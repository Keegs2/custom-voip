"""Ciphertext object storage for encrypted voicemail (contract §2).

Only CIPHERTEXT ever reaches an object store. Object keys are
``c/{customer}/mb/{mailbox}/m/{uuid}.enc`` (messages) and
``c/{customer}/mb/{mailbox}/g/{uuid}.enc`` (greetings) — validated here so no
caller can write outside that layout.

* :class:`GcsObjectStore` (production): google-cloud-storage, blocking calls
  run on the voicemail I/O thread pool (``_gcp.call_with_retries``). Upload
  sends a CRC32C the server validates, and the
  CRC32C GCS reports for the stored object is compared with ours (mismatch ->
  the object is deleted and VoicemailIntegrityError). Download fetches the
  object metadata, refuses anything over 16 MiB, downloads that exact
  generation with client-side CRC32C validation, and re-checks our CRC32C
  against the stored value. Delete is idempotent (404 = ok). Every call: (5 s
  connect, 20 s read) timeout, at most 3 attempts on transient errors, library
  retry disabled. The bucket handle is built with ``client.bucket(name)`` — NO
  bucket metadata call: the runtime SA has no ``storage.buckets.get``.
  IAM used: storage.objects.{create,get,delete} on the bucket
  (roles/storage.objectAdmin; uploads overwrite on a deposit retry, which
  also needs storage.objects.delete).
* :class:`MemoryObjectStore` (tests/dev ONLY): selected by
  ``VOICEMAIL_STORAGE=memory`` and refused unless
  ``VOICEMAIL_ALLOW_LOCAL_KMS=true`` (never when ENV/ENVIRONMENT=production).
"""
from __future__ import annotations

import base64
import binascii
import logging
import re
import threading
from typing import Any, Callable, Protocol, runtime_checkable

from . import _gcp
from ._crc import crc32c
from .config import (
    VoicemailConfig,
    load_config,
    require_gcs_config,
    require_local_backends_permitted,
)
from .errors import (
    VoicemailCryptoUnavailable,
    VoicemailIntegrityError,
    VoicemailObjectNotFound,
)

logger = logging.getLogger(__name__)

#: Hard ceiling for one ciphertext object (deposit cap 10 MB + GCM tag; greeting 5 MB).
MAX_OBJECT_BYTES = 16 * 1024 * 1024
#: (connect, read) seconds per GCS request.
GCS_TIMEOUT_S = (5.0, 20.0)
GCS_MAX_ATTEMPTS = 3

_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
OBJECT_KEY_RE = re.compile(
    rf"c/([1-9][0-9]{{0,9}})/mb/([1-9][0-9]{{0,9}})/([mg])/({_UUID})\.enc", re.ASCII)


def validate_object_key(object_key: str) -> str:
    """Return ``object_key`` if it has the voicemail layout, else ValueError."""
    if not isinstance(object_key, str) or not OBJECT_KEY_RE.fullmatch(object_key):
        raise ValueError("invalid voicemail object key")
    return object_key


def _decode_gcs_crc32c(value: str | None) -> int | None:
    """GCS reports crc32c as base64 of the big-endian 4-byte value."""
    if not value:
        return None
    try:
        raw = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        return None
    return int.from_bytes(raw, "big") if len(raw) == 4 else None


@runtime_checkable
class ObjectStore(Protocol):
    name: str

    async def put(self, object_key: str, data: bytes, *, crc32c: int) -> None:
        """Store ciphertext; the store verifies ``crc32c`` end to end."""
        ...

    async def get(self, object_key: str) -> bytes:
        """Fetch ciphertext, verified against the store's own checksum.
        Missing -> VoicemailObjectNotFound."""
        ...

    async def delete(self, object_key: str) -> None:
        """Delete; a missing object is success (idempotent)."""
        ...


