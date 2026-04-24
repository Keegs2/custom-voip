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
| `velocity_check.lua` | `customer_id` / `cpm_limit, cph_limit, daily_limit, cost` | Atomic fraud check: CPM, CPH, daily spend limits. Returns `{allowed, reason, current_cpm, current_spend}`. |
| `cache_rcf.lua` | `did` / `forward_to, customer_id, pass_caller_id, traffic_grade, ring_timeout, ttl` | RCF DID cache (5-min TTL). Read or write. Avoids DB hit on repeated calls to same DID. |
| `cache_trunk.lua` | Similar to cache_rcf | Trunk config cache for SIP trunk customers. |
| `channel_acquire.lua` | `trunk_id` / `max_channels` | Atomic channel count increment. Returns `{allowed, current_count}`. Prevents exceeding trunk max_channels. |
| `channel_release.lua` | `trunk_id` | Decrement channel count on call hangup. |
| `cps_check.lua` | `customer_id` / `cps_limit` | Calls-per-second rate limiting using sliding window. |
| `spend_adjust.lua` | `customer_id` / `actual_cost, estimated_cost` | Adjust daily spend counter after call completes (replace estimate with actual). |
| `prefix_check.lua` | `destination` | Check destination against high-risk prefix cache. |

## Key Patterns

```
rcf:{did}                  → HASH {forward_to, customer_id, pass_caller_id, ...}  TTL 300s
trunk:{trunk_id}           → HASH {customer_id, max_channels, cps_limit, ...}     TTL 300s
vel:{customer_id}:cpm      → INT (calls this minute)                               TTL 60s
vel:{customer_id}:cph      → INT (calls this hour)                                 TTL 3600s
spend:{customer_id}:{date} → FLOAT (daily spend accumulator)                       TTL 86400s
ch:{trunk_id}              → INT (active channel count)                            No TTL
cps:{customer_id}:{second} → INT (calls this second)                               TTL 2s
```

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
