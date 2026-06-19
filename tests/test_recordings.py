"""Phase 6 — media plane: recordings ingest/serve + WS media consumer.

Two independent layers:

1. **WS media consumer (pure unit, no infra).** A synthetic WebSocket streams N
   binary PCM frames to ``services.media.consume_media_stream``; we assert the
   consumer counts frames/bytes, estimates duration, and drives the pluggable STT
   hook (on_start once, on_audio per frame, on_stop once), closing cleanly on
   disconnect. Never skipped.

2. **Recording ingest → upload → presigned serve round-trip (live stack).** A
   real WAV is dropped into the shared media spool INSIDE the ``voip-api``
   container, the (JWT-exempt) ingest endpoint is POSTed, and we assert the WAV
   landed in the voip-recordings bucket + a DB row exists + a presigned GET
   returns the exact bytes. Runs the storage/HTTP calls inside the container
   (which has boto3/httpx + minio reachability), mirroring test_storage_roundtrip.
   The audio endpoint's tenant-scoped presigned 307 redirect is checked over HTTP
   with a minted JWT. Skips cleanly if the live stack is not up.

Run:  python3 -m pytest tests/test_recordings.py -v
"""
import os
import sys
import time
import json
import uuid
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
sys.path.insert(0, str(API_SRC))


# ===========================================================================
# 1. WS media consumer — pure unit tests (no DB / Redis / FS / Docker)
# ===========================================================================

from services.media import consume_media_stream  # noqa: E402
from services.stt import STTHook, NoopSTTHook, get_stt_hook, set_stt_hook  # noqa: E402


class _FakeWebSocket:
    """Minimal Starlette-ASGI-shaped WebSocket for the consumer.

    ``frames`` are pre-built receive() messages; once exhausted, receive()
    returns a websocket.disconnect (as Starlette does when the peer closes).
    """

    def __init__(self, frames):
        self._frames = list(frames)
        self.receive_calls = 0

    async def receive(self):
        self.receive_calls += 1
        if self._frames:
            return self._frames.pop(0)
        return {"type": "websocket.disconnect", "code": 1000}


class _RecordingHook(STTHook):
    """STT hook that records every lifecycle callback for assertions."""

    def __init__(self):
        self.started = []
        self.frames = []
        self.stopped = []

    async def on_start(self, call_uuid, meta):
        self.started.append((call_uuid, meta))

    async def on_audio(self, call_uuid, frame):
        self.frames.append(frame)

    async def on_stop(self, call_uuid, stats):
        self.stopped.append((call_uuid, stats))


def _bin_frame(payload: bytes) -> dict:
    return {"type": "websocket.receive", "bytes": payload}


@pytest.mark.asyncio
async def test_media_consumer_counts_frames_and_invokes_hook():
    hook = _RecordingHook()
    n = 5
    frame_bytes = bytes(320)  # 160 L16 samples @ 8kHz = 20ms each
    ws = _FakeWebSocket([_bin_frame(frame_bytes) for _ in range(n)])

    stats = await consume_media_stream(ws, "call-unit-1", sample_rate=8000, hook=hook)

    assert stats["frames"] == n
    assert stats["bytes"] == n * 320
    # 1600 bytes / 2 = 800 samples / 8000 Hz = 0.1s = 100ms
    assert stats["duration_ms"] == 100

    # hook lifecycle: start once, audio per frame, stop once
    assert len(hook.started) == 1
    assert hook.started[0][0] == "call-unit-1"
    assert hook.started[0][1]["sample_rate"] == 8000
    assert len(hook.frames) == n
    assert hook.frames[0] == frame_bytes
    assert len(hook.stopped) == 1
    assert hook.stopped[0][1]["frames"] == n


@pytest.mark.asyncio
async def test_media_consumer_ignores_text_control_frames():
    hook = _RecordingHook()
    ws = _FakeWebSocket([
        {"type": "websocket.receive", "text": '{"event":"start"}'},
        _bin_frame(bytes(160)),
        {"type": "websocket.receive", "text": '{"event":"stop"}'},
    ])

    stats = await consume_media_stream(ws, "call-unit-2", sample_rate=8000, hook=hook)

    assert stats["frames"] == 1          # only the binary frame counted
    assert stats["bytes"] == 160
    assert len(hook.frames) == 1


