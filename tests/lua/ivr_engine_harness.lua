-- Visual IVR engine harness (docs/IVR_INTERFACES.md §9, P2).
--
-- Drives the REAL docker/freeswitch/scripts/inbound_router.lua (STEP-1 IVR
-- arm, terminate_ivr, ivr_transfer -> the RCF egress / on-net chain) and the
-- real lib/ivr_engine.lua, lib/ivr_prompts.lua, lib/media_leg.lua,
-- lib/schedule.lua, lib/rules.lua under tests/lua/ivr_sandbox.lua (fake
-- session / freeswitch / db, scripted digits, bridge results and clock; the
-- prompt cache is a real scratch directory).
--
-- Plans come from tests/lua/fixtures/ivr_plans/*.json (contract §3). Part [N]
-- runs EVERY plan in a directory through a generic battery (all-timeout,
-- every digit of every menu, invalid keys, open/closed hours, anonymous and
-- known callers, transfers answered and not) — point it at P1's golden
-- compiler fixtures with:
--   IVR_PLAN_DIR=tests/fixtures/ivr lua tests/lua/ivr_engine_harness.lua
-- (a file may be a bare plan or an object with a "plan" / "expected_plan" /
-- "expected" member; files without a plan are skipped and listed).
--
-- [guard] runs over EVERY router run in this harness: each session:execute
-- argument must match an allowlist of shapes (cache-path / system-prompt
-- playback, the exact play_and_get_digits form, limit hash, digit-only
-- exports, carrier/PBX dial strings) and NO argument may contain '$' — so no
-- customer-controlled string can reach FreeSWITCH's ${...} expansion. Hostile
-- plans (injection strings in every field) must fail validation and take the
-- error path.
--
-- Run: lua tests/lua/ivr_engine_harness.lua

local function script_dir()
    local src = debug.getinfo(1, "S").source
    return (src:match("^@(.*)/[^/]*$")) or "."
end
local HERE = script_dir()
local SB = dofile(HERE .. "/ivr_sandbox.lua")
local ENGINE = assert(loadfile(SB.LIBDIR .. "ivr_engine.lua"))()
local PROMPTS = assert(loadfile(SB.LIBDIR .. "ivr_prompts.lua"))()
local FIXTURES = HERE .. "/fixtures/ivr_plans/"

local passes, failures = 0, 0
local function check(name, cond, detail)
    if cond then
        passes = passes + 1
        print("  PASS  " .. name)
    else
        failures = failures + 1
        print("  FAIL  " .. name .. " -- " .. tostring(detail))
    end
end

-- ------------------------------------------------------------------
-- JSON encode (harness-side; preserves ENGINE.NULL) for plan surgery
-- ------------------------------------------------------------------
local function encode(v)
    if v == ENGINE.NULL or v == nil then return "null" end
    local t = type(v)
    if t == "boolean" then return v and "true" or "false" end
    if t == "number" then
        if math.type(v) == "integer" then return string.format("%d", v) end
        return string.format("%.17g", v)
    end
    if t == "string" then
        return '"' .. v:gsub('[%c"\\]', function(c)
            if c == '"' then return '\\"' elseif c == "\\" then return "\\\\" end
            return string.format("\\u%04x", c:byte())
        end) .. '"'
    end
    local n = #v
    local is_arr = n > 0 or next(v) == nil
    if is_arr then
        for k in pairs(v) do if math.type(k) ~= "integer" then is_arr = false break end end
    end
    if is_arr and n > 0 then
        local out = {}
        for i = 1, n do out[i] = encode(v[i]) end
        return "[" .. table.concat(out, ",") .. "]"
    end
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = tostring(k) end
    table.sort(keys)
    if #keys == 0 then return (getmetatable(v) == nil and v.__array) and "[]" or "{}" end
    local out = {}
    for _, k in ipairs(keys) do out[#out + 1] = encode(k) .. ":" .. encode(v[k]) end
    return "{" .. table.concat(out, ",") .. "}"
end

local function read(path) return SB.read_file(path) end
local function fixture(name) return assert(read(FIXTURES .. name), "missing fixture " .. name) end
local function decode(text) return assert(ENGINE.decode_json(text)) end
local function mutate(text, fn)
    local p = decode(text)
    fn(p)
    return encode(p)
end

-- ------------------------------------------------------------------
-- Common wiring
-- ------------------------------------------------------------------
local IVR_DID = "+16175550100"
local OWNER = 11
local GOOD_WAV = SB.wav(0.2, 7)
local SPLIT_HDRS = {
    ["sip_h_X-SBC-ID"] = "east-sbc-1",
    ["sip_h_X-Inbound-Carrier"] = "bandwidth",
    ["sip_h_X-Inbound-PoP"] = "dallas",
    ["sip_h_X-In-Identity"] = "eyJhbGciOiJFUzI1NiJ9.base;info=<https://x5u.example/c.pem>",
}
-- Mon 2026-01-12 15:00Z = 10:00 EST (business hours open)
local MON_10_EST = 1768230000

local function row_for(plan_text, did, extra)
    local p = ENGINE.decode_json(plan_text)
    local r = {
        did = did, ivr_number_id = "5", customer_id = tostring(type(p) == "table" and p.customer_id or OWNER),
        max_channels = "10", enabled = "t",
        flow_id = tostring(type(p) == "table" and p.flow_id or 1),
        flow_version = tostring(type(p) == "table" and p.version or 1),
        plan_json = plan_text, traffic_grade = "standard",
    }
    for k, v in pairs(extra or {}) do
        if v == false then r[k] = nil else r[k] = v end
    end
    return r
end

local function plan_shas(text)
    local p = ENGINE.decode_json(text)
    local out = {}
    if type(p) == "table" and type(p.prompts) == "table" then
        for _, s in ipairs(p.prompts) do if PROMPTS.is_sha(s) then out[#out + 1] = s end end
    end
    return out
end

local function nr(did, ptype, cust, extra)
    local r = { did = did, product_type = ptype, customer_id = tostring(cust), product_ref_id = "1",
                product_enabled = "t", customer_status = "active", ring_timeout = "30", max_channels = "0" }
    for k, v in pairs(extra or {}) do r[k] = v end
    return r
end

local NESTED_DID = "+16175550500"

-- Build an IVR scenario. o: { plan = text, digits, bridge_results, caller,
-- env, now, ... any sandbox field }.
local function ivr_sc(o)
    local plan = o.plan
    local sc = {
        inbound_did = o.inbound_did or IVR_DID,
        sip_from_user = o.caller or "+15085550123",
        caller_id = o.caller or "+15085550123",
        caller_name = o.caller_name,
        extra_vars = SPLIT_HDRS,
        env = { IVR_ENABLED = "true" },
        step1 = o.step1 or {},
        ivr_rows = { [IVR_DID] = row_for(plan, IVR_DID, o.row) },
        oracle = {
            ["+16175550200"] = nr("+16175550200", "rcf", OWNER, { forward_to = "+17745550222", pass_caller_id = "t",
                product_name = "Support line" }),
            ["+16175550300"] = nr("+16175550300", "voicemail", OWNER, { product_ref_id = "77", product_name = "Front desk",
                ring_timeout = nil, max_channels = nil }),
            ["+16175550400"] = nr("+16175550400", "trunk", OWNER, { trunk_id = "21", max_channels = "10" }),
            [NESTED_DID] = nr(NESTED_DID, "ivr", OWNER, { product_ref_id = "6", max_channels = "10", product_name = "Hours line",
                ring_timeout = nil }),
            -- number_routing also lists the IVR's own number (the ivr arm)
            [IVR_DID] = nr(IVR_DID, "ivr", OWNER, { product_ref_id = "5", max_channels = "10", product_name = "Main line",
                ring_timeout = nil }),
        },
        trunk_endpoints = { ["21"] = { "198.51.100.21" } },
        fake_vm_box = true,
        now = o.now or MON_10_EST,
        precache = {},
    }
    sc.ivr_rows[NESTED_DID] = row_for(o.nested_plan or fixture("business_hours.json"), NESTED_DID)
    -- every plan's prompts are cache HITS unless the scenario tests misses
    -- (run() also covers rows added after this point)
    sc.no_auto_precache = o.no_precache
    for k, v in pairs(o) do
        if k ~= "plan" and k ~= "row" and k ~= "caller" and k ~= "nested_plan" and k ~= "no_precache" then
            if k == "env" then for ek, ev in pairs(v) do sc.env[ek] = ev end
            elseif k == "oracle" then for ok_, ov in pairs(v) do sc.oracle[ok_] = ov end
            elseif k == "ivr_rows" then for rk, rv in pairs(v) do sc.ivr_rows[rk] = rv end
            elseif k == "precache" then for pk, pv in pairs(v) do sc.precache[pk] = pv end
            else sc[k] = v end
        end
    end
    return sc
end

local ALL = {}   -- every capture, for the [guard] sweep
local function run(sc)
    if not sc.no_auto_precache then
        sc.precache = sc.precache or {}
        for _, r in pairs(sc.ivr_rows or {}) do
            if type(r) == "table" and type(r.plan_json) == "string" then
                for _, sha in ipairs(plan_shas(r.plan_json)) do
                    if sc.precache[sha] == nil then sc.precache[sha] = GOOD_WAV end
                end
            end
        end
    end
    local cap = SB.run(sc)
    ALL[#ALL + 1] = cap
    if not cap.script_ok then print("    (script raised: " .. tostring(cap.script_err) .. ")") end
    return cap
end

local function exit_of(c) return c.setvars.ivr_exit end
local function path_of(c) return c.setvars.ivr_path end
local function has_event(c, pat)
    for i, e in ipairs(c.events) do if e:find(pat) then return i end end
    return nil
end
local function count_events(c, pat)
    local n = 0
    for _, e in ipairs(c.events) do if e:find(pat) then n = n + 1 end end
    return n
end
local function cache_path(sha) return "/var/lib/crag/ivr-prompts/" .. sha .. ".wav" end
local SHA = function(ch) return string.rep(ch, 64) end
local TECH = "/usr/local/freeswitch/scripts/sounds/ivr/technical_difficulty.wav"
local BYE = "/usr/local/freeswitch/scripts/sounds/ivr/goodbye.wav"
local function pagd(file, timeout)
    return string.format("1 1 1 %d none %s silence_stream://20 ivr_digit . %d", timeout, file, timeout)
end
local function cdr_block_of(dial)
    local block = dial:match("^{.-}%[([^%]]*)%]sofia/")
    if not block then return nil end
    local t = {}
    for kv in block:gmatch("[^,]+") do
        local k, v = kv:match("^([%w_]+)=(.*)$")
        if k then t[k] = v end
    end
    return t
end

local MAIN = fixture("main_menu.json")
local HOURS = fixture("business_hours.json")
local CALLER = fixture("caller_check.json")
local LOOP = fixture("loop_budget.json")
local NESTED = fixture("ivr_to_ivr.json")

print("== ivr_engine_harness ==")

-- ==================================================================
print("[A] IVR_ENABLED gate + number state")
-- ==================================================================
do
    for _, v in ipairs({ false, "false", "", "1", "on", "yes", "truee" }) do
        local c = run(ivr_sc({ plan = MAIN, env = { IVR_ENABLED = v } }))
        local label = "direct IVR DID, IVR_ENABLED=" .. tostring(v)
        check(label .. ": 603 CALL_REJECTED, lua_routed, never answered, no bridge",
            c.hangups[1] == "CALL_REJECTED" and #c.hangups == 1 and c.setvars.lua_routed == "true"
            and not c.answered and #c.bridges == 0, table.concat(c.hangups, ","))
        check(label .. ": CDR identity ivr / owner", c.setvars.product_type == "ivr"
            and c.setvars.customer_id == "11", tostring(c.setvars.product_type))
        check(label .. ": no IVR module work (no prompt fetch, no playback)",
            #c.playbacks == 0 and not has_event(c, "fetch_ivr_prompt_hex"), "")
    end
    for _, v in ipairs({ "true", "TRUE", "  True \t" }) do
        local c = run(ivr_sc({ plan = MAIN, env = { IVR_ENABLED = v }, digits = { "#" } }))
        check("IVR_ENABLED=" .. string.format("%q", v) .. " => IVR runs (answered, exit hangup)",
            c.answered and exit_of(c) == "hangup", exit_of(c))
    end
    -- On-net RCF -> IVR with the gate off: 603 in the chain, no carrier hairpin.
    local sc = ivr_sc({ plan = MAIN, env = { IVR_ENABLED = false },
        inbound_did = "+16170009000",
        step1 = { product_type = "rcf", customer_id = 10, forward_to = IVR_DID, pass_caller_id = true,
                  ring_timeout = 30, max_channels = 0, rcf_name = "Origin" },
        oracle = { [IVR_DID] = nr(IVR_DID, "ivr", OWNER, { product_ref_id = "5", max_channels = "10", ring_timeout = nil }) } })
    local c = run(sc)
    check("on-net RCF -> IVR, gate off: 603, no bridge, not answered",
        c.hangups[1] == "CALL_REJECTED" and #c.bridges == 0 and not c.answered, table.concat(c.hangups, ","))
    check("on-net RCF -> IVR, gate off: customer_id stays the RCF origin (10)", c.setvars.customer_id == "10",
        c.setvars.customer_id)
    -- ... and with the gate on, the on-net chain reaches terminate_ivr.
    sc.env.IVR_ENABLED = "true"
    sc.digits = { "#" }
    c = run(sc)
    check("on-net RCF -> IVR, gate on: answered by the IVR, product_type ivr, customer 11, on_net true hops 1",
        c.answered and c.setvars.product_type == "ivr" and c.setvars.customer_id == "11"
        and c.setvars.on_net == "true" and c.setvars.on_net_hops == "1" and c.setvars.origin_customer_id == "10",
        tostring(c.setvars.product_type) .. "/" .. tostring(c.setvars.customer_id))
    check("on-net RCF -> IVR: the IVR row was read once (version pinning)",
        count_events(c, "db:lookup_ivr_did:%+16175550100") == 1, count_events(c, "db:lookup_ivr_did"))
    -- Disabled / unpublished
    c = run(ivr_sc({ plan = MAIN, row = { enabled = "f" } }))
    check("enabled=false row: 603, not answered", c.hangups[1] == "CALL_REJECTED" and not c.answered, table.concat(c.hangups, ","))
    c = run(ivr_sc({ plan = MAIN, row = { plan_json = false } }))
    check("plan_json NULL (nothing published): 603", c.hangups[1] == "CALL_REJECTED" and not c.answered, table.concat(c.hangups, ","))
    local sc2 = ivr_sc({ plan = MAIN, inbound_did = "+16170009001",
        step1 = { product_type = "rcf", customer_id = 10, forward_to = IVR_DID, pass_caller_id = true,
                  ring_timeout = 30, max_channels = 0 },
        oracle = { [IVR_DID] = nr(IVR_DID, "ivr", OWNER, { product_enabled = "f" }) } })
    c = run(sc2)
    check("on-net to a disabled IVR number: 603", c.hangups[1] == "CALL_REJECTED" and not c.answered, table.concat(c.hangups, ","))
    c = run(ivr_sc({ plan = MAIN, step1 = {}, ivr_rows = { [IVR_DID] = false } }))
    check("not an IVR number (no row): today's 404", c.hangups[1] == "UNALLOCATED_NUMBER", table.concat(c.hangups, ","))
end

-- ==================================================================
print("[B] menus: barge-in, retries, no-input / invalid, last failure type")
-- ==================================================================
local B = cache_path(SHA("b"))
do
    local c = run(ivr_sc({ plan = MAIN, digits = { "1" }, bridge_results = { "SUCCESS" } }))
    check("B1: welcome played, then ONE play_and_get_digits over the menu prompt (barge-in)",
        c.playbacks[1] == cache_path(SHA("a")) and #c.pagd == 1 and c.pagd[1] == pagd(B, 5000), c.pagd[1])
    check("B1: path n_welcome>n_menu:1>n_sales, exit transfer",
        path_of(c) == "n_welcome>n_menu:1>n_sales" and exit_of(c) == "transfer", path_of(c))

    c = run(ivr_sc({ plan = MAIN, digits = { "", "2" }, bridge_results = { "SUCCESS" } }))
    check("B2: no input -> the retry plays noinput prompt THEN the menu (one file_string, barge-in on both)",
        c.pagd[2] == pagd("file_string://" .. cache_path(SHA("d")) .. "!" .. B, 5000), c.pagd[2])
    check("B2: path n_menu:2", path_of(c) == "n_welcome>n_menu:2>n_support", path_of(c))

    c = run(ivr_sc({ plan = MAIN, digits = { "7", "1" }, bridge_results = { "SUCCESS" } }))
    check("B3: key not in digits -> invalid prompt then menu",
        c.pagd[2] == pagd("file_string://" .. cache_path(SHA("c")) .. "!" .. B, 5000), c.pagd[2])

    c = run(ivr_sc({ plan = MAIN, digits = { "", "", "" } }))
    check("B4: retries=2 -> exactly 3 tries", #c.pagd == 3, #c.pagd)
    check("B4: the last failure's no-input prompt plays once before the exit (simulator parity)",
        #c.playbacks == 2 and c.playbacks[2] == cache_path(SHA("d")), table.concat(c.playbacks, " | "))
    check("B4: last failure no-input, on_noinput null -> exit timeout, NORMAL_CLEARING",
        exit_of(c) == "timeout" and c.hangups[#c.hangups] == "NORMAL_CLEARING" and path_of(c) == "n_welcome>n_menu:noinput",
        tostring(exit_of(c)) .. " " .. tostring(path_of(c)))

    c = run(ivr_sc({ plan = MAIN, digits = { "", "5", "" } }))
    check("B5: timeout, invalid, timeout -> on_noinput (last failure = no input)",
        exit_of(c) == "timeout", exit_of(c))
    check("B5: retry prompts follow each failure type (noinput, then invalid)",
        c.pagd[2]:find(SHA("d"), 1, true) and c.pagd[3]:find(SHA("c"), 1, true), c.pagd[3])

    c = run(ivr_sc({ plan = MAIN, digits = { "", "", "*" } }))
    check("B6: timeout, timeout, invalid '*' -> invalid prompt, then on_nomatch n_bye plays its prompt, exit hangup",
        exit_of(c) == "hangup" and path_of(c) == "n_welcome>n_menu:nomatch>n_bye"
        and c.playbacks[#c.playbacks - 1] == cache_path(SHA("c"))
        and c.playbacks[#c.playbacks] == cache_path(SHA("e")), path_of(c))

    c = run(ivr_sc({ plan = MAIN, digits = { "#" } }))
    check("B7: '#' is an ordinary menu key (terminators none); its null branch hangs up (exit hangup)",
        exit_of(c) == "hangup" and path_of(c) == "n_welcome>n_menu:#", path_of(c))

    c = run(ivr_sc({ plan = MAIN, digits = { "0" } }))
    check("B8: 0 -> Hang up block with prompt", exit_of(c) == "hangup" and #c.playbacks == 2, #c.playbacks)

    c = run(ivr_sc({ plan = MAIN, digits = { "" }, hangup_on_pagd = 2 }))
    check("B9: caller hangs up during the menu -> caller_hangup", exit_of(c) == "caller_hangup", exit_of(c))

    c = run(ivr_sc({ plan = MAIN, digits = { "9", "9", "#" } }))
    check("B10: '9' -> back to the same menu (repeat)", path_of(c) == "n_welcome>n_menu:9>n_menu:9>n_menu:#",
        path_of(c))
end

-- ==================================================================
print("[C] budgets: max_steps (goto loops) and max_seconds")
-- ==================================================================
do
    local c = run(ivr_sc({ plan = LOOP, digits = { "9", "9", "9", "9", "9", "9", "9", "9" } }))
    check("C1: menu<->play cycle bounded by max_steps=7 -> exit limit",
        exit_of(c) == "limit", exit_of(c))
    check("C1: goodbye.wav played, then NORMAL_CLEARING",
        c.playbacks[#c.playbacks] == BYE and c.hangups[#c.hangups] == "NORMAL_CLEARING", c.playbacks[#c.playbacks])
    check("C1: exactly 7 node entries in the path", select(2, path_of(c):gsub(">", "")) + 1 == 7, path_of(c))

    c = run(ivr_sc({ plan = LOOP, digits = {} }))
    check("C2: no-input self-loop (retries 0) also bounded -> limit", exit_of(c) == "limit", exit_of(c))

    local short = mutate(MAIN, function(p) p.limits.max_seconds = 10 end)
    c = run(ivr_sc({ plan = short, digits = { "9", "9", "9", "9" }, pagd_secs = 4 }))
    check("C3: max_seconds=10 with 4 s per menu pass -> limit before the 4th pass",
        exit_of(c) == "limit" and #c.pagd == 3, tostring(exit_of(c)) .. " pagd=" .. #c.pagd)

    c = run(ivr_sc({ plan = LOOP, digits = { "1", "1", "1", "1" }, bridge_results = { "NO_ANSWER", "NO_ANSWER", "NO_ANSWER" } }))
    check("C4: a transfer counts once per entry (menu,xfer,menu,xfer,menu,xfer,menu = 7) -> limit",
        exit_of(c) == "limit" and #c.bridges == 3, tostring(exit_of(c)) .. " bridges=" .. #c.bridges)
end

-- ==================================================================
print("[D] Business hours in every pinned TZ around the DST edges")
-- ==================================================================
do
    -- local wall time -> UTC epoch with the zone's offset (hours) that day
    local function utc(y, m, d, h, mi, off)
        local days = 0
        local t = os.time({ year = 2000, month = 1, day = 1, hour = 0 })  -- unused, keeps 5.3 happy
        local function dfc(Y, M, D)
            if M <= 2 then Y = Y - 1 end
            local era = Y // 400
            local yoe = Y - era * 400
            local mp = (M + 9) % 12
            local doy = (153 * mp + 2) // 5 + D - 1
            local doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
            return era * 146097 + doe - 719468
        end
        days = dfc(y, m, d)
        return days * 86400 + h * 3600 + mi * 60 - off * 3600
    end
    -- winter (before 2026-03-08) / summer offsets (zoneinfo)
    local ZONES = {
        { "America/New_York", -5, -4 }, { "America/Detroit", -5, -4 }, { "America/Chicago", -6, -5 },
        { "America/Denver", -7, -6 }, { "America/Phoenix", -7, -7 }, { "America/Los_Angeles", -8, -7 },
        { "America/Anchorage", -9, -8 }, { "Pacific/Honolulu", -10, -10 }, { "America/Puerto_Rico", -4, -4 },
    }
    local CASES = {
        -- { label, y, m, d, h, mi, season, expect_open }
        { "Fri 2026-03-06 08:59 (before spring-forward)", 2026, 3, 6, 8, 59, "w", false },
        { "Fri 2026-03-06 09:00", 2026, 3, 6, 9, 0, "w", true },
        { "Mon 2026-03-09 08:59 (after spring-forward)", 2026, 3, 9, 8, 59, "s", false },
        { "Mon 2026-03-09 09:00", 2026, 3, 9, 9, 0, "s", true },
        { "Fri 2026-10-30 16:59 (before fall-back)", 2026, 10, 30, 16, 59, "s", true },
        { "Fri 2026-10-30 17:00", 2026, 10, 30, 17, 0, "s", false },
        { "Mon 2026-11-02 08:59 (after fall-back)", 2026, 11, 2, 8, 59, "w", false },
        { "Mon 2026-11-02 09:00", 2026, 11, 2, 9, 0, "w", true },
    }
    for _, z in ipairs(ZONES) do
        local plan = mutate(HOURS, function(p) p.nodes.n_hours.tz = z[1] end)
        for _, cs in ipairs(CASES) do
            local off = (cs[7] == "w") and z[2] or z[3]
            local now = utc(cs[2], cs[3], cs[4], cs[5], cs[6], off)
            local c = run(ivr_sc({ plan = plan, now = now, bridge_results = { "SUCCESS" } }))
            local want = cs[8] and "n_hours:open" or "n_hours:closed"
            check(string.format("D %s %s -> %s", z[1], cs[1], cs[8] and "open" or "closed"),
                (path_of(c) or ""):sub(1, #want) == want, path_of(c))
        end
    end
    local c = run(ivr_sc({ plan = HOURS, now = utc(2026, 12, 25, 10, 0, -5) }))
    check("D closed date 2026-12-25 (a Friday, 10:00 EST) -> closed -> voicemail",
        path_of(c) == "n_hours:closed>n_closed>n_vm" and exit_of(c) == "voicemail", path_of(c))
    c = run(ivr_sc({ plan = HOURS, now = utc(2026, 1, 17, 12, 0, -5) }))
    check("D Saturday noon -> closed", (path_of(c) or ""):find("n_hours:closed", 1, true) == 1, path_of(c))
end

-- ==================================================================
print("[E] caller checks: equals / prefix / anonymous")
-- ==================================================================
do
    local c = run(ivr_sc({ plan = CALLER, caller = "+15085550123", bridge_results = { "SUCCESS" } }))
    check("E1 equals -> own trunk DID -> PBX bridge (X-PBX-Dest), exit transfer",
        path_of(c) == "n_vip:match>n_pbx" and c.setvars["sip_h_X-PBX-Dest"] == "198.51.100.21"
        and exit_of(c) == "transfer", path_of(c))
    check("E1 PBX leg is on-net: no [cdr_*] carrier block",
        c.bridges[1] and not c.bridges[1]:find("cdr_leg", 1, true), c.bridges[1])
    check("E1 PBX leg rings for the Transfer block's 30 s (not the trunk default 60)",
        c.bridges[1] and c.bridges[1]:find("call_timeout=30,", 1, true) ~= nil, c.bridges[1])
    c = run(ivr_sc({ plan = CALLER, caller = "6175559999", bridge_results = { "SUCCESS" } }))
    check("E2 prefix +1617 (10-digit caller canonicalized) -> own RCF -> carrier",
        path_of(c) == "n_vip:nomatch>n_local:match>n_rcf" and #c.bridges == 1
        and c.bridges[1]:find("sofia/external/+17745550222@", 1, true), path_of(c))
    c = run(ivr_sc({ plan = CALLER, caller = "anonymous" }))
    check("E3 anonymous -> n_reject (Hang up block)", path_of(c) == "n_vip:nomatch>n_local:nomatch>n_anon:match>n_reject"
        and exit_of(c) == "hangup", path_of(c))
    c = run(ivr_sc({ plan = CALLER, caller = "+13125550000", bridge_results = { "NO_ANSWER" } }))
    check("E4 neither -> n_rcf; no answer + on_noanswer null -> exit hangup",
        path_of(c) == "n_vip:nomatch>n_local:nomatch>n_anon:nomatch>n_rcf:noanswer" and exit_of(c) == "hangup", path_of(c))
end

-- ==================================================================
print("[F] transfers: RCF egress reuse, dispositions, on-net, ownership")
-- ==================================================================
do
    local c = run(ivr_sc({ plan = MAIN, digits = { "1" }, bridge_results = { "SUCCESS" }, play_secs = 3, pagd_secs = 2 }))
    local d = c.bridges[1] or ""
    check("F1 external: exactly one bridge, legacy loop dial string to the target via SBC-1",
        #c.bridges == 1 and d:find("}%[cdr_[^%]]*%]sofia/external/%+17742220100@10%.0%.0%.1:5060$") ~= nil, d)
    check("F1 progress_timeout=10 (never originate_timeout) + call_timeout = the block's 30 s",
        d:find("progress_timeout=10,call_timeout=30,", 1, true) and not d:find("originate_timeout", 1, true), d)
    local blk = cdr_block_of(d) or {}
    check("F1 [cdr_*] B-leg block: cdr_product_type=ivr, cdr_customer_id=11, attempt 1",
        blk.cdr_product_type == "ivr" and blk.cdr_customer_id == "11" and blk.cdr_leg_attempt == "1"
        and blk.cdr_carrier_leg == "true", encode(blk))
    local bv = (c.bridge_vars or {})[1] or {}
    check("F1 From = the IVR DID (Bandwidth auth): export origination_caller_id_number=6175550100",
        has_event(c, "exec:export:origination_caller_id_number=6175550100") ~= nil, "")
    check("F1 pass_caller_id=true: presented = original caller (effective CID, X-Original-CID, RPID)",
        bv.effective_caller_id_number == "5085550123" and bv["sip_h_X-Original-CID"] == "+15085550123"
        and (bv["sip_h_Remote-Party-ID"] or ""):find("<sip:+15085550123@", 1, true), encode(bv))
    check("F1 Diversion = the IVR DID, STIR div, inbound Identity echoed",
        bv["sip_h_Diversion"] == "<sip:6175550100@203.0.113.50>;reason=unconditional"
        and bv["sip_h_X-Attestation"] == "div" and bv["sip_h_X-In-Identity"] ~= nil, encode(bv))
    check("F1 no X-Original-CID-Name (no customer text in SIP headers)", bv["sip_h_X-Original-CID-Name"] == nil, "")
    check("F1 default media: no proxy_media on the transfer", bv.proxy_media == nil and not d:find("proxy_media", 1, true), "")
    check("F1 CDR: exit transfer, ivr_transfer_to, ivr_seconds = answer -> transfer start (3+2 = 5)",
        exit_of(c) == "transfer" and c.setvars.ivr_transfer_to == "+17742220100" and c.setvars.ivr_seconds == "5",
        tostring(c.setvars.ivr_seconds))
    check("F1 A-leg keeps the IVR identity (product_type ivr, customer 11)",
        c.setvars.product_type == "ivr" and c.setvars.customer_id == "11", c.setvars.product_type)
    check("F1 stir_outcome reset/capture ran around the bridge (raw slots consumed)",
        has_event(c, "set:sip_rh_X%-Stir%-Outcome=nil") ~= nil, "")

    c = run(ivr_sc({ plan = MAIN, digits = { "1" }, bridge_results = { "NO_ANSWER" } }))
    check("F2 no answer -> ONE bridge (no re-dial on the next SBC/carrier) -> on_noanswer -> voicemail",
        #c.bridges == 1 and path_of(c) == "n_welcome>n_menu:1>n_sales:noanswer>n_vm" and exit_of(c) == "voicemail",
        path_of(c) .. " bridges=" .. #c.bridges)
    check("F2 never hung up with 503 on the way", not has_event(c, "hangup:NORMAL_TEMPORARY_FAILURE"), "")
    check("F2 vm_box got the mailbox, the DID and the presented caller",
        c.vm_box_calls[1] and c.vm_box_calls[1].mailbox_id == 77 and c.vm_box_calls[1].did == "+16175550300"
        and c.vm_box_calls[1].caller_number == "+15085550123", encode(c.vm_box_calls[1] or {}))
    check("F2 ivr_transfer_to = the LAST transfer target (the mailbox DID)",
        c.setvars.ivr_transfer_to == "+16175550300", c.setvars.ivr_transfer_to)

    c = run(ivr_sc({ plan = MAIN, digits = { "1" }, bridge_results = { "USER_BUSY" } }))
    check("F3 busy -> one bridge -> on_noanswer", #c.bridges == 1 and path_of(c):find("n_sales:busy>n_vm", 1, true), path_of(c))

    c = run(ivr_sc({ plan = MAIN, digits = { "1" } }))
    check("F4 every attempt fails (legacy 4-attempt loop, 4 bridges) -> on_noanswer",
        #c.bridges == 4 and path_of(c):find("n_sales:noanswer>n_vm", 1, true), #c.bridges)
    local attempts = {}
    for i, b in ipairs(c.bridges) do attempts[i] = (cdr_block_of(b) or {}).cdr_leg_attempt end
    check("F4 cdr_leg_attempt 1..4", table.concat(attempts, ",") == "1,2,3,4", table.concat(attempts, ","))

    c = run(ivr_sc({ plan = MAIN, digits = { "1" }, sbc_down = { ["10.0.0.1"] = true },
        term_trunks = { { carrier = "bandwidth", pop = "dallas", term_ip = "67.231.2.12", traffic_class = "ld" },
                        { carrier = "bandwidth", pop = "la", term_ip = "216.82.238.134", traffic_class = "ld" } },
        bridge_results = { "NORMAL_TEMPORARY_FAILURE", "SUCCESS" } }))
    check("F5 table-driven: SBC-1 down skipped (TCP pre-check), carrier failover, X-Carrier-IP, answered",
        #c.bridges == 2 and c.bridges[1]:find("X-Carrier-IP=67.231.2.12", 1, true)
        and c.bridges[2]:find("X-Carrier-IP=216.82.238.134", 1, true) and c.bridges[2]:find("@10.0.0.2:5060", 1, true)
        and exit_of(c) == "transfer" and c.setvars.carrier_used == "bandwidth-la", table.concat(c.bridges, " | "))

    c = run(ivr_sc({ plan = MAIN, digits = { "2" }, bridge_results = { "SUCCESS" } }))
    d = c.bridges[1] or ""
    bv = (c.bridge_vars or {})[1] or {}
    check("F6 own RCF number: chain resolves in memory, ONE carrier bridge to its forward_to",
        #c.bridges == 1 and d:find("sofia/external/+17745550222@", 1, true), d)
    check("F6 the Transfer block's ring time (20 s) overrides the RCF row's 30 s",
        d:find("call_timeout=20,", 1, true) ~= nil, d)
    check("F6 pass_caller_id=false on the block: the IVR DID masks the caller (last false hop wins)",
        bv.effective_caller_id_number == "6175550100" and bv["sip_h_X-Original-CID"] == "+16175550100", encode(bv))
    check("F6 From / Diversion = the forwarding RCF DID (RCF chain semantics)",
        has_event(c, "exec:export:origination_caller_id_number=6175550200")
        and bv["sip_h_Diversion"] == "<sip:6175550200@203.0.113.50>;reason=unconditional", bv["sip_h_Diversion"])
    blk = cdr_block_of(d) or {}
    check("F6 B-leg: cdr_product_type=ivr, on_net=true hops=1, terminating customer 11",
        blk.cdr_product_type == "ivr" and blk.cdr_on_net == "true" and blk.cdr_on_net_hops == "1"
        and blk.cdr_terminating_customer_id == "11", encode(blk))

    c = run(ivr_sc({ plan = MAIN, digits = { "2", "1" }, bridge_results = { "NO_ANSWER", "SUCCESS" } }))
    local bv2 = (c.bridge_vars or {})[2] or {}
    check("F7 second transfer after a no-answer starts clean (CID not left masked by the first)",
        #c.bridges == 2 and bv2.effective_caller_id_number == "5085550123"
        and bv2["sip_h_X-Original-CID"] == "+15085550123"
        and bv2["sip_h_Diversion"] == "<sip:6175550100@203.0.113.50>;reason=unconditional", encode(bv2))
    check("F7 path n_support:noanswer>n_menu:1>n_sales, exit transfer",
        path_of(c) == "n_welcome>n_menu:2>n_support:noanswer>n_menu:1>n_sales" and exit_of(c) == "transfer", path_of(c))
    c = run(ivr_sc({ plan = MAIN, digits = { "2", "2", "#" }, bridge_results = { "NO_ANSWER", "NO_ANSWER" } }))
    check("F7b the same own number twice: no false loop (483), two bridges",
        #c.bridges == 2 and not has_event(c, "EXCHANGE_ROUTING_ERROR"), #c.bridges)
    c = run(ivr_sc({ plan = MAIN, digits = { "2", "#" }, bridge_results = { "NO_ANSWER" } }))
    check("F7c after a failed own-RCF transfer the A-leg on_net/hops are the IVR's again",
        c.setvars.on_net == "false" and c.setvars.on_net_hops == "0", tostring(c.setvars.on_net) .. "/" .. tostring(c.setvars.on_net_hops))

    local function rejected(c2, label, cause)
        check(label .. ": technical_difficulty played, hangup " .. cause .. ", exit error, no bridge",
            c2.playbacks[#c2.playbacks] == TECH and c2.hangups[#c2.hangups] == cause
            and exit_of(c2) == "error" and #c2.bridges == 0,
            tostring(c2.playbacks[#c2.playbacks]) .. " " .. table.concat(c2.hangups, ","))
    end
    c = run(ivr_sc({ plan = MAIN, digits = { "2" },
        oracle = { ["+16175550200"] = nr("+16175550200", "rcf", 99, { forward_to = "+17745550222" }) } }))
    rejected(c, "F8 own number now belongs to another customer", "CALL_REJECTED")
    local sc = ivr_sc({ plan = MAIN, digits = { "2" } })
    sc.oracle["+16175550200"] = nil
    c = run(sc)
    rejected(c, "F9 own number no longer on the platform", "CALL_REJECTED")
    c = run(ivr_sc({ plan = MAIN, digits = { "2" },
        oracle = { ["+16175550200"] = nr("+16175550200", "rcf", OWNER, { product_enabled = "f", forward_to = "+17745550222" }) } }))
    rejected(c, "F10 own number disabled", "CALL_REJECTED")
    c = run(ivr_sc({ plan = MAIN, digits = { "2" },
        oracle = { ["+16175550200"] = nr("+16175550200", "rcf", OWNER, { forward_to = "+16175550100" }) } }))
    rejected(c, "F11 own RCF forwarding back to the IVR (loop)", "EXCHANGE_ROUTING_ERROR")

    c = run(ivr_sc({ plan = MAIN, digits = { "1" }, hangup_on_bridge = 1 }))
    check("F12 caller hangs up while the transfer rings -> caller_hangup, one bridge",
        exit_of(c) == "caller_hangup" and #c.bridges == 1, tostring(exit_of(c)) .. " " .. #c.bridges)

    local tf_trunks = { { carrier = "bandwidth", pop = "dallas", term_ip = "67.231.2.12", traffic_class = "ld" },
                        { carrier = "sinch", pop = "denver-tf", term_ip = "206.146.100.26", traffic_class = "tollfree" } }
    c = run(ivr_sc({ plan = NESTED, digits = { "2" }, term_trunks = tf_trunks, bridge_results = { "SUCCESS" } }))
    check("F13 8YY external: tollfree trunk only (table-driven class filter)",
        #c.bridges == 1 and c.bridges[1]:find("X-Carrier-IP=206.146.100.26", 1, true)
        and c.bridges[1]:find("sofia/external/+18003330199@", 1, true), c.bridges[1])
    c = run(ivr_sc({ plan = NESTED, digits = { "2", "" , ""}, term_trunks = { tf_trunks[1] } }))
    local tf_bridges = 0
    for _, b in ipairs(c.bridges) do if b:find("+18003330199@", 1, true) then tf_bridges = tf_bridges + 1 end end
    check("F14 8YY with no tollfree trunk: fails closed (no 8YY bridge, term_class_blocked) -> on_noanswer",
        tf_bridges == 0 and c.setvars.term_class_blocked == "tollfree"
        and (path_of(c) or ""):find("n_tollfree:noanswer>n_menu", 1, true), path_of(c))

    c = run(ivr_sc({ plan = NESTED, digits = { "1" }, now = 1768554000 --[[ Sat 2026-01-16 09:00Z = closed ]] }))
    check("F15 IVR -> own IVR number: the nested flow runs on the same channel (path continues), exit from it",
        (path_of(c) or ""):find("^n_menu:1>n_hours_ivr>n_hours:") ~= nil and exit_of(c) ~= nil, path_of(c))
    local first_answer = has_event(c, "^answer$")
    local vm = has_event(c, "^vm_box%.run:") or #c.events
    local answers_between = 0
    for i = (first_answer or 1) + 1, vm - 1 do if c.events[i] == "answer" then answers_between = answers_between + 1 end end
    check("F15 the nested IVR's row read once, no second answer by the nested IVR",
        count_events(c, "db:lookup_ivr_did:%+16175550500") == 1 and first_answer and answers_between == 0,
        answers_between)
    check("F15 CDR keeps the FIRST flow's id/version", c.setvars.ivr_flow_id == "16" and c.setvars.ivr_flow_version == "4",
        tostring(c.setvars.ivr_flow_id))
    c = run(ivr_sc({ plan = NESTED, digits = { "1" }, limit_usage = { ["ivr " .. NESTED_DID] = 10 } }))
    check("F16 nested IVR number full (limit_usage = max): busy for the caller IVR, no limit app 486",
        (path_of(c) or ""):find("n_hours_ivr:busy", 1, true) and not has_event(c, "exec:limit:hash ivr %+16175550500"),
        path_of(c))
    c = run(ivr_sc({ plan = MAIN, digits = { "2", "#" },
        oracle = { ["+16175550200"] = nr("+16175550200", "rcf", OWNER, { forward_to = "+17745550222", max_channels = "2" }) },
        limit_usage = { ["inbound +16175550200"] = 2 } }))
    check("F17 own RCF number at max_channels: busy -> on_noanswer, the caller is NOT hung up 486",
        (path_of(c) or ""):find("n_support:busy>n_menu", 1, true) and #c.bridges == 0
        and not has_event(c, "USER_BUSY:limit"), path_of(c))
    c = run(ivr_sc({ plan = MAIN, digits = { "2" }, bridge_results = { "SUCCESS" },
        oracle = { ["+16175550200"] = nr("+16175550200", "rcf", OWNER, { forward_to = "+17745550222", max_channels = "2" }) },
        limit_usage = { ["inbound +16175550200"] = 1 } }))
    check("F18 own RCF number with a free slot: limit hash inbound then the bridge",
        has_event(c, "exec:limit:hash inbound %+16175550200 2 !USER_BUSY") and #c.bridges == 1, "")

    local onnet = ivr_sc({ plan = MAIN, digits = { "1" }, bridge_results = { "SUCCESS" }, inbound_did = "+16170009002",
        step1 = { product_type = "rcf", customer_id = 10, forward_to = IVR_DID, pass_caller_id = true,
                  ring_timeout = 30, max_channels = 0, rcf_name = "Origin" },
        oracle = { [IVR_DID] = nr(IVR_DID, "ivr", OWNER, { product_ref_id = "5", max_channels = "10", ring_timeout = nil }) } })
    c = run(onnet)
    blk = cdr_block_of(c.bridges[1] or "") or {}
    check("F19 RCF -> IVR -> external: B-leg origin = the RCF customer (10), product ivr, customer 11, hops 1",
        blk.cdr_origin_customer_id == "10" and blk.cdr_product_type == "ivr" and blk.cdr_customer_id == "11"
        and blk.cdr_on_net_hops == "1", encode(blk))
end

-- ==================================================================
print("[G] Voicemail block")
-- ==================================================================
do
    local c = run(ivr_sc({ plan = MAIN, digits = { "3" } }))
    check("G1 voicemail block -> terminate_vvm -> vm_box (mailbox 77), no bridge, exit voicemail",
        #c.vm_box_calls == 1 and c.vm_box_calls[1].mailbox_id == 77 and #c.bridges == 0 and exit_of(c) == "voicemail",
        tostring(exit_of(c)))
    check("G1 A-leg identity stays ivr/11 (not voicemail)", c.setvars.product_type == "ivr" and c.setvars.customer_id == "11", "")
    local sc = ivr_sc({ plan = MAIN, digits = { "3" } })
    sc.oracle["+16175550300"] = nr("+16175550300", "voicemail", OWNER, { product_enabled = "f", product_ref_id = "77" })
    c = run(sc)
    check("G2 disabled mailbox -> rejected 603 path (technical difficulty)", exit_of(c) == "error"
        and c.hangups[#c.hangups] == "CALL_REJECTED" and #c.vm_box_calls == 0, table.concat(c.hangups, ","))
end

-- ==================================================================
print("[H] per-number concurrency limit")
-- ==================================================================
do
    local c = run(ivr_sc({ plan = MAIN, row = { max_channels = "2" }, limit_over = { ivr = true } }))
    check("H1 limit hash ivr <did> <max> !USER_BUSY executed", has_event(c, "exec:limit:hash ivr %+16175550100 2 !USER_BUSY"), "")
    check("H1 over the limit: 486 USER_BUSY, never answered, ivr_exit=limit, no prompt work",
        c.hangups[1] == "USER_BUSY" and not c.answered and exit_of(c) == "limit"
        and not has_event(c, "fetch_ivr_prompt_hex"), table.concat(c.hangups, ","))
end

-- ==================================================================
print("[I] prompt cache: miss -> replica -> verify -> atomic write; corrupt / missing -> error")
-- ==================================================================
do
    local wa, wb = SB.wav(0.5, 11), SB.wav(0.3, 12)
    local sa, sb = PROMPTS.sha256_hex(wa), PROMPTS.sha256_hex(wb)
    -- cross-check the pure-Lua sha256 against the system tool when present
    local tool = io.popen("command -v shasum >/dev/null 2>&1 && echo shasum || (command -v sha256sum >/dev/null 2>&1 && echo sha256sum)")
    local which = tool and tool:read("l") or nil
    if tool then tool:close() end
    if which and which ~= "" then
        local tmp = SB.SCRATCH .. "/sha_check.wav"
        SB.write_file(tmp, wa)
        local cmd = (which == "shasum") and ("shasum -a 256 '" .. tmp .. "'") or ("sha256sum '" .. tmp .. "'")
        local p = io.popen(cmd)
        local out = p:read("l") or ""
        p:close()
        check("I0 pure-Lua sha256 == " .. which, out:match("^(%x+)") == sa, out)
    end
    local real = MAIN:gsub(SHA("a"), sa):gsub(SHA("b"), sb)
    local audio = { [sa] = SB.hex(wa), [sb] = SB.hex(wb), [SHA("c")] = SB.hex(GOOD_WAV) }
    -- c,d,e stay synthetic: they are precached (hits); a,b are misses.
    local function sc_real(extra)
        local o = { plan = real, digits = { "#" }, no_precache = true, audio = audio,
                    precache = { [SHA("c")] = GOOD_WAV, [SHA("d")] = GOOD_WAV, [SHA("e")] = GOOD_WAV } }
        for k, v in pairs(extra or {}) do o[k] = v end
        return ivr_sc(o)
    end
    local c = run(sc_real())
    check("I1 miss: both prompts fetched from the replica (and only those)",
        count_events(c, "db:fetch_ivr_prompt_hex:") == 2 and has_event(c, "db:fetch_ivr_prompt_hex:" .. sa)
        and has_event(c, "db:fetch_ivr_prompt_hex:" .. sb), count_events(c, "db:fetch_ivr_prompt_hex:"))
    local w = has_event(c, "io.write:/var/lib/crag/ivr%-prompts/" .. sa .. "%.tmp%.")
    local r = has_event(c, "os.rename:/var/lib/crag/ivr%-prompts/" .. sa .. "%.tmp%.[%w%-]+>/var/lib/crag/ivr%-prompts/" .. sa .. "%.wav")
    local a = has_event(c, "^answer$")
    check("I1 written as <sha>.tmp.<token> then renamed onto <sha>.wav", w and r and w < r, tostring(w) .. " " .. tostring(r))
    check("I1 every fetch + rename happens BEFORE answer, after a 180 (ring_ready)",
        a and r < a and has_event(c, "exec:ring_ready") and has_event(c, "exec:ring_ready") < a, "")
    local files = table.concat(c.cache_files, ",")
    check("I1 cache holds exactly the verified files (no tmp left)",
        not files:find("tmp", 1, true) and files:find(sa .. ".wav", 1, true) and files:find(sb .. ".wav", 1, true), files)
    check("I1 cached bytes are the replica bytes",
        SB.read_file(c.dir .. "/cache/" .. sa .. ".wav") == wa, "")
    check("I1 call proceeds normally (exit hangup on '#')", exit_of(c) == "hangup", exit_of(c))

    local all = { [sa] = wa, [sb] = wb, [SHA("c")] = GOOD_WAV, [SHA("d")] = GOOD_WAV, [SHA("e")] = GOOD_WAV }
    c = run(sc_real({ precache = all }))
    check("I2 hit: no DB fetch, no ring_ready", not has_event(c, "fetch_ivr_prompt_hex") and not has_event(c, "ring_ready"), "")

    local function err_path(c2, label)
        check(label .. ": answered, technical_difficulty played, NORMAL_TEMPORARY_FAILURE, exit error",
            c2.answered and c2.playbacks[1] == TECH and c2.hangups[#c2.hangups] == "NORMAL_TEMPORARY_FAILURE"
            and exit_of(c2) == "error", tostring(c2.playbacks[1]) .. " " .. table.concat(c2.hangups, ","))
        check(label .. ": no menu ran, no tmp/partial file left",
            #c2.pagd == 0 and not table.concat(c2.cache_files, ","):find("tmp", 1, true), table.concat(c2.cache_files, ","))
        check(label .. ": media prepared before that answer",
            c2.answer_vars and c2.answer_vars.rtp_timer_name == "soft", "")
    end
    local bad = {}
    for k, v in pairs(audio) do bad[k] = v end
    bad[sa] = SB.hex(SB.wav(0.5, 99))          -- valid WAV, wrong content
    c = run(sc_real({ audio = bad }))
    err_path(c, "I3 sha256 mismatch (corrupt replica row)")
    check("I3 nothing cached under the requested sha", not table.concat(c.cache_files, ","):find(sa, 1, true), "")

    for _, case in ipairs({
        { "stereo", SB.wav(0.2, 5, 8000, 2) }, { "16 kHz", SB.wav(0.2, 5, 16000) },
        { "truncated", SB.wav(0.2, 5):sub(1, 300) }, { "not RIFF", ("X"):rep(200) },
        { "extra chunk", (function()
            local w2 = SB.wav(0.2, 5)
            return w2:sub(1, 36) .. "LIST" .. string.pack("<I4", 4) .. "INFO" .. w2:sub(37)
        end)() },
    }) do
        local bytes = case[2]
        local sha = PROMPTS.sha256_hex(bytes)
        local plan = MAIN:gsub(SHA("a"), sha)
        local c3 = run(ivr_sc({ plan = plan, no_precache = true, digits = { "#" },
            audio = { [sha] = SB.hex(bytes) },
            precache = { [SHA("b")] = GOOD_WAV, [SHA("c")] = GOOD_WAV, [SHA("d")] = GOOD_WAV, [SHA("e")] = GOOD_WAV } }))
        err_path(c3, "I4 bad header (" .. case[1] .. ", sha correct)")
    end
    local missing = {}
    for k, v in pairs(audio) do missing[k] = v end
    missing[sb] = nil
    c = run(sc_real({ audio = missing }))
    err_path(c, "I5 prompt missing from the replica")
    local qerr = {}
    for k, v in pairs(audio) do qerr[k] = v end
    qerr[sa] = false
    c = run(sc_real({ audio = qerr }))
    err_path(c, "I6 replica query error")
    c = run(sc_real({ precache = { [sa] = SB.wav(0.5, 11):sub(1, 100), [SHA("c")] = GOOD_WAV,
                                   [SHA("d")] = GOOD_WAV, [SHA("e")] = GOOD_WAV } }))
    check("I7 a corrupt cached file is a miss: refetched, replaced, call proceeds",
        has_event(c, "db:fetch_ivr_prompt_hex:" .. sa) and exit_of(c) == "hangup"
        and SB.read_file(c.dir .. "/cache/" .. sa .. ".wav") == wa, exit_of(c))
    c = run(ivr_sc({ plan = MAIN, digits = { "#" }, no_precache = true, sounds = "missing", audio = {} }))
    check("I8 system prompt file missing -> tone fallback, still exit error",
        exit_of(c) == "error" and (c.playbacks[1] or ""):match("^tone_stream://") ~= nil, c.playbacks[1])
    c = run(ivr_sc({ plan = MAIN, digits = { "#" }, missing_lib = { ivr_engine = true } }))
    check("I9 an IVR module fails to load -> error path with the system prompt",
        exit_of(c) == "error" and c.playbacks[1] == TECH, c.playbacks[1])
end

-- ==================================================================
print("[J] CDR variables, path truncation, media clocking")
-- ==================================================================
do
    local c = run(ivr_sc({ plan = MAIN, digits = { "", "9", "0" }, play_secs = 2, pagd_secs = 5 }))
    check("J1 product_type=ivr customer_id=11 ivr_flow_id=12 ivr_flow_version=3",
        c.setvars.product_type == "ivr" and c.setvars.customer_id == "11"
        and c.setvars.ivr_flow_id == "12" and c.setvars.ivr_flow_version == "3", "")
    check("J1 ivr_path with choices", path_of(c) == "n_welcome>n_menu:9>n_menu:0>n_bye", path_of(c))
    check("J1 ivr_seconds = answer -> end (2 + 5 + 5 + 5 + 2 = 19)", c.setvars.ivr_seconds == "19", c.setvars.ivr_seconds)
    check("J1 no ivr_transfer_to without a transfer", c.setvars.ivr_transfer_to == nil, c.setvars.ivr_transfer_to)
    check("J1 CDR vars are plain setVariable (never export)",
        not has_event(c, "exec:export:ivr_"), "")
    check("J2 rtp_timer_name=soft + jitterbuffer_msec=60:200 set BEFORE answer; sofia_session_timeout=1800",
        c.answer_vars and c.answer_vars.rtp_timer_name == "soft" and c.answer_vars.jitterbuffer_msec == "60:200"
        and c.answer_vars.sofia_session_timeout == "1800", encode(c.answer_vars or {}))
    check("J2 playback_terminators=none (a key never cuts a Play block short)", c.setvars.playback_terminators == "none", "")
    local rc = SB.run({ inbound_did = "+16170000020", sip_from_user = "+15085550101",
        step1 = { product_type = "rcf", customer_id = 10, forward_to = "+17742220100", pass_caller_id = true,
                  ring_timeout = 30, max_channels = 0 }, bridge_results = { "SUCCESS" }, env = { IVR_ENABLED = "true" } })
    check("J3 an RCF call never gets the IVR media timer or ivr_* vars",
        rc.setvars.rtp_timer_name == nil and rc.setvars.ivr_exit == nil and rc.setvars.playback_terminators == nil, "")

    -- 512-byte truncation with a trailing U+2026
    local long = mutate(LOOP, function(p)
        p.limits.max_steps = 1000
        local id = string.rep("x", 40)
        p.nodes[id] = p.nodes.n_p
        p.nodes.n_p = nil
        p.nodes.n_m.digits["9"] = id
        p.nodes[id].next = "n_m"
    end)
    local digits = {}
    for i = 1, 40 do digits[i] = "9" end
    digits[41] = "1"
    c = run(ivr_sc({ plan = long, digits = digits, bridge_results = { "SUCCESS" } }))
    local p = path_of(c) or ""
    check("J4 ivr_path capped at 512 bytes with a trailing ellipsis",
        #p == 512 and p:sub(-3) == "\226\128\166", #p)
end

-- ==================================================================
print("[K] closed-world plan validation (each rejection -> error path)")
-- ==================================================================
do
    local cases = {
        { "v != 1", function(p) p.v = 2 end },
        { "flow_id differs from the number's flow", function(p) p.flow_id = 999 end },
        { "customer differs from the number's owner", function(p) p.customer_id = 12 end },
        { "start not a node", function(p) p.start = "n_nope" end },
        { "pointer to a missing node", function(p) p.nodes.n_welcome.next = "n_gone" end },
        { "unknown node type", function(p) p.nodes.n_bye.t = "record" end },
        { "sha not in the prefetch list", function(p) p.nodes.n_bye.prompts = { SHA("9") } end },
        { "uppercase sha", function(p) p.prompts[1] = SHA("A") p.nodes.n_welcome.prompts = { SHA("A") } end },
        { "digit key '10'", function(p) p.nodes.n_menu.digits["10"] = "n_bye" end },
        { "timeout_ms 0", function(p) p.nodes.n_menu.timeout_ms = 0 end },
        { "retries 9", function(p) p.nodes.n_menu.retries = 9 end },
        { "ring_timeout 500", function(p) p.nodes.n_sales.ring_timeout = 500 end },
        { "pass_caller_id as string", function(p) p.nodes.n_sales.pass_caller_id = "true" end },
        { "external 900", function(p) p.nodes.n_sales.dest.e164 = "+19005551234" end },
        { "external 555-01xx", function(p) p.nodes.n_sales.dest.e164 = "+16175550123" end },
        { "external N11 exchange", function(p) p.nodes.n_sales.dest.e164 = "+16174115555" end },
        { "external not NANP", function(p) p.nodes.n_sales.dest.e164 = "+447911123456" end },
        { "external 0XX exchange", function(p) p.nodes.n_sales.dest.e164 = "+16170555555" end },
        { "own product api", function(p) p.nodes.n_support.dest.product = "api" end },
        { "voicemail did short", function(p) p.nodes.n_vm.did = "+1617555" end },
        { "max_steps 0", function(p) p.limits.max_steps = 0 end },
        { "max_seconds 99999", function(p) p.limits.max_seconds = 99999 end },
        { "float version", function(p) p.version = 3.5 end },
    }
    for _, cs in ipairs(cases) do
        local plan = mutate(MAIN, cs[2])
        local loaded, err = ENGINE.load_plan(plan, { flow_id = 12, version = 3, customer_id = 11 })
        check("K load_plan rejects: " .. cs[1], loaded == nil, err)
    end
    local hours_bad = {
        { "tz not pinned", function(p) p.nodes.n_hours.tz = "Europe/London" end },
        { "range end 1441", function(p) p.nodes.n_hours.weekly.mon = { { 540, 1441 } } end },
        { "range start >= end", function(p) p.nodes.n_hours.weekly.mon = { { 600, 600 } } end },
        { "5 ranges", function(p) p.nodes.n_hours.weekly.mon = { { 0, 1 }, { 2, 3 }, { 4, 5 }, { 6, 7 }, { 8, 9 } } end },
        { "bad day key", function(p) p.nodes.n_hours.weekly.monday = { { 0, 60 } } end },
        { "bad date", function(p) p.nodes.n_hours.closed_dates = { "2026-02-30" } end },
    }
    for _, cs in ipairs(hours_bad) do
        local plan = mutate(HOURS, cs[2])
        check("K load_plan rejects (hours): " .. cs[1], ENGINE.load_plan(plan) == nil, "")
    end
    check("K caller value without '+' rejected",
        ENGINE.load_plan(mutate(CALLER, function(p) p.nodes.n_local.values = { "1617" } end)) == nil, "")
    check("K JSON: trailing comma rejected", ENGINE.decode_json('{"a":1,}') == nil, "")
    check("K JSON: duplicate key rejected", ENGINE.decode_json('{"a":1,"a":2}') == nil, "")
    check("K JSON: null preserved as a sentinel", ENGINE.decode_json('{"a":null}').a == ENGINE.NULL, "")
    check("K every fixture loads", ENGINE.load_plan(MAIN) and ENGINE.load_plan(HOURS) and ENGINE.load_plan(CALLER)
        and ENGINE.load_plan(LOOP) and ENGINE.load_plan(NESTED), "")
    local c = run(ivr_sc({ plan = mutate(MAIN, function(p) p.nodes.n_bye.t = "record" end), digits = { "#" } }))
    check("K an invalid plan at call time: error path (system prompt), menu never runs",
        exit_of(c) == "error" and c.playbacks[1] == TECH and #c.pagd == 0, exit_of(c))
end

-- ==================================================================
print("[guard] hostile plans + the session:execute allowlist over every run")
-- ==================================================================
do
    local EVIL = "${system(touch /tmp/ivr-pwn)}"
    local hostile = {
        function(p) p.nodes.n_menu.digits[EVIL] = "n_bye" end,
        function(p) p.nodes[EVIL] = p.nodes.n_bye end,
        function(p) p.start = EVIL end,
        function(p) p.nodes.n_welcome.next = EVIL end,
        function(p) p.prompts[1] = EVIL p.nodes.n_welcome.prompts = { EVIL } end,
        function(p) p.nodes.n_sales.dest.e164 = "+1774555${uuid()}" end,
        function(p) p.nodes.n_support.dest.did = EVIL end,
        function(p) p.nodes.n_vm.did = "+16175550300${x}" end,
        function(p) p.compiler = EVIL end,
        function(p) p.nodes.n_menu.timeout_ms = EVIL end,
        function(p) p.nodes.n_menu.prompts = { "../../../../etc/passwd" } end,
        function(p) p.nodes.n_sales.ring_timeout = "30,originate_timeout=1" end,
    }
    for i, fn in ipairs(hostile) do
        local plan = mutate(MAIN, fn)
        local c = run(ivr_sc({ plan = plan, digits = { "1", "2", "3" }, bridge_results = { "SUCCESS" } }))
        check("guard hostile #" .. i .. ": rejected at validation -> error path", exit_of(c) == "error"
            and #c.bridges == 0 and #c.pagd == 0, exit_of(c))
    end
    local c = run(ivr_sc({ plan = HOURS:gsub("America/New_York", EVIL), bridge_results = { "SUCCESS" } }))
    check("guard hostile tz: error path", exit_of(c) == "error", exit_of(c))
    c = run(ivr_sc({ plan = MAIN, digits = { "1" }, caller_name = EVIL, caller = "+15085550123",
        env = { RCF_FROM_PASSTHROUGH = "on" }, bridge_results = { "SUCCESS" } }))
    check("guard hostile CALLER display name with the From pass-through on: transfer still placed",
        #c.bridges == 1, #c.bridges)
end

-- ==================================================================
print("[N] generic battery over a plan directory")
-- ==================================================================
local function list_json(dir)
    local p = io.popen("ls -1 '" .. dir .. "' 2>/dev/null")
    local out = p and p:read("a") or ""
    if p then p:close() end
    local files = {}
    for n in out:gmatch("[^\n]+") do if n:match("%.json$") then files[#files + 1] = n end end
    table.sort(files)
    return files
end
local function plan_text_of(raw_text)
    local v = ENGINE.decode_json(raw_text)
    if type(v) ~= "table" then return nil end
    if v.nodes ~= nil and v.start ~= nil then return raw_text end
    for _, k in ipairs({ "plan", "expected_plan", "expected", "output" }) do
        if type(v[k]) == "table" and v[k] ~= ENGINE.NULL and v[k].nodes ~= nil then return encode(v[k]) end
    end
    return nil
end
local EXITS = { transfer = true, voicemail = true, hangup = true, caller_hangup = true,
                timeout = true, error = true, limit = true }
local dirs = { FIXTURES }
local extra_dir = os.getenv("IVR_PLAN_DIR")
if extra_dir and extra_dir ~= "" then dirs[#dirs + 1] = extra_dir:gsub("/?$", "/") end
for _, dir in ipairs(dirs) do
    local files = list_json(dir)
    check("N " .. dir .. ": has plan files", #files > 0, dir)
    for _, f in ipairs(files) do
        local text = plan_text_of(read(dir .. f) or "")
        if not text then
            print("    (skipped " .. f .. ": no plan object)")
        else
            local p = ENGINE.decode_json(text)
            local loaded, lerr = ENGINE.load_plan(text)
            check("N " .. f .. ": validates", loaded ~= nil, lerr)
            -- every digit of every menu, plus timeouts and an invalid key
            local scripts = { {}, { "D", "D", "D", "D", "D", "D" } }
            if loaded then
                local keys = {}
                for _, n in pairs(loaded.nodes) do
                    if n.t == "menu" then for d in pairs(n.digits) do keys[d] = true end end
                end
                for d in pairs(keys) do
                    local s = {}
                    for i = 1, 12 do s[i] = d end
                    scripts[#scripts + 1] = s
                end
            end
            -- own targets in the plan resolve to the plan's customer
            local oracle = {}
            if loaded then
                for _, n in pairs(loaded.nodes) do
                    local did, prod = nil, nil
                    if n.t == "transfer" and n.dest.kind == "own" then did, prod = n.dest.e164, n.dest.product end
                    if n.t == "voicemail" then did, prod = n.did, "voicemail" end
                    if did then
                        if prod == "rcf" then
                            oracle[did] = nr(did, "rcf", loaded.customer_id, { forward_to = "+17745559999", pass_caller_id = "t" })
                        elseif prod == "trunk" then
                            oracle[did] = nr(did, "trunk", loaded.customer_id, { trunk_id = "21" })
                        elseif prod == "ivr" then
                            oracle[did] = nr(did, "ivr", loaded.customer_id, { max_channels = "10" })
                        else
                            oracle[did] = nr(did, "voicemail", loaded.customer_id, { product_ref_id = "77" })
                        end
                    end
                end
            end
            local runs, bad = 0, {}
            for _, digits in ipairs(scripts) do
                for _, caller in ipairs({ "+16175551234", "anonymous" }) do
                    for _, br in ipairs({ { "SUCCESS" }, { "NO_ANSWER", "NO_ANSWER", "NO_ANSWER", "NO_ANSWER" } }) do
                        for _, now in ipairs({ MON_10_EST, 1768554000 }) do
                            local sc = ivr_sc({ plan = text, digits = digits, caller = caller, bridge_results = br, now = now,
                                oracle = oracle })
                            -- nested own-IVR targets run a trivial plan of the same customer
                            for did, r in pairs(oracle) do
                                if r.product_type == "ivr" then
                                    sc.ivr_rows[did] = row_for(MAIN:gsub('"customer_id": 11', '"customer_id": '
                                        .. tostring(loaded.customer_id)):gsub('"flow_id": 12', '"flow_id": 1')
                                        :gsub('"version": 3', '"version": 1'), did)
                                end
                            end
                            sc.ivr_rows[IVR_DID].customer_id = tostring(p.customer_id)
                            local c = run(sc)
                            runs = runs + 1
                            local e = exit_of(c)
                            local pth = path_of(c) or ""
                            if not c.script_ok or not EXITS[e] or #pth > 512 or c.up
                                or (loaded and e == "error" and not c.playbacks[1]) then
                                bad[#bad + 1] = string.format("exit=%s up=%s err=%s path=%s", tostring(e),
                                    tostring(c.up), tostring(c.script_err), pth)
                            end
                        end
                    end
                end
            end
            check(string.format("N %s: %d runs end cleanly (known exit, channel hung up, path <= 512)", f, runs),
                #bad == 0, table.concat(bad, " || "))
        end
    end
end

-- Optional: P1-format simulator expectations (<dir>/expectations.json:
-- { <fixture>: { simulations: [ { caller, at, digits, outcome, path|path_len } ] } })
-- replayed through the REAL engine with every transfer answered (the
-- simulator's assumption). Compares the outcome and the last node.
local function iso_epoch(iso)
    local y, mo, d, h, mi, se = tostring(iso):match("^(%d+)-(%d+)-(%d+)T(%d+):(%d+):(%d+)Z$")
    if not y then return nil end
    local sched = assert(loadfile(SB.LIBDIR .. "schedule.lua"))()
    return sched.utc_epoch(tonumber(y), tonumber(mo), tonumber(d), tonumber(h), tonumber(mi)) + tonumber(se)
end
for _, dir in ipairs(dirs) do
    local etext = read(dir .. "expectations.json")
    local exp = etext and ENGINE.decode_json(etext)
    if type(exp) == "table" then
        print("[N] " .. dir .. "expectations.json: simulator parity")
        local names = {}
        for k in pairs(exp) do if not k:match("^_") then names[#names + 1] = k end end
        table.sort(names)
        for _, name in ipairs(names) do
            local raw = read(dir .. name .. ".plan.json") or read(dir .. name .. ".json")
            local text = raw and plan_text_of(raw)
            local sims = type(exp[name]) == "table" and exp[name].simulations or nil
            if text and type(sims) == "table" then
                local loaded = ENGINE.load_plan(text)
                local oracle = {}
                for _, n in pairs(loaded and loaded.nodes or {}) do
                    local did, prod = nil, nil
                    if n.t == "transfer" and n.dest.kind == "own" then did, prod = n.dest.e164, n.dest.product end
                    if n.t == "voicemail" then did, prod = n.did, "voicemail" end
                    if did then
                        local ptype = (prod == "trunk" or prod == "ivr" or prod == "voicemail") and prod or "rcf"
                        oracle[did] = nr(did, ptype, loaded.customer_id, { forward_to = "+17745559999",
                            pass_caller_id = "t", trunk_id = "21", product_ref_id = "77", max_channels = "10" })
                    end
                end
                for i, sim in ipairs(sims) do
                    local digits = {}
                    for j, dg in ipairs(sim.digits or {}) do digits[j] = dg end
                    local sc = ivr_sc({ plan = text, digits = digits, caller = sim.caller,
                        now = iso_epoch(sim.at), bridge_results = { "SUCCESS", "SUCCESS" }, oracle = oracle })
                    sc.ivr_rows[IVR_DID].customer_id = tostring(loaded and loaded.customer_id or OWNER)
                    for did, r in pairs(oracle) do
                        if r.product_type == "ivr" then sc.ivr_rows[did] = row_for(MAIN, did) end
                    end
                    local c = run(sc)
                    local e = exit_of(c)
                    local nodes = {}
                    for tok in ((path_of(c) or "") .. ">"):gmatch("([^>]*)>") do
                        nodes[#nodes + 1] = tok:match("^([^:]+)")
                    end
                    -- The simulator stops at the first Transfer / Voicemail
                    -- block (it assumes the transfer is answered); the real
                    -- call may continue past it (an own IVR number runs that
                    -- IVR), so compare against the first such block reached.
                    local last = nodes[#nodes]
                    for _, nid in ipairs(nodes) do
                        local nt = loaded and loaded.nodes[nid] and loaded.nodes[nid].t
                        if nt == "transfer" or nt == "voicemail" then last = nid break end
                    end
                    local last_t = loaded and last and loaded.nodes[last] and loaded.nodes[last].t
                    local want = sim.outcome
                    local got = (e == "timeout") and "hangup" or e
                    if want == "transfer" and last_t == "transfer" then got = "transfer" end
                    local want_last = type(sim.path) == "table" and sim.path[#sim.path] or nil
                    check(string.format("N parity %s #%d: outcome %s%s", name, i, tostring(want),
                            want_last and (", ends at " .. want_last) or ""),
                        got == want and (not want_last or want_last == last),
                        string.format("got %s, path %s", tostring(e), tostring(path_of(c))))
                end
            end
        end
    end
end

-- ------------------------------------------------------------------
-- [guard] sweep: EVERY execute argument of EVERY run in this harness
-- ------------------------------------------------------------------
do
    local CACHE = "/var/lib/crag/ivr%-prompts/[0-9a-f]+%.wav"
    local function is_cache(s) return s:match("^" .. CACHE .. "$") ~= nil and #s == #"/var/lib/crag/ivr-prompts/" + 64 + 4 end
    local function is_prompt_file(s)
        if is_cache(s) then return true end
        local list = s:match("^file_string://(.+)$")
        if not list then return false end
        for item in (list .. "!"):gmatch("([^!]*)!") do
            if not is_cache(item) then return false end
        end
        return true
    end
    local SYSTEM = { [TECH] = true, [BYE] = true,
        ["tone_stream://L=6;%(250,250,480,620)"] = true, ["tone_stream://%(300,100,480);%(300,0,400)"] = true }
    local function allowed(app, data)
        data = data or ""
        if data:find("$", 1, true) then return false, "contains $" end
        if app == "playback" then
            return is_cache(data) or SYSTEM[data] == true, "playback"
        elseif app == "play_and_get_digits" then
            local t, file, t2 = data:match("^1 1 1 (%d+) none (%S+) silence_stream://20 ivr_digit %. (%d+)$")
            return t ~= nil and t == t2 and is_prompt_file(file), "pagd"
        elseif app == "limit" then
            return data:match("^hash ivr %+%d+ %d+ !USER_BUSY$") ~= nil
                or data:match("^hash inbound %+%d+ %d+ !USER_BUSY$") ~= nil, "limit"
        elseif app == "export" then
            return data:match("^origination_caller_id_number=%+?%d+$") ~= nil
                or data:match("^origination_caller_id_name=[^%${}]*$") ~= nil, "export"
        elseif app == "bridge" then
            return data:match("^{[%w_=.,:%-+@~!%%*/]+}%[[%w_=.,:%-+@~!%%*/]*%]sofia/external/%+1%d+@[%d.]+:5060$") ~= nil
                or data:match("^{[%w_=.,:%-+@~!%%*/]+}sofia/external/%+?1%d+@[%d.]+:5060$") ~= nil, "bridge"
        elseif app == "ring_ready" then
            return data == "" , "ring_ready"
        end
        return false, "app not allowlisted"
    end
    local bad, n = {}, 0
    for _, c in ipairs(ALL) do
        for _, e in ipairs(c.execs) do
            n = n + 1
            local ok, why = allowed(e.app, e.data)
            if not ok then bad[#bad + 1] = why .. ": " .. tostring(e.app) .. " " .. tostring(e.data) end
        end
    end
    check(string.format("guard: all %d session:execute calls in %d runs match the allowlist (no '$')", n, #ALL),
        #bad == 0, table.concat(bad, "\n    "))
end

print("")
print(string.format("%d passed, %d failed", passes, failures))
SB.cleanup()
if failures == 0 then
    print("ALL IVR ENGINE HARNESS ASSERTIONS PASSED")
    os.exit(0)
end
os.exit(1)
