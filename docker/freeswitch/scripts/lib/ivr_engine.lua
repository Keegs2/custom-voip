-- lib/ivr_engine.lua — the Visual IVR executor (closed world).
--
-- Contract: docs/IVR_INTERFACES.md §3 (plan JSON), §5 (call path, CDR
-- variables, budgets), §6 (call-time E.164 shape check); plan §7.3.
--
-- WHAT IT RUNS. A "plan" is the immutable compiler output of a published flow
-- (call_flow_versions.plan, written ONLY by the East API's server-side
-- compiler). inbound_router.lua's terminate_ivr reads it ONCE per call from the
-- zone's local replica (ivr_fs_number), hands it to M.load_plan(), prefetches
-- its prompts (lib/ivr_prompts.lua), answers and calls M.run().
--
-- CLOSED WORLD. FreeSWITCH expands ${var} and ${api(args)} inside every
-- session:execute() argument (switch_core_session_exec ->
-- switch_channel_expand_variables), so an attacker-controlled string in an
-- application argument is code execution on the media VM. M.load_plan()
-- therefore validates EVERY value the engine will ever use against a strict
-- shape BEFORE the call is answered — node ids ^[A-Za-z0-9_-]{1,40}$, digits
-- ^[0-9*#]$, prompt shas ^[0-9a-f]{64}$ that are in the prefetch list, E.164
-- targets ^\+1[2-9]\d{2}[2-9]\d{6}$, the pinned TZ list, integer bounds — and
-- rejects the whole plan on the first violation (the caller hears the system
-- "technical difficulties" prompt; ivr_exit=error). The ONLY strings that reach
-- a session:execute() argument from here are:
--   * <cache>/<sha>.wav paths built from validated shas (lib/ivr_prompts.lua)
--   * fixed literals (app names, silence_stream://20, "none", ".", var name)
--   * integers formatted with %d
-- Transfer targets (validated E.164) leave through opts.transfer, i.e. the
-- RCF egress in inbound_router.lua. Node ids and digits never reach FS at all:
-- they appear only in the ivr_path CDR variable (session:setVariable, which
-- does not expand). tests/lua/ivr_engine_harness.lua [guard] asserts this over
-- every scenario and over hostile plans.
--
-- MENUS (contract §3, exact): each try is ONE play_and_get_digits with
-- tries=1, so barge-in works on the prompt (any key stops it) and the engine —
-- not FS — decides what a failure means:
--   try 1: play `prompts`, wait timeout_ms for one key
--   no key       -> next try plays noinput_prompts (if any) THEN prompts
--   key not in digits -> next try plays invalid_prompts (if any) THEN prompts
--   (the failure prompt is part of the next try's file_string, so a caller can
--   barge in on it too)
--   after `retries` re-prompts the menu exits on_noinput / on_nomatch by the
--   LAST failure type; that last failure's prompt is played first (plain
--   playback — no try follows), so the caller hears exactly what the API's
--   simulator transcript says (services/ivr/simulator.py: every failure adds
--   its prompts, including the last) and what FS's own multi-try
--   play_and_get_digits would do (bad-input file after every failed try).
-- Every key FS can report is collected (regexp "."; terminators "none", so '#'
-- and '*' are ordinary menu keys) and checked against `digits` in Lua.
--
-- BUDGETS (§5.6): max_steps counts node entries (a transfer counts once);
-- max_seconds is wall clock from answer, checked at every node entry.
-- Exceeding either plays goodbye.wav, hangs up, ivr_exit=limit.
--
-- EXITS (ivr_exit): transfer | voicemail | hangup | caller_hangup | timeout |
-- error | limit. `timeout` = the call ended because a menu ran out of tries on
-- NO INPUT and its on_noinput branch is null (hang up); every other null
-- branch, and a Hang up block, is `hangup`.
--
-- Pure Lua 5.3; no FreeSWITCH globals at module scope. Loaded with the house
-- loadfile() pattern.

local M = {}

M.ID_MAX = 40
M.PATH_MAX = 512
M.MAX_NODES = 500
M.MAX_PROMPTS = 500
M.MAX_PLAN_BYTES = 1024 * 1024
M.DIGIT_VAR = "ivr_digit"
M.SILENCE = "silence_stream://20"   -- the "invalid file" slot: one 20 ms frame

local PINNED_TZ = {
    ["America/New_York"] = true, ["America/Detroit"] = true,
    ["America/Chicago"] = true, ["America/Denver"] = true,
    ["America/Phoenix"] = true, ["America/Los_Angeles"] = true,
    ["America/Anchorage"] = true, ["Pacific/Honolulu"] = true,
    ["America/Puerto_Rico"] = true,
}
M.PINNED_TZ = PINNED_TZ
local DAY_KEYS = { mon = true, tue = true, wed = true, thu = true, fri = true, sat = true, sun = true }
local OWN_PRODUCTS = { rcf = true, voicemail = true, ivr = true, trunk = true }

-- ==================================================================
-- Strict JSON decoder that PRESERVES null (lib/json.lua maps null to nil,
-- which would erase the contract's "null = hang up" branches).
-- ==================================================================
M.NULL = setmetatable({}, { __tostring = function() return "null" end })
local NULL = M.NULL
local MAX_DEPTH = 32

local decode_value

local function skip_ws(s, i)
    return (s:find("[^ \t\r\n]", i)) or (#s + 1)
end

local ESC = { ['"'] = '"', ["\\"] = "\\", ["/"] = "/", b = "\b", f = "\f", n = "\n", r = "\r", t = "\t" }

local function utf8_of(cp)
    if cp < 0x80 then return string.char(cp) end
    if cp < 0x800 then return string.char(0xC0 | (cp >> 6), 0x80 | (cp & 0x3F)) end
    return string.char(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F))
end

local function decode_string(s, i)
    local out, j = {}, i + 1
    while true do
        local c = s:sub(j, j)
        if c == "" then return nil, "unterminated string" end
        if c == '"' then return table.concat(out), j + 1 end
        if c:byte() < 0x20 then return nil, "control byte in string" end
        if c == "\\" then
            local e = s:sub(j + 1, j + 1)
            if ESC[e] then
                out[#out + 1] = ESC[e]
                j = j + 2
            elseif e == "u" then
                local hex = s:sub(j + 2, j + 5)
                if not hex:match("^%x%x%x%x$") then return nil, "bad \\u escape" end
                local cp = tonumber(hex, 16)
                if cp >= 0xD800 and cp <= 0xDFFF then cp = 0xFFFD end
                out[#out + 1] = utf8_of(cp)
                j = j + 6
            else
                return nil, "bad escape"
            end
        else
            local k = s:find('["\\%c]', j) or (#s + 1)
            out[#out + 1] = s:sub(j, k - 1)
            j = k
        end
    end
end

local function decode_number(s, i)
    local num = s:match("^-?%d+%.?%d*[eE]?[+-]?%d*", i)
    if not num or num == "" or num == "-" then return nil, "bad number" end
    if not num:match("^-?0$") and num:match("^-?0%d") then return nil, "leading zero" end
    local v = math.tointeger(tonumber(num)) or tonumber(num)
    if v == nil then return nil, "bad number" end
    return v, i + #num
end

decode_value = function(s, i, depth)
    if depth > MAX_DEPTH then return nil, "nesting too deep" end
    i = skip_ws(s, i)
    local c = s:sub(i, i)
    if c == "{" then
        local obj = {}
        i = skip_ws(s, i + 1)
        if s:sub(i, i) == "}" then return obj, i + 1 end
        while true do
            if s:sub(i, i) ~= '"' then return nil, "object key expected" end
            local k, ni = decode_string(s, i)
            if not k then return nil, ni end
            i = skip_ws(s, ni)
            if s:sub(i, i) ~= ":" then return nil, "':' expected" end
            local v, vi = decode_value(s, i + 1, depth + 1)
            if v == nil then return nil, vi end
            if obj[k] ~= nil then return nil, "duplicate key " .. k end
            obj[k] = v
            i = skip_ws(s, vi)
            local d = s:sub(i, i)
            if d == "}" then return obj, i + 1 end
            if d ~= "," then return nil, "',' or '}' expected" end
            i = skip_ws(s, i + 1)
        end
    elseif c == "[" then
        local arr, n = {}, 0
        i = skip_ws(s, i + 1)
        if s:sub(i, i) == "]" then return arr, i + 1 end
        while true do
            local v, vi = decode_value(s, i, depth + 1)
            if v == nil then return nil, vi end
            n = n + 1
            arr[n] = v
            i = skip_ws(s, vi)
            local d = s:sub(i, i)
            if d == "]" then return arr, i + 1 end
            if d ~= "," then return nil, "',' or ']' expected" end
            i = i + 1
        end
    elseif c == '"' then
        return decode_string(s, i)
    elseif s:sub(i, i + 3) == "true" then
        return true, i + 4
    elseif s:sub(i, i + 4) == "false" then
        return false, i + 5
    elseif s:sub(i, i + 3) == "null" then
        return NULL, i + 4
    elseif c:match("[%-%d]") then
        return decode_number(s, i)
    end
    return nil, "unexpected character at " .. i
end

-- decode_json(text) -> value | nil, err. Never raises. null -> M.NULL.
function M.decode_json(text)
    if type(text) ~= "string" then return nil, "not a string" end
    if #text > M.MAX_PLAN_BYTES then return nil, "plan larger than " .. M.MAX_PLAN_BYTES .. " bytes" end
    local ok, v, i = pcall(decode_value, text, 1, 0)
    if not ok then return nil, "decoder raised: " .. tostring(v) end
    if v == nil then return nil, i end
    if skip_ws(text, i) <= #text then return nil, "trailing data" end
    return v
end

-- ==================================================================
-- Shape validators
-- ==================================================================
local function is_id(s)
    return type(s) == "string" and #s >= 1 and #s <= M.ID_MAX and s:match("^[A-Za-z0-9_%-]+$") ~= nil
end
M.is_id = is_id

local function is_sha(s)
    return type(s) == "string" and #s == 64 and s:match("^[0-9a-f]+$") ~= nil
end

local function is_int(v, lo, hi)
    return math.type(v) == "integer" and v >= lo and v <= hi
end

-- §6 shape: +1 NANP, NPA and NXX both [2-9]XX.
function M.is_nanp_e164(s)
    return type(s) == "string" and #s == 12
        and s:match("^%+1[2-9]%d%d[2-9]%d%d%d%d%d%d$") ~= nil
end

-- External targets: the §6 shape plus a defense-in-depth denylist of the
-- contract's explicitly blocked premium/service codes (P1 enforces the full
-- US-only NPA policy at publish; this only refuses what can never be a
-- legitimate IVR transfer even if a plan were tampered with).
function M.external_allowed(s)
    if not M.is_nanp_e164(s) then return false, "not +1 NANP E.164" end
    local npa, nxx, line = s:sub(3, 5), s:sub(6, 8), s:sub(9, 12)
    if npa == "900" then return false, "900 premium" end
    if npa:sub(2, 3) == "11" then return false, "N11 NPA" end
    if nxx:sub(2, 3) == "11" then return false, "N11 exchange" end
    if nxx == "976" then return false, "976 premium exchange" end
    if nxx == "555" and line:sub(1, 2) == "01" then return false, "555-01xx" end
    return true
end

local function is_date(s)
    if type(s) ~= "string" then return false end
    local y, m, d = s:match("^(%d%d%d%d)%-(%d%d)%-(%d%d)$")
    if not y then return false end
    y, m, d = tonumber(y), tonumber(m), tonumber(d)
    if m < 1 or m > 12 or d < 1 then return false end
    local mdays = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 }
    if m == 2 and (y % 4 == 0 and (y % 100 ~= 0 or y % 400 == 0)) then return d <= 29 end
    return d <= mdays[m]
end

local function is_array(t, max)
    if type(t) ~= "table" or t == NULL then return false end
    local n = #t
    if n > max then return false end
    local count = 0
    for k in pairs(t) do
        if math.type(k) ~= "integer" or k < 1 or k > n then return false end
        count = count + 1
    end
    return count == n
end

local function is_object(t)
    return type(t) == "table" and t ~= NULL
end

-- ==================================================================
-- Plan loading: decode + validate + normalize into an internal form.
-- Pointers become node-id strings or false (= null = hang up).
-- ==================================================================
-- expect: { flow_id=, version=, customer_id= } from the ivr_fs_number row
-- (defense in depth: the plan must belong to the number's bound flow).
function M.load_plan(text, expect)
    local raw, err = M.decode_json(text)
    if raw == nil then return nil, "plan JSON: " .. tostring(err) end
    return M.validate_plan(raw, expect)
end

function M.validate_plan(raw, expect)
    local function fail(msg) return nil, "invalid plan: " .. msg end
    if not is_object(raw) then return fail("not an object") end
    if raw.v ~= 1 then return fail("v must be 1") end
    if type(raw.compiler) ~= "string" or not raw.compiler:match("^[%w%._%-]+$") or #raw.compiler > 20 then
        return fail("bad compiler tag")
    end
    for _, k in ipairs({ "flow_id", "version", "customer_id" }) do
        if not is_int(raw[k], 1, 2 ^ 53) then return fail(k .. " must be a positive integer") end
    end
    if expect then
        if expect.flow_id and raw.flow_id ~= expect.flow_id then return fail("flow_id differs from the number's flow") end
        if expect.version and raw.version ~= expect.version then return fail("version differs from the published version") end
        if expect.customer_id and raw.customer_id ~= expect.customer_id then return fail("customer_id differs from the number's owner") end
    end
    local lim = raw.limits
    if not is_object(lim) then return fail("limits missing") end
    if not is_int(lim.max_steps, 1, 1000) then return fail("limits.max_steps out of range") end
    if not is_int(lim.max_seconds, 1, 3600) then return fail("limits.max_seconds out of range") end

    if not is_array(raw.prompts, M.MAX_PROMPTS) then return fail("prompts must be an array") end
    local prompt_set, prompts = {}, {}
    for _, sha in ipairs(raw.prompts) do
        if not is_sha(sha) then return fail("prompt sha shape") end
        if not prompt_set[sha] then
            prompt_set[sha] = true
            prompts[#prompts + 1] = sha
        end
    end

    if not is_object(raw.nodes) then return fail("nodes must be an object") end
    local count = 0
    for id in pairs(raw.nodes) do
        count = count + 1
        if not is_id(id) then return fail("node id shape") end
    end
    if count == 0 then return fail("no nodes") end
    if count > M.MAX_NODES then return fail("too many nodes") end
    if not is_id(raw.start) or raw.nodes[raw.start] == nil then return fail("start is not a node") end

    local function ptr(v, what)
        if v == nil or v == NULL then return false end
        if is_id(v) and raw.nodes[v] ~= nil then return v end
        return nil, what .. " is not a node id or null"
    end
    local function sha_list(v, what, min, max)
        if v == nil or v == NULL then
            if min > 0 then return nil, what .. " missing" end
            return {}
        end
        if not is_array(v, max) or #v < min then return nil, what .. " must be an array of " .. min .. "-" .. max end
        local out = {}
        for i, sha in ipairs(v) do
            if not is_sha(sha) then return nil, what .. " sha shape" end
            if not prompt_set[sha] then return nil, what .. " sha not in the prefetch list" end
            out[i] = sha
        end
        return out
    end

    local nodes = {}
    for id, n in pairs(raw.nodes) do
        if not is_object(n) then return fail(id .. ": not an object") end
        local t = n.t
        local o, e = { t = t }, nil
        if t == "play" then
            o.prompts, e = sha_list(n.prompts, id .. ".prompts", 1, 10); if not o.prompts then return fail(e) end
            o.next, e = ptr(n.next, id .. ".next"); if o.next == nil then return fail(e) end
        elseif t == "menu" then
            o.prompts, e = sha_list(n.prompts, id .. ".prompts", 1, 10); if not o.prompts then return fail(e) end
            o.invalid_prompts, e = sha_list(n.invalid_prompts, id .. ".invalid_prompts", 0, 10); if not o.invalid_prompts then return fail(e) end
            o.noinput_prompts, e = sha_list(n.noinput_prompts, id .. ".noinput_prompts", 0, 10); if not o.noinput_prompts then return fail(e) end
            if not is_object(n.digits) then return fail(id .. ".digits must be an object") end
            o.digits = {}
            local nd = 0
            for d, target in pairs(n.digits) do
                if type(d) ~= "string" or not d:match("^[0-9*#]$") then return fail(id .. ".digits key shape") end
                local p
                p, e = ptr(target, id .. ".digits[" .. d .. "]"); if p == nil then return fail(e) end
                o.digits[d] = p
                nd = nd + 1
            end
            if nd < 1 or nd > 12 then return fail(id .. ".digits must have 1-12 keys") end
            if not is_int(n.timeout_ms, 1000, 30000) then return fail(id .. ".timeout_ms out of range") end
            if not is_int(n.retries, 0, 5) then return fail(id .. ".retries out of range") end
            o.timeout_ms, o.retries = n.timeout_ms, n.retries
            o.on_noinput, e = ptr(n.on_noinput, id .. ".on_noinput"); if o.on_noinput == nil then return fail(e) end
            o.on_nomatch, e = ptr(n.on_nomatch, id .. ".on_nomatch"); if o.on_nomatch == nil then return fail(e) end
        elseif t == "hours" then
            if not PINNED_TZ[n.tz] then return fail(id .. ".tz not in the pinned list") end
            o.tz = n.tz
            if not is_object(n.weekly) then return fail(id .. ".weekly must be an object") end
            o.weekly = {}
            for day, ranges in pairs(n.weekly) do
                if not DAY_KEYS[day] then return fail(id .. ".weekly day key") end
                if not is_array(ranges, 4) then return fail(id .. ".weekly." .. tostring(day) .. " must be <= 4 ranges") end
                local rs = {}
                for i, r in ipairs(ranges) do
                    if not is_array(r, 2) or #r ~= 2 or not is_int(r[1], 0, 1439)
                        or not is_int(r[2], 1, 1440) or r[1] >= r[2] then
                        return fail(id .. ".weekly." .. day .. " range shape")
                    end
                    rs[i] = { r[1], r[2] }
                end
                o.weekly[day] = rs
            end
            local cd = n.closed_dates
            if cd == nil or cd == NULL then cd = {} end
            if not is_array(cd, 400) then return fail(id .. ".closed_dates must be an array") end
            o.closed_dates = {}
            for i, d in ipairs(cd) do
                if not is_date(d) then return fail(id .. ".closed_dates date shape") end
                o.closed_dates[i] = d
            end
            o.open, e = ptr(n.open, id .. ".open"); if o.open == nil then return fail(e) end
            o.closed, e = ptr(n.closed, id .. ".closed"); if o.closed == nil then return fail(e) end
        elseif t == "caller" then
            if n.mode ~= "prefix" and n.mode ~= "equals" and n.mode ~= "anonymous" then
                return fail(id .. ".mode")
            end
            o.mode = n.mode
            local vals = n.values
            if vals == nil or vals == NULL then vals = {} end
            if not is_array(vals, 50) then return fail(id .. ".values must be an array of <= 50") end
            if n.mode ~= "anonymous" and #vals < 1 then return fail(id .. ".values empty") end
            o.values = {}
            for i, v in ipairs(vals) do
                if type(v) ~= "string" or not v:match("^%+%d+$") or #v > 16 then
                    return fail(id .. ".values shape")
                end
                o.values[i] = v
            end
            o.match, e = ptr(n.match, id .. ".match"); if o.match == nil then return fail(e) end
            o.nomatch, e = ptr(n.nomatch, id .. ".nomatch"); if o.nomatch == nil then return fail(e) end
        elseif t == "transfer" then
            local d = n.dest
            if not is_object(d) then return fail(id .. ".dest") end
            if d.kind == "external" then
                local ok, why = M.external_allowed(d.e164)
                if not ok then return fail(id .. ".dest.e164 " .. tostring(why)) end
                o.dest = { kind = "external", e164 = d.e164 }
            elseif d.kind == "own" then
                if not M.is_nanp_e164(d.did) then return fail(id .. ".dest.did shape") end
                if not OWN_PRODUCTS[d.product] then return fail(id .. ".dest.product") end
                o.dest = { kind = "own", e164 = d.did, product = d.product }
            else
                return fail(id .. ".dest.kind")
            end
            if type(n.pass_caller_id) ~= "boolean" then return fail(id .. ".pass_caller_id must be boolean") end
            if not is_int(n.ring_timeout, 5, 120) then return fail(id .. ".ring_timeout out of range") end
            o.pass_caller_id, o.ring_timeout = n.pass_caller_id, n.ring_timeout
            o.on_noanswer, e = ptr(n.on_noanswer, id .. ".on_noanswer"); if o.on_noanswer == nil then return fail(e) end
        elseif t == "voicemail" then
            if not M.is_nanp_e164(n.did) then return fail(id .. ".did shape") end
            o.did = n.did
        elseif t == "hangup" then
            o.prompts, e = sha_list(n.prompts, id .. ".prompts", 0, 10); if not o.prompts then return fail(e) end
        else
            return fail(id .. ": unknown node type")
        end
        nodes[id] = o
    end

    return {
        v = 1, compiler = raw.compiler,
        flow_id = raw.flow_id, version = raw.version, customer_id = raw.customer_id,
        start = raw.start,
        max_steps = lim.max_steps, max_seconds = lim.max_seconds,
        prompts = prompts,
        nodes = nodes,
    }
end

-- ==================================================================
-- Call state shared across nested IVRs on the same call (an IVR that
-- transfers to another of the platform's IVR numbers runs that IVR on the
-- same channel and appends to the same CDR state).
-- ==================================================================
function M.new_state(answered_at)
    return {
        path = "", path_truncated = false,
        answered_at = answered_at, transfer_to = nil, transfer_started_at = nil,
        exit = nil, depth = 0,
    }
end

local ELLIPSIS = "\226\128\166"  -- U+2026

local function path_push(state, token, sep)
    if state.path_truncated then return end
    local add = (state.path == "") and token or (sep .. token)
    if #state.path + #add > M.PATH_MAX then
        local room = M.PATH_MAX - #ELLIPSIS
        state.path = (state.path .. add):sub(1, room) .. ELLIPSIS
        state.path_truncated = true
        return
    end
    state.path = state.path .. add
end
M.path_push = path_push

-- ==================================================================
-- Run
-- ==================================================================
-- opts:
--   plan        validated plan (M.load_plan)
--   state       M.new_state(...) (shared with nested runs)
--   prompts     lib/ivr_prompts.lua (path_for, system)
--   schedule    lib/schedule.lua
--   rules       lib/rules.lua
--   number_utils lib/number_utils.lua (optional)
--   caller      presented caller number (for caller checks)
--   now         function() -> integer epoch (default os.time)
--   log         function(level, msg) (optional)
--   transfer    function(spec) -> { status=, cause=, product= }
--                 spec = { kind="external"|"own", e164=, pass_caller_id=,
--                          ring_timeout=, product=?, voicemail=bool }
-- returns the state (state.exit set).
function M.run(session, opts)
    local plan, state = opts.plan, opts.state
    local P = opts.prompts
    local now = opts.now or os.time
    local function log(level, msg)
        if opts.log then pcall(opts.log, level, msg) end
    end
    local function ready()
        local ok, r = pcall(function() return session:ready() end)
        return ok and r == true
    end
    local function exec(app, data)
        return pcall(function() session:execute(app, data) end)
    end
    local function hangup(cause)
        pcall(function() session:hangup(cause or "NORMAL_CLEARING") end)
    end
    local function play(path)
        if path and ready() then exec("playback", path) end
    end
    local function finish(exit, cause, sys_prompt)
        if not state.exit then state.exit = exit end
        if ready() then
            if sys_prompt then play(P.system(sys_prompt)) end
            hangup(cause)
        end
        return state
    end

    -- A plan's own wall-clock budget runs from the FIRST answer on this call.
    local t0 = state.answered_at or now()
    local steps = 0
    local cur = plan.start
    local null_exit = "hangup"

    while true do
        if not ready() then return finish("caller_hangup") end
        if cur == false then return finish(null_exit, "NORMAL_CLEARING") end
        null_exit = "hangup"
        steps = steps + 1
        if steps > plan.max_steps or (now() - t0) > plan.max_seconds then
            log("WARNING", string.format("budget exceeded at %s (steps=%d/%d, %ds/%ds)",
                cur, steps - 1, plan.max_steps, now() - t0, plan.max_seconds))
            return finish("limit", "NORMAL_CLEARING", "goodbye")
        end
        local node = plan.nodes[cur]
        path_push(state, cur, ">")

        if node.t == "play" then
            for _, sha in ipairs(node.prompts) do
                if not ready() then break end
                play(P.path_for(sha))
            end
            cur = node.next

        elseif node.t == "menu" then
            local lead, last_fail, chosen = nil, nil, nil
            for attempt = 1, node.retries + 1 do
                if not ready() then return finish("caller_hangup") end
                local files = {}
                for _, sha in ipairs(lead or {}) do files[#files + 1] = P.path_for(sha) end
                for _, sha in ipairs(node.prompts) do files[#files + 1] = P.path_for(sha) end
                local file = (#files == 1) and files[1] or ("file_string://" .. table.concat(files, "!"))
                pcall(function() session:setVariable(M.DIGIT_VAR, "") end)
                exec("play_and_get_digits", string.format("1 1 1 %d none %s %s %s . %d",
                    node.timeout_ms, file, M.SILENCE, M.DIGIT_VAR, node.timeout_ms))
                if not ready() then return finish("caller_hangup") end
                local okv, d = pcall(function() return session:getVariable(M.DIGIT_VAR) end)
                d = (okv and type(d) == "string") and d or ""
                if d ~= "" and node.digits[d] ~= nil then
                    chosen = d
                    break
                end
                if d == "" then
                    last_fail, lead = "noinput", node.noinput_prompts
                else
                    last_fail, lead = "nomatch", node.invalid_prompts
                end
                log("INFO", string.format("menu %s try %d/%d: %s", cur, attempt, node.retries + 1, last_fail))
            end
            if not chosen then
                -- Out of tries: the last failure's prompt, then the exit.
                for _, sha in ipairs(lead or {}) do
                    if not ready() then break end
                    play(P.path_for(sha))
                end
                if not ready() then return finish("caller_hangup") end
            end
            if chosen then
                path_push(state, chosen, ":")
                cur = node.digits[chosen]
            elseif last_fail == "noinput" then
                path_push(state, "noinput", ":")
                cur = node.on_noinput
                null_exit = "timeout"
            else
                path_push(state, "nomatch", ":")
                cur = node.on_nomatch
            end

        elseif node.t == "hours" then
            local open, herr = opts.schedule.hours_open(node, now())
            if open == nil then
                log("ERR", "hours " .. cur .. ": " .. tostring(herr))
                return finish("error", "NORMAL_TEMPORARY_FAILURE", "technical_difficulty")
            end
            path_push(state, open and "open" or "closed", ":")
            cur = open and node.open or node.closed

        elseif node.t == "caller" then
            local m = opts.rules.caller_matches(node.mode, node.values, opts.caller, opts.number_utils)
            path_push(state, m and "match" or "nomatch", ":")
            cur = m and node.match or node.nomatch

        elseif node.t == "transfer" or node.t == "voicemail" then
            local spec
            if node.t == "transfer" then
                spec = { kind = node.dest.kind, e164 = node.dest.e164, product = node.dest.product,
                         pass_caller_id = node.pass_caller_id, ring_timeout = node.ring_timeout }
            else
                spec = { kind = "own", e164 = node.did, product = "voicemail", voicemail = true,
                         pass_caller_id = true, ring_timeout = 30 }
            end
            state.transfer_to = spec.e164
            state.transfer_started_at = now()
            local ok, res = pcall(opts.transfer, spec)
            if not ok then
                log("ERR", "transfer raised: " .. tostring(res))
                res = { status = "rejected", cause = "NORMAL_TEMPORARY_FAILURE" }
            end
            res = res or { status = "delivered" }
            local st = res.status
            if st == "answered" or st == "delivered" then
                if res.product == "voicemail" then
                    return finish("voicemail")
                elseif res.product == "ivr" then
                    return finish(state.exit or "transfer")
                end
                return finish("transfer")
            elseif st == "rejected" then
                path_push(state, "rejected", ":")
                return finish("error", res.cause or "CALL_REJECTED", "technical_difficulty")
            elseif st == "caller_gone" or not ready() then
                return finish("caller_hangup")
            end
            -- noanswer / busy / failed: continue at on_noanswer (voicemail: hang up).
            path_push(state, (st == "busy") and "busy" or "noanswer", ":")
            cur = (node.t == "transfer") and node.on_noanswer or false

        elseif node.t == "hangup" then
            for _, sha in ipairs(node.prompts) do
                if not ready() then break end
                play(P.path_for(sha))
            end
            return finish("hangup", "NORMAL_CLEARING")
        else
            return finish("error", "NORMAL_TEMPORARY_FAILURE", "technical_difficulty")
        end
    end
end

-- Final CDR variables (contract §5.5). Called once, by the outermost IVR.
function M.cdr_vars(state, end_time)
    local vars = {
        ivr_exit = state.exit or "error",
        ivr_path = state.path,
    }
    if state.transfer_to then vars.ivr_transfer_to = state.transfer_to end
    if state.answered_at then
        local stop = end_time
        if (state.exit == "transfer" or state.exit == "voicemail") and state.transfer_started_at then
            stop = state.transfer_started_at
        end
        local secs = math.max(0, math.floor(stop - state.answered_at))
        vars.ivr_seconds = string.format("%d", secs)
    end
    return vars
end

return M