# ===========================================================================
# In-memory (tests/dev)
# ===========================================================================
class MemoryObjectStore:
    """Dict-backed store with GCS-like CRC32C semantics. Tests/dev only."""

    name = "memory"

    def __init__(self) -> None:
        self._objects: dict[str, tuple[bytes, int]] = {}
        self._lock = threading.Lock()

    async def put(self, object_key: str, data: bytes, *, crc32c: int) -> None:  # noqa: A002
        validate_object_key(object_key)
        data = bytes(data)
        if len(data) > MAX_OBJECT_BYTES:
            raise ValueError("object too large")
        if _crc_of(data) != crc32c:
            raise VoicemailIntegrityError("upload CRC32C mismatch")
        with self._lock:
            self._objects[object_key] = (data, crc32c)

    async def get(self, object_key: str) -> bytes:
        validate_object_key(object_key)
        with self._lock:
            entry = self._objects.get(object_key)
        if entry is None:
            raise VoicemailObjectNotFound("voicemail object not found")
        data, stored_crc = entry
        if _crc_of(data) != stored_crc:
            raise VoicemailIntegrityError("stored object failed its CRC32C check")
        return data

    async def delete(self, object_key: str) -> None:
        validate_object_key(object_key)
        with self._lock:
            self._objects.pop(object_key, None)

    # -- test helpers --------------------------------------------------------
    def keys(self) -> list[str]:
        with self._lock:
            return sorted(self._objects)

    def raw(self, object_key: str) -> bytes | None:
        with self._lock:
            entry = self._objects.get(object_key)
        return entry[0] if entry else None

    def replace_raw(self, object_key: str, data: bytes, *, keep_stored_crc: bool) -> None:
        """Overwrite an object's bytes (tamper/swap simulation). With
        ``keep_stored_crc`` the store's own checksum no longer matches (bit-rot);
        without it the bytes look internally consistent (a swapped object)."""
        with self._lock:
            old = self._objects.get(object_key)
            crc = old[1] if (keep_stored_crc and old) else _crc_of(data)
            self._objects[object_key] = (bytes(data), crc)

    def clear(self) -> None:
        with self._lock:
            self._objects.clear()


def _crc_of(data: bytes) -> int:
    return crc32c(data)


# ===========================================================================
# Google Cloud Storage
# ===========================================================================
_RETRYABLE_NAMES = (
    ("google.api_core.exceptions", "TooManyRequests"),
    ("google.api_core.exceptions", "InternalServerError"),
    ("google.api_core.exceptions", "BadGateway"),
    ("google.api_core.exceptions", "ServiceUnavailable"),
    ("google.api_core.exceptions", "GatewayTimeout"),
    ("google.auth.exceptions", "TransportError"),
    ("requests.exceptions", "ConnectionError"),
    ("requests.exceptions", "Timeout"),
    ("requests.exceptions", "ChunkedEncodingError"),
    ("builtins", "ConnectionError"),
)


def _retryable() -> tuple[type[BaseException], ...]:
    """Transient GCS errors (429/5xx/connection). Resolved lazily so importing
    this module does not import the GCP libraries."""
    return _gcp.exception_types(_RETRYABLE_NAMES)


