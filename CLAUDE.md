# Custom VoIP Platform — RCF-V1

## What This Is

Production Remote Call Forwarding (RCF) platform built for Granite Telecommunications.
Nationwide utility company deployment — carrier-grade, no POC shortcuts.

**Branch:** `RCF-V1` (production). Products on it:
- RCF (GA).
- SIP Trunking: the call path is live; the customer portal page is still a placeholder.
- Encrypted Visual Voicemail: merged 2026-10-23.
- API Calling: **retired** 2026-09-23.

The `Full-System` branch has the full UCaaS stack (WebRTC, conferencing, chat and its own voicemail). It is not deployed in production.

## Architecture

3-zone deployment in GCP — **East (us-east1-b), West (us-west1-b), and Central (us-central1-b) are all LIVE as of 2026-07-23.** Each zone is self-contained for SIP/RTP — calls never cross zones. (Started single-zone East; the 3-datacenter expansion is complete — see `GCP Production Topology` below and `docs/NATIONWIDE_PRODUCTION_ROLLOUT_PLAN.md`.)

**Availability:** the design target is 99.999% (owner). The alerting SLO in `infra/monitoring/SLOS.md` is 99.95% monthly inbound-call availability, the error budget that paging defends. Quote whichever fits the context, and never present one as the other.

```
Bandwidth (orig + LD termination)      Sinch (orig + 8YY termination + backup LD)
    |                                      |
    +--- each carrier spreads calls across all 3 zone NLB VIPs ---+
                          |
GCP Network Load Balancer (zone VIP — East 34.24.133.82)
    |
+---+---+
|       |
SBC-1   SBC-2       (Kamailio — ACTIVE/standby; SIP routing, topology hiding, rate limiting, STIR signing)
|       |
+---+---+
    |
FS-1 / FS-2 + Redis  (FreeSWITCH B2BUA — ACTIVE/standby; RCF/trunk/voicemail routing via Lua, RTP media relay)
    |
Zone PG replica      (DID lookups via local PgBouncer; East reads the primary)
    |
Services VM (East)   (PG primary + PgBouncer, FastAPI, React UI, Homer)
```

**Carriers:**
- **Bandwidth:** account 9900717, SIP peer 1162116, client CLI-8cab93d7-e797-4d7d-8717-45aa430c7185. It handles origination and all long-distance termination (first in priority).
- **Sinch:** origination (Denver/Chicago, plus the 8XX-T toll-free origination trunks). It is the **only** toll-free (8YY) termination carrier and the backup long-distance termination carrier.

See "Sinch Carrier Behaviors" and "SBC + Carrier Failover".

