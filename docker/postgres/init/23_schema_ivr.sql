-- ---------------------------------------------------------------------------
-- 23_schema_ivr.sql — Hosted IVR flow storage (UCaaS / programmable voice)
-- ---------------------------------------------------------------------------
-- The IVR builder stores customer-built IVR trees as JSON and serves them as
-- TwiML when calls arrive (see docker/api/src/routers/ivr.py).
--
-- Historically this table was created LAZILY by the API at first request. That
-- breaks under least-privilege: the runtime `api` role has no CREATE on schema
-- public, and even a lazily-created table carries no grants to `api`, so every
-- IVR endpoint 500s ("permission denied for ... ivr_flows"). This migration
-- provisions the table up front WITH the proper grants, the same as every other
-- UCaaS table. ivr.py keeps a guarded fallback but no longer depends on CREATE.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ivr_flows (
    id          SERIAL PRIMARY KEY,
    customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    did         VARCHAR(20),
    name        VARCHAR(100) NOT NULL,
    flow_config JSONB NOT NULL,
    is_active   BOOLEAN DEFAULT true,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Lookups: by customer (list/scope) and by DID (webhook routing).
CREATE INDEX IF NOT EXISTS idx_ivr_flows_customer ON ivr_flows (customer_id);
CREATE INDEX IF NOT EXISTS idx_ivr_flows_did ON ivr_flows (did);

-- Grants — runtime API role needs full CRUD; sequence for inserts.
GRANT ALL ON TABLE ivr_flows TO api;
GRANT USAGE, SELECT ON SEQUENCE ivr_flows_id_seq TO api;
