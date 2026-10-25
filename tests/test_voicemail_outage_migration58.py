"""Migration 58 (vm_fs_mailbox, Visual IVR plan D11) on a DB built from the
REAL init scripts (02..34 prerequisites + 54 + 56, then 58 TWICE).

Proves on an ephemeral local PostgreSQL 16:
  * 58 applies twice cleanly (idempotent), with voicemail data present;
  * PARITY: for every branch of the API's GET /fs/mailbox rule —
    services/voicemail/mailboxes.py MAILBOX_SELECT + accepting_state() —
    the view returns the same accepting / reason / status /
    max_message_seconds / did / customer_id: active, suspended, customer
    entitlement off (inactive wins over full), full by live count, trash
    NOT counted for the count cap, full by bytes INCLUDING trash, pending /
    failed / purged rows ignored, exactly-at-cap, a deleted mailbox = no row
    (the API's 404);
  * the exact statement lib/vm_replica.lua sends (read out of the Lua file —
    no copy to drift) runs as the ``freeswitch`` role and returns that row;
  * grants: freeswitch may read the view and still NOTHING voicemail_*;
    api, grafana_ro (24's default privileges) and PUBLIC get nothing on it;
  * the point lookup is an id index scan of voicemail_boxes (planner forced
    off seq scans on the tiny test tables).

Run:  JWT_SECRET_KEY=x python3 -m pytest tests/test_voicemail_outage_migration58.py -q
"""
import asyncio
import os
import re
import sys
from pathlib import Path

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")

asyncpg = pytest.importorskip("asyncpg", reason="asyncpg required for migration tests")

REPO = Path(__file__).resolve().parents[1]
_API_SRC = REPO / "docker" / "api" / "src"
if str(_API_SRC) not in sys.path:
    sys.path.insert(0, str(_API_SRC))

from services.voicemail.mailboxes import MAILBOX_SELECT, accepting_state  # noqa: E402

from voicemail_db import (  # noqa: E402
    EphemeralPG,
    apply_prerequisites,
    apply_voicemail_schema,
    find_pg_bin,
)

PG_BIN = find_pg_bin()
PORT = 55501  # distinct from every other test module
MIG_58 = REPO / "docker" / "postgres" / "init" / "58_vm_outage_resilience.sql"
VM_REPLICA_LUA = REPO / "docker" / "freeswitch" / "scripts" / "lib" / "vm_replica.lua"

_LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


SEED_SQL = """
INSERT INTO customers (id, name, account_type, status, voicemail_enabled) VALUES
  (1, 'Acme VM', 'rcf', 'active', true),
  (2, 'Off VM', 'rcf', 'active', false),
  (3, 'Suspended Co', 'rcf', 'suspended', true);
SELECT setval('customers_id_seq', 100);
INSERT INTO voicemail_boxes (id, customer_id, did, label, status, max_messages, max_bytes,
                             max_message_seconds) VALUES
  (1, 1, '+16175550001', 'empty',              'active',    100, 524288000, 300),
  (2, 1, '+16175550002', 'full by count',      'active',      2, 524288000, 120),
  (3, 1, '+16175550003', 'trash not counted',  'active',      2, 524288000, 300),
  (4, 1, '+16175550004', 'full by bytes+trash','active',    100,      5000, 300),
  (5, 1, '+16175550005', 'suspended',          'suspended', 100, 524288000, 300),
  (6, 1, '+16175550006', 'deleted',            'deleted',   100, 524288000, 300),
  (7, 2, '+16175550007', 'entitlement off',    'active',    100, 524288000, 300),
  (8, 2, '+16175550008', 'off AND full',       'active',      1, 524288000, 300),
  (9, 1, '+16175550009', 'only unfinished',    'active',      1,         1, 300),
  (10, 1, '+16175550010', 'one below the cap', 'active',      2,     10000, 60),
  (11, 3, '+16175550011', 'customer suspended','active',    100, 524288000, 300);
SELECT setval('voicemail_boxes_id_seq', 100);
"""

CRYPTO = ("'k', 1, '\\x00'::bytea, 'local:1/v1', '\\x000000000000000000000000'::bytea")


def _msg(box: int, cust: int, n: int, *, status="stored", size=1000, trashed=False) -> str:
    crypto = CRYPTO if status == "stored" else "NULL, NULL, NULL, NULL, NULL"
    return (f"INSERT INTO voicemail_messages (msg_uuid, mailbox_id, customer_id, size_bytes, "
            f"status, expires_at, object_key, ciphertext_crc32c, wrapped_dek, kek_version, iv, "
            f"deleted_at) VALUES (md5('{box}-{n}')::uuid, {box}, {cust}, {size}, '{status}', "
            f"now() + interval '90 days', {crypto}, "
            f"{'now()' if trashed else 'NULL'});")


MESSAGES_SQL = "\n".join([
    _msg(2, 1, 1), _msg(2, 1, 2),                                   # 2 live = cap
    _msg(3, 1, 1), _msg(3, 1, 2, trashed=True), _msg(3, 1, 3, trashed=True),  # 1 live + 2 trash
    _msg(4, 1, 1, size=3000), _msg(4, 1, 2, size=2500, trashed=True),         # 5500 >= 5000
    _msg(8, 2, 1),
    _msg(9, 1, 1, status="pending", size=99), _msg(9, 1, 2, status="failed", size=99),
    _msg(9, 1, 3, status="purged", size=99),
    _msg(10, 1, 1, size=4000),                                      # 1 < 2, 4000 < 10000
])


async def _connect(pg, user="postgres"):
    return await asyncpg.connect(host=pg.sock, port=pg.port, user=user, database="postgres",
                                 statement_cache_size=0)


