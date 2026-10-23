"""Transcript sealing (services/voicemail/crypto.py, plan §5).

On an ephemeral PostgreSQL built from the REAL init scripts + migrations 54
and 56 (key rows, key_create audit rows and voicemail_transcripts rows are
real), with the API pool connected as the runtime `api` role:

LOCAL (LocalKmsProvider, dev/CI mode):
  round trip (bytes / bytearray / memoryview, str or UUID msg_uuid); a fresh
  DEK + IV per seal; the SealedBlob fits migration 56's row CHECKs and opens
  back from the row; a blob or wrapped DEK moved to another message, mailbox
  or customer -> VoicemailIntegrityError; audio (``vm:``) <-> transcript
  (``vmt:``) cross-replay fails both ways; tamper; rotation; crypto-erase ->
  VoicemailKeyDestroyed (no KMS call); NO key row -> integrity error and NO
  key / key row / audit row is created (ensure_customer_key is never
  reached); size and shape limits; DEK buffers zeroed; DB down fails closed;
  the local provider is still refused without its flag.

CLOUD (GcpKmsProvider against an in-process fake that uses the REAL
google.cloud.kms request/response types): the vmt AAD (+ CRC32C) reaches KMS
on wrap and unwrap; KMS's own AAD check -> integrity error; KMS outage ->
VoicemailCryptoUnavailable; sealing for a customer without a key row makes
ZERO KMS calls (no create_crypto_key).

No network, no credentials: nothing here contacts Google Cloud.

Run:  JWT_SECRET_KEY=x python3 -m pytest tests/test_voicemail_transcription_crypto.py -q
"""
import asyncio
import base64
import os
import struct
import sys
import uuid
from pathlib import Path

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")

asyncpg = pytest.importorskip("asyncpg", reason="asyncpg required for voicemail crypto tests")
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
from services.voicemail import _gcp, crypto as vm_crypto, keys as vm_keys  # noqa: E402
from services.voicemail import kms as vm_kms, storage as vm_storage  # noqa: E402
from services.voicemail._crc import crc32c  # noqa: E402

PG_BIN = find_pg_bin()
PORT = 55477  # distinct from every other test module (voicemail 55470-55476)

_LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


MASTER_KEY_B64 = base64.b64encode(bytes(range(32))).decode()
LOCAL_ENV = {
    "VOICEMAIL_KMS_PROVIDER": "local",
    "VOICEMAIL_ALLOW_LOCAL_KMS": "true",
    "VOICEMAIL_STORAGE": "memory",
    "VOICEMAIL_LOCAL_MASTER_KEY": MASTER_KEY_B64,
}
GCP_PROJECT = "test-project-123"
KEYRING = f"projects/{GCP_PROJECT}/locations/us-east1/keyRings/voicemail-prod"
GCP_ENV = {
    "VOICEMAIL_KMS_PROVIDER": "gcpkms",
    "VOICEMAIL_KMS_PROJECT": GCP_PROJECT,
    "VOICEMAIL_KMS_LOCATION": "us-east1",
    "VOICEMAIL_KMS_KEYRING": "voicemail-prod",
    "VOICEMAIL_ALLOW_LOCAL_KMS": "true",
    "VOICEMAIL_STORAGE": "memory",
}
_ALL_VM_ENV = set(LOCAL_ENV) | set(GCP_ENV) | {
    "VOICEMAIL_IMPERSONATE_SA", "VOICEMAIL_BUCKET", "ENV", "ENVIRONMENT"}

