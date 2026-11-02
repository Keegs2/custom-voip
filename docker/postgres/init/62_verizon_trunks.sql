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
-- zone up (owner, on the primary), in two steps:
--   (a) As soon as Verizon assigns the SIP Gateway IP — BEFORE (or together
--       with) setting it in the SBCs' VERIZON_PROBE_IPS. Inert while the rows
--       are disabled (FS and Kamailio's X-Carrier-IP / CARRIER_TRUST lookups
--       all filter enabled = true); it is what maps the group-13 probe to
--       this row (carrier_trunk_health matches Verizon probes BY IP, below):
--     UPDATE carrier_trunks SET source_ip = '<verizon sip gw ip>', trunk_group = '<name>', updated_at = now() WHERE carrier = 'verizon' AND pop IN ('east', 'east-orig');
--   (b) After the tunnels and the Kamailio Verizon build are live on BOTH
--       SBCs of the zone:
--     UPDATE carrier_trunks SET enabled = true, updated_at = now() WHERE carrier = 'verizon' AND pop = 'east';
--     UPDATE carrier_gateways SET sip_proxy = '<verizon sip gw ip>', enabled = true, updated_at = now() WHERE gateway_name = 'verizon_east';
-- (same for west / central). Change the IP on BOTH rows of a pop pair (the
-- outbound '<zone>' row and the inbound '<zone>-orig' row) — 53's partial
-- unique indexes allow exactly one ingress + one egress row per IP. FS picks
-- an enabled row up within 60 s (trunk cache TTL); Kamailio's X-Carrier-IP
-- validation passes it on the next call. No redeploy.
--
-- ** MORE THAN ONE SIP GATEWAY IP IN A ZONE ** (Verizon may assign several):
-- give each extra IP its OWN outbound row with pop '<zone>-2', '<zone>-3',
-- ... ((carrier, pop) is UNIQUE; 53's egress index takes one outbound row per
-- IP), e.g. for East, tried right after verizon/east (equal effective
-- priority, ORDER BY eff_priority, id) and before the other zones' gateways:
--     INSERT INTO carrier_trunks (carrier, pop, trunk_group, source_ip, direction, traffic_class, cps_limit, enabled, priority, priority_east, priority_west, priority_central, notes) VALUES ('verizon', 'east-2', '<name>', '<2nd verizon sip gw ip>', 'outbound', 'ld', 25, false, 50, 50, 52, 51, 'Verizon IPsec LD termination — 2nd SIP Gateway preferred by East.');
-- then enable it like (b). It shows in carrier_trunk_health as
-- verizon-east-2 / 'Verizon SIP Gateway East 2'. NO extra '-orig' row:
-- origination attribution is per ZONE (Kamailio stamps X-Inbound-PoP
-- '<zone>-orig' for every VERIZON_SIP_NETS source), so verizon/east-orig
-- covers all of East's gateways and an 'east-2-orig' row would only ever
-- read 'passive'. Also add the IP to the zone SBCs' VERIZON_SIP_NETS and
-- VERIZON_PROBE_IPS (any order). FS needs nothing (lib/term_trunks.lua is
-- pop-agnostic; carrier 'verizon' rows get the signaling-VIP attempt only).
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
--   1. The probe CTE gains a second arm for setid 13: dispatcher group 13 =
--      the Verizon SIP Gateway OPTIONS probes, sent from the .251 VIP socket.
--      (Chosen as the lowest unused setid above the current max 12; 10 is the
--      SBC peer-liveness group — not a carrier.) The first arm (setids 2..12)
--      is 53's aggregation unchanged. ** Verizon probe rows are keyed by the
--      PROBED IP, not the dispatcher duid: ** a probe IP equal to the
--      source_ip of a Verizon outbound/both carrier_trunks row shows as duid
--      'verizon-<pop>' (verizon-east / -west / -central, verizon-east-2 for
--      an extra gateway row), name 'Verizon SIP Gateway <Pop>'; any other
--      probed IP shows as 'verizon-unmapped-<ip, dots as dashes>' with
--      trunk_enabled NULL. The dispatcher duid (verizon-<zone> on the first
--      VERIZON_PROBE_IPS entry, verizon-<zone>-2, ... after) is positional
--      and only keys carrier_trunk_status rows — list order, SBCs disagreeing
--      on it, and cross-zone probing never change which row an IP maps to.
--      Per (IP, SBC) only that SBC's newest report counts (a row left under
--      an old positional duid never double-counts an SBC). Single gateway
--      IP per zone, IP replaced in TED (step (a) above): identical output to
--      the duid-keyed form (verizon-<zone>, 'Verizon SIP Gateway <Zone>').
--   2. orig_map gains the Verizon origination duids DATA-DRIVEN from
--      carrier_trunks (carrier = 'verizon' AND direction = 'inbound'):
--      duid 'verizon-<pop>' (= verizon-east-orig ...), synthesized passive
--      row named 'Verizon <Zone> Orig' with the row's CURRENT source_ip —
--      so replacing the placeholder IP via TED updates the view with no
--      further migration (the Sinch rows stay literal, byte-identical).
--   3. trunk_map gains the Verizon termination duids the same way
--      (direction IN ('outbound','both') -> duid 'verizon-<pop>'), so
--      trunk_enabled reads carrier_trunks.enabled for the mapped Verizon
--      probe rows and a seeded-disabled row shows 'down' + trunk_enabled =
--      false (53's semantics). A probe of an IP no row carries yet (e.g. the
--      TEST-NET placeholder not replaced) is 'verizon-unmapped-...' with
--      trunk_enabled NULL — do step (a) first.
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
-- 3) carrier_trunk_health — 53's definition + an IP-keyed setid-13 probe arm
--    + data-driven Verizon orig_map / trunk_map arms. Columns, order, types
--    and every pre-existing duid's values are IDENTICAL to 53.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW carrier_trunk_health AS
WITH probe AS (
    -- Identical aggregation to 44/45/52/53: one row per carrier duid across
    -- all reporting SBCs; name/ip/setid collapse via MAX (identical per duid).
    -- Live carriers: Bandwidth Dallas/LA (2/3), Sinch orig Denver/Chicago
    -- (6/7), Sinch term Atlanta LD / Denver TF (8/9), Sinch redundant term
    -- Denver LD / Atlanta TF (11/12). TC1/TC2 (4/5) stay structurally
    -- excluded; 10 is the SBC peer-liveness group (not a carrier). Verizon
    -- (13) is the second arm below.
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
    WHERE s.setid IN (2, 3, 6, 7, 8, 9, 11, 12)
    GROUP BY s.duid
    UNION ALL
    -- Verizon SIP Gateways (dispatcher group 13, probed from the .251 VIP),
    -- keyed by the PROBED IP, not by the dispatcher duid. The entrypoint's
    -- duid (verizon-<zone>, verizon-<zone>-2, ...) is positional in
    -- VERIZON_PROBE_IPS, so it only keys the carrier_trunk_status rows; the
    -- identity shown here comes from the carrier_trunks Verizon termination
    -- row whose source_ip IS that IP (53's egress partial unique index: at
    -- most one outbound/both row per IP), so any number of gateway IPs per
    -- zone map correctly in any list order, on SBCs that disagree on the
    -- order, and when probed from more than one zone.
    --   mapped   -> duid 'verizon-' || pop (verizon-east, verizon-east-2 ...),
    --               name 'Verizon SIP Gateway ' || <Pop> (East, East 2 ...);
    --               trunk_map below joins the same row for trunk_enabled.
    --   unmapped -> duid 'verizon-unmapped-<ip with - for .>', name naming
    --               the IP and the dispatcher duid(s) it is probed under;
    --               trunk_enabled NULL. Fix by putting the IP on the row in
    --               TED (no migration).
    -- Per (IP, SBC) only that SBC's MOST RECENT report counts, so a
    -- carrier_trunk_status row left behind under an old positional duid
    -- after a VERIZON_PROBE_IPS reorder/shrink never double-counts an SBC.
    -- (A report with no IP falls back to its duid as the key.)
    SELECT
        COALESCE('verizon-' || ct.pop,
                 'verizon-unmapped-' || translate(v.ip_key, '.:', '--')),
        CASE
            WHEN ct.pop IS NOT NULL
            THEN 'Verizon SIP Gateway ' || initcap(replace(ct.pop, '-', ' '))
            ELSE 'Verizon SIP Gateway ' || COALESCE(NULLIF(v.ip, ''), '<no IP reported>')
                 || ' (unmapped: probed as ' || v.probe_duids || ')'
        END,
        v.ip,
        v.setid,
        v.up_sbcs,
        v.total_sbcs,
        v.probe_up,
        v.last_updated
    FROM (
        SELECT
            l.ip_key,
            MAX(l.ip)    AS ip,
            MAX(l.setid) AS setid,
            COUNT(*) FILTER (WHERE l.is_up) AS up_sbcs,
            COUNT(*)                        AS total_sbcs,
            bool_or(l.is_up)                AS probe_up,
            MAX(l.updated_at)               AS last_updated,
            string_agg(DISTINCT l.duid, ',' ORDER BY l.duid) AS probe_duids
        FROM (
            SELECT DISTINCT ON (COALESCE(NULLIF(s.ip, ''), s.duid), s.sbc_id)
                COALESCE(NULLIF(s.ip, ''), s.duid) AS ip_key,
                s.duid, s.ip, s.setid, s.is_up, s.updated_at
            FROM carrier_trunk_status s
            WHERE s.setid = 13
            ORDER BY COALESCE(NULLIF(s.ip, ''), s.duid), s.sbc_id,
                     s.updated_at DESC, s.duid
        ) l
        GROUP BY l.ip_key
    ) v
    LEFT JOIN carrier_trunks ct
           ON ct.carrier = 'verizon'
          AND ct.direction IN ('outbound', 'both')
          AND host(ct.source_ip) = v.ip_key
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
-- -central / any extra gateway row such as verizon-east-2) come from
-- carrier_trunks — the same row the probe arm matched by IP, so a mapped
-- Verizon probe row always gets its own row's enabled flag; an unmapped one
-- ('verizon-unmapped-...') matches nothing here (trunk_enabled NULL).
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
