"""Encrypted-voicemail crypto/KMS/storage layer (services/voicemail).

Two halves, both on an ephemeral PostgreSQL built from the REAL init scripts +
migration 54 (key rows and the key_create audit row are real), with the API
pool connected as the runtime `api` role:

LOCAL (LocalKmsProvider + MemoryObjectStore, dev/CI mode):
  round trip; key created once + audited; UUID canonicalisation; wrong AAD,
  blob swapped between mailboxes / customers, full row swap, ciphertext tamper,
  CRC mismatches -> VoicemailIntegrityError; simulated rotation (old versions
  still decrypt); crypto-erase -> unrecoverable + idempotent; local provider
  and memory store refused without VOICEMAIL_ALLOW_LOCAL_KMS (and under
  ENV=production); DEK buffers zeroed; fail-closed config/DB errors.

CLOUD (GcpKmsProvider / GcsObjectStore against in-process fakes that use the
REAL google.cloud.kms request/response types, so a wrong field name fails):
  AAD + CRC32C sent and checked on encrypt/decrypt; response tamper ->
  integrity error; per-customer key created once with the contract settings
  (SOFTWARE, ENCRYPT_DECRYPT, 365 d rotation, 24 h destroy window);
  AlreadyExists handled; CryptoKeyVersion recorded as kek_version; rotation;
  bounded retries (5 s timeout, retry=None to the library, 3 attempts on
  UNAVAILABLE); erase destroys every ENABLED/DISABLED version, THEN clears the
  rotation schedule (failure = warning only); impersonated credentials; GCS
  upload/download CRC32C, idempotent delete, and NO bucket-metadata calls
  (the runtime SA has no storage.buckets.get).

No network, no credentials: nothing here contacts Google Cloud.

Run:  JWT_SECRET_KEY=x python3 -m pytest tests/test_voicemail_crypto.py -q
"""
import asyncio
import base64
import logging
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

from voicemail_db import EphemeralPG, apply_54, apply_prerequisites, find_pg_bin  # noqa: E402

from services import voicemail as vm  # noqa: E402
from services.voicemail import _gcp, kms as vm_kms, storage as vm_storage  # noqa: E402
from services.voicemail._crc import crc32c  # noqa: E402

PG_BIN = find_pg_bin()
PORT = 55471  # distinct from every other test module (migration-54 suite = 55470)

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
    # The GCS half is exercised separately; seal/open here keep the memory store.
    "VOICEMAIL_ALLOW_LOCAL_KMS": "true",
    "VOICEMAIL_STORAGE": "memory",
}
_ALL_VM_ENV = set(LOCAL_ENV) | set(GCP_ENV) | {
    "VOICEMAIL_IMPERSONATE_SA", "VOICEMAIL_BUCKET", "ENV", "ENVIRONMENT"}


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
            await apply_54(owner)
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


async def _new_customer(db) -> int:
    async with db.pool.acquire() as c:
        return await c.fetchval(
            "INSERT INTO customers (name, account_type) VALUES ($1::varchar, 'rcf') RETURNING id",
            f"vm-test-{uuid.uuid4().hex[:8]}")


def _msg(cid, mbox, msg_uuid=None):
    u = msg_uuid or str(uuid.uuid4())
    return u, vm.message_object_key(cid, mbox, u), vm.message_aad(cid, mbox, u)


async def _seal_msg(cid, mbox, payload, msg_uuid=None):
    u, key, aad = _msg(cid, mbox, msg_uuid)
    sealed = await vm.seal_and_store(customer_id=cid, object_key=key, aad=aad, plaintext=payload)
    return u, aad, sealed


async def _open(cid, aad, sealed, *, object_key=None, wrapped_dek=None, iv=None, crc=None):
    return await vm.load_and_open(
        customer_id=cid, object_key=object_key or sealed.object_key, aad=aad,
        wrapped_dek=sealed.wrapped_dek if wrapped_dek is None else wrapped_dek,
        iv=sealed.iv if iv is None else iv,
        ciphertext_crc32c=sealed.ciphertext_crc32c if crc is None else crc)


def _memory_store() -> vm_storage.MemoryObjectStore:
    store = vm.get_object_store()
    assert isinstance(store, vm_storage.MemoryObjectStore)
    return store


WAV = b"RIFF" + os.urandom(4096)


# ===========================================================================
# Builders
# ===========================================================================
def test_aad_and_object_key_builders():
    u = "6F9619FF-8B86-D011-B42D-00C04FC964FF"
    assert vm.message_aad(3, 7, u) == b"vm:3:7:6f9619ff-8b86-d011-b42d-00c04fc964ff"
    assert vm.greeting_aad(3, 7, u) == b"vmg:3:7:6f9619ff-8b86-d011-b42d-00c04fc964ff"
    assert vm.message_object_key(3, 7, u) == "c/3/mb/7/m/6f9619ff-8b86-d011-b42d-00c04fc964ff.enc"
    assert vm.greeting_object_key(3, 7, uuid.UUID(u)) == \
        "c/3/mb/7/g/6f9619ff-8b86-d011-b42d-00c04fc964ff.enc"
    for bad in ((0, 1, u), (1, -1, u), (True, 1, u), (1, 1, "not-a-uuid"), ("1", 1, u)):
        with pytest.raises(ValueError):
            vm.message_aad(*bad)


# ===========================================================================
# LOCAL provider + memory store
# ===========================================================================
def test_round_trip_message_and_greeting(vm_db, local_env):
    async def go():
        cid = await _new_customer(vm_db)
        u, aad, sealed = await _seal_msg(cid, 11, WAV)
        assert isinstance(sealed, vm.Sealed)
        assert sealed.object_key == f"c/{cid}/mb/11/m/{u}.enc"
        assert sealed.enc_algo == "AES-256-GCM"
        assert len(sealed.iv) == 12
        assert sealed.kek_version == f"local:{cid}/v1"
        stored = _memory_store().raw(sealed.object_key)
        assert stored is not None and WAV not in stored and len(stored) == len(WAV) + 16
        assert sealed.ciphertext_crc32c == crc32c(stored)
        assert await _open(cid, aad, sealed) == WAV

        g = str(uuid.uuid4())
        gkey, gaad = vm.greeting_object_key(cid, 11, g), vm.greeting_aad(cid, 11, g)
        gs = await vm.seal_and_store(customer_id=cid, object_key=gkey, aad=gaad, plaintext=b"greeting")
        assert await vm.load_and_open(customer_id=cid, object_key=gkey, aad=gaad,
                                      wrapped_dek=gs.wrapped_dek, iv=gs.iv,
                                      ciphertext_crc32c=gs.ciphertext_crc32c) == b"greeting"
        # A fresh DEK + IV per object.
        assert gs.wrapped_dek != sealed.wrapped_dek and gs.iv != sealed.iv

    _run(go())


