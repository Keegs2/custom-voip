-- Seed test data for MVP testing

-- Default rate table
INSERT INTO rate_tables (id, name, description, is_default) VALUES
(1, 'Standard', 'Default rate table', true);

-- Sample rates (US, UK, common destinations)
INSERT INTO rates (rate_table_id, prefix, description, rate_per_min, cost_per_min, increment) VALUES
(1, '1', 'USA/Canada', 0.0100, 0.005000, 6),
(1, '1212', 'New York', 0.0080, 0.004000, 6),
(1, '1310', 'Los Angeles', 0.0080, 0.004000, 6),
(1, '1415', 'San Francisco', 0.0080, 0.004000, 6),
(1, '1800', 'USA Toll-Free', 0.0200, 0.015000, 6),
(1, '1888', 'USA Toll-Free', 0.0200, 0.015000, 6),
(1, '44', 'United Kingdom', 0.0150, 0.008000, 6),
(1, '4420', 'London', 0.0120, 0.006000, 6),
(1, '49', 'Germany', 0.0180, 0.009000, 6),
(1, '33', 'France', 0.0180, 0.009000, 6),
(1, '61', 'Australia', 0.0200, 0.012000, 6),
(1, '81', 'Japan', 0.0250, 0.015000, 6),
(1, '86', 'China', 0.0200, 0.012000, 6),
(1, '91', 'India', 0.0150, 0.008000, 6),
(1, '52', 'Mexico', 0.0180, 0.010000, 6);

-- Test customers
INSERT INTO customers (id, name, account_type, balance, credit_limit, status, traffic_grade, daily_limit, cpm_limit) VALUES
(1, 'Test RCF Customer', 'rcf', 100.00, 50.00, 'active', 'standard', 500, 60),
(2, 'Test API Customer', 'api', 500.00, 100.00, 'active', 'premium', 1000, 120),
(3, 'Test Trunk Customer', 'trunk', 1000.00, 200.00, 'active', 'standard', 2000, 60),
(4, 'Test Hybrid Customer', 'hybrid', 250.00, 100.00, 'active', 'economy', 500, 30);

-- Assign rate tables
INSERT INTO customer_rate_assignments (customer_id, inbound_rate_table_id, outbound_rate_table_id) VALUES
(1, 1, 1),
(2, 1, 1),
(3, 1, 1),
(4, 1, 1);

-- Single test RCF number for POC demo
INSERT INTO rcf_numbers (did, customer_id, forward_to, pass_caller_id, ring_timeout) VALUES
('+15551234567', 1, '+15559876543', true, 30);

-- Test SIP trunk
INSERT INTO sip_trunks (id, customer_id, trunk_name, max_channels, cps_limit, auth_type) VALUES
(1, 3, 'Main Office', 50, 10, 'ip'),
(2, 3, 'Branch Office', 20, 5, 'ip'),
(3, 4, 'Hybrid Trunk', 10, 3, 'ip');

-- Trunk IPs (use test IPs - replace in production)
INSERT INTO trunk_auth_ips (trunk_id, ip_address, description) VALUES
(1, '10.0.0.100', 'Main PBX'),
(1, '10.0.0.101', 'Backup PBX'),
(2, '10.0.1.100', 'Branch PBX'),
(3, '10.0.2.100', 'Hybrid PBX');

-- Trunk DIDs
INSERT INTO trunk_dids (trunk_id, did) VALUES
(1, '+15552001001'),
(1, '+15552001002'),
(2, '+15552002001'),
(3, '+15552003001');

-- API credentials (in production, hash the secret!)
INSERT INTO api_credentials (customer_id, api_key, api_secret_hash, webhook_url) VALUES
(2, 'ak_test_abc123def456', 'hashed_secret_here', 'http://webhook-test:9000/voice'),
(4, 'ak_test_xyz789', 'hashed_secret_here', 'http://webhook-test:9000/voice');

-- API DIDs
INSERT INTO api_dids (customer_id, did, voice_url, fallback_url) VALUES
(2, '+15553001001', 'http://webhook-test:9000/voice', 'http://webhook-test:9000/fallback'),
(2, '+15553001002', 'http://webhook-test:9000/voice', NULL),
(4, '+15553002001', 'http://webhook-test:9000/voice', NULL);

-- Reset sequences
SELECT setval('customers_id_seq', 10);
SELECT setval('sip_trunks_id_seq', 10);
