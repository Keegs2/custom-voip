-- CHARACTERIZATION: handlers/trunk.lua SIP-trunk inbound multi-endpoint delivery
--
-- Exercises the inbound TRUNK path (DID -> customer PBX) through the real
-- inbound_router -> handlers/trunk dispatch. The db_client mock returns the trunk
-- row + endpoint IPs directly (db_client is mock-only in the harness), so a test
-- supplies route_plan as an already-parsed Lua table — exactly what
-- db_client.lookup_trunk_did hands back after decoding the JSONB.
--
-- Verifies:
--   * NIL route_plan -> LEGACY single-endpoint bridge (X-PBX-Dest via set_var to
--     endpoint_ips[1]), byte-for-byte the prior behavior
--   * failover rings endpoints in PLAN order, each with its OWN X-PBX-Dest in the
--     dial-string {} block, advancing on no-answer, stopping on first answer
--   * parallel rings all endpoints in ONE comma-joined dial string, each with its
--     own [sip_h_X-PBX-Dest=...] per-channel block
--   * unauthorized plan endpoints (not in trunk_auth_ips) are skipped
--   * a plan that resolves to NO authorized endpoints fails safe to legacy
--   * an "ip:port" endpoint yields a BARE-IP X-PBX-Dest (Kamailio forces :5060)

package.path = (debug.getinfo(1, "S").source:match("^@(.*/spec/)") or "./")
    :gsub("spec/$", "?.lua;") .. package.path

local helpers = require("helpers")
local fwmock = require("mocks.freeswitch_mock")
local sessmock = require("mocks.session_mock")
local dbmock = require("mocks.db_mock")

local INBOUND = helpers.scripts_dir .. "inbound_router.lua"
local contains = helpers.contains

-- Default authorized endpoint IPs for the trunk (trunk_auth_ips).
local AUTH_IPS = { "203.0.113.50", "203.0.113.51" }

local function trunk_row(over)
    local r = { trunk_id = "42", customer_id = "7", traffic_grade = "standard" }
    for k, v in pairs(over or {}) do r[k] = v end
    return r
end

-- Run inbound_router with a DID that resolves to a SIP trunk.
--   opts.route_plan   : the parsed route plan table (set on the trunk row)
--   opts.endpoint_ips : authorized endpoint IPs (defaults to AUTH_IPS)
--   opts.disposition  : seeds originate_disposition ("SUCCESS" = an endpoint answered)
local function run(opts)
    opts = opts or {}
    local fw = fwmock.new()
    local vars = {
        destination_number = "+15551234567",
        caller_id_number = "+15558675309",
        caller_id_name = "Alice",
        sip_from_user = "+15558675309",
        sip_from_display = "",
        sip_received_ip = "203.0.113.9",
        sip_call_id = "callid-trunk@203.0.113.9",
        uuid = "uuid-trunk",
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
            db_client = dbmock.new_db({
                trunk_did = trunk_row({ route_plan = opts.route_plan }),
                endpoint_ips = opts.endpoint_ips or AUTH_IPS,
            }),
        },
    })
    return rec
end

