-- ==========================================================================
-- 53_sinch_redundant_termination.sql
-- Sinch REDUNDANT termination trunks (a second INT/LD and a second OSAO/8YY
-- trunk group) + the carrier_trunks uniqueness change they require.
--
-- ** WHY THE SCHEMA CHANGES ** — Sinch is building the redundant termination
-- trunk groups on the SAME signaling IPs as the 52 toll-free ORIGINATION
-- trunks (8XX-T To Customer):
--     206.146.100.25  DENSBX21  inbound  sinch/denver-tf-orig   (52)
--                               outbound sinch/denver-ld        (NEW, INT/LD)
--     206.146.98.25   ATLSBX21  inbound  sinch/atlanta-tf-orig  (52)
--                               outbound sinch/atlanta-tf       (NEW, OSAO 8YY)
-- Sinch tells the trunk groups apart by OUR source IP (termination trunks are
-- registered to the 6 SBC public IPs, the 8XX-T orig trunks to the 3 zone
-- VIPs), so one Sinch IP legitimately carries one ingress row AND one egress
-- row. 40's UNIQUE(source_ip) forbids that. It is replaced by TWO partial
-- unique indexes:
--     carrier_trunks_ingress_ip_key  UNIQUE (source_ip)
--                                    WHERE direction IN ('inbound','both')
--     carrier_trunks_egress_ip_key   UNIQUE (source_ip)
--                                    WHERE direction IN ('outbound','both')
-- i.e. at most one ingress row and one egress row per IP; a 'both' row
-- occupies BOTH slots (so it conflicts with any other row on that IP).
-- UNIQUE (carrier, pop) (carrier_trunks_carrier_pop_key) is unchanged.
--
-- ** READER CONTRACT ** — every lookup of a row BY IP must filter direction,
-- or it can now see two rows:
--   * Kamailio route[CARRIER_TRUST] (ingress trust):
--       ... WHERE source_ip = '$si'::inet AND direction IN ('inbound','both')
--           AND enabled = true LIMIT 1
--     — predicate identical to the ingress index, so it stays a single
--     indexed point read (0 or 1 row).
--   * Kamailio X-Carrier-IP validation (egress): filters
--     direction IN ('outbound','both') AND enabled = true.
--   * FreeSWITCH termination SELECT (44's contract, unchanged):
--       SELECT carrier, pop, host(source_ip) AS term_ip, traffic_class,
--              COALESCE(priority_<z>, priority) AS eff_priority
--       FROM carrier_trunks
--       WHERE direction IN ('outbound','both') AND enabled = true
--       ORDER BY eff_priority, id
-- The constraint swap is safe for every existing prod row: all current IPs
-- are distinct, so both partial indexes build without conflict.
--
-- ** SEED ROWS ** (both enabled=false — Sinch has not confirmed the build or
-- assigned trunk-group ids yet; trunk_group NULL until they do):
--   sinch/denver-ld   206.146.100.25  outbound  'ld'        priority 35
--                     Redundant Sinch "INT" LD on DENSBX21, 50 sessions,
--                     media 206.146.100.16/28. Dispatcher group 11
--                     (duid sinch-denver-ld, SBC env SINCH_LD2_IP).
--   sinch/atlanta-tf  206.146.98.25   outbound  'tollfree'  priority 45
--                     Redundant Sinch "OSAO" 8YY on ATLSBX21, 50 sessions,
--                     media 206.146.98.16/28. Dispatcher group 12
--                     (duid sinch-atlanta-tf, SBC env SINCH_TF2_IP).
-- All four priority columns are explicit (35 / 45 in every zone): LD order
-- becomes Bandwidth (10/20) -> sinch/atlanta-ld (30) -> sinch/denver-ld (35);
-- 8YY order becomes sinch/denver-tf (40) -> sinch/atlanta-tf (45). Nothing
-- shifts while the rows are disabled (the FS SELECT filters enabled = true).
-- cps_limit 25 mirrors 44 (inbound backstop only; inert on outbound rows).
--
-- ENABLE (owner, on the primary, once Sinch confirms the build + TG ids):
--     UPDATE carrier_trunks SET enabled = true, trunk_group = '<TG>', updated_at = now() WHERE carrier = 'sinch' AND pop = 'denver-ld';
--     UPDATE carrier_trunks SET enabled = true, trunk_group = '<TG>', updated_at = now() WHERE carrier = 'sinch' AND pop = 'atlanta-tf';
--     UPDATE carrier_gateways SET enabled = true, updated_at = now() WHERE gateway_name IN ('sinch_denver_ld', 'sinch_atlanta_tf');
-- FS picks the rows up on its next trunk-cache refresh (60 s); Kamailio's
-- X-Carrier-IP validation passes them on the next call. No redeploy.
--
-- ** carrier_gateways ** — display/config metadata only (see 46: nothing in
-- the call path reads it). Two rows mirroring 46's termination cards, seeded
-- enabled=false to match the trunk rows; flip them with the trunks.
--
-- ** carrier_trunk_health ** — CREATE OR REPLACE of 52's definition (the
-- latest) with two changes:
--   1. The probe setid filter grows (2,3,6,7,8,9) -> (2,3,6,7,8,9,11,12) for
--      the new dispatcher keepalive groups. (10 is the SBC peer-liveness
--      group — not a carrier, stays excluded, as do the unused 4/5.)
--   2. APPENDED column trunk_enabled BOOLEAN — carrier_trunks.enabled of the
--      row behind each duid (duid -> carrier/pop map in the view; NULL when
--      the duid has no mapped row). WHY: groups 11/12 probe trunks that are
--      seeded DISABLED. Until Sinch builds them, the probes are not expected
--      to be answered and the row reads status 'down' under the strict probe
--      semantics every termination duid has. A new 'disabled' status was
--      deliberately NOT added: every existing consumer (Grafana noc-home /
--      traffic-status tiles and geomap layers, GET /v1/carrier-status) maps
--      any status it does not know to the red/down bucket (CASE ... ELSE 0),
--      so a new status string would render exactly as alarming as 'down'.
--      Consumers that want to grey out a disabled trunk test
--      trunk_enabled = false BEFORE status. Existing columns, their order,
--      types and every pre-existing duid's values are IDENTICAL to 52.
--
-- IDEMPOTENT: safe to run repeatedly. CREATE UNIQUE INDEX IF NOT EXISTS; the
-- old constraint is dropped by a catalog-driven DO block that only fires
-- while a UNIQUE constraint on exactly (source_ip) still exists (whatever its
-- name — 40 names it carrier_trunks_source_ip_key); seed INSERTs are
-- ON CONFLICT DO NOTHING (no conflict target: any unique violation — the
-- (carrier, pop) key, either partial IP index, or carrier_gateways'
-- gateway_name — leaves an existing / hand-inserted / later-edited row
-- untouched); the view is CREATE OR REPLACE; grants are re-asserts.
-- The new indexes are built BEFORE the old constraint is dropped, so the
-- table is never without IP uniqueness, even if the file stops midway.
--
-- PRODUCTION NOTE: init scripts here only run on the first initdb. Apply
-- MANUALLY on the bare-metal prod primary (services VM, 10.142.0.103), where
-- it replicates to every zone replica:
--     sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/53_sinch_redundant_termination.sql
-- Run as SUPERUSER (postgres). Requires 08 (carrier_gateways), 25, 40, 42
-- (priority columns), 44 (traffic_class), 45/52 (the view being replaced).
-- Apply BEFORE the SBC rollout that adds dispatcher groups 11/12 (harmless
-- either way: probe rows for an unknown setid are simply filtered out of the
-- view until this runs).
-- RE-APPLYING AN OLDER FILE after this one: 40/44/45/52 each CREATE OR
-- REPLACE carrier_trunk_health with FEWER columns, so their view statement
-- now fails with "cannot drop columns from view" (verified) and 53's view
-- stays in place. Under plain `psql -f` the rest of that file still applies;
-- with ON_ERROR_STOP it aborts at the view. Either way, re-run this file
-- afterwards. 40's CREATE TABLE IF NOT EXISTS is a no-op on the existing
-- table, so it never re-creates UNIQUE(source_ip) — the partial indexes
-- survive any re-run.
-- ==========================================================================

