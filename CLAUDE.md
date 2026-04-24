# Custom VoIP Platform — RCF-V1

## What This Is

Production Remote Call Forwarding (RCF) platform built for Granite Telecommunications.
Nationwide utility company deployment — carrier-grade, no POC shortcuts.

**Branch:** `RCF-V1` (production). `Full-System` branch has the full UCaaS stack (WebRTC, voicemail, conferencing, chat) — not deployed in production.

## Architecture

4-VM deployment in GCP us-east1-b, expanding to 3 GCP zones. Each zone is self-contained for SIP/RTP — calls never cross zones.

```
Bandwidth Carrier (67.231.2.12 / 216.82.238.134)
    |
GCP Network Load Balancer (VIP: 34.24.133.82)
    |
+---+---+
|       |
SBC-1   SBC-2       (Kamailio — SIP routing, topology hiding, rate limiting)
|       |
+---+---+
    |
FreeSWITCH + Redis   (B2BUA — RCF call routing via Lua, RTP media relay)
    |
Services VM          (PostgreSQL + PgBouncer, FastAPI, React UI, Homer)
```

**Carrier:** Bandwidth — account 9900717, SIP peer 1162116, client CLI-8cab93d7-e797-4d7d-8717-45aa430c7185

## Key Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Local dev — all services on one machine |
| `docker-compose.sbc.yml` | Production SBC VM — Kamailio only |
| `docker-compose.media.yml` | Production media VM — FreeSWITCH + Redis |
| `docker-compose.services.yml` | Production services VM — API + UI + Homer |
| `GCP_DEPLOYMENT_PLAN.md` | Multi-zone GCP architecture, IPs, NLB config, env vars |
| `PRODUCTION_ARCHITECTURE.md` | Full system design doc (capacity planning, scaling) |

## Component Map

| Directory | What | Expert Agent | CLAUDE.md |
|-----------|------|-------------|-----------|
| `docker/kamailio/` | SBC — SIP signaling, carrier routing | telephony-systems-expert | Yes |
| `docker/freeswitch/` | Media server — RCF call routing, RTP | telephony-systems-expert | Yes |
| `docker/freeswitch/conf/` | FS XML configuration — sofia profiles, modules | telephony-systems-expert | Yes |
| `docker/freeswitch/scripts/` | Lua call routing — DID lookup, bridge logic | telephony-systems-expert | Yes |
| `docker/api/` | FastAPI — REST API for provisioning, CDRs, ESL | python-backend-architect | Yes |
| `docker/api/src/` | API source — routers, db, auth, services | python-backend-architect | Yes |
| `docker/ui/` | React SPA — customer management, DID tools | frontend-fullstack-expert | Yes |
| `docker/postgres/` | PostgreSQL schema, PgBouncer, init scripts | Any | Yes |
| `docker/redis/` | Redis config, Lua scripts for caching/velocity | Any | Yes |
| `docker/homer/` | Homer SIP capture — HEP protocol debugging | telephony-systems-expert | Yes |

## Deployment Model

- **Repo path on VMs:** `/opt/revup`
- **Deploy workflow:** Push to GitHub → SSH to VM → `sudo git pull` → rebuild/restart
- **Never use:** `gcloud scp` or direct file transfer
- **All commands need:** `sudo` (Docker runs as root on VMs)
- **Single-line commands only** — backslash continuations break on paste

## Docker Compose Usage

```bash
# Local dev (all services)
docker compose up -d

# Production per-VM
sudo docker compose -f docker-compose.sbc.yml up -d      # SBC VMs
sudo docker compose -f docker-compose.media.yml up -d     # Media VM
sudo docker compose -f docker-compose.services.yml up -d  # Services VM
```

## Environment Variables

Each VM has its own `.env` file at `/opt/revup/.env`. The `.env` is NOT in git — it contains secrets. See `GCP_DEPLOYMENT_PLAN.md` for the full variable list per VM role.

**Critical variables:**
- `EXTERNAL_SIP_IP` — SBC: NLB VIP (34.24.133.82). FS: VM's own public IP.
- `ESL_PASSWORD` — FreeSWITCH Event Socket password. Must match between FS container and API.
- `JWT_SECRET_KEY` — Required, API fails to start without it.
- `DATABASE_URL` — API uses `host.docker.internal:6432` (PgBouncer on host, API in bridge network).

## Networking

- **Kamailio & FreeSWITCH:** `network_mode: host` (direct host network stack)
- **API, UI, Homer:** Bridge network (`services-network`)
- **API → PgBouncer:** Uses `extra_hosts: host.docker.internal:host-gateway` because PgBouncer runs on the host (systemd), not in Docker
- **FS → Redis:** Local 127.0.0.1:6379 (both on host network)

## Call Flow (RCF)

1. Bandwidth sends INVITE to VIP (34.24.133.82:5060 UDP)
2. NLB routes to healthy SBC (Kamailio)
3. Kamailio: topology hiding, rate limiting, dispatch to FreeSWITCH :5080
4. FreeSWITCH: Lua `inbound_router.lua` runs
5. Lua: Redis cache check → PostgreSQL DID lookup → get forward_to number
6. FreeSWITCH: bridge via `sofia/external/$forward_to@$SBC_PROXY_IP:5060`
7. Kamailio: reads X-Carrier header → routes to Bandwidth Dallas or LA
8. Bandwidth: delivers call to destination PSTN number

## Account Types

| Type | Description | Features |
|------|------------|----------|
| `rcf` | Remote Call Forwarding | DID → forward_to mapping only. No UI access for end customer. |
| `api` | API Calling | Programmable voice via webhooks |
| `trunk` | SIP Trunking | IP-authenticated SIP trunks |
| `hybrid` | API + Trunk | Both API and trunk features |
| `ucaas` | UCaaS (Full-System branch only) | WebRTC, voicemail, conferencing, chat |

**RCF customers NEVER see UCaaS features.** Only api/trunk/hybrid get those (Full-System branch).

## Testing

- **Type-check before push:** `tsc --noEmit` — unused imports break Docker build
- **Do not push until tested** — user confirms locally first
- **Live call test DID:** +16174544217 → forwards to +17744045256

## Critical Gotchas

1. **ESL password in health checks:** `fs_cli` needs `-p $ESL_PASSWORD`. Without it, health check fails, Docker restarts FS, orphaned processes hold ports.
2. **Host networking orphans:** When FS container restarts with host networking, previous process may still hold ports. Run `sudo killall -9 freeswitch` before restart.
3. **PgBouncer + asyncpg:** Must use `statement_cache_size=0` — PgBouncer transaction mode doesn't support prepared statements.
4. **SoftphoneWidget hooks:** ALL React hooks must be above early return nulls. Has caused React #310 three times.
5. **Kamailio subst():** Cannot fix SIP header corruption in TO_CARRIER route context. Use remove_hf/append_hf instead.
6. **xml_curl fallback:** When API is unreachable, FS falls back to local XML config. Modules without local config (mod_local_stream) CRIT abort — disabled in RCF-V1.
