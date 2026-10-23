"""Transcription worker (services/voicemail/transcription/worker.py + queue.py,
plan §6, §9, §14) on an ephemeral PostgreSQL 16 built from the REAL init
scripts + migrations 54 and 56, the pool connected as the runtime `api` role,
local KMS, the in-memory object store and the fake STT provider. Messages are
real sealed deposits (``seal_and_store`` of a WAV), so every job decrypts,
plans, transcribes, seals and finalizes for real.

Covers: end to end (one and two pieces, the language taken from the mailbox
at claim time, the INFO line); discovery (pending vs disabled, the 1 h window
vs the catch-up, the LIMIT, deleted mailboxes); TWO CONCURRENT CLAIMERS ->
each job exactly once; the lease reaper; the backoff schedule and
MAX_ATTEMPTS -> failed; deferrals that do not count (provider quota,
decrypt busy); the breaker (open, skip, close; three rejections); the daily
budget cap; the FENCED finalize (a stale attempt is discarded); purge during
processing -> no resurrection, no audit row; trash / restore; disable
mid-flight; crypto-erase; ALL-SILENT -> empty with ZERO provider calls; the
``transcribe`` audit row in the SAME transaction; NO PLAINTEXT in logs, the
ciphertext column, the audit row or any file; permanent failures (bad WAV,
integrity, key destroyed, message gone); the job deadline; flag off / bad
config / missing migration; run_forever + cancellation; start_if_enabled;
the retention orphan step.

Run:  JWT_SECRET_KEY=x python3 -m pytest tests/test_voicemail_transcription_worker.py -q
"""
import asyncio
import base64
import logging
import os
import random
import struct
import sys
import uuid
from pathlib import Path

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")

asyncpg = pytest.importorskip("asyncpg", reason="asyncpg required for worker tests")
pytest.importorskip("cryptography", reason="cryptography required")

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "docker" / "api" / "src"))

from voicemail_db import (  # noqa: E402
    EphemeralPG,
    apply_prerequisites,
    apply_voicemail_schema,
    find_pg_bin,
)

from services import voicemail as vm  # noqa: E402
from services.voicemail import audio, audit, kms as vm_kms, retention, storage as vm_storage  # noqa: E402
from services.voicemail.transcription import config as tconfig  # noqa: E402
from services.voicemail.transcription import document, fake_stt, queue, worker  # noqa: E402
from services.voicemail.transcription import provider as prov  # noqa: E402
from services.voicemail.wav import build_wav  # noqa: E402

PG_BIN = find_pg_bin()
PORT = 55478  # transcription suites: 55478-55489 (backend-A: 55490-55499)

_LOOP = asyncio.new_event_loop()


def run(coro):
    return _LOOP.run_until_complete(coro)


SECRET = "Zebra Quokka seventy-seven thirty-one."     # the fake "spoken" text
MASTER_KEY_B64 = base64.b64encode(bytes(range(32))).decode()
ENV = {
    "VOICEMAIL_KMS_PROVIDER": "local",
    "VOICEMAIL_ALLOW_LOCAL_KMS": "true",
    "VOICEMAIL_STORAGE": "memory",
    "VOICEMAIL_LOCAL_MASTER_KEY": MASTER_KEY_B64,
    "VOICEMAIL_TRANSCRIPTION_ENABLED": "true",
    "VOICEMAIL_STT_PROVIDER": "fake",
    "VOICEMAIL_STT_FAKE_TEXT": SECRET,
}
CLEARED = ("ENV", "ENVIRONMENT", "VOICEMAIL_KMS_PROJECT", "VOICEMAIL_STT_PROJECT",
           "VOICEMAIL_STT_LOCATION", "VOICEMAIL_STT_MODEL", "VOICEMAIL_STT_CONCURRENCY",
           "VOICEMAIL_STT_DAILY_MINUTES_CAP", "VOICEMAIL_TRANSCRIPTION_POLL_S",
           "VOICEMAIL_STT_FAKE_MODE", "GOOGLE_SDK_PYTHON_LOGGING_SCOPE", "GRPC_TRACE")


# ---------------------------------------------------------------------------
# Audio
# ---------------------------------------------------------------------------
def speech_wav(seconds: float, rate: int = 8000, seed: int = 0) -> bytes:
    rnd = random.Random(seed)
    n = int(seconds * rate)
    return build_wav(struct.pack(f"<{n}h", *(rnd.randint(-3000, 3000) for _ in range(n))), rate)


def silent_wav(seconds: float, level: int = 0) -> bytes:
    n = int(seconds * 8000)
    return build_wav(struct.pack(f"<{n}h", *((level if i % 2 else -level) for i in range(n))))


SPEECH_3S = speech_wav(3.0)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def db_mod():
    if PG_BIN is None:
        pytest.skip("no local PostgreSQL binaries; set TEST_PG_BIN to run worker tests")
    pg = EphemeralPG(PG_BIN, PORT)
    try:
        pg.start()
    except Exception as e:  # noqa: BLE001
        pg.stop()
        pytest.skip(f"could not start throwaway PostgreSQL: {e}")
    from db import database as db

    async def _setup():
        owner = await asyncpg.connect(host=pg.sock, port=pg.port, user="postgres",
                                      database="postgres", statement_cache_size=0)
        try:
            await apply_prerequisites(owner)
            await apply_voicemail_schema(owner)
        finally:
            await owner.close()
        db.pool = await asyncpg.create_pool(
            host=pg.sock, port=pg.port, user="api", password="api_secret",
            database="postgres", min_size=2, max_size=16, statement_cache_size=0)

    async def _teardown():
        if db.pool is not None:
            await db.pool.close()
            db.pool = None

    run(_setup())
    try:
        yield db
    finally:
        run(_teardown())
        pg.stop()


