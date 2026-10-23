"""Google Cloud Speech-to-Text V2 provider (docs/VOICEMAIL_TRANSCRIPTION_PLAN.md §8.1).

* Synchronous ``Recognize`` with INLINE audio — the only Google method that
  keeps the audio in memory (D8): no GCS object, nothing stored by Google
  ("processes it in memory and does not store any customer data").
* Location ``us``: endpoint ``us-speech.googleapis.com`` and the implicit
  recognizer ``projects/{project}/locations/us/recognizers/_`` (no recognizer
  resource, no admin IAM — ``roles/speech.client`` on vm-api is enough).
* One request per <= 55 s piece: ``ExplicitDecodingConfig(LINEAR16, the WAV's
  native rate, mono)`` with the raw PCM slice — never resampled, never
  transcoded. Automatic punctuation on, profanity filter off, one
  alternative; no adaptation, no word offsets.
* Each RPC: ``timeout=60``, ``retry=None`` (the worker owns retries — the two
  never compound), on a DEDICATED ``vm-stt`` thread pool (2 x
  VOICEMAIL_STT_CONCURRENCY threads per process), so STT can never take the
  ``vm-io`` threads deposits use for KMS/GCS. At most 2 pieces of a job in
  flight; a piece's PCM is copied into its request only while it is in flight.
* Credentials: ``_gcp.get_credentials`` — ADC as vm-api, or impersonation via
  ``VOICEMAIL_IMPERSONATE_SA`` (the KMS/GCS setup; VM scope cloud-platform).
* No partial transcripts: if any piece fails, the others in flight finish,
  no new piece starts, and the most severe error is raised
  (Unavailable > Rejected > Transient).

Never logs a request, a response, audio or transcript text: only the
exception class, the mapped code and <= 200 chars of the error message.
Importing this module imports no Google library.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import logging
import math
import threading
from datetime import timedelta
from typing import Any, Sequence

from .. import _gcp
from ..config import load_config as load_voicemail_config
from ..errors import VoicemailCryptoUnavailable
from . import config as tconfig
from .provider import (
    SttChunk,
    SttError,
    SttOutcome,
    SttRejected,
    SttSegment,
    SttTransient,
    SttUnavailable,
    most_severe,
)

logger = logging.getLogger(__name__)

RPC_TIMEOUT_S = 60.0
PIECES_IN_FLIGHT = 2
SMOKE_SAMPLE_RATE = 8000
SMOKE_LANGUAGE = "en-US"

_executor_lock = threading.Lock()
_executor: concurrent.futures.ThreadPoolExecutor | None = None


def _stt_executor() -> concurrent.futures.ThreadPoolExecutor:
    """The per-process ``vm-stt`` pool: 2 pieces x VOICEMAIL_STT_CONCURRENCY jobs."""
    global _executor
    if _executor is None:
        with _executor_lock:
            if _executor is None:
                jobs = tconfig.load_config().concurrency or tconfig.DEFAULT_CONCURRENCY
                _executor = concurrent.futures.ThreadPoolExecutor(
                    max_workers=PIECES_IN_FLIGHT * max(1, jobs), thread_name_prefix="vm-stt")
    return _executor


def _types():
    from google.cloud.speech_v2.types import cloud_speech
    return cloud_speech


def _ms(value: Any) -> int:
    """protobuf Duration (proto-plus: timedelta) -> whole milliseconds."""
    if value is None:
        return 0
    if isinstance(value, timedelta):
        return max(0, int(round(value.total_seconds() * 1000)))
    seconds = getattr(value, "seconds", 0) or 0
    nanos = getattr(value, "nanos", 0) or 0
    return max(0, int(seconds) * 1000 + int(nanos) // 1_000_000)


def _billed_fallback_ms(piece_ms: int) -> int:
    """Google rounds each request up to the next whole second."""
    return math.ceil(piece_ms / 1000) * 1000


# (exception class name, mapped error) — resolved lazily; checked in order,
# so subclasses come before their bases (DeadlineExceeded is a GatewayTimeout,
# PermissionDenied a Forbidden, ResourceExhausted a TooManyRequests).
_ERROR_MAP: tuple[tuple[str, str, str, int], ...] = (
    # (module, class, code, pause_s or -1 = transient, -2 = rejected)
    ("google.api_core.exceptions", "DeadlineExceeded", "stt_timeout", -1),
    ("google.api_core.exceptions", "ResourceExhausted", "stt_quota", 300),
    ("google.api_core.exceptions", "TooManyRequests", "stt_quota", 300),
    ("google.api_core.exceptions", "PermissionDenied", "stt_permission", 600),
    ("google.api_core.exceptions", "Unauthenticated", "stt_permission", 600),
    ("google.api_core.exceptions", "Forbidden", "stt_permission", 600),
    ("google.api_core.exceptions", "NotFound", "stt_config", 600),
    ("google.api_core.exceptions", "FailedPrecondition", "stt_config", 600),
    ("google.api_core.exceptions", "InvalidArgument", "stt_rejected", -2),
    ("google.api_core.exceptions", "OutOfRange", "stt_rejected", -2),
    ("google.api_core.exceptions", "ServiceUnavailable", "stt_unavailable", -1),
    ("google.api_core.exceptions", "InternalServerError", "stt_unavailable", -1),
    ("google.api_core.exceptions", "Unknown", "stt_unavailable", -1),
    ("google.api_core.exceptions", "Aborted", "stt_unavailable", -1),
    ("google.api_core.exceptions", "GatewayTimeout", "stt_unavailable", -1),
    ("google.auth.exceptions", "TransportError", "stt_unavailable", -1),
)


def translate_error(exc: BaseException) -> SttError:
    """Map a client / transport exception to the worker's failure classes
    (plan §8.1 table). Anything unrecognised is transient + an ERROR log."""
    if isinstance(exc, SttError):
        return exc
    detail = str(getattr(exc, "message", "") or exc)
    name = type(exc).__name__
    if isinstance(exc, VoicemailCryptoUnavailable):        # no ADC / impersonation failed
        return SttUnavailable("stt_permission", 600, "credentials unavailable", source=name)
    if isinstance(exc, ImportError):
        return SttUnavailable("stt_config", 600, "google-cloud-speech is not installed",
                              source=name)
    for module, cls_name, code, kind in _ERROR_MAP:
        classes = _gcp.exception_types(((module, cls_name),))
        if classes and isinstance(exc, classes):
            if kind == -1:
                return SttTransient(code, detail, source=name)
            if kind == -2:
                return SttRejected(code, detail, source=name)
            return SttUnavailable(code, kind, detail, source=name)
    if isinstance(exc, (ConnectionError, TimeoutError)):
        return SttTransient("stt_unavailable", detail, source=name)
    logger.error("voicemail transcription: unexpected Speech-to-Text error %s", name)
    return SttTransient("stt_unavailable", detail, source=name)


class GcpSttV2Provider:
    """Speech-to-Text V2 ``Recognize`` in ``us`` (production)."""

    name = tconfig.PROVIDER_GCP

    def __init__(self, cfg: tconfig.TranscriptionConfig, *, client: Any = None):
        self._cfg = cfg
        self.model = cfg.model
        self.location = cfg.location
        self.endpoint = cfg.endpoint
        self.recognizer = cfg.recognizer
        self._client = client
        self._client_lock = threading.Lock()

    # -- plumbing ------------------------------------------------------------
    def _get_client(self):
        """Lazily build the client (blocking: credentials may hit the metadata
        server) — always called on a vm-stt thread."""
        if self._client is None:
            with self._client_lock:
                if self._client is None:
                    from google.api_core.client_options import ClientOptions
                    from google.cloud import speech_v2
                    creds = _gcp.get_credentials(load_voicemail_config())
                    self._client = speech_v2.SpeechClient(
                        credentials=creds,
                        client_options=ClientOptions(api_endpoint=self.endpoint))
        return self._client

    def build_request(self, pcm: bytes, *, sample_rate_hz: int, language: str):
        """The exact RecognizeRequest for one piece (plan §8.1)."""
        cs = _types()
        return cs.RecognizeRequest(
            recognizer=self.recognizer,
            config=cs.RecognitionConfig(
                explicit_decoding_config=cs.ExplicitDecodingConfig(
                    encoding=cs.ExplicitDecodingConfig.AudioEncoding.LINEAR16,
                    sample_rate_hertz=sample_rate_hz, audio_channel_count=1),
                language_codes=[language], model=self.model,
                features=cs.RecognitionFeatures(
                    enable_automatic_punctuation=True, profanity_filter=False,
                    max_alternatives=1)),
            content=pcm)

    def _recognize_blocking(self, chunk: SttChunk, sample_rate_hz: int, language: str):
        request = self.build_request(bytes(chunk.pcm), sample_rate_hz=sample_rate_hz,
                                     language=language)
        try:
            return self._get_client().recognize(request=request, timeout=RPC_TIMEOUT_S,
                                                retry=None)
        finally:
            del request  # the piece's PCM copy goes with it

    def parse_response(self, response: Any, *, offset_ms: int,
                       piece_ms: int) -> tuple[list[SttSegment], int]:
        """Segments on the recording's timeline + the billed duration."""
        segments: list[SttSegment] = []
        piece_end = offset_ms + piece_ms
        prev_end = offset_ms
        for result in response.results:
            if not result.alternatives:
                continue
            alt = result.alternatives[0]
            end = min(max(offset_ms + _ms(result.result_end_offset), prev_end), piece_end)
            text = (alt.transcript or "").strip()
            if text:
                confidence = None
                if self.model == tconfig.MODEL_TELEPHONY and alt.confidence > 0:
                    confidence = min(float(alt.confidence), 1.0)
                segments.append(SttSegment(start_ms=prev_end, end_ms=end, text=text,
                                           confidence=confidence))
            prev_end = end
        metadata = getattr(response, "metadata", None)
        billed = _ms(getattr(metadata, "total_billed_duration", None)) if metadata else 0
        return segments, (billed if billed > 0 else _billed_fallback_ms(piece_ms))

    async def _piece(self, chunk: SttChunk, sample_rate_hz: int,
                     language: str) -> tuple[list[SttSegment], int]:
        piece_ms = (len(chunk.pcm) // 2) * 1000 // sample_rate_hz
        loop = asyncio.get_running_loop()
        try:
            response = await loop.run_in_executor(
                _stt_executor(), self._recognize_blocking, chunk, sample_rate_hz, language)
        except Exception as exc:  # noqa: BLE001 — every failure maps to a class
            raise translate_error(exc) from None
        return self.parse_response(response, offset_ms=chunk.offset_ms, piece_ms=piece_ms)

    # -- SttProvider -----------------------------------------------------------
    async def transcribe(self, chunks: Sequence[SttChunk], *, sample_rate_hz: int,
                         language: str) -> SttOutcome:
        gate = asyncio.Semaphore(PIECES_IN_FLIGHT)
        failed = False

        async def one(chunk: SttChunk):
            nonlocal failed
            async with gate:
                if failed:
                    return None                      # never start a piece after a failure
                try:
                    return await self._piece(chunk, sample_rate_hz, language)
                except SttError:
                    failed = True
                    raise

        results = await asyncio.gather(*(one(c) for c in chunks), return_exceptions=True)
        errors = [r for r in results if isinstance(r, SttError)]
        if errors:
            raise most_severe(errors)
        for r in results:
            if isinstance(r, BaseException):
                raise r
        segments: list[SttSegment] = []
        billed = 0
        for segs, piece_billed in results:
            segments.extend(segs)
            billed += piece_billed
        return SttOutcome(segments=tuple(segments), billed_ms=billed, provider=self.name,
                          model=self.model, location=self.location)

    async def smoke(self) -> SttOutcome:
        silence = SttChunk(offset_ms=0, pcm=bytes(SMOKE_SAMPLE_RATE * 2))   # 1.0 s, all zero
        return await self.transcribe([silence], sample_rate_hz=SMOKE_SAMPLE_RATE,
                                     language=SMOKE_LANGUAGE)


def reset_executor() -> None:
    """Test hook: forget the vm-stt pool (a new one is sized from the env)."""
    global _executor
    with _executor_lock:
        old, _executor = _executor, None
    if old is not None:
        old.shutdown(wait=False, cancel_futures=True)