DOC = (b'{"v":1,"language":"en-US","model":"telephony","text":"Please call me back.",'
       b'"segments":[{"start_ms":300,"end_ms":2100,"text":"Please call me back.",'
       b'"confidence":0.91}]}')


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def vm_db():
    if PG_BIN is None:
        pytest.skip("no local PostgreSQL binaries; set TEST_PG_BIN to run voicemail tests")
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
            database="postgres", min_size=1, max_size=5, statement_cache_size=0)

    async def _teardown():
        if db.pool is not None:
            await db.pool.close()
            db.pool = None

    _run(_setup())
    try:
        yield db
    finally:
        _run(_teardown())
        pg.stop()


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    """Fresh provider/store/credential caches + no real backoff per test."""
    for name in _ALL_VM_ENV:
        monkeypatch.delenv(name, raising=False)
    vm_kms.reset_kms_providers()
    vm_storage.reset_object_stores()
    _gcp.reset_credentials_cache()
    monkeypatch.setattr(_gcp, "RETRY_BACKOFF_S", (0.0, 0.0))
    yield
    vm_kms.reset_kms_providers()
    vm_storage.reset_object_stores()
    _gcp.reset_credentials_cache()


@pytest.fixture
def local_env(monkeypatch):
    for k, v in LOCAL_ENV.items():
        monkeypatch.setenv(k, v)


@pytest.fixture
def no_key_creation(monkeypatch):
    """Any attempt to create a key fails the test (the worker must never)."""
    async def boom(*a, **k):
        raise AssertionError("seal_transcript/open_transcript must never create a key")

    monkeypatch.setattr(vm_keys, "ensure_customer_key", boom)
    monkeypatch.setattr(vm_crypto, "ensure_customer_key", boom)
    monkeypatch.setattr(vm_kms.LocalKmsProvider, "ensure_key", boom)
    monkeypatch.setattr(vm_kms.GcpKmsProvider, "ensure_key", boom)


async def _new_customer(db) -> int:
    async with db.pool.acquire() as c:
        return await c.fetchval(
            "INSERT INTO customers (name, account_type) VALUES ($1::varchar, 'rcf') RETURNING id",
            f"vmt-test-{uuid.uuid4().hex[:8]}")


async def _keyed_customer(db) -> int:
    """A customer whose (local) key already exists — as after a deposit."""
    cid = await _new_customer(db)
    await vm.ensure_customer_key(cid)
    return cid


async def _seal(cid, mbox, msg_uuid, plaintext=DOC):
    return await vm.seal_transcript(customer_id=cid, mailbox_id=mbox, msg_uuid=msg_uuid,
                                    plaintext=plaintext)


async def _open(cid, mbox, msg_uuid, blob, *, ciphertext=None, wrapped_dek=None, iv=None):
    return await vm.open_transcript(
        customer_id=cid, mailbox_id=mbox, msg_uuid=msg_uuid,
        ciphertext=blob.ciphertext if ciphertext is None else ciphertext,
        wrapped_dek=blob.wrapped_dek if wrapped_dek is None else wrapped_dek,
        iv=blob.iv if iv is None else iv)


async def _key_rows(db, cid) -> tuple[int, int]:
    async with db.pool.acquire() as c:
        keys = await c.fetchval(
            "SELECT count(*) FROM voicemail_customer_keys WHERE customer_id = $1::int", cid)
        audit = await c.fetchval(
            "SELECT count(*) FROM voicemail_access_log WHERE customer_id = $1::int "
            "AND action = 'key_create'", cid)
    return keys, audit


def _spy_provider(monkeypatch, provider):
    """Record every wrap/unwrap (and the DEK buffers they saw)."""
    calls = []
    real_wrap, real_unwrap = provider.wrap_dek, provider.unwrap_dek

    async def spy_wrap(**kw):
        calls.append(("wrap", kw["aad"], kw["dek"]))
        return await real_wrap(**kw)

    async def spy_unwrap(**kw):
        dek = await real_unwrap(**kw)
        calls.append(("unwrap", kw["aad"], dek))
        return dek

    monkeypatch.setattr(provider, "wrap_dek", spy_wrap)
    monkeypatch.setattr(provider, "unwrap_dek", spy_unwrap)
    return calls


U = "6F9619FF-8B86-D011-B42D-00C04FC964FF"


