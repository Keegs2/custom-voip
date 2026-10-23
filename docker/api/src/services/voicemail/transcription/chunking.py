"""Chunk planner: where to cut a recording into <= 55 s Recognize pieces.

Contract: docs/VOICEMAIL_TRANSCRIPTION_PLAN.md §7. Pure — no I/O, no logging
of audio, no copies of the PCM beyond what reading it needs (a zero-copy
``memoryview.cast`` on little-endian hosts). Run it with ``asyncio.to_thread``:
300 s of 8 kHz audio is ~2.4 M samples, roughly 0.1 s of CPU.

Google's synchronous ``Recognize`` takes <= 1 min (and <= 10 MB) of audio per
request, so a 300 s voicemail goes out as ~6 pieces. The planner:

1. Frame energy = mean |sample| per 20 ms frame (s16le mono PCM).
2. A frame is VOICED when its energy >= ``SILENCE_MEAN_ABS`` (200 — the same
   threshold as FreeSWITCH's ``record`` silence detection in vm_box.lua). No
   voiced frame -> ``speech=False``: the job ends ``empty`` with NO API call.
3. The sent window is [first voiced - 300 ms, last voiced + 500 ms], clamped
   to the recording. That trims the pause after the beep and FreeSWITCH's
   trailing silence (the 10 s silence stop, owner decision O5 — by
   construction it is below the threshold), so neither is billed.
4. While more than 55 s remain: within [cursor + 40 s, cursor + 55 s - 300 ms]
   find the quietest 300 ms run (15 frames; ties -> the LATER run) and cut at
   its centre frame boundary — never mid-word if there is any pause.
5. The last piece is <= 55 s (it may be short).
6. A piece whose every frame is below the threshold is ``silent`` and is not
   sent.

Offsets are on the ORIGINAL recording's timeline (``Chunk.start_ms`` + a
result's offset = position in the message), ready for click-to-seek.
"""
from __future__ import annotations

import sys
from array import array
from dataclasses import dataclass

FRAME_MS = 20
#: = vm_box.lua M.SILENCE_THRESHOLD (FreeSWITCH ``record`` energy threshold).
SILENCE_MEAN_ABS = 200
#: < Google's 60 s synchronous limit.
MAX_CHUNK_MS = 55_000
#: Cut window [MIN_CUT_MS, MAX_CHUNK_MS - QUIET_WINDOW_MS] from the piece start.
MIN_CUT_MS = 40_000
QUIET_WINDOW_MS = 300
LEAD_PAD_MS = 300
TRAIL_PAD_MS = 500

_QUIET_FRAMES = QUIET_WINDOW_MS // FRAME_MS          # 15
_MAX_FRAMES = MAX_CHUNK_MS // FRAME_MS               # 2750
_MIN_CUT_FRAMES = MIN_CUT_MS // FRAME_MS             # 2000
_LEAD_FRAMES = LEAD_PAD_MS // FRAME_MS               # 15
_TRAIL_FRAMES = TRAIL_PAD_MS // FRAME_MS             # 25


@dataclass(frozen=True)
class Chunk:
    start_ms: int           # on the original recording's timeline
    end_ms: int
    byte_start: int         # into the PCM data (even, sample-aligned)
    byte_end: int
    silent: bool            # every frame below SILENCE_MEAN_ABS -> not sent


@dataclass(frozen=True)
class ChunkPlan:
    sample_rate: int
    chunks: tuple[Chunk, ...]
    speech: bool            # False -> 'empty' with no API call
    audio_ms: int           # sum of non-silent chunk durations (what is sent)

    @property
    def sent(self) -> tuple[Chunk, ...]:
        """The pieces that go to the provider."""
        return tuple(c for c in self.chunks if not c.silent)


def _samples(pcm: bytes | bytearray | memoryview):
    """Signed 16-bit little-endian samples, read without copying where the
    host allows it (a trailing odd byte is ignored)."""
    view = memoryview(pcm)
    if view.ndim != 1 or view.itemsize != 1:
        view = view.cast("B")
    usable = len(view) - (len(view) % 2)
    view = view[:usable]
    if sys.byteorder == "little":
        return view.cast("h")
    samples = array("h")               # big-endian host: copy + byteswap
    samples.frombytes(view)
    samples.byteswap()
    return samples


def _frame_energies(samples, spf: int) -> list[float]:
    n = len(samples)
    out = []
    for start in range(0, n, spf):
        frame = samples[start:start + spf]
        out.append(sum(map(abs, frame)) / len(frame))
    return out


def plan_chunks(pcm: bytes | bytearray | memoryview, sample_rate: int) -> ChunkPlan:
    """Plan the pieces of one recording (s16le mono PCM, no WAV header).
    Deterministic. Raises ValueError for a sample rate that does not divide
    into 20 ms frames."""
    if (isinstance(sample_rate, bool) or not isinstance(sample_rate, int) or sample_rate <= 0
            or (sample_rate * FRAME_MS) % 1000):
        raise ValueError("sample_rate must be a positive multiple of 50 Hz")
    spf = sample_rate * FRAME_MS // 1000                 # samples per frame
    samples = _samples(pcm)
    n = len(samples)
    energies = _frame_energies(samples, spf)
    voiced = [i for i, e in enumerate(energies) if e >= SILENCE_MEAN_ABS]
    if not voiced:
        return ChunkPlan(sample_rate=sample_rate, chunks=(), speech=False, audio_ms=0)

    nframes = len(energies)
    first = max(0, voiced[0] - _LEAD_FRAMES)
    stop = min(nframes, voiced[-1] + 1 + _TRAIL_FRAMES)  # frame index, exclusive

    # Prefix sums: the energy of any frame run in O(1).
    prefix = [0.0]
    for e in energies:
        prefix.append(prefix[-1] + e)

    bounds: list[tuple[int, int]] = []                   # [frame_start, frame_end)
    cursor = first
    while stop - cursor > _MAX_FRAMES:
        lo = cursor + _MIN_CUT_FRAMES
        hi = cursor + _MAX_FRAMES - _QUIET_FRAMES        # last allowed run start
        best_start, best_energy = lo, None
        for s in range(lo, hi + 1):
            run = prefix[s + _QUIET_FRAMES] - prefix[s]
            if best_energy is None or run <= best_energy:  # '<=': ties -> the later run
                best_start, best_energy = s, run
        cut = best_start + _QUIET_FRAMES // 2            # centre frame boundary
        bounds.append((cursor, cut))
        cursor = cut
    bounds.append((cursor, stop))

    chunks = []
    audio_ms = 0
    for f0, f1 in bounds:
        s0, s1 = f0 * spf, min(f1 * spf, n)
        silent = all(e < SILENCE_MEAN_ABS for e in energies[f0:f1])
        start_ms, end_ms = s0 * 1000 // sample_rate, s1 * 1000 // sample_rate
        chunks.append(Chunk(start_ms=start_ms, end_ms=end_ms, byte_start=s0 * 2,
                            byte_end=s1 * 2, silent=silent))
        if not silent:
            audio_ms += end_ms - start_ms
    return ChunkPlan(sample_rate=sample_rate, chunks=tuple(chunks), speech=True,
                     audio_ms=audio_ms)
