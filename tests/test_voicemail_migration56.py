"""Migration 56 (voicemail transcription) on a DB built from the REAL init scripts.

Proves on an ephemeral local PostgreSQL 16:
  * 56 applies TWICE cleanly on top of the real 02..34 prerequisites + 54 with
    voicemail data already present (constraint OIDs unchanged by the re-run),
    and a re-run that cannot get its lock fails fast (lock_timeout) instead of
    queueing behind a reader;
  * voicemail_boxes gains transcription_enabled (NOT NULL DEFAULT false — every
    existing and new mailbox is OFF) and transcription_language (NOT NULL
    DEFAULT 'en-US', shape CHECK);
  * every voicemail_transcripts CHECK: status values, crypto fields present
    exactly when 'done', a 'processing' row holds lease + token, iv 12 bytes,
    ciphertext 17..65552 bytes, confidence 0..1, language shape, attempts
    range, machine-only error codes;
  * the composite FK: a transcript whose mailbox or customer disagrees with its
    message is rejected; deleting the message CASCADEs;
  * the purge trigger: -> 'purged' deletes the transcript in the same
    transaction (also as the runtime `api` role — invoker rights), while
    pending -> stored, stored -> failed, flag updates and a rolled-back purge
    leave it alone;
  * grants: api SELECT/INSERT/UPDATE/DELETE only; freeswitch, grafana_ro and
    PUBLIC get nothing on the table (24's default privileges undone);
    grafana_ro reads the counts-only stats view; the view's numbers;
  * scripts/db/check_migrations.sql reports 56 MISSING before and applied after;
  * EXPLAIN: the worker's discovery, claim, due/lease reaper, budget and
    mailbox statements (plan §6/§9) ride the new indexes.

The statements under EXPLAIN are the plan's §6/§9 SQL; phase 2's
``transcription/queue.py`` owns the canonical text (the worker suite runs the
real module against this schema).

Run:  JWT_SECRET_KEY=x python3 -m pytest tests/test_voicemail_migration56.py -q
"""
import asyncio
import time
import uuid
from datetime import datetime, timezone

import pytest

asyncpg = pytest.importorskip("asyncpg", reason="asyncpg required for migration tests")

from voicemail_db import (  # noqa: E402
    CHECK_MIGRATIONS,
    EphemeralPG,
    apply_54,
    apply_56,
    apply_prerequisites,
    find_pg_bin,
)

PG_BIN = find_pg_bin()
PORT = 55476  # distinct from every other test module (voicemail 55470-55475)

_LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


# Pre-56 voicemail data: 56 must apply over existing rows.
SEED_SQL = """
INSERT INTO customers (id, name, account_type, status, voicemail_enabled) VALUES
  (1, 'Acme VM', 'rcf', 'active', true);
SELECT setval('customers_id_seq', 100);
INSERT INTO voicemail_boxes (id, customer_id, did, label) VALUES (1, 1, '+16175550001', 'Old box');
SELECT setval('voicemail_boxes_id_seq', 100);
"""

CONSTRAINT_OIDS_SQL = """
SELECT conname, oid FROM pg_constraint
 WHERE conname IN ('voicemail_boxes_transcription_language_chk',
                   'voicemail_messages_id_box_customer_key',
                   'voicemail_transcripts_message_fk')
 ORDER BY conname
"""

EXPIRES = datetime(2030, 1, 1, tzinfo=timezone.utc)
CRYPTO = {"ciphertext": b"\x01" * 40, "wrapped_dek": b"w" * 70, "kek_version": "local:1/v1",
          "iv": b"\x00" * 12}


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
        owner = await _connect(pg, "postgres")
        try:
            await apply_prerequisites(owner)
            await apply_54(owner)
            await owner.execute(SEED_SQL)
            state["old_msg"] = await _msg(owner, 1, 1, status="stored")
            state["check_before"] = await _check_migrations(owner)
            await apply_56(owner)
            state["oids_1"] = [tuple(r) for r in await owner.fetch(CONSTRAINT_OIDS_SQL)]
            await apply_56(owner)  # idempotency: the second run must be clean
            state["oids_2"] = [tuple(r) for r in await owner.fetch(CONSTRAINT_OIDS_SQL)]
        finally:
            await owner.close()

    _run(_setup())
    try:
        yield state
    finally:
        pg.stop()


async def _connect(pg, role):
    return await asyncpg.connect(host=pg.sock, port=pg.port, user=role,
                                 database="postgres", statement_cache_size=0)


async def _check_migrations(conn) -> dict:
    return {r["migration"]: r["status"] for r in await conn.fetch(CHECK_MIGRATIONS.read_text())}


