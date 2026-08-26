# GCP Multi-Zone Production Deployment Plan — RCF-V1

## Strategic Context

VxRail on-prem environment decommissioning within 2 years (announced April 2026).
All 3 planned locations will be deployed in GCP instead of on-prem. Each zone is
a self-contained call processing unit — calls that enter a zone stay in that zone
for both SIP signaling and RTP media. No cross-zone RTP traffic ever occurs.

---

## Architecture Overview

```
               BANDWIDTH CARRIER (Origination)
              (Account 9900717, Peer 1162116)
               Dallas PoP         LA PoP
            67.231.2.12      216.82.238.134
                   \              /
                    \            /
             ┌───────────────────────────┐
             │  GCP Global External LB   │
             │  (Geo Load Balancer)      │
             │  Single Anycast VIP       │
             │  <geo-vip>                │
             │  Premium Tier Networking  │
             └─────┬─────────┬─────────┬─┘
                   │         │         │
         ┌─────────┘         │         └─────────┐
         │                   │                   │
    GRANITE EAST        GRANITE CENTRAL      GRANITE WEST
    us-east1-b          us-central1-b        us-west1-b
    South Carolina      Iowa                 Oregon
    (DEPLOYED)          (Phase 3)            (Phase 2)
         │                   │                   │
   ┌─────┴──────┐     ┌─────┴──────┐      ┌─────┴──────┐
   │east  │east  │     │cntrl │cntrl │     │west  │west  │
   │sbc-1 │sbc-2 │     │sbc-1 │sbc-2 │     │sbc-1 │sbc-2 │
   │ KAM  │ KAM  │     │ KAM  │ KAM  │     │ KAM  │ KAM  │
   └──┬───┘──┬───┘     └──┬───┘──┬───┘     └──┬───┘──┬───┘
      └───┬──┘            └───┬──┘            └───┬──┘
          │                   │                   │
      ┌───┴───┐          ┌───┴───┐           ┌───┴───┐
      │  FS   │          │  FS   │           │  FS   │
      │+Redis │          │+Redis │           │+Redis │
      └───┬───┘          └───┬───┘           └───┬───┘
          │                   │                   │
          │      Outbound (Termination)           │
          │      via nearest Bandwidth PoP        │
          │                   │                   │
          │         Dallas PoP    LA PoP          │
          │         67.231.2.12   216.82.238.134   │
          │                   │                   │
          │      VPC Internal Routing             │
          └──────────┬────────┴───────────────────┘
                     │
               ┌─────┴─────┐    ┌───────────┐
               │ PG Primary │    │ Services  │
               │ PgBouncer  │    │ API + UI  │
               │ us-east1-b │    │ Homer     │
               └─────┬──────┘   │ us-east1-b│
                     │           └───────────┘
              ┌──────┴──────┐
              │             │
        ┌─────┴────┐  ┌────┴─────┐
        │PG Replica│  │PG Replica│
        │us-west1-b│  │us-central│
        │PgBouncer │  │PgBouncer │
        └──────────┘  └──────────┘
```

### Call Flow Stages (matches Granite CRAG HA animation)

| Stage | Animation Name | Component | Description |
|-------|---------------|-----------|-------------|
| 1. Origination | Inbound Trunks | Bandwidth Dallas + LA PoPs | Dual carrier trunks deliver calls |
| 2. Distribution | Key Distributor | Geo Load Balancer | Single anycast VIP routes to nearest healthy region |
| 3. Processing | Signal Keys + CRAG Engine | Kamailio SBC pair + FreeSWITCH | Per-region call processing, RTP stays in-zone |
| 4. Termination | Dallas / LA / Backup PoP | Bandwidth outbound | Each region sends outbound via nearest carrier PoP |

---

## Region Selection

| Zone | GCP Region | GCP Zone | Bandwidth Proximity | Role |
|------|-----------|----------|---------------------|------|
| **East** | us-east1 (South Carolina) | us-east1-b | Dallas PoP ~20ms, Atlanta ~10ms | Active (DEPLOYED) |
| **West** | us-west1 (Oregon) | us-west1-b | LA PoP (216.82.238.134) ~15ms | Active (Phase 2) |
| **Central** | us-central1 (Iowa) | us-central1-b | Equidistant both PoPs ~25ms | Active (Phase 3) |

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
VPC: default (existing)
  Subnet: us-east1     10.142.0.0/20    (existing)
  Subnet: us-west1     10.138.0.0/20    (new)
  Subnet: us-central1  10.128.0.0/20    (new)
  Subnet: voip-media   192.168.10.0/24  (East FS — Cloud-NAT-excluded)
