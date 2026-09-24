"""CDR A/B leg split — docs/CDR_LEG_SPLIT_CONTRACT.md (wins over the plan).

Covers, against a REAL ephemeral PostgreSQL 16 (vanilla — TimescaleDB-only
SQL is exercised through its no-Timescale branch) behind the REAL JWT
middleware with minted JWTs:

  Ingest (/v1/cdrs/ingest):
    * A-leg writes leg='A', call_id=uuid, leg_attempt NULL; ms precision from
      billmsec/mduration (+ uepoch timestamps); seconds x 1000 fallback.
    * carrier B-leg (cdr_leg=B + cdr_carrier_leg=true) inserts a leg='B' row
      whose attribution comes ONLY from cdr_* vars (never ingest defaults);
      its timing/destination are its own; dedup on uuid.
    * B-leg missing cdr_customer_id / cdr_call_id / cdr_product_type is
      logged + dropped; non-carrier B-leg -> no row; CDR_B_LEG_ROWS=false ->
      no row; cdr_leg=B leaking onto a topology A-leg keeps the A row.
    * STIR outcome UPDATE onto the A-leg only from an ANSWERED carrier B-leg;
      call_attestations written by the A-leg only.
  Read side:
    * /v1/cdrs list + total + /summary count one row per call; staff
      `leg=calls|all|b`; tenants ignore `leg` and `call_id`.
    * staff `call_id=` returns every leg of a call regardless of the date
      window, capped at CALL_ID_LOOKUP_LIMIT; staff rows carry leg/call_id/
      leg_attempt, tenant rows never.
    * /v1/sbc/stats and /v1/search/did/{did}/calls count one row per call.
    * tenant minutes = talk time (end - answer), not ring-inclusive duration.
  Migrations:
    * 48 idempotent; 49 run twice through the real `psql` binary with
      ON_ERROR_STOP (no-Timescale branch: plain partial index; CAGG skipped).
  scripts/backup/asr_guard.sh: leg predicate, no direction dependency.

Run: python3 -m pytest tests/test_cdr_leg_split.py -q
"""
import asyncio
import logging
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
os.environ.setdefault("ENV", "development")

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "docker" / "api" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import config  # noqa: E402
from services import tenant_redaction as tr  # noqa: E402

INIT = REPO / "docker" / "postgres" / "init"


# ---------------------------------------------------------------------------
# Pure / static
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("val,expected", [
    (None, True), ("", True), ("true", True), ("1", True), ("off", True),
    ("false", False), ("FALSE", False), (" false ", False),
])
def test_cdr_b_leg_rows_flag_on_unless_false(monkeypatch, val, expected):
    if val is None:
        monkeypatch.delenv("CDR_B_LEG_ROWS", raising=False)
    else:
        monkeypatch.setenv("CDR_B_LEG_ROWS", val)
    assert config.cdr_b_leg_rows_enabled() is expected


def test_talk_ms_python_twin():
    t = datetime(2026, 9, 1, 12, 0, 0, tzinfo=timezone.utc)
    assert tr.talk_ms(t, t + timedelta(seconds=50, milliseconds=250)) == 50_250
    assert tr.talk_ms(None, t) == 0
    assert tr.talk_ms(t, t - timedelta(seconds=1)) == 0


def test_migration_48_form():
    sql = (INIT / "48_cdr_call_legs.sql").read_text()
    code = "\n".join(line.split("--", 1)[0] for line in sql.splitlines())
    for col, typ in (("leg", "VARCHAR(1)"), ("call_id", "VARCHAR(64)"),
                     ("leg_attempt", "SMALLINT")):
        assert re.search(rf"ADD COLUMN IF NOT EXISTS {col}\s+{re.escape(typ)}", code), col
    assert "DEFAULT" not in code.upper()          # metadata-only on compressed chunks
    assert "DROP COLUMN" not in code.upper()
    assert "CREATE INDEX" not in code.upper()     # index is migration 49


def test_migration_49_form():
    sql = (INIT / "49_cdr_call_legs_index_cagg.sql").read_text()
    assert "WITH (timescaledb.transaction_per_chunk)" in sql
    assert "timescaledb.materialized_only = false" in sql
    assert "WHERE leg IS DISTINCT FROM 'B'" in sql
    assert "CALL refresh_continuous_aggregate('cdr_hourly_stats', NULL, NULL);" in sql
    assert "GRANT SELECT ON cdr_hourly_stats TO api" in sql
    assert "GRANT SELECT ON cdr_hourly_stats TO grafana_ro" in sql
    # the refresh must NOT sit inside the BEGIN/COMMIT (not allowed in a txn)
    begin, commit = sql.index("\nBEGIN;"), sql.index("\nCOMMIT;")
    assert not (begin < sql.index("CALL refresh_continuous_aggregate") < commit)
    assert begin < sql.index("DROP MATERIALIZED VIEW IF EXISTS cdr_hourly_stats") < commit
    # column list identical to 05 (consumers unchanged)
    for col in ("total_calls", "answered_calls", "total_duration_sec", "total_cost",
                "avg_duration_sec"):
        assert f"as {col}" in sql


