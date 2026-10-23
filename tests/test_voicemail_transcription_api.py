"""Voicemail transcription API (v1.1) — docs/VOICEMAIL_TRANSCRIPTION_PLAN.md
§10 + §13, with owner decision O2 (§0.1) overriding §10's writer rule.

Real routers behind the real JWTAuthMiddleware on an ephemeral PostgreSQL 16
built from the real init scripts + migrations 54 and 56
(tests/voicemail_api_harness.py); local KMS + in-memory object store; the
transcription platform flag is toggled per test with the FAKE provider
(available() needs a valid config). Transcripts are seeded with the REAL
``seal_transcript`` (``Harness.seed_transcript``) — no worker, no Google.

Covers (plan §14 row + O2):
  * scope — tenant cross-tenant 404, readonly 200 on GET / 403 on retry,
    support 403, voicemail-disabled customer 404 (admin still 200);
  * transcript read — shape, decrypt, ``transcript_view`` audit, audit failure
    -> 503 with no text, integrity -> 500 (tampered / moved blob / malformed
    document), KMS down -> 503 + Retry-After, erased key -> 404, decrypt slots
    busy -> 503, never marks read, ``Cache-Control: no-store``;
  * snippets — <= 50, junk ids 422, foreign ids omitted, one audit row, KMS
    down / slots busy / audit failure -> 200 ``unavailable: true``, never 5xx;
  * retry / backfill status matrix and every 409 sentence;
  * PATCH (O2: tenant writer 403 on either transcription field, admin 409 /
    422, disable flips ``pending`` only) and POST /mailboxes;
  * the Message ``transcript`` summary on list / PATCH / trash / restore, the
    list never touching KMS; ``summary.transcription_available``;
  * admin-only ops status + requeue; mailbox delete / crypto-erase / purge
    remove transcripts; admin "View as Customer" (customer_id null) end to
    end; no transcript text in any log record.

Run:  JWT_SECRET_KEY=x python -m pytest tests/test_voicemail_transcription_api.py -q
"""
import asyncio
import logging
from datetime import datetime

import pytest

from voicemail_api_harness import CUST_A, Harness

PORT = 55490  # distinct from every other test module (backend-A range 55490-55499)

TEXT = "Hi, this is Dana from Granite. Please call me back about the outage on Elm Street."
TRANSCRIPT_KEYS = {"message_id", "status", "language", "model", "confidence", "text",
                   "segments", "completed_at", "can_retry"}
STATUS_KEYS = {"available", "platform_enabled", "provider", "location", "model", "counts",
               "oldest_pending_age_s", "failed_by_code", "billed_minutes_24h",
               "daily_cap_minutes", "budget_exhausted", "config_problems"}

MSG_UNAVAILABLE = "Transcription isn't available yet."
MSG_MAILBOX_OFF = "Transcription is turned off for this mailbox."
MSG_ADMIN_SETTINGS = "Only an administrator can change transcription settings."
MSG_DAMAGED = "This transcript could not be verified and was not shown."
MSG_DOWN = "The transcript is temporarily unavailable. Try again in a few minutes."

_did_counter = iter(range(1000, 9999))


def new_did() -> str:
    return f"+1857555{next(_did_counter):04d}"


@pytest.fixture(scope="module")
def h():
    harness = Harness(PORT).start()
    try:
        yield harness
    finally:
        harness.stop()


@pytest.fixture(autouse=True)
def _fresh(h, monkeypatch):
    from services.voicemail import transcripts as vmt
    from services.voicemail.transcription import config as tx_config
    h.reset_caches()
    vmt.SLOTS.reset()
    tx_config.reset_problem_log()
    for name in ("VOICEMAIL_TRANSCRIPTION_ENABLED", "VOICEMAIL_STT_PROVIDER",
                 "VOICEMAIL_STT_DAILY_MINUTES_CAP", "GOOGLE_SDK_PYTHON_LOGGING_SCOPE",
                 "GRPC_TRACE"):
        monkeypatch.delenv(name, raising=False)
    yield
    vmt.SLOTS.reset()


@pytest.fixture
def on(monkeypatch):
    """Transcription available: platform flag on + the (dev/CI) fake provider."""
    monkeypatch.setenv("VOICEMAIL_TRANSCRIPTION_ENABLED", "true")
    monkeypatch.setenv("VOICEMAIL_STT_PROVIDER", "fake")
    from services.voicemail.transcription import config as tx_config
    assert tx_config.available()


def run(h, coro):
    return h.run(coro)


async def mailbox(h, customer_id=CUST_A, *, enabled=False, language="en-US") -> dict:
    box = await h.create_mailbox(customer_id, new_did())
    await h.execute("UPDATE voicemail_boxes SET transcription_enabled = $2, "
                    "transcription_language = $3 WHERE id = $1", box["id"], enabled, language)
    return box


async def tx_row(h, message_id):
    rows = await h.fetch("SELECT * FROM voicemail_transcripts WHERE message_id = $1", message_id)
    return rows[0] if rows else None


async def audits(h, action, **where):
    sql = "SELECT * FROM voicemail_access_log WHERE action = $1"
    args = [action]
    for col, value in where.items():
        args.append(value)
        sql += f" AND {col} = ${len(args)}"
    return await h.fetch(sql + " ORDER BY id", *args)


def tx_url(mid):
    return f"/v1/voicemail/messages/{mid}/transcript"


# ===========================================================================
# Mailbox + summary shapes
# ===========================================================================
def test_mailbox_and_summary_shapes(h, monkeypatch):
    async def go():
        c = h.client
        box = await h.create_mailbox(CUST_A, new_did())
        assert box["transcription_enabled"] is False          # O1: off by default
        assert box["transcription_language"] == "en-US"
        r = await c.get("/v1/voicemail/mailboxes", headers=h.auth("user_a"))
        mine = next(b for b in r.json() if b["id"] == box["id"])
        assert mine["transcription_enabled"] is False and mine["transcription_language"] == "en-US"

        for who, path in (("admin", "/v1/voicemail/summary"),
                          ("admin", f"/v1/voicemail/summary?customer_id={CUST_A}"),
                          ("user_a", "/v1/voicemail/summary"),
                          ("ro_a", "/v1/voicemail/summary"),
                          ("user_b", "/v1/voicemail/summary")):   # voicemail disabled
            r = await c.get(path, headers=h.auth(who))
            assert r.status_code == 200 and r.json()["transcription_available"] is False, who
        monkeypatch.setenv("VOICEMAIL_TRANSCRIPTION_ENABLED", "true")
        # Flag on but the config is unusable (no STT project) -> still false.
        r = await c.get("/v1/voicemail/summary", headers=h.auth("user_a"))
        assert r.json()["transcription_available"] is False
        monkeypatch.setenv("VOICEMAIL_STT_PROVIDER", "fake")
        for who in ("admin", "user_a", "ro_a"):
            r = await c.get("/v1/voicemail/summary", headers=h.auth(who))
            assert r.json()["transcription_available"] is True, who
        # Client debug logging could dump payloads -> unavailable (plan §12).
        monkeypatch.setenv("GRPC_TRACE", "all")
        r = await c.get("/v1/voicemail/summary", headers=h.auth("user_a"))
        assert r.json()["transcription_available"] is False

    run(h, go())


