#!/usr/bin/env bash
# ==========================================================================
# repro_cq_refresh_compressed.sh — reproduce the 2026-10-23 WAL storm
# (cdr_refresh_call_quality() vs compressed TimescaleDB chunks) and verify the
# migration-55 fix. LOCAL DOCKER ONLY: starts a throwaway TimescaleDB
# container, never touches a VM / GCP, removes the container on exit.
#
# MANUAL (not CI): CI runs vanilla PostgreSQL 16 without TimescaleDB; the
# semantics of 55 on uncompressed data are covered there by
# tests/test_cdr_refresh_call_quality_55.py. This script covers the
# TimescaleDB-only behaviour.
#
# Usage (from anywhere; ~2 min, ~1.5 GB of scratch WAL inside the container):
#   scripts/db/repro_cq_refresh_compressed.sh
#   IMAGE=timescale/timescaledb:2.26.3-pg16 scripts/db/repro_cq_refresh_compressed.sh
#   KEEP=1 scripts/db/repro_cq_refresh_compressed.sh     # keep the container
# Env: IMAGE (default timescale/timescaledb:latest-pg16 — ships every 2.x
#      library), TS_VERSION (default 2.26.3 = production), NAME (container).
#
# Shape (production-like): cdrs = 05's table + 18/21/40 columns + the REAL
# 23/47/48/50/51 files + 49's call_id index; weekly chunks, compression
# segmentby customer_id / orderby start_time DESC; 2 rows (A + answered B)
# per call: 40k rows Oct 8-15, 150k rows Oct 15-22, 20k rows Oct 22-23.
# Timeline replayed:
#   A  pre-incident: only Oct 8-15 compressed -> the 50 function on a CURRENT
#      week call silently decompresses that whole chunk (succeeds, < 100k).
#   B  08:40 policy run: recompress Oct 8-15 + first compression of Oct 15-22
#      -> every refresh decompresses both chunks, hits the 100k limit, rolls
#      back, and writes ~0.3 GB of WAL per attempt (nothing persists).
#   C  the plan: ModifyHypertable "Update on" EVERY chunk.
#   D  guards: max_tuples=1000 is checked AFTER decompression (no fail-fast);
#      enable_dml_decompression=off refuses before decompressing.
#   E  migration 55 (the REAL file, twice): correct one-chunk update for the
#      current week, 0 + no DML for the compressed week, statuses unchanged.
#   F  other unbounded `UPDATE cdrs` paths in the API (STIR outcome by uuid,
#      exporter watermark by id = ANY(...)).
#   G  the production state: `SELECT 0` stub installed, call_* NULL since the
#      failure -> backfill/55_cdr_call_quality_refill.psql refuses on the stub,
#      55 replaces it, the refill repopulates the current week and leaves the
#      compressed-week row alone (chunk never decompressed).
# ==========================================================================
set -euo pipefail

IMAGE="${IMAGE:-timescale/timescaledb:latest-pg16}"
TS_VERSION="${TS_VERSION:-2.26.3}"
NAME="${NAME:-cq-refresh-repro-$$}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INIT="$REPO/docker/postgres/init"

for f in 05_schema_cdr.sql 23_onnet_cdr_columns.sql 47_cdr_stir_outcome.sql 48_cdr_call_legs.sql \
         50_cdr_quality_accuracy.sql 51_cdr_quality_no_media.sql 55_cdr_refresh_call_quality_fix.sql; do
    [ -f "$INIT/$f" ] || { echo "missing $INIT/$f" >&2; exit 1; }
done

