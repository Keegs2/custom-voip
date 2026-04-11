-- ==========================================================================
-- 14_granite_accounts.sql
-- Granite Telecommunications company accounts and user restructuring
--
-- Creates two internal Granite company accounts, moves the admin user
-- under Granite Engineering, creates a support user, and provisions
-- initial extensions for both customers.
--
-- Idempotent: safe to run multiple times via WHERE NOT EXISTS / ON CONFLICT.
-- ==========================================================================

BEGIN;

-- -------------------------------------------------------------------------
-- 1. Create Granite Engineering customer
-- -------------------------------------------------------------------------
INSERT INTO customers (name, account_type, balance, credit_limit, status, traffic_grade, ucaas_enabled)
SELECT 'Granite Engineering', 'ucaas', 0, 0, 'active', 'premium', true
WHERE NOT EXISTS (
    SELECT 1 FROM customers WHERE name = 'Granite Engineering'
);

-- -------------------------------------------------------------------------
-- 2. Create Granite Support customer
-- -------------------------------------------------------------------------
INSERT INTO customers (name, account_type, balance, credit_limit, status, traffic_grade, ucaas_enabled)
SELECT 'Granite Support', 'ucaas', 0, 0, 'active', 'standard', true
WHERE NOT EXISTS (
    SELECT 1 FROM customers WHERE name = 'Granite Support'
);

-- -------------------------------------------------------------------------
-- 3. Move existing admin user to Granite Engineering
--
--    Admin access is role-based (role = 'admin'), NOT customer-based.
--    See: docker/api/src/auth/dependencies.py — require_admin() checks
--    user.get("role") == "admin" only. get_customer_filter() returns None
--    for admins, granting unscoped access. Assigning a customer_id does
--    not affect admin privileges.
-- -------------------------------------------------------------------------
UPDATE users
SET customer_id = (SELECT id FROM customers WHERE name = 'Granite Engineering'),
    name = 'Keegan Grabhorn'
WHERE email = 'admin@customvoip.com';

-- -------------------------------------------------------------------------
-- 4. Create support user in Granite Support
--    Password hash is for 'password123' (same as existing seed users)
-- -------------------------------------------------------------------------
INSERT INTO users (email, password_hash, customer_id, role, name, status)
VALUES (
    'support@granite.com',
    '$2b$12$3waCBHwkLKsE33ZqkisqJeEKtRx18REHt8AKTMNBuQwmgjuqXN8xy',
    (SELECT id FROM customers WHERE name = 'Granite Support'),
    'readonly',
    'NOC Support',
    'active'
)
ON CONFLICT (email) DO NOTHING;

-- -------------------------------------------------------------------------
-- 5. Auto-provision extensions
--    Each customer gets extensions starting from 100.
--    Extension numbers are unique per-customer (not globally),
--    per idx_extensions_customer_ext.
-- -------------------------------------------------------------------------

-- Granite Engineering: extensions 100-109
INSERT INTO extensions (extension, customer_id, display_name) VALUES
    ('100', (SELECT id FROM customers WHERE name = 'Granite Engineering'), 'Eng Ext 100'),
    ('101', (SELECT id FROM customers WHERE name = 'Granite Engineering'), 'Eng Ext 101'),
    ('102', (SELECT id FROM customers WHERE name = 'Granite Engineering'), 'Eng Ext 102'),
    ('103', (SELECT id FROM customers WHERE name = 'Granite Engineering'), 'Eng Ext 103'),
    ('104', (SELECT id FROM customers WHERE name = 'Granite Engineering'), 'Eng Ext 104'),
    ('105', (SELECT id FROM customers WHERE name = 'Granite Engineering'), 'Eng Ext 105'),
    ('106', (SELECT id FROM customers WHERE name = 'Granite Engineering'), 'Eng Ext 106'),
    ('107', (SELECT id FROM customers WHERE name = 'Granite Engineering'), 'Eng Ext 107'),
    ('108', (SELECT id FROM customers WHERE name = 'Granite Engineering'), 'Eng Ext 108'),
    ('109', (SELECT id FROM customers WHERE name = 'Granite Engineering'), 'Eng Ext 109')
ON CONFLICT (customer_id, extension) DO NOTHING;

-- Granite Support: extensions 100-109
INSERT INTO extensions (extension, customer_id, display_name) VALUES
    ('100', (SELECT id FROM customers WHERE name = 'Granite Support'), 'Support Ext 100'),
    ('101', (SELECT id FROM customers WHERE name = 'Granite Support'), 'Support Ext 101'),
    ('102', (SELECT id FROM customers WHERE name = 'Granite Support'), 'Support Ext 102'),
    ('103', (SELECT id FROM customers WHERE name = 'Granite Support'), 'Support Ext 103'),
    ('104', (SELECT id FROM customers WHERE name = 'Granite Support'), 'Support Ext 104'),
    ('105', (SELECT id FROM customers WHERE name = 'Granite Support'), 'Support Ext 105'),
    ('106', (SELECT id FROM customers WHERE name = 'Granite Support'), 'Support Ext 106'),
    ('107', (SELECT id FROM customers WHERE name = 'Granite Support'), 'Support Ext 107'),
    ('108', (SELECT id FROM customers WHERE name = 'Granite Support'), 'Support Ext 108'),
    ('109', (SELECT id FROM customers WHERE name = 'Granite Support'), 'Support Ext 109')
ON CONFLICT (customer_id, extension) DO NOTHING;

-- -------------------------------------------------------------------------
-- 6. Link admin user to their extension (Granite Engineering ext 100)
-- -------------------------------------------------------------------------
UPDATE extensions
SET user_id = (SELECT id FROM users WHERE email = 'admin@customvoip.com'),
    display_name = 'Keegan Grabhorn'
WHERE customer_id = (SELECT id FROM customers WHERE name = 'Granite Engineering')
  AND extension = '100';

-- Link support user to their extension (Granite Support ext 100)
UPDATE extensions
SET user_id = (SELECT id FROM users WHERE email = 'support@granite.com'),
    display_name = 'NOC Support'
WHERE customer_id = (SELECT id FROM customers WHERE name = 'Granite Support')
  AND extension = '100';

-- -------------------------------------------------------------------------
-- Assign default rate table to both Granite customers
-- -------------------------------------------------------------------------
INSERT INTO customer_rate_assignments (customer_id, inbound_rate_table_id, outbound_rate_table_id)
SELECT id, 1, 1 FROM customers WHERE name = 'Granite Engineering'
ON CONFLICT (customer_id) DO NOTHING;

INSERT INTO customer_rate_assignments (customer_id, inbound_rate_table_id, outbound_rate_table_id)
SELECT id, 1, 1 FROM customers WHERE name = 'Granite Support'
ON CONFLICT (customer_id) DO NOTHING;

COMMIT;
