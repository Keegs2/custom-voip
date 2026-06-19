-- lib/multileg.lua — shared multi-leg ring / failover primitives (unified)
--
-- Two product paths ring a call across MORE THAN ONE destination and stop on the
-- first one that answers:
--   * handlers/ucaas.lua  — find-me/follow-me (extensions.ring_plan): ring a
--     user's extension, cell, etc. in order (or all at once).
--   * handlers/trunk.lua  — SIP-trunk inbound multi-endpoint delivery
--     (trunk_dids.route_plan): deliver an inbound DID across a customer's PBX
--     endpoints in order (or all at once).
--
-- The leg/endpoint dial-string construction is product-specific (verto/user vs
-- per-endpoint X-PBX-Dest), so it stays in each handler. What IS identical — and
-- is centralized here — is the *control flow*:
--   * the authoritative "a leg answered" check (originate_disposition),
--   * the sequential failover loop (ready-check, build, bridge, stop-on-answer),
--   * the parallel simring (one comma-joined dial string).
--
-- Extracting this keeps the ucaas behavior byte-for-byte (it now delegates to
-- these runners; its observable side effects — bridges, executes, hangups — are
-- unchanged) and lets the trunk handler reuse the exact same proven loop.
--
-- Loaded via the load_module()/loadfile() pattern (CLAUDE.md gotcha #10).

local M = {}

-- Authoritative bridge-result check (CLAUDE.md): a leg connected IFF
-- originate_disposition == "SUCCESS". `bridge_result` is NOT a real channel
-- variable (reading it always returns "") — using it would wrongly treat an
-- ANSWERED call as failed and run the fallback. `get_var` is the handler's
-- safe variable reader (get_var(name, default)).
function M.bridged_ok(get_var)
    return get_var("originate_disposition", "") == "SUCCESS"
end

-- Sequential failover ring. For each leg (in document order) call
-- build(leg, idx) to get that leg's dial string; build may also set per-leg
-- channel vars and/or log, and returns nil/"" to SKIP the leg. The leg is
-- bridged; the instant one answers (originate_disposition == "SUCCESS") the loop
-- stops and returns true. session:ready() guards against the caller having hung
-- up mid-ring. Returns true iff some leg answered.
--
-- continue_on_fail=true (set by the caller on the A-leg) returns control here
-- after a failed leg; hangup_after_bridge=true tears the call down once a leg
-- answers.
function M.sequential(session, get_var, legs, build)
    for idx, leg in ipairs(legs) do
        if not session:ready() then break end       -- caller hung up — stop
        local ds = build(leg, idx)
        if ds and ds ~= "" then
            pcall(function() session:execute("bridge", ds) end)
            if M.bridged_ok(get_var) then return true end   -- answered — done
        end
    end
    return M.bridged_ok(get_var)
end

-- Parallel (simring) ring: bridge ALL legs at once via a single dial string.
--   prefix   : the "{...}" global bridge-options block (must already include the
--              surrounding braces), e.g. "{ignore_early_media=false,call_timeout=25}".
--   channels : list of per-leg endpoint strings, each optionally carrying its own
--              "[...]" per-channel variable block (e.g. a per-endpoint
--              "[sip_h_X-PBX-Dest=...]"). They are comma-joined (simring).
-- Returns true iff the simring connected. No-op (returns false) for 0 channels.
function M.parallel(session, get_var, prefix, channels)
    if not channels or #channels == 0 then return false end
    local ds = prefix .. table.concat(channels, ",")
    pcall(function() session:execute("bridge", ds) end)
    return M.bridged_ok(get_var)
end

return M
