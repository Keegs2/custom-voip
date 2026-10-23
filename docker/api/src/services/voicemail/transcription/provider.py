"""Speech-to-text provider contract (docs/VOICEMAIL_TRANSCRIPTION_PLAN.md §8).

Two implementations, chosen by configuration (config.py):

* ``gcp_stt.GcpSttV2Provider`` — Google Cloud Speech-to-Text V2, synchronous
  ``Recognize``, ``us`` endpoint, inline LINEAR16 (production);
* ``fake_stt.FakeSttProvider`` — deterministic, in-process (dev/CI only; the
  local-KMS gate applies).

:func:`get_stt_provider` validates the configuration on EVERY call (so the
fake gate and the US-only location are re-checked even for a cached
provider) and raises :class:`config.TranscriptionUnavailable` when it is not
usable — callers fail closed: nothing is sent.

Errors (worker failure classes, plan §6.7) carry a machine ``code`` only.
``detail`` holds at most 200 chars of the provider's own message for the log
line — never a request, a response or transcript text — and is never stored
or returned to a client.

Importing this module imports no Google library: the Google provider and its
client are loaded on first use.
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from typing import Protocol, Sequence, runtime_checkable

from . import config as tconfig

#: Max chars of a provider error message kept for logging.
DETAIL_MAX_CHARS = 200
#: Third-party loggers pinned to WARNING: their DEBUG output could carry
#: request / response payloads (audio, transcripts).
PINNED_LOGGERS = ("google", "grpc")


def pin_library_loggers() -> None:
    """Pin the Google / gRPC library loggers to WARNING (worker + smoke)."""
    for name in PINNED_LOGGERS:
        lib = logging.getLogger(name)
        if lib.level == logging.NOTSET or lib.level < logging.WARNING:
            lib.setLevel(logging.WARNING)


@dataclass(frozen=True)
class SttChunk:
    """One piece of audio: LINEAR16 mono little-endian PCM (no header).
    ``pcm`` may be a zero-copy memoryview slice of the decrypted recording;
    a provider copies it only while that piece is in flight."""

    offset_ms: int
    pcm: bytes | memoryview


@dataclass(frozen=True)
class SttSegment:
    start_ms: int           # on the recording's timeline (chunk offset + result offset)
    end_ms: int
    text: str
    confidence: float | None


@dataclass(frozen=True)
class SttOutcome:
    segments: tuple[SttSegment, ...]
    billed_ms: int
    provider: str
    model: str
    location: str


class SttError(Exception):
    """Base class. ``code`` is one of the plan §6.7 machine codes; ``source``
    names the underlying exception class (e.g. ``PermissionDenied``)."""

    severity = 0

    def __init__(self, code: str, detail: str = "", *, source: str = ""):
        super().__init__(code)
        self.code = code
        self.detail = (detail or "")[:DETAIL_MAX_CHARS]
        self.source = source or type(self).__name__


class SttTransient(SttError):
    """Retry with backoff; counts as an attempt."""

    severity = 1


class SttRejected(SttError):
    """Permanent for this audio (the job fails at once)."""

    severity = 2


class SttUnavailable(SttError):
    """Deferral (does not count) + opens the per-process breaker for ``pause_s``."""

    severity = 3

    def __init__(self, code: str, pause_s: int, detail: str = "", *, source: str = ""):
        super().__init__(code, detail, source=source)
        self.pause_s = int(pause_s)


def most_severe(errors: Sequence[SttError]) -> SttError:
    """Unavailable > Rejected > Transient (first one wins on a tie)."""
    return max(errors, key=lambda e: e.severity)


@runtime_checkable
class SttProvider(Protocol):
    name: str
    model: str
    location: str

    async def transcribe(self, chunks: Sequence[SttChunk], *, sample_rate_hz: int,
                         language: str) -> SttOutcome:
        """Recognise every chunk (no partial result: any failure raises)."""
        ...

    async def smoke(self) -> SttOutcome:
        """1.0 s of digital silence, bypassing the planner (no customer data)."""
        ...


_lock = threading.Lock()
_providers: dict[tuple, SttProvider] = {}


def get_stt_provider() -> SttProvider:
    """The configured provider (per-process cache). Raises
    TranscriptionUnavailable unless the configuration is valid right now."""
    cfg = tconfig.require_valid()
    if cfg.is_fake:
        key: tuple = ("fake", cfg.fake_mode, cfg.fake_text)
    else:
        from ..config import load_config as load_voicemail_config
        key = ("gcp", cfg.project, cfg.location, cfg.model,
               load_voicemail_config().impersonate_sa)
    with _lock:
        provider = _providers.get(key)
        if provider is None:
            if cfg.is_fake:
                from .fake_stt import FakeSttProvider
                provider = FakeSttProvider(cfg)
            else:
                from .gcp_stt import GcpSttV2Provider
                provider = GcpSttV2Provider(cfg)
            _providers[key] = provider
        return provider


def reset_stt_providers() -> None:
    """Test hook: drop cached providers (and the Google client)."""
    with _lock:
        _providers.clear()
