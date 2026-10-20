"""Migration 54 (encrypted voicemail) on a DB built from the REAL init scripts.

Proves on an ephemeral local PostgreSQL 16:
  * 54 applies TWICE cleanly on top of the real 02/03/09/17/20/22/24/31/34,
    and the second run is a no-op for the did_inventory CHECK (same OID);
  * number_routing keeps its exact column list/types/order, the three existing
    arms return the same rows as before 54, and the voicemail arm follows the
    contract (product_ref_id = mailbox id, product_enabled = mailbox active AND
    customers.voicemail_enabled, customer_status passthrough, deleted mailbox
    = 0 rows, label -> product_name);
  * the `freeswitch` role can SELECT the view but NOT voicemail_boxes (or any
    voicemail table); grafana_ro (24's ALTER DEFAULT PRIVILEGES) gets nothing;
    `api` has ALL on the tables but only SELECT/INSERT on the audit log;
  * the did_inventory product_type CHECK accepts 'voicemail' (and every old
    value), still rejects junk, and 31/34's other CHECKs survive;
  * the extra guards: E.164 DID, live-DID uniqueness, (mailbox, customer)
    tenant-consistency FKs, same-mailbox active greeting (ON DELETE SET NULL
    of that column only), stored rows must carry every crypto field;
  * scripts/db/check_migrations.sql reports 54 MISSING before and applied after.

Run:  JWT_SECRET_KEY=x python3 -m pytest tests/test_voicemail_migration54.py -q
"""
import asyncio
import uuid
from datetime import datetime, timezone

import pytest

asyncpg = pytest.importorskip("asyncpg", reason="asyncpg required for migration tests")

from voicemail_db import (  # noqa: E402
    CHECK_MIGRATIONS,
    EphemeralPG,
    apply_54,
    apply_prerequisites,
    find_pg_bin,
)

PG_BIN = find_pg_bin()
PORT = 55470  # distinct from every other test module (crypto suite = 55471)

_LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


VIEW_COLUMNS_SQL = """
SELECT column_name, data_type, character_maximum_length, ordinal_position
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'number_routing'
 ORDER BY ordinal_position
"""

PRODUCT_TYPE_CHECKS_SQL = """
SELECT c.oid, c.conname, pg_get_constraintdef(c.oid) AS def
  FROM pg_constraint c
 WHERE c.conrelid = 'did_inventory'::regclass AND c.contype = 'c'
   AND (SELECT array_agg(a.attname ORDER BY a.attname)
          FROM unnest(c.conkey) AS k
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
       ) = ARRAY['product_type'::name]
"""

SEED_SQL = """
INSERT INTO customers (id, name, account_type, status) VALUES
  (1, 'Acme RCF', 'rcf', 'active'),
  (2, 'Beta Trunk', 'trunk', 'active'),
  (3, 'Gamma API', 'api', 'active');
SELECT setval('customers_id_seq', 100);
INSERT INTO rcf_numbers (did, name, customer_id, forward_to) VALUES
  ('+16175550001', 'Main line', 1, '+17745550001');
INSERT INTO api_dids (customer_id, did, voice_url) VALUES (3, '+16175550003', 'https://example.test/v');
INSERT INTO sip_trunks (id, customer_id, trunk_name, max_channels) VALUES (7, 2, 'PBX', 10);
INSERT INTO trunk_dids (trunk_id, did) VALUES (7, '+16175550002');
"""


@pytest.fixture(scope="module")
def mig_db():
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
        owner = await asyncpg.connect(host=pg.sock, port=pg.port, user="postgres",
                                      database="postgres", statement_cache_size=0)
        try:
            await apply_prerequisites(owner)
            await owner.execute(SEED_SQL)
            state["view_cols_before"] = [tuple(r) for r in await owner.fetch(VIEW_COLUMNS_SQL)]
            state["rows_before"] = [dict(r) for r in await owner.fetch(
                "SELECT * FROM number_routing ORDER BY did")]
            state["viewdef_before"] = await owner.fetchval(
                "SELECT pg_get_viewdef('number_routing'::regclass, true)")
            state["check_before"] = {r["migration"]: r["status"] for r in await owner.fetch(
                CHECK_MIGRATIONS.read_text())}
            await apply_54(owner)
            state["checks_after_1"] = [dict(r) for r in await owner.fetch(PRODUCT_TYPE_CHECKS_SQL)]
            await apply_54(owner)  # idempotency: second run must be clean
            state["checks_after_2"] = [dict(r) for r in await owner.fetch(PRODUCT_TYPE_CHECKS_SQL)]
        finally:
            await owner.close()

    _run(_setup())
    try:
        yield state
    finally:
        pg.stop()


