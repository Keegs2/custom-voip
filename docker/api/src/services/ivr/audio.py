"""Canonical IVR prompt audio (contract §4).

Every prompt FreeSWITCH plays is ONE format: RIFF/WAVE, ``fmt `` PCM (1),
1 channel, 8000 Hz, 16-bit little-endian, a single ``data`` chunk, and
nothing else (44-byte header). ``sha256`` is computed over those exact bytes
— the content address in ``ivr_prompt_audio`` and the FS cache file name.

``canonicalize`` takes a PCM16 WAV at any common rate, mono or stereo (the
browser recorder/transcoder pipeline sends 8/16 kHz mono; the Piper sidecar
sends 22.05 kHz mono), downmixes and resamples it to 8 kHz, enforces the
length limits and returns the canonical bytes + sha. Anything else is an
``AudioError`` (HTTP 422) with a customer-readable sentence.

Determinism: the resampler is an integer polyphase FIR — Kaiser-windowed sinc
coefficients quantised to Q15 once per (rate) pair, integer multiply-
accumulate, round-half-up shift — so the same input always yields the same
bytes (and sha) on the same build. 8 kHz mono input is passed through
sample-for-sample (only the header is rewritten).
"""
from __future__ import annotations

import hashlib
import struct
from dataclasses import dataclass
from functools import lru_cache
from math import gcd

import numpy as np

from services.ivr import limits

TARGET_RATE = limits.AUDIO_RATE
SOURCE_RATES = (8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000)
WAVE_FORMAT_PCM = 1
WAVE_FORMAT_EXTENSIBLE = 0xFFFE
_PCM_SUBFORMAT = bytes.fromhex("0100000000001000800000aa00389b71")
HEADER_BYTES = 44
_MAX_CHUNKS = 64
#: Taps per output phase scale with the decimation factor; Kaiser beta ~ 80 dB.
_KAISER_BETA = 8.0
_ROLLOFF = 0.90
_Q = 15
_CHUNK = 8192


class AudioError(ValueError):
    """Bad audio -> HTTP 422 with ``detail`` (a short user-facing sentence)."""

    status = 422

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


@dataclass(frozen=True)
class CanonicalAudio:
    wav: bytes
    sha256: str
    duration_ms: int
    bytes: int


@dataclass(frozen=True)
class _Pcm:
    rate: int
    channels: int
    data: bytes


def _parse(data: bytes) -> _Pcm:
    fmt_msg = "Audio must be a 16-bit PCM WAV file."
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise AudioError("Audio must be a WAV file.")
    buf = bytes(data)
    n = len(buf)
    if n < 12 or buf[0:4] != b"RIFF" or buf[8:12] != b"WAVE":
        raise AudioError("Audio must be a WAV file.")
    pos, chunks = 12, 0
    fmt = None
    while pos + 8 <= n:
        chunks += 1
        if chunks > _MAX_CHUNKS:
            raise AudioError("The WAV file is malformed.")
        cid = buf[pos:pos + 4]
        size = struct.unpack_from("<I", buf, pos + 4)[0]
        body = pos + 8
        if cid == b"fmt ":
            if size < 16 or body + size > n:
                raise AudioError("The WAV file is malformed.")
            tag, channels, rate, byte_rate, align, bits = struct.unpack_from("<HHIIHH", buf, body)
            if tag == WAVE_FORMAT_EXTENSIBLE:
                if size < 40 or buf[body + 24:body + 40] != _PCM_SUBFORMAT:
                    raise AudioError(fmt_msg)
                tag = WAVE_FORMAT_PCM
            if tag != WAVE_FORMAT_PCM or bits != 16:
                raise AudioError(fmt_msg)
            if channels not in (1, 2):
                raise AudioError("Audio must be mono or stereo.")
            if rate not in SOURCE_RATES:
                raise AudioError("Audio must be recorded at 8, 16, 22.05, 24, 32, 44.1 or "
                                 "48 kHz.")
            if align != channels * 2 or byte_rate != rate * align:
                raise AudioError("The WAV file is malformed.")
            fmt = (rate, channels)
        elif cid == b"data":
            if fmt is None:
                raise AudioError("The WAV file is malformed.")
            avail = n - body
            if size > avail:
                raise AudioError("The WAV file is incomplete.")
            frame = fmt[1] * 2
            usable = size - (size % frame)
            if usable <= 0:
                raise AudioError("The WAV file has no audio.")
            return _Pcm(fmt[0], fmt[1], buf[body:body + usable])
        pos = body + size + (size & 1)
    raise AudioError("The WAV file has no audio.")


