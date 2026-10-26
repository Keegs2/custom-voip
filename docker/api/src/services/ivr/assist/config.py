"""Flow assistant configuration (env, read LIVE — never cached at import).

  IVR_ASSIST_ENABLED              platform switch: ON only if exactly "true"
                                  (trimmed, any case); default OFF.
  TED_BASE_URL                    TED's public base URL (from the TED runbook).
                                  https:// only — plain http:// is accepted for
                                  a loopback / single-label (dev container) host.
  TED_IVR_ASSIST_TOKEN            the dedicated assist Trigger token (a secret:
                                  .env only). Never logged, never in an error.
  IVR_ASSIST_DAILY_PER_CUSTOMER   jobs per customer per UTC day (default 40).
  IVR_ASSIST_TED_TIMEOUT_SECONDS  HTTP timeout per TED call (default 60).

The assistant is available to a customer only when the platform is
(``platform_available()``: the switch AND TED configured) AND the customer is
opted in (``customers.ivr_assist_enabled``) AND entitled to IVR.
"""
from __future__ import annotations

import ipaddress
import logging
import os
import re
import time
from typing import Optional
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

ENV_ENABLED = "IVR_ASSIST_ENABLED"
ENV_BASE_URL = "TED_BASE_URL"
ENV_TOKEN = "TED_IVR_ASSIST_TOKEN"
ENV_DAILY = "IVR_ASSIST_DAILY_PER_CUSTOMER"
ENV_TIMEOUT = "IVR_ASSIST_TED_TIMEOUT_SECONDS"

#: TED path (contract §1). TED's edge only forwards /api/triggers/* to its backend.
TED_PATH = "/api/triggers/crag/ivr-assist"
USER_AGENT = "crag-ivr-assist/1"

DEFAULT_DAILY = 40
DEFAULT_TIMEOUT_S = 60.0
#: Three TED calls (propose + 2 repairs) must fit well inside the 300 s
#: staleness window, so the per-call timeout is clamped to 5..90 s.
MIN_TIMEOUT_S, MAX_TIMEOUT_S = 5.0, 90.0

# -- fixed product bounds (contract §2 / §5) ---------------------------------
MAX_MESSAGE_CHARS = 2000
HISTORY_TURNS = 10
MAX_REPAIRS = 2
STALE_AFTER_S = 300
#: The job stops starting new TED calls this long after it began (a call that
#: is still running is bounded by the HTTP timeout), so the result is always
#: stored before the job reads as stale.
JOB_DEADLINE_S = 280
CONVERSATION_TTL_S = 24 * 3600
RETENTION_DAYS = 90
RETENTION_BATCH = 500
RATE_PER_MINUTE = 6
MAX_EXTERNAL_NUMBERS = 20
MAX_NODES = 60
MAX_EDGES = 300
MAX_NEW_PROMPTS = 20
MAX_PROMPT_CHARS = 1000
MAX_ENCODED_BODY_BYTES = 256 * 1024

_TOKEN_OK = re.compile(r"^[\x21-\x7e]+$")   # printable ASCII, no spaces (an HTTP header value)
_warned: dict[str, float] = {}


def _warn_once(key: str, message: str) -> None:
    now = time.monotonic()
    if now - _warned.get(key, -1e9) >= 300:
        _warned[key] = now
        logger.error(message)


def enabled() -> bool:
    return os.getenv(ENV_ENABLED, "").strip().lower() == "true"


def ted_base_url() -> Optional[str]:
    """The validated TED base URL (no trailing slash), or None."""
    raw = (os.getenv(ENV_BASE_URL) or "").strip()
    if not raw:
        return None
    try:
        parts = urlsplit(raw)
        host = parts.hostname or ""
        _ = parts.port  # raises ValueError on a malformed port
    except ValueError:
        parts, host = None, ""
    ok = parts is not None and parts.scheme in ("https", "http") and bool(host) \
        and not parts.username and not parts.password and not parts.query \
        and not parts.fragment
    if ok and parts.scheme == "http" and not _plain_http_allowed(host):
        ok = False
    if not ok:
        _warn_once("url", f"ivr assist: {ENV_BASE_URL} is not a usable https:// URL — the "
                          "flow assistant is unavailable")
        return None
    return raw.rstrip("/")


def _plain_http_allowed(host: str) -> bool:
    """http:// only for a loopback address or a single-label (container) name."""
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host == "localhost" or "." not in host


def ted_token() -> Optional[str]:
    """The assist token, or None. NEVER log or return this to a client."""
    raw = (os.getenv(ENV_TOKEN) or "").strip()
    if not raw:
        return None
    if not _TOKEN_OK.match(raw):
        _warn_once("token", f"ivr assist: {ENV_TOKEN} contains characters an HTTP header "
                            "cannot carry — the flow assistant is unavailable")
        return None
    return raw


def ted_configured() -> bool:
    return ted_base_url() is not None and ted_token() is not None


def platform_available() -> bool:
    """The platform half of ``summary.assist.available``."""
    return enabled() and ted_configured()


def _int_env(name: str, default: int, lo: int, hi: int) -> int:
    try:
        value = int((os.getenv(name) or "").strip() or default)
    except ValueError:
        value = default
    return min(max(value, lo), hi)


def daily_cap() -> int:
    return _int_env(ENV_DAILY, DEFAULT_DAILY, 1, 100_000)


def ted_timeout_s() -> float:
    try:
        value = float((os.getenv(ENV_TIMEOUT) or "").strip() or DEFAULT_TIMEOUT_S)
    except ValueError:
        value = DEFAULT_TIMEOUT_S
    return min(max(value, MIN_TIMEOUT_S), MAX_TIMEOUT_S)


def ted_url() -> Optional[str]:
    base = ted_base_url()
    return f"{base}{TED_PATH}" if base else None
