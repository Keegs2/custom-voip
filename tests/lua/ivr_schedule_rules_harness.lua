-- Standalone spec harness for the IVR's pure helpers (house style, no busted):
--   docker/freeswitch/scripts/lib/schedule.lua  (ported from `unified`)
--   docker/freeswitch/scripts/lib/rules.lua     (ported from `unified`)
--
-- Part 1 is the unified schedule_spec.lua, case for case (same instants,
-- same expectations), so the port is proven behavior-compatible.
-- Part 2 pins the timezone table against vectors generated from Python's
-- zoneinfo (the IANA database) — every pinned contract TZ, one second before
-- and AT each 2026/2027 DST transition. (A wider one-off cross-check — every
-- 30 min from 2024 to 2030 plus +-1 s around every transition hour, 1.14M
-- instants, 0 mismatches — was run while porting; see the commit message.)
-- Part 3 covers the IVR `hours` node (weekly ranges, half-open ends, 24:00,
-- closed dates, DST edges) and Part 4 the IVR caller check (rules.lua).
--
-- Run: lua tests/lua/ivr_schedule_rules_harness.lua   (Lua 5.3+; prod is 5.3)

local function script_dir()
    local src = debug.getinfo(1, "S").source
    return (src:match("^@(.*)/[^/]*$")) or "."
end
local LIB = script_dir() .. "/../../docker/freeswitch/scripts/lib/"

local schedule = assert(loadfile(LIB .. "schedule.lua"))()
local rules = assert(loadfile(LIB .. "rules.lua"))()
local number_utils = assert(loadfile(LIB .. "number_utils.lua"))()

local passes, failures = 0, 0
local function check(name, cond, detail)
    if cond then
        passes = passes + 1
        print("  PASS  " .. name)
    else
        failures = failures + 1
        print("  FAIL  " .. name .. " -- " .. tostring(detail))
    end
end

-- ------------------------------------------------------------------
print("[1] unified schedule_spec parity")
-- ------------------------------------------------------------------
local NY = "America/New_York"
check("nil schedule is always true", schedule.matches(nil, 1705327200) == true)
check("non-table schedule is always true", schedule.matches("nope", 1705327200) == true)
check("empty table is always true", schedule.matches({}, 1705327200) == true)
check("days only, in the day set",
    schedule.matches({ days = { "mon" }, tz = "UTC" }, 1705327200) == true)
check("days only, NOT in the day set",
    schedule.matches({ days = { "tue", "wed" }, tz = "UTC" }, 1705327200) == false)
local biz = { days = { "mon", "tue", "wed", "thu", "fri" },
              start = "09:00", ["end"] = "17:00", tz = NY }
check("winter 14:00Z = 09:00 EST Mon -> inside", schedule.matches(biz, 1705327200) == true)
check("winter 13:00Z = 08:00 EST Mon -> before open", schedule.matches(biz, 1705323600) == false)
check("summer 13:00Z = 09:00 EDT Mon -> inside (DST applied)", schedule.matches(biz, 1721048400) == true)
check("summer 02:00Z = Sun 22:00 EDT -> outside", schedule.matches(biz, 1721008800) == false)
check("'-05:00' at 14:00Z -> inside",
    schedule.matches({ start = "09:00", ["end"] = "17:00", tz = "-05:00" }, 1705327200) == true)
check("'-8' at 14:00Z -> before 09:00",
    schedule.matches({ start = "09:00", ["end"] = "17:00", tz = "-8" }, 1705327200) == false)
local night = { days = { "fri" }, start = "22:00", ["end"] = "02:00", tz = "UTC" }
check("overnight: Fri 23:00 inside", schedule.matches(night, 1705705200) == true)
check("overnight: Sat 01:00 inside (prev day Fri)", schedule.matches(night, 1705712400) == true)
check("overnight: Sat 03:00 outside", schedule.matches(night, 1705719600) == false)
check("overnight: Thu 23:00 outside", schedule.matches(night, 1705618800) == false)
check("end exclusive: 17:00 EST not inside",
    schedule.matches({ start = "09:00", ["end"] = "17:00", tz = NY }, 1705356000) == false)
