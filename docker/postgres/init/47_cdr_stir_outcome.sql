-- ==========================================================================
-- 47_cdr_stir_outcome.sql
-- STIR/SHAKEN egress OUTCOME on the CDR — the ACTUAL wire result.
--
-- WHY: call_attestations.signed_attestation (32_call_attestations.sql) is
-- derived from what FreeSWITCH INTENDED (stir_attest_intent +
-- stir_inbound_signed). Kamailio now reports what it REALLY did on the
-- carrier leg — relayed the inbound Identity, signed div, re-originated,
-- gateway-C, base-only, or emitted nothing — as an X-Stir-Outcome response
-- header. FreeSWITCH surfaces it on the A-leg as the `stir_outcome` channel
-- var (or, with mod_json_cdr log-b-leg=true, as sip_rh_X-Stir-Outcome on the
-- B-leg CDR); /v1/cdrs/ingest stores it here. The UI/API badge prefers this
-- ACTUAL value and falls back to the intent-derived one, flagging which it is.
--
-- Columns (both nullable; legacy rows and calls that never reached the
-- carrier stay NULL):
--   * stir_outcome     -- raw value, e.g.
--                         "eff=div;mode=relay;identities=1;base=1;div=1;stripped=0"
--   * stir_eff_actual  -- the `eff=` token only (div | A | B | C | base-only |
--                         unsigned — value-agnostic, no CHECK on purpose so a
--                         new Kamailio label never fails an INSERT)
--
-- cdrs is a TimescaleDB hypertable: ADD COLUMN (no default) is metadata-only
-- and is supported on hypertables with compressed chunks. NO index: the
-- columns are read per-row by uuid (idx_cdrs_uuid) and the Grafana STIR board
-- is metric/call_attestations-backed — an index on a low-cardinality TEXT
-- column across every chunk would cost far more than it returns.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; grants are re-assertable.
--
-- PRODUCTION NOTE: init scripts here ONLY run on the first initdb of a fresh
-- data directory. Apply MANUALLY on the bare-metal prod primary (services VM,
-- 10.142.0.103); it replicates to east-db-standby / west-db / central-db /
-- sandbox_replica:
--     sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/init/47_cdr_stir_outcome.sql
-- Apply BEFORE deploying the API build that binds $56/$57 (the INSERT names
-- the columns and would fail on every CDR until they exist). Requires 05.
-- ==========================================================================

ALTER TABLE cdrs
    ADD COLUMN IF NOT EXISTS stir_outcome    TEXT,
    ADD COLUMN IF NOT EXISTS stir_eff_actual TEXT;

COMMENT ON COLUMN cdrs.stir_outcome IS
    'Raw STIR egress outcome from Kamailio (X-Stir-Outcome): eff=..;mode=..;identities=..;base=..;div=..;stripped=..';
COMMENT ON COLUMN cdrs.stir_eff_actual IS
    'eff= token of stir_outcome: the attestation ACTUALLY on the wire (div|A|B|C|base-only|unsigned). NULL = unknown -> UI falls back to intent.';

-- Same access pattern as the rest of the CDR surface: the API ingests
-- (INSERT + the B-leg UPDATE path) and reads; freeswitch never touches cdrs
-- directly; grafana_ro (24_grafana_ro.sql) already has SELECT on the whole
-- table.
--
-- STRICTLY SPEAKING THESE GRANTS ARE NOT REQUIRED: PostgreSQL table-level
-- privileges cover columns added later, and 23_onnet_cdr_columns.sql (the
-- closest precedent — also a pure cdrs ADD COLUMN) adds none at all. They are
-- re-asserted only so this file is self-sufficient on a checkout where 05/24
-- were never applied. BOTH are role-guarded: an UNGUARDED `GRANT ... TO api`
-- ABORTS the whole migration (and therefore the ADD COLUMNs, since psql runs
-- this file in one implicit transaction per statement but an operator may wrap
-- it in one) on any cluster that has no `api` role — e.g. a throwaway test DB
-- or a lean checkout.
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
