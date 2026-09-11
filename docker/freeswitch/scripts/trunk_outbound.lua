-- Trunk Outbound Handler - SIP Trunk Customer Outbound Calls
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
-- Shared canonical normalizer (Lua/Python/TS same algorithm). See
-- lib/number_utils.lua. normalize_destination / normalize_did / to_10digit
-- below delegate to it so there is ONE implementation on the call path.
local number_utils = load_module("number_utils")
if not number_utils then
    freeswitch.consoleLog("ERR", "[trunk_outbound] number_utils failed to load — falling back to legacy inline normalization\n")
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

-- ================================================================
-- fs_node / fs_zone: which FreeSWITCH node produced this call
-- ================================================================
-- Plain channel variables, so mod_json_cdr carries them in the CDR
-- `variables` object (switch_ivr.c:3304-3323 serialises every channel
-- variable, no allow-list) and the ingest can store cdrs.freeswitch_node.
-- WHY: the ingest used to read `FreeSWITCH-Hostname`, which is an EVENT
-- header and NEVER a channel variable, so the column was NULL on every
-- production row; and switch.conf.xml pins `switchname` to the same value
-- ("voiceplatform") on every node, so the CDR body's switchname is not
-- zone-identifying either. FS_NODE_ID (optional) distinguishes fs-1 from
-- fs-2 within a zone; otherwise "<zone>-fs". The ingest keeps its
-- media-IP / switchname / core-uuid fallbacks, so this is the PREFERRED
-- source, not the only one. Set on every CDR-producing entry script
-- (inbound_router / trunk_outbound / api_outbound) so the field is not
-- populated for inbound RCF only.
do
    local fs_zone_cdr = os.getenv("FS_ZONE") or "east"
    if fs_zone_cdr ~= "east" and fs_zone_cdr ~= "west" and fs_zone_cdr ~= "central" then
        fs_zone_cdr = "east"
    end
    local node_id = os.getenv("FS_NODE_ID")
    if not node_id or node_id == "" then
        node_id = fs_zone_cdr .. "-fs"
    end
    set_var("fs_node", node_id)
    set_var("fs_zone", fs_zone_cdr)
end

-- ================================================================
-- STIR outcome hand-back (docker/kamailio/CLAUDE.md 8.14)
-- ================================================================
-- Kamailio echoes the Identity set it ACTUALLY composed on the carrier /
-- PBX leg back to FS as `X-Stir-Outcome` on every non-100 reply
-- (eff=..;mode=..;identities=..;base=..;div=..;stripped=..). The A-leg CDR
-- contract with the ingest is the channel variable `stir_outcome` (set
-- below, verbatim header value) -- do not rename it or change the format.
--
-- HOW THE VALUE REACHES THIS A-LEG (no `import`, no B-leg access needed):
-- on every 180/183 and every status > 199 -- INCLUDING a 4xx/5xx/6xx that
-- FAILS the originate -- mod_sofia's outbound nua_r_invite handler exports
-- the reply's unknown X-/P- headers as B-leg channel variables
-- (sofia.c:6775-6784 -> sofia_glue_set_extra_headers(), sofia_glue.c:959-965;
-- name filter sofia_test_extra_headers, mod_sofia.h:1137 -- "X-" and not
-- "X-FS-" qualifies, so X-Stir-Outcome does) under the VERBATIM header name:
-- sip_ph_X-Stir-Outcome on 18x, sip_rh_X-Stir-Outcome on finals. It then
-- copies them onto the partner leg with switch_ivr_transfer_variable(session,
-- other_session, "~sip_rh_" / "~sip_ph_") (sofia.c:6787-6798; "~" = prefix
-- match, switch_ivr.c:2327-2346), gated only by sip_copy_custom_headers
-- (default ON, deliberately untouched here). The partner lookup succeeds even
-- while the originate is still failing because the B-leg's signal_bond is set
-- to this A-leg's uuid at B-leg CREATION (switch_core_session.c:711). So the
-- value is on THIS channel by the time session:execute("bridge") returns,
-- without ever touching the (already released) peer session.
--
-- WHY NOT the `import` channel variable: switch_ivr_originate() only reaches
-- switch_process_import() with a usable peer_channel on the SUCCESS path
-- (switch_ivr_originate.c:3903). The failure-path call at :3835 is guarded by
-- `if (caller_channel && peer_channel)`, and peer_channel is NULL there for
-- every ordinary failed bridge -- it is assigned non-NULL only inside the
-- attended-transfer `if (holding)` block at :3616-3642. `import` would
-- therefore capture nothing on exactly the failing attempts we most want
-- labelled, while adding an `import` variable to every CDR
-- (mod_json_cdr serialises every channel variable -- switch_ivr.c:3304-3323).
local STIR_OUTCOME_RH = "sip_rh_X-Stir-Outcome"
local STIR_OUTCOME_PH = "sip_ph_X-Stir-Outcome"

