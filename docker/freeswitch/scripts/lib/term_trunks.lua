-- ================================================================
-- term_trunks.lua — shared table-driven termination (carrier_trunks)
-- ================================================================
-- ONE implementation of the carrier_trunks termination selection used by
--   * inbound_router.lua  (RCF off-net PSTN leg — LIVE production path)
--   * trunk_outbound.lua  (customer SIP trunk, NANP 8YY destinations only)
--   * api_outbound.lua    (API Calling, NANP 8YY destinations only; retired)
--
-- What lives here (pure / process-cache helpers, no session access):
--   get(zone, db, tag)            cached, validated, priority-ordered trunk list
--                                 (nil => DB error / zero usable rows / bad cache)
--   classify_destination(n, nu)   'tollfree' (NANP 8YY) | 'ld'
--   filter_for_class(list, cls)   per-call traffic_class filter (strict TF)
--   build_attempts(list, s1, s2)  trunk-major {SBC-1, SBC-2} attempt table
--                                 (carrier 'verizon' rows: SBC-1/VIP only)
--   dial_string(lead, a, cid, leg, dest)   per-attempt carrier dial string
--   is_sbc_reachable(ip, port, tag)        cached TCP pre-check (shared cache)
--   run_attempts(opts)            the failover loop for trunk/API 8YY egress
--
-- Loaded with loadfile() (mod_lua constraint: never require() local modules;
-- the CALLER sets package.path/cpath before loading). Uses the mod_lua
-- globals `freeswitch` (consoleLog, get/setGlobalVariable) and `os.time`.
-- No Redis anywhere (RCF path constraint).
--
-- Selection SQL (db_client.get_termination_trunks, unchanged):
--   SELECT carrier, pop, host(source_ip) AS term_ip, traffic_class,
--          COALESCE(priority_<zone>, priority) AS eff_priority
--   FROM carrier_trunks
--   WHERE direction IN ('outbound','both') AND enabled = true
--   ORDER BY eff_priority, id
-- The direction filter is what makes the 2026-10 "one ingress + one egress
-- row per IP" schema safe here: an 'inbound' Sinch 8XX-T orig row and the
-- 'outbound' redundant termination row on the SAME source_ip are distinct
-- rows; only the outbound one is ever returned. Nothing below is keyed by
-- IP (the cache is an ordered list, never a map), so two rows can never be
-- collapsed into one.
--
-- Process-wide cache (FreeSWITCH global variable, shared by all three
-- scripts — same key, same format):
--   "term_trunks_<zone>" = "<epoch>|carrier,pop,ip,class;..."  (TTL 60s)
--   "<epoch>|FALLBACK"   = negative cache (DB error / zero usable rows)
-- A 3-field pre-44 entry (no class) still parses as class 'any'.

local M = {}

M.TTL = 60          -- seconds a cached trunk list is trusted
-- NO per-call attempt cap (owner decision 2026-10-29, Verizon plan §7): the
-- hunt goes through EVERY eligible row in eff_priority order, so a
-- bottom-priority trunk (Verizon at 50) is always reached once the rows above
-- it have failed. The only bound is CACHE_MAX — the operator's real knob.
M.CACHE_MAX = 16    -- max rows serialized into the global-var cache

local SBC_HEALTH_UP_TTL = 30
local SBC_HEALTH_DOWN_TTL = 10

local function log(level, msg)
    if freeswitch and freeswitch.consoleLog then
        freeswitch.consoleLog(level, msg)
    end
end

-- Sanitize a carrier/pop token for cache/dial-string/header safety:
-- keep [A-Za-z0-9_.-] only. Row values are admin-provisioned closed
-- vocabulary (TED), so this is belt-and-suspenders, not lossy.
function M.token(s)
    return (tostring(s or ""):gsub("[^%w%._%-]", ""))
end

