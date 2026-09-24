-- Standalone behavioral harness for docker/freeswitch/scripts/trunk_outbound.lua
-- — CDR A/B leg split (docs/CDR_LEG_SPLIT_CONTRACT.md). NOT loaded by
-- FreeSWITCH. Drives the REAL script under a stubbed FreeSWITCH environment
-- (fake db_client, Redis modules absent = the script's fail-open path, the
-- real lib/number_utils.lua) and asserts:
--
--   (1) PBX -> carrier, primary answers: exactly 1 carrier dial string with the
--       per-leg "[cdr_*]" block (cdr_leg_attempt=1, trunk product/customer/
--       trunk_id, direction=outbound); A-leg call-level facts the trunk path
--       never sets (on_net/origin/terminating/inbound_carrier) are OMITTED.
--   (2) Primary fails -> failover: 2 dial strings, attempts 1 and 2,
--       X-Carrier primary/secondary; dial strings minus the block are the
--       pre-split strings byte-for-byte.
--   (3) No cdr_* var is ever set/exported on the A-leg; A-leg direction stays
--       the script's own "outbound" and product_type "trunk".
--   (4) Unauthorized caller DID (reject path) emits no bridge at all.
--
-- Usage: lua tests/lua/trunk_outbound_cdr_harness.lua [path/to/trunk_outbound.lua]
-- Optional: BASELINE_TRUNK=<pre-change trunk_outbound.lua> additionally asserts
-- the captured A-leg state + stripped dial strings are identical to baseline.

local SCRIPT = arg[1] or "docker/freeswitch/scripts/trunk_outbound.lua"
local LIB_DIR = "docker/freeswitch/scripts/lib/"

