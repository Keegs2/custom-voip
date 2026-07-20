"""Object-type-agnostic envelope encryption for encryption-at-rest across the
platform (voicemail, call recordings, chat — the "compliance-as-product" core).

This module generalises the pattern first shipped for Visual Voicemail
(``voicemail_crypto.py``, which now delegates here) so ANY object type can be
sealed with the SAME crypto + KMS abstraction, giving one auditable
key-management surface for SOC 2 / HIPAA.

Envelope model (per object)::

    plaintext ──AES-256-GCM(DEK)──▶ ciphertext     (fresh random 256-bit DEK + 12B IV)
    DEK ──KMS.wrap(KEK)──▶ wrapped_dek             (KEK lives in KMS / local key store)

Only ``(ciphertext, iv, wrapped_dek)`` are ever persisted. The plaintext DEK
exists in memory for exactly one seal/open and is scrubbed afterwards — it is
never written down.

Crypto-erase (NIST SP 800-88 §2.5, "Cryptographic Erase"):
  * **Per-object** — destroy that object's ``wrapped_dek`` (null the column +
    delete the ciphertext object). The random DEK only ever existed wrapped, so
    once the wrapped copy is gone the object is mathematically unrecoverable.
  * **Per-scope** — destroy the KEK (``schedule_destroy``). Renders EVERY object
    wrapped under that KEK unrecoverable at once (customer offboarding, tenant
    right-to-erasure). See :func:`crypto_erase_scope`.

Key hierarchy for the NEW object types (recordings, chat) is managed by the
``envelope_keys`` registry (:func:`resolve_or_create_kek`): one KEK per
``(scope)`` — e.g. ``recordings:customer:1`` or ``chat:customer:1`` — created
once and reused, so a KMS-backed provider is NOT called per object (avoids the
KMS N+1). Voicemail keeps its own per-mailbox KEK bookkeeping on
``voicemail_boxes`` (unchanged) and does not use the registry.

Two providers, selected by the stored ``kek_provider`` value (or the
``VOICEMAIL_KEK_PROVIDER`` env default):

  * ``LocalKmsProvider`` (``'local'``) — wraps the DEK with a MultiFernet built
    from a local env KEK. Reads ``VOICEMAIL_LOCAL_KEK`` first (authoritative when
    set, so existing voicemail data is byte-identically served) and also accepts
    the platform-wide alias ``ENVELOPE_LOCAL_KEK``. Comma-separated for rotation
    (first = active encrypt key; all accepted for decrypt).
  * ``GcpKmsProvider`` (``'gcpkms'``) — Cloud KMS/HSM (FIPS 140-2 L3) structured
    stub; blocking client calls are offloaded via ``asyncio.to_thread``. Present
    so the seam + DB rows carry forward; not wired/tested in Phase 1.
"""
from __future__ import annotations

import os
import base64
import hashlib
import logging
from dataclasses import dataclass
from typing import Optional, Protocol, Tuple, runtime_checkable

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

logger = logging.getLogger(__name__)

# AES-256-GCM, 12-byte nonce (the GCM-recommended size).
GCM_NONCE_BYTES = 12
ENC_ALGO = "AES-256-GCM"

# Provider selected by default for newly-created objects in this environment.
DEFAULT_KEK_PROVIDER = os.getenv("VOICEMAIL_KEK_PROVIDER", "local").lower()


class EnvelopeError(RuntimeError):
    """Raised when an envelope operation cannot proceed (e.g. no configured KEK,
    or an attempt to encrypt under a crypto-erased scope)."""


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


def generate_dek() -> bytes:
    """Return a fresh random 256-bit DEK (32 bytes)."""
    return AESGCM.generate_key(bit_length=256)


def encrypt_with_dek(dek: bytes, plaintext: bytes) -> Tuple[bytes, bytes]:
    """Encrypt ``plaintext`` under an EXISTING ``dek`` (fresh 12-byte IV).

    Returns ``(ciphertext, iv)``. Used by the shared-DEK model (e.g. a
    per-conversation chat DEK) where many small objects share one wrapped DEK but
    each gets its own IV — so a KMS-backed KEK is unwrapped once per read, not per
    object.
    """
    iv = os.urandom(GCM_NONCE_BYTES)
    ciphertext = AESGCM(bytes(dek)).encrypt(iv, plaintext, None)
    return ciphertext, iv


def decrypt_with_dek(dek: bytes, ciphertext: bytes, iv: bytes) -> bytes:
    """Decrypt ``ciphertext`` under an existing ``dek`` + ``iv`` (shared-DEK read
    counterpart of :func:`encrypt_with_dek`)."""
    return AESGCM(bytes(dek)).decrypt(bytes(iv), bytes(ciphertext), None)


