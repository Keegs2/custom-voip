"""Tenant redaction — customers never see how we bill/rate a call.

Owner rule: tenant (non-staff) callers must never receive rates, costs,
carrier cost, margin, rating state, fraud internals, routing/supplier
internals, or an exact call duration. Staff (admin/support) shapes are
unchanged.

Covers:
  * services/tenant_redaction.py pure helpers — duration_minutes rounding
    (0s unanswered, 1s, 29s, 30s, 89s, 90s, 3600s), aggregate + average
    minutes, allowlist/denylist disjointness, minute flooring.
  * REAL routers over an ephemeral PostgreSQL behind the REAL JWT middleware
    with REAL minted JWTs (same harness as test_cdr_search_filters.py):
      - GET /v1/cdrs, /v1/cdrs/{uuid}, /v1/cdrs/summary (day/destination/hour)
      - GET /v1/trunks/{id}/stats
      - GET /v1/calls/{id} (completed + active)
    Tenant responses contain NONE of the forbidden keys (full denylist,
    asserted recursively); tenant-ignored filters (rated_only/sbc_id/zone)
    cannot be used as an oracle; staff responses keep the historical keys
    and exact values.

Run:  JWT_SECRET_KEY=x python3 -m pytest tests/test_tenant_redaction.py -q
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

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
os.environ.setdefault("ENV", "development")

REPO = Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
sys.path.insert(0, str(API_SRC))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from services import tenant_redaction as tr  # noqa: E402  (pure; no DB deps)


def assert_no_forbidden(obj, path="$"):
    """Recursively fail on ANY forbidden tenant key, anywhere in the body."""
    if isinstance(obj, dict):
        hit = tr.FORBIDDEN_TENANT_CDR_KEYS & set(obj)
        assert not hit, f"forbidden tenant keys at {path}: {sorted(hit)}"
        for k, v in obj.items():
            assert_no_forbidden(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            assert_no_forbidden(v, f"{path}[{i}]")


# ---------------------------------------------------------------------------
# 1) Pure helper tests (no DB)
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("ms,answered,expected", [
    (0, False, 0),          # 0s unanswered
    (45_000, False, 0),     # unanswered with ring time -> still 0
    (0, True, 0),           # answered but zero duration -> 0
    (1_000, True, 1),       # 1s -> at least 1 ("never 0 for an answered call")
    (29_000, True, 1),      # 29s -> rounds to 0, floored up to 1
    (30_000, True, 1),      # 30s -> half-up -> 1
    (89_000, True, 1),      # 89s -> 1.48 -> 1
    (90_000, True, 2),      # 90s -> 1.5 -> half-up -> 2
    (3_600_000, True, 60),  # 1h -> 60
    (None, True, 0),
])
def test_duration_minutes_rounding(ms, answered, expected):
    assert tr.duration_minutes(ms, answered) == expected


def test_aggregate_minutes_rounds_the_total_once():
    # Three 20s calls: per-call minimums would sum to 3; the total (60s) is 1.
    assert tr.aggregate_minutes(3 * 20_000) == 1
    assert tr.aggregate_minutes(0) == 0
    assert tr.aggregate_minutes(None) == 0
    assert tr.aggregate_minutes(1_000) == 1          # any talk time -> >= 1
    assert tr.aggregate_minutes(90_000) == 2         # half-up
    assert tr.aggregate_minutes(89_999) == 1


def test_average_minutes_one_decimal_half_up():
    assert tr.average_minutes(None) is None
    assert tr.average_minutes(2.25) == 2.3
    assert tr.average_minutes(2.24) == 2.2
    assert tr.average_minutes(1) == 1.0


def test_allowlist_and_denylist_are_disjoint_and_sane():
    assert not (tr.TENANT_CDR_FIELDS & tr.FORBIDDEN_TENANT_CDR_KEYS)
    assert "duration_ms" in tr.TENANT_CDR_SELECT_COLUMNS          # read...
    assert "duration_ms" not in tr.TENANT_CDR_FIELDS              # ...never returned
    assert "duration_minutes" in tr.TENANT_CDR_FIELDS
    for col in tr.TENANT_CDR_SELECT_COLUMNS:
        assert col not in tr.FORBIDDEN_TENANT_CDR_KEYS or col == "duration_ms", col


def test_redact_cdr_row_drops_unknown_and_sensitive_keys():
    ans = datetime(2026, 9, 1, 12, 0, 7, 123456, tzinfo=timezone.utc)
    row = {
        "uuid": "u1", "answer_time": ans, "end_time": ans + timedelta(seconds=95),
        "duration_ms": 95_000, "billable_ms": 90_000, "total_cost": 1,
        "rate_per_min": 1, "margin": 1, "some_future_column": "x",
        "mos": 4.1, "stir_attestation": "A",
    }
    out = tr.redact_cdr_row(row)
    assert_no_forbidden(out)
    assert "some_future_column" not in out     # allowlist, not denylist
    assert out["duration_minutes"] == 2
    assert out["answer_time"] == ans.replace(second=0, microsecond=0)
    assert out["end_time"].second == 0 and out["end_time"].microsecond == 0
    assert out["stir_badge"] == "A" and out["stir_badge_source"] == "intent"


# ---------------------------------------------------------------------------
# 2) Integration — real routers, ephemeral PostgreSQL
# ---------------------------------------------------------------------------
asyncpg = pytest.importorskip("asyncpg", reason="asyncpg required for integration tests")
httpx = pytest.importorskip("httpx", reason="httpx required for integration tests")

from cdr_schema import apply_cdr_column_migrations  # noqa: E402


def _find_pg_bin():
    override = os.getenv("TEST_PG_BIN")
    candidates = [override] if override else []
    pgctl = shutil.which("pg_ctl")
    if pgctl:
        candidates.append(str(Path(pgctl).parent))
    candidates += [
        "/opt/homebrew/opt/postgresql@16/bin", "/opt/homebrew/opt/postgresql@15/bin",
        "/opt/homebrew/opt/postgresql@14/bin", "/usr/local/opt/postgresql@16/bin",
        "/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/15/bin",
    ]
    for d in candidates:
        if d and Path(d, "initdb").exists() and Path(d, "pg_ctl").exists():
            return d
    return None


PG_BIN = _find_pg_bin()

# Production-shaped cdrs (05 base + 16 detail + 18 sbc_id + 40 inbound
# carrier). 23 (on-net) and 47 (stir outcome) are replayed from the REAL
# migration files via tests/cdr_schema.py.
_SCHEMA = """
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
  inbound_carrier VARCHAR(32),
  inbound_carrier_pop VARCHAR(32),
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

