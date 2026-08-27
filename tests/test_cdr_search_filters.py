"""CDR Search filter contract — GET /v1/cdrs + /v1/cdrs/summary over the REAL router.

Covers the API side of the support CDR Search rebuild (pinned contract: both
endpoints accept the SAME filter set):

  * NEW `zone` filter on BOTH endpoints — east|west|central only (422 on
    anything else), applied as a parameterized sbc_id prefix match
    ("{zone}-sbc-{n}"). Rows with NULL sbc_id (pre-migration-18) are excluded
    by any zone filter, by design.
  * Explicit date ranges honored on BOTH endpoints (the production bug class:
    rows outside the range must be excluded), with INCLUSIVE bounds and naive
    datetimes pinned to UTC.
  * Summary default window unified to 24h (was 7 days) and summary now honors
    the full shared filter set (zone, direction, product_type, destination
    prefix, trunk_id, sbc_id, rated_only).
  * customer_id=0 (the ingest default for unmatched calls) is a real filter
    now — the old truthiness check silently dropped it.
  * destination is a LITERAL prefix match — LIKE metachars no longer act as
    wildcards (destination='%' used to match every row).
  * Tenant/support/admin scoping preserved exactly (get_support_read_filter:
    admin+support platform-wide, tenants hard-scoped, param override ignored).
  * NEW `total` on GET /v1/cdrs — COUNT(*) over the SAME filters (shared
    builder, scoping included), independent of limit/offset; `count` stays
    the returned page's row count (back-compat).

Harness mirrors tests/test_support_role_authz.py (ephemeral local PG, module
event loop, db.pool wired as the runtime `api` role, REAL JWTAuthMiddleware
with REAL minted JWTs per role — the exact production auth path).

Run:  JWT_SECRET_KEY=x python3 -m pytest tests/test_cdr_search_filters.py -q
"""
import asyncio
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

# Set env BEFORE importing app modules (auth.security reads JWT_SECRET_KEY at
# import time).
os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
os.environ.setdefault("ENV", "development")

asyncpg = pytest.importorskip("asyncpg", reason="asyncpg required for CDR search tests")
httpx = pytest.importorskip("httpx", reason="httpx required for CDR search tests")

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

# Production-shaped cdrs table (05 base + 16 detail + 18 sbc_id columns the
# router selects), same as the authz harness. Plain table — TimescaleDB
# partitioning is irrelevant to filter semantics.
_BASE_SCHEMA = """
CREATE ROLE api LOGIN PASSWORD 'api_secret';

CREATE TABLE cdrs (
  id BIGSERIAL,
  uuid VARCHAR(64) NOT NULL,
  customer_id INT NOT NULL,
  product_type VARCHAR(10) NOT NULL,
  trunk_id INT,
  direction VARCHAR(10) NOT NULL,
  caller_id VARCHAR(30),
  destination VARCHAR(30) NOT NULL,
  destination_prefix VARCHAR(20),
  start_time TIMESTAMPTZ NOT NULL,
  answer_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ NOT NULL,
  duration_ms INT NOT NULL DEFAULT 0,
  billable_ms INT NOT NULL DEFAULT 0,
  rate_per_min DECIMAL(10,6),
  total_cost DECIMAL(12,6) DEFAULT 0,
  carrier_cost DECIMAL(12,6) DEFAULT 0,
  margin DECIMAL(12,6) DEFAULT 0,
  rated_at TIMESTAMPTZ,
  hangup_cause VARCHAR(50),
  sip_code INT,
  carrier_used VARCHAR(50),
  traffic_grade VARCHAR(10),
  fraud_score SMALLINT DEFAULT 0,
  fraud_flags JSONB,
  freeswitch_node VARCHAR(50),
  mos NUMERIC(3,2),
  quality_pct NUMERIC(5,2),
  jitter_min_ms NUMERIC(8,3),
  jitter_max_ms NUMERIC(8,3),
  jitter_avg_ms NUMERIC(8,3),
  packet_loss_count INTEGER,
  packet_total_count INTEGER,
  packet_loss_pct NUMERIC(5,2),
  flaw_total INTEGER,
  r_factor NUMERIC(5,2),
  rtp_audio_in_raw_bytes BIGINT,
  rtp_audio_in_media_bytes BIGINT,
  rtp_audio_out_raw_bytes BIGINT,
  rtp_audio_out_media_bytes BIGINT,
  rtp_audio_in_packet_count INTEGER,
  rtp_audio_out_packet_count INTEGER,
  rtp_audio_in_jitter_burst_rate NUMERIC(8,4),
  rtp_audio_in_jitter_loss_rate NUMERIC(8,4),
  rtp_audio_in_mean_interval NUMERIC(8,3),
  read_codec VARCHAR(20),
  write_codec VARCHAR(20),
  read_rate INTEGER,
  write_rate INTEGER,
  sip_from_user VARCHAR(64),
  sip_to_user VARCHAR(64),
  hangup_cause_q850 SMALLINT,
  sip_hangup_disposition VARCHAR(30),
  sip_user_agent VARCHAR(128),
  network_addr VARCHAR(45),
  bridge_uuid VARCHAR(64),
  sbc_id VARCHAR(30),
  PRIMARY KEY (id, start_time));

GRANT ALL ON cdrs TO api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO api;
"""


