"""Manual DID intake with carrier-trunk attribution (migration 41 +
POST /v1/numbers/add, PUT /v1/numbers/{did}/carrier-trunk) — full-stack tests.

Proves, over the REAL router behind the REAL JWTAuthMiddleware on an ephemeral
local PostgreSQL (real migrations 17 + 34 + 25 + 40 + 41, 41 applied twice —
idempotency):

  * POST /add happy path: mixed input formats normalize through the shared
    canonical E.164 helper, in-batch dupes collapse, and the response envelope
    is EXACTLY {"added", "skipped_existing", "invalid", "count"} (the TED UI
    codes against it); rows land status='available' / source='manual' with the
    carrier_trunk_id attribution;
  * dup-skip on re-add, invalid entries reported verbatim, unknown/disabled
    trunk -> 404, batch >500 (and empty) -> 422;
  * support + tenant users get 403 on /add and the carrier-trunk PUT;
  * GET /inventory items carry carrier / carrier_pop / carrier_trunk_id /
    source; the carrier filter matches the COALESCEd value (carrier=bandwidth
    also finds legacy rows with NULL carrier_trunk_id); envelope unchanged;
  * GET /stats gains by_carrier (same COALESCE);
  * PUT /{did}/carrier-trunk re-associates and clears (null), returning the
    updated inventory item;
  * THE SYNC GUARD: POST /sync (Bandwidth client monkeypatched) never reports
    a manual row in 'removed' — even one whose trunk association was cleared —
    while a sync-owned row missing from Bandwidth still is (report-only: no
    status mutation); a manual DID that APPEARS in the Bandwidth feed is left
    entirely alone (no metadata overwrite);
  * the EXISTING assign flow works unchanged on a manually intaken DID
    (assign -> rcf_numbers row -> unassign), attribution surviving both, and
    /reconcile never clobbers source / carrier_trunk_id.

Harness mirrors tests/test_carrier_trunks.py (ephemeral local PG, module event
loop, db.pool wired as the runtime `api` role, REAL minted JWTs through the
REAL middleware).

Run:  JWT_SECRET_KEY=x python3 -m pytest tests/test_did_intake.py -q
"""
import asyncio
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

# Set env BEFORE importing app modules (auth.security reads JWT_SECRET_KEY at
# import time).
os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
os.environ.setdefault("ENV", "development")

asyncpg = pytest.importorskip("asyncpg", reason="asyncpg required for DID-intake tests")
httpx = pytest.importorskip("httpx", reason="httpx required for DID-intake tests")

REPO = Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
INIT = REPO / "docker" / "postgres" / "init"
MIG_DID_INVENTORY = INIT / "17_did_inventory.sql"
MIG_TRUNK_STATUS = INIT / "25_carrier_trunk_status.sql"
MIG_RELEASE_STATUS = INIT / "34_release_requested_status.sql"
MIG_CARRIER_TRUNKS = INIT / "40_carrier_trunks.sql"
MIG_DID_CARRIER = INIT / "41_did_carrier_source.sql"

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

