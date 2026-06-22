-- CHARACTERIZATION: encrypted Visual Voicemail (Phase 1 telephony)
--
-- Exercises the REAL production scripts through the sandbox:
--   1. db_client.lookup_voicemail_did resolution → the dispatcher routes a
--      dedicated-DID mailbox to handlers/voicemail.lua, which records to tmpfs
--      (/dev/shm) via lib/vm_record (encrypted-deposit path — the API encrypts
--      on write; FS never inserts a row).
--   2. The voicemail lookup is LAST in the cascade — it never shadows a revenue
--      product (rcf wins when both match).
--   3. lib/vm_record parameterization: a bound mailbox on the rcf no-answer
--      fallback records to tmpfs; NO bound mailbox keeps the LEGACY spool deposit
--      byte-for-byte (same /var/lib/freeswitch/voicemail/rcf/<did10> path +
--      "300 200 3" record args).
--
-- API_HOST is unset in the sandbox env, so lib/vm_notify and the /resolve fetch
-- both no-op cleanly (no network) — the deposit still records + shreds.

package.path = (debug.getinfo(1, "S").source:match("^@(.*/spec/)") or "./")
    :gsub("spec/$", "?.lua;") .. package.path

local helpers = require("helpers")
local fwmock = require("mocks.freeswitch_mock")
local sessmock = require("mocks.session_mock")
local dbmock = require("mocks.db_mock")

local INBOUND = helpers.scripts_dir .. "inbound_router.lua"
local contains = helpers.contains

local function recorded_record(rec)
    for _, e in ipairs(rec.executes) do
        if e.app == "record" then return e.data end
    end
    return nil
end

-- Run the inbound router with a configurable db. uuid is fixed so the tmpfs
-- filename is deterministic.
local function run(db_cfg, vars_over)
    local fw = fwmock.new()
    local vars = {
        destination_number = "+13105559999",
        caller_id_number = "+15558675309",
        caller_id_name = "Alice",
        sip_from_user = "", sip_from_display = "",
        sip_received_ip = "67.231.2.12",
        sip_call_id = "callid-vm@67.231.2.12",
        uuid = "uuid-vm",
    }
    for k, v in pairs(vars_over or {}) do vars[k] = v end
    local session, rec = sessmock.new({ vars = vars })
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

-- ── 1. dedicated-DID mailbox → standalone voicemail handler → tmpfs deposit ──
describe("Voicemail dedicated-DID: dispatcher resolves + records to tmpfs", function()
    local rec = run({ voicemail = { mailbox_id = "42", customer_id = "7", mode = "direct" } })

    it("sets product_type=voicemail and the mailbox's customer id", function()
        assert.are.equal("voicemail", rec.set_map["product_type"])
        assert.are.equal("7", rec.set_map["customer_id"])
    end)

    it("marks the call lua_routed so the dialplan fallback won't 404", function()
        assert.are.equal("true", rec.set_map["lua_routed"])
    end)

    it("answers and records to tmpfs (/dev/shm), never to persistent disk", function()
        assert.is_true(rec.answered >= 1)
        local vm = recorded_record(rec)
        assert.is_not_nil(vm)
        assert.is_true(contains(vm, "/dev/shm/vm/uuid-vm.wav"))
        assert.is_true(contains(vm, "300 200 3"))
        -- Plaintext must never touch the shared spool on the product path.
        assert.is_false(contains(vm, "/var/lib/freeswitch/voicemail"))
        assert.is_false(contains(vm, "/media/spool"))
    end)
end)

-- ── 2. cascade priority: voicemail is LAST, never shadows a revenue product ──
describe("Voicemail lookup is last in the cascade (rcf still wins)", function()
    local rec = run({
        rcf = {
            customer_id = "55", forward_to = "17775556666",
            traffic_grade = "standard", cpm_limit = "60", daily_limit = "500",
            pass_caller_id = "t", ring_timeout = "30", max_channels = "0",
            name = "Main Office",
        },
        voicemail = { mailbox_id = "42", customer_id = "7", mode = "direct" },
    })

    it("routes as rcf, not voicemail", function()
        assert.are.equal("rcf", rec.set_map["product_type"])
        assert.are.equal("55", rec.set_map["customer_id"])
    end)

    it("does not record a voicemail (it bridged the RCF forward)", function()
        assert.is_nil(recorded_record(rec))
        assert.is_true(#rec.bridges >= 1)
    end)
end)

-- ── 3. attached model on the rcf no-answer fallback: tmpfs vs legacy spool ───
local function rcf_vm_row()
    return {
        customer_id = "55", forward_to = "17775556666",
        traffic_grade = "standard", cpm_limit = "60", daily_limit = "500",
        pass_caller_id = "t", ring_timeout = "30", max_channels = "0", name = "Main Office",
        routing_plan = {
            rules = { { match = nil, ring = {
                strategy = "sequential", ring_timeout = 20,
                legs = { { to = "1001" }, { to = "+15551234567", timeout = 15 } },
            } } },
            fallback = { type = "voicemail" },
        },
    }
end

describe("Attached mailbox on rcf fallback records ENCRYPTED to tmpfs", function()
    -- DID +16175551234 (did10 6175551234), all legs fail -> fallback=voicemail.
    local rec = run(
        { rcf = rcf_vm_row(), attached_mailbox = { mailbox_id = "99", customer_id = "55" } },
        { destination_number = "+16175551234" })

    it("records to tmpfs (/dev/shm), not the legacy spool", function()
        local vm = recorded_record(rec)
        assert.is_not_nil(vm)
        assert.is_true(contains(vm, "/dev/shm/vm/uuid-vm.wav"))
        assert.is_false(contains(vm, "/var/lib/freeswitch/voicemail"))
    end)
end)

describe("NO bound mailbox on rcf fallback keeps the LEGACY spool deposit", function()
    -- Same plan, attached_mailbox unset -> byte-for-byte legacy spool path.
    local rec = run(
        { rcf = rcf_vm_row() },
        { destination_number = "+16175551234" })

    it("records to the legacy /var/lib/freeswitch/voicemail/rcf/<did10> tree", function()
        local vm = recorded_record(rec)
        assert.is_not_nil(vm)
        assert.is_true(contains(vm, "/var/lib/freeswitch/voicemail/rcf/6175551234/"))
        assert.is_true(contains(vm, "300 200 3"))
        assert.is_false(contains(vm, "/dev/shm"))
    end)
end)
