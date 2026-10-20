"""FreeSWITCH -> API voicemail deposit (contract §5; server side).

Request (``lib/vm_deposit.lua``): ``POST /v1/voicemail/fs/deposit``, raw
``audio/wav`` body, ``X-VM-Meta`` (base64url JSON, see meta.py),
``X-Ingest-Secret`` (checked by the router dependency BEFORE this runs).
FS counts a deposit as stored ONLY on 2xx + ``"status":"stored"``; it retries
5xx/408/429/curl errors (3 attempts, 1 s / 2 s backoff, 15 s ``--max-time``
each) and drops the message on any other 4xx.

Order of checks (cheapest first, nothing is read or written before the
request is known to be well-formed):
  meta (400) -> Content-Type (415) -> Content-Length cap (413) ->
  per-process concurrency slot (503 + Retry-After) -> body read (413/400) ->
  WAV (415/422) -> claim (DB) -> seal + upload (KMS/GCS) -> finalize (DB).

Concurrency: uvicorn runs 4 worker processes; each admits
``DEPOSIT_CONCURRENCY`` (5) deposits at once (~20 platform-wide, plan §3.2's
budget: ~3 x payload of RAM per in-flight deposit). A deposit that cannot get
a slot immediately gets 503 + ``Retry-After: 2`` and FS retries.

Idempotency on ``msg_uuid`` (the row is inserted 'pending' FIRST):
  * existing 'stored'   -> 200 with the existing id (a retry whose first 200
                           was lost);
  * 'pending' whose deposit lease is live -> 503 (another attempt is
                           mid-upload; it will finish);
  * 'failed', or 'pending' with an expired lease -> TAKE OVER: new fencing
                           token + lease, re-seal, overwrite the same object
                           key, finalize;
  * 'purged'            -> 409 (the message was removed; never resurrect).
The claim runs under ``SELECT ... FOR UPDATE`` on the msg_uuid row, so two
concurrent attempts serialise there and only one can hold the lease; the
finalising UPDATE matches the attempt's fencing token, so a stale attempt can
never mark the row stored.

Deadline: the request answers within ``DEPOSIT_DEADLINE_S`` (11 s) of
arrival — inside FS's 15 s curl budget. The seal + upload is NEVER cancelled:
its blocking KMS/GCS calls run on worker threads that asyncio cannot stop, so
a cancelled attempt could still upload later and overwrite the object of a
takeover (a stored row whose object no longer matches = an unplayable
message). Instead, when the deadline passes the request gets 503 and a
background task keeps waiting for the SAME seal while renewing this
attempt's lease (``LATE_LEASE_S``) — FS's retries see the live lease (503) —
and finalizes the row (stored + audited) when the seal completes, or marks it
'failed' if it fails. A slow-but-successful upload is therefore kept even if
FS has already given up (FS logs "message lost"; the message is in the
mailbox). The body and the concurrency slot stay held until that background
task ends. A clean failure (KMS/GCS raised) marks the row 'failed' at once, so
FS's retry takes over. The object of a failed/abandoned attempt is deleted by
the retention worker, never inline (an inline delete could race a takeover's
upload).

The processing runs in a task the handler awaits through ``asyncio.shield``:
if FS gives up and disconnects mid-upload the deposit still completes (and
FS's retry gets the idempotent 200).

Audit (fail-closed): the ``deposit`` audit row is INSERTed in the SAME
transaction as the UPDATE to 'stored' — a stored row without its audit row
cannot exist. If that transaction fails the row stays 'pending' under this
attempt's (short) lease and is then marked 'failed' (fenced), the response
is 503 and FS's retry re-seals.
"""
from __future__ import annotations

import asyncio
import logging
import uuid as _uuid
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException
from starlette.responses import JSONResponse

from db import database as db

from . import audit
from .body import content_type_is_wav, declared_length, read_capped_body, zero
from .crypto import message_aad, message_object_key, seal_and_store
from .errors import VoicemailCryptoUnavailable, VoicemailIntegrityError, VoicemailKeyDestroyed
from .limits import NonBlockingLimiter
from .mailboxes import MAILBOX_SELECT, accepting_state
from .meta import DepositMeta, MetaError, parse_meta
from .wav import WavError, parse_wav

