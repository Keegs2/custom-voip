"""Deploy-order guard for migration 47 (db/schema_check.py + the ingest's
pre-47 INSERT fallback in routers/cdrs.py).

Scenario under test: the API build that binds cdrs.stir_outcome /
cdrs.stir_eff_actual ($56/$57) reaches production BEFORE
`47_cdr_stir_outcome.sql` is applied on the East primary. Required behaviour:

  * the startup check logs CRITICAL naming the EXACT remedy command and does
    NOT raise (every other endpoint keeps serving);
  * GET /health/detailed exposes it as the `schema` component;
  * the ingest still LANDS THE BILLABLE ROW (retrying without the two
    columns), still answers HTTP 200 (contract — mod_json_cdr never retries),
    and logs the condition at ERROR once per interval, not once per call;
  * once 47 is applied, the full INSERT resumes with no restart.

Section 1 runs against a fake db (no PostgreSQL). Section 2 boots a
throwaway PostgreSQL with the BASE cdrs schema and deliberately does NOT
apply 47 until the last test — the one scratch schema in the suite that must
stay behind, on purpose.

Run:
    TEST_PG_BIN=/opt/homebrew/opt/postgresql@16/bin python3 -m pytest tests/test_cdr_schema_guard.py -v
"""
import asyncio
import logging
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
os.environ.setdefault("ENV", "development")

REPO = Path(__file__).resolve().parents[1]
_SRC = REPO / "docker" / "api" / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from cdr_schema import apply_cdr_column_migrations  # noqa: E402
from db import database as db  # noqa: E402
from db import schema_check  # noqa: E402
from routers import cdrs  # noqa: E402

asyncpg = pytest.importorskip("asyncpg")

REMEDY_47 = ("sudo -u postgres psql -d voip -f "
             "/opt/revup/docker/postgres/init/47_cdr_stir_outcome.sql")
REMEDY_48 = ("sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f "
             "/opt/revup/docker/postgres/init/48_cdr_call_legs.sql")
REMEDY_50 = ("sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f "
             "/opt/revup/docker/postgres/init/50_cdr_quality_accuracy.sql")
COLS_47_48 = ["stir_outcome", "stir_eff_actual", "leg", "call_id", "leg_attempt"]
COLS_50 = ["quality_status", "quality_grade", "quality_source",
           "fs_mos", "fs_quality_pct", "fs_jitter_max_std_ms",
           "rtp_audio_in_skip_packet_count",
           "packets_expected", "loss_bursts", "packets_reordered", "ssrc_changes",
           "burst_ratio", "inbound_media_ratio",
           "call_quality_status", "call_quality_grade", "call_mos", "call_quality_leg"]
ALL_COLS = COLS_47_48 + COLS_50


def _a_leg_vars(uuid, **overrides):
    v = {
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
        "sip_hangup_disposition": "send_bye",
    }
    v.update(overrides)
    return v


def _reset_fallback_rate_limit():
    cdrs._pre47_last_logged_mono = 0.0
    cdrs._pre47_fallback_count = 0
    cdrs._pre48_last_logged_mono = 0.0
    cdrs._pre48_fallback_count = 0
    cdrs._pre50_last_logged_mono = 0.0
    cdrs._pre50_fallback_count = 0
    cdrs._refresh_last_logged_mono = 0.0
    cdrs._refresh_failure_count = 0


# ===========================================================================
# 1) Fake-db unit tests (no PostgreSQL needed)
# ===========================================================================

def test_remedy_command_is_exact():
    assert schema_check.remedies_for(["stir_outcome", "stir_eff_actual"]) == [REMEDY_47]
    # one command per migration file, not per column
    assert schema_check.remedies_for(["stir_eff_actual"]) == [REMEDY_47]
    assert schema_check.remedies_for([]) == []
    assert schema_check.remedies_for(["leg", "call_id"]) == [REMEDY_48]
    assert schema_check.remedies_for(COLS_47_48) == [REMEDY_47, REMEDY_48]
    assert schema_check.remedies_for(["call_mos", "quality_status"]) == [REMEDY_50]
    assert schema_check.remedies_for(ALL_COLS) == [REMEDY_47, REMEDY_48, REMEDY_50]