def test_key_created_once_and_audited(vm_db, local_env):
    async def go():
        cid = await _new_customer(vm_db)
        k1 = await vm.ensure_customer_key(cid)
        await _seal_msg(cid, 1, b"a")
        await _seal_msg(cid, 2, b"b")
        k2 = await vm.ensure_customer_key(cid)
        assert k1 == k2 and k1.provider == "local" and k1.key_ref == f"local:{cid}" and k1.active
        async with vm_db.pool.acquire() as c:
            assert await c.fetchval(
                "SELECT count(*) FROM voicemail_customer_keys WHERE customer_id = $1::int", cid) == 1
            audit = await c.fetch(
                "SELECT action, source, detail FROM voicemail_access_log "
                "WHERE customer_id = $1::int", cid)
        assert [(a["action"], a["source"]) for a in audit] == [("key_create", "system")]
        assert '"local"' in audit[0]["detail"]

    _run(go())


def test_concurrent_first_use_creates_one_key_row(vm_db, local_env):
    async def go():
        cid = await _new_customer(vm_db)
        keys = await asyncio.gather(*(vm.ensure_customer_key(cid) for _ in range(5)))
        assert len({k.key_ref for k in keys}) == 1
        async with vm_db.pool.acquire() as c:
            assert await c.fetchval(
                "SELECT count(*) FROM voicemail_access_log WHERE customer_id = $1::int "
                "AND action = 'key_create'", cid) == 1

    _run(go())


def test_uuid_canonicalisation_upper_seal_lower_open(vm_db, local_env):
    async def go():
        cid = await _new_customer(vm_db)
        upper = str(uuid.uuid4()).upper()
        _, aad_upper, sealed = await _seal_msg(cid, 5, WAV, msg_uuid=upper)
        # Playback rebuilds from the DB's uuid column (asyncpg -> uuid.UUID).
        db_uuid = uuid.UUID(upper)
        assert await _open(cid, vm.message_aad(cid, 5, db_uuid), sealed,
                           object_key=vm.message_object_key(cid, 5, db_uuid)) == WAV
        assert aad_upper == vm.message_aad(cid, 5, db_uuid)

    _run(go())


def test_wrong_aad_is_rejected(vm_db, local_env):
    async def go():
        cid = await _new_customer(vm_db)
        u, aad, sealed = await _seal_msg(cid, 21, WAV)
        # AAD naming another mailbox / message / kind than the object key.
        for wrong in (vm.message_aad(cid, 22, u), vm.message_aad(cid, 21, str(uuid.uuid4())),
                      vm.greeting_aad(cid, 21, u), b"vm:garbage"):
            with pytest.raises(vm.VoicemailIntegrityError):
                await _open(cid, wrong, sealed)
        # The KEK layer itself is AAD-bound (not only our pre-check).
        provider = vm.get_kms_provider("local")
        key = await vm.ensure_customer_key(cid)
        with pytest.raises(vm.VoicemailIntegrityError):
            await provider.unwrap_dek(customer_id=cid, key_ref=key.key_ref,
                                      wrapped_dek=sealed.wrapped_dek,
                                      aad=vm.message_aad(cid, 22, u))
        assert await _open(cid, aad, sealed) == WAV

    _run(go())


def test_blob_swapped_between_mailboxes(vm_db, local_env):
    async def go():
        cid = await _new_customer(vm_db)
        store = _memory_store()
        ua, aad_a, a = await _seal_msg(cid, 31, b"mailbox A secret audio")
        ub, aad_b, b = await _seal_msg(cid, 32, b"mailbox B audio.......")

        # 1) Object bytes of A copied over B's object (store-consistent copy):
        #    B's row CRC no longer matches -> never served.
        store.replace_raw(b.object_key, store.raw(a.object_key), keep_stored_crc=False)
        with pytest.raises(vm.VoicemailIntegrityError):
            await _open(cid, aad_b, b)

        # 2) Full swap: A's object AND A's crypto fields on B's row (CRC
        #    consistent) — B's AAD makes both the KEK unwrap and GCM fail.
        with pytest.raises(vm.VoicemailIntegrityError):
            await _open(cid, aad_b, a, object_key=b.object_key)

        # A is untouched.
        assert await _open(cid, aad_a, a) == b"mailbox A secret audio"

    _run(go())


def test_blob_swapped_between_customers(vm_db, local_env):
    async def go():
        c1 = await _new_customer(vm_db)
        c2 = await _new_customer(vm_db)
        store = _memory_store()
        u1, aad1, s1 = await _seal_msg(c1, 41, b"customer one")
        u2, aad2, s2 = await _seal_msg(c2, 42, b"customer two")
        store.replace_raw(s2.object_key, store.raw(s1.object_key), keep_stored_crc=False)
        with pytest.raises(vm.VoicemailIntegrityError):
            await _open(c2, aad2, s1, object_key=s2.object_key)
        # Customer 2 cannot open customer 1's row with its own identity.
        with pytest.raises(vm.VoicemailIntegrityError):
            await _open(c2, aad1, s1)

    _run(go())


def test_ciphertext_tamper_with_consistent_crc(vm_db, local_env):
    async def go():
        cid = await _new_customer(vm_db)
        store = _memory_store()
        u, aad, sealed = await _seal_msg(cid, 51, WAV)
        tampered = bytearray(store.raw(sealed.object_key))
        tampered[100] ^= 0x01
        store.replace_raw(sealed.object_key, bytes(tampered), keep_stored_crc=False)
        # An attacker who can also rewrite the row's CRC still hits the GCM tag.
        with pytest.raises(vm.VoicemailIntegrityError):
            await _open(cid, aad, sealed, crc=crc32c(bytes(tampered)))

    _run(go())


def test_crc_mismatches(vm_db, local_env):
    async def go():
        cid = await _new_customer(vm_db)
        store = _memory_store()
        u, aad, sealed = await _seal_msg(cid, 61, WAV)
        # Row CRC disagrees with the stored object.
        with pytest.raises(vm.VoicemailIntegrityError):
            await _open(cid, aad, sealed, crc=(sealed.ciphertext_crc32c + 1) % 2**32)
        # Object rotted in the store (store checksum fails).
        rotted = bytearray(store.raw(sealed.object_key))
        rotted[0] ^= 0xFF
        store.replace_raw(sealed.object_key, bytes(rotted), keep_stored_crc=True)
        with pytest.raises(vm.VoicemailIntegrityError):
            await _open(cid, aad, sealed)
        # Malformed row data.
        with pytest.raises(vm.VoicemailIntegrityError):
            await _open(cid, aad, sealed, iv=b"\x00" * 11)
        with pytest.raises(vm.VoicemailIntegrityError):
            await _open(cid, aad, sealed, crc=-1)

    _run(go())


