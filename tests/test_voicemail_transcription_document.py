"""The transcript document (services/voicemail/transcription/document.py, plan §5).

Pure unit tests (no DB, no KMS): the exact compact JSON of the plan's example,
round trips (incl. non-ASCII), ``text`` = segment texts joined by single
spaces, the caps (400 segments, 32,000 chars, MAX_TRANSCRIPT_PLAINTEXT bytes —
segments truncated first, then text, WARNING with counts only), strict decode
(every malformed shape -> ValueError, and no exception or log line ever
carries transcript text), snippets and the duration-weighted confidence.

Run:  JWT_SECRET_KEY=x python3 -m pytest tests/test_voicemail_transcription_document.py -q
"""
import json
import logging
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")

REPO = Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
if str(API_SRC) not in sys.path:
    sys.path.insert(0, str(API_SRC))

from services.voicemail import MAX_TRANSCRIPT_PLAINTEXT  # noqa: E402
from services.voicemail.transcription import document as d  # noqa: E402

S1 = d.Segment(start_ms=300, end_ms=5120, text="Hi, this is Dana from Granite.", confidence=0.94)
S2 = d.Segment(start_ms=5120, end_ms=9870,
               text="Please call me back about the outage on Elm Street.", confidence=0.89)
EXAMPLE = (
    '{"v":1,"language":"en-US","model":"telephony",'
    '"text":"Hi, this is Dana from Granite. Please call me back about the outage on Elm Street.",'
    '"segments":[{"start_ms":300,"end_ms":5120,"text":"Hi, this is Dana from Granite.",'
    '"confidence":0.94},{"start_ms":5120,"end_ms":9870,'
    '"text":"Please call me back about the outage on Elm Street.","confidence":0.89}]}'
).encode()
SECRET = "Zebra-Quokka-7731"   # a "spoken" word that must never reach a log or an exception


def _doc(segments=(S1, S2), language="en-US", model="telephony", text=None):
    segments = tuple(segments)
    return d.TranscriptDoc(language=language, model=model,
                           text=d.join_text(segments) if text is None else text,
                           segments=segments)


# ---------------------------------------------------------------------------
# Encode / build
# ---------------------------------------------------------------------------
def test_encode_matches_the_contract_example():
    doc = d.from_segments(language="en-US", model="telephony", segments=[S1, S2])
    assert doc.text == ("Hi, this is Dana from Granite. "
                        "Please call me back about the outage on Elm Street.")
    assert d.encode(doc) == EXAMPLE
    assert d.decode(EXAMPLE) == doc
    assert d.MAX_DOC_BYTES == MAX_TRANSCRIPT_PLAINTEXT == 65_536


def test_from_segments_strips_and_drops_empty_segments():
    segs = [d.Segment(0, 100, "  Hello  ", 0.5), d.Segment(100, 200, "   ", 0.9),
            d.Segment(200, 300, "", None), d.Segment(300, 400, "world.", None)]
    doc = d.from_segments(language="es-US", model="chirp_3", segments=segs)
    assert doc.text == "Hello world."
    assert [s.text for s in doc.segments] == ["Hello", "world."]
    assert isinstance(doc.segments, tuple)
    empty = d.from_segments(language="en-US", model="telephony", segments=[])
    assert empty.text == "" and empty.segments == ()
    assert d.decode(d.encode(empty)) == empty


def test_round_trip_non_ascii_is_raw_utf8():
    seg = d.Segment(0, 2500, "Llámame mañana, s'il vous plaît — merci.", None)
    doc = _doc([seg], language="fr-CA", model="chirp_3")
    data = d.encode(doc)
    assert "mañana".encode() in data and b"\\u" not in data      # compact UTF-8, not \u escapes
    assert b'"confidence":null' in data
    assert d.decode(data) == doc
    assert d.decode(bytearray(data)) == doc and d.decode(memoryview(data)) == doc


def test_confidence_is_rounded_to_four_places():
    seg = d.Segment(0, 1000, "x", 0.9399999976158142)   # a float32 from the provider
    assert b'"confidence":0.94' in d.encode(_doc([seg]))
    seg = d.Segment(0, 1000, "x", 0.123456)
    assert d.decode(d.encode(_doc([seg]))).segments[0].confidence == 0.1235


