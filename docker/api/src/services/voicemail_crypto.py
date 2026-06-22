"""Envelope encryption for the standalone Visual Voicemail product.

Encryption model (see VISUAL_VOICEMAIL_PRODUCT_PLAN.md §4, ENCRYPTED_VOICEMAIL_PLAN.md):

    plaintext ──AES-256-GCM(DEK)──▶ ciphertext   (per-object random DEK + 12-byte IV)
    DEK ──KMS.wrap(KEK)──▶ wrapped_dek           (KEK lives in KMS / local key store)

Only the wrapped DEK + IV + ciphertext are ever persisted. The plaintext DEK
exists in memory for the duration of one encrypt/decrypt and is never written
down. Crypto-erase = destroy the KEK (per-customer standard, per-mailbox gov).

Two providers, selected by ``voicemail_boxes.kek_provider``:

  * ``LocalKmsProvider`` (``kek_provider='local'``) — wraps the DEK with a
    MultiFernet built from the env KEK ``VOICEMAIL_LOCAL_KEK`` (comma-separated
    for rotation). Lets the whole encrypted pipeline run on the local MinIO
    stack with no cloud dependency.
  * ``GcpKmsProvider`` (``kek_provider='gcpkms'``) — structured stub that calls
    google-cloud-kms via ``asyncio.to_thread``. Not wired/tested in Phase 1.

The provider interface is async so the GCP path can offload its blocking client
calls to a thread; the local path satisfies it trivially.
"""
from __future__ import annotations

import os
import base64
import hashlib
import logging
from typing import Protocol, Tuple, runtime_checkable

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

logger = logging.getLogger(__name__)

# AES-256-GCM, 12-byte nonce (the GCM-recommended size).
GCM_NONCE_BYTES = 12
ENC_ALGO = "AES-256-GCM"

# Provider selected by default for newly-created mailboxes in this environment.
DEFAULT_KEK_PROVIDER = os.getenv("VOICEMAIL_KEK_PROVIDER", "local").lower()


# ---------------------------------------------------------------------------
# Symmetric layer (per-object DEK) — pure, always available, no key store
# ---------------------------------------------------------------------------
def encrypt_blob(plaintext: bytes) -> Tuple[bytes, bytes, bytes]:
    """Encrypt ``plaintext`` under a fresh random 256-bit DEK.

    Returns ``(ciphertext, iv, dek)``. The caller MUST immediately wrap ``dek``
    with a KEK (provider.wrap_dek) and persist only the wrapped form — never the
    raw DEK. The GCM auth tag is appended to ``ciphertext`` by the library.
    """
    dek = AESGCM.generate_key(bit_length=256)  # 32 bytes
    iv = os.urandom(GCM_NONCE_BYTES)
    ciphertext = AESGCM(dek).encrypt(iv, plaintext, None)
    return ciphertext, iv, dek


def decrypt_blob(ciphertext: bytes, iv: bytes, dek: bytes) -> bytes:
    """Decrypt ``ciphertext`` (with appended GCM tag) using ``dek`` + ``iv``.

    Raises ``cryptography.exceptions.InvalidTag`` if the ciphertext/tag/iv/key
    do not authenticate (tampering or wrong key).
    """
    return AESGCM(bytes(dek)).decrypt(bytes(iv), bytes(ciphertext), None)


# ---------------------------------------------------------------------------
# KEK provider interface
# ---------------------------------------------------------------------------
@runtime_checkable
class KmsProvider(Protocol):
    """Wraps/unwraps per-object DEKs and manages per-customer/mailbox KEKs."""

    name: str

    async def create_customer_kek(self, customer_id: int, mailbox_id: int | None = None) -> str:
        """Provision (or reference) a KEK and return an opaque ``kek_key_ref``."""
        ...

    async def wrap_dek(self, dek: bytes, kek_key_ref: str) -> bytes:
        """Encrypt a DEK with the referenced KEK → wrapped_dek bytes."""
        ...

    async def unwrap_dek(self, wrapped_dek: bytes, kek_key_ref: str) -> bytes:
        """Decrypt a wrapped DEK with the referenced KEK → raw DEK bytes."""
        ...

    async def schedule_destroy(self, kek_key_ref: str) -> None:
        """Crypto-erase: schedule destruction of the referenced KEK."""
        ...

    def configured(self) -> bool:
        """True iff this provider has the key material/config to encrypt."""
        ...


