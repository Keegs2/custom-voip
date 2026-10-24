# GCP Multi-Zone Production Deployment Plan — RCF-V1

> **Status as of 2026-10-24.** This started as the multi-zone *plan*. It is now
> partly a historical record and partly a description of what is deployed. The
> live reference is `PRODUCTION_ARCHITECTURE.md` together with the root
> `CLAUDE.md`; if this file disagrees with them, they win.
>
> **Current — matches production, verified against repo code and docs:**
> - All 3 zones LIVE since 2026-07-23. Each runs a regional external NLB VIP,
>   an internal signaling ILB VIP, an active/standby SBC pair (2026-08-27), an
>   FS-1/FS-2 active/standby media pair (2026-08-31), and a local PG replica
>   (East reads the primary).
> - Carriers spread inbound calls across the 3 VIPs.
> - Termination is table-driven through `carrier_trunks`.
> - The per-zone `.env` reference and the HA cutover procedures still apply.
>
> **Historical plan — NOT built:**
> - The single "Global anycast Geo LB / Key Distributor". GCP has no global
>   passthrough NLB for UDP.
> - The Geo-LB cutover steps.
> - The 13-VM cost estimate.
>
> Geo/DNS steering survives only as a **PLANNED** Infoblox DTC step
> (`docs/INFOBLOX_DTC_CRAG_DNS_ASK.md`, `PRODUCTION_ARCHITECTURE.md` §3.5).
> Sections below are marked **(historical)**, **(current)** or **(planned)**
> where it matters.

## Strategic Context

VxRail on-prem environment decommissioning within 2 years (announced April 2026).
All 3 planned locations will be deployed in GCP instead of on-prem. Each zone is
a self-contained call processing unit — calls that enter a zone stay in that zone
for both SIP signaling and RTP media. No cross-zone RTP traffic ever occurs.

---

## Architecture Overview (current, as deployed)

```
   BANDWIDTH (orig + LD termination)          SINCH (orig + 8YY termination + backup LD)
   Account 9900717, SIP peer 1162116          Denver/Chicago orig, 8XX-T TF orig
                \                                  /
                 \  each carrier is configured with ALL 3 zone VIPs and
                  \ spreads calls across them (no DNS / no global LB)
          ┌────────────────────────┼─────────────────────────┐
          │                        │                         │
   GRANITE EAST              GRANITE CENTRAL            GRANITE WEST
   us-east1-b                us-central1-b              us-west1-b
   NLB VIP 34.24.133.82      NLB VIP 35.253.133.230     NLB VIP 35.252.214.40
          │                        │                         │
   ┌──────┴──────┐          ┌──────┴──────┐           ┌──────┴──────┐
   │ sbc-1 ACTIVE│          │ sbc-1 ACTIVE│           │ sbc-1 ACTIVE│   Kamailio pair, NLB
   │ sbc-2 stndby│          │ sbc-2 stndby│           │ sbc-2 stndby│   failover backends,
   └──────┬──────┘          └──────┬──────┘           └──────┬──────┘   /healthz 5s×2
          │ dispatcher alg 8       │                         │
   ┌──────┴──────┐          ┌──────┴──────┐           ┌──────┴──────┐
   │ FS-1 ACTIVE │          │ FS-1 ACTIVE │           │ FS-1 ACTIVE │   FreeSWITCH + Redis,
   │ FS-2 hot sb │          │ FS-2 hot sb │           │ FS-2 hot sb │   Cloud-NAT-excluded
   └──────┬──────┘          └──────┬──────┘           └──────┬──────┘   media subnet
          │ B-leg → signaling ILB VIP (.250) → ACTIVE SBC → carrier_trunks route
          │   LD:  Bandwidth near PoP → far PoP → Sinch LD backups (per-zone priority)
          │   8YY: Sinch TF trunks only (fail-closed)
          │
   PG primary + API + UI + Homer        west-db replica       central-db replica
   (services, East) ── streaming ──►    10.138.0.2            10.128.0.2
   east-db-standby 10.142.0.87 (HA, us-east1-c)
```

Calls never cross zones for SIP/RTP. Cross-zone traffic is limited to:
- PG replication.
- HEP to the East Homer.
- CDR, voicemail and metrics POSTs to the East services VM.

### Call Flow Stages (current; matches the redrawn landing HA animation)

The landing-page simulation (`docker/ui/app/src/components/layout/HaArchitectureViz.tsx`)
was redrawn in October 2026 to the real topology. The public page uses generic
names only (no cloud, carrier or PoP names). Its old "Key Distributor" and "Signal
Keys" labels are gone.

| Stage | Animation label | Component | Description |
|-------|----------------|-----------|-------------|
| 1. Origination | PSTN | Bandwidth + Sinch | Carriers deliver each call to one of the 3 zone VIPs |
| 2. Distribution | Load balancer (per region) | Regional external NLB, failover backends | Sends everything to the ACTIVE SBC; drains the zone on `/healthz` 503 |
| 3. Signaling | SBC 1 active / SBC 2 standby | Kamailio pair | Standby carries nothing until a flip (~10–12 s, health check 5 s × 2) |
| 4. Media | FS-1 active / FS-2 standby | FreeSWITCH pair (dispatcher alg 8) | RTP stays in-zone; FS-2 takes new calls only while FS-1 is down |
| 5. Termination | Route A / Route B | `carrier_trunks` priority list | East + Central lead with Bandwidth Dallas (Route A), West with Bandwidth LA (Route B); retry the other, then Sinch backups |

The animation's four scenarios run on a 50-second loop:
- Central standby SBC lost: no traffic moves; an alarm is raised.
- West media down: West answers 503 and new calls land in East + Central.
- Route A lost: calls retry on Route B.
- East active SBC lost: the standby takes over.

---

## Region Selection

| Zone | GCP Region | GCP Zone | Bandwidth Proximity | Role |
|------|-----------|----------|---------------------|------|
| **East** | us-east1 (South Carolina) | us-east1-b | Dallas PoP ~20ms, Atlanta ~10ms | **LIVE** (POC → production; also holds the PG primary + services) |
| **West** | us-west1 (Oregon) | us-west1-b | LA PoP (216.82.238.134) ~15ms | **LIVE since 2026-07-23** (LA-first egress) |
| **Central** | us-central1 (Iowa) | us-central1-b | Equidistant both PoPs ~25ms | **LIVE since 2026-07-23** (Dallas-first egress) |

**Inter-region latency:**

| From → To | us-east1 | us-central1 | us-west1 |
|-----------|----------|-------------|----------|
| us-east1 | — | ~20ms | ~50ms |
| us-central1 | ~20ms | — | ~30ms |
| us-west1 | ~50ms | ~30ms | — |

**Why these regions:** All Tier 1 pricing. us-central1 (Iowa) is GCP's cheapest US region.
us-west1 (Oregon) is Tier 1 vs us-west2 (LA) which is Tier 2 (~15-20% more expensive).
The 5-10ms extra latency from Oregon to Bandwidth LA PoP is well within SIP tolerance.

---

## VPC & Networking

### Single VPC with Regional Subnets

GCP VPCs are global — subnets in different regions route automatically. No VPC peering needed.

```
VPC: default
  Subnet: us-east1             10.142.0.0/20    (SBCs, services, east-db-standby)
  Subnet: us-west1             10.138.0.0/20    (SBCs, west-db, west-loadtest)
  Subnet: us-central1          10.128.0.0/20    (SBCs, central-db)
  Subnet: voip-media           192.168.10.0/24  (East FS-1 + FS-2 — Cloud-NAT-excluded)
  Subnet: voip-media-west      192.168.20.0/24  (West FS-1 + FS-2 — Cloud-NAT-excluded)
  Subnet: voip-media-central   192.168.30.0/24  (Central FS-1 + FS-2 — Cloud-NAT-excluded)
```
(Source: `PRODUCTION_ARCHITECTURE.md` §3.1.)

**⚠️ Cloud NAT exclusion is mandatory for FreeSWITCH VMs.** GCP Cloud NAT on the
`default` subnet replaces a VM's 1:1 external IP with a NAT-pool IP, which makes
Bandwidth drop all RTP/SIP (source IP ≠ SDP-negotiated IP). The East FS lives on a
dedicated `voip-media` subnet (`192.168.10.0/24`, internal IP **192.168.10.2**) that
is **not** in the Cloud NAT router's list. **Every new zone's FS must do the same** —
either a per-region `voip-media-{region}` subnet excluded from Cloud NAT, or the
`bypass-vpn` network tag. SBC VMs use the `bypass-vpn` tag. See root `CLAUDE.md`,
"GCP Cloud NAT Breaks VoIP".

### Per-Zone IP Allocation