@pytest.fixture(autouse=True)
def env(db_mod, monkeypatch):
    for name in CLEARED:
        monkeypatch.delenv(name, raising=False)
    for k, v in ENV.items():
        monkeypatch.setenv(k, v)
    vm_kms.reset_kms_providers()
    vm_storage.reset_object_stores()
    prov.reset_stt_providers()
    tconfig.reset_problem_log()
    audio.decrypt_limiter.in_use = 0
    audio.decrypt_limiter.limit = audio.DECRYPT_CONCURRENCY
    run(_clean_slate(db_mod))
    yield monkeypatch
    prov.reset_stt_providers()
    audio.decrypt_limiter.in_use = 0
    audio.decrypt_limiter.limit = audio.DECRYPT_CONCURRENCY


async def _clean_slate(db):
    """Every earlier test's messages purged (the trigger drops their
    transcripts) so a tick only sees this test's jobs."""
    async with db.pool.acquire() as c:
        await c.execute(
            "UPDATE voicemail_messages SET status = 'purged', object_key = NULL, "
            "ciphertext_crc32c = NULL, wrapped_dek = NULL, kek_version = NULL, iv = NULL "
            "WHERE status <> 'purged'")
        await c.execute("DELETE FROM voicemail_transcripts")


class Clock:
    def __init__(self):
        self.now = 1_000.0

    def __call__(self):
        return self.now


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def w(clock):
    return worker.TranscriptionWorker(clock=clock)


def fake():
    p = prov.get_stt_provider()
    assert isinstance(p, fake_stt.FakeSttProvider)
    return p


_dids = iter(range(1000, 9999))


async def customer(db, *, voicemail=True) -> int:
    async with db.pool.acquire() as c:
        cid = await c.fetchval(
            "INSERT INTO customers (name, account_type, voicemail_enabled) "
            "VALUES ($1::varchar, 'rcf', $2::bool) RETURNING id",
            f"vmt-{uuid.uuid4().hex[:8]}", voicemail)
    await vm.ensure_customer_key(cid)
    return cid


async def box(db, cid, *, on=True, language="en-US") -> int:
    async with db.pool.acquire() as c:
        return await c.fetchval(
            "INSERT INTO voicemail_boxes (customer_id, did, transcription_enabled, "
            "transcription_language) VALUES ($1::int, $2::varchar, $3::bool, $4::varchar) "
            "RETURNING id", cid, f"+1781555{next(_dids):04d}", on, language)


async def deposit(db, cid, mbox, wav=SPEECH_3S, *, age_s=0, trashed=False) -> int:
    """A real stored message: the WAV sealed under the customer's key."""
    u = str(uuid.uuid4())
    key = vm.message_object_key(cid, mbox, u)
    sealed = await vm.seal_and_store(customer_id=cid, object_key=key,
                                     aad=vm.message_aad(cid, mbox, u), plaintext=wav)
    async with db.pool.acquire() as c:
        return await c.fetchval(
            "INSERT INTO voicemail_messages (msg_uuid, mailbox_id, customer_id, size_bytes, "
            "status, object_key, ciphertext_crc32c, wrapped_dek, kek_version, iv, enc_algo, "
            "expires_at, created_at, deleted_at) VALUES ($1::uuid, $2::int, $3::int, $4::int, "
            "'stored', $5::text, $6::bigint, $7::bytea, $8::text, $9::bytea, $10::varchar, "
            "now() + interval '90 days', now() - make_interval(secs => $11::int), "
            "CASE WHEN $12::bool THEN now() ELSE NULL END) RETURNING id",
            u, mbox, cid, len(wav), sealed.object_key, sealed.ciphertext_crc32c,
            sealed.wrapped_dek, sealed.kek_version, sealed.iv, sealed.enc_algo, age_s, trashed)


async def placeholder(db, cid, mbox) -> int:
    """A stored row with placeholder crypto (claim tests never decrypt)."""
    async with db.pool.acquire() as c:
        return await c.fetchval(
            "INSERT INTO voicemail_messages (msg_uuid, mailbox_id, customer_id, size_bytes, "
            "status, object_key, ciphertext_crc32c, wrapped_dek, kek_version, iv, expires_at) "
            "VALUES ($1::uuid, $2::int, $3::int, 10, 'stored', 'k', 1, 'w', 'v', $4::bytea, "
            "now() + interval '1 day') RETURNING id",
            uuid.uuid4(), mbox, cid, b"\x00" * 12)


async def row(db, msg_id) -> dict | None:
    async with db.pool.acquire() as c:
        r = await c.fetchrow(
            "SELECT *, EXTRACT(EPOCH FROM next_attempt_at - now())::float AS due_in_s "
            "FROM voicemail_transcripts WHERE message_id = $1::bigint", msg_id)
    return dict(r) if r else None


async def sql(db, query, *args):
    async with db.pool.acquire() as c:
        return await c.execute(query, *args)


async def make_due(db, *ids):
    await sql(db, "UPDATE voicemail_transcripts SET next_attempt_at = now() "
                  "WHERE message_id = ANY($1::bigint[])", list(ids))


async def audits(db, msg_id) -> list[dict]:
    async with db.pool.acquire() as c:
        return [dict(r) for r in await c.fetch(
            "SELECT action, source, detail::text AS detail FROM voicemail_access_log "
            "WHERE message_id = $1::bigint AND action = 'transcribe'", msg_id)]


async def cycle(w) -> dict:
    counts = await w.tick()
    await w.drain()
    return counts


async def opened_text(db, msg_id) -> document.TranscriptDoc:
    async with db.pool.acquire() as c:
        r = await c.fetchrow(
            "SELECT t.*, m.msg_uuid FROM voicemail_transcripts t JOIN voicemail_messages m "
            "ON m.id = t.message_id WHERE t.message_id = $1::bigint", msg_id)
    plain = await vm.open_transcript(customer_id=r["customer_id"], mailbox_id=r["mailbox_id"],
                                     msg_uuid=r["msg_uuid"], ciphertext=r["ciphertext"],
                                     wrapped_dek=r["wrapped_dek"], iv=r["iv"])
    return document.decode(plain)


_PURGE = ("UPDATE voicemail_messages SET status = 'purged', object_key = NULL, "
          "ciphertext_crc32c = NULL, wrapped_dek = NULL, kek_version = NULL, iv = NULL "
          "WHERE id = $1::bigint")


