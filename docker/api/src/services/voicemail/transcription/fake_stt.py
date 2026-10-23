"""Deterministic in-process STT provider — DEV / CI ONLY (plan §8.2).

Selected only by ``VOICEMAIL_STT_PROVIDER=fake``, which config.py refuses
unless ``VOICEMAIL_ALLOW_LOCAL_KMS=true`` and ENV/ENVIRONMENT is not
``production`` (re-checked on every ``get_stt_provider()`` call).
docker-compose.services.yml never passes these variables.

Each piece returns ONE segment covering the piece, confidence 0.9, text
``VOICEMAIL_STT_FAKE_TEXT`` (default "This is a test transcript.");
``billed_ms`` = ceil(piece seconds) x 1000 per piece, like Google.

``VOICEMAIL_STT_FAKE_MODE`` drives every worker / UI state locally:

========== ================================================================
ok         the transcript above (default)
empty      no segments (-> status ``empty``); still billed, like Google
transient  SttTransient('stt_unavailable') -> retries with backoff -> failed
unavailable SttUnavailable('stt_quota', 300) -> deferral + process breaker
rejected   SttRejected('stt_rejected') -> failed at once
slow       each piece sleeps FAKE_SLOW_S (70 s) under the same 60 s per-RPC
           deadline as Google -> SttTransient('stt_timeout')
========== ================================================================

``.calls`` records what each piece looked like (offset, byte count, rate,
language) — never the audio — so tests can assert piece bounds.
"""
from __future__ import annotations

import asyncio
import math
from typing import Sequence

from . import config as tconfig
from .provider import (
    SttChunk,
    SttOutcome,
    SttRejected,
    SttSegment,
    SttTransient,
    SttUnavailable,
)

FAKE_CONFIDENCE = 0.9
FAKE_SLOW_S = 70.0
#: Mirrors gcp_stt.RPC_TIMEOUT_S.
FAKE_RPC_TIMEOUT_S = 60.0
MAX_RECORDED_CALLS = 1000


class FakeSttProvider:
    name = tconfig.PROVIDER_FAKE
    model = tconfig.FAKE_MODEL

    def __init__(self, cfg: tconfig.TranscriptionConfig):
        self.mode = cfg.fake_mode
        self.text = cfg.fake_text or tconfig.DEFAULT_FAKE_TEXT
        self.location = cfg.location
        self.calls: list[dict] = []

    def _raise_for_mode(self) -> None:
        if self.mode == "transient":
            raise SttTransient("stt_unavailable", "fake provider: transient mode")
        if self.mode == "unavailable":
            raise SttUnavailable("stt_quota", 300, "fake provider: unavailable mode")
        if self.mode == "rejected":
            raise SttRejected("stt_rejected", "fake provider: rejected mode")

    async def _maybe_slow(self) -> None:
        if self.mode == "slow":
            try:
                await asyncio.wait_for(asyncio.sleep(FAKE_SLOW_S), FAKE_RPC_TIMEOUT_S)
            except TimeoutError:
                raise SttTransient("stt_timeout", "fake provider: slow mode") from None

    async def transcribe(self, chunks: Sequence[SttChunk], *, sample_rate_hz: int,
                         language: str) -> SttOutcome:
        segments: list[SttSegment] = []
        billed = 0
        for chunk in chunks:
            piece_ms = (len(chunk.pcm) // 2) * 1000 // sample_rate_hz
            self.calls.append({"offset_ms": chunk.offset_ms, "bytes": len(chunk.pcm),
                               "piece_ms": piece_ms, "sample_rate_hz": sample_rate_hz,
                               "language": language})
            del self.calls[:-MAX_RECORDED_CALLS]
            self._raise_for_mode()
            await self._maybe_slow()
            billed += math.ceil(piece_ms / 1000) * 1000
            if self.mode != "empty":
                segments.append(SttSegment(start_ms=chunk.offset_ms,
                                           end_ms=chunk.offset_ms + piece_ms,
                                           text=self.text, confidence=FAKE_CONFIDENCE))
        return SttOutcome(segments=tuple(segments), billed_ms=billed, provider=self.name,
                          model=self.model, location=self.location)

    async def smoke(self) -> SttOutcome:
        """1.0 s of silence: no results, 1 s billed (what Google returns)."""
        self._raise_for_mode()
        await self._maybe_slow()
        return SttOutcome(segments=(), billed_ms=1000, provider=self.name, model=self.model,
                          location=self.location)
