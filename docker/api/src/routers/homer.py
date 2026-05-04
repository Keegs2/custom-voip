"""Homer SIP capture — SIP trace search via qryn (Loki-compatible API).

Homer 10 replaces the old homer-app Go backend with qryn, which exposes
a Loki-compatible query API over ClickHouse.  heplify-server pushes SIP
data as structured log entries queryable via LogQL.

No authentication required for qryn (no more Homer 7 JWT flow).
"""
import json
import os
import logging
import re
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
    correlate: bool = True  # Enable A/B leg correlation


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

    heplify-server pushes SIP data with these Loki labels:
      type, method, response, call_id, from, to, src_ip, dst_ip, node, etc.
    The log line is the raw SIP message text (NOT JSON).

    We use label selectors for call_id and regex on the raw SIP payload
    for phone number matching (since the 'from'/'to' labels contain the
    full SIP header value, not just the user part).
    """
    # Start with label selectors
    label_parts = ['type="sip"']

    if call_id:
        label_parts.append(f'call_id="{call_id}"')

    query = "{" + ", ".join(label_parts) + "}"

    # Phone number search uses regex on the raw SIP payload
    # This matches the number anywhere in the message (From, To, RURI, PAI, etc.)
    line_filters: list[str] = []

    if from_user:
        val = from_user.lstrip("+")
        line_filters.append(f'|~ "{val}"')

    if to_user:
        val = to_user.lstrip("+")
        line_filters.append(f'|~ "{val}"')

    if line_filters:
        query += " " + " ".join(line_filters)

    return query


def _parse_loki_response(loki_data: dict) -> list[dict[str, Any]]:
    """Parse a Loki query_range response into normalized SIP trace records.

    heplify-server stores SIP data with metadata in stream LABELS (not in
    the log line, which is the raw SIP message text). We read from labels.

    Loki response shape:
    {
        "data": {
            "result": [
                {
                    "stream": {
                        "type": "sip", "method": "INVITE", "response": "200",
                        "call_id": "xxx", "src_ip": "1.2.3.4", "dst_ip": "5.6.7.8",
                        "from": "<sip:user@host>", "to": "<sip:user@host>",
                        "node": "100", ...
                    },
                    "values": [
                        ["timestamp_ns_string", "raw_sip_message"],
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
        labels = stream.get("stream", {})

        # Extract status from labels
        status_raw = labels.get("response")
        try:
            status = int(status_raw) if status_raw is not None else None
        except (ValueError, TypeError):
            # response might be a method name like "INVITE" for requests
            status = None

        # Extract user parts from SIP From/To labels
        # Labels contain full header values like '<sip:+17818510289@host>;tag=xxx'
        from_label = labels.get("from", "")
        to_label = labels.get("to", "")
        from_user = _extract_sip_user(from_label)
        to_user = _extract_sip_user(to_label)

        for ts_ns_str, _log_line in stream.get("values", []):
            # Convert nanosecond timestamp to ISO 8601
            try:
                ts_seconds = int(ts_ns_str) / 1_000_000_000
                ts_iso = datetime.fromtimestamp(
                    ts_seconds, tz=timezone.utc
                ).strftime("%Y-%m-%dT%H:%M:%SZ")
            except (ValueError, OSError):
                ts_iso = None

            results.append({
                "timestamp": ts_iso,
                "from_user": from_user,
                "to_user": to_user,
                "callid": labels.get("call_id", ""),
                "method": labels.get("method", ""),
                "src_ip": labels.get("src_ip", ""),
                "dst_ip": labels.get("dst_ip", ""),
                "status": status,
                "node": labels.get("node", ""),
            })

    return results


def _extract_sip_user(header_value: str) -> str:
    """Extract the user part from a SIP From/To header value.

    Input:  '<sip:+17818510289@67.231.13.185>;tag=gK080ee17c'
    Output: '+17818510289'

    Input:  '"MALDEN MA" <sip:+17818510289@host>'
    Output: '+17818510289'
    """
    import re as _re
    match = _re.search(r"sip:([^@>]+)@", header_value)
    return match.group(1) if match else header_value


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


async def _query_qryn(
    client: httpx.AsyncClient,
    logql: str,
    start_ns: int,
    end_ns: int,
    limit: int = 200,
) -> list[dict[str, Any]]:
    """Execute a LogQL query against qryn and return parsed results.

    Raises HTTPException on connection or protocol errors.
    """
    params = {
        "query": logql,
        "start": str(start_ns),
        "end": str(end_ns),
        "limit": str(limit),
    }

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

    return _parse_loki_response(loki_data)


def _extract_callids(results: list[dict[str, Any]]) -> set[str]:
    """Extract unique non-empty call_id values from parsed results."""
    return {r["callid"] for r in results if r.get("callid")}


def _deduplicate_results(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Deduplicate results by (timestamp, callid) and sort by timestamp."""
    seen: set[tuple[str | None, str]] = set()
    deduped: list[dict[str, Any]] = []
    for r in results:
        key = (r.get("timestamp"), r.get("callid", ""))
        if key not in seen:
            seen.add(key)
            deduped.append(r)
    deduped.sort(key=lambda r: r.get("timestamp") or "")
    return deduped


@router.post("/search")
async def search_sip_traces(
    body: HomerSearchRequest,
    admin: dict = Depends(require_admin),
):
    """Search SIP traces via qryn's Loki-compatible query_range API.

    Builds a LogQL query from the search parameters and queries qryn.
    When correlation is enabled, performs two-step A/B leg correlation:
    finds initial results, discovers related call legs via X-CID headers,
    and returns all messages from all related legs.
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

    async with httpx.AsyncClient(timeout=15.0) as client:
        # Step 1: Initial query
        initial_results = await _query_qryn(client, logql, start_ns, end_ns)

        # If no results or correlation disabled, return immediately
        if not initial_results or not body.correlate:
            return {"data": initial_results}

        known_callids = _extract_callids(initial_results)

        if not known_callids or len(known_callids) > 20:
            # Too many call_ids — skip correlation to avoid huge queries
            if len(known_callids) > 20:
                logger.info(
                    "Skipping A/B correlation: %d call_ids exceeds limit of 20",
                    len(known_callids),
                )
            return {"data": initial_results}

        # Step 2: Correlation — search for X-CID headers containing our call IDs
        # This finds B-leg messages that reference our A-leg call_ids
        cid_patterns = "|".join(re.escape(cid) for cid in known_callids)
        corr_query = f'{{type="sip"}} |~ "X-CID: ({cid_patterns})"'

        try:
            corr_results = await _query_qryn(client, corr_query, start_ns, end_ns)
        except HTTPException:
            # Correlation query failed — return initial results without correlation
            logger.warning("A/B correlation query failed, returning initial results only")
            return {"data": initial_results}

        # Extract any NEW call_ids discovered from the correlated results
        new_callids = _extract_callids(corr_results) - known_callids

        if not new_callids:
            # No new legs discovered — merge what we have and return
            merged = initial_results + corr_results
            return {"data": _deduplicate_results(merged)}

        # Step 3: Final query — get ALL messages from all related legs
        all_callids = known_callids | new_callids
        cid_regex = "|".join(re.escape(cid) for cid in all_callids)
        final_query = f'{{type="sip", call_id=~"{cid_regex}"}}'

        try:
            final_results = await _query_qryn(client, final_query, start_ns, end_ns)
        except HTTPException:
            # Final query failed — merge initial + correlation results
            logger.warning("Final correlation query failed, returning partial results")
            merged = initial_results + corr_results
            return {"data": _deduplicate_results(merged)}

        # Merge all results and deduplicate
        all_results = initial_results + corr_results + final_results
        return {"data": _deduplicate_results(all_results)}
