-- Test harness: load and execute the REAL production Lua routing scripts
-- (docker/freeswitch/scripts/*.lua) inside a controlled sandbox, with the
-- `freeswitch` global, the `session` object, env vars, and the lib/ modules
-- all mocked. This characterizes the actual shipped code, not a copy.
--
-- Two entry points:
--   run_script(path, opts)  -- run the whole script top-to-bottom, return the
--                              session recorder + freeswitch recorder.
--   extract(path, marker, names, opts)
--                           -- load the script source TRUNCATED just before
--                              `marker`, then return the named local functions.
--                              Used to characterize pure helpers (normalize_did,
--                              to_10digit, ...) in isolation, byte-for-byte from
--                              the real source, without running the routing
--                              side effects that follow them.
local M = {}

local this_dir = (debug.getinfo(1, "S").source:match("^@(.*/)") or "./")

-- Resolve the repo root from this file's location: tests/lua/helpers.lua
M.repo_root = this_dir:gsub("tests/lua/$", "")
M.scripts_dir = M.repo_root .. "docker/freeswitch/scripts/"

local function read_file(path)
    local fh = assert(io.open(path, "r"), "cannot open " .. path)
    local data = fh:read("*a")
    fh:close()
    return data
end

-- Build the sandbox _ENV for a script run.
--   opts.env      : map consumed by os.getenv (EXTERNAL_SIP_IP, SBC_PROXY_IP, ...)
--   opts.session  : the session mock object
--   opts.freeswitch : the freeswitch mock table
--   opts.modules  : map of lib-module-name -> mock module (for load_module)
local function make_env(opts)
    local env = {}

    -- Inherit the standard library (string, table, math, ipairs, pcall, ...).
    setmetatable(env, { __index = _G })

    env.freeswitch = opts.freeswitch
    env.session = opts.session

    -- os proxy: real os with a controlled getenv.
    local envmap = opts.env or {}
    local os_proxy = setmetatable({
        getenv = function(k) return envmap[k] end,
    }, { __index = os })
    env.os = os_proxy

    -- The scripts mutate package.path/cpath; give them a throwaway table so we
    -- never touch the real loader state.
    env.package = { path = "", cpath = "", loaded = {} }

    -- load_module(name) does loadfile(".../lib/<name>.lua") then pcall(fn).
    -- Intercept loadfile to hand back a chunk that returns the mock module.
    local modules = opts.modules or {}
    env.loadfile = function(path)
        local name = path:match("([^/]+)%.lua$")
        if name and modules[name] ~= nil then
            local mod = modules[name]
            return function() return mod end
        end
        -- Not mocked -> behave like a missing file (load_module logs + returns nil).
        return nil, "mocked harness: no module for " .. tostring(path)
    end

    -- require: socket is deliberately unavailable so the SBC TCP pre-check
    -- fails open deterministically (all bridge attempts are tried). Anything
    -- else delegates to the real require.
    env.require = function(name)
        if name == "socket" then
            error("luasocket unavailable (test harness)")
        end
        return require(name)
    end

    return env
end

-- Run the whole script.
function M.run_script(path, opts)
    local src = read_file(path)
    local env = make_env(opts)
    local chunk, err = load(src, "@" .. path, "t", env)
    if not chunk then error("load failed: " .. tostring(err)) end
    chunk()
    return opts
end

-- Load the script source truncated immediately before `marker` and return the
-- named local functions defined above that point.
function M.extract(path, marker, names, opts)
    local src = read_file(path)
    local cut = src:find(marker, 1, true)
    assert(cut, "marker not found in " .. path .. ": " .. marker)
    local head = src:sub(1, cut - 1)

    local ret = "\nreturn {"
    for _, n in ipairs(names) do
        ret = ret .. string.format(" %s = %s,", n, n)
    end
    ret = ret .. " }\n"

    local env = make_env(opts)
    local chunk, err = load(head .. ret, "@" .. path .. "#probe", "t", env)
    if not chunk then error("probe load failed: " .. tostring(err)) end
    return chunk()
end

-- Convenience: substring containment (plain, not pattern).
function M.contains(haystack, needle)
    return haystack ~= nil and string.find(haystack, needle, 1, true) ~= nil
end

return M
