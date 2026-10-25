"""Client for the internal Piper TTS sidecar (contract §8.1) + the preview limiter.

The sidecar (``docker/tts``, services-network only, no published port):
  * ``POST {IVR_TTS_URL}/synthesize`` ``{text, voice}`` -> ``audio/wav`` at any
    rate (200), 400 (bad text/voice), 503 (busy/not ready);
  * ``GET {IVR_TTS_URL}/voices`` -> ``[{id, label, gender, license, version}]``
    (``version`` = engine + model hash; used for the render cache key only).

The API turns the sidecar's WAV into the canonical 8 kHz prompt format
(services/ivr/audio.canonicalize), so a sha is deterministic for the same
(engine version, voice, text). Render cache (contract §4): key
``sha256(f"{engine_version}|{voice}|{text}")`` -> the canonical audio's
sha256, kept in a small in-process LRU and in Redis (``ivr:tts:<key>``,
30 days). A hit is only used when that audio is still in
``ivr_prompt_audio`` (the caller checks), so the cache can never point at
audio that is gone.

Env (read live): ``IVR_TTS_URL`` (default ``http://tts:5000``),
``IVR_TTS_TIMEOUT_S`` (default 30, clamped 2-120).
"""
from __future__ import annotations

import hashlib
import logging
import os
import time
from collections import OrderedDict, deque
from typing import Any, Optional

import httpx

from db import redis_client
from services.ivr import audio, limits

logger = logging.getLogger(__name__)

DEFAULT_URL = "http://tts:5000"
VOICES_TTL_S = 300.0
CACHE_TTL_S = 30 * 24 * 3600
_LRU_SIZE = 512
_PUBLIC_VOICE_KEYS = ("id", "label", "gender", "license")


class TtsUnavailable(Exception):
    """Sidecar unreachable / 5xx / garbage -> HTTP 503."""


class TtsRejected(Exception):
    """Sidecar said 400 (text or voice not acceptable) -> HTTP 422."""


def tts_url() -> str:
    return (os.getenv("IVR_TTS_URL") or DEFAULT_URL).strip().rstrip("/")


def tts_timeout() -> float:
    try:
        value = float(os.getenv("IVR_TTS_TIMEOUT_S", "30"))
    except ValueError:
        value = 30.0
    return min(max(value, 2.0), 120.0)