def test_asr_guard_uses_leg_predicate_not_direction():
    sh = (REPO / "scripts" / "backup" / "asr_guard.sh").read_text()
    code = "\n".join(ln for ln in sh.splitlines() if not ln.lstrip().startswith("#"))
    assert "leg IS DISTINCT FROM 'B'" in code
    assert "direction" not in code
    assert "column_name = 'leg'" in code          # pre-48 safe probe
    subprocess.run(["bash", "-n", str(REPO / "scripts" / "backup" / "asr_guard.sh")],
                   check=True)


# ---------------------------------------------------------------------------
# Integration
# ---------------------------------------------------------------------------
asyncpg = pytest.importorskip("asyncpg")
httpx = pytest.importorskip("httpx")

from cdr_schema import apply_cdr_column_migrations  # noqa: E402
from test_tenant_redaction import _SCHEMA, _EphemeralPG, _find_pg_bin  # noqa: E402

PG_BIN = _find_pg_bin()


class _LegPG(_EphemeralPG):
    def __init__(self, pg_bin):
        super().__init__(pg_bin)
        self.port = 55441     # distinct from every other module (reports 55440)


_LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


CID_A, CID_B = 101, 202
TRUNK_A = 71
T0 = 1_788_000_000          # 2026-08-29-ish, fixed epoch for ingest bodies


@pytest.fixture(scope="module")
def leg_db():
    if PG_BIN is None:
        pytest.skip("no local PostgreSQL binaries; set TEST_PG_BIN to run")
    pg = _LegPG(PG_BIN)
    try:
        pg.start()
    except Exception as e:  # noqa: BLE001
        pg.stop()
        pytest.skip(f"could not start throwaway PostgreSQL: {e}")
    from db import database as db

    async def _setup():
        owner = await asyncpg.create_pool(
            host=pg.sock, port=pg.port, user="postgres", database="postgres",
            min_size=1, max_size=2, statement_cache_size=0)
        async with owner.acquire() as conn:
            await conn.execute(_SCHEMA)
            await conn.execute("ALTER TABLE call_attestations ADD COLUMN sip_call_id TEXT")
            await conn.execute("CREATE INDEX idx_cdrs_uuid ON cdrs(uuid)")
            await apply_cdr_column_migrations(conn)
            await conn.execute("GRANT ALL ON ALL TABLES IN SCHEMA public TO api")
            await conn.execute(
                "INSERT INTO sip_trunks (id, customer_id, trunk_name, max_channels, cps_limit) "
                "VALUES ($1, $2, 'alpha', 10, 5)", TRUNK_A, CID_A)
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
        yield {"db": db, "pg": pg}
    finally:
        _run(_teardown())
        pg.stop()


@pytest.fixture(scope="module")
def client(leg_db):
    from fastapi import FastAPI
    from middleware.auth import JWTAuthMiddleware
    from routers import cdrs, sbc, search, trunks
    import services.esl_client as esl

    async def _no_esl(*_a, **_k):
        return None

    esl._send_esl_command = _no_esl
    app = FastAPI()
    app.add_middleware(JWTAuthMiddleware)
    app.include_router(cdrs.router, prefix="/v1/cdrs")
    app.include_router(sbc.router, prefix="/v1/sbc")
    app.include_router(search.router, prefix="/v1/search")
    app.include_router(trunks.router, prefix="/v1/trunks")
    c = httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
                          base_url="http://test")
    try:
        yield c
    finally:
        _run(c.aclose())


@pytest.fixture(scope="module")
def tokens(leg_db):
    from auth.security import create_access_token

    def mint(sub, role, cid):
        return create_access_token(
            {"sub": sub, "email": f"{sub}@t.local", "role": role, "customer_id": cid})

    return {"admin": mint("1", "admin", None), "support": mint("2", "support", None),
            "user_a": mint("3", "user", CID_A)}


def _h(tokens, who):
    return {"Authorization": f"Bearer {tokens[who]}"}


def _a_leg(uuid, *, start=T0, ring=4, talk=50, answered=True, **extra):
    """FreeSWITCH A-leg body (RCF inbound). ms vars carry sub-second parts."""
    v = {
        "uuid": uuid, "direction": "inbound", "product_type": "rcf",
        "destination_number": "+16174544217", "caller_id_number": "+15087282017",
        "customer_id": str(CID_A), "trunk_id": str(TRUNK_A),
        "start_epoch": str(start), "start_uepoch": str(start * 1_000_000 + 250_000),
        "end_epoch": str(start + ring + talk),
        "end_uepoch": str((start + ring + talk) * 1_000_000 + 750_000),
        "answer_epoch": str(start + ring) if answered else "0",
        "answer_uepoch": str((start + ring) * 1_000_000 + 400_000) if answered else "0",
        "duration": str(ring + talk), "mduration": str((ring + talk) * 1000 + 500),
        "billsec": str(talk) if answered else "0",
        "billmsec": str(talk * 1000 + 350) if answered else "0",
        "hangup_cause": "NORMAL_CLEARING" if answered else "NO_ANSWER",
        "sip_h_X-SBC-ID": "east-sbc-1",
        "origin_customer_id": str(CID_A), "terminating_customer_id": str(CID_A),
        "on_net": "false",
        "stir_attest_intent": "div", "stir_inbound_signed": "1",
    }
    v.update(extra)
    return {"variables": v, "callflow": [{"caller_profile": {
        "uuid": uuid, "destination_number": v["destination_number"],
        "caller_id_number": v["caller_id_number"],
        "originatee": {"originatee_caller_profiles": [{"uuid": uuid + "-b"}]}}}]}


