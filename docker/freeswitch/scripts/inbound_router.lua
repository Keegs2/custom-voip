-- Inbound Call Router - THIN DISPATCHER
-- Handles RCF, API DID, Trunk DID and UCaaS extension routing.
--
-- Call Flow:
-- 1. Get call details from session
-- 2. Normalize DID to E.164
-- 3. Lookup DID cascade: RCF -> API -> Trunk -> UCaaS extension (PostgreSQL)
-- 4. Build a routing context (ctx) and dispatch to the matching handler:
--      rcf   -> handlers/rcf.lua
--      api   -> handlers/api_voice.lua (TwiML engine, via session:execute lua)
--      trunk -> handlers/trunk.lua
--      ucaas -> handlers/ucaas.lua
--    (Redis fraud/velocity/cache removed in RCF-V1 — see note below)
--
-- This file used to contain every product's bridge logic inline. Phase 2 split
-- those branches into handlers/ and the shared bridge plumbing into lib/
-- (sbc, dialstring, caller_id, session_timer). This dispatcher only resolves
-- the DID and hands a context to the right handler — ZERO behavior change.
--
-- Error Handling:
-- - All lookups wrapped in pcall
-- - Graceful fallbacks for service failures
-- - Detailed logging for troubleshooting

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

-- Load a product handler from handlers/. Same proven loadfile() pattern as
-- load_module (CLAUDE.md gotcha #10) but rooted at scripts/handlers/. Each
-- handler module returns a `function(ctx)` the dispatcher calls.
local function load_handler(name)
    local path = "/usr/local/freeswitch/scripts/handlers/" .. name .. ".lua"
    local func, err = loadfile(path)
    if not func then
        freeswitch.consoleLog("ERR", "[inbound_router] Failed to load handler " .. name .. ": " .. tostring(err) .. "\n")
        return nil
    end
    local ok, result = pcall(func)
    if not ok then
        freeswitch.consoleLog("ERR", "[inbound_router] Failed to execute handler " .. name .. ": " .. tostring(result) .. "\n")
        return nil
    end
    return result
end

-- ================================================================
-- Redis caching/velocity/fraud checks REMOVED in RCF-V1
-- ================================================================
-- The redis-lua library has connection pooling issues inside
-- mod_lua's threading model that caused intermittent call failures.
-- The Redis-backed RCF route cache, caller-prefix fraud check, and
-- CPM/daily velocity limiting were removed from this script — calls
-- route via PostgreSQL lookup only. Re-adding Redis here requires a
-- synchronous client that is safe under mod_lua threading; see git
-- history for the old code paths.
freeswitch.consoleLog("DEBUG", "[inbound_router] redis=DISABLED (RCF-V1), loading db_client\n")
local db = load_module("db_client")
if not db then
    freeswitch.consoleLog("ERR", "[inbound_router] db_client failed to load — DID lookups will fail\n")
else
    freeswitch.consoleLog("DEBUG", "[inbound_router] Modules loaded (db_client ready)\n")
end

-- E.164 normalization helpers — single source of truth in lib/e164.lua
-- (replaces the formerly-inline normalize_did / to_10digit copies).
local e164 = load_module("e164")
if not e164 then
    freeswitch.consoleLog("ERR", "[inbound_router] e164 failed to load — number normalization will fail\n")
end

-- Shared bridge plumbing extracted in Phase 2 (behavior-preserving). These are
-- passed to the product handlers via ctx so each handler builds identical dial
-- strings / headers / session-timer exports as the prior inline code.
--   sbc          : TCP reachability pre-check + 4-attempt SBC×carrier failover loop
--   dialstring   : sofia/external/<dest>@<proxy>:5060 builder
--   caller_id    : Diversion / Remote-Party-ID header-value formatters
--   session_timer: RFC 4028 BRIDGE_OPTS fragment + B-leg export()
local sbc = load_module("sbc")
local dialstring = load_module("dialstring")
local caller_id = load_module("caller_id")
local session_timer = load_module("session_timer")

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

-- Environment-based IPs for multi-VM deployment
-- These replace hardcoded IPs so each VM gets the correct addresses
local external_sip_ip = os.getenv("EXTERNAL_SIP_IP") or "auto"
local sbc_proxy_ip = os.getenv("SBC_PROXY_IP") or "127.0.0.1"
local sbc_proxy_ip_failover = os.getenv("SBC_PROXY_IP_FAILOVER") or sbc_proxy_ip

-- Per-attempt progress timeout in seconds (progress_timeout on each failover
-- attempt). Fails the attempt only if NO provisional response (180/183)
-- arrives from the carrier within N seconds — once ringing starts, the call
-- may ring up to the normal call_timeout. Fast-failover knob for a
-- dead-but-TCP-alive SBC or unresponsive carrier (bounds PDD). Tunable via
-- BRIDGE_PROGRESS_TIMEOUT in /opt/revup/.env (passed through
-- docker-compose.media.yml). Default 10 per CLAUDE.md.
local bridge_progress_timeout = tonumber(os.getenv("BRIDGE_PROGRESS_TIMEOUT") or "")
if not bridge_progress_timeout or bridge_progress_timeout < 1 then
    bridge_progress_timeout = 10
end
bridge_progress_timeout = math.floor(bridge_progress_timeout)

-- The SBC TCP health pre-check + reachability cache + 4-attempt failover loop
-- now live in lib/sbc.lua (loaded above). They were inline here before Phase 2.

-- Get call details
local uuid = get_var("uuid", "unknown")
local did = get_var("destination_number", "")
local caller_id_number = get_var("caller_id_number", "")
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
local original_caller_number = caller_id_number
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
    "[%s] Inbound: DID=%s CallerID=%s IP=%s\n",
    uuid, did, caller_id_number, source_ip
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

-- E.164 helpers now live in lib/e164.lua (single source of truth). Bind locals
-- so the rest of this script (and the normalization characterization tests)
-- reference the same names as before, byte-for-byte equivalent behavior.
local to_10digit = e164.to_10digit
local normalize_did = e164.normalize_did

local normalized_did = normalize_did(did)
freeswitch.consoleLog("DEBUG", "[" .. uuid .. "] Normalized DID: " .. normalized_did .. "\n")

-- ============================================
-- STEP 1: DID Lookup - RCF, API, Trunk or UCaaS Extension
-- ============================================
-- (Caller-prefix fraud check removed with Redis in RCF-V1 — see note at top.)
local product_type = nil
local customer_id = nil
local forward_to = nil
local traffic_grade = "standard"
local ring_timeout = 30
local voice_url = nil
local fallback_url = nil
local trunk_id = nil
local pass_caller_id = true

-- Try RCF lookup (PostgreSQL)
local function lookup_rcf()
    if db then
        local rcf_db = db.lookup_rcf(normalized_did)
        if rcf_db then
            freeswitch.consoleLog("DEBUG", "[" .. uuid .. "] RCF DB hit\n")

            return {
                product_type = "rcf",
                customer_id = tonumber(rcf_db.customer_id),
                forward_to = rcf_db.forward_to,
                traffic_grade = rcf_db.traffic_grade or "standard",
                cpm_limit = tonumber(rcf_db.cpm_limit) or 60,
                daily_limit = tonumber(rcf_db.daily_limit) or 500,
                pass_caller_id = rcf_db.pass_caller_id == "t" or rcf_db.pass_caller_id == true,
                ring_timeout = tonumber(rcf_db.ring_timeout) or 30,
                max_channels = tonumber(rcf_db.max_channels) or 0,
                rcf_name = rcf_db.name or nil,
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
            fallback_url = api_did.fallback_url,
            -- Per-customer webhook signing secret (api_dids JOIN customers).
            -- Empty string / nil means "unsigned" — the engine warns and POSTs unsigned.
            webhook_signing_secret = api_did.webhook_signing_secret
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

-- Try UCaaS Extension DID lookup
-- If the DID is assigned to a user extension, route the call to that extension.
-- Placed LAST in the cascade (after RCF/API/Trunk) so revenue-generating
-- products keep priority and existing rcf/api/trunk DID resolution is unchanged
-- — extensions live in their own table (extensions.assigned_did), disjoint from
-- rcf_numbers / api_dids / trunk_dids, so this only matches DIDs that no earlier
-- lookup claimed.
local function lookup_extension_did()
    if not db then return nil end

    local ext_did = db.lookup_extension_did(normalized_did)
    if ext_did then
        freeswitch.consoleLog("DEBUG", "[" .. uuid .. "] UCaaS Extension DID hit: ext=" .. tostring(ext_did.extension) .. "\n")
        return {
            product_type = "ucaas",
            customer_id = tonumber(ext_did.customer_id),
            extension = ext_did.extension,
            display_name = ext_did.display_name,
            -- ring_plan: parsed find-me/follow-me plan (Lua table) or nil. When
            -- present, handlers/ucaas.lua runs the multi-leg ring; when nil it
            -- keeps the legacy single-extension bridge (backward compatible).
            -- db_client.lookup_extension_did already parsed the JSONB and
            -- guarantees this is either a well-formed table or nil.
            ring_plan = ext_did.ring_plan
        }
    end

    return nil
end

freeswitch.consoleLog("DEBUG", "[" .. uuid .. "] STEP 1: DID lookup for " .. tostring(normalized_did) .. "\n")
-- Execute lookups in order: RCF -> API -> Trunk -> UCaaS Extension
-- Revenue-generating products (RCF, API, Trunk) take priority over UCaaS
-- extensions; the extension lookup only runs when no earlier lookup matched.
local routing = lookup_rcf()
if not routing then
    routing = lookup_api_did()
end
if not routing then
    routing = lookup_trunk_did()
end
if not routing then
    routing = lookup_extension_did()
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

freeswitch.consoleLog("DEBUG", "[" .. uuid .. "] Routing found: type=" .. tostring(routing.product_type) .. "\n")
-- Extract routing data
product_type = routing.product_type
customer_id = routing.customer_id
forward_to = routing.forward_to
traffic_grade = routing.traffic_grade or "standard"
pass_caller_id = routing.pass_caller_id
ring_timeout = routing.ring_timeout or 30
voice_url = routing.voice_url
fallback_url = routing.fallback_url
local webhook_signing_secret = routing.webhook_signing_secret
trunk_id = routing.trunk_id

freeswitch.consoleLog("DEBUG", string.format(
    "[%s] Extracted: type=%s customer=%s trunk=%s grade=%s\n",
    uuid, tostring(product_type), tostring(customer_id), tostring(trunk_id), tostring(traffic_grade)
))

-- Set channel variables for CDR and downstream processing
set_var("customer_id", tostring(customer_id))
set_var("product_type", product_type)
set_var("traffic_grade", traffic_grade)
if trunk_id then
    set_var("trunk_id", tostring(trunk_id))
end

-- (Velocity/CPM rate limiting removed with Redis in RCF-V1 — see note at top.
--  Per-DID concurrent call limits still apply in handlers/rcf.lua via mod_hash.)

-- ============================================
-- STEP 2: Dispatch Based on Product Type
-- ============================================

-- Helper: Get domain for local routing (used by rcf local-forward + ucaas).
local function get_domain()
    local domain = get_var("domain", nil)
    if not domain then
        domain = os.getenv("DOMAIN") or "voiceplatform.local"
    end
    return domain
end

-- Routing context handed to every handler. Carries the session + helpers, the
-- resolved routing data, env-derived addressing, the e164 helpers, and the
-- shared lib modules. Handlers read only what they need.
local ctx = {
    session = session,
    get_var = get_var,
    set_var = set_var,
    hangup = hangup,
    db = db,

    uuid = uuid,
    normalized_did = normalized_did,
    caller_id_number = caller_id_number,
    original_caller_number = original_caller_number,
    original_caller_name = original_caller_name,

    routing = routing,
    product_type = product_type,
    customer_id = customer_id,
    forward_to = forward_to,
    traffic_grade = traffic_grade,
    ring_timeout = ring_timeout,
    pass_caller_id = pass_caller_id,
    trunk_id = trunk_id,

    to_10digit = to_10digit,
    normalize_did = normalize_did,

    external_sip_ip = external_sip_ip,
    sbc_proxy_ip = sbc_proxy_ip,
    sbc_proxy_ip_failover = sbc_proxy_ip_failover,
    bridge_progress_timeout = bridge_progress_timeout,

    get_domain = get_domain,

    sbc = sbc,
    dialstring = dialstring,
    caller_id = caller_id,
    session_timer = session_timer,
}

freeswitch.consoleLog("DEBUG", "[" .. uuid .. "] STEP 2: Dispatching product_type=" .. tostring(product_type) .. "\n")

if product_type == "rcf" then
    -- Remote Call Forwarding -> handlers/rcf.lua
    local handler = load_handler("rcf")
    if handler then
        handler(ctx)
    else
        freeswitch.consoleLog("ERR", "[" .. uuid .. "] rcf handler unavailable — rejecting\n")
        hangup("NORMAL_TEMPORARY_FAILURE")
    end

elseif product_type == "api" then
    -- API Calling - Execute webhook-driven voice control via handlers/api_voice.lua
    -- API product routes via primary carrier (same as all products in 2-carrier model)
    -- traffic_grade is used as a secondary factor for priority within the same trunk
    freeswitch.consoleLog("INFO", string.format(
        "[inbound_router] Routing via carrier_primary (product: api, traffic_grade: %s)\n",
        traffic_grade
    ))
    set_var("carrier_gateway", "carrier_primary")

    if voice_url then
        set_var("voice_url", voice_url)
        if fallback_url then
            set_var("fallback_url", fallback_url)
        end
        -- Pass the per-customer webhook signing secret to the TwiML engine so it
        -- can add X-Revup-Signature to every outbound webhook POST/GET.
        if webhook_signing_secret and webhook_signing_secret ~= "" then
            set_var("webhook_signing_secret", webhook_signing_secret)
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

        -- Execute the webhook engine script (handlers/api_voice.lua — the TwiML
        -- engine; handles the full TwiML-compatible XML fetch/parse/execute loop)
        pcall(function()
            session:execute("lua", "handlers/api_voice.lua")
        end)
    else
        freeswitch.consoleLog("ERR", "[" .. uuid .. "] API DID has no voice_url configured — rejecting\n")
        hangup("NORMAL_TEMPORARY_FAILURE")
    end

elseif product_type == "ucaas" then
    -- UCaaS Extension DID -> handlers/ucaas.lua
    local handler = load_handler("ucaas")
    if handler then
        handler(ctx)
    else
        freeswitch.consoleLog("ERR", "[" .. uuid .. "] ucaas handler unavailable — rejecting\n")
        hangup("NORMAL_TEMPORARY_FAILURE")
    end

elseif product_type == "trunk" then
    -- SIP Trunk inbound -> handlers/trunk.lua
    local handler = load_handler("trunk")
    if handler then
        handler(ctx)
    else
        freeswitch.consoleLog("ERR", "[" .. uuid .. "] trunk handler unavailable — rejecting\n")
        hangup("NORMAL_TEMPORARY_FAILURE")
    end
end

freeswitch.consoleLog("INFO", "[" .. uuid .. "] Inbound routing complete\n")
