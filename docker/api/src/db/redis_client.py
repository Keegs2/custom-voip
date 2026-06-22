"""
Async Redis Client
Uses redis-py async for high-performance caching and real-time data
"""
import asyncio
import os
import logging
import time
from typing import Optional
import redis.asyncio as redis

logger = logging.getLogger(__name__)

# Redis client
client: Optional[redis.Redis] = None

# Retry configuration for init_redis() — generous loop is for app STARTUP
# only (called from main.py lifespan). Request-path re-init (get_client)
# uses a single fast attempt instead.
_REDIS_INIT_RETRIES = 5
_REDIS_INIT_BACKOFF_SEC = 2

# Request-path re-init guard: when Redis is down, do not re-attempt a
# connection more than once per cooldown window, and never let concurrent
# requests stampede (single-flight via lock).
_REINIT_COOLDOWN_SEC = 60
_REINIT_CONNECT_TIMEOUT_SEC = 2
_last_reinit_attempt: float = 0.0
_reinit_lock = asyncio.Lock()


async def init_redis():
    """Initialize Redis connection with retry logic.

    Retries up to _REDIS_INIT_RETRIES times with _REDIS_INIT_BACKOFF_SEC
    seconds between attempts. This prevents the API from crashing if Redis
    on VM2 is temporarily unreachable at startup.
    """
    global client

    redis_url = os.getenv("REDIS_URL", "redis://redis:6379")

    client = redis.from_url(
        redis_url,
        encoding="utf-8",
        decode_responses=True,
        max_connections=50,
        retry_on_timeout=True,
        socket_connect_timeout=5,
        socket_timeout=5,
    )

    # Test connection with retry
    for attempt in range(1, _REDIS_INIT_RETRIES + 1):
        try:
            await client.ping()
            logger.info(f"Redis connected: {redis_url}")
            return
        except (redis.ConnectionError, redis.TimeoutError, OSError) as exc:
            if attempt == _REDIS_INIT_RETRIES:
                logger.error(
                    "Redis connection failed after %d attempts: %s",
                    _REDIS_INIT_RETRIES, exc,
                )
                # Close the failed client so convenience functions treat it
                # as unavailable rather than holding a broken handle.
                await client.close()
                client = None
                logger.warning("Continuing without Redis — all cache operations will be no-ops")
                return
            logger.warning(
                "Redis connection attempt %d/%d failed (%s), retrying in %ds...",
                attempt, _REDIS_INIT_RETRIES, exc, _REDIS_INIT_BACKOFF_SEC,
            )
            await asyncio.sleep(_REDIS_INIT_BACKOFF_SEC)


async def close_redis():
    """Close Redis connection."""
    global client
    if client:
        await client.close()
        client = None
        logger.info("Redis connection closed")


async def _try_reinit() -> None:
    """Single fast reconnect attempt for the request path.

    One attempt, short (2s) connect timeout — NOT the 5-attempt startup loop
    in init_redis(). Fail-open: leaves `client` as None on failure.
    """
    global client
    redis_url = os.getenv("REDIS_URL", "redis://redis:6379")
    candidate = redis.from_url(
        redis_url,
        encoding="utf-8",
        decode_responses=True,
        max_connections=50,
        retry_on_timeout=True,
        socket_connect_timeout=_REINIT_CONNECT_TIMEOUT_SEC,
        socket_timeout=5,
    )
    try:
        await asyncio.wait_for(candidate.ping(), timeout=_REINIT_CONNECT_TIMEOUT_SEC)
        client = candidate
        logger.info(f"Redis reconnected: {redis_url}")
    except Exception as exc:
        try:
            await candidate.close()
        except Exception:
            pass
        logger.warning(
            "Redis re-init attempt failed (%s) — next attempt in %ds, cache stays fail-open",
            str(exc) or type(exc).__name__, _REINIT_COOLDOWN_SEC,
        )


async def get_client() -> Optional[redis.Redis]:
    """Get Redis client. Returns None when Redis is unavailable.

    Non-blocking-safe for request paths: when the client is down, re-init is
    attempted at most once per _REINIT_COOLDOWN_SEC seconds, single-flight
    (concurrent callers don't stampede), with a single short connection
    attempt (~2s worst case) instead of the full startup retry loop.
    """
    global _last_reinit_attempt
    if client:
        return client
    if time.monotonic() - _last_reinit_attempt < _REINIT_COOLDOWN_SEC:
        return None
    if _reinit_lock.locked():
        # Another request is already attempting re-init — don't pile up.
        return client
    async with _reinit_lock:
        # Re-check under the lock: another caller may have just finished.
        if client:
            return client
        if time.monotonic() - _last_reinit_attempt < _REINIT_COOLDOWN_SEC:
            return None
        _last_reinit_attempt = time.monotonic()
        await _try_reinit()
    return client


# Convenience functions — all gracefully handle client is None so callers
# never crash when Redis is unavailable.

async def cache_get(key: str) -> Optional[str]:
    """Get a cached value. Returns None if Redis is unavailable."""
    if not client:
        return None
    return await client.get(key)


