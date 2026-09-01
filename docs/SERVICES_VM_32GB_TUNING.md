# Services VM 32GB Retuning (e2-standard-4 → e2-highmem-4)

The East `services` VM (PG **primary** for the whole platform + the Docker
services stack) is resized 16GB → 32GB. This doc is the memory budget, the
rationale for every changed number, the apply order, verification, and
rollback. Changes live in three places, all repo-encoded:

1. `docker-compose.services.yml` — container memory/cpu limits only
2. `docker/homer/clickhouse-users.xml` — ClickHouse per-query cap 2GB → 4GB
3. `scripts/services-tuning/apply_pg_32gb.sh` — host PG conf.d drop-in
   (`90-revup-32gb.conf`), operator-restarted; `show_pg_tuning.sh` verifies

## The 32GB budget

PostgreSQL runs on the HOST (systemd, not Docker) and depends on the OS page
cache — the container limit ceiling is deliberately capped so PG + page cache
+ OS keep **≥ ~15GB**.

| Consumer | Limit | Old | Notes |
|---|---|---|---|
| api | **2G** | 1G | Busy CDR ingest + Homer search fan-out; 1G was tight |
| clickhouse-server | **6G** | UNLIMITED | New cap: 4G per-query (users.xml) + ~2G server overhead; cpus 3 |
| victoriametrics | **6G** | 4G | Fleet-wide TSDB, 12-mo retention, all-zone remote-write, growing |
| grafana | **1G** | UNLIMITED | New cap; typical use 200–400M, 1G is generous |
| ui | 128M | — | unchanged |
| ops-agent | 128M | — | unchanged |
| cdr-exporter | 256M | — | unchanged (profile-gated, rarely running) |
| vmalert | 256M | — | unchanged |
| vmagent | 256M | — | unchanged |
| node/postgres/pgbouncer/blackbox exporters | 4 × 128M | — | unchanged |
| **Sum of explicit container limits** | **16.5G** | 6.75G | |
| qryn (deliberately uncapped) | ~4.5G worst / 1–2G typical | UNLIMITED | V8 heap already bounded in-process at 4G (`NODE_OPTIONS`); a cgroup cap would OOM-kill instead of GC-degrade |
| heplify-server (uncapped) | ~0.5G typical | UNLIMITED | small Go daemon; buffers only if qryn stalls |
| **Host side (32 − 16.5)** | **15.5G** | | |
| — PG shared_buffers | 8G | | restart-applied |
| — PG backends + work_mem envelope | ~2.5G | | ≤120 pooled backends; ~10–25 hungry sort/hash nodes × 32–64MB |
| — PG maintenance/autovacuum | ~1G | | maintenance_work_mem 1G |
| — OS + systemd + PgBouncer | ~1G | | |
| — **Page-cache floor** | **~3G** | | worst-case; steady state is far higher — containers rarely touch their caps, so unused limit headroom IS page cache |

Arithmetic: 16.5G container ceiling + 11.5G PG + 1G OS + 3G page-cache floor = 32G.
Honest caveat: qryn + heplify are uncapped (≈5G theoretical worst on top of the
ceiling); under that coincidence Linux evicts page cache first (perf, not
correctness). Capping qryn was rejected because its 4G V8 heap cap already
bounds it *gracefully* and env changes were out of scope.

## Every changed value

