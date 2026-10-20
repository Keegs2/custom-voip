-- lib/vm_deposit.lua — FreeSWITCH -> API client for encrypted voicemail.
--
-- Contract: docs/ENCRYPTED_VOICEMAIL_INTERFACES.md §4.5 (FS-facing endpoints)
-- and §5 (deposit). This module is the CLIENT side; the API (routers/
-- voicemail.py) is the server. It is used ONLY by lib/vm_box.lua (the call
-- flow) and loaded with the repo's loadfile() pattern.
--
-- WHY THE curl BINARY (io.popen) AND NOT mod_curl: mod_curl's `curl` API/app
-- posts a Lua string body (no binary file upload) and would need the ingest
-- secret inside the API argument string. The runtime image ships Debian
-- bookworm's curl 7.88, which supports every flag used here:
--   -q (ignore .curlrc; must be first)  -s  --noproxy  --connect-timeout
--   --max-time  --max-filesize  -o  -w '%{http_code}'  --data-binary @file
--   -H @file (read headers from a file — curl >= 7.55.0)
--
-- SHELL-SAFETY RULE (hard requirement, build plan §2 defects 1 + 2):
--   NO untrusted value (caller name/number, DID, Call-ID, anything from SIP)
--   ever appears on a command line. The ONLY variable parts of a command are
--     * the API base URL — API_HOST/API_PORT from the container env, validated
--       (^[A-Za-z0-9][A-Za-z0-9.-]*$ / 1..65535), plus a fixed path and a
--       decimal integer id;
--     * a file path — the fixed /dev/shm/vm/ directory + a UUIDv4 this module
--       generated (validated against the canonical v4 pattern);
--     * the X-VM-Meta value — base64url (no padding) of the JSON metadata,
--       validated against ^[A-Za-z0-9_-]+$ before use. Caller data exists only
--       INSIDE that base64url string.
--   The ingest secret is never on argv: it is read by curl from the root-only
--   header file (-H @/run/revup/vm_ingest.header). Every variable token is
--   still single-quoted (defense in depth), and a value that fails validation
--   aborts the request — it is never "sanitized" into the command.
--
-- Syntax: Lua 5.1/5.3-common (FS runs 5.3). Never raises out of its public
-- functions except on programmer error; network/HTTP failures are values.

local M = {}

-- Fixed locations (contract §6). Not configurable from SIP or the DB.
M.HEADER_FILE = "/run/revup/vm_ingest.header"
M.VM_DIR      = "/dev/shm/vm"

-- Timeouts / limits (seconds unless noted).
M.MAILBOX_CONNECT_TIMEOUT  = 2
M.MAILBOX_MAX_TIME         = 3      -- contract §6: GET /fs/mailbox timeout 3 s
M.GREETING_CONNECT_TIMEOUT = 2
M.GREETING_MAX_TIME        = 5
M.GREETING_MAX_BYTES       = 6291456   -- 6 MiB (API greeting cap is 5 MB)
M.DEPOSIT_CONNECT_TIMEOUT  = 3
M.DEPOSIT_MAX_TIME         = 15     -- per attempt (cross-zone VPC + KMS + GCS)
M.DEPOSIT_ATTEMPTS         = 3      -- contract §5: <= 3 attempts total
M.DEPOSIT_BACKOFF_MS       = { 1000, 2000 }   -- before attempt 2, attempt 3
M.META_MAX_LEN             = 8192   -- base64url chars (real metadata is < 1 KB)

-- DB column widths (contract §1 voicemail_messages) — values are truncated
-- client-side so an oversized SIP value can never turn a deposit into a
-- server-side error (which would retry and then lose the message).
M.MAX_CALLER_NUMBER = 40
M.MAX_CALLER_NAME   = 100
M.MAX_CALL_UUID     = 64
M.MAX_FS_NODE       = 64
M.MAX_ZONE          = 16
M.MAX_DID           = 20

local UUID4_PATTERN = "^%x%x%x%x%x%x%x%x%-%x%x%x%x%-4%x%x%x%-[89ab]%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$"

local function log(level, msg)
    if freeswitch and freeswitch.consoleLog then
        freeswitch.consoleLog(level, "[vm_deposit] " .. msg .. "\n")
    end
end
M._log = log

-- ----------------------------------------------------------------------
-- Small pure helpers (exported for the harness)
-- ----------------------------------------------------------------------

-- POSIX sh single-quote. Only ever applied to values that ALREADY passed a
-- strict charset validation; kept as defense in depth.
local function shq(s)
    return "'" .. tostring(s):gsub("'", "'\\''") .. "'"
