# Custom VoIP Platform — Deployment Guide

## Overview

This document covers deploying the Custom VoIP platform to both **GCP Compute Engine** and **VMware vCenter** environments. The platform runs as a Docker Compose stack with 11 services handling SIP signaling, media processing, REST API, web UI, and SIP monitoring.

The same Docker Compose configuration works in both environments. The only differences are network configuration (public IP, NAT handling) and the base OS provisioning steps.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                  VM (Docker Host) — Host Networking                  │
│                                                                      │
│  ┌────────────┐    ┌──────────────┐                                  │
│  │  Kamailio  │───▶│  FreeSWITCH  │  ← Both use host networking     │
│  │  SBC/SIP   │    │  B2BUA/RTP   │    (no Docker NAT overhead)      │
│  │  :5060     │    │  :5080/:5090 │                                  │
│  └────────────┘    │  :8021 (ESL) │                                  │
│                    │  :8082 (WS)  │                                  │
│                    │  :16384-18383│                                  │
│                    └──────────────┘                                  │
│                           │                                          │
│  ┌────────────────────────┼──────────────────────────────────────┐  │
│  │       Docker Bridge Network (172.28.0.0/16)                   │  │
│  │                        │                                      │  │
│  │  ┌──────────┐  ┌──────┴─────┐  ┌──────────┐  ┌────────────┐ │  │
│  │  │PostgreSQL│  │  FastAPI   │  │  Redis   │  │  Nginx UI  │ │  │
│  │  │+PgBouncer│  │  REST API  │  │  Cache   │  │  React SPA │ │  │
│  │  │:5432/6432│  │  :8000     │  │  :6379   │  │  :80       │ │  │
│  │  └──────────┘  └────────────┘  └──────────┘  └────────────┘ │  │
│  │                                                               │  │
│  │  ┌──────────────────────────────────────────────────────────┐ │  │
│  │  │  Homer Stack: homer-db :5432, heplify :9060, webapp :80  │ │  │
│  │  └──────────────────────────────────────────────────────────┘ │  │
│  │                                                               │  │
│  │  ┌──────────────┐  ┌──────────────┐                           │  │
│  │  │ Webhook Test │  │  SIPp Load   │                           │  │
│  │  │  :9000       │  │  Test :8001  │                           │  │
│  │  └──────────────┘  └──────────────┘                           │  │
│  └───────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

**Key design decisions:**
- FreeSWITCH and Kamailio use **host networking** — eliminates Docker port mapping for RTP, preserves real source IPs for SIP security
- All other services use the Docker bridge network and communicate via service names
- FreeSWITCH connects to Postgres/Redis via `127.0.0.1` (host ports), not Docker DNS

---

## Services

| Service | Image/Build | Host Port | Purpose |
|---------|-------------|-----------|---------|
| PostgreSQL + PgBouncer | `timescale/timescaledb:pg16` + custom | 5432, 6432 | Voice DB, CDR hypertables, connection pooling |
| Redis | `redis:7-alpine` + custom config | 6380 | Caching, velocity tracking, channel acquisition |
| FreeSWITCH | Built from source (Debian bookworm) | 5060, 5080, 5090, 8021, 8082, 16384-18383/udp | SIP B2BUA, RTP media, Verto WebRTC, conferencing |
| Kamailio | `kamailio:5.8` (Debian bookworm) | 5060, 5061 | SBC — rate limiting, topology hiding, carrier routing |
| FastAPI | Python 3.12 + uvicorn | 8088 | REST API, provisioning, CDR queries, WebSocket |
| Nginx UI | nginx:alpine + React build + Homer | 8080 | Web UI, API proxy, Homer SIP capture proxy |
| Homer DB | `postgres:14-alpine` | — | SIP packet capture storage |
| Heplify Server | `ghcr.io/sipcapture/heplify-server` | 9060, 9061 | HEP packet collector |
| Homer Webapp | `ghcr.io/sipcapture/homer-app` | 9080 | SIP capture analysis UI |
| Webhook Test | Python 3.12 + Flask | 9000 | Mock webhook for API calling tests |
| SIPp | Python 3.12 + sip-tester | — | Load testing microservice |

---

## Resource Requirements

