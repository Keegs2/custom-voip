-- ==========================================================================
-- 40_carrier_trunks.sql
-- Multi-carrier trunk registry (Bandwidth + Sinch) + inbound CDR attribution.
--
-- One row per carrier signaling IP (PoP/trunk-group). Three consumers:
--   * Kamailio SBCs — DB-backed trust fallback for unknown-source INVITEs.
--     sqlops (same 'trunk' connection / DB role as the customer trunk-auth
--     lookup) runs, per candidate INVITE:
--         SELECT carrier, pop, cps_limit FROM carrier_trunks
--         WHERE source_ip = '$si'::inet
--           AND direction IN ('inbound','both') AND enabled = true
--     ** CONTRACT: the column names carrier, pop, trunk_group, source_ip,
--     test_tn, direction, cps_limit, enabled are load-bearing for the SBC
--     config. Do NOT rename them. ** The UNIQUE(source_ip) backing index
--     makes that lookup a single indexed point read (0 or 1 row).
--   * FastAPI — admin CRUD at /v1/carrier-trunks (TED admin tool via the
--     revup-admin bridge) writes this table on the East primary.
--   * FreeSWITCH — sets inbound_carrier / inbound_carrier_pop channel vars
--     from the SBC's decision; the CDR ingest stores them in the two cdrs
--     columns added below (per-carrier CDR attribution/reporting).
--
-- Also folds in the carrier_trunk_health view refresh: the Sinch dispatcher
-- groups (setid 6 = Denver, setid 7 = Chicago) join Bandwidth Dallas (2) /
-- LA (3) in the NOC health view. The replace lives HERE because prod applies
-- migrations by number; 25_carrier_trunk_status.sql is amended in place for
-- fresh installs only.
--
-- IDEMPOTENT: safe to run repeatedly. CREATE TABLE/INDEX are IF NOT EXISTS,
-- cdrs column adds are guarded (hypertable-safe — ADD COLUMN IF NOT EXISTS on
-- a TimescaleDB hypertable propagates to all chunks, same pattern as
-- 23_onnet_cdr_columns.sql), seeds are ON CONFLICT DO NOTHING, the view is
-- CREATE OR REPLACE, and grants are unconditional (harmless to re-assert).
--
-- PRODUCTION NOTE: Postgres init scripts here ONLY run on the first initdb of
-- a fresh data directory. The production primary already exists, so apply
-- MANUALLY on the bare-metal prod primary (services VM, 10.142.0.103), where
-- it replicates to every zone replica (SBCs read it via their LOCAL replica):
--     sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/init/40_carrier_trunks.sql
-- Run it as a SUPERUSER (postgres). Writes (admin CRUD) go to the EAST
-- PRIMARY via the API — zone replicas are read-only.
-- ==========================================================================

-- ---------------------------------------------------------------------------
-- Table — one row per carrier signaling IP.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS carrier_trunks (
    id          SERIAL PRIMARY KEY,
    carrier     VARCHAR(50)  NOT NULL,               -- e.g. 'bandwidth', 'sinch'
    pop         VARCHAR(50)  NOT NULL,               -- e.g. 'dallas', 'denver'
    trunk_group VARCHAR(100),                        -- carrier's trunk-group id (NULL if unknown)
    source_ip   INET         NOT NULL,               -- carrier signaling IP ($si match key)
    test_tn     VARCHAR(20),                         -- carrier-provided test TN (NULL if none)
    direction   VARCHAR(20)  NOT NULL DEFAULT 'inbound'
                CHECK (direction IN ('inbound', 'outbound', 'both')),
    cps_limit   INT          NOT NULL DEFAULT 100,   -- per-trunk inbound CPS backstop
    enabled     BOOLEAN      NOT NULL DEFAULT true,
    notes       TEXT,
    created_at  TIMESTAMPTZ  DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  DEFAULT NOW(),
    -- Named constraints: the API maps each to a distinct 409 detail.
    CONSTRAINT carrier_trunks_source_ip_key   UNIQUE (source_ip),
    CONSTRAINT carrier_trunks_carrier_pop_key UNIQUE (carrier, pop)
);