## Key Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Local dev — all services on one machine |
| `docker-compose.sbc.yml` | Production SBC VM — Kamailio only |
| `docker-compose.media.yml` | Production media VM — FreeSWITCH + Redis |
| `docker-compose.services.yml` | Production services VM — API + UI + Homer |
| `docker-compose.x5u.yml` | STIR x5u certificate endpoint (`fs-cert.granitevoip.com`, Caddy) on the services VM. It is a separate compose — **NEVER run it with `--remove-orphans`**, because it shares the project name and would delete the services stack. |
| `docker-compose.stir-key.yml` (untracked, on each SBC) / `docker-compose.stir-cafile.yml` | Kamailio overlays for the STIR signing key and the verify CA file. They must be included on every SBC recreate (Gotcha 15). |
| `GCP_DEPLOYMENT_PLAN.md` | Multi-zone GCP architecture, zone bring-up procedure, IPs, NLB config, `.env` values |
| `PRODUCTION_ARCHITECTURE.md` | Master reference for the live platform: inventory, per-layer design, carriers, STIR, data, observability, and the drift register (§12). Last verified 2026-09-04. |

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
| `docker/carrier-monitor/` | ops-agent sidecar (every VM, :8710) — carrier monitor, NOC reads, maintenance verbs for TED/CRAG | python-backend-architect | No (see `PRODUCTION_ARCHITECTURE.md` §10.3) |
| `infra/` | OpenTofu roots (monitoring, backups, voicemail) + plans, STIR tooling (`infra/stir/`) | Any | No |

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
sudo docker compose -f docker-compose.sbc.yml -f docker-compose.stir-key.yml up -d   # SBC VMs. On a RECREATE, reuse the container's own file list (Gotcha 15): sbc.yml alone drops the STIR key
sudo docker compose -f docker-compose.media.yml up -d     # Media VMs (FS-1 and FS-2). Recreates FS (drops calls) if its service definition changed; use `up -d --no-deps <svc>` for sidecars (Gotcha 14)
sudo docker compose -f docker-compose.services.yml up -d  # Services VM (the x5u Caddy is the separate docker-compose.x5u.yml)
```

## Environment Variables

Each VM has its own `.env` file at `/opt/revup/.env`. The `.env` is NOT in git — it contains secrets. For the full variable list per VM role, see `PRODUCTION_ARCHITECTURE.md` §2.7 and the `.env.sbc.example` / `.env.media.example` / `.env.services.example` templates. `GCP_DEPLOYMENT_PLAN.md` has the zone bring-up values.

**Critical variables:**
- `EXTERNAL_SIP_IP` — SBC: the zone NLB VIP (East 34.24.133.82). FS: the VM's own public IP.
- `ESL_PASSWORD` — FreeSWITCH Event Socket password. Must match between FS container and API.
- `JWT_SECRET_KEY` — Required, API fails to start without it.
- `DATABASE_URL` — API uses `host.docker.internal:6432` (PgBouncer on host, API in bridge network).

## Networking

- **Kamailio & FreeSWITCH:** `network_mode: host` (direct host network stack)
- **API, UI, Homer:** Bridge network (`services-network`)
- **API → PgBouncer:** Uses `extra_hosts: host.docker.internal:host-gateway` because PgBouncer runs on the host (systemd), not in Docker
- **FS → Redis:** Local 127.0.0.1:6379 (both on host network)

## Call Flow (RCF)

1. A carrier (Bandwidth or Sinch) sends the INVITE to one of the 3 zone NLB VIPs on :5060 UDP (East 34.24.133.82, West 35.252.214.40, Central 35.253.133.230). Each carrier spreads calls across all three VIPs itself.
2. The zone NLB delivers it to the **ACTIVE** SBC (Kamailio). SBC-2 is the standby.
3. Kamailio runs the trust, dedup and CPS gates, topology hiding and STIR capture, then dispatches to the **ACTIVE** FreeSWITCH :5080. That is FS-1; FS-2 is used only while FS-1 is marked down (dispatcher alg 8).
4. FreeSWITCH: Lua `inbound_router.lua` runs
5. Lua: DID lookup on the **zone-local** PostgreSQL (replica via local PgBouncer). The cascade is rcf → api → trunk → voicemail, and the first match wins. It returns the product and `forward_to`.
6. **On-net check:** resolve `forward_to` against the `number_routing` view. If it's a platform-owned DID → deliver internally to that DID's product handler (see On-Net Routing below), NO carrier hairpin. If not ours → step 7.
7. FreeSWITCH builds the zone's ordered termination list from `carrier_trunks` (cached 60 s, filtered by the destination's traffic class). It then bridges `sofia/external/$forward_to@$SBC_PROXY_IP:5060`, sending `X-Carrier-IP` on each attempt (see "SBC + Carrier Failover"). If the DB or table is unavailable, the legacy loop runs with `X-Carrier=primary/secondary`.
8. Kamailio `route[TO_CARRIER]` validates `X-Carrier-IP` against an enabled outbound `carrier_trunks` row. On the legacy path it instead maps the `X-Carrier` enum to this zone's Bandwidth PoP. It then signs STIR and relays to that trunk.
9. The carrier delivers the call to the destination PSTN number. Long-distance goes to Bandwidth, with the Sinch LD trunks as backups; 8YY goes to Sinch only.

### On-Net (Internal) Routing

When a forwarded/placed destination is a number the platform **owns** (any product), FreeSWITCH short-circuits the carrier and delivers the call into that DID's own product handler instead of hairpinning out through Bandwidth and back in. Design: `docs/ONNET_ROUTING_DESIGN.md`.

- **Oracle:** the `number_routing` view (`22_number_routing.sql`; `54_voicemail.sql` added the `voicemail_boxes` arm) — one `UNION ALL` over `rcf_numbers`/`api_dids`/`trunk_dids`/`voicemail_boxes` joined to `customers`. `resolve_destination(did)` in `db_client.lua` does a single indexed point lookup (0 or 1 row). The view is **unfiltered** on enabled/active so the resolver can tell "not ours" (0 rows → keep carrier path) from "ours but disabled/suspended" (row present → hard reject).
- **Chain:** an RCF DID whose `forward_to` is another RCF DID resolves the whole chain **in memory** (DB lookups only, NO SIP per hop) until a terminal (off-net PSTN / local ext / trunk DID / voicemail mailbox / API DID — the last is a 603 hard reject while API Calling is retired). **Exactly one** carrier B-leg is emitted, and only if the terminal is off-net PSTN.
- **Terminators** (`inbound_router.lua`): `terminate_rcf` / `terminate_api` / `terminate_trunk` / `terminate_vvm` (voicemail), dispatched via a `TERMINATORS` map. A future product enrolls by adding a `number_routing` arm + a terminator (no rewrite of detection).
- **Billing:** one CDR records BOTH parties — `customer_id`=terminal (so `rate_cdr()` is unchanged), plus `origin_customer_id`/`terminating_customer_id`/`on_net`/`on_net_hops` (`23_onnet_cdr_columns.sql`). Off-net: `origin_customer_id==customer_id`, `on_net=false`.
- **Caller-ID:** honors each DID's `pass_caller_id`, composed across the chain — "last `false` hop wins" (the masking DID closest to the terminal shows). Outbound From stays the terminal DID for Bandwidth auth.
- **Hard reject (no carrier fallback):** disabled/suspended terminal → `CALL_REJECTED` (603); loop (visited-set re-entry) or `hops>5` → `EXCHANGE_ROUTING_ERROR` (483). Sets `lua_routed=true` so the dialplan doesn't mask with 404.
- **Also the API's customer-numbers oracle:** `docker/api/src/services/customer_numbers.py` reads "a customer's numbers" (Reporting, dashboard, `/customers/me` `counts.numbers`, `/numbers/owned`, `/numbers/my`, `/search/did`) from `number_routing` — a new product's arm makes its numbers appear everywhere with no API change (checklist in `docker/api/src/CLAUDE.md` → Customer numbers). Arms must keep `customer_id` / `product_name` (customer-safe label) / `product_enabled` / `forward_to` semantics.
- **Migrations** apply on the prod primary (init scripts only run on first initdb) and replicate to all zones: `sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/init/22_number_routing.sql` and `.../23_onnet_cdr_columns.sql`.

## Account Types

| Type | Description | Features |
|------|------------|----------|
| `rcf` | Remote Call Forwarding — **GA** | DID → forward_to mapping. Customers log in to the portal, which lands on `/dashboard`. `/rcf` is the full numbers manager; Call activity, Reporting and Calls & Quality are also available. |
| `api` | API Calling — **RETIRED (2026-09-23, e408e15)** | Switched OFF, code kept: `API_CALLING_ENABLED` (API + FS env, UI `config/features.ts`) is off unless exactly `true`. Off ⇒ `/v1/calls` + API tiers unmounted, new `api` accounts/DID assignments rejected, calls to an API DID (direct or as an on-net terminal) hard-rejected 603, never hairpinned. |
| `trunk` | SIP Trunking — **early access** | IP-authenticated SIP trunks (IP-peering only, REGISTER declined). The call path is live: `route[TRUNK_AUTH]`, `trunk_outbound.lua`, and PBX delivery from any zone. The customer `/trunks` page is a placeholder and the nav lists it under Coming Soon. |
| `hybrid` | RCF + SIP Trunking | Both RCF and trunk features (was API + Trunk before API Calling was retired). Granite Telephony is hybrid. |
| `ucaas` | UCaaS (Full-System branch only) | WebRTC, voicemail, conferencing, chat |

**Visual Voicemail is a per-customer flag, not an account type.** It is controlled by `customers.voicemail_enabled` (migration 54): encrypted mailboxes on dedicated DIDs, created by admins, for any account type. See "Encrypted Voicemail" below. Treat it as early access: merged 2026-10-23.

**Not productized on RCF-V1:**
- AI voice agents: no code exists.
- IVR builder: the engine code exists, but the page is a "Phase 2" placeholder.
- Toll-free numbers: Sinch 8XX-T origination works on test TNs only.
- UCaaS.

Do not market any of these as available.

**RCF customers NEVER see UCaaS features.** Only trunk/hybrid get those (Full-System branch).

**On-net terminal is product-agnostic.** Any live product's DID (rcf/trunk/voicemail; api only if `API_CALLING_ENABLED`) can be the terminal of an on-net (internal) call — a forward that lands on a platform-owned number is delivered into that number's own handler (RCF bridge, voicemail deposit, API voice app, or trunk-to-PBX) instead of hairpinning through the carrier. This is a routing/billing optimization only; it does NOT change what any customer sees in the UI, and RCF customers still never see UCaaS. See On-Net Routing above and `docs/ONNET_ROUTING_DESIGN.md`.

## Platform changes (2026-09-22 → 09-25) — where to look

- **CDR A/B leg split (LIVE):** one `leg='A'` row per call + one `leg='B'` row per carrier bridge attempt; every call-counting query uses `leg IS DISTINCT FROM 'B'`. Contract `docs/CDR_LEG_SPLIT_CONTRACT.md`, plan `docs/CDR_BILLING_REMEDIATION_PLAN.md`, migrations 48/49. Equinox export is billing-first (derived `answered`/`billed_seconds`/`ring_ms`/`leg`/`call_id`); Equinox builds against whatever we send.
- **Tenant redaction:** customers never receive rates, costs, billable seconds, exact durations, routing internals or `traffic_grade` (`docker/api/src/services/tenant_redaction.py`; minutes = rounded talk time).
- **Customer Reporting page** (`/reporting`, under Insights in the sidebar; rcf/trunk/hybrid tenants and admins): `docs/CUSTOMER_REPORTING_DESIGN.md`. Reports cover overview, trend, per-number totals and a call list, with CSV export, in whole minutes, timezone-aware, and every product's numbers. **Calls & Quality** is `/call-quality` (tenant-reachable) and `/cdrs` (staff).
- **Call quality (migrations 50/51):** our own ITU-T G.107 MOS from true loss (patched FS vars), per-leg rating rule, call quality = worse direction, `no_rtp` = true one-way audio vs `no_media` = no audio either way. `docs/CALL_QUALITY_ACCURACY_PLAN.md`. Dashboards only — **no pager/alerting on quality (owner decision).**
- **Troubleshooting ladders:** A/B legs linked deterministically (X-CID from fetched INVITEs + bounded ClickHouse lookup + CDR B rows) — one row + one ladder per call (`routers/homer_correlation.py`).
- **Session timers:** the ~108 s cut of Sinch-originated calls is fixed (see "Session Timer Normalization").
- **NOC:** concurrent-call live + high-water mark (exporter peak gauges, 15 s rules).
- **API Calling retired** (see Account Types); payments demo removed.

## Platform changes (2026-10) — where to look

- **2026-10-15 (#139): Sinch toll-free 8XX-T origination** (migration 52), plus toll-free ingress enforcement (`TF_INGRESS_ENFORCE`, `TF_TEST_TNS`). Runbook: `docs/runbooks/SINCH_TF_ORIGINATION_RUNBOOK.md`.
- **2026-10-15 → 10-19 (#138, #140–#143): portal refresh.** Adds the admin RCF console, refreshes Calls & Troubleshooting, and adds the account Dashboard (`/dashboard`) and admin dashboard. UI details: `docker/ui/CLAUDE.md` §7.
- **2026-10-23 (#144): Sinch redundant termination.** Adds redundant long-distance/8YY termination rows (migration 53, seeded `enabled=false`). Trunk/API 8YY egress now goes through `carrier_trunks` `tollfree` rows and is fail-closed (`lib/term_trunks.lua`).
- **2026-10-23 (#149, #151): encrypted voicemail v1 + transcription v1.1.** See "Encrypted Voicemail" below.
- **2026-10-23 (#150 → migration 55): `cdr_refresh_call_quality()` no longer DMLs compressed chunks.** That DML was the root cause of the 2026-10-23 WAL/disk-full outage of the PG primary. Re-applying 50 reverts this function, so re-apply 55 after it.
- **2026-10-23 (#152): holistic customer numbers.** Every product's numbers now come from `number_routing` (`services/customer_numbers.py`; migration 57 index).
- **2026-10-23 (#147, #148, #153):** GitHub Actions CI, CRAG Ops alert prerequisites, and readable CRAG alert emails.
- **STIR signing outage, 2026-10-15 → 10-23 (2026-10-23 maintenance record):** the 10-15 deploy recreated the SBCs' Kamailio without `docker-compose.stir-key.yml`, so signing failed open and calls went out unsigned. It was fixed by recreating each SBC with the overlay (Gotcha 15). Verify signing with the `cdrs.stir_eff_actual` mix after any SBC recreate.

## Encrypted Voicemail (RCF-V1, merged 2026-10-23)

Contract: `docs/ENCRYPTED_VOICEMAIL_INTERFACES.md`. Plans: `docs/ENCRYPTED_VOICEMAIL_BUILD_PLAN.md` and `docs/VOICEMAIL_TRANSCRIPTION_PLAN.md`. Runbooks: `docs/runbooks/VOICEMAIL_GCP_SETUP.md`, `VOICEMAIL_DEPLOY_RUNBOOK.md` and `VOICEMAIL_TRANSCRIPTION_DEPLOY.md`.

- **Call path:** mailboxes live on dedicated DIDs (`voicemail_boxes`, migration 54, `number_routing` voicemail arm), reached by a direct dial or an on-net RCF forward. FS `terminate_vvm` → `lib/vm_box.lua` does the following:
  - answers, plays the greeting, and records to the RAM tmpfs `/dev/shm/vm`. On that leg only it sets a jitter buffer and `rtp_timer_name=soft`; recording stops after 10 s of silence.
  - deposits the raw WAV to the East API (`/v1/voicemail/fs/deposit`, using the `X-Ingest-Secret` header file `/opt/revup/secrets/fs-voicemail/vm_ingest.header`), then unlinks it.
  - rejects a disabled or suspended mailbox with 603.
- **Crypto:** AES-256-GCM envelope with one Cloud KMS key per customer (`vm-cust-<id>`, keyring `voicemail-prod`). Only ciphertext is stored in `gs://voip-voicemail`. Plaintext exists only in RAM (FS tmpfs, API tmpfs, core dumps off). Playback tokens last 120 s, the access audit is append-only, and there is a crypto-erase. Any KMS or config problem fails closed with 503, never plaintext.
- **Product rules:**
  - `customers.voicemail_enabled`, with admin-only mailbox create and delete.
  - Retrieval is web-only (`/voicemail`).
  - Voicemail CDRs are rated at $0.
  - Retention defaults to 90 days (`retention_days`); trash is purged after 30 days.
- **Transcription v1.1:** Google Speech-to-Text V2, US-only (`VOICEMAIL_STT_LOCATION` must be `us`). It is gated three ways:
  - the kill switch `VOICEMAIL_TRANSCRIPTION_ENABLED`, off unless exactly `true`.
  - a per-mailbox admin opt-in, off by default (migration 56).
  - a daily cap on billed minutes.
  
  Transcripts are sealed the same way as the audio.
- **Open items:**
  - The prompts in `scripts/sounds/vm/` are espeak-ng placeholders.
  - Equinox must skip `product_type=voicemail`.
  - The live end-to-end test was still pending at merge (owner notes).