def cache_key(engine_version: str, voice: str, text: str) -> str:
    """Contract §4: sha256 of ``engine_version|voice|text``."""
    return hashlib.sha256(f"{engine_version}|{voice}|{text}".encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Voices (cached)
# ---------------------------------------------------------------------------
_voices: Optional[list[dict]] = None
_voices_at = 0.0


def reset_caches() -> None:
    global _voices, _voices_at
    _voices, _voices_at = None, 0.0
    _render_lru.clear()
    preview_limiter.reset()


async def list_voices(*, force: bool = False) -> list[dict]:
    """The sidecar's voices (internal shape incl. ``version``), cached 5 min."""
    global _voices, _voices_at
    now = time.monotonic()
    if not force and _voices is not None and now - _voices_at < VOICES_TTL_S:
        return _voices
    try:
        async with httpx.AsyncClient(timeout=min(tts_timeout(), 10.0)) as client:
            resp = await client.get(f"{tts_url()}/voices")
        if resp.status_code != 200:
            raise TtsUnavailable(f"voices HTTP {resp.status_code}")
        data = resp.json()
    except TtsUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001 — network/JSON: unavailable
        if _voices is not None:
            return _voices  # stale is better than nothing for a picker
        raise TtsUnavailable(f"{type(exc).__name__}: {exc}") from exc
    voices = [v for v in data if isinstance(v, dict) and isinstance(v.get("id"), str)] \
        if isinstance(data, list) else []
    if not voices:
        raise TtsUnavailable("sidecar returned no voices")
    _voices, _voices_at = voices, now
    return voices


def public_voice(v: dict) -> dict:
    return {k: v.get(k) for k in _PUBLIC_VOICE_KEYS}


async def voice_version(voice: str) -> Optional[str]:
    """The voice's engine version string, or None when the voice is unknown."""
    for v in await list_voices():
        if v.get("id") == voice:
            return str(v.get("version") or "piper")
    return None


# ---------------------------------------------------------------------------
# Render cache (key -> canonical sha)
# ---------------------------------------------------------------------------
_render_lru: "OrderedDict[str, str]" = OrderedDict()


async def cached_sha(key: str) -> Optional[str]:
    sha = _render_lru.get(key)
    if sha is not None:
        _render_lru.move_to_end(key)
        return sha
    try:
        sha = await redis_client.cache_get(f"ivr:tts:{key}")
    except Exception as exc:  # noqa: BLE001 — Redis is optional
        logger.debug("ivr tts cache: redis get failed: %s", type(exc).__name__)
        sha = None
    if isinstance(sha, bytes):
        sha = sha.decode("ascii", "replace")
    if isinstance(sha, str) and len(sha) == 64:
        _remember(key, sha)
        return sha
    return None


def _remember(key: str, sha: str) -> None:
    _render_lru[key] = sha
    _render_lru.move_to_end(key)
    while len(_render_lru) > _LRU_SIZE:
        _render_lru.popitem(last=False)


async def remember(key: str, sha: str) -> None:
    _remember(key, sha)
    try:
        await redis_client.cache_set(f"ivr:tts:{key}", sha, ttl=CACHE_TTL_S)
    except Exception as exc:  # noqa: BLE001
        logger.debug("ivr tts cache: redis set failed: %s", type(exc).__name__)


def forget(key: str) -> None:
    _render_lru.pop(key, None)


# ---------------------------------------------------------------------------
# Synthesis
# ---------------------------------------------------------------------------
async def synthesize(text: str, voice: str) -> audio.CanonicalAudio:
    """Render ``text`` with ``voice`` on the sidecar -> canonical 8 kHz audio.

    Raises TtsRejected (422), TtsUnavailable (503), audio.AudioError (the
    sidecar's WAV was unusable -> treated as unavailable by callers).
    """
    if len(text) > limits.MAX_TTS_CHARS:
        raise TtsRejected("text too long")
    try:
        async with httpx.AsyncClient(timeout=tts_timeout()) as client:
            resp = await client.post(f"{tts_url()}/synthesize",
                                     json={"text": text, "voice": voice})
    except Exception as exc:  # noqa: BLE001
        raise TtsUnavailable(f"{type(exc).__name__}: {exc}") from exc
    if resp.status_code == 400:
        raise TtsRejected("sidecar rejected the request")
    if resp.status_code != 200:
        raise TtsUnavailable(f"synthesize HTTP {resp.status_code}")
    body = resp.content
    if len(body) > limits.MAX_UPLOAD_BYTES:
        raise TtsUnavailable("sidecar audio too large")
    try:
        return audio.canonicalize(body)
    except audio.AudioError as exc:
        raise TtsUnavailable(f"sidecar audio unusable: {exc.detail}") from exc


# ---------------------------------------------------------------------------
# Preview rate limit: 30 / minute / user (contract §8.2)
# ---------------------------------------------------------------------------
class PreviewLimiter:
    """Redis fixed window (shared by every API worker) when Redis answers;
    otherwise an in-process sliding window (then the bound is per worker)."""

    def __init__(self, per_minute: int = limits.TTS_PREVIEW_PER_MINUTE):
        self.per_minute = per_minute
        self._local: dict[str, deque] = {}

    def reset(self) -> None:
        self._local.clear()

    async def allow(self, user_key: str) -> tuple[bool, int]:
        """(allowed?, retry_after_seconds)."""
        now = time.time()
        minute = int(now // 60)
        try:
            count = await redis_client.incr_with_ttl(f"ivr:ttsprev:{user_key}:{minute}", 70)
        except Exception as exc:  # noqa: BLE001 — Redis down: fall back
            logger.debug("ivr preview limiter: redis failed: %s", type(exc).__name__)
            count = 0
        if count:
            return count <= self.per_minute, max(1, 60 - int(now % 60))
        window = self._local.setdefault(user_key, deque())
        while window and now - window[0] >= 60.0:
            window.popleft()
        if len(window) >= self.per_minute:
            return False, max(1, int(60.0 - (now - window[0])) + 1)
        window.append(now)
        return True, 0


preview_limiter = PreviewLimiter()


def describe_unavailable(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc}"


def voice_ids(voices: list[dict[str, Any]]) -> set[str]:
    return {v["id"] for v in voices}