# ===========================================================================
# AAD builder + exports
# ===========================================================================
def test_transcript_aad_builder():
    assert vm.TRANSCRIPT_AAD_PREFIX == "vmt"
    assert vm.MAX_TRANSCRIPT_PLAINTEXT == 65_536
    assert vm.transcript_aad(3, 7, U) == b"vmt:3:7:6f9619ff-8b86-d011-b42d-00c04fc964ff"
    assert vm.transcript_aad(3, 7, uuid.UUID(U)) == vm.transcript_aad(3, 7, U.lower())
    # Distinct from the audio and greeting AADs of the same ids.
    assert vm.transcript_aad(3, 7, U) not in (vm.message_aad(3, 7, U), vm.greeting_aad(3, 7, U))
    for bad in ((0, 1, U), (1, -1, U), (True, 1, U), (1, 1, "not-a-uuid"), ("1", 1, U),
                (1, 1, 12345), (1, 1.0, U)):
        with pytest.raises(ValueError):
            vm.transcript_aad(*bad)
    # Re-exported from the package (the API codes against services.voicemail).
    for name in ("transcript_aad", "seal_transcript", "open_transcript", "SealedBlob",
                 "TRANSCRIPT_AAD_PREFIX", "MAX_TRANSCRIPT_PLAINTEXT"):
        assert getattr(vm, name) is getattr(vm_crypto, name)
        assert name in vm.__all__


# ===========================================================================
# LOCAL provider
# ===========================================================================
def test_round_trip(vm_db, local_env):
    async def go():
        cid = await _keyed_customer(vm_db)
        u = str(uuid.uuid4())
        blob = await _seal(cid, 11, u)
        assert isinstance(blob, vm.SealedBlob)
        assert blob.enc_algo == "AES-256-GCM" and len(blob.iv) == 12
        assert blob.kek_version == f"local:{cid}/v1"
        assert len(blob.ciphertext) == len(DOC) + 16
        assert b"Please call me back" not in blob.ciphertext
        assert await _open(cid, 11, u, blob) == DOC
        # UUID canonicalisation: sealed with an upper-case string, opened with
        # the DB's uuid column value.
        upper = str(uuid.uuid4()).upper()
        b2 = await _seal(cid, 11, upper)
        assert await _open(cid, 11, uuid.UUID(upper), b2) == DOC
        # Any bytes-like plaintext.
        for pt in (bytearray(DOC), memoryview(DOC)):
            assert await _open(cid, 11, u, await _seal(cid, 11, u, pt)) == DOC
        # A fresh DEK + IV per seal, even for the same message and text.
        again = await _seal(cid, 11, u)
        assert again.wrapped_dek != blob.wrapped_dek and again.iv != blob.iv
        assert again.ciphertext != blob.ciphertext
        with pytest.raises(AttributeError):
            blob.iv = b"x"  # frozen

    _run(go())