logger = logging.getLogger(__name__)

DEPOSIT_BODY_CAP = 10 * 1024 * 1024
DEPOSIT_CONCURRENCY = 5
DEPOSIT_DEADLINE_S = 11.0
#: A live attempt's lease. Must exceed DEPOSIT_DEADLINE_S + finalize time so a
#: LIVE attempt can never be taken over.
LEASE_S = 30
#: Lease held (and renewed every LATE_LEASE_S / 2) while a seal that missed the
#: deadline finishes in the background. KMS (3 x 5 s) + GCS (3 x (5 s connect +
#: 20 s read)) bound a seal at ~95 s; the renewal covers anything slower.
LATE_LEASE_S = 120
DURATION_GRACE_MS = 5000
RETRY_AFTER = {"Retry-After": "2"}


deposit_limiter = NonBlockingLimiter(DEPOSIT_CONCURRENCY)
_tasks: set[asyncio.Task] = set()


def _err(status: int, detail: str, headers: dict | None = None) -> HTTPException:
    return HTTPException(status_code=status, detail=detail, headers=headers)


@dataclass(frozen=True)
class Claim:
    row_id: int
    attempt_id: str
    customer_id: int
    mailbox_id: int


@dataclass(frozen=True)
class AlreadyStored:
    row_id: int


def _stored(message_id: int) -> JSONResponse:
    return JSONResponse({"status": "stored", "message_id": message_id})