cleanup() {
    if [ "${KEEP:-0}" = "1" ]; then
        echo "KEEP=1: container $NAME left running (docker rm -f $NAME)"
    else
        docker rm -f "$NAME" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

echo "== starting $IMAGE as $NAME (TimescaleDB $TS_VERSION)"
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=repro -v "$INIT:/init:ro" \
    -v "$REPO/docker/postgres/backfill:/backfill:ro" "$IMAGE" \
    -c autovacuum=off -c timescaledb.max_background_workers=0 -c timescaledb.telemetry_level=off \
    -c max_wal_size=8GB -c checkpoint_timeout=1h >/dev/null
for _ in $(seq 1 120); do
    if docker logs "$NAME" 2>&1 | grep -q "PostgreSQL init process complete" \
       && docker exec "$NAME" pg_isready -U postgres -q 2>/dev/null; then
        break
    fi
    sleep 1
done
docker exec "$NAME" pg_isready -U postgres -q

psql_db() { docker exec -i "$NAME" psql -U postgres -X -q -v ON_ERROR_STOP=1 -d repro "$@"; }
docker exec "$NAME" psql -U postgres -X -q -c "CREATE DATABASE repro TEMPLATE template0"

# ---- schema ---------------------------------------------------------------
{
cat <<SQL
SET client_min_messages = error;
CREATE EXTENSION timescaledb VERSION '$TS_VERSION';
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api') THEN CREATE ROLE api LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_ro') THEN CREATE ROLE grafana_ro; END IF;
END \$\$;
SQL
sed -n '/^CREATE TABLE cdrs (/,/^);/p' "$INIT/05_schema_cdr.sql"
cat <<'SQL'
SELECT create_hypertable('cdrs', 'start_time', chunk_time_interval => INTERVAL '1 week', if_not_exists => TRUE);
ALTER TABLE cdrs SET (timescaledb.compress, timescaledb.compress_segmentby = 'customer_id',
                      timescaledb.compress_orderby = 'start_time DESC');
CREATE INDEX idx_cdrs_customer_time ON cdrs(customer_id, start_time DESC);
CREATE INDEX idx_cdrs_uuid ON cdrs(uuid);
CREATE INDEX idx_cdrs_destination ON cdrs(destination, start_time DESC);
CREATE INDEX idx_cdrs_trunk ON cdrs(trunk_id, start_time DESC) WHERE trunk_id IS NOT NULL;
CREATE INDEX idx_cdrs_unrated ON cdrs(start_time) WHERE rated_at IS NULL;
ALTER TABLE cdrs ADD COLUMN IF NOT EXISTS sbc_id VARCHAR(30);                                  -- 18
CREATE INDEX IF NOT EXISTS idx_cdrs_sbc_id_time ON cdrs(sbc_id, start_time DESC) WHERE sbc_id IS NOT NULL;
ALTER TABLE cdrs ADD COLUMN IF NOT EXISTS exported_at TIMESTAMPTZ;                             -- 21
CREATE INDEX IF NOT EXISTS idx_cdrs_unexported ON cdrs (start_time, id) WHERE exported_at IS NULL;
ALTER TABLE cdrs ADD COLUMN IF NOT EXISTS inbound_carrier VARCHAR(20),                         -- 40
                 ADD COLUMN IF NOT EXISTS inbound_carrier_pop VARCHAR(50);
\i /init/23_onnet_cdr_columns.sql
\i /init/47_cdr_stir_outcome.sql
\i /init/48_cdr_call_legs.sql
CREATE INDEX IF NOT EXISTS idx_cdrs_call_id ON cdrs (call_id) WHERE call_id IS NOT NULL;      -- 49
\i /init/50_cdr_quality_accuracy.sql
\i /init/51_cdr_quality_no_media.sql
GRANT ALL ON cdrs TO api;

-- helpers ------------------------------------------------------------------
CREATE FUNCTION repro_gen(p_n int, p_lo timestamptz, p_hi timestamptz, p_seed int) RETURNS bigint
LANGUAGE sql AS $$
WITH ins AS (
INSERT INTO cdrs (uuid, customer_id, product_type, direction, caller_id, destination, destination_prefix,
  start_time, answer_time, end_time, duration_ms, billable_ms, hangup_cause, sip_code, carrier_used,
  freeswitch_node, mos, r_factor, packet_loss_pct, packet_loss_count, packet_total_count, jitter_avg_ms,
  jitter_max_ms, rtp_audio_in_raw_bytes, rtp_audio_in_media_bytes, rtp_audio_out_raw_bytes,
  rtp_audio_out_media_bytes, rtp_audio_in_packet_count, rtp_audio_out_packet_count,
  rtp_audio_in_jitter_loss_rate, read_codec, write_codec, read_rate, write_rate, sip_from_user, sip_to_user,
  hangup_cause_q850, sip_hangup_disposition, sip_user_agent, network_addr, bridge_uuid, sbc_id,
  inbound_carrier, inbound_carrier_pop, origin_customer_id, terminating_customer_id, on_net, stir_outcome,
  stir_eff_actual, leg, call_id, leg_attempt, quality_status, quality_grade, quality_source, fs_mos,
  fs_quality_pct, rtp_audio_in_skip_packet_count, burst_ratio, inbound_media_ratio,
  call_quality_status, call_quality_grade, call_mos, call_quality_leg)
SELECT CASE WHEN l.leg = 'A' THEN c.cid ELSE md5(c.cid || 'b')::uuid::text END,
       c.cust, 'rcf', CASE WHEN l.leg = 'A' THEN 'inbound' ELSE 'outbound' END,
       '+1617' || lpad((c.g % 9999999)::text, 7, '0'), '+1774' || lpad(((c.g * 7) % 9999999)::text, 7, '0'),
       '1774', c.st + CASE WHEN l.leg = 'B' THEN interval '1 second' ELSE interval '0' END,
       c.st + interval '4 seconds', c.st + interval '4 seconds' + c.talk,
       (extract(epoch FROM c.talk) * 1000)::int + 4000, (extract(epoch FROM c.talk) * 1000)::int,
       'NORMAL_CLEARING', 200, 'bandwidth_dallas', 'east-fs', 4.41, 93.20, 0.00, 0, 3000, 0.412, 2.871,
       480000, 480000, 480000, 480000, 3000, 3000, 0.0000, 'PCMU', 'PCMU', 8000, 8000,
       '+1617' || lpad((c.g % 9999999)::text, 7, '0'), '+1774' || lpad(((c.g * 7) % 9999999)::text, 7, '0'),
       16, CASE WHEN l.leg = 'A' THEN 'recv_bye' ELSE 'send_bye' END, 'Bandwidth Network Services',
       '67.231.13.185', md5(c.cid || 'bridge')::uuid::text, 'east-sbc-1',
       CASE WHEN c.g % 3 = 0 THEN 'sinch' ELSE 'bandwidth' END,
       CASE WHEN c.g % 3 = 0 THEN 'denver' ELSE 'dallas' END, c.cust, c.cust, false,
       CASE WHEN l.leg = 'B' THEN 'eff=A;mode=sign;identities=1;base=A;div=0;stripped=0' END,
       CASE WHEN l.leg = 'B' THEN 'A' END, l.leg, c.cid, CASE WHEN l.leg = 'B' THEN 1 END,
       'rated', 'great', 'fs_patch_v1', 4.50, 97.50, 0, 1.000, 1.000,
       CASE WHEN l.leg = 'A' THEN 'rated' END, CASE WHEN l.leg = 'A' THEN 'great' END,
       CASE WHEN l.leg = 'A' THEN 4.41 END, CASE WHEN l.leg = 'A' THEN 'A' END
  FROM (SELECT g, (21000000 + g + p_seed) || '_' || (133000000 + g) || '@' ||
               CASE WHEN g % 3 = 0 THEN '206.146.100.24' ELSE '67.231.13.185' END AS cid,
               1 + (g % 12) AS cust,
               p_lo + (p_hi - p_lo) * ((g - 1)::float8 / p_n) AS st,
               make_interval(secs => 20 + (g % 280)) AS talk
          FROM generate_series(1, p_n) g) c
 CROSS JOIN (VALUES ('A'), ('B')) l(leg)
RETURNING 1)
SELECT count(*) FROM ins $$;

CREATE FUNCTION repro_state() RETURNS TABLE(chunk text, range_start date, is_compressed bool,
                                            status int, live_rows_in_uncompressed_heap bigint, total_size text)
LANGUAGE plpgsql AS $$
DECLARE r record; n bigint;
BEGIN
  FOR r IN SELECT ch.chunk_schema, ch.chunk_name, ch.range_start, ch.is_compressed
             FROM timescaledb_information.chunks ch WHERE ch.hypertable_name = 'cdrs' ORDER BY ch.range_start LOOP
    EXECUTE format('SELECT count(*) FROM ONLY %I.%I', r.chunk_schema, r.chunk_name) INTO n;
    chunk := r.chunk_name; range_start := r.range_start; is_compressed := r.is_compressed;
    SELECT c.status INTO status FROM _timescaledb_catalog.chunk c
     WHERE c.schema_name = r.chunk_schema AND c.table_name = r.chunk_name;
    live_rows_in_uncompressed_heap := n;
    total_size := pg_size_pretty(pg_total_relation_size(format('%I.%I', r.chunk_schema, r.chunk_name)));
    RETURN NEXT;
  END LOOP;
END $$;
SQL
# The migration-50 body under another name, so it can be re-run after 55.
sed -n '/^CREATE OR REPLACE FUNCTION cdr_refresh_call_quality(/,/^SELECT count(\*)::int FROM upd \$\$;/p' \
    "$INIT/50_cdr_quality_accuracy.sql" \
  | sed 's/FUNCTION cdr_refresh_call_quality(/FUNCTION cdr_refresh_call_quality_v50(/'
} | psql_db >/dev/null

