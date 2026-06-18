-- Mock of the FreeSWITCH `freeswitch` global for headless Lua testing.
--
-- mod_lua injects a `freeswitch` global into every script. Our routing
-- scripts (inbound_router.lua, trunk_outbound.lua, ...) call a small,
-- well-defined subset of it. This mock reproduces that subset so the real
-- production scripts can be loaded and executed outside FreeSWITCH.
--
-- Captured surface:
--   consoleLog(level, msg)          -- appended to recorder.logs
--   getGlobalVariable(key)          -- process-wide globals (SBC health cache)
--   setGlobalVariable(key, value)   -- "
--   API():execute(cmd, args)        -- stubbed, returns ""
--
-- Usage:
--   local fwmock = require("mocks.freeswitch_mock")
--   local fw, rec = fwmock.new()
--   -- rec.logs       : list of {level=, msg=}
--   -- rec.globals    : table of global variables
local M = {}

function M.new(opts)
    opts = opts or {}
    local rec = {
        logs = {},
        globals = opts.globals or {},
        api_calls = {},
    }

    local api = {}
    function api.execute(_, cmd, args)
        rec.api_calls[#rec.api_calls + 1] = { cmd = cmd, args = args }
        return ""
    end
    function api.executeString(_, s)
        rec.api_calls[#rec.api_calls + 1] = { cmd = "executeString", args = s }
        return ""
    end

    local fw = {}

    function fw.consoleLog(level, msg)
        rec.logs[#rec.logs + 1] = { level = level, msg = msg }
    end

    function fw.getGlobalVariable(key)
        return rec.globals[key]
    end

    function fw.setGlobalVariable(key, value)
        rec.globals[key] = value
    end

    -- freeswitch.API() returns an API object with :execute / :executeString.
    function fw.API()
        return api
    end

    -- Helpers occasionally referenced; harmless stubs.
    function fw.Event() return {} end
    function fw.msleep(_) end

    return fw, rec
end

return M
