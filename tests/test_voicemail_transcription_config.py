"""Transcription configuration (services/voicemail/transcription/config.py, plan §12).

Pure unit tests (no DB): defaults; the platform flag is ON only for exactly
"true"; ``available()`` needs the flag AND a valid provider config AND no
client debug logging, never raises, and logs its ERROR rate-limited without
echoing values; every STT variable's parse/range rules (invalid = unavailable,
never clamped); US-only location; the fake provider's gate (local-KMS flag +
not production); the language allowlist; importing the package loads no
Google / gRPC module.

Run:  JWT_SECRET_KEY=x python3 -m pytest tests/test_voicemail_transcription_config.py -q
"""
import logging
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")

REPO = Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
if str(API_SRC) not in sys.path:
    sys.path.insert(0, str(API_SRC))

from services.voicemail.transcription import config as cfgmod  # noqa: E402

ENV_NAMES = (
    "VOICEMAIL_TRANSCRIPTION_ENABLED", "VOICEMAIL_STT_PROJECT", "VOICEMAIL_STT_LOCATION",
    "VOICEMAIL_STT_MODEL", "VOICEMAIL_STT_CONCURRENCY", "VOICEMAIL_STT_DAILY_MINUTES_CAP",
    "VOICEMAIL_TRANSCRIPTION_POLL_S", "VOICEMAIL_STT_PROVIDER", "VOICEMAIL_STT_FAKE_MODE",
    "VOICEMAIL_STT_FAKE_TEXT", "VOICEMAIL_KMS_PROJECT", "VOICEMAIL_ALLOW_LOCAL_KMS", "ENV",
    "ENVIRONMENT", "GOOGLE_SDK_PYTHON_LOGGING_SCOPE", "GRPC_TRACE",
)
PROJECT = "rugged-night-193017"


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in ENV_NAMES:
        monkeypatch.delenv(name, raising=False)
    cfgmod.reset_problem_log()
    yield monkeypatch
    cfgmod.reset_problem_log()


@pytest.fixture
def valid_gcp(monkeypatch):
    monkeypatch.setenv("VOICEMAIL_KMS_PROJECT", PROJECT)


@pytest.fixture
def fake_env(monkeypatch):
    monkeypatch.setenv("VOICEMAIL_STT_PROVIDER", "fake")
    monkeypatch.setenv("VOICEMAIL_ALLOW_LOCAL_KMS", "true")


# ---------------------------------------------------------------------------
# Defaults + derived values
# ---------------------------------------------------------------------------
def test_defaults(valid_gcp):
    c = cfgmod.load_config()
    assert c.platform_flag is False
    assert (c.provider, c.project, c.location, c.model) == ("gcp_stt_v2", PROJECT, "us",
                                                            "telephony")
    assert (c.concurrency, c.daily_minutes_cap, c.poll_s) == (1, 1000, 10)
    assert (c.fake_mode, c.fake_text) == ("ok", "This is a test transcript.")
    assert c.debug_logging_env == ()
    assert c.endpoint == "us-speech.googleapis.com"
    assert c.recognizer == f"projects/{PROJECT}/locations/us/recognizers/_"
    assert c.effective_model == "telephony" and c.daily_cap_ms == 60_000_000
    assert cfgmod.problems(c) == ()
    assert cfgmod.require_valid(c) is c


def test_stt_project_overrides_the_kms_project(valid_gcp, monkeypatch):
    monkeypatch.setenv("VOICEMAIL_STT_PROJECT", "other-proj-1")
    assert cfgmod.load_config().project == "other-proj-1"
    monkeypatch.setenv("VOICEMAIL_STT_PROJECT", "  ")            # blank = unset -> fallback
    assert cfgmod.load_config().project == PROJECT


