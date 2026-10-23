"""KEK providers for encrypted voicemail (contract §2, decision D1).

One key-encryption key per customer wraps a fresh per-object AES-256-GCM DEK.
The DEK wrap/unwrap is bound to the object's AAD (``vm:{c}:{m}:{uuid}`` /
``vmg:{c}:{m}:{uuid}``), so a wrapped DEK copied onto another row does not
unwrap.

* :class:`GcpKmsProvider` (production): Cloud KMS key
  ``{keyring}/cryptoKeys/vm-cust-{customer_id}``, purpose ENCRYPT_DECRYPT,
  protection SOFTWARE, rotation 365 d, ``destroy_scheduled_duration`` 24 h,
  created on first use (AlreadyExists handled). Every Encrypt/Decrypt carries
  the AAD as ``additional_authenticated_data`` plus request CRC32Cs, and the
  response CRC32C/verified flags are checked per Google's data-integrity
  guidance. The CryptoKeyVersion that wrapped the DEK (``EncryptResponse.name``)
  is returned as ``kek_version``. Every RPC: 5 s timeout, at most 3 attempts on
  UNAVAILABLE / DEADLINE_EXCEEDED, library retry disabled. Erase destroys every
  ENABLED/DISABLED version, verifies by re-listing, then clears the rotation
  schedule (warning-only) so KMS does not mint a fresh primary a year later.

  IAM used (keyring ``voicemail-prod``): cloudkms.cryptoKeys.{create,get,update},
  cloudkms.cryptoKeyVersions.{list,get,destroy}, and
  roles/cloudkms.cryptoKeyEncrypterDecrypter (useToEncrypt/useToDecrypt). No
  version create/enable/disable/restore, no IAM-policy reads.

* :class:`LocalKmsProvider` (dev/CI ONLY): per-customer KEK =
  HKDF-SHA256(``VOICEMAIL_LOCAL_MASTER_KEY``, info=b"vm-cust-{id}"), wrap =
  AES-256-GCM with the same AAD. Refused unless ``VOICEMAIL_ALLOW_LOCAL_KMS=true``
  (and never when ENV/ENVIRONMENT=production). Erase is logical only (the key
  row is marked destroyed and every later use is refused); ``rotate()``
  simulates a key rotation for tests.

Clients are created lazily inside worker threads — importing this module
needs neither GCP credentials nor network access.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import logging
import os
import re
import struct
import threading
import time
from typing import Any, Callable, Protocol, runtime_checkable

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from . import _gcp
from ._crc import crc32c
from .config import (
    VoicemailConfig,
    load_config,
    require_gcp_kms_config,
    require_local_backends_permitted,
)
from .errors import VoicemailCryptoUnavailable, VoicemailIntegrityError

logger = logging.getLogger(__name__)

DEK_BYTES = 32
GCM_NONCE_BYTES = 12

#: Per-RPC deadline (seconds) — contract: <= 5 s per KMS operation.
KMS_RPC_TIMEOUT_S = 5.0
#: Total tries per KMS operation on UNAVAILABLE / DEADLINE_EXCEEDED.
KMS_MAX_ATTEMPTS = 3
KEY_ROTATION_PERIOD_S = 365 * 24 * 3600
KEY_DESTROY_SCHEDULED_S = 24 * 3600
#: Destroy/verify passes in an erase (a concurrent auto-rotation can add a
#: version between the list and the destroys; the re-list catches it).
ERASE_MAX_ROUNDS = 3

_KEY_REF_RE = re.compile(
    r"projects/[^/\s]+/locations/[^/\s]+/keyRings/[^/\s]+/cryptoKeys/vm-cust-([1-9][0-9]{0,9})",
    re.ASCII,
)
_LOCAL_KEY_REF_RE = re.compile(r"local:([1-9][0-9]{0,9})", re.ASCII)


def _zero(buf: bytearray) -> None:
    """Best-effort scrub of a mutable buffer (Python cannot guarantee that no
    other copy exists — library calls make their own)."""
    for i in range(len(buf)):
        buf[i] = 0


def _check_customer_id(customer_id: Any) -> int:
    if isinstance(customer_id, bool) or not isinstance(customer_id, int) or customer_id <= 0:
        raise ValueError("customer_id must be a positive int")
    return customer_id


@runtime_checkable
class KmsProvider(Protocol):
    """Per-customer KEK operations. ``key_ref`` is the persisted
    ``voicemail_customer_keys.key_ref`` for that customer."""

    name: str

    async def ensure_key(self, customer_id: int) -> str:
        """Create the customer's KEK if missing (idempotent); return key_ref."""
        ...

    async def wrap_dek(self, *, customer_id: int, key_ref: str,
                       dek: bytes | bytearray, aad: bytes) -> tuple[bytes, str]:
        """Wrap a 32-byte DEK bound to ``aad`` -> (wrapped_dek, kek_version)."""
        ...

    async def unwrap_dek(self, *, customer_id: int, key_ref: str,
                         wrapped_dek: bytes, aad: bytes) -> bytearray:
        """Unwrap -> the DEK in a bytearray the caller must zero after use."""
        ...

    async def destroy_key(self, *, customer_id: int, key_ref: str | None) -> list[str]:
        """Crypto-erase: destroy every usable key version; return the names
        of the versions this call scheduled for destruction."""
        ...


