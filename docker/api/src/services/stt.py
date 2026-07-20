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


# ===========================================================================
# Pluggable streaming-STT PROVIDERS for the AI voice-agent runtime (ai_agent).
# ===========================================================================
# The ``STTHook`` above is the media-plane lifecycle hook (Phase 6). The AI
# runtime needs a richer, per-agent-selected transcription surface with TWO
# execution modes:
#
#   * "batched"   — the orchestrator segments utterances with a VAD and asks the
#                   provider to transcribe one utterance of PCM at a time. This is
#                   the DEFAULT and the COMPLIANCE path: WhisperHTTPProvider posts
#                   to a SELF-HOSTED whisper server (base_url), so no audio leaves
#                   the VPC. First-class on purpose.
#   * "streaming" — the provider keeps a live socket and emits transcripts as the
#                   caller speaks (DeepgramSTTProvider). Cloud, EXPLICIT opt-in.
#
# Every provider is chosen per agent config; the self-hostable Whisper path is
# the default so nothing forces PHI/CPNI egress.
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import AsyncIterator, Optional

from services import ai_audio

# Provider execution modes.
STT_MODE_BATCHED = "batched"
STT_MODE_STREAMING = "streaming"


@dataclass
class Transcript:
    """One STT result. ``is_final`` distinguishes a settled utterance from an
    interim hypothesis (streaming providers emit interims; batched only finals)."""
    text: str
    is_final: bool = True
    confidence: Optional[float] = None


class STTStream(ABC):
    """A live streaming-STT session (one per call). Only used by streaming providers."""

    @abstractmethod
    async def send_audio(self, pcm: bytes) -> None:  # pragma: no cover - interface
        ...

    @abstractmethod
    def results(self) -> AsyncIterator[Transcript]:  # pragma: no cover - interface
        ...

    async def close(self) -> None:  # pragma: no cover - interface
        ...


class STTProvider(ABC):
    """Vendor-agnostic STT provider selected per agent config.

    ``mode`` tells the orchestrator how to drive it. ``self_hosted`` powers the
    compliance signal ("does audio stay in the VPC?").
    """
    mode: str = STT_MODE_BATCHED
    self_hosted: bool = True
    name: str = "base"

    async def transcribe(self, pcm: bytes, sample_rate: int) -> str:
        """Batched mode: transcribe one utterance of L16 mono PCM. Returns text
        (may be empty). MUST NOT raise into the orchestrator — return '' on error."""
        return ""

    async def open_stream(self, call_uuid: str, sample_rate: int) -> STTStream:
        """Streaming mode: open a live transcription session."""
        raise NotImplementedError


class NoopSTTProvider(STTProvider):
    """Fallback provider: transcribes nothing (keeps the pipeline alive when no
    real STT is configured). Mirrors :class:`NoopSTTHook`."""
    mode = STT_MODE_BATCHED
    self_hosted = True
    name = "noop"

    async def transcribe(self, pcm: bytes, sample_rate: int) -> str:
        logger.debug("STT[noop] transcribe bytes=%d — returning ''", len(pcm))
        return ""


