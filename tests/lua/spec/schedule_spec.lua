-- UNIT: lib/schedule.lua time-of-day / day-of-week matcher
--
-- schedule.matches(schedule, now) is pure (no FreeSWITCH, no side effects), so
-- we load the real shipped lib directly and drive it with FIXED UTC epochs for
-- fully deterministic assertions regardless of the host machine's timezone.
--
-- Reference instants (all UTC):
--   1705327200 = 2024-01-15 14:00:00Z  (Monday, winter / EST)
--   1705323600 = 2024-01-15 13:00:00Z  (Monday, winter / EST)
--   1721048400 = 2024-07-15 13:00:00Z  (Monday, summer / EDT)
--   1721008800 = 2024-07-15 02:00:00Z  (Mon 02:00Z = Sun 22:00 EDT)
--   1705705200 = 2024-01-19 23:00:00Z  (Friday 23:00)
--   1705712400 = 2024-01-20 01:00:00Z  (Saturday 01:00)
--   1705719600 = 2024-01-20 03:00:00Z  (Saturday 03:00)
--   1705618800 = 2024-01-18 23:00:00Z  (Thursday 23:00)

package.path = (debug.getinfo(1, "S").source:match("^@(.*/spec/)") or "./")
    :gsub("spec/$", "?.lua;") .. package.path

local helpers = require("helpers")
local schedule = dofile(helpers.scripts_dir .. "lib/schedule.lua")

local NY = "America/New_York"

describe("schedule: nil / no time bounds", function()
    it("nil schedule is always true", function()
        assert.is_true(schedule.matches(nil, 1705327200))
    end)
    it("non-table schedule is always true", function()
        assert.is_true(schedule.matches("nope", 1705327200))
    end)
    it("empty table (no days, no window) is always true", function()
        assert.is_true(schedule.matches({}, 1705327200))
    end)
    it("days only, in the day set", function()
        -- 2024-01-15 is a Monday (UTC); tz=UTC so wday is Monday.
        assert.is_true(schedule.matches({ days = { "mon" }, tz = "UTC" }, 1705327200))
    end)
    it("days only, NOT in the day set", function()
        assert.is_false(schedule.matches({ days = { "tue", "wed" }, tz = "UTC" }, 1705327200))
    end)
end)

describe("schedule: same-day window in America/New_York (DST aware)", function()
    local biz = { days = { "mon", "tue", "wed", "thu", "fri" },
                  start = "09:00", ["end"] = "17:00", tz = NY }

    it("winter: 14:00Z = 09:00 EST Monday -> inside (start inclusive)", function()
        assert.is_true(schedule.matches(biz, 1705327200))
    end)
    it("winter: 13:00Z = 08:00 EST Monday -> before open", function()
        assert.is_false(schedule.matches(biz, 1705323600))
    end)
    it("summer: 13:00Z = 09:00 EDT Monday -> inside (proves +1h DST applied)", function()
        -- If DST were NOT applied this would be 08:00 EST and FALSE.
        assert.is_true(schedule.matches(biz, 1721048400))
    end)
    it("summer: 02:00Z = Sun 22:00 EDT -> wrong day + outside", function()
        assert.is_false(schedule.matches(biz, 1721008800))
    end)
end)

describe("schedule: fixed numeric offset string", function()
    it("'-05:00' at 14:00Z = 09:00 -> inside 09:00-17:00", function()
        assert.is_true(schedule.matches(
            { start = "09:00", ["end"] = "17:00", tz = "-05:00" }, 1705327200))
    end)
    it("'-8' at 14:00Z = 06:00 -> before 09:00", function()
        assert.is_false(schedule.matches(
            { start = "09:00", ["end"] = "17:00", tz = "-8" }, 1705327200))
    end)
end)

describe("schedule: overnight window (start > end wraps midnight)", function()
    -- Fri 22:00 -> Sat 02:00, anchored to Friday.
    local night = { days = { "fri" }, start = "22:00", ["end"] = "02:00", tz = "UTC" }

    it("Friday 23:00 -> evening portion, Friday in set", function()
        assert.is_true(schedule.matches(night, 1705705200))
    end)
    it("Saturday 01:00 -> early-morning portion, previous day (Fri) in set", function()
        assert.is_true(schedule.matches(night, 1705712400))
    end)
    it("Saturday 03:00 -> past close, outside", function()
        assert.is_false(schedule.matches(night, 1705719600))
    end)
    it("Thursday 23:00 -> evening but Thursday not in set", function()
        assert.is_false(schedule.matches(night, 1705618800))
    end)
end)

describe("schedule: half-open boundaries", function()
    it("end is exclusive: 17:00 local is NOT inside 09:00-17:00", function()
        -- 22:00Z = 17:00 EST Monday (Jan15 00:00Z 1705276800 + 79200).
        assert.is_false(schedule.matches(
            { start = "09:00", ["end"] = "17:00", tz = NY }, 1705356000))
    end)
    it("only start given -> open until end of day", function()
        -- 23:00Z = 18:00 EST Monday, after 09:00, no end -> inside.
        assert.is_true(schedule.matches({ start = "09:00", tz = NY }, 1705359600))
    end)
end)
