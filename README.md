# revup — RCF-V1 (Remote Call Forwarding) — **PRODUCTION**

> **You are on the `RCF-V1` branch — the production system.** It is the
> carrier-grade Remote Call Forwarding platform deployed for Granite
> Telecommunications: **RCF + SIP trunks + API-calling backend only.**
>
> **There is no UCaaS here** — no WebRTC/softphone, voicemail, conferencing,
> chat, IVR, or call recording. That stack lives on the `unified` branch.

## Branch map — what is built where

| Branch | What it is | Deployed | Has UCaaS / WebRTC? |
|---|---|---|---|
| **`RCF-V1`** (here) | Production RCF platform — RCF + SIP trunks + API-calling backend, hardened for live carrier traffic. | **Production** (4 VMs, GCP us-east1-b) | No |
| **`unified`** | RCF-V1 base **+** full UCaaS (Verto softphone, voicemail, conferencing, chat, IVR, recordings) **+** shared DID-inventory replica. | Sandbox (single all-in-one VM) | Yes |
| `Full-System` | Legacy full-stack branch — superseded by `unified`. | No | Yes (legacy) |

## What is built on this branch

- **RCF** — DID → forward_to routing (the core product). Provisioning API + admin UI.
- **SIP Trunks** — IP-authenticated trunks, call-path packages, CPS tiers.
- **API Calling** — programmable outbound origination via ESL (backend; UI is admin-side).
- **Admin suite** — customers, trunks, CDRs, rates, tiers, carriers, SIPp, DID inventory,
  user lookup, call-quality analytics.
- **SIP troubleshooting** — Homer SIP capture (HEP). The per-VM production deploy uses the
  **Homer 10** tier (ClickHouse + qryn + Grafana); the local all-in-one dev compose still
  ships the older Homer 7 tier.
- **Carrier** — Bandwidth (account 9900717), Dallas + LA, multi-carrier failover.

**Not on this branch** (see `unified`): `webrtc`/`verto`, `voicemail`, `conference`,
`chat`, `presence`, `extensions`, `ivr`, `recordings`, `queues`, coturn, the shared
DID-inventory read-replica, and the UCaaS schema tables.

## Production deployment — 4 VMs, GCP `us-east1-b`

Each zone is a self-contained SIP/RTP stack; calls never cross zones. Inbound flows
Bandwidth → NLB VIP (`34.24.133.82:5060`) → an SBC → FreeSWITCH → carrier.

| VM | Role | Compose file | Services |
|---|---|---|---|
| SBC-1 (`10.142.0.100`) | SBC | `docker-compose.sbc.yml` | Kamailio |
| SBC-2 (`10.142.0.101`) | SBC | `docker-compose.sbc.yml` | Kamailio |
| Media (`192.168.10.2`) | FreeSWITCH | `docker-compose.media.yml` | FreeSWITCH + Redis |
| Services (`10.142.0.103`) | App/data | `docker-compose.services.yml` | API + UI + Homer 10 (ClickHouse/qryn/Grafana); **PostgreSQL + PgBouncer run bare-metal on this VM, not in Docker** |

```bash
sudo docker compose -f docker-compose.sbc.yml up -d       # each SBC VM
sudo docker compose -f docker-compose.media.yml up -d     # media VM
sudo docker compose -f docker-compose.services.yml up -d  # services VM
```

The `docker-compose.yml` at the repo root is an **all-in-one local-dev** stack (single
host) for development/testing — not the production layout.

## Account types

| Type | Sees in UI |
|---|---|
| `rcf` | RCF only (DID → forward_to). No UCaaS, ever. |
| `trunk` / `api` / `hybrid` | Trunk / API-calling features (admin-managed) |

**RCF customers never see UCaaS features.** That isolation is the core product rule.

## Documentation index

| Doc | Covers |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Architecture, GCP production topology + IPs, hard-won SIP/infra lessons, gotchas, env reference |
| [`GCP_DEPLOYMENT_PLAN.md`](GCP_DEPLOYMENT_PLAN.md) | GCP topology, NLB config, per-VM env vars |
| [`PRODUCTION_ARCHITECTURE.md`](PRODUCTION_ARCHITECTURE.md) | Capacity planning, scaling |
| [`docs/LOCAL_RCF_TESTING.md`](docs/LOCAL_RCF_TESTING.md) | Local RCF testing |
| [`infra/OPENTOFU_PLAN.md`](infra/OPENTOFU_PLAN.md) · [`infra/INFRASTRUCTURE_PLAN.md`](infra/INFRASTRUCTURE_PLAN.md) · [`infra/WEST_ZONE_BUILDOUT.md`](infra/WEST_ZONE_BUILDOUT.md) | GCP IaC + multi-zone expansion |
| [`docs/UCAAS_PLAN.md`](docs/UCAAS_PLAN.md) | UCaaS roadmap (delivered on `unified`) |
| component `CLAUDE.md` files | `docker/{api,ui,freeswitch,kamailio,postgres,homer}/` deep dives |

## Notes

- **Deploy workflow:** push to GitHub → SSH to VM → `sudo git pull` → rebuild/restart.
  Never `gcloud scp`. Repo path on VMs is `/opt/revup`; all commands need `sudo`.
- **`.env` is not in git** (secrets). Each VM has its own `/opt/revup/.env`; see
  `GCP_DEPLOYMENT_PLAN.md` for the per-VM variable list.
- **Type-check the UI before pushing:** `cd docker/ui/app && npx tsc --noEmit`.
- **Live RCF test DID:** `+16174544217` → forwards to `+17744045256`.
