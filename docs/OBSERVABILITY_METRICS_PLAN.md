# Production Metrics Plane — Prometheus (VictoriaMetrics + vmagent)

**Status:** Designed + reconciled, NOT built. Awaiting operator review before any repo change or deploy.
**Authors:** telephony-systems-expert (SIP exporters) + python-backend-architect (collection/store/data path), reconciled here.
**Decision (locked):** VictoriaMetrics (central, East) + per-zone vmagent scraping local exporters and remote-writing to it. qryn/ClickHouse stays as-is for HEP/logs — untouched.

## Why this exists

The NOC-TV "Traffic Status" wall needs **truly live** call data (CPS, connected calls, per-trunk/direction), and the platform needs a standard fleet-metrics foundation (FS, Kamailio, node, Postgres). CDRs are written at hangup → they cannot show live active calls. This plane fills that gap the industry-standard way, sized for a **hundreds→thousands of customer-SIP-trunks** future.

## The core principle — cardinality contract

The single rule that keeps this healthy: **customer identifiers NEVER become Prometheus labels.**

| Dimension | Count | Where it lives |
|---|---|---|
| Carrier trunks (Bandwidth PoPs) | dozens (closed enum) | **Prometheus label** `trunk` — safe |
| `direction`, `freeswitch_node`, `zone`, `on_net` | ≤ handful each | **Prometheus labels** — safe |
| **Customer SIP trunks** (`sip_trunks.id`) | hundreds → thousands | **Postgres** (`live_trunk_stats` + `cdrs`), never a label |

VictoriaMetrics carries the aggregate + carrier trunks + `topk` roll-ups (bounded). Full per-customer-trunk detail is served from Postgres and drilled into from CRAG. A customer-trunk explosion is **structurally impossible** because no customer identifier is ever in a label position. Total SIP-layer active series per zone stays in the low hundreds regardless of customer count.

## Architecture

```
 EACH ZONE (East / West / Central) — self-contained, only telemetry crosses
 ┌──────────────────────────────────────────────────────────────┐
 │  SBC-1  Kamailio :8080 (xhttp_prom)  + node_exporter :9100    │
 │  SBC-2  Kamailio :8080 (xhttp_prom)  + node_exporter :9100    │
 │  FS     mod_prometheus :9102  +  ESL exporter :9103           │
 │         (ESL exporter = new thread in the carrier-monitor)    │
 │         + node_exporter :9100                                 │
 │                          │  scrapes local only                │
 │                    vmagent (host-net, per zone)               │
 └──────────────────────────┼───────────────────────────────────┘
                            │ remote_write (one direction, buffered)
                            ▼
 EAST services VM:  VictoriaMetrics :8428  ◄── Grafana (Prometheus datasource)
                    vmalert :8880 (recording rules → bounded roll-ups)
                    node/postgres/pgbouncer exporters + local vmagent
                    Postgres: live_trunk_stats (customer-trunk escape hatch)
```

- Zones never cross for SIP/RTP; the only cross-zone traffic added is vmagent → East `:8428` remote_write (same posture as existing HEP + PG replication).
- Kamailio & FreeSWITCH are `network_mode: host`; their exporter ports bind on the VM interface, so the zone vmagent runs **host-net** and scrapes `127.0.0.1:<port>`.
- qryn (Loki, HEP) and the `voip-cdr-pg` Postgres datasource are unchanged. This adds a **third** Grafana datasource for live metrics.

---

## RECONCILED REGISTRY — ports & metrics (the seam)

**These names/ports are authoritative and supersede the placeholders in either expert section.**

### Port map (no collisions)

