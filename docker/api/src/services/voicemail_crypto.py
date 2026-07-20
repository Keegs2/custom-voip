"""Voicemail envelope encryption — now a thin compatibility shim.

The envelope-encryption implementation was GENERALISED into
``services.envelope_crypto`` (object-type agnostic) so call recordings and chat
can reuse the exact same per-object AES-256-GCM DEK + KMS-wrapped-KEK model and
crypto-erase. This module re-exports that implementation UNCHANGED so the
existing Visual Voicemail code path (``routers/voicemail.py``) keeps calling
``voicemail_crypto.encrypt_blob`` / ``decrypt_blob`` / ``get_kms_provider`` /
``ENC_ALGO`` with byte-identical behavior.

Nothing here is voicemail-specific anymore: ``get_kms_provider`` returns the same
provider singletons ``envelope_crypto`` uses, ``LocalKmsProvider`` still reads
``VOICEMAIL_LOCAL_KEK`` as its authoritative (active) key, and the provider
default still comes from ``VOICEMAIL_KEK_PROVIDER`` — so already-stored voicemail
audio/greetings wrap and unwrap exactly as before. See ``envelope_crypto`` for
the full model, the ``ENVELOPE_LOCAL_KEK`` platform alias, and the
``envelope_keys`` KEK registry used by the newer object types.
"""
from __future__ import annotations

# Re-export the shared implementation. These are the SAME objects/functions the
# rest of the platform uses, guaranteeing voicemail is not a divergent copy.
from services.envelope_crypto import (  # noqa: F401
    GCM_NONCE_BYTES,
    ENC_ALGO,
    DEFAULT_KEK_PROVIDER,
    EnvelopeError,
    encrypt_blob,
    decrypt_blob,
    KmsProvider,
    LocalKmsProvider,
    GcpKmsProvider,
    get_kms_provider,
    encryption_configured,
    _fernet_key_from_secret,
    _LOCAL,
    _GCP,
)

__all__ = [
    "GCM_NONCE_BYTES",
    "ENC_ALGO",
    "DEFAULT_KEK_PROVIDER",
    "EnvelopeError",
    "encrypt_blob",
    "decrypt_blob",
    "KmsProvider",
    "LocalKmsProvider",
    "GcpKmsProvider",
    "get_kms_provider",
    "encryption_configured",
]
