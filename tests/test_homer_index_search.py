"""Indexed number search (C-IDX-1..3) on POST /v1/homer/search + capabilities.

Contract (2026-11-03, shared with TED):
  * GET /v1/homer/search/capabilities -> {number_index, index_covered_from,
    max_scan_hours: 24, max_window_days: 7}; support/admin; cached <= 60 s.
  * POST /v1/homer/search adds search_path ("call_id"|"index"|"scan"),
    index_covered_from, max_scan_hours to every 200.
  * Number search: index when it covers start_time; else the qryn scan only
    for windows <= 24 h; else 422 {"code": "window_too_wide"}. A ClickHouse
    limit -> 422 {"code": "search_too_broad"}. Never an OOM.
  * Every user value reaches ClickHouse as a query parameter; needles are
    digit-validated; index requests run readonly=2 with caps.

Two layers:
  1) PURE — routers/homer_index.py loaded by file path (stdlib only): SQL
     builders, coverage, error classification, hostile input.
  2) ENDPOINT — the REAL router behind the REAL JWT middleware. qryn is a
     store-backed Loki mock; ClickHouse is FakeClickHouse extended with the
     number index, whose rows are derived from the stored SIP by a Python
     mirror of the MV (the MV itself is proven against a real ClickHouse by
     scripts/homer/test_sip_number_index_clickhouse.py).

Run:  JWT_SECRET_KEY=x python3 -m pytest tests/test_homer_index_search.py -q
"""
import asyncio
import importlib.util
import json
import os
import pathlib
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
os.environ.setdefault("ENV", "development")
os.environ.setdefault("QRYN_URL", "http://127.0.0.1:1")
os.environ.setdefault("CLICKHOUSE_URL", "http://127.0.0.1:1")

REPO = pathlib.Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
sys.path.insert(0, str(API_SRC))
sys.path.insert(0, str(REPO / "tests"))

from homer_ch_fake import FakeCDR, FakeClickHouse, ch_row  # noqa: E402


def _load(name, rel):
    spec = importlib.util.spec_from_file_location(name, API_SRC / "routers" / rel)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


hx = _load("homer_index_pure", "homer_index.py")
hp = _load("homer_pipeline_pure", "homer_pipeline.py")

S = 1_000_000_000
MS = 1_000_000
DAY = 86400 * S


# ===========================================================================
# Layer 1 — pure helpers
# ===========================================================================

W0 = int(datetime(2026, 11, 1, 0, 0, tzinfo=timezone.utc).timestamp()) * S
W1 = int(datetime(2026, 11, 3, 12, 0, tzinfo=timezone.utc).timestamp()) * S


def test_lookup_sql_is_constant_text_with_typed_placeholders():
    q = hx.build_lookup("qryn", [("number", "5087282017")], W0, W1, 51)
    assert q.sql == (
        "SELECT call_id, toString(min(first_ns)) AS f_ns, toString(max(last_ns)) AS l_ns "
        "FROM qryn.sip_number_index "
        # Explicit PREWHERE: ClickHouse 23.3 would otherwise move `day` there
        # and read every column of every row in the window.
        "PREWHERE (number = {n0:String}) "
        "WHERE day >= {d0:Date} AND day <= {d1:Date} "
        "GROUP BY call_id "
        "HAVING max(last_ns) >= {lo:Int64} AND min(first_ns) < {hi:Int64} "
        "ORDER BY min(first_ns) DESC, call_id DESC "
        "LIMIT {lim:UInt32} "
        "FORMAT JSONEachRow"
    )
    assert q.params == {
        "param_d0": "2026-11-01", "param_d1": "2026-11-03",
        "param_lo": str(W0), "param_hi": str(W1), "param_lim": "51",
        "param_n0": "5087282017",          # a full number: exact, primary key
    }
    assert "5087282017" not in q.sql   # the needle never enters the SQL text


@pytest.mark.parametrize("needle,cond,param", [
    ("508", "number LIKE {n0:String}", "%508%"),
    ("508728201", "number LIKE {n0:String}", "%508728201%"),     # 9 digits: partial
    ("5087282017", "number = {n0:String}", "5087282017"),        # 10: exact
    ("442079460958", "number = {n0:String}", "442079460958"),    # international: exact
])
def test_full_numbers_are_exact_partials_are_substring(needle, cond, param):
    q = hx.build_lookup("qryn", [("number", needle)], W0, W1, 5)
    assert f"PREWHERE ({cond}) WHERE day" in q.sql and q.params["param_n0"] == param


def test_lookup_roles_and_semantics():
    q = hx.build_lookup("qryn", [("from_user", "617"), ("to_user", "774"), ("number", "5256")],
                        W0, W1, 10)
    assert "(number LIKE {n0:String} AND role IN ('from', 'pai'))" in q.sql
    assert "(number LIKE {n1:String} AND role IN ('to', 'ruri'))" in q.sql
    assert "(number LIKE {n2:String})" in q.sql
    # AND: every needle must match some row of the same call.
    for i in range(3):
        assert f"countIf(number LIKE {{n{i}:String}}" in q.sql
    assert "role IN ('other'" not in q.sql   # 'other' is only for `number`
    assert [q.params[f"param_n{i}"] for i in range(3)] == ["%617%", "%774%", "%5256%"]


def test_lookup_day_range_is_utc_and_end_exclusive():
    midnight = int(datetime(2026, 11, 3, tzinfo=timezone.utc).timestamp()) * S
    q = hx.build_lookup("qryn", [("number", "508")], midnight - DAY, midnight, 5)
    assert (q.params["param_d0"], q.params["param_d1"]) == ("2026-11-02", "2026-11-02")


@pytest.mark.parametrize("needle", [
    "'; DROP TABLE qryn.samples_v3; --", "617'", "617\\", "6%17", "6_17", "617 454",
    "٦١٧", "+16174544217", "", "617\n", "617)", "{n0:String}",
])
def test_lookup_refuses_anything_but_ascii_digits(needle):
    with pytest.raises(ValueError):
        hx.build_lookup("qryn", [("number", needle)], W0, W1, 5)


@pytest.mark.parametrize("db", ["qryn; DROP", "qr`yn", "", "1db", "a.b", "x" * 65])
def test_database_identifier_is_validated(db):
    with pytest.raises(ValueError):
        hx.build_lookup(db, [("number", "617")], W0, W1, 5)
    with pytest.raises(ValueError):
        hx.build_coverage_sql(db)
    with pytest.raises(ValueError):
        hx.build_state_sql(db)