def test_create_mailbox_transcription_fields(h, monkeypatch):
    async def go():
        c = h.client
        did = new_did()
        await h.add_did(did)
        body = {"customer_id": CUST_A, "did": did, "transcription_enabled": True}
        r = await c.post("/v1/voicemail/mailboxes", headers=h.auth("admin"), json=body)
        assert r.status_code == 409 and r.json()["detail"] == MSG_UNAVAILABLE
        assert await h.fetchval("SELECT status FROM did_inventory WHERE did = $1", did) == \
            "available"
        for bad in ("en-GB", "EN-US", "en_US", 5, ""):
            r = await c.post("/v1/voicemail/mailboxes", headers=h.auth("admin"),
                             json={"customer_id": CUST_A, "did": did,
                                   "transcription_language": bad})
            assert r.status_code == 422 and r.json()["detail"] == "Choose a supported language."
        # Off + a language is fine while unavailable.
        r = await c.post("/v1/voicemail/mailboxes", headers=h.auth("admin"),
                         json={"customer_id": CUST_A, "did": did,
                               "transcription_enabled": False, "transcription_language": "fr-CA"})
        assert r.status_code == 201, r.text
        assert r.json()["transcription_enabled"] is False
        assert r.json()["transcription_language"] == "fr-CA"

        monkeypatch.setenv("VOICEMAIL_TRANSCRIPTION_ENABLED", "true")
        monkeypatch.setenv("VOICEMAIL_STT_PROVIDER", "fake")
        did2 = new_did()
        await h.add_did(did2)
        r = await c.post("/v1/voicemail/mailboxes", headers=h.auth("admin"),
                         json={"customer_id": CUST_A, "did": did2, "transcription_enabled": True,
                               "transcription_language": "es-US"})
        assert r.status_code == 201, r.text
        box = r.json()
        assert box["transcription_enabled"] is True and box["transcription_language"] == "es-US"
        detail = (await audits(h, "mailbox_create", mailbox_id=box["id"]))[0]["detail"]
        assert '"transcription_enabled": true' in detail and '"es-US"' in detail
        # Tenants still cannot create mailboxes at all.
        r = await c.post("/v1/voicemail/mailboxes", headers=h.auth("user_a"),
                         json={"customer_id": CUST_A, "did": new_did(),
                               "transcription_enabled": True})
        assert r.status_code == 403

        # The number-inventory assign path keeps the defaults.
        did3 = new_did()
        await h.add_did(did3)
        r = await c.post(f"/v1/numbers/{did3}/assign", headers=h.auth("admin"),
                         json={"customer_id": CUST_A, "product_type": "voicemail"})
        assert r.status_code == 200, r.text
        row = (await h.fetch("SELECT transcription_enabled, transcription_language "
                             "FROM voicemail_boxes WHERE id = $1",
                             r.json()["product_ref_id"]))[0]
        assert row == {"transcription_enabled": False, "transcription_language": "en-US"}

    run(h, go())


# ===========================================================================
# PATCH — owner decision O2 (admin-only switch)
# ===========================================================================
def test_patch_transcription_is_admin_only(h, monkeypatch):
    async def go():
        c = h.client
        box = await mailbox(h)
        url = f"/v1/voicemail/mailboxes/{box['id']}"
        for body in ({"transcription_enabled": True}, {"transcription_enabled": False},
                     {"transcription_language": "es-US"},
                     {"label": "Ok", "transcription_language": "en-US"}):
            r = await c.patch(url, headers=h.auth("user_a"), json=body)
            assert r.status_code == 403 and r.json()["detail"] == MSG_ADMIN_SETTINGS, body
            r = await c.patch(url, headers=h.auth("ro_a"), json=body)
            assert r.status_code == 403
        # The role rule runs before the scope lookup (it leaks nothing): another
        # tenant gets 403 on the transcription fields, 404 on anything else.
        r = await c.patch(url, headers=h.auth("user_b"), json={"transcription_enabled": True})
        assert r.status_code == 403
        r = await c.patch(url, headers=h.auth("user_b"), json={"label": "x"})
        assert r.status_code == 404
        # Nothing changed; other PATCH fields keep the writer rule; null = absent.
        r = await c.patch(url, headers=h.auth("user_a"),
                          json={"label": "Desk", "transcription_enabled": None,
                                "transcription_language": None})
        assert r.status_code == 200, r.text
        assert r.json()["label"] == "Desk" and r.json()["transcription_enabled"] is False
        assert r.json()["transcription_language"] == "en-US"

        # Admin: unavailable -> 409; bad language -> 422 (even unavailable).
        r = await c.patch(url, headers=h.auth("admin"), json={"transcription_enabled": True})
        assert r.status_code == 409 and r.json()["detail"] == MSG_UNAVAILABLE
        for bad in ("de-DE", "en-us", 7):
            r = await c.patch(url, headers=h.auth("admin"), json={"transcription_language": bad})
            assert r.status_code == 422 and r.json()["detail"] == "Choose a supported language."
        r = await c.patch(url, headers=h.auth("admin"), json={"transcription_language": "fr-CA"})
        assert r.status_code == 200 and r.json()["transcription_language"] == "fr-CA"

        monkeypatch.setenv("VOICEMAIL_TRANSCRIPTION_ENABLED", "true")
        monkeypatch.setenv("VOICEMAIL_STT_PROVIDER", "fake")
        r = await c.patch(url, headers=h.auth("admin"),
                          json={"transcription_enabled": True, "transcription_language": "es-US"})
        assert r.status_code == 200, r.text
        assert r.json()["transcription_enabled"] is True
        assert r.json()["transcription_language"] == "es-US"
        last = (await audits(h, "mailbox_update", mailbox_id=box["id"]))[-1]
        assert last["source"] == "admin"
        assert '"fields": ["transcription_enabled", "transcription_language"]' in last["detail"]
        assert '"transcription_enabled": true' in last["detail"]

        # Platform paused: re-asserting ON with a language change is allowed
        # (only an off -> on transition needs the platform).
        monkeypatch.delenv("VOICEMAIL_TRANSCRIPTION_ENABLED")
        r = await c.patch(url, headers=h.auth("admin"),
                          json={"transcription_enabled": True, "transcription_language": "en-US"})
        assert r.status_code == 200 and r.json()["transcription_language"] == "en-US"

    run(h, go())


def test_patch_disable_flips_pending_only(h, on):
    async def go():
        box = await mailbox(h, enabled=True)
        other = await mailbox(h, enabled=True)
        ids = [await h.deposit_ok(box["id"]) for _ in range(6)]
        other_id = await h.deposit_ok(other["id"])
        for mid, status in zip(ids, ("pending", "processing", "done", "failed", "empty")):
            await h.seed_transcript(mid, status, error_code="db" if status == "failed" else None)
        await h.seed_transcript(other_id, "pending")
        # ids[5] has no row yet (derived pending).
        r = await h.client.patch(f"/v1/voicemail/mailboxes/{box['id']}",
                                 headers=h.auth("admin"), json={"transcription_enabled": False})
        assert r.status_code == 200 and r.json()["transcription_enabled"] is False
        got = {mid: (await tx_row(h, mid) or {}).get("status") for mid in ids}
        assert got == {ids[0]: "disabled", ids[1]: "processing", ids[2]: "done",
                       ids[3]: "failed", ids[4]: "empty", ids[5]: None}
        assert (await tx_row(h, other_id))["status"] == "pending"
        # The message list now derives 'disabled' for the row-less message.
        r = await h.client.get(f"/v1/voicemail/mailboxes/{box['id']}/messages",
                               headers=h.auth("user_a"))
        by_id = {m["id"]: m["transcript"] for m in r.json()["items"]}
        assert by_id[ids[5]] == {"status": "disabled", "confidence": None}
        assert by_id[ids[0]]["status"] == "disabled"

    run(h, go())