class WhisperHTTPProvider(STTProvider):
    """SELF-HOSTED Whisper over HTTP — the default, compliance-first STT path.

    Posts one utterance as a WAV to an OpenAI-compatible transcription endpoint
    (``POST {base_url}/audio/transcriptions``, multipart ``file`` + ``model``).
    Works against faster-whisper-server / whisper.cpp server / openedai-whisper /
    a vLLM-hosted Whisper — anything speaking the OpenAI audio API INSIDE the VPC.
    Whisper prefers 16 kHz, so 8 kHz call audio is upsampled before upload.

    ``api_key`` is optional (self-hosted servers usually need none); when set it is
    sent as a Bearer token so the same class also drives a locked-down internal
    gateway. Never raises into the orchestrator.
    """
    mode = STT_MODE_BATCHED
    name = "whisper_http"

    WHISPER_RATE = 16000

    def __init__(
        self,
        base_url: str,
        model: str = "whisper-1",
        language: str = "en",
        api_key: Optional[str] = None,
        timeout: float = 15.0,
        self_hosted: bool = True,
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.language = language
        self.api_key = api_key
        self.timeout = timeout
        self.self_hosted = self_hosted

    async def transcribe(self, pcm: bytes, sample_rate: int) -> str:
        if not pcm:
            return ""
        try:
            up = ai_audio.resample_pcm16(pcm, sample_rate, self.WHISPER_RATE)
            wav = ai_audio.pcm16_to_wav(up, self.WHISPER_RATE)
            import httpx  # local import keeps module import cheap

            headers = {}
            if self.api_key:
                headers["Authorization"] = f"Bearer {self.api_key}"
            files = {"file": ("utterance.wav", wav, "audio/wav")}
            data = {"model": self.model, "response_format": "json"}
            if self.language:
                data["language"] = self.language
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(
                    f"{self.base_url}/audio/transcriptions",
                    headers=headers,
                    files=files,
                    data=data,
                )
            if resp.status_code >= 400:
                logger.warning(
                    "STT[whisper_http] %s -> HTTP %d: %s",
                    self.base_url, resp.status_code, resp.text[:200],
                )
                return ""
            body = resp.json()
            # OpenAI shape: {"text": "..."}. Some servers wrap it in "results".
            text = body.get("text") if isinstance(body, dict) else None
            return (text or "").strip()
        except Exception:
            logger.warning("STT[whisper_http] transcription failed", exc_info=True)
            return ""


class _DeepgramStream(STTStream):
    """Live Deepgram streaming session over a WebSocket (aiohttp)."""

    def __init__(self, api_key: str, sample_rate: int, model: str, language: str):
        self._api_key = api_key
        self._rate = sample_rate
        self._model = model
        self._language = language
        self._ws = None
        self._session = None

    async def _connect(self) -> None:
        import aiohttp  # local import — aiohttp only needed for streaming providers

        url = (
            "wss://api.deepgram.com/v1/listen"
            f"?encoding=linear16&sample_rate={self._rate}&channels=1"
            f"&model={self._model}&language={self._language}"
            "&interim_results=true&punctuate=true&endpointing=300"
        )
        self._session = aiohttp.ClientSession()
        self._ws = await self._session.ws_connect(
            url, headers={"Authorization": f"Token {self._api_key}"}
        )

    async def send_audio(self, pcm: bytes) -> None:
        if self._ws is None:
            await self._connect()
        try:
            await self._ws.send_bytes(pcm)
        except Exception:
            logger.debug("STT[deepgram] send failed", exc_info=True)

    async def results(self) -> AsyncIterator[Transcript]:
        if self._ws is None:
            await self._connect()
        import aiohttp

        try:
            async for msg in self._ws:
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                try:
                    data = orjson_loads(msg.data)
                except Exception:
                    continue
                alt = (
                    data.get("channel", {})
                    .get("alternatives", [{}])[0]
                )
                text = (alt.get("transcript") or "").strip()
                if not text:
                    continue
                yield Transcript(
                    text=text,
                    is_final=bool(data.get("is_final")),
                    confidence=alt.get("confidence"),
                )
        except Exception:
            logger.debug("STT[deepgram] result loop ended", exc_info=True)

    async def close(self) -> None:
        try:
            if self._ws is not None:
                await self._ws.close()
        finally:
            if self._session is not None:
                await self._session.close()


class DeepgramSTTProvider(STTProvider):
    """Deepgram real-time streaming STT — CLOUD, explicit opt-in (data egress)."""
    mode = STT_MODE_STREAMING
    self_hosted = False
    name = "deepgram"

    def __init__(self, api_key: str, model: str = "nova-2-phonecall", language: str = "en"):
        self.api_key = api_key
        self.model = model
        self.language = language

    async def open_stream(self, call_uuid: str, sample_rate: int) -> STTStream:
        return _DeepgramStream(self.api_key, sample_rate, self.model, self.language)


def orjson_loads(data):
    """Tolerant JSON loader (bytes|str) — orjson with a stdlib fallback."""
    try:
        import orjson
        return orjson.loads(data)
    except Exception:
        import json
        if isinstance(data, (bytes, bytearray)):
            data = data.decode("utf-8", "replace")
        return json.loads(data)


def get_stt_provider(
    provider: Optional[str] = None,
    *,
    base_url: Optional[str] = None,
    model: Optional[str] = None,
    language: Optional[str] = None,
    api_key: Optional[str] = None,
) -> STTProvider:
    """Construct the per-agent STT provider.

    Selection order: explicit ``provider`` arg → ``AI_STT_PROVIDER`` env →
    ``whisper_http`` (self-hosted default). Unknown/misconfigured providers fall
    back to Noop so a bad config degrades the agent rather than crashing the call.
    """
    provider = (provider or os.getenv("AI_STT_PROVIDER", "whisper_http")).lower()
    language = language or os.getenv("AI_STT_LANGUAGE", "en")

    if provider in ("noop", "none", "off"):
        return NoopSTTProvider()

    if provider in ("whisper_http", "whisper", "self_hosted", "local"):
        url = base_url or os.getenv("AI_STT_BASE_URL", "http://127.0.0.1:9000")
        return WhisperHTTPProvider(
            base_url=url,
            model=model or os.getenv("AI_STT_MODEL", "whisper-1"),
            language=language,
            api_key=api_key or os.getenv("AI_STT_API_KEY") or None,
            # A localhost/RFC1918 base_url is treated as in-VPC (self-hosted).
            self_hosted=_looks_internal(url),
        )

    if provider == "deepgram":
        key = api_key or os.getenv("DEEPGRAM_API_KEY", "")
        if not key:
            logger.warning("STT[deepgram] selected but no API key — falling back to Noop")
            return NoopSTTProvider()
        return DeepgramSTTProvider(
            api_key=key,
            model=model or os.getenv("AI_STT_MODEL", "nova-2-phonecall"),
            language=language,
        )

    logger.warning("STT: unknown provider %r — falling back to Noop", provider)
    return NoopSTTProvider()


def _looks_internal(url: str) -> bool:
    """True when a base_url points at localhost / RFC1918 / *.local / an internal
    compose hostname — i.e. audio stays in the VPC. Best-effort compliance signal."""
    import re

    host = re.sub(r"^\w+://", "", url or "").split("/", 1)[0].split(":", 1)[0].lower()
    if host in ("localhost", "127.0.0.1", "::1"):
        return True
    if host.endswith(".local") or host.endswith(".internal") or host.endswith(".svc"):
        return True
    if "." not in host:  # bare compose/k8s service name
        return True
    if re.match(r"^10\.", host) or re.match(r"^192\.168\.", host):
        return True
    if re.match(r"^172\.(1[6-9]|2\d|3[01])\.", host):
        return True
    return False