_ids = iter(range(200, 100_000))


async def _customer(conn) -> int:
    cid = next(_ids)
    await conn.execute(
        "INSERT INTO customers (id, name, account_type, voicemail_enabled) "
        "VALUES ($1::int, $2::varchar, 'rcf', true)", cid, f"cust{cid}")
    return cid


async def _box(conn, cid) -> int:
    return await conn.fetchval(
        "INSERT INTO voicemail_boxes (customer_id, did) VALUES ($1::int, $2::varchar) RETURNING id",
        cid, f"+1617555{next(_ids):04d}")


async def _msg(conn, box, cid, *, status="stored", **extra) -> int:
    cols = {"msg_uuid": uuid.uuid4(), "mailbox_id": box, "customer_id": cid, "size_bytes": 100,
            "expires_at": EXPIRES, "status": status}
    if status == "stored":
        cols.update(object_key=f"c/{cid}/mb/{box}/m/{cols['msg_uuid']}.enc",
                    ciphertext_crc32c=1, wrapped_dek=b"w", kek_version="v", iv=b"\x00" * 12)
    cols.update(extra)
    casts = {"msg_uuid": "uuid", "mailbox_id": "int", "customer_id": "int", "size_bytes": "int",
             "expires_at": "timestamptz", "status": "varchar", "object_key": "text",
             "ciphertext_crc32c": "bigint", "wrapped_dek": "bytea", "kek_version": "text",
             "iv": "bytea", "created_at": "timestamptz", "deleted_at": "timestamptz"}
    names = ", ".join(cols)
    params = ", ".join(f"${i}::{casts[k]}" for i, k in enumerate(cols, start=1))
    return await conn.fetchval(
        f"INSERT INTO voicemail_messages ({names}) VALUES ({params}) RETURNING id", *cols.values())


async def _transcript(conn, msg_id, box, cid, **extra):
    cols = {"message_id": msg_id, "mailbox_id": box, "customer_id": cid, "language": "en-US"}
    cols.update(extra)
    casts = {"message_id": "bigint", "mailbox_id": "int", "customer_id": "int",
             "language": "varchar", "status": "varchar", "attempts": "smallint",
             "lease_until": "timestamptz", "attempt_id": "uuid", "error_code": "varchar",
             "confidence": "real", "billed_ms": "int", "ciphertext": "bytea",
             "wrapped_dek": "bytea", "kek_version": "text", "iv": "bytea",
             "completed_at": "timestamptz", "next_attempt_at": "timestamptz"}
    names = ", ".join(cols)
    params = ", ".join(f"${i}::{casts[k]}" for i, k in enumerate(cols, start=1))
    await conn.execute(f"INSERT INTO voicemail_transcripts ({names}) VALUES ({params})",
                       *cols.values())


async def _fixture(conn):
    """A customer + mailbox + stored message, returns (cid, box, msg)."""
    cid = await _customer(conn)
    box = await _box(conn, cid)
    return cid, box, await _msg(conn, box, cid)


async def _count(conn, msg_id) -> int:
    return await conn.fetchval(
        "SELECT count(*) FROM voicemail_transcripts WHERE message_id = $1::bigint", msg_id)


# ---------------------------------------------------------------------------
# Application + idempotency
# ---------------------------------------------------------------------------
def test_second_run_is_clean_and_keeps_constraints(mig_db):
    first, second = mig_db["oids_1"], mig_db["oids_2"]
    assert [c for c, _ in first] == ["voicemail_boxes_transcription_language_chk",
                                     "voicemail_messages_id_box_customer_key",
                                     "voicemail_transcripts_message_fk"]
    assert first == second, "a re-run must not drop/re-add any constraint"


def test_check_migrations_reports_56(mig_db):
    before = mig_db["check_before"]
    assert before["56_voicemail_transcription"] == "*** MISSING ***"
    assert before["54_voicemail"] == "applied"

    async def go():
        conn = await _connect(mig_db["pg"], "postgres")
        try:
            after = await _check_migrations(conn)
        finally:
            await conn.close()
        assert after["56_voicemail_transcription"] == "applied"
        assert after["54_voicemail"] == "applied"

    _run(go())


