# Production Architecture: RCF (Remote Call Forwarding) v1

> **Scope of this document.** This is the master *reference* for the live
> platform — the server inventory, network layout, per-layer design, carrier
> integrations, data plane, observability, and operations planes as they
> actually run in production. It is organized as reference tables, not prose.
>
> **Maintenance rule: update this file alongside any change it describes.**
> A VM resize, a new firewall rule, a new dispatcher group, a new migration —
> if it lands in prod, it lands here in the same PR.
>
> **Last verified against production: 2026-09-04.**
>
> Deep-dive sources this document links to rather than duplicating:
> - Root `CLAUDE.md` — hard-won SIP lessons, critical gotchas, env-var reference (canonical for those).
> - `docker/kamailio/CLAUDE.md` — full SBC routing internals (esp. §8.10 in-dialog dispatch).
> - `GCP_DEPLOYMENT_PLAN.md` — zone bring-up procedure and `.env` values.
> - `docs/*RUNBOOK*.md` — operational procedures (index in §11).

## Table of Contents

1. Overview, Product Surface, Current State
2. Server Inventory (fleet tables + port registry)
3. Network Architecture
4. SBC Layer (Kamailio)
5. Media Layer (FreeSWITCH)
6. Carrier Integrations (Bandwidth + Sinch)
7. STIR/SHAKEN
8. Data Layer (PostgreSQL, CDRs, export, backups)
9. Observability
10. Admin & Operations Planes
11. Runbook & Document Index
12. Known Open Items / Drift Register

---

## 1. Overview, Product Surface, Current State

Production Remote Call Forwarding (RCF) platform built for Granite
Telecommunications — carrier-grade, nationwide, all-GCP. Branch `RCF-V1` is
production; the `Full-System`/`unified` branches hold the UCaaS stack, which is
**not deployed** here.

### 1.1 Product surface (live)

| Product | Status | Notes |
|---------|--------|-------|
| **RCF** (Remote Call Forwarding) | **LIVE — primary product** | DID → forward_to mapping. No end-customer UI access. On-net short-circuit routing for platform-owned destinations. |
| **SIP Trunking** | LIVE | IP-peering only (REGISTER declined). Multi-zone redundant inbound; FS-aware `/healthz` + `trunk.granitevoip.com` DNS failover. |
| **API Calling** | LIVE | Programmable voice. Outbound `/v1/calls` is **East-only single-region** (accepted limitation — ESL pinned to East FS-1). |
| UCaaS (WebRTC/voicemail/conferencing/chat) | NOT on this branch | `Full-System`/`unified` only. RCF customers never see UCaaS features. |

### 1.2 Current-state summary (2026-09-04)

| Plane | State |
|-------|-------|
| Zones | East (us-east1-b), West (us-west1-b), Central (us-central1-b) — **all LIVE since 2026-07-23**, each self-contained for SIP/RTP (calls never cross zones) |
| Fleet | 16 production VMs + 1 banked load-test VM (see §2) |
| SBC HA | **Active/standby** pair per zone via GCP NLB failover backends — deployed + drill-verified all zones **2026-08-27** (§4.1) |
| FS media HA | **Strict active/standby** FS-2 per zone via dispatcher alg 8 — deployed + drilled all zones **2026-08-31** (§5.1) |
| Maintenance plane | Kamailio `maint` drain htable + agent verbs + CRAG Maintenance tool — **LIVE 2026-09-03/04** (§4.6, §10.4) |
| Carriers | Bandwidth (origination + all termination) + Sinch (origination live; termination trunks provisioned as backup, table-driven) (§6) |
| STIR/SHAKEN | Signing LIVE on all 6 SBCs; self-hosted x5u; STI-PA trust pipeline live; inbound own-crypto verify deployed **DARK** (§7) |
| Data | East PG primary → 3 physical replicas (east-standby / west / central); CDR export to Equinox via FTP, flag-gated (§8) |
| Observability | Per-VM vmagent → East VictoriaMetrics (12-mo retention); 7 Grafana NOC boards; GCM alerting (email + Slack/PagerDuty paths); Homer HEP (§9) |
| Admin | revup UI (customer/support/admin) + CRAG console at `granitevoip.com/crag` + fleet-wide ops-agent `:8710` (§10) |

### 1.3 RCF call flow (condensed)

```
Bandwidth/Sinch  →  zone NLB VIP :5060  →  ACTIVE SBC (Kamailio)
  → topology hiding, dedup, CPS gates, STIR handling
  → dispatch to ACTIVE FreeSWITCH :5080 (internal profile)
  → Lua inbound_router.lua: DID lookup on the LOCAL PG replica
  → on-net check (number_routing view): platform-owned dest ⇒ internal delivery, no hairpin
  → else bridge B-leg :5090 → zone signaling ILB VIP :5060 → ACTIVE SBC
  → table-driven carrier trunk selection (carrier_trunks) → Bandwidth PoP → PSTN
```

Full 9-step flow with header/RR details: root `CLAUDE.md` → "Call Flow (RCF)"
and "On-Net (Internal) Routing". Kamailio in-dialog mechanics:
`docker/kamailio/CLAUDE.md` §8.10.

### 1.4 HA failure matrix (what actually happens)

All drilled states are drill-verified (SBC 2026-08-27, FS 2026-08-31, DB
restore proven in a real recovery).

| Failure | Detection | Recovery | Behavior |
|---------|-----------|----------|----------|
| Active SBC dies | NLB fs-aware HC, ~10–12s | Auto (failover backends), auto failback | Both planes (carrier VIP + signaling ILB) flip to standby SBC. Established calls survive (`;fs=` stateless dispatch); setups in flight during the ~6s flip are lost. |
| Standby SBC dies | HC + `sbc_failover.tf` log alert | Page (redundancy degraded) | No traffic impact; zone runs unprotected until restored |
| Active FS dies | Dispatcher OPTIONS 3×5s; fs-watchdog pages | Auto (alg 8 → FS-2), auto failback | That FS's active calls are lost; new calls land on FS-2. East ESL/API originates fail while FS-1 is down (open item §12.3) |
| Both FS in a zone down | `/healthz` → 503 on both SBCs | Auto | Zone drains at the NLB + DNS; carriers re-route to remaining zone VIPs |
| Entire zone dark | NLB all-backends-unhealthy + GCM VIP uptime CRITICAL | Auto + page | Carrier-side distribution to remaining zone VIPs; also achievable deliberately via the maintenance plane (§4.6) |
| Carrier PoP failure | Kamailio 5xx/408/480 failover (flag 8) + dispatcher probe state | Auto | Retry alternate Bandwidth PoP; table-driven attempts continue down the priority list (§5.5) |
| SBC unreachable from FS | TCP pre-check < 1s (cached) | Auto | 4-attempt loop: signaling VIP → SBC-1 direct, × primary/secondary carrier |
| Redis dies (media VM) | FS reconnect | Auto | Trunk/API caches fall through to PG; RCF path unaffected (already DB-only) |
| Zone PG replica dies | postgres-exporter / replication guard | Manual repoint | Zone DID lookups fail → zone effectively drains; repoint `DB_HOST` per DB failover runbook |
| PG primary dies | replication guard + GCM | Manual promote (`docs/runbooks/DB_FAILOVER_RUNBOOK.md`) | Active calls unaffected; provisioning + CDR ingest 503 until promotion (east-db-standby is the HA target) |

---

## 2. Server Inventory

**GCP project:** `rugged-night-193017`. **Repo path on every VM:** `/opt/revup`.
16 production VMs (6 East, 5 West, 5 Central) plus `west-loadtest` (banked SIPp
harness, excluded from monitoring). East VM names are legacy
(`poc-custom-voip`, `kam-g2`, `fs-media-v2`); West/Central follow
`{zone}-sbc-N` / `{zone}-fs[-2]` / `{zone}-db`.

Per-VM software is identical **per role** — see §2.5 for the role → containers
/ ports / agents / systemd mapping, and §2.6 for the fleet-wide port registry.

### 2.1 East — us-east1-b (holds PG primary + API + UI + Homer + metrics store)

| VM | Role | Machine Type | Internal IP | External IP | Subnet | Network Tags | Node ID | HEP ID |
|----|------|--------------|-------------|-------------|--------|--------------|---------|--------|
| `poc-custom-voip` | SBC-1 (ACTIVE) | n2-standard-4 | 10.142.0.100 | 34.74.71.32 | default | bypass-vpn, custom-voip, lb-health-check, voip-sbc | `east-sbc-1` | 100 |
| `kam-g2` | SBC-2 (standby) | e2-standard-4 | 10.142.0.101 | 35.243.136.35 | default | bypass-vpn, lb-health-check, voip-sbc | `east-sbc-2` | 100 |
| `fs-media-v2` | FS-1 (ACTIVE) + Redis | e2-standard-8 | 192.168.10.2 | 34.139.119.135 | voip-media (192.168.10.0/24) | bypass-vpn, voip-media | `east-fs-1` | 200 |
| `east-fs-2` | FS-2 (hot standby) | e2-standard-8 (machine-image clone of FS-1) | 192.168.10.3 | 35.196.226.123 | voip-media | bypass-vpn, voip-media | `east-fs-2` | 201 |
| `services` | PG **primary** + PgBouncer + API + UI + Homer stack + VictoriaMetrics + x5u | **e2-highmem-4 (32 GB — resized 2026-09-02)** | 10.142.0.103 | 34.26.57.37 | default | lb-health-check, voip-services | `services` | — |
| `east-db-standby` | PG hot standby (HA; **us-east1-c**) | e2-standard-4 | 10.142.0.87 | — | default | bypass-vpn, voip-db-standby | — | — |

Notes:
- `services` resize: PG retuned via `conf.d` drop-in `90-revup-32gb`
  (`shared_buffers=8GB`, `effective_cache_size=20GB`, `work_mem=32MB`) —
  applied by `scripts/services-tuning/apply_pg_32gb.sh`; budget doc
  `docs/SERVICES_VM_32GB_TUNING.md`. Root `CLAUDE.md` still says
  e2-standard-4 — drift, see §12.
- `east-db-standby` has **no metrics agent** — monitored via replication SQL
  (`scripts/backup/replication_guard.sh`) from the primary.

### 2.2 West — us-west1-b

| VM | Role | Machine Type | Internal IP | External IP | Subnet | Network Tags | Node ID | HEP ID |
|----|------|--------------|-------------|-------------|--------|--------------|---------|--------|
| `west-sbc-1` | SBC-1 (ACTIVE) | e2-standard-4 | 10.138.0.100 | 8.229.41.59 | default | bypass-vpn, lb-health-check, voip-sbc | `west-sbc-1` | 110 |
| `west-sbc-2` | SBC-2 (standby) | e2-standard-4 | 10.138.0.101 | 136.117.230.166 | default | bypass-vpn, lb-health-check, voip-sbc | `west-sbc-2` | 110 |
| `west-fs` | FS-1 (ACTIVE) + Redis | e2-standard-8 | 192.168.20.2 | 8.229.177.165 | voip-media-west (192.168.20.0/24) | bypass-vpn, voip-media | `west-fs-1` | 210 |
| `west-fs-2` | FS-2 (hot standby) | e2-standard-8 (clone) | 192.168.20.3 | 35.197.95.171 | voip-media-west | bypass-vpn, voip-media | `west-fs-2` | 211 |
| `west-db` | PG replica + PgBouncer | e2-standard-4 | 10.138.0.2 | 136.118.180.103 | default | bypass-vpn, voip-db-standby | `west-db` | — |
| `west-loadtest` | SIPp load-gen (**banked**, excluded from monitoring) | e2-standard-4 | 10.138.0.3 | 104.198.3.25 | default | bypass-vpn, voip-loadtest | — | — |