# ---- data -----------------------------------------------------------------
echo "== loading data"
psql_db <<'SQL'
SELECT repro_gen(20000, '2026-10-08 00:00+00', '2026-10-15 00:00+00', 0)       AS rows_oct08_15,
       repro_gen(75000, '2026-10-15 00:00+00', '2026-10-22 00:00+00', 100000)  AS rows_oct15_22,
       repro_gen(10000, '2026-10-22 00:00+00', '2026-10-23 09:00+00', 200000)  AS rows_oct22_now;
-- The two calls from the incident log (Sinch Denver Call-IDs = FS A-leg uuids).
-- CUR: current week. OLD: inside Oct 15-22 (a CDR arriving after compression).
INSERT INTO cdrs (uuid, customer_id, product_type, direction, destination, start_time, answer_time,
                  end_time, leg, call_id, leg_attempt, quality_status, quality_grade, mos, quality_source) VALUES
 ('21529939_133926655@206.146.100.24', 3, 'rcf', 'inbound', '+17745550100', '2026-10-23 09:15:00+00',
  '2026-10-23 09:15:04+00', '2026-10-23 09:17:04+00', 'A', '21529939_133926655@206.146.100.24', NULL,
  'rated', 'great', 4.41, 'fs_patch_v1'),
 ('b-cur-1', 3, 'rcf', 'outbound', '+17745550100', '2026-10-23 09:15:01+00', '2026-10-23 09:15:04+00',
  '2026-10-23 09:17:04+00', 'B', '21529939_133926655@206.146.100.24', 1, 'rated', 'fair', 3.92, 'fs_patch_v1'),
 ('51007683_134198418@206.146.100.24', 3, 'rcf', 'inbound', '+17745550101', '2026-10-21 14:00:00+00',
  '2026-10-21 14:00:04+00', '2026-10-21 14:02:04+00', 'A', '51007683_134198418@206.146.100.24', NULL,
  'rated', 'great', 4.41, 'fs_patch_v1'),
 ('b-old-1', 3, 'rcf', 'outbound', '+17745550101', '2026-10-21 14:00:01+00', '2026-10-21 14:00:04+00',
  '2026-10-21 14:02:04+00', 'B', '51007683_134198418@206.146.100.24', 1, 'rated', 'fair', 3.92, 'fs_patch_v1');
