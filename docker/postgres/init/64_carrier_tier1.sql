-- ==========================================================================
-- 64_carrier_tier1.sql
-- Tier 1 carriers (TED CRAG Admin redesign, contract C6; owner decision
-- 2026-11-03).
--
-- WHAT THIS DOES (one transaction, idempotent — re-running is a no-op):
--   carrier_trunks.tier1 BOOLEAN NOT NULL DEFAULT false (metadata-only ADD
--   COLUMN on PG >= 11, no rewrite). The Bandwidth rows are seeded true ONLY
--   in the run that adds the column, so a re-run never clobbers a TED edit.
--
-- WHO READS IT: FreeSWITCH selects it with the per-zone termination list
-- (lib/db_client.lua get_termination_trunks). For a customer whose traffic
-- pattern is 'premium' (customers.traffic_grade, 63) the carrier attempts are
-- restricted to tier1 rows after the destination-class filter; when no tier1
-- row is eligible the call falls back to the full class-filtered list and
-- sets term_premium_fallback=1 (65 records it on the CDR). Enterprise
-- customers never look at it. The API (/v1/carrier-trunks) returns and
-- accepts it. tier1 joins the load-bearing carrier_trunks column names —
-- never rename it. The freeswitch role's table-level SELECT covers it.
--
-- LOCKING: brief ACCESS EXCLUSIVE lock on the tiny carrier_trunks table
-- (Kamailio CARRIER_TRUST / X-Carrier-IP lookups and the FS termination
-- fetch read it; the lock is WAL-replayed on every replica). lock_timeout
-- makes it fail fast; if it times out, just re-run it.
--
-- ORDER: apply BEFORE the API build (it SELECTs tier1 on every carrier-trunk
-- route) and before the media-VM pull. If the Lua runs first it retries the
-- pre-64 SELECT, so termination keeps working, without premium routing.
--
-- PRODUCTION NOTE: apply MANUALLY on the bare-metal East primary (services VM)
-- as a SUPERUSER; it replicates to every zone replica. Requires 40/44:
--     hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/64_carrier_tier1.sql
-- Verify: scripts/db/check_migrations.sql -> "64_carrier_tier1 | applied".
-- Rollback: UPDATE carrier_trunks SET tier1 = true (premium then behaves like
-- enterprise). Never DROP the column while the Lua selects it.
-- ==========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'carrier_trunks'
                      AND column_name = 'tier1') THEN
        ALTER TABLE carrier_trunks ADD COLUMN tier1 BOOLEAN NOT NULL DEFAULT false;
        UPDATE carrier_trunks SET tier1 = true, updated_at = NOW()
         WHERE carrier = 'bandwidth';
    END IF;
END
$$;

COMMENT ON COLUMN carrier_trunks.tier1 IS
    'Tier 1 carrier (64): a premium customer''s calls terminate only on tier1 rows; when none is eligible FreeSWITCH falls back to every row and sets term_premium_fallback=1.';

COMMIT;