# ===========================================================================
# Message shape (plan §10.1)
# ===========================================================================
def test_message_shape_carries_transcript_summary(h, monkeypatch):
    async def go():
        c = h.client
        box = await mailbox(h)
        m_none, m_done, m_failed = [await h.deposit_ok(box["id"]) for _ in range(3)]
        await h.seed_transcript(m_done, "done", text=TEXT)
        await h.seed_transcript(m_failed, "failed", error_code="stt_rejected")
        base = f"/v1/voicemail/mailboxes/{box['id']}/messages"

        # The list never decrypts: with KMS unusable it still shows statuses.
        from services.voicemail.errors import VoicemailCryptoUnavailable
        from services.voicemail.kms import LocalKmsProvider

        async def kms_down(*a, **k):
            raise VoicemailCryptoUnavailable("KMS is down")

        with monkeypatch.context() as mp:
            mp.setattr(LocalKmsProvider, "unwrap_dek", kms_down)
            r = await c.get(base, headers=h.auth("user_a"))
        assert r.status_code == 200, r.text
        by_id = {m["id"]: m["transcript"] for m in r.json()["items"]}
        assert by_id[m_done] == {"status": "done", "confidence": 0.912}
        assert by_id[m_failed] == {"status": "failed", "confidence": None}
        assert by_id[m_none] == {"status": "disabled", "confidence": None}  # mailbox off

        await h.execute("UPDATE voicemail_boxes SET transcription_enabled = true WHERE id = $1",
                        box["id"])
        r = await c.get(base, headers=h.auth("ro_a"))
        by_id = {m["id"]: m["transcript"] for m in r.json()["items"]}
        assert by_id[m_none] == {"status": "pending", "confidence": None}  # derived

        # PATCH / DELETE (trash) / restore all return the same shape.
        m = f"/v1/voicemail/messages/{m_done}"
        r = await c.patch(m, headers=h.auth("user_a"), json={"is_saved": True})
        assert r.status_code == 200 and r.json()["transcript"] == {"status": "done",
                                                                    "confidence": 0.912}
        r = await c.delete(m, headers=h.auth("user_a"))
        assert r.status_code == 200 and r.json()["transcript"]["status"] == "done"
        r = await c.get(base + "?folder=trash", headers=h.auth("user_a"))
        assert r.json()["items"][0]["transcript"]["status"] == "done"
        r = await c.post(m + "/restore", headers=h.auth("user_a"))
        assert r.status_code == 200 and r.json()["transcript"]["status"] == "done"
        r = await c.patch(f"/v1/voicemail/messages/{m_none}", headers=h.auth("user_a"),
                          json={"is_read": True})
        assert r.json()["transcript"] == {"status": "pending", "confidence": None}

    run(h, go())


def test_confidence_is_rounded_from_real(h):
    """voicemail_transcripts.confidence is REAL: 0.9 reads back as
    0.8999999761581421. Every output rounds to 3 dp (list summary + full)."""
    async def go():
        box = await mailbox(h)
        mid = await h.deposit_ok(box["id"])
        await h.seed_transcript(mid, "done", text=TEXT, confidence=0.9)
        raw = await h.fetchval("SELECT confidence FROM voicemail_transcripts "
                               "WHERE message_id = $1", mid)
        assert raw != 0.9 and abs(raw - 0.9) < 1e-6          # float4 artefact
        r = await h.client.get(f"/v1/voicemail/mailboxes/{box['id']}/messages",
                               headers=h.auth("user_a"))
        item = next(m for m in r.json()["items"] if m["id"] == mid)
        assert item["transcript"] == {"status": "done", "confidence": 0.9}
        r = await h.client.patch(f"/v1/voicemail/messages/{mid}", headers=h.auth("user_a"),
                                 json={"is_saved": True})
        assert r.json()["transcript"]["confidence"] == 0.9
        r = await h.client.get(tx_url(mid), headers=h.auth("user_a"))
        assert r.json()["confidence"] == 0.9
        assert '"confidence":0.9,' in r.text and "0.89999" not in r.text

    run(h, go())


# ===========================================================================
# GET /messages/{id}/transcript
# ===========================================================================
def test_get_transcript_done(h, on):
    async def go():
        c = h.client
        box = await mailbox(h, enabled=True)
        mid = await h.deposit_ok(box["id"])
        from services.voicemail.transcription.document import Segment
        segs = (Segment(300, 5120, "Hi, this is Dana from Granite.", 0.94),
                Segment(5120, 9870, "Please call me back about the outage on Elm Street.", None))
        await h.seed_transcript(mid, "done", text=TEXT, segments=segs)

        r = await c.get(tx_url(mid), headers=h.auth("user_a"))
        assert r.status_code == 200, r.text
        assert r.headers["cache-control"] == "no-store"
        t = r.json()
        assert set(t) == TRANSCRIPT_KEYS
        assert t["message_id"] == mid and t["status"] == "done"
        assert t["language"] == "en-US" and t["model"] == "telephony"
        assert t["confidence"] == 0.912 and t["text"] == TEXT
        assert t["segments"] == [
            {"start_ms": 300, "end_ms": 5120, "text": "Hi, this is Dana from Granite.",
             "confidence": 0.94},
            {"start_ms": 5120, "end_ms": 9870,
             "text": "Please call me back about the outage on Elm Street.", "confidence": None}]
        datetime.fromisoformat(t["completed_at"])
        assert t["can_retry"] is False          # a tenant cannot force a done transcript
        # Audited (fail-closed, before the response); reading does not mark read.
        rows = await audits(h, "transcript_view", message_id=mid)
        assert len(rows) == 1 and rows[0]["source"] == "ui" and rows[0]["actor_user_id"] == 50
        assert rows[0]["detail"] == '{"kind": "full"}' and rows[0]["mailbox_id"] == box["id"]
        assert rows[0]["customer_id"] == CUST_A
        assert await h.fetchval("SELECT is_read FROM voicemail_messages WHERE id = $1",
                                mid) is False

        r = await c.get(tx_url(mid), headers=h.auth("ro_a"))       # readonly reads
        assert r.status_code == 200 and r.json()["text"] == TEXT
        assert r.json()["can_retry"] is False
        r = await c.get(tx_url(mid), headers=h.auth("admin"))
        assert r.status_code == 200 and r.json()["can_retry"] is True   # admin force
        assert [a["source"] for a in await audits(h, "transcript_view", message_id=mid)] == \
            ["ui", "ui", "admin"]
        r = await c.get(f"/voicemail/messages/{mid}/transcript", headers=h.auth("user_a"))
        assert r.status_code == 200                                   # legacy mount
        # The ciphertext column never holds the plaintext.
        ct = await h.fetchval("SELECT ciphertext FROM voicemail_transcripts "
                              "WHERE message_id = $1", mid)
        assert b"Dana" not in ct and b"Elm Street" not in ct

    run(h, go())


