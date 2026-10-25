"""Migrations 59_ivr.sql + 60_cdr_ivr.sql on an ephemeral PostgreSQL 16.

Real init scripts (voicemail_db prerequisites: 02/03/09/17/20/22/24/31/34),
the REAL 04 rate tables + 05 ``cdrs`` / ``get_rate`` / ``rate_cdr`` (minus the
TimescaleDB-only statements), 54 + 56, then 59 and 60 each applied TWICE
(idempotency). Proves:

  * every pre-existing number_routing row (rcf / api / trunk / voicemail) is
    byte-identical before and after 59, and the view's column types are kept;
  * the 'ivr' arm and ivr_fs_number semantics (contract §1.1);
  * did_inventory's product CHECK keeps every old value and admits 'ivr';
  * grants: freeswitch SELECTs ivr_fs_number + ivr_prompt_audio ONLY;
    grafana_ro and PUBLIC get nothing; api has DML;
  * the extra guards: same-customer flow binding, same-flow publish,
    immutable versions, prompt -> audio FK, audio CHECKs, flow delete cascade;
  * rate_cdr() = 54's text + only the 59 clause; ivr CDRs rate to 0;
  * 59 refuses to run without 54; check_migrations reports 59 / 60.
"""
from __future__ import annotations

import asyncio
import hashlib
import re
import sys
from decimal import Decimal
from pathlib import Path

import pytest

asyncpg = pytest.importorskip("asyncpg", reason="asyncpg required")