def test_sealed_blob_round_trips_through_the_row(vm_db, local_env):
    """The SealedBlob satisfies migration 56's CHECKs as the api role writes
    it, and what the row gives back opens to the same document."""
    async def go():
        cid = await _keyed_customer(vm_db)
        async with vm_db.pool.acquire() as c:
            box = await c.fetchval(
                "INSERT INTO voicemail_boxes (customer_id, did) VALUES ($1::int, $2::varchar) "
                "RETURNING id", cid, f"+1508555{cid % 10000:04d}")
            msg_uuid = uuid.uuid4()
            msg = await c.fetchval(
                "INSERT INTO voicemail_messages (msg_uuid, mailbox_id, customer_id, size_bytes, "
                "status, object_key, ciphertext_crc32c, wrapped_dek, kek_version, iv, expires_at) "
                "VALUES ($1::uuid, $2::int, $3::int, 10, 'stored', 'k', 1, 'w', 'v', "
                "$4::bytea, now() + interval '1 day') RETURNING id",
                msg_uuid, box, cid, b"\x00" * 12)
        blob = await _seal(cid, box, msg_uuid)
        big = await _seal(cid, box, msg_uuid, b"x" * vm.MAX_TRANSCRIPT_PLAINTEXT)
        for sealed in (blob, big):
            async with vm_db.pool.acquire() as c:
                await c.execute(
                    "INSERT INTO voicemail_transcripts (message_id, mailbox_id, customer_id, "
                    "status, language, ciphertext, wrapped_dek, kek_version, iv, enc_algo) "
                    "VALUES ($1::bigint, $2::int, $3::int, 'done', 'en-US', $4::bytea, $5::bytea, "
                    "$6::text, $7::bytea, $8::varchar) "
                    "ON CONFLICT (message_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, "
                    "wrapped_dek = EXCLUDED.wrapped_dek, kek_version = EXCLUDED.kek_version, "
                    "iv = EXCLUDED.iv",
                    msg, box, cid, sealed.ciphertext, sealed.wrapped_dek, sealed.kek_version,
                    sealed.iv, sealed.enc_algo)
                row = await c.fetchrow(
                    "SELECT t.ciphertext, t.wrapped_dek, t.iv, m.msg_uuid, t.mailbox_id, "
                    "t.customer_id FROM voicemail_transcripts t "
                    "JOIN voicemail_messages m ON m.id = t.message_id "
                    "WHERE t.message_id = $1::bigint", msg)
            opened = await vm.open_transcript(
                customer_id=row["customer_id"], mailbox_id=row["mailbox_id"],
                msg_uuid=row["msg_uuid"], ciphertext=row["ciphertext"],
                wrapped_dek=row["wrapped_dek"], iv=row["iv"])
            assert opened == (DOC if sealed is blob else b"x" * vm.MAX_TRANSCRIPT_PLAINTEXT)
        assert len(big.ciphertext) == 65_552

    _run(go())


def test_blob_moved_to_another_message_mailbox_or_customer(vm_db, local_env):
    async def go():
        c1 = await _keyed_customer(vm_db)
        c2 = await _keyed_customer(vm_db)
        u1, u2 = str(uuid.uuid4()), str(uuid.uuid4())
        a = await _seal(c1, 21, u1, b"customer one, message one")
        b = await _seal(c1, 21, u2, b"customer one, message two")
        x = await _seal(c2, 22, u1, b"customer two")
        # The whole blob replayed under another identity.
        for cid, mbox, u in ((c1, 21, u2), (c1, 99, u1), (c2, 21, u1), (c2, 22, u1)):
            with pytest.raises(vm.VoicemailIntegrityError):
                await _open(cid, mbox, u, a)
        # Mixed rows: one message's ciphertext with another's wrapped DEK / IV.
        with pytest.raises(vm.VoicemailIntegrityError):
            await _open(c1, 21, u1, a, wrapped_dek=b.wrapped_dek)
        with pytest.raises(vm.VoicemailIntegrityError):
            await _open(c1, 21, u1, a, iv=b.iv)
        with pytest.raises(vm.VoicemailIntegrityError):
            await _open(c1, 21, u1, a, ciphertext=b.ciphertext)
        # Customer two's own key cannot open customer one's DEK (and vice versa).
        with pytest.raises(vm.VoicemailIntegrityError):
            await _open(c2, 22, u1, a)
        with pytest.raises(vm.VoicemailIntegrityError):
            await _open(c1, 22, u1, x)
        # The KEK layer itself is AAD-bound, not only the GCM layer.
        provider = vm.get_kms_provider("local")
        key = await vm.get_customer_key(c1)
        with pytest.raises(vm.VoicemailIntegrityError):
            await provider.unwrap_dek(customer_id=c1, key_ref=key.key_ref,
                                      wrapped_dek=a.wrapped_dek,
                                      aad=vm.transcript_aad(c1, 21, u2))
        # Untouched rows still open.
        assert await _open(c1, 21, u1, a) == b"customer one, message one"
        assert await _open(c2, 22, u1, x) == b"customer two"

    _run(go())