def test_required_columns_cover_the_whole_insert_tail_and_call_columns():
    """REQUIRED_CDR_COLUMNS = every INSERT column beyond 05 (47 + 48 + the 13
    migration-50 binds) + the 4 call-level columns the read endpoints SELECT."""
    names = [c for c, _ in schema_check.REQUIRED_CDR_COLUMNS]
    assert names == ALL_COLS
    assert list(cdrs._QUALITY_COLUMNS) == COLS_50[:13]
    for col, mig in schema_check.REQUIRED_CDR_COLUMNS:
        if col in COLS_50:
            assert mig == "50_cdr_quality_accuracy.sql"


def test_check_reports_missing_columns_with_fake_pool(monkeypatch):
    async def fake_fetch_all(sql, *args):
        assert "information_schema.columns" in sql
        assert args == (ALL_COLS,)
        return [{"column_name": c} for c in ALL_COLS if c != "stir_eff_actual"]

    monkeypatch.setattr(db, "fetch_all", fake_fetch_all)
    r = asyncio.run(schema_check.check_cdr_schema())
    assert r == {"status": "missing", "missing": ["stir_eff_actual"],
                 "remedy": [REMEDY_47], "error": None}
    assert schema_check.describe(r).startswith("degraded: cdrs is missing column(s) stir_eff_actual")
    assert REMEDY_47 in schema_check.describe(r)


def test_check_ok_with_fake_pool(monkeypatch):
    async def fake_fetch_all(sql, *args):
        return [{"column_name": c} for c in ALL_COLS]

    monkeypatch.setattr(db, "fetch_all", fake_fetch_all)
    r = asyncio.run(schema_check.check_cdr_schema())
    assert r["status"] == "ok" and r["missing"] == [] and r["remedy"] == []
    assert schema_check.describe(r) == "healthy"


def test_check_never_raises_when_db_is_down(monkeypatch):
    async def boom(sql, *args):
        raise ConnectionRefusedError("pgbouncer down")

    monkeypatch.setattr(db, "fetch_all", boom)
    r = asyncio.run(schema_check.check_cdr_schema())
    assert r["status"] == "unknown"
    assert "ConnectionRefusedError" in r["error"]
    assert schema_check.describe(r).startswith("unknown:")


def test_startup_check_logs_critical_with_remedy_and_does_not_raise(monkeypatch, caplog):
    async def fake_fetch_all(sql, *args):
        return []                                      # both missing

    monkeypatch.setattr(db, "fetch_all", fake_fetch_all)
    with caplog.at_level(logging.INFO, logger="db.schema_check"):
        r = asyncio.run(schema_check.run_startup_check())
    assert r["status"] == "missing"
    crit = [rec for rec in caplog.records if rec.levelno == logging.CRITICAL]
    assert len(crit) == 1
    assert "stir_outcome, stir_eff_actual" in crit[0].getMessage()
    assert REMEDY_47 in crit[0].getMessage()


def test_startup_check_is_quiet_when_ok(monkeypatch, caplog):
    async def fake_fetch_all(sql, *args):
        return [{"column_name": c} for c in ALL_COLS]

    monkeypatch.setattr(db, "fetch_all", fake_fetch_all)
    with caplog.at_level(logging.INFO, logger="db.schema_check"):
        r = asyncio.run(schema_check.run_startup_check())
    assert r["status"] == "ok"
    assert not [rec for rec in caplog.records if rec.levelno >= logging.WARNING]


class _FakeExecute:
    """db.execute stand-in: the FULL cdrs INSERT raises UndefinedColumnError
    (as PostgreSQL does without 47), everything else succeeds."""

    def __init__(self):
        self.calls = []

    async def __call__(self, sql, *params):
        self.calls.append((sql, params))
        if "INSERT INTO cdrs" in sql and "stir_outcome" in sql:
            raise asyncpg.exceptions.UndefinedColumnError(
                'column "stir_outcome" of relation "cdrs" does not exist')
        return "INSERT 0 1"

    @property
    def cdr_inserts(self):
        return [(s, p) for s, p in self.calls if "INSERT INTO cdrs" in s]


