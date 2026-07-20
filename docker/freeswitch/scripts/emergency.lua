-- emergency.lua — E911 / 933 emergency call handler (LIFE SAFETY)
--
-- Invoked by the dialplan `emergency_911` extension (placed FIRST in BOTH the
-- `default` context — registered Verto/SIP softphones — and the `public` context
-- — carrier/trunk traffic from Kamailio) for destination_number 911 or 933.
--
-- WHY THIS EXISTS (audit finding): the old `emergency_911` extension lived at the
-- BOTTOM of the `public` context, AFTER the 2-6 digit `local_extension` matcher,
-- so a 3-digit "911"/"933" was swallowed as an extension dial, failed, and fell
-- to voicemail — 911 NEVER reached a PSAP for softphone (or trunk) users. The
-- dialplan now matches 911/933 ABOVE every extension matcher and routes here.
--
-- WHAT THIS DOES:
--   911:
--     1. RAY BAUM's Act — resolve a dispatchable location + a valid callback
--        number for THIS line (per-line channel vars first, then a DB-assigned
--        DID, then env defaults) and attach the location to the outbound INVITE
--        (X-Emergency-Location always; RFC 6442 Geolocation when the location is
--        a URI) so the carrier/PSAP can dispatch and call back.
--     2. Kari's Law — fire a FreeSWITCH `CUSTOM emergency::dial` event AND (if
--        configured) a fire-and-forget notification webhook, BEFORE bridging, so
--        a central contact is notified on every 911 dial. Neither is allowed to
--        delay the PSAP bridge (event is in-process; webhook is backgrounded).
--     3. Bridge to the carrier EMERGENCY path (X-Carrier=emergency → Bandwidth
--        dedicated E911 trunk in Kamailio TO_CARRIER) with SBC + carrier
--        failover, degrading to the normal voice carrier as a last-resort
--        backstop so 911 always egresses somewhere.
--   933 (SHAKEN / E911 test number): DO NOT route to a PSAP. Answer locally and
--        echo back the provisioned callback number + dispatchable location so a
--        technician can verify per-line E911 provisioning end-to-end.
--
-- DESIGN RULES:
--   * FAIL-SAFE / DEFENSIVE: every module load, DB lookup, event, and webhook is
--     nil-checked / pcall-wrapped. Nothing may prevent 911 from bridging. If the
--     script cannot resolve a perfect callback/location it still routes 911 with
--     the best value it has.
--   * Uses the EXTERNAL sofia profile (sofia/external/…@SBC) so Via/Contact/SDP
--     carry the public IP, identical to every other outbound path.
--   * Reuses lib/dialstring + lib/session_timer for byte-consistent dial strings.
--
-- ctx: none — this is a standalone dialplan-invoked script (like inbound_router.lua),
-- so it uses the mod_lua `session` + `freeswitch` globals directly.
--
-- FOLLOW-UPS the backend/infra experts must complete (see report):
--   * Per-DID/registration dispatchable-location schema + provisioning UI, surfaced
--     to FS as the `emergency_location` (+ `emergency_caller_id`) channel variables
--     via the mod_xml_curl directory (per-registration) or a DID lookup.
--   * A notification delivery handler behind EMERGENCY_NOTIFY_URL (Kari's Law
--     central contact — email/SMS/Slack), and/or an ESL consumer of the
--     `CUSTOM emergency::dial` event.
--   * Confirm Bandwidth E911 trunk (TC3 GRANITE_911) egress provisioning for our
--     source IPs (Kamailio routes X-Carrier=emergency there; see kamailio.cfg).

-- Set up package paths (same pattern as inbound_router.lua) so lib modules load.
package.path = "/usr/local/share/lua/5.3/?.lua;/usr/local/share/lua/5.3/?/init.lua;/usr/share/lua/5.3/?.lua;/usr/share/lua/5.3/?/init.lua;/usr/local/freeswitch/scripts/lib/?.lua;" .. (package.path or "")
package.cpath = "/usr/local/lib/lua/5.3/?.so;/usr/local/lib/lua/5.3/?/?.so;/usr/lib/lua/5.3/?.so;/usr/lib/lua/5.3/?/?.so;" .. (package.cpath or "")

