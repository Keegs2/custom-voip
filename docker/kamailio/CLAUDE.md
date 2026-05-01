# Kamailio SBC - Implementation Reference

## 1. Component Role

Kamailio acts as the Session Border Controller (SBC) for the RCF-V1 voice platform. It is the single entry/exit point for all SIP signaling between the public internet and FreeSWITCH. It performs:

- **Topology hiding**: Strips internal IPs (Docker, GCE VPC, loopback) from all outbound SIP headers and SDP bodies, presenting only the public IP to Bandwidth (the carrier).
- **Rate limiting and attack prevention**: Pike module + htable-based IP blocking, scanner detection, OPTIONS flood protection. Trusted sources (Bandwidth, FreeSWITCH) bypass all rate limiting.
- **Load balancing**: Dispatcher module distributes inbound calls across FreeSWITCH instances (currently one, horizontally scalable).
- **NAT keepalive**: Dispatcher sends OPTIONS probes every 5 seconds to Bandwidth IPs, keeping the GCE UDP NAT pinhole open (GCE has a 30-second UDP idle timeout).
- **SIP trunk IP authentication**: Queries PostgreSQL to authenticate customer PBX source IPs against the `trunk_auth_ips` table, with per-trunk CPS rate limiting.
- **Session timer management**: Adds RFC 4028 headers (Session-Expires, Min-SE) on outbound INVITEs and normalizes carrier replies so FreeSWITCH always sees a value it will honor.
- **HEP capture**: Sends all SIP messages to Homer via HEP3 for troubleshooting.
- **Carrier failover**: If primary Bandwidth IP fails (500/503/408/480/404), retries on secondary IP.

Kamailio does NOT handle media. RTP flows directly between Bandwidth and FreeSWITCH. There is no RTPEngine or RTPProxy.

## 2. Docker Image Build

**File**: `Dockerfile`

Base image: `debian:bookworm-slim`. Installs Kamailio 5.8.x from official repos with these module packages:

| Package | Purpose |
|---|---|
| kamailio | Core |
| kamailio-tls-modules | TLS support (optional, ifdef WITH_TLS) |
| kamailio-redis-modules | Distributed rate limiting (installed, not currently used) |
| kamailio-json-modules | JSON handling |
| kamailio-utils-modules | pike, htable |
| kamailio-extra-modules | uac, dialog |
| kamailio-presence-modules | SUBSCRIBE handling |
| kamailio-xml-modules | XML operations |
| kamailio-postgres-modules | PostgreSQL for trunk IP auth (sqlops) |
| kamailio-outbound-modules | NAT |
| kamailio-websocket-modules | Future WebRTC |

Key build steps:
1. Config files are copied as `.tmpl` templates: `kamailio.cfg` -> `kamailio.cfg.tmpl`, `dispatcher.list` -> `dispatcher.list.tmpl`
2. Self-signed TLS cert generated at build time (dev only)
3. Runs as `kamailio` user (non-root)
4. Healthcheck: `kamcmd core.uptime` every 30s
5. CMD args: `-DD` (no daemonize, dump core), `-E` (stderr logging), `-M 512` (512MB shared memory), `-m 16` (16MB pkg memory)

## 3. Entrypoint Templating System

**File**: `entrypoint.sh`

Kamailio's `#!substdef` and `modparam` do not support environment variables. The entrypoint solves this by performing sed-based placeholder replacement at container startup, before Kamailio starts.

**Required environment variables** (container fails to start without these):
| Placeholder | Env Var | Purpose |
|---|---|---|
| `__ADVERTISE_IP__` | `EXTERNAL_SIP_IP` | Public IP for SIP headers (listen advertise, Contact, From domain, SDP rewriting) |
| `__FS_IP__` | `FREESWITCH_IP` | FreeSWITCH IP for dispatcher and direct routing |

