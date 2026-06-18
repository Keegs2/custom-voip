-- Mock of a FreeSWITCH `session` object for headless Lua testing.
--
-- The routing scripts interact with the call session almost exclusively
-- through these methods (all invoked with `:` so `self` is the first arg):
--   session:getVariable(name)            -> string|nil   (configurable)
--   session:setVariable(name, value)     -> records the write
--   session:execute(app, data)           -> records (app == "bridge" / "export" / ...)
--   session:hangup(cause)                -> records the hangup
--   session:answer()                     -> records
--   session:sleep(ms) / session:ready()  -> stubbed
--   session:getDigits(...) / answered()  -> stubbed
--
-- Recorder fields:
--   rec.set_list  : ordered list of {name=, value=} writes (setVariable)
--   rec.set_map   : name -> last value written
--   rec.executes  : ordered list of {app=, data=}
--   rec.bridges   : ordered list of bridge dial strings (app == "bridge")
--   rec.exports   : ordered list of export args (app == "export")
--   rec.hangups   : ordered list of hangup causes
--   rec.answered  : count of session:answer() calls
local M = {}

function M.new(opts)
    opts = opts or {}
    local vars = opts.vars or {}        -- getVariable backing store
    local ready_val = opts.ready
    if ready_val == nil then ready_val = true end

    local rec = {
        set_list = {},
        set_map = {},
        executes = {},
        bridges = {},
        exports = {},
        hangups = {},
        answered = 0,
        slept = {},
    }

    local s = {}

    function s.getVariable(_, name)
        -- A setVariable write should be observable by a later getVariable,
        -- mirroring real session semantics, but configured vars win first
        -- (they model values FreeSWITCH set before Lua ran).
        if vars[name] ~= nil then return vars[name] end
        return rec.set_map[name]
    end

    function s.setVariable(_, name, value)
        rec.set_list[#rec.set_list + 1] = { name = name, value = value }
        rec.set_map[name] = value
    end

    function s.execute(_, app, data)
        rec.executes[#rec.executes + 1] = { app = app, data = data }
        if app == "bridge" then
            rec.bridges[#rec.bridges + 1] = data
        elseif app == "export" then
            rec.exports[#rec.exports + 1] = data
        end
        return ""
    end

    function s.hangup(_, cause)
        rec.hangups[#rec.hangups + 1] = cause
    end

    function s.answer(_)
        rec.answered = rec.answered + 1
    end

    function s.sleep(_, ms)
        rec.slept[#rec.slept + 1] = ms
    end

    function s.ready(_)
        return ready_val
    end

    -- Stubs for the broader session API the prompt asks the mock to expose.
    function s.getDigits(_, ...) return "" end
    function s.answered(_) return true end
    function s.hangupCause(_) return "" end
    function s.recordFile(_) end
    function s.streamFile(_) end
    function s.set_tts_params(_) end
    function s.destroy(_) end

    return s, rec
end

return M