| Role | East | West | Central |
|------|------|------|---------|
| SBC-1 (active) | 10.142.0.100 | 10.138.0.100 | 10.128.0.100 |
| SBC-2 (standby) | 10.142.0.101 | 10.138.0.101 | 10.128.0.101 |
| Signaling ILB VIP | 10.142.0.250 | 10.138.0.250 | 10.128.0.250 |
| FS-1 (active) | **192.168.10.2** (voip-media) | 192.168.20.2 (voip-media-west) | 192.168.30.2 (voip-media-central) |
| FS-2 (hot standby) | 192.168.10.3 | 192.168.20.3 | 192.168.30.3 |
| PG | 10.142.0.103 (**primary**, `services`) + 10.142.0.87 (`east-db-standby`, us-east1-c) | 10.138.0.2 (`west-db` replica) | 10.128.0.2 (`central-db` replica) |

> **Note:** The FS VMs sit on the Cloud-NAT-excluded media subnets with the
> `bypass-vpn` tag, never on the default subnet. The replicas ended up at `.2`,
> not the originally planned `10.138.0.103` / `10.128.0.103`. External IPs per VM
> are in root `CLAUDE.md` "GCP Production Topology" and `PRODUCTION_ARCHITECTURE.md` §2.

### Inbound Load Balancing — what was built (current)

**One regional external passthrough NLB per zone**, not a global LB:
- **VIPs:** East 34.24.133.82, West 35.252.214.40, Central 35.253.133.230.
- **Failover backends:** the primary group holds SBC-1, the standby group holds
  SBC-2. Policy: `failover-ratio=0`, `drop-traffic-if-unhealthy`,
  `no-connection-drain-on-failover`.
- **Health check:** HTTP :8080 `/healthz` (fs-aware + maintenance-aware), 5 s
  interval / 2 failures, so about 10–12 s to flip. Failback is automatic.
- **Signaling ILB:** each zone also has an **internal signaling ILB**
  (`.250`) with the same groups, health check and policy, so the FS → SBC
  plane flips together with the carrier plane.
- **Who uses which:** carriers (Bandwidth, Sinch) are configured with all three
  VIPs and spread calls across them themselves; they retry another VIP when a
  zone stops answering. Tables: `PRODUCTION_ARCHITECTURE.md` §3.2–§3.3.

**Geo / DNS steering is PLANNED, not built.** The request to Granite's DNS team
is outstanding (`docs/INFOBLOX_DTC_CRAG_DNS_ASK.md`; `PRODUCTION_ARCHITECTURE.md`
§3.5, §12 #15):
- **Phase 1:** Infoblox DTC **Topology** steering for `crag.granitevoip.com`
  (customer SIP trunks). The health monitor is SIP OPTIONS on UDP/5060
  expecting 200; a 503 pulls the zone. The SBC side of that contract is
  already live.
- **Phase 2:** `orig.granitevoip.com` for carrier origination.

### Geo Load Balancer (Key Distributor) — historical plan, NOT built

> **Not built, and not buildable as designed:** GCP has no global *passthrough*
> NLB for UDP SIP. It was superseded by the per-zone regional NLBs above, plus
> carrier-side multi-VIP distribution, with DNS steering as the future step.
> The original design is kept below for history only.

Single Global External Passthrough Network Load Balancer with one anycast VIP.
All inbound SIP from Bandwidth hits one IP; GCP's Premium Tier edge network routes
each packet to the nearest healthy region. No per-region VIPs. No Bandwidth
priority failover. GCP handles geographic distribution and failover transparently.

**GCP Product:** Global External Passthrough Network Load Balancer (Premium Tier)

| Property | Value |
|----------|-------|
| **VIP** | Single anycast IP (TBD — reserve global static IP) |
| **Protocol** | UDP + TCP (dual forwarding rules on port 5060) |
| **Backend Service** | Global, with instance groups in 3 regions |
| **Session Affinity** | CLIENT_IP (in-dialog SIP stays on same SBC) |
| **Health Check** | TCP 5060, 5s interval, 3-failure threshold |
| **Routing** | Nearest healthy region based on Bandwidth source PoP |

**Backend Instance Groups** (one per region, 2 SBCs each):

| Region | Instance Group | Members | Health Check |
|--------|---------------|---------|-------------|
| East | sbc-group-east | east-sbc-1, east-sbc-2 | TCP 5060 |
| West | sbc-group-west | west-sbc-1, west-sbc-2 | TCP 5060 |
| Central | sbc-group-central | central-sbc-1, central-sbc-2 | TCP 5060 |

**How it routes Bandwidth traffic:**

- Bandwidth Dallas PoP (67.231.2.12) → GCP edge → nearest healthy region (likely East or Central)
- Bandwidth LA PoP (216.82.238.134) → GCP edge → nearest healthy region (likely West)
- If a region is fully down (both SBCs unhealthy) → auto-reroute to next nearest region
- CLIENT_IP affinity ensures in-dialog SIP (BYE, re-INVITE) returns to the same SBC

**What actually happened:** the regional External Passthrough NLB (East VIP
34.24.133.82) was never replaced. West (35.252.214.40) and Central
(35.253.133.230) got their own regional NLBs, and all three gained failover
backends and a signaling ILB on 2026-08-26/27. See "Inbound Load Balancing"
above.

### Firewall Rules (VPC-wide, all zones)

> **Planned table, superseded.** The audited live inventory is
> `PRODUCTION_ARCHITECTURE.md` §3.6. Notable differences from this plan:
> - Health checks are `allow-hc-sbc-healthz`, tcp:8080 from 209.85.152.0/22 +
>   209.85.204.0/22 + 35.191.0.0/16, and they are VIP-addressed. They are not
>   tcp:5060 from 130.211.0.0/22.
> - `allow-sinch-sip` (Sinch orig + term IPs, added 2026-08-31) was added.
> - `allow-vmagent-remote-write`, `allow-ops-agent`, and the public x5u
>   tcp:80/443 rule were added.

| Rule | Source | Ports | Target Tags |
|------|--------|-------|-------------|
| voip-sip-inbound | 67.231.0.0/16, 216.82.224.0/19 | udp/tcp:5060 | voip-sbc |
| voip-health-check | 35.191.0.0/16, 130.211.0.0/22 | tcp:5060 | voip-sbc |
| voip-rtp | 0.0.0.0/0 | udp:16384-49151 | voip-media |
| voip-web-admin | Office CIDR | tcp:8080,8443,8088,9080 | voip-services |
| voip-internal | All zone subnets | all tcp/udp/icmp | all voip tags |
| voip-pg-replication | Zone subnet CIDRs | tcp:5432 | voip-db |
| allow-ssh-iap | 35.235.240.0/20 | tcp:22 | all voip tags |

---

## Per-Zone VM Topology

Each zone is identical: 4 call-path VMs running the same Docker images with
zone-specific .env files (originally planned as 3; FS-2 was added 2026-08-31).

| VM Role | Machine Type | Count/Zone | Networking |
|---------|-------------|------------|------------|
| Kamailio SBC (active/standby) | e2-standard-4 (East SBC-1 `poc-custom-voip` is n2-standard-4) | 2 | Host networking, static external IP, default subnet, `bypass-vpn` tag |
| FreeSWITCH + Redis (FS-1 active / FS-2 hot standby) | e2-standard-8 (FS-2 = machine-image clone of FS-1) | 2 | Host networking, static external IP, **Cloud-NAT-excluded media subnet**, `bypass-vpn` tag |

### Shared Services (Centralized in East) + per-zone DB

| VM Role | Machine Type | Count | Location |
|---------|-------------|-------|----------|
| `services`: PG Primary + PgBouncer + API + UI + Homer + VictoriaMetrics + x5u | **e2-highmem-4 (32 GB, resized 2026-09-02)** | 1 | us-east1-b |
| `east-db-standby`: PG hot standby (HA failover target) | e2-standard-4 | 1 | us-east1-**c** |
| `west-db`: PG Replica + PgBouncer | e2-standard-4 | 1 | us-west1-b |
| `central-db`: PG Replica + PgBouncer | e2-standard-4 | 1 | us-central1-b |

**Total (actual): 16 production VMs** (6 East, 5 West, 5 Central), plus the
banked `west-loadtest` SIPp VM. The original plan was 13 VMs.

---

## Database Strategy

### Primary-Replica Streaming Replication

Writes are centralized (DID provisioning, CDRs). Reads are call-path-critical (DID lookups on every call). Multi-master is unnecessary complexity.

```
PG Primary (services, us-east1-b, 10.142.0.103)
  ├── slot east_standby    → east-db-standby (us-east1-c, 10.142.0.87 — HA failover target)
  ├── slot west_standby    → west-db         (us-west1-b, 10.138.0.2)
  └── slot central_standby → central-db      (us-central1-b, 10.128.0.2)
```

Each replica runs PgBouncer (:6432, scram, transaction mode) for its zone's
FS/Kamailio connections. The legacy `sandbox_replica` slot is absent
(`PRODUCTION_ARCHITECTURE.md` §8.1). The `central_standby` slot was lost in the
2026-10-23 PG primary disk-full incident, and `central-db` was re-cloned
(owner-confirmed 2026-10-24); see `docker/postgres/CLAUDE.md`.

### Connection Routing

| Zone | DB_HOST (call-path reads) | DB writes (API) |
|------|--------------------------|-----------------|
| East | 10.142.0.103 (primary, local) | 10.142.0.103 (local) |
| West | 10.138.0.2 (`west-db` replica, local) | 10.142.0.103 (cross-region, ~50ms) |
| Central | 10.128.0.2 (`central-db` replica, local) | 10.142.0.103 (cross-region, ~20ms) |

### Replication Lag

Measured replay lag is ~2 ms same-region and ~130 ms cross-region
(`docker/postgres/CLAUDE.md`); replication is async. That is acceptable for DID
routing, since a number provisioned a moment ago works on the next call. CDR
writes go to the primary after call completion (not in the call-setup path), so
cross-region write latency is invisible.

### Failover

If the PG primary goes down (`PRODUCTION_ARCHITECTURE.md` §1.4):
- **Active calls:** Unaffected (already bridged, no DB needed).
- **New calls:**
  - West/Central keep routing: they do their DID lookups on their local replicas.
  - East's FS reads the primary directly, so East DID lookups fail until it is
    promoted or repointed. There is **no Redis DID cache**: it was removed from
    the RCF path.
- **Provisioning + CDR ingest:** writes fail and the API returns 503 until promotion.
- **Recovery:** promote `east-db-standby` (the HA target; promote was drilled at
  0.143 s). Then repoint `DB_HOST`/`DATABASE_URL` per
  `docs/runbooks/DB_FAILOVER_RUNBOOK.md`.
- **Future (not built):** Patroni for automatic failover.

---

## Redis Design

Per-zone local Redis on each FreeSWITCH VM (127.0.0.1:6379). No cross-zone sharing.

- **Not on the RCF path.** `inbound_router.lua` had its Redis route cache,
  fraud-prefix check and velocity code **removed**, because of redis-lua
  threading issues under mod_lua. Every RCF call does a PostgreSQL lookup on the
  zone-local DB.
- **Trunk/API paths only** (`trunk_outbound.lua`, `api_outbound.lua`, fail-open):
  trunk config cache, concurrent-channel counting, CPS sorted sets, velocity
  counters. Counting is zone-local, which is slightly less accurate if a
  customer's calls split across zones; that is acceptable.
- **Session state:** Inherently local to the FS handling the call.

If Redis fails: trunk/API caches fall through to PostgreSQL and limits fail open.
RCF is unaffected. No calls are dropped (`PRODUCTION_ARCHITECTURE.md` §5.7).

---

## Bandwidth Carrier Configuration

### Single SIP Peer, Three Zone VIPs (current)

All Bandwidth DIDs stay on SIP peer 1162116. The original plan had a single Geo
LB anycast VIP as the only host; that was **never built**. What runs today:

```
SIP Peer: 1162116 (GraniteTelecommunicationsLLC_O3)
  Inbound to us (Bandwidth → Granite), distributed across all three:
    34.24.133.82    (East NLB VIP)
    35.252.214.40   (West NLB VIP)
    35.253.133.230  (Central NLB VIP)

  Accepted sources for our outbound traffic (Granite → Bandwidth):
    the 3 zone VIPs              (in SIP headers; source of ACK/BYE/responses, and of INVITEs under VIP_EGRESS)
    + all 6 SBC public IPs       (packet source of INVITEs and OPTIONS probes)
```

Bandwidth spreads inbound calls across the three VIPs and retries another VIP
when a zone stops answering (`PRODUCTION_ARCHITECTURE.md` §6.1, §3.5). The
rollout record notes inbound "DISTRIBUTING (not strict-primary)" (2026-07-23).
The planned Phase-2 DNS step would list `orig.granitevoip.com` first, ahead of
the static VIPs (`docs/INFOBLOX_DTC_CRAG_DNS_ASK.md`); that is not built.

**Sinch** (second carrier; the Sinch side registers our IPs):
- **Origination TGs** (Denver 206.146.100.24, Chicago 206.146.101.39) are
  registered to our three zone **VIPs** and round-robin across them, like
  Bandwidth.
- **8XX-T toll-free origination TGs** (206.146.98.25 / 206.146.100.25) also
  deliver to the zone VIPs.
- **Termination TGs** (Atlanta LD 206.146.98.26, Denver TF 206.146.100.26,
  redundant Denver LD .100.25 / Atlanta TF .98.25) know only the **6 SBC public
  IPs**. Sinch picks the trunk group by our source IP, which is why Sinch-bound
  INVITEs never leave from a VIP.
- Details: `docker/kamailio/CLAUDE.md` §4.1 and §5; `PRODUCTION_ARCHITECTURE.md` §6.2.

**Why all 6 SBC public IPs are whitelisted:** outbound INVITEs from Kamailio
leave from the SBC's own external IP, not the VIP. The exception is
`VIP_EGRESS`, below. Carriers must whitelist these IPs to accept outbound
traffic. The VIP is in SIP headers (From, Contact, Via), so in-dialog requests
route back through the zone NLB to the active SBC.

**`VIP_EGRESS=on` (SBC env, default off, dedicated signaling-VIP mode only):**
Kamailio forces the send socket of carrier-bound INVITEs that arrived on the
signaling ILB VIP to the external VIP (`$fs` guard in `route[TO_CARRIER]`), so
in steady state the INVITE's packet source is the zone VIP too — the same source
ACK/BYE and all responses already use. The 6 SBC public IPs MUST STAY in the
origination list: INVITEs that arrive on an SBC's direct VPC IP (FreeSWITCH's
`SBC_PROXY_IP_FAILOVER` attempts, direct-IP ESL originates) and the OPTIONS
keepalive probes still egress from each SBC's own public IP. The win is one
carrier-facing source for the common case, not fewer whitelisted IPs. Enable on
both SBCs of a zone; see `docker/kamailio/kamailio.cfg`.