# ---------------------------------------------------------------------------
# LocalKmsProvider — MultiFernet over an env KEK (dev / MinIO stack)
# ---------------------------------------------------------------------------
def _fernet_key_from_secret(secret: str) -> bytes:
    """Derive a valid urlsafe-base64 Fernet key from an arbitrary secret string.

    Accepts any input length (a raw 32-byte value, a base64 string, a
    passphrase) and folds it to 32 bytes via SHA-256, then base64-encodes — so
    operators can set ``VOICEMAIL_LOCAL_KEK`` to anything reasonably random.
    """
    digest = hashlib.sha256(secret.encode("utf-8")).digest()  # 32 bytes
    return base64.urlsafe_b64encode(digest)


class LocalKmsProvider:
    """KEK wrapping using a local MultiFernet built from ``VOICEMAIL_LOCAL_KEK``.

    The env var may be a comma-separated list of secrets; the first is the
    active (encrypt) key, all are accepted for decrypt — MultiFernet-style key
    rotation. ``kek_key_ref`` is a local label only (the same underlying
    MultiFernet wraps every mailbox in dev); per-mailbox crypto-erase is a
    GCP-only capability, so ``schedule_destroy`` is a logged no-op here.
    """

    name = "local"

    def __init__(self, env_var: str = "VOICEMAIL_LOCAL_KEK"):
        self._env_var = env_var
        self._multifernet = None  # lazy

    def _load(self):
        if self._multifernet is not None:
            return self._multifernet
        from cryptography.fernet import Fernet, MultiFernet

        raw = os.getenv(self._env_var, "")
        secrets = [s.strip() for s in raw.split(",") if s.strip()]
        if not secrets:
            raise RuntimeError(
                f"{self._env_var} is unset — local voicemail encryption is not "
                "configured; refusing to handle voicemail audio in plaintext"
            )
        self._multifernet = MultiFernet([Fernet(_fernet_key_from_secret(s)) for s in secrets])
        return self._multifernet

    def configured(self) -> bool:
        return bool([s for s in os.getenv(self._env_var, "").split(",") if s.strip()])

    async def create_customer_kek(self, customer_id: int, mailbox_id: int | None = None) -> str:
        # Local provider shares one MultiFernet; the ref is a descriptive label
        # so prod migration (to per-customer/per-mailbox GCP keys) is traceable.
        self._load()  # fail fast if unconfigured
        if mailbox_id is not None:
            return f"local:mailbox:{mailbox_id}"
        return f"local:customer:{customer_id}"

    async def wrap_dek(self, dek: bytes, kek_key_ref: str) -> bytes:
        return self._load().encrypt(bytes(dek))

    async def unwrap_dek(self, wrapped_dek: bytes, kek_key_ref: str) -> bytes:
        return self._load().decrypt(bytes(wrapped_dek))

    async def schedule_destroy(self, kek_key_ref: str) -> None:
        logger.warning(
            "LocalKmsProvider.schedule_destroy(%s) is a no-op — local dev shares "
            "one KEK and cannot crypto-erase a single mailbox. Use GcpKmsProvider "
            "in production for per-customer/per-mailbox crypto-erase.",
            kek_key_ref,
        )


