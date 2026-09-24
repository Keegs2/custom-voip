"""A/B leg correlation on POST /v1/homer/search (and its pure helpers).

Background (2026-09): number search split every forwarded call into separate
A and B "calls". Every B-leg INVITE (each failover attempt, its own Call-ID)
carries ``X-CID: <A-leg SIP Call-ID>``, but heplify's Loki ``call_id`` label is
the packet's OWN Call-ID, and the old window-wide ``|~ "X-CID:"`` qryn scan was
capped at 1000 rows platform-wide, skipped >50 Call-IDs and swallowed errors.

Contract pinned here (the UI builds to it):
  * legs: {callid: {role "A"|"B", a_callid, attempt}} for every Call-ID in data
  * correlation_status ok|partial|degraded + correlation_reason
  * correlations keeps its shape (every Call-ID -> sorted whole group)
  * the qryn query list NEVER contains an X-CID scan

Two layers:
  1) PURE — routers/homer_correlation.py loaded by file path (stdlib only).
  2) ENDPOINT — the REAL router behind the REAL JWT middleware; qryn served
     from a store-backed Loki mock (Step 1 = rows whose text contains the
     needle, like the real ``|~`` filter), ClickHouse by the shared
     FakeClickHouse (answers the router's REAL SQL), PostgreSQL by FakeCDR.

Run:  JWT_SECRET_KEY=x python3 -m pytest tests/test_homer_leg_correlation.py -q
"""
import asyncio
import importlib.util
import json
import os
import pathlib
import sys
import time

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
os.environ.setdefault("ENV", "development")
os.environ.setdefault("QRYN_URL", "http://127.0.0.1:1")
os.environ.setdefault("CLICKHOUSE_URL", "http://127.0.0.1:1")

REPO = pathlib.Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
sys.path.insert(0, str(API_SRC))
sys.path.insert(0, str(REPO / "tests"))

from homer_ch_fake import FakeCDR, FakeClickHouse, ch_row, literals  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "homer_correlation", API_SRC / "routers" / "homer_correlation.py")
hc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hc)


# ===========================================================================
# Layer 1 — pure helpers
# ===========================================================================

def _inv(callid, xcid_line=None, extra=""):
    lines = [
        "INVITE sip:+17744045256@10.142.0.250:5060 SIP/2.0",
        "Via: SIP/2.0/UDP 34.139.119.135:5090;branch=z9hG4bKx",
        f"Call-ID: {callid}",
        "CSeq: 1 INVITE",
    ]
    if extra:
        lines.append(extra)
    if xcid_line is not None:
        lines.append(xcid_line)
    lines.append("Content-Length: 0")
    return "\r\n".join(lines) + "\r\n\r\n"


@pytest.mark.parametrize("line,expected", [
    ("X-CID: a1@67.231.13.185", "a1@67.231.13.185"),
    ("x-cid: a1@67.231.13.185", "a1@67.231.13.185"),       # header name case
    ("X-Cid:a1@67.231.13.185", "a1@67.231.13.185"),        # no space
    ("X-CID:\ta1@67.231.13.185", "a1@67.231.13.185"),      # HTAB
    ("X-CID: a1@67.231.13.185   ", "a1@67.231.13.185"),    # trailing spaces
    ("X-CID: a1@67.231.13.185 \t", "a1@67.231.13.185"),    # trailing mixed ws
    ("X-CID:    ", None),                                  # blank value
])
def test_extract_xcid_header_grammar(line, expected):
    assert hc.extract_xcid(_inv("b1", line)) == expected


def test_extract_xcid_crlf_does_not_leak_into_value():
    msg = _inv("b1", "X-CID: a1@h")
    assert "\r" not in hc.extract_xcid(msg)
    # LF-only line endings (some capture paths) work too.
    assert hc.extract_xcid(msg.replace("\r\n", "\n")) == "a1@h"


