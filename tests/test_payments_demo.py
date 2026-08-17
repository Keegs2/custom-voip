"""Payments DEMO MODE (§9) — end-to-end walkthrough against a real database.

Design: docs/PAYMENTS_SYSTEM_DESIGN.md §9. RCF-V1 port of the unified branch's
tests/test_payments_demo.py — the migrations under test are
``docker/postgres/init/37_payments_ledger.sql`` + ``38_payments_demo.sql``.
No rate_cdr rewrite exists on this branch (billing stays estimates-only →
Equinox): the call-drain scenario posts its usage directly via the ledger
service, which is exactly what the ported router does in production here.

These are REAL integration tests (same harness as tests/test_ledger.py): boot a
throwaway PostgreSQL cluster, bootstrap the minimal schema, apply BOTH payments
migrations, and exercise the ACTUAL demo services +
payments router against live SQL. Nothing is mocked except processor latency
(zeroed via PAYMENTS_DEMO_LATENCY_MS=0). The demo's whole point — REAL ledger
data, REAL auto-recharge trigger, REAL reconciliation invariant, isolated to the
demo customer — is proven here.

Coverage (the exec walkthrough):
  * seed → dedicated is_demo customer created, funded via a real ledger topup.
  * add payment method → tokens only, one default.
  * simulate call-drain → usage crosses threshold → auto-recharge FIRES → a
    `topup` ledger entry appears and the balance tops up.
  * metered endpoint (HTTP layer) → 402 with PAYMENT-REQUIRED, then 200 +
    micro-charge when retried with PAYMENT-SIGNATURE.
  * MPP session → open, stream charges, spend-limit refusal, settle → one
    `stripe_mpp` usage entry.
  * decline → dunning (consecutive_failures increments, disabled_reason set).
  * reconciliation invariant holds for the demo customer throughout.
  * isolation → a real (non-demo) customer is untouched; reset removes ONLY demo.
  * gating → PAYMENTS_DEMO_MODE off → router 404s.

Run:  JWT_SECRET_KEY=x ENV=development PAYMENTS_DEMO_MODE=true PAYMENTS_DEMO_LATENCY_MS=0 \
        python3 -m pytest tests/test_payments_demo.py -q
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

# The demo is gated on this env var; set it BEFORE importing the app modules so
# the provider factory resolves the simulation rails. Zero latency for fast tests.
os.environ.setdefault("PAYMENTS_DEMO_MODE", "true")
os.environ.setdefault("PAYMENTS_DEMO_LATENCY_MS", "0")
os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
os.environ.setdefault("ENV", "development")

asyncpg = pytest.importorskip("asyncpg", reason="asyncpg required for demo tests")

REPO = Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
MIG_LEDGER = REPO / "docker" / "postgres" / "init" / "37_payments_ledger.sql"
MIG_DEMO = REPO / "docker" / "postgres" / "init" / "38_payments_demo.sql"

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

# Minimal schema (mirrors tests/test_ledger.py) — enough to apply both
# migrations. The RCF-V1 migrations do NOT touch rate_cdr(), so no
# cdrs/rates/get_rate bootstrap is needed (unlike unified).
_BASE_SCHEMA = """
CREATE ROLE api LOGIN PASSWORD 'api_secret';
CREATE ROLE freeswitch LOGIN PASSWORD 'fs_secret';

CREATE TABLE customers (
  id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL,
  account_type VARCHAR(20) NOT NULL DEFAULT 'api',
  balance DECIMAL(12,4) DEFAULT 0, credit_limit DECIMAL(12,4) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active', traffic_grade VARCHAR(10) DEFAULT 'standard',
  daily_limit DECIMAL(12,4) DEFAULT 500, cpm_limit INT DEFAULT 60,
  updated_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW());