def test_get_transcript_other_states_and_can_retry(h, monkeypatch, on):
    async def go():
        c = h.client
        box = await mailbox(h, enabled=True, language="es-US")
        states = ("pending", "processing", "failed", "empty", "disabled")
        ids = {s: await h.deposit_ok(box["id"]) for s in states}
        for s, mid in ids.items():
            await h.seed_transcript(mid, s, language="es-US",
                                    error_code="stt_rejected" if s == "failed" else None)
        none_id = await h.deposit_ok(box["id"])

        expect_retry = {"pending": False, "processing": False, "failed": True, "empty": True,
                        "disabled": True}
        for s, mid in ids.items():
            r = await c.get(tx_url(mid), headers=h.auth("user_a"))
            assert r.status_code == 200, (s, r.text)
            assert r.headers["cache-control"] == "no-store"
            t = r.json()
            assert set(t) == TRANSCRIPT_KEYS
            assert t["status"] == s and t["text"] is None and t["segments"] == []
            assert t["confidence"] is None and t["language"] == "es-US"
            assert t["model"] == ("telephony" if s == "empty" else None)
            assert (t["completed_at"] is not None) == (s == "empty")
            assert t["can_retry"] is expect_retry[s], s
            r = await c.get(tx_url(mid), headers=h.auth("ro_a"))
            assert r.json()["can_retry"] is False
        r = await c.get(tx_url(none_id), headers=h.auth("user_a"))
        t = r.json()
        assert t["status"] == "pending" and t["language"] is None and t["model"] is None
        assert t["completed_at"] is None and t["can_retry"] is False
        assert await audits(h, "transcript_view", mailbox_id=box["id"]) == []  # no text shown

        failed = tx_url(ids["failed"])
        # Trashed -> no retry; restored -> retry again.
        await c.delete(f"/v1/voicemail/messages/{ids['failed']}", headers=h.auth("user_a"))
        assert (await c.get(failed, headers=h.auth("user_a"))).json()["can_retry"] is False
        await c.post(f"/v1/voicemail/messages/{ids['failed']}/restore", headers=h.auth("user_a"))
        assert (await c.get(failed, headers=h.auth("user_a"))).json()["can_retry"] is True
        # Mailbox off -> no retry (and a row-less message reads 'disabled').
        await h.execute("UPDATE voicemail_boxes SET transcription_enabled = false WHERE id = $1",
                        box["id"])
        assert (await c.get(failed, headers=h.auth("user_a"))).json()["can_retry"] is False
        assert (await c.get(tx_url(none_id), headers=h.auth("user_a"))).json()["status"] == \
            "disabled"
        await h.execute("UPDATE voicemail_boxes SET transcription_enabled = true WHERE id = $1",
                        box["id"])
        # Platform unavailable -> no retry for anyone.
        monkeypatch.delenv("VOICEMAIL_TRANSCRIPTION_ENABLED")
        assert (await c.get(failed, headers=h.auth("admin"))).json()["can_retry"] is False

    run(h, go())


def test_transcript_scope(h, on):
    async def go():
        c = h.client
        box = await mailbox(h, enabled=True)
        mid = await h.deposit_ok(box["id"])
        await h.seed_transcript(mid, "done", text=TEXT)
        snip = f"/v1/voicemail/mailboxes/{box['id']}/transcript-snippets?ids={mid}"
        retry = tx_url(mid) + "/retry"

        # Customer B: 404 on everything of A's (never data, never 403 for objects).
        r = await c.get(tx_url(mid), headers=h.auth("user_b"))
        assert r.status_code == 404 and r.json()["detail"] == "Message not found."
        assert (await c.get(snip, headers=h.auth("user_b"))).status_code == 404
        assert (await c.post(retry, headers=h.auth("user_b"))).status_code == 404
        # Support: 403 everywhere; no token: 401.
        for method, path in (("GET", tx_url(mid)), ("GET", snip), ("POST", retry),
                             ("POST", f"/v1/voicemail/mailboxes/{box['id']}/transcripts/backfill"),
                             ("GET", "/v1/voicemail/transcription/status"),
                             ("POST", "/v1/voicemail/transcription/requeue")):
            r = await c.request(method, path, headers=h.auth("support"))
            assert r.status_code == 403, (method, path)
            assert (await c.request(method, path)).status_code == 401
        # Readonly: reads 200, retry 403.
        assert (await c.get(tx_url(mid), headers=h.auth("ro_a"))).status_code == 200
        assert (await c.get(snip, headers=h.auth("ro_a"))).status_code == 200
        r = await c.post(retry, headers=h.auth("ro_a"))
        assert r.status_code == 403 and r.json()["detail"] == \
            "Read-only accounts can't change voicemail."
        # Unknown / out-of-range ids are the same 404.
        for bad in (987654321, 2**63):
            assert (await c.get(tx_url(bad), headers=h.auth("user_a"))).status_code == 404
        r = await c.get("/v1/voicemail/mailboxes/987654/transcript-snippets?ids=1",
                        headers=h.auth("admin"))
        assert r.status_code == 404
        # Voicemail disabled for the customer: tenant 404, admin still reads.
        await h.execute("UPDATE customers SET voicemail_enabled = false WHERE id = $1", CUST_A)
        try:
            assert (await c.get(tx_url(mid), headers=h.auth("user_a"))).status_code == 404
            assert (await c.get(snip, headers=h.auth("user_a"))).status_code == 404
            assert (await c.post(retry, headers=h.auth("user_a"))).status_code == 404
            r = await c.get(tx_url(mid), headers=h.auth("admin"))
            assert r.status_code == 200 and r.json()["text"] == TEXT
        finally:
            await h.execute("UPDATE customers SET voicemail_enabled = true WHERE id = $1", CUST_A)

    run(h, go())


def test_transcript_audit_failure_is_503_without_text(h, monkeypatch):
    async def go():
        box = await mailbox(h)
        mid = await h.deposit_ok(box["id"])
        await h.seed_transcript(mid, "done", text=TEXT)
        from services.voicemail import audit

        async def boom(*a, **k):
            raise OSError("audit table unavailable")

        with monkeypatch.context() as mp:
            mp.setattr(audit, "write_audit", boom)
            r = await h.client.get(tx_url(mid), headers=h.auth("user_a"))
            assert r.status_code == 503 and r.headers["retry-after"] == "5"
            assert r.json()["detail"] == MSG_DOWN and "Dana" not in r.text
            r = await h.client.get(
                f"/v1/voicemail/mailboxes/{box['id']}/transcript-snippets?ids={mid}",
                headers=h.auth("user_a"))
            assert r.status_code == 200
            assert r.json() == {"items": [{"message_id": mid, "status": "done",
                                           "snippet": None}], "unavailable": True}
            assert "Dana" not in r.text
        r = await h.client.get(tx_url(mid), headers=h.auth("user_a"))
        assert r.status_code == 200 and r.json()["text"] == TEXT

    run(h, go())


def test_transcript_integrity_failures_are_500(h):
    async def go():
        c = h.client
        box = await mailbox(h)
        tampered, moved_from, moved_to, malformed = [await h.deposit_ok(box["id"])
                                                     for _ in range(4)]
        for mid in (tampered, moved_from, moved_to):
            await h.seed_transcript(mid, "done", text=TEXT)
        await h.seed_transcript(malformed, "done", plaintext=b'{"v":1,"text":"not a doc"}')
        await h.execute("UPDATE voicemail_transcripts SET ciphertext = "
                        "set_byte(ciphertext, 0, get_byte(ciphertext, 0) # 1) "
                        "WHERE message_id = $1", tampered)
        # Another message's blob + wrapped DEK on this row: the vmt AAD differs.
        await h.execute("UPDATE voicemail_transcripts d SET ciphertext = s.ciphertext, "
                        "wrapped_dek = s.wrapped_dek, iv = s.iv, kek_version = s.kek_version "
                        "FROM voicemail_transcripts s WHERE d.message_id = $1 "
                        "AND s.message_id = $2", moved_to, moved_from)
        for mid in (tampered, moved_to, malformed):
            r = await c.get(tx_url(mid), headers=h.auth("user_a"))
            assert r.status_code == 500, (mid, r.text)
            assert r.json()["detail"] == MSG_DAMAGED and "Dana" not in r.text
            assert await audits(h, "transcript_view", message_id=mid) == []
        r = await c.get(f"/v1/voicemail/mailboxes/{box['id']}/transcript-snippets"
                        f"?ids={tampered},{moved_from},{moved_to},{malformed}",
                        headers=h.auth("user_a"))
        assert r.status_code == 200
        snippets = {i["message_id"]: i["snippet"] for i in r.json()["items"]}
        assert r.json()["unavailable"] is True     # never a 5xx; the intact one still shows
        assert snippets == {tampered: None, moved_from: TEXT, moved_to: None, malformed: None}
        rows = await audits(h, "transcript_view", mailbox_id=box["id"])
        assert len(rows) == 1 and rows[0]["message_id"] is None
        assert f'"message_ids": [{moved_from}]' in rows[0]["detail"]

    run(h, go())