```

**⚠️ Cloud NAT exclusion is mandatory for FreeSWITCH VMs.** GCP Cloud NAT on the
`default` subnet replaces a VM's 1:1 external IP with a NAT-pool IP, which makes
Bandwidth drop all RTP/SIP (source IP ≠ SDP-negotiated IP). The East FS lives on a
dedicated `voip-media` subnet (`192.168.10.0/24`, internal IP **192.168.10.2**) that
is **not** in the Cloud NAT router's list. **Every new zone's FS must do the same** —
either a per-region `voip-media-{region}` subnet excluded from Cloud NAT, or the
`bypass-vpn` network tag. SBC VMs use the `bypass-vpn` tag. See root `CLAUDE.md`,
"GCP Cloud NAT Breaks VoIP".

### Per-Zone IP Allocation

| Role | East (deployed) | West | Central |
|------|----------------|------|---------|
| SBC-1 | 10.142.0.100 | 10.138.0.100 | 10.128.0.100 |
| SBC-2 | 10.142.0.101 | 10.138.0.101 | 10.128.0.101 |
| FreeSWITCH | **192.168.10.2** (voip-media subnet) | TBD (per-region media subnet or bypass-vpn) | TBD (per-region media subnet or bypass-vpn) |
| PG Replica | 10.142.0.103 (primary) | 10.138.0.103 | 10.128.0.103 |

> **Note:** The East FS is on the Cloud-NAT-excluded `voip-media` subnet at
> `192.168.10.2`, **not** `10.142.0.102`. West/Central FS VMs must likewise sit on a
> Cloud-NAT-excluded subnet or carry the `bypass-vpn` tag (see the Cloud NAT warning
> above) — do not place them at `10.138.0.102` / `10.128.0.102` on the default subnet.

### Geo Load Balancer (Key Distributor)

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

**Current (East-only POC):** Regional External Passthrough NLB with VIP 34.24.133.82.
Will be replaced by the global LB when Phase 2 deploys. East regional LB stays as
an intermediate step until the global LB is provisioned with backends in 2+ regions.

### Firewall Rules (VPC-wide, all zones)

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

Each zone is identical: 3 VMs running the same Docker images with zone-specific .env files.

| VM Role | Machine Type | Count/Zone | Networking |
|---------|-------------|------------|------------|
| Kamailio SBC | e2-standard-4 | 2 | Host networking, static external IP, default subnet, `bypass-vpn` tag |
| FreeSWITCH + Redis | e2-standard-8 | 1 | Host networking, static external IP, **Cloud-NAT-excluded media subnet** |

### Shared Services (Centralized in East)

| VM Role | Machine Type | Count | Location |
|---------|-------------|-------|----------|
| PG Primary + PgBouncer + API + UI + Homer | e2-standard-4 | 1 | us-east1-b (existing) |
| PG Replica + PgBouncer | e2-standard-4 | 1 | us-west1-b |
| PG Replica + PgBouncer | e2-standard-4 | 1 | us-central1-b |

**Total: 13 VMs** (9 zone + 4 shared)

---

## Database Strategy

### Primary-Replica Streaming Replication

Writes are centralized (DID provisioning, CDRs). Reads are call-path-critical (DID lookups on every call). Multi-master is unnecessary complexity.

```
PG Primary (us-east1-b, 10.142.0.103)
  ├── Streaming replica → us-west1-b (10.138.0.103)
  └── Streaming replica → us-central1-b (10.128.0.103)
