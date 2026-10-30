# FreeSWITCH Docker Build -- RCF-V1 Production

## What This Is

FreeSWITCH media server for the RevUp voice platform. Stripped to Remote Call Forwarding (RCF) only -- no UCaaS, WebRTC, mod_voicemail, conferencing, or IVR. Runs as a B2BUA bridging inbound DID calls to outbound PSTN destinations through Bandwidth carriers via a Kamailio SBC. Exception: the Lua-only **encrypted voicemail** deposit path (dedicated-DID mailboxes; `scripts/CLAUDE.md` "Encrypted voicemail") answers, records to a RAM tmpfs and uploads to the API — mod_voicemail stays unbuilt. Second exception: the Lua-only **Visual IVR** (`scripts/CLAUDE.md` "Visual IVR", gate `IVR_ENABLED`, default off) answers IVR DIDs, plays cached prompts, collects DTMF and transfers through the RCF egress — FreeSWITCH's XML `ivr` menus (`ivr.conf`) are not used; it is `play_and_get_digits` + Lua.

## Architecture Position

```
Bandwidth / Sinch -> zone NLB VIP -> ACTIVE Kamailio SBC -> FreeSWITCH FS-1 (FS-2 standby), port 5080 internal profile
                                      |
                                      v  Lua routing scripts (zone-local PG replica)
                                      |
FreeSWITCH (port 5090 external profile) -> zone signaling ILB VIP -> ACTIVE SBC -> carrier_trunks route (Bandwidth / Sinch) -> PSTN destination
```

Production is 3 self-contained GCP zones (East/West/Central). Each zone has
this layout; the full inventory is in root `CLAUDE.md` "GCP Production
Topology" and `PRODUCTION_ARCHITECTURE.md` §2:
- 2 Kamailio SBC VMs (active/standby behind the zone NLB VIP + internal signaling ILB VIP).
- **2 media VMs running this image**: FS-1 active, FS-2 hot standby. Kamailio dispatcher alg 8 selects between them (live 2026-08-31). Redis runs in its own container on each media VM.
- 1 PG replica + PgBouncer VM (East reads the primary on the `services` VM).
- The East-only `services` VM: PG primary, API, UI, Homer.

Deployed via `docker-compose.media.yml` at repo root on every media VM (FS-1 and FS-2 alike; `FS_NODE_ID` tells them apart).

## Multi-Stage Dockerfile Build

### Stage 1: Builder (`debian:bookworm`)

Builds FreeSWITCH from SignalWire source with these dependencies compiled from source:
1. **libks** -- SignalWire's core library (needs git tags for cmake version)
2. **sofia-sip** -- SIP stack (from freeswitch/sofia-sip fork)
3. **spandsp** -- DSP library for DTMF detection and T.38 fax
4. **signalwire-c** -- SignalWire client library

Lua libraries installed via luarocks:
- `luasocket` -- TCP networking (required by redis-lua)
- `redis-lua` -- Pure Lua Redis client (NOT lua-hiredis; hiredis has Lua 5.1/5.3 API incompatibility)
- `luasql-postgres` -- PostgreSQL driver for DID lookups

**RCF quality patch v1** is applied to the pinned FreeSWITCH checkout right after the
library builds (`COPY patches/` + `git apply --check && git apply` loop, `|| exit 1`), before
module selection/bootstrap. See "Quality patch v1" below.

Module selection in `build/modules.conf.in` via sed substitutions:
- **Enabled**: mod_lua, mod_sofia, mod_xml_curl, mod_json_cdr, mod_event_socket, mod_opus, mod_g729, mod_amr, mod_spandsp, mod_dptools, mod_commands, mod_dialplan_xml, mod_curl, mod_shout, mod_sndfile, mod_tone_stream, mod_say_en, mod_db, mod_hash, mod_loopback, mod_cdr_csv, mod_console, mod_logfile, mod_native_file
- **Explicitly disabled** (commented out from defaults): mod_conference, mod_av, mod_png, mod_verto, mod_rtc, mod_voicemail, mod_callcenter, mod_valet_parking, mod_spy

### Stage 2: Runtime (`debian:bookworm-slim`)

Copies from builder:
- `/usr/local/freeswitch` -- FreeSWITCH installation
- Shared libs: sofia-sip, spandsp, libks, signalwire-c (both `/usr/lib/` and arch-specific paths)
- Lua libraries from luarocks (`/usr/local/lib/lua`, `/usr/local/share/lua`)

