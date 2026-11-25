"""GET /v1/metrics/calls-active — fleet-wide connected calls over time.

Contract: docs/CALLS_ACTIVE_API.md. The REAL router behind the REAL JWT
middleware, driven with real minted JWTs per role. VictoriaMetrics is an
httpx.MockTransport handler (no network, no database, nothing skipped): it
records what the API asked for and answers like the Prometheus query API.

Covers: step alignment and the settle delay, a gap -> null (never 0), a
partly-reporting fleet, parameter limits, that no caller text reaches the
query, admin-only access, and every upstream failure -> 503
``metrics_unavailable`` (never a 500, never an empty series).

Run:  JWT_SECRET_KEY=x python3 -m pytest tests/test_metrics_calls_active.py -q
"""
import asyncio
import json
import os
import pathlib
import subprocess
import sys
from datetime import datetime, timezone

import httpx
import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
os.environ.setdefault("ENV", "development")

REPO = pathlib.Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
sys.path.insert(0, str(API_SRC))

from fastapi import FastAPI  # noqa: E402

from auth.security import create_access_token  # noqa: E402
from middleware.auth import JWTAuthMiddleware  # noqa: E402
from routers import metrics as m  # noqa: E402

_LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


def _ts(text):
    return int(datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ")
               .replace(tzinfo=timezone.utc).timestamp())


#: "Now" for every test unless it pins another: 3 min 10 s past a 5-minute mark.
NOW = _ts("2026-11-25T12:03:10Z")
NOON = _ts("2026-11-25T12:00:00Z")

_app = FastAPI()
_app.add_middleware(JWTAuthMiddleware)
_app.include_router(m.router, prefix="/v1/metrics")
_app.include_router(m.router, prefix="/metrics")


def _token(sub, role, customer_id):
    return {"Authorization": "Bearer " + create_access_token(
        {"sub": sub, "email": f"{role}@test.local", "role": role,
         "customer_id": customer_id})}


ADMIN = _token("1", "admin", None)
SUPPORT = _token("2", "support", None)
TENANT = _token("3", "user", 42)
READONLY = _token("4", "readonly", 42)


def _get(path, headers=ADMIN):
    async def go():
        transport = httpx.ASGITransport(app=_app, raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport, base_url="http://api") as c:
            return await c.get(path, headers=headers)
    return _run(go())


class FakeVM:
    """Answers /api/v1/query_range and /api/v1/query; records every request."""

    def __init__(self, nodes=None, instant=None, range_body=None, instant_body=None,
                 fail=None):
        #: node -> {unix ts: calls}; a ts left out is a mark with no reading.
        self.nodes = nodes or {}
        #: node -> calls for the "now" query (default: none reporting).
        self.instant = instant or {}
        self.range_body = range_body
        self.instant_body = instant_body
        self.fail = fail
        self.requests = []

    def handler(self, request):
        self.requests.append(request)
        if self.fail is not None:
            return self.fail(request)
        params = request.url.params
        if request.url.path == "/api/v1/query_range":
            if self.range_body is not None:
                return self.range_body
            start, end, step = int(params["start"]), int(params["end"]), int(params["step"])
            result = []
            for node, readings in self.nodes.items():
                values = [[ts, str(readings[ts])] for ts in range(start, end + 1, step)
                          if ts in readings]
                if values:
                    result.append({"metric": {"freeswitch_node": node, "zone": "east"},
                                   "values": values})
            return _ok("matrix", result)
        assert request.url.path == "/api/v1/query"
        if self.instant_body is not None:
            return self.instant_body
        return _ok("vector", [
            {"metric": {"freeswitch_node": node, "zone": "east"},
             "value": [int(params["time"]), str(calls)]}
            for node, calls in self.instant.items()])

    def one(self, path):
        hits = [r for r in self.requests if r.url.path == path]
        assert len(hits) == 1, [str(r.url) for r in self.requests]
        return hits[0].url.params


def _ok(result_type, result):
    return httpx.Response(200, json={
        "status": "success", "data": {"resultType": result_type, "result": result}})