def test_audio_and_transcript_cannot_be_cross_replayed(vm_db, local_env):
    async def go():
        cid = await _keyed_customer(vm_db)
        u = str(uuid.uuid4())
        tx = await _seal(cid, 31, u)
        provider = vm.get_kms_provider("local")
        key = await vm.get_customer_key(cid)

        # 1) The transcript's wrapped DEK under the AUDIO AAD of the same message.
        with pytest.raises(vm.VoicemailIntegrityError):
            await provider.unwrap_dek(customer_id=cid, key_ref=key.key_ref,
                                      wrapped_dek=tx.wrapped_dek, aad=vm.message_aad(cid, 31, u))
        # ...and as a stored audio object + row of that message (CRC-consistent).
        store = vm.get_object_store()
        okey = vm.message_object_key(cid, 31, u)
        await store.put(okey, tx.ciphertext, crc32c=crc32c(tx.ciphertext))
        with pytest.raises(vm.VoicemailIntegrityError):
            await vm.load_and_open(customer_id=cid, object_key=okey,
                                   aad=vm.message_aad(cid, 31, u), wrapped_dek=tx.wrapped_dek,
                                   iv=tx.iv, ciphertext_crc32c=crc32c(tx.ciphertext))

        # 2) The reverse: the message AUDIO's blob opened as its transcript.
        audio = b"RIFF" + os.urandom(200)
        sealed = await vm.seal_and_store(customer_id=cid, object_key=okey,
                                         aad=vm.message_aad(cid, 31, u), plaintext=audio)
        audio_ct = await store.get(okey)
        with pytest.raises(vm.VoicemailIntegrityError):
            await vm.open_transcript(customer_id=cid, mailbox_id=31, msg_uuid=u,
                                     ciphertext=audio_ct, wrapped_dek=sealed.wrapped_dek,
                                     iv=sealed.iv)
        with pytest.raises(vm.VoicemailIntegrityError):
            await provider.unwrap_dek(customer_id=cid, key_ref=key.key_ref,
                                      wrapped_dek=sealed.wrapped_dek,
                                      aad=vm.transcript_aad(cid, 31, u))
        # Both still open under their own AAD.
        assert await _open(cid, 31, u, tx) == DOC
        assert await vm.load_and_open(customer_id=cid, object_key=okey,
                                      aad=vm.message_aad(cid, 31, u),
                                      wrapped_dek=sealed.wrapped_dek, iv=sealed.iv,
                                      ciphertext_crc32c=sealed.ciphertext_crc32c) == audio

    _run(go())