## Testing

- **Type-check before push:** `cd docker/ui/app && npm run build` (`tsc -b && vite build`, the same command the Docker build and CI run) — unused imports break the Docker build. Do NOT use `tsc --noEmit`: `tsconfig.json` is a solution file (`"files": []` + references), so it type-checks zero files and always passes.
- **API / Lua tests:** `TEST_PG_BIN=/opt/homebrew/opt/postgresql@16/bin python3 -m pytest tests -q -rs` (deps: `pip install -r tests/requirements.txt`), then `lua tests/lua/<name>_harness.lua` from the repo root. Without PostgreSQL 16 binaries or a `lua` interpreter the DB/Lua tests SKIP silently — read the `-rs` summary.
- **CI** runs all of the above on every PR into `RCF-V1` — see [CI](#ci) below.
- **Do not push until tested** — user confirms locally first
- **Live call test DID:** +16174544217 (RCF). Its `forward_to` is changed for testing, so check `rcf_numbers` before relying on a target. On 2026-09-24 it forwarded to +18004444444 via Sinch Denver-TF; in the 2026-10-23 zone tests it rang +17744045256 again. Read `cdrs.freeswitch_node` to see which zone and FS took the call.
- **Sinch test TNs (origination):** 5305480845 (Denver), 5305480846 (Chicago) — use them for anything that depends on Sinch session timers/refreshes. Toll-free 8XX-T test TNs: 5595335873 (ATL, works) and 5595335908 (DEN). Both are allowed through `TF_TEST_TNS`.

## CI

`.github/workflows/ci.yml` runs on every pull request into `RCF-V1` (drafts and bot-opened PRs included) and on every push to `RCF-V1`. It only verifies; deploys stay `git pull` on the VMs.

| Job | Runs |
|-----|------|
| `api-tests` | Python 3.12 + `tests/requirements.txt`; vanilla PostgreSQL 16 (`TEST_PG_BIN=/usr/lib/postgresql/16/bin`, no TimescaleDB); Lua 5.3 (what production mod_lua is built against). `pytest tests -q -rsx`, then `.github/scripts/check_no_skips.py` **fails the job if any test skipped or xfailed** — the DB/Lua tests skip silently when a tool is missing, which would otherwise pass green without running. Then every `tests/lua/*_harness.lua` and `scripts/vmalert-pager/test/run_tests.sh`. |
| `ui-build` | Node 20, `npm ci && npm run build` in `docker/ui/app` (the Docker image build's commands). |

CI executes PR code, including model-written code from the CRAG Ops agent, so it must stay a read-only sandbox:

- **Never give CI repository secrets**, environments, cloud credentials, or a write-scoped `GITHUB_TOKEN`. Keep top-level `permissions: contents: read`. Nothing in CI may reach production (VMs, DB, carrier or GCP APIs).
- Trigger only on `pull_request` / `push`. Never `pull_request_target` or `workflow_run` — they run PR code with the base repository's token and secrets.
- Pin every third-party action to a full commit SHA with a `# vX.Y.Z` comment; `actions/checkout` keeps `persist-credentials: false`.
- A PR's own copy of `.github/` is what CI runs for that PR — review changes there as changes to the gate itself.
- A new test must run in CI, not skip. If it needs a new tool, install it in the workflow.
- `npm run lint` is not in CI yet: it fails on existing code (19 errors as of 2026-10-21).

## Multi-VM SIP Architecture — Hard-Won Lessons

These lessons were learned through production debugging (2026-04-29/30). They are **critical** for any agent modifying SIP routing, Kamailio config, FreeSWITCH config, or GCP infrastructure.

### GCP Cloud NAT Breaks VoIP

GCP Cloud NAT on the `default` subnet overrides VM 1:1 external IPs with a NAT pool IP. Bandwidth drops all RTP/SIP because the source IP doesn't match what was negotiated in SDP.

- **Root cause:** Cloud NAT router `ted-auto-dialer-nat` on `default` subnet was replacing media VM's external IP (34.139.119.135) with NAT pool IP (172.85.228.254).
- **Fix:** Media VM runs on dedicated `voip-media` subnet (192.168.10.0/24) that is NOT in the Cloud NAT router's subnet list. SBC VMs use `bypass-vpn` network tag to route directly to internet instead of through VPN tunnel.
- **Rule for new regions:** Every VM that sends/receives SIP or RTP MUST either be on a subnet excluded from Cloud NAT, or have the `bypass-vpn` network tag. No exceptions.

### NLB Pass-Through Has Asymmetric Routing

GCE Network Load Balancer is pass-through (not proxy). For intra-VPC traffic, the NLB VIP cannot be used for outbound B-leg SIP from FreeSWITCH to Kamailio.

- **Problem:** FS sends outbound INVITE to NLB VIP → NLB routes to a random SBC → SBC processes call → B-leg reply comes back → but the reply's source IP is the SBC's own IP, not the VIP → FS rejects it.
- **Fix:** FS never targets the EXTERNAL NLB VIP for outbound bridging. Since the active/standby cutover, `SBC_PROXY_IP` is the zone's INTERNAL signaling ILB VIP (an internal passthrough NLB with failover backends — symmetric by design, safe for FS) and `SBC_PROXY_IP_FAILOVER` is SBC-1's direct VPC IP (ILB-bypass fallback). Pre-cutover these were the two SBCs' direct VPC IPs.
- **External NLB is for inbound only:** Bandwidth → NLB VIP → active SBC. FS → SBC traffic uses the internal signaling VIP (or direct IPs as fallback).

### Double Record-Route + Stateless In-Dialog Dispatch (Multi-VM)

Both legs insert two Record-Route headers via `record_route_preset()`, now carrying an `;fs=` dispatch marker:

```
Record-Route: <sip:NLB_VIP:5060;fs=509x;lr>                 ← outer: what Bandwidth sees, routes inbound
Record-Route: <sip:SBC_INTERNAL_IP:5060;r2=on;fs=509x;lr>   ← inner: what FS sees, routes to this specific SBC
```

- **Implementation:** TO_CARRIER (B-leg): `record_route_preset("ADVERTISE_IP:5060;fs=5090;lr", "SBC_INTERNAL_IP:5060;r2=on;fs=5090;lr")`. A-leg (inbound, request_route): reversed argument order with `;fs=5080` on both entries and `;r2=on` on the SBC_INTERNAL entry.
- **FS-originated direction (works via rr):** FS's in-dialog ACK/BYE carry `Route: [SBC_INTERNAL;r2, VIP]`. `;r2=on` on the SBC_INTERNAL entry makes `loose_route()` consume BOTH own Routes in one pass and force the VIP send socket (5.8 `loose.c after_loose()/is_2rr()` — the r2 check reads the FIRST Route only). Without r2, only the inner Route pops and the leftover VIP Route causes a real wire hairpin to the SBC's own loopback + a duplicate Via.
- **Carrier-originated direction (NEVER runs loose_route()):** topology hiding rewrites FS's Contact to the VIP, so every carrier in-dialog request arrives with R-URI == the VIP (= "myself" on BOTH SBCs) + `Route: [VIP, SBC_INTERNAL_owner]`. Feeding that to `loose_route()` triggers rr's RFC 2543 strict-router recovery (`after_strict()` fires whenever R-URI==self + Route present, regardless of r2): it sets `$du` to the FIRST Route (the VIP → loopback self-hairpin) and promotes the LAST Route (the owner SBC's private IP) into the R-URI — destroying the route set and looping the BYE into 481/408. **Fix (2026-08, after three failed rr-based patches):** `route[WITHINDIALOG]` intercepts external-source in-dialog requests with R-URI==self BEFORE `loose_route()` and delivers them straight to FS. The FS profile port is read from the `;fs=` marker the peer echoes back in its Route set (`fs=5080` = A-leg/internal profile, `fs=5090` = B-leg/external profile), so ANY SBC routes ANY carrier in-dialog request with zero dialog state — the NLB coin-flip stops mattering. Pre-marker dialogs fall back to `$dlg_var(fs_port)` (owner only) then guess-5090 + one-shot 481 retry on 5080. See `docker/kamailio/CLAUDE.md` §8.10 for the full history (r2-on-inner was never visible carrier-side; dropping r2 fixed nothing and broke the FS direction; owner/non-owner relays chased promoted shapes).
- **Requires:** `SBC_INTERNAL_IP` env var set per-SBC in `.env` + passed through `docker-compose.sbc.yml`.
- **Requires:** `alias=SBC_INTERNAL_IP:5060` in Kamailio config so the inner RR address counts as "myself" (used by the FS-direction double-pop and the in-dialog dispatch guard).

### SBC + Carrier Failover — TCP Pre-Check + Table-Driven Attempt Loop

FreeSWITCH implements outbound SBC-path and carrier failover in `inbound_router.lua`. The termination logic is shared with trunk/API 8YY through `scripts/lib/term_trunks.lua`.

1. **TCP pre-check (cached):** before each bridge attempt, FS opens a 1-second TCP connect to the SBC target on :5060. An unreachable target is marked dead in under 1 second instead of waiting out the SIP timeout. Results are cached process-wide in FreeSWITCH global variables: reachable for 30 s, unreachable for 10 s (so a recovered target returns within 10 s). Steady state is about 2 probes per target per minute. A skipped attempt launches no B-leg and does not count in `cdr_leg_attempt`.
   - **Role since the active/standby cutover (2026-08-27):** `SBC_PROXY_IP` is the signaling ILB VIP, which always leads to the ACTIVE SBC. The pre-check is therefore the **ILB-bypass detector**: if the ILB goes dark, the attempt moves to `SBC_PROXY_IP_FAILOVER` (SBC-1 direct) within 1 s.
   - It does **not** make SBC failover sub-second. An active-SBC death is handled by the NLB/ILB flip, which takes about 10–12 s. Until the flip, both targets lead to the dead SBC-1, so those attempts are skipped quickly instead of hanging.
2. **Table-driven attempt list (LIVE):**
   - **Source:** per zone from `carrier_trunks`, `WHERE direction IN ('outbound','both') AND enabled`, `ORDER BY COALESCE(priority_<FS_ZONE>, priority), id`. The list is cached for 60 s process-wide, so disabling a trunk in TED takes effect in about 60 s with no redeploy.
   - **Filter:** applied per call on `traffic_class`. Long-distance uses `any`/`ld` rows. NANP 8YY uses **only** `tollfree` rows; if there are none, the call fails closed with `NO_ROUTE_DESTINATION`.
   - **Size:** capped at 4 trunks *after* the filter. Each trunk is tried trunk-major × {`SBC_PROXY_IP`, `SBC_PROXY_IP_FAILOVER`}, giving **up to 8 bridge attempts**, each with `X-Carrier-IP`/`X-Carrier-Label`.
   - **Kamailio behavior:** a validated `X-Carrier-IP` sets flags 8+9, so Kamailio does not flip carriers itself. FS owns failover, and the negative reply goes back to FS's loop.
   - **Long-distance order today:** nearest Bandwidth PoP (10), then the other Bandwidth PoP (20; West swaps Dallas/LA), then Sinch atlanta-ld (30), then Sinch denver-ld (35, once enabled).
3. **Legacy fallback (4 attempts):** if the DB errors, there are zero usable rows, the cache entry is unparsable, or `term_trunks.lua` fails to load, the original loop runs: `SBC_PROXY_IP`+primary → `SBC_PROXY_IP_FAILOVER`+primary → `SBC_PROXY_IP`+secondary → `SBC_PROXY_IP_FAILOVER`+secondary. It uses the `X-Carrier` enum, which Kamailio maps to this zone's Bandwidth PoPs, so its CARRIER_FAILURE flip applies.
   - Which path ran is recorded in the CDR variable `term_trunks_source=db|fallback`.
   - The fallback is class-blind and can send 8YY via Bandwidth. That is a deliberate fail-open for RCF; trunk and API 8YY fail closed instead.
4. **progress_timeout=10s:** This timeout bounds carrier PDD (Post-Dial Delay) — the total time allowed for the carrier to send back a provisional response (180/183). Once ringing starts, the call may ring up to call_timeout. Env-tunable via `BRIDGE_PROGRESS_TIMEOUT` (default 10). Do NOT use `originate_timeout` here — it caps total time-to-ANSWER including ring time, which cancels still-ringing forwarded calls. Worst-case PDD across a fully failing sweep is the number of launched attempts × 10 s.

### SIP Header Handling — What Works and What Doesn't

These are specific Kamailio behaviors that caused production bugs:

- **subst() cannot fix Via corruption.** Kamailio's tm module re-applies `;received=` and `;rport=` AFTER the routing script runs. Attempting to strip FS's Via with `remove_hf("Via")` + `msg_apply_changes()` leaves orphaned annotation text that merges with the next header. **Solution:** Leave FS's Via in place. Two Vias is valid per RFC 3261.
- **record_route() must come AFTER msg_apply_changes() in TO_CARRIER.** The reverse order causes `msg_apply_changes()` to silently fail with "cannot apply msg changes after adding record-route header", which means ALL header cleanup is silently ignored.
- **Contact must be added BEFORE msg_apply_changes().** The dialog module reads Contact during `record_route()` to create leg info. If Contact is absent, you get "bad sip message or missing Contact hdr" → no dialog → ACK routing breaks → BYE returns 404.
- **NAT detection must NOT apply to FreeSWITCH traffic.** `force_rport()` adds `;received=172.28.0.10` to FS's Via, leaking Docker IPs. `fix_nated_contact()` overwrites FS's clean Contact with Docker source IP. NAT_DETECT is ONLY for inbound from Bandwidth.
- **topoh module is disabled.** It conflicts with manual header cleanup by adding TH= markers. All topology hiding is done via explicit `remove_hf()` + `append_hf()` + SDP `subst_body()`.

### Session Timer Normalization

Bandwidth sometimes sends `Session-Expires: 30` in 200 OK (below RFC 4028 minimum of 90). FreeSWITCH has `minimum-session-expires=90` and silently ignores any value below that, never setting up the refresh timer. Bandwidth then kills the call when its 30-second timer expires.

- **B-leg (FS → carrier):** Kamailio `route[TO_CARRIER]` adds `Session-Expires: 1800;refresher=uac` + `Min-SE: 90` to the outbound INVITE (FS's external profile emits none — the `sip-session-timeout` profile param and the `sip_session_timeout`/`sip_minimum_session_expires`/`enable_timer` dial-string/export vars are NOT read by mod_sofia; they are inert).
- **Carrier replies only (REPLY_HANDLER):** Session-Expires below 90 (or unparseable) or above 1800 → `1800;refresher=uac`; 90..1800 → the carrier's interval is KEPT (never raised — raising a carrier's 600 to 1800 would make FS refresh at ~900s after the carrier had already expired the session), always `refresher=uac` (= FS). `Min-SE: 90` appended if absent. "Carrier" = any source that is not FreeSWITCH (VOIP_SUBNET/docker/loopback), so replies handed over by the peer SBC (§8.12) are normalized too. Armed for INVITE and UPDATE (`route[RELAY]` + TO_CARRIER).
- **FS's own replies are NEVER rewritten** (fixed 2026-09-24). The old "normalize ALL replies" rule rewrote FS's A-leg `200 OK Session-Expires: 120;refresher=uac` to 1800 toward the carrier; Sinch (the refresher) planned its refresh at ~900s while FS's real 120s timer fired → BYE `Reason: SIP;cause=408;text="Session timeout"` at ~108s on every Sinch-originated call.
- **A-leg (carrier/PBX → FS internal profile):** `inbound_router.lua` and `trunk_outbound.lua` `set` (not export) `sofia_session_timeout=1800` at top level before any answer/bridge. It is the ONLY per-call knob and is read in `sofia_answer_channel` AFTER the `aggressive-nat-detection` override (TFLAG_NAT → `SOFIA_NAT_SESSION_TIMEOUT` 90, raised to sofia-sip's 120). Do NOT "fix" the profile param name to `session-timeout` — the NAT override would still give 90 (calls cut at ~81s).

### Bandwidth Carrier Behaviors

- **Duplicate INVITEs:** Bandwidth sends the same inbound call from multiple edge proxies simultaneously (different source IPs, different Call-IDs, same From/To). Kamailio deduplicates via `bw_dedup` htable (key=FromUser::ToUser, TTL=3s), responding 482 Merged to duplicates.
- **Carrier IPs:** TC4 Dallas 67.231.2.12 / Los Angeles 216.82.238.134.
  - The order is set per zone by `BANDWIDTH_PRIMARY_IP`/`_SECONDARY_IP`: East and Central try Dallas first, West tries LA first. The same order is mirrored in the `carrier_trunks` priorities (migration 42).
  - FS selects the PoP with `X-Carrier-IP` (table-driven) or with the legacy `X-Carrier` enum (`primary`/`secondary`/`tc1`/`tc2`/`tc4`). The enum is still used for non-8YY trunk/API calls and by the RCF fallback loop.
  - TC1 (NY/ATL) and TC2 (DAL/LA) are trusted, probed (groups 4/5), and used as in-trunk failover targets.
- **422 handling:** If Bandwidth rejects with 422 (Session Interval Too Small), Kamailio retries with Session-Expires: 3600, Min-SE: 900.
- **5xx failover:** on 500/503/408/480/404, `failure_route[CARRIER_FAILURE]` first flips to the other IP of the same Bandwidth trunk config (flag 8), then falls back cross-trunk to TC4 Dallas (flag 9; both flags prevent loops). This applies **only to legacy `X-Carrier` legs**. A validated `X-Carrier-IP` sets flags 8+9 up front, so the reply goes back to FS's attempt loop instead.

### Sinch Carrier Behaviors

- **Origination + table-driven termination (LD and 8YY).** Sinch is the second origination carrier (Denver/Chicago below, plus the 8XX-T toll-free orig trunks) AND terminates long-distance (Sinch "INT") and toll-free 8YY (Sinch "OSAO") traffic. Termination is fully table-driven: FS picks trunks from `carrier_trunks` (`direction IN ('outbound','both') AND enabled`, order `COALESCE(priority_<zone>, priority)`, filtered per call by `traffic_class` — `ld`/`any` rows for LD, ONLY `tollfree` rows for NANP 8YY) and stamps each attempt with `X-Carrier-IP`; Kamailio validates that IP against an enabled outbound/both row and sends the INVITE to it. Changes are a TED edit, no redeploy.
  | carrier/pop | IP | direction / class | priority | dispatcher group |
  |---|---|---|---|---|
  | `sinch/atlanta-ld` (TG ATLNGAQSGR2_7214, INT) | 206.146.98.26 | outbound / `ld` | 30 (after Bandwidth 10/20) | 8 |
  | `sinch/denver-ld` (redundant INT, DENSBX21, TG TBD) | 206.146.100.25 | outbound / `ld` | 35 | 11 |
  | `sinch/denver-tf` (TG DNVTCOZIGR2_3282, OSAO) | 206.146.100.26 | outbound / `tollfree` | 40 (first for 8YY) | 9 |
  | `sinch/atlanta-tf` (redundant OSAO, ATLSBX21, TG TBD) | 206.146.98.25 | outbound / `tollfree` | 45 | 12 |
  The two redundant rows (migration 53) are seeded `enabled=false` until Sinch confirms the build and trunk-group ids; enabling is an `UPDATE carrier_trunks SET enabled=true, trunk_group='<TG>'` on the primary (exact statements in the 53 header). The live enabled state is in the table, not the migration; check `carrier_trunks` / `carrier_trunk_health.trunk_enabled`. The termination sign-off (PCAP matrix to Sinch) is still open (`PRODUCTION_ARCHITECTURE.md` §12 #7). 8YY is **fail-closed**: no enabled `tollfree` row → `NO_ROUTE_DESTINATION`, never Bandwidth — this applies to RCF forwards and to customer SIP-trunk / API outbound 8YY (`trunk_outbound.lua` / `api_outbound.lua` share the selection via `lib/term_trunks.lua`); their non-8YY destinations stay on Bandwidth unchanged.
- **Same IP, two trunks (.25).** 206.146.98.25 / 206.146.100.25 each carry an INBOUND 8XX-T orig trunk (registered to our zone VIPs) AND an OUTBOUND redundant termination trunk (registered to our 6 SBC public IPs). Sinch picks the trunk group from OUR source IP, so termination INVITEs and OPTIONS to Sinch always leave from the SBC's own public IP (never the VIP — `VIP_EGRESS` applies to Bandwidth only). `carrier_trunks` therefore allows one ingress row (`inbound`/`both`) and one egress row (`outbound`/`both`) per IP (partial unique indexes, migration 53); **every lookup by IP must filter direction** (CARRIER_TRUST: inbound/both; X-Carrier-IP validation and FS selection: outbound/both).
- **PoPs / trunk groups:** Denver 206.146.100.24 (Trunk Group `DNVTCOZIGR2_3278`, test TN 5305480845), Chicago 206.146.101.39 (Trunk Group `CHCGIL24GR4_7412`, test TN 5305480846). Env-overridable via `SINCH_DENVER_IP`/`SINCH_CHICAGO_IP` (defaults baked in — deploy is git pull + rebuild, no .env edits).
- **Round-robin to all 3 zone NLB VIPs** (like Bandwidth). Each zone's SBCs trust both Sinch IPs statically (flag 5) and probe them via dispatcher groups 6 (Denver) / 7 (Chicago) for OPTIONS keepalive + carrier-monitor up/down reporting.
- **Dedup + CPS are carrier-generic:** Sinch shares the same `bw_dedup` (From::To key — deliberately source-independent) and per-source-IP `bw_cps` backstop (BW_CPS_LIMIT) as Bandwidth. No Sinch-specific rate plumbing.
- **CDR attribution:** Kamailio stamps spoof-proofed `X-Inbound-Carrier`/`X-Inbound-PoP` on carrier ingress (strips wire-supplied copies first); FS records them as `inbound_carrier`/`inbound_carrier_pop` channel vars (defaults `bandwidth`/`""` when absent) which flow into CDRs. TO_CARRIER strips both headers before any B-leg reaches a carrier.
- **Egress of Sinch-originated calls:** X-Inbound-TC is set to `tc4` for Sinch sources — the forwarded leg terminates per the `carrier_trunks` priority order (LD: Bandwidth first, Sinch LD trunks as backups; 8YY: Sinch TF trunks only).
- **Toll-free origination (8XX-T, migration 52):** `sinch/atlanta-tf-orig` 206.146.98.25 (TG ATLNGAQSGR2_7284) and `sinch/denver-tf-orig` 206.146.100.25 (TG DNVTCOZIGR2_3327), static-trusted (`SINCH_TF_ATL_IP`/`SINCH_TF_DEN_IP`), no OPTIONS probe (passive health in `carrier_trunk_health`). `TF_INGRESS_ENFORCE` (default on) admits only 8YY R-URIs from them and rejects 8YY from every other carrier. `TF_TEST_TNS` (comma list, default empty) exempts listed non-8YY test TNs from the TF trunks' 8YY-only rule — prod SBC `.env`: `TF_TEST_TNS=5595335873,5595335908` (Sinch test TNs ATL/DEN) in place of the old `TF_INGRESS_ENFORCE=off`; when real TFNs are live, delete the line, recreate kamailio, and disable the two test `rcf_numbers` rows.
- **Runtime-added carriers (no redeploy):** carriers beyond the static list can be admitted via the `carrier_trunks` table (managed in TED; sibling migration 40). Kamailio's `route[CARRIER_TRUST]` authenticates unknown source IPs per-INVITE (after the same pike/scanner gates as customer trunk auth), applies the row's per-carrier/PoP CPS limit (`carrier_cps` htable), and stamps attribution from the row. Fail-closed: DB down = DB-only carriers rejected; static carriers (Bandwidth, Sinch) unaffected. See `docker/kamailio/CLAUDE.md`.

### STIR/SHAKEN — Current State

Details: `docker/kamailio/CLAUDE.md` §8.13–8.14 and `PRODUCTION_ARCHITECTURE.md` §7. Plan: `docs/STIR_SHAKEN_IMPLEMENTATION_PLAN.md`.

- **Signing happens at the SBCs**, on carrier-bound legs only (Kamailio secsipid, `route[TO_CARRIER]` Step 8.5):

  | Call | Attestation |
  |---|---|
  | Trunk/API origination | A (B when the caller DID isn't owned) |
  | RCF pass-through forward | inbound chain re-emitted once + our `div` PASSporT |
  | Masked forward (`STIR_MASKED_REORIG`, default on) | fresh A |
  | Forward of an unsigned inbound call | C |

  - **Certificate:** SHAKEN leaf SPC 8052 (Neustar/TruContact). It expires 2027-05-08; renew around 2027-04-01.
  - **x5u:** `https://fs-cert.granitevoip.com/stir/8052-2026.pem`, served by `docker-compose.x5u.yml`.
- **Signing fails open by design.** Any signing failure relays the call unsigned (`eff=unsigned`/`base-only`). `STIR_SHAKEN_SIGN` defaults to OFF in code; prod sets it `on` in each SBC `.env` together with the key overlay (Gotcha 15). Never claim "100% signed".
- **Inbound verification:** Granite's own-crypto verify is **deployed dark** (`STIR_SHAKEN_VERIFY` defaults to off; the canary is pending). Today's inbound attest/verstat comes from Bandwidth headers (`P-Attestation-Indicator`, PAI `verstat`). The STI-PA trust-bundle pipeline is live (`docs/STIR_TRUST_BUNDLE_RUNBOOK.md`).
- **Per-call outcome:** Kamailio hands the Identity set it actually composed back to FS as `X-Stir-Outcome`. It is stored in `cdrs.stir_outcome` / `stir_eff_actual` (migration 47), and the UI badge prefers this actual value over intent. The NOC STIR board shows the signed mix and the certificate/trust-bundle age.

### FreeSWITCH Media Handling

- **No proxy_media in RCF path.** Default media mode works correctly. proxy_media was removed after the Cloud NAT fix resolved the actual audio issue.
- **No sip_enable_soa=false.** SOA stays enabled for proper B-leg media setup. The "duplicate SDP answer" in 200 OK is cosmetic in default media mode.
- **183 SDP passthrough works.** PSTN ringback flows through naturally in default media mode. No special handling needed.
- **Gateway syntax deprecated.** All outbound bridges use `sofia/external/dest@proxy:5060` with an `X-Carrier-IP` (table-driven) or legacy `X-Carrier` header. The old `sofia/gateway/carrier/dest` syntax produced corrupted Contact headers (`sip:gw+carrier_primary@...`).
- **Redis code removed from inbound_router.lua (RCF-V1).** The redis-lua library has connection pooling issues inside mod_lua's threading model. The Redis route cache, fraud prefix check, and velocity limiting were deleted (not just disabled) — calls route via PostgreSQL lookup only. Re-adding requires a synchronous Redis client; the old code is in git history. trunk_outbound/api_outbound still load redis_client fail-open.
- **mod_local_stream disabled.** Requires `local_stream.conf.xml` which doesn't exist. When xml_curl can't reach the API during startup, the missing config causes CRIT abort. RCF uses `silence_stream://-1` instead.

### GCE Hairpin NAT

FreeSWITCH on the media VM cannot send to its own public IP via GCE's network fabric (hairpin NAT). The entrypoint.sh adds the public IP to the loopback interface:

```bash
ip addr add "${PUBLIC_IP}/32" dev lo
```

This allows FS to reach Kamailio's Record-Route address when Kamailio is on the same VM (dev) or when FS needs to send to its own advertised address. Requires `NET_ADMIN` Docker capability.

### Active/Standby SBC Pair (LIVE all 3 zones, 2026-08-27)

Each zone's 2 SBCs run as a TRUE active/standby HA pair — NOT active/active. It was deployed 2026-08-26/27 in West, Central and East. The acceptance, planned-failover and kill drills were run, but they were **never logged** (runbook §8 evidence gap, `PRODUCTION_ARCHITECTURE.md` §12 #14). Treat "~10–12 s flip" and "established calls survive" as design behavior until a logged drill records them. Enforced entirely by GCP NLB failover backends (no VRRP/keepalived; identical config on both SBCs; "active" is decided only by health checks):

- **Both traffic planes fail over together:** the external carrier VIP AND a per-zone internal "signaling VIP" (internal passthrough NLB, `SBC_SIGNALING_VIP`: East 10.142.0.250 / West 10.138.0.250 / Central 10.128.0.250) share the same primary group (SBC-1), standby group (SBC-2 in `*sbc-standby-group`), HTTP :8080 `/healthz` fs-aware health check (5s/2 ≈ 10-12s detection; East/Central `*-sbc-fs-aware-hc`, West `west-sbc-healthz-hc`), and policy (`failover-ratio=0`, `drop-traffic-if-unhealthy`, `no-connection-drain-on-failover`). Failback is automatic.
- **Passthrough-LB health probes are VIP-addressed** (dst = forwarding-rule IP, from 209.85.152.0/22 + 209.85.204.0/22 + 35.191.0.0/16) — Kamailio binds :8080 on the external VIP and (dedicated mode) the signaling VIP for exactly this. Before those binds (pre-2026-08-26) the health checks NEVER passed and zones rode NLB fail-open invisibly.
- **FS targets the signaling VIP** (`SBC_PROXY_IP`), and the inner Record-Route entry renders the signaling VIP — so FS-side in-dialog requests always reach the ACTIVE SBC, and a mid-call SBC death no longer strands the FS→carrier direction. The `;fs=` stateless dispatch (§8.10) + stateless FS→carrier BYE forward are what make established calls survive a flip; setups in flight during the ~10-12s flip are lost (industry-standard HA semantic).
- **Post-flip teardown:** established calls tear down statelessly on EITHER SBC; the dialog entries the ex-active owned age out silently at `default_timeout=7200` (≤2h) — gauges only (`dlg.stats_active`, `kamailio_dialog_active_dialogs`, `carrier_trunk`), never `dlg.end_dlg`-sweep them (sends BYEs); an in-flight setup's CANCEL gets `481` from the new active (flag-5 sources). `docker/kamailio/CLAUDE.md` §8.11.
- **`SBC_SIGNALING_VIP` unset ⇒ byte-identical legacy behavior** (renders as SBC_INTERNAL_IP, no extra listen/alias) — rolling-safe. Never set it before the zone's ILB exists; set it on BOTH SBCs before repointing FS.
- **Peer reply hand-off (`SBC_PEER_INTERNAL_IP`, optional, default off):** a carrier reply that lands on the SBC with no transaction for it (failback while the ex-active still has in-flight VIP-sourced INVITE/CANCEL transactions, a maintenance drain, the standby's VIP-sourced Sinch probes) is handed RAW to the peer SBC whose tm owns it (`send_data("sip:SBC_PEER_IP:5060", "$mb")` + `drop` in `reply_route`; INVITE/CANCEL/OPTIONS only, BYE is stateless on both), gated on peer liveness (dispatcher group 10 → `peerhealth` htable via the `$ru` event routes) so a dead peer never swallows a reply — that case keeps today's stateless via2 forward. Kills the failback duplicate-ring (local 408 → alternate-PoP re-INVITE) and makes the standby read Sinch orig 6/7 Active. `docker/kamailio/CLAUDE.md` §8.12.
- **Single active SBC side-effects:** bw_dedup now catches cross-edge duplicate INVITEs deterministically; bw_cps/pike counters see full zone load (limits env-tunable); dialog gauges are accurate on the active SBC.
- **Maintenance drain (LIVE 2026-09-03/04):** `kamcmd htable.seti maint drain 1` makes `/healthz` return `503 DRAINING`, so both NLB planes move to the peer in about 10–12 s. The flag has a dead-man switch: it auto-expires after 1 h. Restore with `htable.delete maint drain`. An FS is drained with dispatcher state `d`. Zone-dark (both SBCs drained) is done from the CRAG Maintenance tool. Reference: `PRODUCTION_ARCHITECTURE.md` §4.6.
- **Ops:** `docs/SBC_ACTIVE_STANDBY_RUNBOOK.md` (drills, failure modes, rollback, migration record). IaC blueprint: `infra/OPENTOFU_PLAN.md` §18. Alerting: `infra/monitoring/sbc_failover.tf`.

### FreeSWITCH Media HA (LIVE all 3 zones, 2026-08-31)

- **Strict active/standby:** FS-2 in each zone is fully hot (sofia up, DB connected, metrics flowing), but it receives **zero** new calls while FS-1 is healthy.
  - It is enforced by Kamailio dispatcher group 1, `ds_select_dst` alg 8 on priority (FS-1 10, FS-2 5). There is no load balancer.
  - `FREESWITCH_IP_2` must be set on both SBCs; if it is unset, the config renders byte-identical to a single-FS zone.
  - FS-1 is declared dead after 3 failed OPTIONS probes at 5 s intervals. Failback is automatic.
- **Per-call identity:** a `;fsn=1/2` Record-Route marker sends in-dialog requests to the FS that owns the call, even across an SBC flip. An FS death drops **its** calls (the media lives there), and new calls land on FS-2.
- **Zone health:** `/healthz` is any-FS, so the zone is healthy while either FS is up. If both are down it returns 503 and the zone drains.
- **Known gap:** ESL originates are pinned to East FS-1 (`FREESWITCH_ESL_HOST` = `fs-media-v2`). ESL tools, and `POST /v1/calls` if API Calling is ever re-enabled, fail while East FS-1 is down, even though inbound calls ride FS-2 (`PRODUCTION_ARCHITECTURE.md` §12 #3).
- **Ops:** `revup-fs-watchdog.timer` on every media VM pages on container death or an unresponsive ESL. Runbook: `docs/FS_MEDIA_HA_RUNBOOK.md` (its drill log is also empty).

### Per-Zone Self-Containment

Each GCP zone is a complete, independent VoIP stack. Calls NEVER cross zones for SIP/RTP.

- Each zone has:
  - 2 SBCs (active/standby).
  - 2 FreeSWITCH (FS-1 active, FS-2 hot standby; dispatcher alg 8, LIVE 2026-08-31).
  - Redis per media VM.
  - A local PG replica + PgBouncer (East reads the primary).
  - A regional NLB VIP + an internal signaling ILB VIP.
- Services VM (API, DB primary, UI, Homer) is only in East. Other zones use PG replicas for reads; writes (CDRs, provisioning, voicemail deposits) go to East.
- Cross-zone: only PG replication, HEP capture (UDP, fire-and-forget), CDR/voicemail POSTs to the East API and metrics.
- **Inbound distribution today:** the carriers (Bandwidth, Sinch) are configured with all 3 zone NLB VIPs and spread calls across them themselves.
  - A zone whose media layer is down returns 503 on `/healthz`, so its NLB drains it.
  - It also answers SIP OPTIONS from external sources with 503 (`FS_AWARE_OPTIONS`, default on), and the carriers retry another VIP.
  - **There is no DNS steering in production and no DNS config in this repo.** It is not a global NLB either: GCP global passthrough NLB doesn't exist for UDP.
- **Planned (not built): DNS steering.**
  - Infoblox DTC **Topology (geo)** steering for `crag.granitevoip.com` (customer SIP trunks), with a SIP OPTIONS health monitor that expects 200 and treats 503 as "pull the zone", TTL 30.
  - A Phase-2 LBDN `orig.granitevoip.com` for carrier origination.
  - The request to Granite's DNS team is still outstanding: `docs/INFOBLOX_DTC_CRAG_DNS_ASK.md`. `PRODUCTION_ARCHITECTURE.md` §3.5 rows for a Cloud DNS geo policy / `trunk.granitevoip.com` failover have no config behind them.

### GCE UDP Idle Timeout

GCE has a 30-second UDP idle timeout on NAT pinholes. Without keepalive:
- Kamailio: the dispatcher sends OPTIONS probes every 5 s to the carrier IPs in `dispatcher.list`:
  - Bandwidth: TC4 groups 2+3, TC1 group 4, TC2 group 5.
  - Sinch: origination 6+7, termination 8+9, redundant termination 11+12.
  - Group 10 is the peer-SBC liveness probe, not a carrier.
- FreeSWITCH: `rtp-keepalive-sec=15` sends comfort packets to keep RTP pinholes open.

## Critical Gotchas

1. **ESL password in health checks:** `fs_cli` needs `-p $ESL_PASSWORD`. Without it, health check fails, Docker restarts FS, orphaned processes hold ports.
2. **Host networking orphans:** When FS container restarts with host networking, previous process may still hold ports. Run `sudo killall -9 freeswitch` before restart.
3. **PgBouncer + asyncpg:** Must use `statement_cache_size=0` — PgBouncer transaction mode doesn't support prepared statements.
4. **React hooks ordering:** ALL React hooks must be above early return nulls. This has caused React #310 three times (the SoftphoneWidget on the Full-System branch). It applies to every component — see `docker/ui/CLAUDE.md` §13.
5. **Kamailio subst():** Cannot fix SIP header corruption in TO_CARRIER route context. Use remove_hf/append_hf instead.
6. **xml_curl fallback:** When API is unreachable, FS falls back to local XML config. Modules without local config (mod_local_stream) CRIT abort — disabled in RCF-V1.
7. **FS `-nonat` flag:** Do NOT use it. Disables ext-rtp-ip/ext-sip-ip processing, causing SDP to contain Docker internal IPs instead of public IP.
8. **Two sofia profiles required:** Internal (5080) receives inbound. External (5090) sends outbound. The internal profile does NOT apply ext-sip-ip to outbound Via/Contact — that's why external exists.
9. **local-network-acl=loopback.auto:** Required on both FS sofia profiles. Without it, Kamailio's 172.28.0.1 is treated as "local" and SDP gets the private IP instead of ext-rtp-ip.
10. **Lua package path in mod_lua:** mod_lua adds the script directory as a package searcher, which breaks `require("redis")`. All scripts must prepend explicit luarocks paths and use `loadfile()` for local modules.
11. **CDR ingest always returns 200:** The `/v1/cdrs/ingest` endpoint must ALWAYS return 200 to prevent FreeSWITCH mod_json_cdr retry storms. Handle errors internally.
12. **asyncpg explicit type casts:** All CDR INSERT parameters need explicit `::type` casts for asyncpg/PgBouncer compatibility.
13. **FreeSWITCH build is PINNED + PATCHED.** `docker/freeswitch/Dockerfile` fetches FreeSWITCH `0a54a48` and its libraries at exact SHAs, then applies `patches/0001-rcf-rtp-quality-v1.patch` (RFC 3550 loss/jitter vars). Never go back to cloning upstream HEAD (an unpinned rebuild of east-fs-2 on 2026-09-23 produced 1.11.4-dev while the fleet ran 1.11.2-dev). `build freeswitch` recompiles (~5 min/node); when only the sidecar changed, rebuild `ops-agent` only. Upgrade = bump the ARGs, rebuild one FS-2, test, roll.
14. **Media-stack deploys:** Lua scripts + conf are bind-mounted — `git pull` alone takes effect on the next call (no restart). A full media restart is `sudo docker compose -f docker-compose.media.yml down; sudo killall -9 freeswitch; sudo docker compose -f docker-compose.media.yml up -d` (never `up -d` alone after the FreeSWITCH service definition changed — it recreates FS).
15. **Kamailio rebuild must reuse the SAME compose files** (the STIR key overlay): `F=$(sudo docker inspect voip-kamailio --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' | sed 's/,/ -f /g') && sudo docker compose -f $F up -d --build kamailio`. Gate: `sleep 20; sudo docker exec voip-kamailio kamailio -c -f /etc/kamailio/kamailio.cfg` — without the sleep it races entrypoint.sh's sequential `sed -i` rendering and reports a bogus `parse error … line 380, column 1-27` (the unrendered `__STIR_SHAKEN_SIGN_DEFINE__`). Standby SBC first; each primary rebuild = one ~10-12 s NLB flip.
16. **Migrations are hand-applied** after first initdb. Before any deploy run `sudo -u postgres psql -d voip -f /opt/revup/scripts/db/check_migrations.sql` (22..57). Never re-run 43 (one-shot data backfill). 40/44/45/52/53 each replace `carrier_trunk_health`; since 45 every older file's view statement fails with "cannot drop columns from view" (the newer view stays) — after re-applying any of them, re-apply 53 last. Likewise, re-applying 50 reverts `cdr_refresh_call_quality()` to the pre-incident body, so re-apply 55 after it (`check_migrations` flags this).
17. **FS node names:** FS-1 VMs report `freeswitch_node` / `reporting_instance` = `<zone>-fs-1` (`FS_NODE_ID` in .env; `east-fs-1` on fs-media-v2); FS-2 = `<zone>-fs-2`. Dashboards match old|new names. Carrier B-leg CDR rows still say `<zone>-fs` (known follow-up).

## Environment Variable Reference (Multi-VM)

These env vars are set per-VM in `/opt/revup/.env`. Getting any of them wrong breaks call flow.

### SBC VMs (Kamailio)
| Variable | Example | Purpose |
|----------|---------|---------|
| `EXTERNAL_SIP_IP` | `34.24.133.82` | Zone NLB VIP — what the carriers see in SIP headers |
| `SBC_INTERNAL_IP` | `10.142.0.100` | This SBC's VPC IP — legacy inner Record-Route, direct-IP fallback |
| `SBC_SIGNALING_VIP` | `10.142.0.250` | Zone's internal signaling ILB VIP — inner Record-Route + extra listen. Optional; unset = legacy per-SBC behavior |
| `SBC_PEER_INTERNAL_IP` | `10.142.0.101` | The OTHER SBC's VPC IP — peer reply hand-off (`reply_route` `send_data` to the peer's tm) + dispatcher group 10 liveness probe. Optional; unset / non-IPv4 / == SBC_INTERNAL_IP (warned) = compiled out. Set on both SBCs |
| `FREESWITCH_IP` | `192.168.10.2` | Zone FS-1 VPC IP — dispatcher group 1 primary (priority 10) |
| `FREESWITCH_IP_2` | `192.168.10.3` | Zone FS-2 VPC IP — dispatcher alg-8 hot standby (priority 5). Optional; unset = single-FS render. Set it on both SBCs |
| `HOMER_IP` | `10.142.0.103` | Services VM IP — HEP capture destination |
| `DB_HOST` | `10.142.0.103` | Zone-local PgBouncer, used for trunk auth + `CARRIER_TRUST` + `X-Carrier-IP` validation SQL. East: services; West/Central: the zone db VM |
| `DB_PORT` | `6432` | PgBouncer port |
| `BANDWIDTH_PRIMARY_IP` / `BANDWIDTH_SECONDARY_IP` | `67.231.2.12` / `216.82.238.134` (defaults) | Optional — this zone's nearest / secondary Bandwidth TC4 PoP for the legacy `X-Carrier` enum. West swaps them (LA first) |
| `STIR_SHAKEN_SIGN` (+ `STIR_CERT_URL`, `STIR_KEY_PATH`) | `off` (default) | STIR signing. `on` in prod, and it needs the `docker-compose.stir-key.yml` key mount (Gotcha 15); a missing key fails open (unsigned) |
| `STIR_SHAKEN_VERIFY` | `off` (default) | Own-crypto inbound verify — deployed dark, canary pending |
| `FS_AWARE_OPTIONS` | `1` (default) | OPTIONS from external sources answer 503 while no local FS is up; `0` = legacy always-200. `/healthz` is fs-aware regardless |
| `BW_CPS_LIMIT` | `100` (default) | Optional — per-carrier-IP inbound CPS backstop (`bw_cps` htable, 503 + Retry-After when exceeded) |
| `TESTING_IP` | (unset) | Optional — trusted SIPp test source IP. UNSET in production (defaults to 255.255.255.255 = disabled) |
| `BANDWIDTH_TC1_NY` etc. | (defaults) | Optional — TC1/TC2 PoP IPs (`BANDWIDTH_TC1_NY/TC1_ATL/TC2_DAL/TC2_LA`), env-templated with East defaults |
| `SINCH_DENVER_IP` | `206.146.100.24` (default) | Optional — Sinch Denver origination IP (trust + dispatcher group 6), env-templated with production default |
| `SINCH_CHICAGO_IP` | `206.146.101.39` (default) | Optional — Sinch Chicago origination IP (trust + dispatcher group 7), env-templated with production default |
| `SINCH_LD_IP` / `SINCH_TF_IP` | `206.146.98.26` / `206.146.100.26` (defaults) | Optional — Sinch termination IPs, dispatcher keepalive groups 8 / 9 only (egress is table-driven via `carrier_trunks`) |
| `SINCH_LD2_IP` / `SINCH_TF2_IP` | `206.146.100.25` / `206.146.98.25` (defaults) | Optional — Sinch REDUNDANT termination IPs, dispatcher groups 11 / 12 only |
| `SINCH_TF_ATL_IP` / `SINCH_TF_DEN_IP` | `206.146.98.25` / `206.146.100.25` (defaults) | Optional — Sinch 8XX-T toll-free origination IPs (static trust, no probe) |
| `TF_TEST_TNS` | (empty) | Optional — comma list of 10-digit test TNs admitted non-8YY from the TF orig trunks. Prod: `5595335873,5595335908` until real TFNs are live |
| `VIP_EGRESS` | `off` (default) | Optional — `on` (dedicated signaling-VIP mode only; entrypoint forces off otherwise) makes carrier-bound INVITEs that arrived on the signaling ILB VIP egress from the external NLB VIP (`$fs` guard in `route[TO_CARRIER]`), joining the already VIP-sourced ACK/BYE/response class. Direct-IP ingress (FS failover attempts, ESL originates) keeps own-public-IP egress, so the 6 SBC public IPs STAY whitelisted at carriers. Enable on both SBCs of a zone |

### Media VM (FreeSWITCH + Redis)
| Variable | Example | Purpose |
|----------|---------|---------|
| `EXTERNAL_SIP_IP` | `34.139.119.135` | This VM's public IP — SDP c= line, Via, Contact |
| `EXTERNAL_RTP_IP` | `34.139.119.135` | Same as above — RTP source IP |
| `SBC_PROXY_IP` | `10.142.0.250` | Zone signaling ILB VIP — outbound bridge target (always the ACTIVE SBC) |
| `SBC_PROXY_IP_FAILOVER` | `10.142.0.100` | SBC-1 direct VPC IP — ILB-bypass fallback bridge target |
| `DB_HOST` | `10.142.0.103` | Zone-local PgBouncer — DID lookups + `carrier_trunks` (East: services; West/Central: the zone db VM) |
| `DB_PORT` | `6432` | PgBouncer port |
| `ESL_PASSWORD` | (secret) | Event Socket password — must match API config |
| `BRIDGE_PROGRESS_TIMEOUT` | `10` (default) | Optional — per-attempt carrier PDD bound (progress_timeout) in the failover loop |
| `FS_ZONE` | `east` (default) | `west` / `central` on those zones — selects the `priority_<zone>` column for the termination order |
| `FS_NODE_ID` | `east-fs-1` | `<zone>-fs-1` / `<zone>-fs-2` — CDR `freeswitch_node` + metrics identity (Gotcha 17) |
| `API_CALLING_ENABLED` | `false` (default) | API Calling is retired; only exactly `true` re-enables it (it must match the services VM and the UI constant) |
| `RCF_FROM_PASSTHROUGH` | `off` (default) | Original caller in the carrier From. Off until the per-PoP canary; enable order is in `docker/freeswitch/scripts/CLAUDE.md` |

Voicemail on media VMs needs no env var. It needs the ingest header file `/opt/revup/secrets/fs-voicemail/vm_ingest.header` (root 0600) and the compose `/dev/shm/vm` tmpfs (see `docker/freeswitch/CLAUDE.md`).

### Services VM (API + UI + Homer)
| Variable | Example | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | `postgresql://api:...@host.docker.internal:6432/voip` | PgBouncer via host network |
| `FREESWITCH_ESL_HOST` | `192.168.10.2` | East FS-1 VPC IP — ESL commands. This pins ESL to FS-1 (the known gap under FreeSWITCH Media HA) |
| `FREESWITCH_ESL_PASSWORD` | (secret) | Must match FS ESL_PASSWORD |
| `JWT_SECRET_KEY` | (secret) | Required — API crashes without it |
| `SBC_PROXY_IP` | `10.142.0.250` | East signaling ILB VIP — the bridge target `esl_client.originate_call` builds (always the ACTIVE SBC; it was SBC-1's direct IP, with no failover). Today it is reachable only through the retired `/v1/calls`; keep it set for a re-enable |
| `API_CALLING_ENABLED` | `false` (default) | API Calling retired — `/v1/calls` + API tiers unmounted unless exactly `true` |
| `VOICEMAIL_TRANSCRIPTION_ENABLED` (+ `VOICEMAIL_STT_*`) | unset = off | Voicemail transcription kill switch. `VOICEMAIL_STT_LOCATION` must be `us`. Each mailbox is also an admin opt-in. Full list: `docker/api/CLAUDE.md` |
| `VOICEMAIL_KMS_PROJECT` (+ `_LOCATION` us-east1, `_KEYRING` voicemail-prod, `VOICEMAIL_BUCKET` voip-voicemail) | `rugged-night-193017` | Encrypted voicemail: per-customer Cloud KMS keys + GCS ciphertext bucket. Missing ⇒ voicemail endpoints 503 (fail-closed, never plaintext). `VOICEMAIL_KMS_PROVIDER` stays `gcpkms`; optional `VOICEMAIL_IMPERSONATE_SA` |
| `VOICEMAIL_PLAYBACK_SECRET` | (secret) | 120 s playback-URL key; ≥ 32 chars, ≠ `JWT_SECRET_KEY` |
| `INGEST_SHARED_SECRET` | (secret) | `X-Ingest-Secret` FS sends on `/v1/voicemail/fs/*` (same value as `/opt/revup/secrets/fs-voicemail/vm_ingest.header` on every FS node); ≥ 32 chars, unset ⇒ 503 |

## GCP Production Topology (3 zones — East / West / Central, all LIVE 2026-07-23)

GCP Project: `rugged-night-193017` (a **shared** project — TED and other teams' resources live here too). There are 16 production VMs (6 East, 5 West, 5 Central) plus the banked `west-loadtest`. All 3 zones carry carrier traffic.
- **Each zone:** 2 Kamailio SBCs (active/standby) + 2 FreeSWITCH (FS-1 active / FS-2 hot standby) + 1 local PG replica. The PG **primary + API + UI + Homer stay East-only**.
- **Inbound:** Bandwidth and Sinch point at all 3 regional NLB VIPs and distribute across them; there is no DNS steering (see Per-Zone Self-Containment).
- **Outbound:** each zone uses its own `carrier_trunks` priority order: nearest Bandwidth PoP first, then the other PoP, then the Sinch LD backups. 8YY goes to Sinch TF only.

### East — us-east1-b (holds the PG primary + API + UI + Homer)
| VM Name | Role | Machine Type | Internal IP | External IP | Subnet | Tags |
|---------|------|-------------|-------------|-------------|--------|------|
| `poc-custom-voip` | SBC-1 | n2-standard-4 | 10.142.0.100 | 34.74.71.32 | default | bypass-vpn, custom-voip, lb-health-check, voip-sbc |
| `kam-g2` | SBC-2 | e2-standard-4 | 10.142.0.101 | 35.243.136.35 | default | bypass-vpn, lb-health-check, voip-sbc |
| `fs-media-v2` | FreeSWITCH FS-1 (active) + Redis | e2-standard-8 | 192.168.10.2 | 34.139.119.135 | voip-media (192.168.10.0/24) | bypass-vpn, voip-media |
| `east-fs-2` | FreeSWITCH FS-2 (hot standby) | e2-standard-8 | 192.168.10.3 | 35.196.226.123 | voip-media (192.168.10.0/24) | bypass-vpn, voip-media |
| `services` | Services (PG **primary** + API + UI + Homer + PgBouncer) | e2-highmem-4 (32 GB) | 10.142.0.103 | 34.26.57.37 | default | lb-health-check, voip-services |
| `east-db-standby` | PG hot standby (HA, us-east1-**c**) | e2-standard-4 | 10.142.0.87 | — | default | bypass-vpn, voip-db-standby |

East NLB VIP `34.24.133.82` (`sbc-vip-udp`/`-tcp`, 5060) · instance group `sbc-group` · signaling ILB VIP `10.142.0.250`. LD egress order: Bandwidth **Dallas** (67.231.2.12) → LA → Sinch backups.

### West — us-west1-b
| VM Name | Role | Machine Type | Internal IP | External IP | Subnet | Tags |
|---------|------|-------------|-------------|-------------|--------|------|
| `west-sbc-1` | SBC-1 | e2-standard-4 | 10.138.0.100 | 8.229.41.59 | default | bypass-vpn, lb-health-check, voip-sbc |
| `west-sbc-2` | SBC-2 | e2-standard-4 | 10.138.0.101 | 136.117.230.166 | default | bypass-vpn, lb-health-check, voip-sbc |
| `west-fs` | FreeSWITCH FS-1 (active) + Redis | e2-standard-8 | 192.168.20.2 | 8.229.177.165 | voip-media-west (192.168.20.0/24) | bypass-vpn, voip-media |
| `west-fs-2` | FreeSWITCH FS-2 (hot standby) | e2-standard-8 | 192.168.20.3 | 35.197.95.171 | voip-media-west (192.168.20.0/24) | bypass-vpn, voip-media |
| `west-db` | PG replica + PgBouncer | e2-standard-4 | 10.138.0.2 | 136.118.180.103 | default | bypass-vpn, voip-db-standby |
| `west-loadtest` | SIPp load-gen (banked harness) | e2-standard-4 | 10.138.0.3 | 104.198.3.25 | default | bypass-vpn, voip-loadtest |

West NLB VIP `35.252.214.40` (`west-sbc-vip-udp`/`-tcp`) · backend service `west-sbc-backend` + `west-sbc-group` · signaling ILB VIP `10.138.0.250`. LD egress order: Bandwidth **LA** (216.82.238.134) → Dallas → Sinch backups.

### Central — us-central1-b
| VM Name | Role | Machine Type | Internal IP | External IP | Subnet | Tags |
|---------|------|-------------|-------------|-------------|--------|------|
| `central-sbc-1` | SBC-1 | e2-standard-4 | 10.128.0.100 | 34.41.188.100 | default | bypass-vpn, lb-health-check, voip-sbc |
| `central-sbc-2` | SBC-2 | e2-standard-4 | 10.128.0.101 | 35.184.151.64 | default | bypass-vpn, lb-health-check, voip-sbc |
| `central-fs` | FreeSWITCH FS-1 (active) + Redis | e2-standard-8 | 192.168.30.2 | 35.253.103.114 | voip-media-central (192.168.30.0/24) | bypass-vpn, voip-media |
| `central-fs-2` | FreeSWITCH FS-2 (hot standby) | e2-standard-8 | 192.168.30.3 | 34.63.100.161 | voip-media-central (192.168.30.0/24) | bypass-vpn, voip-media |
| `central-db` | PG replica + PgBouncer | e2-standard-4 | 10.128.0.2 | 34.69.170.41 (ephemeral) | default | bypass-vpn, voip-db-standby |

Central NLB VIP `35.253.133.230` (`central-sbc-vip-tcp`/`-udp`) · backend service `central-sbc-backend` + `central-sbc-group` · signaling ILB VIP `10.128.0.250`. LD egress order: Bandwidth **Dallas** (67.231.2.12, the default) → LA → Sinch backups. `central-db`'s reserved external IP `136.112.210.141` was detached in a 2026-09-01 stop/start; the VM runs on an ephemeral IP (`PRODUCTION_ARCHITECTURE.md` §12 #1).

**DB replication:** the East primary (`services` 10.142.0.103) streams to `east-db-standby` (HA), `west-db` and `central-db` via physical slots `east_standby`/`west_standby`/`central_standby`. The legacy `sandbox_replica` slot (fs-media 10.142.0.102) is **absent** from the primary (`PRODUCTION_ARCHITECTURE.md` §8.1, verified 2026-09-04). Slot WAL growth is guarded by `revup-slot-wal-guard.timer`; check every slot with `pg_replication_slots` after any primary incident. Each zone's FS/SBC read DID lookups from its **local** replica through a local PgBouncer (`:6432`, scram); **all writes (CDRs, provisioning) go to the East primary via the API** (`API_HOST`/`HOMER_IP` stay East in every zone's `.env`). Backups (pgBackRest full+WAL PITR, pg_dump, disk snapshots, CDR archive) run on the primary → `gs://revup-db-backups`.

**Homer HEP:** all zones' SBCs + FS send HEP to the East Homer (`10.142.0.103:9060`, allowed by the tag-to-tag `voip-internal` firewall); IP→name aliases in `docker/homer/scripts/ip-alias.lua`.

Static IPs are reserved per node (`{node}-ip`, incl. the FS-2s; FS-2 internal IPs as `{zone}-fs-2-internal` = 192.168.x.3), plus the three external VIPs (`sbc-vip`/`west-sbc-vip`/`central-sbc-vip`) and the three internal signaling-VIP addresses (.250). Note: East VM names are legacy (`poc-custom-voip`, `kam-g2`, `fs-media-v2`); West/Central follow the `{zone}-sbc-N` / `{zone}-fs[-2]` / `{zone}-db` convention. FS-2s are machine-image clones of their FS-1. The fleet is not yet under OpenTofu state (Phase 5 import pending).

## Infrastructure as Code

OpenTofu is used for a few self-contained roots. The VoIP fleet itself (VMs, NLBs/ILBs, firewall) is still hand-managed in GCP. `infra/OPENTOFU_PLAN.md` is the blueprint for bringing it under tofu.

- **Live roots** (state in `gs://revup-tofu-state`, GCS with versioning, one prefix each):
  - `infra/monitoring` (`voip-monitoring`): GCM alerting, incl. `sbc_failover.tf`.
  - `infra/backups` (`voip-backups`).
  - `infra/voicemail` (`voip-voicemail`): KMS keyrings + ciphertext bucket.
- **Planned (not built):** the `voip-region` (per-region VMs + NLB), `firewall` (VPC-wide) and `global-lb` modules, plus the import of the existing fleet.
- **Safety:** `prevent_destroy = true` on all VMs and static IPs in the planned modules. Never run `tofu destroy`. The owner runs every `tofu`/`gcloud` command; agents deliver files plus a command list. The project is shared, so never change shared resources without explicit approval.
- **Secrets are NOT in OpenTofu.** They live in hand-managed `.env` files and `/opt/revup/secrets/` on each VM. The Ansible layer in the plan is not built.