# Roles + every non-inventory table the router touches, copied column-for-column
# from the init scripts (02 core customers/rcf/trunks, 03 api_dids, 09 users).
# did_inventory itself comes from the REAL migration 17 (+34 +41) so the columns
# under test are the migrations', not a copy. api_dids/trunk_dids carry the
# created_at the reconcile SELECT reads.
_BASE_SCHEMA = """
CREATE ROLE api LOGIN PASSWORD 'api_secret';
CREATE ROLE freeswitch LOGIN;         -- read-only routing/SBC role (17/40/41 grants)
CREATE ROLE grafana_ro;               -- granted on the health view by 25/40

CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  account_type VARCHAR(20) NOT NULL CHECK (account_type IN ('rcf', 'api', 'trunk', 'hybrid', 'ucaas')),
  balance DECIMAL(12,4) DEFAULT 0,
  credit_limit DECIMAL(12,4) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW());

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  customer_id INT REFERENCES customers(id) ON DELETE SET NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user', 'readonly')),
  name VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_login TIMESTAMPTZ);

CREATE TABLE rcf_numbers (
  id SERIAL PRIMARY KEY,
  did VARCHAR(20) NOT NULL,
  name VARCHAR(100),
  customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  forward_to VARCHAR(20) NOT NULL,
  pass_caller_id BOOLEAN DEFAULT true,
  enabled BOOLEAN DEFAULT true,
  failover_to VARCHAR(20),
  ring_timeout INT DEFAULT 30,
  max_channels INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT rcf_did_unique UNIQUE (did));

CREATE TABLE sip_trunks (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  trunk_name VARCHAR(100),
  max_channels INT NOT NULL CHECK (max_channels > 0),
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW());

CREATE TABLE trunk_dids (
  id SERIAL PRIMARY KEY,
  trunk_id INT NOT NULL REFERENCES sip_trunks(id) ON DELETE CASCADE,
  did VARCHAR(20) NOT NULL,
  CONSTRAINT trunk_did_unique UNIQUE (did));

CREATE TABLE api_dids (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  did VARCHAR(20) NOT NULL UNIQUE,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW());

-- Stub for migration 40's `ALTER TABLE cdrs ADD COLUMN ...` (CDR content is
-- irrelevant to DID intake; the real ingest columns are proven in
-- test_carrier_trunks.py / test_cdr_export.py).
CREATE TABLE cdrs (
  id BIGSERIAL,
  uuid VARCHAR(64) NOT NULL,
  start_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, start_time));

GRANT ALL ON customers, users, rcf_numbers, sip_trunks, trunk_dids, api_dids, cdrs TO api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO api;

-- Seeds: admin user 1 (assigned_by FK target, matches the admin JWT sub) and
-- rcf customer 42 (matches the tenant JWT customer_id).
INSERT INTO users (id, email, password_hash, role, name)
VALUES (1, 'admin@test.local', 'x', 'admin', 'Test Admin');
INSERT INTO customers (id, name, account_type, status)
VALUES (42, 'Test RCF Co', 'rcf', 'active');
"""


class _EphemeralPG:
    def __init__(self, pg_bin):
        self.pg_bin = pg_bin
        self.tmp = tempfile.mkdtemp(prefix="revup_didintake_pg.")
        self.data = os.path.join(self.tmp, "data")
        self.sock = os.path.join(self.tmp, "sock")
        os.makedirs(self.sock, exist_ok=True)
        self.port = 55437  # distinct from payments (55432-55434) + authz (55435) + trunks (55436)

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


def _run(coro):
    return _LOOP.run_until_complete(coro)


@pytest.fixture(scope="module")
def intake_db():
    """Boot PG, apply base schema + REAL 17/34/25/40/41 (41 twice — idempotency)."""
    if PG_BIN is None:
        pytest.skip("no local PostgreSQL binaries; set TEST_PG_BIN to run DID-intake tests")
    pg = _EphemeralPG(PG_BIN)
    try:
        pg.start()
    except Exception as e:  # noqa: BLE001
        pg.stop()
        pytest.skip(f"could not start throwaway PostgreSQL: {e}")

    from db import database as db  # noqa: E402

    state = {"db": db, "pg": pg}

    async def _setup():
        owner = await asyncpg.create_pool(
            host=pg.sock, port=pg.port, user="postgres", database="postgres",
            min_size=1, max_size=2, statement_cache_size=0)
        async with owner.acquire() as conn:
            await conn.execute(_BASE_SCHEMA)
            await conn.execute(MIG_DID_INVENTORY.read_text())   # 17: did_inventory
            await conn.execute(MIG_RELEASE_STATUS.read_text())  # 34: status CHECK
            await conn.execute(MIG_TRUNK_STATUS.read_text())    # 25: 40's view prereq
            await conn.execute(MIG_CARRIER_TRUNKS.read_text())  # 40: FK target + seeds
            # The migration under test — applied twice (idempotent: guarded
            # ADD COLUMNs, name-agnostic CHECK drop/recreate, IF NOT EXISTS index).
            await conn.execute(MIG_DID_CARRIER.read_text())
            await conn.execute(MIG_DID_CARRIER.read_text())
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


