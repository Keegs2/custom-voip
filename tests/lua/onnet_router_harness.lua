-- Standalone behavioral harness for docker/freeswitch/scripts/inbound_router.lua
-- (on-net routing). Scratch test file — NOT loaded by FreeSWITCH. Drives the
-- REAL inbound_router.lua under a stubbed FreeSWITCH environment and asserts the
-- two surgical on-net fixes without a live FS/DB:
--
--   (1) On-net RCF->trunk chain with an intermediate pass_caller_id=false hop
--       presents the MASKING DID to the PBX (effective_caller_id_number).
--   (2) Direct trunk inbound presents the ORIGINAL caller (sip_from_user)
--       byte-for-byte unchanged (no on-net hop -> pass_effective==true branch).
--   (3) On-net RCF->API terminal receives fallback_url (set_var "fallback_url")
--       -- only with API_CALLING_ENABLED=true (API Calling is RETIRED).
--   (4) API Calling retirement gate (API_CALLING_ENABLED, default OFF):
--       RCF->API on-net terminal and DIRECT api_did inbound are hard-rejected
--       CALL_REJECTED (603) + lua_routed=true, no carrier leg, no webhook;
--       flag parsing ("true" case-insensitive/trimmed only); and RCF/trunk
--       scenarios produce IDENTICAL captured state with the flag off vs on.
--
--   (5) CDR A/B leg split (docs/CDR_LEG_SPLIT_CONTRACT.md): every CARRIER
--       bridge attempt (table-driven + legacy failover loops) carries a
--       per-leg "[cdr_*]" block with the A-leg's final values and a 1-based
--       contiguous cdr_leg_attempt; NO cdr_* var is ever set on the A-leg;
--       on-net trunk delivery / local extension / API reject / hard rejects
--       carry NO cdr_* at all; unsafe values are omitted, never injected.
--       Optional regression mode: BASELINE_ROUTER=<pre-change inbound_router.lua>
--       re-runs every scenario on the baseline and asserts the captured A-leg
--       state + dial strings (with the [cdr_*] block stripped) are IDENTICAL.
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

-- (4) DIRECT api_did inbound. +15550003333 is an API DID; no forward.
--     Flag OFF (default): 603 hard reject. Flag ON: webhook handoff.
scenarios.direct_api = {
    inbound_did   = "+15550003333",
    sip_from_user = "+14045550155",
    caller_id     = "+14045550155",
    step1 = {
        product_type = "api",
        customer_id = 21,
        voice_url = "https://app.example.com/voice2",
        fallback_url = "https://app.example.com/fallback2",
    },
    oracle = {},
    trunk_endpoints = {},
}

-- ------------------------------------------------------------------
-- CDR leg-split scenarios (carrier egress). Common inbound attribution:
-- Kamailio-stamped X-SBC-ID / X-Inbound-Carrier / X-Inbound-PoP on the A-leg.
-- ------------------------------------------------------------------
local SPLIT_HDRS = {
    ["sip_h_X-SBC-ID"]            = "east-sbc-1",
    ["sip_h_X-Inbound-Carrier"]   = "sinch",
    ["sip_h_X-Inbound-PoP"]       = "denver",
}

-- (6) OFF-NET single-hop RCF, carrier_trunks unavailable -> LEGACY 4-attempt
--     loop; every attempt fails -> 4 carrier B-legs, then 503.
scenarios.rcf_offnet_legacy_allfail = {
    inbound_did   = "+16170000020",
    sip_from_user = "+15085550101",
    caller_id     = "+15085550101",
    extra_vars    = SPLIT_HDRS,
    step1 = {
        product_type = "rcf",
        customer_id = 10, forward_to = "+17745550100",
        pass_caller_id = true, ring_timeout = 30, max_channels = 0,
        rcf_name = "Main Office",
    },
    oracle = {},
    trunk_endpoints = {},
    bridge_results = { "NORMAL_TEMPORARY_FAILURE", "NORMAL_TEMPORARY_FAILURE",
                       "NORMAL_TEMPORARY_FAILURE", "NORMAL_TEMPORARY_FAILURE" },
}

