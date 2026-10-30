# Verizon SIP Gateway (2-Way) + ATF-IP over Self-Built IPsec — Build Plan

**Status:** PLANNING (2026-10-28, revised same day after two adversarial reviews — SIP side and network side; findings folded in below, marked ▲). Nothing built, nothing ordered. The owner runs every GCP command; this doc supplies the design, the repo-side configs, and the order-form content.
**Sources:** Verizon `VoIP - Granite - NetOrderForm_2026.xlsx` (form edition 2026-06-01), `VPS Partner - Granite - ATF-IP Forecast.xlsx`, Verizon "IKEv2 Route Based 2024" spec page (screenshot shared 2026-10-08 — **a copy of the full spec still needs to land in the repo**), and the RCF-V1 code as of `29fd90f`.

---

## 0. Decisions

| Topic | Decision (owner) |
|---|---|
| Services | **SIP Gateway 2-Way** (termination + DID delivery to us) — **new install**. **ATF-IP** (toll-free origination) — added to Granite's existing Advanced Toll Free. |
| Metaswitch | Granite's existing Verizon trunks and tunnels terminate on the Metaswitch. This order is separate: nothing is shared or reused. The Metaswitch's tunnel config is only a *reference* for Verizon's peer IPs and profile (§10). |
| Tunnels | **Self-built** strongSwan gateway pairs in GCP, exactly to Verizon's spec. Not Google Cloud VPN (§1.3). |
| Zones | All three: East, West, Central. Calls never cross zones (unchanged). |
| SIP source address | One **reserved Google static IP per zone**, used only inside the tunnel, never attached to a VM. |
| Termination order | Verizon at the **bottom** of the LD list. GCS LCR replaces the static list eventually — no cost routing gets built here. |
| Inbound distribution | **Round robin across zones** where Verizon supports it; otherwise Primary East → Secondary West → Tertiary Central (§6). |
| Origination LCR | Somos (Granite is RespOrg). Not in our stack. |

---

## 1. What Verizon requires

### 1.1 Order form structure
- **SIP Gateway (new install):** Sections A, 1, 2 and 4. **ATF-IP:** Sections A, 1 and 3.
- **Section 1 (IPsec) is shared:** one tunnel set carries both services.
- **Section 4 (TN BETA form) is NOT in the workbook** Verizon sent. It's required for a new SIP Gateway 2-Way / IB Complete install (Section A K35).
- Section A is pre-marked "Move/Add/Change to Existing Service" with only Advanced Toll Free ticked. A new SIP Gateway install needs "Install New Service" + SIP Gateway → ask the SE whether that's one form or two (§10).

### 1.2 Addressing rules
- **IKE peer IP:** public, and **different from the SIP source IP** (Section 1 Q3, IKEv2 only).
- **SIP source IPs:** public, non-RFC1918 (Section 2 C7–C8).
- **ATF-IP terminations:** Verizon-provisioned FQDNs `<term>.<customer>.21sip.com`. No `, $ - ^ + _ #` characters. One test TFN per FQDN, ordered by the SE. All FQDNs are Primary; "Overflow and other toll-free routing features (such as Percentage Allocation) are ordered through Network Manager" (Section 3 C67).

### 1.3 IKEv2 profile and spec
Verizon's own note (Section 1 I18): IKEv2 comes as **Route Manager** or **Traffic Selector**; most customers pick Route Manager. We select **`IKE v2 H19 RM Opt2`** = `pre-g19-sha384-aes256cbc-8h / g19-esp-aes256gcm-1h` — route-based, single 0.0.0.0/0 proxy ID, **static routes, no BGP**.

The "IKEv2 Route Based 2024" spec additionally requires: static routes, IP-unnumbered tunnels, DPD 5 s only when idle, tunnels established immediately, tunnel DF bit cleared, MTU 1400 / TCP-MSS 1350, IKE 28800 s / ESP 3600 s, PFS group 19, anti-replay on, PSK auth, "General IKE-ID".

**Why not Google Cloud VPN** ▲: (i) Verizon requires a public, non-RFC1918 SIP source and Cloud VPN can only carry VPC addressing (BYOIP would be needed); (ii) HA VPN requires BGP, and Classic VPN's static route-based tunnels are on the deprecation path; (iii) MTU 1460, DF handling, DPD timing and the offered cipher set are not configurable. (Lifetimes are *not* an objection: IKEv2 lifetimes aren't negotiated, the shorter side simply rekeys first.) A Linux gateway meets every line exactly. One question worth asking anyway (§10): if Verizon would accept RFC1918 sources inside the tunnel, HA VPN with no NAT becomes a simpler fallback.

### 1.4 SIP Gateway specifics (Section 2)
- Per SIP source IP: service address, City/ST/Zip, NPA-NXX, **CCL** (concurrent call limit), service type (examples: `SIP OB`, `Shared`, `ANI`).
- Header method: **P-Asserted-Identity** (pre-ticked).
- STIR/SHAKEN options: Verification as a Service, Signing as a Service (+ attestation cert owner / level).
- Term Routing (2-Way / IB Complete only): all calls to Primary/Secondary/Tertiary IPs (pre-ticked), or split by NPA / rate center / state / area via spreadsheet. The detail table has a **"Customer DNS_SRV Record if used"** column.

---

## 2. Architecture (identical in each zone)

```
                    Verizon (SIP Gateway + ATF-IP SBCs, media)
                                   │ IKEv2 / ESP (no NAT-T)
          tunnel A ────────────────┴──────────────── tunnel B
   {zone}-vz-ike-a (static ext IP)          {zone}-vz-ike-b (static ext IP)
   protocol forwarding → gw-a               protocol forwarding → gw-b
┌───────────────────────────────┐        ┌───────────────────────────────┐
│ {zone}-vz-gw-a   (zone b)     │        │ {zone}-vz-gw-b   (zone c)     │
│ strongSwan, xfrm-vz (no IP),  │        │ identical config              │
│ MTU 1400, stateless 1:1 NAT   │        │                               │
└───────────────┬───────────────┘        └───────────────┬───────────────┘
                └── next-hop ILB {zone}-vz-gw-ilb (failover, HC = SA up) ──┘
                                   ▲
       VPC static routes: Verizon SIP + media prefixes → ILB (tag vz-{zone} only)
           ┌───────────────────────┼────────────────────────┐
   SBC Verizon VIP 10.x.0.251   FS-1 192.168.x.2         FS-2 192.168.x.3
   (new fwd rule on the zone's  (RTP)                    (RTP)
    existing signaling backend)
```

### 2.1 Two kinds of address, kept apart as Verizon requires
1. **IKE peer IPs:** two reserved static external IPs per zone (6 total = the 6 Section 1 slots), attached to the gateways by **protocol forwarding**. The VM owns the IP directly, so there's no 1:1 NAT in the IKE path and no NAT-T.
2. **Inside-tunnel addresses** (what Verizon sees as our SIP and media sources), translated 1:1 on the gateways, statelessly:

| Purpose | Inside-tunnel address (Verizon sees) | Translates to (VPC) |
|---|---|---|
| SIP | `{zone}-vz-sip` — new reserved IP, **never attached** | `10.x.0.251` — a NEW backend service `{zone}-sbc-verizon-backend` over the SAME two SBC instance groups, same fs-aware health check, same failover policy, one `L3_DEFAULT`/all-ports forwarding rule ▲ (the proven pattern from the signaling ILB: zero touch on the live signaling backend; all-ports also lets PMTU ICMP reach the SBC) |
| Media, FS-1 | FS-1's **existing** public IP | FS-1 NIC IP |
| Media, FS-2 | FS-2's **existing** public IP | FS-2 NIC IP |

