-- lib/caller_id.lua — outbound caller-ID SIP header formatters (RCF-V1)
--
-- Single source of truth for the Diversion and Remote-Party-ID header VALUE
-- formats that were copy-pasted into inbound_router.lua (rcf branch) and
-- trunk_outbound.lua. The strings produced here are byte-for-byte the shipped
-- values — this extraction is behavior-preserving.
--
-- Only the header VALUE format is centralized (the part that was genuinely
-- identical). Which headers each product sets, and with which number
-- (original caller vs. forwarding DID, pass_caller_id on/off), stays in the
-- product handler — that policy differs per product and must not be flattened.
--
-- These build SIP header values for Kamailio to consume:
--   Diversion        — indicates the call was forwarded and from which number.
--   Remote-Party-ID  — backup CID presentation for carriers that don't support
--                      P-Asserted-Identity (Kamailio builds PAI from X-Original-CID).
--
-- Loaded via the load_module() loadfile() pattern (CLAUDE.md gotcha #10).

local M = {}

-- Diversion: <sip:<did>@<advertise_ip>>;reason=unconditional
-- `did` is the forwarding number (10-digit for Bandwidth auth); advertise_ip is
-- EXTERNAL_SIP_IP (the public/NLB address Kamailio presents to the carrier).
function M.diversion(did, advertise_ip)
    return "<sip:" .. did .. "@" .. advertise_ip .. ">;reason=unconditional"
end

-- Remote-Party-ID: <sip:<cid>@<advertise_ip>>;party=calling;privacy=off;screen=yes
-- `cid` is the presented calling number (E.164 in the rcf path).
function M.remote_party_id(cid, advertise_ip)
    return "<sip:" .. cid .. "@" .. advertise_ip .. ">;party=calling;privacy=off;screen=yes"
end

return M
