"""The durable transcription queue = ``voicemail_transcripts`` rows (migration 56).

Contract: docs/VOICEMAIL_TRANSCRIPTION_PLAN.md §6 — this module owns the
WORKER's SQL (discovery, lease reaper, claim, load, re-check, fenced finalize,
fenced release, the 24 h budget). The API's retry / backfill / requeue SQL
(§10) lives with the API (``services/voicemail/transcripts.py``).

Rules every statement here follows (the 2026-10-23 incident rules, invariant 6):
* a point or range predicate on an index (named next to each statement) and,
  for anything that can touch many rows, a LIMIT;
* every transaction starts with ``SET LOCAL statement_timeout = '5s'``
  (:func:`transaction`; ``SET LOCAL`` is transaction-scoped, so it is safe
  under PgBouncer transaction pooling);
* the worker only ever UPDATEs a row it holds (``attempt_id`` fencing) —
  never ``INSERT ... ON CONFLICT`` after discovery, so a purged message
  (whose transcript the trigger deleted) can never come back;
* explicit ``::type`` casts on every bind (asyncpg + PgBouncer).
"""
from __future__ import annotations

import uuid as _uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, AsyncIterator

#: pg_try_advisory_xact_lock key ("vm_trx"): one discoverer / reaper at a time.
LOCK_KEY = 0x766D5F747278
STATEMENT_TIMEOUT = "5s"

MIGRATION_PRESENT_SQL = "SELECT to_regclass('public.voicemail_transcripts') IS NOT NULL"
TRY_LOCK_SQL = "SELECT pg_try_advisory_xact_lock($1::bigint)"

# §6.4 — crashed / killed process: its 'processing' rows come back after the
# 600 s lease (idx_vm_transcripts_lease). $1 = MAX_ATTEMPTS.
# The LIMITed FOR UPDATE SKIP LOCKED pick is a MATERIALIZED CTE (here and in
# CLAIM_SQL): an inlined/IN-subquery form can be re-scanned by the planner, and
# each re-scan skips rows this same command already updated, so the UPDATE
# could touch more than LIMIT rows.
REAP_SQL = """
WITH pick AS MATERIALIZED (
    SELECT message_id FROM voicemail_transcripts
     WHERE status = 'processing' AND lease_until < now()
     ORDER BY lease_until LIMIT 50
     FOR UPDATE SKIP LOCKED
)
UPDATE voicemail_transcripts t
   SET status = CASE WHEN t.attempts >= $1::int THEN 'failed' ELSE 'pending' END,
       error_code = 'lease_expired', lease_until = NULL, attempt_id = NULL,
       next_attempt_at = now() + interval '1 minute', updated_at = now()
  FROM pick
 WHERE t.message_id = pick.message_id
"""

# §6.3 — the stored message is the job source (idx_vm_messages_stored_created
# + PK anti-join probes). $1 = window seconds, $2 = LIMIT.
DISCOVER_RECENT_SQL = """
INSERT INTO voicemail_transcripts (message_id, mailbox_id, customer_id, status, language)
SELECT m.id, m.mailbox_id, m.customer_id,
       CASE WHEN b.transcription_enabled THEN 'pending' ELSE 'disabled' END,
       b.transcription_language
  FROM voicemail_messages m
  JOIN voicemail_boxes b ON b.id = m.mailbox_id
 WHERE m.status = 'stored'
   AND m.created_at >= now() - make_interval(secs => $1::int)
   AND b.status <> 'deleted'
   AND NOT EXISTS (SELECT 1 FROM voicemail_transcripts t WHERE t.message_id = m.id)
 ORDER BY m.created_at
 LIMIT $2::int
ON CONFLICT (message_id) DO NOTHING
"""

# The catch-up variant (worker downtime, the launch): no window. $1 = LIMIT.
DISCOVER_ALL_SQL = """
INSERT INTO voicemail_transcripts (message_id, mailbox_id, customer_id, status, language)
SELECT m.id, m.mailbox_id, m.customer_id,
       CASE WHEN b.transcription_enabled THEN 'pending' ELSE 'disabled' END,
       b.transcription_language
  FROM voicemail_messages m
  JOIN voicemail_boxes b ON b.id = m.mailbox_id
 WHERE m.status = 'stored'
   AND b.status <> 'deleted'
   AND NOT EXISTS (SELECT 1 FROM voicemail_transcripts t WHERE t.message_id = m.id)
 ORDER BY m.created_at
 LIMIT $1::int
ON CONFLICT (message_id) DO NOTHING
"""

