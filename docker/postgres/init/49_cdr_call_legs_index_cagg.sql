-- ==========================================================================
-- 49_cdr_call_legs_index_cagg.sql
-- CDR A/B leg split, part 2: idx_cdrs_call_id + cdr_hourly_stats rebuilt
-- with the one-row-per-call predicate.  Requires 48.
--
-- Contract: docs/CDR_LEG_SPLIT_CONTRACT.md; plan §3 / §8 item 1.
--
-- >>> THIS IS A psql SCRIPT, NOT A PLAIN SQL FILE. <<<
-- It uses psql meta-commands (\gset / \if) and statements that TimescaleDB
-- refuses inside a transaction block (CREATE INDEX ... transaction_per_chunk,
-- CALL refresh_continuous_aggregate). Run it ONLY like this (autocommit, no
-- -1 / --single-transaction, no surrounding BEGIN):
--     hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/49_cdr_call_legs_index_cagg.sql
-- It is RE-RUNNABLE: every step detects its own completed state (an index
-- left INVALID by an interrupted run is dropped and rebuilt; the CAGG is only
-- rebuilt while its definition lacks the leg predicate or is not real-time;
-- the full refresh is idempotent). On a cluster WITHOUT TimescaleDB (the test
-- harness) it creates a plain index and skips the CAGG section.
--
-- 1) idx_cdrs_call_id — partial btree on call_id (legacy rows are NULL and
--    are not indexed). Serves `call_id = $n` (orphan-leg checks, the staff
--    "all legs of this call" view: `(call_id = $n OR uuid = $n)`, which
--    BitmapOrs this with idx_cdrs_uuid). TimescaleDB has no CONCURRENTLY for
--    hypertables; `WITH (timescaledb.transaction_per_chunk)` builds one chunk
--    per transaction so the lock is per chunk, not across all ~13 weekly
--    chunks. On failure TimescaleDB leaves the hypertable index marked
--    INVALID (and IF NOT EXISTS would then silently skip it forever) — so an
--    invalid leftover is DROPPED first and rebuilt.
--
-- 2) cdr_hourly_stats — decision: DROP + recreate (option a), because
--    (i) a continuous aggregate's query cannot be ALTERed, and data volume is
--    tiny (~2.5k calls / 30d) so a full re-materialization is seconds;
--    (ii) it is the only way to put `leg IS DISTINCT FROM 'B'` in the one
--    consumer we cannot patch per query — every CAGG row would otherwise
--    count a forwarded call twice (A inbound + B outbound) once B rows land;
--    (iii) it also fixes plan §8 item 1: 05 created it `WITH NO DATA` with a
--    3-hour rolling refresh, so on TimescaleDB >= 2.13 (prod: 2.26.3,
--    materialized_only default flipped to TRUE) history was never
--    materialized and the view showed only the last ~3h.
--    Columns, names, types and GROUP BY are IDENTICAL to 05 (consumers —
--    call-quality.json ACD panel, SLOS.md ASR query, the api/grafana_ro
--    grants — keep working unchanged); the ONLY semantic change is the
--    WHERE clause.
--    materialized_only = FALSE (real-time) — explicit, reasoned: the NOC
--    panels need the current hour, and the refresh policy trails by
--    end_offset + schedule (up to ~6 min). Real-time unions the tiny
--    not-yet-materialized tail from the raw hypertable, which at this volume
--    costs nothing. Setting it explicitly removes the version-dependent
--    default that caused §8 item 1.
--    Policy start_offset widened 3h -> 3 days so mod_json_cdr disk-fallback
--    CDRs re-ingested via /ingest/bulk up to 3 days late are re-materialized
--    (at this volume a 3-day refresh window is negligible).
--    The DROP+CREATE+policy+grants run in ONE explicit transaction:
--    CREATE ... WITH NO DATA is allowed in a transaction (only WITH DATA is
--    refused), so if the CREATE fails the DROP rolls back and the old view
--    survives. The full refresh then runs outside it (autocommit), and is
--    re-run on every invocation (idempotent).
--
-- Grants on the recreated view: SELECT to api (05) and grafana_ro (24), both
-- role-guarded. No other role references cdr_hourly_stats (grepped:
-- 05, 24, call-quality.json, SLOS.md).
-- ==========================================================================

