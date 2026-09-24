"""Homer SIP capture — SIP trace search via qryn (Loki-compatible API).

Homer 10 replaces the old homer-app Go backend with qryn, which exposes
a Loki-compatible query API over ClickHouse.  heplify-server pushes SIP
data as structured log entries queryable via LogQL.

No authentication required for qryn (no more Homer 7 JWT flow).

A/B LEG CORRELATION (_correlate_legs, 2026-09 rewrite)
-----------------------------------------------------
Every forwarded call is one A leg + one B leg per carrier bridge attempt, each
with its own SIP Call-ID; the only wire link is ``X-CID: <A Call-ID>`` on each
B-leg INVITE.  heplify-server's Loki ``call_id`` label is the packet's OWN
Call-ID (no A-leg label exists), so correlation reads the header from stored
SIP text, from three deterministic, bounded sources (see homer_correlation.py
for the full rationale):

  (a) X-CID harvested from every fetched INVITE request (B -> A, no I/O);
  (b) ClickHouse samples_v3 scan limited to each A call's own setup window
      (A -> B), fingerprint -> call_id via time_series;
  (c) the ``cdrs`` B rows (A -> B cross-check, failure-isolated).

There is NO window-wide ``|~ "X-CID:"`` qryn scan and NO ">50 Call-IDs ->
skip" rule any more.  Leg fetches (by Call-ID, direct ClickHouse ``IN (...)``
— qryn's RE2 engine 500s on large Call-ID regex alternations) are chunked and
paginated; any cap that is still hit, and any failed lookup, is REPORTED via
``correlation_status`` / ``correlation_reason`` instead of silently dropping
the correlation.
"""
import asyncio
import json
import os
import logging
import re
from datetime import datetime, timezone
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from auth.dependencies import require_support_or_admin
from db import database as db
from services.stir_outcome import badge_fields as stir_badge_fields

# Pure (stdlib-only) post-processing pipeline: dedup, SIP-causality ordering,
# hairpin marking, seq assignment.  Lives in a separate module so unit tests
# can exercise it without fastapi/httpx/auth installed.  Re-imported here so
# this router's public surface is unchanged.
# Edge/internal packet classification + libpcap synthesis for GET /pcap.
# Pure stdlib module (same pattern as homer_pipeline) so the classification
# truth table and pcap byte format are unit-testable without fastapi.
from .homer_pcap import build_pcap, is_edge_packet
# Pure (stdlib-only) correlation helpers: X-CID parsing, A-leg windows, the
# ClickHouse SQL builders, grouping/attempt numbering, status bookkeeping.
from . import homer_correlation as hc

from .homer_pipeline import (
    _deduplicate_results,
    _extract_cseq,
    _extract_sip_user,
    _extract_via_branch,
    _finalize_pipeline,
    _is_directional,
    _message_identity,
    _ns_to_iso,
    normalize_number_needle,
)

logger = logging.getLogger(__name__)

router = APIRouter()

# ---------------------------------------------------------------------------
# qryn connection (LogQL queries for phone number search + X-CID discovery)
# ---------------------------------------------------------------------------
QRYN_URL = os.getenv("QRYN_URL", "http://qryn:3100")

# ---------------------------------------------------------------------------
# ClickHouse connection (direct SQL for multi-Call-ID fetch in Step 3)
# ---------------------------------------------------------------------------
# ClickHouse is on the same Docker bridge network (services-network) as the
# API container.  Port 8123 is the HTTP interface.  The default user has no
# password (configured in clickhouse-users.xml).
CLICKHOUSE_URL = os.getenv("CLICKHOUSE_URL", "http://clickhouse-server:8123")
CLICKHOUSE_DB = os.getenv("CLICKHOUSE_DB", "qryn")

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
    # ── EAST ZONE (us-east1-b) ──
    {"alias": "NLB VIP (East)", "ip": "34.24.133.82", "port": 5060},
    # Signaling ILB VIPs (active/standby, 2026-08): FS targets these for B-legs;
    # keep in sync with docker/homer/scripts/ip-alias.lua (Grafana flow panel).
    {"alias": "Signaling VIP (East)", "ip": "10.142.0.250", "port": 5060},
    {"alias": "Signaling VIP (West)", "ip": "10.138.0.250", "port": 5060},
    {"alias": "Signaling VIP (Central)", "ip": "10.128.0.250", "port": 5060},
    {"alias": "SBC-1 East", "ip": "34.74.71.32", "port": 5060},
    {"alias": "SBC-1 East (Int)", "ip": "10.142.0.100", "port": 5060},
    {"alias": "SBC-2 East", "ip": "35.243.136.35", "port": 5060},
    {"alias": "SBC-2 East (Int)", "ip": "10.142.0.101", "port": 5060},
    {"alias": "FreeSWITCH East", "ip": "192.168.10.2", "port": 5080},
    {"alias": "FreeSWITCH East (Ext)", "ip": "34.139.119.135", "port": 5080},
    {"alias": "Services East", "ip": "10.142.0.103", "port": 5432},
    {"alias": "Services East (Ext)", "ip": "34.26.57.37", "port": 9080},
    # ── WEST ZONE (us-west1) ──
    {"alias": "NLB VIP (West)", "ip": "35.252.214.40", "port": 5060},
    {"alias": "SBC-1 West", "ip": "8.229.41.59", "port": 5060},
    {"alias": "SBC-1 West (Int)", "ip": "10.138.0.100", "port": 5060},
    {"alias": "SBC-2 West", "ip": "136.117.230.166", "port": 5060},
    {"alias": "SBC-2 West (Int)", "ip": "10.138.0.101", "port": 5060},
    {"alias": "FreeSWITCH West", "ip": "192.168.20.2", "port": 5080},
    {"alias": "FreeSWITCH West (Ext)", "ip": "8.229.177.165", "port": 5080},
    {"alias": "Services West", "ip": "10.138.0.2", "port": 5432},
    # ── CENTRAL ZONE (us-central1-b) ──
    {"alias": "NLB VIP (Central)", "ip": "35.253.133.230", "port": 5060},
    {"alias": "SBC-1 Central", "ip": "34.41.188.100", "port": 5060},
    {"alias": "SBC-1 Central (Int)", "ip": "10.128.0.100", "port": 5060},
    {"alias": "SBC-2 Central", "ip": "35.184.151.64", "port": 5060},
    {"alias": "SBC-2 Central (Int)", "ip": "10.128.0.101", "port": 5060},
    {"alias": "FreeSWITCH Central", "ip": "192.168.30.2", "port": 5080},
    {"alias": "FreeSWITCH Central (Ext)", "ip": "35.253.103.114", "port": 5080},
    {"alias": "Services Central", "ip": "10.128.0.2", "port": 5432},
    {"alias": "Kamailio SBC", "ip": "0.0.0.0", "port": 5060},
]


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class HomerSearchRequest(BaseModel):
    # PRIMARY free-form number search: any format the user types —
    # "+1 (617) 454-4217", "617.454.4217", "16174544217", "6174544217", or a
    # >=3-digit partial. Normalized server-side (normalize_number_needle) to a
    # digits-only payload-substring needle; 422 if <3 digits survive.
    number: Optional[str] = None
    # Back-compat "advanced" fields — now pass through the SAME normalization
    # as `number` (422 on <3 digits). All number fields AND together.
    from_user: Optional[str] = None
    to_user: Optional[str] = None
    call_id: Optional[str] = None
    start_time: str   # ISO 8601 datetime
    end_time: str      # ISO 8601 datetime
    correlate: bool = True  # Enable A/B leg correlation
    # Cursor paging (PREFERRED by the frontend over shrinking end_time):
    # strict upper bound — only messages with timestamp_ns < before_ns are
    # fetched/returned. Page N+1 sends before_ns = page N's oldest_ts_ns.
    # Needed because end_time goes through datetime.fromisoformat, which holds
    # at most MICROSECOND precision, while stored timestamps are NANOSECOND —
    # an end_time cursor could duplicate or skip messages inside the same
    # microsecond. before_ns is exact. When absent, behavior (including
    # end_time semantics) is byte-identical to before this field existed.
    before_ns: Optional[int] = Field(default=None, gt=0)


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
    number: Optional[str] = None,
) -> str:
    """Build a LogQL query for SIP trace search.

    heplify-server pushes SIP data with these Loki labels:
      type, method, response, call_id, from, to, src_ip, dst_ip, node, etc.
    The log line is the raw SIP message text (NOT JSON).

    We use a label selector for call_id (EXACT match) and regex on the raw
    SIP payload for phone number matching (since the 'from'/'to' labels
    contain the full SIP header value, not just the user part).

    ``from_user`` / ``to_user`` / ``number`` MUST arrive already normalized
    (normalize_number_needle): digits-only needles. That is ENFORCED here
    before interpolation as defense-in-depth — a digit string is
    regex-metacharacter-free by construction, so it can neither alter the RE2
    pattern nor break out of the quoted LogQL string. Each needle becomes an
    UNANCHORED containment filter (``|~ "digits"``) matching the number
    anywhere in the message (From, To, RURI, PAI, Diversion, ...); multiple
    filters AND together.
    """
    # Start with label selectors
    label_parts = ['type="sip"']

    if call_id:
        # Loki label-matcher values are Go-style quoted strings: escape the
        # two structural characters so a hostile Call-ID can never terminate
        # the string and inject extra matchers. Real SIP Call-IDs on this
        # platform are plain word@host tokens — escaping is a no-op for them,
        # and the match stays EXACT (not substring/regex).
        escaped_cid = call_id.replace("\\", "\\\\").replace('"', '\\"')
        label_parts.append(f'call_id="{escaped_cid}"')

    query = "{" + ", ".join(label_parts) + "}"

    # Phone number search uses regex on the raw SIP payload — one containment
    # line filter per needle, ANDed by LogQL. Order is stable: from, to, number.
    line_filters: list[str] = []
    for needle in (from_user, to_user, number):
        if not needle:
            continue
        if not needle.isascii() or not needle.isdigit():
            # Upstream normalization guarantees digits-only; refuse to build
            # a query if anything else ever reaches the interpolation point.
            raise ValueError(
                "search needle must be digits-only after normalization"
            )
        line_filters.append(f'|~ "{needle}"')

    if line_filters:
        query += " " + " ".join(line_filters)

    return query


