-- ==========================================================================
-- 65_cdr_premium_fallback.sql
-- Premium routing fallback on the CDR (TED CRAG Admin redesign, contract C7).
--
-- cdrs.term_premium_fallback BOOLEAN — true on the A-leg row of a call whose
-- paying customer is 'premium' (customers.traffic_grade, 63) and that was
-- actually attempted on a carrier NOT marked Tier 1 (carrier_trunks.tier1,
-- 64) — every Tier 1 attempt failed, or none was eligible. FreeSWITCH sets the
-- channel variable term_premium_fallback=1 (inbound_router.lua RCF / IVR
-- egress, trunk_outbound.lua / api_outbound.lua 8YY); the CDR ingest writes
-- it with ONE guarded UPDATE of the A row, only when the variable is present
-- (every other CDR's ingest is unchanged). NULL = not a premium fallback
-- (incl. every CDR before this release). Staff-only (tenant CDR allowlist).
--
-- Plain SQL, idempotent: ADD COLUMN IF NOT EXISTS with no DEFAULT / CHECK /
-- index (metadata-only on the compressed hypertable — the 47/48/60 form),
-- COMMENT, role-guarded belt-and-braces grants. Replayed on every scratch
-- cdrs by tests/cdr_schema.py.
--
-- PRODUCTION NOTE: apply MANUALLY on the East primary as a SUPERUSER; it
-- replicates to every zone replica. Order-independent of the API build (the
-- ingest logs and skips the UPDATE while the column is missing):
--     hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/65_cdr_premium_fallback.sql
-- Never DROP COLUMN (rollback = stop writing).
-- ==========================================================================

ALTER TABLE cdrs ADD COLUMN IF NOT EXISTS term_premium_fallback BOOLEAN;

COMMENT ON COLUMN cdrs.term_premium_fallback IS
    'Premium call attempted on a non-Tier-1 carrier (Tier 1 failed or none eligible) — A-leg; NULL otherwise (65).';

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
