"""Voicemail transcripts — the API side of transcription v1.1.

Contract: docs/VOICEMAIL_TRANSCRIPTION_PLAN.md §10 + §13; its owner decisions
(§0.1) override the rest — O2: only a platform admin changes a mailbox's
transcription settings, backfills a mailbox, or reads / requeues the ops
queue. routers/voicemail.py owns the HTTP surface and the tenant scope
(``vm_scope`` / ``vm_writer`` / ``vm_admin``); this module owns the rest:

* The status the API shows for a message (:func:`summary`): the row's status
  or, before the worker has created a row, ``pending`` when the mailbox
  currently transcribes and ``disabled`` when it does not. Message routes
  LEFT JOIN ``voicemail_transcripts`` (one PK probe per message), so the list
  stays ONE query, decrypts nothing and never touches KMS.
* The full transcript (:func:`read_transcript`): ``open_transcript`` under the
  per-process transcript-decrypt slots (:data:`SLOTS` — 4, at most
  :data:`SLOT_WAIT_S` to get one, else 503) so transcript KMS calls never hold
  more than 4 of the 16 ``vm-io`` threads deposits use; then a fail-closed
  ``transcript_view`` audit row is COMMITTED before any text is returned
  (audit failure -> 503, no text). Reading does not mark the message read.
* Snippets for the visible page (:func:`snippets`): <= 50 ids, the same
  slots, one :data:`SNIPPET_BUDGET_S` budget for the whole request, ONE audit
  row; never a 5xx — a failed or late decrypt is ``snippet: null`` +
  ``unavailable: true``.
* Retry, backfill, the ops status JSON and requeue (the SQL of plan §10).
  The ops status is computed from the table + config only (never from the
  worker's in-process state): ``budget_exhausted`` is the worker's own
  rule, billed ms of the last 24 h >= the daily cap.

Plaintext (decision D8): transcript text exists only in this process's
memory and the HTTP response. It is never logged, cached or written
anywhere; logs carry ids and exception classes only.

Every SQL bind carries an explicit ``::type`` cast (asyncpg + PgBouncer).
"""
from __future__ import annotations

import asyncio
import functools
import logging
import re
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from fastapi import HTTPException

from db import database as db

from . import audit
from .crypto import open_transcript
from .errors import VoicemailCryptoUnavailable, VoicemailIntegrityError, VoicemailKeyDestroyed
from .mailboxes import MSG_MAILBOX_NOT_FOUND, require_transcription_available
from .transcription import config as tx_config
from .transcription import document

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# User-facing messages (shown verbatim by the UI — short sentences).
# ---------------------------------------------------------------------------
MSG_MESSAGE_NOT_FOUND = "Message not found."
MSG_MAILBOX_OFF = "Transcription is turned off for this mailbox."
MSG_RESTORE_FIRST = "Restore the message before transcribing it."
MSG_IN_PROGRESS = "This message is already being transcribed."
MSG_ALREADY_DONE = "This message already has a transcript."
MSG_TRANSCRIPT_DOWN = "The transcript is temporarily unavailable. Try again in a few minutes."
MSG_TRANSCRIPT_DAMAGED = "This transcript could not be verified and was not shown."
MSG_TOO_MANY_IDS = "Ask for at most 50 messages at a time."
MSG_BAD_IDS = "Message ids must be numbers."
MSG_BAD_ERROR_CODE = "Choose a valid error code."
MSG_BAD_LIMIT = "Limit must be between 1 and 500."
MSG_STATUS_DOWN = "Transcription status is temporarily unavailable. Try again in a few minutes."

STATUSES = ("pending", "processing", "done", "empty", "failed", "disabled")
#: What a writer may re-queue (plan §10.2); an admin's ``force`` adds 'done'.
RETRYABLE = ("failed", "disabled", "empty")

MAX_SNIPPET_IDS = 50
#: Generous cap on the raw ``ids`` string (50 x 19 digits + separators/spaces).
_MAX_IDS_CHARS = MAX_SNIPPET_IDS * 24
BACKFILL_LIMIT = 200
MAX_REQUEUE = 500
#: Transcript-decrypt slots per worker process (full read + snippets share them).
DECRYPT_SLOTS = 4
#: Longest a full-transcript read waits for a slot before answering 503.
SLOT_WAIT_S = 2.0
#: Whole-request budget of one snippet batch (slot waits + decrypts).
SNIPPET_BUDGET_S = 2.0
#: Ops statements (status, requeue, backfill) never run longer than this.
STATEMENT_TIMEOUT = "5s"

