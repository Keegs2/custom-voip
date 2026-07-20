"""Audio transport + light DSP for the in-boundary AI voice-agent runtime.

This module is the wire-level glue between FreeSWITCH ``mod_audio_stream`` and the
AI orchestrator (:mod:`services.ai_agent`). It is intentionally dependency-free
(stdlib only: ``array``/``wave``/``base64``) so it imports cheaply and runs
anywhere the API runs — nothing here forces data out of the VPC.

mod_audio_stream WIRE CONTRACT (confirmed against amigniter/mod_audio_stream)
---------------------------------------------------------------------------
* UPLINK  (FreeSWITCH → API): **binary** WebSocket frames of raw **L16 PCM**,
  mono, little-endian, at the sample rate passed to ``uuid_audio_stream``
  (``STREAM_SAMPLE_RATE`` in api_voice.lua — default **8000**). Older module
  builds could base64 this; v1.0.3+ sends raw binary. We accept binary frames.
* DOWNLINK (API → FreeSWITCH, played to the caller): a **text** JSON message::

      {"type":"streamAudio",
       "data":{"audioDataType":"raw","sampleRate":8000,"audioData":"<base64>"}}

  ``audioDataType`` may be ``raw|wav|mp3|ogg``; we send ``raw`` L16 at 8000 Hz.
* BARGE-IN: the module does **not** document a server→module "flush playback"
  message, so interruption is handled SENDER-SIDE (pace the downlink so only a
  shallow buffer is ever in flight, then stop sending — see ai_agent). An
  OPTIONAL clear message (``AI_AUDIO_CLEAR_MSG``, e.g. ``{"type":"killAudio"}``
  for forks that support it) can be sent additionally; default is unset.

All numbers here are for L16 (16-bit signed) mono PCM.
"""
from __future__ import annotations

import io
import os
import wave
import base64
import array
from dataclasses import dataclass, field
from typing import Optional

import orjson

# mod_audio_stream downlink message contract (centralized so a fork swap is 1 line).
STREAM_AUDIO_TYPE = "streamAudio"
STREAM_AUDIO_DATATYPE_RAW = "raw"

BYTES_PER_SAMPLE = 2  # L16


def frame_ms(pcm: bytes, sample_rate: int) -> float:
    """Duration in milliseconds of an L16 mono PCM ``pcm`` buffer."""
    if sample_rate <= 0:
        return 0.0
    samples = len(pcm) // BYTES_PER_SAMPLE
    return (samples / sample_rate) * 1000.0


def pcm16_rms(pcm: bytes) -> float:
    """Root-mean-square amplitude of an L16 mono buffer (0..32767).

    Pure-Python (``array``) so there is no ``audioop`` dependency (removed in
    Python 3.13). Fast enough for voice frames (a 100 ms 8 kHz frame is 800
    samples).
    """
    if not pcm:
        return 0.0
    # Truncate a stray odd byte so array('h') never raises.
    if len(pcm) % BYTES_PER_SAMPLE:
        pcm = pcm[: len(pcm) - (len(pcm) % BYTES_PER_SAMPLE)]
    if not pcm:
        return 0.0
    samples = array.array("h")
    samples.frombytes(pcm)
    acc = 0
    for s in samples:
        acc += s * s
    return (acc / len(samples)) ** 0.5


def resample_pcm16(pcm: bytes, from_rate: int, to_rate: int) -> bytes:
    """Resample L16 mono PCM by linear interpolation (no external deps).

    Good enough for narrowband speech transport (8 kHz ↔ 16/22.05/24 kHz). Swap
    for a polyphase resampler (soxr) later if fidelity matters; the call sites do
    not change.
    """
    if from_rate == to_rate or not pcm:
        return pcm
    if len(pcm) % BYTES_PER_SAMPLE:
        pcm = pcm[: len(pcm) - (len(pcm) % BYTES_PER_SAMPLE)]
    src = array.array("h")
    src.frombytes(pcm)
    n_src = len(src)
    if n_src == 0:
        return b""
    n_dst = max(1, int(n_src * to_rate / from_rate))
    dst = array.array("h", bytes(2 * n_dst))
    ratio = (n_src - 1) / (n_dst - 1) if n_dst > 1 else 0.0
    for i in range(n_dst):
        pos = i * ratio
        i0 = int(pos)
        i1 = min(i0 + 1, n_src - 1)
        frac = pos - i0
        val = src[i0] + (src[i1] - src[i0]) * frac
        # Clamp into int16 range.
        if val > 32767:
            val = 32767
        elif val < -32768:
            val = -32768
        dst[i] = int(val)
    return dst.tobytes()


