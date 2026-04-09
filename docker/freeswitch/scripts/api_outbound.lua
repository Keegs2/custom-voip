-- API Outbound Handler - API Calling Product Outbound Calls
-- Handles outbound calls originated via ESL/API with full tier enforcement
--
-- Call Flow:
-- 1. Validate customer_id and call parameters
-- 2. Check CPS against API tier limits (25/50/100+ CPS)
-- 3. Validate destination (fraud checks)
-- 4. Record per-call fee for billing
-- 5. Bridge to carrier with proper caller ID handling
-- 6. Support webhook callbacks for call control
--
-- Key Differences from trunk_outbound.lua:
-- - Uses "api" type for CPS checking (higher limits)
-- - Per-call fee tracking for billing
-- - Webhook URL handling for call control callbacks
-- - Higher default CPS limits (25-100+)
--
-- Error Handling:
-- - Graceful handling of Redis/DB failures (fail open)
-- - Proper SIP response codes for each error type
-- - Detailed logging for troubleshooting
-- - Upgrade messages for customers hitting limits

-- Load libraries
-- Set up package paths for Lua 5.3 and our custom modules
-- Prepend luarocks paths so redis-lua is found before mod_lua's script-directory searcher
package.path = "/usr/local/share/lua/5.3/?.lua;/usr/local/share/lua/5.3/?/init.lua;/usr/share/lua/5.3/?.lua;/usr/share/lua/5.3/?/init.lua;/usr/local/freeswitch/scripts/lib/?.lua;" .. (package.path or "")
package.cpath = "/usr/local/lib/lua/5.3/?.so;/usr/local/lib/lua/5.3/?/?.so;/usr/lib/lua/5.3/?.so;/usr/lib/lua/5.3/?/?.so;" .. (package.cpath or "")

-- Load modules using loadfile to bypass FreeSWITCH's broken module-directory handling
-- The require() function fails because mod_lua adds script-directory as a searcher
local function load_module(name)
    local path = "/usr/local/freeswitch/scripts/lib/" .. name .. ".lua"
    local func, err = loadfile(path)
    if not func then
        freeswitch.consoleLog("ERR", "[api_outbound] Failed to load " .. name .. ": " .. tostring(err) .. "\n")
        return nil
    end
    local ok, result = pcall(func)
    if not ok then
        freeswitch.consoleLog("ERR", "[api_outbound] Failed to execute " .. name .. ": " .. tostring(result) .. "\n")
        return nil
    end
    return result
end

local redis = load_module("redis_client")
local redis_cps = load_module("redis_cps")
local db = load_module("db_client")

-- Ensure session exists
if not session then
    freeswitch.consoleLog("ERR", "[api_outbound] No session object - cannot process API outbound call\n")
    return
end

-- Safe variable access
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

local function hangup(cause, log_msg)
    if log_msg then
        freeswitch.consoleLog("INFO", log_msg .. "\n")
    end
    set_var("hangup_cause", cause)
    pcall(function()
        session:hangup(cause)
    end)
end

-- Get call details from channel variables (set by ESL originate)
local uuid = get_var("uuid", "unknown")
local destination = get_var("destination_number", "")
local caller_id = get_var("caller_id_number", "")
local caller_id_name = get_var("caller_id_name", "")
local customer_id = tonumber(get_var("customer_id", "0"))
local webhook_url = get_var("webhook_url", nil)
local callback_url = get_var("callback_url", nil)
local call_reference = get_var("call_reference", uuid)

freeswitch.consoleLog("INFO", string.format(
    "[%s] API Outbound: customer=%d to=%s caller_id=%s webhook=%s\n",
    uuid, customer_id or 0, destination, caller_id, tostring(webhook_url)
))

-- ============================================
-- STEP 1: Validate Customer ID
-- ============================================
if not customer_id or customer_id <= 0 then
    freeswitch.consoleLog("ERR", string.format(
        "[%s] API Outbound: Missing or invalid customer_id\n", uuid
    ))
    set_var("blocked_reason", "INVALID_CUSTOMER")
    hangup("CALL_REJECTED", "[" .. uuid .. "] Invalid customer ID")
    return
