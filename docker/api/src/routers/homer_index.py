"""SIP number index (C-IDX-1/2/3) — pure stdlib helpers for routers/homer.py.

The index is a ClickHouse table filled at ingest by a materialized view on
qryn's samples_v3 (DDL: docker/homer/clickhouse/10_sip_number_index.sql). A
number search reads ONLY this table to find Call-IDs, then fetches those
calls by Call-ID through the existing path. This module holds everything that
needs no I/O, so it is unit-testable without fastapi/httpx:

  * SQL builders. Every user-derived value travels as a ClickHouse query
    parameter (``{name:Type}`` in the SQL, ``param_name=`` on the URL) — the
    SQL text itself contains only constants, validated identifiers and the
    fixed role allow-list. Needles are additionally required to be ASCII
    digit strings (normalize_number_needle output) before a builder accepts
    them.
  * Coverage: ``index_covered_from`` = the oldest moment from which the index
    is complete up to now (MV start time, extended back one whole UTC day at
    a time over days the backfill completed after the MV started).
  * ClickHouse limit-error classification (search_too_broad).

Normalization contract (shared with the DDL): stored numbers are digits only;
an 11-digit number starting with 1 is stored both as-is and without the 1.
The API normalizes needles with homer_pipeline.normalize_number_needle (strip
non-digits; exactly 11 digits with a leading 1 -> drop it). A FULL number
(>= EXACT_MIN_DIGITS digits) matches a stored number EXACTLY — a primary-key
lookup — so "5087282017", "15087282017" and "+1 (508) 728-2017" all find the
same calls. A shorter needle is a PARTIAL and matches by substring
(``number LIKE '%<needle>%'``). Both run in an explicit PREWHERE: ClickHouse
23.3 would otherwise move the ``day`` predicate there and read every column
of every row in the window.
"""

import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable, Optional

INDEX_TABLE = "sip_number_index"
INDEX_MV = "sip_number_index_mv"
COVERAGE_TABLE = "sip_number_index_coverage"

# Contract C-IDX-2/3 constants.
MAX_SCAN_HOURS = 24
MAX_WINDOW_DAYS = 7
# Whole UTC days the index (and qryn's samples) still hold: index rows live
# day + 8 days (TTL), qryn keeps samples 7 days, so days >= today - 7 are
# present. Coverage is never reported older than that.
INDEX_RETENTION_DAYS = 7

# Which stored roles each request field matches. ``number`` matches any role
# (including 'other': numbers seen in any message that is not the initial
# INVITE). Roles are recorded from the initial INVITE only:
# from_user = the calling identity (From, P-Asserted-Identity);
# to_user   = the called party (To, Request-URI).
ROLE_FILTERS: dict[str, Optional[tuple[str, ...]]] = {
    "number": None,
    "from_user": ("from", "pai"),
    "to_user": ("to", "ruri"),
}
_ALLOWED_ROLES = {"ruri", "from", "to", "pai", "diversion", "other"}
# A needle this long is a full number: exact match (primary key), not a
# substring scan. 10 = a NANP national number (the normalized form of every
# +1 / 11-digit input); longer international numbers are exact too.
EXACT_MIN_DIGITS = 10

# Settings sent with every index query (URL settings, never data).
# readonly=2: the request can only read (it may still carry these settings).
# The memory/bytes caps sit far below the global 4e9 per-query limit, so a
# broad partial needle fails fast as search_too_broad instead of an OOM.
# Sized from a 30M-row, 7-day unmerged local load (scripts/homer/
# test_sip_number_index_clickhouse.py --scale; table in docker/homer/CLAUDE.md):
#   full number (primary key):   ~0.57M rows /  11 MB / ~10 MiB / 7-26 ms
#   4-digit partial "2017":       30.1M rows / 2.4 GB / 270 MiB / 281 ms
#   3-digit partial "508":        30.1M rows / 2.5 GB / 756 MiB / 666 ms
# A partial reads the whole index in the window (matches sit in every
# granule), so the byte cap leaves ~2.4x headroom over 30M rows, and a big
# GROUP BY spills to disk at 5e8 instead of failing under the 1e9 memory cap.
INDEX_QUERY_SETTINGS: dict[str, str] = {
    "readonly": "2",
    "max_execution_time": "10",
    "max_memory_usage": "1000000000",
    "max_bytes_before_external_group_by": "500000000",
    "max_bytes_to_read": "6000000000",
}
# Capability probe: two tiny reads (system.tables + the coverage table).
STATE_QUERY_SETTINGS: dict[str, str] = {
    "readonly": "2",
    "max_execution_time": "5",
    "max_memory_usage": "200000000",
    "max_bytes_to_read": "500000000",
}
# Freshness (is the MV still filling?): the newest INVITE in samples_v3 in
# [now - 15 min, now - 2 min) must be in the index within this tolerance.
FRESH_LOOKBACK_S = 15 * 60
FRESH_SETTLE_S = 2 * 60
FRESH_TOLERANCE_S = 5 * 60

