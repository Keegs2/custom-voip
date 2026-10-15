"""GET /v1/cdrs/activity — server-side Call Activity aggregate.

Contract: services/cdr_activity.py module docstring (RCF page "Call
Activity" tab; replaces the UI's client-side roll-up of the latest 200 CDRs).

Covers:
  * pure window math — bucket count / layout per range (24h hourly incl. a
    +05:30 zone, 7d/30d daily, 90d ISO-weekly Monday buckets), DST day, tz
    canonicalization, pct rounding.
  * The REAL cdrs router over an ephemeral PostgreSQL behind the REAL JWT
    middleware with REAL minted JWTs (same harness as test_reports.py):
      - zero-filled buckets for every range; points sum to the KPI total
      - tz handling (a 23:30 New York call lands on the NY date, not UTC's)
      - one row per call (carrier B-leg rows never count)
      - answered semantics == the UI's (staff: duration_ms > 0; tenant: talk
        time > 0) and quality semantics == summarizeCallQuality
      - tenant scoping (customer_id ignored) and no seconds/cost keys
      - staff all-customers vs. one customer; exact destination filter
      - bad tz / range -> 422; route not shadowed by /{cdr_uuid}; legacy
        /cdrs mount; statement_timeout -> 503 without leaking SET LOCAL;
        sargable start_time range (index scan).
      - Python is the single source of bucket edges (width_bucket over bound
        instants; no AT TIME ZONE in SQL): calls straddling the US DST
        transitions land on the local day/week/hour zoneinfo says, for
        24h/7d/30d/90d in America/New_York, and points always sum to the
        KPI total. An out-of-range bucket index is logged, never silent.

Run:  python -m pytest -q -p no:cacheprovider tests/test_cdr_activity.py
"""
import asyncio
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
os.environ.setdefault("ENV", "development")

REPO = Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
sys.path.insert(0, str(API_SRC))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from services import cdr_activity as act  # noqa: E402
from services import tenant_redaction as tr  # noqa: E402

