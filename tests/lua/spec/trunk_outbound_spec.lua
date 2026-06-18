-- CHARACTERIZATION: trunk_outbound.lua
--
-- Runs the REAL trunk_outbound.lua end-to-end against mocked freeswitch / session
-- / db (Redis libs left unmocked => nil => the fail-open rate-limit steps are
-- skipped, exactly as in production when Redis is unreachable). Asserts the dial
-- string, X-Carrier selection + secondary-carrier failover, caller-ID setup, and
-- RFC 4028 session-timer export.

package.path = (debug.getinfo(1, "S").source:match("^@(.*/spec/)") or "./")
    :gsub("spec/$", "?.lua;") .. package.path

local helpers = require("helpers")
local fwmock = require("mocks.freeswitch_mock")
local sessmock = require("mocks.session_mock")
local dbmock = require("mocks.db_mock")

local TRUNK = helpers.scripts_dir .. "trunk_outbound.lua"
local contains = helpers.contains

local function run_trunk(opts)
    opts = opts or {}
    local fw = fwmock.new()
    local vars = {
        destination_number = "5551234567",
        caller_id_number = "+15551110000",
        caller_id_name = "PBX User",
        sip_from_user = "+15559998888",
        trunk_id = "42",
        customer_id = "7",
        sip_call_id = "tcid@2.2.2.2",
        uuid = "t-uuid",
    }
    if opts.disposition ~= nil then vars.originate_disposition = opts.disposition end
    local session, rec = sessmock.new({ vars = vars })
    helpers.run_script(TRUNK, {
        env = { EXTERNAL_SIP_IP = "203.0.113.5", SBC_PROXY_IP = "10.0.0.1" },
        freeswitch = fw,
        session = session,
        modules = {
            -- caller DID "+15559998888" belongs to trunk 42 -> validates.
            db_client = dbmock.new_db({ trunk_did = { trunk_id = "42" } }),
            -- redis_client / redis_cps intentionally absent (nil) -> fail-open skip.
        },
    })
    return rec
end

describe("trunk outbound bridge (primary carrier connects)", function()
    local rec = run_trunk({ disposition = "SUCCESS" })

    it("marks product/direction", function()
        assert.are.equal("trunk", rec.set_map["product_type"])
        assert.are.equal("outbound", rec.set_map["direction"])
    end)

    it("outbound caller ID = trunk DID 10-digit; effective = PBX original", function()
        assert.are.equal("5559998888", rec.set_map["outbound_caller_id_number"])
        assert.are.equal("5551110000", rec.set_map["effective_caller_id_number"])
        assert.are.equal("PBX User", rec.set_map["effective_caller_id_name"])
    end)

    it("X-Original-CID and Diversion are set", function()
        assert.are.equal("5551110000", rec.set_map["sip_h_X-Original-CID"])
        assert.are.equal(
            "<sip:5559998888@203.0.113.5>;reason=unconditional",
            rec.set_map["sip_h_Diversion"])
    end)

    it("trunk path anchors media with proxy_media=true", function()
        assert.are.equal("true", rec.set_map["proxy_media"])
    end)

    it("builds one primary-carrier dial string to the SBC", function()
        assert.are.equal(1, #rec.bridges)
        local b = rec.bridges[1]
        assert.is_true(contains(b, "sip_h_X-Carrier=primary"))
        assert.is_true(contains(b, "sofia/external/15551234567@10.0.0.1:5060"))
        assert.is_true(contains(b, "sip_enable_soa=false"))
        assert.is_true(contains(b, "progress_timeout=10"))
        assert.is_true(contains(b, "call_timeout=60"))
        assert.is_true(contains(b, "sip_h_X-CID=tcid@2.2.2.2"))
        assert.is_true(contains(b, "sip_session_timeout=1800"))
        assert.is_true(contains(b, "sip_minimum_session_expires=90"))
        assert.is_true(contains(b, "enable_timer=true"))
    end)

    it("exports RFC4028 session timers to the B-leg", function()
        local exp = table.concat(rec.exports, "\n")
        assert.is_true(contains(exp, "sip_session_timeout=1800"))
        assert.is_true(contains(exp, "sip_minimum_session_expires=90"))
        assert.is_true(contains(exp, "enable_timer=true"))
    end)
end)

describe("trunk outbound secondary-carrier failover", function()
    -- originate_disposition never becomes SUCCESS -> primary fails -> retry on secondary.
    local rec = run_trunk({ disposition = "" })

    it("attempts primary then secondary carrier", function()
        assert.are.equal(2, #rec.bridges)
        assert.is_true(contains(rec.bridges[1], "sip_h_X-Carrier=primary"))
        assert.is_true(contains(rec.bridges[2], "sip_h_X-Carrier=secondary"))
        -- Trunk failover keeps the SAME SBC, only the carrier changes.
        assert.is_true(contains(rec.bridges[2], "sofia/external/15551234567@10.0.0.1:5060"))
    end)

    it("returns 503 (NORMAL_TEMPORARY_FAILURE) after both carriers fail", function()
        assert.are.equal("NORMAL_TEMPORARY_FAILURE", rec.hangups[#rec.hangups])
    end)
end)
