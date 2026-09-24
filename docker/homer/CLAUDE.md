# Homer 10 — SIP Capture & Debugging

## Overview

Homer 10 SIP monitoring stack for real-time SIP trace analysis and call debugging.
Receives HEP (Homer Encapsulation Protocol) packets from Kamailio and FreeSWITCH,
stores them in ClickHouse via qryn (Loki-compatible API), and provides Grafana
dashboards for SIP search and ladder diagram visualization.

This replaces the Homer 7 stack (PostgreSQL + homer-app) with a modern,
ClickHouse-backed architecture that scales better and uses Grafana for UI.

## Components

| Container | Image | Port | Purpose |
|-----------|-------|------|---------|
| `voip-clickhouse` | clickhouse/clickhouse-server:23.3-alpine | 8123 (internal) | Columnar DB for SIP capture data (replaces Homer 7 Postgres) |
| `voip-qryn` | qxip/qryn:latest | 3100 (Loki API) | Loki-compatible API backed by ClickHouse (replaces homer-app backend) |
| `voip-heplify-server` | ghcr.io/sipcapture/heplify-server:1.60.3 | 9060 UDP/TCP, 9061 TCP | Receives HEP packets, pushes to qryn via Loki push API |
| `voip-grafana` | grafana/grafana-oss:10.4.3 | 3000 (HTTP) | Dashboards for SIP ladder diagrams (now a SECONDARY deep-link target, not the main UI) |

Image tags are pinned in `docker-compose.services.yml` (ClickHouse `23.3-alpine`, Grafana `grafana-oss:10.4.3`, heplify-server `1.60.3`). qryn tracks `:latest`.

## Architecture

```
HEP Sources (Kamailio, FreeSWITCH)
    |
    v  (UDP/TCP port 9060)
heplify-server
    |
    v  (Loki push API)
qryn (:3100)
    |
    v  (ClickHouse native)
clickhouse-server (:8123)
    |
    v  (Loki query API)
Grafana (:3000)
```

heplify-server receives HEP packets and pushes them to qryn's Loki-compatible
push endpoint. qryn stores data in ClickHouse.