**Optional environment variables** (have defaults):
| Placeholder | Env Var | Default | Purpose |
|---|---|---|---|
| `__DB_HOST__` | `DB_HOST` | 127.0.0.1 | PostgreSQL host for trunk auth |
| `__DB_PORT__` | `DB_PORT` | 5432 (compose override: 6432 via PgBouncer) | PostgreSQL port |
| `__DB_USER__` | `DB_USER` | freeswitch | Database user |
| `__DB_PASS__` | `DB_PASS` | fs_secret | Database password |
| `__HOMER_IP__` | `HOMER_IP` | 127.0.0.1 | Homer SIP capture server |

**Flow**: `cp .tmpl -> .cfg` then `sed -i` replaces all `__PLACEHOLDER__` strings, then `exec /usr/sbin/kamailio "$@"` starts Kamailio with the CMD args.

## 4. Routing Logic Walkthrough

### 4.1 request_route (Main Entry Point)

Every SIP request enters here. Processing order:

1. **Logging + HEP trace**: Log method/from/to, set flag 22, call `sip_trace()`.
2. **Max-Forwards check**: Reject with 483 if exceeded.
3. **Trust classification (flag 5)**:
   - Bandwidth IPs (67.231.0.0/16, 216.82.224.0/19) -> trusted
   - Internal networks (172.28.0.0/16, 127.0.0.0/8, 10.142.0.0/20) -> trusted
   - Everything else -> untrusted
4. **IP blocklist check**: Untrusted sources checked against `blocked` htable. Blocked IPs are silently dropped (no response).
5. **Sanity check**: Malformed SIP from untrusted sources increments `ipreputation`; >10 violations = blocked.
6. **Rate limiting (untrusted only)**: Pike module, 50 req/sec/IP. Exceeded = blocked + 503.
7. **Scanner detection (untrusted only)**: route[SCANNER_DETECT] tracks INVITE floods (>30/min = block).
8. **CANCEL**: Forwarded via `t_check_trans()` + RELAY.
9. **Retransmission**: `t_precheck_trans()` + `t_check_trans()` absorb retransmits.
10. **In-dialog (has to-tag)**: Routed via route[WITHINDIALOG].
11. **Record-Route**: Added for INVITE/SUBSCRIBE from non-FreeSWITCH sources. Skipped for FS traffic because `msg_apply_changes()` in TO_CARRIER fails if record_route() was already called.
12. **REGISTER**: Rejected with 403 (Bandwidth uses IP auth, no registration).
13. **OPTIONS**: Responds 200 OK. Tracks floods from untrusted sources.
14. **INVITE routing** (source-based decision tree):
    - **From Bandwidth** -> Dedup check (htable `bw_dedup`, 3s TTL) -> NAT detect -> Dispatch to FreeSWITCH port 5080
    - **From FreeSWITCH** (UA matches "VoicePlatform" or "FreeSWITCH"):
      - If `X-PBX-Dest` header present -> **Trunk inbound delivery**: Route to customer PBX IP, fix headers/SDP, record_route, relay
      - Otherwise -> **Outbound call**: route[TO_CARRIER]
    - **From internal but not FS** (e.g., SIPp) -> Treat as test inbound, dispatch to FS
    - **Unknown source** -> route[TRUNK_AUTH] for IP-based trunk authentication. If auth fails, 403.

### 4.2 route[WITHINDIALOG]

Handles BYE, re-INVITE, ACK, UPDATE, etc. for established calls.

**When `loose_route()` fails** (no Route headers):

- **ACK for 2xx** (normal case per RFC 3261 Section 17.1.1.3 - ACK for 2xx is a separate transaction):
  - From FS -> Topology-hide Contact, forward to carrier. R-URI already points to Bandwidth's Contact address.
  - From Bandwidth -> Forward to FS using `$dlg_var(fs_port)` to select correct FS profile (5080 for inbound calls, 5090 for outbound calls). Rewrites R-URI to strip Record-Route params.
- **BYE/CANCEL/UPDATE/etc without Route**:
  - Same source-based logic as ACK. From FS -> carrier, from Bandwidth -> FS.
  - Uses `$dlg_var(fs_port)` for correct FS profile targeting.

