-- ==========================================================================
-- 34_release_requested_status.sql
-- did_inventory: add 'release_requested' to the status CHECK constraint.
--
-- Backs the request-based number-release workflow:
--   customer POST /v1/numbers/{did}/request-release  -> 'assigned' -> 'release_requested'
--   admin approve = POST /v1/numbers/{did}/unassign  -> 'release_requested' -> 'available'
--   deny/cancel   = POST /v1/numbers/{did}/cancel-release -> back to 'assigned'
--
-- CONSTRAINT HANDLING: the original CHECK in 17_did_inventory.sql was declared
-- inline (unnamed), so its name is auto-generated and may differ between
-- environments. Instead of guessing the name, the DO block below discovers
-- every CHECK constraint on did_inventory whose constrained column set is
-- exactly {status} (via pg_constraint.conkey -> pg_attribute), drops it, and
-- re-adds an EXPLICITLY NAMED constraint (did_inventory_status_check) with the
-- full status list. Future migrations can then target it by name.
--
-- IDEMPOTENT: safe to re-run. Each run drops whatever status CHECK exists and
-- recreates the canonical one; re-adding revalidates existing rows (fast — the
-- table is at most tens of thousands of DIDs) and every status already present
-- is in the new list, so revalidation cannot fail.
--
-- PRODUCTION NOTE: Postgres init scripts here ONLY run on the first initdb of a
-- fresh data directory (on fresh volumes this runs after 17 and upgrades the
-- constraint). The production primary already exists, so apply MANUALLY on the
-- bare-metal prod primary (services VM, 10.142.0.103), then let it replicate:
--     sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/init/34_release_requested_status.sql
-- ==========================================================================

DO $$
DECLARE
    con RECORD;
BEGIN
    -- Drop every CHECK constraint on did_inventory that constrains exactly
    -- the status column (name-agnostic: works whether the constraint is the
    -- auto-generated original or the named one from a prior run of this file).
    FOR con IN
        SELECT c.conname
          FROM pg_constraint c
         WHERE c.conrelid = 'did_inventory'::regclass
           AND c.contype = 'c'
           AND (SELECT array_agg(a.attname ORDER BY a.attname)
                  FROM unnest(c.conkey) AS k
                  JOIN pg_attribute a
                    ON a.attrelid = c.conrelid AND a.attnum = k
               ) = ARRAY['status'::name]
    LOOP
        EXECUTE format('ALTER TABLE did_inventory DROP CONSTRAINT %I', con.conname);
    END LOOP;

    EXECUTE $ck$
        ALTER TABLE did_inventory
            ADD CONSTRAINT did_inventory_status_check
            CHECK (status IN ('available', 'assigned', 'reserved',
                              'release_requested',
                              'porting_in', 'porting_out', 'suspended'))
    $ck$;
END $$;

-- No new grants required: `api` already has ALL on did_inventory
-- (17_did_inventory.sql); a CHECK constraint change grants nothing new.
