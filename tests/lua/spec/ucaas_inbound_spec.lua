-- CHARACTERIZATION: inbound_router.lua UCaaS extension path
--
-- Pins the now-ACTIVE ucaas branch: an inbound DID that resolves (only) to a
-- UCaaS extension (extensions.assigned_did) routes to that extension via the
-- verto.rtc/...|user/... dial string, and on bridge failure/no-answer falls
-- through to the voicemail recording flow — while a SUCCESSFULLY answered call
-- does NOT record voicemail.
--
-- Guards two things that just changed:
--   1. cascade ordering: RCF -> API -> Trunk -> UCaaS Extension. The extension
--      lookup is reached only when no earlier (revenue) lookup matched.
--   2. bridge-success detection uses originate_disposition (the real FS var),
--      NOT the non-existent `bridge_result`. With `bridge_result` a connected
--      call would have wrongly dropped into voicemail.

package.path = (debug.getinfo(1, "S").source:match("^@(.*/spec/)") or "./")
    :gsub("spec/$", "?.lua;") .. package.path

local helpers = require("helpers")
local fwmock = require("mocks.freeswitch_mock")
local sessmock = require("mocks.session_mock")
local dbmock = require("mocks.db_mock")

local INBOUND = helpers.scripts_dir .. "inbound_router.lua"
local contains = helpers.contains

-- Standard UCaaS extension DB row (what lookup_extension_did returns).
local function ext_row(over)
    local r = {
        extension = "100",
        customer_id = "13",
        display_name = "Jane Doe",
    }
    for k, v in pairs(over or {}) do r[k] = v end
    return r
end

-- Run the inbound router with ONLY an extension DID match (rcf/api/trunk nil).
-- opts.disposition seeds originate_disposition before the bridge runs.
-- opts.db lets a test supply additional matches (to prove cascade priority).
local function run_ucaas(opts)
    opts = opts or {}
    local fw = fwmock.new()
    local vars = {
        destination_number = "+13105551111",
        caller_id_number = "+15558675309",
        caller_id_name = "Alice",
        sip_from_user = "",
        sip_from_display = "",
        sip_received_ip = "67.231.2.12",
        sip_call_id = "callid-ucaas@67.231.2.12",
        uuid = "uuid-ucaas",
    }
    if opts.disposition then vars.originate_disposition = opts.disposition end
    local session, rec = sessmock.new({ vars = vars })
    local db_cfg = opts.db or { extension_did = ext_row(opts.ext_over) }
    helpers.run_script(INBOUND, {
        env = {
            EXTERNAL_SIP_IP = "203.0.113.5",
            SBC_PROXY_IP = "10.0.0.1",
            SBC_PROXY_IP_FAILOVER = "10.0.0.2",
        },
        freeswitch = fw,
        session = session,
        modules = { db_client = dbmock.new_db(db_cfg) },
    })
    return rec
end

-- Did the recorded session run a `record` application (voicemail capture)?
local function recorded_voicemail(rec)
    for _, e in ipairs(rec.executes) do
        if e.app == "record" then return e.data end
    end
    return nil
end

describe("UCaaS inbound: DID resolves to an extension", function()
    local rec = run_ucaas()

    it("sets product_type=ucaas and the customer id from the extension row", function()
        assert.are.equal("ucaas", rec.set_map["product_type"])
        assert.are.equal("13", rec.set_map["customer_id"])
    end)

    it("bridges to the extension on the customer-scoped domain (verto + user fallback)", function()
        assert.are.equal(1, #rec.bridges)
        local b = rec.bridges[1]
        assert.is_true(contains(b, "verto.rtc/100@customer_13.voiceplatform.local"))
        assert.is_true(contains(b, "user/100@customer_13.voiceplatform.local"))
        assert.is_true(contains(b, "call_timeout=30"))
    end)

    it("marks the call lua_routed so the dialplan fallback won't 404", function()
        assert.are.equal("true", rec.set_map["lua_routed"])
    end)

    it("preserves the original caller ID for the extension to see", function()
        assert.are.equal("+15558675309", rec.set_map["effective_caller_id_number"])
        assert.are.equal("Alice", rec.set_map["effective_caller_id_name"])
    end)
end)

describe("UCaaS inbound: bridge FAILS -> falls through to voicemail", function()
    -- No originate_disposition seeded => disposition == "" ~= "SUCCESS" => fail.
    local rec = run_ucaas()

    it("answers the call and records a voicemail message", function()
        assert.is_true(rec.answered >= 1)
        local vm = recorded_voicemail(rec)
        assert.is_not_nil(vm)
        -- record <file> <max> <silence_thresh> <silence_hits>
        assert.is_true(contains(vm, "/var/lib/freeswitch/voicemail/customer_13.voiceplatform.local/100/"))
        assert.is_true(contains(vm, "300 200 3"))
    end)
end)

describe("UCaaS inbound: bridge SUCCEEDS -> NO voicemail (bridge_result bug fix)", function()
    -- originate_disposition=SUCCESS: a connected/answered call must NOT record.
    -- This is the regression the old `bridge_result` check would have failed:
    -- bridge_result is never set, so the answered call would have dropped to VM.
    local rec = run_ucaas({ disposition = "SUCCESS" })

    it("does not record voicemail after a successful bridge", function()
        assert.is_nil(recorded_voicemail(rec))
    end)

    it("does not answer for a voicemail prompt after a successful bridge", function()
        assert.are.equal(0, rec.answered)
    end)
end)

describe("UCaaS cascade priority: RCF/API/Trunk still win over an extension", function()
    -- DID matches BOTH an RCF number and an extension. The extension lookup must
    -- NOT be reached — the call routes as RCF, proving ordering is unchanged for
    -- existing products.
    local rec = run_ucaas({
        db = {
            rcf = {
                customer_id = "55", forward_to = "17775556666",
                traffic_grade = "standard", cpm_limit = "60", daily_limit = "500",
                pass_caller_id = "t", ring_timeout = "30", max_channels = "0",
                name = "Main Office",
            },
            extension_did = ext_row(),
        },
    })

    it("routes as RCF, not UCaaS", function()
        assert.are.equal("rcf", rec.set_map["product_type"])
        assert.are.equal("55", rec.set_map["customer_id"])
    end)

    it("uses the RCF PSTN failover bridge, not the extension dial string", function()
        assert.is_true(#rec.bridges >= 1)
        for _, b in ipairs(rec.bridges) do
            assert.is_false(contains(b, "verto.rtc/"))
            assert.is_true(contains(b, "sofia/external/17775556666@"))
        end
    end)
end)
