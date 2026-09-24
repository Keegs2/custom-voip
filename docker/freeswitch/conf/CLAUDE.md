# FreeSWITCH Configuration -- RCF-V1

## freeswitch.xml -- Master Configuration

The master config file defines global variables using `X-PRE-PROCESS` directives and includes all sub-configurations. Variables defined here are available throughout all configs as `$${variable_name}`.

### Variable System: exec-set Pattern

Every configurable value follows the same pattern -- set a default, then override from environment:

```xml
<X-PRE-PROCESS cmd="set" data="pg_host=postgres"/>
<X-PRE-PROCESS cmd="exec-set" data="pg_host=echo ${DB_HOST:-postgres}"/>
```

`exec-set` runs a shell command at XML parse time. The `echo ${VAR:-default}` pattern reads the environment variable with a fallback. This happens ONCE at startup (not per-call).

### Global Variables Defined

**Network/NAT:**
- `external_rtp_ip`, `external_sip_ip` -- Public IP for SDP and SIP headers. Default `auto-nat`, overridden by `EXTERNAL_RTP_IP`/`EXTERNAL_SIP_IP` env vars. Auto-nat fails in Docker (resolves to container IP).
- `homer_ip` -- Homer HEP capture endpoint. From `HOMER_IP` env var.
- `sbc_proxy_ip` -- Primary Kamailio SBC address. From `SBC_PROXY_IP` env var.
- `sbc_proxy_ip_failover` -- Secondary SBC address for the inbound_router.lua 4-attempt failover loop (freeswitch.xml:71). From `SBC_PROXY_IP_FAILOVER` env var; falls back to `SBC_PROXY_IP` if unset.

**SIP Ports:**
- `internal_sip_port=5080` -- Receives from Kamailio
- `internal_tls_port=5081` -- TLS (disabled)
- `external_sip_port=5060` -- Standard SIP
- `external_tls_port=5061` -- TLS (disabled)

**RTP:**
- `rtp_start_port=16384`, `rtp_end_port=49151` -- 32K port range for ~10K concurrent B2BUA calls

**Database (PostgreSQL via PgBouncer):**
- `pg_host`, `pg_port` (6432), `pg_dbname` (voip), `pg_user` (freeswitch), `pg_pass` -- All overridable from `DB_*` env vars

**Redis:**
- `redis_host`, `redis_port` (6379) -- From `REDIS_HOST`/`REDIS_PORT` env vars

**API Server:**
- `api_host`, `api_port` (8000) -- From `API_HOST`/`API_PORT` env vars

**ESL:**
- `esl_password` -- Default `ClueCon`, override via `ESL_PASSWORD` env var. CHANGE IN PRODUCTION.

**Codecs:**
- `global_codec_prefs=PCMU,PCMA,G722,speex`
- `outbound_codec_prefs=PCMU,PCMA`

**Audio:**
- `hold_music=silence_stream://-1` -- No sound files installed; uses silence
- `sounds_dir=/usr/share/freeswitch/sounds` -- Empty; built from source without sound packages

### Section Includes

```xml
<section name="configuration"> autoload_configs/*.xml </section>
<section name="dialplan">      dialplan/*.xml           </section>
<section name="directory">     directory/*.xml           </section>
<section name="languages">     lang/en/*.xml             </section>
```

---

## Sofia Profiles

### Why Two Profiles (Internal vs External)

FreeSWITCH's internal profile does NOT apply `ext-sip-ip` to outbound INVITE Via/Contact headers. The external profile DOES. This is by design in mod_sofia.

- **Internal** (port 5080): Receives inbound calls from Kamailio. Applies ext-rtp-ip to SDP in responses.
- **External** (port 5090): Sends outbound calls to Kamailio -> Bandwidth. Applies ext-sip-ip to Via, Contact, AND SDP in outbound INVITEs.

Without the external profile, outbound INVITEs would contain Docker internal IP (172.28.x.x) in Via/Contact, which Bandwidth cannot route back to.

### Internal Profile (`conf/sofia/internal.xml`)

```
Profile name: internal
Listen: $${local_ip_v4}:5080
Context: public (all calls enter public dialplan context)
```

