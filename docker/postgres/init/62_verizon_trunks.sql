-- ==========================================================================
-- 62_verizon_trunks.sql
-- Verizon IPsec trunks (docs/VERIZON_IPSEC_TRUNKS_PLAN.md §7 / §8.3):
-- carrier_trunks rows (termination + origination attribution),
-- carrier_gateways display cards, and the carrier_trunk_health view with the
-- Verizon dispatcher group.
--
-- ** PLACEHOLDER IPs — REPLACE VIA TED BEFORE ENABLING ** — Verizon has not
-- assigned its SIP Gateway IPs yet. Every Verizon row is seeded with a
-- documented TEST-NET-1 placeholder (RFC 5737, never routable):
--     192.0.2.11  "verizon/east"     (the SIP Gateway East prefers)
--     192.0.2.12  "verizon/west"     (the SIP Gateway West prefers)
--     192.0.2.13  "verizon/central"  (the SIP Gateway Central prefers)
-- and enabled = false. The row notes carry the same instruction. To turn a
-- zone up (owner, on the primary, after the tunnels and the Kamailio
-- Verizon build are live on BOTH SBCs of the zone):
--     UPDATE carrier_trunks SET source_ip = '<verizon sip gw ip>', trunk_group = '<name>', updated_at = now() WHERE carrier = 'verizon' AND pop IN ('east', 'east-orig');
--     UPDATE carrier_trunks SET enabled = true, updated_at = now() WHERE carrier = 'verizon' AND pop = 'east';
--     UPDATE carrier_gateways SET sip_proxy = '<verizon sip gw ip>', enabled = true, updated_at = now() WHERE gateway_name = 'verizon_east';
-- (same for west / central). Change the IP on BOTH rows of a pop pair (the
-- outbound '<zone>' row and the inbound '<zone>-orig' row) — 53's partial
-- unique indexes allow exactly one ingress + one egress row per IP. FS picks
-- an enabled row up within 60 s (trunk cache TTL); Kamailio's X-Carrier-IP
-- validation passes it on the next call. No redeploy.
--
-- ** TERMINATION ROWS ** (direction 'outbound', traffic_class 'ld', FS
-- selection contract of 44/53 unchanged). Base priority 50 — STRICTLY below
-- every Bandwidth (10/20) and Sinch (30/35 LD, 40/45 TF) row, so Verizon is
-- reached only after every row above it fails (there is no attempt cap any
-- more: lib/term_trunks.lua, 2026-10-30). Per-zone overrides make each zone
-- prefer its own Verizon SIP Gateway, then the nearer one (East: east,
-- central, west; West: west, central, east; Central: central, east, west):
--     pop      priority  priority_east  priority_west  priority_central
--     east        50          50             52              51
--     west        50          52             50              52
--     central     50          51             51              50
-- FreeSWITCH emits ONLY the signaling-VIP attempt for carrier 'verizon'
-- rows (all Verizon replies land on the ACTIVE SBC via the zone's .251 ILB
-- rule; an SBC-1-direct attempt can never see its reply).
-- cps_limit mirrors 44/53 (inert on outbound-only rows). trunk_group NULL
-- until Verizon names its SIP Gateways; test_tn NULL (none provided).
--
-- ** ORIGINATION ROWS ** (direction 'inbound', one per SIP Gateway IP, pop
-- '<zone>-orig', the 52/53 "-orig" pattern). Inbound admission is STATIC
-- (Kamailio flag 5 on VERIZON_SIP_NETS), so these rows are not consulted on
-- the call path; they exist so Kamailio's X-Inbound-Carrier=verizon /
-- X-Inbound-PoP=<zone>-orig attribution joins a carrier_trunks row for TED
-- and the NOC (carrier_trunk_health orig_map below), exactly like the Sinch
-- 8XX-T orig rows. ** CONTRACT for the Kamailio Verizon arm: stamp
-- X-Inbound-PoP as 'east-orig' / 'west-orig' / 'central-orig' (the pop of
-- the inbound row for the SIP Gateway the INVITE came from). **
--
-- ** carrier_gateways ** — display/config metadata only (46: nothing in the
-- call path reads it). Three cards, enabled = false, placeholder sip_proxy.
--
-- ** carrier_trunk_health ** — CREATE OR REPLACE of 53's definition (the
-- latest; identical columns, order and types) with three changes:
--   1. The probe setid filter grows (2,3,6,7,8,9,11,12) -> (..., 13):
--      dispatcher group 13 = the Verizon SIP Gateway OPTIONS probes, sent
--      from the .251 VIP socket. (Chosen as the lowest unused setid above the
--      current max 12; 10 is the SBC peer-liveness group — not a carrier.)
--      ** CONTRACT for dispatcher.list: duid = 'verizon-<pop>' of the
--      OUTBOUND row, i.e. verizon-east / verizon-west / verizon-central. **
--   2. orig_map gains the Verizon origination duids DATA-DRIVEN from
--      carrier_trunks (carrier = 'verizon' AND direction = 'inbound'):
--      duid 'verizon-<pop>' (= verizon-east-orig ...), synthesized passive
--      row named 'Verizon <Zone> Orig' with the row's CURRENT source_ip —
--      so replacing the placeholder IP via TED updates the view with no
--      further migration (the Sinch rows stay literal, byte-identical).
--   3. trunk_map gains the Verizon termination duids the same way
--      (direction = 'outbound' -> duid 'verizon-<pop>'), so trunk_enabled
--      reads carrier_trunks.enabled for the probed Verizon rows and a seeded-
--      disabled row shows 'down' + trunk_enabled = false (53's semantics).
--
-- IDEMPOTENT: safe to run repeatedly. Seed INSERTs are ON CONFLICT DO NOTHING
-- (no conflict target: the (carrier, pop) key, either partial IP index, or
-- carrier_gateways' gateway_name all leave an existing / hand-edited row
-- untouched — a TED-replaced IP is never reverted to the placeholder); the
-- view is CREATE OR REPLACE with 53's exact column list; grants are
-- re-asserts.
--
-- PRODUCTION NOTE: init scripts here only run on the first initdb. Apply
-- MANUALLY on the bare-metal prod primary (services VM, 10.142.0.103), where
-- it replicates to every zone replica:
--     sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/62_verizon_trunks.sql
-- Run as SUPERUSER (postgres). Requires 08 (carrier_gateways), 25, 40, 42
-- (priority columns), 44 (traffic_class), 45/52/53 (the view being replaced
-- + the partial unique indexes). Apply BEFORE the SBC rollout that adds
-- dispatcher group 13 (harmless either way: probe rows for an unknown setid
-- are filtered out of the view until this runs). RE-APPLYING AN OLDER FILE
-- after this one: 53's view statement is byte-compatible (same columns) and
-- simply drops the Verizon arms until this file is re-run; 40/44/45/52 fail
-- at their view statement ("cannot drop columns from view") exactly as 53
-- documents.
-- ==========================================================================

-- ---------------------------------------------------------------------------
-- 1) carrier_trunks — Verizon termination (outbound) + origination (inbound).
-- ---------------------------------------------------------------------------
INSERT INTO carrier_trunks
    (carrier, pop, trunk_group, source_ip, test_tn, direction, traffic_class,
     cps_limit, enabled, priority, priority_east, priority_west,
     priority_central, notes)