async def handle_deposit(request: Any) -> JSONResponse:
    """Router entry point (ingest secret already verified)."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + DEPOSIT_DEADLINE_S
    try:
        meta = parse_meta(request.headers.get("x-vm-meta"))
    except MetaError as exc:
        logger.warning("voicemail deposit rejected: %s", exc)
        raise _err(400, str(exc))
    if not content_type_is_wav(request.headers.get("content-type")):
        raise _err(415, "Content-Type must be audio/wav.")
    declared_length(request, DEPOSIT_BODY_CAP, too_large="Recording is larger than 10 MB.")

    if not deposit_limiter.try_acquire():
        logger.warning("voicemail deposit %s: concurrency limit (%d) reached — 503",
                       meta.msg_uuid, deposit_limiter.limit)
        raise _err(503, "Voicemail deposit is busy; retry shortly.", RETRY_AFTER)
    slot = _Slot()
    task: asyncio.Task | None = None
    try:
        slot.body = await read_capped_body(request, DEPOSIT_BODY_CAP,
                                           too_large="Recording is larger than 10 MB.")
        try:
            wav = parse_wav(slot.body, noun="Recording", lenient_data_size=True)
        except WavError as exc:
            raise _err(exc.status, exc.detail)
        info = audit.RequestInfo.from_request(request)
        task = _spawn(_process(meta, slot, wav.duration_ms, deadline, info))
    finally:
        if task is None:
            slot.release()

    def _done(_t: asyncio.Task) -> None:
        if not slot.handed_off:
            slot.release()

    task.add_done_callback(_done)
    return await asyncio.shield(task)


class _Slot:
    """The deposit's concurrency slot + its body buffer. Released (slot freed,
    buffer zeroed) exactly once — by the request task, or by the background
    finisher when a seal missed the deadline (the seal may still need the
    plaintext, so it must not be zeroed under it)."""

    def __init__(self) -> None:
        self.body: bytearray | None = None
        self.handed_off = False
        self._released = False

    def release(self) -> None:
        if not self._released:
            self._released = True
            deposit_limiter.release()
            zero(self.body)


def _spawn(coro) -> asyncio.Task:
    task = asyncio.create_task(coro)
    _tasks.add(task)

    def _forget(t: asyncio.Task) -> None:
        _tasks.discard(t)
        if not t.cancelled():
            t.exception()  # retrieved: no "never retrieved" warning after a disconnect

    task.add_done_callback(_forget)
    return task


async def _process(meta: DepositMeta, slot: _Slot, duration_ms: int, deadline: float,
                   info: audit.RequestInfo) -> JSONResponse:
    body = slot.body
    claim = await _claim(meta, duration_ms, len(body))
    if isinstance(claim, AlreadyStored):
        logger.info("voicemail deposit %s: already stored as message %s (retry)",
                    meta.msg_uuid, claim.row_id)
        return _stored(claim.row_id)

    loop = asyncio.get_running_loop()
    seal = asyncio.create_task(seal_and_store(
        customer_id=claim.customer_id,
        object_key=message_object_key(claim.customer_id, claim.mailbox_id, meta.msg_uuid),
        aad=message_aad(claim.customer_id, claim.mailbox_id, meta.msg_uuid), plaintext=body))
    try:
        done, _ = await asyncio.wait({seal}, timeout=max(0.0, deadline - loop.time()))
    except asyncio.CancelledError:
        # Only on shutdown (the handler awaits us through shield): stop the
        # seal too, BEFORE the slot release zeroes the plaintext under it. The
        # row stays 'pending' until its lease ends (retention / takeover).
        seal.cancel()
        raise
    if not done:
        logger.error("voicemail deposit %s: seal/upload missed the %.0f s deadline — 503; "
                     "it keeps running and will finalize in the background (lease renewed)",
                     meta.msg_uuid, DEPOSIT_DEADLINE_S)
        slot.handed_off = True
        await _release(claim, lease_s=LATE_LEASE_S)
        _spawn(_finish_late(meta, claim, seal, duration_ms, len(body), info, slot))
        raise _err(503, "Voicemail storage is slow; retry.", RETRY_AFTER)
    sealed = await _sealed_or_fail(meta, claim, seal)
    return await _finalize(meta, claim, sealed, duration_ms, len(body), info)


async def _sealed_or_fail(meta: DepositMeta, claim: "Claim", seal: asyncio.Task) -> Any:
    """The finished seal's result, or: mark this attempt 'failed' (fenced; no
    thread is left running, so an immediate takeover is safe) and raise."""
    try:
        return seal.result()
    except VoicemailKeyDestroyed:
        logger.warning("voicemail deposit %s: customer %s was crypto-erased — rejected",
                       meta.msg_uuid, claim.customer_id)
        await _release(claim, failed=True)
        raise _err(404, "Mailbox not found.")
    except VoicemailCryptoUnavailable as exc:
        logger.error("voicemail deposit %s: KMS/GCS unavailable: %s", meta.msg_uuid, exc)
        await _release(claim, failed=True)
        raise _err(503, "Voicemail storage is unavailable; retry.", RETRY_AFTER)
    except VoicemailIntegrityError as exc:
        logger.error("voicemail deposit %s: integrity failure on upload: %s", meta.msg_uuid, exc)
        await _release(claim, failed=True)
        raise _err(503, "Voicemail storage failed an integrity check; retry.", RETRY_AFTER)
    except Exception:
        logger.exception("voicemail deposit %s: unexpected seal failure", meta.msg_uuid)
        await _release(claim, failed=True)
        raise


async def _finish_late(meta: DepositMeta, claim: "Claim", seal: asyncio.Task, duration_ms: int,
                       size: int, info: audit.RequestInfo, slot: _Slot) -> None:
    """Background completion of a seal that missed the request deadline."""
    try:
        while True:
            done, _ = await asyncio.wait({seal}, timeout=LATE_LEASE_S / 2)
            if done:
                break
            await _release(claim, lease_s=LATE_LEASE_S)  # still running: keep the lease
        sealed = await _sealed_or_fail(meta, claim, seal)
        await _finalize(meta, claim, sealed, duration_ms, size, info)
        logger.warning("voicemail deposit %s: stored late (after the request deadline)",
                       meta.msg_uuid)
    except HTTPException as exc:
        logger.error("voicemail deposit %s: late completion failed: %s %s", meta.msg_uuid,
                     exc.status_code, exc.detail)
    except Exception:  # noqa: BLE001
        logger.exception("voicemail deposit %s: late completion failed", meta.msg_uuid)
    finally:
        slot.release()


_CLAIM_EXISTING_SQL = """
SELECT id, mailbox_id, status,
       (deposit_lease_until IS NOT NULL AND deposit_lease_until > now()) AS lease_live
  FROM voicemail_messages WHERE msg_uuid = $1::uuid FOR UPDATE
"""

_INSERT_SQL = """
INSERT INTO voicemail_messages
       (msg_uuid, mailbox_id, customer_id, caller_id_number, caller_id_name, duration_ms,
        size_bytes, status, expires_at, call_uuid, fs_node, zone,
        deposit_attempt_id, deposit_lease_until)
