"""Voicemail product API (routers/voicemail.py) — contract §4.1-§4.5, §4.8.

Real routers behind the real JWTAuthMiddleware on an ephemeral PostgreSQL 16
built from the real init scripts + migration 54 (tests/voicemail_api_harness.py);
local KMS + in-memory object store (no Google Cloud).

Covers: tenant 404-no-leak across customers (lists, per-id routes, playback,
greetings), admin preview with customer_id, support 403, readonly = reads +
playback only, voicemail-disabled tenant sees [] / enabled:false, mailbox
create (DID claim, KMS-down 503 with nothing committed), PATCH semantics the
UI relies on, PIN, message folders/trash/restore/purge, playback tokens
(Bearer rejection, once-per-token audit across "processes", Range/416/HEAD,
audit failure 503), greetings (strict WAV validation, activate, FS fetch),
FS mailbox lookup, mailbox delete, crypto-erase, available numbers, the
number_inventory voicemail arms, and the customer-delete 409.

Run:  JWT_SECRET_KEY=x python -m pytest tests/test_voicemail_api.py -q
"""
import asyncio
import re
import struct
import time

import pytest

from voicemail_api_harness import (
    CUST_A,
    CUST_B,
    CUST_INACTIVE,
    INGEST_SECRET,
    Harness,
    make_wav,
    memory_store,
    pcm_tone,
)

PORT = 55472  # distinct from every other test module

MAILBOX_KEYS = {"id", "customer_id", "customer_name", "did", "label", "status", "timezone",
                "greeting_mode", "active_greeting_id", "has_pin", "retention_days",
                "max_message_seconds", "max_messages", "max_bytes", "message_count",
                "unread_count", "bytes_used", "created_at",
                # transcription v1.1 (additive, docs/VOICEMAIL_TRANSCRIPTION_PLAN.md §10.1)
                "transcription_enabled", "transcription_language"}
MESSAGE_KEYS = {"id", "mailbox_id", "caller_id_number", "caller_id_name", "duration_ms",
                "size_bytes", "is_read", "is_saved", "deleted_at", "created_at", "expires_at",
                "transcript"}  # transcription v1.1 (additive, plan §10.1)
GREETING_KEYS = {"id", "mailbox_id", "label", "duration_ms", "size_bytes", "is_active",
                 "created_at"}

_did_counter = iter(range(2000, 9999))


def new_did() -> str:
    return f"+1617555{next(_did_counter):04d}"


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


def run(h, coro):
    return h.run(coro)


def path_of(url: str) -> str:
    """The UI uses the URL verbatim under /api; the API itself sees it
    without the /api prefix (nginx strips it)."""
    assert url.startswith("/api/v1/voicemail/")
    return url[len("/api"):]


def wav_with_fmt(*, channels=1, rate=8000, bits=16, fmt_tag=1, pcm=None, extra_chunks=b"",
                 data_first=False, data_len=None):
    pcm = pcm if pcm is not None else pcm_tone(1.0, rate)
    block = channels * bits // 8
    fmt = b"fmt " + struct.pack("<IHHIIHH", 16, fmt_tag, channels, rate, rate * block, block, bits)
    data = b"data" + struct.pack("<I", len(pcm) if data_len is None else data_len) + pcm
    chunks = (data + fmt) if data_first else (extra_chunks + fmt + data)
    return b"RIFF" + struct.pack("<I", 4 + len(chunks)) + b"WAVE" + chunks


# ===========================================================================
# Scope: summary / list / per-id, tenants, admin preview, support, disabled
# ===========================================================================
def test_scope_rules_and_no_leak(h):
    async def go():
        box = await h.create_mailbox(CUST_A, new_did(), label="Front desk")
        assert set(box) == MAILBOX_KEYS
        assert box["customer_id"] == CUST_A and box["customer_name"] == "Acme Voicemail"
        assert box["status"] == "active" and box["has_pin"] is False
        assert box["retention_days"] == 90 and box["max_message_seconds"] == 300
        assert box["max_messages"] == 100 and box["max_bytes"] == 524288000
        c = h.client

        r = await c.get("/v1/voicemail/summary", headers=h.auth("user_a"))
        assert r.status_code == 200, r.text
        s = r.json()
        assert s["enabled"] is True and s["can_manage"] is False and s["mailbox_count"] >= 1

        r = await c.get("/v1/voicemail/mailboxes", headers=h.auth("user_a"))
        assert box["id"] in [b["id"] for b in r.json()]
        assert all(b["customer_id"] == CUST_A for b in r.json())
        # Another customer's id as the param -> 404, never data.
        r = await c.get(f"/v1/voicemail/mailboxes?customer_id={CUST_B}", headers=h.auth("user_a"))
        assert r.status_code == 404
        r = await c.get(f"/v1/voicemail/summary?customer_id={CUST_B}", headers=h.auth("user_a"))
        assert r.status_code == 404
        # Own id as the param is fine.
        r = await c.get(f"/v1/voicemail/mailboxes?customer_id={CUST_A}", headers=h.auth("user_a"))
        assert r.status_code == 200

        # Customer B (voicemail disabled, no boxes) sees nothing of A.
        r = await c.get("/v1/voicemail/mailboxes", headers=h.auth("user_b"))
        assert r.status_code == 200 and r.json() == []
        r = await c.get("/v1/voicemail/summary", headers=h.auth("user_b"))
        assert r.json() == {"enabled": False, "mailbox_count": 0, "unread_count": 0,
                            "can_manage": False, "transcription_available": False}
        for path in (f"/v1/voicemail/mailboxes/{box['id']}",
                     f"/v1/voicemail/mailboxes/{box['id']}/messages",
                     f"/v1/voicemail/mailboxes/{box['id']}/greetings"):
            r = await c.get(path, headers=h.auth("user_b"))
            assert r.status_code == 404, (path, r.text)
        r = await c.patch(f"/v1/voicemail/mailboxes/{box['id']}", headers=h.auth("user_b"),
                          json={"label": "hijack"})
        assert r.status_code == 404
        r = await c.put(f"/v1/voicemail/mailboxes/{box['id']}/pin", headers=h.auth("user_b"),
                        json={"pin": "1234"})
        assert r.status_code == 404
        # Unknown id and out-of-range id are the same 404.
        for mid in (999999, 2**40):
            r = await c.get(f"/v1/voicemail/mailboxes/{mid}", headers=h.auth("user_a"))
            assert r.status_code == 404

        # Admin: all customers, or one (preview), summary can_manage.
        r = await c.get("/v1/voicemail/mailboxes", headers=h.auth("admin"))
        assert box["id"] in [b["id"] for b in r.json()]
        r = await c.get(f"/v1/voicemail/mailboxes?customer_id={CUST_A}", headers=h.auth("admin"))
        assert {b["customer_id"] for b in r.json()} == {CUST_A}
        r = await c.get(f"/v1/voicemail/mailboxes?customer_id={CUST_B}", headers=h.auth("admin"))
        assert r.json() == []
        r = await c.get(f"/v1/voicemail/summary?customer_id={CUST_A}", headers=h.auth("admin"))
        assert r.json()["enabled"] is True and r.json()["can_manage"] is True
        r = await c.get(f"/v1/voicemail/summary?customer_id={CUST_B}", headers=h.auth("admin"))
        assert r.json()["enabled"] is False and r.json()["can_manage"] is True
        r = await c.get("/v1/voicemail/summary?customer_id=987654", headers=h.auth("admin"))
        assert r.status_code == 404
        r = await c.get("/v1/voicemail/summary", headers=h.auth("admin"))
        assert r.json()["enabled"] is True and r.json()["can_manage"] is True
        r = await c.get(f"/v1/voicemail/mailboxes/{box['id']}", headers=h.auth("admin"))
        assert r.status_code == 200

        # Support: 403 everywhere; no token: 401 (middleware).
        for path in ("/v1/voicemail/summary", "/v1/voicemail/mailboxes",
                     f"/v1/voicemail/mailboxes/{box['id']}"):
            r = await c.get(path, headers=h.auth("support"))
            assert r.status_code == 403, path
            r = await c.get(path)
            assert r.status_code == 401
        # Legacy (no /v1) mount works the same.
        r = await c.get("/voicemail/mailboxes", headers=h.auth("user_a"))
        assert r.status_code == 200 and box["id"] in [b["id"] for b in r.json()]

        # Voicemail disabled for A -> tenant sees [] / enabled false / 404,
        # admin still sees the mailbox.
        await h.execute("UPDATE customers SET voicemail_enabled = false WHERE id = $1", CUST_A)
        try:
            r = await c.get("/v1/voicemail/mailboxes", headers=h.auth("user_a"))
            assert r.status_code == 200 and r.json() == []
            r = await c.get("/v1/voicemail/summary", headers=h.auth("user_a"))
            assert r.json()["enabled"] is False and r.json()["mailbox_count"] == 0
            r = await c.get(f"/v1/voicemail/mailboxes/{box['id']}", headers=h.auth("user_a"))
            assert r.status_code == 404
            r = await c.get(f"/v1/voicemail/mailboxes/{box['id']}", headers=h.auth("admin"))
            assert r.status_code == 200
        finally:
            await h.execute("UPDATE customers SET voicemail_enabled = true WHERE id = $1", CUST_A)

    run(h, go())