### Minimum VM Specs

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 8 vCPUs | 12+ vCPUs |
| RAM | 12 GB | 16 GB |
| Disk | 50 GB SSD | 100 GB SSD (thin-provisioned OK) |
| Network | 1 NIC with routable IP | 1 NIC with static public IP |

### Per-Service Resource Limits (from docker-compose.yml)

| Service | CPU Limit | Memory Limit | CPU Reserve | Memory Reserve |
|---------|-----------|--------------|-------------|----------------|
| FreeSWITCH | 4 | 4 GB | 2 | 2 GB |
| Kamailio | 2 | 512 MB | 0.5 | 128 MB |
| FastAPI | 2 | 1 GB | 0.5 | 256 MB |
| PostgreSQL | 1 | 1 GB | 0.5 | 256 MB |
| Redis | 1 | 2 GB | 0.5 | 512 MB |
| SIPp | 2 | 512 MB | — | — |
| Nginx UI | 0.5 | 128 MB | — | — |
| Webhook Test | 0.5 | 128 MB | — | — |

**Total reserved:** ~6 vCPUs, ~3.5 GB RAM
**Total limits:** ~13 vCPUs, ~10 GB RAM (not all services peak simultaneously)

---

## Environment Variables

Create a `.env` file in the repo root. Only the deployment-specific variables need customization:

```bash
# ─── Network (MUST CHANGE per deployment) ─────────────────────────
# Set to the VM's public/routable IP address
EXTERNAL_SIP_IP=<PUBLIC_IP>
EXTERNAL_RTP_IP=<PUBLIC_IP>
VERTO_WS_URL=ws://<PUBLIC_IP>:8082
SIP_DOMAIN=voiceplatform.local

# ─── Mode ─────────────────────────────────────────────────────────
# true = plays tone for test calls (no carrier needed)
# false = routes to real carriers (Bandwidth)
TEST_MODE=true

# ─── Database (defaults are fine for single-VM deployments) ───────
POSTGRES_DB=voip
POSTGRES_USER=voip
POSTGRES_PASSWORD=voip_secret

# ─── Bandwidth Carrier Integration (production only) ─────────────
BANDWIDTH_API_CLIENT_ID=
BANDWIDTH_API_CLIENT_SECRET=
BANDWIDTH_ACCOUNT_ID=9900717
BANDWIDTH_SIP_PEER_ID=1162116

# ─── FreeSWITCH ESL ──────────────────────────────────────────────
FREESWITCH_ESL_PASSWORD=ClueCon
```

---

## Firewall / Port Requirements

Open these ports on the VM's firewall (GCP firewall rules or vCenter NSX/iptables):

| Port | Protocol | Direction | Purpose |
|------|----------|-----------|---------|
| 5060 | UDP + TCP | Inbound | SIP signaling (Kamailio SBC) |
| 5061 | TCP | Inbound | SIP TLS (optional) |
| 8082 | TCP | Inbound | WebRTC/Verto WebSocket |
| 16384-18383 | UDP | Inbound | RTP media (FreeSWITCH) |
| 8080 | TCP | Inbound | Web UI (Nginx) |
| 8088 | TCP | Inbound | REST API (FastAPI) |
| 9080 | TCP | Inbound | Homer SIP capture UI |
| 9060 | UDP + TCP | Inbound | HEP capture (Heplify) |

**Outbound:** Allow all (needed for carrier SIP, Bandwidth API, package repos).

---

## Deployment: GCP Compute Engine

### 1. Create the VM

```bash
gcloud compute instances create custom-voip \
  --zone=us-east1-b \
  --machine-type=e2-standard-8 \
  --boot-disk-size=100GB \
  --boot-disk-type=pd-ssd \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --tags=voip-server
```

### 2. Create firewall rules

```bash
gcloud compute firewall-rules create voip-sip \
  --allow=udp:5060,tcp:5060,tcp:5061 \
  --target-tags=voip-server \
  --description="SIP signaling"

gcloud compute firewall-rules create voip-rtp \
  --allow=udp:16384-18383 \
  --target-tags=voip-server \
  --description="RTP media"

gcloud compute firewall-rules create voip-web \
  --allow=tcp:8080,tcp:8082,tcp:8088,tcp:9080 \
  --target-tags=voip-server \
  --description="Web UI, WebRTC, API, Homer"

gcloud compute firewall-rules create voip-hep \
  --allow=udp:9060,tcp:9060,tcp:9061 \
  --target-tags=voip-server \
  --description="HEP SIP capture"
```