def test_rotation_old_versions_still_decrypt(vm_db, local_env):
    async def go():
        cid = await _new_customer(vm_db)
        _, aad1, s1 = await _seal_msg(cid, 71, b"before rotation")
        provider = vm.get_kms_provider()
        assert isinstance(provider, vm.LocalKmsProvider)
        assert provider.rotate() == 2
        _, aad2, s2 = await _seal_msg(cid, 71, b"after rotation")
        assert s1.kek_version == f"local:{cid}/v1"
        assert s2.kek_version == f"local:{cid}/v2"
        assert await _open(cid, aad1, s1) == b"before rotation"
        assert await _open(cid, aad2, s2) == b"after rotation"

    _run(go())


def test_crypto_erase_makes_data_unrecoverable(vm_db, local_env):
    async def go():
        cid = await _new_customer(vm_db)
        _, aad, sealed = await _seal_msg(cid, 81, WAV)
        result = await vm.crypto_erase_customer(cid)
        assert result["status"] == "destroyed" and result["already_destroyed"] is False
        assert result["provider"] == "local" and result["key_ref"] == f"local:{cid}"
        async with vm_db.pool.acquire() as c:
            row = await c.fetchrow(
                "SELECT status, destroyed_at FROM voicemail_customer_keys WHERE customer_id = $1::int",
                cid)
        assert row["status"] == "destroyed" and row["destroyed_at"] is not None
        with pytest.raises(vm.VoicemailKeyDestroyed):
            await _open(cid, aad, sealed)
        with pytest.raises(vm.VoicemailKeyDestroyed):
            await _seal_msg(cid, 81, WAV)
        with pytest.raises(vm.VoicemailKeyDestroyed):
            await vm.ensure_customer_key(cid)
        assert issubclass(vm.VoicemailKeyDestroyed, vm.VoicemailCryptoUnavailable)
        again = await vm.crypto_erase_customer(cid)
        assert again["already_destroyed"] is True and again["status"] == "destroyed"
        # A customer that never had voicemail.
        other = await _new_customer(vm_db)
        none = await vm.crypto_erase_customer(other)
        assert none["status"] == "no_key" and none["versions_destroyed"] == []

    _run(go())


def test_local_provider_refused_without_allow_flag(vm_db, monkeypatch):
    for k, v in LOCAL_ENV.items():
        if k != "VOICEMAIL_ALLOW_LOCAL_KMS":
            monkeypatch.setenv(k, v)

    async def go():
        cid = await _new_customer(vm_db)
        with pytest.raises(vm.VoicemailCryptoUnavailable):
            vm.get_kms_provider("local")
        with pytest.raises(vm.VoicemailCryptoUnavailable):
            vm.get_object_store()  # memory store also needs the flag
        with pytest.raises(vm.VoicemailCryptoUnavailable):
            await _seal_msg(cid, 1, WAV)
        with pytest.raises(vm.VoicemailCryptoUnavailable):
            await vm.ensure_customer_key(cid)
        async with vm_db.pool.acquire() as c:
            assert await c.fetchval(
                "SELECT count(*) FROM voicemail_customer_keys WHERE customer_id = $1::int", cid) == 0

    _run(go())


def test_local_refused_in_production_even_with_flag(local_env, monkeypatch):
    for env_name in ("ENV", "ENVIRONMENT"):
        monkeypatch.setenv(env_name, "production")
        vm_kms.reset_kms_providers()
        vm_storage.reset_object_stores()
        with pytest.raises(vm.VoicemailCryptoUnavailable):
            vm.get_kms_provider("local")
        with pytest.raises(vm.VoicemailCryptoUnavailable):
            vm.get_object_store()
        monkeypatch.delenv(env_name)


def test_allow_flag_rechecked_after_provider_cached(local_env, monkeypatch):
    assert isinstance(vm.get_kms_provider(), vm.LocalKmsProvider)
    monkeypatch.setenv("VOICEMAIL_ALLOW_LOCAL_KMS", "false")
    with pytest.raises(vm.VoicemailCryptoUnavailable):
        vm.get_kms_provider()


def test_local_master_key_must_be_32_bytes(local_env, monkeypatch):
    for bad in ("", "not base64!!", base64.b64encode(b"short").decode()):
        monkeypatch.setenv("VOICEMAIL_LOCAL_MASTER_KEY", bad)
        vm_kms.reset_kms_providers()
        with pytest.raises(vm.VoicemailCryptoUnavailable):
            vm.get_kms_provider()


def test_gcpkms_missing_or_bad_config_fails_closed(monkeypatch):
    monkeypatch.setenv("VOICEMAIL_KMS_PROVIDER", "gcpkms")
    with pytest.raises(vm.VoicemailCryptoUnavailable):
        vm.get_kms_provider()  # no project
    monkeypatch.setenv("VOICEMAIL_KMS_PROJECT", "bad/project")
    with pytest.raises(vm.VoicemailCryptoUnavailable):
        vm.get_kms_provider()
    monkeypatch.setenv("VOICEMAIL_KMS_PROJECT", GCP_PROJECT)
    monkeypatch.setenv("VOICEMAIL_KMS_KEYRING", "ring/../other")
    with pytest.raises(vm.VoicemailCryptoUnavailable):
        vm.get_kms_provider()
    monkeypatch.setenv("VOICEMAIL_KMS_PROVIDER", "aws")
    with pytest.raises(vm.VoicemailCryptoUnavailable):
        vm.get_kms_provider()
    monkeypatch.setenv("VOICEMAIL_STORAGE", "s3")
    with pytest.raises(vm.VoicemailCryptoUnavailable):
        vm.get_object_store()
    monkeypatch.setenv("VOICEMAIL_STORAGE", "gcs")
    monkeypatch.setenv("VOICEMAIL_BUCKET", "Bad_Bucket!")
    with pytest.raises(vm.VoicemailCryptoUnavailable):
        vm.get_object_store()


def test_missing_object_and_idempotent_delete(vm_db, local_env):
    async def go():
        cid = await _new_customer(vm_db)
        _, aad, sealed = await _seal_msg(cid, 91, WAV)
        await vm.delete_object(sealed.object_key)
        await vm.delete_object(sealed.object_key)  # idempotent
        with pytest.raises(vm.VoicemailObjectNotFound):
            await _open(cid, aad, sealed)
        assert issubclass(vm.VoicemailObjectNotFound, vm.VoicemailIntegrityError)
        with pytest.raises(ValueError):
            await vm.delete_object("../../etc/passwd")

    _run(go())