### Failover Behavior (current)

Inbound failover is split between GCP and the carriers:

| Failure | Who Detects | Recovery Time | Behavior |
|---------|------------|---------------|----------|
| Active SBC | Zone NLB + signaling ILB health check (`/healthz`, 5 s × 2) | ~10–12 s (design; drills unlogged) | Both planes flip to the standby SBC. Calls in progress are designed to continue (stateless `;fs=` in-dialog dispatch); setups in flight during the flip are lost |
| Standby SBC | Health check + `sbc_failover.tf` alert | — | No traffic impact; zone unprotected until restored (page) |
| Both FS in a zone / whole zone | `/healthz` → 503 on both SBCs (NLB drains the zone); external SIP OPTIONS → 503 (`FS_AWARE_OPTIONS`) | ~10–12 s + carrier retry | Carriers retry the other zone VIPs |
| Carrier rejects/fails a route | FS attempt loop (table-driven) or Kamailio CARRIER_FAILURE (legacy legs) | Immediate on a 5xx/408/480/404; ≤10 s `progress_timeout` on silence | Next route in the zone's priority list (see below) |

There is no DNS or global LB layer: a dead zone stops answering its VIP, and
the carriers' own multi-VIP retry moves new calls to the other zones.

### Per-Region Carrier PoP Selection (Outbound Termination)

**Table-driven (current, every RCF call).** FreeSWITCH builds each call's route
list from `carrier_trunks`:
- **Query:** `direction IN ('outbound','both') AND enabled`, ordered by
  `COALESCE(priority_<FS_ZONE>, priority)`, cached 60 s.
- **Filter:** per call by `traffic_class`. LD uses `any`/`ld` rows; NANP 8YY
  uses only `tollfree` rows and fails closed (`NO_ROUTE_DESTINATION`) when none
  is enabled.
- **Attempts:** capped at 4 trunks × {signaling ILB VIP, SBC-1 direct}, so **up
  to 8 attempts**, each with `X-Carrier-IP`.
- **Kamailio:** it validates the IP and leaves failover to FS (flags 8+9).
- **Changes:** disabling or reprioritising a trunk in TED takes effect in
  about 60 s, with no redeploy.

| Region | LD order (priority) | 8YY order |
|--------|--------------------|-----------|
| East | Bandwidth Dallas 67.231.2.12 (10) → Bandwidth LA 216.82.238.134 (20) → Sinch atlanta-ld 206.146.98.26 (30) → Sinch denver-ld 206.146.100.25 (35) | Sinch denver-tf 206.146.100.26 (40) → Sinch atlanta-tf 206.146.98.25 (45) |
| West | Bandwidth **LA** (10) → Bandwidth Dallas (20) → Sinch atlanta-ld (30) → Sinch denver-ld (35) | same |
| Central | Bandwidth Dallas (10) → Bandwidth LA (20) → Sinch atlanta-ld (30) → Sinch denver-ld (35) | same |

