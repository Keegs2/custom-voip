# GCP Production Deployment Plan — RCF-V1

## Architecture: 4 VMs + Shared VIP via GCP Network Load Balancer

```
                    ┌──────────────────────────────┐
                    │       Bandwidth Carrier       │
                    │   Whitelists ONE IP:          │
                    │   34.24.133.82 (VIP)        │
                    │   67.231.x.x / 216.82.x.x    │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────┴───────────────┐
                    │   GCP Network Load Balancer   │
                    │   34.24.133.82 (VIP)        │
                    │   UDP/TCP :5060 passthrough   │
                    │   Session affinity: CLIENT_IP │
                    │   Health: TCP 5060 / 5s       │
                    │   Failover: <10 seconds       │
                    └───────┬──────────────┬───────┘
                            │              │
              ┌─────────────┴───┐  ┌───────┴──────────┐
              │  poc-custom-voip│  │  kam-g2           │
              │  KAM-G1 (SBC)  │  │  KAM-G2 (SBC)    │
              │  34.74.71.32   │  │  35.243.136.35    │
              │  10.142.0.100  │  │  10.142.0.101     │
              │  Advertises:   │  │  Advertises:      │
              │  34.24.133.82│  │  34.24.133.82   │
              └────────┬───────┘  └────────┬──────────┘
                       │                   │
                       └─────────┬─────────┘
                                 │ dispatch to FS
                    ┌────────────┴────────────┐
                    │  fs-media               │
                    │  FreeSWITCH + Redis     │
                    │  34.139.119.135         │
                    │  10.142.0.102           │
                    │  :5080/:5090 (SIP)      │
                    │  :16384-49151 (RTP)     │
                    │  :8021 (ESL)            │
                    │  :6379 (Redis local)    │
                    └────────────┬────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │  services               │
                    │  PostgreSQL (bare)       │
                    │  + PgBouncer :6432       │
                    │  FastAPI :8088           │
                    │  UI (nginx) :8080/:8443  │
                    │  Homer stack :9080       │
                    │  34.26.57.37            │
                    │  10.142.0.103           │
                    └─────────────────────────┘
```

---

## IP Assignment

| VM | Internal IP | External IP | Role | Compose File |
|---|---|---|---|---|
| poc-custom-voip | 10.142.0.100 | 34.74.71.32 | KAM-G1 (SBC) | docker-compose.sbc.yml |
| kam-g2 | 10.142.0.101 | 35.243.136.35 | KAM-G2 (SBC) | docker-compose.sbc.yml |
| fs-media | 10.142.0.102 | 34.139.119.135 | FreeSWITCH + Redis | docker-compose.media.yml |
| services | 10.142.0.103 | 34.26.57.37 | PG + API + UI + Homer | docker-compose.services.yml |
| **VIP (NLB)** | — | **34.24.133.82** | SBC floating IP | GCP Network LB |

---

## GCP Network Load Balancer (VIP)