**NAT Configuration (CRITICAL):**
- `ext-rtp-ip=$${external_rtp_ip}` -- Public IP in SDP c= line
- `ext-sip-ip=$${external_sip_ip}` -- Public IP in Via/Contact
- `local-network-acl=loopback.auto` -- Only 127.0.0.0/8 is "local". Everything else (including Docker 172.28.x.x) triggers ext-rtp-ip usage. Without this, Kamailio's 172.28.0.1 would be treated as "local" and SDP would get private IP.
- `apply-nat-acl=rfc1918.auto` -- Belt-and-suspenders: force ext-ip for any RFC1918 source

**Codec Negotiation:**
- `inbound-codec-prefs=PCMU,PCMA,G722,opus` -- PSTN-optimized
- `inbound-codec-negotiation=greedy` -- Prefer our list
- `inbound-late-negotiation=false` -- Disabled for B2BUA/RCF. Late negotiation delays SDP answer and prevents early media/ringback.

**Authentication:**
- `auth-calls=false` -- Kamailio handles auth. Traffic is trusted via ACL.
- `apply-inbound-acl=trusted` -- Only accepts traffic from trusted ACL (RFC1918 ranges)

**High Volume Optimizations:**
- `inbound-use-callid-as-uuid=true` -- Reduces lookup overhead
- `track-calls=false` -- Tracking done in Lua/Redis
- `manage-presence=false` -- No presence for B2BUA
- `enable-compact-headers=false` -- Kamailio needs full-form headers for manipulation
- `max-proceeding=5000` -- Cap incomplete calls

**Session Timers (RFC 4028):**
- `enable-timer=true`
- `sip-session-timeout=1800` / `sip-min-session-expires=90` — **IGNORED**: not mod_sofia params (sofia.c parses `session-timeout` / `minimum-session-expires`). Left in place on purpose. The real floor is `minimum-session-expires=90`. Profile session_timeout is therefore 0, and because aggressive-nat-detection NAT-flags every SBC-relayed INVITE, sofia_answer_channel uses `SOFIA_NAT_SESSION_TIMEOUT` (90 → 120 in sofia-sip) unless the channel var `sofia_session_timeout` is set — the Lua routers set it to 1800 (2026-09-24). Do NOT rename the param to `session-timeout`: the NAT override would still win (90 → cut at ~81s).

**Media:**
- `rtcp-audio-interval-msec=5000` -- Drives ONLY `rtcp_stats()` + the RTCP SR/RR FS sends. It does NOT gate quality measurement: `check_jitter()`/`do_mos()` and the quality patch v1 tracker run on the RTP read path regardless of RTCP (the old comment claiming otherwise was wrong and was rewritten 2026-09).
- `rtp-keepalive-sec=15` -- Sends comfort packets every 15s to keep GCE NAT pinholes open (30s idle timeout)
- `suppress-cng=false` -- Generates Comfort Noise (RFC 3389) during silence for NAT keepalive + user experience
- `rtp-timeout-sec=60` -- Hang up if no RTP for 60s
- `rtp-secure-media=false` -- SRTP disabled for Bandwidth carrier interconnect

**Homer SIP Capture:**
- The HEP endpoint and `capture_id=200` are set ONCE in `sofia.conf.xml`
  `<global_settings>` `capture-server`. This is a GLOBAL-ONLY setting in mod_sofia.
- Per-profile `capture-server` params are silently ignored by mod_sofia, so
  per-profile capture IDs are impossible. BOTH the internal and external profiles
  share `capture_id=200`. (Profiles may set only `sip-capture=yes/no` to
  enable/disable capture, not the ID.)
- Capture ID 200 distinguishes FreeSWITCH from Kamailio (100) in Homer ladder diagrams.

**Gateways:**
All carrier gateways are DISABLED (commented out). Outbound calls use `sofia/external/dest@proxy` with `X-Carrier` header instead. The deprecated gateway definitions are kept as documentation of Bandwidth trunk configurations:
- `carrier_primary` -> Dallas 67.231.2.12 (primary carrier for all products)
- `carrier_secondary` -> LA 216.82.238.134 (secondary/failover carrier)
- `test_echo` -> Loopback (still active, for testing)

