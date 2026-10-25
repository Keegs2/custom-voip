"""Visual IVR prompt audio (services/ivr/audio.py, contract §4): canonical
8 kHz mono PCM16 WAV, deterministic sha256, limits, 422 on bad input."""
from __future__ import annotations

import hashlib
import os
import struct
import sys
from pathlib import Path

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
REPO = Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
if str(API_SRC) not in sys.path:
    sys.path.insert(0, str(API_SRC))

np = pytest.importorskip("numpy")
from services.ivr import audio  # noqa: E402


def make_wav(rate: int = 8000, seconds: float = 1.0, channels: int = 1, freq: float = 440.0,
             bits: int = 16, fmt_tag: int = 1, extra_chunk: bool = False,
             extensible: bool = False) -> bytes:
    n = int(rate * seconds)
    t = np.arange(n) / rate
    s = (np.sin(2 * np.pi * freq * t) * 12000).astype("<i2")
    if channels == 2:
        s = np.stack([s, (s // 2).astype("<i2")], 1).reshape(-1)
    pcm = s.tobytes()
    align = channels * bits // 8
    if extensible:
        fmt = struct.pack("<HHIIHHHHI", 0xFFFE, channels, rate, rate * align, align, bits,
                          22, bits, 0) + bytes.fromhex("0100000000001000800000aa00389b71")
    else:
        fmt = struct.pack("<HHIIHH", fmt_tag, channels, rate, rate * align, align, bits)
    chunks = b"fmt " + struct.pack("<I", len(fmt)) + fmt
    if extra_chunk:
        chunks += b"LIST" + struct.pack("<I", 5) + b"INFOx" + b"\x00"   # odd size + pad
    chunks += b"data" + struct.pack("<I", len(pcm)) + pcm
    return b"RIFF" + struct.pack("<I", 4 + len(chunks)) + b"WAVE" + chunks


def test_8k_mono_passes_through_sample_for_sample():
    src = make_wav(8000, 1.0, extra_chunk=True)
    c = audio.canonicalize(src)
    assert audio.is_canonical(c.wav)
    assert c.wav[44:] == src[-16000:]
    assert c.bytes == len(c.wav) == 44 + 16000 and c.duration_ms == 1000
    assert c.sha256 == hashlib.sha256(c.wav).hexdigest()


def test_canonical_header_layout():
    c = audio.canonicalize(make_wav(16000, 0.5))
    tag, ch, rate, byte_rate, align, bits = struct.unpack_from("<HHIIHH", c.wav, 20)
    assert c.wav[:4] == b"RIFF" and c.wav[8:16] == b"WAVEfmt " and c.wav[36:40] == b"data"
    assert (tag, ch, rate, byte_rate, align, bits) == (1, 1, 8000, 16000, 2, 16)
    assert struct.unpack_from("<I", c.wav, 4)[0] == len(c.wav) - 8
    assert struct.unpack_from("<I", c.wav, 40)[0] == len(c.wav) - 44


@pytest.mark.parametrize("rate", [11025, 16000, 22050, 24000, 32000, 44100, 48000])
def test_resampling_is_deterministic_and_keeps_the_tone(rate):
    src = make_wav(rate, 2.0)
    a, b = audio.canonicalize(src), audio.canonicalize(src)
    assert a.wav == b.wav and a.sha256 == b.sha256
    assert abs(a.duration_ms - 2000) <= 1
    out = np.frombuffer(a.wav[44:], "<i2").astype(float)
    assert 11000 < np.abs(out[400:-400]).max() <= 12100      # 440 Hz passes


def test_resampler_removes_content_above_4khz():
    out = np.frombuffer(audio.canonicalize(make_wav(22050, 1.0, freq=6000)).wav[44:], "<i2")
    assert np.abs(out[200:-200].astype(int)).max() < 50


def test_stereo_and_extensible_are_accepted():
    c = audio.canonicalize(make_wav(16000, 1.0, channels=2))
    assert audio.is_canonical(c.wav)
    c2 = audio.canonicalize(make_wav(8000, 1.0, extensible=True))
    assert c2.wav[44:] == audio.canonicalize(make_wav(8000, 1.0)).wav[44:]


def test_sha_is_known_for_a_fixed_input():
    """A pinned vector: catches any accidental change to the canonical bytes
    (header layout or resampler) that would re-address every stored prompt."""
    c16 = audio.canonicalize(make_wav(16000, 0.25, freq=1000))
    assert len(c16.wav) == 44 + 2 * 2000
    assert c16.sha256 == "3333a54395ae640e2a09596258f7a0add483d49b54d27fe3d907ef35739b80aa"
    c22 = audio.canonicalize(make_wav(22050, 0.25, freq=1000))        # Piper's rate
    assert c22.sha256 == "28d5adee03fcfe8b454737fb18bb54b78701947b8aac3aa88d1c45bfd362bd83"
    assert audio.canonicalize(c16.wav).wav == c16.wav       # canonical is a fixed point


@pytest.mark.parametrize("data,needle", [
    (b"not a wav at all", "WAV file"),
    (b"RIFF\x00\x00\x00\x00WAVE", "no audio"),
    (make_wav(8000, 1.0, bits=8), "16-bit PCM"),
    (make_wav(8000, 1.0, fmt_tag=3), "16-bit PCM"),          # IEEE float
    (make_wav(8000, 1.0, fmt_tag=6), "16-bit PCM"),          # A-law
    (make_wav(96000, 0.2), "kHz"),
    (make_wav(8000, 0.05), "too short"),
    (make_wav(8000, 1.0)[:-2000][:40] + b"\xff\xff\x00\x00", "incomplete"),
])
def test_rejects_bad_input_with_422(data, needle):
    with pytest.raises(audio.AudioError) as exc:
        audio.canonicalize(data)
    assert exc.value.status == 422
    assert needle in exc.value.detail


def test_length_limit_120s():
    ok = audio.canonicalize(make_wav(8000, 120.0))
    assert ok.duration_ms == 120000 and ok.bytes == 1_920_044
    with pytest.raises(audio.AudioError, match="at most 120 seconds"):
        audio.canonicalize(make_wav(8000, 121.0))
    with pytest.raises(audio.AudioError, match="at most 120 seconds"):
        audio.canonicalize(make_wav(48000, 121.0))


def test_duration_of_bytes():
    assert audio.duration_ms_of(44 + 16000) == 1000
    assert audio.duration_ms_of(1_920_044) == 120000
