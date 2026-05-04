"""Homer SIP capture — SIP trace search via qryn (Loki-compatible API).

Homer 10 replaces the old homer-app Go backend with qryn, which exposes
a Loki-compatible query API over ClickHouse.  heplify-server pushes SIP
data as structured log entries queryable via LogQL.

No authentication required for qryn (no more Homer 7 JWT flow).
"""
import json
import os
import logging
from datetime import datetime, timezone
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth.dependencies import require_admin

logger = logging.getLogger(__name__)

router = APIRouter()

# ---------------------------------------------------------------------------
# qryn connection
# ---------------------------------------------------------------------------
QRYN_URL = os.getenv("QRYN_URL", "http://qryn:3100")

# ---------------------------------------------------------------------------
# Canonical alias set — IP-to-name mapping for the platform
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
# Request / response models
# ---------------------------------------------------------------------------

class HomerSearchRequest(BaseModel):
    from_user: Optional[str] = None
    to_user: Optional[str] = None
    call_id: Optional[str] = None
    start_time: str   # ISO 8601 datetime
    end_time: str      # ISO 8601 datetime


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _iso_to_unix_ns(iso_str: str) -> int:
    """Convert an ISO 8601 datetime string to Unix nanoseconds for Loki."""
    dt = datetime.fromisoformat(iso_str)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1_000_000_000)


def _build_logql_query(
    from_user: Optional[str],
    to_user: Optional[str],
    call_id: Optional[str],
) -> str:
    """Build a LogQL query for SIP trace search.

    heplify-server pushes SIP data with label {type="call"} and JSON log
    lines containing from_user, to_user, callid, method, src_ip, dst_ip,
    response, and node fields.
    """
    query = '{type="call"}'
    filters: list[str] = []

    if from_user:
        val = from_user.lstrip("+")
        filters.append(f'| json | from_user=~".*{val}.*"')

    if to_user:
        val = to_user.lstrip("+")
        filters.append(f'| json | to_user=~".*{val}.*"')

    if call_id:
        filters.append(f'| json | callid="{call_id}"')

    if filters:
        query += " " + " ".join(filters)

    return query


def _parse_loki_response(loki_data: dict) -> list[dict[str, Any]]:
    """Parse a Loki query_range response into normalized SIP trace records.

    Loki response shape:
    {
        "data": {
            "result": [
                {
                    "stream": {...labels...},
                    "values": [
                        ["timestamp_ns_string", "json_log_line"],
                        ...
                    ]
                }
            ]
        }
    }
    """
    results: list[dict[str, Any]] = []

    data = loki_data.get("data", {})
    for stream in data.get("result", []):
        for ts_ns_str, log_line in stream.get("values", []):
            try:
                entry = json.loads(log_line)
            except (json.JSONDecodeError, TypeError):
                logger.warning("Failed to parse qryn log line: %.200s", log_line)
                continue

            # Convert nanosecond timestamp to ISO 8601
            try:
                ts_seconds = int(ts_ns_str) / 1_000_000_000
                ts_iso = datetime.fromtimestamp(
                    ts_seconds, tz=timezone.utc
                ).strftime("%Y-%m-%dT%H:%M:%SZ")
            except (ValueError, OSError):
                ts_iso = None

            # Extract status — could be "response" field (string or int)
            status_raw = entry.get("response") or entry.get("status")
            try:
                status = int(status_raw) if status_raw is not None else None
            except (ValueError, TypeError):
                status = None

            results.append({
                "timestamp": ts_iso,
                "from_user": entry.get("from_user", ""),
                "to_user": entry.get("to_user", ""),
                "callid": entry.get("callid", ""),
                "method": entry.get("method", ""),
                "src_ip": entry.get("src_ip", ""),
                "dst_ip": entry.get("dst_ip", ""),
                "status": status,
                "node": entry.get("node", ""),
            })

    return results


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/aliases")
async def list_aliases(admin: dict = Depends(require_admin)):
    """Return the canonical IP-to-name alias mapping.

    In Homer 10, aliases are not synced to a backend — this static list
    is used by the frontend to map IPs to human-readable names in ladder
    diagrams and trace views.
    """
    return {"aliases": CANONICAL_ALIASES}


@router.post("/search")
async def search_sip_traces(
    body: HomerSearchRequest,
    admin: dict = Depends(require_admin),
):
    """Search SIP traces via qryn's Loki-compatible query_range API.

    Builds a LogQL query from the search parameters and queries qryn.
    Returns normalized SIP trace records.
    """
    if not body.from_user and not body.to_user and not body.call_id:
        raise HTTPException(
            status_code=400,
            detail="At least one of from_user, to_user, or call_id is required",
        )

    # Build LogQL query
    logql = _build_logql_query(
        from_user=body.from_user,
        to_user=body.to_user,
        call_id=body.call_id,
    )

    # Convert timestamps to Unix nanoseconds
    try:
        start_ns = _iso_to_unix_ns(body.start_time)
        end_ns = _iso_to_unix_ns(body.end_time)
    except (ValueError, TypeError) as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid timestamp format: {exc}",
        )

    # Query qryn
    params = {
        "query": logql,
        "start": str(start_ns),
        "end": str(end_ns),
        "limit": "200",
    }

    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            resp = await client.get(
                f"{QRYN_URL}/loki/api/v1/query_range",
                params=params,
            )
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            logger.error("qryn unreachable at %s: %s", QRYN_URL, exc)
            raise HTTPException(
                status_code=503,
                detail=f"qryn unreachable at {QRYN_URL}",
            )
        except httpx.ReadTimeout as exc:
            logger.error("qryn query timed out: %s", exc)
            raise HTTPException(
                status_code=503,
                detail="qryn query timed out",
            )

    if resp.status_code != 200:
        logger.error(
            "qryn query failed: HTTP %s — %s",
            resp.status_code,
            resp.text[:500],
        )
        raise HTTPException(
            status_code=502,
            detail=f"qryn query returned HTTP {resp.status_code}",
        )

    try:
        loki_data = resp.json()
    except Exception:
        logger.error("qryn returned non-JSON response: %.500s", resp.text)
        raise HTTPException(
            status_code=502,
            detail="qryn returned non-JSON response",
        )

    traces = _parse_loki_response(loki_data)

    return {"data": traces}
