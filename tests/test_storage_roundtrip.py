"""Live object-storage round-trip test (Phase 4).

Exercises the real `services.storage` module inside the running API container
against live MinIO: ensure_buckets -> put_file -> presigned_get_url -> HTTP GET,
asserting the bytes round-trip exactly and that the three platform buckets exist.

Runs the storage calls *inside* the `voip-api` container (which has boto3 +
httpx and network access to minio:9000) via `docker exec`, so the host needs no
boto3. Skips cleanly if Docker / the api container is unavailable.

Run:  python3 -m pytest tests/test_storage_roundtrip.py -v
"""
import json
import shutil
import subprocess

import pytest

API_CONTAINER = "voip-api"

# Self-contained snippet executed inside the API container. It uses the SAME
# services.storage module the app uses, then fetches the presigned URL over HTTP
# to prove an end-to-end private-object round-trip.
_INNER = r"""
import os, sys, json, uuid
sys.path.insert(0, "/app")
import httpx
from services import storage

out = {}
try:
    storage.ensure_buckets()
    client = storage.get_client()
    buckets = sorted(b["Name"] for b in client.list_buckets().get("Buckets", []))
    out["buckets"] = buckets

    payload = ("roundtrip-" + uuid.uuid4().hex + "-éñ☃").encode("utf-8")
    key = storage.tenant_key(99999, "selftest", uuid.uuid4().hex + ".bin")
    storage.put_file(storage.BUCKET_UPLOADS, key, payload, "application/octet-stream")
    url = storage.presigned_get_url(storage.BUCKET_UPLOADS, key, ttl=120)
    out["presigned_url"] = url

    r = httpx.get(url, timeout=15)
    got = r.content
    out["http_status"] = r.status_code
    out["bytes_match"] = (got == payload)
    out["len"] = len(got)

    storage.delete(storage.BUCKET_UPLOADS, key)
    out["ok"] = (r.status_code == 200 and got == payload)
except Exception as e:
    out["error"] = repr(e)
    out["ok"] = False
print("RESULT_JSON:" + json.dumps(out))
"""


def _docker_available() -> bool:
    if not shutil.which("docker"):
        return False
    r = subprocess.run(
        ["docker", "inspect", "-f", "{{.State.Running}}", API_CONTAINER],
        capture_output=True, text=True,
    )
    return r.returncode == 0 and r.stdout.strip() == "true"


@pytest.fixture(scope="module")
def storage_result():
    if not _docker_available():
        pytest.skip(f"{API_CONTAINER} container not running; storage round-trip needs live stack")
    proc = subprocess.run(
        ["docker", "exec", "-i", API_CONTAINER, "python", "-c", _INNER],
        capture_output=True, text=True, timeout=180,
    )
    line = None
    for ln in proc.stdout.splitlines():
        if ln.startswith("RESULT_JSON:"):
            line = ln[len("RESULT_JSON:"):]
            break
    assert line is not None, (
        f"no RESULT_JSON from container.\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
    )
    return json.loads(line)


def test_three_buckets_exist(storage_result):
    """ensure_buckets() created the three platform buckets in live MinIO."""
    assert "error" not in storage_result, storage_result.get("error")
    buckets = set(storage_result["buckets"])
    for b in ("voip-recordings", "voip-voicemail", "voip-uploads"):
        assert b in buckets, f"bucket {b} missing; have {sorted(buckets)}"


def test_presigned_roundtrip_bytes_match(storage_result):
    """put -> presign -> HTTP GET returns the exact bytes that were stored."""
    assert "error" not in storage_result, storage_result.get("error")
    assert storage_result["http_status"] == 200
    assert storage_result["bytes_match"] is True
    assert storage_result["ok"] is True


def test_presigned_url_is_time_limited(storage_result):
    """A presigned GET URL carries the SigV4 query params (it is not a raw,
    permanently-public object URL)."""
    url = storage_result["presigned_url"]
    assert "X-Amz-Signature" in url and "X-Amz-Expires" in url, url
