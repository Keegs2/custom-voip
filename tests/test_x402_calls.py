"""x402 pay-per-call gate on the REAL POST /v1/calls endpoint (demo-gated).

Companion to tests/test_payments_demo.py (same ephemeral-PG harness). Proves the
two payment paths on the production API-calling endpoint:

  * PAY-PER-CALL (header ``PAYMENT-PROTOCOL: x402``):
      - 402 challenge with a LIVE quote off the real rate deck (seeded rates):
        tier connect fee + first-minute longest-prefix rate, DECIMAL-exact.
      - paid retry (PAYMENT-SIGNATURE) → settle → ONE negative x402 usage ledger
        entry keyed by the tx hash → originate (demo-minted) → 200 with a
        payment block + PAYMENT-RESPONSE header.
      - declared-amount mismatch → re-challenged 402, nothing charged.
      - replay of the same signature → 409, no double ledger post.
      - unrateable destination → 422 (no made-up price).
  * PREPAID (no x402 header, demo mode on): per-call fee posts ONE ledger
    ``rating`` usage entry (key ``api_call_fee:{uuid}``) — balance moves once,
    never the raw decrement too.
  * FLAG OFF: /v1/calls is byte-identical legacy — x402 header ignored, no 402,
    no ledger writes, raw balance decrement only.

Run:  JWT_SECRET_KEY=x PAYMENTS_DEMO_MODE=true PAYMENTS_DEMO_LATENCY_MS=0 \
        PAYMENTS_DEMO_FAKE_ORIGINATE=true python3 -m pytest tests/test_x402_calls.py -q
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

# Set the gates BEFORE importing app modules (module-level singletons read env).
os.environ.setdefault("PAYMENTS_DEMO_MODE", "true")
os.environ.setdefault("PAYMENTS_DEMO_LATENCY_MS", "0")
os.environ.setdefault("PAYMENTS_DEMO_FAKE_ORIGINATE", "true")
os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
os.environ.setdefault("ENV", "development")

asyncpg = pytest.importorskip("asyncpg", reason="asyncpg required for x402 call tests")
httpx = pytest.importorskip("httpx", reason="httpx required for x402 call tests")

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

# Minimal production-shaped schema: everything POST /v1/calls touches —
# customers + cps_tiers (tier fee), api_dids (from-DID auth), active_calls,
# the REAL rate deck (rate_tables/rates/customer_rate_assignments + the
# get_rate() longest-prefix function verbatim from 05_schema_cdr.sql), then the
# two payments migrations on top.
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

CREATE TABLE rate_tables (
  id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL,
  is_default BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT NOW());

CREATE TABLE rates (
  id SERIAL PRIMARY KEY,
  rate_table_id INT NOT NULL REFERENCES rate_tables(id) ON DELETE CASCADE,
  prefix VARCHAR(20) NOT NULL, description VARCHAR(100),
  rate_per_min DECIMAL(10,6) NOT NULL, cost_per_min DECIMAL(10,6) NOT NULL DEFAULT 0,
  connection_fee DECIMAL(10,6) DEFAULT 0, min_duration INT DEFAULT 0,
  increment INT DEFAULT 6, effective_date TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT rate_prefix_unique UNIQUE (rate_table_id, prefix));

CREATE TABLE customer_rate_assignments (
  customer_id INT PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  inbound_rate_table_id INT REFERENCES rate_tables(id),
  outbound_rate_table_id INT REFERENCES rate_tables(id));

-- Verbatim longest-prefix lookup from 05_schema_cdr.sql.
CREATE OR REPLACE FUNCTION get_rate(p_rate_table_id INT, p_destination VARCHAR)
RETURNS TABLE(rate_per_min DECIMAL, cost_per_min DECIMAL, connection_fee DECIMAL,
              min_duration INT, increment INT, prefix VARCHAR)
LANGUAGE SQL STABLE
AS $$
    SELECT r.rate_per_min, r.cost_per_min, r.connection_fee, r.min_duration,
           r.increment, r.prefix
    FROM rates r
    WHERE r.rate_table_id = p_rate_table_id
      AND p_destination LIKE r.prefix || '%'
    ORDER BY LENGTH(r.prefix) DESC
    LIMIT 1;
$$;

GRANT ALL ON customers, cps_tiers, api_dids, active_calls,
             rate_tables, rates, customer_rate_assignments TO api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO api;
GRANT EXECUTE ON FUNCTION get_rate TO api;
"""


class _EphemeralPG:
    def __init__(self, pg_bin):
        self.pg_bin = pg_bin
        self.tmp = tempfile.mkdtemp(prefix="revup_x402_pg.")
        self.data = os.path.join(self.tmp, "data")
        self.sock = os.path.join(self.tmp, "sock")
        os.makedirs(self.sock, exist_ok=True)
        self.port = 55434  # distinct from the other payment suites

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

