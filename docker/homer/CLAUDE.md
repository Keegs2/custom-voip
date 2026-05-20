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
| `voip-clickhouse` | clickhouse/clickhouse-server:latest | 8123 (internal) | Columnar DB for SIP capture data (replaces Homer 7 Postgres) |
| `voip-qryn` | qxip/qryn:latest | 3100 (Loki API) | Loki-compatible API backed by ClickHouse (replaces homer-app backend) |
| `voip-heplify-server` | ghcr.io/sipcapture/heplify-server | 9060 UDP/TCP, 9061 TCP | Receives HEP packets, pushes to qryn via Loki push API |
| `voip-grafana` | grafana/grafana:latest | 3000 (HTTP) | Dashboards for SIP search and ladder diagrams (replaces homer-app Angular UI) |

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
push endpoint. qryn stores data in ClickHouse. Grafana queries qryn's Loki
query API to display SIP traces, search results, and ladder diagrams.

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

**Multi-zone capture IDs:** East=100/200, West=110/210, Central=120/220.

HEP sources (Kamailio and FreeSWITCH) are unchanged from Homer 7 -- they still
send HEP to port 9060 on the services VM. Only the backend storage and UI changed.

## Files

| File | Purpose |
|------|---------|
| `clickhouse-users.xml` | ClickHouse user config (passwordless default user for internal Docker network) |
| `grafana/provisioning/datasources/qryn.yml` | Auto-provisions qryn as Loki datasource in Grafana |
| `grafana/provisioning/dashboards/dashboards.yml` | Auto-provisions dashboard directory in Grafana |
| `grafana/dashboards/sip-search.json` | SIP search dashboard with logs, table, and flow diagram panels |
| `scripts/ip-alias.lua` | heplify-server Lua script: rewrites HEP SrcIP/DstIP to friendly node names before Loki labels are generated |

## Key Configuration

- **heplify-server** uses `DBSHEMA=mock` and `DBDRIVER=mock` -- it does NOT write to a database directly. Instead it pushes to qryn's Loki push endpoint (`LOKIURL`).
- **ALEGIDS=X-CID** is preserved for call leg correlation (Kamailio sets X-CID header).
- **qryn** connects to ClickHouse on port 8123 (HTTP interface) with the default user (no password).
- **Grafana** has anonymous viewer access enabled and serves from `/grafana/` subpath for reverse proxy compatibility.
- **Flow panel plugin** (`qxip-flow-panel`) is installed at Grafana startup for SIP ladder diagrams.
- **IP aliasing** via Lua script (`scripts/ip-alias.lua`). heplify-server's Lua engine calls `SetHEPField("SrcIP", name)` to rewrite raw IPs to friendly names (e.g. "SBC-1", "FreeSWITCH", "BW-DAL") before Loki label generation. This means `src_ip`/`dst_ip` labels carry friendly names with zero Grafana dashboard changes. To add or change aliases, edit the `aliases` table in `ip-alias.lua` and restart heplify-server.

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
