-- lib/json.lua — minimal, dependency-free JSON DECODER for mod_lua (unified)
--
-- WHY THIS EXISTS: the image ships luasocket / redis-lua / luasql-postgres but
-- NO JSON library (mod_json_cdr is a FreeSWITCH C module, not a Lua binding).
-- The UCaaS find-me/follow-me runtime needs to read the `extensions.ring_plan`
-- JSONB column, which luasql hands back as TEXT. This module turns that text
-- into a Lua table.
--
-- SCOPE: decode only (no encode — nothing in the call path serializes JSON).
-- Adapted from the well-known rxi/json.lua (MIT) decoder, trimmed to the decode
-- half and hardened to NEVER raise into the caller: M.decode returns
-- `value, nil` on success and `nil, errmsg` on any malformed input, so a bad
-- ring_plan degrades cleanly to the legacy single-bridge path instead of
-- aborting the call.
--
-- Supports: objects, arrays, strings (with \uXXXX + surrogate pairs and the
-- standard escapes), numbers (int/float/exp), true/false/null, nested to any
-- depth. JSON `null` decodes to Lua `nil` (so absent and null are
-- indistinguishable — fine for our read-only consumption).
--
-- Loaded via the load_module()/loadfile() pattern (CLAUDE.md gotcha #10).

local M = {}

-- ---- decoder ---------------------------------------------------------------

local function create_set(...)
    local res = {}
    for i = 1, select("#", ...) do res[select(i, ...)] = true end
    return res
end

local space_chars  = create_set(" ", "\t", "\r", "\n")
local delim_chars  = create_set(" ", "\t", "\r", "\n", "]", "}", ",")
local escape_chars = create_set("\\", "/", '"', "b", "f", "n", "r", "t", "u")
local literals     = create_set("true", "false", "null")

local literal_map = {
    ["true"]  = true,
    ["false"] = false,
    ["null"]  = nil,   -- decodes to nil (absent)
}

local escape_char_map_inv = {
    ["\\"] = "\\", ["/"] = "/", ['"'] = '"',
    ["b"] = "\b", ["f"] = "\f", ["n"] = "\n", ["r"] = "\r", ["t"] = "\t",
}

local parse  -- forward declaration

local function next_char(str, idx, set, negate)
    for i = idx, #str do
        if set[str:sub(i, i)] ~= negate then
            return i
        end
    end
    return #str + 1
end

local function decode_error(str, idx, msg)
    local line_count = 1
    local col_count = 1
    for i = 1, idx - 1 do
        col_count = col_count + 1
        if str:sub(i, i) == "\n" then
            line_count = line_count + 1
            col_count = 1
        end
    end
    error(string.format("%s at line %d col %d", msg, line_count, col_count))
end

local function codepoint_to_utf8(n)
    -- http://scripts.sil.org/cms/scripts/page.php?site_id=nrsi&id=iws-appendixa
    if n <= 0x7f then
        return string.char(n)
    elseif n <= 0x7ff then
        return string.char(0xc0 | (n >> 6), 0x80 | (n & 0x3f))
    elseif n <= 0xffff then
        return string.char(0xe0 | (n >> 12), 0x80 | ((n >> 6) & 0x3f), 0x80 | (n & 0x3f))
    elseif n <= 0x10ffff then
        return string.char(
            0xf0 | (n >> 18),
            0x80 | ((n >> 12) & 0x3f),
            0x80 | ((n >> 6) & 0x3f),
            0x80 | (n & 0x3f))
    end
    error(string.format("invalid unicode codepoint '%x'", n))
end

local function parse_unicode_escape(s)
    local n1 = tonumber(s:sub(1, 4), 16)
    local n2 = tonumber(s:sub(7, 10), 16)
    -- Surrogate pair?
    if n2 then
        return codepoint_to_utf8((n1 - 0xd800) * 0x400 + (n2 - 0xdc00) + 0x10000)
    else
        return codepoint_to_utf8(n1)
    end
end

local function parse_string(str, i)
    local res = ""
    local j = i + 1
    local k = j
    while j <= #str do
        local x = str:byte(j)
        if x < 32 then
            decode_error(str, j, "control character in string")
        elseif x == 92 then            -- `\`: escape
            res = res .. str:sub(k, j - 1)
            j = j + 1
            local c = str:sub(j, j)
            if c == "u" then
                local hex = str:match("^[dD][89aAbB]%x%x\\u%x%x%x%x", j + 1)
                    or str:match("^%x%x%x%x", j + 1)
                    or decode_error(str, j - 1, "invalid unicode escape in string")
                res = res .. parse_unicode_escape(hex)
                j = j + #hex
            else
                if not escape_chars[c] then
                    decode_error(str, j - 1, "invalid escape char '" .. c .. "' in string")
                end
                res = res .. escape_char_map_inv[c]
            end
            k = j + 1
        elseif x == 34 then            -- `"`: end of string
            res = res .. str:sub(k, j - 1)
            return res, j + 1
        end
        j = j + 1
    end
    decode_error(str, i, "expected closing quote for string")
end

local function parse_number(str, i)
    local x = next_char(str, i, delim_chars)
    local s = str:sub(i, x - 1)
    local n = tonumber(s)
    if not n then
        decode_error(str, i, "invalid number '" .. s .. "'")
    end
    return n, x
end

local function parse_literal(str, i)
    local x = next_char(str, i, delim_chars)
    local word = str:sub(i, x - 1)
    if not literals[word] then
        decode_error(str, i, "invalid literal '" .. word .. "'")
    end
    return literal_map[word], x
end

local function parse_array(str, i)
    local res = {}
    local n = 1
    i = i + 1
    while 1 do
        local x
        i = next_char(str, i, space_chars, true)
        -- Empty / end of array?
        if str:sub(i, i) == "]" then
            i = i + 1
            break
        end
        -- Read token
        x, i = parse(str, i)
        res[n] = x
        n = n + 1
        -- Next token
        i = next_char(str, i, space_chars, true)
        local chr = str:sub(i, i)
        i = i + 1
        if chr == "]" then break end
        if chr ~= "," then decode_error(str, i, "expected ']' or ','") end
    end
    return res, i
end

local function parse_object(str, i)
    local res = {}
    i = i + 1
    while 1 do
        local key, val
        i = next_char(str, i, space_chars, true)
        -- Empty / end of object?
        if str:sub(i, i) == "}" then
            i = i + 1
            break
        end
        -- Read key
        if str:sub(i, i) ~= '"' then
            decode_error(str, i, "expected string for key")
        end
        key, i = parse(str, i)
        -- Read ':' delimiter
        i = next_char(str, i, space_chars, true)
        if str:sub(i, i) ~= ":" then
            decode_error(str, i, "expected ':' after key")
        end
        i = next_char(str, i + 1, space_chars, true)
        -- Read value
        val, i = parse(str, i)
        -- Set
        res[key] = val
        -- Next token
        i = next_char(str, i, space_chars, true)
        local chr = str:sub(i, i)
        i = i + 1
        if chr == "}" then break end
        if chr ~= "," then decode_error(str, i, "expected '}' or ','") end
    end
    return res, i
end

local char_func_map = {
    ['"'] = parse_string,
    ["0"] = parse_number, ["1"] = parse_number, ["2"] = parse_number,
    ["3"] = parse_number, ["4"] = parse_number, ["5"] = parse_number,
    ["6"] = parse_number, ["7"] = parse_number, ["8"] = parse_number,
    ["9"] = parse_number, ["-"] = parse_number,
    ["t"] = parse_literal, ["f"] = parse_literal, ["n"] = parse_literal,
    ["["] = parse_array,
    ["{"] = parse_object,
}

parse = function(str, idx)
    local chr = str:sub(idx, idx)
    local f = char_func_map[chr]
    if f then
        return f(str, idx)
    end
    decode_error(str, idx, "unexpected character '" .. chr .. "'")
end

-- decode(str) -> value, nil   on success
--             -> nil, errmsg   on any malformed / non-string input
function M.decode(str)
    if type(str) ~= "string" then
        return nil, "expected string, got " .. type(str)
    end
    local ok, res, idx = pcall(function()
        local v, i = parse(str, next_char(str, 1, space_chars, true))
        i = next_char(str, i, space_chars, true)
        if i <= #str then
            decode_error(str, i, "trailing garbage after JSON value")
        end
        return v
    end)
    -- pcall returns (true, value) on success or (false, errmsg) on error.
    if not ok then
        return nil, tostring(res)
    end
    return res, nil
end

return M
