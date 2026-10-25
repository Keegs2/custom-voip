"""Strict parser for the FreeSWITCH deposit metadata header (contract §5).

``X-VM-Meta`` = base64url (RFC 4648 §5) of a UTF-8 JSON object, NO padding,
as built by ``docker/freeswitch/scripts/lib/vm_deposit.lua`` (``M.b64url``)
from the table in ``lib/vm_box.lua deposit_phase``:

    {"v":1, "msg_uuid":"<uuid4>", "mailbox_id":123, "did":"+1...",
     "caller_id_number":"...", "caller_id_name":"...", "duration_ms":12345,
     "call_uuid":"<fs uuid>", "fs_node":"east-fs-1", "zone":"east"}

Hardening (every failure is a :class:`MetaError` -> HTTP 400, FS does not
retry a 400):

* the raw header must match ``[A-Za-z0-9_-]{2,8192}`` BEFORE decoding —
  ``base64.urlsafe_b64decode`` silently discards any other character, so
  junk could otherwise decode "successfully";
* a length that is 1 mod 4 cannot be base64; padding is re-added, never sent;
* the bytes must be strict UTF-8 JSON, a single object, no duplicate keys,
  no lone surrogates, at most 32 keys;
* ``v`` must be the integer 1, ``msg_uuid`` a UUID (canonicalised lower-case),
  ``mailbox_id`` a positive int32, ``duration_ms`` (optional) a non-negative
  int32 — JSON booleans are NOT integers here;
* every string field is optional, must be a JSON string and fit its DB column
  (code points, the same unit FS truncates in). C0 controls / DEL are
  replaced by a space (FS already strips them; a non-FS client must not be
  able to store them), and an empty string becomes ``None``.

Unknown keys are ignored (forward compatibility within ``v=1``) — they are
never stored.
"""
from __future__ import annotations

import base64
import binascii
import json
import re
import uuid
from dataclasses import dataclass
from typing import Any

MAX_META_CHARS = 8192
MAX_KEYS = 32
INT32_MAX = 2_147_483_647

_B64URL_RE = re.compile(r"[A-Za-z0-9_-]+", re.ASCII)
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")

#: Optional string fields -> max code points (DB column widths, contract §1).
STRING_FIELDS: dict[str, int] = {
    "did": 20,
    "caller_id_number": 40,
    "caller_id_name": 100,
    "call_uuid": 64,
    "fs_node": 64,
    "zone": 16,
}


class MetaError(ValueError):
    """Malformed X-VM-Meta -> 400. The message never echoes the header."""


@dataclass(frozen=True)
class DepositMeta:
    v: int
    msg_uuid: str
    mailbox_id: int
    duration_ms: int | None
    did: str | None
    caller_id_number: str | None
    caller_id_name: str | None
    call_uuid: str | None
    fs_node: str | None
    zone: str | None


def _no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise MetaError("X-VM-Meta has a duplicate key")
        out[key] = value
    return out


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _has_surrogate(s: str) -> bool:
    return any(0xD800 <= ord(ch) <= 0xDFFF for ch in s)


def decode_meta_header(value: str | None) -> dict[str, Any]:
    """Header string -> JSON object (dict). Raises MetaError."""
    if value is None or value == "":
        raise MetaError("missing X-VM-Meta header")
    if len(value) > MAX_META_CHARS:
        raise MetaError("X-VM-Meta is too long")
    if not _B64URL_RE.fullmatch(value):
        raise MetaError("X-VM-Meta must be unpadded base64url")
    if len(value) % 4 == 1:
        raise MetaError("X-VM-Meta is not valid base64url")
    try:
        raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (binascii.Error, ValueError) as exc:
        raise MetaError("X-VM-Meta is not valid base64url") from exc
    return decode_meta_bytes(raw)


def decode_meta_bytes(raw: bytes | bytearray | memoryview) -> dict[str, Any]:
    """Strict UTF-8 JSON object (no duplicate keys, <= MAX_KEYS keys) ->
    dict. Shared by the X-VM-Meta header and the metadata sealed inside a
    spool blob (``sealed.py``). Raises MetaError."""
    try:
        text = bytes(raw).decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise MetaError("X-VM-Meta is not UTF-8") from exc
    try:
        obj = json.loads(text, object_pairs_hook=_no_duplicates)
    except MetaError:
        raise
    except (json.JSONDecodeError, RecursionError, ValueError) as exc:
        raise MetaError("X-VM-Meta is not valid JSON") from exc
    if not isinstance(obj, dict):
        raise MetaError("X-VM-Meta must be a JSON object")
    if len(obj) > MAX_KEYS:
        raise MetaError("X-VM-Meta has too many keys")
    return obj


def parse_meta(value: str | None) -> DepositMeta:
    """Validate the X-VM-Meta header and return the typed metadata."""
    obj = decode_meta_header(value)

    v = obj.get("v")
    if not _is_int(v) or v != 1:
        raise MetaError("X-VM-Meta v must be 1")

    raw_uuid = obj.get("msg_uuid")
    if not isinstance(raw_uuid, str) or len(raw_uuid) > 64:
        raise MetaError("X-VM-Meta msg_uuid must be a UUID string")
    try:
        msg_uuid = str(uuid.UUID(raw_uuid))
    except ValueError as exc:
        raise MetaError("X-VM-Meta msg_uuid must be a UUID string") from exc

    mailbox_id = obj.get("mailbox_id")
    if not _is_int(mailbox_id) or not 1 <= mailbox_id <= INT32_MAX:
        raise MetaError("X-VM-Meta mailbox_id must be a positive integer")

    duration_ms = obj.get("duration_ms")
    if duration_ms is not None and (not _is_int(duration_ms)
                                    or not 0 <= duration_ms <= INT32_MAX):
        raise MetaError("X-VM-Meta duration_ms must be a non-negative integer")

    strings: dict[str, str | None] = {}
    for key, limit in STRING_FIELDS.items():
        raw = obj.get(key)
        if raw is None:
            strings[key] = None
            continue
        if not isinstance(raw, str):
            raise MetaError(f"X-VM-Meta {key} must be a string")
        if _has_surrogate(raw):
            raise MetaError(f"X-VM-Meta {key} is not valid text")
        if len(raw) > limit:
            raise MetaError(f"X-VM-Meta {key} is longer than {limit} characters")
        cleaned = _CONTROL_RE.sub(" ", raw).strip()
        strings[key] = cleaned or None

    return DepositMeta(v=1, msg_uuid=msg_uuid, mailbox_id=mailbox_id,
                       duration_ms=duration_ms, **strings)


def encode_meta(obj: dict[str, Any]) -> str:
    """Encode like vm_deposit.lua (sorted keys, compact, base64url, no
    padding). Tests/tools only."""
    body = json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return base64.urlsafe_b64encode(body.encode("utf-8")).decode("ascii").rstrip("=")
