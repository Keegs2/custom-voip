-- Inbound Call Router - High Performance Implementation
-- Handles RCF, API DID, and Trunk DID routing
--
-- Call Flow:
-- 1. Get call details from session
-- 2. Normalize DID to E.164
-- 3. Lookup DID: RCF -> API DID -> Trunk DID (PostgreSQL)
-- 4. Route based on product type
--    (Redis fraud/velocity/cache removed in RCF-V1 — see note below)
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

-- Canonical phone-number normalizer shared across the switch (Lua), API
-- (Python utils/phone.py) and UI (TS utils/phone.ts). See number_utils.lua for
-- the spec + test vectors. normalize_did()/to_10digit() below delegate to it so
-- there is ONE implementation on the call path.
local number_utils = load_module("number_utils")
if not number_utils then
    freeswitch.consoleLog("ERR", "[inbound_router] number_utils failed to load — falling back to legacy inline normalization\n")
end

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

-- ================================================================
-- SBC TCP health pre-check with cross-call result caching
-- ================================================================
-- A TCP connect to the SBC on :5060 detects a dead SBC in <1 second
-- instead of waiting for the SIP timeout (10-32 seconds). Probing on
-- every bridge attempt of every call costs up to 4 socket opens (and
-- up to 4s of probe latency worst case) per call, so probe results
-- are cached process-wide in FreeSWITCH global variables
-- (freeswitch.get/setGlobalVariable — shared across all mod_lua
-- sessions and safe under mod_lua threading).
--
-- Cache entry: "sbc_health_<ip>" = "<up|down>:<epoch>"
--   "up"   trusted for 30s (healthy SBC probed at most ~2x/minute)
--   "down" trusted for 10s (a recovered SBC comes back fast)
-- On expiry the next call re-probes and refreshes the entry. Only
-- the probe is cached — the 4-attempt failover loop is unchanged.
local SBC_HEALTH_UP_TTL = 30
local SBC_HEALTH_DOWN_TTL = 10

local luasocket_warned = false  -- warn once per call, not once per attempt

-- Raw TCP probe. Returns true/false, or nil if luasocket is unavailable
-- (unknown — caller fails open and the result is NOT cached).
local function sbc_tcp_probe(ip, port)
    local ok, socket = pcall(require, "socket")
    if not ok then
        -- A broken/missing luasocket silently disables the fast-failover
        -- pre-check. Make it visible instead of failing open silently.
        if not luasocket_warned then
            freeswitch.consoleLog("WARNING", string.format(
                "[inbound_router] luasocket unavailable (%s) — SBC TCP pre-check disabled, failing open\n",
                tostring(socket)
            ))
            luasocket_warned = true
        end
        return nil
    end
    local tcp = socket.tcp()
    tcp:settimeout(1)
    local result = tcp:connect(ip, port or 5060)
    tcp:close()
    return result ~= nil
end

local function is_sbc_reachable(ip, port)
    local cache_key = "sbc_health_" .. ip
    local now = os.time()

    -- Check cache
    local cached_status, cached_ts = nil, nil
    local cached = freeswitch.getGlobalVariable(cache_key)
    if cached and cached ~= "" then
        local status, ts = cached:match("^(%a+):(%d+)$")
        cached_status = status
        cached_ts = tonumber(ts)
    end

    if cached_status and cached_ts then
        local ttl = (cached_status == "up") and SBC_HEALTH_UP_TTL or SBC_HEALTH_DOWN_TTL
        local age = now - cached_ts
        if age >= 0 and age < ttl then
            freeswitch.consoleLog("DEBUG", string.format(
                "[inbound_router] SBC health cache hit: %s is %s (age=%ds)\n",
                ip, cached_status, age
            ))
            return cached_status == "up"
        end
    end

    -- Cache miss or expired: do the real TCP probe and refresh
    local probe = sbc_tcp_probe(ip, port)
    if probe == nil then
        return true  -- luasocket unavailable: fail open, do not cache
    end

    local new_status = probe and "up" or "down"
    if cached_status and cached_status ~= new_status then
        freeswitch.consoleLog("INFO", string.format(
            "[inbound_router] SBC %s health transition: %s -> %s\n",
            ip, cached_status, new_status
        ))
    elseif not cached_status and new_status == "down" then
        freeswitch.consoleLog("INFO", string.format(
            "[inbound_router] SBC %s health: down (first probe)\n", ip
        ))
    end
    freeswitch.setGlobalVariable(cache_key, string.format("%s:%d", new_status, now))
    return probe
end

-- ================================================================
-- Table-driven termination trunks (carrier_trunks) with caching
-- ================================================================
-- RCF PSTN termination attempts are built from the operator-managed
-- carrier_trunks table (TED tool) instead of the hardcoded
-- {SBC-1,SBC-2} x {primary,secondary} matrix, so enabling/disabling/
-- reprioritizing a trunk changes live routing within ~a minute — no
-- redeploy. Selection SQL (db_client.get_termination_trunks):
--
--   SELECT carrier, pop, host(source_ip) AS term_ip,
--          COALESCE(priority_<zone>, priority) AS eff_priority
--   FROM carrier_trunks
--   WHERE direction IN ('outbound','both') AND enabled = true
--   ORDER BY eff_priority, id
--
-- Results are cached PROCESS-WIDE in a FreeSWITCH global variable
-- (freeswitch.get/setGlobalVariable — the exact SBC-health-cache
-- pattern above) for TERM_TRUNKS_TTL seconds: within the TTL no call
-- touches the DB; steady state is ~1 query/minute per FS.
-- Cache entry: "term_trunks_<zone>" = "<epoch>|carrier,pop,ip;..."
-- ("<epoch>|FALLBACK" is the negative-cache sentinel: DB error or
-- zero rows, re-checked after the same TTL).
--
-- FAIL-OPEN (non-negotiable): DB error, zero usable rows, or an
-- unparsable cache entry all return nil, and the caller runs the
-- EXACT legacy hardcoded attempt loop (env primary/secondary SBC IPs
-- + X-Carrier enum header) — table-driven routing can never break
-- termination on a DB blip. The caller records the decision in the
-- term_trunks_source channel variable (db|fallback) which lands in
-- the CDR variables (same plain-channel-var path as inbound_carrier).
local TERM_TRUNKS_TTL = 60
-- Cap at 4 trunks (x 2 SBCs = 8 bridge attempts) to bound worst-case
-- PDD across a fully-failing attempt sweep.
local TERM_TRUNKS_MAX = 4

-- Deployment zone selects the per-zone priority override column
-- (priority_east/west/central). Validated against the closed set;
-- anything else WARNs and falls back to east. Operator step: West and
-- Central .env must set FS_ZONE=west / FS_ZONE=central.
local fs_zone = os.getenv("FS_ZONE") or "east"
if fs_zone ~= "east" and fs_zone ~= "west" and fs_zone ~= "central" then
    freeswitch.consoleLog("WARNING", string.format(
        "[inbound_router] FS_ZONE '%s' is not east/west/central — using east\n",
        tostring(fs_zone)))
    fs_zone = "east"
end

-- Sanitize a carrier/pop token for cache/dial-string/header safety:
-- keep [A-Za-z0-9_.-] only. Row values are admin-provisioned closed
-- vocabulary (TED), so this is belt-and-suspenders, not lossy.
local function term_token(s)
    return tostring(s or ""):gsub("[^%w%._%-]", "")
end