def test_tampered_ciphertext_is_rejected(vm_db, local_env):
    async def go():
        cid = await _keyed_customer(vm_db)
        u = str(uuid.uuid4())
        blob = await _seal(cid, 41, u)
        for i in (0, len(blob.ciphertext) // 2, len(blob.ciphertext) - 1):  # body and tag
            bad = bytearray(blob.ciphertext)
            bad[i] ^= 0x01
            with pytest.raises(vm.VoicemailIntegrityError):
                await _open(cid, 41, u, blob, ciphertext=bytes(bad))
        with pytest.raises(vm.VoicemailIntegrityError):
            await _open(cid, 41, u, blob, ciphertext=blob.ciphertext[:-1])
        bad_wrap = bytearray(blob.wrapped_dek)
        bad_wrap[-1] ^= 0x01
        with pytest.raises(vm.VoicemailIntegrityError):
            await _open(cid, 41, u, blob, wrapped_dek=bytes(bad_wrap))

    _run(go())


def test_rotation_old_transcripts_still_open(vm_db, local_env):
    async def go():
        cid = await _keyed_customer(vm_db)
        u = str(uuid.uuid4())
        b1 = await _seal(cid, 51, u, b"before rotation")
        provider = vm.get_kms_provider()
        assert isinstance(provider, vm.LocalKmsProvider)
        provider.rotate()
        b2 = await _seal(cid, 51, u, b"after rotation")
        assert b1.kek_version.endswith("/v1") and b2.kek_version.endswith("/v2")
        assert await _open(cid, 51, u, b1) == b"before rotation"
        assert await _open(cid, 51, u, b2) == b"after rotation"

    _run(go())


def test_crypto_erase_refuses_seal_and_open(vm_db, local_env, monkeypatch):
    async def go():
        cid = await _keyed_customer(vm_db)
        u = str(uuid.uuid4())
        blob = await _seal(cid, 61, u)
        await vm.crypto_erase_customer(cid)
        calls = _spy_provider(monkeypatch, vm.get_kms_provider("local"))
        with pytest.raises(vm.VoicemailKeyDestroyed):
            await _open(cid, 61, u, blob)
        with pytest.raises(vm.VoicemailKeyDestroyed):
            await _seal(cid, 61, u)
        assert calls == [], "a destroyed key is refused before any KMS call"
        assert issubclass(vm.VoicemailKeyDestroyed, vm.VoicemailCryptoUnavailable)

    _run(go())


def test_no_key_row_is_an_integrity_error_and_creates_nothing(vm_db, local_env,
                                                               no_key_creation, monkeypatch):
    async def go():
        cid = await _new_customer(vm_db)            # never had voicemail: no key row
        calls = _spy_provider(monkeypatch, vm.get_kms_provider("local"))
        u = str(uuid.uuid4())
        with pytest.raises(vm.VoicemailIntegrityError):
            await _seal(cid, 71, u)
        fake = vm.SealedBlob(ciphertext=b"\x00" * 40, wrapped_dek=b"w" * 60,
                             kek_version="local:1/v1", iv=b"\x00" * 12, enc_algo="AES-256-GCM")
        with pytest.raises(vm.VoicemailIntegrityError):
            await _open(cid, 71, u, fake)
        assert await _key_rows(vm_db, cid) == (0, 0), "no key row and no key_create audit"
        assert calls == []
        # An unknown customer id behaves the same (no LookupError, no creation).
        with pytest.raises(vm.VoicemailIntegrityError):
            await _seal(987_654, 71, u)
        assert await _key_rows(vm_db, 987_654) == (0, 0)

    _run(go())


def test_size_and_shape_limits(vm_db, local_env, monkeypatch):
    async def go():
        cid = await _keyed_customer(vm_db)
        u = str(uuid.uuid4())
        blob = await _seal(cid, 81, u)
        calls = _spy_provider(monkeypatch, vm.get_kms_provider("local"))
        # Seal: plaintext must be non-empty bytes-like, <= MAX.
        for bad in (b"", bytearray(), b"x" * (vm.MAX_TRANSCRIPT_PLAINTEXT + 1), "text", None):
            with pytest.raises(ValueError):
                await _seal(cid, 81, u, bad)
        # Bad ids are programming errors on both sides.
        for ids in ((0, 81, u), (cid, 0, u), (True, 81, u), (cid, 81, "nope")):
            with pytest.raises(ValueError):
                await _seal(*ids)
            with pytest.raises(ValueError):
                await _open(*ids, blob)
        # Open: malformed row data is an integrity error, before any KMS call.
        for kwargs in (dict(iv=b"\x00" * 11), dict(iv=b"\x00" * 13), dict(iv="x" * 12),
                       dict(ciphertext=b"\x00" * 16), dict(ciphertext=b"\x00" * 65_553),
                       dict(ciphertext="x" * 40), dict(wrapped_dek=b""),
                       dict(wrapped_dek="w" * 60)):
            with pytest.raises(vm.VoicemailIntegrityError):
                await _open(cid, 81, u, blob, **kwargs)
        assert calls == []
        assert await _open(cid, 81, u, blob) == DOC

    _run(go())


def test_kms_sees_the_transcript_aad_and_deks_are_zeroed(vm_db, local_env, monkeypatch):
    calls = _spy_provider(monkeypatch, vm.get_kms_provider())

    async def go():
        cid = await _keyed_customer(vm_db)
        u = str(uuid.uuid4())
        blob = await _seal(cid, 91, u)
        assert await _open(cid, 91, u, blob) == DOC
        return vm.transcript_aad(cid, 91, u)

    aad = _run(go())
    assert [c[0] for c in calls] == ["wrap", "unwrap"]
    for _, seen_aad, dek in calls:
        assert seen_aad == aad
        assert isinstance(dek, bytearray) and len(dek) == 32 and not any(dek)


def test_database_unavailable_fails_closed(vm_db, local_env, monkeypatch):
    blob = vm.SealedBlob(ciphertext=b"\x00" * 40, wrapped_dek=b"w" * 60,
                         kek_version="local:1/v1", iv=b"\x00" * 12, enc_algo="AES-256-GCM")
    monkeypatch.setattr(vm_db, "pool", None)

    async def go():
        with pytest.raises(vm.VoicemailCryptoUnavailable):
            await _seal(1, 1, U)
        with pytest.raises(vm.VoicemailCryptoUnavailable):
            await _open(1, 1, U, blob)

    _run(go())


def test_local_provider_still_needs_its_flag(vm_db, local_env, monkeypatch):
    async def go():
        cid = await _keyed_customer(vm_db)
        u = str(uuid.uuid4())
        blob = await _seal(cid, 95, u)
        monkeypatch.setenv("VOICEMAIL_ALLOW_LOCAL_KMS", "false")
        with pytest.raises(vm.VoicemailCryptoUnavailable):
            await _seal(cid, 95, u)
        with pytest.raises(vm.VoicemailCryptoUnavailable):
            await _open(cid, 95, u, blob)
        monkeypatch.setenv("ENV", "production")
        monkeypatch.setenv("VOICEMAIL_ALLOW_LOCAL_KMS", "true")
        with pytest.raises(vm.VoicemailCryptoUnavailable):
            await _open(cid, 95, u, blob)

    _run(go())


# ===========================================================================
# Cloud KMS fake (real google.cloud.kms types) — encrypt/decrypt ONLY
# ===========================================================================
kms_types = pytest.importorskip("google.cloud.kms", reason="google-cloud-kms required")
gexc = pytest.importorskip("google.api_core.exceptions")
from cryptography.exceptions import InvalidTag  # noqa: E402
from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: E402


class FakeKms:
    """In-memory Cloud KMS: encrypt/decrypt with server-side CRC32C + AAD
    semantics. Any other RPC (create_crypto_key, ...) fails the test."""

    def __init__(self):
        self.keys = {}          # key name -> 32-byte key material (one ENABLED version)
        self.calls = []
        self.fail = {}

    def add_key(self, name):
        self.keys[name] = os.urandom(32)

    def _record(self, method, req, timeout, retry):
        self.calls.append((method, req, timeout, retry))
        queue = self.fail.get(method)
        if queue:
            raise queue.pop(0)

    def encrypt(self, request, timeout=None, retry=None):
        req = kms_types.EncryptRequest(request)
        self._record("encrypt", req, timeout, retry)
        if req.name not in self.keys:
            raise gexc.NotFound(req.name)
        pt, aad = bytes(req.plaintext), bytes(req.additional_authenticated_data)
        if req.plaintext_crc32c != crc32c(pt) or \
                req.additional_authenticated_data_crc32c != crc32c(aad):
            raise gexc.InvalidArgument("crc32c mismatch")
        nonce = os.urandom(12)
        ct = struct.pack(">I", 1) + nonce + AESGCM(self.keys[req.name]).encrypt(nonce, pt, aad)
        return kms_types.EncryptResponse(
            name=f"{req.name}/cryptoKeyVersions/1", ciphertext=ct, ciphertext_crc32c=crc32c(ct),
            verified_plaintext_crc32c=True, verified_additional_authenticated_data_crc32c=True)

    def decrypt(self, request, timeout=None, retry=None):
        req = kms_types.DecryptRequest(request)
        self._record("decrypt", req, timeout, retry)
        if req.name not in self.keys:
            raise gexc.NotFound(req.name)
        ct, aad = bytes(req.ciphertext), bytes(req.additional_authenticated_data)
        if req.ciphertext_crc32c != crc32c(ct) or \
                req.additional_authenticated_data_crc32c != crc32c(aad):
            raise gexc.InvalidArgument("crc32c mismatch")
        try:
            pt = AESGCM(self.keys[req.name]).decrypt(ct[4:16], ct[16:], aad)
        except InvalidTag:
            raise gexc.InvalidArgument("Decryption failed: the ciphertext is invalid.")
        return kms_types.DecryptResponse(plaintext=pt, plaintext_crc32c=crc32c(pt))

    def __getattr__(self, item):
        raise AssertionError(f"unexpected KMS call: {item}")


@pytest.fixture
def fake_kms(monkeypatch):
    for k, v in GCP_ENV.items():
        monkeypatch.setenv(k, v)
    fake = FakeKms()
    provider = vm.get_kms_provider("gcpkms")
    assert isinstance(provider, vm.GcpKmsProvider)
    provider._client = fake  # inject: no credentials, no network
    return fake


async def _gcp_keyed_customer(db, fake) -> tuple[int, str]:
    """A customer with an existing gcpkms key row + KMS key (as after a
    deposit) — written directly, so nothing here can create a key."""
    cid = await _new_customer(db)
    name = f"{KEYRING}/cryptoKeys/vm-cust-{cid}"
    fake.add_key(name)
    async with db.pool.acquire() as c:
        await c.execute("INSERT INTO voicemail_customer_keys (customer_id, provider, key_ref) "
                        "VALUES ($1::int, 'gcpkms', $2::text)", cid, name)
    return cid, name


def test_gcp_wrap_and_unwrap_carry_the_transcript_aad(vm_db, fake_kms, no_key_creation):
    async def go():
        cid, name = await _gcp_keyed_customer(vm_db, fake_kms)
        u = str(uuid.uuid4())
        blob = await _seal(cid, 7, u)
        assert blob.kek_version == f"{name}/cryptoKeyVersions/1"
        assert await _open(cid, 7, u, blob) == DOC
        aad = vm.transcript_aad(cid, 7, u)
        (m1, enc, e_timeout, e_retry), (m2, dec, d_timeout, d_retry) = fake_kms.calls
        assert (m1, m2) == ("encrypt", "decrypt")
        assert enc.name == name and dec.name == name
        assert enc.additional_authenticated_data == aad == dec.additional_authenticated_data
        assert enc.additional_authenticated_data_crc32c == crc32c(aad)
        assert len(enc.plaintext) == 32 and dec.ciphertext == blob.wrapped_dek
        assert (e_timeout, e_retry, d_timeout, d_retry) == (5.0, None, 5.0, None)
        # KMS enforces the AAD itself: the audio AAD of the same message fails there.
        provider = vm.get_kms_provider()
        with pytest.raises(vm.VoicemailIntegrityError):
            await provider.unwrap_dek(customer_id=cid, key_ref=name,
                                      wrapped_dek=blob.wrapped_dek,
                                      aad=vm.message_aad(cid, 7, u))
        with pytest.raises(vm.VoicemailIntegrityError):
            await _open(cid, 8, u, blob)                  # another mailbox

    _run(go())


def test_gcp_kms_outage_fails_closed(vm_db, fake_kms):
    async def go():
        cid, _ = await _gcp_keyed_customer(vm_db, fake_kms)
        u = str(uuid.uuid4())
        blob = await _seal(cid, 9, u)
        fake_kms.fail["encrypt"] = [gexc.ServiceUnavailable("down")] * 3
        with pytest.raises(vm.VoicemailCryptoUnavailable):
            await _seal(cid, 9, u)
        fake_kms.fail["decrypt"] = [gexc.PermissionDenied("no")]
        with pytest.raises(vm.VoicemailCryptoUnavailable):
            await _open(cid, 9, u, blob)
        assert len([c for c in fake_kms.calls if c[0] == "encrypt"]) == 4  # 1 ok + 3 tries

    _run(go())


def test_gcp_seal_without_a_key_row_makes_no_kms_call(vm_db, fake_kms, no_key_creation):
    async def go():
        cid = await _new_customer(vm_db)
        with pytest.raises(vm.VoicemailIntegrityError):
            await _seal(cid, 10, str(uuid.uuid4()))
        assert fake_kms.calls == [], "no create_crypto_key, no encrypt"
        assert await _key_rows(vm_db, cid) == (0, 0)

    _run(go())