def hook_transcribe(monkeypatch, before):
    """Run ``before()`` inside the provider call (i.e. while the job is
    in flight, after the re-check), then transcribe normally."""
    p = fake()
    real = p.transcribe

    async def transcribe(chunks, **kw):
        await before()
        return await real(chunks, **kw)

    monkeypatch.setattr(p, "transcribe", transcribe)
    return p


# ===========================================================================
# End to end
# ===========================================================================
def test_end_to_end_done(db_mod, w, caplog):
    async def go():
        cid = await customer(db_mod)
        mbox = await box(db_mod, cid, language="es-US")
        msg = await deposit(db_mod, cid, mbox)
        with caplog.at_level(logging.INFO, logger=worker.logger.name):
            counts = await cycle(w)
        assert counts["discovered"] >= 1 and counts["claimed"] == 1
        r = await row(db_mod, msg)
        assert r["status"] == "done" and r["attempts"] == 1 and r["error_code"] is None
        assert (r["provider"], r["model"], r["language"]) == ("fake", "fake", "es-US")
        assert r["chunk_count"] == 1 and r["billed_ms"] == 3000
        assert 2900 <= r["audio_ms"] <= 3000 and r["confidence"] == pytest.approx(0.9)
        assert r["lease_until"] is None and r["attempt_id"] is None
        assert r["completed_at"] is not None and r["enc_algo"] == "AES-256-GCM"
        assert len(r["iv"]) == 12 and r["kek_version"] == f"local:{cid}/v1"
        doc = await opened_text(db_mod, msg)
        assert doc.text == SECRET and doc.language == "es-US" and doc.model == "fake"
        [seg] = doc.segments
        assert seg.start_ms == 0 and 2900 <= seg.end_ms <= 3000 and seg.confidence == 0.9
        [call] = fake().calls
        assert (call["offset_ms"], call["sample_rate_hz"], call["language"]) == (0, 8000, "es-US")
        [a] = await audits(db_mod, msg)
        assert (a["action"], a["source"]) == ("transcribe", "system")
        import json
        detail = json.loads(a["detail"])
        assert detail == {"provider": "fake", "model": "fake", "location": "us",
                          "language": "es-US", "status": "done", "chunks": 1,
                          "audio_ms": r["audio_ms"], "billed_ms": 3000, "attempts": 1}
        line = [rec.getMessage() for rec in caplog.records if f"message={msg} status=" in
                rec.getMessage()]
        assert len(line) == 1 and "status=done attempts=1 chunks=1" in line[0]
        assert "model=fake lang=es-US conf=0.900" in line[0]

    run(go())


