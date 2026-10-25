"""Internal Piper TTS sidecar (contract docs/IVR_INTERFACES.md §8.1).

Stdlib HTTP server (no web framework) on services-network only — no
published port, no auth (the API is its only client). Endpoints:

  POST /synthesize  {"text": str (1..1000 chars), "voice": "<id>"}
                    -> 200 audio/wav (the voice's native rate, 16-bit mono;
                       the API resamples to 8 kHz), 400 bad request,
                       503 busy / not ready
  GET  /voices      -> [{id, label, gender, license, version}]
  GET  /health      -> {"status": "ok", "voices": n}

Voices are loaded once at start from /voices (baked into the image, sha256-
verified at build by fetch_voices.py); nothing is downloaded at run time.
Text is never logged (only its length). Concurrency is bounded by
TTS_CONCURRENCY (default 2); a request that can't get a slot within
TTS_QUEUE_WAIT_S (default 10) is answered 503 so the API can retry.
"""
from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import re
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import metadata
from pathlib import Path

from piper import PiperVoice

LOG = logging.getLogger("tts")
VOICE_DIR = Path(os.getenv("TTS_VOICE_DIR", "/voices"))
MANIFEST = Path(os.getenv("TTS_MANIFEST", "/app/voices.json"))
PORT = int(os.getenv("TTS_PORT", "5000"))
MAX_TEXT = 1000
MAX_BODY = 16 * 1024
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _int_env(name: str, default: int, lo: int, hi: int) -> int:
    try:
        return min(max(int(os.getenv(name, str(default))), lo), hi)
    except ValueError:
        return default


SLOTS = threading.BoundedSemaphore(_int_env("TTS_CONCURRENCY", 2, 1, 8))
QUEUE_WAIT_S = _int_env("TTS_QUEUE_WAIT_S", 10, 1, 60)
ENGINE = f"piper-tts=={metadata.version('piper-tts')}"


class Voices:
    def __init__(self) -> None:
        self.models: dict[str, PiperVoice] = {}
        self.public: list[dict] = []

    def load(self) -> None:
        spec = json.loads(MANIFEST.read_text())
        for v in spec["voices"]:
            onnx = VOICE_DIR / f"{v['id']}.onnx"
            self.models[v["id"]] = PiperVoice.load(str(onnx), config_path=f"{onnx}.json",
                                                   use_cuda=False)
            self.public.append({"id": v["id"], "label": v["label"], "gender": v["gender"],
                                "license": v["license"],
                                # engine + model hash: the API's render-cache key part
                                "version": f"{ENGINE}/{v['onnx_sha256'][:16]}"})
            LOG.info("loaded voice %s", v["id"])


VOICES = Voices()


def synthesize(text: str, voice: str) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        VOICES.models[voice].synthesize_wav(text, wav)
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    server_version = "crag-tts/1"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:  # path + status only, never bodies
        LOG.info("%s %s", self.address_string(), fmt % args)

    def _send(self, status: int, body: bytes, ctype: str = "application/json") -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, obj) -> None:
        self._send(status, json.dumps(obj).encode())

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/voices":
            self._json(200, VOICES.public)
        elif self.path == "/health":
            ok = bool(VOICES.models)
            self._json(200 if ok else 503, {"status": "ok" if ok else "loading",
                                            "voices": len(VOICES.models)})
        else:
            self._json(404, {"detail": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/synthesize":
            self._json(404, {"detail": "not found"})
            return
        length = self.headers.get("Content-Length")
        if length is None or not length.isdigit() or int(length) > MAX_BODY:
            self._json(400, {"detail": "body required (<= 16 KB)"})
            return
        try:
            body = json.loads(self.rfile.read(int(length)) or b"{}")
        except ValueError:
            self._json(400, {"detail": "invalid JSON"})
            return
        text, voice = (body.get("text"), body.get("voice")) if isinstance(body, dict) \
            else (None, None)
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT \
                or _CONTROL.search(text):
            self._json(400, {"detail": f"text must be 1-{MAX_TEXT} printable characters"})
            return
        if not isinstance(voice, str) or voice not in VOICES.models:
            self._json(400, {"detail": "unknown voice"})
            return
        if not SLOTS.acquire(timeout=QUEUE_WAIT_S):
            self._json(503, {"detail": "busy"})
            return
        try:
            wav = synthesize(text.strip(), voice)
        except Exception as exc:  # noqa: BLE001
            LOG.error("synthesis failed (voice=%s, %d chars): %s", voice, len(text),
                      type(exc).__name__)
            self._json(503, {"detail": "synthesis failed"})
            return
        finally:
            SLOTS.release()
        LOG.info("synthesized voice=%s chars=%d bytes=%d sha=%s", voice, len(text), len(wav),
                 hashlib.sha256(wav).hexdigest()[:12])
        self._send(200, wav, "audio/wav")


def main() -> None:
    logging.basicConfig(level=logging.INFO, stream=sys.stdout,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    VOICES.load()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    LOG.info("tts listening on :%d with %d voices (%s)", PORT, len(VOICES.models), ENGINE)
    server.serve_forever()


if __name__ == "__main__":
    main()