-- Parse the serialized cache payload back into the trunk list.
-- Any malformed segment invalidates the WHOLE payload (nil) — never
-- bridge from a half-parsed trunk list.
local function parse_term_trunks(payload)
    local trunks = {}
    for seg in payload:gmatch("[^;]+") do
        local carrier, pop, ip = seg:match("^([%w%._%-]+),([%w%._%-]*),(%d+%.%d+%.%d+%.%d+)$")
        if not carrier then
            return nil
        end
        trunks[#trunks + 1] = { carrier = carrier, pop = pop, term_ip = ip }
    end
    if #trunks == 0 then
        return nil
    end
    return trunks
end

-- get_termination_trunks(zone): ordered trunk list from carrier_trunks,
-- or nil => the caller MUST use the legacy hardcoded fallback attempts.
local function get_termination_trunks(zone)
    local cache_key = "term_trunks_" .. zone
    local now = os.time()

    -- Cache check — fresh entries (TTL 60s) never touch the DB.
    local cached = freeswitch.getGlobalVariable(cache_key)
    if cached and cached ~= "" then
        local ts, payload = cached:match("^(%d+)|(.+)$")
        ts = tonumber(ts)
        if ts and payload then
            local age = now - ts
            if age >= 0 and age < TERM_TRUNKS_TTL then
                if payload == "FALLBACK" then
                    return nil  -- negative-cached miss; re-fetch after TTL
                end
                local trunks = parse_term_trunks(payload)
                if trunks then
                    return trunks
                end
                -- Unparsable cache: fail open NOW; negative-cache so the
                -- next post-TTL fetch rebuilds it cleanly.
                freeswitch.consoleLog("WARNING", string.format(
                    "[inbound_router] term_trunks cache unparsable for zone %s — using legacy fallback attempts\n",
                    zone))
                freeswitch.setGlobalVariable(cache_key, string.format("%d|FALLBACK", now))
                return nil
            end
        end
    end

    -- Cache miss/expired: one DB fetch via db_client (same connection and
    -- error style as the DID lookups).
    local rows = nil
    if db and db.get_termination_trunks then
        local ok, res = pcall(function() return db.get_termination_trunks(zone) end)
        if ok then
            rows = res
        else
            freeswitch.consoleLog("ERR", string.format(
                "[inbound_router] get_termination_trunks(%s) raised: %s\n",
                zone, tostring(res)))
        end
    end

    if type(rows) ~= "table" then
        -- DB error (or db_client unavailable): FAIL OPEN. Negative-cache so
        -- a sustained outage costs ~1 failed query/minute, not one per call.
        freeswitch.consoleLog("WARNING", string.format(
            "[inbound_router] carrier_trunks lookup failed for zone %s — using legacy fallback attempts\n",
            zone))
        freeswitch.setGlobalVariable(cache_key, string.format("%d|FALLBACK", now))
        return nil
    end

    -- Validate + serialize. Rows with an empty carrier or non-IPv4 term_ip
    -- are dropped (WARN); rows beyond TERM_TRUNKS_MAX are ignored (WARN).
    local parts = {}
    local capped = false
    for _, row in ipairs(rows) do
        local carrier = term_token(row.carrier)
        local pop = term_token(row.pop)
        local ip = tostring(row.term_ip or "")
        if carrier == "" or not ip:match("^%d+%.%d+%.%d+%.%d+$") then
            freeswitch.consoleLog("WARNING", string.format(
                "[inbound_router] carrier_trunks row carrier=%s pop=%s term_ip=%s is unusable — skipped\n",
                tostring(row.carrier), tostring(row.pop), ip))
        elseif #parts >= TERM_TRUNKS_MAX then
            if not capped then
                freeswitch.consoleLog("WARNING", string.format(
                    "[inbound_router] carrier_trunks returned more than %d outbound rows for zone %s — extra rows ignored (8-attempt cap)\n",
                    TERM_TRUNKS_MAX, zone))
                capped = true
            end
        else
            parts[#parts + 1] = carrier .. "," .. pop .. "," .. ip
        end
    end

    if #parts == 0 then
        -- Zero usable rows: FAIL OPEN to the legacy attempts.
        freeswitch.consoleLog("WARNING", string.format(
            "[inbound_router] no enabled outbound carrier_trunks rows for zone %s — using legacy fallback attempts\n",
            zone))
        freeswitch.setGlobalVariable(cache_key, string.format("%d|FALLBACK", now))
        return nil
    end

    local payload = table.concat(parts, ";")
    freeswitch.setGlobalVariable(cache_key, string.format("%d|%s", now, payload))
    -- Return by re-parsing what was serialized, so cached and fresh calls
    -- yield the identical validated shape.
    return parse_term_trunks(payload)
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
    "[%s] Inbound: DID=%s CallerID=%s IP=%s\n",
    uuid, did, caller_id, source_ip
))
freeswitch.consoleLog("INFO", string.format(
    "[%s] Original caller preserved: number=%s name=%s\n",
    uuid, original_caller_number, original_caller_name
))

-- ================================================================
-- Inbound carrier attribution (CDR): which carrier/PoP originated
-- this call. Kamailio stamps X-Inbound-Carrier / X-Inbound-PoP on the
-- carrier-ingress INVITE (spoof-proofed at the SBC: any wire-supplied
-- copies are stripped before Kamailio appends its own verdict from the
-- verified source IP — static match for Bandwidth/Sinch, carrier_trunks
-- row for DB-admitted carriers). Set EARLY, before DID validation, so
-- EVERY CDR — including UNALLOCATED_NUMBER rejects — carries the
-- attribution. Plain channel variables are all that is needed for the
-- CDR: mod_json_cdr serializes A-leg variables.* and the ingest reads
-- them from there (same path as traffic_grade / product_type).
-- Defaults when the headers are absent (pre-Sinch SBC image, or direct
-- test traffic): carrier "bandwidth", pop "" — preserving the
-- historical meaning of existing CDRs (everything was Bandwidth).
local inbound_carrier = (get_var("sip_h_X-Inbound-Carrier", "bandwidth"):match("^%s*(.-)%s*$") or "")
if inbound_carrier == "" then inbound_carrier = "bandwidth" end
local inbound_carrier_pop = (get_var("sip_h_X-Inbound-PoP", ""):match("^%s*(.-)%s*$") or "")
set_var("inbound_carrier", inbound_carrier)
set_var("inbound_carrier_pop", inbound_carrier_pop)
freeswitch.consoleLog("DEBUG", string.format(
    "[%s] Inbound carrier attribution: carrier=%s pop=%s\n",
    uuid, inbound_carrier, inbound_carrier_pop
))

-- Validate DID
if did == "" then
    hangup("UNALLOCATED_NUMBER", "[" .. uuid .. "] Empty destination - rejecting")
    return
end

-- Convert E.164 or 11-digit number to 10-digit format for carrier delivery.
-- Delegates to the shared number_utils.to_10digit (same semantics). This value
-- feeds ONLY the outbound From / caller-ID that Bandwidth authenticates against.
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

-- Normalize a number to canonical E.164 (with '+', country code preserved).
-- Delegates to the shared number_utils.to_e164 (the ONE cross-language impl).
--
-- CONTRACT: this wrapper is NON-nil — it is used both to normalize the inbound
-- DID / forward_to (belt-and-suspenders; db_client canonicalizes the lookup key
-- too) AND in caller-ID composition (masking_e164, e164_original_cid,
-- e164_did), where a nil would break string concatenation and DROP THE LIVE
-- CALL. So on a strict-spec failure we fall back to the previous lenient
-- inline behavior instead of returning nil. Routing correctness rides on the
-- canonical to_e164 (and the db_client lookup-key canonicalization); this
-- fallback only protects malformed caller-ID from crashing an otherwise-valid
-- call.
local function normalize_did(number)
    if number_utils then
        local canon = number_utils.to_e164(number)
        if canon then
            return canon
        end
        -- to_e164 rejected it (returned nil) — fall through to legacy lenient.
    end

    -- Legacy lenient normalization (fallback only): never returns nil.
    -- Remove any non-digit characters except +
    local clean = (number or ""):gsub("[^%d+]", "")

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
-- STEP 1: DID Lookup - RCF, API, or Trunk
-- ============================================
-- (Caller-prefix fraud check removed with Redis in RCF-V1 — see note at top.)
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

