-- Standalone behavioral harness for docker/freeswitch/scripts/inbound_router.lua
-- (on-net routing). Scratch test file — NOT loaded by FreeSWITCH. Drives the
-- REAL inbound_router.lua under a stubbed FreeSWITCH environment and asserts the
-- two surgical on-net fixes without a live FS/DB:
--
--   (1) On-net RCF->trunk chain with an intermediate pass_caller_id=false hop
--       presents the MASKING DID to the PBX (effective_caller_id_number).
--   (2) Direct trunk inbound presents the ORIGINAL caller (sip_from_user)
--       byte-for-byte unchanged (no on-net hop -> pass_effective==true branch).
--   (3) On-net RCF->API terminal receives fallback_url (set_var "fallback_url").
--
-- Also runs the RCF->trunk case with a fully-transparent chain to prove the
-- direct-trunk output is reproduced when every hop passes CID.
--
-- Runs under Lua 5.4 (local) — the script uses only 5.1/5.3/5.4-common syntax.

local SCRIPT = arg[1] or "docker/freeswitch/scripts/inbound_router.lua"

-- ------------------------------------------------------------------
-- Test scenarios. Each defines the inbound DID's STEP-1 routing row
-- (returned by db.lookup_rcf / lookup_trunk_did) and the on-net oracle
-- rows keyed by E.164 (returned by db.resolve_destination).
-- ------------------------------------------------------------------
local scenarios = {}

-- (1) RCF -> (RCF masks, pass_caller_id=false) -> trunk terminal.
--     Inbound +16170000001 (RCF, pass=true) forwards to +16170000002
--     (RCF, pass=FALSE) which forwards to +16170000003 (trunk terminal).
--     Expect: PBX sees the masking DID +16170000002.
scenarios.rcf_mask_to_trunk = {
    inbound_did   = "+16170000001",
    sip_from_user = "+15085550123",     -- true external caller
    caller_id     = "+15085550123",
    step1 = {
        product_type = "rcf",
        customer_id = 10, forward_to = "+16170000002",
        pass_caller_id = true, ring_timeout = 30, max_channels = 0,
        rcf_name = "Origin",
    },
    oracle = {
        ["+16170000002"] = {
            did="+16170000002", product_type="rcf", customer_id=11,
            product_ref_id=2, product_enabled="t", customer_status="active",
            forward_to="+16170000003", pass_caller_id="f",  -- MASKS
            ring_timeout="30", max_channels="0", product_name="Masker",
            voice_url=nil, fallback_url=nil, trunk_id=nil,
        },
        ["+16170000003"] = {
            did="+16170000003", product_type="trunk", customer_id=12,
            product_ref_id=3, product_enabled="t", customer_status="active",
            forward_to=nil, pass_caller_id=nil,
            ring_timeout=nil, max_channels="10", product_name="PBX-A",
            voice_url=nil, fallback_url=nil, trunk_id="7",
        },
    },
    trunk_endpoints = { ["7"] = { "203.0.113.9" } },
    expect = { effective_cid = "+16170000002", kind = "trunk" },
}

-- (1b) RCF -> (RCF transparent) -> trunk terminal. Every hop passes CID.
--      Expect: PBX sees the ORIGINAL caller (same as a direct trunk).
scenarios.rcf_transparent_to_trunk = {
    inbound_did   = "+16170000001",
    sip_from_user = "+15085550123",
    caller_id     = "+15085550123",
    step1 = {
        product_type = "rcf",
        customer_id = 10, forward_to = "+16170000002",
        pass_caller_id = true, ring_timeout = 30, max_channels = 0,
        rcf_name = "Origin",
    },
    oracle = {
        ["+16170000002"] = {
            did="+16170000002", product_type="rcf", customer_id=11,
            product_ref_id=2, product_enabled="t", customer_status="active",
            forward_to="+16170000003", pass_caller_id="t",  -- TRANSPARENT
            ring_timeout="30", max_channels="0", product_name="Passer",
            voice_url=nil, fallback_url=nil, trunk_id=nil,
        },
        ["+16170000003"] = {
            did="+16170000003", product_type="trunk", customer_id=12,
            product_ref_id=3, product_enabled="t", customer_status="active",
            forward_to=nil, pass_caller_id=nil,
            ring_timeout=nil, max_channels="10", product_name="PBX-A",
            voice_url=nil, fallback_url=nil, trunk_id="7",
        },
    },
    trunk_endpoints = { ["7"] = { "203.0.113.9" } },
    expect = { effective_cid = "+15085550123", kind = "trunk" },
}

