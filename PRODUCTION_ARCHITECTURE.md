# Production Architecture: RCF (Remote Call Forwarding) v1

## Table of Contents

1. Network Architecture
2. Component Specifications
3. Kamailio SBC Design
4. FreeSWITCH Production Hardening
5. Database Architecture
6. Redis Architecture
7. DNS and Carrier Integration
8. Container Strategy
9. Security Hardening
10. Monitoring and Alerting
11. Deployment Timeline
12. Future Phases

---

## 1. Network Architecture

RCF is the simplest product on the platform: an inbound DID receives a call from the PSTN and forwards it to a configured destination number. No WebRTC, no UCaaS, no browser clients. The entire call flow is SIP/RTP between carriers via Kamailio and FreeSWITCH.

```
                         ┌─────────────────────────────────────┐
                         │           DNS Layer                 │
                         │   sip.revup.io  (SRV records)      │
                         │   api.revup.io  (A record)         │
                         └────────────────┬────────────────────┘
                                          │
                         ┌────────────────┴────────────────────┐
                         │        Bandwidth Carrier            │
                         │   67.231.0.0/16 (Dallas)            │
                         │   216.82.224.0/19 (LA)              │
                         └────────────────┬────────────────────┘
                                          │
        ┌─────────────────────────────────┼──────────────────────────────────┐
        │                  SITE-TO-SITE VPN (IPsec / WireGuard)             │
        │                         10.0.0.0/8                                │
        │                                                                    │
   ═════╪════════════════════════════╗    ╔══════════════════════════════════╪═══
   CHI DC (Primary)                  ║    ║                  DAL DC (Secondary)
   ═════╪════════════════╗           ║    ║          ╔══════════════════════╪═══
        │                ║           ║    ║          ║                      │
   ┌────┴────┐ ┌────┴────┐          ║    ║    ┌─────┴───┐ ┌───────────┴┐
   │ KAM-C1  │ │ KAM-C2  │          ║    ║    │ KAM-D1  │ │  KAM-D2    │
   │ SBC     │ │ SBC     │          ║    ║    │ SBC     │ │  SBC       │
   │ :5060   │ │ :5060   │          ║    ║    │ :5060   │ │  :5060     │
   │ Active  │ │ Active  │          ║    ║    │ Active  │ │  Active    │
   └────┬────┘ └────┬────┘          ║    ║    └────┬────┘ └─────┬──────┘
        │           │               ║    ║         │            │
        └─────┬─────┘               ║    ║         └──────┬─────┘
              │                     ║    ║                │
        ┌─────┴──────┐             ║    ║          ┌─────┴──────┐
        │  FS-CHI    │             ║    ║          │  FS-DAL    │
        │ FreeSWITCH │             ║    ║          │ FreeSWITCH │
        │ :5080/5090 │             ║    ║          │ :5080/5090 │
        │ 16384-32767│             ║    ║          │ 16384-32767│
        └──┬─────┬───┘             ║    ║          └──┬─────┬───┘
           │     │                 ║    ║             │     │
     ┌─────┘     └──────┐         ║    ║       ┌─────┘     └──────┐
     │                  │         ║    ║       │                  │
┌────┴─────┐   ┌────────┴──┐     ║    ║  ┌────┴─────┐   ┌────────┴──┐
│ REDIS-C  │   │ PGBOUNCER │     ║    ║  │ REDIS-D  │   │ PGBOUNCER │
│ :6379    │   │ :6432     │     ║    ║  │ :6379    │   │ :6432     │
└──────────┘   └─────┬─────┘     ║    ║  └──────────┘   └─────┬─────┘
                     │           ║    ║                       │
                     └───────────╫────╫───────────────────────┘
                                 ║    ║
                     ┌───────────╫────╫──────────────┐
                     │ CENTRAL   ║    ║ DATABASE     │
                     │ CLUSTER   ╚════╝              │
                     │  ┌──────────────────────┐     │
                     │  │  PG-PRIMARY (CHI)    │     │
                     │  │  PostgreSQL 16 +     │     │
                     │  │  TimescaleDB + Patroni│    │
                     │  │  Writable             │     │
                     │  └──────────┬───────────┘     │
                     │             │ Streaming        │
                     │             │ Replication      │
                     │  ┌──────────┴───────────┐     │
                     │  │  PG-REPLICA (DAL)    │     │
                     │  │  Read-only Hot        │     │
                     │  │  Standby              │     │
                     │  └──────────────────────┘     │
                     └───────────────────────────────┘
                                 │
                         ┌───────┴───────┐
                         │ GCP (DR Only) │
                         │  KAM-G1 (SBC) │
                         │  FS-GCP       │
                         │  REDIS-G      │
                         │  PG-REPLICA-G │
                         └───────────────┘
```

### RCF Call Flow

**Inbound call (PSTN to RCF destination):**
```
Bandwidth -> DNS SRV -> KAM-C1 (or KAM-D1) -> FS-CHI (or FS-DAL)
  -> Lua inbound_router -> DB lookup (rcf_numbers table)
  -> Bridge to forward_to number
  -> FS-CHI -> KAM-C1 -> Bandwidth -> PSTN destination
```

**Cross-DC failover:**
```
CHI down -> Bandwidth SIP failover (408/503 triggers next hop)
  -> New calls route to DAL SBCs
  -> Patroni promotes DAL PG replica to primary
  -> All new traffic flows through DAL within ~60s
```

