-- ==========================================================================
-- 30_schema_rcf_routing.sql
-- Adds rcf_numbers.routing_plan — the compiled RICH RCF routing plan that the
-- Call Flow Builder publishes (product = 'rcf', rich mode). The FreeSWITCH Lua
-- (handlers/rcf.lua) reads rcf_numbers per call: when routing_plan IS NULL it
-- takes the legacy single-forward path (forward_to + ring_timeout + pass-CID +
-- max_channels columns); when routing_plan IS NOT NULL it evaluates the ordered
-- match rules and rings each rule's leg(s), with a fallback action.
--
-- Sorts AFTER 29_schema_trunk_routes.sql, 28_schema_ring_plan.sql and after
-- 26_resync_sequences.sql. This file only ADDs a nullable column + re-asserts a
-- read grant — no sequences, no seeded rows — so running it after 26 is safe.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS / idempotent GRANT) so it can be
-- hand-applied to the existing prod + sandbox databases — init scripts only run
-- on a fresh initdb, so this same file is the manual-apply migration for
-- already-provisioned DBs.
--
-- routing_plan is NULLABLE on purpose: NULL = legacy single forward_to (the
-- runtime uses the flat columns). A non-NULL routing_plan is the compiled rich
-- artifact (CALL_FLOW_BUILDER_PLAN §12, snake_case keys exactly):
--   { "rules": [ { "match": ..., "ring": ... } ],
--     "fallback": { "type": str, "to"?: str } }
-- The legacy forward_to column stays populated (NOT NULL) even in rich mode so
-- the row is valid; it is unused by the runtime when routing_plan is present.
-- ==========================================================================
BEGIN;

ALTER TABLE rcf_numbers
    ADD COLUMN IF NOT EXISTS routing_plan JSONB;

COMMENT ON COLUMN rcf_numbers.routing_plan IS
    'Compiled rich RCF routing plan (JSON: rules[], fallback). NULL = legacy single forward_to.';

-- rcf_numbers already grants SELECT to freeswitch + ALL to api in
-- 02_schema_core.sql; column grants are inherited by new columns. Re-assert the
-- freeswitch read grant to be explicit and to keep this file self-contained when
-- hand-applied (the Lua reads rcf_numbers each call). api already has ALL.
GRANT SELECT ON rcf_numbers TO freeswitch;

COMMIT;