def test_rerun_fails_fast_when_it_cannot_lock(mig_db):
    """lock_timeout: a re-run behind a long reader of voicemail_boxes errors
    in ~5 s (re-run it later) instead of queueing call-path reads behind it."""
    async def go():
        reader = await _connect(mig_db["pg"], "postgres")
        runner = await _connect(mig_db["pg"], "postgres")
        try:
            tx = reader.transaction()
            await tx.start()
            await reader.fetch("SELECT 1 FROM voicemail_boxes LIMIT 1")  # ACCESS SHARE held
            t0 = time.monotonic()
            with pytest.raises(asyncpg.LockNotAvailableError):
                await apply_56(runner)
            assert time.monotonic() - t0 < 15
            await tx.rollback()
            # The script stopped inside Part 1's BEGIN (as psql ON_ERROR_STOP
            # would, closing the session): roll that block back, then the
            # session is usable and nothing was half-applied.
            assert runner.is_in_transaction()
            await runner.execute("ROLLBACK")
            assert await runner.fetchval("SELECT 1") == 1
            assert (await _check_migrations(runner))["56_voicemail_transcription"] == "applied"
        finally:
            await reader.close()
            await runner.close()

    _run(go())


def test_mailbox_columns_and_defaults(mig_db):
    async def go():
        conn = await _connect(mig_db["pg"], "postgres")
        try:
            cols = {r["column_name"]: r for r in await conn.fetch(
                "SELECT column_name, data_type, is_nullable, column_default, "
                "character_maximum_length FROM information_schema.columns "
                "WHERE table_name = 'voicemail_boxes' "
                "AND column_name IN ('transcription_enabled', 'transcription_language')")}
            en, lang = cols["transcription_enabled"], cols["transcription_language"]
            assert (en["data_type"], en["is_nullable"], en["column_default"]) == \
                ("boolean", "NO", "false")
            assert (lang["data_type"], lang["is_nullable"], lang["character_maximum_length"]) == \
                ("character varying", "NO", 16)
            assert lang["column_default"].startswith("'en-US'")
            # The pre-56 mailbox is OFF / en-US, and so is a new one.
            old = await conn.fetchrow(
                "SELECT transcription_enabled, transcription_language FROM voicemail_boxes "
                "WHERE id = 1")
            assert tuple(old) == (False, "en-US")
            cid = await _customer(conn)
            new = await conn.fetchrow(
                "SELECT transcription_enabled, transcription_language FROM voicemail_boxes "
                "WHERE id = $1::int", await _box(conn, cid))
            assert tuple(new) == (False, "en-US")
            for ok in ("es-US", "fr-CA", "fil-PH"):
                await conn.execute(
                    "UPDATE voicemail_boxes SET transcription_language = $1::varchar "
                    "WHERE id = 1", ok)
            for bad in ("en-us", "EN-US", "en_US", "english", "en-USA", ""):
                with pytest.raises(asyncpg.CheckViolationError):
                    await conn.execute(
                        "UPDATE voicemail_boxes SET transcription_language = $1::varchar "
                        "WHERE id = 1", bad)
            with pytest.raises(asyncpg.NotNullViolationError):
                await conn.execute(
                    "UPDATE voicemail_boxes SET transcription_enabled = NULL WHERE id = 1")
            await conn.execute(
                "UPDATE voicemail_boxes SET transcription_language = 'en-US' WHERE id = 1")
        finally:
            await conn.close()

    _run(go())


