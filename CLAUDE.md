# Custom VoIP Platform — RCF-V1

## What This Is

Production Remote Call Forwarding (RCF) platform built for Granite Telecommunications.
Nationwide utility company deployment — carrier-grade, no POC shortcuts.

**Branch:** `RCF-V1` (production). `Full-System` branch has the full UCaaS stack (WebRTC, voicemail, conferencing, chat) — not deployed in production.

## Architecture

3-zone deployment in GCP — **East (us-east1-b), West (us-west1-b), and Central (us-central1-b) are all LIVE as of 2026-07-23.** Each zone is self-contained for SIP/RTP — calls never cross zones. (Started single-zone East; the 3-datacenter expansion is complete — see `GCP Production Topology` below and `docs/NATIONWIDE_PRODUCTION_ROLLOUT_PLAN.md`.)

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
5. Lua: PostgreSQL DID lookup → get forward_to number
6. **On-net check:** resolve `forward_to` against the `number_routing` view. If it's a platform-owned DID → deliver internally to that DID's product handler (see On-Net Routing below), NO carrier hairpin. If not ours → step 7.
7. FreeSWITCH: bridge via `sofia/external/$forward_to@$SBC_PROXY_IP:5060`
8. Kamailio: reads X-Carrier header → routes to Bandwidth Dallas or LA
9. Bandwidth: delivers call to destination PSTN number

### On-Net (Internal) Routing

When a forwarded/placed destination is a number the platform **owns** (any product), FreeSWITCH short-circuits the carrier and delivers the call into that DID's own product handler instead of hairpinning out through Bandwidth and back in. Design: `docs/ONNET_ROUTING_DESIGN.md`.

- **Oracle:** the `number_routing` view (`22_number_routing.sql`) — one `UNION ALL` over `rcf_numbers`/`api_dids`/`trunk_dids` joined to `customers`. `resolve_destination(did)` in `db_client.lua` does a single indexed point lookup (0 or 1 row). The view is **unfiltered** on enabled/active so the resolver can tell "not ours" (0 rows → keep carrier path) from "ours but disabled/suspended" (row present → hard reject).
- **Chain:** an RCF DID whose `forward_to` is another RCF DID resolves the whole chain **in memory** (DB lookups only, NO SIP per hop) until a terminal (off-net PSTN / local ext / trunk DID / API DID). **Exactly one** carrier B-leg is emitted, and only if the terminal is off-net PSTN.
- **Terminators** (`inbound_router.lua`): `terminate_rcf` / `terminate_api` / `terminate_trunk`, dispatched via a `TERMINATORS` map. A future product enrolls by adding a `number_routing` arm + a terminator (no rewrite of detection).
- **Billing:** one CDR records BOTH parties — `customer_id`=terminal (so `rate_cdr()` is unchanged), plus `origin_customer_id`/`terminating_customer_id`/`on_net`/`on_net_hops` (`23_onnet_cdr_columns.sql`). Off-net: `origin_customer_id==customer_id`, `on_net=false`.
- **Caller-ID:** honors each DID's `pass_caller_id`, composed across the chain — "last `false` hop wins" (the masking DID closest to the terminal shows). Outbound From stays the terminal DID for Bandwidth auth.
- **Hard reject (no carrier fallback):** disabled/suspended terminal → `CALL_REJECTED` (603); loop (visited-set re-entry) or `hops>5` → `EXCHANGE_ROUTING_ERROR` (483). Sets `lua_routed=true` so the dialplan doesn't mask with 404.
- **Migrations** apply on the prod primary (init scripts only run on first initdb) and replicate to all zones: `sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/init/22_number_routing.sql` and `.../23_onnet_cdr_columns.sql`.

## Account Types

| Type | Description | Features |
|------|------------|----------|
| `rcf` | Remote Call Forwarding | DID → forward_to mapping only. No UI access for end customer. |
| `api` | API Calling | Programmable voice via webhooks |
| `trunk` | SIP Trunking | IP-authenticated SIP trunks |
| `hybrid` | API + Trunk | Both API and trunk features |
| `ucaas` | UCaaS (Full-System branch only) | WebRTC, voicemail, conferencing, chat |

