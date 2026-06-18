-- CHARACTERIZATION: lib/caller_id.lua
--
-- Pins the extracted Diversion / Remote-Party-ID header-value formatters. The
-- exact strings here are byte-for-byte what inbound_router.lua (rcf branch) and
-- trunk_outbound.lua emitted inline before the Phase 2 split — and they match
-- the values asserted from the real scripts in inbound_router_spec.lua
-- (sip_h_Diversion, sip_h_Remote-Party-ID) and trunk_outbound_spec.lua
-- (sip_h_Diversion).

package.path = (debug.getinfo(1, "S").source:match("^@(.*/spec/)") or "./")
    :gsub("spec/$", "?.lua;") .. package.path

local helpers = require("helpers")

local caller_id = assert(loadfile(helpers.scripts_dir .. "lib/caller_id.lua"))()

describe("lib/caller_id.diversion", function()
    it("formats <sip:DID@IP>;reason=unconditional", function()
        assert.are.equal(
            "<sip:6175551234@203.0.113.5>;reason=unconditional",
            caller_id.diversion("6175551234", "203.0.113.5"))
    end)
end)

describe("lib/caller_id.remote_party_id", function()
    it("formats <sip:CID@IP>;party=calling;privacy=off;screen=yes", function()
        assert.are.equal(
            "<sip:+15558675309@203.0.113.5>;party=calling;privacy=off;screen=yes",
            caller_id.remote_party_id("+15558675309", "203.0.113.5"))
    end)

    it("passes the (override) RCF DID through the same way", function()
        assert.are.equal(
            "<sip:+16175551234@203.0.113.5>;party=calling;privacy=off;screen=yes",
            caller_id.remote_party_id("+16175551234", "203.0.113.5"))
    end)
end)
