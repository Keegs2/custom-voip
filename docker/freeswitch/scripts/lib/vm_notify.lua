-- lib/vm_notify.lua — notify the API that a voicemail was deposited on the
-- shared /media/spool volume, so the API can upload it to object storage and
-- create the voicemails row.
--
-- WHY system curl (io.popen) and not mod_curl: this runs as a fire-and-forget
-- POST with a custom Content-Type and a JSON body; mod_curl's session app form
-- encodes and can't cleanly set arbitrary headers. We mirror the injection-safe
-- shell quoting used by handlers/api_voice.lua.
--
-- ROBUSTNESS: every failure is logged and swallowed. A notify failure NEVER
-- disrupts the call or the recording — the WAV is already on the shared spool,
-- so the API can also reconcile it by scanning the volume later.
--
-- The API contract (docker/api/src/routers/voicemail.py, POST /v1/voicemail/ingest):
--   { extension:str, customer_id:int, caller_id?, caller_name?,
--     duration_ms?:int, storage_path?:str, transcription?:str }

local M = {}

local function log(level, msg)
    if freeswitch and freeswitch.consoleLog then
        freeswitch.consoleLog(level, "[vm_notify] " .. msg .. "\n")
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

-- Build the JSON body from a metadata table. customer_id/duration_ms are
-- emitted as JSON numbers when valid, else omitted (customer_id -> null).
local function build_body(meta)
    local parts = {}
    parts[#parts + 1] = '"extension":' .. jstr(meta.extension)
    local cid = tonumber(meta.customer_id)
    parts[#parts + 1] = '"customer_id":' .. (cid and string.format("%d", cid) or "null")
    if meta.caller_id and meta.caller_id ~= "" then
        parts[#parts + 1] = '"caller_id":' .. jstr(meta.caller_id)
    end
    if meta.caller_name and meta.caller_name ~= "" then
        parts[#parts + 1] = '"caller_name":' .. jstr(meta.caller_name)
    end
    local dur = tonumber(meta.duration_ms)
    if dur then
        parts[#parts + 1] = '"duration_ms":' .. string.format("%d", math.floor(dur))
    end
    if meta.storage_path and meta.storage_path ~= "" then
        parts[#parts + 1] = '"storage_path":' .. jstr(meta.storage_path)
    end
    return "{" .. table.concat(parts, ",") .. "}"
end

-- notify(meta) -> bool. meta fields: extension, customer_id, caller_id,
-- caller_name, duration_ms, storage_path. Returns true only on a 2xx.
function M.notify(meta)
    meta = meta or {}
    local api_host = os.getenv("API_HOST")
    if not api_host or api_host == "" then
        -- No API endpoint configured (e.g. the Lua unit harness): skip cleanly.
        log("DEBUG", "API_HOST unset; voicemail notify skipped (file remains on spool)")
        return false
    end
    local api_port = os.getenv("API_PORT") or "8000"
    local timeout  = tonumber(os.getenv("VM_NOTIFY_TIMEOUT")) or 5
    local url = string.format("http://%s:%s/v1/voicemail/ingest", api_host, api_port)
    local body = build_body(meta)

    local cmd = string.format(
        "curl -s -o /dev/null -w '%%{http_code}' --max-time %d "
        .. "-X POST -H 'Content-Type: application/json' --data %s %s 2>/dev/null",
        timeout, shq(body), shq(url))

    local ok, ph = pcall(io.popen, cmd)
    if not ok or not ph then
        log("WARNING", "io.popen failed; voicemail notify skipped (file on spool): " .. url)
        return false
    end
    local code = ph:read("*a") or ""
    ph:close()
    code = code:gsub("%s+", "")
    if code == "200" or code == "201" then
        log("INFO", string.format("notified API ext=%s cust=%s http=%s",
            tostring(meta.extension), tostring(meta.customer_id), code))
        return true
    end
    log("WARNING", string.format(
        "API notify non-2xx (http=%s) ext=%s — file remains on spool %s",
        code == "" and "none" or code, tostring(meta.extension), tostring(meta.storage_path)))
    return false
end

return M