async def _owner(pg):
    return await asyncpg.connect(host=pg.sock, port=pg.port, user="postgres",
                                 database="postgres", statement_cache_size=0)


async def _as(pg, role):
    return await asyncpg.connect(host=pg.sock, port=pg.port, user=role,
                                 database="postgres", statement_cache_size=0)


# ---------------------------------------------------------------------------
# Application + idempotency
# ---------------------------------------------------------------------------
def test_second_run_is_noop_for_product_type_check(mig_db):
    first, second = mig_db["checks_after_1"], mig_db["checks_after_2"]
    assert len(first) == 1 and len(second) == 1
    assert first[0]["conname"] == "did_inventory_product_type_check"
    assert first[0]["oid"] == second[0]["oid"], "re-run must not drop/re-add the CHECK"
    assert "'voicemail'" in first[0]["def"]


def test_check_migrations_reports_54(mig_db):
    assert mig_db["check_before"]["54_voicemail"] == "*** MISSING ***"

    async def go():
        conn = await _owner(mig_db["pg"])
        try:
            rows = {r["migration"]: r["status"] for r in await conn.fetch(
                CHECK_MIGRATIONS.read_text())}
        finally:
            await conn.close()
        assert rows["54_voicemail"] == "applied"
        assert rows["22_number_routing"] == "applied"

    _run(go())


def test_tables_and_customer_flag_exist(mig_db):
    async def go():
        conn = await _owner(mig_db["pg"])
        try:
            for t in ("voicemail_customer_keys", "voicemail_boxes", "voicemail_messages",
                      "voicemail_greetings", "voicemail_access_log"):
                assert await conn.fetchval("SELECT to_regclass($1::text) IS NOT NULL", t), t
            col = await conn.fetchrow(
                "SELECT data_type, is_nullable, column_default FROM information_schema.columns "
                "WHERE table_name = 'customers' AND column_name = 'voicemail_enabled'")
            assert col["data_type"] == "boolean" and col["is_nullable"] == "NO"
            assert col["column_default"] == "false"
            assert await conn.fetchval("SELECT bool_and(NOT voicemail_enabled) FROM customers")
        finally:
            await conn.close()

    _run(go())


# ---------------------------------------------------------------------------
# number_routing
# ---------------------------------------------------------------------------
def test_view_columns_unchanged(mig_db):
    async def go():
        conn = await _owner(mig_db["pg"])
        try:
            after = [tuple(r) for r in await conn.fetch(VIEW_COLUMNS_SQL)]
        finally:
            await conn.close()
        assert after == mig_db["view_cols_before"]
        assert [c[0] for c in after] == [
            "did", "product_type", "customer_id", "product_ref_id", "product_enabled",
            "customer_status", "forward_to", "pass_caller_id", "ring_timeout",
            "max_channels", "product_name", "voice_url", "fallback_url", "trunk_id"]

    _run(go())


def test_existing_arms_unchanged(mig_db):
    async def go():
        conn = await _owner(mig_db["pg"])
        try:
            rows = [dict(r) for r in await conn.fetch(
                "SELECT * FROM number_routing WHERE product_type <> 'voicemail' ORDER BY did")]
            viewdef = await conn.fetchval(
                "SELECT pg_get_viewdef('number_routing'::regclass, true)")
        finally:
            await conn.close()
        assert rows == mig_db["rows_before"]
        assert {r["product_type"] for r in rows} == {"rcf", "api", "trunk"}
        # The three original arms deparse identically; 54 only APPENDS an arm.
        assert mig_db["viewdef_before"].rstrip().rstrip(";") in viewdef
        assert "voicemail_boxes" in viewdef

    _run(go())