The 35/45 rows are seeded `enabled=false` (migration 53); the live state is in
the table. The Sinch termination PCAP sign-off is still open
(`PRODUCTION_ARCHITECTURE.md` §12 #7).

**Legacy `X-Carrier` enum (fallback + trunk/API non-8YY).** If the table can't
be resolved (DB error, zero rows, or a lib load failure), RCF runs the legacy
**4-attempt** loop with `X-Carrier=primary/secondary`. Customer SIP-trunk and
API non-8YY calls always use the enum. Kamailio maps the enum per zone through
`BANDWIDTH_PRIMARY_IP` / `BANDWIDTH_SECONDARY_IP`, and its CARRIER_FAILURE
in-trunk / TC4 flip applies:

| Region | X-Carrier=primary | X-Carrier=secondary (failover) |
|--------|------------------------------|------------------------------|
| East | 67.231.2.12 (Dallas, ~20ms) | 216.82.238.134 (LA) |
| West | 216.82.238.134 (LA, ~15ms) | 67.231.2.12 (Dallas) |
| Central | 67.231.2.12 (Dallas, ~25ms) | 216.82.238.134 (LA) |

This needs 2 env vars per zone (`BANDWIDTH_PRIMARY_IP`, `BANDWIDTH_SECONDARY_IP`)
plus, on the media VM, `FS_ZONE` for the table-driven priority column.

---

## Per-Zone Environment Variables

### SBC .env (per zone, per SBC instance)

```bash
EXTERNAL_SIP_IP=<zone_nlb_vip>          # This zone's regional NLB VIP (East 34.24.133.82, West 35.252.214.40, Central 35.253.133.230); same on both SBCs of the zone
SBC_INTERNAL_IP=<this_sbc_vpc_ip>       # THIS SBC's own VPC IP — inner Record-Route, FS-facing listen, alias=
FS_PUBLIC_IP=<zone_fs_public_ip>        # Zone FS public IP — SDP rewrite target (RTP bypasses the NLB)
FREESWITCH_IP=<zone_fs1_internal_ip>    # Zone's FS-1 (dispatcher group 1 primary)
DB_HOST=<zone_pg_ip>                    # Local PG (East primary 10.142.0.103; West 10.138.0.2; Central 10.128.0.2)
DB_PORT=6432
DB_USER=freeswitch
DB_PASS=<STRONG_FS_DB_PASSWORD>
HOMER_IP=10.142.0.103                   # Centralized Homer in East
BANDWIDTH_PRIMARY_IP=<nearest_bw_pop>   # Nearest Bandwidth PoP (East 67.231.2.12, West 216.82.238.134)
BANDWIDTH_SECONDARY_IP=<far_bw_pop>     # Far Bandwidth PoP (failover)
INTERNAL_SUBNET=<zone_vpc_subnet>       # This zone's VPC subnet (East 10.142.0.0/20, West 10.138.0.0/20)
MEDIA_SUBNET=<zone_media_subnet>        # This zone's FS media subnet (East 192.168.10.0/24)
SBC_ID=<region>-sbc-<n>                 # e.g. east-sbc-1, west-sbc-2
HEP_CAPTURE_ID=<see table below>        # Per-ZONE SBC capture ID (both SBCs of a zone share it: 100/110/120)
# Optional in code (unset = legacy behavior) but SET IN ALL 3 ZONES in production:
# SBC_SIGNALING_VIP=<zone_ilb_vip>      # Active/standby HA (LIVE 2026-08-27): per-zone INTERNAL passthrough-NLB VIP (.250) (see below)
# FREESWITCH_IP_2=<zone_fs2_internal_ip> # Strict active/standby FS pair (LIVE 2026-08-31): zone's FS-2 (192.168.x.3) (see below)
# STIR_SHAKEN_SIGN=on + STIR_CERT_URL + STIR_KEY_PATH  # Signing (default off in code); needs the docker-compose.stir-key.yml key mount on every recreate
# SBC_PEER_INTERNAL_IP=<other_sbc_vpc_ip> # Peer reply hand-off (optional; see docker/kamailio/CLAUDE.md §8.12)
# TF_TEST_TNS=5595335873,5595335908     # Sinch 8XX-T test TNs until real toll-free numbers are live
# VIP_EGRESS=off                         # See "VIP_EGRESS" above; full SBC env reference: root CLAUDE.md
# BW_CPS_LIMIT=100                      # Inbound CPS flood backstop per Bandwidth IP (503 above this)
# TESTING_IP=                           # Trusted SIPp test source. UNSET in prod (disabled by default)
# BANDWIDTH_TC1_NY / TC1_ATL / TC2_DAL / TC2_LA  # Fixed TC1/TC2 PoPs (defaults = production IPs)
```

Media VM additionally supports (optional): `BRIDGE_PROGRESS_TIMEOUT=10` — per-attempt
`progress_timeout` (max seconds to wait for carrier 180/183 before failing over to the
next SBC/carrier; ringing then continues to call_timeout).

Media VM also supports (optional): `RCF_FROM_PASSTHROUGH=on|off` (**default `off`**; only `on|true|1` enables — unset = off, so a bare media-VM `git pull` of the bind-mounted Lua changes nothing) — when on, an RCF DID with `pass_caller_id=true` sends the ORIGINAL caller's number and display name in the carrier-bound From (Diversion stays the RCF DID; **P-Asserted-Identity is unchanged** — the From display travels in the dedicated `X-From-Name` header so it no longer moves the PAI display off the RCF line name). Off is the RCF-DID-in-From behavior byte for byte. **Enable per zone, and ONLY in this order (HARD requirement):** (1) that zone's SBCs must be on the #120+#122 Kamailio build FIRST — the base RCF-V1 `kamailio.cfg` has no strip for `X-From-Name`, so an SBC on the older build would forward the caller's display name to the carrier verbatim; (2) one live canary RCF call per carrier PoP (Bandwidth Dallas + LA) confirms the carrier accepts a non-account TN in From (UNVERIFIED today); (3) then set `RCF_FROM_PASSTHROUGH=on` in that zone's media-VM `.env` and recreate the FS container. Rollback: remove the line (or set `off`) + recreate.

Media VM also supports (optional): `FS_NODE_ID` — the node name recorded in the CDR channel variable `fs_node` (e.g. `east-fs-1`). Unset ⇒ `<FS_ZONE>-fs`. Set it on zones running a second FS (fs-2) so CDRs distinguish the two.

> **All of these are now templated** in `entrypoint.sh` / `docker-compose.sbc.yml`, each
> with an East default so an unset value reproduces current East behavior:
> - `SBC_INTERNAL_IP` (`__SBC_INTERNAL_IP__`) powers the inner Record-Route, the
>   FS-facing listen socket, and `alias=` — without it, in-dialog ACK/BYE behind the NLB breaks.
> - `FS_PUBLIC_IP` (`__FS_PUBLIC_IP__`) is the SDP rewrite target because RTP bypasses the NLB.
> - `BANDWIDTH_PRIMARY_IP`/`BANDWIDTH_SECONDARY_IP` (`__BANDWIDTH_PRIMARY_IP__`/
>   `__BANDWIDTH_SECONDARY_IP__`) set this zone's carrier egress order — West sets primary=LA.
>   Safe because every inbound trust check ORs both IPs (swap-invariant); only the egress order changes.
> - `INTERNAL_SUBNET`/`MEDIA_SUBNET` (`__INTERNAL_SUBNET__`/`__MEDIA_SUBNET__`) are this zone's
>   trusted internal CIDRs. Each zone trusts only its own internal + media subnet (per-zone self-containment).
>
> Validated with `kamailio -c` on both East (byte-identical to pre-change) and West templated configs.
> **Set `MEDIA_SUBNET` to the real per-region media subnet you provision for West** — pick a
> Cloud-NAT-excluded CIDR (it must not overlap East's `192.168.10.0/24`).

#### Active/standby SBC pair — `SBC_SIGNALING_VIP` (optional, per zone) — LIVE all 3 zones 2026-08-27

> Status: deployed 2026-08-26/27 (West → Central → East). The cutover below is
> now the historical record and the procedure for rebuilding a zone. Live state,
> drills and failure modes: `docs/SBC_ACTIVE_STANDBY_RUNBOOK.md`. The drill log
> there has no rows yet.

Converts the zone's 2-SBC pair from active/active to a TRUE active/standby HA pair.
Both SBCs keep IDENTICAL config; "active" is decided ONLY by GCP health checks (no
VRRP/keepalived). Two GCP pieces (operator-provisioned) + one env var:

1. **External NLB failover policy** — sbc-1 = primary backend, sbc-2 = failover
   backend. ALL carrier traffic to the external VIP lands on the ONE active SBC
   (automatic failback when the primary recovers).
2. **NEW per-zone INTERNAL passthrough NLB ("signaling VIP")** with the SAME
   primary/failover backends, forwarding UDP:5060 **and** TCP:5060 (two forwarding
   rules on one reserved internal IP, or one `L3_DEFAULT` rule — TCP is required by
   FreeSWITCH's `inbound_router.lua` TCP health pre-check).
3. `SBC_SIGNALING_VIP=<that ILB VIP>` in each SBC's `.env`.

Effect on the templated config (`__SIGNALING_VIP__` / `SBC_SIGVIP_DEDICATED`):
Kamailio binds the ILB VIP on loopback + listens on it (advertising the EXTERNAL
VIP — deliberate, see the listen-block comment in `kamailio.cfg`), adds `alias=`,
and the FS-facing inner Record-Route in BOTH presets becomes the signaling VIP
instead of `SBC_INTERNAL_IP`. FS's in-dialog requests (ACK/BYE/re-INVITE) then
always reach the ACTIVE SBC — a mid-call SBC death no longer strands FS's BYE on
a dead pinned SBC IP. **Unset = byte-identical rendered config to the pre-HA
deploy** (token falls back to `SBC_INTERNAL_IP`, no extra listeners), so the code
can be deployed fleet-wide before any ILB exists.

**Cutover order (per zone, strictly):** (1) deploy code everywhere with the var
unset — no-op; (2) operator creates the ILB (UDP+TCP, failover policy) and the
external NLB failover policy; (3) set `SBC_SIGNALING_VIP` on BOTH SBCs and
restart them one at a time (in-flight dialogs carry the old `SBC_INTERNAL_IP`
inner Route — the kept listen/alias keeps terminating them); (4) flip the media
VM's `SBC_PROXY_IP` to the ILB VIP and `SBC_PROXY_IP_FAILOVER` to sbc-1's direct
VPC IP; (5) the Services VM's `SBC_PROXY_IP` (East `.env`) to the East ILB VIP
`10.142.0.250` too — `esl_client.py` originates API calls as
`sofia/external/<to>@$SBC_PROXY_IP:5060`, and with sbc-1's direct IP every
API-originated call fails while sbc-1 is down even though the standby is active.
(Since API Calling was retired on 2026-09-23 this originate path is reachable
only if `API_CALLING_ENABLED=true`, but keep the value correct for a re-enable.)
Never set the var before the ILB answers on the VIP: new dialogs would
carry an inner Route that nothing serves.

#### Strict active/standby FreeSWITCH pair — `FREESWITCH_IP_2` (optional, per zone) — LIVE all 3 zones 2026-08-31

> Status: deployed and drilled in all zones on 2026-08-31 (east-fs-2
> 192.168.10.3, west-fs-2 192.168.20.3, central-fs-2 192.168.30.3). The drill
> log in `docs/FS_MEDIA_HA_RUNBOOK.md` §9 has no rows yet.

Gives each zone a SECOND media node in the SAME model as the SBC pair: FS-1
serves ALL new calls; FS-2 runs fully hot (sofia up, DB connected, answering the
same dispatcher OPTIONS probes) but receives ZERO new calls while FS-1 is
healthy. Probing-declared death flips new-call selection to FS-2; recovery
automatically fails back. NOT load-sharing, NOT round-robin.

Mechanism (all env-gated by `FREESWITCH_IP_2`; unset = single-FS config,
verified effective-config-identical + `kamailio -c` clean):
- `dispatcher.list` group 1 gains `sip:<FS2>:5080` (duid `fs-standby`,
  priority 5) and FS-1's line renders priority 10. Kamailio 5.8 orders the
  runtime `dlist[]` by DESCENDING priority number and `ds_select_dst("1","8")`
  (serial) always takes the first non-INACTIVE entry — verified against 5.8
  `dispatch.c` (alg-8 hash=0 :2466, skip-walk :2536, ascending insert :589 +
  backwards reindex :803) and live (`kamcmd dispatcher.list` order + INVITE
  delivery tests).
- Per-call node identity for in-dialog routing: the Record-Route presets add
  `;fsn=1`/`;fsn=2` next to `;fs=5080/5090`, and `$dlg_var(fs_node)` records
  the REAL selection on the dialog-owning SBC (it outranks the marker there).
  Legacy dialogs (no `fsn`) resolve to FS-1 with a one-shot 481 other-host
  retry. §8.10 port tiers are untouched.
- `fshealth` gains per-node `fs1_up`/`fs2_up`; `fs_up` becomes the ANY-node
  aggregate. `/healthz` 503 + OPTIONS-503 drain fire ONLY when BOTH nodes are
  down (single-node death must NOT drain the zone). Detection windows with
  current settings (`ds_ping_interval=5`, thresholds 3, tm `fr_timer=30s`):
  ~40-45s for a silently dead node (probe replies time out at fr_timer),
  ~10-15s for a node answering probes with a non-accepted code; failback
  ~10-15s after the node answers again. In-window call setups get one
  in-transaction rescue onto the standby via `DISPATCH_FAILURE`/`ds_next_dst`
  (attempted at ~30s — the carrier will often have CANCELled by then).

**FS-2 VM build:** clone of the media VM — `docker-compose.media.yml` is reused
AS-IS, `inbound_router.lua`/sofia/conf need ZERO changes (all identity is env).
FS-2 `.env` = FS-1's `.env` with exactly these differences:
`EXTERNAL_SIP_IP`/`EXTERNAL_RTP_IP` = FS-2's OWN public IP (entrypoint adds it
to loopback per-VM — no shared VIP anywhere in the media plane),
`FS_NODE_ID`/`HEP_CAPTURE_ID` = distinct per node (Homer: East FS-2 = 201,
West = 211, Central = 221). Identical: `SBC_PROXY_IP` (zone signaling ILB VIP),
`SBC_PROXY_IP_FAILOVER`, `FS_ZONE`, `DB_HOST`/`DB_PORT` (zone replica),
`API_HOST`, `HOMER_IP`, `ESL_PASSWORD`, `METRICS_ZONE`. The FS-2 VM must be on
the zone's Cloud-NAT-excluded media subnet with the same firewall tags as FS-1
(`bypass-vpn`, `voip-media`).

**Cutover order (per zone, strictly):** (1) deploy this code everywhere with
the var unset — no-op; (2) operator builds the FS-2 VM (media subnet, tags,
`.env` as above), verifies it standalone (sofia up on :5080/:5090, DB reachable,
answers OPTIONS from an SBC source); (3) set `FREESWITCH_IP_2=<FS-2 VPC IP>` on
BOTH SBCs of the zone and restart them one at a time; (4) watch
`kamcmd dispatcher.list` (FS-1 prio 10 first + FS-2 prio 5, both `AX`) and
`kamcmd htable.get fshealth fs1_up` / `fs2_up` = 1. In-flight dialogs carry no
`fsn` marker and keep resolving to FS-1 — unchanged.

**Operational caveats:**
- Calls established on a dying FS are LOST (media + B2BUA state are anchored
  on the node — industry standard for media-server death). Failover covers NEW
  calls only; setups inside the detection window may fail.
- ESL/API originate (`POST /v1/calls`) stays pinned to FS-1
  (`FREESWITCH_ESL_HOST` on the Services VM — deliberately NOT changed here).
  A future `FREESWITCH_ESL_HOST_2` failover in the API is the follow-up.
  It is still open as of 2026-10-24 (`PRODUCTION_ARCHITECTURE.md` §12 #3). The
  impact is smaller now that API Calling is retired (2026-09-23): today it
  affects ESL tools only.
- `kamcmd dispatcher.set_state` does NOT fire the dispatcher dst-up/dst-down
  events in 5.8 (`ds_reinit_state` sets flags directly), so an RPC-forced
  state change leaves `fs1_up`/`fs2_up` stale until the next probe-driven
  transition. Also, with `ds_probing_mode=1`, `set_state ip` on an ALIVE node
  self-heals back to active in ~15s (successful probes reactivate it) — for a
  real admin drain of a media node use `set_state dp` (DISABLED sticks), and
  expect the health mirror/markers to lag as above. Selection itself is always
  correct (dispatcher flags are authoritative).
- Each SBC probes and mirrors independently; their views can diverge by one
  probe cycle (±5-15s). Harmless: only the ACTIVE SBC receives carrier traffic
  (NLB failover policy), and the aggregate consumers converge within a cycle.
- The SDP private-IP scrub targets (`FS_PUBLIC_IP`) remain FS-1's public IP.
  They are defense-in-depth no-ops for a correctly configured FS (SDP already
  carries the node's own public IP via `ext-rtp-ip`); a private-IP leak from
  FS-2 would be "repaired" to FS-1's address — the call's audio was already
  broken in that misconfiguration; fix the FS-2 env, don't widen the scrub.

#### SBC Identity & Homer Capture ID Mapping

A single Homer instance (East) receives HEP from all 6 SBCs and all 6 FS nodes.
The original plan gave each SBC a unique capture_id (101/111/121 for the SBC-2s).
**As deployed, both SBCs of a zone share one capture ID**, and the SBCs are told
apart by `SBC_ID` (`X-SBC-ID`). FS-1 and FS-2 have distinct IDs
(`.env.sbc.example:40`; `PRODUCTION_ARCHITECTURE.md` §2.4):

| Region | SBC_IDs | SBC HEP_CAPTURE_ID | FS-1 | FS-2 |
|--------|---------|--------------------|------|------|
| East | `east-sbc-1`, `east-sbc-2` | 100 | 200 | 201 |
| West | `west-sbc-1`, `west-sbc-2` | 110 | 210 | 211 |
| Central | `central-sbc-1`, `central-sbc-2` | 120 | 220 | 221 |

SBC_ID is stamped as `X-SBC-ID` header on all INVITEs heading to FreeSWITCH (visible in CDRs as `sip_h_X-SBC-ID` and in Homer SIP traces). Stripped before traffic leaves the platform (TO_CARRIER and PBX delivery paths).

### FreeSWITCH .env (per zone)

```bash
EXTERNAL_SIP_IP=<zone_fs_public_ip>     # FS VM's public IP (for SDP/RTP)
EXTERNAL_RTP_IP=<zone_fs_public_ip>
DB_HOST=<zone_pg_ip>                    # Local PG (primary or replica)
DB_PORT=6432
DB_NAME=voip
DB_USER=freeswitch
DB_PASS=<STRONG_FS_DB_PASSWORD>
REDIS_HOST=127.0.0.1                    # Local Redis
REDIS_PORT=6379
API_HOST=10.142.0.103                   # Centralized API in East
API_PORT=8088
HOMER_IP=10.142.0.103                   # Centralized Homer in East
SBC_PROXY_IP=<zone_signaling_vip>             # Zone's SBC signaling target. Active/standby HA: the zone's
                                              #   INTERNAL NLB VIP (always reaches the active SBC).
                                              #   Pre-HA (no ILB yet): sbc-1's direct VPC IP, as before.
SBC_PROXY_IP_FAILOVER=<zone_sbc1_internal_ip> # Belt-and-braces if the ILB itself fails: sbc-1's DIRECT
                                              #   VPC IP. Pre-HA: sbc-2's direct VPC IP (legacy meaning).
ESL_PASSWORD=<STRONG_ESL_PASSWORD>
TEST_MODE=false
FS_ZONE=<east|west|central>             # Selects priority_<zone> for the carrier_trunks termination order (default east)
FS_NODE_ID=<zone>-fs-<1|2>              # CDR freeswitch_node + metrics identity (FS-1 vs FS-2)
HEP_CAPTURE_ID=<200|201|210|211|220|221> # Per-node FS capture ID (compose default 200)
```

> `SBC_PROXY_IP_FAILOVER` is templated in `docker-compose.media.yml` (defaults to
> `SBC_PROXY_IP` if unset). It is the second SBC path in `inbound_router.lua`'s
> attempt loop: up to 4 `carrier_trunks` trunks × {`SBC_PROXY_IP`,
> `SBC_PROXY_IP_FAILOVER`} = 8 table-driven attempts, or the 4-attempt legacy
> `X-Carrier` loop when the table can't be resolved. **Active/standby HA meaning:** `SBC_PROXY_IP` = the zone's
> signaling VIP (internal NLB — UDP bridging and the TCP :5060 pre-check both land
> on the active SBC), `SBC_PROXY_IP_FAILOVER` = the primary SBC's direct VPC IP as
> a fallback for ILB failure. No Lua/FS config change is needed — both values are
> consumed verbatim as `<dest>@<ip>:5060` bridge targets and per-IP probe-cache
> keys. Legacy (pre-ILB) meaning — sbc-1 / sbc-2 direct IPs — still works and is
> what an unmigrated zone keeps running.

---

## Config Changes Required

| Component | Changes Needed |
|-----------|---------------|
| **FreeSWITCH** | **Zero.** All values come from env vars already (`FS_ZONE`, `FS_NODE_ID`, `HEP_CAPTURE_ID` per node). |
| **Kamailio** | **Done.** `BANDWIDTH_PRIMARY_IP`/`BANDWIDTH_SECONDARY_IP` (carrier egress), `INTERNAL_SUBNET`/`MEDIA_SUBNET` (trusted internal CIDRs), `SBC_SIGNALING_VIP` and `FREESWITCH_IP_2` are all env-templated in entrypoint.sh, with East/legacy defaults. A new zone only sets these in its `.env`. |
| **Lua scripts** | **Zero.** DB_HOST, Redis, API all from env vars; termination order from the `carrier_trunks` table. |
| **FastAPI** | **Not done (open).** Zone-aware ESL routing: ESL is still pinned to East FS-1 (`PRODUCTION_ARCHITECTURE.md` §12 #3). Lower priority since API Calling was retired on 2026-09-23. |
| **Docker images** | **Identical across zones.** Only .env files differ. |

---

## Failover Scenarios

The landing-page HA simulation (`HaArchitectureViz`, a 50-second loop with 4
scenarios, redrawn October 2026) animates these scenarios with generic labels.
The authoritative failure matrix is `PRODUCTION_ARCHITECTURE.md` §1.4. Note that
the SBC and FS drill logs are empty, so the times below are design values.

### Single SBC failure

- **Standby SBC (SBC-2) dies:** no traffic impact. The health check plus the
  `sbc_failover.tf` alert raise a page, and the zone runs unprotected until it
  is restored. *(Animation: "Central standby SBC lost".)*
- **Active SBC (SBC-1) dies:** the zone NLB and signaling ILB health checks
  (`/healthz`, 5 s × 2) flip **both** planes to SBC-2 in about 10–12 s.
  - **Calls in progress:** designed to continue. In-dialog requests are routed
    statelessly by the `;fs=` Record-Route marker, and RTP never touches the
    SBCs.
  - **Setups in flight during the flip:** lost. Their CANCELs get `481` from
    the new active.
  - **Failback:** automatic. *(Animation: "East active SBC lost".)*

### FreeSWITCH failure

- **FS-1 dies:** the Kamailio dispatcher declares it INACTIVE after 3 failed
  5 s OPTIONS probes. New calls then go to the hot-standby **FS-2** (alg 8
  priority), and failback is automatic.
  - Calls in progress on FS-1 are lost, because the media is anchored there.
  - `revup-fs-watchdog` pages.
- **Both FS in a zone down:** `/healthz` returns 503 on both SBCs, so the zone
  NLB drains. External SIP OPTIONS get 503 (`FS_AWARE_OPTIONS`), and the
  carriers retry the other zone VIPs. *(Animation: "West media down".)*

### Entire zone failure (all VMs in a region)

- The NLB sees all backends unhealthy; the GCM VIP uptime check is CRITICAL.
- ALL active calls in that zone are lost.
- The carriers, which already hold all 3 VIPs, retry the remaining zones. No
  carrier configuration change is needed. There is no DNS layer today; the
  planned Infoblox DTC steering would add one (`PRODUCTION_ARCHITECTURE.md` §3.5).
- The same state can be produced deliberately for maintenance (zone-dark via
  the drain plane, `PRODUCTION_ARCHITECTURE.md` §4.6).

### Carrier trunk failure (e.g., Dallas PoP down)

- **Table-driven legs (all RCF):** a 5xx/408/480/404 from the trunk goes back
  to FreeSWITCH (Kamailio flags 8+9). FS then dials the next entry in the zone
  priority list (Bandwidth LA, then Sinch LD backups), through either SBC
  path. Silence is bounded by `progress_timeout` (10 s) per attempt.
- **Legacy `X-Carrier` legs** (SIP-trunk/API non-8YY, and the RCF DB-failure
  fallback): Kamailio CARRIER_FAILURE flips to the other IP of the same
  Bandwidth trunk config, then cross-trunk to TC4 Dallas.
- Active calls already connected through the failed PoP may drop. New calls
  take the next route. *(Animation: "Route A lost" — East + Central retry on
  Route B.)*

### PostgreSQL primary failure

- Active calls: unaffected (already bridged, no DB needed).
- New calls:
  - West/Central keep routing from their local replicas.
  - East's FS reads the primary, so East DID lookups fail until promotion or
    repoint.
  - There is no Redis DID cache on the RCF path.
- Provisioning + CDR ingest: writes fail and the API returns 503.
- Recovery: promote `east-db-standby` (drilled at 0.143 s) and repoint per
  `docs/runbooks/DB_FAILOVER_RUNBOOK.md`.
- Future (not built): Patroni for automatic failover.

---

## Cross-Region Costs

| Traffic Type | Volume Estimate | Monthly Cost |
|-------------|----------------|-------------|
| PG replication (WAL streaming) | ~10-50 Mbps | $30-150 |
| HEP to centralized Homer | ~5 Mbps per zone | $15/zone |
| API ESL to remote FS | Negligible | < $1 |
| Cross-zone RTP | **ZERO** (stays in-zone) | $0 |
| Cross-zone SIP | **ZERO** (stays in-zone) | $0 |
| **Total cross-region** | | **~$60-180/month** |

---

## Total Cost Estimate

> **Historical estimate (pre-build), not re-estimated.** It assumes 13 VMs and
> no FS-2s, a `services` VM at e2-standard-4, and a Global Geo LB. Reality as of
> 2026-10-24:
> - 16 production VMs plus the banked `west-loadtest`, including 3 FS-2 VMs at
>   e2-standard-8 and `east-db-standby`.
> - `services` is e2-highmem-4.
> - No Geo LB. Instead there are 3 regional NLBs plus 3 internal signaling ILBs.
>
> Treat the figures below as the original plan only.

| Resource | Count | Monthly Cost |
|----------|-------|-------------|
| SBC VMs (e2-standard-4) | 6 | $582 |
| FreeSWITCH VMs (e2-standard-8) | 3 | $600 |
| Services VM (e2-standard-4) | 1 | $97 |
| PG Replica VMs (e2-standard-4) | 2 | $194 |
| Persistent disks (50-100GB SSD each) | 13 | $150 |
| Static external IPs | ~9 | $0 (attached) |
| Global Geo LB (1 anycast VIP) | 1 | $50 |
| Cross-region egress | | $100 |
| **Total** | **13 VMs** | **~$1,773/month** |
| **With 1-year CUDs** | | **~$1,350/month** |

Cost of the original 4-VM East-only POC (historical): ~$450/month.

---

## Implementation Phases

### Status summary (as of 2026-10-24)

Dates are taken only from repo docs and git history.

| Item | Status | Date / source |
|------|--------|---------------|
| East zone POC → production | ✅ DONE | multi-VM SIP lessons 2026-04-29/30 (root `CLAUDE.md`) |
| DB safety net + East DB HA (`east-db-standby`) | ✅ DONE | `docs/NATIONWIDE_PRODUCTION_ROLLOUT_PLAN.md` §0 (2026-07-23) |
| West zone LIVE (`west-db` replica 2026-07-22) | ✅ DONE | 2026-07-23 (rollout plan §0) |
| Central zone LIVE | ✅ DONE | 2026-07-23 (rollout plan §0; live-call validated) |
| Geo Load Balancer (global anycast) | ❌ NOT BUILT — superseded | GCP has no global UDP passthrough NLB; regional NLBs + carrier multi-VIP distribution instead |
| Active/standby SBC pair + signaling ILB, all zones | ✅ DONE | 2026-08-26/27 (`docs/SBC_ACTIVE_STANDBY_RUNBOOK.md`) |
| FS media HA (FS-2 per zone, alg 8) | ✅ DONE | 2026-08-31 (`docs/FS_MEDIA_HA_RUNBOOK.md`) |
| Sinch origination actually working (`allow-sinch-sip` firewall) | ✅ DONE | 2026-08-31 (`PRODUCTION_ARCHITECTURE.md` §6.2) |
| STIR/SHAKEN signing on all 6 SBCs; x5u self-hosted | ✅ LIVE | x5u live 2026-08-05; cert issued 2026-08 (`docs/STIR_SHAKEN_IMPLEMENTATION_PLAN.md`). Inbound own-crypto verify is still **DARK** |
| Maintenance drain plane | ✅ DONE | 2026-09-03/04 (`PRODUCTION_ARCHITECTURE.md` §4.6) |
| `services` VM resize to e2-highmem-4 | ✅ DONE | 2026-09-02 |
| API Calling retired; CDR A/B leg split; G.107 call quality | ✅ DONE | API Calling retired 2026-09-23 (e408e15), shipped in #129 (merged 2026-09-24); B-leg CDRs live 2026-09-24 |
| Sinch toll-free 8XX-T origination | ✅ DONE (test TNs only) | 2026-10-15 (#139) |
| Sinch redundant LD/8YY termination rows | ✅ MERGED (rows seeded disabled) | 2026-10-23 (#144, migration 53) |
| Encrypted voicemail v1 + transcription v1.1 | ✅ MERGED | 2026-10-23 (#149, #151) |
| Geo/DNS steering (Infoblox DTC `crag.` / `orig.granitevoip.com`) | ⏳ PLANNED | `docs/INFOBLOX_DTC_CRAG_DNS_ASK.md` (request outstanding) |
| OpenTofu import of the fleet | ⏳ PLANNED | `infra/OPENTOFU_PLAN.md` (Phase 5 import pending) |
| Zone-aware ESL (ESL → FS-2 failover) | ⏳ OPEN | `PRODUCTION_ARCHITECTURE.md` §12 #3 |
| Logged SBC/FS failover drills | ⏳ OPEN | `PRODUCTION_ARCHITECTURE.md` §12 #14 |
| Patroni / automatic PG failover | ⏳ NOT STARTED | — |

The phase write-ups below are the **original plan**, annotated where reality differed.

### Phase 1: East Zone (POC) — COMPLETE ✓

- 4 VMs deployed in us-east1-b (2 SBCs + 1 FS + 1 Services)
- Regional NLB operational (34.24.133.82). It was meant to be interim until a
  Geo LB, but it is **still the East production VIP**; no Geo LB was built.
- Bandwidth configured with East VIP
- PostgreSQL bare + PgBouncer running
- API, UI, Homer operational
- SBC_ID / HEP_CAPTURE_ID templating ready. The plan gave east-sbc-1=100,
  east-sbc-2=101; as deployed, both SBCs of a zone share the zone ID (East 100).

### Phase 2: West Zone + Geo Load Balancer (Weeks 1-3) — West DONE (LIVE 2026-07-23); Geo LB NOT BUILT

> West was built with its own regional NLB (35.252.214.40), not behind a Geo LB.
> Steps 1–6 and 14–17 (Geo LB provisioning and cutover) never happened and must
> not be run. GCP offers no global passthrough NLB for UDP, and Bandwidth is
> configured with all three regional VIPs instead. DNS steering is the planned
> successor (`docs/INFOBLOX_DTC_CRAG_DNS_ASK.md`).

**Geo LB provisioning (historical plan — not executed):**
1. Reserve global static anycast IP for Geo LB VIP
2. Create Global External Passthrough NLB with Premium Tier networking
3. Create global backend service with CLIENT_IP affinity, TCP 5060 health check
4. Add East instance group (sbc-group-east) as first backend
5. Verify East traffic works through Geo LB VIP (test alongside regional NLB)
6. Request Bandwidth IP whitelisting for Geo LB VIP (1-5 business day lead time)

**West zone deployment:**
7. Deploy PG streaming replica in us-west1-b with PgBouncer
8. Reserve static IPs for 2 SBCs + 1 FS in us-west1-b
9. Deploy VMs from instance templates (same Docker images, zone-specific .env)
10. Configure .env: SBC_ID=west-sbc-{1,2}, HEP_CAPTURE_ID=110/111 *(as deployed: 110 for both)*, BANDWIDTH_PRIMARY_IP=216.82.238.134
11. Create West instance group (sbc-group-west), add to Geo LB backend service
12. Request Bandwidth whitelisting for West SBC public IPs (origination)
13. Add `BANDWIDTH_PRIMARY_IP` / `BANDWIDTH_SECONDARY_IP` env vars to Kamailio entrypoint

**Cutover:**
14. Update Bandwidth termination host: replace East VIP with Geo LB VIP
15. Update all East SBC .env: EXTERNAL_SIP_IP → Geo LB VIP (rebuild containers)
16. Test: inbound calls via Geo LB to both regions, outbound from each region
17. Decommission East regional NLB (no longer needed)
18. SIPp load test at target CPS per region

### Phase 3: Central Zone (Weeks 3-5) — DONE (LIVE 2026-07-23)

> Central was cloned from West, with its own regional NLB 35.253.133.230 and
> `central-db` at 10.128.0.2. It was validated by a live call. Step 5's
> "add to Geo LB backend service" did not happen (there is no Geo LB), and the
> HEP IDs are per zone (120 for both SBCs), not 120/121.

1. Deploy PG streaming replica in us-central1-b with PgBouncer
2. Reserve static IPs for 2 SBCs + 1 FS in us-central1-b
3. Deploy VMs (same Docker images, zone-specific .env)
4. Configure .env: SBC_ID=central-sbc-{1,2}, HEP_CAPTURE_ID=120/121 *(as deployed: 120 for both)*, BANDWIDTH_PRIMARY_IP=67.231.2.12
5. Create Central instance group (sbc-group-central), add to Geo LB backend service
6. Request Bandwidth whitelisting for Central SBC public IPs (origination)
7. Full 3-region failover testing:
   - Kill one SBC per region → verify intra-region failover
   - Kill all SBCs in one region → verify cross-region reroute via Geo LB
   - Kill carrier trunk → verify Kamailio failover to secondary PoP
8. Verify Homer receives HEP from all 6 SBCs with distinct capture_ids

### Phase 4: Hardening (Weeks 5-8)

1. ~~Per-zone Internal LB for FS→SBC outbound failover~~ **DONE 2026-08-26/27.** This is the signaling ILB (`.250`) with the same failover backends as the external NLB (active/standby SBC pair).
2. Zone-aware ESL routing in FastAPI (originate calls on correct zone's FS). **OPEN:** ESL is still pinned to East FS-1 (`PRODUCTION_ARCHITECTURE.md` §12 #3).
3. ~~Per-zone Homer capture_id templating~~ **DONE.** SBC_ID and HEP_CAPTURE_ID env vars are in entrypoint.sh and the compose files. Naming is `{region}-sbc-{n}`. As deployed, the SBC capture IDs are one per zone (East 100, West 110, Central 120, shared by both SBCs). FS uses 200/210/220 for FS-1 and 201/211/221 for FS-2.
4. ~~Cloud Monitoring agents + alerting~~ **DONE.** Per-VM vmagent feeds East VictoriaMetrics, and GCM alerting runs from `infra/monitoring` (VIP uptime, SBC failover state, FS watchdog, replication guard) (`PRODUCTION_ARCHITECTURE.md` §9). The Geo LB health item is n/a.
5. ~~Homer dashboard: per-SBC call volume, per-region call distribution~~ **DONE** as Grafana NOC boards (7) plus the native Troubleshooting page (`PRODUCTION_ARCHITECTURE.md` §9.3).
6. ~~Database backup verification~~ **DONE.** A restore was proven in a real recovery: zero loss in ~4 min (`docs/NATIONWIDE_PRODUCTION_ROLLOUT_PLAN.md` §0).
7. ~~Runbook: all failover procedures documented~~ **DONE.** See `docs/SBC_ACTIVE_STANDBY_RUNBOOK.md`, `docs/FS_MEDIA_HA_RUNBOOK.md` and `docs/runbooks/DB_*`, plus the maintenance drain plane (`PRODUCTION_ARCHITECTURE.md` §4.6). Geo LB backend drain is n/a. The drill logs are still empty (§12 #14).
8. Security: Secret Manager for credentials, IAM review. **OPEN:** secrets still live in the per-VM `.env` and `/opt/revup/secrets/`.

### Phase 5: Optimization (Weeks 9-12)

1. Evaluate Patroni for automatic PG failover. *(Not started.)*
2. Consider Cloud SQL migration if DBA overhead warrants it. *(Not started.)*
3. Per-zone API deployment if needed for call-path features. *(Not done. The API is East-only, and every zone POSTs CDRs and voicemail there.)*
4. Load testing: SIPp at 500 CPS per zone (1500 CPS total platform). *(Banked. The `west-loadtest` harness proved West call setup to ~50 CPS, but in-dialog teardown against the topology-hiding SBC could not be completed from an intra-VPC source — `docs/NATIONWIDE_PRODUCTION_ROLLOUT_PLAN.md` §0.)*
5. Right-size VMs based on observed utilization. *(Partly done: `services` was resized to e2-highmem-4 on 2026-09-02.)*
6. Committed use discounts (1-year CUDs on stable fleet).
7. *(Added.)* OpenTofu import of the hand-built fleet. *(Pending — `infra/OPENTOFU_PLAN.md`. Only `infra/monitoring`, `infra/backups` and `infra/voicemail` are tofu-managed.)*
8. *(Added.)* Geo/DNS steering via Infoblox DTC. *(Planned — `docs/INFOBLOX_DTC_CRAG_DNS_ASK.md`.)*

### Phase 6: VxRail Decommission (Month 3-24)

1. Identify remaining VxRail dependencies (if any)
2. Verify GCP 3-region HA covers all DR scenarios
3. Migrate DNS records
4. Remove VxRail carrier whitelists
5. Decommission VxRail after 3-month burn-in

---

## East Zone — Current Deployed State

### IP Assignment

This matches root `CLAUDE.md` "GCP Production Topology" and
`PRODUCTION_ARCHITECTURE.md` §2.1. West and Central have the same shape; their
IPs are in those tables.

| VM | Role | Internal IP | External IP | SBC_ID / node | HEP_CAPTURE_ID |
|---|---|---|---|---|---|
| poc-custom-voip | SBC-1 (active) | 10.142.0.100 | 34.74.71.32 | east-sbc-1 | 100 |
| kam-g2 | SBC-2 (standby) | 10.142.0.101 | 35.243.136.35 | east-sbc-2 | 100 (shared per zone) |
| fs-media-v2 | FS-1 (active) + Redis | 192.168.10.2 (voip-media subnet) | 34.139.119.135 | east-fs-1 | 200 |
| east-fs-2 | FS-2 (hot standby) | 192.168.10.3 (voip-media subnet) | 35.196.226.123 | east-fs-2 | 201 |
| services | PG primary + API + UI + Homer (e2-highmem-4) | 10.142.0.103 | 34.26.57.37 | — | — |
| east-db-standby | PG hot standby (us-east1-c) | 10.142.0.87 | — | — | — |
| **VIP (Regional external NLB)** | carrier ingress | — | **34.24.133.82** | — | — |
| **VIP (Internal signaling ILB)** | FS → active SBC | 10.142.0.250 | — | — | — |

**Note:** The regional NLB (34.24.133.82) is the permanent East VIP, not an
interim one; no Geo LB was built. SBC `EXTERNAL_SIP_IP` = the zone VIP.

### Current Load-Balancer Components (East)

Names are from the `docs/SBC_ACTIVE_STANDBY_RUNBOOK.md` per-zone table.

```
External NLB (carrier plane):
  Health Check:    east-sbc-fs-aware-hc (HTTP :8080 /healthz, 5s interval / 2 — VIP-addressed probes)
  Backend Service: sbc-backend (failover policy: failover-ratio=0, drop-traffic-if-unhealthy,
                   no-connection-drain-on-failover; automatic failback)
  Instance Groups: sbc-group (primary: poc-custom-voip) + sbc-standby-group (failover: kam-g2)
  Forwarding Rule: sbc-vip-udp (34.24.133.82, UDP:5060)
  Forwarding Rule: sbc-vip-tcp (34.24.133.82, TCP:5060)
Internal signaling ILB (FS plane):
  Backend Service: sbc-signaling-backend (same groups, same health check, same policy)
  Forwarding Rule: sbc-signaling-fwd (10.142.0.250)
```
The legacy TCP `*-sbc-health-check` health checks were deleted after the
2026-08-26 migration.

### Verification Checklist

```bash
# SBCs — dispatcher health
sudo docker logs voip-kamailio --tail 5  # Should show OPTIONS 200 OK

# SBCs — VIP and SBC_ID templating
sudo docker exec voip-kamailio grep "ADVERTISE_IP\|hep_capture_id\|X-SBC-ID" /etc/kamailio/kamailio.cfg | head -3

# SBCs — verify SBC identity in startup log
sudo docker logs voip-kamailio 2>&1 | grep "config templated"
# Should show: SBC_ID=east-sbc-1 (or east-sbc-2), HEP_ID=100 (both East SBCs)

# SBCs — fs-aware health endpoint (what the NLB + ILB probe)
curl -s http://127.0.0.1:8080/healthz   # Should show: OK fs_up=1 (503 DRAINING maint=1 while drained)

# FS — sofia profiles
sudo docker exec voip-freeswitch sh -c '/usr/local/freeswitch/bin/fs_cli -p $ESL_PASSWORD -x "sofia status"'

# Services — API health
curl -s http://localhost:8088/health

# NLB + ILB — backend health (expect primary HEALTHY; the owner runs gcloud)
gcloud compute backend-services get-health sbc-backend --region=us-east1
gcloud compute backend-services get-health sbc-signaling-backend --region=us-east1

# (Historical — the Geo LB was never built; there is no sbc-backend-global)
```

### Rollback

> **HISTORICAL (East POC era) — DO NOT RUN.** This block checks out
> `Full-System` and runs a bare single-machine `docker compose` with the local
> dev file. On any production VM that would replace the RCF-V1 stack, and it
> would drop the STIR key overlay on SBCs. Today's rollbacks are per change:
> - The recorded rollback SHA plus the per-VM compose files from each
>   maintenance runbook (e.g. `docs/runbooks/MAINTENANCE_2026-10_ALL_OPEN_PRS.md`).
> - The SBC HA rollback in `docs/SBC_ACTIVE_STANDBY_RUNBOOK.md`.
> - DB rollback via `docs/runbooks/DB_FAILOVER_RUNBOOK.md` / `DB_RESTORE_RUNBOOK.md`.
>
> The block is kept only as a record.

```bash
cd /opt/revup
sudo git checkout Full-System
sudo docker compose down
sudo docker compose build
sudo docker compose up -d
# Update Bandwidth termination host back to 34.74.71.32
```
