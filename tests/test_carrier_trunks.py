"""Carrier trunk registry (migration 40 + /v1/carrier-trunks) — full-stack tests.

Proves, over the REAL router behind the REAL JWTAuthMiddleware on an ephemeral
local PostgreSQL:

  * migration 40_carrier_trunks.sql applies idempotently (twice) on top of the
    real 25_carrier_trunk_status.sql, seeds the 4 production rows exactly once,
    and widens the carrier_trunk_health setid filter to (2,3,6,7);
  * migration 42_carrier_priorities.sql applies idempotently (twice), lands
    the guarded seed priorities (East/Central prefer Dallas, West prefers LA),
    and NEVER clobbers operator-edited priorities on re-run;
  * priority CRUD: create defaults (100 / NULL overrides), full round-trip,
    partial update incl. clearing a zone override with explicit null, >=1
    validation, and priority itself is not nullable;
  * THE FS TERMINATION CONTRACT: the literal per-zone SQL the FreeSWITCH
    outbound carrier-failover Lua runs (SELECT carrier, pop, host(source_ip)
    AS term_ip, COALESCE(priority_<z>, priority) AS eff_priority FROM
    carrier_trunks WHERE direction IN ('outbound','both') AND enabled = true
    ORDER BY eff_priority, id) — executed AS THE `freeswitch` DB ROLE for
    east/west/central: Bandwidth-only in today's per-zone order, Sinch
    (direction='inbound') structurally absent, disabling Dallas from the
    admin tool collapses every zone to LA (redundancy-from-the-table), and
    flipping Sinch Denver to direction='both' opts it in by priority;
  * admin CRUD happy path (create / list+filters / get / partial update /
    delete), 409 on duplicate source_ip and duplicate (carrier, pop),
    422/400 on bad IP / bad direction / bad cps_limit;
  * support and tenant users get 403 on EVERY route (admin-only surface);
  * THE SBC CONTRACT: the literal sqlops SELECT the Kamailio config runs
    (SELECT carrier, pop, cps_limit FROM carrier_trunks WHERE source_ip =
    '<$si>'::inet AND direction IN ('inbound','both') AND enabled = true)
    returns the seeded Sinch Denver row — executed AS THE `freeswitch` DB ROLE
    (the role Kamailio's sqlops connects with), which also proves the GRANT;
    disabled and outbound-only rows are excluded; the role cannot write;
  * CDR ingest attribution: POST /v1/cdrs/ingest with
    variables.inbound_carrier/inbound_carrier_pop stores the values in the two
    cdrs columns migration 40 added; absent vars store NULL.

Harness mirrors tests/test_support_role_authz.py (ephemeral local PG, module
event loop, db.pool wired as the runtime `api` role, REAL minted JWTs through
the REAL middleware).

Run:  JWT_SECRET_KEY=x python3 -m pytest tests/test_carrier_trunks.py -q
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

asyncpg = pytest.importorskip("asyncpg", reason="asyncpg required for carrier-trunk tests")
httpx = pytest.importorskip("httpx", reason="httpx required for carrier-trunk tests")

REPO = Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
MIG_TRUNK_STATUS = REPO / "docker" / "postgres" / "init" / "25_carrier_trunk_status.sql"
MIG_CARRIER_TRUNKS = REPO / "docker" / "postgres" / "init" / "40_carrier_trunks.sql"
MIG_CARRIER_PRIORITIES = REPO / "docker" / "postgres" / "init" / "42_carrier_priorities.sql"

sys.path.insert(0, str(API_SRC))

# The EXACT sqlops lookup from the Kamailio SBC config, with $si rendered the
# way sqlops does (string substitution into the quoted literal). If the table
# or column names drift, THIS is the test that must fail.
SBC_CONTRACT_SQL = (
    "SELECT carrier, pop, cps_limit FROM carrier_trunks "
    "WHERE source_ip = '{si}'::inet "
    "AND direction IN ('inbound','both') AND enabled = true"
)

# The EXACT per-zone termination-selection SQL the FreeSWITCH outbound
# carrier-failover Lua runs ({zone} in east/west/central — migration 42
# contract). If the table or column names drift, THIS test must fail.
TERM_CONTRACT_SQL = (
    "SELECT carrier, pop, host(source_ip) AS term_ip, "
    "COALESCE(priority_{zone}, priority) AS eff_priority "
    "FROM carrier_trunks "
    "WHERE direction IN ('outbound','both') AND enabled = true "
    "ORDER BY eff_priority, id"
)

ZONES = ("east", "west", "central")


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

# Roles + the tables migrations 25/40 and the ingest INSERT need. `cdrs` is a
# plain table (no TimescaleDB — partitioning is irrelevant here) carrying every
# column of the ingest INSERT EXCEPT inbound_carrier/inbound_carrier_pop: those
# two must come from migration 40's ALTERs, proving the migration wires the
# ingest end-to-end.
_BASE_SCHEMA = """
CREATE ROLE api LOGIN PASSWORD 'api_secret';
CREATE ROLE freeswitch LOGIN;         -- Kamailio sqlops role (DB_USER default)
CREATE ROLE grafana_ro;               -- granted on the health view by 25/40

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
  origin_customer_id INT,
  terminating_customer_id INT,
  on_net BOOLEAN DEFAULT false,
  on_net_hops SMALLINT,
  PRIMARY KEY (id, start_time));

