-- ==========================================================================
-- 28_schema_ring_plan.sql
-- Adds extensions.ring_plan — the compiled UCaaS Find-Me/Follow-Me ring plan
-- that the Call Flow Builder publishes (product = 'ucaas'). The FreeSWITCH Lua
-- reads this column (via db_client.lua) to ring an extension's legs in order
-- (sequential) or together (parallel), with a fallback action.
--
-- Sorts AFTER 27_schema_call_flows.sql (which the publish path writes) and after
-- 26_resync_sequences.sql. This file only ADDs a nullable column + re-asserts a
-- read grant — no sequences, no seeded rows — so running it after 26 is safe.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS / idempotent GRANT) so it can be
-- hand-applied to the existing prod + sandbox databases — init scripts only run
-- on a fresh initdb, so this same file is the manual-apply migration for
-- already-provisioned DBs.
--
-- ring_plan is NULLABLE on purpose: NULL = legacy single-bridge behavior
-- (extensions.forward_on_* / assigned_did single-target). A non-NULL ring_plan
-- is the FLAT compiled artifact (CALL_FLOW_BUILDER_PLAN §12):
--   { "strategy": "sequential"|"parallel", "ring_timeout": int,
--     "legs": [ { "to": str, "timeout"?: int } ],
--     "fallback": { "type": "voicemail"|"forward"|"hangup", "to"?: str } }
-- ==========================================================================
BEGIN;

ALTER TABLE extensions
    ADD COLUMN IF NOT EXISTS ring_plan JSONB;

COMMENT ON COLUMN extensions.ring_plan IS
    'Compiled UCaaS Find-Me/Follow-Me ring plan (flat JSON: strategy, ring_timeout, legs[], fallback). NULL = legacy single-bridge.';

-- extensions already grants ALL to api + SELECT to freeswitch in
-- 10_schema_ucaas.sql; column grants are inherited by new columns. Re-assert the
-- freeswitch read grant to be explicit and to keep this file self-contained when
-- hand-applied (the Lua reads ring_plan off extensions each call). api already
-- has ALL on extensions.
GRANT SELECT ON extensions TO freeswitch;

COMMIT;
