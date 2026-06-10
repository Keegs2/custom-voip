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
                ts_seconds = ts_ns / 1_000_000_000
                # Include microseconds (6 digits) in the display timestamp
                # for correct SIP message ordering — milliseconds alone are
                # insufficient when multiple messages arrive in the same ms
                ts_iso = datetime.fromtimestamp(
                    ts_seconds, tz=timezone.utc
                ).strftime("%Y-%m-%dT%H:%M:%S.") + f"{int((ts_ns % 1_000_000_000) / 1_000):06d}Z"
            except (ValueError, OSError):
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


_CSEQ_RE = re.compile(r"^CSeq:\s*(\d+)\s+(\w+)", re.IGNORECASE | re.MULTILINE)


def _extract_cseq(raw_msg: Optional[str]) -> str:
    """Extract the CSeq value (e.g. ``1 INVITE``) from a raw SIP message.

    CSeq is mandatory in every SIP message (RFC 3261 §8.1.1.5), so it is a
    reliable component of the per-message identity used by deduplication.
    Returns an empty string when the message is absent or unparseable.

    Input:  'CSeq: 102 INVITE\\r\\n'
    Output: '102 INVITE'
    """
    if not raw_msg:
        return ""
    m = _CSEQ_RE.search(raw_msg)
    return f"{m.group(1)} {m.group(2).upper()}" if m else ""


# Matches the FIRST (topmost) Via / v header line.  SIP allows the compact
# form ``v:`` and header names are case-insensitive (RFC 3261 §7.3.3).  We
# capture the header value up to the end of the (possibly line-folded) header
# so a ``branch=`` param wrapped onto a continuation line is still found.
_VIA_RE = re.compile(
    r"^(?:Via|v)\s*:(?P<value>.*(?:\r?\n[ \t].*)*)",
    re.IGNORECASE | re.MULTILINE,
)
# The branch param within a Via value.  Per RFC 3261 the param name is
# case-insensitive; the token runs until the next param/comma/whitespace.
_VIA_BRANCH_RE = re.compile(r";\s*branch\s*=\s*([^;,\s]+)", re.IGNORECASE)