CREATE TABLE call_attestations (
  call_id            TEXT PRIMARY KEY,
  customer_id        INT NOT NULL,
  signed_attestation TEXT,
  attest_intent      TEXT,
  inbound_signed     BOOLEAN,
  inbound_attest     TEXT,
  inbound_verstat    TEXT,
  verstat_source     TEXT,
  sip_call_id        TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now());

-- Stub for migration 42's did_inventory ALTER + carrier backfill (same
-- pattern as test_did_intake.py's cdrs stub for 40): only the columns 42
-- touches. carrier_trunk_id mirrors 41's column (plain INT — carrier_trunks
-- doesn't exist yet at base-schema time; the FK is 41's concern, proven in
-- test_did_intake.py along with the real inventory behavior).
CREATE TABLE did_inventory (
  id SERIAL PRIMARY KEY,
  did VARCHAR(20) NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'available',
  carrier_trunk_id INT);

GRANT ALL ON cdrs, call_attestations, did_inventory TO api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO api;
"""


class _EphemeralPG:
    def __init__(self, pg_bin):
        self.pg_bin = pg_bin
        self.tmp = tempfile.mkdtemp(prefix="revup_ctrunks_pg.")
        self.data = os.path.join(self.tmp, "data")
        self.sock = os.path.join(self.tmp, "sock")
        os.makedirs(self.sock, exist_ok=True)
        self.port = 55436  # distinct from payments (55432-55434) + authz (55435)

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


# Seeded production facts (must match the migration 40 seed block).
SEEDS = {
    ("bandwidth", "dallas"):  {"source_ip": "67.231.2.12",    "trunk_group": None,
                               "test_tn": None,          "direction": "both"},
    ("bandwidth", "la"):      {"source_ip": "216.82.238.134", "trunk_group": None,
                               "test_tn": None,          "direction": "both"},
    ("sinch",     "denver"):  {"source_ip": "206.146.100.24", "trunk_group": "DNVTCOZIGR2_3278",
                               "test_tn": "5305480845",  "direction": "inbound"},
    ("sinch",     "chicago"): {"source_ip": "206.146.101.39", "trunk_group": "CHCGIL24GR4_7412",
                               "test_tn": "5305480846",  "direction": "inbound"},
}


@pytest.fixture(scope="module")
def trunks_db():
    """Boot PG, apply base schema + REAL 25 + REAL 40 + REAL 42 (each of the
    latter twice — idempotency)."""
    if PG_BIN is None:
        pytest.skip("no local PostgreSQL binaries; set TEST_PG_BIN to run carrier-trunk tests")
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
            # Prerequisite the view replace amends: the REAL 25 (fresh-install
            # path — already carries the (2,3,6,7) filter after the amend).
            await conn.execute(MIG_TRUNK_STATUS.read_text())
            # The REAL migrations under test — each applied twice (idempotent;
            # 40's seed block must not duplicate rows, 42's guarded priority
            # seeds must not re-fire on the second pass).
            await conn.execute(MIG_CARRIER_TRUNKS.read_text())
            await conn.execute(MIG_CARRIER_TRUNKS.read_text())
            await conn.execute(MIG_CARRIER_PRIORITIES.read_text())
            await conn.execute(MIG_CARRIER_PRIORITIES.read_text())
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
def client(trunks_db):
    """httpx client over the REAL routers behind the REAL JWT middleware."""
    from fastapi import FastAPI
    from middleware.auth import JWTAuthMiddleware
    from routers import carrier_trunks, cdrs

    app = FastAPI()
    app.add_middleware(JWTAuthMiddleware)
    # Same mounts as main.py (canonical /v1 + legacy).
    app.include_router(carrier_trunks.router, prefix="/v1/carrier-trunks")
    app.include_router(carrier_trunks.router, prefix="/carrier-trunks")
    app.include_router(cdrs.router, prefix="/v1/cdrs")

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    c = httpx.AsyncClient(transport=transport, base_url="http://test")
    try:
        yield c
    finally:
        _run(c.aclose())


@pytest.fixture(scope="module")
def tokens(trunks_db):
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


def _auth(tokens, role):
    return {"Authorization": f"Bearer {tokens[role]}"}


# ---------------------------------------------------------------------------
# 1) Migration — seeds exactly once, view filter widened.
# ---------------------------------------------------------------------------
def test_migration_seeds_exactly_once(trunks_db, client, tokens):
    """Applied twice, the 4 production rows exist exactly once with the real
    values (Bandwidth trunk_group/test_tn NULL, Sinch groups + test TNs)."""
    async def go():
        r = await client.get("/v1/carrier-trunks", headers=_auth(tokens, "admin"))
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["count"] == 4
        by_key = {(t["carrier"], t["pop"]): t for t in body["trunks"]}
        assert set(by_key) == set(SEEDS)
        for key, expect in SEEDS.items():
            row = by_key[key]
            for field, val in expect.items():
                assert row[field] == val, f"{key} {field}: {row[field]!r} != {val!r}"
            assert row["cps_limit"] == 100
            assert row["enabled"] is True

    _run(go())


def test_health_view_setid_filter_widened(trunks_db):
    """carrier_trunk_health (replaced by 40) now admits the Sinch dispatcher
    groups (setid 6/7) and still excludes the unused TC PoPs (4/5)."""
    db = trunks_db["db"]

    async def go():
        await db.execute(
            """
            INSERT INTO carrier_trunk_status (duid, sbc_id, name, ip, setid, is_up)
            VALUES
              ('bw-dallas-primary', 'east-sbc-1', 'Bandwidth Dallas', '67.231.2.12',    2, true),
              ('sinch-denver',      'east-sbc-1', 'Sinch Denver',     '206.146.100.24', 6, true),
              ('sinch-chicago',     'east-sbc-1', 'Sinch Chicago',    '206.146.101.39', 7, false),
              ('bw-tc1-ny',         'east-sbc-1', 'Bandwidth TC1 NY', '198.51.100.1',   4, true)
            ON CONFLICT (duid, sbc_id) DO NOTHING
            """
        )
        rows = await db.fetch_all("SELECT duid, setid, status FROM carrier_trunk_health")
        by_duid = {r["duid"]: dict(r) for r in rows}
        assert "sinch-denver" in by_duid and by_duid["sinch-denver"]["status"] == "up"
        assert "sinch-chicago" in by_duid and by_duid["sinch-chicago"]["status"] == "down"
        assert "bw-dallas-primary" in by_duid
        assert "bw-tc1-ny" not in by_duid  # setid 4 stays structurally excluded

    _run(go())


# ---------------------------------------------------------------------------
# 2) Admin CRUD happy path.
# ---------------------------------------------------------------------------
def test_admin_crud_happy_path(client, tokens):
    async def go():
        hdrs = _auth(tokens, "admin")

        # Create a Sinch-like row.
        r = await client.post("/v1/carrier-trunks", headers=hdrs, json={
            "carrier": "sinch", "pop": "atlanta",
            "trunk_group": "ATLGA99GR1_0001", "source_ip": "206.146.102.50",
            "test_tn": "5305480847", "direction": "inbound",
            "cps_limit": 50, "notes": "turn-up pending",
        })
        assert r.status_code == 200, r.text
        created = r.json()
        trunk_id = created["id"]
        assert created["carrier"] == "sinch"
        assert created["pop"] == "atlanta"
        assert created["source_ip"] == "206.146.102.50"
        assert created["direction"] == "inbound"
        assert created["cps_limit"] == 50
        assert created["enabled"] is True

        # List filters: carrier / direction / enabled.
        r = await client.get("/v1/carrier-trunks?carrier=sinch", headers=hdrs)
        assert r.status_code == 200
        assert {t["pop"] for t in r.json()["trunks"]} == {"denver", "chicago", "atlanta"}

        r = await client.get("/v1/carrier-trunks?direction=both", headers=hdrs)
        assert {t["carrier"] for t in r.json()["trunks"]} == {"bandwidth"}

        r = await client.get("/v1/carrier-trunks?carrier=sinch&direction=inbound&enabled=true",
                             headers=hdrs)
        assert r.json()["count"] == 3

        # Get by id.
        r = await client.get(f"/v1/carrier-trunks/{trunk_id}", headers=hdrs)
        assert r.status_code == 200 and r.json()["pop"] == "atlanta"

        # Partial update: cps + enabled (other fields untouched).
        r = await client.put(f"/v1/carrier-trunks/{trunk_id}", headers=hdrs,
                             json={"cps_limit": 250, "enabled": False})
        assert r.status_code == 200, r.text
        updated = r.json()
        assert updated["cps_limit"] == 250
        assert updated["enabled"] is False
        assert updated["trunk_group"] == "ATLGA99GR1_0001"  # untouched
        assert updated["source_ip"] == "206.146.102.50"      # untouched

        # enabled=false filter now finds it.
        r = await client.get("/v1/carrier-trunks?enabled=false", headers=hdrs)
        assert {t["pop"] for t in r.json()["trunks"]} == {"atlanta"}

        # Delete; then 404.
        r = await client.delete(f"/v1/carrier-trunks/{trunk_id}", headers=hdrs)
        assert r.status_code == 200 and r.json()["status"] == "deleted"
        r = await client.get(f"/v1/carrier-trunks/{trunk_id}", headers=hdrs)
        assert r.status_code == 404

    _run(go())


# ---------------------------------------------------------------------------
# 3) Conflicts + validation.
# ---------------------------------------------------------------------------
def test_409_duplicate_source_ip(client, tokens):
    async def go():
        r = await client.post("/v1/carrier-trunks", headers=_auth(tokens, "admin"), json={
            "carrier": "sinch", "pop": "denver2",
            "source_ip": "206.146.100.24",  # seeded Sinch Denver IP
        })
        assert r.status_code == 409, r.text
        assert "source_ip" in r.json()["detail"]

    _run(go())


def test_409_duplicate_carrier_pop(client, tokens):
    async def go():
        r = await client.post("/v1/carrier-trunks", headers=_auth(tokens, "admin"), json={
            "carrier": "sinch", "pop": "denver",  # seeded pair
            "source_ip": "203.0.113.77",
        })
        assert r.status_code == 409, r.text
        assert "carrier" in r.json()["detail"]

    _run(go())


def test_validation_bad_ip_direction_cps(client, tokens):
    async def go():
        hdrs = _auth(tokens, "admin")
        base = {"carrier": "sinch", "pop": "test", "source_ip": "203.0.113.10"}

        # Bad IP (not parseable) and CIDR (must be a bare address).
        for bad_ip in ("not-an-ip", "206.146.100.0/24", "999.1.1.1"):
            r = await client.post("/v1/carrier-trunks", headers=hdrs,
                                  json={**base, "source_ip": bad_ip})
            assert r.status_code == 422, f"{bad_ip}: {r.status_code} {r.text}"

        # Bad direction enum.
        r = await client.post("/v1/carrier-trunks", headers=hdrs,
                              json={**base, "direction": "sideways"})
        assert r.status_code == 422, r.text

        # cps_limit must be > 0 (create and update).
        r = await client.post("/v1/carrier-trunks", headers=hdrs,
                              json={**base, "cps_limit": 0})
        assert r.status_code == 422, r.text
        r = await client.put("/v1/carrier-trunks/1", headers=hdrs,
                             json={"cps_limit": -5})
        assert r.status_code == 422, r.text

        # Empty-body update is a 400.
        r = await client.put("/v1/carrier-trunks/1", headers=hdrs, json={})
        assert r.status_code == 400, r.text

        # Bad direction on the LIST filter is a 400.
        r = await client.get("/v1/carrier-trunks?direction=sideways", headers=hdrs)
        assert r.status_code == 400, r.text

        # NOTHING invalid got persisted.
        r = await client.get("/v1/carrier-trunks?carrier=sinch", headers=hdrs)
        assert {t["pop"] for t in r.json()["trunks"]} == {"denver", "chicago"}

    _run(go())


# ---------------------------------------------------------------------------
# 4) Authz — admin-only surface: support AND tenant users 403 everywhere.
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("role", ["support", "user"])
def test_non_admin_403_on_all_routes(client, tokens, role):
    async def go():
        hdrs = _auth(tokens, role)
        r = await client.get("/v1/carrier-trunks", headers=hdrs)
        assert r.status_code == 403, f"GET list: {r.status_code} {r.text}"
        r = await client.post("/v1/carrier-trunks", headers=hdrs, json={
            "carrier": "evil", "pop": "pop", "source_ip": "203.0.113.66"})
        assert r.status_code == 403, f"POST: {r.status_code} {r.text}"
        r = await client.get("/v1/carrier-trunks/1", headers=hdrs)
        assert r.status_code == 403, f"GET id: {r.status_code} {r.text}"
        r = await client.put("/v1/carrier-trunks/1", headers=hdrs,
                             json={"enabled": False})
        assert r.status_code == 403, f"PUT: {r.status_code} {r.text}"
        r = await client.delete("/v1/carrier-trunks/1", headers=hdrs)
        assert r.status_code == 403, f"DELETE: {r.status_code} {r.text}"

    _run(go())


def test_no_token_is_401(client):
    async def go():
        r = await client.get("/v1/carrier-trunks")
        assert r.status_code == 401, r.text

    _run(go())


# ---------------------------------------------------------------------------
# 5) THE SBC CONTRACT — the literal Kamailio sqlops SELECT, run as the
#    `freeswitch` DB role (proves column names + the GRANT together).
# ---------------------------------------------------------------------------
def test_sbc_contract_query_as_freeswitch_role(trunks_db):
    pg = trunks_db["pg"]

    async def go():
        conn = await asyncpg.connect(
            host=pg.sock, port=pg.port, user="freeswitch", database="postgres",
            statement_cache_size=0)
        try:
            # Seeded Sinch Denver row comes back with exactly the contract cols.
            rows = await conn.fetch(SBC_CONTRACT_SQL.format(si="206.146.100.24"))
            assert len(rows) == 1
            assert dict(rows[0]) == {"carrier": "sinch", "pop": "denver",
                                     "cps_limit": 100}

            # Bandwidth direction='both' passes the IN ('inbound','both') filter.
            rows = await conn.fetch(SBC_CONTRACT_SQL.format(si="67.231.2.12"))
            assert len(rows) == 1 and rows[0]["carrier"] == "bandwidth"

            # Unknown IP -> 0 rows (SBC keeps treating the source as untrusted).
            rows = await conn.fetch(SBC_CONTRACT_SQL.format(si="203.0.113.200"))
            assert rows == []

            # The grant is SELECT-only: the SBC role can never write the table.
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await conn.execute(
                    "INSERT INTO carrier_trunks (carrier, pop, source_ip) "
                    "VALUES ('rogue', 'rogue', '203.0.113.201')")
        finally:
            await conn.close()

    _run(go())


def test_sbc_contract_excludes_disabled_and_outbound(trunks_db, client, tokens):
    """A disabled row and an outbound-only row are invisible to the SBC query
    (but still present for the admin API)."""
    pg = trunks_db["pg"]

    async def go():
        hdrs = _auth(tokens, "admin")
        # Disabled row.
        r = await client.post("/v1/carrier-trunks", headers=hdrs, json={
            "carrier": "sinch", "pop": "seattle",
            "source_ip": "206.146.103.10", "direction": "inbound",
            "enabled": False,
        })
        assert r.status_code == 200, r.text
        disabled_id = r.json()["id"]
        # Outbound-only row.
        r = await client.post("/v1/carrier-trunks", headers=hdrs, json={
            "carrier": "sinch", "pop": "phoenix",
            "source_ip": "206.146.103.11", "direction": "outbound",
        })
        assert r.status_code == 200, r.text
        outbound_id = r.json()["id"]

        conn = await asyncpg.connect(
            host=pg.sock, port=pg.port, user="freeswitch", database="postgres",
            statement_cache_size=0)
        try:
            assert await conn.fetch(SBC_CONTRACT_SQL.format(si="206.146.103.10")) == []
            assert await conn.fetch(SBC_CONTRACT_SQL.format(si="206.146.103.11")) == []
        finally:
            await conn.close()

        # Re-enabling the disabled row makes it visible to the SBC query.
        r = await client.put(f"/v1/carrier-trunks/{disabled_id}", headers=hdrs,
                             json={"enabled": True})
        assert r.status_code == 200
        conn = await asyncpg.connect(
            host=pg.sock, port=pg.port, user="freeswitch", database="postgres",
            statement_cache_size=0)
        try:
            rows = await conn.fetch(SBC_CONTRACT_SQL.format(si="206.146.103.10"))
            assert len(rows) == 1 and rows[0]["pop"] == "seattle"
        finally:
            await conn.close()

        # Clean up the extra rows (keep later tests over the 4 seeds).
        for tid in (disabled_id, outbound_id):
            r = await client.delete(f"/v1/carrier-trunks/{tid}", headers=hdrs)
            assert r.status_code == 200

    _run(go())


# ---------------------------------------------------------------------------
# 5b) Migration 42 — termination priorities: guarded seeds, operator-edit
#     survival, priority CRUD, and THE FS TERMINATION CONTRACT per zone.
# ---------------------------------------------------------------------------

# Seeded priorities (must match migration 42's guarded UPDATEs). They encode
# TODAY'S per-zone behavior: East/Central prefer Dallas, West prefers LA;
# Sinch has a global order (denver 10, chicago 20) and no zone overrides.
PRIORITY_SEEDS = {
    ("bandwidth", "dallas"):  {"priority": 10, "priority_east": None,
                               "priority_west": 20,   "priority_central": None},
    ("bandwidth", "la"):      {"priority": 20, "priority_east": None,
                               "priority_west": 10,   "priority_central": None},
    ("sinch",     "denver"):  {"priority": 10, "priority_east": None,
                               "priority_west": None, "priority_central": None},
    ("sinch",     "chicago"): {"priority": 20, "priority_east": None,
                               "priority_west": None, "priority_central": None},
}


async def _fetch_term(pg, zone):
    """Run the EXACT FS termination-selection SQL as the `freeswitch` DB role
    (proves the priority-column names + the SELECT grant together)."""
    conn = await asyncpg.connect(
        host=pg.sock, port=pg.port, user="freeswitch", database="postgres",
        statement_cache_size=0)
    try:
        return await conn.fetch(TERM_CONTRACT_SQL.format(zone=zone))
    finally:
        await conn.close()


def test_migration42_seed_priorities(client, tokens):
    """Applied twice (fixture), the guarded seed UPDATEs landed exactly the
    contract priorities on the four production rows — once."""
    async def go():
        r = await client.get("/v1/carrier-trunks", headers=_auth(tokens, "admin"))
        assert r.status_code == 200, r.text
        by_key = {(t["carrier"], t["pop"]): t for t in r.json()["trunks"]}
        assert set(by_key) == set(PRIORITY_SEEDS)
        for key, expect in PRIORITY_SEEDS.items():
            row = by_key[key]
            for field, val in expect.items():
                assert row[field] == val, f"{key} {field}: {row[field]!r} != {val!r}"

    _run(go())


def test_migration42_operator_edit_survives_rerun(trunks_db, client, tokens):
    """An operator-tuned priority is NEVER clobbered by re-running 42: the
    seed UPDATEs are guarded on the column defaults (priority = 100 / touched
    override IS NULL), which no seeded-then-edited row still matches."""
    pg = trunks_db["pg"]

    async def go():
        hdrs = _auth(tokens, "admin")
        r = await client.get("/v1/carrier-trunks", headers=hdrs)
        ids = {(t["carrier"], t["pop"]): t["id"] for t in r.json()["trunks"]}

        # Operator edits through the real API: the global priority on Dallas,
        # and a zone override on Denver (previously NULL).
        r = await client.put(f"/v1/carrier-trunks/{ids[('bandwidth', 'dallas')]}",
                             headers=hdrs, json={"priority": 55})
        assert r.status_code == 200, r.text
        r = await client.put(f"/v1/carrier-trunks/{ids[('sinch', 'denver')]}",
                             headers=hdrs, json={"priority_east": 7})
        assert r.status_code == 200, r.text

        # Re-run the REAL migration as superuser (exactly how prod re-applies).
        conn = await asyncpg.connect(
            host=pg.sock, port=pg.port, user="postgres", database="postgres",
            statement_cache_size=0)
        try:
            await conn.execute(MIG_CARRIER_PRIORITIES.read_text())
        finally:
            await conn.close()

        r = await client.get("/v1/carrier-trunks", headers=hdrs)
        by_key = {(t["carrier"], t["pop"]): t for t in r.json()["trunks"]}
        assert by_key[("bandwidth", "dallas")]["priority"] == 55        # survived
        assert by_key[("bandwidth", "dallas")]["priority_west"] == 20   # untouched
        assert by_key[("sinch", "denver")]["priority_east"] == 7        # survived
        assert by_key[("sinch", "denver")]["priority"] == 10            # untouched
        assert by_key[("bandwidth", "la")]["priority"] == 20            # seed intact
        assert by_key[("bandwidth", "la")]["priority_west"] == 10

        # Restore the seed state for the termination-contract tests below.
        r = await client.put(f"/v1/carrier-trunks/{ids[('bandwidth', 'dallas')]}",
                             headers=hdrs, json={"priority": 10})
        assert r.status_code == 200
        r = await client.put(f"/v1/carrier-trunks/{ids[('sinch', 'denver')]}",
                             headers=hdrs, json={"priority_east": None})
        assert r.status_code == 200 and r.json()["priority_east"] is None

    _run(go())


def test_crud_priority_and_zone_overrides(client, tokens):
    """Create defaults (100/NULLs), full round-trip, partial update incl.
    clearing one zone override with explicit null, >=1 validation, and
    priority itself is not nullable."""
    async def go():
        hdrs = _auth(tokens, "admin")

        # Create with defaults.
        r = await client.post("/v1/carrier-trunks", headers=hdrs, json={
            "carrier": "sinch", "pop": "defaults", "source_ip": "206.146.105.1"})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["priority"] == 100
        assert d["priority_east"] is None and d["priority_west"] is None \
            and d["priority_central"] is None

        # Full round-trip.
        r = await client.post("/v1/carrier-trunks", headers=hdrs, json={
            "carrier": "sinch", "pop": "tuned", "source_ip": "206.146.105.2",
            "priority": 5, "priority_east": 1, "priority_west": 2,
            "priority_central": 3})
        assert r.status_code == 200, r.text
        t = r.json()
        tid = t["id"]
        assert (t["priority"], t["priority_east"], t["priority_west"],
                t["priority_central"]) == (5, 1, 2, 3)
        r = await client.get(f"/v1/carrier-trunks/{tid}", headers=hdrs)
        t = r.json()
        assert (t["priority"], t["priority_east"], t["priority_west"],
                t["priority_central"]) == (5, 1, 2, 3)

        # Partial update: bump priority, clear ONE override with explicit null.
        r = await client.put(f"/v1/carrier-trunks/{tid}", headers=hdrs,
                             json={"priority": 7, "priority_east": None})
        assert r.status_code == 200, r.text
        t = r.json()
        assert t["priority"] == 7
        assert t["priority_east"] is None
        assert t["priority_west"] == 2 and t["priority_central"] == 3  # untouched

        # Validation: every priority must be >= 1; priority is not nullable.
        for bad in ({"priority": 0}, {"priority": -3}, {"priority_west": 0},
                    {"priority_central": -1}, {"priority": None}):
            r = await client.put(f"/v1/carrier-trunks/{tid}", headers=hdrs,
                                 json=bad)
            assert r.status_code == 422, f"{bad}: {r.status_code} {r.text}"
        r = await client.post("/v1/carrier-trunks", headers=hdrs, json={
            "carrier": "sinch", "pop": "badprio", "source_ip": "206.146.105.3",
            "priority": 0})
        assert r.status_code == 422, r.text

        # Clean up (keep the termination tests over the 4 seeds only).
        for cleanup_id in (d["id"], tid):
            r = await client.delete(f"/v1/carrier-trunks/{cleanup_id}",
                                    headers=hdrs)
            assert r.status_code == 200

    _run(go())


def test_termination_contract_per_zone(trunks_db):
    """THE FS TERMINATION CONTRACT: the literal per-zone Lua SQL, run as the
    `freeswitch` DB role, returns the Bandwidth PoPs in TODAY'S order
    (East/Central Dallas-first, West LA-first) with source_ip doubling as
    term_ip — and the Sinch rows (direction='inbound') structurally ABSENT."""
    pg = trunks_db["pg"]

    async def go():
        for zone in ("east", "central"):
            rows = await _fetch_term(pg, zone)
            # dict-equality also pins the CONTRACT column names.
            assert [dict(r) for r in rows] == [
                {"carrier": "bandwidth", "pop": "dallas",
                 "term_ip": "67.231.2.12", "eff_priority": 10},
                {"carrier": "bandwidth", "pop": "la",
                 "term_ip": "216.82.238.134", "eff_priority": 20},
            ], f"zone {zone}"

        rows = await _fetch_term(pg, "west")
        assert [dict(r) for r in rows] == [
            {"carrier": "bandwidth", "pop": "la",
             "term_ip": "216.82.238.134", "eff_priority": 10},
            {"carrier": "bandwidth", "pop": "dallas",
             "term_ip": "67.231.2.12", "eff_priority": 20},
        ]

        # Sinch never terminates while direction='inbound' — in any zone.
        for zone in ZONES:
            rows = await _fetch_term(pg, zone)
            assert all(r["carrier"] != "sinch" for r in rows), zone

    _run(go())


def test_termination_contract_disable_is_failover(trunks_db, client, tokens):
    """Disable Dallas from the admin tool -> every zone's termination list
    collapses to the single LA row on the next query (carrier redundancy is
    operated from the table — no config push). Re-enabling restores today's
    per-zone order."""
    pg = trunks_db["pg"]

    async def go():
        hdrs = _auth(tokens, "admin")
        r = await client.get("/v1/carrier-trunks?carrier=bandwidth", headers=hdrs)
        ids = {t["pop"]: t["id"] for t in r.json()["trunks"]}

        r = await client.put(f"/v1/carrier-trunks/{ids['dallas']}", headers=hdrs,
                             json={"enabled": False})
        assert r.status_code == 200, r.text
        try:
            for zone in ZONES:
                rows = await _fetch_term(pg, zone)
                assert [r2["pop"] for r2 in rows] == ["la"], zone
        finally:
            r = await client.put(f"/v1/carrier-trunks/{ids['dallas']}",
                                 headers=hdrs, json={"enabled": True})
            assert r.status_code == 200

        rows = await _fetch_term(pg, "east")
        assert [r2["pop"] for r2 in rows] == ["dallas", "la"]

    _run(go())


def test_termination_contract_sinch_optin_by_direction(trunks_db, client, tokens):
    """Flip Sinch Denver to direction='both' -> it joins every zone's
    termination list ordered by priority (eff 10; `id` breaks the tie with
    the same-priority Bandwidth row). Turning a carrier's termination on is a
    table edit, not a code change. Restored to 'inbound' after."""
    pg = trunks_db["pg"]

    async def go():
        hdrs = _auth(tokens, "admin")
        r = await client.get("/v1/carrier-trunks", headers=hdrs)
        ids = {(t["carrier"], t["pop"]): t["id"] for t in r.json()["trunks"]}
        # 40 seeds with a single INSERT, so ids follow its VALUES order:
        # dallas < la < denver — the ORDER BY eff_priority, id tiebreak below
        # depends on that.
        assert ids[("bandwidth", "dallas")] < ids[("bandwidth", "la")] \
            < ids[("sinch", "denver")]

        r = await client.put(f"/v1/carrier-trunks/{ids[('sinch', 'denver')]}",
                             headers=hdrs, json={"direction": "both"})
        assert r.status_code == 200, r.text
        try:
            # East/Central: dallas(10) then denver(10, higher id) then la(20).
            for zone in ("east", "central"):
                rows = await _fetch_term(pg, zone)
                assert [(r2["pop"], r2["eff_priority"]) for r2 in rows] == [
                    ("dallas", 10), ("denver", 10), ("la", 20)], zone
            # West: la(10, override) then denver(10, higher id) then dallas(20).
            rows = await _fetch_term(pg, "west")
            assert [(r2["pop"], r2["eff_priority"]) for r2 in rows] == [
                ("la", 10), ("denver", 10), ("dallas", 20)]
        finally:
            r = await client.put(f"/v1/carrier-trunks/{ids[('sinch', 'denver')]}",
                                 headers=hdrs, json={"direction": "inbound"})
            assert r.status_code == 200

    _run(go())


# ---------------------------------------------------------------------------
# 6) CDR ingest — inbound-carrier attribution lands in the migrated columns.
# ---------------------------------------------------------------------------
def _ingest_payload(uuid, extra_vars=None):
    variables = {
        "uuid": uuid,
        "direction": "inbound",
        "product_type": "rcf",
        "destination_number": "+17744045256",
        "caller_id_number": "+15087282017",
        "start_epoch": "1700000000",
        "end_epoch": "1700000030",
        "answer_epoch": "1700000005",
        "duration": "30",
        "billsec": "25",
        "hangup_cause": "NORMAL_CLEARING",
        "customer_id": "20",
    }
    if extra_vars:
        variables.update(extra_vars)
    return {"variables": variables}


def test_ingest_stores_inbound_carrier(trunks_db, client):
    """POST /v1/cdrs/ingest with the FS channel vars -> the row stores them."""
    db = trunks_db["db"]

    async def go():
        r = await client.post("/v1/cdrs/ingest", json=_ingest_payload(
            "ct-ingest-sinch-1",
            {"inbound_carrier": "sinch", "inbound_carrier_pop": "denver"},
        ))
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "ok"

        row = await db.fetch_one(
            "SELECT inbound_carrier, inbound_carrier_pop FROM cdrs WHERE uuid = $1",
            "ct-ingest-sinch-1")
        assert row is not None
        assert row["inbound_carrier"] == "sinch"
        assert row["inbound_carrier_pop"] == "denver"

    _run(go())


def test_ingest_absent_inbound_carrier_is_null(trunks_db, client):
    """No inbound-carrier vars (legacy call) -> both columns NULL."""
    db = trunks_db["db"]

    async def go():
        r = await client.post("/v1/cdrs/ingest", json=_ingest_payload("ct-ingest-legacy-1"))
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "ok"

        row = await db.fetch_one(
            "SELECT inbound_carrier, inbound_carrier_pop FROM cdrs WHERE uuid = $1",
            "ct-ingest-legacy-1")
        assert row is not None
        assert row["inbound_carrier"] is None
        assert row["inbound_carrier_pop"] is None

    _run(go())