SELECT extversion AS timescaledb FROM pg_extension WHERE extname = 'timescaledb';
SQL

# ---- A: pre-incident -------------------------------------------------------
echo
echo "== A. pre-incident: only Oct 8-15 compressed; ORIGINAL (migration 50) function, default limit"
psql_db <<'SQL'
\pset footer off
SELECT compress_chunk(c) IS NOT NULL AS compressed FROM show_chunks('cdrs', older_than => '2026-10-15'::timestamptz) c;
SELECT * FROM repro_state();
CHECKPOINT;
SELECT pg_current_wal_insert_lsn() AS l0 \gset
\timing on
SELECT cdr_refresh_call_quality('21529939_133926655@206.146.100.24', '2026-10-23 09:15:00+00') AS rows_updated;
\timing off
SELECT pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_insert_lsn(), :'l0')) AS wal_one_refresh_of_a_current_week_call;
\echo '-- the whole compressed chunk is now in its uncompressed heap (status 9 = partially compressed):'
SELECT * FROM repro_state();
SELECT pg_current_wal_insert_lsn() AS l1 \gset
SELECT cdr_refresh_call_quality('21529939_133926655@206.146.100.24', '2026-10-23 09:15:01+00') AS rows_updated;
SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), :'l1') AS wal_bytes_next_refresh;
SQL