**RCF customers NEVER see UCaaS features.** Only api/trunk/hybrid get those (Full-System branch).

**On-net terminal is product-agnostic.** Any product's DID (rcf/api/trunk) can be the terminal of an on-net (internal) call — a forward that lands on a platform-owned number is delivered into that number's own handler (RCF bridge, API voice app, or trunk-to-PBX) instead of hairpinning through the carrier. This is a routing/billing optimization only; it does NOT change what any customer sees in the UI, and RCF customers still never see UCaaS. See On-Net Routing above and `docs/ONNET_ROUTING_DESIGN.md`.

## Testing

- **Type-check before push:** `tsc --noEmit` — unused imports break Docker build
- **Do not push until tested** — user confirms locally first
- **Live call test DID:** +16174544217 → forwards to +17744045256

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
- **Fix:** FS uses direct SBC IPs for outbound bridging, not the NLB VIP. Env vars `SBC_PROXY_IP` (primary SBC) and `SBC_PROXY_IP_FAILOVER` (secondary SBC) point to the SBCs' VPC IPs.
- **NLB is for inbound only:** Bandwidth → NLB VIP → SBC. All FS → SBC traffic uses direct IPs.

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

### SBC Failover — TCP Pre-Check + 4-Attempt Loop

FreeSWITCH implements SBC health detection and multi-carrier failover in `inbound_router.lua`:

1. **TCP pre-check (cached):** Before bridging, FS opens a TCP socket to the SBC on port 5060. If the connection fails, the SBC is marked dead in < 1 second. This avoids the 30-second SIP timeout waiting for a dead SBC. Probe results are cached process-wide via FreeSWITCH global variables: reachable cached 30s, unreachable cached 10s (so a recovered SBC returns within 10s). Steady state is ~2 probes per SBC per minute instead of up to 4 socket opens per call.
2. **4-attempt failover loop:** 2 SBCs × 2 carriers = 4 bridge attempts. Order: SBC1+primary carrier (Dallas) → SBC2+primary carrier (Dallas) → SBC1+secondary carrier (LA) → SBC2+secondary carrier (LA).
3. **progress_timeout=10s:** This timeout bounds carrier PDD (Post-Dial Delay) — the total time allowed for the carrier to send back a provisional response (180/183). Once ringing starts, the call may ring up to call_timeout. Env-tunable via `BRIDGE_PROGRESS_TIMEOUT` (default 10). Do NOT use `originate_timeout` here — it caps total time-to-ANSWER including ring time, which cancels still-ringing forwarded calls.

### SIP Header Handling — What Works and What Doesn't

These are specific Kamailio behaviors that caused production bugs:

- **subst() cannot fix Via corruption.** Kamailio's tm module re-applies `;received=` and `;rport=` AFTER the routing script runs. Attempting to strip FS's Via with `remove_hf("Via")` + `msg_apply_changes()` leaves orphaned annotation text that merges with the next header. **Solution:** Leave FS's Via in place. Two Vias is valid per RFC 3261.
- **record_route() must come AFTER msg_apply_changes() in TO_CARRIER.** The reverse order causes `msg_apply_changes()` to silently fail with "cannot apply msg changes after adding record-route header", which means ALL header cleanup is silently ignored.
- **Contact must be added BEFORE msg_apply_changes().** The dialog module reads Contact during `record_route()` to create leg info. If Contact is absent, you get "bad sip message or missing Contact hdr" → no dialog → ACK routing breaks → BYE returns 404.
- **NAT detection must NOT apply to FreeSWITCH traffic.** `force_rport()` adds `;received=172.28.0.10` to FS's Via, leaking Docker IPs. `fix_nated_contact()` overwrites FS's clean Contact with Docker source IP. NAT_DETECT is ONLY for inbound from Bandwidth.
- **topoh module is disabled.** It conflicts with manual header cleanup by adding TH= markers. All topology hiding is done via explicit `remove_hf()` + `append_hf()` + SDP `subst_body()`.