end

-- ============================================
-- STEP 2: Validate Destination
-- ============================================
if destination == "" then
    hangup("INVALID_NUMBER_FORMAT", "[" .. uuid .. "] Empty destination")
    return
end

-- Normalize destination to E.164
local function normalize_destination(number)
    local clean = number:gsub("[^%d+*#]", "")
    if clean:match("^%+") then
        return clean
    end
    -- Get digit count (Lua patterns don't support {n} quantifiers)
    local digit_count = #clean
    if digit_count == 10 and clean:match("^%d+$") then
        return "+1" .. clean
    end
    if digit_count == 11 and clean:match("^1%d+$") then
        return "+" .. clean
    end
    if clean:match("^011") then
        -- International format, convert to +
        return "+" .. clean:gsub("^011", "")
    end
    return "+" .. clean
end

local normalized_dest = normalize_destination(destination)
freeswitch.consoleLog("DEBUG", "[" .. uuid .. "] Normalized destination: " .. normalized_dest .. "\n")

-- Set standard variables
set_var("product_type", "api")
set_var("direction", "outbound")
set_var("normalized_destination", normalized_dest)

-- ============================================
-- STEP 3: Fraud Prevention - Check high-risk prefix
-- ============================================
if redis then
    local is_risky, risk_level, risk_prefix = redis.check_prefix(normalized_dest)
    if is_risky then
        freeswitch.consoleLog("WARNING", string.format(
            "[%s] High-risk destination detected: %s (prefix: %s, level: %s)\n",
            uuid, normalized_dest, risk_prefix, risk_level
        ))

        if risk_level == "blocked" then
            set_var("blocked_reason", "HIGH_RISK_DESTINATION")
            hangup("CALL_REJECTED", "[" .. uuid .. "] Blocked high-risk destination")
            return
        end

        -- Log for analysis but allow (configurable)
        set_var("fraud_score", risk_level == "critical" and "80" or "50")
        set_var("fraud_prefix", risk_prefix)
    end
end

-- ============================================
-- STEP 4: Check CPS (Calls Per Second) with API Tier Limits
-- ============================================
-- API calling has higher CPS limits: 25/50/100+ vs trunk 5/10
local api_tier = nil
local per_call_fee = 0

if redis_cps then
    local cps_result = redis_cps.check_cps_with_tier(customer_id, "api")

    if not cps_result.allowed then
        freeswitch.consoleLog("WARNING", string.format(
            "[%s] API CPS limit exceeded: customer=%d tier=%s current=%d limit=%d\n",
            uuid, customer_id, cps_result.tier_name or "unknown",
            cps_result.current_cps or 0, cps_result.limit or 0
        ))

        -- Set channel variables for logging/billing
        set_var("blocked_reason", "CPS_EXCEEDED")
        set_var("api_tier", cps_result.tier or "unknown")
        set_var("api_tier_name", cps_result.tier_name or "Unknown")
        set_var("cps_current", tostring(cps_result.current_cps or 0))
        set_var("cps_limit", tostring(cps_result.limit or 0))

        -- Set upgrade message header for customer notification
        if cps_result.upgrade_message then
            set_var("sip_h_X-CPS-Upgrade", cps_result.upgrade_message)
            freeswitch.consoleLog("INFO", string.format(
                "[%s] CPS upgrade message: %s\n", uuid, cps_result.upgrade_message
            ))
        end

        -- Return 503 Service Unavailable with upgrade info
        pcall(function()
            session:execute("respond", "503 Service Unavailable")
        end)
        return
    end

    -- CPS check passed - store tier info
    api_tier = cps_result.tier or "starter"
    freeswitch.consoleLog("DEBUG", string.format(
        "[%s] API CPS check passed: customer=%d tier=%s current=%d/%d\n",
        uuid, customer_id, cps_result.tier_name or "unknown",
        cps_result.current_cps or 0, cps_result.limit or 0
    ))

    -- Set tier info for billing/analytics
    set_var("api_tier", cps_result.tier or "starter")
    set_var("api_tier_name", cps_result.tier_name or "Starter")

else
    -- Fallback: If redis_cps unavailable, allow with default tier
    -- This is fail-open behavior - calls proceed without CPS enforcement
    freeswitch.consoleLog("WARNING", string.format(
        "[%s] redis_cps unavailable, proceeding without CPS check (fail-open)\n", uuid
    ))
    api_tier = "starter"
    set_var("api_tier", "starter")
    set_var("api_tier_name", "Starter (unverified)")
end

-- ============================================
-- STEP 5: Get Per-Call Fee from Tier
-- ============================================
-- Per-call fees by tier (defined in redis_cps.lua and database)
local TIER_FEES = {
    starter = 0.0100,       -- $0.01 per call
    professional = 0.0080,  -- $0.008 per call
    enterprise = 0.0050,    -- $0.005 per call
    unlimited = 0.0000,     -- Custom pricing
}

per_call_fee = TIER_FEES[api_tier] or 0.0100  -- Default to starter fee

-- Try to get actual fee from database if available
if db then
    local tier_info = db.get_customer_tier(customer_id, "api")
    if tier_info and tier_info.per_call_fee then
        per_call_fee = tonumber(tier_info.per_call_fee) or per_call_fee
    end
end

set_var("per_call_fee", string.format("%.4f", per_call_fee))
freeswitch.consoleLog("DEBUG", string.format(
    "[%s] Per-call fee: $%.4f (tier: %s)\n", uuid, per_call_fee, api_tier
))

-- ============================================
-- STEP 6: Velocity Check (CPM/Daily limits)
-- ============================================
if redis then
    -- API calling may have different velocity limits
    local cpm_limit = tonumber(get_var("cpm_limit", "300"))    -- Higher default for API
    local daily_limit = tonumber(get_var("daily_limit", "5000")) -- Higher daily limit

    local velocity_ok, velocity_reason = redis.velocity_check(
        customer_id, cpm_limit, 0, daily_limit, per_call_fee
    )

    if not velocity_ok then
        freeswitch.consoleLog("WARNING", string.format(
            "[%s] API Velocity check FAILED: customer=%d reason=%s\n",
            uuid, customer_id, velocity_reason
        ))
        set_var("blocked_reason", velocity_reason)
        hangup("CALL_REJECTED", "[" .. uuid .. "] Velocity limit exceeded: " .. velocity_reason)
        return
    end
end

-- ============================================
-- STEP 7: Select Carrier Gateway
-- ============================================
-- API calls ALWAYS use carrier_premium (high-CPS trunk, negotiated rates)
-- traffic_grade is retained as a secondary factor for priority within the trunk
local traffic_grade = get_var("traffic_grade", "premium")
local gateway = "carrier_premium"

freeswitch.consoleLog("INFO", string.format(
    "[api_outbound] Routing via %s (product: api, traffic_grade: %s)\n",
    gateway, traffic_grade
))

-- Test mode check
local test_mode = os.getenv("TEST_MODE")
if test_mode == "true" then
    freeswitch.consoleLog("INFO", string.format(
        "[%s] TEST MODE: Would route API call to %s via %s\n",
        uuid, normalized_dest, gateway
    ))
    pcall(function()
        session:answer()
        session:execute("playback", "tone_stream://%(1000,0,600)")
        session:sleep(2000)
        session:hangup("NORMAL_CLEARING")
    end)
    return
end

-- ============================================
-- STEP 8: Build and Execute Bridge
-- ============================================
set_var("carrier_used", gateway)
set_var("destination_number", normalized_dest)
set_var("call_reference", call_reference)

-- Caller ID handling
local outbound_caller_id = caller_id
if not outbound_caller_id or outbound_caller_id == "" then
    -- Use customer's default outbound caller ID or anonymous
    outbound_caller_id = get_var("default_caller_id", "anonymous")
end

local outbound_caller_name = caller_id_name
if not outbound_caller_name or outbound_caller_name == "" then
    outbound_caller_name = outbound_caller_id
end

-- Build dial string with proper parameters
-- Use sofia/external/dest@proxy to ensure the outbound INVITE uses ext-sip-ip
-- (public IP 34.74.71.32) in Via, Contact, and SDP headers.
-- The internal profile does NOT apply ext-sip-ip to outbound calls.
-- X-Carrier tells Kamailio which Bandwidth IP to route to.
local dial_string = string.format(
    "{origination_caller_id_number=%s,origination_caller_id_name=%s,call_timeout=60,ignore_early_media=false,sip_h_X-Carrier=premium}sofia/external/%s@127.0.0.1:5060",
    outbound_caller_id,
    outbound_caller_name,
    normalized_dest:gsub("^%+", "")  -- Remove + for carrier (carrier-dependent)
)

freeswitch.consoleLog("INFO", string.format(
    "[%s] API Bridge: customer=%d to=%s via %s (caller_id=%s, tier=%s, fee=$%.4f)\n",
    uuid, customer_id, normalized_dest, gateway, outbound_caller_id, api_tier, per_call_fee
))

-- Set bridge failure handling
set_var("continue_on_fail", "true")
set_var("hangup_after_bridge", "true")

-- Store webhook URLs for potential callbacks
if webhook_url then
    set_var("api_webhook_url", webhook_url)
end
if callback_url then
    set_var("api_callback_url", callback_url)
end

-- Check if this is a webhook-controlled call
-- If webhook_url is set, hand off to voice_webhook.lua after bridge connects
if webhook_url then
    -- Set up variables for the webhook engine
    set_var("voice_url", webhook_url)
    set_var("direction", "outbound")

    if callback_url then
        set_var("status_callback", callback_url)
    else
        -- Derive status_callback from webhook_url base
        local status_base = webhook_url:match("^(https?://[^/]+)")
        if status_base then
            set_var("status_callback", status_base .. "/status")
        end
    end

    freeswitch.consoleLog("INFO", string.format(
        "[%s] Webhook-controlled call: handing off to voice_webhook engine, url=%s\n",
        uuid, webhook_url
    ))

    -- Execute the webhook engine script
    -- voice_webhook.lua handles the full TwiML-compatible XML fetch/parse/execute loop
    pcall(function()
        session:execute("lua", "voice_webhook.lua")
    end)
else
    -- No webhook - simple bridge to destination
    -- Execute bridge
    pcall(function()
        session:execute("bridge", dial_string)
    end)

    -- Check if bridge succeeded
    local bridge_result = get_var("bridge_result", "")
    local hangup_cause_var = get_var("originate_disposition", get_var("hangup_cause", ""))

    if bridge_result ~= "SUCCESS" then
        freeswitch.consoleLog("WARNING", string.format(
            "[%s] API Bridge failed: result=%s cause=%s\n",
            uuid, bridge_result, hangup_cause_var
        ))

        -- Try failover carrier
        if gateway ~= "carrier_backup" then
            freeswitch.consoleLog("INFO", "[" .. uuid .. "] Trying failover carrier\n")

            dial_string = string.format(
                "{origination_caller_id_number=%s,origination_caller_id_name=%s,call_timeout=60,sip_h_X-Carrier=backup}sofia/external/%s@127.0.0.1:5060",
                outbound_caller_id,
                outbound_caller_name,
                normalized_dest:gsub("^%+", "")
            )

            set_var("carrier_used", "carrier_backup")

            pcall(function()
                session:execute("bridge", dial_string)
            end)
        end
    end
end

freeswitch.consoleLog("INFO", string.format(
    "[%s] API outbound complete: customer=%d tier=%s fee=$%.4f\n",
    uuid, customer_id, api_tier, per_call_fee
))
