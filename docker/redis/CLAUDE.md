# Redis — Ephemeral Cache & Velocity Engine

## Overview

Redis 7 Alpine — used for RCF DID caching, fraud velocity tracking, channel counting,
and CPS rate limiting. **All data is ephemeral** — persistence is disabled (`save ""`,
`appendonly no`). Data can be rebuilt from PostgreSQL and call state.

Runs as a sidecar on the FreeSWITCH VM. FS connects via 127.0.0.1:6379 (host networking).

## Configuration (redis.conf)

- **Max memory:** 2GB with volatile-LRU eviction
- **I/O threads:** 4 (Redis 7+ multi-threading)
- **Persistence:** DISABLED for maximum speed
- **Dangerous commands disabled:** KEYS, FLUSHALL, FLUSHDB, DEBUG (renamed to "")
- **Latency monitoring:** 10ms threshold
- **Lua script timeout:** 100ms

## Lua Scripts (scripts/)

Server-side Lua scripts for atomic operations. These run inside Redis, NOT in FreeSWITCH.

| Script | Keys/Args | Purpose |
|--------|-----------|---------|
| `velocity_check.lua` | KEYS=`customer_id` / ARGV=`cpm_limit, cph_limit, daily_limit, estimated_cost` | Atomic fraud check: CPM, CPH, daily spend limits. Increments `vel:{id}:cpm`, `vel:{id}:cph`, `spend:{id}:{date}`. Returns `{allowed, reason, current_cpm, current_spend}`. |
| `cache_rcf.lua` | KEYS=`did` / ARGV=`forward_to, customer_id, pass_caller_id, traffic_grade, ring_timeout, ttl` | RCF DID cache (5-min TTL) under `rcf:{did}` HASH. Read or write. Avoids DB hit on repeated calls to same DID. |
| `cache_trunk.lua` | KEYS=`ip_address` / ARGV=`trunk_id, customer_id, max_channels, cps_limit, traffic_grade, ttl` | Trunk config cache keyed by IP under `trunk_ip:{ip}` HASH (300s TTL). Read or write. |
| `channel_acquire.lua` | KEYS=`trunk_id` / ARGV=`max_channels, call_uuid` | Atomic channel acquire: `SADD` call UUID into `trunk:{trunk_id}:calls` SET (sized via `SCARD`). Returns `{acquired, current_channels, max_channels}`. |
| `channel_release.lua` | KEYS=`trunk_id` / ARGV=`call_uuid` | `SREM` call UUID from `trunk:{trunk_id}:calls` on hangup. Returns remaining count. |
| `cps_check.lua` | KEYS=`trunk_id` or `customer_id` / ARGV=`cps_limit, key_prefix` | Calls-per-second sliding window over a SORTED SET `cps:{prefix}:{id}`. `key_prefix` is `'trunk'` or `'customer'` (default `'trunk'`). Returns `{allowed, current_cps}`. |
| `spend_adjust.lua` | KEYS=`customer_id` / ARGV=`actual_cost, estimated_cost` | Adjust daily spend counter after call completes (replace estimate with actual). |
| `prefix_check.lua` | KEYS=`destination` | Longest-match check of destination against high-risk prefix cache `hrp:{prefix}`. Returns `{matched, risk_level, prefix}`. |

## Key Patterns

```
rcf:{did}                  → HASH {forward_to, customer_id, pass_caller_id, ...}  TTL 300s
trunk_ip:{ip}              → HASH {trunk_id, customer_id, max_channels,           TTL 300s
                                    cps_limit, traffic_grade}
                             (keyed by source IP, NOT trunk_id — for SIP auth)
vel:{customer_id}:cpm      → INT (calls this minute)                               TTL 60s
vel:{customer_id}:cph      → INT (calls this hour)                                 TTL 3600s
spend:{customer_id}:{date} → FLOAT (daily spend accumulator)                       TTL 86400s
trunk:{trunk_id}:calls     → SET of active call UUIDs (SADD/SREM/SCARD)            TTL 7200s
                             channel count = SCARD; cap = trunk max_channels
cps:{prefix}:{id}          → SORTED SET sliding window (ZADD/ZCARD/               TTL 2s
                             ZREMRANGEBYSCORE); prefix ∈ {trunk, customer}
                             e.g. cps:customer:{customer_id}, cps:trunk:{trunk_id}
hrp:{prefix}               → STRING risk_level (high-risk-prefix cache,           (TTL per seed)
                             longest-match lookup by prefix_check.lua)
```

Notes on what changed from older docs:
- Trunk config is cached under `trunk_ip:{ip}` (a HASH keyed by the source IP for fast SIP auth), not `trunk:{trunk_id}`.
- Channel tracking is a SET of call UUIDs (`trunk:{trunk_id}:calls`) sized via `SCARD` with a 7200s safety TTL — not an integer counter like `ch:{trunk_id}`.
- CPS is a per-`{prefix}:{id}` SORTED SET sliding window (`cps:{trunk|customer}:{id}`), not an int-per-second key.

## Multi-Zone Design

Each zone has its own Redis on the local FreeSWITCH VM. No cross-zone Redis sharing.

- **Cache misses** fall through to the local PostgreSQL replica
- **Velocity counters** are zone-local (slightly less accurate if calls split across zones)
- **Channel counts** are zone-local per FreeSWITCH instance

## Port Mapping

- **Production (multi-VM):** Redis on 6379, FS on host network connects to 127.0.0.1:6379
- **Local dev (single-VM):** Redis container maps to **6380** on host (`REDIS_PORT=6380` in compose), because FS also on host might conflict

## Failure Mode

If Redis is unreachable, FreeSWITCH Lua scripts fail open:
- DID cache miss → falls through to PostgreSQL (adds ~5-10ms)
- Velocity check skip → calls proceed without rate limiting
- No calls are dropped due to Redis failure