def test_seal_argument_errors(vm_db, local_env):
    async def go():
        cid = await _new_customer(vm_db)
        other = await _new_customer(vm_db)
        u, key, aad = _msg(cid, 1)
        bad_calls = [
            dict(customer_id=other, object_key=key, aad=aad, plaintext=WAV),          # wrong customer
            dict(customer_id=cid, object_key=key, aad=vm.message_aad(cid, 2, u), plaintext=WAV),
            dict(customer_id=cid, object_key=key, aad=vm.greeting_aad(cid, 1, u), plaintext=WAV),
            dict(customer_id=cid, object_key="c/1/../x.enc", aad=aad, plaintext=WAV),
            dict(customer_id=cid, object_key=key, aad=aad, plaintext=b""),
            dict(customer_id=cid, object_key=key, aad=aad, plaintext="str"),
            dict(customer_id=0, object_key=key, aad=aad, plaintext=WAV),
        ]
        for kwargs in bad_calls:
            with pytest.raises(ValueError):
                await vm.seal_and_store(**kwargs)
        assert _memory_store().keys() == []

    _run(go())


def test_unknown_customer_creates_nothing(vm_db, local_env):
    async def go():
        u, key, aad = _msg(987654, 1)
        with pytest.raises(LookupError):
            await vm.seal_and_store(customer_id=987654, object_key=key, aad=aad, plaintext=WAV)
        async with vm_db.pool.acquire() as c:
            assert await c.fetchval(
                "SELECT count(*) FROM voicemail_customer_keys WHERE customer_id = 987654") == 0

    _run(go())


def test_dek_buffers_are_zeroed(vm_db, local_env, monkeypatch):
    seen = []
    provider = vm.get_kms_provider()
    real_wrap, real_unwrap = provider.wrap_dek, provider.unwrap_dek

    async def spy_wrap(**kw):
        seen.append(("wrap", kw["dek"]))
        return await real_wrap(**kw)

    async def spy_unwrap(**kw):
        dek = await real_unwrap(**kw)
        seen.append(("unwrap", dek))
        return dek

    monkeypatch.setattr(provider, "wrap_dek", spy_wrap)
    monkeypatch.setattr(provider, "unwrap_dek", spy_unwrap)

    async def go():
        cid = await _new_customer(vm_db)
        _, aad, sealed = await _seal_msg(cid, 3, WAV)
        assert await _open(cid, aad, sealed) == WAV

    _run(go())
    assert [s[0] for s in seen] == ["wrap", "unwrap"]
    for _, buf in seen:
        assert isinstance(buf, bytearray) and len(buf) == 32 and not any(buf)


def test_database_unavailable_fails_closed(vm_db, local_env, monkeypatch):
    monkeypatch.setattr(vm_db, "pool", None)

    async def go():
        u, key, aad = _msg(1, 1)
        with pytest.raises(vm.VoicemailCryptoUnavailable):
            await vm.seal_and_store(customer_id=1, object_key=key, aad=aad, plaintext=WAV)

    _run(go())


# ===========================================================================
# Cloud KMS fake (real google.cloud.kms types)
# ===========================================================================
kms_types = pytest.importorskip("google.cloud.kms", reason="google-cloud-kms required")
gexc = pytest.importorskip("google.api_core.exceptions")
from cryptography.exceptions import InvalidTag  # noqa: E402
from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: E402

VState = kms_types.CryptoKeyVersion.CryptoKeyVersionState