---

## 2. Component Specifications Per DC

### Target: 10,000 concurrent RCF calls per DC

RCF calls use `proxy_media` mode -- FreeSWITCH rewrites SDP but passes RTP packets without decoding or re-encoding. This means minimal CPU usage compared to transcoded or WebRTC calls. The sizing below reflects this.

#### Per-DC VM Layout

| Role | Hostname | vCPU | RAM | Disk | Network | Count |
|------|----------|------|-----|------|---------|-------|
| SBC | kam-{dc}1, kam-{dc}2 | 8 | 8 GB | 50 GB SSD | 2x 10Gbps NIC (SIP + mgmt) | 2 |
| Media Server | fs-{dc} | 8 | 16 GB | 100 GB SSD | 2x 10Gbps NIC (RTP + SIP) | 1 |
| Redis | redis-{dc} | 4 | 8 GB | 50 GB NVMe | 10Gbps | 1 |
| PgBouncer | pgb-{dc} | 2 | 4 GB | 20 GB | 10Gbps | 1 |
| DB Primary (CHI only) | pg-primary | 16 | 64 GB | 1 TB NVMe RAID-10 | 10Gbps | 1 |
| DB Replica (DAL only) | pg-replica | 16 | 64 GB | 1 TB NVMe RAID-10 | 10Gbps | 1 |
| FastAPI | api-{dc} | 4 | 8 GB | 50 GB SSD | 10Gbps | 1 |
| Monitoring | mon-{dc} | 4 | 8 GB | 200 GB SSD | 10Gbps | 1 |

#### FreeSWITCH Sizing Rationale (RCF-specific)

RCF is dramatically lighter than a mixed WebRTC/transcoding workload:

- **CPU:** Each G.711 call in `proxy_media` mode uses approximately 0.5% of a modern CPU core. At 10,000 concurrent calls, that is 50 cores worth of work -- but with kernel-level packet forwarding and batching, 8 cores handles this comfortably. No transcoding (Opus, G.729) ever occurs for RCF.
- **RAM:** Each active channel consumes approximately 2-3 MB (session object, SDP, Lua state). 10,000 channels = 20-30 GB. 16 GB handles the realistic initial load (thousands, not tens of thousands) with room to grow. Upgrade to 32 GB when approaching 8K concurrent.
- **RTP ports:** Expand to 16384-49151 (32,768 ports) to support 10K concurrent calls with 2 streams each (RTP + RTCP).
- **Network:** 10,000 G.711 calls at 87.2 kbps each = 872 Mbps sustained. 10Gbps NIC provides ample headroom.

**Why this is so much smaller than the original plan:** The original spec (32 vCPU / 64 GB) assumed a mixed workload with WebRTC SRTP encryption, Opus-to-G.711 transcoding, and ICE negotiation. RCF has none of that. Pure proxy_media G.711 forwarding is essentially packet shuffling.

#### Kamailio SBC Sizing Rationale

Unchanged from original -- Kamailio sizing is independent of call type:

- **CPU:** 8 cores provides 3-4x headroom at 500 CPS sustained.
- **RAM:** 8 GB covers htable caches, pike state, and connection buffers.
- **Production tuning:** `children=32`, `tcp_children=16` per SBC.

#### Network Requirements

| Path | Latency Requirement | Bandwidth |
|------|-------------------|-----------|
| SBC to FS (intra-DC) | < 1 ms | 1 Gbps |
| FS to Redis (intra-DC) | < 1 ms | 100 Mbps |
| FS to PgBouncer (intra-DC) | < 2 ms | 100 Mbps |
| PgBouncer to PG Primary (cross-DC) | < 10 ms (CHI-DAL) | 1 Gbps |
| Inter-DC VPN | < 15 ms | 1 Gbps |
| SBC to Bandwidth | < 50 ms | 100 Mbps |

#### HA Failure Scenarios

| Component Failure | Impact | Recovery |
|-------------------|--------|----------|
| 1 SBC (kam-c1) | Zero -- kam-c2 handles all traffic. Bandwidth retries on second IP. | Auto: health check removes from DNS in 15s |
| FreeSWITCH (fs-chi) | All active calls in CHI lost. New calls route to DAL. | Auto: Kamailio dispatcher detects via OPTIONS probe in 15s, cross-DC failover |
| Redis (redis-chi) | Velocity/channel counters lost. Calls continue with degraded fraud protection. | Auto: FS reconnects. Counters rebuild from call activity |
| PgBouncer (pgb-chi) | FS cannot do DB lookups. New calls fail (no DID resolution). Active calls unaffected. | Auto: restart. FS reconnects within TCP keepalive interval |
| PG Primary | All writes fail. CDRs queue locally. New provisioning fails. Active calls unaffected. | Auto: Patroni promotes DAL replica within 30s |
| CHI DC total failure | All CHI calls lost. Bandwidth retries on DAL IPs. | Auto: Bandwidth SIP failover + Patroni DB promotion. ~60s to full recovery |

---

## 3. Kamailio SBC Design

### 3.1 Active/Active Pair Architecture

Both SBCs in a DC receive traffic simultaneously. They do NOT share SIP dialog state -- each SBC independently proxies its calls. This is the standard carrier SBC pattern.

