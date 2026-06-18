"""File-upload security primitives (Phase 4).

Centralises the controls applied to every user-supplied file (chat attachments
and shared documents):

* **content-type allowlist** — env-tunable, sane defaults.
* **max-size limit** — env-tunable, sane defaults.
* **filename sanitisation** — strip path components / null bytes (no traversal).
* **pluggable AV-scan hook** — an interface plus a no-op default that logs; a
  real scanner (e.g. ClamAV/clamd) is wired in by env without touching callers.

Violations raise :class:`UploadRejected`, which routers translate to a 4xx.
"""
import logging
import os
import socket
from dataclasses import dataclass
from typing import Iterable, Optional

logger = logging.getLogger(__name__)


class UploadRejected(Exception):
    """Raised when an upload violates a security policy.

    ``status_code`` is the HTTP status the router should return (413 for
    too-large, 415 for disallowed type, 400/422 for malformed, 422 for an
    AV hit).
    """

    def __init__(self, detail: str, status_code: int = 400):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


# --------------------------------------------------------------------------
# Policy configuration (env-tunable)
# --------------------------------------------------------------------------
def _parse_size(raw: str, default: int) -> int:
    try:
        return int(raw)
    except (TypeError, ValueError):
        return default


# Defaults: 25MB for chat attachments, 50MB for documents.
CHAT_MAX_FILE_SIZE = _parse_size(os.getenv("CHAT_MAX_FILE_SIZE", ""), 25 * 1024 * 1024)
DOCUMENTS_MAX_FILE_SIZE = _parse_size(os.getenv("DOCUMENTS_MAX_FILE_SIZE", ""), 50 * 1024 * 1024)

# A conservative default allowlist covering the common office / media / archive
# types users actually share. Override with a comma-separated env list.
_DEFAULT_ALLOWED = {
    # images
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/svg+xml",
    # documents
    "application/pdf", "text/plain", "text/csv", "text/markdown",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/rtf",
    # audio / video (voicemail forwards, screen recordings)
    "audio/mpeg", "audio/wav", "audio/x-wav", "audio/webm", "audio/ogg",
    "video/mp4", "video/webm", "video/quicktime",
    # archives / data
    "application/zip", "application/json",
    "application/octet-stream",
}


def _allowed_types() -> set:
    raw = os.getenv("UPLOAD_ALLOWED_CONTENT_TYPES", "")
    if not raw.strip():
        return set(_DEFAULT_ALLOWED)
    return {t.strip().lower() for t in raw.split(",") if t.strip()}


ALLOWED_CONTENT_TYPES = _allowed_types()


# --------------------------------------------------------------------------
# Filename sanitisation
# --------------------------------------------------------------------------
def sanitize_filename(filename: Optional[str]) -> str:
    """Return a safe basename: no path separators, no null bytes, no traversal.

    Always yields a non-empty name; falls back to ``upload`` when the input
    sanitises to nothing.
    """
    name = (filename or "").replace("\x00", "")
    # Defeat both POSIX and Windows separators before basename.
    name = name.replace("\\", "/")
    name = os.path.basename(name)
    name = name.strip().strip(".")  # no leading dots / trailing dots -> hidden/empty
    # Collapse anything still suspicious.
    if name in ("", ".", ".."):
        return "upload"
    return name


# --------------------------------------------------------------------------
# Content-type + size validation
# --------------------------------------------------------------------------
def validate_content_type(content_type: Optional[str], allowed: Optional[Iterable[str]] = None) -> str:
    """Validate the declared MIME type against the allowlist.

    Returns the normalised content-type. Raises UploadRejected (415) if the
    type is missing or not permitted.
    """
    allow = {t.lower() for t in (allowed or ALLOWED_CONTENT_TYPES)}
    ct = (content_type or "").split(";")[0].strip().lower()
    if not ct:
        raise UploadRejected("A Content-Type is required for uploads", status_code=415)
    if ct not in allow:
        raise UploadRejected(
            f"Content-Type '{ct}' is not allowed", status_code=415
        )
    return ct


def validate_size(size: int, max_size: int) -> None:
    """Raise UploadRejected if ``size`` is empty (400) or over ``max_size`` (413)."""
    if size <= 0:
        raise UploadRejected("Empty file", status_code=400)
    if size > max_size:
        raise UploadRejected(
            f"File too large. Maximum size is {max_size // (1024 * 1024)}MB",
            status_code=413,
        )


