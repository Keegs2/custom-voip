-- CHARACTERIZATION: handlers/rcf.lua RICH RCF routing_plan path
--
-- Drives the REAL inbound_router -> handlers/rcf dispatch with an rcf_numbers row
-- carrying a routing_plan (already-parsed Lua table — db_client is mock-only, so
-- the test supplies exactly what db_client.lookup_rcf hands back after decoding
-- the JSONB). Verifies rule evaluation, ring strategies, the carrier/SBC path
-- reuse, fallbacks, caller-ID setup, the schedule test seam — and, critically,
-- that a NIL routing_plan still takes the byte-for-byte legacy single-forward
-- path (the LIVE Granite call path must not regress).

package.path = (debug.getinfo(1, "S").source:match("^@(.*/spec/)") or "./")
    :gsub("spec/$", "?.lua;") .. package.path

local helpers = require("helpers")
local fwmock = require("mocks.freeswitch_mock")
local sessmock = require("mocks.session_mock")
local dbmock = require("mocks.db_mock")

local INBOUND = helpers.scripts_dir .. "inbound_router.lua"
local contains = helpers.contains

-- Fixed UTC epochs (see schedule_spec.lua):
local NOW_BIZ   = 1721048400  -- 2024-07-15 13:00Z = 09:00 EDT Monday (business hours)
local NOW_NIGHT = 1721008800  -- 2024-07-15 02:00Z = Sun 22:00 EDT  (after hours)

local function rcf_row(over)
    local r = {
        customer_id = "55", forward_to = "17775556666", traffic_grade = "standard",
        cpm_limit = "60", daily_limit = "500", pass_caller_id = "t",
        ring_timeout = "30", max_channels = "0", name = "Main Office",
    }
    for k, v in pairs(over or {}) do r[k] = v end
    return r
end

-- Run inbound_router with an RCF DID carrying routing_plan.
--   opts.routing_plan : parsed plan table (nil => legacy path)
--   opts.caller       : caller_id_number (default +1617 area)
--   opts.disposition  : seeds originate_disposition ("SUCCESS" = a leg answered)
--   opts.now          : RCF_NOW_OVERRIDE epoch (deterministic schedule rules)
--   opts.test_mode    : sets TEST_MODE=true
--   opts.rcf_over     : extra rcf row overrides (e.g. pass_caller_id)
local function run(opts)
    opts = opts or {}
    local fw = fwmock.new()
    local vars = {
        destination_number = "+16175551234",
        caller_id_number = opts.caller or "+16175550001",
        caller_id_name = "Alice",
        sip_from_user = "", sip_from_display = "",
        sip_received_ip = "67.231.2.12",
        sip_call_id = "callid-rich@67.231.2.12",
        uuid = "uuid-rich",
    }
    if opts.disposition then vars.originate_disposition = opts.disposition end
    local session, rec = sessmock.new({ vars = vars })
    local over = opts.rcf_over or {}
    over.routing_plan = opts.routing_plan
    helpers.run_script(INBOUND, {
        env = {
            EXTERNAL_SIP_IP = "203.0.113.5",
            SBC_PROXY_IP = "10.0.0.1",
            SBC_PROXY_IP_FAILOVER = "10.0.0.2",
            RCF_NOW_OVERRIDE = opts.now and tostring(opts.now) or nil,
            TEST_MODE = opts.test_mode and "true" or nil,
        },
        freeswitch = fw,
        session = session,
        modules = { db_client = dbmock.new_db({ rcf = rcf_row(over) }) },
    })
    return rec
end

local function recorded_record(rec)
    for _, e in ipairs(rec.executes) do
        if e.app == "record" then return e.data end
    end
    return nil
end

