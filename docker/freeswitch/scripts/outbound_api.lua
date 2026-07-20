-- Outbound API Call Handler
local sbc_proxy_ip = os.getenv("SBC_PROXY_IP") or "127.0.0.1"
local external_sip_ip = os.getenv("EXTERNAL_SIP_IP") or "auto"

-- Per-attempt progress timeout in seconds (progress_timeout on each carrier
-- attempt). Fails the attempt only if NO provisional response (180/183)
-- arrives within N seconds (bounds PDD); once ringing starts the call may
-- ring up to call_timeout. Tunable via BRIDGE_PROGRESS_TIMEOUT in
-- /opt/revup/.env. Default 10 per CLAUDE.md.
local bridge_progress_timeout = tonumber(os.getenv("BRIDGE_PROGRESS_TIMEOUT") or "")
if not bridge_progress_timeout or bridge_progress_timeout < 1 then
    bridge_progress_timeout = 10
end
bridge_progress_timeout = math.floor(bridge_progress_timeout)
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

-- Fix package paths: scripts/lib for our modules, luarocks paths for redis-lua etc.
package.path = "/usr/local/freeswitch/scripts/lib/?.lua;/usr/local/freeswitch/scripts/?.lua;/usr/local/share/lua/5.3/?.lua;/usr/local/share/lua/5.3/?/init.lua;/usr/share/lua/5.3/?.lua;/usr/share/lua/5.3/?/init.lua;" .. (package.path or "")
package.cpath = "/usr/local/lib/lua/5.3/?.so;/usr/local/lib/lua/5.3/?/?.so;/usr/lib/lua/5.3/?.so;/usr/lib/lua/5.3/?/?.so;" .. (package.cpath or "")

-- Load local modules using loadfile() — NOT require() (CLAUDE.md gotcha #10:
-- mod_lua installs the script directory as a package searcher, so a bare
-- require() of a script-directory module can silently fail/misbehave and break
-- this LIVE ESL-originate path). This is the same proven pattern used by
-- inbound_router.lua / trunk_outbound.lua. All failures are fail-open (nil).
local function load_module(name)
    local path = "/usr/local/freeswitch/scripts/lib/" .. name .. ".lua"
    local func, err = loadfile(path)
    if not func then
        freeswitch.consoleLog("ERR", "[outbound_api] Failed to load " .. name .. ": " .. tostring(err) .. "\n")
        return nil
    end
    local ok, result = pcall(func)
    if not ok then
        freeswitch.consoleLog("ERR", "[outbound_api] Failed to execute " .. name .. ": " .. tostring(result) .. "\n")
        return nil
    end
    return result
end

local redis = load_module("redis_client")
local db = load_module("db_client")
-- Least-Cost Outbound (LCO) carrier ordering. On the API-originated path we honor
-- an EXPLICIT route only (channel var lco_route / SIP header X-LCO-Route the API
-- sets when it originates) — NO DB lookup on this hot path (db is intentionally
-- omitted from resolve_carriers below). FAIL-SAFE: no explicit route -> nil ->
-- the default {primary, secondary} order below is byte-identical to before.
local lco = load_module("lco")

-- E.164 normalization helpers — single source of truth in lib/e164.lua.
local e164 = load_module("e164")
if not e164 then
    freeswitch.consoleLog("ERR", "[outbound_api] Failed to load e164 — number normalization will fail\n")
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

-- Use the actual SIP Call-ID from the inbound INVITE for X-CID correlation.
-- Allows Homer to correlate A-leg and B-leg captures. Fallback to uuid if not set.
local sip_call_id = session:getVariable("sip_call_id") or uuid

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

-- Normalize destination to E.164 via the single source of truth lib/e164.
-- RECONCILED (Phase 9): this used to carry an inline copy that DIVERGED by
-- lacking the `011` international-prefix -> "+" branch. The divergence is now
-- aligned — lib/e164.normalize_destination is identical except it ALSO maps a
-- leading `011` international prefix to "+", which is the correct behavior here.
local function normalize_destination(number)
    if e164 and e164.normalize_destination then
        return e164.normalize_destination(number)
    end
    -- Fail-open fallback (e164 module failed to load): basic normalization,
    -- preserving the same 10/11-digit US handling.
    local clean = number:gsub("[^%d+*#]", "")
    if clean:match("^%+") then return clean end
    local digit_count = #clean
    if digit_count == 10 and clean:match("^%d+$") then return "+1" .. clean end
    if digit_count == 11 and clean:match("^1%d+$") then return "+" .. clean end
    if clean:match("^011") then return "+" .. clean:gsub("^011", "") end
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
-- Default: carrier_primary then carrier_secondary (2-carrier model). LCO override:
-- if the API set an explicit X-LCO-Route / lco_route, use that ordered token list
-- instead. NO DB lookup here (db omitted) — the API carries its own route; the DB
-- lco_routes view is used on the RCF/inbound-forward path (handlers/rcf.lua).
-- traffic_grade is retained as a secondary factor for priority within the trunk.
local lco_carriers = (lco and lco.resolve_carriers({
    get_var = get_var, dest = normalized_dest, uuid = uuid,
})) or { "primary", "secondary" }
local primary_carrier = lco_carriers[1] or "primary"
local secondary_carrier = lco_carriers[2]  -- may be nil (single-carrier route)
local gateway = "carrier_" .. primary_carrier

