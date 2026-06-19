# revup — Voice Platform (`unified` branch: full-stack)

> **You are on the `unified` branch — the complete platform.** It is the hardened
> RCF-V1 production base **plus** the full UCaaS stack restored on top, and it is
> what runs on the **single-VM sandbox** used for testing.
>
> **This branch is NOT what production runs.** Production runs the `RCF-V1` branch
> (RCF-only, 4 VMs). See the branch map below.

## Branch map — what is built where

| Branch | What it is | Deployed | Has UCaaS / WebRTC? |
|---|---|---|---|
| **`RCF-V1`** | Production Remote Call Forwarding platform — RCF + SIP trunks + API-calling backend, hardened for carrier traffic. | **Production** (4 VMs, GCP us-east1-b) | No |
| **`unified`** (here) | RCF-V1 base **+** full UCaaS (WebRTC/Verto softphone, voicemail, conferencing, chat/presence, IVR builder, call recordings, queues) **+** shared DID-inventory replica. | **Sandbox** (single all-in-one VM, `34.24.231.249`) | Yes |
| `Full-System` | Legacy full-stack branch — superseded by `unified`. | No | Yes (legacy) |

**Rule of thumb:** RCF customers only ever see RCF. UCaaS surfaces (api/trunk/hybrid/ucaas
account types) live on `unified`. Production stays RCF-only until UCaaS is promoted.

## What `unified` adds over `RCF-V1`

Everything in `RCF-V1`, plus (verified by the repo delta):

- **UCaaS API** (12 extra routers): `webrtc`, `voicemail`, `conference`, `chat`,
  `presence`, `extensions`, `ivr`, `recordings`, `queues`, `media` (+ supporting).
- **WebRTC / softphone**: FreeSWITCH `mod_verto` (WSS) + **coturn** (`docker/coturn`)
  for TURN/STUN relay. The UI proxies `/ws/verto/` to mod_verto (env-driven upstream).
- **Media features**: call/conference **recordings** + **voicemail** to object storage
  (MinIO locally / GCS in prod), Piper **TTS** for `<Say>`, `mod_audio_stream`.
- **Full UI**: every product in the sidebar (RCF, SIP Trunks, API DIDs, IVR Builder)
  + the complete admin suite. RCF-V1's UI is RCF-focused.
- **Schema**: 29 init scripts vs 16 — adds UCaaS/conferencing/chat/documents/recordings
  tables + `did_inventory.allocated_env`.
- **Shared DID inventory**: a read-only PostgreSQL **streaming replica of prod**
  (`docker/postgres-replica`) so the sandbox sees prod's real DID ownership without
  ever writing to prod. See [`docs/SHARED_DID_INVENTORY_PLAN.md`](docs/SHARED_DID_INVENTORY_PLAN.md).
- **Homer 10** SIP capture (ClickHouse + qryn + Grafana) — the prod RCF-V1 tier differs.

## Deployment modes

**1. Single-VM sandbox (all-in-one)** — `docker-compose.yml`. Every service on one host;
this is the test box (`34.24.231.249`). See [`docs/TEST_VM_DEPLOY.md`](docs/TEST_VM_DEPLOY.md).

```bash
cp .env.test.example .env      # fill in secrets
sudo docker compose up -d --build
# optional read-replica of prod inventory (see infra/replica/README.md):
sudo docker compose --profile replica up -d --build postgres-replica
```

**2. Per-VM (production-style)** — the same per-role compose files as RCF-V1, but with
the UCaaS services included:

```bash
sudo docker compose -f docker-compose.sbc.yml up -d       # Kamailio (SBC VMs)
sudo docker compose -f docker-compose.media.yml up -d     # FreeSWITCH + Redis + coturn
sudo docker compose -f docker-compose.services.yml up -d  # API + UI + Homer 10
```

## Service inventory (all-in-one)

| Service | Port(s) | Role |
|---|---|---|
| postgres (+PgBouncer) | 5432 / **6432** | Main DB; app connects via PgBouncer 6432 |
| postgres-replica | 6433 | **Read-only** standby of prod (inventory) — `replica` profile |
| redis | 6380→6379 | Cache, velocity, CPS limits |
| freeswitch | host net | B2BUA — RCF routing, RTP, Verto, voicemail, conferencing |
| kamailio | host net | SBC — SIP security, rate limiting, carrier routing |
| api | **8088**→8000 | FastAPI — provisioning, CDRs, ESL, UCaaS |
| ui | **8080** / **8443** | React SPA + nginx (Verto WSS proxy, Grafana embed) |
| coturn | host net | TURN/STUN for WebRTC media |
| clickhouse-server / qryn / grafana | 3100 / 3000 | Homer 10 SIP capture + visualization |
| heplify-server | 9060/udp, 9060-9061/tcp | HEP ingest from Kamailio/FS |
| minio | 9000 / 9001 | Object storage (recordings/voicemail) — GCS in prod |

## Documentation index

| Doc | Covers |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Architecture, hard-won SIP/infra lessons, gotchas, env reference |
| [`docs/TEST_VM_DEPLOY.md`](docs/TEST_VM_DEPLOY.md) | Single-VM sandbox deploy runbook |
| [`docs/SHARED_DID_INVENTORY_PLAN.md`](docs/SHARED_DID_INVENTORY_PLAN.md) | Shared inventory + read-replica design (live) |
| [`infra/replica/README.md`](infra/replica/README.md) | Stand up the prod read-replica standby |
| [`GCP_DEPLOYMENT_PLAN.md`](GCP_DEPLOYMENT_PLAN.md) | GCP topology, IPs, NLB, per-VM env vars |
| [`PRODUCTION_ARCHITECTURE.md`](PRODUCTION_ARCHITECTURE.md) | Capacity planning, scaling |
| [`PRODUCTION_READINESS_PLAN.md`](PRODUCTION_READINESS_PLAN.md) | The unify + hardening plan and sign-off |
| [`infra/OPENTOFU_PLAN.md`](infra/OPENTOFU_PLAN.md) | OpenTofu/GCP IaC reference |
| component `CLAUDE.md` files | `docker/{api,ui,freeswitch,kamailio,postgres,homer}/` deep dives |

## Notes

- **Deploy workflow:** push to GitHub → SSH to VM → `sudo git pull` → rebuild/restart.
  Never `gcloud scp`. Repo path on VMs is `/opt/revup`; all commands need `sudo`.
- **`.env` is not in git** (secrets). Copy from `.env.test.example` (sandbox) or the
  per-VM examples and fill in.
- **Type-check the UI before pushing:** `cd docker/ui/app && npx tsc --noEmit`.
