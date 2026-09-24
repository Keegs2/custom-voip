-- ==========================================================================
-- 51_cdr_quality_no_media.sql
-- Splits the migration-50 "no inbound RTP" status in two, on the OUTBOUND
-- side of the same leg (owner-approved rule, 2026-09-24):
--
--   in_ratio  = rtp_audio_in_packet_count  / (billable_ms / ptime)
--   out_ratio = rtp_audio_out_packet_count / (billable_ms / ptime)   (same basis)
--
--   in_ratio < 0.10 AND out_ratio >= 0.50           -> 'no_rtp'   TRUE one-way
--       audio (we sent audio, received none): graded poor, MOS NULL (unchanged)
--   in_ratio < 0.10 AND (out_ratio < 0.50 OR out
--       count unknown)                              -> 'no_media' NO audio in
--       either direction (failed setup, test call, or both parties silent):
--       NOT graded (grade NULL, MOS NULL), never counted as one-way audio.
--
-- The thresholds are named constants in ONE place — NO_RTP_RATIO = 0.10 and
-- ONE_WAY_MIN_OUT_RATIO = 0.50 in docker/api/src/services/call_quality.py —
-- mirrored literally here; a parity test (tests/test_cdr_quality_migration51.py)
-- enforces agreement.
--
-- Why: the migration-50 backfill marked 485 legs no_rtp; 479 of them (week of
-- 2026-07-20, load-test/rollout) had 0 packets in AND 0 out, and one 902 s
-- call had 1863 in / 397 out (both sides quiet). Only 5 were one-way audio.
--
-- WHAT THIS FILE DOES — only CREATE OR REPLACE FUNCTION + comments + grants
-- (NO column, NO data change; the one-off reclassification of stored rows is
-- docker/postgres/backfill/51_reclassify_no_media.psql):
--   * NEW overload cq_leg_status(bool, int, int, int, int) — the full rule,
--     p_out_packets NULL -> 'no_media'. All five arguments are required, so
--     calls with 3/4 arguments keep resolving to the migration-50 function.
--   * The migration-50 cq_leg_status(bool, int, int, int) is left UNCHANGED
--     (the inbound-only gate: its 'no_rtp' = "inbound < 10%", either split
--     status). 50_cdr_quality_backfill.psql still calls it, so a re-run of
--     that backfill must be followed by 51_reclassify_no_media.psql.
--   * cdr_refresh_call_quality() needs NO change: no_media carries no grade
--     (so it never wins the worse-direction pick), is not 'no_rtp' (so it
--     never makes the call no_rtp) and is not 'rated'; a no_media A with no
--     graded/rated B yields call_quality_status 'no_media' via its
--     "else the A status" branch.
--
-- Requires 50. IDEMPOTENT + REPLAYABLE (plain SQL, `psql -f`, re-runnable).
-- Safe for the OLD (pre-51) API: nothing it reads or writes changes.
-- Rollback: nothing to undo for the functions (the 5-arg overload is unused
-- by the old API); roll back the DATA with the command in the 51 backfill.
--
-- PRODUCTION NOTE: apply MANUALLY on the East primary (replicates):
--     hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/51_cdr_quality_no_media.sql
-- ==========================================================================

CREATE OR REPLACE FUNCTION cq_leg_status(p_answered bool, p_billable_ms int, p_in_packets int,
                                         p_ptime_ms int, p_out_packets int)
RETURNS varchar LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN NOT p_answered THEN 'unanswered'
              WHEN p_in_packets IS NULL THEN 'no_data'
              WHEN COALESCE(p_billable_ms,0) < 5000 THEN 'short'
              WHEN p_in_packets < 0.10 * p_billable_ms::float8 / p_ptime_ms THEN
                   CASE WHEN p_out_packets >= 0.50 * p_billable_ms::float8 / p_ptime_ms
                        THEN 'no_rtp' ELSE 'no_media' END    -- NULL out -> no_media
              WHEN p_in_packets < 250 THEN 'low_sample'
              ELSE 'rated' END $$;

COMMENT ON FUNCTION cq_leg_status(bool, int, int, int, int) IS
    'Per-leg rating status since migration 51 (mirrors services/call_quality.leg_status): inbound < 10% of expected -> no_rtp when outbound >= 50% of expected (true one-way), else no_media (no audio either way; NULL out -> no_media).';
COMMENT ON FUNCTION cq_leg_status(bool, int, int, int) IS
    'Migration-50 inbound-only gate (no outbound split): its no_rtp means "inbound < 10% of expected" and covers both no_rtp and no_media of the 5-argument overload. Kept for 50_cdr_quality_backfill.psql.';

COMMENT ON COLUMN cdrs.quality_status IS
    'Per-leg rating status (plan B.2): rated | no_rtp | no_media | low_sample | short | unanswered | no_data. no_rtp = inbound < 10% of expected while outbound >= 50% (true one-way audio, graded poor); no_media (since 51) = inbound < 10% and outbound < 50% or unknown (no audio either way, NOT graded). NULL = written by the pre-50 API and not yet backfilled.';
COMMENT ON COLUMN cdrs.quality_grade IS
    'Per-leg grade great/good/fair/poor = cq_grade(mos) when rated, poor when no_rtp, else NULL (not graded — incl. no_media).';
COMMENT ON COLUMN cdrs.inbound_media_ratio IS
    'min(inbound packets / (billable_ms / ptime), 999.999) for statuses rated/no_rtp/no_media/low_sample, else NULL.';
COMMENT ON COLUMN cdrs.call_quality_status IS
    'A rows only, set by cdr_refresh_call_quality(): no_rtp if either direction is no_rtp, else rated if either is rated, else the A status (may be no_media = not graded).';

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api') THEN
        EXECUTE 'GRANT EXECUTE ON FUNCTION cq_leg_status(bool, int, int, int, int) TO api';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_ro') THEN
        EXECUTE 'GRANT EXECUTE ON FUNCTION cq_leg_status(bool, int, int, int, int) TO grafana_ro';
    END IF;
END
$$;