# ---------------------------------------------------------------------------
# GcpKmsProvider — structured stub (google-cloud-kms via to_thread). Phase 2.
# ---------------------------------------------------------------------------
class GcpKmsProvider:
    """Cloud KMS (Cloud HSM, FIPS 140-2 L3) envelope-KEK provider.

    NOT wired or tested in Phase 1 — present so the provider seam exists and the
    DB carries ``kek_provider='gcpkms'`` rows forward. All blocking
    google-cloud-kms calls are offloaded with ``asyncio.to_thread``.
    """

    name = "gcpkms"

    def __init__(self):
        self.project = os.getenv("VOICEMAIL_GCP_PROJECT", "")
        self.location = os.getenv("VOICEMAIL_GCP_LOCATION", "us-east1")
        self.key_ring = os.getenv("VOICEMAIL_GCP_KEYRING", "voicemail")
        self._client = None

    def configured(self) -> bool:
        return bool(self.project and self.location and self.key_ring)

    def _kms(self):
        if self._client is None:
            from google.cloud import kms  # type: ignore

            self._client = kms.KeyManagementServiceClient()
        return self._client

    def _key_path(self, kek_key_ref: str) -> str:
        # kek_key_ref is the fully-qualified cryptoKey resource name in prod.
        return kek_key_ref

    async def create_customer_kek(self, customer_id: int, mailbox_id: int | None = None) -> str:
        import asyncio

        def _create() -> str:
            from google.cloud import kms  # type: ignore

            client = self._kms()
            parent = client.key_ring_path(self.project, self.location, self.key_ring)
            key_id = (
                f"mailbox-{mailbox_id}" if mailbox_id is not None else f"customer-{customer_id}"
            )
            crypto_key = {
                "purpose": kms.CryptoKey.CryptoKeyPurpose.ENCRYPT_DECRYPT,
                "version_template": {
                    "protection_level": kms.ProtectionLevel.HSM,
                    "algorithm": kms.CryptoKeyVersion.CryptoKeyVersionAlgorithm.GOOGLE_SYMMETRIC_ENCRYPTION,
                },
            }
            created = client.create_crypto_key(
                request={"parent": parent, "crypto_key_id": key_id, "crypto_key": crypto_key}
            )
            return created.name

        return await asyncio.to_thread(_create)

    async def wrap_dek(self, dek: bytes, kek_key_ref: str) -> bytes:
        import asyncio

        def _wrap() -> bytes:
            client = self._kms()
            resp = client.encrypt(request={"name": self._key_path(kek_key_ref), "plaintext": bytes(dek)})
            return resp.ciphertext

        return await asyncio.to_thread(_wrap)

    async def unwrap_dek(self, wrapped_dek: bytes, kek_key_ref: str) -> bytes:
        import asyncio

        def _unwrap() -> bytes:
            client = self._kms()
            resp = client.decrypt(
                request={"name": self._key_path(kek_key_ref), "ciphertext": bytes(wrapped_dek)}
            )
            return resp.plaintext

        return await asyncio.to_thread(_unwrap)

    async def schedule_destroy(self, kek_key_ref: str) -> None:
        import asyncio

        def _destroy() -> None:
            client = self._kms()
            # Destroy the primary version; full crypto-erase iterates all versions.
            client.destroy_crypto_key_version(request={"name": f"{kek_key_ref}/cryptoKeyVersions/1"})

        await asyncio.to_thread(_destroy)


# ---------------------------------------------------------------------------
# Provider registry / gates
# ---------------------------------------------------------------------------
_LOCAL = LocalKmsProvider()
_GCP = GcpKmsProvider()


def get_kms_provider(name: str | None = None) -> KmsProvider:
    """Return the KEK provider for ``name`` (defaults to the env-selected one)."""
    chosen = (name or DEFAULT_KEK_PROVIDER or "local").lower()
    if chosen in ("gcp", "gcpkms", "gcp_kms"):
        return _GCP
    return _LOCAL


def encryption_configured(name: str | None = None) -> bool:
    """True iff the selected provider can wrap DEKs. Encryption REFUSES (never
    falls back to plaintext) when this is False — see the ingest hot path."""
    return get_kms_provider(name).configured()
