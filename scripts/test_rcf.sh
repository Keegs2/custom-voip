#!/bin/bash
# Test RCF (Remote Call Forwarding) Functionality
#
# Prerequisites:
#   - All services running (docker compose up -d)
#   - sipp installed (apt install sip-tester)
#
set -e

API_URL="${API_URL:-http://localhost:8000}"
SIP_HOST="${SIP_HOST:-localhost}"
SIP_PORT="${SIP_PORT:-5080}"

echo "=== RCF Functionality Test ==="
echo "API: $API_URL"
echo "SIP: $SIP_HOST:$SIP_PORT"
echo ""

# Test 1: API Health Check
echo "1. Testing API health..."
curl -s "$API_URL/health" | jq .
echo ""

# Test 2: Get existing RCF number
echo "2. Getting RCF config for +15551234567..."
curl -s "$API_URL/v1/rcf/+15551234567" | jq .
echo ""

# Test 3: Create new RCF number
echo "3. Creating new RCF number..."
NEW_RCF=$(curl -s -X POST "$API_URL/v1/rcf" \
  -H "Content-Type: application/json" \
  -d '{
    "customer_id": 1,
    "did": "+15559999999",
    "forward_to": "+15558888888",
    "pass_caller_id": true
  }')
echo "$NEW_RCF" | jq .
echo ""

# Test 4: Update RCF
echo "4. Updating RCF..."
curl -s -X PUT "$API_URL/v1/rcf/+15559999999" \
  -H "Content-Type: application/json" \
  -d '{"forward_to": "+15557777777"}' | jq .
echo ""

# Test 5: List RCF numbers for customer 1
echo "5. Listing RCF numbers for customer 1..."
curl -s "$API_URL/v1/rcf?customer_id=1" | jq .
echo ""

# Test 6: Check velocity tracking
echo "6. Checking velocity for customer 1..."
curl -s "$API_URL/v1/customers/1" | jq '{balance, daily_limit, cpm_limit}'
echo ""

# Test 7: SIP call test (requires sipp)
if command -v sipp &> /dev/null; then
    echo "7. Making test SIP call..."
    echo "   (This will attempt to call +15551234567)"

    # Create a simple UAC scenario
    cat > /tmp/uac_test.xml << 'EOF'
<?xml version="1.0" encoding="ISO-8859-1"?>
<scenario name="Simple UAC">
  <send retrans="500">
    <![CDATA[
      INVITE sip:[service]@[remote_ip]:[remote_port] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      From: "Test" <sip:test@[local_ip]>;tag=[call_number]
      To: <sip:[service]@[remote_ip]:[remote_port]>
      Call-ID: [call_id]
      CSeq: 1 INVITE
      Contact: <sip:test@[local_ip]:[local_port]>
      Max-Forwards: 70
      Content-Type: application/sdp
      Content-Length: [len]

      v=0
      o=test 1 1 IN IP4 [local_ip]
      s=Test
      c=IN IP4 [local_ip]
      t=0 0
      m=audio [auto_media_port] RTP/AVP 0
      a=rtpmap:0 PCMU/8000
    ]]>
  </send>

  <recv response="100" optional="true"/>
  <recv response="180" optional="true"/>
  <recv response="183" optional="true"/>
  <recv response="200" optional="true" timeout="10000"/>

  <send>
    <![CDATA[
      ACK sip:[service]@[remote_ip]:[remote_port] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      From: "Test" <sip:test@[local_ip]>;tag=[call_number]
      To: <sip:[service]@[remote_ip]:[remote_port]>[peer_tag_param]
      Call-ID: [call_id]
      CSeq: 1 ACK
      Max-Forwards: 70
      Content-Length: 0
    ]]>
  </send>

  <pause milliseconds="2000"/>

  <send>
    <![CDATA[
      BYE sip:[service]@[remote_ip]:[remote_port] SIP/2.0
      Via: SIP/2.0/[transport] [local_ip]:[local_port];branch=[branch]
      From: "Test" <sip:test@[local_ip]>;tag=[call_number]
      To: <sip:[service]@[remote_ip]:[remote_port]>[peer_tag_param]
      Call-ID: [call_id]
      CSeq: 2 BYE
      Max-Forwards: 70
      Content-Length: 0
    ]]>
  </send>

  <recv response="200"/>
</scenario>
EOF

    sipp -sn uac -sf /tmp/uac_test.xml \
        -s +15551234567 \
        -m 1 \
        -r 1 \
        -l 1 \
        "$SIP_HOST:$SIP_PORT" 2>&1 || echo "   SIP test completed (check FreeSWITCH logs for details)"
else
    echo "7. Skipping SIP test (sipp not installed)"
    echo "   Install with: apt install sip-tester"
fi

echo ""
echo "=== RCF Tests Complete ==="

# Cleanup test data
echo ""
echo "Cleaning up test RCF number..."
curl -s -X DELETE "$API_URL/v1/rcf/+15559999999" | jq .
