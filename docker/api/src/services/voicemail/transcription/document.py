"""The transcript document — the plaintext that ``seal_transcript`` encrypts.

Contract: docs/VOICEMAIL_TRANSCRIPTION_PLAN.md §5. Compact UTF-8 JSON:

    {"v":1,"language":"en-US","model":"telephony",
     "text":"Hi, this is Dana from Granite. Please call me back.",
     "segments":[{"start_ms":300,"end_ms":5120,"text":"Hi, this is Dana from Granite.",
                  "confidence":0.94}, ...]}

* ``text`` is the segment texts joined with single spaces (Google returns them
  punctuated and capitalised). Segment offsets are on the ORIGINAL recording's
  timeline (chunk start + result offset).
* ``confidence`` is per utterance (0..1, rounded to 4 dp) or null (``chirp_3``,
  or a 0 from the provider, which means "not reported").
* Caps: ``text`` <= 32,000 chars, <= 400 segments, encoded <=
  MAX_TRANSCRIPT_PLAINTEXT bytes. :func:`encode` truncates segments first,
  then text, and logs a WARNING with COUNTS only. A 305 s message is < 10 KB in
  practice.

Plaintext lives only in memory (decision D8): nothing here touches the disk,
and no log line or exception message ever contains transcript text.
"""
from __future__ import annotations

import json
import logging
import math
import re
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

from ..crypto import MAX_TRANSCRIPT_PLAINTEXT

logger = logging.getLogger(__name__)

DOC_VERSION = 1
MAX_TEXT_CHARS = 32_000
MAX_SEGMENTS = 400
#: Encoded document ceiling (bytes) — the crypto layer's plaintext ceiling.
MAX_DOC_BYTES = MAX_TRANSCRIPT_PLAINTEXT
#: Segment offsets must fit the INT columns / JS numbers comfortably.
MAX_OFFSET_MS = 2**31 - 1
SNIPPET_LIMIT = 140
ELLIPSIS = "…"
CONFIDENCE_DP = 4

# Same shape as the DB CHECKs (voicemail_transcripts.language / model column).
_LANGUAGE_RE = re.compile(r"[a-z]{2,3}-[A-Z]{2}", re.ASCII)
_MODEL_RE = re.compile(r"[a-z0-9_]{1,32}", re.ASCII)
#: Trailing characters dropped before the snippet ellipsis.
_SNIPPET_TRAIL = " ,;:.-–—"


@dataclass(frozen=True)
class Segment:
    """One recognised utterance."""

    start_ms: int
    end_ms: int
    text: str
    confidence: float | None


@dataclass(frozen=True)
class TranscriptDoc:
    """A whole transcript (what gets sealed)."""

    language: str
    model: str
    text: str
    segments: tuple[Segment, ...]


# ---------------------------------------------------------------------------
# Building
# ---------------------------------------------------------------------------
def join_text(segments: Iterable[Any]) -> str:
    """The segment texts (stripped, empties skipped) joined with single spaces."""
    return " ".join(t for t in (str(s.text).strip() for s in segments) if t)


def from_segments(*, language: str, model: str, segments: Iterable[Segment]) -> TranscriptDoc:
    """A document whose ``text`` is derived from ``segments`` (empty segments
    dropped, texts stripped). ``text == ""`` means "no speech recognised" —
    the worker stores that as status ``empty`` and seals nothing."""
    kept = tuple(
        Segment(start_ms=s.start_ms, end_ms=s.end_ms, text=s.text.strip(),
                confidence=s.confidence)
        for s in segments if isinstance(s.text, str) and s.text.strip())
    return TranscriptDoc(language=language, model=model, text=join_text(kept), segments=kept)


# ---------------------------------------------------------------------------
# Validation (shared by encode and decode; messages never carry content)
# ---------------------------------------------------------------------------
def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _check_language_model(language: Any, model: Any) -> None:
    if not isinstance(language, str) or not _LANGUAGE_RE.fullmatch(language):
        raise ValueError("transcript language is malformed")
    if not isinstance(model, str) or not _MODEL_RE.fullmatch(model):
        raise ValueError("transcript model is malformed")


