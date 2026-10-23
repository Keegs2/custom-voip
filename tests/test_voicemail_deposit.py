"""FreeSWITCH -> API voicemail deposit (contract §5; services/voicemail/deposit.py).

On the shared harness (real routers + JWT middleware + ephemeral PG 16 with
migration 54; local KMS + memory object store).

Proves:
  * FS <-> API compatibility: the X-VM-Meta header is produced by the REAL
    FreeSWITCH Lua (lib/json.lua + lib/vm_deposit.lua + the meta-table block
    copied VERBATIM out of lib/vm_box.lua at test time) and the API's 200 body
    is classified "stored" (with message_id) by the real vm_deposit.classify;
  * idempotency on msg_uuid (stored -> same id, one object, one audit row),
    concurrent duplicates seal ONCE, live-lease 503, failed/expired-lease
    takeover, purged -> 409, foreign mailbox -> 409;
  * hardening: strict X-VM-Meta (junk chars, padding, bad base64, wrong
    types, duplicate keys, missing) -> 400; secret 401/503; Content-Type 415;
    413 by Content-Length and by streaming counter; WAV 415/422; duration cap;
    per-process concurrency 503 + Retry-After; deadline -> 503 with an
    extended lease (no immediate takeover); KMS down -> 503 + 'failed';
    audit failure -> 503 and never 'stored'; mailbox deleted mid-upload -> 404
    and the retention worker cleans up.

Run:  JWT_SECRET_KEY=x python -m pytest tests/test_voicemail_deposit.py -q
"""
import asyncio
import base64
import json
import re
import shutil
import struct
import subprocess
import uuid

import pytest

from voicemail_api_harness import (
    CUST_A,
    INGEST_SECRET,
    REPO,
    Harness,
    make_wav,
    memory_store,
    pcm_tone,
)

PORT = 55473

LIB = REPO / "docker" / "freeswitch" / "scripts" / "lib"
VM_BOX = LIB / "vm_box.lua"
LUA = shutil.which("lua") or shutil.which("lua5.4") or shutil.which("lua5.3")

_dids = iter(range(3000, 9999))


def new_did() -> str:
    return f"+1508555{next(_dids):04d}"


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
    from services.voicemail import deposit
    assert deposit.deposit_limiter.in_use == 0, "a deposit slot leaked"


@pytest.fixture
def box(h):
    return h.run(h.create_mailbox(CUST_A, new_did()))


def run(h, coro):
    return h.run(coro)


async def msg_row(h, msg_uuid):
    rows = await h.fetch("SELECT * FROM voicemail_messages WHERE msg_uuid = $1::uuid", msg_uuid)
    return rows[0] if rows else None


# ===========================================================================
# FS-exact request (real Lua encoder)
# ===========================================================================
def _vm_box_meta_block() -> str:
    """The deposit metadata construction, copied verbatim from vm_box.lua
    (from `local meta = {` through `local b64 = dep.b64url(body)`)."""
    src = VM_BOX.read_text()
    start = src.index("    local meta = {")
    end = src.index("    local b64 = dep.b64url(body)") + len("    local b64 = dep.b64url(body)")
    return src[start:end]


LUA_DRIVER = """
local LIB = arg[1]
local json = loadfile(LIB .. "/json.lua")()
local dep = loadfile(LIB .. "/vm_deposit.lua")()
local function log() end
local tag = ""
local a = { mailbox_id = arg[2], did = arg[3], caller_number = arg[4],
            caller_name = arg[5], call_uuid = arg[6], fs_node = arg[7], zone = arg[8] }
local st = { msg_uuid = arg[9] }
local dur = math.floor(tonumber(arg[10]))
%s
assert(dep.is_b64url(b64))
assert(dep.deposit_cmd("http://10.142.0.103:8088", dep.VM_DIR .. "/" .. st.msg_uuid .. ".wav", b64))
io.write(b64)
"""

LUA_CLASSIFY = """
local dep = loadfile(arg[1] .. "/vm_deposit.lua")()
local body = io.read("a")
local verdict = dep.classify(arg[2], body)
local mid = tonumber(body:match('"message_id"%s*:%s*(%d+)'))
io.write(verdict .. " " .. tostring(mid))
"""


