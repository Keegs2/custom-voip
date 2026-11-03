-- Unit harness for docker/freeswitch/scripts/lib/term_trunks.lua — the Tier 1
-- cache field and the premium traffic pattern (migrations 63/64, TED contract
-- C7). NOT loaded by FreeSWITCH. Stubs the mod_lua globals the lib touches
-- (freeswitch.consoleLog / get/setGlobalVariable, os.time) and asserts:
--
--   [1] parse(): the 5-field entry (tier1 0/1), the 4-field pre-64 entry
--       (tier1 = false) and the 3-field pre-44 entry (class 'any', tier1 =
--       false) all parse; a bad tier1 digit / malformed segment invalidates
--       the whole payload.
--   [2] get(): serializes tier1 from luasql 't'/'f', Lua booleans and a
--       missing value (pre-64 retry -> 0) under the NEW cache key
--       "term_trunks2_<zone>"; a fresh cache hit never touches the DB; an
--       old-key entry is never read.
--   [3] filter_for_tier1 / apply_traffic_pattern: enterprise, nil and any
--       other grade get the SAME table back (no copy); premium gets the
--       Tier 1 rows, or the full list + fallback=true when there are none.
--   [4] select_tollfree(zone, db, tag, grade): strict tollfree first, then
--       the pattern; the third return is the fallback flag; omitted grade =
--       today's behaviour.
--
-- Usage: lua tests/lua/term_trunks_harness.lua

local LIB = "docker/freeswitch/scripts/lib/term_trunks.lua"

