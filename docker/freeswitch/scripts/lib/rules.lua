-- lib/rules.lua — shared first-match-wins routing-rule evaluator (unified)
--
-- A small, SHARED, side-effect-free primitive: given an ORDERED list of routing
-- rules and an evaluation context, return the FIRST rule whose `match` condition
-- applies right now (document order, first match wins), or nil if none do.
--
-- This is the rule-selection engine that was first built inline in
-- handlers/rcf.lua for RICH RCF (routing_plan). It is factored out here so the
-- SIP-trunk inbound handler (handlers/trunk.lua, RICH route_plan) reuses the
-- EXACT same schedule + caller-id `match` semantics — one matcher, two products.
-- The per-product *delivery* of a matched rule (carrier failover vs PBX
-- X-PBX-Dest endpoints) stays in each handler; only the SELECTION lives here.
--
-- Rule `match` shape (every field optional; snake_case — the Call Flow Builder's
-- compiled artifact):
--   match = nil | <scalar>                      -- catch-all (always applies)
--   match = { schedule  = { days, start, end, tz },   -- time-of-day window
--             caller_id = { prefix?, equals? } }       -- caller-number condition
-- A `match` that is nil or not a table is a CATCH-ALL (the rule always applies) —
-- this is how a plan expresses its "default" rule (typically last).
--
-- Evaluation context (`ctx`, all optional):
--   ctx.caller   : the caller number to test caller_id conditions against. The
--                  CALLER decides the normalization (RCF/trunk both pass the
--                  E.164 form) — this module compares verbatim.
--   ctx.now      : UNIX epoch for schedule evaluation (test seam). schedule.lib
--                  defaults to os.time() when nil.
--   ctx.schedule : the lib/schedule.lua module (the time-of-day matcher). If a
--                  rule carries a `schedule` condition but this is absent, the
--                  rule conservatively does NOT match — so a missing primitive
--                  can never silently route after-hours traffic to a
--                  business-hours rule. caller_id-only and catch-all rules do
--                  NOT need it.
--
-- Loaded via the load_module()/loadfile() pattern (CLAUDE.md gotcha #10). No
-- FreeSWITCH dependency at module scope (logging is guarded) so it loads and is
-- unit-testable under a plain `lua` interpreter.

local M = {}

-- caller_id condition: `prefix` (caller STARTS WITH) and/or `equals` (exact).
-- Both compare against ctx.caller verbatim. An empty/absent condition field is
-- ignored; a non-table condition matches everything. Byte-for-byte the predicate
-- that lived in handlers/rcf.lua.
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

-- Does this rule's `match` apply for ctx? nil/non-table match = catch-all
-- (always). A schedule condition requires ctx.schedule; if it is somehow absent
-- the rule conservatively does NOT match. Byte-for-byte the predicate that lived
-- in handlers/rcf.lua (the only change: it now reads `now`/`schedule`/`caller`
-- from a ctx table instead of positional args).
local function rule_matches(rule, ctx)
    if type(rule) ~= "table" then return false end
    local m = rule.match
    if type(m) ~= "table" then return true end          -- nil/scalar = catch-all
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

-- first_match(rules, ctx) -> matched_rule, index   (or nil, nil when none apply).
-- Iterates rules in DOCUMENT ORDER and returns the first whose `match` applies.
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