# --------------------------------------------------------------------------
# Pluggable AV-scan hook
# --------------------------------------------------------------------------
@dataclass
class ScanResult:
    clean: bool
    detail: str = "ok"


class AVScanner:
    """Interface for antivirus scanners. Implementations scan raw bytes."""

    def scan(self, data: bytes, filename: str) -> ScanResult:  # pragma: no cover - interface
        raise NotImplementedError


class NoopScanner(AVScanner):
    """Default scanner: does not scan, logs that it was bypassed, returns clean.

    This keeps the call sites identical to a real deployment so wiring a real
    engine is a pure-config change (no code edits at the routers).
    """

    def scan(self, data: bytes, filename: str) -> ScanResult:
        logger.info(
            "AV scan bypassed (noop backend): file=%s bytes=%d. "
            "Set AV_SCAN_BACKEND=clamav (+AV_SCAN_HOST/PORT) for real scanning.",
            filename, len(data),
        )
        return ScanResult(clean=True, detail="noop")


class ClamAVScanner(AVScanner):
    """Real scanner: streams the payload to a clamd daemon via INSTREAM.

    Wired in by setting ``AV_SCAN_BACKEND=clamav`` and ``AV_SCAN_HOST`` /
    ``AV_SCAN_PORT`` (default 3310). Fails *closed* on a definitive virus hit
    and fails *open* (logs) if clamd is unreachable, so a scanner outage does
    not take uploads down — flip AV_SCAN_FAIL_CLOSED=true to invert that.
    """

    def __init__(self, host: str, port: int):
        self.host = host
        self.port = port
        self.fail_closed = os.getenv("AV_SCAN_FAIL_CLOSED", "false").lower() == "true"

    def scan(self, data: bytes, filename: str) -> ScanResult:
        try:
            with socket.create_connection((self.host, self.port), timeout=10) as s:
                s.sendall(b"zINSTREAM\x00")
                # clamd INSTREAM: <4-byte length><chunk> ... <4-byte 0>
                view = memoryview(data)
                chunk = 64 * 1024
                for i in range(0, len(view), chunk):
                    part = view[i:i + chunk]
                    s.sendall(len(part).to_bytes(4, "big") + part)
                s.sendall((0).to_bytes(4, "big"))
                resp = s.recv(4096).decode("utf-8", "replace").strip()
        except OSError as e:
            logger.warning("clamd unreachable (%s); fail_closed=%s", e, self.fail_closed)
            if self.fail_closed:
                return ScanResult(clean=False, detail=f"scanner unavailable: {e}")
            return ScanResult(clean=True, detail="scanner unavailable (fail-open)")

        if "FOUND" in resp:
            return ScanResult(clean=False, detail=resp)
        return ScanResult(clean=True, detail=resp or "OK")


_scanner: Optional[AVScanner] = None


def get_scanner() -> AVScanner:
    """Return the configured AV scanner (cached). Selected via AV_SCAN_BACKEND."""
    global _scanner
    if _scanner is not None:
        return _scanner
    backend = os.getenv("AV_SCAN_BACKEND", "noop").lower()
    if backend == "clamav":
        host = os.getenv("AV_SCAN_HOST", "clamav")
        port = int(os.getenv("AV_SCAN_PORT", "3310"))
        _scanner = ClamAVScanner(host, port)
    else:
        if backend != "noop":
            logger.warning("Unknown AV_SCAN_BACKEND=%r; falling back to noop", backend)
        _scanner = NoopScanner()
    return _scanner


def scan_or_reject(data: bytes, filename: str) -> None:
    """Run the configured AV scan; raise UploadRejected(422) on a virus hit."""
    result = get_scanner().scan(data, filename)
    if not result.clean:
        logger.warning("AV scan rejected upload %s: %s", filename, result.detail)
        raise UploadRejected(f"File rejected by malware scan: {result.detail}", status_code=422)


def validate_upload(
    *,
    content_type: Optional[str],
    size: int,
    max_size: int,
    data: bytes,
    filename: Optional[str],
    allowed: Optional[Iterable[str]] = None,
) -> str:
    """One-shot gate: type + size + AV scan. Returns the sanitised filename.

    Raises UploadRejected (with the right status_code) on any violation.
    """
    safe_name = sanitize_filename(filename)
    validate_size(size, max_size)
    validate_content_type(content_type, allowed)
    scan_or_reject(data, safe_name)
    return safe_name
