-- ==========================================================================
-- 50_cdr_quality_accuracy.sql
-- Call-quality accuracy: honest per-leg quality columns, the G.107 E-model as
-- IMMUTABLE SQL functions (mirrors docker/api/src/services/call_quality.py —
-- a parity test enforces they agree), and the call-level "worse direction"
-- combine cdr_refresh_call_quality().
--
-- Contract: docs/CALL_QUALITY_ACCURACY_PLAN.md §B.3 / §B.4 / §C / §D.
--
-- Same form as 47/48: ADD COLUMN IF NOT EXISTS, all nullable, NO DEFAULT, NO
-- CHECK, NO index. ADD COLUMN without a default is metadata-only on the
-- compressed TimescaleDB hypertable (a non-NULL DEFAULT is the form that trips
-- TimescaleDB). Rollback is "stop writing" — NEVER `DROP COLUMN` (a rewrite on
-- a compressed hypertable). The functions are harmless if unused.
--
-- Other than `cdrs` columns/comments, this file creates ONLY
-- `CREATE OR REPLACE FUNCTION`s (and role-guarded grants), so it is safe to
-- replay onto any scratch `cdrs` (tests/cdr_schema.py). Requires 05 + 48
-- (leg / call_id / leg_attempt are read by cdr_refresh_call_quality).
--
-- IDEMPOTENT + REPLAYABLE: plain SQL, safe under `psql -f`, re-runnable.
--
-- The OLD API tolerates this migration (it names none of these columns and
-- calls none of these functions). The NEW API needs it for its read
-- endpoints; its INSERT falls back 73 -> 60 -> 57 -> 55 params as a safety
-- net only.
--
-- PRODUCTION NOTE: init scripts ONLY run on the first initdb. Apply MANUALLY
-- on the East primary (services VM) — replicates to every standby/replica:
--     hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/50_cdr_quality_accuracy.sql
-- Then the history recompute (NOT part of initdb):
--     docker/postgres/backfill/50_cdr_quality_backfill.psql
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. Columns (17 new) — plan §B.3
-- --------------------------------------------------------------------------
ALTER TABLE cdrs
    ADD COLUMN IF NOT EXISTS quality_status                 VARCHAR(12),
    ADD COLUMN IF NOT EXISTS quality_grade                  VARCHAR(5),
    ADD COLUMN IF NOT EXISTS quality_source                 VARCHAR(16),
    ADD COLUMN IF NOT EXISTS fs_mos                         NUMERIC(3,2),
    ADD COLUMN IF NOT EXISTS fs_quality_pct                 NUMERIC(5,2),
    ADD COLUMN IF NOT EXISTS fs_jitter_max_std_ms           NUMERIC(8,3),
    ADD COLUMN IF NOT EXISTS rtp_audio_in_skip_packet_count INTEGER,
    ADD COLUMN IF NOT EXISTS packets_expected               INTEGER,
    ADD COLUMN IF NOT EXISTS loss_bursts                    INTEGER,
    ADD COLUMN IF NOT EXISTS packets_reordered              INTEGER,
    ADD COLUMN IF NOT EXISTS ssrc_changes                   SMALLINT,
    ADD COLUMN IF NOT EXISTS burst_ratio                    NUMERIC(6,3),
    ADD COLUMN IF NOT EXISTS inbound_media_ratio            NUMERIC(6,3),
    ADD COLUMN IF NOT EXISTS call_quality_status            VARCHAR(12),
    ADD COLUMN IF NOT EXISTS call_quality_grade             VARCHAR(5),
    ADD COLUMN IF NOT EXISTS call_mos                       NUMERIC(3,2),
    ADD COLUMN IF NOT EXISTS call_quality_leg               VARCHAR(1);

-- New columns
COMMENT ON COLUMN cdrs.quality_status IS
    'Per-leg rating status (plan B.2): rated | no_rtp | low_sample | short | unanswered | no_data. Always set by the API since migration 50; NULL = written by the pre-50 API and not yet backfilled.';
COMMENT ON COLUMN cdrs.quality_grade IS
    'Per-leg grade great/good/fair/poor = cq_grade(mos) when rated, poor when no_rtp, else NULL (not graded).';
COMMENT ON COLUMN cdrs.quality_source IS
    'fs_patch_v1 (patched FS: RFC 3550 sequence loss) | fs_legacy (unpatched FS: loss from rtp_audio_in_jitter_loss_rate) | backfill_v1 (history recompute). NULL = old API row awaiting the backfill.';
COMMENT ON COLUMN cdrs.fs_mos IS
    'Raw FreeSWITCH rtp_audio_in_mos (do_mos(); scores silence 4.50). Traceability only — never graded.';
COMMENT ON COLUMN cdrs.fs_quality_pct IS
    'Raw FreeSWITCH rtp_audio_in_quality_percentage. Traceability only.';