# ClickHouse error codes that mean "this query hit a limit" (too broad), not
# "ClickHouse is broken": TOO_MANY_ROWS, TIMEOUT_EXCEEDED, TOO_SLOW,
# MEMORY_LIMIT_EXCEEDED, TOO_MANY_BYTES, TOO_MANY_ROWS_OR_BYTES.
CAP_ERROR_CODES = frozenset({158, 159, 160, 241, 307, 396})
_CODE_RE = re.compile(r"Code:\s*(\d+)")
_MEM_RE = re.compile(r"MEMORY_LIMIT_EXCEEDED|Memory limit \(", re.I)

_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
NS = 1_000_000_000
DAY_NS = 86400 * NS


def _ident(db: str) -> str:
    """A database name we are willing to put into SQL text (env constant)."""
    if not isinstance(db, str) or not _IDENT_RE.match(db):
        raise ValueError(f"invalid ClickHouse database identifier: {db!r}")
    return db


def _digits(needle: str) -> str:
    if not isinstance(needle, str) or not needle or not needle.isascii() or not needle.isdigit():
        raise ValueError("index needle must be ASCII digits after normalization")
    return needle


# ---------------------------------------------------------------------------
# Time helpers (UTC)
# ---------------------------------------------------------------------------

def utc_date(ns: int) -> date:
    return datetime.fromtimestamp(ns // NS, tz=timezone.utc).date()


def midnight_ns(d: date) -> int:
    return int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp()) * NS


