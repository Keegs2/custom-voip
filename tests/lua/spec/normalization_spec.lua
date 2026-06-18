-- CHARACTERIZATION: E.164 normalization + to_10digit
--
-- These tests load the REAL helper functions out of the production scripts
-- (inbound_router.lua, trunk_outbound.lua) via helpers.extract(), which loads
-- the script source truncated immediately before the routing logic and returns
-- the named local functions. The function bodies are byte-for-byte the shipped
-- code — this is a regression baseline of CURRENT behavior, NOT a re-implementation.
--
-- If a later phase changes normalize_did / to_10digit / normalize_destination,
-- these assertions break, forcing a conscious decision.

package.path = (debug.getinfo(1, "S").source:match("^@(.*/spec/)") or "./")
    :gsub("spec/$", "?.lua;") .. package.path

local helpers = require("helpers")
local fwmock = require("mocks.freeswitch_mock")
local sessmock = require("mocks.session_mock")
local dbmock = require("mocks.db_mock")

local INBOUND = helpers.scripts_dir .. "inbound_router.lua"
local TRUNK = helpers.scripts_dir .. "trunk_outbound.lua"

-- Build a minimal opts so the truncated head runs without early-returning.
local function inbound_opts()
    local fw = fwmock.new()
    local session = sessmock.new({ vars = { destination_number = "+15551234567", uuid = "t" } })
    return {
        env = { EXTERNAL_SIP_IP = "203.0.113.5", SBC_PROXY_IP = "10.0.0.1" },
        freeswitch = fw,
        session = session,
        modules = { db_client = dbmock.new_db({}) },
    }
end

local function trunk_opts()
    local fw = fwmock.new()
    local session = sessmock.new({ vars = {
        destination_number = "5551234567", trunk_id = "5", customer_id = "7", uuid = "t",
    } })
    return {
        env = { EXTERNAL_SIP_IP = "203.0.113.5", SBC_PROXY_IP = "10.0.0.1" },
        freeswitch = fw,
        session = session,
        modules = { db_client = dbmock.new_db({}) },
    }
end

describe("inbound_router.lua E.164 helpers (characterization)", function()
    local fns = helpers.extract(
        INBOUND,
        "local normalized_did = normalize_did(did)",
        { "normalize_did", "to_10digit" },
        inbound_opts()
    )

    it("exposes the real local helpers", function()
        assert.is_true(type(fns.normalize_did) == "function")
        assert.is_true(type(fns.to_10digit) == "function")
    end)

    it("normalize_did: table of inputs -> exact current outputs", function()
        local cases = {
            { "+16175551234", "+16175551234" },   -- already E.164, kept as-is
            { "6175551234",   "+16175551234" },   -- 10-digit US -> +1
            { "16175551234",  "+16175551234" },   -- 11-digit leading 1 -> +
            { "1-617-555-1234", "+16175551234" }, -- punctuation stripped
            { "(617) 555-1234", "+16175551234" },
            { "+1 (617) 555-1234", "+16175551234" },
            { "+15558675309", "+15558675309" },
            { "15558675309",  "+15558675309" },
            { "442079460991", "+442079460991" },  -- 12 digits: bare "+" prefix
            { "+442079460991", "+442079460991" },
            { "917",          "+917" },           -- short -> "+" prefix
            { "abc",          "+" },              -- garbage -> "+"
            { "",             "+" },              -- empty -> "+"
        }
        for _, c in ipairs(cases) do
            assert.are.equal(c[2], fns.normalize_did(c[1]))
        end
    end)

    it("to_10digit: table of inputs -> exact current outputs", function()
        local cases = {
            { "+16175551234", "6175551234" },
            { "6175551234",   "6175551234" },
            { "16175551234",  "6175551234" },
            { "+15558675309", "5558675309" },
            { "12025550173",  "2025550173" },
            { "2025550173",   "2025550173" },
            { "+442079460991", "442079460991" },  -- 12 digits: passthrough
            { "917",          "917" },            -- non-10/11: passthrough digits
            { "+",            "" },                -- no digits -> empty
            { "abc",          "" },
        }
        for _, c in ipairs(cases) do
            assert.are.equal(c[2], fns.to_10digit(c[1]))
        end
    end)
end)

describe("trunk_outbound.lua E.164 helpers (characterization)", function()
    local fns = helpers.extract(
        TRUNK,
        "local normalized_dest = normalize_destination(destination)",
        { "normalize_destination", "to_10digit", "normalize_did" },
        trunk_opts()
    )

    it("normalize_destination: table of inputs -> exact current outputs", function()
        local cases = {
            { "5551234567",     "+15551234567" },
            { "+15551234567",   "+15551234567" },
            { "15551234567",    "+15551234567" },
            { "01144123456789", "+44123456789" },  -- 011 international prefix -> +
            { "+442079460991",  "+442079460991" },
        }
        for _, c in ipairs(cases) do
            assert.are.equal(c[2], fns.normalize_destination(c[1]))
        end
    end)

    it("normalize_did matches the inbound_router behavior", function()
        assert.are.equal("+16175551234", fns.normalize_did("6175551234"))
        assert.are.equal("+16175551234", fns.normalize_did("+16175551234"))
        assert.are.equal("+", fns.normalize_did("abc"))
    end)

    it("to_10digit strips +1 / leading 1", function()
        assert.are.equal("5551234567", fns.to_10digit("+15551234567"))
        assert.are.equal("5551234567", fns.to_10digit("15551234567"))
        assert.are.equal("5551234567", fns.to_10digit("5551234567"))
    end)
end)