@pytest.mark.asyncio
async def test_media_consumer_closes_cleanly_on_immediate_disconnect():
    hook = _RecordingHook()
    ws = _FakeWebSocket([])  # peer disconnects before any audio

    stats = await consume_media_stream(ws, "call-unit-3", sample_rate=8000, hook=hook)

    assert stats == {"frames": 0, "bytes": 0, "duration_ms": 0}
    assert len(hook.started) == 1  # start still fired
    assert len(hook.stopped) == 1  # stop still fired (frame totals = 0)


@pytest.mark.asyncio
async def test_media_consumer_uses_default_noop_hook_when_none_given():
    # Reset to the real singleton, assert it's the no-op, and that the consumer
    # runs end-to-end with it (transcribes nothing, raises nothing).
    set_stt_hook(None)
    assert isinstance(get_stt_hook(), NoopSTTHook)
    ws = _FakeWebSocket([_bin_frame(bytes(320)), _bin_frame(bytes(320))])
    stats = await consume_media_stream(ws, "call-unit-4", sample_rate=8000)
    assert stats["frames"] == 2


# ===========================================================================
# 2. Recording ingest → upload → presigned serve — live-stack round-trip
# ===========================================================================

requests = pytest.importorskip("requests")
jose_jwt = pytest.importorskip("jose.jwt", reason="python-jose required to mint test JWTs")

API_BASE = os.getenv("API_BASE", "http://localhost:8088")
API_CONTAINER = "voip-api"
PG_CONTAINER = os.getenv("PG_CONTAINER", "voip-postgres")
PG_DB = os.getenv("POSTGRES_DB", "voip")
PG_USER = os.getenv("POSTGRES_USER", "voip")

# Use the seeded Granite customer (id=1) as the recording owner.
OWNER_CUSTOMER_ID = 1

DENIED = {401, 403, 404}


