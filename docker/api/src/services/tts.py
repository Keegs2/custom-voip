"""Pluggable text-to-speech for the in-boundary AI voice-agent runtime.

The platform already self-hosts Piper (neural, offline, MIT) inside the
FreeSWITCH image for TwiML ``<Say>``. The AI runtime, however, synthesizes from
the API process, so it needs TTS reachable over HTTP. This module provides:

  * :class:`HTTPTTSProvider` — SELF-HOSTED default. Talks the OpenAI
    ``/audio/speech`` wire format to an in-VPC voice server (openedai-speech /
    piper-http / a Piper or Coqui HTTP wrapper). No text leaves the boundary.
  * :class:`OpenAITTSProvider` / :class:`ElevenLabsTTSProvider` — CLOUD voices,
    explicit opt-in only.

Providers yield L16 PCM at their native rate; the orchestrator resamples to the
call rate (8 kHz) before framing it for mod_audio_stream. Providers stream where
the upstream supports it (lower time-to-first-audio) and NEVER raise into the
orchestrator — a failure yields nothing and ai_agent takes its fallback path.
"""
from __future__ import annotations

import os
import logging
from abc import ABC, abstractmethod
from typing import AsyncIterator, Optional

from services import ai_audio

logger = logging.getLogger(__name__)


class TTSProvider(ABC):
    """Vendor-agnostic streaming TTS. ``sample_rate`` is the PCM rate the provider
    yields; the orchestrator resamples from there to the call rate."""
    self_hosted: bool = True
    name: str = "base"
    sample_rate: int = 22050

    @abstractmethod
    def synthesize(self, text: str, voice: Optional[str] = None) -> AsyncIterator[bytes]:
        """Yield L16 mono PCM chunks (at ``self.sample_rate``) for ``text``."""
        ...  # pragma: no cover - interface


class HTTPTTSProvider(TTSProvider):
    """SELF-HOSTED HTTP TTS — the default, compliance-first voice path.

    Posts to an OpenAI-compatible ``POST {base_url}/audio/speech`` endpoint and
    reads back audio. ``response_format`` defaults to ``pcm`` (raw L16, which the
    OpenAI spec defines at 24 kHz; self-hosted servers commonly honor a
    ``sample_rate`` too) so there is nothing to decode. If a server can only
    return ``wav``, set ``AI_TTS_FORMAT=wav`` and we parse the header.

    ``api_key`` optional (self-hosted needs none). Never raises.
    """
    name = "http"

    def __init__(
        self,
        base_url: str,
        voice: str = "en_US-lessac-medium",
        model: str = "tts-1",
        api_key: Optional[str] = None,
        response_format: str = "pcm",
        sample_rate: int = 24000,
        timeout: float = 20.0,
        self_hosted: bool = True,
    ):
        self.base_url = base_url.rstrip("/")
        self.voice = voice
        self.model = model
        self.api_key = api_key
        self.response_format = response_format
        self.sample_rate = sample_rate
        self.timeout = timeout
        self.self_hosted = self_hosted

    async def synthesize(self, text: str, voice: Optional[str] = None):
        text = (text or "").strip()
        if not text:
            return
        import httpx

        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        payload = {
            "model": self.model,
            "input": text,
            "voice": voice or self.voice,
            "response_format": self.response_format,
        }
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                if self.response_format == "pcm":
                    # Stream raw PCM chunks straight through (low latency).
                    async with client.stream(
                        "POST", f"{self.base_url}/audio/speech",
                        headers=headers, json=payload,
                    ) as resp:
                        if resp.status_code >= 400:
                            body = (await resp.aread()).decode("utf-8", "replace")
                            logger.warning("TTS[http] HTTP %d: %s", resp.status_code, body[:200])
                            return
                        async for chunk in resp.aiter_bytes():
                            if chunk:
                                yield chunk
                else:
                    resp = await client.post(
                        f"{self.base_url}/audio/speech", headers=headers, json=payload
                    )
                    if resp.status_code >= 400:
                        logger.warning(
                            "TTS[http] HTTP %d: %s", resp.status_code, resp.text[:200]
                        )
                        return
                    data = resp.content
                    if self.response_format == "wav":
                        pcm, rate = ai_audio.wav_to_pcm16(data)
                        # Reflect the true rate for the orchestrator's resampler.
                        self.sample_rate = rate
                        yield pcm
                    else:
                        yield data
        except Exception:
            logger.warning("TTS[http] synthesis failed", exc_info=True)
            return


class OpenAITTSProvider(TTSProvider):
    """OpenAI cloud TTS (``/v1/audio/speech``) — CLOUD, explicit opt-in. Emits raw
    PCM at 24 kHz."""
    name = "openai"
    self_hosted = False
    sample_rate = 24000

    def __init__(self, api_key: str, voice: str = "alloy", model: str = "tts-1",
                 base_url: str = "https://api.openai.com/v1", timeout: float = 20.0):
        self._impl = HTTPTTSProvider(
            base_url=base_url, voice=voice, model=model, api_key=api_key,
            response_format="pcm", sample_rate=24000, timeout=timeout,
            self_hosted=False,
        )
        self.voice = voice

    async def synthesize(self, text: str, voice: Optional[str] = None):
        async for chunk in self._impl.synthesize(text, voice or self.voice):
            yield chunk


