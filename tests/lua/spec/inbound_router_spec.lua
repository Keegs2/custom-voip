-- CHARACTERIZATION: inbound_router.lua RCF path
--
-- Runs the REAL inbound_router.lua end-to-end against mocked freeswitch / session
-- / db, then asserts the exact side effects: dial strings, caller-ID / Diversion /
-- RPID / X-Original-CID headers, session-timer exports, and — most importantly —
-- the hard-won 4-attempt SBC x carrier failover ORDER.

package.path = (debug.getinfo(1, "S").source:match("^@(.*/spec/)") or "./")
    :gsub("spec/$", "?.lua;") .. package.path

local helpers = require("helpers")
local fwmock = require("mocks.freeswitch_mock")
local sessmock = require("mocks.session_mock")
local dbmock = require("mocks.db_mock")

local INBOUND = helpers.scripts_dir .. "inbound_router.lua"
local contains = helpers.contains

-- Standard RCF DB row. Override fields per-test as needed.
local function rcf_row(over)
    local r = {
        customer_id = "55",
        forward_to = "17775556666",
        traffic_grade = "standard",
        cpm_limit = "60",
        daily_limit = "500",
        pass_caller_id = "t",
        ring_timeout = "30",
        max_channels = "0",
        name = "Main Office",
    }
    for k, v in pairs(over or {}) do r[k] = v end
    return r
end

-- Run the RCF path; returns the session recorder.
local function run_rcf(opts)
    opts = opts or {}
    local fw = fwmock.new()
    local vars = {
        destination_number = "+16175551234",
        caller_id_number = "+15558675309",
        caller_id_name = "Alice",
        sip_from_user = "",
        sip_from_display = "",
        sip_received_ip = "67.231.2.12",
        sip_call_id = "callid-abc@67.231.2.12",
        uuid = "uuid-1",
    }
    if opts.disposition then vars.originate_disposition = opts.disposition end
    local session, rec = sessmock.new({ vars = vars })
    helpers.run_script(INBOUND, {
        env = {
            EXTERNAL_SIP_IP = "203.0.113.5",
            SBC_PROXY_IP = "10.0.0.1",
            SBC_PROXY_IP_FAILOVER = "10.0.0.2",
        },
        freeswitch = fw,
        session = session,
        modules = { db_client = dbmock.new_db({ rcf = rcf_row(opts.rcf_over) }) },
    })
    return rec
end

describe("RCF caller-ID / Diversion / RPID setup (pass_caller_id=true)", function()
    local rec = run_rcf()

    it("sets customer/product channel vars", function()
        assert.are.equal("55", rec.set_map["customer_id"])
        assert.are.equal("rcf", rec.set_map["product_type"])
        assert.are.equal("standard", rec.set_map["traffic_grade"])
    end)

    it("outbound caller ID is the RCF DID in 10-digit form (Bandwidth auth)", function()
        assert.are.equal("6175551234", rec.set_map["outbound_caller_id_number"])
        assert.are.equal("6175551234", rec.set_map["outbound_caller_id_name"])
    end)

    it("effective caller ID preserves the original caller", function()
        assert.are.equal("5558675309", rec.set_map["effective_caller_id_number"])
        assert.are.equal("Alice", rec.set_map["effective_caller_id_name"])
    end)

    it("Diversion header is the RCF DID, reason=unconditional, on EXTERNAL_SIP_IP", function()
        assert.are.equal(
            "<sip:6175551234@203.0.113.5>;reason=unconditional",
            rec.set_map["sip_h_Diversion"])
    end)

    it("X-Original-CID is the original caller in E.164 (Kamailio builds PAI)", function()
        assert.are.equal("+15558675309", rec.set_map["sip_h_X-Original-CID"])
    end)

    it("X-Original-CID-Name is the RCF line name", function()
        assert.are.equal("Main Office", rec.set_map["sip_h_X-Original-CID-Name"])
    end)

    it("Remote-Party-ID is the original caller in E.164 with party params", function()
        assert.are.equal(
            "<sip:+15558675309@203.0.113.5>;party=calling;privacy=off;screen=yes",
            rec.set_map["sip_h_Remote-Party-ID"])
    end)

    it("exports origination caller ID + RFC4028 session timers to the B-leg", function()
        local exp = table.concat(rec.exports, "\n")
        assert.is_true(contains(exp, "origination_caller_id_number=6175551234"))
        assert.is_true(contains(exp, "origination_caller_id_name=6175551234"))
        assert.is_true(contains(exp, "sip_session_timeout=1800"))
        assert.is_true(contains(exp, "sip_minimum_session_expires=90"))
        assert.is_true(contains(exp, "enable_timer=true"))
    end)
end)