def pcm16_to_wav(pcm: bytes, sample_rate: int) -> bytes:
    """Wrap raw L16 mono PCM in a minimal WAV container (for HTTP STT uploads)."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(BYTES_PER_SAMPLE)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm)
    return buf.getvalue()


def wav_to_pcm16(data: bytes) -> tuple[bytes, int]:
    """Extract raw L16 mono PCM + sample rate from a WAV byte string.

    Downmixes stereo to mono and narrows >16-bit samples defensively so a TTS
    engine that returns an unexpected WAV shape still plays.
    """
    with wave.open(io.BytesIO(data), "rb") as wf:
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        rate = wf.getframerate()
        frames = wf.readframes(wf.getnframes())
    if sampwidth != BYTES_PER_SAMPLE:
        # Only 16-bit is handled without audioop; anything else is passed through
        # as-is with its declared rate (best effort).
        return frames, rate
    if n_channels == 2:
        stereo = array.array("h")
        stereo.frombytes(frames)
        mono = array.array("h", bytes(len(frames) // 2))
        for i in range(len(mono)):
            mono[i] = (stereo[2 * i] + stereo[2 * i + 1]) // 2
        frames = mono.tobytes()
    return frames, rate


def encode_stream_audio(pcm: bytes, sample_rate: int) -> bytes:
    """Build the mod_audio_stream ``streamAudio`` downlink text frame (as bytes).

    Returns a UTF-8 JSON payload suitable for ``websocket.send_text`` (decode) or
    ``send_bytes``; the orchestrator sends it as text.
    """
    return orjson.dumps(
        {
            "type": STREAM_AUDIO_TYPE,
            "data": {
                "audioDataType": STREAM_AUDIO_DATATYPE_RAW,
                "sampleRate": sample_rate,
                "audioData": base64.b64encode(pcm).decode("ascii"),
            },
        }
    )


def iter_pcm_chunks(pcm: bytes, chunk_ms: int, sample_rate: int):
    """Yield ``chunk_ms``-sized L16 slices of ``pcm`` (last slice may be short)."""
    if chunk_ms <= 0:
        yield pcm
        return
    bytes_per_chunk = max(
        BYTES_PER_SAMPLE, int(sample_rate * (chunk_ms / 1000.0)) * BYTES_PER_SAMPLE
    )
    for off in range(0, len(pcm), bytes_per_chunk):
        yield pcm[off : off + bytes_per_chunk]


# ---------------------------------------------------------------------------
# Energy VAD — utterance segmentation + barge-in detection
# ---------------------------------------------------------------------------
# A dependency-free hysteresis voice-activity detector. It emits utterance
# boundaries for the batched (self-hosted Whisper) STT path AND drives barge-in
# (caller starts talking while the agent is speaking). webrtcvad/silero can be
# dropped in behind the same event surface later without touching ai_agent.


@dataclass
class VADConfig:
    sample_rate: int = 8000
    rms_threshold: float = 500.0     # L16 RMS above which a frame is "speech"
    min_speech_ms: float = 200.0     # sustained speech to declare speech-start
    silence_ms: float = 700.0        # trailing silence to declare utterance-end
    preroll_ms: float = 200.0        # audio kept before speech-start (anti-clip)
    max_utterance_ms: float = 20000  # hard cap so a stuck line still segments


# VAD event kinds.
VAD_SPEECH_START = "speech_start"
VAD_SPEECH_END = "speech_end"


@dataclass
class EnergyVAD:
    cfg: VADConfig = field(default_factory=VADConfig)
    _in_speech: bool = False
    _speech_run_ms: float = 0.0
    _silence_run_ms: float = 0.0
    _utterance_ms: float = 0.0
    _utterance: bytearray = field(default_factory=bytearray)
    _preroll: bytearray = field(default_factory=bytearray)

    def reset(self) -> None:
        self._in_speech = False
        self._speech_run_ms = 0.0
        self._silence_run_ms = 0.0
        self._utterance_ms = 0.0
        self._utterance = bytearray()
        self._preroll = bytearray()

    def _push_preroll(self, pcm: bytes) -> None:
        self._preroll.extend(pcm)
        max_bytes = int(
            self.cfg.sample_rate * (self.cfg.preroll_ms / 1000.0)
        ) * BYTES_PER_SAMPLE
        if len(self._preroll) > max_bytes:
            del self._preroll[: len(self._preroll) - max_bytes]

    def process(self, pcm: bytes) -> Optional[str]:
        """Feed one PCM frame. Returns a VAD_* event string, or None.

        On VAD_SPEECH_END, :meth:`take_utterance` returns the buffered audio.
        """
        dur = frame_ms(pcm, self.cfg.sample_rate)
        if dur <= 0:
            return None
        loud = pcm16_rms(pcm) >= self.cfg.rms_threshold

        if not self._in_speech:
            self._push_preroll(pcm)
            if loud:
                self._speech_run_ms += dur
                if self._speech_run_ms >= self.cfg.min_speech_ms:
                    # Speech confirmed — seed the utterance with the preroll.
                    self._in_speech = True
                    self._silence_run_ms = 0.0
                    self._utterance = bytearray(self._preroll)
                    self._utterance_ms = frame_ms(
                        bytes(self._preroll), self.cfg.sample_rate
                    )
                    self._preroll = bytearray()
                    return VAD_SPEECH_START
            else:
                self._speech_run_ms = 0.0
            return None

        # In speech: accumulate + watch for trailing silence.
        self._utterance.extend(pcm)
        self._utterance_ms += dur
        if loud:
            self._silence_run_ms = 0.0
        else:
            self._silence_run_ms += dur
        if (
            self._silence_run_ms >= self.cfg.silence_ms
            or self._utterance_ms >= self.cfg.max_utterance_ms
        ):
            self._in_speech = False
            self._speech_run_ms = 0.0
            return VAD_SPEECH_END
        return None

    def take_utterance(self) -> bytes:
        """Return and clear the buffered utterance PCM (call after SPEECH_END)."""
        data = bytes(self._utterance)
        self._utterance = bytearray()
        self._utterance_ms = 0.0
        self._silence_run_ms = 0.0
        return data


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def vad_from_env(sample_rate: int) -> EnergyVAD:
    """Construct an :class:`EnergyVAD` from ``AI_VAD_*`` env tunables."""
    return EnergyVAD(
        VADConfig(
            sample_rate=sample_rate,
            rms_threshold=_env_float("AI_VAD_RMS_THRESHOLD", 500.0),
            min_speech_ms=_env_float("AI_VAD_MIN_SPEECH_MS", 200.0),
            silence_ms=_env_float("AI_VAD_SILENCE_MS", 700.0),
            preroll_ms=_env_float("AI_VAD_PREROLL_MS", 200.0),
            max_utterance_ms=_env_float("AI_VAD_MAX_UTTERANCE_MS", 20000.0),
        )
    )