def test_voicemail_arm_semantics(mig_db):
    async def go():
        conn = await _owner(mig_db["pg"])
        try:
            await conn.execute(
                "INSERT INTO customers (id, name, account_type, status) "
                "VALUES (10, 'VM Co', 'rcf', 'active')")
            long_label = "L" * 120
            box_id = await conn.fetchval(
                "INSERT INTO voicemail_boxes (customer_id, did, label) "
                "VALUES (10, '+16175551000', $1::varchar) RETURNING id", long_label)

            async def row():
                return await conn.fetchrow(
                    "SELECT * FROM number_routing WHERE did = '+16175551000'")

            r = await row()
            assert r["product_type"] == "voicemail"
            assert r["customer_id"] == 10
            assert r["product_ref_id"] == box_id
            assert r["product_enabled"] is False  # voicemail_enabled defaults false
            assert r["customer_status"] == "active"
            assert r["product_name"] == "L" * 100
            for col in ("forward_to", "pass_caller_id", "ring_timeout", "max_channels",
                        "voice_url", "fallback_url", "trunk_id"):
                assert r[col] is None, col

            await conn.execute("UPDATE customers SET voicemail_enabled = true WHERE id = 10")
            assert (await row())["product_enabled"] is True

            await conn.execute("UPDATE voicemail_boxes SET status = 'suspended' WHERE id = $1", box_id)
            r = await row()
            assert r is not None and r["product_enabled"] is False

            await conn.execute("UPDATE voicemail_boxes SET status = 'active' WHERE id = $1", box_id)
            await conn.execute("UPDATE customers SET status = 'suspended' WHERE id = 10")
            r = await row()
            assert r["customer_status"] == "suspended" and r["product_enabled"] is True

            await conn.execute("UPDATE voicemail_boxes SET status = 'deleted' WHERE id = $1", box_id)
            assert await row() is None, "a deleted mailbox's DID is 'not ours' again"
            assert await conn.fetchval(
                "SELECT count(*) FROM number_routing WHERE did = '+16175551000'") == 0
        finally:
            await conn.close()

    _run(go())


def test_voicemail_arm_point_lookup_uses_index(mig_db):
    async def go():
        conn = await _owner(mig_db["pg"])
        try:
            await conn.execute("SET enable_seqscan = off")
            plan = "\n".join(r[0] for r in await conn.fetch(
                "EXPLAIN SELECT * FROM number_routing WHERE did = '+16175559999'"))
        finally:
            await conn.close()
        assert "uq_voicemail_boxes_did_live" in plan, plan
        for idx in ("idx_rcf_did_lookup", "idx_api_did_lookup", "idx_trunk_did_lookup"):
            assert idx in plan, plan

    _run(go())


# ---------------------------------------------------------------------------
# Grants
# ---------------------------------------------------------------------------
VM_TABLES = ("voicemail_customer_keys", "voicemail_boxes", "voicemail_messages",
             "voicemail_greetings", "voicemail_access_log")


def test_freeswitch_reads_view_but_not_voicemail_tables(mig_db):
    async def go():
        fs = await _as(mig_db["pg"], "freeswitch")
        try:
            n = await fs.fetchval("SELECT count(*) FROM number_routing")
            assert n >= 3
            for t in VM_TABLES:
                with pytest.raises(asyncpg.InsufficientPrivilegeError):
                    await fs.fetch(f"SELECT 1 FROM {t} LIMIT 1")
        finally:
            await fs.close()

    _run(go())


def test_grafana_ro_gets_nothing_despite_default_privileges(mig_db):
    async def go():
        conn = await _owner(mig_db["pg"])
        try:
            for t in VM_TABLES:
                assert not await conn.fetchval(
                    "SELECT has_table_privilege('grafana_ro', $1::text, 'SELECT')", t), t
                assert not await conn.fetchval(
                    "SELECT has_table_privilege('freeswitch', $1::text, 'SELECT')", t), t
                assert not await conn.fetchval(
                    "SELECT has_table_privilege('public', $1::text, 'SELECT')", t), t
            # Sanity: 24's default privileges ARE live in this DB (so the revoke mattered).
            await conn.execute("CREATE TABLE zz_probe (x int)")
            assert await conn.fetchval(
                "SELECT has_table_privilege('grafana_ro', 'zz_probe', 'SELECT')")
            await conn.execute("DROP TABLE zz_probe")
        finally:
            await conn.close()

    _run(go())


