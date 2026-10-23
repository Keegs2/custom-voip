"""Serving decrypted voicemail audio (contract §4.2 / §4.3 / §4.5, plan §3.3).

* Decrypt ONCE per playback token (``jti``) per worker process into
  :data:`PLAYBACK_CACHE` (64 MB per process, entry TTL = the token's remaining
  lifetime <= 120 s); every Range request of that token is a slice of it.
* The ``play`` / ``download`` / ``greeting_play`` audit row is written once
  per token across ALL worker processes (``uq_vm_access_log_playback_jti`` +
  ``ON CONFLICT DO NOTHING``) — inside the cache loader, AFTER the decrypt
  and BEFORE any byte is served: an audit failure means 503 and no audio
  (defect 10), and nothing is cached.
* HEAD is answered from the row (``size_bytes``) — no decrypt, no audit
  (no audio leaves the API).
* Range: one ``bytes=a-b`` / ``bytes=a-`` / ``bytes=-n`` range -> 206 with
  ``Content-Range``; unsatisfiable -> 416 ``bytes */size``; multi-range or a
  malformed header is ignored (full 200, RFC 9110 §14.2 allows that).
* Every audio response: ``Content-Type: audio/wav``, ``Accept-Ranges: bytes``,
  ``Cache-Control: no-store``, ``X-Content-Type-Options: nosniff`` and
  ``Content-Disposition`` (inline, or attachment with a safe filename).
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from starlette.responses import Response

from .crypto import greeting_aad, load_and_open, message_aad
from .errors import VoicemailCryptoUnavailable
from .limits import NonBlockingLimiter
from .plaintext_cache import PlaintextCache

PLAYBACK_CACHE_BYTES = 64 * 1024 * 1024
FS_GREETING_CACHE_BYTES = 16 * 1024 * 1024
FS_GREETING_TTL_S = 30.0

PLAYBACK_CACHE = PlaintextCache(PLAYBACK_CACHE_BYTES)
FS_GREETING_CACHE = PlaintextCache(FS_GREETING_CACHE_BYTES)

#: Concurrent decrypts per worker process (cache misses only — concurrent
#: requests for one token share a single load). Bounds the transient RAM of
#: plaintext + ciphertext copies (a 300 s message is ~4.8 MB) so a burst of
#: playback cannot push the API container toward its memory limit.
DECRYPT_CONCURRENCY = 6
decrypt_limiter = NonBlockingLimiter(DECRYPT_CONCURRENCY)


class DecryptBusy(VoicemailCryptoUnavailable):
    """Too many concurrent decrypts in this worker -> 503 + Retry-After."""

_RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)", re.ASCII)
_FILENAME_SAFE = re.compile(r"[^0-9A-Za-z+]+", re.ASCII)


def parse_range(header: str | None, size: int) -> tuple[int, int] | str | None:
    """Single byte range -> inclusive (start, end); ``"unsatisfiable"``; or
    None (serve everything)."""
    if not header:
        return None
    m = _RANGE_RE.fullmatch(header.strip())
    if not m:
        return None  # multi-range, other units, junk -> ignore the header
    first, last = m.groups()
    if first == "" and last == "":
        return None
    if first == "":
        suffix = int(last)
        if suffix == 0 or size == 0:
            return "unsatisfiable"
        return max(0, size - suffix), size - 1
    start = int(first)
    end = int(last) if last != "" else size - 1
    if last != "" and end < start:
        return None  # syntactically invalid -> ignore
    if start >= size:
        return "unsatisfiable"
    return start, min(end, size - 1)


def _base_headers(disposition: str) -> dict[str, str]:
    return {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": disposition,
    }


def audio_response(data: bytes | None, *, size: int, range_header: str | None,
                   disposition: str, head: bool = False) -> Response:
    """Full / partial / 416 response over ``data`` (``data`` may be None for
    HEAD, where only ``size`` matters)."""
    headers = _base_headers(disposition)
    rng = parse_range(range_header, size)
    if rng == "unsatisfiable":
        headers["Content-Range"] = f"bytes */{size}"
        return Response(status_code=416, headers=headers)
    if rng is None:
        headers["Content-Length"] = str(size)
        return Response(content=b"" if head else data, status_code=200,
                        media_type="audio/wav", headers=headers)
    start, end = rng
    headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    headers["Content-Length"] = str(end - start + 1)
    body = b"" if head else data[start:end + 1]
    return Response(content=body, status_code=206, media_type="audio/wav", headers=headers)


def disposition_for(*, download: bool, created_at: datetime | None, timezone: str | None,
                    caller: str | None, prefix: str = "voicemail") -> str:
    if not download:
        return "inline"
    when = "unknown"
    if created_at is not None:
        try:
            tz = ZoneInfo(timezone) if timezone else None
        except Exception:  # noqa: BLE001 — fall back to UTC
            tz = None
        local = created_at.astimezone(tz) if tz else created_at
        when = local.strftime("%Y%m%d-%H%M%S")
    who = _FILENAME_SAFE.sub("", caller or "")[:40] or "unknown"
    return f'attachment; filename="{prefix}-{when}-{who}.wav"'


async def _limited_open(**kw: Any) -> bytes:
    if not decrypt_limiter.try_acquire():
        raise DecryptBusy("too many concurrent voicemail decrypts in this worker")
    try:
        return await load_and_open(**kw)
    finally:
        decrypt_limiter.release()


async def decrypt_message(row: Any) -> bytes:
    """Row needs customer_id, mailbox_id, msg_uuid, object_key, wrapped_dek,
    iv, ciphertext_crc32c."""
    return await _limited_open(
        customer_id=row["customer_id"], object_key=row["object_key"],
        aad=message_aad(row["customer_id"], row["mailbox_id"], row["msg_uuid"]),
        wrapped_dek=row["wrapped_dek"], iv=row["iv"],
        ciphertext_crc32c=row["ciphertext_crc32c"])


async def decrypt_greeting(row: Any) -> bytes:
    return await _limited_open(
        customer_id=row["customer_id"], object_key=row["object_key"],
        aad=greeting_aad(row["customer_id"], row["mailbox_id"], row["greeting_uuid"]),
        wrapped_dek=row["wrapped_dek"], iv=row["iv"],
        ciphertext_crc32c=row["ciphertext_crc32c"])


def evict_object(kind: str, obj_id: int) -> None:
    """Drop this process's cached plaintext of a purged message/greeting
    (other processes age out within <= 120 s / 30 s; every request re-checks
    the row first, so a purged object is never SERVED from any cache)."""
    PLAYBACK_CACHE.evict(lambda _k, tag: tag == (kind, obj_id))
    if kind == "greeting":
        FS_GREETING_CACHE.evict(lambda _k, tag: tag == (kind, obj_id))
