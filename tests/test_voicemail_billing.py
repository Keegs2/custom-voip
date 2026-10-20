"""Voicemail CDRs are not billed in v1 (decision D5).

* ``rate_cdr()`` — the LATEST definition is 05_schema_cdr.sql (no later
  migration redefines it); migration 54 re-creates it BYTE-FOR-BYTE plus a
  voicemail clause. Proven textually (strip the marked clause + its DECLARE
  line => 05's text exactly) and functionally on an ephemeral PostgreSQL 16
  with the REAL 04 rate tables, the REAL 05 ``cdrs`` table / ``get_rate`` /
  ``rate_cdr`` (minus the TimescaleDB-only statements), then migration 54:
  a voicemail CDR rates to 0 (rated_at set, billable 0, balance untouched,
  a second call returns NULL like any rated CDR); an RCF CDR is rated exactly
  as the pre-54 function rated it and still debits the balance.
* CDR ingest: ``product_type='voicemail'`` (9 chars, cdrs.product_type is
  VARCHAR(10), no CHECK) is bound through unchanged with direction inbound.

Run:  JWT_SECRET_KEY=x python -m pytest tests/test_voicemail_billing.py -q
"""
import asyncio
import re
import sys
from decimal import Decimal
from pathlib import Path

import pytest

asyncpg = pytest.importorskip("asyncpg", reason="asyncpg required")

REPO = Path(__file__).resolve().parents[1]
INIT = REPO / "docker" / "postgres" / "init"
sys.path.insert(0, str(REPO / "docker" / "api" / "src"))

from voicemail_db import EphemeralPG, apply_54, apply_prerequisites, find_pg_bin  # noqa: E402

PG_BIN = find_pg_bin()
PORT = 55475
_LOOP = asyncio.new_event_loop()

SRC_05 = (INIT / "05_schema_cdr.sql").read_text()
SRC_54 = (INIT / "54_voicemail.sql").read_text()


def _block(src: str, start_marker: str, end_marker: str) -> str:
    start = src.index(start_marker)
    end = src.index(end_marker, start) + len(end_marker)
    return src[start:end]


def _rate_cdr(src: str) -> str:
    start = src.index("CREATE OR REPLACE FUNCTION rate_cdr(p_uuid VARCHAR(64))")
    end = src.index("$$;", src.index("END;", start)) + 3
    return src[start:end]


CDRS_TABLE_05 = _block(SRC_05, "CREATE TABLE cdrs (", "\n);")
GET_RATE_05 = _block(SRC_05, "CREATE OR REPLACE FUNCTION get_rate", "$$;")
RATE_CDR_05 = _rate_cdr(SRC_05)
RATE_CDR_54 = _rate_cdr(SRC_54)


def run(coro):
    return _LOOP.run_until_complete(coro)


def test_54_rate_cdr_is_05_plus_only_the_voicemail_clause():
    clause = re.compile(
        r"\n    -- >>> 54_voicemail\.sql \(decision D5[^\n]*\n.*?    -- <<< 54_voicemail\.sql <<<\n",
        re.S)
    assert len(clause.findall(RATE_CDR_54)) == 1
    stripped = clause.sub("", RATE_CDR_54)
    stripped = stripped.replace("    v_product_type VARCHAR;  -- 54_voicemail.sql (D5)\n", "", 1)
    assert stripped == RATE_CDR_05
    # Only 05 and 54 define it (54 is the latest definition).
    definers = sorted(p.name for p in INIT.glob("*.sql")
                      if "FUNCTION rate_cdr" in p.read_text())
    assert definers == ["05_schema_cdr.sql", "54_voicemail.sql"]


def _ingest_variables(**overrides):
    v = {"uuid": "vm-cdr-1", "direction": "inbound", "product_type": "voicemail",
         "destination_number": "+16175550101", "caller_id_number": "+15085551212",
         "start_epoch": "1700000000", "end_epoch": "1700000040", "answer_epoch": "1700000001",
         "duration": "40", "billsec": "39", "hangup_cause": "NORMAL_CLEARING",
         "customer_id": "101", "vm_mailbox_id": "7", "vm_result": "stored"}
    v.update(overrides)
    return v


def test_cdr_ingest_binds_voicemail_product_type(monkeypatch):
    from db import database as db
    from routers import cdrs

    captured = {}

    async def fake_execute(sql, *params):
        if "INSERT INTO cdrs" in sql:
            captured["params"] = params
        return "INSERT 0 1"

    async def fake_fetch_one(sql, *params):
        return None

    monkeypatch.setattr(db, "execute", fake_execute)
    monkeypatch.setattr(db, "fetch_one", fake_fetch_one)
    result = _LOOP.run_until_complete(cdrs._process_cdr_body({"variables": _ingest_variables()}))
    assert result["status"] == "ok", result
    p = captured["params"]
    assert p[1] == 101 and p[2] == "voicemail" and p[4] == "inbound"
    assert len("voicemail") <= 10  # cdrs.product_type VARCHAR(10)


