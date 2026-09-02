-- Migration 46: Sinch rows for carrier_gateways (the CRAG "Carrier Gateways" cards)
--
-- WHY: the Carrier Gateways area (CRAG Admin > Carriers, top cards; revup
-- GET /v1/carriers) reads the carrier_gateways table, which was seeded with
-- only the two Bandwidth rows (08_carrier_gateways.sql). Sinch was onboarded
-- via the carrier_trunks model (migrations 40/42/44) + SBC env defines, so it
-- never appeared in the gateway cards. carrier_gateways is DISPLAY/CONFIG
-- METADATA ONLY — verified 2026-09-02: nothing in the call path reads it
-- (no Lua, no Kamailio, no other router; only routers/carriers.py CRUD).
-- Adding rows here changes NOTHING about routing.
--
-- NOTE on the card "Test" button: it is a TCP connect to sip_proxy:port.
-- Sinch signaling is UDP; if their SBCs don't accept TCP :5060 the Test
-- shows unreachable — that is a limitation of the TCP probe, not trunk
-- health. Authoritative Sinch health = the SBC dispatcher OPTIONS probes
-- (NOC carrier grid / Grafana carrier tiles / carrier_trunk_health).
--
-- Apply on the East primary (replicates everywhere; init files only run on
-- fresh initdb):
--   sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/init/46_sinch_carrier_gateways.sql
--
-- Idempotent: ON CONFLICT (gateway_name) DO NOTHING.

INSERT INTO carrier_gateways
    (gateway_name, display_name, description, sip_proxy, port, product_types,
     is_primary, is_failover, cps_limit, enabled)
VALUES
    ('sinch_denver', 'Sinch Denver (Origination)',
     'Sinch origination PoP — Trunk Group DNVTCOZIGR2_3278, test TN 5305480845. '
     'Delivers inbound calls to the zone NLB VIPs (round-robin, all 3 zones). '
     'Origination only — never an egress target. Live health: dispatcher OPTIONS '
     '(VIP-sourced; TCP Test button may not apply to this carrier).',
     '206.146.100.24', 5060, ARRAY['rcf','trunk','api'], false, false, 100, true),
    ('sinch_chicago', 'Sinch Chicago (Origination)',
     'Sinch origination PoP — Trunk Group CHCGIL24GR4_7412, test TN 5305480846. '
     'Delivers inbound calls to the zone NLB VIPs. Origination only. '
     'Live health: dispatcher OPTIONS (VIP-sourced).',
     '206.146.101.39', 5060, ARRAY['rcf','trunk','api'], false, false, 100, true),
    ('sinch_atlanta_ld', 'Sinch Atlanta LD (Termination)',
     'Sinch termination trunk — ATLNGAQSGR2_7214, long-distance/international '
     'destinations. BACKUP to Bandwidth (carrier_trunks priority 30 vs BW 10/20); '
     'FreeSWITCH dials it only after Bandwidth attempts fail. Registered to all '
     '6 SBC public IPs.',
     '206.146.98.26', 5060, ARRAY['rcf','trunk','api'], false, true, 25, true),
    ('sinch_denver_tf', 'Sinch Denver TF (Termination)',
     'Sinch termination trunk — DNVTCOZIGR2_3282, toll-free 8YY destinations '
     'ONLY (traffic_class=tollfree; FreeSWITCH never sends it non-8YY calls). '
     'BACKUP priority 40. Registered to all 6 SBC public IPs.',
     '206.146.100.26', 5060, ARRAY['rcf','trunk','api'], false, true, 25, true)
ON CONFLICT (gateway_name) DO NOTHING;