| Port | Service | Host(s) | Scraped by |
|---|---|---|---|
| `9100` | node_exporter | all 10 VMs | co-located vmagent |
| `9102` | FreeSWITCH `mod_prometheus` | 3 FS VMs | media vmagent |
| `9103` | FreeSWITCH ESL exporter (`ops_metrics.py`) | 3 FS VMs | media vmagent |
| `8080` | Kamailio `xhttp_prom` (on `SBC_INTERNAL_IP` + `127.0.0.1`) | 6 SBC VMs | sbc vmagent |
| `9187` | postgres_exporter | services / west-db / central-db | DB vmagent |
| `9127` | pgbouncer_exporter | services / west-db / central-db | DB vmagent |
| `8428` | VictoriaMetrics (vmsingle) | East services | all vmagents (remote_write) + Grafana |
| `8880` | vmalert | East services | — |
| `8429` | vmagent `/health` | all vmagents | Docker healthcheck |

### Metric map (what each exporter emits)

| Metric | Type | Labels | Source | Feeds panel |
|---|---|---|---|---|
| `freeswitch_sessions_total` | counter | *(vmagent adds `freeswitch_node`,`zone`)* | mod_prometheus `:9102` | CPS per FS |
| `freeswitch_calls_active` | gauge | *(+`freeswitch_node`,`zone`)* | mod_prometheus `:9102` | Total connected calls |
| `freeswitch_sessions_active`, `freeswitch_sessions_per_second`, `freeswitch_sessions_peak*` | gauge | *(aggregate)* | mod_prometheus `:9102` | supporting |
| `freeswitch_channels_active` | gauge | `freeswitch_node`,`direction`,`on_net` | ESL exporter `:9103` | on-net share, live splits |
| `freeswitch_calls_bridged`, `freeswitch_channels_total`, `freeswitch_esl_scrape_ok` | gauge | `freeswitch_node` | ESL exporter `:9103` | health / cross-check |
| `kamailio_trunk_cps` | counter | `trunk`(carrier),`direction` | Kamailio custom `:8080` | **Total CPS** (`rate()`) |
| `kamailio_trunk_active_calls` | gauge | `trunk`(carrier),`direction` | Kamailio dialog profile `:8080` | **Calls per trunk in/out** |
| `kamailio_*` (dialog active, tm reply codes, shmem, dispatcher, htable, sl) | mixed | module-intrinsic | xhttp_prom `:8080` (`xhttp_prom_stats="all"`) | SBC health |
| `node_*`, `pg_*`, `pgbouncer_*` | mixed | intrinsic | node/pg/pgbouncer exporters | fleet + DB-replication health |

> **Confirm at build:** whether `xhttp_prom` prefixes custom metrics (`trunk_cps` → `kamailio_trunk_cps`). Standardize on the *exposed* name and use it verbatim in dashboard/rules.

---

## Component 1 — SIP-layer exporters (FreeSWITCH + Kamailio)

### 1a. FreeSWITCH `mod_prometheus` (:9102) — aggregate per-FS

`mod_prometheus` is **not compiled** into the image today and is commented out in `modules.conf.xml`. Both are required:

`docker/freeswitch/Dockerfile` — add one enable line in the module-enable `sed` block (event_handlers group):
```dockerfile
sed -i 's|#event_handlers/mod_prometheus|event_handlers/mod_prometheus|' build/modules.conf.in && \
```
`docker/freeswitch/conf/autoload_configs/modules.conf.xml:205` — uncomment:
```xml
<load module="mod_prometheus"/>
```
New `docker/freeswitch/conf/autoload_configs/prometheus.conf.xml`:
```xml
<configuration name="prometheus.conf" description="Prometheus Exporter">
  <settings>
    <param name="bind-addr" value="0.0.0.0"/>
    <param name="port" value="9102"/>
  </settings>
</configuration>
```
Exposes aggregate, **unlabeled** switch counters (`freeswitch_sessions_active/total/per_second`, `freeswitch_calls_active/total`). Hard limit: **no** per-trunk/direction/on-net — those come from 1b/1c. Host-net ⇒ `:9102` lands on the FS VM IP; **rebuild+recreate FS = call-affecting** (see Rollout). No external apt dep (module bundles its HTTP server); if `make` ever can't find it, fall back to the ESL exporter for the aggregate too.