### 2.3 Central — us-central1-b

| VM | Role | Machine Type | Internal IP | External IP | Subnet | Network Tags | Node ID | HEP ID |
|----|------|--------------|-------------|-------------|--------|--------------|---------|--------|
| `central-sbc-1` | SBC-1 (ACTIVE) | e2-standard-4 | 10.128.0.100 | 34.41.188.100 | default | bypass-vpn, lb-health-check, voip-sbc | `central-sbc-1` | 120 |
| `central-sbc-2` | SBC-2 (standby) | e2-standard-4 | 10.128.0.101 | 35.184.151.64 | default | bypass-vpn, lb-health-check, voip-sbc | `central-sbc-2` | 120 |
| `central-fs` | FS-1 (ACTIVE) + Redis | e2-standard-8 | 192.168.30.2 | 35.253.103.114 | voip-media-central (192.168.30.0/24) | bypass-vpn, voip-media | `central-fs-1` | 220 |
| `central-fs-2` | FS-2 (hot standby) | e2-standard-8 (clone) | 192.168.30.3 | 34.63.100.161 | voip-media-central | bypass-vpn, voip-media | `central-fs-2` | 221 |
| `central-db` | PG replica + PgBouncer | e2-standard-4 | 10.128.0.2 | **34.69.170.41** (current) | default | bypass-vpn, voip-db-standby | `central-db` | — |

Note: `central-db`'s reserved external IP `136.112.210.141` **detached during a
2026-09-01 stop/start**; the VM currently runs on ephemeral `34.69.170.41`.
Re-attach is an open item (§12).

### 2.4 HEP capture-ID scheme

One `HEP_CAPTURE_ID` per SIP element role per zone (both SBCs in a zone share
the SBC ID; FS-1/FS-2 are distinct):

| Zone | SBCs (Kamailio) | FS-1 | FS-2 |
|------|-----------------|------|------|
| East | 100 | 200 | 201 |
| West | 110 | 210 | 211 |
| Central | 120 | 220 | 221 |

### 2.5 Per-role software stacks

Every VM of a given role runs the identical Docker images (per-VM `.env` is the
only difference). Compose files are the deployment unit.

#### SBC role — `docker-compose.sbc.yml` (6 VMs)

| Container | Image / Build | Network | Listens | Healthcheck |
|-----------|---------------|---------|---------|-------------|
| `voip-kamailio` | build `./docker/kamailio` | host | udp+tcp :5060 on {NLB VIP, SBC_INTERNAL_IP, SIGNALING_VIP, 127.0.0.1}; tcp :8080 on {NLB VIP, SBC_INTERNAL_IP, SIGNALING_VIP, 127.0.0.1} (xhttp: `/metrics` + `/healthz`); tls :5061 (ifdef WITH_TLS, unused) | `kamcmd core.uptime` every 30s |
| `voip-vmagent` | victoriametrics/vmagent:v1.103.0 | host | :8429 | wget `:8429/health` |
| `voip-node-exporter` | prom/node-exporter:v1.8.2 | host | :9100 | — |
| `voip-carrier-monitor` (ops-agent, role=sbc) | build `./docker/carrier-monitor` | bridge | :8710 (command API, VPC-internal); 127.0.0.1:9104 (fsdisp metrics) | — |

Host/systemd on SBC VMs: `docker`, `google-cloud-ops-agent` (syslog →
Cloud Logging, carries the `revup-alert` page hook), STIR trust-bundle cron
(`infra/stir/refresh-sbc-trust-bundle.sh` → `/opt/revup/secrets/stir-ca/`).
External health checks: GCP NLB fs-aware HTTP HC on `:8080/healthz`
(VIP-addressed — see §3.3/§4.7).

#### Media role — `docker-compose.media.yml` (6 VMs)

| Container | Image / Build | Network | Listens | Healthcheck |
|-----------|---------------|---------|---------|-------------|
| `voip-freeswitch` | build `./docker/freeswitch` | host | :5080 udp+tcp (internal profile, inbound), :5090 udp+tcp (external profile, outbound), :8021 ESL (loopback + Docker/RFC1918 ACL), udp :16384–49151 RTP | `fs_cli` sofia status (needs `-p $ESL_PASSWORD`) |
| `voip-redis` | build `./docker/redis` | bridge (6379 → host) | :6379 | `redis-cli ping` |
| `voip-ops-agent` (role=fs) | build `./docker/carrier-monitor` | host | 127.0.0.1:8710 (command API); 127.0.0.1:9103 (ESL exporter) | — |
| `voip-vmagent` | victoriametrics/vmagent:v1.103.0 | host | :8429 | wget `:8429/health` |
| `voip-node-exporter` | prom/node-exporter:v1.8.2 | host | :9100 | — |

Host/systemd on media VMs: `docker`, `google-cloud-ops-agent`,
**`revup-fs-watchdog.timer`** (60s tick; 2 consecutive failed checks → one
`revup-alert`-tagged syslog line → GCM log-match page; state in
`/run/revup/fs-watchdog.state`; installer
`scripts/fs-watchdog/install_fs_watchdog.sh`), `revup-alert@.service`.
Entrypoint adds the VM's public IP to `lo` (GCE hairpin fix, `NET_ADMIN`).

#### Services role — `docker-compose.services.yml` + `docker-compose.x5u.yml` (1 VM: `services`)

| Container | Image / Build | Network | Listens | Purpose |
|-----------|---------------|---------|---------|---------|
| `voip-api` | build `./docker/api` | bridge | 8088→8000 | FastAPI (provisioning, CDR ingest, call control, Homer search) |
| `voip-cdr-exporter` | build `./docker/api` | bridge | — | CDR → Equinox FTP export loop (flag-gated, §8.5) |
| `voip-ui` | build `docker/ui` (nginx) | bridge | 8080→80, 8443→443 | React SPA + `/api/` + `/grafana/` reverse proxy |
| `voip-ops-agent` (role=services) | build `./docker/carrier-monitor` | bridge | :8710 | NOC command API |
| `voip-clickhouse` | clickhouse/clickhouse-server:23.3-alpine | bridge | :8123 HTTP, :9000 native | HEP storage |
| `voip-qryn` | qxip/qryn:latest | bridge | :3100 | Loki-compatible HEP query API |
| `voip-heplify-server` | ghcr.io/sipcapture/heplify-server:1.60.3 | bridge | :9060 udp+tcp, :9061 tcp, :9096 metrics | HEP ingest from all zones |
| `voip-grafana` | grafana/grafana-oss:10.4.3 | bridge | :3000 | NOC dashboards (served at `/grafana/`) |
| `voip-victoriametrics` | victoriametrics/victoria-metrics:v1.103.0 | bridge | :8428 | Central TSDB, `-retentionPeriod=12` (months) |
| `voip-vmalert` | victoriametrics/vmalert:v1.103.0 | bridge | :8880 | Recording rules (30s eval) |
| `voip-node-exporter` | prom/node-exporter:v1.8.2 | host | :9100 | + textfile collector `/var/lib/stir/metrics` (STIR trust metrics) |
| `voip-postgres-exporter` | prometheuscommunity/postgres-exporter:v0.15.0 | bridge | :9187 | Direct PG :5432 (metrics_ro — NOT via PgBouncer) |
| `voip-pgbouncer-exporter` | prometheuscommunity/pgbouncer-exporter:v0.10.2 | bridge | :9127 | PgBouncer pool stats (pgb_stats) |
| `voip-blackbox-exporter` | prom/blackbox-exporter:v0.25.0 | bridge | :9115 (in-network) | HTTP reachability probes of services containers |
| `voip-vmagent` | victoriametrics/vmagent:v1.103.0 | bridge | :8429 (in-network) | Services-VM scrapes → VictoriaMetrics |
| `x5u-caddy` | caddy:2-alpine (**separate compose** `docker-compose.x5u.yml`) | own bridge (x5u-net) | :80, :443 | STIR x5u cert endpoint `fs-cert.granitevoip.com` (§7.2). **NEVER run this compose with `--remove-orphans`** — it shares the compose project name and would delete the whole services stack. |

Host/systemd on `services` (bare, NOT Docker): PostgreSQL 16 + TimescaleDB
(primary), PgBouncer :6432 (transaction mode), `google-cloud-ops-agent`,
backup/guard timers from `scripts/backup/systemd/`:
`revup-pgbackrest-full.timer`, `revup-pgbackrest-diff.timer`,
`revup-pgdump.timer`, `revup-cdr-archive.timer`, `revup-asr-guard.timer`,
`revup-replication-guard.timer`, `revup-slot-wal-guard.timer`, plus
`revup-alert@.service` (generic page hook). STIR trust-bundle publisher cron
(`infra/stir/refresh-stir-trust-bundle.sh` → `/var/lib/stir/`).

#### DB-replica role — `docker-compose.db.yml` (2 VMs: `west-db`, `central-db`)

| Component | Where | Listens | Notes |
|-----------|-------|---------|-------|
| PostgreSQL 16 + TimescaleDB (streaming replica) | bare/systemd | :5432 | hot standby, read-only; streams from East primary |
| PgBouncer | bare/systemd | :6432 (scram) | zone-local pooling for FS/SBC DID lookups |
| `voip-node-exporter` | Docker, host net | :9100 | |
| `voip-postgres-exporter` | Docker, host net | :9187 | `db_role=replica` constant label, direct :5432 |
| `voip-pgbouncer-exporter` | Docker, host net | :9127 | |
| `voip-vmagent` | Docker, host net | :8429 | remote-write → East :8428 |

`east-db-standby` runs the PG standby + PgBouncer only (no Docker metrics
stack — see §2.1 note). `west-loadtest` holds the banked SIPp harness (no
production services, no monitoring enrollment).

### 2.6 Fleet-wide port registry

