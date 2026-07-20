"""Payments Wave 1 — append-only ledger foundation tests.

Design: docs/PAYMENTS_SYSTEM_DESIGN.md §2, §7 Wave 1.

These are REAL integration tests: they boot a throwaway PostgreSQL cluster (via
the local `initdb`/`pg_ctl` binaries), bootstrap the minimal schema the ledger
needs (customers + rate_cdr's deps), apply the ACTUAL Wave-1 migration
(`docker/postgres/migrations/2026-07-20_payments_ledger.sql`, which creates the
ledger tables + rewrites `rate_cdr()`), and exercise the real
`services/ledger.py` code against it. Nothing is mocked — the idempotency,
reconciliation, and no-double-charge guarantees are proven against live SQL.

They cover:
  * idempotency — the same idempotency_key posted twice yields ONE entry and
    applies the money ONCE (no double-credit / double-charge).
  * reconciliation invariant — SUM(ledger_entries.amount) == customers.balance
    across topup + usage + refund.
  * rate_cdr no-double-charge — re-rating a CDR is a no-op (the `rated_at IS NULL`
    guard is preserved) and produces exactly one `usage` ledger entry.
  * append-only privilege — the `api` role has SELECT+INSERT only on
    ledger_entries (no UPDATE/DELETE), and the migration is idempotent (re-apply).
  * float rejection — a raw binary float never enters the ledger.

Skips cleanly when the local PostgreSQL binaries are unavailable (CI without PG),
mirroring the codebase's graceful-skip convention. Set TEST_PG_BIN to point at a
specific PostgreSQL bin dir if `pg_ctl` is not on PATH.

Run:  JWT_SECRET_KEY=x ENV=development python3 -m pytest tests/test_ledger.py -q
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

asyncpg = pytest.importorskip("asyncpg", reason="asyncpg required for ledger tests")

REPO = Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
MIGRATION = REPO / "docker" / "postgres" / "migrations" / "2026-07-20_payments_ledger.sql"

# Make the API source importable (services.ledger, db.database).
sys.path.insert(0, str(API_SRC))


def _find_pg_bin() -> str | None:
    """Locate a PostgreSQL bin dir containing initdb + pg_ctl.

    Honors TEST_PG_BIN, then PATH, then common Homebrew locations. Returns the
    directory or None (→ tests skip)."""
    override = os.getenv("TEST_PG_BIN")
    candidates = []
    if override:
        candidates.append(override)
    pgctl = shutil.which("pg_ctl")
    if pgctl:
        candidates.append(str(Path(pgctl).parent))
    candidates += [
        "/opt/homebrew/opt/postgresql@16/bin",
        "/opt/homebrew/opt/postgresql@15/bin",
        "/opt/homebrew/opt/postgresql@14/bin",
        "/usr/local/opt/postgresql@16/bin",
        "/usr/local/opt/postgresql@14/bin",
        "/usr/lib/postgresql/16/bin",
        "/usr/lib/postgresql/15/bin",
    ]
    for d in candidates:
        if d and Path(d, "initdb").exists() and Path(d, "pg_ctl").exists():
            return d
    return None


PG_BIN = _find_pg_bin()

# Minimal schema the ledger + rewritten rate_cdr() need. This is a faithful
# subset of 01_extensions.sql (roles), 02_schema_core.sql (customers) and
# 05_schema_cdr.sql (cdrs, rates, customer_rate_assignments, get_rate) — enough
# to apply the real migration and run rate_cdr. The migration under test creates
# ledger_entries/payment_* and (re)creates rate_cdr() itself.
_BASE_SCHEMA = """
CREATE ROLE api LOGIN PASSWORD 'api_secret';
CREATE ROLE freeswitch LOGIN PASSWORD 'fs_secret';

CREATE TABLE customers (
  id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL,
  account_type VARCHAR(20) NOT NULL DEFAULT 'api',
  balance DECIMAL(12,4) DEFAULT 0, credit_limit DECIMAL(12,4) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active',
  updated_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW());

CREATE TABLE cdrs (
  id BIGSERIAL, uuid VARCHAR(64) NOT NULL, customer_id INT NOT NULL,
  direction VARCHAR(10) NOT NULL DEFAULT 'outbound', destination VARCHAR(30) NOT NULL,
  duration_ms INT NOT NULL DEFAULT 0, billable_ms INT DEFAULT 0, rate_per_min DECIMAL(10,6),
  total_cost DECIMAL(12,6) DEFAULT 0, carrier_cost DECIMAL(12,6) DEFAULT 0,
  margin DECIMAL(12,6) DEFAULT 0, rated_at TIMESTAMPTZ, start_time TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY(id));