local globals, logs, now = {}, {}, 1000000
local env = setmetatable({
    freeswitch = {
        consoleLog = function(level, msg) logs[#logs + 1] = level .. " " .. msg end,
        getGlobalVariable = function(k) return globals[k] end,
        setGlobalVariable = function(k, v) globals[k] = v end,
    },
    os = setmetatable({ time = function() return now end }, { __index = os }),
}, { __index = _G })
local chunk = assert(loadfile(LIB, "t", env))
local M = chunk()

local failures = 0
local function check(name, cond, detail)
    if cond then print("  PASS  " .. name)
    else failures = failures + 1; print("  FAIL  " .. name .. " -- " .. tostring(detail)) end
end
local function ips(list)
    local out = {}
    for _, t in ipairs(list or {}) do out[#out + 1] = t.term_ip end
    return table.concat(out, ",")
end

print("== term_trunks_harness ==")

do
    print("[1] parse: 5-, 4- and 3-field entries")
    local t = M.parse("bandwidth,dallas,67.231.2.12,ld,1;sinch,atlanta-ld,206.146.98.26,ld,0")
    check("5-field parses", t and #t == 2, t and #t)
    check("5-field tier1 1 -> true, 0 -> false", t and t[1].tier1 == true and t[2].tier1 == false)
    check("5-field class kept", t and t[1].traffic_class == "ld")
    local t4 = M.parse("bandwidth,dallas,67.231.2.12,ld;sinch,denver-tf,206.146.100.26,tollfree")
    check("4-field (pre-64) parses with tier1=false",
          t4 and #t4 == 2 and t4[1].tier1 == false and t4[2].traffic_class == "tollfree")
    local t3 = M.parse("bandwidth,la,216.82.238.134")
    check("3-field (pre-44) parses: class any, tier1 false",
          t3 and t3[1].traffic_class == "any" and t3[1].tier1 == false)
    local mixed = M.parse("bandwidth,dallas,67.231.2.12,ld,1;bandwidth,la,216.82.238.134")
    check("mixed generations parse", mixed and #mixed == 2 and mixed[1].tier1 and not mixed[2].tier1)
    check("bad tier1 digit invalidates the payload",
          M.parse("bandwidth,dallas,67.231.2.12,ld,2") == nil)
    check("one malformed segment invalidates the payload",
          M.parse("bandwidth,dallas,67.231.2.12,ld,1;junk") == nil)
end

do
    print("[2] get: tier1 serialization + the new cache key")
    globals = {}
    local fetches = 0
    local db = { get_termination_trunks = function(zone)
        fetches = fetches + 1
        return {
            { carrier = "bandwidth", pop = "dallas", term_ip = "67.231.2.12", traffic_class = "ld", tier1 = "t" },
            { carrier = "bandwidth", pop = "la", term_ip = "216.82.238.134", traffic_class = "ld", tier1 = true },
            { carrier = "sinch", pop = "atlanta-ld", term_ip = "206.146.98.26", traffic_class = "ld", tier1 = "f" },
            { carrier = "sinch", pop = "denver-tf", term_ip = "206.146.100.26", traffic_class = "tollfree" },
        }
    end }
    local t = M.get("west", db, "h")
    check("4 rows", t and #t == 4, t and #t)
    check("tier1 flags t/true/f/nil -> true,true,false,false",
          t and t[1].tier1 and t[2].tier1 and not t[3].tier1 and not t[4].tier1)
    check("cached under term_trunks2_west",
          globals["term_trunks2_west"] == "1000000|bandwidth,dallas,67.231.2.12,ld,1;"
              .. "bandwidth,la,216.82.238.134,ld,1;sinch,atlanta-ld,206.146.98.26,ld,0;"
              .. "sinch,denver-tf,206.146.100.26,tollfree,0", globals["term_trunks2_west"])
    check("old key term_trunks_west never written", globals["term_trunks_west"] == nil)
    now = now + 30
    M.get("west", db, "h")
    check("fresh cache hit: no second DB fetch", fetches == 1, fetches)
    -- an old-generation entry under the OLD key is ignored (a still-running
    -- previous Lua wrote it); the new key decides.
    globals = { ["term_trunks_east"] = now .. "|bandwidth,dallas,67.231.2.12,ld" }
    local e = M.get("east", db, "h")
    check("old-key entry ignored: DB fetched, tier1 known", fetches == 2 and e and e[1].tier1, fetches)
    -- a cached 4-field entry under the NEW key still parses (tier1 false)
    globals = { ["term_trunks2_central"] = now .. "|bandwidth,dallas,67.231.2.12,ld" }
    local cc = M.get("central", db, "h")
    check("4-field entry under the new key parses", cc and #cc == 1 and cc[1].tier1 == false
          and fetches == 2, fetches)
end

local BW = { carrier = "bandwidth", pop = "dallas", term_ip = "67.231.2.12", traffic_class = "ld", tier1 = true }
local BW2 = { carrier = "bandwidth", pop = "la", term_ip = "216.82.238.134", traffic_class = "ld", tier1 = true }
local SL = { carrier = "sinch", pop = "atlanta-ld", term_ip = "206.146.98.26", traffic_class = "ld", tier1 = false }
local ST = { carrier = "sinch", pop = "denver-tf", term_ip = "206.146.100.26", traffic_class = "tollfree", tier1 = false }

do
    print("[3] filter_for_tier1 / apply_traffic_pattern")
    local list = { SL, BW, BW2 }
    check("filter_for_tier1 keeps order", ips(M.filter_for_tier1(list)) == "67.231.2.12,216.82.238.134")
    check("filter_for_tier1 of none -> empty", #M.filter_for_tier1({ SL, ST }) == 0)
    for _, grade in ipairs({ "enterprise", "standard", "economy", "Premium", "" }) do
        local out, fb = M.apply_traffic_pattern(list, grade)
        check("'" .. grade .. "' -> the SAME table, no fallback", out == list and fb == false)
    end
    local out, fb = M.apply_traffic_pattern(list, nil)
    check("nil grade -> the SAME table, no fallback", out == list and fb == false)
    out, fb = M.apply_traffic_pattern(list, "premium")
    check("premium -> Tier 1 rows only", ips(out) == "67.231.2.12,216.82.238.134" and fb == false,
          ips(out))
    local none = { SL }
    out, fb = M.apply_traffic_pattern(none, "premium")
    check("premium, no Tier 1 row -> full list + fallback", out == none and fb == true)
    out, fb = M.apply_traffic_pattern({}, "premium")
    check("premium, empty list -> empty + fallback", #out == 0 and fb == true)
    check("is_true: t/true/1 only", M.is_true("t") and M.is_true(true) and M.is_true("1")
          and not M.is_true("f") and not M.is_true(nil) and not M.is_true(false))
end

do
    print("[4] select_tollfree with a traffic grade")
    now = now + 1000
    local rows = { BW, SL, ST }
    local db = { get_termination_trunks = function() return rows end }
    globals = {}
    local l, src, fb = M.select_tollfree("east", db, "h")
    check("no grade: tollfree rows, source db, no fallback",
          ips(l) == "206.146.100.26" and src == "db" and fb == false)
    l, src, fb = M.select_tollfree("east", db, "h", "premium")
    check("premium, Sinch TF not Tier 1 -> same TF rows + fallback",
          ips(l) == "206.146.100.26" and src == "db" and fb == true)
    rows = { BW, ST, { carrier = "x", pop = "tf1", term_ip = "198.51.100.5",
                       traffic_class = "tollfree", tier1 = true } }
    globals = {}
    l, src, fb = M.select_tollfree("east", db, "h", "premium")
    check("premium with a Tier 1 TF row -> only it", ips(l) == "198.51.100.5" and fb == false,
          ips(l))
    l, src, fb = M.select_tollfree("east", db, "h", "enterprise")
    check("enterprise -> every TF row", ips(l) == "206.146.100.26,198.51.100.5" and fb == false)
    rows = { BW, SL }
    globals = {}
    l, src, fb = M.select_tollfree("east", db, "h", "premium")
    check("no TF row at all -> nil, db (fail closed, no fallback flag)",
          l == nil and src == "db" and fb == false)
    globals = {}
    local l2, src2, fb2 = M.select_tollfree("east", { }, "h", "premium")
    check("table unresolvable -> nil, fallback, no flag", l2 == nil and src2 == "fallback" and fb2 == false)
end

print("")
if failures == 0 then
    print("ALL TERM_TRUNKS HARNESS ASSERTIONS PASSED"); os.exit(0)
else
    print(failures .. " TERM_TRUNKS HARNESS ASSERTION(S) FAILED"); os.exit(1)
end
