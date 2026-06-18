-- ==========================================================================
-- 22_webhook_signing.sql
-- Per-customer webhook signing secret for the programmable-voice product.
--
-- FreeSWITCH signs every webhook POST with HMAC-SHA256 over (URL + sorted
-- params) using this secret and sends it as the `X-Revup-Signature` header.
-- The API exposes the secret to admins/owners and can rotate it.
--
-- Idempotent: safe to re-run and safe on a fresh init. Runs AFTER
-- 02_schema_core (creates `customers`) and AFTER 14_granite_accounts
-- (seeds the Granite customer), so the backfill covers all seeded customers.
-- ==========================================================================

BEGIN;

-- pgcrypto provides gen_random_bytes(). The base TimescaleDB image does NOT
-- enable it by default (only timescaledb/pg_stat_statements/btree_gin in
-- 01_extensions.sql), so enable it here. IF NOT EXISTS keeps this idempotent.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Add the secret column. IF NOT EXISTS makes re-runs a no-op.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS webhook_signing_secret TEXT;

-- Backfill a cryptographically-secure 256-bit secret (64 hex chars) for any
-- existing customer that lacks one. New customers get a secret from the API at
-- creation time; this covers customers seeded before this migration (e.g.
-- Granite) and any provisioned out-of-band.
UPDATE customers
   SET webhook_signing_secret = encode(gen_random_bytes(32), 'hex')
 WHERE webhook_signing_secret IS NULL
    OR webhook_signing_secret = '';

COMMENT ON COLUMN customers.webhook_signing_secret IS
  'Per-customer HMAC-SHA256 secret. FreeSWITCH signs webhook POSTs with '
  'base64(HMAC_SHA256(secret, url + concat(sorted POST params))) in the '
  'X-Revup-Signature header. Rotatable via the API.';

-- The freeswitch role already has table-level SELECT on `customers` (granted in
-- 02_schema_core.sql), which automatically covers newly-added columns. Re-grant
-- explicitly so the privilege is self-documented at the point the column is
-- introduced and stays valid for the Lua db_client join that reads this column.
GRANT SELECT ON customers TO freeswitch;

COMMIT;
