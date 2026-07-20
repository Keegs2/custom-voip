-- handlers/teams.lua — Microsoft Teams Direct Routing inbound handler (PSTN -> Teams)
--
-- Reached ONLY when Teams Direct Routing is enabled (TEAMS_DIRECT_ROUTING_ENABLED
-- =true) AND the dialed DID resolves as Teams-enabled (db.lookup_teams_did, gated
-- in inbound_router.lua). When Teams is off, inbound_router never calls this, so
-- RCF/API/trunk/UCaaS behavior is unchanged.
--
-- FLOW: Bandwidth -> Kamailio -> FreeSWITCH (here) -> bridge toward the Teams SIP
-- proxy via the SBC with sip_h_X-Carrier=teams (Kamailio route[TO_TEAMS] does the
-- TLS + SBC-FQDN Contact/Record-Route + +sip.instance interworking) and SRTP toward
-- Teams. FreeSWITCH is the media anchor: RTP on the Bandwidth A-leg, SRTP on the
-- Teams B-leg — it transcodes between them (Teams REQUIRES SRTP; Bandwidth stays
-- RTP). RTP/SRTP flows FS<->Teams directly; Kamailio is signaling-only.
--
-- SBC failover reuses lib/sbc.failover_bridge (SBC-1 then SBC-2, cached TCP
-- pre-check, progress_timeout/session-timer discipline). Teams SIP-proxy failover
-- (proxy1->2->3) is handled inside Kamailio route[TEAMS_FAILURE].
--
-- ctx: same context inbound_router.lua builds for every handler.

return function(ctx)
    local session = ctx.session
    local get_var = ctx.get_var
    local set_var = ctx.set_var
    local hangup = ctx.hangup
    local uuid = ctx.uuid
    local normalized_did = ctx.normalized_did
    local original_caller_number = ctx.original_caller_number
    local original_caller_name = ctx.original_caller_name
    local ring_timeout = ctx.ring_timeout or 30
    local sbc_proxy_ip = ctx.sbc_proxy_ip
    local sbc_proxy_ip_failover = ctx.sbc_proxy_ip_failover
    local bridge_progress_timeout = ctx.bridge_progress_timeout
    local sbc = ctx.sbc
    local dialstring = ctx.dialstring
    local session_timer = ctx.session_timer

    -- SRTP mode toward Teams (env-tunable). Teams REQUIRES SRTP; FS offers its
    -- supported suites (incl. AES_CM_128_HMAC_SHA1_80) when secure media is on.
    local srtp_mode = os.getenv("TEAMS_SRTP_MODE") or "mandatory"

    -- Present the PSTN caller to the Teams user; the DID (E.164) is the callee that
    -- Teams matches to the enterprise-voice user (R-URI, set by the dial string).
    local teams_dest = ctx.normalize_did(normalized_did)          -- +E.164 to Teams
    local caller_e164 = ctx.normalize_did(original_caller_number or "")
    session:setVariable("effective_caller_id_number", ctx.to_10digit(original_caller_number) or original_caller_number)
    session:setVariable("effective_caller_id_name", original_caller_name)
    session:setVariable("sip_h_X-Original-CID", caller_e164)

    -- Real SIP Call-ID for Homer A/B correlation on the Teams B-leg.
    local sip_call_id = session:getVariable("sip_call_id") or uuid

    set_var("carrier_used", "teams")
    set_var("product_type", "teams")
    set_var("ringback", "%(2000,4000,440,480)")
    set_var("transfer_ringback", "%(2000,4000,440,480)")
    set_var("hangup_after_bridge", "true")
    set_var("continue_on_fail", "true")
    set_var("lua_routed", "true")

    -- Test mode: never touch the SBC/Teams (mirror the other handlers).
    if os.getenv("TEST_MODE") == "true" then
        freeswitch.consoleLog("INFO", string.format(
            "[%s] TEAMS TEST MODE: would bridge DID %s toward Teams (srtp=%s)\n",
            uuid, normalized_did, srtp_mode))
        pcall(function()
            session:answer()
            session:execute("playback", "tone_stream://%(1000,0,600)")
            session:sleep(2000)
            session:hangup("NORMAL_CLEARING")
        end)
        return
    end

    -- RFC 4028 session timers exported to the B-leg (same as every outbound path).
    session_timer.export(session)

    freeswitch.consoleLog("INFO", string.format(
        "[%s] TEAMS inbound: DID %s -> Teams (caller=%s, srtp=%s, failover_sbc=%s)\n",
        uuid, normalized_did, tostring(original_caller_number), srtp_mode, sbc_proxy_ip_failover))

    -- Bridge toward Teams via the SBC (X-Carrier=teams -> Kamailio route[TO_TEAMS]).
    -- SRTP is forced on this B-leg so FS's offered SDP carries crypto for Teams.
    local attempts = {
        { sbc = sbc_proxy_ip,          carrier = "teams", label = "SBC-1 -> Teams" },
        { sbc = sbc_proxy_ip_failover, carrier = "teams", label = "SBC-2 -> Teams" },
    }
    local function build_dial(attempt)
        local inner = string.format(
            "ignore_early_media=false,progress_timeout=%d,call_timeout=%d,rtp_secure_media=%s,sip_h_X-Carrier=teams,sip_h_X-CID=%s,%s",
            bridge_progress_timeout, ring_timeout, srtp_mode, sip_call_id,
            session_timer.BRIDGE_OPTS)
        return dialstring.bridge(inner, teams_dest, attempt.sbc)
    end

    if sbc and sbc.failover_bridge then
        sbc.failover_bridge({
            session = session, get_var = get_var, set_var = set_var, uuid = uuid,
            did = normalized_did, dest = teams_dest, attempts = attempts, build_dial = build_dial,
        })
    else
        -- Defensive: lib/sbc unavailable — single primary attempt.
        pcall(function() session:execute("bridge", build_dial(attempts[1])) end)
    end

    local disposition = get_var("originate_disposition", "")
    if disposition ~= "SUCCESS" then
        freeswitch.consoleLog("WARNING", string.format(
            "[%s] TEAMS bridge failed for DID %s (disposition=%s last_cause=%s)\n",
            uuid, normalized_did, disposition, get_var("last_bridge_hangup_cause", "")))
        hangup("NORMAL_TEMPORARY_FAILURE",
            "[" .. uuid .. "] Teams bridge failed, returning 503 (DID found, Teams unreachable)")
        return
    end
end