class _EphemeralPG:
    def __init__(self, pg_bin):
        self.pg_bin = pg_bin
        self.tmp = tempfile.mkdtemp(prefix="revup_cdrsearch_pg.")
        self.data = os.path.join(self.tmp, "data")
        self.sock = os.path.join(self.tmp, "sock")
        os.makedirs(self.sock, exist_ok=True)
        # distinct from payments (55432-55434) + authz (55435) + carrier
        # trunks (55436) + did-intake (55437)
        self.port = 55438

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

# Tenants (no FK on cdrs.customer_id — plain ints, like production ingest).
CID_A, CID_B = 101, 202
TRUNK_A = 71

# Seeded CDR uuids. NOW is fixed at fixture setup with microsecond=0 so
# Z-formatted boundary strings can hit rows EXACTLY (inclusivity test).
CDR_CUST0 = "cdr-cust0-0001"      # customer_id=0 (unmatched), east-sbc-1, -30m
CDR_EAST1 = "cdr-east-0001"       # A, east-sbc-1, outbound trunk (trunk 71), -1h
CDR_EAST2 = "cdr-east-0002"       # B, east-sbc-2, inbound rcf, RATED, -2h
CDR_WEST1 = "cdr-west-0001"       # A, west-sbc-1, inbound rcf, -3h
CDR_CENT1 = "cdr-central-0001"    # A, central-sbc-1, outbound api, -4h
CDR_NOSBC = "cdr-nosbc-0001"      # A, NULL sbc_id (pre-migration-18), -5h
CDR_OLD = "cdr-old-0001"          # A, east-sbc-1, -3 DAYS (in 7d, out of 24h)
CDR_ANCIENT = "cdr-ancient-0001"  # B, west-sbc-2, -10 DAYS (out of 7d too)

IN_WINDOW = {CDR_CUST0, CDR_EAST1, CDR_EAST2, CDR_WEST1, CDR_CENT1, CDR_NOSBC}