end
M._shq = shq

local B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

-- RFC 4648 §5 base64url, NO padding.
function M.b64url(s)
    s = tostring(s or "")
    local out = {}
    local len = #s
    for i = 1, len, 3 do
        local a, b, c = s:byte(i, i + 2)
        local n = a * 65536 + (b or 0) * 256 + (c or 0)
        local c1 = math.floor(n / 262144) % 64
        local c2 = math.floor(n / 4096) % 64
        local c3 = math.floor(n / 64) % 64
        local c4 = n % 64
        out[#out + 1] = B64URL:sub(c1 + 1, c1 + 1)
        out[#out + 1] = B64URL:sub(c2 + 1, c2 + 1)
        if b then out[#out + 1] = B64URL:sub(c3 + 1, c3 + 1) end
        if c then out[#out + 1] = B64URL:sub(c4 + 1, c4 + 1) end
    end
    return table.concat(out)
end

-- Inverse (harness use: proves the metadata round-trips byte-for-byte).
function M.b64url_decode(s)
    local map = {}
    for i = 1, #B64URL do map[B64URL:sub(i, i)] = i - 1 end
    local out = {}
    local bits, nbits = 0, 0
    for i = 1, #s do
        local v = map[s:sub(i, i)]
        if v == nil then return nil end
        bits = bits * 64 + v
        nbits = nbits + 6
        if nbits >= 8 then
            nbits = nbits - 8
            local byte = math.floor(bits / (2 ^ nbits)) % 256
            out[#out + 1] = string.char(byte)
            bits = bits % (2 ^ nbits)
        end
    end
    return table.concat(out)
end

function M.is_b64url(s)
    return type(s) == "string" and #s > 0 and #s <= M.META_MAX_LEN
        and s:match("^[A-Za-z0-9_%-]+$") ~= nil
end

function M.is_uuid4(s)
    return type(s) == "string" and s:match(UUID4_PATTERN) ~= nil
end

-- Positive 31-bit integer id -> decimal string, or nil.
local function id_string(v)
    local n = tonumber(v)
    if not n or n ~= math.floor(n) or n < 1 or n > 2147483647 then
        return nil
    end
    return string.format("%d", n)
end
M._id_string = id_string

-- UUIDv4 from /dev/urandom (16 bytes, version/variant bits set). Fallback:
-- FreeSWITCH's create_uuid API with the version/variant nibbles forced, so
-- the result is always a syntactically valid v4. nil only if both fail.
function M.uuid4()
    local bytes
    local f = io.open("/dev/urandom", "rb")
    if f then
        bytes = f:read(16)
        f:close()
    end
    local b = {}
    if bytes and #bytes == 16 then
        for i = 1, 16 do b[i] = bytes:byte(i) end
    else
        local raw
        if freeswitch and freeswitch.API then
            local ok, res = pcall(function()
                return freeswitch.API():executeString("create_uuid")
            end)
            if ok then raw = res end
        end
        local hex = tostring(raw or ""):gsub("%-", ""):lower()
        if not hex:match("^%x+$") or #hex ~= 32 then
            log("ERR", "uuid4: /dev/urandom and create_uuid both unavailable")
            return nil
        end
        for i = 1, 16 do b[i] = tonumber(hex:sub(2 * i - 1, 2 * i), 16) end
    end
    b[7] = (b[7] % 16) + 64      -- version 4
    b[9] = (b[9] % 64) + 128     -- RFC 4122 variant (10xx)
    local h = {}
    for i = 1, 16 do h[i] = string.format("%02x", b[i]) end
    return table.concat(h, "", 1, 4) .. "-" .. table.concat(h, "", 5, 6) .. "-"
        .. table.concat(h, "", 7, 8) .. "-" .. table.concat(h, "", 9, 10) .. "-"
        .. table.concat(h, "", 11, 16)
end

-- The only legal tmpfs paths: <VM_DIR>/<uuid4>.wav (message) and
-- <VM_DIR>/g_<uuid4>.wav (greeting).
function M.message_path(msg_uuid)
    if not M.is_uuid4(msg_uuid) then return nil end
    return M.VM_DIR .. "/" .. msg_uuid .. ".wav"
end

function M.greeting_path(file_uuid)
    if not M.is_uuid4(file_uuid) then return nil end
    return M.VM_DIR .. "/g_" .. file_uuid .. ".wav"
end

local function is_vm_path(p)
    if type(p) ~= "string" then return false end
    local prefix = M.VM_DIR .. "/"
    if p:sub(1, #prefix) ~= prefix then return false end
    local name = p:sub(#prefix + 1)
    local u = name:match("^g_(.+)%.wav$") or name:match("^(.+)%.wav$")
    return M.is_uuid4(u)
end
M._is_vm_path = is_vm_path

-- Truncate to at most max_chars UTF-8 code points (never splits a sequence;
-- stray continuation bytes count as one char each — json.encode replaces
-- them with U+FFFD anyway).
function M.utf8_truncate(s, max_chars)
    s = tostring(s or "")
    local i, n, len = 1, 0, #s
    while i <= len do
        if n >= max_chars then return s:sub(1, i - 1) end
        local c = s:byte(i)
        local step = 1
        if c >= 0xF0 then step = 4 elseif c >= 0xE0 then step = 3 elseif c >= 0xC0 then step = 2 end
        i = i + step
        n = n + 1
    end
    return s
end

-- Display hygiene for caller fields: C0 controls + DEL -> space, collapse,
-- trim, then truncate to the DB column width.
function M.clean_text(s, max_chars)
    s = tostring(s or "")
    s = s:gsub("%c", " ")
    s = s:gsub("%s+", " ")
    s = s:gsub("^%s+", "")
    s = s:gsub("%s+$", "")
    return M.utf8_truncate(s, max_chars)
end

-- ----------------------------------------------------------------------
-- Configuration checks (no network)
-- ----------------------------------------------------------------------

-- Validated "http://host:port" from API_HOST / API_PORT, or nil, reason.
-- IPv6 literals are not supported (the API is addressed by VPC IPv4/name).
function M.api_base()
    local host = tostring(os.getenv("API_HOST") or ""):match("^%s*(.-)%s*$")
    local port = tostring(os.getenv("API_PORT") or ""):match("^%s*(.-)%s*$")
    if port == "" then port = "8000" end
    if host == "" then
        return nil, "API_HOST unset"
    end
    if #host > 253 or not host:match("^[%w][%w%.%-]*$") then
        return nil, "API_HOST is not a plain hostname/IPv4"
    end
    local pn = tonumber(port)
    if not port:match("^%d+$") or not pn or pn < 1 or pn > 65535 then
        return nil, "API_PORT invalid"
    end
    return "http://" .. host .. ":" .. port
end

-- The header file must exist, be readable and hold exactly one line
-- `X-Ingest-Secret: <secret>` (printable ASCII, no spaces, >= 32 chars —
-- the API rejects shorter secrets). Returns true, or false + reason. The
-- secret itself is never returned or logged.
function M.ingest_header_ok()
    local f = io.open(M.HEADER_FILE, "r")
    if not f then
        return false, "header file " .. M.HEADER_FILE .. " missing or unreadable"
    end
    local content = f:read(4097) or ""
    f:close()
    if #content > 4096 then
        return false, "header file too large"
    end
    content = content:gsub("\r", "")
    content = content:gsub("^%s+", ""):gsub("%s+$", "")
    local secret = content:match("^X%-Ingest%-Secret: ([!-~]+)$")
    if not secret then
        return false, "header file is not a single 'X-Ingest-Secret: <secret>' line"
    end
    if #secret < 32 then
        return false, "ingest secret shorter than 32 characters"
    end
    return true
end

-- ----------------------------------------------------------------------
-- Command builders (pure; the harness asserts their exact output)
-- ----------------------------------------------------------------------
local COMMON = "curl -q -s --noproxy '*'"

function M.mailbox_cmd(base, mailbox_id)
    local id = id_string(mailbox_id)
    if not base or not id then return nil end
    return string.format(
        "%s --connect-timeout %d --max-time %d -H @%s -H 'Accept: application/json'"
        .. " -w '\\n%%{http_code}' %s 2>/dev/null",
        COMMON, M.MAILBOX_CONNECT_TIMEOUT, M.MAILBOX_MAX_TIME, M.HEADER_FILE,
        shq(base .. "/v1/voicemail/fs/mailbox/" .. id))
end

function M.greeting_cmd(base, greeting_id, out_path)
    local id = id_string(greeting_id)
    if not base or not id or not is_vm_path(out_path) then return nil end
    return string.format(
        "%s --connect-timeout %d --max-time %d --max-filesize %d -H @%s -o %s"
        .. " -w '%%{http_code}' %s 2>/dev/null",
        COMMON, M.GREETING_CONNECT_TIMEOUT, M.GREETING_MAX_TIME, M.GREETING_MAX_BYTES,
        M.HEADER_FILE, shq(out_path),
        shq(base .. "/v1/voicemail/fs/greetings/" .. id .. "/audio"))
end

function M.deposit_cmd(base, rec_path, meta_b64)
    if not base or not is_vm_path(rec_path) or not M.is_b64url(meta_b64) then
        return nil
    end
    return string.format(
        "%s --connect-timeout %d --max-time %d -H @%s -H 'Content-Type: audio/wav'"
        .. " -H 'Expect:' -H %s --data-binary %s -w '\\n%%{http_code}' %s 2>/dev/null",
        COMMON, M.DEPOSIT_CONNECT_TIMEOUT, M.DEPOSIT_MAX_TIME, M.HEADER_FILE,
        shq("X-VM-Meta: " .. meta_b64), shq("@" .. rec_path),
        shq(base .. "/v1/voicemail/fs/deposit"))
end

-- The sweep command is a CONSTANT apart from a validated integer age.
function M.sweep_cmd(min_age_minutes)
    local age = tonumber(min_age_minutes)
    if not age or age ~= math.floor(age) or age < 0 or age > 100000 then return nil end
    return string.format(
        "find %s -mindepth 1 -maxdepth 1 -type f -mmin +%d -delete >/dev/null 2>&1",
        M.VM_DIR, age)
end

-- ----------------------------------------------------------------------
-- Execution
-- ----------------------------------------------------------------------

-- Run a command and return (stdout, exit_code_or_nil). Never raises.
local function run(cmd)
    local ok, p = pcall(io.popen, cmd, "r")
    if not ok or not p then
        return nil, nil, "popen failed: " .. tostring(p)
    end
    local rok, out = pcall(p.read, p, "*a")
    -- Lua 5.2+: close() of a popen handle -> true|nil, "exit"|"signal", code
    local cok, _, _, code = pcall(p.close, p)
    if not rok then
        return nil, nil, "read failed: " .. tostring(out)
    end
    return out or "", (cok and code) or nil
end
M._run = run

-- "<body>\n<code>" (from -w '\n%{http_code}') -> body, code(string 3 digits).
function M.split_body_code(out)
    out = out or ""
    local body, code = out:match("^(.*)\n(%d%d%d)%s*$")
    if body then return body, code end
    code = out:match("(%d%d%d)%s*$")
    return "", code or "000"
end

-- GET /v1/voicemail/fs/mailbox/{id}
-- Returns a table:
--   { kind = "ok", data = <decoded object> }   200 + JSON object
--   { kind = "not_found", code = "404" }       mailbox unknown/deleted
--   { kind = "auth", code = "401"|"403" }      secret rejected (config error)
--   { kind = "error", code = ..., detail = ... } anything else (transport,
--                                                5xx, garbage) -> caller
--                                                proceeds with defaults
function M.fetch_mailbox(base, mailbox_id, json)
    local cmd = M.mailbox_cmd(base, mailbox_id)
    if not cmd then
        return { kind = "error", code = "000", detail = "invalid mailbox request" }
    end
    local out, _, err = run(cmd)
    if not out then
        return { kind = "error", code = "000", detail = err }
    end
    local body, code = M.split_body_code(out)
    if code == "404" then return { kind = "not_found", code = code } end
    if code == "401" or code == "403" then return { kind = "auth", code = code } end
    if code ~= "200" then
        return { kind = "error", code = code, detail = "http " .. code }
    end
    if not json or not json.decode then
        return { kind = "error", code = code, detail = "json module unavailable" }
    end
    local data, derr = json.decode(body)
    if type(data) ~= "table" then
        return { kind = "error", code = code, detail = "bad JSON: " .. tostring(derr) }
    end
    return { kind = "ok", code = code, data = data }
end

-- GET /v1/voicemail/fs/greetings/{id}/audio -> out_path (tmpfs).
-- Returns true when a 200 RIFF/WAVE body landed at out_path; false + detail
-- otherwise. The CALLER owns out_path (it registers it for cleanup BEFORE
-- calling, so a partial download is always unlinked).
function M.fetch_greeting(base, greeting_id, out_path)
    local cmd = M.greeting_cmd(base, greeting_id, out_path)
    if not cmd then return false, "invalid greeting request" end
    local out, exit_code, err = run(cmd)
    if not out then return false, err end
    local code = (out:match("(%d%d%d)%s*$")) or "000"
    if code ~= "200" then return false, "http " .. code end
    -- e.g. exit 63 (--max-filesize exceeded) or 28 (timeout mid-body) with a
    -- 200 status line: the file is partial — never play it.
    if exit_code ~= nil and exit_code ~= 0 then
        return false, "curl exit " .. tostring(exit_code)
    end
    local f = io.open(out_path, "rb")
    if not f then return false, "download produced no file" end
    local head = f:read(12) or ""
    f:close()
    if head:sub(1, 4) ~= "RIFF" or head:sub(9, 12) ~= "WAVE" then
        return false, "greeting is not a RIFF/WAVE file"
    end
    return true
end

-- Contract §5 response table -> "stored" | "retry" | "permanent".
-- 2xx counts as stored ONLY with {"status":"stored"} in the body (build plan
-- defect 8: a 2xx error body must never be mistaken for success); a 2xx
-- without it is retried (deposit is idempotent on msg_uuid).
local PERMANENT = {
    ["400"] = true, ["401"] = true, ["404"] = true, ["409"] = true,
    ["413"] = true, ["415"] = true, ["422"] = true,
}
function M.classify(code, body)
    code = tostring(code or "000")
    if code:match("^2%d%d$") then
        if tostring(body or ""):match('"status"%s*:%s*"stored"') then
            return "stored"
        end
        return "retry"
    end
    if PERMANENT[code] then return "permanent" end
    if code == "000" or code == "408" or code == "429" or code:match("^5%d%d$") then
        return "retry"
    end
    return "permanent"   -- 1xx/3xx/other 4xx: configuration problem, not transient
end

local LOUD = { ["400"] = true, ["401"] = true, ["413"] = true, ["415"] = true, ["422"] = true }

-- POST /v1/voicemail/fs/deposit with the contract retry table.
--   sleep_ms(ms)  backoff sleeper (the caller passes freeswitch.msleep — the
--                 deposit always runs AFTER the A-leg is hung up, so there is
--                 no media to service; see vm_box.lua).
--   file_exists(path) -> bool, checked before every attempt.
-- Returns { outcome = "stored"|"rejected"|"lost", code = "<last http>",
--           attempts = n, message_id = <number|nil> }
function M.deposit(base, rec_path, meta_b64, sleep_ms, file_exists, tag)
    tag = tag or ""
    local cmd = M.deposit_cmd(base, rec_path, meta_b64)
    if not cmd then
        log("ERR", tag .. "deposit request failed validation — message lost")
        return { outcome = "lost", code = "000", attempts = 0 }
    end
    local last_code = "000"
    for attempt = 1, M.DEPOSIT_ATTEMPTS do
        if attempt > 1 then
            local wait = M.DEPOSIT_BACKOFF_MS[attempt - 1] or 2000
            pcall(sleep_ms, wait)
        end
        if file_exists and not file_exists(rec_path) then
            log("ERR", tag .. "recording vanished before deposit attempt " .. attempt
                .. " — message lost")
            return { outcome = "lost", code = last_code, attempts = attempt - 1 }
        end
        local out, exit_code, err = run(cmd)
        local body, code = "", "000"
        if out then
            body, code = M.split_body_code(out)
        end
        last_code = code
        local verdict = M.classify(code, body)
        if verdict == "stored" then
            local mid = tonumber(body:match('"message_id"%s*:%s*(%d+)'))
            log("INFO", string.format("%sdeposit stored (http %s, attempt %d, message_id=%s)",
                tag, code, attempt, tostring(mid)))
            return { outcome = "stored", code = code, attempts = attempt, message_id = mid }
        elseif verdict == "permanent" then
            local level = LOUD[code] and "ERR" or "WARNING"
            if code == "409" or code == "404" then level = "WARNING" end
            log(level, string.format("%sdeposit rejected (http %s, attempt %d) — not retried, message dropped",
                tag, code, attempt))
            return { outcome = "rejected", code = code, attempts = attempt }
        end
        log("WARNING", string.format("%sdeposit attempt %d/%d transient failure (http %s, curl exit %s%s)",
            tag, attempt, M.DEPOSIT_ATTEMPTS, code, tostring(exit_code),
            err and (", " .. err) or ""))
    end
    log("ERR", string.format("%sdeposit failed after %d attempts (last http %s) — message lost",
        tag, M.DEPOSIT_ATTEMPTS, last_code))
    return { outcome = "lost", code = last_code, attempts = M.DEPOSIT_ATTEMPTS }
end

return M
