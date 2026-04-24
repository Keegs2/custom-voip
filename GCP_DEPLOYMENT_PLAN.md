# GCP Multi-Zone Production Deployment Plan — RCF-V1

## Strategic Context

VxRail on-prem environment decommissioning within 2 years (announced April 2026).
All 3 planned locations will be deployed in GCP instead of on-prem. Each zone is
a self-contained call processing unit — calls that enter a zone stay in that zone
for both SIP signaling and RTP media. No cross-zone RTP traffic ever occurs.

---

## Architecture Overview

```
                          BANDWIDTH CARRIER
                   (Account 9900717, Peer 1162116)
                   Termination Hosts (priority order):
                   1. 34.24.133.82   (East VIP)
                   2. <west-vip>     (West VIP)
                   3. <central-vip>  (Central VIP)
                              │
         ┌────────────────────┼────────────────────┐
         │                    │                    │
    US-EAST1             US-WEST1            US-CENTRAL1
    South Carolina       Oregon              Iowa
    (DEPLOYED)           (Phase 2)           (Phase 3)
         │                    │                    │
   ┌─────┴──────┐      ┌─────┴──────┐      ┌─────┴──────┐
   │ NLB (VIP)  │      │ NLB (VIP)  │      │ NLB (VIP)  │
   │34.24.133.82│      │ <west-vip> │      │<central-vip>│
   └──┬──────┬──┘      └──┬──────┬──┘      └──┬──────┬──┘
      │      │            │      │            │      │
   ┌──┴──┐┌──┴──┐     ┌──┴──┐┌──┴──┐     ┌──┴──┐┌──┴──┐
   │SBC-1││SBC-2│     │SBC-1││SBC-2│     │SBC-1││SBC-2│
   │ KAM ││ KAM │     │ KAM ││ KAM │     │ KAM ││ KAM │
   └──┬──┘└──┬──┘     └──┬──┘└──┬──┘     └──┬──┘└──┬──┘
      └───┬──┘           └───┬──┘           └───┬──┘
          │                  │                  │
      ┌───┴───┐          ┌───┴───┐          ┌───┴───┐
      │  FS   │          │  FS   │          │  FS   │
      │+Redis │          │+Redis │          │+Redis │
      └───┬───┘          └───┬───┘          └───┬───┘
          │                  │                  │
          │     VPC Internal Routing            │
          └──────────┬───────┴──────────────────┘
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

---

## Region Selection

| Zone | GCP Region | GCP Zone | Bandwidth Proximity | Role |
|------|-----------|----------|---------------------|------|
| **East** | us-east1 (South Carolina) | us-east1-b | Dallas PoP ~20ms, Atlanta ~10ms | Primary (DEPLOYED) |
| **West** | us-west1 (Oregon) | us-west1-b | LA PoP (216.82.238.134) ~15ms | Secondary |
| **Central** | us-central1 (Iowa) | us-central1-b | Equidistant both PoPs ~25ms | Tertiary / DR |

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
  Subnet: us-east1     10.142.0.0/20   (existing)
  Subnet: us-west1     10.138.0.0/20   (new)
  Subnet: us-central1  10.128.0.0/20   (new)
```

### Per-Zone IP Allocation

| Role | East (deployed) | West | Central |
|------|----------------|------|---------|
| SBC-1 | 10.142.0.100 | 10.138.0.100 | 10.128.0.100 |
| SBC-2 | 10.142.0.101 | 10.138.0.101 | 10.128.0.101 |
| FreeSWITCH | 10.142.0.102 | 10.138.0.102 | 10.128.0.102 |
| PG Replica | 10.142.0.103 (primary) | 10.138.0.103 | 10.128.0.103 |

### Per-Zone NLB

Each zone has its own External Passthrough Network Load Balancer:

| Zone | VIP | Backend Group | Health Check |
|------|-----|---------------|-------------|
| East | 34.24.133.82 (deployed) | sbc-group-east | TCP 5060, 5s, 3 threshold |
| West | TBD (reserve in Phase 2) | sbc-group-west | TCP 5060, 5s, 3 threshold |
| Central | TBD (reserve in Phase 3) | sbc-group-central | TCP 5060, 5s, 3 threshold |

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
| Kamailio SBC | e2-standard-4 | 2 | Host networking, static external IP |
| FreeSWITCH + Redis | e2-standard-8 | 1 | Host networking, static external IP |

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