-- Coerce a trunk traffic_class to the closed {any, ld, tollfree} set.
-- Anything else (NULL from a pre-44 replica, an unexpected future value)
-- becomes 'any' — the unrestricted class — so a schema/value surprise can
-- only ever WIDEN a trunk's eligibility back to pre-44 behavior.
function M.class(s)
    if s == "ld" or s == "tollfree" then
        return s
    end
    return "any"
end

-- classify_destination(number, number_utils) -> 'tollfree' | 'ld'.
-- Delegates to number_utils.classify_destination (unit-tested) when the
-- caller passes it; the inline fallback is the identical algorithm.
-- KEEP IN SYNC: number_utils.TOLLFREE_NPAS and Kamailio route[TF_CLASSIFY].
local TOLLFREE_NPAS_FALLBACK = {
    ["800"] = true, ["833"] = true, ["844"] = true, ["855"] = true,
    ["866"] = true, ["877"] = true, ["888"] = true,
}
function M.classify_destination(number, number_utils)
    if number_utils and number_utils.classify_destination then
        return number_utils.classify_destination(number)
    end
    local d = tostring(number or ""):gsub("%D", "")
    if #d == 11 and d:sub(1, 1) == "1" then
        d = d:sub(2)
    end
    if #d == 10 and TOLLFREE_NPAS_FALLBACK[d:sub(1, 3)] then
        return "tollfree"
    end
    return "ld"
end

-- Parse the serialized cache payload back into the trunk list.
-- Any malformed segment invalidates the WHOLE payload (nil) — never
-- bridge from a half-parsed trunk list.
function M.parse(payload)
    local trunks = {}
    for seg in payload:gmatch("[^;]+") do
        local carrier, pop, ip, class = seg:match("^([%w%._%-]+),([%w%._%-]*),(%d+%.%d+%.%d+%.%d+),(%a+)$")
        if not carrier then
            -- 3-field pre-44 cache entry: parses as class 'any'.
            carrier, pop, ip = seg:match("^([%w%._%-]+),([%w%._%-]*),(%d+%.%d+%.%d+%.%d+)$")
            class = "any"
        end
        if not carrier then
            return nil
        end
        trunks[#trunks + 1] = {
            carrier = carrier, pop = pop, term_ip = ip,
            traffic_class = M.class(class),
        }
    end
    if #trunks == 0 then
        return nil
    end
    return trunks
end

