-- ==========================================================================
-- 60_cdr_ivr.sql
-- Visual IVR — CDR columns for the IVR outcome (contract docs/IVR_INTERFACES.md
-- §1.2 / §5.5; plan docs/IVR_PRODUCT_PLAN.md §4.4).
--
-- Columns (all nullable, NO default — every non-IVR row stays NULL):
--   * ivr_flow_id       BIGINT       call_flows.id the call ran
--   * ivr_flow_version  INT          call_flow_versions.version it ran (pinned
--                                    at call start; a mid-call publish never
--                                    changes it)
--   * ivr_exit          VARCHAR(16)  transfer | voicemail | hangup |
--                                    caller_hangup | timeout | error | limit
--                                    (no CHECK: a new FS label must never fail
--                                    a billable INSERT/UPDATE)
--   * ivr_path          VARCHAR(512) '>'-joined node ids + choices, e.g.
--                                    n_a1>n_m1:1>n_x (FS truncates with '…')
--   * ivr_transfer_to   VARCHAR(20)  E.164 of the last transfer target
--   * ivr_seconds       INT          answer -> transfer start (or -> end)
--
-- Written by POST /v1/cdrs/ingest on the A-leg row of an IVR call
-- (routers/cdrs.py `_apply_ivr_columns`: one UPDATE by uuid + start_time,
-- only when the CDR carries an ivr_* channel variable — every other product's
-- ingest path is unchanged). Transfer B-legs carry the leg-split cdr_* vars
-- with product_type 'ivr' and no ivr_* columns. Rated to zero by 59's
-- rate_cdr() clause.
--
-- cdrs is a TimescaleDB hypertable with compressed chunks: ADD COLUMN with NO
-- DEFAULT is metadata-only and supported on compressed hypertables (same form
-- as 47/48/50). Rollback is "stop writing them" — NEVER `DROP COLUMN` (a
-- rewrite on a compressed hypertable).
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; grants role-guarded + re-assertable.
--
-- PRODUCTION NOTE: init scripts ONLY run on the first initdb. Apply MANUALLY on
-- the East primary (services VM) — replicates to every standby/replica. Apply
-- after 59 and BEFORE the API build (its IVR ingest UPDATE and the CDR export
-- name these columns; the export cycle fails loudly — nothing lost — until
-- they exist):
--     hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/60_cdr_ivr.sql
-- ==========================================================================

ALTER TABLE cdrs
    ADD COLUMN IF NOT EXISTS ivr_flow_id      BIGINT,
    ADD COLUMN IF NOT EXISTS ivr_flow_version INT,
    ADD COLUMN IF NOT EXISTS ivr_exit         VARCHAR(16),
    ADD COLUMN IF NOT EXISTS ivr_path         VARCHAR(512),
    ADD COLUMN IF NOT EXISTS ivr_transfer_to  VARCHAR(20),
    ADD COLUMN IF NOT EXISTS ivr_seconds      INT;

COMMENT ON COLUMN cdrs.ivr_flow_id IS
    'IVR: call_flows.id the call ran (A-leg of an IVR call; NULL otherwise).';
COMMENT ON COLUMN cdrs.ivr_flow_version IS
    'IVR: published call_flow_versions.version the call ran (pinned at call start).';
COMMENT ON COLUMN cdrs.ivr_exit IS
    'IVR outcome: transfer | voicemail | hangup | caller_hangup | timeout | error | limit.';
COMMENT ON COLUMN cdrs.ivr_path IS
    'IVR: >-joined node ids and choices (e.g. n_a1>n_m1:1>n_x), truncated at 512 with a trailing ellipsis.';
COMMENT ON COLUMN cdrs.ivr_transfer_to IS
    'IVR: E.164 of the last transfer target (external or own DID), if any.';
COMMENT ON COLUMN cdrs.ivr_seconds IS
    'IVR: whole seconds from answer to the transfer start, or to the end of the call.';

-- Belt-and-braces grants (table-level privileges already cover new columns);
-- role-guarded so the file never aborts on a cluster without the role.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api') THEN
        EXECUTE 'GRANT ALL ON cdrs TO api';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_ro') THEN
        EXECUTE 'GRANT SELECT ON cdrs TO grafana_ro';
    END IF;
END
$$;
