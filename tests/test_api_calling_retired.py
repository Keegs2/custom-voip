"""API Calling RETIRED (2026-09) — flag-OFF behavior + RCF/trunk non-regression.

``API_CALLING_ENABLED`` (docker/api/src/config.py) is ON only when exactly
"true" (trimmed, case-insensitive); default OFF. With it OFF:

  * main.py does not mount /v1/calls or /calls (404);
  * GET /tiers/api is hidden (404) and tier validators reject tier_type 'api';
  * POST /customers rejects account_type 'api' (422) — 'hybrid' still allowed;
  * number assign / request reject product_type 'api' (422);
  * the billing estimate emits no "API Calling" line (hybrid = RCF + Trunking);
  * /customers/me reports counts.api_dids = 0 (key kept);
  * onboarding intake rejects the 'api' product (422).

Hermetic: no PostgreSQL — validation-level rejections fire before any DB
access, and the few handlers that would read are stubbed. The end-to-end
RCF/trunk suites (test_support_role_authz, test_tenant_redaction,
test_did_intake, test_carrier_trunks) run with the flag at its default (OFF)
and are the full-stack proof those products are unaffected.
"""
import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
os.environ.setdefault("ENV", "development")

httpx = pytest.importorskip("httpx", reason="httpx required")

REPO = Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
sys.path.insert(0, str(API_SRC))

import config  # noqa: E402
from pydantic import ValidationError  # noqa: E402

_LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


@pytest.fixture(autouse=True)
def _flag_default_off(monkeypatch):
    """Every test starts from the production default: flag unset (OFF)."""
    monkeypatch.delenv("API_CALLING_ENABLED", raising=False)


def _client(*routers_and_prefixes, role="admin", customer_id=None):
    from fastapi import FastAPI, Request

    app = FastAPI()

    @app.middleware("http")
    async def _inject_user(request: Request, call_next):
        request.state.user = {"sub": "1", "role": role, "customer_id": customer_id}
        return await call_next(request)

    for router, prefix in routers_and_prefixes:
        app.include_router(router, prefix=prefix)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                             base_url="http://test")


# ---------------------------------------------------------------------------
# Flag contract
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("raw", ["true", "TRUE", "True", " true ", "\ttrue\n"])
def test_flag_on_values(monkeypatch, raw):
    monkeypatch.setenv("API_CALLING_ENABLED", raw)
    assert config.api_calling_enabled() is True


@pytest.mark.parametrize("raw", ["", "false", "1", "yes", "on", "enabled", "truee", "t"])
def test_flag_off_values(monkeypatch, raw):
    monkeypatch.setenv("API_CALLING_ENABLED", raw)
    assert config.api_calling_enabled() is False


def test_flag_default_off():
    assert "API_CALLING_ENABLED" not in os.environ
    assert config.api_calling_enabled() is False


# ---------------------------------------------------------------------------
# main.py mounting — checked in a subprocess so the import-time decision is
# made fresh under each env (no sys.modules pollution of `main`).
# ---------------------------------------------------------------------------
# OpenAPI paths = every mounted route (FastAPI >=0.14x nests included routers
# in app.routes, so walking app.routes no longer yields flat paths).
_ROUTES_SNIPPET = (
    "import json, main; "
    "print(json.dumps(sorted(main.app.openapi()['paths'])))"
)