VALUES ($1::uuid, $2::int, $3::int, $4::varchar, $5::varchar, $6::int,
        $7::int, 'pending', now() + make_interval(days => $8::int), $9::varchar, $10::varchar,
        $11::varchar, $12::uuid, now() + make_interval(secs => $13::int))
ON CONFLICT (msg_uuid) DO NOTHING
RETURNING id
"""

_TAKEOVER_SQL = """
UPDATE voicemail_messages
   SET status = 'pending', duration_ms = $2::int, size_bytes = $3::int,
       caller_id_number = $4::varchar, caller_id_name = $5::varchar, call_uuid = $6::varchar,
       fs_node = $7::varchar, zone = $8::varchar, deposit_attempt_id = $9::uuid,
       deposit_lease_until = now() + make_interval(secs => $10::int)
 WHERE id = $1::bigint
"""


async def _claim(meta: DepositMeta, duration_ms: int, size: int) -> Claim | AlreadyStored:
    pool = db.pool or await db.get_pool()
    attempt_id = str(_uuid.uuid4())
    try:
        async with pool.acquire() as conn:
            async with conn.transaction():
                existing = await conn.fetchrow(_CLAIM_EXISTING_SQL, meta.msg_uuid)
                if existing is not None:
                    if existing["mailbox_id"] != meta.mailbox_id:
                        raise _err(409, "msg_uuid already belongs to another mailbox.")
                    if existing["status"] == "stored":
                        return AlreadyStored(existing["id"])
                    if existing["status"] == "purged":
                        raise _err(409, "This message was already removed.")
                    if existing["status"] == "pending" and existing["lease_live"]:
                        raise _err(503, "This message is already being stored; retry.",
                                   RETRY_AFTER)
                box = await conn.fetchrow(
                    MAILBOX_SELECT + " WHERE b.id = $1::int AND b.status <> 'deleted'",
                    meta.mailbox_id)
                if box is None:
                    raise _err(404, "Mailbox not found.")
                accepting, reason = accepting_state(box)
                if not accepting:
                    raise _err(409, f"Mailbox is not accepting messages ({reason}).")
                if duration_ms > box["max_message_seconds"] * 1000 + DURATION_GRACE_MS:
                    raise _err(422, "Recording is longer than the mailbox allows.")
                if meta.did is not None and meta.did != box["did"]:
                    logger.warning("voicemail deposit %s: meta did %r != mailbox %s did %s",
                                   meta.msg_uuid, meta.did, box["id"], box["did"])
                if existing is not None:
                    await conn.execute(
                        _TAKEOVER_SQL, existing["id"], duration_ms, size,
                        meta.caller_id_number, meta.caller_id_name, meta.call_uuid,
                        meta.fs_node, meta.zone, attempt_id, LEASE_S)
                    row_id = existing["id"]
                    logger.warning("voicemail deposit %s: taking over %s row %s",
                                   meta.msg_uuid, existing["status"], row_id)
                else:
                    row_id = await conn.fetchval(
                        _INSERT_SQL, meta.msg_uuid, box["id"], box["customer_id"],
                        meta.caller_id_number, meta.caller_id_name, duration_ms, size,
                        box["retention_days"], meta.call_uuid, meta.fs_node, meta.zone,
                        attempt_id, LEASE_S)
                    if row_id is None:
                        # A concurrent first attempt inserted the same msg_uuid
                        # between our SELECT and INSERT; it holds the lease.
                        raise _err(503, "This message is already being stored; retry.",
                                   RETRY_AFTER)
                return Claim(row_id=row_id, attempt_id=attempt_id,
                             customer_id=box["customer_id"], mailbox_id=box["id"])
    except HTTPException:
        raise
    except Exception as exc:  # DB down / pool exhausted -> transient
        logger.error("voicemail deposit %s: claim failed: %s: %s", meta.msg_uuid,
                     type(exc).__name__, exc)
        raise _err(503, "Voicemail database is unavailable; retry.", RETRY_AFTER)


async def _release(claim: Claim, *, failed: bool = False, lease_s: int | None = None) -> None:
    """Fenced best-effort: mark this attempt's row 'failed' (immediate
    takeover allowed) or extend its lease (zombie guard). Never raises."""
    try:
        pool = db.pool or await db.get_pool()
        async with pool.acquire() as conn:
            if failed:
                await conn.execute(
                    "UPDATE voicemail_messages SET status = 'failed', deposit_lease_until = NULL "
                    "WHERE id = $1::bigint AND deposit_attempt_id = $2::uuid "
                    "AND status = 'pending'", claim.row_id, claim.attempt_id)
            else:
                await conn.execute(
                    "UPDATE voicemail_messages "
                    "SET deposit_lease_until = now() + make_interval(secs => $3::int) "
                    "WHERE id = $1::bigint AND deposit_attempt_id = $2::uuid "
                    "AND status = 'pending'", claim.row_id, claim.attempt_id, int(lease_s or LEASE_S))
    except Exception as exc:  # noqa: BLE001 — the lease expiry / sweep cover it
        logger.error("voicemail deposit row %s: could not release attempt: %s",
                     claim.row_id, exc)


_FINALIZE_SQL = """
UPDATE voicemail_messages m
   SET status = 'stored', object_key = $3::text, ciphertext_crc32c = $4::bigint,
       wrapped_dek = $5::bytea, kek_version = $6::text, iv = $7::bytea, enc_algo = $8::varchar,
       deposit_lease_until = NULL
 WHERE m.id = $1::bigint AND m.deposit_attempt_id = $2::uuid AND m.status = 'pending'
   AND EXISTS (SELECT 1 FROM voicemail_boxes b WHERE b.id = m.mailbox_id AND b.status <> 'deleted')