@pytest.fixture(scope="module")
def search_db():
    """Boot PG, apply the cdrs schema, seed the filter matrix."""
    if PG_BIN is None:
        pytest.skip("no local PostgreSQL binaries; set TEST_PG_BIN to run CDR search tests")
    pg = _EphemeralPG(PG_BIN)
    try:
        pg.start()
    except Exception as e:  # noqa: BLE001
        pg.stop()
        pytest.skip(f"could not start throwaway PostgreSQL: {e}")

    from db import database as db  # noqa: E402

    now = datetime.now(timezone.utc).replace(microsecond=0)
    state = {"db": db, "now": now}

    async def _setup():
        owner = await asyncpg.create_pool(
            host=pg.sock, port=pg.port, user="postgres", database="postgres",
            min_size=1, max_size=2, statement_cache_size=0)
        async with owner.acquire() as conn:
            await conn.execute(_BASE_SCHEMA)

            async def seed(uuid, cid, sbc, direction, product, dest, start,
                           trunk=None, rated=False):
                await conn.execute(
                    "INSERT INTO cdrs (uuid, customer_id, product_type, trunk_id,"
                    " direction, caller_id, destination, start_time, answer_time,"
                    " end_time, duration_ms, billable_ms, hangup_cause, sip_code,"
                    " sbc_id, rated_at, rate_per_min, total_cost) "
                    "VALUES ($1, $2, $3, $4, $5, '+16175551000', $6, $7, $8, $9,"
                    " 60000, 57000, 'NORMAL_CLEARING', 200, $10, $11, $12, $13)",
                    uuid, cid, product, trunk, direction, dest,
                    start, start + timedelta(seconds=3), start + timedelta(seconds=63),
                    sbc,
                    (start + timedelta(minutes=5)) if rated else None,
                    "0.010000" if rated else None,
                    "0.010000" if rated else "0",
                )

            await seed(CDR_CUST0, 0, "east-sbc-1", "inbound", "trunk",
                       "+17175556666", now - timedelta(minutes=30))
            await seed(CDR_EAST1, CID_A, "east-sbc-1", "outbound", "trunk",
                       "+12125551111", now - timedelta(hours=1), trunk=TRUNK_A)
            await seed(CDR_EAST2, CID_B, "east-sbc-2", "inbound", "rcf",
                       "+13135552222", now - timedelta(hours=2), rated=True)
            await seed(CDR_WEST1, CID_A, "west-sbc-1", "inbound", "rcf",
                       "+14145553333", now - timedelta(hours=3))
            await seed(CDR_CENT1, CID_A, "central-sbc-1", "outbound", "api",
                       "+15155554444", now - timedelta(hours=4))
            await seed(CDR_NOSBC, CID_A, None, "outbound", "trunk",
                       "+16165555555", now - timedelta(hours=5))
            await seed(CDR_OLD, CID_A, "east-sbc-1", "outbound", "trunk",
                       "+12125559999", now - timedelta(days=3))
            await seed(CDR_ANCIENT, CID_B, "west-sbc-2", "inbound", "rcf",
                       "+14145559999", now - timedelta(days=10))
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
def client(search_db):
    """httpx client over the REAL cdrs router behind the REAL JWT middleware."""
    from fastapi import FastAPI
    from middleware.auth import JWTAuthMiddleware
    from routers import cdrs

    app = FastAPI()
    app.add_middleware(JWTAuthMiddleware)
    app.include_router(cdrs.router, prefix="/v1/cdrs")

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    c = httpx.AsyncClient(transport=transport, base_url="http://test")
    try:
        yield c
    finally:
        _run(c.aclose())


@pytest.fixture(scope="module")
def tokens(search_db):
    """Real JWTs per role, minted exactly like POST /auth/login does."""
    from auth.security import create_access_token

    def mint(sub, email, role, customer_id):
        return create_access_token(
            {"sub": sub, "email": email, "role": role, "customer_id": customer_id})

    return {
        "admin": mint("1", "admin@test.local", "admin", None),
        "support": mint("2", "support@test.local", "support", None),
        "user_a": mint("3", "alpha@test.local", "user", CID_A),
    }


def _auth(tokens, role):
    return {"Authorization": f"Bearer {tokens[role]}"}


def _uuids(resp):
    return {c["uuid"] for c in resp.json()["cdrs"]}


def _total(resp):
    return sum(row["total_calls"] for row in resp.json()["summary"])


