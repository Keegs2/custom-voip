-- lib/schedule.lua — time-of-day / day-of-week schedule matcher.
--
-- Ported from branch `unified` (lib/schedule.lua, 2026-06-19) for the Visual
-- IVR "Business hours" block (docs/IVR_INTERFACES.md §2/§3, plan §7.3). Pure,
-- side-effect-free, no FreeSWITCH dependency at module scope (logging is
-- guarded), so it loads under a plain `lua` interpreter for the harnesses.
-- Loaded with the house loadfile() pattern (scripts/CLAUDE.md, gotcha #10).
-- Lua 5.3-compatible (prod mod_lua is 5.3): integer arithmetic only, no 5.4+.
--
-- Two entry points:
--   M.hours_open(node, now)  — the IVR plan's `hours` node (contract §3):
--       { tz = "<pinned TZ>",
--         weekly = { mon = {{540,1020}, ...}, ..., sun = {} },  -- minutes since
--                                                  local midnight, [start,end)
--         closed_dates = { "YYYY-MM-DD", ... } }
--     returns true (open) / false (closed), or nil + err for an unknown tz.
--   M.matches(schedule, now) — the unified rich-plan shape
--       { days = {"mon",...}, start = "HH:MM", ["end"] = "HH:MM", tz = ... }
--     kept byte-compatible with the unified spec (tests/lua/ivr_schedule_rules_harness.lua).
--
-- TIMEZONES (Lua has no tz database). The table below carries each zone's
-- STANDARD-time UTC offset plus whether it observes US DST. It MUST contain
-- the whole pinned list of the contract (§2):
--   America/New_York, America/Detroit, America/Chicago, America/Denver,
--   America/Phoenix (no DST), America/Los_Angeles, America/Anchorage,
--   Pacific/Honolulu (no DST), America/Puerto_Rico (UTC-4, no DST).
--
-- DST is resolved EXACTLY (unlike the unified port, which approximated the
-- transition hour from the standard-time breakdown): the US federal rule since
-- 2007 is 02:00 local standard time on the 2nd Sunday of March (clocks jump to
-- 03:00) through 02:00 local DAYLIGHT time (= 01:00 local standard) on the 1st
-- Sunday of November. Both transition instants are converted to UTC epochs with
-- pure civil-date arithmetic and compared with `now`, so the result never
-- depends on the host's TZ setting and is correct to the second at both edges.
-- The wall-clock breakdown uses os.date("!*t", now + offset) — "!" = UTC, so it
-- is deterministic on any host.

local M = {}

-- IANA name -> { off = standard-time offset (hours), dst = observes US DST }.
M.TZ = {
    ["UTC"]                 = { off =   0, dst = false },
    ["America/New_York"]    = { off =  -5, dst = true  },
    ["America/Detroit"]     = { off =  -5, dst = true  },
    ["America/Chicago"]     = { off =  -6, dst = true  },
    ["America/Denver"]      = { off =  -7, dst = true  },
    ["America/Phoenix"]     = { off =  -7, dst = false },  -- Arizona: no DST
    ["America/Los_Angeles"] = { off =  -8, dst = true  },
    ["America/Anchorage"]   = { off =  -9, dst = true  },
    ["Pacific/Honolulu"]    = { off = -10, dst = false },  -- Hawaii: no DST
    ["America/Puerto_Rico"] = { off =  -4, dst = false },  -- AST all year
}

-- The contract's pinned IVR list (UTC is accepted by matches() only).
M.PINNED_TZ = {
    "America/New_York", "America/Detroit", "America/Chicago", "America/Denver",
    "America/Phoenix", "America/Los_Angeles", "America/Anchorage",
    "Pacific/Honolulu", "America/Puerto_Rico",
}

-- Plan weekday keys, indexed by os.date wday (1 = Sunday .. 7 = Saturday).
M.WDAY_KEY = { "sun", "mon", "tue", "wed", "thu", "fri", "sat" }

-- Schedule day name (first 3 letters, lower) -> os.date wday.
local DAY_WDAY = { sun = 1, mon = 2, tue = 3, wed = 4, thu = 5, fri = 6, sat = 7 }

local _warned_tz = {}

local function warn(msg)
    if freeswitch and freeswitch.consoleLog then
        freeswitch.consoleLog("WARNING", "[schedule] " .. msg .. "\n")
    end
end

-- Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant's
-- days_from_civil). Integer-only; valid for any year this code will see.
local function days_from_civil(y, m, d)
    if m <= 2 then y = y - 1 end
    local era = y // 400                     -- Lua's // floors (no C fixup)
    local yoe = y - era * 400
    local mp = (m + 9) % 12
    local doy = (153 * mp + 2) // 5 + d - 1
    local doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468
end
M.days_from_civil = days_from_civil

-- UTC epoch of a civil date-time (all fields integers).
local function utc_epoch(y, mo, d, h, mi)
    return days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60
end
M.utc_epoch = utc_epoch

-- Day-of-week 0 = Sunday .. 6 = Saturday (1970-01-01 was a Thursday = 4).
local function dow(y, m, d)
    return (days_from_civil(y, m, d) + 4) % 7
end

-- Day-of-month of the Nth Sunday of (y, m).
local function nth_sunday(y, m, n)
    local first_sunday = ((7 - dow(y, m, 1)) % 7) + 1
    return first_sunday + (n - 1) * 7
end
M.nth_sunday = nth_sunday

