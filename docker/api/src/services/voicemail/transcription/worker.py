"""Voicemail transcription worker (docs/VOICEMAIL_TRANSCRIPTION_PLAN.md §6).

``main.py``'s lifespan starts :func:`run_forever` in EVERY uvicorn worker
process (4) — only when the platform flag ``VOICEMAIL_TRANSCRIPTION_ENABLED``
is on (:func:`start_if_enabled`). The deposit path is untouched: the queue is
discovered by polling stored messages.

One tick (every VOICEMAIL_TRANSCRIPTION_POLL_S, default 10 s, +-20 %; the
first 20-40 s after start):

1. Nothing at all while the flag is off, the configuration is invalid, this
   process's breaker is open, or the rolling 24 h billed minutes reached
   VOICEMAIL_STT_DAILY_MINUTES_CAP.
2. One transaction under ``pg_try_advisory_xact_lock('vm_trx')`` (one process
   at a time): reap expired leases, discover stored messages of the last
   hour (and, every 15 min per process, ALL of them — the catch-up), as
   'pending' (mailbox on) or 'disabled' (mailbox off).
3. Claim up to VOICEMAIL_STT_CONCURRENCY jobs (``FOR UPDATE SKIP LOCKED``,
   fencing ``attempt_id``, 600 s lease) and process each in a tracked task.

Processing one job (steps 2-6 under a 300 s deadline):
  load the message -> decrypt the audio IN RAM (shared ``decrypt_limiter``)
  -> parse the WAV -> plan pieces (thread) -> all silent: ``empty`` with NO
  provider call -> re-check (purged / trashed / reset / switched off
  meanwhile -> abandon or 'disabled') -> Speech-to-Text -> drop the audio ->
  transcript document -> ``seal_transcript`` (existing active KEK only) ->
  ONE transaction: fenced finalize + the ``transcribe`` audit row.

Failure classes (§6.7) — every release is fenced on ``attempt_id``:
  transient (counts)  -> 'pending' after 60 s / 5 min / 30 min / 2 h (+-20 %);
                         the 5th attempt -> 'failed'
  deferral (does not) -> 'pending' after 30 s (decrypt busy) or 10 min; a
                         permission / config / quota error also opens this
                         process's breaker (10 / 10 / 5 min)
  permanent           -> 'failed' at once (stt_rejected, bad_wav, integrity,
                         key_destroyed, message_gone)
  switched off        -> 'disabled'
Three ``stt_rejected`` in a row on different messages also open the breaker
(10 min) — that pattern is a model / language config error.

D8: decrypted audio and transcript text exist only in this process's memory.
Nothing here writes a file; no log line carries text, audio, a request or a
response — only ids, counts, durations, codes and exception class names.
"""
from __future__ import annotations

import asyncio
import logging
import random
import time
from dataclasses import dataclass
from typing import Any, Callable

from db import database as db

from .. import audio, audit
from ..crypto import seal_transcript
from ..errors import VoicemailCryptoUnavailable, VoicemailIntegrityError, VoicemailKeyDestroyed
from ..wav import WavError, parse_wav
from . import chunking, document, queue
from . import config as tconfig
from .provider import (
    PINNED_LOGGERS,
    SttChunk,
    SttOutcome,
    SttProvider,
    SttRejected,
    SttTransient,
    SttUnavailable,
    get_stt_provider,
    pin_library_loggers,
)

__all__ = ["TranscriptionWorker", "run_forever", "start_if_enabled", "pin_library_loggers",
           "PINNED_LOGGERS"]

logger = logging.getLogger(__name__)

JOB_DEADLINE_S = 300.0
LEASE_S = 600
MAX_ATTEMPTS = 5
#: Delay after transient failure n (1-based attempts 1..4); the 5th fails.
BACKOFF_S = (60, 300, 1800, 7200)
JITTER = 0.2
DEFER_BUSY_S = 30
DEFER_S = 600
DISCOVER_WINDOW_S = 3600
DISCOVER_LIMIT = 200
CATCHUP_INTERVAL_S = 900.0
CATCHUP_LIMIT = 1000
INITIAL_DELAY_RANGE_S = (20.0, 40.0)
BUDGET_REFRESH_S = 60.0
ERROR_LOG_INTERVAL_S = 300.0
BUDGET_LOG_INTERVAL_S = 3600.0
REJECT_STREAK = 3
REJECT_BREAKER_S = 600

def _jitter(seconds: float) -> float:
    return seconds * random.uniform(1.0 - JITTER, 1.0 + JITTER)


