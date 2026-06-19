-- ==========================================================================
-- 14_granite_accounts.sql
-- Seed Granite Telephony as the primary production customer
-- Hybrid type: RCF now, all products available as they launch
-- ==========================================================================

BEGIN;

-- Create Granite Telephony as a hybrid customer (all products available)
INSERT INTO customers (name, account_type, balance, credit_limit, status, traffic_grade)
SELECT 'Granite Telephony', 'hybrid', 1000.0000, 500.0000, 'active', 'premium'
WHERE NOT EXISTS (SELECT 1 FROM customers WHERE name = 'Granite Telephony');

-- Operator account: enable all UCaaS surfaces so the platform admin can see/review
-- every product in the UI, and "view as customer" previews the full UCaaS experience.
UPDATE customers SET ucaas_enabled = true WHERE name = 'Granite Telephony';

-- Create admin user for Granite
INSERT INTO users (email, password_hash, customer_id, role, name, status)
VALUES (
    'admin@customvoip.com',
    '$2b$12$3waCBHwkLKsE33ZqkisqJeEKtRx18REHt8AKTMNBuQwmgjuqXN8xy',
    (SELECT id FROM customers WHERE name = 'Granite Telephony'),
    'admin', 'Platform Admin', 'active'
)
ON CONFLICT (email) DO UPDATE SET
    customer_id = EXCLUDED.customer_id,
    name = EXCLUDED.name,
    role = EXCLUDED.role;

-- Create support user
INSERT INTO users (email, password_hash, customer_id, role, name, status)
VALUES (
    'support@granite.com',
    '$2b$12$3waCBHwkLKsE33ZqkisqJeEKtRx18REHt8AKTMNBuQwmgjuqXN8xy',
    (SELECT id FROM customers WHERE name = 'Granite Telephony'),
    'user', 'Granite Support', 'active'
)
ON CONFLICT (email) DO UPDATE SET
    customer_id = EXCLUDED.customer_id,
    name = EXCLUDED.name;

-- Assign rate table to Granite Telephony
INSERT INTO customer_rate_assignments (customer_id, inbound_rate_table_id, outbound_rate_table_id)
SELECT id, 1, 1 FROM customers WHERE name = 'Granite Telephony'
ON CONFLICT (customer_id) DO NOTHING;

-- RCF number: +16174544217 forwarding to +17744045256
DELETE FROM rcf_numbers WHERE did = '+16174544217';
INSERT INTO rcf_numbers (did, name, customer_id, forward_to, pass_caller_id, enabled, ring_timeout)
VALUES (
    '+16174544217',
    'Granite RCF Line',
    (SELECT id FROM customers WHERE name = 'Granite Telephony'),
    '+17744045256',
    true, true, 30
)
ON CONFLICT (did) DO UPDATE SET
    customer_id = EXCLUDED.customer_id,
    forward_to = EXCLUDED.forward_to,
    name = EXCLUDED.name;

COMMIT;