# ===========================================================================
# Cloud KMS
# ===========================================================================
_RETRYABLE_NAMES = (
    ("google.api_core.exceptions", "ServiceUnavailable"),
    ("google.api_core.exceptions", "DeadlineExceeded"),
    ("google.auth.exceptions", "TransportError"),
)


def _retryable() -> tuple[type[BaseException], ...]:
    """UNAVAILABLE / DEADLINE_EXCEEDED (+ auth transport hiccups). Resolved
    lazily so importing this module does not import grpc."""
    return _gcp.exception_types(_RETRYABLE_NAMES)


def _gexc():
    from google.api_core import exceptions as gexc
    return gexc


class GcpKmsProvider:
    """Cloud KMS KEK provider (production)."""

    name = "gcpkms"

    def __init__(self, cfg: VoicemailConfig, *, client: Any = None):
        require_gcp_kms_config(cfg)
        self._cfg = cfg
        self._client = client
        self._client_lock = threading.Lock()

    # -- plumbing ------------------------------------------------------------
    def _get_client(self):
        """Lazily build the KMS client (blocking; runs in a worker thread)."""
        if self._client is None:
            with self._client_lock:
                if self._client is None:
                    try:
                        from google.cloud import kms
                    except ImportError as exc:  # pragma: no cover
                        raise VoicemailCryptoUnavailable(
                            "google-cloud-kms is not installed") from exc
                    creds = _gcp.get_credentials(self._cfg)
                    self._client = kms.KeyManagementServiceClient(credentials=creds)
        return self._client

    async def _rpc(self, op: str, call: Callable[[Any], Any], *,
                   passthrough: tuple[type[BaseException], ...] = ()):
        """Run ``call(client)`` with the bounded retry policy; translate
        failures to VoicemailCryptoUnavailable (``passthrough`` re-raised)."""
        try:
            return await _gcp.call_with_retries(
                f"KMS {op}", lambda: call(self._get_client()),
                retryable=_retryable(), attempts=KMS_MAX_ATTEMPTS)
        except passthrough:
            raise
        except (VoicemailCryptoUnavailable, VoicemailIntegrityError):
            raise
        except Exception as exc:  # noqa: BLE001 — every other failure fails closed
            raise self._translate(op, exc) from exc

    @staticmethod
    def _translate(op: str, exc: BaseException) -> VoicemailCryptoUnavailable:
        gexc = _gexc()
        if isinstance(exc, (gexc.PermissionDenied, gexc.Unauthenticated)):
            reason = "permission denied (check the vm-api IAM grants on the voicemail keyring)"
        elif isinstance(exc, gexc.NotFound):
            reason = "key or keyring not found"
        elif isinstance(exc, gexc.FailedPrecondition):
            reason = "key version not usable (disabled, destroyed or scheduled for destruction)"
        elif isinstance(exc, _retryable()):
            reason = f"unavailable after {KMS_MAX_ATTEMPTS} attempts ({type(exc).__name__})"
        else:
            reason = type(exc).__name__
        logger.error("voicemail KMS %s failed: %s: %s", op, type(exc).__name__, exc)
        return VoicemailCryptoUnavailable(f"KMS {op} failed: {reason}")

    @staticmethod
    def _check_key_ref(customer_id: int, key_ref: str) -> None:
        m = _KEY_REF_RE.fullmatch(key_ref or "")
        if not m or int(m.group(1)) != customer_id:
            raise VoicemailIntegrityError("KMS key_ref does not belong to this customer")

    def _kms_types(self):
        try:
            from google.cloud import kms
        except ImportError as exc:  # pragma: no cover
            raise VoicemailCryptoUnavailable("google-cloud-kms is not installed") from exc
        return kms

    def _check_usable_key(self, key: Any, expected_name: str) -> None:
        kms = self._kms_types()
        if key.name != expected_name:
            raise VoicemailCryptoUnavailable("KMS returned an unexpected crypto key name")
        if key.purpose != kms.CryptoKey.CryptoKeyPurpose.ENCRYPT_DECRYPT:
            raise VoicemailCryptoUnavailable(
                f"KMS key {expected_name} is not an ENCRYPT_DECRYPT key")
        if key.primary.state != kms.CryptoKeyVersion.CryptoKeyVersionState.ENABLED:
            raise VoicemailCryptoUnavailable(
                f"KMS key {expected_name} has no ENABLED primary version (crypto-erased?)")

    # -- KmsProvider ---------------------------------------------------------
    async def ensure_key(self, customer_id: int) -> str:
        _check_customer_id(customer_id)
        kms = self._kms_types()
        gexc = _gexc()
        parent = self._cfg.keyring_name
        key_id = f"vm-cust-{customer_id}"
        name = f"{parent}/cryptoKeys/{key_id}"
        crypto_key = {
            "purpose": kms.CryptoKey.CryptoKeyPurpose.ENCRYPT_DECRYPT,
            "version_template": {
                "protection_level": kms.ProtectionLevel.SOFTWARE,
                "algorithm": kms.CryptoKeyVersion.CryptoKeyVersionAlgorithm.GOOGLE_SYMMETRIC_ENCRYPTION,
            },
            "rotation_period": {"seconds": KEY_ROTATION_PERIOD_S},
            "next_rotation_time": {"seconds": int(time.time()) + KEY_ROTATION_PERIOD_S},
            "destroy_scheduled_duration": {"seconds": KEY_DESTROY_SCHEDULED_S},
            "labels": {"product": "voicemail", "customer-id": str(customer_id)},
        }
        try:
            key = await self._rpc(
                "create_crypto_key",
                lambda c: c.create_crypto_key(
                    request={"parent": parent, "crypto_key_id": key_id, "crypto_key": crypto_key},
                    timeout=KMS_RPC_TIMEOUT_S, retry=None),
                passthrough=(gexc.AlreadyExists,))
            logger.info("voicemail: created KMS key %s", name)
        except gexc.AlreadyExists:
            key = await self._rpc(
                "get_crypto_key",
                lambda c: c.get_crypto_key(request={"name": name},
                                           timeout=KMS_RPC_TIMEOUT_S, retry=None))
        self._check_usable_key(key, name)
        return name

    async def wrap_dek(self, *, customer_id: int, key_ref: str,
                       dek: bytes | bytearray, aad: bytes) -> tuple[bytes, str]:
        _check_customer_id(customer_id)
        self._check_key_ref(customer_id, key_ref)
        if len(dek) != DEK_BYTES:
            raise ValueError("DEK must be 32 bytes")
        aad = bytes(aad)
        request = {
            "name": key_ref,
            "plaintext": bytes(dek),
            "plaintext_crc32c": crc32c(dek),
            "additional_authenticated_data": aad,
            "additional_authenticated_data_crc32c": crc32c(aad),
        }
        try:
            resp = await self._rpc(
                "encrypt",
                lambda c: c.encrypt(request=request, timeout=KMS_RPC_TIMEOUT_S, retry=None))
        finally:
            request.clear()  # drop our reference to the DEK copy
        if not resp.verified_plaintext_crc32c:
            raise VoicemailIntegrityError("KMS encrypt: plaintext CRC32C was not verified")
        if not resp.verified_additional_authenticated_data_crc32c:
            raise VoicemailIntegrityError("KMS encrypt: AAD CRC32C was not verified")
        wrapped = bytes(resp.ciphertext)
        if resp.ciphertext_crc32c is None or int(resp.ciphertext_crc32c) != crc32c(wrapped):
            raise VoicemailIntegrityError("KMS encrypt: response ciphertext CRC32C mismatch")
        version = str(resp.name or "")
        if not version.startswith(key_ref + "/cryptoKeyVersions/"):
            raise VoicemailIntegrityError("KMS encrypt: response names an unexpected key version")
        return wrapped, version

    async def unwrap_dek(self, *, customer_id: int, key_ref: str,
                         wrapped_dek: bytes, aad: bytes) -> bytearray:
        _check_customer_id(customer_id)
        self._check_key_ref(customer_id, key_ref)
        gexc = _gexc()
        wrapped = bytes(wrapped_dek)
        aad = bytes(aad)
        request = {
            "name": key_ref,
            "ciphertext": wrapped,
            "ciphertext_crc32c": crc32c(wrapped),
            "additional_authenticated_data": aad,
            "additional_authenticated_data_crc32c": crc32c(aad),
        }
        try:
            resp = await self._rpc(
                "decrypt",
                lambda c: c.decrypt(request=request, timeout=KMS_RPC_TIMEOUT_S, retry=None),
                passthrough=(gexc.InvalidArgument,))
        except gexc.InvalidArgument as exc:
            # Wrong AAD, a wrapped DEK from another row/key, or corruption.
            logger.error("voicemail KMS decrypt rejected the wrapped DEK: %s", exc)
            raise VoicemailIntegrityError(
                "KMS rejected the wrapped DEK (AAD or ciphertext mismatch)") from exc
        plaintext = resp.plaintext
        if resp.plaintext_crc32c is None or int(resp.plaintext_crc32c) != crc32c(plaintext):
            raise VoicemailIntegrityError("KMS decrypt: response plaintext CRC32C mismatch")
        dek = bytearray(plaintext)
        del plaintext
        if len(dek) != DEK_BYTES:
            _zero(dek)
            raise VoicemailIntegrityError("KMS decrypt: unwrapped DEK has the wrong length")
        return dek

    async def destroy_key(self, *, customer_id: int, key_ref: str | None) -> list[str]:
        _check_customer_id(customer_id)
        if key_ref:
            self._check_key_ref(customer_id, key_ref)
            name = key_ref
        else:
            name = self._cfg.crypto_key_name(customer_id)
        kms = self._kms_types()
        gexc = _gexc()
        state = kms.CryptoKeyVersion.CryptoKeyVersionState
        destroyable = {state.ENABLED, state.DISABLED}
        not_yet_destroyable = {state.PENDING_GENERATION, state.PENDING_IMPORT}

        destroyed: list[str] = []
        for _round in range(ERASE_MAX_ROUNDS):
            try:
                versions = await self._rpc(
                    "list_crypto_key_versions",
                    lambda c: list(c.list_crypto_key_versions(
                        request={"parent": name}, timeout=KMS_RPC_TIMEOUT_S, retry=None)),
                    passthrough=(gexc.NotFound,))
            except gexc.NotFound:
                return destroyed  # the key never existed: nothing to erase
            live = [v for v in versions if v.state in destroyable]
            pending = [v for v in versions if v.state in not_yet_destroyable]
            if not live and not pending:
                await self._clear_rotation(name)
                return destroyed
            for version in live:
                version_name = version.name
                try:
                    await self._rpc(
                        "destroy_crypto_key_version",
                        lambda c, n=version_name: c.destroy_crypto_key_version(
                            request={"name": n}, timeout=KMS_RPC_TIMEOUT_S, retry=None),
                        passthrough=(gexc.FailedPrecondition,))
                    destroyed.append(version_name)
                except gexc.FailedPrecondition:
                    # Raced with another erase (already DESTROY_SCHEDULED) —
                    # the verification re-list decides.
                    logger.warning("voicemail erase: %s not destroyable right now", version_name)
        raise VoicemailCryptoUnavailable(
            f"crypto-erase incomplete: key versions of customer {customer_id} are still "
            f"usable after {ERASE_MAX_ROUNDS} passes — re-run the erase")

    async def _clear_rotation(self, name: str) -> None:
        """Stop automatic rotation minting a fresh primary after an erase.
        Failure is a logged warning — the erase itself already succeeded."""
        try:
            await self._rpc(
                "update_crypto_key",
                lambda c: c.update_crypto_key(
                    request={"crypto_key": {"name": name},
                             "update_mask": {"paths": ["rotation_period", "next_rotation_time"]}},
                    timeout=KMS_RPC_TIMEOUT_S, retry=None))
        except VoicemailCryptoUnavailable as exc:
            logger.warning("voicemail erase: could not clear the rotation schedule of %s: %s",
                           name, exc)