# ---------------------------------------------------------------------------
# KEK provider interface
# ---------------------------------------------------------------------------
@runtime_checkable
class KmsProvider(Protocol):
    """Wraps/unwraps per-object DEKs and manages per-scope/mailbox KEKs."""

    name: str

    async def create_customer_kek(
        self, customer_id: int, mailbox_id: int | None = None, key_label: str | None = None
    ) -> str:
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
# Entropy floor for a local KEK. A 256-bit key is 32 raw bytes (44 base64 / 64
# hex chars); anything shorter is almost certainly a low-entropy passphrase that
# SHA-256-folding would silently "upgrade" to a full-length key while remaining
# trivially brute-forceable. Refuse it loudly instead (infra-LOW-1).
_MIN_KEK_CHARS = 32


def _fernet_key_from_secret(secret: str) -> bytes:
    """Derive a valid urlsafe-base64 Fernet key from a KEK secret string.

    Accepts a raw 32-byte value, a base64 string, or a long passphrase and folds
    it to 32 bytes via SHA-256, then base64-encodes it. SECURITY (infra-LOW-1): a
    secret shorter than ``_MIN_KEK_CHARS`` is REJECTED rather than folded — a
    short/low-entropy KEK gives a false sense of at-rest protection because it can
    be brute-forced regardless of the SHA-256 expansion.
    """
    if secret is None or len(secret) < _MIN_KEK_CHARS:
        raise EnvelopeError(
            f"envelope KEK is too weak: need at least {_MIN_KEK_CHARS} characters "
            "of entropy (a 32-byte random value, its base64/hex, or a long "
            "passphrase). Refusing to derive a key from a short/low-entropy secret."
        )
    digest = hashlib.sha256(secret.encode("utf-8")).digest()  # 32 bytes
    return base64.urlsafe_b64encode(digest)


