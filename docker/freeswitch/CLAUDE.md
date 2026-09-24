# FreeSWITCH Docker Build -- RCF-V1 Production

## What This Is

FreeSWITCH media server for the RevUp voice platform. Stripped to Remote Call Forwarding (RCF) only -- no UCaaS, WebRTC, voicemail, conferencing, or IVR. Runs as a B2BUA bridging inbound DID calls to outbound PSTN destinations through Bandwidth carriers via a Kamailio SBC.

## Architecture Position

```
Bandwidth -> Kamailio SBC (VM1) -> FreeSWITCH (VM2, port 5080 internal profile)
                                      |
                                      v  Lua routing scripts
                                      |
FreeSWITCH (port 5090 external profile) -> Kamailio SBC -> Bandwidth -> PSTN destination
```

FreeSWITCH is VM2 in a 4-VM GCP production deployment:
- VM1: Kamailio SBC + Homer
- VM2: FreeSWITCH + Redis (this image)
- VM3: API server + PgBouncer
- VM4: PostgreSQL + monitoring

Deployed via `docker-compose.media.yml` at repo root.

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

**IMPORTANT — entrypoint wiring**: The Dockerfile `ENTRYPOINT` is
`/usr/local/freeswitch/bin/freeswitch` directly (the `ENTRYPOINT` line near the end) — it does NOT invoke
`entrypoint.sh`. The script is `COPY`'d into the image (`COPY entrypoint.sh`) but is never the
image default. Therefore the loopback-IP hairpin fix in `entrypoint.sh` is wired
via a **compose-level entrypoint override** (`docker-compose.media.yml`), not the
image default. (The "Start FreeSWITCH via entrypoint" comment in the Dockerfile
above the `ENTRYPOINT` line is misleading — the actual ENTRYPOINT bypasses it.)

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
| `SBC_PROXY_IP` | `127.0.0.1` | Primary Kamailio SBC IP. Outbound bridges go to sofia/external/dest@SBC_PROXY_IP:5060 |
| `SBC_PROXY_IP_FAILOVER` | `$SBC_PROXY_IP` | Secondary SBC IP for the 4-attempt failover loop in inbound_router.lua (freeswitch.xml:71 -> `sbc_proxy_ip_failover` global). Defaults to SBC_PROXY_IP if unset. |
| `HOMER_IP` | `127.0.0.1` | Homer HEP capture endpoint IP |
| `DB_HOST` | `postgres` | PostgreSQL host (via PgBouncer) |
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
| `BRIDGE_PROGRESS_TIMEOUT` | `10` | Per-attempt `progress_timeout` (seconds) on carrier bridges — max wait for a provisional response (180/183) before failing over. Do NOT replace with originate_timeout (caps time-to-answer incl. ring). |

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
ulimits: nofile 65536, core unlimited
```

Also needs `SYS_NICE` capability for real-time scheduling.

## Key Gotchas

1. **ESL password**: Default is `ClueCon` (well-known). MUST be changed via `ESL_PASSWORD` env var in production.

2. **mod_local_stream disabled**: It requires `local_stream.conf.xml` which doesn't exist. When xml_curl can't reach the API during startup, the missing config causes a CRIT abort. RCF uses `silence_stream://-1` for hold music instead.

3. **mod_httapi and mod_http_cache: built-but-not-loaded**: The Dockerfile ENABLES them at build time (`sed` uncomments them in `build/modules.conf.in`, in the "Enable required modules" `RUN`), so the modules exist in the image. But `modules.conf.xml` leaves their `<load>` lines commented (lines 83/92), so they are NOT loaded at runtime. They are not loaded because their configs would need to be served by xml_curl, which is unreachable during module load on the media VM. To enable, uncomment in `modules.conf.xml` AND provide reachable config.

4. **NAT handling is critical**: Both internal and external profiles set `local-network-acl=loopback.auto` and `apply-nat-acl=rfc1918.auto`. This forces ext-sip-ip/ext-rtp-ip into SDP and SIP headers for ALL traffic except loopback. Without this, Docker 172.28.x.x IPs leak into SDP causing one-way audio.

5. **Two sofia profiles**: Internal (5080) receives inbound from Kamailio. External (5090) sends outbound to Kamailio. The external profile is needed because the internal profile does NOT apply ext-sip-ip to outbound Via/Contact headers.

6. **Lua package path**: mod_lua adds script-directory as a searcher, which breaks `require("redis")` because it tries to read the scripts directory as a file. All scripts prepend explicit luarocks paths and use `loadfile()` instead of `require()` for local modules.

7. **Redis code removed from inbound_router.lua (RCF-V1)**: The redis-lua library has connection pooling issues inside mod_lua's threading model. The route cache, fraud prefix check, and velocity limiting were deleted from the script (old code in git history; re-adding needs a synchronous client). Calls route via PostgreSQL only. trunk_outbound/api_outbound still load redis fail-open.

8. **Session timer export**: Channel variables must be `export`ed (not just `set`) to propagate to the B-leg. Without this, Bandwidth tears down calls after Session-Expires (30s) because FreeSWITCH doesn't send refresh re-INVITEs.

9. **CDR A/B leg split (2026-09-23)**: `json_cdr.conf.xml` `log-b-leg=true` — every originated B-leg posts its own CDR. Only CARRIER dial strings (RCF off-net failover loops, trunk_outbound) carry the per-leg `[cdr_leg=B,cdr_carrier_leg=true,cdr_leg_attempt=N,…]` block that makes the ingest write a B row; on-net deliveries never do. Vars are per-leg `[]` dial-string vars — never `export`/`set` them on the A-leg. Activation after `git pull` = `reloadxml` + `reload mod_json_cdr` (no restart). Details: `scripts/CLAUDE.md` "CDR A/B leg split", `conf/CLAUDE.md` "json_cdr.conf.xml", `docs/CDR_LEG_SPLIT_CONTRACT.md`.

10. **Gateway syntax deprecated**: All outbound bridges use `sofia/external/dest@proxy` instead of `sofia/gateway/carrier/dest`. The gateway syntax produced corrupted Contact headers (`sip:gw+carrier_primary@...`).

## Volumes (docker-compose.media.yml)

- `./docker/freeswitch/conf` mounted to `/usr/local/freeswitch/conf` (config hot-reload)
- `./docker/freeswitch/scripts` mounted to `/usr/local/freeswitch/scripts` (script hot-reload)
- `freeswitch_logs` named volume at `/var/log/freeswitch`

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
  scripts/                # Lua routing scripts (see scripts/CLAUDE.md)
```