def test_languages():
    assert cfgmod.SUPPORTED_LANGUAGES == ("en-US", "es-US", "fr-CA")
    assert cfgmod.DEFAULT_LANGUAGE == "en-US" and cfgmod.DEFAULT_LANGUAGE in cfgmod.SUPPORTED_LANGUAGES
    assert tuple(cfgmod.LANGUAGE_LABELS) == cfgmod.SUPPORTED_LANGUAGES
    shape = re.compile(r"[a-z]{2,3}-[A-Z]{2}")   # migration 56's CHECK
    assert all(shape.fullmatch(code) for code in cfgmod.SUPPORTED_LANGUAGES)
    for ok in cfgmod.SUPPORTED_LANGUAGES:
        assert cfgmod.is_supported_language(ok)
    for bad in ("en-us", "EN-US", "de-DE", "en-GB", "", None, 1, " en-US"):
        assert not cfgmod.is_supported_language(bad)


# ---------------------------------------------------------------------------
# Platform flag + available()
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("value, on", [
    ("true", True), ("TRUE", True), (" True ", True), ("1", False), ("yes", False),
    ("on", False), ("false", False), ("", False), ("truee", False), ("t", False),
])
def test_platform_flag_is_on_only_for_exactly_true(valid_gcp, monkeypatch, value, on):
    monkeypatch.setenv("VOICEMAIL_TRANSCRIPTION_ENABLED", value)
    assert cfgmod.platform_enabled() is on
    assert cfgmod.load_config().platform_flag is on
    assert cfgmod.available() is on


def test_available_needs_flag_and_valid_config(monkeypatch):
    assert cfgmod.available() is False                         # nothing set
    monkeypatch.setenv("VOICEMAIL_KMS_PROJECT", PROJECT)
    assert cfgmod.available() is False                         # valid, flag off
    monkeypatch.setenv("VOICEMAIL_TRANSCRIPTION_ENABLED", "true")
    assert cfgmod.available() is True
    monkeypatch.delenv("VOICEMAIL_KMS_PROJECT")
    assert cfgmod.available() is False                         # flag on, no project


@pytest.mark.parametrize("name", ["GOOGLE_SDK_PYTHON_LOGGING_SCOPE", "GRPC_TRACE"])
def test_client_debug_logging_makes_it_unavailable(valid_gcp, monkeypatch, name):
    monkeypatch.setenv("VOICEMAIL_TRANSCRIPTION_ENABLED", "true")
    assert cfgmod.available() is True
    monkeypatch.setenv(name, "google" if name.startswith("GOOGLE") else "http,api")
    assert cfgmod.available() is False
    assert cfgmod.load_config().debug_logging_env == (name,)
    assert any(name in p for p in cfgmod.problems())
    with pytest.raises(cfgmod.TranscriptionUnavailable):
        cfgmod.require_valid()
    monkeypatch.setenv(name, "")                               # empty = not set
    assert cfgmod.available() is True


def test_available_never_raises(valid_gcp, monkeypatch):
    monkeypatch.setenv("VOICEMAIL_TRANSCRIPTION_ENABLED", "true")

    def boom(*a, **k):
        raise RuntimeError("unexpected")

    monkeypatch.setattr(cfgmod, "problems", boom)
    assert cfgmod.available() is False


def test_unavailable_error_log_is_rate_limited_and_echoes_no_values(monkeypatch, caplog):
    monkeypatch.setenv("VOICEMAIL_TRANSCRIPTION_ENABLED", "true")
    monkeypatch.setenv("VOICEMAIL_STT_PROJECT", "Not/A/Project/s3cr3t")
    with caplog.at_level(logging.ERROR, logger=cfgmod.logger.name):
        for _ in range(5):
            assert cfgmod.available() is False
    records = [r for r in caplog.records if r.name == cfgmod.logger.name]
    assert len(records) == 1
    msg = records[0].getMessage()
    assert "VOICEMAIL_STT_PROJECT" in msg and "s3cr3t" not in msg
    # A different problem set logs again; the same one after the interval too.
    caplog.clear()
    monkeypatch.setenv("VOICEMAIL_STT_LOCATION", "eu")
    with caplog.at_level(logging.ERROR, logger=cfgmod.logger.name):
        cfgmod.available()
        cfgmod.available()
    assert len([r for r in caplog.records if r.name == cfgmod.logger.name]) == 1
    monkeypatch.setattr(cfgmod, "PROBLEM_LOG_INTERVAL_S", 0.0)
    caplog.clear()
    with caplog.at_level(logging.ERROR, logger=cfgmod.logger.name):
        cfgmod.available()
    assert len([r for r in caplog.records if r.name == cfgmod.logger.name]) == 1


