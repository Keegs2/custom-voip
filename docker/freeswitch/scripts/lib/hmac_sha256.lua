-- lib/hmac_sha256.lua — pure-Lua SHA-256 + HMAC-SHA256 + Base64 (no C deps).
--
-- WHY: mod_lua ships no crypto, and the cpath is too fragile to load a C
-- extension reliably (freeswitch/scripts/CLAUDE.md gotcha #10). This single file
-- provides exactly what the webhook-signing contract needs:
--
--   local hmac = <loadfile lib/hmac_sha256.lua>()
--   local sig  = hmac.sign(secret, signing_string)   -- base64 X-Revup-Signature
--
-- The signature is base64( HMAC_SHA256(secret, signing_string) ), byte-for-byte
-- compatible with the Python verifier (Twilio-style). Requires Lua 5.3+ integer
-- bitwise operators (mod_lua is 5.3; CI host is 5.4) — both have them.
--
-- KNOWN-ANSWER TEST (asserted live in the rebuilt container, see Phase 3 report):
--   sign("testsecret", "https://example.com/voiceFrom+15551234To+15555678")

local M = {}

local MASK = 0xFFFFFFFF

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

-- 32-bit right rotate.
local function rrot(x, n)
    return ((x >> n) | (x << (32 - n))) & MASK
end

-- SHA-256 over a binary string. Returns the 32-byte raw digest (a string).
local function sha256(msg)
    local h0, h1, h2, h3 = 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a
    local h4, h5, h6, h7 = 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19

    local bitlen = #msg * 8

    -- Padding: 0x80, then zeros to 56 mod 64, then 64-bit big-endian length.
    msg = msg .. "\128"
    while (#msg % 64) ~= 56 do
        msg = msg .. "\0"
    end
    local lenbytes = {}
    local bl = bitlen
    for i = 8, 1, -1 do
        lenbytes[i] = string.char(bl & 0xFF)
        bl = bl >> 8
    end
    msg = msg .. table.concat(lenbytes)

    local w = {}
    for chunk = 1, #msg, 64 do
        for i = 1, 16 do
            local j = chunk + (i - 1) * 4
            local b1, b2, b3, b4 = msg:byte(j, j + 3)
            w[i] = ((b1 << 24) | (b2 << 16) | (b3 << 8) | b4) & MASK
        end
        for i = 17, 64 do
            local w15 = w[i - 15]
            local w2 = w[i - 2]
            local s0 = rrot(w15, 7) ~ rrot(w15, 18) ~ (w15 >> 3)
            local s1 = rrot(w2, 17) ~ rrot(w2, 19) ~ (w2 >> 10)
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & MASK
        end

        local a, b, c, d = h0, h1, h2, h3
        local e, f, g, h = h4, h5, h6, h7

        for i = 1, 64 do
            local S1 = rrot(e, 6) ~ rrot(e, 11) ~ rrot(e, 25)
            local ch = (e & f) ~ ((~e & MASK) & g)
            local temp1 = (h + S1 + ch + K[i] + w[i]) & MASK
            local S0 = rrot(a, 2) ~ rrot(a, 13) ~ rrot(a, 22)
            local maj = (a & b) ~ (a & c) ~ (b & c)
            local temp2 = (S0 + maj) & MASK
            h = g
            g = f
            f = e
            e = (d + temp1) & MASK
            d = c
            c = b
            b = a
            a = (temp1 + temp2) & MASK
        end

        h0 = (h0 + a) & MASK
        h1 = (h1 + b) & MASK
        h2 = (h2 + c) & MASK
        h3 = (h3 + d) & MASK
        h4 = (h4 + e) & MASK
        h5 = (h5 + f) & MASK
        h6 = (h6 + g) & MASK
        h7 = (h7 + h) & MASK
    end

    local function be32(x)
        return string.char((x >> 24) & 0xFF, (x >> 16) & 0xFF, (x >> 8) & 0xFF, x & 0xFF)
    end
    return be32(h0) .. be32(h1) .. be32(h2) .. be32(h3) ..
           be32(h4) .. be32(h5) .. be32(h6) .. be32(h7)
end
M.sha256 = sha256

-- HMAC-SHA256(key, message) -> 32-byte raw digest string.
local function hmac_sha256(key, message)
    local blocksize = 64
    if #key > blocksize then
        key = sha256(key)
    end
    if #key < blocksize then
        key = key .. string.rep("\0", blocksize - #key)
    end

    local o_pad = {}
    local i_pad = {}
    for i = 1, blocksize do
        local b = key:byte(i)
        o_pad[i] = string.char(b ~ 0x5c)
        i_pad[i] = string.char(b ~ 0x36)
    end
    o_pad = table.concat(o_pad)
    i_pad = table.concat(i_pad)

    return sha256(o_pad .. sha256(i_pad .. message))
end
M.hmac_sha256 = hmac_sha256

local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

-- Standard Base64 encode of a binary string.
local function base64_encode(data)
    local out = {}
    local n = #data
    local i = 1
    while i <= n do
        local b1 = data:byte(i)
        local b2 = data:byte(i + 1)
        local b3 = data:byte(i + 2)
        local c1 = b1 >> 2
        local c2 = ((b1 & 0x03) << 4) | ((b2 or 0) >> 4)
        local idx = #out
        out[idx + 1] = B64:sub(c1 + 1, c1 + 1)
        out[idx + 2] = B64:sub(c2 + 1, c2 + 1)
        if b2 then
            local c3 = ((b2 & 0x0F) << 2) | ((b3 or 0) >> 6)
            out[idx + 3] = B64:sub(c3 + 1, c3 + 1)
            if b3 then
                local c4 = b3 & 0x3F
                out[idx + 4] = B64:sub(c4 + 1, c4 + 1)
            else
                out[idx + 4] = "="
            end
        else
            out[idx + 3] = "="
            out[idx + 4] = "="
        end
        i = i + 3
    end
    return table.concat(out)
end
M.base64_encode = base64_encode

-- Lowercase hex of a binary string (handy for debugging / known-answer checks).
function M.hex(data)
    return (data:gsub(".", function(c)
        return string.format("%02x", c:byte())
    end))
end

-- The signing-contract entry point: base64( HMAC_SHA256(secret, signing_string) ).
function M.sign(secret, signing_string)
    return base64_encode(hmac_sha256(secret or "", signing_string or ""))
end

return M
