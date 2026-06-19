# FreeSWITCH Docker Build -- Unified (UCaaS on the hardened RCF foundation)

## What This Is

FreeSWITCH media server for the RevUp voice platform. This is the **unified** image: the production-hardened RCF/trunk/API SIP foundation (record-route/`r2=on`, Cloud NAT, SBC failover, session timers — all intact) **plus the restored UCaaS stack** (WebRTC softphone via mod_verto/mod_rtc, conferencing via mod_conference/mod_av, voicemail via mod_voicemail, call parking via mod_valet_parking). It runs as a B2BUA bridging inbound DID calls to outbound PSTN destinations through Bandwidth carriers via a Kamailio SBC, AND terminates WebRTC/extension traffic for UCaaS accounts.

**RCF simplicity rule still holds at the product layer:** RCF customers never see UCaaS features — gating is enforced at the API/UI/provisioning layer, not the dialplan. Carrier RCF traffic uses E.164 in the `public` context and never matches the UCaaS short/star codes in the `default` context.

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

Module selection in `build/modules.conf.in` via sed substitutions:
- **Core RCF/SIP** (built + loaded): mod_lua, mod_sofia, mod_xml_curl, mod_json_cdr, mod_event_socket, mod_opus, mod_g729, mod_amr, mod_spandsp, mod_dptools, mod_commands, mod_dialplan_xml, mod_curl, mod_shout, mod_sndfile, mod_tone_stream, mod_say_en, mod_db, mod_hash, mod_loopback, mod_cdr_csv, mod_console, mod_logfile, mod_native_file
- **UCaaS** (built in the Dockerfile AND loaded in `modules.conf.xml`): mod_conference, mod_av (VP8/H264 for video), mod_verto (WebRTC WSS), mod_rtc (WebRTC media), mod_voicemail, mod_valet_parking
- **Call queues** (Phase 7, built + loaded): **mod_fifo** — named dynamic FIFO queues powering the TwiML `<Enqueue>`/`<Dial><Queue>` verbs. Already in the FreeSWITCH default module set (no Dockerfile change needed); enabled via a `<load>` line in `modules.conf.xml` + a minimal `fifo.conf.xml`. Chosen over the also-built `mod_callcenter` because callcenter's agent/tier model is far heavier than Twilio queue semantics need. Queues are created on demand and tenant-namespaced `fifo_<customer_id>_<name>`.
- **Media plane** (Phase 6, built + loaded): **mod_audio_stream** — forks call audio (L16) to a WebSocket for AI/transcription; powers the `<Stream>`/`<Connect><Stream>` TwiML verbs via the `uuid_audio_stream` API. NOT a SignalWire core module: cloned from `github.com/amigniter/mod_audio_stream` and CMake-built against the installed FreeSWITCH (see "mod_audio_stream build" below). Standalone/`<Record>` recording needs NO extra module — it uses the core `record`/`record_session` apps (mod_dptools).
- **TTS** (Phase 7, built + loaded): **mod_tts_commandline** (Piper, default `<Say>` engine — see "Piper neural TTS" below) + **mod_flite** (debian `flite1-dev`/`libflite1`; the `TTS_ENGINE=flite` fallback engine). Both compile into the FS build via `sed` in `build/modules.conf.in`. The `say:` pronunciation path (mod_say_en) is the last-resort degrade if a speak engine fails at runtime.
- **Built but NOT loaded** (compiled in the Dockerfile, no `<load>` in `modules.conf.xml`): mod_callcenter (superseded for TwiML queues by the lighter mod_fifo — see "Call queues"; still available for a future agent/tier ACD), mod_spy (reserved for future call-center/monitoring; enable by adding a `<load>` line + config), mod_httapi, mod_http_cache (need xml_curl-served config, unreachable at module-load on the media VM)
- **Still disabled** (would CRIT-abort without local config): mod_local_stream — RCF/UCaaS use `silence_stream://`/`tone_stream://` instead

#### mod_audio_stream build (Phase 6)

`mod_audio_stream` (audio-fork-to-WebSocket) is NOT in the FreeSWITCH source tree, so
it is cloned and built in a set of **additive Dockerfile layers placed AFTER the
FreeSWITCH `make install`** — deliberately, so they do not invalidate the expensive
cached FreeSWITCH build above. Build chain (builder stage):

1. `apt-get install libevent-dev` (its only extra build dep; libssl/zlib/libspeexdsp
   are already present). The WebSocket client is a git submodule (`libs/libwsc`,
   IXWebSocket-style), statically linked — so it is cloned with `--recurse-submodules`.
