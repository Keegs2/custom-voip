-- handlers/ucaas.lua — UCaaS extension inbound handler (unified)
--
-- An inbound DID that resolves (only) to a UCaaS extension
-- (extensions.assigned_did) is handled here. Two modes:
--
--   1. NO ring plan (extensions.ring_plan is NULL)  -> LEGACY single bridge to
--      the extension identity (verto.rtc/...|user/...), and on bridge
--      failure/no-answer a self-contained voicemail recording flow. This path is
--      byte-for-byte behavior-preserving and pinned by tests/lua/spec/
--      ucaas_inbound_spec.lua. A SUCCESSFULLY answered call does NOT record
--      voicemail (originate_disposition is the authoritative bridge result;
--      bridge_result is NOT a real channel var).
--
--   2. RING PLAN present (extensions.ring_plan JSONB, parsed by
--      db_client.lookup_extension_did into routing.ring_plan) -> FIND-ME /
--      FOLLOW-ME multi-leg ring:
--        { strategy = "sequential"|"parallel",
--          ring_timeout = <int s>,                  -- per-leg (seq) / overall (par)
--          legs = { { to=<E.164 or ext>, timeout?=<int> }, ... },
--          fallback = { type="voicemail"|"forward"|"hangup", to?=<E.164> } }
--      On all legs failing/no-answer the fallback runs. The backend owns the
--      ring_plan column; this handler only READS it.
--
-- ctx fields consumed:
--   session, get_var, set_var, hangup
--   uuid, normalized_did, customer_id, routing (extension, display_name, ring_plan)
--   original_caller_number, original_caller_name
--   get_domain, to_10digit, normalize_did
--   external_sip_ip, sbc_proxy_ip
--   dialstring, caller_id, session_timer        (shared lib modules)
--
-- `freeswitch` is the mod_lua global.

-- POSIX shell single-quote escape: wrap in '...' and turn each ' into '\''.
-- Same helper used by lib/vm_notify.lua / lib/rec_notify.lua. Defense-in-depth
-- for the one os.execute() shell-out below (the vm_dir components are already
-- int customer_id / digit-validated extension, but never hand un-quoted
-- interpolation to a shell).
local function shq(s)
    return "'" .. tostring(s or ""):gsub("'", "'\\''") .. "'"
end

