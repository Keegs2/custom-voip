-- ==========================================================================
-- 33_call_attestation_sip_callid.sql
-- Correlate STIR/SHAKEN attestations to Homer SIP-trace search results.
--
-- Homer's SIP Trace Search (POST /v1/homer/search) keys every returned message
-- by the INBOUND SIP Call-ID header value — the raw string heplify-server puts
-- in the Loki `call_id` label (e.g. "526960203_96407297@67.231.9.142"), NOT the
-- FreeSWITCH channel UUID. call_attestations is keyed by call_id = cdrs.uuid
-- (the FS channel UUID), so the two cannot be joined directly.
--
-- FreeSWITCH's `sip_call_id` channel var IS that inbound Call-ID: on the A-leg
-- (the ONLY leg mod_json_cdr emits — json_cdr.conf.xml has cdr-leg=a /
-- log-b-leg=false) sip_call_id is the Call-ID header of the inbound INVITE, the
-- exact value Homer captures. Storing it here gives the search a single-column
-- equality join (sip_call_id) to the attestation.
--
-- This ALTER is ADDITIVE and IDEMPOTENT:
--   * ADD COLUMN IF NOT EXISTS — safe to re-run; existing rows get NULL.
--   * It does NOT touch the cdrs hypertable, the call_attestations PK/columns,
--     or the ingest 200-contract. sip_call_id is nullable: old rows and calls
--     with no captured Call-ID simply stay NULL and never match a search.
--
-- INDEX: idx_call_attestations_sip_call_id serves the batch enrichment lookup
--   SELECT ... FROM call_attestations WHERE sip_call_id = ANY($1::text[])
-- issued once per Homer search over that page's Call-IDs. A plain btree is
-- correct: `= ANY(array)` is planned as a set of equality probes into the btree.
-- Partial (WHERE sip_call_id IS NOT NULL) so the NULL rows (signing off / legacy
-- / pre-migration) never bloat the index — they can never match an equality
-- probe anyway.
--
-- PRODUCTION NOTE: Postgres init scripts here ONLY run on the first initdb of a
-- fresh data directory. The production primary already exists, so apply MANUALLY
-- on the bare-metal prod primary (services VM, 10.142.0.103), then let it
-- replicate to the standbys:
--     sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/init/33_call_attestation_sip_callid.sql
-- ==========================================================================

ALTER TABLE call_attestations
    ADD COLUMN IF NOT EXISTS sip_call_id TEXT;

-- Batch join key for Homer search enrichment (= ANY($1::text[]) equality probes).
-- Partial index: NULL sip_call_id (signing off / legacy rows) never matches an
-- equality probe, so exclude it to keep the index tight.
CREATE INDEX IF NOT EXISTS idx_call_attestations_sip_call_id
    ON call_attestations (sip_call_id)
    WHERE sip_call_id IS NOT NULL;

-- No new grants required: the `api` DB user already has
-- SELECT/INSERT/UPDATE/DELETE on call_attestations (32_call_attestations.sql),
-- which covers reading the new column in Homer search and writing it in ingest.