| Setting | Old → New | Why |
|---|---|---|
| compose `api` memory | 1G → 2G | headroom for CDR ingest bursts + Bandwidth sync + Homer proxy |
| compose `clickhouse-server` | none → 6G / cpus 3 / resv 512M | was unlimited — could eat the box and evict PG's page cache; 6G = 4G query cap + server overhead; cpus 3 keeps a core for api/PG during scans |
| compose `grafana` | none → 1G / cpus 1 / resv 128M | cap blast radius of a plugin/datasource leak |
| compose `victoriametrics` memory | 4G → 6G | vmsingle RSS grows with active series + 12-mo range reads; 4G was 16GB-box sizing |
| clickhouse-users.xml `max_memory_usage` | 2GB → 4GB | per-QUERY cap; Homer SIP-search on big ranges hit 2GB; must stay < 6G container limit |
| PG `shared_buffers` | (live value varies) → 8GB | 25% of RAM, classic primary sizing; restart required |
| PG `effective_cache_size` | → 20GB | planner hint = shared_buffers + realistic steady-state page cache; advisory only |
| PG `maintenance_work_mem` | → 1GB | faster index builds / vacuum on cdrs hypertable; PG16 caps autovac dead-TID memory at 1GB regardless |
| PG `work_mem` | → 32MB | per sort/hash **node**, not per connection. max_connections=300 but only ≤120 arrive via PgBouncer (pool 100+20) and hungry consumers (Grafana CDR aggs, CDR export) ≈ 10–25 concurrent nodes → 0.8–1.6G envelope. PG16 `hash_mem_multiplier=2.0` doubles hash-node budgets — that is why 32MB, not 64MB. Hot-path DID lookups are point reads, unaffected |
| PG `wal_buffers` | → 64MB | insert-heavy CDR workload; auto default caps at 16MB; restart required |
| PG `checkpoint_completion_target` | → 0.9 | PG14+ default, pinned against legacy overrides |
| PG `random_page_cost` | → 1.1 | SSD persistent disk |
| PG `effective_io_concurrency` | → 200 | SSD prefetch depth |
| PG `autovacuum_vacuum_cost_limit` | → 1000 | default 200 is anemic for cdrs churn; SSD absorbs it |

**Deliberately untouched:** max_connections, listen_addresses, wal_level,
archive_*/pgBackRest, replication (slots/senders/workers),
shared_preload_libraries, statement_timeout, qryn/heplify env. Nothing in the
replica ≥-primary parameter set is changed, so **no replica needs a matching
edit** and replication/backups are unaffected.

**auto.conf trap:** `ALTER SYSTEM` output (`postgresql.auto.conf`) overrides
conf.d. `apply_pg_32gb.sh` scans for conflicting entries and prints the exact
`ALTER SYSTEM RESET` one-liners if found — run them before the restart.

## Apply order (reasoned)

Compose limits are **caps** — safe to apply while the box is still 16GB. The
PG drop-in (8GB shared_buffers) must only take effect **at** 32GB — and the
resize itself is a full VM stop/start, so stage everything first and let the
resize boot apply the PG tuning: **one restart total, no extra PG outage.**

1. **Pull:** `cd /opt/revup && sudo git pull`
2. **Compose (per-service, no dependents restarted):**
   `sudo docker compose -f docker-compose.services.yml up -d --no-deps api clickhouse-server grafana victoriametrics`
   (brief per-service blips: API a few seconds; CH/grafana/VM are not call-path. clickhouse-server recreate also picks up the users.xml 4GB query cap.)
3. **Stage PG tuning (writes file only, PG untouched, still running old settings):**
   `sudo REVUP_PG_TUNE_FORCE=1 /opt/revup/scripts/services-tuning/apply_pg_32gb.sh`
   Run any `ALTER SYSTEM RESET` lines it warns about. Record the before-state:
   `sudo /opt/revup/scripts/services-tuning/show_pg_tuning.sh`
4. **Resize:** stop VM → `gcloud compute instances set-machine-type services --zone=us-east1-b --machine-type=e2-highmem-4` → start. PG boots straight into the tuned config; containers come back with the new limits.
5. If you resize **first** instead: run step 3 without FORCE afterwards, then `sudo systemctl restart postgresql@16-main` at a chosen moment (brief East DID-lookup + fleet-wide write blip; replicas just reconnect).

## Verify

- `sudo /opt/revup/scripts/services-tuning/show_pg_tuning.sh` — every param shows the new value, `source=configuration file`, sourcefile `…conf.d/90-revup-32gb.conf`, `pending_restart=f`
- `sudo docker stats --no-stream` — new limits visible in MEM USAGE / LIMIT
- Replication healthy: `sudo -u postgres psql -X -c "SELECT client_addr, state, replay_lag FROM pg_stat_replication"`
- Homer big-range search no longer 500s at 2GB: watch `sudo docker logs --tail 50 voip-clickhouse` for MEMORY_LIMIT_EXCEEDED while running a wide TroubleshootingPage search
- Grafana NOC boards + VictoriaMetrics `:8428/health` still green

## Rollback

- **PG:** `sudo rm /etc/postgresql/16/main/conf.d/90-revup-32gb.conf && sudo systemctl restart postgresql@16-main`
- **Compose + users.xml:** `cd /opt/revup && sudo git revert <commit> && sudo git pull` then re-run the step-2 `up -d --no-deps` line
- Both are independent; either can roll back alone.