@pytest.mark.parametrize("extra", [
    "Subject: see X-CID: evil@h",                # inside another header value
    "X-Other: foo;X-CID: evil@h",
    "P-Note:X-CID: evil@h",
    " X-CID: evil@h",                            # not at line start (folded)
    "XX-CID: evil@h",
])
def test_extract_xcid_not_at_line_start_never_matches(extra):
    assert hc.extract_xcid(_inv("b1", extra=extra)) is None


def test_extract_xcid_first_header_wins_and_other_header_ignored():
    msg = _inv("b1", "X-CID: real@h", extra="Subject: X-CID: evil@h")
    assert hc.extract_xcid(msg) == "real@h"


def test_python_and_clickhouse_patterns_agree():
    # The RE2 pattern shipped to ClickHouse must be the Python pattern plus
    # inline flags — same header grammar on both sides.
    assert hc.CH_XCID_PATTERN == "(?mi)" + hc.XCID_HEADER_RE.pattern
    assert hc.XCID_HEADER_RE.flags & 0x0A == 0x0A  # IGNORECASE | MULTILINE


def test_harvest_only_from_invite_requests():
    recs = [
        {"callid": "b1", "raw_msg": _inv("b1", "X-CID: a1")},
        # a RESPONSE echoing X-CID must not create a mapping
        {"callid": "b2", "raw_msg": "SIP/2.0 200 OK\r\nX-CID: a1\r\n\r\n"},
        # self-reference ignored
        {"callid": "a1", "raw_msg": _inv("a1", "X-CID: a1")},
        {"callid": "", "raw_msg": _inv("", "X-CID: a1")},
    ]
    assert hc.harvest_xcid(recs) == {"b1": "a1"}


@pytest.mark.parametrize("value,literal", [
    ("a1@h", "'a1@h'"),
    ("it's", "'it\\'s'"),
    ("back\\slash", "'back\\\\slash'"),
    ("trail\\", "'trail\\\\'"),            # cannot swallow the closing quote
    ("cr\r\nlf", "'cr\\r\\nlf'"),
])
def test_ch_quote_escapes(value, literal):
    assert hc.ch_quote(value) == literal
    assert literals(hc.ch_quote(value)) == [value]   # ClickHouse-rule round trip


@pytest.mark.parametrize("cid,ok", [
    ("a1@67.231.13.185", True), ("7523baca-df89-123f", True),
    ("", False), ("x\r\ny", False), ("nul\x00", False), ("é@h", False),
    ("x" * 513, False), (None, False),
])
def test_is_safe_callid(cid, ok):
    assert hc.is_safe_callid(cid) is ok


S = 1_000_000_000


def _r(ts, raw=None, status=None, cseq="1 INVITE"):
    return {"timestamp_ns": ts, "raw_msg": raw, "status": status, "cseq": cseq}


