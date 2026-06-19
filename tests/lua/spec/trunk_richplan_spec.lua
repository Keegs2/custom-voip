-- CHARACTERIZATION: handlers/trunk.lua RICH route_plan path (rules-based)
--
-- Drives the REAL inbound_router -> handlers/trunk dispatch with a trunk_dids row
-- carrying a RICH route_plan ({ rules = { { match, strategy, timeout, endpoints },
-- ... } }). db_client is mock-only in the harness, so the test supplies the
-- already-parsed Lua table exactly as db_client.lookup_trunk_did would after
-- decoding the JSONB.
--
-- Verifies:
--   * detection by route_plan.rules (a table) routes to the RICH evaluator
--   * caller-id rule matching (prefix / equals), first match wins (document order)
--   * schedule rule matching via the TRUNK_NOW_OVERRIDE test seam (reuses the
--     SAME lib/schedule matcher as RICH RCF)
--   * the matched rule's endpoints deliver via the EXISTING multi-endpoint logic
--     (failover X-PBX-Dest in {} per attempt; parallel [sip_h_X-PBX-Dest=...])
--     including the trunk_auth_ips security skip of unauthorized endpoints
--   * NO rule matches -> REJECT (NO_ROUTE_DESTINATION), NOT a legacy fall-through
--   * a matched rule whose endpoints are ALL unauthorized -> REJECT (explicit
--     policy), NOT a legacy fall-through
--   * SIMPLE route_plan (no `rules`) and NIL route_plan still behave exactly as
--     before (pinned again here so the dual-mode split cannot regress them)

package.path = (debug.getinfo(1, "S").source:match("^@(.*/spec/)") or "./")
    :gsub("spec/$", "?.lua;") .. package.path

local helpers = require("helpers")
local fwmock = require("mocks.freeswitch_mock")
local sessmock = require("mocks.session_mock")
local dbmock = require("mocks.db_mock")

local INBOUND = helpers.scripts_dir .. "inbound_router.lua"
local contains = helpers.contains

-- Fixed UTC epochs (same instants schedule_spec / rcf_richplan_spec use):
local NOW_BIZ   = 1721048400  -- 2024-07-15 13:00Z = 09:00 EDT Monday (business hours)
local NOW_NIGHT = 1721008800  -- 2024-07-15 02:00Z = Sun 22:00 EDT  (after hours)

local AUTH_IPS = { "203.0.113.50", "203.0.113.51", "203.0.113.52" }

local function trunk_row(over)
    local r = { trunk_id = "42", customer_id = "7", traffic_grade = "standard" }
    for k, v in pairs(over or {}) do r[k] = v end
    return r
end

-- Run inbound_router with a DID that resolves to a SIP trunk.
--   opts.route_plan   : the parsed route plan table (set on the trunk row)
--   opts.endpoint_ips : authorized endpoint IPs (defaults to AUTH_IPS)
--   opts.caller       : inbound caller number (sip_from_user) for caller-id rules
--   opts.disposition  : seeds originate_disposition ("SUCCESS" = an endpoint answered)
--   opts.now          : TRUNK_NOW_OVERRIDE epoch (deterministic schedule rules)
local function run(opts)
    opts = opts or {}
    local fw = fwmock.new()
    local caller = opts.caller or "+15558675309"
    local vars = {
        destination_number = "+15551234567",
        caller_id_number = caller,
        caller_id_name = "Alice",
        sip_from_user = caller,
        sip_from_display = "",
        sip_received_ip = "203.0.113.9",
        sip_call_id = "callid-trunk@203.0.113.9",
        uuid = "uuid-trunk-rich",
    }
    if opts.disposition then vars.originate_disposition = opts.disposition end
    local session, rec = sessmock.new({ vars = vars })
    helpers.run_script(INBOUND, {
        env = {
            EXTERNAL_SIP_IP = "203.0.113.5",
            SBC_PROXY_IP = "10.0.0.1",
            SBC_PROXY_IP_FAILOVER = "10.0.0.2",
            TRUNK_NOW_OVERRIDE = opts.now and tostring(opts.now) or nil,
        },
        freeswitch = fw,
        session = session,
        modules = {
            db_client = dbmock.new_db({
                trunk_did = trunk_row({ route_plan = opts.route_plan }),
                endpoint_ips = opts.endpoint_ips or AUTH_IPS,
            }),
        },
    })
    return rec
end