-- ---------------------------------------------------------------------------
-- 1) Uniqueness: two partial unique indexes FIRST, then drop UNIQUE(source_ip).
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS carrier_trunks_ingress_ip_key
    ON carrier_trunks (source_ip)
    WHERE direction IN ('inbound', 'both');

CREATE UNIQUE INDEX IF NOT EXISTS carrier_trunks_egress_ip_key
    ON carrier_trunks (source_ip)
    WHERE direction IN ('outbound', 'both');

DO $$
DECLARE
    r record;
BEGIN
    -- Every UNIQUE constraint whose key is exactly (source_ip) — 40 created
    -- it as carrier_trunks_source_ip_key; matched by shape, not name, so a
    -- hand-renamed constraint is handled too. No-op once dropped.
    FOR r IN
        SELECT c.conname
          FROM pg_constraint c
          JOIN pg_attribute a
            ON a.attrelid = c.conrelid AND a.attname = 'source_ip'
         WHERE c.conrelid = 'carrier_trunks'::regclass
           AND c.contype = 'u'
           AND c.conkey = ARRAY[a.attnum]::smallint[]
    LOOP
        EXECUTE format('ALTER TABLE carrier_trunks DROP CONSTRAINT %I', r.conname);
        RAISE NOTICE '53: dropped UNIQUE(source_ip) constraint %', r.conname;
    END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 2) Seed — the two redundant Sinch termination trunk groups (disabled).
