-- handlers/rcf.lua — Remote Call Forwarding inbound handler (RCF-V1 + Rich RCF)
--
-- Extracted (behavior-preserving) from inbound_router.lua's `product_type ==
-- "rcf"` branch as part of the Phase 2 thin-dispatcher split. The dispatcher
-- resolves the DID, sets the CDR channel vars, builds a ctx, and calls
-- handle(ctx); all RCF-specific routing lives here.
--
-- TWO MODES (selected per call by the presence of routing_plan):
--   * NIL routing_plan  -> the LEGACY single-forward_to path below. This is the
--     LIVE Granite production path and is left BYTE-FOR-BYTE UNCHANGED (the guard
--     at the top of handle(ctx) returns into handle_rich_plan ONLY when a valid
--     plan exists; otherwise execution falls straight through to the legacy code
--     exactly as before — pinned by tests/lua/spec/inbound_router_spec.lua).
--   * routing_plan present -> RICH RCF (handle_rich_plan): evaluate the ordered
--     `rules` (schedule + caller-id `match`, first match wins) and ring the
--     matched rule's leg(s) via a time-of-day / ring-group engine, with a
--     plan-level `fallback` (voicemail | forward | hangup) on no-answer.
--
-- RICH plan shape (rcf_numbers.routing_plan JSONB, snake_case — the Call Flow
-- Builder's compiled artifact; db_client.lookup_rcf parses it nil-safe):
--   { rules = { { match = nil | { schedule = {...}, caller_id = {prefix=,equals=} },
--                 ring  = { strategy = "sequential"|"parallel",
--                           ring_timeout = <int s>,
--                           legs = { { to = <E.164|10xx ext>, timeout? = <int> }, ... } } },
--               ... },
--     fallback = { type = "voicemail"|"forward"|"hangup", to? = <dest> } }
-- We are LIBERAL in what we accept for `ring` (string / list / {legs}) to match
-- the backend's _first_leg_dest tolerance (call_flows.py).
--
-- RING REUSE OF THE CARRIER/SBC PATH + TIMEOUT SEMANTICS (the hard-won rules):
--   * A rule that resolves to a SINGLE leg is a FORWARD: it reuses the full
--     4-attempt SBC×carrier failover loop (lib/sbc.failover_bridge) with the
--     EXACT legacy build_dial — progress_timeout (PDD bound) + call_timeout, NO
--     originate_timeout — so a still-ringing single forward is never cancelled
--     (CLAUDE.md "progress_timeout vs originate_timeout").
--   * A rule with 2+ legs is a RING GROUP (FMFM): each PSTN leg routes through
--     the SAME carrier path (lib/dialstring -> sofia/external/<dest>@SBC:5060,
--     X-Carrier=primary, X-CID, RFC4028 timers) but as ONE bridge per leg with a
--     per-leg call_timeout, so a no-answer ADVANCES to the next destination
--     (sequential) — that "time out to advance" IS the ring-group semantic. The
--     ring loop reuses lib/multileg (sequential / parallel simring), exactly like
--     handlers/ucaas.lua find-me/follow-me. Multi-destination resilience comes
--     from the ring group + fallback; per-leg SBC redundancy is via the primary
--     SBC (parallel) or the single-forward failover loop (1-leg rules).
--
-- Media: DEFAULT media mode. The RCF bridge dial strings do NOT set proxy_media
-- (only the trunk path does). This is load-bearing for the carrier audio path
-- after the Cloud-NAT fix (CLAUDE.md "No proxy_media in RCF path").
--
-- Bridge: 4-attempt SBC × carrier failover (SBC-1/SBC-2 × primary/secondary),
-- each guarded by a cached TCP reachability pre-check — see lib/sbc.lua.
--
-- ctx fields consumed (set up by inbound_router.lua):
--   session, get_var, set_var, hangup       — session + helpers
--   uuid, normalized_did, forward_to,        — call/routing identity
--     ring_timeout, pass_caller_id, routing,
--     original_caller_number, original_caller_name, traffic_grade
--   to_10digit, normalize_did                — e164 helpers (bound in dispatcher)
--   external_sip_ip, sbc_proxy_ip,           — env-derived addressing
--     sbc_proxy_ip_failover, bridge_progress_timeout
--   get_domain                               — local-extension domain resolver
--   sbc, dialstring, caller_id, session_timer-- lib modules (loaded by dispatcher)
--
-- `freeswitch` is the mod_lua global (available to loadfile'd chunks).

-- ===========================================================================
-- RICH RCF helpers (module scope, side-effect-free). Only reached when a DID
-- carries a routing_plan; the legacy path below never calls these.
-- ===========================================================================

-- Trim surrounding whitespace (parenthesized to drop gsub's 2nd return value).
local function trim(s)
    return (tostring(s or ""):gsub("^%s*(.-)%s*$", "%1"))
end

-- POSIX shell single-quote escape for the one os.execute() in record_voicemail.
local function shq(s)
    return "'" .. tostring(s or ""):gsub("'", "'\\''") .. "'"
end

-- A local extension destination: 4-digit 10xx (same contract as the legacy
-- is_local_extension below). Anything else is PSTN/E.164.
local function rich_is_local_extension(number)
    if not number then return false end
    return tostring(number):match("^10%d%d$") ~= nil
end

-- Normalize a rule's `ring` into { strategy, ring_timeout, legs={{to,timeout},...} }.
-- Liberal per the backend contract (call_flows.py _first_leg_dest): `ring` may be
-- a bare string, a list of strings, a list of {to,...} objects, an object with a
-- `legs` list, or a single {to} object.
local function normalize_ring(ring, default_timeout)
    local out = { strategy = "sequential", ring_timeout = default_timeout, legs = {} }

    if type(ring) == "string" then
        local to = trim(ring)
        if to ~= "" then out.legs[1] = { to = to } end
        return out
    end
    if type(ring) ~= "table" then return out end

    if ring.strategy == "parallel" then out.strategy = "parallel" end
    local rt = tonumber(ring.ring_timeout)
    if rt and rt > 0 then out.ring_timeout = rt end

    -- Leg source: explicit `legs`, else treat the table itself as the array.
    local src = (type(ring.legs) == "table") and ring.legs or ring
    for _, leg in ipairs(src) do
        if type(leg) == "string" then
            local to = trim(leg)
            if to ~= "" then out.legs[#out.legs + 1] = { to = to } end
        elseif type(leg) == "table" then
            local to = leg.to and trim(tostring(leg.to)) or nil
            if to and to ~= "" then
                out.legs[#out.legs + 1] = { to = to, timeout = tonumber(leg.timeout) }
            end
        end
    end

    -- Single {to} object with no array/legs entries -> one leg.
    if #out.legs == 0 and ring.to then
        local to = trim(tostring(ring.to))
        if to ~= "" then out.legs[1] = { to = to } end
    end

    return out
end

-- NOTE: the schedule + caller-id `match` predicate (caller_id_matches /
-- rule_matches / first-match-wins selection) was FACTORED OUT to lib/rules.lua
-- so the SIP-trunk inbound handler reuses the identical matcher. The selection
-- below calls ctx.rules.first_match(); RCF's routing behavior is unchanged.

-- ===========================================================================
-- TOLL-FRAUD CONTROLS (P0) — RCF international / premium-destination blocklist +
-- per-customer & per-DID concurrency caps. Shared by BOTH the legacy
-- single-forward path and the RICH routing_plan path below. Uses the SYNCHRONOUS
-- PostgreSQL path (ctx.db) — NOT Redis (the redis-lua threading issue that
-- removed Redis from the RCF path does not affect the sync db_client path).
--
-- Rollout-safe / fail-open discipline:
--   * The premium/high-risk blocklist reads high_risk_prefixes (a table that
--     already exists) — active immediately; fails OPEN on DB error.
--   * The international gate + per-customer cap read the two NEW `customers`
--     columns (international_calling_enabled, max_concurrent_calls). Until the
--     backend migration adds them, get_customer_fraud_policy returns nil and
--     those two controls are SKIPPED (fail open) — RCF keeps working. They
--     activate automatically once the columns exist.
--   * A definitive fraud positive (blocked prefix / intl-not-enabled with a
--     readable policy) fails CLOSED (reject). A DB hiccup fails OPEN.
-- ===========================================================================

-- H-4: High-cost NANP NPAs that BILL LIKE INTERNATIONAL even though they are +1
-- (Caribbean/Atlantic + North-American premium). A bare "+1 + 10 digits" test
-- treats all of these as domestic, so a forward_to to e.g. +1-876 (Jamaica),
-- +1-809 (Dom. Rep.), +1-473 (Grenada) would bypass the international gate. This
-- list is BYTE-IDENTICAL to the backend _HIGH_COST_NANP_NPAS in
-- docker/api/src/services/ai_agent.py (the AI transfer_call control) — ONE source
-- of truth for the toll-fraud NPA policy. Blocked UNLESS the customer has
-- international calling enabled (treated exactly like an international destination).
local HIGH_COST_NANP_NPAS = {
    ["242"]=true, ["246"]=true, ["264"]=true, ["268"]=true, ["284"]=true,
    ["340"]=true, ["345"]=true, ["441"]=true, ["473"]=true, ["649"]=true,
    ["658"]=true, ["664"]=true, ["721"]=true, ["758"]=true, ["767"]=true,
    ["784"]=true, ["809"]=true, ["829"]=true, ["849"]=true, ["868"]=true,
    ["869"]=true, ["876"]=true, ["900"]=true, ["976"]=true,
}
-- Premium / pay-per-call NANP NPAs — blocked even WITH international enabled
-- (scam/premium-rate, never a legitimate destination). Mirrors the backend
-- _PREMIUM_NANP_NPAS. Subset of HIGH_COST_NANP_NPAS.
local PREMIUM_NANP_NPAS = { ["900"]=true, ["976"]=true }

-- H-5: loud, ONE-TIME-per-process page when the per-customer fraud policy cannot
-- be read (the international_calling_enabled/max_concurrent_calls columns are not
-- yet present — a backend-migration ROLLOUT gap — as opposed to a transient DB
-- error). We now FAIL CLOSED for international/high-cost-NPA destinations when the
-- policy is unreadable, so surface the schema gap ONCE as a CRIT page (an operator
-- must apply the migration) rather than spamming every call. A transient DB error
-- already logs a per-call WARNING in db_client.get_customer_fraud_policy and does
-- NOT page here. Domestic NANP is unaffected either way. ctx.fraud_policy_reason
-- is stamped by fetch_fraud_policy below.
local function fraud_policy_page(ctx)
    if ctx.fraud_policy_reason ~= "schema_missing" then return end
    local FLAG = "rcf_fraud_schema_paged"
    local seen = nil
    pcall(function() seen = freeswitch.getGlobalVariable(FLAG) end)
    if seen == "1" then return end
    pcall(function() freeswitch.setGlobalVariable(FLAG, "1") end)
    freeswitch.consoleLog("CRIT", string.format(
        "[%s] RCF FRAUD POLICY SCHEMA MISSING — customers.international_calling_enabled/"
        .. "max_concurrent_calls not present. International + high-cost-NPA forwards are "
        .. "now BLOCKED (fail-closed) until the backend migration is applied; domestic "
        .. "NANP is unaffected. (Pages once per FreeSWITCH process.)\n",
        tostring(ctx.uuid)))
end

-- Per-DID default concurrent-call cap when rcf_numbers.max_channels is 0/unset.
-- SECURITY: 0 no longer means "unlimited" — an uncapped DID is uncapped toll
-- fraud on a compromised forward_to. Env-tunable (RCF_DID_MAX_CONCURRENT_DEFAULT);
-- sane non-zero default. To grant a DID effectively-unlimited concurrency,
-- provision an explicit high max_channels on that DID.
local function per_did_default()
    local v = tonumber(os.getenv("RCF_DID_MAX_CONCURRENT_DEFAULT") or "")
    if not v or v < 1 then v = 30 end
    return math.floor(v)
end

-- Fetch the per-customer fraud policy ONCE per call. Returns the policy table, or
-- nil when it cannot be read; ALSO stamps ctx.fraud_policy_reason so callers can
-- distinguish a rollout schema gap ("schema_missing") from a transient DB error
-- ("db_error") — H-5. nil handling is SPLIT by control:
--   * International / high-cost-NPA gate -> FAIL CLOSED (dest_allowed blocks the
--     dest) so a missing migration or a DB blip never leaves international ungated.
--   * Per-customer concurrency cap -> still fail-OPEN (apply_concurrency_limits
--     skips it) because the per-DID mod_hash cap is the verified backstop and
--     always applies. DOMESTIC NANP keeps flowing on a nil policy either way.
local function fetch_fraud_policy(ctx)
    if not (ctx.db and ctx.db.get_customer_fraud_policy and ctx.customer_id) then
        ctx.fraud_policy_reason = "no_db"
        return nil
    end
    -- get_customer_fraud_policy returns (policy, reason): a table on success, or
    -- nil + reason ("schema_missing" | "db_error" | "no_customer" | ...).
    local ok, p, reason = pcall(ctx.db.get_customer_fraud_policy, ctx.customer_id)
    if ok and type(p) == "table" then
        ctx.fraud_policy_reason = nil
        return p
    end
    ctx.fraud_policy_reason = (ok and reason) or "db_error"
    return nil
end

-- Decide whether a PSTN destination may be dialed. Call with the RAW destination
-- (E.164 with +, or 10/11-digit) — NOT a "+"-stripped carrier form, so E.164
-- country-code detection is correct.
--   returns (true, nil)            on allow
--   returns (false, "<reason>")    on a fraud/policy BLOCK (fail CLOSED)
-- Rules:
--   * NANP (+1 + 10 digits): allowed EXCEPT (H-4) high-cost/premium NPAs. Premium
--     NPAs (900/976) are ALWAYS blocked; the rest of HIGH_COST_NANP_NPAS bill like
--     international and are blocked unless international_calling_enabled.
--   * International (non-NANP): requires international_calling_enabled.
--   * H-5 FAIL CLOSED: a nil/unreadable policy is treated as intl DISABLED — it
--     blocks international AND the high-cost NPA list (a rollout schema gap / DB
--     blip must never leave international ungated), while DOMESTIC NANP keeps
--     flowing. The rollout schema gap also pages loudly once (fraud_policy_page).
--   * Premium/high-risk blocklist (DB high_risk_prefixes): a 'blocked' match
--     rejects; elevated/high/critical are ALLOWED but tagged (fraud_score /
--     fraud_prefix), mirroring trunk_outbound / outbound_api — one source of truth.
--     INDEPENDENT of the NPA list above (belt-and-suspenders).
-- Local extensions (10xx) never reach here (callers skip them).
local function dest_allowed(ctx, policy, dest_raw)
    local e164 = ctx.normalize_did(dest_raw or "")
    local digits = (e164:gsub("^%+", ""))
    -- NANP == +1 followed by exactly 10 digits.
    local is_nanp = e164:match("^%+1%d%d%d%d%d%d%d%d%d%d$") ~= nil
    -- H-5: a nil/unreadable policy (rollout schema gap OR DB error) is treated as
    -- international DISABLED (fail closed), NOT allowed.
    local intl_enabled = (policy ~= nil) and policy.intl_enabled and true or false

    if is_nanp then
        -- H-4: gate high-cost / premium NANP NPAs (the 3 digits after +1). Without
        -- this, +1-876 (Jamaica), +1-809, +1-473, +1-900 … slip through as
        -- "domestic" and bypass the international gate entirely.
        local npa = e164:match("^%+1(%d%d%d)")
        if npa and PREMIUM_NANP_NPAS[npa] then
            return false, "premium_npa:" .. npa
        end
        if npa and HIGH_COST_NANP_NPAS[npa] and not intl_enabled then
            if policy == nil then
                fraud_policy_page(ctx)  -- loud one-time page on a schema gap
                return false, "high_cost_npa_policy_unavailable:" .. npa
            end
            return false, "high_cost_npa_intl_disabled:" .. npa
        end
    else
        -- International (non-NANP) gate. H-5: FAIL CLOSED on a nil policy.
        if policy == nil then
            fraud_policy_page(ctx)
            return false, "international_policy_unavailable"
        elseif not intl_enabled then
            return false, "international_not_enabled"
        end
    end

    if ctx.db and ctx.db.check_high_risk_prefix then
        local ok, risky, level, prefix = pcall(ctx.db.check_high_risk_prefix, digits)
        if ok and risky then
            if level == "blocked" then
                return false, "blocked_prefix:" .. tostring(prefix)
            end
            ctx.set_var("fraud_score", (level == "critical") and "80" or "50")
            ctx.set_var("fraud_prefix", tostring(prefix))
            freeswitch.consoleLog("WARNING", string.format(
                "[%s] RCF high-risk (non-blocking) dest=%s prefix=%s level=%s\n",
                tostring(ctx.uuid), tostring(e164), tostring(prefix), tostring(level)))
        end
    end

    return true, nil
end

-- Apply the per-customer + per-DID concurrent-call caps via mod_hash (no Redis).
-- Returns true if the call may proceed, false if a cap was hit (the limit app
-- already hung the session up with USER_BUSY / 486). Per-customer cap fails OPEN
-- when policy is nil; per-DID cap always applies with a sane non-zero default.
local function apply_concurrency_limits(ctx, policy)
    local session = ctx.session

    -- Per-customer cap (across ALL the customer's DIDs) — the real backstop
    -- against a compromised forward_to flooding the customer's whole account.
    -- Distinct mod_hash realm ("customer") from the per-DID realm ("inbound").
    if policy and policy.max_concurrent and policy.max_concurrent > 0 and ctx.customer_id then
        session:execute("limit",
            "hash customer " .. tostring(ctx.customer_id) .. " "
            .. tostring(policy.max_concurrent) .. " !USER_BUSY")
        if not session:ready() then
            freeswitch.consoleLog("WARNING", string.format(
                "[%s] RCF customer %s rejected — %d concurrent-call cap reached\n",
                tostring(ctx.uuid), tostring(ctx.customer_id), policy.max_concurrent))
            return false
        end
    end

    -- Per-DID cap (0/unset -> sane non-zero default; no longer "unlimited").
    local per_did = tonumber(ctx.routing and ctx.routing.max_channels) or 0
    if per_did <= 0 then per_did = per_did_default() end
    if per_did > 0 then
        session:execute("limit",
            "hash inbound " .. ctx.normalized_did .. " " .. tostring(per_did) .. " !USER_BUSY")
        if not session:ready() then
            freeswitch.consoleLog("WARNING", string.format(
                "[%s] RCF DID %s rejected — %d concurrent-call cap reached\n",
                tostring(ctx.uuid), tostring(ctx.normalized_did), per_did))
            return false
        end
    end
    return true
end

-- ===========================================================================
-- RICH RCF executor. Mirrors handlers/ucaas.lua find-me/follow-me but with RCF
-- caller-ID policy + RCF local-ext (10xx) semantics, and reuses lib/sbc for the
-- single-forward 4-attempt failover loop.
-- ===========================================================================
local function handle_rich_plan(ctx, plan)
    local session = ctx.session
    local get_var = ctx.get_var
    local set_var = ctx.set_var
    local hangup = ctx.hangup
    local uuid = ctx.uuid
    local normalized_did = ctx.normalized_did
    local pass_caller_id = ctx.pass_caller_id
    local routing = ctx.routing
    local original_caller_number = ctx.original_caller_number
    local original_caller_name = ctx.original_caller_name
    local ring_timeout = ctx.ring_timeout
    local external_sip_ip = ctx.external_sip_ip
    local sbc_proxy_ip = ctx.sbc_proxy_ip
    local sbc_proxy_ip_failover = ctx.sbc_proxy_ip_failover
    local bridge_progress_timeout = ctx.bridge_progress_timeout
    local sbc = ctx.sbc
    local dialstring = ctx.dialstring
    local caller_id = ctx.caller_id
    local session_timer = ctx.session_timer
    local multileg = ctx.multileg
    local sched = ctx.schedule

    -- Toll-fraud policy fetched ONCE for this call (nil = fail open). `allowed`
    -- gates each PSTN destination against the intl gate + premium blocklist.
    local fraud_policy = fetch_fraud_policy(ctx)
    local function allowed(to) return dest_allowed(ctx, fraud_policy, to) end

    -- Real SIP Call-ID for Homer A/B correlation on carrier legs (mirrors legacy).
    local sip_call_id = session:getVariable("sip_call_id") or uuid

    -- E.164 forms reused across CID setup.
    local outbound_did = ctx.to_10digit(normalized_did)
    local e164_original_cid = ctx.normalize_did(original_caller_number)
    local e164_did = ctx.normalize_did(normalized_did)
    -- Caller-id matching uses the E.164 caller so "+1617" prefixes are reliable.
    local caller_e164 = ctx.normalize_did(original_caller_number or "")

    -- Carrier destination form for a leg: E.164 with the leading "+" stripped —
    -- byte-for-byte the legacy forward_to convention (e.g. "+1777…" -> "1777…").
    local function carrier_dest(to)
        local d = ctx.normalize_did(to)
        return (d:gsub("^%+", ""))
    end

    local function bridged_ok()
        return multileg.bridged_ok(get_var)
    end

    -- SINGLE FORWARD to PSTN: the full 4-attempt SBC×carrier failover loop,
    -- byte-for-byte the legacy build_dial (progress_timeout + call_timeout, NO
    -- originate_timeout — never cancel a still-ringing forward).
    local function forward_pstn(dest, leg_timeout)
        -- LCO carrier ordering (fail-safe to the legacy literal — see the legacy
        -- path's comment). `dest` is already the +-stripped carrier form; lib/lco
        -- (via db_client) digit-strips it for the prefix match.
        -- M-1: INBOUND RCF uses the DB LCO lookup ONLY — do NOT pass get_var (the
        -- sip_h_X-LCO-Route / lco_route explicit-header source). An inbound caller
        -- could otherwise inject X-LCO-Route to override the rate deck and collapse
        -- the 4-attempt SBC×carrier failover. The explicit-header path stays ONLY
        -- on the ESL-originated A-leg (outbound_api.lua), which is not attacker-
        -- reachable. (Belt: kamailio.cfg route[STRIP_CLIENT_HEADERS] also scrubs it.)
        local lco_carriers = ctx.lco and ctx.lco.resolve_carriers({
            db = ctx.db, dest = dest, uuid = uuid,
        }) or nil
        local attempts = (lco_carriers and ctx.lco.build_attempts(
                lco_carriers, sbc_proxy_ip, sbc_proxy_ip_failover)) or {
            { sbc = sbc_proxy_ip,          carrier = "primary",   label = "SBC-1 + primary carrier (Dallas)" },
            { sbc = sbc_proxy_ip_failover, carrier = "primary",   label = "SBC-2 + primary carrier (Dallas)" },
            { sbc = sbc_proxy_ip,          carrier = "secondary", label = "SBC-1 + secondary carrier (LA)" },
            { sbc = sbc_proxy_ip_failover, carrier = "secondary", label = "SBC-2 + secondary carrier (LA)" },
        }
        local function build_dial(attempt)
            local inner = string.format(
                "ignore_early_media=false,progress_timeout=%d,call_timeout=%d,sip_h_X-Carrier=%s,sip_h_X-CID=%s,%s",
                bridge_progress_timeout, leg_timeout, attempt.carrier, sip_call_id,
                session_timer.BRIDGE_OPTS)
            return dialstring.bridge(inner, dest, attempt.sbc)
        end
        sbc.failover_bridge({
            session = session, get_var = get_var, set_var = set_var, uuid = uuid,
            did = normalized_did, dest = dest, attempts = attempts, build_dial = build_dial,
        })
    end

    -- SINGLE FORWARD to a local extension (no SBC/carrier failover).
    local function forward_local(ext, leg_timeout)
        local domain = ctx.get_domain()
        set_var("carrier_used", "local")
        local ds = string.format(
            "{ignore_early_media=false,call_timeout=%d}user/%s@%s", leg_timeout, ext, domain)
        freeswitch.consoleLog("INFO", string.format(
            "[%s] RICH RCF forward (LOCAL): %s -> user/%s@%s (timeout=%ds)\n",
            uuid, normalized_did, ext, domain, leg_timeout))
        pcall(function() session:execute("bridge", ds) end)
    end

    local function forward_one(to, leg_timeout)
        if rich_is_local_extension(to) then
            forward_local(to, leg_timeout)
        else
            -- Toll-fraud gate on the RAW destination (intl gate + premium blocklist).
            local ok, reason = allowed(to)
            if not ok then
                freeswitch.consoleLog("WARNING", string.format(
                    "[%s] RICH RCF forward BLOCKED dest=%s reason=%s\n",
                    uuid, tostring(to), tostring(reason)))
                set_var("blocked_reason", reason)
                return
            end
            forward_pstn(carrier_dest(to), leg_timeout)
        end
    end

    -- RING GROUP — sequential: each leg single-bridges up to its own timeout and
    -- advances on no-answer (FMFM). PSTN legs reuse the carrier dial-string path.
    local function ring_sequential(r)
        multileg.sequential(session, get_var, r.legs, function(leg, idx)
            local to = leg.to
            if not to or to == "" then return nil end
            local leg_timeout = leg.timeout or r.ring_timeout
            local is_ext = rich_is_local_extension(to)
            freeswitch.consoleLog("INFO", string.format(
                "[%s] RICH RCF sequential leg %d/%d -> %s (timeout=%ds, %s)\n",
                uuid, idx, #r.legs, tostring(to), leg_timeout, is_ext and "ext" or "pstn"))
            if is_ext then
                return string.format(
                    "{ignore_early_media=false,call_timeout=%d}user/%s@%s",
                    leg_timeout, to, ctx.get_domain())
            end
            -- Toll-fraud gate: skip a disallowed PSTN leg (advance to next).
            local ok, reason = allowed(to)
            if not ok then
                freeswitch.consoleLog("WARNING", string.format(
                    "[%s] RICH RCF sequential leg %d/%d BLOCKED dest=%s reason=%s (skipping)\n",
                    uuid, idx, #r.legs, tostring(to), tostring(reason)))
                return nil
            end
            local inner = string.format(
                "ignore_early_media=false,call_timeout=%d,sip_h_X-Carrier=primary,sip_h_X-CID=%s,%s",
                leg_timeout, sip_call_id, session_timer.BRIDGE_OPTS)
            return dialstring.bridge(inner, carrier_dest(to), sbc_proxy_ip)
        end)
    end

    -- RING GROUP — parallel: ring all legs at once via ONE comma-joined dial
    -- string (simring) through the primary SBC/carrier.
    local function ring_parallel(r)
        local channels = {}
        local domain = ctx.get_domain()
        for _, leg in ipairs(r.legs) do
            local to = leg.to
            if to and to ~= "" then
                local lt = tonumber(leg.timeout)
                if rich_is_local_extension(to) then
                    local pfx = lt and ("[leg_timeout=" .. lt .. "]") or ""
                    channels[#channels + 1] = pfx .. string.format("user/%s@%s", to, domain)
                elseif allowed(to) then
                    local lv = {}
                    if lt then lv[#lv + 1] = "leg_timeout=" .. lt end
                    lv[#lv + 1] = "sip_h_X-Carrier=primary"
                    lv[#lv + 1] = "sip_h_X-CID=" .. sip_call_id
                    lv[#lv + 1] = session_timer.BRIDGE_OPTS
                    channels[#channels + 1] = "[" .. table.concat(lv, ",") .. "]" ..
                        string.format("sofia/external/%s@%s:5060", carrier_dest(to), sbc_proxy_ip)
                else
                    -- Toll-fraud gate: drop a disallowed PSTN endpoint from the simring.
                    freeswitch.consoleLog("WARNING", string.format(
                        "[%s] RICH RCF parallel endpoint BLOCKED dest=%s (dropping from simring)\n",
                        uuid, tostring(to)))
                end
            end
        end
        if #channels == 0 then return end
        freeswitch.consoleLog("INFO", string.format(
            "[%s] RICH RCF parallel ring %d endpoint(s), overall timeout=%ds\n",
            uuid, #channels, r.ring_timeout))
        local prefix = string.format("{ignore_early_media=false,call_timeout=%d}", r.ring_timeout)
        multileg.parallel(session, get_var, prefix, channels)
    end

    -- A rule's ring: 1 leg => forward (full failover); 2+ => ring group.
    local function execute_ring(r)
        if #r.legs == 1 then
            local leg = r.legs[1]
            forward_one(leg.to, leg.timeout or r.ring_timeout)
        elseif r.strategy == "parallel" then
            ring_parallel(r)
        else
            ring_sequential(r)
        end
    end

    -- DID-scoped voicemail recorder (rich fallback type "voicemail"). Delegates
    -- to the shared lib/vm_record so the tones/beep/record flow is identical to
    -- the UCaaS recorder.
    --
    -- ATTACHED-MODEL GATE (task §5): if a mailbox is bound to this RCF DID
    -- (voicemail_box_bindings binding_type='attached', attach_product='rcf'),
    -- record to tmpfs and upload it ENCRYPTED (the API encrypts on write — FS
    -- never inserts a row). When NO mailbox is bound the behavior is BYTE-FOR-BYTE
    -- the legacy spool deposit (same vm_dir, same record args, same notify meta,
    -- NO shred) — the same backward-compat discipline routing_plan uses. The
    -- attached lookup runs ONLY here on the no-answer fallback, never on the
    -- call-setup hot path.
    local function record_voicemail()
        local last_cause = get_var("last_bridge_hangup_cause", "")
        freeswitch.consoleLog("INFO", string.format(
            "[%s] RICH RCF fallback=voicemail (last_cause=%s) for DID %s\n",
            uuid, last_cause, normalized_did))

        local vmr = ctx.vm_record
        if not vmr or not vmr.record then
            freeswitch.consoleLog("ERR",
                "[" .. uuid .. "] vm_record unavailable — skipping voicemail\n")
            return
        end

        local did10 = ctx.to_10digit(normalized_did)

        local mailbox = nil
        if ctx.db and ctx.db.lookup_attached_mailbox then
            local okq, m = pcall(ctx.db.lookup_attached_mailbox, "rcf", normalized_did)
            if okq and type(m) == "table" and m.mailbox_id then mailbox = m end
        end

        if mailbox then
            -- ENCRYPTED deposit (attached mailbox) — tmpfs + shred.
            vmr.record({
                session = session, uuid = uuid, get_var = get_var,
                storage = "tmpfs",
                log_prefix = "[" .. uuid .. "] [rcf-vm] ",
                notify_duration = true,
                notify = {
                    to_did         = normalized_did,
                    mailbox_id     = mailbox.mailbox_id,
                    attach_product = "rcf",
                    attach_ref     = normalized_did,
                    customer_id    = ctx.customer_id,
                    caller_id      = original_caller_number,
                    caller_name    = original_caller_name,
                    source_model   = "rcf",
                },
            })
        else
            -- LEGACY spool deposit (no mailbox bound) — byte-for-byte unchanged.
            vmr.record({
                session = session, uuid = uuid, get_var = get_var,
                storage = "spool",
                vm_dir = string.format("/var/lib/freeswitch/voicemail/rcf/%s", did10),
                log_prefix = "[" .. uuid .. "] [rcf-vm] ",
                notify = {
                    extension   = did10,
                    customer_id = ctx.customer_id,
                    caller_id   = original_caller_number,
                    caller_name = original_caller_name,
                },
            })
        end
    end

    -- Plan-level fallback once a matched rule's ring fails / no rule matched.
    local fb = (type(plan.fallback) == "table") and plan.fallback or {}
    local fb_type = fb.type
    local function execute_fallback()
        if fb_type == "hangup" then
            hangup("NO_ANSWER",
                "[" .. uuid .. "] RICH RCF plan exhausted, fallback=hangup")
            return
        elseif fb_type == "forward" then
            local to = (fb.to and trim(tostring(fb.to))) or ""
            if to ~= "" then
                freeswitch.consoleLog("INFO", string.format(
                    "[%s] RICH RCF fallback=forward -> %s\n", uuid, to))
                forward_one(to, tonumber(fb.timeout) or ring_timeout)
                if bridged_ok() then return end
                hangup("NORMAL_TEMPORARY_FAILURE",
                    "[" .. uuid .. "] RICH RCF forward fallback failed, returning 503")
                return
            end
            -- forward configured with no target -> graceful failure.
            hangup("NORMAL_TEMPORARY_FAILURE",
                "[" .. uuid .. "] RICH RCF fallback=forward but no target, returning 503")
            return
        elseif fb_type == "voicemail" then
            record_voicemail()
            return
        end
        -- nil / unknown fallback type -> graceful 503 (DID found, ring exhausted).
        hangup("NORMAL_TEMPORARY_FAILURE",
            "[" .. uuid .. "] RICH RCF plan exhausted (no fallback), returning 503")
    end

    -- ----- rule selection (document order; first match wins) -----------------
    -- The schedule + caller-id matcher lives in lib/rules.lua (shared with the
    -- SIP-trunk RICH route_plan path). first_match returns the first rule whose
    -- `match` applies, or nil. Identical semantics to the prior inline loop.
    -- `now` for schedule rule evaluation. RCF_NOW_OVERRIDE is a TEST-ONLY seam
    -- that pins "now" deterministically; it is honored ONLY under TEST_MODE so the
    -- production routing path can never have its schedule clock overridden by the
    -- environment (TEST_MODE unset/false -> os.time() ALWAYS wins).
    local now = os.time()
    if os.getenv("TEST_MODE") == "true" then
        now = tonumber(os.getenv("RCF_NOW_OVERRIDE")) or now
    end
    local matched, matched_idx
    local rules_mod = ctx.rules
    if rules_mod and rules_mod.first_match then
        matched, matched_idx = rules_mod.first_match(plan.rules, {
            caller = caller_e164, now = now, schedule = sched })
    else
        freeswitch.consoleLog("ERR",
            "[" .. uuid .. "] RICH RCF: rules lib unavailable — no rule can match, using fallback\n")
    end

    local r = nil
    if matched then
        local nr = normalize_ring(matched.ring, ring_timeout)
        if #nr.legs > 0 then r = nr end
    end

    freeswitch.consoleLog("INFO", string.format(
        "[%s] RICH RCF: DID=%s rules=%d matched=%s legs=%s strategy=%s fallback=%s\n",
        uuid, normalized_did, #plan.rules, tostring(matched_idx),
        r and tostring(#r.legs) or "0", r and r.strategy or "-", tostring(fb_type)))

    -- ----- does anything we will execute terminate on the carrier? -----------
    local function ring_has_pstn(rr)
        for _, leg in ipairs(rr.legs) do
            if not rich_is_local_extension(leg.to) then return true end
        end
        return false
    end
    local needs_pstn = false
    if r then needs_pstn = ring_has_pstn(r) end
    if not needs_pstn and fb_type == "forward" then
        local to = (fb.to and trim(tostring(fb.to))) or ""
        if to ~= "" and not rich_is_local_extension(to) then needs_pstn = true end
    end

    -- ----- test mode: never touch the carrier (mirror legacy) ----------------
    if os.getenv("TEST_MODE") == "true" and needs_pstn then
        freeswitch.consoleLog("INFO", string.format(
            "[%s] RICH RCF TEST MODE: would ring matched plan (rule=%s) — playing tone\n",
            uuid, tostring(matched_idx)))
        pcall(function()
            session:answer()
            session:execute("playback", "tone_stream://%(1000,0,600)")
            session:sleep(2000)
            session:hangup("NORMAL_CLEARING")
        end)
        return
    end

    -- ----- channel control + ringback (mirror legacy) ------------------------
    set_var("ringback", "%(2000,4000,440,480)")
    set_var("transfer_ringback", "%(2000,4000,440,480)")
    set_var("hangup_after_bridge", "true")
    set_var("continue_on_fail", "true")
    set_var("lua_routed", "true")
    if r and r.legs[1] then set_var("forward_to", r.legs[1].to) end  -- CDR legibility

    -- ----- caller ID (FusionPBX-style, identical policy to the legacy path) ---
    session:setVariable("outbound_caller_id_number", outbound_did)
    session:setVariable("outbound_caller_id_name", outbound_did)
    if pass_caller_id then
        session:setVariable("effective_caller_id_number", ctx.to_10digit(original_caller_number))
        session:setVariable("effective_caller_id_name", original_caller_name)
    else
        session:setVariable("effective_caller_id_number", outbound_did)
        session:setVariable("effective_caller_id_name", outbound_did)
    end
    session:setVariable("sip_h_Diversion", caller_id.diversion(outbound_did, external_sip_ip))
    if pass_caller_id then
        session:setVariable("sip_h_X-Original-CID", e164_original_cid)
    else
        session:setVariable("sip_h_X-Original-CID", e164_did)
    end
    local rcf_name = routing.rcf_name
    if rcf_name and rcf_name ~= "" then
        session:setVariable("sip_h_X-Original-CID-Name", rcf_name)
    end

    -- RFC 4028 session timers exported to the B-leg (unconditional, like legacy).
    session_timer.export(session)

    -- PSTN-only identity headers / From-auth exports, armed once if any leg or a
    -- forward fallback terminates to the carrier.
    if needs_pstn then
        if pass_caller_id then
            session:setVariable("sip_h_Remote-Party-ID",
                caller_id.remote_party_id(e164_original_cid, external_sip_ip))
        else
            session:setVariable("sip_h_Remote-Party-ID",
                caller_id.remote_party_id(e164_did, external_sip_ip))
        end
        pcall(function() session:execute("export", "origination_caller_id_number=" .. outbound_did) end)
        pcall(function() session:execute("export", "origination_caller_id_name=" .. outbound_did) end)
    end

    -- ----- per-customer + per-DID concurrent call caps (mod_hash, no Redis) --
    -- Per-customer cap (customers.max_concurrent_calls) is the backstop against a
    -- compromised forward_to flooding the account; per-DID cap (rcf_numbers.
    -- max_channels, 0 -> sane non-zero default) caps a single DID. Fail-open when
    -- the policy is unreadable.
    if not apply_concurrency_limits(ctx, fraud_policy) then
        return  -- a cap was hit; the limit app already hung up the session (486)
    end

    -- ----- ring the matched rule, then fall back -----------------------------
    if r then
        execute_ring(r)
        if bridged_ok() then return end
    end
    execute_fallback()
end

return function(ctx)
    local session = ctx.session
    local get_var = ctx.get_var
    local set_var = ctx.set_var
    local hangup = ctx.hangup
    local uuid = ctx.uuid
    local normalized_did = ctx.normalized_did
    local forward_to = ctx.forward_to
    local ring_timeout = ctx.ring_timeout
    local pass_caller_id = ctx.pass_caller_id
    local routing = ctx.routing
    local original_caller_number = ctx.original_caller_number
    local original_caller_name = ctx.original_caller_name
    local traffic_grade = ctx.traffic_grade
    local to_10digit = ctx.to_10digit
    local normalize_did = ctx.normalize_did
    local external_sip_ip = ctx.external_sip_ip
    local sbc_proxy_ip = ctx.sbc_proxy_ip
    local sbc_proxy_ip_failover = ctx.sbc_proxy_ip_failover
    local bridge_progress_timeout = ctx.bridge_progress_timeout
    local sbc = ctx.sbc
    local dialstring = ctx.dialstring
    local caller_id = ctx.caller_id
    local session_timer = ctx.session_timer

    -- RICH RCF gate: when this DID carries a routing_plan, evaluate the ordered
    -- match rules and ring each rule's leg(s) (handle_rich_plan). Otherwise fall
    -- THROUGH to the byte-for-byte legacy single-forward path below. A nil /
    -- malformed plan (db_client.lookup_rcf already nil-safed it) takes the legacy
    -- path — this is the load-bearing backward-compat guard protecting the LIVE
    -- Granite call path.
    local routing_plan = ctx.routing and ctx.routing.routing_plan
    if type(routing_plan) == "table"
        and type(routing_plan.rules) == "table"
        and #routing_plan.rules > 0 then
        return handle_rich_plan(ctx, routing_plan)
    end

    -- Helper: Check if forward_to is a local extension (4 digits, 10xx).
    local function is_local_extension(number)
        if not number then return false end
        return number:match("^10%d%d$") ~= nil
    end

    -- Remote Call Forwarding - Bridge to destination
    -- RCF terminates through the primary carrier (TC4 Dallas).
    -- Kamailio sets X-Inbound-TC header for logging/Homer visibility, but
    -- outbound carrier selection is fixed to TC4 until all trunk groups are
    -- provisioned for our IPs on the Bandwidth side.
    -- To enable trunk-affinity routing later, read X-Inbound-TC and map to carrier:
    --   local inbound_tc = get_var("sip_h_X-Inbound-TC", ""):match("^%s*(.-)%s*$") or ""
    --   if inbound_tc == "tc1" then carrier = "tc1" elseif inbound_tc == "tc2" then carrier = "tc2" end
    local inbound_tc = get_var("sip_h_X-Inbound-TC", "")

    -- Use the actual SIP Call-ID from the inbound INVITE for X-CID correlation.
    -- The uuid is FreeSWITCH's internal session ID which differs from the SIP Call-ID
    -- that Homer/HEP captures on the A-leg. Using sip_call_id lets us correlate
    -- A-leg and B-leg in Homer. Fallback to uuid if sip_call_id is not set.
    local sip_call_id = session:getVariable("sip_call_id") or uuid
    inbound_tc = inbound_tc:match("^%s*(.-)%s*$") or ""
    local carrier = "primary"  -- TC4 only — do not change until Bandwidth provisions all TCs
    freeswitch.consoleLog("INFO", string.format(
        "[inbound_router] Routing via carrier=%s (inbound_tc=%s, product: rcf, traffic_grade: %s)\n",
        carrier, inbound_tc, traffic_grade
    ))

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

    -- ================================================================
    -- TOLL-FRAUD GATE (P0): international gate + premium/high-risk blocklist.
    -- PSTN forwards only — local extensions (10xx) are never intl/blocked.
    -- fraud_policy is fetched ONCE here and reused by the concurrency caps below.
    -- ================================================================
    local fraud_policy = fetch_fraud_policy(ctx)
    if not is_local_forward then
        local allow_ok, reason = dest_allowed(ctx, fraud_policy, forward_to)
        if not allow_ok then
            set_var("lua_routed", "true")
            set_var("blocked_reason", reason)
            hangup("CALL_REJECTED", string.format(
                "[%s] RCF forward BLOCKED: DID=%s -> %s reason=%s",
                uuid, normalized_did, forward_to, reason))
            return
        end
    end

    -- Set bridge parameters
    set_var("forward_to", forward_to)
    set_var("call_timeout", tostring(ring_timeout))

    -- Media: DEFAULT media mode (FS stays in the RTP path as B2BUA). The RCF
    -- path does NOT set proxy_media — that was removed after the Cloud-NAT fix
    -- resolved the real audio issue (CLAUDE.md). ringback is the local tone
    -- played on the A-leg while the B-leg rings.
    set_var("ringback", "%(2000,4000,440,480)")
    set_var("transfer_ringback", "%(2000,4000,440,480)")

    local dial_string

    -- ================================================================
    -- Caller ID handling: FusionPBX-style approach (setVariable, not
    -- dial-string overrides). SIP headers produced (after Kamailio):
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
        -- Override: called party sees the RCF DID, not the original caller
        session:setVariable("effective_caller_id_number", outbound_did)
        session:setVariable("effective_caller_id_name", outbound_did)
    end

    -- Diversion header indicates the call was forwarded and from which number
    session:setVariable("sip_h_Diversion", caller_id.diversion(outbound_did, external_sip_ip))

    -- X-Original-CID: Kamailio reads this to build P-Asserted-Identity
    -- Uses E.164 (+1XXXXXXXXXX) format. When pass_caller_id=true, this is the
    -- original caller's number; when false, it's the RCF DID itself.
    if pass_caller_id then
        session:setVariable("sip_h_X-Original-CID", e164_original_cid)
    else
        session:setVariable("sip_h_X-Original-CID", e164_did)
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
        local domain = ctx.get_domain()
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
                caller_id.remote_party_id(e164_original_cid, external_sip_ip))
        else
            session:setVariable("sip_h_Remote-Party-ID",
                caller_id.remote_party_id(e164_did, external_sip_ip))
        end

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
    -- Session-Expires and Min-SE in the outbound INVITE. set_var() only sets
    -- the A-leg; export marks the variable for propagation to the B-leg.
    -- (exports sip_session_timeout=1800, sip_minimum_session_expires=90,
    -- enable_timer=true — same three the prior inline copy emitted.)
    session_timer.export(session)

    -- ================================================================
    -- Concurrent call caps (mod_hash, no Redis): per-customer + per-DID.
    -- ================================================================
    -- Per-customer cap (customers.max_concurrent_calls) is the backstop against a
    -- compromised forward_to flooding the whole account; per-DID cap
    -- (rcf_numbers.max_channels; 0/unset -> sane non-zero default, no longer
    -- "unlimited") caps a single DID. Both reject with 486 Busy Here when hit.
    -- Fail-open when the per-customer policy is unreadable (see apply_concurrency_limits).
    if not apply_concurrency_limits(ctx, fraud_policy) then
        return  -- a cap was hit; the limit app already hung up the session (486)
    end

    -- ================================================================
    -- SBC + Carrier failover: 4 bridge attempts for PSTN routing
    -- ================================================================
    -- For local extensions, there is only the single dial_string built above.
    -- For PSTN, we try all combinations of SBC (SBC-1/SBC-2) and
    -- carrier (primary/secondary) before giving up:
    --   1. SBC-1 + primary carrier   (Dallas)
    --   2. SBC-2 + primary carrier   (Dallas)
    --   3. SBC-1 + secondary carrier (LA)
    --   4. SBC-2 + secondary carrier (LA)
    --
    -- Channel variables (outbound_caller_id_*, effective_caller_id_*,
    -- sip_h_Diversion, sip_h_X-Original-CID, sip_h_Remote-Party-ID)
    -- and exported origination_caller_id_* persist on the session across
    -- all bridge attempts. Only X-Carrier and the SBC IP change per attempt.
    -- ================================================================

    if is_local_forward then
        -- Local extension: single bridge attempt (no SBC/carrier failover)
        pcall(function()
            session:execute("bridge", dial_string)
        end)
    else
        -- PSTN: SBC + carrier failover loop (lib/sbc.lua).
        --
        -- LCO (least-cost outbound): when the backend lco_routes view has a match
        -- for this destination's prefix, lib/lco returns the ORDERED carrier tokens
        -- and build_attempts expands them into the SAME 2-SBC × N-carrier structure.
        -- FAIL-SAFE: no LCO decision (nil) -> the EXACT legacy
        -- {primary,secondary}×{SBC-1,SBC-2} literal below, so the LIVE default path
        -- is byte-identical until the backend populates lco_routes. Failover
        -- semantics (lib/sbc TCP pre-check, progress_timeout, session timers) are
        -- unchanged either way.
        -- M-1: INBOUND uses the DB lookup ONLY — do NOT pass get_var. The explicit
        -- sip_h_X-LCO-Route / lco_route header path is attacker-reachable on the
        -- inbound leg (it would collapse the 4-attempt failover) and is kept ONLY on
        -- the ESL-originated A-leg (outbound_api.lua). (Belt: kamailio.cfg
        -- route[STRIP_CLIENT_HEADERS] also scrubs an inbound X-LCO-Route.)
        local lco_carriers = ctx.lco and ctx.lco.resolve_carriers({
            db = ctx.db, dest = normalize_did(forward_to), uuid = uuid,
        }) or nil
        local bridge_attempts = (lco_carriers and ctx.lco.build_attempts(
                lco_carriers, sbc_proxy_ip, sbc_proxy_ip_failover)) or {
            { sbc = sbc_proxy_ip,          carrier = "primary",   label = "SBC-1 + primary carrier (Dallas)" },
            { sbc = sbc_proxy_ip_failover, carrier = "primary",   label = "SBC-2 + primary carrier (Dallas)" },
            { sbc = sbc_proxy_ip,          carrier = "secondary", label = "SBC-1 + secondary carrier (LA)" },
            { sbc = sbc_proxy_ip_failover, carrier = "secondary", label = "SBC-2 + secondary carrier (LA)" },
        }

        -- Per-attempt dial string. progress_timeout bounds carrier PDD: the
        -- attempt fails over only if NO provisional (180/183) arrives within
        -- N seconds; once ringing starts the call may ring up to call_timeout.
        -- The session-timer fragment is shared via session_timer.BRIDGE_OPTS,
        -- and the sofia/external skeleton via dialstring.bridge — byte-for-byte
        -- the string the prior inline copy produced.
        local function build_dial(attempt)
            local inner = string.format(
                "ignore_early_media=false,progress_timeout=%d,call_timeout=%d,sip_h_X-Carrier=%s,sip_h_X-CID=%s,%s",
                bridge_progress_timeout,
                ring_timeout,
                attempt.carrier,
                sip_call_id,
                session_timer.BRIDGE_OPTS
            )
            return dialstring.bridge(inner, forward_to, attempt.sbc)
        end

        sbc.failover_bridge({
            session = session,
            get_var = get_var,
            set_var = set_var,
            uuid = uuid,
            did = normalized_did,
            dest = forward_to,
            attempts = bridge_attempts,
            build_dial = build_dial,
        })
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
