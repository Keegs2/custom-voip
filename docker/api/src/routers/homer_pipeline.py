"""Pure SIP-trace post-processing pipeline for the Homer router.

This module is STDLIB-ONLY by design: it imports nothing outside the Python
standard library so the unit tests (tests/test_homer_pipeline.py and
tests/test_homer_number_search.py) can load and exercise the dedup /
causality-ordering / hairpin-marking logic — and the search-needle
normalizer — without fastapi, httpx or the auth package being installed.
routers/homer.py re-imports every helper defined here, so the router's
public surface is unchanged.

Ground truth for the behaviors implemented here is a real production call
whose SIP ladder rendered broken:
    tests/fixtures/homer_ground_truth_20260610.md

Verified storage anomalies this pipeline must survive (see the fixture):

1. TIMESTAMP CORRUPTION: rows whose timestamp_ns ends in 000 carry the true
   HEP capture timestamp (microsecond precision x1000).  Rows with full
   nanosecond entropy were stamped at INGEST, 15-20 ms LATE.  For some
   messages (the A-leg carrier INVITE) ALL stored copies are ingest-stamped,
   so sorting by stored timestamp puts the INVITE AFTER its own 100 Trying.
   Historical data is permanently like this — display order must therefore be
   derived from SIP causality, not timestamps alone (_order_by_causality).

2. UP TO 3 COPIES of each on-wire message (FreeSWITCH capture node=200,
   Kamailio sip_trace node=100, Kamailio tm trace_flag duplicate node=100).
   _deduplicate_results collapses them and elects the copy with the most
   trustworthy timestamp.

3. REAL HAIRPIN ROWS: src_ip == dst_ip == SBC-VIP rows are genuine wire
   packets (the SBC routing in-dialog requests to itself via the loopback
   VIP).  They are KEPT and marked hairpin=true so the UI can collapse them.
"""
import heapq
import re
from datetime import datetime, timezone
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Timestamp helpers
# ---------------------------------------------------------------------------


def _ns_to_iso(ts_ns: int) -> Optional[str]:
    """Render Unix nanoseconds as an ISO 8601 UTC string with µs precision.

    Microseconds (6 digits) are included because SIP message ordering matters
    and milliseconds alone are insufficient when multiple messages land in the
    same millisecond.  Returns None when the value cannot be rendered.
    """
    try:
        ts_seconds = ts_ns / 1_000_000_000
        return datetime.fromtimestamp(ts_seconds, tz=timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%S."
        ) + f"{int((ts_ns % 1_000_000_000) / 1_000):06d}Z"
    except (ValueError, OSError, OverflowError):
        return None


def _is_hep_stamped(ts_ns: int) -> bool:
    """True when a timestamp came from the HEP capture header.

    heplify-server stores HEP capture timestamps as whole microseconds x1000,
    so trustworthy stamps always end in three zero digits (ts_ns % 1000 == 0,
    e.g. ...707709698000).  Rows with sub-microsecond entropy were stamped at
    ingest instead (e.g. ...707725832231) — verified 15-20 ms LATE in the
    ground-truth fixture (the A-leg carrier INVITE is stored at
    ...707725964951 while its true wire time is <= ...707709698000).
    """
    return ts_ns > 0 and ts_ns % 1_000 == 0


# ---------------------------------------------------------------------------
# Search-needle normalization (the /v1/homer/search input contract)
# ---------------------------------------------------------------------------

# ASCII-strict on purpose: SIP payloads carry phone numbers as ASCII digits
# only, so Unicode digits (e.g. Arabic-Indic "٦١٧") are stripped as formatting
# rather than translated — they can never match a payload anyway.
_NON_ASCII_DIGIT_RE = re.compile(r"[^0-9]+")


