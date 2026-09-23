-- ==========================================================================
-- 48_cdr_call_legs.sql
-- CDR A/B leg split — columns only (NO index; the index is migration 49).
--
-- Contract: docs/CDR_LEG_SPLIT_CONTRACT.md (wins over the plan);
-- background: docs/CDR_BILLING_REMEDIATION_PLAN.md §2 step 3.
--
-- Columns (all nullable, NO default):
--   * leg          VARCHAR(1)  'A' = ingress (the call row) | 'B' = one carrier
--                              bridge attempt. NULL = legacy row written before
--                              this migration (= an A-leg).
--   * call_id      VARCHAR(64) the A-leg channel uuid. On an A-leg call_id == uuid;
--                              on a B-leg it is its A-leg's uuid.
--   * leg_attempt  SMALLINT    1-based carrier bridge attempt number (B-legs
--                              only; NULL on A-legs).
--
-- Two conventions make every historical row correct with zero backfill:
--   * one-row-per-call predicate:  leg IS DISTINCT FROM 'B'
--   * call identity:               COALESCE(call_id, uuid)
--
-- cdrs is a TimescaleDB hypertable with compressed chunks: ADD COLUMN with NO
-- DEFAULT is metadata-only and supported on compressed hypertables. A non-NULL
-- DEFAULT is the form that trips TimescaleDB — never add one here. Rollback is
-- "stop writing them" — NEVER `DROP COLUMN` (a rewrite on a compressed
-- hypertable). Same form as 47.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; grants role-guarded + re-assertable.
--
-- PRODUCTION NOTE: init scripts ONLY run on the first initdb. Apply MANUALLY on
-- the East primary (services VM) — replicates to every standby/replica:
--     hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/48_cdr_call_legs.sql
-- Apply BEFORE the API build that binds $58..$60 (that build still lands every
-- A-leg row without these columns via its tiered INSERT fallback, but its
-- read endpoints filter on `leg` and would 500 until the columns exist).
-- Requires 05 (and 47 for the API's full 60-column INSERT).
-- ==========================================================================

ALTER TABLE cdrs
    ADD COLUMN IF NOT EXISTS leg         VARCHAR(1),
    ADD COLUMN IF NOT EXISTS call_id     VARCHAR(64),
    ADD COLUMN IF NOT EXISTS leg_attempt SMALLINT;

COMMENT ON COLUMN cdrs.leg IS
    'A = ingress/call row, B = one carrier bridge attempt. NULL = legacy (pre-48) A-leg. One-row-per-call predicate: leg IS DISTINCT FROM ''B''.';
COMMENT ON COLUMN cdrs.call_id IS
    'A-leg channel uuid (== uuid on an A-leg). NULL on legacy rows. Call identity: COALESCE(call_id, uuid).';
COMMENT ON COLUMN cdrs.leg_attempt IS
    '1-based carrier bridge attempt number of a B-leg row. NULL on A-legs.';

-- Belt-and-braces grants (table-level privileges already cover new columns);
-- role-guarded so the file never aborts on a cluster without the role.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api') THEN
        EXECUTE 'GRANT ALL ON cdrs TO api';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_ro') THEN
        EXECUTE 'GRANT SELECT ON cdrs TO grafana_ro';
    END IF;
END
$$;