INT64_MAX = 9_223_372_036_854_775_807
_ID_RE = re.compile(r"[0-9]{1,19}", re.ASCII)

#: The worker's error codes that can sit on a ``failed`` row (backend-T,
#: transcription/worker.py): transient codes after MAX_ATTEMPTS, and the
#: permanent ones. Deferral codes (decrypt_busy, stt_quota, stt_permission,
#: stt_config, budget) only ever sit on ``pending`` rows, so requeue (which
#: acts on ``failed`` rows only) rejects them as a filter.
TRANSIENT_FAILED_CODES = ("stt_unavailable", "stt_timeout", "decrypt_unavailable",
                          "seal_unavailable", "db", "lease_expired", "internal")
PERMANENT_FAILED_CODES = ("stt_rejected", "bad_wav", "integrity", "key_destroyed",
                          "message_gone")
REQUEUE_ERROR_CODES = frozenset(TRANSIENT_FAILED_CODES + PERMANENT_FAILED_CODES)


def _unavailable(detail: str = MSG_TRANSCRIPT_DOWN) -> HTTPException:
    return HTTPException(status_code=503, detail=detail, headers={"Retry-After": "5"})


async def _pool():
    pool = db.pool or await db.get_pool()
    if pool is None:
        raise _unavailable()
    return pool


# ===========================================================================
# Status (plan §10.1)
# ===========================================================================
#: Columns + join that every Message-returning SELECT over
#: ``voicemail_messages m`` adds (one PK probe per message, no decrypt).
SUMMARY_COLUMNS = "t.status AS transcript_status, t.confidence AS transcript_confidence"
SUMMARY_JOIN = " LEFT JOIN voicemail_transcripts t ON t.message_id = m.id "


def effective_status(row_status: str | None, mailbox_enabled: bool) -> str:
    """The row's status; with no row yet (the first poll interval after a
    deposit, or before the launch catch-up) ``pending`` when the mailbox
    currently transcribes, else ``disabled``."""
    if row_status is None:
        return "pending" if mailbox_enabled else "disabled"
    return row_status


def _confidence(value: Any) -> float | None:
    """REAL -> 3 dp (float4 reads back as e.g. 0.9120000004768372)."""
    return None if value is None else round(float(value), 3)


def summary(row_status: str | None, confidence: Any, mailbox_enabled: bool) -> dict:
    """The ``transcript`` object on every Message; confidence only when done."""
    status = effective_status(row_status, bool(mailbox_enabled))
    return {"status": status,
            "confidence": _confidence(confidence) if status == "done" else None}


def can_retry(status: str, *, writer: bool, admin: bool, available: bool,
              mailbox_enabled: bool, trashed: bool) -> bool:
    """Plan §10.2: a writer, transcription available, the mailbox on, the
    message not trashed, and failed/disabled/empty — admins also for done
    (``force``)."""
    if not (writer and available and mailbox_enabled and not trashed):
        return False
    return status in RETRYABLE or (admin and status == "done")


DISABLE_PENDING_SQL = ("UPDATE voicemail_transcripts SET status = 'disabled', updated_at = now() "
                       "WHERE mailbox_id = $1::int AND status = 'pending'")


async def disable_pending(conn: Any, mailbox_id: int) -> int:
    """Mailbox switched off (PATCH, same transaction): its not-yet-claimed jobs
    become ``disabled`` (plan §9; idx_vm_transcripts_mailbox). A job already
    ``processing`` is caught by the worker's pre-send re-check."""
    result = await conn.execute(DISABLE_PENDING_SQL, mailbox_id)
    return int(result.split()[-1])


# ===========================================================================
# Transcript-decrypt slots
# ===========================================================================
@dataclass
class SlotJob:
    task: asyncio.Task
    acquired: asyncio.Event


def _retrieve(task: asyncio.Task) -> None:
    """Abandoned jobs: mark the exception retrieved (no asyncio warning)."""
    if not task.cancelled():
        task.exception()