def test_flag_off_never_logs(monkeypatch, caplog):
    monkeypatch.setenv("VOICEMAIL_STT_LOCATION", "eu")
    with caplog.at_level(logging.DEBUG, logger=cfgmod.logger.name):
        assert cfgmod.available() is False
    assert not [r for r in caplog.records if r.name == cfgmod.logger.name]


# ---------------------------------------------------------------------------
# Per-variable validation (invalid -> a problem, never clamped)
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("name, good, bad", [
    ("VOICEMAIL_STT_LOCATION", ["us", "US", " us "], ["eu", "us-central1", "global", "us-east1",
                                                       "asia"]),
    ("VOICEMAIL_STT_MODEL", ["telephony", "chirp_3", "CHIRP_3"],
     ["latest_long", "chirp_2", "telephony_short", "default"]),
    ("VOICEMAIL_STT_CONCURRENCY", ["1", "4", " 2 "], ["0", "5", "-1", "1.5", "abc", "2x"]),
    ("VOICEMAIL_STT_DAILY_MINUTES_CAP", ["1", "1000", "100000"],
     ["0", "100001", "1e3", "-5", "lots", "9999999999"]),
    ("VOICEMAIL_TRANSCRIPTION_POLL_S", ["2", "10", "60"], ["1", "61", "0", "ten", "5.5"]),
    ("VOICEMAIL_STT_PROJECT", ["my-project-1", PROJECT],
     ["Bad_Project", "bad/project", "x", "a" * 31, "1project"]),
    ("VOICEMAIL_STT_PROVIDER", ["gcp_stt_v2", "GCP_STT_V2"], ["gcp", "aws", "google", "local"]),
])
def test_each_variable_is_validated(valid_gcp, monkeypatch, name, good, bad):
    for value in good:
        monkeypatch.setenv(name, value)
        assert cfgmod.problems() == (), (name, value)
    for value in bad:
        monkeypatch.setenv(name, value)
        found = cfgmod.problems()
        assert len(found) == 1 and name in found[0], (name, value, found)
        with pytest.raises(cfgmod.TranscriptionUnavailable) as ei:
            cfgmod.require_valid()
        assert name in str(ei.value)


def test_numbers_are_parsed_not_clamped(valid_gcp, monkeypatch):
    monkeypatch.setenv("VOICEMAIL_STT_CONCURRENCY", "3")
    monkeypatch.setenv("VOICEMAIL_STT_DAILY_MINUTES_CAP", "250")
    monkeypatch.setenv("VOICEMAIL_TRANSCRIPTION_POLL_S", "2")
    c = cfgmod.require_valid()
    assert (c.concurrency, c.daily_minutes_cap, c.poll_s, c.daily_cap_ms) == (3, 250, 2, 15_000_000)
    monkeypatch.setenv("VOICEMAIL_STT_CONCURRENCY", "abc")
    assert cfgmod.load_config().concurrency is None


