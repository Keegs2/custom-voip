-- Trunk Outbound Handler - SIP Trunk Customer Outbound Calls
-- Handles outbound calls from customer PBXs through SIP trunks
--
-- Call Flow:
-- 1. Authenticate by source IP (already validated in dialplan via trunk_id)
-- 2. Verify channel limits
-- 3. Check CPS (calls per second)
-- 4. Validate destination (fraud checks)
-- 5. Select carrier based on traffic grade
-- 6. Bridge to carrier with proper caller ID handling
--
-- Error Handling:
-- - Graceful handling of Redis/DB failures
-- - Proper SIP response codes for each error type
-- - Detailed logging for troubleshooting

-- Load libraries
-- Set up package paths for Lua 5.3 and our custom modules
package.path = package.path .. ";/usr/local/freeswitch/scripts/lib/?.lua;/usr/local/share/lua/5.3/?.lua;/usr/share/lua/5.3/?.lua"
package.cpath = package.cpath .. ";/usr/local/lib/lua/5.3/?.so;/usr/lib/lua/5.3/?.so"

local ok, redis = pcall(require, "redis_client")
if not ok then
    freeswitch.consoleLog("ERR", "Failed to load redis_client: " .. tostring(redis) .. "\n")
    redis = nil
end

local ok_cps, redis_cps = pcall(require, "redis_cps")
if not ok_cps then
    freeswitch.consoleLog("ERR", "Failed to load redis_cps: " .. tostring(redis_cps) .. "\n")
    redis_cps = nil
end

local ok2, db = pcall(require, "db_client")
if not ok2 then
    freeswitch.consoleLog("ERR", "Failed to load db_client: " .. tostring(db) .. "\n")
    db = nil
end

-- Ensure session exists
if not session then
    freeswitch.consoleLog("ERR", "No session object - cannot process outbound trunk call\n")
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

-- Get call details
local uuid = get_var("uuid", "unknown")
local destination = get_var("destination_number", "")
local caller_id = get_var("caller_id_number", "")
local source_ip = get_var("sip_received_ip", get_var("network_addr", ""))
local trunk_id = get_var("trunk_id", nil)

freeswitch.consoleLog("INFO", string.format(
    "[%s] Trunk Outbound: from=%s to=%s trunk_id=%s ip=%s\n",
    uuid, caller_id, destination, tostring(trunk_id), source_ip
))

-- ============================================
-- STEP 1: Validate Trunk ID
-- ============================================
-- trunk_id should already be set by IP-based auth in earlier dialplan extension
-- If not set, we need to look it up

if not trunk_id or trunk_id == "" then
    -- Try to authenticate by IP
    if db then
        local trunk_data = db.lookup_trunk_by_ip(source_ip)
        if trunk_data then
            trunk_id = trunk_data.trunk_id
            set_var("trunk_id", tostring(trunk_id))
            set_var("customer_id", tostring(trunk_data.customer_id))
            set_var("max_channels", tostring(trunk_data.max_channels or 50))
            set_var("cps_limit", tostring(trunk_data.cps_limit or 10))
            set_var("traffic_grade", trunk_data.traffic_grade or "standard")
        else
            freeswitch.consoleLog("WARNING", string.format(
                "[%s] No trunk found for IP: %s\n", uuid, source_ip
            ))
            hangup("CALL_REJECTED", "[" .. uuid .. "] Unauthorized IP")
            return
        end
    else
        hangup("NORMAL_TEMPORARY_FAILURE", "[" .. uuid .. "] Database unavailable for auth")
        return
    end
end

-- Get trunk parameters
local customer_id = tonumber(get_var("customer_id", "0"))
local max_channels = tonumber(get_var("max_channels", "50"))
local cps_limit = tonumber(get_var("cps_limit", "10"))
local traffic_grade = get_var("traffic_grade", "standard")

-- Set standard variables
set_var("product_type", "trunk")
set_var("direction", "outbound")

