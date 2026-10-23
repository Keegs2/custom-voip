-- ==========================================================================
-- 57_trunk_dids_trunk_index.sql
-- Index trunk_dids(trunk_id): the number_routing trunk arm's customer path.
--
-- WHY: the API reads "a customer's numbers" from the number_routing view
-- (docker/api/src/services/customer_numbers.py, plan
-- docs/CUSTOMER_NUMBERS_HOLISTIC_PLAN.md §3.3/§3.4) with
-- `WHERE customer_id = $1`, pushed into every UNION ALL arm. The rcf, api and
-- voicemail arms have customer_id indexes (idx_rcf_customer,
-- idx_api_did_customer, idx_voicemail_boxes_customer); the trunk arm reaches
-- sip_trunks through idx_trunks_customer but then joined trunk_dids by Seq
-- Scan (trunk_dids only had UNIQUE(did) + the hash idx_trunk_did_lookup).
-- Also serves trunks.py's per-trunk did_count sub-selects and the sip_trunks
-- ON DELETE CASCADE. NOT the FreeSWITCH point lookup (that stays
-- idx_trunk_did_lookup on did) — this changes nothing on the call path.
--
-- LOCKING: a plain CREATE INDEX takes a SHARE lock on trunk_dids for the
-- build: it blocks writes (an admin DID assign) for milliseconds on a tiny
-- table and never blocks reads (call routing). lock_timeout makes it fail
-- fast instead of queueing behind a long transaction; on a timeout just
-- re-run it. Idempotent (IF NOT EXISTS): a second run is a no-op.
--
-- PRODUCTION NOTE: init scripts only run on the first initdb of a fresh data
-- directory. Apply MANUALLY on the bare-metal East primary (services VM,
-- 10.142.0.103); the index replicates to every zone replica. Independent of
-- the API build (the API is correct without it, only slower on the trunk
-- arm), so it can go first, any time:
--     hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/57_trunk_dids_trunk_index.sql
--
-- Verification (after applying):
--     sudo -u postgres psql -d voip -f /opt/revup/scripts/db/check_migrations.sql
-- ==========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS idx_trunk_dids_trunk ON trunk_dids (trunk_id);

COMMIT;