```

Each replica runs PgBouncer (:6432) for local zone FS/Kamailio connections.

### Connection Routing

| Zone | DB_HOST (call-path reads) | DB writes (API) |
|------|--------------------------|-----------------|
| East | 10.142.0.103 (primary, local) | 10.142.0.103 (local) |
| West | 10.138.0.103 (replica, local) | 10.142.0.103 (cross-region, ~50ms) |
| Central | 10.128.0.103 (replica, local) | 10.142.0.103 (cross-region, ~20ms) |

### Replication Lag

Typical cross-region streaming replication lag: 100-500ms (async). Acceptable for DID routing — a number provisioned 500ms ago works fine. CDR writes go to primary after call completion (not in call setup path), so cross-region write latency is invisible.

### Failover

If PG primary goes down:
- **Active calls:** Unaffected (already bridged, no DB needed)
- **New calls:** Work for cached DIDs (Redis, 5-min TTL). Uncached DIDs fail DB lookup.
- **Provisioning:** All writes fail, API returns 503
- **Recovery:** Manually promote a replica (`pg_ctl promote`), update DB_HOST. ~15-30 min.
- **Phase 2:** Add Patroni for automatic failover (~30 seconds)

---

## Redis Design

Per-zone local Redis on each FreeSWITCH VM (127.0.0.1:6379). No cross-zone sharing.

- **DID cache:** 5-minute TTL, cache miss falls through to local PG replica
- **Velocity counters:** Zone-local counting (slightly less accurate if calls split across zones, acceptable for fraud prevention)
- **Session state:** Inherently local to the FS handling the call

If Redis fails: DID lookups fall through to PostgreSQL (+5-10ms per call). No calls dropped.

---

## Bandwidth Carrier Configuration

### Single SIP Peer, Single Termination Host

All DIDs stay on SIP peer 1162116. Bandwidth sends all inbound calls to one IP —
the Geo LB anycast VIP. GCP handles geographic distribution, not Bandwidth.
No priority failover on the Bandwidth side.

```
SIP Peer: 1162116 (GraniteTelecommunicationsLLC_O3)
  Termination Host:
    <geo-vip>   (Single Global Anycast VIP — all regions)

  Origination Hosts (outbound — SBCs send directly to Bandwidth):
    <geo-vip>                    (Global VIP — in SIP headers)
    + all 6 SBC public IPs      (actual packet source IPs)