class DecryptSlots:
    """Per-process transcript-decrypt slots.

    A slot is held until the decrypt itself FINISHES, not until its waiter
    gives up: a request that times out or disconnects abandons its job, which
    keeps the slot until KMS returns (``open_transcript``'s own per-RPC
    timeouts bound that). That is what caps transcript KMS work at ``size``
    of the shared ``vm-io`` threads. A job still QUEUED for a slot is
    cancelled instead (nothing has started).

    The semaphore is created lazily per event loop (one loop per uvicorn
    worker; the tests run one loop per module)."""

    def __init__(self, size: int):
        self.size = size
        self.active = 0
        self._sem: asyncio.Semaphore | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    def _semaphore(self) -> asyncio.Semaphore:
        loop = asyncio.get_running_loop()
        if self._sem is None or self._loop is not loop:
            self._sem, self._loop, self.active = asyncio.Semaphore(self.size), loop, 0
        return self._sem

    def submit(self, factory: Callable[[], Awaitable[Any]]) -> SlotJob:
        """Start ``factory()`` as soon as a slot is free; returns at once."""
        sem = self._semaphore()
        acquired = asyncio.Event()

        async def run() -> Any:
            async with sem:
                acquired.set()
                self.active += 1
                try:
                    return await factory()
                finally:
                    self.active = max(0, self.active - 1)

        task = asyncio.ensure_future(run())
        task.add_done_callback(_retrieve)
        return SlotJob(task, acquired)

    def reset(self) -> None:
        """Test hook."""
        self._sem = self._loop = None
        self.active = 0


SLOTS = DecryptSlots(DECRYPT_SLOTS)


def _drop_if_queued(job: SlotJob) -> None:
    # No await between the check and cancel(): a job that has not acquired its
    # slot is suspended in Semaphore.acquire(), so nothing has started yet.
    if not job.acquired.is_set():
        job.task.cancel()


async def _wait_for_slot(job: SlotJob, timeout: float) -> bool:
    """True once ``job`` holds a slot (or already finished); False — with the
    still-queued job cancelled — when none freed up within ``timeout``."""
    if not (job.acquired.is_set() or job.task.done()):
        waiter = asyncio.ensure_future(job.acquired.wait())
        try:
            await asyncio.wait({waiter, job.task}, timeout=max(timeout, 0.0),
                               return_when=asyncio.FIRST_COMPLETED)
        except asyncio.CancelledError:
            _drop_if_queued(job)
            raise
        finally:
            waiter.cancel()
    if job.acquired.is_set() or job.task.done():
        return True
    _drop_if_queued(job)
    return False


class _SlotsBusy(Exception):
    """Every transcript-decrypt slot stayed busy for SLOT_WAIT_S."""


# ===========================================================================
# Full transcript (plan §10.2)
# ===========================================================================
TRANSCRIPT_ROW_SQL = """
SELECT status, language, model, confidence, completed_at, ciphertext, wrapped_dek, iv
  FROM voicemail_transcripts WHERE message_id = $1::bigint
"""


def _opener(customer_id: int, mailbox_id: int, msg_uuid: Any, row: Any):
    return functools.partial(open_transcript, customer_id=customer_id, mailbox_id=mailbox_id,
                             msg_uuid=msg_uuid, ciphertext=row["ciphertext"],
                             wrapped_dek=row["wrapped_dek"], iv=row["iv"])


async def _open_full(msg: Any, row: Any) -> bytes:
    job = SLOTS.submit(_opener(msg["customer_id"], msg["mailbox_id"], msg["msg_uuid"], row))
    if not await _wait_for_slot(job, SLOT_WAIT_S):
        raise _SlotsBusy()
    # shield: a disconnecting client must not cancel a decrypt that holds a slot.
    return await asyncio.shield(job.task)


