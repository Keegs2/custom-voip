-- lib/sbc.lua — SBC reachability pre-check + multi-attempt failover loop (RCF-V1)
--
-- Extracted verbatim (behavior-preserving) from inbound_router.lua's rcf branch.
-- Three responsibilities, all hard-won (see CLAUDE.md "SBC Failover — TCP
-- Pre-Check + 4-Attempt Loop"):
--
--   1. sbc_tcp_probe(ip, port)   — raw 1-second TCP connect to detect a dead SBC
--                                  in <1s instead of waiting out the SIP timeout.
--   2. is_reachable(ip, port)    — the probe wrapped in a process-wide result
--                                  cache (FreeSWITCH global variables): reachable
--                                  cached 30s, unreachable cached 10s.
--   3. failover_bridge(o)        — the 4-attempt SBC×carrier loop: per-attempt
--                                  reachability skip, bridge, success detection
--                                  via originate_disposition, break on success or
--                                  a torn-down A-leg.
--
-- Module-level state (luasocket_warned) resets per call because inbound_router
-- re-loads this module each invocation via load_module() — matching the prior
-- per-call script-local. The reachability CACHE persists across calls because it
-- lives in FreeSWITCH global variables, not module state.
--
-- Loaded via the load_module() loadfile() pattern (CLAUDE.md gotcha #10).

local M = {}

-- Cache TTLs (seconds). A healthy SBC is trusted for 30s (probed at most ~2x/min);
-- an unreachable SBC is re-checked after 10s so a recovered SBC comes back fast.
M.HEALTH_UP_TTL = 30
M.HEALTH_DOWN_TTL = 10

local luasocket_warned = false  -- warn once per call (per module load), not per attempt

-- Raw TCP probe. Returns true/false, or nil if luasocket is unavailable
-- (unknown — caller fails open and the result is NOT cached).
function M.tcp_probe(ip, port)
    local ok, socket = pcall(require, "socket")
    if not ok then
        -- A broken/missing luasocket silently disables the fast-failover
        -- pre-check. Make it visible instead of failing open silently.
        if not luasocket_warned then
            freeswitch.consoleLog("WARNING", string.format(
                "[sbc] luasocket unavailable (%s) — SBC TCP pre-check disabled, failing open\n",
                tostring(socket)
            ))
            luasocket_warned = true
        end
        return nil
    end
    local tcp = socket.tcp()
    tcp:settimeout(1)
    local result = tcp:connect(ip, port or 5060)
    tcp:close()
    return result ~= nil
end

-- Cached reachability check. Returns true if the SBC is (believed) reachable.
function M.is_reachable(ip, port)
    local cache_key = "sbc_health_" .. ip
    local now = os.time()

    -- Check cache
    local cached_status, cached_ts = nil, nil
    local cached = freeswitch.getGlobalVariable(cache_key)
    if cached and cached ~= "" then
        local status, ts = cached:match("^(%a+):(%d+)$")
        cached_status = status
        cached_ts = tonumber(ts)
    end

    if cached_status and cached_ts then
        local ttl = (cached_status == "up") and M.HEALTH_UP_TTL or M.HEALTH_DOWN_TTL
        local age = now - cached_ts
        if age >= 0 and age < ttl then
            freeswitch.consoleLog("DEBUG", string.format(
                "[sbc] SBC health cache hit: %s is %s (age=%ds)\n",
                ip, cached_status, age
            ))
            return cached_status == "up"
        end
    end

    -- Cache miss or expired: do the real TCP probe and refresh
    local probe = M.tcp_probe(ip, port)
    if probe == nil then
        return true  -- luasocket unavailable: fail open, do not cache
    end

    local new_status = probe and "up" or "down"
    if cached_status and cached_status ~= new_status then
        freeswitch.consoleLog("INFO", string.format(
            "[sbc] SBC %s health transition: %s -> %s\n",
            ip, cached_status, new_status
        ))
    elseif not cached_status and new_status == "down" then
        freeswitch.consoleLog("INFO", string.format(
            "[sbc] SBC %s health: down (first probe)\n", ip
        ))
    end
    freeswitch.setGlobalVariable(cache_key, string.format("%s:%d", new_status, now))
    return probe
end

-- Multi-attempt SBC × carrier failover loop.
--
-- o = {
--   session    = <session>,         -- the call session (bridge target)
--   get_var    = <fn(name,default)>,-- session var reader (matches inbound_router)
--   set_var    = <fn(name,value)>,  -- session var writer
--   uuid       = <string>,          -- for logging
--   did        = <string>,          -- normalized DID, for logging
--   dest       = <string>,          -- forward_to / destination, for logging
--   attempts   = { {sbc=, carrier=, label=}, ... },  -- ordered attempt list
--   build_dial = <fn(attempt) -> dial_string>,       -- per-attempt dial string
-- }
--
-- For each attempt: cached TCP pre-check skips an unreachable SBC instantly;
-- otherwise set carrier_used, bridge, and inspect originate_disposition (the
-- authoritative FS bridge-result var — never `bridge_result`). Break on the
-- first connected attempt, or if continue_on_fail tore the A-leg down.
function M.failover_bridge(o)
    local n = #o.attempts
    for i, attempt in ipairs(o.attempts) do
        local attempted = false

        -- TCP pre-check: detect dead SBC in <1 second instead of
        -- waiting for SIP timeout. Skip unreachable SBCs instantly.
        if not M.is_reachable(attempt.sbc, 5060) then
            freeswitch.consoleLog("WARNING", string.format(
                "[%s] RCF bridge attempt %d/%d SKIPPED — SBC %s unreachable (%s)\n",
                o.uuid, i, n, attempt.sbc, attempt.label
            ))
        else
            attempted = true
            local attempt_dial = o.build_dial(attempt)

            -- Label the CDR with the carrier we are about to try. If this
            -- attempt connects we break immediately below, so carrier_used
            -- reflects the WINNING attempt. On failure the next iteration
            -- overwrites it before its own bridge.
            o.set_var("carrier_used", "carrier_" .. attempt.carrier)

            freeswitch.consoleLog("INFO", string.format(
                "[%s] RCF bridge attempt %d/%d (%s): %s -> %s@%s carrier=%s\n",
                o.uuid, i, n, attempt.label, o.did, o.dest, attempt.sbc, attempt.carrier
            ))

            pcall(function()
                o.session:execute("bridge", attempt_dial)
            end)
        end

        -- Determine whether THIS bridge connected. originate_disposition is
        -- the authoritative FreeSWITCH variable: "SUCCESS" after a connected
        -- bridge, or a failure cause otherwise. (bridge_result is NOT a real
        -- channel variable — never trust it.) We only inspect disposition for
        -- attempts that actually ran a bridge; a skipped (unreachable-SBC)
        -- attempt leaves the previous attempt's disposition in place and must
        -- not be misread as success.
        if attempted then
            local disposition = o.get_var("originate_disposition", "")
            if disposition == "SUCCESS" then
                freeswitch.consoleLog("INFO", string.format(
                    "[%s] RCF bridge attempt %d/%d succeeded (%s)\n",
                    o.uuid, i, n, attempt.label
                ))
                break
            end

            freeswitch.consoleLog("INFO", string.format(
                "[%s] RCF bridge attempt %d/%d failed (%s): cause=%s\n",
                o.uuid, i, n, attempt.label,
                o.get_var("last_bridge_hangup_cause", disposition)
            ))
        end

        -- If continue_on_fail tore the A-leg down (e.g. caller hung up
        -- mid-failover), stop trying — the session is gone.
        if not o.session:ready() then
            break
        end
    end
end

return M