-- (7) OFF-NET RCF, table-driven (carrier_trunks) 2 trunks x 2 SBCs = 4
--     attempts, SBC-2 (10.0.0.2) cached DOWN -> 2 launched; first fails,
--     second answers. Expect cdr_leg_attempt 1,2 (contiguous, skips uncounted).
scenarios.rcf_offnet_table_skip = {
    inbound_did   = "+16170000021",
    sip_from_user = "+15085550102",
    caller_id     = "+15085550102",
    extra_vars    = SPLIT_HDRS,
    step1 = {
        product_type = "rcf",
        customer_id = 10, forward_to = "+17745550101",
        pass_caller_id = false, ring_timeout = 25, max_channels = 0,
        rcf_name = "Masked Line",
    },
    oracle = {},
    trunk_endpoints = {},
    term_trunks = {
        { carrier = "bandwidth", pop = "dallas", term_ip = "67.231.2.12",    traffic_class = "any" },
        { carrier = "bandwidth", pop = "la",     term_ip = "216.82.238.134", traffic_class = "any" },
    },
    sbc_down = { ["10.0.0.2"] = true },
    bridge_results = { "NO_ANSWER", "SUCCESS" },
}

-- (8) ON-NET chain -> OFF-NET terminal: +16170000030 (RCF cust 10, pass=true)
--     -> +16170000031 (RCF cust 11, pass=FALSE, masks) -> +17745550102 (PSTN).
--     One carrier B-leg; call-level facts on_net=true, hops=1, origin=10,
--     terminal=11. First attempt answers.
scenarios.rcf_chain_offnet = {
    inbound_did   = "+16170000030",
    sip_from_user = "+15085550103",
    caller_id     = "+15085550103",
    extra_vars    = SPLIT_HDRS,
    step1 = {
        product_type = "rcf",
        customer_id = 10, forward_to = "+16170000031",
        pass_caller_id = true, ring_timeout = 30, max_channels = 0,
        rcf_name = "Origin",
    },
    oracle = {
        ["+16170000031"] = {
            did="+16170000031", product_type="rcf", customer_id=11,
            product_ref_id=4, product_enabled="t", customer_status="active",
            forward_to="+17745550102", pass_caller_id="f",
            ring_timeout="20", max_channels="0", product_name="Terminal RCF",
            voice_url=nil, fallback_url=nil, trunk_id=nil,
        },
    },
    trunk_endpoints = {},
    bridge_results = { "SUCCESS" },
}

-- (9) Local extension terminal (on-net): RCF -> 1001. No carrier leg.
scenarios.rcf_local_ext = {
    inbound_did   = "+16170000040",
    sip_from_user = "+15085550104",
    caller_id     = "+15085550104",
    extra_vars    = SPLIT_HDRS,
    step1 = {
        product_type = "rcf",
        customer_id = 10, forward_to = "1001",
        pass_caller_id = true, ring_timeout = 30, max_channels = 0,
        rcf_name = "Origin",
    },
    oracle = {},
    trunk_endpoints = {},
    bridge_results = { "SUCCESS" },
}

-- (10) Hard rejects: disabled on-net terminal (603) and a loop (483).
scenarios.rcf_disabled_terminal = {
    inbound_did   = "+16170000050",
    sip_from_user = "+15085550105",
    caller_id     = "+15085550105",
    extra_vars    = SPLIT_HDRS,
    step1 = {
        product_type = "rcf",
        customer_id = 10, forward_to = "+16170000051",
        pass_caller_id = true, ring_timeout = 30, max_channels = 0,
        rcf_name = "Origin",
    },
    oracle = {
        ["+16170000051"] = {
            did="+16170000051", product_type="rcf", customer_id=12,
            product_ref_id=5, product_enabled="f", customer_status="active",
            forward_to="+17745550103", pass_caller_id="t",
            ring_timeout="30", max_channels="0", product_name="Off",
        },
    },
    trunk_endpoints = {},
}
scenarios.rcf_loop = {
    inbound_did   = "+16170000060",
    sip_from_user = "+15085550106",
    caller_id     = "+15085550106",
    extra_vars    = SPLIT_HDRS,
    step1 = {
        product_type = "rcf",
        customer_id = 10, forward_to = "+16170000061",
        pass_caller_id = true, ring_timeout = 30, max_channels = 0,
        rcf_name = "Origin",
    },
    oracle = {
        ["+16170000061"] = {
            did="+16170000061", product_type="rcf", customer_id=10,
            product_ref_id=6, product_enabled="t", customer_status="active",
            forward_to="+16170000060", pass_caller_id="t",
            ring_timeout="30", max_channels="0", product_name="Back",
        },
        ["+16170000060"] = {
            did="+16170000060", product_type="rcf", customer_id=10,
            product_ref_id=7, product_enabled="t", customer_status="active",
            forward_to="+16170000061", pass_caller_id="t",
            ring_timeout="30", max_channels="0", product_name="Origin",
        },
    },
    trunk_endpoints = {},
}