**Why no shared state is needed:**
- `dialog.so` configured with `db_mode=0` (no persistence). Correct for production.
- SIP dialogs are pinned to a specific SBC via Record-Route.
- If one SBC dies mid-call, those calls are lost. Acceptable -- SIP calls cannot be migrated.
- htable rate-limiting state is per-SBC. An attacker gets 2x rate limit by hitting both SBCs. Standard and acceptable.

**Shared data that IS needed:**
- `trunk_auth_ips` table: Both SBCs query PostgreSQL for IP authentication via local PgBouncer.
- `dispatcher.list`: Both SBCs need identical dispatcher configs. Deploy via configuration management.

### 3.2 Dispatcher Configuration for Multi-DC

**CHI dispatcher.list:**
```
# Group 1: Local FreeSWITCH (primary)
1 sip:10.10.1.50:5080 0 0 weight=100;maxload=10000;duid=fs-chi

# Group 1: Remote FreeSWITCH (cross-DC failover)
1 sip:10.20.1.50:5080 0 10 weight=50;maxload=10000;duid=fs-dal

# Groups 2-3: Bandwidth egress gateways
2 sip:67.231.2.12:5060 0 0 weight=100;duid=bw-dallas
3 sip:216.82.238.134:5060 0 0 weight=100;duid=bw-la
```

**Key production changes from POC:**
- Use `ds_select_dst("1", "8")` (priority-based) instead of `"4"` (round-robin). Local FS gets priority 0, remote FS gets priority 10.
- `ds_probing_threshold=3` and `ds_ping_interval=5` means failover detection takes 15 seconds.
- Cross-DC FS entry requires the site-to-site VPN. DAL FS must have CHI SBC IPs in its `trusted` ACL.

### 3.3 Cross-DC Failover Routing

When CHI's FS dies:

1. **Seconds 0-15:** Dispatcher probes fail. New INVITEs get 503, then `ds_next_dst()` in `failure_route[DISPATCH_FAILURE]` picks DAL FS.
2. **After 15 seconds:** Dispatcher marks `fs-chi` as inactive. All new calls go directly to `fs-dal`.
3. **Active calls:** Lost. SIP has no call migration mechanism.
4. **Recovery:** When `fs-chi` returns, 3 successful probes reactivate it. New calls resume on local FS.

**Cross-DC bandwidth consideration:** RTP media crossing the VPN adds 10-15ms latency. At 10K G.711 calls, that is ~872 Mbps through the VPN -- ensure VPN capacity exceeds this.

### 3.4 Carrier IP Whitelisting

For production, expand beyond the POC inline subnet checks:

- Use the `permissions` module with a database-backed `carrier_whitelist` table for runtime updates without restart:
  ```
  modparam("permissions", "db_url", "postgres://...")
  modparam("permissions", "address_table", "carrier_whitelist")
  ```
- Host firewall (iptables/nftables) should ALSO whitelist Bandwidth IPs on port 5060. Defense in depth.
- Request the complete Bandwidth origination IP list from your account team.

### 3.5 Rate Limiting and DDoS Protection

Production tuning from the POC baseline:

| Parameter | POC Value | Production Value | Rationale |
|-----------|-----------|------------------|-----------|
| `PIKE_THRESHOLD` | 50 req/s | 100 req/s | Higher CPS means more legitimate traffic |
| `PIKE_TIMEOUT` | 300s | 600s | Longer block for persistent attackers |
| `SCANNER_THRESHOLD` | 5 | 3 | Faster scanner detection |
| `OPTIONS_FLOOD_THRESHOLD` | 20/s | 10/s | Lower tolerance for OPTIONS floods |
| `children` | 16 | 32 | More SIP worker processes |

**Additional protections:**
- **fail2ban** on the host OS parsing Kamailio logs. Adds iptables DROP rules at the kernel level.
- **SIP topology hiding** for all interfaces (already handled in `route[TO_CARRIER]`).
- **GeoIP filtering** via `geoip2` module. Block SIP from countries with no customers.
- **Kernel-level rate limiting:**
  ```
  iptables -A INPUT -p udp --dport 5060 -m string --string "friendly-scanner" --algo bm -j DROP
  iptables -A INPUT -p udp --dport 5060 -m string --string "sipvicious" --algo bm -j DROP
  iptables -A INPUT -p udp --dport 5060 -m hashlimit --hashlimit-above 100/sec \
    --hashlimit-burst 200 --hashlimit-mode srcip --hashlimit-name sip_limit -j DROP
  ```

---

## 4. FreeSWITCH Production Hardening

### 4.1 Changes from POC to Production

| Area | POC State | Production Change |
|------|-----------|-------------------|
| Build | Source build in Dockerfile | Pre-built image in private registry |
| ESL password | `ClueCon` (default) | 32+ char random, injected via secret manager |
| Database creds | Hardcoded in docker-compose.yml | Secret manager (Vault, Docker secrets) |
| RTP port range | 16384-18383 (2,000 ports) | 16384-49151 (32,768 ports) |
| `max-proceeding` | 5,000 | 15,000 |
| Host networking | Yes | Yes, keep for production |
| Log level | Default (debug for some) | `WARNING` in production, `INFO` on demand |
| `TEST_MODE` | `true` | `false` |
| RTP keepalive | 15s (GCE NAT workaround) | Remove if on-prem with no NAT |
| Entrypoint loopback hack | Adds public IP to lo | Remove for on-prem with direct IPs |
| mod_verto | Loaded | Do not load. Not needed for RCF. |

