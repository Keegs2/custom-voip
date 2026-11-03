-- ==========================================================================
-- 63_admin_redesign.sql
-- TED CRAG Admin redesign (owner decisions 2026-11-03; TED <-> CRAG contract
-- C1-C7).
--
-- WHAT THIS DOES (one transaction, idempotent — re-running is a no-op):
--   1. GRANT DELETE ON live_trunk_stats TO api — DELETE /v1/trunks/{id} (C1)
--      removes the deleted trunk's live-stats rows (26 granted the api role
--      SELECT/INSERT/UPDATE only). Without this grant the API skips that
--      delete and the rows just turn `stale` in live_trunk_health.
--   2. Traffic pattern (C5): customers.traffic_grade becomes exactly
--      'enterprise' | 'premium' (owner decision: it decides ONLY which carriers
--      deliver the customer's calls; Premium = Tier 1 carriers only, with a
--      fall back to every carrier when no Tier 1 carrier is left).
--        * existing 'standard' / 'economy' / NULL -> 'enterprise'; 'premium'
--          stays 'premium' — NOTE: a customer already 'premium' (14's
--          Granite Telephony seed) switches to Tier-1-only routing as soon
--          as the FreeSWITCH Lua of the same release is pulled;
--        * DEFAULT 'enterprise';
--        * the CHECK (02's inline customers_traffic_grade_check, found by
--          definition, name-agnostic) is replaced by
--          customers_traffic_grade_check CHECK (traffic_grade IN
--          ('enterprise', 'premium')) — VARCHAR(10) still fits 'enterprise'.
--      Historic cdrs.traffic_grade values are left alone (no CHECK there).
--   (Tier 1 carriers, C6, are 64_carrier_tier1.sql: carrier_trunks only.)
--
-- LOCKING: customers is read on the call path (and the lock is WAL-replayed
-- on every zone replica). The CHECK swap takes a brief ACCESS EXCLUSIVE lock
-- on customers (a tiny table: the validating scan is milliseconds);
-- lock_timeout makes the migration FAIL FAST instead of queueing call-setup
-- reads behind it. If it times out, just re-run it.
--
-- ORDER: apply BEFORE the API build of the same release (that build creates
-- customers with traffic_grade 'enterprise', which the old CHECK refuses).
-- The OLD API keeps working on reads; between this migration and the API
-- rebuild an old-API customer CREATE (it sends 'standard') would fail the new
-- CHECK, so rebuild the API right after applying this file.
--
-- PRODUCTION NOTE: init scripts only run on the first initdb of a fresh data
-- directory. Apply MANUALLY on the bare-metal East primary (services VM) as a
-- SUPERUSER; it replicates to every zone replica:
--     hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/63_admin_redesign.sql
--
-- Verification (after applying):
--     sudo -u postgres psql -d voip -f /opt/revup/scripts/db/check_migrations.sql
--   Expect "63_admin_redesign | applied".
-- ==========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- --------------------------------------------------------------------------
-- 1. live_trunk_stats: the api role may delete a deleted trunk's rows (C1).
-- --------------------------------------------------------------------------
DO $$
BEGIN
    IF to_regclass('public.live_trunk_stats') IS NOT NULL
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api') THEN
        GRANT DELETE ON live_trunk_stats TO api;
    END IF;
END
$$;

-- --------------------------------------------------------------------------
-- 2. customers.traffic_grade: 'enterprise' | 'premium' (C5).
-- --------------------------------------------------------------------------
DO $$
DECLARE
    con RECORD;
BEGIN
    -- Drop every CHECK on customers that constrains traffic_grade and is not
    -- already the new two-value rule (re-runs keep the new one).
    FOR con IN
        SELECT c.conname
          FROM pg_constraint c
         WHERE c.conrelid = 'customers'::regclass
           AND c.contype = 'c'
           AND pg_get_constraintdef(c.oid) LIKE '%traffic_grade%'
           AND pg_get_constraintdef(c.oid) NOT LIKE '%enterprise%'
    LOOP
        EXECUTE format('ALTER TABLE customers DROP CONSTRAINT %I', con.conname);
    END LOOP;
END
$$;

UPDATE customers
   SET traffic_grade = 'enterprise'
 WHERE traffic_grade IS DISTINCT FROM 'premium'
   AND traffic_grade IS DISTINCT FROM 'enterprise';

ALTER TABLE customers ALTER COLUMN traffic_grade SET DEFAULT 'enterprise';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'customers'::regclass
                      AND conname = 'customers_traffic_grade_check') THEN
        ALTER TABLE customers ADD CONSTRAINT customers_traffic_grade_check
            CHECK (traffic_grade IN ('enterprise', 'premium'));
    END IF;
END
$$;

COMMIT;
