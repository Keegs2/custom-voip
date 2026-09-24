"""Pure helpers for Homer A/B leg correlation (POST /search + GET /pcap).

STDLIB-ONLY by design (same pattern as homer_pipeline.py / homer_pcap.py): the
unit tests load this module by file path and exercise the X-CID parser, the
window math, the ClickHouse SQL builders and the grouping/attempt logic
without fastapi/httpx installed.  routers/homer.py owns the I/O (ClickHouse
HTTP, PostgreSQL) and calls these.

WHY THIS EXISTS (2026-09 diagnosis)
-----------------------------------
FreeSWITCH is a B2BUA: every forwarded call is one inbound A leg plus one B
leg PER carrier bridge attempt, each with its OWN SIP Call-ID.  The only
wire-level link is the ``X-CID: <A-leg SIP Call-ID>`` header FreeSWITCH puts
on every B-leg INVITE (dial strings in inbound_router.lua / trunk_outbound.lua;
Kamailio re-adds it toward carriers), captured at FS-out, SBC-in and SBC-out.

heplify-server 1.60.3 sets the Loki ``call_id`` label to the packet's OWN
Call-ID (remotelog/loki.go) — ``ALEGIDS=X-CID`` does NOT produce any A-leg
label in qryn.  So correlation has to read the header out of the stored SIP
text.  The previous implementation did that with a window-wide qryn scan
(``{type="sip"} |~ "X-CID:"``, limit 1000 = only the newest ~300 carrier legs
platform-wide), skipped correlation entirely above 50 Call-IDs, and silently
returned ``{}`` on any error — forwarded calls rendered as separate A and B
"calls" with no responses on the B side.

THE THREE DETERMINISTIC, BOUNDED SOURCES (routers/homer.py _correlate_legs)
--------------------------------------------------------------------------
(a) B -> A harvest: every INVITE request already fetched carries its X-CID in
    its own text (``harvest_xcid``).  Zero extra I/O.
(b) A -> B discovery: ClickHouse ``qryn.samples_v3`` scan restricted to each A
    call's own setup window ``[first INVITE - 1 s, first final response to the
    INVITE + 2 s]`` (no final -> first INVITE + 5 min, capped at the search end), ``multiSearchAny`` over
    <= 50 A Call-IDs per query, header-anchored ``extract`` of the X-CID value,
    then fingerprint -> call_id via ``qryn.time_series`` (primary-key lookup).
(c) CDR cross-check: ``cdrs`` B rows (``leg='B'``, ``call_id`` = the A-leg
    uuid, which on this platform IS the inbound SIP Call-ID because the
    internal sofia profile sets inbound-use-callid-as-uuid=true).  The B row
    ``uuid`` is the B channel uuid == the B-leg SIP Call-ID FreeSWITCH sent.
"""

import json
import re
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional

# ---------------------------------------------------------------------------
# X-CID header parsing
# ---------------------------------------------------------------------------

# Header-ANCHORED: the header name must start a line (after CRLF/LF), is
# matched case-insensitively (RFC 3261 header names are case-insensitive),
# optional SP/HTAB before the value, value runs to end of line.  "X-CID:"
# appearing inside ANOTHER header's value (e.g. "Subject: see X-CID: x") must
# NOT match — hence ^ + MULTILINE rather than a bare search.
XCID_HEADER_RE = re.compile(r"^X-CID:[ \t]*([^\r\n]+)", re.IGNORECASE | re.MULTILINE)

# The SAME pattern in RE2 syntax for ClickHouse extract(): inline (?mi) flags.
# Kept here next to the Python twin so they cannot drift apart unnoticed
# (tests assert both describe the same header grammar).
CH_XCID_PATTERN = r"(?mi)^X-CID:[ \t]*([^\r\n]+)"
# Own Call-ID header (long or compact form) — fallback identity for a scan hit
# whose fingerprint could not be mapped through time_series.
CH_CALLID_PATTERN = r"(?mi)^(?:Call-ID|i):[ \t]*([^\r\n]+)"


def extract_xcid(raw_msg: Optional[str]) -> Optional[str]:
    """Return the X-CID header value of a raw SIP message, or None.

    Trailing whitespace is stripped; an all-blank value is treated as absent.
    """
    if not raw_msg:
        return None
    m = XCID_HEADER_RE.search(raw_msg)
    if not m:
        return None
    value = m.group(1).strip()
    return value or None


