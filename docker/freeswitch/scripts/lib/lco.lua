-- lib/lco.lua — Least-Cost Outbound (LCO) carrier ordering (RCF-V1)
--
-- TELEPHONY HALF of LCO carrier steering. The backend owns the rate deck + the
-- LCO decision data (the `lco_route` view — a CONTRACT, see below); this module
-- only READS an ordered list of carrier TOKENS (via db.lookup_lco_route, which
-- queries the backend-owned `lco_route` view) and expands it into the
-- {sbc,carrier,label} attempts array that lib/sbc.failover_bridge already
-- consumes. The tokens are exactly the ones Kamailio route[TO_CARRIER] already
-- maps to Bandwidth PoPs — primary | secondary | tc1 | tc2 | tc4 — so NO Kamailio
-- change is needed to steer: LCO only changes WHICH tokens FreeSWITCH emits (as
-- sip_h_X-Carrier per attempt) and in WHAT order.
--
-- FAIL-SAFE / BYTE-IDENTICAL-WHEN-OFF: resolve_carriers() returns nil whenever
-- there is NO LCO decision (no explicit route var/header AND no matching DB row,
-- or the db/module is unavailable / errors). Callers MUST treat nil as "keep your
-- existing default ordering", so the LIVE default carrier path is unchanged until
-- the backend populates lco_route / the API sets an explicit route.
--
-- TWO decision sources, checked IN THIS ORDER:
--   1. EXPLICIT ROUTE (API-originated, Task 3(b)): SIP header `X-LCO-Route`
--      (read on the FS A-leg as channel var `sip_h_X-LCO-Route`) OR channel var
--      `lco_route`. A comma/space-separated ordered token list,
--      e.g. "tc2,primary,secondary". The API sets this when it originates.
--   2. DB LOOKUP (RCF / inbound-forward, Task 3(a)): db.lookup_lco_route(dest) —
--      a longest-prefix match over the backend-owned `lco_route` view returning
--      the ordered carrier tokens for the destination prefix.
--
-- PRESERVES ALL FAILOVER SEMANTICS: build_attempts() emits, for each carrier in
-- order, SBC-1 then SBC-2 — the SAME 2-SBC × N-carrier interleave the hand-written
-- default used. lib/sbc.failover_bridge's per-attempt TCP pre-check,
-- progress_timeout discipline and session-timer normalization are untouched.
--
-- CONTRACT for the backend (read-only from telephony — the backend creates,
-- populates and manages this; we NEVER write it):
--   VIEW: lco_route  (migration 2026-07-01_lco_rate_deck.sql; GRANT SELECT to freeswitch)
--   COLUMNS read here:
--     prefix           TEXT     dialed-digit prefix (longest match wins)
--     x_carrier_value  TEXT     Kamailio X-Carrier token (primary|secondary|tc1|tc2|tc4)
--     priority         INTEGER  lower = tried first (per matched prefix)
--     enabled          BOOLEAN
--   COLUMNS the backend also maintains but telephony does NOT read:
--     carrier_id, pop_ip, cost_per_min  (rate-deck bookkeeping)
--   HEADER / CHANNEL-VAR names read here (explicit-route path):
--     SIP header  X-LCO-Route   (FS channel var sip_h_X-LCO-Route)
--     channel var lco_route
--
-- Loaded via the load_module() loadfile() pattern (CLAUDE.md gotcha #10).

local M = {}

-- Carrier tokens Kamailio route[TO_CARRIER] recognizes. An explicit-route or DB
-- token outside this set is DROPPED for that entry (an unknown X-Carrier would
-- make Kamailio silently default to TC4 Dallas — we refuse to emit that).
local VALID = {
    primary = true, secondary = true, tc1 = true, tc2 = true, tc4 = true,
}

-- Parse a comma/space-separated token string into a validated, de-duplicated,
-- order-preserving array. Returns nil when nothing valid remains.
local function parse_tokens(s)
    if type(s) ~= "string" or s == "" then return nil end
    local out, seen = {}, {}
    for tok in s:gmatch("[^,%s]+") do
        tok = tok:lower()
        if VALID[tok] and not seen[tok] then
            seen[tok] = true
            out[#out + 1] = tok
        end
    end
    if #out == 0 then return nil end
    return out
end

-- Resolve the ordered carrier-token list for a call, or nil for "use default".
-- o = {
--   get_var = <fn(name, default)>,  -- session var reader (optional; explicit route)
--   db      = <db module>,           -- optional; when present, the DB lookup path
--   dest    = <string>,              -- destination (E.164 / digits) for prefix match
--   uuid    = <string>,              -- logging
-- }
function M.resolve_carriers(o)
    o = o or {}

    -- 1. Explicit route (API-originated). Header form first, then channel var.
    if o.get_var then
        local explicit = o.get_var("sip_h_X-LCO-Route", nil) or o.get_var("lco_route", nil)
        local toks = parse_tokens(explicit)
        if toks then
            freeswitch.consoleLog("INFO", string.format(
                "[%s] LCO explicit route: %s\n", tostring(o.uuid), table.concat(toks, ",")))
            return toks
        end
    end

    -- 2. DB longest-prefix lookup (RCF / inbound-forward). pcall + fail-open: any
    --    error / missing view / no match -> nil -> caller keeps its default.
    if o.db and o.db.lookup_lco_route and o.dest and o.dest ~= "" then
        local ok, rows = pcall(o.db.lookup_lco_route, o.dest)
        if ok and type(rows) == "table" and #rows > 0 then
            local out, seen = {}, {}
            for _, v in ipairs(rows) do
                local t = tostring(v):lower()
                if VALID[t] and not seen[t] then
                    seen[t] = true
                    out[#out + 1] = t
                end
            end
            if #out > 0 then
                freeswitch.consoleLog("INFO", string.format(
                    "[%s] LCO db route dest=%s -> %s\n",
                    tostring(o.uuid), tostring(o.dest), table.concat(out, ",")))
                return out
            end
        end
    end

    return nil
end

-- Expand an ordered carrier-token list into the {sbc,carrier,label} attempts
-- array. For EACH carrier (in order): SBC-1 then SBC-2 — the exact interleave the
-- hand-written default used, preserving the 2-SBC × N-carrier failover structure.
-- Both SBCs are always emitted (even if sbc2 == sbc1) so a single-SBC deployment
-- retries identically to today's default (the TCP pre-check caches the repeat).
function M.build_attempts(carriers, sbc1, sbc2)
    local attempts = {}
    for _, carrier in ipairs(carriers or {}) do
        attempts[#attempts + 1] = { sbc = sbc1, carrier = carrier,
            label = "SBC-1 + " .. carrier .. " carrier" }
        attempts[#attempts + 1] = { sbc = sbc2, carrier = carrier,
            label = "SBC-2 + " .. carrier .. " carrier" }
    end
    return attempts
end

return M
