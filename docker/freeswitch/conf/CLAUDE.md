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
- `sbc_proxy_ip` -- Kamailio SBC address. From `SBC_PROXY_IP` env var.

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
- `sip-session-timeout=1800` (30 min)
- `sip-min-session-expires=90` (minimum per RFC 4028)

**Media:**
- `rtp-keepalive-sec=15` -- Sends comfort packets every 15s to keep GCE NAT pinholes open (30s idle timeout)
- `suppress-cng=false` -- Generates Comfort Noise (RFC 3389) during silence for NAT keepalive + user experience
- `rtp-timeout-sec=60` -- Hang up if no RTP for 60s
- `rtp-secure-media=false` -- SRTP disabled for Bandwidth carrier interconnect

**Homer SIP Capture:**
- `capture-server=udp:$${homer_ip}:9060;hep=3;capture_id=200`
- `sip-capture=yes`
- Capture ID 200 distinguishes from Kamailio (100) in Homer ladder diagrams

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
- `aggressive-nat-detection=false` -- Not needed; ext-ip handles addressing
- `NDLB-force-rport=false`
- Session timers enabled with same values as internal (minimum-session-expires=90)
- Homer capture-id=201 (distinct from internal profile's 200)
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

Six ACL lists:

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

Posts JSON CDR data to FastAPI after every completed call.

```
URL: http://$${api_host}:$${api_port}/v1/cdrs/ingest
Timeout: 5 seconds
Retries: 2 (with 2s delay)
```

**Key settings:**
- `cdr-leg=a` -- Only A-leg CDRs (B-leg is redundant for billing)
- `log-http-and-disk=true` -- Fallback to disk when HTTP POST fails
- `log-dir=/var/log/freeswitch/json_cdr` -- Disk fallback path
- All channel variables included (no filtering) -- API picks what it needs
- `encode-values=false` -- Plain JSON, no URL encoding

---

## Dialplan Structure (`conf/dialplan/public.xml`)

Single file containing three contexts:

### Context: `default` (registered users)

For local Zoiper testing only. Contains:
1. **test_rcf_did** -- `555XXXX` pattern transfers to public context for Lua routing
2. **echo_test_default** -- `9196` echo test
3. **default_outbound** -- PSTN calls from registered users. Normalizes to E.164, runs `lookup_user_did.lua` for caller ID, bridges via `sofia/external/dest@sbc_proxy_ip:5060` with X-Carrier header. Primary=primary (Dallas), failover=secondary (LA).

### Context: `public` (carrier/external traffic)

Primary context. Processing order:

1. **Anti-fraud blocks** (continue=false, fast reject):
   - Empty destinations -> 404
   - URI injection (contains @) -> 403
   - Invalid characters (non-digit except +*#) -> 404
   - Excessive length (>20 digits) -> 404

2. **Special numbers**: 9196 (echo), 9195 (delay echo), 9198 (tone), 9197 (milliwatt)

3. **Outbound API calls**: Matches `outbound_api=true` channel variable (set by ESL originate). Runs `api_outbound.lua` with tier-aware CPS limits.

4. **API product type**: Matches `product_type=api` AND `direction=outbound`. Alternative entry for API calls.

5. **Trunk outbound from Kamailio**: Matches `sip_h_X-Trunk-ID` regex `^\s*\d+\s*$`. Copies X-Trunk-ID, X-Customer-ID, X-Max-Channels headers to channel variables. Runs `trunk_outbound.lua`.

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