@pytest.fixture
def vm(monkeypatch):
    def install(fake=None, now=NOW):
        fake = fake or FakeVM()
        monkeypatch.delenv("VICTORIAMETRICS_URL", raising=False)
        monkeypatch.setattr(m, "_now", lambda: float(now))
        monkeypatch.setattr(m, "_client", lambda: httpx.AsyncClient(
            transport=httpx.MockTransport(fake.handler), timeout=m.UPSTREAM_TIMEOUT_S))
        return fake
    return install


def _marks(start, end, step, calls):
    return {ts: calls for ts in range(start, end + 1, step)}


# ---------------------------------------------------------------------------
# Happy path, alignment, what is sent upstream
# ---------------------------------------------------------------------------

def test_series_is_aligned_summed_and_ends_at_the_last_completed_step(vm):
    start = NOON - 3600
    fake = vm(FakeVM(
        nodes={"east-fs": _marks(start, NOON, 300, 7),
               "east-fs-2": _marks(start, NOON, 300, 0),      # standby: its own 0
               "west-fs": _marks(start, NOON, 300, 5)},
        instant={"east-fs": 9, "east-fs-2": 0, "west-fs": 4}))
    r = _get("/v1/metrics/calls-active?hours=1&step_seconds=300")
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"step_seconds", "start", "end", "points", "current"}
    assert body["step_seconds"] == 300
    assert body["start"] == "2026-11-25T11:00:00Z"
    assert body["end"] == "2026-11-25T12:00:00Z"
    points = body["points"]
    assert len(points) == 13                                  # both ends included
    assert [p["t"] for p in points][:2] == ["2026-11-25T11:00:00Z", "2026-11-25T11:05:00Z"]
    assert points[-1] == {"t": "2026-11-25T12:00:00Z", "calls": 12, "nodes": 3}
    assert all(_ts(p["t"]) % 300 == 0 for p in points)
    assert all(p["calls"] == 12 and type(p["calls"]) is int for p in points)
    assert body["current"] == {"t": "2026-11-25T12:03:10Z", "calls": 13, "nodes": 3}

    # What VictoriaMetrics was asked: the constant query + computed integers.
    rng = fake.one("/api/v1/query_range")
    assert dict(rng) == {"query": m.CALLS_BY_NODE_QUERY, "start": str(start),
                         "end": str(NOON), "step": "300"}
    assert dict(fake.one("/api/v1/query")) == {"query": m.CALLS_BY_NODE_QUERY,
                                               "time": str(NOW)}
    assert str(fake.requests[0].url).startswith("http://victoriametrics:8428/api/v1/")


def test_the_query_text_is_fixed():
    assert m.CALLS_BY_NODE_QUERY == (
        "max by (freeswitch_node, zone) (last_over_time(freeswitch_calls_active[60s])) "
        "and on (freeswitch_node, zone) "
        "(max by (freeswitch_node, zone) (max_over_time(freeswitch_esl_scrape_ok[60s])) == 1)")
    assert m.FRESH_S <= 60          # never longer than the smallest step


def test_defaults_are_24_hours_at_5_minutes(vm):
    fake = vm()
    body = _get("/v1/metrics/calls-active").json()
    assert body["step_seconds"] == 300 and len(body["points"]) == 289
    assert body["start"] == "2026-11-24T12:00:00Z" and body["end"] == "2026-11-25T12:00:00Z"
    assert fake.one("/api/v1/query_range")["step"] == "300"


@pytest.mark.parametrize("now,end", [
    ("2026-11-25T12:00:29Z", "2026-11-25T11:55:00Z"),   # 12:00 is not settled yet
    ("2026-11-25T12:00:30Z", "2026-11-25T12:00:00Z"),
    ("2026-11-25T12:04:59Z", "2026-11-25T12:00:00Z"),
])
def test_a_step_is_completed_30_seconds_after_its_mark(vm, now, end):
    vm(now=_ts(now))
    assert _get("/v1/metrics/calls-active?hours=1").json()["end"] == end