CREATE TABLE rates (
  id SERIAL PRIMARY KEY, rate_table_id INT, prefix VARCHAR(20),
  rate_per_min DECIMAL(10,6), cost_per_min DECIMAL(10,6), connection_fee DECIMAL(10,6) DEFAULT 0,
  min_duration INT DEFAULT 0, increment INT DEFAULT 6);

CREATE TABLE customer_rate_assignments (
  customer_id INT, inbound_rate_table_id INT, outbound_rate_table_id INT);

CREATE OR REPLACE FUNCTION get_rate(p_rate_table_id INT, p_destination VARCHAR)
RETURNS TABLE(rate_per_min DECIMAL, cost_per_min DECIMAL, connection_fee DECIMAL,
             min_duration INT, increment INT, prefix VARCHAR)
LANGUAGE SQL STABLE AS $$
  SELECT r.rate_per_min, r.cost_per_min, r.connection_fee, r.min_duration, r.increment, r.prefix
  FROM rates r WHERE r.rate_table_id = p_rate_table_id AND p_destination LIKE r.prefix || '%'
  ORDER BY LENGTH(r.prefix) DESC LIMIT 1;
$$;

GRANT ALL ON customers, cdrs, rates, customer_rate_assignments TO api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO api;
GRANT EXECUTE ON FUNCTION get_rate TO api;
"""


class _EphemeralPG:
    """A throwaway PostgreSQL cluster over a unix socket, torn down on stop()."""

    def __init__(self, pg_bin: str):
        self.pg_bin = pg_bin
        self.tmp = tempfile.mkdtemp(prefix="revup_ledger_pg.")
        self.data = os.path.join(self.tmp, "data")
        self.sock = os.path.join(self.tmp, "sock")
        os.makedirs(self.sock, exist_ok=True)
        self.port = 55432

    def start(self) -> None:
        subprocess.run(
            [f"{self.pg_bin}/initdb", "-D", self.data, "-U", "postgres",
             "--auth=trust", "-E", "UTF8"],
            check=True, capture_output=True,
        )
        subprocess.run(
            [f"{self.pg_bin}/pg_ctl", "-D", self.data,
             "-o", f"-p {self.port} -k {self.sock} -c listen_addresses=''",
             "-w", "-l", os.path.join(self.tmp, "log"), "start"],
            check=True, capture_output=True,
        )

    def stop(self) -> None:
        subprocess.run([f"{self.pg_bin}/pg_ctl", "-D", self.data, "-w", "stop"],
                       capture_output=True)
        shutil.rmtree(self.tmp, ignore_errors=True)


# One dedicated event loop shared by the module fixture + every test, so the
# asyncpg pool (loop-bound) is used only from the loop that created it.
_LOOP = asyncio.new_event_loop()


@pytest.fixture(scope="module")
def ledger_db():
    """Boot PG, bootstrap schema + apply the real migration, wire db.pool, yield.

    Yields the imported `services.ledger` module (with `db.database.pool` pointed
    at the throwaway cluster). A module-scoped DB is fine because each test uses
    its own customer id.
    """
    if PG_BIN is None:
        pytest.skip("no local PostgreSQL binaries (initdb/pg_ctl); set TEST_PG_BIN to run ledger tests")

    pg = _EphemeralPG(PG_BIN)
    try:
        pg.start()
    except Exception as e:  # noqa: BLE001
        pg.stop()
        pytest.skip(f"could not start throwaway PostgreSQL: {e}")

    from db import database as db  # noqa: E402
    from services import ledger  # noqa: E402

    async def _setup():
        db.pool = await asyncpg.create_pool(
            host=pg.sock, port=pg.port, user="postgres", database="postgres",
            min_size=1, max_size=5, statement_cache_size=0,
        )
        db.inventory_pool = db.pool
        async with db.pool.acquire() as conn:
            await conn.execute(_BASE_SCHEMA)
            await conn.execute(MIGRATION.read_text())
            # Idempotency: applying the migration a SECOND time must succeed.
            await conn.execute(MIGRATION.read_text())

    async def _teardown():
        if db.pool is not None:
            await db.pool.close()
            db.pool = None
            db.inventory_pool = None

    _LOOP.run_until_complete(_setup())
    try:
        yield ledger
    finally:
        _LOOP.run_until_complete(_teardown())
        pg.stop()


async def _new_customer(db, name="t", balance="0") -> int:
    row = await db.fetch_one(
        "INSERT INTO customers (name, balance) VALUES ($1, $2::numeric) RETURNING id",
        name, balance,
    )
    return row["id"]


def _run(coro):
    return _LOOP.run_until_complete(coro)


# ---------------------------------------------------------------------------
# Idempotency — the same key twice is exactly one entry, applied once.
# ---------------------------------------------------------------------------
def test_idempotent_double_post_is_one_entry(ledger_db):
    ledger = ledger_db
    from db import database as db

    async def go():
        cid = await _new_customer(db, "idem")
        e1 = await ledger.post_ledger_entry(
            cid, amount=Decimal("10.0000"), entry_type="topup",
            source="admin", idempotency_key="idem-key-1")
        e2 = await ledger.post_ledger_entry(
            cid, amount=Decimal("10.0000"), entry_type="topup",
            source="admin", idempotency_key="idem-key-1")
        # Same row returned, and only one row exists.
        assert e1["id"] == e2["id"]
        n = await db.fetch_one(
            "SELECT COUNT(*) AS n FROM ledger_entries WHERE idempotency_key='idem-key-1'")
        assert n["n"] == 1
        # Money applied exactly once.
        bal = await ledger.get_balance(cid)
        assert bal == Decimal("10.0000")
    _run(go())


# ---------------------------------------------------------------------------
# Reconciliation invariant — SUM(ledger.amount) == balance across signs.
# ---------------------------------------------------------------------------
def test_reconciliation_invariant_topup_usage_refund(ledger_db):
    ledger = ledger_db
    from db import database as db

    async def go():
        cid = await _new_customer(db, "recon")
        await ledger.post_ledger_entry(cid, amount=Decimal("100.0000"),
                                       entry_type="topup", source="admin",
                                       idempotency_key="recon-topup")
        await ledger.post_ledger_entry(cid, amount=Decimal("-12.3400"),
                                       entry_type="usage", source="rating",
                                       idempotency_key="recon-usage")
        await ledger.post_ledger_entry(cid, amount=Decimal("5.0000"),
                                       entry_type="refund", source="admin",
                                       idempotency_key="recon-refund")
        rec = await ledger.reconcile_balance(cid)
        assert rec["reconciled"] is True, rec
        assert rec["balance"] == Decimal("92.6600"), rec["balance"]
        assert rec["ledger_sum"] == rec["balance"]
    _run(go())


# ---------------------------------------------------------------------------
# balance_after snapshots the running balance at post time.
# ---------------------------------------------------------------------------
def test_balance_after_tracks_running_balance(ledger_db):
    ledger = ledger_db
    from db import database as db

    async def go():
        cid = await _new_customer(db, "running")
        a = await ledger.post_ledger_entry(cid, amount=Decimal("20.0000"),
                                           entry_type="topup", source="admin",
                                           idempotency_key="run-a")
        b = await ledger.post_ledger_entry(cid, amount=Decimal("-5.0000"),
                                           entry_type="usage", source="rating",
                                           idempotency_key="run-b")
        assert a["balance_after"] == Decimal("20.0000")
        assert b["balance_after"] == Decimal("15.0000")
    _run(go())


# ---------------------------------------------------------------------------
# rate_cdr no-double-charge — re-rating is a no-op; one usage entry only.
# ---------------------------------------------------------------------------
def test_rate_cdr_no_double_charge_on_rerate(ledger_db):
    ledger = ledger_db
    from db import database as db

    async def go():
        # Start at 0 and fund via a ledger topup so the WHOLE balance is
        # ledger-derived (no pre-ledger opening balance) — required for the
        # reconciliation invariant below to hold end-to-end.
        cid = await _new_customer(db, "cdr", balance="0")
        await ledger.post_ledger_entry(cid, amount=Decimal("50.0000"),
                                       entry_type="topup", source="admin",
                                       idempotency_key="cdr-fund")
        await db.execute(
            "INSERT INTO rates (rate_table_id, prefix, rate_per_min, cost_per_min, "
            "connection_fee, min_duration, increment) VALUES (1,'1',0.02,0.01,0,0,6)")
        uuid = "cdr-nodouble-1"
        await db.execute(
            "INSERT INTO cdrs (uuid, customer_id, direction, destination, duration_ms) "
            "VALUES ($1, $2, 'outbound', '15551234567', 60000)", uuid, cid)

        bal_before = await ledger.get_balance(cid)
        cost1 = await db.fetch_one("SELECT rate_cdr($1) AS c", uuid)
        cost2 = await db.fetch_one("SELECT rate_cdr($1) AS c", uuid)  # re-rate

        assert cost1["c"] is not None and cost1["c"] > 0
        assert cost2["c"] is None, "re-rating an already-rated CDR must be a no-op (NULL)"

        # Exactly one usage entry keyed by the CDR uuid.
        entries = await db.fetch_all(
            "SELECT amount, entry_type, source FROM ledger_entries WHERE idempotency_key=$1", uuid)
        assert len(entries) == 1, f"expected 1 usage entry, got {len(entries)}"
        assert entries[0]["entry_type"] == "usage"
        assert entries[0]["source"] == "rating"
        assert entries[0]["amount"] == -cost1["c"]  # money OUT, negative

        # Balance dropped by EXACTLY the cost, once.
        bal_after = await ledger.get_balance(cid)
        assert bal_after == bal_before - cost1["c"], (bal_before, bal_after, cost1["c"])

        # Ledger still reconciles with the balance cache.
        rec = await ledger.reconcile_balance(cid)
        assert rec["reconciled"] is True, rec
    _run(go())


# ---------------------------------------------------------------------------
# Append-only enforced by PRIVILEGE: api has SELECT+INSERT, not UPDATE/DELETE.
# ---------------------------------------------------------------------------
def test_ledger_entries_append_only_privilege(ledger_db):
    from db import database as db

    async def go():
        grants = await db.fetch_all(
            "SELECT privilege_type FROM information_schema.role_table_grants "
            "WHERE grantee='api' AND table_name='ledger_entries' ORDER BY privilege_type")
        privs = {g["privilege_type"] for g in grants}
        assert privs == {"INSERT", "SELECT"}, f"ledger_entries must be append-only for api, got {privs}"
    _run(go())


# ---------------------------------------------------------------------------
# Float rejection — a raw binary float must never enter the ledger.
# ---------------------------------------------------------------------------
def test_float_amount_is_rejected(ledger_db):
    ledger = ledger_db
    from db import database as db

    async def go():
        cid = await _new_customer(db, "nofloat")
        with pytest.raises(TypeError):
            await ledger.post_ledger_entry(cid, amount=1.23, entry_type="topup",
                                           source="admin", idempotency_key="float-key")
    _run(go())


# ---------------------------------------------------------------------------
# Bad entry_type / source are rejected before any DB write.
# ---------------------------------------------------------------------------
def test_invalid_entry_type_and_source_rejected(ledger_db):
    ledger = ledger_db
    from db import database as db

    async def go():
        cid = await _new_customer(db, "bad")
        with pytest.raises(ValueError):
            await ledger.post_ledger_entry(cid, amount=Decimal("1"), entry_type="bogus",
                                           source="admin", idempotency_key="bad-1")
        with pytest.raises(ValueError):
            await ledger.post_ledger_entry(cid, amount=Decimal("1"), entry_type="topup",
                                           source="bogus", idempotency_key="bad-2")
    _run(go())


# ---------------------------------------------------------------------------
# Admin add_credit posts a ledger entry (money-in through the ledger, not a
# direct balance write) and stays idempotent on the supplied key.
# ---------------------------------------------------------------------------
def test_add_credit_posts_ledger_entry(ledger_db):
    from db import database as db
    from routers import customers as customers_router

    admin = {"sub": "1", "email": "admin@test", "role": "admin"}

    async def go():
        cid = await _new_customer(db, "credit")
        # Positive credit → a `topup` ledger entry (source=admin).
        resp = await customers_router.add_credit(
            cid, 25.0, idempotency_key="credit-key-1", admin=admin)
        assert resp["id"] == cid
        assert resp["balance"] == Decimal("25.0000")

        entries = await db.fetch_all(
            "SELECT amount, entry_type, source FROM ledger_entries "
            "WHERE customer_id=$1 ORDER BY id", cid)
        assert len(entries) == 1
        assert entries[0]["entry_type"] == "topup"
        assert entries[0]["source"] == "admin"
        assert entries[0]["amount"] == Decimal("25.0000")

        # Idempotent: same key again → still ONE entry, balance unchanged.
        resp2 = await customers_router.add_credit(
            cid, 25.0, idempotency_key="credit-key-1", admin=admin)
        assert resp2["balance"] == Decimal("25.0000")
        n = await db.fetch_one(
            "SELECT COUNT(*) AS n FROM ledger_entries WHERE customer_id=$1", cid)
        assert n["n"] == 1

        # A negative correction routes as an `adjustment` (still source=admin).
        await customers_router.add_credit(
            cid, -5.0, idempotency_key="credit-adj-1", admin=admin)
        adj = await db.fetch_one(
            "SELECT entry_type FROM ledger_entries WHERE idempotency_key='credit-adj-1'")
        assert adj["entry_type"] == "adjustment"

        # Ledger reconciles with the balance cache after admin credits.
        rec = await ledger_db.reconcile_balance(cid)
        assert rec["reconciled"] is True, rec
        assert rec["balance"] == Decimal("20.0000")
    _run(go())


def test_add_credit_missing_customer_404(ledger_db):
    from fastapi import HTTPException
    from routers import customers as customers_router
    admin = {"sub": "1", "email": "admin@test", "role": "admin"}

    async def go():
        with pytest.raises(HTTPException) as ei:
            await customers_router.add_credit(999999, 5.0, admin=admin)
        assert ei.value.status_code == 404
    _run(go())


# ---------------------------------------------------------------------------
# Billing endpoints — end-to-end tenant isolation against the real DB.
# ---------------------------------------------------------------------------
def test_billing_endpoints_tenant_isolation(ledger_db):
    from fastapi import HTTPException
    from routers import billing
    from routers import customers as customers_router

    admin = {"sub": "1", "email": "admin@test", "role": "admin"}

    async def real():
        from db import database as db
        # Two tenants, each funded via the ledger.
        cid_a = await _new_customer(db, "tenantA")
        cid_b = await _new_customer(db, "tenantB")
        await customers_router.add_credit(cid_a, 10.0, idempotency_key="ta-fund", admin=admin)
        await customers_router.add_credit(cid_b, 99.0, idempotency_key="tb-fund", admin=admin)

        # Tenant A reads its OWN balance (customer_filter = cid_a).
        bal = await billing.get_billing_balance(customer_id=None, customer_filter=cid_a)
        assert bal["customer_id"] == cid_a
        assert bal["balance"] == Decimal("10.0000")

        # Tenant A cannot read Tenant B's balance → 404 (existence not leaked).
        with pytest.raises(HTTPException) as ei:
            await billing.get_billing_balance(customer_id=cid_b, customer_filter=cid_a)
        assert ei.value.status_code == 404

        # Tenant A ledger shows only A's entries.
        page = await billing.get_billing_ledger(customer_id=None, limit=50, cursor=None,
                                                 customer_filter=cid_a)
        assert page["customer_id"] == cid_a
        assert all(e["customer_id"] == cid_a for e in page["entries"])
        assert len(page["entries"]) == 1  # just the fund topup

        # Tenant A cannot read Tenant B's ledger → 404.
        with pytest.raises(HTTPException) as ei2:
            await billing.get_billing_ledger(customer_id=cid_b, limit=50, cursor=None,
                                              customer_filter=cid_a)
        assert ei2.value.status_code == 404

        # Admin (filter=None) can read either tenant by naming the id.
        admin_bal = await billing.get_billing_balance(customer_id=cid_b, customer_filter=None)
        assert admin_bal["balance"] == Decimal("99.0000")
    _run(real())


# ---------------------------------------------------------------------------
# get_ledger paginates newest-first with a keyset cursor.
# ---------------------------------------------------------------------------
def test_get_ledger_keyset_pagination(ledger_db):
    ledger = ledger_db
    from db import database as db

    async def go():
        cid = await _new_customer(db, "page")
        for i in range(5):
            await ledger.post_ledger_entry(cid, amount=Decimal("1.0000"),
                                           entry_type="topup", source="admin",
                                           idempotency_key=f"page-{i}")
        p1 = await ledger.get_ledger(cid, limit=2)
        assert len(p1["entries"]) == 2
        assert p1["next_cursor"] is not None
        # Newest first: ids descending.
        assert p1["entries"][0]["id"] > p1["entries"][1]["id"]
        p2 = await ledger.get_ledger(cid, limit=2, cursor=p1["next_cursor"])
        assert len(p2["entries"]) == 2
        assert p2["entries"][0]["id"] < p1["entries"][1]["id"]
        # Distinct pages.
        ids1 = {e["id"] for e in p1["entries"]}
        ids2 = {e["id"] for e in p2["entries"]}
        assert ids1.isdisjoint(ids2)
    _run(go())
