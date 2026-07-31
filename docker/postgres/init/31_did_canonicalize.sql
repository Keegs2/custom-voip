-- ==========================================================================
-- 31_did_canonicalize.sql
-- Canonicalize every stored phone number to +E.164 and LOCK the format in.
--
-- Canonical form (must match utils/phone.py / number_utils.lua / phone.ts):
--   E.164 with a leading '+', PRESERVING the country code. The only implicit
--   default is a BARE 10-digit NANP number -> '+1'||digits. An 11-digit
--   1[2-9]NXXXXXXXXX (leading US '1' without the '+') -> '+'||digits. Anything
--   already matching ^\+[1-9]\d{1,14}$ is left UNTOUCHED (international +44/+52
--   etc. are preserved, never forced to +1). forward_to/failover_to may ALSO be
--   a 3-6 digit local PBX extension, which is skipped (kept verbatim).
--
-- WHAT THIS DOES (in ONE transaction, idempotent, re-runnable as a no-op):
--   1. UPDATEs any NON-canonical existing rows to the canonical form:
--        rcf_numbers.did / forward_to / failover_to
--        api_dids.did
--        trunk_dids.did        <-- highest-impact: BUG-1 stored these raw
--        did_inventory.did
--      Only rows that are not already canonical are touched, so a second run
--      changes nothing.
--   2. Adds NAMED CHECK constraints (guarded, IF NOT EXISTS) pinning the
--      canonical shape permanently on all four did columns + the two
--      forward/failover columns (extension-or-E.164).
--
-- >>> OPERATOR: RUN THE DETECTION QUERY FIRST <<<
--   Init scripts only run on a fresh initdb; production already exists, so APPLY
--   THIS MANUALLY on the East PRIMARY (services VM, 10.142.0.103) — it replicates
--   to east-db-standby / west-db / central-db / sandbox automatically:
--       sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/init/31_did_canonicalize.sql
--
--   Before applying, list any offenders per table (audit expects ~zero):
--       SELECT did          FROM rcf_numbers   WHERE did          !~ '^\+[1-9]\d{1,14}$';
--       SELECT forward_to   FROM rcf_numbers   WHERE forward_to   !~ '^\+[1-9]\d{1,14}$' AND forward_to !~ '^\d{3,6}$';
--       SELECT failover_to  FROM rcf_numbers   WHERE failover_to  IS NOT NULL AND failover_to !~ '^\+[1-9]\d{1,14}$' AND failover_to !~ '^\d{3,6}$';
--       SELECT did          FROM api_dids      WHERE did          !~ '^\+[1-9]\d{1,14}$';
--       SELECT did          FROM trunk_dids    WHERE did          !~ '^\+[1-9]\d{1,14}$';
--       SELECT did          FROM did_inventory WHERE did          !~ '^\+[1-9]\d{1,14}$';
--
--   COLLISIONS: each did column has a UNIQUE index. If a non-canonical row (e.g.
--   '6174544217') canonicalizes to a value that ALREADY exists ('+16174544217'),
--   the UPDATE hits the unique index and RAISES. Because the whole file runs in a
--   single transaction, that aborts EVERYTHING cleanly (no partial rewrite). If
--   that happens, hand-resolve the duplicate rows (decide which owns the DID,
--   delete/repoint the other) and re-run. Detect likely collisions up front:
--       SELECT did, count(*) FROM (
--         SELECT CASE WHEN did ~ '^\+[1-9]\d{1,14}$' THEN did
--                     WHEN regexp_replace(did,'[^0-9]','','g') ~ '^1[2-9][0-9]{9}$' THEN '+'  || regexp_replace(did,'[^0-9]','','g')
--                     WHEN regexp_replace(did,'[^0-9]','','g') ~ '^[2-9][0-9]{9}$'  THEN '+1' || regexp_replace(did,'[^0-9]','','g')
--                     ELSE did END AS did
--           FROM rcf_numbers
--       ) x GROUP BY did HAVING count(*) > 1;  -- repeat per table
-- ==========================================================================

BEGIN;

-- --- 1. CANONICALIZE EXISTING ROWS ----------------------------------------
-- The CASE below is the SQL twin of utils.phone.normalize_e164: already-E.164
-- passes through untouched (so international +CC is preserved), 11-digit US 1+NANP
-- and bare 10-digit NANP are the only shapes we rewrite, everything else is left
-- as-is to be surfaced by the detection query / rejected by the CHECK constraint
-- (we never silently mangle an unrecognized value). Do the collision-prone `did`
-- updates first so any UNIQUE violation aborts the whole transaction immediately.

-- rcf_numbers.did
UPDATE rcf_numbers
   SET did = CASE
       WHEN regexp_replace(did, '[^0-9]', '', 'g') ~ '^1[2-9][0-9]{9}$'
            THEN '+'  || regexp_replace(did, '[^0-9]', '', 'g')
       WHEN regexp_replace(did, '[^0-9]', '', 'g') ~ '^[2-9][0-9]{9}$'
            THEN '+1' || regexp_replace(did, '[^0-9]', '', 'g')
       ELSE did
   END
 WHERE did IS NOT NULL
   AND did !~ '^\+[1-9]\d{1,14}$';

