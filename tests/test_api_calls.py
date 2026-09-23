"""POST /v1/calls — the KEPT (retired, flag-gated) API Calling originate path.

API Calling was RETIRED 2026-09: the code is kept but switched off behind
``API_CALLING_ENABLED`` (config.api_calling_enabled). These tests run the kept
code with the flag ON (``monkeypatch.setenv`` per test — the flag is read live)
so it stays tested, plus one case proving the router's own dependency 404s
when the flag is OFF even if something mounts it.

Replaces tests/test_x402_calls.py: the x402 pay-per-call path, the ledger-posted
per-call fee and PAYMENTS_DEMO_FAKE_ORIGINATE were payments-DEMO code (the x402
"facilitator" was a simulation that accepted any signature) and were removed
with the demo. What remains — and is asserted here — is the exact legacy flow:
prepaid originate + raw ``customers.balance`` decrement, and the STIR/SHAKEN
attestation-A from_did ownership gate.

Same ephemeral-PG harness as the other API suites (skips without local PG
binaries; set TEST_PG_BIN to point at them).

Run:  JWT_SECRET_KEY=x python3 -m pytest tests/test_api_calls.py -q
"""
import asyncio
import os
import shutil
import subprocess
import sys
import tempfile
from decimal import Decimal
from pathlib import Path

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
os.environ.setdefault("ENV", "development")

asyncpg = pytest.importorskip("asyncpg", reason="asyncpg required for API call tests")
httpx = pytest.importorskip("httpx", reason="httpx required for API call tests")

REPO = Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"

sys.path.insert(0, str(API_SRC))


def _find_pg_bin():
    override = os.getenv("TEST_PG_BIN")
    candidates = []
    if override:
        candidates.append(override)
    pgctl = shutil.which("pg_ctl")
    if pgctl:
        candidates.append(str(Path(pgctl).parent))
    candidates += [
        "/opt/homebrew/opt/postgresql@16/bin", "/opt/homebrew/opt/postgresql@15/bin",
        "/opt/homebrew/opt/postgresql@14/bin", "/usr/local/opt/postgresql@16/bin",
        "/usr/local/opt/postgresql@14/bin", "/usr/lib/postgresql/16/bin",
        "/usr/lib/postgresql/15/bin",
    ]
    for d in candidates:
        if d and Path(d, "initdb").exists() and Path(d, "pg_ctl").exists():
            return d
    return None


PG_BIN = _find_pg_bin()

# Minimal production-shaped schema: everything POST /v1/calls touches —
# customers + cps_tiers (tier fee / CPS), api_dids (from-DID auth), active_calls.
_BASE_SCHEMA = """
CREATE ROLE api LOGIN PASSWORD 'api_secret';

CREATE TABLE customers (
  id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL,
  account_type VARCHAR(20) NOT NULL DEFAULT 'api',
  balance DECIMAL(12,4) DEFAULT 0, credit_limit DECIMAL(12,4) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active', traffic_grade VARCHAR(10) DEFAULT 'standard',
  daily_limit DECIMAL(12,4) DEFAULT 500, cpm_limit INT DEFAULT 60,
  updated_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW());

CREATE TABLE cps_tiers (
  id SERIAL PRIMARY KEY, name VARCHAR(50) NOT NULL UNIQUE,
  tier_type VARCHAR(20) NOT NULL CHECK (tier_type IN ('trunk', 'api')),
  cps_limit INTEGER NOT NULL CHECK (cps_limit > 0),
  monthly_fee DECIMAL(10,2) NOT NULL DEFAULT 0,
  per_call_fee DECIMAL(10,4) NOT NULL DEFAULT 0,
  is_active BOOLEAN DEFAULT true);

ALTER TABLE customers ADD COLUMN api_tier_id INTEGER REFERENCES cps_tiers(id);

CREATE TABLE api_dids (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  did VARCHAR(20) NOT NULL, voice_url VARCHAR(512) NOT NULL,
  enabled BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT api_did_unique UNIQUE (did));

CREATE TABLE active_calls (
  uuid UUID PRIMARY KEY, customer_id INT NOT NULL,
  product_type VARCHAR(10) NOT NULL, trunk_id INT,
  direction VARCHAR(10) NOT NULL, caller_id VARCHAR(30), destination VARCHAR(30),
  start_time TIMESTAMPTZ DEFAULT NOW(), answer_time TIMESTAMPTZ,
  state VARCHAR(20) DEFAULT 'ringing');

GRANT ALL ON customers, cps_tiers, api_dids, active_calls TO api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO api;
"""