def normalize_number_needle(raw: Optional[str]) -> str:
    """Normalize a free-form phone-number search input to a digits-only needle.

    Support types a number in ANY form — ``+1 (617) 454-4217``,
    ``617.454.4217``, ``16174544217``, ``6174544217``, or any >=3-digit
    partial — and normalization is OUR job, server-side.  Rules (the pinned
    POST /v1/homer/search contract):

      1. Strip every non-digit (ASCII 0-9 only survive).
      2. Exactly 11 digits with a leading ``1`` -> drop the ``1`` (NANP
         national core).  SUBSTRING PROPERTY: because the needle is used as an
         UNANCHORED containment match against the raw SIP payload,
         ``6174544217`` then matches ``+16174544217``, ``16174544217`` AND the
         bare ``6174544217`` form — dropping the country code strictly widens
         the match to every representation of the same NANP number.  Longer
         (12+ digit) or non-leading-1 international strings pass through
         unchanged.
      3. Fewer than 3 digits remaining -> ``ValueError`` ("need at least 3
         digits"); the router maps this to HTTP 422.

    The return value is digits-only by construction, which makes it
    regex-metacharacter-free and safe to interpolate into a LogQL line filter
    (``|~ "<needle>"``) — no anchoring is added anywhere: containment
    semantics are intentional so partials match everything containing them.
    """
    digits = _NON_ASCII_DIGIT_RE.sub("", raw or "")
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if len(digits) < 3:
        raise ValueError("need at least 3 digits")
    return digits


# ---------------------------------------------------------------------------
# SIP text parsing helpers
# ---------------------------------------------------------------------------


def _extract_sip_user(header_value: str) -> str:
    """Extract the user part from a SIP From/To header value.

    Input:  '<sip:+17818510289@67.231.13.185>;tag=gK080ee17c'
    Output: '+17818510289'

    Input:  '"MALDEN MA" <sip:+17818510289@host>'
    Output: '+17818510289'
    """
    match = re.search(r"sip:([^@>]+)@", header_value)
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


# Matches a Via / v header line.  SIP allows the compact form ``v:`` and
# header names are case-insensitive (RFC 3261 §7.3.3).  We capture the header
# value up to the end of the (possibly line-folded) header so a ``branch=``
# param wrapped onto a continuation line is still found.
_VIA_RE = re.compile(
    r"^(?:Via|v)\s*:(?P<value>.*(?:\r?\n[ \t].*)*)",
    re.IGNORECASE | re.MULTILINE,
)
# The branch param within a Via value.  Per RFC 3261 the param name is
# case-insensitive; the token runs until the next param/comma/whitespace.
_VIA_BRANCH_RE = re.compile(r";\s*branch\s*=\s*([^;,\s]+)", re.IGNORECASE)
# The sent-by host[:port] of a Via value: the token following the transport
# (``SIP/2.0/UDP host:port;params``).  Used for hairpin (re-traversal)
# detection — a message carrying the SAME sent-by host in two Vias traversed
# that element twice.
_VIA_SENTBY_RE = re.compile(r"SIP\s*/\s*2\.0\s*/\s*\w+\s+([^;,\s]+)", re.IGNORECASE)


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


def _extract_via_stack(raw_msg: Optional[str]) -> list[tuple[str, str]]:
    """Extract the FULL Via stack as ``[(branch, sent_by_host), ...]``.

    Topmost Via first.  Either element may be "" when unparseable.  Note: a
    single Via header carrying multiple comma-separated values is not split —
    neither Kamailio nor FreeSWITCH emits that form on this platform.

    The stack DEPTH is the hop index of a request (each proxy ADDS a Via as it
    forwards: BW→VIP INVITE has 1 Via, SBC→FS has 2) and the REVERSE hop index
    of a response (the stack SHRINKS as a response retraces: carrier→SBC 200
    has 3 Vias, hairpin VIP→VIP has 2, SBC→FS has 1 — see fixture, B-leg BYE).
    """
    if not raw_msg:
        return []
    stack: list[tuple[str, str]] = []
    for m in _VIA_RE.finditer(raw_msg):
        value = m.group("value")
        b = _VIA_BRANCH_RE.search(value)
        h = _VIA_SENTBY_RE.search(value)
        stack.append(
            (b.group(1).strip() if b else "", h.group(1).strip() if h else "")
        )
    return stack


