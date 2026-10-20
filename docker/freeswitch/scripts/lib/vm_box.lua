-- lib/vm_box.lua — encrypted voicemail: the FreeSWITCH call flow (deposit side).
--
-- Contract: docs/ENCRYPTED_VOICEMAIL_INTERFACES.md §6 (this file + the
-- terminate_vvm terminator in inbound_router.lua), client of §4.5 + §5 via
-- lib/vm_deposit.lua. Build plan: docs/ENCRYPTED_VOICEMAIL_BUILD_PLAN.md D6/D8,
-- §3.1, §2 defects 1/2/8/12/13.
--
-- Reached from inbound_router.lua's terminate_vvm (TERMINATORS.voicemail) for
-- BOTH a mailbox DID dialed directly (STEP-1 arm) and an on-net RCF forward
-- whose terminal is a mailbox DID. The router has already: set lua_routed=true,
-- set the CDR vars (customer_id = mailbox owner, product_type = voicemail),
-- and hard-rejected a disabled/suspended mailbox with 603.
--
-- FLOW
--   preflight (no network): modules loaded, API_HOST/API_PORT valid, ingest
--     header file valid, /dev/shm/vm is a tmpfs mount, msg UUIDv4 generated.
--     Any failure -> answer, play `unavailable` (tone fallback), hang up.
--   answer
--   GET /v1/voicemail/fs/mailbox/{id} (3 s):
--     200 accepting=false -> `mailbox_full` (reason "full") / `unavailable`,
--                            hang up, nothing recorded
--     404 / 401 / 403     -> `unavailable`, hang up (a deposit could only be
--                            dropped by the API)
--     anything else       -> proceed with DEFAULTS (300 s, default greeting);
--                            the deposit still runs with its retries
--   greeting: custom (GET .../greetings/{id}/audio -> /dev/shm/vm/g_<uuid>.wav,
--     played, UNLINKED IMMEDIATELY after playback) else `default_greeting`
--     (tone-only if the prompt file is missing). '#' skips the greeting.
--   beep -> record /dev/shm/vm/<msg_uuid>.wav (8 kHz mono PCM16, max
--     max_message_seconds, silence-stop, '#' ends)
--   hang up the A-leg (if the caller has not already) -> deposit (§5, raw
--     audio/wav, retry table) -> unlink -> opportunistic sweep.
--
-- POST-HANGUP DEPOSIT (how it works under mod_lua)
--   The `lua` dialplan application runs this script synchronously in the
--   channel's own session thread. When the caller hangs up (the NORMAL end of
--   a voicemail), mod_sofia answers the BYE and flags the channel for hangup,
--   the `record` application notices the channel is no longer ready and
--   returns (closing the WAV, so its header is final), and session:ready()
--   turns false — but the Lua script keeps running: the session thread is
--   still inside the `lua` application, and the state machine only advances
--   to CS_HANGUP -> CS_REPORTING (CDR) -> CS_DESTROY after the application
--   returns. So everything after `record` (WAV parse, curl deposit, unlink,
--   session:setVariable for the CDR) runs post-hangup on a still-valid channel
--   object, and the CDR is generated after it with the vm_* vars included.
--   Consequences handled here:
--     * session:sleep()/playback return immediately on a hung-up channel, so
--       the retry backoff uses freeswitch.msleep() (fallback `sleep N`) —
--       safe because there is no media left to service.
--     * the script ALWAYS returns: the deposit is bounded (3 attempts x
--       15 s --max-time incl. connect + 1 s/2 s backoff ~= 48 s), so the channel/thread is never
--       left hanging; the dialplan actions after `lua` are skipped because
--       the channel is no longer in CS_EXECUTE.
--     * CDR TIMING: FreeSWITCH stamps the hangup/end time when the state
--       machine processes CS_HANGUP, i.e. AFTER this script returns — so the
--       CDR end_stamp/billsec/duration INCLUDE the post-hangup deposit time
--       (lab: caller BYE 17:49:48.256, end_uepoch 17:49:49.396 with one 503
--       retry). Typically well under 1 s; bounded by the retry budget
--       (~50 s worst case when the API is down). The channel also stays in
--       `show channels` until then. Accepted trade-off: the alternative
--       (detached luarun job) would lose the vm_* CDR outcome and give
--       unbounded background threads.
--     * verified on a real FreeSWITCH 1.11.3 (loopback leg hung up during
--       `record`): record returned, session:ready()=false, deposit attempt
--       1 -> 503 -> freeswitch.msleep(1000) -> attempt 2 -> stored, vm_* vars
--       present in the JSON CDR, tmpfs empty, the dialplan action after
--       `lua` never executed.
--   To make the end-of-call path uniform, the script hangs up a caller who
--   is still connected after `record` (max length / silence / '#') BEFORE
--   depositing — every deposit therefore runs on a hung-up channel.
--
-- PLAINTEXT HYGIENE (D8, defect 12): every tmpfs path is registered BEFORE it
--   can exist and is unlinked on EVERY exit path — success, API rejection,
--   retries exhausted, too-short, caller hangup mid-greeting/mid-record, and a
--   Lua error anywhere in the flow (pcall). Files older than 15 min are swept
--   opportunistically (rate-limited, at most once per 5 min per FS) and on FS
--   start (startup.lua). Nothing is ever written outside /dev/shm/vm: if that
--   tmpfs is not mounted the call plays `unavailable` instead of recording.
--
-- Loaded per voicemail call with the loadfile() pattern (never at the top of
-- inbound_router.lua, so RCF/trunk calls never pay for it).