class FakeKms:
    """In-memory Cloud KMS with the server-side CRC32C semantics."""

    def __init__(self):
        self.keys = {}
        self.calls = []
        self.fail = {}
        self.tamper = {}

    def _record(self, method, req, timeout, retry):
        self.calls.append((method, req, timeout, retry))
        queue = self.fail.get(method)
        if queue:
            raise queue.pop(0)

    def calls_of(self, method):
        return [c for c in self.calls if c[0] == method]

    def _add_version(self, name):
        k = self.keys[name]
        n = len(k["versions"]) + 1
        k["versions"].append({"name": f"{name}/cryptoKeyVersions/{n}",
                              "state": VState.ENABLED, "key": os.urandom(32)})
        k["primary"] = n - 1

    def rotate(self, name):
        self._add_version(name)

    def _key(self, name):
        k = self.keys[name]
        p = k["versions"][k["primary"]]
        return kms_types.CryptoKey(
            name=name, purpose=k["purpose"],
            primary=kms_types.CryptoKeyVersion(name=p["name"], state=p["state"]))

    # -- RPCs ---------------------------------------------------------------
    def create_crypto_key(self, request, timeout=None, retry=None):
        req = kms_types.CreateCryptoKeyRequest(request)
        self._record("create_crypto_key", req, timeout, retry)
        name = f"{req.parent}/cryptoKeys/{req.crypto_key_id}"
        if name in self.keys:
            raise gexc.AlreadyExists(f"{name} already exists")
        self.keys[name] = {"purpose": req.crypto_key.purpose, "versions": [], "rotation": True}
        self._add_version(name)
        return self._key(name)

    def get_crypto_key(self, request, timeout=None, retry=None):
        req = kms_types.GetCryptoKeyRequest(request)
        self._record("get_crypto_key", req, timeout, retry)
        if req.name not in self.keys:
            raise gexc.NotFound(req.name)
        return self._key(req.name)

    def encrypt(self, request, timeout=None, retry=None):
        req = kms_types.EncryptRequest(request)
        self._record("encrypt", req, timeout, retry)
        k = self.keys.get(req.name)
        if k is None:
            raise gexc.NotFound(req.name)
        p = k["versions"][k["primary"]]
        if p["state"] != VState.ENABLED:
            raise gexc.FailedPrecondition("primary version not enabled")
        pt, aad = bytes(req.plaintext), bytes(req.additional_authenticated_data)
        v_pt = v_aad = False
        if "plaintext_crc32c" in req:
            if req.plaintext_crc32c != crc32c(pt):
                raise gexc.InvalidArgument("plaintext_crc32c mismatch")
            v_pt = True
        if "additional_authenticated_data_crc32c" in req:
            if req.additional_authenticated_data_crc32c != crc32c(aad):
                raise gexc.InvalidArgument("aad crc32c mismatch")
            v_aad = True
        nonce = os.urandom(12)
        ct = struct.pack(">I", k["primary"]) + nonce + AESGCM(p["key"]).encrypt(nonce, pt, aad)
        resp = kms_types.EncryptResponse(
            name=p["name"], ciphertext=ct, ciphertext_crc32c=crc32c(ct),
            verified_plaintext_crc32c=v_pt, verified_additional_authenticated_data_crc32c=v_aad)
        mode = self.tamper.pop("encrypt", None)
        if mode == "ciphertext_crc":
            resp.ciphertext_crc32c = (crc32c(ct) + 1) % 2**32
        elif mode == "unverified_plaintext":
            resp.verified_plaintext_crc32c = False
        elif mode == "unverified_aad":
            resp.verified_additional_authenticated_data_crc32c = False
        elif mode == "foreign_version":
            resp.name = f"{KEYRING}/cryptoKeys/vm-cust-999999/cryptoKeyVersions/1"
        return resp

    def decrypt(self, request, timeout=None, retry=None):
        req = kms_types.DecryptRequest(request)
        self._record("decrypt", req, timeout, retry)
        k = self.keys.get(req.name)
        if k is None:
            raise gexc.NotFound(req.name)
        ct, aad = bytes(req.ciphertext), bytes(req.additional_authenticated_data)
        if "ciphertext_crc32c" in req and req.ciphertext_crc32c != crc32c(ct):
            raise gexc.InvalidArgument("ciphertext_crc32c mismatch")
        if "additional_authenticated_data_crc32c" in req and \
                req.additional_authenticated_data_crc32c != crc32c(aad):
            raise gexc.InvalidArgument("aad crc32c mismatch")
        idx = struct.unpack(">I", ct[:4])[0]
        if idx >= len(k["versions"]):
            raise gexc.InvalidArgument("Decryption failed: the ciphertext is invalid.")
        v = k["versions"][idx]
        if v["state"] != VState.ENABLED:
            raise gexc.FailedPrecondition(f"{v['name']} is not enabled")
        try:
            pt = AESGCM(v["key"]).decrypt(ct[4:16], ct[16:], aad)
        except InvalidTag:
            raise gexc.InvalidArgument("Decryption failed: the ciphertext is invalid.")
        resp = kms_types.DecryptResponse(plaintext=pt, plaintext_crc32c=crc32c(pt),
                                         used_primary=(idx == k["primary"]))
        if self.tamper.pop("decrypt", None) == "plaintext_crc":
            resp.plaintext_crc32c = (crc32c(pt) + 1) % 2**32
        return resp

    def list_crypto_key_versions(self, request, timeout=None, retry=None):
        req = kms_types.ListCryptoKeyVersionsRequest(request)
        self._record("list_crypto_key_versions", req, timeout, retry)
        if req.parent not in self.keys:
            raise gexc.NotFound(req.parent)
        return [kms_types.CryptoKeyVersion(name=v["name"], state=v["state"])
                for v in self.keys[req.parent]["versions"]]

    def destroy_crypto_key_version(self, request, timeout=None, retry=None):
        req = kms_types.DestroyCryptoKeyVersionRequest(request)
        self._record("destroy_crypto_key_version", req, timeout, retry)
        for k in self.keys.values():
            for v in k["versions"]:
                if v["name"] == req.name:
                    if v["state"] not in (VState.ENABLED, VState.DISABLED):
                        raise gexc.FailedPrecondition("not destroyable")
                    v["state"] = VState.DESTROY_SCHEDULED
                    return kms_types.CryptoKeyVersion(name=v["name"], state=v["state"])
        raise gexc.NotFound(req.name)

    def update_crypto_key(self, request, timeout=None, retry=None):
        req = kms_types.UpdateCryptoKeyRequest(request)
        self._record("update_crypto_key", req, timeout, retry)
        name = req.crypto_key.name
        if name not in self.keys:
            raise gexc.NotFound(name)
        paths = set(req.update_mask.paths)
        if {"rotation_period", "next_rotation_time"} <= paths and \
                "rotation_period" not in req.crypto_key and "next_rotation_time" not in req.crypto_key:
            self.keys[name]["rotation"] = False
        return self._key(name)

    # Anything else (version create/enable/disable/restore, IAM reads) is NOT
    # granted to the runtime SA — calling it must fail the test.
    def __getattr__(self, item):
        raise AssertionError(f"unexpected KMS call: {item}")


@pytest.fixture
def gcp_env(monkeypatch):
    for k, v in GCP_ENV.items():
        monkeypatch.setenv(k, v)


@pytest.fixture
def fake_kms(gcp_env):
    fake = FakeKms()
    provider = vm.get_kms_provider("gcpkms")
    assert isinstance(provider, vm.GcpKmsProvider)
    provider._client = fake  # inject: no credentials, no network
    return fake


def _key_name(cid):
    return f"{KEYRING}/cryptoKeys/vm-cust-{cid}"


def test_gcp_provider_construction_needs_no_credentials(gcp_env, monkeypatch):
    import google.auth

    def boom(*a, **k):
        raise AssertionError("credentials must be built lazily")

    monkeypatch.setattr(google.auth, "default", boom)
    provider = vm.get_kms_provider()
    assert isinstance(provider, vm.GcpKmsProvider) and provider._client is None


def test_gcp_key_created_once_with_contract_settings(vm_db, fake_kms):
    async def go():
        cid = await _new_customer(vm_db)
        k1 = await vm.ensure_customer_key(cid)
        k2 = await vm.ensure_customer_key(cid)
        _, _, sealed = await _seal_msg(cid, 1, WAV)
        assert k1 == k2 and k1.provider == "gcpkms" and k1.key_ref == _key_name(cid)
        creates = fake_kms.calls_of("create_crypto_key")
        assert len(creates) == 1, "the KMS key is created exactly once"
        _, req, timeout, retry = creates[0]
        assert req.parent == KEYRING and req.crypto_key_id == f"vm-cust-{cid}"
        ck = req.crypto_key
        assert ck.purpose == kms_types.CryptoKey.CryptoKeyPurpose.ENCRYPT_DECRYPT
        assert ck.version_template.protection_level == kms_types.ProtectionLevel.SOFTWARE
        assert ck.version_template.algorithm == \
            kms_types.CryptoKeyVersion.CryptoKeyVersionAlgorithm.GOOGLE_SYMMETRIC_ENCRYPTION
        assert ck.rotation_period.days == 365
        assert ck.destroy_scheduled_duration.days == 1 and ck.destroy_scheduled_duration.seconds == 0
        assert "next_rotation_time" in ck
        assert timeout == 5.0 and retry is None
        assert sealed.kek_version == f"{_key_name(cid)}/cryptoKeyVersions/1"

    _run(go())


def test_gcp_already_exists_is_handled(fake_kms):
    async def go():
        provider = vm.get_kms_provider()
        name1 = await provider.ensure_key(501)
        name2 = await provider.ensure_key(501)   # KMS says AlreadyExists -> get
        assert name1 == name2 == _key_name(501)
        assert len(fake_kms.calls_of("create_crypto_key")) == 2
        assert len(fake_kms.calls_of("get_crypto_key")) == 1
        assert len(fake_kms.keys) == 1

    _run(go())