class _EphemeralPG:
    def __init__(self, pg_bin):
        self.pg_bin = pg_bin
        self.tmp = tempfile.mkdtemp(prefix="revup_apicalls_pg.")
        self.data = os.path.join(self.tmp, "data")
        self.sock = os.path.join(self.tmp, "sock")
        os.makedirs(self.sock, exist_ok=True)
        self.port = 55434  # the retired x402 suite's slot

    def start(self):
        subprocess.run(
            [f"{self.pg_bin}/initdb", "-D", self.data, "-U", "postgres",
             "--auth=trust", "-E", "UTF8"], check=True, capture_output=True)
        subprocess.run(
            [f"{self.pg_bin}/pg_ctl", "-D", self.data,
             "-o", f"-p {self.port} -k {self.sock} -c listen_addresses=''",
             "-w", "-l", os.path.join(self.tmp, "log"), "start"],
            check=True, capture_output=True)

    def stop(self):
        subprocess.run([f"{self.pg_bin}/pg_ctl", "-D", self.data, "-w", "stop"],
                       capture_output=True)
        shutil.rmtree(self.tmp, ignore_errors=True)


_LOOP = asyncio.new_event_loop()

FROM_DID = "+16175550100"
TO_DEST = "+16175551234"
TIER_FEE = Decimal("0.0100")    # api_basic per_call_fee
START_BALANCE = Decimal("100.0000")


@pytest.fixture(scope="module")
def calls_db():
    """Boot PG, apply the schema, seed one api customer + tier + api_did."""
    if PG_BIN is None:
        pytest.skip("no local PostgreSQL binaries; set TEST_PG_BIN to run API call tests")
    pg = _EphemeralPG(PG_BIN)
    try:
        pg.start()
    except Exception as e:  # noqa: BLE001
        pg.stop()
        pytest.skip(f"could not start throwaway PostgreSQL: {e}")

    from db import database as db  # noqa: E402

    state = {"db": db}

    async def _setup():
        owner = await asyncpg.create_pool(
            host=pg.sock, port=pg.port, user="postgres", database="postgres",
            min_size=1, max_size=2, statement_cache_size=0)
        async with owner.acquire() as conn:
            await conn.execute(_BASE_SCHEMA)
            tier = await conn.fetchrow(
                "INSERT INTO cps_tiers (name, tier_type, cps_limit, per_call_fee) "
                "VALUES ('api_basic', 'api', 5, 0.0100) RETURNING id")
            cust = await conn.fetchrow(
                "INSERT INTO customers (name, account_type, balance, status, api_tier_id) "
                "VALUES ('Legacy API Co', 'api', $1, 'active', $2) RETURNING id",
                START_BALANCE, tier["id"])
            await conn.execute(
                "INSERT INTO api_dids (customer_id, did, voice_url) VALUES ($1, $2, $3)",
                cust["id"], FROM_DID, "https://example.test/voice")
            state["customer_id"] = cust["id"]
        await owner.close()
        db.pool = await asyncpg.create_pool(
            host=pg.sock, port=pg.port, user="api", password="api_secret",
            database="postgres", min_size=1, max_size=5, statement_cache_size=0)

    async def _teardown():
        if db.pool is not None:
            await db.pool.close()
            db.pool = None

    _LOOP.run_until_complete(_setup())
    try:
        yield state
    finally:
        _LOOP.run_until_complete(_teardown())
        pg.stop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


@pytest.fixture(scope="module")
def client(calls_db):
    """httpx client over the REAL calls router, authed as the api customer.

    Mounts routers.calls hermetically (no main.py lifespan — main.py itself
    only mounts it when the flag is on) with an injected non-admin user scoped
    to the seeded customer. ASGITransport shares _LOOP with the asyncpg pool.
    """
    from fastapi import FastAPI, Request
    from routers import calls

    cid = calls_db["customer_id"]
    app = FastAPI()

    @app.middleware("http")
    async def _inject_user(request: Request, call_next):
        request.state.user = {"sub": "42", "role": "user", "customer_id": cid}
        return await call_next(request)

    app.include_router(calls.router, prefix="/v1/calls")
    transport = httpx.ASGITransport(app=app)
    c = httpx.AsyncClient(transport=transport, base_url="http://test")
    try:
        yield c
    finally:
        _run(c.aclose())


@pytest.fixture
def api_calling_on(monkeypatch):
    """Turn the retired product ON for one test (flag is read live)."""
    monkeypatch.setenv("API_CALLING_ENABLED", "true")


@pytest.fixture
def fake_originate(monkeypatch):
    """Stub the ESL originate (no FreeSWITCH in tests); records kwargs."""
    from routers import calls as calls_mod
    seen = []

    async def _fake(**kwargs):
        seen.append(kwargs)
        return True

    monkeypatch.setattr(calls_mod, "originate_call", _fake)
    return seen


def _body(to=TO_DEST):
    return {"from_did": FROM_DID, "to": to}


async def _balance(db, cid) -> Decimal:
    row = await db.fetch_one("SELECT balance FROM customers WHERE id=$1", cid)
    return row["balance"]