### 3. Install Docker and deploy

```bash
# SSH into the VM
gcloud compute ssh custom-voip --zone=us-east1-b

# Install Docker
sudo apt update && sudo apt install -y docker.io docker-compose-plugin git
sudo systemctl enable docker

# Clone and deploy
sudo git clone https://github.com/Keegs2/custom-voip.git /opt/revup
cd /opt/revup

# Get the VM's external IP
EXTERNAL_IP=$(curl -s http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip -H "Metadata-Flavor: Google")

# Create .env
sudo tee .env << EOF
EXTERNAL_SIP_IP=${EXTERNAL_IP}
EXTERNAL_RTP_IP=${EXTERNAL_IP}
VERTO_WS_URL=ws://${EXTERNAL_IP}:8082
SIP_DOMAIN=voiceplatform.local
TEST_MODE=true
FREESWITCH_ESL_PASSWORD=ClueCon
EOF

# Build and start
sudo docker compose build
sudo docker compose up -d

# Verify
sudo docker compose ps
```

### GCE-specific: NAT hairpin workaround

GCE uses 1:1 NAT — the public IP is not on the VM's interface. The FreeSWITCH `entrypoint.sh` automatically handles this by adding the public IP to the loopback interface:

```bash
ip addr add ${EXTERNAL_SIP_IP}/32 dev lo
```

This runs automatically on container start. It requires the `NET_ADMIN` capability (already set in docker-compose.yml). No manual action needed.

---

## Deployment: VMware vCenter

### 1. Create the VM

- **ISO:** Debian 12 (Bookworm) netinst — `debian-12.9.0-amd64-netinst.iso`
  Download: https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/
- **vCPUs:** 8+ (12 recommended)
- **RAM:** 16 GB
- **Disk:** 100 GB thin-provisioned (LSI Logic SAS or VMware Paravirtual)
- **Network:** 1 VMXNET3 NIC on a port group with routable IP access
- **Guest OS type:** Debian 12 (64-bit)

### 2. Install Debian

During the Debian installer:
- Choose minimal install (no desktop, no print server)
- Select SSH server and standard system utilities
- Set hostname (e.g., `custom-voip`)
- Configure static IP if required by your network

### 3. Post-install: Docker and deploy

```bash
# Install Docker (as root or with sudo)
apt update && apt install -y ca-certificates curl gnupg git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt update && apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Clone and deploy
git clone https://github.com/Keegs2/custom-voip.git /opt/revup
cd /opt/revup

# Create .env — replace <PUBLIC_IP> with the VM's routable IP
cat > .env << 'EOF'
EXTERNAL_SIP_IP=<PUBLIC_IP>
EXTERNAL_RTP_IP=<PUBLIC_IP>
VERTO_WS_URL=ws://<PUBLIC_IP>:8082
SIP_DOMAIN=voiceplatform.local
TEST_MODE=true
FREESWITCH_ESL_PASSWORD=ClueCon
EOF

# Build all containers (first build takes 10-15 minutes)
docker compose build

# Start the stack
docker compose up -d

# Verify all services are running
docker compose ps
```

### 4. vCenter-specific: NAT considerations

**If the VM has a directly assigned public IP (no NAT):**
- The `entrypoint.sh` loopback workaround is harmless but unnecessary
- Set `EXTERNAL_SIP_IP` and `EXTERNAL_RTP_IP` to the VM's IP
- Everything works out of the box

**If the VM is behind NAT (private IP, NAT to public):**
- The same GCE hairpin workaround applies — `entrypoint.sh` adds the public IP to loopback automatically
- Set `EXTERNAL_SIP_IP` and `EXTERNAL_RTP_IP` to the **public** (post-NAT) IP
- Ensure the NAT device forwards all required ports (SIP, RTP range, Web)
- The NAT device must support **symmetric RTP** or **full cone NAT** for media to work

**If there is no public IP (internal-only deployment):**
- Set `EXTERNAL_SIP_IP` and `EXTERNAL_RTP_IP` to the VM's private IP
- SIP peers (PBXes, softphones) must be on the same network or reachable via routing
- Carrier integration (Bandwidth) will not work without a public IP

### 5. vCenter firewall (iptables)

