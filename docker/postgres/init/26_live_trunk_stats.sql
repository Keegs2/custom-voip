-- 26_live_trunk_stats.sql — LIVE customer-SIP-trunk stats (Prometheus escape hatch).
--
-- The metrics plane's ONE hard rule is a cardinality contract: customer
-- identifiers NEVER become Prometheus labels. Carrier trunks are a closed enum
-- (safe as labels), but CUSTOMER SIP trunks are hundreds -> thousands, so their
-- per-trunk live detail lives HERE in Postgres instead of exploding VictoriaMetrics
-- active-series. A per-SBC feeder (the carrier-monitor sidecar, which already POSTs
-- carrier-status) derives per-customer-trunk active_channels / cps / registration
-- from kamcmd and POSTs it to the central FastAPI (POST /v1/live-trunk-stats/report).
-- The API UPSERTs one row per (customer_id, trunk_id, reporting SBC) here on the
-- EAST PRIMARY. Grafana/CRAG read the aggregated `live_trunk_health` view as
-- grafana_ro to drill into a customer's live trunk load.
--
-- WHY per-(customer_id, trunk_id, sbc_id): a customer trunk can be active on more
-- than one SBC at once (NLB spreads registrations/calls). Storing one row per
-- reporting SBC lets the view SUM channels/CPS across SBCs, OR registration across
-- SBCs, and flag "no SBC reported lately" (stale — the feeder/SBC itself is dark).
--
-- IDEMPOTENT: safe to run repeatedly. Table create is IF NOT EXISTS, indexes are
-- IF NOT EXISTS, the view is CREATE OR REPLACE, and grants are unconditional
-- (harmless to re-assert).
--
-- PRODUCTION NOTE: Postgres init scripts in this directory ONLY run on the first
-- initdb of a fresh data directory. The production primary already exists, so this
-- migration must be APPLIED MANUALLY on the bare-metal prod primary (services VM,
-- 10.142.0.103), where it replicates to every zone replica:
--     sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/init/26_live_trunk_stats.sql
-- Run it as a SUPERUSER (postgres). Writes (the feeder reports) go to the EAST
-- PRIMARY via the API — zone replicas are read-only, so the table only ever takes
-- writes on the primary and streams read-only to the replicas.

-- ---------------------------------------------------------------------------
-- Table — one row per (customer SIP trunk, reporting SBC).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS live_trunk_stats (
    customer_id     INT           NOT NULL,                  -- owning customer
    trunk_id        INT           NOT NULL,                  -- sip_trunks.id
    sbc_id          TEXT          NOT NULL,                  -- reporting SBC, e.g. east-sbc-1
    trunk_name      TEXT,                                    -- human label for the trunk
    active_channels INT           NOT NULL DEFAULT 0,        -- live concurrent channels on this SBC
    cps_1m          NUMERIC(8,2)  NOT NULL DEFAULT 0,        -- calls/sec (1m window) on this SBC
    asr_5m          NUMERIC(5,2),                            -- answer-seizure ratio % (5m); NULL = unknown
    registered      BOOLEAN,                                 -- registration state per this SBC; NULL = unknown
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),    -- every report touches this
    PRIMARY KEY (customer_id, trunk_id, sbc_id)
);

-- Index the freshness column so the health view's max(updated_at)/stale check and
-- any "recently reported" scans stay cheap as trunk*SBC count grows.
CREATE INDEX IF NOT EXISTS idx_live_trunk_stats_updated_at
    ON live_trunk_stats (updated_at);

-- Index the (customer, trunk) key so a per-customer / per-trunk drill-down that
-- fans across SBCs is a cheap index range instead of a full scan.
CREATE INDEX IF NOT EXISTS idx_live_trunk_stats_customer_trunk
    ON live_trunk_stats (customer_id, trunk_id);

-- ---------------------------------------------------------------------------
-- Aggregated health view — one row per (customer_id, trunk_id) across ALL SBCs.
-- ---------------------------------------------------------------------------
-- A customer trunk can carry calls on more than one SBC at once, so channels and
-- CPS SUM across the reporting SBCs; asr_5m takes MAX (best observed answer rate);
-- registration is OR'd (registered on >=1 SBC => usable). `stale` flags trunks
-- whose freshest report is older than 90s — the feeder reports on a short cadence,
-- so no report in 90s means the feeder/SBC is dark and the last-known values can no
-- longer be trusted.
CREATE OR REPLACE VIEW live_trunk_health AS
SELECT
    s.customer_id,
    s.trunk_id,
    -- trunk_name is per-trunk; MAX() collapses the identical per-SBC copies into
    -- one representative value (they agree across SBCs for a given trunk).
    MAX(s.trunk_name)                 AS trunk_name,
    SUM(s.active_channels)            AS active_channels,   -- total live channels across SBCs
    SUM(s.cps_1m)                     AS cps_1m,            -- total CPS across SBCs
    MAX(s.asr_5m)                     AS asr_5m,            -- best observed answer rate
    bool_or(s.registered)             AS registered_any,    -- registered on >=1 SBC => usable
    MAX(s.updated_at)                 AS last_updated,
    (MAX(s.updated_at) < now() - interval '90 seconds') AS stale
FROM live_trunk_stats s
GROUP BY s.customer_id, s.trunk_id;

-- ---------------------------------------------------------------------------
-- Grants.
-- ---------------------------------------------------------------------------
-- api  : the FastAPI app. Reads the health view (GET /v1/live-trunk-stats) and
--        writes the raw table (POST /v1/live-trunk-stats/report).
-- grafana_ro : read-only NOC/CRAG dashboards. SELECT on the view + underlying
--        table. 24_grafana_ro.sql loops a fixed table array + ALTER DEFAULT
--        PRIVILEGES (which covers only tables created by THAT role). This
--        table/view may be created by a different owner and is not in that array,
--        so grant explicitly here rather than editing 24 — a small, self-contained
--        addition (mirrors 25_carrier_trunk_status.sql).
GRANT SELECT, INSERT, UPDATE ON live_trunk_stats  TO api;
GRANT SELECT                 ON live_trunk_health TO api;
GRANT SELECT                 ON live_trunk_stats  TO grafana_ro;
GRANT SELECT                 ON live_trunk_health TO grafana_ro;
