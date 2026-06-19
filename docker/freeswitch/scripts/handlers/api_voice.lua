-- Voice Webhook Engine - TwiML-compatible XML execution for FreeSWITCH
local sbc_proxy_ip = os.getenv("SBC_PROXY_IP") or "127.0.0.1"
local external_sip_ip = os.getenv("EXTERNAL_SIP_IP") or "auto"
-- Fetches XML instructions from customer webhook URLs and executes them
-- as FreeSWITCH call control commands.
--
-- Supports: Say, Play, Gather, Dial, Hangup, Pause, Redirect, Reject
--
-- Call Flow:
-- 1. Build initial webhook payload from session variables
-- 2. POST to customer's Voice URL with call details
-- 3. Parse XML response into verb list
-- 4. Execute verbs sequentially (Gather/Redirect may recurse)
-- 5. POST to Status Callback URL when call ends
--
-- Error Handling:
-- - Webhook unreachable: play error tone, log, hangup
-- - Unparseable XML: play error tone, log, hangup
-- - Individual verb failure: log and continue to next verb
-- - All operations wrapped in pcall

-- ============================================
-- Module loading and configuration
-- ============================================

-- Prepend luarocks paths so redis-lua is found before mod_lua's script-directory searcher
package.path = "/usr/local/share/lua/5.3/?.lua;/usr/local/share/lua/5.3/?/init.lua;/usr/share/lua/5.3/?.lua;/usr/share/lua/5.3/?/init.lua;/usr/local/freeswitch/scripts/lib/?.lua;" .. (package.path or "")
package.cpath = "/usr/local/lib/lua/5.3/?.so;/usr/local/lib/lua/5.3/?/?.so;/usr/lib/lua/5.3/?.so;/usr/lib/lua/5.3/?/?.so;" .. (package.cpath or "")

local LOG_PREFIX = "[voice_webhook]"
local HTTP_TIMEOUT = tonumber(os.getenv("WEBHOOK_HTTP_TIMEOUT")) or 5  -- seconds, env-tunable
local HTTP_MAX_ATTEMPTS = tonumber(os.getenv("WEBHOOK_MAX_ATTEMPTS")) or 3  -- total tries per URL
local HTTP_BACKOFF_MS = tonumber(os.getenv("WEBHOOK_BACKOFF_MS")) or 200    -- base backoff, doubles each retry
local ALLOW_HTTP = (os.getenv("WEBHOOK_ALLOW_HTTP") == "true")  -- dev only: permit non-HTTPS webhooks
local MAX_REDIRECT_DEPTH = 10 -- prevent infinite redirect loops
local GATHER_DEFAULT_TIMEOUT = 5  -- seconds
local DIAL_DEFAULT_TIMEOUT = 30   -- seconds
-- Recording (Phase 6): tenant-scoped on the shared /media/spool volume the API
-- uploads to object storage. Path: <dir>/customer_<id>/<uuid>.wav
local RECORDINGS_DIR = os.getenv("RECORDINGS_DIR") or "/media/spool/recordings"
local RECORD_DEFAULT_MAXLEN = tonumber(os.getenv("RECORD_DEFAULT_MAXLEN")) or 3600  -- seconds
local RECORD_DEFAULT_TIMEOUT = 5  -- seconds of silence to auto-stop
-- Audio streaming (Phase 6, mod_audio_stream): mono fork at this sample rate.
-- mod_audio_stream's uuid_audio_stream API expects a numeric rate (8000|16000).
local STREAM_SAMPLE_RATE = os.getenv("STREAM_SAMPLE_RATE") or "8000"

-- ============================================
-- TTS (Phase 7) — pluggable <Say> engine
-- ============================================
-- The <Say> verb speaks via a configurable TTS engine. `flite` is the offline
-- default (built into the image). The engine is a DROP-IN HOOK: set TTS_ENGINE
-- to any mod_*/speak engine name (e.g. a future `tts_commandline` wrapping Piper,
-- or a cloud engine via mod_unimrcp/mod_polly) WITHOUT touching this code — the
-- speak app is invoked as `<engine>|<voice>|<text>`. TTS_DEFAULT_VOICE picks the
-- flite voice when the TwiML omits one. See docker/freeswitch/CLAUDE.md "TTS".
local TTS_ENGINE = os.getenv("TTS_ENGINE") or "flite"
local TTS_DEFAULT_VOICE = os.getenv("TTS_DEFAULT_VOICE") or "slt"

-- Map a Twilio-ish voice/language to a flite voice. flite ships: kal, kal16,
-- awb (Scottish male), rms (US male), slt (US female). Twilio's voice tokens
-- (man/woman/alice/Polly.*) and BCP-47 languages don't exist in flite, so we map
-- to the closest flite voice. For non-flite engines the raw voice is passed
-- through (the engine maps it). Returns the engine-appropriate voice string.
local FLITE_VOICE_MAP = {
    ["man"]   = "rms",  ["male"] = "rms",
    ["woman"] = "slt",  ["female"] = "slt",
    ["alice"] = "slt",
    ["kal"]   = "kal",  ["kal16"] = "kal16",
    ["awb"]   = "awb",  ["rms"] = "rms",   ["slt"] = "slt",
}