class _Stop(Exception):
    """Ends a job early. kind: transient | defer | permanent | disabled."""

    def __init__(self, kind: str, code: str | None = None, *, delay_s: float = 0.0):
        super().__init__(code or kind)
        self.kind = kind
        self.code = code
        self.delay_s = delay_s


@dataclass
class _Heard:
    """What steps 2-6 produced (no audio: it is dropped before this exists)."""

    msg_uuid: Any
    sample_rate: int
    outcome: SttOutcome | None      # None = all silent, no provider call
    chunk_count: int
    audio_ms: int
    stt_ms: int


class TranscriptionWorker:
    """Per-process worker state: in-flight jobs, the breaker, the budget."""

    def __init__(self, *, clock: Callable[[], float] = time.monotonic):
        self._clock = clock
        self.inflight: set[asyncio.Task] = set()
        self.breaker_until = 0.0
        self.breaker_reason: str | None = None
        self.budget_exhausted = False
        self.budget_ms = 0
        self._budget_checked_at: float | None = None
        self._next_catchup = 0.0
        self._rejected: list[int] = []
        self._last_logged: dict[str, float] = {}

    # -- logging ---------------------------------------------------------------
    def _limited(self, key: str, interval: float) -> bool:
        now = self._clock()
        last = self._last_logged.get(key)
        if last is not None and now - last < interval:
            return False
        self._last_logged[key] = now
        return True

    # -- breaker -----------------------------------------------------------------
    def breaker_open(self) -> bool:
        if self._clock() < self.breaker_until:
            return True
        if self.breaker_reason is not None:
            logger.info("voicemail transcription: breaker closed (%s)", self.breaker_reason)
            self.breaker_reason = None
        return False

    def open_breaker(self, reason: str, seconds: float) -> None:
        until = self._clock() + seconds
        if until <= self.breaker_until:
            return
        was_open = self._clock() < self.breaker_until
        self.breaker_until, self.breaker_reason = until, reason
        if not was_open:
            logger.error("voicemail transcription: breaker OPEN for %ds (%s) — this process "
                         "claims nothing until then", int(seconds), reason)

    def _note_rejected(self, message_id: int) -> None:
        if message_id not in self._rejected:
            self._rejected.append(message_id)
        if len(self._rejected) >= REJECT_STREAK:
            self._rejected.clear()
            self.open_breaker("stt_rejected x3 (model or language misconfigured?)",
                              REJECT_BREAKER_S)

    # -- budget ------------------------------------------------------------------
    async def refresh_budget(self, pool: Any, cfg: tconfig.TranscriptionConfig) -> None:
        now = self._clock()
        if self._budget_checked_at is None or now - self._budget_checked_at >= BUDGET_REFRESH_S:
            try:
                async with queue.transaction(pool) as conn:
                    if await queue.migration_present(conn):
                        self.budget_ms = await queue.billed_ms_24h(conn)
                self._budget_checked_at = now
            except Exception as exc:  # noqa: BLE001 — keep the last figure
                if self._limited("budget-read", ERROR_LOG_INTERVAL_S):
                    logger.error("voicemail transcription: budget read failed (%s)",
                                 type(exc).__name__)
        cap = cfg.daily_cap_ms or 0
        self.budget_exhausted = self.budget_ms >= cap
        if self.budget_exhausted and self._limited("budget", BUDGET_LOG_INTERVAL_S):
            logger.error("voicemail transcription: daily cap reached (%.1f of %d billed minutes "
                         "in 24 h) — no new jobs until it rolls off", self.budget_ms / 60_000,
                         cfg.daily_minutes_cap or 0)

    # -- one tick ------------------------------------------------------------------
    async def tick(self) -> dict:
        """Housekeeping + claims; returns counts (for tests and logs)."""
        if not tconfig.platform_enabled():
            return {"skipped": "disabled"}
        try:
            cfg = tconfig.require_valid()
        except tconfig.TranscriptionUnavailable as exc:
            if self._limited("config", ERROR_LOG_INTERVAL_S):
                logger.error("voicemail transcription unavailable: %s", exc)
            return {"skipped": "config"}
        pool = db.pool
        if pool is None:
            return {"skipped": "no database pool"}
        if self.breaker_open():
            return {"skipped": "breaker"}
        await self.refresh_budget(pool, cfg)
        if self.budget_exhausted:
            return {"skipped": "budget"}
        counts = await self.housekeeping(pool)
        if counts.get("skipped"):
            return counts
        counts["claimed"] = 0
        while len(self.inflight) < (cfg.concurrency or 1):
            if self.breaker_open() or self.budget_exhausted:
                break
            job = await self.claim(pool)
            if job is None:
                break
            self._spawn(self.process(job))
            counts["claimed"] += 1
        return counts

    async def housekeeping(self, pool: Any) -> dict:
        """Reaper + discovery, one process at a time (transaction-scoped lock)."""
        counts: dict = {}
        async with queue.transaction(pool) as conn:
            if not await queue.migration_present(conn):
                if self._limited("migration", ERROR_LOG_INTERVAL_S):
                    logger.error("voicemail transcription: migration 56 is not applied "
                                 "(voicemail_transcripts missing) — nothing to do")
                return {"skipped": "migration 56 not applied"}
            if not await queue.try_lock(conn):
                return {"locked": False}
            counts["reaped"] = await queue.reap(conn, max_attempts=MAX_ATTEMPTS)
            counts["discovered"] = await queue.discover(conn, window_s=DISCOVER_WINDOW_S,
                                                        limit=DISCOVER_LIMIT)
            now = self._clock()
            if now >= self._next_catchup:
                counts["discovered"] += await queue.discover(conn, window_s=None,
                                                             limit=CATCHUP_LIMIT)
                self._next_catchup = now + CATCHUP_INTERVAL_S
        if counts["reaped"]:
            logger.warning("voicemail transcription: re-queued %d jobs whose lease expired",
                           counts["reaped"])
        return counts

    async def claim(self, pool: Any) -> queue.Job | None:
        async with queue.transaction(pool) as conn:
            return await queue.claim(conn, lease_s=LEASE_S)

    def _spawn(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro, name="voicemail-transcription-job")
        self.inflight.add(task)

        def _forget(t: asyncio.Task) -> None:
            self.inflight.discard(t)
            if not t.cancelled() and t.exception() is not None:  # process() never raises
                logger.error("voicemail transcription: job task failed (%s)",
                             type(t.exception()).__name__)

        task.add_done_callback(_forget)
        return task

    async def drain(self) -> None:
        """Wait for every in-flight job (tests)."""
        while self.inflight:
            await asyncio.gather(*list(self.inflight), return_exceptions=True)

    def cancel_inflight(self) -> None:
        """Shutdown: abandon in-flight jobs (their leases expire; the reaper
        re-queues them; a late provider result is discarded by the fence)."""
        for task in list(self.inflight):
            task.cancel()

    # -- one job -------------------------------------------------------------------
    async def process(self, job: queue.Job) -> str:
        """Run one claimed job to its end state. Never raises (except on
        cancellation). Returns the status written, or 'abandoned' /
        'discarded'."""
        started = time.perf_counter()
        try:
            provider = get_stt_provider()
        except tconfig.TranscriptionUnavailable:
            return await self._release(job, _Stop("defer", "stt_config", delay_s=DEFER_S))
        try:
            heard = await asyncio.wait_for(self._listen(job, provider), JOB_DEADLINE_S)
        except _Stop as stop:
            return await self._release(job, stop)
        except TimeoutError:
            return await self._release(job, _Stop("transient", "stt_timeout"))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.error("voicemail transcription: message=%d unexpected %s",
                         job.message_id, type(exc).__name__)
            return await self._release(job, _Stop("transient", "internal"))
        if heard is None:
            logger.info("voicemail transcription: message=%d abandoned (purged, trashed or "
                        "reset meanwhile)", job.message_id)
            return "abandoned"
        try:
            return await self._store(job, provider, heard, started)
        except _Stop as stop:
            return await self._release(job, stop)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.error("voicemail transcription: message=%d unexpected %s while storing",
                         job.message_id, type(exc).__name__)
            return await self._release(job, _Stop("transient", "internal"))

    async def _listen(self, job: queue.Job, provider: SttProvider) -> _Heard | None:
        """Steps 1-6 (under the job deadline). The plaintext audio lives only
        in this frame and is released before returning."""
        pool = db.pool
        async with queue.transaction(pool) as conn:
            row = await queue.load_message(conn, job.message_id)
        if row is None:
            raise _Stop("permanent", "message_gone")

        data = pcm = chunks = None
        try:
            try:
                data = await audio.decrypt_message(row)
            except audio.DecryptBusy:
                raise _Stop("defer", "decrypt_busy", delay_s=DEFER_BUSY_S) from None
            except VoicemailKeyDestroyed:
                raise _Stop("permanent", "key_destroyed") from None
            except VoicemailIntegrityError as exc:
                logger.error("voicemail transcription: message=%d audio failed integrity "
                             "checks (%s) — not transcribed", job.message_id, type(exc).__name__)
                raise _Stop("permanent", "integrity") from None
            except VoicemailCryptoUnavailable:
                raise _Stop("transient", "decrypt_unavailable") from None
            try:
                wav = parse_wav(data, noun="Recording", lenient_data_size=True)
            except WavError:
                raise _Stop("permanent", "bad_wav") from None
            pcm = memoryview(data)[wav.data_offset:wav.data_offset + wav.data_bytes]
            plan = await asyncio.to_thread(chunking.plan_chunks, pcm, wav.sample_rate)
            if not plan.speech:
                return _Heard(msg_uuid=row["msg_uuid"], sample_rate=wav.sample_rate,
                              outcome=None, chunk_count=0, audio_ms=0, stt_ms=0)

            async with queue.transaction(pool) as conn:
                still = await queue.recheck(conn, job)
            if still is None:
                return None
            if still is False:
                raise _Stop("disabled")
            if self.budget_exhausted:
                raise _Stop("defer", "budget", delay_s=DEFER_S)

            sent = plan.sent
            chunks = [SttChunk(offset_ms=c.start_ms, pcm=pcm[c.byte_start:c.byte_end])
                      for c in sent]
            t0 = time.perf_counter()
            try:
                outcome = await provider.transcribe(chunks, sample_rate_hz=wav.sample_rate,
                                                    language=job.language)
            except SttUnavailable as exc:
                self.open_breaker(exc.code, exc.pause_s)
                self._log_stt_error(job, exc)
                raise _Stop("defer", exc.code, delay_s=DEFER_S) from None
            except SttRejected as exc:
                self._log_stt_error(job, exc)
                self._note_rejected(job.message_id)
                raise _Stop("permanent", exc.code) from None
            except SttTransient as exc:
                self._log_stt_error(job, exc)
                raise _Stop("transient", exc.code) from None
            self._rejected.clear()
            return _Heard(msg_uuid=row["msg_uuid"], sample_rate=wav.sample_rate,
                          outcome=outcome, chunk_count=len(sent), audio_ms=plan.audio_ms,
                          stt_ms=int((time.perf_counter() - t0) * 1000))
        finally:
            # Drop every reference to the plaintext (Python cannot scrub the
            # immutable bytes; the GC frees them once these go).
            if chunks is not None:
                chunks.clear()
            if pcm is not None:
                pcm.release()
            del data, pcm, chunks

    @staticmethod
    def _log_stt_error(job: queue.Job, exc: Exception) -> None:
        logger.warning("voicemail transcription: message=%d provider error %s %s: %s",
                       job.message_id, getattr(exc, "code", "?"),
                       getattr(exc, "source", type(exc).__name__), getattr(exc, "detail", ""))

    async def _store(self, job: queue.Job, provider: SttProvider, heard: _Heard,
                     started: float) -> str:
        """Build + seal the document, then the fenced finalize with its audit row."""
        outcome = heard.outcome
        model = outcome.model if outcome else provider.model
        segments = [document.Segment(start_ms=s.start_ms, end_ms=s.end_ms, text=s.text,
                                     confidence=s.confidence)
                    for s in (outcome.segments if outcome else ())]
        doc = document.from_segments(language=job.language, model=model, segments=segments)
        sealed = None
        confidence = None
        if doc.text:
            plaintext = document.encode(doc)
            try:
                sealed = await seal_transcript(customer_id=job.customer_id,
                                               mailbox_id=job.mailbox_id,
                                               msg_uuid=heard.msg_uuid, plaintext=plaintext)
            except VoicemailKeyDestroyed:
                raise _Stop("permanent", "key_destroyed") from None
            except VoicemailIntegrityError as exc:
                logger.error("voicemail transcription: message=%d seal failed integrity "
                             "checks (%s)", job.message_id, type(exc).__name__)
                raise _Stop("transient", "seal_unavailable") from None
            except VoicemailCryptoUnavailable:
                raise _Stop("transient", "seal_unavailable") from None
            finally:
                del plaintext
            confidence = document.overall_confidence(doc.segments)
        status = "done" if sealed is not None else "empty"
        del doc, segments
        billed_ms = outcome.billed_ms if outcome else 0

        stored = False
        try:
            async with queue.transaction(db.pool) as conn:
                stored = await queue.finalize(
                    conn, job, status=status, sealed=sealed, confidence=confidence,
                    provider=provider.name, model=model, audio_ms=heard.audio_ms,
                    billed_ms=billed_ms, chunk_count=heard.chunk_count)
                if stored:
                    await audit.write_audit(
                        conn, action="transcribe", source="system",
                        customer_id=job.customer_id, mailbox_id=job.mailbox_id,
                        message_id=job.message_id,
                        detail={"provider": provider.name, "model": model,
                                "location": provider.location, "language": job.language,
                                "status": status, "chunks": heard.chunk_count,
                                "audio_ms": heard.audio_ms, "billed_ms": billed_ms,
                                "attempts": job.attempts})
        except Exception as exc:  # noqa: BLE001 — finalize + audit roll back together
            logger.warning("voicemail transcription: message=%d finalize failed (%s)",
                           job.message_id, type(exc).__name__)
            raise _Stop("transient", "db") from None
        if not stored:
            logger.info("voicemail transcription: message=%d result discarded (row purged, "
                        "reset, disabled or reaped meanwhile)", job.message_id)
            return "discarded"
        logger.info(
            "voicemail transcription: message=%d status=%s attempts=%d chunks=%d audio_ms=%d "
            "billed_ms=%d stt_ms=%d total_ms=%d model=%s lang=%s conf=%s",
            job.message_id, status, job.attempts, heard.chunk_count, heard.audio_ms, billed_ms,
            heard.stt_ms, int((time.perf_counter() - started) * 1000), model, job.language,
            "-" if confidence is None else f"{confidence:.3f}")
        return status

    async def _release(self, job: queue.Job, stop: _Stop) -> str:
        if stop.kind == "transient":
            if job.attempts >= MAX_ATTEMPTS:
                status, delay = "failed", 0.0
            else:
                status = "pending"
                delay = _jitter(BACKOFF_S[min(job.attempts, len(BACKOFF_S)) - 1])
            uncount = False
        elif stop.kind == "defer":
            status, delay, uncount = "pending", stop.delay_s, True
        elif stop.kind == "permanent":
            status, delay, uncount = "failed", 0.0, False
        else:  # disabled mid-flight
            status, delay, uncount = "disabled", 0.0, False
        code = None if stop.kind == "disabled" else stop.code
        try:
            async with queue.transaction(db.pool) as conn:
                ours = await queue.release(conn, job, status=status, error_code=code,
                                           uncount=uncount, delay_s=delay)
        except Exception as exc:  # noqa: BLE001 — the lease expiry + reaper cover it
            logger.error("voicemail transcription: message=%d release failed (%s) — the lease "
                         "will expire", job.message_id, type(exc).__name__)
            return "lease"
        if not ours:
            return "discarded"
        if status == "pending":
            logger.warning("voicemail transcription: message=%d %s %s attempts=%d next_in_s=%d",
                           job.message_id, "deferred" if uncount else "transient", code,
                           job.attempts - (1 if uncount else 0), int(delay))
        elif status == "failed":
            logger.warning("voicemail transcription: message=%d failed %s attempts=%d",
                           job.message_id, code, job.attempts)
        else:
            logger.info("voicemail transcription: message=%d disabled mid-flight",
                        job.message_id)
        return status