def test_every_problem_is_reported_at_once(monkeypatch):
    monkeypatch.setenv("VOICEMAIL_STT_LOCATION", "eu")
    monkeypatch.setenv("VOICEMAIL_STT_MODEL", "nope")
    monkeypatch.setenv("VOICEMAIL_STT_CONCURRENCY", "9")
    monkeypatch.setenv("GRPC_TRACE", "all")
    found = cfgmod.problems()
    for name in ("VOICEMAIL_STT_PROJECT", "VOICEMAIL_STT_LOCATION", "VOICEMAIL_STT_MODEL",
                 "VOICEMAIL_STT_CONCURRENCY", "GRPC_TRACE"):
        assert any(name in p for p in found), name
    with pytest.raises(cfgmod.TranscriptionUnavailable) as ei:
        cfgmod.require_valid()
    assert str(ei.value).count(";") == len(found) - 1


# ---------------------------------------------------------------------------
# Fake provider gate (dev/CI only)
# ---------------------------------------------------------------------------
def test_fake_provider_allowed_only_in_dev(fake_env, monkeypatch):
    c = cfgmod.load_config()
    assert c.is_fake and c.effective_model == "fake" and c.project == ""
    assert cfgmod.problems() == (), "the fake needs no project"
    monkeypatch.setenv("VOICEMAIL_TRANSCRIPTION_ENABLED", "true")
    assert cfgmod.available() is True

    monkeypatch.setenv("VOICEMAIL_ALLOW_LOCAL_KMS", "false")
    assert cfgmod.available() is False
    assert any("VOICEMAIL_ALLOW_LOCAL_KMS" in p for p in cfgmod.problems())
    monkeypatch.delenv("VOICEMAIL_ALLOW_LOCAL_KMS")
    assert cfgmod.available() is False

    monkeypatch.setenv("VOICEMAIL_ALLOW_LOCAL_KMS", "true")
    for env_name in ("ENV", "ENVIRONMENT"):
        monkeypatch.setenv(env_name, "production")
        assert cfgmod.available() is False
        assert any("production" in p for p in cfgmod.problems())
        monkeypatch.delenv(env_name)
    assert cfgmod.available() is True


def test_fake_mode_and_text(fake_env, monkeypatch):
    for mode in cfgmod.FAKE_MODES:
        monkeypatch.setenv("VOICEMAIL_STT_FAKE_MODE", mode.upper())
        assert cfgmod.load_config().fake_mode == mode and cfgmod.problems() == ()
    monkeypatch.setenv("VOICEMAIL_STT_FAKE_MODE", "explode")
    assert any("VOICEMAIL_STT_FAKE_MODE" in p for p in cfgmod.problems())
    monkeypatch.setenv("VOICEMAIL_STT_FAKE_TEXT", "  Custom words.  ")
    assert cfgmod.load_config().fake_text == "Custom words."
    # Fake settings are ignored for the Google provider.
    monkeypatch.setenv("VOICEMAIL_STT_PROVIDER", "")
    monkeypatch.setenv("VOICEMAIL_KMS_PROJECT", PROJECT)
    assert cfgmod.problems() == ()


def test_fake_still_obeys_location_and_model(fake_env, monkeypatch):
    monkeypatch.setenv("VOICEMAIL_STT_LOCATION", "eu")
    assert any("VOICEMAIL_STT_LOCATION" in p for p in cfgmod.problems())


# ---------------------------------------------------------------------------
# Import hygiene
# ---------------------------------------------------------------------------
def test_importing_the_package_loads_no_google_or_grpc_module():
    code = (
        "import sys\n"
        f"sys.path.insert(0, {str(API_SRC)!r})\n"
        "import services.voicemail.transcription as t\n"
        "from services.voicemail.transcription import config, document\n"
        "t.available(); config.load_config()\n"
        "bad = sorted(m for m in sys.modules if m.split('.')[0] in ('google', 'grpc'))\n"
        "print(','.join(bad))\n"
    )
    env = {k: v for k, v in os.environ.items() if k not in ENV_NAMES}
    env["JWT_SECRET_KEY"] = "x"
    out = subprocess.run([sys.executable, "-I", "-c", code], capture_output=True, text=True,
                         env=env, timeout=60, cwd=str(REPO))
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "", f"imported: {out.stdout.strip()}"
