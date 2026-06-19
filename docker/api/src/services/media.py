"""Media-plane WebSocket consumer (Phase 6).

Pulls L16 PCM frames off a WebSocket fed by FreeSWITCH ``mod_audio_stream``,
tracks frame/byte counts, estimates duration, and drives a pluggable STT hook
(:mod:`services.stt`). The loop is extracted from the FastAPI endpoint so it can
be unit-tested against a synthetic WebSocket without booting the whole app — the
live FS→API fork is verified in prod (on Docker Desktop, host-net FS cannot reach
the bridged API container, the same isolation noted for the ESL consumer).
"""
import logging
from typing import Optional

from services.stt import STTHook, get_stt_hook

logger = logging.getLogger(__name__)

# mod_audio_stream defaults to 16-bit (2 bytes/sample) mono PCM.
_BYTES_PER_SAMPLE = 2


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
            await hook.on_audio(call_uuid, data)
    except Exception as e:  # noqa: BLE001
        # WebSocketDisconnect (starlette) ends the stream cleanly; anything else
        # is logged but still falls through to on_stop so stats are emitted.
        if e.__class__.__name__ != "WebSocketDisconnect":
            logger.warning("Media WS consume error call=%s: %r", call_uuid, e)
    finally:
        duration_ms = int((total_bytes / _BYTES_PER_SAMPLE) / max(sample_rate, 1) * 1000)
        stats = {"frames": frame_count, "bytes": total_bytes, "duration_ms": duration_ms}
        try:
            await hook.on_stop(call_uuid, stats)
        except Exception:  # noqa: BLE001
            logger.debug("STT on_stop error call=%s", call_uuid, exc_info=True)

    return stats