def test_gcp_existing_key_without_enabled_primary_is_refused(fake_kms):
    async def go():
        provider = vm.get_kms_provider()
        await provider.ensure_key(502)
        fake_kms.keys[_key_name(502)]["versions"][0]["state"] = VState.DESTROY_SCHEDULED
        with pytest.raises(vm.VoicemailCryptoUnavailable):
            await provider.ensure_key(502)

    _run(go())


def test_gcp_encrypt_and_decrypt_send_aad_and_crc32c(vm_db, fake_kms):
    async def go():
        cid = await _new_customer(vm_db)
        _, aad, sealed = await _seal_msg(cid, 7, WAV)
        assert await _open(cid, aad, sealed) == WAV
        (_, enc, e_timeout, e_retry), = fake_kms.calls_of("encrypt")
        assert enc.name == _key_name(cid)
        assert enc.additional_authenticated_data == aad
        assert enc.additional_authenticated_data_crc32c == crc32c(aad)
        assert len(enc.plaintext) == 32 and enc.plaintext_crc32c == crc32c(enc.plaintext)
        assert e_timeout == 5.0 and e_retry is None
        (_, dec, d_timeout, d_retry), = fake_kms.calls_of("decrypt")
        assert dec.name == _key_name(cid)
        assert dec.ciphertext == sealed.wrapped_dek
        assert dec.ciphertext_crc32c == crc32c(sealed.wrapped_dek)
        assert dec.additional_authenticated_data == aad
        assert dec.additional_authenticated_data_crc32c == crc32c(aad)
        assert d_timeout == 5.0 and d_retry is None

    _run(go())


@pytest.mark.parametrize("mode", ["ciphertext_crc", "unverified_plaintext", "unverified_aad",
                                  "foreign_version"])
def test_gcp_encrypt_response_integrity(vm_db, fake_kms, mode):
    async def go():
        cid = await _new_customer(vm_db)
        await vm.ensure_customer_key(cid)
        fake_kms.tamper["encrypt"] = mode
        with pytest.raises(vm.VoicemailIntegrityError):
            await _seal_msg(cid, 8, WAV)
        assert _memory_store().keys() == [], "nothing is uploaded when the wrap is not trusted"

    _run(go())


def test_gcp_decrypt_integrity(vm_db, fake_kms):
    async def go():
        cid = await _new_customer(vm_db)
        u, aad, sealed = await _seal_msg(cid, 9, WAV)
        fake_kms.tamper["decrypt"] = "plaintext_crc"
        with pytest.raises(vm.VoicemailIntegrityError):
            await _open(cid, aad, sealed)
        # KMS itself enforces the AAD: unwrap under another mailbox's AAD.
        provider = vm.get_kms_provider()
        with pytest.raises(vm.VoicemailIntegrityError):
            await provider.unwrap_dek(customer_id=cid, key_ref=_key_name(cid),
                                      wrapped_dek=sealed.wrapped_dek,
                                      aad=vm.message_aad(cid, 10, u))
        assert await _open(cid, aad, sealed) == WAV

    _run(go())


def test_gcp_rotation_records_version_and_old_versions_decrypt(vm_db, fake_kms):
    async def go():
        cid = await _new_customer(vm_db)
        _, aad1, s1 = await _seal_msg(cid, 12, b"v1 audio")
        fake_kms.rotate(_key_name(cid))
        _, aad2, s2 = await _seal_msg(cid, 12, b"v2 audio")
        assert s1.kek_version.endswith("/cryptoKeyVersions/1")
        assert s2.kek_version.endswith("/cryptoKeyVersions/2")
        assert await _open(cid, aad1, s1) == b"v1 audio"
        assert await _open(cid, aad2, s2) == b"v2 audio"

    _run(go())


def test_gcp_key_ref_of_another_customer_rejected(fake_kms):
    async def go():
        provider = vm.get_kms_provider()
        await provider.ensure_key(601)
        with pytest.raises(vm.VoicemailIntegrityError):
            await provider.wrap_dek(customer_id=602, key_ref=_key_name(601),
                                    dek=bytearray(32), aad=b"vm:602:1:x")
        assert fake_kms.calls_of("encrypt") == []

    _run(go())


def test_gcp_retries_are_bounded(fake_kms):
    async def go():
        provider = vm.get_kms_provider()
        await provider.ensure_key(701)
        aad = vm.message_aad(701, 1, str(uuid.uuid4()))

        fake_kms.fail["encrypt"] = [gexc.ServiceUnavailable("x"), gexc.DeadlineExceeded("y")]
        wrapped, version = await provider.wrap_dek(customer_id=701, key_ref=_key_name(701),
                                                   dek=bytearray(os.urandom(32)), aad=aad)
        assert len(fake_kms.calls_of("encrypt")) == 3 and version.endswith("/1")

        fake_kms.calls.clear()
        fake_kms.fail["encrypt"] = [gexc.ServiceUnavailable("x")] * 5
        with pytest.raises(vm.VoicemailCryptoUnavailable):
            await provider.wrap_dek(customer_id=701, key_ref=_key_name(701),
                                    dek=bytearray(32), aad=aad)
        assert len(fake_kms.calls_of("encrypt")) == 3

        fake_kms.calls.clear()
        fake_kms.fail["encrypt"] = [gexc.PermissionDenied("no")]
        with pytest.raises(vm.VoicemailCryptoUnavailable):
            await provider.wrap_dek(customer_id=701, key_ref=_key_name(701),
                                    dek=bytearray(32), aad=aad)
        assert len(fake_kms.calls_of("encrypt")) == 1, "non-transient errors are not retried"

    _run(go())


def test_gcp_destroy_iterates_versions_then_clears_rotation(fake_kms):
    async def go():
        provider = vm.get_kms_provider()
        name = await provider.ensure_key(801)
        for _ in range(3):
            fake_kms.rotate(name)
        versions = fake_kms.keys[name]["versions"]
        versions[1]["state"] = VState.DISABLED
        versions[2]["state"] = VState.DESTROYED
        fake_kms.calls.clear()
        destroyed = await provider.destroy_key(customer_id=801, key_ref=name)
        assert destroyed == [f"{name}/cryptoKeyVersions/1", f"{name}/cryptoKeyVersions/2",
                             f"{name}/cryptoKeyVersions/4"]
        assert all(v["state"] in (VState.DESTROY_SCHEDULED, VState.DESTROYED) for v in versions)
        methods = [c[0] for c in fake_kms.calls]
        assert methods == ["list_crypto_key_versions", "destroy_crypto_key_version",
                           "destroy_crypto_key_version", "destroy_crypto_key_version",
                           "list_crypto_key_versions", "update_crypto_key"], methods
        (_, upd, timeout, retry), = fake_kms.calls_of("update_crypto_key")
        assert upd.crypto_key.name == name
        assert list(upd.update_mask.paths) == ["rotation_period", "next_rotation_time"]
        assert "rotation_period" not in upd.crypto_key
        assert fake_kms.keys[name]["rotation"] is False
        for _, _, t, r in fake_kms.calls:
            assert t == 5.0 and r is None
        # Idempotent: nothing left to destroy, rotation re-cleared.
        assert await provider.destroy_key(customer_id=801, key_ref=name) == []

    _run(go())