async def read_transcript(msg: Any, *, writer: bool, admin: bool, source: str,
                          info: audit.RequestInfo | None) -> dict:
    """The ``Transcript`` JSON of an already-SCOPED message row (the router's
    ``_scoped_message``: id, mailbox_id, customer_id, msg_uuid, deleted_at,
    transcription_enabled). Text only for ``done``, after its audit row
    committed. Raises HTTPException 404 / 500 / 503."""
    message_id = msg["id"]
    pool = await _pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(TRANSCRIPT_ROW_SQL, message_id)
    mailbox_enabled = bool(msg["transcription_enabled"])
    status = effective_status(row["status"] if row else None, mailbox_enabled)
    out: dict[str, Any] = {
        "message_id": message_id,
        "status": status,
        "language": row["language"] if row else None,
        "model": row["model"] if row else None,
        "confidence": None,
        "text": None,
        "segments": [],
        "completed_at": row["completed_at"] if row else None,
        "can_retry": can_retry(status, writer=writer, admin=admin,
                               available=tx_config.available(),
                               mailbox_enabled=mailbox_enabled,
                               trashed=msg["deleted_at"] is not None),
    }
    if status != "done":
        return out

    try:
        doc = document.decode(await _open_full(msg, row))
    except _SlotsBusy:
        logger.warning("voicemail transcript %s: every decrypt slot busy for %.1fs — 503",
                       message_id, SLOT_WAIT_S)
        raise _unavailable()
    except (VoicemailIntegrityError, ValueError) as exc:
        logger.error("voicemail transcript %s: integrity failure — NOT shown (%s)",
                     message_id, type(exc).__name__)
        raise HTTPException(status_code=500, detail=MSG_TRANSCRIPT_DAMAGED)
    except VoicemailKeyDestroyed:
        # Crypto-erase is deleting this message's rows right now.
        raise HTTPException(status_code=404, detail=MSG_MESSAGE_NOT_FOUND)
    except VoicemailCryptoUnavailable as exc:
        logger.error("voicemail transcript %s: decrypt unavailable (%s)", message_id,
                     type(exc).__name__)
        raise _unavailable()
    except Exception as exc:  # noqa: BLE001 — fail closed, no text
        logger.error("voicemail transcript %s: decrypt failed (%s) — 503", message_id,
                     type(exc).__name__)
        raise _unavailable()

    out.update(
        language=row["language"] or doc.language,
        model=row["model"] or doc.model,
        confidence=_confidence(row["confidence"]),
        text=doc.text,
        segments=[{"start_ms": s.start_ms, "end_ms": s.end_ms, "text": s.text,
                   "confidence": s.confidence} for s in doc.segments])
    del doc
    try:
        async with pool.acquire() as conn:
            await audit.write_audit(
                conn, action="transcript_view", source=source, customer_id=msg["customer_id"],
                mailbox_id=msg["mailbox_id"], message_id=message_id, info=info,
                detail={"kind": "full"})
    except Exception as exc:  # noqa: BLE001 — fail closed: no audit row, no text
        logger.error("voicemail transcript %s: audit failed — text withheld (%s)", message_id,
                     type(exc).__name__)
        raise _unavailable()
    return out


# ===========================================================================
# Snippets (plan §10.3)
# ===========================================================================
SNIPPET_ROWS_SQL = """
SELECT m.id, m.msg_uuid, t.status, t.ciphertext, t.wrapped_dek, t.iv
  FROM voicemail_messages m
  LEFT JOIN voicemail_transcripts t ON t.message_id = m.id
 WHERE m.mailbox_id = $1::int AND m.status = 'stored' AND m.id = ANY($2::bigint[])
"""


def parse_snippet_ids(raw: str | None) -> list[int]:
    """``ids=1,2,3`` -> distinct ids in request order. 422 sentences for junk
    or more than 50 distinct ids."""
    text = (raw or "").strip()
    if len(text) > _MAX_IDS_CHARS:
        raise HTTPException(status_code=422, detail=MSG_TOO_MANY_IDS)
    out: list[int] = []
    seen: set[int] = set()
    for part in text.split(","):
        part = part.strip()
        if not _ID_RE.fullmatch(part):
            raise HTTPException(status_code=422, detail=MSG_BAD_IDS)
        value = int(part)
        if not 1 <= value <= INT64_MAX:
            raise HTTPException(status_code=422, detail=MSG_BAD_IDS)
        if value not in seen:
            seen.add(value)
            out.append(value)
    if len(out) > MAX_SNIPPET_IDS:
        raise HTTPException(status_code=422, detail=MSG_TOO_MANY_IDS)
    return out


async def _snippet_of(customer_id: int, mailbox_id: int, row: Any) -> str:
    plaintext = await _opener(customer_id, mailbox_id, row["msg_uuid"], row)()
    return document.snippet(document.decode(plaintext).text, document.SNIPPET_LIMIT)


def _log_snippet_failure(message_id: int, exc: BaseException | None) -> None:
    if exc is None:
        logger.warning("voicemail transcript %s: snippet missed the %.1fs budget",
                       message_id, SNIPPET_BUDGET_S)
    elif isinstance(exc, (VoicemailIntegrityError, ValueError)):
        logger.error("voicemail transcript %s: snippet integrity failure — NOT shown (%s)",
                     message_id, type(exc).__name__)
    else:
        logger.warning("voicemail transcript %s: snippet unavailable (%s)", message_id,
                       type(exc).__name__)


