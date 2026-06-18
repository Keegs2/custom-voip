-- lua_parser_harness.lua
--
-- Phase 0 safety-net harness: runs the REAL XML parser out of the production
-- engine (docker/freeswitch/scripts/voice_webhook.lua) against a TwiML input
-- and prints the resulting verb tree as JSON on stdout.
--
-- ADDITIVE ONLY: this harness does NOT modify voice_webhook.lua. It reads the
-- file at run time, extracts the `parse_attributes` + `parse_xml` functions
-- (the slice between `local function parse_attributes` and the line
-- `local api = freeswitch.API()`), and loads that slice in a sandboxed
-- environment with the two engine-local upvalues the parser needs stubbed
-- (`log_warning`, `uuid`). Because the slice is re-read every run, when Phase 3
-- changes the parser the characterization tests automatically pick up the new
-- behavior.
--
-- Usage:
--   lua lua_parser_harness.lua /abs/path/to/voice_webhook.lua  < input.xml
--   (XML is read from stdin to avoid shell-escaping the markup.)
--
-- Output (stdout), exactly one of:
--   {"ok":true,"verbs":[ ... ]}
--   {"ok":false,"error":"<parser error string>"}

local engine_path = arg[1]
if not engine_path then
    io.stderr:write("usage: lua lua_parser_harness.lua <voice_webhook.lua> < input.xml\n")
    os.exit(2)
end

-- ---------------------------------------------------------------------------
-- Read the production engine source and slice out the parser section.
-- ---------------------------------------------------------------------------
local f = assert(io.open(engine_path, "r"))
local src = f:read("*a")
f:close()

local START_MARKER = "-- BEGIN PARSER SECTION"
local END_MARKER = "-- END PARSER SECTION"

local s = src:find(START_MARKER, 1, true)
local e = src:find(END_MARKER, 1, true)
if not s or not e or e <= s then
    io.write('{"ok":false,"error":"could not locate parser section markers in engine source"}')
    os.exit(0)
end

local section = src:sub(s, e - 1)
local chunk_src = section .. "\nreturn parse_xml\n"

-- The production parser loads lib/xml.lua via loadfile() at an absolute container
-- path; here we load the SAME file from the repo (alongside the engine) and inject
-- it as the upvalue `xml_lib` the sliced section closes over. So the real parser
-- AND the real vendored XML library both run for real in this harness.
local lib_path = engine_path:gsub("handlers[/\\]api_voice%.lua$", "lib/xml.lua")
local xml_chunk, xerr = loadfile(lib_path)
if not xml_chunk then
    io.write('{"ok":false,"error":"could not load lib/xml.lua: ' .. tostring(xerr):gsub('"', "'") .. '"}')
    os.exit(0)
end
local xml_lib = xml_chunk()

-- Sandbox env: provide stdlib via __index, plus the engine-local symbols the
-- parser closes over (xml_lib + inert log/uuid stubs).
local env = setmetatable({
    xml_lib = xml_lib,
    log_warning = function() end,
    log_debug = function() end,
    log_err = function() end,
    log_info = function() end,
    uuid = "harness",
}, { __index = _G })

local loader, lerr = load(chunk_src, "=parser_section", "t", env)
if not loader then
    io.write('{"ok":false,"error":"load failed: ' .. tostring(lerr):gsub('"', "'") .. '"}')
    os.exit(0)
end

local ok_run, parse_xml = pcall(loader)
if not ok_run or type(parse_xml) ~= "function" then
    io.write('{"ok":false,"error":"could not obtain parse_xml from section"}')
    os.exit(0)
end

-- ---------------------------------------------------------------------------
-- Minimal JSON encoder (stable key ordering for deterministic snapshots).
-- ---------------------------------------------------------------------------
local function json_escape(str)
    str = tostring(str)
    str = str:gsub('[%z\1-\31\\"]', function(c)
        local map = {
            ['"'] = '\\"', ['\\'] = '\\\\', ['\n'] = '\\n',
            ['\r'] = '\\r', ['\t'] = '\\t', ['\b'] = '\\b', ['\f'] = '\\f',
        }
        return map[c] or string.format("\\u%04x", string.byte(c))
    end)
    return str
end

local function sorted_keys(t)
    local keys = {}
    for k in pairs(t) do keys[#keys + 1] = k end
    table.sort(keys)
    return keys
end

local function encode_attrs(attrs)
    local parts = {}
    for _, k in ipairs(sorted_keys(attrs or {})) do
        parts[#parts + 1] = '"' .. json_escape(k) .. '":"' .. json_escape(attrs[k]) .. '"'
    end
    return "{" .. table.concat(parts, ",") .. "}"
end

local function encode_child(child)
    return string.format(
        '{"verb":"%s","attrs":%s,"text":"%s"}',
        json_escape(child.verb or ""),
        encode_attrs(child.attrs),
        json_escape(child.text or "")
    )
end

local function encode_verb(verb)
    local child_parts = {}
    for _, c in ipairs(verb.children or {}) do
        child_parts[#child_parts + 1] = encode_child(c)
    end
    return string.format(
        '{"verb":"%s","attrs":%s,"text":"%s","children":[%s]}',
        json_escape(verb.verb or ""),
        encode_attrs(verb.attrs),
        json_escape(verb.text or ""),
        table.concat(child_parts, ",")
    )
end

-- ---------------------------------------------------------------------------
-- Run the real parser over stdin and emit the verb tree.
-- ---------------------------------------------------------------------------
local input_xml = io.read("*a") or ""

local verbs, perr = parse_xml(input_xml)
if not verbs then
    io.write('{"ok":false,"error":"' .. json_escape(perr or "nil") .. '"}')
    os.exit(0)
end

local verb_parts = {}
for _, v in ipairs(verbs) do
    verb_parts[#verb_parts + 1] = encode_verb(v)
end
io.write('{"ok":true,"verbs":[' .. table.concat(verb_parts, ",") .. "]}")
os.exit(0)