Key runtime packages include `iproute2` (for the loopback IP hack in entrypoint.sh).

## Entrypoint and Startup

### entrypoint.sh

Adds the public IP (`EXTERNAL_SIP_IP`) to the loopback interface before starting FreeSWITCH:

```sh
ip addr add "${PUBLIC_IP}/32" dev lo
```

This solves the GCE hairpin NAT problem: when FreeSWITCH sends packets to its own public IP (e.g., ACK/BYE to Kamailio's Record-Route address), they are delivered locally instead of being dropped by GCE's network fabric.

**Requires `NET_ADMIN` capability** in docker-compose.

**entrypoint.sh does NOT run in production** (see the next paragraph), so per-start housekeeping that must deploy with `git pull` lives in `scripts/startup.lua` (mod_lua startup script) — e.g. the encrypted-voicemail `/dev/shm/vm` sweep.

**IMPORTANT — entrypoint wiring**: The Dockerfile `ENTRYPOINT` is
`/usr/local/freeswitch/bin/freeswitch` directly (the `ENTRYPOINT` line near the end) — it does NOT invoke
`entrypoint.sh`. The script is `COPY`'d into the image (`COPY entrypoint.sh`) but is never the
image default. `docker-compose.media.yml` sets **no `entrypoint:` override either**
(verified 2026-10-30: the freeswitch service has no `entrypoint:`/`command:` keys),
so in production the loopback-IP hairpin fix in `entrypoint.sh` does not run (and
nothing today needs it: FS never sends to its own public IP in the multi-VM topology). To activate the script add
`entrypoint: ["/usr/local/freeswitch/entrypoint.sh"]` to the freeswitch service
(the image already carries it at that path; the Dockerfile `CMD` flags are passed
through via `"$@"`), or apply the equivalent `ip addr` / `ip route` on the host.
(The "Start FreeSWITCH via entrypoint" comment in the Dockerfile above the
`ENTRYPOINT` line is misleading — the actual ENTRYPOINT bypasses it.)

**No Verizon MTU route on FS (decided 2026-10-30, `docs/VERIZON_IPSEC_TRUNKS_PLAN.md` §3.4):**
the per-destination `mtu lock 1400` route the IPsec design needs lives on the SBCs only.
FS sends SIP to the SBC, never to Verizon; the only FS→Verizon traffic is RTP/RTCP,
which is far below 1400 bytes. So there is nothing for the (non-running) entrypoint to do.

### CMD flags

```
-nf -conf /usr/local/freeswitch/conf -log /var/log/freeswitch -db /var/lib/freeswitch/db -scripts /usr/local/freeswitch/scripts
```

- `-nf` -- Run in foreground (no fork), required for Docker
- **Do NOT use `-nonat`** -- It disables ext-rtp-ip/ext-sip-ip processing, causing SDP to contain Docker internal IPs instead of public IP

## Host Networking

FreeSWITCH runs with `network_mode: host` in docker-compose.media.yml. This is required because:
1. RTP port range is 16384-49151 (32K+ ports) -- Docker port mapping cannot handle this
2. SIP/RTP performance requires direct host networking to avoid NAT overhead
3. Redis runs on a bridge network with port 6379 published to host, so FS reaches it at 127.0.0.1:6379

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `EXTERNAL_SIP_IP` | `auto-nat` | Public IP for Via/Contact/SDP headers. MUST be set in production. |
| `EXTERNAL_RTP_IP` | `auto-nat` | Public IP for SDP c= line. Usually same as EXTERNAL_SIP_IP. |
| `SBC_PROXY_IP` | `127.0.0.1` | The zone's **internal signaling ILB VIP** (East 10.142.0.250 / West 10.138.0.250 / Central 10.128.0.250). It always leads to the ACTIVE SBC. Outbound bridges go to `sofia/external/dest@SBC_PROXY_IP:5060`. Pre-cutover (before 2026-08-27) it was SBC-1's direct IP. |
| `SBC_PROXY_IP_FAILOVER` | `$SBC_PROXY_IP` | SBC-1's **direct** VPC IP, the ILB-bypass fallback for the SBC×trunk failover loops: inbound_router.lua (RCF) and the 8YY `carrier_trunks` loop in trunk_outbound.lua / api_outbound.lua (freeswitch.xml:76 -> `sbc_proxy_ip_failover` global). The cached 1 s TCP pre-check marks a dark ILB dead and moves the attempt here. Defaults to SBC_PROXY_IP if unset. The non-8YY trunk/API Bandwidth bridges still use SBC_PROXY_IP only. |
| `HOMER_IP` | `127.0.0.1` | Homer HEP capture endpoint IP |
| `DB_HOST` | `postgres` | The zone-local PgBouncer (East: `services` primary; West/Central: the zone db VM's replica). Read-only on replicas; writes go through the East API. |
| `FS_ZONE` | `east` | `east`/`west`/`central` — selects the `priority_<zone>` column for the `carrier_trunks` termination order |
| `FS_NODE_ID` | (empty ⇒ `<zone>-fs`) | `<zone>-fs-1` / `<zone>-fs-2` — the CDR `freeswitch_node` + metrics identity of this node |
| `DB_PORT` | `6432` | PgBouncer port (NOT 5432) |
| `DB_NAME` | `voip` | Database name |
| `DB_USER` | `freeswitch` | Database user |
| `DB_PASS` | `fs_secret` | Database password |
| `REDIS_HOST` | `127.0.0.1` | Redis host (127.0.0.1 because host networking) |
| `REDIS_PORT` | `6379` | Redis port |
| `API_HOST` | `api` | FastAPI server host (for xml_curl and json_cdr) |
| `API_PORT` | `8000` | FastAPI server port |
| `ESL_PASSWORD` | `ClueCon` | Event Socket password. CHANGE IN PRODUCTION. |
| `TEST_MODE` | `false` | When true, plays tone instead of bridging to carrier |
| `API_CALLING_ENABLED` | `false` | API Calling product (account_type `api`) is **RETIRED**. Only the exact value `true` (case-insensitive, trimmed) re-enables it. Off: api_did inbound (direct or on-net RCF terminal) is hard-rejected `CALL_REJECTED` (603, `lua_routed=true`, no carrier leg, no webhook) and `api_outbound.lua` / `outbound_api.lua` reject `CALL_REJECTED`. RCF/trunk unaffected. See `scripts/CLAUDE.md`. |
| `IVR_ENABLED` | `false` | Visual IVR (`scripts/CLAUDE.md` "Visual IVR"). Only the exact value `true` (case-insensitive, trimmed) enables it; parsed like `API_CALLING_ENABLED`. Off: an IVR DID (direct or as an on-net terminal) is hard-rejected `CALL_REJECTED` (603, `lua_routed=true`, never answered, no carrier leg). RCF/trunk/voicemail never read it. Passed through `docker-compose.media.yml` (`IVR_ENABLED=${IVR_ENABLED:-false}`); stays unset until the P5 live test, then per zone `.env` + recreate. |
| `BRIDGE_PROGRESS_TIMEOUT` | `10` | Per-attempt `progress_timeout` (seconds) on carrier bridges — max wait for a provisional response (180/183) before failing over. Do NOT replace with originate_timeout (caps time-to-answer incl. ring). With the attempt cap gone (2026-10-30) this is THE knob that bounds a fully-failing sweep (N eligible trunks × attempts-per-trunk × this). |

## Health Check

Defined in docker-compose.media.yml (NOT in Dockerfile so ESL_PASSWORD can be injected):

```yaml
test: ["CMD-SHELL", "fs_cli -p $ESL_PASSWORD -x 'sofia status' | grep -q 'RUNNING'"]
interval: 30s, timeout: 10s, start_period: 45s, retries: 3
```

## Resource Limits

```yaml
limits: cpus 8, memory 16G
reservations: cpus 4, memory 8G
ulimits: nofile 65536, core 0
```

`core: 0` (was unlimited) is deliberate — encrypted voicemail D8: plaintext audio is in FS memory and the `/dev/shm/vm` tmpfs, and a core dump (the build uses `-g`) would copy it to persistent disk. Re-enable only temporarily, in a window, for crash triage.

Also needs `SYS_NICE` capability for real-time scheduling.

## Key Gotchas

1. **ESL password**: Default is `ClueCon` (well-known). MUST be changed via `ESL_PASSWORD` env var in production.

2. **mod_local_stream disabled**: It requires `local_stream.conf.xml` which doesn't exist. When xml_curl can't reach the API during startup, the missing config causes a CRIT abort. RCF uses `silence_stream://-1` for hold music instead.

3. **mod_httapi and mod_http_cache: built-but-not-loaded**: The Dockerfile ENABLES them at build time (`sed` uncomments them in `build/modules.conf.in`, in the "Enable required modules" `RUN`), so the modules exist in the image. But `modules.conf.xml` leaves their `<load>` lines commented (lines 83/92), so they are NOT loaded at runtime. They are not loaded because their configs would need to be served by xml_curl, which is unreachable during module load on the media VM. To enable, uncomment in `modules.conf.xml` AND provide reachable config.

4. **NAT handling is critical**: Both internal and external profiles set `local-network-acl=loopback.auto` and `apply-nat-acl=rfc1918.auto`. This forces ext-sip-ip/ext-rtp-ip into SDP and SIP headers for ALL traffic except loopback. Without this, Docker 172.28.x.x IPs leak into SDP causing one-way audio.

5. **Two sofia profiles**: Internal (5080) receives inbound from Kamailio. External (5090) sends outbound to Kamailio. The external profile is needed because the internal profile does NOT apply ext-sip-ip to outbound Via/Contact headers.

6. **Lua package path**: mod_lua adds script-directory as a searcher, which breaks `require("redis")` because it tries to read the scripts directory as a file. All scripts prepend explicit luarocks paths and use `loadfile()` instead of `require()` for local modules.

7. **Redis code removed from inbound_router.lua (RCF-V1)**: The redis-lua library has connection pooling issues inside mod_lua's threading model. The route cache, fraud prefix check, and velocity limiting were deleted from the script (old code in git history; re-adding needs a synchronous client). Calls route via PostgreSQL only. trunk_outbound/api_outbound still load redis fail-open.

8. **Session timers (corrected 2026-09-24)**: the ONLY per-call knob mod_sofia reads is `sofia_session_timeout`. `inbound_router.lua` / `trunk_outbound.lua` `set` it to 1800 on the A-leg (not export) before any answer — it is read in `sofia_answer_channel` AFTER the internal profile's aggressive-nat-detection override (90 → sofia-sip 120, which cut Sinch-originated calls at ~108s). `sip_session_timeout` / `sip_minimum_session_expires` / `enable_timer` (exports, dial-string vars) and the `sip-session-timeout` / `sip-min-session-expires` profile params are NOT read by mod_sofia — inert (exports removed from the RCF/trunk scripts; dial-string copies left for byte-identity). B-leg Session-Expires/Min-SE come from Kamailio TO_CARRIER and the carrier's 200 OK (normalized carrier-side only).

9. **CDR A/B leg split (2026-09-23)**: `json_cdr.conf.xml` `log-b-leg=true` — every originated B-leg posts its own CDR. Only CARRIER dial strings (RCF off-net failover loops, trunk_outbound) carry the per-leg `[cdr_leg=B,cdr_carrier_leg=true,cdr_leg_attempt=N,…]` block that makes the ingest write a B row; on-net deliveries never do. Vars are per-leg `[]` dial-string vars — never `export`/`set` them on the A-leg. Activation after `git pull` = `reloadxml` + `reload mod_json_cdr` (no restart). Details: `scripts/CLAUDE.md` "CDR A/B leg split", `conf/CLAUDE.md` "json_cdr.conf.xml", `docs/CDR_LEG_SPLIT_CONTRACT.md`.

10. **Gateway syntax deprecated**: All outbound bridges use `sofia/external/dest@proxy` instead of `sofia/gateway/carrier/dest`. The gateway syntax produced corrupted Contact headers (`sip:gw+carrier_primary@...`).

11. **Termination traffic-class filter (strict toll-free, 2026-10)**: `inbound_router.lua` filters the cached `carrier_trunks` termination list per call by `classify_destination(forward_to)` (NANP 8YY by NPA → `tollfree`, else `ld`). `ld` → trunks of class `any` or `ld` (none → full list, never strand LD). `tollfree` → ONLY `tollfree` trunks (Sinch OSAO denver-tf); `any`/`ld` (Bandwidth, Sinch atlanta-ld) are never eligible, and with no enabled `tollfree` trunk the call FAILS CLOSED: ERR log, `term_class_blocked=tollfree` (CDR variables), `NO_ROUTE_DESTINATION` (SIP 404) + `lua_routed=true`. There is NO attempt cap any more (removed 2026-10-30; the cache's 16-row bound is the only limit), so no number of outbound rows can truncate the only tollfree trunk. The LEGACY fail-open loop (DB blip / zero rows) is class-blind and can still send 8YY via Bandwidth — deliberate. Prod has no `any` rows (owner relabels them `ld`, migration 52 header). The NPA set must match Kamailio `route[TF_CLASSIFY]` (`TF_INGRESS_ENFORCE`) — pinned by `tests/test_classify_destination.py`; behavior pinned by `tests/lua/onnet_router_harness.lua` [13a-f].

12. **Shared termination lib + trunk/API 8YY egress (2026-10, Sinch close-out)**: the carrier_trunks fetch/60s cache/validation, class coercion, `classify_destination`, class filter, trunk-major attempt builder (no cap since 2026-10-30; carrier `verizon` rows get the signaling-VIP attempt only — see "Verizon IPsec termination" below) and the X-Carrier-IP dial-string builder live in `scripts/lib/term_trunks.lua` (loaded via `loadfile`, no Redis). `inbound_router.lua` delegates to it with byte-identical output (vars, dial strings, hangups, log lines — verified against the pre-extraction script); if the lib fails to load, RCF takes the legacy fail-open loop (same as a DB blip). `trunk_outbound.lua` and `api_outbound.lua` (direct-bridge path; webhook calls untouched) send NANP 8YY destinations ONLY over enabled `traffic_class='tollfree'` rows — same SQL, same process-wide cache entry (`term_trunks_<zone>`, shared by all three scripts), per-zone priority (`FS_ZONE`), trunk-major × {`SBC_PROXY_IP`, `SBC_PROXY_IP_FAILOVER`} with the cached TCP pre-check, `X-Carrier-IP`/`X-Carrier-Label`, `carrier_used=<carrier>-<pop>`, `term_trunks_source`. They FAIL CLOSED on every miss — no tollfree row, DB error/zero rows, or lib missing → `term_class_blocked=tollfree` + `NO_ROUTE_DESTINATION` + `lua_routed=true`, never Bandwidth (asymmetric with the RCF legacy fail-open on purpose: these products never had an 8YY route). Non-8YY trunk/API calls never consult carrier_trunks and are byte-identical to before. Ordering with the redundant rows (migration 53): LD = Bandwidth (10/20, west swaps) → sinch/atlanta-ld (30) → sinch/denver-ld (35); 8YY = sinch/denver-tf (40) → sinch/atlanta-tf (45). The redundant rows share source IPs with the inbound 8XX-T orig rows; FS's SELECT filters `direction IN ('outbound','both')` and the cache is an ordered list (never IP-keyed), so nothing collapses. See `scripts/CLAUDE.md` "lib/term_trunks.lua".

13. **No RTP timer on the sofia profiles (source-derived, 2026-10-23)**: neither `internal.xml` nor `external.xml` sets `rtp-timer-name`. Vanilla FreeSWITCH profiles set it to `soft`, and mod_sofia has no default (at the pinned ref, `sofia.c:5285-5286` is the only assignment). So audio RTP sessions are created without a timer ("Not using a timer", `switch_rtp.c:4594`), and reads are paced by packet arrival. This is harmless for bridged RCF/trunk legs. It matters for anything that **terminates** media: a jitter buffer needs a timer, and so does a silence detector that must keep counting when RTP stops. The voicemail recording leg and the Visual IVR leg are the only such paths: `lib/vm_box.lua` (voicemail, owner decision O6; see `scripts/CLAUDE.md` "Recording jitter buffer") and `lib/media_leg.lua` (IVR, called only by `terminate_ivr`) set `rtp_timer_name=soft` + `jitterbuffer_msec=60:200` per call before the answer. Do NOT add `rtp-timer-name` to a profile to get this: that would change the RTP pacing of every RCF/trunk leg. To verify on a node, an RCF CDR in `/var/log/freeswitch/json_cdr` has no `rtp_use_timer_name`, and a voicemail or IVR CDR has `rtp_use_timer_name=soft`.

## Verizon IPsec termination — FS side (2026-10-30, ships dark)

Plan: `docs/VERIZON_IPSEC_TRUNKS_PLAN.md` §7 / §8.2 / §3.4. Verizon is a `carrier_trunks` LD
termination carrier (`carrier='verizon'`, priority 50 — below every Bandwidth and Sinch row —
seeded DISABLED with TEST-NET placeholder IPs by migration 62) reached through the zone's
`.251` SBC Verizon ILB VIP and the IPsec gateways. Two FS-side changes, both inert until a
Verizon row is enabled. No sofia profile change and no MTU route on FS (RTP is small; SIP
goes to the SBC):

1. **Attempt cap removed** (owner decision 2026-10-29). `lib/term_trunks.lua` `M.MAX` and `cap()`
   and `inbound_router.lua` `TERM_TRUNKS_MAX` are gone; the RCF LD loop and `select_tollfree`
   (trunk/API 8YY) try EVERY eligible row in `eff_priority` order. The only bound is
   `M.CACHE_MAX = 16` rows per zone. Why: a post-filter cap silently hid any row below the
   first four, so Verizon at 50 would never have been reached once denver-ld was enabled.
   Worst case grows with the list — N eligible rows × attempts-per-row × (`BRIDGE_PROGRESS_TIMEOUT`
   + ≤1 s TCP probe); the SBC-down case is still fast (cached pre-check skips in <1 s). The knob
   is `BRIDGE_PROGRESS_TIMEOUT`, not a row cap.
2. **VIP-only attempts for Verizon rows.** `build_attempts` emits, for a row whose sanitized
   carrier token is `verizon` (`M.VIP_ONLY_CARRIERS`, case-insensitive), ONLY the `SBC_PROXY_IP`
   (signaling ILB VIP) attempt — never the `SBC_PROXY_IP_FAILOVER` (SBC-1 direct) one. Every
   Verizon reply lands on the ACTIVE SBC via the `.251` ILB rule, so an INVITE sent to SBC-1's
   direct IP while SBC-1 is standby can never see its reply; Kamailio rejects such an INVITE 503
   immediately (plan §8.1 item 3). Every other carrier is byte-identical (2 attempts per row).
   Same lib, so trunk/API 8YY would behave the same if a Verizon `tollfree` row ever existed
   (none planned — 8YY stays on Sinch).
Enable order (per zone): migration 62 on the East primary → Kamailio Verizon build on both SBCs
(`SBC_PEER_INTERNAL_IP` set) → tunnels up → `UPDATE carrier_trunks SET source_ip=<real>, enabled=true
WHERE carrier='verizon' ...` (FS picks it up within 60 s, no restart). Harness:
`tests/lua/onnet_router_harness.lua` (RCF loop) and the standalone cap/VIP-only checks in the PR.

## Volumes (docker-compose.media.yml)

- `./docker/freeswitch/conf` mounted to `/usr/local/freeswitch/conf` (config hot-reload)
- `./docker/freeswitch/scripts` mounted to `/usr/local/freeswitch/scripts` (script hot-reload)
- `freeswitch_logs` named volume at `/var/log/freeswitch`
- `./secrets/fs-voicemail` mounted READ-ONLY at `/run/revup` — holds only `vm_ingest.header` (single line `X-Ingest-Secret: <INGEST_SHARED_SECRET>`, root:root 0600), read by curl via `-H @file`. The directory (not the file) is mounted so a node without the secret still starts FS (Docker auto-creates a missing directory; voicemail calls then play `unavailable`), and a file added later is visible without a recreate. Git-ignored (`secrets/*`).
- `tmpfs: /dev/shm/vm:size=512m,mode=0700,noexec,nosuid,nodev` — the ONLY place plaintext voicemail audio is written (Lua refuses to record unless it is a real tmpfs mount). FS runs as root in this image (no USER / `-u`), so `mode=0700` root-owned is correct.
- `ivr_prompts` named volume at `/var/lib/crag/ivr-prompts` — the Visual IVR's content-addressed prompt cache (`<sha256>.wav`, written atomically by `lib/ivr_prompts.lua` from the local replica's `ivr_prompt_audio`; contract §4/§7, added to `docker-compose.media.yml` by the voicemail-resilience PR). Persistent so a recreate keeps the cache warm; safe to delete (refilled on the next call per sha). Without the volume the Lua creates the directory in the container layer.

### Encrypted voicemail — operator steps per FS node (all 6 nodes, FS-2 first)

Everything is `git pull` + container recreate — **no image rebuild** (Lua, prompts and compose are bind-mounted / compose-level; `curl` and `find` are already in the runtime image).
1. `sudo install -d -m 0700 -o root -g root /opt/revup/secrets/fs-voicemail`
2. `sudo sh -c 'umask 077; read -r S; printf "X-Ingest-Secret: %s\n" "$S" > /opt/revup/secrets/fs-voicemail/vm_ingest.header'` — then paste the services VM's `INGEST_SHARED_SECRET` and press Enter (keeps it out of shell history and argv).
3. `sudo stat -c '%a %U:%G' /opt/revup/secrets/fs-voicemail/vm_ingest.header` → `600 root:root`.
4. In the window: `cd /opt/revup && sudo git pull && sudo docker compose -f docker-compose.media.yml up -d freeswitch` (recreate drops this node's calls; host-net orphan gotcha: `sudo killall -9 freeswitch` if ports stay held).
5. Verify: `sudo docker exec voip-freeswitch sh -c 'grep " /dev/shm/vm " /proc/self/mounts; ulimit -c; test -r /run/revup/vm_ingest.header && echo header-ok'` → a `tmpfs ... mode=700` line, `0`, `header-ok`; and the FS log line `Voicemail:  tmpfs /dev/shm/vm mounted, swept`.

## Network Ports

| Port | Protocol | Purpose |
|---|---|---|
| 5060 | UDP/TCP | External SIP profile (carrier-facing, currently unused for inbound) |
| 5080 | UDP/TCP | Internal SIP profile (receives from Kamailio) |
| 5081 | TCP | Internal TLS (disabled) |
| 5090 | UDP/TCP | External SIP profile (outbound to Kamailio/carriers) |
| 8021 | TCP | Event Socket (ESL) |
| 16384-49151 | UDP | RTP media (32K ports for ~10K concurrent B2BUA calls) |

## Quality patch v1 (RTP loss/jitter measurement) — `patches/0001-rcf-rtp-quality-v1.patch`

Contract: `docs/CALL_QUALITY_ACCURACY_PLAN.md` section A (variables), B (how the API scores
them), G.3 (lab). FreeSWITCH's own `rtp_audio_in_mos` / `_quality_percentage` / `_flaw_total`
are NOT a usable loss or quality measure (`do_mos()` scores zero inbound RTP as 4.50, resets
`flaws`, counts CNG/autoflush/DTMF as flaws). The patch adds a correct measurement NEXT TO them.

**What it is.** A source patch (3 files, 178 added lines, zero removed) applied in the builder
stage to the pinned `FREESWITCH_REF` 0a54a48:
- `src/include/switch_types.h`: 10 fields appended to `switch_rtp_numbers_t`
  (`seq_expected/_received/_lost/_loss_events/_reordered/_epochs`, `rfc3550_jitter_sum_ms/_n/_max_ms`,
  `rfc3550_kernel_clock`). Layout change is safe: every module is compiled from the same tree in
  this Dockerfile; no prebuilt binary modules are loaded (only mod_commands + the unbuilt
  mod_managed SWIG wrapper reference the struct, by field name).
- `src/switch_rtp.c`: private `qt_*` tracker state in `struct switch_rtp` (pool memory is
  zero-filled by `switch_core_alloc`, no init code), and `qt_track()` = RFC 3550 A.1 sequence
  accounting (extended highest seq, cycles, never reset; SSRC change or jump >= 3000 = new
  epoch, not loss; <= 99 behind = late/reordered; duplicate of highest = reordered, not
  received) + RFC 3550 6.4.1 interarrival jitter (8 kHz RTP clock only, RFC 2833 excluded,
  first 50 samples of each epoch = warm-up). Called at exactly two points, both after the
  existing `stats.inbound.packet_count++`: the normal read path (after SRTP unprotect, outside
  the `PROXY_MEDIA` guard, so trunk calls are measured) and the autoflush loop (flushed packets
  DID arrive; muxed RTCP excluded). Arrival time = kernel receive timestamp (`ioctl(SIOCGSTAMP)`
  on `sock_input`, Linux) with `switch_micro_time_now()` fallback; a clock change between two
  packets resets the jitter reference instead of differencing two clocks.
- `src/switch_core_media.c` `set_stats()`: AUDIO-only export of the new variables.
- Touches NONE of `flaws`, `R`, `mos`, `recved`, `loss[]`, `lossrate`, `burstrate`, the
  variances, flags, the packet, or any existing channel variable.

**Channel variables added (strings, at hangup, AUDIO media handle only):**

| Variable | Type / unit | Present when |
|---|---|---|
| `rtp_audio_in_qpatch` | `"1"` | patched image + audio media handle |
| `rtp_audio_in_seq_expected` | uint, packets | patched |
| `rtp_audio_in_seq_received` | uint, packets | patched |
| `rtp_audio_in_seq_lost` | uint, packets (never reset) | patched |
| `rtp_audio_in_seq_loss_events` | uint, forward gaps (loss bursts) | patched |
| `rtp_audio_in_seq_reordered` | uint, late + duplicate-of-highest packets | patched |
| `rtp_audio_in_seq_epochs` | uint (0 = no RTP ever; 1 + SSRC changes/restarts) | patched |
| `rtp_audio_in_rfc3550_jitter_avg_ms` | `%0.2f` ms, mean J over post-warm-up samples | patched AND >= 51 in-order samples at 8 kHz |
| `rtp_audio_in_rfc3550_jitter_max_ms` | `%0.2f` ms, peak J | same |
| `rtp_audio_in_rfc3550_clock` | `kernel` / `read` | patched |

Absent `rtp_audio_in_qpatch` = unpatched ("legacy") image; the API falls back to
`rtp_audio_in_jitter_loss_rate` and writes jitter NULL. Every pre-existing `rtp_audio_*`
variable keeps its exact name, format and value. `seq_lost` = packets that never reached FS's
socket-read stage (network loss + the pre-count "already sent this frame" drop); autoflush
discards count as received (they stay visible in `in_flush_packet_count`/`in_skip_packet_count`).

**Rebuild rule.** The patch is valid ONLY for `FREESWITCH_REF` 0a54a48. `git apply --check` fails
the image build loudly if the ref moves. On any ref bump: regenerate the patch against the new
commit (full clone, re-apply the same hunks, `git diff > patches/0001-...`), re-run the unit test
and the full lab below on west-loadtest, and only then roll (standby FS first). Never "fix" a
failing apply by deleting the patch step: the API would silently fall back to legacy numbers.

**Tests.**
- Unit (any machine, compiles the tracker straight out of the patch file, both the SIOCGSTAMP
  path with a mocked ioctl and the read-time fallback): `sh docker/freeswitch/lab/unit/run_unit.sh`
- Lab evaluator self-test (synthetic CDRs): `python3 docker/freeswitch/lab/unit/eval_selftest.py`
- Acceptance lab (SIPp + netem, west-loadtest ONLY, ~1 h + 2 image builds):
  `cd /opt/revup/docker/freeswitch/lab && sudo ./run_matrix.sh all` then
  `sudo ./run_matrix.sh compare` and `sudo ./run_matrix.sh warncheck`. The 13 checks and pass
  criteria are in `lab/README.md`. All must pass before any production FS rebuild.

**Verify a rebuilt node** (plan H step 7): build log shows
`applied /usr/src/fs-patches/0001-rcf-rtp-quality-v1.patch`;
`sudo docker exec voip-freeswitch sh -c 'grep -ac in_seq_expected /usr/local/freeswitch/lib/libfreeswitch.so*'` >= 1;
a test call's on-disk CDR carries `rtp_audio_in_qpatch":"1"`. Rollback = re-tag the
`revup-fs:pre-qpatch` image (plan H "Rollback").

## File Layout

```
docker/freeswitch/
  Dockerfile              # Multi-stage build (applies patches/ to the pinned FS checkout)
  entrypoint.sh           # Loopback IP hack for GCE hairpin NAT
  patches/                # FS source patches, pinned to FREESWITCH_REF (quality patch v1)
  lab/                    # Call-quality acceptance lab: SIPp + netem + evaluator (lab/README.md)
  conf/                   # FreeSWITCH configuration (see conf/CLAUDE.md)
  scripts/                # Lua routing scripts (see scripts/CLAUDE.md); scripts/lib/term_trunks.lua = shared carrier_trunks termination
    sounds/vm/            # Voicemail prompts (8 kHz mono PCM16 WAV, bind-mounted)
    sounds/ivr/           # Visual IVR system prompts: technical_difficulty.wav, goodbye.wav (espeak-ng placeholders; regenerate with the TTS sidecar)
```

### Visual IVR — operator steps per FS node (P2; FS-2 first)

No image rebuild and no Kamailio change: `play_and_get_digits` / `playback` /
`limit` / `file_string` (mod_dptools), `limit hash` (mod_hash), WAV playback
(mod_sndfile) and `silence_stream` / `tone_stream` (mod_tone_stream) are all
built (Dockerfile `modules.conf.in` seds) and loaded (`modules.conf.xml`).
With `IVR_ENABLED` unset the new code is inert for every existing call (RCF /
trunk / voicemail are byte-identical — `BASELINE_REF=37a56f0 lua tests/lua/ivr_egress_identity_harness.lua`),
so the scripts can land with a plain `git pull` (bind-mounted, next call). The
`ivr_prompts` volume needs the one-time container recreate that the
voicemail-resilience compose change brings. Turning IVR on is P5: one IVR test
number, then `IVR_ENABLED=true` in that zone's media-VM `.env` + recreate.
Order: migration 59 (`ivr_fs_number`) must be on the replicas BEFORE these
scripts are pulled — STEP-1 arm e queries the view for every DID that no other
product owns (a would-be 404), and before 59 that query fails and logs an ERR
line per such call (the call still gets its 404).