return function(ctx)
    local session = ctx.session
    local get_var = ctx.get_var
    local set_var = ctx.set_var
    local hangup = ctx.hangup
    local uuid = ctx.uuid
    local normalized_did = ctx.normalized_did
    local customer_id = ctx.customer_id
    local routing = ctx.routing
    local original_caller_number = ctx.original_caller_number
    local original_caller_name = ctx.original_caller_name

    -- UCaaS Extension DID - Route inbound call to user's extension
    local ext = routing.extension
    local display = routing.display_name or ("Extension " .. ext)
    local ring_plan = routing.ring_plan

    -- Multi-tenant: build customer-specific domain from customer_id.
    -- Extensions register under customer_{id}.voiceplatform.local (e.g.,
    -- 100@customer_13.voiceplatform.local). The global domain (voiceplatform.local)
    -- will NOT resolve the user because mod_xml_curl scopes lookups by the
    -- customer domain extracted from the SIP request.
    local base_domain = ctx.get_domain()
    local customer_domain = string.format("customer_%s.%s", tostring(customer_id), base_domain)

    -- Real SIP Call-ID for Homer A/B-leg correlation on carrier (PSTN) legs
    -- (mirrors handlers/rcf.lua). Falls back to the FS session uuid.
    local sip_call_id = session:getVariable("sip_call_id") or uuid

    freeswitch.consoleLog("INFO", string.format(
        "[%s] UCaaS inbound: DID %s -> ext %s (%s) @ %s%s\n",
        uuid, normalized_did, ext, display, customer_domain,
        ring_plan and " [ring_plan present]" or ""
    ))

    -- Common A-leg setup shared by BOTH paths (ring tone, teardown, caller ID).
    -- NOTE: proxy_media is intentionally NOT set here. It is set ONLY on the
    -- legacy internal-extension path below. The find-me/follow-me path can ring
    -- PSTN carrier legs, and the hard-won CLAUDE.md lesson is that the carrier
    -- media path must use DEFAULT media (no proxy_media) — proxy_media there
    -- reintroduced one-way audio pre-Cloud-NAT-fix.
    set_var("ringback", "%(2000,4000,440,480)")
    set_var("transfer_ringback", "%(2000,4000,440,480)")
    set_var("hangup_after_bridge", "true")
    set_var("continue_on_fail", "true")

    -- Preserve original caller ID for the called party to see. For PSTN legs the
    -- carrier From is overridden to the UCaaS DID by setup_pstn_caller_id()
    -- below, but the *presented* identity (effective_caller_id) stays the real
    -- caller (find-me passes the caller's CID through).
    set_var("effective_caller_id_number", original_caller_number)
    set_var("effective_caller_id_name", original_caller_name)

    -- Mark as lua-routed so the dialplan fallback doesn't return 404
    set_var("lua_routed", "true")

    -- Authoritative bridge-result check (CLAUDE.md): a leg connected iff
    -- originate_disposition == "SUCCESS". bridge_result is NOT a real channel
    -- variable (reading it always returns "") — using it would wrongly drop an
    -- ANSWERED call into voicemail.
    local function bridged_ok()
        return get_var("originate_disposition", "") == "SUCCESS"
    end

    -- ========================================================================
    -- Voicemail recorder (factored verbatim from the legacy inline flow so its
    -- effects are byte-for-byte identical). Used by the legacy no-answer path
    -- AND by the ring-plan fallback type "voicemail".
    -- ========================================================================
    local function record_voicemail()
        local last_bridge_hangup = get_var("last_bridge_hangup_cause", "")
        freeswitch.consoleLog("INFO", string.format(
            "[%s] UCaaS bridge failed (cause=%s), recording voicemail for ext %s@%s\n",
            uuid, last_bridge_hangup, ext, customer_domain
        ))
        pcall(function()
            if not session:ready() then return end
            session:answer()
            session:sleep(500)

            -- "The person at extension <ext> is not available."
            -- Three ascending tones = universal "not available" signal
            session:execute("playback", "tone_stream://%(200,80,500);%(200,80,650);%(200,0,800)")
            session:sleep(800)

            -- "Please leave a message after the tone."
            -- Two short tones = "get ready"
            session:execute("playback", "tone_stream://%(150,100,700);%(150,0,700)")
            session:sleep(600)

            -- BEEP — start recording
            session:execute("playback", "tone_stream://%(1000,0,640)")

            -- Record to mod_voicemail's storage directory so *97 retrieval works.
            -- Format: /var/lib/freeswitch/voicemail/<domain>/<ext>/msg_<uuid>.wav
            local vm_dir = string.format(
                "/var/lib/freeswitch/voicemail/%s/%s",
                customer_domain, ext
            )
            session:execute("set", "playback_terminators=#")
            os.execute("mkdir -p " .. shq(vm_dir))
            local vm_file = string.format("%s/msg_%s.wav", vm_dir, uuid)

            freeswitch.consoleLog("INFO", string.format(
                "[%s] Recording voicemail to %s (max 300s, silence detect 200/3)\n",
                uuid, vm_file
            ))

            -- record <file> <max_seconds> <silence_threshold> <silence_hits>
            session:execute("record", vm_file .. " 300 200 3")

            -- Confirmation beep
            if session:ready() then
                session:execute("playback", "tone_stream://%(100,0,800)")
                session:sleep(300)
                session:execute("playback", "tone_stream://%(200,80,600);%(200,0,400)")
            end

            freeswitch.consoleLog("INFO", string.format(
                "[%s] Voicemail recorded: %s\n", uuid, vm_file
            ))

            -- Notify the API so it uploads the spooled WAV to object storage and
            -- creates the voicemails row. Fire-and-forget, fully fail-open: a
            -- notify failure never affects the call. Skipped cleanly when
            -- API_HOST is unset (unit harness).
            if os.getenv("API_HOST") then
                local notify_chunk = loadfile(
                    "/usr/local/freeswitch/scripts/lib/vm_notify.lua")
                if notify_chunk then
                    local okmod, vm_notify = pcall(notify_chunk)
                    if okmod and vm_notify then
                        local spool_path = vm_file:gsub(
                            "^/var/lib/freeswitch/voicemail", "/media/spool/voicemail")
                        local dur_ms = tonumber(ctx.get_var("record_ms", ""))
                        if not dur_ms then
                            local secs = tonumber(ctx.get_var("record_seconds", ""))
                            if secs then dur_ms = secs * 1000 end
                        end
                        pcall(vm_notify.notify, {
                            extension    = ext,
                            customer_id  = customer_id,
                            caller_id    = original_caller_number,
                            caller_name  = original_caller_name,
                            duration_ms  = dur_ms,
                            storage_path = spool_path,
                        })
                    end
                end
            end
        end)
    end

    -- ========================================================================
    -- PATH 1 — LEGACY single-extension bridge (no ring plan).  UNCHANGED.
    -- ========================================================================
    if type(ring_plan) ~= "table"
        or type(ring_plan.legs) ~= "table"
        or #ring_plan.legs == 0 then

        -- proxy_media is fine here: this leg only ever targets an internal
        -- verto/SIP extension (the carrier-media caveat does not apply).
        set_var("proxy_media", "true")

        -- Verto (WebRTC) users don't appear in sofia registrations — they
        -- connect via mod_verto's WebSocket. "user/" does a sofia lookup and
        -- fails. "verto.rtc/" reaches the Verto endpoint directly. Fall back to
        -- "user/" for any future SIP-registered extensions.
        local dial_string = string.format(
            "{ignore_early_media=false,call_timeout=30}verto.rtc/%s@%s|user/%s@%s",
            ext, customer_domain, ext, customer_domain
        )

        freeswitch.consoleLog("INFO", string.format(
            "[%s] UCaaS Bridge: %s -> verto.rtc/%s@%s (fallback user/)\n",
            uuid, normalized_did, ext, customer_domain
        ))

        pcall(function()
            session:execute("bridge", dial_string)
        end)

        if not bridged_ok() then
            -- Extension unavailable (not registered, busy, rejected, etc.)
            record_voicemail()
        end
        return
    end

    -- ========================================================================
    -- PATH 2 — FIND-ME / FOLLOW-ME ring plan.
    -- ========================================================================
    local strategy = ring_plan.strategy
    if strategy ~= "parallel" then strategy = "sequential" end   -- default sequential
    local plan_timeout = tonumber(ring_plan.ring_timeout) or 30
    local legs = ring_plan.legs
    local fb = (type(ring_plan.fallback) == "table") and ring_plan.fallback or {}
    local fb_type = fb.type or "voicemail"

    -- Classify a leg destination: a short digit string (1-6 digits, no leading
    -- "+") is an internal EXTENSION; anything with a "+" or 10+ digits is a
    -- PSTN/E.164 number routed out the carrier. (Matches the builder's
    -- "E.164 or 3-6 digit ext" contract — CALL_FLOW_BUILDER_PLAN §6.1.)
    local function leg_is_extension(to)
        if not to or to == "" then return false end
        local s = tostring(to)
        if s:match("^%+") then return false end
        local digits = s:gsub("[^%d]", "")
        if digits == "" then return false end
        return #digits <= 6
    end

    -- Extension leg dial string (single sequential bridge): Verto first, SIP
    -- user/ fallback — the same proven string as the legacy path. call_timeout
    -- caps this leg's total ring time so a no-answer advances to the next leg.
    local function ext_dialstring(to, leg_timeout)
        return string.format(
            "{ignore_early_media=false,call_timeout=%d}verto.rtc/%s@%s|user/%s@%s",
            leg_timeout, to, customer_domain, to, customer_domain
        )
    end

    -- PSTN/carrier leg dial string (single sequential bridge) via the SBC proxy,
    -- using lib/dialstring + lib/session_timer exactly like handlers/rcf.lua.
    -- IMPORTANT: we use call_timeout (NOT progress_timeout) here. For find-me we
    -- WANT to bound total time-to-answer per leg and then advance — i.e. ring
    -- the cell for N seconds, then move on. (The RCF carrier loop deliberately
    -- avoids originate/call_timeout because there a still-ringing forwarded call
    -- must not be cancelled; find-me is the opposite requirement.)
    local function pstn_dialstring(to, leg_timeout)
        local dest = ctx.to_10digit(ctx.normalize_did(to))
        local inner = string.format(
            "ignore_early_media=false,call_timeout=%d,sip_h_X-Carrier=primary,sip_h_X-CID=%s,%s",
            leg_timeout, sip_call_id, ctx.session_timer.BRIDGE_OPTS
        )
        return ctx.dialstring.bridge(inner, dest, ctx.sbc_proxy_ip)
    end

    local function build_leg(to, leg_timeout)
        if leg_is_extension(to) then
            return ext_dialstring(to, leg_timeout)
        end
        return pstn_dialstring(to, leg_timeout)
    end

    -- One-time carrier caller-ID/identity setup for PSTN legs, mirroring the
    -- handlers/rcf.lua pass_caller_id=true policy. From/auth = the UCaaS DID
    -- (10-digit, Bandwidth requires); presented identity = the original caller.
    local function setup_pstn_caller_id()
        local outbound_did = ctx.to_10digit(normalized_did)
        local e164_original = ctx.normalize_did(original_caller_number)
        -- SIP From / carrier termination auth = the forwarding (UCaaS) DID.
        session:setVariable("outbound_caller_id_number", outbound_did)
        session:setVariable("outbound_caller_id_name", outbound_did)
        -- Diversion: call was forwarded from the UCaaS DID.
        session:setVariable("sip_h_Diversion",
            ctx.caller_id.diversion(outbound_did, ctx.external_sip_ip))
        -- X-Original-CID -> Kamailio builds P-Asserted-Identity (E.164 caller).
        session:setVariable("sip_h_X-Original-CID", e164_original)
        -- Remote-Party-ID: backup CID for carriers without PAI support.
        session:setVariable("sip_h_Remote-Party-ID",
            ctx.caller_id.remote_party_id(e164_original, ctx.external_sip_ip))
        -- Export From auth to the B-legs + RFC 4028 session timers.
        pcall(function() session:execute("export", "origination_caller_id_number=" .. outbound_did) end)
        pcall(function() session:execute("export", "origination_caller_id_name=" .. outbound_did) end)
        ctx.session_timer.export(session)
    end

    -- SEQUENTIAL: ring each leg in order, each for up to its own timeout (or the
    -- plan ring_timeout), advancing on no-answer/busy/decline. One bridge per
    -- leg so the per-leg call_timeout is honored exactly; continue_on_fail=true
    -- returns control here after a failed leg, hangup_after_bridge=true tears the
    -- call down cleanly once a leg answers.
    local function ring_sequential()
        for idx, leg in ipairs(legs) do
            if not session:ready() then return end   -- caller hung up — stop
            local to = leg and leg.to
            if to and to ~= "" then
                local leg_timeout = tonumber(leg.timeout) or plan_timeout
                local ds = build_leg(to, leg_timeout)
                freeswitch.consoleLog("INFO", string.format(
                    "[%s] FMFM sequential leg %d/%d -> %s (timeout=%ds, %s)\n",
                    uuid, idx, #legs, tostring(to), leg_timeout,
                    leg_is_extension(to) and "extension" or "pstn"
                ))
                pcall(function() session:execute("bridge", ds) end)
                if bridged_ok() then return end       -- answered — done
            end
        end
    end

    -- PARALLEL: ring all legs simultaneously up to the overall ring_timeout via
    -- a single comma-separated dial string. An extension contributes TWO
    -- simultaneous channels (verto.rtc + user) rather than the sequential
    -- "verto|user" form, so the dial string never mixes "," and "|" (that
    -- mixing has ambiguous grouping in FreeSWITCH). A PSTN leg contributes one
    -- carrier channel with its X-Carrier/X-CID/session-timer vars in a per-leg
    -- [..] block. Optional per-leg timeout becomes a per-channel [leg_timeout=N].
    local function ring_parallel()
        local endpoints = {}
        for _, leg in ipairs(legs) do
            local to = leg and leg.to
            if to and to ~= "" then
                local lt = tonumber(leg.timeout)
                if leg_is_extension(to) then
                    local pfx = lt and ("[leg_timeout=" .. lt .. "]") or ""
                    endpoints[#endpoints + 1] = pfx .. string.format("verto.rtc/%s@%s", to, customer_domain)
                    endpoints[#endpoints + 1] = pfx .. string.format("user/%s@%s", to, customer_domain)
                else
                    local dest = ctx.to_10digit(ctx.normalize_did(to))
                    local lv = {}
                    if lt then lv[#lv + 1] = "leg_timeout=" .. lt end
                    lv[#lv + 1] = "sip_h_X-Carrier=primary"
                    lv[#lv + 1] = "sip_h_X-CID=" .. sip_call_id
                    lv[#lv + 1] = ctx.session_timer.BRIDGE_OPTS
                    endpoints[#endpoints + 1] = "[" .. table.concat(lv, ",") .. "]" ..
                        string.format("sofia/external/%s@%s:5060", dest, ctx.sbc_proxy_ip)
                end
            end
        end
        if #endpoints == 0 then return end
        local ds = string.format(
            "{ignore_early_media=false,call_timeout=%d}%s",
            plan_timeout, table.concat(endpoints, ",")
        )
        freeswitch.consoleLog("INFO", string.format(
            "[%s] FMFM parallel ringing %d endpoint(s), overall timeout=%ds\n",
            uuid, #endpoints, plan_timeout
        ))
        pcall(function() session:execute("bridge", ds) end)
    end

    -- FALLBACK once all legs fail / no-answer.
    local function execute_fallback()
        if fb_type == "hangup" then
            freeswitch.consoleLog("INFO", string.format(
                "[%s] FMFM all legs failed -> fallback=hangup\n", uuid))
            hangup("NO_ANSWER",
                "[" .. uuid .. "] FMFM ring plan exhausted, fallback=hangup")
            return
        elseif fb_type == "forward" then
            local to = fb.to
            if to and to ~= "" then
                local t = tonumber(fb.timeout) or plan_timeout
                freeswitch.consoleLog("INFO", string.format(
                    "[%s] FMFM all legs failed -> fallback=forward to %s (timeout=%ds)\n",
                    uuid, tostring(to), t))
                -- If the forward target is PSTN and no earlier leg already set
                -- up carrier CID, do it now (idempotent — safe to call again).
                if not leg_is_extension(to) then setup_pstn_caller_id() end
                local ds = build_leg(to, t)
                pcall(function() session:execute("bridge", ds) end)
                if bridged_ok() then return end
                freeswitch.consoleLog("WARNING", string.format(
                    "[%s] FMFM forward fallback to %s also failed (disposition=%s)\n",
                    uuid, tostring(to), get_var("originate_disposition", "")))
                hangup("NORMAL_TEMPORARY_FAILURE",
                    "[" .. uuid .. "] FMFM forward fallback failed, returning 503")
                return
            end
            -- forward configured with no target -> degrade to voicemail.
            freeswitch.consoleLog("WARNING", string.format(
                "[%s] FMFM fallback=forward but no target -> recording voicemail\n", uuid))
            record_voicemail()
            return
        end
        -- "voicemail" (and any unknown type) -> record a message (legacy UX).
        freeswitch.consoleLog("INFO", string.format(
            "[%s] FMFM all legs failed -> fallback=voicemail\n", uuid))
        record_voicemail()
    end

    -- Pre-arm carrier caller-ID once if any leg (or a PSTN forward fallback)
    -- terminates to the carrier. Harmless for all-extension plans (skipped).
    local needs_pstn = false
    for _, leg in ipairs(legs) do
        if leg and leg.to and not leg_is_extension(leg.to) then
            needs_pstn = true
            break
        end
    end
    if not needs_pstn and fb_type == "forward" and fb.to and fb.to ~= ""
        and not leg_is_extension(fb.to) then
        needs_pstn = true
    end
    if needs_pstn then setup_pstn_caller_id() end

    freeswitch.consoleLog("INFO", string.format(
        "[%s] FMFM ring plan: strategy=%s legs=%d ring_timeout=%ds fallback=%s\n",
        uuid, strategy, #legs, plan_timeout, fb_type
    ))

    if strategy == "parallel" then
        ring_parallel()
    else
        ring_sequential()
    end

    -- A leg answered: hangup_after_bridge already tore the call down. Done.
    if bridged_ok() then return end

    -- No leg answered -> run the configured fallback.
    execute_fallback()
end