class ElevenLabsTTSProvider(TTSProvider):
    """ElevenLabs streaming TTS — CLOUD, explicit opt-in. Requests ``pcm_16000``
    so no decode is needed."""
    name = "elevenlabs"
    self_hosted = False
    sample_rate = 16000

    def __init__(self, api_key: str, voice: str = "Rachel", model: str = "eleven_turbo_v2",
                 timeout: float = 20.0):
        self.api_key = api_key
        self.voice = voice  # voice_id
        self.model = model
        self.timeout = timeout

    async def synthesize(self, text: str, voice: Optional[str] = None):
        text = (text or "").strip()
        if not text:
            return
        import httpx

        voice_id = voice or self.voice
        url = (
            f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream"
            "?output_format=pcm_16000"
        )
        headers = {"xi-api-key": self.api_key, "Content-Type": "application/json"}
        payload = {"text": text, "model_id": self.model}
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                async with client.stream("POST", url, headers=headers, json=payload) as resp:
                    if resp.status_code >= 400:
                        body = (await resp.aread()).decode("utf-8", "replace")
                        logger.warning("TTS[elevenlabs] HTTP %d: %s", resp.status_code, body[:200])
                        return
                    async for chunk in resp.aiter_bytes():
                        if chunk:
                            yield chunk
        except Exception:
            logger.warning("TTS[elevenlabs] synthesis failed", exc_info=True)
            return


class NullTTSProvider(TTSProvider):
    """Yields nothing — the last-resort fallback so a bad TTS config degrades to
    silence rather than crashing the call (ai_agent then transfers/hangs up)."""
    name = "null"
    sample_rate = 8000

    async def synthesize(self, text: str, voice: Optional[str] = None):
        if False:  # pragma: no cover - generator that yields nothing
            yield b""
        return


def get_tts_provider(
    provider: Optional[str] = None,
    *,
    base_url: Optional[str] = None,
    voice: Optional[str] = None,
    model: Optional[str] = None,
    api_key: Optional[str] = None,
) -> TTSProvider:
    """Construct the per-agent TTS provider.

    Defaults to the self-hosted HTTP path (``AI_TTS_*`` env). Cloud providers
    (openai/elevenlabs) require a key and are opt-in; a missing key falls back to
    the self-hosted HTTP provider so no agent silently breaks.
    """
    provider = (provider or os.getenv("AI_TTS_PROVIDER", "http")).lower()
    voice = voice or os.getenv("AI_TTS_VOICE", "en_US-lessac-medium")

    if provider in ("http", "piper", "self_hosted", "local", "openedai"):
        url = base_url or os.getenv("AI_TTS_BASE_URL", "http://127.0.0.1:8002/v1")
        fmt = os.getenv("AI_TTS_FORMAT", "pcm")
        try:
            rate = int(os.getenv("AI_TTS_SAMPLE_RATE", "24000"))
        except ValueError:
            rate = 24000
        return HTTPTTSProvider(
            base_url=url,
            voice=voice,
            model=model or os.getenv("AI_TTS_MODEL", "tts-1"),
            api_key=api_key or os.getenv("AI_TTS_API_KEY") or None,
            response_format=fmt,
            sample_rate=rate,
            self_hosted=_looks_internal(url),
        )

    if provider == "openai":
        key = api_key or os.getenv("AI_TTS_API_KEY") or os.getenv("OPENAI_API_KEY", "")
        if not key:
            logger.warning("TTS[openai] selected but no API key — using self-hosted HTTP")
            return get_tts_provider("http", base_url=base_url, voice=voice, model=model)
        return OpenAITTSProvider(api_key=key, voice=voice or "alloy",
                                 model=model or "tts-1")

    if provider in ("elevenlabs", "eleven"):
        key = api_key or os.getenv("ELEVENLABS_API_KEY", "")
        if not key:
            logger.warning("TTS[elevenlabs] selected but no API key — using self-hosted HTTP")
            return get_tts_provider("http", base_url=base_url, voice=voice, model=model)
        return ElevenLabsTTSProvider(api_key=key, voice=voice or "Rachel",
                                     model=model or "eleven_turbo_v2")

    logger.warning("TTS: unknown provider %r — using self-hosted HTTP", provider)
    return get_tts_provider("http", base_url=base_url, voice=voice, model=model)


def _looks_internal(url: str) -> bool:
    """See stt._looks_internal — does this base_url stay in the VPC?"""
    import re

    host = re.sub(r"^\w+://", "", url or "").split("/", 1)[0].split(":", 1)[0].lower()
    if host in ("localhost", "127.0.0.1", "::1"):
        return True
    if host.endswith(".local") or host.endswith(".internal") or host.endswith(".svc"):
        return True
    if "." not in host:
        return True
    if re.match(r"^10\.", host) or re.match(r"^192\.168\.", host):
        return True
    if re.match(r"^172\.(1[6-9]|2\d|3[01])\.", host):
        return True
    return False
