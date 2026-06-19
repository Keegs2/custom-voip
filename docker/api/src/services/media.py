"""Media-plane WebSocket consumer (Phase 6).

Pulls L16 PCM frames off a WebSocket fed by FreeSWITCH ``mod_audio_stream``,
tracks frame/byte counts, estimates duration, and drives a pluggable STT hook
(:mod:`services.stt`). The loop is extracted from the FastAPI endpoint so it can
be unit-tested against a synthetic WebSocket without booting the whole app — the
live FS→API fork is verified in prod (on Docker Desktop, host-net FS cannot reach
the bridged API container, the same isolation noted for the ESL consumer).

PROD-3 (multi-worker consistency): each uvicorn worker accepts its OWN media-fork
WebSockets, so a per-process registry diverges across the 4 workers — ``GET
/v1/media/streams`` served by worker B would not see a fork held by worker A. The
active-stream registry is therefore mirrored to Redis (a hash per stream + an
index set, each with a refreshed TTL) so any worker's ``/media/streams`` reflects
ALL workers' forks. It degrades gracefully to this worker's in-memory view when
Redis is unavailable (local dev, or Redis down).

SHOULD-FIX (b) DoS bounds: a media fork is unauthenticated (it arrives from FS
over the internal network), so the consumer caps per-stream bytes / frames /
duration and the number of concurrent streams per worker (all env-tunable) to
bound the memory/CPU an abusive or runaway fork can consume.
"""
import os
import json
import time
import logging
from typing import Optional, Dict, Any, List

from services.stt import STTHook, get_stt_hook
from db import redis_client as cache

logger = logging.getLogger(__name__)

# mod_audio_stream defaults to 16-bit (2 bytes/sample) mono PCM.
_BYTES_PER_SAMPLE = 2

# ---------------------------------------------------------------------------
# DoS bounds (SHOULD-FIX b) — all env-tunable.
# ---------------------------------------------------------------------------
# Max raw audio bytes one stream may deliver before we stop consuming it.
# Default ~100 MB ≈ 100 min of 8 kHz L16 — far beyond any real call, tight
# enough to bound memory abuse.
MEDIA_MAX_BYTES = int(os.getenv("MEDIA_MAX_BYTES", str(100 * 1024 * 1024)))
# Max frames one stream may deliver (a flood of tiny frames is also abuse).
MEDIA_MAX_FRAMES = int(os.getenv("MEDIA_MAX_FRAMES", str(2_000_000)))
# Max estimated audio duration (ms) before we stop. Default 4 hours.
MEDIA_MAX_DURATION_MS = int(os.getenv("MEDIA_MAX_DURATION_MS", str(4 * 60 * 60 * 1000)))
# Max concurrent media forks THIS worker will consume at once.
MEDIA_MAX_CONCURRENT_STREAMS = int(os.getenv("MEDIA_MAX_CONCURRENT_STREAMS", "200"))

# ---------------------------------------------------------------------------
# Redis mirror keys (PROD-3)
# ---------------------------------------------------------------------------
_REDIS_STREAM_PREFIX = "media:stream:"
_REDIS_STREAM_INDEX = "media:streams"
# Per-stream hash TTL; refreshed on each mirror so a crashed worker's forks
# self-expire instead of lingering forever in the cross-worker view.
_REDIS_STREAM_TTL = int(os.getenv("MEDIA_STREAM_REDIS_TTL", "60"))
# Mirror to Redis at most this often per stream (don't await Redis per frame).
_REDIS_MIRROR_INTERVAL_SEC = float(os.getenv("MEDIA_STREAM_MIRROR_INTERVAL", "2.0"))


# ---------------------------------------------------------------------------
# Active media-stream registry (Phase 8 observability, PROD-3 Redis-backed)
# ---------------------------------------------------------------------------
# In-memory map of the CURRENTLY-OPEN audio forks THIS worker is consuming:
#   call_uuid -> {frames, bytes, duration_ms, started_at}
# Updated live by consume_media_stream and torn down when the WS disconnects. It
# is mirrored to Redis so list_active_streams() can union all workers' forks.
_active_streams: Dict[str, Dict[str, Any]] = {}