local M = {}

local LIB_DIR = "/usr/local/freeswitch/scripts/lib/"
M.PROMPT_DIR = "/usr/local/freeswitch/scripts/sounds/vm"
M.MOUNTS_FILE = "/proc/self/mounts"

M.DEFAULT_MAX_SECONDS = 300      -- contract cap; used when the lookup fails
M.MIN_MAX_SECONDS     = 10
M.MIN_DEPOSIT_MS      = 1000     -- contract §5: < 1 s is not deposited
M.SILENCE_THRESHOLD   = 200      -- record energy threshold
M.SILENCE_HITS        = 5        -- seconds of silence that end the recording
M.RECORD_SAMPLE_RATE  = 8000     -- canonical 8 kHz mono PCM16 (<= 4.8 MB / 300 s)
M.SETTLE_MS           = 300      -- after answer, before the first prompt
M.SWEEP_AGE_MIN       = 15
M.SWEEP_INTERVAL_S    = 300

-- Tone fallbacks (a missing prompt file must never fail a call).
M.TONE_GREETING = "tone_stream://%(200,80,500);%(200,80,650);%(200,0,800)"
M.TONE_BEEP     = "tone_stream://%(500,0,1000)"
M.TONE_REORDER  = "tone_stream://L=6;%(250,250,480,620)"

local function log(level, msg)
    if freeswitch and freeswitch.consoleLog then
        freeswitch.consoleLog(level, msg .. "\n")
    end
end

local function load_lib(name)
    local chunk, err = loadfile(LIB_DIR .. name .. ".lua")
    if not chunk then
        log("ERR", "[vm_box] failed to load " .. name .. ": " .. tostring(err))
        return nil
    end
    local ok, mod = pcall(chunk)
    if not ok or type(mod) ~= "table" then
        log("ERR", "[vm_box] failed to execute " .. name .. ": " .. tostring(mod))
        return nil
    end
    return mod
end

local dep = load_lib("vm_deposit")
local json = load_lib("json")
M.dep = dep
M.json = json

-- ----------------------------------------------------------------------
-- Helpers (all pcall-guarded: a session/FS call can never raise out)
-- ----------------------------------------------------------------------
local function is_ready(session)
    local ok, r = pcall(function() return session:ready() end)
    return (ok and r) and true or false
end

local function setv(session, k, v)
    if v == nil then return end
    pcall(function() session:setVariable(k, tostring(v)) end)
end

local function getv(session, k)
    local ok, v = pcall(function() return session:getVariable(k) end)
    if ok then return v end
    return nil
end

local function file_exists(path)
    local f = io.open(path, "rb")
    if f then
        f:close()
        return true
    end
    return false