| Port | Proto | Owner | Purpose | Reachable from |
|------|-------|-------|---------|----------------|
| 5060 | UDP+TCP | Kamailio (SBC VMs) | SIP — carrier ingress on NLB VIP; FS-facing on SBC_INTERNAL_IP + SIGNALING_VIP; loopback for tools | Bandwidth + Sinch IPs, customer trunk IPs (all via GCP firewall), FS on zone subnets, peer SBC |
| 5061 | TCP | Kamailio | SIP-TLS (compiled-out by default, unused) | — |
| 8080 | TCP | Kamailio xhttp | `GET /metrics` (Prometheus) + `GET /healthz` (fs-aware + maint drain; 200/503) | GCP HC ranges 209.85.152.0/22, 209.85.204.0/22, 35.191.0.0/16 (VIP-addressed); vmagent (local); operators (VPC) |
| 5080 | UDP+TCP | FreeSWITCH internal profile | Inbound SIP from Kamailio | Zone SBCs |
| 5090 | UDP+TCP | FreeSWITCH external profile | Outbound B-leg SIP (src); in-dialog to this profile | Zone SBCs |
| 16384–49151 | UDP | FreeSWITCH | RTP media (32K ports) | Carrier media ranges + customer PBX (internet, firewall `voip-rtp`) |
| 8021 | TCP | FreeSWITCH mod_event_socket | ESL (originate/status/ops-agent) | Loopback + Docker/RFC1918 ACL; East API via VPC (`FREESWITCH_ESL_HOST`) |
| 6379 | TCP | Redis (media VMs) | Zone-local cache (trunk/API paths; RCF path is DB-only) | Same VM (host net / published) |
| 5432 | TCP | PostgreSQL (services + db VMs) | Primary (East) / replicas (West/Central/east-standby) + streaming replication | Loopback (PgBouncer, exporters); replica VMs → primary :5432 (firewall `voip-pg-replication`) |
| 6432 | TCP | PgBouncer (services + db VMs) | Transaction pooling (`statement_cache_size=0` required for asyncpg) | API (host.docker.internal), zone FS/SBC (local replica), exporters |
| 8000 | TCP | FastAPI (`voip-api`) | REST API (published as host :8088) | UI nginx proxy, FS xml_curl/json_cdr, uptime checks |
| 8088 | TCP | services host → API | Published API port | VPC + uptime probers |
| 8080/8443 | TCP | nginx (`voip-ui`) | UI HTTP/HTTPS + `/api/` + `/grafana/` proxy | Internet (firewall-gated), operators |
| 80/443 | TCP | Caddy (`x5u-caddy`) | STIR x5u cert + trust bundle over HTTPS; :80 = ACME HTTP-01 | Internet (carrier STIR verifiers, Let's Encrypt) |
| 9060/9061 | UDP+TCP / TCP | heplify-server | HEP capture ingest | All zones' SBC + FS (tag-to-tag `voip-internal` firewall) |
| 9096 | TCP | heplify-server | Prometheus metrics | services vmagent (in-network) |
| 8123 / 9000 | TCP | ClickHouse | HEP storage HTTP / native | qryn, Grafana, API homer.py (bridge net) |
| 3100 | TCP | qryn | Loki-compatible HEP search API | Grafana, API homer.py |
| 3000 | TCP | Grafana | Dashboards | nginx `/grafana/` proxy |
| 8428 | TCP | VictoriaMetrics | Remote-write + query API (12-mo retention) | All zones' vmagents (firewall: West/Central → East :8428), vmalert, Grafana |
| 8880 | TCP | vmalert | Rule status | Grafana/ops (bridge) |
| 8429 | TCP | vmagent (every VM) | Agent health/buffer | Local |
| 8710 | TCP | ops-agent (all roles) | NOC/CRAG command API — bearer token, argv-only verbs (§10.3) | CRAG GKE backend + console hosts (VPC-internal; loopback-only on media VMs) |
| 9100 | TCP | node-exporter (every monitored VM) | Host metrics | Local vmagent |
| 9103 | TCP (lo) | ops-agent ESL exporter (media) | FS channel/call gauges | Local vmagent |
| 9104 | TCP (lo) | ops-agent fsdisp exporter (SBC) | Dispatcher group-1 state incl. `fs_dispatcher_disabled` (MAINT) | Local vmagent |
| 9115 | TCP | blackbox-exporter (services) | HTTP probe module | services vmagent (in-network) |
| 9127 | TCP | pgbouncer-exporter (services + db) | Pool saturation | vmagent |
| 9187 | TCP | postgres-exporter (services + db) | PG/replication metrics | vmagent |

### 2.7 Per-role environment variable reference (`/opt/revup/.env`, never in git)

Condensed — full semantics in root `CLAUDE.md` "Environment Variable
Reference" and `docker/kamailio/CLAUDE.md`. Getting any of these wrong breaks
call flow.

#### SBC VMs

| Variable | Example (East SBC-1) | Purpose |
|----------|----------------------|---------|
| `EXTERNAL_SIP_IP` | 34.24.133.82 | Zone NLB VIP (advertised everywhere) |
| `SBC_INTERNAL_IP` | 10.142.0.100 | This SBC's VPC IP |
| `SBC_SIGNALING_VIP` | 10.142.0.250 | Zone ILB VIP (HA mode; unset ⇒ legacy) |
| `FREESWITCH_IP` / `FREESWITCH_IP_2` | 192.168.10.2 / 192.168.10.3 | Dispatcher group-1 FS-1/FS-2 |
| `FS_PUBLIC_IP` | 34.139.119.135 | FS public IP for SDP rewrite |
| `SBC_ID` / `HEP_CAPTURE_ID` | east-sbc-1 / 100 | Identity + Homer capture |
| `HOMER_IP` / `DB_HOST` / `DB_PORT` | 10.142.0.103 / zone replica / 6432 | HEP dest + trunk-auth SQL |
| `INTERNAL_SUBNET` / `MEDIA_SUBNET` | 10.142.0.0/20 / 192.168.10.0/24 | Per-zone trust CIDRs |
| `BANDWIDTH_PRIMARY_IP` / `SECONDARY_IP` | 67.231.2.12 / 216.82.238.134 | Nearest-PoP egress (West swaps) |
| `SINCH_*_IP`, `BANDWIDTH_TC*` | (defaults baked in) | Carrier IP overrides |
| `BW_CPS_LIMIT` / `FS_AWARE_OPTIONS` / `TESTING_IP` | 100 / 1 / unset | CPS backstop / healthz drain / SIPp trust (prod: unset) |
| `STIR_SHAKEN_SIGN` / `STIR_CERT_URL` / `STIR_KEY_PATH` | on / x5u URL / key mount | Signing (LIVE) |
| `STIR_SHAKEN_VERIFY` / `STIR_VERIFY_*` | off (DARK) / mode+CA paths | Verify (pending canary) |
| `OPS_AGENT_TOKEN` / `CARRIER_STATUS_URL`+`TOKEN` / `LIVE_TRUNK_STATS_*` | secrets | ops-agent auth + health feeds to API |
| `METRICS_ZONE` / `METRICS_REMOTE_WRITE_HOST` | east / 10.142.0.103 | vmagent labels + write target |

#### Media VMs

| Variable | Example (east-fs-2) | Purpose |
|----------|---------------------|---------|
| `EXTERNAL_SIP_IP` / `EXTERNAL_RTP_IP` | 35.196.226.123 | This VM's OWN public IP (SDP/Via/RTP) |
| `SBC_PROXY_IP` | 10.142.0.250 | Zone signaling ILB VIP (always the active SBC) |
| `SBC_PROXY_IP_FAILOVER` | 10.142.0.100 | SBC-1 direct VPC IP (ILB-bypass fallback) |
| `DB_HOST` / `DB_PORT` | zone replica / 6432 | DID lookups via local PgBouncer |
| `API_HOST` / `HOMER_IP` | East services (all zones) | xml_curl/json_cdr + HEP (writes stay East) |
| `ESL_PASSWORD` | secret | Must match API's `FREESWITCH_ESL_PASSWORD` |
| `FS_NODE_ID` / `HEP_CAPTURE_ID` / `FS_ZONE` | east-fs-2 / 201 / east | Identity, capture, per-zone trunk priority |
| `BRIDGE_PROGRESS_TIMEOUT` | 10 | Per-attempt carrier PDD bound |

#### Services VM

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | `postgresql://api:...@host.docker.internal:6432/voip` (PgBouncer on host; `statement_cache_size=0`) |
| `JWT_SECRET_KEY` | Required — API crashes without it |
| `FREESWITCH_ESL_HOST` / `_PASSWORD` | 192.168.10.2 (East FS-1 — pinned, §12.3) |
| `SBC_PROXY_IP` | ESL-originate routing target |
| `CDR_EXPORT_*` (+`CDR_EXPORT_ENABLED`) | Equinox FTP export (§8.5) |
| `BANDWIDTH_API_*` / `BANDWIDTH_ACCOUNT_ID` / `SIP_PEER_ID` | TN inventory sync |
| `CARRIER_STATUS_TOKEN` / `LIVE_TRUNK_STATS_TOKEN` / `OPS_AGENT_TOKEN` | shared secrets with ops-agents |
| `GF_*` / `GRAFANA_DB_PASSWORD` / `METRICS_DB_PASSWORD` / `PGBOUNCER_STATS_PASSWORD` | Grafana + exporter roles |
| `X5U_DOMAIN` / `X5U_ACME_EMAIL` | x5u compose (fs-cert.granitevoip.com) |

#### DB replica VMs

| Variable | Purpose |
|----------|---------|
| `DB_NODE_ID` / `METRICS_ZONE` | vmagent identity (west-db / central-db) |
| `METRICS_REMOTE_WRITE_HOST` | 10.142.0.103 (East VictoriaMetrics) |
| `METRICS_DB_PASSWORD` / `PGBOUNCER_STATS_PASSWORD` | exporter roles (metrics_ro / pgb_stats) |

---

## 3. Network Architecture

### 3.1 VPC and subnets

Single global VPC `default`; media subnets are dedicated and
**Cloud-NAT-excluded** (see §3.7).

| Subnet | CIDR | Zone | Used by |
|--------|------|------|---------|
| default us-east1 | 10.142.0.0/20 | East | SBCs, services, east-db-standby |
| default us-west1 | 10.138.0.0/20 | West | SBCs, west-db, west-loadtest |
| default us-central1 | 10.128.0.0/20 | Central | SBCs, central-db |
| voip-media | 192.168.10.0/24 | East | fs-media-v2, east-fs-2 |
| voip-media-west | 192.168.20.0/24 | West | west-fs, west-fs-2 |
| voip-media-central | 192.168.30.0/24 | Central | central-fs, central-fs-2 |

### 3.2 External NLB VIPs (carrier inbound)

Regional external passthrough NLBs, one per zone; **failover backends** make
each zone a true active/standby SBC pair (§4.1). Inbound only — FS never
targets these VIPs.

| Zone | VIP | Forwarding rules | Backend / groups | Health check |
|------|-----|------------------|------------------|--------------|
| East | **34.24.133.82** | `sbc-vip-udp` / `sbc-vip-tcp` (:5060) | `sbc-group` (primary) + `east-sbc-standby-group` | `east-sbc-fs-aware-hc` — HTTP :8080 `/healthz`, 5s/2 |
| West | **35.252.214.40** | `west-sbc-vip-udp` / `-tcp` | `west-sbc-backend`: `west-sbc-group` + `west-sbc-standby-group` | `west-sbc-healthz-hc` — HTTP :8080 `/healthz`, 5s/2 |
| Central | **35.253.133.230** | `central-sbc-vip-udp` / `-tcp` | `central-sbc-backend`: `central-sbc-group` + `central-sbc-standby-group` | `central-sbc-fs-aware-hc` — HTTP :8080 `/healthz`, 5s/2 |

Failover policy on all three: `failover-ratio=0`,
`drop-traffic-if-unhealthy`, `no-connection-drain-on-failover`. Detection ≈
10–12s; failback automatic.

### 3.3 Internal signaling ILB VIPs (FS → active SBC)

Per-zone internal passthrough NLBs with the **same** primary/standby groups,
health check, and failover policy as the external VIP — so both traffic planes
flip together. FS targets these (`SBC_PROXY_IP`); the inner Record-Route
renders them, so FS-side in-dialog requests always reach the ACTIVE SBC.

| Zone | Signaling VIP (`SBC_SIGNALING_VIP`) | FS direct-IP fallback (`SBC_PROXY_IP_FAILOVER`) |
|------|-------------------------------------|------------------------------------------------|
| East | 10.142.0.250 | 10.142.0.100 (SBC-1) |
| West | 10.138.0.250 | 10.138.0.100 |
| Central | 10.128.0.250 | 10.128.0.100 |

Passthrough-LB health probes are **VIP-addressed** (dst = the forwarding-rule
IP, sources 209.85.152.0/22 + 209.85.204.0/22 + 35.191.0.0/16) — Kamailio
explicitly binds :8080 on the external VIP and the signaling VIP for exactly
this reason (before those binds, 2026-07→08, the HCs never passed and zones
rode NLB fail-open invisibly). `SBC_SIGNALING_VIP` unset ⇒ byte-identical
legacy per-SBC behavior (rolling-safe).

### 3.4 Static IP reservations

- Per-node external: `{node}-ip` for every VM (e.g. `west-fs-2-ip`), plus
  internal reservations for the FS-2s (`{zone}-fs-2-internal` = 192.168.x.3).
- VIPs: `sbc-vip` (East), `west-sbc-vip`, `central-sbc-vip` + the three
  internal signaling-VIP addresses (.250 per zone).
- **Drift:** `central-db`'s reserved `136.112.210.141` is currently detached
  (§2.3, §12).
- Not yet under OpenTofu state (Phase 5 import pending —
  `infra/OPENTOFU_PLAN.md`).

### 3.5 DNS

| Name | Points at | Purpose |
|------|-----------|---------|
| Cloud DNS geo-routing policy (carrier-facing) | Nearest zone NLB VIP | Bandwidth/Sinch are additionally configured with all 3 VIPs directly (round-robin/distribution) |
| `trunk.granitevoip.com` | Zone VIPs w/ failover | Customer SIP-trunk target; DNS failover rides the fs-aware `/healthz` (OPTIONS-503 drain) |
| `fs-cert.granitevoip.com` | A 34.26.57.37 (services VM) | STIR x5u + trust-bundle endpoint (Caddy :443) |
| `granitevoip.com` | ted LB (Cloud Run FE / GKE BE) | Public site + `/crag` console (§10.2) |

There is deliberately **no global anycast UDP NLB** (GCP global passthrough
NLB doesn't exist for UDP) — per-zone VIPs + carrier-side distribution instead.

### 3.6 Firewall rule inventory (VPC-wide, tag-targeted)

Audited 2026-08 (VoIP VMs are NOT internet-exposed beyond these;
`bypass-vpn` is routing, not firewall).

| Rule | Source | Ports | Target tags / purpose |
|------|--------|-------|----------------------|
| voip-sip-inbound | Bandwidth ranges (67.231.0.0/16, 216.82.224.0/19) | udp/tcp:5060 | voip-sbc — carrier SIP |
| **allow-sinch-sip** | 206.146.100.24, 206.146.101.39, 206.146.98.26, 206.146.100.26 | udp/tcp:5060 | voip-sbc — Sinch orig + term (added 2026-08-31; orig had never worked before it) |
| allow-hc-sbc-healthz | 209.85.152.0/22, 209.85.204.0/22, 35.191.0.0/16 | tcp:8080 | voip-sbc — NLB/ILB fs-aware health checks (VIP-addressed) |
| voip-rtp | 0.0.0.0/0 | udp:16384-49151 | voip-media — carrier/PBX RTP |
| voip-internal | zone subnets + media subnets (tag-to-tag) | tcp/udp/icmp | all voip tags — intra-platform (HEP → East :9060, ESL, DB) |
| voip-pg-replication | replica VM IPs | tcp:5432 | voip-services — streaming replication |
| allow-vmagent-remote-write | West/Central subnets | tcp:8428 | voip-services — metrics remote-write |
| allow-ops-agent | CRAG backend / console hosts | tcp:8710 | voip-* — NOC command API |
| voip-web-admin / UI public | internet (portal) + office CIDRs (admin) | tcp:8080,8443,8088 | voip-services — UI/API |
| x5u public | 0.0.0.0/0 | tcp:80,443 | voip-services — STIR x5u + ACME |
| voip-uptime-sip / voip-uptime-web | GCM uptime prober IPs (managed by `infra/monitoring/main.tf`) | tcp:5060 (VIPs), API/UI ports | uptime checks |
| allow-ssh-iap | 35.235.240.0/20 | tcp:22 | all — SSH via IAP only |

Health-probe reference: `~/.claude` memory + `infra/monitoring/main.tf`;
rule-by-rule ground truth lives in GCP (operator-managed — Claude never
mutates GCP directly).

### 3.7 Cloud NAT exclusion (mandatory for media)

GCP Cloud NAT on the `default` subnet overrides 1:1 external IPs with a NAT
pool IP → carriers drop RTP/SIP (source ≠ SDP). Therefore:

- Every FS VM lives on a dedicated `voip-media-*` subnet **excluded** from the
  Cloud NAT router.
- SBC VMs carry `bypass-vpn` to route directly to the internet.
- **Rule for any new VM that touches SIP/RTP:** Cloud-NAT-excluded subnet OR
  `bypass-vpn` tag. No exceptions. (Root `CLAUDE.md`, "GCP Cloud NAT Breaks
  VoIP".)

### 3.8 Hairpin / loopback binds

- **FS VMs:** `docker/freeswitch/entrypoint.sh` runs
  `ip addr add ${PUBLIC_IP}/32 dev lo` (requires `NET_ADMIN`) — GCE fabric
  cannot hairpin a VM to its own public IP.
- **SBC VMs:** the NLB VIP and signaling VIP are locally bound so Kamailio can
  `listen=` on them (passthrough-LB semantics); this is also what makes the
  VIP-addressed health probes answerable.

---

## 4. SBC Layer (Kamailio)

Config: `docker/kamailio/kamailio.cfg` (env-templated by `entrypoint.sh`) +
`dispatcher.list`. Full internals: `docker/kamailio/CLAUDE.md`.

### 4.1 Active/standby HA (LIVE all zones 2026-08-27)

Each zone's 2 SBCs are a TRUE active/standby pair — **not** active/active.
Enforced entirely by GCP NLB failover backends (no VRRP/keepalived; both SBCs
run identical config; "active" is decided only by health checks):

| Property | Value |
|----------|-------|
| Planes flipping together | External carrier VIP + internal signaling ILB VIP (§3.2/§3.3 share primary group SBC-1, standby group SBC-2) |
| Health check | HTTP :8080 `/healthz` (fs-aware + maint-aware), 5s interval / 2 threshold ⇒ ~10–12s detection |
| Policy | `failover-ratio=0`, `drop-traffic-if-unhealthy`, `no-connection-drain-on-failover`; automatic failback |
| Mid-call survival | Established calls survive a flip — stateless `;fs=` in-dialog dispatch (§4.3) + stateless FS→carrier BYE forward. Setups in flight during the ~6s flip are lost (standard HA semantic). |
| Verified | Planned-failover + kill drills in all 3 zones, 2026-08-27 (`docs/SBC_ACTIVE_STANDBY_RUNBOOK.md`) |
| Side-effects of single-active | `bw_dedup` catches cross-edge duplicates deterministically; `bw_cps`/pike see full zone load; dialog gauges accurate on the active SBC |

### 4.2 Config templating (entrypoint-rendered defines)

`entrypoint.sh` substitutes `__PLACEHOLDER__` tokens at container start.
Key defines (full table: `docker/kamailio/CLAUDE.md`):

| Define | Env var | Default | Purpose |
|--------|---------|---------|---------|
| ADVERTISE_IP | `EXTERNAL_SIP_IP` | (required) | Zone NLB VIP — all advertised headers |
| SBC_INTERNAL_IP | `SBC_INTERNAL_IP` | 127.0.0.1 | This SBC's VPC IP — legacy inner RR, direct listen, `alias=` |
| SIGNALING_VIP | `SBC_SIGNALING_VIP` | (empty ⇒ legacy) | Zone ILB VIP — inner RR + extra listen/alias in HA mode |
| FREESWITCH_IP / FREESWITCH_IP_2 | same | required / empty | Dispatcher group-1 targets (FS-1 / FS-2 HA) |
| FS_PUBLIC_IP | `FS_PUBLIC_IP` | =EXTERNAL_SIP_IP | FS public IP (SDP/RTP target rewrite) |
| BANDWIDTH_IP_1/2 | `BANDWIDTH_PRIMARY_IP`/`SECONDARY_IP` | Dallas / LA | Per-zone nearest-PoP egress (West swaps) |
| BANDWIDTH_TC1_NY/TC1_ATL/TC2_DAL/TC2_LA | same | fixed prod IPs | Fixed-PoP trunks (groups 4–5) |
| SINCH_DENVER_IP / SINCH_CHICAGO_IP | same | 206.146.100.24 / 206.146.101.39 | Sinch origination (groups 6–7) |
| SINCH_LD_IP / SINCH_TF_IP | same | 206.146.98.26 / 206.146.100.26 | Sinch termination trunks (groups 8–9) |
| INTERNAL_SUBNET / MEDIA_SUBNET | same | 10.142.0.0/20 / 192.168.10.0/24 | Per-zone trust CIDRs |
| BW_CPS_LIMIT | same | 100 | Per-carrier-IP inbound CPS backstop |
| FS_AWARE_OPTIONS | same | 1 | `/healthz` 503-when-FS-down drain |
| STIR_SHAKEN_SIGN / _VERIFY | same | off / off | STIR ifdef blocks (§7) — SIGN is **on** in prod, VERIFY dark |
| STIR_CERT_URL / STIR_KEY_PATH / STIR_VERIFY_* | same | — | x5u URL, key mount, CertVerify mode + CA/CRL paths |
| HEP_CAPTURE_ID / SBC_ID / HOMER_IP / DB_* | same | per §2 | Capture, identity, Homer, trunk-auth SQL |

### 4.3 Record-Route + stateless in-dialog dispatch (pointer)

Both legs get double Record-Route (`enable_double_rr=1`) with an `;fs=`
profile-port marker (5080 A-leg / 5090 B-leg); the inner entry renders the
signaling VIP in HA mode. Carrier-originated in-dialog requests **never** run
`loose_route()` — `route[WITHINDIALOG]` intercepts R-URI==self requests and
dispatches straight to FS using the echoed `;fs=` marker, so ANY SBC routes
ANY carrier in-dialog request with zero dialog state.

**Do not re-derive this design from scratch.** The complete mechanism, the
5.8-source root-cause analysis (`after_strict()` on R-URI==VIP), and the
history of failed rr-based approaches are in
**`docker/kamailio/CLAUDE.md` §8.10** (summary in root `CLAUDE.md`,
"Double Record-Route + Stateless In-Dialog Dispatch").

### 4.4 Dispatcher groups (`docker/kamailio/dispatcher.list`)

| Group | Destination(s) | Purpose |
|-------|----------------|---------|
| 1 | FS-1 `__FS_IP__:5080` prio 10 + FS-2 `__FS_IP_2__:5080` prio 5 (line rendered only in FS-HA mode) | FreeSWITCH selection — **alg 8 (serial/priority)**: FS-1 strictly first while up. Single-FS zones: byte-identical single line. |
| 2 | 67.231.2.12 (BW TC4 Dallas) | Keepalive/health only — routing uses direct `$du` in TO_CARRIER |
| 3 | 216.82.238.134 (BW TC4 LA) | Keepalive/health only |
| 4 | 67.231.9.142 (BW TC1 NY), 67.231.13.185 (BW TC1 ATL) | Keepalive/health only (fixed-PoP trunk) |
| 5 | 67.231.1.188 (BW TC2 DAL), 67.231.4.138 (BW TC2 LA) | Keepalive/health only (fixed-PoP trunk) |
| 6 | Sinch Denver 206.146.100.24 (TG DNVTCOZIGR2_3278) | Origination keepalive — **VIP-sourced probes** (`socket=udp:VIP:5060` + `ping_from=sip:ping@VIP`) |
| 7 | Sinch Chicago 206.146.101.39 (TG CHCGIL24GR4_7412) | Origination keepalive — VIP-sourced probes |
| 8 | Sinch Atlanta-LD 206.146.98.26 (TG ATLNGAQSGR2_7214) | Termination trunk health (table-driven egress, §5.5) |
| 9 | Sinch Denver-TF 206.146.100.26 (TG DNVTCOZIGR2_3282) | Termination trunk health (8YY toll-free only) |

Probing: `ds_ping_interval=5`, `ds_probing_mode=1`, thresholds 3/3.
`ds_ping_reply_codes = class=2 + 404 + 405 + 480 + **500**` — Sinch answers
OPTIONS on origination TGs with 500 **as standard**, so 500 counts as alive
(added 2026-09-02). Because groups 6/7 probes are VIP-sourced, **standby SBCs
legitimately show those destinations Inactive** (probe replies land on the
active VIP holder) — health semantics are "up on ≥1 SBC" by design.
Priority semantics (verified vs Kamailio 5.8 source): **higher number = tried
first** by alg 8; never rely on file order.

Kamailio 5.8 gotcha: `event_route[dispatcher:dst-up|dst-down]` must read
`$ru`, not `$du` (see `docs/FS_MEDIA_HA_RUNBOOK.md`).

### 4.5 Rate limiting, security, and state (htables)

| htable | Key | Autoexpire | Purpose |
|--------|-----|-----------|---------|
| blocked | IP | 300s | Blocklist (pike overflow etc.) |
| failedauth | IP | 3600s | Scanner detection feed |
| ipreputation | IP | 86400s | Reputation counters (>10 ⇒ blocked) |
| ipcalls | IP | 60s | OPTIONS-flood detection |
| bw_dedup | FromUser::ToUser | 3s | Carrier duplicate-INVITE dedup → 482 Merged (deliberately source-independent — shared by Bandwidth and Sinch) |
| bw_cps | source IP | 1s fixed window (`updateexpire=0`) | Per-carrier-IP CPS backstop (`BW_CPS_LIMIT`, default 100) → 503 + Retry-After |
| trunk_cps | trunk | 1s fixed window | Per-customer-trunk CPS |
| carrier_cps | carrier::pop | 1s fixed window | Per-DB-carrier CPS (from `carrier_trunks.cps_limit`) |
| maint | `drain` | **3600s (dead-man)** | Maintenance drain flag (§4.6) |
| dsmon / fshealth | — | 0 (never) | Dispatcher/FS health state for `/healthz` + metrics |

Plus pike (per-IP request-rate), scanner-UA gates, and per-INVITE
`route[CARRIER_TRUST]` DB auth for runtime-added carriers (fail-closed for
DB-only carriers; static Bandwidth/Sinch unaffected).

### 4.6 Maintenance drain plane (LIVE 2026-09-03/04)

The dead-man switch lives **in the SBC**, not in tooling:

| Element | Behavior |
|---------|----------|
| `maint` htable | `kamcmd htable.seti maint drain 1` (drain) / `htable.delete maint drain` (restore). `autoexpire=3600` ⇒ a forgotten drain **self-clears at the SBC after 1 hour**; a Kamailio restart also clears it. |
| `/healthz` while drained | 503 body `DRAINING maint=1` — BEFORE any FS-health logic → both NLB planes drain this SBC in ~10–12s; never reported to carriers/DNS as a dead zone |
| Metrics | `kamailio_maint_drain` gauge (display-only mirror of the flag) + `fs_dispatcher_disabled{fs_ip}` from the :9104 exporter |
| Agent verbs | `sbc.drain` / `sbc.restore` (mutating, step-up) / `sbc.drain_status` (read: `drain=<0\|1> healthz=<status>` with a REAL local healthz GET) — `docker/carrier-monitor/ops_commands.py` |
| FS drain | `kamcmd ds_set_state d` on the group-1 destination (**Disabled** — probing never re-activates it; **no dead-man**, restore is explicit) via `fs.drain`/`fs.restore` |
| Zone dark | = both SBCs drained (typed zone confirmation required in CRAG) |
| CRAG Maintenance tool | Step-up password re-auth, dangerous tier, typed zone confirm for zone ops, ground-truth verification loop ≤20s (§10.4) |
| Grafana | MAINT renders as yellow 3-state (UP/DOWN/MAINT) on server boxes + election rows; a drained node can never claim ACTIVE |

### 4.7 `/healthz` semantics (xhttp, :8080)

Priority order: `maint=>drain` set ⇒ **503 DRAINING maint=1**; else FS group-1
all-down (`fshealth` htable, maintained authoritatively by dispatcher
dst-up/dst-down event routes) ⇒ **503** (fs-aware drain, `FS_AWARE_OPTIONS=1`
default); else **200**. Any-FS semantics: healthy if ≥1 of FS-1/FS-2 is up.
This one endpoint drives: external NLB, signaling ILB, DNS trunk failover, and
the maintenance plane.

### 4.8 Key modparams (selected — timers and dialog behavior)

| Module | Param | Value | Why |
|--------|-------|-------|-----|
| tm | fr_timer | 30000 ms | Non-INVITE response timeout |
| tm | fr_inv_timer | 120000 ms | INVITE timeout (ring up to 120s) |
| tm | retr_timer1 / retr_timer2 | 500 / 4000 ms | SIP retransmit schedule |
| tm | pass_provisional_replies / auto_inv_100 | 1 / 1 | 183 early media passthrough; auto 100 Trying |
| rr | enable_full_lr / enable_double_rr / append_fromtag | 1 / 1 / 1 | Loose routing + double RR (§4.3) |
| dialog | dlg_match_mode | 1 | SIP-element fallback matching — required for the `$dlg_var(fs_port)` owner fallback in TO_FS_INDIALOG |
| dialog | timeout | 12h | Reap dialogs that never got a BYE |
| pike | sampling + PIKE_THRESHOLD / PIKE_TIMEOUT | 1s window, 50 req/s, 300s block | Per-IP flood gate (env-tunable) |
| dispatcher | ds_ping_interval / probing / thresholds | 5s / mode 1 / 3+3 | §4.4 — also keeps GCE UDP pinholes open |
| dispatcher | ds_ping_reply_codes | 2xx, 404, 405, 480, 500 | 500 = Sinch orig OPTIONS standard answer |
| secsipid | (STIR block) | §7 | Identity sign/verify config, ifdef-gated |

Header-handling invariants that have caused production outages when violated
(full list in root `CLAUDE.md` "SIP Header Handling"):
`record_route()` AFTER `msg_apply_changes()`; Contact added BEFORE it;
`subst()` cannot fix Via corruption; NAT detection never applies to FS
traffic; `topoh` module stays disabled (manual topology hiding only).

---

## 5. Media Layer (FreeSWITCH)

Config: `docker/freeswitch/conf/` (sofia profiles, modules) +
`docker/freeswitch/scripts/` (Lua routing). Component docs:
`docker/freeswitch/CLAUDE.md`.

### 5.1 FS media HA — strict active/standby (LIVE all zones 2026-08-31)

| Property | Value |
|----------|-------|
| Model | FS-2 per zone runs **fully hot** (sofia up, DB connected, metrics flowing) but receives ZERO new calls while FS-1 is healthy. Enforced at the SIP layer by dispatcher group 1 — **no load balancer**. |
| Selection | `ds_select_dst` alg 8 on priority: FS-1 prio 10, FS-2 prio 5; automatic failback when FS-1 recovers |
| Per-call identity | `;fsn=1/2` marker stamped at selection time so in-dialog requests reach the FS that owns the call even across an SBC flip |
| Health | Kamailio OPTIONS probes both; `/healthz` is **any-FS** (zone healthy if either FS up) |
| Drilled | All 3 zones 2026-08-31 (`docs/FS_MEDIA_HA_RUNBOOK.md` — deploy, drills, caveats) |
| Known gap | **ESL/API originates still pin to FS-1** (`FREESWITCH_ESL_HOST` = fs-media-v2): East FS-1 down ⇒ `POST /v1/calls` fails while inbound RCF rides FS-2. Open item (§12). |
| Watchdog | `revup-fs-watchdog.timer` on every media VM pages (via `revup-alert` syslog → GCM) on container death / FS unresponsiveness |

### 5.2 Sofia profiles

| Profile | Port | Direction | Key settings |
|---------|------|-----------|--------------|
| internal | 5080 | Inbound from Kamailio | `ext-rtp-ip`/`ext-sip-ip` = VM public IP; `local-network-acl=loopback.auto`; session-timer 1800 / Min-SE 90; `rtp-keepalive-sec` comfort packets vs GCE 30s UDP idle timeout |
| external | 5090 | Outbound B-legs | Same, plus applies `ext-sip-ip` to outbound Via/Contact — the reason two profiles are required |

Never use `-nonat`; never remove `local-network-acl=loopback.auto` (root
`CLAUDE.md` gotchas #7–#9). Media is default relay — **no** `proxy_media`,
**no** `sip_enable_soa=false` on the RCF path.

### 5.3 Inbound routing pipeline (`scripts/inbound_router.lua`)

1. Anti-fraud early rejects (empty/injected/non-digit/>20-digit destinations).
2. Special numbers (9195–9198 echo/tone/milliwatt).
3. Branch: API outbound (`api_outbound.lua`, tier-aware CPS) / trunk outbound
   (`trunk_outbound.lua`) / inbound DID.
4. DID lookup on the **zone-local** PG replica via PgBouncer (`db_client.lua`).
   Redis is intentionally **removed** from the RCF path (mod_lua threading vs
   redis-lua pooling); trunk/API paths still use Redis fail-open.
5. **On-net check** (§5.4) — platform-owned destination ⇒ internal delivery.
6. Off-net: table-driven termination attempt list (§5.5), bridged as
   `sofia/external/dest@SBC_PROXY_IP:5060` with `X-Carrier`/`X-Carrier-IP`
   headers; TCP pre-check of the SBC (cached 30s up / 10s down) then up to 4
   attempts; `progress_timeout` bounds carrier PDD
   (`BRIDGE_PROGRESS_TIMEOUT`, default 10s — deliberately not
   `originate_timeout`).
7. Lua-handled failures reply 503 (not 404); `lua_routed=true` prevents
   dialplan 404 masking.

CDR channel vars flowing to ingest: `product_type`, `customer_id`,
`direction`, `sbc_id`, `inbound_carrier`/`inbound_carrier_pop` (from
Kamailio's spoof-proofed `X-Inbound-Carrier/PoP`), on-net attribution vars.

### 5.4 On-net (internal) routing — LIVE

Design doc: `docs/ONNET_ROUTING_DESIGN.md`; summary in root `CLAUDE.md`.

- **Oracle:** `number_routing` view (`22_number_routing.sql`) — one indexed
  point lookup via `resolve_destination(did)`; unfiltered so "not ours" (0
  rows ⇒ carrier path) is distinct from "ours but disabled" (hard reject 603).
- **Chain resolution in memory** (RCF→RCF→…): DB lookups only, no SIP per hop;
  exactly one carrier B-leg at most; loop/hops>5 ⇒ 483.
- **Terminators:** `terminate_rcf` / `terminate_api` / `terminate_trunk` via a
  `TERMINATORS` dispatch map — any product's DID can be an on-net terminal;
  new products enroll with a view arm + a terminator.
- **Billing:** single CDR carries both parties (`origin_customer_id`,
  `terminating_customer_id`, `on_net`, `on_net_hops` —
  `23_onnet_cdr_columns.sql`); `customer_id` = terminal so rating is
  unchanged.
- **Caller-ID:** per-DID `pass_caller_id` composed across the chain — last
  `false` hop wins; outbound From stays the terminal DID for carrier auth.

### 5.5 Table-driven termination (multi-carrier egress) — LIVE

Termination is driven by the **`carrier_trunks`** table (migrations 40/42/44),
not code:

| Column | Role |
|--------|------|
| `carrier`, `pop`, `source_ip` | Identity + egress target (`X-Carrier-IP`) |
| `direction` | `inbound`/`outbound`/`both` — termination reads `outbound`/`both` |
| `priority` + `priority_east/west/central` | Per-zone attempt order (`COALESCE(priority_<zone>, priority)`); Bandwidth 10/20, Sinch backups 30/40 |
| `traffic_class` | `any` / `ld` / `tollfree` — Sinch Denver-TF is 8YY-only |
| `cps_limit`, `enabled` | Per-trunk CPS (Kamailio `carrier_cps`) and rotation membership |

FS builds the zone's priority-ordered attempt list per call with a **~60s
cache** (plus a 60s table-unavailable fallback). Disabling a trunk in CRAG
takes it out of rotation in ~60s — **no redeploy**. The `carrier_gateways`
table ("carrier gateway cards") is **display metadata only** — zero call-path
consumers, read-only in CRAG, managed via migrations (§6.4).

### 5.6 CDR emission

`mod_json_cdr` POSTs to `POST /v1/cdrs/ingest`, which **always returns 200**
(retry-storm prevention; errors handled internally). All INSERT params use
explicit `::type` casts (asyncpg + PgBouncer transaction mode). RTP quality
stats (jitter variance→ms fix: migration 43) ride along.

### 5.7 Redis (per media VM)

Zone-local ephemeral cache (`127.0.0.1:6379`): trunk config, channel counting,
CPS sorted-sets, velocity — trunk/API paths only (fail-open to PG). No
persistence, `maxmemory`+LRU, dangerous commands renamed. Not on the RCF path
(see §5.3).

### 5.8 Capacity posture

| Dimension | Sizing basis |
|-----------|--------------|
| Per-zone target | ~500 CPS sustained / several thousand concurrent RCF calls (Erlang B: 10K concurrent at 3-min ACD ≈ 55 CPS steady; burst 5–10×) |
| FS (e2-standard-8) | RCF is default-media G.711 relay, no transcoding — ~2–3 MB/channel; 32K RTP ports; upgrade trigger ≈ 8K concurrent |
| SBC (e2/n2-standard-4) | Signaling-only; headroom well past target CPS; `children=32` |
| Growth trigger | Capacity review at 70% of rated peak (weekly CPS/concurrent trend on the Traffic Status board) |
| Load harness | Banked SIPp rig on `west-loadtest` (re-enable via `TESTING_IP` on the target zone only — never in steady-state prod) |

---

## 6. Carrier Integrations

### 6.1 Bandwidth (origination + termination)

| Item | Value |
|------|-------|
| Account / SIP peer | 9900717 / 1162116 (client CLI-8cab93d7-e797-4d7d-8717-45aa430c7185) |
| TC4 PoPs (default trunk) | Dallas **67.231.2.12** (primary East/Central), LA **216.82.238.134** (primary West — swap via `BANDWIDTH_PRIMARY/SECONDARY_IP`) |
| TC1 PoPs | NY 67.231.9.142, ATL 67.231.13.185 (group 4) |
| TC2 PoPs | DAL 67.231.1.188, LA 67.231.4.138 (group 5) |
| Inbound distribution | Bandwidth points at all 3 zone VIPs (currently distributing) |
| Duplicate INVITEs | Same call from multiple edge proxies ⇒ `bw_dedup` (From::To, 3s) → 482 Merged |
| 422 handling | Retry with Session-Expires 3600 / Min-SE 900 |
| Session timers | Carrier Session-Expires normalized to 1800 in REPLY_HANDLER (Bandwidth sends sub-RFC4028 values FS silently ignores) |
| 5xx failover | 500/503/408/480/404 from primary PoP ⇒ retry alternate PoP (flag 8 loop guard) |
| Termination rows | `carrier_trunks` priorities 10 (primary PoP) / 20 (secondary) |
| Egress selection | FS `X-Carrier` (primary/secondary/tc1/tc2/tc4) + `X-Carrier-IP` for table-driven rows |

### 6.2 Sinch (origination live + backup termination)

| Item | Value |
|------|-------|
| Origination PoPs | Denver **206.146.100.24** (TG `DNVTCOZIGR2_3278`, test TN 5305480845), Chicago **206.146.101.39** (TG `CHCGIL24GR4_7412`, test TN 5305480846) — round-robin to all 3 zone VIPs |
| Termination trunks | Atlanta-LD **206.146.98.26** (TG `ATLNGAQSGR2_7214`, `traffic_class=ld`, prio 30), Denver-TF **206.146.100.26** (TG `DNVTCOZIGR2_3282`, `traffic_class=tollfree` — **8YY only**, prio 40). Backup priorities behind Bandwidth's 10/20. Migration 44. |
| Firewall | `allow-sinch-sip` — all 4 IPs → voip-sbc :5060 (added 2026-08-31; before it, origination had never actually worked) |
| OPTIONS behavior | Sinch answers OPTIONS on orig TGs with **500 as standard** ⇒ 500 is in `ds_ping_reply_codes` |
| Probe sourcing | Groups 6/7 probes are **VIP-sourced** (`socket=`/`ping_from=` attrs — Sinch registers the TGs against VIPs, not SBC IPs) ⇒ standby SBCs read them Inactive **by design**; health = up-on-≥1-SBC |
| Dedup / CPS | Shares carrier-generic `bw_dedup` + per-source-IP `bw_cps` — no Sinch-specific plumbing |
| Attribution | Kamailio stamps spoof-proofed `X-Inbound-Carrier: sinch` + `X-Inbound-PoP` (wire copies stripped first) → CDR `inbound_carrier`/`inbound_carrier_pop`; both headers stripped again before any B-leg egress |
| Egress of Sinch-originated calls | `X-Inbound-TC: tc4` — forwarded legs terminate via Bandwidth's default trunk (no Sinch outbound preference for them) |
| Pending | Termination sign-off matrix with PCAPs to Sinch (2 trunks × 6 SBC IPs; beware silent Bandwidth fallback) — §12 |

### 6.3 Runtime carrier admission (`carrier_trunks` inbound)

Carriers beyond the static pair can be admitted **without redeploy**: unknown
source IPs are authenticated per-INVITE in `route[CARRIER_TRUST]` (after the
same pike/scanner gates as trunk auth), rate-limited by the row's
`cps_limit` (`carrier_cps` htable), and attributed from the row. Fail-closed:
DB down ⇒ DB-only carriers rejected, static carriers unaffected.

### 6.4 Carrier gateway cards

`carrier_gateways` (migrations 08/46) = **display metadata only** for the
CRAG Carriers panel. Zero call-path consumers; read-only in CRAG; changes via
migrations.

---

## 7. STIR/SHAKEN

Plan: `docs/STIR_SHAKEN_IMPLEMENTATION_PLAN.md`. x5u hosting:
`docs/STIR_X5U_HOSTING_PLAN.md`. Trust pipeline:
`docs/STIR_TRUST_BUNDLE_RUNBOOK.md`.

### 7.1 Signing — LIVE on all 6 SBCs

On-switch signing at Kamailio via `secsipid` (ifdef `STIR_SHAKEN_SIGN`, on in
prod):

| Call class | Attestation |
|------------|-------------|
| Trunk / API originated | **A** (full attestation) |
| RCF forwarded legs | **`div` PASSporT chaining** — preserves the inbound attestation across the forward (confirmed downstream: T-Mobile renders A→div) |
| Unsigned inbound being forwarded | **C** policy |

Private key is a runtime secret mount (never in image/git); `STIR_KEY_PATH`.

### 7.2 Certificate + x5u endpoint

| Item | Value |
|------|-------|
| STI-CA | **Neustar/TruContact** (issuance only — NO runtime Neustar calls) |
| Chain | SHAKEN leaf (SPC **8052**) → Neustar CA-2 → Root; issued 2026-08 |
| Leaf expiry | **2027-05-08** — renew ~**2027-04-01** |
| x5u URL | `https://fs-cert.granitevoip.com/stir/8052-2026.pem` (leaf + CA-2) |
| Hosting | Isolated Caddy sidecar on `services` (`docker-compose.x5u.yml`, own network/volumes, Let's Encrypt via :80 ACME). **NEVER `--remove-orphans`** on this compose — it would delete the services stack. |
| Rotation | New PEM in `infra/stir/` → new `/stir/8052-2027.pem` path in the Caddyfile → update `STIR_CERT_URL` on SBCs → retire old path after notAfter |

### 7.3 STI-PA trust pipeline — LIVE

Daily/monthly ingestion of the STI-PA trusted-CA list for own-crypto inbound
verification:

```
STI-PA download (sticaList.jwt + stipaCrl.crl)
  → services VM: refresh-stir-trust-bundle.sh — JWT gates J1–J3, PEM gates G1–G5
  → atomic install /var/lib/stir/ (+ dated archive incl. raw .jwt)
  → published by x5u Caddy: /stir/sti-pa-trust-bundle.pem (+ /stir/sti-pa-crl.pem)
  → each SBC (cron): refresh-sbc-trust-bundle.sh (same gates)
      → /opt/revup/secrets/stir-ca/{sti-pa-trust-bundle.pem, sti-pa-crl.pem}
  → Kamailio secsipid CertCAFile (CertVerify mode 5) — when verify goes live
```

Watchdog: `TB_MAX_BUNDLE_AGE_DAYS=40` — a bundle older than 40 days (monthly
cadence + slack) pages via the node-exporter textfile metrics
(`/var/lib/stir/metrics`). Selftests: `trust_bundle_selftest.sh` (35 synthetic
+ 3 real-artifact checks), `verify_selftest.sh`. Proven E2E with real STI-PA
artifacts 2026-08-28.

### 7.4 Inbound verification — deployed DARK

Own-crypto verify (`secsipid_check_identity`, ifdef `STIR_SHAKEN_VERIFY`) is
**deployed but off** pending the §6 canary (per the implementation plan). It
is fail-open (records verstat, never rejects). **Today's inbound
attest/verstat comes from Bandwidth headers** (`P-Attestation-Indicator` +
PAI `verstat`), consumed in `kamailio.cfg` (~line 1479).

### 7.5 Attestation observability

- Migrations 32/33: `call_attestations` (+ Call-ID index) — per-call
  attestation records incl. div chains.
- revup UI: trace-search, call-detail attestation panel, admin view.
- Grafana: STIR/SHAKEN NOC board (sign/verify rates, cert-expiry countdown,
  trust-bundle tiles).

---

## 8. Data Layer

### 8.1 Topology + replication map

PostgreSQL 16 + TimescaleDB. **All writes go to the East primary via the
API**; every zone reads DID lookups from its local replica through local
PgBouncer (:6432, scram, transaction mode — `statement_cache_size=0`).

```
services (East primary, 10.142.0.103)
  ├─ slot east_standby    → east-db-standby (10.142.0.87, us-east1-c — HA standby)
  ├─ slot west_standby    → west-db        (10.138.0.2)
  └─ slot central_standby → central-db     (10.128.0.2)
```

The `sandbox_replica` slot (legacy fs-media 10.142.0.102 sandbox) is
**ABSENT** from the primary — sandbox replica status unknown, open item (§12).
Slot/WAL growth is guarded by `revup-slot-wal-guard.timer`; lag by
`revup-replication-guard.timer` (pages via `revup-alert`).

Failover/restore procedures: `docs/runbooks/DB_FAILOVER_RUNBOOK.md`,
`docs/runbooks/DB_RESTORE_RUNBOOK.md` (proven in a real recovery — a prod
data-dir wipe was recovered with zero loss;
`docs/runbooks/PHASE0_SAFETY_NET_RUNBOOK.md`).

### 8.2 Services VM PG tuning (32 GB)

`services` is e2-highmem-4 (32 GB) since 2026-09-02. Tuning via conf.d
drop-in `90-revup-32gb`: `shared_buffers=8GB`, `effective_cache_size=20GB`,
`work_mem=32MB` (+ container memory budget per
`docs/SERVICES_VM_32GB_TUNING.md`; applier
`scripts/services-tuning/apply_pg_32gb.sh`, inspector `show_pg_tuning.sh`).

### 8.3 Migrations index (`docker/postgres/init/`, 01→46)

Init scripts run only on first initdb; on prod they're applied on the primary
(`sudo -u postgres psql -d voip -f ...`) and replicate everywhere.

| # | File | Purpose |
|---|------|---------|
| 01 | 01_extensions.sql | timescaledb, pgcrypto, inet |
| 02 | 02_schema_core.sql | customers, users, DB roles |
| 03 | 03_schema_api.sql | API Calling tables (api_dids, credentials) |
| 04 | 04_schema_fraud.sql | fraud prefixes, velocity |
| 05 | 05_schema_cdr.sql | CDR hypertable (retention, RTP quality) |
| 06 | 06_seed_data.sql | rate tables baseline |
| 07 | 07_cps_tiers.sql | CPS tiers + call-path packages |
| 08 | 08_carrier_gateways.sql | carrier gateway display cards |
| 09 | 09_schema_users.sql | JWT users + roles |
| 11a | 11a_schema_did_assignment.sql | DID→extension (UCaaS scope, unused here) |
| 14 | 14_granite_accounts.sql | Granite seed customer |
| 16 | 16_cdr_detail_columns.sql | CDR QoS/RTP column expansion |
| 17 | 17_did_inventory.sql | DID inventory (Bandwidth sync + manual) |
| 18 | 18_sbc_id_column.sql | cdrs.sbc_id (per-SBC attribution) |
| 19 | 19_onboarding_requests.sql | onboarding intake queue |
| 20 | 20_rcf_max_channels.sql | RCF per-DID concurrency cap |
| 21 | 21_cdr_export.sql | CDR export watermark/state |
| 22 | 22_number_routing.sql | **on-net oracle view** |
| 23 | 23_onnet_cdr_columns.sql | on-net CDR attribution columns |
| 24 | 24_grafana_ro.sql | Grafana read-only PG role |
| 25 | 25_carrier_trunk_status.sql | carrier trunk health snapshots |
| 26 | 26_live_trunk_stats.sql | live per-trunk stats feed |
| 27 | 27_onboarding_simplify.sql | onboarding status-only schema |
| 28 | 28_tiers_reprice.sql | tier repricing |
| 29 | 29_tiers_cps_reprice.sql | CPS-specific repricing |
| 30 | 30_schema_ivr.sql | IVR flow schema (Phase 2, dormant) |
| 31 | 31_did_canonicalize.sql | E.164 normalization |
| 32 | 32_call_attestations.sql | STIR attestation tracking |
| 33 | 33_call_attestation_sip_callid.sql | attestation Call-ID index |
| 34 | 34_release_requested_status.sql | DID release workflow |
| 35 | 35_onboarding_kyc.sql | FCC KYC capture |
| 36 | 36_onboarding_products.sql | per-product onboarding intake |
| 37 | 37_payments_ledger.sql | payments demo ledger (dormant) |
| 38 | 38_payments_demo.sql | payments demo config (dormant) |
| 39 | 39_users_support_role.sql | support role separation |
| 40 | 40_carrier_trunks.sql | **multi-carrier trunk registry** (trust + egress contract) |
| 41 | 41_did_carrier_source.sql | DID→carrier attribution |
| 42 | 42_carrier_priorities.sql | per-zone trunk priority overrides |
| 43 | 43_jitter_units_backfill.sql | jitter variance→ms fix + backfill |
| 44 | 44_sinch_termination.sql | Sinch term trunks (ATL-LD, DEN-TF) + traffic_class |
| 45 | 45_orig_trunk_passive_health.sql | origination-trunk passive health |
| 46 | 46_sinch_carrier_gateways.sql | Sinch gateway display cards |

### 8.4 CDR pipeline

```
FS mod_json_cdr → POST /v1/cdrs/ingest (always-200) → cdrs hypertable (East primary)
  columns incl.: sbc_id, inbound_carrier/pop, on_net attribution, RTP quality (MOS/jitter/loss)
```

Billing model on this branch: **estimates only** — CDRs flow to Equinox for
rating; the UI shows read-only estimated bills. No ledger on RCF-V1.

### 8.5 CDR export (Equinox) — flag-gated, LIVE-capable

Dedicated `voip-cdr-exporter` container (services VM):

| Setting | Value |
|---------|-------|
| Transport | FTP to FileMage `10.142.0.71` (→ Equinox); `CDR_EXPORT_ENABLED` gate (default false) |
| Format | Full-column CSV **including quality columns** (decision 2026-09-04: keep full) |
| Watermark | `exported_at` stamp — advance only on successful upload |
| Cadence / batching | interval 3600s, batch 5000, freshness lag 120s, lock TTL 900s (all env-tunable, `docker-compose.services.yml`) |

### 8.6 Backups (pointer)

On the primary → `gs://revup-db-backups`: pgBackRest full+diff with WAL PITR
(`revup-pgbackrest-*.timer`), nightly pg_dump (`revup-pgdump.timer`), monthly
CDR archive (`revup-cdr-archive.timer`), disk snapshots. Guards:
`asr_guard`, `replication_guard`, `slot_wal_guard`. Setup + restore drill:
`scripts/backup/README.md`, `docs/runbooks/DB_RESTORE_RUNBOOK.md`.

---

## 9. Observability

Plan/rationale: `docs/OBSERVABILITY_METRICS_PLAN.md`. SLOs:
`infra/monitoring/SLOS.md`.

### 9.1 Metrics plane

Per-VM `vmagent` → remote-write → East VictoriaMetrics `:8428`
(**12-month retention**, 2 GB disk buffer per agent survives outages).

| Role | Scrape config | Jobs |
|------|---------------|------|
| SBC | `docker/vmagent/scrape-sbc.yml` | kamailio :8080 `/metrics` (xhttp_prom), node :9100, fsdisp :9104 |
| Media | `scrape-media.yml` | node :9100, esl-exporter :9103 |
| DB replica | `scrape-db.yml` | node :9100, postgres-exporter :9187 (`db_role=replica`), pgbouncer-exporter :9127 |
| Services | `scrape-services.yml` | api :8000, postgres-exporter :9187, pgbouncer-exporter :9127, blackbox :9115, node :9100 (+ STIR textfile metrics), heplify :9096 |

Key Kamailio-exported series: INVITE reply-class counters (ASR), dialog
gauges, `kamailio_maint_drain`, dispatcher/carrier state, STIR sign counters.

### 9.2 Recording rules (vmalert, 30s eval)

`docker/vmalert/rules/`: `traffic.yml` (zone reply-class rates → live ASR /
failure %), `sip_health.yml`, `stir.yml`.

### 9.3 Grafana NOC boards (`docker/homer/grafana/dashboards/`)

7 boards, anonymous-view behind the nginx `/grafana/` proxy; default home =
NOC Home.

| Board | Content |
|-------|---------|
| `noc/noc-home.json` | **Map-first command center** — US geomap with custom rack/tower icons, per-server 3-state boxes (UP/DOWN/**MAINT** yellow), traffic/voice/STIR KPI rows; exactly 29 grid rows |
| `noc/traffic-status.json` | Live ASR/failure by zone, reply-class trends, **maint-aware Active-SBC + Active-FS election rows** (a drained node can never claim ACTIVE), CPS per SBC |
| `noc/call-quality.json` | TV-tiered MOS/jitter/loss/R-factor |
| `noc/db-replication.json` | Lag per replica, slot status, LSN |
| `noc/infra-overview.json` | Per-VM CPU/mem/disk/net, container uptime |
| `noc/stir-shaken.json` | Sign rates, cert-expiry countdown, trust-bundle tiles |
| `homer/sip-search.json` | qryn/ClickHouse SIP search (deep-link target from Troubleshooting) |

### 9.4 GCM alerting inventory (`infra/monitoring/*.tf` — Phase A, LIVE)

Notification channels: ops email + Slack/PagerDuty + SMS. Policies:

| Policy | Trigger |
|--------|---------|
| SIP VIP uptime × 3 (East/West/Central) — **CRITICAL** | GCM uptime check TCP :5060 against each NLB VIP fails |
| API `/health` uptime, UI https uptime | services endpoints down |
| vm-down | instance metrics absent — covers the 16 monitored instances |
| Disk / memory / CPU | per-VM resource thresholds |
| SBC failover state × 6 (`sbc_failover.tf`) | log-based: per-zone primary-UNHEALTHY (zone on standby) + standby-UNHEALTHY (redundancy degraded) |
| `revup-alert` syslog hook | ANY on-VM script/unit can page by emitting one tagged syslog line — used by fs-watchdog (container death), backup guards, replication/slot guards |

(`zz_test_alert.tf` is a throwaway pipeline test — delete before it drifts
into permanence; untracked in git.)

### 9.5 HEP / Homer

All zones' SBCs + FS send HEP to East heplify-server `10.142.0.103:9060`
(capture-ID scheme §2.4) → qryn/ClickHouse. IP→name aliases:
`docker/homer/scripts/ip-alias.lua` (covers all zones + carriers + FS-2s —
add new nodes there). Primary SIP-debug UI is the native **Troubleshooting**
page (React → `POST /api/homer/search` → qryn LogQL + ClickHouse), Grafana
sip-search is the deep-link secondary.

### 9.6 PCAP export

Troubleshooting page exports per-call PCAPs with a canonical packet-path
ladder; default is **edge-only** (carrier-facing legs) with a "Show internal"
toggle for the full SBC↔FS path.

### 9.7 Health checks summary (who watches what)

| Layer | Mechanism |
|-------|-----------|
| Carrier → zone | NLB fs-aware HTTP HC (10–12s) + Bandwidth/Sinch OPTIONS |
| SBC → FS | dispatcher OPTIONS probes (5s, thresholds 3/3) |
| FS → SBC | TCP pre-check before bridge (cached 30s/10s) |
| Container level | compose healthchecks (§2.5) + fs-watchdog pages |
| Cross-zone | GCM uptime checks + vm-down + Grafana election rows |
| DB | replication/slot guards + postgres-exporter lag metrics; east-db-standby via SQL only |

---

## 10. Admin & Operations Planes

### 10.1 revup UI (`docker/ui`, served at services :8080/:8443)

React SPA; roles admin / **support** (read-heavy, migration 39) / customer.
Key surfaces:

| Area | Notes |
|------|-------|
| Calls & Quality (merged page) | Platform CDR search + quality — carrier columns (inbound carrier/PoP), detail modal, cursor paging |
| Troubleshooting | Full-width redesign; zone/orig/term columns; canonical packet-path SIP ladder; PCAP export (edge-only default + "Show internal") |
| Admin → Customer Mgmt | onboarding queue (KYC), customers, customer-360, trunks, users |
| Admin → Platform Mgmt | carriers (read-only gateway cards), carrier-trunks, CDRs, rates, tiers, SIPp, DID search, STIR views |
| Customer product pages | RCF CRUD; trunk/API pages; RCF customers never see UCaaS features |

Type-check gate: `npx tsc -b --force` (never `--noEmit` — solution config
makes it a false pass). Layout rule: hand-written `@media` in `index.css` for
load-bearing layout, not `md:*` utilities. Design system: Daylight (white
console on dark collapsible sidebar, `dl-*`/`rcf-*` shared classes).

Sidebar visibility is `account_type`-scoped (rcf sees RCF only; trunk sees SIP
Trunks; api sees API DIDs; hybrid gets both; admin sections admin-only) —
RCF customers never see UCaaS features.

#### API surface (`docker/api/src/routers/`, FastAPI behind `/api/`)

| Router | Prefix | Purpose / auth notes |
|--------|--------|----------------------|
| auth.py | /v1/auth | Login, JWT, user CRUD (admin-only) |
| health.py | /health | Liveness (DB + Redis checks) — uptime-check target |
| customers.py | /v1/customers | Customer CRUD + credit |
| rcf.py | /v1/rcf | RCF number provisioning (tenant-scoped read; admin write) |
| calls.py | /v1/calls | API-product call origination (tier CPS, ESL → East FS-1) |
| trunks.py | /v1/trunks | SIP trunk CRUD + IPs + DIDs + stats |
| cdrs.py | /v1/cdrs | **Ingest webhook (always-200, auth-exempt)** + query/summary |
| search.py | /v1/search | Admin DID/user/call search (UNION rcf/api/trunk) |
| number_inventory.py | /v1/numbers | DID lifecycle (Bandwidth sync, assign/release workflow) |
| carriers.py | /v1/carriers | Carrier gateway cards (display) |
| carrier_trunks.py | /v1/carrier-trunks | Multi-carrier trunk registry — the Kamailio/FS contract (§5.5, §6.3) |
| rates.py / tiers.py | /v1/rates, /v1/tiers | Rate deck + CPS tiers |
| sbc.py | /v1/sbc | Per-SBC call distribution (cdrs.sbc_id) |
| homer.py | /v1/homer | SIP trace search (qryn/ClickHouse) + IP aliases |
| onboarding.py | /v1/onboarding | Intake (public POST) + admin review; FCC KYC |
| billing.py | /v1/billing | Read-only estimated billing (§8.4) |
| payments.py | /v1/payments | Machine-payments demo (dormant unless `PAYMENTS_DEMO_MODE`) |
| sipp.py | /v1/sipp | Load-test presets/runner |
| freeswitch.py | /freeswitch | mod_xml_curl gateway + json_cdr ingest (auth-exempt) |

AuthZ pattern: tenant scoping via customer filter + owned-resource helpers +
404-no-leak; provisioning admin-only. **Contract rule:** FastAPI silently
drops undeclared query params — when touching a UI↔API seam, read both ends
and pin the contract (has shipped silent drift twice).

### 10.2 CRAG console (`granitevoip.com/crag`)

Ops/NOC console for the fleet — **separate deployment** (Cloud Run frontend +
GKE backend behind the ted LB; code lives in the ted-next repo, plan
`ted-next/docs/CRAG_ADMIN_MIGRATION_PLAN.md`).

| Element | Detail |
|---------|--------|
| NOC | 7 read-only fleet panels (dispatcher state, sofia, docker, journals, git heads, carrier status, drain status) |
| Admin rail | FLEET: Infrastructure + **Maintenance** · CUSTOMERS: Customers / Users / Onboarding · PLATFORM: Carriers / SIP Trunks / Rates / Tiers / DIDs / STIR |
| CDRs | Platform CDR views |
| Bridge | Deny-by-default **76-route** bridge to the revup API — service-account JWT, hash-chained audit log |
| AuthZ | `crag.noc.read` for reads; step-up (password re-auth) for writes; `crag.admin.dangerous` for the dangerous tier; two-person approval is a deliberate no-op seam (deferred) |

### 10.3 ops-agent (`docker/carrier-monitor`, :8710 fleet-wide)

One container, three roles (`OPS_AGENT_ROLE=sbc|fs|services`). Bearer-token
auth (fail-closed), **argv-only** command construction (no shell), read verbs
(16) + write verbs (11) incl. the maintenance pair `sbc.drain`/`sbc.restore`/
`sbc.drain_status` and `fs.drain`/`fs.restore`. SBC role doubles as
carrier-monitor (POSTs trunk health snapshots to the API — migrations 25/26)
and fsdisp metrics exporter (:9104); media role exports ESL gauges (:9103).
Writes require step-up; dangerous-tier verbs additionally require
`crag.admin.dangerous`.

### 10.4 Maintenance tool (CRAG FLEET → Maintenance, LIVE 2026-09-03/04)

| Property | Behavior |
|----------|----------|
| Actions | Drain/restore per SBC, per FS, or whole zone ("zone dark" = both SBCs drained) |
| Safety | Step-up password re-auth; dangerous tier; **typed zone-name confirmation** for zone ops |
| Verification | Ground-truth loop ≤20s — re-reads `sbc.drain_status` (flag + REAL healthz GET) until observed state matches intent |
| Dead-man | In the SBC itself: `maint` htable autoexpire 3600s (§4.6). FS drains have NO dead-man (dispatcher Disabled state persists) — restore is explicit |
| Visibility | Grafana MAINT yellow states on server boxes + election rows |

### 10.5 Deploy model

- Push to GitHub (PR against `RCF-V1`) → SSH to VM → `sudo git pull` in
  `/opt/revup` → rebuild/restart with the per-VM compose file. Never
  `gcloud scp`.
- All VM commands: `sudo`, single-line (no backslash continuations),
  **hostname-guarded** when destructive
  (`hostname | grep -q '^west-fs-2$' && ...`).
- Host/OS config (loopback VIPs, sysctls, kernel tuning) is encoded in
  entrypoints/compose/`scripts/kernel_tune.sh` — never hand-applied.
- GCP changes (gcloud/tofu/console) are **operator-executed only** — this
  repo designs and hands exact steps.
- Secrets live in per-VM `/opt/revup/.env` (never in git); OpenTofu holds no
  secrets.

---

## 11. Runbook & Document Index

| Document | Covers |
|----------|--------|
| `docs/SBC_ACTIVE_STANDBY_RUNBOOK.md` | SBC HA drills, failure modes, rollback, migration record |
| `docs/FS_MEDIA_HA_RUNBOOK.md` | FS-2 buildout, drain/failover drills, 5.8 dispatcher gotchas, FS-2 `.env` matrix |
| `docs/runbooks/DB_FAILOVER_RUNBOOK.md` | Promoting a standby, repointing zones |
| `docs/runbooks/DB_RESTORE_RUNBOOK.md` | pgBackRest PITR / dump restore |
| `docs/runbooks/PHASE0_SAFETY_NET_RUNBOOK.md` | Backup safety-net (proven in real recovery) |
| `docs/STIR_TRUST_BUNDLE_RUNBOOK.md` | STI-PA trust pipeline gates, crons, selftests |
| `docs/STIR_SHAKEN_IMPLEMENTATION_PLAN.md` | Signing/verify phases incl. §6 verify canary |
| `docs/STIR_X5U_HOSTING_PLAN.md` | x5u design + rotation |
| `docs/SERVICES_VM_32GB_TUNING.md` | services memory budget + PG tuning |
| `docs/OBSERVABILITY_METRICS_PLAN.md` | Metrics plane design |
| `docs/ONNET_ROUTING_DESIGN.md` | On-net routing design |
| `docs/NATIONWIDE_PRODUCTION_ROLLOUT_PLAN.md` | 3-zone rollout record + beta gates |
| `GCP_DEPLOYMENT_PLAN.md` | Zone bring-up, `.env` matrices |
| `infra/OPENTOFU_PLAN.md` | IaC blueprint (§18 = SBC HA), import strategy |
| `infra/monitoring/README.md` + `SLOS.md` | Alerting stack + SLOs |
| `scripts/backup/README.md` | Backup/guard installation |
| Root `CLAUDE.md` | Hard-won SIP lessons, gotchas, env-var reference |
| `docker/kamailio/CLAUDE.md` | SBC internals (§8.10 in-dialog dispatch) |
| `docker/freeswitch/CLAUDE.md`, `docker/homer/CLAUDE.md`, `docker/api/CLAUDE.md`, `docker/ui/CLAUDE.md` | Component docs |

---

## 12. Known Open Items / Drift Register

Honest list — verified 2026-09-04. Remove entries here as they close.

| # | Item | Detail |
|---|------|--------|
| 1 | `central-db` external IP | Reserved `136.112.210.141` detached during 2026-09-01 stop/start; VM on ephemeral `34.69.170.41`. Re-attach the reservation. |
| 2 | `sandbox_replica` | Slot absent from the primary; sandbox replica (legacy fs-media 10.142.0.102) status unknown — confirm or decommission. |
| 3 | ESL pinned to FS-1 | API originates (`POST /v1/calls`, ESL tools) fail when East FS-1 is down even though inbound rides FS-2. Fix option: healthz-aware ESL client fallback (`esl_client.py`). |
| 4 | PDD is a proxy metric | `progress_timeout`-based PDD bounds are indirect; no true per-carrier PDD histogram yet. |
| 5 | STIR verify canary | Own-crypto inbound verify deployed DARK; §6 canary (per implementation plan) pending before `STIR_SHAKEN_VERIFY=on`. |
| 6 | `CLAUDE.md` machine-type drift | Root CLAUDE.md still lists `services` as e2-standard-4; actual is e2-highmem-4/32GB since 2026-09-02. |
| 7 | Sinch termination sign-off | PCAP matrix to Sinch pending (2 term trunks × 6 SBC IPs, via ESL→direct SBC IP + `X-Carrier-IP`; beware silent Bandwidth fallback masking results). |
| 8 | nginx verto proxy hardcode | `docker/ui/nginx.conf` `/ws/verto/` proxies to `10.142.0.100:8082` (East SBC-1) — breaks in West/Central; needs env-driven upstream (UCaaS-only surface, dormant on this branch). |
| 9 | `zz_test_alert.tf` + `infra/test/` | Throwaway alert-pipeline test + scratch dir, untracked — delete or commit deliberately. |
| 10 | OpenTofu import | East resources not yet imported into state (Phase 5); fleet is hand-managed in GCP until then. |
| 11 | `lb-health-check` tag hygiene | Shared-project tag overlap with the ted project flagged in the 2026-08 firewall audit — confirm scoping. |

---

**Change log for this document:** rewritten 2026-09-04 from the verified repo
inventory + operator-confirmed live state (supersedes the 2026-05 design-era
revision, which still described active/active SBCs, single-zone East, and
"planned" replication/monitoring — all long since superseded by reality).
