"""Redact secret query parameters from uvicorn's access log.

The voicemail playback URL carries its short-lived token in the query string
(``/v1/voicemail/messages/{id}/audio?t=<token>`` — an ``<audio src>`` cannot
send headers), and uvicorn's access logger prints the full path WITH the
query string (``uvicorn.protocols.utils.get_path_with_query_string``), so the
token would land in ``docker logs`` of the API container.

:class:`AccessLogRedactor` is a ``logging.Filter`` attached to the
``uvicorn.access`` logger ONLY. It rewrites the value of every query
parameter named ``t`` (also when the key is percent-encoded, e.g. ``%74`` —
Starlette decodes keys before the router reads them) to ``<redacted>`` and
leaves the rest of the line untouched: client address, method, path, other
parameters, HTTP version and status keep their exact text, and the record's
``args`` keep their shape (uvicorn's ``AccessFormatter`` unpacks exactly five).
It never drops a record and never raises.

Install with :func:`install_access_log_redaction` — idempotent. ``main.py``
calls it at import time AND in the lifespan startup: with
``uvicorn --workers 4`` every worker process runs uvicorn's
``configure_logging()`` (dictConfig) BEFORE it imports ``main:app``, so both
points come after uvicorn's logging setup in every worker.
"""
from __future__ import annotations

import logging
import re
from urllib.parse import unquote_plus

ACCESS_LOGGER = "uvicorn.access"
REDACTED = "<redacted>"
#: Query parameter names whose VALUES never reach the access log.
SECRET_PARAMS = frozenset({"t"})

# '?' then the query up to whitespace or a double quote (the end of the
# request line in a preformatted message).
_QUERY_RE = re.compile(r'\?([^\s"]*)')


def _redact_query(match: re.Match) -> str:
    parts = match.group(1).split("&")
    out = []
    for part in parts:
        key, sep, _value = part.partition("=")
        if sep and unquote_plus(key) in SECRET_PARAMS:
            out.append(f"{key}={REDACTED}")
        else:
            out.append(part)
    return "?" + "&".join(out)


def redact_secret_params(text: str) -> str:
    """``/a?x=1&t=tok&y=2`` -> ``/a?x=1&t=<redacted>&y=2``; text without a
    query is returned unchanged."""
    if "?" not in text:
        return text
    return _QUERY_RE.sub(_redact_query, text)


class AccessLogRedactor(logging.Filter):
    """Redacts ``t=`` values in uvicorn access-log records (args or a
    preformatted message). Always lets the record through."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            args = record.args
            if isinstance(args, tuple) and args:
                record.args = tuple(redact_secret_params(a) if isinstance(a, str) else a
                                    for a in args)
            elif isinstance(args, dict) and args:
                record.args = {k: redact_secret_params(v) if isinstance(v, str) else v
                               for k, v in args.items()}
            elif isinstance(record.msg, str):
                record.msg = redact_secret_params(record.msg)
        except Exception:  # noqa: BLE001 — a log filter must never break logging
            pass
        return True


def install_access_log_redaction() -> None:
    """Attach the redactor to the ``uvicorn.access`` logger (once)."""
    logger = logging.getLogger(ACCESS_LOGGER)
    if not any(isinstance(f, AccessLogRedactor) for f in logger.filters):
        logger.addFilter(AccessLogRedactor())