-- (2) DIRECT trunk inbound. +15550002222 is a trunk DID; no forward, no chain.
--     Expect: PBX sees the ORIGINAL caller (sip_from_user), byte-for-byte.
scenarios.direct_trunk = {
    inbound_did   = "+15550002222",
    sip_from_user = "+14045550199",
    caller_id     = "+14045550199",
    step1 = {
        product_type = "trunk",
        customer_id = 30, trunk_id = "5", traffic_grade = "standard",
    },
    oracle = {},
    trunk_endpoints = { ["5"] = { "198.51.100.7" } },
    expect = { effective_cid = "+14045550199", kind = "trunk" },
}

-- (3) On-net RCF -> API terminal. Inbound +16170000010 (RCF) forwards to
--     +15550001111 (API DID with fallback_url). Expect fallback_url plumbed.
scenarios.rcf_to_api = {
    inbound_did   = "+16170000010",
    sip_from_user = "+15085550777",
    caller_id     = "+15085550777",
    step1 = {
        product_type = "rcf",
        customer_id = 10, forward_to = "+15550001111",
        pass_caller_id = true, ring_timeout = 30, max_channels = 0,
        rcf_name = "Origin",
    },
    oracle = {
        ["+15550001111"] = {
            did="+15550001111", product_type="api", customer_id=20,
            product_ref_id=9, product_enabled="t", customer_status="active",
            forward_to=nil, pass_caller_id=nil,
            ring_timeout=nil, max_channels=nil, product_name=nil,
            voice_url="https://app.example.com/voice",
            fallback_url="https://app.example.com/fallback", trunk_id=nil,
        },
    },
    trunk_endpoints = {},
    expect = { voice_url = "https://app.example.com/voice",
               fallback_url = "https://app.example.com/fallback", kind = "api" },
}