def test_transcript_table_shape_and_defaults(mig_db):
    async def go():
        conn = await _connect(mig_db["pg"], "postgres")
        try:
            cid, box, msg = await _fixture(conn)
            await _transcript(conn, msg, box, cid)
            row = dict(await conn.fetchrow(
                "SELECT * FROM voicemail_transcripts WHERE message_id = $1::bigint", msg))
            assert row["status"] == "pending" and row["attempts"] == 0
            assert row["enc_algo"] == "AES-256-GCM" and row["language"] == "en-US"
            assert row["next_attempt_at"] is not None and row["created_at"] is not None
            for col in ("lease_until", "attempt_id", "error_code", "provider", "model",
                        "confidence", "audio_ms", "billed_ms", "chunk_count", "ciphertext",
                        "wrapped_dek", "kek_version", "iv", "completed_at"):
                assert row[col] is None, col
            pk = await conn.fetchval(
                "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                "WHERE conrelid = 'voicemail_transcripts'::regclass AND contype = 'p'")
            assert pk == "PRIMARY KEY (message_id)"
            with pytest.raises(asyncpg.UniqueViolationError):
                await _transcript(conn, msg, box, cid)  # one row per message
            # The pre-56 stored message is covered by the new UNIQUE / FK too.
            old = mig_db["old_msg"]
            await _transcript(conn, old, 1, 1, status="disabled")
            await conn.execute("DELETE FROM voicemail_transcripts WHERE message_id = $1::bigint",
                               old)
        finally:
            await conn.close()

    _run(go())


# ---------------------------------------------------------------------------
# CHECKs
# ---------------------------------------------------------------------------
def test_status_and_crypto_checks(mig_db):
    async def go():
        conn = await _connect(mig_db["pg"], "postgres")
        try:
            cid, box, msg = await _fixture(conn)
            for status in ("pending", "empty", "failed", "disabled"):
                await _transcript(conn, msg, box, cid, status=status)
                await conn.execute("DELETE FROM voicemail_transcripts")
            with pytest.raises(asyncpg.CheckViolationError):
                await _transcript(conn, msg, box, cid, status="queued")
            # 'done' needs EVERY crypto field.
            await _transcript(conn, msg, box, cid, status="done", **CRYPTO)
            await conn.execute("DELETE FROM voicemail_transcripts")
            for missing in CRYPTO:
                partial = {k: v for k, v in CRYPTO.items() if k != missing}
                with pytest.raises(asyncpg.CheckViolationError) as ei:
                    await _transcript(conn, msg, box, cid, status="done", **partial)
                assert ei.value.constraint_name == "voicemail_transcripts_crypto_chk"
            # ...and no other status may carry ANY of them (no stale ciphertext).
            for status in ("pending", "processing", "empty", "failed", "disabled"):
                for field, value in CRYPTO.items():
                    extra = {"lease_until": EXPIRES, "attempt_id": uuid.uuid4()} \
                        if status == "processing" else {}
                    with pytest.raises(asyncpg.CheckViolationError) as ei:
                        await _transcript(conn, msg, box, cid, status=status,
                                          **{field: value}, **extra)
                    assert ei.value.constraint_name == "voicemail_transcripts_crypto_chk"
            # A re-queue that forgets to NULL the ciphertext is refused.
            await _transcript(conn, msg, box, cid, status="done", **CRYPTO)
            with pytest.raises(asyncpg.CheckViolationError):
                await conn.execute("UPDATE voicemail_transcripts SET status = 'pending' "
                                   "WHERE message_id = $1::bigint", msg)
            await conn.execute("DELETE FROM voicemail_transcripts")
        finally:
            await conn.close()

    _run(go())


def test_lease_check(mig_db):
    async def go():
        conn = await _connect(mig_db["pg"], "postgres")
        try:
            cid, box, msg = await _fixture(conn)
            for extra in ({}, {"lease_until": EXPIRES}, {"attempt_id": uuid.uuid4()}):
                with pytest.raises(asyncpg.CheckViolationError) as ei:
                    await _transcript(conn, msg, box, cid, status="processing", **extra)
                assert ei.value.constraint_name == "voicemail_transcripts_lease_chk"
            await _transcript(conn, msg, box, cid, status="processing", lease_until=EXPIRES,
                              attempt_id=uuid.uuid4())
            await conn.execute("DELETE FROM voicemail_transcripts")
        finally:
            await conn.close()

    _run(go())


@pytest.mark.parametrize("field, bad, good, constraint", [
    ("iv", [b"\x00" * 11, b"\x00" * 13], [b"\x00" * 12], "voicemail_transcripts_iv_len_chk"),
    ("ciphertext", [b"\x00" * 16, b"\x00" * 65553], [b"\x00" * 17, b"\x00" * 65552],
     "voicemail_transcripts_ct_len_chk"),
])
def test_crypto_length_checks(mig_db, field, bad, good, constraint):
    async def go():
        conn = await _connect(mig_db["pg"], "postgres")
        try:
            cid, box, msg = await _fixture(conn)
            for value in bad:
                with pytest.raises(asyncpg.CheckViolationError) as ei:
                    await _transcript(conn, msg, box, cid, status="done",
                                      **{**CRYPTO, field: value})
                assert ei.value.constraint_name == constraint
            for value in good:
                await _transcript(conn, msg, box, cid, status="done", **{**CRYPTO, field: value})
                await conn.execute("DELETE FROM voicemail_transcripts")
        finally:
            await conn.close()

    _run(go())


@pytest.mark.parametrize("field, bad, good, constraint", [
    ("confidence", [-0.001, 1.001], [0.0, 0.5, 1.0, None], "voicemail_transcripts_confidence_chk"),
    ("language", ["en-us", "en_US", "EN-US", "en", "en-USA"], ["en-US", "es-US", "fr-CA", "fil-PH"],
     "voicemail_transcripts_language_chk"),
    ("attempts", [-1, 101], [0, 5, 100], "voicemail_transcripts_attempts_chk"),
    ("error_code", ["Stt_Rejected", "stt rejected", "stt-rejected", "",
                    "PermissionDenied: 403"],
     ["stt_rejected", "lease_expired", "db", "x" * 40, None],
     "voicemail_transcripts_error_code_chk"),
])
def test_value_checks(mig_db, field, bad, good, constraint):
    async def go():
        conn = await _connect(mig_db["pg"], "postgres")
        try:
            cid, box, msg = await _fixture(conn)
            for value in bad:
                with pytest.raises(asyncpg.CheckViolationError) as ei:
                    await _transcript(conn, msg, box, cid, **{field: value})
                assert ei.value.constraint_name == constraint
            for value in good:
                await _transcript(conn, msg, box, cid, **{field: value})
                await conn.execute("DELETE FROM voicemail_transcripts")
            if field == "error_code":  # longer than the column: rejected by its type
                with pytest.raises(asyncpg.StringDataRightTruncationError):
                    await _transcript(conn, msg, box, cid, error_code="x" * 41)
        finally:
            await conn.close()

    _run(go())


# ---------------------------------------------------------------------------
# Composite FK + CASCADE
# ---------------------------------------------------------------------------
def test_composite_fk_ties_transcript_to_its_message(mig_db):
    async def go():
        conn = await _connect(mig_db["pg"], "postgres")
        try:
            cid, box, msg = await _fixture(conn)
            other_box = await _box(conn, cid)                    # same customer, other mailbox
            other_cid = await _customer(conn)
            foreign_box = await _box(conn, other_cid)            # another customer's mailbox
            for bad_box, bad_cid in ((other_box, cid), (box, other_cid),
                                     (foreign_box, other_cid)):
                with pytest.raises(asyncpg.ForeignKeyViolationError) as ei:
                    await _transcript(conn, msg, bad_box, bad_cid)
                assert ei.value.constraint_name == "voicemail_transcripts_message_fk"
            with pytest.raises(asyncpg.ForeignKeyViolationError):
                await _transcript(conn, 987654321, box, cid)     # no such message
            await _transcript(conn, msg, box, cid)
            # The AAD / tenant inputs cannot drift after the fact either.
            with pytest.raises(asyncpg.ForeignKeyViolationError):
                await conn.execute("UPDATE voicemail_transcripts SET mailbox_id = $1::int "
                                   "WHERE message_id = $2::bigint", other_box, msg)
            # CASCADE: deleting the message row deletes its transcript.
            await conn.execute("DELETE FROM voicemail_messages WHERE id = $1::bigint", msg)
            assert await _count(conn, msg) == 0
        finally:
            await conn.close()

    _run(go())


# ---------------------------------------------------------------------------
# Purge trigger
# ---------------------------------------------------------------------------
_PURGE_SQL = ("UPDATE voicemail_messages SET status = 'purged', object_key = NULL, "
              "ciphertext_crc32c = NULL, wrapped_dek = NULL, kek_version = NULL, iv = NULL, "
              "purged_at = now() WHERE id = $1::bigint")


def test_purge_deletes_the_transcript_in_the_same_transaction(mig_db):
    async def go():
        conn = await _connect(mig_db["pg"], "postgres")
        try:
            cid, box, msg = await _fixture(conn)
            await _transcript(conn, msg, box, cid, status="done", **CRYPTO)
            async with conn.transaction():
                await conn.execute(_PURGE_SQL, msg)
                assert await _count(conn, msg) == 0, "deleted inside the purge transaction"
            assert await _count(conn, msg) == 0

            # A rolled-back purge keeps the transcript.
            msg2 = await _msg(conn, box, cid)
            await _transcript(conn, msg2, box, cid)
            tx = conn.transaction()
            await tx.start()
            await conn.execute(_PURGE_SQL, msg2)
            await tx.rollback()
            assert await _count(conn, msg2) == 1
        finally:
            await conn.close()

    _run(go())


def test_purge_trigger_works_for_the_api_role(mig_db):
    """Invoker rights: the v1 API's purge paths (user purge, retention,
    mailbox delete, erase) need only the api role's DELETE grant."""
    async def go():
        owner = await _connect(mig_db["pg"], "postgres")
        api = await _connect(mig_db["pg"], "api")
        try:
            cid, box, msg = await _fixture(owner)
            await _transcript(owner, msg, box, cid, status="failed", error_code="stt_rejected")
            await api.execute(_PURGE_SQL, msg)
            assert await _count(owner, msg) == 0
        finally:
            await api.close()
            await owner.close()

    _run(go())


def test_other_transitions_keep_the_transcript(mig_db):
    async def go():
        conn = await _connect(mig_db["pg"], "postgres")
        try:
            cid, box, _ = await _fixture(conn)
            # The deposit path: pending -> stored (and failed -> pending -> stored).
            pending = await _msg(conn, box, cid, status="pending")
            await _transcript(conn, pending, box, cid)
            await conn.execute("UPDATE voicemail_messages SET status = 'failed' "
                               "WHERE id = $1::bigint", pending)
            await conn.execute("UPDATE voicemail_messages SET status = 'pending' "
                               "WHERE id = $1::bigint", pending)
            await conn.execute(
                "UPDATE voicemail_messages SET status = 'stored', object_key = 'k', "
                "ciphertext_crc32c = 1, wrapped_dek = 'w', kek_version = 'v', "
                "iv = '\\x000000000000000000000000'::bytea WHERE id = $1::bigint", pending)
            assert await _count(conn, pending) == 1
            # Flags, trash and restore touch status-less columns or keep 'stored'.
            await conn.execute("UPDATE voicemail_messages SET is_read = true, is_saved = true, "
                               "deleted_at = now() WHERE id = $1::bigint", pending)
            await conn.execute("UPDATE voicemail_messages SET status = 'stored', "
                               "deleted_at = NULL WHERE id = $1::bigint", pending)
            assert await _count(conn, pending) == 1
            # stored -> failed is not a purge either.
            await conn.execute("UPDATE voicemail_messages SET status = 'failed' "
                               "WHERE id = $1::bigint", pending)
            assert await _count(conn, pending) == 1
            trig = await conn.fetchrow(
                "SELECT tgenabled::text AS tgenabled, pg_get_triggerdef(oid) AS def FROM pg_trigger "
                "WHERE tgname = 'trg_vm_messages_purge_transcript' AND NOT tgisinternal")
            assert trig["tgenabled"] == "O"
            assert "AFTER UPDATE OF status ON public.voicemail_messages" in trig["def"]
            assert "FOR EACH ROW" in trig["def"]
            assert "'purged'" in trig["def"]
            assert not await conn.fetchval(
                "SELECT has_function_privilege('public', "
                "'voicemail_messages_purge_transcript()', 'EXECUTE')")
        finally:
            await conn.close()

    _run(go())


def test_stray_row_of_an_already_purged_message_is_not_resurrected(mig_db):
    """The discovery race (plan §6.3): a transcript row inserted for a message
    purged meanwhile survives the FK (status is not checked) — the trigger
    does not fire on purged -> purged, and the row can never be served (the
    claim requires a stored message; the retention orphan arm deletes it)."""
    async def go():
        conn = await _connect(mig_db["pg"], "postgres")
        try:
            cid, box, msg = await _fixture(conn)
            await conn.execute(_PURGE_SQL, msg)
            await _transcript(conn, msg, box, cid)
            await conn.execute("UPDATE voicemail_messages SET status = 'purged' "
                               "WHERE id = $1::bigint", msg)
            assert await _count(conn, msg) == 1
            await conn.execute("DELETE FROM voicemail_transcripts WHERE message_id = $1::bigint",
                               msg)
        finally:
            await conn.close()

    _run(go())


# ---------------------------------------------------------------------------
# Grants + the stats view
# ---------------------------------------------------------------------------
def test_grants(mig_db):
    async def go():
        conn = await _connect(mig_db["pg"], "postgres")
        try:
            for priv, expected in (("SELECT", True), ("INSERT", True), ("UPDATE", True),
                                   ("DELETE", True), ("TRUNCATE", False),
                                   ("REFERENCES", False), ("TRIGGER", False)):
                assert await conn.fetchval(
                    "SELECT has_table_privilege('api', 'voicemail_transcripts', $1::text)",
                    priv) is expected, priv
            for role in ("freeswitch", "grafana_ro", "public"):
                for priv in ("SELECT", "INSERT", "UPDATE", "DELETE"):
                    assert not await conn.fetchval(
                        "SELECT has_table_privilege($1::text, 'voicemail_transcripts', $2::text)",
                        role, priv), (role, priv)
            for role, expected in (("api", True), ("grafana_ro", True), ("freeswitch", False),
                                   ("public", False)):
                assert await conn.fetchval(
                    "SELECT has_table_privilege($1::text, 'voicemail_transcription_stats', "
                    "'SELECT')", role) is expected, role
            # 24's default privileges ARE live here, so the REVOKE mattered.
            await conn.execute("CREATE TABLE zz_probe56 (x int)")
            assert await conn.fetchval(
                "SELECT has_table_privilege('grafana_ro', 'zz_probe56', 'SELECT')")
            await conn.execute("DROP TABLE zz_probe56")
        finally:
            await conn.close()

        for role in ("freeswitch", "grafana_ro"):
            c = await _connect(mig_db["pg"], role)
            try:
                with pytest.raises(asyncpg.InsufficientPrivilegeError):
                    await c.fetch("SELECT ciphertext FROM voicemail_transcripts LIMIT 1")
            finally:
                await c.close()

    _run(go())


def test_stats_view_counts_only(mig_db):
    async def go():
        conn = await _connect(mig_db["pg"], "postgres")
        try:
            await conn.execute("DELETE FROM voicemail_transcripts")
            cid = await _customer(conn)
            box = await _box(conn, cid)
            msgs = [await _msg(conn, box, cid) for _ in range(5)]
            await _transcript(conn, msgs[0], box, cid)
            await _transcript(conn, msgs[1], box, cid, status="done", billed_ms=30_000,
                              completed_at=datetime.now(timezone.utc), **CRYPTO)
            await _transcript(conn, msgs[2], box, cid, status="empty", billed_ms=0,
                              completed_at=datetime.now(timezone.utc))
            await _transcript(conn, msgs[3], box, cid, status="done", billed_ms=99_000,
                              completed_at=datetime(2020, 1, 1, tzinfo=timezone.utc), **CRYPTO)
            await _transcript(conn, msgs[4], box, cid, status="failed", error_code="stt_rejected")
            cols = [r["column_name"] for r in await conn.fetch(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'voicemail_transcription_stats' ORDER BY ordinal_position")]
            assert cols == ["status", "jobs", "oldest_created_at", "billed_ms_24h"]
        finally:
            await conn.close()

        graf = await _connect(mig_db["pg"], "grafana_ro")
        try:
            rows = {r["status"]: r for r in await graf.fetch(
                "SELECT * FROM voicemail_transcription_stats")}
        finally:
            await graf.close()
        assert {s: r["jobs"] for s, r in rows.items()} == \
            {"pending": 1, "done": 2, "empty": 1, "failed": 1}
        assert rows["done"]["billed_ms_24h"] == 30_000      # the 2020 row is outside 24 h
        assert rows["pending"]["billed_ms_24h"] == 0
        assert all(r["oldest_created_at"] is not None for r in rows.values())

    _run(go())


# ---------------------------------------------------------------------------
# The worker's statements ride the new indexes (plan §6 / §9)
# ---------------------------------------------------------------------------
DISCOVERY_SQL = """
INSERT INTO voicemail_transcripts (message_id, mailbox_id, customer_id, status, language)
SELECT m.id, m.mailbox_id, m.customer_id,
       CASE WHEN b.transcription_enabled THEN 'pending' ELSE 'disabled' END,
       b.transcription_language
  FROM voicemail_messages m
  JOIN voicemail_boxes b ON b.id = m.mailbox_id
 WHERE m.status = 'stored'
   AND m.created_at >= now() - make_interval(secs => $1::int)
   AND b.status <> 'deleted'
   AND NOT EXISTS (SELECT 1 FROM voicemail_transcripts t WHERE t.message_id = m.id)
 ORDER BY m.created_at
 LIMIT $2::int
ON CONFLICT (message_id) DO NOTHING
"""

CLAIM_SQL = """
WITH pick AS (
    SELECT t.message_id
      FROM voicemail_transcripts t
      JOIN voicemail_messages m        ON m.id = t.message_id
      JOIN voicemail_boxes b           ON b.id = t.mailbox_id
      JOIN customers c                 ON c.id = t.customer_id
      JOIN voicemail_customer_keys k   ON k.customer_id = t.customer_id
     WHERE t.status = 'pending' AND t.next_attempt_at <= now()
       AND m.status = 'stored' AND m.deleted_at IS NULL
       AND b.status <> 'deleted' AND b.transcription_enabled
       AND c.voicemail_enabled AND k.status = 'active'
     ORDER BY t.next_attempt_at, t.message_id
     LIMIT 1
     FOR UPDATE OF t SKIP LOCKED
)
UPDATE voicemail_transcripts t
   SET status = 'processing', attempts = t.attempts + 1, attempt_id = $1::uuid,
       lease_until = now() + make_interval(secs => $2::int),
       language = b.transcription_language, error_code = NULL, updated_at = now()
  FROM pick, voicemail_boxes b
 WHERE t.message_id = pick.message_id AND b.id = t.mailbox_id
RETURNING t.message_id, t.mailbox_id, t.customer_id, t.language, t.attempts
"""

REAPER_SQL = """
UPDATE voicemail_transcripts t
   SET status = CASE WHEN t.attempts >= $1::int THEN 'failed' ELSE 'pending' END,
       error_code = 'lease_expired', lease_until = NULL, attempt_id = NULL,
       next_attempt_at = now() + interval '1 minute', updated_at = now()
 WHERE t.message_id IN (SELECT message_id FROM voicemail_transcripts
                         WHERE status = 'processing' AND lease_until < now()
                         ORDER BY lease_until LIMIT 50
                         FOR UPDATE SKIP LOCKED)
"""

BUDGET_SQL = """
SELECT COALESCE(sum(billed_ms), 0) FROM voicemail_transcripts
 WHERE status IN ('done', 'empty') AND completed_at >= now() - interval '24 hours'
"""

MAILBOX_DELETE_SQL = "DELETE FROM voicemail_transcripts WHERE mailbox_id = $1::int"
MAILBOX_DISABLE_SQL = ("UPDATE voicemail_transcripts SET status = 'disabled', updated_at = now() "
                       "WHERE mailbox_id = $1::int AND status = 'pending'")


@pytest.mark.parametrize("sql, args, index", [
    (DISCOVERY_SQL, (3600, 200), "idx_vm_messages_stored_created"),
    (CLAIM_SQL, (uuid.uuid4(), 600), "idx_vm_transcripts_due"),
    (REAPER_SQL, (5,), "idx_vm_transcripts_lease"),
    (BUDGET_SQL, (), "idx_vm_transcripts_completed"),
    (MAILBOX_DELETE_SQL, (1,), "idx_vm_transcripts_mailbox"),
    (MAILBOX_DISABLE_SQL, (1,), "idx_vm_transcripts_mailbox"),
], ids=["discovery", "claim", "reaper", "budget", "mailbox_delete", "mailbox_disable"])
def test_worker_statements_use_the_new_indexes(mig_db, sql, args, index):
    async def go():
        conn = await _connect(mig_db["pg"], "postgres")
        try:
            async with conn.transaction():
                await conn.execute("SET LOCAL enable_seqscan = off")
                plan = "\n".join(r[0] for r in await conn.fetch(f"EXPLAIN {sql}", *args))
        finally:
            await conn.close()
        assert index in plan, plan

    _run(go())


def test_claim_and_discovery_execute_against_the_schema(mig_db):
    """The §6 statements are valid against 56 (types, joins, ON CONFLICT
    target) and do what they say on a tiny dataset."""
    async def go():
        conn = await _connect(mig_db["pg"], "postgres")
        try:
            await conn.execute("DELETE FROM voicemail_transcripts")
            cid = await _customer(conn)
            on_box, off_box = await _box(conn, cid), await _box(conn, cid)
            await conn.execute("UPDATE voicemail_boxes SET transcription_enabled = true, "
                               "transcription_language = 'es-US' WHERE id = $1::int", on_box)
            await conn.execute("INSERT INTO voicemail_customer_keys (customer_id, provider, "
                               "key_ref) VALUES ($1::int, 'local', $2::text)", cid, f"local:{cid}")
            on_msg, off_msg = await _msg(conn, on_box, cid), await _msg(conn, off_box, cid)
            await conn.execute(DISCOVERY_SQL, 3600, 200)
            rows = {r["message_id"]: tuple(r)[1:] for r in await conn.fetch(
                "SELECT message_id, status, language FROM voicemail_transcripts "
                "WHERE message_id = ANY($1::bigint[])", [on_msg, off_msg])}
            assert rows == {on_msg: ("pending", "es-US"), off_msg: ("disabled", "en-US")}
            await conn.execute(DISCOVERY_SQL, 3600, 200)  # idempotent
            assert await conn.fetchval(
                "SELECT count(*) FROM voicemail_transcripts "
                "WHERE message_id = ANY($1::bigint[])", [on_msg, off_msg]) == 2

            token = uuid.uuid4()
            claimed = await conn.fetchrow(CLAIM_SQL, token, 600)
            assert claimed["message_id"] == on_msg and claimed["attempts"] == 1
            assert claimed["language"] == "es-US"
            assert await conn.fetchrow(CLAIM_SQL, uuid.uuid4(), 600) is None  # nothing else due
            row = await conn.fetchrow("SELECT status, attempt_id, lease_until FROM "
                                      "voicemail_transcripts WHERE message_id = $1::bigint", on_msg)
            assert row["status"] == "processing" and row["attempt_id"] == token
            assert row["lease_until"] is not None
        finally:
            await conn.close()

    _run(go())