def _z(dt):
    """UTC ISO string with the 'Z' suffix — exactly what the rebuilt UI sends."""
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# 1) zone filter — records endpoint (per-zone in/out, NULL sbc_id excluded).
# ---------------------------------------------------------------------------
def test_zone_filter_records_per_zone(client, tokens):
    async def go():
        hdrs = _auth(tokens, "admin")
        r = await client.get("/v1/cdrs", params={"zone": "east"}, headers=hdrs)
        assert r.status_code == 200, r.text
        assert _uuids(r) == {CDR_CUST0, CDR_EAST1, CDR_EAST2}

        r = await client.get("/v1/cdrs", params={"zone": "west"}, headers=hdrs)
        assert r.status_code == 200, r.text
        assert _uuids(r) == {CDR_WEST1}  # ancient west row is outside 24h

        r = await client.get("/v1/cdrs", params={"zone": "central"}, headers=hdrs)
        assert r.status_code == 200, r.text
        assert _uuids(r) == {CDR_CENT1}

    _run(go())


def test_zone_filter_excludes_null_sbc_rows(client, tokens):
    """NULL-sbc_id rows appear WITHOUT a zone filter, never WITH one."""
    async def go():
        hdrs = _auth(tokens, "admin")
        r = await client.get("/v1/cdrs", headers=hdrs)
        assert r.status_code == 200, r.text
        assert _uuids(r) == IN_WINDOW  # default 24h window, NULL sbc included

        for zone in ("east", "west", "central"):
            r = await client.get("/v1/cdrs", params={"zone": zone}, headers=hdrs)
            assert CDR_NOSBC not in _uuids(r), f"NULL sbc_id row leaked into zone={zone}"

    _run(go())


def test_zone_validation_422_both_endpoints(client, tokens):
    """Contract: zone is validated east|west|central — 422 on ANYTHING else."""
    async def go():
        hdrs = _auth(tokens, "admin")
        for bad in ("chaos", "EAST", "east-sbc-1", "north"):
            r = await client.get("/v1/cdrs", params={"zone": bad}, headers=hdrs)
            assert r.status_code == 422, f"records zone={bad}: {r.status_code} {r.text}"
            r = await client.get("/v1/cdrs/summary", params={"zone": bad}, headers=hdrs)
            assert r.status_code == 422, f"summary zone={bad}: {r.status_code} {r.text}"

    _run(go())


def test_zone_composes_with_sbc_id_backcompat(client, tokens):
    """sbc_id (exact, back-compat) still works and ANDs with zone."""
    async def go():
        hdrs = _auth(tokens, "admin")
        r = await client.get("/v1/cdrs", params={"sbc_id": "east-sbc-1"}, headers=hdrs)
        assert r.status_code == 200, r.text
        assert _uuids(r) == {CDR_CUST0, CDR_EAST1}

        r = await client.get(
            "/v1/cdrs", params={"zone": "east", "sbc_id": "east-sbc-1"}, headers=hdrs)
        assert _uuids(r) == {CDR_CUST0, CDR_EAST1}

        # Contradictory combination is honestly empty, not ignored.
        r = await client.get(
            "/v1/cdrs", params={"zone": "west", "sbc_id": "east-sbc-1"}, headers=hdrs)
        assert _uuids(r) == set()

    _run(go())


# ---------------------------------------------------------------------------
# 2) Explicit date ranges — the "filters don't do anything" production class.
# ---------------------------------------------------------------------------
def test_explicit_date_range_honored_records(search_db, client, tokens):
    async def go():
        hdrs = _auth(tokens, "admin")
        now = search_db["now"]
        r = await client.get("/v1/cdrs", params={
            "start_date": _z(now - timedelta(hours=3, minutes=30)),
            "end_date": _z(now - timedelta(hours=2, minutes=30)),
        }, headers=hdrs)
        assert r.status_code == 200, r.text
        assert _uuids(r) == {CDR_WEST1}  # rows outside the range are EXCLUDED

    _run(go())