### 4.2 Modules to Disable for RCF

RCF does not need these FreeSWITCH modules. Disable them to reduce attack surface and memory footprint:

- `mod_verto` -- WebRTC signaling, not used
- `mod_conference` -- conferencing, not used
- `mod_voicemail` -- voicemail, not used
- `mod_callcenter` -- ACD queues, not used
- `mod_fifo` -- call queues, not used
- `mod_av` -- video, not used
- `mod_valet_parking` -- call parking, not used

Keep loaded: `mod_sofia`, `mod_dptools`, `mod_lua`, `mod_json_cdr`, `mod_commands`, `mod_logfile`, `mod_dialplan_xml`, `mod_sndfile` (for error tones).

### 4.3 Connection Pooling to PostgreSQL

The POC's `luasql-postgres` creates a new TCP connection per query per call. At 500 CPS, this is unsustainable.

**Production approach:**
- PgBouncer per DC in `transaction` pooling mode.
- Lua scripts connect to local PgBouncer (127.0.0.1:6432), not directly to PostgreSQL.
- PgBouncer pool sizing: `default_pool_size=200`, `max_client_conn=5000`.

### 4.4 Media Handling for RCF

**proxy_media mode (current, correct for RCF):**
- RTP flows through FreeSWITCH but is not decoded/re-encoded. CPU usage is minimal.
- FS rewrites SDP but passes RTP packets directly.
- Both legs are G.711. No codec negotiation complexity.

**bypass_media mode (future optimization):**
- RTP flows directly between Bandwidth and the destination, bypassing FS entirely after call setup.
- Reduces FS CPU and bandwidth by ~90%.
- Tradeoff: FS loses visibility into RTP (no quality stats in CDR).
- Consider when scaling beyond 10K concurrent on a single FS.

**Production RTP configuration:**
- Remove `rtp-keepalive-sec=15` if no NAT between FS and carrier.
- Set `rtp-timeout-sec=120` (tolerate longer silence/hold periods).
- Set `rtp-hold-timeout-sec=3600` (1 hour max hold).

### 4.5 CDR Pipeline

At production volume (500 CPS = 43M CDRs/day), direct Lua-to-PostgreSQL writes create unsustainable DB pressure.

**Production CDR pipeline (simple, no Kafka):**
```
FreeSWITCH -> mod_json_cdr -> Local JSON files (rotated every 60s)
  -> Cron job (every 60s) -> Batch INSERT via COPY into PostgreSQL
  -> TimescaleDB handles partitioning and compression
```

**mod_json_cdr configuration:**
- Write to local disk first. Never directly to an HTTP endpoint.
- Rotate files every 60 seconds or 10,000 records.
- Batch loader uses `COPY` for bulk insert (orders of magnitude faster than individual INSERTs).

### 4.6 Log Management

- `mod_logfile` writes to `/var/log/freeswitch/freeswitch.log` with daily rotation.
- Default log level: `WARNING`. Use `fs_cli` to increase to `DEBUG` for troubleshooting.
- Ship logs to Loki via Promtail for centralized viewing in Grafana.
- Per-module tuning: `mod_sofia` at `WARNING` (extremely verbose at INFO), `mod_lua` at `INFO` (captures routing decisions).

---

## 5. Database Architecture

### 5.1 PostgreSQL HA with Patroni

```
CHI DC                              DAL DC
┌──────────────────────┐           ┌──────────────────────┐
│  PG-PRIMARY          │           │  PG-REPLICA          │
│  PostgreSQL 16       │  ───────> │  PostgreSQL 16       │
│  TimescaleDB         │  Streaming│  TimescaleDB         │
│  Patroni Leader      │  Repl.   │  Patroni Follower    │
│  Read/Write          │           │  Read-Only           │
└──────────┬───────────┘           └──────────┬───────────┘
           │                                  │
     ┌─────┴──────┐                     ┌─────┴──────┐
     │ etcd-chi-1 │                     │ etcd-dal-1 │
     │ etcd-chi-2 │    etcd cluster     │ etcd-dal-2 │
     │ etcd-chi-3 │ <=================> │ etcd-dal-3 │
     └────────────┘                     └────────────┘
```

**Key configuration:**
- etcd cluster spans both DCs (3 nodes CHI, 3 nodes DAL). Quorum requires majority, preventing split-brain on DC failure.
- Use **asynchronous replication** for RCF v1. CDR writes are high-volume and can tolerate seconds of data loss on failover. Synchronous replication adds cross-DC RTT (~10-15ms) to every write, which is unnecessary for RCF.
- Patroni REST API provides health endpoints for PgBouncer and monitoring.

**Failover behavior:**
1. PG primary in CHI fails.
2. Patroni in DAL detects leader loss via etcd lease expiry (~30s).
3. DAL replica promotes to primary.
4. PgBouncer in both DCs reconfigures to new primary.
5. All FS instances resume writing to the new primary.
6. When CHI PG returns, it rejoins as a replica.

### 5.2 TimescaleDB CDR Retention

| Parameter | Production | Rationale |
|-----------|------------|-----------|
| Chunk interval | 1 day | At 43M CDRs/day, daily chunks are efficient for compression and dropping |
| Compression delay | 2 hours | Compress soon to reduce storage; allows for late-arriving CDRs |
| Retention (detailed) | 1 year | Regulatory/billing requirement. Compressed data is small. |
| Continuous aggregates | Hourly + daily + monthly | Dashboard queries hit aggregates, not raw data |

