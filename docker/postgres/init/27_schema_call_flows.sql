-- ---------------------------------------------------------------------------
-- 27_schema_call_flows.sql — Universal Call Flow Builder store (product-agnostic)
-- ---------------------------------------------------------------------------
-- The Call Flow Builder edits one portable node-graph (the CallFlowDoc) per
-- product (ivr|rcf|trunk|api|conference|ucaas). This table is the SOURCE OF
-- TRUTH for the editable graph + draft/publish status + version. The RUNTIME is
-- unchanged: on publish, each product compiles its graph to the existing
-- per-product sink (IVR → ivr_flows.flow_config served by api_voice.lua;
-- RCF → rcf_numbers columns; etc.). FreeSWITCH/Lua keep reading their existing
-- sinks, so they need NO access to this table.
--
-- Locked decision #1 (CALL_FLOW_BUILDER_PLAN.md §0.1): build the generalized
-- call_flows table up front rather than extending ivr_flows. `sink_ref` records
-- the id of the product-sink row this flow publishes to (e.g. ivr_flows.id).
--
-- Least-privilege: the runtime `api` role has no CREATE on schema public, so
-- this table is provisioned by migration (the same pattern as 23_schema_ivr.sql),
-- WITH explicit grants to `api`. Idempotent + self-contained so it can be applied
-- by hand to existing production databases (init scripts only run on first initdb).
--
-- Ordering note: this sorts AFTER 26_resync_sequences.sql. That is fine —
-- call_flows has no explicit-id seeds, so the sequence resync is irrelevant to it.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS call_flows (
    id          INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product     VARCHAR(20) NOT NULL
                CHECK (product IN ('ivr','rcf','trunk','api','conference','ucaas')),
    name        TEXT NOT NULL,
    customer_id INT REFERENCES customers(id),
    entry       JSONB NOT NULL DEFAULT '{}'::jsonb,
    flow_graph  JSONB NOT NULL,                  -- editable CallFlowDoc (source of truth)
    compiled    JSONB,                           -- compiled product artifact (set on publish)
    status      VARCHAR(12) NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','published')),
    version     INT NOT NULL DEFAULT 1,
    sink_ref    INT,                             -- id of the product-sink row (e.g. ivr_flows.id)
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Listing: by product + owning customer; and by lifecycle status.
CREATE INDEX IF NOT EXISTS idx_call_flows_product_customer
    ON call_flows (product, customer_id);
CREATE INDEX IF NOT EXISTS idx_call_flows_status
    ON call_flows (status);

-- Grants — runtime API role needs row CRUD (least-privilege: no DDL).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE call_flows TO api;

-- Grant USAGE on the owning IDENTITY sequence so INSERTs can draw nextval.
-- (Resolved dynamically + idempotently; identity sequences have generated names.)
DO $$
DECLARE
    seqname TEXT;
BEGIN
    seqname := pg_get_serial_sequence('public.call_flows', 'id');
    IF seqname IS NOT NULL THEN
        EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO api', seqname);
    END IF;
END $$;

COMMIT;