**When `loose_route()` succeeds** (Route headers present):

1. Re-INVITEs from external sources get NAT detection. Re-INVITEs from FS do NOT (would corrupt Contact).
2. All in-dialog requests from FS get topology hiding: Contact replaced with Kamailio's address, SDP scrubbed.
3. **Self-loop detection**: If R-URI points to Kamailio after loose_route(), redirect to the correct destination (FS or Bandwidth) based on source.
4. Forward via route[RELAY].

**Critical design: `$dlg_var(fs_port)`**

Dialog variable set during initial INVITE routing:
- `5080` = FS internal profile (inbound calls from Bandwidth, trunk auth calls)
- `5090` = FS external profile (outbound calls from FS to Bandwidth)

This is read by WITHINDIALOG to route in-dialog requests to the correct FS SIP profile.

### 4.3 route[TO_CARRIER] (Outbound: FS -> Bandwidth)

9-step process for outbound call setup:

1. **Carrier selection**: Read `X-Carrier` header from FreeSWITCH:
   - `primary` -> 67.231.2.12 (Dallas)
   - `secondary` -> 216.82.238.134 (Los Angeles)
   - Default (no header) -> Dallas (primary)
   - Remove `X-Carrier` before sending to carrier.

2. **From/To domain rewrite**: `$fd` = public IP, `$td` = carrier IP.

3. **Header cleanup**: Remove ALL FS-specific headers:
   - P-Asserted-Identity, User-Agent, X-FS-Support, Content-Disposition, Privacy, Supported, Allow-Events, Allow, Contact, Remote-Party-ID, Session-Expires, Min-SE
   - Add clean Contact with Kamailio's address BEFORE `msg_apply_changes()`.

4. **`msg_apply_changes()` + `record_route()`**: Rebuild message buffer, then add Record-Route. Order is critical -- record_route() before msg_apply_changes() breaks header cleanup.

5. **Via handling**: Intentionally NO Via manipulation. FS's Via is preserved. Removing it causes SIP corruption (orphaned `;received=`/`;rport=` params merge with next header). Two Vias is valid per RFC 3261.

6. **P-Asserted-Identity**: Built from `X-Original-CID` header (RCF caller ID passthrough) or falls back to From user.

7. **Clean outbound headers added**:
   - P-Asserted-Identity, User-Agent: VoicePlatform-SBC/1.0, Allow, Supported: timer,replaces
   - Session-Expires: 1800;refresher=uac, Min-SE: 90 (RFC 4028)

8. **SDP scrubbing**: Replace 172.28.x.x, 10.x.x.x, 127.x.x.x with public IP.

9. **Relay with callbacks**: `t_on_branch(TO_CARRIER_BRANCH)`, `t_on_failure(CARRIER_FAILURE)`, `t_on_reply(REPLY_HANDLER)`.

### 4.4 route[RELAY]

Generic relay for non-carrier traffic (inbound Bandwidth->FS path, in-dialog requests). Sets `t_on_branch(BRANCH_FAILURE)` and `t_on_reply(REPLY_HANDLER)` for INVITEs.

### 4.5 route[DISPATCH]

Selects a FreeSWITCH instance from dispatcher group 1 using round-robin (algorithm 4). Sets `t_on_failure(DISPATCH_FAILURE)` for failover to next FS instance.

### 4.6 route[TRUNK_AUTH]

IP-based SIP trunk authentication for customer PBXs:

1. SQL query joins `trunk_auth_ips` -> `sip_trunks` -> `customers` to find trunk by source IP.
2. Verifies trunk is enabled.
3. Enforces per-trunk CPS rate limiting via `trunk_cps` htable.
4. Appends `X-Trunk-ID`, `X-Customer-ID`, `X-Max-Channels` headers for FreeSWITCH.
5. Dispatches to FreeSWITCH on port 5080 (same path as carrier inbound).
6. If no trunk matches, returns (does not exit), and caller sends 403.

### 4.7 route[NAT_DETECT]

