-- handlers/trunk.lua — SIP Trunk inbound handler (unified)
--
-- Routes an inbound DID that belongs to a customer SIP trunk to that customer's
-- PBX, through the Kamailio SBC. Two modes:
--
--   1. NO route_plan (trunk_dids.route_plan is NULL) -> LEGACY single-endpoint
--      bridge to the FIRST authorized endpoint IP (endpoint_ips[1]). This path is
--      byte-for-byte behavior-preserving and pinned by tests/lua/spec/
--      trunk_inbound_spec.lua.
--
--   2. route_plan present (trunk_dids.route_plan JSONB, parsed by
--      db_client.lookup_trunk_did into routing.route_plan) -> MULTI-ENDPOINT
--      delivery across the trunk's PBX endpoints:
--        { strategy   = "failover" | "parallel",
--          timeout    = <int s>,                        -- per-endpoint default
--          endpoints  = { { to=<pbx ip|ip:port>, timeout?=<int> }, ... } }
--      The backend owns the route_plan column; this handler only READS it.
--
-- X-PBX-Dest tells Kamailio which PBX to relay to (kamailio.cfg reads
-- $hdr(X-PBX-Dest) per request and sets $du = "sip:" + ip + ":5060"). Each
-- endpoint attempt therefore carries its OWN X-PBX-Dest:
--   * failover (sequential): one bridge per endpoint, X-PBX-Dest is in THAT
--     attempt's dial-string {} block (self-contained per B-leg; no stale value
--     can leak across attempts — you cannot put differing X-PBX-Dest values in a
--     single multi-channel dial string).
--   * parallel (simring): all endpoints in ONE comma-joined dial string, each
--     endpoint carrying its X-PBX-Dest in a per-channel [] block.
--
-- SECURITY: route_plan endpoints are validated against the trunk's authorized
-- endpoint IPs (trunk_auth_ips). Kamailio does NOT re-validate X-PBX-Dest, so an
-- unauthorized IP in the plan would be an open relay — those endpoints are
-- skipped. If a route_plan resolves to NO authorized endpoints, we fail safe to
-- the legacy single-endpoint bridge rather than dropping the call.
--
-- NOTE (distinct script): outbound trunk calls FROM customer PBXs are handled by
-- the top-level trunk_outbound.lua, not this file.
--
-- ctx fields consumed:
--   session, get_var, set_var, hangup
--   uuid, normalized_did, trunk_id, caller_id_number, routing (route_plan)
--   sbc_proxy_ip
--   db                                       — db_client (endpoint IP lookup)
--   dialstring, session_timer, multileg      — lib modules
--
-- `freeswitch` is the mod_lua global.