check("only start -> open to end of day",
    schedule.matches({ start = "09:00", tz = NY }, 1705359600) == true)

-- ------------------------------------------------------------------
print("[2] pinned TZ table vs IANA zoneinfo (DST edges, 2026/2027)")
-- ------------------------------------------------------------------
-- { epoch, utc offset seconds, local wall clock } from Python zoneinfo.
local VECTORS = {
    ["America/New_York"] = { {1772953199, -18000, "2026-03-08 01:59"}, {1772953200, -14400, "2026-03-08 03:00"}, {1793512799, -14400, "2026-11-01 01:59"}, {1793512800, -18000, "2026-11-01 01:00"}, {1805007599, -18000, "2027-03-14 01:59"}, {1805007600, -14400, "2027-03-14 03:00"}, {1825567199, -14400, "2027-11-07 01:59"}, {1825567200, -18000, "2027-11-07 01:00"} },
    ["America/Detroit"] = { {1772953199, -18000, "2026-03-08 01:59"}, {1772953200, -14400, "2026-03-08 03:00"}, {1793512799, -14400, "2026-11-01 01:59"}, {1793512800, -18000, "2026-11-01 01:00"}, {1805007599, -18000, "2027-03-14 01:59"}, {1805007600, -14400, "2027-03-14 03:00"}, {1825567199, -14400, "2027-11-07 01:59"}, {1825567200, -18000, "2027-11-07 01:00"} },
    ["America/Chicago"] = { {1772956799, -21600, "2026-03-08 01:59"}, {1772956800, -18000, "2026-03-08 03:00"}, {1793516399, -18000, "2026-11-01 01:59"}, {1793516400, -21600, "2026-11-01 01:00"}, {1805011199, -21600, "2027-03-14 01:59"}, {1805011200, -18000, "2027-03-14 03:00"}, {1825570799, -18000, "2027-11-07 01:59"}, {1825570800, -21600, "2027-11-07 01:00"} },
    ["America/Denver"] = { {1772960399, -25200, "2026-03-08 01:59"}, {1772960400, -21600, "2026-03-08 03:00"}, {1793519999, -21600, "2026-11-01 01:59"}, {1793520000, -25200, "2026-11-01 01:00"}, {1805014799, -25200, "2027-03-14 01:59"}, {1805014800, -21600, "2027-03-14 03:00"}, {1825574399, -21600, "2027-11-07 01:59"}, {1825574400, -25200, "2027-11-07 01:00"} },
    ["America/Phoenix"] = { {1772953199, -25200, "2026-03-07 23:59"}, {1772953200, -25200, "2026-03-08 00:00"}, {1793512799, -25200, "2026-10-31 22:59"}, {1793512800, -25200, "2026-10-31 23:00"} },
    ["America/Los_Angeles"] = { {1772963999, -28800, "2026-03-08 01:59"}, {1772964000, -25200, "2026-03-08 03:00"}, {1793523599, -25200, "2026-11-01 01:59"}, {1793523600, -28800, "2026-11-01 01:00"}, {1805018399, -28800, "2027-03-14 01:59"}, {1805018400, -25200, "2027-03-14 03:00"}, {1825577999, -25200, "2027-11-07 01:59"}, {1825578000, -28800, "2027-11-07 01:00"} },
    ["America/Anchorage"] = { {1772967599, -32400, "2026-03-08 01:59"}, {1772967600, -28800, "2026-03-08 03:00"}, {1793527199, -28800, "2026-11-01 01:59"}, {1793527200, -32400, "2026-11-01 01:00"}, {1805021999, -32400, "2027-03-14 01:59"}, {1805022000, -28800, "2027-03-14 03:00"}, {1825581599, -28800, "2027-11-07 01:59"}, {1825581600, -32400, "2027-11-07 01:00"} },
    ["Pacific/Honolulu"] = { {1772953199, -36000, "2026-03-07 20:59"}, {1772953200, -36000, "2026-03-07 21:00"}, {1793512799, -36000, "2026-10-31 19:59"}, {1793512800, -36000, "2026-10-31 20:00"} },
    ["America/Puerto_Rico"] = { {1772953199, -14400, "2026-03-08 02:59"}, {1772953200, -14400, "2026-03-08 03:00"}, {1793512799, -14400, "2026-11-01 01:59"}, {1793512800, -14400, "2026-11-01 02:00"} },
}
for _, tz in ipairs(schedule.PINNED_TZ) do
    check(tz .. ": in the TZ table", schedule.TZ[tz] ~= nil)
    for _, v in ipairs(VECTORS[tz] or {}) do
        local lt = schedule.local_time(tz, v[1])
        local wall = lt and string.format("%s %02d:%02d", lt.date, lt.hour, lt.min)
        check(string.format("%s @%d: offset %d, wall %s", tz, v[1], v[2], v[3]),
            lt and lt.offset == v[2] and wall == v[3],
            lt and (tostring(lt.offset) .. " " .. tostring(wall)) or "nil")
    end
