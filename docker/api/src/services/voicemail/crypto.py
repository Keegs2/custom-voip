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

__all__ = [
    "ENC_ALGO", "Sealed", "crc32c",
    "message_aad", "greeting_aad", "message_object_key", "greeting_object_key",
    "seal_and_store", "load_and_open", "delete_object",
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
