-- lib/schedule.lua — time-of-day / day-of-week schedule matcher (unified)
--
-- A small, SHARED, side-effect-free primitive: given a schedule descriptor and
-- an instant, decide whether that instant falls inside the schedule's recurring
-- weekly window. Built for the Rich-RCF routing_plan `match.schedule` condition
-- (handlers/rcf.lua), but deliberately product-agnostic so the trunk-inbound and
-- IVR builders can reuse it later for time-based branching.
--
-- Schedule shape (CALL_FLOW_BUILDER_PLAN §12, snake_case, every field optional):
--   { days  = {"mon","tue",...},   -- weekdays the window applies to; omitted/
--                                      empty = every day
--     start = "HH:MM",             -- window open  (local wall-clock, see tz)
--     ["end"] = "HH:MM",           -- window close (local wall-clock)
--     tz    = "America/New_York" } -- IANA name OR "±HH:MM"/"±H" offset; omitted
--                                      = UTC
--
-- TIMEZONE APPROACH (explicit — Lua has no tz database):
--   Lua ships no zoneinfo, so we resolve `tz` to a UTC offset OURSELVES and read
--   the instant as UTC via os.date("!*t", epoch + offset) — the "!" forces a
--   tz-independent (UTC) breakdown, so the RESULT IS DETERMINISTIC regardless of
--   the host machine's TZ (critical for the unit tests and for FreeSWITCH boxes
--   that run in UTC). Two offset sources are supported:
--     1. A small IANA-name table (US zones + UTC) carrying the STANDARD-time
--        offset plus a `dst` flag. For DST zones we add +1h when US DST is in
--        effect for that instant. US DST rule: 02:00 on the 2nd Sunday of March
--        through 02:00 on the 1st Sunday of November (post-2007 federal rule).
--        Arizona (America/Phoenix) and Hawaii (Pacific/Honolulu) do NOT observe
--        DST and are flagged accordingly.
--     2. A fixed numeric offset string ("-05:00", "+0530", "-8") — honored
--        verbatim, no DST. Use this for any zone not in the table.
--   An UNKNOWN IANA name falls back to UTC (offset 0) with a one-time warning, so
--   a typo degrades to "server/UTC time" rather than crashing the call path.
--   The DST-boundary instant is resolved from the standard-time breakdown, which
--   is exact except inside the 1-hour spring-forward/fall-back gap — an
--   industry-standard approximation that never affects a normal business window.
--
-- OVERNIGHT WINDOWS: when start > end the window WRAPS midnight (e.g.
--   start=22:00 end=06:00). The evening portion (cur >= start) belongs to the
--   window's start DAY; the early-morning portion (cur < end) belongs to the
--   PREVIOUS day — so a "Fri 22:00–02:00" window matches Sat 01:00 because Sat's
--   previous day (Fri) is in `days`. start == end (and start/end both omitted) =
--   all-day; only the day-of-week filter applies.
--
-- Loaded via the load_module()/loadfile() pattern (CLAUDE.md gotcha #10). No
-- FreeSWITCH dependency at module scope (logging is guarded) so it loads and is
-- unit-testable under a plain `lua` interpreter.

local M = {}

-- Schedule day name (first 3 letters, lower) -> os.date wday (1=Sun .. 7=Sat).
local DAY_WDAY = {
    sun = 1, mon = 2, tue = 3, wed = 4, thu = 5, fri = 6, sat = 7,
}

-- IANA name -> { off = standard-time UTC offset (hours), dst = observes US DST }.
-- Extend here for additional zones; anything absent falls back to UTC or a
-- numeric "±HH:MM" offset string (resolve_offset below).
local TZ = {
    ["UTC"]                 = { off =   0, dst = false },
    ["America/New_York"]    = { off =  -5, dst = true  },
    ["America/Detroit"]     = { off =  -5, dst = true  },
    ["America/Chicago"]     = { off =  -6, dst = true  },
    ["America/Denver"]      = { off =  -7, dst = true  },
    ["America/Phoenix"]     = { off =  -7, dst = false },  -- Arizona: no DST
    ["America/Los_Angeles"] = { off =  -8, dst = true  },
    ["America/Anchorage"]   = { off =  -9, dst = true  },
    ["Pacific/Honolulu"]    = { off = -10, dst = false },  -- Hawaii: no DST
}

local _warned_tz = {}  -- warn once per unknown tz name (per module load)

local function warn(msg)
    if freeswitch and freeswitch.consoleLog then
        freeswitch.consoleLog("WARNING", "[schedule] " .. msg .. "\n")
    end
end

-- Day-of-week (0=Sun .. 6=Sat) for a Gregorian Y/M/D via Sakamoto's algorithm.
-- Pure arithmetic (no os, no tz) so DST boundary math is host-independent.
local function dow(y, m, d)
    local t = { 0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4 }
    if m < 3 then y = y - 1 end
    return (y + math.floor(y / 4) - math.floor(y / 100) + math.floor(y / 400)
        + t[m] + d) % 7
end

-- Day-of-month of the Nth Sunday of (y, m). nth_sunday(y,3,2) = 2nd Sun of March.
local function nth_sunday(y, m, n)
    local first_dow = dow(y, m, 1)               -- 0=Sun
    local first_sunday = ((7 - first_dow) % 7) + 1
    return first_sunday + (n - 1) * 7
end

-- Is US DST in effect at this LOCAL-STANDARD-time breakdown? Federal post-2007
-- rule: from 02:00 2nd Sunday March to 02:00 1st Sunday November.
local function us_dst(y, mo, d, h)
    if mo < 3 or mo > 11 then return false end
    if mo > 3 and mo < 11 then return true end
    if mo == 3 then
        local start_d = nth_sunday(y, 3, 2)
        if d > start_d then return true end
        if d < start_d then return false end
        return h >= 2
    end
    -- mo == 11
    local end_d = nth_sunday(y, 11, 1)
    if d < end_d then return true end
    if d > end_d then return false end
    return h < 2
end

-- Resolve a tz descriptor to a UTC offset IN SECONDS for the given instant.
local function resolve_offset(tz, now)
    -- Fixed numeric offset string: "-05:00", "+0530", "-8", "+5".
    if type(tz) == "string" then
        local sign, hh, mm = tz:match("^([+%-])(%d%d?):?(%d?%d?)$")
        if sign then
            local off = tonumber(hh) + (tonumber(mm) or 0) / 60
            if sign == "-" then off = -off end
            return math.floor(off * 3600 + 0.5)
        end
    end

    local z = (type(tz) == "string") and TZ[tz] or nil
    if not z then
        if tz ~= nil and tz ~= "" and tz ~= "UTC" and not _warned_tz[tz] then
            _warned_tz[tz] = true
            warn("unknown tz '" .. tostring(tz) .. "' — falling back to UTC")
        end
        return 0
    end

    local base = z.off
    if z.dst then
        -- Approximate local-standard breakdown to test the DST window.
        local std = os.date("!*t", now + base * 3600)
        if us_dst(std.year, std.month, std.day, std.hour) then
            return (base + 1) * 3600
        end
    end
    return base * 3600
end

-- Parse "HH:MM" -> minutes since midnight (0..1440), or nil if absent/invalid.
local function parse_hm(s)
    if type(s) ~= "string" then return nil end
    local h, m = s:match("^%s*(%d%d?):(%d%d?)%s*$")
    if not h then
        -- also accept a bare "HH" (e.g. "9" or "17")
        h = s:match("^%s*(%d%d?)%s*$")
        if not h then return nil end
        m = 0
    end
    h, m = tonumber(h), tonumber(m)
    if h < 0 or h > 24 or m < 0 or m > 59 then return nil end
    return h * 60 + m
end

-- Build the wday allow-set from schedule.days, or nil for "every day".
local function day_set_of(days)
    if type(days) ~= "table" or #days == 0 then return nil end
    local set = {}
    for _, d in ipairs(days) do
        local w = DAY_WDAY[tostring(d):lower():sub(1, 3)]
        if w then set[w] = true end
    end
    -- If nothing parsed, treat as "every day" rather than "never" (lenient).
    if next(set) == nil then return nil end
    return set
end

local function day_allowed(set, wday)
    if set == nil then return true end
    return set[wday] == true
end

local function prev_wday(w)
    local p = w - 1
    if p < 1 then return 7 end
    return p
end

-- matches(schedule, now) -> boolean.
--   schedule : the descriptor table (see top). A non-table / nil schedule means
--              "no time restriction" -> always true (caller treats a rule with
--              no schedule condition as always-in-window).
--   now      : optional UNIX epoch (os.time()); defaults to os.time(). Tests pass
--              a fixed epoch for determinism.
function M.matches(schedule, now)
    if type(schedule) ~= "table" then return true end
    now = now or os.time()

    local off = resolve_offset(schedule.tz, now)
    local lt = os.date("!*t", now + off)          -- local wall-clock breakdown
    local set = day_set_of(schedule.days)
    local cur = lt.hour * 60 + lt.min

    local smin = parse_hm(schedule.start)
    local emin = parse_hm(schedule["end"])

    -- No usable time bounds -> all-day; only the day filter applies.
    if not smin and not emin then
        return day_allowed(set, lt.wday)
    end

    smin = smin or 0          -- only `end` given -> from midnight
    emin = emin or (24 * 60)  -- only `start` given -> to end of day

    if smin == emin then
        -- Degenerate / explicit all-day window.
        return day_allowed(set, lt.wday)
    end

    if emin > smin then
        -- Same-day window: [start, end).
        if cur < smin or cur >= emin then return false end
        return day_allowed(set, lt.wday)
    end

    -- Overnight window (start > end): wraps midnight.
    if cur >= smin then
        -- Evening portion belongs to today's weekday.
        return day_allowed(set, lt.wday)
    elseif cur < emin then
        -- Early-morning portion belongs to the PREVIOUS weekday.
        return day_allowed(set, prev_wday(lt.wday))
    end
    return false
end

return M
