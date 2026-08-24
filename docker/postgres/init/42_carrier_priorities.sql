-- ==========================================================================
-- 42_carrier_priorities.sql
-- Table-driven carrier TERMINATION redundancy: per-trunk termination
-- priorities (global + per-zone overrides) on carrier_trunks, and a
-- first-class did_inventory.carrier (the owning carrier of every DID).
--
--   * carrier_trunks.priority          — INT NOT NULL DEFAULT 100, lower =
--     tried first. Global termination order.
--   * carrier_trunks.priority_east / priority_west / priority_central —
--     per-zone overrides; NULL = use `priority`. Lets each zone keep its
--     nearest-PoP preference (today: East/Central prefer Dallas, West
--     prefers LA) from ONE table instead of hardcoded env vars.
--   * did_inventory.carrier            — VARCHAR(50) NULL, the carrier that
--     owns the DID. NULL = legacy implicit Bandwidth (pre-42 rows and
--     rows the Bandwidth sync inserts); readers COALESCE(d.carrier,
--     ct.carrier, 'bandwidth').
--
-- ** THE FS TERMINATION-SELECTION CONTRACT ** — FreeSWITCH's outbound
-- carrier-failover loop builds its per-zone attempt list by running EXACTLY
-- this (as the `freeswitch` DB role, <z> in {east, west, central}):
--
--     SELECT carrier, pop, host(source_ip) AS term_ip,
--            COALESCE(priority_<z>, priority) AS eff_priority
--     FROM carrier_trunks
--     WHERE direction IN ('outbound','both') AND enabled = true
--     ORDER BY eff_priority, id
--
-- The column names carrier / pop / source_ip / priority / priority_east /
-- priority_west / priority_central (and 40's direction / enabled) are
-- load-bearing for that SQL — never rename them. source_ip doubles as the
-- termination signaling target (true for Bandwidth's symmetric PoP IPs); if
-- a future carrier terminates on a different IP than it originates from, add
-- a term_ip column and point the SELECT at COALESCE(term_ip, source_ip) —
-- that escape hatch is documented here, deliberately not built.
--
-- Disabling a trunk row (admin PUT enabled=false) removes it from every
-- zone's attempt list on the next call — redundancy is operated from the
-- table, no config push.
--
-- SEEDS preserve TODAY'S per-zone behavior exactly:
--     bandwidth/dallas  priority 10, priority_west 20   (East/Central first)
--     bandwidth/la      priority 20, priority_west 10   (West first)
--     sinch/denver      priority 10   (no zone overrides)
--     sinch/chicago     priority 20   (no zone overrides)
-- Sinch rows keep direction='inbound' (40's seed), so they NEVER match the
-- termination SELECT until an operator flips direction — turning Sinch
-- termination on is a table edit, not a code change.
--
-- The seed UPDATEs are guarded to fire only while the row still carries the
-- column DEFAULTS (priority = 100 AND the touched override IS NULL), so
-- re-runs NEVER clobber operator-edited priorities. (Corollary: an operator
-- who deliberately resets a row to exactly priority=100/override NULL will
-- see it re-seeded on the next run — that state means "never tuned".)
--
-- INDEXES: none added. The termination SELECT scans carrier_trunks — a
-- handful of rows — and 40's idx_carrier_trunks_enabled_direction already
-- covers its predicate. did_inventory.carrier is only read through the
-- non-sargable COALESCE in the admin-paged /v1/numbers/inventory filter;
-- it is not on any call path.
--
-- IDEMPOTENT: safe to run repeatedly. ADD COLUMN IF NOT EXISTS throughout;
-- seed UPDATEs are default-guarded (above); the did_inventory.carrier
-- backfill only touches carrier IS NULL rows and recomputes the same
-- implicit value the API renders (trunk's carrier, else 'bandwidth');
-- grants are unconditional re-asserts (the existing TABLE-level grants
-- already cover new columns — re-asserting is belt-and-braces, harmless).
--
-- PRODUCTION NOTE: Postgres init scripts here ONLY run on the first initdb
-- of a fresh data directory. The production primary already exists, so apply
-- MANUALLY on the bare-metal prod primary (services VM, 10.142.0.103), where
-- it replicates to every zone replica (FS reads it via its LOCAL replica):
--     sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/init/42_carrier_priorities.sql
-- Run it as a SUPERUSER (postgres). Requires 40_carrier_trunks.sql and
-- 41_did_carrier_source.sql (carrier_trunks + did_inventory.carrier_trunk_id).
-- ==========================================================================

-- ---------------------------------------------------------------------------
-- carrier_trunks — termination priorities (global + per-zone overrides).
-- ---------------------------------------------------------------------------
ALTER TABLE carrier_trunks
    ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 100;
ALTER TABLE carrier_trunks
    ADD COLUMN IF NOT EXISTS priority_east INT;
ALTER TABLE carrier_trunks
    ADD COLUMN IF NOT EXISTS priority_west INT;
ALTER TABLE carrier_trunks
    ADD COLUMN IF NOT EXISTS priority_central INT;

-- ---------------------------------------------------------------------------
-- Seed priorities — TODAY'S behavior (East/Central prefer Dallas, West
-- prefers LA). Guarded on the column defaults so operator edits survive
-- re-runs; once a row is seeded (priority != 100) the UPDATE never matches.
-- ---------------------------------------------------------------------------
UPDATE carrier_trunks SET priority = 10, priority_west = 20, updated_at = NOW()
 WHERE carrier = 'bandwidth' AND pop = 'dallas'
   AND priority = 100 AND priority_west IS NULL;

UPDATE carrier_trunks SET priority = 20, priority_west = 10, updated_at = NOW()
 WHERE carrier = 'bandwidth' AND pop = 'la'
   AND priority = 100 AND priority_west IS NULL;

UPDATE carrier_trunks SET priority = 10, updated_at = NOW()
 WHERE carrier = 'sinch' AND pop = 'denver' AND priority = 100;

UPDATE carrier_trunks SET priority = 20, updated_at = NOW()
 WHERE carrier = 'sinch' AND pop = 'chicago' AND priority = 100;

-- ---------------------------------------------------------------------------
-- did_inventory.carrier — the owning carrier, first-class (intake writes it;
-- POST /v1/numbers/add now takes carrier as REQUIRED and the trunk as
-- optional). NULL = legacy implicit Bandwidth. Backfill derives it from the
-- 41 trunk attribution where present, else 'bandwidth' — exactly the value
-- the API's COALESCE has always rendered, so this changes no visible state.
-- ---------------------------------------------------------------------------
ALTER TABLE did_inventory
    ADD COLUMN IF NOT EXISTS carrier VARCHAR(50);

UPDATE did_inventory
   SET carrier = COALESCE(
       (SELECT ct.carrier FROM carrier_trunks ct
         WHERE ct.id = did_inventory.carrier_trunk_id),
       'bandwidth')
 WHERE carrier IS NULL;

-- ---------------------------------------------------------------------------
-- Grants — re-asserts of 40's/41's (TABLE-level, so the new columns are
-- already covered; unconditional and harmless on re-run).
--   freeswitch : SELECT-only — the FS termination SELECT + routing lookups.
--   api        : full CRUD (/v1/carrier-trunks, /v1/numbers/*).
-- ---------------------------------------------------------------------------
GRANT SELECT ON carrier_trunks TO freeswitch;
GRANT ALL    ON carrier_trunks TO api;
GRANT USAGE, SELECT ON carrier_trunks_id_seq TO api;

GRANT SELECT ON did_inventory TO freeswitch;
GRANT ALL    ON did_inventory TO api;
GRANT USAGE, SELECT ON did_inventory_id_seq TO api;