# ===========================================================================
# Local (dev/CI only)
# ===========================================================================
_LOCAL_MAGIC = b"VMLK"
_LOCAL_HEADER = struct.Struct(">4sI")  # magic, key version


class LocalKmsProvider:
    """HKDF-derived per-customer KEKs from one local master key. DEV/CI ONLY."""

    name = "local"

    def __init__(self, cfg: VoicemailConfig):
        require_local_backends_permitted(cfg, "the local KMS provider")
        try:
            master = base64.b64decode(cfg.local_master_key_b64, validate=True)
        except (binascii.Error, ValueError):
            master = b""
        if len(master) != 32:
            raise VoicemailCryptoUnavailable(
                "VOICEMAIL_LOCAL_MASTER_KEY must be base64 of exactly 32 random bytes")
        self._master = master
        self._primary_version = 1
        self._lock = threading.Lock()

    def rotate(self) -> int:
        """Simulate a KMS key rotation: new wraps use the next version; every
        older version keeps unwrapping. Returns the new primary version."""
        with self._lock:
            self._primary_version += 1
            return self._primary_version

    @staticmethod
    def _check_key_ref(customer_id: int, key_ref: str) -> None:
        m = _LOCAL_KEY_REF_RE.fullmatch(key_ref or "")
        if not m or int(m.group(1)) != customer_id:
            raise VoicemailIntegrityError("local key_ref does not belong to this customer")

    def _kek(self, customer_id: int, version: int) -> bytearray:
        info = (f"vm-cust-{customer_id}" if version == 1
                else f"vm-cust-{customer_id}:v{version}").encode()
        return bytearray(HKDF(algorithm=hashes.SHA256(), length=32, salt=None,
                              info=info).derive(self._master))

    async def ensure_key(self, customer_id: int) -> str:
        return f"local:{_check_customer_id(customer_id)}"

    async def wrap_dek(self, *, customer_id: int, key_ref: str,
                       dek: bytes | bytearray, aad: bytes) -> tuple[bytes, str]:
        _check_customer_id(customer_id)
        self._check_key_ref(customer_id, key_ref)
        if len(dek) != DEK_BYTES:
            raise ValueError("DEK must be 32 bytes")
        version = self._primary_version
        nonce = os.urandom(GCM_NONCE_BYTES)
        kek = self._kek(customer_id, version)
        try:
            ct = AESGCM(kek).encrypt(nonce, bytes(dek), bytes(aad))
        finally:
            _zero(kek)
        return _LOCAL_HEADER.pack(_LOCAL_MAGIC, version) + nonce + ct, f"{key_ref}/v{version}"

    async def unwrap_dek(self, *, customer_id: int, key_ref: str,
                         wrapped_dek: bytes, aad: bytes) -> bytearray:
        _check_customer_id(customer_id)
        self._check_key_ref(customer_id, key_ref)
        blob = bytes(wrapped_dek)
        expected_len = _LOCAL_HEADER.size + GCM_NONCE_BYTES + DEK_BYTES + 16
        if len(blob) != expected_len:
            raise VoicemailIntegrityError("local KMS: wrapped DEK has the wrong length")
        magic, version = _LOCAL_HEADER.unpack_from(blob)
        if magic != _LOCAL_MAGIC or version < 1:
            raise VoicemailIntegrityError("local KMS: wrapped DEK has a bad header")
        nonce = blob[_LOCAL_HEADER.size:_LOCAL_HEADER.size + GCM_NONCE_BYTES]
        ct = blob[_LOCAL_HEADER.size + GCM_NONCE_BYTES:]
        kek = self._kek(customer_id, version)
        try:
            dek = AESGCM(kek).decrypt(nonce, ct, bytes(aad))
        except InvalidTag as exc:
            raise VoicemailIntegrityError(
                "local KMS: wrapped DEK failed authentication (AAD mismatch or tamper)") from exc
        finally:
            _zero(kek)
        return bytearray(dek)

    async def destroy_key(self, *, customer_id: int, key_ref: str | None) -> list[str]:
        # The local KEK is derivable from the master key, so erase can only be
        # LOGICAL: keys.crypto_erase_customer marks the row destroyed and every
        # later seal/open is refused on that status.
        _check_customer_id(customer_id)
        logger.warning("voicemail local KMS: erase of customer %s is logical only (dev/CI)",
                       customer_id)
        return []