-- Clear the two RAW capture slots before every bridge attempt, so a reply
-- header left over from attempt N can never be read as attempt N+1's.
-- The CDR var `stir_outcome` is deliberately NOT cleared: it RETAINS the last
-- non-empty outcome and is only overwritten when a newer non-empty one is
-- captured, so the FINAL attempt's outcome wins whenever one arrives, and an
-- attempt that produces NO hand-back leaves the previous real outcome in
-- place instead of an EMPTY CDR field (which the ingest would silently
-- replace with FS intent). Two hand-back BLIND SPOTS make that matter:
--   1. Locally generated finals never run onreply_route: tm's fr_inv_timer
--      408 (dead SBC / carrier silence, the progress_timeout case) and a
--      failure_route send_reply(503) carry no X-Stir-Outcome.
--   2. A docker/kamailio/CLAUDE.md 8.12 peer-handed-off reply reaches the
--      owner SBC from the SIBLING SBC's internal IP; REPLY_HANDLER's
--      `!route(IS_INTERNAL_SOURCE)` guard then skips the header, so a reply
--      that crossed the pair during a failback window hands nothing back.
-- `stir_outcome_attempt` (set by the capture) records WHICH attempt the
-- stored value came from, so a retained earlier-attempt outcome is
-- distinguishable in the CDR from the winning attempt's.
-- An empty value DELETES a channel variable (switch_channel.c:1497-1499
-- `if (zstr(value)) switch_event_del_header(...)`), and the Lua binding hands
-- the value straight through (switch_cpp.cpp:770-776) -- this is a real
-- delete, not a stored empty string, so get_var()'s default applies.
local function stir_outcome_reset()
    pcall(function()
        session:setVariable(STIR_OUTCOME_RH, "")
        session:setVariable(STIR_OUTCOME_PH, "")
    end)
end

-- Read the outcome for the attempt that just finished (final reply wins over
-- provisional), pin it in `stir_outcome` (overwriting any earlier attempt's
-- value; an EMPTY read keeps the earlier value — see stir_outcome_reset),
-- then CONSUME the raw slots.
-- Consuming matters: mod_sofia RE-EMITS any sip_rh_*/sip_ph_* channel variable
-- as a real header on responses THIS channel sends (mod_sofia.c:960 200 OK,
-- :2473 180, :2656 183, :570 error responses -> sofia_glue_get_extra_headers()),
-- and mod_json_cdr dumps every channel variable into the CDR with no
-- allow-list. Kamailio's core reply_route strips X-Stir-Outcome off every reply
-- it relays (so the A-leg 18x/200 sent DURING the bridge cannot leak it to the
-- carrier); this is the FS-side half of the same defence, and it keeps the raw
-- header out of the CDR.
local function stir_outcome_capture(uuid, label)
    local v = get_var(STIR_OUTCOME_RH, "")
    local src = "final"
    if v == "" then
        v = get_var(STIR_OUTCOME_PH, "")
        src = "provisional"
    end
    pcall(function()
        session:setVariable(STIR_OUTCOME_RH, "")
        session:setVariable(STIR_OUTCOME_PH, "")
    end)
    if v ~= "" then
        v = v:match("^%s*(.-)%s*$") or v
        pcall(function()
            session:setVariable("stir_outcome", v)
            session:setVariable("stir_outcome_attempt", tostring(label))
        end)
        freeswitch.consoleLog("INFO", string.format(
            "[%s] STIR outcome (%s, from %s reply): %s\n", uuid, tostring(label), src, v))
    else
        freeswitch.consoleLog("DEBUG", string.format(
            "[%s] STIR outcome (%s): no X-Stir-Outcome on any reply (local failure / peer-handed-off reply / pre-hand-back SBC) — keeping stir_outcome=%q from attempt %q\n",
            uuid, tostring(label), get_var("stir_outcome", ""), get_var("stir_outcome_attempt", "")))
    end
    return v
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

