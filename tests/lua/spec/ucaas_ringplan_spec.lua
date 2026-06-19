-- CHARACTERIZATION: handlers/ucaas.lua find-me/follow-me ring plan
--
-- Exercises the NEW ring_plan path (extensions.ring_plan) through the real
-- inbound_router -> handlers/ucaas dispatch. The db_client mock returns the
-- extension row directly (db_client is mock-only in the harness), so the test
-- supplies ring_plan as an already-parsed Lua table — exactly what
-- db_client.lookup_extension_did hands back after decoding the JSONB.
--
-- Verifies:
--   * sequential rings legs in order with per-leg timeout, advancing on no-answer
--   * a leg that answers stops the ring (no further legs, no fallback)
--   * parallel rings all legs in ONE comma-joined dial string
--   * extension-leg vs E.164-leg dial-string construction
--   * fallback voicemail / forward / hangup
--   * PSTN carrier caller-ID setup (From = DID, Diversion, RPID)
--   * NIL ring_plan still takes the legacy single-bridge path (regression guard)

package.path = (debug.getinfo(1, "S").source:match("^@(.*/spec/)") or "./")
    :gsub("spec/$", "?.lua;") .. package.path

local helpers = require("helpers")
local fwmock = require("mocks.freeswitch_mock")
local sessmock = require("mocks.session_mock")
local dbmock = require("mocks.db_mock")

local INBOUND = helpers.scripts_dir .. "inbound_router.lua"
local contains = helpers.contains

local function ext_row(over)
    local r = { extension = "100", customer_id = "13", display_name = "Jane Doe" }
    for k, v in pairs(over or {}) do r[k] = v end
    return r
end

-- Run inbound_router with an extension DID that carries a ring_plan.
--   opts.ring_plan   : the parsed ring plan table (set on the extension row)
--   opts.disposition : seeds originate_disposition (e.g. "SUCCESS" = a leg answered)
local function run(opts)
    opts = opts or {}
    local fw = fwmock.new()
    local vars = {
        destination_number = "+13105551111",
        caller_id_number = "+15558675309",
        caller_id_name = "Alice",
        sip_from_user = "",
        sip_from_display = "",
        sip_received_ip = "67.231.2.12",
        sip_call_id = "callid-fmfm@67.231.2.12",
        uuid = "uuid-fmfm",
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
        modules = {
            db_client = dbmock.new_db({ extension_did = ext_row({ ring_plan = opts.ring_plan }) }),
        },
    })
    return rec
end

local function recorded_voicemail(rec)
    for _, e in ipairs(rec.executes) do
        if e.app == "record" then return e.data end
    end
    return nil
end

