"""POST /v1/voicemail/fs/deposit-sealed — East-outage voicemail replay
(Visual IVR plan D11 / §7.5, contract docs/IVR_INTERFACES.md §8.4;
services/voicemail/sealed.py + spool_crypto.py + deposit.py Mode).

On the shared harness (real routers + JWT middleware + ephemeral PG 16 with
54 + 56; local KMS + memory object store). Blobs are sealed by the openssl CLI
with EXACTLY the flags lib/vm_spool.lua uses (``openssl cms -encrypt -binary
-aes-256-gcm -keyid -outform DER -recip <cert> -keyopt rsa_padding_mode:oaep
-keyopt rsa_oaep_md:sha256 -keyopt rsa_mgf1_md:sha256``) around the same
``CRAGVMS1`` frame; the Lua harness pins the command string, the local docker
E2E runs the real FreeSWITCH-image OpenSSL 3.0.x.

Proves:
  * round trip: sealed -> 201 stored; decrypts through the playback path to
    the SAME WAV bytes (sha256); created_at == received_at (the inbox shows
    the original time, sorted among live deposits), expires_at counts from it
    (never < 1 day from now); the ``deposit`` audit row says via=spool;
  * idempotency: the same blob twice -> 200 duplicate, one row, one object;
    a message the live deposit already stored -> 200 duplicate; a purged row
    that WAS stored -> 200 duplicate (never resurrected); a purged row that
    was never stored (an orphaned failed attempt swept by retention) is
    taken over and stored; a live lease -> 503;
  * 410 + ``spool_drop`` audit (no caller PII in it): mailbox deleted,
    mailbox full, mailbox suspended, longer than the mailbox allows;
  * 422: tampered ciphertext / mac / content key, truncated or garbage blob,
    a frame that is not CRAGVMS1, sealed metadata != X-VM-Meta, a non-WAV
    payload, bad X-VM-Meta, wrong Content-Type, oversized body, an absurd
    received_at — and nothing is stored;
  * 503 (the forwarder keeps the file): key unset, key too small, blob
    sealed to a key the API does not hold; rotation: two keys in the bundle
    open blobs sealed to either;
  * 401 without the ingest secret (no route leak).

Run:  JWT_SECRET_KEY=x python -m pytest tests/test_voicemail_outage_sealed.py -q
"""
from __future__ import annotations

import base64
import hashlib
import json
import shutil
import subprocess
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from voicemail_api_harness import (
    CUST_A,
    INGEST_SECRET,
    Harness,
    make_wav,
    memory_store,
)

PORT = 55500  # distinct from every other test module (voicemail 55470-55499)

OPENSSL = shutil.which("openssl")
ENV_KEY = "VOICEMAIL_SPOOL_PRIVATE_KEY_B64"
OAEP = ["-keyopt", "rsa_padding_mode:oaep", "-keyopt", "rsa_oaep_md:sha256",
        "-keyopt", "rsa_mgf1_md:sha256"]

_dids = iter(range(1000, 9999))


def new_did() -> str:
    return f"+1617555{next(_dids):04d}"


# ---------------------------------------------------------------------------
# Keys + the FS-side seal (openssl CLI, vm_spool.lua flags)
# ---------------------------------------------------------------------------
class Keys:
    def __init__(self, root: Path):
        self.root = root
        self.n = 0

    def make(self, bits: int = 3072) -> tuple[Path, Path]:
        self.n += 1
        key = self.root / f"k{self.n}.pem"
        cert = self.root / f"c{self.n}.pem"
        subprocess.run([OPENSSL, "genpkey", "-algorithm", "RSA", "-pkeyopt",
                        f"rsa_keygen_bits:{bits}", "-out", str(key)], check=True,
                       capture_output=True)
        subprocess.run([OPENSSL, "req", "-new", "-x509", "-key", str(key), "-subj",
                        f"/CN=crag-vm-spool-test-{self.n}", "-days", "30", "-out", str(cert)],
                       check=True, capture_output=True)
        return key, cert

    def seal(self, frame: bytes, certs: list[Path]) -> bytes:
        self.n += 1
        inp, out = self.root / f"f{self.n}.bin", self.root / f"o{self.n}.der"
        inp.write_bytes(frame)
        cmd = [OPENSSL, "cms", "-encrypt", "-binary", "-aes-256-gcm", "-keyid", "-outform", "DER",
               "-in", str(inp), "-out", str(out)]
        for c in certs:
            cmd += ["-recip", str(c), *OAEP]
        subprocess.run(cmd, check=True, capture_output=True)
        inp.unlink()
        data = out.read_bytes()
        out.unlink()
        return data


