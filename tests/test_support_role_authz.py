"""Support role + authz hardening — full-stack tests over the REAL routers.

Proves the new `support` role (platform-wide READ on whitelisted
troubleshooting/quality endpoints, 403 on every write) plus the security holes
closed alongside it:

  * customers CRUD / balance / credit were UNGATED (any authenticated tenant
    could create/update/delete customers) -> now require_admin.
  * GET /v1/cdrs/summary and GET /v1/cdrs/{uuid} had NO auth dependency ->
    now tenant-scoped via get_support_read_filter (404-no-leak on detail).
  * POST /v1/cdrs/{uuid}/rate was an OPEN billing write -> now require_admin.
  * get_customer_filter failed OPEN (non-admin JWT with customer_id=None got
    an unscoped None) -> now 403 "No customer scope".

Harness mirrors tests/test_x402_calls.py (ephemeral local PG, module event
loop, db.pool wired as the runtime `api` role) but mounts the routers behind
the REAL JWTAuthMiddleware and drives them with REAL minted JWTs per role —
the exact production auth path. The new 39_users_support_role.sql migration is
applied from the repo file (twice — idempotency) on top of the ORIGINAL users
role CHECK from 09_schema_users.sql.

Run:  JWT_SECRET_KEY=x python3 -m pytest tests/test_support_role_authz.py -q
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
# import; homer reads QRYN_URL at import — point it at a dead local port so
# the search gate test fails fast with 503, never a slow DNS/timeout).
os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
os.environ.setdefault("ENV", "development")
os.environ["QRYN_URL"] = "http://127.0.0.1:1"

asyncpg = pytest.importorskip("asyncpg", reason="asyncpg required for authz tests")
httpx = pytest.importorskip("httpx", reason="httpx required for authz tests")

REPO = Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
MIG_SUPPORT_ROLE = REPO / "docker" / "postgres" / "init" / "39_users_support_role.sql"

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

# Minimal production-shaped schema: every table the routers under test touch,
# copied column-for-column from the init scripts (02 core, 03 api, 05 cdrs +
# 18 sbc_id, 07 call_path_packages, 08 carrier_gateways, 09 users with the
# ORIGINAL role CHECK — migration 39 is applied on top, 32 call_attestations).
# cdrs is a plain table (no TimescaleDB) — partitioning is irrelevant to authz.
_BASE_SCHEMA = """
CREATE ROLE api LOGIN PASSWORD 'api_secret';

CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  account_type VARCHAR(20) NOT NULL CHECK (account_type IN ('rcf', 'api', 'trunk', 'hybrid', 'ucaas')),
  balance DECIMAL(12,4) DEFAULT 0,
  credit_limit DECIMAL(12,4) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  traffic_grade VARCHAR(10) DEFAULT 'standard',
  fraud_score SMALLINT DEFAULT 0,
  daily_limit DECIMAL(12,4) DEFAULT 500,
  cpm_limit INT DEFAULT 60,
  ucaas_enabled BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW());

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
  cps_limit INT DEFAULT 10 CHECK (cps_limit > 0),
  auth_type VARCHAR(20) DEFAULT 'ip',
  tech_prefix VARCHAR(10),
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW());

CREATE TABLE trunk_auth_ips (
  id SERIAL PRIMARY KEY,
  trunk_id INT NOT NULL REFERENCES sip_trunks(id) ON DELETE CASCADE,
  ip_address INET NOT NULL,
  description VARCHAR(100),
  CONSTRAINT trunk_ip_unique UNIQUE (trunk_id, ip_address));

CREATE TABLE trunk_dids (
  id SERIAL PRIMARY KEY,
  trunk_id INT NOT NULL REFERENCES sip_trunks(id) ON DELETE CASCADE,
  did VARCHAR(20) NOT NULL,
  CONSTRAINT trunk_did_unique UNIQUE (did));

CREATE TABLE call_path_packages (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  call_paths INT NOT NULL CHECK (call_paths > 0),
  monthly_fee DECIMAL(10,2) NOT NULL DEFAULT 0,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW());

