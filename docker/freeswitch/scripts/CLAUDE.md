# FreeSWITCH Lua Scripts -- RCF-V1

## Overview

All call routing logic lives in Lua scripts executed by mod_lua. FreeSWITCH's XML dialplan sets variables and delegates to Lua for dynamic routing decisions. Scripts query PostgreSQL (via luasql-postgres) and optionally Redis (via redis-lua) for DID lookups, customer validation, rate limiting, and fraud prevention.

## Critical: mod_lua Module Loading Workaround

mod_lua adds the script directory as a package searcher, which breaks `require("redis")` because it tries to read `/usr/local/freeswitch/scripts/` as a file (it's a directory). All scripts use one of two workarounds:

1. **`loadfile()` pattern** (preferred, used by inbound_router.lua and newer scripts):
```lua
local function load_module(name)
    local path = "/usr/local/freeswitch/scripts/lib/" .. name .. ".lua"
    local func, err = loadfile(path)
    if not func then return nil end
    local ok, result = pcall(func)
    if not ok then return nil end
    return result
end
local db = load_module("db_client")
```

2. **Package path prepending** (used for luarocks-installed libraries like redis-lua):
```lua
package.path = "/usr/local/share/lua/5.3/?.lua;..." .. (package.path or "")
```

Every script that loads modules MUST prepend paths before any `require()` call.

---

## Complete Inbound Call Flow

```
SIP INVITE arrives at Kamailio (VM1)
  |
  v
Kamailio relays to FreeSWITCH internal profile (VM2, port 5080)
  |
  v
Dialplan public context matches destination_number pattern
  |-- Anti-fraud rules first (empty dest, URI injection, invalid chars, >20 digits)
  |-- trunk_outbound_from_kamailio: if X-Trunk-ID header present -> trunk_outbound.lua
  |-- inbound_handler: if destination matches ^(\+?1?\d{10,15})$ -> inbound_router.lua
  |
  v
inbound_router.lua executes:
  1. Extract call details (DID, caller ID, source IP)
  2. Preserve original caller ID from sip_from_user (before FS modifies it)
  3. Normalize DID to E.164 (+1XXXXXXXXXX)
  4. DID lookup cascade (PostgreSQL only — the Redis route cache, fraud
     prefix check, and velocity limiting were REMOVED in RCF-V1; old code
     is in git history, re-adding needs a synchronous Redis client):
     a. RCF: PostgreSQL (rcf_numbers JOIN customers)
     b. API DID: PostgreSQL (api_dids JOIN customers)
     c. Trunk DID: PostgreSQL (trunk_dids JOIN sip_trunks JOIN customers)
  5. If no match -> UNALLOCATED_NUMBER (SIP 404)
  6. Set channel variables: customer_id, product_type, traffic_grade, trunk_id
  7. Route based on product_type:
     |
     |-- "rcf" -> Bridge to forward_to number via carrier
     |-- "api" -> Answer, then execute voice_webhook.lua
     |-- "trunk" -> Bridge to customer PBX via Kamailio
```

### RCF Bridge Details

```
inbound_router.lua (product_type == "rcf"):
  |
  1. Media: DEFAULT media mode (FS stays in RTP path as B2BUA). The RCF bridge
     dial strings do NOT set proxy_media — only the TRUNK path sets
     proxy_media=true (see ~:862). (Note: a long comment block ~:482-526 in
     the RCF path still discusses proxy_media, but no proxy_media var is set
     on the RCF dial string — the comment is stale.)
  2. Set ringback tone: %(2000,4000,440,480) on A-leg while B-leg rings
  3. Caller ID handling (FusionPBX-style via setVariable, not dial string):
     - outbound_caller_id_number = RCF DID (10-digit, for Bandwidth auth in From header)
     - effective_caller_id_number = original caller (if pass_caller_id=true) or RCF DID
     - sip_h_Diversion = RCF DID with reason=unconditional
     - sip_h_X-Original-CID = original caller (Kamailio builds P-Asserted-Identity from this)
     - sip_h_Remote-Party-ID = original caller (backup CID mechanism)
  4. Carrier is PINNED to "primary" (TC4 Dallas) at ~:455 regardless of the
     inbound trunk. X-Inbound-TC (set by Kamailio) is read but its
     trunk-affinity mapping to tc1/tc2 is present-but-commented — do not
     change until Bandwidth provisions all TCs for our IPs.
  5. 4-ATTEMPT SBC + carrier failover loop (~:707-763), NOT a simple 2-step:
        attempt 1: SBC_PROXY_IP          + X-Carrier=primary   (SBC-1, Dallas)
        attempt 2: SBC_PROXY_IP_FAILOVER + X-Carrier=primary   (SBC-2, Dallas)
        attempt 3: SBC_PROXY_IP          + X-Carrier=secondary (SBC-1, LA)
        attempt 4: SBC_PROXY_IP_FAILOVER + X-Carrier=secondary (SBC-2, LA)
     - Each attempt runs a CACHED TCP reachability pre-check (sbc_tcp_probe +
       is_sbc_reachable): opens a 1s TCP socket to the SBC:5060. If
       unreachable, the attempt is SKIPPED instantly instead of waiting for
       the SIP timeout. Results are cached process-wide via FreeSWITCH
       global variables (key sbc_health_<ip>, value up|down:<epoch>):
       reachable cached 30s, unreachable cached 10s, INFO log on state
       transitions. Fails open (with a WARNING log) if luasocket is
       unavailable; fail-open results are never cached.
     - Per-attempt dial string sets ignore_early_media=false, call_timeout,
       progress_timeout (env BRIDGE_PROGRESS_TIMEOUT, default 10 — bounds
       carrier PDD only; ringing then continues to call_timeout. NEVER use
       originate_timeout here: it caps time-to-ANSWER including ring time),
       X-Carrier, X-CID (sip_call_id for Homer A/B correlation),
       and RFC 4028 session timers (sip_session_timeout=1800, min=90).
     - Loop breaks on `originate_disposition == "SUCCESS"` (the real FS bridge-result variable; `bridge_result` is NOT a channel variable and must never be used). `carrier_used` is set per attempt, so breaking on success records the winning carrier.
     - Export RFC 4028 session timers to B-leg as well.
     - Uses EXTERNAL profile so Via/Contact/SDP get public IP.
  6. If all 4 attempts fail -> NORMAL_TEMPORARY_FAILURE (SIP 503)
     - lua_routed=true prevents dialplan from masking with 404
  |
  Special case: forward_to is a local extension (is_local_extension)
     -> Single bridge attempt as user/{ext}@{domain} (no SBC/carrier failover)
```

---

## Script Reference

### startup.lua

**Runs once at FreeSWITCH boot** (configured as mod_lua startup script).

Responsibilities:
1. Fix package.path and package.cpath for Lua 5.3
2. Read environment variables and set globals: `REDIS_HOST`, `REDIS_PORT`, `PG_HOST`, `PG_PORT`, `PG_DB`, `PG_USER`, `PG_PASS`, `PG_CONNSTRING`, `API_HOST`, `API_PORT`, `TEST_MODE`, `LOG_LEVEL`
3. Build PostgreSQL connection string: `PG_CONNSTRING`
4. Run non-blocking connectivity tests (Redis PING, PostgreSQL SELECT 1)
5. Log configuration summary

**These globals are available to all subsequent Lua script invocations** within the same mod_lua instance. The `PG_CONNSTRING` global is consumed by db_client.lua.

### inbound_router.lua

**Called per inbound call** from the `inbound_handler` dialplan extension.

See "Complete Inbound Call Flow" above for full details.

Key state: Redis code is fully REMOVED (RCF-V1 -- redis-lua threading issues; old code in git history). Only db_client is loaded.

**RCF carrier/failover:** Carrier is pinned to `primary` (TC4 Dallas).
The RCF PSTN bridge is a 4-attempt loop over `SBC_PROXY_IP` and
`SBC_PROXY_IP_FAILOVER` × primary/secondary carrier, each guarded by a cached
1-second TCP reachability pre-check (`is_sbc_reachable` — 30s up / 10s down
cache via FS global variables). See "RCF Bridge Details" above. RCF uses
DEFAULT media — it does NOT set `proxy_media`.

**183 SDP note:** Kamailio now PASSES THROUGH carrier 183 SDP for PSTN early
media (it no longer strips the 183 body). Any script comment implying the 183
body is stripped is obsolete.

**Database tables queried:**
- `rcf_numbers` JOIN `customers` -- RCF DID lookup
- `api_dids` JOIN `customers` -- API DID lookup
- `trunk_dids` JOIN `sip_trunks` JOIN `customers` -- Trunk DID lookup

**Channel variables set for CDR:**
`customer_id`, `product_type`, `traffic_grade`, `trunk_id`, `carrier_used`, `forward_to`, `direction`, `call_start_time`, `hangup_cause`, `blocked_reason`, `fraud_score`, `lua_routed`

### trunk_outbound.lua

**Called per outbound trunk call** from the `trunk_outbound_from_kamailio` or `trunk_outbound` dialplan extensions.

Call flow:
1. Read trunk_id from channel variable (set by Kamailio's X-Trunk-ID header) or fall back to DB lookup by source IP (`trunk_auth_ips` table)
2. Validate destination (normalize to E.164)
3. Validate caller DID belongs to this trunk (`trunk_dids` table). If caller's From number isn't in trunk_dids, look up any DID for this trunk as fallback. Reject if no valid DID found.
4. [If Redis available] Check high-risk prefix fraud database
5. [If Redis available] CPS check with tier support via redis_cps.check_cps_with_tier()
6. [If Redis available] Acquire channel (concurrent call limit via Redis sorted set)
7. [If Redis available] Velocity check (CPM/daily limits)
8. Set caller ID: outbound_caller_id = trunk DID (carrier auth), effective_caller_id = PBX original
9. Bridge via `sofia/external/dest@sbc_proxy_ip:5060` with X-Carrier=primary
10. Failover with X-Carrier=secondary if primary fails
11. Set `api_hangup_hook=lua channel_release.lua` for channel cleanup

### api_outbound.lua

**Called per ESL-originated outbound API call** from the `outbound_api` dialplan extension.

Call flow:
1. Read customer_id, destination, webhook_url, callback_url from channel variables (set by ESL originate)
2. Normalize destination to E.164
3. [If Redis] Fraud prefix check
4. [If Redis] CPS check with API tier limits (25/50/100+ CPS via redis_cps)
5. Get per-call fee from tier (starter=$0.01, professional=$0.008, enterprise=$0.005)
6. [If Redis] Velocity check with higher API limits (300 CPM, 5000 daily)
7. If webhook_url set: hand off to voice_webhook.lua (TwiML engine)
8. If no webhook: bridge via `sofia/external/dest@sbc_proxy_ip:5060` with X-Carrier=primary
9. Failover with X-Carrier=secondary

### outbound_api.lua

**Legacy/alternative outbound API handler.** Similar to api_outbound.lua but simpler:
- Uses `require()` instead of `loadfile()` (may fail due to mod_lua path issue)
- No tier-aware CPS checking
- Supports webhook handoff to voice_webhook.lua
- Falls back to simple bridge

### voice_webhook.lua

**TwiML-compatible XML execution engine** for API calling product.

Supports these verbs: Say, Play, Gather, Dial, Hangup, Pause, Redirect, Reject.

Flow:
1. Build payload from session variables (caller, destination, customer_id, direction)
2. HTTP POST to customer's voice_url with call details (form-encoded)
3. Parse XML response (custom parser, not libxml -- handles `<Response>` root with verb children)
4. Execute verbs sequentially:
   - `<Say>` -- Text-to-speech (mod_say_en or tone fallback)
   - `<Play>` -- Audio file playback (URL or local file)
   - `<Gather>` -- DTMF collection with nested Say/Play prompts; posts digits to action URL
   - `<Dial>` -- Bridge to number via external profile + Kamailio
   - `<Hangup>` -- End call
   - `<Pause>` -- Sleep
   - `<Redirect>` -- Fetch new instructions from URL (up to 10 depth)
   - `<Reject>` -- Reject with reason
5. POST to status_callback URL when call ends

Uses `session:execute("curl", ...)` for HTTP requests with 5s timeout. Supports relative URL resolution against base voice_url.

### lookup_user_did.lua

**Called from default_outbound dialplan** before bridging registered user calls to PSTN.

Queries `extensions.assigned_did` for the calling extension number. Sets `effective_caller_id_number` to the user's DID so the carrier receives a valid number instead of "1001". Falls back to platform default DID `+17743260301`.

### xml_handler.lua

**Dynamic dialplan generator.** Called by FreeSWITCH when looking up dialplan (if configured). Returns a basic XML dialplan that routes everything to `inbound_router.lua`. This is a fallback mechanism; the static dialplan in `public.xml` is the primary routing path.

### channel_release.lua

**Hangup hook** for trunk calls. Called via `api_hangup_hook` channel variable.

Reads `trunk_id` and `uuid` from session/event, calls `redis.release_channel()` to remove the call UUID from the trunk's Redis sorted set (releasing the concurrent channel slot).

Tries multiple sources for variables: session -> argv -> event headers.

---

## Library Reference

### lib/db_client.lua

PostgreSQL client with connection pooling.

**Connection Management:**
- Single persistent connection per mod_lua thread (module-level `conn` variable)
- 5-minute idle timeout (`CONN_IDLE_TIMEOUT=300`)
- Reconnects on failure (tests with `SELECT 1` before reuse)
- Uses `PG_CONNSTRING` global from startup.lua
- Direct `package.loadlib()` for luasql.postgres (bypasses mod_lua path issues)

**SQL Injection Protection:**
- `escape_string()` -- doubles quotes, escapes backslashes, removes null bytes
- `sql_string()` -- wraps in quotes
- `sql_number()` -- validates as number
- `validate_did()` -- strips non-digit except +, validates 10-15 digits
- `validate_ip()` -- validates IPv4 octets 0-255

**Query Functions:**

| Function | Table(s) | Returns |
|---|---|---|
| `lookup_rcf(did)` | rcf_numbers JOIN customers | forward_to, customer_id, pass_caller_id, ring_timeout, traffic_grade, cpm_limit, daily_limit |
| `lookup_api_did(did)` | api_dids JOIN customers | voice_url, fallback_url, customer_id, traffic_grade, cpm_limit, daily_limit |
| `lookup_trunk_did(did)` | trunk_dids JOIN sip_trunks JOIN customers | trunk_id, customer_id, max_channels, traffic_grade |
| `lookup_trunk_by_ip(ip)` | trunk_auth_ips JOIN sip_trunks JOIN customers | trunk_id, customer_id, max_channels, cps_limit, traffic_grade |
| `get_trunk_endpoint_ips(trunk_id)` | trunk_auth_ips | Array of IP strings (for inbound trunk routing to customer PBX) |
| `lookup_customer(customer_id)` | customers | id, name, status, traffic_grade, cpm_limit, daily_limit, balance |
| `get_customer_tier(customer_id, tier_type)` | customers JOIN cps_tiers | tier_id, tier_name, cps_limit, monthly_fee, per_call_fee, features |
| `get_available_tiers(tier_type)` | cps_tiers | Array of tier objects sorted by sort_order |
| `lookup_extension_did(did)` | extensions | extension, customer_id, display_name |
| `lookup_did_for_extension(ext)` | extensions | assigned_did |
| `insert_cdr(cdr)` | cdrs | boolean success |

All queries filter on `enabled=true` / `status='active'`.

### lib/redis_client.lua

Redis client with connection pooling and atomic operations.

**IMPORTANT: Disabled in inbound_router.lua for RCF-V1** due to redis-lua connection pooling issues in mod_lua's threading model. Still used by trunk_outbound.lua and api_outbound.lua (which may also hit the same issues).

**Connection Management:**
- Single persistent connection per mod_lua thread
- PING health check every 30 seconds
- 3 retry attempts on connection failure with 100ms delay
- Defaults to 127.0.0.1:6379 (host networking)

**Key Functions:**

| Function | Redis Keys | Purpose |
|---|---|---|
| `velocity_check(customer_id, cpm, cph, daily, cost)` | `vel:{id}:cpm`, `spend:{id}:{date}` | Atomic CPM + daily spend check via Lua script. Returns (bool, reason, count). |
| `check_prefix(destination)` | `hrp:{prefix}` | Longest-match prefix lookup for fraud detection. Returns (is_risky, level, prefix). |
| `get_rcf_cache(did)` | `rcf:{did}` hash | Returns cached RCF routing data or nil. |
| `set_rcf_cache(did, ...)` | `rcf:{did}` hash | Caches RCF data with TTL (default 300s). Fields: forward_to, customer_id, pass_caller_id, traffic_grade, ring_timeout. |
| `acquire_channel(trunk_id, max, uuid)` | `trunk:{id}:calls` set | Atomic channel acquisition. Returns (bool, current, max). 2hr TTL. |
| `release_channel(trunk_id, uuid)` | `trunk:{id}:calls` set | Removes call from set. Returns remaining count. |
| `cps_check(id, limit, prefix)` | `cps:{prefix}:{id}` sorted set | Sliding window CPS check. 1-second window, 2s key expiry. |
| `health_check()` | -- | PING/PONG test. Returns (bool, status). |

**Fail-open policy:** All Redis operations fail open -- if Redis is unreachable, calls proceed without rate limiting.

### lib/redis_cps.lua

Tier-aware CPS (Calls Per Second) limiting.

**Tier Definitions:**

| Product | Tier | CPS Limit |
|---|---|---|
| Trunk | free | 5 |
| Trunk | paid | 10 |
| API | starter | 25 |
| API | professional | 50 |
| API | enterprise | 100 |
| API | unlimited | 9999 |

Trunk max CPS hard cap: 10. Must upgrade to API for higher.

**Key Functions:**

| Function | Purpose |
|---|---|
| `get_account_limits(account_id, type)` | Reads `account:{id}:limits` hash from Redis. Returns defaults if not found. |
| `set_account_limits(account_id, tier, cps, type)` | Provisions tier info in Redis (for admin use). |
| `cps_check(id, limit, prefix)` | Sliding window CPS check (same as redis_client but with call_id uniqueness). |
| `check_cps_with_tier(account_id, type)` | Main entry point. Gets tier limits, performs CPS check, returns result with upgrade_message if denied. |
| `should_upgrade_to_api(account_id)` | Returns true if trunk customer is at max CPS (10). |
| `get_current_cps(account_id, type)` | Monitoring: returns current CPS count without incrementing. |
| `record_call(account_id, type)` | Records a call for CPS tracking without checking limits. |

**Has its own Redis connection** (separate from redis_client.lua). Both maintain independent connection state.

---

## Database Schema Dependencies

The Lua scripts assume these PostgreSQL tables exist:

```
customers         (id, name, status, traffic_grade, cpm_limit, daily_limit, balance, trunk_tier_id, api_tier_id)
rcf_numbers       (did, forward_to, customer_id, pass_caller_id, ring_timeout, enabled)
api_dids          (did, voice_url, fallback_url, customer_id, enabled)
trunk_dids        (did, trunk_id)
sip_trunks        (id, customer_id, max_channels, cps_limit, enabled)
trunk_auth_ips    (trunk_id, ip_address, description)
extensions        (extension, customer_id, display_name, assigned_did, status)
cps_tiers         (id, name, tier_type, cps_limit, monthly_fee, per_call_fee, description, features, is_active, sort_order)
cdrs              (uuid, customer_id, product_type, trunk_id, direction, caller_id, destination, start_time, end_time, duration_ms, hangup_cause, carrier_used, traffic_grade)
```

---

## Carrier Routing Summary

| Product Type | X-Carrier Header | Bandwidth Endpoint | Failover |
|---|---|---|---|
| RCF | primary | Dallas 67.231.2.12 | secondary (LA 216.82.238.134) |
| API Calling | primary | Dallas 67.231.2.12 | secondary (LA 216.82.238.134) |
| Trunk | primary | Dallas 67.231.2.12 | secondary (LA 216.82.238.134) |

All outbound bridges: `sofia/external/{dest}@{sbc_proxy_ip}:5060` with `sip_h_X-Carrier={carrier}`. Kamailio reads X-Carrier in `route[TO_CARRIER]` to set `$rd` / `$du`.

---

## Error Handling Patterns

1. **All external calls wrapped in pcall()** -- Redis, PostgreSQL, session operations
2. **Fail-open for rate limiting** -- If Redis unreachable, calls proceed without limits
3. **Fail-closed for DID lookup** -- If DB unreachable, call gets UNALLOCATED_NUMBER
4. **lua_routed=true** -- Set when Lua finds the DID. Prevents dialplan fallback from returning 404 when the bridge fails (should be 503 instead)
5. **continue_on_fail=true** -- Allows failover bridge after primary fails
6. **hangup_after_bridge=true** -- Clean teardown when bridge ends
