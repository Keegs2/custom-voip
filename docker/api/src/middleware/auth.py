"""
JWT Authentication Middleware.
Intercepts all requests (except exempt paths), validates the Bearer token,
and attaches decoded claims to request.state.user for downstream dependencies.
"""
import logging
import re

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from jose import JWTError

from auth.security import decode_access_token

logger = logging.getLogger(__name__)

# Paths that never require authentication
EXEMPT_PATHS = {
    "/auth/login",
    "/v1/auth/login",
    "/health",
    "/health/detailed",
    "/docs",
    "/redoc",
    "/openapi.json",
    "/",
}

# Encrypted voicemail (docs/ENCRYPTED_VOICEMAIL_INTERFACES.md §3).
# FreeSWITCH-facing endpoints authenticate with X-Ingest-Secret INSIDE the
# router (auth/ingest.py require_ingest_secret) — every route under these
# prefixes MUST carry that dependency.
VOICEMAIL_FS_PREFIXES = ("/v1/voicemail/fs/", "/voicemail/fs/")
# Audio playback authenticates with the short-lived playback token (?t=)
# INSIDE the router (auth/playback.py verify_playback_token). GET/HEAD only.
# fullmatch + re.ASCII: no trailing-newline match, ASCII digits only.
VOICEMAIL_AUDIO_RE = re.compile(
    r"^/(v1/)?voicemail/(messages|greetings)/\d+/audio$", re.ASCII)


def _has_dot_segment(path: str) -> bool:
    return any(seg in (".", "..") for seg in path.split("/"))


def _has_control_char(path: str) -> bool:
    return any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in path)


def is_voicemail_exempt(path: str, method: str) -> bool:
    """True for the voicemail paths that authenticate inside the router.

    ``path`` must be the ROUTER's view of the path (``scope["path"]``), not
    ``request.url.path``: the latter goes through urlsplit, which silently
    drops tab/CR/LF, so the two can disagree. Any control character refuses
    the exemption outright.
    """
    if _has_control_char(path):
        return False
    if path.startswith(VOICEMAIL_FS_PREFIXES):
        # A dot segment never matches a real route; refuse to exempt it so a
        # non-normalizing proxy can never walk out of the fs/ prefix.
        return not _has_dot_segment(path)
    if method in ("GET", "HEAD") and VOICEMAIL_AUDIO_RE.fullmatch(path):
        return True
    return False


class JWTAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        # CORS preflight must always pass through
        if request.method == "OPTIONS":
            return await call_next(request)

        # Exempt static paths
        if path in EXEMPT_PATHS:
            return await call_next(request)

        # Exempt FreeSWITCH endpoints (called without auth over Docker loopback)
        if path.startswith("/freeswitch/"):
            return await call_next(request)

        # Allow unauthenticated POST to onboarding intake (public form submission)
        if path in ("/v1/onboarding", "/onboarding") and request.method == "POST":
            return await call_next(request)

        # Exempt FreeSWITCH ingest endpoints (called without auth over Docker network)
        if path.endswith("/cdrs/ingest") or path.endswith("/cdrs/ingest/bulk"):
            return await call_next(request)

        # Exempt the carrier-status poller ingest (POST only). The SBC pollers
        # authenticate with a SHARED BEARER token checked inside the router
        # against CARRIER_STATUS_TOKEN — NOT a JWT — so it must bypass JWT
        # validation here. The GET /carrier-status read stays JWT admin-only.
        if path.endswith("/carrier-status/report") and request.method == "POST":
            return await call_next(request)

        # Exempt the live-trunk-stats feeder ingest (POST only). The SBC feeders
        # authenticate with a SHARED BEARER token checked inside the router
        # against LIVE_TRUNK_STATS_TOKEN — NOT a JWT — so it must bypass JWT
        # validation here. The GET /live-trunk-stats read stays JWT admin-only.
        if path.endswith("/live-trunk-stats/report") and request.method == "POST":
            return await call_next(request)

        # WebSocket connections authenticate via query param, not header
        if path.startswith("/ws/"):
            return await call_next(request)

        # Encrypted voicemail: FS endpoints (X-Ingest-Secret) and audio
        # playback (playback token) authenticate inside the router.
        if is_voicemail_exempt(request.scope.get("path", path), request.method):
            return await call_next(request)

        # Require a valid Bearer SESSION JWT for everything else.
        # decode_access_token rejects any token whose `typ` claim is present
        # and is not "session" (e.g. a voicemail playback token), so a
        # non-session token can never authenticate an API call.
        auth_header = request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            token = auth_header[7:]  # Strip "Bearer " prefix
            try:
                request.state.user = decode_access_token(token)
                return await call_next(request)
            except JWTError as exc:
                logger.debug("JWT decode failed: %s", exc)

        return JSONResponse(
            status_code=401,
            content={"detail": "Not authenticated"},
        )