-- ── caller-id rule matching, first match wins ──────────────────────────────
describe("Trunk RICH: caller-id rule match (prefix), first match wins", function()
    local plan = {
        rules = {
            { match = { caller_id = { prefix = "+1617" } },
              strategy = "failover",
              endpoints = { { to = "203.0.113.50" } } },
            { match = nil,
              strategy = "failover",
              endpoints = { { to = "203.0.113.51" } } },
        },
    }

    it("a +1617 caller hits rule 1 -> endpoint .50 via X-PBX-Dest", function()
        local rec = run({ caller = "+16175550001", route_plan = plan })
        assert.are.equal(1, #rec.bridges)
        assert.is_true(contains(rec.bridges[1], "sip_h_X-PBX-Dest=203.0.113.50"))
        assert.is_true(contains(rec.bridges[1], "sofia/external/15551234567@10.0.0.1:5060"))
        assert.is_true(contains(rec.bridges[1], "sip_enable_soa=false"))
        assert.is_true(contains(rec.bridges[1], "sip_session_timeout=1800"))
    end)

    it("a +1212 caller falls through to the catch-all rule 2 -> endpoint .51", function()
        local rec = run({ caller = "+12125550001", route_plan = plan })
        assert.are.equal(1, #rec.bridges)
        assert.is_true(contains(rec.bridges[1], "sip_h_X-PBX-Dest=203.0.113.51"))
    end)
end)

describe("Trunk RICH: caller-id equals matches an exact caller only", function()
    local plan = {
        rules = {
            { match = { caller_id = { equals = "+15558675309" } },
              endpoints = { { to = "203.0.113.50" } } },
            { match = nil, endpoints = { { to = "203.0.113.51" } } },
        },
    }
    it("exact caller -> rule 1", function()
        local rec = run({ caller = "+15558675309", route_plan = plan })
        assert.is_true(contains(rec.bridges[1], "sip_h_X-PBX-Dest=203.0.113.50"))
    end)
    it("different caller -> catch-all rule 2", function()
        local rec = run({ caller = "+15550000000", route_plan = plan })
        assert.is_true(contains(rec.bridges[1], "sip_h_X-PBX-Dest=203.0.113.51"))
    end)
end)

-- ── schedule rule matching via the TRUNK_NOW_OVERRIDE seam ──────────────────
describe("Trunk RICH: schedule rule selects endpoint by time-of-day", function()
    local plan = {
        rules = {
            { match = { schedule = { days = { "mon", "tue", "wed", "thu", "fri" },
                                     start = "09:00", ["end"] = "17:00",
                                     tz = "America/New_York" } },
              endpoints = { { to = "203.0.113.50" } } },            -- business hours
            { match = nil, endpoints = { { to = "203.0.113.51" } } }, -- after hours
        },
    }
    it("business hours (Mon 09:00 EDT) -> rule 1 endpoint .50", function()
        local rec = run({ route_plan = plan, now = NOW_BIZ })
        assert.is_true(contains(rec.bridges[1], "sip_h_X-PBX-Dest=203.0.113.50"))
    end)
    it("after hours (Sun 22:00 EDT) -> catch-all rule 2 endpoint .51", function()
        local rec = run({ route_plan = plan, now = NOW_NIGHT })
        assert.is_true(contains(rec.bridges[1], "sip_h_X-PBX-Dest=203.0.113.51"))
    end)
end)

-- ── matched rule delivers via the EXISTING multi-endpoint logic ─────────────
describe("Trunk RICH: matched rule FAILOVER rings its endpoints in order", function()
    local rec = run({
        route_plan = {
            rules = { { match = nil, strategy = "failover", timeout = 20,
                        endpoints = {
                            { to = "203.0.113.51" },
                            { to = "203.0.113.50", timeout = 15 },
                        } } },
        },
    })
    it("rings both endpoints in document order, each with its own X-PBX-Dest", function()
        assert.are.equal(2, #rec.bridges)
        assert.is_true(contains(rec.bridges[1], "sip_h_X-PBX-Dest=203.0.113.51"))
        assert.is_true(contains(rec.bridges[1], "call_timeout=20"))
        assert.is_true(contains(rec.bridges[2], "sip_h_X-PBX-Dest=203.0.113.50"))
        assert.is_true(contains(rec.bridges[2], "call_timeout=15"))
    end)
end)

describe("Trunk RICH: matched rule PARALLEL rings all endpoints at once", function()
    local rec = run({
        route_plan = {
            rules = { { match = nil, strategy = "parallel", timeout = 25,
                        endpoints = {
                            { to = "203.0.113.50" },
                            { to = "203.0.113.51", timeout = 18 },
                        } } },
        },
    })
    it("issues a single simring bridge, each leg carrying its [X-PBX-Dest]", function()
        assert.are.equal(1, #rec.bridges)
        local b = rec.bridges[1]
        assert.is_true(contains(b, "[sip_h_X-PBX-Dest=203.0.113.50]"))
        assert.is_true(contains(b, "[leg_timeout=18,sip_h_X-PBX-Dest=203.0.113.51]"))
        assert.is_true(contains(b, "call_timeout=25"))
        assert.is_true(contains(b, ","))
    end)
end)

describe("Trunk RICH: FAILOVER stops on the first endpoint that answers", function()
    local rec = run({
        disposition = "SUCCESS",
        route_plan = {
            rules = { { match = nil, strategy = "failover",
                        endpoints = { { to = "203.0.113.50" }, { to = "203.0.113.51" } } } },
        },
    })
    it("rings only the first endpoint", function()
        assert.are.equal(1, #rec.bridges)
        assert.is_true(contains(rec.bridges[1], "sip_h_X-PBX-Dest=203.0.113.50"))
    end)
end)

-- ── trunk_auth_ips security skip inside a matched rule ─────────────────────
describe("Trunk RICH: unauthorized endpoints in a matched rule are skipped", function()
    local rec = run({
        route_plan = {
            rules = { { match = nil, strategy = "failover",
                        endpoints = {
                            { to = "9.9.9.9" },        -- NOT in trunk_auth_ips
                            { to = "203.0.113.50" },   -- authorized
                        } } },
        },
    })
    it("rings only the authorized endpoint", function()
        assert.are.equal(1, #rec.bridges)
        assert.is_true(contains(rec.bridges[1], "sip_h_X-PBX-Dest=203.0.113.50"))
    end)
end)

-- ── REJECT semantics (no silent legacy fall-through) ───────────────────────
describe("Trunk RICH: NO rule matches -> REJECT, not legacy fall-through", function()
    local rec = run({
        caller = "+12125550001",
        route_plan = {
            rules = { { match = { caller_id = { equals = "+19999999999" } },
                        endpoints = { { to = "203.0.113.50" } } } },
        },
    })
    it("issues no bridge and hangs up NO_ROUTE_DESTINATION", function()
        assert.are.equal(0, #rec.bridges)
        assert.are.equal("NO_ROUTE_DESTINATION", rec.hangups[#rec.hangups])
    end)
    it("does NOT fall back to the legacy endpoint_ips[1] bridge", function()
        -- legacy would have set sip_h_X-PBX-Dest via set_var to endpoint_ips[1]
        -- AND issued a call_timeout=60 single bridge; neither happens.
        assert.are.equal(0, #rec.bridges)
    end)
end)

describe("Trunk RICH: matched rule with ALL-unauthorized endpoints -> REJECT", function()
    local rec = run({
        route_plan = {
            rules = { { match = nil, strategy = "failover",
                        endpoints = { { to = "9.9.9.9" }, { to = "8.8.8.8" } } } },
        },
    })
    it("rejects (NO_ROUTE_DESTINATION), does not fall to legacy", function()
        assert.are.equal(0, #rec.bridges)
        assert.are.equal("NO_ROUTE_DESTINATION", rec.hangups[#rec.hangups])
    end)
end)

-- ── SIMPLE + NIL must remain exactly as before under dual-mode ─────────────
describe("Trunk dual-mode: SIMPLE route_plan (no rules) unchanged", function()
    local rec = run({
        route_plan = {
            strategy = "failover", timeout = 20,
            endpoints = { { to = "203.0.113.51" }, { to = "203.0.113.50", timeout = 15 } },
        },
    })
    it("delivers multi-endpoint exactly as the SIMPLE path always did", function()
        assert.are.equal(2, #rec.bridges)
        assert.is_true(contains(rec.bridges[1], "sip_h_X-PBX-Dest=203.0.113.51"))
        assert.is_true(contains(rec.bridges[1], "call_timeout=20"))
        assert.is_true(contains(rec.bridges[2], "sip_h_X-PBX-Dest=203.0.113.50"))
        assert.is_true(contains(rec.bridges[2], "call_timeout=15"))
    end)
end)

describe("Trunk dual-mode: SIMPLE plan with no authorized endpoints fails safe to legacy", function()
    local rec = run({
        route_plan = {
            strategy = "failover", timeout = 20,
            endpoints = { { to = "9.9.9.9" }, { to = "8.8.8.8" } },
        },
    })
    it("falls back to the legacy single-endpoint bridge (endpoint_ips[1])", function()
        assert.are.equal(1, #rec.bridges)
        assert.is_true(contains(rec.bridges[1], "sofia/external/15551234567@10.0.0.1:5060"))
        assert.is_true(contains(rec.bridges[1], "call_timeout=60"))
        assert.are.equal("203.0.113.50", rec.set_map["sip_h_X-PBX-Dest"])
    end)
end)

describe("Trunk dual-mode: NIL route_plan still takes the legacy single-endpoint bridge", function()
    local rec = run({ route_plan = nil })
    it("issues exactly one legacy bridge to endpoint_ips[1]", function()
        assert.are.equal(1, #rec.bridges)
        assert.is_true(contains(rec.bridges[1], "sofia/external/15551234567@10.0.0.1:5060"))
        assert.is_true(contains(rec.bridges[1], "call_timeout=60"))
        assert.are.equal("203.0.113.50", rec.set_map["sip_h_X-PBX-Dest"])
        assert.are.equal("trunk", rec.set_map["product_type"])
    end)
end)