@pytest.mark.parametrize("hours,step", [(1, 60), (1, 420), (5, 3600), (168, 3600), (3, 777)])
def test_every_timestamp_is_a_multiple_of_the_step_since_the_epoch(vm, hours, step):
    fake = vm()
    body = _get(f"/v1/metrics/calls-active?hours={hours}&step_seconds={step}").json()
    stamps = [_ts(p["t"]) for p in body["points"]]
    assert all(ts % step == 0 for ts in stamps)
    assert stamps == list(range(stamps[0], stamps[-1] + 1, step))
    assert stamps[0] == _ts(body["start"]) and stamps[-1] == _ts(body["end"])
    assert NOW - 30 - step < stamps[-1] <= NOW - 30
    # The window: the first mark at or after (end - hours).
    assert stamps[-1] - hours * 3600 <= stamps[0] < stamps[-1] - hours * 3600 + step
    assert len(stamps) == hours * 3600 // step + 1
    rng = fake.one("/api/v1/query_range")
    assert (int(rng["start"]), int(rng["end"])) == (stamps[0], stamps[-1])


def test_largest_request_is_served(vm):
    vm()
    body = _get("/v1/metrics/calls-active?hours=168&step_seconds=60").json()
    assert len(body["points"]) == 168 * 60 + 1


def test_unversioned_mount_answers_the_same(vm):
    vm(FakeVM(nodes={"east-fs": _marks(NOON - 3600, NOON, 300, 2)}))
    a = _get("/v1/metrics/calls-active?hours=1").json()
    b = _get("/metrics/calls-active?hours=1").json()
    assert a == b and a["points"][0]["calls"] == 2


# ---------------------------------------------------------------------------
# No data is null, never 0
# ---------------------------------------------------------------------------

def test_a_mark_no_node_reported_is_null_and_a_real_zero_stays_zero(vm):
    start = NOON - 1800
    east = _marks(start, NOON, 300, 4)
    west = _marks(start, NOON, 300, 3)
    del east[NOON - 900], west[NOON - 900]        # nobody reported at 11:45
    del west[NOON - 600]                          # only west missing at 11:50
    east[NOON - 300] = west[NOON - 300] = 0       # a genuinely idle fleet at 11:55
    vm(FakeVM(nodes={"east-fs": east, "west-fs": west}))
    body = _get("/v1/metrics/calls-active?hours=1&step_seconds=300").json()
    by_t = {p["t"]: p for p in body["points"]}
    assert by_t["2026-11-25T11:45:00Z"] == {
        "t": "2026-11-25T11:45:00Z", "calls": None, "nodes": 0}
    assert by_t["2026-11-25T11:50:00Z"]["calls"] == 4 and by_t["2026-11-25T11:50:00Z"]["nodes"] == 1
    assert by_t["2026-11-25T11:55:00Z"]["calls"] == 0 and by_t["2026-11-25T11:55:00Z"]["nodes"] == 2
    assert by_t["2026-11-25T12:00:00Z"]["calls"] == 7
    # Marks before the data starts are null too, not 0.
    assert by_t["2026-11-25T11:00:00Z"]["calls"] is None
    assert body["current"] is None                # no node has a fresh reading


def test_a_store_with_no_series_is_all_null(vm):
    vm()
    body = _get("/v1/metrics/calls-active?hours=2").json()
    assert len(body["points"]) == 25
    assert all(p["calls"] is None and p["nodes"] == 0 for p in body["points"])
    assert body["current"] is None


def test_current_is_the_sum_of_the_nodes_reporting_now(vm):
    vm(FakeVM(instant={"east-fs": 0}))
    assert _get("/v1/metrics/calls-active?hours=1").json()["current"] == {
        "t": "2026-11-25T12:03:10Z", "calls": 0, "nodes": 1}


# ---------------------------------------------------------------------------
# Parameters
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("qs", [
    "hours=0", "hours=169", "hours=-1", "hours=abc", "hours=1.5", "hours=", "hours=1e2",
    "step_seconds=59", "step_seconds=3601", "step_seconds=0", "step_seconds=abc",
    "step_seconds=300.5", "step_seconds=", "hours=24&step_seconds=5m",
])
def test_out_of_range_or_non_integer_parameters_are_422(vm, qs):
    fake = vm()
    r = _get("/v1/metrics/calls-active?" + qs)
    assert r.status_code == 422, r.text
    assert "detail" in r.json()
    assert fake.requests == []