def test_lookup_rejects_unknown_field_and_empty_window():
    with pytest.raises(ValueError):
        hx.build_lookup("qryn", [("diversion_user", "617")], W0, W1, 5)
    with pytest.raises(ValueError):
        hx.build_lookup("qryn", [("number", "617")], W1, W1, 5)
    with pytest.raises(ValueError):
        hx.build_lookup("qryn", [], W0, W1, 5)


def test_state_sql_passes_names_as_parameters():
    st = hx.build_state_sql("qryn")
    assert "qryn" not in st.sql and "sip_number_index" not in st.sql
    assert st.params == {"param_db": "qryn", "param_t1": "sip_number_index",
                         "param_t2": "sip_number_index_mv",
                         "param_t3": "sip_number_index_coverage"}


def test_every_index_request_is_readonly_and_capped():
    for settings in (hx.INDEX_QUERY_SETTINGS, hx.STATE_QUERY_SETTINGS):
        assert settings["readonly"] == "2"
        assert int(settings["max_execution_time"]) <= 10
        assert int(settings["max_memory_usage"]) <= 1_000_000_000
        assert int(settings["max_bytes_to_read"]) <= 6_000_000_000
    # A wide partial spills its GROUP BY instead of failing.
    assert int(hx.INDEX_QUERY_SETTINGS["max_bytes_before_external_group_by"]) < \
        int(hx.INDEX_QUERY_SETTINGS["max_memory_usage"])


# ---- coverage -------------------------------------------------------------

def _ns(y, mo, d, h=0, mi=0):
    return int(datetime(y, mo, d, h, mi, tzinfo=timezone.utc).timestamp()) * S


NOW_NS = _ns(2026, 11, 5, 15)
MV_AT = _ns(2026, 11, 3, 22, 10)          # MV created during the maintenance
TABLES = {"sip_number_index": 1, "sip_number_index_mv": MV_AT // S,
          "sip_number_index_coverage": 1}