async def cache_set(key: str, value: str, ttl: int = 300):
    """Set a cached value with TTL. No-op if Redis is unavailable."""
    if not client:
        return
    await client.set(key, value, ex=ttl)


async def cache_delete(key: str):
    """Delete a cached value. No-op if Redis is unavailable."""
    if not client:
        return
    await client.delete(key)


async def incr_with_ttl(key: str, ttl: int = 60) -> int:
    """Increment a counter with TTL (for velocity tracking).

    Returns 0 if Redis is unavailable.
    """
    if not client:
        return 0
    pipe = client.pipeline()
    pipe.incr(key)
    pipe.expire(key, ttl)
    results = await pipe.execute()
    return results[0]


async def get_velocity(customer_id: int) -> dict:
    """Get current velocity metrics for a customer.

    Returns zeroed metrics if Redis is unavailable.
    """
    if not client:
        return {"calls_per_minute": 0, "daily_spend": 0.0}

    import datetime
    today = datetime.date.today().strftime("%Y%m%d")

    cpm_key = f"vel:{customer_id}:cpm"
    spend_key = f"spend:{customer_id}:{today}"

    pipe = client.pipeline()
    pipe.get(cpm_key)
    pipe.get(spend_key)
    results = await pipe.execute()

    return {
        "calls_per_minute": int(results[0] or 0),
        "daily_spend": float(results[1] or 0),
    }


# Calendar integration helpers (fail-open) ---------------------------------
# PKCE verifier stash (single-use) + short-lived event cache. All no-op /
# return None when Redis is unavailable so the calendar flow degrades, never
# crashes. NOTE: the PKCE nonce being single-use is a replay guard — pop() uses
# GETDEL so a verifier can only be consumed once even under concurrent callbacks.

_CAL_PKCE_TTL_SEC = 600  # 10m — matches the signed-state exp window.


async def cal_pkce_put(nonce: str, verifier: str) -> None:
    """Stash a PKCE verifier under cal:pkce:{nonce} (TTL 600s). No-op if Redis down."""
    if not client:
        return
    try:
        await client.set(f"cal:pkce:{nonce}", verifier, ex=_CAL_PKCE_TTL_SEC)
    except Exception as exc:
        logger.warning("cal_pkce_put failed (%s)", type(exc).__name__)


async def cal_pkce_pop(nonce: str) -> Optional[str]:
    """Atomically GET+DEL the PKCE verifier (single-use replay guard).

    Returns the verifier or None (missing/expired/replayed/Redis down). If Redis
    is unavailable the callback cannot validate PKCE and must fail closed — the
    router treats a None here as state_invalid.
    """
    if not client:
        return None
    try:
        # GETDEL (Redis 6.2+) is atomic single-use. Fall back to GET+DEL pipeline
        # on older servers that lack the command.
        try:
            return await client.getdel(f"cal:pkce:{nonce}")
        except Exception:
            pipe = client.pipeline()
            pipe.get(f"cal:pkce:{nonce}")
            pipe.delete(f"cal:pkce:{nonce}")
            results = await pipe.execute()
            return results[0]
    except Exception as exc:
        logger.warning("cal_pkce_pop failed (%s)", type(exc).__name__)
        return None


def _cal_cache_ttl() -> int:
    try:
        return int(os.getenv("CALENDAR_CACHE_TTL", "120"))
    except (TypeError, ValueError):
        return 120


async def cal_events_get(key: str) -> Optional[list]:
    """Read a cached events list (orjson). Returns None on miss/unavailable."""
    if not client:
        return None
    try:
        raw = await client.get(f"cal:events:{key}")
        if not raw:
            return None
        import orjson
        return orjson.loads(raw)
    except Exception as exc:
        logger.warning("cal_events_get failed (%s)", type(exc).__name__)
        return None


async def cal_events_set(key: str, events: list) -> None:
    """Cache an events list (orjson) under cal:events:{key}. No-op if Redis down."""
    if not client:
        return
    try:
        import orjson
        await client.set(f"cal:events:{key}", orjson.dumps(events), ex=_cal_cache_ttl())
    except Exception as exc:
        logger.warning("cal_events_set failed (%s)", type(exc).__name__)


async def invalidate_rcf_cache(did: str):
    """Invalidate RCF cache when config changes. No-op if Redis is unavailable."""
    if not client:
        return
    await client.delete(f"rcf:{did}")


async def invalidate_trunk_cache(ip: str):
    """Invalidate trunk IP cache when config changes. No-op if Redis is unavailable."""
    if not client:
        return
    await client.delete(f"trunk_ip:{ip}")


# CPS Tier Functions