### 1b. FreeSWITCH ESL exporter (:9103) — live splits, zero-downtime

A new module `docker/carrier-monitor/ops_metrics.py` inside the **already-deployed carrier-monitor sidecar** (FS role has the ESL client). A background thread polls `show channels as json` on a timer, caches buckets, and serves Prometheus text on a **separate port 9103** (never behind the bearer-gated `/run` API — scrapes are unauthenticated). Emits **bounded** gauges only:
```
freeswitch_channels_active{freeswitch_node,direction,on_net}   # buckets ≤ ~18/node
freeswitch_calls_bridged{freeswitch_node}
freeswitch_channels_total{freeswitch_node}
freeswitch_esl_scrape_ok{freeswitch_node}                      # 1/0, fail-open marker
```
Fail-open: any ESL error → serve last-good sample + `esl_scrape_ok 0`, never block/raise (same contract as the poller). Started from `ops_agent.py` on FS role only. **No FS config change → deploy any time** (recreates only the sidecar).

> **`on_net` dependency:** confirm which channel var `inbound_router.lua` exports for on-net; if none, add one line `export("on_net=true")` in the on-net terminator. Until then the label is `on_net="unknown"` (still bounded).

### 1c. Kamailio `xhttp_prom` (:8080) — SBC stats + carrier-trunk metrics

`xhttp_prom.so` is **not** in the image; add the package. `docker/kamailio/Dockerfile`:
```dockerfile
kamailio-prometheus-modules \
```
`docker/kamailio/kamailio.cfg` additions:
```cfg
# --- modules ---
loadmodule "xhttp.so"
loadmodule "xhttp_prom.so"

# --- params ---
modparam("xhttp_prom", "xhttp_prom_stats", "all")
modparam("xhttp_prom", "prom_metric", "trunk_cps;Per-carrier-trunk CPS;counter;label=trunk,label=direction")
modparam("xhttp_prom", "prom_metric", "trunk_active_calls;Per-carrier-trunk active calls;gauge;label=trunk,label=direction")

# --- dedicated metrics listener (non-SIP, VPC-internal) ---
listen=tcp:SBC_INTERNAL_IP:8080
listen=tcp:127.0.0.1:8080

# --- only serve GET /metrics; 404 everything else ---
event_route[xhttp:request] {
    if ($hu != "/metrics") { xhttp_reply("404","Not Found","text/plain","not found"); exit; }
    # refresh per-carrier active-call gauges from the dialog profile (fixed carrier set):
    #   get_profile_size("carrier_trunk","primary:outbound","$var(n)"); prom_gauge_reset+inc ... (≤12 lines)
    prom_dispatch();
    exit;
}
```
`xhttp_prom_stats="all"` auto-exposes dialog-active, tm reply codes, shmem, dispatcher, htable, sl. Custom carrier metrics from Component 1d. `EXPOSE 8080/tcp` for docs. **Requires a Kamailio restart** (module load + listen parsed only at startup) — safe if done **second-SBC-first, one at a time, windowed** (2 SBCs/zone + carrier failover absorb it; `db_mode=0` so established RTP survives).

### 1d. Per-carrier-trunk CPS + active calls (bounded labels)

**CPS** — increment a custom counter in `route[TO_CARRIER]` (and the inbound Bandwidth branch), keyed by the **carrier** label (closed enum `primary|secondary|tc1|tc2|…`, dozens):
```cfg
prom_counter_inc("trunk_cps", "$var(carrier_label)", "outbound");   # TO_CARRIER
prom_counter_inc("trunk_cps", "$var(inbound_tc_label)", "inbound"); # inbound branch
```
PromQL derives CPS via `rate()`. (Note: the existing `trunk_cps` **htable** is keyed by *customer* trunk_id — do NOT export those keys; carrier egress CPS is added fresh here.)

