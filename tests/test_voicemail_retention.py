"""Voicemail retention worker (contract §4.7; services/voicemail/retention.py).

On the shared harness (ephemeral PG 16 + migration 54, local KMS, memory
object store). Builds one row per arm (and the rows each arm must NOT touch)
with real deposited objects, then runs ``sweep_once`` and checks: the right
rows -> 'purged' (crypto fields nulled, object deleted), everything else
intact, one ``retention_purge`` audit row per mailbox per batch, the
advisory lock (a second concurrent sweeper skips), an unavailable object
store is survived (nothing marked purged without its object gone), and the
access log is never modified.

Run:  JWT_SECRET_KEY=x python -m pytest tests/test_voicemail_retention.py -q
"""
import uuid

import pytest

from voicemail_api_harness import CUST_A, Harness, make_wav, memory_store

PORT = 55474

_dids = iter(range(4000, 9999))


def new_did() -> str:
    return f"+1413555{next(_dids):04d}"


@pytest.fixture(scope="module")
def h():
    harness = Harness(PORT).start()
    try:
        yield harness
    finally:
        harness.stop()


@pytest.fixture(autouse=True)
def _fresh(h):
    h.reset_caches()
    yield


async def _deposit(h, box_id) -> dict:
    mid = await h.deposit_ok(box_id)
    return (await h.fetch("SELECT * FROM voicemail_messages WHERE id = $1", mid))[0]


async def _upload_greeting(h, box_id) -> dict:
    r = await h.client.post(f"/v1/voicemail/mailboxes/{box_id}/greetings",
                            params={"label": "g", "activate": "false"},
                            headers={**h.auth("admin"), "Content-Type": "audio/wav"},
                            content=make_wav(1.0, 16000))
    assert r.status_code == 201, r.text
    return (await h.fetch("SELECT * FROM voicemail_greetings WHERE id = $1", r.json()["id"]))[0]


async def _orphan_message(h, box, status, *, age="2 hours", lease=None) -> dict:
    """A pending/failed row WITH an object at its deterministic key (the
    upload landed, the finalize did not)."""
    from services.voicemail import message_object_key
    msg_uuid = str(uuid.uuid4())
    await h.execute(
        "INSERT INTO voicemail_messages (msg_uuid, mailbox_id, customer_id, size_bytes, status, "
        "expires_at, created_at, deposit_lease_until) VALUES ($1::uuid, $2, $3, 10, $4, "
        "now() + interval '90 days', now() - $5::text::interval, "
        "CASE WHEN $6::text IS NULL THEN NULL ELSE now() + $6::text::interval END)",
        msg_uuid, box["id"], box["customer_id"], status, age, lease)
    key = message_object_key(box["customer_id"], box["id"], msg_uuid)
    from services.voicemail._crc import crc32c
    memory_store()._objects[key] = (b"ciphertext", crc32c(b"ciphertext"))
    return (await h.fetch("SELECT * FROM voicemail_messages WHERE msg_uuid = $1::uuid",
                          msg_uuid))[0] | {"object_key": key}


