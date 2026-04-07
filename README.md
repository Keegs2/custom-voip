# Voice Platform MVP - Containerized Deployment

High-performance containerized voice platform for RCF, API Calling, and SIP Trunk services.

## Quick Start

```bash
# 1. Clone and navigate
cd /path/to/revup

# 2. Copy environment file
cp .env.example .env

# 3. Build and start
docker compose up -d

# 4. Load fraud prefixes into Redis
./scripts/load_fraud_prefixes.sh

# 5. Run tests
./scripts/run_all_tests.sh
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Docker Host (VCenter VM)                  │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌───────────┐  ┌─────────┐  ┌────────────┐  │
│  │ Kamailio │──│ FreeSWITCH│──│ FastAPI │──│  Webhook   │  │
│  │  (SBC)   │  │  (Core)   │  │  (API)  │  │   Test     │  │
│  │  :5060   │  │   :5080   │  │  :8000  │  │   :9000    │  │
│  └──────────┘  └───────────┘  └─────────┘  └────────────┘  │
│        │             │              │                        │
│  ┌─────┴─────────────┴──────────────┴──────────────────┐   │
│  │                  Docker Network                      │   │
│  └─────┬─────────────┬──────────────────────────────────┘   │
│  ┌─────┴─────┐  ┌────┴────┐                                 │
│  │ PostgreSQL│  │  Redis  │                                 │
│  │ +PgBouncer│  │         │                                 │
│  │:5432/6432 │  │  :6379  │                                 │
│  └───────────┘  └─────────┘                                 │
└─────────────────────────────────────────────────────────────┘
```

## Services

| Service | Port | Purpose |
|---------|------|---------|
| PostgreSQL | 5432, 6432 | Database + PgBouncer connection pooling |
| Redis | 6379 | Caching, velocity tracking, channel management |
| FreeSWITCH | 5080 | Core SIP switch, call routing |
| FastAPI | 8000 | REST API for provisioning and control |
| Kamailio | 5060 | SBC (optional) - rate limiting, security |
| Webhook Test | 9000 | Mock webhook for API calling tests |

## Performance Optimizations

### Database
- **TimescaleDB** hypertables for CDR with automatic partitioning
- **PgBouncer** connection pooling (100 connections)
- Hash indexes for O(1) DID lookups
- Async CDR compression and retention policies

### Redis
- Lua scripts for atomic velocity checks
- Atomic channel acquisition/release
- Cached RCF/trunk lookups (avoid DB on hot path)
- Disabled persistence for maximum speed

### FreeSWITCH
- 10,000 max concurrent sessions
- 500 sessions per second
- Connection reuse, compact headers
- Lua scripts with Redis caching

### FastAPI
- Full async with uvloop + httptools
- orjson for 10x faster JSON
- Connection pooling everywhere
- Multiple workers

## Testing

### Test RCF Functionality
```bash
./scripts/test_rcf.sh
```
Tests:
- Create/update/delete RCF numbers
- Verify caching works
- SIP call test (requires sipp)

### Test API Calling
```bash
./scripts/test_api_calling.sh
```
Tests:
- Outbound call initiation
- Call status queries
- Webhook handling

### Test Call Rating
```bash
./scripts/test_rating.sh
```
Tests:
- Rate table lookups
- CDR rating
- Balance deduction
- Fraud prefix detection

### Run All Tests
```bash
./scripts/run_all_tests.sh
```

## VCenter VM Deployment

### Requirements
- Ubuntu 24.04 LTS or Debian 12
- 4+ vCPUs
- 8+ GB RAM
- 50+ GB SSD
- Docker and Docker Compose installed

### Kernel Tuning
```bash
sudo ./scripts/kernel_tune.sh
sudo reboot
```

### Firewall
```bash
sudo ufw allow 5060/udp  # SIP (Kamailio)
sudo ufw allow 5060/tcp
sudo ufw allow 5080/udp  # SIP (FreeSWITCH direct)
sudo ufw allow 8000/tcp  # API
sudo ufw allow 16384:16484/udp  # RTP
```

### Start with SBC
```bash
docker compose --profile with-sbc up -d
```

## API Examples

### Create RCF Number
```bash
curl -X POST http://localhost:8000/v1/rcf \
  -H "Content-Type: application/json" \
  -d '{
    "customer_id": 1,
    "did": "+15551234567",
    "forward_to": "+15559876543",
    "pass_caller_id": true
  }'
```

### Initiate Outbound Call
```bash
curl -X POST http://localhost:8000/v1/calls \
  -H "Content-Type: application/json" \
  -d '{
    "from_did": "+15553001001",
    "to": "+15551112222",
    "webhook_url": "http://your-server.com/voice"
  }'
```

### Create SIP Trunk
```bash
curl -X POST http://localhost:8000/v1/trunks \
  -H "Content-Type: application/json" \
  -d '{
    "customer_id": 3,
    "trunk_name": "Main Office",
    "max_channels": 50,
    "cps_limit": 10
  }'
```

### Query CDRs
```bash
curl "http://localhost:8000/v1/cdrs?customer_id=1&limit=10"
```

## Monitoring

### Check Service Health
```bash
curl http://localhost:8000/health/detailed
```

### View Logs
```bash
docker compose logs -f freeswitch
docker compose logs -f api
```

### FreeSWITCH CLI
```bash
docker exec -it voip-freeswitch fs_cli
```

### Redis Stats
```bash
docker exec voip-redis redis-cli INFO stats
```

## Production Checklist

- [ ] Configure real carrier gateways in FreeSWITCH
- [ ] Set up TLS certificates for Kamailio
- [ ] Change default passwords
- [ ] Configure external IP addresses
- [ ] Set up log rotation
- [ ] Configure monitoring/alerting
- [ ] Test failover scenarios
- [ ] Load test with expected volume
