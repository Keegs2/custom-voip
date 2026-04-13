-- Trunk Outbound Handler - SIP Trunk Customer Outbound Calls
-- Handles outbound calls from customer PBXs through SIP trunks to PSTN
--
-- Call Flow:
-- 1. Read trunk_id and customer_id (set by Kamailio IP auth or dialplan)
-- 2. Validate the caller's DID belongs to this trunk (trunk_dids table)
-- 3. Check CPS (calls per second) via tier-aware Redis limiting
-- 4. Acquire channel (concurrent call limit)
-- 5. Validate destination (fraud checks)
-- 6. Set proper caller ID (trunk DID for carrier, original for display)
-- 7. Bridge via external profile -> Kamailio -> Bandwidth -> PSTN
--
-- Authentication:
--   Kamailio authenticates the customer PBX by source IP and sets:
--     X-Trunk-ID -> trunk_id channel variable
--     X-Customer-ID -> customer_id channel variable
--     X-Max-Channels -> max_channels channel variable
--   If trunk_id is not set, we fall back to IP-based DB lookup.
--
-- Error Handling:
-- - Graceful handling of Redis/DB failures
-- - Proper SIP response codes for each error type
-- - Detailed logging for troubleshooting

-- Load libraries using loadfile (bypasses FreeSWITCH's broken module-directory handling)
-- This is the same pattern used in inbound_router.lua and is more reliable than require()
-- Prepend luarocks paths so redis-lua is found before mod_lua's script-directory searcher
package.path = "/usr/local/share/lua/5.3/?.lua;/usr/local/share/lua/5.3/?/init.lua;/usr/share/lua/5.3/?.lua;/usr/share/lua/5.3/?/init.lua;/usr/local/freeswitch/scripts/lib/?.lua;" .. (package.path or "")
package.cpath = "/usr/local/lib/lua/5.3/?.so;/usr/local/lib/lua/5.3/?/?.so;/usr/lib/lua/5.3/?.so;/usr/lib/lua/5.3/?/?.so;" .. (package.cpath or "")

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
local redis_cps = load_module("redis_cps")
local db = load_module("db_client")

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
local sip_from_user = get_var("sip_from_user", "")
local source_ip = get_var("sip_received_ip", get_var("network_addr", ""))
local trunk_id = get_var("trunk_id", nil)
local customer_id_str = get_var("customer_id", nil)

freeswitch.consoleLog("INFO", string.format(
    "[%s] Trunk Outbound: from=%s sip_from=%s to=%s trunk_id=%s customer_id=%s ip=%s\n",
    uuid, caller_id, sip_from_user, destination, tostring(trunk_id),
    tostring(customer_id_str), source_ip
))

-- ============================================
-- STEP 1: Validate Trunk ID
-- ============================================
-- trunk_id should already be set by Kamailio IP auth (via X-Trunk-ID header)
-- or by earlier dialplan logic. If not set, fall back to DB lookup by IP.

if not trunk_id or trunk_id == "" then
    -- Try to authenticate by IP (fallback path)
    if db then
        local trunk_data = db.lookup_trunk_by_ip(source_ip)
        if trunk_data then
            trunk_id = trunk_data.trunk_id
            set_var("trunk_id", tostring(trunk_id))
            set_var("customer_id", tostring(trunk_data.customer_id))
            set_var("max_channels", tostring(trunk_data.max_channels or 50))
            set_var("cps_limit", tostring(trunk_data.cps_limit or 10))
            set_var("traffic_grade", trunk_data.traffic_grade or "standard")
            customer_id_str = tostring(trunk_data.customer_id)
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
local customer_id = tonumber(customer_id_str or get_var("customer_id", "0"))
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

-- Normalize destination to E.164
local function normalize_destination(number)
    local clean = number:gsub("[^%d+*#]", "")
    if clean:match("^%+") then
        return clean
    end
    local digit_count = #clean
    if digit_count == 10 and clean:match("^%d+$") then
        return "+1" .. clean
    end
    if digit_count == 11 and clean:match("^1%d+$") then
        return "+" .. clean
    end
    if clean:match("^011") then
        return "+" .. clean:gsub("^011", "")
    end
    return "+" .. clean
end

-- Convert E.164 to 10-digit format for carrier delivery
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

-- Normalize a number to E.164 for database comparison
local function normalize_did(number)
    local clean = number:gsub("[^%d+]", "")
    if clean:match("^%+") then
        return clean
    end
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
-- STEP 3: Validate Caller DID Belongs to Trunk
-- ============================================
-- The caller's number (From header / caller_id) should be a DID
-- assigned to this trunk in the trunk_dids table. This prevents
-- customers from spoofing caller ID with numbers they don't own.
--
-- We check the sip_from_user first (most reliable source of the
-- original From header), then fall back to caller_id_number.
local caller_did_raw = sip_from_user
if not caller_did_raw or caller_did_raw == "" then
    caller_did_raw = caller_id
end
local caller_did = normalize_did(caller_did_raw or "")

local validated_caller_did = nil
if db and caller_did ~= "" then
    local trunk_did_data = db.lookup_trunk_did(caller_did)
    if trunk_did_data and tostring(trunk_did_data.trunk_id) == tostring(trunk_id) then
        validated_caller_did = caller_did
        freeswitch.consoleLog("INFO", string.format(
            "[%s] Caller DID %s validated for trunk %s\n",
            uuid, caller_did, trunk_id
        ))
    else
        -- Caller DID does not belong to this trunk.
        -- Try to find ANY DID assigned to this trunk as a fallback.
        -- This handles PBXs that send extensions or internal numbers in From.
        freeswitch.consoleLog("WARNING", string.format(
            "[%s] Caller DID %s not assigned to trunk %s, looking up default DID\n",
            uuid, caller_did, trunk_id
        ))
    end
end

-- If caller DID validation failed, look up a default DID for this trunk
if not validated_caller_did and db then
    -- Query for any DID assigned to this trunk (use as default outbound caller ID)
    local c = db.get_connection()
    if c then
        local sql = string.format(
            "SELECT did FROM trunk_dids WHERE trunk_id = %s LIMIT 1",
            tostring(tonumber(trunk_id) or 0)
        )
        local ok_q, cursor = pcall(function() return c:execute(sql) end)
        if ok_q and cursor then
            local row = cursor:fetch({}, "a")
            if row and row.did then
                validated_caller_did = row.did
                freeswitch.consoleLog("INFO", string.format(
                    "[%s] Using default trunk DID %s for trunk %s\n",
                    uuid, validated_caller_did, trunk_id
                ))
            end
            cursor:close()
        end
    end
end

-- If we still have no valid DID, reject the call
if not validated_caller_did then
    freeswitch.consoleLog("WARNING", string.format(
        "[%s] No valid DID found for trunk %s - cannot place outbound call\n",
        uuid, trunk_id
    ))
    hangup("CALL_REJECTED", "[" .. uuid .. "] No authorized DID for outbound calling")
    return
end

freeswitch.consoleLog("INFO", string.format(
    "[%s] Outbound caller DID: %s (original from PBX: %s)\n",
    uuid, validated_caller_did, caller_did_raw or ""
))

-- ============================================
-- STEP 4: Fraud Prevention - Check high-risk prefix
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

        set_var("fraud_score", risk_level == "critical" and "80" or "50")
    end
end

-- ============================================
-- STEP 5: Check CPS (Calls Per Second) Limit with Tier Support
-- ============================================
if redis_cps and customer_id and customer_id > 0 then
    local cps_ok, cps_result = pcall(function()
        return redis_cps.check_cps_with_tier(customer_id, "trunk")
    end)

    if not cps_ok then
        -- pcall caught an exception (e.g. Redis down) -- fail open
        freeswitch.consoleLog("WARNING", string.format(
            "[%s] CPS check exception (failing OPEN): %s\n",
            uuid, tostring(cps_result)
        ))
        cps_result = { allowed = true, current_cps = 0, limit = 0, tier = "unknown", tier_name = "Unknown" }
    end

    if not cps_result.allowed then
        freeswitch.consoleLog("WARNING", string.format(
            "[%s] CPS limit exceeded: customer=%d trunk=%s tier=%s current=%d limit=%d\n",
            uuid, customer_id, trunk_id, cps_result.tier_name or "unknown",
            cps_result.current_cps or 0, cps_result.limit or 0
        ))

        set_var("blocked_reason", "CPS_EXCEEDED")
        set_var("cps_tier", cps_result.tier or "unknown")
        set_var("cps_tier_name", cps_result.tier_name or "Unknown")
        set_var("cps_current", tostring(cps_result.current_cps or 0))
        set_var("cps_limit", tostring(cps_result.limit or 0))

        if cps_result.upgrade_message then
            set_var("sip_h_X-CPS-Upgrade", cps_result.upgrade_message)
        end

        pcall(function()
            session:execute("respond", "503 Service Unavailable")
        end)
        return
    end

    freeswitch.consoleLog("DEBUG", string.format(
        "[%s] CPS check passed: customer=%d tier=%s current=%d/%d\n",
        uuid, customer_id, cps_result.tier_name or "unknown",
        cps_result.current_cps or 0, cps_result.limit or 0
    ))

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
-- STEP 6: Acquire Channel
-- ============================================
if redis then
    local acq_ok, channel_ok, current_channels, max_ch = pcall(function()
        return redis.acquire_channel(trunk_id, max_channels, uuid)
    end)

    if not acq_ok then
        -- pcall exception -- fail open, allow the call
        freeswitch.consoleLog("WARNING", string.format(
            "[%s] Channel acquire exception (failing OPEN): %s\n",
            uuid, tostring(channel_ok)
        ))
    elseif not channel_ok then
        freeswitch.consoleLog("WARNING", string.format(
            "[%s] Channel limit exceeded: trunk=%s current=%d max=%d\n",
            uuid, trunk_id, current_channels or 0, max_ch or max_channels
        ))
        set_var("blocked_reason", "CHANNEL_LIMIT_EXCEEDED")
        hangup("USER_BUSY")  -- 486 equivalent
        return
    else
        freeswitch.consoleLog("DEBUG", string.format(
            "[%s] Channel acquired: %d/%d\n", uuid, current_channels or 0, max_ch or max_channels
        ))
    end

    -- Set hangup hook to release channel
    set_var("api_hangup_hook", "lua channel_release.lua")
end

-- ============================================
-- STEP 7: Velocity Check (CPM/Daily limits)
-- ============================================
if redis and customer_id > 0 then
    local cpm_limit = tonumber(get_var("cpm_limit", "60"))
    local daily_limit = tonumber(get_var("daily_limit", "500"))

    -- Wrap in pcall to guarantee fail-open if Redis is unreachable
    local vel_ok, velocity_ok, velocity_reason = pcall(function()
        return redis.velocity_check(customer_id, cpm_limit, 0, daily_limit, 0.01)
    end)

    if vel_ok and velocity_ok == false then
        -- Only reject for actual limit violations, NOT for Redis errors
        if velocity_reason and velocity_reason ~= "REDIS_ERROR"
           and velocity_reason ~= "REDIS_CONNECTION_FAILED" then
            freeswitch.consoleLog("WARNING", string.format(
                "[%s] Velocity check FAILED: customer=%d reason=%s\n",
                uuid, customer_id, velocity_reason
            ))
            set_var("blocked_reason", velocity_reason)
            if redis then
                redis.release_channel(trunk_id, uuid)
            end
            hangup("CALL_REJECTED")
            return
        else
            freeswitch.consoleLog("WARNING", string.format(
                "[%s] Velocity check Redis unavailable (reason=%s), failing OPEN\n",
                uuid, tostring(velocity_reason)
            ))
        end
    elseif not vel_ok then
        -- pcall caught an exception -- fail open
        freeswitch.consoleLog("WARNING", string.format(
            "[%s] Velocity check exception (failing OPEN): %s\n",
            uuid, tostring(velocity_ok)
        ))
    end
end

-- ============================================
-- STEP 8: Build and Execute Bridge
-- ============================================
-- Trunk calls ALWAYS use carrier_standard (low-CPS trunk, standard rates)
local gateway = "carrier_standard"

freeswitch.consoleLog("INFO", string.format(
    "[trunk_outbound] Routing via %s (product: trunk, traffic_grade: %s)\n",
    gateway, traffic_grade
))

-- Test mode check
local test_mode = os.getenv("TEST_MODE")
if test_mode == "true" then
    freeswitch.consoleLog("INFO", string.format(
        "[%s] TEST MODE: Would route to %s via %s (caller_did=%s)\n",
        uuid, normalized_dest, gateway, validated_caller_did
    ))
    pcall(function()
        session:answer()
        session:execute("playback", "tone_stream://%(1000,0,600)")
        session:sleep(2000)
        session:hangup("NORMAL_CLEARING")
    end)
    return
end

set_var("carrier_used", gateway)
set_var("destination_number", normalized_dest)

-- ================================================================
-- Caller ID handling (FusionPBX-style, same as inbound_router.lua)
-- ================================================================
-- For outbound trunk calls:
--   outbound_caller_id_number: The trunk DID in 10-digit format.
--     Bandwidth requires the DID that's on our account for termination auth.
--   effective_caller_id_number: The original caller ID from the PBX.
--     This is what the called party sees on their phone display.
-- The trunk DID goes in the SIP From header (carrier auth).
-- The original PBX caller ID goes in P-Asserted-Identity (display).

local outbound_did_10 = to_10digit(validated_caller_did)
session:setVariable("outbound_caller_id_number", outbound_did_10)
session:setVariable("outbound_caller_id_name", outbound_did_10)

-- Preserve the PBX's original caller ID for display to the called party
local original_cid = to_10digit(caller_id)
if original_cid and original_cid ~= "" then
    session:setVariable("effective_caller_id_number", original_cid)
    session:setVariable("effective_caller_id_name", get_var("caller_id_name", original_cid))
else
    session:setVariable("effective_caller_id_number", outbound_did_10)
    session:setVariable("effective_caller_id_name", outbound_did_10)
end

-- X-Original-CID: Kamailio reads this to build P-Asserted-Identity
session:setVariable("sip_h_X-Original-CID", original_cid or outbound_did_10)

-- Diversion header: indicates the call originated from a trunk DID
session:setVariable("sip_h_Diversion",
    "<sip:" .. outbound_did_10 .. "@34.74.71.32>;reason=unconditional")

freeswitch.consoleLog("INFO", string.format(
    "[trunk_outbound] CID setup: outbound_cid=%s effective_cid=%s original_pbx=%s\n",
    outbound_did_10, original_cid or outbound_did_10, caller_id
))

-- ================================================================
-- Media anchoring and early media (ringback) configuration
-- ================================================================
-- Same as RCF: FS must stay in the RTP media path (B2BUA mode).
-- proxy_media=true keeps FS in the path with codec passthrough.
set_var("proxy_media", "true")
set_var("ringback", "%(2000,4000,440,480)")
set_var("transfer_ringback", "%(2000,4000,440,480)")

-- Build dial string using external profile to ensure public IP in Via/Contact/SDP.
-- X-Carrier tells Kamailio which Bandwidth IP to route to.
local dial_string = string.format(
    "{ignore_early_media=false,call_timeout=60,sip_h_X-Carrier=standard}sofia/external/%s@127.0.0.1:5060",
    normalized_dest:gsub("^%+", "")  -- Remove + for carrier (carrier-dependent)
)

freeswitch.consoleLog("INFO", string.format(
    "[%s] Trunk Bridge: trunk=%s -> %s via %s (outbound_cid=%s, effective_cid=%s)\n",
    uuid, trunk_id, normalized_dest, gateway, outbound_did_10, original_cid or outbound_did_10
))

-- Set bridge failure handling
set_var("continue_on_fail", "true")
set_var("hangup_after_bridge", "true")
-- Mark that Lua is handling routing (prevents dialplan fallback 404)
set_var("lua_routed", "true")

-- RFC 4028 session timers: force FS to include Session-Expires and Min-SE
-- in the outbound INVITE. Without these, Bandwidth sends Session-Expires:30
-- in 200 OK and tears down the call when FS doesn't send refresh re-INVITEs.
set_var("sip_session_timeout", "1800")
set_var("sip_minimum_session_expires", "90")
set_var("enable_timer", "true")

-- Execute bridge
pcall(function()
    session:execute("bridge", dial_string)
end)

-- Check if bridge succeeded
local bridge_result = get_var("bridge_result", "")
local last_bridge_hangup = get_var("last_bridge_hangup_cause", get_var("originate_disposition", ""))

if bridge_result ~= "SUCCESS" then
    freeswitch.consoleLog("WARNING", string.format(
        "[%s] Primary bridge failed: result=%s cause=%s\n",
        uuid, bridge_result, last_bridge_hangup
    ))

    -- Try failover carrier
    freeswitch.consoleLog("INFO", "[" .. uuid .. "] Trying failover carrier\n")
    set_var("carrier_used", "carrier_backup")

    local failover_dial = string.format(
        "{ignore_early_media=false,call_timeout=60,sip_h_X-Carrier=backup}sofia/external/%s@127.0.0.1:5060",
        normalized_dest:gsub("^%+", "")
    )

    pcall(function()
        session:execute("bridge", failover_dial)
    end)

    -- Re-check after failover
    bridge_result = get_var("bridge_result", "")
    last_bridge_hangup = get_var("last_bridge_hangup_cause", "")
end

-- If all bridges failed, return 503 (DID was found, carrier unreachable)
if bridge_result ~= "SUCCESS" then
    freeswitch.consoleLog("WARNING", string.format(
        "[%s] All bridges failed for trunk %s -> %s (last_cause=%s)\n",
        uuid, trunk_id, normalized_dest, last_bridge_hangup
    ))
    hangup("NORMAL_TEMPORARY_FAILURE",
        "[" .. uuid .. "] Trunk bridge failed, returning 503 (carrier unreachable)")
    return
end

freeswitch.consoleLog("INFO", "[" .. uuid .. "] Trunk outbound complete\n")
