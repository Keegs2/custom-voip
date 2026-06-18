-- Minimal busted-compatible shim.
--
-- The spec files in tests/lua/spec/ are written in standard `busted` syntax
-- (describe / it / before_each / assert.are.equal / ...). When real busted is
-- installed (`luarocks install busted`) the specs run under it directly and
-- this shim is ignored. When busted is NOT available, tests/lua/run.lua loads
-- this shim first so the very same specs run under a plain `lua` interpreter.
--
-- It implements only the assertion surface the specs use; if you add a spec
-- that needs more of luassert, either extend this shim or install busted.
local Shim = { passed = 0, failed = 0, failures = {} }

local current_describe = nil
local before_stack = {}

-- ---- structure ----
function describe(name, fn)
    local prev = current_describe
    local prev_before = before_stack
    current_describe = name
    before_stack = {}
    fn()
    current_describe = prev
    before_stack = prev_before
end

function before_each(fn)
    before_stack[#before_stack + 1] = fn
end

function after_each(_) end  -- not needed by our specs

function it(name, fn)
    local label = (current_describe and (current_describe .. " :: ") or "") .. name
    for _, b in ipairs(before_stack) do b() end
    local ok, err = pcall(fn)
    if ok then
        Shim.passed = Shim.passed + 1
        io.write(".")
    else
        Shim.failed = Shim.failed + 1
        Shim.failures[#Shim.failures + 1] = { label = label, err = err }
        io.write("F")
    end
end

-- pending / spec aliases
function pending(name) io.write("P") end

-- ---- assertions (luassert subset) ----
local function fail(msg)
    error(msg, 2)
end

local function eq(a, b)
    if a ~= b then
        fail(string.format("expected (==): %s\n        got: %s",
            tostring(b), tostring(a)))
    end
end

local function deep_same(a, b, path)
    path = path or "<root>"
    if type(a) ~= type(b) then
        fail(string.format("same: type mismatch at %s (%s vs %s)", path, type(a), type(b)))
    end
    if type(a) ~= "table" then
        if a ~= b then fail(string.format("same: %s ~= %s at %s", tostring(a), tostring(b), path)) end
        return
    end
    for k, v in pairs(a) do deep_same(v, b[k], path .. "." .. tostring(k)) end
    for k, v in pairs(b) do deep_same(a[k], v, path .. "." .. tostring(k)) end
end

local are = {
    equal = function(expected, actual) eq(actual, expected) end,
    equals = function(expected, actual) eq(actual, expected) end,
    same = function(expected, actual) deep_same(actual, expected) end,
}
local is = {
    equal = are.equal,
    truthy = function(v) if not v then fail("expected truthy, got " .. tostring(v)) end end,
    falsy = function(v) if v then fail("expected falsy, got " .. tostring(v)) end end,
    ["true"] = function(v) if v ~= true then fail("expected true, got " .. tostring(v)) end end,
    ["false"] = function(v) if v ~= false then fail("expected false, got " .. tostring(v)) end end,
    is_nil = function(v) if v ~= nil then fail("expected nil, got " .. tostring(v)) end end,
    is_not_nil = function(v) if v == nil then fail("expected non-nil") end end,
}

local assert_tbl = {
    are = are,
    is = is,
    is_true = is["true"],
    is_false = is["false"],
    is_nil = is.is_nil,
    is_not_nil = is.is_not_nil,
    truthy = is.truthy,
    falsy = is.falsy,
    equal = are.equal,
    same = are.same,
    -- assert.matches(pattern, s) — Lua-pattern match (busted semantics)
    matches = function(pattern, s)
        if type(s) ~= "string" or not s:match(pattern) then
            fail(string.format("expected %q to match pattern %q", tostring(s), tostring(pattern)))
        end
    end,
}

-- `assert` is callable in busted (luassert): assert(value, msg)
assert = setmetatable(assert_tbl, {
    __call = function(_, v, msg)
        if not v then fail(msg or "assertion failed") end
        return v
    end,
})

function Shim.report()
    io.write("\n\n")
    if #Shim.failures > 0 then
        for _, f in ipairs(Shim.failures) do
            io.write("FAIL: " .. f.label .. "\n      " .. tostring(f.err) .. "\n")
        end
    end
    io.write(string.format("\n%d passed, %d failed\n", Shim.passed, Shim.failed))
    return Shim.failed
end

return Shim
