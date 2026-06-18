-- CHARACTERIZATION: lib/dialstring.lua
--
-- Pins the extracted sofia/external dial-string builder. The strings asserted
-- here are byte-for-byte what inbound_router.lua / trunk_outbound.lua /
-- api_outbound.lua produced inline before the Phase 2 split — see the
-- cross-checks in inbound_router_spec.lua (4 RCF bridges) and
-- trunk_outbound_spec.lua (primary + secondary) that exercise this builder via
-- the real production scripts.

package.path = (debug.getinfo(1, "S").source:match("^@(.*/spec/)") or "./")
    :gsub("spec/$", "?.lua;") .. package.path

local helpers = require("helpers")

local dialstring = assert(loadfile(helpers.scripts_dir .. "lib/dialstring.lua"))()

describe("lib/dialstring.bridge", function()
    it("wraps the inner options in {} and appends the sofia/external endpoint", function()
        assert.are.equal(
            "{progress_timeout=10,call_timeout=30}sofia/external/17775556666@10.0.0.1:5060",
            dialstring.bridge("progress_timeout=10,call_timeout=30", "17775556666", "10.0.0.1"))
    end)

    it("passes the destination and proxy through verbatim (no number/format logic)", function()
        -- The builder makes no decisions about the number — caller strips the +.
        assert.are.equal(
            "{x=1}sofia/external/+442079460991@192.168.10.2:5060",
            dialstring.bridge("x=1", "+442079460991", "192.168.10.2"))
    end)

    it("never emits gateway syntax", function()
        local s = dialstring.bridge("a=b", "15551234567", "10.0.0.2")
        assert.is_nil(s:find("sofia/gateway/", 1, true))
        assert.is_true(s:find("sofia/external/", 1, true) ~= nil)
    end)
end)