def env_of(*keys: Path) -> str:
    return base64.b64encode(b"".join(k.read_bytes() for k in keys)).decode()


@pytest.fixture(scope="module")
def keys(tmp_path_factory):
    if OPENSSL is None:
        pytest.skip("openssl CLI not found")
    k = Keys(tmp_path_factory.mktemp("vmspool"))
    try:
        k.k1, k.c1 = k.make()
        k.k2, k.c2 = k.make()
        k.k_other, k.c_other = k.make()
        k.k_small, k.c_small = k.make(2048)
        probe = k.seal(b"CRAGVMS1-PROBE", [k.c1])
    except subprocess.CalledProcessError as e:  # LibreSSL / pre-3.0 OpenSSL
        pytest.skip(f"openssl cannot build CMS AuthEnvelopedData: {e.stderr[:200]!r}")
    if b"\x06\x0b\x2a\x86\x48\x86\xf7\x0d\x01\x09\x10\x01\x17" not in probe[:32]:
        pytest.skip("openssl did not produce AuthEnvelopedData")
    return k


@pytest.fixture(scope="module")
def h(keys):
    harness = Harness(PORT).start()
    try:
        yield harness
    finally:
        harness.stop()


@pytest.fixture(autouse=True)
def _fresh(h, keys, monkeypatch):
    from services.voicemail import spool_crypto
    h.reset_caches()
    spool_crypto.reset_key_cache()
    monkeypatch.setenv(ENV_KEY, env_of(keys.k1))
    yield
    from services.voicemail import deposit
    assert deposit.deposit_limiter.in_use == 0, "a deposit slot leaked"
    spool_crypto.reset_key_cache()


@pytest.fixture
def box(h):
    return h.run(h.create_mailbox(CUST_A, new_did()))


# ---------------------------------------------------------------------------
# Request builders (the forwarder's request; lib/vm_box.lua's META)
# ---------------------------------------------------------------------------
def iso(ts: datetime) -> str:
    return ts.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def smeta(box: dict, *, msg_uuid: str | None = None, received_at: datetime | None = None,
          **over) -> dict:
    m = {"v": 1, "msg_uuid": msg_uuid or str(uuid.uuid4()), "mailbox_id": box["id"],
         "did": box["did"], "caller_number": "+15085551212", "caller_name": "Jane Caller",
         "received_at": iso(received_at or datetime.now(timezone.utc) - timedelta(hours=2)),
         "duration_ms": 2000, "zone": "west"}
    m.update(over)
    return {k: v for k, v in m.items() if v is not None}


