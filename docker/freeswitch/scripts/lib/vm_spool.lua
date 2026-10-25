-- lib/vm_spool.lua — encrypted voicemail: SEAL an undeliverable message to
-- the media VM's persistent spool instead of losing it.
--
-- Contract: docs/IVR_INTERFACES.md §8.4; design + threat model:
-- docs/VOICEMAIL_OUTAGE_RESILIENCE.md (plan D11 / §7.5). Used ONLY by
-- lib/vm_box.lua, and ONLY when lib/vm_deposit.lua's deposit came back
-- "lost" (every attempt transient: the East API unreachable / 5xx). A stored
-- or permanently rejected deposit never reaches this file.
--
-- WHAT A SEAL IS
--   The plaintext recording (/dev/shm/vm/<msg_uuid>.wav, RAM) is encrypted
--   with the openssl CLI of the FS runtime image (Debian bookworm OpenSSL
--   3.0.x, docker/freeswitch/Dockerfile runtime `openssl` package) into a
--   CMS AuthEnvelopedData (RFC 5083) blob:
--     content encryption  AES-256-GCM (RFC 5084: 12-byte nonce, 16-byte tag),
--                         a fresh random content key per message
--     key transport       RSAES-OAEP, SHA-256 + MGF1-SHA-256, to EVERY
--                         certificate in /run/revup/vm_spool_recipients.pem
--                         (1..4 — "current" and "next" during a rotation),
--                         recipient id = subjectKeyIdentifier (-keyid)
--   The matching private key exists ONLY on the services VM (API env
--   VOICEMAIL_SPOOL_PRIVATE_KEY_B64). Nothing on a media VM can decrypt a
--   spool file.
--   What is sealed is a small frame, so the routing metadata is inside the
--   authenticated envelope too (a sidecar cannot be edited to deliver
--   someone's message to another mailbox — the API compares them):
--       "CRAGVMS1\n" <decimal length of META> "\n" META <the WAV bytes>
--   META = the JSON of the X-VM-Meta fields (contract §8.4): v, msg_uuid,
--   mailbox_id, did, caller_number, caller_name (optional), received_at
--   (ISO-8601 UTC), duration_ms, zone.
--
-- FILES (spool = the `vm_spool` Docker volume, docker-compose.media.yml)
--   /var/lib/crag/vm-spool/<msg_uuid>.cms    the DER blob        (0600)
--   /var/lib/crag/vm-spool/<msg_uuid>.json   META, same bytes    (0600)
--   Written as <name>.tmp, fsync'd, then renamed (.json FIRST, .cms LAST):
--   the forwarder (docker/vm-forwarder) only ever picks up a .cms whose
--   .json exists, and sweeps .tmp / orphan leftovers after an hour.
--   The sidecar is plaintext METADATA only (caller number/name, mailbox,
--   time) — what the forwarder needs to build X-VM-Meta without a key.
--
-- PLAINTEXT HYGIENE (voicemail D8 — unchanged by this file)
--   * Audio plaintext is read by openssl FROM tmpfs; the only bytes written
--     to persistent disk are ciphertext and the metadata sidecar.
--   * The frame (/dev/shm/vm/s_<uuid>.bin), the tmpfs copy of META
--     (j_<uuid>.json) and the recipient certificates (r<k>_<uuid>.pem) are
--     registered with vm_box's cleanup BEFORE they exist, and unlinked as
--     soon as openssl returns (success or not); vm_box unlinks the recording
--     right after a successful seal; the 15-min tmpfs sweep catches anything
--     a crash left behind. openssl reads the whole input into memory (no
--     -stream) and writes no temporary files.
--   * No key ever reaches this VM's disk: the recipients file holds public
--     certificates only.
--
-- SPOOL BOUNDS: the forwarder enforces the caps (7 days / 2 GB per VM,
-- oldest first, audited). This file only has a SAFETY CEILING for the case
-- where the forwarder is not running: it refuses to seal (the message is
-- lost, as before this file existed, with an ERROR) when the spool already
-- holds SAFETY_CEILING_KB, or the filesystem has less than MIN_FREE_KB free —
-- a media VM's disk must never fill up because of voicemail.
--
-- SHELL-SAFETY RULE (same as lib/vm_deposit.lua): the only variable parts of
-- a command are fixed directories + a validated UUIDv4 + a recipient index
-- 1..4. Caller data exists only inside files, never on a command line.
--
-- Syntax: Lua 5.1/5.3-common (FS runs 5.3). Never raises out of seal().

local M = {}

M.SPOOL_DIR       = "/var/lib/crag/vm-spool"
M.RECIPIENTS_FILE = "/run/revup/vm_spool_recipients.pem"
M.MOUNTS_FILE     = "/proc/self/mounts"

M.FRAME_MAGIC        = "CRAGVMS1"
M.META_MAX           = 4096                 -- bytes of META JSON (real: < 400)
M.MAX_RECIPIENTS     = 4
M.RECIPIENTS_MAX_LEN = 65536
M.SAFETY_CEILING_KB  = 4 * 1024 * 1024      -- 4 GiB = 2 x the forwarder's 2 GB cap
M.MIN_FREE_KB        = 1024 * 1024          -- keep >= 1 GiB free on the volume's disk
M.SEAL_TIMEOUT_S     = 30                   -- coreutils timeout around openssl
M.COPY_CHUNK         = 65536

-- DER prefix of the id-ct-authEnvelopedData OID (1.2.840.113549.1.9.16.1.23).
M.AUTH_ENVELOPED_OID = "\6\11\42\134\72\134\247\13\1\9\16\1\23"

local UUID4_PATTERN = "^%x%x%x%x%x%x%x%x%-%x%x%x%x%-4%x%x%x%-[89ab]%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$"
local OAEP_OPTS = "-keyopt rsa_padding_mode:oaep -keyopt rsa_oaep_md:sha256"
    .. " -keyopt rsa_mgf1_md:sha256"

local function log(level, msg)
    if freeswitch and freeswitch.consoleLog then
        freeswitch.consoleLog(level, "[vm_spool] " .. msg .. "\n")
    end
end

-- POSIX sh single-quote (defense in depth: every quoted value already passed
-- a strict validation).
local function shq(s)
    return "'" .. tostring(s):gsub("'", "'\\''") .. "'"
end

local function is_uuid4(s)
    return type(s) == "string" and s:match(UUID4_PATTERN) ~= nil
end
M.is_uuid4 = is_uuid4

-- Every path this module ever touches, for one message. vm_dir is the
-- tmpfs (lib/vm_deposit.lua VM_DIR).
function M.paths(vm_dir, msg_uuid)
    if not is_uuid4(msg_uuid) or type(vm_dir) ~= "string" then return nil end
    local p = {
        frame    = vm_dir .. "/s_" .. msg_uuid .. ".bin",
        meta_tmp = vm_dir .. "/j_" .. msg_uuid .. ".json",
        cms_tmp  = M.SPOOL_DIR .. "/" .. msg_uuid .. ".cms.tmp",
        cms      = M.SPOOL_DIR .. "/" .. msg_uuid .. ".cms",
        json_tmp = M.SPOOL_DIR .. "/" .. msg_uuid .. ".json.tmp",
        json     = M.SPOOL_DIR .. "/" .. msg_uuid .. ".json",
        recip    = {},
    }
    for k = 1, M.MAX_RECIPIENTS do
        p.recip[k] = vm_dir .. "/r" .. k .. "_" .. msg_uuid .. ".pem"
    end
    return p
end

-- True when the spool directory is its own mount (the vm_spool volume). Fail
-- closed: without the volume the files would land in the container's
-- writable layer — invisible to the forwarder and gone on recreate.
function M.spool_mounted()
    local f = io.open(M.MOUNTS_FILE, "r")
    if not f then return false end
    local content = f:read("*a") or ""
    f:close()
    for line in content:gmatch("[^\n]+") do
        local mnt = line:match("^%S+%s+(%S+)%s+%S+")
        if mnt == M.SPOOL_DIR then
            return true
        end
    end
    return false
end

-- The recipients file -> list of PEM certificate blocks (1..MAX_RECIPIENTS),
-- or nil + reason. Only structure is checked here; openssl parses them.
function M.read_recipients()
    local f = io.open(M.RECIPIENTS_FILE, "r")
    if not f then
        return nil, "recipients file " .. M.RECIPIENTS_FILE .. " missing or unreadable"
    end
    local content = f:read(M.RECIPIENTS_MAX_LEN + 1) or ""
    f:close()
    if #content > M.RECIPIENTS_MAX_LEN then
        return nil, "recipients file too large"
    end
    content = content:gsub("\r", "")
    local certs = {}
    for body in content:gmatch("%-%-%-%-%-BEGIN CERTIFICATE%-%-%-%-%-\n(.-)\n%-%-%-%-%-END CERTIFICATE%-%-%-%-%-") do
        if not body:match("^[A-Za-z0-9+/=\n]+$") then
            return nil, "recipients file holds a malformed certificate block"
        end
        certs[#certs + 1] = "-----BEGIN CERTIFICATE-----\n" .. body .. "\n-----END CERTIFICATE-----\n"
    end
    if #certs == 0 then
        return nil, "recipients file holds no certificate"
    end
    if #certs > M.MAX_RECIPIENTS then
        return nil, "recipients file holds more than " .. M.MAX_RECIPIENTS .. " certificates"
    end
    if content:find("PRIVATE KEY", 1, true) then
        -- never seal with (or keep) a private key on a media VM
        return nil, "recipients file contains a PRIVATE KEY block — remove it from the media VM"
    end
    return certs
end

-- ----------------------------------------------------------------------
-- Command builders (pure; the harness asserts their exact output)
-- ----------------------------------------------------------------------

-- Seal: openssl -> <uuid>.cms.tmp, the tmpfs META -> <uuid>.json.tmp (0600
-- via install), fsync both, print a marker. stderr is captured (openssl's
-- messages carry no plaintext or key material) for the ERROR log.
function M.seal_cmd(p, n_recip)
    if not p or type(n_recip) ~= "number" or n_recip < 1 or n_recip > M.MAX_RECIPIENTS
        or n_recip ~= math.floor(n_recip) then
        return nil
    end
    local recips = {}
    for k = 1, n_recip do
        recips[#recips + 1] = "-recip " .. shq(p.recip[k]) .. " " .. OAEP_OPTS
    end
    return string.format(
        "{ umask 077 && timeout %d openssl cms -encrypt -binary -aes-256-gcm -keyid -outform DER"
        .. " -in %s -out %s %s && install -m 0600 %s %s && sync %s %s && echo SEALED_OK; } 2>&1",
        M.SEAL_TIMEOUT_S, shq(p.frame), shq(p.cms_tmp), table.concat(recips, " "),
        shq(p.meta_tmp), shq(p.json_tmp), shq(p.cms_tmp), shq(p.json_tmp))
end

-- Usage of the spool (KiB) and free space on its filesystem (KiB).
function M.usage_cmd()
    return string.format("du -sk %s 2>/dev/null; df -Pk %s 2>/dev/null",
        shq(M.SPOOL_DIR), shq(M.SPOOL_DIR))
end

-- fsync the directory entries after the two renames.
function M.sync_dir_cmd()
    return "sync " .. shq(M.SPOOL_DIR) .. " >/dev/null 2>&1"
end

-- "<kb>\t<path>\nFilesystem ...\n<fs> <blocks> <used> <avail> <cap> <mnt>"
-- -> used_kb, free_kb (either may be nil when unparsable).
function M.parse_usage(out)
    out = out or ""
    local used = tonumber(out:match("^%s*(%d+)%s"))
    local free
    for line in out:gmatch("[^\n]+") do
        local avail = line:match("^%S+%s+%d+%s+%d+%s+(%d+)%s+%d+%%")
        if avail then free = tonumber(avail) end
    end
    return used, free
end

-- ----------------------------------------------------------------------
-- Execution helpers
-- ----------------------------------------------------------------------
local function run(cmd)
    local ok, h = pcall(io.popen, cmd, "r")
    if not ok or not h then return nil end
    local rok, out = pcall(h.read, h, "*a")
    pcall(h.close, h)
    if not rok then return nil end
    return out or ""
end

local function write_all(path, data)
    local f = io.open(path, "wb")
    if not f then return false end
    local ok = f:write(data)
    f:close()
    return ok and true or false
end

-- tmpfs frame = MAGIC "\n" len "\n" META WAV (the WAV is streamed in chunks).
local function write_frame(frame_path, meta_json, wav_path)
    local src = io.open(wav_path, "rb")
    if not src then return false, "recording unreadable" end
    local dst = io.open(frame_path, "wb")
    if not dst then
        src:close()
        return false, "cannot create the frame in tmpfs (tmpfs full?)"
    end
    local ok = dst:write(M.FRAME_MAGIC, "\n", tostring(#meta_json), "\n", meta_json)
    while ok do
        local chunk = src:read(M.COPY_CHUNK)
        if not chunk then break end
        ok = dst:write(chunk)
    end
    src:close()
    dst:close()
    if not ok then return false, "frame write failed (tmpfs full?)" end
    return true
end

-- The sealed file must look like a DER ContentInfo of authEnvelopedData.
function M.looks_sealed(path)
    local f = io.open(path, "rb")
    if not f then return false end
    local head = f:read(32) or ""
    local size = f:seek("end") or 0
    f:close()
    if size < 64 or head:byte(1) ~= 0x30 then return false end
    return head:find(M.AUTH_ENVELOPED_OID, 1, true) ~= nil
end

local function clean_out(s)
    s = tostring(s or ""):gsub("%c", " "):gsub("%s+", " ")
    return s:sub(1, 300)
end

-- ----------------------------------------------------------------------
-- seal(a) — never raises. a = {
--   msg_uuid   validated UUIDv4 (the deposit's msg_uuid)
--   vm_dir     tmpfs dir (lib/vm_deposit.lua VM_DIR)
--   wav_path   the recording in tmpfs
--   meta_json  the META JSON string (built by vm_box)
--   register(path) / unlink(path)   vm_box's tmpfs file registry
--   tag        log prefix
-- }
-- Returns { ok = true, bytes = n } or { ok = false, detail = "..." }.
-- ----------------------------------------------------------------------
function M.seal(a)
    local ok, res = pcall(function()
        local tag = a.tag or ""
        local p = M.paths(a.vm_dir, a.msg_uuid)
        if not p then return { ok = false, detail = "invalid message uuid" } end
        if type(a.meta_json) ~= "string" or #a.meta_json == 0 or #a.meta_json > M.META_MAX then
            return { ok = false, detail = "metadata missing or too large" }
        end
        if not M.spool_mounted() then
            return { ok = false, detail = M.SPOOL_DIR .. " is not mounted (recreate the FS container)" }
        end
        local certs, cerr = M.read_recipients()
        if not certs then return { ok = false, detail = cerr } end

        local used, free = M.parse_usage(run(M.usage_cmd()))
        if used and used >= M.SAFETY_CEILING_KB then
            return { ok = false, detail = string.format(
                "spool holds %d KiB >= safety ceiling %d KiB (is vm-forwarder running?)",
                used, M.SAFETY_CEILING_KB) }
        end
        if free and free < M.MIN_FREE_KB then
            return { ok = false, detail = string.format(
                "only %d KiB free on the spool filesystem (< %d KiB)", free, M.MIN_FREE_KB) }
        end
        if not used or not free then
            log("WARNING", tag .. "could not measure the spool (du/df) — sealing anyway")
        end

        -- Every tmpfs path is registered BEFORE it can exist.
        local tmp = { p.frame, p.meta_tmp }
        for k = 1, #certs do tmp[#tmp + 1] = p.recip[k] end
        for _, path in ipairs(tmp) do a.register(path) end

        local function drop_tmpfs()
            for _, path in ipairs(tmp) do a.unlink(path) end
        end
        local function drop_spool_tmp()
            pcall(os.remove, p.cms_tmp)
            pcall(os.remove, p.json_tmp)
        end

        for k = 1, #certs do
            if not write_all(p.recip[k], certs[k]) then
                drop_tmpfs()
                return { ok = false, detail = "cannot write recipient certificate to tmpfs" }
            end
        end
        if not write_all(p.meta_tmp, a.meta_json) then
            drop_tmpfs()
            return { ok = false, detail = "cannot write metadata to tmpfs" }
        end
        local fok, ferr = write_frame(p.frame, a.meta_json, a.wav_path)
        if not fok then
            drop_tmpfs()
            return { ok = false, detail = ferr }
        end

        local out = run(M.seal_cmd(p, #certs))
        drop_tmpfs()   -- plaintext frame + META copy + certs: gone right away
        if not out or not out:find("SEALED_OK", 1, true) then
            drop_spool_tmp()
            return { ok = false, detail = "openssl seal failed: " .. clean_out(out) }
        end
        if not M.looks_sealed(p.cms_tmp) then
            drop_spool_tmp()
            return { ok = false, detail = "sealed output is not a CMS AuthEnvelopedData blob" }
        end
        local sf = io.open(p.cms_tmp, "rb")
        local bytes = sf and sf:seek("end") or 0
        if sf then sf:close() end

        -- .json first, .cms last: the forwarder never sees a .cms without
        -- its metadata.
        local r1, e1 = os.rename(p.json_tmp, p.json)
        if not r1 then
            drop_spool_tmp()
            return { ok = false, detail = "rename of the metadata failed: " .. tostring(e1) }
        end
        local r2, e2 = os.rename(p.cms_tmp, p.cms)
        if not r2 then
            pcall(os.remove, p.json)
            drop_spool_tmp()
            return { ok = false, detail = "rename of the sealed blob failed: " .. tostring(e2) }
        end
        pcall(os.execute, M.sync_dir_cmd())
        return { ok = true, bytes = bytes, recipients = #certs }
    end)
    if not ok then
        return { ok = false, detail = "seal raised: " .. tostring(res) }
    end
    return res
end

-- ----------------------------------------------------------------------
-- Self-test (deploy verification, owner runbook):
--   fs_cli -x 'lua lib/vm_spool.lua selftest'
-- Seals a synthetic, non-audio payload to the recipients in tmpfs (never
-- the spool), checks the output is AuthEnvelopedData, removes everything and
-- prints one line: "vm_spool selftest OK: ..." or "vm_spool selftest FAIL: ...".
-- ----------------------------------------------------------------------
function M.selftest(vm_dir, uuid)
    vm_dir = vm_dir or "/dev/shm/vm"
    local p = M.paths(vm_dir, uuid)
    if not p then return "vm_spool selftest FAIL: no UUID" end
    local lines = {}
    local function add(s) lines[#lines + 1] = s end
    add(M.spool_mounted() and "spool mounted" or "spool NOT mounted")
    local certs, cerr = M.read_recipients()
    if not certs then return "vm_spool selftest FAIL: " .. tostring(cerr) end
    local out_der = vm_dir .. "/t_" .. uuid .. ".der"
    local q = {
        frame = p.frame, meta_tmp = p.meta_tmp, recip = p.recip,
        cms_tmp = out_der, json_tmp = p.meta_tmp .. ".copy",
    }
    local created = { p.frame, p.meta_tmp, out_der, q.json_tmp }
    for k = 1, #certs do created[#created + 1] = p.recip[k] end
    local result
    if not (write_all(p.meta_tmp, "{\"selftest\":true}") and write_all(p.frame, "CRAGVMS1-SELFTEST")) then
        result = "vm_spool selftest FAIL: cannot write to " .. tostring(vm_dir)
    else
        for k = 1, #certs do write_all(p.recip[k], certs[k]) end
        local out = run(M.seal_cmd(q, #certs))
        if out and out:find("SEALED_OK", 1, true) and M.looks_sealed(out_der) then
            local used, free = M.parse_usage(run(M.usage_cmd()))
            add("sealed to " .. #certs .. " recipient(s)")
            add("spool " .. tostring(used) .. " KiB used, " .. tostring(free) .. " KiB free")
            result = (M.spool_mounted() and "vm_spool selftest OK: " or "vm_spool selftest FAIL: ")
                .. table.concat(lines, ", ")
        else
            result = "vm_spool selftest FAIL: " .. clean_out(out)
        end
    end
    for _, path in ipairs(created) do pcall(os.remove, path) end
    return result
end

-- Script mode (only when run directly as `lua lib/vm_spool.lua selftest`;
-- never when vm_box loadfile()s it — argv[0] is then the router's name).
if type(argv) == "table" and tostring(argv[0] or ""):match("vm_spool%.lua$")
    and argv[1] == "selftest" then
    local dep_chunk = loadfile("/usr/local/freeswitch/scripts/lib/vm_deposit.lua")
    local dep = dep_chunk and dep_chunk()
    local line = M.selftest(dep and dep.VM_DIR, dep and dep.uuid4())
    if stream and stream.write then
        stream:write(line .. "\n")
    else
        log("INFO", line)
    end
end

return M
