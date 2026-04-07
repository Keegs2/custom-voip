# Local RCF Testing with Zoiper Softphones

This guide explains how to test the RCF (Remote Call Forwarding) feature locally using Zoiper softphones to prove that updating the forward-to number via API actually changes where calls route.

## Prerequisites

- Docker and Docker Compose installed
- Zoiper softphone (free version works) - download from https://www.zoiper.com/
- curl or any HTTP client for API calls

## Architecture Overview

```
+-------------+     +----------------+     +-------------+
|  Zoiper     |     |                |     |  Zoiper     |
|  Ext 1003   | --> |  FreeSWITCH    | --> |  Ext 1001   |
|  (caller)   |     |  (port 5080)   |     |  (forward)  |
+-------------+     +----------------+     +-------------+
                           |
                           | Lua Script
                           | (inbound_router.lua)
                           |
                    +------v------+
                    |   API       |
                    | (port 8080) |
                    +-------------+
                           |
                    +------v------+
                    | PostgreSQL  |
                    +-------------+
```

## Step 1: Start the Platform

```bash
cd /Users/keegan/revup
docker compose up -d
```

Wait for all services to be healthy:
```bash
docker compose ps
```

## Step 2: Configure Zoiper Clients

You need to set up 3 Zoiper instances (can use multiple devices or VMs):

### Registration Settings for ALL Extensions

| Setting | Value |
|---------|-------|
| **Domain/Server** | `localhost` or your machine's IP |
| **Port** | `5080` |
| **Transport** | UDP |
| **Auth Username** | Same as extension (1001, 1002, 1003) |
| **Password** | `test1234` |

### Extension 1001 (RCF Target A)
- Username: `1001`
- Password: `test1234`

### Extension 1002 (RCF Target B)
- Username: `1002`
- Password: `test1234`

### Extension 1003 (Caller)
- Username: `1003`
- Password: `test1234`

### Zoiper Configuration Steps

1. Open Zoiper
2. Click "Create Account" or "Add Account"
3. Choose "SIP" as the account type
4. Enter:
   - Username: `1001` (or 1002, 1003)
   - Password: `test1234`
   - Domain: `localhost:5080` (or `YOUR_IP:5080`)
5. In advanced settings:
   - Transport: UDP
   - Outbound Proxy: leave empty
   - STUN: disable (not needed for local testing)
6. Save and wait for "Registered" status

## Step 3: Verify Registrations

Check FreeSWITCH for registered users:

```bash
docker exec voip-freeswitch fs_cli -x "sofia status profile internal reg"
```

You should see all 3 extensions registered.

## Step 4: Test Direct Extension Calling

Before testing RCF, verify extensions can call each other directly:

From Zoiper 1003, dial `1001`:
- Extension 1001 should ring
- Answer and verify two-way audio

From Zoiper 1003, dial `1002`:
- Extension 1002 should ring

## Step 5: Set Up Test RCF via API

### 5.1 Create a Test Customer

```bash
curl -X POST http://localhost:8080/customers \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test RCF Customer",
    "account_type": "rcf",
    "credit_limit": 100,
    "traffic_grade": "standard"
  }'
```

Note the returned `id` (e.g., `1`).

### 5.2 Create an RCF DID Forwarding to Extension 1001

```bash
curl -X POST http://localhost:8080/rcf \
  -H "Content-Type: application/json" \
  -d '{
    "customer_id": 1,
    "did": "+15551001001",
    "forward_to": "1001",
    "pass_caller_id": true,
    "ring_timeout": 30
  }'
```

You can also use the test DID pattern `555XXXX`:
```bash
curl -X POST http://localhost:8080/rcf \
  -H "Content-Type: application/json" \
  -d '{
    "customer_id": 1,
    "did": "+15550001",
    "forward_to": "1001",
    "pass_caller_id": true,
    "ring_timeout": 30
  }'
```

## Step 6: Test RCF Routing - Initial Forward to 1001

From Zoiper extension 1003, dial: `5550001`

**Expected Result:**
- Extension 1001 should ring (not 1002)
- The call routes through the RCF Lua script
- FreeSWITCH logs will show: `RCF Bridge (LOCAL): +15550001 -> user/1001@voiceplatform.local`

Check the logs:
```bash
docker logs voip-freeswitch 2>&1 | grep -i "RCF Bridge"
```