async def snippets(box: Any, ids: list[int], *, source: str,
                   info: audit.RequestInfo | None) -> dict:
    """``{"items": [TranscriptSnippet], "unavailable": bool}`` for the ids of
    an already-SCOPED mailbox row. Ids outside the mailbox are omitted (no
    leak); only ``done`` rows are decrypted; never raises for a decrypt or
    audit problem."""
    pool = await _pool()
    async with pool.acquire() as conn:
        rows = {r["id"]: r for r in await conn.fetch(SNIPPET_ROWS_SQL, box["id"], ids)}
    jobs = {mid: SLOTS.submit(functools.partial(_snippet_of, box["customer_id"], box["id"],
                                                rows[mid]))
            for mid in ids if mid in rows and rows[mid]["status"] == "done"}
    texts: dict[int, str] = {}
    unavailable = False
    if jobs:
        try:
            await asyncio.wait({j.task for j in jobs.values()}, timeout=SNIPPET_BUDGET_S)
        except asyncio.CancelledError:
            for job in jobs.values():
                _drop_if_queued(job)
            raise
        for mid, job in jobs.items():
            task = job.task
            if task.done() and not task.cancelled() and task.exception() is None:
                texts[mid] = task.result()
                continue
            unavailable = True
            # Late jobs that hold a slot keep running (and their slot) until
            # KMS returns; their result is dropped.
            _drop_if_queued(job)
            _log_snippet_failure(mid, task.exception() if task.done() and not task.cancelled()
                                 else None)
    if texts:
        try:
            async with pool.acquire() as conn:
                await audit.write_audit(
                    conn, action="transcript_view", source=source,
                    customer_id=box["customer_id"], mailbox_id=box["id"], info=info,
                    detail={"kind": "snippets", "message_ids": sorted(texts)})
        except Exception as exc:  # noqa: BLE001 — fail closed: no audit row, no text
            logger.error("voicemail transcripts of mailbox %s: snippet audit failed — "
                         "withheld (%s)", box["id"], type(exc).__name__)
            texts = {}
            unavailable = True
    enabled = bool(box["transcription_enabled"])
    items = [{"message_id": mid,
              "status": effective_status(rows[mid]["status"], enabled),
              "snippet": texts.get(mid)}
             for mid in ids if mid in rows]
    return {"items": items, "unavailable": unavailable}


# ===========================================================================
# Retry / backfill (plan §10.2)
# ===========================================================================
RETRY_SQL = """
INSERT INTO voicemail_transcripts (message_id, mailbox_id, customer_id, status, language)
VALUES ($1::bigint, $2::int, $3::int, 'pending', $4::varchar)
ON CONFLICT (message_id) DO UPDATE
   SET status = 'pending', attempts = 0, next_attempt_at = now(), error_code = NULL,
       ciphertext = NULL, wrapped_dek = NULL, kek_version = NULL, iv = NULL,
       confidence = NULL, completed_at = NULL, lease_until = NULL, attempt_id = NULL,
       language = EXCLUDED.language, updated_at = now()
 WHERE voicemail_transcripts.status = ANY($5::varchar[])
RETURNING status
"""

BACKFILL_SQL = f"""
WITH cand AS (
    SELECT m.id, m.mailbox_id, m.customer_id FROM voicemail_messages m
     WHERE m.mailbox_id = $1::int AND m.status = 'stored' AND m.deleted_at IS NULL
     ORDER BY m.created_at DESC LIMIT {BACKFILL_LIMIT})
INSERT INTO voicemail_transcripts (message_id, mailbox_id, customer_id, status, language)
SELECT id, mailbox_id, customer_id, 'pending', $2::varchar FROM cand
ON CONFLICT (message_id) DO UPDATE
   SET status = 'pending', attempts = 0, next_attempt_at = now(), error_code = NULL,
       language = EXCLUDED.language, updated_at = now()
 WHERE voicemail_transcripts.status = 'disabled'
RETURNING message_id
"""