end
M._file_exists = file_exists

local function playback(session, what)
    if not is_ready(session) then return end
    pcall(function() session:execute("playback", what) end)
end

-- Play scripts/sounds/vm/<name>.wav, or the tone fallback when missing.
local function play_prompt(session, name, tone, tag)
    local path = M.PROMPT_DIR .. "/" .. name .. ".wav"
    if file_exists(path) then
        playback(session, path)
        return "file"
    end
    log("WARNING", tag .. "prompt " .. path .. " missing — playing tone fallback")
    playback(session, tone)
    return "tone"
end

local function hangup(session, cause)
    pcall(function() session:hangup(cause or "NORMAL_CLEARING") end)
end

-- Media-servicing sleep (only meaningful while the caller is connected).
local function settle(session)
    if is_ready(session) then
        pcall(function() session:sleep(M.SETTLE_MS) end)
    end
end

local function sleep_ms(ms)
    if freeswitch and freeswitch.msleep then
        local ok = pcall(freeswitch.msleep, ms)
        if ok then return end
    end
    -- Constant command string (no data): whole seconds only.
    pcall(os.execute, string.format("sleep %d", math.max(1, math.floor(ms / 1000))))
end

-- Little-endian readers (no string.unpack: 5.1/5.3-common).
local function le16(s, i)
    local a, b = s:byte(i, i + 1)
    if not b then return nil end
    return a + b * 256
end
local function le32(s, i)
    local a, b, c, d = s:byte(i, i + 3)
    if not d then return nil end
    return a + b * 256 + c * 65536 + d * 16777216
end

-- Duration of a RIFF/WAVE PCM file in ms, from its fmt/data chunks (data
-- size falls back to the file size when the header was never finalized).
-- nil when the file is missing or is not a parsable WAV.
function M.wav_duration_ms(path)
    local f = io.open(path, "rb")
    if not f then return nil end
    local size = f:seek("end")
    f:seek("set", 0)
    local head = f:read(4096) or ""
    f:close()
    if head:sub(1, 4) ~= "RIFF" or head:sub(9, 12) ~= "WAVE" then return nil end
    local pos = 13
    local rate, channels, bits, data_off, data_len
    while pos + 7 <= #head do
        local id = head:sub(pos, pos + 3)
        local len = le32(head, pos + 4)
        if not len then break end
        if id == "fmt " then
            channels = le16(head, pos + 10)
            rate = le32(head, pos + 12)
            bits = le16(head, pos + 22)
        elseif id == "data" then
            data_off = pos + 8
            data_len = len
            break
        end
        pos = pos + 8 + len + (len % 2)
    end
    if not (rate and channels and bits and data_off) then return nil end
    local bytes_per_sec = rate * channels * math.floor(bits / 8)
    if bytes_per_sec <= 0 then return nil end
    local avail = (size or 0) - (data_off - 1)
    if avail < 0 then avail = 0 end
    if not data_len or data_len == 0 or data_len >= 4294967295 or data_len > avail then
        data_len = avail
    end
    return math.floor(data_len * 1000 / bytes_per_sec)
end

-- True when /dev/shm/vm is its own tmpfs mount (docker-compose.media.yml).
-- Fail closed: no dedicated RAM mount -> never record (D8).
function M.tmpfs_mounted()
    if not dep then return false end
    local f = io.open(M.MOUNTS_FILE, "r")
    if not f then return false end
    local content = f:read("*a") or ""
    f:close()
    for line in content:gmatch("[^\n]+") do
        local mnt, fstype = line:match("^%S+%s+(%S+)%s+(%S+)")
        if mnt == dep.VM_DIR and fstype == "tmpfs" then
            return true
        end
    end
    return false
end