@lru_cache(maxsize=16)
def _filter_bank(up: int, down: int) -> tuple[np.ndarray, int, int]:
    """(Q15 int64 bank [up, taps], taps, delay) for an up/down polyphase FIR."""
    factor = max(up, down)
    taps = 2 * int(np.ceil(8.0 * factor / up))          # per phase
    length = taps * up
    cutoff = _ROLLOFF * 0.5 / factor                   # cycles/sample at rate*up
    t = np.arange(length, dtype=np.float64) - (length - 1) / 2.0
    proto = 2.0 * cutoff * np.sinc(2.0 * cutoff * t) * np.kaiser(length, _KAISER_BETA)
    proto *= up / proto.sum()                           # DC gain = up (zero-stuffing)
    bank = proto.reshape(taps, up).T                    # bank[p, k] = proto[p + k*up]
    q = np.round(np.round(bank, 12) * (1 << _Q)).astype(np.int64)
    return q, taps, (length - 1) // 2


def _resample(x: np.ndarray, rate: int) -> np.ndarray:
    if rate == TARGET_RATE:
        return x.astype(np.int16)
    g = gcd(rate, TARGET_RATE)
    up, down = TARGET_RATE // g, rate // g
    bank, taps, delay = _filter_bank(up, down)
    n_out = (len(x) * up) // down
    pad = taps + 2
    xp = np.concatenate([np.zeros(pad, np.int64), x.astype(np.int64), np.zeros(pad, np.int64)])
    k = np.arange(taps, dtype=np.int64)
    out = np.empty(n_out, dtype=np.int64)
    for start in range(0, n_out, _CHUNK):
        n = np.arange(start, min(start + _CHUNK, n_out), dtype=np.int64)
        pos = n * down + delay
        phase = pos % up
        base = pos // up
        idx = base[:, None] - k[None, :] + pad
        acc = (xp[idx] * bank[phase]).sum(axis=1)
        out[start:start + len(n)] = (acc + (1 << (_Q - 1))) >> _Q
    return np.clip(out, -32768, 32767).astype(np.int16)


def _header(pcm_bytes: int, rate: int = TARGET_RATE) -> bytes:
    return (b"RIFF" + struct.pack("<I", 36 + pcm_bytes) + b"WAVE"
            + b"fmt " + struct.pack("<IHHIIHH", 16, WAVE_FORMAT_PCM, 1, rate, rate * 2, 2, 16)
            + b"data" + struct.pack("<I", pcm_bytes))


def build_wav(pcm: bytes, rate: int = TARGET_RATE) -> bytes:
    """The canonical 44-byte header + ``pcm`` (mono PCM16 LE)."""
    return _header(len(pcm), rate) + pcm


def is_canonical(data: bytes) -> bool:
    """True iff ``data`` is exactly the canonical 8 kHz mono PCM16 layout."""
    n_pcm = len(data) - HEADER_BYTES
    return n_pcm >= 2 and n_pcm % 2 == 0 and bytes(data[:HEADER_BYTES]) == _header(n_pcm)


def duration_ms_of(canonical_bytes: int) -> int:
    """Duration of a canonical WAV of ``canonical_bytes`` total bytes."""
    return ((canonical_bytes - HEADER_BYTES) // 2) * 1000 // TARGET_RATE


def canonicalize(data: bytes) -> CanonicalAudio:
    """Validate, downmix, resample to 8 kHz and re-wrap ``data`` (see module doc)."""
    pcm = _parse(data)
    samples = np.frombuffer(pcm.data, dtype="<i2").astype(np.int32)
    if pcm.channels == 2:
        samples = (samples[0::2] + samples[1::2]) // 2
    # Bound the work BEFORE resampling: > 120 s at the source rate is refused.
    if len(samples) > limits.MAX_PROMPT_SECONDS * pcm.rate + pcm.rate // 100:
        raise AudioError(f"Messages can be at most {limits.MAX_PROMPT_SECONDS} seconds long.")
    out = _resample(samples, pcm.rate)
    max_samples = limits.MAX_PROMPT_SECONDS * TARGET_RATE
    if len(out) > max_samples:
        out = out[:max_samples]
    if len(out) * 1000 // TARGET_RATE < limits.MIN_PROMPT_MS:
        raise AudioError("That recording is too short to use as a message.")
    wav = build_wav(out.astype("<i2").tobytes())
    return CanonicalAudio(wav=wav, sha256=hashlib.sha256(wav).hexdigest(),
                          duration_ms=duration_ms_of(len(wav)), bytes=len(wav))