**Multi-Tenant Domain Handling:**
`force-register-domain` is NOT set. Each customer registers under `customer_{id}.voiceplatform.local`. FreeSWITCH resolves users via mod_xml_curl. Overlapping extension numbers are supported (Customer A ext 100 != Customer B ext 100).

### External Profile (`conf/sofia/external.xml`)

```
Profile name: external
Listen: $${local_ip_v4}:5090
Context: public
```

**Key differences from internal:**
- `ext-sip-ip` and `ext-rtp-ip` control outbound INVITE headers (this is WHY this profile exists)
- `aggressive-nat-detection=false` and `NDLB-force-rport=false` -- Not needed; ext-ip handles addressing. The **internal** profile sets BOTH of these to `true` (for local Zoiper softphone testing where real NAT exists); the external profile leaves them `false`.
- Session timers enabled (`enable-timer`, `minimum-session-expires=90`); `sip-session-timeout`/`sip-min-session-expires` ignored as on internal. B-leg Session-Expires comes from Kamailio TO_CARRIER + the carrier's 200 OK.
- Homer capture is GLOBAL only (`capture_id=200` for both profiles, set in `sofia.conf.xml`); there is no per-profile capture_id.
- `rtcp-audio-interval-msec=5000` mirrors internal (RTCP reports only). B-leg quality DOES reach the CDR: `log-b-leg=true` posts each carrier B-leg's own `rtp_audio_in_*` (callee->platform) into a `leg='B'` row, which feeds the A row's `call_quality_*` (worse direction). Removing this param would not affect any quality stat.
- No gateways defined -- bridges use `sofia/external/dest@proxy` syntax
- `local-network-acl=loopback.auto` -- Same fix as internal. Without this, 172.28.0.1 (Kamailio) gets sip-ip in Contact instead of ext-sip-ip.

---

## modules.conf.xml

Loaded modules organized by purpose:

| Category | Loaded | Disabled |
|---|---|---|
| Logging | mod_console, mod_logfile | mod_syslog |
| Codecs | mod_opus, mod_g729, mod_amr, mod_spandsp | (G.711 built-in) |
| Dialplan | mod_dialplan_xml | mod_dialplan_asterisk |
| Endpoints | mod_sofia, mod_loopback | mod_verto, mod_rtc |
| Scripting | mod_lua | mod_v8 |
| HTTP/API | mod_event_socket, mod_xml_curl, mod_curl | mod_httapi, mod_http_cache |
| CDR | mod_cdr_csv, mod_json_cdr | mod_cdr_sqlite, mod_cdr_pg_csv |
| Audio | mod_tone_stream, mod_sndfile, mod_native_file, mod_shout, mod_say_en | mod_local_stream, mod_flite |
| Database | mod_db, mod_hash | mod_odbc_query |
| Disabled UCaaS | -- | mod_conference, mod_voicemail, mod_valet_parking, mod_av |

**Why mod_local_stream is disabled:** It requires `local_stream.conf.xml`. When xml_curl can't reach the API (startup or media VM), the missing config causes CRIT abort. RCF uses `silence_stream://` instead.

**Why mod_httapi and mod_http_cache are disabled:** Same missing-config issue. Their configs would need to be served by xml_curl, which is unreachable during module load on the media VM.

---

## acl.conf.xml

Seven ACL lists:

| ACL Name | Default | Purpose |
|---|---|---|
| `trusted` | deny | Kamailio SBC, API server, internal services. Allows all RFC1918 + loopback. |
| `carriers` | deny | Bandwidth signaling IPs: 67.231.2.12, 216.82.238.134. Also Docker 172.28.0.0/16. |
| `sip_trunks` | deny | Direct customer PBX connections (currently empty; all traffic through Kamailio). |
| `event_socket` | deny | ESL access control. Allows loopback + all RFC1918 ranges. |
| `loopback.auto` | deny | 127.0.0.0/8 and ::1/128 only. Used as `local-network-acl` on both profiles. |
| `blocked` | allow | Known bad actors (default-allow, deny specific CIDRs). |
| `domains` | deny | Legacy compatibility. Internal ranges only. |

