-- ==========================================================================
-- 29_schema_trunk_routes.sql
-- Adds trunk_dids.route_plan — the compiled SIP-trunk inbound route plan that
-- the Call Flow Builder publishes (product = 'trunk'). The FreeSWITCH Lua reads
-- trunk_dids (DID lookup) to route an inbound call to the trunk's endpoint(s):
-- failover (try in order) or parallel (ring together), with per-endpoint timeout.
--
-- Sorts AFTER 28_schema_ring_plan.sql and after 26_resync_sequences.sql. This
-- file only ADDs a nullable column + re-asserts a read grant — no sequences, no
-- seeded rows — so running it after 26 is safe.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS / idempotent GRANT) so it can be
-- hand-applied to the existing prod + sandbox databases — init scripts only run
-- on a fresh initdb, so this same file is the manual-apply migration for
-- already-provisioned DBs.
--
-- route_plan is NULLABLE on purpose: NULL = legacy first-endpoint bridge
-- (inbound_router.lua bridges endpoint_ips[1]). A non-NULL route_plan is the
-- FLAT compiled artifact (CALL_FLOW_BUILDER_PLAN §12, snake_case keys exactly):
--   { "strategy": "failover"|"parallel", "timeout": int,
--     "endpoints": [ { "to": str, "timeout"?: int } ] }
-- ==========================================================================
BEGIN;

ALTER TABLE trunk_dids
    ADD COLUMN IF NOT EXISTS route_plan JSONB;

COMMENT ON COLUMN trunk_dids.route_plan IS
    'Compiled SIP-trunk inbound route plan (flat JSON: strategy, timeout, endpoints[]). NULL = legacy first-endpoint bridge.';

-- trunk_dids already grants SELECT to freeswitch + ALL to api in
-- 02_schema_core.sql; column grants are inherited by new columns. Re-assert the
-- freeswitch read grant to be explicit and to keep this file self-contained when
-- hand-applied (the Lua reads trunk_dids each call). api already has ALL.
GRANT SELECT ON trunk_dids TO freeswitch;

COMMIT;
