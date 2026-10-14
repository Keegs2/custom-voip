-- ==========================================================================
-- 52_sinch_tf_origination.sql
-- Sinch TOLL-FREE ORIGINATION trunks (8XX-T "To Customer", 50 sessions each,
-- round-robin to all 3 zone NLB VIPs) + their passive health.
--
--   * Seed rows — the two Sinch INBOUND toll-free trunk groups (DIFFERENT IPs
--     from the 40 origination PoPs and the 44 termination trunks):
--       sinch/atlanta-tf-orig  TG ATLNGAQSGR2_7284  206.146.98.25   'tollfree'
--                              (Sinch order 229644121, SBX ATLSBX21,
--                               media 206.146.98.16/28)
--       sinch/denver-tf-orig   TG DNVTCOZIGR2_3327  206.146.100.25  'tollfree'
--                              (Sinch order 229644753, SBX DENSBX21,
--                               media 206.146.100.16/28)
--     direction='inbound' (never a termination candidate — the FS selection
--     contract filters direction IN ('outbound','both')), traffic_class=
--     'tollfree', cps_limit 10. ON CONFLICT DO NOTHING: the owner inserts
--     these rows by hand on the primary first; this file only reproduces
--     them on fresh installs and never overwrites a hand-edited row.
--
--     TRUST NOTE: both IPs are ALSO static-trusted on the SBC (kamailio.cfg
--     SINCH_TF_ATL_IP / SINCH_TF_DEN_IP, flag 5) — a DB-only carrier row runs
--     the untrusted pike/SCANNER_DETECT gauntlet and a 50-session trunk would
--     be auto-blocked within minutes. Static trust wins (the static carrier
--     branch never reaches route[CARRIER_TRUST]), so on the SBC these rows'
--     cps_limit is NOT the enforced limit (static sources use BW_CPS_LIMIT);
--     the rows are the TED/NOC/CDR-attribution record. Kamailio's
--     TF_INGRESS_ENFORCE (default on) admits ONLY 8YY R-URIs from these two
--     trunks and rejects 8YY R-URIs from every other carrier (404).
--     Toll-free RCF DIDs are identified purely by NPA (800/833/844/855/866/
--     877/888) — no new column.
--
--   * carrier_trunk_health — CREATE OR REPLACE of 45's definition (the latest;
--     46-51 do not touch the view). Two changes:
--       1. The orig-only passive map grows the two TF orig pops.
--       2. PROBE-LESS orig rows: the TF orig trunks have NO dispatcher
--          keepalive group (origination-only; no OPTIONS toward them), so no
--          carrier_trunk_status rows exist for them and 45's FROM-probe shape
--          could never emit them. Map entries that carry a name/ip and have
--          no probe rows are synthesized: setid NULL, up_sbcs/total_sbcs 0,
--          probe_up NULL, last_updated NULL, stale false, and status/is_up
--          purely from passive traffic ('up' with inbound CDRs in 60 min,
--          else 'passive' — never 'down', never 'stale'). If a dispatcher
--          group is ever added for them, the probe rows take over
--          automatically (the synthesized row is suppressed by NOT EXISTS).
--     Every pre-existing duid renders IDENTICALLY to 45 (same first-13
--     column names/types/order — PG requires it; the probe_up/stale COALESCEs
--     are no-ops for probe rows, whose values are never NULL).
--
-- MANUAL OPS STEP (deliberately NOT in this migration — seeded rows are never
-- overwritten by migrations): the owner relabels every remaining
-- traffic_class='any' row to 'ld' on the primary (Bandwidth dallas/la
-- 'both', Sinch denver/chicago 'inbound'), so prod has NO 'any' rows:
--     UPDATE carrier_trunks SET traffic_class = 'ld', updated_at = now() WHERE traffic_class = 'any';
-- Effect: FS 8YY termination is STRICT — only 'tollfree' rows are eligible
-- (no 'tollfree' trunk enabled = the call FAILS CLOSED, NO_ROUTE_DESTINATION);
-- 'ld' destinations keep 'any'+'ld'. On the SBC, route[CARRIER_TRUST] treats
-- every non-'tollfree' row as the non-TF class, so 'any' vs 'ld' is
-- indistinguishable there. Fresh installs keep 40's 'any' seeds (same
-- runtime behavior for LD; 'any' is never eligible for 8YY).
--
-- IDEMPOTENT: safe to run repeatedly (ON CONFLICT DO NOTHING + CREATE OR
-- REPLACE + grant re-asserts). Requires 25, 40, 44 (traffic_class), 45.
--
-- PRODUCTION NOTE: init scripts here only run on the first initdb. Apply
-- MANUALLY on the bare-metal prod primary (services VM, 10.142.0.103), where
-- it replicates to every zone replica:
--     sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/init/52_sinch_tf_origination.sql
-- Run as SUPERUSER (postgres). Safe to apply before OR after the owner's
-- manual INSERT and before or after the SBC rollout.
-- ==========================================================================

-- ---------------------------------------------------------------------------
-- Seed — exactly the rows the owner inserts on the primary.
-- ---------------------------------------------------------------------------
INSERT INTO carrier_trunks
    (carrier, pop, trunk_group, source_ip, test_tn, direction, traffic_class,
     cps_limit, enabled, notes)
