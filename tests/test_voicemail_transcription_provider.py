"""Speech-to-Text providers (transcription/provider.py, gcp_stt.py, fake_stt.py,
smoke.py — plan §8).

No network, no credentials: the Google provider runs against an in-process
fake client that receives and returns the REAL ``google.cloud.speech_v2``
request / response types (a wrong field name fails here, not in production).

GCP provider: the exact RecognizeRequest (implicit ``us`` recognizer,
explicit LINEAR16 at the native rate, mono, model, language, features),
``timeout=60`` + ``retry=None``, the ``us-speech.googleapis.com`` endpoint,
lazy client / credentials, offsets merged onto the recording's timeline,
confidence rules (telephony vs chirp_3), the billed fallback, the whole error
mapping table, severity aggregation across parallel pieces, <= 2 pieces in
flight on ``vm-stt`` threads, no new piece after a failure, and no
transcript text in any log line.

Fake provider + gating: deterministic output, every FAKE_MODE, refused in
production or without the local flag (re-checked for a cached provider),
``available()`` false under client debug logging. Smoke: ok / config /
provider-error lines and the ``python -m`` entry point.

Run:  JWT_SECRET_KEY=x python3 -m pytest tests/test_voicemail_transcription_provider.py -q
"""
import asyncio
import io
import logging
import os
import subprocess
import sys
import threading
import time
from datetime import timedelta
from pathlib import Path

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")

REPO = Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
if str(API_SRC) not in sys.path:
    sys.path.insert(0, str(API_SRC))

cs = pytest.importorskip("google.cloud.speech_v2.types.cloud_speech",
                         reason="google-cloud-speech required (docker/api/requirements.txt)")
gexc = pytest.importorskip("google.api_core.exceptions")
import google.auth.exceptions as gauth_exc  # noqa: E402

from services.voicemail import _gcp  # noqa: E402
from services.voicemail.errors import VoicemailCryptoUnavailable  # noqa: E402
from services.voicemail.transcription import config as tconfig  # noqa: E402
from services.voicemail.transcription import fake_stt, gcp_stt, provider as prov, smoke  # noqa: E402

PROJECT = "rugged-night-193017"
SECRET = "Zebra-Quokka-7731"
ENV_NAMES = (
    "VOICEMAIL_TRANSCRIPTION_ENABLED", "VOICEMAIL_STT_PROJECT", "VOICEMAIL_STT_LOCATION",
    "VOICEMAIL_STT_MODEL", "VOICEMAIL_STT_CONCURRENCY", "VOICEMAIL_STT_DAILY_MINUTES_CAP",
    "VOICEMAIL_TRANSCRIPTION_POLL_S", "VOICEMAIL_STT_PROVIDER", "VOICEMAIL_STT_FAKE_MODE",
    "VOICEMAIL_STT_FAKE_TEXT", "VOICEMAIL_KMS_PROJECT", "VOICEMAIL_ALLOW_LOCAL_KMS", "ENV",
    "ENVIRONMENT", "GOOGLE_SDK_PYTHON_LOGGING_SCOPE", "GRPC_TRACE", "VOICEMAIL_IMPERSONATE_SA",
)


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    for name in ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    prov.reset_stt_providers()
    gcp_stt.reset_executor()
    tconfig.reset_problem_log()
    yield monkeypatch
    prov.reset_stt_providers()
    gcp_stt.reset_executor()


@pytest.fixture
def gcp_env(monkeypatch):
    monkeypatch.setenv("VOICEMAIL_KMS_PROJECT", PROJECT)


@pytest.fixture
def fake_env(monkeypatch):
    monkeypatch.setenv("VOICEMAIL_STT_PROVIDER", "fake")
    monkeypatch.setenv("VOICEMAIL_ALLOW_LOCAL_KMS", "true")


def run(coro):
    return asyncio.run(coro)


