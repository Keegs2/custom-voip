-- ==========================================================================
-- 45_orig_trunk_passive_health.sql
-- HONEST health for ORIGINATION-ONLY carrier trunks: passive-OR-probe.
--
-- ** WHY ** — The Sinch ORIGINATION trunk groups (Denver DNVTCOZIGR2_3278 /
-- Chicago CHCGIL24GR4_7412, dispatcher duids sinch-denver / sinch-chicago,
-- setids 6/7) were provisioned Sinch->us only: unlike the Sinch TERMINATION
-- TGs (setids 8/9, whose registered IP lists include all 6 SBC public IPs),
-- the orig TGs do NOT answer SIP OPTIONS from IPs they don't have registered.
-- Our dispatcher probes are sent correctly (verified end-to-end: no socket=
-- attr / no ds_default_socket -> mhomed=1 picks the SBC_INTERNAL_IP:5060
-- socket for the public destination -> GCE 1:1 NAT -> wire source = each
-- SBC's OWN public IP — the same path on which Bandwidth and the Sinch TERM
-- TGs answer). Sinch simply never replies on the orig TGs, so dispatcher
-- marks them Inactive and the NOC showed a WORKING origination trunk as red
-- DOWN — misleading signal. For an orig-only trunk that answers no probes,
-- "down" is UNKNOWABLE from our side; the honest states are:
--   probe answered      -> 'up'      (hard evidence)
--   recent inbound CDRs -> 'up'      (passive evidence: calls are landing)
--   neither             -> 'passive' (unverifiable — NOT down, NOT red)
-- The eventual real fix is carrier-side: Sinch enabling OPTIONS response on
-- the orig TGs toward our 6 SBC IPs, which makes probe-up green again with
-- zero further change here.
--
-- UPDATE (same PR, after a coworker captured the exchange): the orig TGs are
-- NOT silent — they answer 500 + Contact <sip:ANONYMOUS@...> (Ribbon/Sonus
-- unknown-trunk signature), because they are registered with our NLB VIPs,
-- not the SBC public IPs. dispatcher.list groups 6/7 now carry per-dest
-- socket=/ping_from attrs sourcing those probes FROM the zone VIP. Even if
-- that turns the ACTIVE SBC's probes green, this view stays load-bearing:
-- VIP-addressed replies return through the NLB to the active SBC only, so
-- the STANDBY SBC's 6/7 probes can never be answered and read Inactive
-- forever (bool_or below absorbs that), and 'passive' remains the honest
-- state if Sinch's filter also rejects VIP-sourced OPTIONS.
--
-- ** WHAT ** — CREATE OR REPLACE of carrier_trunk_health (full copy of 44's
-- definition, same first-10 column names/types/order — PG requires it):
--   * status gains a fourth value 'passive' ("up"|"down"|"stale"|"passive"),
--     produced ONLY for the orig-only duids (sinch-denver, sinch-chicago).
--     Term/Bandwidth trunks (setids 2,3,8,9) keep STRICT probe semantics —
--     they answer OPTIONS, so probe-down there is real and stays 'down'.
--   * 'stale' precedence is UNCHANGED (freshest poller report older than 90s
--     wins for every duid — a dark monitoring pipeline must stay visible).
--   * is_up (the "usable" verdict) follows status='up' — for orig duids it
--     now includes traffic-proven up. Raw probe truth is preserved in the
--     new probe_up column.
--   * Appended columns (CREATE OR REPLACE VIEW may only ADD at the end):
--       probe_up             BOOL   — bool_or of per-SBC probe state (raw)
--       recent_inbound_calls BIGINT — inbound CDRs for this trunk's
--                                     carrier+pop in the last 60 min
--                                     (NULL for non-orig duids)
--       health_source        TEXT   — 'probe' | 'traffic' | NULL, which
--                                     evidence produced the up verdict
--   * Passive evidence = cdrs rows with direction='inbound' and the
--     spoof-proofed attribution Kamailio stamps on carrier ingress
--     (inbound_carrier / inbound_carrier_pop, migration 40), window 60 min.
--     The scan is bounded by hypertable chunk exclusion on start_time and
--     runs only for the 2 orig duids — same shape/cost as the NOC tiles'
--     existing per-PoP 1h count queries.
--
-- STATE TABLE (per duid):
--   duid class          | fresh? | probe_up | CDRs<60m | status    | is_up
--   --------------------+--------+----------+----------+-----------+------
--   any                 | no     | n/a      | n/a      | 'stale'   | last probe truth
--   strict (2,3,8,9)    | yes    | true     | n/a      | 'up'      | true
--   strict (2,3,8,9)    | yes    | false    | n/a      | 'down'    | false
--   orig  (6,7)         | yes    | true     | any      | 'up'      | true
--   orig  (6,7)         | yes    | false    | >0       | 'up'      | true
--   orig  (6,7)         | yes    | false    | 0        | 'passive' | false
--
-- Consumers: Grafana noc-home.json (Sinch tiles + geomap layer C render
-- 'passive' as amber "unverified", never red) and GET /v1/carrier-status
-- (explicit column list — appended columns are invisible to it; the new
-- status string flows through as an opaque value).
--
-- IDEMPOTENT: safe to run repeatedly (CREATE OR REPLACE + unconditional
-- grant re-asserts). Requires 25 (carrier_trunk_status), 40
-- (cdrs.inbound_carrier/_pop), 44 (setids 8/9 in the previous definition).
--
-- PRODUCTION NOTE: init scripts here only run on the first initdb. Apply
-- MANUALLY on the bare-metal prod primary (services VM, 10.142.0.103), where
-- it replicates to every zone replica:
--     sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/init/45_orig_trunk_passive_health.sql
-- Run as SUPERUSER (postgres).
-- ==========================================================================