def _b_leg(uuid, a_uuid, attempt, *, start=T0 + 1, ring=3, talk=50, answered=True,
           cdr=True, drop=(), **extra):
    """FreeSWITCH B-leg body (originator profile) with the contract's cdr_*
    dial-string vars. The B channel's OWN vars carry misleading attribution
    (customer_id, direction, product_type) to prove they are never used."""
    v = {
        "uuid": uuid, "direction": "outbound", "customer_id": "999",
        "product_type": "trunk", "destination_number": "+17744045256",
        "caller_id_number": "+15087282017", "originating_leg_uuid": a_uuid,
        "start_epoch": str(start), "end_epoch": str(start + ring + talk),
        "answer_epoch": str(start + ring) if answered else "0",
        "duration": str(ring + talk), "mduration": str((ring + talk) * 1000 + 100),
        "billsec": str(talk) if answered else "0",
        "billmsec": str(talk * 1000 + 350) if answered else "0",
        "hangup_cause": "NORMAL_CLEARING" if answered else "USER_BUSY",
        "sip_rh_X-Stir-Outcome": "eff=div;mode=relay;identities=1;base=1;div=1;stripped=0",
        "stir_attest_intent": "div", "stir_inbound_signed": "1",
    }
    if cdr:
        v.update({
            "cdr_leg": "B", "cdr_carrier_leg": "true", "cdr_call_id": a_uuid,
            "cdr_leg_attempt": str(attempt), "cdr_direction": "outbound",
            "cdr_customer_id": str(CID_A), "cdr_product_type": "rcf",
            "cdr_trunk_id": str(TRUNK_A), "cdr_on_net": "false", "cdr_on_net_hops": "0",
            "cdr_origin_customer_id": str(CID_A),
            "cdr_terminating_customer_id": str(CID_A),
            "cdr_inbound_carrier": "sinch", "cdr_inbound_carrier_pop": "denver",
            "cdr_sbc_id": "east-sbc-1",
        })
    for k in drop:
        v.pop(k, None)
    v.update(extra)
    return {"variables": v, "callflow": [{"caller_profile": {
        "uuid": uuid, "destination_number": v["destination_number"],
        "originator": {"originator_caller_profiles": [{"uuid": a_uuid}]}}}]}


async def _post(client, body):
    r = await client.post("/v1/cdrs/ingest", json=body)
    assert r.status_code == 200, r.text        # gotcha 11: ALWAYS 200
    return r.json()


async def _row(db, uuid):
    return await db.fetch_one("SELECT * FROM cdrs WHERE uuid = $1", uuid)


async def _count(db, where="TRUE", *args):
    return (await db.fetch_one(f"SELECT count(*) AS n FROM cdrs WHERE {where}", *args))["n"]


# ---- ingest ----------------------------------------------------------------
def test_a_leg_writes_leg_call_id_and_ms_precision(leg_db, client):
    db = leg_db["db"]

    async def go():
        r = await _post(client, _a_leg("ing-a-1"))
        assert r["status"] == "ok"
        row = await _row(db, "ing-a-1")
        assert (row["leg"], row["call_id"], row["leg_attempt"]) == ("A", "ing-a-1", None)
        assert row["billable_ms"] == 50_350          # billmsec, not billsec*1000
        assert row["duration_ms"] == 54_500          # mduration
        assert row["start_time"].microsecond == 250_000   # uepoch precision
        assert row["answer_time"].microsecond == 400_000
        # fallback: no ms vars -> seconds x 1000
        body = _a_leg("ing-a-2")
        for k in ("billmsec", "mduration", "start_uepoch", "end_uepoch", "answer_uepoch"):
            del body["variables"][k]
        assert (await _post(client, body))["status"] == "ok"
        row = await _row(db, "ing-a-2")
        assert (row["billable_ms"], row["duration_ms"]) == (50_000, 54_000)
        assert row["start_time"].microsecond == 0
        # A-leg attestation row written
        assert await db.fetch_one(
            "SELECT 1 FROM call_attestations WHERE call_id = $1", "ing-a-1")

    _run(go())