-- ---------------------------------------------------------------------------
INSERT INTO carrier_trunks
    (carrier, pop, trunk_group, source_ip, test_tn, direction, traffic_class,
     cps_limit, enabled, priority, priority_east, priority_west,
     priority_central, notes)
VALUES
    ('sinch', 'denver-ld', NULL, '206.146.100.25', NULL,
     'outbound', 'ld', 25, false, 35, 35, 35, 35,
     'Sinch REDUNDANT INT LD termination on DENSBX21 — trunk group TBD (Sinch to assign), 50 sessions, media 206.146.100.16/28. Shares 206.146.100.25 with the inbound sinch/denver-tf-orig row (Sinch keys the trunk group on OUR source IP). Seeded DISABLED: enable + set trunk_group once Sinch confirms the build. Backup to sinch/atlanta-ld (30). Dispatcher group 11.'),
    ('sinch', 'atlanta-tf', NULL, '206.146.98.25', NULL,
     'outbound', 'tollfree', 25, false, 45, 45, 45, 45,
     'Sinch REDUNDANT OSAO 8YY termination on ATLSBX21 — trunk group TBD (Sinch to assign), 50 sessions, media 206.146.98.16/28. Toll-free (8YY) destinations ONLY. Shares 206.146.98.25 with the inbound sinch/atlanta-tf-orig row. Seeded DISABLED: enable + set trunk_group once Sinch confirms the build. Backup to sinch/denver-tf (40). Dispatcher group 12.')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3) carrier_gateways — display cards (mirrors 46's termination rows).
-- ---------------------------------------------------------------------------
INSERT INTO carrier_gateways
    (gateway_name, display_name, description, sip_proxy, port, product_types,
     is_primary, is_failover, cps_limit, enabled)
VALUES
    ('sinch_denver_ld', 'Sinch Denver LD (Termination, redundant)',
     'Redundant Sinch INT termination trunk on DENSBX21 (trunk group TBD), '
     'long-distance/international destinations. BACKUP to Bandwidth and to '
     'Sinch Atlanta LD (carrier_trunks priority 35 vs BW 10/20, Atlanta LD 30). '
     'Same IP as the Sinch Denver TF origination trunk. Disabled until Sinch '
     'confirms the build.',
     '206.146.100.25', 5060, ARRAY['rcf','trunk','api'], false, true, 25, false),
    ('sinch_atlanta_tf', 'Sinch Atlanta TF (Termination, redundant)',
     'Redundant Sinch OSAO termination trunk on ATLSBX21 (trunk group TBD), '
     'toll-free 8YY destinations ONLY (traffic_class=tollfree). BACKUP priority '
     '45, after Sinch Denver TF (40). Same IP as the Sinch Atlanta TF '
     'origination trunk. Disabled until Sinch confirms the build.',
     '206.146.98.25', 5060, ARRAY['rcf','trunk','api'], false, true, 25, false)
ON CONFLICT (gateway_name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4) carrier_trunk_health — 52's definition + setids 11/12 + trunk_enabled.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW carrier_trunk_health AS
WITH probe AS (
    -- Identical aggregation to 44/45/52: one row per carrier duid across all
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
    -- (6/7), Sinch term Atlanta LD / Denver TF (8/9), Sinch redundant term
    -- Denver LD / Atlanta TF (11/12). TC1/TC2 (4/5) stay structurally
    -- excluded; 10 is the SBC peer-liveness group (not a carrier).
    WHERE s.setid IN (2, 3, 6, 7, 8, 9, 11, 12)
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
-- duid -> carrier_trunks (carrier, pop) for the trunk_enabled column (53).
-- (carrier, pop) is UNIQUE, so the join never multiplies rows. Orig duids
-- reuse orig_map; probed termination/Bandwidth duids are listed here.
trunk_map AS (
    SELECT m.duid, m.carrier, m.pop FROM orig_map m
    UNION ALL
    SELECT * FROM (VALUES
            ('bw-dallas-primary', 'bandwidth', 'dallas'),
            ('bw-la-secondary',   'bandwidth', 'la'),
            ('sinch-atlanta-ld',  'sinch',     'atlanta-ld'),
            ('sinch-denver-tf',   'sinch',     'denver-tf'),
            ('sinch-denver-ld',   'sinch',     'denver-ld'),
            ('sinch-atlanta-tf',  'sinch',     'atlanta-tf')
         ) AS t(duid, carrier, pop)
),
-- Probe rows + synthesized rows for probe-less orig trunks (see 52).
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
    END AS health_source,
    -- Appended (53): carrier_trunks.enabled behind this duid; NULL = no
    -- mapped row. A 'down' row with trunk_enabled = false is an operator-
    -- disabled trunk, not an outage (see header).
    ct.enabled AS trunk_enabled
FROM src s
LEFT JOIN orig_map     o  ON o.duid = s.duid
LEFT JOIN orig_traffic t  ON t.duid = s.duid
LEFT JOIN trunk_map    tm ON tm.duid = s.duid
LEFT JOIN carrier_trunks ct
       ON ct.carrier = tm.carrier AND ct.pop = tm.pop;

-- ---------------------------------------------------------------------------
-- Grants — re-asserts (TABLE-level grants already cover the new rows; view
-- grants survive CREATE OR REPLACE; harmless on re-run). The view runs with
-- its owner's privileges, so readers need no direct carrier_trunks grant.
-- ---------------------------------------------------------------------------
GRANT SELECT ON carrier_trunks TO freeswitch;
GRANT ALL    ON carrier_trunks TO api;
GRANT USAGE, SELECT ON carrier_trunks_id_seq TO api;

GRANT ALL    ON carrier_gateways TO api;
GRANT SELECT ON carrier_gateways TO freeswitch;
GRANT USAGE, SELECT ON carrier_gateways_id_seq TO api;

GRANT SELECT ON carrier_trunk_health TO api;
GRANT SELECT ON carrier_trunk_health TO grafana_ro;
