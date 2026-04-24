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
| `04_schema_fraud.sql` | Fraud detection: `fraud_rules`, `high_risk_prefixes`, `customer_destination_whitelist`. Rate tables: `rate_tables`, `rates`, `customer_rate_assignments`. Includes `get_rate()` and `rate_cdr()` functions. |
| `05_schema_cdr.sql` | CDR hypertable (TimescaleDB): `cdrs` with weekly partitioning, compression after 1 day, retention 90 days. Continuous aggregate `cdr_hourly_stats`. RTP quality metrics columns. |
| `06_seed_data.sql` | Test customers, DIDs, trunks, rates. Test RCF: +15551234567 → +15559876543. |
| `07_cps_tiers.sql` | CPS tier system: `cps_tiers`, `call_path_packages`, `cps_usage_log`. Triggers for auto-tier assignment and change logging. |
| `08_carrier_gateways.sql` | `carrier_gateways` table. Seeds Bandwidth Dallas (67.231.2.12) and LA (216.82.238.134). |
| `09_schema_users.sql` | `users` table for JWT auth. Seeds admin@customvoip.com / admin123. |
| `11a_schema_did_assignment.sql` | UCaaS DID-to-extension mapping (Full-System branch feature). |
| `14_granite_accounts.sql` | **Production seed:** Granite Telephony customer, admin user, RCF DID +16174544217 → +17744045256. |
| `16_cdr_detail_columns.sql` | Idempotent ALTER TABLE adding SIP detail columns to CDRs. |

## Hot-Path Tables (Call Setup)

These are queried on EVERY inbound call — must be fast:

- **`rcf_numbers`** — DID → forward_to lookup. Hash index on `did`. Queried by `inbound_router.lua` via `db_client.lua`.
- **`customers`** — Status/limits check. Joined with rcf_numbers. Index on `(id, status)`.
- **`trunk_auth_ips`** — IP-based SIP trunk auth. Hash index on `ip_address`. Queried by Kamailio sqlops.
- **`high_risk_prefixes`** — IRSF fraud check. text_pattern_ops index for prefix matching.

## Database Users

| User | Permissions | Used By |
|------|------------|---------|
| `voip` | Superuser (owner) | Schema migrations, admin |
| `freeswitch` | SELECT on core tables, INSERT on cdrs | FreeSWITCH Lua scripts via PgBouncer |
| `api` | ALL on most tables | FastAPI application |

## PgBouncer Configuration

File: `pgbouncer.ini`

- **Pool mode:** `transaction` — connections returned to pool after each transaction
- **Max client connections:** 1000
- **Default pool size:** 100 per database
- **Auth:** MD5 via `userlist.txt`
- **Listen:** 0.0.0.0:6432

**Critical:** asyncpg (used by FastAPI) must use `statement_cache_size=0` because PgBouncer transaction mode doesn't support prepared statements. This is configured in the API's `database.py`.

## Multi-Zone Replication (Production)

- **Primary:** us-east1-b (services VM)
- **Replicas:** us-west1-b, us-central1-b (streaming replication)
- Each zone's FreeSWITCH reads from the local replica for DID lookups
- All writes (provisioning, CDRs) go to the primary
- Replication lag: ~100-500ms (acceptable for routing data)

## Adding a New Table

1. Create `NN_schema_name.sql` in `init/` with appropriate numbering
2. Include proper indexes (hash for exact lookups, btree for range queries)
3. Grant permissions: `GRANT SELECT ON new_table TO freeswitch; GRANT ALL ON new_table TO api;`
4. If table is on the call path, add a hash index and test query latency < 5ms
5. For production: run the SQL manually on the bare PG instance (init scripts only run on first `initdb`)
