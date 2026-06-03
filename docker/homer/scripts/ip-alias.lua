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

    -- =================== EAST ZONE (us-east1-b) ===================
    -- SBC layer (East). Both interfaces of each node collapse to one name
    -- so the node renders as a single ladder column.
    ["34.24.133.82"]   = "SBC-VIP",      -- East NLB VIP
    ["10.142.0.100"]   = "SBC-1",        -- East SBC-1 internal (VPC)
    ["34.74.71.32"]    = "SBC-1",        -- East SBC-1 public
    ["10.142.0.101"]   = "SBC-2",        -- East SBC-2 internal (VPC)
    ["35.243.136.35"]  = "SBC-2",        -- East SBC-2 public

    -- Media layer (East FreeSWITCH)
    ["192.168.10.2"]   = "FreeSWITCH",   -- East FS internal (media subnet)
    ["34.139.119.135"] = "FreeSWITCH",   -- East FS public

    -- Services (East)
    ["10.142.0.103"]   = "Services",     -- East services VM (DB/Homer)

    -- =================== WEST ZONE (us-west1) ===================
    -- Mirrors the East naming/collapse pattern: both interfaces of each
    -- node map to one "West-*" name so each node is a single column and
    -- never renders as a raw "UNKNOWN" IP in the ladder.
    ["35.252.214.40"]  = "West-SBC-VIP", -- West NLB VIP
    ["10.138.0.100"]   = "West-SBC-1",   -- West SBC-1 internal (VPC)
    ["8.229.41.59"]    = "West-SBC-1",   -- West SBC-1 public
    ["10.138.0.101"]   = "West-SBC-2",   -- West SBC-2 internal (VPC)
    ["136.117.230.166"]= "West-SBC-2",   -- West SBC-2 public

    -- Media layer (West FreeSWITCH)
    ["192.168.20.2"]   = "West-FreeSWITCH", -- West FS internal (media subnet)
    ["8.229.177.165"]  = "West-FreeSWITCH", -- West FS public

    -- Services (West) — replica DB / HEP relay
    ["10.138.0.103"]   = "West-Services",   -- West services VM (DB replica)
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