def test_carrier_b_leg_inserts_row_from_cdr_vars_only(leg_db, client):
    db = leg_db["db"]

    async def go():
        await _post(client, _a_leg("ing-a-3"))
        # failed attempt 1 (unanswered), answered attempt 2
        r1 = await _post(client, _b_leg("ing-b-3-1", "ing-a-3", 1, answered=False, talk=0))
        r2 = await _post(client, _b_leg("ing-b-3-2", "ing-a-3", 2))
        assert (r1["status"], r1["detail"]) == ("b_leg", "inserted")
        assert (r2["status"], r2["detail"]) == ("b_leg", "inserted")
        b = await _row(db, "ing-b-3-2")
        assert (b["leg"], b["call_id"], b["leg_attempt"]) == ("B", "ing-a-3", 2)
        assert b["direction"] == "outbound"
        assert b["customer_id"] == CID_A          # cdr_customer_id, NOT the B var 999
        assert b["product_type"] == "rcf"         # cdr_product_type, NOT 'trunk'
        assert b["trunk_id"] == TRUNK_A
        assert (b["origin_customer_id"], b["terminating_customer_id"]) == (CID_A, CID_A)
        assert (b["on_net"], b["on_net_hops"]) == (False, 0)
        assert (b["inbound_carrier"], b["inbound_carrier_pop"], b["sbc_id"]) == (
            "sinch", "denver", "east-sbc-1")
        assert b["destination"] == "+17744045256"  # the B leg's own destination
        assert b["billable_ms"] == 50_350
        assert b["stir_eff_actual"] == "div"       # its OWN wire outcome
        b1 = await _row(db, "ing-b-3-1")
        assert b1["answer_time"] is None and b1["billable_ms"] == 0 and b1["leg_attempt"] == 1
        # dedup on the B uuid
        r = await _post(client, _b_leg("ing-b-3-2", "ing-a-3", 2))
        assert r["detail"] == "duplicate"
        assert await _count(db, "call_id = $1", "ing-a-3") == 3
        # attestation: A-leg only — no row keyed by a B uuid
        assert await db.fetch_one(
            "SELECT 1 FROM call_attestations WHERE call_id LIKE 'ing-b-%'") is None

    _run(go())


@pytest.mark.parametrize("missing", ["cdr_customer_id", "cdr_call_id", "cdr_product_type"])
def test_b_leg_missing_required_cdr_vars_is_dropped(leg_db, client, missing, caplog):
    db = leg_db["db"]

    async def go():
        uuid = f"ing-b-miss-{missing}"
        with caplog.at_level(logging.ERROR, logger="routers.cdrs"):
            r = await _post(client, _b_leg(uuid, "ing-a-3", 3, drop=(missing,)))
        assert r["status"] == "b_leg" and r["detail"].startswith("dropped: missing")
        assert missing in r["detail"]
        assert await _row(db, uuid) is None
        assert await _count(db, "customer_id = 0") == 0     # never an ingest default
        assert any("DROPPED" in m for m in caplog.messages)

    _run(go())


def test_non_carrier_b_leg_and_flag_off_insert_nothing(leg_db, client, monkeypatch):
    db = leg_db["db"]

    async def go():
        # on-net / PBX delivery B-leg: no cdr_* vars at all
        r = await _post(client, _b_leg("ing-b-pbx", "ing-a-3", 1, cdr=False))
        assert r["status"] == "b_leg" and "no row" in r["detail"]
        assert await _row(db, "ing-b-pbx") is None
        # cdr_leg=B but cdr_carrier_leg absent -> not a carrier leg
        r = await _post(client, _b_leg("ing-b-nocarrier", "ing-a-3", 1,
                                       drop=("cdr_carrier_leg",)))
        assert await _row(db, "ing-b-nocarrier") is None
        # CDR_B_LEG_ROWS=false -> no row
        monkeypatch.setenv("CDR_B_LEG_ROWS", "false")
        r = await _post(client, _b_leg("ing-b-flagoff", "ing-a-3", 4))
        assert r["status"] == "b_leg"
        assert await _row(db, "ing-b-flagoff") is None

    _run(go())


def test_cdr_leg_b_leaking_onto_a_leg_keeps_the_call_row(leg_db, client, caplog):
    """`export` without `nolocal:` would put cdr_leg=B on the A-leg itself:
    FreeSWITCH still calls it an A-leg (no originator) -> keep it as leg='A'."""
    db = leg_db["db"]

    async def go():
        body = _a_leg("ing-a-leak", cdr_leg="B", cdr_carrier_leg="true",
                      cdr_call_id="ing-a-leak", cdr_customer_id=str(CID_A),
                      cdr_product_type="rcf")
        with caplog.at_level(logging.ERROR, logger="routers.cdrs"):
            r = await _post(client, body)
        assert r["status"] == "ok"
        row = await _row(db, "ing-a-leak")
        assert (row["leg"], row["call_id"], row["direction"]) == ("A", "ing-a-leak", "inbound")
        assert any("leaking onto the A-leg" in m for m in caplog.messages)

    _run(go())


def test_stir_update_only_from_answered_carrier_b_leg(leg_db, client):
    db = leg_db["db"]

    async def go():
        await _post(client, _a_leg("ing-a-stir", stir_outcome="eff=B;mode=base"))
        # failed attempt carries a DIFFERENT outcome — must not overwrite
        r = await _post(client, _b_leg(
            "ing-b-stir-1", "ing-a-stir", 1, answered=False, talk=0,
            **{"sip_rh_X-Stir-Outcome": "eff=unsigned;mode=base;identities=0"}))
        assert r["detail"] == "inserted" and "no stir update" in r["stir"]
        assert (await _row(db, "ing-a-stir"))["stir_eff_actual"] == "B"
        # non-carrier answered B-leg — no update either
        await _post(client, _b_leg(
            "ing-b-stir-pbx", "ing-a-stir", 1, cdr=False,
            **{"sip_rh_X-Stir-Outcome": "eff=C;mode=gateway-C;identities=1"}))
        assert (await _row(db, "ing-a-stir"))["stir_eff_actual"] == "B"
        # the answered carrier leg wins
        r = await _post(client, _b_leg("ing-b-stir-2", "ing-a-stir", 2))
        assert r["stir"] == "updated"
        assert (await _row(db, "ing-a-stir"))["stir_eff_actual"] == "div"

    _run(go())