def test_a_leg_window_invite_to_first_final_plus_slack():
    t0 = 1000 * S
    recs = [
        _r(t0 + S // 1000, "SIP/2.0 100 Trying\r\n", 100),
        _r(t0, "INVITE sip:x SIP/2.0\r\n"),
        _r(t0 + 3 * S, "SIP/2.0 407 Proxy Auth\r\n", 407),   # challenge ignored
        _r(t0 + 5 * S, "SIP/2.0 200 OK\r\n", 200),
        _r(t0 + 5 * S + 1, "SIP/2.0 200 OK\r\n", 200),
        _r(t0 + 90 * S, "SIP/2.0 200 OK\r\n", 200, cseq="2 BYE"),
    ]
    assert hc.a_leg_window(recs, open_end_ns=10**20) == (t0 - S, t0 + 7 * S)


def test_a_leg_window_in_progress_is_bounded_not_search_end():
    # No final seen: the window is capped at first INVITE + 5 min (every B
    # attempt launches within the SBC x carrier budget) -- never a scan to the
    # end of a 24 h search.
    t0 = 1000 * S
    recs = [_r(t0, "INVITE sip:x SIP/2.0\r\n"), _r(t0 + S, "SIP/2.0 180 Ringing\r\n", 180)]
    assert hc.a_leg_window(recs, open_end_ns=t0 + 3600 * S) == (t0 - S, t0 + 300 * S)
    # ... and still never past the search end
    assert hc.a_leg_window(recs, open_end_ns=t0 + 60 * S) == (t0 - S, t0 + 60 * S)


def test_a_leg_window_no_timestamps():
    assert hc.a_leg_window([{"timestamp_ns": 0}], 10) is None


def test_merge_windows():
    assert hc.merge_windows([(5, 9), (1, 3), (2, 6), (20, 30)]) == [(1, 9), (20, 30)]


def test_xcid_scan_sql_is_bounded_and_escaped():
    sql = hc.build_xcid_scan_sql("qryn", ["a1@h", "o'brien\\x"], [(10, 20), (30, 40)])
    assert "(timestamp_ns >= 10 AND timestamp_ns < 20) OR (timestamp_ns >= 30 AND timestamp_ns < 40)" in sql
    assert "multiSearchAny(string, ['a1@h', 'o\\'brien\\\\x'])" in sql
    assert "FROM qryn.samples_v3" in sql and "HAVING xcid != ''" in sql
    with pytest.raises(ValueError):
        hc.build_xcid_scan_sql("qryn", [], [(1, 2)])


def test_parse_xcid_scan_exact_match_only():
    text = "\n".join(json.dumps(r) for r in [
        {"fp": "11", "xcid": "a1@h  ", "hdr_callid": "b1 ", "first_ns": "5"},
        {"fp": "12", "xcid": "a1@h.evil", "hdr_callid": "b9", "first_ns": "5"},
        {"fp": "13", "xcid": "zz", "hdr_callid": "b8", "first_ns": "5"},
    ])
    hits = hc.parse_xcid_scan(text, {"a1@h"})
    assert [(h.fingerprint, h.xcid, h.hdr_callid) for h in hits] == [(11, "a1@h", "b1")]


def test_build_groups_attempt_order_and_cdr_all_or_nothing():
    g = hc.LegGraph()
    for b in ("b-late", "b-early"):
        g.add(b, "A")
    recs = {
        "b-late": [{"timestamp_ns": 300, "raw_msg": "INVITE x SIP/2.0\r\n"}],
        "b-early": [{"timestamp_ns": 100, "raw_msg": "INVITE x SIP/2.0\r\n"}],
    }
    corr, legs = hc.build_groups(["A", "b-late", "b-early"], g, recs)
    assert corr["A"] == corr["b-late"] == ["A", "b-early", "b-late"]
    assert legs["A"] == {"role": "A", "a_callid": "A", "attempt": None}
    assert legs["b-early"]["attempt"] == 1 and legs["b-late"]["attempt"] == 2
    # Only ONE B has a CDR attempt -> ordinal numbering kept (no collisions).
    g.cdr_attempt["b-late"] = 1
    _c, legs = hc.build_groups(["A", "b-late", "b-early"], g, recs)
    assert legs["b-early"]["attempt"] == 1 and legs["b-late"]["attempt"] == 2
    # Every B has one -> CDR leg_attempt wins.
    g.cdr_attempt["b-early"] = 2
    _c, legs = hc.build_groups(["A", "b-late", "b-early"], g, recs)
    assert legs["b-late"]["attempt"] == 1 and legs["b-early"]["attempt"] == 2


def test_leg_graph_root_is_loop_safe():
    g = hc.LegGraph()
    g.add("x", "y")
    g.add("y", "x")
    assert g.root("x") in ("x", "y")


def test_health_status():
    h = hc.CorrelationHealth()
    assert (h.status, h.reason) == ("ok", None)
    h.add("cdr_unavailable")
    h.add("cdr_unavailable")
    assert (h.status, h.reason) == ("partial", "cdr_unavailable")
    h.add("timeout")
    h.degraded = True
    assert (h.status, h.reason) == ("degraded", "cdr_unavailable,timeout")


# ===========================================================================
# Layer 2 — endpoint scenarios
# ===========================================================================

try:
    import fastapi  # noqa: F401
    import httpx
    _WEB = True
except ImportError:  # pragma: no cover
    httpx = None
    _WEB = False

needs_web = pytest.mark.skipif(not _WEB, reason="fastapi/httpx required")
_REAL_ASYNC_CLIENT = httpx.AsyncClient if _WEB else None
_LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


# Search window: the last 2 hours (fixtures sit 1h ago).
NOW = int(time.time())
T0 = (NOW - 3600) * S
START_ISO = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(NOW - 7200))
END_ISO = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(NOW))
MS = 1_000_000

