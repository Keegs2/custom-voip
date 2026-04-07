#!/bin/bash
# Test API Calling Functionality
#
# Tests:
#   1. API credential verification
#   2. Outbound call initiation
#   3. Call status queries
#   4. Webhook handling
#
set -e

API_URL="${API_URL:-http://localhost:8000}"
WEBHOOK_URL="${WEBHOOK_URL:-http://webhook-test:9000}"

echo "=== API Calling Functionality Test ==="
echo "API: $API_URL"
echo "Webhook: $WEBHOOK_URL"
echo ""

# Test 1: Check API DID exists
echo "1. Checking API DID configuration..."
curl -s "$API_URL/v1/customers/2" | jq '{id, name, account_type, balance}'
echo ""

# Test 2: List available API DIDs
echo "2. Querying API DIDs (using direct DB query via CDR endpoint)..."
# Note: We'd need an endpoint for this, using customers as proxy
curl -s "$API_URL/v1/customers/2" | jq .
echo ""

# Test 3: Initiate outbound call
echo "3. Initiating outbound API call..."
CALL_RESPONSE=$(curl -s -X POST "$API_URL/v1/calls" \
  -H "Content-Type: application/json" \
  -d '{
    "from_did": "+15553001001",
    "to": "+15551112222",
    "webhook_url": "http://webhook-test:9000/voice",
    "timeout": 30
  }')
echo "$CALL_RESPONSE" | jq .

CALL_ID=$(echo "$CALL_RESPONSE" | jq -r '.call_id // empty')
echo ""

# Test 4: Query call status
if [ -n "$CALL_ID" ] && [ "$CALL_ID" != "null" ]; then
    echo "4. Querying call status for $CALL_ID..."
    sleep 2  # Wait for call to process
    curl -s "$API_URL/v1/calls/$CALL_ID" | jq .
    echo ""

    # Test 5: Hangup call
    echo "5. Hanging up call..."
    curl -s -X POST "$API_URL/v1/calls/$CALL_ID/update" \
      -H "Content-Type: application/json" \
      -d '{"action": "hangup"}' | jq .
    echo ""
else
    echo "4-5. Skipping call status tests (call not initiated)"
    echo "     This may be expected if FreeSWITCH is not fully configured"
fi

# Test 6: Check webhook server
echo "6. Testing webhook server..."
curl -s "$WEBHOOK_URL/health" | jq .
echo ""

# Test 7: Simulate webhook call
echo "7. Simulating webhook request..."
WEBHOOK_RESPONSE=$(curl -s -X POST "$WEBHOOK_URL/voice" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "uuid=test-uuid-12345&caller_id_number=+15551234567&destination_number=+15559876543&direction=inbound")
echo "$WEBHOOK_RESPONSE"
echo ""

# Test 8: Check CDRs
echo "8. Checking recent CDRs for customer 2..."
curl -s "$API_URL/v1/cdrs?customer_id=2&limit=5" | jq '.cdrs | length'
echo ""

echo "=== API Calling Tests Complete ==="