class GcsObjectStore:
    """Cloud Storage ciphertext store (production)."""

    name = "gcs"

    def __init__(self, cfg: VoicemailConfig, *, client: Any = None):
        require_gcs_config(cfg)
        self._cfg = cfg
        self._client = client
        self._bucket = None
        self._lock = threading.Lock()

    def _get_bucket(self):
        """Lazy client + bucket handle (blocking; worker thread). NO API call:
        ``client.bucket()`` only builds a handle (no storage.buckets.get)."""
        if self._bucket is None:
            with self._lock:
                if self._bucket is None:
                    if self._client is None:
                        try:
                            from google.cloud import storage
                        except ImportError as exc:  # pragma: no cover
                            raise VoicemailCryptoUnavailable(
                                "google-cloud-storage is not installed") from exc
                        creds = _gcp.get_credentials(self._cfg)
                        self._client = storage.Client(
                            project=self._cfg.kms_project or None, credentials=creds)
                    self._bucket = self._client.bucket(self._cfg.bucket)
        return self._bucket

    async def _io(self, op: str, fn: Callable[[], Any]) -> Any:
        try:
            return await _gcp.call_with_retries(
                f"GCS {op}", fn, retryable=_retryable(), attempts=GCS_MAX_ATTEMPTS)
        except (VoicemailCryptoUnavailable, VoicemailIntegrityError):
            raise
        except Exception as exc:  # noqa: BLE001 — fail closed
            if type(exc).__name__ == "DataCorruption":
                logger.error("voicemail GCS %s: checksum mismatch: %s", op, exc)
                raise VoicemailIntegrityError(f"GCS {op}: CRC32C mismatch") from exc
            logger.error("voicemail GCS %s failed: %s: %s", op, type(exc).__name__, exc)
            raise VoicemailCryptoUnavailable(
                f"GCS {op} failed: {type(exc).__name__}") from exc

    async def put(self, object_key: str, data: bytes, *, crc32c: int) -> None:  # noqa: A002
        validate_object_key(object_key)
        data = bytes(data)
        if len(data) > MAX_OBJECT_BYTES:
            raise ValueError("object too large")
        if _crc_of(data) != crc32c:
            raise VoicemailIntegrityError("upload CRC32C does not match the data")

        def _upload() -> str | None:
            blob = self._get_bucket().blob(object_key)
            # checksum="crc32c": computed over these exact bytes and sent with
            # the upload; GCS rejects the write on mismatch.
            blob.upload_from_string(
                data, content_type="application/octet-stream", checksum="crc32c",
                timeout=GCS_TIMEOUT_S, retry=None)
            return blob.crc32c

        stored = _decode_gcs_crc32c(await self._io("upload", _upload))
        if stored != crc32c:
            logger.error("voicemail GCS upload: stored CRC32C differs for %s — deleting", object_key)
            try:
                await self.delete(object_key)
            except Exception:  # noqa: BLE001 — best effort
                logger.exception("voicemail GCS: cleanup delete failed for %s", object_key)
            raise VoicemailIntegrityError("GCS upload: stored CRC32C does not match")

    async def get(self, object_key: str) -> bytes:
        validate_object_key(object_key)

        def _download():
            bucket = self._get_bucket()
            blob = bucket.get_blob(object_key, timeout=GCS_TIMEOUT_S, retry=None)
            if blob is None:
                return None
            if blob.size is None or blob.size > MAX_OBJECT_BYTES:
                raise VoicemailIntegrityError("GCS object has an unexpected size")
            stored_crc = _decode_gcs_crc32c(blob.crc32c)
            payload = blob.download_as_bytes(
                checksum="crc32c", if_generation_match=blob.generation,
                timeout=GCS_TIMEOUT_S, retry=None)
            return payload, stored_crc

        result = await self._io("download", _download)
        if result is None:
            raise VoicemailObjectNotFound("voicemail object not found")
        payload, stored_crc = result
        if stored_crc is None or _crc_of(payload) != stored_crc:
            raise VoicemailIntegrityError("GCS object failed its stored CRC32C check")
        return payload

    async def delete(self, object_key: str) -> None:
        validate_object_key(object_key)

        def _delete() -> None:
            from google.api_core.exceptions import NotFound
            try:
                self._get_bucket().blob(object_key).delete(timeout=GCS_TIMEOUT_S, retry=None)
            except NotFound:
                return

        await self._io("delete", _delete)


# ===========================================================================
# Registry
# ===========================================================================
_stores_lock = threading.Lock()
_stores: dict[tuple, ObjectStore] = {}


def get_object_store() -> ObjectStore:
    """Return the (cached, per-process) configured object store.
    ``VOICEMAIL_STORAGE`` = ``gcs`` (default) | ``memory`` (tests/dev, gated)."""
    cfg = load_config()
    backend = cfg.storage_backend
    if backend == "memory":
        require_local_backends_permitted(cfg, "the in-memory voicemail object store")
        cache_key: tuple = ("memory",)
        factory: Callable[[], ObjectStore] = MemoryObjectStore
    elif backend == "gcs":
        require_gcs_config(cfg)
        cache_key = ("gcs", cfg.bucket, cfg.kms_project, cfg.impersonate_sa)
        factory = lambda: GcsObjectStore(cfg)
    else:
        raise VoicemailCryptoUnavailable(f"unknown VOICEMAIL_STORAGE {backend!r}")
    with _stores_lock:
        store = _stores.get(cache_key)
        if store is None:
            store = factory()
            _stores[cache_key] = store
        return store


def reset_object_stores() -> None:
    """Test hook: drop cached stores (memory contents included)."""
    with _stores_lock:
        _stores.clear()
