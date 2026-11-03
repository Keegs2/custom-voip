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

    -- Sinch origination (inbound to us)
    ["206.146.100.24"] = "Sinch-Denver",
    ["206.146.101.39"] = "Sinch-Chicago",

    -- Sinch DUAL-ROLE IPs: each hosts an 8XX-T toll-free ORIGINATION trunk
    -- (inbound, registered to our zone VIPs) AND a REDUNDANT TERMINATION
    -- trunk (outbound, registered to our SBC public IPs). One IP = one HEP
    -- address, so the alias names both roles; tell them apart in the ladder
    -- by direction (Sinch -> VIP = orig, SBC public IP -> Sinch = term).
    --   98.25:  orig TG ATLNGAQSGR2_7284 (8YY only) + redundant OSAO 8YY term (ATLSBX21, dispatcher group 12)
    --   100.25: orig TG DNVTCOZIGR2_3327 (8YY only) + redundant INT LD term (DENSBX21, dispatcher group 11)
    ["206.146.98.25"]  = "Sinch-Atlanta-TF-Orig+TF-Term",
    ["206.146.100.25"] = "Sinch-Denver-TF-Orig+LD-Term",

    -- Sinch termination (outbound from us; DIFFERENT IPs from origination)
    ["206.146.98.26"]  = "Sinch-Atlanta-LD",  -- TG ATLNGAQSGR2_7214 (INT LD)
    ["206.146.100.26"] = "Sinch-Denver-TF",   -- TG DNVTCOZIGR2_3282 (OSAO 8YY)

    -- Verizon IPsec trunks (docs/VERIZON_IPSEC_TRUNKS_PLAN.md §2.2 / §4.1).
    -- Our side only — Verizon's SIP Gateway / ATF-IP / media IPs are not
    -- assigned yet; add them here as "Verizon-<name>" (that prefix is the
    -- carrier family in the API mirror, homer_pcap.py CARRIER_NAME_PREFIXES)
    -- once Verizon provides the prefixes. Our own Vz* entries are PLATFORM
    -- nodes (gateways, reserved source IPs), never carrier. The per-zone entries below cover: the
    -- inside-tunnel SIP IP Verizon sees (1:1 NAT -> the zone's .251 SBC VIP),
    -- the .251 VIP itself (siptrace reports the bind address for inbound),
    -- the IKE peer IPs (ESP only — never SIP, listed for completeness so a
    -- stray packet never renders as a raw IP), and the gateway NIC IPs.

    -- =================== EAST ZONE (us-east1-b) ===================
    -- SBC layer (East). Both interfaces of each node collapse to one name
    -- so the node renders as a single ladder column.
    ["34.24.133.82"]   = "SBC-VIP",      -- East NLB VIP
    ["10.142.0.250"]   = "SBC-SigVIP",   -- East signaling ILB VIP (active/standby; update if reservation differs)
    ["10.142.0.251"]   = "SBC-VzVIP",    -- East SBC Verizon ILB VIP (sbc-verizon-fwd; inbound bind address in siptrace)
    ["34.148.100.185"] = "VzSIP",       -- east-vz-sip: inside-tunnel SIP IP Verizon sees (1:1 NAT -> 10.142.0.251)
    ["35.231.206.85"]  = "VzIKE-A",     -- east-vz-ike-a: IKE peer IP (ESP only, never SIP)
    ["34.26.69.151"]   = "VzIKE-B",     -- east-vz-ike-b: IKE peer IP (ESP only, never SIP)
    ["192.168.11.2"]   = "VzGW-A",      -- east-vz-gw-a NIC (vz-ipsec-east, us-east1-b)
    ["192.168.11.3"]   = "VzGW-B",      -- east-vz-gw-b NIC (vz-ipsec-east, us-east1-c)
    ["10.142.0.100"]   = "SBC-1",        -- East SBC-1 internal (VPC)
    ["34.74.71.32"]    = "SBC-1",        -- East SBC-1 public
    ["10.142.0.101"]   = "SBC-2",        -- East SBC-2 internal (VPC)
    ["35.243.136.35"]  = "SBC-2",        -- East SBC-2 public

    -- Media layer (East FreeSWITCH)
    ["192.168.10.2"]   = "FreeSWITCH",   -- East FS internal (media subnet)
    ["34.139.119.135"] = "FreeSWITCH",   -- East FS public

    -- Media HA hot standby (East FS-2 `east-fs-2`, Phase 4c — receives calls
    -- only while FS-1 is dead). Same collapse pattern: both interfaces -> one name.
    ["192.168.10.3"]   = "FreeSWITCH-2", -- East FS-2 internal (voip-media; update if reservation differs)
    ["35.196.226.123"] = "FreeSWITCH-2", -- East FS-2 public (east-fs-2-ip)

    -- Services (East)
    ["10.142.0.103"]   = "Services",     -- East services VM (DB/Homer)

    -- =================== WEST ZONE (us-west1) ===================
    -- Mirrors the East naming/collapse pattern: both interfaces of each
    -- node map to one "West-*" name so each node is a single column and
    -- never renders as a raw "UNKNOWN" IP in the ladder.
    ["35.252.214.40"]  = "West-SBC-VIP", -- West NLB VIP
    ["10.138.0.250"]   = "West-SBC-SigVIP", -- West signaling ILB VIP (active/standby; update if reservation differs)
    ["10.138.0.251"]   = "West-SBC-VzVIP",  -- West SBC Verizon ILB VIP (west-sbc-verizon-fwd; inbound bind address in siptrace)
    ["136.86.242.57"]  = "West-VzSIP",     -- west-vz-sip: inside-tunnel SIP IP Verizon sees (1:1 NAT -> 10.138.0.251)
    ["8.231.131.118"]  = "West-VzIKE-A",   -- west-vz-ike-a: IKE peer IP (ESP only, never SIP)
    ["136.66.170.29"]  = "West-VzIKE-B",   -- west-vz-ike-b: IKE peer IP (ESP only, never SIP)
    ["192.168.21.2"]   = "West-VzGW-A",    -- west-vz-gw-a NIC (vz-ipsec-west, us-west1-b)
    ["192.168.21.3"]   = "West-VzGW-B",    -- west-vz-gw-b NIC (vz-ipsec-west, us-west1-c)
    ["10.138.0.100"]   = "West-SBC-1",   -- West SBC-1 internal (VPC)
    ["8.229.41.59"]    = "West-SBC-1",   -- West SBC-1 public
    ["10.138.0.101"]   = "West-SBC-2",   -- West SBC-2 internal (VPC)
    ["136.117.230.166"]= "West-SBC-2",   -- West SBC-2 public

    -- Media layer (West FreeSWITCH)
    ["192.168.20.2"]   = "West-FreeSWITCH", -- West FS internal (media subnet)
    ["8.229.177.165"]  = "West-FreeSWITCH", -- West FS public

    -- Media HA hot standby (West FS-2 `west-fs-2`, Phase 4c)
    ["192.168.20.3"]   = "West-FreeSWITCH-2", -- West FS-2 internal (voip-media-west; update if reservation differs)
    ["35.197.95.171"]  = "West-FreeSWITCH-2", -- West FS-2 public (west-fs-2-ip)

    -- Services (West) — replica DB / HEP relay
    ["10.138.0.2"]     = "West-Services",   -- West services VM (DB replica)
    ["10.138.0.103"]   = "West-Services",   -- West services VM (legacy interface)

    -- =================== CENTRAL ZONE (us-central1-b) ===================
    -- Same collapse pattern: both interfaces of each node map to one
    -- "Central-*" name so each node is a single ladder column.
    ["35.253.133.230"] = "Central-SBC-VIP", -- Central NLB VIP
    ["10.128.0.250"]   = "Central-SBC-SigVIP", -- Central signaling ILB VIP (active/standby; update if reservation differs)
    ["10.128.0.251"]   = "Central-SBC-VzVIP",  -- Central SBC Verizon ILB VIP (central-sbc-verizon-fwd; inbound bind address in siptrace)
    ["35.184.132.124"] = "Central-VzSIP",     -- central-vz-sip: inside-tunnel SIP IP Verizon sees (1:1 NAT -> 10.128.0.251)
    ["34.68.252.50"]   = "Central-VzIKE-A",   -- central-vz-ike-a: IKE peer IP (ESP only, never SIP)
    ["34.171.191.175"] = "Central-VzIKE-B",   -- central-vz-ike-b: IKE peer IP (ESP only, never SIP)
    ["192.168.31.4"]   = "Central-VzGW-A",    -- central-vz-gw-a NIC (vz-ipsec-central, us-central1-a)
    ["192.168.31.5"]   = "Central-VzGW-B",    -- central-vz-gw-b NIC (vz-ipsec-central, us-central1-f)
    ["10.128.0.100"]   = "Central-SBC-1",   -- Central SBC-1 internal (VPC)
    ["34.41.188.100"]  = "Central-SBC-1",   -- Central SBC-1 public
    ["10.128.0.101"]   = "Central-SBC-2",   -- Central SBC-2 internal (VPC)
    ["35.184.151.64"]  = "Central-SBC-2",   -- Central SBC-2 public

    -- Media layer (Central FreeSWITCH)
    ["192.168.30.2"]   = "Central-FreeSWITCH", -- Central FS internal (media subnet)
    ["35.253.103.114"] = "Central-FreeSWITCH", -- Central FS public

    -- Media HA hot standby (Central FS-2 `central-fs-2`, Phase 4c)
    ["192.168.30.3"]   = "Central-FreeSWITCH-2", -- Central FS-2 internal (voip-media-central; update if reservation differs)
    ["34.63.100.161"]  = "Central-FreeSWITCH-2", -- Central FS-2 public (central-fs-2-ip)

    -- Services (Central) — replica DB / HEP relay
    ["10.128.0.2"]     = "Central-Services",   -- Central services VM (DB replica)
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
