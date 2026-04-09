-- Inbound Call Router - High Performance Implementation
-- Handles RCF, API DID, and Trunk DID routing with caching
--
-- Call Flow:
-- 1. Get call details from session
-- 2. Normalize DID to E.164
-- 3. Check caller ID against fraud prefixes
-- 4. Lookup DID: RCF (cache then DB) -> API DID -> Trunk DID
-- 5. Apply velocity/rate limits
-- 6. Route based on product type
--
-- Error Handling:
-- - All lookups wrapped in pcall
-- - Graceful fallbacks for service failures
-- - Detailed logging for troubleshooting

-- Load libraries
-- Set up package paths for Lua 5.3 and our custom modules
package.path = package.path .. ";/usr/local/freeswitch/scripts/lib/?.lua;/usr/local/share/lua/5.3/?.lua;/usr/share/lua/5.3/?.lua"
package.cpath = package.cpath .. ";/usr/local/lib/lua/5.3/?.so;/usr/local/lib/lua/5.3/?/?.so;/usr/lib/lua/5.3/?.so;/usr/lib/lua/5.3/?/?.so"

-- Load modules using loadfile to bypass FreeSWITCH's broken module-directory handling
-- The require() function fails because mod_lua adds script-directory as a searcher
local function load_module(name)
    local path = "/usr/local/freeswitch/scripts/lib/" .. name .. ".lua"
    local func, err = loadfile(path)
    if not func then
        freeswitch.consoleLog("ERR", "Failed to load " .. name .. ": " .. tostring(err) .. "\n")
        return nil
    end
    local ok, result = pcall(func)
    if not ok then
        freeswitch.consoleLog("ERR", "Failed to execute " .. name .. ": " .. tostring(result) .. "\n")
        return nil
    end
    return result
end

local redis = load_module("redis_client")
local db = load_module("db_client")

-- Ensure session exists
if not session then
    freeswitch.consoleLog("ERR", "No session object - cannot route\n")
    return
end

-- Get call variables with safe defaults
local function get_var(name, default)
    local ok, val = pcall(function()
        return session:getVariable(name)
    end)
    if ok and val and val ~= "" then
        return val
    end
    return default
end

-- Set call variable safely
local function set_var(name, value)
    if value ~= nil then
        pcall(function()
            session:setVariable(name, tostring(value))
        end)
    end
end

-- Safely hangup with cause
local function hangup(cause, log_msg)
    if log_msg then
        freeswitch.consoleLog("INFO", log_msg .. "\n")
    end
    set_var("hangup_cause", cause)
    pcall(function()
        session:hangup(cause)
    end)
end

-- Get call details
local uuid = get_var("uuid", "unknown")
local did = get_var("destination_number", "")
local caller_id = get_var("caller_id_number", "")
local caller_id_name = get_var("caller_id_name", "")
local sip_from_user = get_var("sip_from_user", "")
local sip_from_display = get_var("sip_from_display", "")
local source_ip = get_var("sip_received_ip", get_var("network_addr", ""))

-- Save original caller ID IMMEDIATELY -- FreeSWITCH may overwrite these during processing.
-- FusionPBX pattern: capture caller_id early, before any DID normalization or transfers.
-- sip_from_user is the most reliable source of the original caller's number because
-- it comes directly from the From header of the inbound INVITE and is not modified
-- by dialplan processing. Fall back to caller_id_number if sip_from_user is empty
-- or matches the DID (which means the carrier put the DID in From, not the caller).
local original_caller_number = caller_id
if sip_from_user ~= "" and sip_from_user ~= did then
    original_caller_number = sip_from_user
end
local original_caller_name = caller_id_name
if (original_caller_name == "" or original_caller_name == nil) and sip_from_display ~= "" then
    original_caller_name = sip_from_display
end
if original_caller_name == "" or original_caller_name == nil then
    original_caller_name = original_caller_number
end

freeswitch.consoleLog("INFO", string.format(
    "[%s] Inbound: DID=%s CallerID=%s SIP-From-User=%s SIP-From-Display=%s SourceIP=%s\n",
    uuid, did, caller_id, sip_from_user, sip_from_display, source_ip
))
freeswitch.consoleLog("INFO", string.format(
    "[%s] Original caller preserved: number=%s name=%s\n",
    uuid, original_caller_number, original_caller_name
))

