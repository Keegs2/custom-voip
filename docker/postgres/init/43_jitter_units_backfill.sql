-- ==========================================================================
-- 43_jitter_units_backfill.sql
-- One-time DATA backfill: convert historical CDR jitter columns from
-- FreeSWITCH's raw running inter-arrival VARIANCE (ms^2 -- what the old API
-- stored) to jitter std-dev in real ms, and recompute packet_loss_pct from
-- flaw_total (sequence-gap network loss) instead of the autoflush skip count.
--
--   jitter_min_ms  := sqrt(old value)   -- "floor" running jitter (ms)
--   jitter_max_ms  := sqrt(old value)   -- "peak" running jitter (ms)
--   jitter_avg_ms  := sqrt(old value)   -- old value was (min_var+max_var)/2,
--                                          so sqrt of it IS the new ingest
--                                          definition sqrt((min+max)/2):
--                                          RMS mid-band estimate
--   packet_loss_pct := flaw_total * 100 / inbound packets, clamped 0..100;
--                      NULLed where flaw_total/denominator are unavailable
--                      (the old skip-based value is semantically wrong).
--
-- NOT IDEMPOTENT (sqrt twice = wrong) and racy against the OLD API, so:
--
--   * DOUBLE-RUN GUARD: the whole file is ONE transaction whose first write
--     is an INSERT into data_migrations (PK = migration id).  A second run
--     hits the PK, the transaction aborts, and every later statement is
--     skipped -- re-running is harmless.
--   * DEPLOY-ORDER CUTOFF: deploy the NEW API (which already writes ms)
--     FIRST, then run this restricted to rows the OLD API wrote.  The cutoff
--     compares END_TIME (a CDR is ingested at call end, so end_time -- not
--     start_time -- classifies which API version wrote it; a call that was
--     up during the deploy ends after it, is written in ms by the new API,
--     and is correctly excluded).  The cutoff is a REQUIRED psql variable;
--     without -v cutoff=... the cast below fails and nothing runs.
--
-- RUN ORDER (single-line commands, East primary only -- replicates down):
--   1. Deploy the new API on the services VM and note the UTC time it came up:
--        cd /opt/revup && sudo git pull && sudo docker compose -f docker-compose.services.yml up -d --build api && date -u +%Y-%m-%dT%H:%M:%SZ
--   2. Run this backfill with that timestamp as the cutoff:
--        sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -v cutoff="2026-08-28T00:00:00Z" -f /opt/revup/docker/postgres/init/43_jitter_units_backfill.sql
--   3. Do NOT bulk re-ingest mod_json_cdr fallback files between steps 1 and
--      2: a pre-deploy call re-ingested by the new API stores ms with an
--      old end_time and would be double-converted.  Re-ingest AFTER step 2.
--
-- TimescaleDB note: cdrs chunks older than 1 day are compressed.  On
-- TimescaleDB >= 2.11 UPDATE on compressed chunks works (slow but bounded --
-- 90-day retention).  If it errors with "cannot update compressed chunk",
-- decompress first:
--        sudo -u postgres psql -d voip -c "SELECT decompress_chunk(c, true) FROM show_chunks('cdrs') c;"
-- (compression policy re-compresses automatically afterwards).
--
-- Fresh-initdb databases: init scripts 01..42 run first, the cdrs table is
-- empty, and this file still needs -v cutoff -- for docker-entrypoint initdb
-- the guard below inserts the marker with cutoff defaulting via the
-- coalesce-style \if.  (Init runs psql WITHOUT -v cutoff, so we default it
-- to epoch: zero rows match and the marker still records the migration.)
-- ==========================================================================

-- Default the cutoff to epoch when the variable was not provided (fresh
-- initdb): converts nothing, but records the marker so a later manual run
-- cannot double-convert rows ingested by the (always-new) API.
\if :{?cutoff}
\else
\set cutoff '1970-01-01T00:00:00Z'
\endif

BEGIN;

CREATE TABLE IF NOT EXISTS data_migrations (
    migration_id TEXT PRIMARY KEY,
    applied_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    cutoff_time  TIMESTAMPTZ,
    notes        TEXT
);

-- Double-run guard: PK violation here aborts the transaction; every
-- following statement then fails with "current transaction is aborted" and
-- the final COMMIT rolls back.  Nothing is converted twice.
INSERT INTO data_migrations (migration_id, cutoff_time, notes)
VALUES (
    '43_jitter_units_backfill',
    (:'cutoff')::timestamptz,
    'jitter variance(ms^2)->std-dev(ms); packet_loss_pct from flaw_total'
);

-- Jitter unit conversion.  All three columns in ONE statement so every RHS
-- reads the OLD value.  Variance is non-negative by construction; GREATEST
-- guards sqrt against any bad legacy value.
UPDATE cdrs
SET jitter_min_ms = round(sqrt(GREATEST(jitter_min_ms, 0)), 3),
    jitter_max_ms = round(sqrt(GREATEST(jitter_max_ms, 0)), 3),
    jitter_avg_ms = round(sqrt(GREATEST(jitter_avg_ms, 0)), 3)
WHERE end_time < (:'cutoff')::timestamptz
  AND (jitter_min_ms IS NOT NULL
       OR jitter_max_ms IS NOT NULL
       OR jitter_avg_ms IS NOT NULL);

-- packet_loss_pct: recompute from flaw_total where possible (same rule as
-- the new ingest: denominator = rtp_audio_in_packet_count, falling back to
-- packet_total_count).  Where it cannot be recomputed, NULL the old
-- skip-based value rather than keep a wrong number.
UPDATE cdrs
SET packet_loss_pct = CASE
        WHEN flaw_total IS NOT NULL
             AND COALESCE(NULLIF(rtp_audio_in_packet_count, 0),
                          NULLIF(packet_total_count, 0)) IS NOT NULL
        THEN LEAST(GREATEST(round(
                 flaw_total * 100.0
                 / COALESCE(NULLIF(rtp_audio_in_packet_count, 0),
                            NULLIF(packet_total_count, 0)), 2), 0), 100)
        ELSE NULL
    END
WHERE end_time < (:'cutoff')::timestamptz
  AND (packet_loss_pct IS NOT NULL OR flaw_total IS NOT NULL);

COMMIT;