CALLER = "+15087282017"
DID = "+16174544217"
FWD = "+17744045256"


def sip(first, cid, frm, to, cseq, branch, xcid=None):
    hdrs = [
        first,
        f"Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK{branch}",
        f"From: <sip:{frm}@h>;tag=f{branch}",
        f"To: <sip:{to}@h>",
        f"Call-ID: {cid}",
        f"CSeq: {cseq}",
    ]
    if xcid:
        hdrs.append(f"X-CID: {xcid}")
    hdrs.append("Content-Length: 0")
    return "\r\n".join(hdrs) + "\r\n\r\n"


def a_leg(cid, t0, frm=CALLER, final=200):
    """Carrier -> VIP -> SBC -> FS inbound leg, answered (or failed) at +5 s."""
    inv = sip(f"INVITE sip:{DID}@34.24.133.82 SIP/2.0", cid, frm, DID, "1 INVITE", f"a{cid}")
    fin = sip(f"SIP/2.0 {final} X", cid, frm, DID, "1 INVITE", f"a{cid}")
    bye = sip(f"BYE sip:{DID}@h SIP/2.0", cid, frm, DID, "2 BYE", f"ab{cid}")
    return [
        ch_row(cid, t0, "BW-ATL", "SBC-VIP", inv),
        ch_row(cid, t0 + 1 * MS, "SBC-1", "FreeSWITCH", inv, dport="5080"),
        ch_row(cid, t0 + 5 * S, "FreeSWITCH", "SBC-1", fin, node="200",
               response=str(final)),
        ch_row(cid, t0 + 5 * S + 1 * MS, "SBC-VIP", "BW-ATL", fin, response=str(final)),
        ch_row(cid, t0 + 60 * S, "BW-ATL", "SBC-VIP", bye, method="BYE"),
    ]


def b_leg(cid, a_cid, t_inv, final, frm=CALLER, with_invite=True, xcid_ok=True):
    """FS -> SigVIP -> SBC -> carrier bridge attempt (own Call-ID, X-CID)."""
    inv = sip(f"INVITE sip:{FWD}@10.142.0.250 SIP/2.0", cid, frm, FWD, "1 INVITE",
              f"b{cid}", xcid=a_cid if xcid_ok else None)
    fin = sip(f"SIP/2.0 {final} X", cid, frm, FWD, "1 INVITE", f"b{cid}")
    rows = []
    if with_invite:
        rows += [
            ch_row(cid, t_inv, "FreeSWITCH", "SBC-SigVIP", inv, sport="5090", node="200"),
            ch_row(cid, t_inv + 1 * MS, "SBC-VIP", "BW-DAL", inv),
        ]
    rows += [
        ch_row(cid, t_inv + 200 * MS, "BW-DAL", "SBC-VIP", fin, response=str(final)),
        ch_row(cid, t_inv + 201 * MS, "SBC-SigVIP", "FreeSWITCH", fin,
               response=str(final)),
    ]
    if final == 200:
        bye = sip(f"BYE sip:{FWD}@h SIP/2.0", cid, frm, FWD, "2 BYE", f"bb{cid}")
        rows.append(ch_row(cid, T0 + 60 * S + 2 * MS, "SBC-VIP", "BW-DAL", bye,
                           method="BYE"))
    return rows


def loki_from_rows(rows, needles):
    """Step-1 emulation: rows whose text contains EVERY needle (LogQL |~ AND),
    newest first, grouped into Loki streams by label set."""
    hits = [r for r in rows if all(n in r["msg"] for n in needles)]
    hits.sort(key=lambda r: r["timestamp_ns"], reverse=True)
    streams = {}
    for r in hits:
        streams.setdefault(r["labels"], []).append([str(r["timestamp_ns"]), r["msg"]])
    return {"data": {"result": [
        {"stream": json.loads(lab), "values": vals} for lab, vals in streams.items()]}}


