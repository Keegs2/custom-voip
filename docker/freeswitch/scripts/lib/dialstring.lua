-- lib/dialstring.lua — outbound carrier dial-string builder (RCF-V1)
--
-- Single source of truth for the `{...}sofia/external/<dest>@<proxy>:5060`
-- skeleton that was previously copy-pasted into the four outbound bridge sites
-- (inbound_router.lua rcf failover loop, trunk_outbound.lua primary+failover,
-- api_outbound.lua primary+failover). Centralizing the skeleton removes the
-- near-duplicate `}sofia/external/%s@%s:5060` literal from every call site while
-- producing byte-for-byte identical strings.
--
-- WHY a thin builder (not a fully-structured one): the three products order
-- their bridge {} options differently (api puts origination_caller_id first;
-- trunk leads with sip_enable_soa; rcf has no SOA flag) and a positional builder
-- could not reproduce all of them byte-for-byte. So each caller assembles its
-- own ordered inner-option string (sharing the session-timer fragment via
-- lib/session_timer.BRIDGE_OPTS) and hands it here for the common wrapper.
--
-- Gateway syntax is deliberately NOT supported — all outbound bridges use
-- sofia/external/dest@proxy (CLAUDE.md: the old sofia/gateway/carrier/dest
-- syntax produced corrupted Contact headers).
--
-- Loaded via the load_module() loadfile() pattern (CLAUDE.md gotcha #10).

local M = {}

-- Build a carrier bridge dial string.
--   inner_opts  : the already-assembled, comma-joined bridge {} option string
--                 (NO surrounding braces), e.g.
--                 "ignore_early_media=false,progress_timeout=10,...".
--   destination : the dialed number as the carrier expects it (caller strips
--                 the leading "+" where required — kept caller-side so this
--                 builder makes no number-format decisions).
--   proxy_ip    : the SBC IP to send the outbound INVITE to (port 5060).
-- Returns: "{<inner_opts>}sofia/external/<destination>@<proxy_ip>:5060"
function M.bridge(inner_opts, destination, proxy_ip)
    return string.format("{%s}sofia/external/%s@%s:5060", inner_opts, destination, proxy_ip)
end

return M
