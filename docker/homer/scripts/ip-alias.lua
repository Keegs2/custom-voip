-- ip-alias.lua — Rewrite HEP SrcIP/DstIP to friendly node names
--
-- Runs inside heplify-server's Lua engine for every HEP packet.
-- Replaces raw IP addresses with human-readable names so that Grafana's
-- qxip-flow-panel shows "SBC-1 -> FreeSWITCH" instead of "10.142.0.100 -> 192.168.10.2".
--
-- How it works:
--   heplify-server calls every top-level function in order.
--   SetHEPField("SrcIP", name) mutates the HEP packet BEFORE Loki label
--   generation reads pkt.SrcIP/pkt.DstIP, so the built-in src_ip/dst_ip
--   labels carry the friendly names with zero dashboard changes.
--
-- Maintenance:
--   When IPs change or new nodes are added, update the aliases table below
--   and restart heplify-server. Unknown IPs pass through unchanged.

local aliases = {
    -- Bandwidth origination (inbound to us)
    ["67.231.13.185"]  = "BW-ATL",
    ["67.231.9.142"]   = "BW-NY",

    -- Bandwidth termination (outbound from us)
    ["67.231.2.12"]    = "BW-DAL",
    ["216.82.238.134"] = "BW-LA",
    ["67.231.1.188"]   = "BW-TC2-DAL",
    ["67.231.4.138"]   = "BW-TC2-LA",

    -- SBC layer
    ["34.24.133.82"]   = "SBC-VIP",
    ["10.142.0.100"]   = "SBC-1",
    ["10.142.0.101"]   = "SBC-2",
    ["34.74.71.32"]    = "SBC-1",
    ["35.243.136.35"]  = "SBC-2",

    -- Media layer (FreeSWITCH)
    ["192.168.10.2"]   = "FreeSWITCH",
    ["34.139.119.135"] = "FreeSWITCH",

    -- Services
    ["10.142.0.103"]   = "Services",
}

function aliasIPs()
    local srcIP = GetHEPSrcIP()
    local dstIP = GetHEPDstIP()

    if srcIP and aliases[srcIP] then
        SetHEPField("SrcIP", aliases[srcIP])
    end

    if dstIP and aliases[dstIP] then
        SetHEPField("DstIP", aliases[dstIP])
    end
end