class Upstream:
    def __init__(self, rows, ch_fail=()):
        self.rows = rows
        self.ch = FakeClickHouse(fail=ch_fail)
        self.ch.add(rows)
        self.loki_queries = []

    def _handle(self, request):
        if "/loki/api/v1/query_range" in request.url.path:
            q = request.url.params["query"]
            self.loki_queries.append(q)
            needles = [p.split('"')[1] for p in q.split("|~")[1:]]
            return httpx.Response(200, json=loki_from_rows(self.rows, needles))
        code, text = self.ch.handle(request.content.decode(), dict(request.url.params))
        return httpx.Response(code, text=text)

    def factory(self, *a, **kw):
        return _REAL_ASYNC_CLIENT(transport=httpx.MockTransport(self._handle))


@pytest.fixture(scope="module")
def api():
    if not _WEB:
        pytest.skip("fastapi/httpx required")
    try:
        from fastapi import FastAPI
        from middleware.auth import JWTAuthMiddleware
        from auth.security import create_access_token
        from routers import homer as homer_mod
    except ImportError as exc:  # pragma: no cover
        pytest.skip(f"API deps missing: {exc}")
    app = FastAPI()
    app.add_middleware(JWTAuthMiddleware)
    app.include_router(homer_mod.router, prefix="/v1/homer")
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://test")
    token = create_access_token(
        {"sub": "2", "email": "s@test.local", "role": "support", "customer_id": None})
    try:
        yield {"client": client, "homer": homer_mod,
               "auth": {"Authorization": f"Bearer {token}"}}
    finally:
        _run(client.aclose())


def search(api, monkeypatch, rows, number, cdr=None, ch_fail=()):
    up = Upstream(rows, ch_fail=ch_fail)
    monkeypatch.setattr(api["homer"].httpx, "AsyncClient", up.factory)
    cdr = cdr if cdr is not None else FakeCDR()
    monkeypatch.setattr(api["homer"].db, "fetch_all", cdr.fetch_all)
    r = _run(api["client"].post("/v1/homer/search", headers=api["auth"], json={
        "number": number, "start_time": START_ISO, "end_time": END_ISO}))
    assert r.status_code == 200, r.text
    return r.json(), up, cdr


def _statuses(body, cid):
    return {m["status"] for m in body["data"] if m["callid"] == cid}


A = "218382592_122992403@67.231.13.185"
B1 = "7523baca-df89-123f-0b87-4201c0a80a02"
B2 = "8634cbdb-e09a-234f-1c98-5312d1b91b13"


def failover_call(frm_b=CALLER, t0=T0):
    """A answered at +5 s; B1 = 503 (attempt 1), B2 = 200 (attempt 2)."""
    return (a_leg(A, t0)
            + b_leg(B1, A, t0 + 100 * MS, 503, frm=frm_b)
            + b_leg(B2, A, t0 + 400 * MS, 200, frm=frm_b))


def _assert_one_failover_group(body):
    group = sorted([A, B1, B2])
    for cid in group:
        assert body["correlations"][cid] == group
    assert body["legs"][A] == {"role": "A", "a_callid": A, "attempt": None}
    assert body["legs"][B1] == {"role": "B", "a_callid": A, "attempt": 1}
    assert body["legs"][B2] == {"role": "B", "a_callid": A, "attempt": 2}
    assert set(body["legs"]) == {m["callid"] for m in body["data"]}
    # B rows carry their responses — the RESULT/DURATION "—" symptom is gone.
    assert 503 in _statuses(body, B1)
    assert 200 in _statuses(body, B2)
    assert any(m["callid"] == B2 and m["method"] == "BYE" for m in body["data"])