def pcm(ms: int, rate: int = 8000) -> bytes:
    return b"\x10\x00" * (rate * ms // 1000)


def response(*results, billed_s=None):
    kw = {"results": [cs.SpeechRecognitionResult(
        alternatives=[cs.SpeechRecognitionAlternative(transcript=t, confidence=c)] if t is not None
        else [], result_end_offset=timedelta(milliseconds=end)) for t, c, end in results]}
    if billed_s is not None:
        kw["metadata"] = cs.RecognitionResponseMetadata(
            total_billed_duration=timedelta(seconds=billed_s))
    return cs.RecognizeResponse(**kw)


class FakeSpeechClient:
    """Records (request, timeout, retry, thread) per call and answers from a
    script keyed by ("len", content bytes) — parallel pieces race, so their
    call order is not deterministic — or by the 1-based call number."""

    def __init__(self, script=None, default=None, delay_s=0.0):
        self.script = script or {}
        self.default = default if default is not None else response()
        self.delay_s = delay_s
        self.calls = []
        self._lock = threading.Lock()
        self.in_flight = 0
        self.max_in_flight = 0

    def recognize(self, request=None, *, timeout=None, retry=None):
        assert isinstance(request, cs.RecognizeRequest)
        with self._lock:
            self.calls.append((request, timeout, retry, threading.current_thread().name))
            self.in_flight += 1
            self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            n = len(self.calls)
            answer = self.script.get(("len", len(request.content)),
                                     self.script.get(n, self.default))
            if isinstance(answer, BaseException):
                raise answer
            if self.delay_s:
                time.sleep(self.delay_s)
            return answer
        finally:
            with self._lock:
                self.in_flight -= 1

    def __getattr__(self, item):
        raise AssertionError(f"unexpected Speech call: {item}")


def gcp_provider(client, *, model="telephony", monkeypatch=None):
    if monkeypatch is not None:
        monkeypatch.setenv("VOICEMAIL_STT_MODEL", model)
    cfg = tconfig.require_valid()
    return gcp_stt.GcpSttV2Provider(cfg, client=client)


# ===========================================================================
# GCP provider — request shape
# ===========================================================================
def test_request_is_exactly_the_contract(gcp_env):
    client = FakeSpeechClient(default=response(("Hello there.", 0.91, 1500), billed_s=2))
    p = gcp_provider(client)
    piece = pcm(1800, 16000)
    out = run(p.transcribe([prov.SttChunk(0, memoryview(piece))], sample_rate_hz=16000,
                           language="es-US"))
    [(req, timeout, retry, thread)] = client.calls
    assert req.recognizer == f"projects/{PROJECT}/locations/us/recognizers/_"
    dec = req.config.explicit_decoding_config
    assert dec.encoding == cs.ExplicitDecodingConfig.AudioEncoding.LINEAR16
    assert dec.sample_rate_hertz == 16000 and dec.audio_channel_count == 1
    assert "auto_decoding_config" not in req.config
    assert list(req.config.language_codes) == ["es-US"] and req.config.model == "telephony"
    f = req.config.features
    assert f.enable_automatic_punctuation is True and f.profanity_filter is False
    assert f.max_alternatives == 1
    assert not f.enable_word_time_offsets and not f.enable_word_confidence
    assert "adaptation" not in req.config
    assert req.content == piece and not req.uri
    assert timeout == 60.0 and retry is None
    assert thread.startswith("vm-stt")
    assert (out.provider, out.model, out.location) == ("gcp_stt_v2", "telephony", "us")
    assert out.billed_ms == 2000


def test_client_is_lazy_and_targets_the_us_endpoint(gcp_env, monkeypatch):
    from google.auth.credentials import AnonymousCredentials
    seen = []

    def creds(cfg):
        seen.append(cfg)
        return AnonymousCredentials()

    monkeypatch.setattr(_gcp, "get_credentials", creds)
    p = prov.get_stt_provider()
    assert isinstance(p, gcp_stt.GcpSttV2Provider) and p._client is None and seen == []
    client = p._get_client()                        # no RPC is made by building it
    assert client.api_endpoint == "us-speech.googleapis.com"
    assert len(seen) == 1 and p._get_client() is client
    assert p.endpoint == "us-speech.googleapis.com" and p.location == "us"


# ===========================================================================
# GCP provider — response parsing
# ===========================================================================
def test_offsets_are_merged_onto_the_recording_timeline(gcp_env):
    client = FakeSpeechClient(script={
        ("len", 64_000): response(("First words.", 0.9, 1200), ("", 0.0, 2000),
                                  (None, 0, 2500), (" Second part. ", 0.8, 3400), billed_s=4),
        ("len", 36_800): response(("Tail.", 0.7, 99_000)),   # an end past the piece: clamped
    })
    p = gcp_provider(client)
    out = run(p.transcribe([prov.SttChunk(55_000, pcm(4000)), prov.SttChunk(59_000, pcm(2300))],
                           sample_rate_hz=8000, language="en-US"))
    assert [(s.start_ms, s.end_ms, s.text) for s in out.segments] == [
        (55_000, 56_200, "First words."),
        (57_000, 58_400, "Second part."),           # starts at the previous result's end
        (59_000, 61_300, "Tail."),
    ]
    assert out.billed_ms == 4000 + 3000            # piece 2: no metadata -> ceil(2.3 s)


def test_confidence_rules(gcp_env, monkeypatch):
    rsp = response(("a", 0.93, 500), ("b", 0.0, 900), ("c", 1.5, 1000))
    tele = run(gcp_provider(FakeSpeechClient(default=rsp)).transcribe(
        [prov.SttChunk(0, pcm(1000))], sample_rate_hz=8000, language="en-US"))
    assert [s.confidence for s in tele.segments] == [pytest.approx(0.93), None, 1.0]
    chirp = run(gcp_provider(FakeSpeechClient(default=rsp), model="chirp_3",
                             monkeypatch=monkeypatch).transcribe(
        [prov.SttChunk(0, pcm(1000))], sample_rate_hz=8000, language="en-US"))
    assert [s.confidence for s in chirp.segments] == [None, None, None]
    assert chirp.model == "chirp_3"


# ===========================================================================
# GCP provider — errors
# ===========================================================================
ERROR_TABLE = [
    (gexc.ServiceUnavailable("x"), prov.SttTransient, "stt_unavailable", None),
    (gexc.InternalServerError("x"), prov.SttTransient, "stt_unavailable", None),
    (gexc.Unknown("x"), prov.SttTransient, "stt_unavailable", None),
    (gexc.Aborted("x"), prov.SttTransient, "stt_unavailable", None),
    (gexc.GatewayTimeout("x"), prov.SttTransient, "stt_unavailable", None),
    (gauth_exc.TransportError("x"), prov.SttTransient, "stt_unavailable", None),
    (ConnectionError("x"), prov.SttTransient, "stt_unavailable", None),
    (gexc.DeadlineExceeded("x"), prov.SttTransient, "stt_timeout", None),
    (gexc.ResourceExhausted("x"), prov.SttUnavailable, "stt_quota", 300),
    (gexc.TooManyRequests("x"), prov.SttUnavailable, "stt_quota", 300),
    (gexc.PermissionDenied("Speech API disabled"), prov.SttUnavailable, "stt_permission", 600),
    (gexc.Unauthenticated("x"), prov.SttUnavailable, "stt_permission", 600),
    (gexc.Forbidden("x"), prov.SttUnavailable, "stt_permission", 600),
    (VoicemailCryptoUnavailable("no ADC"), prov.SttUnavailable, "stt_permission", 600),
    (gexc.NotFound("x"), prov.SttUnavailable, "stt_config", 600),
    (gexc.FailedPrecondition("x"), prov.SttUnavailable, "stt_config", 600),
    (gexc.InvalidArgument("x"), prov.SttRejected, "stt_rejected", None),
    (gexc.OutOfRange("x"), prov.SttRejected, "stt_rejected", None),
    (RuntimeError("weird"), prov.SttTransient, "stt_unavailable", None),
]


@pytest.mark.parametrize("exc, cls, code, pause", ERROR_TABLE,
                         ids=[type(e[0]).__name__ for e in ERROR_TABLE])
def test_error_mapping(gcp_env, exc, cls, code, pause):
    p = gcp_provider(FakeSpeechClient(default=exc))
    with pytest.raises(cls) as ei:
        run(p.transcribe([prov.SttChunk(0, pcm(500))], sample_rate_hz=8000, language="en-US"))
    err = ei.value
    assert type(err) is cls and err.code == code
    assert err.source == type(exc).__name__
    if pause is not None:
        assert err.pause_s == pause
    assert err.__cause__ is None


def test_error_detail_is_capped_and_unknown_errors_log_the_class_only(gcp_env, caplog):
    long = gexc.InvalidArgument("y" * 500)
    err = gcp_stt.translate_error(long)
    assert len(err.detail) == prov.DETAIL_MAX_CHARS
    with caplog.at_level(logging.ERROR, logger=gcp_stt.logger.name):
        gcp_stt.translate_error(RuntimeError(SECRET))
    assert [r.getMessage() for r in caplog.records] == \
        ["voicemail transcription: unexpected Speech-to-Text error RuntimeError"]


def test_most_severe_error_wins_across_pieces(gcp_env):
    a, b = ("len", 8000), ("len", 9600)             # a 500 ms and a 600 ms piece
    for script, expected in (
            ({a: gexc.ServiceUnavailable("t"), b: gexc.InvalidArgument("r")}, prov.SttRejected),
            ({a: gexc.InvalidArgument("r"), b: gexc.PermissionDenied("u")}, prov.SttUnavailable),
            ({a: gexc.ServiceUnavailable("t"), b: gexc.DeadlineExceeded("t")}, prov.SttTransient),
            ({b: gexc.InvalidArgument("r")}, prov.SttRejected)):
        client = FakeSpeechClient(script=script, delay_s=0.05)
        p = gcp_provider(client)
        with pytest.raises(expected):
            run(p.transcribe([prov.SttChunk(0, pcm(500)), prov.SttChunk(500, pcm(600))],
                             sample_rate_hz=8000, language="en-US"))
        assert len(client.calls) == 2, "both in-flight pieces finished before raising"


def test_at_most_two_pieces_in_flight_and_none_after_a_failure(gcp_env):
    client = FakeSpeechClient(default=response(("ok", 0.9, 400)), delay_s=0.05)
    p = gcp_provider(client)
    chunks = [prov.SttChunk(i * 500, pcm(500)) for i in range(6)]
    out = run(p.transcribe(chunks, sample_rate_hz=8000, language="en-US"))
    assert len(client.calls) == 6 and client.max_in_flight == 2
    assert [s.start_ms for s in out.segments] == [0, 500, 1000, 1500, 2000, 2500]

    failing = FakeSpeechClient(script={1: gexc.ServiceUnavailable("down")},
                               default=response(("ok", 0.9, 400)), delay_s=0.1)
    with pytest.raises(prov.SttTransient):
        run(gcp_provider(failing).transcribe(chunks, sample_rate_hz=8000, language="en-US"))
    assert len(failing.calls) == 2, "no new piece starts after a failure"


def test_no_transcript_text_reaches_the_logs(gcp_env, caplog):
    client = FakeSpeechClient(script={1: response((SECRET, 0.9, 400)),
                                      2: gexc.InvalidArgument("bad audio")})
    with caplog.at_level(logging.DEBUG):
        run(gcp_provider(client).transcribe([prov.SttChunk(0, pcm(500))], sample_rate_hz=8000,
                                            language="en-US"))
        with pytest.raises(prov.SttRejected):
            run(gcp_provider(client).transcribe([prov.SttChunk(0, pcm(500))],
                                                sample_rate_hz=8000, language="en-US"))
    assert all(SECRET not in r.getMessage() for r in caplog.records)


def test_gcp_smoke_sends_one_second_of_silence(gcp_env):
    client = FakeSpeechClient(default=response(billed_s=1))
    out = run(gcp_provider(client).smoke())
    [(req, *_)] = client.calls
    assert req.content == bytes(16000) and req.config.explicit_decoding_config.sample_rate_hertz == 8000
    assert list(req.config.language_codes) == ["en-US"]
    assert out.segments == () and out.billed_ms == 1000


# ===========================================================================
# Fake provider
# ===========================================================================
def test_fake_provider_is_deterministic(fake_env, monkeypatch):
    monkeypatch.setenv("VOICEMAIL_STT_FAKE_TEXT", SECRET)
    p = prov.get_stt_provider()
    assert isinstance(p, fake_stt.FakeSttProvider) and p is prov.get_stt_provider()
    out = run(p.transcribe([prov.SttChunk(300, memoryview(pcm(40_000))),
                            prov.SttChunk(40_300, pcm(2_300))], sample_rate_hz=8000,
                           language="fr-CA"))
    assert [(s.start_ms, s.end_ms, s.text, s.confidence) for s in out.segments] == [
        (300, 40_300, SECRET, 0.9), (40_300, 42_600, SECRET, 0.9)]
    assert out.billed_ms == 40_000 + 3_000
    assert (out.provider, out.model, out.location) == ("fake", "fake", "us")
    assert p.calls == [
        {"offset_ms": 300, "bytes": 640_000, "piece_ms": 40_000, "sample_rate_hz": 8000,
         "language": "fr-CA"},
        {"offset_ms": 40_300, "bytes": 36_800, "piece_ms": 2_300, "sample_rate_hz": 8000,
         "language": "fr-CA"}]
    assert all(isinstance(v, (int, str)) for c in p.calls for v in c.values()), \
        "the fake never keeps audio"


@pytest.mark.parametrize("mode, cls, code", [
    ("transient", prov.SttTransient, "stt_unavailable"),
    ("unavailable", prov.SttUnavailable, "stt_quota"),
    ("rejected", prov.SttRejected, "stt_rejected"),
])
def test_fake_error_modes(fake_env, monkeypatch, mode, cls, code):
    monkeypatch.setenv("VOICEMAIL_STT_FAKE_MODE", mode)
    p = prov.get_stt_provider()
    with pytest.raises(cls) as ei:
        run(p.transcribe([prov.SttChunk(0, pcm(500))], sample_rate_hz=8000, language="en-US"))
    assert ei.value.code == code
    with pytest.raises(cls):
        run(p.smoke())


def test_fake_empty_and_slow_modes(fake_env, monkeypatch):
    monkeypatch.setenv("VOICEMAIL_STT_FAKE_MODE", "empty")
    out = run(prov.get_stt_provider().transcribe([prov.SttChunk(0, pcm(1500))],
                                                 sample_rate_hz=8000, language="en-US"))
    assert out.segments == () and out.billed_ms == 2000
    monkeypatch.setenv("VOICEMAIL_STT_FAKE_MODE", "slow")
    monkeypatch.setattr(fake_stt, "FAKE_SLOW_S", 5.0)
    monkeypatch.setattr(fake_stt, "FAKE_RPC_TIMEOUT_S", 0.05)
    with pytest.raises(prov.SttTransient) as ei:
        run(prov.get_stt_provider().transcribe([prov.SttChunk(0, pcm(500))],
                                               sample_rate_hz=8000, language="en-US"))
    assert ei.value.code == "stt_timeout"


# ===========================================================================
# get_stt_provider gating
# ===========================================================================
def test_fake_is_refused_outside_dev(monkeypatch):
    monkeypatch.setenv("VOICEMAIL_STT_PROVIDER", "fake")
    with pytest.raises(tconfig.TranscriptionUnavailable):
        prov.get_stt_provider()                     # no VOICEMAIL_ALLOW_LOCAL_KMS
    monkeypatch.setenv("VOICEMAIL_ALLOW_LOCAL_KMS", "true")
    cached = prov.get_stt_provider()
    for env_name in ("ENV", "ENVIRONMENT"):
        monkeypatch.setenv(env_name, "production")
        with pytest.raises(tconfig.TranscriptionUnavailable):
            prov.get_stt_provider()                 # re-checked even though cached
        monkeypatch.delenv(env_name)
    assert prov.get_stt_provider() is cached


def test_gcp_provider_needs_valid_config(monkeypatch):
    with pytest.raises(tconfig.TranscriptionUnavailable):
        prov.get_stt_provider()                     # no project
    monkeypatch.setenv("VOICEMAIL_KMS_PROJECT", PROJECT)
    p = prov.get_stt_provider()
    assert isinstance(p, gcp_stt.GcpSttV2Provider) and p.recognizer.startswith("projects/")
    for name, value in (("VOICEMAIL_STT_LOCATION", "eu"),
                        ("GOOGLE_SDK_PYTHON_LOGGING_SCOPE", "google"),
                        ("GRPC_TRACE", "all")):
        monkeypatch.setenv(name, value)
        with pytest.raises(tconfig.TranscriptionUnavailable):
            prov.get_stt_provider()
        monkeypatch.setenv("VOICEMAIL_TRANSCRIPTION_ENABLED", "true")
        assert tconfig.available() is False
        monkeypatch.delenv(name)
        monkeypatch.delenv("VOICEMAIL_TRANSCRIPTION_ENABLED")
    monkeypatch.setenv("VOICEMAIL_STT_MODEL", "chirp_3")
    assert prov.get_stt_provider() is not p and prov.get_stt_provider().model == "chirp_3"


def test_stt_pool_is_dedicated_and_sized_from_concurrency(gcp_env, monkeypatch):
    monkeypatch.setenv("VOICEMAIL_STT_CONCURRENCY", "3")
    gcp_stt.reset_executor()
    pool = gcp_stt._stt_executor()
    assert pool._max_workers == 6 and pool is not _gcp._io_executor()


# ===========================================================================
# smoke.py
# ===========================================================================
def test_smoke_ok_with_the_fake(fake_env):
    out = io.StringIO()
    assert run(smoke.run(out)) == 0
    assert out.getvalue().strip() == ("stt smoke ok: provider=fake endpoint=in-process "
                                      "location=us model=fake results=0 billed_ms=1000")


def test_smoke_reports_config_problems():
    out = io.StringIO()
    assert run(smoke.run(out)) == 1
    lines = out.getvalue().splitlines()
    assert lines[0] == "stt smoke FAILED: config TranscriptionUnavailable"
    assert any("VOICEMAIL_STT_PROJECT" in line for line in lines[1:])


def test_smoke_runs_regardless_of_the_flag_and_names_the_google_error(gcp_env, monkeypatch):
    monkeypatch.setenv("VOICEMAIL_TRANSCRIPTION_ENABLED", "false")
    p = prov.get_stt_provider()
    p._client = FakeSpeechClient(default=gexc.PermissionDenied("Speech API disabled"))
    out = io.StringIO()
    assert run(smoke.run(out)) == 1
    assert out.getvalue().strip() == "stt smoke FAILED: stt_permission PermissionDenied"
    p._client = FakeSpeechClient(default=response(billed_s=1))
    out = io.StringIO()
    assert run(smoke.run(out)) == 0
    assert out.getvalue().strip() == (
        "stt smoke ok: provider=gcp_stt_v2 endpoint=us-speech.googleapis.com location=us "
        "model=telephony results=0 billed_ms=1000")


def test_smoke_module_entry_point():
    env = {k: v for k, v in os.environ.items() if k not in ENV_NAMES}
    env.update({"JWT_SECRET_KEY": "x", "VOICEMAIL_STT_PROVIDER": "fake",
                "VOICEMAIL_ALLOW_LOCAL_KMS": "true"})
    ok = subprocess.run([sys.executable, "-m", "services.voicemail.transcription.smoke"],
                        cwd=str(API_SRC), env=env, capture_output=True, text=True, timeout=60)
    assert ok.returncode == 0, ok.stderr
    assert ok.stdout.startswith("stt smoke ok: provider=fake")
    env["ENV"] = "production"
    bad = subprocess.run([sys.executable, "-m", "services.voicemail.transcription.smoke"],
                         cwd=str(API_SRC), env=env, capture_output=True, text=True, timeout=60)
    assert bad.returncode == 1
    assert bad.stdout.startswith("stt smoke FAILED: config TranscriptionUnavailable")
