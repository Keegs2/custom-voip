"""Media-plane WebSocket consumer (Phase 6).

Pulls L16 PCM frames off a WebSocket fed by FreeSWITCH ``mod_audio_stream``,
tracks frame/byte counts, estimates duration, and drives a pluggable STT hook
(:mod:`services.stt`). The loop is extracted from the FastAPI endpoint so it can
be unit-tested against a synthetic WebSocket without booting the whole app — the
live FS→API fork is verified in prod (on Docker Desktop, host-net FS cannot reach
the bridged API container, the same isolation noted for the ESL consumer).
"""
import time
import logging
from typing import Optional, Dict, Any, List

from services.stt import STTHook, get_stt_hook

logger = logging.getLogger(__name__)

# mod_audio_stream defaults to 16-bit (2 bytes/sample) mono PCM.
_BYTES_PER_SAMPLE = 2


# ---------------------------------------------------------------------------
# Active media-stream registry (Phase 8 observability)
# ---------------------------------------------------------------------------
# In-memory map of the CURRENTLY-OPEN audio forks this worker is consuming:
#   call_uuid -> {frames, bytes, duration_ms, started_at}
# Updated live by consume_media_stream and torn down when the WS disconnects,
# so list_active_streams() reflects only in-progress forks. Like the ESL
# live-call registry this is per-worker (each uvicorn worker accepts its own WS
# connections), which is correct: a worker reports exactly the forks it holds.
_active_streams: Dict[str, Dict[str, Any]] = {}


def list_active_streams() -> List[Dict[str, Any]]:
    """Read-only snapshot of active media-fork sessions for the observability
    endpoint. Always succeeds (pure in-memory) — empty list when no forks."""
    return [
        {
            "call_uuid": call_uuid,
            "frames": s["frames"],
            "bytes": s["bytes"],
            "duration_ms": s["duration_ms"],
            "started_at": s["started_at"],
        }
        for call_uuid, s in _active_streams.items()
    ]


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
    """
    hook = hook or get_stt_hook()
    await hook.on_start(call_uuid, {"call_uuid": call_uuid, "sample_rate": sample_rate})

    # Register this fork as active for the observability endpoint; the entry is
    # mutated in place per frame and removed on disconnect (finally).
    entry: Dict[str, Any] = {
        "frames": 0, "bytes": 0, "duration_ms": 0, "started_at": time.time(),
    }
    _active_streams[call_uuid] = entry

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
    except Exception as e:  # noqa: BLE001
        # WebSocketDisconnect (starlette) ends the stream cleanly; anything else
        # is logged but still falls through to on_stop so stats are emitted.
        if e.__class__.__name__ != "WebSocketDisconnect":
            logger.warning("Media WS consume error call=%s: %r", call_uuid, e)
    finally:
        _active_streams.pop(call_uuid, None)
        duration_ms = int((total_bytes / _BYTES_PER_SAMPLE) / max(sample_rate, 1) * 1000)
        stats = {"frames": frame_count, "bytes": total_bytes, "duration_ms": duration_ms}
        try:
            await hook.on_stop(call_uuid, stats)
        except Exception:  # noqa: BLE001
            logger.debug("STT on_stop error call=%s", call_uuid, exc_info=True)

    return stats
