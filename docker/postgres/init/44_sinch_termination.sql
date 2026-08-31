-- ==========================================================================
-- 44_sinch_termination.sql
-- Sinch TERMINATION provisioning: per-trunk traffic class + the two Sinch
-- outbound trunk-group rows (Atlanta LD + Denver Toll-Free).
--
--   * carrier_trunks.traffic_class — TEXT NOT NULL DEFAULT 'any', CHECK
--     ('any','ld','tollfree'). Which DESTINATION classes a trunk may carry:
--     'any' = no restriction (all pre-44 rows keep this — behavior
--     unchanged), 'ld' = long-distance/international only, 'tollfree' =
--     NANP 8YY only. FreeSWITCH's attempt loop filters the cached trunk
--     list per call by classify_destination(dest) (inbound_router.lua);
--     Kamailio does NOT read this column (its X-Carrier-IP validation stays
--     direction/enabled only).
--   * Seed rows — the two Sinch OUTBOUND trunk groups (registered to all 6
--     SBC public IPs on the Sinch side; DIFFERENT IPs from the group-6/7
--     origination PoPs):
--       sinch/atlanta-ld  TG ATLNGAQSGR2_7214  206.146.98.26   'ld'
--                         (Sinch "INT" Long Distance, order 225468139)
--       sinch/denver-tf   TG DNVTCOZIGR2_3282  206.146.100.26  'tollfree'
--                         (Sinch "OSAO" 8YY-only, order 225468672)
--
-- ** THE FS TERMINATION-SELECTION CONTRACT (supersedes 42's) ** —
-- FreeSWITCH's outbound carrier-failover loop now runs EXACTLY (as the
-- `freeswitch` DB role, <z> in {east, west, central}):
--
--     SELECT carrier, pop, host(source_ip) AS term_ip, traffic_class,
--            COALESCE(priority_<z>, priority) AS eff_priority
--     FROM carrier_trunks
--     WHERE direction IN ('outbound','both') AND enabled = true
--     ORDER BY eff_priority, id
--
-- traffic_class joins the load-bearing column names of 40/42 — never
-- rename it.
--
-- ** THIS MIGRATION DOES NOT SHIFT LIVE ROUTING. ** The Sinch rows seed all
-- four priority columns explicitly at 30 (LD) / 40 (TF) — STRICTLY below
-- every Bandwidth priority in every zone (42 seeds Bandwidth at 10/20; West
-- swaps the PoPs but stays 10/20) — so both Bandwidth attempts are always
-- exhausted before any Sinch attempt. enabled=true is REQUIRED even while
-- Sinch carries no organic traffic: forced test calls stamp the trunk via
-- X-Carrier-IP and Kamailio's Step 1a validation only passes enabled
-- outbound rows. The class filter only ever NARROWS which calls may reach a
-- Sinch trunk (OSAO must never see an LD call and vice versa — Sinch
-- contract); Bandwidth rows stay 'any' and are untouched.
--
-- cps_limit 25: Sinch provisions 50 concurrent SESSIONS per trunk group;
-- cps_limit is 40's per-trunk INBOUND CPS backstop (inert for these
-- outbound-only rows unless direction is ever flipped) — 25 is a
-- conservative floor under the session cap, not a measured rate.
--
-- test_tn: Sinch LD test line 2139924610 (stored 10-digit, matching 40's
-- seed style). No TF test number was provided -> NULL.
--
-- Also widens the carrier_trunk_health view setid filter (2,3,6,7) ->
-- (2,3,6,7,8,9) for the new dispatcher keepalive groups 8 (Sinch Atlanta
-- LD) and 9 (Sinch Denver TF). Same full-copy pattern as 40: CREATE OR
-- REPLACE needs the whole definition.
--
-- IDEMPOTENT: safe to run repeatedly. ADD COLUMN IF NOT EXISTS (the inline
-- CHECK rides the column add, so it is never duplicated); the seed INSERT
-- is ON CONFLICT DO NOTHING (a seeded-then-edited row is never
-- overwritten); the view is CREATE OR REPLACE; grants are unconditional
-- re-asserts (harmless).
--
-- PRODUCTION NOTE: Postgres init scripts here ONLY run on the first initdb
-- of a fresh data directory. The production primary already exists, so apply
-- MANUALLY on the bare-metal prod primary (services VM, 10.142.0.103), where
-- it replicates to every zone replica (FS reads it via its LOCAL replica):
--     sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/init/44_sinch_termination.sql
-- Run it as a SUPERUSER (postgres). Requires 40_carrier_trunks.sql and
-- 42_carrier_priorities.sql (table + priority columns). Apply BEFORE pulling
-- the FS Lua that selects traffic_class — until the column replicates, that
-- SELECT errors and FS fails open to the legacy Bandwidth attempts.
-- ==========================================================================

