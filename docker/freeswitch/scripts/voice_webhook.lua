-- Voice Webhook Engine - TwiML-compatible XML execution for FreeSWITCH
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

package.path = package.path .. ";/usr/local/freeswitch/scripts/lib/?.lua;/usr/local/share/lua/5.3/?.lua;/usr/share/lua/5.3/?.lua"
package.cpath = package.cpath .. ";/usr/local/lib/lua/5.3/?.so;/usr/local/lib/lua/5.3/?/?.so;/usr/lib/lua/5.3/?.so;/usr/lib/lua/5.3/?/?.so"

local LOG_PREFIX = "[voice_webhook]"
local HTTP_TIMEOUT = 5       -- seconds
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
local fallback_url = get_var("fallback_url", nil)
local status_callback = get_var("status_callback", nil)
local direction = get_var("direction", "inbound")
local call_start_time = os.time()

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
-- Simple XML parser for TwiML-style flat/shallow XML.
-- Handles <Response> root with verb elements, attributes, text content,
-- and one level of nesting (e.g., Gather containing Say/Play).

local function parse_attributes(attr_string)
    local attrs = {}
    if not attr_string or attr_string == "" then
        return attrs
    end
    -- Match attribute="value" or attribute='value'
    for key, value in attr_string:gmatch('(%w+)%s*=%s*"([^"]*)"') do
        attrs[key] = value
    end
    for key, value in attr_string:gmatch("(%w+)%s*=%s*'([^']*)'") do
        attrs[key] = value
    end
    return attrs
end

local function parse_xml(xml_string)
    if not xml_string or xml_string == "" then
        return nil, "Empty XML string"
    end

    -- Remove XML declaration if present
    xml_string = xml_string:gsub("<%?xml[^?]*%?>", "")

    -- Remove comments
    xml_string = xml_string:gsub("<!%-%-.-%--%>", "")

    -- Trim whitespace
    xml_string = xml_string:match("^%s*(.-)%s*$")

    -- Check for <Response> root element
    local response_content = xml_string:match("<Response%s*>(.-)</Response>")
    if not response_content then
        -- Try self-closing or case variations
        response_content = xml_string:match("<Response%s*/>")
        if response_content then
            return {}  -- Empty response
        end
        return nil, "No <Response> root element found"
    end

    local verbs = {}

    -- Pattern to match top-level elements inside <Response>
    -- We need to handle both self-closing tags and tags with content (including nested tags)
    local pos = 1
    while pos <= #response_content do
        -- Skip whitespace and text outside tags
        local tag_start = response_content:find("<", pos)
        if not tag_start then break end

        -- Extract the tag name and attributes
        -- Match opening tag: <TagName attr1="val1" attr2="val2">
        local tag_end_pos = response_content:find(">", tag_start)
        if not tag_end_pos then break end

        local tag_content = response_content:sub(tag_start + 1, tag_end_pos - 1)

        -- Check for self-closing tag: <TagName attrs/>
        local is_self_closing = tag_content:match("/$")
        if is_self_closing then
            tag_content = tag_content:sub(1, -2)  -- Remove trailing /
        end

        -- Extract tag name and attribute string
        local tag_name, attr_str = tag_content:match("^(%w+)%s*(.*)")
        if not tag_name then
            pos = tag_end_pos + 1
            goto continue
        end

        -- Skip closing tags
        if response_content:sub(tag_start + 1, tag_start + 1) == "/" then
            pos = tag_end_pos + 1
            goto continue
        end

        local verb = {
            verb = tag_name,
            attrs = parse_attributes(attr_str),
            text = "",
            children = {}
        }

        if is_self_closing then
            table.insert(verbs, verb)
            pos = tag_end_pos + 1
        else
            -- Find the matching closing tag
            -- For verbs that can have children (Gather, Dial), we need to parse nested elements
            local close_pattern = "</" .. tag_name .. ">"
            local close_start, close_end = response_content:find(close_pattern, tag_end_pos + 1)

            if not close_start then
                -- Malformed XML - treat as self-closing
                log_warning(uuid, "Missing closing tag for <" .. tag_name .. ">, treating as self-closing")
                table.insert(verbs, verb)
                pos = tag_end_pos + 1
            else
                local inner = response_content:sub(tag_end_pos + 1, close_start - 1)

                -- Check if inner content has child elements
                if inner:match("<(%w+)") then
                    -- Parse children (one level deep)
                    local child_pos = 1
                    while child_pos <= #inner do
                        -- Capture text before next child tag
                        local child_tag_start = inner:find("<", child_pos)
                        if not child_tag_start then
                            -- Remaining text
                            local remaining = inner:sub(child_pos):match("^%s*(.-)%s*$")
                            if remaining ~= "" then
                                verb.text = (verb.text ~= "" and verb.text .. " " or "") .. remaining
                            end
                            break
                        end

                        -- Text before this child
                        local text_before = inner:sub(child_pos, child_tag_start - 1):match("^%s*(.-)%s*$")
                        if text_before and text_before ~= "" then
                            verb.text = (verb.text ~= "" and verb.text .. " " or "") .. text_before
                        end

                        local child_tag_end = inner:find(">", child_tag_start)
                        if not child_tag_end then break end

                        local child_tag_raw = inner:sub(child_tag_start + 1, child_tag_end - 1)

                        -- Skip closing tags
                        if child_tag_raw:sub(1, 1) == "/" then
                            child_pos = child_tag_end + 1
                            goto continue_child
                        end

                        local child_self_closing = child_tag_raw:match("/$")
                        if child_self_closing then
                            child_tag_raw = child_tag_raw:sub(1, -2)
                        end

                        local child_name, child_attr_str = child_tag_raw:match("^(%w+)%s*(.*)")
                        if not child_name then
                            child_pos = child_tag_end + 1
                            goto continue_child
                        end

                        local child = {
                            verb = child_name,
                            attrs = parse_attributes(child_attr_str),
                            text = ""
                        }

                        if child_self_closing then
                            table.insert(verb.children, child)
                            child_pos = child_tag_end + 1
                        else
                            local child_close = "</" .. child_name .. ">"
                            local cc_start, cc_end = inner:find(child_close, child_tag_end + 1)
                            if cc_start then
                                child.text = inner:sub(child_tag_end + 1, cc_start - 1):match("^%s*(.-)%s*$")
                                table.insert(verb.children, child)
                                child_pos = cc_end + 1
                            else
                                table.insert(verb.children, child)
                                child_pos = child_tag_end + 1
                            end
                        end

                        ::continue_child::
                    end
                else
                    -- Plain text content
                    verb.text = inner:match("^%s*(.-)%s*$")
                end

                table.insert(verbs, verb)
                pos = close_end + 1
            end
        end

        ::continue::
    end

    return verbs, nil