def test_transcript_kms_down_and_erased_key(h, monkeypatch):
    async def go():
        c = h.client
        box = await mailbox(h)
        mid = await h.deposit_ok(box["id"])
        await h.seed_transcript(mid, "done", text=TEXT)
        from services.voicemail.errors import VoicemailCryptoUnavailable
        from services.voicemail.kms import LocalKmsProvider

        async def kms_down(*a, **k):
            raise VoicemailCryptoUnavailable("KMS is down")

        with monkeypatch.context() as mp:
            mp.setattr(LocalKmsProvider, "unwrap_dek", kms_down)
            r = await c.get(tx_url(mid), headers=h.auth("user_a"))
            assert r.status_code == 503 and r.headers["retry-after"] == "5"
            assert r.json()["detail"] == MSG_DOWN
            r = await c.get(
                f"/v1/voicemail/mailboxes/{box['id']}/transcript-snippets?ids={mid}",
                headers=h.auth("user_a"))
            assert r.status_code == 200 and r.json()["unavailable"] is True
            assert r.json()["items"][0]["snippet"] is None
        assert await audits(h, "transcript_view", mailbox_id=box["id"]) == []

        # Erased key (crypto-erase in flight: rows not yet deleted) -> 404.
        await h.execute("INSERT INTO customers (id, name, account_type) VALUES "
                        "(150, 'Erasing Co', 'rcf')")
        b2 = await mailbox(h, 150)
        m2 = await h.deposit_ok(b2["id"])
        await h.seed_transcript(m2, "done", text=TEXT)
        await h.execute("UPDATE voicemail_customer_keys SET status = 'destroyed', "
                        "destroyed_at = now() WHERE customer_id = 150")
        r = await c.get(tx_url(m2), headers=h.auth("admin"))
        assert r.status_code == 404 and r.json()["detail"] == "Message not found."

    run(h, go())


def test_decrypt_slots_busy_is_503(h, monkeypatch):
    async def go():
        from services.voicemail import transcripts as vmt
        monkeypatch.setattr(vmt, "SLOT_WAIT_S", 0.05)
        monkeypatch.setattr(vmt, "SNIPPET_BUDGET_S", 0.05)
        box = await mailbox(h)
        mid = await h.deposit_ok(box["id"])
        await h.seed_transcript(mid, "done", text=TEXT)
        blocker = asyncio.Event()
        held = [vmt.SLOTS.submit(blocker.wait) for _ in range(vmt.DECRYPT_SLOTS)]
        await asyncio.sleep(0)
        assert vmt.SLOTS.active == vmt.DECRYPT_SLOTS
        try:
            r = await h.client.get(tx_url(mid), headers=h.auth("user_a"))
            assert r.status_code == 503 and r.headers["retry-after"] == "5"
            r = await h.client.get(
                f"/v1/voicemail/mailboxes/{box['id']}/transcript-snippets?ids={mid}",
                headers=h.auth("user_a"))
            assert r.status_code == 200 and r.json()["unavailable"] is True
            assert vmt.SLOTS.active == vmt.DECRYPT_SLOTS   # queued jobs were cancelled
        finally:
            blocker.set()
            await asyncio.gather(*(j.task for j in held))
        assert vmt.SLOTS.active == 0
        r = await h.client.get(tx_url(mid), headers=h.auth("user_a"))
        assert r.status_code == 200 and r.json()["text"] == TEXT
        assert vmt.SLOTS.active == 0

    run(h, go())


def test_decrypt_slots_bound_kms_work_even_when_readers_leave(h, monkeypatch):
    """The slots cap concurrent transcript decrypts at 4 per process, and a
    reader that disconnects mid-decrypt does NOT free its slot early (the KMS
    thread is still running) — that is the bound on the shared vm-io pool."""
    async def go():
        from services.voicemail import transcripts as vmt
        gate = asyncio.Event()
        running = 0
        peak = 0

        async def slow_open(**kw):
            nonlocal running, peak
            running += 1
            peak = max(peak, running)
            try:
                await gate.wait()
                return b"{}"
            finally:
                running -= 1

        monkeypatch.setattr(vmt, "open_transcript", slow_open)
        monkeypatch.setattr(vmt, "SLOT_WAIT_S", 5.0)
        row = {"ciphertext": b"", "wrapped_dek": b"", "iv": b""}
        msg = {"customer_id": 1, "mailbox_id": 1, "msg_uuid": "x"}
        readers = [asyncio.ensure_future(vmt._open_full(msg, row)) for _ in range(6)]
        for _ in range(5):
            await asyncio.sleep(0)
        assert vmt.SLOTS.active == 4 and running == 4
        readers[0].cancel()                  # a client goes away mid-decrypt
        with pytest.raises(asyncio.CancelledError):
            await readers[0]
        for _ in range(5):
            await asyncio.sleep(0)
        assert vmt.SLOTS.active == 4 and running == 4   # its decrypt still holds the slot
        gate.set()
        assert await asyncio.gather(*readers[1:]) == [b"{}"] * 5
        for _ in range(5):
            await asyncio.sleep(0)
        assert vmt.SLOTS.active == 0 and running == 0 and peak == 4

    run(h, go())