def meta_bytes(meta: dict) -> bytes:
    # lib/json.lua: sorted keys, compact
    return json.dumps(meta, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def frame(meta: dict, wav: bytes, *, meta_override: bytes | None = None) -> bytes:
    mb = meta_override if meta_override is not None else meta_bytes(meta)
    return b"CRAGVMS1\n" + str(len(mb)).encode() + b"\n" + mb + wav


def header_of(meta: dict) -> str:
    return base64.urlsafe_b64encode(meta_bytes(meta)).decode().rstrip("=")


async def post(h, blob: bytes, meta: dict | None, *, raw_meta: str | None = None,
               secret: str | None = INGEST_SECRET, content_type: str = "application/octet-stream"):
    headers = {"Content-Type": content_type}
    if secret is not None:
        headers["X-Ingest-Secret"] = secret
    if raw_meta is not None:
        headers["X-VM-Meta"] = raw_meta
    elif meta is not None:
        headers["X-VM-Meta"] = header_of(meta)
    return await h.client.post("/v1/voicemail/fs/deposit-sealed", headers=headers, content=blob)


def sealed(keys, meta: dict, wav: bytes, certs=None) -> bytes:
    return keys.seal(frame(meta, wav), certs or [keys.c1])


async def row(h, msg_uuid: str):
    rows = await h.fetch("SELECT * FROM voicemail_messages WHERE msg_uuid = $1::uuid", msg_uuid)
    return rows[0] if rows else None


async def audits(h, action: str, msg_uuid: str):
    return await h.fetch("SELECT * FROM voicemail_access_log WHERE action = $1 "
                         "AND detail->>'msg_uuid' = $2 ORDER BY id", action, msg_uuid)


def path_of(url: str) -> str:
    return url[len("/api"):] if url.startswith("/api/") else url


# ===========================================================================
# Round trip
# ===========================================================================
def test_round_trip_stored_201_same_audio_original_time(h, keys, box):
    async def go():
        wav = make_wav(3.0)
        received = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(hours=5)
        meta = smeta(box, received_at=received, duration_ms=3000)
        r = await post(h, sealed(keys, meta, wav), meta)
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["status"] == "stored" and isinstance(body["message_id"], int)
        mid = body["message_id"]

        m = await row(h, meta["msg_uuid"])
        assert m["status"] == "stored" and m["id"] == mid
        assert m["created_at"] == received, "inbox must show the ORIGINAL time"
        # 90 calendar days in the DB session time zone (same arithmetic as a
        # live deposit's now() + retention_days): +/- 1 h across a DST change.
        assert abs(m["expires_at"] - (received + timedelta(days=90))) <= timedelta(hours=1)
        assert m["caller_id_number"] == "+15085551212" and m["caller_id_name"] == "Jane Caller"
        assert m["zone"] == "west" and m["call_uuid"] is None and m["fs_node"] is None
        assert m["duration_ms"] == 3000 and m["size_bytes"] == len(wav)

        a = await audits(h, "deposit", meta["msg_uuid"])
        assert len(a) == 1 and a[0]["message_id"] == mid and a[0]["source"] == "freeswitch"
        detail = json.loads(a[0]["detail"])
        assert detail["via"] == "spool" and detail["received_at"] == received.isoformat()

        # Through the real playback path: decrypts to the very same bytes.
        r = await h.client.post(f"/v1/voicemail/messages/{mid}/playback-token",
                                headers=h.auth("user_a"), json={})
        assert r.status_code == 200, r.text
        r = await h.client.get(path_of(r.json()["url"]))
        assert r.status_code == 200, r.text
        assert hashlib.sha256(r.content).hexdigest() == hashlib.sha256(wav).hexdigest()

        # Sorted among live deposits by the original time (newest first).
        live = await h.deposit_ok(box["id"])
        r = await h.client.get(f"/v1/voicemail/mailboxes/{box['id']}/messages",
                               headers=h.auth("user_a"))
        ids = [x["id"] for x in r.json()["items"]]
        assert ids == [live, mid]
    h.run(go())


def test_recipient_order_and_rotation(h, keys, box, monkeypatch):
    from services.voicemail import spool_crypto

    async def go():
        wav = make_wav(1.5)
        # Sealed to current + next (the rotation window), API holds only next.
        monkeypatch.setenv(ENV_KEY, env_of(keys.k2))
        spool_crypto.reset_key_cache()
        meta = smeta(box)
        r = await post(h, sealed(keys, meta, wav, [keys.c1, keys.c2]), meta)
        assert r.status_code == 201, r.text
        # The API holds BOTH keys; a blob sealed to either opens.
        monkeypatch.setenv(ENV_KEY, env_of(keys.k1, keys.k2))
        spool_crypto.reset_key_cache()
        for certs in ([keys.c1], [keys.c2]):
            meta = smeta(box)
            r = await post(h, sealed(keys, meta, wav, certs), meta)
            assert r.status_code == 201, r.text
    h.run(go())


def test_expires_at_never_less_than_a_day(h, keys, box):
    async def go():
        await h.execute("UPDATE voicemail_boxes SET retention_days = 1 WHERE id = $1", box["id"])
        received = datetime.now(timezone.utc) - timedelta(days=6)
        meta = smeta(box, received_at=received)
        r = await post(h, sealed(keys, meta, make_wav(1.2)), meta)
        assert r.status_code == 201, r.text
        m = await row(h, meta["msg_uuid"])
        assert m["created_at"] == received.replace(microsecond=0)
        left = m["expires_at"] - datetime.now(timezone.utc)
        assert timedelta(hours=23) < left <= timedelta(days=1, minutes=1)
    h.run(go())


def test_future_received_at_is_clamped_to_now(h, keys, box):
    async def go():
        meta = smeta(box, received_at=datetime.now(timezone.utc) + timedelta(hours=3))
        r = await post(h, sealed(keys, meta, make_wav(1.2)), meta)
        assert r.status_code == 201, r.text
        m = await row(h, meta["msg_uuid"])
        assert abs(m["created_at"] - datetime.now(timezone.utc)) < timedelta(minutes=1)
    h.run(go())


# ===========================================================================
# Idempotency
# ===========================================================================
def test_replay_twice_is_one_message(h, keys, box):
    async def go():
        meta = smeta(box)
        blob = sealed(keys, meta, make_wav(2.0))
        r1 = await post(h, blob, meta)
        r2 = await post(h, blob, meta)
        assert r1.status_code == 201, r1.text
        assert r2.status_code == 200, r2.text
        assert r2.json() == {"status": "duplicate", "message_id": r1.json()["message_id"]}
        n = await h.fetchval("SELECT count(*) FROM voicemail_messages WHERE msg_uuid = $1::uuid",
                             meta["msg_uuid"])
        assert n == 1
        assert len(await audits(h, "deposit", meta["msg_uuid"])) == 1
        keys_in_store = [k for k in memory_store()._objects if meta["msg_uuid"] in k]
        assert len(keys_in_store) == 1
    h.run(go())


def test_already_stored_by_the_live_deposit_is_duplicate(h, keys, box):
    async def go():
        msg_uuid = str(uuid.uuid4())
        live = await h.deposit_ok(box["id"], msg_uuid=msg_uuid)
        meta = smeta(box, msg_uuid=msg_uuid)
        r = await post(h, sealed(keys, meta, make_wav(2.0)), meta)
        assert r.status_code == 200 and r.json() == {"status": "duplicate", "message_id": live}
    h.run(go())


def test_purged_after_delivery_is_never_resurrected(h, keys, box):
    async def go():
        meta = smeta(box)
        blob = sealed(keys, meta, make_wav(2.0))
        mid = (await post(h, blob, meta)).json()["message_id"]
        r = await h.client.delete(f"/v1/voicemail/messages/{mid}/purge", headers=h.auth("user_a"))
        assert r.status_code == 204, r.text
        r = await post(h, blob, meta)
        assert r.status_code == 200 and r.json()["status"] == "duplicate", r.text
        assert (await row(h, meta["msg_uuid"]))["status"] == "purged"
    h.run(go())


def test_never_stored_purged_row_is_taken_over(h, keys, box):
    """The live deposit claimed the row, KMS failed ('failed'), FS sealed it,
    the retention worker purged the orphan: the replay must still deliver."""
    async def go():
        meta = smeta(box)
        await h.execute(
            "INSERT INTO voicemail_messages (msg_uuid, mailbox_id, customer_id, size_bytes, status,"
            " expires_at, purged_at, created_at) VALUES ($1::uuid, $2, $3, 10, 'purged',"
            " now() + interval '1 day', now(), now() - interval '20 minutes')",
            meta["msg_uuid"], box["id"], CUST_A)
        r = await post(h, sealed(keys, meta, make_wav(2.0)), meta)
        assert r.status_code == 201, r.text
        m = await row(h, meta["msg_uuid"])
        assert m["status"] == "stored" and m["purged_at"] is None
        assert m["created_at"] == datetime.fromisoformat(meta["received_at"])
    h.run(go())


def test_failed_row_is_taken_over_and_redated(h, keys, box):
    async def go():
        meta = smeta(box)
        await h.execute(
            "INSERT INTO voicemail_messages (msg_uuid, mailbox_id, customer_id, size_bytes, status,"
            " expires_at) VALUES ($1::uuid, $2, $3, 10, 'failed', now() + interval '1 day')",
            meta["msg_uuid"], box["id"], CUST_A)
        r = await post(h, sealed(keys, meta, make_wav(2.0)), meta)
        assert r.status_code == 201, r.text
        m = await row(h, meta["msg_uuid"])
        assert m["status"] == "stored"
        assert m["created_at"] == datetime.fromisoformat(meta["received_at"])
    h.run(go())


def test_live_lease_is_503(h, keys, box):
    async def go():
        meta = smeta(box)
        await h.execute(
            "INSERT INTO voicemail_messages (msg_uuid, mailbox_id, customer_id, size_bytes, status,"
            " expires_at, deposit_attempt_id, deposit_lease_until) VALUES ($1::uuid, $2, $3, 10,"
            " 'pending', now() + interval '1 day', gen_random_uuid(), now() + interval '30 seconds')",
            meta["msg_uuid"], box["id"], CUST_A)
        r = await post(h, sealed(keys, meta, make_wav(2.0)), meta)
        assert r.status_code == 503 and r.headers.get("retry-after") == "2", r.text
    h.run(go())


# ===========================================================================
# 410 dropped + audited
# ===========================================================================
def _assert_dropped(h, r, meta, reason, customer_id):
    async def go():
        assert r.status_code == 410, r.text
        assert r.json()["detail"] == f"dropped: {reason}"
        assert await row(h, meta["msg_uuid"]) is None
        a = await audits(h, "spool_drop", meta["msg_uuid"])
        assert len(a) == 1, a
        assert a[0]["customer_id"] == customer_id and a[0]["mailbox_id"] == meta["mailbox_id"]
        assert a[0]["source"] == "freeswitch"
        detail = json.loads(a[0]["detail"])
        assert detail["reason"] == reason and detail["zone"] == "west"
        assert detail["received_at"] == datetime.fromisoformat(meta["received_at"]).isoformat()
        flat = json.dumps(detail)
        assert "5085551212" not in flat and "Jane" not in flat, "no caller PII in the audit"
    h.run(go())


def test_deleted_mailbox_410_audited(h, keys, box):
    meta = smeta(box)
    blob = sealed(keys, meta, make_wav(2.0))
    r = h.run(h.client.delete(f"/v1/voicemail/mailboxes/{box['id']}", headers=h.auth("admin")))
    assert r.status_code == 204, r.text
    _assert_dropped(h, h.run(post(h, blob, meta)), meta, "mailbox_deleted", CUST_A)


def test_full_mailbox_410_audited(h, keys, box):
    h.run(h.deposit_ok(box["id"]))
    h.run(h.execute("UPDATE voicemail_boxes SET max_messages = 1 WHERE id = $1", box["id"]))
    meta = smeta(box)
    _assert_dropped(h, h.run(post(h, sealed(keys, meta, make_wav(2.0)), meta)), meta,
                    "not_accepting_full", CUST_A)


def test_suspended_mailbox_410_audited(h, keys, box):
    h.run(h.execute("UPDATE voicemail_boxes SET status = 'suspended' WHERE id = $1", box["id"]))
    meta = smeta(box)
    _assert_dropped(h, h.run(post(h, sealed(keys, meta, make_wav(2.0)), meta)), meta,
                    "not_accepting_inactive", CUST_A)


def test_longer_than_the_mailbox_allows_410(h, keys, box):
    h.run(h.execute("UPDATE voicemail_boxes SET max_message_seconds = 10 WHERE id = $1", box["id"]))
    meta = smeta(box, duration_ms=20000)
    _assert_dropped(h, h.run(post(h, sealed(keys, meta, make_wav(20.0)), meta)), meta,
                    "too_long", CUST_A)


def test_drop_audit_failure_is_503_not_410(h, keys, box, monkeypatch):
    from services.voicemail import audit

    async def boom(*a, **k):
        raise RuntimeError("audit table unavailable")
    h.run(h.client.delete(f"/v1/voicemail/mailboxes/{box['id']}", headers=h.auth("admin")))
    meta = smeta(box)
    monkeypatch.setattr(audit, "write_audit", boom)
    r = h.run(post(h, sealed(keys, meta, make_wav(2.0)), meta))
    assert r.status_code == 503, r.text   # never dropped without its audit row


# ===========================================================================
# 422 bad blob / bad meta (nothing stored)
# ===========================================================================
def test_tampered_blobs_are_422(h, keys, box):
    async def go():
        meta = smeta(box)
        blob = sealed(keys, meta, make_wav(2.0))
        cases = {
            "ciphertext": lambda b: b[:-200] + bytes([b[-200] ^ 1]) + b[-199:],
            "mac": lambda b: b[:-1] + bytes([b[-1] ^ 1]),
            "truncated": lambda b: b[:-50],
            "trailing": lambda b: b + b"\x00",
            "garbage": lambda b: b"\x30\x03\x02\x01\x00",
            "empty": lambda b: b"",
        }
        for name, mutate in cases.items():
            r = await post(h, mutate(blob), meta)
            assert r.status_code == 422, (name, r.text)
            assert r.json()["detail"].startswith("bad_blob: "), (name, r.text)
        # the content key of OUR recipient
        from services.voicemail import spool_crypto
        parsed = spool_crypto._parse(memoryview(blob))
        ek = parsed.recipients[0].encrypted_key
        at = blob.find(ek)
        bad_ek = blob[:at + 10] + bytes([blob[at + 10] ^ 1]) + blob[at + 11:]
        r = await post(h, bad_ek, meta)
        assert r.status_code == 422 and "content key" in r.json()["detail"], r.text
        assert await row(h, meta["msg_uuid"]) is None
    h.run(go())


def test_frame_and_metadata_binding_422(h, keys, box):
    async def go():
        wav = make_wav(2.0)
        meta = smeta(box)
        # sealed content is not a frame
        r = await post(h, keys.seal(wav, [keys.c1]), meta)
        assert r.status_code == 422 and "CRAGVMS1" in r.json()["detail"], r.text
        # sidecar edited to point at another mailbox / caller: refused
        blob = sealed(keys, meta, wav)
        for change in ({"mailbox_id": box["id"] + 1000}, {"caller_number": "+19995550000"},
                       {"received_at": iso(datetime.now(timezone.utc))}, {"extra": 1}):
            edited = dict(meta, **change)
            r = await post(h, blob, edited)
            assert r.status_code == 422, (change, r.text)
        # a sealed payload that is not a WAV
        r = await post(h, keys.seal(frame(meta, b"x" * 2000), [keys.c1]), meta)
        assert r.status_code == 422 and r.json()["detail"].startswith("bad_blob: "), r.text
        # malformed frame length
        bad = b"CRAGVMS1\n0012\n" + meta_bytes(meta) + wav
        r = await post(h, keys.seal(bad, [keys.c1]), meta)
        assert r.status_code == 422, r.text
        assert await row(h, meta["msg_uuid"]) is None
    h.run(go())


def test_bad_meta_content_type_and_size_422(h, keys, box):
    async def go():
        meta = smeta(box)
        blob = sealed(keys, meta, make_wav(2.0))
        for raw in ("", "!!!", "e30", header_of(dict(meta, v=2)),
                    header_of({k: v for k, v in meta.items() if k != "received_at"}),
                    header_of(dict(meta, received_at="2026-10-25T10:00:00")),       # no zone
                    header_of(dict(meta, received_at="2026-10-25T10:00:00+02:00")),  # not UTC
                    header_of(dict(meta, mailbox_id=True)),
                    header_of(dict(meta, caller_name="x" * 101))):
            r = await post(h, blob, None, raw_meta=raw)
            assert r.status_code == 422 and r.json()["detail"].startswith("bad_meta: "), (raw, r.text)
        r = await post(h, blob, meta, content_type="audio/wav")
        assert r.status_code == 422 and "Content-Type" in r.json()["detail"], r.text
        too_old = smeta(box, received_at=datetime.now(timezone.utc) - timedelta(days=40))
        r = await post(h, sealed(keys, too_old, make_wav(1.2)), too_old)
        assert r.status_code == 422 and "older" in r.json()["detail"], r.text
        from services.voicemail import sealed as vm_sealed
        r = await h.client.post(
            "/v1/voicemail/fs/deposit-sealed",
            headers={"X-Ingest-Secret": INGEST_SECRET, "X-VM-Meta": header_of(meta),
                     "Content-Type": "application/octet-stream",
                     "Content-Length": str(vm_sealed.SEALED_BODY_CAP + 1)},
            content=b"x" * (vm_sealed.SEALED_BODY_CAP + 1))
        assert r.status_code == 422, r.text
        assert await row(h, meta["msg_uuid"]) is None
    h.run(go())


# ===========================================================================
# 503 (kept by the forwarder) / 401
# ===========================================================================
def test_key_unset_or_unusable_is_503(h, keys, box, monkeypatch):
    from services.voicemail import spool_crypto

    async def go():
        meta = smeta(box)
        blob = sealed(keys, meta, make_wav(2.0))
        for value in (None, "not base64 !!", base64.b64encode(b"no pem here").decode(),
                      env_of(keys.k_small)):
            if value is None:
                monkeypatch.delenv(ENV_KEY, raising=False)
            else:
                monkeypatch.setenv(ENV_KEY, value)
            spool_crypto.reset_key_cache()
            r = await post(h, blob, meta)
            assert r.status_code == 503 and r.headers.get("retry-after") == "2", (value, r.text)
        # sealed only to a key the API does not hold
        monkeypatch.setenv(ENV_KEY, env_of(keys.k1))
        spool_crypto.reset_key_cache()
        r = await post(h, sealed(keys, meta, make_wav(2.0), [keys.c_other]), meta)
        assert r.status_code == 503, r.text
        assert await row(h, meta["msg_uuid"]) is None
        # ...and the same message delivers once the key is right
        r = await post(h, blob, meta)
        assert r.status_code == 201, r.text
    h.run(go())


def test_ingest_secret_required(h, keys, box):
    async def go():
        meta = smeta(box)
        blob = sealed(keys, meta, make_wav(2.0))
        r = await post(h, blob, meta, secret=None)
        assert r.status_code == 401, r.text
        r = await post(h, blob, meta, secret="x" * 40)
        assert r.status_code == 401, r.text
        assert await row(h, meta["msg_uuid"]) is None
    h.run(go())
