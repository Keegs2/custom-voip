-- handlers/ucaas.lua — UCaaS extension inbound handler (RCF-V1)
--
-- Extracted (behavior-preserving) from inbound_router.lua's `product_type ==
-- "ucaas"` branch. An inbound DID that resolves (only) to a UCaaS extension
-- (extensions.assigned_did) routes to that extension via the
-- verto.rtc/...|user/... dial string; on bridge failure/no-answer it falls
-- through to a self-contained voicemail recording flow. A SUCCESSFULLY answered
-- call does NOT record voicemail (the originate_disposition fix — bridge_result
-- is never a real channel var).
--
-- ctx fields consumed:
--   session, get_var, set_var, hangup
--   uuid, normalized_did, customer_id, routing (extension, display_name)
--   original_caller_number, original_caller_name
--   get_domain
--
-- `freeswitch` is the mod_lua global.

return function(ctx)
    local session = ctx.session
    local get_var = ctx.get_var
    local set_var = ctx.set_var
    local uuid = ctx.uuid
    local normalized_did = ctx.normalized_did
    local customer_id = ctx.customer_id
    local routing = ctx.routing
    local original_caller_number = ctx.original_caller_number
    local original_caller_name = ctx.original_caller_name

    -- UCaaS Extension DID - Route inbound call to user's extension
    local ext = routing.extension
    local display = routing.display_name or ("Extension " .. ext)

    -- Multi-tenant: build customer-specific domain from customer_id.
    -- Extensions register under customer_{id}.voiceplatform.local (e.g.,
    -- 100@customer_13.voiceplatform.local). The global domain (voiceplatform.local)
    -- will NOT resolve the user because mod_xml_curl scopes lookups by the
    -- customer domain extracted from the SIP request.
    local base_domain = ctx.get_domain()
    local customer_domain = string.format("customer_%s.%s", tostring(customer_id), base_domain)

    freeswitch.consoleLog("INFO", string.format(
        "[%s] UCaaS inbound: DID %s -> ext %s (%s) @ %s\n",
        uuid, normalized_did, ext, display, customer_domain
    ))

    -- Media anchoring and ringback (same pattern as RCF local)
    set_var("proxy_media", "true")
    set_var("ringback", "%(2000,4000,440,480)")
    set_var("transfer_ringback", "%(2000,4000,440,480)")
    set_var("hangup_after_bridge", "true")
    set_var("continue_on_fail", "true")

    -- Preserve original caller ID for the called extension to see
    set_var("effective_caller_id_number", original_caller_number)
    set_var("effective_caller_id_name", original_caller_name)

    -- Mark as lua-routed so the dialplan fallback doesn't return 404
    set_var("lua_routed", "true")

    -- Verto (WebRTC) users don't appear in sofia registrations — they connect
    -- via mod_verto's WebSocket.  "user/" does a sofia lookup and fails.
    -- "verto.rtc/" reaches the Verto endpoint directly.  Fall back to "user/"
    -- for any future SIP-registered extensions.
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

    -- Determine bridge success the authoritative FreeSWITCH way, exactly as the
    -- rcf branch does. originate_disposition is set to "SUCCESS" after a
    -- connected bridge, or to a failure cause (USER_BUSY, NO_USER_RESPONSE,
    -- NORMAL_TEMPORARY_FAILURE, etc.) otherwise. `bridge_result` is NOT a real
    -- FreeSWITCH channel variable — reading it always returns "" so a
    -- successfully ANSWERED call would wrongly fall through to voicemail.
    local disposition = get_var("originate_disposition", "")
    local last_bridge_hangup = get_var("last_bridge_hangup_cause", "")

    if disposition ~= "SUCCESS" then
        -- Extension unavailable (not registered, busy, rejected, etc.)
        -- Record a voicemail directly: play a brief tone sequence, beep, record.
        -- We bypass mod_voicemail's phrase-macro flow (which needs full sound
        -- packs for a good UX) and handle recording ourselves, then deposit
        -- the file where mod_voicemail can pick it up for retrieval later.
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
            os.execute("mkdir -p " .. vm_dir)
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
            -- creates the voicemails row. vm_file lives under
            -- /var/lib/freeswitch/voicemail, which entrypoint.sh symlinks onto
            -- the shared /media/spool volume — send the API the spool path it
            -- reads from its own mount. Fire-and-forget, fully fail-open: a
            -- notify failure never affects the call (the file is already on the
            -- shared spool). Skipped cleanly when API_HOST is unset (unit harness).
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
end