-- ------------------------------------------------------------------
-- Run one scenario in an isolated environment and return captured state.
-- ------------------------------------------------------------------
local function run_scenario(sc)
    local captured = {
        setvars   = {},   -- session:setVariable + set_var (last write wins)
        bridges   = {},   -- dial strings passed to session:execute("bridge", ...)
        executes  = {},   -- other session:execute verbs
        hangups   = {},
        answered  = false,
        webhook   = false,
    }

    -- ---- session stub ----
    local session = {}
    local session_vars = {
        uuid                = "u-"..tostring(sc.inbound_did),
        destination_number  = sc.inbound_did,
        caller_id_number    = sc.caller_id,
        caller_id_name      = "",
        sip_from_user       = sc.sip_from_user,
        sip_from_display    = "",
        sip_call_id         = "callid-"..tostring(sc.inbound_did),
        sip_received_ip     = "67.231.2.12",
        network_addr        = "67.231.2.12",
    }
    function session:getVariable(k) return session_vars[k] end
    function session:setVariable(k, v) session_vars[k] = v; captured.setvars[k] = v end
    function session:ready() return true end
    function session:answer() captured.answered = true end
    function session:sleep(_) end
    function session:hangup(cause) captured.hangups[#captured.hangups+1] = cause end
    function session:execute(app, data)
        if app == "bridge" then
            captured.bridges[#captured.bridges+1] = data
        elseif app == "lua" and data == "voice_webhook.lua" then
            captured.webhook = true
        else
            captured.executes[#captured.executes+1] = { app = app, data = data }
        end
    end

    -- ---- freeswitch stub ----
    local globals = {}
    local freeswitch = {
        consoleLog = function(_, _) end,
        getGlobalVariable = function(k) return globals[k] end,
        setGlobalVariable = function(k, v) globals[k] = v end,
    }

    -- ---- fake db module (returned by the script's loadfile("db_client")) ----
    local fake_db = {
        lookup_rcf = function(did)
            if sc.step1.product_type == "rcf" and did == sc.inbound_did then
                return {
                    customer_id = tostring(sc.step1.customer_id),
                    forward_to = sc.step1.forward_to,
                    pass_caller_id = sc.step1.pass_caller_id and "t" or "f",
                    ring_timeout = tostring(sc.step1.ring_timeout),
                    max_channels = tostring(sc.step1.max_channels),
                    name = sc.step1.rcf_name,
                    traffic_grade = "standard", cpm_limit = "60",
                    daily_limit = "500", status = "active",
                }
            end
            return nil
        end,
        lookup_api_did = function(did)
            if sc.step1.product_type == "api" and did == sc.inbound_did then
                return { customer_id = tostring(sc.step1.customer_id),
                         voice_url = sc.step1.voice_url,
                         fallback_url = sc.step1.fallback_url,
                         traffic_grade = "standard", status = "active" }
            end
            return nil
        end,
        lookup_trunk_did = function(did)
            if sc.step1.product_type == "trunk" and did == sc.inbound_did then
                return { trunk_id = sc.step1.trunk_id,
                         customer_id = tostring(sc.step1.customer_id),
                         max_channels = "10", traffic_grade = "standard",
                         status = "active" }
            end
            return nil
        end,
        resolve_destination = function(did)
            return sc.oracle[did]   -- raw view row (strings/nil) or nil
        end,
        get_trunk_endpoint_ips = function(trunk_id)
            return sc.trunk_endpoints[tostring(trunk_id)]
        end,
    }

    -- ---- sandbox env for the script ----
    local env = setmetatable({
        session = session,
        freeswitch = freeswitch,
        os = os, string = string, table = table, math = math,
        tonumber = tonumber, tostring = tostring, type = type,
        pcall = pcall, ipairs = ipairs, pairs = pairs, print = print,
        error = error, assert = assert, select = select,
        setmetatable = setmetatable, getmetatable = getmetatable,
        rawget = rawget, rawset = rawset, next = next, require = require,
    }, { __index = _G })

    -- Intercept loadfile so require of the db_client module yields our fake_db,
    -- and package.loadlib (luasql) is a no-op. The script uses:
    --   loadfile("/usr/local/freeswitch/scripts/lib/db_client.lua")()  -> fake_db
    env.loadfile = function(path)
        if type(path) == "string" and path:match("db_client") then
            return function() return fake_db end
        end
        return loadfile(path)
    end
    env.package = setmetatable({
        path = package.path, cpath = package.cpath,
        loadlib = function() return nil, "stubbed" end,
        loaded = {},
    }, { __index = package })

    -- Ensure the RCF path does not take the TEST_MODE tone branch.
    local saved_test_mode = os.getenv("TEST_MODE")

    local chunk, err = loadfile(SCRIPT, "t", env)
    if not chunk then error("loadfile "..SCRIPT.." failed: "..tostring(err)) end
    local ok, run_err = pcall(chunk)
    if not ok then error("script raised: "..tostring(run_err)) end

    captured.session_vars = session_vars
    return captured
end

-- ------------------------------------------------------------------
-- Assertions
-- ------------------------------------------------------------------
local failures = 0
local function check(name, cond, detail)
    if cond then
        print(string.format("  PASS  %s", name))
    else
        failures = failures + 1
        print(string.format("  FAIL  %s -- %s", name, tostring(detail)))
    end
end

print("== onnet_router_harness ==")

do
    print("[1] RCF -> (mask, pass=false) -> trunk  (expect PBX sees masking DID)")
    local c = run_scenario(scenarios.rcf_mask_to_trunk)
    local eff = c.setvars["effective_caller_id_number"]
    check("effective_caller_id_number == masking DID +16170000002",
          eff == "+16170000002", "got "..tostring(eff))
    check("bridged to a PBX (X-PBX-Dest set)",
          c.setvars["sip_h_X-PBX-Dest"] ~= nil, c.setvars["sip_h_X-PBX-Dest"])
    check("terminal customer is the trunk's (12)",
          c.setvars["customer_id"] == "12", c.setvars["customer_id"])
    check("on_net flag true", c.setvars["on_net"] == "true", c.setvars["on_net"])
end

do
    print("[1b] RCF -> (transparent) -> trunk  (expect PBX sees original caller)")
    local c = run_scenario(scenarios.rcf_transparent_to_trunk)
    local eff = c.setvars["effective_caller_id_number"]
    check("effective_caller_id_number == original caller +15085550123",
          eff == "+15085550123", "got "..tostring(eff))
end

do
    print("[2] DIRECT trunk inbound  (expect PBX sees original caller, unchanged)")
    local c = run_scenario(scenarios.direct_trunk)
    local eff = c.setvars["effective_caller_id_number"]
    -- Direct path presents get_var("sip_from_user", caller_id) verbatim.
    check("effective_caller_id_number == sip_from_user +14045550199",
          eff == "+14045550199", "got "..tostring(eff))
    check("on_net flag false (direct, no forward)",
          c.setvars["on_net"] == "false", c.setvars["on_net"])
    check("terminal customer is the trunk's (30)",
          c.setvars["customer_id"] == "30", c.setvars["customer_id"])
end

do
    print("[3] RCF -> API terminal  (expect fallback_url plumbed)")
    local c = run_scenario(scenarios.rcf_to_api)
    check("voice_url set",
          c.setvars["voice_url"] == "https://app.example.com/voice",
          c.setvars["voice_url"])
    check("fallback_url set (Gap 2)",
          c.setvars["fallback_url"] == "https://app.example.com/fallback",
          c.setvars["fallback_url"])
    check("webhook engine handed off", c.webhook == true, c.webhook)
    check("terminal customer is API customer (20)",
          c.setvars["customer_id"] == "20", c.setvars["customer_id"])
end

print("")
if failures == 0 then
    print("ALL LUA HARNESS ASSERTIONS PASSED")
    os.exit(0)
else
    print(string.format("%d LUA HARNESS ASSERTION(S) FAILED", failures))
    os.exit(1)
end