-- loadfile() module loader (CLAUDE.md gotcha #10: require() is broken under mod_lua).
local function load_module(name)
    local path = "/usr/local/freeswitch/scripts/lib/" .. name .. ".lua"
    local ok_f, func = pcall(loadfile, path)
    if not ok_f or not func then return nil end
    local ok, result = pcall(func)
    if not ok then return nil end
    return result
end

-- Optional helpers — all nil-safe. 911 must route even if these fail to load.
local db = load_module("db_client")
local e164 = load_module("e164")
local dialstring = load_module("dialstring")
local session_timer = load_module("session_timer")

if not session then
    freeswitch.consoleLog("CRIT", "[emergency] NO SESSION OBJECT — cannot route emergency call\n")
    return
end

-- ---------------------------------------------------------------------------
-- session helpers
-- ---------------------------------------------------------------------------
local function get_var(name, default)
    local ok, val = pcall(function() return session:getVariable(name) end)
    if ok and val and val ~= "" then return val end
    return default
end

local function set_var(name, value)
    if value ~= nil then
        pcall(function() session:setVariable(name, tostring(value)) end)
    end
end

-- POSIX shell single-quote escape (mirror lib/vm_notify.lua).
local function shq(s)
    return "'" .. tostring(s or ""):gsub("'", "'\\''") .. "'"
end

-- Minimal JSON string escape for the notify payload.
local function jesc(s)
    s = tostring(s or "")
    s = s:gsub("\\", "\\\\"):gsub('"', '\\"'):gsub("\n", "\\n"):gsub("\r", "\\r"):gsub("\t", "\\t")
    return s
end

-- Digit-strip to a 10-digit NANP number for carrier From auth (fail-safe: returns
-- the input unchanged if it is not 10/11 digits, so nothing is ever dropped).
local function to_10digit(number)
    if e164 and e164.to_10digit then return e164.to_10digit(number) end
    local digits = tostring(number or ""):gsub("[^%d]", "")
    if #digits == 11 and digits:sub(1, 1) == "1" then return digits:sub(2) end
    return digits
end

local function normalize_e164(number)
    if e164 and e164.normalize_did then return e164.normalize_did(number) end
    local clean = tostring(number or ""):gsub("[^%d+]", "")
    if clean:match("^%+") then return clean end
    if #clean == 10 then return "+1" .. clean end
    if #clean == 11 and clean:sub(1, 1) == "1" then return "+" .. clean end
    return "+" .. clean
end

-- ---------------------------------------------------------------------------
-- inputs + environment
-- ---------------------------------------------------------------------------
local uuid = get_var("uuid", "unknown")
local emergency_number = get_var("emergency_number", get_var("destination_number", "911"))
local caller_id_number = get_var("caller_id_number", "")
local caller_id_name = get_var("caller_id_name", "")
local customer_id = get_var("customer_id", "")
local sip_call_id = get_var("sip_call_id", uuid)

local sbc_proxy_ip = os.getenv("SBC_PROXY_IP") or "127.0.0.1"
local sbc_proxy_ip_failover = os.getenv("SBC_PROXY_IP_FAILOVER") or sbc_proxy_ip
local external_sip_ip = os.getenv("EXTERNAL_SIP_IP") or "auto"

-- Provisioning defaults. EMERGENCY_DEFAULT_CALLBACK MUST be a real DID on our
-- Bandwidth account (carrier termination auth) — set it in the media VM .env.
local default_callback = os.getenv("EMERGENCY_DEFAULT_CALLBACK") or ""
local default_location = os.getenv("EMERGENCY_DEFAULT_LOCATION") or ""

-- Kari's Law webhook (default-OFF: no URL -> event only). Fire-and-forget so it
-- can NEVER delay the PSAP bridge.
local notify_url = os.getenv("EMERGENCY_NOTIFY_URL") or ""
local notify_secret = os.getenv("EMERGENCY_NOTIFY_SECRET") or ""
local notify_timeout = tonumber(os.getenv("EMERGENCY_NOTIFY_TIMEOUT") or "") or 5

-- Per-attempt PDD bound + overall ring time (emergency rings long once answered).
local progress_timeout = tonumber(os.getenv("BRIDGE_PROGRESS_TIMEOUT") or "") or 10
if progress_timeout < 1 then progress_timeout = 10 end
local call_timeout = tonumber(os.getenv("EMERGENCY_CALL_TIMEOUT") or "") or 180
if call_timeout < 30 then call_timeout = 180 end

-- ---------------------------------------------------------------------------
-- Resolve a valid CALLBACK number (must be a DID we own for carrier auth + so the
-- PSAP can call back). Priority:
--   1. emergency_caller_id channel var (explicit per-line provisioning)
--   2. DB assigned DID when the caller is a short internal extension (softphone)
--   3. caller_id_number when it is already a 10/11-digit number (trunk/DID line)
--   4. EMERGENCY_DEFAULT_CALLBACK env (a real account DID)
--   5. caller_id_number as-is (last resort — better some callback than none)
-- ---------------------------------------------------------------------------
local function resolve_callback()
    local explicit = get_var("emergency_caller_id", nil)
    if explicit and explicit ~= "" then return to_10digit(explicit), "line-provisioned" end

    local cidn = caller_id_number or ""
    local cid_digits = cidn:gsub("[^%d]", "")

    -- Short internal extension (1-6 digits, no +) -> look up its assigned DID.
    if cidn ~= "" and not cidn:match("^%+") and #cid_digits >= 1 and #cid_digits <= 6 then
        if db and db.lookup_did_for_extension then
            local ok, row = pcall(db.lookup_did_for_extension, cidn)
            if ok and type(row) == "table" and row.assigned_did and row.assigned_did ~= "" then
                return to_10digit(row.assigned_did), "extension-assigned-did"
            end
        end
    end

    -- Already a real 10/11-digit number (trunk PBX / DID line).
    if #cid_digits == 10 or (#cid_digits == 11 and cid_digits:sub(1, 1) == "1") then
        return to_10digit(cidn), "caller-id"
    end

    if default_callback ~= "" then return to_10digit(default_callback), "env-default" end

    -- Last resort (H-2). NEVER present a bogus "0000000000": Bandwidth E911 REJECTS
    -- a 911 INVITE whose From is not a real account DID, so a placeholder fails the
    -- call exactly like an empty From. Fall back to the configured account default
    -- instead. entrypoint.sh HARD-FAILS FreeSWITCH startup in production when
    -- EMERGENCY_DEFAULT_CALLBACK is unset/invalid, so the `env-default` branch above
    -- always returns a real Granite DID there and this line is dev-only (where
    -- default_callback may be "" and there is no live PSAP regardless).
    return to_10digit(cidn ~= "" and cidn or default_callback), "fallback"
end

-- Resolve dispatchable LOCATION (RAY BAUM's Act): per-line channel var, else env
-- default. The per-line `emergency_location` var is the CORRECT source; wiring it
-- from the directory/DID (per-registration mod_xml_curl variable or a DID lookup)
-- is an ACKNOWLEDGED FOLLOW-UP (see the FOLLOW-UPS header block). Until that lands,
-- EMERGENCY_DEFAULT_LOCATION is the FLOOR — entrypoint.sh HARD-FAILS FreeSWITCH
-- startup in production when it is empty (H-3), so `default_location` is non-empty
-- there. A "none" result is a provisioning failure and is logged loudly (CRIT) at
-- call time below; we never silently egress a 911 with no location.
local function resolve_location()
    local loc = get_var("emergency_location", nil)
    if loc and loc ~= "" then return loc, "line-provisioned" end
    if default_location ~= "" then return default_location, "env-default" end
    return "", "none"
end

local callback, callback_src = resolve_callback()
local location, location_src = resolve_location()
local callback_e164 = normalize_e164(callback)

freeswitch.consoleLog("CRIT", string.format(
    "[%s] EMERGENCY %s dial: caller=%s (%s) callback=%s (src=%s) location=%s (src=%s) customer=%s\n",
    uuid, emergency_number, caller_id_number, caller_id_name,
    callback, callback_src, (location ~= "" and location or "<none>"), location_src,
    tostring(customer_id)))

if location == "" then
    freeswitch.consoleLog("CRIT", string.format(
        "[%s] EMERGENCY %s has NO dispatchable location — set per-line emergency_location "
        .. "or EMERGENCY_DEFAULT_LOCATION. Routing anyway (life-safety).\n",
        uuid, emergency_number))
end

-- ---------------------------------------------------------------------------
-- Kari's Law notification (911 only): CUSTOM event (in-process, instant) +
-- fire-and-forget webhook (backgrounded so it can never delay the bridge).
-- ---------------------------------------------------------------------------
local function fire_karis_law_notification()
    -- 1) FreeSWITCH CUSTOM event — an ESL consumer (backend) delivers the central
    --    notification. Always fired for 911; instant + non-blocking.
    pcall(function()
        local ev = freeswitch.Event("CUSTOM", "emergency::dial")
        if ev then
            ev:addHeader("Emergency-Number", tostring(emergency_number))
            ev:addHeader("Caller-ID-Number", tostring(caller_id_number))
            ev:addHeader("Caller-ID-Name", tostring(caller_id_name))
            ev:addHeader("Callback-Number", tostring(callback))
            ev:addHeader("Callback-Source", tostring(callback_src))
            ev:addHeader("Dispatchable-Location", tostring(location))
            ev:addHeader("Customer-ID", tostring(customer_id))
            ev:addHeader("Call-UUID", tostring(uuid))
            ev:addHeader("Timestamp", os.date("!%Y-%m-%dT%H:%M:%SZ"))
            ev:fire()
            freeswitch.consoleLog("INFO", "[" .. uuid .. "] Kari's Law event fired (emergency::dial)\n")
        end
    end)

    -- 2) Optional webhook (default-OFF). Backgrounded fire-and-forget: MUST NOT
    --    delay the PSAP bridge. Fail-open — a failed notify never affects the call.
    if notify_url == "" then return end
    local payload = string.format(
        '{"event":"emergency_dial","emergency_number":"%s","caller_id":"%s","caller_name":"%s",'
        .. '"callback":"%s","callback_source":"%s","location":"%s","customer_id":"%s",'
        .. '"call_uuid":"%s","timestamp":"%s"}',
        jesc(emergency_number), jesc(caller_id_number), jesc(caller_id_name),
        jesc(callback), jesc(callback_src), jesc(location), jesc(customer_id),
        jesc(uuid), jesc(os.date("!%Y-%m-%dT%H:%M:%SZ")))

    local parts = {
        "curl", "-s", "-o", "/dev/null",
        "--max-time", tostring(notify_timeout),
        "-X", "POST",
        "-H", shq("Content-Type: application/json"),
    }
    if notify_secret ~= "" then
        parts[#parts + 1] = "-H"
        parts[#parts + 1] = shq("X-Emergency-Secret: " .. notify_secret)
    end
    parts[#parts + 1] = "--data"
    parts[#parts + 1] = shq(payload)
    parts[#parts + 1] = shq(notify_url)
    -- Background + fully detach so os.execute returns immediately (no bridge delay).
    local cmd = table.concat(parts, " ") .. " >/dev/null 2>&1 &"
    pcall(function() os.execute(cmd) end)
    freeswitch.consoleLog("INFO", "[" .. uuid .. "] Kari's Law webhook dispatched (backgrounded)\n")
end

-- ===========================================================================
-- 933 — SHAKEN / E911 TEST NUMBER. Local echo of provisioned info. NO PSAP.
-- ===========================================================================
if emergency_number == "933" then
    freeswitch.consoleLog("CRIT", string.format(
        "[%s] 933 E911 TEST: callback=%s location=%s (echo only, NOT routed to PSAP)\n",
        uuid, callback, (location ~= "" and location or "<none>")))
    set_var("is_emergency_test", "true")
    set_var("emergency_callback", callback)
    set_var("emergency_location", location)

    pcall(function() session:answer() end)
    pcall(function() session:sleep(500) end)

    -- Speak the provisioned callback + location so a technician can verify it.
    local tts_engine = os.getenv("TTS_ENGINE") or "tts_commandline"
    local tts_voice = os.getenv("TTS_DEFAULT_VOICE") or "slt"
    local spoken_cb = tostring(callback):gsub("%d", "%0 ")  -- space digits for clarity
    local phrase = string.format(
        "This is the emergency test line. Your emergency callback number is %s. "
        .. "Your registered dispatchable location is %s.",
        spoken_cb, (location ~= "" and location or "not configured"))
    local ok_speak = pcall(function()
        session:execute("speak", tts_engine .. "|" .. tts_voice .. "|" .. phrase)
    end)
    if not ok_speak then
        -- TTS unavailable: still give an audible confirmation tone so the tester
        -- knows the number is reachable, and the details are in the logs above.
        pcall(function()
            session:execute("playback", "tone_stream://%(400,200,440,620);loops=3")
        end)
    end
    pcall(function() session:sleep(500) end)
    pcall(function() session:hangup("NORMAL_CLEARING") end)
    return
end

-- ===========================================================================
-- 911 — route to the carrier EMERGENCY path with location + callback.
-- ===========================================================================

-- Kari's Law FIRST (before bridge; non-blocking).
fire_karis_law_notification()

-- Caller ID: present the callback DID (carrier From auth + PSAP callback).
set_var("outbound_caller_id_number", callback)
set_var("outbound_caller_id_name", callback)
set_var("effective_caller_id_number", callback)
set_var("effective_caller_id_name", callback)
-- Kamailio TO_CARRIER builds P-Asserted-Identity from X-Original-CID (E.164).
set_var("sip_h_X-Original-CID", callback_e164)
pcall(function() session:execute("export", "origination_caller_id_number=" .. callback) end)

-- Dispatchable location (RAY BAUM's Act). Always send the internal
-- X-Emergency-Location header (Bandwidth by-reference / provisioned-location key
-- or civic text). If the location is a URI, ALSO send RFC 6442 Geolocation +
-- Geolocation-Routing so a location-by-reference dereference is permitted.
if location ~= "" then
    set_var("sip_h_X-Emergency-Location", location)
    if location:match("^https?://") or location:match("^cid:") or location:match("^sips?:") then
        set_var("sip_h_Geolocation", "<" .. location .. ">")
        set_var("sip_h_Geolocation-Routing", "yes")
    end
end

-- Mark the call as emergency for CDR / downstream.
set_var("is_emergency", "true")
set_var("emergency_callback", callback)
set_var("emergency_location", location)
set_var("lua_routed", "true")
set_var("hangup_after_bridge", "true")
set_var("continue_on_fail", "true")
-- Local ringback while the PSAP trunk rings.
set_var("ringback", "%(2000,4000,440,480)")
set_var("transfer_ringback", "%(2000,4000,440,480)")

-- RFC 4028 session timers to the B-leg (same as every outbound path).
if session_timer and session_timer.export then
    session_timer.export(session)
else
    pcall(function() session:execute("export", "sip_session_timeout=1800") end)
    pcall(function() session:execute("export", "sip_minimum_session_expires=90") end)
    pcall(function() session:execute("export", "enable_timer=true") end)
end

-- Build a carrier dial string. Reuse lib/dialstring when available; otherwise a
-- byte-equivalent inline skeleton (life-safety: never depend on an optional lib).
local bopts = (session_timer and session_timer.BRIDGE_OPTS)
    or "sip_session_timeout=1800,sip_minimum_session_expires=90,enable_timer=true"
local function build_dial(carrier, sbc_ip)
    local inner = string.format(
        "ignore_early_media=false,progress_timeout=%d,call_timeout=%d,sip_h_X-Carrier=%s,sip_h_X-CID=%s,%s",
        progress_timeout, call_timeout, carrier, sip_call_id, bopts)
    if dialstring and dialstring.bridge then
        return dialstring.bridge(inner, "911", sbc_ip)
    end
    return string.format("{%s}sofia/external/911@%s:5060", inner, sbc_ip)
end

-- Attempt order: dedicated E911 trunk (both SBCs), then the normal voice carrier
-- as a life-safety BACKSTOP so 911 always egresses even if the E911 trunk is
-- unprovisioned/unreachable. (Kamailio maps X-Carrier=emergency -> Bandwidth
-- GRANITE_911 TC3 IPs; primary/secondary -> the normal voice PoPs.)
local attempts = {
    { carrier = "emergency", sbc = sbc_proxy_ip,          label = "E911 trunk via SBC-1" },
    { carrier = "emergency", sbc = sbc_proxy_ip_failover, label = "E911 trunk via SBC-2" },
    { carrier = "primary",   sbc = sbc_proxy_ip,          label = "voice carrier via SBC-1 (backstop)" },
    { carrier = "secondary", sbc = sbc_proxy_ip_failover, label = "voice carrier via SBC-2 (backstop)" },
}

local test_mode = os.getenv("TEST_MODE")
if test_mode == "true" then
    freeswitch.consoleLog("CRIT", string.format(
        "[%s] TEST MODE: would bridge 911 to carrier emergency path (callback=%s location=%s)\n",
        uuid, callback, location))
    pcall(function()
        session:answer()
        session:execute("playback", "tone_stream://%(1000,0,440)")
        session:sleep(1500)
        session:hangup("NORMAL_CLEARING")
    end)
    return
end

for i, a in ipairs(attempts) do
    if not session:ready() then break end
    set_var("carrier_used", "emergency_" .. a.carrier)
    freeswitch.consoleLog("CRIT", string.format(
        "[%s] 911 bridge attempt %d/%d (%s) carrier=%s sbc=%s callback=%s\n",
        uuid, i, #attempts, a.label, a.carrier, a.sbc, callback))
    pcall(function()
        session:execute("bridge", build_dial(a.carrier, a.sbc))
    end)
    local disposition = get_var("originate_disposition", "")
    if disposition == "SUCCESS" then
        freeswitch.consoleLog("CRIT", string.format(
            "[%s] 911 CONNECTED via %s\n", uuid, a.label))
        return
    end
    freeswitch.consoleLog("CRIT", string.format(
        "[%s] 911 attempt %d/%d FAILED (%s): cause=%s\n",
        uuid, i, #attempts, a.label, get_var("last_bridge_hangup_cause", disposition)))
end

-- All attempts failed. This is a life-safety failure — log loudly.
freeswitch.consoleLog("CRIT", string.format(
    "[%s] 911 ROUTING FAILED ON ALL CARRIERS for callback=%s — caller could not reach a PSAP\n",
    uuid, callback))
if session:ready() then
    pcall(function()
        session:answer()
        session:execute("playback", "tone_stream://%(400,200,440,620);loops=5")
        session:hangup("NETWORK_OUT_OF_ORDER")
    end)
end
