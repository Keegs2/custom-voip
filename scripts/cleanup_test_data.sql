-- ==========================================================================
-- cleanup_test_data.sql
-- Run on LIVE production database to remove test accounts
-- and update Granite Telephony to hybrid account type.
--
-- Usage on services VM:
--   sudo -u postgres psql -d voip -f /opt/revup/scripts/cleanup_test_data.sql
-- ==========================================================================

BEGIN;

-- 1. Update Granite Telephony to hybrid (all products available)
UPDATE customers
SET account_type = 'hybrid',
    updated_at = NOW()
WHERE name = 'Granite Telephony';

-- 2. Delete test trunks (cascades to trunk_auth_ips, trunk_dids)
DELETE FROM sip_trunks WHERE customer_id IN (
    SELECT id FROM customers WHERE name LIKE 'Test %'
);

-- 3. Delete test API credentials
DELETE FROM api_credentials WHERE customer_id IN (
    SELECT id FROM customers WHERE name LIKE 'Test %'
);

-- 4. Delete test API DIDs
DELETE FROM api_dids WHERE customer_id IN (
    SELECT id FROM customers WHERE name LIKE 'Test %'
);

-- 5. Delete test RCF numbers
DELETE FROM rcf_numbers WHERE customer_id IN (
    SELECT id FROM customers WHERE name LIKE 'Test %'
);

-- 6. Delete test customer rate assignments
DELETE FROM customer_rate_assignments WHERE customer_id IN (
    SELECT id FROM customers WHERE name LIKE 'Test %'
);

-- 7. Delete test users (users linked to test customers)
DELETE FROM users WHERE customer_id IN (
    SELECT id FROM customers WHERE name LIKE 'Test %'
);

-- 8. Delete test customers
DELETE FROM customers WHERE name LIKE 'Test %';

-- 9. Verify
SELECT id, name, account_type, status, traffic_grade FROM customers;
SELECT id, email, name, role FROM users;
SELECT id, did, forward_to FROM rcf_numbers;

COMMIT;
