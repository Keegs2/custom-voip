-- handlers/rcf.lua — Remote Call Forwarding inbound handler (RCF-V1)
--
-- Extracted (behavior-preserving) from inbound_router.lua's `product_type ==
-- "rcf"` branch as part of the Phase 2 thin-dispatcher split. The dispatcher
-- resolves the DID, sets the CDR channel vars, builds a ctx, and calls
-- handle(ctx); all RCF-specific routing lives here.
--
-- Media: DEFAULT media mode. The RCF bridge dial strings do NOT set proxy_media
-- (only the trunk path does). This is load-bearing for the carrier audio path
-- after the Cloud-NAT fix (CLAUDE.md "No proxy_media in RCF path").
--
-- Bridge: 4-attempt SBC × carrier failover (SBC-1/SBC-2 × primary/secondary),
-- each guarded by a cached TCP reachability pre-check — see lib/sbc.lua.
--
-- ctx fields consumed (set up by inbound_router.lua):
--   session, get_var, set_var, hangup       — session + helpers
--   uuid, normalized_did, forward_to,        — call/routing identity
--     ring_timeout, pass_caller_id, routing,
--     original_caller_number, original_caller_name, traffic_grade
--   to_10digit, normalize_did                — e164 helpers (bound in dispatcher)
--   external_sip_ip, sbc_proxy_ip,           — env-derived addressing
--     sbc_proxy_ip_failover, bridge_progress_timeout
--   get_domain                               — local-extension domain resolver
--   sbc, dialstring, caller_id, session_timer-- lib modules (loaded by dispatcher)
--
-- `freeswitch` is the mod_lua global (available to loadfile'd chunks).

return function(ctx)
    local session = ctx.session
    local get_var = ctx.get_var
    local set_var = ctx.set_var
    local hangup = ctx.hangup
    local uuid = ctx.uuid
    local normalized_did = ctx.normalized_did
    local forward_to = ctx.forward_to
    local ring_timeout = ctx.ring_timeout
    local pass_caller_id = ctx.pass_caller_id
    local routing = ctx.routing
    local original_caller_number = ctx.original_caller_number
    local original_caller_name = ctx.original_caller_name
    local traffic_grade = ctx.traffic_grade
    local to_10digit = ctx.to_10digit
    local normalize_did = ctx.normalize_did
    local external_sip_ip = ctx.external_sip_ip
    local sbc_proxy_ip = ctx.sbc_proxy_ip
    local sbc_proxy_ip_failover = ctx.sbc_proxy_ip_failover
    local bridge_progress_timeout = ctx.bridge_progress_timeout
    local sbc = ctx.sbc
    local dialstring = ctx.dialstring
    local caller_id = ctx.caller_id
    local session_timer = ctx.session_timer

    -- Helper: Check if forward_to is a local extension (4 digits, 10xx).
    local function is_local_extension(number)
        if not number then return false end
        return number:match("^10%d%d$") ~= nil
    end

    -- Remote Call Forwarding - Bridge to destination
    -- RCF terminates through the primary carrier (TC4 Dallas).
    -- Kamailio sets X-Inbound-TC header for logging/Homer visibility, but
    -- outbound carrier selection is fixed to TC4 until all trunk groups are
    -- provisioned for our IPs on the Bandwidth side.
    -- To enable trunk-affinity routing later, read X-Inbound-TC and map to carrier:
    --   local inbound_tc = get_var("sip_h_X-Inbound-TC", ""):match("^%s*(.-)%s*$") or ""
    --   if inbound_tc == "tc1" then carrier = "tc1" elseif inbound_tc == "tc2" then carrier = "tc2" end
    local inbound_tc = get_var("sip_h_X-Inbound-TC", "")

    -- Use the actual SIP Call-ID from the inbound INVITE for X-CID correlation.
    -- The uuid is FreeSWITCH's internal session ID which differs from the SIP Call-ID
    -- that Homer/HEP captures on the A-leg. Using sip_call_id lets us correlate
    -- A-leg and B-leg in Homer. Fallback to uuid if sip_call_id is not set.
    local sip_call_id = session:getVariable("sip_call_id") or uuid
    inbound_tc = inbound_tc:match("^%s*(.-)%s*$") or ""
    local carrier = "primary"  -- TC4 only — do not change until Bandwidth provisions all TCs
    freeswitch.consoleLog("INFO", string.format(
        "[inbound_router] Routing via carrier=%s (inbound_tc=%s, product: rcf, traffic_grade: %s)\n",
        carrier, inbound_tc, traffic_grade
    ))

    local is_local_forward = is_local_extension(forward_to)

    -- Check for test mode
    local test_mode = os.getenv("TEST_MODE")
    if test_mode == "true" and not is_local_forward then
        freeswitch.consoleLog("INFO", "[" .. uuid .. "] TEST MODE: Would forward to " .. forward_to .. "\n")
        pcall(function()
            session:answer()
            session:execute("playback", "tone_stream://%(1000,0,600)")
            session:sleep(2000)
            session:hangup("NORMAL_CLEARING")
        end)
        return
    end

    -- Set bridge parameters
    set_var("forward_to", forward_to)
    set_var("call_timeout", tostring(ring_timeout))

    -- Media: DEFAULT media mode (FS stays in the RTP path as B2BUA). The RCF
    -- path does NOT set proxy_media — that was removed after the Cloud-NAT fix
    -- resolved the real audio issue (CLAUDE.md). ringback is the local tone
    -- played on the A-leg while the B-leg rings.
    set_var("ringback", "%(2000,4000,440,480)")
    set_var("transfer_ringback", "%(2000,4000,440,480)")

    local dial_string

    -- ================================================================
    -- Caller ID handling: FusionPBX-style approach (setVariable, not
    -- dial-string overrides). SIP headers produced (after Kamailio):
    --   From: <sip:RCF_DID@public_ip>           (via outbound_caller_id_number)
    --   P-Asserted-Identity: <sip:orig@ip>       (via X-Original-CID -> Kamailio)
    --   Remote-Party-ID: <sip:orig@ip>           (via sip_h_Remote-Party-ID)
    --   Diversion: <sip:RCF_DID@ip>;reason=unconditional
    -- ================================================================

    -- Set outbound caller ID for carrier authorization (SIP From header).
    -- Bandwidth requires the RCF DID in 10-digit format for termination auth.
    local outbound_did = to_10digit(normalized_did)
    session:setVariable("outbound_caller_id_number", outbound_did)
    session:setVariable("outbound_caller_id_name", outbound_did)

    local outbound_original_cid = to_10digit(original_caller_number)
    -- E.164 versions for SIP identity headers (PAI, RPID, Diversion)
    -- Carriers require +1 prefix per E.164; bare 10-digit leaks into PAI otherwise
    local e164_original_cid = normalize_did(original_caller_number)
    local e164_did = normalize_did(normalized_did)
    if pass_caller_id then
        -- Preserve original caller ID so the called party sees who is calling
        session:setVariable("effective_caller_id_number", outbound_original_cid)
        session:setVariable("effective_caller_id_name", original_caller_name)
    else
        -- Override: called party sees the RCF DID, not the original caller
        session:setVariable("effective_caller_id_number", outbound_did)
        session:setVariable("effective_caller_id_name", outbound_did)
    end

    -- Diversion header indicates the call was forwarded and from which number
    session:setVariable("sip_h_Diversion", caller_id.diversion(outbound_did, external_sip_ip))

    -- X-Original-CID: Kamailio reads this to build P-Asserted-Identity
    -- Uses E.164 (+1XXXXXXXXXX) format. When pass_caller_id=true, this is the
    -- original caller's number; when false, it's the RCF DID itself.
    if pass_caller_id then
        session:setVariable("sip_h_X-Original-CID", e164_original_cid)
    else
        session:setVariable("sip_h_X-Original-CID", e164_did)
    end

    -- X-Original-CID-Name: Display name for P-Asserted-Identity
    -- Uses the RCF line name configured in the portal (e.g. "Main Office")
    local rcf_name = routing.rcf_name
    if rcf_name and rcf_name ~= "" then
        session:setVariable("sip_h_X-Original-CID-Name", rcf_name)
    end

    freeswitch.consoleLog("INFO", string.format(
        "[inbound_router] CID setup (FusionPBX-style): outbound_cid=%s effective_cid=%s original=%s pass=%s\n",
        normalized_did,
        pass_caller_id and original_caller_number or normalized_did,
        original_caller_number,
        tostring(pass_caller_id)
    ))

    if is_local_forward then
        -- LOCAL EXTENSION ROUTING
        -- Forward to a registered user (e.g., 1001, 1002, 1003)
        local domain = ctx.get_domain()
        set_var("carrier_used", "local")

        -- Build dial string for local user (CID handling is simpler for local)
        dial_string = string.format(
            "{ignore_early_media=false,call_timeout=%d}user/%s@%s",
            ring_timeout, forward_to, domain
        )

        freeswitch.consoleLog("INFO", string.format(
            "[%s] RCF Bridge (LOCAL): %s -> user/%s@%s\n",
            uuid, normalized_did, forward_to, domain
        ))
    else
        -- PSTN/CARRIER ROUTING via Kamailio proxy (no gateway syntax)
        -- Using sofia/external/dest@proxy ensures the outbound INVITE uses
        -- ext-sip-ip (public IP from EXTERNAL_SIP_IP) in Via, Contact, and SDP.
        -- The internal profile does NOT apply ext-sip-ip to outbound calls.
        -- X-Carrier header tells Kamailio which Bandwidth IP to use.
        set_var("carrier_used", "carrier_" .. carrier)

        -- Remote-Party-ID: backup CID presentation mechanism for carriers
        -- that don't support P-Asserted-Identity. Uses E.164 format.
        if pass_caller_id then
            session:setVariable("sip_h_Remote-Party-ID",
                caller_id.remote_party_id(e164_original_cid, external_sip_ip))
        else
            session:setVariable("sip_h_Remote-Party-ID",
                caller_id.remote_party_id(e164_did, external_sip_ip))
        end

        -- Export caller ID to B-leg for Bandwidth From header auth.
        pcall(function() session:execute("export", "origination_caller_id_number=" .. outbound_did) end)
        pcall(function() session:execute("export", "origination_caller_id_name=" .. outbound_did) end)

        freeswitch.consoleLog("INFO", string.format(
            "[%s] RCF Bridge (PSTN): %s -> %s via proxy (carrier=%s, pass_cid=%s, failover_sbc=%s)\n",
            uuid, normalized_did, forward_to, carrier, tostring(pass_caller_id), sbc_proxy_ip_failover
        ))
    end

    -- Ensure clean call teardown when bridge ends
    set_var("hangup_after_bridge", "true")
    -- Set bridge failure handling for failover
    set_var("continue_on_fail", "true")
    -- Mark that the DID was found and Lua is handling routing
    -- This prevents the dialplan fallback 404 from masking bridge failures
    set_var("lua_routed", "true")

    -- RFC 4028 session timers: export to B-leg so mod_sofia includes
    -- Session-Expires and Min-SE in the outbound INVITE. set_var() only sets
    -- the A-leg; export marks the variable for propagation to the B-leg.
    -- (exports sip_session_timeout=1800, sip_minimum_session_expires=90,
    -- enable_timer=true — same three the prior inline copy emitted.)
    session_timer.export(session)

    -- ================================================================
    -- Per-DID concurrent call limit (mod_hash, no Redis needed)
    -- ================================================================
    -- max_channels=0 means unlimited (default). When set >0, FreeSWITCH
    -- tracks concurrent calls per DID using the in-memory hash backend.
    -- If the limit is reached, the call is rejected with 486 Busy Here.
    local max_concurrent = tonumber(routing.max_channels) or 0
    if max_concurrent > 0 then
        freeswitch.consoleLog("INFO", string.format(
            "[inbound_router] Checking limit: DID %s, max %d concurrent\n",
            normalized_did, max_concurrent
        ))
        session:execute("limit", "hash inbound " .. normalized_did .. " " .. tostring(max_concurrent) .. " !USER_BUSY")
        -- If limit exceeded, session is already hung up with 486 Busy
        -- Check if session is still active before continuing
        if not session:ready() then
            freeswitch.consoleLog("WARNING", string.format(
                "[inbound_router] DID %s rejected — %d concurrent call limit reached\n",
                normalized_did, max_concurrent
            ))
            return
        end
    end

    -- ================================================================
    -- SBC + Carrier failover: 4 bridge attempts for PSTN routing
    -- ================================================================
    -- For local extensions, there is only the single dial_string built above.
    -- For PSTN, we try all combinations of SBC (SBC-1/SBC-2) and
    -- carrier (primary/secondary) before giving up:
    --   1. SBC-1 + primary carrier   (Dallas)
    --   2. SBC-2 + primary carrier   (Dallas)
    --   3. SBC-1 + secondary carrier (LA)
    --   4. SBC-2 + secondary carrier (LA)
    --
    -- Channel variables (outbound_caller_id_*, effective_caller_id_*,
    -- sip_h_Diversion, sip_h_X-Original-CID, sip_h_Remote-Party-ID)
    -- and exported origination_caller_id_* persist on the session across
    -- all bridge attempts. Only X-Carrier and the SBC IP change per attempt.
    -- ================================================================

    if is_local_forward then
        -- Local extension: single bridge attempt (no SBC/carrier failover)
        pcall(function()
            session:execute("bridge", dial_string)
        end)
    else
        -- PSTN: 4-attempt SBC + carrier failover loop (lib/sbc.lua)
        local bridge_attempts = {
            { sbc = sbc_proxy_ip,          carrier = "primary",   label = "SBC-1 + primary carrier (Dallas)" },
            { sbc = sbc_proxy_ip_failover, carrier = "primary",   label = "SBC-2 + primary carrier (Dallas)" },
            { sbc = sbc_proxy_ip,          carrier = "secondary", label = "SBC-1 + secondary carrier (LA)" },
            { sbc = sbc_proxy_ip_failover, carrier = "secondary", label = "SBC-2 + secondary carrier (LA)" },
        }

        -- Per-attempt dial string. progress_timeout bounds carrier PDD: the
        -- attempt fails over only if NO provisional (180/183) arrives within
        -- N seconds; once ringing starts the call may ring up to call_timeout.
        -- The session-timer fragment is shared via session_timer.BRIDGE_OPTS,
        -- and the sofia/external skeleton via dialstring.bridge — byte-for-byte
        -- the string the prior inline copy produced.
        local function build_dial(attempt)
            local inner = string.format(
                "ignore_early_media=false,progress_timeout=%d,call_timeout=%d,sip_h_X-Carrier=%s,sip_h_X-CID=%s,%s",
                bridge_progress_timeout,
                ring_timeout,
                attempt.carrier,
                sip_call_id,
                session_timer.BRIDGE_OPTS
            )
            return dialstring.bridge(inner, forward_to, attempt.sbc)
        end

        sbc.failover_bridge({
            session = session,
            get_var = get_var,
            set_var = set_var,
            uuid = uuid,
            did = normalized_did,
            dest = forward_to,
            attempts = bridge_attempts,
            build_dial = build_dial,
        })
    end

    -- Final result check (covers both local and PSTN paths).
    -- originate_disposition == "SUCCESS" means a B-leg connected at some point;
    -- the call has since completed normally via hangup_after_bridge.
    local disposition = get_var("originate_disposition", "")
    local last_bridge_hangup = get_var("last_bridge_hangup_cause", "")

    -- If NO attempt ever connected, hangup with NORMAL_TEMPORARY_FAILURE (SIP 503)
    -- instead of falling through to the dialplan's 404 which would mask the real
    -- issue. The DID WAS found -- the carrier bridge just couldn't complete.
    -- NOTE: a session that is no longer ready but DID connect (disposition
    -- SUCCESS) is a normal completed call, not a failure.
    if disposition ~= "SUCCESS" then
        freeswitch.consoleLog("WARNING", string.format(
            "[%s] All bridges failed for RCF DID %s -> %s (disposition=%s last_cause=%s)\n",
            uuid, normalized_did, forward_to, disposition, last_bridge_hangup
        ))
        hangup("NORMAL_TEMPORARY_FAILURE",
            "[" .. uuid .. "] RCF bridge failed, returning 503 (DID was found, carrier unreachable)")
        return
    end
end