def test_date_range_bounds_inclusive_both_ends(search_db, client, tokens):
    """start_time >= start AND start_time <= end: a row exactly ON either
    bound is returned (start_date == end_date == the row's start_time)."""
    async def go():
        hdrs = _auth(tokens, "admin")
        west1_ts = search_db["now"] - timedelta(hours=3)
        r = await client.get("/v1/cdrs", params={
            "start_date": _z(west1_ts), "end_date": _z(west1_ts),
        }, headers=hdrs)
        assert r.status_code == 200, r.text
        assert _uuids(r) == {CDR_WEST1}

    _run(go())


def test_default_and_explicit_windows_records(search_db, client, tokens):
    async def go():
        hdrs = _auth(tokens, "admin")
        now = search_db["now"]
        # Default 24h: OLD (-3d) and ANCIENT (-10d) excluded.
        r = await client.get("/v1/cdrs", headers=hdrs)
        assert _uuids(r) == IN_WINDOW
        # Explicit 8-day window widens past the default: OLD in, ANCIENT out.
        r = await client.get("/v1/cdrs", params={
            "start_date": _z(now - timedelta(days=8)), "end_date": _z(now),
        }, headers=hdrs)
        assert _uuids(r) == IN_WINDOW | {CDR_OLD}

    _run(go())


def test_naive_datetime_treated_as_utc(search_db, client, tokens):
    """A bare ISO string (no Z/offset) is pinned to UTC — identical results
    to the same instant sent with an explicit Z suffix."""
    async def go():
        hdrs = _auth(tokens, "admin")
        now = search_db["now"]
        start = now - timedelta(hours=3, minutes=30)
        end = now - timedelta(hours=2, minutes=30)

        aware = await client.get("/v1/cdrs", params={
            "start_date": _z(start), "end_date": _z(end)}, headers=hdrs)
        naive = await client.get("/v1/cdrs", params={
            "start_date": start.replace(tzinfo=None).isoformat(),
            "end_date": end.replace(tzinfo=None).isoformat()}, headers=hdrs)
        assert naive.status_code == 200, naive.text
        assert _uuids(naive) == _uuids(aware) == {CDR_WEST1}

    _run(go())


# ---------------------------------------------------------------------------
# 3) Existing record filters still applied (none accepted-but-ignored).
# ---------------------------------------------------------------------------
def test_records_existing_filters_still_applied(client, tokens):
    async def go():
        hdrs = _auth(tokens, "admin")
        cases = [
            ({"direction": "outbound"}, {CDR_EAST1, CDR_CENT1, CDR_NOSBC}),
            ({"product_type": "rcf"}, {CDR_EAST2, CDR_WEST1}),
            ({"destination": "+1313"}, {CDR_EAST2}),
            ({"rated_only": "true"}, {CDR_EAST2}),
            ({"trunk_id": TRUNK_A}, {CDR_EAST1}),
            ({"customer_id": CID_B}, {CDR_EAST2}),
        ]
        for params, expected in cases:
            r = await client.get("/v1/cdrs", params=params, headers=hdrs)
            assert r.status_code == 200, f"{params}: {r.text}"
            assert _uuids(r) == expected, f"{params}: got {_uuids(r)}"

    _run(go())


def test_customer_id_zero_filter_applied(client, tokens):
    """customer_id=0 (ingest default for unmatched calls) must FILTER, not be
    dropped by truthiness and return the whole platform."""
    async def go():
        r = await client.get("/v1/cdrs", params={"customer_id": 0},
                             headers=_auth(tokens, "admin"))
        assert r.status_code == 200, r.text
        assert _uuids(r) == {CDR_CUST0}

    _run(go())


