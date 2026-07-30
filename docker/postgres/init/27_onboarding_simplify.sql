-- ==========================================================================
-- 27_onboarding_simplify.sql
-- Simplify the onboarding_requests status model to a lightweight 3-state
-- lifecycle. Billing verification and provisioning are handled by an
-- EXTERNAL system (integrated later); this app only stores the public
-- signup form and tracks status.
--
--   OLD statuses: pending, billing_verified, approved, provisioning, active, rejected
--   NEW statuses: pending, completed, rejected
--
--   "Completed" is a STATUS-ONLY transition (no customer/user/RCF/DID
--   creation — that integration comes later).
--
-- Idempotent + transactional: hand-applied to the LIVE prod primary
-- (init scripts only run on first initdb). Safe to re-run.
--
--   sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/init/27_onboarding_simplify.sql
-- ==========================================================================

BEGIN;

-- 1. Drop the existing status CHECK constraint by its REAL name.
--    19_onboarding_requests.sql declared the CHECK inline (unnamed), so
--    Postgres auto-generated a name. Discover it from pg_constraint rather
--    than hardcoding a guess, and drop whichever CHECK constraint on
--    onboarding_requests references the `status` column.
DO $$
DECLARE
    con_name TEXT;
BEGIN
    FOR con_name IN
        SELECT con.conname
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
         WHERE rel.relname = 'onboarding_requests'
           AND nsp.nspname = 'public'
           AND con.contype = 'c'
           AND pg_get_constraintdef(con.oid) ILIKE '%status%'
    LOOP
        EXECUTE format(
            'ALTER TABLE public.onboarding_requests DROP CONSTRAINT IF EXISTS %I',
            con_name
        );
        RAISE NOTICE 'Dropped status CHECK constraint: %', con_name;
    END LOOP;
END $$;

-- 2. Migrate existing rows to the new 3-status model.
UPDATE onboarding_requests SET status = 'completed' WHERE status = 'active';
UPDATE onboarding_requests SET status = 'pending'
 WHERE status IN ('billing_verified', 'approved', 'provisioning');

-- 3. Add the new 3-status CHECK constraint (named, so it's easy to find later).
--    Guarded so a re-run doesn't error on the already-present constraint.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
         WHERE rel.relname = 'onboarding_requests'
           AND nsp.nspname = 'public'
           AND con.conname = 'onboarding_requests_status_check'
    ) THEN
        ALTER TABLE onboarding_requests
            ADD CONSTRAINT onboarding_requests_status_check
            CHECK (status IN ('pending', 'completed', 'rejected'));
    END IF;
END $$;

-- 4. Add the completion audit columns (mirror the reject columns).
ALTER TABLE onboarding_requests
    ADD COLUMN IF NOT EXISTS completed_by INT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE onboarding_requests
    ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- NOTE: the now-unused columns (billing_verified_by/at, billing_notes,
-- provisioning_config, customer_id, user_id, reviewed_by/at) are left in
-- place — dormant, NOT dropped — to minimize risk. A future external-billing
-- integration may repurpose or drop them.

COMMIT;