2. `cmake -DCMAKE_BUILD_TYPE=Release .. && make && make install` with
   `PKG_CONFIG_PATH=/usr/local/freeswitch/lib/pkgconfig` so its CMake discovers
   FreeSWITCH's `modulesdir`. **`make install` lands the `.so` at
   `/usr/local/freeswitch/lib/freeswitch/mod/mod_audio_stream.so`** — that IS
   FreeSWITCH's real module-load dir on this image (there is NO `/usr/local/freeswitch/mod`;
   do not "fix up" a copy there — that was a build bug). The runtime stage copies the
   whole `/usr/local/freeswitch`, so the module ships automatically.
3. Runtime stage adds `libevent-2.1-7` **and `libevent-pthreads-2.1-7`** — the module
   links `libevent_pthreads`, so the core libevent package alone is NOT enough (the
   module fails to load with `libevent_pthreads-2.1.so.7 => not found`).

`modules.conf.xml` carries `<load module="mod_audio_stream"/>`. Verified live:
`module_exists mod_audio_stream` → `true`, `uuid_audio_stream` registers, FS boots
with no CRIT and verto WSS / sofia / conference / voicemail still load. The
`uuid_audio_stream` API rate arg is **numeric** (`8000|16000`), not `8k/16k` as the
upstream README claims — the engine passes `8000`.

### Stage 2: Runtime (`debian:bookworm-slim`)

Copies from builder:
- `/usr/local/freeswitch` -- FreeSWITCH installation
- Shared libs: sofia-sip, spandsp, libks, signalwire-c (both `/usr/lib/` and arch-specific paths)
- Lua libraries from luarocks (`/usr/local/lib/lua`, `/usr/local/share/lua`)

Key runtime packages include `iproute2` (for the loopback IP hack in entrypoint.sh).

## Entrypoint and Startup

### entrypoint.sh

**The Dockerfile `ENTRYPOINT` IS `entrypoint.sh`** (Phase 4 — previously the
ENTRYPOINT was the freeswitch binary directly and the script never ran, leaving
the loopback hack latent-dead; that is fixed). `entrypoint.sh` does three
repo-encoded host-config steps, then `exec`s the freeswitch binary as PID 1 with
the CMD args:

1. **GCE hairpin NAT** — adds the public IP (`EXTERNAL_SIP_IP`) to loopback:
   `ip addr add "${PUBLIC_IP}/32" dev lo`. So when FreeSWITCH sends packets to
   its own public IP (ACK/BYE to Kamailio's Record-Route address), they are
   delivered locally instead of dropped by GCE's fabric. **Requires `NET_ADMIN`.**
   No-op when `EXTERNAL_SIP_IP` is unset/`auto-nat`/`127.0.0.1` (local dev).
2. **ESL password hardening (kill ClueCon)** — HARD-FAILS (`exit 1`) if
   `ESL_PASSWORD` is literally `ClueCon`; warns if unset (FS then falls back to
   the freeswitch.xml dev default `fs_esl_dev_pw`); `export`s the validated value
   so the `esl_password` X-PRE-PROCESS templating sees exactly what we checked.
3. **Shared media spool** — `mkdir -p /media/spool/{voicemail,recordings}` and
   symlinks `/var/lib/freeswitch/{voicemail,recordings}` onto them, so every
   voicemail/recording artifact lands on the shared `media_spool` volume the API
   uploads to object storage from. (handlers/ucaas.lua keeps its in-image
   `/var/lib/...` record path — pinned by a characterization test — and the
   symlink makes it physically resolve to the spool.)

Because this is the image ENTRYPOINT, BOTH the local compose and
`docker-compose.media.yml` get all three steps with no compose-level entrypoint
override needed.

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
| `ESL_PASSWORD` | `fs_esl_dev_pw` | Event Socket password. Templated into `event_socket.conf.xml` via the `esl_password` X-PRE-PROCESS global. **NEVER `ClueCon`** — entrypoint.sh refuses that literal. Must match the API's `FREESWITCH_ESL_PASSWORD`. Set a strong value in `.env` for production. |
| `TEST_MODE` | `false` | When true, plays tone instead of bridging to carrier |
| `BRIDGE_PROGRESS_TIMEOUT` | `10` | Per-attempt `progress_timeout` (seconds) on carrier bridges — max wait for a provisional response (180/183) before failing over. Do NOT replace with originate_timeout (caps time-to-answer incl. ring). |
| `VERTO_TLS_PEM` | `conf/tls/wss.pem` | mod_verto WSS cert+privkey (combined PEM). Env-driven global `verto_tls_pem`. PRODUCTION: mount a CA-issued cert and set this. |
| `VERTO_TLS_CHAIN` | `conf/tls/wss.crt` | mod_verto WSS cert/CA chain. Env-driven global `verto_tls_chain`. |
| `VM_NOTIFY_TIMEOUT` | `5` | curl `--max-time` (seconds) for the voicemail-deposit notify POST (lib/vm_notify.lua). |
| `INGEST_SHARED_SECRET` | (unset) | SEC-2. Shared secret sent as `X-Ingest-Secret` on the multipart media uploads to the API ingest endpoints (lib/vm_notify.lua, lib/rec_notify.lua). MUST match the API's `INGEST_SHARED_SECRET` (the API compares it constant-time). When unset (local harness) the header is omitted and notify still no-ops cleanly. Read directly via `os.getenv` — set it in the container env on the Media VM. PRODUCTION: set a strong value. |
| `RECORDINGS_DIR` | `/media/spool/recordings` | Phase 6. Root of tenant-scoped call recordings: `<dir>/customer_<id>/<uuid>.wav`. On the shared `media_spool` volume the API uploads to object storage. |
| `RECORD_DEFAULT_MAXLEN` | `3600` | Phase 6. Default `<Record>` maxLength (seconds) when the verb omits it. |
| `REC_NOTIFY_TIMEOUT` | `5` | Phase 6. curl `--max-time` (seconds) for the recordings-ingest notify POST (lib/rec_notify.lua). |
| `STREAM_SAMPLE_RATE` | `8000` | Phase 6. Sample rate passed to `uuid_audio_stream` for `<Stream>`/`<Connect><Stream>` (mod_audio_stream wants numeric `8000`/`16000`). |
| `TTS_ENGINE` | `tts_commandline` | Phase 7. `<Say>` TTS engine. **Default = Piper** (neural, offline) via `mod_tts_commandline`. The speak app is `<engine>\|<voice>\|<text>`, so set this to any other speak engine — `flite` (mod_flite is BUILT + loaded as the fallback engine; set `TTS_ENGINE=flite`), or a cloud engine — to swap TTS with NO code change. entrypoint.sh exports this default so env + `$${tts_engine}` agree. |
| `TTS_DEFAULT_VOICE` | `slt` | Phase 7. Voice token used when `<Say>` omits `voice`. With Piper, `scripts/bin/piper_tts.sh` maps known/unknown tokens (incl. `slt`) to its default model (`en_US-lessac-medium`); with `TTS_ENGINE=flite` it is read as a flite voice (kal/kal16/awb/rms/slt). |
| `PIPER_DIR` | `/opt/piper` | Phase 7. Piper install root (binary + bundled libonnxruntime/espeak-ng-data). Set in the Dockerfile. |
| `PIPER_VOICES_DIR` | `/opt/piper/voices` | Phase 7. Where `<voice>.onnx`/`.onnx.json` models live. Add models here + extend `piper_tts.sh`'s voice map for multi-voice. |
| `PIPER_DEFAULT_MODEL` | `en_US-lessac-medium` | Phase 7. Piper model (basename, no ext) used for unknown/omitted voices. |
| `CONF_AUDIO_PROFILE` | `default` | Phase 7. mod_conference profile for `<Conference>` (audio). |
| `CONF_VIDEO_PROFILE` | `video` | Phase 7. mod_conference profile used when `<Conference>` carries a `video` attribute. |

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

1. **ESL password (no ClueCon)**: `event_socket.conf.xml` reads `$${esl_password}`, templated from `ESL_PASSWORD` by a freeswitch.xml `X-PRE-PROCESS exec-set` at parse time. Dev default is `fs_esl_dev_pw` (NOT ClueCon). `entrypoint.sh` HARD-FAILS if `ESL_PASSWORD=ClueCon`. The dev `.env` carried `FREESWITCH_ESL_PASSWORD=ClueCon` historically — that MUST be a strong value (it feeds both FS `ESL_PASSWORD` and the API's `FREESWITCH_ESL_PASSWORD`, which no longer has a ClueCon fallback). `fs_cli` (and the compose healthcheck) must pass `-p $ESL_PASSWORD`.

   **Storage handoff (Phase 4)**: Voicemail and recordings write to the shared `/media/spool` volume (also mounted in the API container), which the API uploads to object storage. `mod_voicemail` `storage-dir=/media/spool/voicemail/`; `$${recordings_dir}=/media/spool/recordings`. `entrypoint.sh` also symlinks the in-image `/var/lib/freeswitch/{voicemail,recordings}` onto the spool so legacy/self-recorded paths land there too. handlers/ucaas.lua POSTs deposit metadata to the API `POST /v1/voicemail/ingest` via lib/vm_notify.lua (fail-open).

   **WebRTC needs TURN**: STUN-only fails behind symmetric NAT. The sibling `coturn` service (`docker/coturn/turnserver.conf`) provides the TURN relay; the API mints time-limited credentials from the shared `TURN_SECRET`. Verto WSS TLS cert paths are env-driven (`VERTO_TLS_PEM`/`VERTO_TLS_CHAIN`, dev self-signed under `conf/tls/`).

   **PRODUCTION WebRTC TLS (PROD-5 — drop-in cert, no code change):** browsers require a CA-trusted cert on BOTH the Verto WSS listener (8083) and the coturn `turns:` listener (5349). The wiring is already env/path-driven — production only provisions the cert:
   - **Verto WSS (mod_verto):** obtain a CA-issued cert for the platform FQDN (a combined cert+privkey PEM, e.g. Let's Encrypt `fullchain.pem`+`privkey.pem` concatenated), mount it into the FS container, and point `VERTO_TLS_PEM` (combined PEM) and `VERTO_TLS_CHAIN` (cert/CA chain) at the mounted paths. `freeswitch.xml` exec-sets `$${verto_tls_pem}`/`$${verto_tls_chain}` from those env vars; `verto.conf.xml` reads them as `secure-combined`/`secure-chain`. No file edit — just set the env + mount. The committed `conf/tls/wss.pem`/`wss.crt` are dev self-signed only.
   - **coturn `turns:` TLS:** see the PRODUCTION block in `docker/coturn/turnserver.conf` — mount the CA cert at `/etc/coturn/certs`, uncomment `cert=`/`pkey=` (or envsubst `${TURN_TLS_CERT}`/`${TURN_TLS_KEY}`, or append `--cert`/`--pkey` CLI overrides), restart. coturn does NOT expand env inside its config file, so use one of those three injection methods.

2. **mod_local_stream disabled**: It requires `local_stream.conf.xml` which doesn't exist. When xml_curl can't reach the API during startup, the missing config causes a CRIT abort. RCF uses `silence_stream://-1` for hold music instead.

3. **mod_httapi and mod_http_cache: built-but-not-loaded**: The Dockerfile ENABLES them at build time (`sed` uncomments them in `build/modules.conf.in`, lines 129/131), so the modules exist in the image. But `modules.conf.xml` leaves their `<load>` lines commented (lines 83/92), so they are NOT loaded at runtime. They are not loaded because their configs would need to be served by xml_curl, which is unreachable during module load on the media VM. To enable, uncomment in `modules.conf.xml` AND provide reachable config.

4. **NAT handling is critical**: Both internal and external profiles set `local-network-acl=loopback.auto` and `apply-nat-acl=rfc1918.auto`. This forces ext-sip-ip/ext-rtp-ip into SDP and SIP headers for ALL traffic except loopback. Without this, Docker 172.28.x.x IPs leak into SDP causing one-way audio.

5. **Two sofia profiles**: Internal (5080) receives inbound from Kamailio. External (5090) sends outbound to Kamailio. The external profile is needed because the internal profile does NOT apply ext-sip-ip to outbound Via/Contact headers.

6. **Lua package path**: mod_lua adds script-directory as a searcher, which breaks `require("redis")` because it tries to read the scripts directory as a file. All scripts prepend explicit luarocks paths and use `loadfile()` instead of `require()` for local modules.

7. **Redis code removed from inbound_router.lua (RCF-V1)**: The redis-lua library has connection pooling issues inside mod_lua's threading model. The route cache, fraud prefix check, and velocity limiting were deleted from the script (old code in git history; re-adding needs a synchronous client). Calls route via PostgreSQL only. trunk_outbound/outbound_api still load redis fail-open (via `loadfile()`). NOTE: the tier-aware `api_outbound.lua` was DELETED in the Phase 9 remediation as dead code — the live ESL-originate outbound API handler is `outbound_api.lua` (applied directly to the A-leg by esl_client.py's `&lua(outbound_api.lua)` originate; no dialplan extension).

8. **Session timer export**: Channel variables must be `export`ed (not just `set`) to propagate to the B-leg. Without this, Bandwidth tears down calls after Session-Expires (30s) because FreeSWITCH doesn't send refresh re-INVITEs.

9. **Gateway syntax deprecated**: All outbound bridges use `sofia/external/dest@proxy` instead of `sofia/gateway/carrier/dest`. The gateway syntax produced corrupted Contact headers (`sip:gw+carrier_primary@...`).

10. **Recording & streaming (Phase 6)**: `<Record>` and `<Dial record>` use CORE FreeSWITCH (`record` / `record_session`) — NO extra module — writing tenant-scoped WAVs to `/media/spool/recordings/customer_<id>/<uuid>.wav` on the shared spool, then POSTing metadata to the API `POST /v1/recordings/ingest` via `lib/rec_notify.lua` (fail-open; on Docker Desktop FS→API is unreachable, which is an expected clean no-op — prod works). `<Stream>`/`<Connect><Stream>` use the BUILT mod_audio_stream (`uuid_audio_stream`); when absent the verb warns loudly (no silent no-op) so `<Record>` is never blocked on streaming. Recording info (`RecordingUrl`/`RecordingSid`) flows into status/action callbacks.

11. **`<Conference>` verb contract (Phase 7)**: a programmatic `<Conference name="X">` for customer C joins the **existing** mod_conference room **`conf_<C>_<sanitized X>`** (lowercase, every non-alnum char → `_`). This `conf_` namespace is DISTINCT from the UCaaS `*88XX` dialplan rooms (`room_<cid>_<n>`) and is the SHARED CONTRACT the API's `conference.py` uses to drive ESL control (`conference <room> list|mute|kick`) and tenant-scoped listing on programmatically-created rooms. Conferencing is NOT rebuilt — the verb just exposes the already-built mod_conference. The conference app blocks until the member leaves. Twilio nests `<Conference>` in `<Dial>`; a top-level `<Conference>` is also accepted.

12. **Call queues (Phase 7)**: TwiML `<Enqueue>`/`<Dial><Queue>` use **mod_fifo** (already built; loaded via `modules.conf.xml` + minimal `fifo.conf.xml`). Queues are dynamic + tenant-scoped (`fifo_<cid>_<name>`). **Limitation:** mod_fifo's `in` app blocks the caller, so Twilio's waitUrl-driven TwiML and a mid-wait `<Leave>` cannot run during the wait — `waitUrl` is used only as hold music and `<Leave>` works only as a top-level document-ender. Full `<Leave>`/waitUrl parity would need mod_callcenter's non-blocking wait-loop or a DTMF abort key.

13. **TTS = Piper, in-image (Phase 7 — RESOLVED)**: `<Say>` defaults to **Piper** (neural, offline, MIT) via `mod_tts_commandline`; **mod_flite is built + loaded as the fallback engine** (`TTS_ENGINE=flite` — debian `flite1-dev`/`libflite1`, voices kal/kal16/awb/rms/slt). NOTE: the original image NEVER built flite — it was added here so flite is a genuine fallback, not just a `say:` degrade. The engine stays a drop-in hook via `TTS_ENGINE` (speak app = `<engine>|<voice>|<text>`); if the chosen engine fails at runtime, `api_voice.lua` still degrades to `say:PRONOUNCED`. `voice`/`language` map to engine voices; SSML/`<speak>` markup is stripped so it is never read literally (not a full SSML engine). Cloud (Polly/Google) is still a config-only swap via `mod_unimrcp`/`mod_polly`. See "Piper neural TTS (Phase 7)" below for the install + wiring + sample-rate note.

### Piper neural TTS (Phase 7 — in-image, no sidecar)

`<Say>` renders with **Piper** (github.com/rhasspy/piper) baked into the runtime image. In-image (not a sidecar) is deliberate: a sidecar would hit the documented Docker-Desktop FS→bridge network isolation; in-image renders with **zero network** and is locally verifiable.

- **Install (Dockerfile, runtime stage):** downloads the arch-correct prebuilt Piper release tarball (`ARG TARGETARCH`: `amd64`→`piper_linux_x86_64.tar.gz`, `arm64`→`piper_linux_aarch64.tar.gz`, pinned `PIPER_VERSION=2023.11.14-2`) into `/opt/piper` — the tarball bundles the `piper` binary + `libonnxruntime` + `libpiper_phonemize` + `espeak-ng-data` (nothing to compile). Then downloads ONE en-US voice (`en_US-lessac-medium.onnx` ~63 MB + `.onnx.json`) from huggingface `rhasspy/piper-voices` into `/opt/piper/voices`. A build-time smoke test renders a throwaway WAV so a broken download fails the build. Runtime dep added: `libgomp1` (onnxruntime OpenMP). Lean by design (one voice).
- **Module:** `mod_tts_commandline` is enabled in the builder (`sed` un-comments `asr_tts/mod_tts_commandline` in `build/modules.conf.in`) — it has NO build deps (just shells out + reads the WAV) — and `<load>`ed in `modules.conf.xml`. Enabling it forces a full FreeSWITCH recompile (it is compiled into the FS build), unlike the additive mod_audio_stream layers. `mod_flite` is ALSO built+loaded in the same recompile (debian `flite1-dev` → `HAVE_FLITE`; runtime `libflite1`) as the fallback engine.
- **Wiring:** `conf/autoload_configs/tts_commandline.conf.xml` sets `command = scripts/bin/piper_tts.sh ${file} ${rate} ${voice} ${text}`. mod_tts_commandline passes every `${...}` token through `switch_util_quote_shell_arg()`, so all are **shell-safe and `${text}` is a single argument** — there is NO shell-injection path from customer `<Say>` text (verified in `mod_tts_commandline.c`). The wrapper maps the voice token to a model (ships one → `en_US-lessac-medium`; unknown/`slt`→default), then `printf '%s' "$TEXT" | piper --model … --output_file "$file"`.
- **Sample rate:** Piper medium voices emit a **22050 Hz** 16-bit mono WAV. mod_tts_commandline writes a temp `<uuid>.tmp.wav`, then FreeSWITCH opens it with mod_sndfile which reads the **native** rate from the WAV header and **resamples to the call rate** (e.g. 8000 for PCMU). So `${rate}` is informational — we do NOT force Piper's rate. Correct WAV header is all that's required.
- **Default:** `TTS_ENGINE=tts_commandline` is the default in three agreeing places: `handlers/api_voice.lua` (`os.getenv("TTS_ENGINE") or "tts_commandline"`), `entrypoint.sh` (`export TTS_ENGINE="${TTS_ENGINE:-tts_commandline}"`), and the `$${tts_engine}` exec-set global in `freeswitch.xml`. flite still works end-to-end with `TTS_ENGINE=flite`.
- **Multi-voice (future):** drop `<name>.onnx`+`.onnx.json` into `/opt/piper/voices` (Dockerfile) and add a `case` in `piper_tts.sh` mapping `<Say voice="…">` tokens to models. One voice is shipped today.

## Volumes

- `./docker/freeswitch/conf` mounted to `/usr/local/freeswitch/conf` (config hot-reload; note this OVERLAYS the Dockerfile-generated TLS certs with the repo's `conf/tls/`, so runtime Verto certs are the committed `wss.pem`/`wss.crt`)
- `./docker/freeswitch/scripts` mounted to `/usr/local/freeswitch/scripts` (script hot-reload)
- `freeswitch_logs` named volume at `/var/log/freeswitch`
- `media_spool` shared volume at `/media/spool` (voicemail + recordings; ALSO mounted in the API container, which uploads from it to object storage). Present in the local `docker-compose.yml`; add the equivalent on the media VM.

## Network Ports

| Port | Protocol | Purpose |
|---|---|---|
| 5060 | UDP/TCP | External SIP profile (carrier-facing, currently unused for inbound) |
| 5080 | UDP/TCP | Internal SIP profile (receives from Kamailio) |
| 5081 | TCP | Internal TLS (disabled) |
| 5090 | UDP/TCP | External SIP profile (outbound to Kamailio/carriers) |
| 8021 | TCP | Event Socket (ESL) |
| 8082 | TCP | mod_verto WebSocket (ws) — UCaaS softphone/conference signaling |
| 8083 | TCP | mod_verto secure WebSocket (wss) — TLS via `$${verto_tls_pem}` |
| 16384-49151 | UDP | RTP media (32K ports for ~10K concurrent B2BUA calls) |

## File Layout

```
docker/freeswitch/
  Dockerfile              # Multi-stage build
  entrypoint.sh           # Loopback IP hack for GCE hairpin NAT
  conf/                   # FreeSWITCH configuration (see conf/CLAUDE.md)
  scripts/                # Lua routing scripts (see scripts/CLAUDE.md)
```