**Storage estimate:**
- Raw CDR: ~500 bytes/row. 43M rows/day = ~21.5 GB/day uncompressed.
- TimescaleDB compression: 10-15x on CDR data = ~1.5-2 GB/day compressed.
- 1 year retention = ~550-730 GB compressed.
- 1 TB NVMe RAID-10 provides comfortable headroom.

### 5.3 PgBouncer Per DC

**CHI PgBouncer:**
```ini
[databases]
voip = host=10.10.1.60 port=5432 dbname=voip pool_size=200
voip_ro = host=10.10.1.60 port=5432 dbname=voip pool_size=100

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = scram-sha-256
pool_mode = transaction
max_client_conn = 5000
default_pool_size = 200
reserve_pool_size = 50
```

**DAL PgBouncer:**
```ini
[databases]
voip = host=10.10.1.60 port=5432 dbname=voip pool_size=200
voip_ro = host=10.20.1.60 port=5432 dbname=voip pool_size=200
```

Route CDR inserts and provisioning writes to `voip` (primary). Route DID lookups and customer data reads to `voip_ro` (local replica) for lower latency.

### 5.4 Backup and Recovery

| Backup Type | Frequency | Retention | Tool |
|-------------|-----------|-----------|------|
| Full base backup | Daily | 30 days | pgBackRest to GCS |
| WAL archiving | Continuous | 7 days | pgBackRest archive-push |
| Logical dump | Weekly | 90 days | pg_dump (schema + seed data) |

**RPO/RTO targets:**
- RPO: < 5 seconds with async replication.
- RTO: < 5 minutes with Patroni automatic failover. < 1 hour for full restore from backup.

---

## 6. Redis Architecture

### 6.1 Local Per-DC

Redis is local to each DC and stores purely ephemeral data:

| Data Type | Examples |
|-----------|---------|
| Channel counters | `channel:count:customer_123` -- active calls per customer |
| Velocity tracking | `velocity:+15551234567` -- calls/minute for fraud detection |
| Rate limit state | CPS counters per customer |
| Session cache | Cached customer/DID lookups (TTL 60s) |

No cross-DC Redis sync is needed for RCF. There is no presence, chat, or session state to share.

### 6.2 Production Configuration

```
bind 10.10.1.55
port 6379
requirepass <strong-random-password>

maxmemory 4gb
maxmemory-policy volatile-lru

# No persistence (ephemeral cache)
save ""
appendonly no

# Threading
io-threads 4
io-threads-do-reads yes

hz 100
dynamic-hz yes

# Disable dangerous commands
rename-command KEYS ""
rename-command FLUSHALL ""
rename-command FLUSHDB ""
rename-command DEBUG ""
```

**HA approach:** Single Redis per DC with restart tolerance. If Redis dies, Lua scripts handle connection failures gracefully (try/catch, fall back to DB or skip velocity checks). The data rebuilds from call activity. Add Sentinel only if uptime requirements demand it later.

---

## 7. DNS and Carrier Integration

### 7.1 Bandwidth IP Configuration

Bandwidth uses IP-based peering. Two approaches:

**Option A: Direct IP whitelisting (recommended for launch)**
- Whitelist CHI SBC public IPs (2) + DAL SBC public IPs (2) + GCP IP (1) in Bandwidth dashboard.
- Configure Bandwidth to send inbound calls with priority ordering: CHI first, DAL second, GCP last.
- Bandwidth's SIP proxy handles failover -- if CHI IPs do not respond, it tries DAL.

**Option B: DNS SRV records (more flexible, consider post-launch)**
```
_sip._udp.sip.revup.io. 300 IN SRV 10 50 5060 sbc-chi1.revup.io.
_sip._udp.sip.revup.io. 300 IN SRV 10 50 5060 sbc-chi2.revup.io.
_sip._udp.sip.revup.io. 300 IN SRV 20 50 5060 sbc-dal1.revup.io.
_sip._udp.sip.revup.io. 300 IN SRV 20 50 5060 sbc-dal2.revup.io.
_sip._udp.sip.revup.io. 300 IN SRV 30 50 5060 sbc-gcp.revup.io.
```
Priority 10 (CHI), 20 (DAL), 30 (GCP). Verify SRV support with your Bandwidth account team first.

### 7.2 API Endpoint

- `api.revup.io` behind a simple load balancer or direct A record.
- Health check: `GET /health` on the FastAPI service.
- API can run in any DC since it connects to the central database.

### 7.3 DID Routing Strategy

**All DIDs to all DCs (recommended):**
- All Bandwidth DIDs route to all DC IPs with priority ordering.
- Any DC can handle any DID because all DCs share the same database.
- No DID-to-DC mapping needed. Simplest to manage.

### 7.4 SIP Trunk Per DC

Each DC's Kamailio needs DC-specific values:
```
# CHI Kamailio
#!substdef "!ADVERTISE_IP!203.0.113.10!g"
#!define FREESWITCH_IP "10.10.1.50"

# DAL Kamailio
#!substdef "!ADVERTISE_IP!203.0.113.20!g"
#!define FREESWITCH_IP "10.20.1.50"
```