Both SBCs are behind a GCP External Passthrough Network Load Balancer. This replaces
traditional keepalived/VRRP (which doesn't work on GCP due to multicast blocking).

- **Frontend:** 34.24.133.82 (VIP) — the ONLY IP Bandwidth needs
- **Backend:** Instance group containing poc-custom-voip + kam-g2
- **Protocol:** UDP + TCP on port 5060
- **Session affinity:** CLIENT_IP — ensures all SIP from the same Bandwidth gateway hits the same SBC
- **Health check:** TCP 5060, interval 5s, unhealthy after 3 failures (15s failover)
- **Both SBCs advertise the VIP** (34.24.133.82) in SIP headers via EXTERNAL_SIP_IP env var

### Failover behavior
1. KAM-G1 dies → NLB detects in 15 seconds (3 × 5s health probes)
2. All new SIP traffic routes to KAM-G2 automatically
3. Active calls on KAM-G1 are lost (SIP calls cannot be migrated)
4. KAM-G1 recovers → NLB adds it back after 2 healthy probes (10s)

### NLB Components
```
Health Check:    sbc-health-check (TCP 5060, 5s interval, 3 threshold)
Backend Service: sbc-backend (UDP, CLIENT_IP affinity, EXTERNAL LB)
Instance Group:  sbc-group (poc-custom-voip + kam-g2)
Forwarding Rule: sbc-vip-udp (34.24.133.82, UDP:5060)
Forwarding Rule: sbc-vip-tcp (34.24.133.82, TCP:5060)
```

---

## Firewall Rules

| Rule | Source | Ports | Target Tags |
|---|---|---|---|
| voip-sip-inbound | 67.231.0.0/16, 216.82.224.0/19 | udp:5060, tcp:5060 | voip-sbc |
| voip-health-check | 35.191.0.0/16, 130.211.0.0/22 | tcp:5060 | voip-sbc |
| voip-rtp | 0.0.0.0/0 | udp:16384-49151 | voip-media |
| voip-web-admin | Office IP/32 (or 0.0.0.0/0 during setup) | tcp:8080,8443,8088,9080 | voip-services |
| voip-internal | voip-sbc, voip-media, voip-services tags | all tcp/udp/icmp | all voip tags |
| allow-ssh-iap | 35.235.240.0/20 | tcp:22 | all voip tags |

---

## Per-VM Environment Variables

### Both SBCs (.env on poc-custom-voip and kam-g2)
```
EXTERNAL_SIP_IP=34.24.133.82      # VIP — both SBCs advertise the SAME IP
FREESWITCH_IP=10.142.0.102          # VM2 internal
DB_HOST=10.142.0.103                # VM3 internal
DB_PORT=6432                        # PgBouncer
DB_USER=freeswitch
DB_PASS=<STRONG_FS_DB_PASSWORD>
HOMER_IP=10.142.0.103               # VM3 internal
```

### fs-media (.env)
```
EXTERNAL_SIP_IP=34.139.119.135      # VM2 public (for SDP/RTP)
EXTERNAL_RTP_IP=34.139.119.135
DB_HOST=10.142.0.103                # VM3 internal
DB_PORT=6432                        # PgBouncer
DB_NAME=voip
DB_USER=freeswitch
DB_PASS=<STRONG_FS_DB_PASSWORD>
REDIS_HOST=127.0.0.1                # Local Redis
REDIS_PORT=6379
API_HOST=10.142.0.103               # VM3 internal
API_PORT=8088                       # Host-mapped API port
HOMER_IP=10.142.0.103
SBC_PROXY_IP=10.142.0.100           # Primary SBC for outbound calls
ESL_PASSWORD=<STRONG_ESL_PASSWORD>
TEST_MODE=false
```

### services (.env)
```
JWT_SECRET_KEY=<64+ char random>
DATABASE_URL=postgresql://api:<API_DB_PASS>@127.0.0.1:6432/voip
REDIS_URL=redis://10.142.0.102:6379
FREESWITCH_ESL_HOST=10.142.0.102
FREESWITCH_ESL_PORT=8021
FREESWITCH_ESL_PASSWORD=<STRONG_ESL_PASSWORD>
CORS_ORIGINS=https://34.26.57.37:8443,http://34.26.57.37:8080
SBC_PROXY_IP=10.142.0.100
BANDWIDTH_API_CLIENT_ID=CLI-8cab93d7-e797-4d7d-8717-45aa430c7185
BANDWIDTH_API_CLIENT_SECRET=<from Bandwidth>
BANDWIDTH_ACCOUNT_ID=9900717
BANDWIDTH_SIP_PEER_ID=1162116
TEST_MODE=false
ENABLE_DOCS=true
HOMER_DB_PASS=<STRONG_HOMER_PASSWORD>
```

---

## Cross-VM Connectivity Map

| Source | Destination | Port | Purpose |
|---|---|---|---|
| Bandwidth → NLB | 34.24.133.82:5060 | UDP/TCP | Inbound SIP (NLB → healthy SBC) |
| SBCs → FS | 10.142.0.102:5080 | UDP | SIP dispatch (via dispatcher) |
| SBCs → FS | 10.142.0.102:5090 | UDP | In-dialog routing (WITHINDIALOG) |
| SBCs → DB | 10.142.0.103:6432 | TCP | Trunk auth IP lookup (sqlops) |
| SBCs → Homer | 10.142.0.103:9060 | UDP | HEP SIP capture |
| FS → SBC | 10.142.0.100:5060 | UDP | Outbound calls (bridge to carrier) |
| FS → DB | 10.142.0.103:6432 | TCP | Lua DID/customer lookups |
| FS → Redis | 127.0.0.1:6379 | TCP | Local cache (velocity, sessions) |
| FS → API | 10.142.0.103:8088 | TCP | xml_curl directory, CDR ingest |
| FS → Homer | 10.142.0.103:9060 | UDP | HEP SIP capture from sofia |
| API → DB | 127.0.0.1:6432 | TCP | PgBouncer (local on VM3) |
| API → Redis | 10.142.0.102:6379 | TCP | Cache, session state |
| API → FS ESL | 10.142.0.102:8021 | TCP | Call origination, status |
| GCP HC → SBCs | :5060 | TCP | NLB health probes |

---

## Deploy Commands Per VM

### VM3 (services) — deploy FIRST
```
# PostgreSQL bare install (one-time setup — see bootstrap section)
cd /opt/revup
sudo docker compose -f docker-compose.services.yml build
sudo docker compose -f docker-compose.services.yml up -d
```

### VM2 (fs-media) — deploy SECOND (needs DB on VM3)
```
cd /opt/revup
sudo docker compose -f docker-compose.media.yml build
sudo docker compose -f docker-compose.media.yml up -d
```

### Both SBCs — deploy LAST (needs FS on VM2)
```
cd /opt/revup
sudo docker compose -f docker-compose.sbc.yml build
sudo docker compose -f docker-compose.sbc.yml up -d
```

---

## Bandwidth Configuration

In Bandwidth Dashboard for account 9900717 / location 1162116:

**Replace:** 34.74.71.32 (old individual SBC IP)
**With:** 34.24.133.82 (VIP — single IP, both SBCs behind it)

---

## Verification Checklist

```bash
# SBCs — check dispatcher hits FS
sudo docker logs voip-kamailio --tail 5  # Should show OPTIONS 200 OK

# SBCs — check templating
sudo docker exec voip-kamailio grep "ADVERTISE_IP" /etc/kamailio/kamailio.cfg | head -1
# Should show: 34.24.133.82

sudo docker exec voip-kamailio cat /etc/kamailio/dispatcher.list | grep "sip:"
# Should show: 10.142.0.102:5080

# FS — check profiles
sudo docker exec voip-freeswitch /usr/local/freeswitch/bin/fs_cli -x "sofia status"

# Services — check health
curl -s http://localhost:8088/health

# NLB — check both backends healthy
gcloud compute backend-services get-health sbc-backend --region=us-east1

# Live call test
# Call +16174544217 → should forward to +17744045256
```

---

## Rollback Plan

If anything breaks, revert existing VM to standalone mode:
```
cd /opt/revup
sudo git checkout Full-System
sudo docker compose down
sudo docker compose build
sudo docker compose up -d
```

Update Bandwidth back to 34.74.71.32 (individual SBC IP).