### Session Timer Normalization

Bandwidth sometimes sends `Session-Expires: 30` in 200 OK (below RFC 4028 minimum of 90). FreeSWITCH has `minimum-session-expires=90` and silently ignores any value below that, never setting up the refresh timer. Bandwidth then kills the call when its 30-second timer expires.

- **Fix:** Kamailio REPLY_HANDLER normalizes all carrier Session-Expires to 1800.
- **Both sides:** FS exports `sip_session_timeout=1800` and `sip_min_session_expires=90` to the B-leg. Kamailio adds `Session-Expires: 1800;refresher=uac` and `Min-SE: 90` on outbound INVITEs.

### Bandwidth Carrier Behaviors

- **Duplicate INVITEs:** Bandwidth sends the same inbound call from multiple edge proxies simultaneously (different source IPs, different Call-IDs, same From/To). Kamailio deduplicates via `bw_dedup` htable (key=FromUser::ToUser, TTL=3s), responding 482 Merged to duplicates.
- **Carrier IPs:** Dallas 67.231.2.12 (primary), Los Angeles 216.82.238.134 (secondary). X-Carrier header from FS tells Kamailio which to use.
- **422 handling:** If Bandwidth rejects with 422 (Session Interval Too Small), Kamailio retries with Session-Expires: 3600, Min-SE: 900.
- **5xx failover:** On 500/503/408/480/404 from primary carrier IP, Kamailio fails over to alternate Bandwidth IP (flag 8 prevents infinite loop).

### FreeSWITCH Media Handling

- **No proxy_media in RCF path.** Default media mode works correctly. proxy_media was removed after the Cloud NAT fix resolved the actual audio issue.
- **No sip_enable_soa=false.** SOA stays enabled for proper B-leg media setup. The "duplicate SDP answer" in 200 OK is cosmetic in default media mode.
- **183 SDP passthrough works.** PSTN ringback flows through naturally in default media mode. No special handling needed.
- **Gateway syntax deprecated.** All outbound bridges use `sofia/external/dest@proxy:5060` with X-Carrier header. The old `sofia/gateway/carrier/dest` syntax produced corrupted Contact headers (`sip:gw+carrier_primary@...`).
- **Redis code removed from inbound_router.lua (RCF-V1).** The redis-lua library has connection pooling issues inside mod_lua's threading model. The Redis route cache, fraud prefix check, and velocity limiting were deleted (not just disabled) — calls route via PostgreSQL lookup only. Re-adding requires a synchronous Redis client; the old code is in git history. trunk_outbound/api_outbound still load redis_client fail-open.
- **mod_local_stream disabled.** Requires `local_stream.conf.xml` which doesn't exist. When xml_curl can't reach the API during startup, the missing config causes CRIT abort. RCF uses `silence_stream://-1` instead.

### GCE Hairpin NAT

FreeSWITCH on the media VM cannot send to its own public IP via GCE's network fabric (hairpin NAT). The entrypoint.sh adds the public IP to the loopback interface:

```bash
ip addr add "${PUBLIC_IP}/32" dev lo
```

This allows FS to reach Kamailio's Record-Route address when Kamailio is on the same VM (dev) or when FS needs to send to its own advertised address. Requires `NET_ADMIN` Docker capability.

### Per-Zone Self-Containment

Each GCP zone is a complete, independent VoIP stack. Calls NEVER cross zones for SIP/RTP.

- Each zone has: 2 SBCs + 1 FreeSWITCH + 1 Redis + regional NLB
- Services VM (API, DB, Homer) is only in East. Other zones use PG replicas.
- Cross-zone: only PG replication traffic and HEP capture (UDP, fire-and-forget).
- DNS geo-routing (Cloud DNS routing policies) directs Bandwidth to the nearest zone's NLB VIP. NOT global NLB — GCP global passthrough NLB doesn't exist for UDP.