**Primary SIP-debug UI is the React app, not Grafana.** The customer-facing
TroubleshootingPage (`docker/ui/app/src/pages/TroubleshootingPage.tsx`) POSTs to
`/api/homer/search`, which nginx proxies to the FastAPI Homer router
(`docker/api/src/routers/homer.py`, mounted at both `/homer` and `/v1/homer`).
That router queries qryn (LogQL) for phone-number search + X-CID discovery, then
queries ClickHouse **directly on port 8123** for the multi-Call-ID fetch (bypassing
qryn's RE2 LogQL engine, which 500s on large regex alternations). Grafana is now a
SECONDARY deep-link target for ad-hoc ladder inspection, not the main entry point.

## HEP Sources & Capture IDs

Each SIP component sends HEP packets with a unique capture_id for identification:

| Source | capture_id | HEP Target | Config Location |
|--------|-----------|------------|-----------------|
| Kamailio SBC | 100 | $HOMER_IP:9060 UDP | kamailio.cfg (`siptrace` module) |
| FreeSWITCH (all profiles) | 200 | $HOMER_IP:9060 UDP | sofia.conf.xml `global_settings` (`capture-server`) |

**NOTE:** mod_sofia only supports a single global capture-server with one capture_id.
Per-profile capture-server params are silently ignored by FreeSWITCH (the config parser
does not recognize `capture-server` in profile `<settings>`, only in `<global_settings>`).
Both internal and external profiles share capture_id=200.

**Multi-zone capture IDs:** East=100/200, West=110/210, Central=120/220. Media-HA FS-2 nodes (Phase 4c hot standbys `east-fs-2`/`west-fs-2`/`central-fs-2`): **201/211/221** — set via `HEP_CAPTURE_ID` in each FS-2 `.env` so ladders distinguish which FS handled a call (confirm against the FS-2 `.env` matrix at deploy).

HEP sources (Kamailio and FreeSWITCH) are unchanged from Homer 7 -- they still
send HEP to port 9060 on the services VM. Only the backend storage and UI changed.

## Files

| File | Purpose |
|------|---------|
| `clickhouse-users.xml` | ClickHouse user config (passwordless default user for internal Docker network) |
| `grafana/provisioning/datasources/qryn.yml` | Auto-provisions qryn as Loki datasource in Grafana |
| `grafana/provisioning/dashboards/dashboards.yml` | Auto-provisions dashboard directory in Grafana |
| `grafana/dashboards/homer/sip-search.json` | SIP search dashboard with logs, table, and flow diagram panels (in the `homer/` subdir so its provider does not recurse into the `noc/` NOC dashboards) |
| `grafana/dashboards/noc/*.json` | Production NOC dashboards (infra + voice-product), provisioned into the "Production NOC" Grafana folder by a second dashboards provider |
| `scripts/ip-alias.lua` | heplify-server Lua script: rewrites HEP SrcIP/DstIP to friendly node names before Loki labels are generated |

## NOC dashboards reading `cdrs` — one row per call (A/B leg split, 2026-09-23)

Since migration 48 `cdrs` holds one A row per call (`leg='A'`, `call_id=uuid`) plus one **B row per carrier bridge attempt** (`leg='B'`, `call_id`=A-leg uuid, `leg_attempt` 1..N, `direction='outbound'`, its own RTP stats); pre-48 rows have `leg IS NULL`. Contract: `docs/CDR_LEG_SPLIT_CONTRACT.md`.

- **Every** SQL panel/target that reads `cdrs` (datasource `voip-cdr-pg`) MUST carry `leg IS DISTINCT FROM 'B'` (alias-qualified, e.g. `c.leg ...`) — counts, ASR, minutes, on-net %, carrier splits AND call-level quality (the `call_quality_*` / `call_mos` columns live on the A row only). A new panel without it double-counts every carrier call. Filtering `direction='inbound'` is NOT a substitute. Leg-level (per-direction) quality panels are the deliberate exception listed below; they still spell the A-side predicate (as a `caller_side` label, or `(leg IS DISTINCT FROM 'B' OR leg = 'B')` when both directions are pooled) so the rule stays greppable.
- The panels are the predicate's only home: the `leg` column must exist (migration 48 applied on the primary) BEFORE these dashboards are deployed, or every cdrs panel errors.
- Leg-aware panels: call-quality.json id 76 "Carrier legs per call — last 24h (orphan-leg check)" (Diagnostics row): B rows, calls with ≥1 B, max/avg `leg_attempt`, orphan B rows (no A row, call started >3h ago — must be 0, red otherwise) and "B awaiting A" (in-progress calls — A CDR posts at hangup; informational).
- Also leg-aware (quality **by direction**, 2026-09): call-quality.json ids 21 (loss p95), 20 (RFC 3550 jitter p50/p95), 13 (loss distribution), 22 (one-way audio per hour + partial inbound media) and noc-home.json ids 31/32 (loss / jitter p95, both directions pooled). caller→platform = the A row (what the callee hears), callee→platform = the carrier B rows (what the caller hears). They count legs, never calls.
- `cdr_hourly_stats` (continuous aggregate) has no `leg` dimension. Its only dashboard consumer is call-quality.json id 3 (ACD), filtered `direction='inbound'` so B rows (all `outbound`) drop out. Any new CAGG consumer needs the same filter unless the aggregate is recreated with the leg predicate.
- Counting vs rating: minutes/volume panels = A rows only. B rows carry their own `billed_seconds` for rating (Equinox); no NOC panel shows "billed" totals today — if one is added, decide per-leg rating semantics explicitly rather than reusing the A-only predicate.

## NOC call-quality panels (2026-09, `docs/CALL_QUALITY_ACCURACY_PLAN.md` E.1)

The quality panels read the honest columns from migration 50. They need `50_cdr_quality_accuracy.sql` applied on the primary BEFORE the dashboards are deployed, otherwise `quality_status` / `call_quality_*` are undefined and the panels error.

- **Grades, one definition (plan D):** great ≥ 4.34 · good ≥ 4.02 · fair ≥ 3.60 · poor < 3.60 or one-way audio (`no_rtp`). They apply to the stored 2-dp E-model MOS. Grafana literals are 3.60 / 4.02 / 4.34. Never reintroduce the old 3.5 / 4.0 / 4.3 cuts.
- **Graded predicates only:** call-level panels use `leg IS DISTINCT FROM 'B' AND call_quality_grade IS NOT NULL` (or `call_quality_status='rated'` for MOS percentiles). Leg-level panels use `quality_status = 'rated'` (plus `no_rtp` for one-way). The old ad-hoc floors `billable_ms >= 10000 AND rtp_audio_in_packet_count >= 500` are gone; `quality_status` replaces them.
- **No MOS averages anywhere.** Use shares (Good+ %), percentiles (p50 / p10 MOS, p95 loss and jitter), distributions and one-way counts. `quality_pct` and `jitter_min_ms` are deprecated (always NULL). `r_factor` is no longer a relabelled MOS, but it is not charted. `jitter_max_ms` is not charted either.
- **Jitter panels stay empty until FS images carry quality patch v1.** Legacy images and history write `jitter_avg_ms` NULL. The old FS variance-derived peak survives only as `fs_jitter_max_std_ms` (diagnostic).
- **call-quality.json:** #43 Good-or-better calls 15m · #12 Call MOS p50/p10 · #21 True loss p95 by direction · #20 RFC 3550 jitter by direction · #11 Call grade distribution (Great / Good / Fair / Poor (audio) / One-way) · #13 Loss distribution (barchart, 7 bands) · #22 One-way audio per hour + partial inbound media · #30 Graded-call snapshot. **noc-home.json** Voice row: #30 Good+ 15m · #31 Loss p95 15m · #32 Jitter p95 15m · #33 One-way audio 1h.
- SLIs built on these panels: `infra/monitoring/SLOS.md` "Voice quality SLI". Paging for one-way audio: `scripts/backup/media_guard.sh`.
- `tests/test_grafana_quality_sql.py` runs every edited panel's SQL (macros substituted) against an ephemeral PG16 with migration 50 and asserts the result shapes, the leg predicate, the thresholds and that no MOS average exists. Run it after any quality-panel edit.

## Key Configuration

- **heplify-server** uses `DBSHEMA=mock` and `DBDRIVER=mock` -- it does NOT write to a database directly. Instead it pushes to qryn's Loki push endpoint (`LOKIURL`).
- **`LOKIALLOWOUTOFORDER=true` is REQUIRED.** heplify-server's Loki client (remotelog/loki.go) keeps a single global `lastPktTime`; with the default `false`, any HEP packet arriving out of timestamp order gets its timestamp REPLACED with `time.Now()` (and poisons `lastPktTime`, cascading onto subsequent packets). Symptom: rows with full-nanosecond entropy, 15-20ms late, INVITEs sorting after their own 100 Trying in the ladder. Real HEP capture timestamps are µs precision (stored ns values end in `000`). The guard exists for genuine Grafana Loki; qryn/ClickHouse accepts out-of-order writes, so disabling the guard is safe here.
- **ALEGIDS=X-CID** is preserved for call leg correlation (Kamailio sets X-CID header).
- **qryn** connects to ClickHouse on port 8123 (HTTP interface) with the default user (no password).
- **Grafana** has anonymous viewer access enabled and serves from `/grafana/` subpath for reverse proxy compatibility.
- **Flow panel plugin** (`qxip-flow-panel`) is installed at Grafana startup for SIP ladder diagrams.
- **IP aliasing** via Lua script (`scripts/ip-alias.lua`). heplify-server's Lua engine calls `SetHEPField("SrcIP", name)` to rewrite raw IPs to friendly names (e.g. "SBC-1", "FreeSWITCH", "Services") before Loki label generation. This means `src_ip`/`dst_ip` labels carry friendly names with zero Grafana dashboard changes. To add or change aliases, edit the `aliases` table in `ip-alias.lua` and restart heplify-server.
  - **East-only hardcode:** the `aliases` table currently lists only East-zone IPs (SBC-1/SBC-2 VPC + external, FreeSWITCH VPC + external, Services, SBC-VIP). **Every new zone MUST add its SBC/FS IPs here** or the SIP ladder shows raw IPs instead of node names for that zone.

## Accessing Homer 10

- **Local dev:** http://localhost:3000/grafana/
- **Production:** http://<services-vm-ip>:3000/grafana/ (via IAP tunnel or NLB)
- **Default login:** admin / sipcapture (set via `GRAFANA_ADMIN_PASSWORD` env var)
- **Anonymous access:** Viewer role enabled for embedding in our UI

## Centralized vs Per-Zone

**Phase 1 (current):** Single Homer stack on the services VM in us-east1-b. All zones
send HEP packets to this centralized instance. Cross-region HEP is UDP, fire-and-forget,
~5 Mbps per zone -- negligible cost and no call quality impact.

**Phase 2 (optional):** Per-zone ClickHouse if HEP volume becomes a concern. qryn
supports ClickHouse clustering for distributed queries.

## Using Homer 10 for Debugging

1. Open Grafana at :3000/grafana/
2. Navigate to Homer > SIP Search dashboard
3. Enter Call-ID, From User, or To User in the filter variables
4. Logs panel shows SIP messages in time order
5. Table panel shows parsed SIP fields (method, src_ip, dst_ip, sip_code)
6. Flow panel shows SIP ladder diagram for a specific Call-ID
7. Use this to debug: one-way audio, call setup failures, 4xx/5xx errors, codec mismatches

## Migration Notes (Homer 7 to Homer 10)

- Homer 7 PostgreSQL data is NOT migrated -- old SIP captures are lost on upgrade
- The `homer-db` (postgres:14-alpine) container and `homer_db_data` volume are removed
- The `homer-webapp` (homer-app) container is removed
- heplify-server image is the same but reconfigured for Loki push instead of Postgres
- HEP sources need zero changes -- same ports, same protocol