# ===========================================================================
# Provider registry
# ===========================================================================
_providers_lock = threading.Lock()
_providers: dict[tuple, KmsProvider] = {}


def get_kms_provider(name: str | None = None) -> KmsProvider:
    """Return the (cached, per-process) provider ``name`` — default the
    configured ``VOICEMAIL_KMS_PROVIDER``. Raises VoicemailCryptoUnavailable
    when that provider is not configured or not permitted. The local-provider
    permission is re-checked on EVERY call, not only at construction."""
    cfg = load_config()
    chosen = (name or cfg.kms_provider or "").strip().lower()
    if chosen == "gcpkms":
        require_gcp_kms_config(cfg)
        cache_key: tuple = ("gcpkms", cfg.kms_project, cfg.kms_location,
                            cfg.kms_keyring, cfg.impersonate_sa)
        factory: Callable[[], KmsProvider] = lambda: GcpKmsProvider(cfg)
    elif chosen == "local":
        require_local_backends_permitted(cfg, "the local KMS provider")
        cache_key = ("local", hashlib.sha256(cfg.local_master_key_b64.encode()).hexdigest())
        factory = lambda: LocalKmsProvider(cfg)
    else:
        raise VoicemailCryptoUnavailable(f"unknown voicemail KMS provider {chosen!r}")
    with _providers_lock:
        provider = _providers.get(cache_key)
        if provider is None:
            provider = factory()
            _providers[cache_key] = provider
        return provider


def reset_kms_providers() -> None:
    """Test hook: drop cached providers (and their clients)."""
    with _providers_lock:
        _providers.clear()