Called ONLY for inbound traffic from Bandwidth and re-INVITEs from external sources. NEVER called for FS-originated traffic (would corrupt Contact).

- `force_rport()`: Use actual source port instead of Via sent-by.
- `nat_uac_test("19")`: Check for private IPs in Contact/Via.
- `fix_nated_contact()`: Rewrite Contact to use source IP.

### 4.8 Failure Routes

**CARRIER_FAILURE**: Handles outbound carrier failures.
- 422 (Session Interval Too Small): Retry with Session-Expires: 3600, Min-SE: 900.
- 500/503/408/480/404: Failover to alternate Bandwidth IP. Flag 8 prevents infinite failover loop (at most one retry).

**DISPATCH_FAILURE**: Handles FS failures.
- 500/503/408: Try next FS via `ds_next_dst()`, mark failed destination as probing.

**TRUNK_DELIVERY_FAILURE**: Handles customer PBX delivery failures. Returns 503.

### 4.9 reply_route and onreply_route[REPLY_HANDLER]

**reply_route** (global): Traces all replies to Homer. Does NOT call `fix_nated_contact()` (FS already uses correct public IPs). Drops late 100 Trying.

**REPLY_HANDLER** (per-transaction): Fires for 1xx and 2xx replies.
- SDP scrubbing on all replies (replace private IPs with public).
- Contact rewriting on FS-originated replies: Replace FS Contact with Kamailio's address.
- **Session timer normalization on carrier replies**: Replace carrier's Session-Expires with 1800. Bandwidth sometimes sends Session-Expires: 30 (below RFC minimum of 90), which FS silently ignores, causing call disconnection. Normalizing to 1800 ensures FS always sets up the refresh timer.

### 4.10 route[SCANNER_DETECT]

Tracks INVITE floods per source IP. >30 INVITEs/minute from untrusted source = blocked. Only applies to untrusted sources.

## 5. Dispatcher Configuration

**File**: `dispatcher.list`

Three dispatcher groups:

| Group | Destination | Purpose |
|---|---|---|
| 1 | sip:__FS_IP__:5080 | FreeSWITCH load balancing (used by `ds_select_dst`) |
| 2 | sip:67.231.2.12:5060 | Bandwidth Dallas keepalive/health monitoring ONLY |
| 3 | sip:216.82.238.134:5060 | Bandwidth LA keepalive/health monitoring ONLY |

Groups 2 and 3 are NOT used for call routing. They exist solely for:
- **NAT keepalive**: OPTIONS every 5s keeps GCE's UDP NAT pinhole open.
- **Health monitoring**: Detects carrier unreachability.

Dispatcher parameters:
- `ds_ping_interval=5`: Probe every 5 seconds (all groups).
- `ds_probing_mode=1`: Probe all destinations continuously, not just inactive.
- `ds_probing_threshold=3`: 3 failures = mark inactive.
- `ds_inactive_threshold=3`: 3 successes = mark active.
- `ds_ping_reply_codes`: Accepts 2xx, 404, 405, 480 as alive.
- Algorithm: Round-robin (4) for FS group. Weight (100) and maxload (2000) attrs configured but not currently used (would need algorithm 9 or 10).

To add a FreeSWITCH instance for horizontal scaling:
```
1 sip:freeswitch-2:5080 0 0 weight=100;maxload=2000;duid=fs-secondary
```

Runtime commands:
- `kamcmd dispatcher.reload` - Reload dispatcher list without restart
- `kamcmd dispatcher.list` - View current dispatcher status

## 6. Key Environment Variables

Set in `.env` file on each SBC VM. Passed via `docker-compose.sbc.yml`.

