"""S3-compatible object storage abstraction (Phase 4).

A thin, dependency-light wrapper over boto3's S3 client, configured from the
``STORAGE_*`` environment contract. Works against MinIO locally (path-style
addressing, http endpoint) and against AWS S3 / GCS-S3 in production.

Design notes
------------
* **Tenant scoping is mandatory.** Every object key MUST be prefixed with
  ``customer_{id}/`` so one customer's media can never collide with or be
  enumerated alongside another's. Use :func:`tenant_key` to build keys.
* **ensure_buckets() is idempotent + retried** so it is safe to call on every
  API startup, even before MinIO has finished booting.
* The boto3 client is created lazily and cached; importing this module never
  touches the network, so it is safe to import in tooling/tests.
"""
import io
import os
import logging
import threading
import time
from typing import Optional, Union

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------
# Configuration (read once at import; all overridable via env)
# --------------------------------------------------------------------------
STORAGE_ENDPOINT_URL = os.getenv("STORAGE_ENDPOINT_URL", "http://minio:9000")
# Optional separate endpoint used when minting presigned URLs (e.g. a public
# hostname the browser can reach). Defaults to the internal endpoint.
STORAGE_PUBLIC_ENDPOINT_URL = os.getenv("STORAGE_PUBLIC_ENDPOINT_URL", "") or STORAGE_ENDPOINT_URL
STORAGE_ACCESS_KEY = os.getenv("STORAGE_ACCESS_KEY", "minioadmin")
STORAGE_SECRET_KEY = os.getenv("STORAGE_SECRET_KEY", "minioadmin")
STORAGE_REGION = os.getenv("STORAGE_REGION", "us-east-1")
STORAGE_FORCE_PATH_STYLE = os.getenv("STORAGE_FORCE_PATH_STYLE", "true").lower() == "true"

BUCKET_RECORDINGS = os.getenv("STORAGE_BUCKET_RECORDINGS", "voip-recordings")
BUCKET_VOICEMAIL = os.getenv("STORAGE_BUCKET_VOICEMAIL", "voip-voicemail")
BUCKET_UPLOADS = os.getenv("STORAGE_BUCKET_UPLOADS", "voip-uploads")

ALL_BUCKETS = (BUCKET_RECORDINGS, BUCKET_VOICEMAIL, BUCKET_UPLOADS)

# Default presigned-URL lifetime (seconds).
DEFAULT_PRESIGN_TTL = int(os.getenv("STORAGE_PRESIGN_TTL", "3600"))

_client = None
_client_lock = threading.Lock()


class StorageError(RuntimeError):
    """Raised when an object-storage operation fails unrecoverably."""


def _build_client(endpoint_url: str):
    """Construct a boto3 S3 client. Imported lazily so the module imports with
    no boto3 installed (e.g. lightweight tooling)."""
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        endpoint_url=endpoint_url,
        aws_access_key_id=STORAGE_ACCESS_KEY,
        aws_secret_access_key=STORAGE_SECRET_KEY,
        region_name=STORAGE_REGION,
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path" if STORAGE_FORCE_PATH_STYLE else "auto"},
            retries={"max_attempts": 3, "mode": "standard"},
        ),
    )


def get_client():
    """Return the cached internal S3 client, creating it on first use."""
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                _client = _build_client(STORAGE_ENDPOINT_URL)
    return _client


def _presign_client():
    """Client used only for presigned URLs.

    When STORAGE_PUBLIC_ENDPOINT_URL differs from the internal endpoint, a
    dedicated client is built so the signed host matches what the caller can
    actually reach. Otherwise the shared client is reused.
    """
    if STORAGE_PUBLIC_ENDPOINT_URL == STORAGE_ENDPOINT_URL:
        return get_client()
    return _build_client(STORAGE_PUBLIC_ENDPOINT_URL)