```

**Why all 6 SBC public IPs in origination:** Outbound INVITEs from Kamailio leave
from the SBC's own external IP (not the VIP). Bandwidth must whitelist these IPs
to accept outbound traffic. The VIP is in SIP headers (From, Contact, Via) so
in-dialog responses route back through the Geo LB.

### Failover Behavior

Failover is handled by GCP, not Bandwidth:

| Failure | Who Detects | Recovery Time | Behavior |
|---------|------------|---------------|----------|
| Single SBC | Geo LB health check | ~15s | Route to other SBC in same region |
| Entire region | Geo LB health check | ~15s | Route to next nearest healthy region |
| Bandwidth 503 | N/A (transparent) | Instant | Never reaches Bandwidth — GCP only sends to healthy backends |

Bandwidth no longer needs to handle failover. It always sends to the single VIP,
and GCP guarantees the packet reaches a healthy SBC.

### Per-Region Carrier PoP Selection (Outbound Termination)

Each region's Kamailio sends outbound calls to the nearest Bandwidth signaling proxy.
Configured via `BANDWIDTH_PRIMARY_IP` / `BANDWIDTH_SECONDARY_IP` env vars per zone.

| Region | X-Carrier=primary | X-Carrier=secondary (failover) |
|--------|------------------------------|------------------------------|
| East | 67.231.2.12 (Dallas, ~20ms) | 216.82.238.134 (LA) |
| West | 216.82.238.134 (LA, ~15ms) | 67.231.2.12 (Dallas) |
| Central | 67.231.2.12 (Dallas, ~25ms) | 216.82.238.134 (LA) |

Requires 2 env vars per zone: `BANDWIDTH_PRIMARY_IP`, `BANDWIDTH_SECONDARY_IP`.

---

## Per-Zone Environment Variables

### SBC .env (per zone, per SBC instance)

```bash
EXTERNAL_SIP_IP=<geo-vip>               # Global Geo LB anycast VIP (advertised; same for ALL SBCs)
SBC_INTERNAL_IP=<this_sbc_vpc_ip>       # THIS SBC's own VPC IP — inner Record-Route, FS-facing listen, alias=
FS_PUBLIC_IP=<zone_fs_public_ip>        # Zone FS public IP — SDP rewrite target (RTP bypasses the NLB)
FREESWITCH_IP=<zone_fs_internal_ip>     # Zone's local FS (dispatcher target)
DB_HOST=<zone_pg_ip>                    # Local PG (primary or replica)
DB_PORT=6432
DB_USER=freeswitch
DB_PASS=<STRONG_FS_DB_PASSWORD>
HOMER_IP=10.142.0.103                   # Centralized Homer in East
BANDWIDTH_PRIMARY_IP=<nearest_bw_pop>   # Nearest Bandwidth PoP (East 67.231.2.12, West 216.82.238.134)
BANDWIDTH_SECONDARY_IP=<far_bw_pop>     # Far Bandwidth PoP (failover)
INTERNAL_SUBNET=<zone_vpc_subnet>       # This zone's VPC subnet (East 10.142.0.0/20, West 10.138.0.0/20)
MEDIA_SUBNET=<zone_media_subnet>        # This zone's FS media subnet (East 192.168.10.0/24)
SBC_ID=<region>-sbc-<n>                 # e.g. east-sbc-1, west-sbc-2
HEP_CAPTURE_ID=<see table below>        # Unique per-SBC Homer capture ID
# Optional (defaults preserve current behavior — usually leave unset):
# SBC_SIGNALING_VIP=<zone_ilb_vip>      # Active/standby HA: per-zone INTERNAL passthrough-NLB VIP (see below)
# BW_CPS_LIMIT=100                      # Inbound CPS flood backstop per Bandwidth IP (503 above this)
# TESTING_IP=                           # Trusted SIPp test source. UNSET in prod (disabled by default)
# BANDWIDTH_TC1_NY / TC1_ATL / TC2_DAL / TC2_LA  # Fixed TC1/TC2 PoPs (defaults = production IPs)
```

Media VM additionally supports (optional): `BRIDGE_PROGRESS_TIMEOUT=10` — per-attempt
`progress_timeout` (max seconds to wait for carrier 180/183 before failing over to the
next SBC/carrier; ringing then continues to call_timeout).

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

#### Active/standby SBC pair — `SBC_SIGNALING_VIP` (optional, per zone)

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
VPC IP. Never set the var before the ILB answers on the VIP: new dialogs would
carry an inner Route that nothing serves.

#### SBC Identity & Homer Capture ID Mapping

Single Homer instance receives HEP from all 6 SBCs. Each needs a unique capture_id.

| Region | SBC | SBC_ID | HEP_CAPTURE_ID |
|--------|-----|--------|----------------|
| East | 1 | `east-sbc-1` | 100 |
| East | 2 | `east-sbc-2` | 101 |
| West | 1 | `west-sbc-1` | 110 |
| West | 2 | `west-sbc-2` | 111 |
| Central | 1 | `central-sbc-1` | 120 |
| Central | 2 | `central-sbc-2` | 121 |

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
```

> `SBC_PROXY_IP_FAILOVER` is templated in `docker-compose.media.yml` (defaults to
> `SBC_PROXY_IP` if unset) and drives the 4-attempt SBC×carrier failover loop in
> `inbound_router.lua`. **Active/standby HA meaning:** `SBC_PROXY_IP` = the zone's
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
| **FreeSWITCH** | **Zero.** All values come from env vars already. |
| **Kamailio** | **Done.** `BANDWIDTH_PRIMARY_IP`/`BANDWIDTH_SECONDARY_IP` (carrier egress) and `INTERNAL_SUBNET`/`MEDIA_SUBNET` (trusted internal CIDRs) are now env-templated in entrypoint.sh, with East defaults. New zone only sets these in its `.env`. |
| **Lua scripts** | **Zero.** DB_HOST, Redis, API all from env vars. |
| **FastAPI** | **Phase 2.** Add zone-aware ESL routing for multi-zone call origination. |
| **Docker images** | **Identical across zones.** Only .env files differ. |

---

## Failover Scenarios

All failover is demonstrated in the Granite CRAG HA animation on the platform homepage
(HaArchitectureViz component — 64-second cycle showing 4 failure modes).

### Single SBC failure (e.g., east-sbc-2 dies)