-- get(zone, db, tag): ordered trunk list from carrier_trunks, or nil =>
-- the caller decides (RCF: legacy Bandwidth fallback loop, fail-open;
-- trunk/API 8YY: fail closed). `tag` prefixes log lines ("inbound_router"
-- keeps the RCF log text byte-identical to the pre-extraction script).
function M.get(zone, db, tag)
    tag = tag or "term_trunks"
    local cache_key = "term_trunks_" .. zone
    local now = os.time()

    -- Cache check — fresh entries (TTL 60s) never touch the DB.
    local cached = freeswitch.getGlobalVariable(cache_key)
    if cached and cached ~= "" then
        local ts, payload = cached:match("^(%d+)|(.+)$")
        ts = tonumber(ts)
        if ts and payload then
            local age = now - ts
            if age >= 0 and age < M.TTL then
                if payload == "FALLBACK" then
                    return nil  -- negative-cached miss; re-fetch after TTL
                end
                local trunks = M.parse(payload)
                if trunks then
                    return trunks
                end
                log("WARNING", string.format(
                    "[%s] term_trunks cache unparsable for zone %s — using legacy fallback attempts\n",
                    tag, zone))
                freeswitch.setGlobalVariable(cache_key, string.format("%d|FALLBACK", now))
                return nil
            end
        end
    end

    -- Cache miss/expired: one DB fetch via db_client.
    local rows = nil
    if db and db.get_termination_trunks then
        local ok, res = pcall(function() return db.get_termination_trunks(zone) end)
        if ok then
            rows = res
        else
            log("ERR", string.format(
                "[%s] get_termination_trunks(%s) raised: %s\n",
                tag, zone, tostring(res)))
        end
    end

    if type(rows) ~= "table" then
        log("WARNING", string.format(
            "[%s] carrier_trunks lookup failed for zone %s — using legacy fallback attempts\n",
            tag, zone))
        freeswitch.setGlobalVariable(cache_key, string.format("%d|FALLBACK", now))
        return nil
    end

    -- Validate + serialize. Rows with an empty carrier or non-IPv4 term_ip
    -- are dropped (WARN); rows beyond CACHE_MAX are ignored (WARN). There is
    -- no further per-call cap: every cached row that passes the class
    -- filter is attempted.
    local parts = {}
    local capped = false
    for _, row in ipairs(rows) do
        local carrier = M.token(row.carrier)
        local pop = M.token(row.pop)
        local ip = tostring(row.term_ip or "")
        if carrier == "" or not ip:match("^%d+%.%d+%.%d+%.%d+$") then
            log("WARNING", string.format(
                "[%s] carrier_trunks row carrier=%s pop=%s term_ip=%s is unusable — skipped\n",
                tag, tostring(row.carrier), tostring(row.pop), ip))
        elseif #parts >= M.CACHE_MAX then
            if not capped then
                log("WARNING", string.format(
                    "[%s] carrier_trunks returned more than %d outbound rows for zone %s — extra rows ignored (cache cap)\n",
                    tag, M.CACHE_MAX, zone))
                capped = true
            end
        else
            parts[#parts + 1] = carrier .. "," .. pop .. "," .. ip .. ","
                .. M.class(row.traffic_class)
        end
    end

    if #parts == 0 then
        log("WARNING", string.format(
            "[%s] no enabled outbound carrier_trunks rows for zone %s — using legacy fallback attempts\n",
            tag, zone))
        freeswitch.setGlobalVariable(cache_key, string.format("%d|FALLBACK", now))
        return nil
    end

    local payload = table.concat(parts, ";")
    freeswitch.setGlobalVariable(cache_key, string.format("%d|%s", now, payload))
    -- Return by re-parsing what was serialized, so cached and fresh calls
    -- yield the identical validated shape.
    return M.parse(payload)
end

-- filter_for_class(trunks, dest_class) -> eligible list (order preserved,
-- may be empty). CONTRACT:
--   'tollfree' -> STRICT: only class 'tollfree' trunks ('any'/'ld' never).
--   'ld'       -> class 'any' or 'ld'. (An empty result is the CALLER's
--                 decision: inbound_router falls back to the full list.)
function M.filter_for_class(trunks, dest_class)
    local eligible = {}
    for _, trunk in ipairs(trunks or {}) do
        local ok
        if dest_class == "tollfree" then
            ok = trunk.traffic_class == "tollfree"
        else
            ok = trunk.traffic_class == "any" or trunk.traffic_class == dest_class
        end
        if ok then
            eligible[#eligible + 1] = trunk
        end
    end
    return eligible
end

-- Carriers whose rows get ONLY the sbc1 (signaling-VIP) attempt. Verizon's
-- replies all land on the ACTIVE SBC via the zone's .251 ILB rule, so an
-- attempt sent to SBC-1's direct IP (sbc2 here) can never receive its reply
-- while SBC-1 is standby — Kamailio answers such an INVITE 503 immediately
-- (plan §8.1 item 3). Emitting the attempt would only add a wasted leg.
-- Keyed on the SANITIZED row carrier (M.token output, the same value that
-- goes into X-Carrier-Label / carrier_used), lower-case exact match.
M.VIP_ONLY_CARRIERS = { verizon = true }

-- build_attempts(trunks, sbc1, sbc2): trunk-major attempt table — for each
-- trunk (eff_priority order) try SBC-1 (sbc1 = signaling VIP), then SBC-2
-- (sbc2 = SBC-1 direct IP). VIP_ONLY_CARRIERS rows emit the sbc1 attempt
-- only; every other carrier is byte-identical to before.
function M.build_attempts(trunks, sbc1, sbc2)
    local attempts = {}
    for _, trunk in ipairs(trunks) do
        local carrier_label = trunk.carrier
        if trunk.pop and trunk.pop ~= "" then
            carrier_label = trunk.carrier .. "-" .. trunk.pop
        end
        attempts[#attempts + 1] = {
            sbc = sbc1, ip = trunk.term_ip, carrier_label = carrier_label,
            label = "SBC-1 + " .. carrier_label .. " (" .. trunk.term_ip .. ")",
        }
        if not M.VIP_ONLY_CARRIERS[string.lower(trunk.carrier)] then
            attempts[#attempts + 1] = {
                sbc = sbc2, ip = trunk.term_ip, carrier_label = carrier_label,
                label = "SBC-2 + " .. carrier_label .. " (" .. trunk.term_ip .. ")",
            }
        end
    end
    return attempts
end

-- dial_string(lead_vars, attempt, call_id, leg_block, dest):
--   "{<lead_vars>,sip_h_X-Carrier-IP=<ip>,sip_h_X-Carrier-Label=<label>,
--     sip_h_X-CID=<call_id>,sip_session_timeout=1800,
--     sip_minimum_session_expires=90,enable_timer=true}<leg_block>
--    sofia/external/<dest>@<sbc>:5060"
-- lead_vars is the per-script prefix (each product keeps its own
-- progress_timeout / call_timeout / SOA / caller-ID vars). X-Carrier-IP /
-- X-Carrier-Label are the selector Kamailio route[TO_CARRIER] Step 1a
-- validates (enabled outbound carrier_trunks row or env Bandwidth IP). The
-- session-timer trio is inert (mod_sofia reads none of it) and kept only
-- for byte-identity with the pre-extraction RCF dial string.
function M.dial_string(lead_vars, attempt, call_id, leg_block, dest)
    return string.format(
        "{%s,sip_h_X-Carrier-IP=%s,sip_h_X-Carrier-Label=%s" ..
        ",sip_h_X-CID=%s" ..
        ",sip_session_timeout=1800,sip_minimum_session_expires=90,enable_timer=true" ..
        "}%ssofia/external/%s@%s:5060",
        lead_vars,
        attempt.ip,
        attempt.carrier_label,
        call_id,
        leg_block or "",
        dest,
        attempt.sbc
    )
end

-- ================================================================
-- SBC TCP pre-check (cached) — same cache key/format/TTLs as the copy in
-- inbound_router.lua ("sbc_health_<ip>" = "<up|down>:<epoch>", up 30s,
-- down 10s), so all scripts share one process-wide health view.
-- inbound_router.lua keeps its own inline copy (live path, untouched).
-- ================================================================
local luasocket_warned = false

local function sbc_tcp_probe(ip, port, tag)
    local ok, socket = pcall(require, "socket")
    if not ok then
        if not luasocket_warned then
            log("WARNING", string.format(
                "[%s] luasocket unavailable (%s) — SBC TCP pre-check disabled, failing open\n",
                tag, tostring(socket)))
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

function M.is_sbc_reachable(ip, port, tag)
    tag = tag or "term_trunks"
    local cache_key = "sbc_health_" .. ip
    local now = os.time()

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
            return cached_status == "up"
        end
    end

    local probe = sbc_tcp_probe(ip, port, tag)
    if probe == nil then
        return true  -- luasocket unavailable: fail open, do not cache
    end

    local new_status = probe and "up" or "down"
    if cached_status and cached_status ~= new_status then
        log("INFO", string.format(
            "[%s] SBC %s health transition: %s -> %s\n",
            tag, ip, cached_status, new_status))
    elseif not cached_status and new_status == "down" then
        log("INFO", string.format(
            "[%s] SBC %s health: down (first probe)\n", tag, ip))
    end
    freeswitch.setGlobalVariable(cache_key, string.format("%s:%d", new_status, now))
    return probe
end

-- zone(): FS_ZONE validated against east/west/central (else east) — same
-- rule as inbound_router.lua's fs_zone (no warning here; inbound_router
-- already warns once per call on a bad value).
function M.zone()
    local z = os.getenv("FS_ZONE") or "east"
    if z ~= "east" and z ~= "west" and z ~= "central" then
        z = "east"
    end
    return z