def test_bulk_ingest_tallies_b_rows_as_b_leg(leg_db, client):
    async def go():
        r = await client.post("/v1/cdrs/ingest/bulk", json=[
            _a_leg("bulk-a-1"), _b_leg("bulk-b-1", "bulk-a-1", 1)])
        body = r.json()
        assert (body["ok"], body["b_leg"], body["error"]) == (1, 1, 0)

    _run(go())


# ---- read side ---------------------------------------------------------------
@pytest.fixture(scope="module")
def read_seed(leg_db):
    """Direct-SQL seed at NOW so the default 24h window applies: two calls
    for tenant A, each with carrier B rows, + tenant B's call. Also a legacy
    (leg NULL) row and an OLD call (outside any default window)."""
    db = leg_db["db"]
    now = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(minutes=5)

    async def seed():
        async def ins(uuid, cid, start, answered, *, leg, call_id=None, attempt=None,
                      direction="inbound", ring=40, talk=50, sbc="east-sbc-1"):
            ans = start + timedelta(seconds=ring) if answered else None
            end = start + timedelta(seconds=ring + (talk if answered else 0))
            await db.execute(
                "INSERT INTO cdrs (uuid, customer_id, product_type, trunk_id, direction,"
                " caller_id, destination, start_time, answer_time, end_time, duration_ms,"
                " billable_ms, hangup_cause, sbc_id, leg, call_id, leg_attempt)"
                " VALUES ($1,$2,'rcf',$3,$4,'+15087282017','+16174544217',$5,$6,$7,$8,$9,"
                " 'NORMAL_CLEARING',$10,$11,$12,$13)",
                uuid, cid, TRUNK_A if cid == CID_A else None, direction, start, ans, end,
                (ring + (talk if answered else 0)) * 1000, (talk * 1000) if answered else 0,
                sbc, leg, call_id, attempt)

        await ins("rd-a-1", CID_A, now - timedelta(minutes=20), True, leg="A", call_id="rd-a-1")
        await ins("rd-b-1-1", CID_A, now - timedelta(minutes=20) + timedelta(seconds=1), False,
                  leg="B", call_id="rd-a-1", attempt=1, direction="outbound")
        await ins("rd-b-1-2", CID_A, now - timedelta(minutes=20) + timedelta(seconds=2), True,
                  leg="B", call_id="rd-a-1", attempt=2, direction="outbound")
        await ins("rd-a-2", CID_A, now - timedelta(minutes=30), True, leg="A", call_id="rd-a-2")
        await ins("rd-b-2-1", CID_A, now - timedelta(minutes=30) + timedelta(seconds=1), True,
                  leg="B", call_id="rd-a-2", attempt=1, direction="outbound")
        await ins("rd-legacy", CID_A, now - timedelta(minutes=40), False, leg=None)
        await ins("rd-bcust", CID_B, now - timedelta(minutes=10), True, leg="A", call_id="rd-bcust")
        # a call from 10 days ago with its B leg — only reachable via call_id=
        await ins("rd-old-a", CID_A, now - timedelta(days=10), True, leg="A", call_id="rd-old-a")
        await ins("rd-old-b", CID_A, now - timedelta(days=10) + timedelta(seconds=1), True,
                  leg="B", call_id="rd-old-a", attempt=1, direction="outbound")

    _run(seed())
    # rows the ingest tests created sit at T0 (2026-08), outside the default
    # 24h window, so the read tests below see exactly this seed.
    return now


def _uuids(resp):
    return {c["uuid"] for c in resp.json()["cdrs"]}


def test_staff_list_default_counts_calls_once(read_seed, client, tokens):
    async def go():
        for who in ("admin", "support"):
            r = await client.get("/v1/cdrs", headers=_h(tokens, who))
            assert r.status_code == 200, r.text
            assert _uuids(r) == {"rd-a-1", "rd-a-2", "rd-legacy", "rd-bcust"}
            assert r.json()["total"] == 4
            row = {c["uuid"]: c for c in r.json()["cdrs"]}
            assert (row["rd-a-1"]["leg"], row["rd-a-1"]["call_id"],
                    row["rd-a-1"]["leg_attempt"]) == ("A", "rd-a-1", None)
            # legacy row: canonical identity COALESCE(call_id, uuid)
            assert (row["rd-legacy"]["leg"], row["rd-legacy"]["call_id"]) == (None, "rd-legacy")

    _run(go())