### GCE UDP Idle Timeout

GCE has a 30-second UDP idle timeout on NAT pinholes. Without keepalive:
- Kamailio: Dispatcher sends OPTIONS probes every 5s to Bandwidth IPs (groups 2+3 in dispatcher.list).
- FreeSWITCH: `rtp-keepalive-sec=15` sends comfort packets to keep RTP pinholes open.

## Critical Gotchas

1. **ESL password in health checks:** `fs_cli` needs `-p $ESL_PASSWORD`. Without it, health check fails, Docker restarts FS, orphaned processes hold ports.
2. **Host networking orphans:** When FS container restarts with host networking, previous process may still hold ports. Run `sudo killall -9 freeswitch` before restart.
3. **PgBouncer + asyncpg:** Must use `statement_cache_size=0` — PgBouncer transaction mode doesn't support prepared statements.
4. **SoftphoneWidget hooks:** ALL React hooks must be above early return nulls. Has caused React #310 three times.
5. **Kamailio subst():** Cannot fix SIP header corruption in TO_CARRIER route context. Use remove_hf/append_hf instead.
6. **xml_curl fallback:** When API is unreachable, FS falls back to local XML config. Modules without local config (mod_local_stream) CRIT abort — disabled in RCF-V1.
7. **FS `-nonat` flag:** Do NOT use it. Disables ext-rtp-ip/ext-sip-ip processing, causing SDP to contain Docker internal IPs instead of public IP.
8. **Two sofia profiles required:** Internal (5080) receives inbound. External (5090) sends outbound. The internal profile does NOT apply ext-sip-ip to outbound Via/Contact — that's why external exists.
9. **local-network-acl=loopback.auto:** Required on both FS sofia profiles. Without it, Kamailio's 172.28.0.1 is treated as "local" and SDP gets the private IP instead of ext-rtp-ip.
10. **Lua package path in mod_lua:** mod_lua adds the script directory as a package searcher, which breaks `require("redis")`. All scripts must prepend explicit luarocks paths and use `loadfile()` for local modules.
11. **CDR ingest always returns 200:** The `/v1/cdrs/ingest` endpoint must ALWAYS return 200 to prevent FreeSWITCH mod_json_cdr retry storms. Handle errors internally.
12. **asyncpg explicit type casts:** All CDR INSERT parameters need explicit `::type` casts for asyncpg/PgBouncer compatibility.

## Environment Variable Reference (Multi-VM)

These env vars are set per-VM in `/opt/revup/.env`. Getting any of them wrong breaks call flow.

### SBC VMs (Kamailio)
| Variable | Example | Purpose |
|----------|---------|---------|
| `EXTERNAL_SIP_IP` | `34.24.133.82` | NLB VIP — what Bandwidth sees in SIP headers |
| `SBC_INTERNAL_IP` | `10.142.0.100` | This SBC's VPC IP — used in inner Record-Route |
| `FREESWITCH_IP` | `192.168.10.2` | FS media VM VPC IP — dispatcher target |
| `HOMER_IP` | `10.142.0.103` | Services VM IP — HEP capture destination |
| `DB_HOST` | `10.142.0.103` | Services VM IP — trunk auth SQL |
| `DB_PORT` | `6432` | PgBouncer port |
| `BW_CPS_LIMIT` | `100` (default) | Optional — per-carrier-IP inbound CPS backstop (`bw_cps` htable, 503 + Retry-After when exceeded) |
| `TESTING_IP` | (unset) | Optional — trusted SIPp test source IP. UNSET in production (defaults to 255.255.255.255 = disabled) |
| `BANDWIDTH_TC1_NY` etc. | (defaults) | Optional — TC1/TC2 PoP IPs (`BANDWIDTH_TC1_NY/TC1_ATL/TC2_DAL/TC2_LA`), env-templated with East defaults |