# §6.5 — one due job, skipping rows another process holds (idx_vm_transcripts_due).
# Not claimable (and skipped): trashed or non-stored message, deleted or
# switched-off mailbox, voicemail-disabled customer, destroyed key. The
# language is taken from the mailbox AT CLAIM TIME. $1 = attempt_id, $2 = lease s.
CLAIM_SQL = """
WITH pick AS MATERIALIZED (
    SELECT t.message_id
      FROM voicemail_transcripts t
      JOIN voicemail_messages m        ON m.id = t.message_id
      JOIN voicemail_boxes b           ON b.id = t.mailbox_id
      JOIN customers c                 ON c.id = t.customer_id
      JOIN voicemail_customer_keys k   ON k.customer_id = t.customer_id
     WHERE t.status = 'pending' AND t.next_attempt_at <= now()
       AND m.status = 'stored' AND m.deleted_at IS NULL
       AND b.status <> 'deleted' AND b.transcription_enabled
       AND c.voicemail_enabled AND k.status = 'active'
     ORDER BY t.next_attempt_at, t.message_id
     LIMIT 1
     FOR UPDATE OF t SKIP LOCKED
)
UPDATE voicemail_transcripts t
   SET status = 'processing', attempts = t.attempts + 1, attempt_id = $1::uuid,
       lease_until = now() + make_interval(secs => $2::int),
       language = b.transcription_language, error_code = NULL, updated_at = now()
  FROM pick, voicemail_boxes b
 WHERE t.message_id = pick.message_id AND b.id = t.mailbox_id
RETURNING t.message_id, t.mailbox_id, t.customer_id, t.language, t.attempts
"""

# §6.6 step 1 — the message row (PK).
LOAD_MESSAGE_SQL = """
SELECT id, msg_uuid, mailbox_id, customer_id, object_key, wrapped_dek, iv, ciphertext_crc32c
  FROM voicemail_messages
 WHERE id = $1::bigint AND status = 'stored'
"""

# §6.6 step 5 — right before any byte is sent: still ours, still stored,
# untrashed, mailbox live? -> transcription_enabled; no row -> abandon.
RECHECK_SQL = """
SELECT b.transcription_enabled
  FROM voicemail_transcripts t
  JOIN voicemail_messages m ON m.id = t.message_id
  JOIN voicemail_boxes b ON b.id = t.mailbox_id
 WHERE t.message_id = $1::bigint AND t.attempt_id = $2::uuid AND t.status = 'processing'
   AND m.status = 'stored' AND m.deleted_at IS NULL AND b.status <> 'deleted'
"""

# §6.6 step 8 — the fenced finalize. Zero rows = the row was purged, reset by
# a retry, disabled or reaped meanwhile: the result is discarded. The crypto
# binds are all NULL for 'empty' (enc_algo then keeps its NOT NULL default).
FINALIZE_SQL = """
UPDATE voicemail_transcripts t
   SET status = $3::varchar,
       ciphertext = $4::bytea, wrapped_dek = $5::bytea, kek_version = $6::text,
       iv = $7::bytea, enc_algo = COALESCE($8::varchar, t.enc_algo),
       confidence = $9::real, provider = $10::varchar, model = $11::varchar,
       audio_ms = $12::int, billed_ms = $13::int, chunk_count = $14::smallint,
       error_code = NULL, lease_until = NULL, attempt_id = NULL,
       completed_at = now(), updated_at = now()
 WHERE t.message_id = $1::bigint AND t.attempt_id = $2::uuid AND t.status = 'processing'
   AND EXISTS (SELECT 1 FROM voicemail_messages m WHERE m.id = t.message_id AND m.status = 'stored')
RETURNING t.message_id
"""

# §6.7 — every release is fenced. $3 status ('pending' | 'failed' |
# 'disabled'), $4 error_code (NULL for 'disabled'), $5 = 1 for a deferral
# (the attempt does not count), $6 = delay before the next attempt (s).
RELEASE_SQL = """
UPDATE voicemail_transcripts t
   SET status = $3::varchar, error_code = $4::varchar,
       attempts = GREATEST(t.attempts - $5::int, 0),
       next_attempt_at = now() + make_interval(secs => $6::double precision),
       lease_until = NULL, attempt_id = NULL, updated_at = now()
 WHERE t.message_id = $1::bigint AND t.attempt_id = $2::uuid AND t.status = 'processing'
RETURNING t.attempts
"""