# ===========================================================================
# Snippets (plan §10.3)
# ===========================================================================
def test_snippets(h):
    async def go():
        c = h.client
        box = await mailbox(h, enabled=True)
        other = await mailbox(h)
        long_text = ("Hello, this is the facilities desk calling about the scheduled "
                     "maintenance window on Thursday night; please call us back at your "
                     "earliest convenience so we can confirm access to the building.")
        d1, d2, failed, none_id, trashed = [await h.deposit_ok(box["id"]) for _ in range(5)]
        foreign = await h.deposit_ok(other["id"])
        await h.seed_transcript(d1, "done", text=TEXT)
        await h.seed_transcript(d2, "done", text=long_text)
        await h.seed_transcript(failed, "failed", error_code="stt_rejected")
        await h.seed_transcript(trashed, "done", text=TEXT)
        await h.seed_transcript(foreign, "done", text=TEXT)
        await c.delete(f"/v1/voicemail/messages/{trashed}", headers=h.auth("user_a"))
        base = f"/v1/voicemail/mailboxes/{box['id']}/transcript-snippets"

        ids = f"{d2},{failed},{foreign},{none_id},987654321,{d1},{d2},{trashed}"
        r = await c.get(f"{base}?ids={ids}", headers=h.auth("user_a"))
        assert r.status_code == 200, r.text
        assert r.headers["cache-control"] == "no-store"
        page = r.json()
        assert page["unavailable"] is False
        # Request order, de-duplicated; foreign + unknown ids silently omitted.
        assert [i["message_id"] for i in page["items"]] == [d2, failed, none_id, d1, trashed]
        items = {i["message_id"]: i for i in page["items"]}
        assert items[d1] == {"message_id": d1, "status": "done", "snippet": TEXT}
        assert items[failed] == {"message_id": failed, "status": "failed", "snippet": None}
        assert items[none_id] == {"message_id": none_id, "status": "pending", "snippet": None}
        assert items[trashed]["snippet"] == TEXT
        cut = items[d2]["snippet"]
        assert len(cut) <= 140 and cut.endswith("…") and long_text.startswith(cut[:-1])
        assert foreign not in items
        # ONE audit row per request: no message_id, the decrypted ids.
        rows = await audits(h, "transcript_view", mailbox_id=box["id"])
        assert len(rows) == 1 and rows[0]["message_id"] is None and rows[0]["source"] == "ui"
        assert rows[0]["detail"] == ('{"kind": "snippets", "message_ids": '
                                     f'[{d1}, {d2}, {trashed}]}}')
        assert await audits(h, "transcript_view", mailbox_id=other["id"]) == []

        # Nothing decryptable -> no audit row (no text left the API).
        r = await c.get(f"{base}?ids={failed},{none_id}", headers=h.auth("ro_a"))
        assert r.status_code == 200 and r.json()["unavailable"] is False
        assert len(await audits(h, "transcript_view", mailbox_id=box["id"])) == 1
        r = await c.get(f"{base}?ids={d1}", headers=h.auth("admin"))
        assert r.json()["items"][0]["snippet"] == TEXT
        assert (await audits(h, "transcript_view", mailbox_id=box["id"]))[-1]["source"] == "admin"

        # Limits and junk.
        r = await c.get(f"{base}?ids=" + ",".join(str(i) for i in range(1, 51)),
                        headers=h.auth("user_a"))
        assert r.status_code == 200
        for bad, detail in ((",".join(str(i) for i in range(1, 52)),
                             "Ask for at most 50 messages at a time."),
                            (",".join(["1"] * 2000), "Ask for at most 50 messages at a time."),
                            ("1,a", "Message ids must be numbers."),
                            ("", "Message ids must be numbers."),
                            ("0", "Message ids must be numbers."),
                            ("-3", "Message ids must be numbers."),
                            ("1,,2", "Message ids must be numbers."),
                            ("99999999999999999999", "Message ids must be numbers.")):
            r = await c.get(f"{base}?ids={bad}", headers=h.auth("user_a"))
            assert r.status_code == 422 and r.json()["detail"] == detail, bad
        r = await c.get(base, headers=h.auth("user_a"))
        assert r.status_code == 422 and r.json()["detail"] == "Message ids must be numbers."

    run(h, go())


# ===========================================================================
# Retry (plan §10.2; O2: plain retry = writer, force = admin)
# ===========================================================================
def test_retry_matrix(h, monkeypatch, on):
    async def go():
        c = h.client
        box = await mailbox(h, enabled=True, language="fr-CA")
        ids = {s: await h.deposit_ok(box["id"])
               for s in ("pending", "processing", "done", "failed", "empty", "disabled", "none")}
        for s, mid in ids.items():
            if s != "none":
                await h.seed_transcript(mid, s, attempts=3,
                                        error_code="stt_unavailable" if s == "failed" else None)

        async def retry(s, who="user_a", **body):
            return await c.post(tx_url(ids[s]) + "/retry", headers=h.auth(who),
                                json=body or None)

        for s, detail in (("pending", "This message is already being transcribed."),
                          ("processing", "This message is already being transcribed."),
                          ("done", "This message already has a transcript.")):
            r = await retry(s)
            assert r.status_code == 409 and r.json()["detail"] == detail, s
        r = await retry("done", force=True)
        assert r.status_code == 403 and r.json()["detail"] == "Only an administrator can do that."
        r = await retry("failed", "ro_a")
        assert r.status_code == 403

        for s in ("failed", "empty", "disabled", "none"):
            r = await retry(s)
            assert r.status_code == 202, (s, r.text)
            assert r.json() == {"message_id": ids[s], "status": "pending"}
            row = await tx_row(h, ids[s])
            assert row["status"] == "pending" and row["attempts"] == 0
            assert row["error_code"] is None and row["language"] == "fr-CA"
            assert row["ciphertext"] is None and row["completed_at"] is None
        r = await retry("failed")
        assert r.status_code == 409 and r.json()["detail"] == \
            "This message is already being transcribed."
        # Admin force re-runs a done transcript (crypto cleared, CHECK holds).
        r = await retry("done", "admin", force=True)
        assert r.status_code == 202, r.text
        row = await tx_row(h, ids["done"])
        assert row["status"] == "pending" and row["ciphertext"] is None
        assert row["wrapped_dek"] is None and row["iv"] is None and row["confidence"] is None
        r = await retry("processing", "admin", force=True)
        assert r.status_code == 409          # never yanks a live attempt
        rows = await audits(h, "transcript_request", mailbox_id=box["id"])
        assert len(rows) == 5
        assert rows[0]["detail"] == '{"kind": "retry", "force": false}'
        assert rows[-1]["detail"] == '{"kind": "retry", "force": true}'
        assert rows[-1]["source"] == "admin" and rows[0]["source"] == "ui"

        # Every precondition sentence.
        m = await h.deposit_ok(box["id"])
        await h.seed_transcript(m, "failed", error_code="db")
        await c.delete(f"/v1/voicemail/messages/{m}", headers=h.auth("user_a"))
        r = await c.post(tx_url(m) + "/retry", headers=h.auth("user_a"))
        assert r.status_code == 409 and r.json()["detail"] == \
            "Restore the message before transcribing it."
        await c.post(f"/v1/voicemail/messages/{m}/restore", headers=h.auth("user_a"))
        await h.execute("UPDATE voicemail_boxes SET transcription_enabled = false WHERE id = $1",
                        box["id"])
        r = await c.post(tx_url(m) + "/retry", headers=h.auth("user_a"))
        assert r.status_code == 409 and r.json()["detail"] == MSG_MAILBOX_OFF
        await h.execute("UPDATE voicemail_boxes SET transcription_enabled = true WHERE id = $1",
                        box["id"])
        monkeypatch.delenv("VOICEMAIL_TRANSCRIPTION_ENABLED")
        r = await c.post(tx_url(m) + "/retry", headers=h.auth("user_a"))
        assert r.status_code == 409 and r.json()["detail"] == MSG_UNAVAILABLE
        assert (await tx_row(h, m))["status"] == "failed"

    run(h, go())