def _main_routes(flag):
    env = dict(os.environ)
    env.setdefault("JWT_SECRET_KEY", "test-secret")
    env.pop("API_CALLING_ENABLED", None)
    if flag is not None:
        env["API_CALLING_ENABLED"] = flag
    out = subprocess.run([sys.executable, "-c", _ROUTES_SNIPPET], cwd=str(API_SRC),
                         env=env, capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    return set(json.loads(out.stdout.strip().splitlines()[-1]))


def test_main_does_not_mount_calls_when_off():
    paths = _main_routes(None)
    assert not any(p.startswith("/v1/calls") or p.startswith("/calls") for p in paths)
    # Payments demo is gone entirely; read-only billing stays.
    assert not any("/payments" in p for p in paths)
    assert "/v1/billing/ledger" in paths and "/v1/billing/balance" in paths
    # RCF / trunk / tiers / numbers surfaces still mounted.
    for p in ("/v1/rcf", "/v1/trunks", "/v1/numbers/{did}/assign", "/v1/tiers/trunk",
              "/v1/customers/me/billing", "/v1/cdrs/ingest"):
        assert p in paths, p
    assert _main_routes("false") == paths
    assert _main_routes("1") == paths


def test_main_mounts_calls_when_on():
    paths = _main_routes("true")
    assert {"/v1/calls", "/v1/calls/{call_id}", "/v1/calls/{call_id}/update",
            "/calls", "/calls/{call_id}"} <= paths


def test_calls_404_through_main_app_when_off(monkeypatch):
    """The real main.app (flag off at import) serves 404 for /v1/calls."""
    env = dict(os.environ)
    env.pop("API_CALLING_ENABLED", None)
    snippet = (
        "import asyncio, httpx, main\n"
        "from auth.security import create_access_token\n"
        "tok = create_access_token({'sub':'1','email':'a@x','role':'admin','customer_id':None})\n"
        "async def go():\n"
        "    t = httpx.ASGITransport(app=main.app)\n"
        "    async with httpx.AsyncClient(transport=t, base_url='http://t') as c:\n"
        "        h = {'Authorization': 'Bearer ' + tok}\n"
        "        a = await c.post('/v1/calls', json={'from_did':'+16175550100','to':'+16175551234'}, headers=h)\n"
        "        b = await c.post('/calls', json={}, headers=h)\n"
        "        print(a.status_code, b.status_code)\n"
        "asyncio.run(go())\n"
    )
    out = subprocess.run([sys.executable, "-c", snippet], cwd=str(API_SRC), env=env,
                         capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip().splitlines()[-1] == "404 404"


# ---------------------------------------------------------------------------
# Tiers
# ---------------------------------------------------------------------------
def test_tiers_api_hidden_when_off(monkeypatch):
    from routers import tiers

    reads = []

    async def _fetch_all(q, *a):
        reads.append(q)
        return []

    monkeypatch.setattr(tiers.db, "fetch_all", _fetch_all)

    async def go():
        async with _client((tiers.router, "/v1/tiers")) as c:
            r = await c.get("/v1/tiers/api")
            assert r.status_code == 404, r.text
            assert r.json() == {"detail": "Not Found"}
            assert reads == []                      # never queried
            # Trunk tiers unaffected.
            r = await c.get("/v1/tiers/trunk")
            assert r.status_code == 200 and r.json() == []
            # Flag on → the kept endpoint answers again.
            monkeypatch.setenv("API_CALLING_ENABLED", "true")
            r = await c.get("/v1/tiers/api")
            assert r.status_code == 200 and r.json() == []

    _run(go())


def test_tier_validators_reject_api_when_off(monkeypatch):
    from routers.tiers import TierCreate, TierUpdate

    with pytest.raises(ValidationError, match="API Calling is retired"):
        TierCreate(name="x", tier_type="api", cps_limit=5)
    with pytest.raises(ValidationError, match="API Calling is retired"):
        TierCreate(name="x", tier_type="API", cps_limit=5)
    with pytest.raises(ValidationError, match="API Calling is retired"):
        TierUpdate(tier_type="api")
    # Non-api tier types unaffected; TierUpdate without tier_type fine.
    assert TierCreate(name="x", tier_type="trunk", cps_limit=5).tier_type == "trunk"
    assert TierCreate(name="x", tier_type="all", cps_limit=5).tier_type == "all"
    assert TierUpdate(cps_limit=9).tier_type is None
    monkeypatch.setenv("API_CALLING_ENABLED", "true")
    assert TierCreate(name="x", tier_type="api", cps_limit=5).tier_type == "api"


def test_tier_create_api_422_over_http():
    from routers import tiers

    async def go():
        async with _client((tiers.router, "/v1/tiers")) as c:
            r = await c.post("/v1/tiers", json={"name": "api_x", "tier_type": "api",
                                                "cps_limit": 5})
            assert r.status_code == 422, r.text
            assert "API Calling is retired" in r.text

    _run(go())


# ---------------------------------------------------------------------------
# Customers
# ---------------------------------------------------------------------------
def test_create_customer_api_422_hybrid_ok(monkeypatch):
    from routers import customers

    inserted = []

    async def _fetch_one(q, *a):
        inserted.append(a)
        return {"id": 7, "name": a[0], "account_type": a[1], "balance": 0,
                "status": "active", "traffic_grade": "standard",
                "ucaas_enabled": False, "created_at": None}

    monkeypatch.setattr(customers.db, "fetch_one", _fetch_one)

    async def go():
        async with _client((customers.router, "/v1/customers")) as c:
            r = await c.post("/v1/customers", json={"name": "Bot", "account_type": "api"})
            assert r.status_code == 422, r.text
            assert "API Calling is retired" in r.text
            assert inserted == []
            for at in ("rcf", "trunk", "hybrid"):
                r = await c.post("/v1/customers", json={"name": at, "account_type": at})
                assert r.status_code == 200, r.text
                assert r.json()["account_type"] == at
            assert [a[1] for a in inserted] == ["rcf", "trunk", "hybrid"]

    _run(go())


def test_create_customer_api_allowed_when_on(monkeypatch):
    from routers.customers import CustomerCreate
    with pytest.raises(ValidationError, match="API Calling is retired"):
        CustomerCreate(name="x", account_type="api")
    monkeypatch.setenv("API_CALLING_ENABLED", "true")
    assert CustomerCreate(name="x", account_type="api").account_type == "api"


class _FakeConn:
    """asyncpg-connection stand-in for compute_billing_estimate."""

    def __init__(self, account_type, rcf_lines=2):
        self.account_type = account_type
        self.rcf_lines = rcf_lines
        self.queries = []

    async def fetchrow(self, q, *a):
        self.queries.append(q)
        if "SELECT account_type FROM customers" in q:
            return {"account_type": self.account_type}
        if "FROM rcf_numbers" in q:
            return {"n": self.rcf_lines}
        if "c.trunk_tier_id" in q:
            return {"name": "trunk_standard", "monthly_fee": 99, "call_paths": 10}
        if "call_path_packages" in q:
            return {"fee": 25, "paths": 5}
        if "c.api_tier_id" in q:
            return {"name": "api_basic", "monthly_fee": 49}
        raise AssertionError(f"unexpected query: {q}")


def test_hybrid_billing_estimate_has_no_api_line_when_off():
    from routers.customers import compute_billing_estimate

    conn = _FakeConn("hybrid")
    est = _run(compute_billing_estimate(conn, 1))
    products = [li["product"] for li in est["line_items"]]
    assert products == ["rcf", "trunk"]
    assert not any("API" in li["label"] for li in est["line_items"])
    assert est["total_monthly_estimate"] == 10.0 + 99.0 + 25.0
    assert not any("api_tier_id" in q for q in conn.queries)  # not even read


def test_api_account_billing_estimate_empty_when_off():
    from routers.customers import compute_billing_estimate

    est = _run(compute_billing_estimate(_FakeConn("api", rcf_lines=0), 1))
    assert est["line_items"] == [] and est["total_monthly_estimate"] == 0.0


def test_hybrid_billing_estimate_api_line_when_on(monkeypatch):
    from routers.customers import compute_billing_estimate

    monkeypatch.setenv("API_CALLING_ENABLED", "true")
    est = _run(compute_billing_estimate(_FakeConn("hybrid"), 1))
    assert [li["product"] for li in est["line_items"]] == ["rcf", "trunk", "api"]
    assert est["total_monthly_estimate"] == 10.0 + 99.0 + 25.0 + 49.0


@pytest.mark.parametrize("acct,expected", [("rcf", ["rcf"]), ("trunk", ["rcf", "trunk"])])
def test_rcf_trunk_billing_estimate_unchanged(acct, expected):
    from routers.customers import compute_billing_estimate

    est = _run(compute_billing_estimate(_FakeConn(acct), 1))
    assert [li["product"] for li in est["line_items"]] == expected


def test_me_counts_api_dids_zero_when_off(monkeypatch):
    from routers import customers

    queries = []

    async def _fetch_one(q, *a):
        queries.append(q)
        if "FROM customers" in q:
            return {"id": 3, "name": "Granite Telephony", "account_type": "hybrid",
                    "status": "active", "traffic_grade": "standard", "daily_limit": 500,
                    "cpm_limit": 60, "ucaas_enabled": False, "created_at": None}
        if "FROM rcf_numbers" in q:
            return {"n": 4}
        if "FROM api_dids" in q:
            return {"n": 9}
        if "FROM sip_trunks" in q:
            return {"n": 2}
        raise AssertionError(q)

    monkeypatch.setattr(customers.db, "fetch_one", _fetch_one)

    async def go():
        async with _client((customers.router, "/v1/customers"),
                           role="user", customer_id=3) as c:
            r = await c.get("/v1/customers/me")
            assert r.status_code == 200, r.text
            assert r.json()["counts"] == {"rcf": 4, "api_dids": 0, "trunks": 2}
            assert not any("api_dids" in q for q in queries)
            monkeypatch.setenv("API_CALLING_ENABLED", "true")
            r = await c.get("/v1/customers/me")
            assert r.json()["counts"] == {"rcf": 4, "api_dids": 9, "trunks": 2}

    _run(go())


# ---------------------------------------------------------------------------
# Number inventory
# ---------------------------------------------------------------------------
def test_inventory_assign_api_422(monkeypatch):
    from routers import number_inventory as ni

    touched = []

    async def _no_db(*a, **k):
        touched.append(a)
        return None

    monkeypatch.setattr(ni.db, "fetch_one", _no_db)

    async def go():
        async with _client((ni.router, "/v1/numbers")) as c:
            r = await c.post("/v1/numbers/+16175550100/assign",
                             json={"customer_id": 1, "product_type": "api"})
            assert r.status_code == 422, r.text
            assert "API Calling is retired" in r.text
            assert touched == []
            # RCF/trunk pass validation and reach the handler (customer lookup
            # stubbed to "not found" → 404, i.e. NOT a validation rejection).
            for pt, extra in (("trunk", {}), ("rcf", {"forward_to": "+17744045256"})):
                r = await c.post("/v1/numbers/+16175550100/assign",
                                 json={"customer_id": 1, "product_type": pt, **extra})
                assert r.status_code == 404, (pt, r.text)
        async with _client((ni.router, "/v1/numbers"), role="user", customer_id=1) as c:
            r = await c.post("/v1/numbers/+16175550100/request", json={"product_type": "api"})
            assert r.status_code == 422, r.text
            assert "API Calling is retired" in r.text

    _run(go())


def test_inventory_models_accept_api_when_on(monkeypatch):
    from routers.number_inventory import AssignRequest, NumberRequest

    with pytest.raises(ValidationError, match="API Calling is retired"):
        AssignRequest(customer_id=1, product_type="api")
    with pytest.raises(ValidationError, match="API Calling is retired"):
        NumberRequest(product_type="api")
    assert AssignRequest(customer_id=1, product_type="ucaas").product_type == "ucaas"
    monkeypatch.setenv("API_CALLING_ENABLED", "true")
    assert AssignRequest(customer_id=1, product_type="api").product_type == "api"
    assert NumberRequest(product_type="api").product_type == "api"


# ---------------------------------------------------------------------------
# Onboarding intake
# ---------------------------------------------------------------------------
_API_BLOCK = {"use_case": "outbound alerts", "needs_numbers": True}
_RCF_BLOCK = {"did_count": "1–10", "porting": "No — need new numbers",
              "forwarding_setup": "All numbers forward to one destination"}


def test_onboarding_rejects_api_product_when_off(monkeypatch):
    from routers.onboarding import ProductsPayload

    for payload in (
        {"selected": ["api"], "api": _API_BLOCK},
        {"selected": ["rcf", "api"], "rcf": _RCF_BLOCK, "api": _API_BLOCK},
        {"selected": ["rcf"], "rcf": _RCF_BLOCK, "api": _API_BLOCK},
    ):
        with pytest.raises(ValidationError, match="API Calling is retired"):
            ProductsPayload.model_validate(payload)
    ok = ProductsPayload.model_validate({"selected": ["rcf"], "rcf": _RCF_BLOCK})
    assert ok.selected == ["rcf"]
    monkeypatch.setenv("API_CALLING_ENABLED", "true")
    both = ProductsPayload.model_validate(
        {"selected": ["rcf", "api"], "rcf": _RCF_BLOCK, "api": _API_BLOCK})
    assert both.selected == ["rcf", "api"]