**Design change vs the 2026-10-08 plan — media reuses the FS public IPs.** FreeSWITCH already puts its public IP in SDP `c=` on both profiles. If Verizon routes those /32s into the tunnel and our gateways translate them to the FS NIC IPs, FreeSWITCH needs **no new sofia profile, no per-trunk profile column, no new `;fs=` marker and no FS rebuild**. Verizon's route for those /32s exists only inside Granite's Verizon VPN; Bandwidth and Sinch keep reaching the same IPs over the internet. The open question is whether Verizon accepts media addresses that also exist on the public internet (§10). **Fallback if they refuse:** reserve 2 more Google IPs per zone for media and add a `verizon` FS profile whose `ext-rtp-ip` is that address (the 10-08 design: a third profile, a per-trunk profile column in `carrier_trunks`, a new `;fs=` marker).

### 2.2 Per-zone values

| | East (us-east1) | West (us-west1) | Central (us-central1) |
|---|---|---|---|
| IKE peer IPs (reserved 2026-10-30) | `east-vz-ike-a` **35.231.206.85**, `east-vz-ike-b` **34.26.69.151** | `west-vz-ike-a` **8.231.131.118**, `west-vz-ike-b` **136.66.170.29** | `central-vz-ike-a` **34.68.252.50**, `central-vz-ike-b` **34.171.191.175** |
| SIP inside-tunnel IP (reserved 2026-10-30) | `east-vz-sip` **34.148.100.185** | `west-vz-sip` **136.86.242.57** | `central-vz-sip` **35.184.132.124** |
| SBC Verizon VIP (new internal fwd rule) | `10.142.0.251` → `sbc-verizon-backend` / `sbc-verizon-fwd` (live 2026-10-30) | `10.138.0.251` → `west-sbc-verizon-backend` / `west-sbc-verizon-fwd` (live 2026-10-30) | `10.128.0.251` → `central-sbc-verizon-backend` / `central-sbc-verizon-fwd` (live 2026-10-30, unhealthy until the Kamailio :8080 bind) |
| FS-1 media | `34.139.119.135` ⇄ `192.168.10.2` | `8.229.177.165` ⇄ `192.168.20.2` | `35.253.103.114` ⇄ `192.168.30.2` |
| FS-2 media | `35.196.226.123` ⇄ `192.168.10.3` | `35.197.95.171` ⇄ `192.168.20.3` | `34.63.100.161` ⇄ `192.168.30.3` |
| Gateway subnet (new) | `vz-ipsec-east` 192.168.11.0/28 (created 2026-10-30) | `vz-ipsec-west` 192.168.21.0/28 (created 2026-10-30) | `vz-ipsec-central` 192.168.31.0/28 (created 2026-10-30) |
| Gateways | `east-vz-gw-a` (us-east1-b, 192.168.11.2), `east-vz-gw-b` (us-east1-c, 192.168.11.3) — built 2026-10-30 | `west-vz-gw-a` (us-west1-b, 192.168.21.2), `west-vz-gw-b` (us-west1-c, 192.168.21.3) — built 2026-10-30 | `central-vz-gw-a` (**us-central1-a**, 192.168.31.4), `central-vz-gw-b` (**us-central1-f**, 192.168.31.5) — built 2026-10-30; b/c were stocked out of n2-standard-2 |
| Route tag | `vz-east` | `vz-west` | `vz-central` |

**New reserved IPs: 9** (6 IKE + 3 SIP) — all reserved 2026-10-30, values above. **Gateways get NO primary external IP** ▲ — the forwarded IKE IP is the VM's only public identity (§3.1), so a mis-sourced packet fails loudly instead of leaving as a second public IP Verizon has never seen. VERIFY before building: `.251` is free in each region's `default` subnet; the three /28s collide with nothing; gw-b zones have e2 capacity.

### 2.3 Gateway failover
- A next-hop internal passthrough LB in front of the pair: gw-a primary, gw-b failover, failback on, `drop-traffic-if-unhealthy`. Its health check (§3.4) passes only while that gateway's tunnel AND local datapath are good.
- **Both tunnels are always up** (spec: establish immediately), so a flip is only the VPC route moving (~10 s HC detection) **plus IKE dead-peer detection** ▲ — with strongSwan defaults a dead peer takes ~165 s to declare (DPD retransmit schedule), so §3.2 tightens retransmits to ~25 s. Verizon's side keeps sending on tunnel A until *their* DPD fires — ask for their timers (§10).
- ▲ Caveat: when BOTH gateways are unhealthy the VPC route is not withdrawn — packets drop. Nothing falls through to a lower-priority route.
- **All six gateways and all three next-hop ILBs are built before the first Verizon test** (owner decision 2026-10-29). Testing and acceptance happen on the final topology; nothing is added or re-pointed after the "good to go". (A single-gateway `--next-hop-instance` turn-up was considered and rejected: it would mean a route change after acceptance.)
- The NAT rules are **stateless and identical** on both gateways. Verizon can send on tunnel B while we reply on tunnel A; established calls survive a gateway flip with a short audio gap.
- Ask Verizon to prefer tunnel A per zone.

---

## 3. Gateway configuration (spec → strongSwan)

