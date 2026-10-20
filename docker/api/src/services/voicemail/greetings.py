"""Custom greeting upload (contract §4.3): raw ``audio/wav`` body (<= 5 MB,
<= 120 s, PCM s16le mono 8000|16000 Hz — validated strictly, never
transcoded), sealed exactly like a message (AAD ``vmg:{c}:{m}:{uuid}``).

Row lifecycle mirrors the deposit: INSERT 'pending' first, seal + upload,
then ONE transaction sets 'stored' + every crypto field, writes the
``greeting_upload`` audit row and (``activate=true``) points the mailbox at it
with ``greeting_mode='custom'``. A failure marks the row 'failed' (the
retention worker deletes any object and purges the row after a grace period).
Each upload uses a fresh greeting_uuid, so there is no takeover/zombie race.
"""
from __future__ import annotations

import asyncio
import logging
import uuid as _uuid
from typing import Any

from fastapi import HTTPException

from db import database as db

from . import audit
from .body import content_type_is_wav, declared_length, read_capped_body, zero
from .crypto import greeting_aad, greeting_object_key, seal_and_store
from .errors import VoicemailCryptoUnavailable, VoicemailIntegrityError
from .limits import NonBlockingLimiter
from .mailboxes import MSG_CRYPTO_DOWN, MSG_MAILBOX_NOT_FOUND, crypto_http_error
from .wav import WavError, parse_wav

logger = logging.getLogger(__name__)

GREETING_BODY_CAP = 5 * 1024 * 1024
GREETING_MAX_MS = 120_000
GREETING_CONCURRENCY = 3
GREETING_SEAL_TIMEOUT_S = 20.0
MAX_GREETINGS_PER_MAILBOX = 20

MSG_TOO_LARGE = "Greeting must be 5 MB or smaller."
MSG_NOT_WAV = "Greeting must be a WAV file."
MSG_TOO_LONG = "Greeting must be 2 minutes or shorter."
MSG_TOO_MANY = (f"This mailbox already has {MAX_GREETINGS_PER_MAILBOX} greetings. "
                "Delete one first.")
MSG_BUSY = "Too many uploads at once. Try again in a moment."

greeting_limiter = NonBlockingLimiter(GREETING_CONCURRENCY)

GREETING_FIELDS = ("id", "mailbox_id", "label", "duration_ms", "size_bytes", "is_active",
                   "created_at")

GREETING_SELECT = """
SELECT g.id, g.mailbox_id, g.label, g.duration_ms, g.size_bytes, g.created_at,
       (b.active_greeting_id IS NOT DISTINCT FROM g.id) AS is_active
  FROM voicemail_greetings g
  JOIN voicemail_boxes b ON b.id = g.mailbox_id
"""


def greeting_out(row: Any) -> dict:
    return {k: row[k] for k in GREETING_FIELDS}


async def upload_greeting(request: Any, *, box: Any, label: str, activate: bool,
                          info: audit.RequestInfo) -> dict:
    """``box`` is the caller's already-authorised mailbox row."""
    if not content_type_is_wav(request.headers.get("content-type")):
        raise HTTPException(status_code=415, detail=MSG_NOT_WAV)
    declared_length(request, GREETING_BODY_CAP, too_large=MSG_TOO_LARGE)
    if not greeting_limiter.try_acquire():
        raise HTTPException(status_code=503, detail=MSG_BUSY, headers={"Retry-After": "2"})
    body: bytearray | None = None
    try:
        body = await read_capped_body(request, GREETING_BODY_CAP, too_large=MSG_TOO_LARGE)
        try:
            wav = parse_wav(body, noun="Greeting", lenient_data_size=False)
        except WavError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.detail)
        if wav.duration_ms > GREETING_MAX_MS:
            raise HTTPException(status_code=422, detail=MSG_TOO_LONG)
        return await _store(box=box, body=body, duration_ms=wav.duration_ms, label=label,
                            activate=activate, info=info)
    finally:
        greeting_limiter.release()
        zero(body)