# ===========================================================================
# Backfill (O2: admin only)
# ===========================================================================
def test_backfill(h, monkeypatch):
    async def go():
        c = h.client
        box = await mailbox(h, language="es-US")
        m_none, m_disabled, m_done, m_failed, m_trash = [await h.deposit_ok(box["id"])
                                                         for _ in range(5)]
        await h.seed_transcript(m_disabled, "disabled", language="en-US")
        await h.seed_transcript(m_done, "done", text=TEXT)
        await h.seed_transcript(m_failed, "failed", error_code="stt_rejected")
        await c.delete(f"/v1/voicemail/messages/{m_trash}", headers=h.auth("user_a"))
        url = f"/v1/voicemail/mailboxes/{box['id']}/transcripts/backfill"

        for who in ("user_a", "ro_a", "user_b"):
            r = await c.post(url, headers=h.auth(who))
            assert r.status_code == 403 and r.json()["detail"] == \
                "Only an administrator can do that.", who
        r = await c.post(url, headers=h.auth("admin"))
        assert r.status_code == 409 and r.json()["detail"] == MSG_UNAVAILABLE
        monkeypatch.setenv("VOICEMAIL_TRANSCRIPTION_ENABLED", "true")
        monkeypatch.setenv("VOICEMAIL_STT_PROVIDER", "fake")
        r = await c.post(url, headers=h.auth("admin"))
        assert r.status_code == 409 and r.json()["detail"] == MSG_MAILBOX_OFF
        r = await c.post("/v1/voicemail/mailboxes/987654/transcripts/backfill",
                         headers=h.auth("admin"))
        assert r.status_code == 404

        await h.execute("UPDATE voicemail_boxes SET transcription_enabled = true WHERE id = $1",
                        box["id"])
        r = await c.post(url, headers=h.auth("admin"))
        assert r.status_code == 202 and r.json() == {"queued": 2}
        for mid in (m_none, m_disabled):
            row = await tx_row(h, mid)
            assert row["status"] == "pending" and row["language"] == "es-US"
            assert row["attempts"] == 0
        assert (await tx_row(h, m_done))["status"] == "done"
        assert (await tx_row(h, m_failed))["status"] == "failed"
        assert await tx_row(h, m_trash) is None
        rows = await audits(h, "transcript_request", mailbox_id=box["id"])
        assert [r_["detail"] for r_ in rows] == ['{"kind": "backfill", "count": 2}']
        assert rows[0]["source"] == "admin" and rows[0]["message_id"] is None
        r = await c.post(url, headers=h.auth("admin"))
        assert r.status_code == 202 and r.json() == {"queued": 0}

    run(h, go())


# ===========================================================================
# Ops status + requeue (admin only)
# ===========================================================================
def test_ops_status_and_requeue(h, monkeypatch, on):
    async def go():
        c = h.client
        await h.execute("DELETE FROM voicemail_transcripts")
        box = await mailbox(h, enabled=True)
        off_box = await mailbox(h, enabled=False)
        m = [await h.deposit_ok(box["id"]) for _ in range(9)]
        m_off = await h.deposit_ok(off_box["id"])
        await h.seed_transcript(m[0], "done", text=TEXT, billed_ms=30_000)
        await h.seed_transcript(m[1], "done", text=TEXT, billed_ms=30_000)
        await h.seed_transcript(m[2], "empty", billed_ms=6_000)
        await h.seed_transcript(m[3], "failed", error_code="stt_unavailable")
        await h.seed_transcript(m[4], "failed", error_code="stt_unavailable")
        await h.seed_transcript(m[5], "failed", error_code="stt_rejected")
        await h.seed_transcript(m[6], "pending")
        await h.seed_transcript(m[7], "processing")
        await h.seed_transcript(m[8], "failed", error_code="stt_unavailable")  # trashed below
        await h.seed_transcript(m_off, "failed", error_code="stt_unavailable")  # mailbox off
        await c.delete(f"/v1/voicemail/messages/{m[8]}", headers=h.auth("user_a"))
        await h.execute("UPDATE voicemail_transcripts SET next_attempt_at = now() - "
                        "interval '90 seconds' WHERE message_id = $1", m[6])

        for who in ("user_a", "ro_a"):
            assert (await c.get("/v1/voicemail/transcription/status",
                                headers=h.auth(who))).status_code == 403
            assert (await c.post("/v1/voicemail/transcription/requeue", headers=h.auth(who),
                                 json={})).status_code == 403
        r = await c.get("/v1/voicemail/transcription/status", headers=h.auth("admin"))
        assert r.status_code == 200, r.text
        s = r.json()
        assert set(s) == STATUS_KEYS
        assert s["available"] is True and s["platform_enabled"] is True
        assert (s["provider"], s["location"], s["model"]) == ("fake", "us", "fake")
        assert s["counts"] == {"pending": 1, "processing": 1, "done": 2, "empty": 1,
                               "failed": 5, "disabled": 0}
        assert s["failed_by_code"] == {"stt_rejected": 1, "stt_unavailable": 4}
        assert 90 <= s["oldest_pending_age_s"] < 600
        assert s["billed_minutes_24h"] == 1.1          # 66 000 ms
        assert s["daily_cap_minutes"] == 1000 and s["budget_exhausted"] is False
        assert s["config_problems"] == []
        monkeypatch.setenv("VOICEMAIL_STT_DAILY_MINUTES_CAP", "1")
        s = (await c.get("/v1/voicemail/transcription/status", headers=h.auth("admin"))).json()
        assert s["daily_cap_minutes"] == 1 and s["budget_exhausted"] is True
        monkeypatch.delenv("VOICEMAIL_STT_DAILY_MINUTES_CAP")

        url = "/v1/voicemail/transcription/requeue"
        # Only codes that can sit on a FAILED row (backend-T's worker): deferral
        # codes live on pending rows only, unknown codes are typos.
        for body, detail in (({"error_code": "Bad Code"}, "Choose a valid error code."),
                             ({"error_code": 5}, "Choose a valid error code."),
                             ({"error_code": "nope"}, "Choose a valid error code."),
                             ({"error_code": "stt_quota"}, "Choose a valid error code."),
                             ({"error_code": "budget"}, "Choose a valid error code."),
                             ({"error_code": "decrypt_busy"}, "Choose a valid error code."),
                             ({"limit": 0}, "Limit must be between 1 and 500."),
                             ({"limit": 501}, "Limit must be between 1 and 500."),
                             ({"limit": "5"}, "Limit must be between 1 and 500."),
                             ({"limit": True}, "Limit must be between 1 and 500.")):
            r = await c.post(url, headers=h.auth("admin"), json=body)
            assert r.status_code == 422 and r.json()["detail"] == detail, body
        # Only claimable rows (mailbox on, message stored + untrashed) move.
        r = await c.post(url, headers=h.auth("admin"),
                         json={"error_code": "stt_unavailable", "limit": 1})
        assert r.status_code == 200 and r.json() == {"requeued": 1}
        r = await c.post(url, headers=h.auth("admin"), json={"error_code": "stt_unavailable"})
        assert r.json() == {"requeued": 1}
        for mid in (m[3], m[4]):
            row = await tx_row(h, mid)
            assert row["status"] == "pending" and row["attempts"] == 0 and row["error_code"] is None
        assert (await tx_row(h, m[8]))["status"] == "failed"      # trashed
        assert (await tx_row(h, m_off))["status"] == "failed"     # mailbox off
        r = await c.post(url, headers=h.auth("admin"))            # no body: every code, 500
        assert r.json() == {"requeued": 1} and (await tx_row(h, m[5]))["status"] == "pending"
        rows = await audits(h, "transcript_requeue")
        assert [r_["detail"] for r_ in rows] == [   # jsonb orders keys by length
            '{"count": 1, "error_code": "stt_unavailable"}',
            '{"count": 1, "error_code": "stt_unavailable"}',
            '{"count": 1, "error_code": null}']
        assert all(r_["source"] == "admin" and r_["customer_id"] is None for r_ in rows)
        # Every transient + permanent failed-row code is accepted as a filter.
        from services.voicemail import transcripts as vmt
        assert vmt.REQUEUE_ERROR_CODES == {
            "stt_unavailable", "stt_timeout", "decrypt_unavailable", "seal_unavailable", "db",
            "lease_expired", "internal", "stt_rejected", "bad_wav", "integrity",
            "key_destroyed", "message_gone"}
        await h.seed_transcript(m[3], "failed", error_code="internal")
        await h.seed_transcript(m[4], "failed", error_code="bad_wav")
        for code in sorted(vmt.REQUEUE_ERROR_CODES):
            r = await c.post(url, headers=h.auth("admin"), json={"error_code": code, "limit": 1})
            assert r.status_code == 200, (code, r.text)
            assert r.json() == {"requeued": 1 if code in ("internal", "bad_wav") else 0}, code

        # Flag off: still readable by an admin, reports why.
        monkeypatch.delenv("VOICEMAIL_TRANSCRIPTION_ENABLED")
        monkeypatch.delenv("VOICEMAIL_STT_PROVIDER")
        s = (await c.get("/v1/voicemail/transcription/status", headers=h.auth("admin"))).json()
        assert s["available"] is False and s["platform_enabled"] is False
        assert s["provider"] == "gcp_stt_v2" and s["model"] == "telephony"
        assert any("VOICEMAIL_STT_PROJECT" in p for p in s["config_problems"])

    run(h, go())