@pytest.mark.skipif(LUA is None, reason="lua interpreter not available")
def test_fs_exact_meta_and_response_round_trip(h, box):
    async def go():
        msg_uuid = str(uuid.uuid4())
        caller_name = b'Jos\xe9 "@/etc/passwd" \x07<x> \xe6\x97\xa5\xe6\x9c\xac'  # Latin-1 + ctrl + UTF-8
        args = [LUA, "-", str(LIB), str(box["id"]), box["did"].encode(),
                b"+15085551212", caller_name,
                b"abc-123@sip.example;tag=x" * 4, b"east-fs-1", b"east", msg_uuid.encode(),
                b"2000"]
        script = LUA_DRIVER % _vm_box_meta_block()
        out = subprocess.run(args, input=script.encode(), capture_output=True, timeout=30)
        assert out.returncode == 0, out.stderr.decode(errors="replace")
        header = out.stdout.decode("ascii")
        assert re.fullmatch(r"[A-Za-z0-9_-]+", header) and not header.endswith("=")

        wav = make_wav(2.0, 8000)
        r = await h.client.post(
            "/v1/voicemail/fs/deposit", content=wav,
            headers={"Content-Type": "audio/wav", "X-VM-Meta": header,
                     "X-Ingest-Secret": INGEST_SECRET, "User-Agent": "curl/7.88.1",
                     "Accept": "*/*"})
        assert r.status_code == 200, r.text

        # The real FS client classifies our body as stored and reads the id.
        cl = subprocess.run([LUA, "-e", LUA_CLASSIFY.replace("arg[1]", repr(str(LIB)))
                             .replace("arg[2]", '"200"')], input=r.content,
                            capture_output=True, timeout=30)
        assert cl.returncode == 0, cl.stderr.decode(errors="replace")
        verdict, mid = cl.stdout.decode().split()
        assert verdict == "stored" and int(mid) == r.json()["message_id"]

        row = await msg_row(h, msg_uuid)
        assert row["status"] == "stored" and row["id"] == int(mid)
        assert row["mailbox_id"] == box["id"] and row["customer_id"] == CUST_A
        assert row["caller_id_number"] == "+15085551212"
        # json.lua: invalid UTF-8 byte -> U+FFFD; vm_deposit.clean_text: C0 -> space.
        assert row["caller_id_name"] == 'Jos� "@/etc/passwd" <x> 日本'
        assert row["call_uuid"] == ("abc-123@sip.example;tag=x" * 4)[:64]
        assert row["fs_node"] == "east-fs-1" and row["zone"] == "east"
        assert row["duration_ms"] == 2000 and row["size_bytes"] == len(wav)
        # Ciphertext stored, AAD-bound, decrypts to the exact body.
        from services.voicemail import audio
        assert await audio.decrypt_message(row) == wav
        assert memory_store().raw(row["object_key"]) != wav

    run(h, go())


# ===========================================================================
# Idempotency + concurrency
# ===========================================================================
def test_retry_of_stored_message_is_idempotent(h, box):
    async def go():
        meta = h.meta(box["id"])
        r1 = await h.deposit(meta)
        r2 = await h.deposit(meta)
        r3 = await h.deposit({**meta, "msg_uuid": meta["msg_uuid"].upper()})
        assert r1.status_code == r2.status_code == r3.status_code == 200
        assert r1.json() == r2.json() == r3.json()
        assert r1.json()["status"] == "stored"
        assert await h.fetchval("SELECT count(*) FROM voicemail_messages WHERE msg_uuid = $1::uuid",
                                meta["msg_uuid"]) == 1
        assert await h.fetchval(
            "SELECT count(*) FROM voicemail_access_log WHERE action = 'deposit' "
            "AND detail->>'msg_uuid' = $1", meta["msg_uuid"]) == 1
        assert sum(meta["msg_uuid"] in k for k in memory_store().keys()) == 1
        # Same msg_uuid claimed for another mailbox -> 409.
        other = await h.create_mailbox(CUST_A, new_did())
        r = await h.deposit({**meta, "mailbox_id": other["id"]})
        assert r.status_code == 409

    run(h, go())