return function(ctx)
    local session = ctx.session
    local get_var = ctx.get_var
    local set_var = ctx.set_var
    local hangup = ctx.hangup
    local uuid = ctx.uuid
    local normalized_did = ctx.normalized_did
    local trunk_id = ctx.trunk_id
    local caller_id = ctx.caller_id_number
    local sbc_proxy_ip = ctx.sbc_proxy_ip
    local db = ctx.db
    local dialstring = ctx.dialstring
    local session_timer = ctx.session_timer
    local multileg = ctx.multileg
    local route_plan = ctx.routing and ctx.routing.route_plan

    -- SIP Trunk inbound — route call to customer's PBX
    -- Look up the customer's authorized IP(s) and bridge to their PBX
    freeswitch.consoleLog("DEBUG", string.format(
        "[%s] Trunk inbound: trunk_id=%s did=%s%s\n",
        uuid, tostring(trunk_id), normalized_did,
        (type(route_plan) == "table") and " [route_plan present]" or ""
    ))

    -- Get customer PBX endpoint IPs
    local endpoint_ips = nil
    if db then
        local lookup_ok, lookup_result = pcall(function()
            return db.get_trunk_endpoint_ips(trunk_id)
        end)
        if lookup_ok then
            endpoint_ips = lookup_result
        else
            freeswitch.consoleLog("ERR", string.format(
                "[%s] Trunk endpoint IP lookup failed for trunk %s: %s\n",
                uuid, tostring(trunk_id), tostring(lookup_result)
            ))
        end
    else
        freeswitch.consoleLog("ERR", "[" .. uuid .. "] db_client unavailable — cannot look up trunk endpoints\n")
    end

    freeswitch.consoleLog("DEBUG", string.format(
        "[%s] Trunk endpoint lookup: count=%d\n",
        uuid, (endpoint_ips and #endpoint_ips or 0)
    ))

    if not endpoint_ips or #endpoint_ips == 0 then
        freeswitch.consoleLog("WARNING", string.format(
            "[%s] No endpoint IPs found for trunk %s\n", uuid, tostring(trunk_id)
        ))
        hangup("NO_ROUTE_DESTINATION", "[" .. uuid .. "] No PBX endpoint configured for trunk")
        return
    end

    -- Media anchoring and ringback (same as RCF). Set ONCE for both paths.
    set_var("proxy_media", "true")
    set_var("ringback", "%(2000,4000,440,480)")
    set_var("transfer_ringback", "%(2000,4000,440,480)")
    set_var("hangup_after_bridge", "true")
    set_var("continue_on_fail", "true")

    -- Caller ID: pass the original caller through to the PBX
    local original_caller = get_var("sip_from_user", caller_id)
    set_var("effective_caller_id_number", original_caller)

    -- Mark as lua-routed (prevents the dialplan fallback returning 404)
    set_var("lua_routed", "true")

    -- The DID the PBX expects, with the leading "+" stripped (same as RCF).
    local bridge_did = normalized_did:gsub("^%+", "")

    -- ========================================================================
    -- route_plan path — multi-endpoint delivery (failover ordering / parallel).
    -- Build the ORDERED, AUTHORIZED endpoint list first; if it is empty we fall
    -- through to the legacy single-endpoint bridge (fail-safe).
    -- ========================================================================
    if type(route_plan) == "table" and type(route_plan.endpoints) == "table"
        and #route_plan.endpoints > 0 then

        -- Authorized PBX IPs for this trunk (trunk_auth_ips, bare host() IPs).
        local authorized = {}
        for _, ip in ipairs(endpoint_ips) do authorized[ip] = true end

        -- Extract the bare IP from a plan endpoint "to" ("ip" or "ip:port").
        -- Kamailio's X-PBX-Dest handler HARD-CODES :5060, so only the IP is
        -- meaningful (a custom port in the plan cannot be honored by the current
        -- SBC config — see report).
        local function pbx_ip_of(to)
            if not to then return nil end
            local s = tostring(to):gsub("^%s*(.-)%s*$", "%1")
            if s == "" then return nil end
            return s:match("^([^:]+)")
        end

        -- Filter the plan to authorized endpoints, preserving plan order.
        local eps = {}
        for _, ep in ipairs(route_plan.endpoints) do
            local ip = (type(ep) == "table") and pbx_ip_of(ep.to) or nil
            if ip and authorized[ip] then
                eps[#eps + 1] = {
                    ip = ip,
                    timeout = (type(ep) == "table") and tonumber(ep.timeout) or nil,
                }
            elseif ip then
                freeswitch.consoleLog("WARNING", string.format(
                    "[%s] route_plan endpoint %s not in trunk %s authorized IPs — skipping\n",
                    uuid, ip, tostring(trunk_id)))
            else
                freeswitch.consoleLog("WARNING", string.format(
                    "[%s] route_plan endpoint missing/invalid 'to' — skipping\n", uuid))
            end
        end

        if #eps > 0 then
            -- Per-endpoint default timeout. 60 matches the legacy single bridge's
            -- call_timeout, so an endpoint with no explicit timeout rings exactly
            -- as long as today's single delivery.
            local plan_timeout = tonumber(route_plan.timeout) or 60
            local strategy = route_plan.strategy
            if strategy ~= "parallel" then strategy = "failover" end

            freeswitch.consoleLog("INFO", string.format(
                "[%s] Trunk route_plan: strategy=%s endpoints=%d timeout=%ds\n",
                uuid, strategy, #eps, plan_timeout))

            if strategy == "parallel" then
                -- PARALLEL: ring all PBX endpoints at once. Common bridge options
                -- (SOA off, overall call_timeout, RFC 4028 timers) live in the
                -- global {} block; each endpoint's OWN X-PBX-Dest (and optional
                -- per-leg timeout) lives in its [] per-channel block. All legs go
                -- to the same SBC; Kamailio reads each forked INVITE's X-PBX-Dest
                -- independently. We can NOT use a single A-leg X-PBX-Dest here —
                -- that's exactly why each leg carries its own in [].
                local channels = {}
                for _, ep in ipairs(eps) do
                    local lv = {}
                    if ep.timeout then lv[#lv + 1] = "leg_timeout=" .. ep.timeout end
                    lv[#lv + 1] = "sip_h_X-PBX-Dest=" .. ep.ip
                    channels[#channels + 1] = "[" .. table.concat(lv, ",") .. "]" ..
                        string.format("sofia/external/%s@%s:5060", bridge_did, sbc_proxy_ip)
                end
                local prefix = string.format(
                    "{ignore_early_media=false,sip_enable_soa=false,call_timeout=%d,%s}",
                    plan_timeout, session_timer.BRIDGE_OPTS)
                freeswitch.consoleLog("INFO", string.format(
                    "[%s] Trunk parallel delivery: %s%s\n",
                    uuid, prefix, table.concat(channels, ",")))
                multileg.parallel(session, get_var, prefix, channels)
            else
                -- FAILOVER (sequential): try endpoints in order, each up to its
                -- own timeout (or the plan timeout), advancing on no-answer/busy/
                -- failure. One bridge per endpoint so each per-endpoint timeout is
                -- honored exactly. X-PBX-Dest is in THIS attempt's {} block, so
                -- the new B-leg's INVITE always carries the right PBX IP and no
                -- stale value can leak from a previous attempt.
                multileg.sequential(session, get_var, eps, function(ep, idx)
                    local t = ep.timeout or plan_timeout
                    local inner = string.format(
                        "ignore_early_media=false,sip_enable_soa=false,call_timeout=%d," ..
                        "sip_h_X-PBX-Dest=%s,%s",
                        t, ep.ip, session_timer.BRIDGE_OPTS)
                    local ds = dialstring.bridge(inner, bridge_did, sbc_proxy_ip)
                    freeswitch.consoleLog("INFO", string.format(
                        "[%s] Trunk failover attempt %d/%d -> PBX %s (timeout=%ds): %s\n",
                        uuid, idx, #eps, ep.ip, t, ds))
                    return ds
                end)
            end

            -- Bridge result across all endpoints. originate_disposition is the
            -- authoritative success/failure indicator.
            local disposition = get_var("originate_disposition", "")
            if disposition ~= "" and disposition ~= "SUCCESS" then
                freeswitch.consoleLog("WARNING", string.format(
                    "[%s] Trunk route_plan delivery failed across %d endpoint(s): disposition=%s last_cause=%s\n",
                    uuid, #eps, disposition, get_var("last_bridge_hangup_cause", "")))
            end
            return
        end

        -- route_plan present but NO authorized endpoints survived validation.
        -- Fail safe to the legacy single-endpoint bridge below (never drop the
        -- call because of a bad plan).
        freeswitch.consoleLog("WARNING", string.format(
            "[%s] route_plan for trunk %s had no authorized endpoints — falling back to legacy single-endpoint bridge\n",
            uuid, tostring(trunk_id)))
    end

    -- ========================================================================
    -- LEGACY single-endpoint bridge (no route_plan). UNCHANGED — byte-for-byte
    -- the prior behavior: bridge to the FIRST authorized endpoint IP.
    -- ========================================================================
    -- Build dial string to customer PBX through Kamailio SBC.
    -- Same pattern as RCF: FS -> Kamailio (sbc_proxy_ip:5060) -> PBX.
    -- X-PBX-Dest header tells Kamailio where to relay the call.
    local pbx_ip = endpoint_ips[1]

    set_var("sip_h_X-PBX-Dest", pbx_ip)

    -- Inner bridge {} options: SOA off (carrier interop) + call_timeout +
    -- the shared RFC 4028 session-timer fragment. dialstring wraps the
    -- common sofia/external skeleton — byte-for-byte the prior inline copy.
    local inner = "ignore_early_media=false,sip_enable_soa=false,call_timeout=60," ..
        session_timer.BRIDGE_OPTS
    local dial_string = dialstring.bridge(inner, bridge_did, sbc_proxy_ip)

    freeswitch.consoleLog("INFO", string.format(
        "[%s] Trunk inbound bridge (via SBC): %s X-PBX-Dest=%s\n",
        uuid, dial_string, pbx_ip
    ))

    session:execute("bridge", dial_string)

    -- Check bridge result. originate_disposition is the authoritative
    -- success/failure indicator ("SUCCESS" on connect, a failure cause
    -- otherwise). bridge_result is NOT a real variable and is never used.
    local disposition = get_var("originate_disposition", "")
    if disposition ~= "" and disposition ~= "SUCCESS" then
        freeswitch.consoleLog("WARNING", string.format(
            "[%s] Trunk inbound bridge failed: disposition=%s last_cause=%s\n",
            uuid, disposition, get_var("last_bridge_hangup_cause", "")
        ))
    end
end