def test_mailbox_ordering(h):
    async def go():
        await h.execute("INSERT INTO customers (id, name, account_type) VALUES "
                        "(110, 'Zeta Order', 'rcf'), (111, 'Alpha Order', 'rcf')")
        z1 = await h.create_mailbox(110, new_did(), label="B box")
        a2 = await h.create_mailbox(111, new_did(), label="Same")
        a1 = await h.create_mailbox(111, new_did(), label="Same")
        a0 = await h.create_mailbox(111, new_did(), label="A box")
        r = await h.client.get("/v1/voicemail/mailboxes", headers=h.auth("admin"))
        ids = [b["id"] for b in r.json() if b["customer_id"] in (110, 111)]
        # customer name, then label, then id
        assert a2["id"] < a1["id"]
        assert ids == [a0["id"], a2["id"], a1["id"], z1["id"]]

    run(h, go())


# ===========================================================================
# Create
# ===========================================================================
def test_create_mailbox_claims_did_and_validates(h):
    async def go():
        c = h.client
        did = new_did()
        await h.add_did(did)
        r = await c.post("/v1/voicemail/mailboxes", headers=h.auth("admin"),
                         json={"customer_id": CUST_A, "did": did[2:], "label": "  Sales  ",
                               "timezone": "America/Chicago", "pin": "4321"})
        assert r.status_code == 201, r.text
        box = r.json()
        assert box["did"] == did and box["label"] == "Sales"
        assert box["timezone"] == "America/Chicago" and box["has_pin"] is True
        inv = (await h.fetch("SELECT * FROM did_inventory WHERE did = $1", did))[0]
        assert inv["status"] == "assigned" and inv["customer_id"] == CUST_A
        assert inv["product_type"] == "voicemail" and inv["product_ref_id"] == box["id"]
        assert inv["assigned_by"] == 1
        assert await h.fetchval("SELECT voicemail_enabled FROM customers WHERE id = $1", CUST_A)
        nr = await h.fetch("SELECT * FROM number_routing WHERE did = $1", did)
        assert len(nr) == 1 and nr[0]["product_type"] == "voicemail"
        assert nr[0]["product_ref_id"] == box["id"] and nr[0]["product_enabled"] is True
        actions = [r["action"] for r in await h.fetch(
            "SELECT action FROM voicemail_access_log WHERE mailbox_id = $1 ORDER BY id",
            box["id"])]
        assert actions == ["mailbox_create", "pin_set"]
        assert await h.fetchval(
            "SELECT pin_hash LIKE '$2%' FROM voicemail_boxes WHERE id = $1", box["id"])

        # The same DID again -> 409 (now assigned).
        r = await c.post("/v1/voicemail/mailboxes", headers=h.auth("admin"),
                         json={"customer_id": CUST_A, "did": did})
        assert r.status_code == 409 and r.json()["detail"] == "That number is not available."
        # Not in inventory / reserved -> 409.
        r = await c.post("/v1/voicemail/mailboxes", headers=h.auth("admin"),
                         json={"customer_id": CUST_A, "did": "+19995550000"})
        assert r.status_code == 409
        reserved = new_did()
        await h.add_did(reserved, status="reserved")
        r = await c.post("/v1/voicemail/mailboxes", headers=h.auth("admin"),
                         json={"customer_id": CUST_A, "did": reserved})
        assert r.status_code == 409
        # Inventory drift: 'available' but an rcf row routes it -> 409 in use.
        drift = new_did()
        await h.add_did(drift)
        await h.execute("INSERT INTO rcf_numbers (did, customer_id, forward_to) "
                        "VALUES ($1, $2, '+17745550000')", drift, CUST_B)
        r = await c.post("/v1/voicemail/mailboxes", headers=h.auth("admin"),
                         json={"customer_id": CUST_A, "did": drift})
        assert r.status_code == 409 and r.json()["detail"] == "That number is already in use."

        free = new_did()
        await h.add_did(free)
        bad_inputs = [
            ({"did": "12"}, 422, "Enter a valid phone number."),
            ({"pin": "12a4"}, 422, "PIN must be 4 to 10 digits."),
            ({"pin": "123"}, 422, "PIN must be 4 to 10 digits."),
            ({"timezone": "Mars/Base"}, 422, "Choose a valid time zone."),
            ({"label": "   "}, 422, "Name must be 1 to 120 characters."),
            ({"label": "x" * 121}, 422, "Name must be 1 to 120 characters."),
            ({"customer_id": 987654}, 404, "Customer not found."),
            ({"customer_id": CUST_INACTIVE}, 409, "That customer is not active."),
        ]
        for extra, status, detail in bad_inputs:
            body = {"customer_id": CUST_A, "did": free, **extra}
            r = await c.post("/v1/voicemail/mailboxes", headers=h.auth("admin"), json=body)
            assert r.status_code == status, (extra, r.text)
            assert r.json()["detail"] == detail
        # Tenants / readonly / support cannot create.
        for who in ("user_a", "ro_a", "support"):
            r = await c.post("/v1/voicemail/mailboxes", headers=h.auth(who),
                             json={"customer_id": CUST_A, "did": free})
            assert r.status_code == 403
        assert await h.fetchval("SELECT status FROM did_inventory WHERE did = $1", free) == \
            "available"

    run(h, go())