- Geo LB health check detects in ~15s, removes from backend
- ~50% of active calls on that SBC are lost (in-progress RTP unaffected, SIP signaling lost)
- New calls route to the healthy SBC in the same region
- **Animation: Signal Key failure** — traffic reroutes through the other Signal Key

### FreeSWITCH failure (zone FS dies)

- Kamailio dispatcher detects in ~15s, both SBCs return 503
- Geo LB sees both SBCs returning errors, marks region unhealthy
- ALL active calls in that zone are lost
- New calls automatically route to the next nearest healthy region
- **Animation: Entire datacenter failure** — traffic redistributes to remaining locations

### Entire zone failure (all VMs in a region)

- Geo LB detects all backends unhealthy in ~15s
- ALL active calls in that zone are lost
- GCP automatically routes new traffic to next nearest healthy region
- No Bandwidth configuration change needed — single VIP stays the same
- **Animation: Datacenter failure** — same visualization

### Carrier trunk failure (e.g., Dallas PoP down)

- Kamailio CARRIER_FAILURE route detects 503/408 from primary Bandwidth IP
- Retries on secondary Bandwidth IP (e.g., LA PoP)
- Active calls on Dallas trunk may drop; new calls use LA PoP
- **Animation: Dallas trunk failure** — outbound reroutes to LA + Backup

### PostgreSQL primary failure

- Active calls: unaffected (already bridged, no DB needed)
- New calls: work for cached DIDs (Redis, 5-min TTL). Uncached DIDs fail.
- Provisioning: all writes fail, API returns 503
- Recovery: manually promote a replica (`pg_ctl promote`), update DB_HOST. ~15-30 min.
- Phase 2: add Patroni for automatic failover (~30 seconds)

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

Current 4-VM (East only) cost: ~$450/month.

---

## Implementation Phases

### Phase 1: East Zone (POC) — COMPLETE ✓

- 4 VMs deployed in us-east1-b (2 SBCs + 1 FS + 1 Services)
- Regional NLB operational (34.24.133.82) — interim until Geo LB
- Bandwidth configured with East VIP
- PostgreSQL bare + PgBouncer running
- API, UI, Homer operational
- SBC_ID / HEP_CAPTURE_ID templating ready (east-sbc-1=100, east-sbc-2=101)

### Phase 2: West Zone + Geo Load Balancer (Weeks 1-3)

**Geo LB provisioning (do first — long lead items):**
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
10. Configure .env: SBC_ID=west-sbc-{1,2}, HEP_CAPTURE_ID=110/111, BANDWIDTH_PRIMARY_IP=216.82.238.134
11. Create West instance group (sbc-group-west), add to Geo LB backend service
12. Request Bandwidth whitelisting for West SBC public IPs (origination)
13. Add `BANDWIDTH_PRIMARY_IP` / `BANDWIDTH_SECONDARY_IP` env vars to Kamailio entrypoint

**Cutover:**
14. Update Bandwidth termination host: replace East VIP with Geo LB VIP
15. Update all East SBC .env: EXTERNAL_SIP_IP → Geo LB VIP (rebuild containers)
16. Test: inbound calls via Geo LB to both regions, outbound from each region
17. Decommission East regional NLB (no longer needed)
18. SIPp load test at target CPS per region

### Phase 3: Central Zone (Weeks 3-5)

1. Deploy PG streaming replica in us-central1-b with PgBouncer
2. Reserve static IPs for 2 SBCs + 1 FS in us-central1-b
3. Deploy VMs (same Docker images, zone-specific .env)
4. Configure .env: SBC_ID=central-sbc-{1,2}, HEP_CAPTURE_ID=120/121, BANDWIDTH_PRIMARY_IP=67.231.2.12
5. Create Central instance group (sbc-group-central), add to Geo LB backend service
6. Request Bandwidth whitelisting for Central SBC public IPs (origination)
7. Full 3-region failover testing:
   - Kill one SBC per region → verify intra-region failover
   - Kill all SBCs in one region → verify cross-region reroute via Geo LB
   - Kill carrier trunk → verify Kamailio failover to secondary PoP
8. Verify Homer receives HEP from all 6 SBCs with distinct capture_ids

### Phase 4: Hardening (Weeks 5-8)

