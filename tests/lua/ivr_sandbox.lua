-- tests/lua/ivr_sandbox.lua — shared FreeSWITCH sandbox for the IVR harnesses
-- (ivr_egress_identity_harness.lua, ivr_engine_harness.lua). House style of
-- tests/lua/onnet_router_harness.lua / voicemail_harness.lua: the REAL
-- docker/freeswitch/scripts/inbound_router.lua runs under stubbed `session`,
-- `freeswitch`, `os`, `io` and `loadfile`, and EVERY observable side effect is
-- appended, in order, to one event log:
--   set:<k>=<v>   session:setVariable  ("" deletes, as in FreeSWITCH)
--   exec:<app>:<data>  session:execute (bridge/playback/limit/export/...)
--   answer / hangup:<cause> / log:<LEVEL>:<msg> / api:<cmd> / global:<k>=<v>
--   db:<fn>:<arg>  fake db_client calls      os.execute:<cmd>
-- The identity harness compares two routers' logs byte for byte; the engine
-- harness asserts on the same capture.
--
-- dofile()d by the harnesses: returns M with M.run(sc, script_path).
-- Lua 5.3+ (the local `lua` is 5.5; nothing here needs more than 5.3).

local M = {}

local real_io, real_os = io, os

local function script_dir()
    local src = debug.getinfo(1, "S").source
    return (src:match("^@(.*)/[^/]*$")) or "."
end
M.REPO = script_dir() .. "/../.."
M.ROUTER = M.REPO .. "/docker/freeswitch/scripts/inbound_router.lua"
M.LIBDIR = M.REPO .. "/docker/freeswitch/scripts/lib/"
M.SOUNDS = M.REPO .. "/docker/freeswitch/scripts/sounds/"

-- ------------------------------------------------------------------
-- Scratch space (one dir per scenario: the prompt cache maps into it)
-- ------------------------------------------------------------------
local SCRATCH = real_os.tmpname()
real_os.remove(SCRATCH)
assert(real_os.execute("mkdir -p '" .. SCRATCH .. "'"))
M.SCRATCH = SCRATCH
local scenario_no = 0

function M.cleanup()
    real_os.execute("rm -rf '" .. SCRATCH .. "'")
end

function M.write_file(path, content)
    local f = assert(real_io.open(path, "wb"))
    f:write(content)
    f:close()
end

function M.read_file(path)
    local f = real_io.open(path, "rb")
    if not f then return nil end
    local s = f:read("a")
    f:close()
    return s
end