def _needle_or_422(field: str, raw: Optional[str]) -> Optional[str]:
    """Normalize one user-typed number field to a digits-only needle, or 422.

    Absent/empty fields pass through as None (not part of the search).
    Anything the user actually typed must yield >= 3 digits — the 422 detail
    names the offending field so the UI can attach the error to the right
    input (e.g. "number: need at least 3 digits").
    """
    if not raw:
        return None
    try:
        return normalize_number_needle(raw)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"{field}: {exc}")


def _parse_loki_response(loki_data: dict) -> list[dict[str, Any]]:
    """Parse a Loki query_range response into normalized SIP trace records.

    heplify-server stores SIP data with metadata in stream LABELS (not in
    the log line, which is the raw SIP message text). We read from labels.
    The ``call_id`` label is the packet's OWN Call-ID for every leg
    (FORCEALEGID=false; heplify 1.60.3 never emits an A-leg label) — leg
    correlation reads X-CID from raw_msg later (homer_correlation).

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

        for ts_ns_str, log_line in stream.get("values", []):
            # Preserve nanosecond precision for sorting (SIP message order matters)
            try:
                ts_ns = int(ts_ns_str)
                # µs precision (6 digits) in the display timestamp — ms alone
                # are insufficient when multiple messages share a millisecond.
                ts_iso = _ns_to_iso(ts_ns)
            except (ValueError, TypeError):
                ts_ns = 0
                ts_iso = None

            record: dict[str, Any] = {
                "timestamp": ts_iso,
                "timestamp_ns": ts_ns,
                "from_user": from_user,
                "to_user": to_user,
                "callid": labels.get("call_id", ""),
                "method": labels.get("method", ""),
                "cseq": _extract_cseq(log_line),
                "via_branch": _extract_via_branch(log_line),
                "src_ip": labels.get("src_ip", ""),
                "dst_ip": labels.get("dst_ip", ""),
                "src_port": labels.get("src_port", ""),
                "dst_port": labels.get("dst_port", ""),
                "status": status,
                "node": labels.get("node", ""),
                "raw_msg": log_line if log_line else None,
            }
            results.append(record)

    return results


# NOTE: _extract_sip_user / _extract_cseq / _extract_via_branch and the whole
# dedup + causality-ordering pipeline live in routers/homer_pipeline.py
# (pure stdlib, unit-testable without fastapi) and are imported above.


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/aliases")
async def list_aliases(user: dict = Depends(require_support_or_admin)):
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


async def _clickhouse_post(
    client: httpx.AsyncClient,
    sql: str,
    params: Optional[dict[str, str]] = None,
) -> str:
    """POST one SQL statement to the ClickHouse HTTP interface; return text.

    Raises HTTPException (503 unreachable / timed out, 502 non-200) — the
    same contract every ClickHouse caller in this router has always had.
    ``params`` are ClickHouse settings passed as URL parameters (e.g.
    max_execution_time) — never data.
    """
    try:
        resp = await client.post(
            CLICKHOUSE_URL,
            content=sql.encode(),
            headers={"Content-Type": "text/plain"},
            params=params or None,
        )
    except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
        logger.error("ClickHouse unreachable at %s: %s", CLICKHOUSE_URL, exc)
        raise HTTPException(
            status_code=503,
            detail=f"ClickHouse unreachable at {CLICKHOUSE_URL}",
        )
    except (httpx.ReadTimeout, httpx.WriteTimeout, httpx.PoolTimeout) as exc:
        logger.error("ClickHouse query timed out: %s", exc)
        raise HTTPException(status_code=503, detail="ClickHouse query timed out")

    if resp.status_code != 200:
        logger.error(
            "ClickHouse query failed: HTTP %s — %s",
            resp.status_code,
            resp.text[:500],
        )
        raise HTTPException(
            status_code=502,
            detail=f"ClickHouse query returned HTTP {resp.status_code}",
        )
    return resp.text


def _failure_reason(exc: BaseException) -> str:
    """Map an upstream failure to a short correlation_reason token."""
    if isinstance(exc, asyncio.TimeoutError):
        return "timeout"
    if isinstance(exc, HTTPException) and "timed out" in str(exc.detail):
        return "timeout"
    return "clickhouse_error"


async def _query_clickhouse_by_callids(
    client: httpx.AsyncClient,
    call_ids: list[str],
    start_ns: int,
    end_ns: int,
    limit: int = 2000,
) -> list[dict[str, Any]]:
    """Fetch all SIP messages for a set of Call-IDs via direct ClickHouse SQL.

    This bypasses qryn's LogQL engine entirely for the multi-Call-ID fetch.
    ClickHouse SQL ``WHERE val IN ('cid1','cid2',...)`` is indexed and handles
    hundreds of values trivially -- no regex, no RE2, no 500 errors.

    Query path:
      time_series_gin (key='call_id', val IN (...)) -> get fingerprints
      samples_v3 (fingerprint IN (...), timestamp range) -> get log entries
      time_series (fingerprint) -> get labels (method, src_ip, dst_ip, etc.)

    Returns the same record format as _parse_loki_response() for seamless
    integration with the existing deduplication and correlation logic.
    """
    if not call_ids:
        return []

    # Values are rendered with hc.ch_quote (full backslash + quote escaping
    # — the previous quote-doubling let a trailing backslash swallow the
    # closing quote) and anything that is not a printable-ASCII Call-ID is
    # skipped outright (hc.is_safe_callid): never interpolated.
    safe_cids = [c for c in call_ids if hc.is_safe_callid(c)]
    if not safe_cids:
        return []
    escaped_cids = ", ".join(hc.ch_quote(cid) for cid in safe_cids)

    # Compute the date partition filter from the timestamp range.
    # ClickHouse partitions samples_v3 by day; time_series_gin by date.
    from_date = datetime.fromtimestamp(
        start_ns / 1_000_000_000, tz=timezone.utc
    ).strftime("%Y-%m-%d")

    # qryn type constants: 1=logs, 2=metrics, 0=both.
    # SIP data is stored as type=1 (logs).  Include type=0 (both) for safety.
    #
    # CRITICAL — the time_series side of the JOIN MUST be pre-filtered by the
    # same gin fingerprint subquery.  ClickHouse hash-joins by loading the
    # ENTIRE right-hand table into memory: the previous unfiltered
    # ``INNER JOIN time_series`` shape OOM'd production at the 1.86 GiB query
    # memory limit (verified 2026-06-10 on the services VM).  Pre-filtering
    # the joined subselect with the indexed gin lookup keeps the right side
    # to the handful of fingerprints belonging to the requested Call-IDs.
    gin_subquery = f"""SELECT fingerprint
            FROM {CLICKHOUSE_DB}.time_series_gin
            WHERE key = 'call_id'
              AND val IN ({escaped_cids})
              AND date >= {hc.ch_quote(from_date)}
              AND type IN (1, 0)"""

    sql = f"""
        SELECT
            s.timestamp_ns AS timestamp_ns,
            s.string AS msg,
            ts.labels AS labels
        FROM {CLICKHOUSE_DB}.samples_v3 AS s
        INNER JOIN (
            SELECT fingerprint, labels
            FROM {CLICKHOUSE_DB}.time_series
            WHERE fingerprint IN ({gin_subquery})
        ) AS ts
            ON s.fingerprint = ts.fingerprint
        WHERE s.fingerprint IN ({gin_subquery})
          AND s.timestamp_ns >= {start_ns}
          AND s.timestamp_ns < {end_ns}
        ORDER BY s.timestamp_ns ASC
        LIMIT {limit}
        FORMAT JSONEachRow
    """

    text = await _clickhouse_post(client, sql)

    # Parse JSONEachRow response — one JSON object per line
    results: list[dict[str, Any]] = []
    for row in hc.parse_json_each_row(text):
        # Parse the labels JSON string from time_series
        try:
            labels = json.loads(row.get("labels", "{}"))
        except (json.JSONDecodeError, TypeError):
            labels = {}

        ts_ns = int(row.get("timestamp_ns", 0))
        log_line = row.get("msg", "")

        # Extract status from labels (same logic as _parse_loki_response)
        status_raw = labels.get("response")
        try:
            status = int(status_raw) if status_raw is not None else None
        except (ValueError, TypeError):
            status = None

        # Extract user parts from SIP From/To labels
        from_label = labels.get("from", "")
        to_label = labels.get("to", "")
        from_user = _extract_sip_user(from_label) if from_label else ""
        to_user = _extract_sip_user(to_label) if to_label else ""

        # Build timestamp ISO string with microsecond precision
        ts_iso = _ns_to_iso(ts_ns)

        record: dict[str, Any] = {
            "timestamp": ts_iso,
            "timestamp_ns": ts_ns,
            "from_user": from_user,
            "to_user": to_user,
            "callid": labels.get("call_id", ""),
            "method": labels.get("method", ""),
            "cseq": _extract_cseq(log_line),
            "via_branch": _extract_via_branch(log_line),
            "src_ip": labels.get("src_ip", ""),
            "dst_ip": labels.get("dst_ip", ""),
            "src_port": labels.get("src_port", ""),
            "dst_port": labels.get("dst_port", ""),
            "status": status,
            "node": labels.get("node", ""),
            "raw_msg": log_line if log_line else None,
        }
        results.append(record)

    return results


# ---------------------------------------------------------------------------
# A/B leg correlation engine (sources (a)/(b)/(c) — see homer_correlation.py)
# ---------------------------------------------------------------------------

# (b) X-CID scan: A Call-IDs per ClickHouse query (multiSearchAny needle list;
# the hard ClickHouse limit is 255) and the most A calls one request will
# correlate. Above the cap the NEWEST A calls are correlated and the rest are
# reported as cap_reached:<cap> (partial) — never silently skipped.
XCID_SCAN_CHUNK = 50
MAX_CORRELATE_A_CALLS = 200
# Fingerprints per time_series point lookup.
FINGERPRINT_CHUNK = 500
# Leg fetch (fetch-by-Call-ID): Call-IDs per query, pages per chunk, and the
# most Call-IDs one request will fetch. Chunks that fill their row limit are
# paginated (timestamp cursor) up to the page cap; beyond that the cap is
# reported as fetch_cap_reached:<limit>.
FETCH_CHUNK_CALLIDS = 25
FETCH_CHUNK_LIMIT = 2000
FETCH_MAX_PAGES = 5
MAX_FETCH_CALLIDS = 400
# Concurrent ClickHouse requests per correlation pass.
CLICKHOUSE_CONCURRENCY = 4
# Whole-(b) budget; ClickHouse-side execution cap (URL setting) per query.
XCID_SCAN_BUDGET_S = 12.0
CLICKHOUSE_MAX_EXECUTION_S = "10"
# (c) CDR cross-check: short, failure-isolated.
CDR_LOOKUP_TIMEOUT_S = 3.0
CDR_WINDOW_SLACK_NS = 60 * 1_000_000_000

_CDR_B_LEGS_SQL = """
    SELECT uuid, call_id, leg_attempt
    FROM cdrs
    WHERE leg = 'B'
      AND call_id = ANY($1::text[])
      AND start_time >= $2::timestamptz
      AND start_time < $3::timestamptz