# ---- B: the incident ------------------------------------------------------
echo
echo "== B. 08:40 policy run (recompress Oct 8-15, first compression of Oct 15-22), then 5 refreshes"
psql_db <<'SQL'
\pset footer off
SELECT compress_chunk(c) IS NOT NULL AS compressed FROM show_chunks('cdrs', older_than => '2026-10-22'::timestamptz) c;
VACUUM;
SELECT * FROM repro_state();
SELECT pg_size_pretty(pg_database_size('repro')) AS database_size;
SHOW timescaledb.max_tuples_decompressed_per_dml_transaction;
CHECKPOINT;
\set ON_ERROR_STOP off
SELECT pg_current_wal_insert_lsn() AS l0 \gset
SELECT sum(pg_total_relation_size(c)) AS s0 FROM show_chunks('cdrs') c \gset
\timing on
SELECT cdr_refresh_call_quality('21529939_133926655@206.146.100.24', '2026-10-23 09:15:00+00');
\timing off
SELECT pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_insert_lsn(), :'l0')) AS wal_attempt_1;
SELECT pg_current_wal_insert_lsn() AS l1 \gset
SELECT cdr_refresh_call_quality('21529939_133926655@206.146.100.24', '2026-10-23 09:15:00+00');
SELECT cdr_refresh_call_quality('21529939_133926655@206.146.100.24', '2026-10-23 09:15:01+00');
SELECT cdr_refresh_call_quality('21529939_133926655@206.146.100.24', '2026-10-23 09:15:00+00');
SELECT cdr_refresh_call_quality('21529939_133926655@206.146.100.24', '2026-10-23 09:15:01+00');
\set ON_ERROR_STOP on
SELECT pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_insert_lsn(), :'l1') / 4) AS wal_per_attempt_2_to_5,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_insert_lsn(), :'l0')) AS wal_5_attempts,
       pg_size_pretty(sum(pg_total_relation_size(c)) - :s0) AS dead_chunk_growth_5_attempts
  FROM show_chunks('cdrs') c;
\echo '-- nothing persisted: statuses unchanged, uncompressed heaps hold no live rows:'
SELECT * FROM repro_state();
SQL

# ---- C: the plan ------------------------------------------------------------
echo
echo "== C. the ORIGINAL function's UPDATE plan (auto_explain, rolled back, limit lifted)"
psql_db 2>&1 <<'SQL' | grep -E "ModifyHypertable|Batches decompressed|Tuples decompressed|Update on _hyper|Seq Scan on _hyper_1_[0-9]+_chunk t_" || true
LOAD 'auto_explain';
SET auto_explain.log_min_duration = 0;
SET auto_explain.log_nested_statements = on;
SET client_min_messages = log;
BEGIN;
SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0;
SELECT cdr_refresh_call_quality('21529939_133926655@206.146.100.24', '2026-10-23 09:15:00+00');
ROLLBACK;
SQL

# ---- D: guards --------------------------------------------------------------
echo
echo "== D. guards on the migration-50 body"
psql_db 2>&1 <<'SQL'
\pset footer off
\set ON_ERROR_STOP off
SET timescaledb.max_tuples_decompressed_per_dml_transaction = 1000;
SELECT pg_current_wal_insert_lsn() AS l0 \gset
\timing on
SELECT cdr_refresh_call_quality_v50('21529939_133926655@206.146.100.24', '2026-10-23 09:15:00+00');
\timing off
SELECT pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_insert_lsn(), :'l0')) AS wal_with_max_tuples_1000;
RESET timescaledb.max_tuples_decompressed_per_dml_transaction;
SET timescaledb.enable_dml_decompression = off;
SELECT pg_current_wal_insert_lsn() AS l1 \gset
\timing on
SELECT cdr_refresh_call_quality_v50('21529939_133926655@206.146.100.24', '2026-10-23 09:15:00+00');
\timing off
SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), :'l1') AS wal_bytes_with_enable_dml_decompression_off;
SQL

