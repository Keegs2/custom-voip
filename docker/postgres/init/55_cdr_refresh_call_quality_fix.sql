-- ==========================================================================
-- 55_cdr_refresh_call_quality_fix.sql
-- INCIDENT FIX (2026-10-23): cdr_refresh_call_quality() must never run DML
-- against a compressed TimescaleDB chunk.
--
-- ROOT CAUSE (reproduced on TimescaleDB 2.26.3 / PG 16 by
-- scripts/db/repro_cq_refresh_compressed.sh, which prints the numbers):
--   Migration 50's LANGUAGE sql body ends in
--       UPDATE cdrs t SET ... FROM a, agg
--        WHERE t.id = a.id AND t.start_time = a.start_time
--   a.id / a.start_time come from a JOIN, not from constants, so NO chunk can
--   be excluded from the UPDATE: every chunk of the hypertable is a target.
--   For each COMPRESSED target chunk TimescaleDB must first decompress every
--   batch the UPDATE might touch; with no constant qual to filter batches by,
--   that is the WHOLE chunk, written into the uncompressed heap (WAL-logged),
--   although the one row being updated sits in the CURRENT, uncompressed chunk.
--     * While all compressed history held < 100k rows the refresh "worked":
--       the first refresh after every 12-hourly compression run silently
--       decompressed all of it again (the autovacuum churn on the Sep/Oct
--       chunks).
--     * 08:40 UTC the policy compressed the Oct 15-22 chunk. From ~09:15 every
--       refresh decompressed > timescaledb.max_tuples_decompressed_per_dml_
--       transaction (100k default), raised "tuple decompression limit exceeded
--       by operation" and ROLLED BACK — so nothing ever stayed decompressed
--       and EVERY CDR ingest (A and B leg) repeated the full decompression.
--       A rolled-back DML still writes its WAL (and leaves dead heap/index
--       tuples): ~2.7 GB/min of WAL against a 1.2 GB database; the archiver
--       could not keep up, the 197 GB disk filled, PostgreSQL crashed.
--   The call_id the API passes is NOT a factor: both call sites pass the
--   A-leg uuid, which on this platform IS the inbound SIP Call-ID (internal
--   sofia profile inbound-use-callid-as-uuid=true) — e.g.
--   21529939_133926655@206.146.100.24 for a Sinch Denver call. It matches
--   cdrs.uuid of the A row and cdrs.call_id of its B rows, as designed. The
--   UPDATE's target set is "every chunk" for ANY call_id.
--
-- WHAT THIS FILE DOES — only CREATE OR REPLACE FUNCTION + COMMENT + a
-- role-guarded GRANT (+ a DROP of an incompatible stub, never otherwise; no
-- table, column, index or data change). Same signature and return type
-- (cdr_refresh_call_quality(varchar, timestamptz) RETURNS int: A rows updated,
-- 0 or 1), so the API needs no change. Now LANGUAGE plpgsql:
--   1. The A-row lookup binds its bounds as constants (EXECUTE ... USING is a
--      one-shot custom plan; plpgsql marks USING values PARAM_FLAG_CONST, so
--      the planner folds them and TimescaleDB excludes chunks at PLAN time):
--      only the chunk(s) overlapping [anchor - 1 day, anchor + 1 minute].
--   2. TimescaleDB present (timescaledb_information.chunks resolves): if ANY
--      compressed chunk overlaps the A row or its B-lookup window
--      [A.start_time, A.end_time + 1 minute] -> RETURN 0 with NO DML. Only a
--      CDR ingested more than ~1 day after its week ended can hit this; that
--      A row keeps its call_quality_* (NULL if never refreshed). Plain
--      PostgreSQL (CI, no TimescaleDB): the check is skipped.
--   3. The UPDATE targets id AND start_time as constants -> the plan holds
--      exactly ONE chunk. The combine (legs / w / agg CTEs and the SET list)
--      is migration 50's SQL verbatim: identical results for every row in an
--      uncompressed chunk (tests/test_cdr_refresh_call_quality_55.py
--      differential-tests it against the migration-50 body).
--   4. Fail-fast guard: function-level SET timescaledb.enable_dml_decompression
--      = off. Any UPDATE plan that still holds a compressed chunk is REFUSED
--      before a single tuple is decompressed ("UPDATE/DELETE is disabled on
--      compressed chunks"; the API logs it, the CDR is stored). Measured on
--      2.26.3 against the migration-50 body: 96 bytes of WAL, ~2 ms.
--      NOT max_tuples_decompressed_per_dml_transaction: 2.26.3 checks that
--      limit only AFTER decompressing every target chunk — at 1000 the 50 body
--      still decompressed 190,002 tuples and wrote ~270 MB of WAL before
--      raising, and a failing limit is exactly what turned a one-off into the
--      per-ingest storm. The SET is scoped to the call and restored on exit
--      (also under PgBouncer transaction pooling). TimescaleDB does not
--      reserve its GUC prefix, so on plain PostgreSQL (CI applies this file
--      and calls the function as `api`) — or if a future TimescaleDB drops the
--      GUC — it is an inert placeholder; 1-3 alone keep the DML off
--      compressed chunks.
--
-- THE INCIDENT STUB: the `SELECT 0` no-op hand-installed at ~14:50 UTC is
-- replaced by this file (in place when it has the same parameter names and
-- return type; otherwise dropped first — see the DO block below).
--
-- AFTER APPLYING: A rows whose refresh failed (~09:14 UTC) or was stubbed
-- still have call_quality_status NULL ("Not rated · no sound data"). Refill
-- them with docker/postgres/backfill/55_cdr_call_quality_refill.psql (header
-- has the command; it refuses to run until THIS function is installed).
--
-- OTHER BACKFILLS: 50_cdr_quality_backfill.psql / 51_reclassify_no_media.psql
-- call this function per chunk; both already ran in production. Any re-run
-- now leaves call_quality_* of rows in COMPRESSED chunks untouched (0). To
-- recompute those, decompress_chunk() the chunk first (the 1-day policy
-- recompresses it) — never lift the guard on the API path.
--
-- REPLAY ORDER: re-applying 50 (or any file that CREATE OR REPLACEs this
-- function from the 50 body) REVERTS this fix — re-apply 55 right after.
-- scripts/db/check_migrations.sql reports 55 MISSING in that state.
--
-- Requires 50 (+48). IDEMPOTENT + REPLAYABLE (plain SQL, `psql -f`,
-- re-runnable). Replayed on every scratch `cdrs` by tests/cdr_schema.py.
-- Rollback: none needed (re-applying 50 restores the old function — DON'T).
--
-- PRODUCTION: apply on the East primary (services VM) — replicates to every
-- standby/replica. Safe while the API is running (CREATE OR REPLACE is atomic;
-- in-flight calls finish on the old body):
--     hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/55_cdr_refresh_call_quality_fix.sql
-- VERIFY (expect: plpgsql|{timescaledb.enable_dml_decompression=off}, then 55 "applied"):
--     hostname | grep -q '^services$' && sudo -u postgres psql -d voip -Atc "SELECT l.lanname, p.proconfig FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = 'cdr_refresh_call_quality(varchar, timestamptz)'::regprocedure"
--     hostname | grep -q '^services$' && sudo -u postgres psql -d voip -f /opt/revup/scripts/db/check_migrations.sql
-- Then watch WAL settle (MB/min, run twice a minute apart) and the API log
-- stop reporting "call-quality refresh failed":
--     hostname | grep -q '^services$' && sudo -u postgres psql -d voip -Atc "SELECT pg_current_wal_lsn()"
-- ==========================================================================

-- Guard: the combine reads 48/50 columns and cq_grade_rank() (50).
DO $$
BEGIN
    IF to_regprocedure('cq_grade_rank(varchar)') IS NULL
       OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = current_schema() AND table_name = 'cdrs'
                         AND column_name = 'call_quality_status') THEN
        RAISE EXCEPTION 'migration 50 not applied (cq_grade_rank / cdrs.call_quality_status missing) — apply 50_cdr_quality_accuracy.sql first';
    END IF;
END
$$;

-- The incident's hand-installed no-op (`SELECT 0`) may carry other parameter
-- names or another return type, which CREATE OR REPLACE cannot change
-- ("cannot change name of input parameter" / "cannot change return type").
-- Only in that case: drop it so the CREATE below can run. The API logs
-- "cdr_refresh_call_quality() is missing" for the few ms in between (its
-- refresh never raises; the CDR is stored). A same-shape stub, the
-- migration-50 function and a 55 replay are replaced in place (no DROP).
DO $$
DECLARE
    v_names text[];
    v_ret   regtype;
BEGIN
    SELECT p.proargnames, p.prorettype::regtype INTO v_names, v_ret
      FROM pg_proc p
     WHERE p.oid = to_regprocedure('cdr_refresh_call_quality(varchar, timestamptz)');
    IF FOUND AND (v_ret <> 'integer'::regtype
                  OR v_names IS DISTINCT FROM ARRAY['p_call_id', 'p_anchor']) THEN
        RAISE NOTICE 'dropping incompatible cdr_refresh_call_quality (args %, returns %) so migration 55 can recreate it',
                     v_names, v_ret;
        EXECUTE 'DROP FUNCTION cdr_refresh_call_quality(varchar, timestamptz)';
    END IF;
END
$$;

CREATE OR REPLACE FUNCTION cdr_refresh_call_quality(p_call_id varchar, p_anchor timestamptz)
RETURNS int
LANGUAGE plpgsql
VOLATILE
SET timescaledb.enable_dml_decompression = off
AS $fn$
DECLARE
    v_id         bigint;
    v_uuid       varchar;
    v_start      timestamptz;
    v_end        timestamptz;
    v_b_hi       timestamptz;
    v_compressed boolean := false;
    v_rows       bigint;
BEGIN
    -- cq-refresh-v55 (sentinel: backfill/55_cdr_call_quality_refill.psql and
    -- scripts/db/check_migrations.sql look for it — keep it in the body)
    IF p_call_id IS NULL OR p_anchor IS NULL THEN
        RETURN 0;
    END IF;

    -- 1. The A (call) row — migration 50's predicate, bounds bound as
    --    constants so only the chunk(s) of [anchor - 1 day, anchor + 1 min]
    --    are planned.
    EXECUTE 'SELECT id, uuid, start_time, end_time FROM cdrs
              WHERE uuid = $1 AND leg IS DISTINCT FROM ''B''
                AND start_time >= $2 AND start_time <= $3
              LIMIT 1'
       INTO v_id, v_uuid, v_start, v_end
      USING p_call_id, p_anchor - interval '1 day', p_anchor + interval '1 minute';
    IF v_id IS NULL THEN
        RETURN 0;
    END IF;
    v_b_hi := v_end + interval '1 minute';          -- B lookup upper bound (as 50)

    -- 2. Never DML into a compressed chunk: the A row's chunk or any chunk of
    --    the B lookup window compressed -> 0, no DML. TimescaleDB only.
    IF to_regclass('timescaledb_information.chunks') IS NOT NULL THEN
        SELECT EXISTS (
                 SELECT 1
                   FROM timescaledb_information.chunks ch
                   JOIN pg_namespace n ON n.nspname = ch.hypertable_schema
                   JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = ch.hypertable_name
                  WHERE c.oid = 'cdrs'::regclass
                    AND ch.is_compressed
                    AND ch.range_start <= GREATEST(v_start, v_b_hi)
                    AND ch.range_end > v_start)
          INTO v_compressed;
        IF v_compressed THEN
            RAISE DEBUG 'cdr_refresh_call_quality(%): A row / B window in a compressed chunk — skipped, no DML', p_call_id;
            RETURN 0;
        END IF;
    END IF;

    -- 3. Migration 50's combine verbatim; every chunk-selecting predicate is a
    --    bound constant ($1 id, $2 A start_time, $3 A uuid, $4 B upper bound),
    --    so the UPDATE plan holds exactly the A row's chunk.
    EXECUTE $q$
WITH a AS (
  SELECT id, uuid, start_time, end_time, quality_status, quality_grade, mos
    FROM cdrs
   WHERE id = $1 AND start_time = $2
), b AS (
  SELECT c.quality_status, c.quality_grade, c.mos
    FROM cdrs c
   WHERE c.call_id = $3 AND c.leg = 'B' AND c.answer_time IS NOT NULL
     AND c.start_time >= $2 AND c.start_time <= $4
   ORDER BY c.leg_attempt DESC NULLS LAST, c.start_time DESC
   LIMIT 1
), legs AS (
  SELECT 'A'::varchar AS leg, quality_status, quality_grade, mos FROM a
  UNION ALL
  SELECT 'B', quality_status, quality_grade, mos FROM b
), w AS (
  SELECT leg, quality_grade FROM legs WHERE quality_grade IS NOT NULL
   ORDER BY cq_grade_rank(quality_grade), (quality_status = 'no_rtp') DESC, mos ASC NULLS LAST, leg
   LIMIT 1
), agg AS (
  SELECT bool_or(quality_status = 'no_rtp') AS any_no_rtp,
         bool_or(quality_status = 'rated')  AS any_rated,
         min(mos) FILTER (WHERE quality_status = 'rated') AS min_rated_mos
    FROM legs
)
UPDATE cdrs t SET
    call_quality_grade  = (SELECT quality_grade FROM w),
    call_quality_leg    = (SELECT leg FROM w),
    call_quality_status = CASE WHEN agg.any_no_rtp THEN 'no_rtp' WHEN agg.any_rated THEN 'rated'
                               ELSE a.quality_status END,
    call_mos            = CASE WHEN agg.any_no_rtp THEN NULL ELSE agg.min_rated_mos END
  FROM a, agg
 WHERE t.id = $1 AND t.start_time = $2
$q$
      USING v_id, v_start, v_uuid, v_b_hi;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows;
END
$fn$;

COMMENT ON FUNCTION cdr_refresh_call_quality(varchar, timestamptz) IS
    'Since migration 55: call-level worse-direction combine onto the A row (migration 50 semantics), returns A rows updated (0/1). Returns 0 WITHOUT DML when the A row or its B window lies in a compressed TimescaleDB chunk; all chunk-selecting predicates are bound constants (one-chunk UPDATE); runs with timescaledb.enable_dml_decompression = off (never decompresses). Incident 2026-10-23.';

-- Grants — belt-and-braces (CREATE OR REPLACE keeps existing privileges),
-- role-guarded like 50 so the file never aborts on a cluster without the role.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api') THEN
        EXECUTE 'GRANT EXECUTE ON FUNCTION cdr_refresh_call_quality(varchar, timestamptz) TO api';
    END IF;
END
$$;
