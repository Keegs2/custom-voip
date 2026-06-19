-- lib/rec_notify.lua — notify the API that a call recording was written, and
-- HAND THE API THE ACTUAL AUDIO FILE so it can upload it to object storage,
-- create the `recordings` row, and hand back the stored key / serve URL.
--
-- PROD-2 (cross-VM media): in production FreeSWITCH (Media VM) and the API
-- (Services VM) do NOT share a volume, so a spool PATH alone is useless to the
-- API. We therefore POST the recording FILE itself as multipart/form-data
-- (curl -F file=@<path>) ALONGSIDE the metadata fields. The same code path works
-- in local dev (where the shared /media/spool volume still exists) — we keep
-- sending spool_path so the API can reconcile from the volume as a fallback.
--
-- SEC-2 (ingest auth): every POST carries `X-Ingest-Secret: <INGEST_SHARED_SECRET>`
-- so the API can authenticate the uploader constant-time. Header is sent only
-- when the env var is set (dev/local harness without it still no-ops cleanly).
--
-- WHY system curl (io.popen) and not mod_curl: mod_curl's session app cannot set
-- an arbitrary header (X-Ingest-Secret) nor stream a multipart file upload. We
-- mirror the injection-safe single-quote shell quoting used across the Lua
-- scripts: EVERY token that contains caller/file-derived data is `shq()`-wrapped.
--
-- ROBUSTNESS: every failure is logged and swallowed (fail-open). A notify failure
-- NEVER disrupts the call or the recording — the WAV is already on the spool, so
-- the API can reconcile it by scanning the volume later (dev) or it is simply
-- retried out of band. On Docker Desktop the FS->API hop is unreachable; that is
-- expected and is a clean no-op.
--
-- The shared contract (docker/api/src/routers/recordings.py, POST
-- /v1/recordings/ingest) — multipart/form-data:
--   file (the audio) + fields: recording_uuid, customer_id, call_uuid,
--   spool_path, duration_ms, kind   (kind in {programmable, call, conference})
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
    local secret   = os.getenv("INGEST_SHARED_SECRET")
    local url = string.format("http://%s:%s/v1/recordings/ingest", api_host, api_port)
    local spool_path = meta.spool_path

    -- Build the curl argv as a list of shell-safe tokens. Capture BOTH the
    -- response body and the HTTP code: body first, then a sentinel line with the
    -- code (curl -w). This lets us read back the stored key / serve URL while
    -- staying single-shot and fail-open.
    local args = {
        "curl", "-s", "-w", shq("\\n__HTTP__%{http_code}"),
        "--max-time", tostring(timeout), "-X", "POST",
    }
    if secret and secret ~= "" then
        args[#args + 1] = "-H"
        args[#args + 1] = shq("X-Ingest-Secret: " .. secret)
    end
    -- The audio file (multipart). curl reads name=@filename; quoting the whole
    -- token keeps paths with spaces/specials injection-safe.
    if spool_path and spool_path ~= "" then
        args[#args + 1] = "-F"
        args[#args + 1] = shq("file=@" .. spool_path)
    end
    -- Metadata form fields (mirror the old JSON body field set).
    local function field(name, value)
        if value == nil then return end
        args[#args + 1] = "-F"
        args[#args + 1] = shq(name .. "=" .. tostring(value))
    end
    field("recording_uuid", meta.recording_uuid)
    local cid = tonumber(meta.customer_id)
    if cid then field("customer_id", string.format("%d", cid)) end
    field("call_uuid", meta.call_uuid)
    field("spool_path", spool_path)
    local dur = tonumber(meta.duration_ms)
    field("duration_ms", string.format("%d", dur and math.floor(dur) or 0))
    field("kind", meta.kind or "programmable")
    args[#args + 1] = shq(url)
    args[#args + 1] = "2>/dev/null"
    local cmd = table.concat(args, " ")

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
            "uploaded recording to API rec=%s cust=%s kind=%s http=%s url=%s",
            tostring(meta.recording_uuid), tostring(meta.customer_id),
            tostring(meta.kind), code, tostring(rec_url or store_key or "-")))
        return { ok = true, http = code, recording_url = rec_url, storage_key = store_key }
    end

    log("WARNING", string.format(
        "API recording ingest non-2xx (http=%s) rec=%s — file remains on spool %s",
        code == "" and "none" or code, tostring(meta.recording_uuid),
        tostring(meta.spool_path)))
    return { ok = false, http = code == "" and "none" or code }
end

return M