def test_sweep_purges_exactly_the_right_rows(h):
    async def go():
        from services.voicemail import retention
        await h.execute("INSERT INTO customers (id, name, account_type) VALUES "
                        "(150, 'Retain', 'rcf'), (151, 'Erased', 'rcf')")
        box = await h.create_mailbox(150, new_did())
        gone_box = await h.create_mailbox(150, new_did())
        erased_box = await h.create_mailbox(151, new_did())
        store = memory_store()

        expired = await _deposit(h, box["id"])
        old_trash = await _deposit(h, box["id"])
        new_trash = await _deposit(h, box["id"])
        keep = await _deposit(h, box["id"])
        await h.execute("UPDATE voicemail_messages SET expires_at = now() - interval '1 minute' "
                        "WHERE id = $1", expired["id"])
        await h.execute("UPDATE voicemail_messages SET deleted_at = now() - interval '31 days' "
                        "WHERE id = $1", old_trash["id"])
        await h.execute("UPDATE voicemail_messages SET deleted_at = now() - interval '29 days' "
                        "WHERE id = $1", new_trash["id"])
        old_pending = await _orphan_message(h, box, "pending", age="2 hours")
        leased_pending = await _orphan_message(h, box, "pending", age="2 hours",
                                               lease="5 minutes")
        young_pending = await _orphan_message(h, box, "pending", age="5 minutes")
        old_failed = await _orphan_message(h, box, "failed", age="11 minutes")
        young_failed = await _orphan_message(h, box, "failed", age="1 minute")
        gone_msg = await _deposit(h, gone_box["id"])
        gone_greeting = await _upload_greeting(h, gone_box["id"])
        await h.execute("UPDATE voicemail_boxes SET status = 'deleted' WHERE id = $1",
                        gone_box["id"])
        erased_msg = await _deposit(h, erased_box["id"])
        erased_greeting = await _upload_greeting(h, erased_box["id"])
        await h.execute("UPDATE voicemail_customer_keys SET status = 'destroyed', "
                        "destroyed_at = now() WHERE customer_id = 151")
        keep_greeting = await _upload_greeting(h, box["id"])
        old_pending_greeting_id = await h.fetchval(
            "INSERT INTO voicemail_greetings (greeting_uuid, mailbox_id, customer_id, size_bytes, "
            "status, created_at) VALUES ($1::uuid, $2, 150, 5, 'pending', "
            "now() - interval '2 hours') RETURNING id", str(uuid.uuid4()), box["id"])
        log_before = await h.fetch("SELECT * FROM voicemail_access_log ORDER BY id")

        counts = await retention.sweep_once()
        assert "skipped" not in counts and "error" not in counts, counts

        async def status(table, row_id):
            return await h.fetchval(f"SELECT status FROM {table} WHERE id = $1", row_id)

        purged_msgs = [expired, old_trash, old_pending, old_failed, gone_msg, erased_msg]
        kept_msgs = [(new_trash, "stored"), (keep, "stored"), (leased_pending, "pending"),
                     (young_pending, "pending"), (young_failed, "failed")]
        for row in purged_msgs:
            full = (await h.fetch("SELECT * FROM voicemail_messages WHERE id = $1",
                                  row["id"]))[0]
            assert full["status"] == "purged", row["id"]
            assert full["purged_at"] is not None
            for col in ("object_key", "ciphertext_crc32c", "wrapped_dek", "kek_version", "iv",
                        "deposit_lease_until"):
                assert full[col] is None, (row["id"], col)
            assert row["object_key"] not in store.keys(), row["id"]
        for row, expected in kept_msgs:
            assert await status("voicemail_messages", row["id"]) == expected, row["id"]
            assert row["object_key"] in store.keys(), row["id"]
        for g in (gone_greeting, erased_greeting):
            assert await status("voicemail_greetings", g["id"]) == "purged"
            assert g["object_key"] not in store.keys()
        assert await status("voicemail_greetings", keep_greeting["id"]) == "stored"
        assert keep_greeting["object_key"] in store.keys()
        assert await status("voicemail_greetings", old_pending_greeting_id) == "purged"

        for arm in ("message:expired", "message:trash", "message:pending", "message:failed",
                    "message:mailbox_deleted", "message:key_destroyed",
                    "greeting:mailbox_deleted", "greeting:key_destroyed", "greeting:pending"):
            assert counts.get(arm, 0) >= 1, (arm, counts)

        # Audit: rows only ADDED (append-only), retention_purge per mailbox.
        log_after = await h.fetch("SELECT * FROM voicemail_access_log ORDER BY id")
        assert log_after[:len(log_before)] == log_before
        added = log_after[len(log_before):]
        assert added and {r["action"] for r in added} == {"retention_purge"}
        assert all(r["source"] == "system" for r in added)
        ids_logged = {i for r in added for i in __import__("json").loads(r["detail"])["ids"]}
        assert {r["id"] for r in purged_msgs} <= ids_logged

        # Idempotent: a second run purges nothing new.
        counts2 = await retention.sweep_once()
        assert not any(v for k, v in counts2.items() if ":" in k), counts2

    h.run(go())


def test_advisory_lock_single_sweeper(h):
    async def go():
        from services.voicemail import retention
        holder = await h.owner()
        try:
            tx = holder.transaction()
            await tx.start()
            assert await holder.fetchval("SELECT pg_try_advisory_xact_lock($1::bigint)",
                                         retention.LOCK_KEY)
            counts = await retention.sweep_once()
            assert counts == {"skipped": "another worker is sweeping"}
            await tx.rollback()
        finally:
            await holder.close()
        counts = await retention.sweep_once()
        assert "skipped" not in counts

    h.run(go())


def test_store_unavailable_is_survived(h, monkeypatch):
    async def go():
        from services.voicemail import mailboxes, retention
        from services.voicemail.errors import VoicemailCryptoUnavailable
        box = await h.create_mailbox(CUST_A, new_did())
        row = await _deposit(h, box["id"])
        await h.execute("UPDATE voicemail_messages SET expires_at = now() - interval '1 minute' "
                        "WHERE id = $1", row["id"])

        async def down(key):
            raise VoicemailCryptoUnavailable("GCS unavailable (test)")

        monkeypatch.setattr(mailboxes, "delete_object", down)
        counts = await retention.sweep_once()
        assert counts.get("deferred", 0) >= 1 and "error" not in counts, counts
        assert await h.fetchval("SELECT status FROM voicemail_messages WHERE id = $1",
                                row["id"]) == "stored"
        assert row["object_key"] in memory_store().keys()
        monkeypatch.undo()
        counts = await retention.sweep_once()
        assert counts.get("message:expired", 0) >= 1
        assert await h.fetchval("SELECT status FROM voicemail_messages WHERE id = $1",
                                row["id"]) == "purged"

    h.run(go())


def test_sweep_without_pool_or_kms_never_raises(h, monkeypatch):
    async def go():
        from db import database as db
        from services.voicemail import retention
        # No KMS needed: an unusable KMS config does not stop the sweep.
        monkeypatch.setenv("VOICEMAIL_KMS_PROVIDER", "gcpkms")
        counts = await retention.sweep_once()
        assert "error" not in counts and "skipped" not in counts
        saved = db.pool
        db.pool = None
        try:
            assert await retention.sweep_once() == {"skipped": "no database pool"}
        finally:
            db.pool = saved
        assert retention.enabled() is False  # harness env turns the lifespan task off
        monkeypatch.delenv("VOICEMAIL_RETENTION_ENABLED")
        assert retention.enabled() is True

    h.run(go())
