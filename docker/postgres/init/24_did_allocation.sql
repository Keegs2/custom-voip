-- ==========================================================================
-- 24_did_allocation.sql
-- Adds did_inventory.allocated_env — the environment that OWNS each DID for
-- call-routing purposes (the shared-inventory single-source-of-truth field).
--
-- Sorts AFTER 17_did_inventory.sql (which creates the table) and BEFORE
-- 26_resync_sequences.sql (which MUST remain the alphabetically-last script).
--
-- Idempotent (IF NOT EXISTS / catalog guards) so it can be hand-applied to the
-- existing prod + sandbox databases — init scripts only run on a fresh initdb,
-- so this same file is the manual-apply migration for already-provisioned DBs.
--
-- allocated_env values (by convention, enforced by CHECK below):
--   'prod'     — DID is served by the production environment
--   'sandbox'  — DID is reserved for the test/sandbox environment
--   'reserved' — DID is held, not routable in any environment
-- Default 'prod' so every existing row is owned by production.
-- ==========================================================================
BEGIN;

ALTER TABLE did_inventory
    ADD COLUMN IF NOT EXISTS allocated_env VARCHAR(20) NOT NULL DEFAULT 'prod';

COMMENT ON COLUMN did_inventory.allocated_env IS
    'Environment that owns this DID for call routing. Allowed: prod, sandbox, reserved.';

-- Enforce the allowed value set. Guard so re-running does not error if the
-- constraint already exists (ADD CONSTRAINT has no IF NOT EXISTS in PG16).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'did_inventory_allocated_env_check'
    ) THEN
        ALTER TABLE did_inventory
            ADD CONSTRAINT did_inventory_allocated_env_check
            CHECK (allocated_env IN ('prod', 'sandbox', 'reserved'));
    END IF;
END $$;

-- Index supports the reconciliation-guard lookup that filters by allocated_env.
CREATE INDEX IF NOT EXISTS idx_did_inv_allocated_env ON did_inventory(allocated_env);

-- did_inventory already grants ALL to api + SELECT to freeswitch in
-- 17_did_inventory.sql; column grants are inherited. Re-assert to be explicit
-- and to keep this file self-contained when hand-applied.
GRANT SELECT ON did_inventory TO freeswitch;
GRANT ALL ON did_inventory TO api;

COMMIT;
