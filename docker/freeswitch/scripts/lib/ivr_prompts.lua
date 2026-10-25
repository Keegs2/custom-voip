-- lib/ivr_prompts.lua — content-addressed IVR prompt cache on the media VM.
--
-- Contract: docs/IVR_INTERFACES.md §4 (FS cache) and §1 (ivr_prompt_audio);
-- plan §3 / §7.4 (D9: no call-time dependency on East).
--
-- Every prompt in a published plan is named by the sha256 (lowercase hex) of
-- its exact WAV bytes. The audio lives in Postgres (ivr_prompt_audio, written
-- by the East API in the publish transaction) and replicates to every zone's
-- replica with the plan, so a published version can never reference audio the
-- zone lacks. FreeSWITCH reads only its LOCAL replica and caches by sha on a
-- persistent volume:
--
--   /var/lib/crag/ivr-prompts/<sha256>.wav        (volume `ivr_prompts`, §7)
--
-- HIT   the file exists and its 44-byte header is the canonical format with a
--       data size that matches the file size. (The sha is NOT re-hashed on a
--       hit: the file was verified before it was renamed into place, and the
--       name is the content address.) A hit that fails the header check is
--       treated as a miss and replaced.
-- MISS  1. SELECT encode(wav,'hex') FROM ivr_prompt_audio WHERE sha256 = $1
--          on the local replica (db_client.fetch_ivr_prompt_hex)
--       2. hex-decode
--       3. verify sha256(bytes) == the requested sha AND the canonical
--          RIFF/WAVE header (PCM 1, mono, 8000 Hz, 16-bit, one data chunk)
--       4. write <sha>.tmp.<token>, then os.rename onto <sha>.wav (atomic on
--          the same filesystem; a concurrent miss for the same sha writes its
--          own tmp and renames identical bytes over the same name)
-- Any failure returns nil + reason; the engine then plays the system prompt
-- `technical_difficulty.wav`, hangs up and records ivr_exit=error (§4).
--
-- SECURITY: the only path this module builds is CACHE_DIR/<sha>.wav where
-- <sha> has been checked against ^[0-9a-f]{64}$, plus the tmp name with a
-- [%w-]-only token. No customer string reaches a filename, a shell or an FS
-- application argument.
--
-- Pure Lua 5.3 (integer bitwise operators, string.pack/unpack); io/os are
-- resolved at call time so the harness sandbox can stub them. Loaded with the
-- house loadfile() pattern.

local M = {}

M.CACHE_DIR = "/var/lib/crag/ivr-prompts"
M.SYSTEM_DIR = "/usr/local/freeswitch/scripts/sounds/ivr"
M.MAX_SECONDS = 120                                   -- contract §4
M.SAMPLE_RATE = 8000
M.MAX_BYTES = 44 + M.MAX_SECONDS * M.SAMPLE_RATE * 2  -- 1,920,044
M.MAX_HEX = M.MAX_BYTES * 2

-- System prompts shipped in the repo (scripts/sounds/ivr/, bind-mounted).
-- Missing file => tone fallback, never a failure (vm_box precedent).
M.SYSTEM = {
    technical_difficulty = { file = "technical_difficulty.wav",
                             tone = "tone_stream://L=6;%(250,250,480,620)" },
    goodbye              = { file = "goodbye.wav",
                             tone = "tone_stream://%(300,100,480);%(300,0,400)" },
}

local function log(level, msg)
    if freeswitch and freeswitch.consoleLog then
        freeswitch.consoleLog(level, "[ivr_prompts] " .. msg .. "\n")
    end
end

function M.is_sha(s)
    return type(s) == "string" and #s == 64 and s:match("^[0-9a-f]+$") ~= nil
end

function M.path_for(sha)
    if not M.is_sha(sha) then return nil end
    return M.CACHE_DIR .. "/" .. sha .. ".wav"
end

-- ------------------------------------------------------------------
-- SHA-256 (FIPS 180-4), Lua 5.3 integers. Measured 0.16 s for the 1.92 MB
-- worst case (120 s prompt) on the dev box; typical prompts take a few ms.
-- Only a cold miss hashes (once per sha per zone).
-- ------------------------------------------------------------------
local K = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
}
local BLOCK_FMT = ">" .. string.rep("I4", 16)