### 3.1 Addressing on the gateway ▲
GCP external protocol forwarding (forwarding rule → `target-instance`, `L3_DEFAULT`) delivers packets to the NIC with **dst = the forwarded IP preserved** (no DNAT, unlike a VM's own 1:1-NAT external IP). The guest agent adds a `local <IKE_IP>/32` route. But which public IP *sources* an outbound packet is decided per packet by the source address the VM puts in it — the default route and charon both pick the NIC IP unless told otherwise, and that would leave as the VM's primary external IP (or be dropped with none). So, all three:
1. `ip addr add <IKE_IP>/32 dev ens4` (charon enumerates real addresses, not guest-agent local routes).
2. `swanctl` `connections.vz.local_addrs = <IKE_IP>` → IKE and the SAs' outer source are the IKE IP; no NAT detection, no flip to 4500.
3. No primary external IP on the VM (§2.2). Internet access for apt: `ip route replace default via <subnet-gw> dev ens4 src <IKE_IP>` + `10.0.0.0/8` and `192.168.0.0/16` routes with `src <NIC_IP>` (VPC traffic stays NIC-sourced). The forwarded IP carries the TCP replies and the VPC firewall is stateful. VERIFIED 2026-10-30 on `vz-proof` (§11 Phase 0). Enable Private Google Access on the /28s. `bypass-vpn` tag still mandatory.

### 3.2 IKE / ESP

| Spec | Setting (`swanctl.conf` unless noted) |
|---|---|
| IKE `pre-g19-sha384-aes256cbc-8h` | `proposals = aes256-sha384-ecp256` (only) · `rekey_time = 27000s` · `over_time = 1800s` (hard limit 28800 s; IKE has no `life_time`) |
| ESP `g19-esp-aes256gcm-1h`, PFS 19, tunnel mode | `esp_proposals = aes256gcm16-ecp256` · `mode = tunnel` · `rekey_time = 3240s` · `life_time = 3600s` |
| PSK | `auth = psk`. Key in `/etc/swanctl/conf.d/secrets.conf` (mode 600) — never in git, OpenTofu or a committed `.env` |
| DPD 5 s, idle only | `dpd_delay = 5s` (strongSwan only sends DPD when nothing has been received for the delay) · `dpd_action = restart` |
| ▲ Dead-peer detection time | `charon.retransmit_timeout = 2.0`, `retransmit_base = 1.5`, `retransmit_tries = 4` (≈26 s to declare dead vs ≈165 s default). Local only; does not change what Verizon sees |
| Establish immediately | `start_action = start` · `close_action = start` · `keyingtries = 0` |
| Clear DF | `children.vz.copy_df = no` |
| MTU 1400 | XFRM interface `xfrm-vz` `mtu 1400` |
| TCP-MSS 1350 | nftables MSS clamp on forward (§3.3) |
| Anti-replay | ▲ `replay_window = 128` (per-child; the default 32 is one RTP reorder burst away from drops under ECMP). No ESN: `noesn` is the proposal default — there is NO `esn` child option (charon 5.9.8 discards the whole connection on it; caught in verification 2026-10-30) |
| General IKE-ID | `local id = <IKE_IP>`, `remote id = <Verizon peer IP>` — **confirm with Verizon** |
| IP unnumbered | `ip link add xfrm-vz type xfrm if_id 42` (persist via systemd-networkd `.netdev` `Kind=xfrm`, `InterfaceId=42`, `Independent=yes`), no address; `children.vz.if_id_in = 42`, `if_id_out = 42` |
| Static routes | ▲ `charon.install_routes = no`, `install_virtual_ip = no`. Manual: `ip route add <VZ_PREFIX> dev xfrm-vz` **plus** `ip route add blackhole <VZ_PREFIX> metric 200` (if `xfrm-vz` drops, packets die locally instead of looping default-route → ILB → same gateway). `/32` host routes for Verizon's IKE peer IPs via `ens4` in case they sit inside a declared prefix. GCP: static routes → next-hop ILB |
| Option 2 proxy ID | `local_ts = 0.0.0.0/0` · `remote_ts = 0.0.0.0/0` |
| No NAT-T | `encap = no` (default) · `mobike = no` · `charon.interfaces_use = ens4` |

**OS:** Debian 12, strongSwan 5.9.x. `net.ipv4.ip_forward=1`; `rp_filter=2` on `xfrm-vz`; `send_redirects=0`, `accept_redirects=0`. Verify `grep -A3 rfc4106 /proc/crypto` shows `driver: rfc4106-gcm-aesni` (software GCM is ~10× slower). chrony → metadata.

### 3.3 Stateless 1:1 NAT ▲
`notrack` + `snat`/`dnat` **does not work** — nft NAT statements run in the conntrack NAT engine, which skips untracked packets. The stateless primitive is **payload mangling in filter-type chains** (`ip daddr set` / `ip saddr set`); the kernel fixes the IPv4 header checksum and the UDP/TCP pseudo-header checksum automatically (Debian 12 kernel 6.1 / nft 1.0.6). Rules are **IP-only, no port match**, so non-first UDP fragments are translated identically.

```
table ip vz {
  chain vz_pre  { type filter hook prerouting priority raw; policy accept;   # before routing
    iifname "xfrm-vz" ip daddr ZONE_SIP ip daddr set 10.X.0.251
    iifname "xfrm-vz" ip daddr FS1_PUB  ip daddr set FS1_NIC
    iifname "xfrm-vz" ip daddr FS2_PUB  ip daddr set FS2_NIC }
  chain vz_fwd  { type filter hook forward priority filter; policy drop;      # 'fwd' alone is a reserved nft keyword (verified: parse error)
    tcp flags syn tcp option maxseg size set 1350
    iifname "xfrm-vz" ip saddr { VZ_PREFIXES } ip daddr { 10.X.0.251, FS1_NIC, FS2_NIC } accept
    iifname "ens4"    ip daddr { VZ_PREFIXES } ip saddr { 10.X.0.251, SBC1, SBC2, FS1_NIC, FS2_NIC } accept }
  chain vz_post { type filter hook postrouting priority 100; policy accept;  # after routing, before xfrm encap
    oifname "xfrm-vz" ip saddr { 10.X.0.251, SBC1, SBC2 } ip saddr set ZONE_SIP
    oifname "xfrm-vz" ip saddr FS1_NIC ip saddr set FS1_PUB
    oifname "xfrm-vz" ip saddr FS2_NIC ip saddr set FS2_PUB } }
```
- **conntrack must never load:** no `ct`/`nat` expressions, `blacklist nf_conntrack` in modprobe.d, and **no Docker on the gateways** (Docker loads conntrack + iptables NAT). The gateways deploy by `git pull` + a plain install script, not compose.
- Accepted limitation: ICMP errors' embedded inner headers aren't translated; Verizon-originated ICMP errors naming ZONE_SIP reach the SBC unmatched and are ignored.
- Verify: `nft --debug=netlink` shows `csum_flags 0x1` on the payload writes; tcpdump `-vv` shows `cksum ... (correct)` both sides. Ruleset verified 2026-10-30 with nft 1.0.6 in a Debian 12 container (`nft -c -f`, loaded, 6 csum-fixing payload writes). Implementation: `infra/vz-ipsec/` (PR `feat/vz-ipsec-gateways`).

### 3.4 MTU — the real fix is on the SBCs and FSes ▲
Arithmetic: inner 1400 → 20 (outer IP) + 8 (SPI/seq) + 8 (GCM IV) + 1404 (padded) + 16 (ICV) = **1456 ≤ 1460** (VPC MTU). Four bytes of margin — which is why "no NAT-T" is load-bearing (UDP encap adds 8 → every full-size packet becomes two outer fragments). Don't touch the VPC MTU.

The trap: Linux UDP sockets send datagrams that fit the route MTU **with DF set** (`IP_PMTUDISC_WANT`). A 1430-byte INVITE (Identity + div PASSporT + SDP is routine) leaves the SBC with DF, exceeds `xfrm-vz`'s 1400 at the gateway, and is dropped with an ICMP frag-needed that the SBC may never receive — Kamailio retransmits until the transaction times out. **Fix:** on every SBC, a per-destination MTU hint, `ip route add <VZ_PREFIX> via <subnet-gw> dev ens4 mtu lock 1400` (added by the Kamailio entrypoint, which has `NET_ADMIN` and host networking). **Not on the FSes** (decided 2026-10-30): FS sends SIP to the SBC, never to Verizon, and the only FS→Verizon traffic is RTP/RTCP, far below 1400 B. Also, the FS `entrypoint.sh` does not run in production (the Dockerfile `ENTRYPOINT` is the freeswitch binary; compose sets no override), so an FS route there would have been inert anyway. The kernel then fragments UDP at 1400 locally and sets TCP MSS correctly without an ICMP round trip. Do **not** use Kamailio's `udp_mtu`/`udp_mtu_try_proto` — it's global and would hit the FS `:5080` dispatch and PBX legs too (`kamailio.cfg:527-536`). With `copy_df=no`, an inner packet that still exceeds 1400 is encapsulated whole and the outer is fragmented at 1460; Verizon's "DF cleared" line implies they reassemble pre-decrypt.

### 3.5 Health endpoint ▲
HTTP on `0.0.0.0:8081/healthz` (probes are VIP-addressed, so also `ip route add local <GW_ILB_IP>/32 dev lo` in the install script — otherwise `ip_forward` would forward the probe back out `ens4`). Returns 200 only if ALL of: `swanctl --list-sas --raw` shows the `vz` CHILD_SA `INSTALLED`; `xfrm-vz` UP with MTU 1400; `ip route get <VZ_PREFIX>` resolves to `xfrm-vz`; `nft list table ip vz` loads; `XfrmOutNoStates` delta over 30 s == 0; no drain file (`/run/vz-drain`, for deliberate failover before patching). Do NOT use "inbound ESP bytes increasing" — Verizon will likely send only on its preferred tunnel. Export the same booleans as textfile metrics (`vz_ipsec_sa_up{zone,gw}` etc.) and enable node_exporter's native `--collector.xfrm` (`XfrmInStateSeqError` = replay drops, `XfrmOutNoStates` = black-hole indicator) for a NOC dashboard panel.

### 3.6 Capacity ▲
ESP has no ports, so **all inbound decrypt for a tunnel lands on one CPU**. 1,000 calls ≈ 100 k pps per direction; at ~5 µs/pkt realistic (netfilter + xfrm + forward) that's one e2 vCPU at 50 %+. Build on n2-standard-2 from the start (an e2 would need a post-acceptance resize). Load-test gw-a↔gw-b back-to-back with the banked `west-loadtest` SIPp harness before Verizon turn-up. ESP sequence overflow needs no ESN (an SA lives ~54 min ≈ 3×10⁸ packets at that rate).

**Repo layout:** `infra/vz-ipsec/` — templates for `swanctl.conf`, `strongswan.d/charon.conf` overrides, `nftables.conf`, `sysctl.d`, the networkd `.netdev`, the health service and an install script, rendered per gateway from its local `/opt/revup/.env` (zone IPs + Verizon prefixes; PSK stays in `secrets.conf`).

## 4. GCP resources per zone

**Build status 2026-10-30:** every Verizon-independent object below exists in all three zones (IPs, subnets, gateways, protocol forwarding, gateway ILBs, `.251` backends, the IAP/HC/internal-forward firewall rules). `vz-{zone}` tags go on the 12 production SBC/FS VMs (East `poc-custom-voip`, `kam-g2`, `fs-media-v2`, `east-fs-2`; West `west-sbc-1/2`, `west-fs`, `west-fs-2`; Central `central-sbc-1/2`, `central-fs`, `central-fs-2`; NOT `fs-media` 10.142.0.102, the sandbox replica). Still to build once Verizon's prefixes arrive: the prefix-specific firewall rules and the tagged routes.

| Resource | Details |
|---|---|
| Static external IPs | `{zone}-vz-ike-a`, `{zone}-vz-ike-b`, `{zone}-vz-sip` (regional). The SIP IP's description says **never attach** |
| Subnet | `vz-ipsec-{zone}` (/28 above). **Must not be covered by Cloud NAT** |
| VMs | `{zone}-vz-gw-a` / `-b` in two different zones of the region (any two with n2 stock; Central landed in `-a`/`-f`), **n2-standard-2** (sized for the end state up front — §3.6; no post-acceptance resize), Debian 12, **no external IP**, `can_ip_forward=true`, tags `bypass-vpn`, `vz-ipsec` |
| Protocol forwarding | One target instance per gateway (`NO_NAT`); one forwarding rule on its IKE IP with `--ip-protocol=L3_DEFAULT --ports=ALL` (`--ports=ALL` is mandatory for L3_DEFAULT, learned 2026-10-30). Covers ESP + UDP 500 + the apt/HTTPS replies of §3.1 |
| Next-hop ILB | Two unmanaged instance groups (gw-a primary, gw-b failover) → backend service `{zone}-vz-gw-backend`, failover policy (`failover-ratio=0`, `drop-traffic-if-unhealthy`), HTTP :8081 health check → forwarding rule `{zone}-vz-gw-ilb` (`INTERNAL`, **`--ip-protocol=UDP --ports=ALL`, IP in the `vz-ipsec-{zone}` subnet**). ▲ **Not `L3_DEFAULT`**: GCP refuses an L3_DEFAULT rule as a route next hop (proven 2026-10-30: "not supported as next hop forwarding rule"). A next-hop-ILB route forwards every IP protocol regardless of the rule's declared protocol, so UDP is only a label here. Backend service `--protocol=UDP`, `--network=default`. Backends need `can_ip_forward` (they emit packets with Verizon source IPs after DNAT). Destination IP is preserved through the ILB, so the gateway's `xfrm-vz` route applies |
| SBC Verizon VIP | ▲ New backend service over the existing SBC instance groups + one `L3_DEFAULT` forwarding rule at `10.x.0.251` (§2.1). Names follow the signaling-ILB convention checked 2026-10-29: East `sbc-verizon-backend` / `sbc-verizon-fwd` (East has no zone prefix: `sbc-signaling-fwd`), West/Central `{zone}-sbc-verizon-backend` / `-fwd` |
| VPC routes | Verizon SIP + media prefixes → `{zone}-vz-gw-ilb`, priority 100, **tags `vz-{zone}`** on that zone's SBCs and FSes only (**both** SBCs and both FSes). ▲ All three zones get the same prefixes, so this is three routes with identical destination + priority distinguished only by tag — tag support on next-hop-ILB routes was **proven 2026-10-30** (§11 Phase 0), so the three zones' routes are isolated by tag as designed. Peerings checked 2026-10-29: only the Cloud Build private-pool peering exports custom routes; harmless (nothing there sends to Verizon prefixes) |

**Firewall (new rules only):**
- Verizon IKE peers → `vz-ipsec`: UDP 500, ESP (UDP 4500 only if Verizon insists on NAT-T).
- Verizon SIP prefixes → `voip-sbc`: 5060 UDP + TCP.
- Verizon media prefixes → `voip-media`: UDP 16384–49151 (the FS RTP range).
- SBC + FS subnets → `vz-ipsec`: all (forwarded traffic). (No "gateway → voip-sbc/voip-media" rule needed: the source the SBC/FS sees is the Verizon IP, and existing carrier-prefix rules are destination-agnostic, so they cover `.251`.)
- Health-check ranges `35.191.0.0/16`, `130.211.0.0/22` → `vz-ipsec`: TCP 8081.
- IAP range → `vz-ipsec`: TCP 22 (no public SSH on the IKE IP). Created 2026-10-30 as `vz-ipsec-allow-iap-ssh`.

### 4.1 As-built inventory (2026-10-30, all three zones)

| Object | East (us-east1) | West (us-west1) | Central (us-central1) |
|---|---|---|---|
| IKE A / IKE B / SIP (reserved, unattached) | 35.231.206.85 / 34.26.69.151 / 34.148.100.185 | 8.231.131.118 / 136.66.170.29 / 136.86.242.57 | 34.68.252.50 / 34.171.191.175 / 35.184.132.124 |
| Subnet `vz-ipsec-{zone}` (PGA on, not NATed) | 192.168.11.0/28 | 192.168.21.0/28 | 192.168.31.0/28 |
| `{zone}-vz-gw-a` (n2-standard-2, no ext IP, deletion-protected) | us-east1-b, 192.168.11.2 | us-west1-b, 192.168.21.2 | **us-central1-a**, 192.168.31.4 |
| `{zone}-vz-gw-b` | us-east1-c, 192.168.11.3 | us-west1-c, 192.168.21.3 | **us-central1-f**, 192.168.31.5 |
| Target instances + L3_DEFAULT all-ports rules | `{zone}-vz-gw-a-ti`/`-b-ti`, `{zone}-vz-gw-a-fwd`/`-b-fwd` | same | same |
| Groups → backend `{zone}-vz-gw-backend` (UDP, failover-ratio 0, drop-if-unhealthy, no drain; HC `{zone}-vz-gw-hc` :8081 5s/5s/2/2) | `east-vz-gw-a-group` primary, `-b-group` failover | same | same |
| Gateway ILB `{zone}-vz-gw-ilb` (UDP, all ports) | **192.168.11.4** | **192.168.21.4** | **192.168.31.2** |
| SBC Verizon VIP backend / rule (UNSPECIFIED, L3_DEFAULT all ports, existing SBC groups + fs-aware HC) | `sbc-verizon-backend` / `sbc-verizon-fwd` 10.142.0.251 | `west-sbc-verizon-backend` / `-fwd` 10.138.0.251 | `central-sbc-verizon-backend` / `-fwd` 10.128.0.251 |
| Route tag applied | `vz-east` on poc-custom-voip, kam-g2, fs-media-v2, east-fs-2 | `vz-west` on west-sbc-1/2, west-fs, west-fs-2 | `vz-central` on central-sbc-1/2, central-fs, central-fs-2 |

Shared firewall rules (all zones): `vz-ipsec-allow-iap-ssh` (35.235.240.0/20 → `vz-ipsec` tcp:22), `vz-ipsec-allow-hc` (35.191.0.0/16 + 130.211.0.0/22 → `vz-ipsec` tcp:8081), `vz-ipsec-allow-internal-fwd` (all zone/media/gateway subnets → `vz-ipsec` all). Phase 0 proofs both passed (tags on next-hop-ILB routes; forwarded-IP sourcing with no external IP). **Not yet built (needs Verizon's prefixes):** `vz-ipsec-allow-ike` (peers → `vz-ipsec` udp:500 + ESP), `vz-allow-verizon-sip` (SIP prefixes → `voip-sbc` 5060), `vz-allow-verizon-rtp` (media prefixes → `voip-media` udp:16384-49151), and the tagged `--next-hop-ilb` routes. Nothing carries traffic until those routes exist; the `.251` and gateway backends read unhealthy until the Kamailio `:8080` bind and the gateway health service ship.

**Shared project:** `rugged-night-193017` also hosts TED. This plan only **adds** resources. Checked 2026-10-29: the only Cloud Router is `vpc-connector-router` (us-east1), so Cloud NAT can exist only in East; West and Central gateways have NO internet path except the forwarded IP (§3.1 proof is load-bearing for apt there). East NAT `ted-auto-dialer-nat` checked 2026-10-30: `LIST_OF_SUBNETWORKS` = `default` + `ted-auto-dialer-subnet` (primary ranges only), so `vz-ipsec-east` is never NATed. Never change that NAT to ALL_SUBNETWORKS.

**OpenTofu:** the gateways and their IPs join `infra/` with `prevent_destroy = true` once the zone works (same pending-import status as the rest).

---

## 5. Call flows

**Toll-free inbound (ATF-IP).** Somos → Verizon → `east1.<label>.21sip.com` → East SIP IP → tunnel → gateway translates to `10.142.0.251` → active SBC → FS-1 `:5080` (the existing internal profile). FS answers with its public IP in SDP; Verizon sends RTP to it through the tunnel.

**DID inbound (SIP Gateway 2-Way).** Same path. Verizon picks the zone by Term Routing (§6).

**Termination.** RCF forward → `term_trunks` reaches the Verizon row (only after Bandwidth and Sinch fail, §7) → `X-Carrier-IP` = Verizon SIP Gateway IP → SBC `route[TO_CARRIER]` Verizon branch sends from the `10.x.0.251` socket, advertising the zone SIP IP → VPC route → next-hop ILB → gateway → tunnel. B-leg SDP carries the FS public IP as today.

**In-dialog.** Verizon → zone SIP IP → `.251` → active SBC; the existing stateless `;fs=5080` / `;fs=5090` dispatch applies unchanged. For Verizon dialogs, **every** Verizon-visible address — outer Record-Route, Contact, From host, PAI host, Diversion host, and the Contact Kamailio rewrites into FS-originated replies and in-dialog requests — must render the zone SIP IP instead of the NLB VIP (§8.1 ▲).

---

## 6. Inbound distribution across zones

| Service | Mechanism | Setting |
|---|---|---|
| Toll-free (ATF-IP) | **Percentage Allocation** in Verizon Network Manager (Section 3 C67), ordered by Granite, not on this form | ~34/33/33 across `east1` / `west1` / `cent1` FQDNs, with overflow to the other two |
| DIDs (SIP Gateway) | Term Routing **"Customer DNS_SRV Record"** (Section 2 G51) | One SRV name with three equal-priority, equal-weight targets → even split |
| DIDs, if Verizon won't load-share on SRV | Term Routing Primary / Secondary / Tertiary | **East → West → Central** |

**SRV record** (Granite DNS team, Infoblox, `granitevoip.com` — name TBD, must not be under `21sip.com`):
```
_sip._udp.vzgw.granitevoip.com.  SRV 10 10 5060 east.vzgw.granitevoip.com.
_sip._udp.vzgw.granitevoip.com.  SRV 10 10 5060 west.vzgw.granitevoip.com.
_sip._udp.vzgw.granitevoip.com.  SRV 10 10 5060 central.vzgw.granitevoip.com.
east.vzgw.granitevoip.com.       A   <east-vz-sip>      (likewise west, central)
```
- Plain static records. **No Infoblox DTC health monitor:** it can't reach tunnel-only addresses. A dead zone is handled by Verizon's SRV client moving to the next target.
- `_udp` vs `_tcp` follows the transport answer (§10).

---

## 7. Termination selection

Today's LD order (`carrier_trunks`, effective per-zone priority):

| Priority | Row | Class | Enabled |
|---|---|---|---|
| 10 / 20 | bandwidth dallas / la | any | yes |
| 30 | sinch atlanta-ld | ld | yes |
| 35 | sinch denver-ld | ld | **no** (seeded disabled, migration 53) |
| **50 (new)** | **verizon** | ld | **no** until turn-up |

- **New rows:** one `outbound` row per Verizon SIP Gateway IP (`carrier='verizon'`, pop = Verizon SBC name, `traffic_class='ld'`, priority 50, `priority_<zone>` to prefer the nearest Verizon SBC), `enabled=false`. Forced test calls temporarily set the zone priority to 1, then restore it (same procedure as the Sinch test). ▲ Inbound admission is static (flag 5), so no `inbound` row is *required*, but add them for TED/NOC joins (the `orig_map` pattern in migration 53).
- **Attempt cap removed — hunt through every enabled carrier** (owner decision 2026-10-29). Today `lib/term_trunks.lua:47` `M.MAX = 4` and `inbound_router.lua:552` `TERM_TRUNKS_MAX = 4` truncate the eligible list **after** the class filter, so a bottom-priority row is silently never tried once four higher rows are enabled (with denver-ld disabled there are only 3 LD rows today; enabling it would hide Verizon). Change: delete the post-filter `cap()` call in `inbound_router.lua:1796-1803` and the `M.cap(eligible, M.MAX)` in `M.select_tollfree` (`term_trunks.lua:395`); drop `M.MAX`; the list is bounded only by `M.CACHE_MAX = 16` rows per zone (the serialized global-var cache), which is the operator's real knob. Fix the `:546-552` comment and the "8-attempt cap" log text. Order is unchanged: `eff_priority` ascending, so Verizon at 50 is reached only after every Bandwidth and Sinch row has failed.
- ▲ **Worst case grows with the list**: N trunks × attempts per trunk × (`progress_timeout` 10 s + ≤1 s TCP probe). With 5 enabled LD rows and 2 SBC targets each that is ~110 s of ringback before the caller hears 503. Two mitigations ship with the removal: (a) `build_attempts` emits **only the signaling-VIP attempt** for Verizon rows (the SBC-1-direct attempt can't work for Verizon — §8.3), and (b) attempts whose SBC target failed the cached TCP pre-check are skipped in < 1 s, so the ~110 s is the carriers-silent case, not the SBC-down case. Verify the originating carriers' INVITE/ring timers tolerate the bound (Bandwidth/Sinch typically 60–180 s); if they don't, the knob is `BRIDGE_PROGRESS_TIMEOUT`, not a row cap.
- **8YY stays on Sinch.** Toll-free destinations only use `tollfree` rows (strict filter), and there's one egress row per IP (migration 53). Verizon toll-free termination would need a second Verizon egress IP as a `tollfree` row — not planned.
- ▲ **5xx carrier failover chain: Verizon stays out, correctly.** Table-driven (X-Carrier-IP) calls set flags 8+9 so `CARRIER_FAILURE` never flips to another carrier; the legacy `X-Carrier` path can only name Bandwidth. No change needed.
- **GCS later:** when the GCS interface is known it becomes the top of the list (or replaces it). This row stays as a fallback or is removed.

## 8. Platform changes (one PR, ships dark)

New SBC env: `VERIZON_VIP` (`10.x.0.251`), `VERIZON_SIP_IP` (zone inside-tunnel IP), `VERIZON_SIP_NETS` (Verizon signaling prefixes incl. monitoring hosts), `VERIZON_TF_IPS` (ATF-IP sources, if distinct). **Unset ⇒ compiled out, byte-identical config** (the `SBC_SIGNALING_VIP` / `SBC_PEER_INTERNAL_IP` pattern). ▲ Every new var must be listed in `docker-compose.sbc.yml` `environment:` or the container never sees it (`docker/kamailio/CLAUDE.md` §8.13 item 4). Verizon mode is forced OFF unless `SBC_SIGVIP_MODE=dedicated` (a `.251` rule on the signaling backend is meaningless in legacy mode — same forcing `VIP_EGRESS` gets).

### 8.1 Kamailio (`docker/kamailio/`)
1. **Listen + loopback** ▲: `listen=udp/tcp:VERIZON_VIP:5060 advertise VERIZON_SIP_IP:5060`; `listen=tcp:VERIZON_VIP:8080` (ILB probes are VIP-addressed; `/healthz` already serves on any TCP listen); `alias` for both addresses (keep `alias=VERIZON_SIP_IP:5060` as belt-and-braces for the r2 double-pop, U1). **`entrypoint.sh` must `ip addr add VERIZON_VIP/32 dev lo`** exactly like the signaling VIP block (`entrypoint.sh:632-653`, with the `" IP/"` grep guard) — a listen on a non-local address is a fatal startup error. Each UDP listen forks `children=16` more workers; check the pkg memory flag in compose.
2. **Every Verizon-visible address, not just Record-Route** ▲: today `ADVERTISE_IP` is hardcoded into From (`kamailio.cfg:4344`), Diversion (`:4473`), Contact (`:4504`), PAI (`:4650/4652`), the Contact rewrite on every FS-originated reply (`:5790` — that's the 200 OK Verizon gets on inbound calls), and the Contact rewrite on FS-originated in-dialog ACK/BYE/re-INVITE (`:2900`, `:2995`, `:3148`). Verizon can't reach the NLB VIP inside the tunnel and may screen Contact/PAI hosts against the declared source IPs. Fix: a `$var(egress_adv)` (= `VERIZON_SIP_IP` when the egress IP is in `VERIZON_SIP_NETS`, else `ADVERTISE_IP`) used at all request-side sites + the RR presets (`:1572-1577`, `:4568-4573`); a transaction AVP set at ingress / TO_CARRIER for the reply-side rewrite at `:5790` (AVPs are visible in `onreply_route`); for FS-originated in-dialog requests decide from the echoed Route set before `loose_route()` consumes it (the `:2489-2496` technique) or from `$fs` after the r2 pop.
3. **Egress** ▲: in `route[TO_CARRIER]`, when the validated `X-Carrier-IP` is in `VERIZON_SIP_NETS` → `$fs = "udp:VERIZON_VIP:5060"` (Via renders from that socket's advertise — the same mechanism `VIP_EGRESS` uses at `:5249-5255`). Place it **outside** the `VIP_EGRESS`/`SBC_SIGVIP_DEDICATED` nesting, after it, keyed on a static `VERIZON_NET_*` define (no DB dependency; the Step 1a lookup is `SELECT 1`). **Direct-IP ingress can't work for Verizon**: all Verizon return traffic lands on `.251` → the ACTIVE SBC regardless of which SBC sent the request, so an FS failover attempt via `SBC_PROXY_IP_FAILOVER` (SBC-1 direct) while SBC-1 is standby strands the reply on SBC-2 → local 408. Reject a Verizon-bound INVITE whose `$Ri == SBC_INTERNAL_IP` with an immediate 503 (`t_newtran` + `t_reply`, like the 8YY guard at `:4214-4218`) so FS moves on instantly; FS side emits VIP-only attempts for Verizon (§7).
4. **Peer reply hand-off guard** ▲: `:5619` keys on `$Ri == "ADVERTISE_IP"` only. Extend to `($Ri == "ADVERTISE_IP" || $Ri == "VERIZON_VIP")` inside the `SBC_PEER_HANDOFF` ifdef, and make `SBC_PEER_INTERNAL_IP` a **documented prerequisite** for enabling Verizon in a zone — otherwise the standby's `.251`-sourced OPTIONS probes get their replies on the active with no transaction and the standby reads Verizon DOWN forever (the pre-§8.12 Sinch bug).
5. **Static trust** (flag 5) for `VERIZON_SIP_NETS` in the trust block (`:1372-1384`) AND the carrier-ingress branch condition (`:1656`). DB-only `carrier_trunks` carriers hit pike/SCANNER_DETECT (`:316`). ▲ Untrusted OPTIONS are flood-tracked and blocked after 20/60 s (`:1591-1598`), so **every Verizon OPTIONS-probe source** must be in the list — ask for the full signaling list including monitoring hosts (§10).
6. **Attribution arms** ▲: `X-Inbound-TC` (`:2063-2068`) and `X-Inbound-Carrier` (`:2133-2144`) default to `tc4`/`bandwidth` in their `else` arms. Add Verizon arms mirroring the Sinch ones (`:2047-2050`, `:2119-2124`): TC header `tc4` (egress is Bandwidth-first), label/carrier `verizon`, PoP = zone or Verizon SBC name — else CDR `inbound_carrier`, `kamailio_trunk_cps{trunk}` and the `carrier_trunk` dialog profile misattribute Verizon to Bandwidth. `bw_dedup`/`bw_cps`, STIR Identity capture and verstat-in-PAI parsing then apply unchanged.
7. **Toll-free ingress class** ▲: `TF_INGRESS_ENFORCE` sets `$var(tf_src)=1` only for the Sinch TF IPs (`:1669-1674`); 8YY R-URIs from a non-TF source are rejected 404 (`:3546-3549`) and non-8YY from a TF source likewise (`:3529-3544`). There is no "mixed" class. Add `VERIZON_TF_IPS` to the TF arm. **If Verizon's ATF-IP and SIP Gateway share signaling IPs, a third class (skip the TF check for those sources) is needed — decide before Phase 3.** Also confirm the ATF-IP R-URI user is the dialed 8YY TFN, not a translated DNIS (the Sinch non-8YY test TNs needed `TF_TEST_TNS` for exactly this).
8. **RFC1918 scrub guard** ▲ (conditional on Verizon's prefixes): `REPLY_HANDLER` rewrites `IN IP4 10.x/172.28.x/127.x` in carrier replies to `ADVERTISE_IP` (`:5770-5775`). If any Verizon media address is RFC1918 this corrupts their SDP — gate the scrub on the source not being a Verizon address.
9. **Dispatcher + carrier-monitor** ▲: a new OPTIONS group for the Verizon SIP Gateway IPs with `socket=udp:VERIZON_VIP:5060`; the `dispatcher.list` line must render as a comment when `VERIZON_VIP` is unset (the `__SBC_PEER_DISPATCHER_LINE__` pattern, `entrypoint.sh:88-93`) — a socket on a non-listen is a dispatcher load error. Bump `CARRIER_SETIDS` in the sidecar env (`dispatcher.list:157,210,262`).
10. **MTU hint** ▲ (§3.4): the Kamailio entrypoint adds `ip route replace <VZ_PREFIX> ... mtu lock 1400` per prefix in `VERIZON_SIP_NETS` (SBCs only; FS needs none).
11. **Transport** ▲: `TO_CARRIER` is UDP-only today (`$du = "sip:IP:5060"`, `:4326`; Contact hardcodes `;transport=udp`, `:4504`). For Verizon-only TCP: `$du` with `;transport=tcp`, `$fs = "tcp:VERIZON_VIP:5060"`, `;transport=tcp` on the Verizon outer RR and Contact, keep both UDP and TCP `.251` listens (the forced-socket proto fallback at `:5209-5218` needs the sibling bind). `tcp_connection_lifetime=300` means in-dialog requests after 5 min idle open a fresh connection from `.251` — Verizon must accept inbound TCP from the zone SIP IP. Decide after §10 #7.
12. **Self-loop safety nets** (`:2907`, `:2999`, `:3186`) bounce an FS in-dialog request with R-URI==self to `BANDWIDTH_IP_1` — latent for Verizon dialogs but the wrong target; at minimum log the Route set.
13. Caller ID in P-Asserted-Identity (Verizon's header method). ▲ `E164_EGRESS` is dark by default, so From/PAI/R-URI are 10-digit; Verizon SIP Gateway commonly expects +1 E.164 or 11-digit, and the From/PAI TN typically must be on the account — `RCF_FROM_PASSTHROUGH` must stay off for Verizon. Confirm per zone which gates are on.

### 8.2 FreeSWITCH
- **No sofia profile change** ▲ (confirmed): both profiles decide ext-vs-local addressing from the SIP peer (the SBC), never from the far-end media IP — `local-network-acl=loopback.auto` + `apply-nat-acl=rfc1918.auto` force `ext-rtp-ip` for any 10.x peer. Verizon RTP arrives from its real media IP (the gateway rewrites dst only) = SDP `c=`, so AUTOADJ latching is a no-op; `rtp-keepalive-sec=15` is harmless through a stateless gateway. FS's second Via still leaks the FS public IP + `received=192.168.x.2` exactly as today.
- Attempt cap removed (`M.MAX` / `TERM_TRUNKS_MAX` gone, `CACHE_MAX=16` is the only bound); VIP-only attempts for Verizon rows (§7).
- No MTU route on FS (§3.4: FS→Verizon is RTP only, and the FS entrypoint does not run in production).

### 8.3 Database
Migration `62_verizon_trunks.sql`: the `carrier_trunks` rows (§7) + `carrier_gateways` display rows; ▲ `CREATE OR REPLACE VIEW carrier_trunk_health` with the new dispatcher setid + duid (the view hardcodes `setid IN (2,3,6,7,8,9,11,12)` and a literal `trunk_map`, migration 53). Verizon DIDs enter inventory through TED (carrier = verizon), like the Sinch numbers; 2-Way DID inbound to trunk/API products is carrier-agnostic (`number_routing` → `terminate_trunk`; API retired → 603).

### 8.4 Homer
`docker/homer/scripts/ip-alias.lua` entries for the Verizon IPs, the zone SIP IPs **and `10.x.0.251`** ▲ (siptrace reports the bind address for inbound), plus the gateways.

### 8.5 STIR/SHAKEN
The SBCs already sign every carrier leg with Granite's own certificate, so Verizon receives our `Identity` header. On the form: no Signing as a Service; cert owner Granite. Verizon must pass our Identity through and accept RCF forwards (caller ID Granite doesn't own, signed C with a div PASSporT + Diversion).

### 8.6 Things to prove in Phase 2 before writing the PR (UNVERIFIED)
- U1 **FS-direction r2 double-pop with an advertise-only address:** for FS→Verizon ACK/BYE, `after_loose()` forces the send socket from the second Route by looking up `VERIZON_SIP_IP:5060`, which is only *advertised*, never bound. 5.x compares advertise names too, so it should resolve to the `.251` socket — if not, the BYE leaves the NIC socket with `Via: ADVERTISE_IP` and Verizon's 200 OK goes to the public NLB VIP. Verify with `kamcmd corex.list_sockets` and a Homer trace of an FS-side hangup in Central.
- U2 **`.251`-sourced egress into a next-hop-ILB route**, and ILB delivery of gateway-forwarded packets with a foreign (Verizon) source. The proven case is external-VIP-sourced UDP to the internet; a VPC static route to the gateway ILB is a different path. tcpdump on the gateway.
- U3 Session timers: egress sends `Session-Expires: 1800;refresher=uac`, `Min-SE: 90`; 422 retry and carrier-reply normalization are generic. Verizon may require `refresher=uas` — confirm.

## 9. Order forms — what goes where

Drafts: `~/Downloads/VoIP - Granite - NetOrderForm_2026 - DRAFT v2.xlsx` and `VPS Partner - Granite - ATF-IP Forecast - DRAFT v2.xlsx` (yellow = TBD). The 10-08 `DRAFT` files describe the abandoned HA VPN/BGP design — don't send them.

| Section | Content |
|---|---|
| A | Granite Telecommunications LLC; **Install New Service** (SIP Gateway) + existing MAC tick (ATF-IP); **SIP Gateway** + Advanced Toll Free ticked; comment explains the split. TBD: date, revenue, contacts, OA number, DBAs |
| 1 | 6 peers (2 per zone). IKE peer IP = `{zone}-vz-ike-a/b`. Device "Linux strongSwan 5.9 on Debian 12 (Google Cloud), route-based, unnumbered XFRM, static routes". SIP source = zone SIP IP + FS-1 + FS-2 public IPs, each /32. Profile `IKE v2 H19 RM Opt2` + matching transform. TBD: the reserved IPs |
| 2 | One row per zone SIP IP; service type 2-Way; City/ST = GCP region (Moncks Corner SC / The Dalles OR / Council Bluffs IA); PAI; Term Routing E/W/C with SRV column; comment covers SRV round robin, STIR, TCP and the missing Section 4. TBD: SIP IPs, addresses/zips, NPA-NXX, CCL, SRV name |
| 3 | Request type Add, 3 test TFNs; CPE = customer-built Linux IPsec gateway pair, strongSwan on Google Cloud; IKE IPs per site; DNS rows `east1` / `west1` / `cent1` `.<label>.21sip.com`; comment = percentage allocation via Network Manager. TBD: contacts, PON, Corp ID, label, street address, IPs |
| 4 | **Missing — request from the SE** |
| Forecast | Toll-free only (SIP Gateway volume goes in Section 2 CCL). TBD: every traffic number |

---

## 10. Inputs still needed

**From the Verizon SE (John Evans):**
1. Section 4 (TN BETA form).
2. One form or two (SIP Gateway = Install New, ATF-IP = MAC)? Service Type code for 2-Way.
3. Will Verizon turn up against a Linux strongSwan peer?
4. Verizon IKE peer IPs per zone/PoP; SIP signaling prefixes (SIP Gateway and ATF-IP); media prefixes.
5. PSK exchange method; what "General IKE-ID" means (we propose IP-address IDs).
6. Can tunnel A be preferred per zone (both tunnels up)?
7. SIP over TCP supported?
8. Must media addresses be declared? Are FS public IPs that are also internet-reachable acceptable as in-tunnel media sources (§2.1)?
9. Does Term Routing load-share on SRV weights, or only use priority order?
10. Section 2 service address / NPA-NXX for cloud-hosted IPs.
11. STIR: Identity pass-through; acceptance of forwarded calls (non-owned ANI, signed C + Diversion).
12. A copy of the "IKEv2 Route Based 2024" spec.
13. ▲ Do ATF-IP and SIP Gateway use **separate** signaling IPs/prefixes, or shared? (Drives §8.1 #7.) Is the ATF-IP R-URI user the dialed 8YY number?
14. ▲ The **full** list of addresses that send us anything — including OPTIONS/monitoring hosts (§8.1 #5).
15. ▲ Do you accept return traffic for a given inside IP on **either** tunnel (no per-tunnel uRPF / session pinning)? What are your DPD / retransmit timers?
16. ▲ Would you accept RFC1918 SIP/media sources inside the tunnel? (A yes makes HA Cloud VPN a simpler fallback, §1.3.)
17. ▲ Number format on SIP Gateway: +1 E.164, 11-digit or 10-digit in From/PAI/R-URI? Must the From/PAI TN be on the account? `refresher=uac` acceptable?

**From Granite:**
G1. Metaswitch team: their Verizon tunnel config, PSK removed (Verizon peer IPs, profile, prefixes).
G2. OA number, Toll Free Corp ID, PON, primary/secondary contacts, DBAs, the existing `21sip.com` label, estimated monthly revenue.
G3. Forecast (toll-free) numbers; CCL per SIP IP (SIP Gateway).
G4. DNS team: the SRV + A records (§6).

**From the owner:**
O1. ~~`ted-auto-dialer-nat` subnet list~~ — done 2026-10-30, LIST_OF_SUBNETWORKS (default + ted), safe.
O2. ~~`.251` free; /28s free; gateway zones~~ — done 2026-10-30 (Central gateways landed in a/f after an n2 stockout in b/c).
O3. ~~peerings~~ — done 2026-10-30, only the Cloud Build pool exports custom routes; harmless.
O4. ~~`SBC_PEER_INTERNAL_IP` set on all 6 SBCs?~~ — verified 2026-10-30: all six have `SBC_SIGNALING_VIP=10.x.0.250`, `SBC_PEER_INTERNAL_IP` = the zone peer, `VIP_EGRESS=on`. Prerequisite for §8.1 #4 met.

---

## 11. Build order

- **Phase 0 — inputs + two GCP proofs.** §10. Reserve the 9 static IPs first: that alone fills every Section 1 IP field. ▲ **PROVEN 2026-10-30:** tags are accepted on a next-hop-ILB route (throwaway route against `central-vz-gw-ilb`, a UDP all-ports rule built with no backends; `describe` showed `tags: [vz-tagtest]`). The Central skeleton stays: `central-vz-gw-hc` (HTTP :8081 /healthz, 5s/5s/2/2), `central-vz-gw-backend` (UDP, failover-ratio 0, drop-if-unhealthy, no drain), `central-vz-gw-ilb` = **192.168.31.2**. East built the same way 2026-10-30: `east-vz-gw-ilb` = **192.168.11.4** (groups in us-east1-b/c). East signaling shape: groups `sbc-group` + `sbc-standby-group` (us-east1-b), regional HC `east-sbc-fs-aware-hc`. West: `west-vz-gw-ilb` = **192.168.21.4** (groups in us-west1-b/c); signaling shape `west-sbc-group` + `west-sbc-standby-group` (us-west1-b), regional HC `west-sbc-healthz-hc`. ▲ **PROVEN 2026-10-30:** forwarded-IP sourcing on a throwaway VM (`vz-proof`, no external IP, `vz-ipsec-central`): `curl --interface 34.68.252.50 https://ifconfig.me` returned 34.68.252.50 and deb.debian.org answered `HTTP/2 200`; `ip route show table local` had both the guest agent's `proto 66` and the kernel's address route. Remaining check once a peer exists: `swanctl --list-sas` shows no `[4500]`/`nat-local`.
- **Phase 1 — build the FINAL topology in all three zones** (owner: everything up before testing, no changes after acceptance). Per zone, in this order: subnet → firewall rules → both gateway VMs (no primary external IP) → protocol forwarding (2 target instances + 2 rules) → 2 unmanaged instance groups → HC + backend service with failover policy → next-hop ILB forwarding rule → `.251` backend service + rule → the tagged VPC routes (placeholders for Verizon prefixes until §10 #1 arrives) → `vz-{zone}` tag on both SBCs and both FSes → `infra/vz-ipsec/` configs on both gateways. Then the **pre-Verizon drills that need no peer**: gw-a↔gw-b loopback tunnel for the §3.6 load test and the NAT/MTU proofs; failover drill with the drain file (HC fails → ILB moves → remove drain → fails back). **Submit the order form** with the 9 IPs.
- **Phase 2 — tunnel turn-up with Verizon, all six tunnels:**
  - `swanctl --list-sas` shows exactly `AES_CBC-256/HMAC_SHA2_384_192/PRF_HMAC_SHA2_384/ECP_256` and `AES_GCM_16-256/ECP_256` on every gateway.
  - tcpdump: DF clear on outer ESP.
  - `ping -M do -s 1372` passes, `-s 1373` fails (MTU 1400).
  - DPD only when idle; rekeys at ~7.5 h / ~54 min.
  - ▲ `ip -s xfrm state` outer src = IKE IP; `ip route show table local | grep <IKE_IP>`; `lsmod | grep -c nf_conntrack` == 0; tcpdump of a 1430-B UDP INVITE from the SBC arriving as two ≤1400-B fragments (proves §3.4).
  - U1/U2 traces (§8.6).
  - Failover drill **with Verizon live**, per zone: drain gw-a → traffic moves to gw-b with Verizon still sending on tunnel A until their DPD fires (measure) → remove drain → fails back. Repeat with a hard stop of charon (measures the §3.2 detection time).
- **Phase 3 — platform PR** (§8) deployed dark (env unset), then enabled in Central first, East and West the same day:
  - test TFN call (ATF-IP) in each zone
  - test DID call (SIP Gateway inbound) in each zone
  - forced termination test (Verizon row priority 1, then restore) in each zone
- **Phase 4 — distribution + acceptance:** Network Manager percentage allocation; SRV records; confirm the round robin lands in all three zones; declare good-to-go. After this point the only expected changes are gateway resizes from real volume (a resize is a stop/start of one gateway behind the ILB — drain first).

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| Verizon won't support a Linux peer | Ask first (§10 #3). A managed-router fallback is a different plan |
| UDP fragmentation (Identity headers) | TCP to Verizon; watch INVITE sizes in Homer |
| Verizon rejects reusing FS public IPs for media | Fallback in §2.1 (2 more IPs/zone + `verizon` FS profile) |
| Gateways are new production boxes | OS patching, dashboard panel, OpenTofu `prevent_destroy`, runbook |
| Gateway flip | ~10 s route move + ~25 s IKE detection (§3.2); stateless NAT means established calls resume. Verizon-side detection is theirs (§10 #15) |
| ~~Tags unsupported on next-hop-ILB routes~~ | Retired 2026-10-30: proven supported (§11 Phase 0) |
| ▲ UDP INVITEs > 1400 B black-holed | Per-destination `mtu lock 1400` routes on SBCs/FSes (§3.4) |
| ▲ Shared ATF-IP / SIP Gateway signaling IPs | Needs a third TF-ingress class (§8.1 #7); ask first |
| Termination volume through the gateways | All Verizon-terminated audio crosses them (~1,000 calls ≈ 180 Mbps by our estimate). n2-standard-2 from day one (§3.6 load test before Verizon turn-up); a later resize is a drained one-gateway-at-a-time stop/start |
| Shared GCP project | Add-only; no edits to TED / shared resources |

**Rough cost (estimate — verify against current GCP pricing):** 6 × n2-standard-2 + 3 next-hop ILBs + 6 protocol-forwarding rules + 3 `.251` ILB rules + 3 unattached static IPs ≈ $500–600 / month.
