"""Encrypted voicemail — crypto, KMS, storage and key bookkeeping.

Contract: docs/ENCRYPTED_VOICEMAIL_INTERFACES.md §2. Importing this package
needs no GCP credentials and makes no network call; KMS/GCS clients are built
lazily on first use.

    from services.voicemail import (
        seal_and_store, load_and_open, delete_object,
        message_aad, greeting_aad, message_object_key, greeting_object_key,
        ensure_customer_key, crypto_erase_customer,
        VoicemailCryptoUnavailable, VoicemailIntegrityError,
    )

Transcripts (v1.1, docs/VOICEMAIL_TRANSCRIPTION_PLAN.md §5): ``transcript_aad``,
``seal_transcript`` / ``open_transcript`` -> ``SealedBlob`` (ciphertext on the
DB row, AAD ``vmt:``; sealing never creates a customer key).
"""
from .crypto import (
    ENC_ALGO,
    MAX_TRANSCRIPT_PLAINTEXT,
    TRANSCRIPT_AAD_PREFIX,
    Sealed,
    SealedBlob,
    crc32c,
    delete_object,
    greeting_aad,
    greeting_object_key,
    load_and_open,
    message_aad,
    message_object_key,
    open_transcript,
    seal_and_store,
    seal_transcript,
    transcript_aad,
)
from .errors import (
    VoicemailCryptoUnavailable,
    VoicemailIntegrityError,
    VoicemailKeyDestroyed,
    VoicemailObjectNotFound,
)
from .keys import CustomerKey, crypto_erase_customer, ensure_customer_key, get_customer_key
from .kms import GcpKmsProvider, KmsProvider, LocalKmsProvider, get_kms_provider
from .storage import GcsObjectStore, MemoryObjectStore, ObjectStore, get_object_store

__all__ = [
    "ENC_ALGO", "Sealed", "crc32c",
    "message_aad", "greeting_aad", "message_object_key", "greeting_object_key",
    "seal_and_store", "load_and_open", "delete_object",
    "TRANSCRIPT_AAD_PREFIX", "MAX_TRANSCRIPT_PLAINTEXT", "SealedBlob",
    "transcript_aad", "seal_transcript", "open_transcript",
    "CustomerKey", "ensure_customer_key", "get_customer_key", "crypto_erase_customer",
    "KmsProvider", "GcpKmsProvider", "LocalKmsProvider", "get_kms_provider",
    "ObjectStore", "GcsObjectStore", "MemoryObjectStore", "get_object_store",
    "VoicemailCryptoUnavailable", "VoicemailIntegrityError",
    "VoicemailKeyDestroyed", "VoicemailObjectNotFound",
]
