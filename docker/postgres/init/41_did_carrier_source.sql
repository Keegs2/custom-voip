-- ==========================================================================
-- 41_did_carrier_source.sql
-- did_inventory: carrier-trunk attribution + intake-source tracking.
--
-- Backs the manual DID intake path (POST /v1/numbers/add): today the pool
-- only fills from the Bandwidth API sync; Sinch DIDs (and any future
-- non-Bandwidth numbers, e.g. the Sinch test TNs 5305480845/5305480846)
-- need a first-class way in. Each manually-added batch is attributed to a
-- carrier_trunks row (migration 40); the existing assign->customer->RCF
-- flow then takes over unchanged.
--
--   * carrier_trunk_id — FK to carrier_trunks(id), ON DELETE SET NULL
--     (deleting a trunk demotes its DIDs to the implicit-Bandwidth
--     attribution legacy rows carry; it never blocks the delete).
--     NULL = implicit Bandwidth (every pre-41 row).
--   * source — 'bandwidth_sync' | 'manual'. Existing rows keep the default
--     'bandwidth_sync' (correct: they all came from the BW sync). This is
--     the SYNC OWNERSHIP BOUNDARY: POST /v1/numbers/sync only manages rows
--     with source='bandwidth_sync' — manual rows can never appear in its
--     'removed' report and never get their metadata overwritten.
--
-- CONSTRAINT HANDLING: same name-agnostic drop-and-recreate pattern as
-- 34_release_requested_status.sql — the DO block discovers every CHECK on
-- did_inventory whose constrained column set is exactly {source}, drops it,
-- and re-adds the EXPLICITLY NAMED did_inventory_source_check. Future
-- migrations can then target it by name.
--
-- IDEMPOTENT: safe to re-run. ADD COLUMN / CREATE INDEX are IF NOT EXISTS;
-- each run drops whatever source CHECK exists and recreates the canonical
-- one (revalidation cannot fail — both allowed values are the only ones the
-- API ever writes); grants are unconditional re-asserts of 17's.
--
-- PRODUCTION NOTE: Postgres init scripts here ONLY run on the first initdb
-- of a fresh data directory. The production primary already exists, so apply
-- MANUALLY on the bare-metal prod primary (services VM, 10.142.0.103), where
-- it replicates to every zone replica:
--     sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/init/41_did_carrier_source.sql
-- Requires 40_carrier_trunks.sql (the FK target) to be applied first.
-- ==========================================================================

ALTER TABLE did_inventory
    ADD COLUMN IF NOT EXISTS carrier_trunk_id INT
        REFERENCES carrier_trunks(id) ON DELETE SET NULL;

ALTER TABLE did_inventory
    ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'bandwidth_sync';

DO $$
DECLARE
    con RECORD;
BEGIN
    -- Drop every CHECK constraint on did_inventory that constrains exactly
    -- the source column (name-agnostic: works on re-runs regardless of how
    -- the constraint was previously named).
    FOR con IN
        SELECT c.conname
          FROM pg_constraint c
         WHERE c.conrelid = 'did_inventory'::regclass
           AND c.contype = 'c'
           AND (SELECT array_agg(a.attname ORDER BY a.attname)
                  FROM unnest(c.conkey) AS k
                  JOIN pg_attribute a
                    ON a.attrelid = c.conrelid AND a.attnum = k
               ) = ARRAY['source'::name]
    LOOP
        EXECUTE format('ALTER TABLE did_inventory DROP CONSTRAINT %I', con.conname);
    END LOOP;

    EXECUTE $ck$
        ALTER TABLE did_inventory
            ADD CONSTRAINT did_inventory_source_check
            CHECK (source IN ('bandwidth_sync', 'manual'))
    $ck$;
END $$;

-- Attribution lookups/joins only ever chase rows that HAVE a trunk; the
-- (dominant) implicit-Bandwidth NULL rows stay out of the index.
CREATE INDEX IF NOT EXISTS idx_did_inv_carrier_trunk
    ON did_inventory(carrier_trunk_id) WHERE carrier_trunk_id IS NOT NULL;

-- Re-assert 17_did_inventory.sql's grants (unconditional, harmless on re-run):
-- api = full DID-lifecycle CRUD, freeswitch = read-only routing lookups.
GRANT ALL ON did_inventory TO api;
GRANT SELECT ON did_inventory TO freeswitch;
GRANT USAGE, SELECT ON did_inventory_id_seq TO api;