async def run_forever(*, worker: TranscriptionWorker | None = None,
                      initial_delay: tuple[float, float] = INITIAL_DELAY_RANGE_S) -> None:
    """Lifespan task body: jittered first tick, then every POLL_S +-20 %.
    Never raises out of its loop; on cancellation the in-flight jobs are
    abandoned (lease expiry + the reaper re-queue them)."""
    pin_library_loggers()
    worker = worker or TranscriptionWorker()
    try:
        await asyncio.sleep(random.uniform(*initial_delay))
        while True:
            try:
                await worker.tick()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — never kill the loop
                if worker._limited("tick", ERROR_LOG_INTERVAL_S):
                    logger.error("voicemail transcription: tick failed (%s)",
                                 type(exc).__name__)
            poll = tconfig.load_config().poll_s or tconfig.DEFAULT_POLL_S
            if not tconfig.POLL_S_RANGE[0] <= poll <= tconfig.POLL_S_RANGE[1]:
                poll = tconfig.DEFAULT_POLL_S
            await asyncio.sleep(_jitter(poll))
    finally:
        worker.cancel_inflight()


def start_if_enabled() -> asyncio.Task | None:
    """Start the worker task in this process iff the platform flag is on
    (``main.py`` lifespan). Off -> None: no task, nothing ever sent."""
    if not tconfig.platform_enabled():
        logger.info("voicemail transcription: platform flag off — worker not started")
        return None
    logger.info("voicemail transcription: worker started")
    return asyncio.create_task(run_forever(), name="voicemail-transcription")