describe("RCF caller-ID override (pass_caller_id=false)", function()
    local rec = run_rcf({ rcf_over = { pass_caller_id = "f" } })

    it("called party sees the RCF DID, not the original caller", function()
        assert.are.equal("6175551234", rec.set_map["effective_caller_id_number"])
        assert.are.equal("6175551234", rec.set_map["effective_caller_id_name"])
    end)

    it("X-Original-CID and RPID fall back to the RCF DID in E.164", function()
        assert.are.equal("+16175551234", rec.set_map["sip_h_X-Original-CID"])
        assert.are.equal(
            "<sip:+16175551234@203.0.113.5>;party=calling;privacy=off;screen=yes",
            rec.set_map["sip_h_Remote-Party-ID"])
    end)
end)

describe("RCF 4-attempt SBC x carrier failover ORDER (hard-won lesson)", function()
    -- No originate_disposition -> every attempt 'fails' -> all 4 run, in order.
    local rec = run_rcf()

    it("runs exactly 4 bridge attempts", function()
        assert.are.equal(4, #rec.bridges)
    end)

    it("attempt 1 = SBC-1 (primary SBC) + primary carrier (Dallas)", function()
        assert.is_true(contains(rec.bridges[1], "sip_h_X-Carrier=primary"))
        assert.is_true(contains(rec.bridges[1], "sofia/external/17775556666@10.0.0.1:5060"))
    end)

    it("attempt 2 = SBC-2 (failover SBC) + primary carrier (Dallas)", function()
        assert.is_true(contains(rec.bridges[2], "sip_h_X-Carrier=primary"))
        assert.is_true(contains(rec.bridges[2], "sofia/external/17775556666@10.0.0.2:5060"))
    end)

    it("attempt 3 = SBC-1 + secondary carrier (LA)", function()
        assert.is_true(contains(rec.bridges[3], "sip_h_X-Carrier=secondary"))
        assert.is_true(contains(rec.bridges[3], "sofia/external/17775556666@10.0.0.1:5060"))
    end)

    it("attempt 4 = SBC-2 + secondary carrier (LA)", function()
        assert.is_true(contains(rec.bridges[4], "sip_h_X-Carrier=secondary"))
        assert.is_true(contains(rec.bridges[4], "sofia/external/17775556666@10.0.0.2:5060"))
    end)

    it("every attempt carries progress_timeout, call_timeout, X-CID and session timers", function()
        for _, b in ipairs(rec.bridges) do
            assert.is_true(contains(b, "ignore_early_media=false"))
            assert.is_true(contains(b, "progress_timeout=10"))     -- BRIDGE_PROGRESS_TIMEOUT default
            assert.is_true(contains(b, "call_timeout=30"))         -- ring_timeout
            assert.is_true(contains(b, "sip_h_X-CID=callid-abc@67.231.2.12"))
            assert.is_true(contains(b, "sip_session_timeout=1800"))
            assert.is_true(contains(b, "sip_minimum_session_expires=90"))
            assert.is_true(contains(b, "enable_timer=true"))
        end
    end)

    it("RCF dial strings do NOT set proxy_media (default media mode)", function()
        for _, b in ipairs(rec.bridges) do
            assert.is_false(contains(b, "proxy_media"))
        end
    end)

    it("when all attempts fail it hangs up NORMAL_TEMPORARY_FAILURE (503), not 404", function()
        assert.is_true(#rec.hangups >= 1)
        assert.are.equal("NORMAL_TEMPORARY_FAILURE", rec.hangups[#rec.hangups])
    end)
end)

describe("RCF stops failover on the first connected attempt", function()
    local rec = run_rcf({ disposition = "SUCCESS" })

    it("only one bridge runs when attempt 1 connects", function()
        assert.are.equal(1, #rec.bridges)
        assert.is_true(contains(rec.bridges[1], "sip_h_X-Carrier=primary"))
        assert.is_true(contains(rec.bridges[1], "@10.0.0.1:5060"))
    end)

    it("no failure hangup is issued on success", function()
        assert.are.equal(0, #rec.hangups)
    end)
end)