describe("FMFM sequential: rings legs in order, advances on no-answer", function()
    -- No disposition seeded => every leg "fails" => all legs ring, then fallback.
    local rec = run({
        ring_plan = {
            strategy = "sequential",
            ring_timeout = 20,
            legs = {
                { to = "100" },                       -- extension, uses plan timeout 20
                { to = "+15551234567", timeout = 15 },-- E.164, per-leg timeout 15
            },
            fallback = { type = "voicemail" },
        },
    })

    it("rings both legs in document order", function()
        assert.are.equal(2, #rec.bridges)
    end)

    it("leg 1 is the extension via verto+user fallback at the plan ring_timeout", function()
        local b = rec.bridges[1]
        assert.is_true(contains(b, "verto.rtc/100@customer_13.voiceplatform.local"))
        assert.is_true(contains(b, "user/100@customer_13.voiceplatform.local"))
        assert.is_true(contains(b, "call_timeout=20"))
    end)

    it("leg 2 is the E.164 via the carrier (10-digit, X-Carrier) at its own timeout", function()
        local b = rec.bridges[2]
        assert.is_true(contains(b, "sofia/external/5551234567@10.0.0.1:5060"))
        assert.is_true(contains(b, "sip_h_X-Carrier=primary"))
        assert.is_true(contains(b, "call_timeout=15"))
        assert.is_true(contains(b, "sip_session_timeout=1800"))
    end)

    it("falls back to voicemail after all legs fail", function()
        local vm = recorded_voicemail(rec)
        assert.is_not_nil(vm)
        assert.is_true(contains(vm, "/var/lib/freeswitch/voicemail/customer_13.voiceplatform.local/100/"))
        assert.is_true(contains(vm, "300 200 3"))
    end)

    it("sets carrier caller ID (From=DID, Diversion, Remote-Party-ID)", function()
        assert.are.equal("3105551111", rec.set_map["outbound_caller_id_number"])
        assert.is_true(contains(rec.set_map["sip_h_Diversion"], "3105551111@203.0.113.5"))
        assert.is_true(contains(rec.set_map["sip_h_X-Original-CID"], "+15558675309"))
        assert.is_true(contains(rec.set_map["sip_h_Remote-Party-ID"], "+15558675309"))
        -- presented identity to the called party stays the real caller
        assert.are.equal("+15558675309", rec.set_map["effective_caller_id_number"])
    end)
end)

describe("FMFM sequential: a leg ANSWERS -> stop, no further legs, no fallback", function()
    local rec = run({
        disposition = "SUCCESS",
        ring_plan = {
            strategy = "sequential",
            ring_timeout = 30,
            legs = { { to = "100" }, { to = "+15551234567" } },
            fallback = { type = "voicemail" },
        },
    })

    it("rings only the first leg", function()
        assert.are.equal(1, #rec.bridges)
        assert.is_true(contains(rec.bridges[1], "verto.rtc/100@"))
    end)

    it("does not record voicemail and does not answer for a prompt", function()
        assert.is_nil(recorded_voicemail(rec))
        assert.are.equal(0, rec.answered)
    end)
end)

describe("FMFM parallel: all legs in ONE comma-joined dial string", function()
    local rec = run({
        ring_plan = {
            strategy = "parallel",
            ring_timeout = 25,
            legs = { { to = "1001" }, { to = "17745551212" } },
            fallback = { type = "hangup" },
        },
    })

    it("issues a single bridge", function()
        assert.are.equal(1, #rec.bridges)
    end)

    it("rings extension (verto+user) and PSTN simultaneously at overall ring_timeout", function()
        local b = rec.bridges[1]
        assert.is_true(contains(b, "call_timeout=25"))
        assert.is_true(contains(b, "verto.rtc/1001@customer_13.voiceplatform.local"))
        assert.is_true(contains(b, "user/1001@customer_13.voiceplatform.local"))
        assert.is_true(contains(b, "sofia/external/7745551212@10.0.0.1:5060"))
        assert.is_true(contains(b, "sip_h_X-Carrier=primary"))
        -- comma-separated (simring), not pipe (sequential)
        assert.is_true(contains(b, ","))
    end)
end)

describe("FMFM fallback=hangup: legs fail -> hangup, no voicemail", function()
    local rec = run({
        ring_plan = {
            strategy = "sequential",
            ring_timeout = 10,
            legs = { { to = "100" } },
            fallback = { type = "hangup" },
        },
    })

    it("hangs up and does not record voicemail", function()
        assert.is_nil(recorded_voicemail(rec))
        assert.is_true(#rec.hangups >= 1)
        assert.are.equal("NO_ANSWER", rec.hangups[1])
    end)
end)

describe("FMFM fallback=forward: legs fail -> bridge to the forward target", function()
    local rec = run({
        ring_plan = {
            strategy = "sequential",
            ring_timeout = 10,
            legs = { { to = "100" } },
            fallback = { type = "forward", to = "+18005551212" },
        },
    })

    it("rings the extension leg then forwards to the PSTN target via the carrier", function()
        -- bridge 1 = extension leg, bridge 2 = forward target
        assert.are.equal(2, #rec.bridges)
        assert.is_true(contains(rec.bridges[1], "verto.rtc/100@"))
        assert.is_true(contains(rec.bridges[2], "sofia/external/8005551212@10.0.0.1:5060"))
    end)

    it("does not record voicemail (forward, not voicemail)", function()
        assert.is_nil(recorded_voicemail(rec))
    end)
end)

describe("FMFM all-extension plan does NOT arm carrier caller ID", function()
    local rec = run({
        ring_plan = {
            strategy = "sequential",
            ring_timeout = 15,
            legs = { { to = "100" }, { to = "200" } },
            fallback = { type = "voicemail" },
        },
    })

    it("leaves outbound/Diversion unset (purely internal ring)", function()
        assert.is_nil(rec.set_map["outbound_caller_id_number"])
        assert.is_nil(rec.set_map["sip_h_Diversion"])
    end)
end)

describe("NIL ring_plan still takes the legacy single-bridge path", function()
    local rec = run({ ring_plan = nil })

    it("issues exactly one verto+user bridge at call_timeout=30", function()
        assert.are.equal(1, #rec.bridges)
        local b = rec.bridges[1]
        assert.is_true(contains(b, "verto.rtc/100@customer_13.voiceplatform.local"))
        assert.is_true(contains(b, "user/100@customer_13.voiceplatform.local"))
        assert.is_true(contains(b, "call_timeout=30"))
    end)
end)