def test_api_privileges(mig_db):
    async def go():
        conn = await _owner(mig_db["pg"])
        try:
            for t in VM_TABLES[:4]:
                for priv in ("SELECT", "INSERT", "UPDATE", "DELETE"):
                    assert await conn.fetchval(
                        "SELECT has_table_privilege('api', $1::text, $2::text)", t, priv), (t, priv)
            for priv, expected in (("SELECT", True), ("INSERT", True), ("UPDATE", False),
                                   ("DELETE", False), ("TRUNCATE", False)):
                assert await conn.fetchval(
                    "SELECT has_table_privilege('api', 'voicemail_access_log', $1::text)",
                    priv) is expected, priv
            for seq in ("voicemail_boxes_id_seq", "voicemail_messages_id_seq",
                        "voicemail_greetings_id_seq", "voicemail_access_log_id_seq"):
                assert await conn.fetchval(
                    "SELECT has_sequence_privilege('api', $1::text, 'USAGE')", seq), seq
            assert await conn.fetchval(
                "SELECT has_table_privilege('api', 'number_routing', 'SELECT')")
        finally:
            await conn.close()

        api = await _as(mig_db["pg"], "api")
        try:
            await api.execute(
                "INSERT INTO voicemail_access_log (action, source) VALUES ('mailbox_create', 'admin')")
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await api.execute("DELETE FROM voicemail_access_log")
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                await api.execute("UPDATE voicemail_access_log SET action = 'x'")
        finally:
            await api.close()

    _run(go())


# ---------------------------------------------------------------------------
# did_inventory CHECKs
# ---------------------------------------------------------------------------
def test_did_inventory_product_type_check(mig_db):
    async def go():
        conn = await _owner(mig_db["pg"])
        try:
            for i, pt in enumerate(("rcf", "trunk", "api", "ucaas", "voicemail")):
                await conn.execute(
                    "INSERT INTO did_inventory (did, product_type, status) "
                    "VALUES ($1::varchar, $2::varchar, 'assigned')", f"+1617555200{i}", pt)
            await conn.execute(
                "INSERT INTO did_inventory (did, status) VALUES ('+16175552009', 'available')")
            with pytest.raises(asyncpg.CheckViolationError):
                await conn.execute(
                    "INSERT INTO did_inventory (did, product_type) VALUES ('+16175552010', 'junk')")
            # 34's status CHECK and 31's E.164 CHECK survived the swap.
            with pytest.raises(asyncpg.CheckViolationError):
                await conn.execute(
                    "INSERT INTO did_inventory (did, status) VALUES ('+16175552011', 'bogus')")
            with pytest.raises(asyncpg.CheckViolationError):
                await conn.execute(
                    "INSERT INTO did_inventory (did, status) VALUES ('6175552012', 'available')")
            await conn.execute(
                "INSERT INTO did_inventory (did, status) VALUES ('+16175552013', 'release_requested')")
        finally:
            await conn.close()

    _run(go())


# ---------------------------------------------------------------------------
# Table guards
# ---------------------------------------------------------------------------
async def _customer(conn, cid):
    await conn.execute(
        "INSERT INTO customers (id, name, account_type) VALUES ($1::int, $2::varchar, 'rcf') "
        "ON CONFLICT (id) DO NOTHING", cid, f"cust{cid}")


async def _box(conn, cid, did):
    return await conn.fetchval(
        "INSERT INTO voicemail_boxes (customer_id, did) VALUES ($1::int, $2::varchar) RETURNING id",
        cid, did)


def test_box_did_guards(mig_db):
    async def go():
        conn = await _owner(mig_db["pg"])
        try:
            await _customer(conn, 20)
            with pytest.raises(asyncpg.CheckViolationError):
                await _box(conn, 20, "6175553000")
            b1 = await _box(conn, 20, "+16175553000")
            with pytest.raises(asyncpg.UniqueViolationError) as ei:
                await _box(conn, 20, "+16175553000")
            assert ei.value.constraint_name == "uq_voicemail_boxes_did_live"
            await conn.execute("UPDATE voicemail_boxes SET status = 'deleted' WHERE id = $1", b1)
            await _box(conn, 20, "+16175553000")  # the DID is reusable once deleted
            # RESTRICT: a customer with mailboxes cannot be deleted out from under them.
            with pytest.raises(asyncpg.ForeignKeyViolationError):
                await conn.execute("DELETE FROM customers WHERE id = 20")
        finally:
            await conn.close()

    _run(go())


def _msg_insert(conn, mailbox_id, customer_id, **extra):
    cols = {"msg_uuid": uuid.uuid4(), "mailbox_id": mailbox_id, "customer_id": customer_id,
            "size_bytes": 100, "expires_at": datetime(2030, 1, 1, tzinfo=timezone.utc)}
    cols.update(extra)
    names = ", ".join(cols)
    casts = {"msg_uuid": "uuid", "mailbox_id": "int", "customer_id": "int", "size_bytes": "int",
             "expires_at": "timestamptz", "status": "varchar", "object_key": "text",
             "ciphertext_crc32c": "bigint", "wrapped_dek": "bytea", "kek_version": "text",
             "iv": "bytea"}
    params = ", ".join(f"${i}::{casts[k]}" for i, k in enumerate(cols, start=1))
    return conn.fetchval(f"INSERT INTO voicemail_messages ({names}) VALUES ({params}) RETURNING id",
                         *cols.values())