# ---- E: migration 55 --------------------------------------------------------
echo
echo "== E. apply docker/postgres/init/55_cdr_refresh_call_quality_fix.sql (twice), re-run as role api"
docker exec -i "$NAME" psql -U postgres -X -q -v ON_ERROR_STOP=1 -d repro -f /init/55_cdr_refresh_call_quality_fix.sql
docker exec -i "$NAME" psql -U postgres -X -q -v ON_ERROR_STOP=1 -d repro -f /init/55_cdr_refresh_call_quality_fix.sql
psql_db 2>&1 <<'SQL'
\pset footer off
SELECT l.lanname, p.proconfig FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
 WHERE p.oid = 'cdr_refresh_call_quality(varchar, timestamptz)'::regprocedure;
-- reset the current-week call (constant-targeted: an `IN (...)` list here would itself
-- decompress every compressed chunk — `= ANY` is not batch-filterable on 2.26.3)
UPDATE cdrs SET call_quality_status = NULL, call_quality_grade = NULL, call_mos = NULL, call_quality_leg = NULL
 WHERE uuid = '21529939_133926655@206.146.100.24' AND start_time = '2026-10-23 09:15:00+00';
CHECKPOINT;
SET ROLE api;
SHOW timescaledb.max_tuples_decompressed_per_dml_transaction;
SELECT pg_current_wal_insert_lsn() AS l0 \gset
SELECT cdr_refresh_call_quality('21529939_133926655@206.146.100.24', '2026-10-23 09:15:00+00') AS current_week_a_anchor;
SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), :'l0') AS wal_bytes;
SELECT pg_current_wal_insert_lsn() AS l1 \gset
SELECT cdr_refresh_call_quality('21529939_133926655@206.146.100.24', '2026-10-23 09:15:01+00') AS current_week_b_anchor;
SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), :'l1') AS wal_bytes;
SELECT uuid, call_quality_status, call_quality_grade, call_mos, call_quality_leg FROM cdrs
 WHERE uuid = '21529939_133926655@206.146.100.24';
SELECT pg_current_wal_insert_lsn() AS l2 \gset
SELECT cdr_refresh_call_quality('51007683_134198418@206.146.100.24', '2026-10-21 14:00:00+00') AS compressed_week;
SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), :'l2') AS wal_bytes;
SELECT uuid, call_quality_status, call_quality_grade, call_mos, call_quality_leg FROM cdrs
 WHERE uuid = '51007683_134198418@206.146.100.24';
DO $$ DECLARE t0 timestamptz := clock_timestamp(); BEGIN
  FOR i IN 1..1000 LOOP
    PERFORM cdr_refresh_call_quality('21529939_133926655@206.146.100.24', '2026-10-23 09:15:00+00');
  END LOOP;
  RAISE NOTICE '55, current-week call (UPDATE path): % ms/call',
    round((extract(epoch FROM clock_timestamp() - t0))::numeric, 3);
  t0 := clock_timestamp();
  FOR i IN 1..1000 LOOP
    PERFORM cdr_refresh_call_quality('51007683_134198418@206.146.100.24', '2026-10-21 14:00:00+00');
  END LOOP;
  RAISE NOTICE '55, compressed-week call (skip path): % ms/call',
    round((extract(epoch FROM clock_timestamp() - t0))::numeric, 3);
END $$;
RESET ROLE;
SELECT * FROM repro_state();
SQL
echo "-- the 55 UPDATE plan (auto_explain):"
psql_db 2>&1 <<'SQL' | grep -E "ModifyHypertable|Batches|Tuples decompressed|Update on _hyper|Query Parameters" || true
LOAD 'auto_explain';
SET auto_explain.log_min_duration = 0;
SET auto_explain.log_nested_statements = on;
SET client_min_messages = log;
SELECT cdr_refresh_call_quality('21529939_133926655@206.146.100.24', '2026-10-23 09:15:00+00');
SQL