freeswitch.consoleLog("DEBUG", "[" .. uuid .. "] STEP 1: DID lookup for " .. tostring(normalized_did) .. "\n")
-- RCF-V1: Execute lookups in order: RCF -> API -> Trunk
-- UCaaS extension routing removed — not needed for RCF-only deployment
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

freeswitch.consoleLog("DEBUG", "[" .. uuid .. "] Routing found: type=" .. tostring(routing.product_type) .. "\n")
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
--  Per-DID concurrent call limits still apply below via mod_hash.)

-- ============================================
-- STEP 2: Route Based on Product Type (on-net aware)
-- ============================================
-- On-net (internal) routing: when a forwarded/placed destination is a number
-- this platform OWNS (any product), short-circuit the carrier and deliver the
-- call into that DID's own product handler instead of hairpinning out through
-- Bandwidth and back in. See docs/ONNET_ROUTING_DESIGN.md.
--
-- Structure:
--   * The three product bodies are extracted VERBATIM into named terminators
--     terminate_rcf / terminate_api / terminate_trunk (behavior-preserving for
--     off-net) + a TERMINATORS dispatch map.
--   * `ctx` threads cross-hop state (original caller, composed presented CID,
--     hop counter, visited E.164 set, origin customer, sip_call_id).
--   * terminate_rcf contains the on-net decision at the forward branch point;
--     an RCF chain resolves in-memory (DB lookups only, NO SIP emitted per hop)
--     until a terminal, which emits EXACTLY ONE B-leg (or zero for local/api).

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

-- MAX_HOPS: cap on internal RCF chain depth before hard-reject (design §6).
local MAX_HOPS = 5

-- Hard reject helper (design §6): a resolved-but-unusable on-net destination
-- must fail cleanly with NO carrier fallback. Set lua_routed=true so the
-- dialplan's post-script fallback doesn't mask this with a 404/503.
--   disabled/suspended terminal -> CALL_REJECTED (SIP 603)
--   loop / hop-limit            -> EXCHANGE_ROUTING_ERROR (SIP 483)
local function hard_reject(cause, log_msg)
    set_var("lua_routed", "true")
    hangup(cause, log_msg)
end

-- Normalize a resolved number_routing view row into booleans/numbers the
-- terminators consume. luasql returns everything as strings ('t'/'f'/nil).
local function normalize_dest(row)
    if not row then return nil end
    return {
        did             = row.did,
        product_type    = row.product_type,
        customer_id     = tonumber(row.customer_id),
        product_ref_id  = tonumber(row.product_ref_id),
        product_enabled = (row.product_enabled == "t" or row.product_enabled == true),
        customer_status = row.customer_status,
        forward_to      = row.forward_to,
        pass_caller_id  = (row.pass_caller_id == "t" or row.pass_caller_id == true),
        ring_timeout    = tonumber(row.ring_timeout) or 30,
        max_channels    = tonumber(row.max_channels) or 0,
        product_name    = row.product_name,
        voice_url       = row.voice_url,
        fallback_url    = row.fallback_url,
        trunk_id        = row.trunk_id,
    }
end