@pytest.mark.parametrize("doc", [
    _doc(language="en-us"), _doc(language="english"), _doc(model="Telephony"),
    _doc(model=""), _doc([d.Segment(-1, 10, "x", None)]),
    _doc([d.Segment(10, 9, "x", None)]), _doc([d.Segment(True, 9, "x", None)]),
    _doc([d.Segment(0, 1.5, "x", None)]), _doc([d.Segment(0, 2**31, "x", None)]),
    _doc([d.Segment(0, 10, "x", 1.5)]), _doc([d.Segment(0, 10, "x", -0.1)]),
    _doc([d.Segment(0, 10, "x", float("nan"))]), _doc([d.Segment(0, 10, "x", True)]),
    _doc([d.Segment(0, 10, b"x", None)]),
    d.TranscriptDoc(language="en-US", model="telephony", text=5, segments=()),
    d.TranscriptDoc(language="en-US", model="telephony", text="", segments=[("not", "seg")]),
    d.TranscriptDoc(language="en-US", model="telephony", text="", segments=None),
    {"language": "en-US"},
])
def test_encode_rejects_malformed_documents(doc):
    with pytest.raises(ValueError):
        d.encode(doc)


def test_caps_segments_then_text_with_a_counts_only_warning(caplog):
    segs = [d.Segment(i * 10, i * 10 + 10, f"{SECRET} {i}.", 0.9) for i in range(450)]
    doc = _doc(segs)
    with caplog.at_level(logging.WARNING, logger=d.logger.name):
        data = d.encode(doc)
    out = d.decode(data)
    assert len(out.segments) == d.MAX_SEGMENTS
    assert out.segments == tuple(segs[:d.MAX_SEGMENTS]) and out.text == doc.text
    [record] = [r for r in caplog.records if r.name == d.logger.name]
    assert record.levelno == logging.WARNING
    msg = record.getMessage()
    assert "450 -> 400" in msg and SECRET not in msg

    long_text = ("word " * 7000).strip()          # 34,999 chars
    out = d.decode(d.encode(_doc([], text=long_text)))
    assert out.text == long_text[:d.MAX_TEXT_CHARS] and len(out.text) == 32_000


def test_oversized_document_drops_segments_first_then_text(caplog):
    # ~60 KB of segments + ~32 KB of text: over 64 KiB -> segments go first.
    big = "a" * 150
    segs = [d.Segment(i, i + 1, big, None) for i in range(400)]
    doc = _doc(segs, text="b" * 32_000)
    with caplog.at_level(logging.WARNING, logger=d.logger.name):
        data = d.encode(doc)
    assert len(data) <= d.MAX_DOC_BYTES
    out = d.decode(data)
    assert out.text == "b" * 32_000, "text is kept whole while dropping segments suffices"
    assert 0 < len(out.segments) < 400 and out.segments == tuple(segs[:len(out.segments)])
    # The largest prefix that fits: one more segment would not.
    one_more = d._dump("en-US", "telephony", out.text, segs[:len(out.segments) + 1])
    assert len(one_more) > d.MAX_DOC_BYTES

    # 4-byte characters: 32,000 of them is ~128 KB even with no segment ->
    # every segment dropped, then the text is cut to fit.
    emoji = "\U0001F600" * 32_000
    data = d.encode(_doc([d.Segment(0, 1, "x", None)], text=emoji))
    out = d.decode(data)
    assert len(data) <= d.MAX_DOC_BYTES and out.segments == ()
    assert out.text and set(out.text) == {"\U0001F600"}
    assert len(d._dump("en-US", "telephony", emoji[:len(out.text) + 1], ())) > d.MAX_DOC_BYTES
    for r in caplog.records:
        assert big not in r.getMessage() and "\U0001F600" not in r.getMessage()


# ---------------------------------------------------------------------------
# Decode (strict)
# ---------------------------------------------------------------------------
def _j(**overrides) -> bytes:
    obj = json.loads(EXAMPLE)
    for key, value in overrides.items():
        if value is ...:
            obj.pop(key, None)
        else:
            obj[key] = value
    return json.dumps(obj).encode()


def _seg(**overrides) -> bytes:
    seg = {"start_ms": 0, "end_ms": 10, "text": "x", "confidence": 0.5}
    for key, value in overrides.items():
        if value is ...:
            seg.pop(key, None)
        else:
            seg[key] = value
    return _j(segments=[seg])


@pytest.mark.parametrize("data", [
    "not bytes", None, b"", b"\x00" * (MAX_TRANSCRIPT_PLAINTEXT + 1),
    b"\xff\xfe not utf-8", b"{not json", b"[1, 2]", b'"text"', b"null", b"[" * 60_000,
    _j(v=...), _j(v=2), _j(v=True), _j(v="1"), _j(v=1.0),
    _j(language=...), _j(language="en-us"), _j(model=...), _j(model="Fake!"),
    _j(text=...), _j(text=7), _j(text="x" * 32_001),
    _j(segments=...), _j(segments={}), _j(segments=[{}] * 401), _j(segments=["seg"]),
    _seg(start_ms=...), _seg(start_ms=True), _seg(start_ms=1.0), _seg(start_ms=-1),
    _seg(end_ms=...), _seg(start_ms=20), _seg(end_ms=2**31), _seg(text=...), _seg(text=5),
    _seg(confidence="0.5"), _seg(confidence=True), _seg(confidence=1.1),
    _seg(confidence=-0.1),
    EXAMPLE.replace(b'"confidence":0.94', b'"confidence":NaN'),
    EXAMPLE.replace(b'"confidence":0.94', b'"confidence":Infinity'),
    EXAMPLE.replace(b'"model":"telephony"', b'"model":"telephony","model":"chirp_3"'),
])
def test_decode_rejects_malformed_documents(data):
    with pytest.raises(ValueError):
        d.decode(data)


