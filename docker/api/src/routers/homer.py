"""Homer SIP capture alias management (admin only).

Syncs IP-to-name aliases into Homer's REST API so ladder diagrams
show human-readable labels instead of raw IPs.
"""
import os
import logging
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException

from auth.dependencies import require_admin

logger = logging.getLogger(__name__)

router = APIRouter()

# ---------------------------------------------------------------------------
# Homer connection settings
# ---------------------------------------------------------------------------
HOMER_URL = os.getenv("HOMER_URL", "http://homer-webapp:9080")
HOMER_USER = os.getenv("HOMER_USER", "admin")
HOMER_PASS = os.getenv("HOMER_PASS", "sipcapture")

# Homer 7 has two possible API mount points for aliases.  We try both.
ALIAS_PATHS = ["/api/v3/mapping/alias", "/api/v3/alias"]

# ---------------------------------------------------------------------------
# Canonical alias set — the single source of truth for the platform
# ---------------------------------------------------------------------------
CANONICAL_ALIASES: list[dict[str, Any]] = [
    # Bandwidth TC4 - GraniteTelecommunicationsLLC_03
    {"alias": "Bandwidth TC4 (DAL)", "ip": "67.231.2.12", "port": 5060},
    {"alias": "Bandwidth TC4 (LA)", "ip": "216.82.238.134", "port": 5060},
    # Bandwidth TC1 - GraniteTelecommunicationsLLC_01 (Default)
    {"alias": "Bandwidth TC1 (NY)", "ip": "67.231.9.142", "port": 5060},
    {"alias": "Bandwidth TC1 (ATL)", "ip": "67.231.13.185", "port": 5060},
    # Bandwidth TC2 - GraniteTelecommunicationsLLC_02
    {"alias": "Bandwidth TC2 (DAL)", "ip": "67.231.1.188", "port": 5060},
    {"alias": "Bandwidth TC2 (LA)", "ip": "67.231.4.138", "port": 5060},
    {"alias": "NLB VIP (East)", "ip": "34.24.133.82", "port": 5060},
    {"alias": "SBC-1 East", "ip": "34.74.71.32", "port": 5060},
    {"alias": "SBC-1 East (Int)", "ip": "10.142.0.100", "port": 5060},
    {"alias": "SBC-2 East", "ip": "35.243.136.35", "port": 5060},
    {"alias": "SBC-2 East (Int)", "ip": "10.142.0.101", "port": 5060},
    {"alias": "FreeSWITCH East", "ip": "192.168.10.2", "port": 5080},
    {"alias": "FreeSWITCH East (Ext)", "ip": "34.139.119.135", "port": 5080},
    {"alias": "Services East", "ip": "10.142.0.103", "port": 5432},
    {"alias": "Services East (Ext)", "ip": "34.26.57.37", "port": 9080},
    {"alias": "Kamailio SBC", "ip": "0.0.0.0", "port": 5060},
]


# ---------------------------------------------------------------------------
# Homer HTTP helpers
# ---------------------------------------------------------------------------

async def _homer_auth(client: httpx.AsyncClient) -> str:
    """Authenticate to Homer and return a JWT token.

    Raises HTTPException(503) if Homer is unreachable or auth fails.
    """
    try:
        resp = await client.post(
            f"{HOMER_URL}/api/v3/auth",
            json={"username": HOMER_USER, "password": HOMER_PASS},
        )
    except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
        logger.error("Homer unreachable at %s: %s", HOMER_URL, exc)
        raise HTTPException(status_code=503, detail=f"Homer unreachable at {HOMER_URL}")

    if resp.status_code != 200:
        logger.error("Homer auth failed: %s %s", resp.status_code, resp.text)
        raise HTTPException(
            status_code=503,
            detail=f"Homer auth failed (HTTP {resp.status_code})",
        )

    data = resp.json()
    token = data.get("token") or data.get("data", {}).get("token")
    if not token:
        logger.error("Homer auth response missing token: %s", data)
        raise HTTPException(status_code=503, detail="Homer auth response missing token")

    return token