async def _store(*, box: Any, body: bytearray, duration_ms: int, label: str, activate: bool,
                 info: audit.RequestInfo) -> dict:
    pool = db.pool or await db.get_pool()
    customer_id, mailbox_id = box["customer_id"], box["id"]
    greeting_uuid = str(_uuid.uuid4())
    async with pool.acquire() as conn:
        async with conn.transaction():
            # Serialise uploads per mailbox for the count check.
            locked = await conn.fetchval(
                "SELECT id FROM voicemail_boxes WHERE id = $1::int AND status <> 'deleted' "
                "FOR UPDATE", mailbox_id)
            if locked is None:
                raise HTTPException(status_code=404, detail=MSG_MAILBOX_NOT_FOUND)
            count = await conn.fetchval(
                "SELECT count(*) FROM voicemail_greetings WHERE mailbox_id = $1::int "
                "AND status IN ('stored', 'pending')", mailbox_id)
            if count >= MAX_GREETINGS_PER_MAILBOX:
                raise HTTPException(status_code=409, detail=MSG_TOO_MANY)
            greeting_id = await conn.fetchval(
                """
                INSERT INTO voicemail_greetings
                       (greeting_uuid, mailbox_id, customer_id, label, duration_ms, size_bytes,
                        status, created_by)
                VALUES ($1::uuid, $2::int, $3::int, $4::varchar, $5::int, $6::int, 'pending',
                        (SELECT id FROM users WHERE id = $7::int))
                RETURNING id
                """,
                greeting_uuid, mailbox_id, customer_id, label, duration_ms, len(body),
                info.actor_user_id)

    async def _fail() -> None:
        try:
            async with pool.acquire() as c:
                await c.execute("UPDATE voicemail_greetings SET status = 'failed' "
                                "WHERE id = $1::int AND status = 'pending'", greeting_id)
        except Exception as exc:  # noqa: BLE001 — the retention worker covers it
            logger.error("voicemail greeting %s: could not mark failed: %s", greeting_id, exc)

    try:
        async with asyncio.timeout(GREETING_SEAL_TIMEOUT_S):
            sealed = await seal_and_store(
                customer_id=customer_id,
                object_key=greeting_object_key(customer_id, mailbox_id, greeting_uuid),
                aad=greeting_aad(customer_id, mailbox_id, greeting_uuid), plaintext=body)
    except TimeoutError:
        logger.error("voicemail greeting %s: seal/upload timed out", greeting_id)
        await _fail()
        raise HTTPException(status_code=503, detail=MSG_CRYPTO_DOWN, headers={"Retry-After": "5"})
    except VoicemailCryptoUnavailable as exc:
        logger.error("voicemail greeting %s: KMS/GCS unavailable: %s", greeting_id, exc)
        await _fail()
        raise crypto_http_error(exc)
    except VoicemailIntegrityError as exc:
        logger.error("voicemail greeting %s: integrity failure on upload: %s", greeting_id, exc)
        await _fail()
        raise HTTPException(status_code=503, detail=MSG_CRYPTO_DOWN, headers={"Retry-After": "5"})
    except BaseException:
        await _fail()
        raise

    try:
        async with pool.acquire() as conn:
            async with conn.transaction():
                done = await conn.fetchval(
                    """
                    UPDATE voicemail_greetings g
                       SET status = 'stored', object_key = $2::text,
                           ciphertext_crc32c = $3::bigint, wrapped_dek = $4::bytea,
                           kek_version = $5::text, iv = $6::bytea, enc_algo = $7::varchar
                     WHERE g.id = $1::int AND g.status = 'pending'
                       AND EXISTS (SELECT 1 FROM voicemail_boxes b
                                    WHERE b.id = g.mailbox_id AND b.status <> 'deleted')
                    RETURNING g.id
                    """,
                    greeting_id, sealed.object_key, sealed.ciphertext_crc32c, sealed.wrapped_dek,
                    sealed.kek_version, sealed.iv, sealed.enc_algo)
                if done is None:
                    raise HTTPException(status_code=404, detail=MSG_MAILBOX_NOT_FOUND)
                await audit.write_audit(
                    conn, action="greeting_upload", source="ui", customer_id=customer_id,
                    mailbox_id=mailbox_id, greeting_id=greeting_id, info=info,
                    detail={"duration_ms": duration_ms, "size_bytes": len(body),
                            "activate": activate})
                if activate:
                    await conn.execute(
                        "UPDATE voicemail_boxes SET active_greeting_id = $1::int, "
                        "greeting_mode = 'custom', updated_at = now() WHERE id = $2::int",
                        greeting_id, mailbox_id)
            row = await conn.fetchrow(GREETING_SELECT + " WHERE g.id = $1::int", greeting_id)
    except HTTPException:
        await _fail()
        raise
    except Exception as exc:
        logger.error("voicemail greeting %s: finalize/audit failed: %s: %s", greeting_id,
                     type(exc).__name__, exc)
        await _fail()
        raise HTTPException(status_code=503, detail=MSG_CRYPTO_DOWN, headers={"Retry-After": "5"})
    logger.info("voicemail greeting %s stored for mailbox %s (%d ms)", greeting_id, mailbox_id,
                duration_ms)
    return greeting_out(row)