### Media VM (FreeSWITCH + Redis)
| Variable | Example | Purpose |
|----------|---------|---------|
| `EXTERNAL_SIP_IP` | `34.139.119.135` | This VM's public IP — SDP c= line, Via, Contact |
| `EXTERNAL_RTP_IP` | `34.139.119.135` | Same as above — RTP source IP |
| `SBC_PROXY_IP` | `10.142.0.100` | Primary SBC VPC IP — outbound bridge target |
| `SBC_PROXY_IP_FAILOVER` | `10.142.0.101` | Secondary SBC VPC IP — failover bridge target |
| `DB_HOST` | `10.142.0.103` | Services VM IP — DID lookups |
| `DB_PORT` | `6432` | PgBouncer port |
| `ESL_PASSWORD` | (secret) | Event Socket password — must match API config |
| `BRIDGE_PROGRESS_TIMEOUT` | `10` (default) | Optional — per-attempt carrier PDD bound (progress_timeout) in the failover loop |

### Services VM (API + UI + Homer)
| Variable | Example | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | `postgresql://api:...@host.docker.internal:6432/voip` | PgBouncer via host network |
| `FREESWITCH_ESL_HOST` | `192.168.10.2` | FS media VM VPC IP — ESL commands |
| `FREESWITCH_ESL_PASSWORD` | (secret) | Must match FS ESL_PASSWORD |
| `JWT_SECRET_KEY` | (secret) | Required — API crashes without it |
| `SBC_PROXY_IP` | `10.142.0.100` | Primary SBC — for ESL originate routing |

## GCP Production Topology (3 zones — East / West / Central, all LIVE 2026-07-23)

GCP Project: `rugged-night-193017`. All 3 zones carry carrier traffic. Each zone = 2 Kamailio SBCs + 1 FreeSWITCH + 1 local PG replica; the PG **primary + API + UI + Homer stay East-only**. Inbound: Bandwidth points at all 3 regional NLB VIPs (currently **distributing** across them). Outbound: per-zone nearest Bandwidth PoP.

### East — us-east1-b (holds the PG primary + API + UI + Homer)
| VM Name | Role | Machine Type | Internal IP | External IP | Subnet | Tags |
|---------|------|-------------|-------------|-------------|--------|------|
| `poc-custom-voip` | SBC-1 | n2-standard-4 | 10.142.0.100 | 34.74.71.32 | default | bypass-vpn, custom-voip, lb-health-check, voip-sbc |
| `kam-g2` | SBC-2 | e2-standard-4 | 10.142.0.101 | 35.243.136.35 | default | bypass-vpn, lb-health-check, voip-sbc |
| `fs-media-v2` | FreeSWITCH | e2-standard-8 | 192.168.10.2 | 34.139.119.135 | voip-media (192.168.10.0/24) | bypass-vpn, voip-media |
| `services` | Services (PG **primary** + API + UI + Homer + PgBouncer) | e2-standard-4 | 10.142.0.103 | 34.26.57.37 | default | lb-health-check, voip-services |
| `east-db-standby` | PG hot standby (HA, us-east1-**c**) | e2-standard-4 | 10.142.0.87 | — | default | bypass-vpn, voip-db-standby |

East NLB VIP `34.24.133.82` (`sbc-vip-udp`/`-tcp`, 5060) · instance group `sbc-group`. Egress PoP: **Dallas** (67.231.2.12).

