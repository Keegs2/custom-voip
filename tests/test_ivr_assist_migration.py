"""Migration 61_ivr_assist.sql on an ephemeral PostgreSQL 16.

Real init scripts (voicemail_db prerequisites: 02/03/09/17/20/22/24/31/34),
54 + 56, 59, then 61 applied TWICE (idempotency). Proves (contract
docs/IVR_ASSIST_INTERFACES.md §8/§9):

  * customers.ivr_assist_enabled exists, NOT NULL, default false;
  * ivr_assist_jobs: the contract columns and types, the state-machine
    CHECKs, at most ONE running job per flow (unique partial index), the
    same-customer flow FK, cascades on flow / customer delete, user SET NULL;
  * the daily-cap / conversation / retention indexes exist;
  * grants: api has DML, freeswitch / grafana_ro / PUBLIC nothing;
  * 61 refuses to run without 59; check_migrations reports 61; the header
    carries the exact apply command.
"""
from __future__ import annotations

import asyncio
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest

asyncpg = pytest.importorskip("asyncpg", reason="asyncpg required")

REPO = Path(__file__).resolve().parents[1]
INIT = REPO / "docker" / "postgres" / "init"
sys.path.insert(0, str(Path(__file__).resolve().parent))

from voicemail_db import (  # noqa: E402
    CHECK_MIGRATIONS, EphemeralPG, apply_prerequisites, apply_voicemail_schema, find_pg_bin,
)

PG_BIN = find_pg_bin()
PORT = 55522  # IVR range 55520-55529
_LOOP = asyncio.new_event_loop()
MIG_59 = INIT / "59_ivr.sql"
MIG_61 = INIT / "61_ivr_assist.sql"


T0 = datetime(2026, 10, 25, tzinfo=timezone.utc)
T1 = datetime(2026, 10, 25, 0, 1, tzinfo=timezone.utc)


def run(coro):
    return _LOOP.run_until_complete(coro)


async def owner(pg, database="postgres"):
    return await asyncpg.connect(host=pg.sock, port=pg.port, user="postgres",
                                 database=database, statement_cache_size=0)


@pytest.fixture(scope="module")
def pg():
    if PG_BIN is None:
        pytest.skip("no local PostgreSQL binaries; set TEST_PG_BIN to run")
    server = EphemeralPG(PG_BIN, PORT)
    try:
        server.start()
    except Exception as e:  # noqa: BLE001
        server.stop()
        pytest.skip(f"could not start throwaway PostgreSQL: {e}")

    async def setup():
        conn = await owner(server)
        try:
            await apply_prerequisites(conn)
            await apply_voicemail_schema(conn)
            await conn.execute(MIG_59.read_text())
            await conn.execute(
                """
                INSERT INTO customers (id, name, account_type, status) VALUES
                  (11, 'Acme', 'rcf', 'active'), (12, 'Beta', 'rcf', 'active');
                INSERT INTO users (id, email, password_hash, customer_id, role, name) VALUES
                  (70, 'u70@test', 'x', 11, 'user', 'U');
                INSERT INTO call_flows (id, customer_id, name, draft_graph) VALUES
                  (1, 11, 'Main', '{}'), (2, 11, 'Second', '{}'), (3, 12, 'Beta', '{}');
                """)
            for _ in range(2):  # idempotent
                await conn.execute(MIG_61.read_text())
        finally:
            await conn.close()

    run(setup())
    try:
        yield server
    finally:
        server.stop()


def job_sql(**over) -> tuple[str, list]:
    row = {"id": str(uuid.uuid4()), "customer_id": 11, "flow_id": 1, "user_id": 70,
           "conversation_id": str(uuid.uuid4()), "status": "running", "message": "hello",
           "error_code": None, "finished_at": None, "outcome": None, "outcome_at": None,
           "rounds": 0}
    row.update(over)
    cols = list(row)
    casts = {"id": "uuid", "customer_id": "int", "flow_id": "bigint", "user_id": "int",
             "conversation_id": "uuid", "status": "varchar", "message": "text",
             "error_code": "varchar", "finished_at": "timestamptz", "outcome": "varchar",
             "outcome_at": "timestamptz", "rounds": "smallint"}
    vals = ", ".join(f"${i + 1}::{casts[c]}" for i, c in enumerate(cols))
    return (f"INSERT INTO ivr_assist_jobs ({', '.join(cols)}) VALUES ({vals})",
            [row[c] for c in cols])


