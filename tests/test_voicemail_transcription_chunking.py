"""Chunk planner (services/voicemail/transcription/chunking.py, plan §7).

Pure unit tests on synthetic PCM: <= 55 s -> one piece; 305 s of speech-like
noise with quiet gaps -> every piece <= 55 s, contiguous, every cut inside a
gap; FreeSWITCH's silence tail (10 s at energy 150, owner decision O5) is
trimmed to the 500 ms pad and the post-beep pause to the 300 ms pad; all
silent -> speech=False (no API call); a silent piece is marked and not
counted; 16 kHz; an odd byte count; a 1-frame and a sub-frame recording;
determinism; bytes / bytearray / memoryview input without copying.

Run:  JWT_SECRET_KEY=x python3 -m pytest tests/test_voicemail_transcription_chunking.py -q
"""
import os
import random
import re
import struct
import sys
from pathlib import Path

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")

REPO = Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
if str(API_SRC) not in sys.path:
    sys.path.insert(0, str(API_SRC))

from services.voicemail.transcription import chunking as ch  # noqa: E402

RATE = 8000


def tone(ms: int, amplitude: int, *, rate: int = RATE, seed: int = 0) -> bytes:
    """Noise with mean |sample| ~ amplitude / 2 (amplitude 0 = digital silence)."""
    n = rate * ms // 1000
    if amplitude == 0:
        return bytes(2 * n)
    rnd = random.Random(seed)
    return struct.pack(f"<{n}h", *(rnd.randint(-amplitude, amplitude) for _ in range(n)))


def quiet(ms: int, level: int = 150, *, rate: int = RATE) -> bytes:
    """A constant-magnitude signal just below the 200 threshold (FS 'silence')."""
    n = rate * ms // 1000
    return struct.pack(f"<{n}h", *((level if i % 2 else -level) for i in range(n)))


SPEECH = 3000          # mean |x| ~ 1500, far above SILENCE_MEAN_ABS


def ms_of(nbytes: int, rate: int = RATE) -> int:
    return nbytes // 2 * 1000 // rate


def test_short_message_is_one_piece_trimmed_to_the_pads():
    pcm = quiet(2000) + tone(20_000, SPEECH) + quiet(10_000)   # beep gap, speech, FS tail
    plan = ch.plan_chunks(pcm, RATE)
    assert plan.speech and plan.sample_rate == RATE
    [c] = plan.chunks
    assert not c.silent
    assert c.start_ms == 2000 - ch.LEAD_PAD_MS                  # 300 ms before the first voice
    assert c.end_ms == 22_000 + ch.TRAIL_PAD_MS                 # 10 s tail -> 500 ms
    assert (c.byte_start, c.byte_end) == (c.start_ms * 16, c.end_ms * 16)
    assert plan.audio_ms == c.end_ms - c.start_ms
    assert plan.sent == (c,)


def test_pads_are_clamped_to_the_recording():
    pcm = tone(5000, SPEECH)
    [c] = ch.plan_chunks(pcm, RATE).chunks
    assert (c.start_ms, c.end_ms, c.byte_start, c.byte_end) == (0, 5000, 0, len(pcm))


def test_exactly_55_s_is_still_one_piece():
    pcm = tone(55_000, SPEECH)
    plan = ch.plan_chunks(pcm, RATE)
    assert len(plan.chunks) == 1 and plan.audio_ms == 55_000