local function run(sc, script_path)
    local captured = { setvars = {}, bridges = {}, executes = {}, hangups = {} }
    local vars = {
        uuid               = sc.uuid or "218382592_122992403@67.231.13.185",
        destination_number = sc.dest or "+17745550199",
        caller_id_number   = sc.from or "+16175550001",
        caller_id_name     = "PBX User",
        sip_from_user      = sc.from or "+16175550001",
        sip_call_id        = "pbx-callid-1",
        sip_received_ip    = "10.142.0.100",
        trunk_id           = "7",
        customer_id        = "42",
        max_channels       = "10",
        cps_limit          = "10",
        ["sip_h_X-SBC-ID"] = "east-sbc-1",
    }
    local results, idx = sc.bridge_results or { "SUCCESS" }, 0
    local session = {}
    function session:getVariable(k) return vars[k] end
    function session:setVariable(k, v) vars[k] = v; captured.setvars[k] = v end
    function session:ready() return true end
    function session:answer() end
    function session:sleep(_) end
    function session:hangup(c) captured.hangups[#captured.hangups+1] = c end
    function session:execute(app, data)
        if app == "bridge" then
            captured.bridges[#captured.bridges+1] = data
            idx = idx + 1
            vars.originate_disposition = results[idx] or "NORMAL_TEMPORARY_FAILURE"
        else
            captured.executes[#captured.executes+1] = { app = app, data = data }
        end
    end

    local fake_db = {
        lookup_trunk_did = function(did)
            if sc.owned ~= false and did == "+16175550001" then
                return { trunk_id = "7", customer_id = "42" }
            end
            return nil
        end,
        get_connection = function() return nil end,
    }
    local env = setmetatable({
        session = session,
        freeswitch = {
            consoleLog = function() end,
            getGlobalVariable = function() return nil end,
            setGlobalVariable = function() end,
        },
        os = setmetatable({ getenv = function(k)
            if k == "SBC_PROXY_IP" then return "10.0.0.1" end
            if k == "EXTERNAL_SIP_IP" then return "203.0.113.50" end
            if k == "FS_ZONE" then return "east" end
            if k == "TEST_MODE" or k == "BRIDGE_PROGRESS_TIMEOUT" or k == "FS_NODE_ID" then return nil end
            return os.getenv(k)
        end }, { __index = os }),
    }, { __index = _G })
    env.loadfile = function(path)
        if type(path) == "string" then
            if path:match("db_client") then return function() return fake_db end end
            if path:match("redis") then return function() return nil end end
            local lib = path:match("/lib/([%w_]+)%.lua$")
            if lib then return loadfile(LIB_DIR .. lib .. ".lua", "t", env) end
        end
        return loadfile(path)
    end
    env.package = setmetatable({ path = package.path, cpath = package.cpath,
        loadlib = function() return nil, "stubbed" end, loaded = {} }, { __index = package })

    local chunk, err = loadfile(script_path or SCRIPT, "t", env)
    if not chunk then error("loadfile failed: " .. tostring(err)) end
    local ok, e = pcall(chunk)
    if not ok then error("script raised: " .. tostring(e)) end
    return captured
end

local failures = 0
local function check(name, cond, detail)
    if cond then print("  PASS  " .. name)
    else failures = failures + 1; print("  FAIL  " .. name .. " -- " .. tostring(detail)) end
end

local function block(dial)
    local pre, b, post = dial:match("^(.-})%[([^%]]*)%](sofia/.*)$")
    if not b then return nil, dial end
    local t = {}
    for kv in b:gmatch("[^,]+") do
        local k, v = kv:match("^([%w_]+)=(.*)$")
        if k then t[k] = v else t.__bad__ = kv end
    end
    return t, pre .. post
end

local function no_cdr_on_a(c, label)
    local leaked = {}
    for k in pairs(c.setvars) do if k:match("^cdr_") then leaked[#leaked+1] = k end end
    for _, e in ipairs(c.executes) do
        if tostring(e.data):match("cdr_") then leaked[#leaked+1] = e.data end
    end
    check(label .. ": NO cdr_* on the A-leg", #leaked == 0, table.concat(leaked, ","))
end

local function want_dial(carrier)
    return "{ignore_early_media=false,sip_enable_soa=false,progress_timeout=10,call_timeout=60,sip_h_X-Carrier="
        .. carrier .. ",sip_h_X-CID=pbx-callid-1"
        .. ",sip_session_timeout=1800,sip_minimum_session_expires=90,enable_timer=true}sofia/external/+17745550199@10.0.0.1:5060"
end

print("== trunk_outbound_cdr_harness ==")

do
    print("[1] PBX -> carrier, primary answers")
    local c = run({ bridge_results = { "SUCCESS" } })
    check("1 carrier bridge", #c.bridges == 1, #c.bridges)
    local t, stripped = block(c.bridges[1] or "")
    check("[cdr_*] block present before sofia/", t ~= nil, c.bridges[1])
    t = t or {}
    local want = {
        cdr_leg = "B", cdr_carrier_leg = "true", cdr_leg_attempt = "1",
        cdr_direction = "outbound", cdr_call_id = "218382592_122992403@67.231.13.185",
        cdr_customer_id = "42", cdr_product_type = "trunk", cdr_trunk_id = "7",
        cdr_sbc_id = "east-sbc-1",
    }
    for k, v in pairs(want) do check(k .. "=" .. v, t[k] == v, tostring(t[k])) end
    for _, k in ipairs({ "cdr_on_net", "cdr_on_net_hops", "cdr_origin_customer_id",
                         "cdr_terminating_customer_id", "cdr_inbound_carrier",
                         "cdr_inbound_carrier_pop" }) do
        check(k .. " omitted (A-leg never sets it on the trunk path)", t[k] == nil, tostring(t[k]))
    end
    check("no stray fields", t.__bad__ == nil, tostring(t.__bad__))
    check("dial minus block == pre-split primary string", stripped == want_dial("primary"),
          "\n got " .. tostring(stripped) .. "\nwant " .. want_dial("primary"))
    no_cdr_on_a(c, "primary answers")
    check("A-leg direction=outbound product_type=trunk (script's own, unchanged)",
          c.setvars.direction == "outbound" and c.setvars.product_type == "trunk",
          tostring(c.setvars.direction) .. "/" .. tostring(c.setvars.product_type))
    check("no router hangup", #c.hangups == 0, table.concat(c.hangups, ","))
end

do
    print("[2] primary fails -> secondary answers")
    local c = run({ bridge_results = { "NORMAL_TEMPORARY_FAILURE", "SUCCESS" } })
    check("2 carrier bridges", #c.bridges == 2, #c.bridges)
    for i, carrier in ipairs({ "primary", "secondary" }) do
        local t, stripped = block(c.bridges[i] or "")
        check("attempt " .. i .. ": cdr_leg_attempt=" .. i, t and t.cdr_leg_attempt == tostring(i),
              t and t.cdr_leg_attempt)
        check("attempt " .. i .. ": cdr_leg=B + cdr_carrier_leg=true",
              t and t.cdr_leg == "B" and t.cdr_carrier_leg == "true", c.bridges[i])
        check("attempt " .. i .. ": dial minus block == pre-split " .. carrier,
              stripped == want_dial(carrier), stripped)
    end
    no_cdr_on_a(c, "failover")
    check("carrier_used = carrier_secondary", c.setvars.carrier_used == "carrier_secondary",
          c.setvars.carrier_used)
end

do
    print("[3] both fail -> 503, still 2 B-legs")
    local c = run({ bridge_results = { "NORMAL_TEMPORARY_FAILURE", "NO_ANSWER" } })
    check("2 carrier bridges", #c.bridges == 2, #c.bridges)
    check("503", c.hangups[1] == "NORMAL_TEMPORARY_FAILURE", table.concat(c.hangups, ","))
    no_cdr_on_a(c, "both fail")
end

do
    print("[4] unauthorized caller DID -> reject, no bridge")
    local c = run({ owned = false })
    check("CALL_REJECTED", c.hangups[1] == "CALL_REJECTED", table.concat(c.hangups, ","))
    check("no bridge", #c.bridges == 0, #c.bridges)
    no_cdr_on_a(c, "reject")
end

local BASE = os.getenv("BASELINE_TRUNK")
if BASE and BASE ~= "" then
    print("[5] BASELINE regression vs " .. BASE)
    local function dump(c, strip)
        local keys, out = {}, {}
        for k in pairs(c.setvars) do keys[#keys+1] = k end
        table.sort(keys)
        for _, k in ipairs(keys) do out[#out+1] = k .. "=" .. tostring(c.setvars[k]) end
        for _, b in ipairs(c.bridges) do
            local _, s = block(b); out[#out+1] = "#bridge=" .. (strip and s or b)
        end
        for _, e in ipairs(c.executes) do out[#out+1] = "#exec=" .. e.app .. ":" .. tostring(e.data) end
        out[#out+1] = "#hangups=" .. table.concat(c.hangups, ",")
        return table.concat(out, "\n")
    end
    for _, sc in ipairs({ { bridge_results = { "SUCCESS" } },
                          { bridge_results = { "NORMAL_TEMPORARY_FAILURE", "SUCCESS" } },
                          { bridge_results = { "NORMAL_TEMPORARY_FAILURE", "NO_ANSWER" } },
                          { owned = false } }) do
        local new, old = dump(run(sc), true), dump(run(sc, BASE), false)
        check("identical to baseline (" .. table.concat(sc.bridge_results or { "reject" }, "+") .. ")",
              new == old, "\n--- baseline ---\n" .. old .. "\n--- new ---\n" .. new)
    end
end

print("")
if failures == 0 then
    print("ALL TRUNK_OUTBOUND CDR HARNESS ASSERTIONS PASSED"); os.exit(0)
else
    print(failures .. " TRUNK_OUTBOUND CDR HARNESS ASSERTION(S) FAILED"); os.exit(1)
end