REPO = Path(__file__).resolve().parents[1]
INIT = REPO / "docker" / "postgres" / "init"
sys.path.insert(0, str(REPO / "docker" / "api" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from voicemail_db import (  # noqa: E402
    CHECK_MIGRATIONS, EphemeralPG, apply_prerequisites, apply_voicemail_schema, find_pg_bin,
)

PG_BIN = find_pg_bin()
PORT = 55520  # distinct from every other test module (IVR range 55520-55529)
_LOOP = asyncio.new_event_loop()

MIG_59 = INIT / "59_ivr.sql"
MIG_60 = INIT / "60_cdr_ivr.sql"
SRC_05 = (INIT / "05_schema_cdr.sql").read_text()
SRC_54 = (INIT / "54_voicemail.sql").read_text()
SRC_59 = MIG_59.read_text()


def run(coro):
    return _LOOP.run_until_complete(coro)


def _block(src: str, start: str, end: str) -> str:
    i = src.index(start)
    return src[i:src.index(end, i) + len(end)]


def _rate_cdr(src: str) -> str:
    start = src.index("CREATE OR REPLACE FUNCTION rate_cdr(p_uuid VARCHAR(64))")
    end = src.index("$$;", src.index("END;", start)) + 3
    return src[start:end]


def _view_arms(src: str) -> str:
    """The number_routing definition text from CREATE to the voicemail arm's end."""
    return _block(src, "CREATE OR REPLACE VIEW number_routing AS",
                  "    WHERE b.status <> 'deleted'")


SHA_A = hashlib.sha256(b"a").hexdigest()
SHA_B = hashlib.sha256(b"b").hexdigest()
WAV = b"RIFF" + b"\x00" * 42                       # 46 bytes, the CHECK's minimum


@pytest.fixture(scope="module")
def mig_db():
    if PG_BIN is None:
        pytest.skip("no local PostgreSQL binaries; set TEST_PG_BIN to run")
    pg = EphemeralPG(PG_BIN, PORT)
    try:
        pg.start()
    except Exception as e:  # noqa: BLE001
        pg.stop()
        pytest.skip(f"could not start throwaway PostgreSQL: {e}")
    state = {"pg": pg}

    async def setup():
        conn = await owner(pg)
        try:
            await apply_prerequisites(conn)
            await conn.execute((INIT / "04_schema_fraud.sql").read_text())
            await conn.execute(_block(SRC_05, "CREATE TABLE cdrs (", "\n);"))
            await conn.execute(_block(SRC_05, "CREATE OR REPLACE FUNCTION get_rate", "$$;"))
            await conn.execute(_rate_cdr(SRC_05))
            await conn.execute("GRANT ALL ON cdrs TO api; GRANT USAGE, SELECT ON cdrs_id_seq TO api;"
                               "GRANT EXECUTE ON FUNCTION get_rate TO api;")
            await apply_voicemail_schema(conn)
            await conn.execute(
                """
                INSERT INTO customers (id, name, account_type, status, balance) VALUES
                  (11, 'Acme', 'rcf', 'active', 100), (12, 'Beta', 'trunk', 'active', 100),
                  (13, 'Gone', 'rcf', 'suspended', 0);
                INSERT INTO rcf_numbers (customer_id, did, name, forward_to, max_channels)
                  VALUES (11, '+16175550101', 'Front desk', '+17744045256', 3),
                         (12, '+16175550102', NULL, '1001', 0);
                INSERT INTO api_dids (customer_id, did, voice_url) VALUES
                  (11, '+16175550103', 'https://example.invalid/voice');
                INSERT INTO sip_trunks (id, customer_id, trunk_name, max_channels)
                  VALUES (1, 12, 'PBX', 23);
                INSERT INTO trunk_dids (trunk_id, did) VALUES (1, '+16175550104');
                UPDATE customers SET voicemail_enabled = true WHERE id = 11;
                INSERT INTO voicemail_boxes (customer_id, did, label) VALUES
                  (11, '+16175550105', 'Main box');
                INSERT INTO voicemail_boxes (customer_id, did, label, status) VALUES
                  (11, '+16175550106', 'Paused', 'suspended');
                INSERT INTO did_inventory (did, status, product_type, customer_id)
                  VALUES ('+16175550107', 'assigned', 'voicemail', 11),
                         ('+16175550108', 'available', NULL, NULL);
                """)
            state["before"] = await routing_rows(conn)
            state["before_types"] = await view_types(conn)
            for _ in range(2):  # idempotent
                await conn.execute(MIG_59.read_text())
                await conn.execute(MIG_60.read_text())
            state["after"] = await routing_rows(conn)
            state["after_types"] = await view_types(conn)
        finally:
            await conn.close()

    run(setup())
    try:
        yield state
    finally:
        pg.stop()


async def owner(pg):
    return await asyncpg.connect(host=pg.sock, port=pg.port, user="postgres",
                                 database="postgres", statement_cache_size=0)


async def as_role(pg, role: str, password: str):
    return await asyncpg.connect(host=pg.sock, port=pg.port, user=role, password=password,
                                 database="postgres", statement_cache_size=0)


async def routing_rows(conn) -> list[str]:
    return [r["t"] for r in await conn.fetch(
        "SELECT nr::text AS t FROM number_routing nr ORDER BY did, product_type")]


async def view_types(conn) -> list[tuple]:
    return [tuple(r) for r in await conn.fetch(
        "SELECT a.attname, format_type(a.atttypid, a.atttypmod) FROM pg_attribute a "
        "WHERE a.attrelid = 'number_routing'::regclass AND a.attnum > 0 ORDER BY a.attnum")]


# ---------------------------------------------------------------------------
# Text-level
# ---------------------------------------------------------------------------
def test_59_keeps_54s_four_arms_byte_for_byte():
    assert _view_arms(SRC_59) == _view_arms(SRC_54)


def test_59_rate_cdr_is_54_plus_only_the_ivr_clause():
    clause = re.compile(
        r"\n    -- >>> 59_ivr\.sql \(decision D6[^\n]*\n.*?    -- <<< 59_ivr\.sql <<<\n", re.S)
    rate_59 = _rate_cdr(SRC_59)
    assert len(clause.findall(rate_59)) == 1
    assert clause.sub("", rate_59) == _rate_cdr(SRC_54)


def test_migration_headers_have_the_apply_command():
    for path in (MIG_59, MIG_60):
        txt = path.read_text()
        assert ("hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v "
                f"ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/{path.name}") in txt
    assert "SET LOCAL lock_timeout = '5s';" in SRC_59
    chk = CHECK_MIGRATIONS.read_text()
    for m in ("58_vm_outage_resilience", "59_ivr", "60_cdr_ivr"):
        assert f"('{m}'," in chk


# ---------------------------------------------------------------------------
# Applied
# ---------------------------------------------------------------------------
def test_existing_number_routing_rows_byte_identical(mig_db):
    assert mig_db["before"] and mig_db["after"] == mig_db["before"]
    assert {r.split(",")[1] for r in mig_db["before"]} == {"rcf", "api", "trunk", "voicemail"}
    assert mig_db["after_types"] == mig_db["before_types"]


def test_did_inventory_check_keeps_old_values_and_admits_ivr(mig_db):
    async def go():
        conn = await owner(mig_db["pg"])
        try:
            defs = await conn.fetch(
                "SELECT conname, pg_get_constraintdef(oid) AS d FROM pg_constraint "
                "WHERE conrelid = 'did_inventory'::regclass AND contype = 'c' "
                "AND pg_get_constraintdef(oid) LIKE '%product_type%'")
            assert [r["conname"] for r in defs] == ["did_inventory_product_type_check"]
            for v in ("rcf", "trunk", "api", "ucaas", "voicemail", "ivr"):
                assert f"'{v}'" in defs[0]["d"]
            await conn.execute("UPDATE did_inventory SET product_type = 'ivr' "
                               "WHERE did = '+16175550108'")
            with pytest.raises(asyncpg.CheckViolationError):
                await conn.execute("UPDATE did_inventory SET product_type = 'bogus' "
                                   "WHERE did = '+16175550108'")
            await conn.execute("UPDATE did_inventory SET product_type = NULL "
                               "WHERE did = '+16175550108'")
        finally:
            await conn.close()

    run(go())


async def _seed_ivr(conn) -> dict:
    """Customer 11: entitled, one published flow + one draft flow, numbers."""
    await conn.execute("UPDATE customers SET ivr_enabled = true WHERE id = 11")
    f1 = await conn.fetchval("INSERT INTO call_flows (customer_id, name, draft_graph) "
                             "VALUES (11, 'Main', '{}') RETURNING id")
    f2 = await conn.fetchval("INSERT INTO call_flows (customer_id, name, draft_graph) "
                             "VALUES (11, 'Draft only', '{}') RETURNING id")
    fb = await conn.fetchval("INSERT INTO call_flows (customer_id, name, draft_graph) "
                             "VALUES (12, 'Beta flow', '{}') RETURNING id")
    v1 = await conn.fetchval(
        "INSERT INTO call_flow_versions (flow_id, version, graph, plan, compiler_version) "
        "VALUES ($1, 1, '{}', '{\"v\":1,\"prompts\":[]}', 'ivr-1') RETURNING id", f1)
    await conn.execute("UPDATE call_flows SET published_version_id = $1 WHERE id = $2", v1, f1)
    n1 = await conn.fetchval("INSERT INTO ivr_numbers (customer_id, did, name, flow_id) VALUES "
                             "(11, '+16175550201', 'Main line', $1) RETURNING id", f1)
    n2 = await conn.fetchval("INSERT INTO ivr_numbers (customer_id, did, flow_id) VALUES "
                             "(11, '+16175550202', $1) RETURNING id", f2)
    n3 = await conn.fetchval("INSERT INTO ivr_numbers (customer_id, did) VALUES "
                             "(11, '+16175550203') RETURNING id")
    return {"f1": f1, "f2": f2, "fb": fb, "v1": v1, "n1": n1, "n2": n2, "n3": n3}


def test_ivr_arm_and_fs_view(mig_db):
    async def go():
        conn = await owner(mig_db["pg"])
        try:
            async with conn.transaction():
                ids = await _seed_ivr(conn)
                rows = {r["did"]: r for r in await conn.fetch(
                    "SELECT * FROM number_routing WHERE product_type = 'ivr'")}
                assert rows["+16175550201"]["product_enabled"] is True
                assert rows["+16175550201"]["product_ref_id"] == ids["n1"]
                assert rows["+16175550201"]["product_name"] == "Main line"
                assert rows["+16175550201"]["max_channels"] == 10
                assert rows["+16175550201"]["customer_status"] == "active"
                assert rows["+16175550202"]["product_enabled"] is False   # never published
                assert rows["+16175550203"]["product_enabled"] is False   # no flow
                fs = {r["did"]: r for r in await conn.fetch("SELECT * FROM ivr_fs_number")}
                assert fs["+16175550201"]["enabled"] is True
                assert fs["+16175550201"]["flow_version"] == 1
                assert fs["+16175550201"]["plan_json"] == '{"v": 1, "prompts": []}'
                assert fs["+16175550202"]["plan_json"] is None
                # kill switch / entitlement / customer status
                await conn.execute("UPDATE ivr_numbers SET enabled = false WHERE id = $1",
                                   ids["n1"])
                assert await conn.fetchval("SELECT product_enabled FROM number_routing "
                                           "WHERE did = '+16175550201'") is False
                assert await conn.fetchval("SELECT enabled FROM ivr_fs_number "
                                           "WHERE did = '+16175550201'") is False
                await conn.execute("UPDATE ivr_numbers SET enabled = true WHERE id = $1",
                                   ids["n1"])
                await conn.execute("UPDATE customers SET ivr_enabled = false WHERE id = 11")
                assert await conn.fetchval("SELECT enabled FROM ivr_fs_number "
                                           "WHERE did = '+16175550201'") is False
                await conn.execute("UPDATE customers SET ivr_enabled = true, "
                                   "status = 'suspended' WHERE id = 11")
                assert await conn.fetchval("SELECT enabled FROM ivr_fs_number "
                                           "WHERE did = '+16175550201'") is False
                raise _Rollback()
        except _Rollback:
            pass
        finally:
            await conn.close()

    run(go())


class _Rollback(Exception):
    pass


def test_guards_same_customer_same_flow_immutable_cascade(mig_db):
    async def go():
        conn = await owner(mig_db["pg"])
        try:
            async with conn.transaction():
                ids = await _seed_ivr(conn)
                # a number can never be bound to ANOTHER customer's flow
                with pytest.raises(asyncpg.ForeignKeyViolationError):
                    async with conn.transaction():
                        await conn.execute("UPDATE ivr_numbers SET flow_id = $1 WHERE id = $2",
                                           ids["fb"], ids["n3"])
                # a flow can only publish its OWN version
                with pytest.raises(asyncpg.ForeignKeyViolationError):
                    async with conn.transaction():
                        await conn.execute("UPDATE call_flows SET published_version_id = $1 "
                                           "WHERE id = $2", ids["v1"], ids["f2"])
                # versions are immutable
                with pytest.raises(asyncpg.RaiseError, match="immutable"):
                    async with conn.transaction():
                        await conn.execute("UPDATE call_flow_versions SET plan = '{}' "
                                           "WHERE id = $1", ids["v1"])
                # bad DID / sha / audio
                with pytest.raises(asyncpg.CheckViolationError):
                    async with conn.transaction():
                        await conn.execute("INSERT INTO ivr_numbers (customer_id, did) "
                                           "VALUES (11, '6175550299')")
                with pytest.raises(asyncpg.CheckViolationError):
                    async with conn.transaction():
                        await conn.execute("INSERT INTO ivr_prompt_audio (sha256, wav, bytes) "
                                           "VALUES ($1, $2, 99)", SHA_A, WAV)
                with pytest.raises(asyncpg.ForeignKeyViolationError):
                    async with conn.transaction():
                        await conn.execute(
                            "INSERT INTO ivr_prompts (customer_id, name, kind, sha256, "
                            "duration_ms, bytes) VALUES (11, 'x', 'upload', $1, 10, 46)", SHA_B)
                with pytest.raises(asyncpg.CheckViolationError):
                    async with conn.transaction():
                        await conn.execute("INSERT INTO ivr_prompt_audio (sha256, wav, bytes) "
                                           "VALUES ($1, $2, 46)", SHA_A.upper(), WAV)
                await conn.execute("INSERT INTO ivr_prompt_audio (sha256, wav, bytes) "
                                   "VALUES ($1, $2, 46)", SHA_A, WAV)
                with pytest.raises(asyncpg.CheckViolationError):    # tts needs text + voice
                    async with conn.transaction():
                        await conn.execute(
                            "INSERT INTO ivr_prompts (customer_id, name, kind, sha256, "
                            "duration_ms, bytes) VALUES (11, 'x', 'tts', $1, 10, 46)", SHA_A)
                pid = await conn.fetchval(
                    "INSERT INTO ivr_prompts (customer_id, name, kind, sha256, duration_ms, "
                    "bytes) VALUES (11, 'x', 'upload', $1, 10, 46) RETURNING id", SHA_A)
                with pytest.raises(asyncpg.ForeignKeyViolationError):   # audio in use
                    async with conn.transaction():
                        await conn.execute("DELETE FROM ivr_prompt_audio WHERE sha256 = $1",
                                           SHA_A)
                # deleting a published flow cascades its versions and unbinds numbers
                await conn.execute("DELETE FROM call_flows WHERE id = $1", ids["f1"])
                assert await conn.fetchval("SELECT count(*) FROM call_flow_versions "
                                           "WHERE flow_id = $1", ids["f1"]) == 0
                assert await conn.fetchval("SELECT flow_id FROM ivr_numbers WHERE id = $1",
                                           ids["n1"]) is None
                assert pid
                raise _Rollback()
        except _Rollback:
            pass
        finally:
            await conn.close()

    run(go())


def test_grants(mig_db):
    async def go():
        conn = await owner(mig_db["pg"])
        try:
            def has(role, obj, priv="SELECT"):
                return conn.fetchval("SELECT has_table_privilege($1, $2, $3)", role, obj, priv)

            for obj in ("ivr_fs_number", "ivr_prompt_audio", "number_routing"):
                assert await has("freeswitch", obj) is True, obj
            for obj in ("call_flows", "call_flow_versions", "ivr_numbers", "ivr_prompts"):
                assert await has("freeswitch", obj) is False, obj
            for obj in ("call_flows", "call_flow_versions", "ivr_numbers", "ivr_prompts",
                        "ivr_prompt_audio", "ivr_fs_number"):
                assert await has("grafana_ro", obj) is False, obj
                assert await has("public", obj) is False, obj
            for obj in ("call_flows", "call_flow_versions", "ivr_numbers", "ivr_prompts",
                        "ivr_prompt_audio"):
                for priv in ("SELECT", "INSERT", "UPDATE", "DELETE"):
                    assert await has("api", obj, priv) is True, (obj, priv)
            assert await has("api", "ivr_fs_number") is True
            for seq in ("call_flows_id_seq", "call_flow_versions_id_seq", "ivr_numbers_id_seq",
                        "ivr_prompts_id_seq"):
                assert await conn.fetchval("SELECT has_sequence_privilege('api', $1, 'USAGE')",
                                           seq)
            assert await conn.fetchval(
                "SELECT has_function_privilege('api', 'rate_cdr(varchar)', 'EXECUTE')")
        finally:
            await conn.close()
        # and for real, as the freeswitch login role
        fs = await as_role(mig_db["pg"], "freeswitch", "fs_secret")
        try:
            await fs.fetch("SELECT did, plan_json FROM ivr_fs_number")
            await fs.fetch("SELECT encode(wav, 'hex') FROM ivr_prompt_audio LIMIT 1")
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await fs.fetch("SELECT draft_graph FROM call_flows")
        finally:
            await fs.close()

    run(go())


def test_rate_cdr_ivr_rates_to_zero_and_rcf_unchanged(mig_db):
    async def go():
        conn = await as_role(mig_db["pg"], "api", "api_secret")
        try:
            await conn.execute(
                "INSERT INTO cdrs (uuid, customer_id, product_type, direction, caller_id, "
                "destination, start_time, answer_time, end_time, duration_ms, billable_ms) VALUES "
                "('ivr-a', 12, 'ivr', 'inbound', '+15085551212', '+16175550201', now(), now(), "
                "now(), 40000, 40000), "
                "('ivr-b', 12, 'ivr', 'outbound', '+16175550201', '+17744045256', now(), now(), "
                "now(), 30000, 30000)")
            for uuid in ("ivr-a", "ivr-b"):
                assert await conn.fetchval("SELECT rate_cdr($1)", uuid) == 0
                row = await conn.fetchrow("SELECT * FROM cdrs WHERE uuid = $1", uuid)
                assert row["rated_at"] is not None and row["total_cost"] == 0
                assert row["billable_ms"] == 0 and row["margin"] == 0
                assert await conn.fetchval("SELECT rate_cdr($1)", uuid) is None
            assert await conn.fetchval("SELECT balance FROM customers WHERE id = 12") == \
                Decimal(100)
            # the 60 columns exist and are nullable on every row
            row = await conn.fetchrow("SELECT ivr_flow_id, ivr_flow_version, ivr_exit, ivr_path, "
                                      "ivr_transfer_to, ivr_seconds FROM cdrs WHERE uuid='ivr-a'")
            assert all(v is None for v in row.values())
        finally:
            await conn.close()

    run(go())


def test_check_migrations_reports_59_and_60(mig_db):
    async def go():
        conn = await owner(mig_db["pg"])
        try:
            status = {r["migration"]: r["status"]
                      for r in await conn.fetch(CHECK_MIGRATIONS.read_text())}
            assert status["59_ivr"] == "applied"
            assert status["60_cdr_ivr"] == "applied"
            assert status["54_voicemail"] == "applied"
            assert status["58_vm_outage_resilience"] == "*** MISSING ***"   # P2V's file
        finally:
            await conn.close()

    run(go())


def test_59_refuses_without_54(mig_db):
    async def go():
        conn = await owner(mig_db["pg"])
        try:
            await conn.execute("CREATE DATABASE no54")
        finally:
            await conn.close()
        c2 = await asyncpg.connect(host=mig_db["pg"].sock, port=mig_db["pg"].port,
                                   user="postgres", database="no54", statement_cache_size=0)
        try:
            for name in ("02_schema_core.sql", "03_schema_api.sql", "09_schema_users.sql",
                         "17_did_inventory.sql", "20_rcf_max_channels.sql",
                         "22_number_routing.sql"):
                await c2.execute((INIT / name).read_text())
            with pytest.raises(asyncpg.RaiseError, match="requires 54_voicemail.sql"):
                await c2.execute(MIG_59.read_text())
            await c2.execute("ROLLBACK")      # the script's BEGIN is left aborted
            assert await c2.fetchval("SELECT to_regclass('public.call_flows')") is None
        finally:
            await c2.close()

    run(go())