def test_concurrent_duplicates_seal_once(h, box, monkeypatch):
    async def go():
        from services.voicemail import deposit
        real = deposit.seal_and_store
        calls = []

        async def slow_seal(**kw):
            calls.append(kw["object_key"])
            await asyncio.sleep(0.4)
            return await real(**kw)

        monkeypatch.setattr(deposit, "seal_and_store", slow_seal)
        meta = h.meta(box["id"])
        results = await asyncio.gather(*(h.deposit(meta) for _ in range(4)))
        codes = sorted(r.status_code for r in results)
        assert codes.count(200) >= 1 and set(codes) <= {200, 503}, codes
        for r in results:
            if r.status_code == 503:
                assert r.headers["retry-after"] == "2"
        assert len(calls) == 1, calls  # exactly one seal + upload
        r = await h.deposit(meta)
        assert r.status_code == 200
        ok = [x.json()["message_id"] for x in results if x.status_code == 200]
        assert all(m == r.json()["message_id"] for m in ok)
        assert len(calls) == 1

    run(h, go())


def test_pending_lease_and_takeover(h, box):
    async def go():
        # A pending row with a LIVE lease (another attempt mid-upload) -> 503.
        meta = h.meta(box["id"])
        await h.execute(
            "INSERT INTO voicemail_messages (msg_uuid, mailbox_id, customer_id, size_bytes, "
            "status, expires_at, deposit_attempt_id, deposit_lease_until) VALUES "
            "($1::uuid, $2, $3, 10, 'pending', now() + interval '90 days', $4::uuid, "
            "now() + interval '20 seconds')", meta["msg_uuid"], box["id"], CUST_A,
            str(uuid.uuid4()))
        r = await h.deposit(meta)
        assert r.status_code == 503 and r.headers["retry-after"] == "2"
        # Lease expired -> this attempt takes the row over (same id).
        row_id = (await msg_row(h, meta["msg_uuid"]))["id"]
        await h.execute("UPDATE voicemail_messages SET deposit_lease_until = now() - "
                        "interval '1 second' WHERE id = $1", row_id)
        r = await h.deposit(meta)
        assert r.status_code == 200, r.text
        assert r.json()["message_id"] == row_id
        row = await msg_row(h, meta["msg_uuid"])
        assert row["status"] == "stored" and row["deposit_lease_until"] is None
        # A 'failed' row is taken over immediately.
        meta2 = h.meta(box["id"])
        await h.execute(
            "INSERT INTO voicemail_messages (msg_uuid, mailbox_id, customer_id, size_bytes, "
            "status, expires_at) VALUES ($1::uuid, $2, $3, 10, 'failed', now())",
            meta2["msg_uuid"], box["id"], CUST_A)
        r = await h.deposit(meta2)
        assert r.status_code == 200
        # A purged message is never resurrected.
        await h.execute("UPDATE voicemail_messages SET status = 'purged', object_key = NULL, "
                        "ciphertext_crc32c = NULL, wrapped_dek = NULL, kek_version = NULL, "
                        "iv = NULL WHERE msg_uuid = $1::uuid", meta2["msg_uuid"])
        r = await h.deposit(meta2)
        assert r.status_code == 409

    run(h, go())


def test_concurrency_limit_503(h, box):
    async def go():
        from services.voicemail import deposit
        deposit.deposit_limiter.limit = 0
        try:
            r = await h.deposit(h.meta(box["id"]))
            assert r.status_code == 503 and r.headers["retry-after"] == "2"
        finally:
            deposit.deposit_limiter.limit = deposit.DEPOSIT_CONCURRENCY
        assert deposit.DEPOSIT_CONCURRENCY == 5  # x 4 uvicorn workers ~ 20 platform-wide
        r = await h.deposit(h.meta(box["id"]))
        assert r.status_code == 200

    run(h, go())


