"""Envelope encryption for voicemail audio (contract §2, decisions D1/D8).

    plaintext --AES-256-GCM(DEK, iv, aad)--> ciphertext   (stored in GCS, CRC32C-checked)
    DEK       --KMS wrap(customer KEK, aad)--> wrapped_dek  (stored on the DB row)

* One fresh random 256-bit DEK and 12-byte IV per object. The DEK lives in a
  ``bytearray`` that is zeroed as soon as it has been used (best effort:
  ``cryptography`` and the KMS client keep their own short-lived copies).
* The SAME AAD binds both layers: ``vm:{customer}:{mailbox}:{msg_uuid}`` for
  messages, ``vmg:{customer}:{mailbox}:{greeting_uuid}`` for greetings. A blob
  or wrapped DEK moved onto another row (another mailbox, customer or message)
  fails authentication -> VoicemailIntegrityError, never served (defect 6).
* ``ciphertext_crc32c`` (on the row) is re-checked against the downloaded
  bytes before any KMS call, so a swapped/rotted object is caught cheaply.
* The object key, the AAD and ``customer_id`` must describe the SAME object;
  a mismatch is a programming error (ValueError on seal) or tampered row data
  (VoicemailIntegrityError on open).
* Plaintext is only ever in process memory; nothing here touches the disk.

Failures: VoicemailCryptoUnavailable (-> 503) when KMS/GCS/DB/config is down;
VoicemailIntegrityError (-> 500, never serve) on any authentication/CRC/format
failure; VoicemailKeyDestroyed (a VoicemailCryptoUnavailable) after erase.

Transcripts (v1.1, docs/VOICEMAIL_TRANSCRIPTION_PLAN.md §5) use the same
envelope with AAD ``vmt:{customer}:{mailbox}:{msg_uuid}`` — distinct from
``vm:`` and ``vmg:``, so a transcript blob or wrapped DEK replayed against the
audio (or the reverse) fails authentication. The ciphertext is small
(<= 64 KiB + tag) and lives on the ``voicemail_transcripts`` row, so there is
no object store and no CRC32C: the GCM tag authenticates it. Sealing a
transcript NEVER creates a customer key (the background worker may only use a
key that already exists and is active).
"""
from __future__ import annotations

import os
import uuid as _uuid
from dataclasses import dataclass
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from ._crc import crc32c
from .errors import VoicemailIntegrityError
from .keys import ensure_customer_key, get_customer_key, _require_active
from .kms import DEK_BYTES, GCM_NONCE_BYTES, _zero, get_kms_provider
from .storage import OBJECT_KEY_RE, get_object_store, validate_object_key

ENC_ALGO = "AES-256-GCM"
IV_BYTES = GCM_NONCE_BYTES
#: Sanity ceiling for one plaintext (deposit cap 10 MB, greeting 5 MB).
MAX_PLAINTEXT_BYTES = 16 * 1024 * 1024 - 16

#: AAD prefix of a sealed transcript (audio is ``vm``, greetings ``vmg``).
TRANSCRIPT_AAD_PREFIX = "vmt"
#: Ceiling for one transcript plaintext (the JSON document) in bytes; the
#: ciphertext is at most this + the 16-byte GCM tag (migration 56's
#: voicemail_transcripts_ct_len_chk: 17..65552).
MAX_TRANSCRIPT_PLAINTEXT = 65_536
_GCM_TAG_BYTES = 16
_MIN_TRANSCRIPT_CIPHERTEXT = 1 + _GCM_TAG_BYTES
_MAX_TRANSCRIPT_CIPHERTEXT = MAX_TRANSCRIPT_PLAINTEXT + _GCM_TAG_BYTES

__all__ = [
    "ENC_ALGO", "Sealed", "crc32c",
    "message_aad", "greeting_aad", "message_object_key", "greeting_object_key",
    "seal_and_store", "load_and_open", "delete_object",
    "TRANSCRIPT_AAD_PREFIX", "MAX_TRANSCRIPT_PLAINTEXT", "SealedBlob",
    "transcript_aad", "seal_transcript", "open_transcript",
]