# --------------------------------------------------------------------------
# Key helpers — tenant scoping is NOT optional
# --------------------------------------------------------------------------
def tenant_key(customer_id: int, *parts: str) -> str:
    """Build a tenant-scoped object key: ``customer_{id}/part/part/...``.

    Each part is stripped of leading/trailing slashes so callers cannot escape
    the tenant prefix via an absolute path component.
    """
    if customer_id is None:
        raise ValueError("customer_id is required for a tenant-scoped key")
    clean = [f"customer_{int(customer_id)}"]
    for p in parts:
        seg = str(p).strip("/")
        if seg:
            clean.append(seg)
    return "/".join(clean)


# --------------------------------------------------------------------------
# Bucket lifecycle
# --------------------------------------------------------------------------
def ensure_buckets(retries: int = 10, backoff: float = 2.0) -> None:
    """Create the three platform buckets if they do not exist (idempotent).

    Retries on transient connection errors so it can be called at API startup
    before MinIO has finished initialising. Never raises on
    already-exists; raises StorageError only if it cannot reach storage after
    all retries.
    """
    last_err: Optional[Exception] = None
    for attempt in range(1, retries + 1):
        try:
            client = get_client()
            existing = {b["Name"] for b in client.list_buckets().get("Buckets", [])}
            for bucket in ALL_BUCKETS:
                if bucket in existing:
                    continue
                try:
                    client.create_bucket(Bucket=bucket)
                    logger.info("Created object-storage bucket: %s", bucket)
                except Exception as e:  # noqa: BLE001 - normalise already-exists
                    name = e.__class__.__name__
                    if "BucketAlreadyOwnedByYou" in name or "BucketAlreadyExists" in name:
                        continue
                    raise
            logger.info("Object storage ready; buckets present: %s", ", ".join(ALL_BUCKETS))
            return
        except Exception as e:  # noqa: BLE001
            last_err = e
            logger.warning(
                "ensure_buckets attempt %d/%d failed: %s", attempt, retries, e
            )
            if attempt < retries:
                time.sleep(backoff)
    raise StorageError(f"Could not ensure storage buckets after {retries} attempts: {last_err}")


# --------------------------------------------------------------------------
# Object operations
# --------------------------------------------------------------------------
def put_file(
    bucket: str,
    key: str,
    path_or_bytes: Union[str, bytes, bytearray],
    content_type: Optional[str] = None,
) -> str:
    """Upload a file (from a local path) or a bytes object to ``bucket/key``.

    Returns the object key on success. Raises StorageError on failure.
    """
    extra = {"ContentType": content_type} if content_type else {}
    client = get_client()
    try:
        if isinstance(path_or_bytes, (bytes, bytearray)):
            client.upload_fileobj(
                io.BytesIO(bytes(path_or_bytes)), bucket, key,
                ExtraArgs=extra or None,
            )
        else:
            client.upload_file(path_or_bytes, bucket, key, ExtraArgs=extra or None)
    except Exception as e:  # noqa: BLE001
        raise StorageError(f"put_file failed for {bucket}/{key}: {e}") from e
    return key


def get_bytes(bucket: str, key: str) -> bytes:
    """Download an object and return its raw bytes."""
    client = get_client()
    try:
        resp = client.get_object(Bucket=bucket, Key=key)
        return resp["Body"].read()
    except Exception as e:  # noqa: BLE001
        raise StorageError(f"get_bytes failed for {bucket}/{key}: {e}") from e


def presigned_get_url(bucket: str, key: str, ttl: int = DEFAULT_PRESIGN_TTL) -> str:
    """Return a time-limited presigned GET URL for ``bucket/key``."""
    client = _presign_client()
    try:
        return client.generate_presigned_url(
            "get_object",
            Params={"Bucket": bucket, "Key": key},
            ExpiresIn=ttl,
        )
    except Exception as e:  # noqa: BLE001
        raise StorageError(f"presign failed for {bucket}/{key}: {e}") from e


def delete(bucket: str, key: str) -> None:
    """Delete an object (best-effort; missing keys are not an error in S3)."""
    client = get_client()
    try:
        client.delete_object(Bucket=bucket, Key=key)
    except Exception as e:  # noqa: BLE001
        raise StorageError(f"delete failed for {bucket}/{key}: {e}") from e
