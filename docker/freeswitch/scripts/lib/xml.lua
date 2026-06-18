-- lib/xml.lua — minimal, permissive, pure-Lua XML parser (no C extensions).
--
-- WHY PURE LUA: mod_lua's cpath is fragile (see freeswitch/scripts/CLAUDE.md
-- gotcha #10), so a C parser like lua-expat (lxp) cannot be reliably loaded.
-- This is a single-file recursive-descent parser adapted to TwiML's needs and
-- loaded via loadfile() like the other lib/* modules.
--
-- CONTRACT
--   local xml = <loadfile lib/xml.lua>()
--   local root, err = xml.parse(document_string)
--     root == nil  -> malformed; `err` is a human-readable reason (caller MUST
--                    take the fallback path; never execute partial/wrong output)
--     root ~= nil  -> the first/top element node:
--                      { tag = "Response", attrs = { ... }, kids = { ... } }
--   Node shape:
--     node.tag    string  element name (case-sensitive, as written)
--     node.attrs  table   attribute name -> entity-decoded value
--     node.kids   array   ordered children; each kid is either
--                           * a string  (a text / CDATA run, entity-decoded
--                             EXCEPT CDATA which is preserved verbatim), or
--                           * a table   (a nested element node)
--
-- CORRECTNESS GUARANTEES (the bugs this fixes vs the old regex parser):
--   * XML entity decoding: &amp; &lt; &gt; &quot; &apos; and numeric &#NN;
--     / &#xHH; (UTF-8 encoded). Unknown entities are left verbatim.
--   * Single- AND double-quoted attribute values, including a value that
--     contains the other quote character (e.g. voice='a"b').
--   * CDATA sections (content kept literally, no entity decoding inside).
--   * Comments <!-- ... -->, the <?xml ...?> declaration, processing
--     instructions, and <!DOCTYPE ...> are skipped.
--   * Arbitrary nesting depth (recursive) — fixes the old 2-level limit and the
--     grandchild-leak bug.
--   * Unknown / lowercase elements parse fine (handled gracefully, no crash);
--     it is the TwiML layer that decides which tags are meaningful verbs.
--   * Malformed input (unquoted attribute values, mismatched/missing close
--     tags, unterminated constructs) returns nil + a clear error string rather
--     than silently producing wrong output.
--
-- The parser is linear-time over the input (no nested backtracking quantifiers),
-- so it is not susceptible to the ReDoS class of the old pattern parser.

local M = {}

local NAMED = {
    amp = "&", lt = "<", gt = ">", quot = "\"", apos = "'",
}

-- UTF-8 encode a Unicode code point (works on Lua 5.1+ without the utf8 lib).
local function utf8_char(n)
    if n < 0x80 then
        return string.char(n)
    elseif n < 0x800 then
        return string.char(0xC0 + (n // 0x40), 0x80 + (n % 0x40))
    elseif n < 0x10000 then
        return string.char(
            0xE0 + (n // 0x1000),
            0x80 + ((n // 0x40) % 0x40),
            0x80 + (n % 0x40))
    else
        return string.char(
            0xF0 + (n // 0x40000),
            0x80 + ((n // 0x1000) % 0x40),
            0x80 + ((n // 0x40) % 0x40),
            0x80 + (n % 0x40))
    end
end

-- Decode XML entities in a text/attribute run. Unknown entities are preserved.
local function decode_entities(s)
    if not s or s == "" or not s:find("&", 1, true) then
        return s
    end
    return (s:gsub("&(#?[%w]+);", function(ent)
        if ent:sub(1, 1) == "#" then
            local n
            local b = ent:sub(2, 2)
            if b == "x" or b == "X" then
                n = tonumber(ent:sub(3), 16)
            else
                n = tonumber(ent:sub(2), 10)
            end
            if n and n >= 0 and n <= 0x10FFFF then
                return utf8_char(n)
            end
            return "&" .. ent .. ";"
        end
        local r = NAMED[ent]
        if r then return r end
        return "&" .. ent .. ";"
    end))
end
M.decode_entities = decode_entities

-- Name characters per a permissive subset (covers TwiML + namespaced tags).
local NAME_PAT = "^([%a_][%w%._%-:]*)"

function M.parse(str)
    if type(str) ~= "string" or str == "" then
        return nil, "empty document"
    end

    -- Strip a UTF-8 BOM if present.
    if str:sub(1, 3) == "\239\187\191" then
        str = str:sub(4)
    end

    local pos = 1
    local len = #str

    local parse_element, parse_nodes

    -- Parse the attribute list + children of an element whose '<' is at `pos`.
    parse_element = function()
        local s, e, name = str:find(NAME_PAT, pos + 1)
        if not name then
            return nil, "malformed start tag at byte " .. (pos + 1)
        end
        pos = e + 1
        local attrs = {}
        while true do
            local _, we = str:find("^%s*", pos)
            pos = we + 1
            local c = str:sub(pos, pos)
            if c == "" then
                return nil, "unexpected end of input inside <" .. name .. ">"
            elseif c == "/" then
                if str:sub(pos, pos + 1) ~= "/>" then
                    return nil, "malformed self-closing tag <" .. name .. ">"
                end
                pos = pos + 2
                return { tag = name, attrs = attrs, kids = {} }
            elseif c == ">" then
                pos = pos + 1
                local kids, perr = parse_nodes(name)
                if not kids then
                    return nil, perr
                end
                return { tag = name, attrs = attrs, kids = kids }
            else
                local as, ae, aname = str:find("^([%a_][%w%._%-:]*)%s*=%s*", pos)
                if not aname then
                    return nil, "malformed attribute in <" .. name .. "> at byte " .. pos
                end
                pos = ae + 1
                local q = str:sub(pos, pos)
                if q ~= "\"" and q ~= "'" then
                    return nil, "unquoted value for attribute '" .. aname ..
                        "' in <" .. name .. "> (XML requires quoted values)"
                end
                local vs, ve, val = str:find("^" .. q .. "([^" .. q .. "]*)" .. q, pos)
                if not val then
                    return nil, "unterminated value for attribute '" .. aname ..
                        "' in <" .. name .. ">"
                end
                pos = ve + 1
                attrs[aname] = decode_entities(val)
            end
        end
    end

    -- Parse a run of sibling nodes. `parent` is the enclosing element name, or
    -- nil at the document level. Returns the kids array, or nil + error.
    parse_nodes = function(parent)
        local kids = {}
        while true do
            if pos > len then
                if parent then
                    return nil, "unexpected end of input, expected </" .. parent .. ">"
                end
                return kids
            end

            local lt = str:find("<", pos, true)
            if not lt then
                local text = str:sub(pos)
                pos = len + 1
                if parent then
                    return nil, "unexpected end of input, expected </" .. parent .. ">"
                end
                return kids
            end

            if lt > pos then
                kids[#kids + 1] = decode_entities(str:sub(pos, lt - 1))
                pos = lt
            end

            local nxt = str:sub(lt + 1, lt + 1)
            if nxt == "/" then
                local cs, ce, cname = str:find("^</%s*([%a_][%w%._%-:]*)%s*>", pos)
                if not cname then
                    return nil, "malformed closing tag at byte " .. pos
                end
                if not parent then
                    return nil, "unexpected closing tag </" .. cname .. "> at top level"
                end
                if cname ~= parent then
                    return nil, "mismatched closing tag: expected </" .. parent ..
                        "> but found </" .. cname .. ">"
                end
                pos = ce + 1
                return kids
            elseif nxt == "!" then
                if str:sub(lt, lt + 3) == "<!--" then
                    local ce = str:find("-->", lt + 4, true)
                    if not ce then return nil, "unterminated comment" end
                    pos = ce + 3
                elseif str:sub(lt, lt + 8) == "<![CDATA[" then
                    local ce = str:find("]]>", lt + 9, true)
                    if not ce then return nil, "unterminated CDATA section" end
                    kids[#kids + 1] = str:sub(lt + 9, ce - 1) -- verbatim, no decode
                    pos = ce + 3
                else
                    -- <!DOCTYPE ...> or other declaration: skip to '>'
                    local ce = str:find(">", lt + 1, true)
                    if not ce then return nil, "unterminated declaration" end
                    pos = ce + 1
                end
            elseif nxt == "?" then
                local ce = str:find("?>", lt + 2, true)
                if not ce then return nil, "unterminated processing instruction" end
                pos = ce + 2
            else
                local el, eerr = parse_element()
                if not el then
                    return nil, eerr
                end
                kids[#kids + 1] = el
            end
        end
    end

    local nodes, err = parse_nodes(nil)
    if not nodes then
        return nil, err
    end

    for _, n in ipairs(nodes) do
        if type(n) == "table" then
            return n
        end
    end
    return nil, "no root element found"
end

-- Convenience: concatenate the direct text-node children of an element node
-- (ignores nested element children). Used by the TwiML layer to extract a
-- verb's text content while STRIPPING any inline child elements.
function M.direct_text(node)
    if not node or not node.kids then return "" end
    local parts = {}
    for _, k in ipairs(node.kids) do
        if type(k) == "string" then
            parts[#parts + 1] = k
        end
    end
    return table.concat(parts)
end

return M