end

-- select_tollfree(zone, db, tag) -> attempts-ready trunk list or nil, source
-- For the trunk/API 8YY egress: STRICT 'tollfree' rows only, every eligible
-- row (no cap).
-- Returns (list, "db") when at least one enabled tollfree trunk exists;
-- (nil, "db") when the table resolved but carries no tollfree trunk;
-- (nil, "fallback") when the table could not be resolved (DB error / zero
-- outbound rows / unparsable cache). The callers FAIL CLOSED on both nil
-- cases — unlike inbound_router's class-blind legacy loop, these products
-- never had an 8YY route, so there is nothing to fail open TO.
function M.select_tollfree(zone, db, tag)
    local trunks = M.get(zone, db, tag)
    if not trunks then
        return nil, "fallback"
    end
    local eligible = M.filter_for_class(trunks, "tollfree")
    if #eligible == 0 then
        return nil, "db"
    end
    return eligible, "db"
end

-- run_attempts(opts): failover loop for trunk/API 8YY egress. Same shape
-- and disposition contract as inbound_router.lua's table-driven loop:
--   * cached TCP pre-check per attempt; a dead SBC is SKIPPED (no B
--     channel, not counted in the launched-leg counter);
--   * carrier_used = "<carrier>-<pop>" set before each launched attempt,
--     so it records the WINNING attempt;
--   * break on originate_disposition == "SUCCESS";
--   * break when the A-leg is gone (session:ready() false).
-- opts: session, get_var, set_var, tag, uuid, attempts, lead_vars,
--       call_id, dest, leg_block(n) (optional), stir_reset(), stir_capture(uuid, label)
-- Returns the final originate_disposition ("" when nothing launched).
function M.run_attempts(opts)
    local session = opts.session
    local total = #opts.attempts
    local launched = 0
    for i, attempt in ipairs(opts.attempts) do
        local attempted = false
        if not M.is_sbc_reachable(attempt.sbc, 5060, opts.tag) then
            log("WARNING", string.format(
                "[%s] [%s] 8YY bridge attempt %d/%d SKIPPED — SBC %s unreachable (%s)\n",
                opts.tag, opts.uuid, i, total, attempt.sbc, attempt.label))
        else
            attempted = true
            launched = launched + 1
            local leg = ""
            if opts.leg_block then
                leg = opts.leg_block(launched)
            end
            local dial = M.dial_string(opts.lead_vars, attempt, opts.call_id, leg, opts.dest)
            opts.set_var("carrier_used", attempt.carrier_label)
            log("INFO", string.format(
                "[%s] [%s] 8YY bridge attempt %d/%d (%s): -> %s@%s carrier_ip=%s\n",
                opts.tag, opts.uuid, i, total, attempt.label, opts.dest, attempt.sbc, attempt.ip))
            if opts.stir_reset then opts.stir_reset() end
            pcall(function()
                session:execute("bridge", dial)
            end)
            if opts.stir_capture then opts.stir_capture(opts.uuid, attempt.label) end
        end

        if attempted then
            local disposition = opts.get_var("originate_disposition", "")
            if disposition == "SUCCESS" then
                log("INFO", string.format(
                    "[%s] [%s] 8YY bridge attempt %d/%d succeeded (%s)\n",
                    opts.tag, opts.uuid, i, total, attempt.label))
                return disposition
            end
            log("INFO", string.format(
                "[%s] [%s] 8YY bridge attempt %d/%d failed (%s): cause=%s\n",
                opts.tag, opts.uuid, i, total, attempt.label,
                opts.get_var("last_bridge_hangup_cause", disposition)))
        end

        if not session:ready() then
            break
        end
    end
    if launched == 0 then
        return ""
    end
    return opts.get_var("originate_disposition", "")
end

return M
