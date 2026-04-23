# GCP Production Deployment Plan — RCF-V1

## Architecture: 4 VMs (1 existing + 3 new)

```
                    ┌─────────────────────────┐
                    │    Bandwidth Carrier     │
                    │  67.231.x.x / 216.82.x.x│
                    └───────┬─────────┬───────┘
                            │         │
              ┌─────────────┴───┐ ┌───┴──────────────┐
              │  EXISTING VM    │ │  NEW VM1          │
              │  34.74.71.32    │ │  KAM-G2           │
              │  KAM-G1 (SBC)  │ │  SBC              │
              │  :5060          │ │  :5060            │
              │  Already with   │ │  New static IP    │
              │  Bandwidth      │ │  Add to Bandwidth │
              └────────┬────────┘ └────────┬──────────┘
                       │                   │
                       └─────────┬─────────┘
                                 │ dispatch
                    ┌────────────┴────────────┐
                    │  NEW VM2: FreeSWITCH    │
                    │  e2-standard-8          │
                    │  + Redis (local)        │
                    │  Internal: 10.142.0.20  │
                    │  Public IP for RTP      │
                    └────────────┬────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │  NEW VM3: Services      │
                    │  e2-standard-4          │
                    │  PostgreSQL + PgBouncer  │
                    │  FastAPI + UI (nginx)   │
                    │  Homer stack            │
                    │  Internal: 10.142.0.30  │
                    │  Public IP (for UI/API) │
                    └─────────────────────────┘
```

## VM Inventory

| VM | IP | Role | Machine Type | What Runs |
|---|---|---|---|---|
| Existing (poc-custom-voip) | 34.74.71.32 (public) + 10.142.0.100 (internal) | KAM-G1 — SBC only | e2-standard-4 (downsize) | Kamailio + heplify agent |
| VM1 (new) | New static public IP + 10.142.0.11 | KAM-G2 — SBC | e2-standard-4 | Kamailio + heplify agent |
| VM2 (new) | New static public IP + 10.142.0.20 | Media Server | e2-standard-8 | FreeSWITCH + Redis |
| VM3 (new) | New static public IP + 10.142.0.30 | Data + Services | e2-standard-4 | PostgreSQL + PgBouncer + FastAPI + UI + Homer |

## Compose Files

Each VM gets its own compose file:

- `docker-compose.sbc.yml` — Kamailio only (existing VM + VM1)
- `docker-compose.media.yml` — FreeSWITCH + Redis (VM2)
- `docker-compose.services.yml` — API + UI + Homer stack (VM3)
- PostgreSQL installed bare on VM3 (not Docker, for data safety)

## Network Design

- VPC: existing `default` VPC in us-east1-b
- All VMs in same subnet (10.142.0.0/20)
- Internal communication via private IPs
- SBCs and FS need public IPs for SIP/RTP
- DB VM internal only (no public IP)

## Firewall Rules

| Rule | Source | Ports | Target VMs |
|---|---|---|---|
| sip-inbound | Bandwidth IPs (67.231.0.0/16, 216.82.224.0/19) | 5060/udp+tcp | Existing, VM1 |
| rtp-inbound | 0.0.0.0/0 | 16384-49151/udp | VM2 |
| web-admin | Office IPs | 8080, 8443, 9080 | VM3 |
| api-access | Office IPs | 8088 | VM3 |
| internal-sip | 10.142.0.0/20 | 5060-5090/udp+tcp | VM2 |
| internal-esl | 10.142.0.0/20 | 8021/tcp | VM2 |
| internal-db | 10.142.0.0/20 | 5432, 6432 | VM3 |
| internal-redis | 10.142.0.0/20 | 6379 | VM2 |
| internal-hep | 10.142.0.0/20 | 9060/udp+tcp, 9061/tcp | VM3 |
| internal-api | 10.142.0.0/20 | 8000, 8088 | VM3 |

## Kamailio Dispatcher Config

### Existing VM (KAM-G1) — dispatcher.list:
```
# Group 1: FreeSWITCH on VM2
1 sip:10.142.0.20:5080 0 0 weight=100;maxload=10000;duid=fs-gcp

# Group 2: Bandwidth Dallas
2 sip:67.231.2.12:5060 0 0 weight=100;duid=bw-dallas

# Group 3: Bandwidth LA
3 sip:216.82.238.134:5060 0 0 weight=100;duid=bw-la
```

### VM1 (KAM-G2) — identical dispatcher.list (same FS target)

### Kamailio substdef per SBC:
```
# Existing VM (KAM-G1):
#!substdef "!ADVERTISE_IP!34.74.71.32!g"
#!define INTERNAL_IP 10.142.0.100

# VM1 (KAM-G2):
#!substdef "!ADVERTISE_IP!<VM1_PUBLIC_IP>!g"
#!define INTERNAL_IP 10.142.0.11
```

## FreeSWITCH Config (VM2)