-- api_dids.did
UPDATE api_dids
   SET did = CASE
       WHEN regexp_replace(did, '[^0-9]', '', 'g') ~ '^1[2-9][0-9]{9}$'
            THEN '+'  || regexp_replace(did, '[^0-9]', '', 'g')
       WHEN regexp_replace(did, '[^0-9]', '', 'g') ~ '^[2-9][0-9]{9}$'
            THEN '+1' || regexp_replace(did, '[^0-9]', '', 'g')
       ELSE did
   END
 WHERE did IS NOT NULL
   AND did !~ '^\+[1-9]\d{1,14}$';

-- trunk_dids.did (BUG-1: these were inserted verbatim, most likely to need it)
UPDATE trunk_dids
   SET did = CASE
       WHEN regexp_replace(did, '[^0-9]', '', 'g') ~ '^1[2-9][0-9]{9}$'
            THEN '+'  || regexp_replace(did, '[^0-9]', '', 'g')
       WHEN regexp_replace(did, '[^0-9]', '', 'g') ~ '^[2-9][0-9]{9}$'
            THEN '+1' || regexp_replace(did, '[^0-9]', '', 'g')
       ELSE did
   END
 WHERE did IS NOT NULL
   AND did !~ '^\+[1-9]\d{1,14}$';

-- did_inventory.did
UPDATE did_inventory
   SET did = CASE
       WHEN regexp_replace(did, '[^0-9]', '', 'g') ~ '^1[2-9][0-9]{9}$'
            THEN '+'  || regexp_replace(did, '[^0-9]', '', 'g')
       WHEN regexp_replace(did, '[^0-9]', '', 'g') ~ '^[2-9][0-9]{9}$'
            THEN '+1' || regexp_replace(did, '[^0-9]', '', 'g')
       ELSE did
   END
 WHERE did IS NOT NULL
   AND did !~ '^\+[1-9]\d{1,14}$';

-- rcf_numbers.forward_to (skip 3-6 digit local extensions; else canonicalize)
UPDATE rcf_numbers
   SET forward_to = CASE
       WHEN regexp_replace(forward_to, '[^0-9]', '', 'g') ~ '^1[2-9][0-9]{9}$'
            THEN '+'  || regexp_replace(forward_to, '[^0-9]', '', 'g')
       WHEN regexp_replace(forward_to, '[^0-9]', '', 'g') ~ '^[2-9][0-9]{9}$'
            THEN '+1' || regexp_replace(forward_to, '[^0-9]', '', 'g')
       ELSE forward_to
   END
 WHERE forward_to IS NOT NULL
   AND forward_to !~ '^\+[1-9]\d{1,14}$'
   AND forward_to !~ '^\d{3,6}$';

-- rcf_numbers.failover_to (nullable; skip extensions; else canonicalize)
UPDATE rcf_numbers
   SET failover_to = CASE
       WHEN regexp_replace(failover_to, '[^0-9]', '', 'g') ~ '^1[2-9][0-9]{9}$'
            THEN '+'  || regexp_replace(failover_to, '[^0-9]', '', 'g')
       WHEN regexp_replace(failover_to, '[^0-9]', '', 'g') ~ '^[2-9][0-9]{9}$'
            THEN '+1' || regexp_replace(failover_to, '[^0-9]', '', 'g')
       ELSE failover_to
   END
 WHERE failover_to IS NOT NULL
   AND failover_to !~ '^\+[1-9]\d{1,14}$'
   AND failover_to !~ '^\d{3,6}$';

-- --- 2. LOCK THE CANONICAL FORM IN (guarded, named CHECK constraints) ------
-- IF-NOT-EXISTS via a catalog check so re-running is a clean no-op. If any row
-- still fails the predicate (an offender the CASE above could not canonicalize),
-- ADD CONSTRAINT raises and the whole transaction rolls back — resolve per the
-- detection query above, then re-run.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rcf_did_e164_chk') THEN
        ALTER TABLE rcf_numbers
            ADD CONSTRAINT rcf_did_e164_chk CHECK (did ~ '^\+[1-9]\d{1,14}$');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rcf_forward_to_e164_chk') THEN
        ALTER TABLE rcf_numbers
            ADD CONSTRAINT rcf_forward_to_e164_chk
            CHECK (forward_to ~ '^\+[1-9]\d{1,14}$' OR forward_to ~ '^\d{3,6}$');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rcf_failover_to_e164_chk') THEN
        -- failover_to is nullable: allow NULL, else E.164 or a 3-6 digit extension.
        ALTER TABLE rcf_numbers
            ADD CONSTRAINT rcf_failover_to_e164_chk
            CHECK (failover_to IS NULL
                   OR failover_to ~ '^\+[1-9]\d{1,14}$'
                   OR failover_to ~ '^\d{3,6}$');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_did_e164_chk') THEN
        ALTER TABLE api_dids
            ADD CONSTRAINT api_did_e164_chk CHECK (did ~ '^\+[1-9]\d{1,14}$');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trunk_did_e164_chk') THEN
        ALTER TABLE trunk_dids
            ADD CONSTRAINT trunk_did_e164_chk CHECK (did ~ '^\+[1-9]\d{1,14}$');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'did_inventory_e164_chk') THEN
        ALTER TABLE did_inventory
            ADD CONSTRAINT did_inventory_e164_chk CHECK (did ~ '^\+[1-9]\d{1,14}$');
    END IF;
END $$;

COMMIT;