## Step 7: Update RCF to Forward to Extension 1002

Now update the RCF to forward to 1002:

```bash
curl -X PUT http://localhost:8080/rcf/+15550001 \
  -H "Content-Type: application/json" \
  -d '{
    "forward_to": "1002"
  }'
```

Expected response:
```json
{
  "id": 1,
  "did": "+15550001",
  "forward_to": "1002",
  "pass_caller_id": true,
  "enabled": true,
  "ring_timeout": 30,
  "customer_id": 1,
  "customer_name": "Test RCF Customer"
}
```

## Step 8: Test RCF Routing - Now Forwards to 1002

From Zoiper extension 1003, dial `5550001` again:

**Expected Result:**
- Extension 1002 should ring (not 1001 anymore!)
- This proves the API update changed the routing

Check the logs:
```bash
docker logs voip-freeswitch 2>&1 | grep -i "RCF Bridge" | tail -5
```

You should see:
```
RCF Bridge (LOCAL): +15550001 -> user/1002@voiceplatform.local
```

## Step 9: Verify the Complete Test Scenario

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Register 1001, 1002, 1003 to FreeSWITCH | All show "Registered" |
| 2 | Create RCF DID `+15550001` -> `1001` | API returns success |
| 3 | From 1003, dial `5550001` | Extension 1001 rings |
| 4 | Update RCF to forward to `1002` | API returns new forward_to |
| 5 | From 1003, dial `5550001` | Extension 1002 rings |

## Troubleshooting

### Extensions Not Registering

1. Check FreeSWITCH is running:
   ```bash
   docker compose ps freeswitch
   ```

2. Check port 5080 is accessible:
   ```bash
   nc -zv localhost 5080
   ```

3. Check FreeSWITCH logs for auth failures:
   ```bash
   docker logs voip-freeswitch 2>&1 | grep -i auth
   ```

### RCF Not Routing

1. Check the RCF exists in database:
   ```bash
   curl http://localhost:8080/rcf/+15550001
   ```

2. Check Lua script is being executed:
   ```bash
   docker logs voip-freeswitch 2>&1 | grep -i inbound
   ```

3. Check Redis cache (it caches RCF for 5 minutes):
   ```bash
   docker exec voip-redis redis-cli KEYS "rcf:*"
   docker exec voip-redis redis-cli HGETALL "rcf:+15550001"
   ```

4. Force cache invalidation:
   ```bash
   docker exec voip-redis redis-cli DEL "rcf:+15550001"
   ```

### Audio Issues

1. Check RTP ports are exposed:
   ```bash
   docker compose ps | grep 16384
   ```

2. Try calling the echo test to verify audio:
   - From any extension, dial `9196`
   - You should hear your voice echoed back

### Cannot Reach API

```bash
curl http://localhost:8080/health
```

If this fails, check API container:
```bash
docker logs voip-api
```

## API Reference

### Create RCF
```bash
POST /rcf
{
  "customer_id": 1,
  "did": "+15550001",
  "forward_to": "1001",    # Can be local ext (1001) or E.164 (+15551234567)
  "pass_caller_id": true,
  "ring_timeout": 30
}
```

### Get RCF
```bash
GET /rcf/{did}
```

### Update RCF
```bash
PUT /rcf/{did}
{
  "forward_to": "1002"
}
```

### List All RCF
```bash
GET /rcf
GET /rcf?customer_id=1
```

### Delete RCF
```bash
DELETE /rcf/{did}
```

## Files Modified for Local Testing

The following files were configured to enable local Zoiper testing:

1. **`/docker/freeswitch/conf/directory/default.xml`**
   - Added users 1001, 1002, 1003 with password `test1234`

2. **`/docker/freeswitch/conf/dialplan/public.xml`**
   - Added `default` context for registered users
   - Added local extension dialing (10XX pattern)
   - Added test RCF DID pattern (555XXXX)

3. **`/docker/freeswitch/scripts/inbound_router.lua`**
   - Added `is_local_extension()` function
   - Routes to `user/XXXX@domain` for local extensions
   - Routes to `sofia/gateway/carrier/number` for PSTN

4. **`/docker/freeswitch/conf/sofia/internal.xml`**
   - Enabled `auth-calls` for digest authentication
   - Enabled NAT detection for local testing
   - Added logging for auth failures
