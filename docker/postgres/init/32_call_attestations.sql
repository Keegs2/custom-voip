-- ==========================================================================
-- 32_call_attestations.sql
-- STIR/SHAKEN attestation visibility — companion table to cdrs.
--
-- Records, per carrier-bound call, the attestation story derived from the
-- raw stir_* channel vars FreeSWITCH emits on every call (captured by
-- mod_json_cdr -> /v1/cdrs/ingest). This is a SEPARATE table on purpose:
-- the cdrs hypertable schema is NOT touched (no ALTER on cdrs), so CDR
-- ingest / rating / TimescaleDB partitioning are completely unaffected.
--
-- Columns:
--   * call_id             -- the CDR correlation key (cdrs.uuid). PK.
--   * customer_id         -- tenant; the TERMINAL customer, same value the
--                            paired CDR stores in cdrs.customer_id, so read
--                            tenant-scoping matches CDR tenant-scoping exactly.
--   * signed_attestation  -- A/B/C/div: what WE actually emitted outbound,
--                            DERIVED in the API (see cdrs.py ingest):
--                              signed_attestation =
--                                (attest_intent='div' AND inbound_signed=false)
--                                  ? 'C' : attest_intent
--                            (RCF forward of an UNSIGNED inbound really goes
--                             out as C; a SIGNED inbound chains as div;
--                             trunk/API are A/B.)
--   * attest_intent       -- raw stir_attest_intent (A | B | div) we set.
--   * inbound_signed      -- did we have an inbound Identity to chain (bool).
--   * inbound_attest      -- A/B/C: the ORIGINATING carrier's attestation of
--                            the caller (from inbound P-Attestation-Indicator).
--                            NULL when unknown / not present.
--   * inbound_verstat     -- inbound caller verification result
--                            (TN-Validation-Passed / -Failed / No-TN-Validation).
--                            NULL when unknown.
--   * verstat_source      -- 'self' (our own crypto) | 'carrier' (their PAI).
--                            NULL when unknown.
--   * created_at          -- ingest time.
--
-- The per-call story surfaced by the read API is:
--   caller `inbound_attest` (verified via `inbound_verstat`) -> we emitted
--   `signed_attestation`.  e.g. "caller A, TN-Validation-Passed -> div".
--
-- IDEMPOTENT: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS, safe to
-- run repeatedly. This is a PLAIN table (NOT a TimescaleDB hypertable) — it is
-- keyed by call_id for point lookups and range-scanned per customer/time for
-- the summary; volume is one small row per carrier-bound call.
--
-- PRODUCTION NOTE: Postgres init scripts here ONLY run on the first initdb of a
-- fresh data directory. The production primary already exists, so apply
-- MANUALLY on the bare-metal prod primary (services VM, 10.142.0.103), then let
-- it replicate to the standbys:
--     sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/init/32_call_attestations.sql
-- ==========================================================================

CREATE TABLE IF NOT EXISTS call_attestations (
    call_id            TEXT PRIMARY KEY,
    customer_id        INT NOT NULL,
    signed_attestation TEXT,
    attest_intent      TEXT,
    inbound_signed     BOOLEAN,
    inbound_attest     TEXT,
    inbound_verstat    TEXT,
    verstat_source     TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Aggregate summary path: GROUP BY over a customer + time window.
CREATE INDEX IF NOT EXISTS idx_call_attestations_customer_time
    ON call_attestations (customer_id, created_at DESC);

-- Point lookup by call_id is served by the PRIMARY KEY. A separate index on
-- call_id would be redundant (the PK already provides a unique btree on it),
-- so it is intentionally omitted.

-- The `api` DB user needs full access (ingest UPSERT + reads). `freeswitch`
-- does NOT touch this table — the API derives and writes it during CDR ingest,
-- so no freeswitch grant is required.
GRANT SELECT, INSERT, UPDATE, DELETE ON call_attestations TO api;