async def _homer_request(
    client: httpx.AsyncClient,
    method: str,
    path: str,
    token: str,
    **kwargs: Any,
) -> httpx.Response | None:
    """Send a request to Homer, trying both alias API paths if needed.

    Returns the first successful response, or None if both paths fail
    with 404.  Re-raises connection errors as HTTPException(503).
    """
    headers = {"Authorization": f"Bearer {token}"}

    for base_path in ALIAS_PATHS:
        url = f"{HOMER_URL}{base_path}{path}"
        try:
            resp = await client.request(method, url, headers=headers, **kwargs)
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            logger.error("Homer unreachable: %s", exc)
            raise HTTPException(status_code=503, detail=f"Homer unreachable at {HOMER_URL}")

        # 404 means this mount point doesn't exist — try the other one
        if resp.status_code == 404:
            continue

        return resp

    # Both paths returned 404
    return None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/aliases")
async def list_aliases(admin: dict = Depends(require_admin)):
    """List current Homer aliases (proxy to Homer GET)."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        token = await _homer_auth(client)
        resp = await _homer_request(client, "GET", "", token)

    if resp is None:
        raise HTTPException(status_code=503, detail="Homer alias endpoint not found at either API path")

    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Homer returned HTTP {resp.status_code}: {resp.text[:500]}",
        )

    return resp.json()


@router.post("/aliases/sync")
async def sync_aliases(admin: dict = Depends(require_admin)):
    """Idempotent sync: delete all Homer aliases, then create the canonical set.

    Returns the list of aliases created and any errors encountered.
    """
    created: list[dict[str, Any]] = []
    errors: list[str] = []

    async with httpx.AsyncClient(timeout=15.0) as client:
        token = await _homer_auth(client)

        # --- 1. Fetch existing aliases so we can delete them ---------------
        resp = await _homer_request(client, "GET", "", token)

        if resp is None:
            raise HTTPException(
                status_code=503,
                detail="Homer alias endpoint not found at either API path",
            )

        if resp.status_code == 200:
            body = resp.json()
            # Homer wraps the list under "data" in some versions
            existing = body if isinstance(body, list) else body.get("data", [])

            for alias_rec in existing:
                alias_id = alias_rec.get("id")
                if alias_id is None:
                    continue
                del_resp = await _homer_request(
                    client, "DELETE", f"/{alias_id}", token,
                )
                if del_resp is None or del_resp.status_code not in (200, 204):
                    status = del_resp.status_code if del_resp else "no endpoint"
                    msg = f"Failed to delete alias id={alias_id}: HTTP {status}"
                    logger.warning(msg)
                    errors.append(msg)
                else:
                    logger.info("Deleted Homer alias id=%s", alias_id)
        else:
            msg = f"Failed to list existing aliases: HTTP {resp.status_code}"
            logger.warning(msg)
            errors.append(msg)

        # --- 2. Create the canonical aliases --------------------------------
        for alias_def in CANONICAL_ALIASES:
            payload = {
                "alias": alias_def["alias"],
                "ip": alias_def["ip"],
                "port": alias_def["port"],
                "mask": 32,
                "captureID": "0",
                "status": True,
            }

            create_resp = await _homer_request(
                client, "POST", "", token, json=payload,
            )

            if create_resp is None:
                msg = f"Failed to create alias '{alias_def['alias']}': no endpoint"
                logger.error(msg)
                errors.append(msg)
                continue

            if create_resp.status_code in (200, 201):
                created.append(alias_def)
                logger.info(
                    "Created Homer alias: %s -> %s:%s",
                    alias_def["alias"],
                    alias_def["ip"],
                    alias_def["port"],
                )
            else:
                msg = (
                    f"Failed to create alias '{alias_def['alias']}': "
                    f"HTTP {create_resp.status_code}"
                )
                logger.warning(msg)
                errors.append(msg)

    logger.info(
        "Homer alias sync complete: %d created, %d errors",
        len(created),
        len(errors),
    )

    return {
        "synced": len(created),
        "total": len(CANONICAL_ALIASES),
        "aliases": created,
        "errors": errors,
    }