def test_message_tenant_consistency_and_stored_guard(mig_db):
    async def go():
        conn = await _owner(mig_db["pg"])
        try:
            await _customer(conn, 30)
            await _customer(conn, 31)
            box = await _box(conn, 30, "+16175554000")
            await _msg_insert(conn, box, 30)  # pending: no crypto fields needed
            with pytest.raises(asyncpg.ForeignKeyViolationError):
                await _msg_insert(conn, box, 31)  # customer_id disagrees with the mailbox
            with pytest.raises(asyncpg.CheckViolationError):
                await _msg_insert(conn, box, 30, status="stored")
            with pytest.raises(asyncpg.CheckViolationError):
                await _msg_insert(conn, box, 30, iv=b"\x00" * 11)
            await _msg_insert(conn, box, 30, status="stored", object_key="c/30/mb/1/m/x.enc",
                              ciphertext_crc32c=4294967295, wrapped_dek=b"w",
                              kek_version="v", iv=b"\x00" * 12)
            with pytest.raises(asyncpg.UniqueViolationError):
                u = uuid.uuid4()
                await _msg_insert(conn, box, 30, msg_uuid=u)
                await _msg_insert(conn, box, 30, msg_uuid=u)
        finally:
            await conn.close()

    _run(go())


def test_active_greeting_must_belong_to_the_mailbox(mig_db):
    async def go():
        conn = await _owner(mig_db["pg"])
        try:
            await _customer(conn, 40)
            box_a = await _box(conn, 40, "+16175556000")
            box_b = await _box(conn, 40, "+16175556001")

            async def greeting(box):
                return await conn.fetchval(
                    "INSERT INTO voicemail_greetings (greeting_uuid, mailbox_id, customer_id, size_bytes) "
                    "VALUES ($1::uuid, $2::int, 40, 10) RETURNING id", uuid.uuid4(), box)

            g_a = await greeting(box_a)
            g_b = await greeting(box_b)
            with pytest.raises(asyncpg.ForeignKeyViolationError):
                await conn.execute(
                    "UPDATE voicemail_boxes SET active_greeting_id = $1::int WHERE id = $2::int",
                    g_b, box_a)
            await conn.execute(
                "UPDATE voicemail_boxes SET active_greeting_id = $1::int, greeting_mode = 'custom' "
                "WHERE id = $2::int", g_a, box_a)
            await conn.execute("DELETE FROM voicemail_greetings WHERE id = $1::int", g_a)
            row = await conn.fetchrow(
                "SELECT id, active_greeting_id, customer_id FROM voicemail_boxes WHERE id = $1::int",
                box_a)
            assert row["id"] == box_a and row["active_greeting_id"] is None
            assert row["customer_id"] == 40
            with pytest.raises(asyncpg.ForeignKeyViolationError):
                await conn.execute(
                    "INSERT INTO voicemail_greetings (greeting_uuid, mailbox_id, customer_id, size_bytes) "
                    "VALUES ($1::uuid, $2::int, 999, 10)", uuid.uuid4(), box_a)
        finally:
            await conn.close()

    _run(go())


def test_key_row_constraints(mig_db):
    async def go():
        conn = await _owner(mig_db["pg"])
        try:
            await _customer(conn, 50)
            with pytest.raises(asyncpg.CheckViolationError):
                await conn.execute(
                    "INSERT INTO voicemail_customer_keys (customer_id, provider, key_ref) "
                    "VALUES (50, 'aws', 'x')")
            await conn.execute(
                "INSERT INTO voicemail_customer_keys (customer_id, provider, key_ref) "
                "VALUES (50, 'local', 'local:50')")
            with pytest.raises(asyncpg.ForeignKeyViolationError):
                await conn.execute("DELETE FROM customers WHERE id = 50")
            with pytest.raises(asyncpg.ForeignKeyViolationError):
                await conn.execute(
                    "INSERT INTO voicemail_customer_keys (customer_id, provider, key_ref) "
                    "VALUES (98765, 'local', 'local:98765')")
        finally:
            await conn.close()

    _run(go())