# ===========================================================================
# Lifecycle: mailbox delete / crypto-erase / purge remove transcripts
# ===========================================================================
def test_mailbox_delete_erase_and_purge_remove_transcripts(h, monkeypatch):
    async def go():
        c = h.client
        box = await mailbox(h, enabled=True)
        mids = [await h.deposit_ok(box["id"]) for _ in range(2)]
        await h.seed_transcript(mids[0], "done", text=TEXT)
        await h.seed_transcript(mids[1], "failed", error_code="db")
        # GCS down: the message purge is deferred, the transcripts go NOW.
        from services.voicemail.errors import VoicemailCryptoUnavailable
        from services.voicemail.storage import MemoryObjectStore

        async def store_down(*a, **k):
            raise VoicemailCryptoUnavailable("GCS is down")

        with monkeypatch.context() as mp:
            mp.setattr(MemoryObjectStore, "delete", store_down)
            r = await c.delete(f"/v1/voicemail/mailboxes/{box['id']}", headers=h.auth("admin"))
        assert r.status_code == 204
        assert await h.fetchval("SELECT count(*) FROM voicemail_messages WHERE mailbox_id = $1 "
                                "AND status = 'stored'", box["id"]) == 2
        assert await h.fetchval("SELECT count(*) FROM voicemail_transcripts "
                                "WHERE mailbox_id = $1", box["id"]) == 0

        # Crypto-erase: every transcript of the customer, in the erase transaction.
        await h.execute("INSERT INTO customers (id, name, account_type) VALUES "
                        "(160, 'Erase Transcripts', 'rcf')")
        b1, b2 = await mailbox(h, 160), await mailbox(h, 160)
        for b in (b1, b2):
            mid = await h.deposit_ok(b["id"])
            await h.seed_transcript(mid, "done", text=TEXT)
        r = await c.post("/v1/voicemail/customers/160/crypto-erase", headers=h.auth("admin"),
                         json={"confirm": "ERASE 160"})
        assert r.status_code == 200, r.text
        assert await h.fetchval("SELECT count(*) FROM voicemail_transcripts "
                                "WHERE customer_id = 160") == 0

        # User purge: the migration-56 trigger takes the row with the message.
        b3 = await mailbox(h)
        mid = await h.deposit_ok(b3["id"])
        await h.seed_transcript(mid, "done", text=TEXT)
        r = await c.delete(f"/v1/voicemail/messages/{mid}/purge", headers=h.auth("user_a"))
        assert r.status_code == 204
        assert await tx_row(h, mid) is None
        assert (await c.get(tx_url(mid), headers=h.auth("user_a"))).status_code == 404

    run(h, go())


# ===========================================================================
# Admin "View as Customer" (admin JWT, customer_id = null) — owner's test path
# ===========================================================================
def test_admin_view_as_customer(h, on):
    async def go():
        c = h.client
        adm = h.auth("admin")
        box = await mailbox(h)
        mid = await h.deposit_ok(box["id"])
        r = await c.get(f"/v1/voicemail/summary?customer_id={CUST_A}", headers=adm)
        assert r.json()["transcription_available"] is True and r.json()["can_manage"] is True
        r = await c.get(f"/v1/voicemail/mailboxes?customer_id={CUST_A}", headers=adm)
        assert any(b["id"] == box["id"] and b["transcription_enabled"] is False
                   for b in r.json())
        # The settings panel (admin only, O2).
        r = await c.patch(f"/v1/voicemail/mailboxes/{box['id']}", headers=adm,
                          json={"transcription_enabled": True, "transcription_language": "es-US"})
        assert r.status_code == 200 and r.json()["transcription_enabled"] is True
        r = await c.post(f"/v1/voicemail/mailboxes/{box['id']}/transcripts/backfill",
                         headers=adm)
        assert r.status_code == 202 and r.json() == {"queued": 1}
        r = await c.get(f"/v1/voicemail/mailboxes/{box['id']}/messages", headers=adm)
        assert r.json()["items"][0]["transcript"] == {"status": "pending", "confidence": None}
        # The worker finishes; the reading pane + list snippets.
        await h.seed_transcript(mid, "done", text=TEXT, language="es-US")
        r = await c.get(tx_url(mid), headers=adm)
        assert r.status_code == 200 and r.json()["text"] == TEXT
        assert r.json()["language"] == "es-US" and r.json()["can_retry"] is True
        r = await c.get(f"/v1/voicemail/mailboxes/{box['id']}/transcript-snippets?ids={mid}",
                        headers=adm)
        assert r.json()["items"][0]["snippet"] == TEXT
        r = await c.post(tx_url(mid) + "/retry", headers=adm, json={"force": True})
        assert r.status_code == 202
        r = await c.get("/v1/voicemail/transcription/status", headers=adm)
        assert r.status_code == 200
        # Switch off: the queued job becomes 'disabled'.
        r = await c.patch(f"/v1/voicemail/mailboxes/{box['id']}", headers=adm,
                          json={"transcription_enabled": False})
        assert r.status_code == 200
        assert (await tx_row(h, mid))["status"] == "disabled"
        sources = {a["source"] for a in await audits(h, "transcript_view", customer_id=CUST_A)
                   if a["mailbox_id"] == box["id"]}
        assert sources == {"admin"}

    run(h, go())


# ===========================================================================
# D8: no transcript text in any log record
# ===========================================================================
def test_no_transcript_text_in_logs(h, monkeypatch, caplog):
    async def go():
        c = h.client
        secret = "Zebra quartz password is hunter two seven"
        box = await mailbox(h)
        ok, bad = [await h.deposit_ok(box["id"]) for _ in range(2)]
        await h.seed_transcript(ok, "done", text=secret)
        await h.seed_transcript(bad, "done", text=secret)
        await h.execute("UPDATE voicemail_transcripts SET ciphertext = "
                        "set_byte(ciphertext, 3, get_byte(ciphertext, 3) # 1) "
                        "WHERE message_id = $1", bad)
        caplog.set_level(logging.DEBUG)
        assert (await c.get(tx_url(ok), headers=h.auth("user_a"))).status_code == 200
        assert (await c.get(tx_url(bad), headers=h.auth("user_a"))).status_code == 500
        r = await c.get(f"/v1/voicemail/mailboxes/{box['id']}/transcript-snippets"
                        f"?ids={ok},{bad}", headers=h.auth("user_a"))
        assert r.json()["unavailable"] is True
        from services.voicemail import audit

        async def boom(*a, **k):
            raise OSError("audit down")

        with monkeypatch.context() as mp:
            mp.setattr(audit, "write_audit", boom)
            assert (await c.get(tx_url(ok), headers=h.auth("user_a"))).status_code == 503
        assert any(rec.name == "services.voicemail.transcripts" for rec in caplog.records)
        for rec in caplog.records:
            assert "Zebra" not in rec.getMessage() and "hunter" not in rec.getMessage()
            assert not rec.exc_text or "Zebra" not in rec.exc_text
        assert "Zebra" not in caplog.text

    run(h, go())
