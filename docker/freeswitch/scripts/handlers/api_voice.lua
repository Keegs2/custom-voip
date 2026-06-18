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
    local text = verb.text or ""
    if text == "" then
        log_warning(uuid, "Say verb with empty text, skipping")
        return
    end

    local voice = verb.attrs.voice or "kal"
    local language = verb.attrs.language or "en"
    local loop = tonumber(verb.attrs.loop) or 1

    log_info(uuid, string.format("Say: text='%s' voice=%s lang=%s loop=%d",
        text:sub(1, 80), voice, language, loop))

    for i = 1, loop do
        if not session_ready() then break end
        local ok, err = pcall(function()
            -- Try mod_flite TTS first (most common in FreeSWITCH)
            session:execute("speak", "flite|" .. voice .. "|" .. text)
        end)
        if not ok then
            log_warning(uuid, "speak (flite) failed: " .. tostring(err) .. " - trying fallback")
            -- Fallback: use say application
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

    -- Recording is NOT yet implemented (standalone recording is Phase 6). Do NOT
    -- silently ignore an advertised attribute — warn loudly so operators know the
    -- requested recording did not happen.
    if dial_record and dial_record ~= "" and dial_record ~= "false" and dial_record ~= "do-not-record" then
        log_warning(uuid, string.format(
            "Dial record=\"%s\" requested but call recording is NOT yet supported (pending Phase 6) — proceeding WITHOUT recording",
            tostring(dial_record)))
    end

    -- Resolve action URL
    if dial_action then
        dial_action = resolve_url(dial_action, current_base_url)
    end

    -- Check for <Number> children
    if verb.children and #verb.children > 0 then
        for _, child in ipairs(verb.children) do
            if child.verb == "Number" and child.text and child.text ~= "" then
                table.insert(dial_targets, child.text)
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
    end

    local combined_dial = table.concat(dial_strings, "|")

    log_info(uuid, string.format("Dial: bridge string=%s", combined_dial))

    pcall(function()
        session:execute("bridge", combined_dial)
    end)

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

        local params = build_webhook_params({
            DialCallStatus = dial_call_status,
            DialCallDuration = tostring(math.floor(tonumber(dial_duration) / 1000))
        })

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
                -- Standalone recording is Phase 6. Do not silently no-op an
                -- advertised verb — warn loudly and continue.
                log_warning(uuid, "<Record> verb is NOT yet supported (pending Phase 6) — skipping, no recording made")
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