def _extract_via_branch(raw_msg: Optional[str]) -> str:
    """Extract the ``branch`` param of the TOPMOST Via header.

    The topmost Via branch is the per-HOP fingerprint of a SIP transaction:
    every proxy that forwards a request pushes its own Via (with a fresh
    ``branch=z9hG4bK...``) onto the top of the stack, and responses echo the
    request's Via stack so the topmost branch on the way back identifies the
    same hop.  It is therefore:

      * UNIQUE per proxy hop (BW→SBC, SBC→FS, FS→SBC, SBC→carrier each differ),
        so distinct hops of one logical request are never collapsed; AND
      * IDENTICAL when the same on-wire message is HEP-captured at both the
        sender (egress) and receiver (ingress), so those genuine duplicates
        still merge.

    Handles the compact ``v:`` form, case-insensitive header name, and a
    ``branch=`` param folded onto a Via line continuation.  Returns "" when no
    topmost Via branch can be parsed (the caller falls back to a src/dst/ts
    identity so the hop is never silently dropped).

    Input:  'Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-abc;rport\\r\\n'
    Output: 'z9hG4bK-abc'
    """
    if not raw_msg:
        return ""
    via = _VIA_RE.search(raw_msg)
    if not via:
        return ""
    m = _VIA_BRANCH_RE.search(via.group("value"))
    return m.group(1).strip() if m else ""


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
    sql = f"""
        SELECT
            s.timestamp_ns AS timestamp_ns,
            s.string AS msg,
            ts.labels AS labels
        FROM {CLICKHOUSE_DB}.samples_v3 AS s
        INNER JOIN {CLICKHOUSE_DB}.time_series AS ts
            ON s.fingerprint = ts.fingerprint
        WHERE s.fingerprint IN (
            SELECT fingerprint
            FROM {CLICKHOUSE_DB}.time_series_gin
            WHERE key = 'call_id'
              AND val IN ({escaped_cids})
              AND date >= '{from_date}'
              AND type IN (1, 0)
        )
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
        try:
            ts_seconds = ts_ns / 1_000_000_000
            ts_iso = datetime.fromtimestamp(
                ts_seconds, tz=timezone.utc
            ).strftime("%Y-%m-%dT%H:%M:%S.") + f"{int((ts_ns % 1_000_000_000) / 1_000):06d}Z"
        except (ValueError, OSError):
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
        results.append(record)

    return results


def _extract_callids(results: list[dict[str, Any]]) -> set[str]:
    """Extract unique non-empty call_id values from parsed results."""
    return {r["callid"] for r in results if r.get("callid")}


def _is_directional(record: dict[str, Any]) -> bool:
    """True when a record has a real, drawable hop (distinct src and dst).

    The HEP capture path rewrites SrcIP/DstIP to friendly node names via the
    heplify-server ``ip-alias.lua`` script (see docker/homer/CLAUDE.md).  Many
    distinct underlying IPs collapse to the SAME alias — e.g. the SBC's VPC IP,
    its external IP and the NLB VIP all map to "SBC-1 East"; FreeSWITCH's
    internal and external IPs both map to "FreeSWITCH East".  When a single
    capture sees both ends of a message resolve to the same node name (a
    self/loopback capture, or an alias collapse), ``src_ip == dst_ip`` and the
    ladder cannot draw an arrow — it renders an orphan dot.

    A record is directional only when both endpoints are present AND distinct.
    """
    src = (record.get("src_ip") or "").strip()
    dst = (record.get("dst_ip") or "").strip()
    return bool(src) and bool(dst) and src != dst


def _message_identity(record: dict[str, Any]) -> tuple[Any, ...]:
    """Direction-AGNOSTIC identity of one logical SIP message ON ONE HOP.

    Deliberately EXCLUDES src_ip/dst_ip (when a topmost Via branch is present)
    so that the multiple captures of the SAME on-wire message — taken at the
    sender (egress) and the receiver (ingress), possibly with a collapsed
    self-capture where src==dst — all land in one group and reconcile to a
    single directional row.

    The discriminator is the TOPMOST Via branch (``branch=z9hG4bK...`` of the
    first Via header), NOT CSeq.  CSeq is INVARIANT as a request traverses
    proxies (RFC 3261 §8.1.1.5: the CSeq is copied verbatim when a proxy
    forwards a request), so keying on CSeq merged every genuinely-distinct
    proxy HOP of one request — BW→SBC, SBC→FS, FS→SBC, SBC→carrier — into a
    single row and dropped the rest of the ladder.  The topmost Via branch is
    unique per hop (each proxy adds its own Via/branch) yet identical for the
    two captures of the same hop, so hops are preserved while same-hop dupes
    still merge.

    FALLBACK: if no topmost Via branch can be parsed (rare for valid SIP), we
    refuse to merge by including (src_ip, dst_ip, timestamp_ns) in the identity
    — a possibly-duplicate row is acceptable, a silently-dropped hop is not.
    """
    via_branch = record.get("via_branch", "") or _extract_via_branch(
        record.get("raw_msg")
    )
    base = (
        record.get("callid", ""),
        record.get("method", ""),
        str(record.get("status", "") or ""),  # response code as string
    )
    if via_branch:
        return base + (via_branch,)
    # No parseable topmost Via branch: never merge this hop away.
    return base + (
        "",
        record.get("src_ip", ""),
        record.get("dst_ip", ""),
        record.get("timestamp_ns", 0),
    )


def _deduplicate_results(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Deduplicate SIP messages captured by multiple HEP nodes.

    The same SIP message traversing between Kamailio (capture_id=100) and
    FreeSWITCH (capture_id=200) is captured by both: once on the sender's HEP
    trace and once on the receiver's.  These are the same logical message but
    appear as separate entries with different node IDs and timestamps a few
    milliseconds apart.  A capture may also collapse to ``src_ip == dst_ip``
    when the heplify alias script maps both endpoints to the same node name —
    such a row is non-directional and must never be the survivor of a group if
    a directional twin exists (otherwise the ladder renders an orphan dot).

    Dedup strategy:
      1. Exact dedup by (timestamp_ns, callid, method, status) — removes truly
         identical rows returned by overlapping queries.  The key includes
         method+status so two genuinely different messages that happen to share
         a timestamp are never silently dropped.
      2. Group by a DIRECTION-AGNOSTIC, PER-HOP message identity (callid,
         method, status, topmost Via branch) so every capture of one physical
         on-wire message — including a collapsed src==dst self-capture — lands
         in the same group, while distinct proxy hops of one request (which
         share callid/method/status/CSeq but differ in topmost Via branch)
         stay in SEPARATE groups and are all preserved.
      3. Within each group, cluster entries within DEDUP_WINDOW_NS of each
         other (same physical message seen by sender and receiver within a few
         ms; a re-INVITE or retransmit with the same identity far apart in time
         stays a separate cluster).
      4. For each cluster, elect the survivor by PREFERRING a directional
         capture (src != dst).  Among directional captures pick the earliest;
         only if NO directional capture exists do we keep a src==dst row (so a
         message is never lost entirely, but a drawable hop always wins).  Node
         IDs from the whole cluster are merged into the survivor.

    Guarantees: genuine duplicates collapse to one row; the survivor carries a
    distinct, directional src/dst whenever ANY capture of that message did; a
    src==dst row is emitted only when it is the sole capture of the message.
    """
    # Tunable: maximum time difference (in nanoseconds) between two captures
    # of the same SIP message to consider them duplicates.  50ms accommodates
    # VPC latency + heplify-server processing jitter.
    DEDUP_WINDOW_NS = 50_000_000  # 50 ms

    if not results:
        return []

    # --- Pass 1: exact dedup ------------------------------------------------
    # Remove truly identical rows from overlapping queries (the correlation
    # query may return rows already in the initial result set).  method+status
    # are in the key so distinct messages sharing a timestamp are NOT dropped.
    exact_seen: set[tuple[int, str, str, str]] = set()
    unique: list[dict[str, Any]] = []
    for r in results:
        key = (
            r.get("timestamp_ns", 0),
            r.get("callid", ""),
            r.get("method", ""),
            str(r.get("status", "") or ""),
        )
        if key not in exact_seen:
            exact_seen.add(key)
            unique.append(r)

    # --- Pass 2: group by direction-agnostic, per-hop message identity -------
    groups: dict[tuple[Any, ...], list[dict[str, Any]]] = {}
    for r in unique:
        groups.setdefault(_message_identity(r), []).append(r)

    deduped: list[dict[str, Any]] = []
    for members in groups.values():
        # Sort by timestamp within the group
        members.sort(key=lambda r: r.get("timestamp_ns", 0))

        # Cluster entries within DEDUP_WINDOW_NS of each other.  Anchor the
        # window on the cluster's first timestamp so a long run of captures
        # spaced < window apart doesn't merge a later re-INVITE/retransmit.
        clusters: list[list[dict[str, Any]]] = []
        for entry in members:
            ts = entry.get("timestamp_ns", 0)
            if clusters and (ts - clusters[-1][0].get("timestamp_ns", 0)) <= DEDUP_WINDOW_NS:
                clusters[-1].append(entry)
            else:
                clusters.append([entry])

        # For each cluster, elect a directional survivor and merge node IDs.
        for cluster in clusters:
            directional = [e for e in cluster if _is_directional(e)]
            # Prefer a directional capture (earliest); fall back to the
            # earliest non-directional capture only if none is directional.
            representative = directional[0] if directional else cluster[0]

            # Collect all distinct node values from the entire cluster so the
            # survivor still shows every capture point that saw the message.
            nodes: list[str] = []
            seen_nodes: set[str] = set()
            for entry in cluster:
                node_val = str(entry.get("node", ""))
                if node_val and node_val not in seen_nodes:
                    seen_nodes.add(node_val)
                    nodes.append(node_val)
            if nodes:
                representative["node"] = ",".join(sorted(nodes))
            deduped.append(representative)

    deduped.sort(key=lambda r: r.get("timestamp_ns", 0))
    return deduped


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

        # Sort helper for early returns — use nanosecond precision
        def _sorted(r: list) -> list:
            r.sort(key=lambda x: x.get("timestamp_ns", 0))
            return r

        # If no results or correlation disabled, return immediately
        if not initial_results or not body.correlate:
            return {"data": _sorted(initial_results), "correlations": {}}

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
            return {"data": _sorted(initial_results), "correlations": {}}

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
            return {"data": _sorted(initial_results), "correlations": {}}

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
            merged = initial_results + corr_results
            return {
                "data": _deduplicate_results(merged),
                "correlations": correlations,
                # Additive, backward-compatible: only present when True.
                **({"correlation_truncated": True} if correlation_truncated else {}),
            }

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
            merged = initial_results + corr_results
            return {
                "data": _deduplicate_results(merged),
                "correlations": correlations,
                **({"correlation_truncated": True} if correlation_truncated else {}),
            }

        # The final query is the definitive result set — it contains ALL
        # messages for all Call-IDs. Merge with earlier results (dedup
        # handles any overlap) to ensure nothing is lost if the final
        # query itself hit its limit.
        all_results = initial_results + corr_results + final_results
        return {
            "data": _deduplicate_results(all_results),
            "correlations": correlations,
            **({"correlation_truncated": True} if correlation_truncated else {}),
        }