def test_ingest_falls_back_to_pre47_insert_with_fake_db(monkeypatch, caplog):
    fake = _FakeExecute()
    monkeypatch.setattr(db, "execute", fake)
    _reset_fallback_rate_limit()
    with caplog.at_level(logging.DEBUG, logger="routers.cdrs"):
        r = asyncio.run(cdrs._process_cdr_body(
            {"variables": _a_leg_vars("fake-1", stir_outcome="eff=A;mode=base")}))
    assert r["status"] == "ok"
    assert len(fake.cdr_inserts) == 2
    full_sql, full_p = fake.cdr_inserts[0]
    pre_sql, pre_p = fake.cdr_inserts[1]
    assert len(full_p) == 73 and "stir_outcome" in full_sql
    assert len(pre_p) == 55 and "stir_outcome" not in pre_sql and "stir_eff_actual" not in pre_sql
    assert max(int(x) for x in re.findall(r"\$(\d+)", pre_sql)) == 55
    assert pre_p == full_p[:55]                         # nothing renumbered
    assert pre_p[14] == 200                            # $15 sip_code still bound
    errs = [rec for rec in caplog.records if rec.levelno == logging.ERROR]
    assert len(errs) == 1 and REMEDY_47.split(" -f ")[1] in errs[0].getMessage()

    # second CDR inside the interval: fallback again, but NO second ERROR line
    caplog.clear()
    with caplog.at_level(logging.DEBUG, logger="routers.cdrs"):
        r = asyncio.run(cdrs._process_cdr_body({"variables": _a_leg_vars("fake-2")}))
    assert r["status"] == "ok" and len(fake.cdr_inserts) == 4
    assert not [rec for rec in caplog.records if rec.levelno == logging.ERROR]
    assert any(rec.levelno == logging.DEBUG and "pre-47 fallback" in rec.getMessage()
               for rec in caplog.records)


def test_other_undefined_column_is_not_swallowed(monkeypatch):
    """Only the two migration-47 columns trigger the retry; any other missing
    column surfaces through the normal error path (status=error, still 200)."""
    calls = []

    async def fake(sql, *params):
        calls.append(sql)
        if "INSERT INTO cdrs" in sql:
            raise asyncpg.exceptions.UndefinedColumnError(
                'column "on_net_hops" of relation "cdrs" does not exist')
        return "INSERT 0 1"

    monkeypatch.setattr(db, "execute", fake)
    r = asyncio.run(cdrs._process_cdr_body({"variables": _a_leg_vars("fake-3")}))
    assert r["status"] == "error"
    assert len([s for s in calls if "INSERT INTO cdrs" in s]) == 1   # no retry


# ===========================================================================
# 2) Throwaway PostgreSQL — base cdrs schema WITHOUT migration 47
# ===========================================================================

def _find_pg_bin():
    for d in filter(None, [os.getenv("TEST_PG_BIN"),
                           str(Path(shutil.which("pg_ctl")).parent) if shutil.which("pg_ctl") else None,
                           "/opt/homebrew/opt/postgresql@16/bin", "/usr/lib/postgresql/16/bin"]):
        if Path(d, "initdb").exists() and Path(d, "pg_ctl").exists():
            return d
    return None


PG_BIN = _find_pg_bin()

# The PRE-47 cdrs table: every column the ingest binds in $1..$55 (base 05 +
# migration 23's on-net set + migration 40's inbound_carrier pair, inline
# because this module's whole point is a schema that is deliberately behind),
# plus call_attestations for the companion UPSERT. stir_outcome /
# stir_eff_actual are ABSENT on purpose.
_PRE47_SCHEMA = """
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
  hangup_cause VARCHAR(50),
  sip_code INT,
  carrier_used VARCHAR(50),
  traffic_grade VARCHAR(10),
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
  inbound_carrier VARCHAR(20),
  inbound_carrier_pop VARCHAR(50),
  PRIMARY KEY (id, start_time));
CREATE INDEX idx_cdrs_uuid ON cdrs (uuid);

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

GRANT ALL ON cdrs, call_attestations TO api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO api;
"""