"""


class _Correlation:
    """Mutable result of one _correlate_legs pass."""

    def __init__(self) -> None:
        self.graph = hc.LegGraph()
        self.health = hc.CorrelationHealth()
        self.rows: list[dict[str, Any]] = []


def _rows_by_callid(rows: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        cid = r.get("callid")
        if cid:
            out.setdefault(cid, []).append(r)
    return out


def _row_key(r: dict[str, Any]) -> tuple:
    return (r.get("timestamp_ns"), r.get("callid"), r.get("src_ip"),
            r.get("dst_ip"), r.get("node"), r.get("raw_msg"))


async def _fetch_legs(
    client: httpx.AsyncClient,
    call_ids: set[str],
    start_ns: int,
    end_ns: int,
    health: hc.CorrelationHealth,
    *,
    chunk_limit: Optional[int] = None,
    max_pages: Optional[int] = None,
) -> list[dict[str, Any]]:
    """Fetch every stored message for ``call_ids`` — chunked, paginated.

    Never raises: failures/caps are recorded on ``health``.  All chunks
    failing marks the correlation degraded (the ClickHouse backbone is down).
    """
    # Resolved at call time (module constants are tunable/monkeypatchable).
    chunk_limit = chunk_limit or FETCH_CHUNK_LIMIT
    max_pages = max_pages or FETCH_MAX_PAGES
    cids = sorted(c for c in call_ids if hc.is_safe_callid(c))
    if not cids:
        return []
    if len(cids) > MAX_FETCH_CALLIDS:
        health.add(f"fetch_cap_reached:{MAX_FETCH_CALLIDS}")
        health.truncated = True
        cids = cids[:MAX_FETCH_CALLIDS]
    chunks = [cids[i:i + FETCH_CHUNK_CALLIDS]
              for i in range(0, len(cids), FETCH_CHUNK_CALLIDS)]
    sem = asyncio.Semaphore(CLICKHOUSE_CONCURRENCY)

    async def one(chunk: list[str]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        seen: set[tuple] = set()
        cursor = start_ns
        for _page in range(max_pages):
            async with sem:
                page = await _query_clickhouse_by_callids(
                    client, chunk, cursor, end_ns, limit=chunk_limit)
            for r in page:
                k = _row_key(r)
                if k not in seen:
                    seen.add(k)
                    out.append(r)
            if len(page) < chunk_limit:
                return out
            last = max((r.get("timestamp_ns") or 0) for r in page)
            if last <= cursor:
                break          # a whole page shares one timestamp: cannot advance
            cursor = last      # inclusive re-read of the boundary ns, deduped above
        health.add(f"fetch_cap_reached:{chunk_limit * max_pages}")
        health.truncated = True
        return out

    results = await asyncio.gather(*(one(c) for c in chunks), return_exceptions=True)
    rows: list[dict[str, Any]] = []
    failures = 0
    for res in results:
        if isinstance(res, BaseException):
            failures += 1
            health.add(_failure_reason(res))
            logger.warning("Homer correlation: leg fetch chunk failed: %s", res)
        else:
            rows.extend(res)
    if failures and failures == len(chunks):
        health.degraded = True
    return rows


async def _xcid_scan(
    client: httpx.AsyncClient,
    windows: dict[str, tuple[int, int]],
    corr: _Correlation,
) -> None:
    """Source (b): A -> B via X-CID in samples_v3, bounded to A windows."""
    items = sorted(windows.items())
    chunks = [items[i:i + XCID_SCAN_CHUNK] for i in range(0, len(items), XCID_SCAN_CHUNK)]
    ch_params = {"max_execution_time": CLICKHOUSE_MAX_EXECUTION_S}
    sem = asyncio.Semaphore(CLICKHOUSE_CONCURRENCY)

    async def one(chunk: list[tuple[str, tuple[int, int]]]) -> list[hc.ScanHit]:
        a_ids = [a for a, _w in chunk]
        sql = hc.build_xcid_scan_sql(
            CLICKHOUSE_DB, a_ids, hc.merge_windows(w for _a, w in chunk))
        async with sem:
            text = await _clickhouse_post(client, sql, ch_params)
        if len(hc.parse_json_each_row(text)) >= hc.XCID_SCAN_ROW_LIMIT:
            corr.health.add(f"scan_cap_reached:{hc.XCID_SCAN_ROW_LIMIT}")
            corr.health.truncated = True
        return hc.parse_xcid_scan(text, set(a_ids))

    results = await asyncio.gather(*(one(c) for c in chunks), return_exceptions=True)
    hits: list[hc.ScanHit] = []
    failures = 0
    for res in results:
        if isinstance(res, BaseException):
            failures += 1
            corr.health.add(_failure_reason(res))
            logger.warning("Homer correlation: X-CID scan chunk failed: %s", res)
        else:
            hits.extend(res)
    if chunks and failures == len(chunks):
        corr.health.degraded = True
        return
    if not hits:
        return

    # fingerprint -> call_id label (authoritative identity for the fetch).
    fps = sorted({h.fingerprint for h in hits})
    fp_map: dict[int, str] = {}
    try:
        for i in range(0, len(fps), FINGERPRINT_CHUNK):
            sql = hc.build_fingerprint_labels_sql(
                CLICKHOUSE_DB, fps[i:i + FINGERPRINT_CHUNK])
            fp_map.update(hc.parse_fingerprint_labels(
                await _clickhouse_post(client, sql, ch_params)))
    except HTTPException as exc:
        # The scan already carries each hit's own Call-ID header — fall back
        # to it rather than losing the B legs.
        corr.health.add("fingerprint_map_error")
        logger.warning("Homer correlation: fingerprint map failed: %s", exc)

    for h in hits:
        b = fp_map.get(h.fingerprint) or h.hdr_callid
        if not b or b == h.xcid:
            continue
        corr.graph.add(b, h.xcid)
        prev = corr.graph.scan_first_ns.get(b)
        if h.first_ns and (prev is None or h.first_ns < prev):
            corr.graph.scan_first_ns[b] = h.first_ns


async def _cdr_b_legs(
    windows: dict[str, tuple[int, int]],
    corr: _Correlation,
) -> None:
    """Source (c): cdrs B rows for the A calls (uuid == B SIP Call-ID).

    ``cdrs.call_id`` is the A-leg channel uuid, which on this platform IS the
    inbound SIP Call-ID (internal sofia profile inbound-use-callid-as-uuid).
    Failure-isolated with a short timeout: a DB hiccup costs only the
    cross-check (correlation_reason cdr_unavailable), never the search.
    """
    a_ids = sorted(windows)
    lo = min(w[0] for w in windows.values()) - CDR_WINDOW_SLACK_NS
    hi = max(w[1] for w in windows.values()) + CDR_WINDOW_SLACK_NS
    try:
        rows = await asyncio.wait_for(
            db.fetch_all(
                _CDR_B_LEGS_SQL, a_ids,
                datetime.fromtimestamp(lo / 1e9, tz=timezone.utc),
                datetime.fromtimestamp(hi / 1e9, tz=timezone.utc),
            ),
            timeout=CDR_LOOKUP_TIMEOUT_S,
        )
    except Exception as exc:  # noqa: BLE001 — isolation is the contract
        corr.health.add("cdr_unavailable")
        logger.warning("Homer correlation: CDR B-leg lookup failed (%s: %s)",
                       type(exc).__name__, exc)
        return
    wanted = set(a_ids)
    for r in rows:
        b, a, attempt = r["uuid"], r["call_id"], r["leg_attempt"]
        if not b or a not in wanted or b == a:
            continue
        existing = corr.graph.b_to_a.get(b)
        if existing is not None and existing != a:
            # Wire evidence (X-CID) wins over the CDR row.
            logger.warning("Homer correlation: CDR maps %s -> %s but X-CID says %s",
                           b, a, existing)
            continue
        corr.graph.add(b, a)
        if attempt is not None:
            corr.graph.cdr_attempt[b] = int(attempt)


async def _correlate_legs(
    client: httpx.AsyncClient,
    seed_rows: list[dict[str, Any]],
    start_ns: int,
    end_ns: int,
    *,
    prefetched: Optional[set[str]] = None,
    chunk_limit: Optional[int] = None,
    max_pages: Optional[int] = None,
) -> _Correlation:
    """Deterministic, bounded A/B leg correlation. NEVER raises.

    1. (a) harvest X-CID from the seed INVITEs; fetch any referenced A leg we
       do not have yet (so searching the forwarded-to number pulls the A leg).
    2. A-leg setup windows from each A's own messages.
    3. (b) X-CID scan + (c) CDR cross-check, concurrently.
    4. Fetch every leg of every multi-leg call not fetched yet (this also
       re-fetches the seed legs of those calls, filling responses/BYEs a
       number-filtered seed never contains), then harvest again for attempt
       ordering.

    ``prefetched`` = Call-IDs whose FULL capture is already in ``seed_rows``
    (pcap: the requested leg) — never re-fetched.
    """
    corr = _Correlation()
    corr.rows = list(seed_rows)
    fetched: set[str] = set(prefetched or ())

    def harvest(rows: list[dict[str, Any]]) -> None:
        for b, a in hc.harvest_xcid(rows).items():
            corr.graph.add(b, a)

    try:
        harvest(corr.rows)
        by_cid = _rows_by_callid(corr.rows)

        # Step 1: A legs referenced by X-CID but absent from what we hold.
        missing_a = set(corr.graph.b_to_a.values()) - set(by_cid) - fetched
        if missing_a:
            new_rows = await _fetch_legs(
                client, missing_a, start_ns, end_ns, corr.health,
                chunk_limit=chunk_limit, max_pages=max_pages)
            fetched |= missing_a
            corr.rows.extend(new_rows)
            harvest(new_rows)
            by_cid = _rows_by_callid(corr.rows)

        # Step 2: A candidates = roots we hold messages for.
        a_ids = {corr.graph.root(c) for c in by_cid}
        windows: dict[str, tuple[int, int]] = {}
        for a in a_ids:
            if a in corr.graph.b_to_a or a not in by_cid or not hc.is_safe_callid(a):
                continue
            w = hc.a_leg_window(by_cid[a], end_ns)
            if w is not None:
                windows[a] = w
        if len(windows) > MAX_CORRELATE_A_CALLS:
            newest = sorted(windows, key=lambda a: windows[a][0], reverse=True)
            windows = {a: windows[a] for a in newest[:MAX_CORRELATE_A_CALLS]}
            corr.health.add(f"cap_reached:{MAX_CORRELATE_A_CALLS}")
            corr.health.truncated = True

        # Step 3: (b) + (c).
        if windows:
            async def scan() -> None:
                try:
                    await asyncio.wait_for(
                        _xcid_scan(client, windows, corr), XCID_SCAN_BUDGET_S)
                except asyncio.TimeoutError:
                    corr.health.add("timeout")
                    corr.health.degraded = True
            await asyncio.gather(scan(), _cdr_b_legs(windows, corr))

        # Step 4: fetch every leg of every multi-leg call not yet fetched.
        known = set(by_cid) | set(corr.graph.b_to_a) | set(corr.graph.b_to_a.values())
        groups: dict[str, set[str]] = {}
        for cid in known:
            groups.setdefault(corr.graph.root(cid), set()).add(cid)
        to_fetch = {c for g in groups.values() if len(g) > 1 for c in g} - fetched
        if to_fetch:
            new_rows = await _fetch_legs(
                client, to_fetch, start_ns, end_ns, corr.health,
                chunk_limit=chunk_limit, max_pages=max_pages)
            corr.rows.extend(new_rows)
            harvest(new_rows)
    except Exception as exc:  # noqa: BLE001 — correlation must never fail a search
        logger.exception("Homer correlation failed unexpectedly")
        corr.health.add(_failure_reason(exc))
        corr.health.degraded = True
    return corr


# ---------------------------------------------------------------------------
# STIR/SHAKEN attestation enrichment
# ---------------------------------------------------------------------------

# The exact per-call attestation fields surfaced on each returned message. This
# is the frontend column contract — keep it in sync with the SELECT below.
_ATTEST_FIELDS = (
    "signed_attestation",
    "attest_intent",
    "inbound_signed",
    "inbound_attest",
    "inbound_verstat",
    "verstat_source",
)


async def _fetch_attestations_by_callid(
    call_ids: list[str],
) -> dict[str, dict[str, Any]]:
    """Batch-fetch STIR/SHAKEN attestations for a set of SIP Call-IDs.

    ONE indexed query over the whole page's Call-IDs:
        SELECT ... FROM call_attestations WHERE sip_call_id = ANY($1::text[])
    (never per-row). ``sip_call_id`` is the INBOUND SIP Call-ID FreeSWITCH stored
    during CDR ingest — byte-identical to the ``callid`` heplify-server puts on
    each captured message (the Loki ``call_id`` label), so the equality join
    hits without any normalization. Returns a ``{sip_call_id: attestation}`` map
    containing only Call-IDs that have a row; callers treat a miss as ``null``.

    FAILURE-ISOLATED: any DB error (or an empty input) yields ``{}`` so the
    search returns its calls WITHOUT attestation rather than failing. asyncpg /
    PgBouncer: the explicit ``$1::text[]`` cast lets the batch bind work with
    ``statement_cache_size=0`` and no per-value type inference.
    """
    if not call_ids:
        return {}
    try:
        # The ACTUAL wire outcome (stir_outcome / stir_eff_actual, migration
        # 47) lives on the cdrs row; LATERAL by uuid (idx_cdrs_uuid) so the
        # badge — actual when present, else intent — ships in the same
        # object. Same shared serializer as the CDR endpoints
        # (services.stir_outcome.badge_fields).
        rows = await db.fetch_all(
            """
            SELECT ca.sip_call_id, ca.signed_attestation, ca.attest_intent,
                   ca.inbound_signed, ca.inbound_attest, ca.inbound_verstat,
                   ca.verstat_source,
                   oc.stir_outcome, oc.stir_eff_actual
            FROM call_attestations ca
            LEFT JOIN LATERAL (
                SELECT c.stir_outcome, c.stir_eff_actual FROM cdrs c
                WHERE c.uuid = ca.call_id
                ORDER BY c.start_time DESC LIMIT 1
            ) oc ON true
            WHERE ca.sip_call_id = ANY($1::text[])
            """,
            call_ids,
        )
    except Exception:
        # Never let attestation enrichment break or slow the SIP-trace search.
        logger.exception(
            "Homer search: attestation lookup failed for %d Call-IDs (ignored)",
            len(call_ids),
        )
        return {}

    out: dict[str, dict[str, Any]] = {}
    for r in rows:
        cid = r["sip_call_id"]
        if cid:
            att = {f: r[f] for f in _ATTEST_FIELDS}
            att.update(stir_badge_fields(
                r["signed_attestation"], r["stir_eff_actual"], r["stir_outcome"]))
            out[cid] = att
    return out


async def _attach_attestations(data: list[dict[str, Any]]) -> None:
    """Attach an ``attestation`` object (or ``None``) to every message in-place.

    Groups the page's messages by ``callid``, does a single batched lookup, and
    stamps each message with its call's attestation. Every message carries the
    key so the response shape is uniform: messages whose Call-ID has no stored
    attestation (signing off, legacy calls, or a lookup failure) get
    ``attestation: null``. Never raises.
    """
    call_ids = sorted({m["callid"] for m in data if m.get("callid")})
    by_callid = await _fetch_attestations_by_callid(call_ids)
    for m in data:
        m["attestation"] = by_callid.get(m.get("callid") or "")


@router.post("/search")
async def search_sip_traces(
    body: HomerSearchRequest,
    user: dict = Depends(require_support_or_admin),
):
    """Search SIP traces with A/B leg correlation.

    SEARCH INPUTS (all optional, at least one required -> 400 otherwise):
      number       free-form phone number in ANY format — "+1 (617) 454-4217",
                   "617.454.4217", "16174544217", "6174544217", or any
                   >=3-digit partial. Normalized server-side
                   (normalize_number_needle: strip non-digits; 11-digit
                   leading-1 NANP -> drop the 1) into a digits-only needle used
                   as an UNANCHORED substring regex over the raw SIP payload.
                   422 when fewer than 3 digits survive normalization.
      from_user /
      to_user      back-compat "advanced" fields; SAME normalization and 422
                   rule as `number`. Every number field contributes its own
                   LogQL line filter — AND semantics when combined.
      call_id      EXACT Loki label match (call_id="<value>"), NOT a
                   substring — the UI should send the complete SIP Call-ID
                   (== the heplify call_id label; FORCEALEGID=false, so it is
                   the real Call-ID for both legs). Combines (AND) with the
                   number filters; correlation then expands to sibling legs
                   via X-CID.

    Builds a LogQL query from the search parameters and queries qryn.
    When correlation is enabled (``correlate``, default true):

    1. Step 1 — number search (limit=INITIAL_LIMIT) via qryn LogQL finds the
       messages whose text contains the number (A and/or B legs).
    2. _correlate_legs (see module docstring / homer_correlation.py):
       (a) X-CID harvested from every fetched INVITE (B -> A; a discovered A
           leg is fetched, so searching the forwarded-to number pulls the A
           leg); (b) ClickHouse X-CID scan bounded to each A call's own setup
           window (A -> B; searching a masked caller finds its B legs);
           (c) cdrs B rows (A -> B cross-check).  NO window-wide X-CID scan,
           no Call-ID-count skip.
    3. Every leg of every multi-leg call is fetched by Call-ID via DIRECT
       ClickHouse SQL (``IN (...)`` — qryn's RE2 engine 500s on large escaped
       Call-ID alternations), chunked + paginated, so B-leg responses/BYEs a
       number-filtered Step 1 never contains are present.

    RESPONSE CONTRACT (the UI builds the SIP ladder to this — all additions
    are backward-compatible / additive):

    Top level:
      data                  [message]  — in AUTHORITATIVE display order
      correlations          {callid: [callid]}  — shape unchanged: every
                            Call-ID in data -> sorted list of its whole call
                            (A + every B attempt, itself included)
      legs                  {callid: {role: "A"|"B", a_callid: str,
                            attempt: int|null}} — every Call-ID in data. A:
                            a_callid = itself, attempt null. B: a_callid = its
                            A leg, attempt = 1-based bridge attempt (CDR
                            leg_attempt when every B of the call has one,
                            else order of first INVITE). {} when correlate is
                            false.
      correlation_status    "ok" | "partial" | "degraded" — partial: some
                            lookup failed or a cap was hit but the rest
                            worked; degraded: the ClickHouse correlation
                            backbone could not run (Step-1 data only). The
                            search itself never fails because of correlation.
      correlation_reason    str|null — comma-joined short tokens, e.g.
                            "clickhouse_error", "timeout", "cdr_unavailable",
                            "cap_reached:200", "fetch_cap_reached:10000",
                            "scan_cap_reached:5000", "fingerprint_map_error";
                            "disabled" when correlate=false (status "ok").
      pipeline_warnings     [str]      — e.g. "2 messages reordered for SIP
                            causality", "13 ingest-stamped rows detected";
                            empty list when the pipeline saw nothing unusual
      correlation_truncated true       — DEPRECATED (use correlation_status /
                            correlation_reason); only present when a
                            correlation cap was hit.
      oldest_ts_ns          int|null   — timestamp_ns of the OLDEST message
                            actually RETURNED in data (the true min over the
                            post-dedup result set); null when data is empty.
                            This is the paging cursor.
      has_more              bool       — true when the Step-1 base fetch came
                            back at exactly INITIAL_LIMIT, i.e. the window was
                            truncated by the internal cap and older data (qryn
                            returns the NEWEST entries first) exists beyond
                            what was returned. Under-limit -> false.

    CURSOR PAGING: when has_more is true, the frontend re-issues the SAME
    search with ``before_ns = oldest_ts_ns`` (strict ``timestamp_ns <
    before_ns`` bound applied to every fetch step AND to the returned set) to
    get the next-older page. before_ns is preferred over shrinking end_time
    because end_time parses through datetime.fromisoformat (microsecond
    precision at best) while timestamps are nanosecond — adjacent pages via
    before_ns share ZERO message rows by construction. NOTE the boundary is
    message-level, not call-level: a call whose messages straddle the cursor
    is split across pages (its older messages appear on the next page). That
    is intentional — the server does not re-expand calls across the boundary;
    oldest_ts_ns is always the exact min of what THIS response returned so
    the next window starts exactly there.

    Per message (in addition to the existing fields timestamp, timestamp_ns,
    from_user, to_user, callid, method, cseq, via_branch, src_ip, dst_ip,
    status, node, raw_msg — all unchanged):
      node          str  — HEP capture id(s); "100" (Kamailio) / "200"
                    (FreeSWITCH), comma-joined ("100,200") when the same wire
                    message was captured by multiple nodes
      hairpin       bool — genuine loopback wire packet (src==dst, the SBC
                    sending to itself via the NLB VIP) or an intermediate
                    re-traversal copy detected via duplicated own-Via.  KEPT
                    in data; the UI collapses/toggles them.
      ts_corrected  bool — the stored timestamp is ingest-stamped/late and
                    the message was repositioned to satisfy SIP causality;
                    the raw timestamp/timestamp_ns fields are NOT altered
      seq           int  — authoritative display order, 0..n-1, unique,
                    ascending; data is returned sorted by seq
      attestation   obj|null — the call's STIR/SHAKEN attestation, joined by
                    the message's Call-ID (== FreeSWITCH sip_call_id stored at
                    CDR ingest). Same object on EVERY message of one Call-ID;
                    null when the call has no stored attestation (signing off,
                    legacy call) or the (failure-isolated, batched) lookup
                    errored. Shape:
                      {signed_attestation, attest_intent, inbound_signed,
                       inbound_attest, inbound_verstat, verstat_source,
                       stir_attestation, stir_eff_actual, stir_outcome,
                       stir_badge, stir_badge_source}
                    The last five are the shared STIR badge payload
                    (services.stir_outcome.badge_fields): stir_badge is the
                    ACTUAL wire level (cdrs.stir_eff_actual, migration 47)
                    when Kamailio reported one, else the INTENT-derived
                    signed_attestation; stir_badge_source says which
                    ("actual" | "intent" | null).

    Display order is derived from hard SIP-causality rules (a response never
    precedes its request at the same hop; a forwarded request copy at hop N+1
    never precedes hop N; ACK never precedes the 2xx it acknowledges) with
    stored timestamps as the tiebreak — ingest-stamped rows carry timestamps
    15-20 ms late, so timestamp order alone is NOT trustworthy (see
    tests/fixtures/homer_ground_truth_20260610.md).
    """
    if (
        not body.number
        and not body.from_user
        and not body.to_user
        and not body.call_id
    ):
        raise HTTPException(
            status_code=400,
            detail="At least one of number, from_user, to_user, or call_id is required",
        )

    # Free-form number normalization is OUR job, server-side (the pinned
    # contract — see normalize_number_needle). from_user/to_user get the SAME
    # treatment: the legacy path interpolated raw user input into the LogQL
    # regex, so "(617) 454-4217" (literal parens/spaces; dots matching any
    # char) matched nothing, and "+1"/11-digit forms missed bare 10-digit
    # payload occurrences. Raises 422 (naming the field) on <3 digits.
    number_needle = _needle_or_422("number", body.number)
    from_needle = _needle_or_422("from_user", body.from_user)
    to_needle = _needle_or_422("to_user", body.to_user)

    # Build LogQL query
    logql = _build_logql_query(
        from_user=from_needle,
        to_user=to_needle,
        call_id=body.call_id,
        number=number_needle,
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

    # Cursor paging: before_ns is a STRICT upper bound (timestamp_ns <
    # before_ns). Clamping end_ns propagates the bound to every fetch step
    # (qryn Steps 1/2 and the ClickHouse Step 3, whose range predicate is
    # already exclusive: ``timestamp_ns < end_ns``); a Python-side strict
    # filter in _respond() guarantees it regardless of qryn's end-boundary
    # semantics. end_time behavior is untouched when before_ns is absent.
    if body.before_ns is not None:
        end_ns = min(end_ns, body.before_ns)
        if end_ns <= start_ns:
            # Cursor paged past the window start — nothing older can exist.
            return {
                "data": [],
                "correlations": {},
                "legs": {},
                "correlation_status": "ok",
                "correlation_reason": None,
                "pipeline_warnings": [],
                "oldest_ts_ns": None,
                "has_more": False,
            }

    # INITIAL_LIMIT (500) caps the Step-1 number search. It is ALSO the
    # guardrail for broad partial needles: a 3-digit needle like "617" can
    # match thousands of messages in a busy window, but Step 1 simply
    # truncates (has_more tells the UI to page). Correlation is bounded per A
    # call (MAX_CORRELATE_A_CALLS, windows, chunking) and every upstream query
    # carries the 15s httpx timeout. The time WINDOW span itself is
    # client-chosen and not capped server-side.
    INITIAL_LIMIT = 500

    async with httpx.AsyncClient(timeout=15.0) as client:
        # Step 1: Initial query — phone number regex match
        initial_results = await _query_qryn(
            client, logql, start_ns, end_ns, limit=INITIAL_LIMIT,
        )

        # Paging truth: qryn (Loki-compatible) defaults to direction=backward,
        # returning the NEWEST entries when the limit truncates — so a
        # full-limit Step-1 response means older data exists in the window
        # beyond what was returned, and the next page is reached by bounding
        # below this page's oldest timestamp (before_ns). Under-limit means
        # the base fetch saw the whole window. Measured PRE-dedup/PRE-filter:
        # it reflects what the store actually handed back.
        base_truncated = len(initial_results) >= INITIAL_LIMIT

        # Every return path runs the full post-processing pipeline (dedup,
        # SIP-causality ordering, hairpin marking, seq assignment) so the UI
        # receives the same per-message contract regardless of which path
        # produced the data.
        async def _respond(
            results: list,
            corr: Optional[_Correlation] = None,
            disabled: bool = False,
        ) -> dict:
            if body.before_ns is not None:
                # Belt-and-braces strict cursor bound: end_ns clamping already
                # scoped every upstream fetch, but correlation refetches merge
                # rows from multiple queries — enforce the page boundary on
                # the final set so adjacent pages can never share a row.
                results = [
                    r for r in results
                    if r.get("timestamp_ns", 0) < body.before_ns
                ]
            data, pipeline_warnings = _finalize_pipeline(results)
            # Additive: stamp each message with its call's STIR/SHAKEN
            # attestation (or null). One batched, failure-isolated lookup — it
            # never raises and never blocks the search on a DB hiccup.
            await _attach_attestations(data)
            # True min over what was RETURNED (0 = unparseable-timestamp
            # sentinel, excluded — it is not a usable cursor position).
            oldest_ts_ns = min(
                (m["timestamp_ns"] for m in data if m.get("timestamp_ns")),
                default=None,
            )
            if corr is not None:
                # Groups/legs cover exactly the Call-IDs present in data.
                correlations, legs = hc.build_groups(
                    {m["callid"] for m in data if m.get("callid")},
                    corr.graph, _rows_by_callid(data),
                )
                status, reason = corr.health.status, corr.health.reason
                truncated = corr.health.truncated
            else:
                correlations, legs = {}, {}
                status, reason = "ok", ("disabled" if disabled else None)
                truncated = False
            return {
                "data": data,
                "correlations": correlations,
                "legs": legs,
                "correlation_status": status,
                "correlation_reason": reason,
                "pipeline_warnings": pipeline_warnings,
                # Additive cursor-paging fields (always present).
                "oldest_ts_ns": oldest_ts_ns,
                "has_more": base_truncated,
                # DEPRECATED back-compat flag: only present when True.
                **({"correlation_truncated": True} if truncated else {}),
            }

        if not body.correlate:
            return await _respond(initial_results, disabled=True)
        if not initial_results:
            return await _respond(initial_results, _Correlation())

        # Steps 2-3: deterministic, bounded A/B correlation + leg fetch.
        # Never raises; failures surface as correlation_status/_reason.
        corr = await _correlate_legs(client, initial_results, start_ns, end_ns)
        return await _respond(corr.rows, corr)


# ---------------------------------------------------------------------------
# PCAP export — GET /pcap
# ---------------------------------------------------------------------------

# How far back the export looks for a Call-ID.  The contract takes no time
# window (one click from a trace row), so we scan a generous slice of the
# capture retention; the ClickHouse gin lookup is indexed by call_id, so the
# wide window costs only extra partition pruning, not a scan.
PCAP_LOOKBACK_DAYS = 30
# Row cap per the pinned contract (~2000 packets -> 413 when exceeded).
PCAP_MAX_PACKETS = 2000
# Margin around the requested leg's observed packet span for the correlated
# leg fetch.  B-legs are created strictly within the A-leg's lifetime (and an
# A leg's INVITE precedes its B legs by at most the failover loop, ~4 x 10 s);
# 5 minutes is ample slack.  The A -> B X-CID scan itself is bounded far more
# tightly, to each A call's own setup window (homer_correlation.a_leg_window).
PCAP_CORRELATION_MARGIN_NS = 300 * 1_000_000_000

# Content-Disposition filename characters we keep from the raw Call-ID.
_PCAP_FILENAME_SAFE_RE = re.compile(r"[^A-Za-z0-9._@-]")


@router.get("/pcap")
async def export_pcap(
    call_id: str = "",
    internal: bool = False,
    correlated: bool = True,
    user: dict = Depends(require_support_or_admin),
):
    """Export the captured SIP signaling for one call as a Wireshark pcap.

    PINNED CONTRACT (the UI is built against this verbatim):
      GET /v1/homer/pcap?call_id=<sip call-id>&internal=<bool, default
      false>&correlated=<bool, default true>
      * Auth: same gate as POST /search (support/admin).
      * 200: binary body, Content-Type application/vnd.tcpdump.pcap,
        Content-Disposition attachment;
        filename="sip_<sanitized-callid>[_internal].pcap" — the "_internal"
        suffix ONLY when internal=true, so the filename itself says which
        flavor a human is holding.
      * internal=false (THE DEFAULT — enforced here at the API, not just in
        the UI): EDGE packets only — signaling between our SBCs and the
        outside world (carrier PoPs, customer PBXes).  Safe to hand to
        carriers/customers: internal topology (SBC<->FS hops, private IPs,
        FS nodes) is entirely absent.  internal=true: the full capture
        through the whole network.
      * 404 with detail when the Call-ID has no stored packets at all, AND
        when edge filtering leaves zero packets (an empty-but-valid pcap is
        never returned).
      * 400 on malformed/empty call_id; 413 with detail above the
        ~2000-packet cap.
      * correlated=true also pulls EVERY correlated leg (the same A<->B
        correlation POST /search computes: the A leg and every B bridge
        attempt, whichever leg was requested).  X-Pcap-Correlation header:
        ok | partial | degraded (a failed lookup exports what was found).
      * X-Pcap-Skipped header: count of stored rows that could not be
        represented as IPv4/UDP packets (rare; e.g. IPv6 endpoints).

    Edge/internal classification and pcap synthesis live in homer_pcap.py
    (pure stdlib, truth table + byte format pinned by unit tests there).
    """
    cid = call_id.strip()
    if not cid:
        raise HTTPException(
            status_code=400,
            detail="call_id is required and must be a non-empty SIP Call-ID",
        )
    if len(cid) > 512 or any(c in cid for c in "\r\n\x00"):
        raise HTTPException(
            status_code=400,
            detail="call_id is malformed (control characters or >512 chars)",
        )

    now_ns = int(datetime.now(timezone.utc).timestamp() * 1_000_000_000)
    start_ns = now_ns - PCAP_LOOKBACK_DAYS * 86400 * 1_000_000_000
    end_ns = now_ns + 60 * 1_000_000_000  # small allowance for clock skew

    async with httpx.AsyncClient(timeout=15.0) as client:
        # Primary fetch: every stored packet for THIS Call-ID (indexed gin
        # lookup — same access pattern as /search Step 3).  limit=cap+1 so
        # cap overflow is detectable without unbounded transfer.
        rows = await _query_clickhouse_by_callids(
            client, [cid], start_ns, end_ns, limit=PCAP_MAX_PACKETS + 1,
        )
        if not rows:
            raise HTTPException(
                status_code=404,
                detail=(
                    f"no captured SIP packets found for Call-ID '{cid}' "
                    f"within the last {PCAP_LOOKBACK_DAYS} days"
                ),
            )
        if len(rows) > PCAP_MAX_PACKETS:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"capture for Call-ID '{cid}' exceeds the "
                    f"{PCAP_MAX_PACKETS}-packet export cap"
                ),
            )

        corr_status = "ok"
        if correlated:
            # SAME engine as POST /search (X-CID harvest + bounded ClickHouse
            # X-CID scan + CDR cross-check), seeded with this leg's full
            # capture: requesting an A leg pulls every B attempt, requesting
            # a B leg pulls its A leg AND the sibling attempts.  Fail-soft:
            # a failed lookup exports what was found (status in the
            # X-Pcap-Correlation header), never a 5xx.
            ts_values = [r["timestamp_ns"] for r in rows if r.get("timestamp_ns")]
            win_start = (min(ts_values) - PCAP_CORRELATION_MARGIN_NS
                         if ts_values else start_ns)
            win_end = (max(ts_values) + PCAP_CORRELATION_MARGIN_NS
                       if ts_values else end_ns)
            corr = await _correlate_legs(
                client, rows, win_start, win_end,
                prefetched={cid},
                chunk_limit=PCAP_MAX_PACKETS + 1, max_pages=1,
            )
            corr_status = corr.health.status
            if corr.health.status != "ok":
                logger.warning(
                    "pcap export: correlation for %s is %s (%s)",
                    cid, corr.health.status, corr.health.reason,
                )
            rows = corr.rows
            if len(rows) > PCAP_MAX_PACKETS:
                raise HTTPException(
                    status_code=413,
                    detail=(
                        f"capture for Call-ID '{cid}' plus correlated "
                        f"legs exceeds the {PCAP_MAX_PACKETS}-packet "
                        "export cap — retry with correlated=false to "
                        "export only this leg"
                    ),
                )

    total_stored = len(rows)
    if not internal:
        rows = [
            r for r in rows
            if is_edge_packet(r.get("src_ip") or "", r.get("dst_ip") or "")
        ]
        if not rows:
            raise HTTPException(
                status_code=404,
                detail=(
                    f"no edge packets for this call ({total_stored} internal "
                    "packets stored) — it may be on-net; retry with "
                    "internal=true"
                ),
            )

    # No dedup by design: a carrier<->SBC packet is captured only at the SBC
    # (node 100-series) so multi-node duplication is minimal, and for the
    # internal flavor the per-capture-point copies are the point.  Stored
    # timestamp order is the export order.
    rows.sort(key=lambda r: r.get("timestamp_ns") or 0)
    pcap_bytes, packet_count, skipped = build_pcap(rows)
    if packet_count == 0:
        # Contract: never return an empty-but-valid pcap.
        raise HTTPException(
            status_code=404,
            detail=(
                f"all {len(rows)} stored packets for this call were "
                "unrepresentable as IPv4/UDP (skipped) — nothing to export"
            ),
        )

    safe_cid = _PCAP_FILENAME_SAFE_RE.sub("_", cid)[:120] or "call"
    filename = f"sip_{safe_cid}{'_internal' if internal else ''}.pcap"
    return Response(
        content=pcap_bytes,
        media_type="application/vnd.tcpdump.pcap",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Pcap-Skipped": str(skipped),
            "X-Pcap-Packets": str(packet_count),
            # Additive: ok | partial | degraded (correlated=true), else ok.
            "X-Pcap-Correlation": corr_status,
        },
    )