-- Delete /dev/shm/vm files older than min_age minutes. Rate-limited through
-- an FS global variable unless force. The command is constant except for the
-- validated integer age (vm_deposit.sweep_cmd).
function M.sweep(min_age, force)
    if not dep then return false end
    local now = os.time()
    if not force and freeswitch and freeswitch.getGlobalVariable then
        local last = tonumber(freeswitch.getGlobalVariable("vm_sweep_last") or "")
        if last and now - last >= 0 and now - last < M.SWEEP_INTERVAL_S then
            return false
        end
        pcall(freeswitch.setGlobalVariable, "vm_sweep_last", tostring(now))
    end
    local cmd = dep.sweep_cmd(min_age or M.SWEEP_AGE_MIN)
    if not cmd then return false end
    pcall(os.execute, cmd)
    return true
end

-- ----------------------------------------------------------------------
-- File registry: every tmpfs path is registered BEFORE it can exist.
-- ----------------------------------------------------------------------
local function register(st, path)
    st.files[path] = true
end

local function unlink(st, path)
    pcall(os.remove, path)
    st.files[path] = nil
end

local function cleanup(st, tag)
    local n = 0
    for path in pairs(st.files) do
        pcall(os.remove, path)
        n = n + 1
    end
    st.files = {}
    if n > 0 then
        log("DEBUG", tag .. "unlinked " .. n .. " tmpfs file(s)")
    end
end

