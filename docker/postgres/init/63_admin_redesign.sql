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
--
-- LOCKING: GRANT takes a brief lock on the tiny live_trunk_stats table only.
-- lock_timeout makes the migration fail fast instead of queueing; if it times
-- out, just re-run it.
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

COMMIT;