**Active calls** — a valued dialog profile (dialog.so already loaded, already uses a valued profile):
```cfg
modparam("dialog", "profiles_with_value", "caller;carrier_trunk")   # extend existing line
set_dlg_profile("carrier_trunk", "$var(carrier_label):outbound");   # TO_CARRIER
set_dlg_profile("carrier_trunk", "$var(inbound_tc_label):inbound"); # inbound branch
```
Rendered per carrier value via `get_profile_size()` in the xhttp route. **Same restart class as 1c** — fold into one maintenance change. Caveat to document: `trunk_active_calls` only counts calls set up *after* the restart; it self-heals within one call-duration cycle.

> **Lower-risk interim:** ship the SBC-role ESL/kamcmd exporter emitting whole-SBC `kamailio` dialog-active + carrier CPS (1d) first, and add the per-carrier dialog profile (active split) in a planned window.

---

## Component 2 — per-zone vmagent (collection)

One `victoriametrics/vmagent:v1.103.0` per zone role, **host-net**, scrapes local exporters only, remote-writes to `${METRICS_REMOTE_WRITE_HOST:-10.142.0.103}:8428` with on-disk buffering (`-remoteWrite.maxDiskUsagePerURL=2GB`, `tmpDataPath=/vmagent-data`). New service, **no `depends_on`**, deploy `--no-deps`. Health on `:8429`. Add to `docker-compose.sbc.yml` and `docker-compose.media.yml` (+ a services/DB variant, bridge-net via `host.docker.internal`, in Component 4).

Scrape files (new `docker/vmagent/`), reconciled to the real ports, `external_labels` stamp `zone`+`reporting_instance`:
- `scrape-sbc.yml`: `kamailio` → `127.0.0.1:8080`; `node` → `127.0.0.1:9100`
- `scrape-media.yml`: `freeswitch` → `127.0.0.1:9102`; `freeswitch_esl` → `127.0.0.1:9103`; `node` → `127.0.0.1:9100`
- `scrape-services.yml` / `scrape-db.yml`: `node` `:9100`, `postgres` `:9187`, `pgbouncer` `:9127` (via `host.docker.internal`)

New `.env` keys: `METRICS_ZONE` (east|west|central), `METRICS_REMOTE_WRITE_HOST=10.142.0.103`; media adds `FS_NODE_ID`; SBC already has `SBC_ID`.

**Firewall (operator runs — GCP):**
```
gcloud compute firewall-rules create allow-vmagent-remote-write --project rugged-night-193017 --network default --direction INGRESS --action ALLOW --rules tcp:8428 --target-tags voip-services --source-ranges 10.142.0.0/20,10.138.0.0/20,10.128.0.0/20,192.168.10.0/24,192.168.20.0/24,192.168.30.0/24 --description "Zone vmagents -> East VictoriaMetrics remote_write"
```

---

## Component 3 — central VictoriaMetrics + vmalert (East services)

Add to `docker-compose.services.yml` (bridge `services-network`, published `8428:8428` VPC-internal, persistent `victoriametrics_data` volume, 12-month retention, healthcheck `/health`):
- `victoriametrics/victoria-metrics:v1.103.0` — `-retentionPeriod=12 -httpListenAddr=:8428`, 2 vCPU / 4G limit.
- `victoriametrics/vmalert:v1.103.0` — `-datasource.url`/`-remoteWrite.url`/`-remoteRead.url=http://victoriametrics:8428`, `-rule=/etc/vmalert/rules/*.yml`, `:8880`. `depends_on: victoriametrics` is **safe** (neither is a call server). Alertmanager optional/later; recording rules are the immediate value.

At ~15s scrape × 9 call VMs with bounded labels → low tens of thousands of active series (trivial for vmsingle; tens of GB for 12mo). **vmcluster** is the documented scale path if active series ever cross ~1M — vmagent/Grafana URLs change, PromQL identical.

---

## Component 4 — host & DB exporters (all 10 VMs)