-- ============================================
-- STEP 2: Validate Destination
-- ============================================
if destination == "" then
    hangup("INVALID_NUMBER_FORMAT", "[" .. uuid .. "] Empty destination")
    return
end

-- Normalize destination
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
            set_var("blocked_reason", "high_risk_destination")
            hangup("CALL_REJECTED")
            return
        end

        -- Log for analysis but allow (configurable)
        set_var("fraud_score", risk_level == "critical" and "80" or "50")
    end
end

-- ============================================
-- STEP 4: Check CPS (Calls Per Second) Limit with Tier Support
-- ============================================
-- Use tier-aware CPS checking if redis_cps is available
if redis_cps and customer_id and customer_id > 0 then
    local cps_result = redis_cps.check_cps_with_tier(customer_id, "trunk")

    if not cps_result.allowed then
        freeswitch.consoleLog("WARNING", string.format(
            "[%s] CPS limit exceeded: customer=%d trunk=%s tier=%s current=%d limit=%d\n",
            uuid, customer_id, trunk_id, cps_result.tier_name or "unknown",
            cps_result.current_cps or 0, cps_result.limit or 0
        ))

        -- Set channel variables for logging/billing
        set_var("blocked_reason", "CPS_EXCEEDED")
        set_var("cps_tier", cps_result.tier or "unknown")
        set_var("cps_tier_name", cps_result.tier_name or "Unknown")
        set_var("cps_current", tostring(cps_result.current_cps or 0))
        set_var("cps_limit", tostring(cps_result.limit or 0))

        -- Set upgrade message header if available (for customer notification)
        if cps_result.upgrade_message then
            set_var("sip_h_X-CPS-Upgrade", cps_result.upgrade_message)
            freeswitch.consoleLog("INFO", string.format(
                "[%s] CPS upgrade message: %s\n", uuid, cps_result.upgrade_message
            ))
        end

        -- Return 503 Service Unavailable
        pcall(function()
            session:execute("respond", "503 Service Unavailable")
        end)
        return
    end

    -- Log successful CPS check with tier info
    freeswitch.consoleLog("DEBUG", string.format(
        "[%s] CPS check passed: customer=%d tier=%s current=%d/%d\n",
        uuid, customer_id, cps_result.tier_name or "unknown",
        cps_result.current_cps or 0, cps_result.limit or 0
    ))

    -- Store tier info for billing/analytics
    set_var("cps_tier", cps_result.tier or "free")
    set_var("cps_tier_name", cps_result.tier_name or "Free")

elseif redis and cps_limit > 0 then
    -- Fallback to legacy CPS check if redis_cps not available
    local cps_ok, current_cps = redis.cps_check(trunk_id, cps_limit, "trunk")

    if not cps_ok then
        freeswitch.consoleLog("WARNING", string.format(
            "[%s] CPS limit exceeded (legacy): trunk=%s current=%d limit=%d\n",
            uuid, trunk_id, current_cps, cps_limit
        ))
        set_var("blocked_reason", "CPS_EXCEEDED")
        pcall(function()
            session:execute("respond", "503 Service Unavailable")
        end)
        return
    end
end

-- ============================================
-- STEP 5: Acquire Channel
-- ============================================
if redis then
    local channel_ok, current_channels, max_ch = redis.acquire_channel(trunk_id, max_channels, uuid)

    if not channel_ok then
        freeswitch.consoleLog("WARNING", string.format(
            "[%s] Channel limit exceeded: trunk=%s current=%d max=%d\n",
            uuid, trunk_id, current_channels, max_ch
        ))
        set_var("blocked_reason", "CHANNEL_LIMIT_EXCEEDED")
        hangup("USER_BUSY")  -- 486 equivalent
        return
    end

    freeswitch.consoleLog("DEBUG", string.format(
        "[%s] Channel acquired: %d/%d\n", uuid, current_channels, max_ch
    ))

    -- Set hangup hook to release channel
    set_var("api_hangup_hook", "lua channel_release.lua")
end

