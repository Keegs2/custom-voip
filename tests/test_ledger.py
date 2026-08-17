"""Payments foundation — append-only ledger tests (RCF-V1 port).

Ported from the unified branch's tests/test_ledger.py, adapted to RCF-V1 scope:
  * The migration under test is ``docker/postgres/init/37_payments_ledger.sql``
    (tables + grants ONLY — unlike unified's Wave 1 it does NOT rewrite
    rate_cdr(), and the customers add-credit path is NOT rewired through the
    ledger). The unified tests covering the rate_cdr rewrite and add_credit
    ledger routing are therefore intentionally DROPPED here.
  * The base schema is just the roles + customers table — the RCF-V1 migration
    has no dependency on cdrs/rates/get_rate.

These are REAL integration tests: they boot a throwaway PostgreSQL cluster (via
the local `initdb`/`pg_ctl` binaries — the ephemeral-PG pattern; the repo has no
central pytest harness, each test file is standalone-runnable), bootstrap the
minimal schema, apply the ACTUAL migration twice (idempotency), and exercise the
real ``services/ledger.py`` code against it. Nothing is mocked.

They cover:
  * idempotency — the same idempotency_key posted twice yields ONE entry and
    applies the money ONCE (no double-credit / double-charge).
  * reconciliation invariant — SUM(ledger_entries.amount) == customers.balance
    across topup + usage + refund (for a ledger-only customer — on RCF-V1 this
    invariant is scoped to demo/API-charge customers, see services/ledger.py).
  * append-only privilege — the `api` role has SELECT+INSERT only on
    ledger_entries (no UPDATE/DELETE), and the migration is idempotent.
  * float rejection — a raw binary float never enters the ledger.
  * billing router tenant isolation end-to-end.

Skips cleanly when the local PostgreSQL binaries are unavailable. Set
TEST_PG_BIN to point at a specific PostgreSQL bin dir if `pg_ctl` is not on PATH.

Run:  JWT_SECRET_KEY=x python3 -m pytest tests/test_ledger.py -q
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

asyncpg = pytest.importorskip("asyncpg", reason="asyncpg required for ledger tests")

REPO = Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
MIGRATION = REPO / "docker" / "postgres" / "init" / "37_payments_ledger.sql"

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

# Minimal schema the ledger migration needs: the roles (01_extensions.sql) and
# the customers table (02_schema_core.sql subset). The RCF-V1 migration does
# NOT touch rate_cdr(), so no cdrs/rates/get_rate bootstrap is needed.
_BASE_SCHEMA = """
CREATE ROLE api LOGIN PASSWORD 'api_secret';
CREATE ROLE freeswitch LOGIN PASSWORD 'fs_secret';

CREATE TABLE customers (
  id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL,
  account_type VARCHAR(20) NOT NULL DEFAULT 'api',
  balance DECIMAL(12,4) DEFAULT 0, credit_limit DECIMAL(12,4) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active',
  updated_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW());

GRANT ALL ON customers TO api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO api;
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
        async with db.pool.acquire() as conn:
            await conn.execute(_BASE_SCHEMA)
            await conn.execute(MIGRATION.read_text())
            # Idempotency: applying the migration a SECOND time must succeed.
            await conn.execute(MIGRATION.read_text())

    async def _teardown():
        if db.pool is not None:
            await db.pool.close()
            db.pool = None

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
# NOTE (RCF-V1): unified's tests for the rate_cdr() ledger rewrite and the
# add_credit → ledger routing are intentionally NOT ported. On this branch
# rate_cdr() and the customers add-credit path are untouched by design
# (billing is estimates-only → Equinox); the ledger serves only the payments
# demo + future API-calling charges. See services/ledger.py module docstring.
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Billing endpoints — end-to-end tenant isolation against the real DB.
# (Funding goes through the ledger service directly — this branch's admin
# add-credit endpoint is deliberately NOT ledger-routed.)
# ---------------------------------------------------------------------------
def test_billing_endpoints_tenant_isolation(ledger_db):
    from fastapi import HTTPException
    from routers import billing

    ledger = ledger_db

    async def real():
        from db import database as db
        # Two tenants, each funded via the ledger.
        cid_a = await _new_customer(db, "tenantA")
        cid_b = await _new_customer(db, "tenantB")
        await ledger.post_ledger_entry(cid_a, amount=Decimal("10.0000"),
                                       entry_type="topup", source="admin",
                                       idempotency_key="ta-fund")
        await ledger.post_ledger_entry(cid_b, amount=Decimal("99.0000"),
                                       entry_type="topup", source="admin",
                                       idempotency_key="tb-fund")

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