| Variable | Required | Example | Purpose |
|---|---|---|---|
| `EXTERNAL_SIP_IP` | Yes | 34.74.71.32 | Public IP of this SBC VM. Used in listen advertise, Contact headers, SDP rewriting, From domain. |
| `FREESWITCH_IP` | Yes | 10.142.0.100 | FreeSWITCH's IP (GCE internal VPC IP, not 127.0.0.1, because FS binds to `local_ip_v4`). |
| `DB_HOST` | No | 127.0.0.1 | PostgreSQL host for trunk auth. Default: 127.0.0.1. |
| `DB_PORT` | No | 6432 | PostgreSQL port (compose default 6432 = PgBouncer). |
| `DB_USER` | No | freeswitch | Database user. |
| `DB_PASS` | No | fs_secret | Database password. |
| `HOMER_IP` | No | 127.0.0.1 | Homer SIP capture server. |

## 7. SIP Call Flows

### 7.1 Inbound: Bandwidth -> Kamailio -> FreeSWITCH

```
Bandwidth (67.231.2.12)
  |
  | INVITE sip:+18005551234@34.74.71.32:5060
  v
Kamailio (34.74.71.32:5060)
  - Flag 5 set (trusted: Bandwidth IP)
  - Skip rate limiting
  - Bandwidth dedup check (bw_dedup htable, 3s TTL)
  - NAT detect (force_rport, fix_nated_contact)
  - dlg_manage(), $dlg_var(fs_port) = "5080"
  - record_route() (Kamailio stays in signaling path)
  - ds_select_dst("1", "4") -> picks FreeSWITCH from group 1
  |
  | INVITE sip:+18005551234@10.142.0.100:5080
  v
FreeSWITCH (10.142.0.100:5080) - internal profile
  - Processes call (RCF, IVR, etc.)
  - 200 OK flows back through Kamailio
  - REPLY_HANDLER scrubs SDP, rewrites FS Contact to Kamailio address
  - In-dialog BYE/re-INVITE routed via WITHINDIALOG to FS port 5080
```

### 7.2 Outbound: FreeSWITCH -> Kamailio -> Bandwidth

```
FreeSWITCH (10.142.0.100:5090) - external profile
  |
  | INVITE sip:+15551234567@34.74.71.32:5060
  | Headers: X-Carrier: primary, X-Original-CID: +18005559999
  | UA: VoicePlatform/1.0
  v
Kamailio (34.74.71.32:5060)
  - Flag 5 set (trusted: GCE internal network)
  - UA matches "VoicePlatform" -> outbound path
  - NO record_route() yet (deferred for msg_apply_changes)
  - route[TO_CARRIER]:
    1. X-Carrier=primary -> carrier_ip=67.231.2.12
    2. $fd=34.74.71.32, $td=67.231.2.12
    3. Strip all FS headers, add clean Contact
    4. msg_apply_changes(), then record_route()
    5. (Via untouched - two Vias is valid)
    6. PAI from X-Original-CID
    7. Add Supported: timer, Session-Expires: 1800
    8. SDP scrub
    9. t_relay() with CARRIER_FAILURE failover
  |
  | INVITE sip:+15551234567@67.231.2.12:5060
  | Clean headers, Kamailio identity
  v
Bandwidth (67.231.2.12:5060)
  - 200 OK flows back through Kamailio
  - REPLY_HANDLER normalizes Session-Expires to 1800
  - REPLY_HANDLER rewrites FS Contact to Kamailio address
  - In-dialog BYE/re-INVITE routed via WITHINDIALOG to FS port 5090
```

### 7.3 SIP Trunk: Customer PBX -> Kamailio -> FreeSWITCH

```
Customer PBX (203.0.113.50)
  |
  | INVITE sip:+15551234567@34.74.71.32:5060
  v
Kamailio (34.74.71.32:5060)
  - Source not Bandwidth, not internal -> untrusted
  - Rate limiting + sanity checks
  - route[TRUNK_AUTH]:
    1. SQL: SELECT from trunk_auth_ips WHERE ip_address='203.0.113.50'
    2. Verify trunk enabled
    3. CPS rate limit check
    4. Append: X-Trunk-ID, X-Customer-ID, X-Max-Channels
    5. $dlg_var(fs_port) = "5080"
    6. route[DISPATCH] -> FreeSWITCH
  |
  | INVITE sip:+15551234567@10.142.0.100:5080
  | X-Trunk-ID: uuid, X-Customer-ID: uuid
  v
FreeSWITCH (10.142.0.100:5080) - internal profile
  - Detects X-Trunk-ID, runs trunk_outbound.lua
```

