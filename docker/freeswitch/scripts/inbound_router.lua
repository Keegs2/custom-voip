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
-- Far-end final results: never re-dial a phone that was reached
-- ================================================================
-- A bridge attempt that ends USER_BUSY (the far end answered 486 busy) or
-- NO_ANSWER (it rang for the whole call_timeout) reached the forwarded
-- PHONE, not a broken route. The next SBC / carrier attempt would only ring
-- that same phone again — up to 8 times — so the failover sweep stops there
-- and the caller gets that answer back (USER_BUSY -> 486, NO_ANSWER -> 480)
-- instead of a 503, which also invites the originating carrier to retry
-- the whole call on another of our routes. Every other cause (SBC / carrier
-- trouble, PROGRESS_TIMEOUT, 5xx, CALL_REJECTED …) keeps the failover order.
-- NO_ANSWER counts only when the ring time is longer than the PDD bound:
-- with call_timeout <= progress_timeout a route that never answered at all
-- also ends NO_ANSWER, and that one must still fail over.
local function far_end_final(disposition, call_timeout)
    if disposition == "USER_BUSY" then
        return true
    end
    return disposition == "NO_ANSWER"
        and (tonumber(call_timeout) or 0) > bridge_progress_timeout
end

-- ================================================================
-- RCF From-header pass-through gate (RCF_FROM_PASSTHROUGH=on|off)
-- ================================================================
-- DEFAULT OFF. Only the exact values on|true|1 (case-insensitive, trimmed)
-- enable it; unset, empty, or anything else = OFF, so a media VM that has
-- merely `git pull`ed this bind-mounted script inside a running container
-- (no such env var) behaves EXACTLY as before this gate existed: From is
-- always the RCF DID (CLAUDE.md: "Outbound From stays the terminal DID for
-- Bandwidth auth").
-- When ON AND the RCF DID has pass_caller_id=true, the carrier-bound From
-- number/display name is the ORIGINAL caller (see terminate_rcf "SIP From").
-- Enable PER ZONE, and only after BOTH of these hold:
--   1. the zone's SBCs run the #120+#122 Kamailio build FIRST — the base
--      RCF-V1 kamailio.cfg has no strip for the X-From-Name header this gate
--      emits, so an older SBC would forward the caller's display name to the
--      carrier verbatim;
--   2. one live canary RCF call per carrier PoP (Bandwidth Dallas + LA)
--      confirms the carrier accepts a non-account TN in From (UNVERIFIED).
-- Read via os.getenv like BRIDGE_PROGRESS_TIMEOUT (passed through
-- docker-compose.media.yml; set RCF_FROM_PASSTHROUGH=on in /opt/revup/.env
-- + recreate the container).
local rcf_from_passthrough = false
do
    local v = tostring(os.getenv("RCF_FROM_PASSTHROUGH") or ""):lower():match("^%s*(.-)%s*$")
    if v == "on" or v == "true" or v == "1" then
        rcf_from_passthrough = true
    end
end

-- ================================================================
-- API Calling product gate (API_CALLING_ENABLED=true|<anything else>)
-- ================================================================
-- The "API Calling" product (account_type `api`: voice_webhook.lua,
-- outbound_api.lua / api_outbound.lua) is RETIRED — switched OFF, code KEPT.
-- DEFAULT OFF. Only the exact value "true" (case-insensitive, trimmed)
-- re-enables it; unset/empty/anything else = OFF, so a media VM that merely
-- `git pull`s this bind-mounted script (no env var) retires the product with
-- no FS restart and no .env change.
-- When OFF, an api_did is still recognized as OURS (STEP 1 lookup_api_did and
-- the number_routing view keep their api arms) but its product is retired, so
-- it is HARD-REJECTED with CALL_REJECTED (603) + lua_routed=true — never
-- handed to voice_webhook.lua and never hairpinned to the carrier:
--   * direct inbound to an api_did (STEP 2 non-RCF branch)
--   * an on-net RCF chain whose terminal resolves to an api_did
-- RCF and SIP Trunking paths do not consult this flag.
-- When ON, terminate_api runs exactly as before this gate existed.
local api_calling_enabled = false
do
    local v = tostring(os.getenv("API_CALLING_ENABLED") or ""):lower():match("^%s*(.-)%s*$")
    if v == "true" then
        api_calling_enabled = true
    end
end

-- ================================================================
-- Visual IVR product gate (IVR_ENABLED=true|<anything else>)
-- ================================================================
-- docs/IVR_INTERFACES.md §5.1. Parsed EXACTLY like API_CALLING_ENABLED:
-- only the value "true" (case-insensitive, trimmed) enables it; unset / empty
-- / anything else = OFF. Passed through docker-compose.media.yml
-- (IVR_ENABLED=${IVR_ENABLED:-false}); turning it on is a per-zone .env line
-- + container recreate (P5).
-- When OFF, an IVR DID is still recognized as OURS (STEP-1 lookup_ivr_did
-- and the number_routing ivr arm) and is HARD-REJECTED CALL_REJECTED (603)
-- + lua_routed=true — never answered, never hairpinned to the carrier:
--   * direct inbound to an IVR DID (STEP 2 non-RCF branch)
--   * an on-net RCF chain whose terminal resolves to an IVR DID
-- When ON, TERMINATORS.ivr = terminate_ivr. RCF/trunk/voicemail/API paths
-- never consult this flag (harness: tests/lua/ivr_egress_identity_harness.lua).
local ivr_enabled = false
do
    local v = tostring(os.getenv("IVR_ENABLED") or ""):lower():match("^%s*(.-)%s*$")
    if v == "true" then
        ivr_enabled = true
    end
end

-- ================================================================
-- Egress "return disposition" mode (Visual IVR transfers)
-- ================================================================
-- The RCF egress (terminate_rcf: TCP pre-check, SBC x carrier failover,
-- progress_timeout, carrier_trunks + 8YY class, From/PAI/RPID/Diversion, STIR
-- div + outcome capture, [cdr_*] B-leg block) and the on-net chain resolver
-- (run_onnet_chain) are shared with IVR transfers (ivr_transfer below). An
-- IVR transfer that is not answered must RETURN to the IVR engine (the
-- block's "No answer" exit) instead of hanging the caller up, so while an IVR
-- transfer runs this flag is true and:
--   * hard_reject records the cause instead of hanging up (the engine plays
--     the technical-difficulty prompt, then hangs up with that cause);
--   * terminate_rcf / terminate_trunk return a disposition instead of the 503;
--   * the A-leg customer_id / product_type stay the IVR's (dispatch_terminal);
--   * a far-end NO_ANSWER / USER_BUSY returns to the engine (its No-answer
--     exit) instead of hanging up with that cause. Ending the failover sweep
--     on it is shared with RCF (far_end_final, top of file).
-- It is NEVER true on an RCF / trunk / voicemail / API call: only
-- ivr_transfer sets it, and it is restored when the transfer returns.
local egress_return_mode = false
local egress_reject_cause = nil

-- ================================================================
-- SIP display-name hardening
-- ================================================================
-- A display name we hand to Kamailio in X-From-Name / X-Original-CID-Name is
-- rendered into TWO SIP quoted-string productions:
--   * From display  -- Kamailio assigns `$fn = "\"" + $hdr(...) + "\""`;
--     pv_set_xto_attr() case 3 (modules/pv/pv_core.c) inserts the value
--     VERBATIM (it adds no quotes itself — the cfg supplies them). Inside a
--     quoted-string only '"' and '\\' are structural (escapes), so THIS
--     function MUST keep stripping both, or a name could close the quotes
--     early and a following '<' '>' '@' ',' ';' ':' would restructure the
--     From header (a second angle-addr, a forged URI, a bogus parameter).
--   * PAI display   -- appended inside an explicit \"...\" quoted-string, same
--     two escapes.
-- So the quote/escape pair AND the structural set are stripped for BOTH, and
-- CR/LF/control bytes become spaces (header injection). An empty result never
-- reaches the wire: X-Original-CID-Name is only emitted when non-empty and
-- X-From-Name falls back to the From number (sanitize_display_name).
-- This matters because with the From pass-through
-- the name is CARRIER-SUPPLIED (the A-leg caller's display name) -- before it,
-- the only source was the admin-provisioned RCF line name.
-- Well-formed names ("Main Office", "Smith & Co.") are byte-identical through
-- this function, so applying it to the RCF line name changes nothing real.
local function sip_display_safe(name)
    local s = tostring(name or "")
    s = s:gsub("%c", " ")            -- CR/LF/control -> space (header injection)
    s = s:gsub('["\\<>@,;:]', "")    -- quoted-string escapes + angle-addr/URI/param delimiters
    s = s:gsub("%s+", " ")           -- collapse runs (a raw TAB became a space above)
    s = s:gsub("^%s+", "")
    s = s:gsub("%s+$", "")
    return s
end

-- As above, plus a 64-char cap and a fallback when nothing printable is left
-- (the cap is applied ONLY to caller-supplied names; the RCF line name keeps
-- its historical uncapped rendering via sip_display_safe()). Never nil.
-- '$', '{' and '}' are removed too: with the From pass-through on, this name
-- is exported (`export origination_caller_id_name=<name>`), and FreeSWITCH
-- expands ${var} / ${api(args)} inside every session:execute() argument
-- (switch_core_session_exec). A CARRIER-supplied display name must never be
-- able to run an API command (IVR contract §5 guard; a name without these
-- three characters is byte-identical).
local function sanitize_display_name(name, fallback)
    local s = sip_display_safe((tostring(name or ""):gsub("[%${}]", "")))
    if #s > 64 then
        s = s:sub(1, 64)
        s = s:gsub("%s+$", "")
    end
    if s == "" then
        s = sip_display_safe((tostring(fallback or ""):gsub("[%${}]", "")))
    end
    return s
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
--   SELECT carrier, pop, host(source_ip) AS term_ip, traffic_class,
--          COALESCE(priority_<zone>, priority) AS eff_priority
--   FROM carrier_trunks
--   WHERE direction IN ('outbound','both') AND enabled = true
--   ORDER BY eff_priority, id
--
-- traffic_class (migration 44: any|ld|tollfree) restricts which
-- destination classes a trunk may carry; the ONE cached list is
-- filtered PER CALL against classify_destination(forward_to) at
-- attempt-build time (never split into per-class caches). 8YY
-- destinations are STRICT (only 'tollfree' trunks) and FAIL CLOSED when
-- none is enabled; see the filter at the bridge.
--
-- Results are cached PROCESS-WIDE in a FreeSWITCH global variable
-- (freeswitch.get/setGlobalVariable — the exact SBC-health-cache
-- pattern above) for TERM_TRUNKS_TTL seconds: within the TTL no call
-- touches the DB; steady state is ~1 query/minute per FS.
-- Cache entry: "term_trunks_<zone>" = "<epoch>|carrier,pop,ip,class;..."
-- ("<epoch>|FALLBACK" is the negative-cache sentinel: DB error or
-- zero rows, re-checked after the same TTL). A 3-field pre-44 entry
-- (no class) still parses, as class 'any' — covers the one stale
-- cache generation across a rolling Lua deploy.
--
-- FAIL-OPEN (non-negotiable): DB error, zero usable rows, or an
-- unparsable cache entry all return nil, and the caller runs the
-- EXACT legacy hardcoded attempt loop (env primary/secondary SBC IPs
-- + X-Carrier enum header) — table-driven routing can never break
-- termination on a DB blip. The caller records the decision in the
-- term_trunks_source channel variable (db|fallback) which lands in
-- the CDR variables (same plain-channel-var path as inbound_carrier).
-- (TTL 60s and the 16-row cache cap: lib/term_trunks.lua M.TTL / M.CACHE_MAX.)
-- Cap at 4 trunks (x 2 SBCs = 8 bridge attempts) to bound worst-case
-- PDD across a fully-failing attempt sweep. Applied AFTER the per-call
-- traffic-class filter (strict-TF 2026-10): capping the raw list first
-- could truncate the only 'tollfree' trunk once >4 outbound rows exist,
-- and 8YY now FAILS CLOSED without one. The cached list itself is bounded
-- separately (lib/term_trunks.lua M.CACHE_MAX) so the global-var payload stays small.
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

-- ================================================================
-- fs_node / fs_zone: which FreeSWITCH node produced this call
-- ================================================================
-- Plain channel variables, so mod_json_cdr carries them in the CDR
-- `variables` object (switch_ivr.c:3304-3323 serialises every channel
-- variable, no allow-list) and the ingest can store cdrs.freeswitch_node.
-- WHY: the ingest used to read `FreeSWITCH-Hostname`, which is an EVENT
-- header and NEVER a channel variable, so the column was NULL on every
-- production row (the "calls unknown" legend on the Call Quality board);
-- and switch.conf.xml pins `switchname` to the same value ("voiceplatform")
-- on every node, so the CDR body's switchname is not zone-identifying
-- either. FS_NODE_ID (optional) distinguishes fs-1 from fs-2 within a zone;
-- otherwise "<zone>-fs". The ingest keeps its media-IP / switchname /
-- core-uuid fallbacks, so this is the PREFERRED source, not the only one.
-- The same block is in trunk_outbound.lua and api_outbound.lua so the field
-- is not populated for inbound RCF only. (`session` is guaranteed here: the
-- script returns at the top when there is none, so this can never run under
-- a session-less luarun.) Changing switch.conf.xml's `switchname` per node
-- would also fix the body fallback, but it moves FreeSWITCH-Switchname on
-- every event (ESL metrics exporter, Homer aliasing) — a separate change.
do
    local node_id = os.getenv("FS_NODE_ID")
    if not node_id or node_id == "" then
        node_id = fs_zone .. "-fs"
    end
    set_var("fs_node", node_id)
    set_var("fs_zone", fs_zone)
end

-- The trunk-list fetch/cache/validation, class coercion and destination
-- classifier live in lib/term_trunks.lua (shared with trunk_outbound.lua /
-- api_outbound.lua 8YY egress — ONE implementation, same process-wide
-- "term_trunks_<zone>" cache entry and format). These local wrappers keep
-- the call sites below unchanged; log lines keep the "[inbound_router]"
-- tag, so output is byte-identical to the pre-extraction script.
--
-- FAIL-OPEN if the lib itself cannot load (bad deploy): get_termination_trunks
-- returns nil, i.e. exactly the DB-blip path — the legacy hardcoded Bandwidth
-- loop runs. classify_destination is only consulted on the table-driven path
-- (which requires the lib), so it needs no separate fallback.
local term_trunks_lib = load_module("term_trunks")
if not term_trunks_lib then
    freeswitch.consoleLog("ERR", "[inbound_router] term_trunks failed to load — RCF termination uses the legacy fallback attempts\n")
end

-- classify_destination(number) -> 'tollfree' | 'ld' for the trunk class
-- filter (number_utils.classify_destination, inline fallback in the lib).
-- KEEP IN SYNC: number_utils.TOLLFREE_NPAS, lib/term_trunks.lua fallback
-- set, and the Kamailio SBC's route[TF_CLASSIFY] regex use the SAME NPAs.
local function classify_destination(number)
    return term_trunks_lib.classify_destination(number, number_utils)
end

-- get_termination_trunks(zone): ordered trunk list from carrier_trunks,
-- or nil => the caller MUST use the legacy hardcoded fallback attempts.
local function get_termination_trunks(zone)
    if not term_trunks_lib then
        return nil
    end
    return term_trunks_lib.get(zone, db, "inbound_router")
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

-- ================================================================
-- RFC 4028 session timer for the A-leg (this inbound channel)
-- ================================================================
-- sofia_session_timeout is the ONLY per-call knob mod_sofia reads for the
-- interval it answers with: sofia_answer_channel() starts from the
-- profile's session_timeout, then — when the channel has TFLAG_NAT
-- (aggressive-nat-detection on the internal profile flags every
-- SBC-relayed INVITE) — overrides it with SOFIA_NAT_SESSION_TIMEOUT (90),
-- and only AFTER that reads this variable (mod_sofia.c ~944-958). Without
-- it FS answered "Session-Expires: 120;refresher=uac" (90 raised to
-- sofia-sip's min_se 120) and tore Sinch-originated calls down at ~108s
-- with BYE 408 "Session timeout" when the carrier had not refreshed yet.
-- 1800 = the platform interval (refresh at ~900s by the negotiated
-- refresher). Plain set (NOT export): the A-leg answer is the only reader;
-- the B-leg (external profile) interval comes from the carrier's 200 OK.
-- Set at top level, before ANY answer/pre_answer/ring_ready/bridge on every
-- path (RCF, on-net chain, trunk-DID delivery, local ext, TEST_MODE, API
-- terminal) — harmless on the reject paths (never answered).
-- NOT a replacement for the profile param: "sip-session-timeout" in
-- internal.xml is not a mod_sofia param (sofia.c reads "session-timeout")
-- and is ignored; renaming it would yield the NAT override 90 -> cut at 81s.
set_var("sofia_session_timeout", "1800")

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

-- Try voicemail mailbox DID (encrypted voicemail v1: dedicated-DID mailboxes,
-- build plan D6). LAST in the cascade, so it can never shadow a revenue
-- product, and RCF/API/trunk calls never run it: the query only executes for
-- a DID that all three lookups missed (i.e. a call that would otherwise be a
-- 404). db.lookup_voicemail_did reads the number_routing view's voicemail arm
-- and is UNFILTERED on enabled/active (like resolve_destination) — a
-- suspended/disabled mailbox is rejected 603 by terminate_vvm, not 404.
local function lookup_voicemail_did()
    if not db or not db.lookup_voicemail_did then return nil end

    local vm_row = db.lookup_voicemail_did(normalized_did)
    if vm_row then
        freeswitch.consoleLog("DEBUG", "[" .. uuid .. "] Voicemail DID hit\n")
        return {
            product_type = "voicemail",
            customer_id = tonumber(vm_row.customer_id),
            product_ref_id = tonumber(vm_row.product_ref_id),   -- mailbox id
            product_enabled = (vm_row.product_enabled == "t" or vm_row.product_enabled == true),
            customer_status = vm_row.customer_status,
            traffic_grade = vm_row.traffic_grade or "standard",
        }
    end

    return nil
end

-- Try IVR DID (Visual IVR, docs/IVR_INTERFACES.md §5.2). LAST in the cascade
-- — after voicemail, matching customer_numbers PRECEDENCE (rcf, api, trunk,
-- voicemail, then ivr) — so it can never shadow another product and no
-- existing call ever runs it: the query only executes for a DID every other
-- arm missed (a call that would otherwise be a 404). db.lookup_ivr_did reads
-- the ivr_fs_number view ONCE (version pinning) and is UNFILTERED: enabled=f
-- or no published plan => 603 in terminate_ivr (or the IVR_ENABLED gate in
-- STEP 2), never 404 — the number is ours.
local function lookup_ivr_did()
    if not db or not db.lookup_ivr_did then return nil end

    local ivr_row = db.lookup_ivr_did(normalized_did)
    if ivr_row then
        freeswitch.consoleLog("DEBUG", "[" .. uuid .. "] IVR DID hit\n")
        local en = (ivr_row.enabled == "t" or ivr_row.enabled == true)
        return {
            product_type = "ivr",
            customer_id = tonumber(ivr_row.customer_id),
            product_ref_id = tonumber(ivr_row.ivr_number_id),
            -- ivr_fs_number.enabled already folds in customers.status='active'
            product_enabled = en and ivr_row.plan_json ~= nil,
            customer_status = "active",
            traffic_grade = ivr_row.traffic_grade or "standard",
            max_channels = tonumber(ivr_row.max_channels) or 0,
            ivr_row = ivr_row,
        }
    end

    return nil
end

freeswitch.consoleLog("DEBUG", "[" .. uuid .. "] STEP 1: DID lookup for " .. tostring(normalized_did) .. "\n")
-- RCF-V1: Execute lookups in order: RCF -> API -> Trunk -> Voicemail -> IVR
-- UCaaS extension routing removed — not needed for RCF-only deployment
local routing = lookup_rcf()
if not routing then
    routing = lookup_api_did()
end
if not routing then
    routing = lookup_trunk_did()
end
if not routing then
    routing = lookup_voicemail_did()
end
if not routing then
    routing = lookup_ivr_did()
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
    if egress_return_mode then
        -- IVR transfer (see egress_return_mode): no carrier fallback either,
        -- but the IVR engine owns the hangup (it plays the system prompt
        -- first and hangs up with THIS cause).
        egress_reject_cause = cause
        if log_msg then
            freeswitch.consoleLog("INFO", (log_msg:gsub("\n+$", "")) .. " [IVR transfer: returned to the IVR]\n")
        end
        return
    end
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
-- IVR-transfer helpers (egress_return_mode only — never on an RCF call)
-- ================================================================
-- (A far-end busy / ring-out ends an IVR transfer's failover sweep exactly
-- like an RCF forward's: far_end_final(), near the top of this file.)

-- Map an unanswered bridge result to the IVR engine's dispositions.
local function egress_disposition(disposition, last_cause, product)
    local ready = false
    pcall(function() ready = session:ready() end)
    local cause = (last_cause and last_cause ~= "") and last_cause or disposition
    local status
    if not ready then
        status = "caller_gone"
    elseif disposition == "USER_BUSY" or cause == "USER_BUSY" then
        status = "busy"
    elseif disposition == "NO_ANSWER" or cause == "NO_ANSWER" then
        status = "noanswer"
    else
        status = "failed"
    end
    return { status = status, cause = cause, product = product }
end

-- Concurrency pre-check for an IVR transfer onto a capped number (an RCF
-- DID's max_channels, or another IVR number's). The `limit` app's over-limit
-- action would HANG THE IVR CALLER UP; an IVR wants "busy" instead. So ask
-- mod_hash first (`limit_usage hash <realm> <id>`) and only run the limit app
-- when a slot is free. A slot THIS call already holds (an earlier transfer
-- to the same number) is not counted against it: mod_hash never increments
-- the same realm/id twice for one channel. Fails open (API error -> the limit
-- app enforces as usual). A race for the last slot ends as the limit app's
-- 486, exactly like an RCF call.
local function limit_would_block(ctx, realm, id, max)
    local key = realm .. "/" .. tostring(id)
    if ctx.limits_held and ctx.limits_held[key] then return false end
    local ok, out = pcall(function()
        return freeswitch.API():executeString("limit_usage hash " .. realm .. " " .. tostring(id))
    end)
    local n = ok and tonumber(tostring(out or ""):match("^%s*(%d+)")) or nil
    if not n then return false end
    return n >= max
end

local function limit_mark_held(ctx, realm, id)
    ctx.limits_held = ctx.limits_held or {}
    ctx.limits_held[realm .. "/" .. tostring(id)] = true
end

-- ================================================================
-- CDR A/B leg split: per-leg B-channel CDR variables
-- ================================================================
-- Contract: docs/CDR_LEG_SPLIT_CONTRACT.md. With mod_json_cdr log-b-leg=true
-- every originated B channel POSTs its own CDR. The ingest writes a B row
-- ONLY when the B channel carries cdr_leg=B AND cdr_carrier_leg=true, and
-- builds that row from these cdr_* vars (never from its A-leg defaults —
-- direction='inbound'/customer_id=0 would double-bill). So this fragment is
-- appended ONLY to CARRIER dial strings (the RCF off-net failover loops
-- below); on-net terminals (terminate_trunk PBX delivery, terminate_api,
-- local extension) and hard rejects never get it -> no B row.
--
-- Scoping: returned as a "[...]" PER-LEG block placed immediately before
-- the endpoint ("{globals}[cdr_*]sofia/external/..."). switch_ivr_originate
-- parses "[...]" into a local_var_event applied ONLY to that one new peer
-- channel; nothing is ever written back to the caller channel, so the A-leg
-- CDR is unchanged (no `export`, no `set` — export would ALSO set the var
-- on the A-leg and flip every A row to direction=outbound).
--
-- Values are the A-leg's FINAL values read back off the A channel at bridge
-- time (after on-net chain resolution / dispatch_terminal), so the B row's
-- call-level facts are verbatim copies of the A row's. Every value is
-- validated against a dial-string-safe charset (no , [ ] { } $ ' " or
-- whitespace) — an unsafe or absent value is OMITTED (the ingest then logs
-- + drops a B-leg missing cdr_customer_id/cdr_call_id; it never mis-inserts)
-- so attribution can fail closed but the CALL can never fail from this.
local CDR_B_LEG_VARS = {
    -- { B-leg var,                  A-leg source var,          validator }
    { "cdr_customer_id",             "customer_id",             "int"   },
    { "cdr_product_type",            "product_type",            "word"  },
    { "cdr_trunk_id",                "trunk_id",                "int"   },
    { "cdr_on_net",                  "on_net",                  "bool"  },
    { "cdr_on_net_hops",             "on_net_hops",             "int"   },
    { "cdr_origin_customer_id",      "origin_customer_id",      "int"   },
    { "cdr_terminating_customer_id", "terminating_customer_id", "int"   },
    { "cdr_inbound_carrier",         "inbound_carrier",         "token" },
    { "cdr_inbound_carrier_pop",     "inbound_carrier_pop",     "token" },
    { "cdr_sbc_id",                  "sip_h_X-SBC-ID",          "token" },
}

local function cdr_safe_value(v, kind)
    if v == nil then return nil end
    v = tostring(v)
    if v == "" then return nil end
    if kind == "int" then
        return v:match("^%d+$")
    elseif kind == "bool" then
        if v == "true" or v == "false" then return v end
        return nil
    elseif kind == "word" then
        return v:match("^[%a_]+$")
    elseif kind == "token" then
        return v:match("^[%w%._%-]+$")
    elseif kind == "callid" then
        -- A-leg uuid == inbound SIP Call-ID (internal profile
        -- inbound-use-callid-as-uuid=true), e.g. 218382592_122992403@67.231.13.185.
        -- The same value already rides every carrier dial string as X-CID.
        return v:match("^[%w%._%-@:+~!%%*/]+$")
    end
    return nil
end

-- attempt_no: 1-based count of bridges actually LAUNCHED for this call
-- (TCP-pre-check-skipped attempts create no B channel and are not counted,
-- so B rows are numbered 1..N without gaps).
local function cdr_b_leg_block(attempt_no)
    local parts = {
        "cdr_leg=B",
        "cdr_carrier_leg=true",
        "cdr_leg_attempt=" .. string.format("%d", attempt_no),
        "cdr_direction=outbound",
    }
    local a_uuid = get_var("uuid", nil)
    local call_id = cdr_safe_value(a_uuid, "callid")
    if call_id then
        parts[#parts + 1] = "cdr_call_id=" .. call_id
    else
        freeswitch.consoleLog("WARNING", string.format(
            "[inbound_router] cdr_call_id omitted (uuid %q not dial-string safe) — B-leg CDR will be dropped by ingest\n",
            tostring(a_uuid)))
    end
    for _, spec in ipairs(CDR_B_LEG_VARS) do
        local raw = get_var(spec[2], nil)
        local val = cdr_safe_value(raw, spec[3])
        if val then
            parts[#parts + 1] = spec[1] .. "=" .. val
        elseif raw ~= nil then
            freeswitch.consoleLog("WARNING", string.format(
                "[inbound_router] %s omitted from B-leg (A-leg %s=%q not dial-string safe)\n",
                spec[1], spec[2], tostring(raw)))
        end
    end
    return "[" .. table.concat(parts, ",") .. "]"
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
    -- IVR transfer: the Transfer block's ring time bounds the whole transfer,
    -- including an own RCF number's chain terminal (egress_return_mode only).
    if egress_return_mode and ctx.ring_timeout_override then
        ring_timeout = ctx.ring_timeout_override
    end
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
    -- Media handling: default media mode (FS decodes/relays; no proxy_media, no bypass)
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
    -- WHY default media mode (and NOT proxy_media):
    --   The RCF path sets neither bypass_media nor proxy_media. FS is a
    --   full B2BUA media anchor: both legs negotiate SDP with FS's public
    --   IP, FS reads/decodes each leg's RTP and writes it to the other
    --   leg. No re-INVITEs are needed. (proxy_media was removed from the
    --   RCF path once the Cloud NAT fix resolved the real audio issue;
    --   root CLAUDE.md "No proxy_media in RCF path". Only the trunk
    --   terminator sets proxy_media, further down in this file.)
    --   Because FS anchors and reads the media, it measures inbound RTP
    --   quality per leg (rtp_audio_in_*, incl. the RCF quality patch v1
    --   rtp_audio_in_seq_* / rtp_audio_in_rfc3550_* vars; see
    --   docker/freeswitch/CLAUDE.md "Quality patch v1").
    --
    --   SOA stays ENABLED (default), which is required for FS to
    --   set up the B-leg RTP media channel. The duplicate SDP answer
    --   Bandwidth can send (183 then 200 OK) is cosmetic in default
    --   media mode. Do NOT set sip_enable_soa=false: it disables the
    --   SOA engine entirely and FS never sets up B-leg media.
    --
    -- ringback: local tone while B-leg rings (generated by FS since
    --   FS is in the media path).
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
    --   From: "<name>" <sip:FROM@public_ip>      (FROM = original caller when
    --                                             pass_caller_id=true AND
    --                                             RCF_FROM_PASSTHROUGH=on,
    --                                             else the RCF DID — see below)
    --   P-Asserted-Identity: <sip:orig@ip>       (via X-Original-CID -> Kamailio)
    --   Remote-Party-ID: <sip:orig@ip>           (via sip_h_Remote-Party-ID)
    --   Diversion: <sip:RCF_DID@ip>;reason=unconditional   (ALWAYS the RCF DID)
    -- ================================================================

    -- ================================================================
    -- SIP From (carrier-facing) — pass_caller_id-gated pass-through
    -- ================================================================
    -- HISTORY: From was ALWAYS the RCF DID ("Bandwidth requires the RCF DID
    -- in 10-digit format for termination auth") with the original caller
    -- carried only in PAI/RPID. That requirement is UNVERIFIED for
    -- Bandwidth (IP-peered termination) and Sinch, so the change is gated:
    --   RCF_FROM_PASSTHROUGH env (DEFAULT OFF; only on|true|1 enables) AND
    --   the DID's pass_caller_id.
    --   pass_caller_id=true  -> From number = original caller; From display
    --                           = original caller's name, handed over in the
    --                           DEDICATED X-From-Name header; Diversion = the
    --                           RCF DID. RFC 8224 §6.2 verifiers match the
    --                           PASSporT orig (= PAI = original caller)
    --                           against From — this makes From agree with it.
    --   pass_caller_id=false -> EXACTLY the pre-change behavior: From and
    --                           PAI = the masking DID, display = the RCF
    --                           line name (X-Original-CID-Name).
    -- P-ASSERTED-IDENTITY IS UNTOUCHED IN BOTH MODES. Kamailio builds BOTH
    -- the From display ($fn) and the PAI display from X-Original-CID-Name, so
    -- overloading that header to carry the caller's name would silently
    -- change the PAI display too (customers today see the RCF line name
    -- there). X-From-Name exists precisely to keep the two apart: Kamailio
    -- prefers it for $fn and never uses it for PAI, and it is absent
    -- whenever the pass-through is not active.
    -- Ships DARK: enable per zone (RCF_FROM_PASSTHROUGH=on in the media VM's
    -- .env + recreate) only after (1) that zone's SBCs are on the #120+#122
    -- Kamailio build — the base RCF-V1 kamailio.cfg does not strip
    -- X-From-Name, so an older SBC would leak the caller's display name to
    -- the carrier — and (2) one live canary RCF call per carrier PoP
    -- (Bandwidth Dallas + LA) confirms acceptance of a non-account TN in From.
    --
    -- Digit form = the same form the DID used: to_10digit for a NANP caller
    -- (Kamailio E164_EGRESS TN_E164 turns 10/11-digit into +E.164; gate off
    -- renders it verbatim) and full +E.164 for a non-NANP caller (TN_E164
    -- passes '+' numbers through — never a bare 12-digit run). A non-numeric
    -- original caller (anonymous / Restricted / empty) keeps the DID in From
    -- so the carrier never sees From: anonymous@ (PAI/RPID unchanged).
    --
    -- HOW FS BUILDS From: the exported origination_caller_id_* below is what
    -- wins (switch_ivr_originate.c: export vars are copied into var_event at
    -- ~1635 BEFORE effective_caller_id_* is mirrored at ~1649, and the first
    -- origination_caller_id_number header wins at ~2652); the FusionPBX-style
    -- outbound_caller_id_* vars are set for CDR/ops parity (no FS core
    -- consumer). Both are set to the same value.
    local outbound_did = to_10digit(normalized_did)
    local outbound_original_cid = to_10digit(original_caller_number)
    -- E.164 versions for SIP identity headers (PAI, RPID, Diversion)
    -- Carriers require +1 prefix per E.164; bare 10-digit leaks into PAI otherwise
    local e164_original_cid = normalize_did(original_caller_number)
    local e164_did = normalize_did(normalized_did)
    local rcf_name = routing.rcf_name

    local from_passthrough = rcf_from_passthrough and pass_caller_id
    local from_number = outbound_did
    local from_name = outbound_did
    -- X-Original-CID-Name feeds the PAI display (and, absent X-From-Name, the
    -- From display): ALWAYS the RCF line name, exactly as before this gate.
    local cid_display_name = sip_display_safe(rcf_name)
    -- X-From-Name feeds ONLY the From display, and only while the
    -- pass-through is active (nil => the header is never emitted => Kamailio
    -- falls back to X-Original-CID-Name, i.e. today's behavior byte for byte).
    local from_display_name = nil
    if from_passthrough then
        -- NANP caller -> 10-digit (the form the RCF DID uses; Kamailio's
        -- E164_EGRESS TN_E164 lifts 10/11-digit to +E.164, and with the gate
        -- off it renders verbatim, matching today's RCF-DID rendering).
        -- Non-NANP caller -> full +E.164 (TN_E164 passes '+' through, so this
        -- can never degrade into a bare 12-digit run).
        if e164_original_cid:match("^%+1%d%d%d%d%d%d%d%d%d%d$") then
            from_number = outbound_original_cid
        -- Length bounds mirror Kamailio route[TN_E164]'s +E.164 passthrough
        -- test EXACTLY ("^[+][1-9][0-9]{7,14}$" = '+' plus 8..15 digits), so
        -- anything we put in From is a shape TN_E164 recognises.
        elseif e164_original_cid:match("^%+[1-9]%d+$") and #e164_original_cid >= 9 and #e164_original_cid <= 16 then
            from_number = e164_original_cid
        else
            -- anonymous / Restricted / empty / non-numeric: keep the RCF DID
            -- in From so the carrier never sees From: anonymous@ .
            from_passthrough = false
            freeswitch.consoleLog("WARNING", string.format(
                "[%s] From pass-through: original caller %q is not a usable TN — keeping the RCF DID in From\n",
                uuid, tostring(original_caller_number)))
        end
    end
    if from_passthrough then
        from_name = sanitize_display_name(original_caller_name, from_number)
        from_display_name = from_name
    end
    session:setVariable("outbound_caller_id_number", from_number)
    session:setVariable("outbound_caller_id_name", from_name)
    -- CDR/ops breadcrumb: which From mode this leg actually used.
    set_var("rcf_from_passthrough", from_passthrough and "true" or "false")

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

    -- X-Original-CID-Name: the RCF line name configured in the portal (e.g.
    -- "Main Office"). Kamailio puts it on P-Asserted-Identity always, and on
    -- the From display whenever X-From-Name is absent — i.e. unchanged.
    if cid_display_name and cid_display_name ~= "" then
        session:setVariable("sip_h_X-Original-CID-Name", cid_display_name)
    end

    -- X-From-Name: From-display-only override, emitted ONLY while the
    -- pass-through is active. Kamailio prefers it for $fn and NEVER uses it
    -- for PAI, so the PAI display stays the RCF line name in both modes.
    -- Kamailio strips it from the carrier-bound INVITE (TO_CARRIER internal
    -- X-* cleanup) and spoof-strips any wire-supplied copy at every ingress.
    if from_display_name and from_display_name ~= "" then
        session:setVariable("sip_h_X-From-Name", from_display_name)
    end

    freeswitch.consoleLog("INFO", string.format(
        "[inbound_router] CID setup (FusionPBX-style): from=%s from_passthrough=%s effective_cid=%s original=%s pass=%s did=%s\n",
        from_number,
        tostring(from_passthrough),
        pass_caller_id and original_caller_number or normalized_did,
        original_caller_number,
        tostring(pass_caller_id),
        normalized_did
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

        -- Export the From identity to the B-leg. This exported pair is what
        -- mod_sofia renders as the From header (see "SIP From" above):
        -- original caller when the pass-through is active, else the RCF DID.
        pcall(function() session:execute("export", "origination_caller_id_number=" .. from_number) end)
        pcall(function() session:execute("export", "origination_caller_id_name=" .. from_name) end)

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

    -- RFC 4028 session timers: NOTHING to export here. The former
    -- `export sip_session_timeout/sip_minimum_session_expires/enable_timer`
    -- was a no-op (mod_sofia reads none of those names) and was removed
    -- 2026-09-24. The A-leg interval is set above via sofia_session_timeout
    -- (the only per-call knob); the B-leg's Session-Expires/Min-SE are added
    -- by Kamailio route[TO_CARRIER] (1800;refresher=uac, Min-SE 90) and the
    -- negotiated value comes back in the carrier's 200 OK. The same three
    -- names inside the bridge {} dial strings below are equally inert; they
    -- are left in place only to keep the dial strings byte-identical.

    -- ================================================================
    -- Per-DID concurrent call limit (mod_hash, no Redis needed)
    -- ================================================================
    -- max_channels=0 means unlimited (default). When set >0, FreeSWITCH
    -- tracks concurrent calls per DID using the in-memory hash backend.
    -- If the limit is reached, the call is rejected with 486 Busy Here.
    -- On-net note (design §6): this runs against the TERMINAL DID only
    -- (intermediate RCF hops emit no B-leg, so they have no concurrency).
    local max_concurrent = tonumber(routing.max_channels) or 0
    if max_concurrent > 0 and egress_return_mode
        and limit_would_block(ctx, "inbound", normalized_did, max_concurrent) then
        -- IVR transfer onto a full RCF number: "busy" goes back to the IVR
        -- (its No-answer exit) instead of the limit app's 486 hangup.
        freeswitch.consoleLog("WARNING", string.format(
            "[inbound_router] DID %s at its %d concurrent call limit — IVR transfer busy\n",
            normalized_did, max_concurrent))
        return { status = "busy", cause = "USER_BUSY", product = "rcf" }
    end
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
        if egress_return_mode then
            limit_mark_held(ctx, "inbound", normalized_did)
        end
    end

    -- ================================================================
    -- SBC + Carrier failover: table-driven attempts (carrier_trunks)
    -- with legacy hardcoded fallback
    -- ================================================================
    -- For local extensions, there is only the single dial_string built above.
    -- For PSTN, attempts come from get_termination_trunks(fs_zone) — the
    -- TED-managed carrier_trunks table (60s process-wide cache) — filtered
    -- per call by traffic_class (any/ld/tollfree vs classify_destination,
    -- see the filter below) and built TRUNK-MAJOR: both SBCs are tried on
    -- trunk 1 before moving to trunk 2, preserving today's shape. With the
    -- 2-row Bandwidth seeds ('any'/'ld' class — eligible for every non-8YY
    -- call, NEVER for 8YY, which is tollfree-trunk-only) this is
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

    -- CDR leg split: 1-based count of CARRIER bridges actually launched for
    -- this call (shared by whichever PSTN loop runs below; skipped attempts
    -- are not counted). Feeds cdr_leg_attempt via cdr_b_leg_block().
    local carrier_legs_launched = 0

    -- IVR transfer: this call may already have bridged (and failed) earlier
    -- in the IVR, so the result variables are cleared first — a sweep whose
    -- every attempt is skipped must never read an older disposition.
    if egress_return_mode then
        session:setVariable("originate_disposition", "")
        session:setVariable("last_bridge_hangup_cause", "")
    end

    if is_local_forward then
        -- Local extension: single bridge attempt (no SBC/carrier failover).
        -- ON-NET terminal: deliberately NO cdr_b_leg_block() -> no B row.
        stir_outcome_reset()
        pcall(function()
            session:execute("bridge", dial_string)
        end)
        stir_outcome_capture(uuid, "local")
    else
        local term_trunks = get_termination_trunks(fs_zone)

        if term_trunks then
        -- PSTN: table-driven SBC + carrier failover loop (carrier_trunks)
        set_var("term_trunks_source", "db")

        -- Traffic-class filter (migration 44, strict-TF 2026-10). Filtered
        -- PER CALL on the one cached list; ordering is untouched.
        -- CONTRACT by destination class (classify_destination: 'tollfree'
        -- = NANP 8YY, else 'ld'):
        --   * 'ld'       -> trunks of class 'any' or 'ld'. If none, fall back
        --                   to the FULL list (operator misconfig — never
        --                   strand an LD call; unchanged pre-TF behavior).
        --   * 'tollfree' -> STRICT: ONLY class 'tollfree' trunks (Sinch
        --                   OSAO). 'any' AND 'ld' trunks are never eligible
        --                   (prod has no 'any' rows — Bandwidth and the Sinch
        --                   orig rows are relabeled 'ld'; an 'any' row added
        --                   later stays eligible for 'ld' only). If no
        --                   'tollfree' trunk is enabled the call FAILS CLOSED:
        --                   ERR log, term_class_blocked=tollfree breadcrumb
        --                   (CDR variables), hard_reject NO_ROUTE_DESTINATION
        --                   (SIP 404 — terminal, no carrier retry storm) with
        --                   lua_routed=true. Pushing 8YY onto Bandwidth or the
        --                   LD-only Sinch atlanta-ld trunk is a contract
        --                   violation, so there is NO fallback here.
        -- NOTE: the LEGACY FALLBACK loop below (DB blip / zero rows /
        -- unparsable cache) has no class awareness and CAN still route 8YY
        -- via Bandwidth — that is the fail-open contract, deliberately left
        -- untouched.
        local dest_class = classify_destination(forward_to)
        freeswitch.consoleLog("DEBUG", string.format(
            "[%s] Destination %s classified as %s for trunk selection\n",
            uuid, forward_to, dest_class))
        -- Shared filter (lib/term_trunks.lua filter_for_class — the same
        -- rule trunk_outbound/api_outbound apply to 8YY).
        local eligible_trunks = term_trunks_lib.filter_for_class(term_trunks, dest_class)
        if #eligible_trunks == 0 then
            if dest_class == "tollfree" then
                freeswitch.consoleLog("ERR", string.format(
                    "[%s] No enabled 'tollfree' termination trunk for 8YY %s (DID %s) — failing closed NO_ROUTE_DESTINATION (8YY never terminates via 'any'/'ld' trunks)\n",
                    uuid, forward_to, normalized_did))
                set_var("term_class_blocked", "tollfree")
                if egress_return_mode then
                    -- IVR transfer: still never via an 'any'/'ld' trunk, but
                    -- the caller continues at the block's No-answer exit.
                    return { status = "failed", cause = "NO_ROUTE_DESTINATION", product = "pstn" }
                end
                hard_reject("NO_ROUTE_DESTINATION",
                    "[" .. uuid .. "] 8YY termination blocked: no tollfree trunk enabled")
                return
            end
            freeswitch.consoleLog("WARNING", string.format(
                "[%s] No termination trunk carries class %s (no 'any' rows either) — using the full trunk list\n",
                uuid, dest_class))
            eligible_trunks = term_trunks
        end
        -- Attempt cap (TERM_TRUNKS_MAX), post-filter: first N eligible in
        -- eff_priority order. For <= 4 outbound rows this is a no-op.
        if #eligible_trunks > TERM_TRUNKS_MAX then
            freeswitch.consoleLog("WARNING", string.format(
                "[%s] %d eligible %s trunks — trying the first %d (8-attempt cap)\n",
                uuid, #eligible_trunks, dest_class, TERM_TRUNKS_MAX))
            eligible_trunks = term_trunks_lib.cap(eligible_trunks, TERM_TRUNKS_MAX)
        end

        -- Trunk-major attempt table: for each trunk (already in
        -- eff_priority order) try the primary SBC, then the failover SBC.
        -- (lib/term_trunks.lua build_attempts — label "<carrier>-<pop>".)
        local bridge_attempts = term_trunks_lib.build_attempts(
            eligible_trunks, sbc_proxy_ip, sbc_proxy_ip_failover)
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
                -- are unchanged. The per-leg "[cdr_*]" block (CDR leg split,
                -- cdr_b_leg_block above) scopes the B-row vars to THIS B
                -- channel only.
                carrier_legs_launched = carrier_legs_launched + 1
                -- Shared builder (lib/term_trunks.lua dial_string) renders
                -- "{<lead>,sip_h_X-Carrier-IP=..,sip_h_X-Carrier-Label=..,
                -- sip_h_X-CID=..,<inert timer trio>}[cdr_*]sofia/external/
                -- <forward_to>@<sbc>:5060" — byte-identical to the former
                -- inline format (harness-verified against the pre-change script).
                local attempt_dial = term_trunks_lib.dial_string(
                    string.format("ignore_early_media=false,progress_timeout=%d,call_timeout=%d",
                        bridge_progress_timeout, ring_timeout),
                    attempt,
                    sip_call_id,
                    cdr_b_leg_block(carrier_legs_launched),
                    forward_to
                )

                -- carrier_used reflects the WINNING attempt (same semantics
                -- as the legacy loop, new value shape "<carrier>-<pop>").
                set_var("carrier_used", attempt.carrier_label)

                freeswitch.consoleLog("INFO", string.format(
                    "[%s] RCF bridge attempt %d/%d (%s): %s -> %s@%s carrier_ip=%s\n",
                    uuid, i, total_attempts, attempt.label, normalized_did, forward_to, attempt.sbc, attempt.ip
                ))

                stir_outcome_reset()
                pcall(function()
                    session:execute("bridge", attempt_dial)
                end)
                stir_outcome_capture(uuid, attempt.label)
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
                if far_end_final(disposition, ring_timeout) then
                    freeswitch.consoleLog("INFO", string.format(
                        "[%s] RCF far end %s on attempt %d/%d: not re-dialing %s on another route\n",
                        uuid, disposition, i, total_attempts, forward_to
                    ))
                    break
                end
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
        -- attempts (env primary/secondary + X-Carrier enum). The only
        -- addition is the per-leg "[cdr_*]" CDR-split block (B channel only;
        -- no SIP header, no A-leg var).
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
                -- CDR leg split: the per-leg "[cdr_*]" block is the ONLY
                -- addition to the pre-table dial string (B channel only).
                carrier_legs_launched = carrier_legs_launched + 1
                local attempt_dial = string.format(
                    "{ignore_early_media=false,progress_timeout=%d,call_timeout=%d,sip_h_X-Carrier=%s" ..
                    ",sip_h_X-CID=%s" ..
                    ",sip_session_timeout=1800,sip_minimum_session_expires=90,enable_timer=true" ..
                    "}%ssofia/external/%s@%s:5060",
                    bridge_progress_timeout,
                    ring_timeout,
                    attempt.carrier,
                    sip_call_id,
                    cdr_b_leg_block(carrier_legs_launched),
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

                stir_outcome_reset()
                pcall(function()
                    session:execute("bridge", attempt_dial)
                end)
                stir_outcome_capture(uuid, attempt.label)
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
                if far_end_final(disposition, ring_timeout) then
                    freeswitch.consoleLog("INFO", string.format(
                        "[%s] RCF far end %s on attempt %d/4: not re-dialing %s on another route\n",
                        uuid, disposition, i, forward_to
                    ))
                    break
                end
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

    -- The forwarded phone itself was busy / rang out (see far_end_final):
    -- hand THAT back (486 / 480), not a 503 — a 503 makes the originating
    -- carrier retry the call on another route and ring the phone again.
    -- An IVR transfer (egress_return_mode) never hangs up here: it returns
    -- the disposition to the engine below (the block's No-answer exit).
    if not egress_return_mode and far_end_final(disposition, ring_timeout) then
        hangup(disposition, string.format(
            "[%s] RCF %s -> %s: far end %s, returned to the caller (no failover, no 503)",
            uuid, normalized_did, forward_to, disposition))
        return
    end

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
        if egress_return_mode then
            -- IVR transfer: back to the engine (its No-answer exit), no 503.
            return egress_disposition(disposition, last_bridge_hangup, "pstn")
        end
        hangup("NORMAL_TEMPORARY_FAILURE",
            "[" .. uuid .. "] RCF bridge failed, returning 503 (DID was found, carrier unreachable)")
        return
    end
    if egress_return_mode then
        return { status = "answered", product = "pstn" }
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
    return { status = "delivered", product = "api" }
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
        if egress_return_mode then
            -- IVR transfer onto a trunk DID with no PBX: No-answer exit.
            return { status = "failed", cause = "NO_ROUTE_DESTINATION", product = "trunk" }
        end
        hangup("NO_ROUTE_DESTINATION", "[" .. uuid .. "] No PBX endpoint configured for trunk")
    else
        -- Media anchoring (proxy_media: trunk path ONLY; RCF runs in default media mode) + ringback (same as RCF)
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

        -- ================================================================
        -- ON-NET RCF -> trunk-DID delivery: mark the PBX leg DIVERTED
        -- ================================================================
        -- Reached through >=1 RCF forwarding hop (ctx.hops > 0; the chain
        -- loop records the LAST forwarding RCF DID in ctx.last_rcf_did). Set
        -- on this leg exactly what terminate_rcf sets on a diverted carrier
        -- leg so Kamailio's X-PBX-Dest div arm (kamailio.cfg "STIR egress
        -- (pbx ..)", gated on X-Attestation=div AND a Diversion header AND a
        -- base chain) is no longer dormant:
        --   sip_h_Diversion      <- terminate_rcf "Diversion header indicates
        --                           the call was forwarded" (there: the
        --                           10-digit DID, which Kamailio E164_EGRESS
        --                           normalizes on the carrier leg; the PBX leg
        --                           has no normalizer, so use +E.164 here)
        --   sip_h_X-Attestation  <- terminate_rcf 'session:setVariable(
        --                           "sip_h_X-Attestation", "div")'
        -- (No X-Original-CID here: on the PBX path Kamailio derives the STIR
        --  orig claim from $fU -- the From user, i.e. effective_caller_id_number
        --  set above -- and X-Original-CID is read ONLY in route[TO_CARRIER].
        --  remove_hf_re("^[Xx]-") strips it before the PBX, so setting it would
        --  be a header nothing reads plus a channel variable in every CDR.)
        --   sip_h_X-In-Identity  <- already on this A-leg (mod_sofia stored
        --                           the inbound X-In-Identity header as
        --                           sip_h_X-In-Identity) and copied to the
        --                           bridged leg with every other sip_h_*
        --                           variable — nothing to re-set here (the
        --                           old self-reassignment was a no-op).
        --   stir_attest_intent / stir_inbound_signed / stir_verstat* /
        --   stir_inbound_attest <- terminate_rcf "STIR/SHAKEN CDR facts"
        -- Display name (same pass_caller_id gate as the carrier leg's From):
        -- passing -> the composed presented name (original caller, sanitized);
        -- masked  -> the masking hop's RCF line name (ctx.masking_name), or the
        -- masking DID digits when the line has no name. A DIRECT trunk inbound
        -- (hops == 0) is byte-for-byte unchanged: none of this runs.
        local diverted_via = ctx.last_rcf_did
        if (tonumber(ctx.hops) or 0) > 0 and diverted_via and diverted_via ~= "" then
            local div_e164 = normalize_did(diverted_via)
            session:setVariable("sip_h_Diversion",
                "<sip:" .. div_e164 .. "@" .. external_sip_ip .. ">;reason=unconditional")
            session:setVariable("sip_h_X-Attestation", "div")
            if ctx.pass_effective then
                set_var("effective_caller_id_name",
                    sanitize_display_name(ctx.presented_name, original_caller))
            else
                set_var("effective_caller_id_name",
                    sanitize_display_name(ctx.masking_name, ctx.presented_cid))
            end
            local in_identity = get_var("sip_h_X-In-Identity", nil)
            set_var("stir_attest_intent", "div")
            set_var("stir_inbound_signed", (in_identity and in_identity ~= "") and "1" or "0")
            set_var("stir_verstat", get_var("sip_h_X-Verstat", ""))
            set_var("stir_verstat_source", get_var("sip_h_X-Verstat-Source", ""))
            set_var("stir_inbound_attest", get_var("sip_h_X-Inbound-Attest", ""))
            freeswitch.consoleLog("INFO", string.format(
                "[%s] On-net RCF->trunk delivery marked div: Diversion=%s hops=%s pass=%s presented=%s inbound_signed=%s\n",
                uuid, div_e164, tostring(ctx.hops), tostring(ctx.pass_effective),
                tostring(ctx.presented_cid), (in_identity and in_identity ~= "") and "1" or "0"))
        end

        -- Build dial string to customer PBX through Kamailio SBC
        -- Same pattern as RCF: FS -> Kamailio (sbc_proxy_ip:5060) -> PBX
        -- CDR leg split: this is an ON-NET / PBX delivery, NOT a carrier leg —
        -- deliberately NO cdr_b_leg_block() (contract: no B row; the B-leg
        -- POST carries no cdr_carrier_leg=true so the ingest writes nothing).
        -- X-PBX-Dest header tells Kamailio where to relay the call
        local bridge_did = normalized_did:gsub("^%+", "")
        local pbx_ip = endpoint_ips[1]

        set_var("sip_h_X-PBX-Dest", pbx_ip)

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

        -- IVR transfer onto an own trunk number: the Transfer block's ring
        -- time replaces the fixed 60 s (egress_return_mode only; every
        -- trunk/RCF call keeps call_timeout=60 byte for byte).
        local pbx_call_timeout = 60
        if egress_return_mode and ctx.ring_timeout_override then
            pbx_call_timeout = math.floor(tonumber(ctx.ring_timeout_override) or 60)
        end
        local dial_string = string.format(
            "{ignore_early_media=false,sip_enable_soa=false,call_timeout=%d" ..
            ",sip_session_timeout=1800,sip_minimum_session_expires=90,enable_timer=true" ..
            "}sofia/external/%s@%s:5060",
            pbx_call_timeout,
            bridge_did,
            sbc_proxy_ip
        )

        freeswitch.consoleLog("INFO", string.format(
            "[%s] Trunk inbound bridge (via SBC): %s X-PBX-Dest=%s\n",
            uuid, dial_string, pbx_ip
        ))

        -- Mark as lua-routed
        set_var("lua_routed", "true")

        -- X-Stir-Outcome arrives on this leg's replies via Kamailio's
        -- onreply_route[PBX_REPLY_HANDLER] (mode=pbx) — same A-leg capture
        -- as the carrier loop.
        if egress_return_mode then
            -- IVR transfer: never read an earlier transfer's result.
            session:setVariable("originate_disposition", "")
            session:setVariable("last_bridge_hangup_cause", "")
        end
        stir_outcome_reset()
        session:execute("bridge", dial_string)
        stir_outcome_capture(uuid, "pbx " .. tostring(pbx_ip))

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
        if egress_return_mode then
            if disposition == "SUCCESS" then
                return { status = "answered", product = "trunk" }
            end
            return egress_disposition(disposition, get_var("last_bridge_hangup_cause", ""), "trunk")
        end
    end
end

-- ================================================================
-- Terminator: Voicemail  (dest = terminal mailbox row, ctx = state)
-- ================================================================
-- Encrypted voicemail v1 (docs/ENCRYPTED_VOICEMAIL_INTERFACES.md §6, build
-- plan D6/D8). Reached two ways, both through dispatch_terminal (which has
-- already set customer_id = mailbox owner, product_type = voicemail and the
-- on-net CDR set):
--   * DIRECT: a mailbox DID dialed from the PSTN (STEP-1 voicemail arm;
--     on_net=false, hops=0).
--   * ON-NET: an RCF forward_to (or chain) whose terminal is a mailbox DID —
--     resolved by the number_routing voicemail arm in the chain loop; NO
--     carrier B-leg is ever built (this terminator never bridges).
-- Answers on-platform and hands the call to lib/vm_box.lua (answer -> API
-- mailbox lookup -> greeting -> beep -> record to the /dev/shm/vm tmpfs ->
-- hang up -> deposit to the API -> unlink). The module is loaded LAZILY here so
-- RCF/trunk calls never read or parse it.
-- Emits ZERO carrier legs by construction, so no cdr_b_leg_block (no B row).
local function terminate_vvm(dest, ctx)
    local uuid = ctx.uuid
    -- The DID was found and Lua owns the call from here: never let the
    -- dialplan fallback mask an early exit with its 503/404.
    set_var("lua_routed", "true")

    -- Disabled/suspended mailbox -> 603. The on-net chain loop already
    -- rejected this case before dispatch; the DIRECT arm is unfiltered on
    -- purpose so it lands here (number is ours -> 603, never 404).
    if (not dest.product_enabled) or (dest.customer_status ~= "active") then
        hard_reject("CALL_REJECTED", string.format(
            "[%s] Voicemail mailbox DID %s is disabled/suspended "
            .. "(product_enabled=%s customer_status=%s) — 603",
            uuid, tostring(dest.did), tostring(dest.product_enabled),
            tostring(dest.customer_status)))
        return
    end

    local mailbox_id = tonumber(dest.product_ref_id)
    if not mailbox_id or mailbox_id < 1 or mailbox_id ~= math.floor(mailbox_id) then
        hard_reject("NORMAL_TEMPORARY_FAILURE", string.format(
            "[%s] Voicemail DID %s has no valid mailbox id (%s) — 503",
            uuid, tostring(dest.did), tostring(dest.product_ref_id)))
        return
    end

    local vm_box = load_module("vm_box")
    if not vm_box or type(vm_box.run) ~= "function" then
        hard_reject("NORMAL_TEMPORARY_FAILURE", string.format(
            "[%s] Voicemail module unavailable — 503 for mailbox %d", uuid, mailbox_id))
        return
    end

    -- Presented caller: the composed identity (design §5 "last false hop
    -- wins"). Direct dial: the original caller. On-net: a masking RCF hop
    -- (pass_caller_id=false) shows its DID, exactly like terminate_trunk.
    local caller_number = ctx.presented_cid or ""
    local caller_name = ctx.presented_name or ""
    if caller_name == caller_number then
        caller_name = ""   -- the router defaults an absent name to the number
    end

    freeswitch.consoleLog("INFO", string.format(
        "[%s] Voicemail: mailbox=%d did=%s customer=%s on_net=%s hops=%s\n",
        uuid, mailbox_id, tostring(dest.did), tostring(dest.customer_id),
        tostring(ctx.on_net), tostring(ctx.hops)))

    local ok, err = pcall(vm_box.run, session, {
        uuid          = uuid,
        mailbox_id    = mailbox_id,
        did           = dest.did,
        caller_number = caller_number,
        caller_name   = caller_name,
        call_uuid     = uuid,
        fs_node       = get_var("fs_node", ""),
        zone          = get_var("fs_zone", fs_zone),
    })
    if not ok then
        -- vm_box.run is internally pcall-guarded (and unlinks its tmpfs files
        -- on every path); this is belt-and-braces only.
        freeswitch.consoleLog("ERR", string.format(
            "[%s] Voicemail flow raised: %s\n", uuid, tostring(err)))
        pcall(function() session:hangup("NORMAL_TEMPORARY_FAILURE") end)
    end
    return { status = "delivered", product = "voicemail" }
end

-- Product-agnostic dispatch map (design §2/§8). A future product enrolls by
-- adding a UNION-ALL arm to number_routing + a terminator here — detection,
-- the hop loop, loop/limit/reject, and CDR emission stay untouched.
-- (Visual IVR: TERMINATORS.ivr = terminate_ivr is registered below, only
-- while IVR_ENABLED is on — contract §5.1.)
local TERMINATORS = {
    rcf       = terminate_rcf,
    api       = terminate_api,
    trunk     = terminate_trunk,
    voicemail = terminate_vvm,
}

-- Set common CDR/terminal channel vars on the resolved TERMINAL destination,
-- then dispatch to its product terminator (design §4/§5). customer_id is set to
-- the TERMINAL customer so rate_cdr() (which rates customer_id) is unchanged.
-- IVR transfer (egress_return_mode): the A-leg keeps the IVR's customer_id /
-- product_type (contract §5.5 — the CDR row is the IVR call; its transfer
-- B-legs carry cdr_product_type=ivr); the terminal facts below still record
-- where the transfer went. dest.terminator lets the IVR's pseudo-hop (product
-- ivr) use the RCF egress.
-- Returns the terminator's result (a disposition table in egress_return_mode;
-- ignored on every other call).
local function dispatch_terminal(dest, ctx)
    if not egress_return_mode then
        set_var("customer_id", tostring(dest.customer_id))
        set_var("product_type", dest.product_type)
    end
    set_var("terminating_customer_id", tostring(dest.customer_id))
    set_var("origin_customer_id", tostring(ctx.origin_customer_id))
    set_var("on_net", ctx.on_net and "true" or "false")
    set_var("on_net_hops", tostring(ctx.hops))
    if dest.trunk_id then
        set_var("trunk_id", tostring(dest.trunk_id))
    end
    local fn = TERMINATORS[dest.terminator or dest.product_type]
    if not fn then
        -- Should never happen (view only yields known product types) — fail
        -- closed rather than fall through to the carrier.
        hard_reject("EXCHANGE_ROUTING_ERROR", string.format(
            "[%s] No terminator for product_type=%s — hard reject\n",
            ctx.uuid, tostring(dest.product_type)))
        return
    end
    return fn(dest, ctx)
end

-- ================================================================
-- RCF branch point: 3-way on-net decision + in-memory chain
-- ================================================================
-- (design §2/§5/§6) — a chain of RCF->RCF forwards resolves entirely in
-- memory (DB lookups only, NO SIP per hop) until it reaches a terminal:
-- an off-net PSTN number, a local extension, or another product's DID.
-- EXACTLY ONE B-leg is ever emitted (by the terminal terminator).
--
-- Extracted VERBATIM from the module-level `if product_type == "rcf"` body
-- into a callable function (the only edits: `break` -> `return`, the IVR gate
-- beside the API gate, and the optional own-number check) so an IVR Transfer
-- block reuses it with a pseudo-hop (ivr_transfer). The RCF call path calls it
-- once with the STEP-1 row and ignores the result — byte-identity proven by
-- tests/lua/ivr_egress_identity_harness.lua against the pre-extraction router.
--   start              the first hop (an RCF row, or the IVR pseudo-hop)
--   own_customer_id    IVR "own number" transfers only: the FIRST resolution
--                      must be a platform number of this customer, else the
--                      transfer is rejected like a disabled terminal (603) —
--                      contract §6 "ownership changed since publish".
local function run_onnet_chain(start, ctx, own_customer_id)
    local cur = start
    local first = true

    while true do
        -- Compose caller-ID for THIS hop ("last false hop wins", design §5).
        -- The terminal RCF hop participates too, so a single off-net RCF DID
        -- yields exactly today's CID behavior.
        if cur.pass_caller_id == false then
            ctx.pass_effective = false
            ctx.presented_cid = cur.did
            ctx.presented_name = cur.did
            -- Masking hop's RCF line name — used ONLY by terminate_trunk for
            -- the on-net PBX leg's display name (terminate_rcf keeps using the
            -- TERMINAL line's name via X-Original-CID-Name, unchanged).
            ctx.masking_name = cur.product_name
        end

        local fwd = cur.forward_to

        -- (1) Local extension terminal — existing user/<ext> bridge (unchanged).
        if is_local_extension(fwd) then
            ctx.on_net = ctx.on_net or false
            return dispatch_terminal(cur, ctx)
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

        -- IVR "own number" transfer: the dialed number must still be one of
        -- the IVR owner's platform numbers (published against
        -- customer_numbers; re-checked here at call time).
        if first and own_customer_id then
            if not resolved or tonumber(resolved.customer_id) ~= tonumber(own_customer_id) then
                hard_reject("CALL_REJECTED", string.format(
                    "[%s] IVR own-number transfer target %s is no longer customer %s's number "
                    .. "(resolved customer=%s) — 603\n",
                    uuid, tostring(fwd_e164), tostring(own_customer_id),
                    tostring(resolved and resolved.customer_id)))
                return
            end
        end
        first = false

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
            return dispatch_terminal(cur, ctx)
        end

        -- (2b) ON-NET: forward_to is a platform-owned DID.
        -- Disabled/suspended terminal -> hard reject (no carrier fallback).
        if (not resolved.product_enabled) or (resolved.customer_status ~= "active") then
            hard_reject("CALL_REJECTED", string.format(
                "[%s] On-net destination %s is disabled/suspended "
                .. "(product_enabled=%s customer_status=%s) — 603\n",
                uuid, fwd_e164, tostring(resolved.product_enabled),
                tostring(resolved.customer_status)))
            return
        end

        -- Retired product terminal (API Calling, API_CALLING_ENABLED off):
        -- the number is ours, so hard reject exactly like a disabled
        -- terminal (603, lua_routed=true, no carrier fallback).
        if resolved.product_type == "api" and not api_calling_enabled then
            hard_reject("CALL_REJECTED", string.format(
                "[%s] API Calling retired (API_CALLING_ENABLED off): "
                .. "rejecting on-net terminal DID %s (customer=%s) — 603\n",
                uuid, tostring(resolved.did), tostring(resolved.customer_id)))
            return
        end

        -- Visual IVR terminal with IVR_ENABLED off: ours -> 603, same shape.
        if resolved.product_type == "ivr" and not ivr_enabled then
            hard_reject("CALL_REJECTED", string.format(
                "[%s] IVR disabled (IVR_ENABLED off): "
                .. "rejecting on-net terminal DID %s (customer=%s) — 603\n",
                uuid, tostring(resolved.did), tostring(resolved.customer_id)))
            return
        end

        -- Loop guard: this DID already entered in the chain -> hard reject.
        if ctx.visited[resolved.did] then
            hard_reject("EXCHANGE_ROUTING_ERROR", string.format(
                "[%s] Routing loop detected re-entering %s — 483\n",
                uuid, resolved.did))
            return
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
            return
        end

        -- If the resolved on-net destination is itself an RCF DID, keep
        -- following the chain in memory (no SIP). Otherwise it is a terminal
        -- of another product (api/trunk) — dispatch it and stop.
        if resolved.product_type == "rcf" then
            cur = resolved
            -- loop again
        else
            -- The RCF DID that forwarded onto this other-product terminal is
            -- the DIVERTING number of the delivery leg (terminate_trunk marks
            -- the PBX leg div + Diversion from it; RFC 8946 div.tn).
            ctx.last_rcf_did = cur.did
            return dispatch_terminal(resolved, ctx)
        end
    end
end

-- ================================================================
-- Visual IVR: transfer = the RCF egress with a pseudo-hop
-- ================================================================
-- docs/IVR_INTERFACES.md §3 "Transfer semantics", plan §7.3. The IVR's
-- Transfer / Voicemail block becomes a pseudo RCF hop
--   { did = the IVR DID, forward_to = the target, pass_caller_id = the block
--     setting, max_channels = 0, terminator = "rcf" }
-- fed to run_onnet_chain in egress_return_mode, so it reuses EVERYTHING an RCF
-- forward does: on-net resolution of own numbers (RCF chain, voicemail DID ->
-- terminate_vvm, another IVR -> terminate_ivr hop-limited, trunk DID ->
-- terminate_trunk) and, off-net, terminate_rcf itself — cached TCP pre-check,
-- table-driven carrier_trunks x {signaling VIP, SBC-1 direct} (legacy 4-attempt
-- fallback), progress_timeout (never originate_timeout), the 8YY class
-- (fail-closed), From = the IVR DID for Bandwidth auth, PAI/RPID = the caller
-- (pass_caller_id=true) or the IVR DID (false), Diversion = the IVR DID, STIR
-- `div` + X-In-Identity + stir_outcome capture, the per-leg [cdr_*] B-leg
-- block (cdr_product_type=ivr, read off the A-leg), default media (no
-- proxy_media, SOA on).
-- Per transfer the cross-hop ctx (CID composition, hops, visited set) and the
-- egress channel variables are put back to the IVR's state, so a second
-- transfer after a no-answer starts exactly like the first (no stale
-- Diversion / exported From / proxy_media, no false loop on the same number).
-- Returns { status = answered|delivered|noanswer|busy|failed|rejected|
--           caller_gone, cause = <FS cause>, product = pstn|rcf|trunk|
--           voicemail|ivr|api }.
local IVR_EGRESS_RESET_VARS = {
    "sip_h_Diversion", "sip_h_X-Original-CID", "sip_h_X-Original-CID-Name",
    "sip_h_X-From-Name", "sip_h_Remote-Party-ID", "sip_h_X-Attestation",
    "sip_h_X-PBX-Dest", "outbound_caller_id_number", "outbound_caller_id_name",
    "effective_caller_id_number", "effective_caller_id_name",
    "origination_caller_id_number", "origination_caller_id_name", "proxy_media",
}
-- A-leg on-net facts that only describe a transfer that actually connected.
local IVR_ONNET_VARS = { "on_net", "on_net_hops", "terminating_customer_id", "trunk_id" }

local function ivr_snapshot(ctx)
    local visited = {}
    for k, v in pairs(ctx.visited) do visited[k] = v end
    local vars = {}
    for _, k in ipairs(IVR_ONNET_VARS) do vars[k] = get_var(k, "") end
    return {
        pass_effective = ctx.pass_effective, presented_cid = ctx.presented_cid,
        presented_name = ctx.presented_name, masking_name = ctx.masking_name,
        hops = ctx.hops, visited = visited, on_net = ctx.on_net,
        last_rcf_did = ctx.last_rcf_did, vars = vars,
    }
end

local function ivr_restore(ctx, snap)
    ctx.pass_effective, ctx.presented_cid = snap.pass_effective, snap.presented_cid
    ctx.presented_name, ctx.masking_name = snap.presented_name, snap.masking_name
    ctx.hops, ctx.on_net, ctx.last_rcf_did = snap.hops, snap.on_net, snap.last_rcf_did
    local visited = {}
    for k, v in pairs(snap.visited) do visited[k] = v end
    ctx.visited = visited
    for k, v in pairs(snap.vars) do
        pcall(function() session:setVariable(k, v) end)   -- "" deletes
    end
end

local function ivr_reset_egress_vars()
    for _, k in ipairs(IVR_EGRESS_RESET_VARS) do
        pcall(function() session:setVariable(k, "") end)
    end
end

local function ivr_transfer(ivr, spec, ctx)
    local hop = {
        did             = ivr.did,
        product_type    = "ivr",
        terminator      = "rcf",
        customer_id     = ivr.customer_id,
        product_enabled = true,
        customer_status = "active",
        forward_to      = spec.e164,
        pass_caller_id  = (spec.pass_caller_id == true),
        ring_timeout    = spec.ring_timeout,
        max_channels    = 0,
        product_name    = nil,     -- no customer text in any SIP header
    }
    freeswitch.consoleLog("INFO", string.format(
        "[%s] IVR transfer: %s -> %s (kind=%s pass_cid=%s ring=%ss)\n",
        ctx.uuid, tostring(ivr.did), tostring(spec.e164), tostring(spec.kind),
        tostring(hop.pass_caller_id), tostring(spec.ring_timeout)))

    local snap = ivr_snapshot(ctx)
    ivr_reset_egress_vars()
    local prev_mode, prev_ring = egress_return_mode, ctx.ring_timeout_override
    egress_return_mode = true
    egress_reject_cause = nil
    ctx.ring_timeout_override = spec.ring_timeout
    local ok, res = pcall(run_onnet_chain, hop, ctx,
        (spec.kind == "own") and ivr.customer_id or nil)
    ctx.ring_timeout_override = prev_ring
    egress_return_mode = prev_mode
    local reject = egress_reject_cause
    egress_reject_cause = nil

    if not ok then
        freeswitch.consoleLog("ERR", string.format(
            "[%s] IVR transfer raised: %s\n", ctx.uuid, tostring(res)))
        res = { status = "rejected", cause = "NORMAL_TEMPORARY_FAILURE" }
    elseif reject then
        res = { status = "rejected", cause = reject }
    elseif type(res) ~= "table" then
        local up = false
        pcall(function() up = session:ready() end)
        res = { status = up and "failed" or "delivered", cause = "NORMAL_TEMPORARY_FAILURE" }
    end

    if res.status ~= "answered" and res.status ~= "delivered" then
        ivr_restore(ctx, snap)
        ivr_reset_egress_vars()
    end
    freeswitch.consoleLog("INFO", string.format(
        "[%s] IVR transfer -> %s: %s (cause=%s product=%s)\n",
        ctx.uuid, tostring(spec.e164), tostring(res.status),
        tostring(res.cause), tostring(res.product)))
    return res
end

-- ================================================================
-- Terminator: Visual IVR  (dest = IVR number row, ctx = state)
-- ================================================================
-- docs/IVR_INTERFACES.md §5; plan §7.1-§7.4. Reached two ways, both through
-- dispatch_terminal (customer_id = IVR owner, product_type = ivr):
--   * DIRECT: an IVR DID dialed from the PSTN (STEP-1 lookup_ivr_did, LAST arm;
--     dest.ivr_row is the ivr_fs_number row).
--   * ON-NET: an RCF forward / chain — or another IVR's transfer — whose
--     terminal resolves to the number_routing ivr arm (row read here).
-- Flow: ONE ivr_fs_number read (version pinning) -> enabled + published or
-- 603 -> `limit hash ivr <did> <max_channels>` (486 + ivr_exit=limit) -> plan
-- decoded + validated closed-world (lib/ivr_engine.lua) -> every prompt
-- prefetched into the local cache BEFORE answer (lib/ivr_prompts.lua; a 180
-- first when a fetch is needed, so the caller hears ringback) ->
-- lib/media_leg.prepare (rtp_timer_name=soft + jitterbuffer, this leg only)
-- -> answer -> engine -> CDR vars. Any failure: answer, play
-- sounds/ivr/technical_difficulty.wav, hang up, ivr_exit=error.
-- Modules load lazily HERE, so RCF/trunk/voicemail calls never read them.
-- Nested (an IVR transferred onto another IVR number): same steps on the
-- already-answered channel, sharing the call's IVR CDR state; a full nested
-- number is "busy" for the outer IVR.
local IVR_FALLBACK_PROMPT = "/usr/local/freeswitch/scripts/sounds/ivr/technical_difficulty.wav"

local function terminate_ivr(dest, ctx)
    local uuid = ctx.uuid
    local nested = (ctx.ivr_state ~= nil)
    set_var("lua_routed", "true")

    if not ivr_enabled then
        hard_reject("CALL_REJECTED", string.format(
            "[%s] IVR disabled (IVR_ENABLED off): rejecting DID %s — 603", uuid, tostring(dest.did)))
        return
    end

    -- ONE read of the number (version pinning: this plan runs to the end).
    local row = dest.ivr_row
    if not row and db and db.lookup_ivr_did then
        local ok, r = pcall(db.lookup_ivr_did, dest.did)
        if ok then
            row = r
        else
            freeswitch.consoleLog("ERR", string.format(
                "[%s] IVR lookup raised for %s: %s\n", uuid, tostring(dest.did), tostring(r)))
        end
    end
    local row_enabled = row and (row.enabled == "t" or row.enabled == true)
    local plan_text = row and row.plan_json
    local row_customer = row and tonumber(row.customer_id)
    if not row or not row_enabled or type(plan_text) ~= "string" or plan_text == ""
        or (dest.customer_id and row_customer ~= tonumber(dest.customer_id)) then
        hard_reject("CALL_REJECTED", string.format(
            "[%s] IVR DID %s not callable (row=%s enabled=%s plan=%s owner=%s/%s) — 603",
            uuid, tostring(dest.did), tostring(row ~= nil), tostring(row_enabled),
            tostring(type(plan_text) == "string" and plan_text ~= ""),
            tostring(row_customer), tostring(dest.customer_id)))
        return
    end

    local flow_id, flow_version = tonumber(row.flow_id), tonumber(row.flow_version)
    if not nested then
        set_var("ivr_flow_id", flow_id)
        set_var("ivr_flow_version", flow_version)
    end

    local function log(level, msg)
        freeswitch.consoleLog(level, string.format("[%s] IVR %s: %s\n", uuid, tostring(dest.did), msg))
    end

    -- State shared with nested IVRs on this call; created at the first answer.
    local state = ctx.ivr_state

    local function finalize()
        if nested or not state then return end
        local engine_mod = state.engine
        local vars
        if engine_mod then
            vars = engine_mod.cdr_vars(state, os.time())
        else
            -- ivr_engine itself failed to load: exit + seconds only.
            vars = { ivr_exit = state.exit or "error" }
            if state.answered_at then
                vars.ivr_seconds = string.format("%d", math.max(0, os.time() - state.answered_at))
            end
        end
        for k, v in pairs(vars) do
            if v ~= nil and v ~= "" then set_var(k, v) end
        end
        log("INFO", string.format("exit=%s path=%s seconds=%s", tostring(vars.ivr_exit),
            tostring(vars.ivr_path), tostring(vars.ivr_seconds)))
        ctx.ivr_state = nil
    end

    -- The error path (contract §4/§5): system prompt, hang up, ivr_exit=error.
    local media, prompts, engine
    local function fail(reason, cause)
        log("ERR", reason)
        local up = false
        pcall(function() up = session:ready() end)
        if up then
            if media then media.prepare(session) end
            pcall(function() session:answer() end)
        end
        if not state then
            state = engine and engine.new_state(os.time()) or { path = "", answered_at = os.time() }
            state.engine = engine
            ctx.ivr_state = state
        end
        state.exit = state.exit or "error"
        pcall(function() up = session:ready() end)
        if up then
            local p = prompts and prompts.system("technical_difficulty") or IVR_FALLBACK_PROMPT
            pcall(function() session:execute("playback", p) end)
            pcall(function() session:hangup(cause or "NORMAL_TEMPORARY_FAILURE") end)
        end
        finalize()
        return { status = "delivered", product = "ivr" }
    end

    -- Per-number concurrency (§5.4): `limit hash ivr <did> <max_channels>`.
    local max_ch = tonumber(row.max_channels) or 0
    local did_ok = type(dest.did) == "string" and dest.did:match("^%+%d+$") ~= nil
    if max_ch > 0 and did_ok then
        if nested then
            if limit_would_block(ctx, "ivr", dest.did, max_ch) then
                log("WARNING", string.format("at its %d concurrent call limit — busy for the calling IVR", max_ch))
                return { status = "busy", cause = "USER_BUSY", product = "ivr" }
            end
        end
        session:execute("limit", string.format("hash ivr %s %d !USER_BUSY", dest.did, max_ch))
        if not session:ready() then
            log("WARNING", string.format("rejected — %d concurrent call limit reached (486)", max_ch))
            if nested then
                state.exit = state.exit or "limit"
            else
                set_var("ivr_exit", "limit")
            end
            return
        end
        if nested then limit_mark_held(ctx, "ivr", dest.did) end
    end

    -- Modules (lazy, house load_module; a missing one is the error path,
    -- never a 404/503 or a carrier hairpin).
    media = load_module("media_leg")
    prompts = load_module("ivr_prompts")
    engine = load_module("ivr_engine")
    local schedule = load_module("schedule")
    local rules = load_module("rules")
    if not (media and prompts and engine and schedule and rules) then
        return fail("IVR modules failed to load")
    end

    local plan, perr = engine.load_plan(plan_text, {
        flow_id = flow_id, version = flow_version, customer_id = row_customer,
    })
    if not plan then
        return fail(tostring(perr))
    end

    -- Prefetch EVERY prompt before answer (D9: local replica + local disk).
    if not nested and not prompts.all_cached(plan.prompts) then
        pcall(function() session:execute("ring_ready") end)
    end
    local cache_token = tostring(uuid):gsub("[^%w%-]", "")
    local pok, ferr, fsha = prompts.prefetch(plan.prompts, { db = db, token = cache_token })
    if not pok then
        return fail(string.format("prompt %s unavailable: %s", tostring(fsha), tostring(ferr)))
    end

    -- Media clocking for THIS leg only, then answer (§5.3).
    if not nested then
        media.prepare(session)
        session:setVariable("playback_terminators", "none")
        pcall(function() session:answer() end)
        if not session:ready() then
            state = { path = "", answered_at = nil, exit = "caller_hangup" }
            ctx.ivr_state = state
            finalize()
            return
        end
        state = engine.new_state(os.time())
        state.engine = engine
        ctx.ivr_state = state
    end
    state.depth = (state.depth or 0) + 1
    log("INFO", string.format("flow %s v%s, %d nodes, %d prompts (depth %d)",
        tostring(flow_id), tostring(flow_version), (function()
            local n = 0 for _ in pairs(plan.nodes) do n = n + 1 end return n end)(),
        #plan.prompts, state.depth))

    local ivr = { did = dest.did, customer_id = row_customer }
    local ok, err = pcall(engine.run, session, {
        plan = plan, state = state, prompts = prompts, schedule = schedule,
        rules = rules, number_utils = number_utils,
        caller = ctx.presented_cid, now = os.time, log = log,
        transfer = function(spec) return ivr_transfer(ivr, spec, ctx) end,
    })
    state.depth = state.depth - 1
    if not ok then
        return fail("engine raised: " .. tostring(err))
    end

    if not nested then
        -- Never hand a live channel back to the dialplan (its 503 fallback).
        local up = false
        pcall(function() up = session:ready() end)
        if up then pcall(function() session:hangup("NORMAL_CLEARING") end) end
        finalize()
    end
    return { status = "delivered", product = "ivr" }
end

if ivr_enabled then
    TERMINATORS.ivr = terminate_ivr
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
    -- STEP 1 rcf/api/trunk lookups already filtered enabled/active (their
    -- routing tables carry neither field -> true / "active", unchanged). The
    -- voicemail arm is UNFILTERED, so its flags flow through and
    -- terminate_vvm hard-rejects a disabled/suspended mailbox (603).
    product_enabled = (routing.product_enabled ~= false),
    customer_status = routing.customer_status or "active",
    product_ref_id  = routing.product_ref_id,   -- voicemail: mailbox id (nil otherwise)
    forward_to      = forward_to,
    pass_caller_id  = pass_caller_id,
    ring_timeout    = ring_timeout,
    max_channels    = tonumber(routing.max_channels) or 0,
    product_name    = routing.rcf_name,
    voice_url       = voice_url,
    fallback_url    = fallback_url,
    trunk_id        = trunk_id,
    ivr_row         = routing.ivr_row,          -- ivr: the ivr_fs_number row (nil otherwise)
}

if product_type == "rcf" then
    -- RCF branch point: the on-net chain (run_onnet_chain above, unchanged).
    run_onnet_chain(first_dest, ctx)
else
    -- Non-RCF inbound (api / trunk): the first-hop DID is the terminal, exactly
    -- as before. No chain, no on-net decision (a directly-dialed platform DID is
    -- not a "forward" — off-net vs on-net only applies to a forwarding handoff).
    -- A directly-dialed DID is off-net by definition; pin it explicitly so the
    -- `on_net` channel variable (exported in dispatch_terminal for the ESL
    -- metrics exporter's live-channel label) is deterministic, not nil-coerced.
    ctx.on_net = false
    if product_type == "api" and not api_calling_enabled then
        -- Retired product (API_CALLING_ENABLED off): the DID is ours but API
        -- Calling is switched off -> hard reject 603 (lua_routed=true), same
        -- shape as the on-net disabled/suspended terminal reject.
        hard_reject("CALL_REJECTED", string.format(
            "[%s] API Calling retired (API_CALLING_ENABLED off): "
            .. "rejecting DID %s (customer=%s) — 603\n",
            uuid, tostring(normalized_did), tostring(customer_id)))
    elseif product_type == "ivr" and not ivr_enabled then
        -- Visual IVR with IVR_ENABLED off (contract §5.1): ours -> 603.
        hard_reject("CALL_REJECTED", string.format(
            "[%s] IVR disabled (IVR_ENABLED off): "
            .. "rejecting DID %s (customer=%s) — 603\n",
            uuid, tostring(normalized_did), tostring(customer_id)))
    else
        dispatch_terminal(first_dest, ctx)
    end
end

freeswitch.consoleLog("INFO", "[" .. uuid .. "] Inbound routing complete\n")