def test_destination_prefix_is_literal_not_wildcard(client, tokens):
    """LIKE metachars in the destination input are escaped: '%' used to match
    EVERY row; now it matches only destinations literally starting with '%'."""
    async def go():
        hdrs = _auth(tokens, "admin")
        r = await client.get("/v1/cdrs", params={"destination": "%"}, headers=hdrs)
        assert r.status_code == 200, r.text
        assert _uuids(r) == set()
        r = await client.get("/v1/cdrs", params={"destination": "_1717"}, headers=hdrs)
        assert _uuids(r) == set()
        # Normal literal prefixes are unaffected.
        r = await client.get("/v1/cdrs", params={"destination": "+1717"}, headers=hdrs)
        assert _uuids(r) == {CDR_CUST0}

    _run(go())


def test_pagination_and_param_validation(client, tokens):
    async def go():
        hdrs = _auth(tokens, "admin")
        # Deterministic ORDER BY start_time DESC walk.
        r = await client.get("/v1/cdrs", params={"limit": 2}, headers=hdrs)
        assert [c["uuid"] for c in r.json()["cdrs"]] == [CDR_CUST0, CDR_EAST1]
        assert r.json()["count"] == 2 and r.json()["limit"] == 2
        r = await client.get("/v1/cdrs", params={"limit": 2, "offset": 2}, headers=hdrs)
        assert [c["uuid"] for c in r.json()["cdrs"]] == [CDR_EAST2, CDR_WEST1]

        # Bad pagination is a 422 now, not an asyncpg 500.
        for params in ({"offset": -1}, {"limit": -5}, {"limit": 1001}):
            r = await client.get("/v1/cdrs", params=params, headers=hdrs)
            assert r.status_code == 422, f"{params}: {r.status_code} {r.text}"

    _run(go())


# ---------------------------------------------------------------------------
# 4) Summary — same filter set, same 24h default, validated group_by.
# ---------------------------------------------------------------------------
def test_summary_default_window_now_24h(client, tokens):
    """CHANGED: summary defaulted to 7 DAYS (inconsistent with records).
    Now both default to 24h — the -3d row no longer inflates the roll-up."""
    async def go():
        r = await client.get("/v1/cdrs/summary", headers=_auth(tokens, "admin"))
        assert r.status_code == 200, r.text
        assert _total(r) == len(IN_WINDOW)  # 6 — old 7d default counted 7

    _run(go())


def test_summary_honors_shared_filters(search_db, client, tokens):
    async def go():
        hdrs = _auth(tokens, "admin")
        now = search_db["now"]
        cases = [
            ({"zone": "east"}, 3),
            ({"zone": "west"}, 1),
            ({"zone": "central"}, 1),
            ({"direction": "outbound"}, 3),
            ({"product_type": "rcf"}, 2),
            ({"destination": "+1313"}, 1),
            ({"rated_only": "true"}, 1),
            ({"sbc_id": "east-sbc-1"}, 2),
            ({"trunk_id": TRUNK_A}, 1),
            ({"customer_id": CID_B}, 1),
            ({"customer_id": 0}, 1),
            ({"start_date": _z(now - timedelta(hours=3, minutes=30)),
              "end_date": _z(now - timedelta(hours=2, minutes=30))}, 1),
            ({"start_date": _z(now - timedelta(days=8)),
              "end_date": _z(now)}, 7),  # explicit range widens past default
        ]
        for params, expected in cases:
            r = await client.get("/v1/cdrs/summary", params=params, headers=hdrs)
            assert r.status_code == 200, f"{params}: {r.text}"
            assert _total(r) == expected, f"{params}: got {_total(r)}"

    _run(go())


def test_summary_group_by_shapes_consistent(client, tokens):
    async def go():
        hdrs = _auth(tokens, "admin")
        for group_by in ("day", "hour", "destination"):
            r = await client.get("/v1/cdrs/summary", params={"group_by": group_by},
                                 headers=hdrs)
            assert r.status_code == 200, f"{group_by}: {r.text}"
            assert r.json()["group_by"] == group_by
            assert _total(r) == len(IN_WINDOW)
        # Unknown group_by is a 422 now (previously fell through to hourly).
        r = await client.get("/v1/cdrs/summary", params={"group_by": "week"}, headers=hdrs)
        assert r.status_code == 422, r.text

    _run(go())


