-- lib/rec_notify.lua — notify the API that a call recording was written to the
-- shared /media/spool/recordings volume, so the API can upload it to object
-- storage, create the `recordings` row, and hand back the stored key / serve URL.
--
-- WHY system curl (io.popen) and not mod_curl: this is a fire-and-forget POST
-- with a JSON body; mod_curl's session app form-encodes and can't cleanly set an
-- arbitrary Content-Type/header. We mirror the injection-safe single-quote shell
-- quoting used by lib/vm_notify.lua and handlers/api_voice.lua.
--
-- ROBUSTNESS: every failure is logged and swallowed (fail-open). A notify failure
-- NEVER disrupts the call or the recording — the WAV is already on the shared
-- spool, so the API can reconcile it by scanning the volume later. On Docker
-- Desktop the FS->API hop is unreachable; this is expected and is a clean no-op.
--
-- The shared contract (docker/api/src/routers/recordings.py, POST
-- /v1/recordings/ingest):
--   { recording_uuid:str, customer_id:int, call_uuid:str, spool_path:str,
--     duration_ms:int, kind:str }   kind in {programmable, call, conference}
-- Response (2xx): JSON that MAY carry a "recording_url" and/or "storage_key" the
-- caller surfaces to the customer in status/action callbacks. We parse them
-- leniently; absence is fine (caller falls back to the spool path).

local M = {}

local function log(level, msg)
    if freeswitch and freeswitch.consoleLog then
        freeswitch.consoleLog(level, "[rec_notify] " .. msg .. "\n")
    end
end

-- POSIX shell single-quote escape: wrap in '...' and turn each ' into '\''.
local function shq(s)
    return "'" .. tostring(s or ""):gsub("'", "'\\''") .. "'"
end

-- Minimal JSON string escaper for the small, known field set we emit.
local function jstr(s)
    s = tostring(s or "")
    s = s:gsub("\\", "\\\\"):gsub('"', '\\"')
         :gsub("\n", "\\n"):gsub("\r", "\\r"):gsub("\t", "\\t")
    return '"' .. s .. '"'
end

-- Build the JSON body from a metadata table. customer_id/duration_ms are emitted
-- as JSON numbers when valid (customer_id -> null when absent, duration_ms -> 0).
local function build_body(meta)
    local parts = {}
    parts[#parts + 1] = '"recording_uuid":' .. jstr(meta.recording_uuid)
    local cid = tonumber(meta.customer_id)
    parts[#parts + 1] = '"customer_id":' .. (cid and string.format("%d", cid) or "null")
    parts[#parts + 1] = '"call_uuid":' .. jstr(meta.call_uuid)
    parts[#parts + 1] = '"spool_path":' .. jstr(meta.spool_path)
    local dur = tonumber(meta.duration_ms)
    parts[#parts + 1] = '"duration_ms":' .. string.format("%d", dur and math.floor(dur) or 0)
    parts[#parts + 1] = '"kind":' .. jstr(meta.kind or "programmable")
    return "{" .. table.concat(parts, ",") .. "}"
end

-- Lenient single-field extractor: "<key>" : "<value>". Returns nil if absent.
local function json_field(body, key)
    if not body or body == "" then return nil end
    return body:match('"' .. key .. '"%s*:%s*"([^"]*)"')
end

-- notify(meta) -> result table. meta fields: recording_uuid, customer_id,
-- call_uuid, spool_path, duration_ms, kind. Returns:
--   { ok = bool, http = "<code>", recording_url = str|nil, storage_key = str|nil }
-- ok is true only on a 2xx. Never raises.
function M.notify(meta)
    meta = meta or {}
    local api_host = os.getenv("API_HOST")
    if not api_host or api_host == "" then
        -- No API endpoint configured (e.g. the Lua unit harness): skip cleanly.
        log("DEBUG", "API_HOST unset; recording notify skipped (file remains on spool)")
        return { ok = false, http = "skipped" }
    end
    local api_port = os.getenv("API_PORT") or "8000"
    local timeout  = tonumber(os.getenv("REC_NOTIFY_TIMEOUT")) or 5
    local url = string.format("http://%s:%s/v1/recordings/ingest", api_host, api_port)
    local body = build_body(meta)

    -- Capture BOTH the response body and the HTTP code: body first, then a
    -- sentinel line with the code (curl -w). This lets us read back the stored
    -- key / serve URL the API assigns, while staying single-shot and fail-open.
    local cmd = string.format(
        "curl -s -w '\\n__HTTP__%%{http_code}' --max-time %d "
        .. "-X POST -H 'Content-Type: application/json' --data %s %s 2>/dev/null",
        timeout, shq(body), shq(url))

    local ok, ph = pcall(io.popen, cmd)
    if not ok or not ph then
        log("WARNING", "io.popen failed; recording notify skipped (file on spool): " .. url)
        return { ok = false, http = "popen_failed" }
    end
    local out = ph:read("*a") or ""
    ph:close()

    local resp_body, code = out:match("^(.-)\n__HTTP__(%d*)%s*$")
    if not code then
        -- No sentinel (curl produced nothing): treat as transport failure.
        resp_body, code = out, ""
    end
    code = (code or ""):gsub("%s+", "")

    if code == "200" or code == "201" then
        local rec_url = json_field(resp_body, "recording_url")
        local store_key = json_field(resp_body, "storage_key")
        log("INFO", string.format(
            "notified API rec=%s cust=%s kind=%s http=%s url=%s",
            tostring(meta.recording_uuid), tostring(meta.customer_id),
            tostring(meta.kind), code, tostring(rec_url or store_key or "-")))
        return { ok = true, http = code, recording_url = rec_url, storage_key = store_key }
    end

    log("WARNING", string.format(
        "API recording notify non-2xx (http=%s) rec=%s — file remains on spool %s",
        code == "" and "none" or code, tostring(meta.recording_uuid),
        tostring(meta.spool_path)))
    return { ok = false, http = code == "" and "none" or code }
end

return M
