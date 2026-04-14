"""
Bandwidth API Client — OAuth2 + TN Inventory
Fetches the full telephone number inventory from Bandwidth's Numbers API.
Caches results in Redis (5 min TTL) to avoid hammering the upstream.
"""
import os
import time
import logging
from typing import Optional

import httpx
import orjson

from db import redis_client as cache

logger = logging.getLogger(__name__)

# Bandwidth credentials from environment
BANDWIDTH_CLIENT_ID = os.getenv("BANDWIDTH_API_CLIENT_ID", "")
BANDWIDTH_CLIENT_SECRET = os.getenv("BANDWIDTH_API_CLIENT_SECRET", "")
BANDWIDTH_ACCOUNT_ID = os.getenv("BANDWIDTH_ACCOUNT_ID", "5006123")

TOKEN_URL = "https://id.bandwidth.com/api/v1/oauth2/token"
NUMBERS_BASE = f"https://numbers.bandwidth.com/api/v1/accounts/{BANDWIDTH_ACCOUNT_ID}"

# Redis cache key and TTL
CACHE_KEY = "bandwidth:tns"
CACHE_TTL = 300  # 5 minutes

# In-memory token cache
_token: Optional[str] = None
_token_expires_at: float = 0.0


def _credentials_configured() -> bool:
    """Return True if Bandwidth API credentials are present."""
    return bool(BANDWIDTH_CLIENT_ID and BANDWIDTH_CLIENT_SECRET)


async def _get_access_token(force_refresh: bool = False) -> str:
    """Obtain an OAuth2 access token via client_credentials grant.

    Caches the token in-memory and refreshes automatically before expiry.
    Raises RuntimeError when credentials are missing or the token request fails.
    """
    global _token, _token_expires_at

    if not _credentials_configured():
        raise RuntimeError(
            "Bandwidth API credentials not configured. "
            "Set BANDWIDTH_API_CLIENT_ID and BANDWIDTH_API_CLIENT_SECRET."
        )

    # Return cached token if still valid (with 30 s margin)
    if not force_refresh and _token and time.time() < _token_expires_at - 30:
        return _token

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            TOKEN_URL,
            data={"grant_type": "client_credentials"},
            auth=(BANDWIDTH_CLIENT_ID, BANDWIDTH_CLIENT_SECRET),
        )
        if resp.status_code != 200:
            raise RuntimeError(
                f"Bandwidth OAuth2 token request failed: {resp.status_code} {resp.text}"
            )

        body = resp.json()
        _token = body["access_token"]
        _token_expires_at = time.time() + body.get("expires_in", 3600)
        logger.info("Bandwidth OAuth2 token obtained (expires in %ds)", body.get("expires_in", 3600))
        return _token


async def _api_get(path: str, params: dict | None = None, _retried: bool = False) -> dict:
    """GET request to the Bandwidth Numbers API with automatic 401 retry."""
    token = await _get_access_token()

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f"{NUMBERS_BASE}{path}",
            params=params,
            headers={"Authorization": f"Bearer {token}"},
        )

    # Token expired — refresh once and retry
    if resp.status_code == 401 and not _retried:
        logger.warning("Bandwidth API returned 401 — refreshing token and retrying")
        await _get_access_token(force_refresh=True)
        return await _api_get(path, params=params, _retried=True)

    if resp.status_code != 200:
        raise RuntimeError(
            f"Bandwidth API error: {resp.status_code} {resp.text}"
        )

    return resp.json()


async def list_tns(page: int = 1, size: int = 500) -> dict:
    """Fetch a single page of TNs from Bandwidth."""
    return await _api_get("/tns", params={"page": page, "size": size})


async def get_all_tns() -> list[dict]:
    """Paginate through the Bandwidth TN inventory and return the full list.

    Results are cached in Redis for CACHE_TTL seconds. If the upstream is
    unreachable, stale cached data is returned when available.
    """
    # Try Redis cache first
    rc = await cache.get_client()
    cached = await rc.get(CACHE_KEY)
    if cached:
        logger.debug("Returning cached Bandwidth TN inventory")
        return orjson.loads(cached)

    try:
        all_tns: list[dict] = []
        page = 1
        size = 500

        while True:
            data = await list_tns(page=page, size=size)

            # Bandwidth wraps results in a list under a key — adapt to
            # the actual response shape.  Common patterns:
            #   { "telephoneNumbers": [...] }
            #   { "TelephoneNumbers": [...] }
            #   or the data itself is a list
            if isinstance(data, list):
                tns = data
            elif isinstance(data, dict):
                # Try common keys
                tns = (
                    data.get("telephoneNumbers")
                    or data.get("TelephoneNumbers")
                    or data.get("data")
                    or data.get("results")
                    or []
                )
            else:
                tns = []

            if not tns:
                break

            all_tns.extend(tns)

            # If we got fewer than `size`, we've reached the last page
            if len(tns) < size:
                break

            page += 1

        # Cache in Redis
        await rc.set(CACHE_KEY, orjson.dumps(all_tns).decode(), ex=CACHE_TTL)
        logger.info("Fetched %d TNs from Bandwidth and cached for %ds", len(all_tns), CACHE_TTL)
        return all_tns

    except Exception:
        # If upstream fails, try to serve stale cache (race: might have expired
        # between the check above and now, but worth the attempt)
        stale = await rc.get(CACHE_KEY)
        if stale:
            logger.warning("Bandwidth API unavailable — returning stale cached data")
            return orjson.loads(stale)
        raise


async def invalidate_cache():
    """Force-expire the cached TN inventory."""
    rc = await cache.get_client()
    await rc.delete(CACHE_KEY)