# ===========================================================================
# Hardening
# ===========================================================================
def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def test_hostile_meta_is_400(h, box):
    async def go():
        good = h.meta(box["id"])
        from services.voicemail.meta import encode_meta
        enc = encode_meta(good)
        cases = {
            "junk char": enc[:10] + "$" + enc[10:],
            "dot inside (stdlib would drop it)": enc[:8] + "." + enc[8:],
            "padding": enc + "=" * (-len(enc) % 4 or 4),
            "space": enc[:5] + " " + enc[5:],
            "len%4==1": enc + "A" if len(enc) % 4 == 0 else enc[:len(enc) - len(enc) % 4] + "A",
            "not utf8": _b64(b"\xff\xfe{}"),
            "not json": _b64(b"{v:1}"),
            "array": _b64(b"[1,2]"),
            "dup key": _b64(b'{"v":1,"v":1,"msg_uuid":"%s","mailbox_id":%d}'
                            % (good["msg_uuid"].encode(), box["id"])),
            "too long": "A" * 8196,
            "empty": "",
        }
        bad_values = [
            {"v": 2}, {"v": True}, {"v": "1"}, {"msg_uuid": "not-a-uuid"},
            {"msg_uuid": 123}, {"mailbox_id": str(box["id"])}, {"mailbox_id": True},
            {"mailbox_id": 0}, {"mailbox_id": 2**31}, {"mailbox_id": 1.5},
            {"duration_ms": -1}, {"duration_ms": "5"}, {"caller_id_name": "n" * 101},
            {"caller_id_number": 5085551212}, {"zone": "z" * 17}, {"did": ["+1"]},
            {"caller_id_name": "\ud800"},
        ]
        for name, raw in cases.items():
            r = await h.deposit(raw_meta=raw)
            assert r.status_code == 400, (name, r.status_code, r.text)
        for override in bad_values:
            meta = {**good, **override}
            body = json.dumps(meta).encode("utf-8", "surrogatepass")
            r = await h.deposit(raw_meta=_b64(body))
            assert r.status_code == 400, (override, r.text)
        for missing in ("v", "msg_uuid", "mailbox_id"):
            meta = {k: v for k, v in good.items() if k != missing}
            r = await h.deposit(meta)
            assert r.status_code == 400, missing
        r = await h.deposit(None)  # no header at all
        assert r.status_code == 400
        # Unknown keys are ignored; empty strings become NULL; controls -> space.
        meta = {**good, "future_key": {"x": 1}, "caller_id_name": "",
                "caller_id_number": "+1508\t555\x7f1212"}
        r = await h.deposit(meta)
        assert r.status_code == 200, r.text
        row = await msg_row(h, good["msg_uuid"])
        assert row["caller_id_name"] is None and row["caller_id_number"] == "+1508 555 1212"
        assert await h.fetchval("SELECT count(*) FROM voicemail_messages m JOIN voicemail_boxes b "
                                "ON b.id = m.mailbox_id WHERE b.id = $1 AND m.status <> 'stored'",
                                box["id"]) == 0

    run(h, go())


def test_ingest_secret_and_content_checks(h, box, monkeypatch):
    async def go():
        assert (await h.deposit(h.meta(box["id"]), secret=None)).status_code == 401
        assert (await h.deposit(h.meta(box["id"]), secret="x" * 40)).status_code == 401
        assert (await h.deposit(h.meta(box["id"]), secret=INGEST_SECRET + "x")).status_code == 401
        r = await h.deposit(h.meta(box["id"]), content_type="audio/mpeg")
        assert r.status_code == 415
        r = await h.deposit(h.meta(box["id"]), content_type="multipart/form-data; boundary=x")
        assert r.status_code == 415
        r = await h.deposit(h.meta(box["id"]), body=b"OggS" + b"\x00" * 200)
        assert r.status_code == 415
        stereo = (b"RIFF" + struct.pack("<I", 36 + 8) + b"WAVE" + b"fmt "
                  + struct.pack("<IHHIIHH", 16, 1, 2, 8000, 32000, 4, 16)
                  + b"data" + struct.pack("<I", 8) + b"\x00" * 8)
        r = await h.deposit(h.meta(box["id"]), body=stereo)
        assert r.status_code == 422
        # The X-VM-Meta check runs before the body; the secret before both.
        r = await h.deposit(raw_meta="$$$", secret=None)
        assert r.status_code == 401
        monkeypatch.setenv("INGEST_SHARED_SECRET", "short")
        assert (await h.deposit(h.meta(box["id"]))).status_code == 503
        monkeypatch.delenv("INGEST_SHARED_SECRET")
        assert (await h.deposit(h.meta(box["id"]))).status_code == 503
        assert await h.fetchval("SELECT count(*) FROM voicemail_messages WHERE mailbox_id = $1",
                                box["id"]) == 0

    run(h, go())