def test_gcp_rotation_clear_failure_is_only_a_warning(fake_kms, caplog):
    async def go():
        provider = vm.get_kms_provider()
        name = await provider.ensure_key(802)
        fake_kms.fail["update_crypto_key"] = [gexc.PermissionDenied("no cryptoKeys.update")]
        with caplog.at_level(logging.WARNING):
            destroyed = await provider.destroy_key(customer_id=802, key_ref=name)
        assert destroyed == [f"{name}/cryptoKeyVersions/1"]
        assert fake_kms.keys[name]["versions"][0]["state"] == VState.DESTROY_SCHEDULED
        assert any("rotation schedule" in r.getMessage() for r in caplog.records)

    _run(go())


def test_gcp_destroy_of_missing_key_is_noop(fake_kms):
    async def go():
        provider = vm.get_kms_provider()
        assert await provider.destroy_key(customer_id=803, key_ref=None) == []
        assert fake_kms.calls_of("update_crypto_key") == []

    _run(go())


def test_gcp_crypto_erase_end_to_end(vm_db, fake_kms):
    async def go():
        cid = await _new_customer(vm_db)
        _, aad, sealed = await _seal_msg(cid, 13, WAV)
        fake_kms.rotate(_key_name(cid))
        result = await vm.crypto_erase_customer(cid)
        assert result["status"] == "destroyed" and result["provider"] == "gcpkms"
        assert result["versions_destroyed"] == [f"{_key_name(cid)}/cryptoKeyVersions/1",
                                                f"{_key_name(cid)}/cryptoKeyVersions/2"]
        assert fake_kms.keys[_key_name(cid)]["rotation"] is False
        with pytest.raises(vm.VoicemailKeyDestroyed):
            await _open(cid, aad, sealed)
        # Even bypassing the DB status, KMS no longer unwraps the DEK.
        provider = vm.get_kms_provider()
        with pytest.raises(vm.VoicemailCryptoUnavailable):
            await provider.unwrap_dek(customer_id=cid, key_ref=_key_name(cid),
                                      wrapped_dek=sealed.wrapped_dek, aad=aad)
        again = await vm.crypto_erase_customer(cid)
        assert again["already_destroyed"] is True and again["versions_destroyed"] == []

    _run(go())


def test_gcp_crypto_erase_orphan_key_without_row(vm_db, fake_kms):
    async def go():
        cid = await _new_customer(vm_db)
        await vm.get_kms_provider().ensure_key(cid)   # KMS key exists, row never written
        result = await vm.crypto_erase_customer(cid)
        assert result["status"] == "destroyed"
        assert result["versions_destroyed"] == [f"{_key_name(cid)}/cryptoKeyVersions/1"]
        key = await vm.get_customer_key(cid)
        assert key is not None and key.status == "destroyed" and key.key_ref == _key_name(cid)
        with pytest.raises(vm.VoicemailKeyDestroyed):
            await vm.ensure_customer_key(cid)

    _run(go())


def test_gcp_kms_outage_fails_closed_and_persists_nothing(vm_db, fake_kms):
    async def go():
        cid = await _new_customer(vm_db)
        fake_kms.fail["create_crypto_key"] = [gexc.ServiceUnavailable("down")] * 3
        with pytest.raises(vm.VoicemailCryptoUnavailable):
            await vm.ensure_customer_key(cid)
        assert await vm.get_customer_key(cid) is None
        await vm.ensure_customer_key(cid)
        fake_kms.fail["encrypt"] = [gexc.ServiceUnavailable("down")] * 3
        with pytest.raises(vm.VoicemailCryptoUnavailable):
            await _seal_msg(cid, 1, WAV)
        assert _memory_store().keys() == []

    _run(go())


def test_impersonated_credentials(gcp_env, monkeypatch):
    import google.auth
    from google.auth import credentials as ga_credentials
    from google.auth import impersonated_credentials

    class _Source(ga_credentials.Credentials):
        def refresh(self, request):  # pragma: no cover - never called
            raise AssertionError("no network in tests")

    calls = []

    def fake_default(scopes=None, **kw):
        calls.append(scopes)
        return _Source(), GCP_PROJECT

    monkeypatch.setattr(google.auth, "default", fake_default)
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", "")
    from services.voicemail.config import load_config

    monkeypatch.setenv("VOICEMAIL_IMPERSONATE_SA", "vm-api@test-project-123.iam.gserviceaccount.com")
    creds = _gcp.get_credentials(load_config())
    assert isinstance(creds, impersonated_credentials.Credentials)
    assert creds.service_account_email == "vm-api@test-project-123.iam.gserviceaccount.com"
    assert calls == [[_gcp.CLOUD_PLATFORM_SCOPE]]
    assert "GOOGLE_APPLICATION_CREDENTIALS" not in os.environ  # "" normalised to unset
    assert _gcp.get_credentials(load_config()) is creds  # cached

    monkeypatch.delenv("VOICEMAIL_IMPERSONATE_SA")
    plain = _gcp.get_credentials(load_config())
    assert isinstance(plain, _Source)

    monkeypatch.setenv("VOICEMAIL_IMPERSONATE_SA", "not-an-email")
    with pytest.raises(vm.VoicemailCryptoUnavailable):
        vm.get_kms_provider()


# ===========================================================================
# Cloud Storage fake
# ===========================================================================
class FakeBlob:
    def __init__(self, bucket, name):
        self.bucket, self.name = bucket, name
        self.crc32c = None
        self.size = None
        self.generation = None

    def _load(self):
        obj = self.bucket.objects.get(self.name)
        if obj is None:
            return False
        data, crc, gen = obj
        self.crc32c = base64.b64encode(crc.to_bytes(4, "big")).decode()
        self.size, self.generation = len(data), gen
        return True

    def upload_from_string(self, data, content_type=None, checksum=None, timeout=None, retry=None):
        self.bucket.record("upload", checksum=checksum, timeout=timeout, retry=retry,
                           content_type=content_type)
        server_crc = crc32c(data)
        if self.bucket.server_crc_skew:
            server_crc = (server_crc + 1) % 2**32
        self.bucket.gen += 1
        self.bucket.objects[self.name] = (bytes(data), server_crc, self.bucket.gen)
        self._load()

    def download_as_bytes(self, checksum=None, if_generation_match=None, timeout=None, retry=None):
        self.bucket.record("download", checksum=checksum, timeout=timeout, retry=retry,
                           if_generation_match=if_generation_match)
        if self.bucket.corrupt_download:
            from google.cloud.storage.exceptions import DataCorruption
            raise DataCorruption(None, "crc32c mismatch")
        data, _crc, gen = self.bucket.objects[self.name]
        assert if_generation_match == gen
        return data

    def delete(self, timeout=None, retry=None):
        self.bucket.record("delete", timeout=timeout, retry=retry)
        if self.name not in self.bucket.objects:
            raise gexc.NotFound(self.name)
        del self.bucket.objects[self.name]

    def reload(self, *a, **k):  # pragma: no cover
        raise AssertionError("blob.reload is not used")


