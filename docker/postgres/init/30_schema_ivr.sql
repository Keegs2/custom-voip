-- ==========================================================================
-- 30_schema_ivr.sql
-- IVR flow persistence + API-credential management columns.
--
-- Idempotent (safe to run on the prod primary and to re-run). Init scripts only
-- run on a fresh initdb, so on existing databases apply this manually on the
-- East primary; it replicates to all zone replicas:
--   sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/init/30_schema_ivr.sql
-- ==========================================================================

-- --------------------------------------------------------------------------
-- IVR flows — customer-built call flows stored as a JSON node graph.
-- Backs the /ivr router and the React IVR builder (api/ivr.ts + types/ivr.ts):
-- the `definition` JSONB holds { nodes, entry_node_id, description, did }.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ivr_flows (
    id           SERIAL PRIMARY KEY,
    customer_id  INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    name         VARCHAR(100) NOT NULL,
    definition   JSONB NOT NULL DEFAULT '{}'::jsonb,   -- { nodes:[], entry_node_id, description, did }
    is_active    BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ivr_flows_customer ON ivr_flows(customer_id);

GRANT ALL ON ivr_flows TO api;
GRANT SELECT ON ivr_flows TO freeswitch;
GRANT USAGE, SELECT ON ivr_flows_id_seq TO api;

-- --------------------------------------------------------------------------
-- API credentials — additive columns for the management UI / API-key auth.
--   label        : human-friendly name shown in the credentials list
--   last_used_at : stamped on each successful API-key authentication
-- `enabled` (existing) remains the source of truth for active/revoked; the API
-- exposes it as a `status` string ('active' | 'revoked').
-- --------------------------------------------------------------------------
ALTER TABLE api_credentials ADD COLUMN IF NOT EXISTS label        VARCHAR(100);
ALTER TABLE api_credentials ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;
