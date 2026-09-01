# Kamailio SBC - Implementation Reference

## 1. Component Role

Kamailio acts as the Session Border Controller (SBC) for the RCF-V1 voice platform. It is the single entry/exit point for all SIP signaling between the public internet and FreeSWITCH. It performs:

- **Topology hiding**: Strips internal IPs (Docker, GCE VPC, loopback) from all outbound SIP headers and SDP bodies, presenting only the public IP to Bandwidth (the carrier).
- **Rate limiting and attack prevention**: Pike module + htable-based IP blocking, scanner detection, OPTIONS flood protection. Trusted sources (Bandwidth, FreeSWITCH) bypass all rate limiting.
- **Load balancing**: Dispatcher module distributes inbound calls across FreeSWITCH instances (currently one, horizontally scalable).
- **NAT keepalive**: Dispatcher sends OPTIONS probes every 5 seconds to Bandwidth IPs, keeping the GCE UDP NAT pinhole open (GCE has a 30-second UDP idle timeout).
- **SIP trunk IP authentication**: Queries PostgreSQL to authenticate customer PBX source IPs against the `trunk_auth_ips` table, with per-trunk CPS rate limiting.
- **Session timer management**: Adds RFC 4028 headers (Session-Expires, Min-SE) on outbound INVITEs and normalizes carrier replies so FreeSWITCH always sees a value it will honor.
- **HEP capture**: Sends all SIP messages to Homer via HEP3 for troubleshooting (capture ID from `HEP_CAPTURE_ID`, default 100). Exactly-once model: `sip_trace()` in request_route (received request) + `setflag(22)` transaction tracing (forwarded branches, received replies, relayed/local replies via tm callbacks; sl replies via SL callback). reply_route traces ONLY transaction-less (statelessly forwarded) replies — an unconditional `sip_trace()` there duplicates every received reply.
- **Carrier failover**: Multi-IP, multi-trunk failover (500/503/408/480/404). Each Bandwidth trunk config (TC1/TC2/TC4) has two IPs; on failure Kamailio fails over within the trunk (flag 8, one retry), then cross-trunk to TC4 Dallas as a last resort (flag 9 guards against loops). See route[CARRIER_FAILURE].

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
| `__ADVERTISE_IP__` | `EXTERNAL_SIP_IP` | Public IP / NLB VIP advertised in SIP headers (listen advertise, Contact, From domain, outer Record-Route). NOT used for SDP — see FS_PUBLIC_IP. |
| `__FS_IP__` | `FREESWITCH_IP` | FreeSWITCH IP for dispatcher and direct routing |

**Optional environment variables** (have defaults):
| Placeholder | Env Var | Default | Purpose |
|---|---|---|---|
| `__SBC_INTERNAL_IP__` | `SBC_INTERNAL_IP` | 127.0.0.1 | This SBC's own VPC IP. Used for: (a) the FS-facing `listen` socket, (b) `alias=` so loose_route() recognizes the inner RR as local, (c) the **inner Record-Route** (bypasses the NLB so in-dialog ACK/BYE reach THIS specific SBC). |
| `__FS_PUBLIC_IP__` | `FS_PUBLIC_IP` | `$EXTERNAL_SIP_IP` | FreeSWITCH VM's OWN public IP, used in SDP body rewrites. Different from ADVERTISE_IP because RTP goes directly to/from FS, NOT through the NLB (which only forwards SIP on 5060). Falls back to EXTERNAL_SIP_IP when no NLB is used. |
| `__HEP_CAPTURE_ID__` | `HEP_CAPTURE_ID` | 100 | HEP capture ID for siptrace (Homer ladder identification). |
| `__SBC_ID__` | `SBC_ID` | east-sbc-1 | Per-SBC identifier, appended as the `X-SBC-ID` header so Homer/logs show which SBC handled the leg. |
| `__DB_HOST__` | `DB_HOST` | 127.0.0.1 | PostgreSQL host for trunk auth |
| `__DB_PORT__` | `DB_PORT` | 5432 (compose override: 6432 via PgBouncer) | PostgreSQL port |
| `__DB_USER__` | `DB_USER` | freeswitch | Database user |
| `__DB_PASS__` | `DB_PASS` | fs_secret | Database password |
| `__HOMER_IP__` | `HOMER_IP` | 127.0.0.1 | Homer SIP capture server |
| `__BANDWIDTH_PRIMARY_IP__` | `BANDWIDTH_PRIMARY_IP` | 67.231.2.12 | This zone's NEAREST Bandwidth PoP (BANDWIDTH_IP_1, `X-Carrier=primary`). East=Dallas, West=LA. |
| `__BANDWIDTH_SECONDARY_IP__` | `BANDWIDTH_SECONDARY_IP` | 216.82.238.134 | This zone's SECONDARY Bandwidth PoP (BANDWIDTH_IP_2, `X-Carrier=secondary`). East=LA, West=Dallas. |
| `__INTERNAL_SUBNET__` | `INTERNAL_SUBNET` | 10.142.0.0/20 | This zone's trusted VPC subnet (GCE_INTERNAL_NETWORK). East=10.142.0.0/20, West=10.138.0.0/20. |
| `__MEDIA_SUBNET__` | `MEDIA_SUBNET` | 192.168.10.0/24 | This zone's trusted FreeSWITCH media subnet (VOIP_SUBNET). East=192.168.10.0/24, West=192.168.20.0/24. |
| `__TESTING_IP__` | `TESTING_IP` | 255.255.255.255 (= disabled) | Trusted SIPp test source. Default can never match a real unicast source — leave unset in production. |
| `__BW_CPS_LIMIT__` | `BW_CPS_LIMIT` | 100 | Per-Bandwidth-IP inbound CPS flood backstop (`bw_cps` htable). |
| `__BANDWIDTH_TC1_NY__` | `BANDWIDTH_TC1_NY` | 67.231.9.142 | TC1 New York PoP. Templated into kamailio.cfg AND dispatcher.list (group 4). |
| `__BANDWIDTH_TC1_ATL__` | `BANDWIDTH_TC1_ATL` | 67.231.13.185 | TC1 Atlanta PoP. Templated into kamailio.cfg AND dispatcher.list (group 4). |
| `__BANDWIDTH_TC2_DAL__` | `BANDWIDTH_TC2_DAL` | 67.231.1.188 | TC2 Dallas PoP. Templated into kamailio.cfg AND dispatcher.list (group 5). |
| `__BANDWIDTH_TC2_LA__` | `BANDWIDTH_TC2_LA` | 67.231.4.138 | TC2 Los Angeles PoP. Templated into kamailio.cfg AND dispatcher.list (group 5). |

