-- Migration: RCF fraud controls on `customers`
-- ============================================================================
-- Adds two per-customer fraud-control columns that the FreeSWITCH RCF call path
-- reads at call time (synchronous PG lookup in Lua) and that the admin customer
-- API exposes for toggling. These EXACT names/types are a cross-domain contract
-- with the telephony expert -- do NOT rename or retype them:
--
--   international_calling_enabled BOOLEAN NOT NULL DEFAULT false
--       Gates non-NANP (international) destinations. RCF call routing refuses an
--       international forward/dial for a customer without this flag; the API
--       (routers/rcf.py) also refuses to PROVISION an international forward_to /
--       failover_to unless this is true (defense in depth).
--
--   max_concurrent_calls INTEGER NOT NULL DEFAULT 30
--       Per-customer concurrent-call cap enforced by the telephony call path.
--
-- Why a migration (not init/): init/*.sql only runs on first `initdb`. Existing
-- databases (production services VM + any already-initialized local volume) must
-- get these columns via this migration.  **Migrations are currently applied BY
-- HAND** -- there is no Alembic/auto-runner yet (infra may add one later). This
-- file MUST be run on every environment that already has a `customers` table,
-- BEFORE deploying the API build that references the new columns.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS is a no-op when the column already exists,
-- so this file is safe to run repeatedly.
--
-- Fast + safe on a populated table: adding a NOT NULL column WITH a *constant*
-- DEFAULT is a metadata-only change on PostgreSQL 11+ (no full table rewrite),
-- so this does not lock `customers` against reads/writes for any meaningful time.
--
-- Permissions: the `freeswitch` and `api` roles already hold table-level grants
-- on `customers` (02_schema_core.sql: GRANT SELECT ... TO freeswitch; GRANT ALL
-- ... TO api). In PostgreSQL a table-level grant automatically covers columns
-- added later, so no additional GRANT is required for the call path to read
-- these columns.
--
-- Apply (production services VM, bare-metal PostgreSQL, DB 'voip'):
--
--   sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/migrations/2026-07-01_customer_fraud_controls.sql
--
-- Verify afterwards:
--
--   sudo -u postgres psql -d voip -c "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name='customers' AND column_name IN ('international_calling_enabled','max_concurrent_calls') ORDER BY column_name;"
--
-- Expected: two rows, both is_nullable = NO, defaults false and 30.
-- ============================================================================

ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS international_calling_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS max_concurrent_calls INTEGER NOT NULL DEFAULT 30;