If the VM uses iptables directly (no NSX):

```bash
# SIP
iptables -A INPUT -p udp --dport 5060 -j ACCEPT
iptables -A INPUT -p tcp --dport 5060 -j ACCEPT
iptables -A INPUT -p tcp --dport 5061 -j ACCEPT

# WebRTC
iptables -A INPUT -p tcp --dport 8082 -j ACCEPT

# RTP
iptables -A INPUT -p udp --dport 16384:18383 -j ACCEPT

# Web UI, API, Homer
iptables -A INPUT -p tcp --dport 8080 -j ACCEPT
iptables -A INPUT -p tcp --dport 8088 -j ACCEPT
iptables -A INPUT -p tcp --dport 9080 -j ACCEPT

# HEP capture
iptables -A INPUT -p udp --dport 9060 -j ACCEPT
iptables -A INPUT -p tcp --dport 9060 -j ACCEPT
iptables -A INPUT -p tcp --dport 9061 -j ACCEPT

# Save
iptables-save > /etc/iptables/rules.v4
```

---

## Database Initialization

On first start, PostgreSQL runs all SQL scripts in `/docker/postgres/init/` alphabetically:

| Script | Purpose |
|--------|---------|
| 01_extensions.sql | TimescaleDB, pg_stat_statements; creates freeswitch/api DB users |
| 02_schema_core.sql | customers, rcf_numbers, sip_trunks, trunk_dids, trunk_auth_ips, rates |
| 03_schema_api.sql | API calling: api_credentials, api_dids, api_call_logs |
| 04_schema_fraud.sql | Fraud prefixes, velocity tables, block lists |
| 05_schema_cdr.sql | CDR hypertable (TimescaleDB), partitioned by day |
| 06_seed_data.sql | Demo customers, RCF numbers, rate tables |
| 07_cps_tiers.sql | CPS rate limiting tiers |
| 08_carrier_gateways.sql | Carrier trunk definitions |
| 09_schema_users.sql | User authentication, RBAC (admin/user roles) |
| 10_schema_ucaas.sql | Extensions, voicemail, call queues, presence |
| 11_schema_chat.sql | Chat conversations, messages, attachments |
| 11a-d | DID assignment, UCaaS type refinements |
| 12_multi_tenant_extensions.sql | Per-customer extension isolation |
| 13_schema_conferencing.sql | Conference rooms, schedules, participants |
| 14_granite_accounts.sql | Granite Telephony account setup |
| 15_schema_documents.sql | Document sharing metadata |
| 16_cdr_detail_columns.sql | CDR enrichment columns |
| 17_account_cleanup.sql | Demo account restructuring |

These only run on a **fresh** database (empty `postgres_data` volume). To re-initialize:

```bash
docker compose down
docker volume rm revup_postgres_data
docker compose up -d
```

---

## Startup Order and Health Checks

Docker Compose enforces this dependency chain:

```
PostgreSQL ──(healthy)──▶ FreeSWITCH ──▶ Kamailio
     │                         │
     ├──(healthy)──▶ FastAPI ──▶ Nginx UI
     │
Redis ──(healthy)──▶ FreeSWITCH
     │
     └──(healthy)──▶ FastAPI

Homer DB ──(healthy)──▶ Heplify Server
     │
     └──(healthy)──▶ Homer Webapp
```

| Service | Health Check | Interval | Retries |
|---------|-------------|----------|---------|
| PostgreSQL | `pg_isready -U voip -d voip` | 5s | 10 |
| Redis | `redis-cli ping` | 5s | 5 |
| FreeSWITCH | `fs_cli -x "status"` | 30s | 3 |
| Kamailio | `kamcmd core.uptime` | 30s | 3 |
| Homer DB | `psql -h localhost -U root -c '\l'` | 2s | 30 |

---

## Post-Deployment Verification

After all services are running, verify the stack:

