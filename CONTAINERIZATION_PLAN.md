# MVP Containerization Plan for VCenter Deployment

## Overview

This plan outlines how to containerize the MVP Voice Platform for deployment to VCenter VMs, enabling testing of:
- Remote Call Forwarding (RCF)
- API Calling functionality
- Call Rating/Billing system

---

## Architecture: Containerized Stack

```
┌─────────────────────────────────────────────────────────────────┐
│                     VCenter VM (Docker Host)                    │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │   Kamailio  │  │  FreeSWITCH │  │       FastAPI           │ │
│  │    (SBC)    │──│   (Core)    │──│    (REST API)           │ │
│  │  Port 5060  │  │  Port 5080  │  │    Port 8000            │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
│         │                │                    │                 │
│  ┌──────┴────────────────┴────────────────────┴──────────────┐ │
│  │                    Docker Network                          │ │
│  └──────┬────────────────┬────────────────────┬──────────────┘ │
│  ┌──────┴──────┐  ┌──────┴──────┐  ┌──────────┴─────────────┐ │
│  │ PostgreSQL  │  │    Redis    │  │   Test Webhook Server  │ │
│  │  Port 5432  │  │  Port 6379  │  │      Port 9000         │ │
│  └─────────────┘  └─────────────┘  └────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## Container Definitions

### 1. PostgreSQL Container
**Purpose**: Customer data, RCF config, CDRs, billing

```dockerfile
# docker/postgres/Dockerfile
FROM postgres:16-alpine