-- (11) Unsafe values never reach the dial string: a PoP with a comma and a
--      uuid with a comma/bracket are OMITTED; the rest of the block is intact.
scenarios.rcf_offnet_unsafe = {
    inbound_did   = "+16170000070",
    sip_from_user = "+15085550107",
    caller_id     = "+15085550107",
    uuid          = "bad,uuid]x",
    extra_vars    = {
        ["sip_h_X-SBC-ID"]          = "east-sbc-2",
        ["sip_h_X-Inbound-Carrier"] = "bandwidth",
        ["sip_h_X-Inbound-PoP"]     = "den,ver",
    },
    step1 = {
        product_type = "rcf",
        customer_id = 10, forward_to = "+17745550104",
        pass_caller_id = true, ring_timeout = 30, max_channels = 0,
        rcf_name = "Origin",
    },
    oracle = {},
    trunk_endpoints = {},
    bridge_results = { "SUCCESS" },
}

-- Shallow-copy a scenario with a per-run env override table (os.getenv stub).
local function with_env(sc, envtab)
    local c = {}
    for k, v in pairs(sc) do c[k] = v end
    c.env = envtab
    return c
end

-- ------------------------------------------------------------------
-- Run one scenario in an isolated environment and return captured state.
-- ------------------------------------------------------------------
local function run_scenario(sc, script_path)
    local captured = {
        setvars   = {},   -- session:setVariable + set_var (last write wins)
        bridges   = {},   -- dial strings passed to session:execute("bridge", ...)
        executes  = {},   -- other session:execute verbs
        hangups   = {},
        answered  = false,
        webhook   = false,
        -- sofia_session_timeout value seen at each answer / bridge (order check)
        timer_seen = {},
    }

    -- ---- session stub ----
    local session = {}
    local session_vars = {
        uuid                = sc.uuid or ("u-"..tostring(sc.inbound_did)),
        destination_number  = sc.inbound_did,
        caller_id_number    = sc.caller_id,
        caller_id_name      = "",
        sip_from_user       = sc.sip_from_user,
        sip_from_display    = "",
        sip_call_id         = "callid-"..tostring(sc.inbound_did),
        sip_received_ip     = "67.231.2.12",
        network_addr        = "67.231.2.12",
    }
    for k, v in pairs(sc.extra_vars or {}) do session_vars[k] = v end
    local bridge_results = sc.bridge_results
    local bridge_idx = 0
    function session:getVariable(k) return session_vars[k] end
    function session:setVariable(k, v) session_vars[k] = v; captured.setvars[k] = v end
    function session:ready() return true end
    function session:answer()
        captured.answered = true
        captured.timer_seen[#captured.timer_seen+1] = "answer=" .. tostring(session_vars.sofia_session_timeout)
    end
    function session:sleep(_) end
    function session:hangup(cause) captured.hangups[#captured.hangups+1] = cause end
    function session:execute(app, data)
        if app == "bridge" then
            captured.bridges[#captured.bridges+1] = data
            captured.timer_seen[#captured.timer_seen+1] = "bridge=" .. tostring(session_vars.sofia_session_timeout)
            -- Scripted bridge outcome (originate_disposition) per attempt,
            -- only for scenarios that define one (older scenarios unchanged).
            if bridge_results then
                bridge_idx = bridge_idx + 1
                session_vars.originate_disposition =
                    bridge_results[bridge_idx] or "NORMAL_TEMPORARY_FAILURE"
            end
        elseif app == "lua" and data == "voice_webhook.lua" then
            captured.webhook = true
        else
            captured.executes[#captured.executes+1] = { app = app, data = data }
        end
    end

    -- ---- freeswitch stub ----
    -- Pre-seed the process-wide SBC health cache so no real TCP probe runs
    -- (luasocket may exist on the dev box): both harness SBCs "up" unless the
    -- scenario marks one down.
    local globals = {}
    for _, ip in ipairs({ "10.0.0.1", "10.0.0.2" }) do
        globals["sbc_health_" .. ip] = string.format("%s:%d",
            (sc.sbc_down and sc.sbc_down[ip]) and "down" or "up", os.time())
    end
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
    -- carrier_trunks (table-driven termination) only when the scenario
    -- supplies rows; otherwise db.get_termination_trunks is absent and the
    -- router takes the LEGACY fallback loop (fail-open path).
    if sc.term_trunks then
        fake_db.get_termination_trunks = function(_) return sc.term_trunks end
    end

    -- ---- os stub: per-scenario env overrides (os.getenv) ----
    -- API_CALLING_ENABLED is pinned to the scenario's value (nil = unset)
    -- so the caller's shell env can never leak into the result.
    local sc_env = sc.env or {}
    -- Pinned harness env: deterministic SBC IPs for the failover loop and
    -- no leak of the caller's shell (TEST_MODE, pass-through flags, zone).
    local PINNED = {
        SBC_PROXY_IP = "10.0.0.1", SBC_PROXY_IP_FAILOVER = "10.0.0.2",
        EXTERNAL_SIP_IP = "203.0.113.50", FS_ZONE = "east",
    }
    local UNSET = { API_CALLING_ENABLED = true, TEST_MODE = true,
        RCF_FROM_PASSTHROUGH = true, BRIDGE_PROGRESS_TIMEOUT = true,
        FS_NODE_ID = true }
    local sandbox_os = setmetatable({
        getenv = function(k)
            if sc_env[k] ~= nil then return sc_env[k] end
            if PINNED[k] ~= nil then return PINNED[k] end
            if UNSET[k] then return nil end
            return os.getenv(k)
        end,
    }, { __index = os })

    -- ---- sandbox env for the script ----
    local env = setmetatable({
        session = session,
        freeswitch = freeswitch,
        os = sandbox_os, string = string, table = table, math = math,
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

    local path = script_path or SCRIPT
    local chunk, err = loadfile(path, "t", env)
    if not chunk then error("loadfile "..path.." failed: "..tostring(err)) end
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
    print("[3] RCF -> API terminal, API_CALLING_ENABLED=true  (expect fallback_url plumbed)")
    local c = run_scenario(with_env(scenarios.rcf_to_api, { API_CALLING_ENABLED = "true" }))
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

-- Assert a retired-API hard reject: exactly one CALL_REJECTED hangup,
-- lua_routed=true, no carrier/PBX bridge, no webhook, never answered.
local function check_api_rejected(c, label)
    check(label .. ": single hangup CALL_REJECTED (603)",
          #c.hangups == 1 and c.hangups[1] == "CALL_REJECTED",
          table.concat(c.hangups, ","))
    check(label .. ": lua_routed=true (dialplan does not mask with 404)",
          c.setvars["lua_routed"] == "true", c.setvars["lua_routed"])
    check(label .. ": hangup_cause var CALL_REJECTED",
          c.setvars["hangup_cause"] == "CALL_REJECTED", c.setvars["hangup_cause"])
    check(label .. ": NO bridge emitted (no carrier hairpin)",
          #c.bridges == 0, table.concat(c.bridges, " | "))
    check(label .. ": webhook engine NOT invoked", c.webhook == false, c.webhook)
    check(label .. ": call NOT answered", c.answered == false, c.answered)
    check(label .. ": voice_url NOT set", c.setvars["voice_url"] == nil,
          c.setvars["voice_url"])
end

do
    print("[3b] RCF -> API terminal, flag UNSET (default)  (expect 603 hard reject)")
    local c = run_scenario(scenarios.rcf_to_api)
    check_api_rejected(c, "rcf->api off")
    -- Same CDR/on-net shape as the disabled/suspended on-net reject: the
    -- terminal is never dispatched, so customer_id stays the ORIGIN (10) and
    -- terminating_customer_id / on_net are not exported.
    check("rcf->api off: customer_id stays origin (10)",
          c.setvars["customer_id"] == "10", c.setvars["customer_id"])
    check("rcf->api off: origin_customer_id == 10",
          c.setvars["origin_customer_id"] == "10", c.setvars["origin_customer_id"])
    check("rcf->api off: terminating_customer_id not set",
          c.setvars["terminating_customer_id"] == nil, c.setvars["terminating_customer_id"])
end

do
    print("[3c] RCF -> API terminal, flag variants")
    for _, v in ipairs({ "false", "", "1", "on", "yes", "enabled", "truee" }) do
        local c = run_scenario(with_env(scenarios.rcf_to_api, { API_CALLING_ENABLED = v }))
        check(string.format("flag %q => OFF (603, no webhook)", v),
              c.hangups[1] == "CALL_REJECTED" and c.webhook == false,
              table.concat(c.hangups, ",") .. " webhook=" .. tostring(c.webhook))
    end
    for _, v in ipairs({ "TRUE", "  True \t" }) do
        local c = run_scenario(with_env(scenarios.rcf_to_api, { API_CALLING_ENABLED = v }))
        check(string.format("flag %q => ON (webhook handoff)", v),
              c.webhook == true and #c.hangups == 0,
              table.concat(c.hangups, ",") .. " webhook=" .. tostring(c.webhook))
    end
end

do
    print("[4] DIRECT api_did inbound, flag UNSET (default)  (expect 603 hard reject)")
    local c = run_scenario(scenarios.direct_api)
    check_api_rejected(c, "direct api off")
    check("direct api off: customer_id is the API DID's (21)",
          c.setvars["customer_id"] == "21", c.setvars["customer_id"])
    check("direct api off: product_type api",
          c.setvars["product_type"] == "api", c.setvars["product_type"])
end

do
    print("[4b] DIRECT api_did inbound, API_CALLING_ENABLED=true  (expect today's webhook handoff)")
    local c = run_scenario(with_env(scenarios.direct_api, { API_CALLING_ENABLED = "true" }))
    check("voice_url set", c.setvars["voice_url"] == "https://app.example.com/voice2",
          c.setvars["voice_url"])
    check("fallback_url set", c.setvars["fallback_url"] == "https://app.example.com/fallback2",
          c.setvars["fallback_url"])
    check("answered + webhook engine handed off", c.answered and c.webhook == true, c.webhook)
    check("no hangup from router", #c.hangups == 0, table.concat(c.hangups, ","))
    check("on_net false (direct)", c.setvars["on_net"] == "false", c.setvars["on_net"])
end

-- Serialize captured state deterministically for off-vs-on equality.
local function dump(c)
    local keys = {}
    for k in pairs(c.setvars) do keys[#keys+1] = k end
    table.sort(keys)
    local out = {}
    for _, k in ipairs(keys) do out[#out+1] = k .. "=" .. tostring(c.setvars[k]) end
    out[#out+1] = "#bridges=" .. table.concat(c.bridges, " | ")
    out[#out+1] = "#hangups=" .. table.concat(c.hangups, ",")
    for _, e in ipairs(c.executes) do
        out[#out+1] = "#exec=" .. tostring(e.app) .. ":" .. tostring(e.data)
    end
    out[#out+1] = "#answered=" .. tostring(c.answered) .. " webhook=" .. tostring(c.webhook)
    return table.concat(out, "\n")
end

do
    print("[5] RCF / trunk scenarios unaffected by the flag (off vs on identical)")
    for _, name in ipairs({ "rcf_mask_to_trunk", "rcf_transparent_to_trunk", "direct_trunk" }) do
        local off = dump(run_scenario(scenarios[name]))
        local on  = dump(run_scenario(with_env(scenarios[name], { API_CALLING_ENABLED = "true" })))
        check(name .. ": captured state identical with flag off vs on", off == on,
              "\n--- off ---\n" .. off .. "\n--- on ---\n" .. on)
    end
end

-- ------------------------------------------------------------------
-- CDR A/B leg split assertions
-- ------------------------------------------------------------------
-- Extract the per-leg "[...]" block that must sit IMMEDIATELY before the
-- endpoint ("}[cdr_...]sofia/external/"). Returns (vars table | nil, the
-- dial string with the block removed, raw block text).
local function cdr_block(dial)
    local pre, block, post = dial:match("^(.-})%[([^%]]*)%](sofia/.*)$")
    if not block then return nil, dial, nil end
    local t = {}
    for kv in block:gmatch("[^,]+") do
        local k, v = kv:match("^([%w_]+)=(.*)$")
        if k then t[k] = v else t["__bad__"] = kv end
    end
    return t, pre .. post, block
end

local function no_cdr_on_a_leg(c, label)
    local leaked = {}
    for k in pairs(c.setvars) do
        if tostring(k):match("^cdr_") then leaked[#leaked+1] = k end
    end
    for _, e in ipairs(c.executes) do
        if tostring(e.data):match("cdr_") then leaked[#leaked+1] = e.app .. ":" .. e.data end
    end
    check(label .. ": NO cdr_* var set/exported on the A-leg", #leaked == 0,
          table.concat(leaked, ","))
end

local function no_cdr_in_bridges(c, label)
    local bad = {}
    for _, b in ipairs(c.bridges) do
        if b:match("cdr_") then bad[#bad+1] = b end
    end
    check(label .. ": NO cdr_* in any dial string (no B row)", #bad == 0,
          table.concat(bad, " | "))
end

-- Assert the full contract set on one carrier dial string.
local function check_b_block(dial, want, label)
    local t, stripped = cdr_block(dial)
    check(label .. ": [cdr_*] per-leg block present right before sofia/",
          t ~= nil, dial)
    if not t then return end
    check(label .. ": block parses cleanly (no stray fields)", t["__bad__"] == nil,
          tostring(t["__bad__"]))
    for k, v in pairs(want) do
        if v == false then
            check(label .. ": " .. k .. " omitted", t[k] == nil, tostring(t[k]))
        else
            check(label .. ": " .. k .. "=" .. v, t[k] == v, tostring(t[k]))
        end
    end
    check(label .. ": only one [ ] block / endpoint untouched",
          not stripped:find("%[") and stripped:find("}sofia/external/") ~= nil, stripped)
end

local function base_want(sc, attempt, extra)
    local w = {
        cdr_leg = "B", cdr_carrier_leg = "true",
        cdr_leg_attempt = tostring(attempt), cdr_direction = "outbound",
        cdr_call_id = "u-" .. sc.inbound_did,
        cdr_product_type = "rcf",
        cdr_trunk_id = false,
        cdr_inbound_carrier = "sinch", cdr_inbound_carrier_pop = "denver",
        cdr_sbc_id = "east-sbc-1",
    }
    for k, v in pairs(extra or {}) do w[k] = v end
    return w
end

do
    print("[6] OFF-NET RCF, legacy fallback loop, all 4 attempts fail")
    local sc = scenarios.rcf_offnet_legacy_allfail
    local c = run_scenario(sc)
    check("4 carrier bridge attempts", #c.bridges == 4, #c.bridges)
    local sbcs = { "10.0.0.1", "10.0.0.2", "10.0.0.1", "10.0.0.2" }
    local carriers = { "primary", "primary", "secondary", "secondary" }
    for i, b in ipairs(c.bridges) do
        check_b_block(b, base_want(sc, i, {
            cdr_customer_id = "10", cdr_on_net = "false", cdr_on_net_hops = "0",
            cdr_origin_customer_id = "10", cdr_terminating_customer_id = "10",
        }), "legacy attempt " .. i)
        local _, stripped = cdr_block(b)
        local want_dial = string.format(
            "{ignore_early_media=false,progress_timeout=10,call_timeout=30,sip_h_X-Carrier=%s" ..
            ",sip_h_X-CID=callid-%s" ..
            ",sip_session_timeout=1800,sip_minimum_session_expires=90,enable_timer=true" ..
            "}sofia/external/+17745550100@%s:5060", carriers[i], sc.inbound_did, sbcs[i])
        check("legacy attempt " .. i .. ": dial string minus block == pre-split string",
              stripped == want_dial, "\n got " .. stripped .. "\nwant " .. want_dial)
    end
    no_cdr_on_a_leg(c, "legacy allfail")
    check("503 after all attempts", c.hangups[1] == "NORMAL_TEMPORARY_FAILURE",
          table.concat(c.hangups, ","))
    check("term_trunks_source=fallback", c.setvars["term_trunks_source"] == "fallback",
          c.setvars["term_trunks_source"])
    check("A-leg product/customer unchanged (rcf / 10)",
          c.setvars["product_type"] == "rcf" and c.setvars["customer_id"] == "10",
          tostring(c.setvars["product_type"]) .. "/" .. tostring(c.setvars["customer_id"]))
    check("A-leg direction NOT set to outbound", c.setvars["direction"] ~= "outbound",
          c.setvars["direction"])
end

do
    print("[7] OFF-NET RCF, table-driven loop, SBC-2 down, 2nd launched attempt answers")
    local sc = scenarios.rcf_offnet_table_skip
    local c = run_scenario(sc)
    check("2 launched bridges (2 skipped by TCP pre-check)", #c.bridges == 2, #c.bridges)
    local ips = { "67.231.2.12", "216.82.238.134" }
    for i, b in ipairs(c.bridges) do
        check_b_block(b, base_want(sc, i, {
            cdr_customer_id = "10", cdr_on_net = "false", cdr_on_net_hops = "0",
            cdr_origin_customer_id = "10", cdr_terminating_customer_id = "10",
        }), "table attempt " .. i)
        check("table attempt " .. i .. ": carrier IP " .. ips[i] .. " via SBC-1",
              b:find("sip_h_X-Carrier-IP=" .. ips[i], 1, true) ~= nil
              and b:find("@10.0.0.1:5060", 1, true) ~= nil, b)
    end
    no_cdr_on_a_leg(c, "table skip")
    check("no router hangup (answered)", #c.hangups == 0, table.concat(c.hangups, ","))
    check("carrier_used = winning trunk", c.setvars["carrier_used"] == "bandwidth-la",
          c.setvars["carrier_used"])
    -- pass_caller_id=false single hop: masking DID presented (CID composition).
    check("CID: effective_caller_id_number = masking DID (10-digit)",
          c.setvars["effective_caller_id_number"] == "6170000021",
          c.setvars["effective_caller_id_number"])
end

do
    print("[8] ON-NET chain -> OFF-NET terminal (one carrier B-leg, call-level facts)")
    local sc = scenarios.rcf_chain_offnet
    local c = run_scenario(sc)
    check("exactly 1 carrier bridge", #c.bridges == 1, #c.bridges)
    if c.bridges[1] then
        check_b_block(c.bridges[1], base_want(sc, 1, {
            cdr_customer_id = "11", cdr_on_net = "true", cdr_on_net_hops = "1",
            cdr_origin_customer_id = "10", cdr_terminating_customer_id = "11",
        }), "chain attempt 1")
    end
    no_cdr_on_a_leg(c, "chain offnet")
    check("A-leg customer_id = terminal (11)", c.setvars["customer_id"] == "11",
          c.setvars["customer_id"])
    check("A-leg on_net=true hops=1",
          c.setvars["on_net"] == "true" and c.setvars["on_net_hops"] == "1",
          tostring(c.setvars["on_net"]) .. "/" .. tostring(c.setvars["on_net_hops"]))
    check("CID: masking hop +16170000031 presented (last false hop wins)",
          c.setvars["effective_caller_id_number"] == "6170000031",
          c.setvars["effective_caller_id_number"])
    check("CID: X-Original-CID = masking E.164",
          c.setvars["sip_h_X-Original-CID"] == "+16170000031",
          c.setvars["sip_h_X-Original-CID"])
end

do
    print("[9] ON-NET terminals / rejects carry NO cdr_* (no B row)")
    for _, name in ipairs({ "rcf_mask_to_trunk", "rcf_transparent_to_trunk",
                            "direct_trunk", "rcf_local_ext" }) do
        local c = run_scenario(scenarios[name])
        check(name .. ": a bridge was emitted", #c.bridges >= 1, #c.bridges)
        no_cdr_in_bridges(c, name)
        no_cdr_on_a_leg(c, name)
    end
    for _, spec in ipairs({
        { "rcf_to_api", "CALL_REJECTED" }, { "direct_api", "CALL_REJECTED" },
        { "rcf_disabled_terminal", "CALL_REJECTED" },
        { "rcf_loop", "EXCHANGE_ROUTING_ERROR" },
    }) do
        local c = run_scenario(scenarios[spec[1]])
        check(spec[1] .. ": hard reject " .. spec[2],
              c.hangups[1] == spec[2] and #c.bridges == 0,
              table.concat(c.hangups, ",") .. " bridges=" .. #c.bridges)
        no_cdr_on_a_leg(c, spec[1])
    end
    -- API Calling ON: the webhook engine answers; still no carrier dial here.
    local c = run_scenario(with_env(scenarios.rcf_to_api, { API_CALLING_ENABLED = "true" }))
    no_cdr_in_bridges(c, "rcf_to_api (flag on)")
    no_cdr_on_a_leg(c, "rcf_to_api (flag on)")
end

do
    print("[10] Unsafe values are omitted, never injected into the dial string")
    local sc = scenarios.rcf_offnet_unsafe
    local c = run_scenario(sc)
    check("1 bridge", #c.bridges == 1, #c.bridges)
    if c.bridges[1] then
        check_b_block(c.bridges[1], {
            cdr_leg = "B", cdr_carrier_leg = "true", cdr_leg_attempt = "1",
            cdr_direction = "outbound", cdr_customer_id = "10",
            cdr_call_id = false,             -- uuid had ',' and ']'
            cdr_inbound_carrier = "bandwidth",
            cdr_inbound_carrier_pop = false, -- had ','
            cdr_sbc_id = "east-sbc-2",
        }, "unsafe")
    end
    no_cdr_on_a_leg(c, "unsafe")
end

-- ------------------------------------------------------------------
-- RFC 4028 A-leg session timer (sofia_session_timeout, 2026-09-24)
-- ------------------------------------------------------------------
-- The removed no-op exports (mod_sofia reads none of these names).
local NOOP_TIMER_EXPORTS = {
    ["sip_session_timeout=1800"] = true,
    ["sip_minimum_session_expires=90"] = true,
    ["enable_timer=true"] = true,
}

do
    print("[12] A-leg sofia_session_timeout=1800 (setvar, NOT export) on every path")
    local names = {}
    for name in pairs(scenarios) do names[#names+1] = name end
    table.sort(names)
    for _, name in ipairs(names) do
        for _, flag in ipairs({ false, true }) do
            local sc = flag and with_env(scenarios[name], { API_CALLING_ENABLED = "true" })
                or scenarios[name]
            local c = run_scenario(sc)
            local label = string.format("%s (api flag %s)", name, tostring(flag))
            check(label .. ": sofia_session_timeout=1800 set on A-leg",
                  c.setvars["sofia_session_timeout"] == "1800",
                  tostring(c.setvars["sofia_session_timeout"]))
            local late = {}
            for _, t in ipairs(c.timer_seen) do
                if not t:match("=1800$") then late[#late+1] = t end
            end
            check(label .. ": set BEFORE every answer/bridge (" .. #c.timer_seen .. " seen)",
                  #late == 0, table.concat(late, ","))
            local bad = {}
            for _, e in ipairs(c.executes) do
                local d = tostring(e.data)
                if e.app == "export" and (d:match("^sofia_session_timeout") or NOOP_TIMER_EXPORTS[d]) then
                    bad[#bad+1] = e.app .. ":" .. d
                end
            end
            check(label .. ": no session-timer export (sofia_session_timeout / removed no-ops)",
                  #bad == 0, table.concat(bad, ","))
            local leaked = {}
            for _, b in ipairs(c.bridges) do
                if b:find("sofia_session_timeout", 1, true) then leaked[#leaked+1] = b end
            end
            check(label .. ": sofia_session_timeout NOT in any B-leg dial string",
                  #leaked == 0, table.concat(leaked, " | "))
        end
    end
end

-- Optional regression mode against the pre-split router.
local BASELINE = os.getenv("BASELINE_ROUTER")
if BASELINE and BASELINE ~= "" then
    print("[11] BASELINE regression: A-leg state + dial strings (minus [cdr_*]) identical to " .. BASELINE)
    -- Session-timer change (2026-09-24) is normalized out on BOTH sides so
    -- everything else (A-leg vars, dial strings, hangups, other executes)
    -- must be byte-identical: the new router's added setvar
    -- sofia_session_timeout is dropped, and the baseline's removed no-op
    -- exports are dropped. Their presence/absence is asserted by [12].
    local function strip_timer(c, is_baseline)
        local sv = {}
        for k, v in pairs(c.setvars) do
            if is_baseline or k ~= "sofia_session_timeout" then sv[k] = v end
        end
        local ex = {}
        for _, e in ipairs(c.executes) do
            if not (e.app == "export" and NOOP_TIMER_EXPORTS[tostring(e.data)]) then
                ex[#ex+1] = e
            end
        end
        return sv, ex
    end
    local function dump_stripped(c)
        local sv, ex = strip_timer(c, false)
        local copy = { setvars = sv, hangups = c.hangups, executes = ex,
                       answered = c.answered, webhook = c.webhook, bridges = {} }
        for i, b in ipairs(c.bridges) do
            local _, stripped = cdr_block(b)
            copy.bridges[i] = stripped
        end
        return dump(copy)
    end
    -- [cdr_*] blocks are stripped on the baseline side too (cdr_block()
    -- returns a pre-split dial string unchanged), so the baseline may be
    -- either the pre-CDR-split router or any later one (e.g. origin/RCF-V1).
    local function dump_baseline(c)
        local sv, ex = strip_timer(c, true)
        local copy = { setvars = sv, hangups = c.hangups, executes = ex,
                       answered = c.answered, webhook = c.webhook, bridges = {} }
        for i, b in ipairs(c.bridges) do
            local _, stripped = cdr_block(b)
            copy.bridges[i] = stripped
        end
        return dump(copy)
    end
    local names = {}
    for name in pairs(scenarios) do names[#names+1] = name end
    table.sort(names)
    for _, name in ipairs(names) do
        for _, flag in ipairs({ false, true }) do
            local sc = flag and with_env(scenarios[name], { API_CALLING_ENABLED = "true" })
                or scenarios[name]
            local new = dump_stripped(run_scenario(sc))
            local old = dump_baseline(run_scenario(sc, BASELINE))
            check(string.format("%s (api flag %s): identical to baseline", name, tostring(flag)),
                  new == old, "\n--- baseline ---\n" .. old .. "\n--- new ---\n" .. new)
        end
    end
end

print("")
if failures == 0 then
    print("ALL LUA HARNESS ASSERTIONS PASSED")
    os.exit(0)
else
    print(string.format("%d LUA HARNESS ASSERTION(S) FAILED", failures))
    os.exit(1)
end