def is_invite_request(record: dict[str, Any]) -> bool:
    """True when the record is an INVITE *request* (not a response to one).

    Prefers the raw request line (authoritative); falls back to the heplify
    labels (method=INVITE with no numeric response code) when the raw text is
    absent.
    """
    raw = record.get("raw_msg") or ""
    if raw:
        return raw.lstrip().startswith("INVITE ")
    return (record.get("method") or "").upper() == "INVITE" and record.get("status") is None


def harvest_xcid(records: Iterable[dict[str, Any]]) -> dict[str, str]:
    """Source (a): B-leg Call-ID -> A-leg Call-ID from fetched INVITE requests."""
    out: dict[str, str] = {}
    for r in records:
        cid = r.get("callid") or ""
        if not cid or not is_invite_request(r):
            continue
        a = extract_xcid(r.get("raw_msg"))
        if a and a != cid:
            out.setdefault(cid, a)
    return out


# ---------------------------------------------------------------------------
# Call-ID safety + ClickHouse string literals
# ---------------------------------------------------------------------------

MAX_CALLID_LEN = 512


def is_safe_callid(cid: Any) -> bool:
    """A Call-ID we are willing to put into a ClickHouse query at all.

    Printable ASCII only (RFC 3261 Call-ID is word[@word] of printable chars;
    SP tolerated — ch_quote escapes everything that matters), no CR/LF/NUL,
    bounded length.  Anything else is SKIPPED (never interpolated), even
    though ch_quote would escape it correctly.
    """
    if not isinstance(cid, str) or not cid or len(cid) > MAX_CALLID_LEN:
        return False
    return all(0x20 <= ord(c) <= 0x7E for c in cid)


def ch_quote(value: str) -> str:
    """ClickHouse single-quoted string literal with full escaping.

    ClickHouse string literals are backslash-escaped: both ``\\`` and ``'``
    must be escaped (doubling the quote alone — the previous approach — lets
    a trailing backslash swallow the closing quote).  Control characters are
    rendered as escapes so the literal is always a single line.
    """
    out = []
    for ch in value:
        if ch == "\\":
            out.append("\\\\")
        elif ch == "'":
            out.append("\\'")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif ord(ch) < 0x20 or ord(ch) == 0x7F:
            out.append("\\x%02x" % ord(ch))
        else:
            out.append(ch)
    return "'" + "".join(out) + "'"


# ---------------------------------------------------------------------------
# A-leg setup windows (source (b))
# ---------------------------------------------------------------------------

WINDOW_PRE_NS = 1 * 1_000_000_000      # capture-node clock skew before A INVITE
WINDOW_POST_NS = 2 * 1_000_000_000     # slack after A's final response
# No final response seen (call in progress, or the final's capture was lost):
# every B INVITE (all failover attempts) is launched within the SBC x carrier
# attempt budget right after the A INVITE (4 attempts x progress_timeout 10 s +
# ringing), so a bounded tail is always sufficient. Never scan to the search
# end: on a 24 h search that would be a wide samples_v3 scan per open call.
WINDOW_OPEN_MAX_NS = 5 * 60 * 1_000_000_000


def _cseq_method(record: dict[str, Any]) -> str:
    cseq = record.get("cseq") or ""
    parts = cseq.split()
    return parts[1].upper() if len(parts) >= 2 else ""


def a_leg_window(
    records: Iterable[dict[str, Any]],
    open_end_ns: int,
) -> Optional[tuple[int, int]]:
    """``[first INVITE - 1 s, first final INVITE response + 2 s)`` for one A leg.

    Every B leg (each failover attempt) is launched after the A INVITE arrives
    and before FreeSWITCH answers/rejects the A leg, so this window contains
    every B INVITE.  Final = first >=200 response whose CSeq method is INVITE,
    excluding 401/407 challenges.  No final seen (in-progress call, or capture
    lost) -> ``min(open_end_ns, first INVITE + 5 min)`` (bounded; never the whole search).  No INVITE seen at all
    -> earliest record of the Call-ID is used as the start.  None when the
    records carry no usable timestamps.
    """
    recs = [r for r in records if r.get("timestamp_ns")]
    if not recs:
        return None
    invites = [r["timestamp_ns"] for r in recs if is_invite_request(r)]
    start = min(invites) if invites else min(r["timestamp_ns"] for r in recs)
    finals = [
        r["timestamp_ns"] for r in recs
        if isinstance(r.get("status"), int)
        and r["status"] >= 200
        and r["status"] not in (401, 407)
        and _cseq_method(r) in ("INVITE", "")
        and r["timestamp_ns"] >= start
    ]
    end = (min(finals) + WINDOW_POST_NS) if finals else min(open_end_ns, start + WINDOW_OPEN_MAX_NS)
    start -= WINDOW_PRE_NS
    if end <= start:
        end = start + WINDOW_PRE_NS + WINDOW_POST_NS
    return start, end