freeswitch.consoleLog("INFO", string.format(
    "[outbound_api] Routing via %s (product: api, traffic_grade: %s)\n",
    gateway, traffic_grade
))

set_var("carrier_used", gateway)

-- disable_soa on the A-leg session: CRITICAL for carrier interop.
-- The SOA engine reads this variable from the A-leg session context,
-- NOT from the B-leg channel variables set in the bridge {} block.
-- Setting it here ensures FS does not run SDP offer/answer processing
-- sip_enable_soa=false disables SDP Offer/Answer engine. Must be exported.
-- sip_enable_soa=false is in B-leg bridge string only

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
    -- Webhook-controlled call - use voice_webhook.lua engine
    freeswitch.consoleLog("INFO", string.format(
        "[%s] Webhook-controlled call: handing off to voice_webhook engine, url=%s\n",
        uuid, webhook_url
    ))

    -- Set up variables for the webhook engine
    set_var("voice_url", webhook_url)
    set_var("direction", "outbound")

    -- Set fallback URL if provided
    local fallback_url = get_var("fallback_url", "")
    if fallback_url ~= "" then
        set_var("fallback_url", fallback_url)
    end

    -- Derive status_callback from webhook_url base if not explicitly set
    local callback_url_var = get_var("callback_url", "")
    if callback_url_var ~= "" then
        set_var("status_callback", callback_url_var)
    else
        local status_base = webhook_url:match("^(https?://[^/]+)")
        if status_base then
            set_var("status_callback", status_base .. "/status")
        end
    end

    -- Execute the webhook engine script
    -- handlers/api_voice.lua (renamed from voice_webhook.lua) handles the full
    -- TwiML-compatible XML fetch/parse/execute loop
    pcall(function()
        session:execute("lua", "handlers/api_voice.lua")
    end)

else
    -- Simple bridge to destination
    -- Use sofia/external/dest@proxy to ensure the outbound INVITE uses ext-sip-ip
    -- (public IP 34.74.71.32) in Via, Contact, and SDP headers.
    -- The internal profile does NOT apply ext-sip-ip to outbound calls.
    -- X-Carrier tells Kamailio which Bandwidth IP to route to.
    local dial_string = string.format(
        "{origination_caller_id_number=%s,progress_timeout=%d,call_timeout=%d,ignore_early_media=false,sip_enable_soa=false,sip_h_X-Carrier=%s" ..
        ",sip_h_X-CID=%s" ..
        ",sip_session_timeout=1800,sip_minimum_session_expires=90,enable_timer=true}sofia/external/%s@" .. sbc_proxy_ip .. ":5060",
        from_did ~= "" and from_did or "anonymous",
        bridge_progress_timeout,
        call_timeout,
        primary_carrier,
        sip_call_id,
        normalized_dest:gsub("^%+", "")
    )

    freeswitch.consoleLog("INFO", string.format(
        "[%s] API Bridge: -> %s via %s\n",
        uuid, normalized_dest, gateway
    ))

    set_var("continue_on_fail", "true")
    set_var("hangup_after_bridge", "true")

    -- RFC 4028 session timers: export to B-leg so mod_sofia includes
    -- Session-Expires and Min-SE in the outbound INVITE.
    -- CRITICAL: set_var() only sets on the A-leg. export via session:execute
    -- marks the variable for propagation to the B-leg channel.
    -- Belt-and-suspenders: these are also included in the bridge {} blocks.
    pcall(function() session:execute("export", "sip_session_timeout=1800") end)
    pcall(function() session:execute("export", "sip_minimum_session_expires=90") end)
    pcall(function() session:execute("export", "enable_timer=true") end)

    pcall(function()
        session:execute("bridge", dial_string)
    end)

    -- Check if bridge succeeded. originate_disposition is the authoritative
    -- FreeSWITCH variable ("SUCCESS" on connect, a failure cause otherwise).
    -- bridge_result is NOT a real channel variable and must never be trusted.
    local disposition = get_var("originate_disposition", "")

    if disposition ~= "SUCCESS" and session:ready() then
        freeswitch.consoleLog("WARNING", string.format(
            "[%s] Bridge failed: %s\n",
            uuid, disposition ~= "" and disposition or "unknown"
        ))

        -- Try the next carrier in the LCO order (default: secondary = LA). Skip
        -- when there is no distinct second carrier (a single-carrier LCO route).
        if secondary_carrier and secondary_carrier ~= primary_carrier then
            freeswitch.consoleLog("INFO", string.format(
                "[outbound_api] Primary bridge failed, trying carrier_%s (product: api)\n",
                secondary_carrier
            ))

            dial_string = string.format(
                "{origination_caller_id_number=%s,progress_timeout=%d,call_timeout=%d,sip_enable_soa=false,sip_h_X-Carrier=%s" ..
                ",sip_h_X-CID=%s" ..
                ",sip_session_timeout=1800,sip_minimum_session_expires=90,enable_timer=true}sofia/external/%s@" .. sbc_proxy_ip .. ":5060",
                from_did ~= "" and from_did or "anonymous",
                bridge_progress_timeout,
                call_timeout,
                secondary_carrier,
                sip_call_id,
                normalized_dest:gsub("^%+", "")
            )

            set_var("carrier_used", "carrier_" .. secondary_carrier)

            pcall(function()
                session:execute("bridge", dial_string)
            end)
        end
    end
end

freeswitch.consoleLog("INFO", "[" .. uuid .. "] API outbound complete\n")