### 7.4 Trunk Inbound Delivery: FreeSWITCH -> Kamailio -> Customer PBX

```
FreeSWITCH (10.142.0.100:5090)
  |
  | INVITE with X-PBX-Dest: 203.0.113.50
  v
Kamailio (34.74.71.32:5060)
  - From FS, has X-PBX-Dest header
  - Set $du/$rd to PBX IP:5060
  - Fix To/From/PAI: replace 127.0.0.1/10.142.x.x with public IP
  - Fix SDP: replace internal IPs
  - Remove X-PBX-Dest, X-FS-Support
  - record_route() for PBX leg
  - t_relay() with TRUNK_DELIVERY_FAILURE
  |
  | INVITE sip:+15551234567@203.0.113.50:5060
  v
Customer PBX (203.0.113.50)
```

## 8. Critical Gotchas

### 8.1 subst() Cannot Fix Via Corruption

`subst()` cannot remove `;received=` and `;rport=` params from Via headers. These are added by the tm module's transaction state and re-applied AFTER the routing script runs. Attempting to strip FS's Via with `remove_hf("Via")` + `msg_apply_changes()` leaves orphaned annotation text that merges with the next header, producing corrupted SIP like:
```
;received=10.142.0.100;rport=5090Max-Forwards: 69
```
**Solution**: Leave FS's Via in place. Two Vias is valid per RFC 3261.

### 8.2 record_route() vs msg_apply_changes() Order

`record_route()` must be called AFTER `msg_apply_changes()` in TO_CARRIER. The reverse order causes `msg_apply_changes()` to fail silently with "cannot apply msg changes after adding record-route header", which means ALL header cleanup (`remove_hf()`, `append_hf()`) is silently ignored.

For FS-originated traffic, the initial `record_route()` in request_route is intentionally skipped (the `if (!(isflagset(5) && UA matches FS))` guard). TO_CARRIER adds its own `record_route()` at the correct point.

### 8.3 NAT Detection Must NOT Apply to FreeSWITCH Traffic

`route(NAT_DETECT)` calls `force_rport()` and `fix_nated_contact()`, which:
1. `force_rport()` adds `;received=172.28.0.10;rport=5090` to FS's Via, leaking Docker IPs.
2. `fix_nated_contact()` overwrites FS's clean Contact (which already has the public IP via ext-sip-ip) with the Docker source IP.

NAT_DETECT is ONLY called for inbound from Bandwidth and re-INVITEs from external sources.

### 8.4 Contact Header in TO_CARRIER Must Be Added Before msg_apply_changes()