def ns_to_iso(ns: Optional[int]) -> Optional[str]:
    if ns is None:
        return None
    dt = datetime.fromtimestamp(ns // NS, tz=timezone.utc).replace(
        microsecond=(ns % NS) // 1000)
    return dt.isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# Capability / coverage (C-IDX-3)
# ---------------------------------------------------------------------------

def build_state_sql(db: str) -> "Lookup":
    """Which index objects exist, and when each was created (unix s)."""
    sql = (
        "SELECT name, toString(toUnixTimestamp(metadata_modification_time)) AS mtime "
        "FROM system.tables "
        "WHERE database = {db:String} AND name IN ({t1:String}, {t2:String}, {t3:String}) "
        "FORMAT JSONEachRow"
    )
    return Lookup(sql, {
        "param_db": _ident(db),
        "param_t1": INDEX_TABLE,
        "param_t2": INDEX_MV,
        "param_t3": COVERAGE_TABLE,
    })


def build_coverage_sql(db: str) -> str:
    return (
        "SELECT kind, toString(day) AS day, "
        "toString(toUnixTimestamp64Milli(started_at)) AS started_ms "
        f"FROM {_ident(db)}.{COVERAGE_TABLE} FINAL "
        "FORMAT JSONEachRow"
    )


def build_fresh_samples_sql(db: str) -> str:
    """Newest INVITE request in samples_v3 inside {lo, hi} (timestamp_ns is
    qryn's sort key, so this reads only the last minutes)."""
    return (
        "SELECT toString(max(timestamp_ns)) AS t "
        f"FROM {_ident(db)}.samples_v3 "
        "PREWHERE timestamp_ns >= {lo:Int64} AND timestamp_ns < {hi:Int64} "
        "WHERE startsWith(string, 'INVITE ') "
        "FORMAT JSONEachRow"
    )


def build_fresh_index_sql(db: str) -> str:
    """Newest message the index holds (today's and yesterday's partitions)."""
    return (
        "SELECT toString(max(last_ns)) AS t "
        f"FROM {_ident(db)}.{INDEX_TABLE} "
        "WHERE day >= {d:Date} "
        "FORMAT JSONEachRow"
    )


def fresh_params(now_ns: int) -> tuple[dict[str, str], dict[str, str]]:
    lo = now_ns - FRESH_LOOKBACK_S * NS
    hi = now_ns - FRESH_SETTLE_S * NS
    return ({"param_lo": str(lo), "param_hi": str(hi)},
            {"param_d": (utc_date(now_ns) - timedelta(days=1)).isoformat()})


def parse_max(text: str) -> int:
    rows = parse_rows(text)
    try:
        return int(rows[0]["t"]) if rows else 0
    except (KeyError, TypeError, ValueError):
        return 0


def is_stale(newest_invite_ns: int, newest_index_ns: int) -> bool:
    """True when SIP arrived that the MV did not index: an INVITE captured
    2-15 min ago is newer than everything in the index by more than the
    tolerance. No INVITE in that span (quiet platform) -> not stale."""
    if newest_invite_ns <= 0:
        return False
    return newest_index_ns < newest_invite_ns - FRESH_TOLERANCE_S * NS


@dataclass
class Capability:
    number_index: bool = False
    covered_from_ns: Optional[int] = None
    reason: str = "absent"     # diagnostics only (logs), never user-facing

    @property
    def covered_from_iso(self) -> Optional[str]:
        return ns_to_iso(self.covered_from_ns) if self.number_index else None

    def covers(self, start_ns: int) -> bool:
        return (self.number_index and self.covered_from_ns is not None
                and start_ns >= self.covered_from_ns)


def parse_rows(text: str) -> list[dict[str, Any]]:
    rows = []
    for line in (text or "").strip().splitlines():
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            rows.append(obj)
    return rows


def parse_state(text: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for r in parse_rows(text):
        try:
            out[str(r["name"])] = int(r["mtime"])
        except (KeyError, TypeError, ValueError):
            continue
    return out


def compute_capability(
    tables: dict[str, int],
    coverage_rows: Iterable[dict[str, Any]],
    now_ns: int,
    *,
    stale: bool = False,
) -> Capability:
    """Truthful coverage from the objects present + the coverage table.

    * The MV and the index table must both exist, else no index.
    * ``mv_since`` = the LATER of the MV's own creation time
      (system.tables.metadata_modification_time, stable across restarts) and
      the 'mv' coverage row written right after it. Everything inserted since
      then reached the index through the MV.
    * Coverage extends back from mv_since one whole UTC day at a time while
      that day has a 'backfill' row whose run STARTED at or after mv_since (a
      backfill that ran before the MV existed could miss rows inserted
      between the two, so it does not count). The MV's own day counts once
      backfilled: the backfill read every row inserted before it started.
    * Never older than retention (today - INDEX_RETENTION_DAYS, midnight).
    * ``stale`` (the MV stopped filling, see is_stale) -> no index: the
      search falls back to the bounded scan instead of answering "no calls".
    """
    if INDEX_MV not in tables or INDEX_TABLE not in tables:
        return Capability(False, None, "absent")
    if stale:
        return Capability(False, None, "stale")
    mv_since_ns = tables[INDEX_MV] * NS
    filled: dict[date, int] = {}
    for r in coverage_rows:
        try:
            kind = r["kind"]
            started_ns = int(r["started_ms"]) * 1_000_000
            d = date.fromisoformat(str(r["day"]))
        except (KeyError, TypeError, ValueError):
            continue
        if kind == "mv":
            mv_since_ns = max(mv_since_ns, started_ns)
        elif kind == "backfill":
            filled[d] = max(filled.get(d, 0), started_ns)
    covered = mv_since_ns
    d = utc_date(mv_since_ns)
    while filled.get(d, -1) >= mv_since_ns:
        covered = midnight_ns(d)
        d -= timedelta(days=1)
    floor = midnight_ns(utc_date(now_ns) - timedelta(days=INDEX_RETENTION_DAYS))
    return Capability(True, max(covered, floor), "ok")


# ---------------------------------------------------------------------------
# Index lookup (C-IDX-2)
# ---------------------------------------------------------------------------

@dataclass
class IndexHit:
    call_id: str
    first_ns: int
    last_ns: int


@dataclass
class Lookup:
    sql: str
    params: dict[str, str] = field(default_factory=dict)


def build_lookup(
    db: str,
    needles: list[tuple[str, str]],
    start_ns: int,
    end_ns: int,
    limit: int,
) -> Lookup:
    """Calls whose stored numbers match EVERY needle, newest first.

    ``needles`` = [(field, digits)] with field in ROLE_FILTERS. A needle of
    EXACT_MIN_DIGITS+ digits matches a stored number exactly; a shorter one
    by substring. A call matches when, for each needle, at least one of its
    index rows matches in an allowed role. Time: the call's matched rows
    overlap [start_ns, end_ns) — ``max(last_ns) >= start`` and
    ``min(first_ns) < end`` — and calls are ordered by that ``min(first_ns)``
    DESC (ties broken by Call-ID), which is the paging cursor.
    The number conditions are an explicit PREWHERE (read the narrow number /
    role columns first, the rest only for matching granules); ``day`` in
    WHERE prunes partitions.
    """
    if not needles:
        raise ValueError("build_lookup needs at least one needle")
    if end_ns <= start_ns:
        raise ValueError("empty window")
    params: dict[str, str] = {
        "param_d0": utc_date(int(start_ns)).isoformat(),
        "param_d1": utc_date(int(end_ns) - 1).isoformat(),
        "param_lo": str(int(start_ns)),
        "param_hi": str(int(end_ns)),
        "param_lim": str(int(limit)),
    }
    conds: list[str] = []
    for i, (fld, needle) in enumerate(needles):
        if fld not in ROLE_FILTERS:
            raise ValueError(f"unknown needle field {fld!r}")
        digits = _digits(needle)
        if len(digits) >= EXACT_MIN_DIGITS:
            params[f"param_n{i}"] = digits
            cond = f"number = {{n{i}:String}}"
        else:
            params[f"param_n{i}"] = f"%{digits}%"
            cond = f"number LIKE {{n{i}:String}}"
        roles = ROLE_FILTERS[fld]
        if roles:
            assert set(roles) <= _ALLOWED_ROLES
            cond += " AND role IN (" + ", ".join(f"'{r}'" for r in roles) + ")"
        conds.append(f"({cond})")
    having = [f"countIf{c} > 0" for c in conds] if len(conds) > 1 else []
    having += ["max(last_ns) >= {lo:Int64}", "min(first_ns) < {hi:Int64}"]
    sql = (
        # Output aliases must not shadow the column names used in HAVING.
        "SELECT call_id, toString(min(first_ns)) AS f_ns, "
        "toString(max(last_ns)) AS l_ns "
        f"FROM {_ident(db)}.{INDEX_TABLE} "
        f"PREWHERE {' OR '.join(conds)} "
        "WHERE day >= {d0:Date} AND day <= {d1:Date} "
        "GROUP BY call_id "
        f"HAVING {' AND '.join(having)} "
        "ORDER BY min(first_ns) DESC, call_id DESC "
        "LIMIT {lim:UInt32} "
        "FORMAT JSONEachRow"
    )
    return Lookup(sql, params)


def parse_lookup(text: str) -> list[IndexHit]:
    hits: list[IndexHit] = []
    for r in parse_rows(text):
        try:
            cid = r["call_id"]
            hits.append(IndexHit(str(cid), int(r["f_ns"]), int(r["l_ns"])))
        except (KeyError, TypeError, ValueError):
            continue
    return hits


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

def error_code(headers: Any, body: str) -> Optional[int]:
    """ClickHouse exception code from the HTTP header, else from the text."""
    raw = None
    try:
        raw = headers.get("X-ClickHouse-Exception-Code") if headers is not None else None
    except AttributeError:
        raw = None
    if raw:
        try:
            return int(raw)
        except ValueError:
            pass
    m = _CODE_RE.search(body or "")
    return int(m.group(1)) if m else None


def is_cap_error(code: Optional[int], body: str = "") -> bool:
    return (code in CAP_ERROR_CODES) or bool(_MEM_RE.search(body or ""))


def fetch_too_large_sentence() -> str:
    return ("The matching calls' SIP is too large to load in one page; "
            "choose a shorter window.")


def too_broad_sentence(needles: list[tuple[str, str]]) -> str:
    shortest = min((n for _f, n in needles), key=len, default="")
    if not shortest:
        return "This search matches too much SIP; choose a shorter window."
    return (f"Too many calls match '{shortest}' for this search; "
            "add more digits or choose a shorter window.")


def window_too_wide_sentence(capability: Capability) -> str:
    if capability.number_index and capability.covered_from_iso:
        return (f"The number index covers calls from {capability.covered_from_iso} on; "
                f"an older number search can cover at most {MAX_SCAN_HOURS} hours at a time. "
                "Choose a shorter window or a later start.")
    return (f"A number search can cover at most {MAX_SCAN_HOURS} hours at a time "
            "on this server. Choose a shorter window.")