def _check_offsets(i: int, start_ms: Any, end_ms: Any) -> None:
    if not _is_int(start_ms) or not _is_int(end_ms):
        raise ValueError(f"transcript segment {i} offsets are not integers")
    if not 0 <= start_ms <= end_ms <= MAX_OFFSET_MS:
        raise ValueError(f"transcript segment {i} offsets are out of range")


def _check_confidence(i: int, confidence: Any) -> float | None:
    if confidence is None:
        return None
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
        raise ValueError(f"transcript segment {i} confidence is not a number")
    value = float(confidence)
    if not math.isfinite(value) or not 0.0 <= value <= 1.0:
        raise ValueError(f"transcript segment {i} confidence is out of range")
    return value


def _validate(doc: TranscriptDoc) -> None:
    if not isinstance(doc, TranscriptDoc):
        raise ValueError("expected a TranscriptDoc")
    _check_language_model(doc.language, doc.model)
    if not isinstance(doc.text, str):
        raise ValueError("transcript text is not a string")
    if not isinstance(doc.segments, (tuple, list)):
        raise ValueError("transcript segments must be a tuple")
    for i, seg in enumerate(doc.segments):
        if not isinstance(seg, Segment):
            raise ValueError(f"transcript segment {i} is not a Segment")
        _check_offsets(i, seg.start_ms, seg.end_ms)
        if not isinstance(seg.text, str):
            raise ValueError(f"transcript segment {i} text is not a string")
        _check_confidence(i, seg.confidence)


# ---------------------------------------------------------------------------
# Encode / decode
# ---------------------------------------------------------------------------
def _dump(language: str, model: str, text: str, segments: Sequence[Segment]) -> bytes:
    obj = {
        "v": DOC_VERSION,
        "language": language,
        "model": model,
        "text": text,
        "segments": [
            {"start_ms": s.start_ms, "end_ms": s.end_ms, "text": s.text,
             "confidence": None if s.confidence is None else round(float(s.confidence),
                                                                    CONFIDENCE_DP)}
            for s in segments],
    }
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"),
                      allow_nan=False).encode("utf-8")


def _largest_fit(lo: int, hi: int, fits) -> int:
    """Largest n in [lo, hi] with fits(n), given fits(lo) and monotonicity."""
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if fits(mid):
            lo = mid
        else:
            hi = mid - 1
    return lo


def encode(doc: TranscriptDoc) -> bytes:
    """Compact UTF-8 JSON, at most MAX_DOC_BYTES. Over a cap: keep the first
    MAX_SEGMENTS segments and MAX_TEXT_CHARS characters, then drop trailing
    segments and finally trailing text until it fits (WARNING, counts only).
    Raises ValueError for a malformed document (a programming error)."""
    _validate(doc)
    segments = tuple(doc.segments)
    text = doc.text
    in_segments, in_chars = len(segments), len(text)

    segments = segments[:MAX_SEGMENTS]
    text = text[:MAX_TEXT_CHARS]
    data = _dump(doc.language, doc.model, text, segments)
    if len(data) > MAX_DOC_BYTES:
        keep = _largest_fit(0, len(segments), lambda n: len(
            _dump(doc.language, doc.model, text, segments[:n])) <= MAX_DOC_BYTES)
        segments = segments[:keep]
        data = _dump(doc.language, doc.model, text, segments)
    if len(data) > MAX_DOC_BYTES:
        chars = _largest_fit(0, len(text), lambda n: len(
            _dump(doc.language, doc.model, text[:n], segments)) <= MAX_DOC_BYTES)
        text = text[:chars]
        data = _dump(doc.language, doc.model, text, segments)
    if len(segments) != in_segments or len(text) != in_chars:
        logger.warning("voicemail transcription: transcript truncated to fit "
                       "(segments %d -> %d, chars %d -> %d, bytes %d)",
                       in_segments, len(segments), in_chars, len(text), len(data))
    return data


def _no_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise ValueError("transcript document has a duplicate key")
        out[key] = value
    return out


def _reject_constant(_name: str) -> Any:
    raise ValueError("transcript document contains NaN or Infinity")


_INVALID = object()


def _parse(data: bytes | bytearray | memoryview) -> Any:
    """json.loads, or _INVALID (UnicodeDecodeError / JSONDecodeError and our
    hooks' errors are all ValueErrors; deep nesting is a RecursionError)."""
    try:
        return json.loads(bytes(data).decode("utf-8"), object_pairs_hook=_no_duplicate_keys,
                          parse_constant=_reject_constant)
    except (ValueError, RecursionError):
        return _INVALID