@pytest.mark.parametrize("qs", ["hours=1&step_seconds=60", "hours=168&step_seconds=3600"])
def test_limits_are_inclusive(vm, qs):
    vm()
    assert _get("/v1/metrics/calls-active?" + qs).status_code == 200


def test_nothing_the_caller_sends_reaches_the_query(vm):
    fake = vm()
    r = _get("/v1/metrics/calls-active?hours=1&query=up&start=1&end=2&step=1&time=3"
             "&match[]=x&extra_label=a=b")
    assert r.status_code == 200
    assert dict(fake.one("/api/v1/query_range")) == {
        "query": m.CALLS_BY_NODE_QUERY, "start": str(NOON - 3600), "end": str(NOON),
        "step": "300"}
    assert dict(fake.one("/api/v1/query")) == {"query": m.CALLS_BY_NODE_QUERY,
                                               "time": str(NOW)}


def test_base_url_comes_from_the_environment(vm, monkeypatch):
    fake = vm()
    monkeypatch.setenv("VICTORIAMETRICS_URL", " http://vm.internal:9999/ ")
    assert _get("/v1/metrics/calls-active?hours=1").status_code == 200
    assert {r.url.host for r in fake.requests} == {"vm.internal"}
    assert str(fake.requests[0].url).startswith("http://vm.internal:9999/api/v1/")
    monkeypatch.setenv("VICTORIAMETRICS_URL", "")
    assert m._base_url() == "http://victoriametrics:8428"


# ---------------------------------------------------------------------------
# Admin only
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("headers", [TENANT, READONLY, SUPPORT],
                         ids=["tenant", "readonly", "support"])
@pytest.mark.parametrize("path", ["/v1/metrics/calls-active", "/metrics/calls-active"])
def test_anyone_but_an_admin_is_forbidden(vm, headers, path):
    fake = vm(FakeVM(nodes={"east-fs": _marks(NOON - 86400, NOON, 300, 5)}))
    r = _get(path, headers=headers)
    assert r.status_code == 403
    assert r.json() == {"detail": "Admin access required"}
    assert fake.requests == []


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer not-a-token"}])
def test_no_valid_session_is_401(vm, headers):
    fake = vm()
    r = _get("/v1/metrics/calls-active", headers=headers)
    assert r.status_code == 401 and r.json() == {"detail": "Not authenticated"}
    assert fake.requests == []


# ---------------------------------------------------------------------------
# VictoriaMetrics down, slow, or answering garbage -> 503, never 500 / empty
# ---------------------------------------------------------------------------

def _raise(exc_type):
    def fail(request):
        raise exc_type("boom", request=request)
    return fail


def _assert_unavailable(r):
    assert r.status_code == 503, r.text
    body = r.json()
    assert set(body) == {"detail", "code"}
    assert body["code"] == "metrics_unavailable"
    assert body["detail"].startswith("Call metrics are unavailable: ")
    assert "victoriametrics" not in body["detail"]      # no internal address


@pytest.mark.parametrize("exc_type", [
    httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout, httpx.PoolTimeout,
    httpx.ReadError, httpx.RemoteProtocolError,
])
def test_unreachable_or_timed_out_store_is_503(vm, exc_type):
    vm(FakeVM(fail=_raise(exc_type)))
    _assert_unavailable(_get("/v1/metrics/calls-active"))


def test_a_slow_store_is_cut_off_at_the_overall_timeout(vm, monkeypatch):
    async def slow(request):
        await asyncio.sleep(30)
        return _ok("matrix", [])
    vm(FakeVM(fail=slow))
    monkeypatch.setattr(m, "UPSTREAM_TIMEOUT_S", 0.05)
    started = _LOOP.time()
    r = _get("/v1/metrics/calls-active")
    assert _LOOP.time() - started < 5
    _assert_unavailable(r)
    assert "in time" in r.json()["detail"]


def test_the_timeout_is_about_five_seconds():
    assert m.UPSTREAM_TIMEOUT_S == 5.0