RETURNING m.id
"""


async def _finalize(meta: DepositMeta, claim: Claim, sealed: Any, duration_ms: int, size: int,
                    info: audit.RequestInfo) -> JSONResponse:
    pool = db.pool or await db.get_pool()
    stored_id = None
    try:
        async with pool.acquire() as conn:
            async with conn.transaction():
                stored_id = await conn.fetchval(
                    _FINALIZE_SQL, claim.row_id, claim.attempt_id, sealed.object_key,
                    sealed.ciphertext_crc32c, sealed.wrapped_dek, sealed.kek_version,
                    sealed.iv, sealed.enc_algo)
                if stored_id is not None:
                    await audit.write_audit(
                        conn, action="deposit", source="freeswitch",
                        customer_id=claim.customer_id, mailbox_id=claim.mailbox_id,
                        message_id=stored_id, info=info,
                        detail={"msg_uuid": meta.msg_uuid, "duration_ms": duration_ms,
                                "size_bytes": size, "fs_node": meta.fs_node,
                                "zone": meta.zone, "call_uuid": meta.call_uuid})
            if stored_id is None:
                state = await conn.fetchrow(
                    "SELECT m.id, m.status, m.deposit_attempt_id::text AS attempt, "
                    "       b.status AS box_status "
                    "  FROM voicemail_messages m JOIN voicemail_boxes b ON b.id = m.mailbox_id "
                    " WHERE m.id = $1::bigint", claim.row_id)
    except Exception as exc:
        logger.error("voicemail deposit %s: finalize/audit failed (%s: %s) — not stored",
                     meta.msg_uuid, type(exc).__name__, exc)
        await _release(claim, failed=True)
        raise _err(503, "Voicemail database is unavailable; retry.", RETRY_AFTER)

    if stored_id is not None:
        logger.info("voicemail deposit %s stored as message %s (mailbox %s, %d ms, %d bytes)",
                    meta.msg_uuid, stored_id, claim.mailbox_id, duration_ms, size)
        return _stored(stored_id)
    if state is not None and state["status"] == "stored":
        return _stored(state["id"])
    if state is not None and state["box_status"] == "deleted":
        logger.warning("voicemail deposit %s: mailbox %s deleted during upload — dropped "
                       "(row left for the retention worker)", meta.msg_uuid, claim.mailbox_id)
        raise _err(404, "Mailbox not found.")
    logger.error("voicemail deposit %s: lost the deposit lease before finalize (state %s)",
                 meta.msg_uuid, dict(state) if state else None)
    raise _err(503, "This message is already being stored; retry.", RETRY_AFTER)