### Single SIP Peer, Multiple Termination Hosts

All DIDs stay on SIP peer 1162116. Bandwidth routes inbound calls by priority:

```
SIP Peer: 1162116 (GraniteTelecommunicationsLLC_O3)
  Termination Hosts:
    Priority 1: 34.24.133.82   (East VIP)
    Priority 2: <west-vip>      (West VIP)
    Priority 3: <central-vip>   (Central VIP)

  Origination Hosts (outbound):
    34.24.133.82    (East VIP)
    <west-vip>       (West VIP)
    <central-vip>    (Central VIP)
    + all 6 SBC public IPs
```

### Bandwidth Failover Behavior

- 503 from NLB → immediate retry to next priority host
- Timeout (32s) → retry to next priority host
- 480/486 → NOT a failover trigger (valid busy response)

### Per-Zone Carrier PoP Selection

Each zone's Kamailio prefers the nearest Bandwidth signaling proxy:

| Zone | X-Carrier=standard (primary) | X-Carrier=premium (secondary) |
|------|------------------------------|-------------------------------|
| East | 67.231.2.12 (Dallas) | 216.82.238.134 (LA) |
| West | 216.82.238.134 (LA) | 67.231.2.12 (Dallas) |
| Central | 67.231.2.12 (Dallas) | 216.82.238.134 (LA) |

Requires 2 new env vars per zone: `BANDWIDTH_PRIMARY_IP`, `BANDWIDTH_SECONDARY_IP`.

---

## Per-Zone Environment Variables

### SBC .env (per zone)