def _cseq_parts(record: dict[str, Any]) -> tuple[Optional[int], str]:
    """Return ``(cseq_number, cseq_method)`` for a record.

    Falls back to the heplify ``method`` label when the raw CSeq is missing —
    for both requests and responses the method label IS the CSeq method
    (responses carry the transaction's method, e.g. method=INVITE for a 183).
    """
    m = re.match(r"^(\d+)\s+(\S+)", record.get("cseq") or "")
    if m:
        return int(m.group(1)), m.group(2).upper()
    return None, (record.get("method") or "").upper()


# ---------------------------------------------------------------------------
# Deduplication
# ---------------------------------------------------------------------------


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

    NOTE: this key is deliberately NOT the whole story.  The wire src/dst
    endpoints are part of a message's identity too — two rows with the same
    branch key but DIFFERENT directional (src, dst) pairs are two DISTINCT
    wire messages on two different hops and must never merge (observed in
    production 2026-09: same-branch teardown rows on different hops collapsed,
    silently dropping the carrier-side hop from the ladder).  That split is
    enforced by ``_split_cluster_by_hop`` inside ``_deduplicate_results``
    rather than here, because a naive (src, dst) key would ALSO split the
    alias-collapsed ``src == dst`` self-capture away from its directional twin
    and resurrect the orphan-dot bug this identity was designed to fix.
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


# Maximum time difference (in nanoseconds) between two captures of the same
# SIP message to consider them duplicates.
#
# Window re-verified against the ground-truth fixture (2026-06-10 call):
#   * Observed intra-cluster spreads are sub-millisecond, e.g. A-leg 200 OK
#     FS→SBC .716968394000 (HEP) vs .716969202430 (ingest) = 808 µs; B-leg
#     100 Trying .743660000 vs .744163757 = 504 µs; B-leg hairpin BYE-200
#     .898207000 vs .899201658 = 995 µs.
#   * The worst-case skew between a HEP-stamped copy and an ingest-stamped
#     sibling is the ingest lateness itself: 15-20 ms (the A-leg carrier
#     INVITE is stored at .725964951 with a true wire time <= .709698000 =
#     16.3 ms late).  50 ms covers that with 2.5x margin.
#   * The nearest same-identity NON-duplicate is a SIP retransmission, and
#     timer T1 = 500 ms (RFC 3261) keeps retransmits 10x outside the window.
# 50 ms therefore stands.
DEDUP_WINDOW_NS = 50_000_000  # 50 ms


def _split_cluster_by_hop(
    cluster: list[dict[str, Any]],
) -> list[list[dict[str, Any]]]:
    """Split one time-cluster of same-identity rows by directional hop.

    A cluster groups rows sharing (callid, method, status, topmost Via branch)
    within DEDUP_WINDOW_NS.  Normally every row in it is a capture of ONE wire
    message, but two DISTINCT wire messages on two DIFFERENT hops can land in
    the same cluster when the forwarding element's stored copy carries the
    same topmost Via branch (e.g. a trace buffer serialized before the new Via
    was prepended, or an element that forwards without re-branching).  Merging
    those drops a real hop from the ladder — the exact production defect where
    the SBC→carrier teardown leg vanished because its only capture merged into
    the FS→SBC cluster.

    Rules (mirrors the _message_identity contract):
      * rows with a DIRECTIONAL (src, dst) pair are grouped by that exact
        ordered pair — different pairs = different wire messages, never merged;
      * NON-directional rows (src == dst alias collapse, or missing endpoint)
        are per-capture copies that cannot name their hop — each one joins the
        temporally-nearest directional subcluster (preserving the East-fixture
        behavior where a collapsed self-capture merges with its directional
        twin instead of surviving as an orphan dot);
      * a cluster with zero or one distinct directional pair is returned
        unchanged (the overwhelmingly common case — zero-cost).

    Returned subclusters are internally timestamp-sorted and ordered by their
    first timestamp, so downstream survivor election is order-stable.
    """
    by_pair: dict[tuple[str, str], list[dict[str, Any]]] = {}
    nondirectional: list[dict[str, Any]] = []
    for entry in cluster:
        if _is_directional(entry):
            pair = (
                (entry.get("src_ip") or "").strip(),
                (entry.get("dst_ip") or "").strip(),
            )
            by_pair.setdefault(pair, []).append(entry)
        else:
            nondirectional.append(entry)

    if len(by_pair) <= 1:
        return [cluster]

    subclusters = list(by_pair.values())
    for entry in nondirectional:
        ts = entry.get("timestamp_ns", 0)
        nearest = min(
            subclusters,
            key=lambda rows: min(
                abs(ts - r.get("timestamp_ns", 0)) for r in rows
            ),
        )
        nearest.append(entry)

    for rows in subclusters:
        rows.sort(key=lambda r: r.get("timestamp_ns", 0))
    subclusters.sort(key=lambda rows: rows[0].get("timestamp_ns", 0))
    return subclusters