local function map_tts_voice(voice, language)
    -- Non-flite engines own their voice catalog: pass the requested voice through.
    if TTS_ENGINE ~= "flite" then
        return voice or TTS_DEFAULT_VOICE
    end
    if not voice or voice == "" then
        -- A language hint with no voice: en male-ish default, else the configured default.
        return TTS_DEFAULT_VOICE
    end
    local key = tostring(voice):lower()
    -- Twilio "Polly.Joanna" / "Google.en-US-Wavenet-D" → strip vendor prefix, then
    -- fall back to the configured default (flite can't render those exact voices).
    if FLITE_VOICE_MAP[key] then
        return FLITE_VOICE_MAP[key]
    end
    -- Gendered guess from a vendor voice name when we can infer it.
    if key:find("joanna") or key:find("salli") or key:find("kendra")
        or key:find("woman") or key:find("female") then
        return "slt"
    end
    if key:find("matthew") or key:find("joey") or key:find("man") then
        return "rms"
    end
    return TTS_DEFAULT_VOICE
end

-- Strip SSML so markup is NEVER read literally. We are not a full SSML engine;
-- we remove tags (<speak>, <break>, <prosody>, <say-as>, ...) and decode the
-- five XML entities, leaving the plain spoken text. <break>/<say-as> nuances are
-- intentionally dropped (documented limitation) — correctness over fidelity.
local function strip_ssml(text)
    if not text or text == "" then return text end
    -- Only do work if it actually looks like markup.
    if not text:find("<", 1, true) then return text end
    local t = text
    -- <break .../> and <break></break> → a small spoken pause (comma).
    t = t:gsub("<%s*[bB][rR][eE][aA][kK][^>]*/?>", ", ")
    -- Drop every remaining tag (opening, closing, self-closing).
    t = t:gsub("<%s*/?%s*[%w:_%-]+[^>]*>", " ")
    -- Decode the standard XML entities that survive in text nodes.
    t = t:gsub("&lt;", "<"):gsub("&gt;", ">"):gsub("&quot;", '"')
         :gsub("&apos;", "'"):gsub("&amp;", "&")
    -- Collapse whitespace introduced by tag removal.
    t = t:gsub("%s+", " "):gsub("^%s*(.-)%s*$", "%1")
    return t
end

-- ============================================
-- Conference / Queue (Phase 7) naming + config
-- ============================================
-- SHARED CONTRACT (python conference.py relies on this): a programmatic
-- <Conference name="X"> for customer C joins the FreeSWITCH room
-- `conf_<C>_<sanitized X>` (lowercase, every non-alnum char → "_"). This distinct
-- `conf_` namespace lets the API's tenant-scoped ESL control (`conference <room>
-- list|mute|kick`) operate on programmatically-created rooms.
local CONF_PROFILE_AUDIO = os.getenv("CONF_AUDIO_PROFILE") or "default"
local CONF_PROFILE_VIDEO = os.getenv("CONF_VIDEO_PROFILE") or "video"

local function sanitize_token(s)
    s = tostring(s or ""):lower()
    s = s:gsub("[^%a%d]", "_")          -- non-alnum → _
    s = s:gsub("_+", "_"):gsub("^_+", ""):gsub("_+$", "")
    if s == "" then s = "default" end
    return s
end

-- ============================================
-- Logging helpers
-- ============================================

local function log_info(uuid, msg)
    freeswitch.consoleLog("INFO", string.format("%s [%s] %s\n", LOG_PREFIX, uuid, msg))
end

local function log_debug(uuid, msg)
    freeswitch.consoleLog("DEBUG", string.format("%s [%s] %s\n", LOG_PREFIX, uuid, msg))
end

local function log_err(uuid, msg)
    freeswitch.consoleLog("ERR", string.format("%s [%s] %s\n", LOG_PREFIX, uuid, msg))
end

local function log_warning(uuid, msg)
    freeswitch.consoleLog("WARNING", string.format("%s [%s] %s\n", LOG_PREFIX, uuid, msg))
end

-- ============================================
-- Vendored pure-Lua libs (loaded via loadfile() — mod_lua cpath is fragile;
-- see scripts/CLAUDE.md gotcha #10, mirrors lib/db_client loading)
-- ============================================

local function load_lib(name)
    local path = "/usr/local/freeswitch/scripts/lib/" .. name .. ".lua"
    local chunk, lerr = loadfile(path)
    if not chunk then
        freeswitch.consoleLog("ERR", string.format(
            "%s failed to loadfile %s: %s\n", LOG_PREFIX, path, tostring(lerr)))
        return nil
    end
    local ok, mod = pcall(chunk)
    if not ok then
        freeswitch.consoleLog("ERR", string.format(
            "%s failed to initialize %s: %s\n", LOG_PREFIX, name, tostring(mod)))
        return nil
    end
    return mod
end

local xml_lib = load_lib("xml")           -- real XML parser (replaces regex parser)
local hmac_lib = load_lib("hmac_sha256")  -- HMAC-SHA256 for webhook signing
local rec_notify_lib = load_lib("rec_notify")  -- recordings-ingest notify (Phase 6)

-- ============================================
-- Session helpers
-- ============================================

-- Ensure session exists
if not session then
    freeswitch.consoleLog("ERR", LOG_PREFIX .. " No session object - cannot execute webhook\n")
    return
end

local function get_var(name, default)
    local ok, val = pcall(function()
        return session:getVariable(name)
    end)
    if ok and val and val ~= "" then
        return val
    end
    return default
end

local function set_var(name, value)
    if value ~= nil then
        pcall(function()
            session:setVariable(name, tostring(value))
        end)
    end
end

local function session_ready()
    local ok, result = pcall(function()
        return session:ready()
    end)
    return ok and result
end

-- ============================================
-- Gather session variables
-- ============================================

local uuid = get_var("uuid", "unknown")
local caller_id = get_var("caller_id_number", "unknown")
local destination = get_var("destination_number", "unknown")
local customer_id = get_var("customer_id", "unknown")
local voice_url = get_var("voice_url", nil)

-- Use the actual SIP Call-ID from the inbound INVITE for X-CID correlation.
-- Allows Homer to correlate A-leg and B-leg captures. Fallback to uuid if not set.
local sip_call_id = session:getVariable("sip_call_id") or uuid
local fallback_url = get_var("fallback_url", nil)
local status_callback = get_var("status_callback", nil)
local direction = get_var("direction", "inbound")
local call_start_time = os.time()

-- Per-customer webhook signing secret (set by inbound_router api branch from the
-- api_dids JOIN customers lookup). When present, every outbound webhook POST/GET
-- carries an X-Revup-Signature header the customer can verify.
local webhook_signing_secret = get_var("webhook_signing_secret", nil)

log_info(uuid, string.format(
    "Webhook engine starting: from=%s to=%s customer=%s direction=%s voice_url=%s",
    caller_id, destination, customer_id, direction, tostring(voice_url)
))

-- ============================================
-- URL encoding helper
-- ============================================

local function url_encode(str)
    if str == nil then return "" end
    str = tostring(str)
    str = str:gsub("\n", "\r\n")
    str = str:gsub("([^%w%-_.~])", function(c)
        return string.format("%%%02X", string.byte(c))
    end)
    return str
end

-- Build form-encoded body from a table of key-value pairs
local function build_form_body(params)
    local parts = {}
    for k, v in pairs(params) do
        table.insert(parts, url_encode(k) .. "=" .. url_encode(v))
    end
    return table.concat(parts, "&")
end

-- ============================================
-- Resolve relative/absolute URLs
-- ============================================

-- Extract base URL (scheme + host + port) from a full URL
local function get_base_url(url)
    if not url then return "" end
    -- Match scheme://host:port or scheme://host
    local base = url:match("^(https?://[^/]+)")
    return base or ""
end

-- Resolve a URL that may be relative against a base URL
local function resolve_url(url, base_url)
    if not url or url == "" then return base_url end
    -- Already absolute
    if url:match("^https?://") then
        return url
    end
    -- Relative path - combine with base
    local base = get_base_url(base_url)
    if base == "" then
        log_warning(uuid, "Cannot resolve relative URL without base: " .. url)
        return url
    end
    -- Ensure path starts with /
    if url:sub(1, 1) ~= "/" then
        url = "/" .. url
    end
    return base .. url
end

-- ============================================
-- XML Parser
-- ============================================
-- TwiML layer over lib/xml.lua (the vendored pure-Lua XML parser). This replaces
-- the old regex parser. It flattens the parsed DOM into the verb tree the
-- executor consumes: top-level <Response> children become verbs, each verb's
-- direct text is its `text`, and each verb's element children become `children`
-- (inline grandchildren elements are STRIPPED from the text, fixing the old
-- grandchild-leak bug). Entities/CDATA/quotes/nesting are all handled by xml.lua.
-- Malformed input returns nil + a clear error so the caller takes the fallback
-- path instead of silently executing wrong behavior.

-- BEGIN PARSER SECTION
-- (Sliced verbatim by tests/twiml/lua_parser_harness.lua. Keep this region
--  self-contained except for the injected upvalue `xml_lib`.)
local function parse_xml(xml_string)
    if not xml_string or xml_string == "" then
        return nil, "Empty XML string"
    end
    if not xml_lib then
        return nil, "XML library unavailable"
    end

    local root, perr = xml_lib.parse(xml_string)
    if not root then
        return nil, "malformed XML: " .. tostring(perr)
    end

    -- TwiML is case-sensitive on the root element: it must be exactly <Response>.
    if root.tag ~= "Response" then
        return nil, "No <Response> root element found (got <" .. tostring(root.tag) .. ">)"
    end

    local function trim(s)
        return (tostring(s or ""):gsub("^%s*(.-)%s*$", "%1"))
    end

    local verbs = {}
    for _, child in ipairs(root.kids) do
        if type(child) == "table" then
            -- Element children of this verb (Gather>Say/Play/Pause, Dial>Number, ...)
            local elem_kids = {}
            for _, gk in ipairs(child.kids) do
                if type(gk) == "table" then
                    elem_kids[#elem_kids + 1] = gk
                end
            end

            local verb = {
                verb = child.tag,
                attrs = child.attrs,
                text = trim(xml_lib.direct_text(child)),
                children = {},
            }

            for _, gk in ipairs(elem_kids) do
                table.insert(verb.children, {
                    verb = gk.tag,
                    attrs = gk.attrs,
                    text = trim(xml_lib.direct_text(gk)),
                })
            end

            table.insert(verbs, verb)
        end
    end

    return verbs, nil
end
-- END PARSER SECTION

-- ============================================
-- HTTP request via the system curl binary
-- ============================================
-- We shell out to /usr/bin/curl (present in the FS image) rather than mod_curl's
-- `curl` API because that API cannot set a custom REQUEST header — and the
-- webhook-signing contract requires the X-Revup-Signature header on every POST.
-- All interpolated values are single-quote shell-escaped (shq) to prevent
-- command injection from customer-controlled URLs/params.

-- Safe POSIX shell single-quoting: wrap in '...' and replace ' with '\''.
local function shq(s)
    return "'" .. tostring(s):gsub("'", "'\\''") .. "'"
end

-- HTTPS enforcement: reject non-https webhook/action URLs unless WEBHOOK_ALLOW_HTTP=true.
local function url_is_allowed(url)
    if not url or url == "" then
        return false, "empty URL"
    end
    if url:match("^https://") then
        return true
    end
    if url:match("^http://") then
        if ALLOW_HTTP then
            log_warning(uuid, "WEBHOOK_ALLOW_HTTP=true — permitting non-HTTPS webhook URL: " .. url)
            return true
        end
        return false, "non-HTTPS webhook URL refused (set WEBHOOK_ALLOW_HTTP=true for dev): " .. url
    end
    return false, "unsupported URL scheme: " .. url
end

-- Compute the Twilio-style HMAC-SHA256 signature for a webhook request.
--   POST: signing_string = url .. concat(sorted "key"..value over POST params)
--   GET:  signing_string = full url including the query string (no param concat)
-- Returns base64 signature, or nil if no secret/lib (caller POSTs unsigned).
local function compute_signature(url, params, method)
    if not webhook_signing_secret or webhook_signing_secret == "" then
        return nil
    end
    if not hmac_lib then
        log_warning(uuid, "hmac lib unavailable — sending webhook UNSIGNED")
        return nil
    end
    local signing_string
    if method == "GET" then
        signing_string = url
    else
        local keys = {}
        for k in pairs(params or {}) do keys[#keys + 1] = k end
        table.sort(keys)
        local parts = { url }
        for _, k in ipairs(keys) do
            parts[#parts + 1] = k .. tostring(params[k])
        end
        signing_string = table.concat(parts)
    end
    local ok, sig = pcall(function()
        return hmac_lib.sign(webhook_signing_secret, signing_string)
    end)
    if not ok then
        log_err(uuid, "signature computation failed: " .. tostring(sig))
        return nil
    end
    return sig
end

-- Single HTTP request. method = "POST" (default) or "GET". Returns body, err.
local function http_request(url, params, method)
    method = (method == "GET") and "GET" or "POST"

    local allowed, why = url_is_allowed(url)
    if not allowed then
        return nil, why
    end

    local final_url = url
    local body = nil
    if method == "GET" then
        local qs = build_form_body(params)
        if qs ~= "" then
            final_url = url .. (url:find("?", 1, true) and "&" or "?") .. qs
        end
    else
        body = build_form_body(params)
    end

    -- Sign: POST signs over base url + sorted params; GET over the full URL.
    local signature = compute_signature(method == "GET" and final_url or url, params, method)

    local argv = { "curl", "-sS", "--max-time", tostring(HTTP_TIMEOUT), "-X", method }
    if method ~= "GET" then
        argv[#argv + 1] = "-H"
        argv[#argv + 1] = "Content-Type: application/x-www-form-urlencoded"
        argv[#argv + 1] = "--data-binary"
        argv[#argv + 1] = body or ""
    end
    if signature then
        argv[#argv + 1] = "-H"
        argv[#argv + 1] = "X-Revup-Signature: " .. signature
    end
    argv[#argv + 1] = final_url

    local quoted = {}
    for i, a in ipairs(argv) do quoted[i] = shq(a) end
    local cmd = table.concat(quoted, " ") .. " 2>/dev/null"

    log_debug(uuid, string.format("HTTP %s %s signed=%s", method, final_url, tostring(signature ~= nil)))

    local fh = io.popen(cmd, "r")
    if not fh then
        return nil, "io.popen failed for curl"
    end
    local response = fh:read("*a") or ""
    local ok_close, _, code = fh:close()

    if response == "" then
        return nil, string.format("empty response from webhook (curl exit=%s)", tostring(code))
    end

    log_debug(uuid, string.format("HTTP response length=%d", #response))
    return response, nil
end

-- Best-effort sleep between retries (bounded backoff). No-op if unavailable.
local function backoff_sleep(ms)
    pcall(function()
        if freeswitch.msleep then
            freeswitch.msleep(ms)
        end
    end)
end

-- POST/GET a URL with bounded retry + exponential backoff. Returns body, err.
local function http_with_retry(url, params, method)
    local err
    local response
    for attempt = 1, HTTP_MAX_ATTEMPTS do
        response, err = http_request(url, params, method)
        if response then
            if attempt > 1 then
                log_info(uuid, string.format("Webhook fetch succeeded on attempt %d: %s", attempt, url))
            end
            return response, nil
        end
        -- Do not retry a hard policy rejection (e.g. non-HTTPS) — it will never succeed.
        if err and (err:find("refused", 1, true) or err:find("unsupported URL", 1, true) or err:find("empty URL", 1, true)) then
            return nil, err
        end
        if attempt < HTTP_MAX_ATTEMPTS then
            local delay = HTTP_BACKOFF_MS * (2 ^ (attempt - 1))
            log_warning(uuid, string.format(
                "Webhook fetch failed (attempt %d/%d): %s — retrying in %dms",
                attempt, HTTP_MAX_ATTEMPTS, tostring(err), delay))
            backoff_sleep(delay)
        end
    end
    log_err(uuid, string.format("Webhook fetch failed after %d attempts: %s", HTTP_MAX_ATTEMPTS, tostring(err)))
    return nil, err
end

-- ============================================
-- Fetch and parse instructions from a webhook URL.
-- Applies fallback_url to ANY action URL (not just the initial fetch): if the
-- primary URL fails after retries, try the configured fallback_url before giving
-- up. `method` ("POST"/"GET") is honored per the verb's method attribute.
-- ============================================

-- Fetch + parse a single URL (with transport retry). Returns verbs, err.
local function fetch_and_parse(url, params, method)
    local response, err = http_with_retry(url, params, method)
    if not response then
        return nil, err
    end
    -- Real parser. Malformed XML is a hard failure (never execute wrong behavior).
    local verbs, parse_err = parse_xml(response)
    if not verbs then
        log_err(uuid, "XML parse failed for " .. tostring(url) .. ": " .. tostring(parse_err) ..
            " | raw=" .. response:sub(1, 500))
        return nil, "XML parse error: " .. tostring(parse_err)
    end
    log_info(uuid, string.format("Parsed %d verb(s) from %s", #verbs, url))
    return verbs, nil
end

local function fetch_instructions(url, params, method)
    local verbs, err = fetch_and_parse(url, params, method)

    -- Fallback URL applies to EVERY action fetch (Gather/Dial/Redirect + initial),
    -- and covers BOTH transport failure and a primary that returns malformed XML.
    if not verbs and fallback_url and fallback_url ~= "" and fallback_url ~= url then
        log_warning(uuid, "Primary webhook failed (" .. tostring(err) .. "), trying fallback_url: " .. fallback_url)
        verbs, err = fetch_and_parse(fallback_url, params, method)
    end

    return verbs, err
end

-- Build the standard webhook parameters for a request
local function build_webhook_params(extra)
    local params = {
        CallSid     = uuid,
        AccountSid  = customer_id,
        From        = caller_id,
        To          = destination,
        CallStatus  = "in-progress",
        Direction   = direction
    }
    -- Merge extra params
    if extra then
        for k, v in pairs(extra) do
            params[k] = v
        end
    end
    return params
end

-- ============================================
-- Recording + media-streaming helpers (Phase 6)
-- ============================================
-- Standalone recording uses CORE FreeSWITCH (no extra module): the `record`
-- application for <Record> (one channel) and `record_session`/`stop_record_session`
-- for <Dial record> (the mixed A+B legs). Media streaming uses mod_audio_stream
-- (forks L16 audio to a WebSocket) when it is built into the image.

-- Generate a unique recording id. Prefer FreeSWITCH's create_uuid; fall back to
-- a time+random composite if the API is unavailable (e.g. unit harness).
local function new_recording_uuid()
    local id
    pcall(function()
        local api = freeswitch.API()
        if api then
            local r = api:executeString("create_uuid")
            if r and r ~= "" then id = (r:gsub("%s+", "")) end
        end
    end)
    if not id or id == "" then
        id = string.format("rec-%d-%d", os.time(), math.random(100000, 999999))
    end
    return id
end

-- Build the tenant-scoped spool path and ensure the customer dir exists.
local function recording_spool_path(rec_uuid)
    local cust = tostring(customer_id or "unknown"):gsub("[^%w_%-]", "")
    if cust == "" then cust = "unknown" end
    local dir = string.format("%s/customer_%s", RECORDINGS_DIR, cust)
    pcall(function() os.execute("mkdir -p " .. shq(dir)) end)
    return string.format("%s/%s.wav", dir, rec_uuid)
end

-- POST recording metadata to the API ingest (shared contract). Fail-open: on
-- Docker Desktop FS->API is unreachable, which is fine — the WAV is on the spool.
-- Returns the API's stored key / serve URL when it answers, else nil.
local function notify_recording(rec_uuid, spool_path, duration_ms, kind)
    if not rec_notify_lib then return nil end
    local res
    local ok = pcall(function()
        res = rec_notify_lib.notify({
            recording_uuid = rec_uuid,
            customer_id    = customer_id,
            call_uuid      = uuid,
            spool_path     = spool_path,
            duration_ms    = duration_ms,
            kind           = kind or "programmable",
        })
    end)
    if not ok or not res then return nil end
    return res.recording_url or res.storage_key
end

-- Is mod_audio_stream loaded in this FreeSWITCH? Cached per-process.
local _audio_stream_cached = nil
local function audio_stream_available()
    if _audio_stream_cached ~= nil then return _audio_stream_cached end
    local avail = false
    pcall(function()
        local api = freeswitch.API()
        if api then
            local r = api:executeString("module_exists mod_audio_stream")
            avail = (tostring(r or ""):gsub("%s+", "")) == "true"
        end
    end)
    _audio_stream_cached = avail
    return avail
end

-- Start a mono audio fork to a ws/wss URL via mod_audio_stream. Returns true if
-- the fork was started. NEVER a silent no-op: when the module is absent it logs
-- a clear, actionable warning so operators know streaming did not happen.
local function start_audio_stream(url)
    if not url or url == "" then
        log_warning(uuid, "Stream verb has no url — skipping")
        return false
    end
    if not (url:match("^wss://") or url:match("^ws://")) then
        log_warning(uuid, "Stream url is not ws/wss (" .. url .. ") — skipping")
        return false
    end
    if not audio_stream_available() then
        log_warning(uuid, string.format(
            "audio streaming module not available (mod_audio_stream not loaded) — "
            .. "cannot fork call audio to %s. Build mod_audio_stream into the FS "
            .. "image to enable <Stream>/<Connect><Stream>.", url))
        return false
    end
    -- Audio must be flowing for the fork to carry frames.
    if direction == "inbound" then
        pcall(function()
            local answered = false
            pcall(function() answered = session:answered() end)
            if not answered then session:answer() end
        end)
    end
    local started = false
    pcall(function()
        local api = freeswitch.API()
        -- uuid_audio_stream <uuid> start <ws-url> <mix-type> <sampling-rate>
        local arg = string.format("%s start %s mono %s", uuid, url, STREAM_SAMPLE_RATE)
        local r = api:executeString("uuid_audio_stream " .. arg)
        log_info(uuid, string.format("uuid_audio_stream start url=%s rate=%s -> %s",
            url, STREAM_SAMPLE_RATE, tostring(r)))
        started = true
    end)
    return started
end

local function stop_audio_stream()
    pcall(function()
        freeswitch.API():executeString("uuid_audio_stream " .. uuid .. " stop")
    end)
end

-- ============================================
-- Verb execution functions
-- ============================================

-- Forward declarations for mutual recursion
local execute_verbs

-- Track redirect depth to prevent infinite loops
local redirect_depth = 0

-- Keep track of the current base URL for resolving relative URLs
local current_base_url = voice_url or ""

-- Play an error tone to indicate a problem to the caller
local function play_error_tone()
    pcall(function()
        session:execute("playback", "tone_stream://%(250,0,800);%(250,100,800);%(250,0,800)")
    end)
end

-- ============================================
-- <Say> verb
-- ============================================
local function execute_say(verb)
    local raw = verb.text or ""
    -- SSML safety: if the customer sent <speak>...</speak> or inline SSML tags,
    -- strip them so the engine never reads markup aloud (Phase 7).
    local text = strip_ssml(raw)
    if text == "" then
        log_warning(uuid, "Say verb with empty text, skipping")
        return
    end

    local language = verb.attrs.language or "en"
    -- Map the Twilio-ish voice/language to the configured TTS engine's voice.
    local voice = map_tts_voice(verb.attrs.voice, language)
    local loop = tonumber(verb.attrs.loop) or 1

    log_info(uuid, string.format("Say: engine=%s text='%s' voice=%s lang=%s loop=%d%s",
        TTS_ENGINE, text:sub(1, 80), voice, language, loop,
        (raw ~= text) and " (SSML stripped)" or ""))

    for i = 1, loop do
        if not session_ready() then break end
        local ok, err = pcall(function()
            -- Pluggable engine: <engine>|<voice>|<text>. Swap engines via TTS_ENGINE.
            session:execute("speak", TTS_ENGINE .. "|" .. voice .. "|" .. text)
        end)
        if not ok then
            log_warning(uuid, "speak (" .. TTS_ENGINE .. ") failed: " .. tostring(err) .. " - trying fallback")
            -- Fallback: the say module (number/letter pronunciation, no TTS engine).
            pcall(function()
                session:execute("playback", "say:" .. language .. ":PRONOUNCED:" .. text)
            end)
        end
    end
end

-- ============================================
-- <Play> verb
-- ============================================
local function execute_play(verb)
    local url = verb.text or ""
    if url == "" then
        log_warning(uuid, "Play verb with empty URL, skipping")
        return
    end

    local loop = tonumber(verb.attrs.loop) or 1

    log_info(uuid, string.format("Play: url='%s' loop=%d", url, loop))

    for i = 1, loop do
        if not session_ready() then break end
        local ok, err = pcall(function()
            -- FreeSWITCH mod_shout handles HTTP URLs for playback
            session:execute("playback", url)
        end)
        if not ok then
            log_err(uuid, "Play failed: " .. tostring(err) .. " url=" .. url)
        end
    end
end

-- ============================================
-- <Pause> verb
-- ============================================
local function execute_pause(verb)
    local length = tonumber(verb.attrs.length) or 1
    log_info(uuid, string.format("Pause: length=%d seconds", length))

    pcall(function()
        session:execute("sleep", tostring(length * 1000))
    end)
end

-- ============================================
-- <Hangup> verb
-- ============================================
local function execute_hangup(verb)
    local reason = verb.attrs.reason or "NORMAL_CLEARING"

    -- Map friendly reasons to FreeSWITCH hangup causes
    local reason_map = {
        ["completed"]  = "NORMAL_CLEARING",
        ["busy"]       = "USER_BUSY",
        ["rejected"]   = "CALL_REJECTED",
        ["no-answer"]  = "NO_ANSWER"
    }
    local fs_cause = reason_map[reason] or reason

    log_info(uuid, string.format("Hangup: reason=%s (fs_cause=%s)", reason, fs_cause))

    pcall(function()
        session:hangup(fs_cause)
    end)
end

-- ============================================
-- <Reject> verb
-- ============================================
local function execute_reject(verb)
    local reason = verb.attrs.reason or "rejected"

    local code_map = {
        ["rejected"] = "403 Forbidden",
        ["busy"]     = "486 Busy Here"
    }
    local sip_code = code_map[reason] or "403 Forbidden"

    log_info(uuid, string.format("Reject: reason=%s sip=%s", reason, sip_code))

    pcall(function()
        session:execute("respond", sip_code)
    end)
end

-- ============================================
-- <Gather> verb
-- ============================================
local function execute_gather(verb)
    local num_digits = tonumber(verb.attrs.numDigits) or 128
    local timeout = tonumber(verb.attrs.timeout) or GATHER_DEFAULT_TIMEOUT
    local finish_on_key = verb.attrs.finishOnKey or "#"
    local action_url = verb.attrs.action or nil
    local method = (verb.attrs.method == "GET") and "GET" or "POST"

    -- Resolve action URL against current base
    if action_url then
        action_url = resolve_url(action_url, current_base_url)
    end

    log_info(uuid, string.format("Gather: numDigits=%d timeout=%d finishOnKey='%s' action=%s",
        num_digits, timeout, finish_on_key, tostring(action_url)))

    local digits = ""

    -- Check if there are child verbs to play as a prompt
    if verb.children and #verb.children > 0 then
        -- We need to play the prompt while collecting digits.
        -- Use play_and_get_digits for child Say/Play verbs.
        -- For simplicity, concatenate all child prompts into a single TTS or playback,
        -- then use getDigits during playback.

        -- Strategy: For each child, if it's a Say, use speak; if it's Play, use playback.
        -- We use session input callback to collect digits during playback.

        -- Simple approach: play children as prompts, then collect digits
        -- Actually, the best approach is to use play_and_get_digits if there's a single prompt,
        -- or fall back to playing children then getDigits.

        -- Build a prompt file/command from children
        -- For the POC, play children sequentially then collect digits after
        for _, child in ipairs(verb.children) do
            if not session_ready() then return end
            if child.verb == "Say" then
                local ok, err = pcall(function()
                    session:execute("speak", "flite|kal|" .. (child.text or ""))
                end)
                if not ok then
                    pcall(function()
                        session:execute("playback", "say:en:PRONOUNCED:" .. (child.text or ""))
                    end)
                end
            elseif child.verb == "Play" then
                pcall(function()
                    session:execute("playback", child.text or "")
                end)
            elseif child.verb == "Pause" then
                local child_len = tonumber(child.attrs.length) or 1
                pcall(function()
                    session:execute("sleep", tostring(child_len * 1000))
                end)
            end
        end

        -- Now collect digits
        if session_ready() then
            local ok, result = pcall(function()
                return session:getDigits(num_digits, finish_on_key, timeout * 1000)
            end)
            if ok and result then
                digits = result
            end
        end
    else
        -- No children - just wait for digits with silence
        if session_ready() then
            local ok, result = pcall(function()
                return session:getDigits(num_digits, finish_on_key, timeout * 1000)
            end)
            if ok and result then
                digits = result
            end
        end
    end

    log_info(uuid, string.format("Gather result: digits='%s'", digits))

    if digits ~= "" and action_url then
        -- POST digits to action URL, then execute the new instructions
        log_info(uuid, string.format("Gather: posting digits='%s' to %s", digits, action_url))

        local params = build_webhook_params({ Digits = digits })
        local new_verbs, err = fetch_instructions(action_url, params, method)

        if new_verbs then
            -- Update the base URL for relative URL resolution in the new instruction set
            local saved_base = current_base_url
            current_base_url = action_url
            execute_verbs(new_verbs)
            current_base_url = saved_base
            return "stop"  -- Signal that we executed new instructions; don't continue current verb list
        else
            log_err(uuid, "Failed to fetch Gather action URL: " .. tostring(err))
        end
    elseif digits ~= "" then
        -- Digits collected but no action URL - store in channel variable
        set_var("gathered_digits", digits)
        log_info(uuid, "Gather: digits stored in channel variable (no action URL)")
    else
        -- No digits collected
        log_info(uuid, "Gather: no input received, falling through to next verb")
    end

    return nil  -- Continue to next verb
end

-- ============================================
-- Conference / Queue naming (customer-scoped; needs `customer_id` upvalue)
-- ============================================

-- conf_<cid>_<sanitized name> — the SHARED CONTRACT room name the API controls.
local function conference_room_name(name)
    local cust = sanitize_token(customer_id)
    return string.format("conf_%s_%s", cust, sanitize_token(name))
end

-- fifo_<cid>_<sanitized name> — tenant-scoped FIFO queue name (mod_fifo).
local function queue_name(name)
    local cust = sanitize_token(customer_id)
    return string.format("fifo_%s_%s", cust, sanitize_token(name))
end

-- Forward declaration: <Dial><Queue> dequeues; defined with the queue verbs below.
local execute_dial_queue

-- ============================================
-- <Dial> child builders: <Sip> and <Client>  (Phase 7)
-- ============================================

-- <Sip>sip:user@host</Sip> -> a sofia dial string. External URIs go out the
-- `external` profile (public IP in Via/Contact/SDP); URIs targeting our own
-- internal domain use the `internal` profile. Optional username/password on the
-- <Sip> element become sip_auth_username/sip_auth_password for digest auth.
local function build_sip_dialstring(child, dial_timeout)
    local uri = (child.text or ""):gsub("^%s*(.-)%s*$", "%1")
    if uri == "" then return nil end
    -- Accept "sip:user@host", "sips:...", or bare "user@host".
    if not uri:match("^sips?:") then
        uri = "sip:" .. uri
    end
    local a = child.attrs or {}
    local host = uri:match("@([^;>%s]+)") or ""
    -- Internal if it targets our platform domain; else the carrier-facing profile.
    local domain = get_var("domain", nil) or os.getenv("DOMAIN") or "voiceplatform.local"
    local profile = (host == domain or host:match("%.?" .. domain:gsub("%.", "%%.") .. "$"))
        and "internal" or "external"

    local vars = {
        string.format("call_timeout=%d", dial_timeout),
        "ignore_early_media=false",
        "sip_enable_soa=false",
        "sip_session_timeout=1800",
        "sip_minimum_session_expires=90",
        "enable_timer=true",
        string.format("sip_h_X-CID=%s", sip_call_id),
    }
    if a.username and a.username ~= "" then
        vars[#vars + 1] = "sip_auth_username=" .. a.username
    end
    if a.password and a.password ~= "" then
        vars[#vars + 1] = "sip_auth_password=" .. a.password
    end
    return string.format("{%s}sofia/%s/%s", table.concat(vars, ","), profile, uri)
end

-- <Client>identity</Client> -> bridge to a registered Verto/WebRTC client (or a
-- SIP-registered extension as fallback), mirroring handlers/ucaas.lua's string.
-- Customer-scoped domain so identities never collide across tenants.
local function build_client_dialstring(identity, dial_timeout)
    identity = (identity or ""):gsub("^%s*(.-)%s*$", "%1")
    if identity == "" then return nil end
    local base_domain = get_var("domain", nil) or os.getenv("DOMAIN") or "voiceplatform.local"
    local cust_domain = string.format("customer_%s.%s", tostring(customer_id), base_domain)
    return string.format(
        "{ignore_early_media=false,call_timeout=%d}verto.rtc/%s@%s|user/%s@%s",
        dial_timeout, identity, cust_domain, identity, cust_domain
    )
end

-- ============================================
-- <Conference> verb (Twilio nests it in <Dial>; we also accept it top-level)
-- ============================================
-- Joins the customer-scoped mod_conference room conf_<cid>_<name>. The conference
-- app BLOCKS until the member leaves (hangup / kicked / # control), so this owns
-- the call for its lifetime. Attribute map (Twilio -> mod_conference):
--   muted=true               -> +flags{mute}
--   startConferenceOnEnter   -> default true; false -> +flags{wait-mod} (hold until a moderator joins)
--   endConferenceOnExit=true -> +flags{endconf|moderator} (conf ends when this member leaves)
--   beep                     -> conference_enter_sound/exit_sound channel vars (true|false|onEnter|onExit)
--   waitUrl/waitMethod       -> conference_moh_sound (MOH while alone; URL or silence)
--   maxParticipants          -> conference_max_members channel var
--   record                   -> conference_auto_record=<spool wav>; notify ingest kind="conference"
--   video                    -> use the @video profile instead of @default
local function execute_conference(verb)
    local name = verb.text or ""
    if name == "" then
        log_warning(uuid, "Conference verb with no room name, skipping")
        return nil
    end
    local a = verb.attrs or {}
    local profile = (a.video and a.video ~= "" and a.video ~= "false")
        and CONF_PROFILE_VIDEO or CONF_PROFILE_AUDIO
    local room = conference_room_name(name)

    -- Build the +flags{...} set.
    local flags = { "speak" }  -- mirror public.xml: keep speak in passthrough video
    if a.muted == "true" or a.muted == "1" then flags[#flags + 1] = "mute" end
    -- startConferenceOnEnter defaults to true (Twilio). false => wait for a moderator.
    if a.startConferenceOnEnter == "false" then flags[#flags + 1] = "wait-mod" end
    if a.endConferenceOnExit == "true" then
        flags[#flags + 1] = "endconf"
        flags[#flags + 1] = "moderator"
    end
    local flag_str = "+flags{" .. table.concat(flags, "|") .. "}"

    -- beep: enter/exit tones. Twilio accepts true/false/onEnter/onExit.
    local beep = a.beep or "true"
    if beep == "false" then
        set_var("conference_enter_sound", "")
        set_var("conference_exit_sound", "")
    elseif beep == "onEnter" then
        set_var("conference_exit_sound", "")
    elseif beep == "onExit" then
        set_var("conference_enter_sound", "")
    end

    -- waitUrl: MOH while alone. A real URL is played by mod_shout; otherwise silence.
    local wait_url = a.waitUrl
    if wait_url and wait_url ~= "" then
        set_var("conference_moh_sound", wait_url)
    else
        set_var("conference_moh_sound", "silence_stream://-1")
    end

    -- maxParticipants
    local max_p = tonumber(a.maxParticipants)
    if max_p and max_p > 0 then
        set_var("conference_max_members", tostring(max_p))
    end

    -- record: auto-record the whole conference to the tenant spool.
    local do_record = a.record and a.record ~= "" and a.record ~= "false"
        and a.record ~= "do-not-record"
    local rec_uuid, rec_spool
    if do_record then
        rec_uuid = new_recording_uuid()
        rec_spool = recording_spool_path(rec_uuid)
        set_var("conference_auto_record", rec_spool)
        log_info(uuid, string.format("Conference record -> %s (uuid=%s)", rec_spool, rec_uuid))
    end

    -- The caller's media must be flowing before joining (Twilio answers first).
    if direction == "inbound" then
        pcall(function()
            local answered = false
            pcall(function() answered = session:answered() end)
            if not answered then session:answer() end
        end)
    end

    local data = string.format("%s@%s%s", room, profile, flag_str)
    log_info(uuid, string.format(
        "Conference: name='%s' -> room=%s profile=%s flags=%s waitUrl=%s max=%s",
        name, room, profile, table.concat(flags, "|"),
        tostring(wait_url), tostring(max_p)))

    -- conference app blocks until the member leaves.
    pcall(function()
        session:execute("conference", data)
    end)

    -- Teardown: notify the recording ingest if we recorded.
    if do_record and rec_spool then
        local rec_dur = tonumber(get_var("conference_record_ms", ""))
            or tonumber(get_var("billmsec", "0")) or 0
        local rec_url = notify_recording(rec_uuid, rec_spool, rec_dur, "conference") or rec_spool
        set_var("RecordingUrl", rec_url)
        set_var("RecordingSid", rec_uuid)
    end

    -- The member has left the conference. Twilio continues to the next verb.
    return nil
end

-- ============================================
-- <Dial> verb
-- ============================================
local function execute_dial(verb)
    -- The number to dial can be in the text content or in <Number> children
    local dial_targets = {}
    local dial_caller_id = verb.attrs.callerId or nil
    local dial_timeout = tonumber(verb.attrs.timeout) or DIAL_DEFAULT_TIMEOUT
    local dial_action = verb.attrs.action or nil
    local dial_method = (verb.attrs.method == "GET") and "GET" or "POST"
    local dial_record = verb.attrs.record or nil

    -- <Dial record="..."> — record the bridged call. Any value other than the
    -- explicit opt-outs starts a session recording (record_session captures the
    -- mixed A+B audio). The Twilio "*-dual" variants request stereo (A/B split).
    local do_record = dial_record and dial_record ~= "" and dial_record ~= "false"
        and dial_record ~= "do-not-record"
    local rec_uuid, rec_spool, dial_recording_url

    -- Resolve action URL
    if dial_action then
        dial_action = resolve_url(dial_action, current_base_url)
    end

    -- Twilio nests <Conference>/<Queue> inside <Dial>. If present, that child owns
    -- the verb (you cannot also dial a PSTN number in the same <Dial>).
    if verb.children and #verb.children > 0 then
        for _, child in ipairs(verb.children) do
            if child.verb == "Conference" then
                return execute_conference(child)
            elseif child.verb == "Queue" then
                return execute_dial_queue(child, verb)
            end
        end
    end

    -- Collect dial targets from <Number>/<Sip>/<Client> children (and bare text).
    -- Each entry is a pre-built FreeSWITCH dial string; multiple entries ring
    -- SEQUENTIALLY (joined by "|" below). dial_targets holds the human label for
    -- logging only.
    local dial_strings_explicit = {}  -- Sip/Client (already full dial strings)
    if verb.children and #verb.children > 0 then
        for _, child in ipairs(verb.children) do
            if child.verb == "Number" and child.text and child.text ~= "" then
                table.insert(dial_targets, child.text)
            elseif child.verb == "Sip" and child.text and child.text ~= "" then
                local ds = build_sip_dialstring(child, dial_timeout)
                if ds then
                    table.insert(dial_strings_explicit, ds)
                    table.insert(dial_targets, child.text)
                end
            elseif child.verb == "Client" and child.text and child.text ~= "" then
                local ds = build_client_dialstring(child.text, dial_timeout)
                if ds then
                    table.insert(dial_strings_explicit, ds)
                    table.insert(dial_targets, "client:" .. child.text)
                end
            end
        end
    end

    -- Also check text content for a direct number
    if verb.text and verb.text ~= "" then
        table.insert(dial_targets, verb.text)
    end

    if #dial_targets == 0 then
        log_warning(uuid, "Dial verb with no targets, skipping")
        return
    end

    log_info(uuid, string.format("Dial: targets=%s callerId=%s timeout=%d",
        table.concat(dial_targets, ","), tostring(dial_caller_id), dial_timeout))

    -- Set caller ID if specified
    if dial_caller_id then
        set_var("effective_caller_id_number", dial_caller_id)
        set_var("effective_caller_id_name", dial_caller_id)
    end

    -- Set timeout
    set_var("call_timeout", tostring(dial_timeout))
    set_var("continue_on_fail", "true")
    set_var("hangup_after_bridge", "false")

    -- disable_soa on the A-leg session: CRITICAL for carrier interop.
    -- sip_enable_soa=false is in B-leg bridge string only

    -- RFC 4028 session timers: export to B-leg so mod_sofia includes
    -- Session-Expires and Min-SE in the outbound INVITE.
    -- CRITICAL: set_var() only sets on the A-leg. export via session:execute
    -- marks the variable for propagation to the B-leg channel.
    -- Belt-and-suspenders: these are also included in the bridge {} blocks.
    pcall(function() session:execute("export", "sip_session_timeout=1800") end)
    pcall(function() session:execute("export", "sip_minimum_session_expires=90") end)
    pcall(function() session:execute("export", "enable_timer=true") end)

    -- Build dial strings for all targets
    -- Multiple targets are separated by | for sequential or , for simultaneous
    local dial_strings = {}
    -- Webhook-driven calls are always API product -> use carrier_primary
    -- traffic_grade is retained as a secondary factor for priority within the trunk
    local gateway = "carrier_primary"
    log_info(uuid, string.format(
        "Dial: using gateway %s (product: api, traffic_grade: %s)",
        gateway, get_var("traffic_grade", "standard")
    ))

    for _, target in ipairs(dial_targets) do
        -- Sip/Client targets are pre-built (dial_strings_explicit); skip them here
        -- so the number-cleaner below never mangles a SIP URI / client identity.
        if target:match("^sip:") or target:match("^client:") then
            goto continue_target
        end
        local clean_target = target:gsub("[^%d+*#]", "")

        -- Check if target is a local extension (4 digits starting with 10xx)
        if clean_target:match("^10%d%d$") then
            local domain = get_var("domain", nil) or os.getenv("DOMAIN") or "voiceplatform.local"
            table.insert(dial_strings, string.format(
                "{call_timeout=%d,ignore_early_media=false}user/%s@%s",
                dial_timeout, clean_target, domain
            ))
        -- Check if target is a FreeSWITCH special extension (e.g., 9196 echo test)
        elseif clean_target:match("^9%d%d%d$") then
            local domain = get_var("domain", nil) or os.getenv("DOMAIN") or "voiceplatform.local"
            table.insert(dial_strings, string.format(
                "{call_timeout=%d,ignore_early_media=false}user/%s@%s",
                dial_timeout, clean_target, domain
            ))
        else
            -- External number - route via Kamailio proxy using external profile
            -- sofia/external/ ensures ext-sip-ip (public IP) is used in Via/Contact/SDP
            -- X-Carrier tells Kamailio which Bandwidth IP to route to
            local dial_number = clean_target:gsub("^%+", "")
            table.insert(dial_strings, string.format(
                "{call_timeout=%d,ignore_early_media=false,sip_enable_soa=false,sip_h_X-Carrier=primary" ..
                ",sip_h_X-CID=%s" ..
                ",sip_session_timeout=1800,sip_minimum_session_expires=90,enable_timer=true}sofia/external/%s@" .. sbc_proxy_ip .. ":5060",
                dial_timeout, sip_call_id, dial_number
            ))
        end
        ::continue_target::
    end

    -- Append pre-built Sip/Client dial strings (in document order, after numbers).
    for _, ds in ipairs(dial_strings_explicit) do
        table.insert(dial_strings, ds)
    end

    if #dial_strings == 0 then
        log_warning(uuid, "Dial: no resolvable targets after building dial strings, skipping")
        return
    end

    local combined_dial = table.concat(dial_strings, "|")

    log_info(uuid, string.format("Dial: bridge string=%s", combined_dial))

    -- Start recording the session BEFORE the bridge so the whole conversation
    -- (A+B mixed) is captured. record_session runs until stop_record_session.
    if do_record then
        rec_uuid = new_recording_uuid()
        rec_spool = recording_spool_path(rec_uuid)
        if dial_record:find("dual", 1, true) then
            pcall(function() session:execute("set", "RECORD_STEREO=true") end)
        end
        log_info(uuid, string.format(
            "Dial record=%s -> session recording uuid=%s file=%s",
            tostring(dial_record), rec_uuid, rec_spool))
        pcall(function() session:execute("record_session", rec_spool) end)
    end

    pcall(function()
        session:execute("bridge", combined_dial)
    end)

    -- Stop + notify the recording after the bridge tears down.
    if do_record and rec_spool then
        pcall(function() session:execute("stop_record_session", rec_spool) end)
        local rec_dur = tonumber(get_var("record_ms", ""))
            or tonumber(get_var("billmsec", "0")) or 0
        dial_recording_url = notify_recording(rec_uuid, rec_spool, rec_dur, "call")
            or rec_spool
        set_var("RecordingUrl", dial_recording_url)
        set_var("RecordingSid", rec_uuid)
    end

    -- Check dial result. originate_disposition is the authoritative FreeSWITCH
    -- variable ("SUCCESS" on connect, a failure cause otherwise). The old
    -- bridge_result read was a no-op (not a real channel variable) and is gone.
    local dial_status = get_var("originate_disposition", "")

    log_info(uuid, string.format("Dial result: disposition=%s", dial_status))

    -- If there's an action URL, POST the result
    if dial_action then
        local status_map = {
            ["SUCCESS"]                  = "completed",
            ["ORIGINATOR_CANCEL"]        = "canceled",
            ["USER_BUSY"]                = "busy",
            ["NO_ANSWER"]                = "no-answer",
            ["CALL_REJECTED"]            = "failed",
            ["NORMAL_TEMPORARY_FAILURE"] = "failed"
        }
        local dial_call_status = status_map[dial_status] or "failed"
        local dial_duration = get_var("billmsec", "0")

        local extra = {
            DialCallStatus = dial_call_status,
            DialCallDuration = tostring(math.floor(tonumber(dial_duration) / 1000))
        }
        -- Surface the recording to the action handler when Dial record was set.
        if dial_recording_url then
            extra.RecordingUrl = dial_recording_url
            extra.RecordingSid = rec_uuid
        end
        local params = build_webhook_params(extra)

        local new_verbs, err = fetch_instructions(dial_action, params, dial_method)
        if new_verbs then
            local saved_base = current_base_url
            current_base_url = dial_action
            execute_verbs(new_verbs)
            current_base_url = saved_base
            return "stop"
        else
            log_err(uuid, "Failed to fetch Dial action URL: " .. tostring(err))
        end
    end
end

-- ============================================
-- <Redirect> verb
-- ============================================
local function execute_redirect(verb)
    local redirect_url = verb.text or ""
    local method = (verb.attrs.method == "GET") and "GET" or "POST"

    if redirect_url == "" then
        log_warning(uuid, "Redirect verb with empty URL, skipping")
        return nil
    end

    -- Resolve relative URL
    redirect_url = resolve_url(redirect_url, current_base_url)

    redirect_depth = redirect_depth + 1
    if redirect_depth > MAX_REDIRECT_DEPTH then
        log_err(uuid, string.format("Redirect depth exceeded (%d), stopping", MAX_REDIRECT_DEPTH))
        return nil
    end

    log_info(uuid, string.format("Redirect: url=%s method=%s depth=%d", redirect_url, method, redirect_depth))

    local params = build_webhook_params()
    local new_verbs, err = fetch_instructions(redirect_url, params, method)

    if new_verbs then
        local saved_base = current_base_url
        current_base_url = redirect_url
        execute_verbs(new_verbs)
        current_base_url = saved_base
        return "stop"  -- Don't continue current verb list
    else
        log_err(uuid, "Failed to fetch Redirect URL: " .. tostring(err))
    end

    return nil
end

-- ============================================
-- <Record> verb  (standalone recording — core FS `record` app)
-- ============================================
local function execute_record(verb)
    local max_length    = tonumber(verb.attrs.maxLength) or RECORD_DEFAULT_MAXLEN
    local timeout       = tonumber(verb.attrs.timeout) or RECORD_DEFAULT_TIMEOUT
    local finish_on_key = verb.attrs.finishOnKey or "#"
    local play_beep     = not (verb.attrs.playBeep == "false")  -- default true (Twilio)
    local action_url    = verb.attrs.action or nil
    local method        = (verb.attrs.method == "GET") and "GET" or "POST"
    local status_cb     = verb.attrs.recordingStatusCallback or nil

    if action_url then action_url = resolve_url(action_url, current_base_url) end
    if status_cb then status_cb = resolve_url(status_cb, current_base_url) end

    -- The caller's audio must be flowing to capture it.
    if direction == "inbound" then
        pcall(function()
            local answered = false
            pcall(function() answered = session:answered() end)
            if not answered then session:answer() end
        end)
    end

    local rec_uuid = new_recording_uuid()
    local spool_path = recording_spool_path(rec_uuid)

    log_info(uuid, string.format(
        "Record: uuid=%s maxLength=%d timeout=%d finishOnKey='%s' playBeep=%s file=%s",
        rec_uuid, max_length, timeout, finish_on_key, tostring(play_beep), spool_path))

    -- finishOnKey terminates the record app via playback_terminators.
    pcall(function() session:execute("set", "playback_terminators=" .. finish_on_key) end)

    if play_beep then
        pcall(function() session:execute("playback", "tone_stream://%(1000,0,640)") end)
    end

    -- core record app: record <file> <time_limit_s> <silence_thresh> <silence_secs>
    if session_ready() then
        pcall(function()
            session:execute("record",
                string.format("%s %d 200 %d", spool_path, max_length, timeout))
        end)
    end

    -- Duration + terminating DTMF from the channel vars the record app sets.
    local dur_ms = tonumber(get_var("record_ms", "")) or 0
    if dur_ms == 0 then
        local secs = tonumber(get_var("record_seconds", ""))
        if secs then dur_ms = math.floor(secs * 1000) end
    end
    local digits = get_var("playback_terminator_used", "") or ""

    log_info(uuid, string.format("Record complete: uuid=%s duration_ms=%d digits='%s'",
        rec_uuid, dur_ms, digits))

    -- Notify the API ingest (shared contract). The stored key/serve URL it hands
    -- back is the recordingUrl surfaced to the customer; else fall back to spool.
    local recording_url = notify_recording(rec_uuid, spool_path, dur_ms, "programmable")
        or spool_path
    set_var("RecordingUrl", recording_url)
    set_var("RecordingSid", rec_uuid)

    -- recordingStatusCallback: fire-and-forget POST once the artifact is ready.
    if status_cb then
        local params = build_webhook_params({
            RecordingSid      = rec_uuid,
            RecordingUrl      = recording_url,
            RecordingDuration = tostring(math.floor(dur_ms / 1000)),
            RecordingStatus   = "completed",
        })
        pcall(function() http_request(status_cb, params, "POST") end)
    end

    -- action URL: POST recording info, execute the returned TwiML, then stop.
    if action_url then
        local params = build_webhook_params({
            RecordingSid      = rec_uuid,
            RecordingUrl      = recording_url,
            RecordingDuration = tostring(math.floor(dur_ms / 1000)),
            Digits            = digits,
        })
        local new_verbs, err = fetch_instructions(action_url, params, method)
        if new_verbs then
            local saved_base = current_base_url
            current_base_url = action_url
            execute_verbs(new_verbs)
            current_base_url = saved_base
            return "stop"
        else
            log_err(uuid, "Failed to fetch Record action URL: " .. tostring(err))
        end
    end

    return nil  -- continue to next verb
end

-- ============================================
-- <Stream> verb  (one-way audio fork; Twilio <Start><Stream> semantics)
-- ============================================
local function execute_stream(verb)
    local url = verb.attrs.url or verb.text or ""
    log_info(uuid, string.format("Stream: url=%s (one-way fork)", url))
    start_audio_stream(url)
    -- A <Stream> fork does NOT block — execution continues to the next verb.
    return nil
end

-- ============================================
-- <Connect><Stream> verb  (bidirectional media to a WS peer; OWNS the call)
-- ============================================
local function execute_connect(verb)
    local stream
    for _, child in ipairs(verb.children or {}) do
        if child.verb == "Stream" then
            stream = child
            break
        end
    end
    if not stream then
        log_warning(uuid, "Connect verb without a <Stream> child is not supported — skipping")
        return nil
    end
    local url = stream.attrs.url or stream.text or ""
    log_info(uuid, string.format("Connect><Stream: url=%s (bidirectional)", url))

    if not start_audio_stream(url) then
        -- Module unavailable / bad url: do NOT hang the call open with no stream.
        return nil
    end

    -- <Connect> owns the call for the streaming lifetime: hold it up until the
    -- channel hangs up (the WS peer / caller ends it), sleeping in 1s slices.
    while session_ready() do
        pcall(function() session:execute("sleep", "1000") end)
    end
    stop_audio_stream()
    return "stop"
end

-- ============================================
-- <Enqueue> / <Leave> / <Dial><Queue>  (Phase 7 — mod_fifo call queues)
-- ============================================
-- We use mod_fifo (already built into the image): named dynamic FIFOs map 1:1 to
-- Twilio's <Enqueue>name + <Dial><Queue>name. Queues are tenant-scoped
-- (fifo_<cid>_<name>). The agent side (<Dial><Queue>) dequeues the
-- longest-waiting caller.
--
-- DOCUMENTED LIMITATION: Twilio's <Leave> (and waitUrl-driven re-prompting) work
-- by executing TwiML WHILE the caller waits. mod_fifo's `in` app BLOCKS the caller
-- until an agent dequeues them or they hang up, so we cannot run a waitUrl TwiML
-- document mid-wait or honor a <Leave> emitted from one. waitUrl is therefore used
-- only as hold music (a real audio URL is streamed; otherwise silence). <Leave>
-- reached as a top-level verb (caller not currently blocked in a FIFO) simply ends
-- the current document. See docker/freeswitch/CLAUDE.md "Call queues".

local function execute_enqueue(verb)
    local name = verb.text or ""
    if name == "" then
        log_warning(uuid, "Enqueue verb with no queue name, skipping")
        return nil
    end
    local a = verb.attrs or {}
    local qname = queue_name(name)
    local wait_url = a.waitUrl
    local moh = (wait_url and wait_url ~= "") and wait_url or "silence_stream://-1"
    local action_url = a.action and resolve_url(a.action, current_base_url) or nil
    local method = (a.method == "GET") and "GET" or "POST"

    -- Answer so the caller hears hold music while queued.
    if direction == "inbound" then
        pcall(function()
            local answered = false
            pcall(function() answered = session:answered() end)
            if not answered then session:answer() end
        end)
    end

    log_info(uuid, string.format(
        "Enqueue: name='%s' -> fifo=%s moh=%s action=%s",
        name, qname, moh, tostring(action_url)))

    -- `fifo <name> in undef <music>` blocks until an agent dequeues us / we hang up.
    pcall(function()
        session:execute("fifo", string.format("%s in undef %s", qname, moh))
    end)

    -- Dequeued (or abandoned). QueueResult mirrors Twilio's action callback.
    local fifo_status = get_var("fifo_status", "")
    local queue_result = (fifo_status == "DONE") and "bridged"
        or (fifo_status == "ABORT") and "leave" or "hangup"
    log_info(uuid, string.format("Enqueue done: fifo_status=%s QueueResult=%s",
        tostring(fifo_status), queue_result))

    if action_url then
        local params = build_webhook_params({
            QueueResult = queue_result,
            QueueSid    = qname,
            QueueTime   = get_var("fifo_target_seconds", "0"),
        })
        local new_verbs, err = fetch_instructions(action_url, params, method)
        if new_verbs then
            local saved_base = current_base_url
            current_base_url = action_url
            execute_verbs(new_verbs)
            current_base_url = saved_base
            return "stop"
        else
            log_err(uuid, "Failed to fetch Enqueue action URL: " .. tostring(err))
        end
    end
    return nil
end

local function execute_leave(verb)
    -- Best-effort: end the current document so the caller proceeds past the queue.
    -- Cannot interrupt an in-progress <Enqueue> wait in the FIFO model (see note).
    log_info(uuid, "Leave: exiting current TwiML document (queue-leave semantics)")
    return "stop"
end

-- <Dial><Queue>name</Queue></Dial> — agent side: bridge to the longest-waiting
-- caller in the queue. `fifo <name> out nowait` connects immediately if a caller
-- is waiting; otherwise it returns and we fall through (optionally to action URL).
execute_dial_queue = function(queue_child, dial_verb)
    local name = queue_child.text or ""
    if name == "" then
        log_warning(uuid, "Dial>Queue with no queue name, skipping")
        return nil
    end
    local qname = queue_name(name)
    local action_url = dial_verb.attrs.action
        and resolve_url(dial_verb.attrs.action, current_base_url) or nil
    local method = (dial_verb.attrs.method == "GET") and "GET" or "POST"

    log_info(uuid, string.format("Dial>Queue: name='%s' -> fifo=%s out", name, qname))

    set_var("continue_on_fail", "true")
    set_var("hangup_after_bridge", "false")
    pcall(function()
        session:execute("fifo", string.format("%s out nowait", qname))
    end)

    local fifo_status = get_var("fifo_status", "")
    log_info(uuid, string.format("Dial>Queue done: fifo_status=%s", tostring(fifo_status)))

    if action_url then
        local params = build_webhook_params({
            DialCallStatus = (fifo_status == "DONE") and "completed" or "no-answer",
            QueueSid       = qname,
        })
        local new_verbs, err = fetch_instructions(action_url, params, method)
        if new_verbs then
            local saved_base = current_base_url
            current_base_url = action_url
            execute_verbs(new_verbs)
            current_base_url = saved_base
            return "stop"
        else
            log_err(uuid, "Failed to fetch Dial>Queue action URL: " .. tostring(err))
        end
    end
    return nil
end

-- ============================================
-- Main verb execution loop
-- ============================================

execute_verbs = function(verbs)
    if not verbs then return end

    for _, verb in ipairs(verbs) do
        if not session_ready() then
            log_info(uuid, "Session no longer ready, stopping verb execution")
            break
        end

        local result = nil
        local ok, err = pcall(function()
            if verb.verb == "Say" then
                execute_say(verb)
            elseif verb.verb == "Play" then
                execute_play(verb)
            elseif verb.verb == "Gather" then
                result = execute_gather(verb)
            elseif verb.verb == "Dial" then
                result = execute_dial(verb)
            elseif verb.verb == "Hangup" then
                execute_hangup(verb)
                result = "stop"
            elseif verb.verb == "Pause" then
                execute_pause(verb)
            elseif verb.verb == "Redirect" then
                result = execute_redirect(verb)
            elseif verb.verb == "Reject" then
                execute_reject(verb)
                result = "stop"
            elseif verb.verb == "Record" then
                result = execute_record(verb)
            elseif verb.verb == "Stream" then
                execute_stream(verb)
            elseif verb.verb == "Connect" then
                result = execute_connect(verb)
            elseif verb.verb == "Conference" then
                result = execute_conference(verb)
            elseif verb.verb == "Enqueue" then
                result = execute_enqueue(verb)
            elseif verb.verb == "Leave" then
                result = execute_leave(verb)
            else
                log_warning(uuid, "Unknown verb: " .. tostring(verb.verb) .. ", skipping")
            end
        end)

        if not ok then
            log_err(uuid, string.format("Verb '%s' execution error: %s", verb.verb, tostring(err)))
            -- Continue to next verb on failure
        end

        -- If the verb signaled to stop processing this verb list (Hangup, Redirect, Reject,
        -- or Gather/Dial with action URL that returned new instructions), break out
        if result == "stop" then
            return
        end
    end
end

-- ============================================
-- Status callback - POST final call status
-- ============================================

local function send_status_callback()
    if not status_callback or status_callback == "" then
        log_debug(uuid, "No status callback URL configured, skipping")
        return
    end

    local call_end_time = os.time()
    local call_duration = call_end_time - call_start_time
    local hangup_cause = get_var("hangup_cause", "NORMAL_CLEARING")

    -- Map FreeSWITCH hangup causes to friendly status names
    local status_map = {
        ["NORMAL_CLEARING"]          = "completed",
        ["ORIGINATOR_CANCEL"]        = "canceled",
        ["USER_BUSY"]                = "busy",
        ["NO_ANSWER"]                = "no-answer",
        ["CALL_REJECTED"]            = "failed",
        ["NORMAL_TEMPORARY_FAILURE"] = "failed",
        ["UNALLOCATED_NUMBER"]       = "failed"
    }
    local call_status = status_map[hangup_cause] or "completed"

    local params = {
        CallSid       = uuid,
        AccountSid    = customer_id,
        From          = caller_id,
        To            = destination,
        CallStatus    = call_status,
        Direction     = direction,
        Duration      = tostring(call_duration),
        CallDuration  = tostring(call_duration),
        HangupCause   = hangup_cause
    }

    log_info(uuid, string.format("Status callback: url=%s status=%s duration=%d",
        status_callback, call_status, call_duration))

    -- Fire and forget - don't block on status callback. Signed like every other
    -- webhook POST; HTTPS-enforced via http_request.
    local ok, err = pcall(function()
        http_request(status_callback, params, "POST")
    end)

    if not ok then
        log_warning(uuid, "Status callback failed: " .. tostring(err))
    end
end

-- ============================================
-- Main entry point
-- ============================================

local function main()
    if not voice_url then
        log_err(uuid, "No voice_url configured - cannot execute webhook")
        play_error_tone()
        pcall(function() session:hangup("NORMAL_TEMPORARY_FAILURE") end)
        return
    end

    -- Ensure the call is answered (for inbound calls)
    if direction == "inbound" then
        pcall(function()
            session:answer()
        end)
        -- Small delay for media to settle
        pcall(function()
            session:execute("sleep", "250")
        end)
    end

    -- Set initial base URL for relative URL resolution
    current_base_url = voice_url

    -- Fetch initial instructions from the voice URL. fetch_instructions already
    -- applies fallback_url internally (covering transport failure AND a primary
    -- that returns malformed XML), so no separate fallback retry is needed here.
    local params = build_webhook_params({ CallStatus = "ringing" })
    local verbs, err = fetch_instructions(voice_url, params)

    if not verbs then
        log_err(uuid, "All webhook URLs failed (" .. tostring(err) .. "), hanging up")
        play_error_tone()
        pcall(function() session:hangup("NORMAL_TEMPORARY_FAILURE") end)
        send_status_callback()
        return
    end

    -- Execute the verb list
    execute_verbs(verbs)

    -- Send status callback when execution completes
    send_status_callback()

    -- If session is still active after all verbs, hang up gracefully
    if session_ready() then
        log_info(uuid, "All verbs executed, hanging up")
        pcall(function() session:hangup("NORMAL_CLEARING") end)
    end

    log_info(uuid, "Webhook engine finished")
end

-- Run main entry point wrapped in pcall for safety
local ok, err = pcall(main)
if not ok then
    freeswitch.consoleLog("ERR", string.format(
        "%s [%s] Fatal error in webhook engine: %s\n",
        LOG_PREFIX, uuid, tostring(err)
    ))
    -- Attempt to send status callback even on fatal error
    pcall(send_status_callback)
    -- Attempt cleanup hangup
    pcall(function() session:hangup("NORMAL_TEMPORARY_FAILURE") end)
end