@pytest.fixture(scope="module")
def db():
    if PG_BIN is None:
        pytest.skip("no local PostgreSQL binaries; set TEST_PG_BIN to run migration tests")
    pg = EphemeralPG(PG_BIN, PORT)
    try:
        pg.start()
    except Exception as e:  # noqa: BLE001
        pg.stop()
        pytest.skip(f"could not start throwaway PostgreSQL: {e}")
    state = {"pg": pg}

    async def _setup():
        owner = await _connect(pg)
        try:
            await apply_prerequisites(owner)
            await owner.execute("CREATE ROLE grafana_ro_probe")  # unrelated role: no grant
            await apply_voicemail_schema(owner)
            await owner.execute(SEED_SQL)
            await owner.execute(MESSAGES_SQL)
            await owner.execute(MIG_58.read_text())
            state["def_1"] = await owner.fetchval("SELECT pg_get_viewdef('vm_fs_mailbox'::regclass)")
            await owner.execute(MIG_58.read_text())   # idempotency: second run is clean
            state["def_2"] = await owner.fetchval("SELECT pg_get_viewdef('vm_fs_mailbox'::regclass)")
        finally:
            await owner.close()

    try:
        _run(_setup())
        yield state
    finally:
        pg.stop()


def test_applies_twice_unchanged(db):
    assert db["def_1"] == db["def_2"]


def test_parity_with_api_accepting_state(db):
    async def go():
        owner = await _connect(db["pg"])
        try:
            api_rows = {r["id"]: r for r in await owner.fetch(
                MAILBOX_SELECT + " WHERE b.status <> 'deleted'")}
            view = {r["mailbox_id"]: r for r in await owner.fetch("SELECT * FROM vm_fs_mailbox")}
        finally:
            await owner.close()
        assert set(view) == set(api_rows) == {1, 2, 3, 4, 5, 7, 8, 9, 10, 11}
        assert 6 not in view, "a deleted mailbox has no row (the API answers 404)"
        for mid, api in api_rows.items():
            accepting, reason = accepting_state(api)
            v = view[mid]
            assert (v["accepting"], v["reason"]) == (accepting, reason), (mid, api["label"])
            assert v["status"] == api["status"] and v["did"] == api["did"]
            assert v["customer_id"] == api["customer_id"]
            assert v["max_message_seconds"] == api["max_message_seconds"]
        expected = {1: (True, None), 2: (False, "full"), 3: (True, None), 4: (False, "full"),
                    5: (False, "inactive"), 7: (False, "inactive"), 8: (False, "inactive"),
                    9: (True, None), 10: (True, None), 11: (True, None)}
        assert {m: (v["accepting"], v["reason"]) for m, v in view.items()} == expected
    _run(go())


def test_lua_statement_as_freeswitch(db):
    lua = VM_REPLICA_LUA.read_text()
    m = re.search(r'M\.SQL = "([^"]+)"\s*\.\.\s*"([^"]+)"', lua)
    assert m, "M.SQL not found in vm_replica.lua"
    sql = (m.group(1) + m.group(2)).replace("%d", "{}")

    async def go():
        fs = await _connect(db["pg"], "freeswitch")
        try:
            row = await fs.fetchrow(sql.format(2))
            assert dict(row) == {"mailbox_id": 2, "did": "+16175550002", "customer_id": 1,
                                 "status": "active", "accepting": False,
                                 "max_message_seconds": 120, "reason": "full"}
            assert await fs.fetchrow(sql.format(6)) is None        # deleted
            assert await fs.fetchrow(sql.format(999)) is None      # unknown
            for table in ("voicemail_boxes", "voicemail_messages", "voicemail_greetings",
                          "voicemail_access_log", "voicemail_customer_keys"):
                with pytest.raises(asyncpg.InsufficientPrivilegeError):
                    await fs.fetch(f"SELECT 1 FROM {table} LIMIT 1")
        finally:
            await fs.close()
    _run(go())


def test_grants(db):
    async def go():
        owner = await _connect(db["pg"])
        try:
            got = {}
            for role in ("freeswitch", "api", "grafana_ro", "grafana_ro_probe"):
                got[role] = await owner.fetchval(
                    "SELECT has_table_privilege($1, 'vm_fs_mailbox', 'SELECT')", role)
            assert got == {"freeswitch": True, "api": False, "grafana_ro": False,
                           "grafana_ro_probe": False}
            acl = await owner.fetchval(
                "SELECT relacl::text FROM pg_class WHERE relname = 'vm_fs_mailbox'")
            assert "=r/" not in acl.replace("freeswitch=r/", ""), acl   # no PUBLIC grant
            for priv in ("INSERT", "UPDATE", "DELETE"):
                assert not await owner.fetchval(
                    "SELECT has_table_privilege('freeswitch', 'vm_fs_mailbox', $1)", priv)
        finally:
            await owner.close()
    _run(go())


def test_point_lookup_is_an_id_index_scan(db):
    async def go():
        owner = await _connect(db["pg"])
        try:
            async with owner.transaction():
                await owner.execute("SET LOCAL enable_seqscan = off")
                plan = "\n".join(r[0] for r in await owner.fetch(
                    "EXPLAIN SELECT * FROM vm_fs_mailbox WHERE mailbox_id = 2"))
        finally:
            await owner.close()
        # voicemail_boxes_pkey or the (id, customer_id) unique index — both
        # are id point lookups; never a scan of every mailbox.
        assert re.search(r"Index Scan using voicemail_boxes_\w+ on voicemail_boxes b", plan), plan
        assert "Index Cond: (id = 2)" in plan, plan
    _run(go())