# ---- F: other unbounded UPDATE cdrs paths (rolled back) ----------------------
echo
echo "== F. other API UPDATEs of cdrs with no start_time bound (rolled back)"
psql_db 2>&1 <<'SQL'
\pset footer off
\set ON_ERROR_STOP off
\echo '-- STIR outcome (routers/cdrs.py _apply_b_leg_stir_outcome: WHERE uuid = $1):'
BEGIN;
SELECT pg_current_wal_insert_lsn() AS l0 \gset
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
UPDATE cdrs SET stir_outcome = 'eff=A', stir_eff_actual = 'A' WHERE uuid = '21529939_133926655@206.146.100.24';
SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), :'l0') AS wal_bytes;
ROLLBACK;
SELECT id AS cur_id FROM cdrs WHERE uuid = '21529939_133926655@206.146.100.24' \gset
\echo '-- exporter watermark (services/cdr_export/exporter.py _mark_rows_exported: WHERE id = ANY($1::bigint[])):'
BEGIN;
SELECT pg_current_wal_insert_lsn() AS l1 \gset
UPDATE cdrs SET exported_at = now() WHERE id = ANY(ARRAY[:cur_id]::bigint[]);
ROLLBACK;
SELECT pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_insert_lsn(), :'l1')) AS wal_failed_watermark;
\echo '-- the same watermark bounded by the batch min/max start_time:'
BEGIN;
SELECT pg_current_wal_insert_lsn() AS l2 \gset
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
UPDATE cdrs SET exported_at = now() WHERE id = ANY(ARRAY[:cur_id]::bigint[])
   AND start_time >= '2026-10-23 09:15:00+00' AND start_time <= '2026-10-23 09:15:00+00';
SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), :'l2') AS wal_bytes;
ROLLBACK;
SQL

# ---- G: incident state -> 55 -> refill backfill ----------------------------
echo
echo "== G. incident state (SELECT 0 stub, call_* NULL since Oct 23 00:00) -> refill"
psql_db <<'SQL'
\pset footer off
-- constant-bounded (current chunk only) — simulates the failed/stubbed refreshes
UPDATE cdrs SET call_quality_status = NULL, call_quality_grade = NULL, call_mos = NULL, call_quality_leg = NULL
 WHERE leg IS DISTINCT FROM 'B' AND start_time >= '2026-10-23 00:00+00';
CREATE OR REPLACE FUNCTION cdr_refresh_call_quality(p_call_id varchar, p_anchor timestamptz)
RETURNS int LANGUAGE sql AS $$ SELECT 0 $$;
SELECT count(*) AS null_call_quality_a_rows_since_oct21,
       count(*) FILTER (WHERE start_time < '2026-10-22 00:00+00') AS of_which_in_compressed_week
  FROM cdrs WHERE leg IS DISTINCT FROM 'B' AND call_quality_status IS NULL
   AND start_time >= '2026-10-21 00:00+00';
SQL
refill() { docker exec -i "$NAME" psql -U postgres -X -d repro -v ON_ERROR_STOP=on "$@" -f /backfill/55_cdr_call_quality_refill.psql; }
echo "-- refill while the stub is installed (must refuse):"
ERR="$(mktemp)"
if refill -v since='2026-10-21 00:00+00' >/dev/null 2>"$ERR"; then
    echo "UNEXPECTED: refill ran against the stub" >&2; rm -f "$ERR"; exit 1
fi
grep -o "ERROR:.*" "$ERR" || true; rm -f "$ERR"
docker exec -i "$NAME" psql -U postgres -X -q -v ON_ERROR_STOP=1 -d repro -f /init/55_cdr_refresh_call_quality_fix.sql
psql_db -c "CHECKPOINT" >/dev/null
L0=$(psql_db -Atc "SELECT pg_current_wal_insert_lsn()")
echo "-- refill (since reaches into the compressed week on purpose):"
refill -v since='2026-10-21 00:00+00'
psql_db <<SQL
\pset footer off
SELECT pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_insert_lsn(), '$L0')) AS wal_whole_refill;
SELECT call_quality_status, call_quality_grade, call_mos, call_quality_leg, count(*)
  FROM cdrs WHERE leg IS DISTINCT FROM 'B' AND start_time >= '2026-10-23 00:00+00' GROUP BY 1, 2, 3, 4;
SELECT uuid, call_quality_status FROM cdrs WHERE uuid = '51007683_134198418@206.146.100.24';
\echo '-- compressed weeks untouched (status 1, nothing in the uncompressed heap = no DML, no decompression):'
SELECT * FROM repro_state();
SQL
echo "-- re-run (idempotent):"
refill -v since='2026-10-21 00:00+00' | grep -E "^batch|candidates|^ *[0-9]" || true

echo
echo "== done"
