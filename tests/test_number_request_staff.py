"""POST /v1/numbers/{did}/request is customer-only.

Staff (admin/support) assign numbers via /{did}/assign in the inventory tool;
an admin request used to reserve the DID with customer_id NULL. Hermetic: the
staff rejection fires before any DB access (db is stubbed to record calls).
"""
import asyncio
import os
import sys
from pathlib import Path

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
os.environ.setdefault("ENV", "development")

httpx = pytest.importorskip("httpx", reason="httpx required")

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "docker" / "api" / "src"))

_LOOP = asyncio.new_event_loop()


def _client(router, role, customer_id):
    from fastapi import FastAPI, Request

    app = FastAPI()

    @app.middleware("http")
    async def _inject_user(request: Request, call_next):
        request.state.user = {"sub": "1", "role": role, "customer_id": customer_id}
        return await call_next(request)

    app.include_router(router, prefix="/v1/numbers")
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


@pytest.fixture
def ni(monkeypatch):
    from routers import number_inventory as ni

    touched: list = []

    async def _record(*a, **k):
        touched.append(a)
        return None

    monkeypatch.setattr(ni.db, "fetch_one", _record)
    monkeypatch.setattr(ni.db, "execute", _record)
    ni._touched = touched
    return ni


@pytest.mark.parametrize("role,customer_id", [("admin", None), ("admin", 7), ("support", None)])
def test_staff_request_403_before_db(ni, role, customer_id):
    async def go():
        async with _client(ni.router, role, customer_id) as c:
            return await c.post("/v1/numbers/+16175550100/request", json={"product_type": "rcf"})

    r = _LOOP.run_until_complete(go())
    assert r.status_code == 403, r.text
    assert "assign" in r.json()["detail"]
    assert ni._touched == []


def test_customer_request_reaches_inventory_lookup(ni):
    async def go():
        async with _client(ni.router, "user", 3) as c:
            return await c.post("/v1/numbers/+16175550100/request", json={"product_type": "rcf"})

    r = _LOOP.run_until_complete(go())
    # fetch_one stubbed to None -> "not found in inventory": the customer path is unchanged.
    assert r.status_code == 404, r.text
    assert len(ni._touched) == 1


def test_customerless_user_still_400(ni):
    async def go():
        async with _client(ni.router, "user", None) as c:
            return await c.post("/v1/numbers/+16175550100/request", json={"product_type": "rcf"})

    r = _LOOP.run_until_complete(go())
    assert r.status_code == 400, r.text
    assert ni._touched == []