The `route[TO_CARRIER]` logic is identical across DCs -- the X-Carrier header determines which Bandwidth IP to target.

### 7.5 IP Whitelisting Migration from GCP

1. Request additional IP whitelisting from Bandwidth for CHI and DAL public IPs.
2. Add new IPs to Bandwidth SIP Peer with priority: CHI (1), DAL (2), GCP (3, existing, becomes DR).
3. Test inbound calls to each DC individually.
4. Test outbound calls from each DC (Bandwidth authenticates by source IP).
5. Enable all IPs simultaneously. GCP becomes DR-only.

---

## 8. Container Strategy

### 8.1 Service Stack (5 services per DC)

RCF requires only 5 services, down from 11+ in the full platform plan:

| Service | Image | Host Network | Notes |
|---------|-------|-------------|-------|
| Kamailio (x2) | `registry.revup.io/kamailio:x.y.z` | Yes | SBC, UDP :5060 |
| FreeSWITCH (x1) | `registry.revup.io/freeswitch:x.y.z` | Yes | Media server, :5080/:5090, RTP range |
| Redis (x1) | `redis:7-alpine` | No | Ephemeral cache, :6379 |
| PgBouncer (x1) | `pgbouncer/pgbouncer:latest` | No | Connection pooler, :6432 |
| FastAPI (x1) | `registry.revup.io/api:x.y.z` | No | Provisioning API, :8000 |

PostgreSQL runs on dedicated VMs (not containers) for data safety. Monitoring (Prometheus, Grafana, Loki) runs on a separate monitoring VM.

**Not deployed for RCF v1:** Homer, RTPEngine, Nginx/React UI, mod_verto.

### 8.2 Docker Compose (not Kubernetes)

Docker Compose is correct for this scale:
- Only 5 services per DC. No orchestration complexity needed.
- 2 services require host networking (FS, Kamailio). Kubernetes supports this but it is awkward.
- When the platform grows beyond 3 DCs or needs auto-scaling, migrate to Kubernetes.

**Structure for future Kubernetes migration:**
- All configuration via environment variables.
- Health checks defined in compose files.
- Images in a private registry (Harbor or GHCR).
- No host-path volumes for stateful data.

### 8.3 Image Registry

- Deploy Harbor on the monitoring VM, or use GitHub Container Registry.
- Tag images with git SHA + semantic version: `registry.revup.io/freeswitch:1.0.0-abc1234`
- Never use `:latest` in production.

### 8.4 Rolling Updates

**FreeSWITCH:**
- Cannot be updated without dropping active calls.
- Graceful drain: tell Kamailio to stop sending new calls (`ds_mark_dst("i")`). Wait for active calls to complete. When count reaches acceptable threshold, restart FS.
- Cross-DC approach: drain CHI FS (route all calls to DAL), update CHI, then reverse.

**Kamailio:**
- Rolling update: update KAM-C1 while KAM-C2 handles traffic. Brief disruption (~2s) for in-dialog requests on the restarting SBC. Then update KAM-C2.

### 8.5 Health Checks

| Service | Health Check | Interval | Failure Action |
|---------|-------------|----------|----------------|
| FreeSWITCH | `fs_cli -x "sofia status profile external"` | 15s | Alert + auto-restart after 3 failures |
| Kamailio | `kamcmd dispatcher.list` | 10s | Alert + auto-restart after 2 failures |
| Redis | `redis-cli -a <pass> ping` | 5s | Auto-restart |
| PgBouncer | `psql -h 127.0.0.1 -p 6432 -c "SHOW POOLS"` | 10s | Auto-restart |
| FastAPI | `curl -sf http://127.0.0.1:8000/health` | 10s | Auto-restart |

---

## 9. Security Hardening

### 9.1 TLS Requirements (Simplified for RCF)

RCF has no WebRTC, no browser clients, no WSS. The TLS surface is minimal:

| Connection | Requirement |
|------------|------------|
| SIP to/from Bandwidth | UDP :5060 plain (Bandwidth does not support TLS) |
| API | HTTPS :443 via Let's Encrypt behind reverse proxy |
| DB connections | TLS (`sslmode=verify-full` in connection strings) |
| Redis | Restrict to DC-internal IPs only (no TLS needed on private network) |
| Inter-DC VPN | IPsec or WireGuard tunnel |
| ESL | Bind to 127.0.0.1 only |

No SIP TLS, no SRTP, no WSS, no self-signed browser certificates. This is a pure carrier-to-carrier RTP path.

### 9.2 Network Segmentation

| VLAN | Purpose | Hosts |
|------|---------|-------|
| 10 | SIP-External (carrier-facing) | SBC public interfaces |
| 20 | SIP-Internal (FS-to-SBC) | SBC internal, FS |
| 30 | Media (RTP) | FS media interfaces |
| 40 | Data (DB, Redis, API) | PG, Redis, API, PgBouncer |
| 50 | Management (SSH, monitoring) | All hosts mgmt interfaces |
| 60 | VPN (inter-DC) | VPN endpoints |

**Firewall rules:** VLAN 10 can only reach VLAN 20. VLAN 20 can reach VLAN 30 and 40. VLAN 30 is isolated. VLAN 40 internal only. VLAN 50 can reach all.

### 9.3 Secret Management