- **node_exporter** `prom/node-exporter:v1.8.2` — host-net + `pid:host` + `/:/host:ro,rslave`, `:9100`. Same block in all three compose files (and the DB compose). Added to every VM.
- **postgres_exporter** `prometheuscommunity/postgres-exporter:v0.15.0` `:9187` — bridge + `host.docker.internal:5432` (DIRECT :5432, **not** PgBouncer, per the transaction-pooling gotcha), read-only `metrics_ro` role with `pg_monitor`. Gives replication lag / slots / connections.
- **pgbouncer_exporter** `prometheuscommunity/pgbouncer-exporter:v0.10.2` `:9127` — bridge + `host.docker.internal:6432/pgbouncer`, `pgb_stats` user in `stats_users`. Pool saturation (`cl_waiting`, `sv_idle`).
- **services VM** runs its own bridge vmagent (`host.docker.internal` to its host-net node + DB exporters, remote-write to `victoriametrics` by name). **west-db / central-db** need a new small `docker-compose.db.yml` (node + pg + pgbouncer exporters + a DB vmagent) — the `allow-vmagent-remote-write` rule already covers their subnets.

DB wiring (apply on **East primary**, replicates read-only):
```sql
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='metrics_ro') THEN
  CREATE ROLE metrics_ro LOGIN PASSWORD 'CHANGE_ME_MATCH_ENV'; END IF; END $$;
GRANT pg_monitor TO metrics_ro;  GRANT CONNECT ON DATABASE voip TO metrics_ro;
```
PgBouncer stats user is host config (`pgbouncer.ini` `stats_users` + `userlist.txt` + reload) — document in `docker/postgres/`. New `.env`: `METRICS_DB_PASSWORD`, `PGBOUNCER_STATS_PASSWORD`, `SERVICES_NODE_ID`.

---

## Component 5 — Grafana Prometheus datasource

New `docker/homer/grafana/provisioning/datasources/victoriametrics.yml`, styled like the existing files, **fixed uid `voip-metrics-vm`**, in-network by service name:
```yaml
apiVersion: 1
datasources:
  - name: VoIP Metrics (VictoriaMetrics)
    uid: voip-metrics-vm
    type: prometheus          # built-in in grafana-oss 10.4.3; VM is Prom-API compatible
    access: proxy
    url: http://victoriametrics:8428
    isDefault: false
    editable: false
    jsonData: { httpMethod: POST, prometheusType: Prometheus, prometheusVersion: "2.40.0", timeInterval: "15s", manageAlerts: false }
```

---

## Component 6 — customer-SIP-trunk escape hatch (Postgres)

Keeps hundreds→thousands of customer trunks **out** of Prometheus while still queryable live from CRAG.

- **`docker/postgres/init/26_live_trunk_stats.sql`** (new) — mirrors `25_carrier_trunk_status.sql`: table `live_trunk_stats(customer_id,trunk_id,sbc_id,trunk_name,active_channels,cps_1m,asr_5m,registered,updated_at)` PK `(customer_id,trunk_id,sbc_id)`, a `live_trunk_health` view aggregating across SBCs with a `stale` flag, grants to `api` (write) + `grafana_ro` (read). Idempotent; apply on primary, replicates.
- **`docker/api/src/routers/live_trunk_stats.py`** (new) — byte-for-byte the `carrier_status.py` shape: shared-bearer (**distinct** `LIVE_TRUNK_STATS_TOKEN`, fail-closed), resilient **always-200**, per-row UPSERT with explicit `::type` casts, `MAX_TRUNKS` guard. `GET ""` (`require_admin`) reads `live_trunk_health` for CRAG. Dual-mount `/v1/live-trunk-stats` + `/live-trunk-stats` in `main.py`; one exemption line in `middleware/auth.py` (`path.endswith("/live-trunk-stats/report") and method=="POST"`).
- **Feeder** — extend the SBC `carrier-monitor` (already POSTs to the East API): a second poll derives per-customer-trunk `active_channels`/`cps`/registration from `kamcmd` and POSTs to `/v1/live-trunk-stats/report`. No new container. (CDR-derived `asr_5m` can be filled by a periodic East-API query.)
- **`docker/vmalert/rules/trunk_rollup.yml`** (new) — bounded roll-ups so the wall stays fixed-size (reconciled to real metric names):
```yaml
groups:
  - name: trunk_rollups
    interval: 30s
    rules:
      - record: voip:cps:by_direction:rate1m
        expr: sum by (direction, zone) (rate(kamailio_trunk_cps[1m]))
      - record: voip:calls_active:by_node
        expr: sum by (freeswitch_node, zone) (freeswitch_calls_active)
      - record: voip:calls_active:top10_carrier
        expr: topk(10, sum by (trunk, direction) (kamailio_trunk_active_calls))
```