@pytest.fixture(scope="module")
def client(intake_db):
    """httpx client over the REAL routers behind the REAL JWT middleware."""
    from fastapi import FastAPI
    from middleware.auth import JWTAuthMiddleware
    from routers import carrier_trunks, number_inventory

    app = FastAPI()
    app.add_middleware(JWTAuthMiddleware)
    # Same mounts as main.py (canonical /v1 + legacy).
    app.include_router(number_inventory.router, prefix="/v1/numbers")
    app.include_router(number_inventory.router, prefix="/numbers")
    app.include_router(carrier_trunks.router, prefix="/v1/carrier-trunks")

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    c = httpx.AsyncClient(transport=transport, base_url="http://test")
    try:
        yield c
    finally:
        _run(c.aclose())


@pytest.fixture(scope="module")
def tokens(intake_db):
    """Real JWTs per role, minted exactly like POST /auth/login does."""
    from auth.security import create_access_token

    def mint(sub, email, role, customer_id):
        return create_access_token(
            {"sub": sub, "email": email, "role": role, "customer_id": customer_id})

    return {
        "admin": mint("1", "admin@test.local", "admin", None),
        "support": mint("2", "support@test.local", "support", None),
        "user": mint("3", "tenant@test.local", "user", 42),
    }


@pytest.fixture(scope="module")
def sinch_ids(intake_db):
    """ids of the migration-40 seeded Sinch trunks (never hardcoded)."""
    db = intake_db["db"]

    async def go():
        rows = await db.fetch_all(
            "SELECT id, pop FROM carrier_trunks WHERE carrier = 'sinch'")
        return {r["pop"]: r["id"] for r in rows}

    ids = _run(go())
    assert set(ids) == {"denver", "chicago"}
    return ids


def _auth(tokens, role):
    return {"Authorization": f"Bearer {tokens[role]}"}


async def _get_item(client, tokens, did):
    """Fetch one inventory item via GET /inventory (search on the digits)."""
    r = await client.get(f"/v1/numbers/inventory?search={did.lstrip('+')}",
                         headers=_auth(tokens, "admin"))
    assert r.status_code == 200, r.text
    items = [i for i in r.json()["items"] if i["did"] == did]
    assert len(items) == 1, f"{did} not found in inventory"
    return items[0]


# ---------------------------------------------------------------------------
# 1) POST /add — happy path, mixed formats, EXACT response envelope.
# ---------------------------------------------------------------------------
def test_add_happy_path_mixed_formats_exact_envelope(client, tokens, sinch_ids, intake_db):
    db = intake_db["db"]

    async def go():
        r = await client.post("/v1/numbers/add", headers=_auth(tokens, "admin"), json={
            "dids": [
                "5305480845",          # bare 10-digit NANP -> +1
                "+1 530 548 0846",     # already +CC, punctuation stripped
                "1 (617) 555-0100",    # 1 + 10 NANP
                "617-555-0100",        # DUP of previous in another format
                "notanumber",          # invalid: no digits
                "12345",               # invalid: too short / ambiguous
            ],
            "carrier_trunk_id": sinch_ids["denver"],
            "notes": "Sinch Denver turn-up batch",
        })
        assert r.status_code == 200, r.text
        body = r.json()

        # EXACT envelope — the TED UI codes against these four keys.
        assert set(body.keys()) == {"added", "skipped_existing", "invalid", "count"}
        assert body["added"] == ["+15305480845", "+15305480846", "+16175550100"]
        assert body["skipped_existing"] == []
        assert body["invalid"] == ["notanumber", "12345"]  # verbatim raw inputs
        assert body["count"] == 3

        # Rows landed available/manual with the trunk attribution + notes.
        rows = await db.fetch_all(
            "SELECT did, status, source, carrier_trunk_id, notes FROM did_inventory ORDER BY did")
        by_did = {r2["did"]: dict(r2) for r2 in rows}
        for did in ("+15305480845", "+15305480846", "+16175550100"):
            assert by_did[did]["status"] == "available"
            assert by_did[did]["source"] == "manual"
            assert by_did[did]["carrier_trunk_id"] == sinch_ids["denver"]
            assert by_did[did]["notes"] == "Sinch Denver turn-up batch"

    _run(go())


