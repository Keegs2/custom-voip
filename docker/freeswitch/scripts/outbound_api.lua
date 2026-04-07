-- Outbound API Call Handler
-- Handles calls originated via REST API (API Calling product)
--
-- Call Flow:
-- 1. Get call parameters from session (set by ESL originate command)
-- 2. Validate destination (fraud checks)
-- 3. Check customer velocity limits
-- 4. Select carrier based on traffic grade
-- 5. Bridge to destination or execute webhook
--
-- Error Handling:
-- - Graceful handling of all failures
-- - Proper logging for debugging
-- - Webhook fallback support

package.path = package.path .. ";/etc/freeswitch/scripts/lib/?.lua"

local ok, redis = pcall(require, "redis_client")
if not ok then
    freeswitch.consoleLog("ERR", "Failed to load redis_client: " .. tostring(redis) .. "\n")
    redis = nil
end

local ok2, db = pcall(require, "db_client")
if not ok2 then
    freeswitch.consoleLog("ERR", "Failed to load db_client: " .. tostring(db) .. "\n")
    db = nil
end

-- Ensure session exists
if not session then
    freeswitch.consoleLog("ERR", "No session object in outbound_api\n")
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

-- Get call variables (set by API when originating via ESL)
local uuid = get_var("uuid", "unknown")
local destination = get_var("destination_number", "")
local from_did = get_var("caller_id_number", "")
local customer_id = tonumber(get_var("customer_id", "0"))
local webhook_url = get_var("webhook_url", "")
local traffic_grade = get_var("traffic_grade", "standard")
local call_timeout = tonumber(get_var("call_timeout", "60"))

freeswitch.consoleLog("INFO", string.format(
    "[%s] API Outbound: from=%s to=%s customer=%d webhook=%s\n",
    uuid, from_did, destination, customer_id, webhook_url ~= "" and "yes" or "no"
))

-- Set standard variables
set_var("product_type", "api")
set_var("direction", "outbound")

-- ============================================
-- STEP 1: Validate Destination
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
    return "+" .. clean
end

local normalized_dest = normalize_destination(destination)
freeswitch.consoleLog("DEBUG", "[" .. uuid .. "] Normalized destination: " .. normalized_dest .. "\n")

-- ============================================
-- STEP 2: Fraud Prevention - Check high-risk prefix
-- ============================================
if redis then
    local is_risky, risk_level, risk_prefix = redis.check_prefix(normalized_dest)
    if is_risky then
        freeswitch.consoleLog("WARNING", string.format(
            "[%s] High-risk destination: %s (prefix: %s, level: %s)\n",
            uuid, normalized_dest, risk_prefix, risk_level
        ))

        if risk_level == "blocked" then
            set_var("blocked_reason", "high_risk_destination")
            hangup("CALL_REJECTED")
            return
        end

        -- Log for analysis but allow
        set_var("fraud_score", risk_level == "critical" and "80" or "50")
    end
end

-- ============================================
-- STEP 3: Velocity Check
-- ============================================
if redis and customer_id > 0 then
    -- API calling typically has higher limits
    local cpm_limit = tonumber(get_var("cpm_limit", "120"))
    local daily_limit = tonumber(get_var("daily_limit", "1000"))
    local estimated_cost = 0.02  -- Higher for API calls

    local velocity_ok, velocity_reason = redis.velocity_check(
        customer_id, cpm_limit, 0, daily_limit, estimated_cost
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
-- STEP 4: Select Carrier Gateway
-- ============================================
local gateway = nil

if traffic_grade == "premium" then
    gateway = "carrier_premium"
else
    gateway = "carrier_standard"
end

set_var("carrier_used", gateway)

-- ============================================
-- STEP 5: Execute Call / Bridge
-- ============================================

-- Test mode check
local test_mode = os.getenv("TEST_MODE")
if test_mode == "true" then
    freeswitch.consoleLog("INFO", string.format(
        "[%s] TEST MODE: Would call %s via %s\n",
        uuid, normalized_dest, gateway
    ))

    pcall(function()
        session:answer()
        session:execute("playback", "tone_stream://%(1000,0,440)")
        session:sleep(2000)
    end)

    -- If webhook provided, log what we would do
    if webhook_url ~= "" then
        freeswitch.consoleLog("INFO", "[" .. uuid .. "] Would fetch webhook: " .. webhook_url .. "\n")
    end

    pcall(function()
        session:hangup("NORMAL_CLEARING")
    end)
    return
end

-- Check if this is a webhook-controlled call or simple bridge
if webhook_url ~= "" then
    -- Webhook-controlled call - use httapi
    freeswitch.consoleLog("INFO", string.format(
        "[%s] Executing webhook: %s\n",
        uuid, webhook_url
    ))

    -- Set fallback URL if provided
    local fallback_url = get_var("fallback_url", "")
    if fallback_url ~= "" then
        set_var("httapi_fallback_url", fallback_url)
    end

    -- Execute httapi with webhook URL
    pcall(function()
        session:execute("httapi", "{url=" .. webhook_url .. "}")
    end)

else
    -- Simple bridge to destination
    local dial_string = string.format(
        "{origination_caller_id_number=%s,call_timeout=%d,ignore_early_media=false}sofia/gateway/%s/%s",
        from_did ~= "" and from_did or "anonymous",
        call_timeout,
        gateway,
        normalized_dest:gsub("^%+", "")
    )

    freeswitch.consoleLog("INFO", string.format(
        "[%s] API Bridge: -> %s via %s\n",
        uuid, normalized_dest, gateway
    ))

    set_var("continue_on_fail", "true")
    set_var("hangup_after_bridge", "true")

    pcall(function()
        session:execute("bridge", dial_string)
    end)

    -- Check if bridge succeeded
    local bridge_result = get_var("bridge_result", "")

    if bridge_result ~= "SUCCESS" then
        freeswitch.consoleLog("WARNING", string.format(
            "[%s] Bridge failed: %s\n",
            uuid, get_var("originate_disposition", "unknown")
        ))

        -- Try failover carrier
        if gateway == "carrier_standard" then
            freeswitch.consoleLog("INFO", "[" .. uuid .. "] Trying failover carrier\n")

            dial_string = string.format(
                "{origination_caller_id_number=%s,call_timeout=%d}sofia/gateway/carrier_premium/%s",
                from_did ~= "" and from_did or "anonymous",
                call_timeout,
                normalized_dest:gsub("^%+", "")
            )

            set_var("carrier_used", "carrier_premium")

            pcall(function()
                session:execute("bridge", dial_string)
            end)
        end
    end
end

freeswitch.consoleLog("INFO", "[" .. uuid .. "] API outbound complete\n")