def test_body_cap_413(h, box):
    async def go():
        cap = 10 * 1024 * 1024
        r = await h.deposit(h.meta(box["id"]), body=b"\x00" * (cap + 1))
        assert r.status_code == 413

        async def chunked():
            for _ in range(11):
                yield b"\x00" * (1024 * 1024)

        from services.voicemail.meta import encode_meta
        r = await h.client.post(
            "/v1/voicemail/fs/deposit", content=chunked(),
            headers={"Content-Type": "audio/wav", "X-Ingest-Secret": INGEST_SECRET,
                     "X-VM-Meta": encode_meta(h.meta(box["id"]))})
        assert "content-length" not in {k.lower() for k in r.request.headers}
        assert r.status_code == 413
        r = await h.deposit(h.meta(box["id"]), extra_headers={"Content-Length": "12abc"})
        assert r.status_code in (400, 413)
        assert await h.fetchval("SELECT count(*) FROM voicemail_messages WHERE mailbox_id = $1",
                                box["id"]) == 0

    run(h, go())


def test_mailbox_state_and_duration_checks(h, box):
    async def go():
        assert (await h.deposit(h.meta(999999))).status_code == 404
        await h.execute("UPDATE voicemail_boxes SET max_message_seconds = 10 WHERE id = $1",
                        box["id"])
        r = await h.deposit(h.meta(box["id"]), body=make_wav(16.0))
        assert r.status_code == 422
        mid = await h.deposit_ok(box["id"], seconds=15.0, duration_ms=1)  # 10 s + 5 s grace
        # The stored duration is the server's own measurement, not the meta's.
        assert await h.fetchval("SELECT duration_ms FROM voicemail_messages WHERE id = $1",
                                mid) == 15000
        await h.execute("UPDATE voicemail_boxes SET status = 'suspended' WHERE id = $1",
                        box["id"])
        r = await h.deposit(h.meta(box["id"]))
        assert r.status_code == 409 and "inactive" in r.json()["detail"]
        await h.execute("UPDATE voicemail_boxes SET status = 'active', max_messages = 1 "
                        "WHERE id = $1", box["id"])
        meta_full = h.meta(box["id"])
        r = await h.deposit(meta_full)
        assert r.status_code == 409 and "full" in r.json()["detail"]
        # ...but a retry of an already-stored message still gets its 200.
        stored_meta = {**h.meta(box["id"]),
                       "msg_uuid": str(await h.fetchval(
                           "SELECT msg_uuid FROM voicemail_messages WHERE id = $1", mid))}
        r = await h.deposit(stored_meta)
        assert r.status_code == 200 and r.json()["message_id"] == mid

    run(h, go())


def test_unfinalized_wav_header_is_accepted(h, box):
    """FS's wav_duration_ms tolerates a data size of 0 / 0xFFFFFFFF (header
    never finalised) by using the bytes present; the API must agree, or FS
    drops a message it already measured."""
    async def go():
        pcm = pcm_tone(1.5)
        for size_field in (0, 0xFFFFFFFF, len(pcm) + 999):
            wav = (b"RIFF" + struct.pack("<I", 0) + b"WAVE" + b"fmt "
                   + struct.pack("<IHHIIHH", 16, 1, 1, 8000, 16000, 2, 16)
                   + b"data" + struct.pack("<I", size_field) + pcm + b"\x01")  # odd tail byte
            r = await h.deposit(h.meta(box["id"]), body=wav)
            assert r.status_code == 200, (size_field, r.text)
            mid = r.json()["message_id"]
            assert await h.fetchval("SELECT duration_ms FROM voicemail_messages WHERE id = $1",
                                    mid) == 1500

    run(h, go())


# ===========================================================================
# Failure handling
# ===========================================================================
def test_kms_down_marks_failed_then_retry_takes_over(h, box, monkeypatch):
    async def go():
        from services.voicemail import deposit
        from services.voicemail.errors import VoicemailCryptoUnavailable
        real = deposit.seal_and_store

        async def down(**kw):
            raise VoicemailCryptoUnavailable("KMS unavailable (test)")

        monkeypatch.setattr(deposit, "seal_and_store", down)
        meta = h.meta(box["id"])
        r = await h.deposit(meta)
        assert r.status_code == 503 and r.headers["retry-after"] == "2"
        row = await msg_row(h, meta["msg_uuid"])
        assert row["status"] == "failed" and row["wrapped_dek"] is None
        monkeypatch.setattr(deposit, "seal_and_store", real)
        r = await h.deposit(meta)
        assert r.status_code == 200 and r.json()["message_id"] == row["id"]

    run(h, go())


