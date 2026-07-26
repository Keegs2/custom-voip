-- ==========================================================================
-- 23_onnet_cdr_columns.sql
-- On-net (internal) routing CDR columns.
--
-- Records BOTH parties of an on-net call on the single A-leg CDR
-- (mod_json_cdr is A-leg-only -> one CDR per logical call, unchanged):
--   * origin_customer_id      -- the customer whose DID the call first entered
--   * terminating_customer_id -- the customer whose DID actually handled it
--   * on_net                  -- true when the carrier hairpin was short-circuited
--   * on_net_hops             -- number of internal RCF hops resolved in-memory
--
-- customer_id itself is set to the TERMINAL customer by FreeSWITCH, so
-- rate_cdr() (which rates customer_id) is UNCHANGED. For off-net calls
-- FreeSWITCH sets origin_customer_id == customer_id and on_net=false, so
-- existing rows/queries stay backward-compatible.
--
-- Cross-customer settlement (origin != terminating) is DEFERRED policy: the
-- CDR records both parties so any downstream model can be applied later.
-- See docs/ONNET_ROUTING_DESIGN.md sections 4 and 11.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS, so safe
-- to run repeatedly and on the existing, populated cdrs hypertable (ADD COLUMN
-- on a TimescaleDB hypertable propagates to all chunks). Mirrors the style of
-- 16_cdr_detail_columns.sql / 18_sbc_id_column.sql.
--
-- PRODUCTION NOTE: Postgres init scripts here ONLY run on the first initdb of a
-- fresh data directory. The production primary already exists, so apply
-- MANUALLY on the bare-metal prod primary (services VM, 10.142.0.103), then let
-- it replicate to the standbys:
--     sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/init/23_onnet_cdr_columns.sql
-- The `api` DB user already has ALL on cdrs; `freeswitch` already has
-- SELECT, INSERT on cdrs -- no new grants required.
-- ==========================================================================

ALTER TABLE cdrs ADD COLUMN IF NOT EXISTS origin_customer_id INT;
ALTER TABLE cdrs ADD COLUMN IF NOT EXISTS terminating_customer_id INT;
ALTER TABLE cdrs ADD COLUMN IF NOT EXISTS on_net BOOLEAN DEFAULT false;
ALTER TABLE cdrs ADD COLUMN IF NOT EXISTS on_net_hops SMALLINT;

-- Partial index for "calls this customer ORIGINATED" (on-net billing /
-- settlement lookups). Only indexes rows where origin_customer_id is set,
-- keeping the index small (NULL on legacy rows written before this migration).
CREATE INDEX IF NOT EXISTS idx_cdrs_origin_customer
    ON cdrs (origin_customer_id, start_time DESC)
    WHERE origin_customer_id IS NOT NULL;