end

-- ============================================
-- HTTP request via FreeSWITCH API curl
-- ============================================

local api = freeswitch.API()

-- Fetch instructions from a webhook URL via HTTP POST
-- Returns: xml_string, error_string
local function http_post(url, params)
    if not url or url == "" then
        return nil, "Empty URL"
    end

    local body = build_form_body(params)

    log_debug(uuid, string.format("HTTP POST %s body=%s", url, body))

    -- Use FreeSWITCH curl API: curl url [options]
    -- Format: curl <url> content-type application/x-www-form-urlencoded post <data>
    local curl_cmd = string.format(
        "curl %s content-type application/x-www-form-urlencoded timeout %d post '%s'",
        url, HTTP_TIMEOUT, body
    )

    local ok, response = pcall(function()
        return api:executeString(curl_cmd)
    end)

    if not ok or not response then
        return nil, "curl execution failed: " .. tostring(response)
    end

    -- FreeSWITCH curl API returns the response body directly
    -- On error it may return an empty string or error message
    if response == "" then
        return nil, "Empty response from webhook"
    end

    log_debug(uuid, string.format("HTTP response length=%d", #response))

    return response, nil
end

-- ============================================
-- Fetch and parse instructions from a webhook URL
-- Includes retry logic: retry once on failure
-- ============================================

local function fetch_instructions(url, params)
    -- First attempt
    local response, err = http_post(url, params)
    if not response then
        log_warning(uuid, "Webhook fetch failed (attempt 1): " .. tostring(err) .. " - retrying")
        -- Retry once
        response, err = http_post(url, params)
        if not response then
            log_err(uuid, "Webhook fetch failed (attempt 2): " .. tostring(err))
            return nil, err
        end
    end

    -- Parse the XML
    local verbs, parse_err = parse_xml(response)
    if not verbs then
        log_err(uuid, "XML parse failed: " .. tostring(parse_err) .. " | raw=" .. response:sub(1, 500))
        return nil, "XML parse error: " .. tostring(parse_err)
    end

    log_info(uuid, string.format("Parsed %d verb(s) from %s", #verbs, url))
    return verbs, nil
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
    local method = verb.attrs.method or "POST"

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
        local new_verbs, err = fetch_instructions(action_url, params)

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
    local dial_record = verb.attrs.record or nil

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

    -- Build dial strings for all targets
    -- Multiple targets are separated by | for sequential or , for simultaneous
    local dial_strings = {}
    -- Webhook-driven calls are always API product -> use carrier_premium (high-CPS trunk)
    -- traffic_grade is retained as a secondary factor for priority within the trunk
    local gateway = "carrier_premium"
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
                "{call_timeout=%d,ignore_early_media=false,sip_h_X-Carrier=premium}sofia/external/%s@127.0.0.1:5060",
                dial_timeout, dial_number
            ))
        end
    end

    local combined_dial = table.concat(dial_strings, "|")

    log_info(uuid, string.format("Dial: bridge string=%s", combined_dial))

    pcall(function()
        session:execute("bridge", combined_dial)
    end)

    -- Check dial result
    local dial_status = get_var("originate_disposition", "")
    local bridge_result = get_var("bridge_result", "")

    log_info(uuid, string.format("Dial result: disposition=%s bridge=%s", dial_status, bridge_result))

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

        local new_verbs, err = fetch_instructions(dial_action, params)
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
    local method = verb.attrs.method or "POST"

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
    local new_verbs, err = fetch_instructions(redirect_url, params)

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

    -- Fire and forget - don't block on status callback
    local ok, err = pcall(function()
        http_post(status_callback, params)
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

    -- Fetch initial instructions from the voice URL
    local params = build_webhook_params({ CallStatus = "ringing" })
    local verbs, err = fetch_instructions(voice_url, params)

    if not verbs then
        log_err(uuid, "Failed to fetch initial instructions: " .. tostring(err))

        -- Try fallback URL if available
        if fallback_url and fallback_url ~= "" then
            log_info(uuid, "Trying fallback URL: " .. fallback_url)
            current_base_url = fallback_url
            verbs, err = fetch_instructions(fallback_url, params)
        end

        if not verbs then
            log_err(uuid, "All webhook URLs failed, hanging up")
            play_error_tone()
            pcall(function() session:hangup("NORMAL_TEMPORARY_FAILURE") end)
            send_status_callback()
            return
        end
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
