-- Seed data — production baseline
-- Rate tables and rates only. Customer/trunk/DID data is in 14_granite_accounts.sql.
-- Test accounts removed for RCF-V1 production.

-- Default rate table
INSERT INTO rate_tables (id, name, description, is_default) VALUES
(1, 'Standard', 'Default rate table', true)
ON CONFLICT (id) DO NOTHING;

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
(1, '52', 'Mexico', 0.0180, 0.010000, 6)
ON CONFLICT DO NOTHING;