---

## Component 7 — "Traffic Status" dashboard rework

Five live panels → PromQL on `voip-metrics-vm`; the seven analytics panels stay on `voip-cdr-pg` (CDRs are the right store for history). Reconciled queries:

| id | Panel | Datasource after | Query after |
|---|---|---|---|
| 1 | Total CPS — now (1m) | `voip-metrics-vm` | `sum(rate(kamailio_trunk_cps[1m]))` |
| 2 | CPS per FreeSWITCH | `voip-metrics-vm` | `sum by (freeswitch_node)(rate(freeswitch_sessions_total[1m]))` |
| 3 | Total connected calls — now | `voip-metrics-vm` | `sum(freeswitch_calls_active)` *(true live gauge — upgrade from the CDR overlap proxy; update the panel description)* |
| 4 | Calls per trunk — inbound | `voip-metrics-vm` | `sum by (trunk)(kamailio_trunk_active_calls{direction="inbound"})` |
| 5 | Calls per trunk — outbound | `voip-metrics-vm` | `sum by (trunk)(kamailio_trunk_active_calls{direction="outbound"})` |
| 10,11,20,21,22,30,31 | volume / per-zone / carrier split / ASR-ACD / on-net / SIP class / hangup | `voip-cdr-pg` | **unchanged** |

**Semantic note (needs your nod):** panels 4/5 are titled "Calls per trunk" but the current SQL joins **customer** trunks. The live PromQL `trunk` label is **carrier-only** (bounded). Recommended: panels 4/5 become **live per-carrier-trunk in/out** on the wall; **per-customer-trunk** detail moves to the CRAG `live_trunk_health` drill-down (matches your "wall for glance, CRAG to look further" model). Alternative: retitle the SQL panels as retrospective per-customer and add the two PromQL carrier panels.

`zone` var: add a hidden `zonere` var (`.*`/`east`/`west`/`central`) for the PromQL panels; leave `$zone` (SQL `LIKE`) for the kept Postgres panels.

---

## Phased rollout (single-line, hostname-guarded; every `up` is `--no-deps`, NEW services only)

Never names/rebuilds `freeswitch`/`kamailio` except the deliberate windowed FS/SBC steps. Order: **store → firewall+datasource → DB roles → host/DB exporters → per-zone vmagent (East→West→Central) → API+feeder → SIP exporters (windowed) → dashboard.**

