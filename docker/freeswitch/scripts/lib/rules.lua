-- lib/rules.lua — caller-number conditions + first-match-wins rule selection.
--
-- Ported from branch `unified` (lib/rules.lua, 2026-06-19) for the Visual IVR
-- "Caller check" block (docs/IVR_INTERFACES.md §2/§3 `caller` node, plan
-- §7.3). Pure, side-effect-free, no FreeSWITCH dependency at module scope, so
-- it loads under a plain `lua` interpreter for the harnesses. Loaded with the
-- house loadfile() pattern. Lua 5.3-compatible.
--
-- IVR entry point:
--   M.caller_matches(mode, values, caller, number_utils) -> boolean
--     mode   "prefix"    caller (canonical +E.164) STARTS WITH any value
--            "equals"    caller (canonical +E.164) EQUALS any value
--            "anonymous" the caller presented no usable telephone number
--     values validated "+<digits>" strings (lib/ivr_engine.lua checks them);
--            empty for "anonymous"
--     caller the presented caller number (inbound_router ctx.presented_cid)
--   An anonymous caller never matches "prefix"/"equals" (there is no number
--   to compare), so a "starts with +1617" check sends withheld numbers down
--   the No-match exit.
--
-- Unified entry points (kept for spec parity; not used by the IVR):
--   M.caller_id_matches(cond, caller), M.rule_matches(rule, ctx),
--   M.first_match(rules, ctx).

local M = {}

-- ------------------------------------------------------------------
-- Anonymous / withheld caller detection
-- ------------------------------------------------------------------
-- SIP carriers present a withheld number as a keyword user part
-- ("anonymous", "Restricted", "unavailable", ...) or an empty one. Anything
-- with fewer than 7 digits is not a dialable telephone number either.
local ANON_WORDS = {
    anonymous = true, restricted = true, private = true, unavailable = true,
    unknown = true, withheld = true, blocked = true, ["no caller id"] = true,
}

function M.is_anonymous(caller)
    if caller == nil then return true end
    local s = tostring(caller):match("^%s*(.-)%s*$") or ""
    if s == "" then return true end
    local user = s:lower():match("^([^@]*)") or ""
    if ANON_WORDS[user] then return true end
    local digits = s:gsub("[^%d]", "")
    return #digits < 7
end

-- Canonical +E.164 form of the caller for prefix/equals comparisons.
-- number_utils (lib/number_utils.lua) is optional: without it, a value that
-- already looks like +<digits> is used verbatim and a bare 10/11-digit NANP
-- number is lifted to +1.
local function canonical(caller, number_utils)
    local s = tostring(caller or "")
    if number_utils and number_utils.to_e164 then
        local ok, c = pcall(number_utils.to_e164, s)
        if ok and c then return c end
    end
    local plus = s:match("^%s*(%+%d+)%s*$")
    if plus then return plus end
    local d = s:gsub("[^%d]", "")
    if #d == 10 then return "+1" .. d end
    if #d == 11 and d:sub(1, 1) == "1" then return "+" .. d end
    return nil
end
M.canonical = canonical

function M.caller_matches(mode, values, caller, number_utils)
    if mode == "anonymous" then
        return M.is_anonymous(caller)
    end
    if mode ~= "prefix" and mode ~= "equals" then
        return false
    end
    if M.is_anonymous(caller) then
        return false
    end
    local c = canonical(caller, number_utils)
    if not c then return false end
    for _, v in ipairs(values or {}) do
        if type(v) == "string" and v ~= "" then
            if mode == "equals" then
                if c == v then return true end
            elseif c:sub(1, #v) == v then
                return true
            end
        end
    end
    return false
end

-- ------------------------------------------------------------------
-- Unified rule selection (verbatim semantics)
-- ------------------------------------------------------------------
local function caller_id_matches(cond, caller)
    if type(cond) ~= "table" then return true end
    caller = caller or ""
    local eq = cond.equals
    if type(eq) == "string" and eq ~= "" and caller ~= eq then
        return false
    end
    local pfx = cond.prefix
    if type(pfx) == "string" and pfx ~= "" and caller:sub(1, #pfx) ~= pfx then
        return false
    end
    return true
end
M.caller_id_matches = caller_id_matches

local function rule_matches(rule, ctx)
    if type(rule) ~= "table" then return false end
    local m = rule.match
    if type(m) ~= "table" then return true end
    if m.schedule ~= nil then
        local sched = ctx and ctx.schedule
        if not (sched and sched.matches) then
            if freeswitch and freeswitch.consoleLog then
                freeswitch.consoleLog("WARNING",
                    "[rules] schedule lib unavailable — schedule rule skipped\n")
            end
            return false
        end
        if not sched.matches(m.schedule, ctx.now) then return false end
    end
    if m.caller_id ~= nil and not caller_id_matches(m.caller_id, ctx and ctx.caller) then
        return false
    end
    return true
end
M.rule_matches = rule_matches

function M.first_match(rules, ctx)
    if type(rules) ~= "table" then return nil end
    for i, rule in ipairs(rules) do
        if rule_matches(rule, ctx) then
            return rule, i
        end
    end
    return nil
end

return M