# §6.8 — rolling 24 h billed duration (idx_vm_transcripts_completed).
BUDGET_SQL = """
SELECT COALESCE(sum(billed_ms), 0) FROM voicemail_transcripts
 WHERE status IN ('done', 'empty') AND completed_at >= now() - interval '24 hours'
"""


@dataclass(frozen=True)
class Job:
    """A claimed job (this process holds the lease under ``attempt_id``)."""

    message_id: int
    mailbox_id: int
    customer_id: int
    language: str
    attempts: int           # including this attempt
    attempt_id: _uuid.UUID


@asynccontextmanager
async def transaction(pool: Any) -> AsyncIterator[Any]:
    """One short worker transaction with ``statement_timeout = 5s``."""
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(f"SET LOCAL statement_timeout = '{STATEMENT_TIMEOUT}'")
            yield conn


def _rowcount(status: str) -> int:
    """asyncpg command tag ('INSERT 0 3', 'UPDATE 2') -> 3 / 2."""
    try:
        return int(status.rsplit(" ", 1)[-1])
    except (ValueError, AttributeError):
        return 0


async def migration_present(conn: Any) -> bool:
    return bool(await conn.fetchval(MIGRATION_PRESENT_SQL))


async def try_lock(conn: Any) -> bool:
    return bool(await conn.fetchval(TRY_LOCK_SQL, LOCK_KEY))


async def reap(conn: Any, *, max_attempts: int) -> int:
    return _rowcount(await conn.execute(REAP_SQL, max_attempts))


async def discover(conn: Any, *, window_s: int | None, limit: int) -> int:
    """Create the missing rows ('pending' / 'disabled'); never re-queues."""
    if window_s is None:
        return _rowcount(await conn.execute(DISCOVER_ALL_SQL, limit))
    return _rowcount(await conn.execute(DISCOVER_RECENT_SQL, window_s, limit))


async def claim(conn: Any, *, lease_s: int) -> Job | None:
    attempt_id = _uuid.uuid4()
    row = await conn.fetchrow(CLAIM_SQL, attempt_id, lease_s)
    if row is None:
        return None
    return Job(message_id=row["message_id"], mailbox_id=row["mailbox_id"],
               customer_id=row["customer_id"], language=row["language"],
               attempts=row["attempts"], attempt_id=attempt_id)


async def load_message(conn: Any, message_id: int) -> Any:
    return await conn.fetchrow(LOAD_MESSAGE_SQL, message_id)


async def recheck(conn: Any, job: Job) -> bool | None:
    """True = go ahead; False = the mailbox was switched off; None = the row
    is no longer ours (purged, trashed, reset, mailbox deleted): abandon."""
    row = await conn.fetchrow(RECHECK_SQL, job.message_id, job.attempt_id)
    return None if row is None else bool(row["transcription_enabled"])


async def finalize(conn: Any, job: Job, *, status: str, sealed: Any, confidence: float | None,
                   provider: str, model: str, audio_ms: int, billed_ms: int,
                   chunk_count: int) -> bool:
    """The fenced finalize; True when this attempt's result was stored."""
    row = await conn.fetchrow(
        FINALIZE_SQL, job.message_id, job.attempt_id, status,
        sealed.ciphertext if sealed else None, sealed.wrapped_dek if sealed else None,
        sealed.kek_version if sealed else None, sealed.iv if sealed else None,
        sealed.enc_algo if sealed else None, confidence, provider, model,
        audio_ms, billed_ms, chunk_count)
    return row is not None


async def release(conn: Any, job: Job, *, status: str, error_code: str | None,
                  uncount: bool, delay_s: float) -> bool:
    """The fenced release; False when the row was no longer ours."""
    row = await conn.fetchrow(RELEASE_SQL, job.message_id, job.attempt_id, status,
                              error_code, 1 if uncount else 0, float(delay_s))
    return row is not None


async def billed_ms_24h(conn: Any) -> int:
    return int(await conn.fetchval(BUDGET_SQL))
