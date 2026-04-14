-- ==========================================================================
-- 17_account_cleanup.sql
-- Clean up and restructure accounts for presentation-ready state
--
-- Replaces old test customers (IDs 1-5) with clean demo accounts.
-- Renames "Granite Engineering" to "Granite Telephony" and assigns real DIDs.
--
-- Idempotent: uses ON CONFLICT, WHERE NOT EXISTS, and conditional checks.
-- Must run AFTER: 14_granite_accounts.sql (Granite customers/users exist)
-- ==========================================================================

BEGIN;

-- =========================================================================
-- STEP 1: Rename "Granite Engineering" -> "Granite Telephony"
-- =========================================================================
UPDATE customers
SET name = 'Granite Telephony',
    account_type = 'hybrid',
    ucaas_enabled = true,
    updated_at = NOW()
WHERE name IN ('Granite Engineering', 'Granite Telephony');

-- =========================================================================
-- STEP 2: Assign real DIDs to Granite Telephony extensions
--         +17743260301 -> ext 100,  +16174544217 as RCF DID (step 8)
-- =========================================================================

-- Clear any stale DID assignments globally for the DIDs we're about to assign
UPDATE extensions SET assigned_did = NULL WHERE assigned_did = '+17743260301';
UPDATE extensions SET assigned_did = NULL WHERE assigned_did = '+16174544217';

-- Assign +17743260301 to extension 100
UPDATE extensions
SET assigned_did = '+17743260301'
WHERE customer_id = (SELECT id FROM customers WHERE name = 'Granite Telephony')
  AND extension = '100';

-- =========================================================================
-- STEP 3: Delete old test customers and their orphaned users
--
-- CASCADE handles: rcf_numbers, sip_trunks (-> trunk_auth_ips, trunk_dids),
--   api_credentials, api_dids, extensions (-> voicemails, voicemail_greetings),
--   chat_conversations (-> chat_participants, chat_messages -> chat_attachments),
--   customer_destination_whitelist, customer_rate_assignments,
--   conferences (-> conference_schedules, conference_participants,
--     conference_sessions), document_folders, shared_documents
--
-- users.customer_id is ON DELETE SET NULL, so we must delete users explicitly.
-- =========================================================================

-- Delete users that belong to old test customers (IDs 1-5).
-- Preserve admin@customvoip.com and support@granite.com regardless.
DELETE FROM users
WHERE customer_id IN (1, 2, 3, 4, 5)
  AND email NOT IN ('admin@customvoip.com', 'support@granite.com');

-- Also clean up any demo users from prior runs of this script
-- (their customer will be deleted, leaving them orphaned with SET NULL)
DELETE FROM users
WHERE email IN (
    'rcf@demo.customvoip.com',
    'trunk@demo.customvoip.com',
    'ucaas@demo.customvoip.com',
    'hybrid@demo.customvoip.com'
);

-- Now delete the old test customers. CASCADE cleans up all child records.
DELETE FROM customers WHERE id IN (1, 2, 3, 4, 5);

-- =========================================================================
-- STEP 4: Create new demo customers
-- =========================================================================

-- 4a. Demo RCF Customer
INSERT INTO customers (name, account_type, balance, credit_limit, status, traffic_grade, ucaas_enabled)
SELECT 'Demo RCF Customer', 'rcf', 100.0000, 50.0000, 'active', 'standard', false
WHERE NOT EXISTS (SELECT 1 FROM customers WHERE name = 'Demo RCF Customer');

-- 4b. Demo Trunk Customer
INSERT INTO customers (name, account_type, balance, credit_limit, status, traffic_grade, ucaas_enabled)
SELECT 'Demo Trunk Customer', 'trunk', 1000.0000, 200.0000, 'active', 'standard', false
WHERE NOT EXISTS (SELECT 1 FROM customers WHERE name = 'Demo Trunk Customer');

-- 4c. Demo UCaaS Customer
INSERT INTO customers (name, account_type, balance, credit_limit, status, traffic_grade, ucaas_enabled)
SELECT 'Demo UCaaS Customer', 'ucaas', 0, 0, 'active', 'standard', true
WHERE NOT EXISTS (SELECT 1 FROM customers WHERE name = 'Demo UCaaS Customer');

-- 4d. Demo Hybrid Customer
INSERT INTO customers (name, account_type, balance, credit_limit, status, traffic_grade, ucaas_enabled)
SELECT 'Demo Hybrid Customer', 'hybrid', 500.0000, 200.0000, 'active', 'standard', true
WHERE NOT EXISTS (SELECT 1 FROM customers WHERE name = 'Demo Hybrid Customer');