NY = "America/New_York"
#: Pinned "now": Wed 2026-09-30 15:20 UTC == 11:20 EDT.
NOW = datetime(2026, 9, 30, 15, 20, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# 1) Pure logic (no DB)
# ---------------------------------------------------------------------------
def test_one_row_per_call_predicate_matches_router():
    from routers import cdrs
    assert act.ONE_ROW_PER_CALL_SQL == cdrs.ONE_ROW_PER_CALL_SQL


def test_window_24h_utc():
    w = act.compute_window("24h", "UTC", NOW)
    assert w.bucket == "hour" and len(w.bucket_starts) == 24
    assert w.hi == datetime(2026, 9, 30, 16, 0, tzinfo=timezone.utc)
    assert w.lo == datetime(2026, 9, 29, 16, 0, tzinfo=timezone.utc)
    assert w.bucket_starts[0].isoformat() == "2026-09-29T16:00:00+00:00"
    assert w.bucket_starts[-1].isoformat() == "2026-09-30T15:00:00+00:00"


def test_window_24h_half_hour_zone():
    # Kolkata +05:30: local now 20:50 -> current local hour 20:00 == 14:30Z.
    w = act.compute_window("24h", "Asia/Kolkata", NOW)
    assert w.hi == datetime(2026, 9, 30, 15, 30, tzinfo=timezone.utc)
    assert w.bucket_starts[0].isoformat() == "2026-09-29T21:00:00+05:30"
    assert w.bucket_starts[-1].isoformat() == "2026-09-30T20:00:00+05:30"


def test_window_24h_across_dst_keeps_24_distinct_hours():
    # 2026-11-01 06:30Z = 01:30 EST (second pass after fall-back).
    now = datetime(2026, 11, 1, 6, 30, tzinfo=timezone.utc)
    w = act.compute_window("24h", NY, now)
    assert len({s.astimezone(timezone.utc) for s in w.bucket_starts}) == 24
    assert (w.hi - w.lo) == timedelta(hours=24)
    labels = [s.isoformat() for s in w.bucket_starts]
    assert "2026-11-01T01:00:00-04:00" in labels and "2026-11-01T01:00:00-05:00" in labels


@pytest.mark.parametrize("rng,n", [("7d", 7), ("30d", 30)])
def test_window_daily(rng, n):
    w = act.compute_window(rng, NY, NOW)
    assert w.bucket == "day" and len(w.bucket_starts) == n
    assert w.bucket_starts[-1].isoformat() == "2026-09-30T00:00:00-04:00"
    assert w.bucket_starts[0].date() == date(2026, 9, 30) - timedelta(days=n - 1)
    assert w.lo == w.bucket_starts[0].astimezone(timezone.utc)
    assert w.hi == datetime(2026, 10, 1, 4, 0, tzinfo=timezone.utc)
    assert w.anchor_date == w.bucket_starts[0].date()


def test_window_daily_dst_day_is_23h():
    # 2026-03-08 is the US spring-forward day: its bucket spans 23 real hours.
    w = act.compute_window("7d", NY, datetime(2026, 3, 10, 12, tzinfo=timezone.utc))
    starts = [s.astimezone(timezone.utc) for s in w.bucket_starts] + [w.hi]
    spans = {w.bucket_starts[i].date(): starts[i + 1] - starts[i] for i in range(7)}
    assert spans[date(2026, 3, 8)] == timedelta(hours=23)


def test_window_90d_weeks():
    w = act.compute_window("90d", NY, NOW)
    assert w.bucket == "week"
    first_day = date(2026, 9, 30) - timedelta(days=89)          # 2026-07-03 (Fri)
    assert w.lo == datetime(2026, 7, 3, 4, 0, tzinfo=timezone.utc)
    assert all(s.weekday() == 0 for s in w.bucket_starts)       # Monday starts
    assert w.bucket_starts[0].date() == first_day - timedelta(days=first_day.weekday())
    assert w.bucket_starts[-1].date() == date(2026, 9, 28)
    assert 13 <= len(w.bucket_starts) <= 14
    assert w.bucket_starts[0].astimezone(timezone.utc) < w.lo   # first week partial


def test_canonical_tz():
    assert act.canonical_tz("UTC") == "UTC"
    assert act.canonical_tz("utc") == "UTC"
    assert act.canonical_tz("america/new_york") == NY
    for bad in ("Mars/Olympus", "", None, "../../etc/passwd", "/etc/localtime",
                "America/New_York; DROP TABLE cdrs", "x" * 65):
        assert act.canonical_tz(bad) is None


def test_pct():
    assert act.pct(0, 0) is None
    assert act.pct(1, 3) == 33.3
    assert act.pct(2, 3) == 66.7
    assert act.pct(5, 5) == 100.0


@pytest.mark.parametrize("rng", ["24h", "7d", "30d", "90d"])
@pytest.mark.parametrize("now", [
    NOW,
    datetime(2026, 3, 8, 7, 30, tzinfo=timezone.utc),    # just after spring-forward
    datetime(2026, 3, 12, 12, tzinfo=timezone.utc),
    datetime(2026, 11, 1, 6, 30, tzinfo=timezone.utc),   # 01:30 EST, 2nd pass
    datetime(2026, 11, 5, 12, tzinfo=timezone.utc),
])
@pytest.mark.parametrize("tz", [NY, "UTC", "Asia/Kolkata", "Australia/Lord_Howe"])
def test_bucket_edges_are_python_starts_ascending(rng, now, tz):
    w = act.compute_window(rng, tz, now)
    edges = w.bucket_edges_utc()
    assert edges == [s.astimezone(timezone.utc) for s in w.bucket_starts]
    assert all(a < b for a, b in zip(edges, edges[1:]))
    assert edges[0] <= w.lo < edges[1] and edges[-1] < w.hi
    if rng != "90d":
        assert edges[0] == w.lo                  # only 90d's first week is clipped


def test_sql_buckets_by_bound_edges_not_pg_tz():
    for rng in ("24h", "7d", "90d"):
        w = act.compute_window(rng, NY, NOW)
        sql, args = act.build_activity_query(w, staff=True, customer_id=None,
                                             product_type="rcf", destination=None)
        assert "width_bucket(start_time, $3::timestamptz[])" in sql
        assert "AT TIME ZONE" not in sql and "date_trunc" not in sql
        assert NY not in args                    # the tz never reaches PostgreSQL
        assert args[:3] == [w.lo, w.hi, w.bucket_edges_utc()]
        assert args[3:] == ["rcf"]


def test_unsorted_edges_rejected():
    w = act.compute_window("7d", NY, NOW)
    bad = act.ActivityWindow(w.range, w.bucket, w.tz, w.lo, w.hi,
                             tuple(reversed(w.bucket_starts)), w.anchor_date)
    with pytest.raises(ValueError):
        bad.bucket_edges_utc()


def test_out_of_range_bucket_is_logged_not_silent(caplog):
    w = act.compute_window("7d", NY, NOW)
    rows = [
        {"is_total": True, "b": None, "calls": 4, "answered": 0},
        {"is_total": False, "b": 0, "calls": 1, "answered": 0},
        {"is_total": False, "b": 7, "calls": 2, "answered": 0},    # n == 7
        {"is_total": False, "b": -1, "calls": 1, "answered": 0},
    ]
    with caplog.at_level("WARNING", logger=act.logger.name):
        body = act.shape_activity(w, rows, staff=True)
    assert body["kpis"]["calls"] == 4
    assert sum(p["calls"] for p in body["points"]) == 1
    msgs = [r.getMessage() for r in caplog.records if r.levelname == "WARNING"]
    assert len(msgs) == 2 and all("out-of-range bucket" in m for m in msgs), msgs


# ---------------------------------------------------------------------------
# 2) Integration: real router over ephemeral PostgreSQL
# ---------------------------------------------------------------------------
asyncpg = pytest.importorskip("asyncpg", reason="asyncpg required for integration tests")
httpx = pytest.importorskip("httpx", reason="httpx required for integration tests")

from cdr_schema import apply_cdr_column_migrations  # noqa: E402
from test_tenant_redaction import _SCHEMA, _EphemeralPG, _find_pg_bin  # noqa: E402

PG_BIN = _find_pg_bin()


class _ActivityPG(_EphemeralPG):
    def __init__(self, pg_bin):
        super().__init__(pg_bin)
        self.port = 55463   # distinct from every other test module


_LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


CID_A, CID_B = 101, 202
D_A1, D_A2, D_B = "+16175550101", "+16175550102", "+12085550900"

# tag, cid, product, dest, start, ring_s, talk_s (None = unanswered),
#   status, grade, mos
# duration_ms = ring + talk. Staff "answered" = answer_time AND duration_ms>0;
# tenant "answered" = answer_time AND talk > 0 (exactly the UI's per-shape
# hasTalkTime). "a5" is answered-with-zero-talk: staff yes, tenant no.
CDRS = [
    ("a1", CID_A, "rcf", D_A1, NOW - timedelta(minutes=10), 5, 60, "rated", "great", 4.4),
    ("a2", CID_A, "rcf", D_A1, NOW - timedelta(hours=2), 5, 30, "rated", "good", 4.1),
    ("a3", CID_A, "rcf", D_A2, NOW - timedelta(days=1), 20, None, "unanswered", None, None),
    ("a4", CID_A, "rcf", D_A1, NOW - timedelta(days=3), 5, 120, "no_rtp", "poor", None),
    ("a5", CID_A, "rcf", D_A2, NOW - timedelta(hours=5), 5, 0, "short", None, None),
    # 03:30Z on 9/30 == 23:30 EDT on 9/29: "today" in UTC, "yesterday" in NY
    ("tz", CID_A, "rcf", D_A2, datetime(2026, 9, 30, 3, 30, tzinfo=timezone.utc),
     5, 10, "short", None, None),
    ("a6", CID_A, "trunk", D_A1, NOW - timedelta(hours=1), 5, 60, "rated", "great", 4.4),
    ("a7", CID_A, "rcf", D_A1, NOW - timedelta(days=20), 5, 90, "rated", "fair", 3.8),
    ("a8", CID_A, "rcf", D_A1, NOW - timedelta(days=80), 5, 60, "rated", "great", 4.5),
    ("a9", CID_A, "rcf", D_A1, NOW - timedelta(days=100), 5, 60, "rated", "great", 4.5),
    ("b1", CID_B, "rcf", D_B, NOW - timedelta(minutes=30), 5, 45, "rated", "good", 4.2),
]
#: Calls that also carry carrier B-leg rows (must never be counted).
B_LEG_TAGS = {"a1", "a2", "a4", "b1"}

#: DST-edge calls for a separate customer (all outside every NOW-anchored
#: window: Nov 2026 is after NOW, Mar 2026 is > 90 days before it).
#: US 2026: spring-forward Sun 3/8 07:00Z (02:00 EST -> 03:00 EDT, 23h day);
#: fall-back Sun 11/1 06:00Z (02:00 EDT -> 01:00 EST, 25h day). Both Sundays,
#: so the following Monday is also an ISO-week edge.
CID_DST = 303
DST_STARTS = [
    datetime(2026, 3, 8, 4, 59, tzinfo=timezone.utc),    # Sat 3/7 23:59 EST
    datetime(2026, 3, 8, 5, 0, tzinfo=timezone.utc),     # Sun 3/8 00:00 EST
    datetime(2026, 3, 8, 6, 59, tzinfo=timezone.utc),    # 01:59 EST
    datetime(2026, 3, 8, 7, 0, tzinfo=timezone.utc),     # 03:00 EDT
    datetime(2026, 3, 9, 3, 59, tzinfo=timezone.utc),    # Sun 3/8 23:59 EDT
    datetime(2026, 3, 9, 4, 0, tzinfo=timezone.utc),     # Mon 3/9 00:00 EDT
    datetime(2026, 10, 31, 3, 59, tzinfo=timezone.utc),  # Fri 10/30 23:59 EDT
    datetime(2026, 11, 1, 3, 59, tzinfo=timezone.utc),   # Sat 10/31 23:59 EDT
    datetime(2026, 11, 1, 4, 0, tzinfo=timezone.utc),    # Sun 11/1 00:00 EDT
    datetime(2026, 11, 1, 5, 30, tzinfo=timezone.utc),   # 01:30 EDT (1st pass)
    datetime(2026, 11, 1, 6, 30, tzinfo=timezone.utc),   # 01:30 EST (2nd pass)
    datetime(2026, 11, 2, 4, 59, tzinfo=timezone.utc),   # Sun 11/1 23:59 EST
    datetime(2026, 11, 2, 5, 0, tzinfo=timezone.utc),    # Mon 11/2 00:00 EST
]
CDRS += [(f"dst{i}", CID_DST, "rcf", D_B, ts, 5, 30, "rated", "good", 4.2)
         for i, ts in enumerate(DST_STARTS)]


def _uuid(tag):
    return f"act-{tag}-0000-0000-0000-000000000000"


@pytest.fixture(scope="module")
def activity_db():
    if PG_BIN is None:
        pytest.skip("no local PostgreSQL binaries; set TEST_PG_BIN to run")
    pg = _ActivityPG(PG_BIN)
    try:
        pg.start()
    except Exception as e:  # noqa: BLE001
        pg.stop()
        pytest.skip(f"could not start throwaway PostgreSQL: {e}")

    from db import database as db

    async def _setup():
        owner = await asyncpg.create_pool(
            host=pg.sock, port=pg.port, user="postgres", database="postgres",
            min_size=1, max_size=2, statement_cache_size=0)
        async with owner.acquire() as conn:
            await conn.execute(_SCHEMA)
            await apply_cdr_column_migrations(conn)
            await conn.execute("CREATE INDEX idx_cdrs_customer_time ON cdrs(customer_id, start_time DESC)")
            # stands in for the Timescale hypertable's default time index
            await conn.execute("CREATE INDEX idx_cdrs_start_time ON cdrs(start_time DESC)")
            await conn.execute("GRANT ALL ON ALL TABLES IN SCHEMA public TO api")
            for tag, cid, product, dest, start, ring, talk, status, grade, mos in CDRS:
                answer = start + timedelta(seconds=ring) if talk is not None else None
                end = start + timedelta(seconds=ring + (talk or 0))
                dur_ms = (ring + (talk or 0)) * 1000
                await conn.execute(
                    "INSERT INTO cdrs (uuid, customer_id, product_type, direction,"
                    " caller_id, destination, start_time, answer_time, end_time,"
                    " duration_ms, billable_ms, rate_per_min, total_cost, hangup_cause,"
                    " leg, call_id, call_quality_status, call_quality_grade, call_mos)"
                    " VALUES ($1, $2, $3, 'inbound', '+12125550000', $4, $5, $6, $7,"
                    " $8, $8, 0.012, 0.024, 'NORMAL_CLEARING', 'A', $1, $9, $10, $11)",
                    _uuid(tag), cid, product, dest, start, answer, end, dur_ms,
                    status, grade, mos)
                if tag in B_LEG_TAGS:
                    for attempt in (1, 2):
                        await conn.execute(
                            "INSERT INTO cdrs (uuid, customer_id, product_type, direction,"
                            " caller_id, destination, start_time, answer_time, end_time,"
                            " duration_ms, billable_ms, hangup_cause, leg, call_id,"
                            " leg_attempt, call_quality_status, call_quality_grade, call_mos)"
                            " VALUES ($1, $2, $3, 'outbound', $4, '+17745550000', $5, $6, $7,"
                            " 99999, 99999, 'NORMAL_CLEARING', 'B', $8, $9, 'no_rtp', 'poor', 1.0)",
                            f"act-{tag}-b{attempt}-000-0000-000000000000", cid, product, dest,
                            start + timedelta(seconds=attempt), answer, end,
                            _uuid(tag), attempt)
        await owner.close()
        db.pool = await asyncpg.create_pool(
            host=pg.sock, port=pg.port, user="api", password="api_secret",
            database="postgres", min_size=1, max_size=5, statement_cache_size=0)

    async def _teardown():
        if db.pool is not None:
            await db.pool.close()
            db.pool = None

    _run(_setup())
    try:
        yield db
    finally:
        _run(_teardown())
        pg.stop()


@pytest.fixture(autouse=True)
def _pin_now(monkeypatch):
    monkeypatch.setattr(act, "utc_now", lambda: NOW)


@pytest.fixture(scope="module")
def client(activity_db):
    from fastapi import FastAPI
    from fastapi.responses import ORJSONResponse
    from middleware.auth import JWTAuthMiddleware
    from routers import cdrs

    app = FastAPI(default_response_class=ORJSONResponse)
    app.add_middleware(JWTAuthMiddleware)
    app.include_router(cdrs.router, prefix="/v1/cdrs")
    app.include_router(cdrs.router, prefix="/cdrs")
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    c = httpx.AsyncClient(transport=transport, base_url="http://test")
    try:
        yield c
    finally:
        _run(c.aclose())


@pytest.fixture(scope="module")
def tokens(activity_db):
    from auth.security import create_access_token

    def mint(sub, role, cid):
        return create_access_token(
            {"sub": sub, "email": f"{sub}@test.local", "role": role, "customer_id": cid})

    return {
        "admin": mint("1", "admin", None),
        "support": mint("2", "support", None),
        "user_a": mint("3", "user", CID_A),
        "user_b": mint("5", "user", CID_B),
    }


def _get(client, tokens, who, path="/v1/cdrs/activity", **params):
    return _run(client.get(path, params=params,
                           headers={"Authorization": f"Bearer {tokens[who]}"}))


def _ok(resp):
    assert resp.status_code == 200, resp.text
    return resp.json()


KPI_COMMON = {"calls", "answered", "asr_pct", "graded", "good_or_better",
              "good_share_pct", "poor", "one_way", "median_mos"}
POINT_KEYS = {"t", "calls", "answered", "missed", "asr_pct", "graded",
              "good_or_better", "good_share_pct", "one_way", "median_mos"}


def _assert_tenant_safe(obj, path="$"):
    """No seconds / cost / ms / rate keys anywhere in a tenant body."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            low = k.lower()
            assert not any(s in low for s in ("sec", "cost", "_ms", "rate_per",
                                              "billable", "margin")), f"{path}.{k}"
            _assert_tenant_safe(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            _assert_tenant_safe(v, f"{path}[{i}]")


def _day(body, iso_prefix):
    return next(p for p in body["points"] if p["t"].startswith(iso_prefix))


def test_staff_7d_ny_shape_and_values(client, tokens):
    body = _ok(_get(client, tokens, "admin", customer_id=CID_A, tz=NY))
    assert set(body) == {"range", "bucket", "tz", "start", "end", "kpis", "points"}
    assert (body["range"], body["bucket"], body["tz"]) == ("7d", "day", NY)
    assert body["start"] == "2026-09-24T00:00:00-04:00"
    assert body["end"] == "2026-10-01T00:00:00-04:00"
    k = body["kpis"]
    assert set(k) == KPI_COMMON | {"avg_duration_sec"}
    # 7d rcf for A: a1 a2 a3 a4 a5 tz (a6 trunk, a7+ older; B-legs excluded)
    assert k["calls"] == 6
    assert k["answered"] == 5            # a1 a2 a4 a5(ring-only dur>0) tz
    assert k["asr_pct"] == 83.3
    assert (k["graded"], k["good_or_better"], k["poor"], k["one_way"]) == (3, 2, 1, 1)
    assert k["good_share_pct"] == 66.7
    assert k["median_mos"] == 4.25       # rated+graded only: 4.4, 4.1
    # mean duration_ms/1000 over staff-answered: (65+35+125+5+15)/5
    assert k["avg_duration_sec"] == 49.0
    assert len(body["points"]) == 7
    assert all(set(p) == POINT_KEYS for p in body["points"])
    assert sum(p["calls"] for p in body["points"]) == k["calls"]
    today, yday = _day(body, "2026-09-30"), _day(body, "2026-09-29")
    assert (today["calls"], today["answered"], today["missed"]) == (3, 3, 0)  # a1 a2 a5
    assert (yday["calls"], yday["answered"], yday["missed"]) == (2, 1, 1)     # a3 tz
    assert today["median_mos"] == 4.25 and today["good_share_pct"] == 100.0
    empty = _day(body, "2026-09-25")
    assert empty == {"t": "2026-09-25T00:00:00-04:00", "calls": 0, "answered": 0,
                     "missed": 0, "asr_pct": None, "graded": 0, "good_or_better": 0,
                     "good_share_pct": None, "one_way": 0, "median_mos": None}
    assert _day(body, "2026-09-27")["one_way"] == 1                           # a4


def test_tz_moves_late_night_call_to_ny_date(client, tokens):
    utc = _ok(_get(client, tokens, "admin", customer_id=CID_A, tz="UTC"))
    assert utc["tz"] == "UTC"
    assert _day(utc, "2026-09-30")["calls"] == 4           # a1 a2 a5 tz
    assert _day(utc, "2026-09-29")["calls"] == 1           # a3
    assert utc["points"][-1]["t"] == "2026-09-30T00:00:00+00:00"


def test_default_tz_is_utc_and_case_insensitive(client, tokens):
    assert _ok(_get(client, tokens, "admin", customer_id=CID_A))["tz"] == "UTC"
    assert _ok(_get(client, tokens, "admin", customer_id=CID_A,
                    tz="america/new_york"))["tz"] == NY


def test_24h_hourly_zero_filled(client, tokens):
    body = _ok(_get(client, tokens, "admin", customer_id=CID_A, range="24h", tz="UTC"))
    assert body["bucket"] == "hour" and len(body["points"]) == 24
    assert body["start"] == "2026-09-29T16:00:00+00:00"
    assert body["end"] == "2026-09-30T16:00:00+00:00"
    calls = [p["calls"] for p in body["points"]]
    # a1 15:10 -> 23, a2 13:20 -> 21, a5 10:20 -> 18, tz 03:30 -> 11; a3 (24h ago) out
    assert {i: c for i, c in enumerate(calls) if c} == {23: 1, 21: 1, 18: 1, 11: 1}
    assert body["kpis"]["calls"] == 4


def test_24h_half_hour_zone(client, tokens):
    body = _ok(_get(client, tokens, "admin", customer_id=CID_A, range="24h",
                    tz="Asia/Kolkata"))
    assert body["points"][0]["t"] == "2026-09-29T21:00:00+05:30"
    assert body["points"][23]["calls"] == 1                   # a1 (14:30Z..15:30Z)
    assert body["kpis"]["calls"] == 4


def test_30d_daily(client, tokens):
    body = _ok(_get(client, tokens, "admin", customer_id=CID_A, range="30d", tz=NY))
    assert body["bucket"] == "day" and len(body["points"]) == 30
    assert body["kpis"]["calls"] == 7                         # + a7 (20d)
    assert sum(p["calls"] for p in body["points"]) == 7
    assert body["kpis"]["median_mos"] == 4.1                  # 4.4 4.1 3.8


def test_90d_weekly(client, tokens):
    body = _ok(_get(client, tokens, "admin", customer_id=CID_A, range="90d", tz=NY))
    w = act.compute_window("90d", NY, NOW)
    assert body["bucket"] == "week" and len(body["points"]) == len(w.bucket_starts)
    assert body["start"] == "2026-07-03T00:00:00-04:00"
    for p in body["points"]:
        assert datetime.fromisoformat(p["t"]).weekday() == 0
        assert datetime.fromisoformat(p["t"]).time().isoformat() == "00:00:00"
    assert body["kpis"]["calls"] == 8                         # + a8 (80d); a9 out
    assert sum(p["calls"] for p in body["points"]) == 8
    assert body["points"][-1]["t"] == "2026-09-28T00:00:00-04:00"
    assert body["points"][-1]["calls"] == 5                   # Mon 9/28 .. now


def test_tenant_scoped_and_minutes_only(client, tokens):
    body = _ok(_get(client, tokens, "user_a", customer_id=CID_B, tz=NY))
    k = body["kpis"]
    assert set(k) == KPI_COMMON | {"avg_duration_minutes"}
    assert k["calls"] == 6                                    # A's calls, not B's
    # tenant answered == talk time > 0: a5 (ring only) is NOT answered
    assert k["answered"] == 4 and k["asr_pct"] == 66.7
    # mean per-call whole minutes: a1 1, a2 1 (30s half-up), a4 2, tz 1 -> 1.25
    assert k["avg_duration_minutes"] == 1.3
    _assert_tenant_safe(body)
    assert _day(body, "2026-09-30")["answered"] == 2          # a1 a2 (a5 not)


def test_tenant_b_sees_only_b(client, tokens):
    body = _ok(_get(client, tokens, "user_b", tz=NY))
    assert body["kpis"]["calls"] == 1 and body["kpis"]["median_mos"] == 4.2
    _assert_tenant_safe(body)


@pytest.mark.parametrize("who", ["admin", "support"])
def test_staff_all_customers_and_single(client, tokens, who):
    everyone = _ok(_get(client, tokens, who, tz=NY))["kpis"]
    assert everyone["calls"] == 7                             # A's 6 + b1
    assert "avg_duration_sec" in everyone
    assert _ok(_get(client, tokens, who, tz=NY, customer_id=CID_B))["kpis"]["calls"] == 1
    assert _ok(_get(client, tokens, who, tz=NY, customer_id=0))["kpis"]["calls"] == 0


def test_product_type_filter(client, tokens):
    trunk = _ok(_get(client, tokens, "admin", customer_id=CID_A, tz=NY,
                     product_type="trunk"))["kpis"]
    assert trunk["calls"] == 1                                # a6


def test_destination_exact(client, tokens):
    k = _ok(_get(client, tokens, "admin", customer_id=CID_A, tz=NY,
                 destination=D_A1))["kpis"]
    assert k["calls"] == 3                                    # a1 a2 a4
    assert _ok(_get(client, tokens, "admin", customer_id=CID_A, tz=NY,
                    destination=D_A1[:-1]))["kpis"]["calls"] == 0   # not a prefix match
    assert _ok(_get(client, tokens, "admin", customer_id=CID_A, tz=NY,
                    destination="%"))["kpis"]["calls"] == 0


@pytest.mark.parametrize("params", [
    {"tz": "Mars/Olympus"}, {"tz": "../../etc/passwd"}, {"tz": ""},
    {"range": "1y"}, {"range": "24H"}, {"customer_id": "x"},
])
def test_validation_422(client, tokens, params):
    assert _get(client, tokens, "admin", **params).status_code == 422
    assert _get(client, tokens, "user_a", **params).status_code == 422


def test_unauthenticated_401(client):
    assert _run(client.get("/v1/cdrs/activity")).status_code == 401


def test_legacy_mount_and_not_shadowed(client, tokens):
    body = _ok(_get(client, tokens, "admin", path="/cdrs/activity", customer_id=CID_A))
    assert body["range"] == "7d" and len(body["points"]) == 7


def test_statement_timeout_maps_to_503(client, tokens, monkeypatch):
    monkeypatch.setattr(act, "ACTIVITY_STATEMENT_TIMEOUT_MS", 1)
    real = act.build_activity_query

    def slow(*a, **kw):
        sql, args = real(*a, **kw)
        return sql.replace("FROM f\n", "FROM f, pg_sleep(0.3)\n", 1), args
    monkeypatch.setattr(act, "build_activity_query", slow)
    assert _get(client, tokens, "admin", customer_id=CID_A).status_code == 503
    monkeypatch.undo()
    monkeypatch.setattr(act, "utc_now", lambda: NOW)
    assert _get(client, tokens, "admin", customer_id=CID_A).status_code == 200

    async def show():
        async with act.db.pool.acquire() as conn:
            return await conn.fetchval("SHOW statement_timeout")
    assert _run(show()) == "0"


@pytest.mark.parametrize("staff,cid", [(True, None), (True, CID_A), (False, CID_A)])
def test_scan_is_sargable_range(activity_db, staff, cid):
    w = act.compute_window("30d", NY, NOW)
    sql, args = act.build_activity_query(w, staff=staff, customer_id=cid,
                                         product_type="rcf", destination=None)

    async def plan():
        async with activity_db.pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute("SET LOCAL enable_seqscan = off")
                rows = await conn.fetch("EXPLAIN " + sql, *args)
                return "\n".join(r[0] for r in rows)
    text = _run(plan())
    # Either index is a valid choice on a tiny table; what matters is that
    # the window range is an INDEX condition (sargable), not a filter.
    cond = next((ln for ln in text.splitlines() if "Index Cond" in ln), "")
    assert "idx_cdrs_customer_time" in text or "idx_cdrs_start_time" in text, text
    assert "start_time >=" in cond and "start_time <" in cond, text
    if cid is None:
        assert "customer_id" not in text, text


def test_tenant_sql_never_reads_duration_or_cost_columns():
    w = act.compute_window("7d", NY, NOW)
    sql, _ = act.build_activity_query(w, staff=False, customer_id=CID_A,
                                      product_type="rcf", destination=None)
    for col in ("duration_ms", "billable_ms", "total_cost", "rate_per_min"):
        assert col not in sql
    assert tr.TALK_MS_SQL in sql


# ---------------------------------------------------------------------------
# 3) DST: Python edges vs. rows actually bucketed by PostgreSQL
# ---------------------------------------------------------------------------
def _expected_point_t(ts, rng, tz):
    """Independent oracle (zoneinfo only): the local bucket label for `ts`."""
    from zoneinfo import ZoneInfo
    local = ts.astimezone(ZoneInfo(tz))
    if rng == "24h":
        return ts.replace(minute=0, second=0, microsecond=0)   # NY: whole-hour offsets
    d = local.date()
    if rng == "90d":
        d -= timedelta(days=d.weekday())
    return d


_DST_NOWS = {
    "spring+0": datetime(2026, 3, 9, 4, 30, tzinfo=timezone.utc),   # Mon 3/9 00:30 EDT
    "spring+4d": datetime(2026, 3, 12, 12, tzinfo=timezone.utc),
    "fall+0": datetime(2026, 11, 1, 23, 0, tzinfo=timezone.utc),    # Sun 11/1 18:00 EST
    "fall+4d": datetime(2026, 11, 5, 12, tzinfo=timezone.utc),
}
#: 24h only where its window holds the transition (the +4d nows are past it).
_DST_CASES = [(r, k) for k in _DST_NOWS for r in ("24h", "7d", "30d", "90d")
              if not (r == "24h" and k.endswith("+4d"))]


@pytest.mark.parametrize("rng,now_id", _DST_CASES)
def test_dst_crossing_buckets_match_zoneinfo(client, tokens, monkeypatch, rng, now_id):
    now = _DST_NOWS[now_id]
    monkeypatch.setattr(act, "utc_now", lambda: now)
    body = _ok(_get(client, tokens, "admin", customer_id=CID_DST, range=rng, tz=NY))
    w = act.compute_window(rng, NY, now)
    in_window = [ts for ts in DST_STARTS if w.lo <= ts < w.hi]
    assert in_window, "fixture should exercise this window"
    # No silent drops: every call counted in the KPIs shows in some point.
    assert body["kpis"]["calls"] == len(in_window)
    assert sum(p["calls"] for p in body["points"]) == len(in_window)
    expected: dict = {}
    for ts in in_window:
        key = _expected_point_t(ts, rng, NY)
        expected[key] = expected.get(key, 0) + 1
    got = {}
    for p in body["points"]:
        if not p["calls"]:
            continue
        t = datetime.fromisoformat(p["t"])
        key = t.astimezone(timezone.utc) if rng == "24h" else t.date()
        got[key] = p["calls"]
    assert got == expected, (rng, now, body["points"])