COMMENT ON COLUMN cdrs.fs_jitter_max_std_ms IS
    'sqrt(rtp_audio_in_jitter_max_variance) ms — the pre-50 jitter_max_ms meaning (poisoned by DTX/hold gaps). Traceability only.';
COMMENT ON COLUMN cdrs.rtp_audio_in_skip_packet_count IS
    'Raw FS rtp_audio_in_skip_packet_count (autoflush / CNG discards) — the pre-50 packet_loss_count meaning. NOT network loss.';
COMMENT ON COLUMN cdrs.packets_expected IS
    'Patched FS only: RFC 3550 A.1 expected inbound packets (sum over SSRC epochs), any status. 0 = patched leg that never got RTP.';
COMMENT ON COLUMN cdrs.loss_bursts IS
    'Patched FS only: forward sequence gaps (loss events / bursts), any status.';
COMMENT ON COLUMN cdrs.packets_reordered IS
    'Patched FS only: late + duplicate-of-highest inbound packets, any status.';
COMMENT ON COLUMN cdrs.ssrc_changes IS
    'Patched FS only: max(seq_epochs - 1, 0) — SSRC changes + sequence restarts, any status.';
COMMENT ON COLUMN cdrs.burst_ratio IS
    'G.107 BurstR fed to the model (rated only): (lost/loss_events)*(1-p) clamped [1,10]; 1.000 on legacy/backfill.';
COMMENT ON COLUMN cdrs.inbound_media_ratio IS
    'min(inbound packets / (billable_ms / ptime), 999.999) for statuses rated/no_rtp/low_sample, else NULL.';
COMMENT ON COLUMN cdrs.call_quality_status IS
    'A rows only, set by cdr_refresh_call_quality(): no_rtp if either direction is no_rtp, else rated if either is rated, else the A status.';
COMMENT ON COLUMN cdrs.call_quality_grade IS
    'A rows only: grade of the WORSE direction (A-in caller->platform vs the answered carrier B-in callee->platform).';
COMMENT ON COLUMN cdrs.call_mos IS
    'A rows only: min MOS over rated legs; NULL when call_quality_status = no_rtp or nothing is rated.';
COMMENT ON COLUMN cdrs.call_quality_leg IS
    'A rows only, STAFF ONLY: which leg (A/B) supplied call_quality_grade.';

-- Changed meaning of existing columns (names kept so no customer field is renamed)
COMMENT ON COLUMN cdrs.mos IS
    'Since migration 50: ITU-T G.107 E-model MOS (packet-loss impairment; clean G.711 = 4.41), rated legs only, else NULL. Raw FS MOS is fs_mos.';
COMMENT ON COLUMN cdrs.r_factor IS
    'Since migration 50: G.107 R-factor (0..100), rated legs only, else NULL. (Pre-50 this was a relabelled MOS.)';
COMMENT ON COLUMN cdrs.packet_loss_pct IS
    'Since migration 50: true inbound loss % (patched: 100*seq_lost/seq_expected; legacy: 100*rtp_audio_in_jitter_loss_rate), rated legs only.';
COMMENT ON COLUMN cdrs.packet_loss_count IS
    'Since migration 50: lost inbound packets (patched: seq_lost; legacy: round(loss_rate*in_packets), an estimate), rated legs only. The skip counter is rtp_audio_in_skip_packet_count.';
COMMENT ON COLUMN cdrs.jitter_avg_ms IS
    'Since migration 50: RFC 3550 per-call mean interarrival jitter J (ms), patched FS + rated only; NULL on legacy images (never fabricated).';
COMMENT ON COLUMN cdrs.jitter_max_ms IS
    'Since migration 50: RFC 3550 post-warmup peak J (ms), patched FS + rated only. The old variance peak is fs_jitter_max_std_ms.';
COMMENT ON COLUMN cdrs.jitter_min_ms IS
    'DEPRECATED since migration 50: always NULL.';
COMMENT ON COLUMN cdrs.quality_pct IS
    'DEPRECATED since migration 50: always NULL. The raw FS value is fs_quality_pct.';

-- --------------------------------------------------------------------------
-- 2. The model — IMMUTABLE mirrors of services/call_quality.py (plan §B.4).
--    float8 arithmetic in the SAME operation order as Python.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cq_r_factor(p_loss_pct float8, p_burst_r float8, p_ie float8 DEFAULT 0, p_bpl float8 DEFAULT 25.1)
RETURNS float8 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p_loss_pct IS NULL THEN NULL ELSE
    GREATEST(0::float8, LEAST(100::float8,
      93.2 - 0.0 - (p_ie + (95 - p_ie) * LEAST(GREATEST(p_loss_pct,0),100)
                  / (LEAST(GREATEST(p_loss_pct,0),100) / LEAST(GREATEST(COALESCE(p_burst_r,1),1),10) + p_bpl))))
  END $$;

