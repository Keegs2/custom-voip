-- ---------------------------------------------------------------------------
-- 31_schema_call_flow_versions.sql — Call Flow Builder publish version history
-- ---------------------------------------------------------------------------
-- Snapshots every successful publish of a call_flows row (migration 27). Each
-- publish appends one immutable row capturing the flow_graph (the editable
-- CallFlowDoc) and the compiled product artifact AS THEY WERE at publish time,
-- under a per-flow monotonic `version`. This backs the version-history API
-- (list / fetch / restore) so an operator can review past published states and
-- restore one back onto the draft without touching the live product sink.
--
-- `version` here is INDEPENDENT of call_flows.version: it is a dense, per-flow
-- publish counter (COALESCE(MAX(version),0)+1 scoped to flow_id), assigned in
-- the publish transaction. call_flows.version is the editable-revision counter
-- (bumped on every draft save); the two intentionally diverge.
--
-- ON DELETE CASCADE: deleting a call_flow drops its history with it (the flow
-- and its snapshots are one unit; delete_call_flow already leaves the product
-- sink intact independently of this table).
--
-- Idempotent + self-contained so it can be hand-applied to existing production
-- databases (init scripts only run on first initdb). Sorts AFTER 27 (the parent
-- table) and AFTER 26_resync_sequences.sql — this file seeds no explicit ids, so
-- running it after the resync is safe.
--
-- Least-privilege: the runtime `api` role gets SELECT + INSERT only (publish
-- appends, the API reads/restores). No UPDATE/DELETE — history is immutable and
-- only removed via the parent's ON DELETE CASCADE.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS call_flow_versions (
    id           INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    flow_id      INT NOT NULL REFERENCES call_flows(id) ON DELETE CASCADE,
    version      INT NOT NULL,                  -- per-flow, monotonic publish counter
    flow_graph   JSONB NOT NULL,                -- the CallFlowDoc at publish time
    compiled     JSONB,                         -- the compiled artifact at publish time
    published_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (flow_id, version)
);

-- History lookup: list / fetch newest-first per flow.
CREATE INDEX IF NOT EXISTS idx_call_flow_versions_flow_id
    ON call_flow_versions (flow_id);

-- Grants — runtime API role appends on publish and reads on list/restore.
GRANT SELECT, INSERT ON TABLE call_flow_versions TO api;

-- Grant USAGE on the owning IDENTITY sequence so INSERTs can draw nextval.
-- (Resolved dynamically + idempotently; identity sequences have generated names.)
DO $$
DECLARE
    seqname TEXT;
BEGIN
    seqname := pg_get_serial_sequence('public.call_flow_versions', 'id');
    IF seqname IS NOT NULL THEN
        EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO api', seqname);
    END IF;
END $$;

COMMIT;