async def sync_cps_tier_to_redis(
    customer_id: int,
    tier_type: str,
    tier_name: str,
    cps_limit: int
) -> bool:
    """Sync customer tier limits to Redis for FreeSWITCH to read.

    Key format: account:{customer_id}:limits (HASH)
    Fields: tier, cps_limit, type

    This key is read by FreeSWITCH's redis_cps.lua script to enforce
    CPS limits during call setup.

    Args:
        customer_id: The customer's database ID
        tier_type: Either 'trunk' or 'api'
        tier_name: The tier name (e.g., 'trunk_standard', 'api_basic')
        cps_limit: The CPS limit for this tier

    Returns:
        True if sync successful, False otherwise
    """
    if not client:
        logger.warning("sync_cps_tier_to_redis: Redis unavailable, skipping")
        return False

    key = f"account:{customer_id}:limits"
    try:
        await client.hset(key, mapping={
            "tier": tier_name,
            "cps_limit": str(cps_limit),
            "type": tier_type
        })
        # Set a long TTL (7 days) - will be refreshed on tier changes
        await client.expire(key, 604800)
        logger.info(f"Synced CPS tier to Redis: {key} -> {tier_name}/{cps_limit}/{tier_type}")
        return True
    except Exception as e:
        logger.error(f"Failed to sync CPS tier to Redis: {key} - {e}")
        return False


async def get_cps_tier_from_redis(customer_id: int) -> Optional[dict]:
    """Get customer tier limits from Redis.

    Returns dict with keys: tier, cps_limit, type
    Or None if not found in Redis.
    """
    if not client:
        return None

    key = f"account:{customer_id}:limits"
    try:
        result = await client.hgetall(key)
        if result:
            return {
                "tier": result.get("tier"),
                "cps_limit": int(result.get("cps_limit", 0)),
                "type": result.get("type")
            }
        return None
    except Exception as e:
        logger.error(f"Failed to get CPS tier from Redis: {key} - {e}")
        return None


async def check_cps_limit(
    customer_id: int,
    cps_limit: int,
    tier_type: str = "api"
) -> tuple[bool, int]:
    """Check if a call is allowed under CPS limits using sliding window.

    Uses a sorted set with millisecond timestamps for sliding window tracking.
    Key format: cps:{type}:{customer_id}

    Args:
        customer_id: The customer's database ID
        cps_limit: The CPS limit to check against
        tier_type: Either 'trunk' or 'api'

    Returns:
        Tuple of (allowed: bool, current_cps: int)
    """
    if not client:
        return True, 0  # Fail open when Redis is unavailable

    import time
    import uuid as uuid_module

    key = f"cps:{tier_type}:{customer_id}"
    now_ms = int(time.time() * 1000)
    window_start = now_ms - 1000  # 1 second sliding window
    call_id = f"{now_ms}:{uuid_module.uuid4().hex[:8]}"

    # Lua script for atomic CPS check using sliding window
    script = """
        local key = KEYS[1]
        local limit = tonumber(ARGV[1])
        local now = tonumber(ARGV[2])
        local window_start = now - 1000
        local call_id = ARGV[3]

        -- Remove entries outside the sliding window
        redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

        -- Count current calls in window
        local current = tonumber(redis.call('ZCARD', key) or 0)

        if current >= limit then
            -- Over limit - don't add this call
            return {0, current, limit}
        end

        -- Add this call with timestamp as score (use call_id for uniqueness)
        redis.call('ZADD', key, now, call_id)

        -- Set expiry on the key (slightly longer than window)
        redis.call('EXPIRE', key, 2)

        return {1, current + 1, limit}
    """

    try:
        result = await client.eval(
            script,
            1,  # number of keys
            key,
            str(cps_limit),
            str(now_ms),
            call_id
        )

        if isinstance(result, list) and len(result) >= 2:
            allowed = result[0] == 1
            current_cps = result[1]
            return allowed, current_cps

        return True, 0  # Fail open on unexpected result
    except Exception as e:
        logger.error(f"CPS check failed: {e}")
        return True, 0  # Fail open on error


async def get_current_cps(customer_id: int, tier_type: str = "api") -> int:
    """Get current CPS for a customer (for monitoring).

    Args:
        customer_id: The customer's database ID
        tier_type: Either 'trunk' or 'api'

    Returns:
        Current CPS count in the sliding window
    """
    if not client:
        return 0

    import time

    key = f"cps:{tier_type}:{customer_id}"
    now_ms = int(time.time() * 1000)
    window_start = now_ms - 1000

    # Lua script to clean and count
    script = """
        local key = KEYS[1]
        local window_start = tonumber(ARGV[1])

        redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)
        return redis.call('ZCARD', key)
    """

    try:
        result = await client.eval(script, 1, key, str(window_start))
        return int(result) if result else 0
    except Exception as e:
        logger.error(f"Failed to get current CPS: {e}")
        return 0


async def record_cps_hit(customer_id: int, tier_type: str = "api") -> bool:
    """Record a CPS hit without checking limits.

    Used when bypassing limit check but still want to track for metrics.

    Args:
        customer_id: The customer's database ID
        tier_type: Either 'trunk' or 'api'

    Returns:
        True if recorded successfully
    """
    if not client:
        return False

    import time
    import uuid as uuid_module

    key = f"cps:{tier_type}:{customer_id}"
    now_ms = int(time.time() * 1000)
    call_id = f"{now_ms}:{uuid_module.uuid4().hex[:8]}"

    try:
        pipe = client.pipeline()
        pipe.zadd(key, {call_id: now_ms})
        pipe.expire(key, 2)
        await pipe.execute()
        return True
    except Exception as e:
        logger.error(f"Failed to record CPS hit: {e}")
        return False