def decode(data: bytes | bytearray | memoryview) -> TranscriptDoc:
    """Parse and strictly validate a decrypted document. Raises ValueError on
    anything malformed (the caller treats it as an integrity failure: 500,
    never shown). Unknown keys are ignored (forward-compatible additions);
    an unknown ``v`` is not."""
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise ValueError("transcript document must be bytes")
    if not 0 < len(data) <= MAX_DOC_BYTES:
        raise ValueError("transcript document has a bad size")
    obj = _parse(data)
    if obj is _INVALID:
        # Raised OUTSIDE the except block: UnicodeDecodeError.object and
        # JSONDecodeError.doc hold the whole document, so not even
        # __context__ may reference them.
        raise ValueError("transcript document is not valid UTF-8 JSON")
    if not isinstance(obj, dict):
        raise ValueError("transcript document is not an object")
    version = obj.get("v")
    if not _is_int(version) or version != DOC_VERSION:
        raise ValueError("transcript document has an unsupported version")
    language, model, text = obj.get("language"), obj.get("model"), obj.get("text")
    _check_language_model(language, model)
    if not isinstance(text, str) or len(text) > MAX_TEXT_CHARS:
        raise ValueError("transcript text is malformed")
    raw_segments = obj.get("segments")
    if not isinstance(raw_segments, list) or len(raw_segments) > MAX_SEGMENTS:
        raise ValueError("transcript segments are malformed")

    segments: list[Segment] = []
    for i, raw in enumerate(raw_segments):
        if not isinstance(raw, dict):
            raise ValueError(f"transcript segment {i} is not an object")
        start_ms, end_ms, seg_text = raw.get("start_ms"), raw.get("end_ms"), raw.get("text")
        _check_offsets(i, start_ms, end_ms)
        if not isinstance(seg_text, str):
            raise ValueError(f"transcript segment {i} text is not a string")
        segments.append(Segment(start_ms=start_ms, end_ms=end_ms, text=seg_text,
                                confidence=_check_confidence(i, raw.get("confidence"))))
    return TranscriptDoc(language=language, model=model, text=text, segments=tuple(segments))


# ---------------------------------------------------------------------------
# Presentation helpers
# ---------------------------------------------------------------------------
def snippet(text: str, limit: int = SNIPPET_LIMIT) -> str:
    """One-line preview: whitespace collapsed; if longer than ``limit``
    characters, cut at a word boundary and end with "…" (the result, ellipsis
    included, is at most ``limit`` characters). A single word longer than half
    the budget is cut mid-word rather than leaving an almost empty preview."""
    if not isinstance(text, str):
        raise ValueError("text must be a str")
    if not _is_int(limit) or limit < 2:
        raise ValueError("limit must be an int >= 2")
    collapsed = " ".join(text.split())
    if len(collapsed) <= limit:
        return collapsed
    budget = limit - 1
    cut = collapsed[:budget]
    if collapsed[budget] != " ":                 # the cut lands inside a word
        space = cut.rfind(" ")
        if space >= budget // 2:
            cut = cut[:space]
    cut = cut.rstrip(_SNIPPET_TRAIL)
    return (cut or collapsed[:budget]) + ELLIPSIS


def overall_confidence(segments: Iterable[Any]) -> float | None:
    """Duration-weighted mean utterance confidence: sum(c * dur) / sum(dur)
    over segments whose confidence is a number > 0 (None / 0 = not reported),
    rounded to 3 dp; None when no segment qualifies. A zero-length segment
    weighs 1 ms. Works on any objects with ``start_ms``, ``end_ms`` and
    ``confidence`` (Segment, the provider's SttSegment)."""
    weighted = 0.0
    total = 0
    for seg in segments:
        c = seg.confidence
        if c is None or isinstance(c, bool) or not isinstance(c, (int, float)):
            continue
        c = float(c)
        if not math.isfinite(c) or c <= 0.0:
            continue
        weight = max(int(seg.end_ms) - int(seg.start_ms), 1)
        weighted += min(c, 1.0) * weight
        total += weight
    if total == 0:
        return None
    return round(min(max(weighted / total, 0.0), 1.0), 3)
