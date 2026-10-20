"""uvicorn access-log redaction of the voicemail playback token (?t=).

The playback URL ``/v1/voicemail/messages/{id}/audio?t=<token>`` would be
printed verbatim by uvicorn's access logger. ``utils/access_log.py`` attaches
a filter to the ``uvicorn.access`` logger ONLY that rewrites ``t=<value>`` to
``t=<redacted>`` and leaves everything else on the line intact.

Covers: a record built exactly like uvicorn's httptools/h11 protocols build it
(``'%s - "%s %s HTTP/%s" %d'`` + 5 args) formatted with uvicorn's own
``AccessFormatter`` and with a plain Formatter; other parameters, a
percent-encoded key, a preformatted message; idempotent install; other
loggers untouched; and a FRESH process that runs uvicorn's per-worker
``configure_logging()`` and then imports ``main`` (exactly what each of the
``--workers 4`` processes does) prints no token.

Run:  JWT_SECRET_KEY=x python -m pytest tests/test_access_log_redaction.py -q
"""
import logging
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
if str(API_SRC) not in sys.path:
    sys.path.insert(0, str(API_SRC))

from utils.access_log import (  # noqa: E402
    AccessLogRedactor,
    install_access_log_redaction,
    redact_secret_params,
)

TOKEN = "abc.def.ghi"
PATH = f"/v1/voicemail/messages/7/audio?t={TOKEN}"


def uvicorn_access_record(full_path: str) -> logging.LogRecord:
    """The record uvicorn's access logger creates (protocols/http/*_impl.py)."""
    return logging.LogRecord(
        "uvicorn.access", logging.INFO, __file__, 1, '%s - "%s %s HTTP/%s" %d',
        ("10.142.0.5:51234", "GET", full_path, "1.1", 206), None)


def test_uvicorn_access_record_token_is_redacted():
    uvicorn_logging = pytest.importorskip("uvicorn.logging")
    record = uvicorn_access_record(PATH)
    assert AccessLogRedactor().filter(record) is True  # never drops the line
    fmt = uvicorn_logging.AccessFormatter(
        '%(levelprefix)s %(client_addr)s - "%(request_line)s" %(status_code)s', use_colors=False)
    line = fmt.format(record)
    assert TOKEN not in line
    assert line.endswith(
        '10.142.0.5:51234 - "GET /v1/voicemail/messages/7/audio?t=<redacted> HTTP/1.1" '
        '206 Partial Content')
    plain = logging.Formatter("%(message)s").format(uvicorn_access_record(PATH))
    assert TOKEN in plain  # sanity: an unfiltered record DOES carry it
    record = uvicorn_access_record(PATH)
    AccessLogRedactor().filter(record)
    assert logging.Formatter("%(message)s").format(record) == (
        '10.142.0.5:51234 - "GET /v1/voicemail/messages/7/audio?t=<redacted> HTTP/1.1" 206')


@pytest.mark.parametrize("raw, expected", [
    ("/x?t=abc.def.ghi", "/x?t=<redacted>"),
    ("/x?a=1&t=abc.def.ghi&b=2", "/x?a=1&t=<redacted>&b=2"),
    ("/x?%74=abc.def.ghi", "/x?%74=<redacted>"),          # percent-encoded key
    ("/x?t=", "/x?t=<redacted>"),
    ("/x?tt=keep&at=keep&T=keep", "/x?tt=keep&at=keep&T=keep"),  # only exactly `t`
    ("/x?t", "/x?t"),
    ("/v1/voicemail/summary", "/v1/voicemail/summary"),
    ('1.2.3.4:5 - "GET /a?t=abc.def.ghi HTTP/1.1" 200', '1.2.3.4:5 - "GET /a?t=<redacted> HTTP/1.1" 200'),
])
def test_redact_secret_params(raw, expected):
    assert redact_secret_params(raw) == expected


def test_preformatted_message_and_non_string_args():
    rec = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1,
                            f'1.2.3.4:5 - "GET {PATH} HTTP/1.1" 200', None, None)
    AccessLogRedactor().filter(rec)
    assert TOKEN not in rec.getMessage()
    rec = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, "%s %d",
                            (PATH, 200), None)
    AccessLogRedactor().filter(rec)
    assert rec.args == ("/v1/voicemail/messages/7/audio?t=<redacted>", 200)


def test_install_is_idempotent_and_scoped_to_uvicorn_access():
    access = logging.getLogger("uvicorn.access")
    saved = list(access.filters)
    try:
        for f in list(access.filters):
            access.removeFilter(f)
        install_access_log_redaction()
        install_access_log_redaction()
        assert sum(isinstance(f, AccessLogRedactor) for f in access.filters) == 1
        for name in ("", "uvicorn", "uvicorn.error", "services.voicemail.deposit"):
            assert not any(isinstance(f, AccessLogRedactor)
                           for f in logging.getLogger(name).filters), name

        captured = []

        class Capture(logging.Handler):
            def emit(self, record):
                captured.append(self.format(record))

        handler = Capture()
        access.addHandler(handler)
        old_level, old_propagate = access.level, access.propagate
        access.setLevel(logging.INFO)
        access.propagate = False
        try:
            access.info('%s - "%s %s HTTP/%s" %d', "10.0.0.1:1", "GET", PATH, "1.1", 200)
            logging.getLogger("uvicorn.error").addHandler(handler)
            logging.getLogger("uvicorn.error").error("other logger keeps %s", PATH)
        finally:
            access.removeHandler(handler)
            logging.getLogger("uvicorn.error").removeHandler(handler)
            access.setLevel(old_level)
            access.propagate = old_propagate
        assert captured[0] == '10.0.0.1:1 - "GET /v1/voicemail/messages/7/audio?t=<redacted> HTTP/1.1" 200'
        assert captured[1] == f"other logger keeps {PATH}"  # untouched by design
    finally:
        for f in list(access.filters):
            access.removeFilter(f)
        for f in saved:
            access.addFilter(f)


def test_fresh_uvicorn_worker_process_redacts():
    """What each `uvicorn main:app --workers 4` child does: uvicorn's
    configure_logging() (dictConfig) FIRST, then import main:app. The access
    line it prints must not contain the token."""
    pytest.importorskip("uvicorn")
    script = (
        "import logging, sys\n"
        "from uvicorn.config import Config\n"
        "Config('main:app', log_level='info').configure_logging()\n"
        "import main  # noqa: F401\n"
        "logging.getLogger('uvicorn.access').info("
        "'%s - \"%s %s HTTP/%s\" %d', '10.142.0.5:1', 'GET', sys.argv[1], '1.1', 206)\n"
    )
    env = {**os.environ, "JWT_SECRET_KEY": os.environ.get("JWT_SECRET_KEY", "x"),
           "PYTHONPATH": str(API_SRC)}
    out = subprocess.run([sys.executable, "-c", script, PATH], cwd=str(API_SRC), env=env,
                         capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    combined = out.stdout + out.stderr
    assert "/v1/voicemail/messages/7/audio?t=<redacted> HTTP/1.1" in combined, combined
    assert TOKEN not in combined