CREATE TABLE sip_trunks (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL,
  trunk_name VARCHAR(100),
  max_channels INT NOT NULL,
  cps_limit INT DEFAULT 10);

CREATE TABLE trunk_dids (
  id SERIAL PRIMARY KEY,
  trunk_id INT NOT NULL,
  did VARCHAR(20) NOT NULL);

CREATE TABLE active_calls (
  uuid UUID PRIMARY KEY,
  customer_id INT NOT NULL,
  product_type VARCHAR(10) NOT NULL,
  trunk_id INT,
  direction VARCHAR(10) NOT NULL,
  caller_id VARCHAR(30),
  destination VARCHAR(30),
  start_time TIMESTAMPTZ DEFAULT NOW(),
  answer_time TIMESTAMPTZ,
  state VARCHAR(20) DEFAULT 'ringing');

GRANT ALL ON ALL TABLES IN SCHEMA public TO api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO api;
"""


class _EphemeralPG:
    def __init__(self, pg_bin):
        self.pg_bin = pg_bin
        self.tmp = tempfile.mkdtemp(prefix="revup_redact_pg.")
        self.data = os.path.join(self.tmp, "data")
        self.sock = os.path.join(self.tmp, "sock")
        os.makedirs(self.sock, exist_ok=True)
        # distinct from payments (55432-55434), authz (55435), carrier trunks
        # (55436), did-intake/schema-guard (55437), cdr search (55438)
        self.port = 55439

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


CID_A, CID_B = 101, 202
TRUNK_A = 71
# Seeded CDRs for tenant A (all inside the default 24h window).
#   uuid                   answered  duration_ms  note
CDR_ANS_95 = "a0000000-0000-0000-0000-000000000095"   # yes, 95_000 -> 2 min, RATED, trunk 71
CDR_ANS_20 = "a0000000-0000-0000-0000-000000000020"   # yes, 20_000 -> 1 min
CDR_NOANS = "a0000000-0000-0000-0000-000000000000"    # no,  30_000 ring -> 0 min
CDR_B = "b0000000-0000-0000-0000-000000000001"        # tenant B, answered 60_000
ACTIVE_A = "c0000000-0000-0000-0000-00000000000a"     # live call, tenant A


@pytest.fixture(scope="module")
def redact_db():
    if PG_BIN is None:
        pytest.skip("no local PostgreSQL binaries; set TEST_PG_BIN to run")
    pg = _EphemeralPG(PG_BIN)
    try:
        pg.start()
    except Exception as e:  # noqa: BLE001
        pg.stop()
        pytest.skip(f"could not start throwaway PostgreSQL: {e}")

    from db import database as db

    # Anchor at :13s of the previous minute so seeded answer times (start+7s
    # -> :20s) are deterministically NOT on a minute boundary.
    now = (datetime.now(timezone.utc).replace(second=13, microsecond=0)
           - timedelta(minutes=1))
    state = {"db": db, "now": now}

    async def _setup():
        owner = await asyncpg.create_pool(
            host=pg.sock, port=pg.port, user="postgres", database="postgres",
            min_size=1, max_size=2, statement_cache_size=0)
        async with owner.acquire() as conn:
            await conn.execute(_SCHEMA)
            await apply_cdr_column_migrations(conn)
            await conn.execute("GRANT ALL ON ALL TABLES IN SCHEMA public TO api")

            async def seed(uuid, cid, start, dur_ms, answered, trunk=None, rated=False):
                answer = start + timedelta(seconds=7) if answered else None
                end = start + timedelta(seconds=7) + timedelta(milliseconds=dur_ms)
                await conn.execute(
                    """
                    INSERT INTO cdrs (uuid, customer_id, product_type, trunk_id,
                      direction, caller_id, destination, destination_prefix,
                      start_time, answer_time, end_time, duration_ms, billable_ms,
                      rate_per_min, total_cost, carrier_cost, margin, rated_at,
                      hangup_cause, sip_code, carrier_used, traffic_grade,
                      fraud_score, fraud_flags, freeswitch_node, mos, r_factor,
                      packet_total_count, rtp_audio_in_raw_bytes,
                      rtp_audio_in_packet_count, sip_user_agent, network_addr,
                      bridge_uuid, sbc_id, inbound_carrier, inbound_carrier_pop,
                      on_net, stir_outcome, stir_eff_actual)
                    VALUES ($1, $2, 'trunk', $3, 'outbound', '+16175551000',
                      '+12125551111', '1212', $4, $5, $6, $7, $8,
                      0.012000, 0.024000, 0.010000, 0.014000, $9,
                      'NORMAL_CLEARING', 200, 'bandwidth-dallas', 'standard',
                      7, '{"flag": 1}'::jsonb, 'east-fs', 4.30, 88.5,
                      4750, 760000, 4750, 'PBX/1.0', '203.0.113.9',
                      'bleg-1', 'east-sbc-1', 'bandwidth', 'dallas',
                      false, 'eff=A;mode=relay', 'A')
                    """,
                    uuid, cid, trunk, start, answer, end, dur_ms,
                    (dur_ms // 6000) * 6000,
                    (start + timedelta(minutes=5)) if rated else None,
                )

            await seed(CDR_ANS_95, CID_A, now - timedelta(minutes=10), 95_000, True,
                       trunk=TRUNK_A, rated=True)
            await seed(CDR_ANS_20, CID_A, now - timedelta(hours=2), 20_000, True)
            await seed(CDR_NOANS, CID_A, now - timedelta(hours=3), 30_000, False)
            await seed(CDR_B, CID_B, now - timedelta(hours=1), 60_000, True)
            await conn.execute(
                "INSERT INTO call_attestations (call_id, customer_id, signed_attestation) "
                "VALUES ($1, $2, 'A')", CDR_ANS_95, CID_A)
            await conn.execute(
                "INSERT INTO sip_trunks (id, customer_id, trunk_name, max_channels, cps_limit) "
                "VALUES ($1, $2, 'alpha', 10, 5)", TRUNK_A, CID_A)
            await conn.execute(
                "INSERT INTO active_calls (uuid, customer_id, product_type, direction,"
                " caller_id, destination, start_time, answer_time, state) "
                "VALUES ($1::uuid, $2, 'api', 'outbound', '+16175551000', '+12125551111',"
                " $3, $4, 'answered')",
                ACTIVE_A, CID_A, now - timedelta(seconds=50),
                now - timedelta(seconds=41, microseconds=500))
        await owner.close()
        db.pool = await asyncpg.create_pool(
            host=pg.sock, port=pg.port, user="api", password="api_secret",
            database="postgres", min_size=1, max_size=5, statement_cache_size=0)

    async def _teardown():
        if db.pool is not None:
            await db.pool.close()
            db.pool = None

    _run(_setup())
    try:
        yield state
    finally:
        _run(_teardown())
        pg.stop()


@pytest.fixture(scope="module")
def client(redact_db):
    from fastapi import FastAPI
    from middleware.auth import JWTAuthMiddleware
    from routers import calls, cdrs, trunks
    import services.esl_client as esl

    # No FreeSWITCH in tests: ESL returns nothing (trunk channel count 0,
    # live-call status falls back to the active_calls row).
    async def _no_esl(*_a, **_k):
        return None

    async def _no_status(*_a, **_k):
        return {}

    esl._send_esl_command = _no_esl
    calls.get_call_status = _no_status

    app = FastAPI()
    app.add_middleware(JWTAuthMiddleware)
    app.include_router(cdrs.router, prefix="/v1/cdrs")
    app.include_router(trunks.router, prefix="/v1/trunks")
    app.include_router(calls.router, prefix="/v1/calls")
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    c = httpx.AsyncClient(transport=transport, base_url="http://test")
    try:
        yield c
    finally:
        _run(c.aclose())


@pytest.fixture(scope="module")
def tokens(redact_db):
    from auth.security import create_access_token

    def mint(sub, role, cid):
        return create_access_token(
            {"sub": sub, "email": f"{role}@test.local", "role": role, "customer_id": cid})

    return {
        "admin": mint("1", "admin", None),
        "support": mint("2", "support", None),
        "user_a": mint("3", "user", CID_A),
        "readonly_a": mint("4", "readonly", CID_A),
    }


def _is_minute(value) -> bool:
    """True when an ISO/str timestamp has zero seconds and microseconds."""
    dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return dt.second == 0 and dt.microsecond == 0


def _h(tokens, who):
    return {"Authorization": f"Bearer {tokens[who]}"}


TENANTS = ("user_a", "readonly_a")


def test_tenant_cdr_list_has_no_forbidden_keys(client, tokens):
    async def go():
        for who in TENANTS:
            r = await client.get("/v1/cdrs", headers=_h(tokens, who))
            assert r.status_code == 200, r.text
            body = r.json()
            assert_no_forbidden(body)
            rows = {c["uuid"]: c for c in body["cdrs"]}
            assert set(rows) == {CDR_ANS_95, CDR_ANS_20, CDR_NOANS}  # scoped
            for c in rows.values():
                assert set(c) <= tr.TENANT_CDR_FIELDS, set(c) - tr.TENANT_CDR_FIELDS
            assert rows[CDR_ANS_95]["duration_minutes"] == 2
            assert rows[CDR_ANS_20]["duration_minutes"] == 1
            assert rows[CDR_NOANS]["duration_minutes"] == 0
            # quality + STIR badge survive redaction
            assert rows[CDR_ANS_95]["mos"] == pytest.approx(4.30)
            assert rows[CDR_ANS_95]["stir_badge"] == "A"
            # answer/end floored to the minute -> exact duration not derivable
            for key in ("answer_time", "end_time"):
                assert _is_minute(rows[CDR_ANS_95][key]), (key, rows[CDR_ANS_95][key])

    _run(go())


def test_tenant_cdr_detail_has_no_forbidden_keys(client, tokens):
    async def go():
        r = await client.get(f"/v1/cdrs/{CDR_ANS_95}", headers=_h(tokens, "user_a"))
        assert r.status_code == 200, r.text
        body = r.json()
        assert_no_forbidden(body)
        assert set(body) <= tr.TENANT_CDR_FIELDS
        assert body["duration_minutes"] == 2
        # cross-tenant stays a no-leak 404
        r = await client.get(f"/v1/cdrs/{CDR_B}", headers=_h(tokens, "user_a"))
        assert r.status_code == 404

    _run(go())


def test_tenant_summary_minutes_not_seconds_or_cost(client, tokens):
    async def go():
        for group_by in ("day", "destination", "hour"):
            r = await client.get("/v1/cdrs/summary", params={"group_by": group_by},
                                 headers=_h(tokens, "user_a"))
            assert r.status_code == 200, r.text
            body = r.json()
            assert_no_forbidden(body)
            for row in body["summary"]:
                assert set(row) <= tr.TENANT_SUMMARY_FIELDS, row
        r = await client.get("/v1/cdrs/summary", params={"group_by": "destination"},
                             headers=_h(tokens, "user_a"))
        (row,) = r.json()["summary"]
        assert row["total_calls"] == 3 and row["answered_calls"] == 2
        # answered total 95s + 20s = 115s -> rounded ONCE -> 2 (not 2+1=3)
        assert row["total_minutes"] == 2
        # mean of per-call whole minutes (2, 1) -> 1.5
        assert row["avg_duration_minutes"] == 1.5

    _run(go())


def test_tenant_billing_filters_are_not_an_oracle(client, tokens):
    """rated_only / sbc_id / zone are IGNORED for tenants (same result set)."""
    async def go():
        h = _h(tokens, "user_a")
        base = await client.get("/v1/cdrs", headers=h)
        for params in ({"rated_only": "true"}, {"sbc_id": "nope"}, {"zone": "west"}):
            r = await client.get("/v1/cdrs", params=params, headers=h)
            assert r.status_code == 200, r.text
            assert r.json()["total"] == base.json()["total"] == 3, params
            s = await client.get("/v1/cdrs/summary", params=params, headers=h)
            assert sum(x["total_calls"] for x in s.json()["summary"]) == 3, params

    _run(go())


def test_tenant_trunk_stats_no_cost_no_seconds(client, tokens):
    async def go():
        r = await client.get(f"/v1/trunks/{TRUNK_A}/stats", headers=_h(tokens, "user_a"))
        assert r.status_code == 200, r.text
        body = r.json()
        assert_no_forbidden(body)
        lh = body["last_hour"]
        assert lh["total_calls"] == 1 and lh["answered_calls"] == 1
        assert lh["avg_duration_minutes"] == 2.0

    _run(go())


def test_tenant_call_status_minutes_only(client, tokens):
    async def go():
        h = _h(tokens, "user_a")
        r = await client.get(f"/v1/calls/{CDR_ANS_95}", headers=h)
        assert r.status_code == 200, r.text
        body = r.json()
        assert_no_forbidden(body)
        assert body["status"] == "completed" and body["duration_minutes"] == 2
        assert _is_minute(body["end_time"]), body["end_time"]

        r = await client.get(f"/v1/calls/{ACTIVE_A}", headers=h)
        assert r.status_code == 200, r.text
        live = r.json()
        assert _is_minute(live["answer_time"]), live

    _run(go())


# ---------------------------------------------------------------------------
# 3) Staff shapes unchanged
# ---------------------------------------------------------------------------
STAFF_CDR_KEYS = {
    "duration_seconds", "billable_seconds", "rate_per_min", "total_cost",
    "carrier_used", "traffic_grade", "rated_at", "sbc_id", "network_addr",
    "sip_user_agent", "freeswitch_node", "inbound_carrier", "rtp_audio_in_raw_bytes",
}


def test_staff_cdr_list_and_detail_unchanged(client, tokens):
    async def go():
        for who in ("admin", "support"):
            r = await client.get("/v1/cdrs", headers=_h(tokens, who))
            assert r.status_code == 200, r.text
            rows = {c["uuid"]: c for c in r.json()["cdrs"]}
            assert CDR_B in rows  # platform-wide
            c = rows[CDR_ANS_95]
            assert STAFF_CDR_KEYS <= set(c), STAFF_CDR_KEYS - set(c)
            assert "duration_minutes" not in c
            assert c["duration_seconds"] == 95.0 and c["billable_seconds"] == 90.0
            assert float(c["total_cost"]) == pytest.approx(0.024)

            r = await client.get(f"/v1/cdrs/{CDR_ANS_95}", headers=_h(tokens, who))
            assert r.status_code == 200, r.text
            d = r.json()
            assert {"carrier_cost", "margin", "fraud_score", "fraud_flags",
                    "destination_prefix"} | STAFF_CDR_KEYS <= set(d)
            assert d["margin"] == pytest.approx(0.014)
            # staff timestamps keep full precision (answer = start + 7s)
            assert not _is_minute(d["answer_time"]) or d["answer_time"] is None

        # staff rated_only still filters
        r = await client.get("/v1/cdrs", params={"rated_only": "true"},
                             headers=_h(tokens, "admin"))
        assert {c["uuid"] for c in r.json()["cdrs"]} == {CDR_ANS_95}

    _run(go())


def test_staff_summary_and_trunk_stats_unchanged(client, tokens):
    async def go():
        h = _h(tokens, "admin")
        r = await client.get("/v1/cdrs/summary", params={"group_by": "day"}, headers=h)
        assert r.status_code == 200, r.text
        for row in r.json()["summary"]:
            assert {"total_duration_sec", "total_cost"} <= set(row)
            assert "total_minutes" not in row
        r = await client.get("/v1/cdrs/summary",
                             params={"group_by": "destination", "customer_id": CID_A},
                             headers=h)
        (row,) = r.json()["summary"]
        assert "avg_duration_sec" in row and "total_cost" in row

        r = await client.get(f"/v1/trunks/{TRUNK_A}/stats", headers=h)
        assert r.status_code == 200, r.text
        lh = r.json()["last_hour"]
        assert lh["avg_duration_sec"] == 95.0
        assert lh["total_cost"] == pytest.approx(0.024)
        assert "avg_duration_minutes" not in lh

        r = await client.get(f"/v1/calls/{CDR_ANS_95}", headers=h)
        assert r.status_code == 200, r.text
        assert r.json()["duration_seconds"] == 95.0

    _run(go())