# ---------------------------------------------------------------------------
# 2) Dup-skip on re-add (existing DID untouched, new one added).
# ---------------------------------------------------------------------------
def test_add_dup_skip(client, tokens, sinch_ids):
    async def go():
        r = await client.post("/v1/numbers/add", headers=_auth(tokens, "admin"), json={
            "dids": ["+15305480845", "5305480999"],
            "carrier_trunk_id": sinch_ids["chicago"],
        })
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["added"] == ["+15305480999"]
        assert body["skipped_existing"] == ["+15305480845"]
        assert body["invalid"] == []
        assert body["count"] == 1

        # The skipped row kept its ORIGINAL attribution (Denver, first batch).
        item = await _get_item(client, tokens, "+15305480845")
        assert item["carrier_trunk_id"] == sinch_ids["denver"]

    _run(go())


# ---------------------------------------------------------------------------
# 3) Unknown / disabled trunk -> 404.
# ---------------------------------------------------------------------------
def test_add_unknown_and_disabled_trunk_404(client, tokens):
    async def go():
        hdrs = _auth(tokens, "admin")
        r = await client.post("/v1/numbers/add", headers=hdrs, json={
            "dids": ["+15305481000"], "carrier_trunk_id": 99999})
        assert r.status_code == 404, r.text

        # Disabled trunk (created through the real carrier-trunks API).
        r = await client.post("/v1/carrier-trunks", headers=hdrs, json={
            "carrier": "sinch", "pop": "disabledpop",
            "source_ip": "206.146.104.10", "enabled": False})
        assert r.status_code == 200, r.text
        disabled_id = r.json()["id"]

        r = await client.post("/v1/numbers/add", headers=hdrs, json={
            "dids": ["+15305481000"], "carrier_trunk_id": disabled_id})
        assert r.status_code == 404, r.text
        assert "disabled" in r.json()["detail"]

        # Nothing was inserted by either attempt.
        r = await client.get("/v1/numbers/inventory?search=5305481000", headers=hdrs)
        assert r.json()["total"] == 0

        r = await client.delete(f"/v1/carrier-trunks/{disabled_id}", headers=hdrs)
        assert r.status_code == 200

    _run(go())


# ---------------------------------------------------------------------------
# 4) Batch size limits: >500 and empty -> 422 (Pydantic Field bounds).
# ---------------------------------------------------------------------------
def test_add_batch_size_limits_422(client, tokens, sinch_ids):
    async def go():
        hdrs = _auth(tokens, "admin")
        r = await client.post("/v1/numbers/add", headers=hdrs, json={
            "dids": [f"+1530600{i:04d}" for i in range(501)],
            "carrier_trunk_id": sinch_ids["denver"]})
        assert r.status_code == 422, r.text

        r = await client.post("/v1/numbers/add", headers=hdrs, json={
            "dids": [], "carrier_trunk_id": sinch_ids["denver"]})
        assert r.status_code == 422, r.text

    _run(go())


# ---------------------------------------------------------------------------
# 5) Authz — support and tenant users 403 on both new admin routes.
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("role", ["support", "user"])
def test_non_admin_403_on_add_and_carrier_trunk_put(client, tokens, sinch_ids, role):
    async def go():
        hdrs = _auth(tokens, role)
        r = await client.post("/v1/numbers/add", headers=hdrs, json={
            "dids": ["+15305482000"], "carrier_trunk_id": sinch_ids["denver"]})
        assert r.status_code == 403, f"POST /add: {r.status_code} {r.text}"
        r = await client.put("/v1/numbers/+15305480845/carrier-trunk", headers=hdrs,
                             json={"carrier_trunk_id": sinch_ids["chicago"]})
        assert r.status_code == 403, f"PUT carrier-trunk: {r.status_code} {r.text}"

    _run(go())