def merge_windows(windows: Iterable[tuple[int, int]]) -> list[tuple[int, int]]:
    """Union of half-open ranges, sorted, overlapping/adjacent ones merged."""
    out: list[list[int]] = []
    for s, e in sorted(windows):
        if out and s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return [(s, e) for s, e in out]


# ---------------------------------------------------------------------------
# ClickHouse SQL builders
# ---------------------------------------------------------------------------

XCID_SCAN_ROW_LIMIT = 5000


def build_xcid_scan_sql(
    db: str,
    a_callids: list[str],
    windows: list[tuple[int, int]],
    limit: int = XCID_SCAN_ROW_LIMIT,
) -> str:
    """Source (b) query 1: samples_v3 rows in the A windows that carry X-CID.

    * ``timestamp_ns`` ranges (OR of merged windows) are the primary-key /
      partition bound — the scan never leaves the A calls' own setup windows.
    * ``multiSearchAny`` (<= 255 needles; callers chunk at 50) with the bare
      A Call-IDs as needles is a superset of "X-CID: <cid>" (robust to header
      spacing/case); the header-anchored ``extract`` then keeps only rows that
      really carry an X-CID and the caller filters the value by EXACT match.
    * Only (fingerprint, X-CID value, own Call-ID header, first ts) leave the
      server — never the message text — grouped, so the result stays small.
    Every value is ch_quote()d; windows are ints.
    """
    if not a_callids or not windows:
        raise ValueError("build_xcid_scan_sql needs Call-IDs and windows")
    ranges = " OR ".join(
        f"(timestamp_ns >= {int(s)} AND timestamp_ns < {int(e)})" for s, e in windows
    )
    needles = ", ".join(ch_quote(c) for c in a_callids)
    return f"""
        SELECT
            toString(fingerprint) AS fp,
            extract(string, {ch_quote(CH_XCID_PATTERN)}) AS xcid,
            extract(string, {ch_quote(CH_CALLID_PATTERN)}) AS hdr_callid,
            min(timestamp_ns) AS first_ns
        FROM {db}.samples_v3
        WHERE ({ranges})
          AND multiSearchAny(string, [{needles}])
        GROUP BY fp, xcid, hdr_callid
        HAVING xcid != ''
        LIMIT {int(limit)}
        FORMAT JSONEachRow
    """


def build_fingerprint_labels_sql(db: str, fingerprints: list[int]) -> str:
    """Source (b) query 2: fingerprint -> labels (call_id) via time_series.

    time_series is ORDER BY fingerprint, so ``fingerprint IN (<ints>)`` is a
    primary-key point lookup — the same (proven in production) access shape
    _query_clickhouse_by_callids already uses on this table; deliberately no
    extra column predicates.  ``any(labels)`` collapses ReplacingMergeTree
    duplicates across partitions.
    """
    if not fingerprints:
        raise ValueError("build_fingerprint_labels_sql needs fingerprints")
    fps = ", ".join(str(int(f)) for f in fingerprints)
    return f"""
        SELECT toString(fingerprint) AS fp, any(labels) AS labels
        FROM {db}.time_series
        WHERE fingerprint IN ({fps})
        GROUP BY fingerprint
        FORMAT JSONEachRow
    """


def parse_json_each_row(text: str) -> list[dict[str, Any]]:
    rows = []
    for line in (text or "").strip().splitlines():
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def _as_int(value: Any) -> Optional[int]:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


@dataclass
class ScanHit:
    fingerprint: int
    xcid: str          # stripped X-CID value (== an A Call-ID we asked for)
    hdr_callid: str    # stripped own Call-ID header (fallback identity)
    first_ns: int


def parse_xcid_scan(text: str, wanted_a: set[str]) -> list[ScanHit]:
    """Keep only rows whose (stripped) X-CID EXACTLY equals a requested A."""
    hits = []
    for row in parse_json_each_row(text):
        xcid = (row.get("xcid") or "").strip()
        if xcid not in wanted_a:
            continue
        fp = _as_int(row.get("fp"))
        if fp is None:
            continue
        hits.append(ScanHit(
            fingerprint=fp,
            xcid=xcid,
            hdr_callid=(row.get("hdr_callid") or "").strip(),
            first_ns=_as_int(row.get("first_ns")) or 0,
        ))
    return hits


def parse_fingerprint_labels(text: str) -> dict[int, str]:
    out: dict[int, str] = {}
    for row in parse_json_each_row(text):
        fp = _as_int(row.get("fp"))
        if fp is None:
            continue
        labels = row.get("labels")
        if isinstance(labels, str):
            try:
                labels = json.loads(labels)
            except json.JSONDecodeError:
                labels = {}
        if isinstance(labels, dict) and labels.get("call_id"):
            out[fp] = labels["call_id"]
    return out