end
check("contract pins exactly 9 IVR zones", #schedule.PINNED_TZ == 9, #schedule.PINNED_TZ)
check("unknown zone -> nil, err", schedule.local_time("Europe/Paris", 1772953200) == nil)

-- ------------------------------------------------------------------
print("[3] IVR hours node")
-- ------------------------------------------------------------------
local function hours(tz, extra)
    local n = { tz = tz, weekly = {
        mon = { { 540, 1020 } }, tue = { { 540, 1020 } }, wed = { { 540, 1020 } },
        thu = { { 540, 1020 } }, fri = { { 540, 720 }, { 780, 1020 } },
        sat = {}, sun = { { 0, 1440 } } }, closed_dates = {} }
    for k, v in pairs(extra or {}) do n[k] = v end
    return n
end
-- 2026-01-12 is a Monday. 14:00Z = 09:00 EST.
local MON_0900_EST = 1768226400
check("NY Mon 09:00 open (start inclusive)", schedule.hours_open(hours(NY), MON_0900_EST) == true)
check("NY Mon 08:59 closed", schedule.hours_open(hours(NY), MON_0900_EST - 60) == false)
check("NY Mon 17:00 closed (end exclusive)", schedule.hours_open(hours(NY), MON_0900_EST + 8 * 3600) == false)
check("NY Mon 16:59 open", schedule.hours_open(hours(NY), MON_0900_EST + 8 * 3600 - 60) == true)
-- Friday 2026-01-16: lunch gap 12:00-13:00.
local FRI_1200_EST = 1768582800
check("NY Fri 12:00 closed (gap)", schedule.hours_open(hours(NY), FRI_1200_EST) == false)
check("NY Fri 11:59 open", schedule.hours_open(hours(NY), FRI_1200_EST - 60) == true)
check("NY Fri 13:00 open (second range)", schedule.hours_open(hours(NY), FRI_1200_EST + 3600) == true)
check("NY Sat closed all day", schedule.hours_open(hours(NY), FRI_1200_EST + 86400) == false)
check("NY Sun 00:00-24:00 open at 23:59",
    schedule.hours_open(hours(NY), 1768712400 + 23 * 3600 + 59 * 60) == true)
check("closed date wins over weekly hours",
    schedule.hours_open(hours(NY, { closed_dates = { "2026-01-12" } }), MON_0900_EST) == false)
check("closed date compared in LOCAL time (23:30 EST Mon = Tue 04:30Z)",
    schedule.hours_open(hours(NY, { weekly = { mon = { { 0, 1440 } } },
        closed_dates = { "2026-01-13" } }), MON_0900_EST + 14 * 3600 + 30 * 60) == true)
check("missing weekday key = closed",
    schedule.hours_open({ tz = NY, weekly = { tue = { { 0, 1440 } } } }, MON_0900_EST) == false)
-- DST edge: NY Sunday 2026-03-08, open 01:00-03:30 local. 06:59:59Z = 01:59:59
-- EST (open); 07:00Z = 03:00 EDT (open); 07:30Z = 03:30 EDT (closed).
local dst = { tz = NY, weekly = { sun = { { 60, 210 } } } }
check("DST spring: 01:59 EST open", schedule.hours_open(dst, 1772953199) == true)
check("DST spring: 03:00 EDT open", schedule.hours_open(dst, 1772953200) == true)
check("DST spring: 03:30 EDT closed", schedule.hours_open(dst, 1772955000) == false)
-- Fall back 2026-11-01: 05:59:59Z = 01:59:59 EDT; 06:00Z = 01:00 EST.
local fall = { tz = NY, weekly = { sun = { { 120, 180 } } } }
check("DST fall: 01:59 EDT closed (range 02:00-03:00)", schedule.hours_open(fall, 1793512799) == false)
check("DST fall: 07:00Z = 02:00 EST open", schedule.hours_open(fall, 1793516400) == true)
check("Puerto Rico: 13:00Z = 09:00 AST open, no DST in July",
    schedule.hours_open(hours("America/Puerto_Rico"), 1783947600) == true)
check("Phoenix: 16:00Z = 09:00 MST open in July (no DST)",
    schedule.hours_open(hours("America/Phoenix"), 1783958400) == true)
check("Denver: 16:00Z = 10:00 MDT open in July",
    schedule.hours_open(hours("America/Denver"), 1783958400) == true)
check("Honolulu: 19:00Z = 09:00 HST open",
    schedule.hours_open(hours("Pacific/Honolulu"), 1783969200) == true)
check("unknown tz -> nil", schedule.hours_open({ tz = "Mars/Base" }, 0) == nil)

-- ------------------------------------------------------------------
print("[4] IVR caller check (rules.caller_matches)")
-- ------------------------------------------------------------------
local cm = function(mode, values, caller)
    return rules.caller_matches(mode, values, caller, number_utils)
end
check("prefix +1617 matches +16175551234", cm("prefix", { "+1617" }, "+16175551234") == true)
check("prefix matches a bare 10-digit caller (canonicalized)", cm("prefix", { "+1617" }, "6175551234") == true)
check("prefix matches an 11-digit caller", cm("prefix", { "+1617" }, "16175551234") == true)
check("prefix: any value in the list", cm("prefix", { "+1508", "+1617" }, "+16175551234") == true)
check("prefix: no value matches", cm("prefix", { "+1508" }, "+16175551234") == false)
check("equals exact", cm("equals", { "+16175551234" }, "+16175551234") == true)
check("equals is not a prefix test", cm("equals", { "+1617555123" }, "+16175551234") == false)
check("anonymous: 'anonymous'", cm("anonymous", {}, "anonymous") == true)
check("anonymous: 'Restricted'", cm("anonymous", {}, "Restricted") == true)
check("anonymous: empty", cm("anonymous", {}, "") == true)
check("anonymous: nil", cm("anonymous", {}, nil) == true)
check("anonymous: short digit string", cm("anonymous", {}, "1234") == true)
check("anonymous: a real number is not anonymous", cm("anonymous", {}, "+16175551234") == false)
check("an anonymous caller never matches prefix", cm("prefix", { "+1" }, "anonymous") == false)
check("an anonymous caller never matches equals", cm("equals", { "+1" }, "") == false)
check("unknown mode never matches", cm("regex", { ".*" }, "+16175551234") == false)
check("unified caller_id_matches parity (prefix)",
    rules.caller_id_matches({ prefix = "+1617" }, "+16175551234") == true)
check("unified first_match: catch-all after a miss",
    select(2, rules.first_match({ { match = { caller_id = { equals = "+1999" } } }, { match = nil } },
        { caller = "+1617" })) == 2)
check("unified: schedule rule without the lib does not match",
    rules.rule_matches({ match = { schedule = {} } }, {}) == false)

print("")
print(string.format("%d passed, %d failed", passes, failures))
if failures == 0 then
    print("ALL IVR SCHEDULE/RULES ASSERTIONS PASSED")
    os.exit(0)
end
os.exit(1)
