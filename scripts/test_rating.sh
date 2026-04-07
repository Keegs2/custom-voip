#!/bin/bash
# Test Call Rating System
#
# Tests:
#   1. Rate table lookup
#   2. CDR rating
#   3. Balance deduction
#   4. CDR queries
#
set -e

API_URL="${API_URL:-http://localhost:8000}"

echo "=== Call Rating System Test ==="
echo "API: $API_URL"
echo ""

# Test 1: Check customer balance before
echo "1. Customer 1 balance before test..."
BALANCE_BEFORE=$(curl -s "$API_URL/v1/customers/1/balance" | jq '.balance')
echo "   Balance: $BALANCE_BEFORE"
echo ""

# Test 2: Insert test CDR directly via PostgreSQL
echo "2. Inserting test CDR..."
docker exec voip-postgres psql -U voip -d voip -c "
INSERT INTO cdrs (uuid, customer_id, product_type, direction, caller_id, destination,
                  start_time, end_time, duration_ms, hangup_cause, carrier_used, traffic_grade)
VALUES ('test-rating-$(date +%s)', 1, 'rcf', 'outbound', '+15551234567', '+14155551234',
        NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '3 minutes', 120000, 'NORMAL_CLEARING',
        'carrier_standard', 'standard')
RETURNING uuid;
"
echo ""

# Test 3: Get the test CDR UUID
TEST_UUID=$(docker exec voip-postgres psql -U voip -d voip -t -c "
SELECT uuid FROM cdrs WHERE caller_id = '+15551234567' AND rated_at IS NULL ORDER BY start_time DESC LIMIT 1;
" | tr -d ' ')
echo "3. Test CDR UUID: $TEST_UUID"
echo ""

# Test 4: Rate the CDR
if [ -n "$TEST_UUID" ]; then
    echo "4. Rating CDR..."
    curl -s -X POST "$API_URL/v1/cdrs/$TEST_UUID/rate" | jq .
    echo ""

    # Test 5: Verify CDR is rated
    echo "5. Verifying rated CDR..."
    curl -s "$API_URL/v1/cdrs/$TEST_UUID" | jq '{uuid, duration_seconds, rate_per_min, total_cost, rated_at}'
    echo ""
else
    echo "4-5. Skipping rating tests (no unrated CDR found)"
fi

# Test 6: Check customer balance after
echo "6. Customer 1 balance after test..."
BALANCE_AFTER=$(curl -s "$API_URL/v1/customers/1/balance" | jq '.balance')
echo "   Balance: $BALANCE_AFTER"
echo "   Difference: $(echo "$BALANCE_BEFORE - $BALANCE_AFTER" | bc)"
echo ""

# Test 7: Query CDR summary
echo "7. CDR summary for customer 1 (last 7 days)..."
curl -s "$API_URL/v1/cdrs/summary?customer_id=1&group_by=day" | jq '.summary | .[0:3]'
echo ""

# Test 8: Query CDRs by destination
echo "8. CDRs to +1415 prefix..."
curl -s "$API_URL/v1/cdrs?destination=+1415&limit=5" | jq '.count'
echo ""

# Test 9: Verify rate lookup (check DB directly)
echo "9. Rate table lookup for +1 (US)..."
docker exec voip-postgres psql -U voip -d voip -c "
SELECT * FROM get_rate(1, '+14155551234');
"
echo ""

# Test 10: Check fraud prefix blocking
echo "10. Testing fraud prefix detection (Cuba +53)..."
docker exec voip-redis redis-cli GET hrp:53
echo ""

echo "=== Rating System Tests Complete ==="
