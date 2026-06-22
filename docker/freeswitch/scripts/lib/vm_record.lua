-- lib/vm_record.lua — ONE shared voicemail recorder for every product path.
--
-- Extracted (behavior-preserving) from the duplicated `record_voicemail()` flows
-- that lived inline in handlers/rcf.lua (RICH fallback=voicemail) and
-- handlers/ucaas.lua (no-answer + ring-plan fallback). Both copies were
-- byte-identical except for the storage directory and the notify metadata, so
-- they collapse into M.record(opts) parameterised on:
--   * storage   — "spool" (LEGACY: shared /media/spool tree, NOT shredded) or
--                 "tmpfs" (ENCRYPTED product path: RAM-fs, shredded on exit).
--   * vm_dir    — the directory to record into (spool callers pass the legacy
--                 path; tmpfs defaults to /dev/shm/vm).
--   * notify    — the metadata table handed to lib/vm_notify (extension/
--                 customer_id for the legacy paths; to_did/mailbox_id/
--                 attach_*/source_model for the product paths).
--
-- THE FLOW (task §2 telephony): tones → optional greeting → BEEP → record →
-- confirmation beep → notify/upload → SHRED (tmpfs only). The tone/beep/record
-- sequence is byte-for-byte the legacy code so the rcf/ucaas characterization
-- tests (tests/lua/spec/{rcf_richplan,ucaas_inbound,ucaas_ringplan}_spec.lua)
-- stay green when no mailbox is bound (legacy spool deposit, unchanged).
--
-- ENCRYPTION DISCIPLINE (task hard constraint): for the product/tmpfs path the
-- plaintext WAV is written to /dev/shm (RAM-fs, never persistent disk), the
-- multipart upload to /v1/voicemail/ingest IS the only handoff (the API encrypts
-- on write — FS never inserts a row), and the tmpfs file is SHREDDED on EVERY
-- exit path (success, short-message discard, or error) via a pcall'd os.remove
-- so plaintext never lingers in RAM-fs. The spool/legacy path is intentionally
-- NOT shredded — the API uploads + reconciles it from the shared volume exactly
-- as before.
--
-- ROBUSTNESS: the whole capture is wrapped in pcall — a recorder error never
-- breaks the call. The notify is fire-and-forget / fail-open and skipped cleanly
-- when API_HOST is unset (e.g. the Lua unit harness).
--
-- `freeswitch` is the mod_lua global (guarded for the headless test harness).

local M = {}

local function log(level, prefix, msg)
    if freeswitch and freeswitch.consoleLog then
        freeswitch.consoleLog(level, prefix .. msg .. "\n")
    end
end

-- POSIX shell single-quote escape: wrap in '...' and turn each ' into '\''.
-- Defense-in-depth for the one os.execute() (mkdir) below.
local function shq(s)
    return "'" .. tostring(s or ""):gsub("'", "'\\''") .. "'"
end

