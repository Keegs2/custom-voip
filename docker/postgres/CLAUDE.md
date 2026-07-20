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
| `10_schema_ucaas.sql` | **UCaaS core:** `extensions`, presence, voicemail, `user_devices`. Now present on the unified branch — establishes the `extensions` table that `11a` and `11d` extend. |
| `11_schema_chat.sql` | Chat / messaging tables for UCaaS (rooms, messages, membership). |
| `11a_schema_did_assignment.sql` | UCaaS DID-to-extension mapping. `ALTER TABLE extensions …` — now inits clean because `10_schema_ucaas.sql` (which creates `extensions`) runs first on the unified branch. |
| `11b_add_ucaas_type.sql` | Adds the `ucaas` account type to `customers`; seeds a UCaaS test customer (explicit id=5). |
| `11c_ucaas_enabled_flag.sql` | Adds the `ucaas_enabled` flag column to `customers`. |
| `11d_per_customer_extensions.sql` | Per-customer extension uniqueness (namespacing) on `extensions`. |
| `12_multi_tenant_extensions.sql` | Multi-tenant extension namespacing / tenant scoping. |
| `13_schema_conferencing.sql` | Conferencing tables for UCaaS (conference rooms, participants). |
| `14_granite_accounts.sql` | **Production seed:** Granite Telephony customer (explicit id=1), admin user, RCF DID +16174544217 → +17744045256. |
| `15_schema_documents.sql` | Shared document library for customer organizations. |
| `16_cdr_detail_columns.sql` | Idempotent ALTER TABLE adding SIP detail columns to CDRs. |
| `17_did_inventory.sql` | `did_inventory` table — tracks all Bandwidth DIDs and their assignment to customers/products (backs the number_inventory API). |
| `18_sbc_id_column.sql` | Idempotent ALTER adding `cdrs.sbc_id VARCHAR(30)` + partial index, for SBC failover tracking (backs `/v1/sbc/stats`). |
| `19_onboarding_requests.sql` | `onboarding_requests` table — backs the onboarding intake/approval router. |
| `20_rcf_max_channels.sql` | Idempotent ALTER adding `rcf_numbers.max_channels INT DEFAULT 0` (0 = unlimited); FreeSWITCH enforces via limit_hash. |
| `22_webhook_signing.sql` | Adds `customers.webhook_signing_secret` (HMAC-SHA256 key); FS signs programmable-voice webhook POSTs with it. |
| `23_schema_ivr.sql` | `ivr_flows` (+ related) tables for the programmable-voice / IVR builder. |
| `25_schema_recordings.sql` | `recordings` table — call/conference recording metadata + object-storage keys (backs the recordings ingest/serve API). |
| `99_resync_sequences.sql` | **MUST RUN LAST** (sorts after every schema/seed script). Advances owning sequences past explicitly-seeded ids (Granite customer 1, UCaaS customer 5, admin user, …) so `nextval()` does not collide with seeded rows. Renumbered `24_`→`26_`→`99_` as schema files grew past `33_`, so it always sorts last. |

> **Fresh init is clean.** The unified branch ships `10–13`, `15`, `22`, `23`, `25`, `26` (the previously-missing UCaaS/conferencing/documents/recordings schemas), so the whole `init/` set applies in order on a fresh `initdb` with no failures. The earlier warning that `11a` fails on fresh init no longer applies — `10_schema_ucaas.sql` creates `extensions` before `11a`/`11d` alter it.

## Hot-Path Tables (Call Setup)

These are queried on EVERY inbound call — must be fast:

- **`rcf_numbers`** — DID → forward_to lookup. Hash index on `did`. Queried by `inbound_router.lua` via `db_client.lua`.
- **`customers`** — Status/limits check. Joined with rcf_numbers. Index on `(id, status)`.
- **`trunk_auth_ips`** — IP-based SIP trunk auth. Hash index on `ip_address`. Queried by Kamailio sqlops.
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

## Multi-Zone Replication — PLANNED (NOT implemented in this repo)

> **Status: aspirational design only.** There is currently ZERO replication
> configuration in `docker/postgres/`. No `primary_conninfo`, no replica role,
> no standby tuning, no recovery/standby signal. `pgbouncer.ini` points at a
> single host (`host=127.0.0.1 port=5432`). East runs as a standalone primary.
> Read this section as the target design for the multi-datacenter expansion,
> NOT as the current state. Do not assume replicas exist when reasoning about
> failover or read routing today.

Target design once the West/Central zones come online:

- **Primary:** us-east1-b (services VM)
- **Replicas (planned):** us-west1-b, us-central1-b via streaming replication — must be configured (replica role, `primary_conninfo`, standby tuning) before any zone can read locally
- Each zone's FreeSWITCH would read from the local replica for DID lookups
- All writes (provisioning, CDRs) go to the primary
- Expected replication lag: ~100-500ms (acceptable for routing data)
- **Until configured:** all zones must reach the East primary directly for DID lookups (cross-zone DB traffic), which is the current behavior.

## Adding a New Table

1. Create `NN_schema_name.sql` in `init/` with appropriate numbering
2. Include proper indexes (hash for exact lookups, btree for range queries)
3. Grant permissions: `GRANT SELECT ON new_table TO freeswitch; GRANT ALL ON new_table TO api;`
4. If table is on the call path, add a hash index and test query latency < 5ms
5. For production: run the SQL manually on the bare PG instance (init scripts only run on first `initdb`)