def test_header_has_the_apply_command_and_check_row():
    txt = MIG_61.read_text()
    assert ("hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v "
            "ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/61_ivr_assist.sql") in txt
    assert "SET LOCAL lock_timeout = '5s';" in txt
    assert "('61_ivr_assist'," in CHECK_MIGRATIONS.read_text()


def test_columns_and_defaults(pg):
    async def go():
        conn = await owner(pg)
        try:
            col = await conn.fetchrow(
                "SELECT is_nullable, column_default, data_type FROM information_schema.columns "
                "WHERE table_name = 'customers' AND column_name = 'ivr_assist_enabled'")
            assert (col["is_nullable"], col["column_default"], col["data_type"]) == \
                ("NO", "false", "boolean")
            assert await conn.fetchval("SELECT ivr_assist_enabled FROM customers WHERE id = 11") \
                is False
            types = {r["column_name"]: r["data_type"] for r in await conn.fetch(
                "SELECT column_name, data_type FROM information_schema.columns "
                "WHERE table_name = 'ivr_assist_jobs'")}
            assert types == {
                "id": "uuid", "customer_id": "integer", "flow_id": "bigint",
                "user_id": "integer", "conversation_id": "uuid",
                "status": "character varying", "message": "text", "result": "jsonb",
                "error_code": "character varying", "rounds": "smallint",
                "ted_request_ids": "ARRAY", "outcome": "character varying",
                "created_at": "timestamp with time zone",
                "finished_at": "timestamp with time zone",
                "outcome_at": "timestamp with time zone"}
            for idx in ("idx_ivr_assist_jobs_customer_created", "uq_ivr_assist_jobs_running_flow",
                        "idx_ivr_assist_jobs_conversation", "idx_ivr_assist_jobs_created"):
                assert await conn.fetchval("SELECT to_regclass($1) IS NOT NULL", idx), idx
            assert "WHERE" in await conn.fetchval(
                "SELECT pg_get_indexdef('uq_ivr_assist_jobs_running_flow'::regclass)")
        finally:
            await conn.close()

    run(go())


def test_state_machine_checks(pg):
    async def go():
        conn = await owner(pg)
        try:
            bad = [
                {"status": "queued"},
                {"message": ""},
                {"message": "x" * 2001},
                {"status": "failed"},                                      # no error_code
                {"error_code": "assistant_failed"},                        # running + code
                {"status": "done", "finished_at": None},
                {"status": "running", "finished_at": T0},
                {"status": "failed", "error_code": "boom", "finished_at": T0},
                {"rounds": 4},
                {"status": "done", "finished_at": T0, "outcome": "kept",
                 "outcome_at": T0},
                {"status": "done", "finished_at": T0, "outcome": "accepted"},
                {"outcome": "accepted", "outcome_at": T0},   # running
            ]
            for over in bad:
                sql, args = job_sql(flow_id=2, **over)
                with pytest.raises(asyncpg.CheckViolationError):
                    await conn.execute(sql, *args)
            sql, args = job_sql(flow_id=2, status="done", finished_at=T0,
                                outcome="accepted", outcome_at=T1,
                                rounds=3)
            await conn.execute(sql, *args)
            with pytest.raises(asyncpg.CheckViolationError):
                await conn.execute(
                    "UPDATE ivr_assist_jobs SET ted_request_ids = ARRAY['a','b','c','d'] "
                    "WHERE flow_id = 2")
            with pytest.raises(asyncpg.CheckViolationError):
                await conn.execute("UPDATE ivr_assist_jobs SET result = '[]' WHERE flow_id = 2")
        finally:
            await conn.close()

    run(go())