-- ── REGRESSION: NIL routing_plan = legacy path, untouched ──────────────────
describe("RICH guard: NIL routing_plan keeps the legacy single-forward path", function()
    local rec = run({ routing_plan = nil })

    it("runs the legacy 4-attempt SBC x carrier failover to forward_to", function()
        assert.are.equal(4, #rec.bridges)
        assert.is_true(contains(rec.bridges[1], "sofia/external/17775556666@10.0.0.1:5060"))
        assert.is_true(contains(rec.bridges[1], "sip_h_X-Carrier=primary"))
        assert.is_true(contains(rec.bridges[2], "@10.0.0.2:5060"))
        assert.is_true(contains(rec.bridges[3], "sip_h_X-Carrier=secondary"))
        assert.is_true(contains(rec.bridges[4], "@10.0.0.2:5060"))
        assert.is_true(contains(rec.bridges[1], "progress_timeout=10"))
    end)
    it("ends in NORMAL_TEMPORARY_FAILURE (503) when all attempts fail", function()
        assert.are.equal("NORMAL_TEMPORARY_FAILURE", rec.hangups[#rec.hangups])
    end)
end)

-- ── single-leg rule = forward (full carrier/SBC failover, legacy semantics) ─
describe("RICH single-leg rule reuses the full 4-attempt SBC x carrier failover", function()
    local rec = run({
        routing_plan = {
            rules = { { match = nil, ring = { legs = { { to = "+15551234567" } } } } },
            fallback = { type = "hangup" },
        },
    })

    it("runs all 4 SBC x carrier attempts in the hard-won order", function()
        assert.are.equal(4, #rec.bridges)
        assert.is_true(contains(rec.bridges[1], "sofia/external/15551234567@10.0.0.1:5060"))
        assert.is_true(contains(rec.bridges[1], "sip_h_X-Carrier=primary"))
        assert.is_true(contains(rec.bridges[2], "sofia/external/15551234567@10.0.0.2:5060"))
        assert.is_true(contains(rec.bridges[3], "sip_h_X-Carrier=secondary"))
        assert.is_true(contains(rec.bridges[4], "@10.0.0.2:5060"))
    end)
    it("uses progress_timeout (PDD bound), never originate_timeout", function()
        for _, b in ipairs(rec.bridges) do
            assert.is_true(contains(b, "progress_timeout=10"))
            assert.is_false(contains(b, "originate_timeout"))
            assert.is_true(contains(b, "sip_session_timeout=1800"))
        end
    end)
    it("a connected attempt stops the loop", function()
        local rec2 = run({
            disposition = "SUCCESS",
            routing_plan = {
                rules = { { match = nil, ring = { legs = { { to = "+15551234567" } } } } },
                fallback = { type = "hangup" },
            },
        })
        assert.are.equal(1, #rec2.bridges)
        assert.are.equal(0, #rec2.hangups)
    end)
end)

-- ── sequential ring group (FMFM: one bridge per leg, advance on no-answer) ──
describe("RICH sequential ring group rings legs in order (FMFM)", function()
    local rec = run({
        routing_plan = {
            rules = { { match = nil, ring = {
                strategy = "sequential", ring_timeout = 20,
                legs = { { to = "1001" }, { to = "+15551234567", timeout = 15 } },
            } } },
            fallback = { type = "voicemail" },
        },
    })

    it("rings exactly 2 legs (NOT 4x carrier failover per leg)", function()
        assert.are.equal(2, #rec.bridges)
    end)
    it("leg 1 is the local extension via user/ at the plan ring_timeout", function()
        assert.is_true(contains(rec.bridges[1], "user/1001@voiceplatform.local"))
        assert.is_true(contains(rec.bridges[1], "call_timeout=20"))
    end)
    it("leg 2 is the PSTN dest via the carrier (X-Carrier, per-leg timeout)", function()
        assert.is_true(contains(rec.bridges[2], "sofia/external/15551234567@10.0.0.1:5060"))
        assert.is_true(contains(rec.bridges[2], "sip_h_X-Carrier=primary"))
        assert.is_true(contains(rec.bridges[2], "call_timeout=15"))
        assert.is_true(contains(rec.bridges[2], "sip_session_timeout=1800"))
    end)
    it("falls back to voicemail after all legs fail", function()
        local vm = recorded_record(rec)
        assert.is_not_nil(vm)
        assert.is_true(contains(vm, "/var/lib/freeswitch/voicemail/rcf/6175551234/"))
        assert.is_true(contains(vm, "300 200 3"))
    end)
    it("arms carrier caller-ID (From=DID, Diversion, RPID) for the PSTN leg", function()
        assert.are.equal("6175551234", rec.set_map["outbound_caller_id_number"])
        assert.is_true(contains(rec.set_map["sip_h_Diversion"], "6175551234@203.0.113.5"))
        assert.are.equal("+16175550001", rec.set_map["sip_h_X-Original-CID"])
        assert.is_true(contains(rec.set_map["sip_h_Remote-Party-ID"], "+16175550001"))
        assert.are.equal("6175550001", rec.set_map["effective_caller_id_number"])
    end)
end)

describe("RICH sequential ring group: a leg ANSWERS -> stop, no fallback", function()
    local rec = run({
        disposition = "SUCCESS",
        routing_plan = {
            rules = { { match = nil, ring = {
                strategy = "sequential", ring_timeout = 30,
                legs = { { to = "1001" }, { to = "+15551234567" } },
            } } },
            fallback = { type = "voicemail" },
        },
    })
    it("rings only the first leg and records no voicemail", function()
        assert.are.equal(1, #rec.bridges)
        assert.is_true(contains(rec.bridges[1], "user/1001@"))
        assert.is_nil(recorded_record(rec))
    end)
end)

-- ── parallel ring group (simring) ─────────────────────────────────────────
describe("RICH parallel ring group rings all legs in ONE comma-joined bridge", function()
    local rec = run({
        routing_plan = {
            rules = { { match = nil, ring = {
                strategy = "parallel", ring_timeout = 25,
                legs = { { to = "1002" }, { to = "17745551212" } },
            } } },
            fallback = { type = "hangup" },
        },
    })
    it("issues exactly one (simring) bridge", function()
        assert.are.equal(1, #rec.bridges)
        local b = rec.bridges[1]
        assert.is_true(contains(b, "call_timeout=25"))
        assert.is_true(contains(b, "user/1002@voiceplatform.local"))
        assert.is_true(contains(b, "sofia/external/17745551212@10.0.0.1:5060"))
        assert.is_true(contains(b, "sip_h_X-Carrier=primary"))
        assert.is_true(contains(b, ","))  -- comma-joined simring
    end)
end)

-- ── caller-id rule matching + document-order precedence ────────────────────
describe("RICH caller-id match: first matching rule wins (document order)", function()
    local plan = {
        rules = {
            { match = { caller_id = { prefix = "+1617" } },
              ring = { legs = { { to = "+18001110000" } } } },
            { match = nil, ring = { legs = { { to = "+18002220000" } } } },
        },
        fallback = { type = "hangup" },
    }
    it("a +1617 caller hits rule 1", function()
        local rec = run({ caller = "+16175550001", routing_plan = plan })
        assert.is_true(contains(rec.bridges[1], "sofia/external/18001110000@"))
    end)
    it("a +1212 caller falls through to the catch-all rule 2", function()
        local rec = run({ caller = "+12125550001", routing_plan = plan })
        assert.is_true(contains(rec.bridges[1], "sofia/external/18002220000@"))
    end)
    it("equals matches an exact caller only", function()
        local p = {
            rules = {
                { match = { caller_id = { equals = "+16175550001" } },
                  ring = { legs = { { to = "+18003330000" } } } },
                { match = nil, ring = { legs = { { to = "+18004440000" } } } },
            },
            fallback = { type = "hangup" },
        }
        assert.is_true(contains(run({ caller = "+16175550001", routing_plan = p }).bridges[1],
            "18003330000"))
        assert.is_true(contains(run({ caller = "+16175559999", routing_plan = p }).bridges[1],
            "18004440000"))
    end)
end)

-- ── schedule rule matching via the RCF_NOW_OVERRIDE test seam ───────────────
describe("RICH schedule match selects the right rule by time-of-day", function()
    local plan = {
        rules = {
            { match = { schedule = { days = { "mon", "tue", "wed", "thu", "fri" },
                                     start = "09:00", ["end"] = "17:00",
                                     tz = "America/New_York" } },
              ring = { legs = { { to = "+18005550100" } } } },          -- business hours
            { match = nil, ring = { legs = { { to = "+18005550200" } } } }, -- after hours
        },
        fallback = { type = "hangup" },
    }
    it("business hours (Mon 09:00 EDT) -> rule 1", function()
        local rec = run({ routing_plan = plan, now = NOW_BIZ })
        assert.is_true(contains(rec.bridges[1], "sofia/external/18005550100@"))
    end)
    it("after hours (Sun 22:00 EDT) -> catch-all rule 2", function()
        local rec = run({ routing_plan = plan, now = NOW_NIGHT })
        assert.is_true(contains(rec.bridges[1], "sofia/external/18005550200@"))
    end)
end)

-- ── no rule matches -> plan fallback ───────────────────────────────────────
describe("RICH no rule matches -> fallback runs", function()
    it("forward fallback bridges the forward target", function()
        local rec = run({
            caller = "+12125550001",
            routing_plan = {
                rules = { { match = { caller_id = { equals = "+19999999999" } },
                            ring = { legs = { { to = "1001" } } } } },
                fallback = { type = "forward", to = "+18007770000" },
            },
        })
        -- No rule matched -> straight to forward fallback (carrier failover).
        assert.is_true(contains(rec.bridges[1], "sofia/external/18007770000@10.0.0.1:5060"))
        assert.is_nil(recorded_record(rec))
    end)
    it("hangup fallback hangs up NO_ANSWER, no bridge", function()
        local rec = run({
            caller = "+12125550001",
            routing_plan = {
                rules = { { match = { caller_id = { equals = "+19999999999" } },
                            ring = { legs = { { to = "1001" } } } } },
                fallback = { type = "hangup" },
            },
        })
        assert.are.equal(0, #rec.bridges)
        assert.are.equal("NO_ANSWER", rec.hangups[1])
    end)
end)

-- ── fallback variants after a matched ring fails ───────────────────────────
describe("RICH fallback after the matched ring fails", function()
    it("fallback=hangup -> NO_ANSWER, no voicemail", function()
        local rec = run({
            routing_plan = {
                rules = { { match = nil, ring = { legs = { { to = "1001" } } } } },
                fallback = { type = "hangup" },
            },
        })
        assert.is_nil(recorded_record(rec))
        assert.are.equal("NO_ANSWER", rec.hangups[#rec.hangups])
    end)
    it("fallback=forward -> ring (ext) then bridge the forward target", function()
        local rec = run({
            routing_plan = {
                rules = { { match = nil, ring = { legs = { { to = "1001" } } } } },
                fallback = { type = "forward", to = "+18008880000" },
            },
        })
        assert.are.equal(5, #rec.bridges)  -- 1 ext leg + 4-attempt carrier forward
        assert.is_true(contains(rec.bridges[1], "user/1001@"))
        assert.is_true(contains(rec.bridges[2], "sofia/external/18008880000@10.0.0.1:5060"))
    end)
    it("no fallback object -> graceful 503", function()
        local rec = run({
            routing_plan = {
                rules = { { match = nil, ring = { legs = { { to = "1001" } } } } },
            },
        })
        assert.are.equal("NORMAL_TEMPORARY_FAILURE", rec.hangups[#rec.hangups])
    end)
end)

-- ── all-extension ring does NOT arm carrier identity (RPID) ────────────────
describe("RICH all-extension ring does not arm carrier Remote-Party-ID", function()
    local rec = run({
        routing_plan = {
            rules = { { match = nil, ring = {
                strategy = "sequential", legs = { { to = "1001" }, { to = "1002" } },
            } } },
            fallback = { type = "hangup" },
        },
    })
    it("RPID and origination export are not set for a purely-internal ring", function()
        assert.is_nil(rec.set_map["sip_h_Remote-Party-ID"])
        local exp = table.concat(rec.exports, "\n")
        assert.is_false(contains(exp, "origination_caller_id_number"))
    end)
    it("but base CID (Diversion) is still set, like the legacy path", function()
        assert.is_not_nil(rec.set_map["sip_h_Diversion"])
    end)
end)

-- ── test mode never touches the carrier ────────────────────────────────────
describe("RICH test mode short-circuits any PSTN-bound plan", function()
    local rec = run({
        test_mode = true,
        routing_plan = {
            rules = { { match = nil, ring = { legs = { { to = "+15551234567" } } } } },
            fallback = { type = "hangup" },
        },
    })
    it("plays a tone and issues no carrier bridge", function()
        assert.are.equal(0, #rec.bridges)
        assert.are.equal(1, rec.answered)
        local played = false
        for _, e in ipairs(rec.executes) do
            if e.app == "playback" and contains(e.data, "tone_stream") then played = true end
        end
        assert.is_true(played)
    end)
end)

-- ── pass_caller_id=false override ──────────────────────────────────────────
describe("RICH pass_caller_id=false presents the RCF DID to the callee", function()
    local rec = run({
        rcf_over = { pass_caller_id = "f" },
        routing_plan = {
            rules = { { match = nil, ring = { legs = { { to = "+15551234567" } } } } },
            fallback = { type = "hangup" },
        },
    })
    it("effective + X-Original-CID become the RCF DID", function()
        assert.are.equal("6175551234", rec.set_map["effective_caller_id_number"])
        assert.are.equal("+16175551234", rec.set_map["sip_h_X-Original-CID"])
    end)
end)

-- ── liberal ring shapes (backend _first_leg_dest tolerance) ────────────────
describe("RICH liberal ring shapes", function()
    it("ring as a bare string -> single forward", function()
        local rec = run({
            routing_plan = {
                rules = { { match = nil, ring = "+15551234567" } },
                fallback = { type = "hangup" },
            },
        })
        assert.are.equal(4, #rec.bridges)  -- single forward = full failover
        assert.is_true(contains(rec.bridges[1], "sofia/external/15551234567@"))
    end)
    it("ring as a list of strings -> ring group", function()
        local rec = run({
            routing_plan = {
                rules = { { match = nil, ring = { "1001", "1002" } } },
                fallback = { type = "hangup" },
            },
        })
        assert.are.equal(2, #rec.bridges)
        assert.is_true(contains(rec.bridges[1], "user/1001@"))
        assert.is_true(contains(rec.bridges[2], "user/1002@"))
    end)
end)