# ---------------------------------------------------------------------------
# 6) GET /inventory — attribution fields + carrier filter (incl. legacy NULLs).
# ---------------------------------------------------------------------------
def test_inventory_carrier_fields_and_filter(client, tokens, sinch_ids, intake_db):
    db = intake_db["db"]

    async def go():
        # Legacy Bandwidth-sync row: plain insert, defaults apply
        # (source='bandwidth_sync', carrier_trunk_id NULL).
        await db.execute(
            "INSERT INTO did_inventory (did, status, city, state) "
            "VALUES ('+16175559999', 'available', 'Boston', 'MA')")

        hdrs = _auth(tokens, "admin")
        r = await client.get("/v1/numbers/inventory", headers=hdrs)
        assert r.status_code == 200, r.text
        body = r.json()
        # Envelope unchanged.
        assert set(body.keys()) == {"items", "total", "limit", "offset"}

        by_did = {i["did"]: i for i in body["items"]}

        manual = by_did["+15305480845"]
        assert manual["carrier"] == "sinch"
        assert manual["carrier_pop"] == "denver"
        assert manual["carrier_trunk_id"] == sinch_ids["denver"]
        assert manual["source"] == "manual"

        legacy = by_did["+16175559999"]
        assert legacy["carrier"] == "bandwidth"       # COALESCEd implicit
        assert legacy["carrier_pop"] is None
        assert legacy["carrier_trunk_id"] is None
        assert legacy["source"] == "bandwidth_sync"

        # carrier=sinch -> only attributed Sinch rows.
        r = await client.get("/v1/numbers/inventory?carrier=sinch", headers=hdrs)
        sinch_dids = {i["did"] for i in r.json()["items"]}
        assert sinch_dids == {"+15305480845", "+15305480846",
                              "+16175550100", "+15305480999"}

        # carrier=bandwidth -> matches the legacy NULL row (the COALESCE).
        r = await client.get("/v1/numbers/inventory?carrier=bandwidth", headers=hdrs)
        bw_items = r.json()["items"]
        assert {i["did"] for i in bw_items} == {"+16175559999"}
        assert r.json()["total"] == 1

    _run(go())


# ---------------------------------------------------------------------------
# 7) GET /stats — by_carrier with the same COALESCE.
# ---------------------------------------------------------------------------
def test_stats_by_carrier(client, tokens):
    async def go():
        r = await client.get("/v1/numbers/stats", headers=_auth(tokens, "admin"))
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["by_carrier"] == {"sinch": 4, "bandwidth": 1}
        assert body["total"] == 5

    _run(go())


# ---------------------------------------------------------------------------
# 8) PUT /{did}/carrier-trunk — re-associate + clear; returns the item shape.
# ---------------------------------------------------------------------------
def test_put_carrier_trunk_reassociate_and_clear(client, tokens, sinch_ids):
    async def go():
        hdrs = _auth(tokens, "admin")

        # Re-associate Denver -> Chicago (accepts a URL-form DID too).
        r = await client.put("/v1/numbers/15305480999/carrier-trunk", headers=hdrs,
                             json={"carrier_trunk_id": sinch_ids["chicago"]})
        assert r.status_code == 200, r.text
        item = r.json()
        assert item["did"] == "+15305480999"
        assert item["carrier"] == "sinch"
        assert item["carrier_pop"] == "chicago"
        assert item["carrier_trunk_id"] == sinch_ids["chicago"]
        assert item["source"] == "manual"
        assert "customer_name" in item and "status" in item  # full item shape

        # Clear (null) -> implicit Bandwidth; source stays 'manual'.
        r = await client.put("/v1/numbers/+15305480999/carrier-trunk", headers=hdrs,
                             json={"carrier_trunk_id": None})
        assert r.status_code == 200, r.text
        item = r.json()
        assert item["carrier_trunk_id"] is None
        assert item["carrier"] == "bandwidth"
        assert item["carrier_pop"] is None
        assert item["source"] == "manual"

        # Unknown trunk id -> 404 (DID untouched).
        r = await client.put("/v1/numbers/+15305480845/carrier-trunk", headers=hdrs,
                             json={"carrier_trunk_id": 99999})
        assert r.status_code == 404, r.text
        # Unknown DID -> 404.
        r = await client.put("/v1/numbers/+19995550000/carrier-trunk", headers=hdrs,
                             json={"carrier_trunk_id": sinch_ids["denver"]})
        assert r.status_code == 404, r.text

    _run(go())