class LocalKmsProvider:
    """KEK wrapping using a local MultiFernet built from an env KEK.

    Key material is read from ``env_var`` (default ``VOICEMAIL_LOCAL_KEK``) FIRST,
    then from each name in ``alias_env_vars`` (default ``ENVELOPE_LOCAL_KEK``).
    Each may be a comma-separated list; the FIRST secret overall is the active
    (encrypt) key and ALL are accepted for decrypt — MultiFernet-style rotation.

    Reading ``VOICEMAIL_LOCAL_KEK`` first is deliberate: when it is set (the
    production reality for voicemail today) it stays the active encrypt key, so
    already-stored voicemail objects are wrapped/unwrapped byte-identically; the
    platform-wide ``ENVELOPE_LOCAL_KEK`` alias only ever ADDS decrypt capability
    or supplies the active key when ``VOICEMAIL_LOCAL_KEK`` is unset.

    ``kek_key_ref`` is a local label only (one MultiFernet wraps everything in
    dev); per-object/per-scope crypto-erase in dev is achieved by destroying the
    wrapped DEKs themselves (the KEK ``schedule_destroy`` is a logged no-op).
    """

    name = "local"

    def __init__(self, env_var: str = "VOICEMAIL_LOCAL_KEK",
                 alias_env_vars: Tuple[str, ...] = ("ENVELOPE_LOCAL_KEK",)):
        self._env_var = env_var
        self._alias_env_vars = tuple(alias_env_vars)
        self._multifernet = None  # lazy
        self._loaded_from: Tuple[str, ...] = ()

    def _secrets(self) -> list[str]:
        """Ordered, de-duplicated secret list across the primary + alias env vars.

        Primary (``self._env_var``) is listed first so its first entry is the
        active encrypt key when present — the voicemail-preserving invariant.
        """
        out: list[str] = []
        seen: set[str] = set()
        for name in (self._env_var, *self._alias_env_vars):
            for s in os.getenv(name, "").split(","):
                s = s.strip()
                if s and s not in seen:
                    seen.add(s)
                    out.append(s)
        return out

    def _load(self):
        # Rebuild if the effective secret set changed (test/rotation friendliness).
        secrets = self._secrets()
        key = tuple(secrets)
        if self._multifernet is not None and key == self._loaded_from:
            return self._multifernet
        from cryptography.fernet import Fernet, MultiFernet

        if not secrets:
            raise EnvelopeError(
                f"{self._env_var} (or {'/'.join(self._alias_env_vars)}) is unset — "
                "local encryption is not configured; refusing to handle sensitive "
                "media in plaintext"
            )
        self._multifernet = MultiFernet([Fernet(_fernet_key_from_secret(s)) for s in secrets])
        self._loaded_from = key
        return self._multifernet

    def configured(self) -> bool:
        return bool(self._secrets())

    async def create_customer_kek(
        self, customer_id: int, mailbox_id: int | None = None, key_label: str | None = None
    ) -> str:
        # Local provider shares one MultiFernet; the ref is a descriptive label so
        # a prod migration (to per-scope/per-mailbox GCP keys) stays traceable.
        self._load()  # fail fast if unconfigured
        if key_label:
            return f"local:{key_label}"
        if mailbox_id is not None:
            return f"local:mailbox:{mailbox_id}"
        return f"local:customer:{customer_id}"

    async def wrap_dek(self, dek: bytes, kek_key_ref: str) -> bytes:
        return self._load().encrypt(bytes(dek))

    async def unwrap_dek(self, wrapped_dek: bytes, kek_key_ref: str) -> bytes:
        return self._load().decrypt(bytes(wrapped_dek))

    async def schedule_destroy(self, kek_key_ref: str) -> None:
        logger.warning(
            "LocalKmsProvider.schedule_destroy(%s) is a no-op — local dev shares one "
            "KEK and cannot crypto-erase by KEK. Per-object crypto-erase (destroying "
            "the wrapped DEK) still works; use GcpKmsProvider in production for "
            "per-scope/per-mailbox KEK destruction.",
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
        self.project = os.getenv("VOICEMAIL_GCP_PROJECT", "") or os.getenv("ENVELOPE_GCP_PROJECT", "")
        self.location = os.getenv("VOICEMAIL_GCP_LOCATION", "") or os.getenv("ENVELOPE_GCP_LOCATION", "us-east1")
        self.key_ring = os.getenv("VOICEMAIL_GCP_KEYRING", "") or os.getenv("ENVELOPE_GCP_KEYRING", "voicemail")
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

    @staticmethod
    def _sanitize_key_id(raw: str) -> str:
        # Cloud KMS crypto-key ids: [a-zA-Z0-9_-], <=63 chars.
        safe = "".join(c if (c.isalnum() or c in "_-") else "-" for c in raw)
        return safe[:63] or "key"

    async def create_customer_kek(
        self, customer_id: int, mailbox_id: int | None = None, key_label: str | None = None
    ) -> str:
        import asyncio

        def _create() -> str:
            from google.cloud import kms  # type: ignore

            client = self._kms()
            parent = client.key_ring_path(self.project, self.location, self.key_ring)
            if key_label:
                key_id = self._sanitize_key_id(key_label)
            elif mailbox_id is not None:
                key_id = f"mailbox-{mailbox_id}"
            else:
                key_id = f"customer-{customer_id}"
            crypto_key = {
                "purpose": kms.CryptoKey.CryptoKeyPurpose.ENCRYPT_DECRYPT,
                "version_template": {
                    "protection_level": kms.ProtectionLevel.HSM,
                    "algorithm": kms.CryptoKeyVersion.CryptoKeyVersionAlgorithm.GOOGLE_SYMMETRIC_ENCRYPTION,
                },
            }
            try:
                created = client.create_crypto_key(
                    request={"parent": parent, "crypto_key_id": key_id, "crypto_key": crypto_key}
                )
                return created.name
            except Exception:
                # Idempotent reference: if the key already exists, return its path.
                return client.crypto_key_path(self.project, self.location, self.key_ring, key_id)

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
    falls back to plaintext) when this is False for confidentiality-critical
    paths — see the voicemail ingest hot path."""
    return get_kms_provider(name).configured()


# ---------------------------------------------------------------------------
# High-level envelope operations (object-type agnostic) — pure, no DB / storage
# ---------------------------------------------------------------------------
@dataclass
class Envelope:
    """The persistable ciphertext + key metadata for one sealed object.

    Everything here is safe to store; the plaintext DEK is never a field.
    """
    ciphertext: bytes
    iv: bytes
    wrapped_dek: bytes
    enc_algo: str
    kek_provider: str
    kek_key_ref: str


async def seal(plaintext: bytes, *, kek_provider: str, kek_key_ref: str) -> Envelope:
    """Encrypt + wrap in one step: fresh DEK → AES-256-GCM → wrap the DEK under
    the referenced KEK, scrubbing the plaintext DEK before returning.

    Raises :class:`EnvelopeError` if the provider is not configured (callers must
    NOT fall back to plaintext for confidentiality-critical objects).
    """
    provider = get_kms_provider(kek_provider)
    if not provider.configured():
        raise EnvelopeError("encryption provider is not configured (no KEK)")
    ciphertext, iv, dek = encrypt_blob(plaintext)
    try:
        wrapped = await provider.wrap_dek(dek, kek_key_ref)
    finally:
        dek = b"\x00" * len(dek)  # best-effort scrub
    return Envelope(ciphertext, iv, wrapped, ENC_ALGO, provider.name, kek_key_ref)


async def open_envelope(ciphertext: bytes, iv: bytes, wrapped_dek: bytes, *,
                        kek_provider: str, kek_key_ref: str) -> bytes:
    """Unwrap the DEK and AES-256-GCM decrypt → plaintext, scrubbing the DEK.

    Raises ``cryptography.exceptions.InvalidTag`` if the object does not
    authenticate (tampering / wrong key), or the provider's error on unwrap.
    """
    provider = get_kms_provider(kek_provider)
    dek = await provider.unwrap_dek(bytes(wrapped_dek), kek_key_ref)
    try:
        return decrypt_blob(ciphertext, iv, dek)
    finally:
        dek = b"\x00" * len(dek)


async def wrap_dek(dek: bytes, kek_provider: str, kek_key_ref: str) -> bytes:
    """Wrap a raw DEK under the referenced KEK (thin provider passthrough)."""
    return await get_kms_provider(kek_provider).wrap_dek(dek, kek_key_ref)


async def unwrap_dek(wrapped_dek: bytes, kek_provider: str, kek_key_ref: str) -> bytes:
    """Unwrap a wrapped DEK under the referenced KEK (thin provider passthrough)."""
    return await get_kms_provider(kek_provider).unwrap_dek(bytes(wrapped_dek), kek_key_ref)


# ---------------------------------------------------------------------------
# DB-backed KEK registry (envelope_keys) — one KEK per scope, created once.
# Lazily imports db so the pure crypto layer above stays import-light/testable.
# Voicemail does NOT use this (it keeps per-mailbox KEK refs on voicemail_boxes).
# ---------------------------------------------------------------------------
async def resolve_or_create_kek(
    scope: str, customer_id: int, provider_name: str | None = None
) -> Tuple[str, str]:
    """Return ``(kek_provider, kek_key_ref)`` for ``scope`` — creating the KEK on
    first use and persisting it in ``envelope_keys`` so subsequent objects reuse
    it (never provisioning a KMS key per object).

    ``scope`` is a stable string such as ``recordings:customer:1`` or
    ``chat:customer:1``. Raises :class:`EnvelopeError` if the provider is
    unconfigured, or if the scope was crypto-erased (refuse to silently re-key an
    erased scope — the caller must explicitly re-provision).
    """
    from db import database as db

    row = await db.fetch_one(
        "SELECT kek_provider, kek_key_ref, status FROM envelope_keys WHERE scope = $1",
        scope,
    )
    if row is not None:
        if row["status"] != "active":
            raise EnvelopeError(f"scope {scope!r} is crypto-erased; refusing to re-key")
        return row["kek_provider"], row["kek_key_ref"]

    provider = get_kms_provider(provider_name)
    if not provider.configured():
        raise EnvelopeError("encryption provider is not configured (no KEK)")
    kek_ref = await provider.create_customer_kek(customer_id, key_label=scope)

    # Race-safe insert: a concurrent creator may win — ON CONFLICT then re-read.
    await db.execute(
        """
        INSERT INTO envelope_keys (scope, customer_id, kek_provider, kek_key_ref)
        VALUES ($1::text, $2::int, $3::text, $4::text)
        ON CONFLICT (scope) DO NOTHING
        """,
        scope, customer_id, provider.name, kek_ref,
    )
    row = await db.fetch_one(
        "SELECT kek_provider, kek_key_ref, status FROM envelope_keys WHERE scope = $1",
        scope,
    )
    if row is None or row["status"] != "active":
        raise EnvelopeError(f"could not provision KEK for scope {scope!r}")
    return row["kek_provider"], row["kek_key_ref"]


async def get_scope_kek(scope: str) -> Optional[dict]:
    """Return the ``envelope_keys`` row for ``scope`` as a dict, or None."""
    from db import database as db

    row = await db.fetch_one(
        "SELECT scope, customer_id, kek_provider, kek_key_ref, status FROM envelope_keys WHERE scope = $1",
        scope,
    )
    return dict(row) if row else None


async def crypto_erase_scope(scope: str) -> bool:
    """Scope-level crypto-erase: destroy the KEK and mark the registry row
    ``crypto_erased``. Renders every object wrapped under this KEK unrecoverable
    (per NIST SP 800-88) once the provider destroys the KEK.

    Returns True if a scope row existed. Best-effort on the provider destroy
    (logged, never raised) so the DB status flip always lands. Note: with the
    LocalKmsProvider the KEK destroy is a no-op — callers that need real erasure
    in dev must also destroy the per-object wrapped DEKs.
    """
    from db import database as db

    row = await db.fetch_one(
        "SELECT kek_provider, kek_key_ref, status FROM envelope_keys WHERE scope = $1",
        scope,
    )
    if row is None:
        return False
    if row["status"] == "active":
        try:
            await get_kms_provider(row["kek_provider"]).schedule_destroy(row["kek_key_ref"])
        except Exception:
            logger.warning("crypto_erase_scope(%s): provider destroy failed", scope, exc_info=True)
    await db.execute(
        "UPDATE envelope_keys SET status = 'crypto_erased', erased_at = NOW() WHERE scope = $1",
        scope,
    )
    return True