def test_staff_leg_param_all_and_b(read_seed, client, tokens):
    async def go():
        h = _h(tokens, "admin")
        r = await client.get("/v1/cdrs", params={"leg": "all"}, headers=h)
        assert r.json()["total"] == 7
        r = await client.get("/v1/cdrs", params={"leg": "b"}, headers=h)
        assert _uuids(r) == {"rd-b-1-1", "rd-b-1-2", "rd-b-2-1"}
        b = {c["uuid"]: c for c in r.json()["cdrs"]}["rd-b-1-2"]
        assert (b["leg"], b["call_id"], b["leg_attempt"]) == ("B", "rd-a-1", 2)
        r = await client.get("/v1/cdrs", params={"leg": "nope"}, headers=h)
        assert r.status_code == 422
        # summary honors the same param
        s = await client.get("/v1/cdrs/summary", params={"group_by": "hour"}, headers=h)
        assert sum(x["total_calls"] for x in s.json()["summary"]) == 4
        s = await client.get("/v1/cdrs/summary", params={"group_by": "hour", "leg": "all"},
                             headers=h)
        assert sum(x["total_calls"] for x in s.json()["summary"]) == 7
        for gb in ("day", "destination"):
            s = await client.get("/v1/cdrs/summary", params={"group_by": gb}, headers=h)
            assert sum(x["total_calls"] for x in s.json()["summary"]) == 4, gb

    _run(go())


def test_staff_call_id_param_ignores_date_window(read_seed, client, tokens):
    async def go():
        h = _h(tokens, "admin")
        r = await client.get("/v1/cdrs", params={"leg": "all", "call_id": "rd-old-a"},
                             headers=h)
        assert r.status_code == 200, r.text
        assert _uuids(r) == {"rd-old-a", "rd-old-b"}      # 10 days old, no dates sent
        # even an explicit narrow window is ignored when call_id is set
        now = datetime.now(timezone.utc)
        r = await client.get("/v1/cdrs", params={
            "leg": "all", "call_id": "rd-a-1",
            "start_date": (now - timedelta(minutes=1)).isoformat(),
            "end_date": now.isoformat()}, headers=h)
        assert _uuids(r) == {"rd-a-1", "rd-b-1-1", "rd-b-1-2"}
        assert r.json()["total"] == 3
        # default leg=calls with call_id -> just the call row
        r = await client.get("/v1/cdrs", params={"call_id": "rd-a-1"}, headers=h)
        assert _uuids(r) == {"rd-a-1"}
        # a B uuid resolves to that one B row ((call_id = $n OR uuid = $n))
        r = await client.get("/v1/cdrs", params={"leg": "all", "call_id": "rd-b-1-2"},
                             headers=h)
        assert _uuids(r) == {"rd-b-1-2"}
        # page capped at CALL_ID_LOOKUP_LIMIT
        from routers import cdrs as cdrs_router
        r = await client.get("/v1/cdrs", params={"leg": "all", "call_id": "rd-a-1",
                                                 "limit": 1000}, headers=h)
        assert r.json()["limit"] == cdrs_router.CALL_ID_LOOKUP_LIMIT
        s = await client.get("/v1/cdrs/summary", params={
            "group_by": "hour", "leg": "all", "call_id": "rd-old-a"}, headers=h)
        assert sum(x["total_calls"] for x in s.json()["summary"]) == 2

    _run(go())


def test_tenant_ignores_leg_and_call_id(read_seed, client, tokens):
    async def go():
        h = _h(tokens, "user_a")
        base = await client.get("/v1/cdrs", headers=h)
        assert _uuids(base) == {"rd-a-1", "rd-a-2", "rd-legacy"}
        for params in ({"leg": "all"}, {"leg": "b"}, {"call_id": "rd-old-a", "leg": "all"}):
            r = await client.get("/v1/cdrs", params=params, headers=h)
            assert r.status_code == 200, r.text
            assert _uuids(r) == _uuids(base), params
            for c in r.json()["cdrs"]:
                assert not ({"leg", "call_id", "leg_attempt"} & set(c))
                assert set(c) <= tr.TENANT_CDR_FIELDS
            s = await client.get("/v1/cdrs/summary", params={**params, "group_by": "day"},
                                 headers=h)
            assert sum(x["total_calls"] for x in s.json()["summary"]) == 3, params
        r = await client.get("/v1/cdrs/rd-b-1-2", headers=h)
        assert r.status_code == 404
        # staff detail of a B row carries the leg fields
        r = await client.get("/v1/cdrs/rd-b-1-2", headers=_h(tokens, "admin"))
        assert (r.json()["leg"], r.json()["call_id"], r.json()["leg_attempt"]) == (
            "B", "rd-a-1", 2)

    _run(go())