describe("Trunk inbound: NIL route_plan -> legacy single-endpoint bridge", function()
    local rec = run({ route_plan = nil })

    it("sets product_type=trunk and the customer id", function()
        assert.are.equal("trunk", rec.set_map["product_type"])
        assert.are.equal("7", rec.set_map["customer_id"])
    end)

    it("issues exactly one bridge to the FIRST authorized endpoint via the SBC", function()
        assert.are.equal(1, #rec.bridges)
        local b = rec.bridges[1]
        assert.is_true(contains(b, "sofia/external/15551234567@10.0.0.1:5060"))
        assert.is_true(contains(b, "sip_enable_soa=false"))
        assert.is_true(contains(b, "call_timeout=60"))
        assert.is_true(contains(b, "sip_session_timeout=1800"))
    end)

    it("sets X-PBX-Dest via set_var to endpoint_ips[1] (legacy mechanism)", function()
        assert.are.equal("203.0.113.50", rec.set_map["sip_h_X-PBX-Dest"])
    end)

    it("anchors media (proxy_media) and passes the original caller through", function()
        assert.are.equal("true", rec.set_map["proxy_media"])
        assert.are.equal("+15558675309", rec.set_map["effective_caller_id_number"])
        assert.are.equal("true", rec.set_map["lua_routed"])
    end)
end)

describe("Trunk inbound: route_plan FAILOVER rings endpoints in plan order", function()
    -- No disposition => every endpoint 'fails' => both ring, in PLAN order
    -- (note: plan lists .51 BEFORE .50 — the reverse of endpoint_ips order).
    local rec = run({
        route_plan = {
            strategy = "failover",
            timeout = 20,
            endpoints = {
                { to = "203.0.113.51" },                 -- plan default timeout 20
                { to = "203.0.113.50", timeout = 15 },   -- per-endpoint timeout 15
            },
        },
    })

    it("rings both endpoints, in document order", function()
        assert.are.equal(2, #rec.bridges)
    end)

    it("attempt 1 carries its OWN X-PBX-Dest in the dial-string {} at plan timeout", function()
        local b = rec.bridges[1]
        assert.is_true(contains(b, "sip_h_X-PBX-Dest=203.0.113.51"))
        assert.is_true(contains(b, "call_timeout=20"))
        assert.is_true(contains(b, "sofia/external/15551234567@10.0.0.1:5060"))
        assert.is_true(contains(b, "sip_enable_soa=false"))
        assert.is_true(contains(b, "sip_session_timeout=1800"))
    end)

    it("attempt 2 carries the SECOND endpoint's X-PBX-Dest at its own timeout", function()
        local b = rec.bridges[2]
        assert.is_true(contains(b, "sip_h_X-PBX-Dest=203.0.113.50"))
        assert.is_true(contains(b, "call_timeout=15"))
    end)
end)

describe("Trunk inbound: FAILOVER stops on the first endpoint that answers", function()
    local rec = run({
        disposition = "SUCCESS",
        route_plan = {
            strategy = "failover",
            timeout = 30,
            endpoints = { { to = "203.0.113.50" }, { to = "203.0.113.51" } },
        },
    })

    it("rings only the first endpoint", function()
        assert.are.equal(1, #rec.bridges)
        assert.is_true(contains(rec.bridges[1], "sip_h_X-PBX-Dest=203.0.113.50"))
    end)
end)

describe("Trunk inbound: route_plan PARALLEL rings all endpoints at once", function()
    local rec = run({
        route_plan = {
            strategy = "parallel",
            timeout = 25,
            endpoints = {
                { to = "203.0.113.50" },
                { to = "203.0.113.51", timeout = 18 },
            },
        },
    })

    it("issues a single simring bridge", function()
        assert.are.equal(1, #rec.bridges)
    end)

    it("each endpoint carries its own [sip_h_X-PBX-Dest=...] per-channel block", function()
        local b = rec.bridges[1]
        assert.is_true(contains(b, "[sip_h_X-PBX-Dest=203.0.113.50]"))
        assert.is_true(contains(b, "[leg_timeout=18,sip_h_X-PBX-Dest=203.0.113.51]"))
        assert.is_true(contains(b, "sofia/external/15551234567@10.0.0.1:5060"))
        assert.is_true(contains(b, "call_timeout=25"))
        assert.is_true(contains(b, "sip_enable_soa=false"))
        -- comma-separated simring, both legs to the same SBC
        assert.is_true(contains(b, ","))
    end)
end)

describe("Trunk inbound: unauthorized plan endpoints are skipped", function()
    local rec = run({
        route_plan = {
            strategy = "failover",
            timeout = 20,
            endpoints = {
                { to = "9.9.9.9" },          -- NOT in trunk_auth_ips -> skipped
                { to = "203.0.113.50" },     -- authorized
            },
        },
    })

    it("rings only the authorized endpoint", function()
        assert.are.equal(1, #rec.bridges)
        assert.is_true(contains(rec.bridges[1], "sip_h_X-PBX-Dest=203.0.113.50"))
    end)
end)

describe("Trunk inbound: plan with NO authorized endpoints fails safe to legacy", function()
    local rec = run({
        route_plan = {
            strategy = "failover",
            timeout = 20,
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

describe("Trunk inbound: an ip:port endpoint yields a BARE-IP X-PBX-Dest", function()
    -- Kamailio's X-PBX-Dest handler HARD-CODES :5060, so the port is dropped.
    local rec = run({
        route_plan = {
            strategy = "failover",
            timeout = 20,
            endpoints = { { to = "203.0.113.50:5070" } },
        },
    })

    it("strips the port from X-PBX-Dest", function()
        assert.are.equal(1, #rec.bridges)
        assert.is_true(contains(rec.bridges[1], "sip_h_X-PBX-Dest=203.0.113.50]")
            or contains(rec.bridges[1], "sip_h_X-PBX-Dest=203.0.113.50,"))
        assert.is_false(contains(rec.bridges[1], "203.0.113.50:5070"))
    end)
end)