function M.sha256_hex(msg)
    local h0, h1, h2, h3 = 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a
    local h4, h5, h6, h7 = 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    local len = #msg
    local full = len - len % 64
    local tail = msg:sub(full + 1) .. "\128" .. string.rep("\0", (55 - len) % 64)
        .. string.pack(">I8", len * 8)
    local w = {}

    local function compress(s, pos)
        w[1], w[2], w[3], w[4], w[5], w[6], w[7], w[8],
        w[9], w[10], w[11], w[12], w[13], w[14], w[15], w[16] = string.unpack(BLOCK_FMT, s, pos)
        for i = 17, 64 do
            local a, b = w[i - 15], w[i - 2]
            local s0 = ((a >> 7) | (a << 25)) ~ ((a >> 18) | (a << 14)) ~ (a >> 3)
            local s1 = ((b >> 17) | (b << 15)) ~ ((b >> 19) | (b << 13)) ~ (b >> 10)
            w[i] = (w[i - 16] + (s0 & 0xffffffff) + w[i - 7] + (s1 & 0xffffffff)) & 0xffffffff
        end
        local a, b, c, d, e, f, g, h = h0, h1, h2, h3, h4, h5, h6, h7
        for i = 1, 64 do
            local S1 = (((e >> 6) | (e << 26)) ~ ((e >> 11) | (e << 21)) ~ ((e >> 25) | (e << 7))) & 0xffffffff
            local ch = (e & f) ~ ((~e) & g)
            local t1 = (h + S1 + (ch & 0xffffffff) + K[i] + w[i]) & 0xffffffff
            local S0 = (((a >> 2) | (a << 30)) ~ ((a >> 13) | (a << 19)) ~ ((a >> 22) | (a << 10))) & 0xffffffff
            local maj = (a & b) ~ (a & c) ~ (b & c)
            h = g; g = f; f = e
            e = (d + t1) & 0xffffffff
            d = c; c = b; b = a
            a = (t1 + S0 + maj) & 0xffffffff
        end
        h0 = (h0 + a) & 0xffffffff; h1 = (h1 + b) & 0xffffffff
        h2 = (h2 + c) & 0xffffffff; h3 = (h3 + d) & 0xffffffff
        h4 = (h4 + e) & 0xffffffff; h5 = (h5 + f) & 0xffffffff
        h6 = (h6 + g) & 0xffffffff; h7 = (h7 + h) & 0xffffffff
    end

    for pos = 1, full, 64 do compress(msg, pos) end
    for pos = 1, #tail, 64 do compress(tail, pos) end
    return string.format("%08x%08x%08x%08x%08x%08x%08x%08x", h0, h1, h2, h3, h4, h5, h6, h7)
end

-- ------------------------------------------------------------------
-- Hex decode (table-driven gsub: no per-byte function call)
-- ------------------------------------------------------------------
local HEXPAIR = {}
for i = 0, 255 do
    HEXPAIR[string.format("%02x", i)] = string.char(i)
    HEXPAIR[string.format("%02X", i)] = string.char(i)
end

function M.hex_decode(hex)
    if type(hex) ~= "string" or #hex % 2 ~= 0 or hex:find("[^0-9a-fA-F]") then
        return nil
    end
    return (hex:gsub("..", HEXPAIR))
end

-- ------------------------------------------------------------------
-- Canonical WAV check (contract §4): RIFF/WAVE, a 16-byte `fmt ` chunk with
-- PCM (1), 1 channel, 8000 Hz, byte rate 16000, block align 2, 16 bits, then a
-- single `data` chunk running exactly to the end of the file.
-- ------------------------------------------------------------------
local function check_header(hdr, total_len)
    if type(hdr) ~= "string" or #hdr < 44 then return nil, "shorter than a WAV header" end
    if hdr:sub(1, 4) ~= "RIFF" or hdr:sub(9, 12) ~= "WAVE" then return nil, "not RIFF/WAVE" end
    if hdr:sub(13, 16) ~= "fmt " then return nil, "fmt chunk not first" end
    local riff_size = string.unpack("<I4", hdr, 5)
    local fmt_size, fmt, ch, rate, byte_rate, align, bits =
        string.unpack("<I4I2I2I4I4I2I2", hdr, 17)
    if fmt_size ~= 16 then return nil, "fmt chunk size " .. fmt_size end
    if fmt ~= 1 then return nil, "not PCM (format " .. fmt .. ")" end
    if ch ~= 1 then return nil, "not mono (" .. ch .. " channels)" end
    if rate ~= M.SAMPLE_RATE then return nil, "sample rate " .. rate end
    if bits ~= 16 then return nil, bits .. "-bit" end
    if byte_rate ~= M.SAMPLE_RATE * 2 or align ~= 2 then return nil, "bad byte rate/align" end
    if hdr:sub(37, 40) ~= "data" then return nil, "data chunk not at byte 36" end
    local data_size = string.unpack("<I4", hdr, 41)
    if data_size % 2 ~= 0 then return nil, "odd data size" end
    if total_len ~= 44 + data_size then return nil, "data size does not match the file length" end
    if riff_size ~= total_len - 8 then return nil, "RIFF size does not match the file length" end
    if total_len > M.MAX_BYTES then return nil, "longer than " .. M.MAX_SECONDS .. " s" end
    return true
end