def test_seventy_seconds_is_two_pieces(db_mod, w):
    async def go():
        cid = await customer(db_mod)
        mbox = await box(db_mod, cid)
        msg = await deposit(db_mod, cid, mbox, speech_wav(70.0, seed=3))
        await cycle(w)
        r = await row(db_mod, msg)
        assert r["status"] == "done" and r["chunk_count"] == 2
        calls = fake().calls
        assert len(calls) == 2 and calls[0]["offset_ms"] == 0
        assert 40_000 <= calls[1]["offset_ms"] <= 55_000
        assert all(c["piece_ms"] <= 55_000 for c in calls)
        doc = await opened_text(db_mod, msg)
        assert doc.text == f"{SECRET} {SECRET}" and len(doc.segments) == 2
        assert doc.segments[1].start_ms == calls[1]["offset_ms"]
        assert r["billed_ms"] == sum(-(-c["piece_ms"] // 1000) * 1000 for c in calls)

    run(go())


def test_sixteen_khz_recording(db_mod, w):
    async def go():
        cid = await customer(db_mod)
        msg = await deposit(db_mod, cid, await box(db_mod, cid), speech_wav(2.0, rate=16000))
        await cycle(w)
        assert (await row(db_mod, msg))["status"] == "done"
        assert fake().calls[0]["sample_rate_hz"] == 16000

    run(go())


# ===========================================================================
# Discovery, claim, reaper
# ===========================================================================
def test_discovery_pending_vs_disabled_window_catchup_and_limit(db_mod, w, clock, monkeypatch):
    async def go():
        cid = await customer(db_mod)
        on, off = await box(db_mod, cid), await box(db_mod, cid, on=False)
        recent_on = await placeholder(db_mod, cid, on)
        recent_off = await placeholder(db_mod, cid, off)
        old_on = await placeholder(db_mod, cid, on)
        await sql(db_mod, "UPDATE voicemail_messages SET created_at = now() - interval '2 hours' "
                          "WHERE id = $1::bigint", old_on)
        gone_box = await box(db_mod, cid)
        in_deleted = await placeholder(db_mod, cid, gone_box)
        await sql(db_mod, "UPDATE voicemail_boxes SET status = 'deleted' WHERE id = $1::int",
                  gone_box)

        w._next_catchup = clock.now + 10_000          # the 1 h window only
        counts = await w.housekeeping(db_mod.pool)
        assert counts["discovered"] == 2
        assert (await row(db_mod, recent_on))["status"] == "pending"
        assert (await row(db_mod, recent_off))["status"] == "disabled"
        assert await row(db_mod, old_on) is None and await row(db_mod, in_deleted) is None

        clock.now += 20_000                            # the 15-min catch-up is due
        counts = await w.housekeeping(db_mod.pool)
        assert counts["discovered"] == 1 and (await row(db_mod, old_on))["status"] == "pending"
        assert await row(db_mod, in_deleted) is None   # deleted mailboxes never
        assert (await w.housekeeping(db_mod.pool))["discovered"] == 0   # never re-queues

        more = [await placeholder(db_mod, cid, on) for _ in range(3)]
        monkeypatch.setattr(worker, "DISCOVER_LIMIT", 2)
        assert (await w.housekeeping(db_mod.pool))["discovered"] == 2
        assert (await w.housekeeping(db_mod.pool))["discovered"] == 1
        assert all([await row(db_mod, m) for m in more])

    run(go())


def test_housekeeping_is_one_process_at_a_time(db_mod, w):
    async def go():
        async with db_mod.pool.acquire() as holder:
            async with holder.transaction():
                assert await holder.fetchval("SELECT pg_try_advisory_xact_lock($1::bigint)",
                                             queue.LOCK_KEY)
                assert await w.housekeeping(db_mod.pool) == {"locked": False}
        assert "discovered" in await w.housekeeping(db_mod.pool)

    run(go())


def test_two_concurrent_claimers_each_job_exactly_once(db_mod, clock):
    async def go():
        cid = await customer(db_mod)
        mbox = await box(db_mod, cid)
        ids = [await placeholder(db_mod, cid, mbox) for _ in range(12)]
        await worker.TranscriptionWorker(clock=clock).housekeeping(db_mod.pool)
        a, b = worker.TranscriptionWorker(clock=clock), worker.TranscriptionWorker(clock=clock)
        jobs = await asyncio.gather(*(x.claim(db_mod.pool) for _ in range(9) for x in (a, b)))
        got = [j.message_id for j in jobs if j is not None]
        assert sorted(got) == sorted(ids), "every job claimed exactly once"
        assert len(set(j.attempt_id for j in jobs if j)) == 12
        async with db_mod.pool.acquire() as c:
            rows = await c.fetch("SELECT status, attempts, lease_until IS NOT NULL AS leased "
                                 "FROM voicemail_transcripts WHERE message_id = ANY($1::bigint[])",
                                 ids)
        assert {(r["status"], r["attempts"], r["leased"]) for r in rows} == {("processing", 1, True)}
        assert await a.claim(db_mod.pool) is None

    run(go())


def test_claim_skips_what_is_not_claimable(db_mod, w):
    async def go():
        cid = await customer(db_mod)
        no_vm = await customer(db_mod, voicemail=False)
        mbox, off = await box(db_mod, cid), await box(db_mod, cid, on=False)
        trashed = await placeholder(db_mod, cid, mbox)
        await sql(db_mod, "UPDATE voicemail_messages SET deleted_at = now() WHERE id = $1::bigint",
                  trashed)
        disabled_box = await placeholder(db_mod, cid, off)
        no_vm_msg = await placeholder(db_mod, no_vm, await box(db_mod, no_vm))
        later = await placeholder(db_mod, cid, mbox)
        await w.housekeeping(db_mod.pool)
        await sql(db_mod, "UPDATE voicemail_transcripts SET status = 'pending' "
                          "WHERE message_id = $1::bigint", disabled_box)  # pending, box off
        await sql(db_mod, "UPDATE voicemail_transcripts SET next_attempt_at = now() + "
                          "interval '1 hour' WHERE message_id = $1::bigint", later)
        assert await w.claim(db_mod.pool) is None
        for m in (trashed, disabled_box, no_vm_msg, later):
            assert (await row(db_mod, m))["status"] == "pending"

    run(go())


def test_lease_reaper(db_mod, w):
    async def go():
        cid = await customer(db_mod)
        mbox = await box(db_mod, cid)
        young, old, live = [await placeholder(db_mod, cid, mbox) for _ in range(3)]
        await w.housekeeping(db_mod.pool)
        for m, attempts, lease in ((young, 2, "-1 second"), (old, 5, "-1 second"),
                                   (live, 1, "10 minutes")):
            await sql(db_mod, "UPDATE voicemail_transcripts SET status = 'processing', "
                              "attempts = $2::int, attempt_id = gen_random_uuid(), "
                              "lease_until = now() + $3::text::interval "
                              "WHERE message_id = $1::bigint", m, attempts, lease)
        counts = await w.housekeeping(db_mod.pool)
        assert counts["reaped"] == 2
        y, o, lv = [await row(db_mod, m) for m in (young, old, live)]
        assert (y["status"], y["error_code"], y["attempt_id"], y["lease_until"]) == \
            ("pending", "lease_expired", None, None)
        assert 50 <= y["due_in_s"] <= 61
        assert (o["status"], o["error_code"]) == ("failed", "lease_expired")
        assert lv["status"] == "processing"

    run(go())


# ===========================================================================
# Failure classes, backoff, breaker, budget
# ===========================================================================
def test_transient_backoff_then_failed_after_max_attempts(db_mod, w, monkeypatch, caplog):
    monkeypatch.setenv("VOICEMAIL_STT_FAKE_MODE", "transient")

    async def go():
        cid = await customer(db_mod)
        msg = await deposit(db_mod, cid, await box(db_mod, cid))
        for attempt in range(1, worker.MAX_ATTEMPTS + 1):
            with caplog.at_level(logging.WARNING, logger=worker.logger.name):
                await cycle(w)
            r = await row(db_mod, msg)
            assert r["attempts"] == attempt and r["error_code"] == "stt_unavailable"
            if attempt < worker.MAX_ATTEMPTS:
                backoff = worker.BACKOFF_S[attempt - 1]
                assert r["status"] == "pending"
                assert backoff * 0.8 - 2 <= r["due_in_s"] <= backoff * 1.2 + 1
                await make_due(db_mod, msg)
            else:
                assert r["status"] == "failed"
            assert r["ciphertext"] is None and r["attempt_id"] is None
        assert len(fake().calls) == worker.MAX_ATTEMPTS
        assert any("next_in_s=" in rec.getMessage() for rec in caplog.records)
        assert await audits(db_mod, msg) == []

    run(go())


def test_quota_defers_without_counting_and_opens_the_breaker(db_mod, w, clock, monkeypatch,
                                                              caplog):
    monkeypatch.setenv("VOICEMAIL_STT_FAKE_MODE", "unavailable")

    async def go():
        cid = await customer(db_mod)
        mbox = await box(db_mod, cid)
        msg = await deposit(db_mod, cid, mbox)
        with caplog.at_level(logging.INFO, logger=worker.logger.name):
            await cycle(w)
        r = await row(db_mod, msg)
        assert (r["status"], r["attempts"], r["error_code"]) == ("pending", 0, "stt_quota")
        assert worker.DEFER_S - 2 <= r["due_in_s"] <= worker.DEFER_S + 1
        assert w.breaker_open()
        assert sum("breaker OPEN" in rec.getMessage() for rec in caplog.records) == 1

        await make_due(db_mod, msg)
        assert await cycle(w) == {"skipped": "breaker"}
        assert (await row(db_mod, msg))["status"] == "pending"

        monkeypatch.setenv("VOICEMAIL_STT_FAKE_MODE", "ok")
        prov.reset_stt_providers()
        clock.now += 301                                # stt_quota pauses 300 s
        with caplog.at_level(logging.INFO, logger=worker.logger.name):
            await cycle(w)
        assert any("breaker closed" in rec.getMessage() for rec in caplog.records)
        r = await row(db_mod, msg)
        assert r["status"] == "done" and r["attempts"] == 1

    run(go())


def test_decrypt_busy_defers_30_s_without_counting(db_mod, w):
    async def go():
        cid = await customer(db_mod)
        msg = await deposit(db_mod, cid, await box(db_mod, cid))
        audio.decrypt_limiter.limit = 0
        await cycle(w)
        r = await row(db_mod, msg)
        assert (r["status"], r["attempts"], r["error_code"]) == ("pending", 0, "decrypt_busy")
        assert 28 <= r["due_in_s"] <= 31
        assert not w.breaker_open() and fake().calls == []

    run(go())


def test_three_rejections_on_different_messages_open_the_breaker(db_mod, w, monkeypatch):
    monkeypatch.setenv("VOICEMAIL_STT_FAKE_MODE", "rejected")

    async def go():
        cid = await customer(db_mod)
        mbox = await box(db_mod, cid)
        msgs = [await deposit(db_mod, cid, mbox, seed) for seed in
                (SPEECH_3S, speech_wav(2, seed=1), speech_wav(2, seed=2))]
        for i in range(3):
            assert not w.breaker_open()
            await cycle(w)
        for m in msgs:
            r = await row(db_mod, m)
            assert (r["status"], r["error_code"], r["attempts"]) == ("failed", "stt_rejected", 1)
        assert w.breaker_open() and "stt_rejected" in w.breaker_reason

    run(go())
    # The same message rejected twice counts once.
    w2 = worker.TranscriptionWorker()
    for m in (7, 7, 8):
        w2._note_rejected(m)
    assert not w2.breaker_open()
    w2._note_rejected(9)
    assert w2.breaker_open()


def test_daily_budget_cap_blocks_claims(db_mod, w, clock, monkeypatch, caplog):
    monkeypatch.setenv("VOICEMAIL_STT_DAILY_MINUTES_CAP", "1")

    async def go():
        cid = await customer(db_mod)
        mbox = await box(db_mod, cid)
        spent = await placeholder(db_mod, cid, mbox)
        await sql(db_mod, "INSERT INTO voicemail_transcripts (message_id, mailbox_id, "
                          "customer_id, status, language, billed_ms, completed_at) VALUES "
                          "($1::bigint, $2::int, $3::int, 'empty', 'en-US', 60000, now())",
                  spent, mbox, cid)
        msg = await deposit(db_mod, cid, mbox)
        with caplog.at_level(logging.ERROR, logger=worker.logger.name):
            assert await cycle(w) == {"skipped": "budget"}
            assert await cycle(w) == {"skipped": "budget"}
        assert sum("daily cap reached" in rec.getMessage() for rec in caplog.records) == 1
        assert await row(db_mod, msg) is None and fake().calls == []
        # Rolls off: the next read (>= 60 s later) lets claims through.
        await sql(db_mod, "UPDATE voicemail_transcripts SET completed_at = now() - "
                          "interval '25 hours' WHERE message_id = $1::bigint", spent)
        assert await cycle(w) == {"skipped": "budget"}          # cached figure
        clock.now += worker.BUDGET_REFRESH_S
        await cycle(w)
        assert (await row(db_mod, msg))["status"] == "done"

    run(go())


def test_job_deadline_is_a_transient_timeout(db_mod, w, monkeypatch):
    monkeypatch.setenv("VOICEMAIL_STT_FAKE_MODE", "slow")
    monkeypatch.setattr(fake_stt, "FAKE_SLOW_S", 5.0)
    monkeypatch.setattr(fake_stt, "FAKE_RPC_TIMEOUT_S", 10.0)
    monkeypatch.setattr(worker, "JOB_DEADLINE_S", 0.3)

    async def go():
        cid = await customer(db_mod)
        msg = await deposit(db_mod, cid, await box(db_mod, cid))
        await cycle(w)
        r = await row(db_mod, msg)
        assert (r["status"], r["attempts"], r["error_code"]) == ("pending", 1, "stt_timeout")

    run(go())


def test_provider_rpc_timeout_is_a_transient_timeout(db_mod, w, monkeypatch):
    monkeypatch.setenv("VOICEMAIL_STT_FAKE_MODE", "slow")
    monkeypatch.setattr(fake_stt, "FAKE_SLOW_S", 5.0)
    monkeypatch.setattr(fake_stt, "FAKE_RPC_TIMEOUT_S", 0.05)

    async def go():
        cid = await customer(db_mod)
        msg = await deposit(db_mod, cid, await box(db_mod, cid))
        await cycle(w)
        assert (await row(db_mod, msg))["error_code"] == "stt_timeout"

    run(go())


# ===========================================================================
# Fencing, purge, trash, disable, erase
# ===========================================================================
def test_fenced_finalize_discards_a_stale_attempt(db_mod, w, monkeypatch):
    async def go():
        cid = await customer(db_mod)
        msg = await deposit(db_mod, cid, await box(db_mod, cid))
        other = uuid.uuid4()

        async def taken_over():   # reaped + re-claimed by another process meanwhile
            await sql(db_mod, "UPDATE voicemail_transcripts SET attempt_id = $2::uuid, "
                              "attempts = attempts + 1 WHERE message_id = $1::bigint", msg, other)

        hook_transcribe(monkeypatch, taken_over)
        await w.housekeeping(db_mod.pool)
        job = await w.claim(db_mod.pool)
        assert await w.process(job) == "discarded"
        r = await row(db_mod, msg)
        assert (r["status"], r["attempt_id"], r["attempts"]) == ("processing", other, 2)
        assert r["ciphertext"] is None and await audits(db_mod, msg) == []

    run(go())


def test_purge_during_processing_never_resurrects(db_mod, w, monkeypatch):
    async def go():
        cid = await customer(db_mod)
        msg = await deposit(db_mod, cid, await box(db_mod, cid))

        async def purge():
            await sql(db_mod, _PURGE, msg)            # user purge / retention mid-STT

        p = hook_transcribe(monkeypatch, purge)
        await cycle(w)
        assert len(p.calls) == 1
        assert await row(db_mod, msg) is None, "the trigger deleted it; nothing re-created it"
        assert await audits(db_mod, msg) == []
        await w.housekeeping(db_mod.pool)
        assert await row(db_mod, msg) is None, "discovery never re-queues a purged message"

    run(go())


def test_message_gone_before_load(db_mod, w):
    async def go():
        cid = await customer(db_mod)
        msg = await deposit(db_mod, cid, await box(db_mod, cid))
        await w.housekeeping(db_mod.pool)
        job = await w.claim(db_mod.pool)
        await sql(db_mod, _PURGE, msg)
        assert await w.process(job) == "discarded"   # trigger already removed the row
        assert await row(db_mod, msg) is None and fake().calls == []

    run(go())


def test_trashed_is_not_claimed_and_restore_makes_it_claimable(db_mod, w):
    async def go():
        cid = await customer(db_mod)
        msg = await deposit(db_mod, cid, await box(db_mod, cid), trashed=True)
        assert (await cycle(w))["claimed"] == 0
        assert (await row(db_mod, msg))["status"] == "pending"
        await sql(db_mod, "UPDATE voicemail_messages SET deleted_at = NULL WHERE id = $1::bigint",
                  msg)
        assert (await cycle(w))["claimed"] == 1
        assert (await row(db_mod, msg))["status"] == "done"

    run(go())


def test_trashed_after_claim_is_abandoned_before_sending(db_mod, w):
    async def go():
        cid = await customer(db_mod)
        msg = await deposit(db_mod, cid, await box(db_mod, cid))
        await w.housekeeping(db_mod.pool)
        job = await w.claim(db_mod.pool)
        await sql(db_mod, "UPDATE voicemail_messages SET deleted_at = now() WHERE id = $1::bigint",
                  msg)
        assert await w.process(job) == "abandoned"
        assert fake().calls == [], "nothing is sent for a trashed message"
        assert (await row(db_mod, msg))["status"] == "processing"   # lease expiry re-queues it

    run(go())


def test_disabled_mid_flight(db_mod, w):
    async def go():
        cid = await customer(db_mod)
        mbox = await box(db_mod, cid)
        msg = await deposit(db_mod, cid, mbox)
        await w.housekeeping(db_mod.pool)
        job = await w.claim(db_mod.pool)
        await sql(db_mod, "UPDATE voicemail_boxes SET transcription_enabled = false "
                          "WHERE id = $1::int", mbox)
        assert await w.process(job) == "disabled"
        r = await row(db_mod, msg)
        assert (r["status"], r["error_code"], r["attempt_id"]) == ("disabled", None, None)
        assert fake().calls == []

    run(go())


def test_crypto_erase_stops_the_worker_and_retention_clears_rows(db_mod, w):
    async def go():
        cid = await customer(db_mod)
        mbox = await box(db_mod, cid)
        queued = await deposit(db_mod, cid, mbox)
        claimed = await deposit(db_mod, cid, mbox)
        await w.housekeeping(db_mod.pool)
        await sql(db_mod, "UPDATE voicemail_transcripts SET next_attempt_at = now() + "
                          "interval '1 hour' WHERE message_id = $1::bigint", queued)
        job = await w.claim(db_mod.pool)
        assert job.message_id == claimed
        await make_due(db_mod, queued)
        await vm.crypto_erase_customer(cid)
        assert await w.process(job) == "failed"
        r = await row(db_mod, claimed)
        assert (r["status"], r["error_code"]) == ("failed", "key_destroyed")
        assert await w.claim(db_mod.pool) is None, "the claim requires an active key"
        assert fake().calls == []
        await retention.sweep_once()
        assert await row(db_mod, queued) is None and await row(db_mod, claimed) is None

    run(go())


# ===========================================================================
# Empty, audit atomicity, plaintext
# ===========================================================================
@pytest.mark.parametrize("wav", [silent_wav(4.0), silent_wav(4.0, level=150)],
                         ids=["digital-silence", "below-threshold"])
def test_all_silent_is_empty_with_zero_provider_calls(db_mod, w, wav):
    async def go():
        cid = await customer(db_mod)
        msg = await deposit(db_mod, cid, await box(db_mod, cid), wav)
        await cycle(w)
        r = await row(db_mod, msg)
        assert (r["status"], r["chunk_count"], r["audio_ms"], r["billed_ms"]) == ("empty", 0, 0, 0)
        assert r["ciphertext"] is None and r["confidence"] is None
        assert fake().calls == [], "no byte left the platform"
        [a] = await audits(db_mod, msg)
        assert '"status": "empty"' in a["detail"] and '"chunks": 0' in a["detail"]

    run(go())


def test_no_speech_recognised_is_empty_but_billed(db_mod, w, monkeypatch):
    monkeypatch.setenv("VOICEMAIL_STT_FAKE_MODE", "empty")

    async def go():
        cid = await customer(db_mod)
        msg = await deposit(db_mod, cid, await box(db_mod, cid))
        await cycle(w)
        r = await row(db_mod, msg)
        assert (r["status"], r["chunk_count"], r["billed_ms"]) == ("empty", 1, 3000)
        assert r["ciphertext"] is None and len(fake().calls) == 1

    run(go())


def test_transcribe_audit_is_in_the_same_transaction(db_mod, w, monkeypatch):
    async def go():
        cid = await customer(db_mod)
        msg = await deposit(db_mod, cid, await box(db_mod, cid))

        real = audit.write_audit

        async def broken_audit(*a, **k):
            raise asyncpg.InsufficientPrivilegeError("audit insert refused")

        monkeypatch.setattr(audit, "write_audit", broken_audit)
        await cycle(w)
        r = await row(db_mod, msg)
        assert (r["status"], r["error_code"], r["attempts"]) == ("pending", "db", 1)
        assert r["ciphertext"] is None and r["completed_at"] is None, \
            "no transcript without its audit row"
        monkeypatch.setattr(audit, "write_audit", real)
        await make_due(db_mod, msg)
        await cycle(w)
        assert (await row(db_mod, msg))["status"] == "done"
        assert len(await audits(db_mod, msg)) == 1

    run(go())


_WRITES: dict = {"on": False, "events": []}


def _audit_hook(event, args):
    if not _WRITES["on"]:
        return
    if event == "open":
        path, mode, flags = (list(args) + [None, None, None])[:3]
        writing = (isinstance(mode, str) and any(ch in mode for ch in "wax+")) or (
            isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT))
        if writing and "__pycache__" not in str(path):
            _WRITES["events"].append((event, str(path)))
    elif event in ("tempfile.mkstemp", "tempfile.mkdtemp"):
        _WRITES["events"].append((event, str(args)))


sys.addaudithook(_audit_hook)


def test_no_plaintext_in_logs_ciphertext_audit_or_files(db_mod, w, caplog):
    async def go():
        cid = await customer(db_mod)
        mbox = await box(db_mod, cid)
        await deposit(db_mod, cid, mbox)
        await cycle(w)                                     # warm-up (lazy imports)
        msg = await deposit(db_mod, cid, mbox, speech_wav(62.0, seed=11))
        _WRITES["events"].clear()
        _WRITES["on"] = True
        try:
            with caplog.at_level(logging.DEBUG):
                await cycle(w)
        finally:
            _WRITES["on"] = False
        assert _WRITES["events"] == [], "a transcription job wrote a file"
        r = await row(db_mod, msg)
        assert r["status"] == "done" and r["chunk_count"] == 2
        secret = SECRET.encode()
        for col in ("ciphertext", "wrapped_dek", "iv"):
            assert secret not in r[col] and b"Zebra" not in r[col]
        for rec in caplog.records:
            text = rec.getMessage()
            assert "Zebra" not in text and "Quokka" not in text, text
        assert all("Zebra" not in a["detail"] for a in await audits(db_mod, msg))
        assert (await opened_text(db_mod, msg)).text == f"{SECRET} {SECRET}"

    run(go())


# ===========================================================================
# Permanent / transient classes
# ===========================================================================
def test_bad_wav_is_permanent(db_mod, w):
    async def go():
        cid = await customer(db_mod)
        msg = await deposit(db_mod, cid, await box(db_mod, cid), b"not a wav at all" * 64)
        await cycle(w)
        r = await row(db_mod, msg)
        assert (r["status"], r["error_code"], r["attempts"]) == ("failed", "bad_wav", 1)

    run(go())


def test_tampered_audio_is_an_integrity_failure(db_mod, w, caplog):
    async def go():
        cid = await customer(db_mod)
        msg = await deposit(db_mod, cid, await box(db_mod, cid))
        async with db_mod.pool.acquire() as c:
            key = await c.fetchval("SELECT object_key FROM voicemail_messages "
                                   "WHERE id = $1::bigint", msg)
        store = vm.get_object_store()
        raw = bytearray(store.raw(key))
        raw[50] ^= 1
        store.replace_raw(key, bytes(raw), keep_stored_crc=False)   # CRC-consistent tamper
        from services.voicemail._crc import crc32c
        await sql(db_mod, "UPDATE voicemail_messages SET ciphertext_crc32c = $2::bigint "
                          "WHERE id = $1::bigint", msg, crc32c(bytes(raw)))
        with caplog.at_level(logging.ERROR, logger=worker.logger.name):
            await cycle(w)
        r = await row(db_mod, msg)
        assert (r["status"], r["error_code"]) == ("failed", "integrity")
        assert any("integrity" in rec.getMessage() for rec in caplog.records)
        assert fake().calls == []

    run(go())


def test_object_store_down_is_transient(db_mod, w, monkeypatch):
    async def go():
        cid = await customer(db_mod)
        msg = await deposit(db_mod, cid, await box(db_mod, cid))

        async def down(_key):
            raise vm.VoicemailCryptoUnavailable("GCS unavailable")

        monkeypatch.setattr(vm.get_object_store(), "get", down)
        await cycle(w)
        r = await row(db_mod, msg)
        assert (r["status"], r["error_code"], r["attempts"]) == ("pending", "decrypt_unavailable", 1)

    run(go())


def test_seal_failures(db_mod, w, monkeypatch):
    async def go():
        cid = await customer(db_mod)
        mbox = await box(db_mod, cid)
        msg = await deposit(db_mod, cid, mbox)

        async def kms_down(**kw):
            raise vm.VoicemailCryptoUnavailable("KMS down")

        monkeypatch.setattr(worker, "seal_transcript", kms_down)
        await cycle(w)
        r = await row(db_mod, msg)
        assert (r["status"], r["error_code"]) == ("pending", "seal_unavailable")

        async def erased(**kw):
            raise vm.VoicemailKeyDestroyed("erased")

        monkeypatch.setattr(worker, "seal_transcript", erased)
        await make_due(db_mod, msg)
        await cycle(w)
        r = await row(db_mod, msg)
        assert (r["status"], r["error_code"], r["attempts"]) == ("failed", "key_destroyed", 2)

    run(go())


# ===========================================================================
# Switched off / misconfigured / no migration
# ===========================================================================
def test_flag_off_does_nothing(db_mod, w, monkeypatch):
    async def go():
        cid = await customer(db_mod)
        msg = await deposit(db_mod, cid, await box(db_mod, cid))
        monkeypatch.setenv("VOICEMAIL_TRANSCRIPTION_ENABLED", "false")
        assert await cycle(w) == {"skipped": "disabled"}
        assert await row(db_mod, msg) is None

    run(go())


def test_bad_config_does_nothing_and_logs_once(db_mod, w, monkeypatch, caplog):
    async def go():
        cid = await customer(db_mod)
        msg = await deposit(db_mod, cid, await box(db_mod, cid))
        monkeypatch.setenv("VOICEMAIL_STT_LOCATION", "eu")
        with caplog.at_level(logging.ERROR, logger=worker.logger.name):
            for _ in range(3):
                assert await cycle(w) == {"skipped": "config"}
        assert sum("unavailable" in r.getMessage() for r in caplog.records) == 1
        assert await row(db_mod, msg) is None

        monkeypatch.setenv("VOICEMAIL_STT_LOCATION", "us")
        monkeypatch.setenv("ENV", "production")              # the fake is refused
        assert await cycle(w) == {"skipped": "config"}

    run(go())


def test_missing_migration_is_logged_not_fatal(db_mod, w, monkeypatch, caplog):
    async def missing(_conn):
        return False

    monkeypatch.setattr(queue, "migration_present", missing)

    async def go():
        with caplog.at_level(logging.ERROR, logger=worker.logger.name):
            assert (await cycle(w))["skipped"] == "migration 56 not applied"
            await cycle(w)
        assert sum("migration 56" in r.getMessage() for r in caplog.records) == 1

    run(go())


# ===========================================================================
# Lifecycle: run_forever, cancellation, start_if_enabled
# ===========================================================================
def test_run_forever_processes_then_cancels_cleanly(db_mod, monkeypatch):
    monkeypatch.setenv("VOICEMAIL_TRANSCRIPTION_POLL_S", "2")
    monkeypatch.setattr(worker, "JITTER", 0.0)

    async def go():
        cid = await customer(db_mod)
        msg = await deposit(db_mod, cid, await box(db_mod, cid))
        w = worker.TranscriptionWorker()
        task = asyncio.create_task(worker.run_forever(worker=w, initial_delay=(0.0, 0.0)))
        for _ in range(100):
            await asyncio.sleep(0.05)
            r = await row(db_mod, msg)
            if r and r["status"] == "done":
                break
        assert (await row(db_mod, msg))["status"] == "done"
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert w.inflight == set()

    run(go())


def test_shutdown_abandons_in_flight_jobs_and_the_reaper_requeues_them(db_mod, monkeypatch):
    monkeypatch.setenv("VOICEMAIL_STT_FAKE_MODE", "slow")
    monkeypatch.setattr(fake_stt, "FAKE_SLOW_S", 30.0)

    async def go():
        cid = await customer(db_mod)
        msg = await deposit(db_mod, cid, await box(db_mod, cid))
        w = worker.TranscriptionWorker()
        task = asyncio.create_task(worker.run_forever(worker=w, initial_delay=(0.0, 0.0)))
        for _ in range(100):
            await asyncio.sleep(0.05)
            if fake().calls:
                break
        assert len(w.inflight) == 1
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0.05)
        assert w.inflight == set()
        r = await row(db_mod, msg)
        assert r["status"] == "processing" and r["lease_until"] is not None
        await sql(db_mod, "UPDATE voicemail_transcripts SET lease_until = now() - "
                          "interval '1 second' WHERE message_id = $1::bigint", msg)
        await worker.TranscriptionWorker().housekeeping(db_mod.pool)
        r = await row(db_mod, msg)
        assert (r["status"], r["error_code"], r["attempts"]) == ("pending", "lease_expired", 1)

    run(go())


