# PostgreSQL + PgBouncer — Database Layer

## Overview

PostgreSQL 16 with TimescaleDB extension, fronted by PgBouncer for connection pooling.
In production, PostgreSQL runs **bare on the VM** (systemd), not in Docker. The Docker
setup in this directory is for local development only.

**Production:** Bare PG on services VM (10.142.0.103), PgBouncer on :6432, PG on :5432.
**Local dev:** Docker container with PgBouncer built in.

## Schema Files (Init Order)

Scripts in `init/` run alphabetically on first database creation:

| File | Purpose |
|------|---------|
| `01_extensions.sql` | TimescaleDB, pg_stat_statements, btree_gin. Creates `freeswitch` and `api` DB users. |
| `02_schema_core.sql` | **Core tables:** `customers`, `rcf_numbers`, `sip_trunks`, `trunk_auth_ips`, `trunk_dids`. Hot-path indexes (hash indexes for O(1) DID lookup). |
| `03_schema_api.sql` | API Calling: `api_credentials`, `api_dids`, `active_calls`. |
| `04_schema_fraud.sql` | Fraud detection: `fraud_rules`, `high_risk_prefixes`, `customer_destination_whitelist`. Rate tables: `rate_tables`, `rates`, `customer_rate_assignments`. |
| `05_schema_cdr.sql` | CDR hypertable (TimescaleDB): `cdrs` with weekly partitioning, compression after 1 day, retention 90 days. Continuous aggregate `cdr_hourly_stats`. RTP quality metrics columns. **Defines `get_rate()` (longest-prefix rate match) and `rate_cdr()` (rates a CDR) functions** (granted to freeswitch/api). |
| `06_seed_data.sql` | **Rates only** (production baseline). Default rate table + sample US/UK rates. Test customers/DIDs/trunks were REMOVED for RCF-V1 production — that data now lives in `14_granite_accounts.sql`. No test RCF DID here. |
| `07_cps_tiers.sql` | CPS tier system: `cps_tiers`, `cps_usage_log`, `cps_tier_changes` (tier-change audit log), `call_path_packages`. Triggers for auto-tier assignment and change logging. |
| `08_carrier_gateways.sql` | `carrier_gateways` table. Seeds Bandwidth Dallas (67.231.2.12) and LA (216.82.238.134). |
| `09_schema_users.sql` | `users` table for JWT auth. Seeds admin@customvoip.com / admin123. |
| `11a_schema_did_assignment.sql` | UCaaS DID-to-extension mapping. **Non-functional on RCF-V1:** it `ALTER TABLE extensions` but the `extensions` table is created by `10_schema_ucaas.sql`, which does NOT exist on this branch. A fresh RCF-V1 init would FAIL on this script. Full-System branch only. |
| `14_granite_accounts.sql` | **Production seed:** Granite Telephony customer, admin user, RCF DID +16174544217 → +17744045256. |
| `16_cdr_detail_columns.sql` | Idempotent ALTER TABLE adding SIP detail columns to CDRs. |
| `17_did_inventory.sql` | `did_inventory` table — tracks all Bandwidth DIDs and their assignment to customers/products (backs the number_inventory API). |
| `18_sbc_id_column.sql` | Idempotent ALTER adding `cdrs.sbc_id VARCHAR(30)` + partial index, for SBC failover tracking (backs `/v1/sbc/stats`). |
| `19_onboarding_requests.sql` | `onboarding_requests` table — backs the onboarding intake/approval router. |
| `20_rcf_max_channels.sql` | Idempotent ALTER adding `rcf_numbers.max_channels INT DEFAULT 0` (0 = unlimited); FreeSWITCH enforces via limit_hash. |
| `21_cdr_export.sql` | Idempotent: `cdrs.exported_at` watermark + partial index; `cdr_export_log` / `cdr_export_lock` tables (backs the Equinox→FileMage CDR forwarder). Apply manually on prod primary. |
| `22_number_routing.sql` | **On-net routing oracle:** `CREATE OR REPLACE VIEW number_routing` — `UNION ALL` over rcf_numbers/api_dids/trunk_dids JOIN customers, canonical columns, `GRANT SELECT TO freeswitch, api`. **Unfiltered on enabled/active** (resolver tells "not ours" from "ours but disabled"). Point lookup by `did` hits each arm's hash index. Apply manually on prod primary → replicates to all zones (view must exist before any replica is re-cloned). |
| `23_onnet_cdr_columns.sql` | Idempotent ALTER adding `cdrs.origin_customer_id INT`, `terminating_customer_id INT`, `on_net BOOLEAN DEFAULT false`, `on_net_hops SMALLINT` + partial index on `origin_customer_id`. Records both parties of an on-net call; `customer_id` stays the terminal so `rate_cdr()` is unchanged. Apply manually on prod primary. |
| `40_carrier_trunks.sql` | **Multi-carrier trunk registry:** `carrier_trunks` table (one row per carrier signaling IP; UNIQUE source_ip + UNIQUE (carrier,pop)) seeded with Bandwidth Dallas/LA + Sinch Denver/Chicago; **columns carrier/pop/trunk_group/source_ip/test_tn/direction/cps_limit/enabled are the Kamailio sqlops CONTRACT** (SELECT-granted to `freeswitch`, ALL to `api`). Also: idempotent ALTER adding `cdrs.inbound_carrier VARCHAR(20)` + `inbound_carrier_pop VARCHAR(50)` (per-carrier CDR attribution), and the `carrier_trunk_health` view replace widening setid (2,3) → (2,3,6,7) for the Sinch dispatcher groups (25 is amended in place for fresh installs; prod applies this file). Apply manually on prod primary. |
| `41_did_carrier_source.sql` | **DID carrier attribution (manual intake):** adds `did_inventory.carrier_trunk_id` (FK → `carrier_trunks`, ON DELETE SET NULL; NULL = implicit Bandwidth) and `source VARCHAR(20) NOT NULL DEFAULT 'bandwidth_sync'`, CHECK `('bandwidth_sync','manual')` via the same name-agnostic drop-and-recreate DO block as 34 (named `did_inventory_source_check`); partial index on non-NULL `carrier_trunk_id`; re-asserts 17's grants. `source` is the sync OWNERSHIP BOUNDARY — `POST /v1/numbers/sync` only manages `bandwidth_sync` rows, so manually intaken DIDs (`POST /v1/numbers/add`, e.g. Sinch) are invisible to it. Requires 40. Apply manually on prod primary. |
| `42_carrier_priorities.sql` | **Table-driven carrier termination redundancy:** adds `carrier_trunks.priority INT NOT NULL DEFAULT 100` (lower = tried first) + per-zone overrides `priority_east`/`priority_west`/`priority_central` (NULL = use `priority`). **THE FS TERMINATION CONTRACT** — FreeSWITCH's outbound failover Lua builds its per-zone attempt list with `SELECT carrier, pop, host(source_ip) AS term_ip, COALESCE(priority_<z>, priority) AS eff_priority FROM carrier_trunks WHERE direction IN ('outbound','both') AND enabled = true ORDER BY eff_priority, id` — never rename these columns (`source_ip` doubles as the termination target; a future `term_ip` column is the documented, unbuilt escape hatch). Seeds preserve today's behavior via default-guarded UPDATEs (never clobber operator edits): bandwidth/dallas 10 + west 20, bandwidth/la 20 + west 10, sinch denver 10 / chicago 20 (no overrides; direction stays `inbound` so Sinch never terminates until an operator flips it). Also adds `did_inventory.carrier VARCHAR(50)` (NULL = legacy implicit Bandwidth) + backfill from the trunk's carrier else `'bandwidth'`; readers COALESCE(d.carrier, ct.carrier, 'bandwidth'). No new indexes (tiny table / non-sargable filter); re-asserts 40/41 grants. Requires 40 + 41. Apply manually on prod primary. |