-- Use the actual SIP Call-ID from the inbound INVITE for X-CID correlation.
-- Allows Homer to correlate A-leg and B-leg captures. Fallback to uuid if not set.
local sip_call_id = session:getVariable("sip_call_id") or uuid
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

-- Normalize destination to canonical E.164 (with '+', country code preserved).
-- Delegates to the shared number_utils.to_e164. This value (normalized_dest) is
-- the OUTBOUND WIRE number sent to the carrier — it keeps its '+' and country
-- code (do NOT force +1 on an international dial-out).
--
-- International-prefix handling stays HERE, before to_e164: a PBX that dials the
-- North-American international access code 011<CC><nsn> means "+<CC><nsn>", so we
-- rewrite a leading 011 to '+' first (the canonical spec deliberately does not
-- know the 011 access code). '*'/'#' feature codes never reach to_e164 (they
-- have no bare-10/11-digit or + form and fall through to the lenient fallback,
-- preserving prior behavior).
local function normalize_destination(number)
    number = number or ""
    -- Rewrite the NANP international access code 011... -> +... before canonical.
    local pre = number:gsub("[^%d+*#]", "")
    if pre:match("^011%d") then
        pre = "+" .. pre:gsub("^011", "")
    end

    if number_utils then
        local canon = number_utils.to_e164(pre)
        if canon then
            return canon
        end
        -- to_e164 rejected it — fall through to legacy lenient (keeps *,# etc.)
    end

    -- Legacy lenient fallback (never nil). Operates on the *-preserving `pre`.
    local clean = pre
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

-- Convert E.164 to 10-digit format for carrier delivery (From/caller-ID only).
local function to_10digit(number)
    if number_utils then
        return number_utils.to_10digit(number)
    end
    -- Legacy fallback (number_utils failed to load) — identical behavior.
    if not number or number == "" then return number end
    local digits = number:gsub("[^%d]", "")
    if #digits == 11 and digits:sub(1, 1) == "1" then
        return digits:sub(2)
    elseif #digits == 10 then
        return digits
    end
    return digits
end

-- Normalize a number to canonical E.164 for DID (trunk_dids) comparison.
-- Delegates to the shared number_utils.to_e164; non-nil (lenient fallback) so a
-- malformed From never crashes caller-DID validation. The DB lookup key is ALSO
-- canonicalized inside db_client.lookup_trunk_did, so this is belt-and-suspenders.
local function normalize_did(number)
    if number_utils then
        local canon = number_utils.to_e164(number)
        if canon then
            return canon
        end
    end
    local clean = (number or ""):gsub("[^%d+]", "")
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
-- STIR/SHAKEN attestation basis (Phase 2 Task 2.1): true ONLY when the calling
-- number the PBX presented is a DID we can confirm belongs to THIS trunk (the
-- ownership check below passes). The default-DID fallback (:294-316) substitutes
-- a different trunk DID because the presented number could NOT be validated, so
-- it is NOT ownership of the presented calling number -> attest B, not A.
local caller_did_owned = false
if db and caller_did ~= "" then
    local trunk_did_data = db.lookup_trunk_did(caller_did)
    if trunk_did_data and tostring(trunk_did_data.trunk_id) == tostring(trunk_id) then
        validated_caller_did = caller_did
        caller_did_owned = true
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
-- Trunk calls use carrier_primary (Dallas, same carrier as all products)
local gateway = "carrier_primary"

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
-- ("" is truthy in Lua — guard it explicitly so an empty PBX caller ID falls
-- back to the trunk DID, matching the effective_caller_id branch above)
session:setVariable("sip_h_X-Original-CID", (original_cid ~= "" and original_cid) or outbound_did_10)

-- Diversion header: indicates the call originated from a trunk DID
session:setVariable("sip_h_Diversion",
    "<sip:" .. outbound_did_10 .. "@" .. external_sip_ip .. ">;reason=unconditional")

-- ================================================================
-- STIR/SHAKEN attestation (carrier-bound) — Phase 2 Task 2.1
-- ================================================================
-- Kamailio route[TO_CARRIER] reads X-Attestation ∈ {A,B,div} to choose the
-- SHAKEN signing level, then strips it before relaying to Bandwidth (see
-- kamailio.cfg "Step 8.5"). A trunk call is ORIGINATION (not diversion): attest
-- A only when we own the presented calling number (caller_did_owned — the DID
-- ownership check passed), otherwise B. Degrade safely to B if the check was
-- indeterminate. Trunk does NOT echo X-In-Identity: an originated outbound call
-- has no inbound carrier Identity to chain.
--
-- Set as a session variable (like sip_h_Diversion / sip_h_X-Original-CID above)
-- so mod_sofia emits it on the outbound INVITE and it is present on BOTH the
-- primary and the secondary/failover carrier bridge attempts below without
-- editing either dial string.
local stir_attest = caller_did_owned and "A" or "B"
session:setVariable("sip_h_X-Attestation", stir_attest)

-- STIR/SHAKEN (docker/kamailio/CLAUDE.md §8.13): Kamailio OWNS the Identity
-- header at every egress. mod_sofia would otherwise emit this channel's
-- inherited `sip_h_identity` TWICE on the bridged B-leg (the dedicated
-- SIPTAG_IDENTITY_STR path + the generic sip_h_* copy loop). Nothing in
-- these scripts reads it, and X-In-Identity is the SOLE carrier of the
-- inbound Identity chain across the B2BUA, so delete the var before any
-- bridge: an empty value deletes a channel variable
-- (switch_channel_set_variable) and FS variable names are case-insensitive.
-- Belt-and-braces only — Kamailio strips every Identity copy at the border
-- regardless. sip_copy_custom_headers is deliberately untouched.
session:setVariable("sip_h_identity", "")

-- ================================================================
-- STIR/SHAKEN CDR facts (T3) — record RAW facts only, never derive.
-- ================================================================
-- Same contract as inbound_router.lua's RCF carrier branch: these A-leg channel
-- variables serialize verbatim into the posted CDR JSON (mod_json_cdr includes
-- ALL channel vars) and are read by /v1/cdrs/ingest. A trunk call is
-- ORIGINATION, not diversion:
--   stir_attest_intent  = the X-Attestation we set (A when we own the presented
--                         calling number, else B).
--   stir_inbound_signed = "0" ALWAYS — an originated outbound trunk call has no
--                         inbound carrier Identity to chain (trunk never echoes
--                         X-In-Identity; see the attestation comment above).
--   stir_verstat/_source = the inbound X-Verstat/-Source if any (normally empty
--                         for an originated call — there is no inbound carrier
--                         leg — but read defensively for a uniform CDR shape).
--   stir_inbound_attest = the inbound caller attestation (A/B/C) if any (also
--                         normally empty for an originated trunk call — no
--                         inbound carrier leg carries P-Attestation-Indicator —
--                         but read for the same uniform CDR shape).
-- Additive + fail-safe: setting a channel var can never fail the call.
set_var("stir_attest_intent", stir_attest)
set_var("stir_inbound_signed", "0")
set_var("stir_verstat", get_var("sip_h_X-Verstat", ""))
set_var("stir_verstat_source", get_var("sip_h_X-Verstat-Source", ""))
set_var("stir_inbound_attest", get_var("sip_h_X-Inbound-Attest", ""))

freeswitch.consoleLog("INFO", string.format(
    "[trunk_outbound] CID setup: outbound_cid=%s effective_cid=%s original_pbx=%s attest=%s\n",
    outbound_did_10, original_cid or outbound_did_10, caller_id, stir_attest
))

-- ================================================================
-- Media anchoring and early media (ringback) configuration
-- ================================================================
-- Same as RCF: FS must stay in the RTP media path (B2BUA mode).
-- proxy_media=true keeps FS in the path with codec passthrough.
set_var("proxy_media", "true")
set_var("ringback", "%(2000,4000,440,480)")
set_var("transfer_ringback", "%(2000,4000,440,480)")

-- disable_soa on the A-leg session: CRITICAL for carrier interop.
-- The SOA engine reads this variable from the A-leg session context,
-- NOT from the B-leg channel variables set in the bridge {} block.
-- Setting it here ensures FS does not run SDP offer/answer processing
-- sip_enable_soa=false disables SDP Offer/Answer engine. Must be exported.
-- sip_enable_soa=false is in B-leg bridge string only

-- Build dial string using external profile to ensure public IP in Via/Contact/SDP.
-- X-Carrier tells Kamailio which Bandwidth IP to route to.
local dial_string = string.format(
    "{ignore_early_media=false,sip_enable_soa=false,progress_timeout=%d,call_timeout=60,sip_h_X-Carrier=primary" ..
    ",sip_h_X-CID=%s" ..
    ",sip_session_timeout=1800,sip_minimum_session_expires=90,enable_timer=true}sofia/external/%s@" .. sbc_proxy_ip .. ":5060",
    bridge_progress_timeout,
    sip_call_id,
    normalized_dest  -- full +E.164 (KEEP the '+' — preserves country code; matches RCF)
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

-- RFC 4028 session timers: export to B-leg so mod_sofia includes
-- Session-Expires and Min-SE in the outbound INVITE.
-- CRITICAL: set_var() only sets on the A-leg. export via session:execute
-- marks the variable for propagation to the B-leg channel.
-- Belt-and-suspenders: these are also included in the bridge {} blocks.
pcall(function() session:execute("export", "sip_session_timeout=1800") end)
pcall(function() session:execute("export", "sip_minimum_session_expires=90") end)
pcall(function() session:execute("export", "enable_timer=true") end)

-- Execute bridge
stir_outcome_reset()
pcall(function()
    session:execute("bridge", dial_string)
end)
stir_outcome_capture(uuid, "primary")

-- Check if bridge succeeded. originate_disposition is the authoritative
-- FreeSWITCH variable: "SUCCESS" on a connected bridge, a failure cause
-- (USER_BUSY, NO_ROUTE_DESTINATION, RECOVERY_ON_TIMER_EXPIRE, ...) otherwise.
-- (bridge_result is NOT a real channel variable and must never be trusted.)
local disposition = get_var("originate_disposition", "")
local last_bridge_hangup = get_var("last_bridge_hangup_cause", disposition)

if disposition ~= "SUCCESS" and session:ready() then
    freeswitch.consoleLog("WARNING", string.format(
        "[%s] Primary bridge failed: disposition=%s cause=%s\n",
        uuid, disposition, last_bridge_hangup
    ))

    -- Try failover carrier (secondary = LA)
    freeswitch.consoleLog("INFO", "[" .. uuid .. "] Trying secondary carrier (LA)\n")
    set_var("carrier_used", "carrier_secondary")

    local failover_dial = string.format(
        "{ignore_early_media=false,sip_enable_soa=false,progress_timeout=%d,call_timeout=60,sip_h_X-Carrier=secondary" ..
        ",sip_h_X-CID=%s" ..
        ",sip_session_timeout=1800,sip_minimum_session_expires=90,enable_timer=true}sofia/external/%s@" .. sbc_proxy_ip .. ":5060",
        bridge_progress_timeout,
        sip_call_id,
        normalized_dest  -- full +E.164 (KEEP the '+' — preserves country code)
    )

    stir_outcome_reset()
    pcall(function()
        session:execute("bridge", failover_dial)
    end)
    stir_outcome_capture(uuid, "secondary")

    -- Re-check after failover
    disposition = get_var("originate_disposition", "")
    last_bridge_hangup = get_var("last_bridge_hangup_cause", disposition)
end

-- If all bridges failed, return 503 (DID was found, carrier unreachable)
if disposition ~= "SUCCESS" then
    freeswitch.consoleLog("WARNING", string.format(
        "[%s] All bridges failed for trunk %s -> %s (disposition=%s last_cause=%s)\n",
        uuid, trunk_id, normalized_dest, disposition, last_bridge_hangup
    ))
    hangup("NORMAL_TEMPORARY_FAILURE",
        "[" .. uuid .. "] Trunk bridge failed, returning 503 (carrier unreachable)")
    return
end

freeswitch.consoleLog("INFO", "[" .. uuid .. "] Trunk outbound complete\n")