def test_one_running_job_per_flow_and_same_customer_fk(pg):
    async def go():
        conn = await owner(pg)
        try:
            sql, args = job_sql(flow_id=1)
            await conn.execute(sql, *args)
            sql, args = job_sql(flow_id=1)
            with pytest.raises(asyncpg.UniqueViolationError):
                await conn.execute(sql, *args)
            # a finished job does not block a new running one
            await conn.execute("UPDATE ivr_assist_jobs SET status = 'done', finished_at = now() "
                               "WHERE flow_id = 1")
            await conn.execute(sql, *args)
            # flow 3 belongs to customer 12: a customer-11 job on it is refused
            sql, args = job_sql(flow_id=3, customer_id=11)
            with pytest.raises(asyncpg.ForeignKeyViolationError):
                await conn.execute(sql, *args)
        finally:
            await conn.close()

    run(go())


def test_cascades(pg):
    async def go():
        conn = await owner(pg)
        try:
            await conn.execute("INSERT INTO call_flows (id, customer_id, name, draft_graph) "
                               "VALUES (9, 12, 'Gone soon', '{}')")
            await conn.execute("INSERT INTO users (id, email, password_hash, customer_id, role, "
                               "name) VALUES (71, 'u71@test', 'x', 12, 'user', 'U')")
            sql, args = job_sql(flow_id=9, customer_id=12, user_id=71)
            await conn.execute(sql, *args)
            await conn.execute("DELETE FROM users WHERE id = 71")
            assert await conn.fetchval(
                "SELECT user_id FROM ivr_assist_jobs WHERE flow_id = 9") is None
            await conn.execute("DELETE FROM call_flows WHERE id = 9")
            assert await conn.fetchval(
                "SELECT count(*) FROM ivr_assist_jobs WHERE flow_id = 9") == 0
        finally:
            await conn.close()

    run(go())


def test_grants(pg):
    async def go():
        conn = await owner(pg)
        try:
            def has(role, priv):
                return conn.fetchval("SELECT has_table_privilege($1, 'ivr_assist_jobs', $2)",
                                     role, priv)

            for priv in ("SELECT", "INSERT", "UPDATE", "DELETE"):
                assert await has("api", priv) is True, priv
            for role in ("freeswitch", "grafana_ro", "public"):
                for priv in ("SELECT", "INSERT", "UPDATE", "DELETE"):
                    assert await has(role, priv) is False, (role, priv)
        finally:
            await conn.close()
        fs = await asyncpg.connect(host=pg.sock, port=pg.port, user="freeswitch",
                                   password="fs_secret", database="postgres",
                                   statement_cache_size=0)
        try:
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await fs.fetch("SELECT message FROM ivr_assist_jobs")
        finally:
            await fs.close()

    run(go())


def test_check_migrations_reports_61(pg):
    async def go():
        conn = await owner(pg)
        try:
            status = {r["migration"]: r["status"]
                      for r in await conn.fetch(CHECK_MIGRATIONS.read_text())}
            assert status["61_ivr_assist"] == "applied"
            assert status["59_ivr"] == "applied"
        finally:
            await conn.close()

    run(go())


def test_61_refuses_without_59(pg):
    async def go():
        conn = await owner(pg)
        try:
            await conn.execute("CREATE DATABASE no59")
        finally:
            await conn.close()
        c2 = await owner(pg, "no59")
        try:
            for name in ("02_schema_core.sql", "09_schema_users.sql"):
                await c2.execute((INIT / name).read_text())
            with pytest.raises(asyncpg.RaiseError, match="requires 59_ivr.sql"):
                await c2.execute(MIG_61.read_text())
            await c2.execute("ROLLBACK")      # the script's BEGIN is left aborted
            assert await c2.fetchval("SELECT to_regclass('public.ivr_assist_jobs')") is None
            status = {r["migration"]: r["status"]
                      for r in await c2.fetch(CHECK_MIGRATIONS.read_text())}
            assert status["61_ivr_assist"] == "*** MISSING ***"
        finally:
            await c2.close()

    run(go())
