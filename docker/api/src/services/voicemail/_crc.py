"""CRC32C (Castagnoli) helper — lazy google-crc32c import (package-private).

CRC32C is what Cloud KMS (``*_crc32c`` request/response fields) and Cloud
Storage (object ``crc32c`` metadata) use for end-to-end integrity. It is a
transport/storage checksum, NOT a MAC — authenticity comes from AES-GCM + AAD.
"""
from __future__ import annotations

import logging

from .errors import VoicemailCryptoUnavailable

logger = logging.getLogger(__name__)

_impl = None


def crc32c(data: bytes | bytearray | memoryview) -> int:
    """Unsigned 32-bit CRC32C of ``data`` (0 .. 2**32-1)."""
    global _impl
    if _impl is None:
        try:
            import google_crc32c
        except ImportError as exc:  # pragma: no cover - dependency missing
            raise VoicemailCryptoUnavailable("google-crc32c is not installed") from exc
        if getattr(google_crc32c, "implementation", "c") != "c":
            logger.warning("google-crc32c is using the slow pure-Python implementation")
        _impl = google_crc32c.value
    return int(_impl(bytes(data)))