-- record(opts) -> vm_file, duration_ms, notified
--
-- opts:
--   session         (required) the FreeSWITCH session.
--   uuid            call uuid (filename + logs).
--   get_var         ctx.get_var (name, default) — reads record_ms/record_seconds.
--   storage         "spool" (default) | "tmpfs".
--   vm_dir          recording directory. REQUIRED for spool; tmpfs defaults to
--                   /dev/shm/vm.
--   log_prefix      log line prefix (default "[<uuid>] [vm_record] ").
--   greeting_file   optional path/URI to playback between the announce tones and
--                   the beep (product greeting; Phase 2). Played best-effort.
--   play_greeting   optional function(session) called in place of greeting_file.
--   max_record_len / silence_threshold / silence_hits — record app args
--                   (default 300 / 200 / 3 — the legacy + voicemail.conf values).
--   min_keep_ms     tmpfs short-message discard threshold (default 2000).
--   notify          metadata table forwarded to lib/vm_notify.notify (merged
--                   with the computed storage_path + optional duration_ms).
--   notify_duration when true (or storage=="tmpfs"), include the measured
--                   duration_ms in the notify (legacy rcf omitted it; ucaas sent
--                   it — preserved per-caller).
function M.record(opts)
    opts = opts or {}
    local session = opts.session
    if not session then return nil end
    local uuid = opts.uuid or "unknown"
    local get_var = opts.get_var or function(_, d) return d end
    local storage = (opts.storage == "tmpfs") and "tmpfs" or "spool"
    local log_prefix = opts.log_prefix or string.format("[%s] [vm_record] ", uuid)

    -- record app args. Default to the legacy/voicemail.conf values so the
    -- spool/legacy callers emit the exact "300 200 3" the specs pin.
    local max_len  = tonumber(opts.max_record_len)   or 300
    local sil_thr  = tonumber(opts.silence_threshold) or 200
    local sil_hits = tonumber(opts.silence_hits)      or 3
    local record_args = string.format("%d %d %d", max_len, sil_thr, sil_hits)

    -- File path. tmpfs => RAM-fs (/dev/shm); spool => the legacy
    -- /var/lib/freeswitch/voicemail/... tree (symlinked onto /media/spool).
    local vm_dir, vm_file
    if storage == "tmpfs" then
        vm_dir = opts.vm_dir or "/dev/shm/vm"
        vm_file = string.format("%s/%s.wav", vm_dir, uuid)
    else
        vm_dir = opts.vm_dir
        if not vm_dir or vm_dir == "" then
            log("ERR", log_prefix, "spool record requested with no vm_dir — aborting")
            return nil
        end
        vm_file = string.format("%s/msg_%s.wav", vm_dir, uuid)
    end

    local duration_ms = nil
    local notified = false

    local ok, perr = pcall(function()
        if not session:ready() then return end
        session:answer()
        session:sleep(500)

        -- Announce tones (byte-for-byte the legacy sequence):
        -- three ascending tones = "the party is not available".
        session:execute("playback", "tone_stream://%(200,80,500);%(200,80,650);%(200,0,800)")
        session:sleep(800)
        -- two short tones = "get ready to leave a message".
        session:execute("playback", "tone_stream://%(150,100,700);%(150,0,700)")
        session:sleep(600)

        -- Optional product greeting (Phase 2). Best-effort: a greeting failure
        -- must NEVER block the deposit. Legacy callers pass neither → no-op, so
        -- the next line (BEEP) follows the tones exactly as before.
        if type(opts.play_greeting) == "function" then
            pcall(opts.play_greeting, session)
        elseif type(opts.greeting_file) == "string" and opts.greeting_file ~= "" then
            pcall(function() session:execute("playback", opts.greeting_file) end)
        end

        -- BEEP — start recording.
        session:execute("playback", "tone_stream://%(1000,0,640)")

        session:execute("set", "playback_terminators=#")
        os.execute("mkdir -p " .. shq(vm_dir))
        session:execute("record", vm_file .. " " .. record_args)

        -- Confirmation beep.
        if session:ready() then
            session:execute("playback", "tone_stream://%(100,0,800)")
            session:sleep(300)
            session:execute("playback", "tone_stream://%(200,80,600);%(200,0,400)")
        end

        -- Measure duration (record app sets record_ms / record_seconds).
        local dur_ms = tonumber(get_var("record_ms", ""))
        if not dur_ms then
            local secs = tonumber(get_var("record_seconds", ""))
            if secs then dur_ms = secs * 1000 end
        end
        duration_ms = dur_ms

        -- Short-message discard (product/tmpfs path only): a sub-2s capture is a
        -- caller hangup, not a message — do not upload it. The file is still
        -- shredded below. The spool/legacy path NEVER discards (unchanged).
        local min_keep = tonumber(opts.min_keep_ms) or 2000
        if storage == "tmpfs" and dur_ms and dur_ms < min_keep then
            log("INFO", log_prefix, string.format(
                "discarding short recording (%dms < %dms) — caller hangup, not a message",
                dur_ms, min_keep))
            return
        end

        -- Notify / upload. Fire-and-forget, fail-open, skipped when API_HOST is
        -- unset (loaded with the proven loadfile() pattern — CLAUDE.md gotcha #10).
        if os.getenv("API_HOST") then
            local notify_chunk = loadfile("/usr/local/freeswitch/scripts/lib/vm_notify.lua")
            if notify_chunk then
                local okmod, vm_notify = pcall(notify_chunk)
                if okmod and vm_notify and vm_notify.notify then
                    local meta = {}
                    for k, v in pairs(opts.notify or {}) do meta[k] = v end
                    -- storage_path: tmpfs => the RAM-fs file itself (vm_notify
                    -- multipart-uploads it; no shared volume exists cross-VM).
                    -- spool => the shared-volume path (legacy gsub) so the API
                    -- uploads it cross-VM and can reconcile from the volume in dev.
                    if storage == "tmpfs" then
                        meta.storage_path = vm_file
                    else
                        meta.storage_path = vm_file:gsub(
                            "^/var/lib/freeswitch/voicemail", "/media/spool/voicemail")
                    end
                    if (opts.notify_duration or storage == "tmpfs")
                        and dur_ms and not meta.duration_ms then
                        meta.duration_ms = dur_ms
                    end
                    pcall(vm_notify.notify, meta)
                    notified = true
                end
            end
        end
    end)

    if not ok then
        log("WARNING", log_prefix, "recorder error (swallowed): " .. tostring(perr))
    end

    -- SHRED — plaintext must never linger on the RAM-fs. Runs on EVERY exit path
    -- (success / short-discard / error). The spool/legacy file is intentionally
    -- preserved (the API uploads + reconciles it from the shared volume).
    if storage == "tmpfs" then
        pcall(os.remove, vm_file)
    end

    return vm_file, duration_ms, notified
end

return M