class _EphemeralPG:
    def __init__(self, pg_bin):
        self.pg_bin = pg_bin
        self.tmp = tempfile.mkdtemp(prefix="revup_schemaguard_pg.")
        self.data = os.path.join(self.tmp, "data")
        self.sock = os.path.join(self.tmp, "sock")
        os.makedirs(self.sock, exist_ok=True)
        self.port = 55437  # payments 55432-55434, authz 55435, carrier-trunks 55436

    def start(self):
        subprocess.run([f"{self.pg_bin}/initdb", "-D", self.data, "-U", "postgres",
                        "--auth=trust", "-E", "UTF8"], check=True, capture_output=True)
        subprocess.run([f"{self.pg_bin}/pg_ctl", "-D", self.data,
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
def guard_db():
    if PG_BIN is None:
        pytest.skip("no local PostgreSQL binaries; set TEST_PG_BIN to run schema-guard tests")
    pg = _EphemeralPG(PG_BIN)
    try:
        pg.start()
    except Exception as e:  # noqa: BLE001
        pg.stop()
        pytest.skip(f"could not start throwaway PostgreSQL: {e}")

    state = {"db": db, "pg": pg, "owner": None}

    async def _setup():
        state["owner"] = await asyncpg.create_pool(
            host=pg.sock, port=pg.port, user="postgres", database="postgres",
            min_size=1, max_size=2, statement_cache_size=0)
        async with state["owner"].acquire() as conn:
            await conn.execute(_PRE47_SCHEMA)            # NO migration 47 here
        db.pool = await asyncpg.create_pool(
            host=pg.sock, port=pg.port, user="api", password="api_secret",
            database="postgres", min_size=1, max_size=5, statement_cache_size=0)

    async def _teardown():
        if db.pool is not None:
            await db.pool.close()
            db.pool = None
        if state["owner"] is not None:
            await state["owner"].close()

    _run(_setup())
    try:
        yield state
    finally:
        _run(_teardown())
        pg.stop()


@pytest.fixture(scope="module")
def client(guard_db):
    httpx = pytest.importorskip("httpx")
    from fastapi import FastAPI
    from routers import health

    app = FastAPI()
    app.include_router(cdrs.router, prefix="/v1/cdrs")
    app.include_router(health.router)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    c = httpx.AsyncClient(transport=transport, base_url="http://test")
    try:
        yield c
    finally:
        _run(c.aclose())


def test_pg_schema_check_reports_both_columns_missing(guard_db, caplog):
    with caplog.at_level(logging.INFO, logger="db.schema_check"):
        r = _run(schema_check.run_startup_check())
    assert r["status"] == "missing"
    assert r["missing"] == ALL_COLS
    assert r["remedy"] == [REMEDY_47, REMEDY_48, REMEDY_50]
    crit = [rec for rec in caplog.records if rec.levelno == logging.CRITICAL]
    assert len(crit) == 1 and REMEDY_47 in crit[0].getMessage()


def test_pg_health_detailed_exposes_schema_degraded(guard_db, client):
    async def go():
        r = await client.get("/health/detailed")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "degraded"
        assert body["components"]["database"] == "healthy"
        assert body["components"]["schema"].startswith("degraded: cdrs is missing column(s) stir_outcome, stir_eff_actual")
        assert REMEDY_47 in body["components"]["schema"]

    _run(go())


def test_pg_ingest_lands_billable_row_without_47_and_logs_once(guard_db, client, caplog):
    """THE deploy-window contract: HTTP 200, status ok, and the row is IN THE
    TABLE — not only in the media VM's disk log."""
    _reset_fallback_rate_limit()

    async def go():
        with caplog.at_level(logging.DEBUG, logger="routers.cdrs"):
            r1 = await client.post("/v1/cdrs/ingest", json={
                "variables": _a_leg_vars("guard-a-1", stir_outcome="eff=div;mode=relay",
                                     stir_attest_intent="div", stir_inbound_signed="1")})
            r2 = await client.post("/v1/cdrs/ingest", json={
                "variables": _a_leg_vars("guard-a-2")})
        assert r1.status_code == 200 and r1.json()["status"] == "ok", r1.text
        assert r2.status_code == 200 and r2.json()["status"] == "ok", r2.text

        row = await db.fetch_one(
            "SELECT customer_id, destination, sip_code, billable_ms, hangup_cause "
            "FROM cdrs WHERE uuid = $1", "guard-a-1")
        assert row is not None, "billable row must land even without migration 47"
        assert row["customer_id"] == 20 and row["destination"] == "+17744045256"
        assert row["sip_code"] == 200 and row["billable_ms"] == 25000
        assert row["hangup_cause"] == "NORMAL_CLEARING"
        n = await db.fetch_one("SELECT COUNT(*) AS n FROM cdrs")
        assert n["n"] == 2
        # the companion (intent) attestation UPSERT still ran after the fallback
        att = await db.fetch_one("SELECT 1 FROM call_attestations WHERE call_id = $1", "guard-a-1")
        assert att is not None

        # duplicate guard still works on the pre-47 statement
        r3 = await client.post("/v1/cdrs/ingest", json={"variables": _a_leg_vars("guard-a-1")})
        assert r3.json()["status"] == "duplicate"
        n = await db.fetch_one("SELECT COUNT(*) AS n FROM cdrs")
        assert n["n"] == 2

    _run(go())
    errs = [rec for rec in caplog.records if rec.levelno == logging.ERROR
            and "migration-47" in rec.getMessage()]
    assert len(errs) == 1, "fallback must be logged at ERROR once per interval, not per CDR"
    assert "47_cdr_stir_outcome.sql" in errs[0].getMessage()


def test_pg_after_applying_47_full_insert_resumes(guard_db, client):
    """Apply the REAL migration 47 (twice — idempotent) on the live scratch
    DB: no restart, the next ingest binds $56/$57 via the PRE-48 tier (48 is
    still missing) and the columns fill."""
    async def go():
        async with guard_db["owner"].acquire() as conn:
            await apply_cdr_column_migrations(conn, names=("47_cdr_stir_outcome.sql",))

        r = await client.get("/health/detailed")
        assert r.json()["components"]["schema"].startswith(
            "degraded: cdrs is missing column(s) leg, call_id, leg_attempt")
        assert REMEDY_48 in r.json()["components"]["schema"]

        r = await client.post("/v1/cdrs/ingest", json={
            "variables": _a_leg_vars("guard-a-3", stir_outcome="eff=A;mode=reorig")})
        assert r.json()["status"] == "ok", r.text
        row = await db.fetch_one(
            "SELECT stir_outcome, stir_eff_actual FROM cdrs WHERE uuid = $1", "guard-a-3")
        assert row["stir_outcome"] == "eff=A;mode=reorig" and row["stir_eff_actual"] == "A"
        # the pre-47 rows are still there, columns NULL
        row = await db.fetch_one(
            "SELECT stir_outcome FROM cdrs WHERE uuid = $1", "guard-a-1")
        assert row is not None and row["stir_outcome"] is None

    _run(go())


def test_pg_pre48_tier_lands_a_leg_and_drops_b_row(guard_db, client, caplog):
    """47 applied, 48 NOT: the A-leg lands through the 57-param tier (ERROR
    names migration 48) and a carrier B-leg row is DROPPED — never inserted
    without its `leg` column, where it would double-count as a call."""
    _reset_fallback_rate_limit()

    async def go():
        with caplog.at_level(logging.DEBUG, logger="routers.cdrs"):
            r = await client.post("/v1/cdrs/ingest", json={
                "variables": _a_leg_vars("guard-a-48")})
        assert r.json()["status"] == "ok", r.text
        assert await db.fetch_one("SELECT 1 FROM cdrs WHERE uuid = $1", "guard-a-48")

        before = (await db.fetch_one("SELECT COUNT(*) AS n FROM cdrs"))["n"]
        b = {"variables": _a_leg_vars(
                "guard-b-48", originating_leg_uuid="guard-a-48", direction="outbound",
                cdr_leg="B", cdr_carrier_leg="true", cdr_call_id="guard-a-48",
                cdr_leg_attempt="1", cdr_customer_id="20", cdr_product_type="rcf"),
             "callflow": [{"caller_profile": {
                 "uuid": "guard-b-48", "destination_number": "+17744045256",
                 "originator": {"originator_caller_profiles": [{"uuid": "guard-a-48"}]}}}]}
        r = await client.post("/v1/cdrs/ingest", json=b)
        assert r.status_code == 200
        assert r.json()["status"] == "b_leg"
        assert r.json()["detail"].startswith("dropped: schema behind")
        after = (await db.fetch_one("SELECT COUNT(*) AS n FROM cdrs"))["n"]
        assert after == before

    _run(go())
    errs = [rec for rec in caplog.records if rec.levelno == logging.ERROR
            and "migration-48" in rec.getMessage()]
    assert len(errs) == 1 and "48_cdr_call_legs.sql" in errs[0].getMessage()


def test_pg_after_applying_48_pre50_tier_lands_a_and_b(guard_db, client, caplog):
    """48 applied, 50 NOT: the A-leg lands through the 60-param (pre-50) tier
    with leg/call_id, a carrier B row lands too (it keeps `leg` on that
    tier), the missing refresh function is logged, never fatal."""
    _reset_fallback_rate_limit()

    async def go():
        async with guard_db["owner"].acquire() as conn:
            await apply_cdr_column_migrations(conn, names=("48_cdr_call_legs.sql",))
        r = await client.get("/health/detailed")
        assert r.json()["components"]["schema"].startswith(
            "degraded: cdrs is missing column(s) quality_status, quality_grade")
        assert REMEDY_50 in r.json()["components"]["schema"]
        with caplog.at_level(logging.DEBUG, logger="routers.cdrs"):
            r = await client.post("/v1/cdrs/ingest", json={
                "variables": _a_leg_vars("guard-a-60")})
            assert r.json()["status"] == "ok", r.text
            b = {"variables": _a_leg_vars(
                    "guard-b-60", originating_leg_uuid="guard-a-60", direction="outbound",
                    cdr_leg="B", cdr_carrier_leg="true", cdr_call_id="guard-a-60",
                    cdr_leg_attempt="1", cdr_customer_id="20", cdr_product_type="rcf"),
                 "callflow": [{"caller_profile": {
                     "uuid": "guard-b-60", "destination_number": "+17744045256",
                     "originator": {"originator_caller_profiles": [{"uuid": "guard-a-60"}]}}}]}
            r = await client.post("/v1/cdrs/ingest", json=b)
            assert r.status_code == 200 and r.json()["detail"] == "inserted", r.text
        row = await db.fetch_one(
            "SELECT leg, call_id, leg_attempt FROM cdrs WHERE uuid = $1", "guard-a-60")
        assert (row["leg"], row["call_id"], row["leg_attempt"]) == ("A", "guard-a-60", None)
        row = await db.fetch_one(
            "SELECT leg, call_id, leg_attempt FROM cdrs WHERE uuid = $1", "guard-b-60")
        assert (row["leg"], row["call_id"], row["leg_attempt"]) == ("B", "guard-a-60", 1)
        # rows written by the earlier tiers stay legacy-shaped (leg NULL)
        row = await db.fetch_one("SELECT leg FROM cdrs WHERE uuid = $1", "guard-a-48")
        assert row["leg"] is None

    _run(go())
    errs = [rec.getMessage() for rec in caplog.records if rec.levelno == logging.ERROR]
    assert sum("migration-50" in m for m in errs) == 1
    assert any("cdr_refresh_call_quality() is missing" in m for m in errs)


def test_pg_after_applying_50_full_73_param_insert_and_refresh(guard_db, client):
    async def go():
        async with guard_db["owner"].acquire() as conn:
            await apply_cdr_column_migrations(conn, names=("50_cdr_quality_accuracy.sql",))
        r = await client.get("/health/detailed")
        assert r.json()["components"]["schema"] == "healthy"
        assert (await schema_check.check_cdr_schema())["status"] == "ok"
        r = await client.post("/v1/cdrs/ingest", json={
            "variables": _a_leg_vars("guard-a-73", rtp_audio_in_packet_count="1250",
                                     rtp_audio_in_jitter_loss_rate="0.0",
                                     rtp_audio_in_mos="4.50",
                                     rtp_audio_in_skip_packet_count="9")})
        assert r.json()["status"] == "ok", r.text
        row = await db.fetch_one(
            "SELECT leg, quality_status, quality_grade, quality_source, mos, fs_mos, "
            "packet_loss_count, rtp_audio_in_skip_packet_count, call_quality_status, "
            "call_quality_grade, call_mos, call_quality_leg FROM cdrs WHERE uuid = $1",
            "guard-a-73")
        assert row["leg"] == "A"
        assert (row["quality_status"], row["quality_grade"], row["quality_source"]) == (
            "rated", "great", "fs_legacy")
        assert float(row["mos"]) == 4.41 and float(row["fs_mos"]) == 4.50
        assert row["packet_loss_count"] == 0 and row["rtp_audio_in_skip_packet_count"] == 9
        # the refresh ran after the INSERT (A-only call -> call = A)
        assert (row["call_quality_status"], row["call_quality_grade"],
                float(row["call_mos"]), row["call_quality_leg"]) == ("rated", "great", 4.41, "A")

    _run(go())


def test_fake_db_pre48_tier_is_strict_tail_truncation(monkeypatch, caplog):
    """Missing 48 only: full(73) -> pre-48(57); the 57 params are exactly the
    first 57 of the full tuple and the SQL tops out at $57."""
    calls = []

    async def fake(sql, *params):
        calls.append((sql, params))
        if "INSERT INTO cdrs" in sql and "leg_attempt" in sql:
            raise asyncpg.exceptions.UndefinedColumnError(
                'column "leg" of relation "cdrs" does not exist')
        return "INSERT 0 1"

    monkeypatch.setattr(db, "execute", fake)
    _reset_fallback_rate_limit()
    r = asyncio.run(cdrs._process_cdr_body({"variables": _a_leg_vars("fake-48")}))
    assert r["status"] == "ok"
    ins = [(s, p) for s, p in calls if "INSERT INTO cdrs" in s]
    assert len(ins) == 2
    (full_sql, full_p), (pre_sql, pre_p) = ins
    assert len(full_p) == 73 and len(pre_p) == 57 and pre_p == full_p[:57]
    assert "stir_outcome" in pre_sql and "leg_attempt" not in pre_sql
    assert max(int(x) for x in re.findall(r"\$(\d+)", pre_sql)) == 57


def test_fake_db_neither_47_nor_48_falls_to_55(monkeypatch):
    """Missing 47 AND 48: PostgreSQL names the FIRST missing column
    (stir_outcome) -> straight to the 55-param tier."""
    calls = []

    async def fake(sql, *params):
        calls.append((sql, params))
        if "INSERT INTO cdrs" in sql and "stir_outcome" in sql:
            raise asyncpg.exceptions.UndefinedColumnError(
                'column "stir_outcome" of relation "cdrs" does not exist')
        return "INSERT 0 1"

    monkeypatch.setattr(db, "execute", fake)
    _reset_fallback_rate_limit()
    r = asyncio.run(cdrs._process_cdr_body({"variables": _a_leg_vars("fake-55")}))
    assert r["status"] == "ok"
    ins = [p for s, p in calls if "INSERT INTO cdrs" in s]
    assert [len(p) for p in ins] == [73, 55]


def test_fake_db_pre48_then_pre47(monkeypatch):
    """48 reported first (e.g. 47 dropped by hand after 48?) — the pre-48
    retry then names a 47 column and the 55 tier lands the row."""
    calls = []

    async def fake(sql, *params):
        calls.append((sql, params))
        if "INSERT INTO cdrs" in sql and "leg_attempt" in sql:
            raise asyncpg.exceptions.UndefinedColumnError(
                'column "call_id" of relation "cdrs" does not exist')
        if "INSERT INTO cdrs" in sql and "stir_outcome" in sql:
            raise asyncpg.exceptions.UndefinedColumnError(
                'column "stir_eff_actual" of relation "cdrs" does not exist')
        return "INSERT 0 1"

    monkeypatch.setattr(db, "execute", fake)
    _reset_fallback_rate_limit()
    r = asyncio.run(cdrs._process_cdr_body({"variables": _a_leg_vars("fake-3t")}))
    assert r["status"] == "ok"
    assert [len(p) for s, p in calls if "INSERT INTO cdrs" in s] == [73, 57, 55]


def test_insert_tiers_are_strict_tail_truncations():
    full, pre50 = cdrs._CDR_INSERT_SQL, cdrs._CDR_INSERT_SQL_PRE50
    pre48, pre47 = cdrs._CDR_INSERT_SQL_PRE48, cdrs._CDR_INSERT_SQL_PRE47
    top = lambda q: max(int(x) for x in re.findall(r"\$(\d+)", q))  # noqa: E731
    assert (top(full), top(pre50), top(pre48), top(pre47)) == (73, 60, 57, 55)
    assert "$58::varchar, $59::varchar, $60::smallint" in full
    assert "$58::varchar, $59::varchar, $60::smallint" in pre50
    assert "quality_status" in full and "quality_status" not in pre50
    # the 13 migration-50 binds, in contract order, each explicitly cast
    tail = re.findall(r"\$(6[1-9]|7[0-3])::(\w+)", full)
    assert [(int(n), t) for n, t in tail] == [
        (61, "varchar"), (62, "varchar"), (63, "varchar"), (64, "numeric"),
        (65, "numeric"), (66, "numeric"), (67, "int"), (68, "int"), (69, "int"),
        (70, "int"), (71, "smallint"), (72, "numeric"), (73, "numeric")]
    with pytest.raises(ValueError):
        cdrs._cdr_insert_sql(with_stir_outcome=False, with_call_legs=True)
    with pytest.raises(ValueError):
        cdrs._cdr_insert_sql(True, False, True)


def test_fake_db_pre50_tier_is_strict_tail_truncation(monkeypatch, caplog):
    """Missing 50 only: full(73) -> pre-50(60); the 60 params are exactly the
    first 60, ERROR names migration 50 once per interval, the refresh call
    that follows can never break ingest."""
    calls = []

    async def fake(sql, *params):
        calls.append((sql, params))
        if "INSERT INTO cdrs" in sql and "quality_status" in sql:
            raise asyncpg.exceptions.UndefinedColumnError(
                'column "quality_status" of relation "cdrs" does not exist')
        return "INSERT 0 1"

    async def fake_fetch_one(sql, *args):
        raise asyncpg.exceptions.UndefinedFunctionError(
            "function cdr_refresh_call_quality(character varying, timestamp with time zone) does not exist")

    monkeypatch.setattr(db, "execute", fake)
    monkeypatch.setattr(db, "fetch_one", fake_fetch_one)
    _reset_fallback_rate_limit()
    with caplog.at_level(logging.DEBUG, logger="routers.cdrs"):
        r = asyncio.run(cdrs._process_cdr_body({"variables": _a_leg_vars("fake-50")}))
        r2 = asyncio.run(cdrs._process_cdr_body({"variables": _a_leg_vars("fake-50b")}))
    assert r["status"] == "ok" and r2["status"] == "ok"
    ins = [(s, p) for s, p in calls if "INSERT INTO cdrs" in s]
    assert [len(p) for _, p in ins] == [73, 60, 73, 60]
    assert ins[1][1] == ins[0][1][:60]
    assert max(int(x) for x in re.findall(r"\$(\d+)", ins[1][0])) == 60
    errs = [rec.getMessage() for rec in caplog.records if rec.levelno == logging.ERROR]
    assert sum("migration-50" in m for m in errs) == 1
    assert sum("cdr_refresh_call_quality() is missing" in m for m in errs) == 1
    assert any("50_cdr_quality_accuracy.sql" in m for m in errs)


def test_fake_db_b_leg_uses_pre50_but_never_below(monkeypatch):
    """Carrier B rows keep `leg` on the pre-50 tier (allowed) but are never
    written by the 57/55 tiers (dropped instead)."""
    async def fake_50(sql, *params):
        if "INSERT INTO cdrs" in sql and "quality_status" in sql:
            raise asyncpg.exceptions.UndefinedColumnError(
                'column "quality_status" of relation "cdrs" does not exist')
        return "INSERT 0 1"

    monkeypatch.setattr(db, "execute", fake_50)
    params = tuple(range(73))
    assert asyncio.run(cdrs._execute_cdr_insert("b", params, allow_fallback=False)) == "INSERT 0 1"

    async def fake_48(sql, *params):
        if "INSERT INTO cdrs" in sql and "leg_attempt" in sql:
            raise asyncpg.exceptions.UndefinedColumnError(
                'column "leg" of relation "cdrs" does not exist')
        return "INSERT 0 1"

    monkeypatch.setattr(db, "execute", fake_48)
    with pytest.raises(asyncpg.exceptions.UndefinedColumnError):
        asyncio.run(cdrs._execute_cdr_insert("b", params, allow_fallback=False))
