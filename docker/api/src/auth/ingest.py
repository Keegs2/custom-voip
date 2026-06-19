"""Shared-secret authentication for FreeSWITCH → API ingest endpoints (SEC-2).

The media/CDR/voicemail/recording ingest endpoints are JWT-EXEMPT in the auth
middleware because FreeSWITCH calls them without a user token. That exemption
previously left them fully open: anyone able to reach the API could forge CDRs,
voicemails, or recordings, and trust was derived solely from the body's
``customer_id``. This module closes that hole with a shared secret.

CONTRACT (shared with the FreeSWITCH/Lua side):
  * The API reads the secret from env ``INGEST_SHARED_SECRET``.
  * FreeSWITCH sends it on every ingest POST as the header ``X-Ingest-Secret``.
  * Comparison is constant-time (:func:`hmac.compare_digest`).

Dev fallback: when ``INGEST_SHARED_SECRET`` is unset, ingest is allowed but a
loud warning is logged ONCE so local dev keeps working. **Production MUST set
``INGEST_SHARED_SECRET``** (and FreeSWITCH must send the matching header), or the
ingest endpoints stay open. This is asserted by the lessons guard and the deploy
docs.
"""
import os
import hmac
import logging

from fastapi.responses import ORJSONResponse

logger = logging.getLogger(__name__)

# Read once at import. Set per-VM in /opt/revup/.env (Services VM) in production.
INGEST_SHARED_SECRET = os.getenv("INGEST_SHARED_SECRET", "")

# Header FreeSWITCH sends the shared secret in.
INGEST_SECRET_HEADER = "X-Ingest-Secret"

_warned_unset = False


def ingest_secret_ok(request) -> bool:
    """Return True iff the request is authorised to call an ingest endpoint.

    * Secret configured  -> constant-time compare of the ``X-Ingest-Secret``
      header against ``INGEST_SHARED_SECRET``.
    * Secret unset (dev) -> allow, logging a loud one-time warning. Production
      MUST set the secret.
    """
    global _warned_unset
    if not INGEST_SHARED_SECRET:
        if not _warned_unset:
            logger.warning(
                "SECURITY: INGEST_SHARED_SECRET is UNSET — ingest endpoints "
                "(/cdrs/ingest, /cdrs/ingest/bulk, /voicemail/ingest, "
                "/recordings/ingest) are UNAUTHENTICATED. This is acceptable for "
                "local dev ONLY. Production MUST set INGEST_SHARED_SECRET and "
                "configure FreeSWITCH to send the X-Ingest-Secret header."
            )
            _warned_unset = True
        return True
    provided = request.headers.get(INGEST_SECRET_HEADER, "") or ""
    return hmac.compare_digest(provided, INGEST_SHARED_SECRET)


def ingest_auth_error() -> ORJSONResponse:
    """Standard 401 response for an ingest call missing/with a wrong secret.

    A 401 here does NOT violate the "always 200 to avoid FS retry storms" rule:
    that rule is about PROCESSING errors (FS sends valid data, we ack). An auth
    failure means the caller is not the trusted FreeSWITCH (which always sends the
    secret in production), so rejecting it is correct and never loops a real FS.
    """
    return ORJSONResponse(
        status_code=401,
        content={"status": "error", "detail": "invalid or missing ingest secret"},
    )