CREATE OR REPLACE VIEW carrier_trunk_health AS
WITH probe AS (
    -- Identical aggregation to 44: one row per carrier duid across all
    -- reporting SBCs; name/ip/setid collapse via MAX (identical per duid).
    SELECT
        s.duid,
        MAX(s.name)  AS name,
        MAX(s.ip)    AS ip,
        MAX(s.setid) AS setid,
        COUNT(*) FILTER (WHERE s.is_up) AS up_sbcs,
        COUNT(*)                        AS total_sbcs,
        bool_or(s.is_up)                AS probe_up,
        MAX(s.updated_at)               AS last_updated
    FROM carrier_trunk_status s
    -- Live carriers: Bandwidth Dallas/LA (2/3), Sinch orig Denver/Chicago
    -- (6/7), Sinch term Atlanta LD / Denver TF (8/9). TC1/TC2 (4/5) stay
    -- structurally excluded.
    WHERE s.setid IN (2, 3, 6, 7, 8, 9)
    GROUP BY s.duid
),
-- Passive (traffic) evidence — ORIGINATION-ONLY duids. The VALUES map is the
-- duid -> CDR-attribution join key (Kamailio stamps inbound_carrier/_pop on
-- carrier ingress; FS records them into cdrs). Add a row here if another
-- probe-deaf origination-only trunk ever enrolls.
orig_traffic AS (
    SELECT m.duid, COUNT(*) AS recent_inbound_calls
    FROM (VALUES
            ('sinch-denver',  'sinch', 'denver'),
            ('sinch-chicago', 'sinch', 'chicago')
         ) AS m(duid, carrier, pop)
    JOIN cdrs c
      ON c.direction          = 'inbound'
     AND c.start_time         > now() - interval '60 minutes'
     AND c.inbound_carrier     = m.carrier
     AND c.inbound_carrier_pop = m.pop
    GROUP BY m.duid
)
SELECT
    p.duid,
    p.name,
    p.ip,
    p.setid,
    p.up_sbcs,
    p.total_sbcs,
    -- Usability verdict. Strict duids: probe truth (unchanged). Orig duids:
    -- probe OR traffic — a trunk landing calls is usable by definition.
    (p.probe_up
     OR (p.duid IN ('sinch-denver', 'sinch-chicago')
         AND COALESCE(t.recent_inbound_calls, 0) > 0)) AS is_up,
    p.last_updated,
    (p.last_updated < now() - interval '90 seconds') AS stale,
    CASE
        -- Stale wins for every duid: no fresh poller report in 90s means the
        -- monitoring pipeline itself is dark — never trust (or hide) that.
        WHEN p.last_updated < now() - interval '90 seconds' THEN 'stale'
        WHEN p.probe_up                                     THEN 'up'
        -- Orig-only duids below: probe-down is not evidence of failure
        -- (Sinch orig TGs don't answer OPTIONS from unregistered IPs).
        WHEN p.duid IN ('sinch-denver', 'sinch-chicago')
             AND COALESCE(t.recent_inbound_calls, 0) > 0    THEN 'up'
        WHEN p.duid IN ('sinch-denver', 'sinch-chicago')    THEN 'passive'
        ELSE 'down'
    END AS status,
    -- Appended columns (new consumers only; see header).
    p.probe_up,
    CASE
        WHEN p.duid IN ('sinch-denver', 'sinch-chicago')
        THEN COALESCE(t.recent_inbound_calls, 0)
    END AS recent_inbound_calls,
    CASE
        WHEN p.probe_up THEN 'probe'
        WHEN p.duid IN ('sinch-denver', 'sinch-chicago')
             AND COALESCE(t.recent_inbound_calls, 0) > 0 THEN 'traffic'
    END AS health_source
FROM probe p
LEFT JOIN orig_traffic t ON t.duid = p.duid;

-- ---------------------------------------------------------------------------
-- Grants — re-asserts (grants survive CREATE OR REPLACE; harmless on re-run).
-- The view executes with its owner's privileges (postgres), so readers need
-- no direct cdrs grant through it — grafana_ro/api already hold cdrs SELECT
-- anyway (24_grafana_ro.sql / API role).
-- ---------------------------------------------------------------------------
GRANT SELECT ON carrier_trunk_health TO api;
GRANT SELECT ON carrier_trunk_health TO grafana_ro;