def _psql(sql: str) -> str:
    r = subprocess.run(
        ["docker", "exec", "-i", PG_CONTAINER, "psql", "-U", PG_USER, "-d", PG_DB,
         "-tAqc", sql],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(f"psql failed: {r.stderr.strip()}\nSQL: {sql}")
    return r.stdout.strip()


def _stack_up() -> bool:
    if not shutil.which("docker"):
        return False
    try:
        return requests.get(f"{API_BASE}/health", timeout=5).status_code == 200
    except Exception:
        return False


def _jwt_secret() -> str:
    r = subprocess.run(
        ["docker", "exec", API_CONTAINER, "printenv", "JWT_SECRET_KEY"],
        capture_output=True, text=True,
    )
    secret = r.stdout.strip()
    if not secret:
        pytest.skip("could not read JWT_SECRET_KEY from api container")
    return secret


def _token(secret: str, customer_id: int, role: str = "user") -> str:
    claims = {
        "sub": "999999",
        "email": "recordings-test@example.com",
        "role": role,
        "customer_id": customer_id,
        "exp": int(time.time()) + 3600,
    }
    return jose_jwt.encode(claims, secret, algorithm="HS256")


# Step 1 — write a real WAV into the shared spool AS ROOT, mimicking FreeSWITCH
# (which runs as root and writes world-readable files). The API container runs as
# UID 1000 and cannot create files under the root-owned spool — exactly the prod
# model where FS writes and the API only reads. Prints the file's sha256 + size.
_WRITE_WAV = r"""
import os, sys, json, wave, struct, hashlib
SPOOL = "__SPOOL_PATH__"
out = {}
try:
    os.makedirs(os.path.dirname(SPOOL), exist_ok=True)
    with wave.open(SPOOL, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000)
        w.writeframes(struct.pack("<" + "h" * 800, *([1234] * 800)))
    os.chmod(SPOOL, 0o644)  # world-readable, like an FS-written recording
    with open(SPOOL, "rb") as f:
        data = f.read()
    out["sha256"] = hashlib.sha256(data).hexdigest()
    out["len"] = len(data)
    out["ok"] = True
except Exception as e:
    out["error"] = repr(e); out["ok"] = False
print("RESULT_JSON:" + json.dumps(out))
"""

# Step 2 — run AS THE API USER: POST the (unauthenticated) ingest endpoint, then
# presign-GET the uploaded object and prove the bytes round-trip exactly via sha256.
_INGEST_SERVE = r"""
import os, sys, json, hashlib
sys.path.insert(0, "/app")
import httpx
from services import storage

CID = __CID__
RUUID = "__RUUID__"
SPOOL = "__SPOOL_PATH__"
out = {}
try:
    # SEC-2: send the shared ingest secret the API container is configured with.
    SECRET = os.environ.get("INGEST_SHARED_SECRET", "")
    headers = {"X-Ingest-Secret": SECRET} if SECRET else {}
    r = httpx.post(
        "http://127.0.0.1:8000/v1/recordings/ingest",
        json={
            "recording_uuid": RUUID,
            "customer_id": CID,
            "call_uuid": "call-" + RUUID,
            "spool_path": SPOOL,
            "duration_ms": 100,
            "kind": "call",
        },
        headers=headers,
        timeout=30,
    )
    out["ingest_status"] = r.status_code
    body = r.json()
    out["ingest_body"] = body
    out["recording_id"] = body.get("recording_id")
    key = body.get("object_key")
    out["object_key"] = key

    if key:
        url = storage.presigned_get_url(storage.BUCKET_RECORDINGS, key, ttl=120)
        out["presigned_url"] = url
        g = httpx.get(url, timeout=15)
        out["serve_status"] = g.status_code
        out["served_sha256"] = hashlib.sha256(g.content).hexdigest()
        out["served_len"] = len(g.content)
        out["ok"] = (r.status_code == 200 and g.status_code == 200)
    else:
        out["ok"] = False
except Exception as e:
    out["error"] = repr(e); out["ok"] = False
print("RESULT_JSON:" + json.dumps(out))
"""


# Step 2 (PROD-2) — multipart variant: POST the audio FILE itself (field `file`)
# plus the metadata fields, mirroring production where the FreeSWITCH Media VM and
# the API Services VM share NO volume. Proves the bytes round-trip MinIO exactly.
_INGEST_MULTIPART = r"""
import os, sys, json, hashlib
sys.path.insert(0, "/app")
import httpx
from services import storage

CID = __CID__
RUUID = "__RUUID__"
SPOOL = "__SPOOL_PATH__"
out = {}
try:
    SECRET = os.environ.get("INGEST_SHARED_SECRET", "")
    headers = {"X-Ingest-Secret": SECRET} if SECRET else {}
    with open(SPOOL, "rb") as f:
        data = f.read()
    out["orig_sha256"] = hashlib.sha256(data).hexdigest()
    out["orig_len"] = len(data)
    r = httpx.post(
        "http://127.0.0.1:8000/v1/recordings/ingest",
        data={
            "recording_uuid": RUUID,
            "customer_id": str(CID),
            "call_uuid": "call-" + RUUID,
            "duration_ms": "100",
            "kind": "call",
        },
        files={"file": ("rec.wav", data, "audio/wav")},
        headers=headers,
        timeout=30,
    )
    out["ingest_status"] = r.status_code
    body = r.json()
    out["ingest_body"] = body
    out["recording_id"] = body.get("recording_id")
    key = body.get("object_key")
    out["object_key"] = key
    if key:
        url = storage.presigned_get_url(storage.BUCKET_RECORDINGS, key, ttl=120)
        g = httpx.get(url, timeout=15)
        out["serve_status"] = g.status_code
        out["served_sha256"] = hashlib.sha256(g.content).hexdigest()
        out["ok"] = (
            r.status_code == 200 and g.status_code == 200
            and out["served_sha256"] == out["orig_sha256"]
        )
    else:
        out["ok"] = False
except Exception as e:
    out["error"] = repr(e); out["ok"] = False
print("RESULT_JSON:" + json.dumps(out))
"""


def _ingest_secret() -> str:
    """Read INGEST_SHARED_SECRET from the running API container (set in compose)."""
    r = subprocess.run(
        ["docker", "exec", API_CONTAINER, "printenv", "INGEST_SHARED_SECRET"],
        capture_output=True, text=True,
    )
    return r.stdout.strip()


def _exec_json(args):
    """Run a container command, parse the single RESULT_JSON line it prints."""
    proc = subprocess.run(args, capture_output=True, text=True, timeout=180)
    for ln in proc.stdout.splitlines():
        if ln.startswith("RESULT_JSON:"):
            return json.loads(ln[len("RESULT_JSON:"):])
    raise AssertionError(
        f"no RESULT_JSON.\nCMD: {args}\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
    )


@pytest.fixture(scope="module")
def live(env_guard):
    secret = _jwt_secret()
    ruuid = uuid.uuid4().hex
    spool_path = f"/media/spool/recordings/customer_{OWNER_CUSTOMER_ID}/{ruuid}.wav"

    # Step 1: write the WAV as root (mimics FreeSWITCH).
    wrote = _exec_json([
        "docker", "exec", "-u", "0", "-i", API_CONTAINER, "python", "-c",
        _WRITE_WAV.replace("__SPOOL_PATH__", spool_path),
    ])
    assert wrote.get("ok"), f"failed to seed spool WAV: {wrote.get('error')}"

    # Step 2: ingest + presigned serve as the api user (default UID 1000).
    result = _exec_json([
        "docker", "exec", "-i", API_CONTAINER, "python", "-c",
        _INGEST_SERVE
        .replace("__CID__", str(OWNER_CUSTOMER_ID))
        .replace("__RUUID__", ruuid)
        .replace("__SPOOL_PATH__", spool_path),
    ])
    result["_secret"] = secret
    result["recording_uuid"] = ruuid
    result["orig_sha256"] = wrote.get("sha256")
    result["orig_len"] = wrote.get("len")

    yield result

    # teardown — remove the DB row + object (best-effort)
    ruuid = result.get("recording_uuid")
    key = result.get("object_key")
    if ruuid:
        try:
            _psql(f"DELETE FROM recordings WHERE recording_uuid = '{ruuid}'")
        except Exception:
            pass
    if key:
        try:
            subprocess.run(
                ["docker", "exec", "-i", API_CONTAINER, "python", "-c",
                 "import sys; sys.path.insert(0,'/app'); from services import storage; "
                 f"storage.delete(storage.BUCKET_RECORDINGS, {key!r})"],
                capture_output=True, text=True, timeout=30,
            )
        except Exception:
            pass


@pytest.fixture(scope="module")
def env_guard():
    if not _stack_up():
        pytest.skip("live API stack not reachable; recordings round-trip needs it up")
    yield


@pytest.fixture(scope="module")
def live_multipart(env_guard):
    """PROD-2 round-trip: write a WAV as root, then POST it as a MULTIPART FILE
    (not a spool_path) to the ingest endpoint and prove the bytes round-trip
    MinIO via a presigned GET. Mirrors production cross-VM media (no shared spool)."""
    ruuid = uuid.uuid4().hex
    spool_path = f"/media/spool/recordings/customer_{OWNER_CUSTOMER_ID}/mp_{ruuid}.wav"

    wrote = _exec_json([
        "docker", "exec", "-u", "0", "-i", API_CONTAINER, "python", "-c",
        _WRITE_WAV.replace("__SPOOL_PATH__", spool_path),
    ])
    assert wrote.get("ok"), f"failed to seed spool WAV: {wrote.get('error')}"

    result = _exec_json([
        "docker", "exec", "-i", API_CONTAINER, "python", "-c",
        _INGEST_MULTIPART
        .replace("__CID__", str(OWNER_CUSTOMER_ID))
        .replace("__RUUID__", ruuid)
        .replace("__SPOOL_PATH__", spool_path),
    ])
    result["recording_uuid"] = ruuid

    yield result

    # teardown — DB row + object + spool file (best-effort)
    try:
        _psql(f"DELETE FROM recordings WHERE recording_uuid = '{ruuid}'")
    except Exception:
        pass
    key = result.get("object_key")
    if key:
        try:
            subprocess.run(
                ["docker", "exec", "-i", API_CONTAINER, "python", "-c",
                 "import sys; sys.path.insert(0,'/app'); from services import storage; "
                 f"storage.delete(storage.BUCKET_RECORDINGS, {key!r})"],
                capture_output=True, text=True, timeout=30,
            )
        except Exception:
            pass
    try:
        subprocess.run(
            ["docker", "exec", "-u", "0", "-i", API_CONTAINER, "rm", "-f", spool_path],
            capture_output=True, text=True, timeout=30,
        )
    except Exception:
        pass


def test_multipart_ingest_uploaded_to_bucket(live_multipart):
    assert "error" not in live_multipart, live_multipart.get("error")
    assert live_multipart["ingest_status"] == 200, live_multipart
    assert live_multipart["object_key"], "multipart ingest returned no object_key"
    assert live_multipart["object_key"].startswith(
        f"customer_{OWNER_CUSTOMER_ID}/recordings/"
    )


def test_multipart_serve_returns_exact_bytes(live_multipart):
    assert "error" not in live_multipart, live_multipart.get("error")
    assert live_multipart["serve_status"] == 200, live_multipart
    assert live_multipart["ok"] is True, live_multipart
    # The presigned GET returns exactly the bytes we POSTed as the multipart file.
    assert live_multipart["served_sha256"] == live_multipart["orig_sha256"]


def test_ingest_uploaded_to_bucket(live):
    assert "error" not in live, live.get("error")
    assert live["ingest_status"] == 200, live
    assert live["object_key"], "ingest did not return an object_key (upload failed)"
    assert live["object_key"].startswith(f"customer_{OWNER_CUSTOMER_ID}/recordings/")


def test_ingest_persisted_db_row(live):
    assert "error" not in live, live.get("error")
    rid = live["recording_id"]
    row = _psql(
        "SELECT customer_id || '|' || kind || '|' || coalesce(object_key,'') "
        f"FROM recordings WHERE id = {int(rid)}"
    )
    cid, kind, key = row.split("|", 2)
    assert int(cid) == OWNER_CUSTOMER_ID
    assert kind == "call"
    assert key == live["object_key"]


def test_presigned_serve_returns_exact_bytes(live):
    assert "error" not in live, live.get("error")
    assert live["serve_status"] == 200, live
    assert live["ok"] is True
    # The presigned GET returns the exact bytes that were written to the spool.
    assert live["served_sha256"] == live["orig_sha256"], live
    assert live["served_len"] == live["orig_len"]
    assert "X-Amz-Signature" in live["presigned_url"]


def test_audio_endpoint_returns_presigned_json(live):
    """GET /v1/recordings/{id}/audio (owner token) → 200 JSON with a presigned URL.

    SHOULD-FIX (a): the endpoint returns the presigned URL as JSON (like
    voicemail), no 307 redirect and no ?token= JWT-in-URL.
    """
    token = _token(live["_secret"], OWNER_CUSTOMER_ID)
    r = requests.get(
        f"{API_BASE}/v1/recordings/{live['recording_id']}/audio",
        headers={"Authorization": f"Bearer {token}"},
        allow_redirects=False,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "X-Amz-Signature" in body.get("url", ""), body
    assert body.get("expires_in")


def test_list_includes_recording_for_owner(live):
    token = _token(live["_secret"], OWNER_CUSTOMER_ID)
    r = requests.get(
        f"{API_BASE}/v1/recordings?call_uuid=call-{live['recording_uuid']}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200, r.text
    ids = {row.get("id") for row in r.json()}
    assert live["recording_id"] in ids


def test_ingest_is_jwt_exempt_but_requires_secret(env_guard):
    """The ingest endpoint must be JWT-exempt (FreeSWITCH has no token) yet, with
    SEC-2, require the shared X-Ingest-Secret. With the correct secret (and NO JWT)
    it returns the resilient always-200 body."""
    secret = _ingest_secret()
    if not secret:
        pytest.skip("INGEST_SHARED_SECRET not set in API container (dev-allow mode)")
    r = requests.post(
        f"{API_BASE}/v1/recordings/ingest",
        headers={"X-Ingest-Secret": secret},
        json={"recording_uuid": "", "customer_id": None, "spool_path": ""},
    )
    # JWT-exempt + correct secret: 200, error handled internally (missing fields).
    assert r.status_code == 200, r.text
    assert r.json().get("status") == "error"


def test_ingest_without_secret_is_rejected(env_guard):
    """SEC-2: an ingest POST WITHOUT the shared secret is rejected (401), not
    silently trusted. (Skips in dev-allow mode where the secret is unset.)"""
    secret = _ingest_secret()
    if not secret:
        pytest.skip("INGEST_SHARED_SECRET not set in API container (dev-allow mode)")
    r = requests.post(
        f"{API_BASE}/v1/recordings/ingest",
        json={"recording_uuid": "x", "customer_id": 1, "spool_path": ""},
    )
    assert r.status_code in DENIED, r.text


def test_ingest_with_wrong_secret_is_rejected(env_guard):
    """SEC-2: a wrong shared secret is rejected (constant-time compare)."""
    secret = _ingest_secret()
    if not secret:
        pytest.skip("INGEST_SHARED_SECRET not set in API container (dev-allow mode)")
    r = requests.post(
        f"{API_BASE}/v1/recordings/ingest",
        headers={"X-Ingest-Secret": secret + "_wrong"},
        json={"recording_uuid": "x", "customer_id": 1, "spool_path": ""},
    )
    assert r.status_code in DENIED, r.text