def test_create_mailbox_kms_down_commits_nothing(h, monkeypatch):
    async def go():
        await h.execute("INSERT INTO customers (id, name, account_type) VALUES "
                        "(120, 'No Key Yet', 'rcf')")
        did = new_did()
        await h.add_did(did)
        # gcpkms without a project = KMS unavailable (fail closed) for a
        # customer that has no key row yet.
        monkeypatch.setenv("VOICEMAIL_KMS_PROVIDER", "gcpkms")
        from services.voicemail import kms
        kms.reset_kms_providers()
        r = await h.client.post("/v1/voicemail/mailboxes", headers=h.auth("admin"),
                                json={"customer_id": 120, "did": did})
        assert r.status_code == 503, r.text
        assert await h.fetchval("SELECT status FROM did_inventory WHERE did = $1", did) == \
            "available"
        assert await h.fetchval("SELECT count(*) FROM voicemail_boxes WHERE customer_id = 120") == 0
        assert await h.fetchval("SELECT voicemail_enabled FROM customers WHERE id = 120") is False
        assert await h.fetchval(
            "SELECT count(*) FROM voicemail_customer_keys WHERE customer_id = 120") == 0
        # KMS back -> works.
        monkeypatch.setenv("VOICEMAIL_KMS_PROVIDER", "local")
        kms.reset_kms_providers()
        r = await h.client.post("/v1/voicemail/mailboxes", headers=h.auth("admin"),
                                json={"customer_id": 120, "did": did})
        assert r.status_code == 201, r.text

    run(h, go())


# ===========================================================================
# PATCH / PIN
# ===========================================================================
def test_patch_mailbox_semantics(h):
    async def go():
        c = h.client
        box = await h.create_mailbox(CUST_A, new_did())
        other = await h.create_mailbox(CUST_A, new_did())
        url = f"/v1/voicemail/mailboxes/{box['id']}"

        r = await c.patch(url, headers=h.auth("user_a"),
                          json={"label": "Support line", "timezone": "Europe/London"})
        assert r.status_code == 200, r.text
        assert r.json()["label"] == "Support line" and r.json()["timezone"] == "Europe/London"
        assert set(r.json()) == MAILBOX_KEYS
        # Tenants cannot suspend; readonly cannot change anything.
        r = await c.patch(url, headers=h.auth("user_a"), json={"status": "suspended"})
        assert r.status_code == 403
        r = await c.patch(url, headers=h.auth("ro_a"), json={"label": "x"})
        assert r.status_code == 403
        # custom without a stored greeting -> 422.
        r = await c.patch(url, headers=h.auth("user_a"), json={"greeting_mode": "custom"})
        assert r.status_code == 422
        assert r.json()["detail"] == ("Upload or choose a greeting before switching to a "
                                      "custom greeting.")
        # Upload a greeting (not activated) to each mailbox.
        g = await upload_greeting(h, box["id"], activate=False)
        g_other = await upload_greeting(h, other["id"], activate=False)
        # mode + active id together in ONE request.
        r = await c.patch(url, headers=h.auth("user_a"),
                          json={"greeting_mode": "custom", "active_greeting_id": g["id"]})
        assert r.status_code == 200, r.text
        assert r.json()["greeting_mode"] == "custom" and r.json()["active_greeting_id"] == g["id"]
        # Another mailbox's greeting -> 422 (also not stored / unknown).
        for gid in (g_other["id"], 999999):
            r = await c.patch(url, headers=h.auth("user_a"),
                              json={"greeting_mode": "custom", "active_greeting_id": gid})
            assert r.status_code == 422, r.text
            assert r.json()["detail"] == "That greeting can't be used for this mailbox."
        # standard alone.
        r = await c.patch(url, headers=h.auth("user_a"), json={"greeting_mode": "standard"})
        assert r.status_code == 200 and r.json()["greeting_mode"] == "standard"
        assert r.json()["active_greeting_id"] == g["id"]  # kept for a one-click switch back
        # Admin suspend/resume; FS lookup follows.
        r = await c.patch(url, headers=h.auth("admin"), json={"status": "suspended"})
        assert r.status_code == 200 and r.json()["status"] == "suspended"
        r = await fs_lookup(h, box["id"])
        assert r.json()["accepting"] is False and r.json()["reason"] == "inactive"
        r = await c.patch(url, headers=h.auth("admin"), json={"status": "active"})
        assert r.json()["status"] == "active"
        r = await c.patch(url, headers=h.auth("admin"), json={"status": "deleted"})
        assert r.status_code == 422
        # Bad label / timezone are sentences.
        r = await c.patch(url, headers=h.auth("user_a"), json={"timezone": "Nowhere/X"})
        assert r.status_code == 422 and r.json()["detail"] == "Choose a valid time zone."
        # Empty body = no-op 200.
        r = await c.patch(url, headers=h.auth("user_a"), json={})
        assert r.status_code == 200
        audits = await h.fetchval(
            "SELECT count(*) FROM voicemail_access_log WHERE mailbox_id = $1 "
            "AND action = 'mailbox_update'", box["id"])
        assert audits >= 4

    run(h, go())


def test_pin(h):
    async def go():
        box = await h.create_mailbox(CUST_A, new_did())
        url = f"/v1/voicemail/mailboxes/{box['id']}/pin"
        r = await h.client.put(url, headers=h.auth("user_a"), json={"pin": "246810"})
        assert r.status_code == 204, r.text
        r = await h.client.get(f"/v1/voicemail/mailboxes/{box['id']}", headers=h.auth("user_a"))
        assert r.json()["has_pin"] is True
        for bad in ("12a4", "123", "12345678901", 1234, None):
            r = await h.client.put(url, headers=h.auth("user_a"), json={"pin": bad})
            assert r.status_code == 422 and r.json()["detail"] == "PIN must be 4 to 10 digits."
        r = await h.client.put(url, headers=h.auth("ro_a"), json={"pin": "1234"})
        assert r.status_code == 403
        assert await h.fetchval(
            "SELECT count(*) FROM voicemail_access_log WHERE mailbox_id = $1 "
            "AND action = 'pin_set'", box["id"]) == 1
        stored = await h.fetchval("SELECT pin_hash FROM voicemail_boxes WHERE id = $1",
                                  box["id"])
        assert stored.startswith("$2") and "246810" not in stored

    run(h, go())