# ---------------------------------------------------------------------------
# 5) Scoping preserved — tenants hard-scoped, support/admin platform-wide.
# ---------------------------------------------------------------------------
def test_tenant_scoping_preserved_records(client, tokens):
    async def go():
        hdrs = _auth(tokens, "user_a")
        r = await client.get("/v1/cdrs", headers=hdrs)
        assert r.status_code == 200, r.text
        assert _uuids(r) == {CDR_EAST1, CDR_WEST1, CDR_CENT1, CDR_NOSBC}

        # Requested customer_id is IGNORED for tenants (forced to their own).
        r = await client.get("/v1/cdrs", params={"customer_id": CID_B}, headers=hdrs)
        assert _uuids(r) == {CDR_EAST1, CDR_WEST1, CDR_CENT1, CDR_NOSBC}

        # zone composes WITH the tenant scope, never widens it.
        r = await client.get("/v1/cdrs", params={"zone": "east"}, headers=hdrs)
        assert _uuids(r) == {CDR_EAST1}  # B's east row + cust0 invisible

    _run(go())


def test_tenant_scoping_preserved_summary(client, tokens):
    async def go():
        hdrs = _auth(tokens, "user_a")
        r = await client.get("/v1/cdrs/summary", headers=hdrs)
        assert r.status_code == 200, r.text
        assert _total(r) == 4  # A's in-window rows only

        r = await client.get("/v1/cdrs/summary", params={"customer_id": CID_B}, headers=hdrs)
        assert _total(r) == 4  # override ignored

        r = await client.get("/v1/cdrs/summary", params={"zone": "east"}, headers=hdrs)
        assert _total(r) == 1

    _run(go())


def test_support_platform_wide_with_zone(client, tokens):
    async def go():
        hdrs = _auth(tokens, "support")
        r = await client.get("/v1/cdrs", params={"zone": "east"}, headers=hdrs)
        assert r.status_code == 200, r.text
        # Cross-customer: A's, B's and the unmatched customer-0 east rows.
        assert _uuids(r) == {CDR_CUST0, CDR_EAST1, CDR_EAST2}

        r = await client.get("/v1/cdrs/summary", params={"zone": "east"}, headers=hdrs)
        assert r.status_code == 200, r.text
        assert _total(r) == 3

    _run(go())


# ---------------------------------------------------------------------------
# 6) `total` — real pagination: COUNT(*) over the SAME filters, scope included.
# ---------------------------------------------------------------------------
def test_total_present_and_correct_with_filters(search_db, client, tokens):
    """`total` rides the shared filter builder — zone / customer / explicit
    date ranges shape it exactly like the rows they return. Response keys are
    the pinned contract: count/offset/limit unchanged, total added."""
    async def go():
        hdrs = _auth(tokens, "admin")
        now = search_db["now"]

        # Default 24h window: page holds everything, so count == total here.
        r = await client.get("/v1/cdrs", headers=hdrs)
        assert r.status_code == 200, r.text
        body = r.json()
        assert set(body.keys()) == {"cdrs", "count", "total", "offset", "limit"}
        assert body["total"] == len(IN_WINDOW)
        assert body["count"] == len(IN_WINDOW)

        cases = [
            ({"zone": "east"}, 3),
            ({"zone": "west"}, 1),
            ({"zone": "central"}, 1),
            ({"customer_id": CID_B}, 1),
            ({"customer_id": 0}, 1),  # ingest-default filter counts too
            ({"start_date": _z(now - timedelta(hours=3, minutes=30)),
              "end_date": _z(now - timedelta(hours=2, minutes=30))}, 1),
            ({"start_date": _z(now - timedelta(days=8)),
              "end_date": _z(now)}, 7),  # widened range pulls in the -3d row
        ]
        for params, expected in cases:
            r = await client.get("/v1/cdrs", params=params, headers=hdrs)
            assert r.status_code == 200, f"{params}: {r.text}"
            body = r.json()
            assert body["total"] == expected, f"{params}: got {body['total']}"
            assert body["count"] == len(body["cdrs"])  # back-compat semantic

    _run(go())