-- ============================================
-- STEP 6: Velocity Check (CPM/Daily limits)
-- ============================================
if redis and customer_id > 0 then
    local cpm_limit = tonumber(get_var("cpm_limit", "60"))
    local daily_limit = tonumber(get_var("daily_limit", "500"))

    local velocity_ok, velocity_reason = redis.velocity_check(
        customer_id, cpm_limit, 0, daily_limit, 0.01
    )

    if not velocity_ok then
        freeswitch.consoleLog("WARNING", string.format(
            "[%s] Velocity check FAILED: customer=%d reason=%s\n",
            uuid, customer_id, velocity_reason
        ))
        set_var("blocked_reason", velocity_reason)
        -- Release channel before rejecting
        if redis then
            redis.release_channel(trunk_id, uuid)
        end
        hangup("CALL_REJECTED")
        return
    end
end

-- ============================================
-- STEP 7: Select Carrier Gateway
-- ============================================
-- Trunk calls ALWAYS use carrier_standard (low-CPS trunk, standard rates)
-- traffic_grade is retained as a secondary factor for priority within the trunk
local gateway = "carrier_standard"

freeswitch.consoleLog("INFO", string.format(
    "[trunk_outbound] Routing via %s (product: trunk, traffic_grade: %s)\n",
    gateway, traffic_grade
))

-- Test mode check
local test_mode = os.getenv("TEST_MODE")
if test_mode == "true" then
    freeswitch.consoleLog("INFO", string.format(
        "[%s] TEST MODE: Would route to %s via %s\n",
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

-- Caller ID handling - use original caller ID if valid
local outbound_caller_id = caller_id
if not outbound_caller_id or outbound_caller_id == "" then
    -- Use a default if no caller ID provided
    outbound_caller_id = get_var("sip_from_user", "anonymous")
end

-- Build dial string with proper parameters
-- Use sofia/external/dest@proxy to ensure the outbound INVITE uses ext-sip-ip
-- (public IP 34.74.71.32) in Via, Contact, and SDP headers.
-- The internal profile does NOT apply ext-sip-ip to outbound calls.
-- X-Carrier tells Kamailio which Bandwidth IP to route to.
local dial_string = string.format(
    "{origination_caller_id_number=%s,call_timeout=60,ignore_early_media=false,sip_h_X-Carrier=standard}sofia/external/%s@127.0.0.1:5060",
    outbound_caller_id,
    normalized_dest:gsub("^%+", "")  -- Remove + for carrier (carrier-dependent)
)

freeswitch.consoleLog("INFO", string.format(
    "[%s] Trunk Bridge: %s -> %s via %s (caller_id=%s)\n",
    uuid, trunk_id, normalized_dest, gateway, outbound_caller_id
))

-- Set bridge failure handling
set_var("continue_on_fail", "true")
set_var("hangup_after_bridge", "true")

-- Execute bridge
pcall(function()
    session:execute("bridge", dial_string)
end)

-- Check if bridge succeeded
local bridge_result = get_var("bridge_result", "")
local hangup_cause_var = get_var("originate_disposition", get_var("hangup_cause", ""))

if bridge_result ~= "SUCCESS" then
    freeswitch.consoleLog("WARNING", string.format(
        "[%s] Bridge failed: result=%s cause=%s\n",
        uuid, bridge_result, hangup_cause_var
    ))

    -- Try failover carrier if primary failed
    if gateway == "carrier_standard" then
        freeswitch.consoleLog("INFO", "[" .. uuid .. "] Trying failover carrier\n")

        dial_string = string.format(
            "{origination_caller_id_number=%s,call_timeout=60,sip_h_X-Carrier=backup}sofia/external/%s@127.0.0.1:5060",
            outbound_caller_id,
            normalized_dest:gsub("^%+", "")
        )

        set_var("carrier_used", "carrier_backup")

        pcall(function()
            session:execute("bridge", dial_string)
        end)
    end
end

freeswitch.consoleLog("INFO", "[" .. uuid .. "] Trunk outbound complete\n")