\set ON_ERROR_STOP on

SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') AS has_ts \gset

SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'cdrs'
       AND column_name = 'call_id'
) AS has_48 \gset

\if :has_48
\else
\echo 'ERROR: cdrs.call_id is missing -- apply 48_cdr_call_legs.sql first'
SELECT 1/0 AS migration_48_required;
\endif

-- ---------------------------------------------------------------------------
-- 1) idx_cdrs_call_id
-- ---------------------------------------------------------------------------
SELECT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'idx_cdrs_call_id' AND NOT i.indisvalid
) AS idx_invalid \gset

\if :idx_invalid
\echo 'idx_cdrs_call_id is INVALID (interrupted earlier build) -- dropping and rebuilding'
DROP INDEX IF EXISTS idx_cdrs_call_id;
\endif

\if :has_ts
CREATE INDEX IF NOT EXISTS idx_cdrs_call_id ON cdrs (call_id)
    WITH (timescaledb.transaction_per_chunk)
    WHERE call_id IS NOT NULL;
\else
CREATE INDEX IF NOT EXISTS idx_cdrs_call_id ON cdrs (call_id)
    WHERE call_id IS NOT NULL;
\endif

-- ---------------------------------------------------------------------------
-- 2) cdr_hourly_stats (TimescaleDB only)
-- ---------------------------------------------------------------------------
\if :has_ts

SELECT NOT EXISTS (
    SELECT 1 FROM timescaledb_information.continuous_aggregates
     WHERE view_name = 'cdr_hourly_stats'
       AND view_definition ILIKE '%leg%IS DISTINCT FROM%'
       AND materialized_only = false
) AS cagg_rebuild \gset

\if :cagg_rebuild
\echo 'cdr_hourly_stats: rebuilding with leg IS DISTINCT FROM ''B'' (real-time)'
BEGIN;
DROP MATERIALIZED VIEW IF EXISTS cdr_hourly_stats;
CREATE MATERIALIZED VIEW cdr_hourly_stats
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
    customer_id,
    time_bucket('1 hour', start_time) AS hour,
    product_type,
    direction,
    COUNT(*) as total_calls,
    COUNT(*) FILTER (WHERE answer_time IS NOT NULL) as answered_calls,
    SUM(duration_ms) / 1000 as total_duration_sec,
    SUM(total_cost) as total_cost,
    AVG(duration_ms) FILTER (WHERE answer_time IS NOT NULL) / 1000 as avg_duration_sec
FROM cdrs
WHERE leg IS DISTINCT FROM 'B'
GROUP BY customer_id, hour, product_type, direction
WITH NO DATA;
SELECT add_continuous_aggregate_policy('cdr_hourly_stats',
    start_offset => INTERVAL '3 days',
    end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '5 minutes',
    if_not_exists => TRUE);
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api') THEN
        EXECUTE 'GRANT SELECT ON cdr_hourly_stats TO api';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_ro') THEN
        EXECUTE 'GRANT SELECT ON cdr_hourly_stats TO grafana_ro';
    END IF;
END
$$;
COMMIT;
\else
\echo 'cdr_hourly_stats: already carries the leg predicate + real-time -- no rebuild'
\endif

-- Full (re)materialization of all history. Cannot run in a transaction
-- block; idempotent, so it runs on every invocation.
CALL refresh_continuous_aggregate('cdr_hourly_stats', NULL, NULL);

\else
\echo 'TimescaleDB not installed -- cdr_hourly_stats section skipped'
\endif