# Copy init scripts for schema
COPY init/*.sql /docker-entrypoint-initdb.d/

ENV POSTGRES_DB=voip
ENV POSTGRES_USER=voip
ENV POSTGRES_PASSWORD=voip_secret
```

**Init SQL**: Create all tables from MVP spec (customers, rcf_numbers, api_credentials, etc.)

---

### 2. Redis Container
**Purpose**: Channel counters, velocity tracking, real-time state

```dockerfile
# docker/redis/Dockerfile
FROM redis:7-alpine

# Custom config for persistence
COPY redis.conf /usr/local/etc/redis/redis.conf

CMD ["redis-server", "/usr/local/etc/redis/redis.conf"]
```

---

### 3. FreeSWITCH Container
**Purpose**: Core SIP switch, call routing, CDR generation

```dockerfile
# docker/freeswitch/Dockerfile
FROM debian:bookworm-slim

# Install FreeSWITCH 1.10.x
RUN apt-get update && apt-get install -y \
    gnupg2 wget lsb-release \
    && wget -O - https://files.freeswitch.org/repo/deb/debian-release/fsstretch-archive-keyring.asc | apt-key add - \
    && echo "deb http://files.freeswitch.org/repo/deb/debian-release/ bookworm main" > /etc/apt/sources.list.d/freeswitch.list \
    && apt-get update && apt-get install -y \
    freeswitch \
    freeswitch-mod-sofia \
    freeswitch-mod-lua \
    freeswitch-mod-xml-curl \
    freeswitch-mod-cdr-pg-csv \
    freeswitch-mod-httapi \
    freeswitch-mod-event-socket \
    freeswitch-mod-dptools \
    freeswitch-mod-dialplan-xml \
    freeswitch-mod-commands \
    freeswitch-sounds-en-us-callie \
    lua5.3 lua-sql-postgres lua-redis \
    && apt-get clean

# Copy configuration
COPY conf/ /etc/freeswitch/
COPY scripts/ /etc/freeswitch/scripts/

EXPOSE 5080/udp 5080/tcp 5081/tcp 8021/tcp

CMD ["/usr/bin/freeswitch", "-nonat", "-nc"]
```

**Key Config Files**:
- `vars.xml` - Global variables
- `sofia/internal.xml` - SIP profile
- `dialplan/default.xml` - Call routing
- `scripts/rcf_lookup.lua` - RCF forwarding logic
- `scripts/fraud_check.lua` - Fraud detection
- `scripts/trunk_channel_check.lua` - Channel management

---

### 4. FastAPI Container
**Purpose**: REST API for provisioning, CDR queries, billing

```dockerfile
# docker/api/Dockerfile
FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ /app/

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

**requirements.txt**:
```
fastapi>=0.109.0
uvicorn[standard]>=0.27.0
asyncpg>=0.29.0
redis>=5.0.0
pydantic>=2.5.0
httpx>=0.26.0
python-jose[cryptography]>=3.3.0
passlib[bcrypt]>=1.7.4
```

---

### 5. Kamailio Container (Optional for Initial Testing)
**Purpose**: SBC - rate limiting, topology hiding, TLS

```dockerfile
# docker/kamailio/Dockerfile
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    gnupg2 wget \
    && wget -O- https://deb.kamailio.org/kamailiodebkey.gpg | apt-key add - \
    && echo "deb http://deb.kamailio.org/kamailio58 bookworm main" > /etc/apt/sources.list.d/kamailio.list \
    && apt-get update && apt-get install -y \
    kamailio \
    kamailio-redis-modules \
    kamailio-postgres-modules \
    kamailio-tls-modules \
    && apt-get clean

COPY kamailio.cfg /etc/kamailio/

EXPOSE 5060/udp 5060/tcp 5061/tcp

CMD ["/usr/sbin/kamailio", "-DD", "-E"]
```

---

### 6. Test Webhook Server (For API Calling Tests)
**Purpose**: Mock customer webhook endpoint for testing API call control

```dockerfile
# docker/webhook-test/Dockerfile
FROM python:3.11-slim

WORKDIR /app
COPY webhook_server.py .
RUN pip install flask

EXPOSE 9000

CMD ["python", "webhook_server.py"]
```

---

## Docker Compose Configuration

```yaml
# docker-compose.yml
version: '3.8'

services:
  postgres:
    build: ./docker/postgres
    container_name: voip-postgres
    environment:
      POSTGRES_DB: voip
      POSTGRES_USER: voip
      POSTGRES_PASSWORD: voip_secret
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./docker/postgres/init:/docker-entrypoint-initdb.d
    ports:
      - "5432:5432"
    networks:
      - voip-network
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U voip -d voip"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    build: ./docker/redis
    container_name: voip-redis
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    networks:
      - voip-network
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5

  freeswitch:
    build: ./docker/freeswitch
    container_name: voip-freeswitch
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    environment:
      - DB_HOST=postgres
      - DB_NAME=voip
      - DB_USER=voip
      - DB_PASS=voip_secret
      - REDIS_HOST=redis
    ports:
      - "5080:5080/udp"   # SIP UDP
      - "5080:5080/tcp"   # SIP TCP
      - "5081:5081/tcp"   # SIP TLS
      - "8021:8021/tcp"   # Event Socket
      - "16384-16484:16384-16484/udp"  # RTP range
    volumes:
      - ./docker/freeswitch/conf:/etc/freeswitch
      - ./docker/freeswitch/scripts:/etc/freeswitch/scripts
      - freeswitch_logs:/var/log/freeswitch
    networks:
      - voip-network
    cap_add:
      - NET_ADMIN  # For RTP

  api:
    build: ./docker/api
    container_name: voip-api
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    environment:
      - DATABASE_URL=postgresql://voip:voip_secret@postgres:5432/voip
      - REDIS_URL=redis://redis:6379
      - FREESWITCH_ESL_HOST=freeswitch
      - FREESWITCH_ESL_PORT=8021
      - FREESWITCH_ESL_PASSWORD=ClueCon
    ports:
      - "8000:8000"
    volumes:
      - ./docker/api/src:/app
    networks:
      - voip-network

  kamailio:
    build: ./docker/kamailio
    container_name: voip-kamailio
    depends_on:
      - freeswitch
    environment:
      - FREESWITCH_HOST=freeswitch
      - FREESWITCH_PORT=5080
    ports:
      - "5060:5060/udp"   # SIP UDP (external)
      - "5060:5060/tcp"   # SIP TCP
      - "5061:5061/tcp"   # SIP TLS
    networks:
      - voip-network

  webhook-test:
    build: ./docker/webhook-test
    container_name: voip-webhook-test
    ports:
      - "9000:9000"
    networks:
      - voip-network

networks:
  voip-network:
    driver: bridge

volumes:
  postgres_data:
  redis_data:
  freeswitch_logs:
```

---

## Directory Structure

```
revup/
├── docker-compose.yml
├── docker/
│   ├── postgres/
│   │   ├── Dockerfile
│   │   └── init/
│   │       ├── 01_schema.sql      # Core tables
│   │       ├── 02_rcf.sql         # RCF tables
│   │       ├── 03_trunks.sql      # SIP trunk tables
│   │       ├── 04_api.sql         # API calling tables
│   │       ├── 05_fraud.sql       # Fraud detection tables
│   │       └── 06_seed_data.sql   # Test data
│   ├── redis/
│   │   ├── Dockerfile
│   │   └── redis.conf
│   ├── freeswitch/
│   │   ├── Dockerfile
│   │   ├── conf/
│   │   │   ├── freeswitch.xml
│   │   │   ├── vars.xml
│   │   │   ├── sofia/
│   │   │   │   └── internal.xml
│   │   │   └── dialplan/
│   │   │       └── default.xml
│   │   └── scripts/
│   │       ├── rcf_lookup.lua
│   │       ├── fraud_check.lua
│   │       └── trunk_channel_check.lua
│   ├── api/
│   │   ├── Dockerfile
│   │   ├── requirements.txt
│   │   └── src/
│   │       ├── main.py
│   │       ├── routers/
│   │       │   ├── rcf.py
│   │       │   ├── calls.py
│   │       │   ├── trunks.py
│   │       │   └── cdrs.py
│   │       ├── models/
│   │       ├── services/
│   │       └── db/
│   ├── kamailio/
│   │   ├── Dockerfile
│   │   └── kamailio.cfg
│   └── webhook-test/
│       ├── Dockerfile
│       └── webhook_server.py
└── tests/
    ├── test_rcf.py
    ├── test_api_calling.py
    └── test_rating.py
```

---

## Implementation Phases

### Phase 1: Core Infrastructure (Days 1-2)
1. Create directory structure
2. Set up PostgreSQL with full schema
3. Set up Redis container
4. Verify database connectivity

### Phase 2: FreeSWITCH Core (Days 3-5)
1. Build FreeSWITCH container with required modules
2. Configure SIP profile (internal.xml)
3. Implement basic dialplan
4. Implement Lua scripts:
   - `rcf_lookup.lua` - RCF forwarding
   - `fraud_check.lua` - Basic fraud checks
   - `trunk_channel_check.lua` - Channel management
5. Configure CDR to PostgreSQL

### Phase 3: FastAPI Layer (Days 6-8)
1. Build API skeleton with authentication
2. Implement endpoints:
   - `POST /v1/rcf` - Create RCF number
   - `GET /v1/rcf/{did}` - Get RCF config
   - `POST /v1/calls` - Initiate outbound call
   - `GET /v1/calls/{id}` - Get call status
   - `GET /v1/cdrs` - Query CDRs
   - `POST /v1/trunks` - Create SIP trunk
3. Implement billing/rating service

### Phase 4: Testing Setup (Days 9-10)
1. Create test webhook server for API calling
2. Seed test data (customers, DIDs, trunks)
3. Write test scripts
4. Document test procedures

---

## Test Scenarios

### Test 1: RCF Functionality
**Objective**: Verify DID forwards to configured destination

```bash
# 1. Create test customer and RCF number via API
curl -X POST http://localhost:8000/v1/customers \
  -H "Content-Type: application/json" \
  -d '{"name": "Test Customer", "account_type": "rcf"}'

curl -X POST http://localhost:8000/v1/rcf \
  -H "Content-Type: application/json" \
  -d '{
    "customer_id": 1,
    "did": "+15551234567",
    "forward_to": "+15559876543",
    "pass_caller_id": true
  }'

# 2. Make test call to the DID
# Use SIP softphone (Zoiper, Linphone) or sipp tool
sipp -sn uac -s +15551234567 -r 1 localhost:5060

# 3. Verify:
# - Call is answered and forwarded
# - CDR is generated with correct billing
# - Caller ID is passed through (if configured)
```

### Test 2: API Calling
**Objective**: Verify outbound call via API with webhook control

```bash
# 1. Create API credentials for customer
curl -X POST http://localhost:8000/v1/api-credentials \
  -H "Content-Type: application/json" \
  -d '{
    "customer_id": 1,
    "webhook_url": "http://webhook-test:9000/voice"
  }'

# 2. Provision DID with voice URL
curl -X POST http://localhost:8000/v1/api-dids \
  -H "Content-Type: application/json" \
  -d '{
    "customer_id": 1,
    "did": "+15552223333",
    "voice_url": "http://webhook-test:9000/voice"
  }'

# 3. Initiate outbound call via API
curl -X POST http://localhost:8000/v1/calls \
  -H "Authorization: Bearer <api_key>" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "+15552223333",
    "to": "+15551111111",
    "webhook_url": "http://webhook-test:9000/status"
  }'

# 4. Verify:
# - Call is initiated
# - Webhook receives call events
# - Call can be controlled via webhook responses
# - CDR is generated
```

### Test 3: Call Rating System
**Objective**: Verify CDRs are correctly rated

```bash
# 1. Set up rate tables
curl -X POST http://localhost:8000/v1/rates \
  -H "Content-Type: application/json" \
  -d '{
    "prefix": "1",
    "rate_per_min": 0.01,
    "description": "US Domestic"
  }'

# 2. Make test calls with known durations

# 3. Query CDRs and verify rating
curl http://localhost:8000/v1/cdrs?customer_id=1

# Expected response:
# {
#   "cdrs": [
#     {
#       "uuid": "abc123",
#       "duration_sec": 120,
#       "billable_sec": 120,
#       "rate_per_min": 0.01,
#       "total_cost": 0.02
#     }
#   ]
# }

# 4. Verify customer balance updated
curl http://localhost:8000/v1/customers/1

# 5. Test fraud detection
# - Try calling blocked prefix
# - Exceed velocity limits
# - Exceed daily spend cap
```

### Test 4: SIP Trunk Channel Limits
**Objective**: Verify channel enforcement

```bash
# 1. Create trunk with 2 channel limit
curl -X POST http://localhost:8000/v1/trunks \
  -d '{"customer_id": 1, "max_channels": 2, "cps_limit": 5}'

# 2. Make 3 simultaneous calls
# - First 2 should connect
# - Third should receive 486 Busy Here

# 3. Verify Redis channel counter
redis-cli GET trunk:1:channels
```

---

## VCenter VM Deployment

### VM Requirements
- **OS**: Ubuntu 24.04 LTS or Debian 12
- **CPU**: 4+ vCPUs
- **RAM**: 8+ GB
- **Disk**: 50+ GB SSD
- **Network**: Public IP or NAT with port forwarding for SIP (5060/5061)

### Deployment Steps

```bash
# 1. Install Docker on VM
sudo apt update
sudo apt install -y docker.io docker-compose-v2
sudo usermod -aG docker $USER

# 2. Clone repository
git clone <repo> /opt/voip-platform
cd /opt/voip-platform

# 3. Configure environment
cp .env.example .env
# Edit .env with production values

# 4. Build and start containers
docker compose build
docker compose up -d

# 5. Verify all services running
docker compose ps

# 6. Check logs
docker compose logs -f freeswitch
docker compose logs -f api

# 7. Run health checks
curl http://localhost:8000/health
```

### Firewall Configuration
```bash
# Required ports
sudo ufw allow 5060/udp   # SIP UDP
sudo ufw allow 5060/tcp   # SIP TCP
sudo ufw allow 5061/tcp   # SIP TLS
sudo ufw allow 8000/tcp   # API
sudo ufw allow 16384:16484/udp  # RTP range
```

---

## Success Criteria

| Test | Pass Criteria |
|------|---------------|
| RCF Call | Inbound call to DID forwards to configured number within 2 seconds |
| API Outbound | API call initiates outbound call, webhook receives events |
| Webhook Control | Webhook response controls call flow (play, gather, dial) |
| CDR Generation | CDR written to PostgreSQL within 5 seconds of call end |
| Call Rating | CDR contains correct rate and total_cost based on destination |
| Balance Update | Customer balance decremented after rated call |
| Fraud Block | Calls to blocked prefixes rejected with proper hangup cause |
| Channel Limit | Calls beyond trunk limit receive 486 response |
| Velocity Limit | Rapid calls beyond limit are blocked |

---

## Next Steps After This Document

1. Review and approve this plan
2. Create the directory structure
3. Begin Phase 1 implementation
4. Set up CI/CD for container builds (optional)