-- Admin/list scans by state ("all enabled inbound trunks"). The hot-path SBC
-- lookup itself rides the UNIQUE(source_ip) index above.
CREATE INDEX IF NOT EXISTS idx_carrier_trunks_enabled_direction
    ON carrier_trunks (enabled, direction);

-- ---------------------------------------------------------------------------
-- Seed — the live carrier trunks. ON CONFLICT DO NOTHING keeps re-runs (and
-- later admin edits) authoritative: a seeded row is never overwritten.
-- Bandwidth trunk_group ids are unknown here -> NULL; Bandwidth has no test TN.
-- ---------------------------------------------------------------------------
INSERT INTO carrier_trunks
    (carrier, pop, trunk_group, source_ip, test_tn, direction, cps_limit, enabled)
VALUES
    ('bandwidth', 'dallas',  NULL,                '67.231.2.12',    NULL,         'both',    100, true),
    ('bandwidth', 'la',      NULL,                '216.82.238.134', NULL,         'both',    100, true),
    ('sinch',     'denver',  'DNVTCOZIGR2_3278',  '206.146.100.24', '5305480845', 'inbound', 100, true),
    ('sinch',     'chicago', 'CHCGIL24GR4_7412',  '206.146.101.39', '5305480846', 'inbound', 100, true)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- cdrs — inbound-carrier attribution columns (nullable, additive).
-- FreeSWITCH sets the inbound_carrier / inbound_carrier_pop channel vars on
-- calls admitted via a carrier trunk; the CDR ingest ($54/$55) stores them.
-- Absent vars (legacy calls, customer-trunk sources) stay NULL.
-- ---------------------------------------------------------------------------
ALTER TABLE cdrs ADD COLUMN IF NOT EXISTS inbound_carrier VARCHAR(20);
ALTER TABLE cdrs ADD COLUMN IF NOT EXISTS inbound_carrier_pop VARCHAR(50);

-- ---------------------------------------------------------------------------
-- carrier_trunk_health — refresh for the Sinch dispatcher groups.
-- Identical to the 25_carrier_trunk_status.sql view except the setid filter
-- grows (2, 3) -> (2, 3, 6, 7). Kept as a full copy because CREATE OR REPLACE
-- needs the whole definition; 25 is amended in place for fresh installs.
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
-- The live carriers: Bandwidth Dallas (setid 2) + LA (setid 3) and Sinch
-- Denver (setid 6) + Chicago (setid 7). The Bandwidth TC1/TC2 PoPs (setid 4/5)
-- are unused, so they stay excluded structurally — even if a lagging poller
-- ever reports one, it can never surface in the health view/map.
WHERE s.setid IN (2, 3, 6, 7)
GROUP BY s.duid;

-- ---------------------------------------------------------------------------
-- Grants.
-- ---------------------------------------------------------------------------
-- freeswitch : the DB role Kamailio's sqlops 'trunk' connection uses (its
--              entrypoint defaults DB_USER to freeswitch — the same role the
--              trunk_auth_ips customer-auth lookup is granted to in
--              02_schema_core.sql). SELECT-only: the SBC never writes.
-- api        : the FastAPI app — full CRUD (/v1/carrier-trunks) + sequence.
GRANT SELECT ON carrier_trunks TO freeswitch;
GRANT ALL    ON carrier_trunks TO api;
GRANT USAGE, SELECT ON carrier_trunks_id_seq TO api;

-- Re-assert the health-view readers (grants survive CREATE OR REPLACE; this
-- mirrors 25_carrier_trunk_status.sql and is harmless on re-run).
GRANT SELECT ON carrier_trunk_health TO api;
GRANT SELECT ON carrier_trunk_health TO grafana_ro;