-- ================================================================
-- Terminator: RCF  (dest = terminal RCF routing row, ctx = cross-hop state)
-- ================================================================
-- BEHAVIOR-PRESERVING extraction of the original `product_type == "rcf"` body.
-- The only structural change is the shadowed locals at the top, which point the
-- verbatim body at the TERMINAL DID (dest.did) and the composed presented CID
-- (ctx.presented_cid) instead of the module-level inbound-DID/original-caller
-- values. For an off-net single-hop call dest.did == the inbound DID and
-- ctx.presented_cid == original_caller_number, so output is byte-identical.
local function terminate_rcf(dest, ctx)
    -- Shadowed locals: the pasted body below is unchanged and reads these.
    local uuid = ctx.uuid
    local traffic_grade = ctx.traffic_grade
    -- normalized_did is the SELF/terminal DID (drives outbound_caller_id / From
    -- for Bandwidth auth, Diversion, limit-hash key, and all logs).
    local normalized_did = dest.did
    local forward_to = dest.forward_to
    local ring_timeout = tonumber(dest.ring_timeout) or 30
    -- Composed caller-ID identity ("last false hop wins", design §5).
    local pass_caller_id = ctx.pass_effective
    local original_caller_number = ctx.presented_cid
    local original_caller_name = ctx.presented_name
    -- routing.rcf_name / routing.max_channels came off the terminal row.
    local routing = { rcf_name = dest.product_name, max_channels = dest.max_channels }
    -- masking identity (E.164 + 10-digit) used ONLY in the pass=false branches.
    -- For single-hop this equals the terminal DID (byte-identical to before);
    -- for a chain it is the last masking hop's DID carried in presented_cid.
    local masking_e164 = normalize_did(original_caller_number)
    local masking_10 = to_10digit(original_caller_number)

    -- Remote Call Forwarding - Bridge to destination
    -- RCF terminates through the primary carrier (TC4 Dallas).
    -- Kamailio sets X-Inbound-TC header for logging/Homer visibility, but
    -- outbound carrier selection is fixed to TC4 until all trunk groups are
    -- provisioned for our IPs on the Bandwidth side.
    -- To enable trunk-affinity routing later, read X-Inbound-TC and map to carrier:
    --   local inbound_tc = get_var("sip_h_X-Inbound-TC", ""):match("^%s*(.-)%s*$") or ""
    --   if inbound_tc == "tc1" then carrier = "tc1" elseif inbound_tc == "tc2" then carrier = "tc2" end
    local inbound_tc = ctx.inbound_tc or ""

    -- Use the actual SIP Call-ID from the inbound INVITE for X-CID correlation.
    -- The uuid is FreeSWITCH's internal session ID which differs from the SIP Call-ID
    -- that Homer/HEP captures on the A-leg. Using sip_call_id lets us correlate
    -- A-leg and B-leg in Homer. Fallback to uuid if sip_call_id is not set.
    local sip_call_id = ctx.sip_call_id or uuid
    local carrier = "primary"  -- TC4 only — do not change until Bandwidth provisions all TCs
    freeswitch.consoleLog("INFO", string.format(
        "[inbound_router] Routing via carrier=%s (inbound_tc=%s, product: rcf, traffic_grade: %s)\n",
        carrier, inbound_tc, traffic_grade
    ))

    local is_local_test = ctx.is_local_test or "false"
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
    -- Media handling: proxy_media (lightweight RTP relay)
    -- ================================================================
    -- WHY NOT bypass_media:
    --   bypass_media=true takes FS out of the RTP path entirely by
    --   sending re-INVITEs to BOTH legs after answer to swap SDPs so
    --   RTP flows directly between endpoints. This FAILS in our
    --   architecture because:
    --
    --   1. Re-INVITEs from FS go through Kamailio, which rewrites
    --      SDP (replacing private IPs with FS_PUBLIC_IP) and Contact
    --      headers. The SDP swap requires untouched SDP pass-through
    --      which Kamailio's topology hiding breaks.
    --
    --   2. sip_enable_soa=false (needed with bypass_media to avoid
    --      SOA errors on 183+200 double SDP) disables the very SOA
    --      engine that drives the re-INVITE SDP swap. Result: bridge
    --      "succeeds" momentarily but no media path is established,
    --      causing immediate silent disconnect (empty last_cause).
    --
    --   3. Even if re-INVITEs worked, Kamailio's Contact rewriting
    --      (replacing FS Contact with Kamailio's address) would
    --      confuse the endpoint addressing for subsequent requests.
    --
    -- WHY proxy_media:
    --   proxy_media=true keeps FS in the RTP path as a lightweight
    --   relay (no transcoding, just packet forwarding). Both legs
    --   negotiate SDP with FS's public IP. No re-INVITEs needed.
    --   RTP path: Bandwidth-A -> FS -> Bandwidth-B (minimal overhead
    --   since FS just forwards packets without decoding).
    --
    --   SOA stays ENABLED (default), which is required for FS to
    --   set up the B-leg RTP media channel. Bandwidth sends SDP in
    --   both 183 and 200 OK (duplicate answer), but Kamailio's
    --   REPLY_HANDLER strips the 183 SDP body, forwarding it as a
    --   bodyless provisional (like 180 Ringing). The 200 OK SDP
    --   passes through intact as the FIRST and ONLY answer SOA
    --   processes, avoiding the duplicate answer error. FS plays
    --   local ringback (from the ringback variable below) while
    --   waiting for the 200 OK. Do NOT set sip_enable_soa=false —
    --   it disables the SOA engine entirely and FS never sets up
    --   B-leg media.
    --
    -- ringback: local tone while B-leg rings (generated by FS since
    --   FS is in the media path with proxy_media).
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
    -- E.164 versions for SIP identity headers (PAI, RPID, Diversion)
    -- Carriers require +1 prefix per E.164; bare 10-digit leaks into PAI otherwise
    local e164_original_cid = normalize_did(original_caller_number)
    local e164_did = normalize_did(normalized_did)
    if pass_caller_id then
        -- Preserve original caller ID so the called party sees who is calling
        session:setVariable("effective_caller_id_number", outbound_original_cid)
        session:setVariable("effective_caller_id_name", original_caller_name)
    else
        -- Override: called party sees the masking DID, not the original caller
        -- (masking_* == terminal DID for single-hop; == last masking hop for a chain)
        session:setVariable("effective_caller_id_number", masking_10)
        session:setVariable("effective_caller_id_name", masking_10)
    end

    -- Diversion header indicates the call was forwarded and from which number
    session:setVariable("sip_h_Diversion", "<sip:" .. outbound_did .. "@" .. external_sip_ip .. ">;reason=unconditional")

    -- X-Original-CID: Kamailio reads this to build P-Asserted-Identity
    -- Uses E.164 (+1XXXXXXXXXX) format. When pass_caller_id=true, this is the
    -- original caller's number; when false, it's the masking DID.
    if pass_caller_id then
        session:setVariable("sip_h_X-Original-CID", e164_original_cid)
    else
        session:setVariable("sip_h_X-Original-CID", masking_e164)
    end

    -- X-Original-CID-Name: Display name for P-Asserted-Identity
    -- Uses the RCF line name configured in the portal (e.g. "Main Office")
    local rcf_name = routing.rcf_name
    if rcf_name and rcf_name ~= "" then
        session:setVariable("sip_h_X-Original-CID-Name", rcf_name)
    end

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
        -- ext-sip-ip (public IP from EXTERNAL_SIP_IP) in Via, Contact, and SDP.
        -- The internal profile does NOT apply ext-sip-ip to outbound calls.
        -- X-Carrier header tells Kamailio which Bandwidth IP to use.
        set_var("carrier_used", "carrier_" .. carrier)

        -- Remote-Party-ID: backup CID presentation mechanism for carriers
        -- that don't support P-Asserted-Identity. Uses E.164 format.
        if pass_caller_id then
            session:setVariable("sip_h_Remote-Party-ID",
                "<sip:" .. e164_original_cid .. "@" .. external_sip_ip .. ">;party=calling;privacy=off;screen=yes")
        else
            session:setVariable("sip_h_Remote-Party-ID",
                "<sip:" .. masking_e164 .. "@" .. external_sip_ip .. ">;party=calling;privacy=off;screen=yes")
        end

        -- ================================================================
        -- STIR/SHAKEN attestation (carrier-bound leg only) — Phase 2 Task 2.3/2.4
        -- ================================================================
        -- Kamailio route[TO_CARRIER] signs the outbound Identity (PASSporT) at
        -- the carrier border. It reads two FS-set custom headers on this B-leg
        -- (then strips them before relaying to Bandwidth — see kamailio.cfg
        -- "Step 8.5"): X-Attestation ∈ {A,B,div} and X-In-Identity (the div base).
        --
        -- RCF is DIVERSION, not origination: we do NOT assert A on the original
        -- caller's number. Mark this leg `div` so Kamailio builds an RFC 8946 /
        -- ATIS-1000085 div PASSporT chained onto the preserved inbound Identity.
        -- (Kamailio ALSO treats a present Diversion header as the div trigger, so
        -- this is belt-and-suspenders with the sip_h_Diversion set above — but we
        -- set it explicitly so the contract does not silently depend on Diversion.)
        --
        -- These are session variables (like sip_h_Diversion / sip_h_X-Original-CID
        -- above), so mod_sofia emits them on the outbound INVITE and they PERSIST
        -- across every iteration of the SBC×carrier failover loop below — table-
        -- driven or legacy (either loop only overrides the carrier selector
        -- headers (X-Carrier-IP/X-Carrier-Label or legacy X-Carrier) / X-CID /
        -- the SBC IP per attempt).
        -- They are set ONLY in this PSTN/carrier `else` branch — the local-
        -- extension branch (user/<ext>) never reaches the carrier, so it must not
        -- carry them.
        session:setVariable("sip_h_X-Attestation", "div")

        -- Echo the inbound SHAKEN Identity as the div base. Kamailio captured the
        -- carrier's inbound Identity on the A-leg and handed it to FS as
        -- X-In-Identity (Task 1.4). Read what we RECEIVED (sip_h_X-In-Identity)
        -- and re-set it verbatim on this B-leg so Kamailio can re-emit it as the
        -- base PASSporT (RFC 8946: a div is only valid chained onto a base).
        -- If the inbound call carried NO Identity there is simply nothing to
        -- echo — OMIT the header (never set an empty one); Kamailio then falls
        -- back to a base PASSporT for the "div marked but no base" case.
        local in_identity = get_var("sip_h_X-In-Identity", nil)
        if in_identity and in_identity ~= "" then
            session:setVariable("sip_h_X-In-Identity", in_identity)
        end

        -- ================================================================
        -- STIR/SHAKEN CDR facts (T3) — record RAW facts only, never derive.
        -- ================================================================
        -- These A-leg channel variables are serialized verbatim into the posted
        -- CDR JSON (mod_json_cdr includes ALL channel vars — see
        -- json_cdr.conf.xml, no channel-vars filter) and read by
        -- /v1/cdrs/ingest. FS records ONLY what it knows on this carrier-bound
        -- leg; the backend derives the EFFECTIVE attestation (div→C) from
        -- stir_attest_intent + stir_inbound_signed. Additive + fail-safe: every
        -- value defaults to empty/"0" and setting a channel var can never fail a
        -- call. Set ONLY in this PSTN/carrier branch (a local-extension forward
        -- never reaches the carrier, so it carries no STIR facts).
        --
        --   stir_attest_intent   = the X-Attestation we set on the B-leg (here
        --                          always "div" — RCF is diversion).
        --   stir_inbound_signed  = "1" if we had an inbound Identity to chain
        --                          (X-In-Identity present on the A-leg), else "0".
        --   stir_verstat         = the inbound X-Verstat value Kamailio stamped on
        --                          the A-leg (self-verify OR carrier PAI), or "".
        --   stir_verstat_source  = "self" / "carrier" / "" (the source marker
        --                          Kamailio set alongside X-Verstat).
        --   stir_inbound_attest  = the ORIGINATING carrier's attestation of the
        --                          caller (A/B/C) that Kamailio lifted from the
        --                          inbound P-Attestation-Indicator into internal
        --                          X-Inbound-Attest, or "" if absent/unrecognized.
        --                          COMPLEMENTARY to stir_verstat (pass/fail of
        --                          THIS hop) — this is the caller's attestation.
        set_var("stir_attest_intent", "div")
        set_var("stir_inbound_signed", (in_identity and in_identity ~= "") and "1" or "0")
        set_var("stir_verstat", get_var("sip_h_X-Verstat", ""))
        set_var("stir_verstat_source", get_var("sip_h_X-Verstat-Source", ""))
        set_var("stir_inbound_attest", get_var("sip_h_X-Inbound-Attest", ""))

        -- Export caller ID to B-leg for Bandwidth From header auth.
        pcall(function() session:execute("export", "origination_caller_id_number=" .. outbound_did) end)
        pcall(function() session:execute("export", "origination_caller_id_name=" .. outbound_did) end)

        freeswitch.consoleLog("INFO", string.format(
            "[%s] RCF Bridge (PSTN): %s -> %s via proxy (carrier=%s, pass_cid=%s, failover_sbc=%s)\n",
            uuid, normalized_did, forward_to, carrier, tostring(pass_caller_id), sbc_proxy_ip_failover
        ))
    end

    -- Ensure clean call teardown when bridge ends
    set_var("hangup_after_bridge", "true")
    -- Set bridge failure handling for failover
    set_var("continue_on_fail", "true")
    -- Mark that the DID was found and Lua is handling routing
    -- This prevents the dialplan fallback 404 from masking bridge failures
    set_var("lua_routed", "true")

    -- RFC 4028 session timers: export to B-leg so mod_sofia includes
    -- Session-Expires and Min-SE in the outbound INVITE.
    -- CRITICAL: set_var() only sets on the A-leg. export via session:execute
    -- marks the variable for propagation to the B-leg channel.
    -- Belt-and-suspenders: these are also included in the bridge {} blocks.
    pcall(function() session:execute("export", "sip_session_timeout=1800") end)
    pcall(function() session:execute("export", "sip_minimum_session_expires=90") end)
    pcall(function() session:execute("export", "enable_timer=true") end)

    -- ================================================================
    -- Per-DID concurrent call limit (mod_hash, no Redis needed)
    -- ================================================================
    -- max_channels=0 means unlimited (default). When set >0, FreeSWITCH
    -- tracks concurrent calls per DID using the in-memory hash backend.
    -- If the limit is reached, the call is rejected with 486 Busy Here.
    -- On-net note (design §6): this runs against the TERMINAL DID only
    -- (intermediate RCF hops emit no B-leg, so they have no concurrency).
    local max_concurrent = tonumber(routing.max_channels) or 0
    if max_concurrent > 0 then
        freeswitch.consoleLog("INFO", string.format(
            "[inbound_router] Checking limit: DID %s, max %d concurrent\n",
            normalized_did, max_concurrent
        ))
        session:execute("limit", "hash inbound " .. normalized_did .. " " .. tostring(max_concurrent) .. " !USER_BUSY")
        -- If limit exceeded, session is already hung up with 486 Busy
        -- Check if session is still active before continuing
        if not session:ready() then
            freeswitch.consoleLog("WARNING", string.format(
                "[inbound_router] DID %s rejected — %d concurrent call limit reached\n",
                normalized_did, max_concurrent
            ))
            return
        end
    end

    -- ================================================================
    -- SBC + Carrier failover: table-driven attempts (carrier_trunks)
    -- with legacy hardcoded fallback
    -- ================================================================
    -- For local extensions, there is only the single dial_string built above.
    -- For PSTN, attempts come from get_termination_trunks(fs_zone) — the
    -- TED-managed carrier_trunks table (60s process-wide cache) — built
    -- TRUNK-MAJOR: both SBCs are tried on trunk 1 before moving to trunk 2,
    -- preserving today's shape. With the 2-row Bandwidth seeds this is
    -- exactly the historical order (east/central shown; west swaps the PoPs):
    --   1. SBC-1 + bandwidth-dallas
    --   2. SBC-2 + bandwidth-dallas
    --   3. SBC-1 + bandwidth-la
    --   4. SBC-2 + bandwidth-la
    -- Per attempt the dial string carries sip_h_X-Carrier-IP=<term_ip> (+
    -- sip_h_X-Carrier-Label=<carrier>-<pop>) instead of the legacy X-Carrier
    -- enum. Kamailio validates the IP (env Bandwidth IPs or a carrier_trunks
    -- point lookup), sets $du to it, and DISABLES its own alternate-IP
    -- carrier flip for these calls — this loop owns ALL carrier failover
    -- (two failover owners would double-dial the PSTN).
    --
    -- FAIL-OPEN: if the table cannot be resolved (DB blip / zero rows /
    -- bad cache), the legacy 4-attempt loop below runs byte-identically to
    -- the pre-table behavior (X-Carrier enum -> Kamailio env mapping).
    -- term_trunks_source=db|fallback records which path ran (CDR breadcrumb).
    --
    -- Channel variables (outbound_caller_id_*, effective_caller_id_*,
    -- sip_h_Diversion, sip_h_X-Original-CID, sip_h_Remote-Party-ID)
    -- and exported origination_caller_id_* persist on the session across
    -- all bridge attempts. Only the carrier selector headers and the SBC IP
    -- change per attempt.
    -- ================================================================

    if is_local_forward then
        -- Local extension: single bridge attempt (no SBC/carrier failover)
        pcall(function()
            session:execute("bridge", dial_string)
        end)
    else
        local term_trunks = get_termination_trunks(fs_zone)

        if term_trunks then
        -- PSTN: table-driven SBC + carrier failover loop (carrier_trunks)
        set_var("term_trunks_source", "db")

        -- Trunk-major attempt table: for each trunk (already in
        -- eff_priority order) try the primary SBC, then the failover SBC.
        local bridge_attempts = {}
        for _, trunk in ipairs(term_trunks) do
            local carrier_label = trunk.carrier
            if trunk.pop and trunk.pop ~= "" then
                carrier_label = trunk.carrier .. "-" .. trunk.pop
            end
            bridge_attempts[#bridge_attempts + 1] = {
                sbc = sbc_proxy_ip, ip = trunk.term_ip, carrier_label = carrier_label,
                label = "SBC-1 + " .. carrier_label .. " (" .. trunk.term_ip .. ")",
            }
            bridge_attempts[#bridge_attempts + 1] = {
                sbc = sbc_proxy_ip_failover, ip = trunk.term_ip, carrier_label = carrier_label,
                label = "SBC-2 + " .. carrier_label .. " (" .. trunk.term_ip .. ")",
            }
        end
        local total_attempts = #bridge_attempts

        for i, attempt in ipairs(bridge_attempts) do
            local attempted = false

            -- Same cached TCP pre-check as the legacy loop: skip a dead
            -- SBC in <1 second instead of eating the SIP timeout.
            if not is_sbc_reachable(attempt.sbc, 5060) then
                freeswitch.consoleLog("WARNING", string.format(
                    "[%s] RCF bridge attempt %d/%d SKIPPED — SBC %s unreachable (%s)\n",
                    uuid, i, total_attempts, attempt.sbc, attempt.label
                ))
            else
                attempted = true
                -- Same dial string as the legacy loop except the carrier
                -- selector: X-Carrier-IP/X-Carrier-Label replace the
                -- X-Carrier enum. progress_timeout still bounds carrier PDD
                -- per attempt; call_timeout / session-timer trio / X-CID
                -- are unchanged.
                local attempt_dial = string.format(
                    "{ignore_early_media=false,progress_timeout=%d,call_timeout=%d,sip_h_X-Carrier-IP=%s,sip_h_X-Carrier-Label=%s" ..
                    ",sip_h_X-CID=%s" ..
                    ",sip_session_timeout=1800,sip_minimum_session_expires=90,enable_timer=true" ..
                    "}sofia/external/%s@%s:5060",
                    bridge_progress_timeout,
                    ring_timeout,
                    attempt.ip,
                    attempt.carrier_label,
                    sip_call_id,
                    forward_to,
                    attempt.sbc
                )

                -- carrier_used reflects the WINNING attempt (same semantics
                -- as the legacy loop, new value shape "<carrier>-<pop>").
                set_var("carrier_used", attempt.carrier_label)

                freeswitch.consoleLog("INFO", string.format(
                    "[%s] RCF bridge attempt %d/%d (%s): %s -> %s@%s carrier_ip=%s\n",
                    uuid, i, total_attempts, attempt.label, normalized_did, forward_to, attempt.sbc, attempt.ip
                ))

                pcall(function()
                    session:execute("bridge", attempt_dial)
                end)
            end

            -- Same disposition contract as the legacy loop (see its comments):
            -- originate_disposition is the authoritative bridge result and is
            -- only inspected for attempts that actually ran a bridge.
            if attempted then
                local disposition = get_var("originate_disposition", "")
                if disposition == "SUCCESS" then
                    freeswitch.consoleLog("INFO", string.format(
                        "[%s] RCF bridge attempt %d/%d succeeded (%s)\n",
                        uuid, i, total_attempts, attempt.label
                    ))
                    break
                end

                freeswitch.consoleLog("INFO", string.format(
                    "[%s] RCF bridge attempt %d/%d failed (%s): cause=%s\n",
                    uuid, i, total_attempts, attempt.label,
                    get_var("last_bridge_hangup_cause", disposition)
                ))
            end

            -- If continue_on_fail tore the A-leg down (e.g. caller hung up
            -- mid-failover), stop trying — the session is gone.
            if not session:ready() then
                break
            end
        end

        else
        -- LEGACY FALLBACK — byte-identical to the pre-table loop below this
        -- comment (indentation preserved on purpose). Do NOT restructure:
        -- the fail-open contract is that a DB blip reproduces today's exact
        -- attempts (env primary/secondary + X-Carrier enum).
        set_var("term_trunks_source", "fallback")
        -- PSTN: 4-attempt SBC + carrier failover loop
        local bridge_attempts = {
            { sbc = sbc_proxy_ip,          carrier = "primary",   label = "SBC-1 + primary carrier (Dallas)" },
            { sbc = sbc_proxy_ip_failover, carrier = "primary",   label = "SBC-2 + primary carrier (Dallas)" },
            { sbc = sbc_proxy_ip,          carrier = "secondary", label = "SBC-1 + secondary carrier (LA)" },
            { sbc = sbc_proxy_ip_failover, carrier = "secondary", label = "SBC-2 + secondary carrier (LA)" },
        }

        for i, attempt in ipairs(bridge_attempts) do
            local attempted = false

            -- TCP pre-check: detect dead SBC in <1 second instead of
            -- waiting for SIP timeout. Skip unreachable SBCs instantly.
            if not is_sbc_reachable(attempt.sbc, 5060) then
                freeswitch.consoleLog("WARNING", string.format(
                    "[%s] RCF bridge attempt %d/4 SKIPPED — SBC %s unreachable (%s)\n",
                    uuid, i, attempt.sbc, attempt.label
                ))
            else
                attempted = true
                -- progress_timeout bounds carrier PDD: the attempt fails over
                -- to the next SBC+carrier combination only if NO provisional
                -- response (180/183) arrives within N seconds. Once ringing
                -- starts, the call may ring up to call_timeout (the ring time
                -- allowed for this attempt). Env-tunable per CLAUDE.md.
                local attempt_dial = string.format(
                    "{ignore_early_media=false,progress_timeout=%d,call_timeout=%d,sip_h_X-Carrier=%s" ..
                    ",sip_h_X-CID=%s" ..
                    ",sip_session_timeout=1800,sip_minimum_session_expires=90,enable_timer=true" ..
                    "}sofia/external/%s@%s:5060",
                    bridge_progress_timeout,
                    ring_timeout,
                    attempt.carrier,
                    sip_call_id,
                    forward_to,
                    attempt.sbc
                )

                -- Label the CDR with the carrier we are about to try. If this
                -- attempt connects we break immediately below, so carrier_used
                -- reflects the WINNING attempt. On failure the next iteration
                -- overwrites it before its own bridge.
                set_var("carrier_used", "carrier_" .. attempt.carrier)

                freeswitch.consoleLog("INFO", string.format(
                    "[%s] RCF bridge attempt %d/4 (%s): %s -> %s@%s carrier=%s\n",
                    uuid, i, attempt.label, normalized_did, forward_to, attempt.sbc, attempt.carrier
                ))

                pcall(function()
                    session:execute("bridge", attempt_dial)
                end)
            end

            -- Determine whether THIS bridge connected. originate_disposition is
            -- the authoritative FreeSWITCH variable: it is set to "SUCCESS" after
            -- a connected bridge, or to a failure cause (USER_BUSY,
            -- NO_ROUTE_DESTINATION, RECOVERY_ON_TIMER_EXPIRE, etc.) otherwise.
            -- (bridge_result is NOT a real channel variable — never trust it.)
            -- We only inspect disposition for attempts that actually ran a bridge;
            -- a skipped (unreachable-SBC) attempt leaves the previous attempt's
            -- disposition in place and must not be misread as success.
            if attempted then
                local disposition = get_var("originate_disposition", "")
                if disposition == "SUCCESS" then
                    freeswitch.consoleLog("INFO", string.format(
                        "[%s] RCF bridge attempt %d/4 succeeded (%s)\n",
                        uuid, i, attempt.label
                    ))
                    break
                end

                freeswitch.consoleLog("INFO", string.format(
                    "[%s] RCF bridge attempt %d/4 failed (%s): cause=%s\n",
                    uuid, i, attempt.label,
                    get_var("last_bridge_hangup_cause", disposition)
                ))
            end

            -- If continue_on_fail tore the A-leg down (e.g. caller hung up
            -- mid-failover), stop trying — the session is gone.
            if not session:ready() then
                break
            end
        end
        end -- term_trunks (table-driven) vs legacy fallback
    end

    -- Final result check (covers both local and PSTN paths).
    -- originate_disposition == "SUCCESS" means a B-leg connected at some point;
    -- the call has since completed normally via hangup_after_bridge.
    local disposition = get_var("originate_disposition", "")
    local last_bridge_hangup = get_var("last_bridge_hangup_cause", "")

    -- If NO attempt ever connected, hangup with NORMAL_TEMPORARY_FAILURE (SIP 503)
    -- instead of falling through to the dialplan's 404 which would mask the real
    -- issue. The DID WAS found -- the carrier bridge just couldn't complete.
    -- NOTE: a session that is no longer ready but DID connect (disposition
    -- SUCCESS) is a normal completed call, not a failure.
    if disposition ~= "SUCCESS" then
        freeswitch.consoleLog("WARNING", string.format(
            "[%s] All bridges failed for RCF DID %s -> %s (disposition=%s last_cause=%s)\n",
            uuid, normalized_did, forward_to, disposition, last_bridge_hangup
        ))
        hangup("NORMAL_TEMPORARY_FAILURE",
            "[" .. uuid .. "] RCF bridge failed, returning 503 (DID was found, carrier unreachable)")
        return
    end
end

-- ================================================================
-- Terminator: API DID  (dest = terminal API routing row, ctx = state)
-- ================================================================
-- BEHAVIOR-PRESERVING extraction of the original `product_type == "api"` body.
-- Answers on-platform and hands off to voice_webhook.lua. Emits ZERO carrier
-- legs by construction (the answered channel can never fall through to a
-- carrier), so no lua_routed flag is needed here.
local function terminate_api(dest, ctx)
    local uuid = ctx.uuid
    local traffic_grade = ctx.traffic_grade
    local voice_url = dest.voice_url
    local fallback_url = dest.fallback_url

    -- API Calling - Execute webhook-driven voice control via voice_webhook.lua
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
        freeswitch.consoleLog("ERR", "[" .. uuid .. "] API DID has no voice_url configured — rejecting\n")
        hangup("NORMAL_TEMPORARY_FAILURE")
    end
end

-- ================================================================
-- Terminator: Trunk DID  (dest = terminal trunk routing row, ctx = state)
-- ================================================================
-- BEHAVIOR-PRESERVING extraction of the original `product_type == "trunk"` body.
-- Bridges to the customer PBX via Kamailio using X-PBX-Dest (never X-Carrier).
local function terminate_trunk(dest, ctx)
    local uuid = ctx.uuid
    local caller_id = ctx.caller_id
    -- SELF/terminal trunk DID and its parent trunk id.
    local normalized_did = dest.did
    local trunk_id = dest.trunk_id

    -- SIP Trunk inbound — route call to customer's PBX
    -- Look up the customer's authorized IP(s) and bridge to their PBX
    freeswitch.consoleLog("DEBUG", string.format(
        "[%s] Trunk inbound: trunk_id=%s did=%s\n",
        uuid, tostring(trunk_id), normalized_did
    ))

    -- Get customer PBX endpoint IPs
    local endpoint_ips = nil
    if db then
        local lookup_ok, lookup_result = pcall(function()
            return db.get_trunk_endpoint_ips(trunk_id)
        end)
        if lookup_ok then
            endpoint_ips = lookup_result
        else
            freeswitch.consoleLog("ERR", string.format(
                "[%s] Trunk endpoint IP lookup failed for trunk %s: %s\n",
                uuid, tostring(trunk_id), tostring(lookup_result)
            ))
        end
    else
        freeswitch.consoleLog("ERR", "[" .. uuid .. "] db_client unavailable — cannot look up trunk endpoints\n")
    end

    freeswitch.consoleLog("DEBUG", string.format(
        "[%s] Trunk endpoint lookup: count=%d\n",
        uuid, (endpoint_ips and #endpoint_ips or 0)
    ))

    if not endpoint_ips or #endpoint_ips == 0 then
        freeswitch.consoleLog("WARNING", string.format(
            "[%s] No endpoint IPs found for trunk %s\n", uuid, tostring(trunk_id)
        ))
        hangup("NO_ROUTE_DESTINATION", "[" .. uuid .. "] No PBX endpoint configured for trunk")
    else
        -- Media anchoring and ringback (same as RCF)
        set_var("proxy_media", "true")
        set_var("ringback", "%(2000,4000,440,480)")
        set_var("transfer_ringback", "%(2000,4000,440,480)")
        set_var("hangup_after_bridge", "true")
        set_var("continue_on_fail", "true")

        -- Caller ID: present the composed identity to the PBX (design §5,
        -- "last false hop wins"). ctx.pass_effective is TRUE for a direct trunk
        -- inbound (no RCF hop ran) AND for an on-net RCF->trunk chain whose every
        -- hop passed CID transparently; in that case present exactly what the
        -- pre-on-net direct path presented -- the original caller from
        -- sip_from_user (fallback caller_id) -- BYTE-FOR-BYTE UNCHANGED. Only when
        -- an intermediate RCF hop masked (pass_caller_id=false) do we substitute
        -- the masking DID (ctx.presented_cid) so the PBX sees the mask, not the
        -- true caller. ctx.caller_id == the module-level caller_id_number.
        local original_caller
        if ctx.pass_effective then
            original_caller = get_var("sip_from_user", caller_id)
        else
            original_caller = ctx.presented_cid
        end
        set_var("effective_caller_id_number", original_caller)

        -- Build dial string to customer PBX through Kamailio SBC
        -- Same pattern as RCF: FS -> Kamailio (sbc_proxy_ip:5060) -> PBX
        -- X-PBX-Dest header tells Kamailio where to relay the call
        local bridge_did = normalized_did:gsub("^%+", "")
        local pbx_ip = endpoint_ips[1]

        set_var("sip_h_X-PBX-Dest", pbx_ip)

        local dial_string = string.format(
            "{ignore_early_media=false,sip_enable_soa=false,call_timeout=60" ..
            ",sip_session_timeout=1800,sip_minimum_session_expires=90,enable_timer=true" ..
            "}sofia/external/%s@%s:5060",
            bridge_did,
            sbc_proxy_ip
        )

        freeswitch.consoleLog("INFO", string.format(
            "[%s] Trunk inbound bridge (via SBC): %s X-PBX-Dest=%s\n",
            uuid, dial_string, pbx_ip
        ))

        -- Mark as lua-routed
        set_var("lua_routed", "true")

        session:execute("bridge", dial_string)

        -- Check bridge result. originate_disposition is the authoritative
        -- success/failure indicator ("SUCCESS" on connect, a failure cause
        -- otherwise). bridge_result is NOT a real variable and is never used.
        local disposition = get_var("originate_disposition", "")
        if disposition ~= "" and disposition ~= "SUCCESS" then
            freeswitch.consoleLog("WARNING", string.format(
                "[%s] Trunk inbound bridge failed: disposition=%s last_cause=%s\n",
                uuid, disposition, get_var("last_bridge_hangup_cause", "")
            ))
        end
    end
end

-- Product-agnostic dispatch map (design §2/§8). A future product enrolls by
-- adding a UNION-ALL arm to number_routing + a terminator here — detection,
-- the hop loop, loop/limit/reject, and CDR emission stay untouched.
local TERMINATORS = {
    rcf   = terminate_rcf,
    api   = terminate_api,
    trunk = terminate_trunk,
}

-- Set common CDR/terminal channel vars on the resolved TERMINAL destination,
-- then dispatch to its product terminator (design §4/§5). customer_id is set to
-- the TERMINAL customer so rate_cdr() (which rates customer_id) is unchanged.
local function dispatch_terminal(dest, ctx)
    set_var("customer_id", tostring(dest.customer_id))
    set_var("product_type", dest.product_type)
    set_var("terminating_customer_id", tostring(dest.customer_id))
    set_var("origin_customer_id", tostring(ctx.origin_customer_id))
    set_var("on_net", ctx.on_net and "true" or "false")
    set_var("on_net_hops", tostring(ctx.hops))
    if dest.trunk_id then
        set_var("trunk_id", tostring(dest.trunk_id))
    end
    local fn = TERMINATORS[dest.product_type]
    if not fn then
        -- Should never happen (view only yields known product types) — fail
        -- closed rather than fall through to the carrier.
        hard_reject("EXCHANGE_ROUTING_ERROR", string.format(
            "[%s] No terminator for product_type=%s — hard reject\n",
            ctx.uuid, tostring(dest.product_type)))
        return
    end
    fn(dest, ctx)
end

freeswitch.consoleLog("DEBUG", "[" .. uuid .. "] STEP 2: Routing product_type=" .. tostring(product_type) .. "\n")

-- ================================================================
-- Seed cross-hop context at the first (inbound) hop (design §2)
-- ================================================================
-- presented_cid / pass_effective start "transparent": the original caller is
-- shown unless a masking (pass=false) hop overrides it. visited is seeded with
-- the inbound DID so an immediate A->A forward is caught as a loop.
local ctx = {
    uuid                = uuid,
    sip_call_id         = (session:getVariable("sip_call_id") or uuid),
    inbound_tc          = (get_var("sip_h_X-Inbound-TC", ""):match("^%s*(.-)%s*$") or ""),
    is_local_test       = get_var("is_local_test", "false"),
    caller_id           = caller_id,
    traffic_grade       = traffic_grade,
    original_caller_number = original_caller_number,
    original_caller_name   = original_caller_name,
    presented_cid       = original_caller_number,
    presented_name      = original_caller_name,
    pass_effective      = true,
    hops                = 0,
    visited             = { [normalized_did] = true },
    origin_customer_id  = customer_id,   -- first-hop (inbound DID) customer
    origin_did          = normalized_did,
}
set_var("origin_customer_id", tostring(ctx.origin_customer_id))

-- The first-hop routing row (from STEP 1) becomes the initial terminal
-- candidate. For api/trunk inbound it IS the terminal (no chain). For rcf it is
-- the first hop whose forward_to may itself be on-net (resolved in the loop).
local first_dest = {
    did             = normalized_did,
    product_type    = product_type,
    customer_id     = customer_id,
    product_enabled = true,        -- STEP 1 lookups already filtered enabled/active
    customer_status = "active",
    forward_to      = forward_to,
    pass_caller_id  = pass_caller_id,
    ring_timeout    = ring_timeout,
    max_channels    = tonumber(routing.max_channels) or 0,
    product_name    = routing.rcf_name,
    voice_url       = voice_url,
    fallback_url    = fallback_url,
    trunk_id        = trunk_id,
}

if product_type == "rcf" then
    -- ============================================================
    -- RCF branch point: 3-way on-net decision + in-memory chain
    -- ============================================================
    -- (design §2/§5/§6) — a chain of RCF->RCF forwards resolves entirely in
    -- memory (DB lookups only, NO SIP per hop) until it reaches a terminal:
    -- an off-net PSTN number, a local extension, or another product's DID.
    -- EXACTLY ONE B-leg is ever emitted (by the terminal terminator).
    local cur = first_dest

    while true do
        -- Compose caller-ID for THIS hop ("last false hop wins", design §5).
        -- The terminal RCF hop participates too, so a single off-net RCF DID
        -- yields exactly today's CID behavior.
        if cur.pass_caller_id == false then
            ctx.pass_effective = false
            ctx.presented_cid = cur.did
            ctx.presented_name = cur.did
        end

        local fwd = cur.forward_to

        -- (1) Local extension terminal — existing user/<ext> bridge (unchanged).
        if is_local_extension(fwd) then
            ctx.on_net = ctx.on_net or false
            dispatch_terminal(cur, ctx)
            break
        end

        -- (2) Resolve forward_to against the on-net oracle.
        local fwd_e164 = normalize_did(fwd)
        local resolved = nil
        if db then
            local ok, row = pcall(function() return db.resolve_destination(fwd_e164) end)
            if ok then
                resolved = normalize_dest(row)
            else
                freeswitch.consoleLog("ERR", string.format(
                    "[%s] resolve_destination failed for %s: %s — treating as off-net\n",
                    uuid, fwd_e164, tostring(row)))
            end
        end

        if not resolved then
            -- (2a) OFF-NET: forward_to is not one of our DIDs. Terminate the
            -- CURRENT RCF DID exactly as today (single carrier B-leg via the
            -- 4-attempt failover loop). on_net reflects whether we short-
            -- circuited any earlier hop in this chain.
            -- Pin the classification explicitly (carrier B-leg): dispatch_terminal
            -- exports the `on_net` channel variable read by the ESL metrics
            -- exporter to label live channels; leaving it implicit here would
            -- rely on nil->"false" coercion. Preserves an earlier true hop.
            ctx.on_net = ctx.on_net or false
            dispatch_terminal(cur, ctx)
            break
        end

        -- (2b) ON-NET: forward_to is a platform-owned DID.
        -- Disabled/suspended terminal -> hard reject (no carrier fallback).
        if (not resolved.product_enabled) or (resolved.customer_status ~= "active") then
            hard_reject("CALL_REJECTED", string.format(
                "[%s] On-net destination %s is disabled/suspended "
                .. "(product_enabled=%s customer_status=%s) — 603\n",
                uuid, fwd_e164, tostring(resolved.product_enabled),
                tostring(resolved.customer_status)))
            break
        end

        -- Loop guard: this DID already entered in the chain -> hard reject.
        if ctx.visited[resolved.did] then
            hard_reject("EXCHANGE_ROUTING_ERROR", string.format(
                "[%s] Routing loop detected re-entering %s — 483\n",
                uuid, resolved.did))
            break
        end

        -- Count this on-net hop; enforce MAX_HOPS.
        ctx.hops = ctx.hops + 1
        ctx.visited[resolved.did] = true
        ctx.on_net = true
        freeswitch.consoleLog("INFO", string.format(
            "[%s] ON-NET hop %d: %s -> %s (product=%s customer=%s)\n",
            uuid, ctx.hops, cur.did, resolved.did, resolved.product_type,
            tostring(resolved.customer_id)))

        if ctx.hops > MAX_HOPS then
            hard_reject("EXCHANGE_ROUTING_ERROR", string.format(
                "[%s] On-net hop limit exceeded (>%d) at %s — 483\n",
                uuid, MAX_HOPS, resolved.did))
            break
        end

        -- If the resolved on-net destination is itself an RCF DID, keep
        -- following the chain in memory (no SIP). Otherwise it is a terminal
        -- of another product (api/trunk) — dispatch it and stop.
        if resolved.product_type == "rcf" then
            cur = resolved
            -- loop again
        else
            dispatch_terminal(resolved, ctx)
            break
        end
    end
else
    -- Non-RCF inbound (api / trunk): the first-hop DID is the terminal, exactly
    -- as before. No chain, no on-net decision (a directly-dialed platform DID is
    -- not a "forward" — off-net vs on-net only applies to a forwarding handoff).
    -- A directly-dialed DID is off-net by definition; pin it explicitly so the
    -- `on_net` channel variable (exported in dispatch_terminal for the ESL
    -- metrics exporter's live-channel label) is deterministic, not nil-coerced.
    ctx.on_net = false
    dispatch_terminal(first_dest, ctx)
end

freeswitch.consoleLog("INFO", "[" .. uuid .. "] Inbound routing complete\n")
