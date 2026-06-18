-- CHARACTERIZATION: lib/sbc.lua
--
-- Pins the extracted SBC reachability pre-check (TCP probe + process-wide cache)
-- and the multi-attempt SBC×carrier failover loop. The loop's attempt ORDER and
-- break-on-success behavior are ALSO exercised end-to-end through the real
-- inbound_router.lua in inbound_router_spec.lua (4 RCF bridges; 1 bridge on
-- success); this spec adds isolated coverage of the cache TTL logic and the
-- unreachable-SBC skip that the harness can't easily reach (luasocket is
-- deliberately absent there, so every SBC is fail-open reachable).

package.path = (debug.getinfo(1, "S").source:match("^@(.*/spec/)") or "./")
    :gsub("spec/$", "?.lua;") .. package.path

local helpers = require("helpers")
local fwmock = require("mocks.freeswitch_mock")
local sessmock = require("mocks.session_mock")

-- Load lib/sbc.lua in a controlled sandbox so we can drive `freeswitch`
-- (global var cache), `os.time` (deterministic TTL math) and `require("socket")`
-- (present/absent probe). Mirrors how mod_lua exposes the freeswitch global.
local function load_sbc(opts)
    opts = opts or {}
    local fw, fwrec = fwmock.new({ globals = opts.globals or {} })
    local now = opts.now or os.time()
    local env = setmetatable({}, { __index = _G })
    env.freeswitch = fw
    env.os = setmetatable({ time = function() return now end }, { __index = os })
    env.require = function(name)
        if name == "socket" then
            if opts.socket == nil then error("luasocket unavailable (test)") end
            return opts.socket
        end
        return require(name)
    end
    local fh = assert(io.open(helpers.scripts_dir .. "lib/sbc.lua", "r"))
    local src = fh:read("*a"); fh:close()
    local chunk = assert(load(src, "@sbc", "t", env))
    return chunk(), fwrec, now
end

-- A fake luasocket whose TCP connect succeeds/fails deterministically.
local function fake_socket(connect_ok)
    return { tcp = function()
        return {
            settimeout = function() end,
            connect = function(_, _ip, _port) return connect_ok and true or nil end,
            close = function() end,
        }
    end }
end

describe("lib/sbc.is_reachable — luasocket absent (fail open, no cache)", function()
    local sbc, fwrec = load_sbc({})  -- no socket
    local ok = sbc.is_reachable("1.1.1.1", 5060)

    it("returns true when luasocket is unavailable", function()
        assert.is_true(ok)
    end)

    it("does NOT cache a fail-open result", function()
        assert.is_nil(fwrec.globals["sbc_health_1.1.1.1"])
    end)
end)

describe("lib/sbc.is_reachable — cache hits skip the probe", function()
    it("fresh 'up' cache returns true", function()
        local now = os.time()
        local sbc = load_sbc({ now = now, globals = { ["sbc_health_2.2.2.2"] = "up:" .. now } })
        assert.is_true(sbc.is_reachable("2.2.2.2", 5060))
    end)

    it("fresh 'down' cache returns false", function()
        local now = os.time()
        local sbc = load_sbc({ now = now, globals = { ["sbc_health_3.3.3.3"] = "down:" .. now } })
        assert.is_false(sbc.is_reachable("3.3.3.3", 5060))
    end)

    it("expired 'down' cache (age >= 10s) re-probes", function()
        local now = os.time()
        -- down cached 11s ago -> past the 10s down-TTL -> re-probe. With a
        -- working socket the probe says up and refreshes the cache.
        local sbc, fwrec = load_sbc({
            now = now, socket = fake_socket(true),
            globals = { ["sbc_health_3.3.3.3"] = "down:" .. (now - 11) },
        })
        assert.is_true(sbc.is_reachable("3.3.3.3", 5060))
        assert.is_true(fwrec.globals["sbc_health_3.3.3.3"]:sub(1, 3) == "up:")
    end)
end)

describe("lib/sbc.is_reachable — probe result is cached", function()
    it("a reachable probe caches 'up:<epoch>'", function()
        local now = os.time()
        local sbc, fwrec = load_sbc({ now = now, socket = fake_socket(true) })
        assert.is_true(sbc.is_reachable("4.4.4.4", 5060))
        assert.are.equal("up:" .. now, fwrec.globals["sbc_health_4.4.4.4"])
    end)

    it("an unreachable probe caches 'down:<epoch>'", function()
        local now = os.time()
        local sbc, fwrec = load_sbc({ now = now, socket = fake_socket(false) })
        assert.is_false(sbc.is_reachable("5.5.5.5", 5060))
        assert.are.equal("down:" .. now, fwrec.globals["sbc_health_5.5.5.5"])
    end)
end)

-- Helper: run failover_bridge with the given disposition + reachability cache.
local function run_failover(opts)
    opts = opts or {}
    local sbc = load_sbc({ now = opts.now, globals = opts.globals or {} })  -- fail-open unless cache says down
    local session, rec = sessmock.new({})
    local set_map = {}
    local function set_var(n, v) set_map[n] = v end
    local function get_var(n, d)
        if n == "originate_disposition" then return opts.disposition or d end
        return d
    end
    local attempts = {
        { sbc = "a", carrier = "primary",   label = "A+primary" },
        { sbc = "b", carrier = "primary",   label = "B+primary" },
        { sbc = "a", carrier = "secondary", label = "A+secondary" },
        { sbc = "b", carrier = "secondary", label = "B+secondary" },
    }
    sbc.failover_bridge({
        session = session, get_var = get_var, set_var = set_var,
        uuid = "u", did = "+15551112222", dest = "13334445555",
        attempts = attempts,
        build_dial = function(at) return "DIAL:" .. at.sbc .. ":" .. at.carrier end,
    })
    return rec, set_map
end

describe("lib/sbc.failover_bridge — attempt order + break-on-success", function()
    it("runs all 4 attempts in order when none connect", function()
        local rec = run_failover({ disposition = "" })
        assert.are.equal(4, #rec.bridges)
        assert.are.equal("DIAL:a:primary", rec.bridges[1])
        assert.are.equal("DIAL:b:primary", rec.bridges[2])
        assert.are.equal("DIAL:a:secondary", rec.bridges[3])
        assert.are.equal("DIAL:b:secondary", rec.bridges[4])
    end)

    it("stops after the first connected attempt", function()
        local rec, set_map = run_failover({ disposition = "SUCCESS" })
        assert.are.equal(1, #rec.bridges)
        assert.are.equal("DIAL:a:primary", rec.bridges[1])
        assert.are.equal("carrier_primary", set_map["carrier_used"])
    end)
end)

describe("lib/sbc.failover_bridge — skips an unreachable SBC instantly", function()
    it("skips attempts whose SBC is cached down (only the reachable SBC bridges)", function()
        local now = os.time()
        -- SBC 'b' is cached down -> its two attempts are skipped; 'a' is
        -- fail-open reachable -> its two attempts bridge.
        local rec = run_failover({
            now = now, disposition = "",
            globals = { ["sbc_health_b"] = "down:" .. now },
        })
        assert.are.equal(2, #rec.bridges)
        assert.are.equal("DIAL:a:primary", rec.bridges[1])
        assert.are.equal("DIAL:a:secondary", rec.bridges[2])
    end)
end)