def test_deadline_503_then_seal_finishes_in_background(h, box, monkeypatch):
    """A seal that misses the 11 s deadline is NOT cancelled (its KMS/GCS
    thread could otherwise still upload after a takeover): FS gets 503, the
    lease is held so retries get 503, and the SAME seal is finalized in the
    background — the message is stored, the slot and body released after."""
    async def go():
        from services.voicemail import deposit
        real = deposit.seal_and_store
        gate = asyncio.Event()
        calls = []

        async def slow(**kw):
            calls.append(1)
            await gate.wait()
            return await real(**kw)

        monkeypatch.setattr(deposit, "DEPOSIT_DEADLINE_S", 0.3)
        monkeypatch.setattr(deposit, "seal_and_store", slow)
        meta = h.meta(box["id"])
        r = await h.deposit(meta)
        assert r.status_code == 503 and r.headers["retry-after"] == "2"
        row = await msg_row(h, meta["msg_uuid"])
        assert row["status"] == "pending"
        lease_left = await h.fetchval(
            "SELECT extract(epoch FROM deposit_lease_until - now()) FROM voicemail_messages "
            "WHERE id = $1", row["id"])
        assert deposit.LATE_LEASE_S - 10 < lease_left <= deposit.LATE_LEASE_S
        assert deposit.deposit_limiter.in_use == 1  # slot + body held by the finisher
        # FS's quick retry must NOT take over while the first seal is alive.
        monkeypatch.setattr(deposit, "DEPOSIT_DEADLINE_S", 11.0)
        r = await h.deposit(meta)
        assert r.status_code == 503
        assert len(calls) == 1
        # The first seal completes -> finalized in the background.
        gate.set()
        for _ in range(100):
            if (await msg_row(h, meta["msg_uuid"]))["status"] == "stored":
                break
            await asyncio.sleep(0.02)
        row = await msg_row(h, meta["msg_uuid"])
        assert row["status"] == "stored" and row["deposit_lease_until"] is None
        for _ in range(50):
            if deposit.deposit_limiter.in_use == 0:
                break
            await asyncio.sleep(0.02)
        assert deposit.deposit_limiter.in_use == 0
        assert await h.fetchval("SELECT count(*) FROM voicemail_access_log WHERE action = 'deposit' "
                                "AND detail->>'msg_uuid' = $1", meta["msg_uuid"]) == 1
        # FS's last retry now gets the idempotent 200; still one seal.
        r = await h.deposit(meta)
        assert r.status_code == 200 and r.json()["message_id"] == row["id"]
        assert len(calls) == 1
        # The plaintext was not zeroed under the late seal.
        from services.voicemail import audio
        assert (await audio.decrypt_message(row)).startswith(b"RIFF")

    run(h, go())


def test_late_seal_failure_marks_failed(h, box, monkeypatch):
    async def go():
        from services.voicemail import deposit
        from services.voicemail.errors import VoicemailCryptoUnavailable
        gate = asyncio.Event()

        async def slow_fail(**kw):
            await gate.wait()
            raise VoicemailCryptoUnavailable("GCS gave up (test)")

        monkeypatch.setattr(deposit, "DEPOSIT_DEADLINE_S", 0.2)
        monkeypatch.setattr(deposit, "seal_and_store", slow_fail)
        meta = h.meta(box["id"])
        assert (await h.deposit(meta)).status_code == 503
        gate.set()
        for _ in range(100):
            if (await msg_row(h, meta["msg_uuid"]))["status"] == "failed":
                break
            await asyncio.sleep(0.02)
        assert (await msg_row(h, meta["msg_uuid"]))["status"] == "failed"
        for _ in range(50):
            if deposit.deposit_limiter.in_use == 0:
                break
            await asyncio.sleep(0.02)
        monkeypatch.undo()
        r = await h.deposit(meta)  # takeover of the failed row
        assert r.status_code == 200

    run(h, go())


def test_audit_failure_never_leaves_row_stored(h, box, monkeypatch):
    async def go():
        from services.voicemail import audit
        real = audit.write_audit

        async def failing(conn, **kw):
            if kw.get("action") == "deposit":
                raise OSError("audit insert failed (test)")
            return await real(conn, **kw)

        monkeypatch.setattr(audit, "write_audit", failing)
        meta = h.meta(box["id"])
        r = await h.deposit(meta)
        assert r.status_code == 503
        row = await msg_row(h, meta["msg_uuid"])
        assert row["status"] == "failed" and row["wrapped_dek"] is None
        assert await h.fetchval("SELECT count(*) FROM voicemail_access_log WHERE action = 'deposit' "
                                "AND detail->>'msg_uuid' = $1", meta["msg_uuid"]) == 0
        monkeypatch.setattr(audit, "write_audit", real)
        r = await h.deposit(meta)
        assert r.status_code == 200 and r.json()["message_id"] == row["id"]
        assert await h.fetchval("SELECT count(*) FROM voicemail_access_log WHERE action = 'deposit' "
                                "AND detail->>'msg_uuid' = $1", meta["msg_uuid"]) == 1

    run(h, go())


