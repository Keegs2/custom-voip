-- CHARACTERIZATION: lib/e164.lua
--
-- Independent guard for the extracted E.164 helper module. The SAME exact
-- behavior is also pinned, from the production scripts' perspective, by
-- normalization_spec.lua (which extracts `normalize_did` / `to_10digit` /
-- `normalize_destination` out of inbound_router.lua and trunk_outbound.lua
-- after they bind `local x = e164.x`). This spec asserts the module in
-- isolation so the lib is guarded on its own, byte-for-byte against the values
-- the production scripts used before the extraction.
--
-- The expected outputs here are intentionally IDENTICAL to the cases in
-- normalization_spec.lua — if the two ever diverge, the extraction was not
-- behavior-preserving.

package.path = (debug.getinfo(1, "S").source:match("^@(.*/spec/)") or "./")
    :gsub("spec/$", "?.lua;") .. package.path

local helpers = require("helpers")

-- Load the REAL lib module off disk (pure Lua, returns a table).
local e164 = assert(loadfile(helpers.scripts_dir .. "lib/e164.lua"))()

describe("lib/e164.normalize_did (characterization)", function()
    it("table of inputs -> exact current outputs", function()
        local cases = {
            { "+16175551234", "+16175551234" },   -- already E.164, kept as-is
            { "6175551234",   "+16175551234" },   -- 10-digit US -> +1
            { "16175551234",  "+16175551234" },   -- 11-digit leading 1 -> +
            { "1-617-555-1234", "+16175551234" }, -- punctuation stripped
            { "(617) 555-1234", "+16175551234" },
            { "+1 (617) 555-1234", "+16175551234" },
            { "+15558675309", "+15558675309" },
            { "15558675309",  "+15558675309" },
            { "442079460991", "+442079460991" },  -- 12 digits: bare "+" prefix
            { "+442079460991", "+442079460991" },
            { "917",          "+917" },           -- short -> "+" prefix
            { "abc",          "+" },              -- garbage -> "+"
            { "",             "+" },              -- empty -> "+"
        }
        for _, c in ipairs(cases) do
            assert.are.equal(c[2], e164.normalize_did(c[1]))
        end
    end)
end)

describe("lib/e164.to_10digit (characterization)", function()
    it("table of inputs -> exact current outputs", function()
        local cases = {
            { "+16175551234", "6175551234" },
            { "6175551234",   "6175551234" },
            { "16175551234",  "6175551234" },
            { "+15558675309", "5558675309" },
            { "12025550173",  "2025550173" },
            { "2025550173",   "2025550173" },
            { "+442079460991", "442079460991" },  -- 12 digits: passthrough
            { "917",          "917" },            -- non-10/11: passthrough digits
            { "+",            "" },                -- no digits -> empty
            { "abc",          "" },
        }
        for _, c in ipairs(cases) do
            assert.are.equal(c[2], e164.to_10digit(c[1]))
        end
    end)

    it("nil / empty input is returned unchanged (guard clause)", function()
        assert.is_nil(e164.to_10digit(nil))
        assert.are.equal("", e164.to_10digit(""))
    end)
end)

describe("lib/e164.normalize_destination (characterization)", function()
    it("table of inputs -> exact current outputs", function()
        local cases = {
            { "5551234567",     "+15551234567" },
            { "+15551234567",   "+15551234567" },
            { "15551234567",    "+15551234567" },
            { "01144123456789", "+44123456789" },  -- 011 international prefix -> +
            { "+442079460991",  "+442079460991" },
        }
        for _, c in ipairs(cases) do
            assert.are.equal(c[2], e164.normalize_destination(c[1]))
        end
    end)

    it("preserves * and # service-code characters (unlike normalize_did)", function()
        -- normalize_destination strips [^%d+*#] (keeps * and #); a star code
        -- stays a star code rather than being mangled into digits.
        assert.are.equal("+*67", e164.normalize_destination("*67"))
        assert.are.equal("+#31#", e164.normalize_destination("#31#"))
    end)
end)