-- Validate DID
if did == "" then
    hangup("UNALLOCATED_NUMBER", "[" .. uuid .. "] Empty destination - rejecting")
    return
end

-- Convert E.164 or 11-digit number to 10-digit format for carrier delivery
local function to_10digit(number)
    if not number or number == "" then return number end
    local digits = number:gsub("[^%d]", "")
    if #digits == 11 and digits:sub(1, 1) == "1" then
        return digits:sub(2)
    elseif #digits == 10 then
        return digits
    end
    return digits
end

-- Normalize DID to E.164 format
local function normalize_did(number)
    -- Remove any non-digit characters except +
    local clean = number:gsub("[^%d+]", "")

    -- If starts with +, keep as-is
    if clean:match("^%+") then
        return clean
    end

    -- Get digit count (Lua patterns don't support {n} quantifiers)
    local digit_count = #clean

    -- If 10 digits (US), prepend +1
    if digit_count == 10 and clean:match("^%d+$") then
        return "+1" .. clean
    end

    -- If 11 digits starting with 1 (US), prepend +
    if digit_count == 11 and clean:match("^1%d+$") then
        return "+" .. clean
    end

    -- Otherwise, assume needs + prefix
    return "+" .. clean
end

local normalized_did = normalize_did(did)
freeswitch.consoleLog("DEBUG", "[" .. uuid .. "] Normalized DID: " .. normalized_did .. "\n")

-- ============================================
-- STEP 1: Fraud Prevention - Check caller ID prefix
-- ============================================
local is_risky, risk_level, risk_prefix = false, "", ""

if redis then
    is_risky, risk_level, risk_prefix = redis.check_prefix(caller_id)
    if is_risky and risk_level == "blocked" then
        freeswitch.consoleLog("WARNING", string.format(
            "[%s] BLOCKED caller from high-risk prefix: %s (matched: %s)\n",
            uuid, caller_id, risk_prefix
        ))
        set_var("fraud_score", "100")
        set_var("blocked_reason", "high_risk_caller_prefix")
        hangup("CALL_REJECTED")
        return
    elseif is_risky then
        freeswitch.consoleLog("INFO", string.format(
            "[%s] High-risk caller prefix detected: %s (level: %s)\n",
            uuid, risk_prefix, risk_level
        ))
        set_var("fraud_score", risk_level == "critical" and "80" or "50")
    end
end

-- ============================================
-- STEP 2: DID Lookup - RCF, API, or Trunk
-- ============================================
local product_type = nil
local customer_id = nil
local forward_to = nil
local traffic_grade = "standard"
local cpm_limit = 60
local daily_limit = 500
local ring_timeout = 30
local voice_url = nil
local fallback_url = nil
local trunk_id = nil
local pass_caller_id = true

-- Try RCF lookup (cache first, then DB)
local function lookup_rcf()
    -- Try cache
    if redis then
        local rcf_cache = redis.get_rcf_cache(normalized_did)
        if rcf_cache then
            freeswitch.consoleLog("DEBUG", "[" .. uuid .. "] RCF cache hit\n")
            return {
                product_type = "rcf",
                customer_id = tonumber(rcf_cache.customer_id),
                forward_to = rcf_cache.forward_to,
                traffic_grade = rcf_cache.traffic_grade or "standard",
                pass_caller_id = rcf_cache.pass_caller_id == "1",
                ring_timeout = tonumber(rcf_cache.ring_timeout) or 30,
                cache_hit = true
            }
        end
    end

    -- Try database
    if db then
        local rcf_db = db.lookup_rcf(normalized_did)
        if rcf_db then
            freeswitch.consoleLog("DEBUG", "[" .. uuid .. "] RCF DB hit\n")

            -- Cache for future calls
            if redis then
                redis.set_rcf_cache(
                    normalized_did,
                    rcf_db.forward_to,
                    rcf_db.customer_id,
                    rcf_db.pass_caller_id == "t" or rcf_db.pass_caller_id == true,
                    rcf_db.traffic_grade,
                    rcf_db.ring_timeout,
                    300  -- 5 minute TTL
                )
            end

            return {
                product_type = "rcf",
                customer_id = tonumber(rcf_db.customer_id),
                forward_to = rcf_db.forward_to,
                traffic_grade = rcf_db.traffic_grade or "standard",
                cpm_limit = tonumber(rcf_db.cpm_limit) or 60,
                daily_limit = tonumber(rcf_db.daily_limit) or 500,
                pass_caller_id = rcf_db.pass_caller_id == "t" or rcf_db.pass_caller_id == true,
                ring_timeout = tonumber(rcf_db.ring_timeout) or 30,
                cache_hit = false
            }
        end
    end

    return nil
end

-- Try API DID lookup
local function lookup_api_did()
    if not db then return nil end

    local api_did = db.lookup_api_did(normalized_did)
    if api_did then
        freeswitch.consoleLog("DEBUG", "[" .. uuid .. "] API DID hit\n")
        return {
            product_type = "api",
            customer_id = tonumber(api_did.customer_id),
            traffic_grade = api_did.traffic_grade or "standard",
            cpm_limit = tonumber(api_did.cpm_limit) or 60,
            daily_limit = tonumber(api_did.daily_limit) or 500,
            voice_url = api_did.voice_url,
            fallback_url = api_did.fallback_url
        }
    end

    return nil
end

-- Try Trunk DID lookup
local function lookup_trunk_did()
    if not db then return nil end

    local trunk_did = db.lookup_trunk_did(normalized_did)
    if trunk_did then
        freeswitch.consoleLog("DEBUG", "[" .. uuid .. "] Trunk DID hit\n")
        return {
            product_type = "trunk",
            customer_id = tonumber(trunk_did.customer_id),
            trunk_id = trunk_did.trunk_id,
            traffic_grade = trunk_did.traffic_grade or "standard"
        }
    end

    return nil
end

-- Execute lookups in order: RCF -> API -> Trunk
local routing = lookup_rcf()
if not routing then
    routing = lookup_api_did()
end
if not routing then
    routing = lookup_trunk_did()
end

-- No match found
if not routing then
    freeswitch.consoleLog("WARNING", string.format(
        "[%s] No routing found for DID: %s\n",
        uuid, normalized_did
    ))
    hangup("UNALLOCATED_NUMBER")
    return
end

-- Extract routing data
product_type = routing.product_type
customer_id = routing.customer_id
forward_to = routing.forward_to
traffic_grade = routing.traffic_grade or "standard"
cpm_limit = routing.cpm_limit or 60
daily_limit = routing.daily_limit or 500
pass_caller_id = routing.pass_caller_id
ring_timeout = routing.ring_timeout or 30
voice_url = routing.voice_url
fallback_url = routing.fallback_url
trunk_id = routing.trunk_id

freeswitch.consoleLog("INFO", string.format(
    "[%s] Routing: type=%s customer=%s grade=%s\n",
    uuid, product_type, tostring(customer_id), traffic_grade
))

-- Set channel variables for CDR and downstream processing
set_var("customer_id", tostring(customer_id))
set_var("product_type", product_type)
set_var("traffic_grade", traffic_grade)
if trunk_id then
    set_var("trunk_id", tostring(trunk_id))
end

-- ============================================
-- STEP 3: Velocity/Rate Limiting
-- ============================================
if redis and customer_id then
    local velocity_ok, velocity_reason = redis.velocity_check(
        customer_id, cpm_limit, 0, daily_limit, 0.01
    )

    if not velocity_ok then
        freeswitch.consoleLog("WARNING", string.format(
            "[%s] Velocity check FAILED: customer=%d reason=%s\n",
            uuid, customer_id, velocity_reason
        ))
        set_var("blocked_reason", velocity_reason)
        hangup("CALL_REJECTED")
        return
    end
end

-- ============================================
-- STEP 4: Route Based on Product Type
-- ============================================

-- Helper: Check if forward_to is a local extension
-- Local extensions are 4 digits starting with 10xx (e.g., 1001, 1002, 1003)
local function is_local_extension(number)
    if not number then return false end
    return number:match("^10%d%d$") ~= nil
end

-- Helper: Get domain for local routing
local function get_domain()
    local domain = get_var("domain", nil)
    if not domain then
        domain = os.getenv("DOMAIN") or "voiceplatform.local"
    end
    return domain
end

if product_type == "rcf" then
    -- Remote Call Forwarding - Bridge to destination
    -- RCF product always routes via carrier_standard (low-CPS trunk, standard rates)
    -- traffic_grade is used as a secondary factor for priority within the same trunk
    local carrier = "standard"
    freeswitch.consoleLog("INFO", string.format(
        "[inbound_router] Routing via carrier_%s (product: rcf, traffic_grade: %s)\n",
        carrier, traffic_grade
    ))

    local is_local_test = get_var("is_local_test", "false")
    local is_local_forward = is_local_extension(forward_to)

    -- Check for test mode
    local test_mode = os.getenv("TEST_MODE")
    if test_mode == "true" and not is_local_forward then
        freeswitch.consoleLog("INFO", "[" .. uuid .. "] TEST MODE: Would forward to " .. forward_to .. "\n")
        pcall(function()
            session:answer()
            session:execute("playback", "tone_stream://%(1000,0,600)")
            session:sleep(2000)
            session:hangup("NORMAL_CLEARING")
        end)
        return
    end

    -- Set bridge parameters
    set_var("forward_to", forward_to)
    set_var("call_timeout", tostring(ring_timeout))

    -- ================================================================
    -- Media anchoring and early media (ringback) configuration
    -- ================================================================
    -- FreeSWITCH MUST stay in the RTP media path for both legs (B2BUA mode).
    -- proxy_media=true keeps FS in the media path while allowing codec
    -- passthrough (no transcoding unless needed). This is critical because:
    --   1. FS needs to relay RTP between Bandwidth (A-leg) and Bandwidth (B-leg)
    --   2. Without media anchoring, RTP would need to flow directly between
    --      the two Bandwidth endpoints, which they won't do (no direct path)
    --   3. SDP in both directions must contain FS's public IP (ext-rtp-ip)
    --
    -- ringback: Generates local ringback tone on the A-leg while waiting for
    -- the B-leg to answer. This ensures the caller hears ringing even if
    -- Bandwidth doesn't send 183 Session Progress with SDP (early media).
    -- If the B-leg DOES send early media (183+SDP), ignore_early_media=false
    -- in the bridge string means FS will pass that through instead.
    set_var("proxy_media", "true")
    set_var("ringback", "%(2000,4000,440,480)")
    set_var("transfer_ringback", "%(2000,4000,440,480)")

    local dial_string

    -- ================================================================
    -- Caller ID handling: FusionPBX-style approach
    -- ================================================================
    -- FusionPBX uses channel variables (setVariable) instead of dial-string
    -- overrides. This is cleaner and more reliable because:
    --   1. outbound_caller_id_number -> SIP From header (carrier auth)
    --   2. effective_caller_id_number -> caller ID presentation to called party
    --   3. These are DIFFERENT from origination_caller_id_number
    --
    -- By using setVariable on the session, the variables apply to the bridge
    -- without needing to pack everything into the dial string {} block.
    --
    -- SIP headers produced (after Kamailio processing):
    --   From: <sip:RCF_DID@public_ip>           (via outbound_caller_id_number)
    --   P-Asserted-Identity: <sip:orig@ip>       (via X-Original-CID -> Kamailio)
    --   Remote-Party-ID: <sip:orig@ip>           (via sip_h_Remote-Party-ID)
    --   Diversion: <sip:RCF_DID@ip>;reason=unconditional
    -- ================================================================

    -- Set outbound caller ID for carrier authorization (SIP From header).
    -- Bandwidth requires the RCF DID in 10-digit format for termination auth.
    local outbound_did = to_10digit(normalized_did)
    session:setVariable("outbound_caller_id_number", outbound_did)
    session:setVariable("outbound_caller_id_name", outbound_did)

    local outbound_original_cid = to_10digit(original_caller_number)
    if pass_caller_id then
        -- Preserve original caller ID so the called party sees who is calling
        session:setVariable("effective_caller_id_number", outbound_original_cid)
        session:setVariable("effective_caller_id_name", original_caller_name)
    else
        -- Override: called party sees the RCF DID, not the original caller
        session:setVariable("effective_caller_id_number", outbound_did)
        session:setVariable("effective_caller_id_name", outbound_did)
    end

    -- Diversion header indicates the call was forwarded and from which number
    session:setVariable("sip_h_Diversion", "<sip:" .. outbound_did .. "@34.74.71.32>;reason=unconditional")

    -- X-Original-CID: Kamailio reads this to build P-Asserted-Identity
    session:setVariable("sip_h_X-Original-CID", outbound_original_cid)

    freeswitch.consoleLog("INFO", string.format(
        "[inbound_router] CID setup (FusionPBX-style): outbound_cid=%s effective_cid=%s original=%s pass=%s\n",
        normalized_did,
        pass_caller_id and original_caller_number or normalized_did,
        original_caller_number,
        tostring(pass_caller_id)
    ))

    if is_local_forward then
        -- LOCAL EXTENSION ROUTING
        -- Forward to a registered user (e.g., 1001, 1002, 1003)
        local domain = get_domain()
        set_var("carrier_used", "local")

        -- Build dial string for local user (CID handling is simpler for local)
        dial_string = string.format(
            "{ignore_early_media=false,call_timeout=%d}user/%s@%s",
            ring_timeout, forward_to, domain
        )

        freeswitch.consoleLog("INFO", string.format(
            "[%s] RCF Bridge (LOCAL): %s -> user/%s@%s\n",
            uuid, normalized_did, forward_to, domain
        ))
    else
        -- PSTN/CARRIER ROUTING via Kamailio proxy (no gateway syntax)
        -- Using sofia/external/dest@proxy ensures the outbound INVITE uses
        -- ext-sip-ip (public IP 34.74.71.32) in Via, Contact, and SDP.
        -- The internal profile does NOT apply ext-sip-ip to outbound calls.
        -- X-Carrier header tells Kamailio which Bandwidth IP to use.
        set_var("carrier_used", "carrier_" .. carrier)

        -- Remote-Party-ID: backup CID presentation mechanism for carriers
        -- that don't support P-Asserted-Identity
        if pass_caller_id then
            session:setVariable("sip_h_Remote-Party-ID",
                "<sip:" .. original_caller_number .. "@34.74.71.32>;party=calling;privacy=off;screen=yes")
        end

        -- Simplified bridge string -- no origination_caller_id_number override needed.
        -- FreeSWITCH uses outbound_caller_id_* for the SIP From header
        -- and effective_caller_id_* for caller ID presentation to the called party.
        -- Both were set via setVariable above (FusionPBX pattern).
        dial_string = string.format(
            "{ignore_early_media=false,call_timeout=%d,sip_h_X-Carrier=%s" ..
            "}sofia/external/%s@172.28.0.1:5060",
            ring_timeout,
            carrier,
            forward_to
        )

        freeswitch.consoleLog("INFO", string.format(
            "[%s] RCF Bridge (PSTN): %s -> %s via proxy (carrier=%s, pass_cid=%s)\n",
            uuid, normalized_did, forward_to, carrier, tostring(pass_caller_id)
        ))
    end

    -- Ensure clean call teardown when bridge ends
    set_var("hangup_after_bridge", "true")
    -- Set bridge failure handling for failover
    set_var("continue_on_fail", "true")
    -- Mark that the DID was found and Lua is handling routing
    -- This prevents the dialplan fallback 404 from masking bridge failures
    set_var("lua_routed", "true")

    pcall(function()
        session:execute("bridge", dial_string)
    end)

    -- Check if bridge succeeded
    local bridge_result = get_var("bridge_result", "")
    local last_bridge_hangup = get_var("last_bridge_hangup_cause", "")

    -- If PSTN bridge failed, try backup carrier as failover
    if not is_local_forward and bridge_result ~= "SUCCESS" then
        freeswitch.consoleLog("INFO", string.format(
            "[inbound_router] Primary bridge failed for RCF (cause=%s), trying carrier_backup (product: rcf)\n",
            last_bridge_hangup
        ))
        set_var("carrier_used", "carrier_backup")

        -- Channel variables (outbound_caller_id_*, effective_caller_id_*,
        -- sip_h_Diversion, sip_h_X-Original-CID, sip_h_Remote-Party-ID)
        -- persist on the session from the primary bridge attempt above.
        -- Only the X-Carrier header changes for the failover carrier.
        local failover_dial = string.format(
            "{ignore_early_media=false,call_timeout=%d,sip_h_X-Carrier=backup" ..
            "}sofia/external/%s@172.28.0.1:5060",
            ring_timeout,
            forward_to
        )

        pcall(function()
            session:execute("bridge", failover_dial)
        end)

        -- Re-check after failover attempt
        bridge_result = get_var("bridge_result", "")
        last_bridge_hangup = get_var("last_bridge_hangup_cause", "")
    end

    -- If all bridge attempts failed, hangup with NORMAL_TEMPORARY_FAILURE (SIP 503)
    -- instead of falling through to the dialplan's 404 which would mask the real issue.
    -- The DID WAS found -- the carrier bridge just couldn't complete.
    if bridge_result ~= "SUCCESS" then
        freeswitch.consoleLog("WARNING", string.format(
            "[%s] All bridges failed for RCF DID %s -> %s (last_cause=%s)\n",
            uuid, normalized_did, forward_to, last_bridge_hangup
        ))
        hangup("NORMAL_TEMPORARY_FAILURE",
            "[" .. uuid .. "] RCF bridge failed, returning 503 (DID was found, carrier unreachable)")
        return
    end

elseif product_type == "api" then
    -- API Calling - Execute webhook-driven voice control via voice_webhook.lua
    -- API product always routes via carrier_premium (high-CPS trunk, negotiated rates)
    -- traffic_grade is used as a secondary factor for priority within the same trunk
    freeswitch.consoleLog("INFO", string.format(
        "[inbound_router] Routing via carrier_premium (product: api, traffic_grade: %s)\n",
        traffic_grade
    ))
    set_var("carrier_gateway", "carrier_premium")

    if voice_url then
        set_var("voice_url", voice_url)
        if fallback_url then
            set_var("fallback_url", fallback_url)
        end
        set_var("direction", "inbound")

        -- Derive status_callback from voice_url base if not explicitly set
        -- Convention: status callback at /status on the same host
        local status_base = voice_url:match("^(https?://[^/]+)")
        if status_base then
            set_var("status_callback", status_base .. "/status")
        end

        freeswitch.consoleLog("INFO", string.format(
            "[%s] API DID: handing off to voice_webhook engine, voice_url=%s\n",
            uuid, voice_url
        ))

        -- Answer the call before handing off to the webhook engine
        pcall(function()
            session:answer()
        end)

        -- Execute the webhook engine script
        -- This loads and runs voice_webhook.lua which handles the full
        -- TwiML-compatible XML fetch/parse/execute loop
        pcall(function()
            session:execute("lua", "voice_webhook.lua")
        end)
    else
        freeswitch.consoleLog("ERR", "[" .. uuid .. "] API DID without voice_url\n")
        hangup("NORMAL_TEMPORARY_FAILURE")
    end

elseif product_type == "trunk" then
    -- SIP Trunk inbound - route to customer's PBX
    -- Trunk product always routes via carrier_standard (low-CPS trunk, standard rates)
    freeswitch.consoleLog("INFO", string.format(
        "[inbound_router] Routing via carrier_standard (product: trunk, trunk_id: %s)\n",
        tostring(trunk_id)
    ))
    freeswitch.consoleLog("INFO", string.format(
        "[%s] Trunk inbound: trunk_id=%s\n",
        uuid, tostring(trunk_id)
    ))

    -- For MVP, play a message since we don't have customer endpoint config
    local test_mode = os.getenv("TEST_MODE")
    if test_mode == "true" then
        pcall(function()
            session:answer()
            session:execute("playback", "ivr/ivr-welcome.wav")
            session:sleep(1000)
            session:hangup("NORMAL_CLEARING")
        end)
    else
        -- In production, would look up customer endpoint and bridge
        -- session:execute("bridge", "sofia/gateway/customer_" .. trunk_id .. "/" .. normalized_did)
        hangup("NO_ROUTE_DESTINATION", "[" .. uuid .. "] Trunk routing not configured")
    end
end

freeswitch.consoleLog("INFO", "[" .. uuid .. "] Inbound routing complete\n")
