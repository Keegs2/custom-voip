-- 26_resync_sequences.sql — MUST RUN LAST (sorts after every schema/seed script).
-- (Renamed from 24_ when 25_schema_recordings.sql was added — this resync must
--  stay the alphabetically-last init script so it runs after all explicit-id seeds.)
--
-- Several seed scripts insert rows with EXPLICIT ids (14_granite_accounts → customer 1,
-- 11b_add_ucaas_type → customer 5, the admin user, etc.) without advancing the owning
-- sequence. Without this resync, nextval() returns 1,2,… and collides with seeded rows
-- (e.g. POST /v1/customers would reuse id=1 = Granite, or the multi-tenant tests collide).
-- Found live during Phase 5. This advances every public sequence to MAX(owning column).
--
-- Scoped to schema 'public' (so TimescaleDB internal sequences are skipped) and each
-- sequence is resynced in its own sub-block — a quirky/unqueryable sequence (e.g. a
-- hypertable proxy) is logged and skipped, never aborting init.
DO $$
DECLARE
    r RECORD;
    maxid BIGINT;
BEGIN
    FOR r IN
        SELECT s.relname AS seqname,
               t.relname AS tabname,
               a.attname AS colname
        FROM pg_class s
        JOIN pg_namespace n  ON n.oid = s.relnamespace AND n.nspname = 'public'
        JOIN pg_depend d     ON d.objid = s.oid AND d.deptype = 'a'
        JOIN pg_class t      ON t.oid = d.refobjid AND t.relkind = 'r'
        JOIN pg_namespace tn ON tn.oid = t.relnamespace AND tn.nspname = 'public'
        JOIN pg_attribute a  ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
        WHERE s.relkind = 'S'
    LOOP
        BEGIN
            EXECUTE format('SELECT COALESCE(MAX(%I), 0) FROM public.%I', r.colname, r.tabname) INTO maxid;
            IF maxid > 0 THEN
                EXECUTE format('SELECT setval(%L, %s, true)', r.seqname, maxid);
                RAISE NOTICE 'resync: % -> %', r.seqname, maxid;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'resync: skipped % (%)', r.seqname, SQLERRM;
        END;
    END LOOP;
END $$;
