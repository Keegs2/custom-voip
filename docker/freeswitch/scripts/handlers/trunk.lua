-- handlers/trunk.lua — SIP Trunk inbound handler (RCF-V1)
--
-- Extracted (behavior-preserving) from inbound_router.lua's `product_type ==
-- "trunk"` branch. Routes an inbound DID that belongs to a customer SIP trunk
-- to that customer's PBX: look up the trunk's authorized endpoint IP(s) and
-- bridge to the first one through the Kamailio SBC (X-PBX-Dest tells Kamailio
-- where to relay).
--
-- NOTE (distinct script): outbound trunk calls FROM customer PBXs are handled
-- by the top-level trunk_outbound.lua, not this file.
--
-- ctx fields consumed:
--   session, get_var, set_var, hangup
--   uuid, normalized_did, trunk_id, caller_id_number
--   sbc_proxy_ip
--   db                                       — db_client (endpoint IP lookup)
--   dialstring, session_timer                — lib modules
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

    -- SIP Trunk inbound — route call to customer's PBX
    -- Look up the customer's authorized IP(s) and bridge to their PBX
    freeswitch.consoleLog("DEBUG", string.format(
        "[%s] Trunk inbound: trunk_id=%s did=%s\n",
        uuid, tostring(trunk_id), normalized_did
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
    else
        -- Media anchoring and ringback (same as RCF)
        set_var("proxy_media", "true")
        set_var("ringback", "%(2000,4000,440,480)")
        set_var("transfer_ringback", "%(2000,4000,440,480)")
        set_var("hangup_after_bridge", "true")
        set_var("continue_on_fail", "true")

        -- Caller ID: pass the original caller through to the PBX
        local original_caller = get_var("sip_from_user", caller_id)
        set_var("effective_caller_id_number", original_caller)

        -- Build dial string to customer PBX through Kamailio SBC
        -- Same pattern as RCF: FS -> Kamailio (sbc_proxy_ip:5060) -> PBX
        -- X-PBX-Dest header tells Kamailio where to relay the call
        local bridge_did = normalized_did:gsub("^%+", "")
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

        -- Mark as lua-routed
        set_var("lua_routed", "true")

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
end