VALUES
    ('verizon', 'east', NULL, '192.0.2.11', NULL,
     'outbound', 'ld', 25, false, 50, 50, 52, 51,
     'Verizon IPsec LD termination — SIP Gateway preferred by East. PLACEHOLDER IP (TEST-NET-1 192.0.2.11): replace via TED with the real Verizon SIP Gateway IP (on this row AND the east-orig row) before enabling. Reached via the zone .251 SBC Verizon VIP + IPsec gateways; FS sends the signaling-VIP attempt only. Priority 50 (after every Bandwidth/Sinch row); East 50 / Central 51 / West 52. Dispatcher group 13, duid verizon-east. Seeded DISABLED.'),
    ('verizon', 'west', NULL, '192.0.2.12', NULL,
     'outbound', 'ld', 25, false, 50, 52, 50, 52,
     'Verizon IPsec LD termination — SIP Gateway preferred by West. PLACEHOLDER IP (TEST-NET-1 192.0.2.12): replace via TED with the real Verizon SIP Gateway IP (on this row AND the west-orig row) before enabling. Reached via the zone .251 SBC Verizon VIP + IPsec gateways; FS sends the signaling-VIP attempt only. Priority 50 (after every Bandwidth/Sinch row); effective priority in West 50 / East 52 / Central 52 (each zone tries its own Verizon gateway first, then the nearer one). Dispatcher group 13, duid verizon-west. Seeded DISABLED.'),
    ('verizon', 'central', NULL, '192.0.2.13', NULL,
     'outbound', 'ld', 25, false, 50, 51, 51, 50,
     'Verizon IPsec LD termination — SIP Gateway preferred by Central. PLACEHOLDER IP (TEST-NET-1 192.0.2.13): replace via TED with the real Verizon SIP Gateway IP (on this row AND the central-orig row) before enabling. Reached via the zone .251 SBC Verizon VIP + IPsec gateways; FS sends the signaling-VIP attempt only. Priority 50 (after every Bandwidth/Sinch row); effective priority in Central 50 / East 51 / West 51 (each zone tries its own Verizon gateway first, then the nearer one). Dispatcher group 13, duid verizon-central. Seeded DISABLED.'),
    ('verizon', 'east-orig', NULL, '192.0.2.11', NULL,
     'inbound', 'any', 100, false, 100, NULL, NULL, NULL,
     'Verizon IPsec origination attribution row for the East-preferred SIP Gateway (same IP as verizon/east). PLACEHOLDER IP (TEST-NET-1): replace via TED together with the verizon/east row. Not on the call path (Kamailio trusts VERIZON_SIP_NETS statically, flag 5); exists so X-Inbound-Carrier=verizon / X-Inbound-PoP=east-orig joins a row for TED/NOC (carrier_trunk_health orig_map). Seeded DISABLED.'),
    ('verizon', 'west-orig', NULL, '192.0.2.12', NULL,
     'inbound', 'any', 100, false, 100, NULL, NULL, NULL,
     'Verizon IPsec origination attribution row for the West-preferred SIP Gateway (same IP as verizon/west). PLACEHOLDER IP (TEST-NET-1): replace via TED together with the verizon/west row. Not on the call path (static trust, flag 5); X-Inbound-PoP=west-orig join for TED/NOC. Seeded DISABLED.'),
    ('verizon', 'central-orig', NULL, '192.0.2.13', NULL,
     'inbound', 'any', 100, false, 100, NULL, NULL, NULL,
     'Verizon IPsec origination attribution row for the Central-preferred SIP Gateway (same IP as verizon/central). PLACEHOLDER IP (TEST-NET-1): replace via TED together with the verizon/central row. Not on the call path (static trust, flag 5); X-Inbound-PoP=central-orig join for TED/NOC. Seeded DISABLED.')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2) carrier_gateways — display cards (mirrors 46/53's termination rows).
-- ---------------------------------------------------------------------------
INSERT INTO carrier_gateways
    (gateway_name, display_name, description, sip_proxy, port, product_types,
     is_primary, is_failover, cps_limit, enabled)
VALUES
    ('verizon_east', 'Verizon East (IPsec, Termination)',
     'Verizon SIP Gateway preferred by East, reached over the zone IPsec '
     'tunnels (east-vz-gw-a/b) via the SBC Verizon VIP 10.142.0.251. LD '
     'destinations; LAST resort after every Bandwidth and Sinch row '
     '(carrier_trunks priority 50). PLACEHOLDER IP until Verizon assigns the '
     'gateway — disabled until turn-up. The TCP Test button cannot reach an '
     'in-tunnel address; live health = dispatcher group 13 OPTIONS.',
     '192.0.2.11', 5060, ARRAY['rcf','trunk','api'], false, true, 25, false),
    ('verizon_west', 'Verizon West (IPsec, Termination)',
     'Verizon SIP Gateway preferred by West, reached over the zone IPsec '
     'tunnels (west-vz-gw-a/b) via the SBC Verizon VIP 10.138.0.251. LD '
     'destinations; LAST resort after every Bandwidth and Sinch row '
     '(carrier_trunks priority 50). PLACEHOLDER IP until Verizon assigns the '
     'gateway — disabled until turn-up. The TCP Test button cannot reach an '
     'in-tunnel address; live health = dispatcher group 13 OPTIONS.',
     '192.0.2.12', 5060, ARRAY['rcf','trunk','api'], false, true, 25, false),
    ('verizon_central', 'Verizon Central (IPsec, Termination)',
     'Verizon SIP Gateway preferred by Central, reached over the zone IPsec '
     'tunnels (central-vz-gw-a/b) via the SBC Verizon VIP 10.128.0.251. LD '
     'destinations; LAST resort after every Bandwidth and Sinch row '
     '(carrier_trunks priority 50). PLACEHOLDER IP until Verizon assigns the '
     'gateway — disabled until turn-up. The TCP Test button cannot reach an '
     'in-tunnel address; live health = dispatcher group 13 OPTIONS.',
     '192.0.2.13', 5060, ARRAY['rcf','trunk','api'], false, true, 25, false)
ON CONFLICT (gateway_name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3) carrier_trunk_health — 53's definition + setid 13 + data-driven Verizon
--    orig_map / trunk_map arms. Columns, order, types and every pre-existing
--    duid's values are IDENTICAL to 53.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW carrier_trunk_health AS
WITH probe AS (
    -- Identical aggregation to 44/45/52/53: one row per carrier duid across
    -- all reporting SBCs; name/ip/setid collapse via MAX (identical per duid).
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
    -- Denver LD / Atlanta TF (11/12), Verizon SIP Gateways (13, probed from
    -- the .251 VIP). TC1/TC2 (4/5) stay structurally excluded; 10 is the SBC
    -- peer-liveness group (not a carrier).
    WHERE s.setid IN (2, 3, 6, 7, 8, 9, 11, 12, 13)
    GROUP BY s.duid
),
-- ORIGINATION-ONLY duids. duid -> CDR-attribution join key (Kamailio stamps
-- inbound_carrier/_pop on carrier ingress; FS records them into cdrs). name/
-- ip are set ONLY for probe-less trunks (no dispatcher group) — they seed the
-- synthesized row below; NULL = the trunk has probe rows (45's two PoPs).
-- Sinch rows are literal (unchanged from 53). Verizon rows are read from
-- carrier_trunks so a TED IP replacement needs no view change: duid
-- 'verizon-<pop>' (verizon-east-orig ...), name 'Verizon <Zone> Orig'.
orig_map AS (
    SELECT * FROM (VALUES
            ('sinch-denver',          'sinch', 'denver',          NULL::text,              NULL::text),
            ('sinch-chicago',         'sinch', 'chicago',         NULL::text,              NULL::text),
            ('sinch-atlanta-tf-orig', 'sinch', 'atlanta-tf-orig', 'Sinch Atlanta TF Orig', '206.146.98.25'),
            ('sinch-denver-tf-orig',  'sinch', 'denver-tf-orig',  'Sinch Denver TF Orig',  '206.146.100.25')
         ) AS m(duid, carrier, pop, name, ip)
    UNION ALL
    SELECT 'verizon-' || ct.pop,
           ct.carrier,
           ct.pop,
           'Verizon ' || initcap(replace(ct.pop, '-orig', '')) || ' Orig',
           host(ct.source_ip)
    FROM carrier_trunks ct
    WHERE ct.carrier = 'verizon' AND ct.direction = 'inbound'
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
-- reuse orig_map; probed termination/Bandwidth duids are listed here. The
-- Verizon termination duids ('verizon-<pop>' = verizon-east / -west /
-- -central, dispatcher group 13) come from carrier_trunks.
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
    UNION ALL
    SELECT 'verizon-' || ct.pop, ct.carrier, ct.pop
    FROM carrier_trunks ct
    WHERE ct.carrier = 'verizon' AND ct.direction IN ('outbound', 'both')
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
        -- the TF orig TGs and the Verizon orig rows are not probed at all).
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
    -- disabled trunk, not an outage.
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
