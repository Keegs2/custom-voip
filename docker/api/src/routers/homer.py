"""Homer SIP capture — SIP trace search via qryn (Loki-compatible API).

Homer 10 replaces the old homer-app Go backend with qryn, which exposes
a Loki-compatible query API over ClickHouse.  heplify-server pushes SIP
data as structured log entries queryable via LogQL.

No authentication required for qryn (no more Homer 7 JWT flow).

Call correlation (Step 3) queries ClickHouse directly instead of using
LogQL regex alternation.  qryn's RE2 engine crashes with 500 errors on
patterns like ``call_id=~"cid1|cid2|...|cid24"`` because SIP Call-IDs
contain characters (@, ., -) that produce complex escaped alternations.
ClickHouse SQL ``IN ('cid1','cid2',...)`` handles any number of values
trivially with a single indexed lookup.
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

# Pure (stdlib-only) post-processing pipeline: dedup, SIP-causality ordering,
# hairpin marking, seq assignment.  Lives in a separate module so unit tests
# can exercise it without fastapi/httpx/auth installed.  Re-imported here so
# this router's public surface is unchanged.
from .homer_pipeline import (
    _deduplicate_results,
    _extract_cseq,
    _extract_sip_user,
    _extract_via_branch,
    _finalize_pipeline,
    _is_directional,
    _message_identity,
    _ns_to_iso,
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


def _parse_loki_response(
    loki_data: dict,
    extract_xcid: bool = False,
) -> list[dict[str, Any]]:
    """Parse a Loki query_range response into normalized SIP trace records.

    heplify-server stores SIP data with metadata in stream LABELS (not in
    the log line, which is the raw SIP message text). We read from labels.

    When extract_xcid=True, parses the raw SIP body for X-CID headers to
    support A/B leg correlation mapping. With FORCEALEGID=false in
    heplify-server, the call_id label contains the real Call-ID for both
    A-leg and B-leg messages, so no real_callid extraction is needed.

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
    _xcid_re = re.compile(r"X-CID:\s*(.+)", re.IGNORECASE) if extract_xcid else None
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
                "status": status,
                "node": labels.get("node", ""),
                "raw_msg": log_line if log_line else None,
            }

            # Extract X-CID from raw SIP body for correlation
            if _xcid_re is not None and log_line:
                m = _xcid_re.search(log_line)
                if m:
                    record["x_cid"] = m.group(1).strip()

            results.append(record)

    return results


