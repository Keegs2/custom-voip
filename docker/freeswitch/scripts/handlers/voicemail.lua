-- handlers/voicemail.lua — standalone encrypted Visual Voicemail (Phase 1)
--
-- Reached from inbound_router.lua's dispatch cascade when the dialed DID is a
-- mailbox's own access DID — i.e. db_client.lookup_voicemail_did matched a
-- voicemail_box_bindings row with binding_type='dedicated_did'. The cascade
-- places this LAST (after rcf/api/trunk/ucaas) so it can never shadow a revenue
-- product; the binding table is disjoint from the product DID tables.
--
-- FLOW (task §2 / §6 — Phase 1):
--   resolve greeting (GET /v1/voicemail/resolve?to_did=, best-effort, never
--   blocks the deposit) → record via lib/vm_record to tmpfs (/dev/shm) →
--   vm_record uploads the WAV to /v1/voicemail/ingest (the API encrypts on
--   write — FS NEVER inserts a row) → vm_record shreds the tmpfs file.
--
-- Greeting audio is a Phase-2 feature (recorder/upload + decrypt-stream-to-FS):
-- in Phase 1 the resolve only confirms the mailbox + carries greeting_type for
-- the ingest; there is no uploaded greeting audio yet, so vm_record always plays
-- its synthesized announce-tones/beep. The resolve is purely best-effort — a
-- fetch failure must never block the deposit (the dispatcher already handed us
-- the authoritative mailbox_id).
--
-- `0` → operator and caller review/re-record are Phase 2 (operator requires an
-- operator-target column that the v1 schema does not have, so v1 just records).
--
-- ctx fields consumed (set up by inbound_router.lua):
--   session, get_var, set_var, hangup       — session + helpers
--   uuid, normalized_did, customer_id        — call/routing identity
--   mailbox_id, vm_mode, ring_target         — resolved voicemail routing
--   original_caller_number, original_caller_name
--   vm_record                                — shared recorder (lib/vm_record)
--
-- `freeswitch` is the mod_lua global (guarded for the headless test harness).

-- POSIX shell single-quote escape (injection-safe curl, same as lib/vm_notify).
local function shq(s)
    return "'" .. tostring(s or ""):gsub("'", "'\\''") .. "'"
end

-- RFC 3986 percent-encode a query-string value (the dialed DID carries a "+"
-- which would otherwise decode to a space).
local function urlenc(s)
    return (tostring(s or ""):gsub("[^%w%-%_%.%~]", function(c)
        return string.format("%%%02X", string.byte(c))
    end))
end

-- Lazy lib/json loader (loadfile pattern — require() is broken under mod_lua,
-- CLAUDE.md gotcha #10). Cached; a load failure is non-fatal (greeting just
-- stays nil and we fall back to the synthesized tones).
local _json, _json_tried
local function get_json()
    if _json then return _json end
    if _json_tried then return nil end
    _json_tried = true
    local chunk = loadfile("/usr/local/freeswitch/scripts/lib/json.lua")
    if chunk then
        local ok, mod = pcall(chunk)
        if ok and type(mod) == "table" and mod.decode then _json = mod end
    end
    return _json
end

-- resolve_greeting(to_did) -> active_greeting table | nil. Best-effort GET to
-- /v1/voicemail/resolve over the ingest-secret channel. Fully fail-open: any
-- error (no API_HOST, curl/popen failure, non-JSON, no greeting) returns nil and
-- the caller proceeds straight to the deposit.
local function resolve_greeting(to_did)
    local api_host = os.getenv("API_HOST")
    if not api_host or api_host == "" then return nil end
    local api_port = os.getenv("API_PORT") or "8000"
    local timeout  = tonumber(os.getenv("VM_NOTIFY_TIMEOUT")) or 5
    local secret   = os.getenv("INGEST_SHARED_SECRET")
    local url = string.format("http://%s:%s/v1/voicemail/resolve?to_did=%s",
        api_host, api_port, urlenc(to_did))

    local args = { "curl", "-s", "--max-time", tostring(timeout) }
    if secret and secret ~= "" then
        args[#args + 1] = "-H"
        args[#args + 1] = shq("X-Ingest-Secret: " .. secret)
    end
    args[#args + 1] = shq(url)
    args[#args + 1] = "2>/dev/null"

    local ok, ph = pcall(io.popen, table.concat(args, " "))
    if not ok or not ph then return nil end
    local body = ph:read("*a") or ""
    ph:close()
    if body == "" then return nil end

    local json = get_json()
    if not json then return nil end
    local parsed = json.decode(body)
    if type(parsed) ~= "table" then return nil end
    return parsed.active_greeting  -- table or nil
end

return function(ctx)
    local session = ctx.session
    local get_var = ctx.get_var
    local set_var = ctx.set_var
    local hangup = ctx.hangup
    local uuid = ctx.uuid
    local normalized_did = ctx.normalized_did
    local mailbox_id = ctx.mailbox_id
    local original_caller_number = ctx.original_caller_number
    local original_caller_name = ctx.original_caller_name

    freeswitch.consoleLog("INFO", string.format(
        "[%s] Voicemail (dedicated DID): to_did=%s mailbox=%s mode=%s\n",
        uuid, normalized_did, tostring(mailbox_id), tostring(ctx.vm_mode or "direct")))

    -- Mark lua-routed so the dialplan fallback returns 503 (not 404) if anything
    -- below short-circuits — the DID WAS found.
    set_var("lua_routed", "true")

    local vmr = ctx.vm_record
    if not vmr or not vmr.record then
        hangup("NORMAL_TEMPORARY_FAILURE",
            "[" .. uuid .. "] vm_record unavailable — cannot record voicemail")
        return
    end

    -- Resolve the active greeting (best-effort; never blocks the deposit).
    local active_greeting = nil
    local okg, g = pcall(resolve_greeting, normalized_did)
    if okg then active_greeting = g end
    local greeting_type = type(active_greeting) == "table"
        and active_greeting.greeting_type or nil

    -- Record straight to the mailbox (ring-target-then-VM is Phase 2). vm_record
    -- answers, plays the announce tones/beep, records to tmpfs, uploads the WAV
    -- to /v1/voicemail/ingest (the API resolves the mailbox by to_did and
    -- encrypts on write), then shreds the tmpfs plaintext.
    vmr.record({
        session = session,
        uuid = uuid,
        get_var = get_var,
        storage = "tmpfs",
        log_prefix = "[" .. uuid .. "] [vm] ",
        notify_duration = true,
        notify = {
            to_did = normalized_did,
            mailbox_id = mailbox_id,
            customer_id = ctx.customer_id,
            caller_id = original_caller_number,
            caller_name = original_caller_name,
            greeting_type = greeting_type,
            source_model = "dedicated_did",
        },
    })

    -- Clean teardown if the caller is still up after the deposit.
    if session:ready() then
        pcall(function() session:hangup("NORMAL_CLEARING") end)
    end
end
