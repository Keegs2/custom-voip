-- Migration: Add 'ucaas' account type to customers table
-- Needed for existing databases where init scripts have already run

-- Drop and re-add the CHECK constraint to include 'ucaas'
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_account_type_check;
ALTER TABLE customers ADD CONSTRAINT customers_account_type_check
    CHECK (account_type IN ('rcf', 'api', 'trunk', 'hybrid', 'ucaas'));

-- Insert test UCaaS customer (id=5)
INSERT INTO customers (id, name, account_type, balance, credit_limit, status, traffic_grade, daily_limit, cpm_limit, ucaas_enabled) VALUES
(5, 'Test UCaaS Customer', 'ucaas', 0.00, 0.00, 'active', 'standard', 500, 60, true)
ON CONFLICT (id) DO NOTHING;

-- Assign rate table for UCaaS customer
INSERT INTO customer_rate_assignments (customer_id, inbound_rate_table_id, outbound_rate_table_id) VALUES
(5, 1, 1)
ON CONFLICT (customer_id) DO NOTHING;

-- Insert test UCaaS user
INSERT INTO users (email, password_hash, customer_id, role, name, status) VALUES
('ucaas@customvoip.com', '$2b$12$3waCBHwkLKsE33ZqkisqJeEKtRx18REHt8AKTMNBuQwmgjuqXN8xy', 5, 'user', 'UCaaS Test User', 'active')
ON CONFLICT (email) DO NOTHING;

-- Insert test UCaaS extensions
INSERT INTO extensions (extension, customer_id, display_name) VALUES
('2001', 5, 'UCaaS User 1'),
('2002', 5, 'UCaaS User 2')
ON CONFLICT (extension) DO NOTHING;