- Deploy HashiCorp Vault (or Infisical/Doppler) for secret storage.
- Secrets injected as environment variables at container start.
- Rotate all defaults immediately: PostgreSQL passwords, ESL password (`ClueCon`), Redis password.
- Never commit secrets to git.

### 9.4 Audit Logging

- **API audit log:** Log all provisioning changes (RCF number CRUD, customer changes) to a separate audit table with timestamp, user, action, before/after values.
- **SSH access:** Bastion host for all SSH access. Log sessions with `auditd`.
- **Database audit:** Enable `pgaudit` for DDL and privileged operations.

---

## 10. Monitoring and Alerting

### 10.1 Stack: Prometheus + Grafana + Loki

```
┌───────────────┐     ┌───────────────┐     ┌───────────────┐
│  Prometheus   │────>│   Grafana     │<────│   Loki        │
│  (Metrics)    │     │  (Dashboards) │     │  (Logs)       │
└───────┬───────┘     └───────────────┘     └───────┬───────┘
        │                                           │
   Exporters:                                  Promtail on
   - kamailio_exporter                         each host
   - freeswitch_exporter (ESL)
   - redis_exporter
   - postgres_exporter
   - node_exporter
```

### 10.2 Key Dashboards

1. **RCF Call Volume:** CPS, concurrent calls, ASR (answer-seizure ratio), ACD (average call duration) per DC, per customer.
2. **SBC Health:** SIP transactions/sec, response code distribution, rate limiting triggers, blocked IPs.
3. **Infrastructure:** CPU, memory, network, disk per host.
4. **Database:** Query latency, connection pool utilization, replication lag.
5. **RCF Provisioning:** Numbers provisioned, API request rate, error rate.

### 10.3 Critical Alerts

| Alert | Condition | Severity |
|-------|-----------|----------|
| FS down | Health check fails 3x | P1 (page) |
| Both SBCs in a DC down | Health check fails | P1 (page) |
| DB replication lag > 30s | `pg_stat_replication.replay_lag` | P1 (page) |
| ASR < 50% | Answer-seizure ratio drops | P2 (notify) |
| CPS > 80% capacity | Approaching limits | P2 (notify) |
| Disk > 85% | Any production host | P3 (ticket) |
| Certificate expiry < 14 days | API TLS cert | P3 (ticket) |

### 10.4 Distributed Tracing

Correlation ID flows through the entire RCF call path:

```
Bandwidth INVITE (Call-ID: abc123)
  -> Kamailio adds X-CID: abc123
    -> FreeSWITCH A-leg (uuid: xxx, X-CID: abc123)
      -> Lua: [abc123] RCF lookup for +15551234567 -> forward to +15559876543
      -> FreeSWITCH B-leg (uuid: yyy, X-CID: abc123)
        -> Kamailio TO_CARRIER (X-CID: abc123)
          -> CDR.correlation_id = abc123
```

Store correlation_id in CDR as a first-class field. Include in all log messages.

---

## 11. Deployment Timeline

RCF-only deployment is substantially faster than a full UCaaS platform. No WebRTC, no UI, no complex media handling.

| Phase | Timeline | Deliverables |
|-------|----------|-------------|
| **Phase 1: Foundation** | Weeks 1-2 | Site-to-site VPN (CHI-DAL). vCenter VMs provisioned. Private Docker registry. Secret management (Vault). |
| **Phase 2: Database** | Weeks 2-4 | Patroni cluster (CHI primary, DAL replica). PgBouncer per DC. pgBackRest backup. Migrate POC data. |
| **Phase 3: CHI DC** | Weeks 3-5 | Deploy FS-CHI, KAM-C1, KAM-C2, Redis-CHI, FastAPI. SIPp load test at 120% target. Whitelist CHI IPs with Bandwidth. |
| **Phase 4: DAL DC** | Weeks 5-6 | Deploy FS-DAL, KAM-D1, KAM-D2, Redis-DAL. Test cross-DC failover. Whitelist DAL IPs with Bandwidth. |
| **Phase 5: Monitoring** | Weeks 5-7 | Prometheus + Grafana + Loki per DC. Alert rules. Dashboards. |
| **Phase 6: Cutover** | Week 7-8 | Migrate production traffic from GCP. GCP becomes DR. 24/7 monitoring during burn-in. |
| **Phase 7: Hardening** | Weeks 8-10 | fail2ban. GeoIP filtering. Audit logging. Security review. |

**Total: ~10 weeks to production RCF.** This is roughly 60% of the original 16-week timeline because we are not deploying WebRTC, UI, Homer, RTPEngine, or UCaaS features.

---

## 12. Future Phases

Features to add in subsequent releases, after RCF is stable in production:

### Phase 2: Toll-Free (8XX) Multi-Carrier Expansion

~22,000 RCF and Voicemail subscribers use toll-free (8XX) numbers (LCC 6 = '8XX Orig'). These cannot be migrated until multi-carrier inbound toll-free infrastructure is in place. Geographic DIDs migrate first on Bandwidth only.

**Why multi-carrier:** Toll-free routing uses SMS/800 (TFN Registry) with LCO (Least Cost Origination) — the Customer Record routes each inbound call to the cheapest carrier based on the caller's origination. Single-carrier loses LCO savings and redundancy.

**Required inbound toll-free carriers:**