The dialog module reads the Contact header during `record_route()` to create leg info. If Contact is absent (because `remove_hf("Contact")` removed the old one and the new one hasn't been added yet), you get "bad sip message or missing Contact hdr" -> no dialog created -> ACK routing breaks -> BYE returns 404.

The fix: `remove_hf("Contact")` then immediately `append_hf(new Contact)`, then `msg_apply_changes()`, then `record_route()`.

### 8.5 Bandwidth Sends Duplicate INVITEs

Bandwidth sends the same inbound call from multiple edge proxies simultaneously (different source IPs, different Call-IDs, same From/To). Without dedup, the platform creates duplicate call legs. The `bw_dedup` htable (key=FromUser::ToUser, TTL=3s) suppresses duplicates with 482 Merged.

### 8.6 Session Timer Normalization is Required

Bandwidth sometimes sends `Session-Expires: 30` in 200 OK (below RFC minimum of 90). FreeSWITCH has `minimum-session-expires=90` and silently ignores any value below that, never setting up the refresh timer. The carrier then kills the call when its 30-second timer expires. REPLY_HANDLER normalizes all carrier Session-Expires to 1800.

### 8.7 GCE Hairpin NAT Solved at OS Level

FreeSWITCH on the same VM cannot send to Kamailio's public IP via GCE's network fabric (hairpin NAT). The solution is adding the public IP to the loopback interface on the host:
```
ip addr add 34.74.71.32/32 dev lo
```
This means single `record_route()` (no double RR needed) and FS can reach Kamailio's advertised address locally.

### 8.8 Topology Hiding is Manual, Not via topoh Module

The `topoh.so` module is explicitly disabled. It conflicts with the manual header cleanup in TO_CARRIER by adding TH= markers that must then be removed. All topology hiding is done via explicit `remove_hf()` + `append_hf()` + SDP `subst_body()`.

### 8.9 Dialog Variable for FS Port Selection

`$dlg_var(fs_port)` is set during initial INVITE routing and read during in-dialog routing. If this variable is missing (e.g., dialog not created), WITHINDIALOG defaults to port 5090 (external profile). Getting this wrong routes BYE to the wrong FS profile, causing the call to not hang up properly.

## 9. How to Modify

### Adding a New Carrier IP

1. Add a `#!define` in the Global Parameters section:
   ```
   #!define NEW_CARRIER_IP "1.2.3.4"
   ```
2. Add to trust classification in request_route (flag 5 block).
3. Add dispatcher group in `dispatcher.list` for keepalive:
   ```
   4 sip:1.2.3.4:5060 0 0 weight=100;duid=new-carrier
   ```
4. Add routing case in TO_CARRIER's X-Carrier switch.
5. Add failover case in CARRIER_FAILURE.
6. Run `kamcmd dispatcher.reload` after deploy.

### Adding a New Route

1. Define the route block:
   ```
   route[MY_ROUTE] {
       # routing logic
   }
   ```
2. Call it from the appropriate place in request_route's INVITE decision tree or from WITHINDIALOG.
3. If it handles initial INVITEs, decide whether it needs `dlg_manage()` + `$dlg_var(fs_port)` and `record_route()`.
4. If it sends to an external destination, ensure topology hiding (Contact, SDP, internal headers).

### Changing Rate Limits

Modify the `#!define` values at the top of the config:
- `PIKE_THRESHOLD` (default 50): Max requests/second/IP before blocking.
- `PIKE_TIMEOUT` (default 300): Block duration in seconds.
- `HTABLE_AUTOEXPIRE` (default 300): Blocklist entry lifetime.
- `SCANNER_THRESHOLD` (default 5): Max failed auth attempts.
- `OPTIONS_FLOOD_THRESHOLD` (default 20): Max OPTIONS/second before blocking.
- INVITE flood threshold is hardcoded at 30/minute in route[SCANNER_DETECT].

### Adding a FreeSWITCH Instance

Add to `dispatcher.list`:
```
1 sip:NEW_FS_IP:5080 0 0 weight=100;maxload=2000;duid=fs-secondary
```
Reload: `kamcmd dispatcher.reload`. Dispatcher will automatically load-balance and health-check. Consider switching from round-robin (algorithm 4) to weight-based (9) or call-load (10) for uneven capacity.

### Docker Compose Configuration

**File**: `docker-compose.sbc.yml`

- `network_mode: host` - Kamailio binds directly to VM interfaces (no Docker bridge NAT).
- Config files mounted as read-only volumes (entrypoint copies them before templating).
- Resource limits: 4 CPU / 2GB memory (reservation: 2 CPU / 512MB).
- File descriptor limit: 65536 (required for high connection counts).
- Restart policy: `unless-stopped`.

### Tuning for Scale

Current config targets 500+ CPS:
- `children=16` (SIP worker processes)
- `tcp_children=8` (TCP worker processes)
- `tcp_max_connections=4096`
- Shared memory: 512MB (-M 512)
- Package memory: 16MB per process (-m 16)
- Timer tuning: `fr_timer=30000` (30s non-INVITE), `fr_inv_timer=120000` (120s INVITE)
- Dialog: 12-hour max call, no DB persistence (stateless SBC)

For higher scale, increase `children`, shared memory, and file descriptor limits.
