-- Standalone behavioral harness for the encrypted-voicemail FreeSWITCH side:
--   docker/freeswitch/scripts/inbound_router.lua  (STEP-1 voicemail arm,
--                                                  terminate_vvm, on-net chain)
--   docker/freeswitch/scripts/lib/vm_box.lua       (call flow)
--   docker/freeswitch/scripts/lib/vm_deposit.lua   (curl client, retry table)
--   docker/freeswitch/scripts/lib/json.lua         (JSON encode/decode)
-- Contract: docs/ENCRYPTED_VOICEMAIL_INTERFACES.md §5/§6; build plan §6.
--
-- Drives the REAL scripts under a stubbed FreeSWITCH environment (same style
-- as tests/lua/onnet_router_harness.lua). Nothing touches the network or a
-- shell except the harness's own scratch-dir housekeeping:
--   * io.popen is a scripted fake: every command string the code would run is
--     CAPTURED VERBATIM (so tests assert exactly what /bin/sh would receive)
--     and answered from the scenario (HTTP code/body/exit code, or a raise).
--   * os.execute is captured, never run.
--   * fixed container paths are mapped onto a per-scenario scratch dir:
--       /dev/shm/vm/*                    -> <scratch>/vm/*   (REAL files: the
--                                           record stub writes a real WAV, so
--                                           "unlinked on every path" is
--                                           checked on the real filesystem)
--       /run/revup/vm_ingest.header      -> <scratch>/header (or missing)
--       /proc/self/mounts                -> <scratch>/mounts
--       /usr/local/freeswitch/scripts/sounds/vm/*  -> repo sounds (or empty)
--       /usr/local/freeswitch/scripts/lib/*.lua    -> repo lib, loaded INTO the
--                                           sandbox so nested loadfile/io/os
--                                           resolve to the stubs too
--
-- Run:  lua tests/lua/voicemail_harness.lua            (from the repo root)

local function script_dir()
    local src = debug.getinfo(1, "S").source
    return (src:match("^@(.*)/[^/]*$")) or "."
end
local REPO = script_dir() .. "/../.."
local ROUTER = REPO .. "/docker/freeswitch/scripts/inbound_router.lua"
local LIBDIR = REPO .. "/docker/freeswitch/scripts/lib/"
local SOUNDS = REPO .. "/docker/freeswitch/scripts/sounds/vm/"

local real_io, real_os = io, os

-- ------------------------------------------------------------------
-- Scratch space
-- ------------------------------------------------------------------
local SCRATCH = real_os.tmpname()
real_os.remove(SCRATCH)
assert(real_os.execute("mkdir -p '" .. SCRATCH .. "'"))
local scenario_no = 0

local function write_file(path, content)
    local f = assert(real_io.open(path, "wb"))
    f:write(content)
    f:close()
end

local function list_dir(dir)
    local p = real_io.popen("ls -A '" .. dir .. "' 2>/dev/null")
    local out = p:read("*a") or ""
    p:close()
    local names = {}
    for n in out:gmatch("[^\n]+") do names[#names + 1] = n end
    return names
end

local function le32(v)
    return string.char(v % 256, math.floor(v / 256) % 256,
        math.floor(v / 65536) % 256, math.floor(v / 16777216) % 256)
end
local function le16(v) return string.char(v % 256, math.floor(v / 256) % 256) end

-- Canonical PCM16 mono WAV of `secs` seconds.
local function wav_bytes(secs, rate)
    rate = rate or 8000
    local n = math.floor(secs * rate + 0.5)
    local data_len = n * 2
    return "RIFF" .. le32(36 + data_len) .. "WAVE" .. "fmt " .. le32(16) .. le16(1)
        .. le16(1) .. le32(rate) .. le32(rate * 2) .. le16(2) .. le16(16)
        .. "data" .. le32(data_len) .. string.rep("\0\0", n)
end

local GOOD_SECRET_LINE = "X-Ingest-Secret: " .. string.rep("s3cr3t", 8) .. "\n"
local MOUNTS_OK = table.concat({
    "overlay / overlay rw,relatime 0 0",
    "shm /dev/shm tmpfs rw,nosuid,nodev,noexec,relatime,size=65536k 0 0",
    "tmpfs /dev/shm/vm tmpfs rw,nosuid,nodev,noexec,relatime,size=524288k,mode=700 0 0",
}, "\n") .. "\n"
local MOUNTS_NO_VM = "overlay / overlay rw,relatime 0 0\nshm /dev/shm tmpfs rw 0 0\n"

local UUID4 = "%x%x%x%x%x%x%x%x%-%x%x%x%x%-4%x%x%x%-[89ab]%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x"

-- ------------------------------------------------------------------
-- Scenario runner
-- ------------------------------------------------------------------
-- sc fields (all optional unless noted):
--   inbound_did (req), caller_id, caller_name, sip_from_user, uuid
--   step1 = { product_type = "rcf"|"voicemail"|..., ... }  STEP-1 row
--   oracle = { [e164] = number_routing row }                 on-net rows
--   env = { API_HOST=..., ... } overrides
--   header = string | false (false = missing file)
--   mounts = string
--   sounds = "repo" | "missing"
--   mailbox = { code=, body=, exit= } | function(cmd) | "raise"
--   greeting = { code=, content=, exit= }
--   deposits = { {code=, body=, exit=} | "raise", ... }   (in attempt order)
--   record = { secs=, hangup=true, nofile=true, raise=true }
--   hangup_during_greeting = true
--   raise_on_rec_open = N   (io.open of the message file raises on the Nth open)
--   vm_box_missing = true
--   sweep_last = epoch      (pre-seeded vm_sweep_last global)
local function run_scenario(sc)
    scenario_no = scenario_no + 1
    local dir = SCRATCH .. "/s" .. scenario_no
    assert(real_os.execute("mkdir -p '" .. dir .. "/vm' '" .. dir .. "/nosounds'"))
    local header_path = dir .. "/header"
    if sc.header ~= false then
        write_file(header_path, sc.header or GOOD_SECRET_LINE)
    end
    write_file(dir .. "/mounts", sc.mounts or MOUNTS_OK)

    local cap = {
        setvars = {}, events = {}, popen = {}, execs = {}, hangups = {},
        playbacks = {}, records = {}, bridges = {}, msleeps = {}, logs = {},
        db_calls = {}, answered = false, rec_open_count = 0,
        rec_exists_at_record = nil, greeting_exists_at_record = nil,
    }
    local function ev(s) cap.events[#cap.events + 1] = s end

    local up = true
    local session_vars = {
        uuid               = sc.uuid or "callid-1234@67.231.2.12",
        destination_number = sc.inbound_did,
        caller_id_number   = sc.caller_id or "+15085550123",
        caller_id_name     = sc.caller_name or "",
        sip_from_user      = sc.sip_from_user or sc.caller_id or "+15085550123",
        sip_from_display   = "",
        sip_call_id        = "callid-1234@67.231.2.12",
        sip_received_ip    = "67.231.2.12",
        network_addr       = "67.231.2.12",
    }

    -- path mapping (container path -> scratch/repo path)
    local function map(p)
        if type(p) ~= "string" then return p end
        local rest = p:match("^/dev/shm/vm/(.*)$")
        if rest then return dir .. "/vm/" .. rest end
        if p == "/dev/shm/vm" then return dir .. "/vm" end
        if p == "/run/revup/vm_ingest.header" then return header_path end
        if p == "/proc/self/mounts" then return dir .. "/mounts" end
        rest = p:match("^/usr/local/freeswitch/scripts/sounds/vm/(.*)$")
        if rest then
            if sc.sounds == "missing" then return dir .. "/nosounds/" .. rest end
            return SOUNDS .. rest
        end
        if p:match("^/usr/local/") then return dir .. "/nonexistent" end
        return p
    end

    local function is_msg_path(p)
        return type(p) == "string" and p:match("^/dev/shm/vm/" .. UUID4 .. "%.wav$") ~= nil
    end

    -- ---- io stub ----
    local sandbox_io = setmetatable({}, { __index = real_io })
    sandbox_io.open = function(p, mode)
        if is_msg_path(p) and sc.raise_on_rec_open then
            cap.rec_open_count = cap.rec_open_count + 1
            if cap.rec_open_count == sc.raise_on_rec_open then
                error("injected io.open failure")
            end
        end
        return real_io.open(map(p), mode)
    end

    local function fake_handle(stdout, exit_code)
        local h = {}
        function h:read(_) return stdout end
        function h:close()
            if exit_code == 0 then return true, "exit", 0 end
            return nil, "exit", exit_code
        end
        return h
    end

    local deposit_idx = 0
    sandbox_io.popen = function(cmd, mode)
        cap.popen[#cap.popen + 1] = cmd
        local ready_now = up
        if cmd:find("/v1/voicemail/fs/mailbox/", 1, true) then
            ev("popen:mailbox")
            local m = sc.mailbox
            if m == "raise" then error("injected popen failure") end
            if type(m) == "function" then m = m(cmd) end
            m = m or { code = "200", body = '{"mailbox_id":42,"customer_id":77,"did":"+15550009999","status":"active","accepting":true,"reason":null,"max_message_seconds":300,"greeting":null}' }
            return fake_handle((m.body or "") .. "\n" .. m.code, m.exit or 0)
        elseif cmd:find("/v1/voicemail/fs/greetings/", 1, true) then
            ev("popen:greeting")
            local g = sc.greeting or { code = "404" }
            local out = cmd:match(" %-o '([^']+)'")
            if g.code == "200" and out then
                write_file(map(out), g.content or wav_bytes(2))
            end
            return fake_handle(g.code, g.exit or 0)
        elseif cmd:find("/v1/voicemail/fs/deposit", 1, true) then
            deposit_idx = deposit_idx + 1
            ev("popen:deposit:" .. (ready_now and "up" or "down"))
            local d = (sc.deposits or {})[deposit_idx]
                or { code = "200", body = '{"status":"stored","message_id":9001}' }
            if d == "raise" then error("injected popen failure") end
            -- the real curl reads the file: it must exist at this moment
            local src = cmd:match("%-%-data%-binary '@([^']+)'")
            local f = src and real_io.open(map(src), "rb")
            cap.deposit_file_present = cap.deposit_file_present or {}
            cap.deposit_file_present[#cap.deposit_file_present + 1] = (f ~= nil)
            if f then
                cap.deposit_bytes = f:read("*a")
                f:close()
            end
            return fake_handle((d.body or "") .. "\n" .. d.code, d.exit or 0)
        end
        ev("popen:other")
        return fake_handle("", 0)
    end

    -- ---- os stub ----
    local sc_env = sc.env or {}
    local PINNED = {
        SBC_PROXY_IP = "10.0.0.1", SBC_PROXY_IP_FAILOVER = "10.0.0.2",
        EXTERNAL_SIP_IP = "203.0.113.50", FS_ZONE = "east",
        API_HOST = "10.142.0.103", API_PORT = "8000",
    }
    local UNSET = { API_CALLING_ENABLED = true, TEST_MODE = true,
        RCF_FROM_PASSTHROUGH = true, BRIDGE_PROGRESS_TIMEOUT = true, FS_NODE_ID = true }
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
        remove = function(p)
            ev("remove:" .. tostring(p))
            return real_os.remove(map(p))
        end,
        execute = function(cmd)
            cap.execs[#cap.execs + 1] = cmd
            ev("os.execute")
            return true, "exit", 0
        end,
    }, { __index = real_os })

    -- ---- session stub ----
    local session = {}
    function session:getVariable(k) return session_vars[k] end
    function session:setVariable(k, v)
        if v == "" then v = nil end
        session_vars[k] = v
        cap.setvars[k] = v
    end
    function session:ready() return up end
    function session:answer() cap.answered = true; ev("answer") end
    function session:sleep(ms) ev("sleep:" .. tostring(ms)) end
    function session:hangup(cause)
        cap.hangups[#cap.hangups + 1] = cause or "NORMAL_CLEARING"
        ev("hangup:" .. tostring(cause) .. ":" .. (up and "up" or "down"))
        up = false
    end
    function session:execute(app, data)
        if app == "bridge" then
            cap.bridges[#cap.bridges + 1] = data
            session_vars.originate_disposition = "SUCCESS"
        elseif app == "playback" then
            if not up then return end
            cap.playbacks[#cap.playbacks + 1] = data
            ev("playback:" .. data)
            if sc.hangup_during_greeting and (data:match("default_greeting") or data:match("/g_")) then
                up = false
            end
        elseif app == "record" then
            if not up then return end
            cap.records[#cap.records + 1] = data
            ev("record:" .. data)
            local path = data:match("^(%S+)")
            -- greeting file must already be gone, nothing else in the dir
            local names = list_dir(dir .. "/vm")
            cap.vm_dir_at_record = names
            local r = sc.record or { secs = 12 }
            if not r.nofile then
                write_file(map(path), wav_bytes(r.secs or 12))
            end
            session_vars.record_ms = tostring(math.floor((r.secs or 12) * 1000))
            if r.raise then error("injected record failure") end
            if r.hangup then up = false end
        else
            ev("execute:" .. app)
        end
    end

    -- ---- freeswitch stub ----
    local globals = {}
    for _, ip in ipairs({ "10.0.0.1", "10.0.0.2" }) do
        globals["sbc_health_" .. ip] = string.format("up:%d", real_os.time())
    end
    if sc.sweep_last then globals["vm_sweep_last"] = tostring(sc.sweep_last) end
    local freeswitch = {
        consoleLog = function(level, msg) cap.logs[#cap.logs + 1] = { level = level, msg = msg } end,
        getGlobalVariable = function(k) return globals[k] end,
        setGlobalVariable = function(k, v) globals[k] = v end,
        msleep = function(ms) cap.msleeps[#cap.msleeps + 1] = ms; ev("msleep:" .. ms) end,
    }

    -- ---- fake db ----
    local s1 = sc.step1 or {}
    local function call(name, did) cap.db_calls[#cap.db_calls + 1] = name .. ":" .. tostring(did) end
    local fake_db = {
        lookup_rcf = function(did)
            call("rcf", did)
            if s1.product_type == "rcf" and did == sc.inbound_did then
                return {
                    customer_id = tostring(s1.customer_id), forward_to = s1.forward_to,
                    pass_caller_id = (s1.pass_caller_id == false) and "f" or "t",
                    ring_timeout = "30", max_channels = "0", name = s1.rcf_name,
                    traffic_grade = "standard", cpm_limit = "60", daily_limit = "500", status = "active",
                }
            end
        end,
        lookup_api_did = function(did) call("api", did) end,
        lookup_trunk_did = function(did) call("trunk", did) end,
        lookup_voicemail_did = function(did)
            call("voicemail", did)
            if s1.product_type == "voicemail" and did == sc.inbound_did then
                return {
                    did = sc.inbound_did, product_type = "voicemail",
                    customer_id = tostring(s1.customer_id),
                    product_ref_id = tostring(s1.mailbox_id),
                    product_enabled = (s1.enabled == false) and "f" or "t",
                    customer_status = s1.customer_status or "active",
                    product_name = s1.label or "Voicemail",
                    traffic_grade = s1.traffic_grade or "premium",
                }
            end
        end,
        resolve_destination = function(did) call("resolve", did); return (sc.oracle or {})[did] end,
        get_trunk_endpoint_ips = function() return nil end,
    }

    -- ---- sandbox ----
    local env
    env = setmetatable({
        session = session, freeswitch = freeswitch, os = sandbox_os, io = sandbox_io,
    }, { __index = _G })
    env.loadfile = function(path)
        if type(path) ~= "string" then return nil, "bad path" end
        if path:match("db_client") then
            return function() return fake_db end
        end
        local name = path:match("^/usr/local/freeswitch/scripts/lib/([%w_]+)%.lua$")
        if name then
            if name == "vm_box" and sc.vm_box_missing then
                return nil, "cannot open " .. path
            end
            return loadfile(LIBDIR .. name .. ".lua", "t", env)
        end
        return nil, "cannot open " .. path
    end
    env.package = setmetatable({
        path = package.path, cpath = package.cpath,
        loadlib = function() return nil, "stubbed" end, loaded = {},
    }, { __index = package })

    local chunk, err = loadfile(ROUTER, "t", env)
    if not chunk then error("loadfile router: " .. tostring(err)) end
    local ok, run_err = pcall(chunk)
    cap.script_ok = ok
    cap.script_err = run_err
    cap.vm_dir_after = list_dir(dir .. "/vm")
    cap.session_vars = session_vars
    cap.dir = dir
    return cap
end

-- ------------------------------------------------------------------
-- Assertions
-- ------------------------------------------------------------------
local failures, passes = 0, 0
local function check(name, cond, detail)
    if cond then
        passes = passes + 1
        print("  PASS  " .. name)
    else
        failures = failures + 1
        print("  FAIL  " .. name .. " -- " .. tostring(detail))
    end
end

local function count(t, pred)
    local n = 0
    for _, v in ipairs(t) do if pred(v) then n = n + 1 end end
    return n
end

local function find_event(cap, prefix)
    for i, e in ipairs(cap.events) do
        if e:sub(1, #prefix) == prefix then return i end
    end
    return nil
end

local function popen_kind(cap, frag)
    local out = {}
    for _, c in ipairs(cap.popen) do
        if c:find(frag, 1, true) then out[#out + 1] = c end
    end
    return out
end

local function has_log(cap, level, frag)
    for _, l in ipairs(cap.logs) do
        if (level == nil or l.level == level) and l.msg:find(frag, 1, true) then return true end
    end
    return false
end

-- Modules (in a plain env) for unit checks and expected-value construction.
local function plain_load(name)
    local env = setmetatable({ freeswitch = { consoleLog = function() end } }, { __index = _G })
    env.loadfile = function(p)
        local n = p:match("/lib/([%w_]+)%.lua$")
        return loadfile(LIBDIR .. n .. ".lua", "t", env)
    end
    return assert(loadfile(LIBDIR .. name .. ".lua", "t", env))()
end
local json = plain_load("json")
local dep = plain_load("vm_deposit")

local function meta_of(cmd)
    local b64 = cmd:match("'X%-VM%-Meta: ([^']*)'")
    return b64, b64 and json.decode(dep.b64url_decode(b64) or "")
end

local API = "http://10.142.0.103:8000"
local HDR = "-H @/run/revup/vm_ingest.header"
local function expected_mailbox_cmd(id)
    return "curl -q -s --noproxy '*' --connect-timeout 2 --max-time 3 " .. HDR
        .. " -H 'Accept: application/json' -w '\\n%{http_code}' '" .. API
        .. "/v1/voicemail/fs/mailbox/" .. id .. "' 2>/dev/null"
end
local function expected_deposit_cmd(path, b64)
    return "curl -q -s --noproxy '*' --connect-timeout 3 --max-time 15 " .. HDR
        .. " -H 'Content-Type: audio/wav' -H 'Expect:' -H 'X-VM-Meta: " .. b64
        .. "' --data-binary '@" .. path .. "' -w '\\n%{http_code}' '" .. API
        .. "/v1/voicemail/fs/deposit' 2>/dev/null"
end
local function expected_greeting_cmd(id, path)
    return "curl -q -s --noproxy '*' --connect-timeout 2 --max-time 5 --max-filesize 6291456 "
        .. HDR .. " -o '" .. path .. "' -w '%{http_code}' '" .. API
        .. "/v1/voicemail/fs/greetings/" .. id .. "/audio' 2>/dev/null"
end
local SWEEP_CMD = "find /dev/shm/vm -mindepth 1 -maxdepth 1 -type f -mmin +15 -delete >/dev/null 2>&1"

-- Common fixtures
local MAILBOX_DID = "+15550009999"
local function direct(extra)
    local sc = {
        inbound_did = MAILBOX_DID,
        step1 = { product_type = "voicemail", customer_id = 77, mailbox_id = 42 },
    }
    for k, v in pairs(extra or {}) do sc[k] = v end
    return sc
end
local VM_ORACLE_ROW = {
    did = MAILBOX_DID, product_type = "voicemail", customer_id = "77",
    product_ref_id = "42", product_enabled = "t", customer_status = "active",
    forward_to = nil, pass_caller_id = nil, ring_timeout = nil, max_channels = nil,
    product_name = "Front desk VM", voice_url = nil, fallback_url = nil, trunk_id = nil,
}
local function copy(t) local c = {} for k, v in pairs(t) do c[k] = v end return c end

local function rec_path_of(cap)
    local r = cap.records[1]
    return r and r:match("^(%S+)")
end

local function assert_clean(tag, cap)
    check(tag .. ": /dev/shm/vm empty after the call", #cap.vm_dir_after == 0,
        table.concat(cap.vm_dir_after, ","))
    check(tag .. ": script did not raise", cap.script_ok, cap.script_err)
end

print("== voicemail_harness ==")

-- ==================================================================
-- [1] Direct dial -> terminate_vvm -> record -> deposit (happy path)
-- ==================================================================
do
    print("[1] direct dial to a mailbox DID: answer, default greeting, record, deposit 200")
    local c = run_scenario(direct({
        caller_id = "+15085550123", sip_from_user = "+15085550123", caller_name = "Jane Caller",
        mailbox = { code = "200", body = '{"mailbox_id":42,"customer_id":77,"did":"+15550009999","status":"active","accepting":true,"reason":null,"max_message_seconds":120,"greeting":null}' },
    }))
    local v = c.setvars
    check("product_type=voicemail", v.product_type == "voicemail", v.product_type)
    check("customer_id = mailbox owner (77)", v.customer_id == "77", v.customer_id)
    check("terminating_customer_id = 77", v.terminating_customer_id == "77", v.terminating_customer_id)
    check("origin_customer_id = 77 (direct)", v.origin_customer_id == "77", v.origin_customer_id)
    check("on_net=false, hops=0", v.on_net == "false" and v.on_net_hops == "0", tostring(v.on_net) .. "/" .. tostring(v.on_net_hops))
    check("traffic_grade from the customer row", v.traffic_grade == "premium", v.traffic_grade)
    check("lua_routed=true", v.lua_routed == "true", v.lua_routed)
    check("no bridge / no carrier dial string", #c.bridges == 0, #c.bridges)
    check("STEP-1 order rcf -> api -> trunk -> voicemail",
        c.db_calls[1] == "rcf:" .. MAILBOX_DID and c.db_calls[2] == "api:" .. MAILBOX_DID
        and c.db_calls[3] == "trunk:" .. MAILBOX_DID and c.db_calls[4] == "voicemail:" .. MAILBOX_DID,
        table.concat(c.db_calls, ","))
    check("answered", c.answered, c.answered)
    check("default greeting prompt file played",
        c.playbacks[1] == "/usr/local/freeswitch/scripts/sounds/vm/default_greeting.wav", c.playbacks[1])
    check("beep tone after greeting", c.playbacks[2] == "tone_stream://%(500,0,1000)", c.playbacks[2])
    check("'#' terminator + 8 kHz record rate",
        c.setvars.playback_terminators == "#" and c.setvars.record_sample_rate == "8000",
        tostring(c.setvars.playback_terminators) .. "/" .. tostring(c.setvars.record_sample_rate))
    local rp = rec_path_of(c)
    check("record path = /dev/shm/vm/<uuid4>.wav", rp and rp:match("^/dev/shm/vm/" .. UUID4 .. "%.wav$"), rp)
    check("record args: max_message_seconds from API, silence 200/5",
        c.records[1] == rp .. " 120 200 5", c.records[1])
    local msg_uuid = rp and rp:match("^/dev/shm/vm/(.*)%.wav$")
    check("vm_msg_uuid CDR var = record file uuid", c.setvars.vm_msg_uuid == msg_uuid, c.setvars.vm_msg_uuid)
    check("exactly 2 commands (mailbox GET, deposit POST)", #c.popen == 2, #c.popen)
    check("mailbox GET command is exact", c.popen[1] == expected_mailbox_cmd(42), c.popen[1])
    local b64, meta = meta_of(c.popen[2] or "")
    check("X-VM-Meta is base64url (no padding)", b64 and b64:match("^[A-Za-z0-9_-]+$"), b64)
    check("deposit POST command is exact", c.popen[2] == expected_deposit_cmd(rp, b64 or "?"), c.popen[2])
    check("meta v=1", meta and meta.v == 1, meta and meta.v)
    check("meta msg_uuid = record uuid", meta and meta.msg_uuid == msg_uuid, meta and meta.msg_uuid)
    check("meta mailbox_id=42 (number)", meta and meta.mailbox_id == 42, meta and meta.mailbox_id)
    check("meta did", meta and meta.did == MAILBOX_DID, meta and meta.did)
    check("meta caller number/name", meta and meta.caller_id_number == "+15085550123"
        and meta.caller_id_name == "Jane Caller", meta and (tostring(meta.caller_id_number) .. "/" .. tostring(meta.caller_id_name)))
    check("meta duration_ms = 12000 (from the WAV)", meta and meta.duration_ms == 12000, meta and meta.duration_ms)
    check("meta call_uuid = FS uuid", meta and meta.call_uuid == "callid-1234@67.231.2.12", meta and meta.call_uuid)
    check("meta fs_node/zone", meta and meta.fs_node == "east-fs" and meta.zone == "east",
        meta and (tostring(meta.fs_node) .. "/" .. tostring(meta.zone)))
    check("deposit body = the recorded WAV bytes", c.deposit_bytes == wav_bytes(12), c.deposit_bytes and #c.deposit_bytes)
    local hi, di = find_event(c, "hangup:NORMAL_CLEARING:up"), find_event(c, "popen:deposit")
    check("caller hung up by FS BEFORE the deposit", hi and di and hi < di, tostring(hi) .. " vs " .. tostring(di))
    check("deposit ran on a hung-up channel", c.events[di or 1] == "popen:deposit:down", c.events[di or 1])
    check("vm_result=stored, vm_message_id=9001", c.setvars.vm_result == "stored" and c.setvars.vm_message_id == "9001",
        tostring(c.setvars.vm_result) .. "/" .. tostring(c.setvars.vm_message_id))
    check("vm_deposit_http=200 attempts=1", c.setvars.vm_deposit_http == "200" and c.setvars.vm_deposit_attempts == "1",
        tostring(c.setvars.vm_deposit_http) .. "/" .. tostring(c.setvars.vm_deposit_attempts))
    check("no msleep on success", #c.msleeps == 0, #c.msleeps)
    check("opportunistic sweep runs the exact constant command", c.execs[1] == SWEEP_CMD, c.execs[1])
    assert_clean("[1]", c)
end

-- ==================================================================
-- [2] On-net: RCF forward_to = mailbox DID (no carrier leg)
-- ==================================================================
do
    print("[2] on-net RCF -> mailbox DID: chain resolver, no carrier leg, owner billed")
    local c = run_scenario({
        inbound_did = "+16170000001", caller_id = "+15085550777", sip_from_user = "+15085550777",
        caller_name = "Bob",
        step1 = { product_type = "rcf", customer_id = 10, forward_to = MAILBOX_DID, pass_caller_id = true, rcf_name = "Origin" },
        oracle = { [MAILBOX_DID] = VM_ORACLE_ROW },
    })
    local v = c.setvars
    check("no bridge at all (no carrier B-leg)", #c.bridges == 0, #c.bridges)
    check("no cdr_* B-leg vars on the A-leg", v.cdr_leg == nil and v.cdr_carrier_leg == nil, tostring(v.cdr_leg))
    check("product_type=voicemail", v.product_type == "voicemail", v.product_type)
    check("customer_id = mailbox owner 77 (terminal)", v.customer_id == "77", v.customer_id)
    check("origin_customer_id = RCF customer 10", v.origin_customer_id == "10", v.origin_customer_id)
    check("on_net=true hops=1", v.on_net == "true" and v.on_net_hops == "1", tostring(v.on_net) .. "/" .. tostring(v.on_net_hops))
    check("voicemail STEP-1 lookup NOT run for an RCF DID",
        count(c.db_calls, function(x) return x:match("^voicemail:") end) == 0, table.concat(c.db_calls, ","))
    check("resolved via number_routing", count(c.db_calls, function(x) return x == "resolve:" .. MAILBOX_DID end) == 1,
        table.concat(c.db_calls, ","))
    check("recorded + deposited", #c.records == 1 and #popen_kind(c, "/fs/deposit") == 1, #c.records)
    local _, meta = meta_of(popen_kind(c, "/fs/deposit")[1] or "")
    check("meta did = mailbox DID, caller = original caller",
        meta and meta.did == MAILBOX_DID and meta.caller_id_number == "+15085550777" and meta.caller_id_name == "Bob",
        meta and (tostring(meta.did) .. " " .. tostring(meta.caller_id_number) .. " " .. tostring(meta.caller_id_name)))
    check("vm_result=stored", v.vm_result == "stored", v.vm_result)
    assert_clean("[2]", c)

    print("[2b] on-net RCF (pass_caller_id=false) -> mailbox: masking DID presented")
    c = run_scenario({
        inbound_did = "+16170000002", caller_id = "+15085550777", sip_from_user = "+15085550777",
        caller_name = "Bob",
        step1 = { product_type = "rcf", customer_id = 10, forward_to = MAILBOX_DID, pass_caller_id = false, rcf_name = "Masked" },
        oracle = { [MAILBOX_DID] = VM_ORACLE_ROW },
    })
    _, meta = meta_of(popen_kind(c, "/fs/deposit")[1] or "")
    check("meta caller_id_number = masking RCF DID", meta and meta.caller_id_number == "+16170000002",
        meta and meta.caller_id_number)
    check("meta caller_id_name empty (mask has no caller name)", meta and meta.caller_id_name == "",
        meta and meta.caller_id_name)
    check("no carrier leg", #c.bridges == 0, #c.bridges)
    assert_clean("[2b]", c)

    print("[2c] RCF -> RCF -> mailbox chain: hops=2, one terminal, no carrier leg")
    c = run_scenario({
        inbound_did = "+16170000003", caller_id = "+15085550888", sip_from_user = "+15085550888",
        step1 = { product_type = "rcf", customer_id = 10, forward_to = "+16170000004", pass_caller_id = true },
        oracle = {
            ["+16170000004"] = { did = "+16170000004", product_type = "rcf", customer_id = "11",
                product_ref_id = "4", product_enabled = "t", customer_status = "active",
                forward_to = MAILBOX_DID, pass_caller_id = "t", ring_timeout = "30", max_channels = "0",
                product_name = "Mid" },
            [MAILBOX_DID] = VM_ORACLE_ROW,
        },
    })
    check("hops=2 on_net=true customer=77 origin=10",
        c.setvars.on_net_hops == "2" and c.setvars.on_net == "true" and c.setvars.customer_id == "77"
        and c.setvars.origin_customer_id == "10",
        tostring(c.setvars.on_net_hops) .. " " .. tostring(c.setvars.customer_id))
    check("no carrier leg, deposited", #c.bridges == 0 and c.setvars.vm_result == "stored", c.setvars.vm_result)
    assert_clean("[2c]", c)
end

-- ==================================================================
-- [3] Disabled / suspended -> 603 (existing hard_reject path)
-- ==================================================================
do
    print("[3] disabled / suspended mailbox -> 603 CALL_REJECTED, never answered")
    local function rejected(tag, c, expect_customer)
        check(tag .. ": hangup CALL_REJECTED only", #c.hangups == 1 and c.hangups[1] == "CALL_REJECTED",
            table.concat(c.hangups, ","))
        check(tag .. ": lua_routed=true", c.setvars.lua_routed == "true", c.setvars.lua_routed)
        check(tag .. ": not answered, nothing recorded, no HTTP", not c.answered and #c.records == 0 and #c.popen == 0,
            tostring(c.answered) .. " " .. #c.records .. " " .. #c.popen)
        check(tag .. ": no carrier leg", #c.bridges == 0, #c.bridges)
        check(tag .. ": customer_id=" .. expect_customer, c.setvars.customer_id == expect_customer, c.setvars.customer_id)
        assert_clean(tag, c)
    end
    local row = copy(VM_ORACLE_ROW); row.product_enabled = "f"
    rejected("[3a] on-net disabled mailbox", run_scenario({
        inbound_did = "+16170000001",
        step1 = { product_type = "rcf", customer_id = 10, forward_to = MAILBOX_DID },
        oracle = { [MAILBOX_DID] = row },
    }), "10")
    row = copy(VM_ORACLE_ROW); row.customer_status = "suspended"
    rejected("[3b] on-net suspended customer", run_scenario({
        inbound_did = "+16170000001",
        step1 = { product_type = "rcf", customer_id = 10, forward_to = MAILBOX_DID },
        oracle = { [MAILBOX_DID] = row },
    }), "10")
    local c = run_scenario(direct({ step1 = { product_type = "voicemail", customer_id = 77, mailbox_id = 42, enabled = false } }))
    rejected("[3c] direct-dial disabled mailbox", c, "77")
    check("[3c] product_type=voicemail on the reject CDR", c.setvars.product_type == "voicemail", c.setvars.product_type)
    rejected("[3d] direct-dial suspended customer", run_scenario(direct({
        step1 = { product_type = "voicemail", customer_id = 77, mailbox_id = 42, customer_status = "suspended" } })), "77")
end

-- ==================================================================
-- [4] Shell safety: hostile caller data only ever inside base64url
-- ==================================================================
do
    print("[4] hostile caller name/number never reaches a command line")
    local hostile = {
        { name = "@/etc/passwd",        number = "+15085550123" },
        { name = "$(reboot)",           number = "+15085550123" },
        { name = "'; rm -rf / #",       number = "+15085550123" },
        { name = "`id`|nc evil 1 \"x\\y", number = "+15085550123" },
        { name = "Eve\r\nX-Ingest-Secret: forged", number = "+15085550123" },
        { name = "Normal", number = "@/etc/shadow" },
        { name = "Normal", number = "$(curl evil)" },
    }
    local bad_fragments = { "passwd", "shadow", "reboot", "rm -rf", "`", "$(", "evil", "forged", "Eve", "Normal" }
    for i, h in ipairs(hostile) do
        local c = run_scenario(direct({ caller_name = h.name, caller_id = h.number, sip_from_user = h.number,
            uuid = "evil'$(reboot)`id`@x" }))
        local all = table.concat(c.popen, "\n") .. "\n" .. table.concat(c.execs, "\n")
        local leaked
        for _, frag in ipairs(bad_fragments) do
            if all:find(frag, 1, true) then leaked = frag end
        end
        check(string.format("[4.%d] no caller/Call-ID data in any command (%s)", i, (h.name:gsub("%c", "?"))), leaked == nil, leaked)
        local dep_cmd = popen_kind(c, "/fs/deposit")[1] or ""
        local b64, meta = meta_of(dep_cmd)
        local rp = rec_path_of(c)
        check(string.format("[4.%d] deposit command exact template", i),
            rp and dep_cmd == expected_deposit_cmd(rp, b64 or "?"), dep_cmd)
        check(string.format("[4.%d] mailbox command exact template", i),
            c.popen[1] == expected_mailbox_cmd(42), c.popen[1])
        local exp_name = dep.clean_text(h.name, 100)
        local exp_num = dep.clean_text(h.number, 40)
        check(string.format("[4.%d] caller data round-trips inside X-VM-Meta", i),
            meta and meta.caller_id_name == exp_name and meta.caller_id_number == exp_num
            and meta.call_uuid == "evil'$(reboot)`id`@x",
            meta and (tostring(meta.caller_id_name) .. " | " .. tostring(meta.caller_id_number)))
        check(string.format("[4.%d] record path is fixed dir + uuid4 only", i),
            rp and rp:match("^/dev/shm/vm/" .. UUID4 .. "%.wav$"), rp)
        assert_clean(string.format("[4.%d]", i), c)
    end
    -- API_HOST is env, but still validated before it can reach a command line
    local c = run_scenario(direct({ env = { API_HOST = "10.1.1.1;reboot" } }))
    check("[4.h] invalid API_HOST -> no command at all", #c.popen == 0, #c.popen)
    check("[4.h] invalid API_HOST -> unavailable prompt + config result",
        c.setvars.vm_result == "unavailable_config"
        and c.playbacks[1] == "/usr/local/freeswitch/scripts/sounds/vm/unavailable.wav",
        tostring(c.setvars.vm_result) .. " " .. tostring(c.playbacks[1]))
    assert_clean("[4.h]", c)
end

-- ==================================================================
-- [5] Recording removed on every exit path
-- ==================================================================
do
    print("[5] tmpfs file removed on every exit path")
    -- 5xx then retries exhausted
    local c = run_scenario(direct({ deposits = {
        { code = "500" }, { code = "502" }, { code = "503", body = '{"detail":"busy"}' } } }))
    check("[5a] 3 deposit attempts", #popen_kind(c, "/fs/deposit") == 3, #popen_kind(c, "/fs/deposit"))
    check("[5a] backoff 1 s then 2 s (msleep)", #c.msleeps == 2 and c.msleeps[1] == 1000 and c.msleeps[2] == 2000,
        table.concat(c.msleeps, ","))
    check("[5a] result lost + ERROR 'message lost'", c.setvars.vm_result == "lost" and has_log(c, "ERR", "message lost"),
        c.setvars.vm_result)
    check("[5a] identical command on every retry (idempotent msg_uuid)",
        popen_kind(c, "/fs/deposit")[1] == popen_kind(c, "/fs/deposit")[3], "differs")
    assert_clean("[5a]", c)

    c = run_scenario(direct({ deposits = { { code = "000", exit = 28 }, { code = "200", body = '{"status":"stored","message_id":5}' } } }))
    check("[5b] timeout then 200: stored on attempt 2", c.setvars.vm_result == "stored"
        and c.setvars.vm_deposit_attempts == "2" and #c.msleeps == 1 and c.msleeps[1] == 1000,
        tostring(c.setvars.vm_result) .. " " .. tostring(c.setvars.vm_deposit_attempts))
    assert_clean("[5b]", c)

    c = run_scenario(direct({ deposits = { { code = "401", body = '{"detail":"bad secret"}' } } }))
    check("[5c] 401: one attempt, no retry, rejected_401, ERROR",
        #popen_kind(c, "/fs/deposit") == 1 and #c.msleeps == 0 and c.setvars.vm_result == "rejected_401"
        and has_log(c, "ERR", "not retried"), c.setvars.vm_result)
    assert_clean("[5c]", c)

    c = run_scenario(direct({ record = { secs = 20, hangup = true } }))
    check("[5d] hangup mid-record: deposit still runs", #popen_kind(c, "/fs/deposit") == 1, #popen_kind(c, "/fs/deposit"))
    check("[5d] deposit ran after the caller hung up", find_event(c, "popen:deposit:down") ~= nil, table.concat(c.events, ","))
    check("[5d] the file existed when curl read it", c.deposit_file_present and c.deposit_file_present[1], "missing")
    check("[5d] duration from the WAV = 20000", ({ meta_of(popen_kind(c, "/fs/deposit")[1] or "") })[2].duration_ms == 20000, "dur")
    check("[5d] stored", c.setvars.vm_result == "stored", c.setvars.vm_result)
    assert_clean("[5d]", c)

    c = run_scenario(direct({ record = { secs = 9, raise = true } }))
    check("[5e] Lua error during record: result error, no deposit",
        c.setvars.vm_result == "error" and #popen_kind(c, "/fs/deposit") == 0, c.setvars.vm_result)
    check("[5e] flow error logged", has_log(c, "ERR", "voicemail flow error"), "no log")
    assert_clean("[5e]", c)

    c = run_scenario(direct({ raise_on_rec_open = 3 }))
    check("[5f] Lua error in the deposit phase: result lost, logged",
        c.setvars.vm_result == "lost" and has_log(c, "ERR", "deposit phase error"), c.setvars.vm_result)
    assert_clean("[5f]", c)

    c = run_scenario(direct({ raise_on_rec_open = 2 }))
    check("[5f2] Lua error AFTER the recording completed: flow error logged, message still deposited",
        has_log(c, "ERR", "voicemail flow error") and c.setvars.vm_result == "stored"
        and #popen_kind(c, "/fs/deposit") == 1, c.setvars.vm_result)
    assert_clean("[5f2]", c)

    c = run_scenario(direct({ deposits = { "raise", "raise", "raise" } }))
    check("[5g] popen itself raising: treated as transient, 3 attempts, lost",
        c.setvars.vm_result == "lost" and #popen_kind(c, "/fs/deposit") == 3, c.setvars.vm_result)
    assert_clean("[5g]", c)

    c = run_scenario(direct({ record = { secs = 0.6, hangup = true } }))
    check("[5h] < 1 s recording (caller hung up): not deposited, too_short, no prompt",
        c.setvars.vm_result == "too_short" and #popen_kind(c, "/fs/deposit") == 0
        and c.playbacks[#c.playbacks] == "tone_stream://%(500,0,1000)", c.setvars.vm_result)
    assert_clean("[5h]", c)

    c = run_scenario(direct({ record = { secs = 0 } }))
    check("[5h2] record returns at once with the caller connected (tmpfs full / instant '#'): unavailable, no deposit",
        c.setvars.vm_result == "too_short" and #popen_kind(c, "/fs/deposit") == 0
        and c.playbacks[#c.playbacks] == "/usr/local/freeswitch/scripts/sounds/vm/unavailable.wav"
        and has_log(c, "WARNING", "tmpfs full"), tostring(c.setvars.vm_result) .. " " .. tostring(c.playbacks[#c.playbacks]))
    assert_clean("[5h2]", c)

    c = run_scenario(direct({ record = { nofile = true } }))
    check("[5i] record produced no file (tmpfs full): record_failed + unavailable, no deposit",
        c.setvars.vm_result == "record_failed" and #popen_kind(c, "/fs/deposit") == 0
        and c.playbacks[#c.playbacks] == "/usr/local/freeswitch/scripts/sounds/vm/unavailable.wav",
        tostring(c.setvars.vm_result) .. " " .. tostring(c.playbacks[#c.playbacks]))
    assert_clean("[5i]", c)

    c = run_scenario(direct({ hangup_during_greeting = true }))
    check("[5j] hangup during greeting: no record, no deposit, caller_gone",
        #c.records == 0 and #popen_kind(c, "/fs/deposit") == 0 and c.setvars.vm_result == "caller_gone",
        c.setvars.vm_result)
    assert_clean("[5j]", c)
end

-- ==================================================================
-- [6] Custom greeting: fetched to tmpfs, played, unlinked immediately
-- ==================================================================
do
    print("[6] custom greeting")
    local mb = { code = "200", body = '{"mailbox_id":42,"accepting":true,"reason":null,"max_message_seconds":300,"greeting":{"greeting_id":5,"duration_ms":2000}}' }
    local c = run_scenario(direct({ mailbox = mb, greeting = { code = "200", content = wav_bytes(2, 16000) } }))
    local gcmd = popen_kind(c, "/fs/greetings/")[1] or ""
    local gpath = gcmd:match(" %-o '([^']+)'")
    check("[6a] greeting path = /dev/shm/vm/g_<uuid4>.wav", gpath and gpath:match("^/dev/shm/vm/g_" .. UUID4 .. "%.wav$"), gpath)
    check("[6a] greeting GET command exact", gpath and gcmd == expected_greeting_cmd(5, gpath), gcmd)
    check("[6a] greeting played from tmpfs", c.playbacks[1] == gpath, c.playbacks[1])
    check("[6a] greeting unlinked BEFORE record started (dir empty at record)",
        c.vm_dir_at_record and #c.vm_dir_at_record == 0, c.vm_dir_at_record and table.concat(c.vm_dir_at_record, ","))
    local pi, ri = find_event(c, "playback:" .. (gpath or "?")), find_event(c, "remove:" .. (gpath or "?"))
    check("[6a] unlink right after its playback", pi and ri and ri == pi + 1, tostring(pi) .. "/" .. tostring(ri))
    check("[6a] vm_greeting=custom", c.setvars.vm_greeting == "custom", c.setvars.vm_greeting)
    check("[6a] record uses 300 s", c.records[1] and c.records[1]:match(" 300 200 5$"), c.records[1])
    assert_clean("[6a]", c)

    c = run_scenario(direct({ mailbox = mb, greeting = { code = "200", content = "<html>not a wav</html>" } }))
    check("[6b] non-WAV greeting body: default prompt instead",
        c.playbacks[1] == "/usr/local/freeswitch/scripts/sounds/vm/default_greeting.wav" and c.setvars.vm_greeting == "default",
        c.playbacks[1])
    assert_clean("[6b]", c)

    c = run_scenario(direct({ mailbox = mb, greeting = { code = "503" } }))
    check("[6c] greeting fetch 503: default prompt, still deposits",
        c.setvars.vm_greeting == "default" and c.setvars.vm_result == "stored", c.setvars.vm_greeting)
    assert_clean("[6c]", c)

    c = run_scenario(direct({ mailbox = mb, greeting = { code = "200", content = wav_bytes(2), exit = 63 } }))
    check("[6d] curl exit != 0 with a 200 (partial download): default prompt",
        c.setvars.vm_greeting == "default", c.setvars.vm_greeting)
    assert_clean("[6d]", c)
end

-- ==================================================================
-- [7] Prompts missing -> tone fallback (never fails the call)
-- ==================================================================
do
    print("[7] prompt files missing -> tones")
    local c = run_scenario(direct({ sounds = "missing" }))
    check("[7a] greeting tone instead of default_greeting.wav",
        c.playbacks[1] == "tone_stream://%(200,80,500);%(200,80,650);%(200,0,800)", c.playbacks[1])
    check("[7a] still records + deposits", c.setvars.vm_result == "stored" and c.setvars.vm_greeting == "tone", c.setvars.vm_result)
    check("[7a] missing prompt logged WARNING", has_log(c, "WARNING", "missing"), "no log")
    assert_clean("[7a]", c)

    c = run_scenario(direct({ sounds = "missing",
        mailbox = { code = "200", body = '{"mailbox_id":42,"accepting":false,"reason":"full"}' } }))
    check("[7b] mailbox full + prompt missing -> reorder tone, hangup, no record",
        c.playbacks[1] == "tone_stream://L=6;%(250,250,480,620)" and #c.records == 0
        and c.setvars.vm_result == "not_accepting_full", tostring(c.playbacks[1]))
    assert_clean("[7b]", c)
end

-- ==================================================================
-- [8] Mailbox lookup outcomes
-- ==================================================================
do
    print("[8] mailbox lookup outcomes")
    local c = run_scenario(direct({ mailbox = { code = "200", body = '{"mailbox_id":42,"accepting":false,"reason":"full"}' } }))
    check("[8a] full -> mailbox_full.wav, no record, no deposit",
        c.playbacks[1] == "/usr/local/freeswitch/scripts/sounds/vm/mailbox_full.wav" and #c.records == 0
        and #popen_kind(c, "/fs/deposit") == 0, c.playbacks[1])
    check("[8a] answered then hung up NORMAL_CLEARING", c.answered and c.hangups[1] == "NORMAL_CLEARING", c.hangups[1])
    assert_clean("[8a]", c)

    c = run_scenario(direct({ mailbox = { code = "200", body = '{"mailbox_id":42,"accepting":false,"reason":"inactive"}' } }))
    check("[8b] inactive -> unavailable.wav", c.playbacks[1] == "/usr/local/freeswitch/scripts/sounds/vm/unavailable.wav"
        and c.setvars.vm_result == "not_accepting_inactive", c.playbacks[1])
    assert_clean("[8b]", c)

    for _, code in ipairs({ "404", "401", "403" }) do
        c = run_scenario(direct({ mailbox = { code = code, body = '{"detail":"x"}' } }))
        check("[8c] lookup " .. code .. " -> unavailable, no record/deposit",
            c.playbacks[1] == "/usr/local/freeswitch/scripts/sounds/vm/unavailable.wav" and #c.records == 0
            and #popen_kind(c, "/fs/deposit") == 0 and c.setvars.vm_result == "unavailable_" .. code,
            tostring(c.setvars.vm_result))
        assert_clean("[8c " .. code .. "]", c)
    end

    local failures_list = {
        { tag = "timeout (000, curl 28)", m = { code = "000", exit = 28 } },
        { tag = "500", m = { code = "500", body = "oops" } },
        { tag = "200 garbage JSON", m = { code = "200", body = "<html>" } },
        { tag = "200 without accepting", m = { code = "200", body = '{"mailbox_id":42}' } },
        { tag = "popen raises", m = "raise" },
    }
    for _, f in ipairs(failures_list) do
        c = run_scenario(direct({ mailbox = f.m }))
        local rp = rec_path_of(c)
        check("[8d] lookup " .. f.tag .. " -> defaults: 300 s, default greeting, deposits",
            rp and c.records[1] == rp .. " 300 200 5"
            and c.playbacks[1] == "/usr/local/freeswitch/scripts/sounds/vm/default_greeting.wav"
            and c.setvars.vm_result == "stored", tostring(c.records[1]) .. " " .. tostring(c.setvars.vm_result))
        assert_clean("[8d " .. f.tag .. "]", c)
    end

    c = run_scenario(direct({ mailbox = { code = "200", body = '{"mailbox_id":42,"accepting":true,"max_message_seconds":99999}' } }))
    check("[8e] out-of-range max_message_seconds -> 300", c.records[1] and c.records[1]:match(" 300 200 5$"), c.records[1])
    assert_clean("[8e]", c)
end

-- ==================================================================
-- [9] Preflight / configuration failures (fail closed, call never crashes)
-- ==================================================================
do
    print("[9] configuration failures")
    local cases = {
        { tag = "header file missing", sc = { header = false } },
        { tag = "header malformed", sc = { header = "Authorization: x\n" } },
        { tag = "secret too short", sc = { header = "X-Ingest-Secret: short\n" } },
        { tag = "two header lines", sc = { header = GOOD_SECRET_LINE .. "X-Other: y\n" } },
        { tag = "tmpfs not mounted", sc = { mounts = MOUNTS_NO_VM } },
        { tag = "API_HOST unset", sc = { env = { API_HOST = false } } },
        { tag = "API_PORT bad", sc = { env = { API_PORT = "80;id" } } },
    }
    for _, k in ipairs(cases) do
        local c = run_scenario(direct(k.sc))
        check("[9] " .. k.tag .. ": unavailable prompt, no HTTP, no record",
            c.setvars.vm_result == "unavailable_config" and #c.popen == 0 and #c.records == 0
            and c.playbacks[1] == "/usr/local/freeswitch/scripts/sounds/vm/unavailable.wav",
            tostring(c.setvars.vm_result) .. " popen=" .. #c.popen)
        check("[9] " .. k.tag .. ": ERROR logged", has_log(c, "ERR", "voicemail unavailable"), "no log")
        assert_clean("[9 " .. k.tag .. "]", c)
    end
    local c = run_scenario(direct({ header = "X-Ingest-Secret: " .. string.rep("q", 40) .. "\r\n" }))
    check("[9] CRLF header file accepted", c.setvars.vm_result == "stored", c.setvars.vm_result)

    c = run_scenario(direct({ vm_box_missing = true }))
    check("[9] vm_box.lua unloadable -> 503 hard reject, lua_routed, not answered",
        c.hangups[1] == "NORMAL_TEMPORARY_FAILURE" and c.setvars.lua_routed == "true" and not c.answered,
        tostring(c.hangups[1]))
end

-- ==================================================================
-- [10] Unrelated DIDs: 404 unchanged; RCF/trunk never touch voicemail
-- ==================================================================
do
    print("[10] non-voicemail calls")
    local c = run_scenario({ inbound_did = "+15559990000" })
    check("[10a] unknown DID -> UNALLOCATED_NUMBER (voicemail lookup was last)",
        c.hangups[1] == "UNALLOCATED_NUMBER" and c.db_calls[4] == "voicemail:+15559990000", table.concat(c.db_calls, ","))
    check("[10a] no voicemail activity", #c.popen == 0 and not c.answered, #c.popen)
    c = run_scenario({ inbound_did = "+16170000001",
        step1 = { product_type = "rcf", customer_id = 10, forward_to = "+17745550100" } })
    check("[10b] off-net RCF still bridges to the carrier, no voicemail lookup/HTTP",
        #c.bridges >= 1 and #c.popen == 0 and count(c.db_calls, function(x) return x:match("^voicemail") end) == 0,
        #c.bridges)
end

-- ==================================================================
-- [11] Sweep: constant command, rate-limited
-- ==================================================================
do
    print("[11] opportunistic sweep")
    local c = run_scenario(direct({ sweep_last = os.time() - 10 }))
    check("[11a] sweep skipped inside the 5-minute window", #c.execs == 0, table.concat(c.execs, " | "))
    c = run_scenario(direct({ sweep_last = os.time() - 301 }))
    check("[11b] sweep runs after the window", c.execs[1] == SWEEP_CMD, c.execs[1])
    check("[11c] startup sweep command (1 min)", dep.sweep_cmd(1)
        == "find /dev/shm/vm -mindepth 1 -maxdepth 1 -type f -mmin +1 -delete >/dev/null 2>&1", dep.sweep_cmd(1))
    check("[11d] sweep_cmd refuses non-integers", dep.sweep_cmd("1; reboot") == nil and dep.sweep_cmd(1.5) == nil, "accepted")
end

-- ==================================================================
-- [12] Retry table (vm_deposit.classify / deposit) — contract §5
-- ==================================================================
do
    print("[12] contract §5 retry table")
    local function run_deposit(responses)
        local env = setmetatable({ freeswitch = { consoleLog = function() end } }, { __index = _G })
        local n = 0
        local cmds = {}
        env.io = setmetatable({
            popen = function(cmd)
                n = n + 1
                cmds[#cmds + 1] = cmd
                local r = responses[n] or responses[#responses]
                return {
                    read = function() return (r.body or "") .. "\n" .. r.code end,
                    close = function() return true, "exit", 0 end,
                }
            end,
        }, { __index = io })
        env.loadfile = function(p) return loadfile(p, "t", env) end
        local d = assert(loadfile(LIBDIR .. "vm_deposit.lua", "t", env))()
        local sleeps = {}
        local res = d.deposit("http://10.0.0.5:8000",
            "/dev/shm/vm/0f8fad5b-d9cb-469f-a165-70867728950e.wav", "eyJ2IjoxfQ",
            function(ms) sleeps[#sleeps + 1] = ms end, function() return true end)
        return res, sleeps, cmds
    end
    for _, code in ipairs({ "400", "401", "404", "409", "413", "415", "422", "403", "301" }) do
        local res, sleeps = run_deposit({ { code = code } })
        check("[12] " .. code .. " -> 1 attempt, no retry, rejected",
            res.outcome == "rejected" and res.attempts == 1 and #sleeps == 0, res.outcome .. "/" .. res.attempts)
    end
    for _, code in ipairs({ "500", "502", "503", "504", "000", "408", "429" }) do
        local res, sleeps = run_deposit({ { code = code } })
        check("[12] " .. code .. " -> 3 attempts, backoff 1s/2s, lost",
            res.outcome == "lost" and res.attempts == 3 and sleeps[1] == 1000 and sleeps[2] == 2000 and #sleeps == 2,
            res.outcome .. "/" .. res.attempts)
    end
    local res = run_deposit({ { code = "200", body = '{"status":"error"}' }, { code = "200", body = '{"status": "stored", "message_id": 77}' } })
    check("[12] 200 without status=stored is NOT success (defect 8) -> retried",
        res.outcome == "stored" and res.attempts == 2 and res.message_id == 77, res.outcome .. "/" .. res.attempts)
    res = run_deposit({ { code = "200", body = '{"status":"stored","message_id":1}' } })
    check("[12] 200 stored -> 1 attempt", res.outcome == "stored" and res.attempts == 1, res.outcome)
    local d = dep
    check("[12] deposit_cmd refuses a non-uuid path",
        d.deposit_cmd("http://h:1", "/dev/shm/vm/../../etc/passwd.wav", "abc") == nil
        and d.deposit_cmd("http://h:1", "/tmp/x.wav", "abc") == nil, "accepted")
    check("[12] deposit_cmd refuses a non-base64url meta",
        d.deposit_cmd("http://h:1", "/dev/shm/vm/0f8fad5b-d9cb-469f-a165-70867728950e.wav", "ab+c") == nil
        and d.deposit_cmd("http://h:1", "/dev/shm/vm/0f8fad5b-d9cb-469f-a165-70867728950e.wav", "a'b") == nil, "accepted")
    check("[12] mailbox_cmd refuses non-integer ids",
        d.mailbox_cmd("http://h:1", "42; reboot") == nil and d.mailbox_cmd("http://h:1", 0) == nil
        and d.mailbox_cmd("http://h:1", 4.5) == nil, "accepted")
end

-- ==================================================================
-- [13] Units: json, base64url, uuid4, WAV duration, truncation
-- ==================================================================
do
    print("[13] units")
    local enc = json.encode
    check("[13] json escapes quote/backslash/controls/DEL",
        enc("a\"b\\c\n\r\t\b\f\1\31\127") == '"a\\"b\\\\c\\n\\r\\t\\b\\f\\u0001\\u001f\\u007f"',
        enc("a\"b\\c\n\r\t\b\f\1\31\127"))
    check("[13] json passes valid UTF-8 through", enc("Zoë 日本 😀") == '"Zoë 日本 😀"', enc("Zoë 日本 😀"))
    check("[13] json replaces invalid UTF-8 with U+FFFD", enc("caf\233") == '"caf\239\191\189"', enc("caf\233"))
    check("[13] json rejects overlong / surrogate encodings",
        enc("\192\175") == '"\239\191\189\239\191\189"' and enc("\237\160\128") == '"\239\191\189\239\191\189\239\191\189"',
        enc("\192\175"))
    check("[13] json object keys sorted, ints without .0",
        enc({ b = 1, a = 2.5, c = true, d = { 1, 2 } }) == '{"a":2.5,"b":1,"c":true,"d":[1,2]}',
        enc({ b = 1, a = 2.5, c = true, d = { 1, 2 } }))
    check("[13] json NaN is an error", enc(0 / 0) == nil, enc(0 / 0))
    local t = json.decode('{"a":[1,2,{"b":null}],"s":"x\\u00e9\\ud83d\\ude00\\n","t":true,"f":false,"n":-1.5e2}')
    check("[13] json decode", t and t.a[2] == 2 and t.s == "x\195\169\240\159\152\128\n" and t.t == true
        and t.f == false and t.n == -150 and t.a[3].b == nil, t and t.s)
    check("[13] json decode rejects trailing garbage / bad input",
        json.decode('{"a":1} x') == nil and json.decode("{'a':1}") == nil and json.decode("[1,]") == nil
        and json.decode("01") == nil and json.decode('"a\1"') == nil, "accepted")
    check("[13] json decode depth cap", json.decode(string.rep("[", 200) .. string.rep("]", 200)) == nil, "accepted")
    local name = "Zoë \"x\" \\ @/etc/passwd $(reboot) '; rm -rf /"
    local rt = json.decode(enc({ n = name }))
    check("[13] json round trip of hostile text", rt and rt.n == name, rt and rt.n)

    local vec = { [""] = "", f = "Zg", fo = "Zm8", foo = "Zm9v", foob = "Zm9vYg", fooba = "Zm9vYmE", foobar = "Zm9vYmFy" }
    local okv = true
    for k, v in pairs(vec) do if dep.b64url(k) ~= v or dep.b64url_decode(v) ~= k then okv = false end end
    check("[13] base64url RFC 4648 vectors (no padding)", okv, "mismatch")
    check("[13] base64url uses -_ not +/", dep.b64url("\251\255\191") == "-_-_", dep.b64url("\251\255\191"))
    local allbytes = {}
    for i = 0, 255 do allbytes[#allbytes + 1] = string.char(i) end
    allbytes = table.concat(allbytes)
    check("[13] base64url round trip of all 256 bytes",
        dep.b64url_decode(dep.b64url(allbytes)) == allbytes and dep.b64url(allbytes):match("^[A-Za-z0-9_-]+$"), "mismatch")

    local seen, okfmt = {}, true
    for _ = 1, 200 do
        local u = dep.uuid4()
        if not (u and u:match("^" .. UUID4 .. "$")) or seen[u] then okfmt = false end
        seen[u or ""] = true
    end
    check("[13] uuid4: 200 unique, canonical v4/variant", okfmt, "bad uuid")

    local vbox_env = setmetatable({ freeswitch = { consoleLog = function() end } }, { __index = _G })
    vbox_env.loadfile = function(p)
        local n = p:match("/lib/([%w_]+)%.lua$")
        return loadfile(LIBDIR .. n .. ".lua", "t", vbox_env)
    end
    local vbox = assert(loadfile(LIBDIR .. "vm_box.lua", "t", vbox_env))()
    local wdir = SCRATCH .. "/wav"
    real_os.execute("mkdir -p '" .. wdir .. "'")
    write_file(wdir .. "/a.wav", wav_bytes(3.25))
    write_file(wdir .. "/b.wav", wav_bytes(2, 16000))
    local unfinal = wav_bytes(4):gsub("data....", "data\0\0\0\0", 1)
    write_file(wdir .. "/c.wav", unfinal)
    write_file(wdir .. "/d.wav", "not a wav at all")
    check("[13] wav_duration_ms 8k", vbox.wav_duration_ms(wdir .. "/a.wav") == 3250, vbox.wav_duration_ms(wdir .. "/a.wav"))
    check("[13] wav_duration_ms 16k", vbox.wav_duration_ms(wdir .. "/b.wav") == 2000, vbox.wav_duration_ms(wdir .. "/b.wav"))
    check("[13] wav_duration_ms unfinalized header -> file size", vbox.wav_duration_ms(wdir .. "/c.wav") == 4000,
        vbox.wav_duration_ms(wdir .. "/c.wav"))
    check("[13] wav_duration_ms non-WAV -> nil", vbox.wav_duration_ms(wdir .. "/d.wav") == nil, "parsed")

    local long = string.rep("é", 150)
    local tr = dep.clean_text(long, 100)
    check("[13] utf8 truncation by code points (100 chars, 200 bytes)", #tr == 200 and json.encode(tr):find("\239\191\189", 1, true) == nil, #tr)
    check("[13] clean_text strips controls", dep.clean_text("  a\r\nb\tc\0d  ", 40) == "a b c d", dep.clean_text("  a\r\nb\tc\0d  ", 40))
    local c = run_scenario(direct({ uuid = string.rep("x", 90) .. "@carrier.example" }))
    local _, meta = meta_of(popen_kind(c, "/fs/deposit")[1] or "")
    check("[13] call_uuid truncated to 64 chars (DB column)", meta and #meta.call_uuid == 64, meta and #meta.call_uuid)

    -- prompts shipped in the repo are 8 kHz mono PCM16 WAV
    for _, p in ipairs({ "default_greeting", "mailbox_full", "unavailable" }) do
        local f = real_io.open(SOUNDS .. p .. ".wav", "rb")
        local h = f and f:read(44) or ""
        if f then f:close() end
        local ok = h:sub(1, 4) == "RIFF" and h:sub(9, 12) == "WAVE" and h:sub(13, 16) == "fmt "
            and h:byte(21) == 1 and h:byte(23) == 1 and (h:byte(25) + h:byte(26) * 256) == 8000 and h:byte(35) == 16
        check("[13] prompt " .. p .. ".wav is 8 kHz mono PCM16", ok, "bad header")
    end
end

real_os.execute("rm -rf '" .. SCRATCH .. "'")
print(string.format("\n%d passed, %d failed", passes, failures))
if failures > 0 then
    print("VOICEMAIL HARNESS: FAILURES")
    os.exit(1)
end
print("ALL VOICEMAIL HARNESS ASSERTIONS PASSED")