@needs_web
def test_search_forwarded_to_number_groups_via_b_invite_xcid(api, monkeypatch):
    # Searching the FORWARDED-TO number: Step 1 contains only B-leg messages.
    # The B INVITE's X-CID pulls the A leg (a), whose window scan finds the
    # sibling attempt (b).  No qryn X-CID scan anywhere.
    body, up, _cdr = search(api, monkeypatch, failover_call(), FWD)
    _assert_one_failover_group(body)
    assert up.loki_queries == ['{type="sip"} |~ "7744045256"']
    assert all("X-CID" not in q for q in up.loki_queries)
    assert body["correlation_status"] == "ok", body["correlation_reason"]
    assert body["correlation_reason"] is None
    assert "correlation_truncated" not in body


@needs_web
def test_search_did_failover_two_attempts_one_group(api, monkeypatch):
    # Searching the DID: Step 1 = A leg only; both B attempts come from the
    # bounded ClickHouse scan -> ONE group of 3 with attempts 1/2.
    body, up, cdr = search(api, monkeypatch, failover_call(), DID)
    _assert_one_failover_group(body)
    assert all("X-CID" not in q for q in up.loki_queries)
    scans = [sql for k, sql, _p in up.ch.calls if k == "scan"]
    assert len(scans) == 1
    # Tightly bounded: [A INVITE - 1 s, A final (+5 s) + 2 s).
    assert f"timestamp_ns >= {T0 - S} AND timestamp_ns < {T0 + 5 * S + 2 * S}" in scans[0]
    # The ClickHouse execution cap rides as a URL setting.
    assert [p for k, _s, p in up.ch.calls if k == "scan"][0]["max_execution_time"]
    assert cdr.calls and cdr.calls[0][1][0] == [A]


@needs_web
def test_search_masked_caller_finds_b_legs(api, monkeypatch):
    # Masked caller: the B legs present the DID as From, so searching the
    # CALLER matches only the A leg — the scan must still find both Bs.
    rows = failover_call(frm_b=DID)
    body, _up, _cdr = search(api, monkeypatch, rows, CALLER)
    _assert_one_failover_group(body)


@needs_web
def test_search_clickhouse_failure_is_degraded_not_an_error(api, monkeypatch):
    body, _up, _cdr = search(api, monkeypatch, failover_call(), DID,
                             ch_fail={"scan", "fetch"})
    assert body["correlation_status"] == "degraded"
    assert "clickhouse_error" in body["correlation_reason"]
    # Step-1 rows are still returned, as an ungrouped A call.
    assert {m["callid"] for m in body["data"]} == {A}
    assert body["legs"] == {A: {"role": "A", "a_callid": A, "attempt": None}}


@needs_web
def test_search_scan_failure_alone_is_degraded(api, monkeypatch):
    body, _up, _cdr = search(api, monkeypatch, failover_call(), DID, ch_fail={"scan"})
    assert body["correlation_status"] == "degraded"
    assert body["data"]


@needs_web
def test_search_cdr_unavailable_is_partial(api, monkeypatch):
    body, _up, _cdr = search(api, monkeypatch, failover_call(), DID,
                             cdr=FakeCDR(fail=True))
    _assert_one_failover_group(body)          # ClickHouse carried it
    assert body["correlation_status"] == "partial"
    assert body["correlation_reason"] == "cdr_unavailable"


@needs_web
def test_search_cdr_only_discovery_when_invite_capture_lost(api, monkeypatch):
    # B2's INVITE was never captured (no X-CID anywhere): only its responses
    # and BYE exist.  The CDR B row (uuid == B SIP Call-ID) finds it; the
    # attempt numbers come from CDR leg_attempt (every B has one).
    rows = (a_leg(A, T0)
            + b_leg(B1, A, T0 + 100 * MS, 503)
            + b_leg(B2, A, T0 + 400 * MS, 200, with_invite=False))
    cdr = FakeCDR([
        {"uuid": B1, "call_id": A, "leg_attempt": 1},
        {"uuid": B2, "call_id": A, "leg_attempt": 2},
    ])
    body, _up, _cdr = search(api, monkeypatch, rows, DID, cdr=cdr)
    assert body["correlations"][B2] == sorted([A, B1, B2])
    assert body["legs"][B2] == {"role": "B", "a_callid": A, "attempt": 2}
    assert body["legs"][B1]["attempt"] == 1
    assert 200 in _statuses(body, B2)
    assert body["correlation_status"] == "ok"