def test_mailbox_deleted_during_upload(h, monkeypatch):
    async def go():
        from services.voicemail import deposit, retention
        b = await h.create_mailbox(CUST_A, new_did())
        real = deposit.seal_and_store

        async def delete_then_seal(**kw):
            await h.execute("UPDATE voicemail_boxes SET status = 'deleted' WHERE id = $1", b["id"])
            return await real(**kw)

        monkeypatch.setattr(deposit, "seal_and_store", delete_then_seal)
        meta = h.meta(b["id"])
        r = await h.deposit(meta)
        assert r.status_code == 404
        row = await msg_row(h, meta["msg_uuid"])
        assert row["status"] == "pending"
        key = f"c/{CUST_A}/mb/{b['id']}/m/{meta['msg_uuid']}.enc"
        assert key in memory_store().keys()
        # Lease still live: the retention worker leaves it alone ...
        await retention.sweep_once()
        assert (await msg_row(h, meta["msg_uuid"]))["status"] == "pending"
        # ... and purges row + object once the lease is over.
        await h.execute("UPDATE voicemail_messages SET deposit_lease_until = now() - "
                        "interval '1 second' WHERE id = $1", row["id"])
        counts = await retention.sweep_once()
        assert counts.get("message:mailbox_deleted", 0) >= 1, counts
        assert (await msg_row(h, meta["msg_uuid"]))["status"] == "purged"
        assert key not in memory_store().keys()

    run(h, go())


def test_audio_paths_never_touch_the_disk(h, box, monkeypatch):
    """Plan D8 / §3.2: deposit, greeting upload, playback and the FS greeting
    fetch never create a file — every file-creating primitive raises while
    they run (Starlette multipart spooling would trip tempfile)."""
    import builtins
    import os
    import tempfile

    attempts = []
    real_open, real_os_open = builtins.open, os.open

    def guarded_open(file, mode="r", *a, **k):
        if any(c in mode for c in "wax+"):
            attempts.append(("open", file))
            raise AssertionError(f"disk write attempted: {file}")
        return real_open(file, mode, *a, **k)

    def guarded_os_open(path, flags, *a, **k):
        if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT):
            attempts.append(("os.open", path))
            raise AssertionError(f"disk write attempted: {path}")
        return real_os_open(path, flags, *a, **k)

    def no_tempfile(*a, **k):
        attempts.append(("tempfile", a))
        raise AssertionError("tempfile used")

    async def go():
        wav = make_wav(3.0, 8000)
        monkeypatch.setattr(builtins, "open", guarded_open)
        monkeypatch.setattr(os, "open", guarded_os_open)
        for name in ("mkstemp", "mkdtemp", "TemporaryFile", "NamedTemporaryFile",
                     "SpooledTemporaryFile"):
            monkeypatch.setattr(tempfile, name, no_tempfile)
        try:
            r = await h.deposit(h.meta(box["id"]), body=wav)
            assert r.status_code == 200, r.text
            mid = r.json()["message_id"]
            r = await h.client.post(
                f"/v1/voicemail/mailboxes/{box['id']}/greetings", params={"activate": "true"},
                headers={**h.auth("user_a"), "Content-Type": "audio/wav"},
                content=make_wav(2.0, 16000))
            assert r.status_code == 201, r.text
            gid = r.json()["id"]
            r = await h.client.post(f"/v1/voicemail/messages/{mid}/playback-token",
                                    headers=h.auth("user_a"), json={})
            url = r.json()["url"][len("/api"):]
            r = await h.client.get(url, headers={"Range": "bytes=0-1023"})
            assert r.status_code == 206 and r.content == wav[:1024]
            r = await h.client.get(f"/v1/voicemail/fs/greetings/{gid}/audio",
                                   headers={"X-Ingest-Secret": INGEST_SECRET})
            assert r.status_code == 200
        finally:
            monkeypatch.undo()
        assert attempts == []

    run(h, go())