function M.check_wav(bytes)
    if type(bytes) ~= "string" then return nil, "no bytes" end
    return check_header(bytes:sub(1, 44), #bytes)
end

-- Cheap hit check: header + file length, no hashing.
local function cached_ok(path)
    local f = io.open(path, "rb")
    if not f then return false end
    local ok, res = pcall(function()
        local hdr = f:read(44)
        local size = f:seek("end")
        return check_header(hdr, size)
    end)
    pcall(function() f:close() end)
    return ok and res == true
end

local tmp_seq = 0
local function tmp_path(sha, token)
    tmp_seq = tmp_seq + 1
    local t = tostring(token or ""):gsub("[^%w%-]", "")
    if #t > 64 then t = t:sub(1, 64) end
    if t == "" then
        t = string.format("%d-%d", os.time(), math.random(1, 0x7fffffff))
    end
    return string.format("%s/%s.tmp.%s-%d", M.CACHE_DIR, sha, t, tmp_seq)
end

local dir_checked = false

local function write_atomic(sha, bytes, token)
    local final = M.path_for(sha)
    local tmp = tmp_path(sha, token)
    local f = io.open(tmp, "wb")
    if not f and not dir_checked then
        -- The ivr_prompts volume is not mounted (container not recreated yet):
        -- create the directory once (constant command) and keep going — the
        -- cache then lives in the container layer until the recreate.
        dir_checked = true
        log("WARNING", M.CACHE_DIR .. " missing — creating it (is the ivr_prompts volume mounted?)")
        pcall(os.execute, "mkdir -p " .. M.CACHE_DIR)
        f = io.open(tmp, "wb")
    end
    if not f then return nil, "cannot write " .. tmp end
    local ok, err = pcall(function()
        assert(f:write(bytes))
        assert(f:flush())
    end)
    pcall(function() f:close() end)
    if not ok then
        pcall(os.remove, tmp)
        return nil, "write failed: " .. tostring(err)
    end
    local rok, rerr = os.rename(tmp, final)
    if not rok then
        pcall(os.remove, tmp)
        return nil, "rename failed: " .. tostring(rerr)
    end
    return final
end

-- ensure(sha, opts) -> cache path | nil, reason
--   opts.db     db_client (fetch_ivr_prompt_hex)
--   opts.token  [%w-] token for the tmp name (the call uuid)
--   opts.stats  optional { hits = n, misses = n } counter table
function M.ensure(sha, opts)
    opts = opts or {}
    local path = M.path_for(sha)
    if not path then return nil, "invalid sha" end
    if cached_ok(path) then
        if opts.stats then opts.stats.hits = (opts.stats.hits or 0) + 1 end
        return path
    end
    if opts.stats then opts.stats.misses = (opts.stats.misses or 0) + 1 end
    local db = opts.db
    if not db or type(db.fetch_ivr_prompt_hex) ~= "function" then
        return nil, "db unavailable"
    end
    local ok, hex, err = pcall(db.fetch_ivr_prompt_hex, sha)
    if not ok then return nil, "fetch raised: " .. tostring(hex) end
    if not hex then return nil, "not in ivr_prompt_audio (" .. tostring(err or "no row") .. ")" end
    if #hex > M.MAX_HEX then return nil, "audio larger than the contract cap" end
    local bytes = M.hex_decode(hex)
    if not bytes then return nil, "bad hex from the replica" end
    local wok, werr = M.check_wav(bytes)
    if not wok then return nil, "bad WAV: " .. tostring(werr) end
    local got = M.sha256_hex(bytes)
    if got ~= sha then return nil, "sha256 mismatch (got " .. got .. ")" end
    local final, ferr = write_atomic(sha, bytes, opts.token)
    if not final then return nil, ferr end
    log("INFO", "cached " .. sha .. " (" .. #bytes .. " bytes)")
    return final
end

-- Is every sha already cached (no DB work needed)?
function M.all_cached(shas)
    for _, sha in ipairs(shas or {}) do
        local p = M.path_for(sha)
        if not p or not cached_ok(p) then return false end
    end
    return true
end

-- prefetch(shas, opts) -> true | nil, reason, sha. Stops at the first failure.
function M.prefetch(shas, opts)
    for _, sha in ipairs(shas or {}) do
        local p, err = M.ensure(sha, opts)
        if not p then return nil, err, sha end
    end
    return true
end

-- system(name) -> playable path, or the tone fallback when the file is
-- missing/unreadable (a missing system prompt must never fail a call).
function M.system(name)
    local spec = M.SYSTEM[name]
    if not spec then return nil end
    local path = M.SYSTEM_DIR .. "/" .. spec.file
    local f = io.open(path, "rb")
    if f then
        pcall(function() f:close() end)
        return path
    end
    log("WARNING", "system prompt " .. path .. " missing — playing a tone instead")
    return spec.tone
end

return M