class FakeBucket:
    def __init__(self, name):
        self.name = name
        self.objects = {}
        self.ops = []
        self.gen = 0
        self.server_crc_skew = False
        self.corrupt_download = False
        self.fail = {}

    def record(self, op, **kw):
        self.ops.append((op, kw))
        q = self.fail.get(op)
        if q:
            raise q.pop(0)

    def blob(self, name):
        return FakeBlob(self, name)

    def get_blob(self, name, timeout=None, retry=None):
        self.record("get_blob", timeout=timeout, retry=retry)
        b = FakeBlob(self, name)
        return b if b._load() else None

    def reload(self, *a, **k):
        raise AssertionError("bucket metadata calls need storage.buckets.get (not granted)")


class FakeStorageClient:
    def __init__(self):
        self.buckets = {}
        self.bucket_calls = []

    def bucket(self, name):
        self.bucket_calls.append(name)
        return self.buckets.setdefault(name, FakeBucket(name))

    def get_bucket(self, *a, **k):
        raise AssertionError("get_bucket needs storage.buckets.get (not granted)")

    def lookup_bucket(self, *a, **k):
        raise AssertionError("lookup_bucket needs storage.buckets.get (not granted)")


@pytest.fixture
def gcs(monkeypatch):
    monkeypatch.setenv("VOICEMAIL_STORAGE", "gcs")
    monkeypatch.setenv("VOICEMAIL_BUCKET", "voip-voicemail")
    monkeypatch.setenv("VOICEMAIL_KMS_PROJECT", GCP_PROJECT)
    store = vm.get_object_store()
    assert isinstance(store, vm.GcsObjectStore)
    client = FakeStorageClient()
    store._client = client
    return store, client


GKEY = vm.message_object_key(1, 2, str(uuid.uuid4()))


def test_gcs_put_get_delete_with_crc32c(gcs):
    store, client = gcs

    async def go():
        data = os.urandom(3000)
        await store.put(GKEY, data, crc32c=crc32c(data))
        bucket = client.buckets["voip-voicemail"]
        op, kw = bucket.ops[0]
        assert op == "upload" and kw["checksum"] == "crc32c" and kw["retry"] is None
        assert kw["timeout"] == (5.0, 20.0) and kw["content_type"] == "application/octet-stream"
        assert await store.get(GKEY) == data
        dl = [kw for op, kw in bucket.ops if op == "download"][0]
        assert dl["checksum"] == "crc32c" and dl["if_generation_match"] == 1 and dl["retry"] is None
        await store.delete(GKEY)
        await store.delete(GKEY)  # idempotent (NotFound swallowed)
        with pytest.raises(vm.VoicemailObjectNotFound):
            await store.get(GKEY)
        assert client.bucket_calls == ["voip-voicemail"], "bucket handle only, no metadata call"

    _run(go())


def test_gcs_put_rejects_wrong_caller_crc_and_server_mismatch(gcs):
    store, client = gcs

    async def go():
        data = b"ciphertext"
        with pytest.raises(vm.VoicemailIntegrityError):
            await store.put(GKEY, data, crc32c=crc32c(data) ^ 1)
        assert client.bucket_calls == []  # rejected before any I/O
        bucket = client.bucket("voip-voicemail")
        client.bucket_calls.clear()
        bucket.server_crc_skew = True
        with pytest.raises(vm.VoicemailIntegrityError):
            await store.put(GKEY, data, crc32c=crc32c(data))
        assert GKEY not in bucket.objects, "an object whose stored CRC32C differs is deleted"

    _run(go())


def test_gcs_get_integrity_checks(gcs):
    store, client = gcs

    async def go():
        data = b"x" * 100
        await store.put(GKEY, data, crc32c=crc32c(data))
        bucket = client.buckets["voip-voicemail"]
        # Bytes changed under an unchanged stored checksum.
        _, crc, gen = bucket.objects[GKEY]
        bucket.objects[GKEY] = (b"y" * 100, crc, gen)
        with pytest.raises(vm.VoicemailIntegrityError):
            await store.get(GKEY)
        # Library-level DataCorruption -> integrity error.
        bucket.objects[GKEY] = (data, crc32c(data), gen)
        bucket.corrupt_download = True
        with pytest.raises(vm.VoicemailIntegrityError):
            await store.get(GKEY)
        bucket.corrupt_download = False
        # Oversized object is refused before download.
        big = b"z" * (vm_storage.MAX_OBJECT_BYTES + 1)
        bucket.objects[GKEY] = (big, crc32c(big), gen)
        with pytest.raises(vm.VoicemailIntegrityError):
            await store.get(GKEY)

    _run(go())


def test_gcs_transient_errors_retried_then_fail_closed(gcs):
    store, client = gcs

    async def go():
        bucket = client.bucket("voip-voicemail")
        data = b"abc"
        bucket.fail["upload"] = [gexc.ServiceUnavailable("503"), gexc.TooManyRequests("429")]
        await store.put(GKEY, data, crc32c=crc32c(data))
        assert [op for op, _ in bucket.ops].count("upload") == 3
        bucket.ops.clear()
        bucket.fail["get_blob"] = [gexc.InternalServerError("500")] * 3
        with pytest.raises(vm.VoicemailCryptoUnavailable):
            await store.get(GKEY)
        assert [op for op, _ in bucket.ops].count("get_blob") == 3
        bucket.ops.clear()
        bucket.fail["delete"] = [gexc.Forbidden("no storage.objects.delete")]
        with pytest.raises(vm.VoicemailCryptoUnavailable):
            await store.delete(GKEY)
        assert [op for op, _ in bucket.ops].count("delete") == 1

    _run(go())


def test_object_key_layout_enforced(gcs):
    store, _ = gcs

    async def go():
        for bad in ("c/1/mb/2/m/../../x.enc", "c/1/mb/2/m/NOT-A-UUID.enc", "/c/1/mb/2/m/x.enc",
                    "c/0/mb/2/m/" + str(uuid.uuid4()) + ".enc"):
            with pytest.raises(ValueError):
                await store.put(bad, b"x", crc32c=crc32c(b"x"))
            with pytest.raises(ValueError):
                await store.get(bad)

    _run(go())