1. Per-zone Internal LB for FS→SBC outbound failover
2. Zone-aware ESL routing in FastAPI (originate calls on correct zone's FS)
3. ~~Per-zone Homer capture_id templating~~ **DONE** — SBC_ID and HEP_CAPTURE_ID env vars in entrypoint.sh and compose files. Naming: `{region}-sbc-{n}`, capture IDs: East=100/101, West=110/111, Central=120/121
4. Cloud Monitoring agents + alerting (Geo LB health, FS status, PG replication lag)
5. Homer dashboard: per-SBC call volume, per-region call distribution
6. Database backup verification (test restore from replica)
7. Runbook: all failover procedures documented (including Geo LB backend drain)
8. Security: Secret Manager for credentials, IAM review

### Phase 5: Optimization (Weeks 9-12)

1. Evaluate Patroni for automatic PG failover
2. Consider Cloud SQL migration if DBA overhead warrants it
3. Per-zone API deployment if needed for call-path features
4. Load testing: SIPp at 500 CPS per zone (1500 CPS total platform)
5. Right-size VMs based on observed utilization
6. Committed use discounts (1-year CUDs on stable fleet)

### Phase 6: VxRail Decommission (Month 3-24)

1. Identify remaining VxRail dependencies (if any)
2. Verify GCP 3-region HA covers all DR scenarios
3. Migrate DNS records
4. Remove VxRail carrier whitelists
5. Decommission VxRail after 3-month burn-in

---

## East Zone — Current Deployed State

### IP Assignment

| VM | Internal IP | External IP | SBC_ID | HEP_CAPTURE_ID |
|---|---|---|---|---|
| poc-custom-voip | 10.142.0.100 | 34.74.71.32 | east-sbc-1 | 100 |
| kam-g2 | 10.142.0.101 | 35.243.136.35 | east-sbc-2 | 101 |
| fs-media-v2 | 192.168.10.2 (voip-media subnet) | 34.139.119.135 | — | — |
| services | 10.142.0.103 | 34.26.57.37 | — | — |
| **VIP (Regional NLB)** | — | **34.24.133.82** | — | — |
| **VIP (Geo LB)** | — | **TBD** | — | — |

**Note:** Regional NLB (34.24.133.82) is interim. Will be replaced by Geo LB VIP
in Phase 2. At cutover, all SBC EXTERNAL_SIP_IP values switch to the Geo LB VIP.

### Current NLB Components (to be replaced by Geo LB)

```
Health Check:    sbc-health-check (TCP 5060, 5s interval, regional us-east1)
Backend Service: sbc-backend (UNSPECIFIED, CLIENT_IP affinity)
Instance Group:  sbc-group (poc-custom-voip + kam-g2)
Forwarding Rule: sbc-vip-udp (34.24.133.82, UDP:5060)
Forwarding Rule: sbc-vip-tcp (34.24.133.82, TCP:5060)
```

### Verification Checklist

```bash
# SBCs — dispatcher health
sudo docker logs voip-kamailio --tail 5  # Should show OPTIONS 200 OK

# SBCs — VIP and SBC_ID templating
sudo docker exec voip-kamailio grep "ADVERTISE_IP\|hep_capture_id\|X-SBC-ID" /etc/kamailio/kamailio.cfg | head -3

# SBCs — verify SBC identity in startup log
sudo docker logs voip-kamailio 2>&1 | grep "config templated"
# Should show: SBC_ID=east-sbc-1 (or east-sbc-2), HEP_ID=100 (or 101)

# FS — sofia profiles
sudo docker exec voip-freeswitch sh -c '/usr/local/freeswitch/bin/fs_cli -p $ESL_PASSWORD -x "sofia status"'

# Services — API health
curl -s http://localhost:8088/health

# NLB — backend health (regional, until Geo LB cutover)
gcloud compute backend-services get-health sbc-backend --region=us-east1

# Geo LB — backend health (after Phase 2 cutover)
# gcloud compute backend-services get-health sbc-backend-global --global
```

### Rollback

```bash
cd /opt/revup
sudo git checkout Full-System
sudo docker compose down
sudo docker compose build
sudo docker compose up -d
# Update Bandwidth termination host back to 34.74.71.32
```
