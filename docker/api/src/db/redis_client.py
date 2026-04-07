"""
Async Redis Client
Uses redis-py async for high-performance caching and real-time data
"""
import os
import logging
from typing import Optional
import redis.asyncio as redis

logger = logging.getLogger(__name__)

# Redis client
client: Optional[redis.Redis] = None


async def init_redis():
    """Initialize Redis connection."""
    global client

    redis_url = os.getenv("REDIS_URL", "redis://redis:6379")

    client = redis.from_url(
        redis_url,
        encoding="utf-8",
        decode_responses=True,
        max_connections=50,
    )

    # Test connection
    await client.ping()
    logger.info(f"Redis connected: {redis_url}")


async def close_redis():
    """Close Redis connection."""
    global client
    if client:
        await client.close()
        client = None
        logger.info("Redis connection closed")


async def get_client() -> redis.Redis:
    """Get Redis client."""
    if not client:
        await init_redis()
    return client


# Convenience functions

async def cache_get(key: str) -> Optional[str]:
    """Get a cached value."""
    return await client.get(key)


async def cache_set(key: str, value: str, ttl: int = 300):
    """Set a cached value with TTL."""
    await client.set(key, value, ex=ttl)


async def cache_delete(key: str):
    """Delete a cached value."""
    await client.delete(key)


async def incr_with_ttl(key: str, ttl: int = 60) -> int:
    """Increment a counter with TTL (for velocity tracking)."""
    pipe = client.pipeline()
    pipe.incr(key)
    pipe.expire(key, ttl)
    results = await pipe.execute()
    return results[0]


async def get_velocity(customer_id: int) -> dict:
    """Get current velocity metrics for a customer."""
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


async def invalidate_rcf_cache(did: str):
    """Invalidate RCF cache when config changes."""
    await client.delete(f"rcf:{did}")


async def invalidate_trunk_cache(ip: str):
    """Invalidate trunk IP cache when config changes."""
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