-- ----------------------------------------------------------------------
-- Phase 1: answer -> lookup -> greeting -> beep -> record
-- ----------------------------------------------------------------------
local function flow(session, a, st)
    local tag = st.tag
    local mailbox_id = a.mailbox_id

    -- Preflight (no network, before answer).
    local problem
    local base
    if not dep or not json then
        problem = "voicemail libraries failed to load"
    else
        local err
        base, err = dep.api_base()
        if not base then
            problem = err
        else
            local ok, herr = dep.ingest_header_ok()
            if not ok then
                problem = herr
            elseif not M.tmpfs_mounted() then
                problem = "tmpfs " .. dep.VM_DIR .. " is not mounted (recreate the FS container)"
            else
                st.msg_uuid = dep.uuid4()
                if not dep.is_uuid4(st.msg_uuid) then
                    problem = "could not generate a message UUID"
                end
            end
        end
    end
    setv(session, "vm_msg_uuid", st.msg_uuid)
    if problem then
        log("ERR", tag .. "voicemail unavailable: " .. problem)
    end

    pcall(function() session:answer() end)
    if not is_ready(session) then
        st.result = problem and "unavailable_config" or "caller_gone"
        return
    end

    if problem then
        st.result = "unavailable_config"
        settle(session)
        play_prompt(session, "unavailable", M.TONE_REORDER, tag)
        hangup(session)
        return
    end

    -- Mailbox lookup (contract §4.5).
    local max_secs = M.DEFAULT_MAX_SECONDS
    local greeting_id
    local lk = dep.fetch_mailbox(base, mailbox_id, json)
    if lk.kind == "ok" then
        local d = lk.data
        if d.accepting == false then
            local reason = (d.reason == "full") and "full" or "inactive"
            log("INFO", tag .. "mailbox " .. tostring(mailbox_id) .. " not accepting (" .. reason .. ")")
            st.result = "not_accepting_" .. reason
            settle(session)
            if reason == "full" then
                play_prompt(session, "mailbox_full", M.TONE_REORDER, tag)
            else
                play_prompt(session, "unavailable", M.TONE_REORDER, tag)
            end
            hangup(session)
            return
        elseif d.accepting ~= true then
            log("WARNING", tag .. "mailbox lookup returned no 'accepting' flag — using defaults")
        else
            if d.mailbox_id ~= nil and tonumber(d.mailbox_id) ~= tonumber(mailbox_id) then
                log("WARNING", tag .. "mailbox lookup returned a different mailbox_id — using defaults")
            else
                local n = tonumber(d.max_message_seconds)
                if n and n == math.floor(n) and n >= M.MIN_MAX_SECONDS and n <= M.DEFAULT_MAX_SECONDS then
                    max_secs = n
                elseif d.max_message_seconds ~= nil then
                    log("WARNING", tag .. "invalid max_message_seconds from API — using "
                        .. M.DEFAULT_MAX_SECONDS)
                end
                if type(d.greeting) == "table" then
                    greeting_id = dep._id_string(d.greeting.greeting_id)
                end
            end
        end
    elseif lk.kind == "not_found" or lk.kind == "auth" then
        log("ERR", tag .. "mailbox " .. tostring(mailbox_id) .. " lookup http " .. tostring(lk.code)
            .. (lk.kind == "auth" and " (ingest secret rejected — check the header file)" or " (mailbox unknown/deleted)")
            .. " — playing unavailable")
        st.result = "unavailable_" .. tostring(lk.code)
        settle(session)
        play_prompt(session, "unavailable", M.TONE_REORDER, tag)
        hangup(session)
        return
    else
        log("WARNING", tag .. "mailbox lookup failed (" .. tostring(lk.detail) .. ", http "
            .. tostring(lk.code) .. ") — proceeding with defaults ("
            .. M.DEFAULT_MAX_SECONDS .. " s, default greeting)")
        st.lookup_failed = true
    end
    setv(session, "vm_max_seconds", max_secs)

    settle(session)
    if not is_ready(session) then
        st.result = "caller_gone"
        return
    end

    -- '#' skips the greeting and ends the recording.
    setv(session, "playback_terminators", "#")

    -- Greeting.
    local greeting_kind
    if greeting_id then
        local gpath = dep.greeting_path(dep.uuid4())
        if gpath then
            register(st, gpath)
            local ok, gerr = dep.fetch_greeting(base, greeting_id, gpath)
            if ok then
                playback(session, gpath)
                greeting_kind = "custom"
            else
                log("WARNING", tag .. "custom greeting " .. greeting_id .. " unavailable ("
                    .. tostring(gerr) .. ") — default greeting")
            end
            unlink(st, gpath)   -- immediately after playback (or failed fetch)
        end
    end
    if not greeting_kind then
        greeting_kind = (play_prompt(session, "default_greeting", M.TONE_GREETING, tag) == "file")
            and "default" or "tone"
    end
    setv(session, "vm_greeting", greeting_kind)

    if not is_ready(session) then
        st.result = "caller_gone"
        return
    end

    playback(session, M.TONE_BEEP)
    if not is_ready(session) then
        st.result = "caller_gone"
        return
    end

    -- Record to tmpfs. Path = fixed dir + validated UUIDv4 (never SIP data).
    local rec_path = dep.message_path(st.msg_uuid)
    register(st, rec_path)
    setv(session, "record_sample_rate", M.RECORD_SAMPLE_RATE)
    -- Returns when: max length reached, silence-stop, '#', the caller hangs
    -- up (the normal end — see "POST-HANGUP DEPOSIT" above), or the file
    -- could not be opened/written (tmpfs full).
    session:execute("record", string.format("%s %d %d %d",
        rec_path, max_secs, M.SILENCE_THRESHOLD, M.SILENCE_HITS))

    if not file_exists(rec_path) then
        log("ERR", tag .. "record produced no file (tmpfs full or not writable?) — message not taken")
        st.result = "record_failed"
        if is_ready(session) then
            play_prompt(session, "unavailable", M.TONE_REORDER, tag)
        end
        return
    end
    -- From here on the deposit phase runs even if something below raises.
    st.rec_path = rec_path

    local dur = M.wav_duration_ms(rec_path)
    if not dur then
        dur = tonumber(getv(session, "record_ms") or "")
    end
    st.duration_ms = dur
    -- `record` came back almost at once with the caller STILL connected:
    -- the tmpfs is full / the file could not be written, or '#' was pressed
    -- right after the beep. Nothing will be deposited (< 1 s) — say so
    -- instead of hanging up in silence (build plan §3.1 "Full tmpfs").
    if is_ready(session) and (not dur or dur < M.MIN_DEPOSIT_MS) then
        log("WARNING", tag .. "recording ended after " .. tostring(dur)
            .. " ms with the caller still connected (tmpfs full / immediate '#')")
        play_prompt(session, "unavailable", M.TONE_REORDER, tag)
    end
end

