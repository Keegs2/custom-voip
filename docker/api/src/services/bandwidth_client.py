"""
Bandwidth API Client — OAuth2 + TN Inventory
Fetches the full telephone number inventory from Bandwidth's Numbers API.

The Numbers API returns XML (not JSON).  We parse with xml.etree.ElementTree
and normalize every TN to E.164 (+1NPANXXXXXX) for downstream comparison.

Caches results in Redis (5 min TTL) to avoid hammering the upstream.
"""
import os
import time
import logging
import xml.etree.ElementTree as ET
from typing import Optional
import httpx
import orjson

from db import redis_client as cache

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BANDWIDTH_CLIENT_ID = os.getenv("BANDWIDTH_API_CLIENT_ID", "")
BANDWIDTH_CLIENT_SECRET = os.getenv("BANDWIDTH_API_CLIENT_SECRET", "")

# Main account ID — the OAuth2 token is scoped to this account.
BANDWIDTH_ACCOUNT_ID = os.getenv("BANDWIDTH_ACCOUNT_ID", "9900717")
# Sub-account (site) to filter TNs — "Granite Lab" = 12455
BANDWIDTH_SITE_ID = os.getenv("BANDWIDTH_SITE_ID", "12455")

TOKEN_URL = "https://api.bandwidth.com/api/v1/oauth2/token"
NUMBERS_BASE = "https://api.bandwidth.com/api"

# Redis cache key and TTL
CACHE_KEY = "bandwidth:tns"
CACHE_TTL = 300  # 5 minutes

# In-memory token cache
_token: Optional[str] = None
_token_expires_at: float = 0.0


def _credentials_configured() -> bool:
    """Return True if Bandwidth API credentials are present."""
    return bool(BANDWIDTH_CLIENT_ID and BANDWIDTH_CLIENT_SECRET)


# ---------------------------------------------------------------------------
# Phone number normalization
# ---------------------------------------------------------------------------

def _to_e164(raw: str) -> str:
    """Convert a Bandwidth 10-digit TN to E.164 (+1NPANXXXXXX).

    Bandwidth returns bare 10-digit numbers (e.g. '6174544217').  Our DB
    stores E.164 ('+16174544217').  Handle all common formats gracefully.
    """
    digits = raw.strip().lstrip("+")
    if len(digits) == 10:
        return f"+1{digits}"
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    # Already has country code or is non-NANPA — best effort
    return f"+{digits}"


# ---------------------------------------------------------------------------
# XML parsing helpers
# ---------------------------------------------------------------------------

def _parse_tn_element(elem: ET.Element) -> dict:
    """Convert a single <TelephoneNumber> XML element to a dict.

    Returns a dict with keys matching the downstream router expectations.
    The fullNumber is normalized to E.164 for consistent comparison.
    """
    def _text(tag: str) -> str:
        child = elem.find(tag)
        return child.text.strip() if child is not None and child.text else ""

    raw_number = _text("FullNumber")
    return {
        "fullNumber": _to_e164(raw_number),
        "rawNumber": raw_number,
        "city": _text("City"),
        "state": _text("State"),
        "lata": _text("LATA"),
        "rateCenter": _text("RateCenter"),
        "tier": _text("Tier"),
        "status": _text("Status"),
        "accountId": _text("AccountId"),
        "vendorId": _text("VendorId"),
        "vendorName": _text("VendorName"),
        "lastModified": _text("LastModified"),
        "inServiceDate": _text("InServiceDate"),
    }


