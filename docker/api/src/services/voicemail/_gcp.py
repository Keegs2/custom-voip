"""Shared GCP plumbing for the voicemail KMS + GCS clients (package-private).

* Credentials: Application Default Credentials (the VM's attached service
  account via the metadata server, or a key file named by
  ``GOOGLE_APPLICATION_CREDENTIALS``); when ``VOICEMAIL_IMPERSONATE_SA`` is set,
  those source credentials are used to mint short-lived tokens for that SA
  (``google.auth.impersonated_credentials``, scope cloud-platform). Built
  lazily, once per (process, SA) — importing this module needs no credentials.
* Bounded retries: every blocking client call runs on a DEDICATED thread
  pool (``IO_THREADS`` = 16 threads per worker process, NOT the loop's
  default executor — that one is only min(32, cpu+4) threads and also serves
  ``loop.getaddrinfo``, so slow GCS uploads must never starve DNS for the rest
  of the API) with an explicit per-attempt timeout passed by the caller and at
  most ``attempts`` tries with a fixed short backoff. The client libraries'
  own retry is always disabled by the callers (``retry=None``) so the two
  never compound into minute-long stalls on the request path.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import functools
import logging
import os
import threading
from typing import Any, Callable, TypeVar

from .config import VoicemailConfig
from .errors import VoicemailCryptoUnavailable

logger = logging.getLogger(__name__)

CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
#: Lifetime of an impersonated access token (seconds; refreshed automatically).
IMPERSONATION_LIFETIME_S = 3600

T = TypeVar("T")

_creds_lock = threading.Lock()
_creds_cache: dict[str, Any] = {}


def get_credentials(cfg: VoicemailConfig):
    """Return (cached) google.auth credentials for the voicemail clients.

    Blocking (may hit the metadata server) — call from a worker thread.
    Raises VoicemailCryptoUnavailable when no usable credentials exist.
    """
    cache_key = cfg.impersonate_sa or "<adc>"
    with _creds_lock:
        cached = _creds_cache.get(cache_key)
        if cached is not None:
            return cached
        try:
            import google.auth
            from google.auth import exceptions as auth_exceptions
            from google.auth import impersonated_credentials
        except ImportError as exc:  # pragma: no cover - dependency missing
            raise VoicemailCryptoUnavailable(
                "google-auth is not installed in this image") from exc

        # docker-compose passes GOOGLE_APPLICATION_CREDENTIALS through as ""
        # when unset; older google-auth versions treat "" as a file path.
        if os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", None) == "":
            os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)

        try:
            source, _project = google.auth.default(scopes=[CLOUD_PLATFORM_SCOPE])
        except auth_exceptions.DefaultCredentialsError as exc:
            raise VoicemailCryptoUnavailable(
                "no Application Default Credentials available for voicemail KMS/GCS") from exc

        creds = source
        if cfg.impersonate_sa:
            creds = impersonated_credentials.Credentials(
                source_credentials=source,
                target_principal=cfg.impersonate_sa,
                target_scopes=[CLOUD_PLATFORM_SCOPE],
                lifetime=IMPERSONATION_LIFETIME_S,
            )
            logger.info("voicemail: using impersonated credentials for %s", cfg.impersonate_sa)
        _creds_cache[cache_key] = creds
        return creds


def reset_credentials_cache() -> None:
    """Test hook: forget cached credentials."""
    with _creds_lock:
        _creds_cache.clear()


#: Backoff before attempt 2 and attempt 3 (seconds). Module-level so tests can
#: zero it.
RETRY_BACKOFF_S: tuple[float, ...] = (0.2, 0.6)

#: Threads per API worker process for blocking KMS/GCS calls (deposit
#: concurrency is capped at 20 by the router; 16 keeps the pool from being the
#: bottleneck without letting voicemail I/O monopolise the process).
IO_THREADS = 16

_executor_lock = threading.Lock()
_executor: concurrent.futures.ThreadPoolExecutor | None = None


def _io_executor() -> concurrent.futures.ThreadPoolExecutor:
    global _executor
    if _executor is None:
        with _executor_lock:
            if _executor is None:
                _executor = concurrent.futures.ThreadPoolExecutor(
                    max_workers=IO_THREADS, thread_name_prefix="vm-io")
    return _executor


async def call_with_retries(
    op: str,
    fn: Callable[[], T],
    *,
    retryable: tuple[type[BaseException], ...],
    attempts: int = 3,
) -> T:
    """Run blocking ``fn`` in a worker thread, retrying ``retryable`` errors.

    ``fn`` must apply its own per-attempt timeout (the RPC ``timeout=``) and
    disable the client library's built-in retry. Non-retryable exceptions
    propagate unchanged on the first occurrence; the last retryable one is
    re-raised after ``attempts`` tries so the caller can translate it.
    """
    last: BaseException | None = None
    for attempt in range(1, attempts + 1):
        try:
            return await asyncio.get_running_loop().run_in_executor(_io_executor(), fn)
        except retryable as exc:  # type: ignore[misc]
            last = exc
            logger.warning("voicemail %s: transient %s (attempt %d/%d)",
                           op, type(exc).__name__, attempt, attempts)
            if attempt < attempts:
                delay = RETRY_BACKOFF_S[min(attempt - 1, len(RETRY_BACKOFF_S) - 1)]
                if delay > 0:
                    await asyncio.sleep(delay)
    assert last is not None
    raise last


@functools.lru_cache(maxsize=None)
def exception_types(names: tuple[tuple[str, str], ...]) -> tuple[type[BaseException], ...]:
    """Resolve ``(module, attr)`` pairs to exception classes, skipping any that
    the installed library versions do not provide (cached)."""
    out: list[type[BaseException]] = []
    for module_name, attr in names:
        try:
            module = __import__(module_name, fromlist=[attr])
            cls = getattr(module, attr)
        except (ImportError, AttributeError):
            continue
        if isinstance(cls, type) and issubclass(cls, BaseException):
            out.append(cls)
    return tuple(out)