ALTER TABLE sip_trunks ADD COLUMN call_path_package_id INTEGER REFERENCES call_path_packages(id);

CREATE TABLE api_credentials (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE);

CREATE TABLE api_dids (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  did VARCHAR(20) NOT NULL,
  enabled BOOLEAN DEFAULT true);

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

CREATE TABLE call_attestations (
  call_id            TEXT PRIMARY KEY,
  customer_id        INT NOT NULL,
  signed_attestation TEXT,
  attest_intent      TEXT,
  inbound_signed     BOOLEAN,
  inbound_attest     TEXT,
  inbound_verstat    TEXT,
  verstat_source     TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE carrier_gateways (
  id SERIAL PRIMARY KEY,
  gateway_name VARCHAR(50) NOT NULL UNIQUE,
  display_name VARCHAR(100) NOT NULL,
  description TEXT,
  sip_proxy VARCHAR(255) NOT NULL,
  port INT DEFAULT 5060,
  transport VARCHAR(10) DEFAULT 'udp',
  auth_type VARCHAR(20) DEFAULT 'ip',
  username VARCHAR(100),
  password VARCHAR(100),
  register BOOLEAN DEFAULT false,
  caller_id_in_from BOOLEAN DEFAULT true,
  codec_prefs VARCHAR(255) DEFAULT 'PCMU,PCMA',
  max_channels INT,
  cps_limit INT,
  product_types TEXT[] DEFAULT '{}',
  is_primary BOOLEAN DEFAULT false,
  is_failover BOOLEAN DEFAULT false,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW());

-- ORIGINAL 09_schema_users.sql shape: the inline role CHECK auto-names to
-- users_role_check, which 39_users_support_role.sql swaps by that exact name.
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

GRANT ALL ON customers, rcf_numbers, sip_trunks, trunk_auth_ips, trunk_dids,
             call_path_packages, api_credentials, api_dids, cdrs,
             call_attestations, carrier_gateways, users TO api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO api;
"""


class _EphemeralPG:
    def __init__(self, pg_bin):
        self.pg_bin = pg_bin
        self.tmp = tempfile.mkdtemp(prefix="revup_authz_pg.")
        self.data = os.path.join(self.tmp, "data")
        self.sock = os.path.join(self.tmp, "sock")
        os.makedirs(self.sock, exist_ok=True)
        self.port = 55435  # distinct from the payment suites (55433/55434)

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
DID_RCF_A = "+16175550111"          # customer A's RCF number
CDR_A1, CDR_A2 = "cdr-a-0001", "cdr-a-0002"   # customer A's CDRs
CDR_B1 = "cdr-b-0001"                          # customer B's CDR
FINANCIAL_KEYS = ("balance", "credit_limit", "fraud_score", "daily_limit", "cpm_limit")


@pytest.fixture(scope="module")
def authz_db():
    """Boot PG, apply schema + the 39 support-role migration (twice), seed."""
    if PG_BIN is None:
        pytest.skip("no local PostgreSQL binaries; set TEST_PG_BIN to run authz tests")
    pg = _EphemeralPG(PG_BIN)
    try:
        pg.start()
    except Exception as e:  # noqa: BLE001
        pg.stop()
        pytest.skip(f"could not start throwaway PostgreSQL: {e}")

    from db import database as db  # noqa: E402

    state = {"db": db}
    now = datetime.now(timezone.utc)

    async def _setup():
        owner = await asyncpg.create_pool(
            host=pg.sock, port=pg.port, user="postgres", database="postgres",
            min_size=1, max_size=2, statement_cache_size=0)
        async with owner.acquire() as conn:
            await conn.execute(_BASE_SCHEMA)
            # The REAL migration under test — applied twice (idempotent).
            await conn.execute(MIG_SUPPORT_ROLE.read_text())
            await conn.execute(MIG_SUPPORT_ROLE.read_text())

            # Two tenants with distinct financial rows.
            cust_a = await conn.fetchrow(
                "INSERT INTO customers (name, account_type, balance, credit_limit, fraud_score) "
                "VALUES ('Tenant Alpha', 'trunk', 123.4500, 100, 7) RETURNING id")
            cust_b = await conn.fetchrow(
                "INSERT INTO customers (name, account_type, balance, credit_limit, fraud_score) "
                "VALUES ('Tenant Beta', 'trunk', 67.8900, 50, 3) RETURNING id")
            cid_a, cid_b = cust_a["id"], cust_b["id"]

            # One trunk each (+ one auth IP on A's — the list must expose only counts).
            trunk_a = await conn.fetchrow(
                "INSERT INTO sip_trunks (customer_id, trunk_name, max_channels, cps_limit) "
                "VALUES ($1, 'alpha-trunk-1', 10, 5) RETURNING id", cid_a)
            trunk_b = await conn.fetchrow(
                "INSERT INTO sip_trunks (customer_id, trunk_name, max_channels, cps_limit) "
                "VALUES ($1, 'beta-trunk-1', 10, 5) RETURNING id", cid_b)
            ip_a = await conn.fetchrow(
                "INSERT INTO trunk_auth_ips (trunk_id, ip_address) "
                "VALUES ($1, '198.51.100.10') RETURNING id", trunk_a["id"])

            # An RCF number for A (PUT /v1/rcf fail-closed target).
            await conn.execute(
                "INSERT INTO rcf_numbers (did, customer_id, forward_to) VALUES ($1, $2, '+17745550000')",
                DID_RCF_A, cid_a)

            # CDRs: 2 for A, 1 for B, all inside the default 24h window.
            for u, cid in ((CDR_A1, cid_a), (CDR_A2, cid_a), (CDR_B1, cid_b)):
                await conn.execute(
                    "INSERT INTO cdrs (uuid, customer_id, product_type, direction, caller_id, "
                    " destination, start_time, answer_time, end_time, duration_ms, billable_ms, "
                    " hangup_cause, sip_code, sbc_id) "
                    "VALUES ($1, $2, 'trunk', 'outbound', '+16175551000', '+12125551111', "
                    " $3, $4, $5, 60000, 60000, 'NORMAL_CLEARING', 200, 'sbc-1')",
                    u, cid, now - timedelta(hours=1),
                    now - timedelta(hours=1) + timedelta(seconds=3),
                    now - timedelta(hours=1) + timedelta(seconds=63))

            # Attestations for one call per tenant.
            await conn.execute(
                "INSERT INTO call_attestations (call_id, customer_id, signed_attestation, "
                " attest_intent, inbound_signed, inbound_attest, inbound_verstat, verstat_source) "
                "VALUES ($1, $2, 'A', 'A', true, 'A', 'TN-Validation-Passed', 'self')",
                CDR_A1, cid_a)
            await conn.execute(
                "INSERT INTO call_attestations (call_id, customer_id, signed_attestation, "
                " attest_intent, inbound_signed, inbound_attest, inbound_verstat, verstat_source) "
                "VALUES ($1, $2, 'div', 'div', true, 'B', 'TN-Validation-Passed', 'carrier')",
                CDR_B1, cid_b)

            # One user per role. The support INSERT doubles as DB-level proof
            # that migration 39 admitted the new role (pre-migration CHECK
            # would have rejected it). Password hashes are dummies — tokens
            # are minted directly, /login is not under test.
            await conn.execute(
                "INSERT INTO users (email, password_hash, customer_id, role, name) VALUES "
                "('admin@test.local',    'x', NULL, 'admin',    'Admin'), "
                "('support@test.local',  'x', NULL, 'support',  'Support'), "
                "('alpha@test.local',    'x', $1,   'user',     'Alpha User'), "
                "('alpha-ro@test.local', 'x', $1,   'readonly', 'Alpha RO')",
                cid_a)

            state.update(cid_a=cid_a, cid_b=cid_b,
                         trunk_a=trunk_a["id"], trunk_b=trunk_b["id"], ip_a=ip_a["id"])
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
def client(authz_db):
    """httpx client over the REAL routers behind the REAL JWT middleware.

    Production prefixes from main.py; no injected request.state.user — every
    request authenticates through JWTAuthMiddleware with a REAL minted Bearer
    token, so 401/403 semantics are exactly what production serves.
    raise_app_exceptions=False so upstream-down 5xx (homer search) comes back
    as a response, not a raised exception.
    """
    from fastapi import FastAPI
    from middleware.auth import JWTAuthMiddleware
    from routers import (
        auth as auth_router, carriers, calls, cdrs, customers,
        homer, number_inventory, rates, rcf, stir, tiers, trunks,
    )

    app = FastAPI()
    app.add_middleware(JWTAuthMiddleware)
    app.include_router(auth_router.router, prefix="/v1/auth")
    app.include_router(customers.router, prefix="/v1/customers")
    app.include_router(rcf.router, prefix="/v1/rcf")
    app.include_router(calls.router, prefix="/v1/calls")
    app.include_router(trunks.router, prefix="/v1/trunks")
    app.include_router(cdrs.router, prefix="/v1/cdrs")
    app.include_router(carriers.router, prefix="/v1/carriers")
    app.include_router(rates.router, prefix="/v1/rates")
    app.include_router(tiers.router, prefix="/v1/tiers")
    app.include_router(homer.router, prefix="/v1/homer")
    app.include_router(stir.router, prefix="/v1/stir")
    app.include_router(number_inventory.router, prefix="/v1/numbers")

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    c = httpx.AsyncClient(transport=transport, base_url="http://test")
    try:
        yield c
    finally:
        _run(c.aclose())


@pytest.fixture(scope="module")
def tokens(authz_db):
    """Real JWTs per role, minted exactly like POST /auth/login does."""
    from auth.security import create_access_token

    def mint(sub, email, role, customer_id):
        return create_access_token(
            {"sub": sub, "email": email, "role": role, "customer_id": customer_id})

    return {
        "admin": mint("1", "admin@test.local", "admin", None),
        "support": mint("2", "support@test.local", "support", None),
        "user_a": mint("3", "alpha@test.local", "user", authz_db["cid_a"]),
        "readonly_a": mint("4", "alpha-ro@test.local", "readonly", authz_db["cid_a"]),
        # The fail-open hole: a non-admin JWT with NO customer scope.
        "user_noscope": mint("5", "noscope@test.local", "user", None),
    }


def _auth(tokens, role):
    return {"Authorization": f"Bearer {tokens[role]}"}


# ---------------------------------------------------------------------------
# 1) Support 200s — platform-wide read on the whitelisted surface.
# ---------------------------------------------------------------------------
def test_support_reads_cdrs_platform_wide(authz_db, client, tokens):
    async def go():
        r = await client.get("/v1/cdrs", headers=_auth(tokens, "support"))
        assert r.status_code == 200, r.text
        body = r.json()
        seen = {c["customer_id"] for c in body["cdrs"]}
        # BOTH tenants' rows visible — platform-wide, not tenant-scoped.
        assert {authz_db["cid_a"], authz_db["cid_b"]} <= seen
        uuids = {c["uuid"] for c in body["cdrs"]}
        assert {CDR_A1, CDR_A2, CDR_B1} <= uuids

    _run(go())


def test_support_reads_cdr_summary(client, tokens):
    async def go():
        r = await client.get("/v1/cdrs/summary", headers=_auth(tokens, "support"))
        assert r.status_code == 200, r.text
        rows = r.json()["summary"]
        # All 3 seeded calls (2 tenant-A + 1 tenant-B) are in the roll-up.
        assert sum(row["total_calls"] for row in rows) == 3

    _run(go())


def test_support_reads_cdr_detail_cross_customer(authz_db, client, tokens):
    async def go():
        r = await client.get(f"/v1/cdrs/{CDR_B1}", headers=_auth(tokens, "support"))
        assert r.status_code == 200, r.text
        assert r.json()["customer_id"] == authz_db["cid_b"]

    _run(go())


def test_support_reads_attestations(authz_db, client, tokens):
    async def go():
        # Per-call attestation, cross-customer.
        r = await client.get(f"/v1/cdrs/{CDR_B1}/attestation", headers=_auth(tokens, "support"))
        assert r.status_code == 200, r.text
        assert r.json()["customer_id"] == authz_db["cid_b"]
        # Platform roll-up.
        r2 = await client.get("/v1/stir/attestation-summary", headers=_auth(tokens, "support"))
        assert r2.status_code == 200, r2.text
        assert r2.json()["total"] == 2

    _run(go())


def test_support_reads_homer_aliases(client, tokens):
    async def go():
        r = await client.get("/v1/homer/aliases", headers=_auth(tokens, "support"))
        assert r.status_code == 200, r.text
        assert any(a["alias"].startswith("Bandwidth") for a in r.json()["aliases"])

    _run(go())


def test_support_homer_search_gate_passes(client, tokens):
    """The authz gate admits support; upstream qryn is unreachable in the
    harness, so anything EXCEPT 401/403 (here: 503) proves the gate."""
    async def go():
        r = await client.post(
            "/v1/homer/search",
            headers=_auth(tokens, "support"),
            json={"from_user": "6175551000",
                  "start_time": "2026-08-19T00:00:00Z",
                  "end_time": "2026-08-19T01:00:00Z"})
        assert r.status_code not in (401, 403), r.text
        assert 500 <= r.status_code < 600  # qryn down -> 503 from _query_qryn

    _run(go())


def test_support_lists_customers_all_rows_slim(authz_db, client, tokens):
    async def go():
        r = await client.get("/v1/customers", headers=_auth(tokens, "support"))
        assert r.status_code == 200, r.text
        rows = r.json()
        ids = {row["id"] for row in rows}
        assert {authz_db["cid_a"], authz_db["cid_b"]} <= ids  # platform-wide
        for row in rows:
            assert row["name"]  # dropdowns need id + name — shape kept
            for key in FINANCIAL_KEYS:
                assert key not in row, f"support must not see {key}"

    _run(go())


def test_support_lists_trunks_all_rows(authz_db, client, tokens):
    async def go():
        r = await client.get("/v1/trunks", headers=_auth(tokens, "support"))
        assert r.status_code == 200, r.text
        rows = r.json()
        assert {t["customer_id"] for t in rows} >= {authz_db["cid_a"], authz_db["cid_b"]}
        # The list exposes only a COUNT of auth IPs, never addresses.
        for t in rows:
            assert "ip_count" in t
            assert "ip_address" not in t

    _run(go())


# ---------------------------------------------------------------------------
# 2) Support 403s — every write, everywhere.
# ---------------------------------------------------------------------------
def test_support_403_on_customer_writes(authz_db, client, tokens):
    async def go():
        hdrs = _auth(tokens, "support")
        cid_a = authz_db["cid_a"]
        r = await client.post("/v1/customers", headers=hdrs,
                              json={"name": "Evil Co"})
        assert r.status_code == 403, r.text
        r = await client.put(f"/v1/customers/{cid_a}", headers=hdrs,
                             json={"name": "Hacked"})
        assert r.status_code == 403, r.text
        r = await client.delete(f"/v1/customers/{cid_a}", headers=hdrs)
        assert r.status_code == 403, r.text
        r = await client.post(f"/v1/customers/{cid_a}/credit", headers=hdrs,
                              params={"amount": 100})
        assert r.status_code == 403, r.text

    _run(go())


def test_support_403_on_trunk_writes(authz_db, client, tokens):
    async def go():
        hdrs = _auth(tokens, "support")
        r = await client.post("/v1/trunks", headers=hdrs,
                              json={"customer_id": authz_db["cid_a"], "trunk_name": "evil"})
        assert r.status_code == 403, r.text
        # Auth-IP management is owner-self-service via get_customer_filter —
        # support has NO customer scope, so it fails closed with 403.
        r = await client.post(f"/v1/trunks/{authz_db['trunk_a']}/ips", headers=hdrs,
                              json={"ip_address": "203.0.113.9"})
        assert r.status_code == 403, r.text
        r = await client.delete(
            f"/v1/trunks/{authz_db['trunk_a']}/ips/{authz_db['ip_a']}", headers=hdrs)
        assert r.status_code == 403, r.text

    _run(go())


def test_support_403_on_cdr_rate_and_calls(client, tokens):
    async def go():
        hdrs = _auth(tokens, "support")
        r = await client.post(f"/v1/cdrs/{CDR_A1}/rate", headers=hdrs)
        assert r.status_code == 403, r.text
        r = await client.post("/v1/calls", headers=hdrs,
                              json={"from_did": "+16175550100", "to": "+16175551234"})
        assert r.status_code == 403, r.text

    _run(go())


def test_support_403_on_admin_surfaces(client, tokens):
    async def go():
        hdrs = _auth(tokens, "support")
        r = await client.post("/v1/auth/register", headers=hdrs,
                              json={"email": "sneak@test.local", "password": "password123",
                                    "name": "Sneak", "role": "admin"})
        assert r.status_code == 403, r.text
        # One representative admin-only route per group.
        for path in ("/v1/rates", "/v1/tiers", "/v1/carriers", "/v1/numbers/inventory"):
            r = await client.get(path, headers=hdrs)
            assert r.status_code == 403, f"{path}: {r.status_code} {r.text}"

    _run(go())


def test_support_rcf_update_fails_closed(client, tokens):
    async def go():
        # Non-admin with NULL scope: the tenant predicate (customer_id = NULL)
        # can never match -> 404, and nothing is updated. 403 or 404 both prove
        # fail-closed; leaking a 200 would be the bug.
        r = await client.put(f"/v1/rcf/{DID_RCF_A}", headers=_auth(tokens, "support"),
                             json={"name": "hijack"})
        assert r.status_code in (403, 404), r.text
        # And the RCF read list is NOT on the support whitelist: fail closed.
        r2 = await client.get("/v1/rcf", headers=_auth(tokens, "support"))
        assert r2.status_code == 403, r2.text

    _run(go())


# ---------------------------------------------------------------------------
# 3) Tenant regression — scoping still bites with the new dependency.
# ---------------------------------------------------------------------------
def test_tenant_summary_scoped_despite_query_param(authz_db, client, tokens):
    async def go():
        # Tenant A asks for tenant B's summary — the filter is FORCED to A.
        r = await client.get(f"/v1/cdrs/summary?customer_id={authz_db['cid_b']}",
                             headers=_auth(tokens, "user_a"))
        assert r.status_code == 200, r.text
        rows = r.json()["summary"]
        assert sum(row["total_calls"] for row in rows) == 2  # A's calls only

    _run(go())


def test_tenant_cdr_detail_cross_customer_404(client, tokens):
    async def go():
        hdrs = _auth(tokens, "user_a")
        # Own CDR: visible.
        r = await client.get(f"/v1/cdrs/{CDR_A1}", headers=hdrs)
        assert r.status_code == 200, r.text
        # Foreign CDR: indistinguishable from missing (no existence leak).
        r = await client.get(f"/v1/cdrs/{CDR_B1}", headers=hdrs)
        assert r.status_code == 404, r.text

    _run(go())


def test_tenant_lists_scoped_and_slim(authz_db, client, tokens):
    async def go():
        hdrs = _auth(tokens, "user_a")
        r = await client.get("/v1/cdrs", headers=hdrs)
        assert r.status_code == 200, r.text
        assert {c["customer_id"] for c in r.json()["cdrs"]} == {authz_db["cid_a"]}

        r = await client.get("/v1/customers", headers=hdrs)
        assert r.status_code == 200, r.text
        rows = r.json()
        assert [row["id"] for row in rows] == [authz_db["cid_a"]]  # own row only
        for key in FINANCIAL_KEYS:
            assert key not in rows[0]

        r = await client.get("/v1/trunks", headers=hdrs)
        assert r.status_code == 200, r.text
        assert {t["customer_id"] for t in r.json()} == {authz_db["cid_a"]}

    _run(go())


# ---------------------------------------------------------------------------
# 4) Fail-closed — non-admin JWT with customer_id=None gets 403, not the world.
# ---------------------------------------------------------------------------
def test_null_scope_user_fails_closed(client, tokens):
    async def go():
        hdrs = _auth(tokens, "user_noscope")
        for path in ("/v1/trunks", "/v1/rcf"):
            r = await client.get(path, headers=hdrs)
            assert r.status_code == 403, f"{path}: {r.status_code} {r.text}"
            assert r.json()["detail"] == "No customer scope"

    _run(go())


# ---------------------------------------------------------------------------
# 5) Admin unchanged — full rows, writes still work, role whitelist grew.
# ---------------------------------------------------------------------------
def test_admin_full_rows_and_write_smoke(authz_db, client, tokens):
    async def go():
        hdrs = _auth(tokens, "admin")
        r = await client.get("/v1/customers", headers=hdrs)
        assert r.status_code == 200, r.text
        by_id = {row["id"]: row for row in r.json()}
        assert float(by_id[authz_db["cid_a"]]["balance"]) == 123.45  # financials intact
        assert "credit_limit" in by_id[authz_db["cid_a"]]

        r = await client.get(f"/v1/customers/{authz_db['cid_a']}", headers=hdrs)
        assert r.status_code == 200 and "balance" in r.json()

        # Write smoke: create + delete a customer.
        r = await client.post("/v1/customers", headers=hdrs,
                              json={"name": "Smoke Co", "account_type": "rcf"})
        assert r.status_code == 200, r.text
        new_id = r.json()["id"]
        r = await client.delete(f"/v1/customers/{new_id}", headers=hdrs)
        assert r.status_code == 200, r.text

        # Cheap admin GET (carriers group) still admin-accessible.
        r = await client.get("/v1/carriers", headers=hdrs)
        assert r.status_code == 200, r.text

        # Admin CDR view is platform-wide.
        r = await client.get("/v1/cdrs", headers=hdrs)
        assert {c["uuid"] for c in r.json()["cdrs"]} >= {CDR_A1, CDR_A2, CDR_B1}

    _run(go())


def test_admin_can_register_support_user(client, tokens):
    async def go():
        hdrs = _auth(tokens, "admin")
        r = await client.post("/v1/auth/register", headers=hdrs,
                              json={"email": "support2@test.local", "password": "password123",
                                    "name": "Support Two", "role": "support"})
        assert r.status_code == 200, r.text
        assert r.json()["role"] == "support"
        assert r.json()["customer_id"] is None
        # The whitelist grew — it did not open up.
        r = await client.post("/v1/auth/register", headers=hdrs,
                              json={"email": "bogus@test.local", "password": "password123",
                                    "name": "Bogus", "role": "superuser"})
        assert r.status_code == 400, r.text

    _run(go())


def test_users_role_check_constraint_still_enforced(authz_db):
    """Migration 39 admits 'support' but the CHECK still rejects unknown roles."""
    db = authz_db["db"]

    async def go():
        with pytest.raises(asyncpg.CheckViolationError):
            await db.execute(
                "INSERT INTO users (email, password_hash, role, name) "
                "VALUES ('bad@test.local', 'x', 'superuser', 'Bad')")

    _run(go())


# ---------------------------------------------------------------------------
# 6) No token at all -> 401 from the middleware (sanity).
# ---------------------------------------------------------------------------
def test_no_token_is_401(client):
    async def go():
        r = await client.get("/v1/cdrs/summary")
        assert r.status_code == 401, r.text

    _run(go())