# NOTE: _extract_sip_user / _extract_cseq / _extract_via_branch and the whole
# dedup + causality-ordering pipeline live in routers/homer_pipeline.py
# (pure stdlib, unit-testable without fastapi) and are imported above.


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
    extract_xcid: bool = False,
) -> list[dict[str, Any]]:
    """Execute a LogQL query against qryn and return parsed results.

    When extract_xcid=True, parses X-CID headers from the raw SIP body
    to support A/B leg correlation mapping.

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

    return _parse_loki_response(loki_data, extract_xcid=extract_xcid)


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

    # Build parameterized IN clause — ClickHouse HTTP interface uses
    # query parameters for safe value injection, but for simplicity and
    # because these are Call-ID strings from our own Loki labels (not user
    # input), we use escaped string literals.  Call-IDs contain only
    # printable ASCII (alphanumeric, @, ., -, _) so single-quote escaping
    # is sufficient.
    escaped_cids = ", ".join(
        f"'{cid.replace(chr(39), chr(39)+chr(39))}'" for cid in call_ids
    )

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
              AND date >= '{from_date}'
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

    try:
        resp = await client.post(
            CLICKHOUSE_URL,
            content=sql.encode(),
            headers={"Content-Type": "text/plain"},
        )
    except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
        logger.error("ClickHouse unreachable at %s: %s", CLICKHOUSE_URL, exc)
        raise HTTPException(
            status_code=503,
            detail=f"ClickHouse unreachable at {CLICKHOUSE_URL}",
        )
    except httpx.ReadTimeout as exc:
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

    # Parse JSONEachRow response — one JSON object per line
    results: list[dict[str, Any]] = []
    for line in resp.text.strip().splitlines():
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue

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
            "status": status,
            "node": labels.get("node", ""),
            "raw_msg": log_line if log_line else None,
        }
        results.append(record)

    return results


def _extract_callids(results: list[dict[str, Any]]) -> set[str]:
    """Extract unique non-empty call_id values from parsed results."""
    return {r["callid"] for r in results if r.get("callid")}


def _build_correlations(
    known_callids: set[str],
    corr_results: list[dict[str, Any]],
) -> dict[str, list[str]]:
    """Build a correlations map from the X-CID data in correlated results.

    Each Call-ID maps to the full set of Call-IDs in its correlation group
    (including itself). Both legs of a correlated pair point to the same list.

    Uses the ``x_cid`` field extracted from B-leg SIP bodies during the
    correlation query (extract_xcid=True). The X-CID value is the A-leg
    Call-ID that the B-leg references.

    With FORCEALEGID=false in heplify-server, the call_id label contains
    the real Call-ID for both A-leg and B-leg messages, so r["callid"]
    is reliable and no real_callid workaround is needed.
    """
    # Map: B-leg Call-ID -> A-leg Call-ID (from X-CID header)
    bleg_to_aleg: dict[str, str] = {}
    for r in corr_results:
        xcid = r.get("x_cid", "")
        bleg_cid = r.get("callid", "")
        if xcid and bleg_cid and bleg_cid != xcid:
            bleg_to_aleg[bleg_cid] = xcid

    # Build correlation groups: A-leg -> set of all related Call-IDs
    groups: dict[str, set[str]] = {}
    for aleg_cid in known_callids:
        groups.setdefault(aleg_cid, set()).add(aleg_cid)

    for bleg_cid, aleg_cid in bleg_to_aleg.items():
        groups.setdefault(aleg_cid, set()).add(aleg_cid)
        groups[aleg_cid].add(bleg_cid)

    # Build the final map: every Call-ID -> sorted list of its group
    correlations: dict[str, list[str]] = {}
    for aleg_cid, group in groups.items():
        sorted_group = sorted(group)
        for cid in group:
            correlations[cid] = sorted_group

    return correlations


@router.post("/search")
async def search_sip_traces(
    body: HomerSearchRequest,
    admin: dict = Depends(require_admin),
):
    """Search SIP traces with A/B leg correlation.

    Builds a LogQL query from the search parameters and queries qryn.
    When correlation is enabled, performs A/B leg correlation in 3 steps:

    1. Initial phone number search (limit=500) via qryn LogQL finds both
       A-leg and B-leg messages where the number appears in the SIP body.
    2. Correlation query via qryn LogQL finds X-CID headers referencing
       known Call-IDs, building a map of B-leg -> A-leg relationships.
    3. Final query fetches ALL messages for ALL correlated Call-IDs using
       a DIRECT ClickHouse SQL query with an IN clause. This bypasses
       qryn's LogQL/RE2 engine entirely, avoiding the 500 errors that
       occur with regex alternation patterns containing escaped SIP
       Call-ID characters (@, ., -).

    The final query ALWAYS runs when correlations are found, even if no
    new Call-IDs were discovered. This is critical because the initial
    phone-number regex query may truncate results at the limit, missing
    some B-leg messages. The ClickHouse SQL query is precise and returns
    complete data for all legs via indexed fingerprint lookup.

    RESPONSE CONTRACT (the UI builds the SIP ladder to this — all additions
    are backward-compatible / additive):

    Top level:
      data                  [message]  — in AUTHORITATIVE display order
      correlations          {callid: [callid]}  — unchanged
      pipeline_warnings     [str]      — e.g. "2 messages reordered for SIP
                            causality", "13 ingest-stamped rows detected";
                            empty list when the pipeline saw nothing unusual
      correlation_truncated true       — only present when Step 2 truncated

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

    Display order is derived from hard SIP-causality rules (a response never
    precedes its request at the same hop; a forwarded request copy at hop N+1
    never precedes hop N; ACK never precedes the 2xx it acknowledges) with
    stored timestamps as the tiebreak — ingest-stamped rows carry timestamps
    15-20 ms late, so timestamp order alone is NOT trustworthy (see
    tests/fixtures/homer_ground_truth_20260610.md).
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

    # Limits: 500 for initial phone-number search (8 calls x ~30 msgs = 240+),
    # 1000 for the X-CID correlation query in Step 2 (it fetches EVERY X-CID
    # message in the window and filters in Python, so the default limit of 200
    # was easily truncated on busy windows -- consistent with FINAL_LIMIT),
    # 1000 for the final call_id query which fetches both legs of all calls.
    INITIAL_LIMIT = 500
    CORRELATION_LIMIT = 1000
    FINAL_LIMIT = 1000

    async with httpx.AsyncClient(timeout=15.0) as client:
        # Step 1: Initial query — phone number regex match
        initial_results = await _query_qryn(
            client, logql, start_ns, end_ns, limit=INITIAL_LIMIT,
        )

        # Every return path runs the full post-processing pipeline (dedup,
        # SIP-causality ordering, hairpin marking, seq assignment) so the UI
        # receives the same per-message contract regardless of which path
        # produced the data.
        def _respond(results: list, correlations: dict, truncated: bool = False) -> dict:
            data, pipeline_warnings = _finalize_pipeline(results)
            return {
                "data": data,
                "correlations": correlations,
                "pipeline_warnings": pipeline_warnings,
                # Additive, backward-compatible: only present when True.
                **({"correlation_truncated": True} if truncated else {}),
            }

        # If no results or correlation disabled, return immediately
        if not initial_results or not body.correlate:
            return _respond(initial_results, {})

        known_callids = _extract_callids(initial_results)

        if not known_callids or len(known_callids) > 50:
            # Too many call_ids — skip correlation to avoid excessive queries.
            # The ClickHouse IN clause can handle hundreds of values, but the
            # X-CID correlation query in Step 2 still fetches ALL X-CID messages
            # in the time window (expensive). Cap at 50 to keep Step 2 bounded.
            if len(known_callids) > 50:
                logger.info(
                    "Skipping A/B correlation: %d call_ids exceeds limit of 50",
                    len(known_callids),
                )
            return _respond(initial_results, {})

        # Step 2: Correlation — search for X-CID headers to find B-leg messages.
        # Use a simple "X-CID:" filter (not a complex regex with all Call-IDs)
        # because qryn's RE2 engine chokes on large alternation patterns with
        # escaped special characters (@, .) — returns 500 Internal Server Error.
        # We filter by specific Call-ID in Python after fetching.
        corr_query = '{type="sip"} |~ "X-CID:"'

        correlation_truncated = False
        try:
            corr_results = await _query_qryn(
                client, corr_query, start_ns, end_ns,
                limit=CORRELATION_LIMIT, extract_xcid=True,
            )
            # Truncation check BEFORE the Python-side filter: if qryn returned
            # exactly the limit, there were likely more X-CID messages in the
            # window that we never saw, so some B-leg -> A-leg mappings may be
            # missing from the correlation map.
            if len(corr_results) >= CORRELATION_LIMIT:
                correlation_truncated = True
                logger.warning(
                    "A/B correlation may be incomplete: X-CID query returned "
                    "%d results (limit=%d), correlation window truncated",
                    len(corr_results), CORRELATION_LIMIT,
                )
            # Filter to only messages whose X-CID references one of our known Call-IDs
            corr_results = [
                r for r in corr_results
                if r.get("x_cid", "") in known_callids
            ]
        except HTTPException:
            # Correlation query failed — return initial results without correlation
            logger.warning("A/B correlation query failed, returning initial results only")
            return _respond(initial_results, {})

        # Build the correlations map from X-CID data BEFORE stripping x_cid
        correlations = _build_correlations(known_callids, corr_results)

        # Strip internal correlation fields from corr_results
        for r in corr_results:
            r.pop("x_cid", None)

        # Collect any NEW call_ids discovered via correlation (B-leg IDs
        # that weren't in the initial results, e.g. due to limit truncation).
        new_callids = _extract_callids(corr_results) - known_callids

        # Check if ANY correlations were actually found (i.e., any B-leg
        # Call-ID was mapped to an A-leg Call-ID). This is the key check:
        # even when new_callids is empty (both legs already in known_callids
        # from the initial query), the initial results may be INCOMPLETE due
        # to the query limit. B-leg responses (100 Trying, 183, 200 OK from
        # carrier) don't contain the phone number, so they may have been
        # truncated. The final query uses precise call_id label selectors
        # and fetches ALL messages for all known legs.
        has_correlations = any(
            len(group) > 1 for group in correlations.values()
        )

        if not has_correlations:
            # No A/B correlation found — merge what we have and return.
            # All Call-IDs are independent calls, no B-legs to fetch.
            return _respond(
                initial_results + corr_results,
                correlations,
                truncated=correlation_truncated,
            )

        # Step 3: Final query — get ALL messages from all correlated legs.
        # Uses direct ClickHouse SQL with an IN clause instead of qryn LogQL
        # regex alternation.  SQL ``IN ('cid1','cid2',...,'cid24')`` is an
        # indexed lookup that handles any number of Call-IDs trivially.
        # This eliminates the 500 errors from qryn's RE2 engine choking on
        # large escaped alternation patterns.
        all_callids = known_callids | new_callids
        cid_list = sorted(all_callids)

        try:
            final_results = await _query_clickhouse_by_callids(
                client, cid_list, start_ns, end_ns, limit=FINAL_LIMIT,
            )
        except HTTPException:
            # ClickHouse query failed — merge initial + correlation results
            logger.warning("ClickHouse correlation query failed, returning partial results")
            return _respond(
                initial_results + corr_results,
                correlations,
                truncated=correlation_truncated,
            )

        # The final query is the definitive result set — it contains ALL
        # messages for all Call-IDs. Merge with earlier results (dedup
        # handles any overlap) to ensure nothing is lost if the final
        # query itself hit its limit.
        all_results = initial_results + corr_results + final_results
        return _respond(all_results, correlations, truncated=correlation_truncated)