@pytest.fixture(scope="module")
def bill_db():
    if PG_BIN is None:
        pytest.skip("no local PostgreSQL binaries; set TEST_PG_BIN to run billing tests")
    pg = EphemeralPG(PG_BIN, PORT)
    try:
        pg.start()
    except Exception as e:  # noqa: BLE001
        pg.stop()
        pytest.skip(f"could not start throwaway PostgreSQL: {e}")
    state = {"pg": pg}

    async def setup():
        conn = await asyncpg.connect(host=pg.sock, port=pg.port, user="postgres",
                                     database="postgres", statement_cache_size=0)
        try:
            await apply_prerequisites(conn)
            await conn.execute((INIT / "04_schema_fraud.sql").read_text())
            await conn.execute(CDRS_TABLE_05)
            await conn.execute(GET_RATE_05)
            await conn.execute(RATE_CDR_05)
            await conn.execute("GRANT ALL ON cdrs TO api; GRANT USAGE, SELECT ON cdrs_id_seq TO api;"
                               "GRANT EXECUTE ON FUNCTION rate_cdr TO api;"
                               "GRANT EXECUTE ON FUNCTION get_rate TO api;")
            await conn.execute(
                "INSERT INTO rate_tables (id, name, is_default) VALUES (1, 'Default', true);"
                "INSERT INTO rates (rate_table_id, prefix, rate_per_min, cost_per_min, increment) "
                "VALUES (1, '+1', 0.02, 0.005, 6);"
                "INSERT INTO customers (id, name, account_type, balance) VALUES "
                "(101, 'VM Billing', 'rcf', 100);")
            # The PRE-54 function's result for an RCF CDR (the baseline).
            await _insert_cdr(conn, "rcf-before", "rcf")
            state["before_cost"] = await conn.fetchval("SELECT rate_cdr('rcf-before')")
            state["before_row"] = dict(await conn.fetchrow(
                "SELECT billable_ms, rate_per_min, total_cost, carrier_cost, margin "
                "FROM cdrs WHERE uuid = 'rcf-before'"))
            await conn.execute("UPDATE customers SET balance = 100 WHERE id = 101")
            await apply_54(conn)
            await apply_54(conn)  # idempotent
        finally:
            await conn.close()

    run(setup())
    try:
        yield state
    finally:
        pg.stop()


async def _insert_cdr(conn, uuid, product_type, duration_ms=40000):
    await conn.execute(
        "INSERT INTO cdrs (uuid, customer_id, product_type, direction, caller_id, destination, "
        "start_time, answer_time, end_time, duration_ms, billable_ms) VALUES "
        "($1, 101, $2, 'inbound', '+15085551212', '+16175550101', now() - interval '1 minute', "
        "now() - interval '59 seconds', now(), $3, $3)", uuid, product_type, duration_ms)


async def _api(pg):
    return await asyncpg.connect(host=pg.sock, port=pg.port, user="api", password="api_secret",
                                 database="postgres", statement_cache_size=0)


def test_voicemail_cdr_rates_to_zero(bill_db):
    async def go():
        conn = await _api(bill_db["pg"])
        try:
            await _insert_cdr(conn, "vm-1", "voicemail")
            cost = await conn.fetchval("SELECT rate_cdr('vm-1')")
            assert cost == 0
            row = await conn.fetchrow("SELECT * FROM cdrs WHERE uuid = 'vm-1'")
            assert row["rated_at"] is not None
            assert row["total_cost"] == 0 and row["rate_per_min"] == 0
            assert row["carrier_cost"] == 0 and row["margin"] == 0 and row["billable_ms"] == 0
            assert await conn.fetchval("SELECT balance FROM customers WHERE id = 101") == 100
            # Already rated -> NULL (the POST /cdrs/{uuid}/rate 404 path), no double work.
            assert await conn.fetchval("SELECT rate_cdr('vm-1')") is None
            assert await conn.fetchval("SELECT rate_cdr('no-such-uuid')") is None
        finally:
            await conn.close()

    run(go())


def test_non_voicemail_cdr_rated_exactly_as_before(bill_db):
    async def go():
        conn = await _api(bill_db["pg"])
        try:
            await _insert_cdr(conn, "rcf-after", "rcf")
            cost = await conn.fetchval("SELECT rate_cdr('rcf-after')")
            assert cost == bill_db["before_cost"] and cost > 0
            row = dict(await conn.fetchrow(
                "SELECT billable_ms, rate_per_min, total_cost, carrier_cost, margin "
                "FROM cdrs WHERE uuid = 'rcf-after'"))
            assert row == bill_db["before_row"]
            assert await conn.fetchval("SELECT balance FROM customers WHERE id = 101") == \
                Decimal(100) - cost
            await conn.execute("UPDATE customers SET balance = 100 WHERE id = 101")
        finally:
            await conn.close()

    run(go())