# ---------------------------------------------------------------------------
# Grouping, roles, attempts
# ---------------------------------------------------------------------------

@dataclass
class LegGraph:
    """Accumulated B -> A evidence from all three sources."""
    b_to_a: dict[str, str] = field(default_factory=dict)
    # B Call-ID -> CDR leg_attempt (source (c)), when known.
    cdr_attempt: dict[str, int] = field(default_factory=dict)
    # B Call-ID -> first-seen ns from the ClickHouse scan (source (b)).
    scan_first_ns: dict[str, int] = field(default_factory=dict)

    def add(self, b: str, a: str) -> bool:
        """Record B -> A. Returns True when the mapping is new."""
        if not b or not a or b == a or b in self.b_to_a:
            return False
        self.b_to_a[b] = a
        return True

    def root(self, cid: str) -> str:
        """Follow B -> A links to the originating A (loop-guarded)."""
        seen = {cid}
        cur = cid
        while cur in self.b_to_a:
            nxt = self.b_to_a[cur]
            if nxt in seen:
                break
            seen.add(nxt)
            cur = nxt
        return cur


def _first_invite_ns(records: list[dict[str, Any]]) -> Optional[int]:
    inv = [r["timestamp_ns"] for r in records if r.get("timestamp_ns") and is_invite_request(r)]
    if inv:
        return min(inv)
    any_ts = [r["timestamp_ns"] for r in records if r.get("timestamp_ns")]
    return min(any_ts) if any_ts else None


def build_groups(
    callids: Iterable[str],
    graph: LegGraph,
    records_by_cid: dict[str, list[dict[str, Any]]],
) -> tuple[dict[str, list[str]], dict[str, dict[str, Any]]]:
    """Build the (unchanged-shape) ``correlations`` map and the ``legs`` map.

    correlations: every Call-ID -> sorted list of its whole group (A + all Bs,
    itself included).  legs: {role, a_callid, attempt}.  Attempt numbering per
    A call: when EVERY B leg of the group has a CDR ``leg_attempt`` those are
    used verbatim; otherwise all B legs are numbered 1..N by first INVITE time
    (fallback: first captured row, then the scan's first-seen time), Call-ID as
    the deterministic tiebreak.  Mixing the two could collide, so it is
    all-or-nothing per group.
    """
    ids = set(callids)
    groups: dict[str, set[str]] = {}
    for cid in ids:
        groups.setdefault(graph.root(cid), set()).add(cid)

    correlations: dict[str, list[str]] = {}
    legs: dict[str, dict[str, Any]] = {}
    for a, members in groups.items():
        members = set(members)
        ordered = sorted(members)
        for cid in members:
            correlations[cid] = ordered
        bs = [c for c in members if c != a]
        if bs and all(b in graph.cdr_attempt for b in bs):
            attempts = {b: graph.cdr_attempt[b] for b in bs}
        else:
            def _key(b: str) -> tuple[int, str]:
                t = _first_invite_ns(records_by_cid.get(b, []))
                if t is None:
                    t = graph.scan_first_ns.get(b)
                return (t if t is not None else 1 << 62, b)
            attempts = {b: i + 1 for i, b in enumerate(sorted(bs, key=_key))}
        for cid in members:
            if cid == a:
                legs[cid] = {"role": "A", "a_callid": a, "attempt": None}
            else:
                legs[cid] = {"role": "B", "a_callid": a, "attempt": attempts.get(cid)}
    return correlations, legs


# ---------------------------------------------------------------------------
# Status bookkeeping
# ---------------------------------------------------------------------------

@dataclass
class CorrelationHealth:
    """ok | partial | degraded + a short machine-readable reason.

    degraded = the ClickHouse backbone could not run (every X-CID scan chunk
    failed, or every leg fetch failed) — results are Step-1 data only.
    partial  = something failed or was capped but the rest succeeded (a scan
    or fetch chunk failed, the CDR cross-check was unavailable, a cap hit).
    """
    reasons: list[str] = field(default_factory=list)
    degraded: bool = False
    truncated: bool = False

    def add(self, reason: str) -> None:
        if reason and reason not in self.reasons:
            self.reasons.append(reason)

    @property
    def status(self) -> str:
        if self.degraded:
            return "degraded"
        return "partial" if self.reasons else "ok"

    @property
    def reason(self) -> Optional[str]:
        return ",".join(self.reasons) if self.reasons else None