async def _redis_mirror_stream(call_uuid: str, entry: Dict[str, Any]) -> None:
    """Best-effort write-through of one active stream to Redis (PROD-3).

    Uses the module-level Redis client DIRECTLY (never get_client(), which could
    trigger a blocking reconnect) so a down Redis is a fast no-op — the same
    fail-open rule as the health probe.
    """
    rc = cache.client
    if rc is None:
        return
    try:
        key = f"{_REDIS_STREAM_PREFIX}{call_uuid}"
        await rc.set(key, json.dumps({"call_uuid": call_uuid, **entry}), ex=_REDIS_STREAM_TTL)
        await rc.sadd(_REDIS_STREAM_INDEX, call_uuid)
    except Exception:  # noqa: BLE001
        logger.debug("media stream redis mirror failed call=%s", call_uuid, exc_info=True)


async def _redis_remove_stream(call_uuid: str) -> None:
    """Best-effort removal of a finished stream from the Redis mirror."""
    rc = cache.client
    if rc is None:
        return
    try:
        await rc.delete(f"{_REDIS_STREAM_PREFIX}{call_uuid}")
        await rc.srem(_REDIS_STREAM_INDEX, call_uuid)
    except Exception:  # noqa: BLE001
        logger.debug("media stream redis remove failed call=%s", call_uuid, exc_info=True)


async def list_active_streams() -> List[Dict[str, Any]]:
    """Cross-worker snapshot of active media-fork sessions for the observability
    endpoint (PROD-3).

    Unions THIS worker's in-memory forks with the Redis-mirrored forks of all
    workers, deduped by ``call_uuid`` (local wins — it is the freshest for forks
    this worker holds). Always succeeds: when Redis is unavailable it returns just
    the local in-memory view (never raises), so ``/media/streams`` never 500s.
    """
    merged: Dict[str, Dict[str, Any]] = {}

    rc = cache.client
    if rc is not None:
        try:
            uuids = await rc.smembers(_REDIS_STREAM_INDEX)
            for cu in uuids:
                raw = await rc.get(f"{_REDIS_STREAM_PREFIX}{cu}")
                if raw is None:
                    # Stale index entry (hash expired) — clean it up opportunistically.
                    try:
                        await rc.srem(_REDIS_STREAM_INDEX, cu)
                    except Exception:  # noqa: BLE001
                        pass
                    continue
                try:
                    merged[cu] = json.loads(raw)
                except Exception:  # noqa: BLE001
                    continue
        except Exception:  # noqa: BLE001
            logger.debug("media stream redis read failed", exc_info=True)

    # Local in-memory forks are authoritative for this worker.
    for call_uuid, s in _active_streams.items():
        merged[call_uuid] = {
            "call_uuid": call_uuid,
            "frames": s["frames"],
            "bytes": s["bytes"],
            "duration_ms": s["duration_ms"],
            "started_at": s["started_at"],
        }

    return list(merged.values())