# ===========================================================================
# Messages
# ===========================================================================
def test_message_folders_trash_restore_purge(h):
    async def go():
        c = h.client
        box = await h.create_mailbox(CUST_A, new_did())
        ids = []
        for i in range(3):
            ids.append(await h.deposit_ok(box["id"], caller_id_name=f"Caller {i}"))
            await asyncio.sleep(0.01)
        base = f"/v1/voicemail/mailboxes/{box['id']}/messages"
        r = await c.get(base, headers=h.auth("user_a"))
        assert r.status_code == 200, r.text
        page = r.json()
        assert [m["id"] for m in page["items"]] == list(reversed(ids))  # newest first
        assert page["total"] == 3 and page["unread"] == 3
        assert set(page["items"][0]) == MESSAGE_KEYS
        r = await c.get(base + "?limit=1&offset=1", headers=h.auth("user_a"))
        assert [m["id"] for m in r.json()["items"]] == [ids[1]] and r.json()["total"] == 3
        r = await c.get(base + "?folder=junk", headers=h.auth("user_a"))
        assert r.status_code == 422 and r.json()["detail"] == "Folder must be inbox, saved or trash."

        m0 = f"/v1/voicemail/messages/{ids[0]}"
        r = await c.patch(m0, headers=h.auth("user_a"), json={"is_saved": True, "is_read": True})
        assert r.status_code == 200 and r.json()["is_saved"] is True and r.json()["is_read"]
        assert set(r.json()) == MESSAGE_KEYS
        r = await c.get(base + "?folder=saved", headers=h.auth("user_a"))
        assert [m["id"] for m in r.json()["items"]] == [ids[0]] and r.json()["unread"] == 0
        r = await c.get(base, headers=h.auth("user_a"))
        assert r.json()["total"] == 2

        # Trash keeps is_saved; restore only clears deleted_at.
        r = await c.delete(m0, headers=h.auth("user_a"))
        assert r.status_code == 200 and r.json()["deleted_at"] is not None
        r = await c.get(base + "?folder=trash", headers=h.auth("user_a"))
        assert [m["id"] for m in r.json()["items"]] == [ids[0]]
        r = await c.get(base + "?folder=saved", headers=h.auth("user_a"))
        assert r.json()["total"] == 0
        r = await c.post(m0 + "/restore", headers=h.auth("user_a"))
        assert r.status_code == 200 and r.json()["deleted_at"] is None
        assert r.json()["is_saved"] is True
        r = await c.get(base + "?folder=saved", headers=h.auth("user_a"))
        assert [m["id"] for m in r.json()["items"]] == [ids[0]]

        # Mailbox counts: message_count excludes trash, bytes_used includes it.
        await c.delete(f"/v1/voicemail/messages/{ids[1]}", headers=h.auth("user_a"))
        r = await c.get(f"/v1/voicemail/mailboxes/{box['id']}", headers=h.auth("user_a"))
        mb = r.json()
        assert mb["message_count"] == 2
        sizes = await h.fetchval("SELECT sum(size_bytes) FROM voicemail_messages "
                                 "WHERE mailbox_id = $1 AND status = 'stored'", box["id"])
        assert mb["bytes_used"] == sizes

        # Readonly: reads OK, every mutation 403. Customer B: 404 everywhere.
        r = await c.get(base, headers=h.auth("ro_a"))
        assert r.status_code == 200
        for method, path, kw in (("PATCH", m0, {"json": {"is_read": False}}),
                                 ("DELETE", m0, {}), ("POST", m0 + "/restore", {}),
                                 ("DELETE", m0 + "/purge", {})):
            r = await c.request(method, path, headers=h.auth("ro_a"), **kw)
            assert r.status_code == 403, (method, path)
            r = await c.request(method, path, headers=h.auth("user_b"), **kw)
            assert r.status_code == 404, (method, path, r.text)
        r = await c.post(m0 + "/playback-token", headers=h.auth("user_b"), json={})
        assert r.status_code == 404

        # Purge: object gone, row purged with crypto fields nulled, 404 after.
        row = (await h.fetch("SELECT * FROM voicemail_messages WHERE id = $1", ids[2]))[0]
        assert row["object_key"] in memory_store().keys()
        r = await c.delete(f"/v1/voicemail/messages/{ids[2]}/purge", headers=h.auth("user_a"))
        assert r.status_code == 204
        row = (await h.fetch("SELECT * FROM voicemail_messages WHERE id = $1", ids[2]))[0]
        assert row["status"] == "purged" and row["purged_at"] is not None
        for col in ("object_key", "ciphertext_crc32c", "wrapped_dek", "kek_version", "iv"):
            assert row[col] is None, col
        assert not any(str(row["msg_uuid"]) in k for k in memory_store().keys())
        r = await c.get(f"/v1/voicemail/messages/{ids[2]}", headers=h.auth("user_a"))
        assert r.status_code in (404, 405)
        r = await c.patch(f"/v1/voicemail/messages/{ids[2]}", headers=h.auth("user_a"),
                          json={"is_read": True})
        assert r.status_code == 404
        assert await h.fetchval("SELECT count(*) FROM voicemail_access_log WHERE message_id = $1 "
                                "AND action = 'message_purge'", ids[2]) == 1

    run(h, go())


# ===========================================================================
# Playback
# ===========================================================================
async def mint(h, message_id, who="user_a", **body):
    r = await h.client.post(f"/v1/voicemail/messages/{message_id}/playback-token",
                            headers=h.auth(who), json=body)
    assert r.status_code == 200, r.text
    return r.json()


