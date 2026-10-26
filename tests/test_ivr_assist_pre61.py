"""The Flow assistant on a database WITHOUT migration 61 (deploy-order guard).

The API build may reach the services VM before 61 is applied. Then nothing
may error: the assistant reads as unavailable, the admin endpoints keep their
pre-assistant shapes (no ``ivr_assist_enabled`` key, so TED hides its switch),
an attempt to opt a customer in is a 503 that names the migration, and a POST
to the assistant is the normal 403.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ivr_assist_fake_ted as fake  # noqa: E402
from test_ivr_api import IvrHarness  # noqa: E402
from voicemail_api_harness import CUST_A  # noqa: E402

PORT = 55524            # IVR range 55520-55529


class Pre61Harness(IvrHarness):
    IVR_MIGRATIONS = ("59_ivr.sql", "60_cdr_ivr.sql")

    async def _setup(self) -> None:
        await super()._setup()
        conn = await self.owner()
        try:
            await conn.execute(f"UPDATE customers SET ivr_enabled = true WHERE id = {CUST_A}")
        finally:
            await conn.close()

    @staticmethod
    def build_app():
        app = IvrHarness.build_app()
        from routers import ivr_assist
        app.include_router(ivr_assist.router, prefix="/v1/ivr")
        return app


@pytest.fixture(scope="module")
def pre():
    harness = Pre61Harness(PORT).start()
    try:
        yield harness
    finally:
        harness.stop()


def api(h, method, path, who="user_a", **kw):
    return h.run(h.client.request(method, path, headers=h.auth(who), **kw))


def test_pre_61_schema_reports_the_assistant_unavailable(pre, monkeypatch):
    from services.ivr.assist import ted_client
    fake.configure_env(monkeypatch)                   # the platform side is fully on
    ted = fake.FakeTed()
    monkeypatch.setattr(ted_client, "TRANSPORT", ted.transport())
    r = api(pre, "GET", "/v1/ivr/summary")
    assert r.status_code == 200 and r.json()["assist"] == {"available": False}
    body = api(pre, "GET", f"/v1/ivr/admin/customers/{CUST_A}", "admin").json()
    assert "ivr_assist_enabled" not in body and body["ivr_enabled"] is True
    r = api(pre, "PUT", f"/v1/ivr/admin/customers/{CUST_A}/entitlement", "admin",
            json={"enabled": True})
    assert r.status_code == 200 and r.json() == {"ivr_enabled": True}
    r = api(pre, "PUT", f"/v1/ivr/admin/customers/{CUST_A}/entitlement", "admin",
            json={"enabled": False, "assist_enabled": True})
    assert r.status_code == 503 and "migration 61" in r.json()["detail"]
    assert pre.run(pre.fetchval(f"SELECT ivr_enabled FROM customers WHERE id = {CUST_A}")) \
        is True                                       # the failed PUT changed nothing
    r = api(pre, "POST", "/v1/ivr/flows", json={"name": "Main"})
    assert r.status_code == 201
    r = api(pre, "POST", f"/v1/ivr/flows/{r.json()['id']}/assist", json={"message": "hi"})
    assert r.status_code == 403 and r.json()["detail"] == "ivr_assist_not_enabled"
    assert ted.requests == []
