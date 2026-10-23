-- lib/json.lua — small, dependency-free JSON encode/decode for mod_lua.
--
-- Loaded with the repo's loadfile() pattern (mod_lua breaks require() for
-- local modules — scripts/CLAUDE.md "mod_lua Module Loading Workaround"):
--
--   local json = loadfile("/usr/local/freeswitch/scripts/lib/json.lua")()
--
-- Syntax is Lua 5.1/5.3-common (FreeSWITCH runs 5.3; the harnesses run on
-- the dev box's Lua): no bitwise operators, no goto, no integer division, no
-- string.pack/unpack.
--
-- encode(value) -> string | nil, err
--   * nil / json.null -> null; booleans; numbers (integral values without an
--     exponent or ".0", others with %.17g; NaN / +-inf are an error — JSON has
--     no spelling for them).
--   * strings: '"' '\' and every C0 control byte (0x00-0x1F) plus DEL (0x7F)
--     are escaped (\" \\ \b \f \n \r \t or \u00XX). Valid UTF-8 is passed
--     through byte-for-byte (no \u escaping of non-ASCII). INVALID UTF-8
--     (e.g. a Latin-1 SIP display name) is replaced, per offending byte, by
--     U+FFFD — the output is therefore ALWAYS valid UTF-8 JSON, so a strict
--     server-side parser (Python json.loads on bytes) can never reject it.
--   * tables: a table whose keys are exactly 1..n (n >= 1) is an array;
--     anything else is an object whose keys must be strings (numbers are
--     stringified); object keys are emitted in SORTED order so the output is
--     deterministic. An empty table encodes as {}. Cycles and nesting deeper
--     than MAX_DEPTH are errors. Functions/userdata/threads are errors.
--
-- decode(text) -> value | nil, err
--   * RFC 8259 grammar, strict: no comments, no trailing commas, no single
--     quotes, no leading zeros, no raw control bytes inside strings.
--   * null decodes to nil (an object member whose value is null is simply
--     absent) — callers that must see an explicit null compare against
--     json.null only where they ENCODE.
--   * \uXXXX escapes (incl. surrogate pairs) become UTF-8; a lone surrogate
--     becomes U+FFFD.
--   * nesting depth is capped (MAX_DEPTH) so hostile input cannot blow the C
--     stack of the FreeSWITCH session thread.
--   * never raises: every failure is returned as (nil, "message").

local M = {}

local MAX_DEPTH = 64

-- Sentinel for an explicit JSON null inside a table being encoded.
M.null = setmetatable({}, { __tostring = function() return "json.null" end })

-- ----------------------------------------------------------------------
-- UTF-8 helpers
-- ----------------------------------------------------------------------
local REPLACEMENT = "\239\191\189"   -- U+FFFD in UTF-8

local function codepoint_to_utf8(cp)
    if cp < 0x80 then
        return string.char(cp)
    elseif cp < 0x800 then
        return string.char(0xC0 + math.floor(cp / 0x40),
                           0x80 + cp % 0x40)
    elseif cp < 0x10000 then
        return string.char(0xE0 + math.floor(cp / 0x1000),
                           0x80 + math.floor(cp / 0x40) % 0x40,
                           0x80 + cp % 0x40)
    elseif cp <= 0x10FFFF then
        return string.char(0xF0 + math.floor(cp / 0x40000),
                           0x80 + math.floor(cp / 0x1000) % 0x40,
                           0x80 + math.floor(cp / 0x40) % 0x40,
                           0x80 + cp % 0x40)
    end
    return REPLACEMENT
end
M._codepoint_to_utf8 = codepoint_to_utf8

-- Length of the valid UTF-8 sequence starting at byte i of s, or nil when
-- the bytes at i do not start a valid (shortest-form, non-surrogate,
-- <= U+10FFFF) sequence. Only called for bytes >= 0x80.
local function utf8_seq_len(s, i)
    local c = s:byte(i)
    local n, min
    if c >= 0xC2 and c <= 0xDF then
        n, min = 2, 0x80
    elseif c >= 0xE0 and c <= 0xEF then
        n, min = 3, 0x800
    elseif c >= 0xF0 and c <= 0xF4 then
        n, min = 4, 0x10000
    else
        return nil
    end
    local cp = (n == 2 and c - 0xC0) or (n == 3 and c - 0xE0) or (c - 0xF0)
    for k = 1, n - 1 do
        local b = s:byte(i + k)
        if not b or b < 0x80 or b > 0xBF then
            return nil
        end
        cp = cp * 0x40 + (b - 0x80)
    end
    if cp < min or cp > 0x10FFFF or (cp >= 0xD800 and cp <= 0xDFFF) then
        return nil
    end
    return n
end

-- ----------------------------------------------------------------------
-- encode
-- ----------------------------------------------------------------------
local ESCAPES = {
    [0x22] = '\\"', [0x5C] = "\\\\",
    [0x08] = "\\b", [0x0C] = "\\f", [0x0A] = "\\n", [0x0D] = "\\r", [0x09] = "\\t",
}

local function encode_string(s)
    local out = { '"' }
    local i, len = 1, #s
    local run_start = 1
    while i <= len do
        local c = s:byte(i)
        if c < 0x20 or c == 0x22 or c == 0x5C or c == 0x7F then
            if run_start < i then out[#out + 1] = s:sub(run_start, i - 1) end
            out[#out + 1] = ESCAPES[c] or string.format("\\u%04x", c)
            i = i + 1
            run_start = i
        elseif c < 0x80 then
            i = i + 1
        else
            local n = utf8_seq_len(s, i)
            if n then
                i = i + n
            else
                if run_start < i then out[#out + 1] = s:sub(run_start, i - 1) end
                out[#out + 1] = REPLACEMENT
                i = i + 1
                run_start = i
            end
        end
    end
    if run_start <= len then out[#out + 1] = s:sub(run_start, len) end
    out[#out + 1] = '"'
    return table.concat(out)
end
M._encode_string = encode_string

local function encode_number(n)
    if n ~= n or n == math.huge or n == -math.huge then
        return nil, "cannot encode NaN/Infinity"
    end
    if n == math.floor(n) and n >= -2^53 and n <= 2^53 then
        return string.format("%d", n)
    end
    return string.format("%.17g", n)
end

local function is_array(t)
    local n = 0
    for k in pairs(t) do
        if type(k) ~= "number" or k < 1 or k ~= math.floor(k) then
            return false
        end
        n = n + 1
    end
    if n == 0 then return false end
    for k = 1, n do
        if t[k] == nil then return false end
    end
    return true, n
end

local encode_value

local function encode_table(t, depth, seen)
    if seen[t] then return nil, "cannot encode a cyclic table" end
    if depth > MAX_DEPTH then return nil, "nesting too deep" end
    seen[t] = true
    local out = {}
    local arr, n = is_array(t)
    if arr then
        for k = 1, n do
            local v, err = encode_value(t[k], depth + 1, seen)
            if not v then seen[t] = nil; return nil, err end
            out[#out + 1] = v
        end
        seen[t] = nil
        return "[" .. table.concat(out, ",") .. "]"
    end
    local keys = {}
    for k in pairs(t) do
        local kt = type(k)
        if kt == "string" then
            keys[#keys + 1] = k
        elseif kt == "number" then
            local ks = encode_number(k)
            if not ks then seen[t] = nil; return nil, "invalid numeric key" end
            keys[#keys + 1] = k
        else
            seen[t] = nil
            return nil, "object keys must be strings"
        end
    end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    for _, k in ipairs(keys) do
        local v, err = encode_value(t[k], depth + 1, seen)
        if not v then seen[t] = nil; return nil, err end
        local ks = (type(k) == "string") and k or encode_number(k)
        out[#out + 1] = encode_string(ks) .. ":" .. v
    end
    seen[t] = nil
    return "{" .. table.concat(out, ",") .. "}"
end

encode_value = function(v, depth, seen)
    local t = type(v)
    if v == nil or v == M.null then
        return "null"
    elseif t == "boolean" then
        return v and "true" or "false"
    elseif t == "number" then
        return encode_number(v)
    elseif t == "string" then
        return encode_string(v)
    elseif t == "table" then
        return encode_table(v, depth, seen)
    end
    return nil, "cannot encode a " .. t
end

function M.encode(v)
    local ok, res, err = pcall(encode_value, v, 0, {})
    if not ok then return nil, tostring(res) end
    if res == nil then return nil, err end
    return res
end

-- ----------------------------------------------------------------------
-- decode
-- ----------------------------------------------------------------------
local function decode_error(pos, msg)
    error({ json_decode_error = string.format("%s at byte %d", msg, pos) }, 0)
end

local function skip_ws(s, i)
    local _, e = s:find("^[ \t\r\n]*", i)
    return e + 1
end

local decode_value

local function decode_string(s, i)
    -- s:sub(i, i) == '"'
    local out = {}
    local j = i + 1
    while true do
        local c = s:byte(j)
        if not c then decode_error(j, "unterminated string") end
        if c == 0x22 then
            return table.concat(out), j + 1
        elseif c == 0x5C then
            local e = s:sub(j + 1, j + 1)
            if e == '"' then out[#out + 1] = '"'
            elseif e == "\\" then out[#out + 1] = "\\"
            elseif e == "/" then out[#out + 1] = "/"
            elseif e == "b" then out[#out + 1] = "\b"
            elseif e == "f" then out[#out + 1] = "\f"
            elseif e == "n" then out[#out + 1] = "\n"
            elseif e == "r" then out[#out + 1] = "\r"
            elseif e == "t" then out[#out + 1] = "\t"
            elseif e == "u" then
                local hex = s:sub(j + 2, j + 5)
                if not hex:match("^%x%x%x%x$") then decode_error(j, "bad \\u escape") end
                local cp = tonumber(hex, 16)
                local consumed = 6
                if cp >= 0xD800 and cp <= 0xDBFF then
                    local lo = s:sub(j + 6, j + 11)
                    local lohex = lo:match("^\\u(%x%x%x%x)$")
                    local locp = lohex and tonumber(lohex, 16)
                    if locp and locp >= 0xDC00 and locp <= 0xDFFF then
                        cp = 0x10000 + (cp - 0xD800) * 0x400 + (locp - 0xDC00)
                        consumed = 12
                    else
                        cp = 0xFFFD
                    end
                elseif cp >= 0xDC00 and cp <= 0xDFFF then
                    cp = 0xFFFD
                end
                out[#out + 1] = codepoint_to_utf8(cp)
                j = j + consumed - 2   -- the "+ 2" below completes the advance
            else
                decode_error(j, "bad escape")
            end
            j = j + 2
        elseif c < 0x20 then
            decode_error(j, "control character in string")
        else
            -- copy a run of ordinary bytes in one go
            local _, e = s:find('^[^"\\%c]+', j)
            if e then
                out[#out + 1] = s:sub(j, e)
                j = e + 1
            else
                out[#out + 1] = s:sub(j, j)
                j = j + 1
            end
        end
    end
end

local function decode_number(s, i)
    local num = s:match("^-?%d+%.?%d*[eE]?[-+]?%d*", i)
    if not num or num == "" or num == "-" then decode_error(i, "bad number") end
    -- strict grammar: int part "0" or [1-9]digits; optional frac with >=1
    -- digit; optional exponent with >=1 digit.
    local ok = num:match("^-?0$") or num:match("^-?[1-9]%d*$")
        or num:match("^-?0%.%d+$") or num:match("^-?[1-9]%d*%.%d+$")
        or num:match("^-?0[eE][-+]?%d+$") or num:match("^-?[1-9]%d*[eE][-+]?%d+$")
        or num:match("^-?0%.%d+[eE][-+]?%d+$") or num:match("^-?[1-9]%d*%.%d+[eE][-+]?%d+$")
    if not ok then decode_error(i, "bad number") end
    local v = tonumber(num)
    if v == nil then decode_error(i, "bad number") end
    return v, i + #num
end

local function decode_array(s, i, depth)
    if depth > MAX_DEPTH then decode_error(i, "nesting too deep") end
    local arr = {}
    local n = 0
    local j = skip_ws(s, i + 1)
    if s:sub(j, j) == "]" then return arr, j + 1 end
    while true do
        local v
        v, j = decode_value(s, j, depth + 1)
        n = n + 1
        arr[n] = v
        j = skip_ws(s, j)
        local c = s:sub(j, j)
        if c == "]" then return arr, j + 1 end
        if c ~= "," then decode_error(j, "expected ',' or ']'") end
        j = skip_ws(s, j + 1)
    end
end

local function decode_object(s, i, depth)
    if depth > MAX_DEPTH then decode_error(i, "nesting too deep") end
    local obj = {}
    local j = skip_ws(s, i + 1)
    if s:sub(j, j) == "}" then return obj, j + 1 end
    while true do
        if s:sub(j, j) ~= '"' then decode_error(j, "expected string key") end
        local k
        k, j = decode_string(s, j)
        j = skip_ws(s, j)
        if s:sub(j, j) ~= ":" then decode_error(j, "expected ':'") end
        j = skip_ws(s, j + 1)
        local v
        v, j = decode_value(s, j, depth + 1)
        obj[k] = v
        j = skip_ws(s, j)
        local c = s:sub(j, j)
        if c == "}" then return obj, j + 1 end
        if c ~= "," then decode_error(j, "expected ',' or '}'") end
        j = skip_ws(s, j + 1)
    end
end

decode_value = function(s, i, depth)
    local c = s:sub(i, i)
    if c == "{" then return decode_object(s, i, depth) end
    if c == "[" then return decode_array(s, i, depth) end
    if c == '"' then return decode_string(s, i) end
    if c == "-" or c:match("%d") then return decode_number(s, i) end
    if s:sub(i, i + 3) == "true" then return true, i + 4 end
    if s:sub(i, i + 4) == "false" then return false, i + 5 end
    if s:sub(i, i + 3) == "null" then return nil, i + 4 end
    decode_error(i, "unexpected character")
end

function M.decode(s)
    if type(s) ~= "string" then return nil, "decode expects a string" end
    local ok, res, pos = pcall(function()
        local j = skip_ws(s, 1)
        local v, k = decode_value(s, j, 0)
        k = skip_ws(s, k)
        if k <= #s then decode_error(k, "trailing garbage") end
        return v, k
    end)
    if ok then return res end
    if type(res) == "table" and res.json_decode_error then
        return nil, res.json_decode_error
    end
    return nil, tostring(res)
end

return M