## Hot-Path Tables (Call Setup)

These are queried on EVERY inbound call — must be fast:

- **`rcf_numbers`** — DID → forward_to lookup. Hash index on `did`. Queried by `inbound_router.lua` via `db_client.lua`.
- **`number_routing`** (view) — on-net oracle. `resolve_destination(forward_to)` does one `WHERE did=$1` point lookup that pushes into each product arm's DID hash index (`idx_{rcf,api,trunk}_did_lookup`) → 3 point lookups + small joins, sub-ms, 0/1 row. Runs on EVERY RCF forward. Defined on the primary, inherited by every replica.
- **`customers`** — Status/limits check. Joined with rcf_numbers (and every `number_routing` arm). Index on `(id, status)`.
- **`trunk_auth_ips`** — IP-based SIP trunk auth. Hash index on `ip_address`. Queried by Kamailio sqlops.
- **`carrier_trunks`** — carrier-IP trust fallback for unknown-source INVITEs (Bandwidth + Sinch) AND the per-zone termination-order oracle (migration 42: `COALESCE(priority_<z>, priority)`, queried by FreeSWITCH's outbound failover per call). UNIQUE index on `source_ip` (point lookup); the termination scan rides `idx_carrier_trunks_enabled_direction` over a handful of rows. Queried by Kamailio sqlops + FS; admin CRUD via `/v1/carrier-trunks`.
- **`high_risk_prefixes`** — IRSF fraud check. text_pattern_ops index for prefix matching.

## Database Users

| User | Permissions | Used By | Created By |
|------|------------|---------|-----------|
| `voip` | Superuser (owner) | Schema migrations, admin | **Image `POSTGRES_USER`** — created by the Postgres entrypoint, NOT by init SQL |
| `freeswitch` | SELECT on core tables, INSERT on cdrs | FreeSWITCH Lua scripts via PgBouncer | `01_extensions.sql` (`CREATE USER freeswitch`) |
| `api` | ALL on most tables | FastAPI application | `01_extensions.sql` (`CREATE USER api`) |

Note: `01_extensions.sql` only creates `freeswitch` and `api`. The `voip` superuser comes from the Docker image's `POSTGRES_USER` env (or is provisioned manually on the bare-metal production instance).

## PgBouncer Configuration

File: `pgbouncer.ini`

- **Pool mode:** `transaction` — connections returned to pool after each transaction
- **Max client connections:** 1000
- **Default pool size:** 100 per database
- **Auth:** MD5 via `userlist.txt`
- **Listen:** 0.0.0.0:6432

**Critical:** asyncpg (used by FastAPI) must use `statement_cache_size=0` because PgBouncer transaction mode doesn't support prepared statements. This is configured in the API's `database.py`.

## Multi-Zone Replication — LIVE (as of 2026-07-22)

> **Status: implemented in production.** Streaming physical replication is live.
> The local-dev Docker setup in this directory is still single-node
> (`pgbouncer.ini` → `host=127.0.0.1`), but the **bare-metal production** VMs run
> a real primary + three replicas. Do NOT assume single-node when reasoning about
> prod failover or read routing.

**Production topology (bare-metal, not Docker):**

| Node | Role | IP | Zone |
|------|------|----|------|
| `services` | **Primary** (read-write) | 10.142.0.103 | us-east1-b |
| `east-db-standby` | HA hot standby (failover target) | 10.142.0.87 | us-east1-c |
| `west-db` | West-zone read replica (local DID lookups) | 10.138.0.2 | us-west1-b |
| `sandbox_replica` | Dev/unified sandbox replica | 10.142.0.102 | us-east1-b |

- Streaming replication via the `replicator` role + one physical slot per standby (`east_standby`, `west_standby`, `sandbox_replica`). Replay lag ~2ms same-region, ~130ms cross-region. TimescaleDB 2.26.3, PG 16.
- **Each zone runs its OWN PgBouncer** on the local replica (`:6432` → local `:5432`, transaction pool, `scram-sha-256`). Zone FS/SBC point `DB_HOST` at the local replica; **all writes (CDRs, provisioning) go to the East primary via the API** (`API_HOST` stays East — a replica is read-only).
- **Runbooks:** failover = `docs/runbooks/DB_FAILOVER_RUNBOOK.md` (promote `east-db-standby`); restore/PITR = `docs/runbooks/DB_RESTORE_RUNBOOK.md` (pgBackRest).
- **Adding a new zone replica (Central reuses this):** `pg_basebackup` from the primary → recovery params (`max_worker_processes` etc.) **≥ primary** → **TimescaleDB pinned to the EXACT primary extension version** (`timescaledb-2-postgresql-16=<ver>` or PG won't start) → strip any `recovery_target`/`restore_command` from `postgresql.auto.conf` (clones inherit them from a prior `--type=immediate` restore and then pause instead of streaming) → stand up local PgBouncer (userlist generated from the replica's own `pg_authid`) + a `voip-media-<zone>`→replica `:6432` firewall rule (the media subnet is not covered by `default-allow-internal`).
- **Gotchas:** replication slots are NOT in pgBackRest backups — recreate them after any restore before re-cloning standbys; Debian keeps PG config in `/etc`, so use `pg_ctlcluster` (not `pg_ctl -D`).

## Adding a New Table

1. Create `NN_schema_name.sql` in `init/` with appropriate numbering
2. Include proper indexes (hash for exact lookups, btree for range queries)
3. Grant permissions: `GRANT SELECT ON new_table TO freeswitch; GRANT ALL ON new_table TO api;`
4. If table is on the call path, add a hash index and test query latency < 5ms
5. For production: run the SQL manually on the bare PG instance (init scripts only run on first `initdb`)
