"""Pluggable speech-to-text (STT) hook for the media plane (Phase 6).

FreeSWITCH's ``mod_audio_stream`` forks live call audio (L16 PCM frames) to the
API over a WebSocket. The media consumer feeds those frames to an STT backend
through this thin, vendor-agnostic interface so a real provider (Deepgram /
Whisper / Google STT) can be wired later via env (``STT_BACKEND``) WITHOUT
touching the WebSocket endpoint.

The default :class:`NoopSTTHook` transcribes nothing — it just logs the stream
lifecycle and frame totals. That is enough to prove the audio path end-to-end
(frames flow FS → API → hook) which is all Phase 6 requires; real transcription
is a later wiring step.
"""
import os
import logging

logger = logging.getLogger(__name__)


class STTHook:
    """Streaming-STT backend interface.

    A backend observes three lifecycle events for one media stream:
      * :meth:`on_start` — once, when the WebSocket opens.
      * :meth:`on_audio` — per binary PCM frame.
      * :meth:`on_stop`  — once, when the stream ends (with summary stats).
    Implementations must be async and should never raise into the consumer.
    """

    async def on_start(self, call_uuid: str, meta: dict) -> None:  # pragma: no cover - interface
        ...

    async def on_audio(self, call_uuid: str, frame: bytes) -> None:  # pragma: no cover - interface
        ...

    async def on_stop(self, call_uuid: str, stats: dict) -> None:  # pragma: no cover - interface
        ...


class NoopSTTHook(STTHook):
    """Default no-op backend: logs lifecycle + frame totals, transcribes nothing.

    Vendor-agnostic proof that audio frames flow from FreeSWITCH to the API.
    """

    async def on_start(self, call_uuid: str, meta: dict) -> None:
        logger.info("STT[noop] stream start call=%s meta=%s", call_uuid, meta)

    async def on_audio(self, call_uuid: str, frame: bytes) -> None:
        logger.debug("STT[noop] audio call=%s bytes=%d", call_uuid, len(frame))

    async def on_stop(self, call_uuid: str, stats: dict) -> None:
        logger.info("STT[noop] stream stop call=%s stats=%s", call_uuid, stats)


_hook: STTHook | None = None


def get_stt_hook() -> STTHook:
    """Return the configured STT hook (process singleton).

    ``STT_BACKEND`` selects the implementation; only ``noop`` ships today. Real
    backends are dispatched here once added — the consumer/endpoint never change.
    """
    global _hook
    if _hook is None:
        backend = os.getenv("STT_BACKEND", "noop").lower()
        # Future: branch on `backend` to construct a real vendor client.
        _hook = NoopSTTHook()
        logger.info(
            "STT hook initialized: backend=%s impl=%s",
            backend, _hook.__class__.__name__,
        )
    return _hook


def set_stt_hook(hook: STTHook | None) -> None:
    """Override the singleton (test seam / runtime wiring). Pass ``None`` to reset."""
    global _hook
    _hook = hook