-- =========================================================================
-- STEP 5: Create demo users
--         bcrypt hash is for 'password123'
-- =========================================================================

-- 5a. RCF Demo User
INSERT INTO users (email, password_hash, customer_id, role, name, status)
VALUES (
    'rcf@demo.customvoip.com',
    '$2b$12$3waCBHwkLKsE33ZqkisqJeEKtRx18REHt8AKTMNBuQwmgjuqXN8xy',
    (SELECT id FROM customers WHERE name = 'Demo RCF Customer'),
    'user', 'RCF Demo User', 'active'
)
ON CONFLICT (email) DO UPDATE SET
    customer_id = EXCLUDED.customer_id,
    name = EXCLUDED.name;

-- 5b. Trunk Demo User
INSERT INTO users (email, password_hash, customer_id, role, name, status)
VALUES (
    'trunk@demo.customvoip.com',
    '$2b$12$3waCBHwkLKsE33ZqkisqJeEKtRx18REHt8AKTMNBuQwmgjuqXN8xy',
    (SELECT id FROM customers WHERE name = 'Demo Trunk Customer'),
    'user', 'Trunk Demo User', 'active'
)
ON CONFLICT (email) DO UPDATE SET
    customer_id = EXCLUDED.customer_id,
    name = EXCLUDED.name;

-- 5c. UCaaS Demo User
INSERT INTO users (email, password_hash, customer_id, role, name, status)
VALUES (
    'ucaas@demo.customvoip.com',
    '$2b$12$3waCBHwkLKsE33ZqkisqJeEKtRx18REHt8AKTMNBuQwmgjuqXN8xy',
    (SELECT id FROM customers WHERE name = 'Demo UCaaS Customer'),
    'user', 'UCaaS Demo User', 'active'
)
ON CONFLICT (email) DO UPDATE SET
    customer_id = EXCLUDED.customer_id,
    name = EXCLUDED.name;

-- 5d. Hybrid Demo User
INSERT INTO users (email, password_hash, customer_id, role, name, status)
VALUES (
    'hybrid@demo.customvoip.com',
    '$2b$12$3waCBHwkLKsE33ZqkisqJeEKtRx18REHt8AKTMNBuQwmgjuqXN8xy',
    (SELECT id FROM customers WHERE name = 'Demo Hybrid Customer'),
    'user', 'Hybrid Demo User', 'active'
)
ON CONFLICT (email) DO UPDATE SET
    customer_id = EXCLUDED.customer_id,
    name = EXCLUDED.name;

-- =========================================================================
-- STEP 6: Create demo extensions for UCaaS and Hybrid customers
-- =========================================================================

-- 6a. Demo UCaaS Customer: extension 100 linked to ucaas demo user
INSERT INTO extensions (extension, customer_id, user_id, display_name)
VALUES (
    '100',
    (SELECT id FROM customers WHERE name = 'Demo UCaaS Customer'),
    (SELECT id FROM users WHERE email = 'ucaas@demo.customvoip.com'),
    'UCaaS Demo User'
)
ON CONFLICT (customer_id, extension) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    display_name = EXCLUDED.display_name;

-- 6b. Demo Hybrid Customer: extension 100 linked to hybrid demo user
INSERT INTO extensions (extension, customer_id, user_id, display_name)
VALUES (
    '100',
    (SELECT id FROM customers WHERE name = 'Demo Hybrid Customer'),
    (SELECT id FROM users WHERE email = 'hybrid@demo.customvoip.com'),
    'Hybrid Demo User'
)
ON CONFLICT (customer_id, extension) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    display_name = EXCLUDED.display_name;

-- =========================================================================
-- STEP 7: Create demo SIP trunks and auth IPs
-- =========================================================================

-- 7a. Demo Trunk Customer: "Demo Main Trunk" (50 channels, cps 5, IP auth)
INSERT INTO sip_trunks (customer_id, trunk_name, max_channels, cps_limit, auth_type)
SELECT
    (SELECT id FROM customers WHERE name = 'Demo Trunk Customer'),
    'Demo Main Trunk', 50, 5, 'ip'
WHERE NOT EXISTS (
    SELECT 1 FROM sip_trunks
    WHERE customer_id = (SELECT id FROM customers WHERE name = 'Demo Trunk Customer')
      AND trunk_name = 'Demo Main Trunk'
);

-- Auth IP for Demo Main Trunk: 203.0.113.100
INSERT INTO trunk_auth_ips (trunk_id, ip_address, description)
SELECT
    (SELECT id FROM sip_trunks
     WHERE customer_id = (SELECT id FROM customers WHERE name = 'Demo Trunk Customer')
       AND trunk_name = 'Demo Main Trunk'),
    '203.0.113.100'::inet,
    'Demo Trunk PBX'