# Seeded fixture facts (asserted throughout).
FROM_DID = "+16175550100"
TO_RATED = "+16175551234"       # matches prefix 1617 → 0.0125/min
TO_FALLBACK = "+12125551234"    # matches prefix 1 → 0.02/min
TO_UNRATEABLE = "+447911123456" # no prefix covers 44…
TIER_FEE = Decimal("0.0100")    # api_basic per_call_fee
RATE_1617 = Decimal("0.0125")
QUOTE_TOTAL = Decimal("0.0225")           # 0.0100 + 0.0125
QUOTE_MINOR = 22500                       # 0.0225 USD in USDC 6dp minor units
START_BALANCE = Decimal("100.0000")


@pytest.fixture(scope="module")
def x402_db():
    """Boot PG, apply schema + payment migrations, seed the rate deck + customer."""
    if PG_BIN is None:
        pytest.skip("no local PostgreSQL binaries; set TEST_PG_BIN to run x402 tests")
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
            await conn.execute(MIG_LEDGER.read_text())
            await conn.execute(MIG_DEMO.read_text())
            # Seed the REAL rate deck the quote reads.
            table = await conn.fetchrow(
                "INSERT INTO rate_tables (name, is_default) VALUES ('default', true) RETURNING id")
            await conn.execute(
                "INSERT INTO rates (rate_table_id, prefix, description, rate_per_min, cost_per_min) "
                "VALUES ($1, '1617', 'Boston metro', 0.0125, 0.0040), "
                "       ($1, '1',    'US/NANP',      0.0200, 0.0080)",
                table["id"])
            tier = await conn.fetchrow(
                "INSERT INTO cps_tiers (name, tier_type, cps_limit, per_call_fee) "
                "VALUES ('api_basic', 'api', 5, 0.0100) RETURNING id")
            cust = await conn.fetchrow(
                "INSERT INTO customers (name, account_type, balance, status, api_tier_id) "
                "VALUES ('X402 Bot Co', 'api', $1, 'active', $2) RETURNING id",
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
def client(x402_db):
    """httpx client over the REAL calls router, authed as the bot customer.

    Mounts routers.calls hermetically (no main.py lifespan) with an injected
    non-admin user scoped to the seeded customer — proving the tenant path an
    AI agent actually uses (JWT customer auth; payment is per-call ON TOP).
    ASGITransport shares _LOOP with the asyncpg pool (loop-bound).
    """
    from fastapi import FastAPI, Request
    from routers import calls

    cid = x402_db["customer_id"]
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


def _body(to=TO_RATED):
    return {"from_did": FROM_DID, "to": to}


async def _balance(db, cid) -> Decimal:
    row = await db.fetch_one("SELECT balance FROM customers WHERE id=$1", cid)
    return row["balance"]


async def _ledger_count(db, cid) -> int:
    row = await db.fetch_one(
        "SELECT COUNT(*) AS n FROM ledger_entries WHERE customer_id=$1", cid)
    return row["n"]


# ---------------------------------------------------------------------------
# 1) 402 challenge — quote correctness against the seeded rate deck.
# ---------------------------------------------------------------------------
def test_402_challenge_quote_from_real_rates(x402_db, client):
    db, cid = x402_db["db"], x402_db["customer_id"]

    async def go():
        r = await client.post("/v1/calls", json=_body(),
                              headers={"PAYMENT-PROTOCOL": "x402"})
        assert r.status_code == 402, r.text
        # PAYMENT-REQUIRED header present and carries the quoted minor amount.
        hdr = r.headers.get("PAYMENT-REQUIRED")
        assert hdr and f"amount={QUOTE_MINOR}" in hdr and "scheme=exact" in hdr
        body = r.json()
        # LIVE breakdown: tier connect fee + first-minute longest-prefix rate.
        assert body["price"]["connect_fee"] == "0.0100"
        assert Decimal(body["price"]["rate_per_min"]) == RATE_1617
        assert Decimal(body["price"]["first_minute"]) == RATE_1617
        assert body["price"]["total"] == str(QUOTE_TOTAL)
        assert body["price"]["matched_prefix"] == "1617"   # longest match, not '1'
        assert body["price"]["tier"] == "api_basic"
        assert body["asset"] == "USDC"
        assert body["amount_minor"] == QUOTE_MINOR
        assert body["pay_to"].startswith("0x")
        assert body["nonce"] and body["expires_at"] and body["how_to_pay"]
        # A challenge charges nothing and mints no call.
        assert await _ledger_count(db, cid) == 0
        assert await _balance(db, cid) == START_BALANCE
        n = await db.fetch_one("SELECT COUNT(*) AS n FROM active_calls")
        assert n["n"] == 0

        # Fallback prefix: '1' matches +1212… at 0.02 → total 0.03.
        r2 = await client.post("/v1/calls", json=_body(TO_FALLBACK),
                               headers={"PAYMENT-PROTOCOL": "x402"})
        assert r2.status_code == 402
        assert r2.json()["price"]["total"] == "0.0300"
        assert r2.json()["price"]["matched_prefix"] == "1"

    _run(go())


# ---------------------------------------------------------------------------
# 2) Unrateable destination → honest 422 (no invented price).
# ---------------------------------------------------------------------------
def test_unrateable_destination_422(x402_db, client):
    async def go():
        r = await client.post("/v1/calls", json=_body(TO_UNRATEABLE),
                              headers={"PAYMENT-PROTOCOL": "x402"})
        assert r.status_code == 422, r.text
        assert "not rateable" in r.json()["detail"]

    _run(go())


# ---------------------------------------------------------------------------
# 3) Paid retry — settle → ledger → (demo) originate → 200 + payment block.
# ---------------------------------------------------------------------------
def test_settle_ledger_originate_happy_path(x402_db, client):
    db, cid = x402_db["db"], x402_db["customer_id"]

    async def go():
        bal0 = await _balance(db, cid)
        r = await client.post(
            "/v1/calls", json=_body(),
            headers={"PAYMENT-PROTOCOL": "x402",
                     "PAYMENT-SIGNATURE": "0xdemo-signed-eip3009-auth-call1",
                     "PAYMENT-AMOUNT": str(QUOTE_TOTAL)})
        assert r.status_code == 200, r.text
        assert r.headers.get("PAYMENT-RESPONSE", "").startswith("x402 tx=0x")
        body = r.json()
        assert body["status"] == "demo_originated"     # fake-originate flag on
        assert body["from"] == FROM_DID and body["to"] == TO_RATED
        pay = body["payment"]
        assert pay["protocol"] == "x402"
        assert pay["amount"] == str(QUOTE_TOTAL)
        assert pay["amount_minor"] == QUOTE_MINOR
        assert pay["tx_hash"].startswith("0x")
        assert pay["breakdown"]["connect_fee"] == "0.0100"
        assert pay["ledger_entry_id"] is not None

        # Exactly ONE negative x402 usage entry, keyed by the tx hash.
        rows = await db.fetch_all(
            "SELECT amount, entry_type, source, idempotency_key, external_ref "
            "FROM ledger_entries WHERE customer_id=$1 AND source='x402'", cid)
        assert len(rows) == 1
        assert rows[0]["amount"] == -QUOTE_TOTAL
        assert rows[0]["entry_type"] == "usage"
        assert rows[0]["idempotency_key"] == f"x402:{pay['tx_hash']}"
        assert rows[0]["external_ref"] == pay["tx_hash"]
        # Balance moved once, by exactly the quote.
        assert await _balance(db, cid) == bal0 - QUOTE_TOTAL
        # The demo call record was minted.
        ac = await db.fetch_one(
            "SELECT state, destination FROM active_calls WHERE uuid=$1", body["call_id"])
        assert ac["state"] == "demo_originated" and ac["destination"] == TO_RATED
        # Audit trail: fake-originate + x402 scenario rows recorded.
        scen = await db.fetch_all(
            "SELECT scenario FROM demo_scenarios WHERE customer_id=$1", cid)
        names = {s["scenario"] for s in scen}
        assert {"demo_originate", "agent_usage"} <= names

    _run(go())


# ---------------------------------------------------------------------------
# 4) Price-mismatch rejection — declared amount != recomputed quote.
# ---------------------------------------------------------------------------
def test_price_mismatch_rechallenged(x402_db, client):
    db, cid = x402_db["db"], x402_db["customer_id"]

    async def go():
        before = await _ledger_count(db, cid)
        bal0 = await _balance(db, cid)
        r = await client.post(
            "/v1/calls", json=_body(),
            headers={"PAYMENT-PROTOCOL": "x402",
                     "PAYMENT-SIGNATURE": "0xdemo-cheapskate",
                     "PAYMENT-AMOUNT": "0.0001"})
        assert r.status_code == 402, r.text
        assert "mismatch" in r.json()["error"]
        assert r.json()["price"]["total"] == str(QUOTE_TOTAL)  # fresh honest quote
        assert "PAYMENT-REQUIRED" in r.headers
        # Nothing charged, no call.
        assert await _ledger_count(db, cid) == before
        assert await _balance(db, cid) == bal0

    _run(go())


# ---------------------------------------------------------------------------
# 5) Replay idempotency — same signature can never fund a second call.
# ---------------------------------------------------------------------------
def test_replay_rejected_409_no_double_post(x402_db, client):
    db, cid = x402_db["db"], x402_db["customer_id"]

    async def go():
        sig = {"PAYMENT-PROTOCOL": "x402", "PAYMENT-SIGNATURE": "0xdemo-replay-me"}
        r1 = await client.post("/v1/calls", json=_body(), headers=sig)
        assert r1.status_code == 200, r1.text
        tx = r1.json()["payment"]["tx_hash"]
        bal1 = await _balance(db, cid)
        count1 = await _ledger_count(db, cid)

        # REPLAY the exact same signed authorization.
        r2 = await client.post("/v1/calls", json=_body(), headers=sig)
        assert r2.status_code == 409, r2.text
        detail = r2.json()["detail"]
        assert detail["error"] == "x402 payment replay"
        assert detail["tx_hash"] == tx
        assert detail["original_call_id"] == r1.json()["call_id"]
        # No double ledger post, balance unmoved, no second call minted.
        assert await _ledger_count(db, cid) == count1
        assert await _balance(db, cid) == bal1
        n = await db.fetch_one(
            "SELECT COUNT(*) AS n FROM ledger_entries WHERE idempotency_key=$1",
            f"x402:{tx}")
        assert n["n"] == 1
        calls_n = await db.fetch_one(
            "SELECT COUNT(*) AS n FROM active_calls WHERE customer_id=$1 AND destination=$2",
            cid, TO_RATED)
        # happy-path call + replay-test first call = 2 (replay minted nothing).
        assert calls_n["n"] == 2

    _run(go())


# ---------------------------------------------------------------------------
# 6) PREPAID path (demo mode) — single ledger fee, no raw-decrement double.
# ---------------------------------------------------------------------------
def test_prepaid_path_single_ledger_charge(x402_db, client):
    db, cid = x402_db["db"], x402_db["customer_id"]

    async def go():
        bal0 = await _balance(db, cid)
        r = await client.post("/v1/calls", json=_body(TO_FALLBACK))  # no x402 headers
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "demo_originated"
        assert "payment" not in body                      # prepaid, not x402
        assert body["per_call_fee"] == 0.01
        call_id = body["call_id"]

        # Background task posted EXACTLY ONE rating usage entry for the fee…
        rows = await db.fetch_all(
            "SELECT amount, entry_type, source FROM ledger_entries "
            "WHERE customer_id=$1 AND idempotency_key=$2",
            cid, f"api_call_fee:{call_id}")
        assert len(rows) == 1
        assert rows[0]["amount"] == -TIER_FEE
        assert rows[0]["entry_type"] == "usage" and rows[0]["source"] == "rating"
        # …and the balance moved ONCE by the fee (ledger updated it atomically;
        # the raw decrement did NOT also run — no double charge).
        assert await _balance(db, cid) == bal0 - TIER_FEE

    _run(go())


# ---------------------------------------------------------------------------
# 7) FLAG OFF — byte-identical legacy behavior (no 402, no ledger writes).
# ---------------------------------------------------------------------------
def test_flag_off_legacy_behavior(x402_db, client, monkeypatch):
    db, cid = x402_db["db"], x402_db["customer_id"]
    from routers import calls as calls_mod

    # Demo mode OFF (read live per request) → fake-originate also off; stub the
    # real ESL originate so the legacy path "succeeds" without FreeSWITCH.
    monkeypatch.setenv("PAYMENTS_DEMO_MODE", "false")
    originated = []

    async def _fake_esl_originate(**kwargs):
        originated.append(kwargs["uuid"])
        return True

    monkeypatch.setattr(calls_mod, "originate_call", _fake_esl_originate)

    async def go():
        bal0 = await _balance(db, cid)
        count0 = await _ledger_count(db, cid)

        # (a) x402 header is IGNORED — no 402, plain legacy success shape.
        r = await client.post("/v1/calls", json=_body(),
                              headers={"PAYMENT-PROTOCOL": "x402"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "initiated"              # real originate path
        assert "payment" not in body
        assert "PAYMENT-REQUIRED" not in r.headers
        assert body["call_id"] in originated              # legacy ESL ran

        # (b) plain request → same legacy shape.
        r2 = await client.post("/v1/calls", json=_body())
        assert r2.status_code == 200
        assert r2.json()["status"] == "initiated"

        # Fee = legacy RAW balance decrement (2 calls × 0.01), ZERO ledger writes.
        assert await _ledger_count(db, cid) == count0
        assert await _balance(db, cid) == bal0 - Decimal("0.0200")

    _run(go())