async def request_retry(conn: Any, msg: Any, *, force: bool, source: str,
                        info: audit.RequestInfo | None) -> dict:
    """Re-queue one message (``conn`` is in the caller's transaction and
    ``msg`` is the scoped message row, locked FOR UPDATE so a concurrent purge
    cannot leave a job behind). ``force`` (admin only — the router checks)
    also re-runs a ``done`` transcript. Raises 409 sentences."""
    require_transcription_available()
    if not msg["transcription_enabled"]:
        raise HTTPException(status_code=409, detail=MSG_MAILBOX_OFF)
    if msg["deleted_at"] is not None:
        raise HTTPException(status_code=409, detail=MSG_RESTORE_FIRST)
    allowed = list(RETRYABLE) + (["done"] if force else [])
    status = await conn.fetchval(RETRY_SQL, msg["id"], msg["mailbox_id"], msg["customer_id"],
                                 msg["transcription_language"], allowed)
    if status is None:
        current = await conn.fetchval(
            "SELECT status FROM voicemail_transcripts WHERE message_id = $1::bigint", msg["id"])
        raise HTTPException(status_code=409,
                            detail=MSG_ALREADY_DONE if current == "done" else MSG_IN_PROGRESS)
    await audit.write_audit(
        conn, action="transcript_request", source=source, customer_id=msg["customer_id"],
        mailbox_id=msg["mailbox_id"], message_id=msg["id"], info=info,
        detail={"kind": "retry", "force": force})
    return {"message_id": msg["id"], "status": "pending"}


async def backfill(conn: Any, box: Any, *, source: str,
                   info: audit.RequestInfo | None) -> dict:
    """Queue the newest BACKFILL_LIMIT stored, untrashed messages of a mailbox
    (missing rows inserted ``pending``, ``disabled`` rows flipped; nothing
    else is touched). ``conn`` is in the caller's transaction; the mailbox row
    is locked FOR SHARE so a concurrent switch-off (PATCH, FOR UPDATE) cannot
    interleave and strand ``pending`` jobs on a disabled mailbox."""
    require_transcription_available()
    await conn.execute(f"SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT}'")
    current = await conn.fetchrow(
        "SELECT transcription_enabled, transcription_language FROM voicemail_boxes "
        "WHERE id = $1::int AND status <> 'deleted' FOR SHARE", box["id"])
    if current is None:
        raise HTTPException(status_code=404, detail=MSG_MAILBOX_NOT_FOUND)
    if not current["transcription_enabled"]:
        raise HTTPException(status_code=409, detail=MSG_MAILBOX_OFF)
    queued = len(await conn.fetch(BACKFILL_SQL, box["id"], current["transcription_language"]))
    await audit.write_audit(
        conn, action="transcript_request", source=source, customer_id=box["customer_id"],
        mailbox_id=box["id"], info=info, detail={"kind": "backfill", "count": queued})
    return {"queued": queued}


# ===========================================================================
# Ops status + requeue (plan §13, §6.10) — admin only
# ===========================================================================
STATUS_COUNTS_SQL = """
SELECT status, count(*)::bigint AS jobs FROM voicemail_transcripts GROUP BY status
"""

#: The worker's rolling 24 h budget — VERBATIM backend-T's
#: ``transcription.queue.BUDGET_SQL`` (copied, not imported: the API never
#: depends on the worker module; unify at merge). idx_vm_transcripts_completed.
BUDGET_SQL = ("SELECT COALESCE(sum(billed_ms),0) FROM voicemail_transcripts "
              "WHERE status IN ('done','empty') AND completed_at >= now() - interval '24 hours'")

#: How long the most overdue CLAIMABLE-looking job has waited past its due
#: time (idx_vm_transcripts_due). Trashed messages are excluded: they stay
#: 'pending' by design until restored and would read as a stuck queue.
OLDEST_DUE_SQL = """
SELECT EXTRACT(EPOCH FROM now() - min(t.next_attempt_at))::float8
  FROM voicemail_transcripts t
  JOIN voicemail_messages m ON m.id = t.message_id
 WHERE t.status = 'pending' AND t.next_attempt_at <= now()
   AND m.status = 'stored' AND m.deleted_at IS NULL
"""

FAILED_BY_CODE_SQL = """
SELECT COALESCE(error_code, 'unknown') AS code, count(*)::bigint AS jobs
  FROM voicemail_transcripts WHERE status = 'failed' GROUP BY 1 ORDER BY 1
"""