WHERE NOT EXISTS (
    SELECT 1 FROM trunk_auth_ips
    WHERE trunk_id = (SELECT id FROM sip_trunks
                      WHERE customer_id = (SELECT id FROM customers WHERE name = 'Demo Trunk Customer')
                        AND trunk_name = 'Demo Main Trunk')
      AND ip_address = '203.0.113.100'::inet
);

-- 7b. Demo Hybrid Customer: "Hybrid Trunk" (25 channels)
INSERT INTO sip_trunks (customer_id, trunk_name, max_channels, cps_limit, auth_type)
SELECT
    (SELECT id FROM customers WHERE name = 'Demo Hybrid Customer'),
    'Hybrid Trunk', 25, 10, 'ip'
WHERE NOT EXISTS (
    SELECT 1 FROM sip_trunks
    WHERE customer_id = (SELECT id FROM customers WHERE name = 'Demo Hybrid Customer')
      AND trunk_name = 'Hybrid Trunk'
);

-- Auth IP for Hybrid Trunk: 203.0.113.200
INSERT INTO trunk_auth_ips (trunk_id, ip_address, description)
SELECT
    (SELECT id FROM sip_trunks
     WHERE customer_id = (SELECT id FROM customers WHERE name = 'Demo Hybrid Customer')
       AND trunk_name = 'Hybrid Trunk'),
    '203.0.113.200'::inet,
    'Hybrid Customer PBX'
WHERE NOT EXISTS (
    SELECT 1 FROM trunk_auth_ips
    WHERE trunk_id = (SELECT id FROM sip_trunks
                      WHERE customer_id = (SELECT id FROM customers WHERE name = 'Demo Hybrid Customer')
                        AND trunk_name = 'Hybrid Trunk')
      AND ip_address = '203.0.113.200'::inet
);

-- =========================================================================
-- STEP 8: Create RCF number for Granite Telephony (real TN)
--         +16174544217 forwarding to +17744045256
-- =========================================================================

-- Remove the DID from any previous owner first (idempotency)
DELETE FROM rcf_numbers WHERE did = '+16174544217';

INSERT INTO rcf_numbers (did, name, customer_id, forward_to, pass_caller_id, enabled, ring_timeout)
VALUES (
    '+16174544217',
    'Granite RCF Line',
    (SELECT id FROM customers WHERE name = 'Granite Telephony'),
    '+17744045256',
    true,
    true,
    30
)
ON CONFLICT (did) DO UPDATE SET
    customer_id = EXCLUDED.customer_id,
    forward_to = EXCLUDED.forward_to,
    name = EXCLUDED.name;

-- =========================================================================
-- STEP 9: Assign rate tables to new demo customers
-- =========================================================================

INSERT INTO customer_rate_assignments (customer_id, inbound_rate_table_id, outbound_rate_table_id)
SELECT id, 1, 1 FROM customers WHERE name = 'Demo RCF Customer'
ON CONFLICT (customer_id) DO NOTHING;

INSERT INTO customer_rate_assignments (customer_id, inbound_rate_table_id, outbound_rate_table_id)
SELECT id, 1, 1 FROM customers WHERE name = 'Demo Trunk Customer'
ON CONFLICT (customer_id) DO NOTHING;

INSERT INTO customer_rate_assignments (customer_id, inbound_rate_table_id, outbound_rate_table_id)
SELECT id, 1, 1 FROM customers WHERE name = 'Demo UCaaS Customer'
ON CONFLICT (customer_id) DO NOTHING;

INSERT INTO customer_rate_assignments (customer_id, inbound_rate_table_id, outbound_rate_table_id)
SELECT id, 1, 1 FROM customers WHERE name = 'Demo Hybrid Customer'
ON CONFLICT (customer_id) DO NOTHING;

-- =========================================================================
-- STEP 10: Reset sequences so new auto-generated IDs are clean
--          Start above any manually inserted IDs
-- =========================================================================

SELECT setval('customers_id_seq',  GREATEST((SELECT MAX(id) FROM customers),  20));
SELECT setval('sip_trunks_id_seq', GREATEST((SELECT MAX(id) FROM sip_trunks), 20));
SELECT setval('users_id_seq',      GREATEST((SELECT MAX(id) FROM users),      20));
SELECT setval('extensions_id_seq', GREATEST((SELECT MAX(id) FROM extensions), 100));
SELECT setval('rcf_numbers_id_seq', GREATEST((SELECT MAX(id) FROM rcf_numbers), 10));

COMMIT;