**Dual listen sockets:** the entrypoint templates a carrier-facing listen on
`ADVERTISE_IP:5060` (NLB VIP, advertised as itself) AND an FS-facing listen on
`SBC_INTERNAL_IP:5060` (this SBC's VPC IP, advertised as ADVERTISE_IP). Both UDP
and TCP. A loopback listen on 127.0.0.1:5060 is added for `kamcmd`/health checks.

**Flow**: `cp .tmpl -> .cfg` then `sed -i` replaces all `__PLACEHOLDER__` strings,
then the NLB VIP is added to loopback (see below), then `exec /usr/sbin/kamailio "$@"`
starts Kamailio with the CMD args.

**NLB VIP on loopback (self-healing, GCP passthrough-NLB requirement):** After
templating, the entrypoint adds `EXTERNAL_SIP_IP` (the NLB VIP / `ADVERTISE_IP`) to
the host loopback via `ip addr add EXTERNAL_SIP_IP/32 dev lo`. This is required
because GCP external passthrough Network Load Balancers deliver packets with the
destination still set to the VIP — the VM kernel only accepts them (and Kamailio
can only bind `listen=udp:ADVERTISE_IP:5060`) if the VIP is a local address.

- **Replaces the old manual step.** This used to be done by hand on each SBC VM and
  was NOT persisted (not in git, not in any systemd unit, not in instance metadata),
  so East SBCs lost the VIP on reboot and freshly-cloned West SBCs never had it.
  Doing it in the entrypoint makes the VIP **survive reboot and re-clone** with no
  manual step.
- **Idempotent.** The block skips the add if the VIP is already on an interface
  (`ip addr show | grep -q`). With host networking the loopback state persists
  across container restarts, so a restart logs `NLB VIP <ip> already on interface`.
- **Requires `NET_ADMIN`** (added to the `kamailio` service in
  `docker-compose.sbc.yml`) **and a root entrypoint.** The Dockerfile now sets
  `USER root` so the entrypoint can run `ip addr`; Kamailio then drops privileges
  to the kamailio user/group via the `-u kamailio -g kamailio` CMD flags, so the
  SIP worker processes remain unprivileged (same runtime user as before). This
  mirrors how `docker/freeswitch/entrypoint.sh` handles its hairpin-NAT loopback add.
- **Verify after pull+restart:** `docker logs voip-kamailio` shows
  `Adding <VIP>/32 to loopback` (first run / fresh clone) or
  `NLB VIP <VIP> already on interface` (restart), and `ip -br addr show lo` lists
  the VIP. See also Gotcha 8.7 (GCE hairpin NAT uses the same loopback VIP).

## 4. Routing Logic Walkthrough

### 4.1 request_route (Main Entry Point)

Every SIP request enters here. Processing order:

1. **Logging + HEP trace**: Log method/from/to, set flag 22, call `sip_trace()`.
2. **Max-Forwards check**: Reject with 483 if exceeded.
3. **Trust classification (flag 5)** — the STATIC carrier trust list:
   - Bandwidth IPs (67.231.0.0/16, 216.82.224.0/19) -> trusted
   - Sinch origination IPs (`SINCH_DENVER_IP` 206.146.100.24, `SINCH_CHICAGO_IP`
     206.146.101.39 — env-templated defines, origination only) -> trusted
   - Internal networks: Docker `172.28.0.0/16`, loopback `127.0.0.0/8`,
     `GCE_INTERNAL_NETWORK` `10.142.0.0/20`, and `VOIP_SUBNET` `192.168.10.0/24`
     (the FS media subnet) -> trusted
   - Everything else -> untrusted. (Runtime-added carriers are NOT here —
     they are DB-authenticated per-INVITE later, in route[CARRIER_TRUST];
     see 4.6.1 for the static-vs-DB trust model.)
   - **Per-zone (env-driven):** `GCE_INTERNAL_NETWORK` and `VOIP_SUBNET` are now
     templated from `INTERNAL_SUBNET` (default 10.142.0.0/20) and `MEDIA_SUBNET`
     (default 192.168.10.0/24). A new zone sets these in its `.env`
     (West: `INTERNAL_SUBNET=10.138.0.0/20`, `MEDIA_SUBNET=192.168.20.0/24`).
     They flow into every `is_in_subnet` internal-source check throughout the
     routing script. Per-zone self-containment: each SBC trusts ONLY its OWN
     VPC + media subnet — no SBC needs to trust another zone's internal sources
     (the services VM is within the zone's own INTERNAL_SUBNET).
4. **IP blocklist check**: Untrusted sources checked against `blocked` htable. Blocked IPs are silently dropped (no response).
5. **Sanity check**: Malformed SIP from untrusted sources increments `ipreputation`; >10 violations = blocked.
6. **Rate limiting (untrusted only)**: Pike module, 50 req/sec/IP. Exceeded = blocked + 503.
7. **Scanner detection (untrusted only)**: route[SCANNER_DETECT] tracks INVITE floods (>30/min = block).
8. **CANCEL**: Forwarded via `t_check_trans()` + RELAY.
9. **Retransmission**: `t_precheck_trans()` + `t_check_trans()` absorb retransmits.
10. **In-dialog (has to-tag)**: Routed via route[WITHINDIALOG].
11. **Record-Route (DOUBLE)**: `enable_double_rr=1` is set, and both legs use
    `record_route_preset()` with TWO URIs (outer = NLB VIP / ADVERTISE_IP, inner =
    SBC_INTERNAL_IP). For the A-leg (Bandwidth->FS) this is added in request_route
    with REVERSED argument order so the outer/inner roles end up correct for the
    direction. Skipped for plain FS->carrier traffic here because TO_CARRIER adds
    its own `record_route_preset()` AFTER `msg_apply_changes()`. See section 8.7.
12. **REGISTER**: Rejected with 403 (Bandwidth uses IP auth, no registration).
13. **OPTIONS**: Responds 200 OK. Tracks floods from untrusted sources.
14. **INVITE routing** (source-based decision tree):
    - **From a static carrier (Bandwidth or Sinch)** -> shared carrier-ingress branch:
      dedup check (htable `bw_dedup`, 3s TTL, source-independent From::To key) ->
      per-source-IP CPS backstop (`bw_cps`, BW_CPS_LIMIT) -> STIR capture ->
      X-Inbound-TC (Sinch gets tc4: egress stays Bandwidth) -> spoof-proofed
      `X-Inbound-Carrier`/`X-Inbound-PoP` attribution (strip wire copies, then
      stamp from the matched IP) -> NAT detect -> Dispatch to FreeSWITCH port 5080
    - **From FreeSWITCH** (UA matches "VoicePlatform" or "FreeSWITCH"):
      - If `X-PBX-Dest` header present -> **Trunk inbound delivery**: Route to customer PBX IP, fix headers/SDP, record_route, relay
      - Otherwise -> **Outbound call**: route[TO_CARRIER]
    - **From internal but not FS** (e.g., SIPp) -> Treat as test inbound, dispatch to FS
    - **Unknown source** -> route[TRUNK_AUTH] (customer trunk IP auth), then
      route[CARRIER_TRUST] (DB-backed carrier trust, 4.6.1). If both fall through, 403.

### 4.2 route[WITHINDIALOG]

Handles BYE, re-INVITE, ACK, UPDATE, etc. for established calls. (CANCEL never gets here — it is handled at the top of request_route via `t_check_trans()`.)

**FIRST — network-side dispatch, BEFORE `loose_route()`** (§8.10): if the source is external (`!IS_INTERNAL_SOURCE`, not SIPp) and the R-URI is one of OUR OWN addresses (`is_myself($rd)` — always true for carrier/PBX in-dialog requests because topology hiding rewrote FS's Contact to the VIP), the request is handed to `route[FROM_NET_INDIALOG]` → `route[TO_FS_INDIALOG]` and NEVER runs `loose_route()`. Re-INVITEs get `NAT_DETECT` + `record_route()` first (mirrors the legacy in-dialog INVITE handling). `TO_FS_INDIALOG` resolves the FS profile port statelessly — `;fs=` marker in Route/R-URI → `$dlg_var(fs_port)` (owner fallback for pre-marker dialogs) → guess 5090 + one-shot 481 retry — builds a clean `sip:<user>@FS_IP:port` R-URI (preserving `$rU` = FS's own Contact user echoed back), strips all Route headers, and relays. Works identically on both SBCs with zero dialog state.

**When `loose_route()` fails** (no Route headers) — internal-plane and degenerate shapes only:

- **ACK for 2xx** (normal case per RFC 3261 Section 17.1.1.3 - ACK for 2xx is a separate transaction):
  - R-URI == self (mixed-state peer relay of a carrier ACK, see §8.10) -> `TO_FS_INDIALOG`.
  - From FS -> Topology-hide Contact, forward to carrier. R-URI already points to Bandwidth's Contact address.
  - From external (non-self R-URI) -> `TO_FS_INDIALOG`.
- **BYE/UPDATE/etc without Route**:
  - Same logic as ACK: R-URI==self -> FS; from FS -> carrier; from trusted external -> FS.

**When `loose_route()` succeeds** (Route headers present) — FS-originated, SIPp test path, and trunk-delivery legs only (network-side requests exited at the head arm):

1. FS-originated requests: `after_loose()` pops the inner Route, sees `;r2=on` on it, consumes the VIP Route too and forces the VIP send socket → one traversal to the carrier.
2. Re-INVITEs from external sources get NAT detection. Re-INVITEs from FS do NOT (would corrupt Contact).
3. All in-dialog requests from FS get topology hiding: Contact replaced with Kamailio's address, SDP scrubbed.
4. **Self-loop detection**: If R-URI points to Kamailio after loose_route(): from FS (media/docker/loopback subnets) -> carrier; from anything else (e.g. a mixed-state peer SBC relay) -> `TO_FS_INDIALOG`. Never key this on `IS_INTERNAL_SOURCE` alone — a peer SBC is "internal" too, and bouncing its relayed carrier BYE to Bandwidth was one of the §8.10 failure modes.
5. Forward via route[RELAY].

**FS profile port resolution (in `TO_FS_INDIALOG`)**

- `5080` = FS internal profile (inbound calls from Bandwidth, trunk auth calls) — A-leg dialogs, `;fs=5080` marker.
- `5090` = FS external profile (outbound calls from FS to Bandwidth) — B-leg dialogs, `;fs=5090` marker.
- `$dlg_var(fs_port)` (set at INVITE time) remains as the owner-side fallback for dialogs established before the `;fs=` marker deploy; `dlg_match_mode=1` lets it resolve without `loose_route()` having processed a `;did=`.

### 4.3 route[TO_CARRIER] (Outbound: FS -> Bandwidth)

9-step process for outbound call setup:

1. **Carrier selection**: Read `X-Carrier` header from FreeSWITCH and map it to one
   of the Bandwidth trunk-config IPs. There are **eight** hardcoded carrier IPs
   across three live trunk configs (TC3/E911 IPs are trust-only, not routed):
   - `primary` / `tc4` -> this zone's PRIMARY PoP (`BANDWIDTH_IP_1` = `BANDWIDTH_PRIMARY_IP`). East=Dallas `67.231.2.12`, West=LA `216.82.238.134`.
   - `secondary` -> this zone's SECONDARY PoP (`BANDWIDTH_IP_2` = `BANDWIDTH_SECONDARY_IP`). East=LA `216.82.238.134`, West=Dallas `67.231.2.12`.
   - `tc1` -> TC1 New York `67.231.9.142` (`BANDWIDTH_TC1_NY`)
   - `tc2` -> TC2 Dallas `67.231.1.188` (`BANDWIDTH_TC2_DAL`)
   - Default / unknown header -> this zone's primary PoP.
   - Remove `X-Carrier` before sending to carrier.
   - **Per-zone (env-driven):** `BANDWIDTH_IP_1`/`BANDWIDTH_IP_2` are now templated
     from `BANDWIDTH_PRIMARY_IP`/`BANDWIDTH_SECONDARY_IP` (default = East Dallas/LA).
     West swaps them so each zone egresses to its nearest PoP first. The fixed-PoP
     carrier IPs (TC1 NY/ATL, TC2 DAL/LA) are ALSO env-driven now —
     `BANDWIDTH_TC1_NY`/`BANDWIDTH_TC1_ATL`/`BANDWIDTH_TC2_DAL`/`BANDWIDTH_TC2_LA`,
     templated into both kamailio.cfg and dispatcher.list with the current
     production IPs as defaults. The full TC1/TC2 second IPs (ATL, LA) are
     used only in failover, below.

2. **From/To domain rewrite**: `$fd` = public IP, `$td` = carrier IP.

3. **Header cleanup**: Remove ALL FS-specific headers:
   - P-Asserted-Identity, User-Agent, X-FS-Support, Content-Disposition, Privacy, Supported, Allow-Events, Allow, Contact, Remote-Party-ID, Session-Expires, Min-SE
   - Add clean Contact with Kamailio's address BEFORE `msg_apply_changes()`.

4. **`msg_apply_changes()` + DOUBLE `record_route_preset()`**: Rebuild message
   buffer, then add the two Record-Route headers via
   `record_route_preset("ADVERTISE_IP:5060;fs=5090;lr", "SBC_INTERNAL_IP:5060;r2=on;fs=5090;lr")`
   (outer = NLB VIP, inner = this SBC's VPC IP). Order is critical -- record_route
   before msg_apply_changes breaks header cleanup. `;r2=on` on the inner entry
   makes FS-originated in-dialog requests consume both own Routes in one pass;
   `;fs=5090` is the stateless dispatch marker that lets ANY SBC deliver a
   carrier-originated in-dialog request to FS's external profile. See §8.7 + §8.10.

5. **Via handling**: Intentionally NO Via manipulation. FS's Via is preserved. Removing it causes SIP corruption (orphaned `;received=`/`;rport=` params merge with next header). Two Vias is valid per RFC 3261.

6. **P-Asserted-Identity**: Built from `X-Original-CID` header (RCF caller ID passthrough) or falls back to From user.

7. **Clean outbound headers added**:
   - P-Asserted-Identity, User-Agent: VoicePlatform-SBC/1.0, Allow, Supported: timer,replaces
   - Session-Expires: 1800;refresher=uac, Min-SE: 90 (RFC 4028)

8. **SDP scrubbing**: Replace 172.28.x.x, 10.x.x.x, 127.x.x.x in the SDP body with
   **FS_PUBLIC_IP** (the FS VM's own public IP, where RTP actually flows), NOT
   ADVERTISE_IP. The Contact/headers use ADVERTISE_IP (NLB VIP for SIP); only the
   SDP `c=`/media addressing uses FS_PUBLIC_IP because RTP bypasses the NLB.

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
6. If no trunk matches, returns (does not exit), and caller falls through to CARRIER_TRUST, then 403.

### 4.6.1 route[CARRIER_TRUST] (DB-backed carrier trust)

Runtime carrier admission: lets ops add a NEW origination carrier/PoP with a
single `carrier_trunks` INSERT (managed via TED; table from migration 40 —
columns `carrier, pop, trunk_group, source_ip inet, test_tn, direction,
cps_limit, enabled`) — no config change, no redeploy, no restart.

**Static vs DB trust model:**

| | Static (Bandwidth, Sinch) | DB (`carrier_trunks`) |
|---|---|---|
| Trust point | Top of request_route (flag 5), compile-time defines | Per initial INVITE, SQL point lookup on the zone's local replica |
| Protection cost | Skips pike/scanner (carrier-grade volume) | Runs AFTER the full untrusted gauntlet: blocked htable, sanity, pike (50 req/s/IP), SCANNER_DETECT (30 INVITE/min) — same profile as TRUNK_AUTH, so scanners cannot cheaply farm SQL |
| CPS limit | `bw_cps` htable, global `BW_CPS_LIMIT` per source IP | `carrier_cps` htable (key `carrier::pop`, fixed 1s window, autoexpire=1 + updateexpire=0), limit = the row's `cps_limit` (NULL/0 = no per-row limit) |
| OPTIONS / non-INVITE | Trusted (no flood tracking) | Untrusted handling — keep DB-carrier OPTIONS probes >= 5s apart (OPTIONS_FLOOD_THRESHOLD is 20/60s) |
| Ceiling | None (static IPs bypass pike) | pike bounds EVERY request at 50/s/IP — promote a permanent/high-CPS carrier to a static define |
| DB down | Unaffected (no DB on path) | **Fail-closed**: query error/no row -> return -> 403. A DB outage can never admit an unknown source |

**On a hit** (enabled row, `direction IN ('inbound','both')`): `setflag(5)`,
shared `bw_dedup` dedup (with the same 503-rollback semantics as the static
branch), per-row `carrier_cps` admission (503 + Retry-After over limit),
`dlg_manage()` + `$dlg_var(fs_port)=5080`, `X-SBC-ID`, spoof-proofed
`X-Inbound-Carrier`/`X-Inbound-PoP` from the row, Identity capture
(`X-In-Identity` for STIR div chaining), NAT_DETECT, DISPATCH, exit. The
carrier double-RR was already applied in request_route (unknown sources take
the non-FS `record_route_preset` branch), so in-dialog routing is identical to
static carriers (WITHINDIALOG/FROM_NET_INDIALOG are carrier-agnostic).
Deliberately NOT replicated: Bandwidth-PAI verstat/attest capture
(Bandwidth-format observability) and the closed-enum Prometheus trunk
metrics (a DB-sourced name is not a bounded label).

### 4.7 route[NAT_DETECT]

Called ONLY for inbound traffic from Bandwidth and re-INVITEs from external sources. NEVER called for FS-originated traffic (would corrupt Contact).

- `force_rport()`: Use actual source port instead of Via sent-by.
- `nat_uac_test("19")`: Check for private IPs in Contact/Via.
- `fix_nated_contact()`: Rewrite Contact to use source IP.

### 4.8 Failure Routes

**CARRIER_FAILURE**: Handles outbound carrier failures. Two-tier failover:
- 422 (Session Interval Too Small): Retry with Session-Expires: 3600, Min-SE: 900.
- 500/503/408/480/404, **flag 8 not yet set** -> in-trunk failover to the OTHER IP
  of the same Bandwidth trunk config, then set flag 8 (one in-trunk retry):
  - TC4: Dallas (`BANDWIDTH_IP_1`) <-> LA (`BANDWIDTH_IP_2`)
  - TC1: NY <-> Atlanta
  - TC2: Dallas <-> LA
  - Unknown `$rd` -> fall back to TC4 Dallas.
- 500/503/408/480/404, **flag 8 set, flag 9 not set, not already on TC4** ->
  cross-trunk failover to TC4 Dallas as the final fallback, then set flag 9
  (prevents infinite cross-trunk loops).

**DISPATCH_FAILURE**: Handles FS failures.
- 500/503/408: Try next FS via `ds_next_dst()`, mark failed destination as probing.

**TRUNK_DELIVERY_FAILURE**: Handles customer PBX delivery failures. Returns 503.

### 4.9 reply_route and onreply_route[REPLY_HANDLER]

**reply_route** (global): Traces ONLY stateless (transaction-less) replies to Homer via `if (!t_check_trans()) sip_trace();` — transaction-matched replies are already traced once by the siptrace tm callbacks armed in request_route (an unconditional `sip_trace()` here produced the historical node-100 duplicate rows). Side effect: 200s to dispatcher's own OPTIONS keepalives are no longer traced (noise reduction). Does NOT call `fix_nated_contact()` (FS already uses correct public IPs). Drops late 100 Trying.

**REPLY_HANDLER** (per-transaction): Fires for 1xx and 2xx replies.
- **183 SDP is PASSED THROUGH** (not stripped). Carrier 183 Session Progress with
  SDP flows to FS intact for PSTN early media / network ringback. (An earlier
  approach stripped the 183 body; that comment block in the config is obsolete —
  default media mode handles the cosmetic 183+200 double-SDP without stripping.)
- SDP scrubbing on all replies: private IPs replaced with **FS_PUBLIC_IP** (RTP
  target), not ADVERTISE_IP. Only the SDP body uses FS_PUBLIC_IP; headers keep VIP.
- Contact rewriting on FS-originated replies: Replace FS Contact with Kamailio's address.
- **Session timer normalization (BIDIRECTIONAL)**: Any reply passing through with a
  Session-Expires header gets normalized to `1800;refresher=uac` — in BOTH
  directions (carrier->FS and FS->carrier). Bandwidth sometimes sends
  Session-Expires: 30 (below RFC min 90), which FS silently ignores -> call
  disconnection; FS may answer Bandwidth's inbound proposal with a short value too.
  Normalizing every leg to 1800 guarantees both sides set up the refresh timer.

### 4.10 route[SCANNER_DETECT]

Tracks INVITE floods per source IP. >30 INVITEs/minute from untrusted source = blocked. Only applies to untrusted sources.

## 5. Dispatcher Configuration

**File**: `dispatcher.list`

Seven dispatcher groups:

| Group | Destination(s) | Purpose |
|---|---|---|
| 1 | sip:__FS_IP__:5080 | FreeSWITCH load balancing (used by `ds_select_dst`) |
| 2 | sip:67.231.2.12:5060 | Bandwidth TC4 Dallas keepalive/health monitoring ONLY |
| 3 | sip:216.82.238.134:5060 | Bandwidth TC4 LA keepalive/health monitoring ONLY |
| 4 | sip:67.231.9.142 + sip:67.231.13.185 | Bandwidth TC1 New York + Atlanta keepalive/health ONLY |
| 5 | sip:67.231.1.188 + sip:67.231.4.138 | Bandwidth TC2 Dallas + LA keepalive/health ONLY |
| 6 | sip:206.146.100.24:5060 (`__SINCH_DENVER_IP__`, duid=sinch-denver) | Sinch Denver (origination-only) keepalive/health ONLY |
| 7 | sip:206.146.101.39:5060 (`__SINCH_CHICAGO_IP__`, duid=sinch-chicago) | Sinch Chicago (origination-only) keepalive/health ONLY |

Groups 2-7 are NOT used for call routing (that's route[TO_CARRIER] via $rd/$du —
and Sinch is origination-only, never a TO_CARRIER destination anyway).
They exist solely for:
- **NAT keepalive**: OPTIONS every 5s keeps GCE's UDP NAT pinhole open.
- **Health monitoring**: Detects carrier unreachability. The carrier-monitor
  sidecar reports groups 2, 3, 6-9 (`CARRIER_SETIDS`) to the East API.

**Probe egress / on-the-wire source IP (verified against config + 5.8 socket
selection):** for every group EXCEPT 6/7 no destination carries a `socket=`
attr and there is no `ds_default_socket`, so with `mhomed=1` the OPTIONS
probes to the public carrier IPs egress from the `udp:SBC_INTERNAL_IP:5060`
socket (kernel route lookup picks the NIC address — the external VIP and
signaling VIP live on loopback and are never selected for an external
destination) and GCE 1:1 NAT puts **each SBC's OWN public IP** on the wire.
The Via shows ADVERTISE_IP (that socket advertises the VIP), but compliant
peers reply to the packet source per RFC 3261 §18.2.2 (`received`), i.e.
straight back to the SBC — this is the exact path on which Bandwidth (groups
2-5) and the Sinch TERM TGs (groups 8-9) answer. **Groups 6/7 are the
exception**: they carry `socket=udp:ADVERTISE_IP:5060` +
`ping_from=sip:ping@ADVERTISE_IP` (rendered from `__ADVERTISE_IP__`), so
those two probes egress FROM the external VIP bind on lo (GCE
passthrough-NLB backends may egress with the forwarding-rule IP as source —
DSR semantics, same mechanism as the proven /healthz VIP-sourced RST) with a
VIP From URI. `socket=` must match a real `listen=` bind exactly or
dispatcher REJECTS the list at load and kamailio won't start
(dispatch.c:472-490 `grep_sock_info`); the VIP bind exists unconditionally.

**Sinch ORIGINATION groups 6-7 — VIP-sourced probes + standby reads Inactive
by design:** the orig TGs (DNVTCOZIGR2_3278 / CHCGIL24GR4_7412) are
registered with our NLB VIPs (the addresses Sinch sends calls to), not the
SBC public IPs — captured 2026-09-01: SBC-public-sourced OPTIONS get 500 +
Contact `<sip:ANONYMOUS@...>` (Ribbon/Sonus unknown-trunk signature; 500 is
counted as probe-failure and deliberately NOT added to ds_ping_reply_codes —
see that modparam's comment). The `socket=`/`ping_from=` attrs make the 6/7
probes VIP-sourced at L3 and L7. Consequence of the passthrough NLB: replies
to the VIP reach the ACTIVE SBC only — the active SBC's 6/7 go probe-up
green; the STANDBY's 6/7 stay Inactive PERMANENTLY (its replies land on the
active, no transaction, dropped) and fire one `dispatcher:dst-down` per
standby boot per duid (single dsmon gen bump + one carrier-monitor snapshot
— harmless, no flapping). Correct overall signal because
carrier_trunk_health is up-on-≥1-SBC (bool_or), and migration 45's
passive/traffic state remains the safety net ('up' on probe-answer OR
inbound CDRs within 60 min, else amber 'passive' — never red). If Sinch's
filter still 500s VIP-sourced OPTIONS, the passive display stands and the
Sinch support ask (enable OPTIONS on the orig TGs) is the only path to
probe-green.

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
| `EXTERNAL_SIP_IP` | Yes | 34.24.133.82 | ADVERTISE_IP — the NLB VIP. Used in listen advertise, Contact, From domain, and the OUTER Record-Route. NOT used for SDP. |
| `FREESWITCH_IP` | Yes | 192.168.10.2 | FreeSWITCH's IP (GCE internal VPC/media-subnet IP, not 127.0.0.1, because FS binds to `local_ip_v4`). Dispatcher group 1 target. |
| `SBC_INTERNAL_IP` | No (default 127.0.0.1) | 10.142.0.100 | This SBC's VPC IP. FS-facing listen socket, `alias=`, and the INNER Record-Route (bypasses NLB so in-dialog ACK/BYE reach THIS SBC). |
| `FS_PUBLIC_IP` | No (default `$EXTERNAL_SIP_IP`) | 34.139.119.135 | FS VM's OWN public IP, used in SDP body rewrites (RTP target). Distinct from the NLB VIP. |
| `HEP_CAPTURE_ID` | No (default 100) | 110 | siptrace HEP capture ID (East=100, West=110, Central=120). |
| `SBC_ID` | No (default east-sbc-1) | east-sbc-2 | Per-SBC identifier appended as `X-SBC-ID` header for Homer/log correlation. |
| `DB_HOST` | No | 127.0.0.1 | PostgreSQL host for trunk auth. Default: 127.0.0.1. |
| `DB_PORT` | No | 6432 | PostgreSQL port (compose default 6432 = PgBouncer). Entrypoint default is 5432. |
| `DB_USER` | No | freeswitch | Database user. |
| `DB_PASS` | No | fs_secret | Database password. |
| `HOMER_IP` | No | 127.0.0.1 | Homer SIP capture server. |
| `BANDWIDTH_PRIMARY_IP` | No (default 67.231.2.12) | 216.82.238.134 | This zone's nearest Bandwidth PoP → `BANDWIDTH_IP_1` (`X-Carrier=primary`). East=Dallas, West=LA. |
| `BANDWIDTH_SECONDARY_IP` | No (default 216.82.238.134) | 67.231.2.12 | This zone's secondary Bandwidth PoP → `BANDWIDTH_IP_2` (`X-Carrier=secondary`). East=LA, West=Dallas. |
| `INTERNAL_SUBNET` | No (default 10.142.0.0/20) | 10.138.0.0/20 | This zone's trusted VPC subnet → `GCE_INTERNAL_NETWORK`. |
| `MEDIA_SUBNET` | No (default 192.168.10.0/24) | 192.168.20.0/24 | This zone's trusted FS media subnet → `VOIP_SUBNET`. |
| `BW_CPS_LIMIT` | No (default 100) | 100 | Per-carrier-IP inbound CPS backstop. New INVITEs from a Bandwidth IP above this rate get 503 + Retry-After: 5 (`bw_cps` htable, fixed 1s window). Flood protection, not a traffic shaper. |
| `TESTING_IP` | No (default 255.255.255.255 = disabled) | 72.74.134.146 | Trusted SIPp test source IP. Leave UNSET in production — the default can never match a real source. |
| `BANDWIDTH_TC1_NY` | No (default 67.231.9.142) | — | TC1 New York PoP (`X-Carrier=tc1`, in-trunk failover, dispatcher group 4 keepalive). |
| `BANDWIDTH_TC1_ATL` | No (default 67.231.13.185) | — | TC1 Atlanta PoP (TC1 in-trunk failover target, dispatcher group 4 keepalive). |
| `BANDWIDTH_TC2_DAL` | No (default 67.231.1.188) | — | TC2 Dallas PoP (`X-Carrier=tc2`, in-trunk failover, dispatcher group 5 keepalive). |
| `BANDWIDTH_TC2_LA` | No (default 67.231.4.138) | — | TC2 Los Angeles PoP (TC2 in-trunk failover target, dispatcher group 5 keepalive). |
| `SINCH_DENVER_IP` | No (default 206.146.100.24) | — | Sinch Denver origination PoP (Trunk Group DNVTCOZIGR2_3278, test TN 5305480845). Static inbound trust + attribution + dispatcher group 6 keepalive. Origination-only — never an egress target. |
| `SINCH_CHICAGO_IP` | No (default 206.146.101.39) | — | Sinch Chicago origination PoP (Trunk Group CHCGIL24GR4_7412, test TN 5305480846). Static inbound trust + attribution + dispatcher group 7 keepalive. Origination-only — never an egress target. |

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
  - Per-carrier-IP CPS backstop (bw_cps htable, BW_CPS_LIMIT/s, 503 if exceeded)
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
    1. X-Carrier=primary -> carrier_ip=67.231.2.12 (TC4 Dallas)
    2. $fd=ADVERTISE_IP (NLB VIP), $td=67.231.2.12
    3. Strip all FS headers, add clean Contact (ADVERTISE_IP)
    4. msg_apply_changes(), then DOUBLE record_route_preset(VIP, SBC_INTERNAL_IP)
    5. (Via untouched - two Vias is valid)
    6. PAI from X-Original-CID
    7. Add Supported: timer, Session-Expires: 1800
    8. SDP scrub -> FS_PUBLIC_IP (not VIP; RTP bypasses NLB)
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

### 8.7 Double Record-Route for Multi-SBC NLB

`enable_double_rr=1` is set and BOTH legs use `record_route_preset()` with two URIs:
```
Record-Route: <sip:ADVERTISE_IP:5060;fs=509x;lr>          (outer = NLB VIP, what Bandwidth sees)
Record-Route: <sip:SBC_INTERNAL_IP:5060;r2=on;fs=509x;lr> (inner = this SBC's VPC IP)
```
- **TO_CARRIER (B-leg, FS->carrier):** `record_route_preset("ADVERTISE_IP:5060;fs=5090;lr", "SBC_INTERNAL_IP:5060;r2=on;fs=5090;lr")` — outer first.
- **A-leg (Bandwidth->FS, in request_route):** `record_route_preset("SBC_INTERNAL_IP:5060;r2=on;fs=5080;lr", "ADVERTISE_IP:5060;fs=5080;lr")` — REVERSED order, because Kamailio's RR insertion direction means the reversal yields the correct outer(VIP)/inner(SBC) roles for the inbound direction.

**The `;r2=on` marker (FS-direction hairpin fix — carrier-side it is inert):** `r2=on` is the rr module's native double-RR pair marker (record.c `RR_R2`). With `enable_double_rr=1`, when `loose_route()` pops an own FIRST Route carrying `r2`, it ALSO consumes the next Route and forces the send socket to that URI's listen socket (5.8 loose.c `after_loose`/`is_2rr` — the check reads the FIRST Route's params only). It goes on the **FS-facing (SBC_INTERNAL) entry ONLY**, because that entry is the FIRST Route only in the FS→carrier direction:
- FS-side in-dialog ACK/BYE (Route: SBC_INTERNAL;r2, VIP) → both Routes consumed in ONE traversal, request relayed straight to the carrier from the VIP socket with ONE SBC Via. Without it, the leftover VIP Route made the SBC send the request TO ITSELF over loopback (the VIP is a local address), reprocess it, and stack a second own Via on the carrier-bound BYE (this is exactly what production did during the r2-less window 2026-08-03..21).
- In the carrier→FS direction the VIP is the first Route and never carries `r2`, so `r2` is **invisible there — it neither helps nor harms**. Carrier-side in-dialog requests are NOT routed by `loose_route()` at all; see §8.10.

**The `;fs=` marker (stateless carrier-side dispatch):** `fs=5080` (A-leg preset) / `fs=5090` (B-leg preset) on BOTH entries. The peer echoes our Record-Route set verbatim in its Route headers (and some shapes echo an RR URI as the R-URI), so any SBC can read the target FS profile port from the request itself — no dialog state, no owner/non-owner logic. URI parameters on our own RR entries are inert to the rr module (`is_myself` matches host:port; `is_2rr`/`is_strict` key on `r2`/`lr` specifically) and MUST be echoed unmodified per RFC 3261 (Bandwidth demonstrably echoes `ftag`/`did` already).

**Why the inner RR (FS direction):** GCE's NLB is pass-through and stateless. FS
sends its in-dialog ACK/BYE to its first Route = the inner SBC_INTERNAL_IP —
directly to the SBC that owns the dialog, bypassing the NLB. Without it, FS's ACK
would hit the VIP and load-balance to a random SBC. This requires
`alias=SBC_INTERNAL_IP:5060` (so `loose_route()` recognizes the inner RR as
local/"myself"). In the carrier→FS direction the inner RR is informational only —
any SBC can serve the request via the `;fs=` marker (§8.10), which is what makes
the stateless NLB coin-flip harmless.

**Contact vs SDP IP split:** Contact and From use ADVERTISE_IP (the VIP, for SIP
routing); SDP `c=`/media uses FS_PUBLIC_IP (where RTP actually flows, bypassing
the NLB). Mixing these up breaks either signaling routing or audio.

**GCE hairpin NAT** is solved separately at the OS level — the SBC adds its
ADVERTISE_IP (VIP) to loopback (`ip addr add VIP/32 dev lo`) so traffic to its own
advertised address is delivered locally instead of dropped by GCE's fabric.

### 8.8 Topology Hiding is Manual, Not via topoh Module

The `topoh.so` module is explicitly disabled. It conflicts with the manual header cleanup in TO_CARRIER by adding TH= markers that must then be removed. All topology hiding is done via explicit `remove_hf()` + `append_hf()` + SDP `subst_body()`.

### 8.9 FS Profile Port Selection (fs= marker first, dialog variable as fallback)

The authoritative port source is the `;fs=` Record-Route marker (§8.7/§8.10) — stateless, works on any SBC. `$dlg_var(fs_port)` (set during initial INVITE routing: 5080 inbound/trunk, 5090 outbound) remains as the owner-side fallback for dialogs established before the marker existed; `dlg_match_mode=1` (SIP-element fallback matching) is REQUIRED for it to resolve in `TO_FS_INDIALOG`, which does not run `loose_route()` (so no `;did=` processing). If both are missing, `TO_FS_INDIALOG` guesses 5090 and serially retries the other profile on a 481 (`failure_route[FS_PORT_FAILOVER]`, non-ACK only). Routing an in-dialog request to the wrong FS profile yields a Sofia 481 — the profiles are independent SIP agents.

### 8.10 Carrier-side in-dialog routing (BYE/ACK/re-INVITE 481) — FINAL DESIGN: stateless dispatch, no loose_route() for network-side requests

**Status: VALIDATED IN PRODUCTION (2026-08-24). Deployed to all 6 SBCs / 3 zones (PR #65, merged); live test matrix below PASSED per zone — far-end AND caller-side hangups tear down immediately in West, East, and Central; no 481s, single VIP Via, BYEs reach FS on the correct profile port. The `kamailio -c` gate was run on the 5.8 image at each SBC before restart. Adversarially reviewed against fetched 5.8 `rr/loose.c` + rr/tm/dialog docs + RFC 3261 (zero call-path findings; one comment-level correction applied: `dlg_match_mode=1` does NOT affect `$dlg_var` reads — see the modparam comment). Ops corollary of the NLB consistent-hash pinning: whether pre-fix teardown "worked" depended on each Bandwidth PoP's 5-tuple pin coinciding with the B-leg bridge SBC — restarts re-roll the pin, which is why the defect appeared/disappeared across deployments. With this design the pin no longer matters.**

#### The disease (source-verified against Kamailio 5.8 `rr/loose.c`)

Topology hiding rewrites FreeSWITCH's Contact to the NLB VIP (`ADVERTISE_IP`), so EVERY
carrier/PBX in-dialog request arrives with **R-URI == one of our own addresses** — on
BOTH SBCs (both listen on/advertise the VIP) — plus `Route: [VIP, SBC_INTERNAL_owner]`.
`loose_route_mode()` dispatches on exactly that shape: *R-URI is myself + Route header
present + to-tag* → **`after_strict()`** — the RFC 2543 strict-router recovery — fires
**unconditionally** (r2 plays no role in the trigger). `after_strict()` then:

1. sets **`$du` = the FIRST Route** — our own VIP → a guaranteed loopback self-hairpin
   (the VIP is a local address on every SBC), one stacked `Via:<VIP>` per pass;
2. **promotes the LAST Route into the R-URI verbatim** (`rewrite_uri()` via
   `find_rem_target()`) — the owner SBC's private `sip:10.138.0.x:5060;lr;ftag;did`
   becomes the R-URI, params and all — and removes only that last Route.

The route set is destroyed and the packet's fate then depends on which SBC re-receives
it, its dialog state, and which patch generation it runs — the captured result was a
3×`Via:<VIP>` BYE egressing an SBC **public** interface to FS with an SBC R-URI, and
Sofia answering **481** (wrong port or an R-URI Sofia can't associate → 481 every time;
the two FS profiles :5080/:5090 are independent SIP agents). `after_strict()` is correct
for a genuine upstream strict router; our R-URI==self comes from topology hiding, and
rr has no way to know the difference. **Conclusion: carrier-side in-dialog requests must
never be given to `loose_route()` at all.**

#### The fix (design A — stateless deterministic dispatch)

1. **`;fs=` dispatch marker in both Record-Route presets** (§8.7): A-leg preset carries
   `;fs=5080`, TO_CARRIER preset `;fs=5090`, on BOTH entries. The peer echoes the RR set
   verbatim in its Route headers on every in-dialog request (Bandwidth demonstrably echoes
   `ftag`/`did` already), and RR-URI-as-R-URI shapes carry it in the R-URI. The target FS
   profile port is therefore IN THE REQUEST — readable by ANY SBC with zero dialog state.
2. **`route[WITHINDIALOG]` head arm, BEFORE `loose_route()`:**
   `!IS_INTERNAL_SOURCE && $si != SIPP_TESTING_IP && is_myself($rd)` →
   `route[FROM_NET_INDIALOG]` (re-INVITE: `NAT_DETECT` + `record_route()`, mirroring the
   legacy in-dialog INVITE handling) → `route[TO_FS_INDIALOG]`.
3. **`route[TO_FS_INDIALOG]`** (the ONE terminal FS delivery path, also used by the
   no-Route safety nets and the self-loop redirect): resolve port `;fs=` in Route (either
   header) → `;fs=` in R-URI → `$dlg_var(fs_port)` (owner-only fallback for pre-marker
   dialogs; needs `dlg_match_mode=1`) → guess 5090 + one-shot 481 retry on 5080
   (`failure_route[FS_PORT_FAILOVER]`, non-ACK). Build a clean `sip:<user>@FS_IP:port`
   (preserve `$rU` — it IS FS's Contact user echoed back: the TN on the A-leg,
   `mod_sofia` on the B-leg; fall back to `$tU`), `remove_hf("Route")` (we terminate the
   route set — FS must never see Route headers), `$du = sip:FS_IP:port` → mhomed picks
   the internal socket (192.168.x is only reachable via the VPC interface — same
   mechanism as every DISPATCH INVITE, so the BYE reaches FS from an internal `10.x`
   source, single SBC Via, never the public path).
4. **`;r2=on` RESTORED on the inner (SBC_INTERNAL) preset entries** — FS-direction only
   (§8.7). Carrier-side it was always invisible; FS-side it restores the April
   single-traversal behavior (`after_loose()` double-pop + VIP send socket).
5. **`dlg_match_mode=1`** so the `$dlg_var(fs_port)` fallback can resolve without
   `loose_route()`/`;did=` processing (exact Call-ID+tags matching).

Invariants preserved: topology hiding, `bw_dedup`, NAT_DETECT never on FS traffic
(head arm is external-source-only, matching the old conditional exactly), TEST-PATH
(SIPp is excluded from the head arm by BOTH clauses — internal SIPp via
`IS_INTERNAL_SOURCE`, external SIPp via `$si != SIPP_TESTING_IP` — so test dialogs
always reach their dedicated TEST-PATH machinery), STIR hooks, 422/5xx carrier
failover, REPLY_HANDLER Contact rewriting, Contact-before-`msg_apply_changes`,
`record_route`-after-`msg_apply_changes`, no topoh, `alias=SBC_INTERNAL_IP:5060`.

#### Mixed-state / transition behavior (deploy-window safety)

Each updated SBC is **self-sufficient**: a carrier request hitting it directly is
handled correctly regardless of the peer's config generation. Shapes relayed BY a
stale peer (its `after_strict()` output: no-Route + R-URI == our SBC_INTERNAL, from an
internal source) land in the no-Route arms' `is_myself($rd)` safety net → same
`TO_FS_INDIALOG` delivery. Dialogs **established before** the marker deploy have no
`;fs=`: at the owner, `$dlg_var(fs_port)` resolves the port; at the non-owner, the
5090-guess + 481-retry recovers BYE/UPDATE/INFO (one ~1ms internal round-trip); a
pre-marker 2xx **ACK** on the non-owner cannot be retried (no transaction) and is
best-effort — strictly better than the prior state, where it was 100% lost. These
old dialogs age out within one session-timer cycle.

#### Superseded iterations (kept for the record — do NOT resurrect)

1. **April design ("r2=on required, inner Route reaches the owner")** — half right.
   `r2` on the inner entry is correct and necessary **for the FS→carrier direction
   only** (`is_2rr()` reads the FIRST Route; inner is first only in FS's route set).
   The claim that the carrier direction "pops ONLY the VIP, leaving the inner Route
   to reach the dialog-owning SBC" was **false**: with R-URI==self, `after_strict()`
   fires before any popping logic and destroys the set. Carrier-side teardowns were
   structurally broken from day one.
2. **Option A, 34a7f70 (2026-08-03): drop r2 from both presets + `$dd`-keyed
   non-owner relay** — attacked the wrong lever twice. Dropping `r2` changed nothing
   carrier-side (it was never consulted there) and broke the FS-direction double-pop
   (re-introducing the wire hairpin + duplicate Via it had fixed). The relay keyed on
   `$dd ∈ GCE_INTERNAL_NETWORK`, but `after_strict()` sets `$du` to the **VIP** (first
   Route) — never a peer-internal address — so the relay **could not fire** on the
   real shape; the BYE self-hairpinned instead. Never live-verified.
3. **2707a10 (owner no-Route `is_myself($rd)`→FS guard)** — right instinct (decide by
   R-URI, not source), wrong location: the failing packet stays in the
   loose_route()-SUCCESS branch (promotion returns RR_DRIVEN), so the no-Route guard
   was unreachable for the primary shape. Also read `$dlg_var(fs_port)` in a context
   where `dlg_match_mode=0` (did-only) could never match a no-Route request → always
   defaulted to 5090, wrong for every A-leg (caller-side) BYE. The guard survives in
   spirit as the mixed-state safety net (now delivering via `TO_FS_INDIALOG`).
4. **b38f985 (loose_route-SUCCESS promoted-R-URI guard)** — correctly identified the
   promotion but kept chasing its outputs: owner/non-owner branching on `$rd`, a
   non-owner→owner relay (another traversal, another config-generation dependency),
   `$dlg_var` reads with the same `dlg_match_mode=0` flaw, and its relay left the
   leftover `Route:[VIP]` attached (per 5.8 `after_strict()` only the LAST Route is
   removed), handing the owner a shape whose self-loop redirect (keyed on
   `IS_INTERNAL_SOURCE`) would bounce it to Bandwidth. Never deployed.

   The common failure mode of 2-4: **treating `after_strict()`'s output shapes as the
   problem instead of the fact that `after_strict()` runs at all.** The final design
   removes the generator; there are no shapes left to chase.

#### Live test matrix (run per zone before calling it fixed; Homer signatures)

For each cell: **PASS** = the BYE reaches FS as `BYE sip:<user>@<FS_IP>:<port>` (A-leg
`:5080`, B-leg `:5090`) from an SBC **internal** `10.x` source, exactly ONE SBC
`Via:<VIP>` on the FS leg, FS answers `200 OK`, and the phone drops immediately.
**FAIL** signatures to grep: R-URI containing `:5060;lr` toward FS, 3× stacked
`Via:<VIP>`, `received=<SBC public IP>` on the FS-received top Via, Sofia `481`.

| Cell | Wire shape in | cfg branch | Expected |
|---|---|---|---|
| Callee hangup, NLB→either SBC, new dialog | R-URI `sip:mod_sofia@VIP`, Route `[VIP;fs=5090, inner;r2;fs=5090]` | head arm → TO_FS_INDIALOG (tier 1) | FS :5090, 200 OK, caller phone drops via FS A-leg BYE |
| Caller hangup, NLB→either SBC, new dialog | R-URI `sip:<TN>@VIP`, Route `[VIP;fs=5080, inner;r2;fs=5080]` | head arm → TO_FS_INDIALOG (tier 1) | FS :5080, 200 OK, callee leg dropped by FS |
| Either hangup, pre-marker dialog, NLB→owner | no `fs=` in Routes | head arm → tier 3 (`$dlg_var`) | correct port first try |
| Either hangup, pre-marker dialog, NLB→non-owner | no `fs=`, no dialog state | head arm → tier 4 guess+retry | ≤1 internal 481 then 200 on the other port |
| Carrier re-INVITE (session refresh) | INVITE, R-URI==VIP, Route pair | head arm → FROM_NET_INDIALOG (NAT_DETECT+record_route) → TO_FS_INDIALOG | FS answers 200 w/ SDP; refresh completes |
| Carrier 2xx ACK | ACK, R-URI==VIP, Route pair | head arm → TO_FS_INDIALOG | ACK lands on correct profile; no 200-retransmit storm |
| FS-originated BYE/ACK (both legs) | Route `[inner;r2, VIP]`, R-URI=carrier Contact | loose_route → after_loose double-pop | single traversal, ONE `Via:<VIP>`, egress from VIP socket to Bandwidth |
| SIPp test in-dialog | single plain internal RR | TEST-PATH fast exit | unchanged |
| Trunk PBX-side BYE (trunk-delivery leg) | R-URI = FS real Contact (not ours) | loose_route (head arm skipped: R-URI not myself) | unchanged |

#### HEP extraction used to diagnose (qryn/ClickHouse on the East `services` VM)
```
sudo docker exec voip-clickhouse clickhouse-client --query "SELECT timestamp_ns, string FROM qryn.samples_v3 WHERE string LIKE '%<callid-A>%' OR string LIKE '%<callid-B>%' ORDER BY timestamp_ns ASC FORMAT Vertical"
```
(SIP text is in `qryn.samples_v3.string`; do NOT `| tee` a failing query — `tee` truncates the output file even on error.)

## 9. How to Modify

### Adding a New Carrier IP / Trunk Config

**Runtime path (ORIGINATION-only carriers, no redeploy):** INSERT a row into
`carrier_trunks` (via TED) with the source IP, carrier/pop names, direction
`inbound`/`both`, and a `cps_limit`. route[CARRIER_TRUST] (4.6.1) admits it on
the next INVITE — no config change. Use this for trials and emergency adds;
PROMOTE to a static define (below) once the carrier is permanent or needs
carrier-grade CPS (the DB path sits behind pike at 50 req/s/IP).

**Static path** — ALL carrier IPs are env-driven: the Bandwidth TC4
primary/secondary PoPs via `BANDWIDTH_PRIMARY_IP`/`BANDWIDTH_SECONDARY_IP`, the
fixed-PoP TC1/TC2 IPs via
`BANDWIDTH_TC1_NY`/`BANDWIDTH_TC1_ATL`/`BANDWIDTH_TC2_DAL`/`BANDWIDTH_TC2_LA`,
and the Sinch origination PoPs via `SINCH_DENVER_IP`/`SINCH_CHICAGO_IP`
(entrypoint templates them into both kamailio.cfg AND dispatcher.list, defaults =
current production IPs). To add a NEW static carrier IP:

1. Add a `#!define` with a `__PLACEHOLDER__` in the Global Parameters section and
   the matching default + sed line in entrypoint.sh (follow the `BANDWIDTH_TC*` /
   `SINCH_*` precedent):
   ```
   #!define BANDWIDTH_TCx_NEW "__BANDWIDTH_TCx_NEW__"
   ```
2. Trust: Bandwidth IPs inside 67.231.0.0/16 / 216.82.224.0/19 are already
   covered by the flag-5 nets. IPs outside those (like Sinch's) need an explicit
   `$si ==` arm in the flag-5 block AND in the carrier-ingress INVITE branch
   condition (they are parallel — keep them in sync), plus an
   `X-Inbound-Carrier`/`X-Inbound-PoP` attribution arm and (for a non-Bandwidth
   carrier) an `X-Inbound-TC` arm.
3. Add a dispatcher group in `dispatcher.list` for keepalive (groups 6-7 are
   Sinch; next free group is 8):
   ```
   8 sip:1.2.3.4:5060 0 0 weight=100;duid=carrier-pop
   ```
   Add the setid to `CARRIER_SETIDS` + a `DUID_NAMES` entry in
   `docker/carrier-monitor/carrier_monitor.py` if it should be reported, and an
   alias in `docker/homer/scripts/ip-alias.lua`.
4. TERMINATION carriers only: add an `X-Carrier` routing case in TO_CARRIER's
   switch and the in-trunk failover case (and its return IP) in CARRIER_FAILURE.
   Origination-only carriers (Sinch) get NEITHER — egress stays Bandwidth.
5. Run `kamcmd dispatcher.reload` after deploy.

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
- `BW_CPS_LIMIT` is env-driven (NOT a `#!define` edit) — set it in the SBC's `.env`.

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