function M.list_dir(dir)
    local p = real_io.popen("ls -A '" .. dir .. "' 2>/dev/null")
    local out = p:read("a") or ""
    p:close()
    local names = {}
    for n in out:gmatch("[^\n]+") do names[#names + 1] = n end
    table.sort(names)
    return names
end

-- Canonical 8 kHz mono PCM16 WAV; `seed` varies the samples so shas differ.
function M.wav(secs, seed, rate, channels)
    rate = rate or 8000
    channels = channels or 1
    local n = math.floor(secs * rate + 0.5)
    local parts = {}
    local s = seed or 1
    for i = 1, n do
        s = (s * 1103515245 + 12345) % 2147483648
        parts[i] = string.pack("<i2", (s % 2001) - 1000)
    end
    local data = table.concat(parts)
    if channels == 2 then data = data .. data end
    local byte_rate = rate * 2 * channels
    return "RIFF" .. string.pack("<I4", 36 + #data) .. "WAVE" .. "fmt "
        .. string.pack("<I4I2I2I4I4I2I2", 16, 1, channels, rate, byte_rate, 2 * channels, 16)
        .. "data" .. string.pack("<I4", #data) .. data
end

function M.hex(bytes)
    return (bytes:gsub(".", function(c) return string.format("%02x", c:byte()) end))
end

-- ------------------------------------------------------------------
-- run(sc, script_path) -> cap
-- ------------------------------------------------------------------
-- sc fields (all optional unless noted):
--   inbound_did (req), caller_id, caller_name, sip_from_user, uuid
--   extra_vars              inbound channel vars (sip_h_X-...)
--   env                     os.getenv overrides (false = unset)
--   step1 = { product_type = rcf|api|trunk|voicemail, ... }  STEP-1 row
--   ivr_rows = { [did] = ivr_fs_number row }  (db.lookup_ivr_did)
--   oracle  = { [e164] = number_routing row }  (db.resolve_destination)
--   resolve_raises = true
--   trunk_endpoints = { [trunk_id] = { ip, ... } }
--   term_trunks = { ... }   (db.get_termination_trunks; absent = legacy)
--   sbc_down = { [ip] = true }
--   bridge_results = { "SUCCESS" | cause, ... }  per launched bridge
--   hangup_on_bridge = N    caller hangs up during the Nth bridge
--   limit_over = { [realm] = true }   the limit app finds the realm full
--   limit_usage = { ["<realm> <id>"] = n }   freeswitch.API limit_usage
--   digits = { "1", "", "#", ... }   per play_and_get_digits ("" = timeout)
--   hangup_on_pagd = N      caller hangs up during the Nth play_and_get_digits
--   audio = { [sha] = hex | false }   ivr_prompt_audio (false = query error)
--   precache = { [sha] = bytes }      files already in the prompt cache
--   now = epoch, play_secs, pagd_secs, bridge_secs   (scripted clock)
--   fake_vm_box = true      replace lib/vm_box.lua with a recorder
--   no_db = true            db_client fails to load
--   missing_lib = { name = true }   loadfile of lib/<name>.lua fails
--   sounds = "missing"      system prompts absent
function M.run(sc, script_path)
    scenario_no = scenario_no + 1
    local dir = SCRATCH .. "/s" .. scenario_no
    assert(real_os.execute("mkdir -p '" .. dir .. "/cache' '" .. dir .. "/nosounds'"))
    for sha, bytes in pairs(sc.precache or {}) do
        M.write_file(dir .. "/cache/" .. sha .. ".wav", bytes)
    end

    local cap = {
        events = {}, setvars = {}, bridges = {}, execs = {}, hangups = {},
        logs = {}, api = {}, db = {}, answered = false, pagd = {}, playbacks = {},
        vm_box_calls = {}, dir = dir,
    }
    local function ev(s) cap.events[#cap.events + 1] = s end

    local clock = sc.now or 1767225600   -- 2026-01-01T00:00:00Z
    local up = true
    local session_vars = {
        uuid               = sc.uuid or ("u-" .. tostring(sc.inbound_did)),
        destination_number = sc.inbound_did,
        caller_id_number   = sc.caller_id or "+15085550123",
        caller_id_name     = sc.caller_name or "",
        sip_from_user      = sc.sip_from_user or sc.caller_id or "+15085550123",
        sip_from_display   = sc.sip_from_display or "",
        sip_call_id        = "callid-" .. tostring(sc.inbound_did),
        sip_received_ip    = "67.231.2.12",
        network_addr       = "67.231.2.12",
    }
    for k, v in pairs(sc.extra_vars or {}) do session_vars[k] = v end

    -- path mapping (container path -> scratch / repo)
    local function map(p)
        if type(p) ~= "string" then return p end
        local rest = p:match("^/var/lib/crag/ivr%-prompts/(.*)$")
        if rest then return dir .. "/cache/" .. rest end
        if p == "/var/lib/crag/ivr-prompts" then return dir .. "/cache" end
        rest = p:match("^/usr/local/freeswitch/scripts/sounds/(.*)$")
        if rest then
            if sc.sounds == "missing" then return dir .. "/nosounds/" .. rest end
            return M.SOUNDS .. rest
        end
        if p:match("^/usr/local/") or p:match("^/var/") then return dir .. "/nonexistent" end
        return p
    end

    -- ---- session ----
    local session = {}
    local bridge_idx, pagd_idx = 0, 0
    function session:getVariable(k) return session_vars[k] end
    function session:setVariable(k, v)
        if v == "" then v = nil end
        session_vars[k] = v
        cap.setvars[k] = v
        ev("set:" .. tostring(k) .. "=" .. tostring(v))
    end
    function session:ready() return up end
    function session:answered() return cap.answered end
    function session:answer()
        if not up then return end
        if not cap.answered then
            cap.answered = true
            cap.answered_at = clock
            cap.answer_vars = {
                rtp_timer_name = session_vars.rtp_timer_name,
                jitterbuffer_msec = session_vars.jitterbuffer_msec,
                sofia_session_timeout = session_vars.sofia_session_timeout,
            }
        end
        ev("answer")
    end
    function session:preAnswer() ev("preanswer") end
    function session:sleep(ms) ev("sleep:" .. tostring(ms)) end
    function session:hangup(cause)
        cause = cause or "NORMAL_CLEARING"
        cap.hangups[#cap.hangups + 1] = cause
        ev("hangup:" .. tostring(cause) .. ":" .. (up and "up" or "down"))
        up = false
    end
    function session:execute(app, data)
        cap.execs[#cap.execs + 1] = { app = app, data = data }
        ev("exec:" .. tostring(app) .. ":" .. tostring(data))
        if app == "bridge" then
            bridge_idx = bridge_idx + 1
            cap.bridges[#cap.bridges + 1] = data
            cap.bridge_vars = cap.bridge_vars or {}
            -- A-leg vars FS would copy to the B-leg at THIS bridge
            local snap = {}
            for k, v in pairs(session_vars) do
                if type(k) == "string" and (k:match("^sip_h_") or k:match("caller_id_") or k == "proxy_media") then
                    snap[k] = v
                end
            end
            cap.bridge_vars[#cap.bridge_vars + 1] = snap
            clock = clock + (sc.bridge_secs or 0)
            if sc.hangup_on_bridge == bridge_idx then
                up = false
                session_vars.originate_disposition = "ORIGINATOR_CANCEL"
                return
            end
            local r = (sc.bridge_results or {})[bridge_idx] or "NORMAL_TEMPORARY_FAILURE"
            session_vars.originate_disposition = r
            session_vars.last_bridge_hangup_cause = (r ~= "SUCCESS") and r or "NORMAL_CLEARING"
            if r == "SUCCESS" then
                -- hangup_after_bridge=true: the A-leg ends with the B-leg
                if session_vars.hangup_after_bridge == "true" then up = false end
            end
        elseif app == "limit" then
            local realm = tostring(data):match("^hash (%S+)")
            if sc.limit_over and sc.limit_over[realm] then
                local act = tostring(data):match("!(%u[%u_]*)$")
                cap.hangups[#cap.hangups + 1] = act or "limit_exceeded"
                ev("hangup:" .. tostring(act) .. ":limit")
                up = false
            end
        elseif app == "playback" then
            if up then
                cap.playbacks[#cap.playbacks + 1] = data
                clock = clock + (sc.play_secs or 0)
            end
        elseif app == "play_and_get_digits" then
            pagd_idx = pagd_idx + 1
            cap.pagd[#cap.pagd + 1] = data
            clock = clock + (sc.pagd_secs or 0)
            if sc.hangup_on_pagd == pagd_idx then up = false return end
            local var = tostring(data):match("^%S+ %S+ %S+ %S+ %S+ %S+ %S+ (%S+)")
            local d = (sc.digits or {})[pagd_idx] or ""
            if var then
                session_vars[var] = (d ~= "") and d or nil
            end
        elseif app == "lua" and data == "voice_webhook.lua" then
            cap.webhook = true
        end
    end

    -- ---- freeswitch ----
    -- Pre-seeded SBC health cache (no real TCP probe): stamped with the
    -- SANDBOX clock, which is what the router's os.time() returns.
    local globals = {}
    for _, ip in ipairs({ "10.0.0.1", "10.0.0.2" }) do
        globals["sbc_health_" .. ip] = string.format("%s:%d",
            (sc.sbc_down and sc.sbc_down[ip]) and "down" or "up", clock)
    end
    local freeswitch = {
        consoleLog = function(level, msg)
            cap.logs[#cap.logs + 1] = { level = level, msg = msg }
            ev("log:" .. tostring(level) .. ":" .. tostring(msg))
        end,
        getGlobalVariable = function(k) return globals[k] end,
        setGlobalVariable = function(k, v) globals[k] = v; ev("global:" .. k .. "=" .. tostring(v)) end,
        msleep = function(ms) ev("msleep:" .. tostring(ms)) end,
        API = function()
            return {
                executeString = function(_, cmd)
                    cap.api[#cap.api + 1] = cmd
                    ev("api:" .. tostring(cmd))
                    local key = tostring(cmd):match("^limit_usage hash (.+)$")
                    if key then return tostring((sc.limit_usage or {})[key] or 0) end
                    return ""
                end,
            }
        end,
    }

    -- ---- fake db_client ----
    local s1 = sc.step1 or {}
    local function call(name, arg) cap.db[#cap.db + 1] = name .. ":" .. tostring(arg); ev("db:" .. name .. ":" .. tostring(arg)) end
    local fake_db = {
        lookup_rcf = function(did)
            call("lookup_rcf", did)
            if s1.product_type == "rcf" and did == sc.inbound_did then
                return {
                    customer_id = tostring(s1.customer_id), forward_to = s1.forward_to,
                    pass_caller_id = (s1.pass_caller_id == false) and "f" or "t",
                    ring_timeout = tostring(s1.ring_timeout or 30),
                    max_channels = tostring(s1.max_channels or 0), name = s1.rcf_name,
                    traffic_grade = "standard", cpm_limit = "60", daily_limit = "500", status = "active",
                }
            end
        end,
        lookup_api_did = function(did)
            call("lookup_api_did", did)
            if s1.product_type == "api" and did == sc.inbound_did then
                return { customer_id = tostring(s1.customer_id), voice_url = s1.voice_url,
                         fallback_url = s1.fallback_url, traffic_grade = "standard", status = "active" }
            end
        end,
        lookup_trunk_did = function(did)
            call("lookup_trunk_did", did)
            if s1.product_type == "trunk" and did == sc.inbound_did then
                return { trunk_id = s1.trunk_id, customer_id = tostring(s1.customer_id),
                         max_channels = "10", traffic_grade = "standard", status = "active" }
            end
        end,
        lookup_voicemail_did = function(did)
            call("lookup_voicemail_did", did)
            if s1.product_type == "voicemail" and did == sc.inbound_did then
                return {
                    did = sc.inbound_did, product_type = "voicemail",
                    customer_id = tostring(s1.customer_id), product_ref_id = tostring(s1.mailbox_id or 42),
                    product_enabled = (s1.enabled == false) and "f" or "t",
                    customer_status = s1.customer_status or "active",
                    product_name = "Voicemail", traffic_grade = "premium",
                }
            end
        end,
        lookup_ivr_did = function(did)
            call("lookup_ivr_did", did)
            return (sc.ivr_rows or {})[did]
        end,
        resolve_destination = function(did)
            call("resolve_destination", did)
            if sc.resolve_raises then error("injected resolve failure") end
            return (sc.oracle or {})[did]
        end,
        get_trunk_endpoint_ips = function(trunk_id)
            call("get_trunk_endpoint_ips", trunk_id)
            return (sc.trunk_endpoints or {})[tostring(trunk_id)]
        end,
        fetch_ivr_prompt_hex = function(sha)
            call("fetch_ivr_prompt_hex", sha)
            local a = (sc.audio or {})[sha]
            if a == false then return nil, "query failed" end
            if a == nil then return nil, "no row" end
            return a
        end,
    }
    if sc.term_trunks then
        fake_db.get_termination_trunks = function(z) call("get_termination_trunks", z); return sc.term_trunks end
    end
    if sc.db_without_ivr then fake_db.lookup_ivr_did = nil end

    -- ---- os ----
    local sc_env = sc.env or {}
    local PINNED = {
        SBC_PROXY_IP = "10.0.0.1", SBC_PROXY_IP_FAILOVER = "10.0.0.2",
        EXTERNAL_SIP_IP = "203.0.113.50", FS_ZONE = "east",
        API_HOST = "10.142.0.103", API_PORT = "8000",
    }
    local UNSET = { API_CALLING_ENABLED = true, TEST_MODE = true, RCF_FROM_PASSTHROUGH = true,
        BRIDGE_PROGRESS_TIMEOUT = true, FS_NODE_ID = true, IVR_ENABLED = true, DOMAIN = true }
    local sandbox_os = setmetatable({
        getenv = function(k)
            if sc_env[k] ~= nil then
                if sc_env[k] == false then return nil end
                return sc_env[k]
            end
            if PINNED[k] ~= nil then return PINNED[k] end
            if UNSET[k] then return nil end
            return real_os.getenv(k)
        end,
        time = function(t) if t then return real_os.time(t) end return clock end,
        remove = function(p) ev("os.remove:" .. tostring(p)); return real_os.remove(map(p)) end,
        rename = function(a, b) ev("os.rename:" .. tostring(a) .. ">" .. tostring(b)); return real_os.rename(map(a), map(b)) end,
        execute = function(cmd) ev("os.execute:" .. tostring(cmd)); return true, "exit", 0 end,
    }, { __index = real_os })

    -- ---- io ----
    local sandbox_io = setmetatable({}, { __index = real_io })
    sandbox_io.open = function(p, mode)
        if mode and mode:match("w") and type(p) == "string" and p:match("^/var/lib/crag/ivr%-prompts/") then
            ev("io.write:" .. p)
        end
        return real_io.open(map(p), mode)
    end
    sandbox_io.popen = function(cmd) ev("io.popen:" .. tostring(cmd)); error("popen not allowed in this sandbox") end

    -- ---- sandbox env ----
    local env
    env = setmetatable({
        session = session, freeswitch = freeswitch, os = sandbox_os, io = sandbox_io,
    }, { __index = _G })
    env.loadfile = function(path)
        if type(path) ~= "string" then return nil, "bad path" end
        if path:match("db_client") then
            if sc.no_db then return nil, "cannot open " .. path end
            return function() return fake_db end
        end
        local name = path:match("^/usr/local/freeswitch/scripts/lib/([%w_]+)%.lua$")
        if name then
            if sc.missing_lib and sc.missing_lib[name] then return nil, "cannot open " .. path end
            if name == "vm_box" and sc.fake_vm_box then
                return function()
                    return {
                        run = function(sess, args)
                            cap.vm_box_calls[#cap.vm_box_calls + 1] = args
                            ev("vm_box.run:" .. tostring(args.mailbox_id) .. ":" .. tostring(args.did)
                                .. ":" .. tostring(args.caller_number))
                            sess:answer()
                            sess:hangup("NORMAL_CLEARING")
                        end,
                    }
                end
            end
            return loadfile(M.LIBDIR .. name .. ".lua", "t", env)
        end
        return nil, "cannot open " .. path
    end
    env.package = setmetatable({
        path = package.path, cpath = package.cpath,
        loadlib = function() return nil, "stubbed" end, loaded = {},
    }, { __index = package })
    env.require = function(name)
        if name == "socket" then error("luasocket stubbed out") end
        return require(name)
    end

    local chunk, err = loadfile(script_path or M.ROUTER, "t", env)
    if not chunk then error("loadfile router: " .. tostring(err)) end
    local ok, run_err = pcall(chunk)
    cap.script_ok = ok
    cap.script_err = run_err
    cap.vars = session_vars
    cap.up = up
    cap.cache_files = M.list_dir(dir .. "/cache")
    return cap
end

return M
