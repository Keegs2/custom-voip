-- 25_carrier_trunk_status.sql — LIVE carrier-trunk connectivity monitor.
--
-- Backs the NOC "carrier trunks" map layer. A per-SBC poller (one per Kamailio
-- SBC) reads that SBC's dispatcher OPTIONS state (kamcmd dispatcher.list) and
-- POSTs it to the central FastAPI (POST /v1/carrier-status/report). The API
-- UPSERTs one row per (carrier duid, reporting SBC) here on the EAST PRIMARY.
-- Grafana's NOC home board reads the aggregated `carrier_trunk_health` view as
-- grafana_ro to color the carrier markers by REAL reachability (not CDR-derived).
--
-- WHY per-(duid, sbc_id): a carrier is reachable from ANY SBC that can OPTIONS-
-- ping it. Storing one row per reporting SBC lets the view answer "up on >=1 SBC"
-- (usable) vs "down on every SBC" (truly unreachable) vs "no SBC reported lately"
-- (stale — poller/SBC itself is dark).
--
-- IDEMPOTENT: safe to run repeatedly. Table create is IF NOT EXISTS, the view is
-- CREATE OR REPLACE, and grants are unconditional (harmless to re-assert). Column
-- adds are guarded so re-runs never error.
--
-- PRODUCTION NOTE: Postgres init scripts in this directory ONLY run on the first
-- initdb of a fresh data directory. The production primary already exists, so this
-- migration must be APPLIED MANUALLY on the bare-metal prod primary (services VM,
-- 10.142.0.103), where it replicates to every zone replica:
--     sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/init/25_carrier_trunk_status.sql
-- Run it as a SUPERUSER (postgres). Writes (the poller reports) go to the EAST
-- PRIMARY via the API — zone replicas are read-only, so the table only ever takes
-- writes on the primary and streams read-only to the replicas.

-- ---------------------------------------------------------------------------
-- Table — one row per (carrier destination, reporting SBC).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS carrier_trunk_status (
    duid        TEXT        NOT NULL,                 -- dispatcher duid, e.g. bw-dallas-primary
    sbc_id      TEXT        NOT NULL,                 -- reporting SBC, e.g. east-sbc-1
    name        TEXT,                                 -- human label, e.g. Bandwidth Dallas
    ip          TEXT,                                 -- carrier signaling IP
    setid       INT,                                  -- dispatcher group id (2..5)
    is_up       BOOLEAN     NOT NULL DEFAULT false,   -- reachable per this SBC's last probe
    flags       TEXT,                                 -- raw dispatcher flags, e.g. AP
    last_change TIMESTAMPTZ NOT NULL DEFAULT now(),   -- when is_up last FLIPPED for this pair
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),   -- every report touches this
    PRIMARY KEY (duid, sbc_id)
);

-- Index the freshness column so the health view's max(updated_at)/stale check and
-- any "recently reported" scans stay cheap as SBC count grows.
CREATE INDEX IF NOT EXISTS idx_carrier_trunk_status_updated_at
    ON carrier_trunk_status (updated_at);

-- ---------------------------------------------------------------------------
-- Aggregated health view — one row per carrier duid across ALL reporting SBCs.
-- ---------------------------------------------------------------------------
-- is_up here is the USABILITY verdict: TRUE if the carrier is up on at least one
-- SBC (a carrier reachable from any SBC can carry calls). `stale` flags carriers
-- whose freshest report is older than 90s — the pollers report on a short cadence,
-- so no report in 90s means the SBC/poller is dark, and the last known is_up can no
-- longer be trusted. `status` collapses both into one field for the map:
--   'stale' when no fresh probe (takes precedence — we don't trust stale up/down),
--   'up'    when up on >=1 SBC and fresh,
--   'down'  when down on every SBC and fresh.
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
GROUP BY s.duid;

-- ---------------------------------------------------------------------------
-- Grants.
-- ---------------------------------------------------------------------------
-- api  : the FastAPI app. Reads the health view (GET /v1/carrier-status) and
--        writes the raw table (POST /v1/carrier-status/report).
-- grafana_ro : read-only NOC dashboards. SELECT on the view + underlying table.
--        24_grafana_ro.sql loops a fixed table array + ALTER DEFAULT PRIVILEGES
--        (which covers only tables created by THAT role). This table/view may be
--        created by a different owner and is not in that array, so grant explicitly
--        here rather than editing 24 — a small, self-contained addition.
GRANT SELECT, INSERT, UPDATE ON carrier_trunk_status TO api;
GRANT SELECT                 ON carrier_trunk_health TO api;
GRANT SELECT                 ON carrier_trunk_status TO grafana_ro;
GRANT SELECT                 ON carrier_trunk_health TO grafana_ro;