-- US DST window for `year` in a zone whose standard offset is `std_off`
-- hours, as [start_utc, end_utc) epochs.
local function us_dst_window(year, std_off)
    local shift = -std_off * 3600                       -- local standard -> UTC
    local start_utc = utc_epoch(year, 3, nth_sunday(year, 3, 2), 2, 0) + shift
    local end_utc = utc_epoch(year, 11, nth_sunday(year, 11, 1), 1, 0) + shift
    return start_utc, end_utc
end
M.us_dst_window = us_dst_window

-- UTC offset in SECONDS for `tz` at instant `now`, or nil for an unknown
-- name. Also accepts a fixed numeric offset ("-05:00", "+0530", "-8").
local function resolve_offset(tz, now)
    if type(tz) == "string" then
        local sign, hh, mm = tz:match("^([+%-])(%d%d?):?(%d?%d?)$")
        if sign then
            local secs = tonumber(hh) * 3600 + (tonumber(mm) or 0) * 60
            if sign == "-" then secs = -secs end
            return secs
        end
    end
    local z = (type(tz) == "string") and M.TZ[tz] or nil
    if not z then return nil end
    local base = z.off * 3600
    if z.dst then
        -- The calendar year of the instant in local standard time; DST never
        -- straddles a year boundary, so this is exact.
        local year = os.date("!*t", now + base).year
        local s, e = us_dst_window(year, z.off)
        if now >= s and now < e then
            return base + 3600
        end
    end
    return base
end
M.resolve_offset = resolve_offset

-- Local wall-clock breakdown for `tz` at `now`:
--   { year, month, day, hour, min, wday (1=Sun), minute (0..1439),
--     date = "YYYY-MM-DD", day_key = "mon".., offset = seconds }
-- or nil, err for an unknown tz.
function M.local_time(tz, now)
    now = now or os.time()
    local off = resolve_offset(tz, now)
    if not off then
        return nil, "unknown tz " .. tostring(tz)
    end
    local t = os.date("!*t", now + off)
    return {
        year = t.year, month = t.month, day = t.day,
        hour = t.hour, min = t.min, wday = t.wday,
        minute = t.hour * 60 + t.min,
        date = string.format("%04d-%02d-%02d", t.year, t.month, t.day),
        day_key = M.WDAY_KEY[t.wday],
        offset = off,
    }
end

-- IVR `hours` node evaluation (contract §3). The node has been validated by
-- lib/ivr_engine.lua (pinned tz, integer [start,end) ranges within 0..1440,
-- YYYY-MM-DD closed dates), so this only decides. A closed date wins over the
-- weekly hours. Returns true (open) / false (closed) / nil, err.
function M.hours_open(node, now)
    if type(node) ~= "table" then return nil, "no hours node" end
    local lt, err = M.local_time(node.tz, now)
    if not lt then return nil, err end
    for _, d in ipairs(node.closed_dates or {}) do
        if d == lt.date then return false end
    end
    local ranges = (node.weekly or {})[lt.day_key] or {}
    for _, r in ipairs(ranges) do
        if lt.minute >= r[1] and lt.minute < r[2] then return true end
    end
    return false
end

-- ------------------------------------------------------------------
-- Unified rich-plan matcher (kept for spec parity; not used by the IVR).
-- ------------------------------------------------------------------
local function parse_hm(s)
    if type(s) ~= "string" then return nil end
    local h, m = s:match("^%s*(%d%d?):(%d%d?)%s*$")
    if not h then
        h = s:match("^%s*(%d%d?)%s*$")
        if not h then return nil end
        m = 0
    end
    h, m = tonumber(h), tonumber(m)
    if h < 0 or h > 24 or m < 0 or m > 59 then return nil end
    return h * 60 + m
end

local function day_set_of(days)
    if type(days) ~= "table" or #days == 0 then return nil end
    local set = {}
    for _, d in ipairs(days) do
        local w = DAY_WDAY[tostring(d):lower():sub(1, 3)]
        if w then set[w] = true end
    end
    if next(set) == nil then return nil end
    return set
end

local function day_allowed(set, wday)
    if set == nil then return true end
    return set[wday] == true
end

local function prev_wday(w)
    if w <= 1 then return 7 end
    return w - 1
end

-- matches(schedule, now) -> boolean. Unknown tz -> UTC with a one-time
-- warning (unified semantics: a typo degrades to UTC, never crashes).
function M.matches(schedule, now)
    if type(schedule) ~= "table" then return true end
    now = now or os.time()

    local off = resolve_offset(schedule.tz, now)
    if not off then
        local tz = schedule.tz
        if tz ~= nil and tz ~= "" and not _warned_tz[tz] then
            _warned_tz[tz] = true
            warn("unknown tz '" .. tostring(tz) .. "' — falling back to UTC")
        end
        off = 0
    end
    local lt = os.date("!*t", now + off)
    local set = day_set_of(schedule.days)
    local cur = lt.hour * 60 + lt.min

    local smin = parse_hm(schedule.start)
    local emin = parse_hm(schedule["end"])
    if not smin and not emin then
        return day_allowed(set, lt.wday)
    end
    smin = smin or 0
    emin = emin or (24 * 60)
    if smin == emin then
        return day_allowed(set, lt.wday)
    end
    if emin > smin then
        if cur < smin or cur >= emin then return false end
        return day_allowed(set, lt.wday)
    end
    if cur >= smin then
        return day_allowed(set, lt.wday)
    elseif cur < emin then
        return day_allowed(set, prev_wday(lt.wday))
    end
    return false
end

return M