def test_tenant_minutes_are_talk_time_not_duration(read_seed, client, tokens):
    """Seeded calls ring 40 s + talk 50 s: duration_ms = 90 s (-> 2 min half-up),
    talk = 50 s (-> 1 min). Tenants must see 1."""
    async def go():
        h = _h(tokens, "user_a")
        rows = {c["uuid"]: c for c in (await client.get("/v1/cdrs", headers=h)).json()["cdrs"]}
        assert rows["rd-a-1"]["duration_minutes"] == 1
        assert rows["rd-legacy"]["duration_minutes"] == 0
        s = await client.get("/v1/cdrs/summary", params={"group_by": "destination"},
                             headers=h)
        (row,) = s.json()["summary"]
        assert row["total_calls"] == 3 and row["answered_calls"] == 2
        assert row["total_minutes"] == 2           # 100 s talk, rounded once
        assert row["avg_duration_minutes"] == 1.0
        r = await client.get(f"/v1/trunks/{TRUNK_A}/stats", headers=h)
        lh = r.json()["last_hour"]
        assert (lh["total_calls"], lh["answered_calls"]) == (3, 2)
        assert lh["avg_duration_minutes"] == 1.0
        # staff trunk stats also one row per call (B rows would add 3)
        r = await client.get(f"/v1/trunks/{TRUNK_A}/stats", headers=_h(tokens, "admin"))
        assert r.json()["last_hour"]["total_calls"] == 3

    _run(go())


def test_sbc_stats_and_did_search_count_calls_once(read_seed, client, tokens):
    async def go():
        h = _h(tokens, "admin")
        r = await client.get("/v1/sbc/stats", params={"minutes": 120}, headers=h)
        assert r.status_code == 200, r.text
        assert r.json()["total_calls"] == 4
        r = await client.get("/v1/search/did/+16174544217/calls", headers=h)
        assert r.status_code == 200, r.text
        uu = {c["uuid"] for c in r.json()["calls"]}
        assert not any(u.startswith(("rd-b-", "ing-b-", "rd-old-b", "bulk-b")) for u in uu)
        assert {"rd-a-1", "rd-a-2", "rd-legacy", "rd-old-a"} <= uu

    _run(go())


# ---- migration 49 via the real psql binary ------------------------------------
def test_migration_49_runs_twice_via_psql_no_timescale(leg_db):
    pg = leg_db["pg"]
    psql = Path(PG_BIN, "psql")
    if not psql.exists():
        pytest.skip("psql binary not found")
    cmd = [str(psql), "-X", "-h", pg.sock, "-p", str(pg.port), "-U", "postgres",
           "-d", "postgres", "-v", "ON_ERROR_STOP=on",
           "-f", str(INIT / "49_cdr_call_legs_index_cagg.sql")]
    for _ in range(2):                    # re-runnable
        out = subprocess.run(cmd, capture_output=True, text=True)
        assert out.returncode == 0, out.stderr
        assert "TimescaleDB not installed" in out.stdout + out.stderr

    async def check():
        db = leg_db["db"]
        row = await db.fetch_one(
            "SELECT i.indisvalid, pg_get_indexdef(i.indexrelid) AS def FROM pg_index i "
            "JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'idx_cdrs_call_id'")
        assert row is not None and row["indisvalid"]
        assert "WHERE (call_id IS NOT NULL)" in row["def"]
        plan = await db.fetch_all(
            "EXPLAIN SELECT * FROM cdrs WHERE call_id = 'x' OR uuid = 'x'")
        assert plan  # planner accepts the OR shape (index choice is data-dependent)

    _run(check())


def test_migration_49_refuses_without_48(tmp_path):
    """On a DB without cdrs.call_id the script stops (ON_ERROR_STOP) before
    touching anything."""
    if PG_BIN is None or not Path(PG_BIN, "psql").exists():
        pytest.skip("no psql")
    pg = _EphemeralPG(PG_BIN)
    pg.port = 55443
    try:
        pg.start()
        base = [str(Path(PG_BIN, "psql")), "-X", "-h", pg.sock, "-p", str(pg.port),
                "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=on"]
        subprocess.run(base + ["-c", "CREATE TABLE cdrs (id int, uuid varchar(64))"],
                       check=True, capture_output=True)
        out = subprocess.run(base + ["-f", str(INIT / "49_cdr_call_legs_index_cagg.sql")],
                             capture_output=True, text=True)
        assert out.returncode != 0
        assert "apply 48_cdr_call_legs.sql first" in out.stdout + out.stderr
    finally:
        pg.stop()


# ---- call-quality (migration 50, docs/CALL_QUALITY_ACCURACY_PLAN.md §C) ------
# Legacy-image quality vars: 50 s talk at 20 ms = 2500 expected packets.
_CLEAN_IN = {"rtp_audio_in_packet_count": "2500", "rtp_audio_in_jitter_loss_rate": "0",
             "rtp_audio_in_mos": "4.50", "read_codec": "PCMU"}
_LOSSY_IN = {"rtp_audio_in_packet_count": "2500", "rtp_audio_in_jitter_loss_rate": "0.05",
             "rtp_audio_in_mos": "4.50", "read_codec": "PCMU"}
# Silent INBOUND while we sent full audio out = true one-way (no_rtp). With
# nothing sent either it would be no_media (migration 51), not one-way.
_SILENT_IN = {"rtp_audio_in_packet_count": "0", "rtp_audio_out_packet_count": "2500",
              "rtp_audio_in_mos": "4.50"}