def _deduplicate_results(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Deduplicate SIP messages captured by multiple HEP nodes.

    The same SIP message traversing between Kamailio (capture_id=100) and
    FreeSWITCH (capture_id=200) is captured by both: once on the sender's HEP
    trace and once on the receiver's (plus a Kamailio tm trace_flag duplicate,
    so up to THREE copies per wire message — see the ground-truth fixture).
    These are the same logical message but appear as separate entries with
    different node IDs and timestamps up to ~17 ms apart.  A capture may also
    collapse to ``src_ip == dst_ip`` when the heplify alias script maps both
    endpoints to the same node name — such a row is non-directional and must
    never be the survivor of a group if a directional twin exists (otherwise
    the ladder renders an orphan dot).

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
      3b. Split each time-cluster by directional hop (_split_cluster_by_hop):
         rows with DIFFERENT directional (src, dst) pairs are DISTINCT wire
         messages even under an identical branch identity and each keep their
         own survivor; non-directional (src==dst / endpoint-less) copies still
         merge with their temporally-nearest directional twin.
      4. For each cluster, elect the survivor by PREFERRING a directional
         capture (src != dst); only if NO directional capture exists do we keep
         a src==dst row (so a message is never lost entirely, but a drawable
         hop always wins).  Within the preferred set the survivor is the copy
         with the most TRUSTWORTHY timestamp: HEP-stamped copies (µs precision,
         ts_ns % 1_000 == 0) beat ingest-stamped copies (sub-µs entropy,
         verified 15-20 ms LATE in the fixture), earliest first.  The
         survivor's timestamp is then set to the cluster's elected timestamp:
         the MINIMUM among HEP-stamped copies when any exist, else the cluster
         minimum (ingest stamps are always late, never early, so the minimum
         is the closest available bound on true wire time).  Node IDs from the
         whole cluster are merged into the survivor.

    Guarantees: genuine duplicates collapse to one row; the survivor carries a
    distinct, directional src/dst whenever ANY capture of that message did; a
    src==dst row is emitted only when it is the sole capture of the message;
    the surviving timestamp is never LATER than any trustworthy capture stamp
    of that message.
    """
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

        # For each cluster, split by directional hop FIRST (two distinct wire
        # messages sharing the branch identity must both survive — see
        # _split_cluster_by_hop), then elect a survivor per hop-subcluster
        # and merge node IDs.
        hop_clusters: list[list[dict[str, Any]]] = []
        for cluster in clusters:
            hop_clusters.extend(_split_cluster_by_hop(cluster))

        for cluster in hop_clusters:
            directional = [e for e in cluster if _is_directional(e)]
            # Prefer a directional capture; fall back to non-directional only
            # if none is directional.  Within the pool, prefer HEP-stamped
            # (trustworthy) timestamps, earliest first.
            pool = directional if directional else cluster
            representative = min(
                pool,
                key=lambda e: (
                    not _is_hep_stamped(e.get("timestamp_ns", 0)),
                    e.get("timestamp_ns", 0),
                ),
            )

            # Elect the cluster's representative timestamp: minimum among
            # HEP-stamped copies when any exist (exact capture times), else
            # the cluster minimum (ingest stamps are always LATE, never early,
            # so min is the tightest available bound on true wire time).
            ts_values = [
                e.get("timestamp_ns", 0)
                for e in cluster
                if e.get("timestamp_ns", 0) > 0
            ]
            hep_values = [t for t in ts_values if t % 1_000 == 0]
            if hep_values or ts_values:
                elected_ts = min(hep_values) if hep_values else min(ts_values)
                if elected_ts != representative.get("timestamp_ns"):
                    representative["timestamp_ns"] = elected_ts
                    representative["timestamp"] = _ns_to_iso(elected_ts)

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


# ---------------------------------------------------------------------------
# SIP-causality ordering
# ---------------------------------------------------------------------------


def _order_by_causality(
    messages: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], int, bool]:
    """Order deduplicated messages so SIP causality is never violated.

    Stored timestamps LIE for ingest-stamped rows (15-20 ms late — for the
    A-leg carrier INVITE in the ground-truth fixture EVERY stored copy is
    ingest-stamped, so timestamp sorting puts the INVITE after its own 100
    Trying).  This pass derives the display order from HARD SIP rules and uses
    timestamps only as the tiebreak.  Only hard-rule violations cause
    reordering — when the constraints are already satisfied, the output is
    exactly the timestamp order.

    Hard constraints (edges in a precedence DAG, all scoped to one Call-ID):

      R1  A response never precedes the request that created the transaction
          at the same hop.  Matched via CSeq (number+method) plus the topmost
          Via branch — a response echoes the request's Via stack, so the top
          branch identifies the hop exactly.  Fallback when no branch is
          parseable: swapped src/dst endpoints with a UNIQUE candidate.

      R2  A forwarded copy of a request at hop N+1 never precedes the same
          request at hop N.  Same Call-ID + CSeq + method; hop index = Via
          stack depth (each proxy ADDS a Via).  Chained only when the
          shallower copy's branch list is a proper suffix of the deeper
          copy's — proof they are the same forwarded request.

      R2' A retraced copy of a response at the upstream hop never precedes the
          downstream copy (the Via stack SHRINKS as a response retraces, so
          deeper = earlier).  Applied only for status > 100: 100 Trying is
          hop-by-hop (RFC 3261 §8.2.6 / §16.2 — never forwarded; each element
          generates its own, e.g. Kamailio's 100 at .709698 legitimately
          precedes FreeSWITCH's at .711764 in the fixture) — and only when the
          suffix proof holds.

      R3  ACK never precedes the 2xx it acknowledges (same Call-ID, same CSeq
          number, INVITE transaction).  BYE's 200 never precedes the BYE
          (already covered by R1).

    Ordering = Kahn's topological sort over the DAG with a min-heap keyed on
    (timestamp_ns, input order): every message is emitted at the earliest
    position satisfying causality, and messages without violated constraints
    keep pure timestamp order.  Raw ``timestamp_ns``/``timestamp`` fields are
    NEVER altered here.

    ``ts_corrected`` is set True on each message displayed EARLIER than some
    later message's smaller raw timestamp — i.e. messages whose stored stamp
    is inconsistent with (later than) their causal position.  In the fixture
    this flags exactly the two ingest-stamped A-leg INVITE hops and nothing
    else.

    Returns ``(ordered_messages, n_ts_corrected, cycle_detected)``.  A
    constraint cycle (corrupt/garbled SIP text) cannot occur with well-formed
    edges but is handled defensively: remaining messages are appended in
    timestamp order and the flag is returned so the caller can emit a warning.
    """
    n = len(messages)
    if n <= 1:
        for m in messages:
            m["ts_corrected"] = False
        return list(messages), 0, False

    # Work on a timestamp-sorted copy so heap index tiebreaks ARE ts order.
    msgs = sorted(messages, key=lambda r: r.get("timestamp_ns", 0))

    metas: list[dict[str, Any]] = []
    for i, r in enumerate(msgs):
        stack = _extract_via_stack(r.get("raw_msg"))
        branches = [b for b, _h in stack]
        status = r.get("status")
        num, cmethod = _cseq_parts(r)
        metas.append({
            "idx": i,
            "callid": r.get("callid", ""),
            "is_request": not isinstance(status, int),
            "status": status if isinstance(status, int) else None,
            "method": (r.get("method") or "").upper(),
            "cseq_num": num,
            "cseq_method": cmethod,
            "branches": branches,
            "top": (r.get("via_branch") or (branches[0] if branches else "")),
            "depth": len(stack) or None,
            "src": (r.get("src_ip") or "").strip(),
            "dst": (r.get("dst_ip") or "").strip(),
            "ts": r.get("timestamp_ns", 0),
        })

    adj: list[list[int]] = [[] for _ in range(n)]
    indeg = [0] * n
    edge_set: set[tuple[int, int]] = set()

    def add_edge(a: int, b: int) -> None:
        if a == b or (a, b) in edge_set:
            return
        edge_set.add((a, b))
        adj[a].append(b)
        indeg[b] += 1

    def is_proper_suffix(short: list[str], long_: list[str]) -> bool:
        return 0 < len(short) < len(long_) and long_[-len(short):] == short

    # Group by transaction: (callid, CSeq method, CSeq number).
    req_by_txn: dict[tuple[Any, ...], list[dict[str, Any]]] = {}
    resp_by_txn: dict[tuple[Any, ...], list[dict[str, Any]]] = {}
    for m in metas:
        key = (m["callid"], m["cseq_method"], m["cseq_num"])
        (req_by_txn if m["is_request"] else resp_by_txn).setdefault(key, []).append(m)

    # R1 — response after its request at the same hop.
    #
    # RETRANSMISSION-AWARE: only the EARLIEST matching request copy constrains
    # the response.  A retransmitted request shares the branch identity of the
    # original, and on the wire the response legitimately crosses/precedes the
    # later retransmissions (that crossing is exactly WHY they retransmit).
    # Edging from EVERY copy forced the first 200 to display after the LAST
    # retransmitted BYE, interleaving teardown rounds out of wire order.
    for key, resps in resp_by_txn.items():
        reqs = req_by_txn.get(key, [])
        if not reqs:
            continue
        for resp in resps:
            matched = False
            if resp["top"]:
                cands = [
                    req for req in reqs
                    if req["top"] and req["top"] == resp["top"]
                ]
                if cands:
                    first = min(cands, key=lambda r: (r["ts"], r["idx"]))
                    add_edge(first["idx"], resp["idx"])
                    matched = True
            if not matched and resp["src"] and resp["dst"]:
                # Conservative fallback: swapped endpoints, unique candidate.
                cands = [
                    req for req in reqs
                    if req["src"] == resp["dst"] and req["dst"] == resp["src"]
                ]
                if len(cands) == 1:
                    add_edge(cands[0]["idx"], resp["idx"])

    # R2 — forwarded request copies ordered by Via depth (hop adjacency),
    # chained only with the suffix proof.
    #
    # RETRANSMISSION-AWARE: chain the EARLIEST copy per depth only.  The hard
    # rule is "the first forwarded copy follows the first arrival"; a later
    # retransmission at depth N carries no constraint against the original at
    # depth N+1 (zip-chaining copies pushed the original forwarded BYE at
    # +1 ms after the +500 ms retransmitted first-hop copy).
    for reqs in req_by_txn.values():
        if len(reqs) < 2:
            continue
        earliest_by_depth: dict[int, dict[str, Any]] = {}
        for m in reqs:
            if not m["depth"]:
                continue
            cur = earliest_by_depth.get(m["depth"])
            if cur is None or (m["ts"], m["idx"]) < (cur["ts"], cur["idx"]):
                earliest_by_depth[m["depth"]] = m
        known = sorted(earliest_by_depth.values(), key=lambda m: m["depth"])
        for a, b in zip(known, known[1:]):
            if a["depth"] < b["depth"] and is_proper_suffix(a["branches"], b["branches"]):
                add_edge(a["idx"], b["idx"])

    # R2' — retraced response copies (status > 100 only; the Via stack shrinks
    # toward the UAC, so deeper stack = earlier hop on the return path).
    for resps in resp_by_txn.values():
        by_status: dict[int, list[dict[str, Any]]] = {}
        for m in resps:
            if m["status"] is not None and m["status"] > 100:
                by_status.setdefault(m["status"], []).append(m)
        for group in by_status.values():
            if len(group) < 2:
                continue
            # Earliest copy per depth (retransmitted response copies carry no
            # constraint against the original at the next hop — see R2).
            earliest_resp: dict[int, dict[str, Any]] = {}
            for m in group:
                if not m["depth"]:
                    continue
                cur = earliest_resp.get(m["depth"])
                if cur is None or (m["ts"], m["idx"]) < (cur["ts"], cur["idx"]):
                    earliest_resp[m["depth"]] = m
            known = sorted(earliest_resp.values(), key=lambda m: -m["depth"])
            for a, b in zip(known, known[1:]):
                if a["depth"] > b["depth"] and is_proper_suffix(b["branches"], a["branches"]):
                    add_edge(a["idx"], b["idx"])

    # R3 — ACK never precedes the 2xx it acknowledges.
    twoxx_by_callid: dict[str, list[dict[str, Any]]] = {}
    ack_by_callid: dict[str, list[dict[str, Any]]] = {}
    for m in metas:
        if (
            not m["is_request"]
            and m["status"] is not None
            and 200 <= m["status"] < 300
            and m["cseq_method"] == "INVITE"
        ):
            twoxx_by_callid.setdefault(m["callid"], []).append(m)
        elif m["is_request"] and m["method"] == "ACK":
            ack_by_callid.setdefault(m["callid"], []).append(m)
    for callid, acks in ack_by_callid.items():
        for ok in twoxx_by_callid.get(callid, []):
            for ack in acks:
                if (
                    ok["cseq_num"] is None
                    or ack["cseq_num"] is None
                    or ok["cseq_num"] == ack["cseq_num"]
                ):
                    add_edge(ok["idx"], ack["idx"])

    # Kahn's algorithm with a (timestamp, index) min-heap: each message is
    # emitted at the earliest position satisfying every constraint; with no
    # violated constraints the result IS the timestamp order.
    heap = [(metas[i]["ts"], i) for i in range(n) if indeg[i] == 0]
    heapq.heapify(heap)
    order: list[int] = []
    while heap:
        _ts, i = heapq.heappop(heap)
        order.append(i)
        for j in adj[i]:
            indeg[j] -= 1
            if indeg[j] == 0:
                heapq.heappush(heap, (metas[j]["ts"], j))

    cycle_detected = len(order) < n
    if cycle_detected:
        emitted = set(order)
        order.extend(
            sorted(
                (i for i in range(n) if i not in emitted),
                key=lambda i: (metas[i]["ts"], i),
            )
        )

    ordered = [msgs[i] for i in order]

    # ts_corrected: displayed earlier than a later message's smaller raw
    # timestamp (suffix-min scan; raw timestamps are NOT modified).
    suffix_min: Optional[int] = None
    n_corrected = 0
    for pos in range(n - 1, -1, -1):
        ts = ordered[pos].get("timestamp_ns", 0)
        corrected = suffix_min is not None and ts > suffix_min
        ordered[pos]["ts_corrected"] = corrected
        n_corrected += corrected
        if ts > 0 and (suffix_min is None or ts < suffix_min):
            suffix_min = ts

    return ordered, n_corrected, cycle_detected


# ---------------------------------------------------------------------------
# Hairpin marking
# ---------------------------------------------------------------------------


def _mark_hairpins(messages: list[dict[str, Any]]) -> int:
    """Set ``hairpin: bool`` on every message; return the count flagged.

    Hairpin rows are GENUINE wire packets — the SBC sending in-dialog
    requests/responses to ITSELF via the loopback NLB VIP (fixture: the B-leg
    BYE appears 3x as it retraces FS→SBC-1, VIP→VIP, SBC-1→BW-DAL with
    progressively deeper Via stacks).  They are kept in the data and flagged
    so the UI can collapse/toggle them.

    A message is hairpin when:
      1. src_ip == dst_ip (non-empty) — the direct loopback signature; OR
      2. it is a re-traversal COPY detectable via a duplicated own-Via: its
         Via stack contains the same sent-by host twice AND a same-transaction
         sibling with a strictly DEEPER stack exists (i.e. the message was
         forwarded again afterwards).  The deeper-sibling condition keeps the
         FINAL egress (e.g. the SBC→BW-DAL BYE, which legitimately carries TWO
         SBC Vias proving the double traversal) visible — only intermediate
         re-traversal copies are collapsible.
    """
    metas: list[tuple[dict[str, Any], list[tuple[str, str]], tuple[Any, ...], int]] = []
    deepest: dict[tuple[Any, ...], int] = {}
    for m in messages:
        stack = _extract_via_stack(m.get("raw_msg"))
        num, cmethod = _cseq_parts(m)
        status = m.get("status")
        key = (
            m.get("callid", ""),
            cmethod,
            num,
            status if isinstance(status, int) else None,
            not isinstance(status, int),
        )
        depth = len(stack)
        metas.append((m, stack, key, depth))
        if depth:
            deepest[key] = max(deepest.get(key, 0), depth)

    count = 0
    for m, stack, key, depth in metas:
        src = (m.get("src_ip") or "").strip()
        dst = (m.get("dst_ip") or "").strip()
        hairpin = bool(src) and src == dst
        if not hairpin and depth >= 2:
            hosts = [h for _b, h in stack if h]
            if len(set(hosts)) < len(hosts) and depth < deepest.get(key, depth):
                hairpin = True
        m["hairpin"] = hairpin
        count += hairpin
    return count


# ---------------------------------------------------------------------------
# Pipeline entry point
# ---------------------------------------------------------------------------


def _finalize_pipeline(
    results: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[str]]:
    """Run the full post-processing pipeline on raw parsed capture records.

    dedup -> SIP-causality ordering -> hairpin marking -> seq assignment.

    Returns ``(messages, pipeline_warnings)`` where messages are in
    authoritative display order and each carries the additive contract fields:

      node          str  — capture id(s), e.g. "100" or "100,200" when the
                           same wire message was seen by multiple captures
      hairpin       bool — loopback/re-traversal copy (UI may collapse)
      ts_corrected  bool — displayed earlier than its stored (late) timestamp
      seq           int  — authoritative display order, 0..n-1

    Existing fields are unchanged; raw timestamps are never rewritten by the
    ordering pass (only dedup survivor election may adopt a sibling capture's
    more trustworthy stamp).
    """
    warnings: list[str] = []
    ingest_stamped = sum(
        1
        for r in results
        if r.get("timestamp_ns", 0) > 0 and not _is_hep_stamped(r["timestamp_ns"])
    )

    data = _deduplicate_results(results)
    data, n_reordered, cycle_detected = _order_by_causality(data)
    _mark_hairpins(data)

    for i, m in enumerate(data):
        m["seq"] = i
        m["node"] = str(m.get("node", "") or "")

    if n_reordered:
        warnings.append(f"{n_reordered} messages reordered for SIP causality")
    if ingest_stamped:
        warnings.append(f"{ingest_stamped} ingest-stamped rows detected")
    if cycle_detected:
        warnings.append(
            "causality constraint cycle detected; affected messages kept in timestamp order"
        )
    return data, warnings