def _cov(kind, day, started_ns):
    return {"kind": kind, "day": day, "started_ms": str(started_ns // MS)}


def test_capability_absent_without_mv_or_table():
    assert not hx.compute_capability({}, [], NOW_NS).number_index
    t = dict(TABLES); t.pop("sip_number_index_mv")
    cap = hx.compute_capability(t, [], NOW_NS)
    assert (cap.number_index, cap.covered_from_iso) == (False, None)
    t = dict(TABLES); t.pop("sip_number_index")
    assert not hx.compute_capability(t, [], NOW_NS).number_index


def test_capability_mv_only_covers_from_mv_creation():
    cap = hx.compute_capability(TABLES, [], NOW_NS)
    assert cap.number_index and cap.covered_from_ns == MV_AT
    assert cap.covered_from_iso == "2026-11-03T22:10:00Z"
    assert cap.covers(MV_AT) and not cap.covers(MV_AT - 1)


def test_capability_uses_the_later_of_mv_mtime_and_mv_row():
    later = MV_AT + 3600 * S
    cap = hx.compute_capability(TABLES, [_cov("mv", "2026-11-03", later)], NOW_NS)
    assert cap.covered_from_ns == later


def test_capability_extends_over_backfilled_days_newest_first():
    rows = [_cov("mv", "2026-11-03", MV_AT)] + [
        _cov("backfill", d, MV_AT + 60 * S)
        for d in ("2026-11-03", "2026-11-02", "2026-11-01")]
    cap = hx.compute_capability(TABLES, rows, NOW_NS)
    assert cap.covered_from_iso == "2026-11-01T00:00:00Z"


def test_capability_gap_day_stops_extension():
    rows = [_cov("backfill", d, MV_AT + 60 * S) for d in ("2026-11-03", "2026-11-01")]
    assert hx.compute_capability(TABLES, rows, NOW_NS).covered_from_iso == "2026-11-03T00:00:00Z"


def test_capability_backfill_that_started_before_the_mv_does_not_count():
    rows = [_cov("backfill", "2026-11-03", MV_AT - 1 * S)]
    assert hx.compute_capability(TABLES, rows, NOW_NS).covered_from_ns == MV_AT


def test_capability_mv_day_must_itself_be_backfilled():
    # Older days filled but not the MV's own day: coverage starts at the MV.
    rows = [_cov("backfill", "2026-11-02", MV_AT + 60 * S)]
    assert hx.compute_capability(TABLES, rows, NOW_NS).covered_from_ns == MV_AT


def test_capability_never_older_than_retention():
    rows = [_cov("backfill", (date(2026, 11, 3) - timedelta(days=i)).isoformat(), MV_AT + S)
            for i in range(12)]
    cap = hx.compute_capability(TABLES, rows, NOW_NS)
    assert cap.covered_from_iso == "2026-10-29T00:00:00Z"   # 2026-11-05 - 7 days


def test_capability_stale_index_reads_as_no_index():
    cap = hx.compute_capability(TABLES, [], NOW_NS, stale=True)
    assert (cap.number_index, cap.covered_from_iso) == (False, None)


def test_is_stale():
    m = 60 * S
    assert not hx.is_stale(0, 0)                      # no INVITE 2-15 min ago
    assert not hx.is_stale(NOW_NS - 5 * m, NOW_NS - 6 * m)   # within tolerance
    assert hx.is_stale(NOW_NS - 5 * m, NOW_NS - 11 * m)      # MV stopped
    assert hx.is_stale(NOW_NS - 5 * m, 0)                    # index empty
    lo, hi_ = hx.fresh_params(NOW_NS)
    assert int(lo["param_hi"]) - int(lo["param_lo"]) == 13 * m
    assert hx.parse_max('{"t":"123"}') == 123 and hx.parse_max("") == 0


def test_freshness_sql_is_parameterized_and_bounded():
    sq = hx.build_fresh_samples_sql("qryn")
    assert "PREWHERE timestamp_ns >= {lo:Int64} AND timestamp_ns < {hi:Int64}" in sq
    assert "WHERE day >= {d:Date}" in hx.build_fresh_index_sql("qryn")


def test_capability_ignores_garbage_rows():
    rows = [{"kind": "backfill"}, {"kind": "backfill", "day": "x", "started_ms": "1"},
            {"kind": "mv", "day": "2026-11-03", "started_ms": "nope"}]
    assert hx.compute_capability(TABLES, rows, NOW_NS).covered_from_ns == MV_AT


# ---- errors / sentences -----------------------------------------------------

@pytest.mark.parametrize("headers,body,code,cap", [
    ({"X-ClickHouse-Exception-Code": "241"}, "", 241, True),
    ({}, "Code: 241. DB::Exception: Memory limit (for query) exceeded", 241, True),
    ({}, "Code: 307. DB::Exception: Limit for bytes to read exceeded", 307, True),
    ({}, "Code: 158. TOO_MANY_ROWS", 158, True),
    ({}, "Code: 159. DB::Exception: Timeout exceeded", 159, True),
    ({}, '{"message":"... MEMORY_LIMIT_EXCEEDED ..."}', None, True),
    ({}, "Code: 60. DB::Exception: Table qryn.sip_number_index doesn't exist", 60, False),
    ({}, "Code: 62. Syntax error", 62, False),
    ({}, "", None, False),
])
def test_error_classification(headers, body, code, cap):
    assert hx.error_code(headers, body) == code
    assert hx.is_cap_error(hx.error_code(headers, body), body) is cap


def test_sentences_are_plain_and_name_the_fix():
    s = hx.too_broad_sentence([("number", "508"), ("to_user", "7744045256")])
    assert "'508'" in s and "more digits" in s and "shorter window" in s
    assert "''" not in hx.too_broad_sentence([]) and "shorter window" in hx.too_broad_sentence([])
    assert "24 hours" in hx.window_too_wide_sentence(hx.Capability(False, None))
    c = hx.Capability(True, MV_AT)
    assert "2026-11-03T22:10:00Z" in hx.window_too_wide_sentence(c)


def test_ns_to_iso():
    assert hx.ns_to_iso(_ns(2026, 11, 3, 1) + 123456789) == "2026-11-03T01:00:00.123456Z"
    assert hx.ns_to_iso(None) is None


# ---- DDL / backfill / normalizer parity -------------------------------------

DDL = (REPO / "docker/homer/clickhouse/10_sip_number_index.sql").read_text()
BACKFILL = (REPO / "scripts/homer/backfill_sip_number_index.sh").read_text()


def test_ddl_has_one_extract_block_with_one_backfill_marker():
    assert DDL.count("-- BEGIN sip_number_index extract\n") == 1
    assert DDL.count("-- END sip_number_index extract\n") == 1
    block = DDL.split("-- BEGIN sip_number_index extract\n")[1].split("-- END")[0]
    assert block.count("/*BACKFILL_RANGE*/") == 1
    assert "-- BEGIN sip_number_index extract" in BACKFILL
    assert "/*BACKFILL_RANGE*/" in BACKFILL


def test_ddl_is_idempotent_and_ordered():
    stmts = [s.strip() for s in re.split(r";\s*\n", re.sub(r"(?m)^\s*--.*$", "", DDL)) if s.strip()]
    kinds = [s.split("(")[0].split("\n")[0].strip() for s in stmts]
    assert kinds[0].startswith("CREATE TABLE IF NOT EXISTS qryn.sip_number_index_coverage")
    assert kinds[1].startswith("CREATE TABLE IF NOT EXISTS qryn.sip_number_index")
    assert kinds[2].startswith("CREATE MATERIALIZED VIEW IF NOT EXISTS qryn.sip_number_index_mv")
    assert stmts[3].startswith("INSERT INTO qryn.sip_number_index_coverage")
    assert "WHERE (SELECT count() FROM qryn.sip_number_index_coverage WHERE kind = 'mv') = 0" in stmts[3]
    assert len(stmts) == 4


def test_ddl_normalization_matches_the_python_needle_rule():
    # The 11-digit leading-1 rule (stored with and without the 1), digits
    # only, 3..32 digits: the same rule normalize_number_needle applies.
    assert "if(length(d) = 11 AND startsWith(d, '1'), [d, substring(d, 2)], [d])" in DDL
    assert "replaceRegexpAll(u, '%[0-9A-Fa-f]{2}', ''), '[^0-9]', '')" in DDL
    assert "length(n) BETWEEN 3 AND 32" in DDL
    for raw, stored in (("+1 (508) 728-2017", {"15087282017", "5087282017"}),
                        ("5087282017", {"5087282017"})):
        assert hp.normalize_number_needle(raw) in stored


def test_ddl_mv_row_never_expires_and_roles_come_from_the_initial_invite():
    assert "TTL toDate(finished_at) + INTERVAL 9 DAY DELETE WHERE kind = 'backfill'" in DDL
    assert "NOT match(v_to, '(?i);[ \\\\t]*tag[ \\\\t]*=') AS is_initial" in DDL
    assert "if(is_initial, ['ruri', 'from', 'to', 'pai', 'diversion'], ['other', 'other', 'other', 'other', 'other'])" in DDL
    # Bounded per-row work: header block <= 8 KiB, no RE2 {m,n} blow-up.
    assert "BETWEEN 1 AND 8192" in DDL and not re.search(r"\{\d+,\d+\}", DDL.split("BEGIN sip")[1])


def test_users_xml_keeps_ingest_alive_when_the_mv_fails():
    users = (REPO / "docker/homer/clickhouse-users.xml").read_text()
    assert "<materialized_views_ignore_errors>1</materialized_views_ignore_errors>" in users


def test_ddl_mv_never_uses_throwing_functions():
    mv = DDL.split("-- BEGIN sip_number_index extract\n")[1].split("-- END")[0]
    # Conversions only on constants or the Int64 timestamp (cannot throw);
    # no joins, dictionaries or parsers that raise on bad input.
    for bad in ("throwIf", "JSONExtract", "parseDateTime", "toUInt16(substring", "dictGet",
                "joinGet", "toInt64(string", "toDate(string"):
        assert bad not in mv, bad
    assert not re.search(r"(?<!ARRAY) JOIN ", mv)
    assert "toUInt16OrZero(substring(line1, 9, 3))" in mv


# ===========================================================================
# Layer 2 — endpoint
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


NOW = int(time.time())
T0 = (NOW - 3600) * S
CALLER = "+15087282017"
DID = "+16174544217"
FWD = "+17744045256"


def _iso(sec):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(sec))


def sip(first, cid, frm, to, cseq, branch, xcid=None):
    hdrs = [first, f"Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK{branch}",
            f"From: <sip:{frm}@h>;tag=f{branch}", f"To: <sip:{to}@h>",
            f"Call-ID: {cid}", f"CSeq: {cseq}"]
    if xcid:
        hdrs.append(f"X-CID: {xcid}")
    return "\r\n".join(hdrs + ["Content-Length: 0"]) + "\r\n\r\n"


def a_leg(cid, t0, frm=CALLER, to=DID):
    inv = sip(f"INVITE sip:{to}@34.24.133.82 SIP/2.0", cid, frm, to, "1 INVITE", f"a{cid}")
    ok = sip("SIP/2.0 200 OK", cid, frm, to, "1 INVITE", f"a{cid}")
    bye = sip(f"BYE sip:{to}@h SIP/2.0", cid, frm, to, "2 BYE", f"ab{cid}")
    return [ch_row(cid, t0, "BW-ATL", "SBC-VIP", inv),
            ch_row(cid, t0 + 5 * S, "SBC-VIP", "BW-ATL", ok, response="200"),
            ch_row(cid, t0 + 60 * S, "BW-ATL", "SBC-VIP", bye, method="BYE")]


def b_leg(cid, a_cid, t_inv, final=200, frm=CALLER):
    inv = sip(f"INVITE sip:{FWD}@10.142.0.250 SIP/2.0", cid, frm, FWD, "1 INVITE", f"b{cid}", xcid=a_cid)
    fin = sip(f"SIP/2.0 {final} X", cid, frm, FWD, "1 INVITE", f"b{cid}")
    return [ch_row(cid, t_inv, "FreeSWITCH", "SBC-SigVIP", inv, sport="5090", node="200"),
            ch_row(cid, t_inv + 200 * MS, "BW-DAL", "SBC-VIP", fin, response=str(final))]


# ---- Python mirror of the MV extraction (docker/homer/clickhouse/10_...) ----

_ROLE_HDR = {
    "from": re.compile(r"(?mi)^(?:from|f)[ \t]*:([^\r\n]*)"),
    "to": re.compile(r"(?mi)^(?:to|t)[ \t]*:([^\r\n]*)"),
    "pai": re.compile(r"(?mi)^p-asserted-identity[ \t]*:([^\r\n]*)"),
    "diversion": re.compile(r"(?mi)^diversion[ \t]*:([^\r\n]*)"),
}
_SIPU = re.compile(r"(?i)\bsips?:([^@>,;?\s]+)[^@>,?\s]*@")
_TELU = re.compile(r"(?i)\btel:([^;>,?\s]+)")
_CID = re.compile(r"(?mi)^(?:call-id|i)[ \t]*:[ \t]*([^\r\n]*[^\r\n \t])")


def _forms(value):
    out = []
    for u in _SIPU.findall(value) + _TELU.findall(value):
        d = re.sub(r"[^0-9]", "", re.sub(r"%[0-9A-Fa-f]{2}", "", u))
        for n in ([d, d[1:]] if len(d) == 11 and d.startswith("1") else [d]):
            if 3 <= len(n) <= 32:
                out.append(n)
    return out


_CSEQ = re.compile(r"(?mi)^cseq[ \t]*:[ \t]*[0-9]+[ \t]+([A-Za-z]+)")


def derive_index(rows):
    idx = {}
    for r in rows:
        hdr = r["msg"].split("\r\n\r\n")[0]
        line1 = hdr.split("\r\n")[0]
        is_req = bool(re.match(r"^[A-Za-z]+ [^ ]+ SIP/2\.0$", line1))
        if not (is_req or line1.startswith("SIP/2.0 ")):
            continue
        m = _CID.search(hdr)
        if not m:
            continue
        cid, ts = m.group(1), r["timestamp_ns"]
        day = datetime.fromtimestamp(ts // S, tz=timezone.utc).date().isoformat()
        cseq = (_CSEQ.search(hdr).group(1).upper() if _CSEQ.search(hdr) else "")
        to_v = "\n".join(_ROLE_HDR["to"].findall(hdr))
        initial = (is_req and line1.startswith("INVITE ") and cseq == "INVITE"
                   and not re.search(r"(?i);[ \t]*tag[ \t]*=", to_v))
        pairs = [("ruri", n) for n in (_forms(line1) if is_req else [])]
        for role, rx in _ROLE_HDR.items():
            pairs += [(role, n) for n in _forms("\n".join(rx.findall(hdr)))]
        if not initial:
            pairs = [("other", n) for _r, n in pairs]
        for role, n in set(pairs):
            k = (day, n, role, cid)
            f, l = idx.get(k, (ts, ts))
            idx[k] = (min(f, ts), max(l, ts))
    return [{"day": k[0], "number": k[1], "role": k[2], "call_id": k[3],
             "first_ns": v[0], "last_ns": v[1]} for k, v in idx.items()]


_COND_RE = re.compile(r"\(number (LIKE|=) \{n(\d+):String\}(?: AND role IN \(([^)]*)\))?\)")


class IndexedFakeClickHouse(FakeClickHouse):
    """FakeClickHouse + the number index, capability tables and coverage."""

    def __init__(self, rows, *, objects=("sip_number_index", "sip_number_index_mv",
                                         "sip_number_index_coverage"),
                 mv_created_s=None, coverage=(), index_fail=None, extra_index=(),
                 stale=False):
        super().__init__()
        self.add(rows)
        self.extra_index = list(extra_index)     # index rows with no SIP stored
        self.stale = stale                       # MV stopped filling
        self.objects = {o: (mv_created_s or NOW - 3 * 86400) for o in objects}
        self.coverage = list(coverage)
        self.index_fail = index_fail            # None | "cap" | "error"
        self.index_calls = []                   # [(sql, params)]
        self.state_calls = 0

    def handle(self, sql, params=None):
        params = dict(params or {})
        if "system.tables" in sql:
            self.state_calls += 1
            self.probes.append((sql, params))
            wanted = {params.get(f"param_t{i}") for i in (1, 2, 3)}
            return 200, "\n".join(json.dumps({"name": n, "mtime": str(t)})
                                  for n, t in self.objects.items() if n in wanted)
        if "sip_number_index_coverage" in sql:
            self.probes.append((sql, params))
            return 200, "\n".join(json.dumps(c) for c in self.coverage)
        if "startsWith(string, 'INVITE ')" in sql:       # freshness: samples
            self.probes.append((sql, params))
            t = (NOW - 300) * S if self.stale else 0
            return 200, json.dumps({"t": str(t)})
        if "max(last_ns)) AS t" in sql:                  # freshness: index
            self.probes.append((sql, params))
            return 200, json.dumps({"t": str((NOW - 3600) * S)})
        if "sip_number_index" in sql:
            self.index_calls.append((sql, params))
            if self.index_fail == "cap":
                return 500, "Code: 241. DB::Exception: Memory limit (for query) exceeded (fake)"
            if self.index_fail == "error":
                return 404, "Code: 60. DB::Exception: Table qryn.sip_number_index doesn't exist"
            return 200, self._lookup(sql, params)
        return super().handle(sql, params)

    def _lookup(self, sql, p):
        assert "PREWHERE" in sql
        conds = [(op, p[f"param_n{i}"].strip("%"),
                  {x.strip().strip("'") for x in roles.split(",")} if roles else None)
                 for op, i, roles in _COND_RE.findall(sql)]
        d0, d1 = p["param_d0"], p["param_d1"]
        calls = {}
        for r in derive_index(self.rows) + self.extra_index:
            if not (d0 <= r["day"] <= d1):
                continue
            hit = [(n == r["number"] if op == "=" else n in r["number"])
                   and (roles is None or r["role"] in roles) for op, n, roles in conds]
            if not any(hit):
                continue
            c = calls.setdefault(r["call_id"], {"f": r["first_ns"], "l": r["last_ns"], "m": [False] * len(conds)})
            c["f"], c["l"] = min(c["f"], r["first_ns"]), max(c["l"], r["last_ns"])
            c["m"] = [a or b for a, b in zip(c["m"], hit)]
        lo, hi = int(p["param_lo"]), int(p["param_hi"])
        out = [(cid, c) for cid, c in calls.items()
               if all(c["m"]) and c["l"] >= lo and c["f"] < hi]
        out.sort(key=lambda kv: (kv[1]["f"], kv[0]), reverse=True)
        return "\n".join(json.dumps({"call_id": cid, "f_ns": str(c["f"]), "l_ns": str(c["l"])})
                         for cid, c in out[:int(p["param_lim"])])


def loki_from_rows(rows, needles, limit=500):
    hits = [r for r in rows if all(n in r["msg"] for n in needles)]
    hits.sort(key=lambda r: r["timestamp_ns"], reverse=True)
    streams = {}
    for r in hits[:limit]:
        streams.setdefault(r["labels"], []).append([str(r["timestamp_ns"]), r["msg"]])
    return {"data": {"result": [{"stream": json.loads(lab), "values": v} for lab, v in streams.items()]}}


class Upstream:
    def __init__(self, ch, qryn_status=200, qryn_text=None):
        self.ch = ch
        self.loki_queries = []
        self.qryn_status, self.qryn_text = qryn_status, qryn_text

    def _handle(self, request):
        if "/loki/api/v1/query_range" in request.url.path:
            q = request.url.params["query"]
            self.loki_queries.append(q)
            if self.qryn_status != 200:
                return httpx.Response(self.qryn_status, text=self.qryn_text or "")
            needles = [x.split('"')[1] for x in q.split("|~")[1:]]
            return httpx.Response(200, json=loki_from_rows(self.ch.rows, needles))
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
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
                               base_url="http://test")

    def tok(sub, role, cust):
        return {"Authorization": "Bearer " + create_access_token(
            {"sub": sub, "email": f"{role}@test.local", "role": role, "customer_id": cust})}
    try:
        yield {"client": client, "homer": homer_mod,
               "support": tok("2", "support", None), "admin": tok("1", "admin", None),
               "user": tok("3", "user", 42)}
    finally:
        _run(client.aclose())


FULL_COVERAGE = [{"kind": "mv", "day": "x", "started_ms": str((NOW - 3 * 86400) * 1000)}] + [
    {"kind": "backfill", "day": (datetime.now(timezone.utc).date() - timedelta(days=i)).isoformat(),
     "started_ms": str((NOW - 3 * 86400 + 600) * 1000)} for i in range(9)]


def setup(api, monkeypatch, rows, *, indexed=True, cdr=None, **kw):
    if indexed:
        ch = IndexedFakeClickHouse(rows, coverage=kw.pop("coverage", FULL_COVERAGE), **kw)
    else:
        ch = IndexedFakeClickHouse(rows, objects=())
    up = Upstream(ch)
    monkeypatch.setattr(api["homer"].httpx, "AsyncClient", up.factory)
    cdr = cdr if cdr is not None else FakeCDR()
    monkeypatch.setattr(api["homer"].db, "fetch_all", cdr.fetch_all)
    return up


def post(api, role="support", **body):
    b = {"start_time": _iso(NOW - 7 * 86400 + 60), "end_time": _iso(NOW)}
    b.update(body)
    return _run(api["client"].post("/v1/homer/search", headers=api[role], json=b))


def forwarded_call(a="A-1@67.231.13.185", t0=T0):
    return a_leg(a, t0) + b_leg(f"B1-{a}", a, t0 + 100 * MS, 503) + b_leg(f"B2-{a}", a, t0 + 400 * MS, 200)


# ---- capabilities -----------------------------------------------------------

@needs_web
def test_capabilities_present(api, monkeypatch):
    up = setup(api, monkeypatch, [])
    r = _run(api["client"].get("/v1/homer/search/capabilities", headers=api["support"]))
    assert r.status_code == 200, r.text
    body = r.json()
    midnight = datetime.combine(datetime.now(timezone.utc).date() - timedelta(days=7),
                                datetime.min.time(), tzinfo=timezone.utc)
    assert body == {"number_index": True,
                    "index_covered_from": midnight.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "max_scan_hours": 24, "max_window_days": 7}
    # Cached: a second call (and a search) issue no new probe.
    _run(api["client"].get("/v1/homer/search/capabilities", headers=api["admin"]))
    assert up.ch.state_calls == 1
    for sql, params in up.ch.probes:
        assert params["readonly"] == "2" and "max_execution_time" in params


@needs_web
def test_capabilities_absent_and_auth(api, monkeypatch):
    setup(api, monkeypatch, [], indexed=False)
    r = _run(api["client"].get("/v1/homer/search/capabilities", headers=api["support"]))
    assert r.json() == {"number_index": False, "index_covered_from": None,
                        "max_scan_hours": 24, "max_window_days": 7}
    assert _run(api["client"].get("/v1/homer/search/capabilities")).status_code == 401
    assert _run(api["client"].get("/v1/homer/search/capabilities",
                                  headers=api["user"])).status_code == 403


@needs_web
def test_capabilities_probe_failure_reads_as_no_index(api, monkeypatch):
    up = setup(api, monkeypatch, [])
    up.ch.handle = lambda sql, params=None: (500, "Code: 210. Connection refused")
    r = _run(api["client"].get("/v1/homer/search/capabilities", headers=api["support"]))
    assert r.status_code == 200 and r.json()["number_index"] is False


@needs_web
def test_capabilities_route_is_literal_before_search(api):
    paths = [(getattr(rt, "path", ""), sorted(getattr(rt, "methods", []) or []))
             for rt in api["homer"].router.routes]
    i_cap = paths.index(("/search/capabilities", ["GET"]))
    i_search = paths.index(("/search", ["POST"]))
    assert i_cap < i_search
    assert not any("{" in p for p, _m in paths[:i_cap])


# ---- index path ---------------------------------------------------------------

@needs_web
def test_index_path_7_days_fetches_by_callid_and_correlates(api, monkeypatch):
    rows = forwarded_call()
    up = setup(api, monkeypatch, rows)
    r = post(api, number="(774) 404-5256")       # the forwarded-to number: B legs only
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["search_path"] == "index"
    assert body["max_scan_hours"] == 24 and body["index_covered_from"].endswith("T00:00:00Z")
    assert up.loki_queries == []                 # never the text scan
    group = sorted(["A-1@67.231.13.185", "B1-A-1@67.231.13.185", "B2-A-1@67.231.13.185"])
    assert {m["callid"] for m in body["data"]} == set(group)   # A leg pulled via X-CID
    for cid in group:
        assert body["correlations"][cid] == group
    assert body["legs"]["B2-A-1@67.231.13.185"]["role"] == "B"
    assert body["has_more"] is False
    # Cursor = first matching message of the page's oldest call (B1); the
    # correlated A leg (not a number match) holds older rows.
    assert body["oldest_ts_ns"] == T0 + 100 * MS
    assert min(m["timestamp_ns"] for m in body["data"]) == T0
    # The index lookup carried the needle only as a parameter, with caps.
    sql, params = up.ch.index_calls[0]
    assert "7744045256" not in sql and params["param_n0"] == "7744045256"   # exact
    assert params["readonly"] == "2" and params["max_memory_usage"] == "1000000000"
    assert params["max_bytes_to_read"] == "6000000000"
    # Every other ClickHouse request on this path is capped too.
    for _k, _sql, p in up.ch.calls:
        assert p["readonly"] == "2" and p["max_execution_time"] and p["max_memory_usage"]


@needs_web
@pytest.mark.parametrize("raw", ["5087282017", "15087282017", "+1 (508) 728-2017", "508.728.2017"])
def test_index_every_number_form_finds_the_same_calls(api, monkeypatch, raw):
    setup(api, monkeypatch, forwarded_call())
    body = post(api, number=raw).json()
    assert body["search_path"] == "index"
    assert {m["callid"] for m in body["data"]} == {
        "A-1@67.231.13.185", "B1-A-1@67.231.13.185", "B2-A-1@67.231.13.185"}


@needs_web
def test_index_partial_number(api, monkeypatch):
    up = setup(api, monkeypatch, forwarded_call() + a_leg("other@x", T0 - 600 * S, frm="+13125550100"))
    body = post(api, number="4217").json()
    assert body["search_path"] == "index" and up.ch.index_calls[0][1]["param_n0"] == "%4217%"
    assert "other@x" in {m["callid"] for m in body["data"]}    # DID 6174544217 on both


@needs_web
def test_index_role_filters(api, monkeypatch):
    up = setup(api, monkeypatch, forwarded_call())
    # The forwarded-to number is only ever a callee.
    assert post(api, from_user=FWD).json()["data"] == []
    body = post(api, to_user=FWD).json()
    assert "B2-A-1@67.231.13.185" in {m["callid"] for m in body["data"]}
    assert "role IN ('to', 'ruri')" in up.ch.index_calls[-1][0]
    # AND across fields: caller AND forwarded-to -> the B legs (and their A).
    body = post(api, from_user=CALLER, to_user=FWD).json()
    assert body["search_path"] == "index" and len(body["data"]) > 0
    assert post(api, from_user=FWD, to_user=CALLER).json()["data"] == []


@needs_web
def test_index_correlate_false(api, monkeypatch):
    setup(api, monkeypatch, forwarded_call())
    body = post(api, number=FWD, correlate=False).json()
    assert body["correlation_reason"] == "disabled"
    assert {m["callid"] for m in body["data"]} == {"B1-A-1@67.231.13.185", "B2-A-1@67.231.13.185"}


@needs_web
def test_index_no_match_is_an_empty_ok_page(api, monkeypatch):
    setup(api, monkeypatch, forwarded_call())
    body = post(api, number="999888").json()
    assert body["search_path"] == "index" and body["data"] == []
    assert (body["has_more"], body["oldest_ts_ns"], body["correlation_status"]) == (False, None, "ok")


# ---- paging -------------------------------------------------------------------

def _many_calls(n, step_s=30):
    rows = []
    for i in range(n):
        rows += a_leg(f"C{i:03d}@x", T0 - i * step_s * S)
    return rows


@needs_web
def test_index_paging_50_calls_per_page_no_overlap_no_skip(api, monkeypatch):
    rows = _many_calls(60)
    setup(api, monkeypatch, rows)
    p1 = post(api, number=DID).json()
    c1 = {m["callid"] for m in p1["data"]}
    assert p1["search_path"] == "index" and len(c1) == 50 and p1["has_more"] is True
    assert c1 == {f"C{i:03d}@x" for i in range(50)}          # the newest 50
    # The cursor = first matching message of the page's oldest call.
    assert p1["oldest_ts_ns"] == T0 - 49 * 30 * S
    p2 = post(api, number=DID, before_ns=p1["oldest_ts_ns"]).json()
    c2 = {m["callid"] for m in p2["data"]}
    assert c2 == {f"C{i:03d}@x" for i in range(50, 60)} and p2["has_more"] is False
    rows1 = {(m["callid"], m["timestamp_ns"]) for m in p1["data"]}
    rows2 = {(m["callid"], m["timestamp_ns"]) for m in p2["data"]}
    assert rows1 & rows2 == set()
    # Whole calls: C050 started before the cursor but its BYE is newer —
    # it is returned with its call instead of being lost between pages.
    assert all(min(ts for c, ts in rows2 if c == cid) < p1["oldest_ts_ns"] for cid in c2)
    assert any(ts >= p1["oldest_ts_ns"] for _c, ts in rows2)
    assert {m["method"] for m in p2["data"] if m["callid"] == "C050@x"} >= {"INVITE", "BYE"}


@needs_web
def test_index_before_ns_clamps_the_lookup(api, monkeypatch):
    up = setup(api, monkeypatch, _many_calls(3))
    cursor = T0 - 15 * S
    post(api, number=DID, before_ns=cursor)
    assert up.ch.index_calls[0][1]["param_hi"] == str(cursor)


@needs_web
def test_index_paging_by_call_never_skips_a_call_a_correlated_leg_straddles(api, monkeypatch):
    # 50 newer calls to FWD (B legs); the oldest of them (EDGE-B) has an A
    # leg that started 30 s before it. GAP starts between that A leg and
    # EDGE-B. The cursor is EDGE-B's first message (paging is by call), so
    # GAP is on page 2 instead of being skipped, and the A leg's older rows
    # ride along with EDGE-B on page 1.
    rows = []
    for i in range(49):
        rows += b_leg(f"N{i:02d}@x", f"NA{i:02d}@x", T0 + (100 + i) * S)
    a_old = T0 - 30 * S
    rows += a_leg("EDGE-A@x", a_old) + b_leg("EDGE-B@x", "EDGE-A@x", T0)
    rows += b_leg("GAP@x", "GAP-A-not-captured@x", T0 - 10 * S)
    rows += b_leg("OLD@x", "OLD-A-not-captured@x", T0 - 3600 * S)
    setup(api, monkeypatch, rows)
    p1 = post(api, number=FWD).json()
    c1 = {m["callid"] for m in p1["data"]}
    assert {"EDGE-A@x", "EDGE-B@x"} <= c1 and "GAP@x" not in c1
    assert p1["oldest_ts_ns"] == T0 and p1["has_more"] is True
    assert min(m["timestamp_ns"] for m in p1["data"]) == a_old   # correlated leg is older
    p2 = post(api, number=FWD, before_ns=p1["oldest_ts_ns"]).json()
    assert {m["callid"] for m in p2["data"]} == {"GAP@x", "OLD@x"} and p2["has_more"] is False
    assert p2["oldest_ts_ns"] == T0 - 3600 * S


@needs_web
def test_index_paging_keeps_ties_with_the_oldest_call_together(api, monkeypatch):
    rows = []
    for i in range(49):
        rows += a_leg(f"T{i:02d}@x", T0 + (100 + i) * S)
    rows += a_leg("TIE-1@x", T0) + a_leg("TIE-2@x", T0) + a_leg("OLDER@x", T0 - 600 * S)
    setup(api, monkeypatch, rows)
    p1 = post(api, number=DID).json()
    c1 = {m["callid"] for m in p1["data"]}
    assert {"TIE-1@x", "TIE-2@x"} <= c1 and len(c1) == 51 and p1["has_more"] is True
    p2 = post(api, number=DID, before_ns=p1["oldest_ts_ns"]).json()
    assert {m["callid"] for m in p2["data"]} == {"OLDER@x"}


@needs_web
def test_has_more_always_comes_with_a_usable_cursor(api, monkeypatch):
    # The index knows 60 calls but their SIP is gone (e.g. samples expired
    # first): has_more must still come with a cursor, and the page says why.
    day = datetime.fromtimestamp(T0 // S, tz=timezone.utc).date().isoformat()
    extra = [{"day": day, "number": "7744045256", "role": "to", "call_id": f"GONE{i:02d}@x",
              "first_ns": T0 - i * S, "last_ns": T0 - i * S} for i in range(60)]
    setup(api, monkeypatch, [], extra_index=extra)
    body = post(api, number=FWD).json()
    assert body["data"] == [] and body["has_more"] is True
    assert body["oldest_ts_ns"] == T0 - 49 * S
    assert any("could be fetched" in w for w in body["pipeline_warnings"])
    p2 = post(api, number=FWD, before_ns=body["oldest_ts_ns"]).json()
    assert p2["has_more"] is False and p2["oldest_ts_ns"] == T0 - 59 * S


@needs_web
def test_stale_index_falls_back_to_the_scan(api, monkeypatch):
    up = setup(api, monkeypatch, forwarded_call(), stale=True)
    r = _run(api["client"].get("/v1/homer/search/capabilities", headers=api["support"]))
    assert r.json()["number_index"] is False and r.json()["index_covered_from"] is None
    api["homer"]._reset_capability_cache()
    body = post(api, number=FWD, start_time=_iso(NOW - 3600 * 3), end_time=_iso(NOW)).json()
    assert body["search_path"] == "scan" and up.ch.index_calls == []
    api["homer"]._reset_capability_cache()
    assert post(api, number=FWD).status_code == 422       # 7 days, no index


# ---- fallback, refusals -------------------------------------------------------

@needs_web
def test_no_index_24h_window_uses_scan(api, monkeypatch):
    up = setup(api, monkeypatch, forwarded_call(), indexed=False)
    body = post(api, number=FWD, start_time=_iso(NOW - 86400), end_time=_iso(NOW)).json()
    assert body["search_path"] == "scan" and body["index_covered_from"] is None
    assert up.loki_queries == ['{type="sip"} |~ "7744045256"']
    assert "B2-A-1@67.231.13.185" in {m["callid"] for m in body["data"]}


@needs_web
def test_no_index_wider_than_24h_is_window_too_wide(api, monkeypatch):
    up = setup(api, monkeypatch, forwarded_call(), indexed=False)
    r = post(api, number=FWD, start_time=_iso(NOW - 86400 - 1), end_time=_iso(NOW))
    assert r.status_code == 422
    assert r.json() == {"detail": hx.window_too_wide_sentence(hx.Capability(False, None)),
                        "code": "window_too_wide", "max_scan_hours": 24}
    assert up.loki_queries == [] and up.ch.calls == []


@needs_web
def test_window_older_than_coverage(api, monkeypatch):
    mv_at = NOW - 7200
    up = setup(api, monkeypatch, forwarded_call(), mv_created_s=mv_at, coverage=[])
    # <= 24 h but starts before coverage -> scan.
    body = post(api, number=FWD, start_time=_iso(NOW - 6 * 3600), end_time=_iso(NOW)).json()
    assert body["search_path"] == "scan"
    assert body["index_covered_from"] == _iso(mv_at)
    # Starts inside coverage -> index.
    body = post(api, number=FWD, start_time=_iso(mv_at), end_time=_iso(NOW)).json()
    assert body["search_path"] == "index"
    # Wider than 24 h and older than coverage -> 422 naming the coverage start.
    r = post(api, number=FWD, start_time=_iso(NOW - 2 * 86400), end_time=_iso(NOW))
    assert r.status_code == 422 and r.json()["code"] == "window_too_wide"
    assert _iso(mv_at) in r.json()["detail"]
    assert len(up.loki_queries) == 1


@needs_web
def test_index_limit_hit_is_search_too_broad(api, monkeypatch):
    up = setup(api, monkeypatch, forwarded_call(), index_fail="cap")
    r = post(api, number="508")
    assert r.status_code == 422
    assert r.json() == {"detail": hx.too_broad_sentence([("number", "508")]),
                        "code": "search_too_broad", "max_scan_hours": 24}
    assert up.loki_queries == []


@needs_web
def test_scan_limit_relayed_by_qryn_is_search_too_broad(api, monkeypatch):
    ch = IndexedFakeClickHouse([], objects=())
    up = Upstream(ch, 500, '{"message":"Code: 241. DB::Exception: Memory limit (for query) exceeded"}')
    monkeypatch.setattr(api["homer"].httpx, "AsyncClient", up.factory)
    monkeypatch.setattr(api["homer"].db, "fetch_all", FakeCDR().fetch_all)
    r = post(api, number="508", start_time=_iso(NOW - 86400), end_time=_iso(NOW))
    assert r.status_code == 422 and r.json()["code"] == "search_too_broad"
    # A plain qryn failure stays a 502, as before.
    up.qryn_text = "upstream exploded"
    assert post(api, number="508", start_time=_iso(NOW - 86400), end_time=_iso(NOW)).status_code == 502


@needs_web
def test_index_error_falls_back_to_scan_within_24h_else_502(api, monkeypatch):
    up = setup(api, monkeypatch, forwarded_call(), index_fail="error")
    body = post(api, number=FWD, start_time=_iso(NOW - 3600 * 3), end_time=_iso(NOW)).json()
    assert body["search_path"] == "scan" and len(up.loki_queries) == 1
    up = setup(api, monkeypatch, forwarded_call(), index_fail="error")
    r = post(api, number=FWD)
    assert r.status_code == 502


@needs_web
def test_seed_fetch_total_failure_is_loud(api, monkeypatch):
    up = setup(api, monkeypatch, forwarded_call())
    up.ch.fail = {"fetch"}           # FakeClickHouse answers 500 Code 241
    r = post(api, number=FWD)
    assert r.status_code == 422 and r.json()["code"] == "search_too_broad"
    # Its own plain message: a full number is not "too short".
    assert r.json()["detail"] == hx.fetch_too_large_sentence()


@needs_web
def test_call_id_path_unchanged_any_window(api, monkeypatch):
    up = setup(api, monkeypatch, forwarded_call(), indexed=False)
    body = post(api, call_id="A-1@67.231.13.185").json()   # 7-day window, no index
    assert body["search_path"] == "call_id"
    assert up.loki_queries == ['{type="sip", call_id="A-1@67.231.13.185"}']


# ---- hostile input --------------------------------------------------------------

@needs_web
@pytest.mark.parametrize("raw,needle", [
    ("'; DROP TABLE qryn.samples_v3; -- 617", "617"),
    ("617\\' OR 1=1 --", "6171"),
    ("{n0:String} 508", "08"),             # 0 + 508? -> digits "0508"
    ("٦١٧ 508", "508"),     # Unicode digits are stripped
])
def test_hostile_number_reaches_clickhouse_only_as_digits(api, monkeypatch, raw, needle):
    up = setup(api, monkeypatch, forwarded_call())
    r = post(api, number=raw)
    assert r.status_code == 200, r.text
    sql, params = up.ch.index_calls[0]
    assert params["param_n0"] == "%" + hp.normalize_number_needle(raw) + "%"
    assert re.fullmatch(r"%[0-9]+%", params["param_n0"])
    for bad in ("DROP", "'", "\\", "OR 1", "٦"):
        assert bad not in sql
    assert needle in params["param_n0"]


@needs_web
@pytest.mark.parametrize("field,value", [
    ("before_ns", "1; DROP TABLE x"), ("before_ns", "1e30"), ("before_ns", -5),
])
def test_typed_cursor_rejects_injection(api, monkeypatch, field, value):
    up = setup(api, monkeypatch, forwarded_call())
    r = post(api, number=FWD, **{field: value})
    assert r.status_code == 422
    assert up.ch.index_calls == [] and up.loki_queries == []


@needs_web
@pytest.mark.parametrize("start", ["2026-11-01'; DROP", "yesterday", "2026-11-01T00:00:00Z OR 1"])
def test_bad_start_time_is_400_before_any_query(api, monkeypatch, start):
    up = setup(api, monkeypatch, forwarded_call())
    r = post(api, number=FWD, start_time=start)
    assert r.status_code == 400
    assert up.ch.index_calls == [] and up.loki_queries == []


@needs_web
def test_hostile_call_id_keeps_the_escaped_label_path(api, monkeypatch):
    up = setup(api, monkeypatch, [])
    r = post(api, call_id='x"} |~ "y\\', start_time=_iso(NOW - 3600), end_time=_iso(NOW))
    assert r.status_code == 200
    assert up.loki_queries == ['{type="sip", call_id="x\\"} |~ \\"y\\\\"}']
    assert up.ch.index_calls == []
