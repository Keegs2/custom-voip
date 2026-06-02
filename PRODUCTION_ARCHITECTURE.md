# Production Architecture: RCF (Remote Call Forwarding) v1

> **Scope of this document.** This is the *design* reference — why the system is
> built the way it is: sizing, HA reasoning, security model, capacity planning.
> For the step-by-step *deployment* procedure (zone bring-up, Geo LB, Bandwidth
> config, `.env` values), see `GCP_DEPLOYMENT_PLAN.md`. For the load-bearing
> production debugging lessons, see the "Multi-VM SIP Architecture — Hard-Won
> Lessons" and "Critical Gotchas" sections of the root `CLAUDE.md`, which remain
> the canonical source of truth. This document references those lessons rather
> than restating them in full.

## Table of Contents

1. Overview and Deployment Target
2. Network Architecture (GCP Multi-Zone)
3. Component Specifications Per Zone
4. Kamailio SBC Design
5. FreeSWITCH Production Design
6. Database Architecture
7. Redis Architecture
8. DNS and Carrier Integration
9. Container Strategy
10. Security Hardening
11. Monitoring and Observability
12. HA Failure Scenarios
13. Capacity Planning
14. Roadmap / Future Phases

---

## 1. Overview and Deployment Target

RCF is the simplest product on the platform: an inbound DID receives a call from
the PSTN and forwards it to a configured destination number. No WebRTC, no UCaaS,
no browser clients. The entire call flow is SIP/RTP between carriers via Kamailio
and FreeSWITCH.

**Deployment target: all-GCP, multi-zone.** The VxRail on-prem environment is being
decommissioned (announced April 2026, ~2-year horizon). All three planned locations
are deployed in **GCP**, not on-prem. An earlier revision of this document described
an on-prem Chicago/Dallas VxRail design with a site-to-site VPN and Patroni/etcd —
that plan was abandoned in favor of GCP zones, and this document has been rewritten
to match what we actually run.

**Three GCP regions** (each a self-contained call-processing unit):

| Zone | GCP Region | Zone | Bandwidth Proximity | Status |
|------|-----------|------|---------------------|--------|
| **East** | us-east1 (South Carolina) | us-east1-b | Dallas ~20ms, Atlanta ~10ms | **DEPLOYED** |
| **West** | us-west1 (Oregon) | us-west1-b | LA (216.82.238.134) ~15ms | Phase 2 |
| **Central** | us-central1 (Iowa) | us-central1-b | Equidistant both PoPs ~25ms | Phase 3 |

**Per-zone self-containment is a hard rule.** Calls that enter a zone stay in that
zone for both SIP signaling and RTP media. No cross-zone RTP ever occurs. The only
cross-zone traffic is PostgreSQL replication and HEP capture (both UDP/streaming,
fire-and-forget). This is documented in the root `CLAUDE.md` under "Per-Zone
Self-Containment" and is the foundational scaling principle.

### RCF Call Flow

**Inbound call (PSTN to RCF destination):**
```
Bandwidth -> Geo LB anycast VIP -> nearest healthy region's SBC (Kamailio)
  -> FreeSWITCH (:5080 internal profile) -> Lua inbound_router.lua
  -> Redis DID cache (miss -> local PG) -> get forward_to number
  -> FS bridges B-leg out (:5090 external profile) -> SBC (direct IP) -> Bandwidth
  -> PSTN destination
```

The detailed 8-stage flow (X-Carrier header selection, double Record-Route, SDP
rewrite to the FS public IP) is in the root `CLAUDE.md` "Call Flow (RCF)" section.

---

## 2. Network Architecture (GCP Multi-Zone)

```
                 BANDWIDTH CARRIER (Origination)
                Account 9900717, SIP Peer 1162116
                 Dallas PoP          LA PoP
              67.231.2.12       216.82.238.134
                     \               /
                      \             /
               ┌─────────────────────────────┐
               │  GCP Global External         │
               │  Passthrough NLB (Premium)   │
               │  Single anycast VIP          │   (Phase 2 — replaces
               │  UDP + TCP :5060             │    East regional NLB
               │  CLIENT_IP affinity          │    34.24.133.82)
               └────┬───────────┬──────────┬──┘
                    │           │          │
            GRANITE EAST   GRANITE CENTRAL  GRANITE WEST
            us-east1-b     us-central1-b    us-west1-b
            (DEPLOYED)     (Phase 3)        (Phase 2)
                │              │                │
         ┌──────┴─────┐  ┌─────┴──────┐  ┌──────┴─────┐
         │ SBC-1 SBC-2│  │ SBC-1 SBC-2│  │ SBC-1 SBC-2│  Kamailio (host net)
         │  (Kamailio)│  │  (Kamailio)│  │  (Kamailio)│  default subnet
         └──────┬─────┘  └─────┬──────┘  └──────┬─────┘
                │              │                │
          ┌─────┴─────┐  ┌─────┴─────┐    ┌─────┴─────┐
          │ FreeSWITCH│  │ FreeSWITCH│    │ FreeSWITCH│  FS + Redis (host net)
          │  + Redis  │  │  + Redis  │    │  + Redis  │  voip-media subnet
          └─────┬─────┘  └─────┬─────┘    └─────┬─────┘  (Cloud-NAT-excluded)
                │              │                │
                │   Outbound termination via    │
                │   nearest Bandwidth PoP        │
                └──────────────┬────────────────┘
                               │  VPC-internal routing (global VPC)
                   ┌───────────┴───────────┐
                   │  SERVICES VM (East)    │
                   │  PG Primary + PgBouncer│
                   │  FastAPI + React UI    │
                   │  Homer (HEP capture)   │
                   └───────────┬───────────┘
                               │ streaming replication (PLANNED)
                   ┌───────────┴───────────┐
                   │ PG Replica  PG Replica │
                   │ us-west1-b  us-central │  (Phase 2/3 — not yet built)
                   └───────────────────────┘
```