**Production TODO:** Replace broad RFC1918 ranges with specific VM IPs.

---

## xml_curl.conf.xml

Dynamic directory provisioning via HTTP POST to the API server.

```xml
gateway-url: http://$${api_host}:$${api_port}/freeswitch/directory
bindings: directory
method: POST
timeout: 3 seconds
```

**How it works:**
1. FreeSWITCH needs to authenticate a user (REGISTER, INVITE) or resolve a `user/` dial string
2. POSTs to API with SIP request details (domain, user, etc.)
3. API extracts customer_id from domain (`customer_{id}.voiceplatform.local`)
4. API returns FreeSWITCH-compatible XML with user params/variables
5. If user not found, returns empty `<section/>` and FS falls back to static directory

**Performance:** API caches directory lookups in Redis (30s TTL) to avoid hitting PostgreSQL on every REGISTER refresh.

**Failure mode:** If API unreachable (3s timeout), FS falls back to static directory XML (default.xml with test extensions 1001-1003).

---

## json_cdr.conf.xml

Posts JSON CDR data to FastAPI after every completed call — and, since the
CDR A/B leg split (2026-09-23, `docs/CDR_LEG_SPLIT_CONTRACT.md`), after every
originated B-leg too.

```
URL: http://$${api_host}:$${api_port}/v1/cdrs/ingest
Timeout: 5 seconds
Retries: 2 (with 2s delay)
```

**Key settings (read the param, not the neighbouring comment — the old
comments were attributed to the wrong params):**
- `log-b-leg=true` -- **the split is ON.** The ONLY live leg filter; `false` =
  A-leg only. The per-zone cutover switch. The old `cdr-leg=a` line was NOT a
  real mod_json_cdr param (inert) and has been removed.