def test_start_if_enabled(db_mod, monkeypatch):
    async def go():
        monkeypatch.setenv("VOICEMAIL_TRANSCRIPTION_ENABLED", "")
        assert worker.start_if_enabled() is None
        monkeypatch.setenv("VOICEMAIL_TRANSCRIPTION_ENABLED", "TRUE")
        task = worker.start_if_enabled()
        assert isinstance(task, asyncio.Task) and task.get_name() == "voicemail-transcription"
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    run(go())


def test_library_loggers_are_pinned_to_warning():
    for name in worker.PINNED_LOGGERS:
        logging.getLogger(name).setLevel(logging.DEBUG)
    worker.pin_library_loggers()
    for name in worker.PINNED_LOGGERS:
        assert logging.getLogger(name).level == logging.WARNING


# ===========================================================================
# Retention: the transcript orphan step (plan §9)
# ===========================================================================
def test_retention_orphan_step(db_mod, w, caplog):
    async def go():
        cid = await customer(db_mod)
        mbox = await box(db_mod, cid)
        healthy = await deposit(db_mod, cid, mbox)
        await cycle(w)
        assert (await row(db_mod, healthy))["status"] == "done"
        # The discovery race: a row inserted for a message purged meanwhile.
        raced = await placeholder(db_mod, cid, mbox)
        await sql(db_mod, _PURGE, raced)
        await sql(db_mod, "INSERT INTO voicemail_transcripts (message_id, mailbox_id, "
                          "customer_id, language) VALUES ($1::bigint, $2::int, $3::int, 'en-US')",
                  raced, mbox, cid)
        with caplog.at_level(logging.WARNING, logger=retention.logger.name):
            counts = await retention.sweep_once()
        assert counts.get("transcript_orphans") == 1, counts
        assert any("orphaned transcript" in r.getMessage() for r in caplog.records)
        assert await row(db_mod, raced) is None
        assert (await row(db_mod, healthy))["status"] == "done"
        assert "transcript_orphans" not in await retention.sweep_once()

    run(go())


def test_retention_purge_removes_the_transcript_with_the_message(db_mod, w):
    async def go():
        cid = await customer(db_mod)
        msg = await deposit(db_mod, cid, await box(db_mod, cid))
        await cycle(w)
        assert (await row(db_mod, msg))["status"] == "done"
        await sql(db_mod, "UPDATE voicemail_messages SET expires_at = now() - interval '1 second' "
                          "WHERE id = $1::bigint", msg)
        counts = await retention.sweep_once()
        assert counts.get("message:expired", 0) >= 1
        assert await row(db_mod, msg) is None

    run(go())