def test_total_unaffected_by_limit_offset(client, tokens):
    """total is the filtered COUNT(*) — identical on EVERY page (including an
    empty page past the end and limit=0); count remains the page size."""
    async def go():
        hdrs = _auth(tokens, "admin")
        expected_total = len(IN_WINDOW)  # 6

        for offset in (0, 2, 4):
            r = await client.get("/v1/cdrs", params={"limit": 2, "offset": offset},
                                 headers=hdrs)
            assert r.status_code == 200, r.text
            assert r.json()["total"] == expected_total, f"offset={offset}"
            assert r.json()["count"] == 2, f"offset={offset}"

        # Past the end: empty page, total unchanged.
        r = await client.get("/v1/cdrs", params={"limit": 2, "offset": 100}, headers=hdrs)
        assert r.json()["cdrs"] == [] and r.json()["count"] == 0
        assert r.json()["total"] == expected_total

        # limit=0 proves total comes from COUNT(*), never from the page.
        r = await client.get("/v1/cdrs", params={"limit": 0}, headers=hdrs)
        assert r.json()["count"] == 0 and r.json()["total"] == expected_total

        # Filter + pagination compose: zone=east has 3 rows, page 2 of size 1.
        r = await client.get("/v1/cdrs", params={"zone": "east", "limit": 1, "offset": 1},
                             headers=hdrs)
        assert r.json()["count"] == 1 and r.json()["total"] == 3

    _run(go())


def test_total_respects_tenant_scoping(client, tokens):
    """Tenant A's total NEVER counts B's (or customer-0's) rows — the COUNT
    reuses the where clause built AFTER the customer_filter override, so the
    requested customer_id param cannot widen it either."""
    async def go():
        hdrs = _auth(tokens, "user_a")

        r = await client.get("/v1/cdrs", headers=hdrs)
        assert r.status_code == 200, r.text
        assert r.json()["total"] == 4  # A's in-window rows only (of 6 platform-wide)

        # Requested customer_id=B is IGNORED for tenants — in total too.
        r = await client.get("/v1/cdrs", params={"customer_id": CID_B}, headers=hdrs)
        assert r.json()["total"] == 4

        # Scope composes with filters: east has 3 rows platform-wide, A owns 1.
        r = await client.get("/v1/cdrs", params={"zone": "east"}, headers=hdrs)
        assert r.json()["total"] == 1

        # Scoped total is page-independent as well.
        r = await client.get("/v1/cdrs", params={"limit": 1, "offset": 1}, headers=hdrs)
        assert r.json()["count"] == 1 and r.json()["total"] == 4

        # support stays platform-wide (read-only troubleshooting scope).
        r = await client.get("/v1/cdrs", params={"zone": "east"},
                             headers=_auth(tokens, "support"))
        assert r.json()["total"] == 3

    _run(go())


def test_total_respects_rated_only(client, tokens):
    async def go():
        hdrs = _auth(tokens, "admin")
        r = await client.get("/v1/cdrs", params={"rated_only": "true"}, headers=hdrs)
        assert r.status_code == 200, r.text
        assert r.json()["total"] == 1  # only the rated east row is in-window
        assert _uuids(r) == {CDR_EAST2}

        # rated_only + limit=0: empty page, total still counts the rated row.
        r = await client.get("/v1/cdrs", params={"rated_only": "true", "limit": 0},
                             headers=hdrs)
        assert r.json()["count"] == 0 and r.json()["total"] == 1

    _run(go())