# ---------------------------------------------------------------------------
# Builders (sync). UUIDs are canonicalised (lower-case, hyphenated) so the AAD
# built at deposit time from FreeSWITCH's string equals the one built at
# playback time from the DB's uuid column.
# ---------------------------------------------------------------------------
def _pos_int(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{name} must be a positive int")
    return value


def _canonical_uuid(value: Any) -> str:
    if isinstance(value, _uuid.UUID):
        return str(value)
    if not isinstance(value, str):
        raise ValueError("uuid must be a str or uuid.UUID")
    try:
        return str(_uuid.UUID(value))
    except ValueError as exc:
        raise ValueError("invalid uuid") from exc


def message_aad(customer_id: int, mailbox_id: int, msg_uuid: str) -> bytes:
    """``b"vm:{customer}:{mailbox}:{msg_uuid}"``."""
    return (f"vm:{_pos_int(customer_id, 'customer_id')}:{_pos_int(mailbox_id, 'mailbox_id')}:"
            f"{_canonical_uuid(msg_uuid)}").encode("ascii")


def greeting_aad(customer_id: int, mailbox_id: int, greeting_uuid: str) -> bytes:
    """``b"vmg:{customer}:{mailbox}:{greeting_uuid}"``."""
    return (f"vmg:{_pos_int(customer_id, 'customer_id')}:{_pos_int(mailbox_id, 'mailbox_id')}:"
            f"{_canonical_uuid(greeting_uuid)}").encode("ascii")


def transcript_aad(customer_id: int, mailbox_id: int, msg_uuid: str | _uuid.UUID) -> bytes:
    """``b"vmt:{customer}:{mailbox}:{msg_uuid}"`` — the transcript of message
    ``msg_uuid`` (same validation / canonicalisation as :func:`message_aad`)."""
    return (f"{TRANSCRIPT_AAD_PREFIX}:{_pos_int(customer_id, 'customer_id')}:"
            f"{_pos_int(mailbox_id, 'mailbox_id')}:{_canonical_uuid(msg_uuid)}").encode("ascii")


def message_object_key(customer_id: int, mailbox_id: int, msg_uuid: str) -> str:
    """``"c/{customer}/mb/{mailbox}/m/{msg_uuid}.enc"``."""
    return (f"c/{_pos_int(customer_id, 'customer_id')}/mb/{_pos_int(mailbox_id, 'mailbox_id')}"
            f"/m/{_canonical_uuid(msg_uuid)}.enc")


def greeting_object_key(customer_id: int, mailbox_id: int, greeting_uuid: str) -> str:
    """``"c/{customer}/mb/{mailbox}/g/{greeting_uuid}.enc"``."""
    return (f"c/{_pos_int(customer_id, 'customer_id')}/mb/{_pos_int(mailbox_id, 'mailbox_id')}"
            f"/g/{_canonical_uuid(greeting_uuid)}.enc")


def _binding_ok(customer_id: int, object_key: str, aad: bytes) -> bool:
    """object_key, aad and customer_id all name the same object."""
    m = OBJECT_KEY_RE.fullmatch(object_key) if isinstance(object_key, str) else None
    if not m:
        return False
    key_customer, key_mailbox, kind, obj_uuid = m.groups()
    if int(key_customer) != customer_id:
        return False
    builder = message_aad if kind == "m" else greeting_aad
    return bytes(aad) == builder(customer_id, int(key_mailbox), obj_uuid)


@dataclass(frozen=True)
class Sealed:
    """What the caller persists on the message/greeting row."""

    object_key: str
    ciphertext_crc32c: int
    wrapped_dek: bytes
    kek_version: str
    iv: bytes
    enc_algo: str


# ---------------------------------------------------------------------------
# Seal / open / delete
# ---------------------------------------------------------------------------
async def seal_and_store(*, customer_id: int, object_key: str, aad: bytes,
                         plaintext: bytes) -> Sealed:
    """Encrypt ``plaintext`` under a fresh DEK, wrap the DEK with the
    customer's KEK (same AAD), upload the ciphertext with CRC32C and return
    the fields to persist. Nothing is uploaded unless the wrap succeeded.

    Raises ValueError (bad arguments / object_key-AAD-customer mismatch),
    LookupError (unknown customer), VoicemailCryptoUnavailable /
    VoicemailKeyDestroyed (-> 503), VoicemailIntegrityError (-> 500).
    """
    _pos_int(customer_id, "customer_id")
    validate_object_key(object_key)
    if not isinstance(aad, (bytes, bytearray)) or not _binding_ok(customer_id, object_key, aad):
        raise ValueError("object_key, aad and customer_id do not describe the same object")
    aad = bytes(aad)
    if not isinstance(plaintext, (bytes, bytearray, memoryview)):
        raise ValueError("plaintext must be bytes")
    if len(plaintext) == 0:
        raise ValueError("plaintext is empty")
    if len(plaintext) > MAX_PLAINTEXT_BYTES:
        raise ValueError("plaintext too large")

    store = get_object_store()                      # config problems surface before any KMS op
    key = await ensure_customer_key(customer_id)
    provider = get_kms_provider(key.provider)

    dek = bytearray(os.urandom(DEK_BYTES))
    try:
        wrapped, kek_version = await provider.wrap_dek(
            customer_id=customer_id, key_ref=key.key_ref, dek=dek, aad=aad)
        iv = os.urandom(IV_BYTES)
        ciphertext = AESGCM(dek).encrypt(iv, bytes(plaintext), aad)
    finally:
        _zero(dek)

    ct_crc = crc32c(ciphertext)
    await store.put(object_key, ciphertext, crc32c=ct_crc)
    return Sealed(object_key=object_key, ciphertext_crc32c=ct_crc, wrapped_dek=wrapped,
                  kek_version=kek_version, iv=iv, enc_algo=ENC_ALGO)


async def load_and_open(*, customer_id: int, object_key: str, aad: bytes, wrapped_dek: bytes,
                        iv: bytes, ciphertext_crc32c: int) -> bytes:
    """Download the ciphertext, verify its CRC32C against the row, unwrap the
    DEK (AAD-bound) and decrypt (AAD-bound). Returns the plaintext bytes.

    Raises VoicemailIntegrityError (-> 500, never serve) on any mismatch or a
    missing object (VoicemailObjectNotFound), VoicemailCryptoUnavailable /
    VoicemailKeyDestroyed (-> 503) when KMS/GCS/DB is down or the customer was
    crypto-erased, ValueError for a non-positive customer_id.
    """
    _pos_int(customer_id, "customer_id")
    if not isinstance(aad, (bytes, bytearray)) or not _binding_ok(customer_id, object_key, aad):
        raise VoicemailIntegrityError("row data does not match the requested object")
    aad = bytes(aad)
    if not isinstance(iv, (bytes, bytearray, memoryview)) or len(iv) != IV_BYTES:
        raise VoicemailIntegrityError("stored IV is malformed")
    if not isinstance(wrapped_dek, (bytes, bytearray, memoryview)) or len(wrapped_dek) == 0:
        raise VoicemailIntegrityError("stored wrapped DEK is malformed")
    if (isinstance(ciphertext_crc32c, bool) or not isinstance(ciphertext_crc32c, int)
            or not 0 <= ciphertext_crc32c <= 0xFFFFFFFF):
        raise VoicemailIntegrityError("stored ciphertext CRC32C is malformed")

    key = await get_customer_key(customer_id)
    if key is None:
        raise VoicemailIntegrityError("no voicemail key exists for this customer")
    _require_active(key)
    provider = get_kms_provider(key.provider)
    store = get_object_store()

    ciphertext = await store.get(object_key)
    if crc32c(ciphertext) != ciphertext_crc32c:
        raise VoicemailIntegrityError("ciphertext CRC32C does not match the database row")

    dek = await provider.unwrap_dek(customer_id=customer_id, key_ref=key.key_ref,
                                    wrapped_dek=bytes(wrapped_dek), aad=aad)
    try:
        return AESGCM(dek).decrypt(bytes(iv), ciphertext, aad)
    except InvalidTag as exc:
        raise VoicemailIntegrityError(
            "AES-GCM authentication failed (AAD mismatch or tampered ciphertext)") from exc
    finally:
        _zero(dek)


async def delete_object(object_key: str) -> None:
    """Delete a ciphertext object. Idempotent: a missing object is success."""
    validate_object_key(object_key)
    await get_object_store().delete(object_key)


# ---------------------------------------------------------------------------
# Transcripts (v1.1) — the sealed blob lives on the voicemail_transcripts row
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class SealedBlob:
    """What the transcription worker persists on the voicemail_transcripts row."""

    ciphertext: bytes      # AES-256-GCM output incl. the 16-byte tag
    wrapped_dek: bytes
    kek_version: str
    iv: bytes              # 12 bytes
    enc_algo: str          # "AES-256-GCM"


async def seal_transcript(*, customer_id: int, mailbox_id: int, msg_uuid: str | _uuid.UUID,
                          plaintext: bytes | bytearray | memoryview) -> SealedBlob:
    """Encrypt a transcript document under a fresh DEK wrapped with the
    customer's EXISTING, ACTIVE KEK. The ``vmt:`` AAD is built here from the
    ids, so a caller cannot pass a mismatched one.

    Never creates a key: ``get_customer_key`` + ``_require_active``, never
    ``ensure_customer_key`` (the background worker must not mint KMS keys or
    key rows; a customer without one has no stored messages to transcribe).

    Raises ValueError (non-positive ids / bad uuid / plaintext empty, not
    bytes-like or > MAX_TRANSCRIPT_PLAINTEXT), VoicemailKeyDestroyed (the
    customer was crypto-erased), VoicemailCryptoUnavailable (KMS / DB / config
    down), VoicemailIntegrityError (no key row for the customer; KMS response
    CRC checks).
    """
    aad = transcript_aad(customer_id, mailbox_id, msg_uuid)
    if not isinstance(plaintext, (bytes, bytearray, memoryview)):
        raise ValueError("plaintext must be bytes")
    if len(plaintext) == 0:
        raise ValueError("plaintext is empty")
    if len(plaintext) > MAX_TRANSCRIPT_PLAINTEXT:
        raise ValueError("transcript plaintext too large")

    key = await get_customer_key(customer_id)
    if key is None:
        raise VoicemailIntegrityError("no voicemail key exists for this customer")
    _require_active(key)
    provider = get_kms_provider(key.provider)

    dek = bytearray(os.urandom(DEK_BYTES))
    try:
        wrapped, kek_version = await provider.wrap_dek(
            customer_id=customer_id, key_ref=key.key_ref, dek=dek, aad=aad)
        iv = os.urandom(IV_BYTES)
        # AESGCM takes any buffer: no extra immutable copy of the plaintext.
        ciphertext = AESGCM(dek).encrypt(iv, plaintext, aad)
    finally:
        _zero(dek)
    return SealedBlob(ciphertext=ciphertext, wrapped_dek=wrapped, kek_version=kek_version,
                      iv=iv, enc_algo=ENC_ALGO)


async def open_transcript(*, customer_id: int, mailbox_id: int, msg_uuid: str | _uuid.UUID,
                          ciphertext: bytes, wrapped_dek: bytes, iv: bytes) -> bytes:
    """Decrypt a sealed transcript (row fields) of message ``msg_uuid``.

    Row shapes are validated first (iv 12 bytes, ciphertext 17..65552 bytes,
    wrapped DEK non-empty), then the customer's key must exist and be active,
    then KMS unwraps the DEK under the ``vmt:`` AAD and AES-GCM decrypts under
    the same AAD. A blob or wrapped DEK moved from another message / mailbox /
    customer, or from the audio (``vm:``), fails here.

    Raises VoicemailIntegrityError (-> 500, never serve: malformed row data, no
    key row, GCM tag / AAD mismatch, KMS InvalidArgument), VoicemailKeyDestroyed
    (crypto-erased), VoicemailCryptoUnavailable (-> 503: KMS / DB down),
    ValueError (non-positive ids / bad uuid — a programming error).
    """
    aad = transcript_aad(customer_id, mailbox_id, msg_uuid)
    if not isinstance(iv, (bytes, bytearray, memoryview)) or len(iv) != IV_BYTES:
        raise VoicemailIntegrityError("stored transcript IV is malformed")
    if (not isinstance(ciphertext, (bytes, bytearray, memoryview))
            or not _MIN_TRANSCRIPT_CIPHERTEXT <= len(ciphertext) <= _MAX_TRANSCRIPT_CIPHERTEXT):
        raise VoicemailIntegrityError("stored transcript ciphertext is malformed")
    if not isinstance(wrapped_dek, (bytes, bytearray, memoryview)) or len(wrapped_dek) == 0:
        raise VoicemailIntegrityError("stored transcript wrapped DEK is malformed")

    key = await get_customer_key(customer_id)
    if key is None:
        raise VoicemailIntegrityError("no voicemail key exists for this customer")
    _require_active(key)
    provider = get_kms_provider(key.provider)

    dek = await provider.unwrap_dek(customer_id=customer_id, key_ref=key.key_ref,
                                    wrapped_dek=bytes(wrapped_dek), aad=aad)
    try:
        return AESGCM(dek).decrypt(bytes(iv), bytes(ciphertext), aad)
    except InvalidTag as exc:
        raise VoicemailIntegrityError(
            "AES-GCM authentication failed (AAD mismatch or tampered transcript)") from exc
    finally:
        _zero(dek)