- `EXTERNAL_SIP_IP=<VM2_PUBLIC_IP>`
- `EXTERNAL_RTP_IP=<VM2_PUBLIC_IP>`
- `DB_HOST=10.142.0.30` (VM3 PostgreSQL via PgBouncer)
- `DB_PORT=6432` (PgBouncer)
- `REDIS_HOST=127.0.0.1` (local Redis)
- `REDIS_PORT=6379`
- `API_HOST=10.142.0.30`
- `API_PORT=8000`
- Entrypoint: adds public IP to loopback (GCE NAT)

## PostgreSQL Config (VM3, bare install)

- PostgreSQL 16 + TimescaleDB extension
- PgBouncer in transaction mode (pool_size=200)
- Listen on 10.142.0.30:5432 (PG direct) and :6432 (PgBouncer)
- Users: voip (owner), api (read/write), freeswitch (read-only)
- Data directory: /var/lib/postgresql/data on 200GB SSD
- Automated daily backups to GCS bucket
- Patroni-ready: install but run standalone until CHI/DAL

## API + UI Config (VM3)

- `DATABASE_URL=postgresql://api:api_secret@127.0.0.1:6432/voip` (local PgBouncer)
- `REDIS_URL=redis://10.142.0.20:6379` (VM2 Redis)
- `FREESWITCH_ESL_HOST=10.142.0.20`
- Bandwidth env vars for TN inventory
- UI served on :8080 (HTTP) and :8443 (HTTPS)
- Homer webapp on :9080

## Migration Phases

### Phase 1: Build New VMs (no disruption)
1. Create VM1, VM2, VM3 in same VPC
2. Assign static IPs to VM1 and VM2
3. Install Docker on VM1, VM2, VM3
4. Install PostgreSQL 16 + TimescaleDB bare on VM3
5. Migrate database: pg_dump from existing VM → pg_restore on VM3
6. Deploy FreeSWITCH + Redis on VM2 via docker-compose.media.yml
7. Deploy API + UI + Homer on VM3 via docker-compose.services.yml
8. Internal testing: verify FS on VM2 can route calls via VM3 DB

### Phase 2: Cut Over SBCs (brief ~2 second disruption)
9. Update existing VM Kamailio dispatcher: local FS → VM2 FS (10.142.0.20:5080)
10. Reload Kamailio: `kamcmd dispatcher.reload`
11. Test live call: existing KAM → VM2 FS → VM3 DB → Bandwidth
12. Stop non-Kamailio services on existing VM (FS, PG, Redis, API, UI, Homer)
13. Existing VM is now a dedicated SBC

### Phase 3: Add Second SBC (no disruption)
14. Deploy Kamailio on VM1 via docker-compose.sbc.yml
15. Whitelist VM1 public IP with Bandwidth (secondary)
16. Test: call routes through VM1 → VM2 FS
17. Both SBCs active — Bandwidth sends to both IPs

### Phase 4: Cleanup
18. Downsize existing VM to e2-standard-4
19. Remove unused Docker images/volumes from existing VM
20. Update monitoring/alerting for all 4 VMs
21. Document the final architecture and runbook

## Rollback Plan

At any phase, roll back by:
1. Pointing existing VM Kamailio back to local FS
2. Restarting all services on existing VM
3. Existing VM returns to single-VM mode

## Bandwidth Integration

- **Existing IP (34.74.71.32):** Already whitelisted, stays as primary SBC
- **VM1 IP:** Add to Bandwidth SIP Peer as secondary (Priority 2)
- **VM2 IP:** Not needed in Bandwidth — FS talks to Bandwidth via KAM SBCs
- **DID routing:** All DIDs to both SBC IPs, priority ordering

## Environment Files

### .env.sbc (existing VM + VM1)
```
EXTERNAL_SIP_IP=<this_vm_public_ip>
```

### .env.media (VM2)
```
EXTERNAL_SIP_IP=<vm2_public_ip>
EXTERNAL_RTP_IP=<vm2_public_ip>
DB_HOST=10.142.0.30
DB_PORT=6432
DB_NAME=voip
DB_USER=freeswitch
DB_PASS=<strong_password>
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
API_HOST=10.142.0.30
API_PORT=8000
TEST_MODE=false
```

### .env.services (VM3)
```
DATABASE_URL=postgresql://api:<strong_password>@127.0.0.1:6432/voip
REDIS_URL=redis://10.142.0.20:6379
FREESWITCH_ESL_HOST=10.142.0.20
FREESWITCH_ESL_PORT=8021
FREESWITCH_ESL_PASSWORD=<strong_password>
BANDWIDTH_API_CLIENT_ID=CLI-8cab93d7-e797-4d7d-8717-45aa430c7185
BANDWIDTH_API_CLIENT_SECRET=<from_vault>
BANDWIDTH_ACCOUNT_ID=9900717
BANDWIDTH_SIP_PEER_ID=1162116
TEST_MODE=false
```