async def consume_media_stream(
    websocket,
    call_uuid: str,
    *,
    sample_rate: int = 8000,
    hook: Optional[STTHook] = None,
) -> dict:
    """Consume binary audio frames from ``websocket`` until it disconnects.

    ``websocket`` must expose an async ``receive()`` returning a dict in the
    Starlette ASGI shape: a ``"type"`` key (``"websocket.receive"`` /
    ``"websocket.disconnect"``) plus optional ``"bytes"`` / ``"text"``. This
    matches :class:`starlette.websockets.WebSocket` so the real endpoint and a
    test fake share one code path.

    Returns a stats dict ``{frames, bytes, duration_ms}``. Never raises on a
    clean disconnect; the STT hook's lifecycle callbacks are always invoked
    (``on_start`` once, ``on_audio`` per frame, ``on_stop`` once).

    SHOULD-FIX (b): the per-worker concurrent-stream limit and the per-stream
    byte/frame/duration caps bound the DoS surface of an unauthenticated fork.
    """
    hook = hook or get_stt_hook()

    # SHOULD-FIX (b): reject when this worker is already at its concurrent-stream
    # cap. Fire the lifecycle so the hook sees a clean (empty) start/stop pair and
    # callers still get a stats dict; we never begin consuming the abusive fork.
    if len(_active_streams) >= MEDIA_MAX_CONCURRENT_STREAMS:
        logger.warning(
            "Media WS rejected call=%s — worker at concurrent-stream cap (%d)",
            call_uuid, MEDIA_MAX_CONCURRENT_STREAMS,
        )
        await hook.on_start(call_uuid, {"call_uuid": call_uuid, "sample_rate": sample_rate, "rejected": True})
        stats = {"frames": 0, "bytes": 0, "duration_ms": 0}
        try:
            await hook.on_stop(call_uuid, stats)
        except Exception:  # noqa: BLE001
            logger.debug("STT on_stop error call=%s", call_uuid, exc_info=True)
        return stats

    await hook.on_start(call_uuid, {"call_uuid": call_uuid, "sample_rate": sample_rate})

    # Register this fork as active for the observability endpoint; the entry is
    # mutated in place per frame and removed on disconnect (finally).
    entry: Dict[str, Any] = {
        "frames": 0, "bytes": 0, "duration_ms": 0, "started_at": time.time(),
    }
    _active_streams[call_uuid] = entry
    await _redis_mirror_stream(call_uuid, entry)
    last_mirror = time.monotonic()

    frame_count = 0
    total_bytes = 0
    try:
        while True:
            msg = await websocket.receive()
            if msg.get("type") == "websocket.disconnect":
                break

            data = msg.get("bytes")
            if data is None:
                # Some forks send a JSON text control frame (e.g. a start event)
                # before/around the audio. We only consume binary PCM.
                text = msg.get("text")
                if text is not None:
                    logger.debug("Media WS text frame call=%s: %s", call_uuid, str(text)[:200])
                continue

            frame_count += 1
            total_bytes += len(data)
            entry["frames"] = frame_count
            entry["bytes"] = total_bytes
            entry["duration_ms"] = int(
                (total_bytes / _BYTES_PER_SAMPLE) / max(sample_rate, 1) * 1000
            )
            await hook.on_audio(call_uuid, data)

            # SHOULD-FIX (b): stop consuming once any per-stream cap is hit. This
            # is a clean stop (stats still emitted) — it bounds an abusive fork
            # without crashing the worker.
            if (
                total_bytes >= MEDIA_MAX_BYTES
                or frame_count >= MEDIA_MAX_FRAMES
                or entry["duration_ms"] >= MEDIA_MAX_DURATION_MS
            ):
                logger.warning(
                    "Media WS cap hit call=%s frames=%d bytes=%d duration_ms=%d "
                    "— stopping consumption", call_uuid, frame_count, total_bytes,
                    entry["duration_ms"],
                )
                break

            # Throttled Redis mirror (don't await Redis on every frame).
            now = time.monotonic()
            if now - last_mirror >= _REDIS_MIRROR_INTERVAL_SEC:
                await _redis_mirror_stream(call_uuid, entry)
                last_mirror = now
    except Exception as e:  # noqa: BLE001
        # WebSocketDisconnect (starlette) ends the stream cleanly; anything else
        # is logged but still falls through to on_stop so stats are emitted.
        if e.__class__.__name__ != "WebSocketDisconnect":
            logger.warning("Media WS consume error call=%s: %r", call_uuid, e)
    finally:
        _active_streams.pop(call_uuid, None)
        await _redis_remove_stream(call_uuid)
        duration_ms = int((total_bytes / _BYTES_PER_SAMPLE) / max(sample_rate, 1) * 1000)
        stats = {"frames": frame_count, "bytes": total_bytes, "duration_ms": duration_ms}
        try:
            await hook.on_stop(call_uuid, stats)
        except Exception:  # noqa: BLE001
            logger.debug("STT on_stop error call=%s", call_uuid, exc_info=True)

    return stats