_GOOD_VALUES = [[NOON, "3"]]
_GARBAGE_RANGE = {
    "http_500": httpx.Response(500, text="internal error"),
    "http_422": httpx.Response(422, json={"status": "error", "error": "bad query"}),
    "not_json": httpx.Response(200, text="<html>bad gateway</html>"),
    "json_list": httpx.Response(200, json=[1, 2, 3]),
    "status_error": httpx.Response(200, json={"status": "error", "errorType": "x"}),
    "no_data": httpx.Response(200, json={"status": "success"}),
    "wrong_type": _ok("vector", []),
    "result_not_list": _ok("matrix", {"a": 1}),
    "series_not_object": _ok("matrix", ["x"]),
    "no_values": _ok("matrix", [{"metric": {}}]),
    "sample_not_pair": _ok("matrix", [{"metric": {}, "values": [[NOON]]}]),
    "value_not_string": _ok("matrix", [{"metric": {}, "values": [[NOON, 3]]}]),
    "value_not_number": _ok("matrix", [{"metric": {}, "values": [[NOON, "many"]]}]),
    "value_nan": _ok("matrix", [{"metric": {}, "values": [[NOON, "NaN"]]}]),
    "value_inf": _ok("matrix", [{"metric": {}, "values": [[NOON, "+Inf"]]}]),
    "value_negative": _ok("matrix", [{"metric": {}, "values": [[NOON, "-1"]]}]),
    "timestamp_text": _ok("matrix", [{"metric": {}, "values": [["noon", "3"]]}]),
    "off_grid": _ok("matrix", [{"metric": {}, "values": [[NOON - 7, "3"]]}]),
    "fractional_ts": _ok("matrix", [{"metric": {}, "values": [[NOON - 0.5, "3"]]}]),
    "after_end": _ok("matrix", [{"metric": {}, "values": [[NOON + 300, "3"]]}]),
    "before_start": _ok("matrix", [{"metric": {}, "values": [[NOON - 86400 - 300, "3"]]}]),
}


@pytest.mark.parametrize("name", sorted(_GARBAGE_RANGE))
def test_a_garbage_series_answer_is_503(vm, name):
    vm(FakeVM(range_body=_GARBAGE_RANGE[name], instant={"east-fs": 1}))
    _assert_unavailable(_get("/v1/metrics/calls-active"))


_GARBAGE_INSTANT = {
    "http_503": httpx.Response(503, text="unavailable"),
    "not_json": httpx.Response(200, text="nope"),
    "wrong_type": _ok("matrix", []),
    "no_value": _ok("vector", [{"metric": {}}]),
    "value_nan": _ok("vector", [{"metric": {}, "value": [NOW, "NaN"]}]),
}


@pytest.mark.parametrize("name", sorted(_GARBAGE_INSTANT))
def test_a_garbage_latest_value_answer_is_503(vm, name):
    vm(FakeVM(nodes={"east-fs": {NOON: 3}}, instant_body=_GARBAGE_INSTANT[name]))
    _assert_unavailable(_get("/v1/metrics/calls-active"))


def test_a_good_answer_after_a_failure_is_served(vm):
    fake = vm(FakeVM(fail=_raise(httpx.ConnectError)))
    _assert_unavailable(_get("/v1/metrics/calls-active?hours=1"))
    fake.fail = None
    fake.nodes = {"east-fs": dict(_GOOD_VALUES)}
    body = _get("/v1/metrics/calls-active?hours=1").json()
    assert body["points"][-1]["calls"] == 3


# ---------------------------------------------------------------------------
# The real app mounts it (subprocess: a fresh import of main)
# ---------------------------------------------------------------------------

def test_main_mounts_the_endpoint():
    env = dict(os.environ)
    env.setdefault("JWT_SECRET_KEY", "test-secret")
    out = subprocess.run(
        [sys.executable, "-c",
         "import json, main; print(json.dumps(sorted(main.app.openapi()['paths'])))"],
        cwd=str(API_SRC), env=env, capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    paths = set(json.loads(out.stdout.strip().splitlines()[-1]))
    assert {"/v1/metrics/calls-active", "/metrics/calls-active"} <= paths