def test_playback_token_range_head_and_audit_once(h):
    async def go():
        c = h.client
        box = await h.create_mailbox(CUST_A, new_did(), timezone="America/Chicago")
        wav = make_wav(3.0)
        r = await h.deposit(h.meta(box["id"], caller_id_number="+1 (508) 555-1212"), body=wav)
        mid = r.json()["message_id"]
        assert await h.fetchval("SELECT is_read FROM voicemail_messages WHERE id = $1", mid) is False

        tok = await mint(h, mid, "ro_a")  # readonly may play
        assert tok["expires_in"] == 120
        assert re.fullmatch(rf"/api/v1/voicemail/messages/{mid}/audio\?t=[A-Za-z0-9._-]+",
                            tok["url"])
        assert await h.fetchval("SELECT is_read FROM voicemail_messages WHERE id = $1", mid)
        url = path_of(tok["url"])

        r = await c.get(url)
        assert r.status_code == 200, r.text
        assert r.content == wav
        assert r.headers["content-type"] == "audio/wav"
        assert r.headers["accept-ranges"] == "bytes"
        assert r.headers["cache-control"] == "no-store"
        assert r.headers["content-disposition"] == "inline"
        size = len(wav)
        r = await c.get(url, headers={"Range": "bytes=0-99"})
        assert r.status_code == 206 and r.content == wav[:100]
        assert r.headers["content-range"] == f"bytes 0-99/{size}"
        r = await c.get(url, headers={"Range": "bytes=100-"})
        assert r.status_code == 206 and r.content == wav[100:]
        r = await c.get(url, headers={"Range": "bytes=-10"})
        assert r.status_code == 206 and r.content == wav[-10:]
        r = await c.get(url, headers={"Range": f"bytes={size - 5}-{size + 100}"})
        assert r.status_code == 206 and r.content == wav[-5:]
        r = await c.get(url, headers={"Range": f"bytes={size}-"})
        assert r.status_code == 416 and r.headers["content-range"] == f"bytes */{size}"
        r = await c.get(url, headers={"Range": "bytes=-0"})
        assert r.status_code == 416
        r = await c.get(url, headers={"Range": "bytes=0-1,5-6"})  # multi-range ignored
        assert r.status_code == 200 and r.content == wav
        r = await c.head(url)
        assert r.status_code == 200 and r.content == b""
        assert r.headers["content-length"] == str(size)
        r = await c.head(url, headers={"Range": "bytes=0-9"})
        assert r.status_code == 206 and r.headers["content-length"] == "10"

        # Simulate other worker processes: an empty per-process cache must
        # NOT add audit rows for the same token (cross-process unique index).
        from services.voicemail import audio
        for _ in range(3):
            audio.PLAYBACK_CACHE.clear()
            r = await c.get(url, headers={"Range": "bytes=0-9"})
            assert r.status_code == 206
        plays = await h.fetch("SELECT * FROM voicemail_access_log WHERE message_id = $1 "
                              "AND action IN ('play', 'download')", mid)
        assert len(plays) == 1, plays
        assert plays[0]["action"] == "play" and plays[0]["actor_user_id"] == 51
        assert plays[0]["customer_id"] == CUST_A and plays[0]["source"] == "ui"

        # A second mint (UI re-mints during long playback) = a second row;
        # minting an already-read message is idempotent.
        tok2 = await mint(h, mid)
        assert tok2["url"] != tok["url"]
        r = await c.get(path_of(tok2["url"]), headers={"Range": "bytes=0-1"})
        assert r.status_code == 206
        assert await h.fetchval("SELECT count(*) FROM voicemail_access_log WHERE message_id = $1 "
                                "AND action = 'play'", mid) == 2
        # Body optional / {}.
        r = await c.post(f"/v1/voicemail/messages/{mid}/playback-token", headers=h.auth("user_a"))
        assert r.status_code == 200, r.text

        # Download token -> attachment with a safe name in the mailbox tz.
        dl = await mint(h, mid, download=True)
        r = await c.get(path_of(dl["url"]))
        assert r.status_code == 200
        cd = r.headers["content-disposition"]
        assert re.fullmatch(r'attachment; filename="voicemail-\d{8}-\d{6}-\+15085551212\.wav"', cd)
        assert await h.fetchval("SELECT count(*) FROM voicemail_access_log WHERE message_id = $1 "
                                "AND action = 'download'", mid) == 1

        # Token checks: no/bad token, other object, other kind, expired.
        r = await c.get(f"/v1/voicemail/messages/{mid}/audio")
        assert r.status_code == 401
        r = await c.get(f"/v1/voicemail/messages/{mid}/audio?t=garbage")
        assert r.status_code == 401
        other = await h.deposit_ok(box["id"])
        r = await c.get(f"/v1/voicemail/messages/{other}/audio?t=" + url.split("?t=")[1])
        assert r.status_code == 401
        r = await c.get(f"/v1/voicemail/greetings/{mid}/audio?t=" + url.split("?t=")[1])
        assert r.status_code == 401
        from jose import jwt as jose_jwt
        from voicemail_api_harness import PLAYBACK_SECRET
        now = int(time.time())
        expired = jose_jwt.encode(
            {"aud": "vm-playback", "typ": "vm-playback", "k": "message", "oid": mid,
             "cid": CUST_A, "sub": "50", "dl": False, "jti": "x" * 20, "iat": now - 300,
             "exp": now - 180}, PLAYBACK_SECRET, algorithm="HS256")
        r = await c.get(f"/v1/voicemail/messages/{mid}/audio?t={expired}")
        assert r.status_code == 401
        # A token for the right object but another customer (forged cid) -> 404.
        forged = jose_jwt.encode(
            {"aud": "vm-playback", "typ": "vm-playback", "k": "message", "oid": mid,
             "cid": CUST_B, "sub": "52", "dl": False, "jti": "y" * 20, "iat": now,
             "exp": now + 60}, PLAYBACK_SECRET, algorithm="HS256")
        r = await c.get(f"/v1/voicemail/messages/{mid}/audio?t={forged}")
        assert r.status_code == 404

        # The playback token is useless as a Bearer.
        token = url.split("?t=")[1]
        r = await c.get("/v1/voicemail/mailboxes", headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 401
        # The audio route is not a JWT route for anything but GET/HEAD.
        r = await c.post(url)
        assert r.status_code == 401

        # Legacy mount serves the same token.
        r = await c.get("/voicemail" + url[len("/v1/voicemail"):], headers={"Range": "bytes=0-3"})
        assert r.status_code == 206

    run(h, go())


def test_playback_audit_failure_is_fail_closed(h, monkeypatch):
    async def go():
        box = await h.create_mailbox(CUST_A, new_did())
        mid = await h.deposit_ok(box["id"])
        tok = await mint(h, mid)
        from services.voicemail import audio, audit

        async def boom(*a, **k):
            raise OSError("audit table unavailable")

        monkeypatch.setattr(audit, "write_audit_once_per_token", boom)
        r = await h.client.get(path_of(tok["url"]))
        assert r.status_code == 503 and r.content.find(b"RIFF") == -1
        assert len(audio.PLAYBACK_CACHE) == 0  # nothing cached without its audit
        monkeypatch.undo()
        r = await h.client.get(path_of(tok["url"]))
        assert r.status_code == 200 and r.content.startswith(b"RIFF")

    run(h, go())


def test_playback_integrity_failure_is_500_never_served(h):
    async def go():
        box = await h.create_mailbox(CUST_A, new_did())
        mid = await h.deposit_ok(box["id"])
        key = await h.fetchval("SELECT object_key FROM voicemail_messages WHERE id = $1", mid)
        store = memory_store()
        store.replace_raw(key, b"\x00" * len(store.raw(key)), keep_stored_crc=False)
        tok = await mint(h, mid)
        r = await h.client.get(path_of(tok["url"]))
        assert r.status_code == 500 and b"RIFF" not in r.content
        assert await h.fetchval("SELECT count(*) FROM voicemail_access_log WHERE message_id = $1 "
                                "AND action = 'play'", mid) == 0

    run(h, go())


def test_playback_secret_unset_is_503(h, monkeypatch):
    async def go():
        box = await h.create_mailbox(CUST_A, new_did())
        mid = await h.deposit_ok(box["id"])
        monkeypatch.delenv("VOICEMAIL_PLAYBACK_SECRET")
        r = await h.client.post(f"/v1/voicemail/messages/{mid}/playback-token",
                                headers=h.auth("user_a"), json={})
        assert r.status_code == 503
        r = await h.client.get(f"/v1/voicemail/messages/{mid}/audio?t=abc")
        assert r.status_code == 503

    run(h, go())


# ===========================================================================
# Greetings
# ===========================================================================
async def upload_greeting(h, mailbox_id, *, activate=True, label="Hello", body=None,
                          who="user_a", content_type="audio/wav"):
    r = await h.client.post(
        f"/v1/voicemail/mailboxes/{mailbox_id}/greetings",
        params={"label": label, "activate": str(activate).lower()},
        headers={**h.auth(who), "Content-Type": content_type},
        content=make_wav(2.0, 16000) if body is None else body)
    assert r.status_code == 201, r.text
    return r.json()


async def fs_lookup(h, mailbox_id, secret=INGEST_SECRET):
    headers = {"X-Ingest-Secret": secret} if secret is not None else {}
    return await h.client.get(f"/v1/voicemail/fs/mailbox/{mailbox_id}", headers=headers)


def test_greeting_upload_activate_fetch_delete(h):
    async def go():
        c = h.client
        box = await h.create_mailbox(CUST_A, new_did())
        wav16 = make_wav(2.0, 16000)
        g = await upload_greeting(h, box["id"], body=wav16, label="Main")
        assert set(g) == GREETING_KEYS
        assert g["is_active"] is True and g["label"] == "Main" and g["duration_ms"] == 2000
        assert g["size_bytes"] == len(wav16)
        r = await c.get(f"/v1/voicemail/mailboxes/{box['id']}", headers=h.auth("user_a"))
        assert r.json()["greeting_mode"] == "custom" and r.json()["active_greeting_id"] == g["id"]
        r = await c.get(f"/v1/voicemail/mailboxes/{box['id']}/greetings", headers=h.auth("ro_a"))
        assert [x["id"] for x in r.json()] == [g["id"]]

        # FS lookup advertises it; FS fetch returns the plaintext + audits.
        r = await fs_lookup(h, box["id"])
        assert r.status_code == 200, r.text
        assert r.json()["greeting"] == {"greeting_id": g["id"], "duration_ms": 2000}
        for _ in range(2):
            r = await c.get(f"/v1/voicemail/fs/greetings/{g['id']}/audio",
                            headers={"X-Ingest-Secret": INGEST_SECRET})
            assert r.status_code == 200 and r.content == wav16
            assert r.headers["cache-control"] == "no-store"
        assert await h.fetchval("SELECT count(*) FROM voicemail_access_log WHERE greeting_id = $1 "
                                "AND action = 'greeting_fs_fetch'", g["id"]) == 2
        r = await c.get(f"/v1/voicemail/fs/greetings/{g['id']}/audio")
        assert r.status_code == 401

        # Playback token for greetings (body {} or none).
        r = await c.post(f"/v1/voicemail/greetings/{g['id']}/playback-token",
                         headers=h.auth("ro_a"), json={})
        assert r.status_code == 200, r.text
        url = r.json()["url"]
        assert url.startswith(f"/api/v1/voicemail/greetings/{g['id']}/audio?t=")
        r = await c.get(path_of(url), headers={"Range": "bytes=0-43"})
        assert r.status_code == 206 and r.content == wav16[:44]
        assert await h.fetchval("SELECT count(*) FROM voicemail_access_log WHERE greeting_id = $1 "
                                "AND action = 'greeting_play'", g["id"]) == 1
        r = await c.post(f"/v1/voicemail/greetings/{g['id']}/playback-token",
                         headers=h.auth("user_b"))
        assert r.status_code == 404

        # Readonly / other tenant cannot upload or delete.
        r = await c.post(f"/v1/voicemail/mailboxes/{box['id']}/greetings",
                         headers={**h.auth("ro_a"), "Content-Type": "audio/wav"}, content=wav16)
        assert r.status_code == 403
        r = await c.post(f"/v1/voicemail/mailboxes/{box['id']}/greetings",
                         headers={**h.auth("user_b"), "Content-Type": "audio/wav"}, content=wav16)
        assert r.status_code == 404
        r = await c.delete(f"/v1/voicemail/greetings/{g['id']}", headers=h.auth("user_b"))
        assert r.status_code == 404

        # Delete the active greeting -> standard mode, object gone, 404 after.
        gkey = await h.fetchval("SELECT object_key FROM voicemail_greetings WHERE id = $1", g["id"])
        r = await c.delete(f"/v1/voicemail/greetings/{g['id']}", headers=h.auth("user_a"))
        assert r.status_code == 204
        r = await c.get(f"/v1/voicemail/mailboxes/{box['id']}", headers=h.auth("user_a"))
        assert r.json()["greeting_mode"] == "standard" and r.json()["active_greeting_id"] is None
        assert gkey not in memory_store().keys()
        assert await h.fetchval("SELECT status FROM voicemail_greetings WHERE id = $1",
                                g["id"]) == "purged"
        r = await fs_lookup(h, box["id"])
        assert r.json()["greeting"] is None
        r = await c.get(f"/v1/voicemail/fs/greetings/{g['id']}/audio",
                        headers={"X-Ingest-Secret": INGEST_SECRET})
        assert r.status_code == 404
        r = await c.get(path_of(url))  # token still unexpired, but the greeting is gone
        assert r.status_code == 404

    run(h, go())


def test_greeting_wav_validation(h):
    async def go():
        c = h.client
        box = await h.create_mailbox(CUST_A, new_did())
        url = f"/v1/voicemail/mailboxes/{box['id']}/greetings"
        fmt_msg = "Greeting must be a mono 8 or 16 kHz 16-bit PCM WAV."
        cases = [
            (b"ID3" + b"\x00" * 100, "audio/wav", 415, "Greeting must be a WAV file."),
            (make_wav(1.0), "audio/mpeg", 415, "Greeting must be a WAV file."),
            (wav_with_fmt(channels=2), "audio/wav", 422, fmt_msg),
            (wav_with_fmt(rate=44100, pcm=pcm_tone(0.5, 44100)), "audio/wav", 422, fmt_msg),
            (wav_with_fmt(bits=8), "audio/wav", 422, fmt_msg),
            (wav_with_fmt(fmt_tag=3), "audio/wav", 422, fmt_msg),
            (wav_with_fmt(data_first=True), "audio/wav", 422,
             "Greeting is not a valid WAV file."),
            (wav_with_fmt(data_len=10**6), "audio/wav", 422,
             "Greeting is incomplete or damaged."),
            (b"RIFF\x24\x00\x00\x00WAVE", "audio/wav", 422, "Greeting has no audio data."),
            (wav_with_fmt(pcm=b""), "audio/wav", 422, "Greeting is incomplete or damaged."),
            (make_wav(121.0, 8000), "audio/wav", 422, "Greeting must be 2 minutes or shorter."),
        ]
        for body, ctype, status, detail in cases:
            r = await c.post(url, headers={**h.auth("user_a"), "Content-Type": ctype},
                             content=body)
            assert r.status_code == status, (detail, r.text)
            assert r.json()["detail"] == detail
        # Over 5 MB -> 413 from Content-Length, before reading.
        r = await c.post(url, headers={**h.auth("user_a"), "Content-Type": "audio/wav"},
                         content=b"\x00" * (5 * 1024 * 1024 + 1))
        assert r.status_code == 413 and r.json()["detail"] == "Greeting must be 5 MB or smaller."
        # Extra chunks (LIST) before fmt/data are tolerated; 8 kHz OK.
        lst = b"LIST" + struct.pack("<I", 5) + b"INFOx" + b"\x00"  # odd size + pad byte
        g = await upload_greeting(h, box["id"], body=wav_with_fmt(extra_chunks=lst),
                                  activate=False)
        assert g["duration_ms"] == 1000 and g["is_active"] is False
        # Exactly 120 s is allowed.
        g2 = await upload_greeting(h, box["id"], body=make_wav(120.0, 8000), activate=False)
        assert g2["duration_ms"] == 120000
        # Nothing failed was left 'stored'; no stray pending rows.
        assert await h.fetchval("SELECT count(*) FROM voicemail_greetings WHERE mailbox_id = $1 "
                                "AND status <> 'stored'", box["id"]) == 0

    run(h, go())


# ===========================================================================
# FS mailbox lookup
# ===========================================================================
def test_fs_mailbox_lookup(h, monkeypatch):
    async def go():
        box = await h.create_mailbox(CUST_A, new_did())
        r = await fs_lookup(h, box["id"])
        assert r.status_code == 200, r.text
        assert r.json() == {"mailbox_id": box["id"], "customer_id": CUST_A, "did": box["did"],
                            "status": "active", "accepting": True, "reason": None,
                            "max_message_seconds": 300, "greeting": None}
        assert (await fs_lookup(h, box["id"], secret=None)).status_code == 401
        assert (await fs_lookup(h, box["id"], secret="wrong" * 10)).status_code == 401
        assert (await fs_lookup(h, 999999)).status_code == 404
        # Full: max_messages reached.
        await h.execute("UPDATE voicemail_boxes SET max_messages = 1 WHERE id = $1", box["id"])
        await h.deposit_ok(box["id"])
        r = await fs_lookup(h, box["id"])
        assert r.json()["accepting"] is False and r.json()["reason"] == "full"
        # Full by bytes.
        await h.execute("UPDATE voicemail_boxes SET max_messages = 100, max_bytes = 10 "
                        "WHERE id = $1", box["id"])
        assert (await fs_lookup(h, box["id"])).json()["reason"] == "full"
        await h.execute("UPDATE voicemail_boxes SET max_bytes = 524288000 WHERE id = $1",
                        box["id"])
        assert (await fs_lookup(h, box["id"])).json()["accepting"] is True
        # Inactive: entitlement off (wins over full).
        await h.execute("UPDATE customers SET voicemail_enabled = false WHERE id = $1", CUST_A)
        try:
            r = await fs_lookup(h, box["id"])
            assert r.json()["accepting"] is False and r.json()["reason"] == "inactive"
        finally:
            await h.execute("UPDATE customers SET voicemail_enabled = true WHERE id = $1", CUST_A)
        # Secret unset -> 503 (fail closed).
        monkeypatch.delenv("INGEST_SHARED_SECRET")
        assert (await fs_lookup(h, box["id"])).status_code == 503

    run(h, go())


# ===========================================================================
# Mailbox delete / crypto-erase / available numbers
# ===========================================================================
def test_delete_mailbox_purges_and_frees_did(h):
    async def go():
        c = h.client
        box = await h.create_mailbox(CUST_A, new_did())
        mids = [await h.deposit_ok(box["id"]) for _ in range(2)]
        g = await upload_greeting(h, box["id"])
        store = memory_store()
        keys = [r["object_key"] for r in await h.fetch(
            "SELECT object_key FROM voicemail_messages WHERE mailbox_id = $1 UNION ALL "
            "SELECT object_key FROM voicemail_greetings WHERE mailbox_id = $1", box["id"])]
        assert all(k in store.keys() for k in keys) and len(keys) == 3

        for who in ("user_a", "ro_a", "support"):
            r = await c.delete(f"/v1/voicemail/mailboxes/{box['id']}", headers=h.auth(who))
            assert r.status_code == 403
        r = await c.delete(f"/v1/voicemail/mailboxes/{box['id']}", headers=h.auth("admin"))
        assert r.status_code == 204, r.text
        assert await h.fetchval("SELECT status FROM voicemail_boxes WHERE id = $1",
                                box["id"]) == "deleted"
        inv = (await h.fetch("SELECT * FROM did_inventory WHERE did = $1", box["did"]))[0]
        assert inv["status"] == "available" and inv["customer_id"] is None
        assert inv["product_type"] is None and inv["product_ref_id"] is None
        assert await h.fetchval("SELECT count(*) FROM number_routing WHERE did = $1",
                                box["did"]) == 0
        assert not any(k in store.keys() for k in keys)
        assert await h.fetchval("SELECT count(*) FROM voicemail_messages WHERE mailbox_id = $1 "
                                "AND status <> 'purged'", box["id"]) == 0
        assert await h.fetchval("SELECT status FROM voicemail_greetings WHERE id = $1",
                                g["id"]) == "purged"
        # Deleting a mailbox does NOT turn voicemail off for the customer.
        assert await h.fetchval("SELECT voicemail_enabled FROM customers WHERE id = $1", CUST_A)
        assert (await fs_lookup(h, box["id"])).status_code == 404
        r = await c.delete(f"/v1/voicemail/mailboxes/{box['id']}", headers=h.auth("admin"))
        assert r.status_code == 404
        r = await c.post(f"/v1/voicemail/messages/{mids[0]}/playback-token",
                         headers=h.auth("admin"), json={})
        assert r.status_code == 404
        # The DID is reusable for a new mailbox.
        r = await c.post("/v1/voicemail/mailboxes", headers=h.auth("admin"),
                         json={"customer_id": CUST_A, "did": box["did"]})
        assert r.status_code == 201
        assert await h.fetchval("SELECT count(*) FROM voicemail_access_log WHERE mailbox_id = $1 "
                                "AND action = 'mailbox_delete'", box["id"]) == 1

    run(h, go())


def test_crypto_erase_end_to_end(h):
    async def go():
        c = h.client
        await h.execute("INSERT INTO customers (id, name, account_type) VALUES "
                        "(130, 'Erase Me', 'rcf')")
        b1 = await h.create_mailbox(130, new_did())
        b2 = await h.create_mailbox(130, new_did())
        m1 = await h.deposit_ok(b1["id"])
        await h.deposit_ok(b2["id"])
        await upload_greeting(h, b1["id"], who="admin")
        keys = [r["object_key"] for r in await h.fetch(
            "SELECT object_key FROM voicemail_messages WHERE customer_id = 130 UNION ALL "
            "SELECT object_key FROM voicemail_greetings WHERE customer_id = 130")]
        assert len(keys) == 3

        url = "/v1/voicemail/customers/130/crypto-erase"
        r = await c.post(url, headers=h.auth("user_a"), json={"confirm": "ERASE 130"})
        assert r.status_code == 403
        for bad in ("ERASE 131", "erase 130", "", None):
            r = await c.post(url, headers=h.auth("admin"), json={"confirm": bad})
            assert r.status_code == 422 and r.json()["detail"] == "Type ERASE 130 to confirm."
        r = await c.post("/v1/voicemail/customers/987654/crypto-erase", headers=h.auth("admin"),
                         json={"confirm": "ERASE 987654"})
        assert r.status_code == 404

        r = await c.post(url, headers=h.auth("admin"), json={"confirm": "ERASE 130"})
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["mailboxes"] == 2 and out["messages"] == 2 and out["greetings"] == 1
        assert out["deferred"] == 0 and out["key_status"] == "destroyed"
        assert await h.fetchval("SELECT status FROM voicemail_customer_keys "
                                "WHERE customer_id = 130") == "destroyed"
        assert await h.fetchval("SELECT voicemail_enabled FROM customers WHERE id = 130") is False
        assert await h.fetchval("SELECT count(*) FROM voicemail_boxes WHERE customer_id = 130 "
                                "AND status <> 'deleted'") == 0
        for b in (b1, b2):
            assert await h.fetchval("SELECT status FROM did_inventory WHERE did = $1",
                                    b["did"]) == "available"
        assert await h.fetchval("SELECT count(*) FROM voicemail_messages WHERE customer_id = 130 "
                                "AND (status <> 'purged' OR wrapped_dek IS NOT NULL)") == 0
        assert not any(k in memory_store().keys() for k in keys)
        assert await h.fetchval("SELECT count(*) FROM voicemail_access_log WHERE customer_id = 130 "
                                "AND action = 'crypto_erase'") == 1
        # Idempotent re-run.
        r = await c.post(url, headers=h.auth("admin"), json={"confirm": "ERASE 130"})
        assert r.status_code == 200 and r.json()["mailboxes"] == 0
        # Gone for FS, the UI and playback; never re-enabled.
        assert (await fs_lookup(h, b1["id"])).status_code == 404
        r = await h.deposit(h.meta(b1["id"]))
        assert r.status_code == 404
        r = await c.post(f"/v1/voicemail/messages/{m1}/playback-token", headers=h.auth("admin"))
        assert r.status_code == 404
        did = new_did()
        await h.add_did(did)
        r = await c.post("/v1/voicemail/mailboxes", headers=h.auth("admin"),
                         json={"customer_id": 130, "did": did})
        assert r.status_code == 409
        assert r.json()["detail"].startswith("Voicemail for this customer was permanently erased")
        assert await h.fetchval("SELECT status FROM did_inventory WHERE did = $1", did) == \
            "available"

    run(h, go())


def test_available_numbers(h):
    async def go():
        c = h.client
        await h.add_did("+17815550101", city="Lynn")
        await h.add_did("+17815550102", status="assigned")
        await h.add_did("+17815550103")
        await h.execute("INSERT INTO rcf_numbers (did, customer_id, forward_to) "
                        "VALUES ('+17815550103', $1, '+17745550000')", CUST_B)
        r = await c.get("/v1/voicemail/available-numbers?q=(781) 555-01", headers=h.auth("admin"))
        assert r.status_code == 200, r.text
        dids = [x["did"] for x in r.json()]
        assert "+17815550101" in dids
        assert "+17815550102" not in dids and "+17815550103" not in dids
        assert set(r.json()[0]) == {"did", "city", "state"}
        r = await c.get("/v1/voicemail/available-numbers?limit=1", headers=h.auth("admin"))
        assert len(r.json()) == 1
        r = await c.get("/v1/voicemail/available-numbers?limit=51", headers=h.auth("admin"))
        assert r.status_code == 422
        r = await c.get("/v1/voicemail/available-numbers", headers=h.auth("user_a"))
        assert r.status_code == 403

    run(h, go())


# ===========================================================================
# number_inventory voicemail arms + customer delete
# ===========================================================================
def test_number_inventory_voicemail_arms(h):
    async def go():
        c = h.client
        did = new_did()
        await h.add_did(did)
        r = await c.post(f"/v1/numbers/{did}/assign", headers=h.auth("admin"),
                         json={"customer_id": CUST_B, "product_type": "voicemail",
                               "label": "Beta VM"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["product_type"] == "voicemail" and body["status"] == "assigned"
        box_id = body["product_ref_id"]
        box = (await h.fetch("SELECT * FROM voicemail_boxes WHERE id = $1", box_id))[0]
        assert box["did"] == did and box["label"] == "Beta VM" and box["customer_id"] == CUST_B
        assert await h.fetchval("SELECT voicemail_enabled FROM customers WHERE id = $1", CUST_B)
        inv = (await h.fetch("SELECT * FROM did_inventory WHERE did = $1", did))[0]
        assert inv["product_ref_id"] == box_id and inv["product_type"] == "voicemail"

        # /my (tenant) lists it; reconcile counts it and keeps it intact.
        r = await c.get("/v1/numbers/my", headers=h.auth("user_b"))
        assert {"did": did, "product_type": "voicemail"}.items() <= next(
            x for x in r.json() if x["did"] == did).items()
        # Drift: drop the inventory row -> /my still shows it (voicemail arm),
        # reconcile restores it.
        await h.execute("DELETE FROM did_inventory WHERE did = $1", did)
        r = await c.get("/v1/numbers/my", headers=h.auth("user_b"))
        assert any(x["did"] == did and x["product_type"] == "voicemail" for x in r.json())
        r = await c.get("/v1/numbers/my", headers=h.auth("admin"))
        assert any(x["did"] == did and x["product_type"] == "voicemail" for x in r.json())
        r = await c.post("/v1/numbers/reconcile", headers=h.auth("admin"))
        assert r.status_code == 200, r.text
        assert r.json()["by_product"]["voicemail"] >= 1
        inv = (await h.fetch("SELECT * FROM did_inventory WHERE did = $1", did))[0]
        assert inv["status"] == "assigned" and inv["product_ref_id"] == box_id

        # Unassign -> mailbox deleted, DID available.
        await h.deposit_ok(box_id)
        r = await c.post(f"/v1/numbers/{did}/unassign", headers=h.auth("admin"), json={})
        assert r.status_code == 200, r.text
        assert r.json()["previous_product_type"] == "voicemail"
        assert await h.fetchval("SELECT status FROM voicemail_boxes WHERE id = $1", box_id) == \
            "deleted"
        assert await h.fetchval("SELECT status FROM did_inventory WHERE did = $1", did) == \
            "available"
        assert await h.fetchval("SELECT count(*) FROM voicemail_messages WHERE mailbox_id = $1 "
                                "AND status <> 'purged'", box_id) == 0

        # Existing product paths unchanged: rcf assign + unassign still work.
        rcf_did = new_did()
        await h.add_did(rcf_did)
        r = await c.post(f"/v1/numbers/{rcf_did}/assign", headers=h.auth("admin"),
                         json={"customer_id": CUST_B, "product_type": "rcf",
                               "forward_to": "+17745550000"})
        assert r.status_code == 200 and r.json()["product_type"] == "rcf"
        r = await c.post(f"/v1/numbers/{rcf_did}/unassign", headers=h.auth("admin"), json={})
        assert r.status_code == 200
        # A customer can still not request a voicemail DID (staff-only creation).
        r = await c.post(f"/v1/numbers/{rcf_did}/request", headers=h.auth("user_b"),
                         json={"product_type": "voicemail"})
        assert r.status_code == 422
        # Bad label surfaces the voicemail sentence.
        bad = new_did()
        await h.add_did(bad)
        r = await c.post(f"/v1/numbers/{bad}/assign", headers=h.auth("admin"),
                         json={"customer_id": CUST_B, "product_type": "voicemail",
                               "label": "x" * 200})
        assert r.status_code == 422
        assert await h.fetchval("SELECT status FROM did_inventory WHERE did = $1", bad) == \
            "available"

    run(h, go())


def test_customer_delete_with_voicemail_is_409(h):
    async def go():
        c = h.client
        await h.execute("INSERT INTO customers (id, name, account_type) VALUES "
                        "(140, 'Del Me', 'rcf'), (141, 'Plain', 'rcf')")
        await h.create_mailbox(140, new_did())
        r = await c.delete("/v1/customers/140", headers=h.auth("admin"))
        assert r.status_code == 409, r.text
        assert "Erase their voicemail first" in r.json()["detail"]
        r = await c.post("/v1/voicemail/customers/140/crypto-erase", headers=h.auth("admin"),
                         json={"confirm": "ERASE 140"})
        assert r.status_code == 200
        r = await c.delete("/v1/customers/140", headers=h.auth("admin"))
        assert r.status_code == 409
        assert "can't be deleted" in r.json()["detail"]
        assert await h.fetchval("SELECT count(*) FROM customers WHERE id = 140") == 1
        # A customer without voicemail still deletes (existing behavior).
        r = await c.delete("/v1/customers/141", headers=h.auth("admin"))
        assert r.status_code == 200, r.text

    run(h, go())


def test_every_fs_route_requires_the_ingest_secret():
    """/v1/voicemail/fs/* is JWT-exempt in the middleware: every route there
    MUST carry require_ingest_secret (auth/ingest.py)."""
    from auth.ingest import require_ingest_secret
    from routers import voicemail
    fs_routes = [r for r in voicemail.router.routes if r.path.startswith("/fs/")]
    assert {r.path for r in fs_routes} == {"/fs/mailbox/{mailbox_id}",
                                           "/fs/greetings/{greeting_id}/audio", "/fs/deposit"}
    for r in fs_routes:
        assert any(d.dependency is require_ingest_secret for d in r.dependencies), r.path
    # The only token-authenticated (JWT-exempt) non-fs routes are GET/HEAD audio.
    audio = [r for r in voicemail.router.routes if r.path.endswith("/audio")
             and not r.path.startswith("/fs/")]
    assert {(r.path, frozenset(r.methods)) for r in audio} == {
        ("/messages/{message_id}/audio", frozenset({"GET", "HEAD"})),
        ("/greetings/{greeting_id}/audio", frozenset({"GET", "HEAD"}))}


def test_decrypt_concurrency_limit_is_503(h):
    async def go():
        from services.voicemail import audio
        box = await h.create_mailbox(CUST_A, new_did())
        mid = await h.deposit_ok(box["id"])
        tok = await mint(h, mid)
        audio.decrypt_limiter.limit = 0
        try:
            r = await h.client.get(path_of(tok["url"]))
            assert r.status_code == 503 and r.headers["retry-after"] == "5"
            assert await h.fetchval("SELECT count(*) FROM voicemail_access_log "
                                    "WHERE message_id = $1 AND action = 'play'", mid) == 0
        finally:
            audio.decrypt_limiter.limit = audio.DECRYPT_CONCURRENCY
        r = await h.client.get(path_of(tok["url"]))
        assert r.status_code == 200
        assert audio.decrypt_limiter.in_use == 0

    run(h, go())
