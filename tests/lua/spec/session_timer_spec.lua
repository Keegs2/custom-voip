-- CHARACTERIZATION: lib/session_timer.lua
--
-- Pins the extracted RFC 4028 session-timer helpers. BRIDGE_OPTS is the exact
-- bridge {} fragment, and export() emits the exact three exports, that the
-- inline copies in inbound_router.lua (rcf) / trunk_outbound.lua /
-- api_outbound.lua produced before the Phase 2 split. These same values are
-- asserted end-to-end from the real scripts in inbound_router_spec.lua and
-- trunk_outbound_spec.lua.

package.path = (debug.getinfo(1, "S").source:match("^@(.*/spec/)") or "./")
    :gsub("spec/$", "?.lua;") .. package.path

local helpers = require("helpers")
local sessmock = require("mocks.session_mock")

local session_timer = assert(loadfile(helpers.scripts_dir .. "lib/session_timer.lua"))()

describe("lib/session_timer.BRIDGE_OPTS", function()
    it("is the exact session-timer dial-string fragment, in order", function()
        assert.are.equal(
            "sip_session_timeout=1800,sip_minimum_session_expires=90,enable_timer=true",
            session_timer.BRIDGE_OPTS)
    end)
end)

describe("lib/session_timer.export", function()
    local session, rec = sessmock.new({})
    session_timer.export(session)

    it("exports the three B-leg session-timer variables, in order", function()
        assert.are.equal(3, #rec.exports)
        assert.are.equal("sip_session_timeout=1800", rec.exports[1])
        assert.are.equal("sip_minimum_session_expires=90", rec.exports[2])
        assert.are.equal("enable_timer=true", rec.exports[3])
    end)
end)