-- ---------------------------------------------------------------------------
-- carrier_trunks.traffic_class — destination-class restriction.
-- ---------------------------------------------------------------------------
ALTER TABLE carrier_trunks
    ADD COLUMN IF NOT EXISTS traffic_class TEXT NOT NULL DEFAULT 'any'
    CHECK (traffic_class IN ('any', 'ld', 'tollfree'));

-- ---------------------------------------------------------------------------
-- Seed — the two Sinch termination trunk groups. ON CONFLICT DO NOTHING
-- keeps re-runs (and later admin edits) authoritative. All four priority
-- columns are EXPLICIT so no later edit to a global default can ever float
-- a Sinch trunk above Bandwidth in any zone by accident.
-- ---------------------------------------------------------------------------
INSERT INTO carrier_trunks
    (carrier, pop, trunk_group, source_ip, test_tn, direction, traffic_class,
     cps_limit, enabled, priority, priority_east, priority_west,
     priority_central, notes)
VALUES
    ('sinch', 'atlanta-ld', 'ATLNGAQSGR2_7214', '206.146.98.26', '2139924610',
     'outbound', 'ld', 25, true, 30, 30, 30, 30,
     'Sinch INT LD termination — TG ATLNGAQSGR2_7214, Sinch order 225468139. 50 concurrent sessions per Sinch; cps_limit 25 is the inbound backstop only (row is outbound-only).'),
    ('sinch', 'denver-tf', 'DNVTCOZIGR2_3282', '206.146.100.26', NULL,
     'outbound', 'tollfree', 25, true, 40, 40, 40, 40,
     'Sinch OSAO 8YY termination — TG DNVTCOZIGR2_3282, Sinch order 225468672. Toll-free (8YY) destinations ONLY per contract; 50 concurrent sessions per Sinch.')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- carrier_trunk_health — refresh for the Sinch termination dispatcher
-- groups. Identical to the 40_carrier_trunks.sql view except the setid
-- filter grows (2, 3, 6, 7) -> (2, 3, 6, 7, 8, 9). Kept as a full copy
-- because CREATE OR REPLACE needs the whole definition.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW carrier_trunk_health AS
SELECT
    s.duid,
    -- name/ip/setid are per-carrier; MAX() collapses the identical per-SBC copies
    -- into one representative value (they agree across SBCs for a given duid).
    MAX(s.name)  AS name,
    MAX(s.ip)    AS ip,
    MAX(s.setid) AS setid,
    COUNT(*) FILTER (WHERE s.is_up)  AS up_sbcs,
    COUNT(*)                          AS total_sbcs,
    bool_or(s.is_up)                  AS is_up,          -- up on >=1 SBC => usable
    MAX(s.updated_at)                 AS last_updated,
    (MAX(s.updated_at) < now() - interval '90 seconds') AS stale,
    CASE
        WHEN MAX(s.updated_at) < now() - interval '90 seconds' THEN 'stale'
        WHEN bool_or(s.is_up)                                   THEN 'up'
        ELSE 'down'
    END AS status
FROM carrier_trunk_status s
-- The live carriers: Bandwidth Dallas (setid 2) + LA (setid 3), Sinch
-- origination Denver (setid 6) + Chicago (setid 7), and Sinch termination
-- Atlanta LD (setid 8) + Denver TF (setid 9). The Bandwidth TC1/TC2 PoPs
-- (setid 4/5) are unused, so they stay excluded structurally — even if a
-- lagging poller ever reports one, it can never surface in the health
-- view/map.
WHERE s.setid IN (2, 3, 6, 7, 8, 9)
GROUP BY s.duid;

-- ---------------------------------------------------------------------------
-- Grants — re-asserts of 40's (TABLE-level, so the new column is already
-- covered; unconditional and harmless on re-run).
-- ---------------------------------------------------------------------------
GRANT SELECT ON carrier_trunks TO freeswitch;
GRANT ALL    ON carrier_trunks TO api;
GRANT USAGE, SELECT ON carrier_trunks_id_seq TO api;

-- Re-assert the health-view readers (grants survive CREATE OR REPLACE; this
-- mirrors 40 and is harmless on re-run).
GRANT SELECT ON carrier_trunk_health TO api;
GRANT SELECT ON carrier_trunk_health TO grafana_ro;