VALUES
    ('sinch', 'atlanta-tf-orig', 'ATLNGAQSGR2_7284', '206.146.98.25', NULL,
     'inbound', 'tollfree', 10, true,
     'Sinch 8XX-T toll-free ORIGINATION (To Customer) — TG ATLNGAQSGR2_7284, Sinch order 229644121, SBX ATLSBX21, 50 sessions, media 206.146.98.16/28. Static-trusted on the SBC (SINCH_TF_ATL_IP); 8YY R-URIs only.'),
    ('sinch', 'denver-tf-orig', 'DNVTCOZIGR2_3327', '206.146.100.25', NULL,
     'inbound', 'tollfree', 10, true,
     'Sinch 8XX-T toll-free ORIGINATION (To Customer) — TG DNVTCOZIGR2_3327, Sinch order 229644753, SBX DENSBX21, 50 sessions, media 206.146.100.16/28. Static-trusted on the SBC (SINCH_TF_DEN_IP); 8YY R-URIs only.')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- carrier_trunk_health — 45's passive-OR-probe view + probe-less orig rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW carrier_trunk_health AS
WITH probe AS (
    -- Identical aggregation to 44/45: one row per carrier duid across all
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
-- ORIGINATION-ONLY duids. duid -> CDR-attribution join key (Kamailio stamps
-- inbound_carrier/_pop on carrier ingress; FS records them into cdrs). name/
-- ip are set ONLY for probe-less trunks (no dispatcher group) — they seed the
-- synthesized row below; NULL = the trunk has probe rows (45's two PoPs).
-- Add a row here if another origination-only trunk ever enrolls.
orig_map AS (
    SELECT * FROM (VALUES
            ('sinch-denver',          'sinch', 'denver',          NULL::text,              NULL::text),
            ('sinch-chicago',         'sinch', 'chicago',         NULL::text,              NULL::text),
            ('sinch-atlanta-tf-orig', 'sinch', 'atlanta-tf-orig', 'Sinch Atlanta TF Orig', '206.146.98.25'),
            ('sinch-denver-tf-orig',  'sinch', 'denver-tf-orig',  'Sinch Denver TF Orig',  '206.146.100.25')
         ) AS m(duid, carrier, pop, name, ip)
),
orig_traffic AS (
    SELECT m.duid, COUNT(*) AS recent_inbound_calls
    FROM orig_map m
    JOIN cdrs c
      ON c.direction          = 'inbound'
     AND c.start_time         > now() - interval '60 minutes'
     AND c.inbound_carrier     = m.carrier
     AND c.inbound_carrier_pop = m.pop
    GROUP BY m.duid
),
-- Probe rows + synthesized rows for probe-less orig trunks (see header).
src AS (
    SELECT p.duid, p.name, p.ip, p.setid, p.up_sbcs, p.total_sbcs,
           p.probe_up, p.last_updated
    FROM probe p
    UNION ALL
    SELECT m.duid, m.name, m.ip, NULL::int, 0::bigint, 0::bigint,
           NULL::boolean, NULL::timestamptz
    FROM orig_map m
    WHERE m.name IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM probe p WHERE p.duid = m.duid)
)
SELECT
    s.duid,
    s.name,
    s.ip,
    s.setid,
    s.up_sbcs,
    s.total_sbcs,
    -- Usability verdict. Strict duids: probe truth (unchanged). Orig duids:
    -- probe OR traffic — a trunk landing calls is usable by definition.
    (COALESCE(s.probe_up, false)
     OR (o.duid IS NOT NULL
         AND COALESCE(t.recent_inbound_calls, 0) > 0)) AS is_up,
    s.last_updated,
    COALESCE(s.last_updated < now() - interval '90 seconds', false) AS stale,
    CASE
        -- Stale wins for every PROBED duid (no fresh poller report in 90s =
        -- the monitoring pipeline is dark). Probe-less rows (last_updated
        -- NULL) have no pipeline to go stale.
        WHEN s.last_updated < now() - interval '90 seconds' THEN 'stale'
        WHEN s.probe_up                                     THEN 'up'
        -- Orig-only duids below: probe-down / no probe is not evidence of
        -- failure (Sinch orig TGs don't answer OPTIONS from unregistered IPs;
        -- the TF orig TGs are not probed at all).
        WHEN o.duid IS NOT NULL
             AND COALESCE(t.recent_inbound_calls, 0) > 0    THEN 'up'
        WHEN o.duid IS NOT NULL                             THEN 'passive'
        ELSE 'down'
    END AS status,
    -- Appended columns (45; new consumers only).
    s.probe_up,
    CASE
        WHEN o.duid IS NOT NULL
        THEN COALESCE(t.recent_inbound_calls, 0)
    END AS recent_inbound_calls,
    CASE
        WHEN s.probe_up THEN 'probe'
        WHEN o.duid IS NOT NULL
             AND COALESCE(t.recent_inbound_calls, 0) > 0 THEN 'traffic'
    END AS health_source
FROM src s
LEFT JOIN orig_map     o ON o.duid = s.duid
LEFT JOIN orig_traffic t ON t.duid = s.duid;

-- ---------------------------------------------------------------------------
-- Grants — re-asserts (grants survive CREATE OR REPLACE; harmless on re-run).
-- ---------------------------------------------------------------------------
GRANT SELECT ON carrier_trunk_health TO api;
GRANT SELECT ON carrier_trunk_health TO grafana_ro;