CREATE OR REPLACE FUNCTION cq_mos(p_r float8) RETURNS float8 LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p_r IS NULL THEN NULL WHEN p_r <= 0 THEN 1.0 WHEN p_r >= 100 THEN 4.5
              ELSE 1 + 0.035*p_r + 0.000007*p_r*(p_r-60)*(100-p_r) END $$;

CREATE OR REPLACE FUNCTION cq_grade(p_mos numeric) RETURNS varchar LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p_mos IS NULL THEN NULL WHEN p_mos >= 4.34 THEN 'great' WHEN p_mos >= 4.02 THEN 'good'
              WHEN p_mos >= 3.60 THEN 'fair' ELSE 'poor' END $$;       -- input = the STORED 2-dp mos

CREATE OR REPLACE FUNCTION cq_grade_rank(p_grade varchar) RETURNS int LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE p_grade WHEN 'poor' THEN 0 WHEN 'fair' THEN 1 WHEN 'good' THEN 2 WHEN 'great' THEN 3 END $$;

CREATE OR REPLACE FUNCTION cq_leg_status(p_answered bool, p_billable_ms int, p_in_packets int, p_ptime_ms int DEFAULT 20)
RETURNS varchar LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN NOT p_answered THEN 'unanswered'
              WHEN p_in_packets IS NULL THEN 'no_data'
              WHEN COALESCE(p_billable_ms,0) < 5000 THEN 'short'
              WHEN p_in_packets < 0.10 * p_billable_ms::float8 / p_ptime_ms THEN 'no_rtp'
              WHEN p_in_packets < 250 THEN 'low_sample'
              ELSE 'rated' END $$;

-- --------------------------------------------------------------------------
-- 3. Call-level combine (plan §C). VOLATILE; returns the number of A rows
--    updated (0 or 1). Called by BOTH ingests (A and carrier B) as their OWN
--    statement AFTER their INSERT committed, so whichever CDR arrives second
--    sees both committed rows (READ COMMITTED) and writes the final value;
--    concurrent refreshes serialize on the A row lock. Deterministic function
--    of committed rows -> idempotent; late /ingest/bulk re-runs are safe.
--    p_call_id = the A-leg uuid; p_anchor = the calling row's start_time
--    (bounds the A lookup to one chunk range).
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cdr_refresh_call_quality(p_call_id varchar, p_anchor timestamptz)
RETURNS int LANGUAGE sql AS $$
WITH a AS (
  SELECT id, uuid, start_time, end_time, quality_status, quality_grade, mos
    FROM cdrs
   WHERE uuid = p_call_id AND leg IS DISTINCT FROM 'B'
     AND start_time >= p_anchor - interval '1 day' AND start_time <= p_anchor + interval '1 minute'
   LIMIT 1
), b AS (
  SELECT c.quality_status, c.quality_grade, c.mos
    FROM cdrs c JOIN a ON c.call_id = a.uuid
   WHERE c.leg = 'B' AND c.answer_time IS NOT NULL
     AND c.start_time >= a.start_time AND c.start_time <= a.end_time + interval '1 minute'
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
), upd AS (
  UPDATE cdrs t SET
      call_quality_grade  = (SELECT quality_grade FROM w),
      call_quality_leg    = (SELECT leg FROM w),
      call_quality_status = CASE WHEN agg.any_no_rtp THEN 'no_rtp' WHEN agg.any_rated THEN 'rated'
                                 ELSE a.quality_status END,
      call_mos            = CASE WHEN agg.any_no_rtp THEN NULL ELSE agg.min_rated_mos END
    FROM a, agg
   WHERE t.id = a.id AND t.start_time = a.start_time
  RETURNING 1
)
SELECT count(*)::int FROM upd $$;

-- --------------------------------------------------------------------------
-- 4. Grants — belt-and-braces, role-guarded (same as 47/48) so the file never
--    aborts on a cluster without the role.
-- --------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api') THEN
        EXECUTE 'GRANT ALL ON cdrs TO api';
        EXECUTE 'GRANT EXECUTE ON FUNCTION cq_r_factor(float8, float8, float8, float8), '
                'cq_mos(float8), cq_grade(numeric), cq_grade_rank(varchar), '
                'cq_leg_status(bool, int, int, int), '
                'cdr_refresh_call_quality(varchar, timestamptz) TO api';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_ro') THEN
        EXECUTE 'GRANT SELECT ON cdrs TO grafana_ro';
        EXECUTE 'GRANT EXECUTE ON FUNCTION cq_r_factor(float8, float8, float8, float8), '
                'cq_mos(float8), cq_grade(numeric), cq_grade_rank(varchar), '
                'cq_leg_status(bool, int, int, int) TO grafana_ro';
    END IF;
END
$$;