# ---------------------------------------------------------------------------
# 9) THE SYNC GUARD — manual rows never in 'removed'; sync-owned behavior kept.
# ---------------------------------------------------------------------------
def test_sync_set_arithmetic_unit():
    """The pure ownership partition (no DB)."""
    from routers.number_inventory import _compute_sync_sets

    existing = [
        {"did": "+16175550001", "source": "bandwidth_sync"},  # still in BW
        {"did": "+16175550002", "source": "bandwidth_sync"},  # gone from BW
        {"did": "+15305480845", "source": "manual"},          # manual, not in BW
        {"did": "+15305480846", "source": "manual"},          # manual, IS in BW (edge)
    ]
    bw = {"+16175550001", "+15305480846", "+16170009999"}
    new, update, removed = _compute_sync_sets(existing, bw)
    assert new == {"+16170009999"}            # manual overlap never re-inserted
    assert update == {"+16175550001"}         # manual rows never metadata-updated
    assert removed == {"+16175550002"}        # manual rows NEVER 'removed'


def test_sync_guard_end_to_end(client, tokens, sinch_ids, intake_db, monkeypatch):
    """POST /sync with the Bandwidth client monkeypatched: a sync-owned row
    missing from BW is reported removed (status untouched — report-only); the
    manual Sinch rows are invisible to the sync even when one of them appears
    in the BW feed (left entirely alone) or has a cleared trunk association."""
    db = intake_db["db"]
    from routers import number_inventory

    async def go():
        # A second sync-owned row that Bandwidth no longer has.
        await db.execute(
            "INSERT INTO did_inventory (did, status) VALUES ('+16175558888', 'available')")

        feed = [
            # Sync-owned row still in BW -> metadata refresh.
            {"fullNumber": "+16175559999", "city": "Cambridge", "state": "MA",
             "lata": "128", "rateCenter": "CAMBRIDGE"},
            # EDGE: a MANUAL row's DID appears in the BW feed -> left alone.
            {"fullNumber": "+15305480845", "city": "Denver", "state": "CO",
             "lata": "656", "rateCenter": "DENVER"},
            # Brand-new TN -> inserted with default source='bandwidth_sync'.
            {"fullNumber": "+16170001111", "city": "Boston", "state": "MA",
             "lata": "128", "rateCenter": "BOSTON"},
        ]

        async def fake_get_all_tns():
            return feed

        monkeypatch.setattr(number_inventory, "_credentials_configured", lambda: True)
        monkeypatch.setattr(number_inventory, "get_all_tns", fake_get_all_tns)

        r = await client.post("/v1/numbers/sync", headers=_auth(tokens, "admin"))
        assert r.status_code == 200, r.text
        body = r.json()

        # Removed: ONLY the sync-owned row gone from BW. The four manual rows
        # (incl. +15305480999 whose trunk association was cleared in test 8 —
        # the guard keys on source, not carrier_trunk_id) never appear.
        assert body["removed"] == ["+16175558888"]
        assert body["inserted"] == 1
        assert body["updated"] == 1  # only +16175559999 — manual 845 NOT counted

        # Report-only: the 'removed' row was not mutated.
        row = await db.fetch_one(
            "SELECT status, source FROM did_inventory WHERE did = '+16175558888'")
        assert row["status"] == "available" and row["source"] == "bandwidth_sync"

        # The manual row in the feed was left ENTIRELY alone (no metadata).
        row = await db.fetch_one(
            "SELECT city, state, source, carrier_trunk_id FROM did_inventory "
            "WHERE did = '+15305480845'")
        assert row["city"] is None and row["state"] is None
        assert row["source"] == "manual"
        assert row["carrier_trunk_id"] == sinch_ids["denver"]

        # Sync-owned metadata refresh DID happen.
        row = await db.fetch_one(
            "SELECT city FROM did_inventory WHERE did = '+16175559999'")
        assert row["city"] == "Cambridge"

        # New TN inserted as sync-owned.
        row = await db.fetch_one(
            "SELECT status, source, carrier_trunk_id FROM did_inventory "
            "WHERE did = '+16170001111'")
        assert row["status"] == "available"
        assert row["source"] == "bandwidth_sync"
        assert row["carrier_trunk_id"] is None

    _run(go())