def test_decode_ignores_unknown_keys_and_missing_confidence():
    obj = json.loads(EXAMPLE)
    obj["future_field"] = {"x": 1}
    obj["segments"][0]["words"] = []
    del obj["segments"][1]["confidence"]
    doc = d.decode(json.dumps(obj).encode())
    assert doc.segments[0].confidence == 0.94 and doc.segments[1].confidence is None
    assert doc.text.startswith("Hi, this is Dana")


def test_decode_errors_never_carry_document_content():
    bad_json = ('{"v":1,"language":"en-US","model":"telephony","text":"' + SECRET + '",').encode()
    bad_utf8 = SECRET.encode() + b"\xff"
    bad_version = _j(v=9, text=SECRET)
    for data in (bad_json, bad_utf8, bad_version):
        with pytest.raises(ValueError) as ei:
            d.decode(data)
        exc = ei.value
        assert SECRET not in str(exc)
        assert exc.__cause__ is None and exc.__context__ is None, \
            "no chained exception may hold the document"


# ---------------------------------------------------------------------------
# Snippet
# ---------------------------------------------------------------------------
LONG = ("Hi, this is Dana from Granite. Please call me back about the outage on Elm Street "
        "as soon as you can, my number is on file and I will be at my desk until five.")


def test_snippet_short_text_is_whitespace_collapsed_only():
    assert d.snippet("  Hello\n\tthere   friend ") == "Hello there friend"
    assert d.snippet("") == "" and d.snippet(" \n ") == ""
    exact = "x" * 140
    assert d.snippet(exact) == exact


def test_snippet_cuts_at_a_word_boundary_with_an_ellipsis():
    for limit in (20, 41, 60, 72, 140):
        out = d.snippet(LONG, limit)
        assert len(out) <= limit and out.endswith("…")
        body = out[:-1]
        assert LONG.startswith(body)
        nxt = LONG[len(body)] if len(body) < len(LONG) else " "
        assert nxt in " ,.", (limit, out)      # never ends mid-word
        assert not body.endswith((" ", ","))
    assert d.snippet(LONG, 72) == ("Hi, this is Dana from Granite. Please call me back about "
                                   "the outage on…")
    assert d.snippet("x" * 141) == "x" * 139 + "…"           # one huge word: hard cut
    assert d.snippet("ab " + "c" * 200, 20) == "ab " + "c" * 16 + "…"


@pytest.mark.parametrize("args", [(None,), (b"bytes",), ("text", 1), ("text", 0), ("text", True),
                                  ("text", 2.5)])
def test_snippet_argument_errors(args):
    with pytest.raises(ValueError):
        d.snippet(*args)


# ---------------------------------------------------------------------------
# Overall confidence
# ---------------------------------------------------------------------------
def test_overall_confidence_is_duration_weighted():
    # (0.94 * 4820 + 0.89 * 4750) / 9570 = 0.91518...
    assert d.overall_confidence([S1, S2]) == 0.915
    assert d.overall_confidence([S1]) == 0.94
    # None / 0 / non-numbers do not count; a zero-length segment weighs 1 ms.
    segs = [d.Segment(0, 1000, "a", None), d.Segment(1000, 2000, "b", 0.0),
            d.Segment(2000, 2000, "c", 0.5), d.Segment(2000, 3000, "d", 0.8)]
    assert d.overall_confidence(segs) == round((0.5 * 1 + 0.8 * 1000) / 1001, 3)
    assert d.overall_confidence([]) is None
    assert d.overall_confidence([d.Segment(0, 10, "a", None)]) is None
    assert d.overall_confidence([SimpleNamespace(start_ms=0, end_ms=10, confidence=True),
                                 SimpleNamespace(start_ms=0, end_ms=10, confidence="0.9"),
                                 SimpleNamespace(start_ms=0, end_ms=10,
                                                 confidence=float("nan"))]) is None
    # Duck-typed (the provider's SttSegment) and clamped into the DB's 0..1.
    assert d.overall_confidence([SimpleNamespace(start_ms=0, end_ms=10, confidence=1.7)]) == 1.0
