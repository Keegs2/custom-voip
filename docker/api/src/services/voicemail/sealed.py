"""``POST /v1/voicemail/fs/deposit-sealed`` — deliver a message FreeSWITCH
SEALED to its spool during an East outage (Visual IVR plan D11 / §7.5;
contract docs/IVR_INTERFACES.md §8.4; design docs/VOICEMAIL_OUTAGE_RESILIENCE.md).

Request (``docker/vm-forwarder``, replaying ``/var/lib/crag/vm-spool``)::

    POST /v1/voicemail/fs/deposit-sealed
    X-Ingest-Secret: <secret>              (router dependency, checked first)
    Content-Type: application/octet-stream
    X-VM-Meta: base64url(JSON)             (the sidecar's bytes, unpadded)
    body: the CMS AuthEnvelopedData DER blob (lib/vm_spool.lua)

``X-VM-Meta`` JSON: ``{"v":1, "msg_uuid", "mailbox_id", "did",
"caller_number", "caller_name"?, "received_at" (ISO-8601 UTC), "duration_ms",
"zone"}``.

Responses (what the forwarder does):
  201 ``{"status":"stored","message_id":N}``     delete the spool file
  200 ``{"status":"duplicate","message_id":N}``  delete (already delivered)
  410 ``{"detail":"dropped: <reason>"}``         delete; a ``spool_drop``
       audit row was committed first (mailbox deleted / not accepting / key
       crypto-erased / longer than the mailbox allows)
  422 ``{"detail":"bad_meta: ..."|"bad_blob: ..."}``  permanent -> rejected/
  503 (+ Retry-After)                            keep, retry with backoff:
       spool key not configured (VOICEMAIL_SPOOL_PRIVATE_KEY_B64), blob sealed
       to a key this API does not hold, DB/KMS/GCS unavailable, busy.
Anything else (401 bad secret, 404 = an API without this route) is retried.

Order (cheapest first; nothing is decrypted before the request is known to
be well-formed, nothing is written before the blob authenticated):
  X-VM-Meta (422) -> Content-Type (422) -> Content-Length cap (422) -> spool
  key loaded (503) -> received_at sane (422) -> concurrency slot (503) ->
  body read (422) -> unseal in RAM (422 / 503) -> frame + sealed metadata ==
  X-VM-Meta (422) -> WAV (422) -> the EXISTING deposit pipeline
  (deposit.py ``_process`` with ``Mode(sealed=True)``): claim (re-checks the
  mailbox -> 410 + audit), per-customer KMS seal + upload, finalize + the
  ``deposit`` audit row (detail adds ``via: spool`` + ``received_at``) — the
  same idempotency on ``msg_uuid``, leases, deadline and late finisher as a
  live deposit, and ``created_at`` = ``received_at``.

D8: the ciphertext, the decrypted frame and the WAV are ``bytearray``s in
this process only (never ``request.form()`` / a temp file / a log); each is
zeroed as soon as it is no longer needed and the WAV buffer is released with
the deposit slot.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException
from starlette.responses import JSONResponse

from . import audit
from . import spool_crypto
from .body import declared_length, read_capped_body, zero
from .deposit import (
    DEPOSIT_BODY_CAP,
    DEPOSIT_DEADLINE_S,
    RETRY_AFTER,
    Mode,
    _err,
    _process,
    _Slot,
    _spawn,
    deposit_limiter,
)
from .meta import INT32_MAX, DepositMeta, MetaError, decode_meta_bytes, decode_meta_header
from .wav import WavError, parse_wav

logger = logging.getLogger(__name__)

CONTENT_TYPE = "application/octet-stream"
#: The WAV cap of a live deposit + room for the frame header and the CMS
#: envelope (4 recipients of 4096-bit RSA ~ 2.5 KB).
SEALED_BODY_CAP = DEPOSIT_BODY_CAP + 256 * 1024
FRAME_MAGIC = b"CRAGVMS1\n"
FRAME_META_MAX = 4096
#: A received_at older than this is not a spool replay (the forwarder drops
#: at 7 days) -> 422.
RECEIVED_MAX_AGE = timedelta(days=31)
#: A received_at in the future (FS clock ahead) is clamped to now; beyond
#: this skew it is logged.
RECEIVED_FUTURE_SKEW = timedelta(minutes=5)

#: Optional string fields -> max code points (voicemail_messages columns /
#: what lib/vm_box.lua truncates to).
SEALED_STRING_FIELDS: dict[str, int] = {
    "did": 20,
    "caller_number": 40,
    "caller_name": 100,
    "zone": 16,
}


@dataclass(frozen=True)
class SealedMeta:
    msg_uuid: str
    mailbox_id: int
    received_at: datetime
    duration_ms: int
    did: str | None
    caller_number: str | None
    caller_name: str | None
    zone: str | None

    def deposit_meta(self) -> DepositMeta:
        """The live-deposit metadata shape the shared pipeline consumes. A
        sealed message has no call_uuid / fs_node (contract §8.4 keeps the
        sidecar to the routing fields); the CDR links it by vm_msg_uuid."""
        return DepositMeta(v=1, msg_uuid=self.msg_uuid, mailbox_id=self.mailbox_id,
                           duration_ms=self.duration_ms, did=self.did,
                           caller_id_number=self.caller_number,
                           caller_id_name=self.caller_name, call_uuid=None, fs_node=None,
                           zone=self.zone)


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _parse_received_at(value: Any) -> datetime:
    if not isinstance(value, str) or not 20 <= len(value) <= 40:
        raise MetaError("received_at must be an ISO-8601 UTC timestamp")
    try:
        ts = datetime.fromisoformat(value)
    except ValueError as exc:
        raise MetaError("received_at must be an ISO-8601 UTC timestamp") from exc
    if ts.tzinfo is None or ts.utcoffset() != timedelta(0):
        raise MetaError("received_at must be UTC")
    return ts.astimezone(timezone.utc)


def parse_sealed_meta(obj: dict[str, Any]) -> SealedMeta:
    """Validate a decoded sealed-metadata object. Raises MetaError. Same
    hardening as meta.parse_meta (strict ints, UUID, column-width strings,
    C0 controls -> space, empty -> None); unknown keys are ignored."""
    v = obj.get("v")
    if not _is_int(v) or v != 1:
        raise MetaError("v must be 1")
    raw_uuid = obj.get("msg_uuid")
    if not isinstance(raw_uuid, str) or len(raw_uuid) > 64:
        raise MetaError("msg_uuid must be a UUID string")
    try:
        msg_uuid = str(uuid.UUID(raw_uuid))
    except ValueError as exc:
        raise MetaError("msg_uuid must be a UUID string") from exc
    mailbox_id = obj.get("mailbox_id")
    if not _is_int(mailbox_id) or not 1 <= mailbox_id <= INT32_MAX:
        raise MetaError("mailbox_id must be a positive integer")
    duration_ms = obj.get("duration_ms")
    if not _is_int(duration_ms) or not 0 <= duration_ms <= INT32_MAX:
        raise MetaError("duration_ms must be a non-negative integer")
    received_at = _parse_received_at(obj.get("received_at"))
    strings: dict[str, str | None] = {}
    for key, limit in SEALED_STRING_FIELDS.items():
        raw = obj.get(key)
        if raw is None:
            strings[key] = None
            continue
        if not isinstance(raw, str):
            raise MetaError(f"{key} must be a string")
        if any(0xD800 <= ord(ch) <= 0xDFFF for ch in raw):
            raise MetaError(f"{key} is not valid text")
        if len(raw) > limit:
            raise MetaError(f"{key} is longer than {limit} characters")
        cleaned = "".join(" " if ord(ch) < 0x20 or ord(ch) == 0x7F else ch for ch in raw).strip()
        strings[key] = cleaned or None
    return SealedMeta(msg_uuid=msg_uuid, mailbox_id=mailbox_id, received_at=received_at,
                      duration_ms=duration_ms, **strings)


def parse_frame(plain: bytes | bytearray) -> tuple[int, int, int]:
    """``CRAGVMS1\\n<len>\\n<META><WAV>`` -> (meta_start, meta_end, wav_start).
    Raises spool_crypto.SpoolBlobInvalid."""
    bad = spool_crypto.SpoolBlobInvalid
    if bytes(plain[:len(FRAME_MAGIC)]) != FRAME_MAGIC:
        raise bad("the sealed content is not a CRAGVMS1 frame")
    pos = len(FRAME_MAGIC)
    nl = plain.find(b"\n", pos, pos + 6)
    digits = bytes(plain[pos:nl]) if nl > pos else b""
    if not digits.isdigit() or (len(digits) > 1 and digits[:1] == b"0"):
        raise bad("the frame's metadata length is malformed")
    n = int(digits)
    if not 2 <= n <= FRAME_META_MAX:
        raise bad("the frame's metadata length is out of range")
    meta_start = nl + 1
    meta_end = meta_start + n
    if meta_end + 44 > len(plain):
        raise bad("the frame is truncated")
    return meta_start, meta_end, meta_end


def _received_or_422(ts: datetime) -> datetime:
    now = datetime.now(timezone.utc)
    if ts > now:
        if ts - now > RECEIVED_FUTURE_SKEW:
            logger.warning("voicemail sealed deposit: received_at %s is %s ahead of the API "
                           "clock — clamped to now (check NTP on the media VM)",
                           ts.isoformat(), ts - now)
        return now
    if now - ts > RECEIVED_MAX_AGE:
        raise _err(422, "bad_meta: received_at is older than the spool can hold.")
    return ts


def _bad(detail: str) -> HTTPException:
    return _err(422, detail)


async def handle_deposit_sealed(request: Any) -> JSONResponse:
    """Router entry point (ingest secret already verified)."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + DEPOSIT_DEADLINE_S
    try:
        header_obj = decode_meta_header(request.headers.get("x-vm-meta"))
        smeta = parse_sealed_meta(header_obj)
    except MetaError as exc:
        logger.warning("voicemail sealed deposit rejected: %s", exc)
        raise _bad(f"bad_meta: {exc}")
    media = (request.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
    if media != CONTENT_TYPE:
        raise _bad("bad_blob: Content-Type must be application/octet-stream.")
    try:
        declared_length(request, SEALED_BODY_CAP, too_large="Sealed message is too large.")
    except HTTPException as exc:
        raise _bad(f"bad_blob: {exc.detail}")
    try:
        keys = spool_crypto.load_spool_keys()
    except spool_crypto.SpoolKeyUnavailable as exc:
        logger.error("voicemail sealed deposit %s: %s — 503 (the forwarder keeps it; set %s on "
                     "the services VM)", smeta.msg_uuid, exc, spool_crypto.ENV_KEY)
        raise _err(503, "Spool key is not configured; retry later.", RETRY_AFTER)
    received_at = _received_or_422(smeta.received_at)

    if not deposit_limiter.try_acquire():
        logger.warning("voicemail sealed deposit %s: concurrency limit (%d) reached — 503",
                       smeta.msg_uuid, deposit_limiter.limit)
        raise _err(503, "Voicemail deposit is busy; retry shortly.", RETRY_AFTER)
    slot = _Slot()
    task: asyncio.Task | None = None
    try:
        try:
            blob = await read_capped_body(request, SEALED_BODY_CAP,
                                          too_large="Sealed message is too large.")
        except HTTPException as exc:
            if exc.status_code in (400, 413):
                raise _bad(f"bad_blob: {exc.detail}")
            raise
        try:
            plain = spool_crypto.unseal(blob, keys)
        except spool_crypto.SpoolNoRecipient:
            logger.error("voicemail sealed deposit %s: not sealed to any configured spool key "
                         "(rotation: add the new key to %s BEFORE its certificate reaches the "
                         "media VMs) — 503, kept", smeta.msg_uuid, spool_crypto.ENV_KEY)
            raise _err(503, "Sealed to an unknown spool key; retry later.", RETRY_AFTER)
        except spool_crypto.SpoolBlobInvalid as exc:
            logger.error("voicemail sealed deposit %s: bad blob: %s", smeta.msg_uuid, exc)
            raise _bad(f"bad_blob: {exc}")
        finally:
            zero(blob)
        try:
            meta_start, meta_end, wav_start = parse_frame(plain)
            inner = decode_meta_bytes(bytes(plain[meta_start:meta_end]))
            if inner != header_obj:
                raise spool_crypto.SpoolBlobInvalid(
                    "X-VM-Meta does not match the metadata sealed in the blob")
            if len(plain) - wav_start > DEPOSIT_BODY_CAP:
                raise spool_crypto.SpoolBlobInvalid("the sealed recording is larger than 10 MB")
            view = memoryview(plain)
            try:
                slot.body = bytearray(view[wav_start:])
            finally:
                view.release()
        except (spool_crypto.SpoolBlobInvalid, MetaError) as exc:
            logger.error("voicemail sealed deposit %s: bad blob: %s", smeta.msg_uuid, exc)
            raise _bad(f"bad_blob: {exc}")
        finally:
            zero(plain)
        try:
            wav = parse_wav(slot.body, noun="Recording", lenient_data_size=True)
        except WavError as exc:
            raise _bad(f"bad_blob: {exc.detail}")
        info = audit.RequestInfo.from_request(request)
        mode = Mode(sealed=True, received_at=received_at, info=info,
                    detail_extra={"via": "spool", "received_at": received_at.isoformat()})
        task = _spawn(_process(smeta.deposit_meta(), slot, wav.duration_ms, deadline, info, mode))
    finally:
        if task is None:
            slot.release()

    def _done(_t: asyncio.Task) -> None:
        if not slot.handed_off:
            slot.release()

    task.add_done_callback(_done)
    try:
        return await asyncio.shield(task)
    except HTTPException as exc:
        if exc.status_code in (410, 422, 503):
            raise
        # The shared pipeline only maps to 410/422/503 in sealed mode; any
        # other status is unexpected — keep the file (503) rather than drop it.
        logger.error("voicemail sealed deposit %s: unexpected %s %s — answered 503",
                     smeta.msg_uuid, exc.status_code, exc.detail)
        raise _err(503, "Voicemail deposit failed; retry.", RETRY_AFTER)