```bash
EXTERNAL_SIP_IP=<zone_vip>              # Zone's NLB VIP
FREESWITCH_IP=<zone_fs_internal_ip>     # Zone's local FS
DB_HOST=<zone_pg_ip>                    # Local PG (primary or replica)
DB_PORT=6432
DB_USER=freeswitch
DB_PASS=<STRONG_FS_DB_PASSWORD>
HOMER_IP=10.142.0.103                   # Centralized Homer in East
BANDWIDTH_PRIMARY_IP=<nearest_bw_pop>   # NEW: nearest Bandwidth PoP
BANDWIDTH_SECONDARY_IP=<far_bw_pop>     # NEW: far Bandwidth PoP
```

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
SBC_PROXY_IP=<zone_sbc1_internal_ip>    # Zone's primary SBC
ESL_PASSWORD=<STRONG_ESL_PASSWORD>
TEST_MODE=false
```

---

## Config Changes Required

| Component | Changes Needed |
|-----------|---------------|
| **FreeSWITCH** | **Zero.** All values come from env vars already. |
| **Kamailio** | **Minimal.** Add `BANDWIDTH_PRIMARY_IP` / `BANDWIDTH_SECONDARY_IP` env vars to entrypoint.sh templating. Replace hardcoded Bandwidth IPs in TO_CARRIER route. |
| **Lua scripts** | **Zero.** DB_HOST, Redis, API all from env vars. |
| **FastAPI** | **Phase 2.** Add zone-aware ESL routing for multi-zone call origination. |
| **Docker images** | **Identical across zones.** Only .env files differ. |

---

## Failover Scenarios

### Single SBC failure (e.g., East SBC-1 dies)

- NLB detects in 15s, routes to SBC-2
- ~50% active calls on SBC-1 are lost
- New calls unaffected after 15s

### FreeSWITCH failure (zone FS dies)

- Kamailio dispatcher detects in 15s, returns 503 to Bandwidth
- ALL active calls in zone are lost
- Bandwidth fails over to next priority VIP (immediate on 503)
- New calls route to next zone within seconds

### Entire zone failure

- Bandwidth timeout to zone VIP (~32s) or 503 (immediate)
- ALL active calls in zone are lost
- New calls route to next priority zone
- Automatic, no manual intervention

### PostgreSQL primary failure

- Active calls: unaffected
- New calls: work for cached DIDs (5-min TTL)
- Provisioning: stops until manual replica promotion
- Recovery: 15-30 min manual, or ~30s with Patroni (Phase 2)

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
| Network LBs (3 zones) | 3 | $120 |
| Cross-region egress | | $100 |
| **Total** | **13 VMs** | **~$1,843/month** |
| **With 1-year CUDs** | | **~$1,400/month** |

Current 4-VM (East only) cost: ~$450/month.

---

## Implementation Phases

### Phase 1: East Zone — COMPLETE ✓

- 4 VMs deployed in us-east1-b
- NLB operational (34.24.133.82)
- Bandwidth configured with VIP
- PostgreSQL bare + PgBouncer running
- API, UI, Homer operational

### Phase 2: West Zone (Weeks 1-3)

1. Deploy PG streaming replica in us-west1-b with PgBouncer
2. Reserve static IPs for 2 SBCs + 1 FS in us-west1-b
3. Reserve static IP for West NLB VIP
4. Deploy VMs from instance templates (same Docker images, zone-specific .env)
5. Create NLB (sbc-group-west, sbc-backend-west, forwarding rules)
6. Request Bandwidth IP whitelisting for West VIP + SBC IPs (1-5 business day lead time)
7. Add West VIP as Priority 2 termination host in Bandwidth
8. Add `BANDWIDTH_PRIMARY_IP` / `BANDWIDTH_SECONDARY_IP` env vars to Kamailio entrypoint
9. Test: inbound calls via West, outbound calls from West, failover East→West
10. SIPp load test at target CPS

### Phase 3: Central Zone (Weeks 3-5)

Repeat Phase 2 for us-central1-b:
1. PG replica + PgBouncer
2. 3 VMs (2 SBCs + 1 FS)
3. NLB + VIP
4. Bandwidth whitelisting + Priority 3 termination host
5. Full 3-zone failover testing: kill each zone, verify calls route to remaining zones

### Phase 4: Hardening (Weeks 5-8)

1. Per-zone Internal LB for FS→SBC outbound failover
2. Zone-aware ESL routing in FastAPI
3. Per-zone Homer capture_id templating (East=100, West=110, Central=120)
4. Cloud Monitoring agents + alerting (NLB health, FS status, PG replication lag)
5. Database backup verification (test restore from replica)
6. Runbook: all failover procedures documented
7. Security: Secret Manager for credentials, IAM review

### Phase 5: Optimization (Weeks 9-12)

1. Evaluate Patroni for automatic PG failover
2. Consider Cloud SQL migration if DBA overhead warrants it
3. Per-zone API deployment if needed for call-path features
4. Load testing: SIPp at 500 CPS per zone
5. Right-size VMs based on observed utilization
6. Committed use discounts

### Phase 6: VxRail Decommission (Month 3-24)

1. Identify remaining VxRail dependencies (if any)
2. Verify GCP 3-zone HA covers all DR scenarios
3. Migrate DNS records
4. Remove VxRail carrier whitelists
5. Decommission VxRail after 3-month burn-in

---

## East Zone — Current Deployed State

### IP Assignment

| VM | Internal IP | External IP | Role |
|---|---|---|---|
| poc-custom-voip | 10.142.0.100 | 34.74.71.32 | SBC-1 (Kamailio) |
| kam-g2 | 10.142.0.101 | 35.243.136.35 | SBC-2 (Kamailio) |
| fs-media | 10.142.0.102 | 34.139.119.135 | FreeSWITCH + Redis |
| services | 10.142.0.103 | 34.26.57.37 | PG Primary + API + UI + Homer |
| **VIP (NLB)** | — | **34.24.133.82** | SBC floating IP |

### NLB Components

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

# SBCs — VIP templating
sudo docker exec voip-kamailio grep "ADVERTISE_IP" /etc/kamailio/kamailio.cfg | head -1
# Should show: 34.24.133.82

# FS — sofia profiles
sudo docker exec voip-freeswitch sh -c '/usr/local/freeswitch/bin/fs_cli -p $ESL_PASSWORD -x "sofia status"'

# Services — API health
curl -s http://localhost:8088/health

# NLB — backend health
gcloud compute backend-services get-health sbc-backend --region=us-east1
```

### Rollback

```bash
cd /opt/revup
sudo git checkout Full-System
sudo docker compose down
sudo docker compose build
sudo docker compose up -d
# Update Bandwidth back to 34.74.71.32
```