-- ----------------------------------------------------------------------
-- Phase 2: deposit (always on a hung-up channel)
-- ----------------------------------------------------------------------
local function deposit_phase(session, a, st, base)
    local tag = st.tag
    hangup(session)   -- end a still-connected caller BEFORE the deposit

    local dur = st.duration_ms
    if not dur then
        -- the flow raised before measuring, or the file is not a WAV
        dur = M.wav_duration_ms(st.rec_path) or tonumber(getv(session, "record_ms") or "")
    end
    if not dur then
        log("ERR", tag .. "recording is not a parsable WAV — not deposited")
        st.result = "bad_recording"
        return
    end
    dur = math.floor(dur)
    setv(session, "vm_duration_ms", dur)
    if dur < M.MIN_DEPOSIT_MS then
        log("INFO", tag .. "recording " .. dur .. " ms < " .. M.MIN_DEPOSIT_MS
            .. " ms — not deposited")
        st.result = "too_short"
        return
    end

    local meta = {
        v = 1,
        msg_uuid = st.msg_uuid,
        mailbox_id = tonumber(a.mailbox_id),
        did = dep.clean_text(a.did, dep.MAX_DID),
        caller_id_number = dep.clean_text(a.caller_number, dep.MAX_CALLER_NUMBER),
        caller_id_name = dep.clean_text(a.caller_name, dep.MAX_CALLER_NAME),
        duration_ms = dur,
        call_uuid = dep.clean_text(a.call_uuid, dep.MAX_CALL_UUID),
        fs_node = dep.clean_text(a.fs_node, dep.MAX_FS_NODE),
        zone = dep.clean_text(a.zone, dep.MAX_ZONE),
    }
    local body, jerr = json.encode(meta)
    if not body then
        log("ERR", tag .. "metadata encode failed (" .. tostring(jerr) .. ") — message lost")
        st.result = "lost"
        return
    end
    local b64 = dep.b64url(body)
    if not dep.is_b64url(b64) then
        log("ERR", tag .. "metadata header failed validation — message lost")
        st.result = "lost"
        return
    end

    local res = dep.deposit(base, st.rec_path, b64, sleep_ms, file_exists, tag)
    st.deposit = res
    if res.outcome == "stored" then
        st.result = "stored"
    elseif res.outcome == "rejected" then
        st.result = "rejected_" .. tostring(res.code)
    else
        st.result = "lost"
    end
    setv(session, "vm_deposit_http", res.code)
    setv(session, "vm_deposit_attempts", res.attempts)
    setv(session, "vm_message_id", res.message_id)
end

-- ----------------------------------------------------------------------
-- Entry point
-- ----------------------------------------------------------------------
-- a = {
--   uuid          call uuid (log prefix; == inbound SIP Call-ID)
--   mailbox_id    integer (number_routing.product_ref_id)
--   did           mailbox DID (+E.164)
--   caller_number / caller_name   presented caller (composed across an
--                                 on-net chain: "last false hop wins")
--   call_uuid, fs_node, zone      metadata for the deposit
-- }
-- Returns the result string (also set as the vm_result channel variable).
function M.run(session, a)
    a = a or {}
    local st = {
        files = {},
        result = nil,
        tag = "[" .. tostring(a.uuid or "?") .. "] [vm " .. tostring(a.mailbox_id) .. "] ",
    }
    setv(session, "vm_mailbox_id", a.mailbox_id)

    local ok, err = pcall(flow, session, a, st)
    if not ok then
        log("ERR", st.tag .. "voicemail flow error: " .. tostring(err))
        if not st.rec_path then
            st.result = "error"
        end
    end

    -- Deposit whatever was recorded — also after a flow error that happened
    -- once the recording was complete.
    if st.rec_path then
        local base = dep and dep.api_base()
        local ok2, err2 = pcall(deposit_phase, session, a, st, base)
        if not ok2 then
            log("ERR", st.tag .. "deposit phase error: " .. tostring(err2) .. " — message lost")
            st.result = "lost"
        end
    end

    cleanup(st, st.tag)   -- EVERY exit path ends here
    hangup(session)
    setv(session, "vm_result", st.result or "error")
    pcall(M.sweep, M.SWEEP_AGE_MIN, false)
    log("INFO", st.tag .. "voicemail done: result=" .. tostring(st.result or "error"))
    return st.result or "error"
end

return M