### West — us-west1-b
| VM Name | Role | Machine Type | Internal IP | External IP | Subnet | Tags |
|---------|------|-------------|-------------|-------------|--------|------|
| `west-sbc-1` | SBC-1 | e2-standard-4 | 10.138.0.100 | 8.229.41.59 | default | bypass-vpn, lb-health-check, voip-sbc |
| `west-sbc-2` | SBC-2 | e2-standard-4 | 10.138.0.101 | 136.117.230.166 | default | bypass-vpn, lb-health-check, voip-sbc |
| `west-fs` | FreeSWITCH | e2-standard-8 | 192.168.20.2 | 8.229.177.165 | voip-media-west (192.168.20.0/24) | bypass-vpn, voip-media |
| `west-db` | PG replica + PgBouncer | e2-standard-4 | 10.138.0.2 | 136.118.180.103 | default | bypass-vpn, voip-db-standby |
| `west-loadtest` | SIPp load-gen (banked harness) | e2-standard-4 | 10.138.0.3 | 104.198.3.25 | default | bypass-vpn, voip-loadtest |

West NLB VIP `35.252.214.40` (`west-sbc-vip-udp`/`-tcp`) · backend service `west-sbc-backend` + `west-sbc-group`. Egress PoP: **LA** (216.82.238.134).

### Central — us-central1-b
| VM Name | Role | Machine Type | Internal IP | External IP | Subnet | Tags |
|---------|------|-------------|-------------|-------------|--------|------|
| `central-sbc-1` | SBC-1 | e2-standard-4 | 10.128.0.100 | 34.41.188.100 | default | bypass-vpn, lb-health-check, voip-sbc |
| `central-sbc-2` | SBC-2 | e2-standard-4 | 10.128.0.101 | 35.184.151.64 | default | bypass-vpn, lb-health-check, voip-sbc |
| `central-fs` | FreeSWITCH | e2-standard-8 | 192.168.30.2 | 35.253.103.114 | voip-media-central (192.168.30.0/24) | bypass-vpn, voip-media |
| `central-db` | PG replica + PgBouncer | e2-standard-4 | 10.128.0.2 | 136.112.210.141 | default | bypass-vpn, voip-db-standby |

Central NLB VIP `35.253.133.230` (`central-sbc-vip-tcp`/`-udp`) · backend service `central-sbc-backend` + `central-sbc-group`. Egress PoP: **Dallas** (67.231.2.12, the default).

**DB replication:** the East primary (`services` 10.142.0.103) streams to `east-db-standby` (HA), `west-db`, `central-db`, and `sandbox_replica` (fs-media 10.142.0.102) via physical slots `east_standby`/`west_standby`/`central_standby`/`sandbox_replica`. Each zone's FS/SBC read DID lookups from its **local** replica through a local PgBouncer (`:6432`, scram); **all writes (CDRs, provisioning) go to the East primary via the API** (`API_HOST`/`HOMER_IP` stay East in every zone's `.env`). Backups (pgBackRest full+WAL PITR, pg_dump, disk snapshots, CDR archive) run on the primary → `gs://revup-db-backups`.

**Homer HEP:** all zones' SBCs + FS send HEP to the East Homer (`10.142.0.103:9060`, allowed by the tag-to-tag `voip-internal` firewall); IP→name aliases in `docker/homer/scripts/ip-alias.lua`.

Static IPs are reserved per node (`{node}-ip`) + the three VIPs (`sbc-vip`/`west-sbc-vip`/`central-sbc-vip`). Note: East VM names are legacy (`poc-custom-voip`, `kam-g2`, `fs-media-v2`); West/Central follow the `{zone}-sbc-1`/`-fs`/`-db` convention. Not yet under OpenTofu state (Phase 5 import pending).

## Infrastructure as Code

OpenTofu manages GCP infrastructure. Plans and module blueprints are in `infra/`. See `infra/OPENTOFU_PLAN.md` for the complete HCL reference and import strategy.

- **State bucket:** `gs://revup-tofu-state` (GCS with versioning)
- **Module structure:** `voip-region` (per-region VMs + NLB), `firewall` (VPC-wide), `global-lb` (Phase 2)
- **Import strategy:** East resources imported into state (not recreated). West/Central created fresh.
- **Safety:** `prevent_destroy = true` on all VMs and static IPs. Never run `tofu destroy`.
- **Secrets are NOT in OpenTofu.** They live in `.env` files on VMs, managed by Ansible.