@needs_web
def test_search_more_than_50_calls_still_correlates(api, monkeypatch):
    # The old path skipped correlation above 50 Call-IDs. 60 forwarded calls
    # (120 Call-IDs) -> every one grouped; the scan is chunked (<= 50 A
    # Call-IDs per ClickHouse query).
    rows = []
    for i in range(60):
        a, b = f"a{i:03d}@67.231.13.185", f"b{i:03d}-uuid"
        t = T0 + i * 20 * S
        rows += a_leg(a, t)[:3] + b_leg(b, a, t + 100 * MS, 200)[:3]
    body, up, _cdr = search(api, monkeypatch, rows, DID)
    for i in range(60):
        a, b = f"a{i:03d}@67.231.13.185", f"b{i:03d}-uuid"
        assert body["correlations"][a] == sorted([a, b]), i
        assert body["legs"][b] == {"role": "B", "a_callid": a, "attempt": 1}
    scans = [sql for k, sql, _p in up.ch.calls if k == "scan"]
    assert len(scans) == 2
    assert all(len(literals(s.split("multiSearchAny(string, [", 1)[1].split("])", 1)[0])) <= 50
               for s in scans)
    assert body["correlation_status"] == "ok", body["correlation_reason"]


@needs_web
def test_search_cap_is_reported_not_silent(api, monkeypatch):
    monkeypatch.setattr(api["homer"], "MAX_CORRELATE_A_CALLS", 2)
    rows = []
    for i in range(3):
        a, b = f"a{i}@h", f"b{i}-uuid"
        rows += a_leg(a, T0 + i * 20 * S)[:3] + b_leg(b, a, T0 + i * 20 * S + 100 * MS, 200)[:3]
    body, _up, _cdr = search(api, monkeypatch, rows, DID)
    assert body["correlation_status"] == "partial"
    assert body["correlation_reason"] == "cap_reached:2"
    assert body["correlation_truncated"] is True          # deprecated flag
    # The two NEWEST A calls were correlated.
    assert body["legs"]["b2-uuid"]["a_callid"] == "a2@h"
    assert body["legs"]["b1-uuid"]["a_callid"] == "a1@h"


@needs_web
def test_search_leg_fetch_paginates_past_chunk_limit(api, monkeypatch):
    # A chunk that fills its row limit is paginated (timestamp cursor), not
    # silently truncated: 14 stored rows through 5-row pages.
    monkeypatch.setattr(api["homer"], "FETCH_CHUNK_LIMIT", 5)
    body, up, _cdr = search(api, monkeypatch, failover_call(), DID)
    _assert_one_failover_group(body)
    assert body["correlation_status"] == "ok", body["correlation_reason"]
    assert sum(1 for k, _s, _p in up.ch.calls if k == "fetch") >= 3


@needs_web
def test_search_leg_fetch_hard_cap_is_reported(api, monkeypatch):
    monkeypatch.setattr(api["homer"], "FETCH_CHUNK_LIMIT", 3)
    monkeypatch.setattr(api["homer"], "FETCH_MAX_PAGES", 1)
    body, _up, _cdr = search(api, monkeypatch, failover_call(), DID)
    assert body["correlation_status"] == "partial"
    assert "fetch_cap_reached:3" in body["correlation_reason"]
    assert body["correlation_truncated"] is True


@needs_web
def test_search_single_leg_call_is_ok_and_self_grouped(api, monkeypatch):
    body, up, _cdr = search(api, monkeypatch, a_leg(A, T0, final=486), DID)
    assert body["correlations"] == {A: [A]}
    assert body["legs"] == {A: {"role": "A", "a_callid": A, "attempt": None}}
    assert body["correlation_status"] == "ok"
    # No multi-leg group -> no leg refetch at all (just the bounded scan).
    assert [k for k, _s, _p in up.ch.calls] == ["scan"]
