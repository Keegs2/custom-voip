-- Read-only: reports which hand-applied migrations (22..49) are present on this database (22..51).
-- Run on the East primary: sudo -u postgres psql -d voip -f /opt/revup/scripts/db/check_migrations.sql
-- Init scripts only run on first initdb; every later migration is applied by hand, so check before assuming.
-- 43 is a one-shot data backfill (jitter units) — if MISSING, read its header before running; never re-run it.
WITH c AS (SELECT table_name t, column_name col FROM information_schema.columns WHERE table_schema='public'), chk(m, ok) AS (VALUES
('22_number_routing', to_regclass('public.number_routing') IS NOT NULL),
('23_onnet_cdr_columns', EXISTS(SELECT 1 FROM c WHERE t='cdrs' AND col='on_net')),
('37_payments_ledger', to_regclass('public.ledger_entries') IS NOT NULL),
('38_payments_demo', EXISTS(SELECT 1 FROM c WHERE t='customers' AND col='is_demo')),
('39_users_support_role', EXISTS(SELECT 1 FROM pg_constraint WHERE conname='users_role_check' AND pg_get_constraintdef(oid) LIKE '%support%')),
('40_carrier_trunks', to_regclass('public.carrier_trunks') IS NOT NULL AND EXISTS(SELECT 1 FROM c WHERE t='cdrs' AND col='inbound_carrier')),
('41_did_carrier_source', EXISTS(SELECT 1 FROM c WHERE t='did_inventory' AND col='carrier_trunk_id')),
('42_carrier_priorities', EXISTS(SELECT 1 FROM c WHERE t='carrier_trunks' AND col='priority_east')),
('43_jitter_units_backfill (DO NOT re-run)', CASE WHEN to_regclass('public.data_migrations') IS NULL THEN false ELSE (xpath('/row/n/text()', query_to_xml('SELECT count(*) AS n FROM data_migrations WHERE migration_id=''43_jitter_units_backfill''', false, true, '')))[1]::text::int > 0 END),
('44_sinch_termination', EXISTS(SELECT 1 FROM c WHERE t='carrier_trunks' AND col='traffic_class')),
('45_orig_trunk_passive_health', EXISTS(SELECT 1 FROM c WHERE t='carrier_trunk_health' AND col='health_source')),
('46_sinch_carrier_gateways', CASE WHEN to_regclass('public.carrier_gateways') IS NULL THEN false ELSE (xpath('/row/n/text()', query_to_xml('SELECT count(*) AS n FROM carrier_gateways WHERE gateway_name=''sinch_denver''', false, true, '')))[1]::text::int > 0 END),
('47_cdr_stir_outcome', EXISTS(SELECT 1 FROM c WHERE t='cdrs' AND col='stir_outcome')),
('48_cdr_call_legs', EXISTS(SELECT 1 FROM c WHERE t='cdrs' AND col='leg')),
('49_cdr_call_legs_index_cagg', to_regclass('public.idx_cdrs_call_id') IS NOT NULL),
('50_cdr_quality_accuracy', EXISTS(SELECT 1 FROM c WHERE t='cdrs' AND col='quality_status') AND EXISTS(SELECT 1 FROM pg_proc WHERE proname='cdr_refresh_call_quality')),
('51_cdr_quality_no_media', EXISTS(SELECT 1 FROM pg_proc WHERE proname='cq_leg_status' AND pronargs=5))
) SELECT m AS migration, CASE WHEN ok THEN 'applied' ELSE '*** MISSING ***' END AS status FROM chk;
