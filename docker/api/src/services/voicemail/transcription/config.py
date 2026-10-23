"""Voicemail transcription configuration — env parsing + fail-closed checks.

Contract: docs/VOICEMAIL_TRANSCRIPTION_PLAN.md §12 (owner decisions §0.1
override the rest of that document). Read LIVE on every call, like
``services/voicemail/config.py``: a test ``monkeypatch.setenv`` or a container
restart with a new ``.env`` takes effect without code changes. Parsing never
raises; :func:`problems` lists what is wrong, :func:`require_valid` raises
:class:`TranscriptionUnavailable`, and :func:`available` never raises — so
nothing is ever sent to Google unless the platform flag is on AND the whole
configuration is valid.

Production env (services ``.env`` -> ``docker-compose.services.yml`` -> ``api``):

================================  ==================  =================================
VOICEMAIL_TRANSCRIPTION_ENABLED   unset = OFF         ON only if exactly ``true``
                                                      (trimmed, case-insensitive)
VOICEMAIL_STT_PROJECT             = KMS project       recognizer path + billing project
VOICEMAIL_STT_LOCATION            ``us``              ONLY ``us`` (US residency)
VOICEMAIL_STT_MODEL               ``telephony``       ``telephony`` | ``chirp_3``
VOICEMAIL_STT_CONCURRENCY         ``1``               jobs per API worker process, 1-4
VOICEMAIL_STT_DAILY_MINUTES_CAP   ``1000``            rolling 24 h billed minutes, 1-100000
VOICEMAIL_TRANSCRIPTION_POLL_S    ``10``              worker tick, 2-60 s
================================  ==================  =================================

An unparseable or out-of-range value is a configuration ERROR (transcription
unavailable), never silently clamped: the operator sees it in the smoke test
and in the ERROR log, and nothing is sent anywhere meanwhile.

Dev/CI ONLY (deliberately NOT passed through docker-compose.services.yml, so
production can never select them):

* ``VOICEMAIL_STT_PROVIDER=fake`` — the deterministic in-process fake. Refused
  unless ``VOICEMAIL_ALLOW_LOCAL_KMS=true`` AND ``ENV``/``ENVIRONMENT`` is not
  ``production`` (the local-KMS gate). Unset = the Google provider.
* ``VOICEMAIL_STT_FAKE_MODE`` — ``ok`` (default) | ``empty`` | ``transient`` |
  ``unavailable`` | ``rejected`` | ``slow``.
* ``VOICEMAIL_STT_FAKE_TEXT`` — default ``"This is a test transcript."``.

Debug logging guard: ``GOOGLE_SDK_PYTHON_LOGGING_SCOPE`` turns on the Google
client library's DEBUG logging (its docs warn the logs "may contain sensitive
information") and ``GRPC_TRACE`` turns on gRPC tracers; either could dump a
request (audio) or response (transcript). If either is set (non-empty),
transcription is unavailable.

Credentials are NOT configured here: the provider reuses
``VOICEMAIL_IMPERSONATE_SA`` / ADC through ``services.voicemail._gcp``.
"""
from __future__ import annotations

import logging
import os
import re
import threading
import time
from dataclasses import dataclass

from ..config import _PROJECT_RE
from ..config import load_config as load_voicemail_config

logger = logging.getLogger(__name__)

PLATFORM_FLAG_ENV = "VOICEMAIL_TRANSCRIPTION_ENABLED"

#: Provider names — also the value stored in voicemail_transcripts.provider.
PROVIDER_GCP = "gcp_stt_v2"
PROVIDER_FAKE = "fake"
PROVIDERS = (PROVIDER_GCP, PROVIDER_FAKE)

#: US residency (plan invariant 8): the only accepted location.
DEFAULT_LOCATION = "us"
ALLOWED_LOCATIONS = ("us",)

MODEL_TELEPHONY = "telephony"
MODEL_CHIRP_3 = "chirp_3"
MODELS = (MODEL_TELEPHONY, MODEL_CHIRP_3)
DEFAULT_MODEL = MODEL_TELEPHONY
#: The model name the fake provider reports (voicemail_transcripts.model).
FAKE_MODEL = "fake"

#: Languages with the ``telephony`` model in ``us`` (plan §2.4). Adding one is
#: a code change after checking Google's table — not a migration (the DB only
#: checks the shape). The UI holds the same list with these labels.
SUPPORTED_LANGUAGES: tuple[str, ...] = ("en-US", "es-US", "fr-CA")
DEFAULT_LANGUAGE = "en-US"
LANGUAGE_LABELS: dict[str, str] = {
    "en-US": "English (US)",
    "es-US": "Spanish (US)",
    "fr-CA": "French (Canada)",
}

