-- lib/vm_notify.lua — notify the API that a voicemail was deposited, and HAND
-- THE API THE ACTUAL AUDIO FILE so it can upload it to object storage and create
-- the voicemails row.
--
-- PROD-2 (cross-VM media): in production FreeSWITCH (Media VM) and the API
-- (Services VM) do NOT share a volume, so a spool PATH alone is useless to the
-- API. We therefore POST the voicemail FILE itself as multipart/form-data
-- (curl -F file=@<path>) ALONGSIDE the metadata fields. The same code path works
-- in local dev (where the shared /media/spool volume still exists) — we keep
-- sending storage_path so the API can reconcile from the volume as a fallback.
--
-- SEC-2 (ingest auth): every POST carries `X-Ingest-Secret: <INGEST_SHARED_SECRET>`
-- so the API can authenticate the uploader constant-time. Header is sent only
-- when the env var is set (dev/local harness without it still no-ops cleanly).
--
-- WHY system curl (io.popen) and not mod_curl: mod_curl's session app cannot set
-- an arbitrary header (X-Ingest-Secret) nor stream a multipart file upload. We
-- mirror the injection-safe single-quote shell quoting used by handlers/api_voice.lua:
-- EVERY token that contains caller/file-derived data is `shq()`-wrapped.
--
-- ROBUSTNESS: every failure is logged and swallowed. A notify failure NEVER
-- disrupts the call or the recording — the WAV is already on the spool, so the
-- API can also reconcile it by scanning the volume later (dev).
--
-- The API contract (docker/api/src/routers/voicemail.py, POST /v1/voicemail/ingest)
-- — multipart/form-data: file (the audio) + fields: extension, customer_id,
--   caller_id?, caller_name?, duration_ms?, storage_path?, transcription?

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
    local secret   = os.getenv("INGEST_SHARED_SECRET")
    local url = string.format("http://%s:%s/v1/voicemail/ingest", api_host, api_port)
    local storage_path = meta.storage_path

    -- Build the curl argv as a list of shell-safe tokens. -o /dev/null discards
    -- the body; -w '%{http_code}' yields just the status (fail-open on anything
    -- that is not 2xx).
    local args = {
        "curl", "-s", "-o", "/dev/null", "-w", shq("%{http_code}"),
        "--max-time", tostring(timeout), "-X", "POST",
    }
    if secret and secret ~= "" then
        args[#args + 1] = "-H"
        args[#args + 1] = shq("X-Ingest-Secret: " .. secret)
    end
    -- The audio file (multipart). curl reads name=@filename; quoting the whole
    -- token keeps paths with spaces/specials injection-safe.
    if storage_path and storage_path ~= "" then
        args[#args + 1] = "-F"
        args[#args + 1] = shq("file=@" .. storage_path)
    end
    -- Metadata form fields (mirror the old JSON body field set).
    local function field(name, value)
        if value == nil or value == "" then return end
        args[#args + 1] = "-F"
        args[#args + 1] = shq(name .. "=" .. tostring(value))
    end
    field("extension", meta.extension)
    local cid = tonumber(meta.customer_id)
    if cid then field("customer_id", string.format("%d", cid)) end
    field("caller_id", meta.caller_id)
    field("caller_name", meta.caller_name)
    local dur = tonumber(meta.duration_ms)
    if dur then field("duration_ms", string.format("%d", math.floor(dur))) end
    field("storage_path", storage_path)
    args[#args + 1] = shq(url)
    args[#args + 1] = "2>/dev/null"
    local cmd = table.concat(args, " ")

    local ok, ph = pcall(io.popen, cmd)
    if not ok or not ph then
        log("WARNING", "io.popen failed; voicemail notify skipped (file on spool): " .. url)
        return false
    end
    local code = ph:read("*a") or ""
    ph:close()
    code = code:gsub("%s+", "")
    if code == "200" or code == "201" then
        log("INFO", string.format("uploaded voicemail to API ext=%s cust=%s http=%s",
            tostring(meta.extension), tostring(meta.customer_id), code))
        return true
    end
    log("WARNING", string.format(
        "API voicemail ingest non-2xx (http=%s) ext=%s — file remains on spool %s",
        code == "" and "none" or code, tostring(meta.extension), tostring(meta.storage_path)))
    return false
end

return M