@pytest.mark.parametrize("order", ["a_first", "b_first"])
def test_b_leg_ingest_refreshes_call_quality_either_order(leg_db, client, order):
    """B-leg loss makes the CALL grade worse regardless of CDR arrival order:
    both ingests run cdr_refresh_call_quality() after their INSERT."""
    db = leg_db["db"]
    a_uuid, b_uuid = f"cq-a-{order}", f"cq-b-{order}"
    start = T0 + 10_000 + (0 if order == "a_first" else 1_000)

    async def go():
        a = _a_leg(a_uuid, start=start, **_CLEAN_IN)
        failed = _b_leg(f"{b_uuid}-1", a_uuid, 1, start=start + 1, answered=False, talk=0,
                        **_SILENT_IN)
        b = _b_leg(b_uuid, a_uuid, 2, start=start + 2, **_LOSSY_IN)
        bodies = [a, failed, b] if order == "a_first" else [failed, b, a]
        for body in bodies:
            r = await _post(client, body)
            assert r["status"] in ("ok", "b_leg") and r.get("detail") != "dropped", r
        row = await _row(db, a_uuid)
        assert (row["quality_status"], row["quality_grade"], float(row["mos"])) == (
            "rated", "great", 4.41)
        brow = await _row(db, b_uuid)
        assert (brow["quality_status"], brow["quality_grade"], float(brow["mos"])) == (
            "rated", "fair", 3.92)
        assert brow["call_quality_status"] is None          # call_* live on the A row only
        assert (row["call_quality_status"], row["call_quality_grade"],
                float(row["call_mos"]), row["call_quality_leg"]) == ("rated", "fair", 3.92, "B")
        # the failed attempt (unanswered, silent) never counts
        f = await _row(db, f"{b_uuid}-1")
        assert f["quality_status"] == "unanswered" and f["mos"] is None
        # a duplicate re-ingest re-runs the idempotent refresh, same answer
        assert (await _post(client, a))["status"] == "duplicate"
        row = await _row(db, a_uuid)
        assert row["call_quality_grade"] == "fair"

    _run(go())


def test_one_way_b_leg_makes_the_call_no_rtp(leg_db, client, tokens):
    """Callee->platform silent (the caller heard nothing) -> call no_rtp/poor,
    call_mos NULL; the staff detail exposes both directions."""
    db = leg_db["db"]
    a_uuid, b_uuid = "cq-a-oneway", "cq-b-oneway"
    start = T0 + 20_000

    async def go():
        await _post(client, _a_leg(a_uuid, start=start, **_CLEAN_IN))
        await _post(client, _b_leg(b_uuid, a_uuid, 1, start=start + 1, **_SILENT_IN))
        row = await _row(db, a_uuid)
        assert (row["call_quality_status"], row["call_quality_grade"], row["call_mos"],
                row["call_quality_leg"]) == ("no_rtp", "poor", None, "B")
        r = await client.get(f"/v1/cdrs/{a_uuid}", headers=_h(tokens, "admin"))
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["call_quality_grade"] == "poor" and body["call_mos"] is None
        qbd = body["quality_by_direction"]
        assert qbd["caller_audio"]["quality_grade"] == "great"
        assert qbd["caller_audio"]["mos"] == 4.41 and qbd["caller_audio"]["uuid"] == a_uuid
        assert qbd["callee_audio"]["quality_status"] == "no_rtp"
        assert qbd["callee_audio"]["mos"] is None and qbd["callee_audio"]["uuid"] == b_uuid
        assert qbd["callee_audio"]["fs_mos"] == 4.5 and qbd["callee_audio"]["quality_source"] == "fs_legacy"
        # the B row's own detail carries no direction block
        r = await client.get(f"/v1/cdrs/{b_uuid}", headers=_h(tokens, "admin"))
        assert r.json()["quality_by_direction"] is None
        # the staff list carries the call-level columns (floated)
        r = await client.get("/v1/cdrs", params={"call_id": a_uuid, "leg": "all"},
                             headers=_h(tokens, "admin"))
        rows = {c["uuid"]: c for c in r.json()["cdrs"]}
        assert rows[a_uuid]["call_quality_status"] == "no_rtp"
        assert rows[a_uuid]["mos"] == 4.41 and isinstance(rows[a_uuid]["mos"], float)

    _run(go())


def test_b_leg_uses_pre50_tier_but_never_below(monkeypatch):
    """Fake db: without migration 50 a carrier B row still lands (60 params,
    keeps `leg`); a B row is never written by the pre-48 (57) tier."""
    import asyncpg as _apg
    from db import database as db
    from routers import cdrs

    calls = []

    async def fake_execute(sql, *params):
        calls.append((sql, params))
        if "INSERT INTO cdrs" in sql and "quality_status" in sql:
            raise _apg.exceptions.UndefinedColumnError(
                'column "quality_status" of relation "cdrs" does not exist')
        return "INSERT 0 1"

    async def fake_fetch_one(sql, *args):
        return None

    monkeypatch.setattr(db, "execute", fake_execute)
    monkeypatch.setattr(db, "fetch_one", fake_fetch_one)
    r = asyncio.run(cdrs._process_cdr_body(_b_leg("fk-b-50", "fk-a-50", 1)))
    assert (r["status"], r["detail"]) == ("b_leg", "inserted"), r
    ins = [p for s, p in calls if "INSERT INTO cdrs" in s]
    assert [len(p) for p in ins] == [73, 60]
    assert ins[1][57:60] == ("B", "fk-a-50", 1)