DEFAULT_CONCURRENCY = 1
CONCURRENCY_RANGE = (1, 4)
DEFAULT_DAILY_MINUTES_CAP = 1000
DAILY_MINUTES_CAP_RANGE = (1, 100_000)
DEFAULT_POLL_S = 10
POLL_S_RANGE = (2, 60)

FAKE_MODES = ("ok", "empty", "transient", "unavailable", "rejected", "slow")
DEFAULT_FAKE_MODE = "ok"
DEFAULT_FAKE_TEXT = "This is a test transcript."

#: Env vars that turn on client-library / gRPC debug logging (payload dumps).
DEBUG_LOGGING_ENV = ("GOOGLE_SDK_PYTHON_LOGGING_SCOPE", "GRPC_TRACE")

#: At most one ERROR log per distinct problem set per this many seconds.
PROBLEM_LOG_INTERVAL_S = 300.0

_UINT_RE = re.compile(r"[0-9]{1,9}", re.ASCII)


class TranscriptionUnavailable(RuntimeError):
    """Transcription is switched off or its configuration is unusable. The
    message names the setting, never a secret or any customer data."""


def _env(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


def _int_env(name: str, default: int) -> int | None:
    """Unset / empty -> ``default``; a plain non-negative integer -> its value;
    anything else -> None (reported by :func:`problems`)."""
    raw = _env(name)
    if not raw:
        return default
    return int(raw) if _UINT_RE.fullmatch(raw) else None


@dataclass(frozen=True)
class TranscriptionConfig:
    """A parsed snapshot of the transcription env. Unvalidated — see
    :func:`problems` / :func:`require_valid`."""

    platform_flag: bool
    provider: str
    project: str
    location: str
    model: str                       # the configured STT model (the fake reports FAKE_MODEL)
    concurrency: int | None          # None = not an integer
    daily_minutes_cap: int | None
    poll_s: int | None
    fake_mode: str
    fake_text: str
    local_backends_permitted: bool   # VOICEMAIL_ALLOW_LOCAL_KMS=true and not production
    production_env: bool
    debug_logging_env: tuple[str, ...]   # names of the DEBUG_LOGGING_ENV vars that are set

    @property
    def is_fake(self) -> bool:
        return self.provider == PROVIDER_FAKE

    @property
    def endpoint(self) -> str:
        """Regional API endpoint, e.g. ``us-speech.googleapis.com``."""
        return f"{self.location}-speech.googleapis.com"

    @property
    def recognizer(self) -> str:
        """The implicit recognizer (no resource to create, no admin IAM)."""
        return f"projects/{self.project}/locations/{self.location}/recognizers/_"

    @property
    def effective_model(self) -> str:
        """What the provider reports and the row stores."""
        return FAKE_MODEL if self.is_fake else self.model

    @property
    def daily_cap_ms(self) -> int | None:
        return None if self.daily_minutes_cap is None else self.daily_minutes_cap * 60_000


def load_config() -> TranscriptionConfig:
    """Snapshot the transcription env (never raises)."""
    vm = load_voicemail_config()
    return TranscriptionConfig(
        platform_flag=_env(PLATFORM_FLAG_ENV).lower() == "true",
        provider=_env("VOICEMAIL_STT_PROVIDER", PROVIDER_GCP).lower(),
        project=_env("VOICEMAIL_STT_PROJECT") or vm.kms_project,
        location=_env("VOICEMAIL_STT_LOCATION", DEFAULT_LOCATION).lower(),
        model=_env("VOICEMAIL_STT_MODEL", DEFAULT_MODEL).lower(),
        concurrency=_int_env("VOICEMAIL_STT_CONCURRENCY", DEFAULT_CONCURRENCY),
        daily_minutes_cap=_int_env("VOICEMAIL_STT_DAILY_MINUTES_CAP", DEFAULT_DAILY_MINUTES_CAP),
        poll_s=_int_env("VOICEMAIL_TRANSCRIPTION_POLL_S", DEFAULT_POLL_S),
        fake_mode=_env("VOICEMAIL_STT_FAKE_MODE", DEFAULT_FAKE_MODE).lower(),
        fake_text=_env("VOICEMAIL_STT_FAKE_TEXT", DEFAULT_FAKE_TEXT),
        local_backends_permitted=vm.local_backends_permitted,
        production_env=vm.production_env,
        debug_logging_env=tuple(n for n in DEBUG_LOGGING_ENV if _env(n)),
    )


def _range_problem(name: str, value: int | None, bounds: tuple[int, int]) -> str | None:
    lo, hi = bounds
    if value is None:
        return f"{name} must be a whole number between {lo} and {hi}"
    if not lo <= value <= hi:
        return f"{name} must be between {lo} and {hi}"
    return None


def problems(cfg: TranscriptionConfig | None = None) -> tuple[str, ...]:
    """Every reason the provider configuration is unusable (empty = valid).
    Independent of the platform flag (the smoke test validates with the flag
    off). Never raises; messages name settings, never values that could be
    secrets."""
    cfg = cfg or load_config()
    out: list[str] = []

    if cfg.provider not in PROVIDERS:
        out.append("VOICEMAIL_STT_PROVIDER must be unset (Google Speech-to-Text) "
                   "or 'fake' (dev/CI only)")
    elif cfg.is_fake:
        if cfg.production_env:
            out.append("the fake STT provider is refused: ENV/ENVIRONMENT=production "
                       "(dev/CI only)")
        elif not cfg.local_backends_permitted:
            out.append("the fake STT provider is refused: VOICEMAIL_ALLOW_LOCAL_KMS is not "
                       "'true' (dev/CI only)")
        if cfg.fake_mode not in FAKE_MODES:
            out.append(f"VOICEMAIL_STT_FAKE_MODE must be one of {', '.join(FAKE_MODES)}")
    else:  # Google
        if not cfg.project:
            out.append("VOICEMAIL_STT_PROJECT (or VOICEMAIL_KMS_PROJECT) is not set")
        elif not _PROJECT_RE.fullmatch(cfg.project):
            out.append("VOICEMAIL_STT_PROJECT is not a valid GCP project id")

    if cfg.location not in ALLOWED_LOCATIONS:
        out.append("VOICEMAIL_STT_LOCATION must be 'us' (US-only processing)")
    if cfg.model not in MODELS:
        out.append(f"VOICEMAIL_STT_MODEL must be one of {', '.join(MODELS)}")
    for name, value, bounds in (
            ("VOICEMAIL_STT_CONCURRENCY", cfg.concurrency, CONCURRENCY_RANGE),
            ("VOICEMAIL_STT_DAILY_MINUTES_CAP", cfg.daily_minutes_cap, DAILY_MINUTES_CAP_RANGE),
            ("VOICEMAIL_TRANSCRIPTION_POLL_S", cfg.poll_s, POLL_S_RANGE)):
        problem = _range_problem(name, value, bounds)
        if problem:
            out.append(problem)
    for name in cfg.debug_logging_env:
        out.append(f"{name} is set: client debug logging could record audio or transcripts")
    return tuple(out)


def require_valid(cfg: TranscriptionConfig | None = None) -> TranscriptionConfig:
    """Return the snapshot if the provider configuration is usable, else raise
    TranscriptionUnavailable naming every problem. Ignores the platform flag
    (the worker only runs when it is on; the smoke test runs either way)."""
    cfg = cfg or load_config()
    found = problems(cfg)
    if found:
        raise TranscriptionUnavailable("; ".join(found))
    return cfg


def platform_enabled() -> bool:
    """The platform kill switch: ON only if VOICEMAIL_TRANSCRIPTION_ENABLED is
    exactly ``true`` (trimmed, case-insensitive). Never raises."""
    try:
        return _env(PLATFORM_FLAG_ENV).lower() == "true"
    except Exception:  # noqa: BLE001 — a kill switch fails OFF
        return False


_log_lock = threading.Lock()
_last_logged: dict[tuple[str, ...], float] = {}


def _log_problems(found: tuple[str, ...]) -> None:
    """ERROR at most once per PROBLEM_LOG_INTERVAL_S per distinct problem set
    (available() is called on every /summary request)."""
    now = time.monotonic()
    with _log_lock:
        last = _last_logged.get(found)
        if last is not None and now - last < PROBLEM_LOG_INTERVAL_S:
            return
        _last_logged[found] = now
    logger.error("voicemail transcription unavailable (platform flag is on): %s",
                 "; ".join(found))


def available() -> bool:
    """True only when the platform flag is on AND the provider configuration is
    valid AND no client debug logging is switched on. This is
    ``summary.transcription_available``. Never raises (any failure -> False)."""
    try:
        if not platform_enabled():
            return False
        found = problems()
        if found:
            _log_problems(found)
            return False
        return True
    except Exception:  # noqa: BLE001 — availability fails CLOSED
        logger.exception("voicemail transcription: availability check failed")
        return False


def is_supported_language(value: object) -> bool:
    """Exact (case-sensitive) match against SUPPORTED_LANGUAGES."""
    return isinstance(value, str) and value in SUPPORTED_LANGUAGES


def reset_problem_log() -> None:
    """Test hook: forget the rate-limited ERROR log state."""
    with _log_lock:
        _last_logged.clear()