# ---------------------------------------------------------------------------
# Flag OFF — the router's own dependency 404s even when mounted directly.
# ---------------------------------------------------------------------------
def test_flag_off_router_dependency_404(calls_db, client, fake_originate, monkeypatch):
    monkeypatch.delenv("API_CALLING_ENABLED", raising=False)

    async def go():
        r = await client.post("/v1/calls", json=_body())
        assert r.status_code == 404, r.text
        assert r.json() == {"detail": "Not Found"}
        r = await client.get("/v1/calls/00000000-0000-0000-0000-000000000000")
        assert r.status_code == 404
        r = await client.post(
            "/v1/calls/00000000-0000-0000-0000-000000000000/update",
            json={"action": "hangup"})
        assert r.status_code == 404
        assert fake_originate == []
        n = await calls_db["db"].fetch_one("SELECT COUNT(*) AS n FROM active_calls")
        assert n["n"] == 0

    _run(go())


# ---------------------------------------------------------------------------
# Flag ON — legacy prepaid originate + raw balance decrement (unchanged flow).
# ---------------------------------------------------------------------------
def test_flag_on_legacy_prepaid_originate(calls_db, client, api_calling_on, fake_originate):
    db, cid = calls_db["db"], calls_db["customer_id"]

    async def go():
        bal0 = await _balance(db, cid)
        # A leftover x402 header from an old client is simply ignored now.
        r = await client.post("/v1/calls", json=_body(),
                              headers={"PAYMENT-PROTOCOL": "x402"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert set(body) == {"call_id", "status", "from", "to", "tier", "per_call_fee"}
        assert body["status"] == "initiated"
        assert body["from"] == FROM_DID and body["to"] == TO_DEST
        assert body["tier"] == "api_basic" and body["per_call_fee"] == 0.01
        assert "PAYMENT-REQUIRED" not in r.headers
        assert [k["uuid"] for k in fake_originate] == [body["call_id"]]

        ac = await db.fetch_one(
            "SELECT product_type, direction, destination FROM active_calls WHERE uuid=$1",
            body["call_id"])
        assert dict(ac) == {"product_type": "api", "direction": "outbound",
                            "destination": TO_DEST}
        # Background fee task: ONE raw decrement by the tier fee.
        assert await _balance(db, cid) == bal0 - TIER_FEE

    _run(go())


def test_flag_on_originate_failure_cleans_up(calls_db, client, api_calling_on, monkeypatch):
    db, cid = calls_db["db"], calls_db["customer_id"]
    from routers import calls as calls_mod

    async def _fail(**kwargs):
        return False

    monkeypatch.setattr(calls_mod, "originate_call", _fail)

    async def go():
        bal0 = await _balance(db, cid)
        before = await db.fetch_one("SELECT COUNT(*) AS n FROM active_calls")
        r = await client.post("/v1/calls", json=_body())
        assert r.status_code == 500, r.text
        after = await db.fetch_one("SELECT COUNT(*) AS n FROM active_calls")
        assert after["n"] == before["n"]          # active_calls row removed
        assert await _balance(db, cid) == bal0     # no fee for a failed launch

    _run(go())


def test_flag_on_invalid_numbers_422(calls_db, client, api_calling_on, fake_originate):
    async def go():
        r = await client.post("/v1/calls", json={"from_did": "abc", "to": TO_DEST})
        assert r.status_code == 422, r.text
        r = await client.post("/v1/calls", json={"from_did": FROM_DID, "to": "12"})
        assert r.status_code == 422, r.text
        assert fake_originate == []

    _run(go())


# ---------------------------------------------------------------------------
# STIR/SHAKEN Task 2.2 — from_did ownership gate (attestation-A layer 1).
# ---------------------------------------------------------------------------
def test_from_did_ownership_gate_and_stir_attest(calls_db, client, api_calling_on,
                                                fake_originate):
    """The tenant may only originate from an OWNED api_did (404-no-leak), and a
    successful originate carries stir_attest="A" into the ESL layer."""
    db = calls_db["db"]

    async def go():
        other = await db.fetch_one(
            "INSERT INTO customers (name, account_type, balance, status) "
            "VALUES ('Other Co', 'api', 10, 'active') RETURNING id")
        other_did = "+16175550999"
        await db.execute(
            "INSERT INTO api_dids (customer_id, did, voice_url) VALUES ($1, $2, $3)",
            other["id"], other_did, "https://other.test/voice")
        try:
            # (a) Cross-tenant from_did → 404 (no existence leak, no originate).
            r = await client.post("/v1/calls", json={"from_did": other_did, "to": TO_DEST})
            assert r.status_code == 404, r.text
            # (b) from_did that exists nowhere → 404.
            r2 = await client.post("/v1/calls",
                                   json={"from_did": "+19995550000", "to": TO_DEST})
            assert r2.status_code == 404
            assert fake_originate == []
            # (c) Owned from_did (10-digit input normalizes) → attestation A.
            r3 = await client.post("/v1/calls",
                                   json={"from_did": "6175550100", "to": TO_DEST})
            assert r3.status_code == 200, r3.text
            assert [k.get("stir_attest") for k in fake_originate] == ["A"]
        finally:
            await db.execute("DELETE FROM api_dids WHERE did = $1", other_did)
            await db.execute("DELETE FROM customers WHERE id = $1", other["id"])

    _run(go())