- A B-leg POST becomes a B row ONLY if it carries `cdr_leg=B` +
  `cdr_carrier_leg=true` — set per-leg on carrier dial strings by
  `inbound_router.lua` / `trunk_outbound.lua` (see `scripts/CLAUDE.md` "CDR A/B
  leg split"). On-net B-legs (PBX delivery, local ext) post but write nothing.
- `prefix-a-leg=true` -- on-disk file naming only (A-leg files `a_`-prefixed).
- `encode=true` -- body is `application/x-www-form-urlencoded` `cdr=<url-encoded
  JSON>` (ingest handles it); not base64, not a Content-Type knob.
- `log-http-and-disk=true` -- EVERY CDR is also written to `log-dir`
  (`/var/log/freeswitch/json_cdr`, not only on failure); with B-legs on, one
  file per bridge attempt — watch volume growth. Failed-after-retries POSTs go to
  `err-log-dir`.
- All channel variables included (`channel-vars` whitelist stays COMMENTED —
  the stale list has none of the `cdr_*` vars; enabling it drops every B row).
- `encode-values=false` -- values not URL-encoded inside the JSON.
- **Synchronous-post exposure:** a slow/dead API holds each finished session up
  to `timeout×(1+retries)+delay×retries` = 19 s (thread + memory; RTP already
  released). B-legs report on their own session threads (never delay the A-leg's
  next failover attempt), but the split multiplies posting sessions (≤9 per RCF
  call in a full failover storm) → sustained API outage at high CPS pushes the
  session count toward `switch.conf` `max-sessions=10000`.

**Activation / revert on a running media VM (no container restart).** The conf
dir is bind-mounted (`docker-compose.media.yml` `./docker/freeswitch/conf:/usr/local/freeswitch/conf`),
so `git pull` changes the file on disk, but mod_json_cdr reads it ONLY at module
load and FS serves config from the in-memory XML registry — so BOTH steps are
needed: `reloadxml` (re-parse; safe for live calls) then `reload mod_json_cdr`
(unload+load). `xml_curl` binds only `directory`, so the local file is
authoritative. Scripts (Lua) are also bind-mounted and take effect on the NEXT
call right after `git pull` — the `[cdr_*]` B-leg vars are inert until
`log-b-leg=true` is loaded. Deploy the API ingest gate FIRST (else B-leg POSTs
hit the legacy STIR-outcome path — plan §4.7 trap 1).
- Activate: `sudo docker exec voip-freeswitch sh -c '/usr/local/freeswitch/bin/fs_cli -p "$ESL_PASSWORD" -x "reloadxml" && /usr/local/freeswitch/bin/fs_cli -p "$ESL_PASSWORD" -x "reload mod_json_cdr"'`
- Verify loaded: `sudo docker exec voip-freeswitch sh -c '/usr/local/freeswitch/bin/fs_cli -p "$ESL_PASSWORD" -x "module_exists mod_json_cdr"'` → `true` (if `false`, run the same with `-x "load mod_json_cdr"` — while unloaded NO CDRs are written at all).
- Revert (split off): `cd /opt/revup && sudo sed -i 's|<param name="log-b-leg" value="true"/>|<param name="log-b-leg" value="false"/>|' docker/freeswitch/conf/autoload_configs/json_cdr.conf.xml && sudo docker exec voip-freeswitch sh -c '/usr/local/freeswitch/bin/fs_cli -p "$ESL_PASSWORD" -x "reloadxml" && /usr/local/freeswitch/bin/fs_cli -p "$ESL_PASSWORD" -x "reload mod_json_cdr"'` — leaves the file dirty in git; restore with `sudo git checkout -- docker/freeswitch/conf/autoload_configs/json_cdr.conf.xml` (+ the activate line) to re-enable.
- **In-flight impact of the reload:** live calls' media/signaling are untouched;
  their CDRs are posted at their own hangup by the reloaded module (so B-legs
  bridged before the reload ALSO post — without `cdr_*` if bridged before the
  `git pull` → ingest writes no row). A session that reaches its reporting
  state inside the unload→load gap (milliseconds) is neither posted nor written
  to disk — a lost CDR. Unloading while a session thread is mid-POST inside the
  module is a use-after-unload hazard FS does not guard against; run it at low
  traffic with a healthy API (`show calls count` first). A container restart
  instead drops EVERY live call — never use it for this.

## RTP quality variables in the CDR (quality patch v1)

The json_cdr body carries ALL channel variables, so the patched image's new
`rtp_audio_in_qpatch` / `rtp_audio_in_seq_*` / `rtp_audio_in_rfc3550_*` variables reach the
API with no config change here (do NOT enable the `channel-vars` whitelist: it would drop
them along with the `cdr_*` vars). Variable table, semantics and the rebuild rule:
`docker/freeswitch/CLAUDE.md` "Quality patch v1"; contract `docs/CALL_QUALITY_ACCURACY_PLAN.md`
A.5. The lab (`docker/freeswitch/lab/`) runs this same json_cdr.conf.xml with only the `url`
rewritten to `http://127.0.0.1:9/` so every CDR lands on disk (`log-http-and-disk=true`).

## Dialplan Structure (`conf/dialplan/public.xml`)

Single file containing three contexts:

### Context: `default` (registered users)

For local Zoiper testing only. Contains:
1. **test_rcf_did** -- `555XXXX` pattern transfers to public context for Lua routing
2. **echo_test_default** -- `9196` echo test
3. **default_outbound** -- PSTN calls from registered users. Normalizes to E.164, runs `lookup_user_did.lua` for caller ID, bridges via `sofia/external/dest@sbc_proxy_ip:5060` with X-Carrier header. Primary=primary (Dallas), failover=secondary (LA).
4. **default_catchall** -- `.*` final fallback in the default context: logs the unmatched number, plays a reorder tone, and hangs up NO_ROUTE_DESTINATION.

### Context: `public` (carrier/external traffic)

Primary context. Processing order:

1. **Anti-fraud blocks** (continue=false, fast reject):
   - Empty destinations -> 404
   - URI injection (contains @) -> 403
   - Invalid characters (non-digit except +*#) -> 404
   - Excessive length (>20 digits) -> 404

2. **Special numbers**: 9196 (echo), 9195 (delay echo), 9198 (tone), 9197 (milliwatt)

3. **Outbound API calls** (API Calling product **RETIRED**): Matches `outbound_api=true` channel variable (set by ESL originate). Runs `api_outbound.lua` with tier-aware CPS limits. With `API_CALLING_ENABLED` off (default) the script hangs up `CALL_REJECTED` immediately; the XML extension is intentionally left in place (no reloadxml).

4. **API product type** (RETIRED, same gate): Matches `product_type=api` AND `direction=outbound`. Alternative entry for API calls; runs `api_outbound.lua`, which rejects when the flag is off.

5. **Trunk header debug** (`continue=true`): Non-terminating `^(.*)$` extension that logs the inbound X-Trunk-ID header variants (debugging header casing). Falls through to the next extension.

6. **Trunk outbound from Kamailio**: Matches `sip_h_X-Trunk-ID` regex `^\s*\d+\s*$`. Copies X-Trunk-ID, X-Customer-ID, X-Max-Channels headers to channel variables. Runs `trunk_outbound.lua`.

6. **Trunk outbound legacy**: Matches `trunk_id` channel variable (set by earlier dialplan logic).

7. **Inbound handler** (main routing): Matches `^(\+?1?\d{10,15})$`. Sets direction=inbound, runs `inbound_router.lua`. If Lua returns without completing, responds 503 (not 404 -- DID may exist but service unavailable).

8. **Inbound short format**: Matches `^(\d{10})$`. Normalizes to +1 prefix, transfers to public context.

9. **Star codes**: `*XX` to `*XXXX` -> 404 (placeholder)

10. **Emergency 911**: Routes 911/933 through Kamailio via external profile with failover.

11. **Catchall**: Everything unmatched -> 404

### Context: `features`

Transfers all calls back to public context. Used for attended transfer parking.

**Important extension ordering note:** Trunk outbound extensions fire BEFORE the inbound handler to prevent outbound trunk calls from accidentally matching as inbound DIDs.

---

## Directory Structure (`conf/directory/default.xml`)

Static directory for local testing. Domain: `$${domain}` (voiceplatform.local).

Three test extensions pre-configured:
- 1001, 1002, 1003 -- password `test1234`
- Context: `default`
- Voicemail enabled (but mod_voicemail disabled in RCF-V1)

The dial-string template uses `${sofia_contact(*/${dialed_user}@${dialed_domain})}` for reaching registered users.

Dynamic directory (production UCaaS extensions) is served by mod_xml_curl from the API server. Static directory is fallback only.

---

## Configuration Dependencies

```
freeswitch.xml
  |-- autoload_configs/modules.conf.xml     (what modules load)
  |-- autoload_configs/event_socket.conf.xml (ESL config)
  |-- autoload_configs/acl.conf.xml          (network ACLs)
  |-- autoload_configs/xml_curl.conf.xml     (dynamic directory)
  |-- autoload_configs/json_cdr.conf.xml     (CDR posting)
  |-- autoload_configs/sofia.conf.xml        (auto-includes sofia/*.xml)
  |     |-- sofia/internal.xml               (inbound profile :5080)
  |     |-- sofia/external.xml               (outbound profile :5090)
  |-- dialplan/public.xml                    (all dialplan contexts)
  |-- directory/default.xml                  (static test users)
  |-- lang/en/*.xml                          (minimal language defs)
```

## Common Modification Scenarios

**Adding a new carrier IP to ACL:** Edit `acl.conf.xml`, add node to `carriers` list. Reload: `fs_cli -x 'reloadacl'`.

**Changing codec preferences:** Edit `internal.xml` and `external.xml` `inbound-codec-prefs`/`outbound-codec-prefs`. Requires sofia profile restart: `fs_cli -x 'sofia profile internal restart'`.

**Changing RTP port range:** Must update BOTH `freeswitch.xml` (global vars) AND `switch.conf.xml` (if it exists). Values must match.

**Enabling TLS:** Uncomment TLS params in `internal.xml`, mount CA certs at `/usr/local/freeswitch/conf/tls/`, set `tls=true`.

**Changing ESL password:** Set `ESL_PASSWORD` environment variable. Restart container.