#: The pick is a MATERIALIZED CTE, never ``WHERE id IN (SELECT … LIMIT n FOR
#: UPDATE SKIP LOCKED)``: when the planner rescans that subquery (inner side
#: of a nested loop) FOR UPDATE skips the rows this same command already
#: updated, so every rescan yields NEW rows and the UPDATE exceeds its LIMIT
#: (reproduced in tests/test_voicemail_transcription_api.py).
REQUEUE_SQL = """
WITH pick AS MATERIALIZED (
    SELECT f.message_id FROM voicemail_transcripts f
      JOIN voicemail_messages m ON m.id = f.message_id
      JOIN voicemail_boxes b ON b.id = f.mailbox_id
     WHERE f.status = 'failed'
       AND ($1::varchar IS NULL OR f.error_code = $1::varchar)
       AND m.status = 'stored' AND m.deleted_at IS NULL
       AND b.status <> 'deleted' AND b.transcription_enabled
     ORDER BY f.updated_at, f.message_id
     LIMIT $2::int
     FOR UPDATE OF f SKIP LOCKED)
UPDATE voicemail_transcripts t
   SET status = 'pending', attempts = 0, next_attempt_at = now(), error_code = NULL,
       lease_until = NULL, attempt_id = NULL, updated_at = now()
  FROM pick
 WHERE t.message_id = pick.message_id AND t.status = 'failed'
RETURNING t.message_id
"""


async def ops_status() -> dict:
    """Plan §13 ops JSON, from the table + config only. The worker's
    per-process breaker state is not visible here and is not reported;
    ``budget_exhausted`` is the worker's own rule (BUDGET_SQL >= the cap)."""
    cfg = tx_config.load_config()
    pool = await _pool()
    try:
        async with pool.acquire() as conn:
            async with conn.transaction(readonly=True):
                await conn.execute(f"SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT}'")
                rows = await conn.fetch(STATUS_COUNTS_SQL)
                billed_ms = int(await conn.fetchval(BUDGET_SQL))
                oldest = await conn.fetchval(OLDEST_DUE_SQL)
                failed = await conn.fetch(FAILED_BY_CODE_SQL)
    except Exception as exc:  # noqa: BLE001
        logger.error("voicemail transcription status: query failed (%s)", type(exc).__name__)
        raise _unavailable(MSG_STATUS_DOWN)
    counts = {s: 0 for s in STATUSES}
    for r in rows:
        counts[r["status"]] = int(r["jobs"])
    cap_ms = cfg.daily_cap_ms
    return {
        "available": tx_config.available(),
        "platform_enabled": tx_config.platform_enabled(),
        "provider": cfg.provider,
        "location": cfg.location,
        "model": cfg.effective_model,
        "counts": counts,
        "oldest_pending_age_s": None if oldest is None else max(0, int(oldest)),
        "failed_by_code": {r["code"]: int(r["jobs"]) for r in failed},
        "billed_minutes_24h": round(billed_ms / 60_000, 1),
        "daily_cap_minutes": cfg.daily_minutes_cap,
        "budget_exhausted": cap_ms is not None and billed_ms >= cap_ms,
        "config_problems": list(tx_config.problems(cfg)),
    }


def clean_requeue(error_code: Any, limit: Any) -> tuple[str | None, int]:
    """``error_code``: None (every code) or one of REQUEUE_ERROR_CODES;
    ``limit``: 1..MAX_REQUEUE (default MAX_REQUEUE). 422 sentences."""
    if error_code is not None and (not isinstance(error_code, str)
                                   or error_code not in REQUEUE_ERROR_CODES):
        raise HTTPException(status_code=422, detail=MSG_BAD_ERROR_CODE)
    if limit is None:
        limit = MAX_REQUEUE
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_REQUEUE:
        raise HTTPException(status_code=422, detail=MSG_BAD_LIMIT)
    return error_code, limit


async def requeue(error_code: Any, limit: Any, *, info: audit.RequestInfo | None) -> dict:
    """Up to ``limit`` (<= 500) ``failed`` rows, optionally of one
    ``error_code``, back to ``pending`` with ``attempts = 0`` — only rows the
    worker can actually claim (message stored and untrashed, mailbox live and
    transcribing); anything else would sit ``pending`` forever."""
    code, limit = clean_requeue(error_code, limit)
    pool = await _pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(f"SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT}'")
            requeued = len(await conn.fetch(REQUEUE_SQL, code, limit))
            await audit.write_audit(
                conn, action="transcript_requeue", source="admin", info=info,
                detail={"error_code": code, "count": requeued})
    logger.info("voicemail transcription: %d failed job(s) requeued (error_code=%s)",
                requeued, code)
    return {"requeued": requeued}