| Carrier | Notes |
|---------|-------|
| Inteliquent (Sinch) | Major toll-free carrier |
| Lumen (CenturyLink/Level 3) | Tier 1 |
| Verizon | Tier 1 |
| AT&T | Tier 1 |
| 382/Iristel | Canadian CLEC |
| TBD | Possibly one more |

All carrier contracts are through Granite Telecommunications. Direct trunk agreements exist on Granite's other systems.

**RespOrg strategy:** Existing RespOrg ID is assigned to another Granite system. A new RespOrg ID may be needed for this platform to independently manage SMS/800 Customer Records and LCO routing tables.

**Platform changes required:**

1. **Kamailio multi-carrier ACL:** Expand from Bandwidth-only (2 IPs) to per-carrier trusted IP sets. Use `address` module or `htable` for scalable carrier identification.
2. **Per-carrier dispatcher groups:** Each carrier gets its own dispatcher group in `dispatcher.list` for health monitoring and failover.
3. **Per-carrier SIP normalization:** Each carrier has different SIP behaviors (Session-Expires, Via handling, codec preferences). REPLY_HANDLER and request processing may need per-carrier branches.
4. **Carrier identification on inbound:** Kamailio must tag each inbound INVITE with the originating carrier (e.g., `X-Inbound-Carrier` header) for CDR attribution and debugging.
5. **GCP firewall rules:** Each carrier's signaling and media IP ranges must be allowed on SBC VMs.
6. **Homer/HEP labeling:** HEP capture should identify carrier per-leg for SIP debugging.

**Architecture target:** 6 carrier interconnects (Bandwidth + 5 toll-free carriers). Design Kamailio carrier handling to be table-driven so adding a new carrier is a config change, not a code change.

**Migration sequence:**
1. Geographic DIDs migrate first (Bandwidth only) — **current phase**
2. Establish SIP trunks with each toll-free carrier
3. Obtain/provision new RespOrg ID
4. Pilot: 10-50 toll-free numbers through Bandwidth to validate 8XX routing on the platform
5. Configure LCO routing in SMS/800 Customer Records across all carriers
6. Phased migration: low-volume TFNs first, high-volume utility hotlines last

### Phase 3: SIP Trunking Product (was Phase 2)
- Customer PBX registration and IP authentication via Kamailio
- SIP TLS on port 5061 for trunk customers who require encrypted signaling
- SRTP optional per-trunk (`rtp-secure-media=optional` as channel variable)
- Outbound calling with LCR (least-cost routing) in Lua
- Per-trunk CPS limits and channel limits in Redis
- Customer-facing trunk provisioning in FastAPI

### Phase 4: API Calling Product
- REST API for programmatic call origination (click-to-call, dialers)
- Webhook CDR delivery for real-time call events
- API key authentication and rate limiting in FastAPI
- Call recording infrastructure (mod_record, object storage)

### Phase 5: Observability Enhancements
- Homer SIP capture (HEP protocol from Kamailio and FreeSWITCH)
- RTPEngine for media anchoring and SRTP-to-RTP transcryption
- MOS/jitter/packet loss metrics from RTP stats
- SIPp-based synthetic monitoring (canary calls)

### Phase 6: UCaaS Features (for trunk/api/hybrid customers only)
- mod_verto / WebRTC for browser-based softphone
- WSS on port 8083, GSLB for WebRTC clients
- SRTP mandatory for WebRTC legs
- Presence, chat, voicemail, conferencing
- React UI with Nginx reverse proxy
- FreeSWITCH sizing upgrade to 32 vCPU / 64 GB for transcoding workload

### Phase 7: Compliance
- E911 integration with Bandwidth E911 API (Kari's Law, RAY BAUM's Act)
- Call recording retention (90 days hot, 7 years cold)
- HIPAA/PCI compliance hardening if serving healthcare or financial customers

---

## Capacity Planning

Establish baselines from day one:

- **Erlang B:** 10K concurrent calls at 3-minute ACD = ~55 CPS steady state. Burst 5-10x = 275-555 CPS. Size for 500 CPS sustained.
- **RCF duty cycle:** Each RCF customer generates approximately 0.01-0.05 concurrent calls. You need 200K-1M RCF numbers before hitting 10K concurrent calls per DC.
- **Load test before production:** SIPp at 120% of target capacity per DC.
- **Trend monitoring:** Weekly CPS and concurrent call peaks in Grafana. Trigger capacity planning at 70% of rated capacity.

---

**Key files referenced:**

- `/Users/keegan/revup/docker-compose.yml` -- service definitions, resource limits
- `/Users/keegan/revup/docker/kamailio/kamailio.cfg` -- SBC routing logic, topology hiding, carrier integration
- `/Users/keegan/revup/docker/kamailio/dispatcher.list` -- carrier gateway and FS backend definitions
- `/Users/keegan/revup/docker/freeswitch/conf/sofia/external.xml` -- carrier-facing SIP profile
- `/Users/keegan/revup/docker/freeswitch/entrypoint.sh` -- GCE NAT workaround (remove for on-prem)
- `/Users/keegan/revup/docker/freeswitch/Dockerfile` -- multi-stage build, Lua dependencies
- `/Users/keegan/revup/docker/postgres/pgbouncer.ini` -- connection pooling configuration
- `/Users/keegan/revup/docker/postgres/init/05_schema_cdr.sql` -- CDR hypertable, compression, retention
- `/Users/keegan/revup/docker/redis/redis.conf` -- ephemeral cache configuration