0. **Commit + push** all repo artifacts from the dev box.
1. **Store (East):** `[ "$(hostname)" = "services" ] && sudo docker compose -f /opt/revup/docker-compose.services.yml up -d --no-deps victoriametrics vmalert` → verify `curl -s http://127.0.0.1:8428/health`.
2. **Firewall** (operator gcloud line above) + **datasource:** `... up -d --no-deps --force-recreate grafana` (safe; re-reads provisioning).
3. **DB role + PgBouncer stats user** (hostname-guarded, primary first — replicates): apply `26_live_trunk_stats.sql` + `metrics_ro` on `services`; `stats_users` + `systemctl reload pgbouncer` on each DB VM.
4. **Host/DB exporters + services vmagent (East):** `... services.yml up -d --no-deps node-exporter postgres-exporter pgbouncer-exporter vmagent`.
5. **East SBC + FS exporters (additive, safe):** `sbc.yml up -d --no-deps node-exporter vmagent` on both East SBCs; `media.yml up -d --no-deps node-exporter vmagent` on `fs-media-v2`. Verify East targets `up` from the store.
6. **West** then **7. Central:** repeat 5 with `METRICS_ZONE` set; DB VMs use `docker-compose.db.yml`.
8. **API + feeder (East):** `... services.yml up -d --no-deps --build api`; then `sbc.yml up -d --no-deps --build carrier-monitor` on each SBC (already has no `depends_on: kamailio`).
9. **SIP exporters — the windowed, call-aware steps:**
   - **Kamailio (1c/1d):** rebuild + recreate **second SBC first**, verify `curl 127.0.0.1:8080/metrics` + `core.uptime`, then the primary; one SBC at a time, low-traffic window.
   - **FS `mod_prometheus` (1a) — only truly call-affecting step:** per zone, drain that zone's inbound, confirm `show calls count` = 0, `killall -9 freeswitch` then `media.yml build && up -d freeswitch`. **Never all three FS at once.** (1b ESL exporter already shipped in step 5 with the sidecar — no FS restart.)
10. **Dashboard:** edit `traffic-status.json` per Component 7, push, `... up -d --no-deps --force-recreate grafana`.

---

## Resolved decisions (operator, 2026-07-29)

1. **Panels 4/5 semantics — RESOLVED: live per-carrier on the wall + per-customer in CRAG.** Built: panels 4/5 are now live `kamailio_trunk_active_calls` per carrier; per-customer-trunk detail lands in Postgres `live_trunk_stats` / `live_trunk_health` for the CRAG drill-down.
2. **Sequencing — RESOLVED: no split, deploy everything now (pre-launch).** The platform is not yet carrying real customer traffic, so all phases below run in one pass. The **dependency ordering still holds** (store → datasource → exporters → vmagent → dashboard), but the call-safety caveats in Phase 9 (drain FS first / second-SBC-first windows) are **moot until real traffic** — the FS recreate and Kamailio restart can be done straight through. Re-observe those windowing rules once live.

## Flags to confirm at build time

1. `xhttp_prom` custom-metric prefix (`trunk_cps` vs `kamailio_trunk_cps`) — pin the exposed name into dashboard + rules.
2. `mod_prometheus` builds on the pinned FS checkout with no extra apt dep (validate first `make`); fallback = ESL exporter carries the aggregate too.
3. Exact `prom_*` verb names in `kamailio-prometheus-modules` on 5.8 (`prom_gauge_set` vs `reset`+`inc`).
4. Which channel var `inbound_router.lua` exports for `on_net` (else one-line `export`).
5. Confirm nothing else binds `:8080` on the SBC hosts / `:9102`/`:9103` on FS hosts.
6. Image tag patch levels (majors pinned above are stable).

## File inventory

**New:** `docker/vmagent/{scrape-sbc,scrape-media,scrape-services,scrape-db}.yml` · `docker/vmalert/rules/trunk_rollup.yml` · `docker/homer/grafana/provisioning/datasources/victoriametrics.yml` · `docker/postgres/init/26_live_trunk_stats.sql` · `docker/api/src/routers/live_trunk_stats.py` · `docker/carrier-monitor/ops_metrics.py` · `docker/freeswitch/conf/autoload_configs/prometheus.conf.xml` · `docker-compose.db.yml`

**Changed:** `docker-compose.{services,media,sbc}.yml` · `docker/freeswitch/Dockerfile` · `docker/freeswitch/conf/autoload_configs/modules.conf.xml` · `docker/kamailio/Dockerfile` · `docker/kamailio/kamailio.cfg` · `docker/carrier-monitor/ops_agent.py` · `docker/api/src/main.py` · `docker/api/src/middleware/auth.py` · `docker/homer/grafana/dashboards/noc/traffic-status.json` · `.env.{sbc,media,services}.example`