GRANT ALL ON customers TO api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO api;
"""


class _EphemeralPG:
    def __init__(self, pg_bin):
        self.pg_bin = pg_bin
        self.tmp = tempfile.mkdtemp(prefix="revup_demo_pg.")
        self.data = os.path.join(self.tmp, "data")
        self.sock = os.path.join(self.tmp, "sock")
        os.makedirs(self.sock, exist_ok=True)
        self.port = 55433

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


@pytest.fixture(scope="module")
def demo_db():
    """Boot PG, apply base schema + BOTH payment migrations, wire db.pool.

    The migration is applied as the DB OWNER (postgres) so the SECURITY DEFINER
    reset_demo_ledger() is owned by a superuser (matching production, where the
    migration is applied by the postgres superuser). The app pool then connects
    as `api` for the walkthrough, proving the append-only + EXECUTE grants work.
    """
    if PG_BIN is None:
        pytest.skip("no local PostgreSQL binaries; set TEST_PG_BIN to run demo tests")
    pg = _EphemeralPG(PG_BIN)
    try:
        pg.start()
    except Exception as e:  # noqa: BLE001
        pg.stop()
        pytest.skip(f"could not start throwaway PostgreSQL: {e}")

    from db import database as db  # noqa: E402

    async def _setup():
        # Owner (superuser) applies schema + migrations.
        owner = await asyncpg.create_pool(
            host=pg.sock, port=pg.port, user="postgres", database="postgres",
            min_size=1, max_size=2, statement_cache_size=0)
        async with owner.acquire() as conn:
            await conn.execute(_BASE_SCHEMA)
            await conn.execute(MIG_LEDGER.read_text())
            await conn.execute(MIG_DEMO.read_text())
            # Idempotency: applying both a SECOND time must succeed.
            await conn.execute(MIG_LEDGER.read_text())
            await conn.execute(MIG_DEMO.read_text())
        await owner.close()
        # App connects as `api` (the runtime role) — proves the grants.
        db.pool = await asyncpg.create_pool(
            host=pg.sock, port=pg.port, user="api", password="api_secret",
            database="postgres", min_size=1, max_size=5, statement_cache_size=0)

    async def _teardown():
        if db.pool is not None:
            await db.pool.close()
            db.pool = None

    _LOOP.run_until_complete(_setup())
    try:
        yield db
    finally:
        _LOOP.run_until_complete(_teardown())
        pg.stop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


# ---------------------------------------------------------------------------
# The full exec walkthrough, in order, in one test (shared demo customer).
# ---------------------------------------------------------------------------
def test_full_demo_walkthrough(demo_db):
    from services import demo_seed, ledger
    from routers import payments

    async def go():
        # 1) SEED — dedicated is_demo customer, funded via real ledger topup.
        seed = await demo_seed.seed_demo()
        cid = seed["customer_id"]
        assert seed["name"] == "DEMO — Acme Robotics"
        assert seed["balance"] == Decimal("250.0000")
        # is_demo flag set.
        row = await demo_db.fetch_one("SELECT is_demo, account_type FROM customers WHERE id=$1", cid)
        assert row["is_demo"] is True
        assert row["account_type"] == "api"  # never rcf
        # Seed is idempotent (re-seed doesn't double-credit).
        seed2 = await demo_seed.seed_demo()
        assert seed2["customer_id"] == cid
        assert (await ledger.get_balance(cid)) == Decimal("250.0000")

        # 2) ADD PAYMENT METHOD — tokens only, one default.
        m = await payments.add_payment_method(
            body=payments.AddMethodRequest(brand="visa", make_default=True),
            customer_id=None, customer_filter=cid)
        assert m["provider_pm_id"].startswith("pm_")
        assert m["brand"] == "visa" and m["last4"] == "4242"
        assert m["is_default"] is True
        # No PAN/CVV column exists anywhere (SAQ-A).
        pan = await demo_db.fetch_all(
            "SELECT column_name FROM information_schema.columns WHERE table_name='payment_methods' "
            "AND column_name IN ('pan','card_number','cvv','cvc')")
        assert pan == []

        # 3) CALL-DRAIN — usage crosses threshold (50) → auto-recharge FIRES.
        #    Balance 250 → drain 220*0.02=4.40? Not enough. Drain hard: 5000 min.
        drain = await payments.simulate_call_drain(
            minutes=11000, rate_per_min=0.02, customer_id=cid,
            admin={"sub": "1", "role": "admin"})
        # 11000 * 0.02 = 220 → balance 250-220 = 30 < 50 threshold → recharge $100.
        assert drain["balance_after_drain"] == Decimal("30.0000")
        assert drain["auto_recharge"]["action"] == "charged", drain["auto_recharge"]
        assert drain["auto_recharge"]["amount"] == Decimal("100.0000")
        assert drain["balance"] == Decimal("130.0000")  # 30 + 100
        # A `topup` ledger entry from the card rail exists.
        topups = await demo_db.fetch_all(
            "SELECT source, amount, metadata FROM ledger_entries "
            "WHERE customer_id=$1 AND entry_type='topup' AND source='stripe_card'", cid)
        assert len(topups) == 1
        assert topups[0]["amount"] == Decimal("100.0000")
        # payment_transactions recorded the charge.
        pt = await demo_db.fetch_one(
            "SELECT status, kind FROM payment_transactions WHERE customer_id=$1 AND kind='topup' AND provider='stripe'", cid)
        assert pt["status"] == "succeeded"

        # 4) MPP SESSION — open, stream, spend-limit refusal, settle.
        sess = await payments.open_mpp_session(
            body=payments.MppSessionRequest(spend_limit=5.0, label="voice-agent"),
            customer_id=None, customer_filter=cid)
        sid = sess["id"]
        assert sess["status"] == "open" and sess["spend_limit"] == Decimal("5.0000")
        c1 = await payments.charge_mpp_session(
            sid, body=payments.MppChargeRequest(amount=1.5), customer_id=None, customer_filter=cid)
        assert c1["accepted"] and c1["total_charged"] == Decimal("1.5000")
        c2 = await payments.charge_mpp_session(
            sid, body=payments.MppChargeRequest(amount=2.0), customer_id=None, customer_filter=cid)
        assert c2["total_charged"] == Decimal("3.5000")
        # Overrun refused (would exceed 5.0).
        from fastapi import HTTPException
        with pytest.raises(HTTPException) as ei:
            await payments.charge_mpp_session(
                sid, body=payments.MppChargeRequest(amount=2.0), customer_id=None, customer_filter=cid)
        assert ei.value.status_code == 409
        # Settle the tab.
        bal_before_settle = await ledger.get_balance(cid)
        cs = await payments.charge_mpp_session(
            sid, body=payments.MppChargeRequest(amount=1.0, settle=True),
            customer_id=None, customer_filter=cid)
        assert cs["settled"] is True
        assert cs["total_charged"] == Decimal("4.5000")
        assert cs["settlement"]["provider_ref"].startswith("pi_")
        # Tab settled → one stripe_mpp usage entry (money OUT of the tab total).
        assert (await ledger.get_balance(cid)) == bal_before_settle - Decimal("4.5000")
        mpp_entry = await demo_db.fetch_one(
            "SELECT amount FROM ledger_entries WHERE customer_id=$1 AND source='stripe_mpp'", cid)
        assert mpp_entry["amount"] == Decimal("-4.5000")

        # 5) AGENT USAGE (x402 batch) — settles a USDC batch as one x402 usage entry.
        au = await payments.simulate_agent_usage(
            requests=25, customer_id=cid, admin={"sub": "1", "role": "admin"})
        assert au["total_charged"] == Decimal("0.2500")  # 25 * 0.01
        assert au["tx_hash"].startswith("0x")
        x = await demo_db.fetch_one(
            "SELECT amount, source FROM ledger_entries WHERE customer_id=$1 AND source='x402' LIMIT 1", cid)
        assert x["amount"] == Decimal("-0.2500")

        # 6) DECLINE → DUNNING.
        dec = await payments.simulate_decline(
            reason="insufficient_funds", drain_to_trigger=True, customer_id=cid,
            admin={"sub": "1", "role": "admin"})
        assert dec["auto_recharge"]["action"] == "declined"
        assert dec["auto_recharge"]["reason"] == "insufficient_funds"
        assert dec["dunning"]["consecutive_failures"] >= 1

        # 7) RECONCILIATION INVARIANT holds for the demo customer.
        rec = await ledger.reconcile_balance(cid)
        assert rec["reconciled"] is True, rec

        # 8) DEMO STATE returns coherent, populated data.
        state = await payments.demo_state_endpoint(customer_id=None, admin={"sub": "1", "role": "admin"})
        assert state["seeded"] is True
        assert state["customer"]["id"] == cid
        assert len(state["transactions"]) > 0
        assert state["auto_recharge"] is not None
        assert len(state["payment_methods"]) == 1
        assert state["revenue"]["total_revenue"] > 0
        rails = {r["rail"] for r in state["revenue"]["by_rail"]}
        assert "stripe_card" in rails  # the auto-recharge topup shows as revenue

        # 9) SUMMARY (revenue by rail) + COMPLIANCE (three green gates).
        summ = await payments.payments_summary(customer_id=None, scope="demo",
                                               admin={"sub": "1", "role": "admin"})
        assert summ["revenue"]["total_revenue"] > 0
        assert summ["reconciled"] is True
        comp = await payments.compliance_status(admin={"sub": "1", "role": "admin"})
        assert comp["all_green"] is True
        assert {g["id"] for g in comp["gates"]} == {
            "pci_saq_a", "closed_loop_prepaid", "non_custodial_crypto"}

    _run(go())


# ---------------------------------------------------------------------------
# Isolation — a real (non-demo) customer is untouched; reset removes ONLY demo.
# ---------------------------------------------------------------------------
def test_demo_isolation_and_reset(demo_db):
    from services import demo_seed, ledger

    async def go():
        # A real (non-demo) customer with a real ledger balance.
        real = await demo_db.fetch_one(
            "INSERT INTO customers (name, account_type, is_demo) VALUES ('Real Co','api',false) RETURNING id")
        real_id = real["id"]
        await ledger.post_ledger_entry(real_id, amount=Decimal("500.0000"),
                                       entry_type="topup", source="admin",
                                       idempotency_key=f"real-fund-{real_id}")
        # Seed demo (dedicated is_demo customer, distinct id).
        seed = await demo_seed.seed_demo()
        demo_id = seed["customer_id"]
        assert demo_id != real_id

        # RESET — deletes ONLY demo data (via the is_demo-guarded purge).
        result = await demo_seed.reset_demo()
        assert demo_id in result["customer_ids"]
        assert result["deleted_ledger_entries"] >= 1

        # Demo customer + its ledger are gone.
        assert (await demo_db.fetch_one("SELECT id FROM customers WHERE id=$1", demo_id)) is None
        assert (await demo_db.fetch_one(
            "SELECT id FROM ledger_entries WHERE customer_id=$1", demo_id)) is None
        # Real customer + its ledger are UNTOUCHED (isolation proven).
        assert (await ledger.get_balance(real_id)) == Decimal("500.0000")
        real_entries = await demo_db.fetch_all(
            "SELECT id FROM ledger_entries WHERE customer_id=$1", real_id)
        assert len(real_entries) == 1
        # NB: the `api` role CANNOT delete a non-demo customer's ledger rows
        # (append-only by privilege) nor via reset_demo_ledger() (is_demo guard),
        # so the real customer's row is intentionally left in the module DB.

    _run(go())


# ---------------------------------------------------------------------------
# HTTP layer: metered endpoint 402-then-200 (needs headers → TestClient).
# ---------------------------------------------------------------------------
def test_metered_402_then_200_via_http(demo_db):
    """Full HTTP round-trip of the x402 flow through a mounted FastAPI app.

    Mounts ONLY the payments router (bypassing main.py's middleware/lifespan) so
    the test is hermetic, injects an admin request.state.user, then drives GET
    /demo/metered over HTTP: first 402 with PAYMENT-REQUIRED, then 200 +
    PAYMENT-RESPONSE when retried with a PAYMENT-SIGNATURE.

    Driven via httpx ASGITransport on the SAME event loop (_LOOP) that owns the
    asyncpg pool — asyncpg pools are strictly loop-bound, so we cannot use the
    default TestClient (which spins its own loop).
    """
    import httpx
    from fastapi import FastAPI, Request
    from services import demo_seed
    from routers import payments

    # Seed a demo customer first (call the service directly for setup).
    _run(demo_seed.seed_demo())
    cid = _run(demo_seed.get_demo_customer_id())

    app = FastAPI()

    # Inject an admin user on every request (bypass JWT middleware for the test).
    @app.middleware("http")
    async def _inject_user(request: Request, call_next):
        request.state.user = {"sub": "1", "role": "admin", "customer_id": None}
        return await call_next(request)

    app.include_router(payments.router, prefix="/v1/payments")

    async def drive():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            # 1) No payment → 402 with PAYMENT-REQUIRED header.
            r1 = await client.get(f"/v1/payments/demo/metered?customer_id={cid}")
            assert r1.status_code == 402, r1.text
            assert "payment-required" in {k.lower() for k in r1.headers}
            body1 = r1.json()
            assert body1["accepts"][0]["asset"] == "USDC"
            assert body1["accepts"][0]["amount_minor"] == 10000  # 0.01 USDC in 6dp

            # 2) Retry WITH PAYMENT-SIGNATURE → 200 + PAYMENT-RESPONSE + micro-charge.
            r2 = await client.get(
                f"/v1/payments/demo/metered?customer_id={cid}",
                headers={"PAYMENT-SIGNATURE": "0xdemo-signed-eip3009-auth"})
            assert r2.status_code == 200, r2.text
            assert "payment-response" in {k.lower() for k in r2.headers}
            body2 = r2.json()
            assert body2["ok"] is True
            assert body2["settlement"]["tx_hash"].startswith("0x")
            assert body2["settlement"]["amount_minor"] == 10000
            assert body2["ledger_entry_id"] is not None

    _run(drive())
    # Cleanup demo data so the module DB stays isolated for other tests.
    _run(demo_seed.reset_demo())


# ---------------------------------------------------------------------------
# Gating: PAYMENTS_DEMO_MODE off → the whole router 404s.
# ---------------------------------------------------------------------------
def test_demo_mode_gate_404_when_disabled(monkeypatch):
    from fastapi import HTTPException
    from routers import payments
    import services.payments as psvc

    # Force demo mode OFF for this check.
    monkeypatch.setenv("PAYMENTS_DEMO_MODE", "false")
    assert psvc.demo_mode_enabled() is False
    with pytest.raises(HTTPException) as ei:
        payments._require_demo_mode()
    assert ei.value.status_code == 404
