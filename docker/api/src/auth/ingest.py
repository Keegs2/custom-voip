"""Shared-secret authentication for FreeSWITCH -> API voicemail endpoints.

Contract: docs/ENCRYPTED_VOICEMAIL_INTERFACES.md §3 / §5. The ``/v1/voicemail/fs/``
and ``/voicemail/fs/`` prefixes are JWT-exempt in ``middleware/auth.py``;
EVERY route under them must depend on :func:`require_ingest_secret`.

* FreeSWITCH sends ``X-Ingest-Secret: <secret>`` (read by curl from a
  root-only header file, never on argv).
* The API compares it with ``INGEST_SHARED_SECRET`` in constant time.
* FAIL CLOSED (fixes build-plan defect 3): when ``INGEST_SHARED_SECRET`` is
  unset or shorter than 32 characters, EVERY call is rejected with 503 and an
  ERROR log — there is no "dev mode" that lets unauthenticated deposits in.
* The header value is never logged.

Usage::

    router = APIRouter()

    @router.post("/fs/deposit", dependencies=[Depends(require_ingest_secret)])
    async def deposit(...): ...
"""
from __future__ import annotations

import hmac
import logging

from fastapi import HTTPException, Request

from services.voicemail.config import MIN_SECRET_CHARS, ingest_secret

logger = logging.getLogger(__name__)

#: Header FreeSWITCH sends the shared secret in.
INGEST_SECRET_HEADER = "X-Ingest-Secret"


def ingest_secret_configured() -> bool:
    """True iff INGEST_SHARED_SECRET is set and long enough to be used."""
    return ingest_secret() is not None


async def require_ingest_secret(request: Request) -> None:
    """FastAPI dependency: authenticate a FreeSWITCH ingest call.

    503 when the API has no usable secret configured (fail closed),
    401 when the header is missing or wrong.
    """
    secret = ingest_secret()
    if secret is None:
        logger.error(
            "INGEST_SHARED_SECRET is unset or shorter than %d characters — rejecting "
            "FreeSWITCH voicemail call to %s (fail closed). Set it in the services "
            ".env and in /opt/revup/secrets/vm_ingest.header on every FS node.",
            MIN_SECRET_CHARS, request.url.path)
        raise HTTPException(status_code=503, detail="ingest authentication is not configured")

    provided = request.headers.get(INGEST_SECRET_HEADER)
    # Compare bytes: a non-ASCII header value must be a clean mismatch, never
    # a TypeError (hmac.compare_digest refuses non-ASCII str).
    if provided is None or not hmac.compare_digest(
            provided.encode("utf-8", "surrogateescape"),
            secret.encode("utf-8", "surrogateescape")):
        logger.warning("voicemail ingest auth failed for %s from %s", request.url.path,
                       request.client.host if request.client else "?")
        raise HTTPException(status_code=401, detail="invalid or missing ingest secret")
