-- lib/session_timer.lua — RFC 4028 session-timer B-leg helpers (RCF-V1)
--
-- Single source of truth for the session-timer normalization that was
-- previously copy-pasted inline into inbound_router.lua (rcf branch),
-- trunk_outbound.lua and api_outbound.lua. The values here are byte-for-byte
-- the shipped logic — this extraction is behavior-preserving.
--
-- Two pieces, both required on every outbound carrier leg (see CLAUDE.md
-- "Session Timer Normalization"):
--
--   M.BRIDGE_OPTS  — the bridge {} option fragment that travels INSIDE the
--                    dial string so mod_sofia emits Session-Expires/Min-SE on
--                    the outbound INVITE.
--   M.export()     — exports the SAME three variables onto the A-leg session so
--                    they propagate to the B-leg channel. set_var() alone only
--                    sets the A-leg; export marks the variable for propagation.
--                    Belt-and-suspenders with BRIDGE_OPTS (CLAUDE.md gotcha #8).
--
-- Loaded the same proven way as the other lib/ modules — via the load_module()
-- loadfile() pattern (CLAUDE.md gotcha #10).

local M = {}

-- Bridge {} option fragment. Kept as the exact substring the characterization
-- specs assert (sip_session_timeout=1800, sip_minimum_session_expires=90,
-- enable_timer=true), in the exact order the production dial strings used.
M.BRIDGE_OPTS = "sip_session_timeout=1800,sip_minimum_session_expires=90,enable_timer=true"

-- Export the RFC 4028 session timers onto the B-leg. Each export is wrapped in
-- pcall exactly as the inline copies were, so a session in an odd state never
-- aborts routing.
function M.export(session)
    pcall(function() session:execute("export", "sip_session_timeout=1800") end)
    pcall(function() session:execute("export", "sip_minimum_session_expires=90") end)
    pcall(function() session:execute("export", "enable_timer=true") end)
end

return M
