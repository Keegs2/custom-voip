"""Strict RIFF/WAVE validation for voicemail audio (contract §4.3, §4.6, §5).

Pure (no I/O). The API never transcodes (contract §0.6): it accepts exactly
the canonical format the browser (greetings) and FreeSWITCH ``record`` with
``record_sample_rate=8000`` (deposits) produce — PCM s16le, mono, 8000 or
16000 Hz — and rejects everything else:

* not ``RIFF....WAVE``                       -> 415
* malformed chunks / wrong format / no data  -> 422

Chunk walk: ``fmt `` must precede ``data``; any other chunk (``LIST``,
``fact``, ``cue `` ...) is skipped (word-aligned). The duration comes from the
data-chunk size: ``data_bytes * 1000 // byte_rate``.

``lenient_data_size`` (deposits only) mirrors ``vm_box.lua wav_duration_ms``:
a data size of 0 / 0xFFFFFFFF / larger than what is actually present (a
streaming writer that never finalised its header) is clamped to the bytes
present, and a trailing odd byte is dropped — so a recording FreeSWITCH
measured and deposited is never refused for a header nit (a 4xx makes FS
drop the message). Greetings (browser-encoded) are validated strictly.
"""
from __future__ import annotations

import struct
from dataclasses import dataclass

ALLOWED_SAMPLE_RATES = (8000, 16000)
WAVE_FORMAT_PCM = 1
_MAX_CHUNKS = 64
_U32_MAX = 0xFFFFFFFF


class WavError(ValueError):
    """Validation failure. ``status`` is the HTTP status (415 or 422);
    ``detail`` is a short, user-presentable sentence."""

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


@dataclass(frozen=True)
class WavInfo:
    sample_rate: int
    channels: int
    bits_per_sample: int
    data_offset: int
    data_bytes: int
    duration_ms: int


def _u16(buf, off: int) -> int:
    return struct.unpack_from("<H", buf, off)[0]


def _u32(buf, off: int) -> int:
    return struct.unpack_from("<I", buf, off)[0]


def parse_wav(data: bytes | bytearray | memoryview, *, noun: str = "Audio",
              lenient_data_size: bool = False) -> WavInfo:
    """Validate ``data`` as canonical voicemail WAV and return its layout.

    Raises :class:`WavError` (415 / 422). ``noun`` prefixes the messages
    ("Greeting must be ...", "Recording must be ...").
    """
    fmt_msg = f"{noun} must be a mono 8 or 16 kHz 16-bit PCM WAV."
    buf = memoryview(data)
    n = len(buf)
    if n < 12 or bytes(buf[0:4]) != b"RIFF" or bytes(buf[8:12]) != b"WAVE":
        raise WavError(415, f"{noun} must be a WAV file.")

    pos = 12
    fmt_seen = False
    rate = channels = bits = byte_rate = block_align = 0
    chunks = 0
    while True:
        if pos + 8 > n:
            raise WavError(422, f"{noun} has no audio data.")
        chunks += 1
        if chunks > _MAX_CHUNKS:
            raise WavError(422, f"{noun} is not a valid WAV file.")
        cid = bytes(buf[pos:pos + 4])
        size = _u32(buf, pos + 4)
        body = pos + 8

        if cid == b"fmt ":
            if fmt_seen or size < 16 or body + size > n:
                raise WavError(422, f"{noun} is not a valid WAV file.")
            fmt_tag = _u16(buf, body)
            channels = _u16(buf, body + 2)
            rate = _u32(buf, body + 4)
            byte_rate = _u32(buf, body + 8)
            block_align = _u16(buf, body + 12)
            bits = _u16(buf, body + 14)
            if (fmt_tag != WAVE_FORMAT_PCM or channels != 1 or bits != 16
                    or rate not in ALLOWED_SAMPLE_RATES or block_align != 2
                    or byte_rate != rate * 2):
                raise WavError(422, fmt_msg)
            fmt_seen = True
        elif cid == b"data":
            if not fmt_seen:
                raise WavError(422, f"{noun} is not a valid WAV file.")
            avail = n - body
            if size > avail or size == 0 or size == _U32_MAX:
                if not lenient_data_size:
                    raise WavError(422, f"{noun} is incomplete or damaged.")
                size = avail
            if size % block_align:
                if not lenient_data_size:
                    raise WavError(422, f"{noun} is incomplete or damaged.")
                size -= size % block_align
            if size <= 0:
                raise WavError(422, f"{noun} contains no audio.")
            return WavInfo(sample_rate=rate, channels=channels, bits_per_sample=bits,
                           data_offset=body, data_bytes=size,
                           duration_ms=(size * 1000) // byte_rate)
        else:
            if body + size > n:
                raise WavError(422, f"{noun} is not a valid WAV file.")
        pos = body + size + (size & 1)


def build_wav(pcm: bytes, sample_rate: int = 8000) -> bytes:
    """Canonical mono s16le WAV around ``pcm`` (tests/tools)."""
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVE"
    fmt = b"fmt " + struct.pack("<IHHIIHH", 16, WAVE_FORMAT_PCM, 1, sample_rate,
                                sample_rate * 2, 2, 16)
    return header + fmt + b"data" + struct.pack("<I", len(pcm)) + pcm