# ---------------------------------------------------------------------------
# 10) Assign flow — the EXISTING path works unchanged on a manual Sinch DID.
# ---------------------------------------------------------------------------
def test_assign_flow_on_manual_did(client, tokens, sinch_ids, intake_db):
    db = intake_db["db"]

    async def go():
        hdrs = _auth(tokens, "admin")

        r = await client.post("/v1/numbers/+15305480846/assign", headers=hdrs, json={
            "customer_id": 42, "product_type": "rcf"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "assigned"
        assert body["customer_id"] == 42
        assert body["product_type"] == "rcf"
        assert body["product_ref_id"] is not None

        # rcf_numbers record created (the RCF provisioning side-effect).
        rcf = await db.fetch_one(
            "SELECT customer_id FROM rcf_numbers WHERE did = '+15305480846'")
        assert rcf is not None and rcf["customer_id"] == 42

        # Attribution survived assignment.
        item = await _get_item(client, tokens, "+15305480846")
        assert item["status"] == "assigned"
        assert item["source"] == "manual"
        assert item["carrier"] == "sinch" and item["carrier_pop"] == "denver"
        assert item["customer_name"] == "Test RCF Co"

        # Unassign -> back to the pool, attribution intact.
        r = await client.post("/v1/numbers/+15305480846/unassign", headers=hdrs, json={})
        assert r.status_code == 200, r.text
        item = await _get_item(client, tokens, "+15305480846")
        assert item["status"] == "available"
        assert item["source"] == "manual"
        assert item["carrier_trunk_id"] == sinch_ids["denver"]
        rcf = await db.fetch_one(
            "SELECT id FROM rcf_numbers WHERE did = '+15305480846'")
        assert rcf is None

    _run(go())


# ---------------------------------------------------------------------------
# 11) /reconcile never clobbers attribution on an assigned manual DID.
# ---------------------------------------------------------------------------
def test_reconcile_preserves_attribution(client, tokens, sinch_ids, intake_db):
    db = intake_db["db"]

    async def go():
        hdrs = _auth(tokens, "admin")
        r = await client.post("/v1/numbers/+16175550100/assign", headers=hdrs, json={
            "customer_id": 42, "product_type": "rcf"})
        assert r.status_code == 200, r.text

        r = await client.post("/v1/numbers/reconcile", headers=hdrs)
        assert r.status_code == 200, r.text
        assert r.json()["by_product"]["rcf"] == 1

        # The upsert touched customer/product/status ONLY — attribution intact.
        row = await db.fetch_one(
            "SELECT status, source, carrier_trunk_id, customer_id, product_type "
            "FROM did_inventory WHERE did = '+16175550100'")
        assert row["status"] == "assigned"
        assert row["customer_id"] == 42 and row["product_type"] == "rcf"
        assert row["source"] == "manual"
        assert row["carrier_trunk_id"] == sinch_ids["denver"]

    _run(go())