### 2.1 Single Global VPC

GCP VPCs are global — subnets in different regions route to each other automatically
with no VPC peering. The `default` VPC carries all zones:

```
VPC: default
  Subnet: us-east1     10.142.0.0/20    (existing)
  Subnet: us-west1     10.138.0.0/20    (Phase 2 — new)
  Subnet: us-central1  10.128.0.0/20    (Phase 3 — new)
  Subnet: voip-media   192.168.10.0/24  (East FS — Cloud-NAT-excluded)
```

### 2.2 Cloud NAT Exclusion is Mandatory for Media VMs

**This is the single most important networking lesson** (root `CLAUDE.md`, "GCP Cloud
NAT Breaks VoIP"). GCP Cloud NAT on the `default` subnet overrides a VM's 1:1
external IP with a NAT-pool IP. Bandwidth then drops all RTP/SIP because the source
IP no longer matches the SDP-negotiated address.

- The East FreeSWITCH (`fs-media-v2`) lives on a **dedicated `voip-media` subnet
  (192.168.10.0/24)** that is **not** in the Cloud NAT router's subnet list. Its
  internal IP is **192.168.10.2** — not a `10.142.x` address.
- SBC VMs use the **`bypass-vpn`** network tag to route directly to the internet
  rather than through the VPN tunnel.
- **Rule for every new zone:** the FreeSWITCH VM MUST either be on a Cloud-NAT-excluded
  subnet (e.g. a per-region `voip-media-{region}` subnet) or carry the `bypass-vpn`
  tag. No exceptions. West and Central FS VMs require this same treatment.

### 2.3 Geo Load Balancer (Inbound Distribution)

A single **Global External Passthrough Network Load Balancer** (Premium Tier) with one
anycast VIP fronts all regions. Bandwidth sends every inbound packet to one IP; GCP's
edge network steers each packet to the nearest healthy region. There are no per-region
VIPs and no Bandwidth-side priority failover.

| Property | Value |
|----------|-------|
| VIP | Single global anycast IP (Phase 2 — reserve global static IP) |
| Protocol | UDP + TCP (dual forwarding rules, port 5060) |
| Backend | Global backend service, one instance group per region (2 SBCs each) |
| Session affinity | `CLIENT_IP` (in-dialog SIP — BYE, re-INVITE — returns to the same SBC) |
| Health check | TCP 5060, 5s interval, 3-failure threshold |

**Current state (East-only):** a **Regional** External Passthrough NLB with VIP
**34.24.133.82** (`sbc-vip-udp` + `sbc-vip-tcp` forwarding rules, `sbc-group`
instance group). This is the interim front end until the Geo LB is provisioned with
backends in 2+ regions. See `GCP_DEPLOYMENT_PLAN.md` Phase 2 for the cutover.

### 2.4 NLB Pass-Through is Inbound-Only

The GCE NLB is pass-through, not a proxy, so it has **asymmetric routing** for
intra-VPC traffic (root `CLAUDE.md`, "NLB Pass-Through Has Asymmetric Routing").
FreeSWITCH must **not** send outbound B-leg SIP to the NLB VIP — the reply would
come from a random SBC's own IP and FS would reject it. Instead, FS bridges to
**direct SBC IPs** via `SBC_PROXY_IP` (primary) and `SBC_PROXY_IP_FAILOVER`
(secondary). The NLB is for Bandwidth → SBC inbound only.

### 2.5 Firewall Rules (VPC-wide)

| Rule | Source | Ports | Target Tags |
|------|--------|-------|-------------|
| voip-sip-inbound | 67.231.0.0/16, 216.82.224.0/19 | udp/tcp:5060 | voip-sbc |
| voip-health-check | 35.191.0.0/16, 130.211.0.0/22 | tcp:5060 | voip-sbc |
| voip-rtp | 0.0.0.0/0 | udp:16384-49151 | voip-media |
| voip-web-admin | Office CIDR | tcp:8080,8443,8088 | voip-services |
| voip-internal | All zone subnets | tcp/udp/icmp | all voip tags |
| voip-pg-replication | Zone subnet CIDRs | tcp:5432 | voip-db |
| allow-ssh-iap | 35.235.240.0/20 | tcp:22 | all voip tags |

---

## 3. Component Specifications Per Zone

### Target: scale to ~500 CPS / several thousand concurrent RCF calls per zone

Each zone is identical: 3 VMs running the same Docker images with zone-specific
`.env` files. Shared services (DB primary, API, UI, Homer) are centralized in East.

| Role | VM | Machine Type | Count/Zone | Networking |
|------|-----|-------------|------------|------------|
| Kamailio SBC | `{region}-sbc-{1,2}` | e2-standard-4 | 2 | Host net, static external IP, default subnet |
| FreeSWITCH + Redis | `{region}-fs` | e2-standard-8 | 1 | Host net, static external IP, **voip-media subnet** |

### Shared Services (East only)

| Role | VM | Machine Type | Location |
|------|-----|-------------|----------|
| PG Primary + PgBouncer + API + UI + Homer | `services` | e2-standard-4 | us-east1-b |
| PG Replica + PgBouncer (Phase 2/3) | `{region}-db` | e2-standard-4 | us-west1-b, us-central1-b |

### 3.1 FreeSWITCH Sizing Rationale (RCF-specific)

RCF is dramatically lighter than a mixed WebRTC/transcoding workload. **RCF uses
FreeSWITCH's default media mode** — FS anchors and relays RTP but performs no
transcoding (both legs are G.711). Note: this is *default media relay*, **not**
`proxy_media`. `proxy_media` was removed from the RCF path after the Cloud NAT fix
resolved the underlying audio issue (root `CLAUDE.md`, "FreeSWITCH Media Handling";
`proxy_media=true` is used only on the trunk inbound path, not RCF).

- **CPU:** Each G.711 call in default-media relay is light (no codec work). An
  e2-standard-8 comfortably handles thousands of concurrent legs. No Opus/G.729
  transcoding ever occurs for RCF.
- **RAM:** ~2–3 MB per active channel (session object, SDP, Lua state). 16 GB covers
  the realistic initial load (thousands of concurrent) with headroom; upgrade when
  approaching ~8K concurrent.
- **RTP ports:** 16384–49151 (32,768 ports) supports high concurrency with RTP+RTCP
  per call.
- **Network:** G.711 ≈ 87.2 kbps/call. Several thousand concurrent calls fit well
  within the VM's network allocation.

### 3.2 Kamailio SBC Sizing Rationale

Independent of call type:
- **CPU:** e2-standard-4 provides ample headroom at the target CPS.
- **RAM:** covers htable caches (`bw_dedup`, pike state), dialog state, and buffers.
- **Production tuning:** `children=32`, `tcp_children=16` per SBC (see §10).

### 3.3 Intra-Zone Latency Requirements

| Path | Requirement |
|------|-------------|
| SBC → FS (intra-zone) | < 1 ms |
| FS → Redis (intra-zone, 127.0.0.1) | < 1 ms |
| FS → PgBouncer (local replica) | < 2 ms |
| PgBouncer → PG Primary (cross-region write) | < 50 ms (West→East) |
| SBC → Bandwidth | < 50 ms |

---

## 4. Kamailio SBC Design

### 4.1 Active/Active Pair Per Zone

Both SBCs in a zone receive traffic simultaneously via the Geo LB. They do **not**
share SIP dialog state — each independently proxies its own calls, and the dialog is
pinned to a specific SBC via the inner Record-Route (see §4.3). `CLIENT_IP` affinity
on the Geo LB keeps in-dialog requests on the same SBC. If one SBC dies mid-call,
those calls are lost (SIP cannot migrate calls) — acceptable, standard carrier SBC
behavior.

Shared data both SBCs need:
- `trunk_auth` IP authentication via local PgBouncer (queried from PostgreSQL).
- Identical `dispatcher.list` and `kamailio.cfg` — deployed from git, templated
  per-SBC by `entrypoint.sh`.

### 4.2 Per-SBC Config Templating

`kamailio.cfg` is a template; `entrypoint.sh` substitutes `__PLACEHOLDER__` tokens
from env vars at container start (Kamailio's `#!substdef`/`modparam` do not read env
vars directly). Per-SBC values:

| Env var | Purpose |
|---------|---------|
| `EXTERNAL_SIP_IP` | Advertised IP — the Geo LB VIP (carrier-facing Via/Contact/RR outer) |
| `SBC_INTERNAL_IP` | This SBC's own VPC IP — FS-facing listen socket + inner Record-Route + `alias=` |
| `FS_PUBLIC_IP` | The zone FreeSWITCH's public IP — SDP rewrite target (RTP bypasses the NLB) |
| `FREESWITCH_IP` | The zone FS internal IP — dispatcher target |
| `SBC_ID` | e.g. `east-sbc-1` — stamped as `X-SBC-ID` toward FS, stripped before egress |
| `HEP_CAPTURE_ID` | Unique per-SBC Homer capture ID (East 100/101, West 110/111, Central 120/121) |
| `HOMER_IP`, `DB_HOST`, `DB_*` | Centralized Homer + local PG |

### 4.3 Double Record-Route (Required for Multi-VM)

`enable_double_rr=1`. When Kamailio sends an outbound INVITE to Bandwidth, it inserts
**two** Record-Route headers so in-dialog requests (ACK/BYE) reach the *specific* SBC
that holds dialog state, instead of being load-balanced to a random SBC by the NLB:

```
Record-Route: <sip:EXTERNAL_SIP_IP:5060;lr>     ← outer: what Bandwidth sees (VIP)
Record-Route: <sip:SBC_INTERNAL_IP:5060;lr>     ← inner: routes back to THIS SBC
```

Implementation notes (all in root `CLAUDE.md` "Double Record-Route Required" and
the Kamailio component `CLAUDE.md`):
- TO_CARRIER uses `record_route_preset("EXTERNAL_SIP_IP:5060;lr", "SBC_INTERNAL_IP:5060;lr")`.
- The A-leg uses the **reversed** order because the UAC reverses the RR set.
- `alias=SBC_INTERNAL_IP:5060` is required so `loose_route()` recognizes the inner
  RR address as local — without it, ACKs loop infinitely.
- `record_route()` must come **after** `msg_apply_changes()` in TO_CARRIER, and
  Contact must be added **before** it, or header cleanup is silently dropped.

### 4.4 Dispatcher Configuration

`dispatcher.list` has **5 groups**:

| Group | Members | Purpose |
|-------|---------|---------|
| 1 | local FreeSWITCH (`FREESWITCH_IP:5080`) | inbound delivery to media server |
| 2 | 67.231.2.12 (Bandwidth Dallas) | carrier egress (TC4 primary) |
| 3 | 216.82.238.134 (Bandwidth LA) | carrier egress (TC4 secondary) |
| 4 | 67.231.9.142 (NY), 67.231.13.185 (ATL) | carrier egress TC1 |
| 5 | 67.231.1.188 (DAL), 67.231.4.138 (LA) | carrier egress TC2 |

Dispatcher sends OPTIONS probes to the Bandwidth groups every 5s to keep GCE UDP NAT
pinholes open (root `CLAUDE.md`, "GCE UDP Idle Timeout").

### 4.5 Carrier Routing and Failover

Outbound carrier selection is driven by the `X-Carrier` header set by FreeSWITCH.
TO_CARRIER switches on `primary` / `secondary` / `tc1` / `tc2` / `tc4`. Every zone's
FS pins `X-Carrier=primary`, which resolves to that zone's `BANDWIDTH_IP_1`.

> **Per-zone carrier IPs are env-driven.** `BANDWIDTH_IP_1`/`BANDWIDTH_IP_2` are
> templated from `BANDWIDTH_PRIMARY_IP` / `BANDWIDTH_SECONDARY_IP` (East defaults =
> Dallas/LA; West sets primary=LA, secondary=Dallas), so `X-Carrier=primary`
> automatically egresses to each zone's nearest PoP with no Lua change. This is safe
> because every **inbound** Bandwidth trust/attribution check ORs both IPs together
> (set-membership → swap-invariant; both PoPs always recognized, both attributed
> `X-Inbound-TC: tc4`), and the failover swap between the two defines stays internally
> consistent. The TC1/TC2 IPs (toll-free future) remain fixed defines. Validated with
> `kamailio -c` on both East (byte-identical to pre-change) and West configs.

`CARRIER_FAILURE` is two-tier: per-trunk in-trunk failover (flag 8, e.g. Dallas↔LA
within TC4) plus a cross-trunk fallback to TC4 Dallas (flag 9) to prevent infinite
loops. 5xx/408/480/404 from a primary carrier IP triggers failover to the alternate.

### 4.6 Trusted-Network Hardcodes (Per-Zone)

`kamailio.cfg` trusts internal sources by CIDR. `DOCKER_NETWORK 172.28.0.0/16` and
`LOCALHOST_NETWORK 127.0.0.0/8` are fixed defines; the two zone-specific CIDRs —
`GCE_INTERNAL_NETWORK` (this zone's VPC subnet) and `VOIP_SUBNET` (this zone's FS media
subnet) — are now **env-driven**, templated from `INTERNAL_SUBNET` / `MEDIA_SUBNET`
(East defaults `10.142.0.0/20` and `192.168.10.0/24`).

> **Per-zone trust.** A new zone sets `INTERNAL_SUBNET` (West `10.138.0.0/20`, Central
> `10.128.0.0/20`) and `MEDIA_SUBNET` (its own Cloud-NAT-excluded media CIDR) in its
> `.env`. Each zone trusts only its own internal + media subnet — correct under per-zone
> self-containment (an SBC never needs to trust another zone's hosts; cross-zone HEP and
> DB replication are outbound and don't require inbound SIP trust).

### 4.7 Carrier Behaviors, Topology Hiding, Session Timers

These are stable and documented in the root `CLAUDE.md`:
- **Bandwidth duplicate INVITEs** deduplicated via `bw_dedup` htable (key
  FromUser::ToUser, TTL 3s) → 482 Merged.
- **422 handling:** retry with Session-Expires 3600 / Min-SE 900.
- **Session-Expires normalization** to 1800 in REPLY_HANDLER, **bidirectional**
  (carrier→FS and FS→carrier), because Bandwidth sometimes sends values below the
  RFC 4028 minimum that FS silently ignores.
- **Topology hiding** is manual (`remove_hf`/`append_hf` + SDP `subst_body`); the
  `topoh` module is **disabled** (it conflicts with manual cleanup). `subst()` cannot
  fix Via corruption — leave FS's Via in place (two Vias is valid).
- **NAT detection (`force_rport`/`fix_nated_contact`) must NOT apply to FS traffic** —
  it leaks Docker IPs. NAT_DETECT is inbound-from-Bandwidth only.
- **183 SDP is passed through** (PSTN ringback flows naturally in default media mode).

### 4.8 Rate Limiting and DDoS Protection (Production Tuning)

| Parameter | Baseline | Production | Rationale |
|-----------|----------|------------|-----------|
| `PIKE_THRESHOLD` | 50 req/s | 100 req/s | More legitimate CPS at scale |
| `PIKE_TIMEOUT` | 300s | 600s | Longer block for persistent attackers |
| `SCANNER_THRESHOLD` | 5 | 3 | Faster scanner detection |
| `OPTIONS_FLOOD_THRESHOLD` | 20/s | 10/s | Lower OPTIONS-flood tolerance |
| `children` | 16 | 32 | More SIP worker processes |

Defense in depth: host firewall (GCP firewall rules already restrict 5060 to
Bandwidth + health-check ranges), `fail2ban` parsing Kamailio logs, and optional
kernel-level string/hashlimit drops for `friendly-scanner`/`sipvicious`.

---

## 5. FreeSWITCH Production Design

### 5.1 Two Sofia Profiles

- **Internal (:5080)** receives inbound from Kamailio.
- **External (:5090)** sends outbound B-legs. The external profile applies
  `ext-sip-ip`/`ext-rtp-ip` so the Via/Contact/SDP carry the FS public IP, not the
  Docker internal IP. Both profiles need `local-network-acl=loopback.auto`.

Do **not** use the `-nonat` flag (it disables `ext-*-ip` processing → Docker IPs leak
into SDP). See root `CLAUDE.md` gotchas #7–#9.

### 5.2 RCF Bridge — 4-Attempt SBC × Carrier Failover

`inbound_router.lua` does **not** do a simple primary→secondary bridge. It runs a
**4-attempt loop**, each preceded by a TCP reachability pre-check (`is_sbc_reachable`)
so a dead SBC is detected in < 1s instead of waiting out the SIP timeout:

```
1. SBC_PROXY_IP          + primary carrier
2. SBC_PROXY_IP_FAILOVER + primary carrier
3. SBC_PROXY_IP          + secondary carrier
4. SBC_PROXY_IP_FAILOVER + secondary carrier
```

`originate_timeout=10s` per attempt includes carrier Post-Dial Delay. Bridges use
`sofia/external/$dest@$SBC:5060` with the `X-Carrier` header (the old
`sofia/gateway/...` syntax is deprecated — it produced corrupted Contact headers).

### 5.3 Media, CDR, and Hairpin

- **Default media relay** for RCF (not `proxy_media`). SOA stays enabled. 183 SDP
  passthrough works without special handling.
- **CDR pipeline:** `mod_json_cdr` posts to the FastAPI `/v1/cdrs/ingest` endpoint.
  That endpoint **always returns 200** to prevent mod_json_cdr retry storms; errors
  are handled internally. All CDR INSERT params use explicit `::type` casts for
  asyncpg/PgBouncer compatibility.
- **GCE hairpin NAT:** `entrypoint.sh` adds the public IP to the loopback
  (`ip addr add ${PUBLIC_IP}/32 dev lo`) so FS can reach its own advertised address;
  requires the `NET_ADMIN` Docker capability. Wired via a compose-level entrypoint
  override (the image's Dockerfile `ENTRYPOINT` runs the FS binary directly).
- **Redis is disabled in `inbound_router.lua`** (RCF-V1): the redis-lua library has
  connection-pooling issues under mod_lua threading. RCF routes via PostgreSQL lookup
  only; velocity/fraud checks are off for RCF (still available on trunk/api paths).
- **`mod_local_stream` disabled** (missing config caused CRIT abort under xml_curl
  fallback); RCF uses `silence_stream://-1`.

### 5.4 RTP Keepalive

`rtp-keepalive-sec=15` keeps RTP pinholes open against GCE's 30s UDP idle timeout.

---

## 6. Database Architecture

### 6.1 Current State: Single Primary in East

A single PostgreSQL 16 + TimescaleDB primary runs on the East `services` VM, fronted
by PgBouncer (transaction mode, `:6432`). All zones — once expanded — connect through
PgBouncer. The API uses `statement_cache_size=0` (PgBouncer transaction mode does not
support prepared statements).

### 6.2 Multi-Zone Replication — PLANNED (not yet implemented)

> **Status:** The streaming-replication topology below is the *design* for Phase 2/3.
> There is **no replication configured in the repo today** — no replica roles, no
> `primary_conninfo`, no standby tuning. The single East primary serves all reads and
> writes. Do not assume replicas exist.

Planned model — writes centralized (DID provisioning, CDRs), reads call-path-critical
(DID lookups on every call) served from a local replica:

```
PG Primary (us-east1-b)
  ├── streaming replica → us-west1-b   (local reads for West zone)
  └── streaming replica → us-central1-b (local reads for Central zone)
```

| Zone | DB_HOST (call-path reads) | DB writes (API) |
|------|--------------------------|-----------------|
| East | primary (local) | primary (local) |
| West | local replica | primary (cross-region ~50ms) |
| Central | local replica | primary (cross-region ~20ms) |

Async replication; typical cross-region lag 100–500ms — acceptable for DID routing.
CDR writes happen after call completion, so cross-region write latency is off the call
path. Each replica runs its own PgBouncer for local zone connections.

### 6.3 TimescaleDB CDR Retention

The `cdrs` hypertable (`05_schema_cdr.sql`): 1-week chunks, compression after 1 day,
90-day retention, with an `cdr_hourly_stats` continuous aggregate for dashboards.
Ingest dedups via `WHERE NOT EXISTS` on the CDR uuid.

### 6.4 Failover (Current → Planned)

- **Today (manual):** if the primary fails, active calls are unaffected (already
  bridged); new calls work for Redis-cached DIDs (5-min TTL) and fail for uncached;
  provisioning returns 503. Recovery is a manual replica promotion + `DB_HOST` update
  (~15–30 min, once replicas exist).
- **Phase 4/5:** evaluate Patroni for automatic failover (~30s), or Cloud SQL if DBA
  overhead warrants.

### 6.5 Backup and Recovery

| Type | Frequency | Retention | Tool |
|------|-----------|-----------|------|
| Full base backup | Daily | 30 days | pgBackRest → GCS |
| WAL archiving | Continuous | 7 days | pgBackRest archive-push |
| Logical dump | Weekly | 90 days | pg_dump (schema + seed) |

---

## 7. Redis Architecture

Per-zone local Redis on each FreeSWITCH VM (`127.0.0.1:6379`, bridge network with
6379 exposed to host). No cross-zone sharing — all data is ephemeral and zone-local:

| Data | Key form | Notes |
|------|----------|-------|
| DID cache | `rcf:{did}` | 5-min TTL; miss falls through to local PG |
| Trunk config cache | `trunk_ip:{ip}` (HASH) | trunk/api paths |
| Channel counting | `trunk:{trunk_id}:calls` (SET of UUIDs) | SADD/SREM/SCARD, TTL 7200s |
| CPS limiting | `cps:{type}:{id}` (SORTED SET) | ZADD/ZCARD/ZREMRANGEBYSCORE, TTL 2s |
| Velocity | `vel:{customer_id}:cph` | fraud tracking |

Production config: `maxmemory 2gb` / `volatile-lru`, no persistence (`save ""`,
`appendonly no`), `io-threads 4`, dangerous commands renamed (KEYS/FLUSHALL/FLUSHDB/
DEBUG). If Redis dies, Lua falls through to PostgreSQL (+5–10ms/call); no calls drop.

---

## 8. DNS and Carrier Integration

### 8.1 Single Bandwidth SIP Peer, Single Termination Host

All DIDs stay on SIP Peer **1162116**. Bandwidth sends all inbound to one IP — the
Geo LB anycast VIP — and GCP handles geographic distribution and failover. No
Bandwidth-side priority failover.

```
SIP Peer 1162116 (GraniteTelecommunicationsLLC_O3)
  Termination Host: <geo-vip>   (single global anycast VIP)
  Origination Hosts (outbound source IPs Bandwidth must whitelist):
    <geo-vip> (in SIP headers) + all 6 SBC public IPs (actual packet sources)
```

Outbound INVITEs leave from each SBC's own external IP (not the VIP), so Bandwidth
must whitelist all SBC public IPs for origination. The VIP appears in From/Contact/Via
so in-dialog responses route back through the Geo LB.

### 8.2 Per-Region Carrier PoP Selection (Outbound)

| Region | primary | secondary (failover) |
|--------|---------|----------------------|
| East | 67.231.2.12 (Dallas ~20ms) | 216.82.238.134 (LA) |
| West | 216.82.238.134 (LA ~15ms) | 67.231.2.12 (Dallas) |
| Central | 67.231.2.12 (Dallas ~25ms) | 216.82.238.134 (LA) |

Implemented via the `BANDWIDTH_PRIMARY_IP` / `BANDWIDTH_SECONDARY_IP` env vars
(see §4.5) — set per zone in `.env`, no code change needed at bring-up.

### 8.3 API Endpoint

`api.revup.io` behind a load balancer or A record; health check `GET /health`. The API
can run in any zone since it reaches the central database (today it's East-only on the
`services` VM).

---

## 9. Container Strategy

### 9.1 Per-VM Compose Files

| Compose file | VM | Services |
|--------------|-----|----------|
| `docker-compose.sbc.yml` | SBC VMs | Kamailio (host net) |
| `docker-compose.media.yml` | Media VM | FreeSWITCH (host net) + Redis (bridge) |
| `docker-compose.services.yml` | Services VM | PG/PgBouncer, FastAPI, React UI, Homer stack (heplify-server, qryn, ClickHouse, Grafana) |
| `docker-compose.yml` | Local dev | all services on one machine |

Kamailio and FreeSWITCH use `network_mode: host`. API/UI/Homer use a bridge network.
The API reaches PgBouncer (on the host via systemd) through
`host.docker.internal:6432` (`extra_hosts: host-gateway`).

### 9.2 Same Image Everywhere, Per-Zone `.env`

Every zone runs identical Docker images; only the `.env` differs. This is the core of
the "FreeSWITCH config changes: zero / Kamailio: minimal" expansion model — all
zone-specific values are env-driven (with the carrier-IP exception noted in §4.5).

### 9.3 Deployment Workflow

Push to GitHub → SSH to the VM (`/opt/revup`) → `sudo git pull` → rebuild/restart with
the per-VM compose file. Never `gcloud scp`. All VM commands need `sudo` and must be
single-line (backslash continuations break on paste).

### 9.4 Image Registry and Rolling Updates

- Tag images with git SHA + semver; never `:latest` in production.
- **FreeSWITCH** cannot be updated without dropping active calls — graceful drain:
  tell the Geo LB / dispatcher to stop sending new calls to that zone, wait for active
  calls to drain, then restart. Cross-zone: drain one zone, update, reverse.
- **Kamailio:** rolling — update SBC-1 while SBC-2 serves, then swap.

---

## 10. Security Hardening

### 10.1 TLS Surface (Minimal for RCF)

| Connection | Requirement |
|------------|-------------|
| SIP to/from Bandwidth | UDP :5060 plain (Bandwidth does not support TLS) |
| API | HTTPS behind reverse proxy (Let's Encrypt) |
| DB | TLS (`sslmode=verify-full`) |
| Redis | DC-internal only (no TLS on private net) |
| ESL | Bind 127.0.0.1 only; password must match between FS and API |

No SIP TLS, SRTP, or WSS for RCF — pure carrier-to-carrier RTP.

### 10.2 Secrets

`.env` files live on each VM (`/opt/revup/.env`), **never in git**. Rotate all
defaults (PostgreSQL, ESL password, Redis). `JWT_SECRET_KEY` is required or the API
won't start. Phase 4: migrate to GCP Secret Manager.

### 10.3 Audit Logging

- API audit log for all provisioning changes (RCF/customer/DID CRUD) with
  timestamp/user/before-after.
- SSH via IAP only (`35.235.240.0/20`); session logging with `auditd`.
- `pgaudit` for DDL/privileged operations.

---

## 11. Monitoring and Observability

### 11.1 Deployed Today: Homer SIP Capture

Homer **is deployed** (centralized on the East `services` VM) — contrary to earlier
plans that deferred it. The stack is heplify-server (HEP ingest) → qryn (Loki-compatible
API) → ClickHouse (storage) → Grafana (dashboards). Each SBC and FS sends HEP with a
unique `HEP_CAPTURE_ID` (East 100/101/200, West 110/111/210, Central 120/121/220).

The **primary** SIP-debug UI is the native React **Troubleshooting page** (SIP-ladder
diagram with inline packet inspection): React → `POST /api/homer/search` → FastAPI
`homer.py`, which queries qryn (LogQL) and ClickHouse directly (:8123) for multi-Call-ID
correlation. Grafana is a secondary deep-link target.

`scripts/ip-alias.lua` maps IPs → friendly names in the ladder and currently hardcodes
**East** IPs — new zones' SBC/FS IPs must be added there.

### 11.2 Planned: Metrics + Logs

Prometheus + Grafana + Loki with exporters (kamailio, freeswitch ESL, redis, postgres,
node) and Promtail log shipping. Key dashboards: call volume (CPS, concurrent, ASR,
ACD) per zone/customer; SBC health; infrastructure; DB (latency, pool, replication
lag); provisioning. Critical alerts: FS down, both SBCs in a zone down, replication
lag > 30s, ASR < 50%, CPS > 80% capacity, disk > 85%.

### 11.3 Correlation ID

`X-CID` flows the entire call path (Bandwidth Call-ID → Kamailio X-CID → FS A-leg →
Lua → FS B-leg → Kamailio TO_CARRIER → `CDR.correlation_id`), enabling end-to-end
trace in Homer and CDRs.

---

## 12. HA Failure Scenarios

| Failure | Detection | Recovery | Behavior |
|---------|-----------|----------|----------|
| Single SBC | Geo LB health check ~15s | Auto | Other SBC in same zone takes traffic; ~50% of that SBC's in-dialog calls lost |
| FreeSWITCH (zone) | Kamailio dispatcher ~15s, both SBCs 503 | Auto | All active calls in zone lost; new calls route to next nearest healthy zone |
| Entire zone | Geo LB sees all backends unhealthy ~15s | Auto | New traffic to next nearest zone; no Bandwidth change (single VIP) |
| Carrier trunk (PoP) | Kamailio CARRIER_FAILURE 503/408 | Auto | Retry on secondary Bandwidth PoP |
| Redis | FS reconnect | Auto | DID lookups fall through to PG; degraded fraud checks |
| PgBouncer | restart | Auto | New-call DID lookups fail until reconnect; active calls fine |
| PG Primary | — | Manual (Phase 4: Patroni auto) | Cached DIDs work; uncached + provisioning fail; promote replica |

All four primary modes (single SBC, zone/FS, full-zone, carrier-trunk) are
demonstrated in the Granite Keystone HA animation on the platform homepage
(`HaArchitectureViz`).

---

## 13. Capacity Planning

- **Erlang B:** 10K concurrent at 3-min ACD ≈ 55 CPS steady state; burst 5–10× =
  275–555 CPS. Size for ~500 CPS sustained per zone.
- **RCF duty cycle:** each RCF number ≈ 0.01–0.05 concurrent calls → 200K–1M numbers
  before hitting 10K concurrent per zone.
- **Load test before each zone goes live:** SIPp at 120% of target CPS.
- **Trend monitoring:** weekly CPS/concurrent peaks; trigger capacity planning at 70%
  of rated capacity.

---

## 14. Roadmap / Future Phases

### Phase 2: Toll-Free (8XX) Multi-Carrier Expansion

~22,000 RCF/Voicemail subscribers use toll-free (8XX) numbers (LCC 6 = '8XX Orig').
These can't migrate until multi-carrier inbound toll-free with **LCO** (Least Cost
Origination) is in place — toll-free routing uses SMS/800 (TFN Registry) Customer
Records to route each inbound call to the cheapest carrier. Geographic DIDs migrate
first (Bandwidth only) — **current phase**.

Required inbound toll-free carriers (all contracted through Granite): Inteliquent
(Sinch), Lumen, Verizon, AT&T, 382/Iristel, possibly one more. RespOrg: the existing
RespOrg ID is assigned to another Granite system; a new RespOrg ID may be needed for
this platform to independently manage SMS/800 Customer Records and LCO tables.

Platform changes (design to be **table-driven** so adding a carrier is config, not
code): per-carrier trusted-IP sets, per-carrier dispatcher groups, per-carrier SIP
normalization, inbound carrier tagging (`X-Inbound-TC` already exists in code,
currently disabled), GCP firewall ranges per carrier, per-carrier HEP labeling.

### Phase 3: SIP Trunking Product
Customer PBX registration + IP auth via Kamailio, optional SIP TLS (:5061) and SRTP
per-trunk, outbound LCR in Lua, per-trunk CPS/channel limits in Redis, customer-facing
provisioning in the API. (The trunk inbound path — including `proxy_media=true` — is
already partially present in `inbound_router.lua`.)

### Phase 4: API Calling Product
REST call origination (click-to-call, dialers), webhook CDR delivery, API-key auth +
rate limiting, call recording (mod_record + object storage).

### Phase 5: Observability Enhancements
Full Prometheus/Grafana/Loki rollout, MOS/jitter/loss from RTP stats, SIPp synthetic
canary calls, RTPEngine if media anchoring/SRTP transcryption is needed.

### Phase 6: UCaaS Features (trunk/api/hybrid only — Full-System branch)
mod_verto/WebRTC, WSS, SRTP-mandatory WebRTC legs, presence/chat/voicemail/
conferencing, FreeSWITCH sizing upgrade for transcoding. **RCF customers never see
UCaaS features.**

### Phase 7: Compliance
Bandwidth E911 (Kari's Law, RAY BAUM's Act), call-recording retention, HIPAA/PCI
hardening if serving regulated customers.

---

**Key files referenced:**

- `GCP_DEPLOYMENT_PLAN.md` — zone bring-up procedure, Geo LB, Bandwidth config, per-zone `.env`
- `CLAUDE.md` (root) — hard-won SIP lessons and critical gotchas (canonical)
- `docker-compose.{sbc,media,services}.yml` — per-VM service definitions
- `docker/kamailio/kamailio.cfg` + `dispatcher.list` — SBC routing, double RR, carrier integration
- `docker/freeswitch/scripts/inbound_router.lua` — RCF routing, 4-attempt failover
- `docker/freeswitch/conf/sofia/{internal,external}.xml` — sofia profiles
- `docker/freeswitch/entrypoint.sh` — GCE hairpin loopback fix
- `docker/postgres/init/05_schema_cdr.sql` — CDR hypertable, compression, retention
- `docker/redis/redis.conf` — ephemeral cache config
- `infra/OPENTOFU_PLAN.md` — IaC plan (HCL not yet scaffolded)