def _parse_tns_response(xml_bytes: bytes) -> tuple[list[dict], int, Optional[str]]:
    """Parse a TelephoneNumbersResponse XML body.

    Returns:
        (tns, total_count, next_url)
        - tns: list of parsed TN dicts
        - total_count: value of <TelephoneNumberCount>
        - next_url: the 'next' link URL if present, else None
    """
    root = ET.fromstring(xml_bytes)

    # Total count
    count_elem = root.find("TelephoneNumberCount")
    total_count = int(count_elem.text) if count_elem is not None and count_elem.text else 0

    # Parse each <TelephoneNumber>
    tns: list[dict] = []
    container = root.find("TelephoneNumbers")
    if container is not None:
        for tn_elem in container.findall("TelephoneNumber"):
            tns.append(_parse_tn_element(tn_elem))

    # Pagination: look for a <Links>/<next> URL
    next_url: Optional[str] = None
    links = root.find("Links")
    if links is not None:
        # Bandwidth uses <first>, <next>, <last> link elements
        next_elem = links.find("next")
        if next_elem is not None and next_elem.text:
            next_url = next_elem.text.strip()

    return tns, total_count, next_url


# ---------------------------------------------------------------------------
# OAuth2 token management
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Raw API request (returns bytes, NOT parsed JSON)
# ---------------------------------------------------------------------------

async def _api_get_raw(
    path: str,
    params: dict | None = None,
    _retried: bool = False,
) -> bytes:
    """GET request to the Bandwidth Numbers API.  Returns raw response bytes.

    Handles 401 by refreshing the OAuth2 token and retrying once.
    """
    token = await _get_access_token()

    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        resp = await client.get(
            f"{NUMBERS_BASE}{path}",
            params=params,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/xml",
            },
        )

    # Token expired — refresh once and retry
    if resp.status_code == 401 and not _retried:
        logger.warning("Bandwidth API returned 401 — refreshing token and retrying")
        await _get_access_token(force_refresh=True)
        return await _api_get_raw(path, params=params, _retried=True)

    if resp.status_code != 200:
        raise RuntimeError(
            f"Bandwidth API error: {resp.status_code} {resp.text}"
        )

    return resp.content


async def _api_get_url_raw(
    url: str,
    _retried: bool = False,
) -> bytes:
    """GET an absolute URL (used for pagination 'next' links)."""
    token = await _get_access_token()

    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        resp = await client.get(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/xml",
            },
        )

    if resp.status_code == 401 and not _retried:
        logger.warning("Bandwidth API returned 401 — refreshing token and retrying")
        await _get_access_token(force_refresh=True)
        return await _api_get_url_raw(url, _retried=True)

    if resp.status_code != 200:
        raise RuntimeError(
            f"Bandwidth API error: {resp.status_code} {resp.text}"
        )

    return resp.content


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def list_tns(page: int = 1, size: int = 500) -> tuple[list[dict], int, Optional[str]]:
    """Fetch a single page of TNs from Bandwidth.

    Returns (tns, total_count, next_url).
    """
    xml_bytes = await _api_get_raw("/tns", params={
        "accountId": BANDWIDTH_ACCOUNT_ID,
        "siteId": BANDWIDTH_SITE_ID,
        "page": page,
        "size": size,
    })
    return _parse_tns_response(xml_bytes)


async def get_all_tns() -> list[dict]:
    """Paginate through the Bandwidth TN inventory and return the full list.

    Each TN dict contains: fullNumber (E.164), city, state, lata, rateCenter,
    tier, status, accountId, lastModified, inServiceDate, and more.

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
        max_pages = 200  # safety limit

        while page <= max_pages:
            if page == 1:
                tns, total_count, next_url = await list_tns(page=page, size=size)
            else:
                # Use next_url if available, otherwise increment page param
                if next_url:
                    xml_bytes = await _api_get_url_raw(next_url)
                    tns, total_count, next_url = _parse_tns_response(xml_bytes)
                else:
                    tns, total_count, next_url = await list_tns(page=page, size=size)

            if not tns:
                break

            all_tns.extend(tns)
            logger.debug(
                "Page %d: got %d TNs (total so far: %d, reported total: %d)",
                page, len(tns), len(all_tns), total_count,
            )

            # If we have all TNs or this page was short, stop
            if len(all_tns) >= total_count:
                break
            if len(tns) < size:
                break
            if not next_url:
                # No next link and we haven't reached total — try next page
                page += 1
                continue

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