def test_305_s_with_quiet_gaps_cuts_inside_the_gaps():
    gaps = []                       # (start_ms, end_ms) of each quiet gap
    parts = []
    t = 0
    seed = 1
    # Speech runs of 7-13 s separated by 0.5-1.5 s pauses (like a real message).
    rnd = random.Random(42)
    while t < 305_000:
        run = min(rnd.randint(7_000, 13_000), 305_000 - t)
        parts.append(tone(run, SPEECH, seed=seed))
        seed += 1
        t += run
        if t >= 305_000:
            break
        gap = min(rnd.randint(500, 1_500) // 20 * 20, 305_000 - t)
        parts.append(tone(gap, 60, seed=seed))                 # breath / line noise
        gaps.append((t, t + gap))
        t += gap
    pcm = b"".join(parts)
    plan = ch.plan_chunks(pcm, RATE)
    chunks = plan.chunks
    assert len(chunks) >= 6
    assert chunks[0].start_ms == 0 and chunks[-1].byte_end == len(pcm)
    for a, b in zip(chunks, chunks[1:]):
        assert a.byte_end == b.byte_start and a.end_ms == b.start_ms   # contiguous
    for c in chunks:
        assert c.end_ms - c.start_ms <= ch.MAX_CHUNK_MS
        assert c.byte_start % 2 == 0 and c.byte_end % 2 == 0
        assert not c.silent
    for c in chunks[:-1]:
        assert c.end_ms - c.start_ms >= ch.MIN_CUT_MS
        assert any(g0 <= c.end_ms <= g1 for g0, g1 in gaps), (c.end_ms, "cut outside a gap")
    assert plan.audio_ms == sum(c.end_ms - c.start_ms for c in chunks)


def test_no_pause_at_all_still_cuts_within_the_window():
    pcm = tone(120_000, SPEECH)
    plan = ch.plan_chunks(pcm, RATE)
    assert len(plan.chunks) == 3
    for c in plan.chunks:
        assert c.end_ms - c.start_ms <= ch.MAX_CHUNK_MS
    first = plan.chunks[0]
    assert ch.MIN_CUT_MS <= first.end_ms <= ch.MAX_CHUNK_MS


def test_ties_prefer_the_later_quiet_run():
    # Uniform speech: every candidate run has (almost) the same energy, so a
    # perfectly flat signal must cut at the LATEST allowed position.
    n = RATE * 70  # 70 s
    pcm = struct.pack(f"<{n}h", *((1000 if i % 2 else -1000) for i in range(n)))
    first = ch.plan_chunks(pcm, RATE).chunks[0]
    latest_run = ch.MAX_CHUNK_MS - ch.QUIET_WINDOW_MS
    assert first.end_ms == latest_run + (ch.QUIET_WINDOW_MS // ch.FRAME_MS // 2) * ch.FRAME_MS


def test_all_silent_is_no_speech_and_no_chunks():
    for pcm in (bytes(2 * RATE * 5), quiet(30_000), quiet(30_000, level=199), b""):
        plan = ch.plan_chunks(pcm, RATE)
        assert plan.speech is False and plan.chunks == () and plan.audio_ms == 0
        assert plan.sent == ()


def test_a_silent_piece_is_marked_and_not_sent():
    # Speech, then 50 s of near-silence, then speech: the middle piece has no
    # voiced frame at all.
    pcm = tone(50_000, SPEECH) + quiet(56_000, level=100) + tone(10_000, SPEECH, seed=9)
    plan = ch.plan_chunks(pcm, RATE)
    assert any(c.silent for c in plan.chunks)
    sent = plan.sent
    assert all(not c.silent for c in sent) and len(sent) < len(plan.chunks)
    assert plan.audio_ms == sum(c.end_ms - c.start_ms for c in sent)


def test_16_khz():
    pcm = quiet(1000, rate=16000) + tone(70_000, SPEECH, rate=16000) + quiet(10_000, rate=16000)
    plan = ch.plan_chunks(pcm, 16000)
    assert plan.sample_rate == 16000 and len(plan.chunks) == 2
    first, last = plan.chunks
    assert first.start_ms == 700 and last.end_ms == 71_500
    assert first.byte_start == 700 * 32 and last.byte_end == 71_500 * 32
    assert first.byte_end == last.byte_start and first.byte_end % 2 == 0


def test_odd_byte_count_ignores_the_trailing_byte():
    pcm = tone(3000, SPEECH) + b"\x7f"
    [c] = ch.plan_chunks(pcm, RATE).chunks
    assert c.byte_end == len(pcm) - 1 and c.byte_end % 2 == 0


def test_one_frame_and_sub_frame_recordings():
    one_frame = tone(20, SPEECH)
    [c] = ch.plan_chunks(one_frame, RATE).chunks
    assert (c.start_ms, c.end_ms, c.byte_end) == (0, 20, 320)
    tiny = tone(20, SPEECH)[:50]                                 # 25 samples
    [c] = ch.plan_chunks(tiny, RATE).chunks
    assert (c.byte_start, c.byte_end) == (0, 50) and c.end_ms == 3
    assert ch.plan_chunks(b"\x00", RATE).speech is False


def test_deterministic_and_buffer_types():
    pcm = quiet(500) + tone(80_000, SPEECH, seed=7) + quiet(3000)
    plans = [ch.plan_chunks(buf, RATE) for buf in (pcm, bytearray(pcm), memoryview(pcm),
                                                    memoryview(b"RIFFhead" + pcm)[8:])]
    assert all(p == plans[0] for p in plans)
    assert ch.plan_chunks(pcm, RATE) == plans[0]


@pytest.mark.parametrize("rate", [0, -8000, 8001, 44_123, True, 8000.0, "8000"])
def test_bad_sample_rates(rate):
    with pytest.raises(ValueError):
        ch.plan_chunks(tone(100, SPEECH), rate)


def test_threshold_matches_freeswitch():
    # vm_box.lua M.SILENCE_THRESHOLD — the same 200 the FS `record` app uses.
    lua = (REPO / "docker" / "freeswitch" / "scripts" / "lib" / "vm_box.lua").read_text()
    m = re.search(r"^M\.SILENCE_THRESHOLD\s*=\s*(\d+)", lua, re.M)
    assert m and int(m.group(1)) == 200
    assert ch.SILENCE_MEAN_ABS == 200
    assert ch.plan_chunks(quiet(1000, level=200), RATE).speech is True
    assert ch.plan_chunks(quiet(1000, level=199), RATE).speech is False