```bash
# 1. Check all containers are healthy
docker compose ps

# 2. API health check
curl http://localhost:8088/health

# 3. Get an admin token
TOKEN=$(curl -s http://localhost:8088/auth/login -H "Content-Type: application/json" -d '{"email":"admin@customvoip.com","password":"admin123"}' | jq -r '.access_token')

# 4. List customers
curl -s http://localhost:8088/customers -H "Authorization: Bearer $TOKEN" | jq

# 5. Check Bandwidth TN inventory (if credentials configured)
curl -s http://localhost:8088/numbers/stats -H "Authorization: Bearer $TOKEN" | jq

# 6. FreeSWITCH status
docker exec voip-freeswitch fs_cli -x "sofia status"

# 7. Kamailio status
docker exec voip-kamailio kamcmd core.uptime

# 8. Web UI
# Open http://<PUBLIC_IP>:8080 in a browser
# Login: admin@customvoip.com / admin123

# 9. Homer SIP capture
# Open http://<PUBLIC_IP>:9080 in a browser
# Login: admin / sipcapture
```

---

## Updating the Platform

The deployment workflow is the same for both GCP and vCenter:

```bash
cd /opt/revup

# Pull latest code
git pull

# Rebuild only changed services (Docker layer caching makes this fast)
docker compose build

# Restart with new images
docker compose up -d

# For API-only changes (no Docker rebuild needed — code is bind-mounted in dev):
docker compose restart api
```

**Note:** The UI container requires a full rebuild (`docker compose build ui`) because the React app is compiled into the Docker image at build time. The API container in dev mode uses `--reload` with a bind-mounted source directory, so code changes take effect on save.

---

## Kernel Tuning (Optional, recommended for production)

For high call volumes (100+ concurrent calls), apply these sysctl settings on the host:

```bash
# /etc/sysctl.d/99-voip.conf

# Network buffers
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.core.rmem_default = 1048576
net.core.wmem_default = 1048576
net.core.netdev_max_backlog = 65536
net.core.somaxconn = 65535

# TCP tuning
net.ipv4.tcp_max_syn_backlog = 65536
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_intvl = 15
net.ipv4.tcp_keepalive_probes = 5

# UDP buffer for RTP
net.ipv4.udp_mem = 65536 131072 262144
net.ipv4.udp_rmem_min = 16384
net.ipv4.udp_wmem_min = 16384

# Connection tracking (for Docker NAT)
net.netfilter.nf_conntrack_max = 262144

# Apply
sysctl --system
```

---

## Default Credentials

| Service | Username | Password | Notes |
|---------|----------|----------|-------|
| Web UI (admin) | admin@customvoip.com | admin123 | Full admin access |
| Web UI (support) | support@granite.com | admin123 | Granite Telephony user |
| PostgreSQL | voip | voip_secret | Main database |
| PostgreSQL (FS) | freeswitch | fs_secret | FreeSWITCH read-only |
| PostgreSQL (API) | api | api_secret | API service |
| Redis | — | — | No auth (internal only) |
| FreeSWITCH ESL | — | ClueCon | Event Socket |
| Homer | admin | sipcapture | SIP capture UI |

**Change all passwords before exposing to any network beyond the lab.**

---

## Troubleshooting

### No audio on calls
- Verify RTP ports (16384-18383/udp) are open in firewall
- Check `EXTERNAL_RTP_IP` matches the VM's public/routable IP
- On GCE: verify `ip addr show lo` includes the public IP

### SIP registration fails
- Check Kamailio is running: `docker exec voip-kamailio kamcmd core.uptime`
- Check FreeSWITCH profiles: `docker exec voip-freeswitch fs_cli -x "sofia status"`
- Verify port 5060 is reachable: `nc -zvu <PUBLIC_IP> 5060`

### Calls disconnect after 28-32 seconds
- ACK routing issue — the public IP is not looped back locally
- Verify: `ip addr show lo | grep <PUBLIC_IP>`
- If missing, restart FreeSWITCH: `docker compose restart freeswitch`

### Web UI shows old content after update
- The UI is compiled into the Docker image
- Must rebuild: `docker compose build ui && docker compose up -d ui`

### API returns 502 on Bandwidth endpoints
- Check credentials in .env: `grep BANDWIDTH .env`
- Test token: `curl -s -X POST https://api.bandwidth.com/api/v1/oauth2/token -u "$CLIENT_ID:$CLIENT_SECRET" -d "grant_type=client_credentials" | jq`
- Clear Redis cache: `docker exec voip-redis redis-cli DEL bandwidth:tns`

### Container won't start (health check failing)
- Check logs: `docker compose logs <service> --tail 50`
- Database not ready: `docker compose restart <service>` (health checks will retry)
- Port conflict: another process on the host using the same port
