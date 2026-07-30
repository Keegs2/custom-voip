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
from auth.api_key import authenticate_api_key

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

# Programmable-voice paths that additionally accept an API key (HTTP Basic or
# X-Api-Key/X-Api-Secret) as an alternative to a browser JWT. Machine clients
# drive live calls / read their CDRs with an API key, not a JWT. A valid JWT is
# always tried first; the API-key fallback only runs for these paths and never
# weakens auth elsewhere. Mounted at both /v1/<path> and /<path>.
#   POST   /calls                originate
#   GET    /calls/{id}           status
#   POST   /calls/{id}/update    live control
#   GET    /cdrs                 list own CDRs
_API_KEY_PATHS = (
    re.compile(r"^/(v1/)?calls$"),
    re.compile(r"^/(v1/)?calls/[^/]+$"),
    re.compile(r"^/(v1/)?calls/[^/]+/update$"),
    re.compile(r"^/(v1/)?cdrs$"),
)


def _api_key_allowed(path: str) -> bool:
    """True if `path` is a programmable-voice endpoint that accepts an API key."""
    return any(p.match(path) for p in _API_KEY_PATHS)


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

        api_key_allowed = _api_key_allowed(path)

        # Try a Bearer JWT first (primary auth for the browser UI). A malformed
        # or expired JWT is only fatal here when the path does NOT accept an API
        # key; on programmable-voice paths we fall through to the API-key check.
        auth_header = request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            token = auth_header[7:]  # Strip "Bearer " prefix
            try:
                request.state.user = decode_access_token(token)
                return await call_next(request)
            except JWTError as exc:
                logger.debug("JWT decode failed: %s", exc)
                if not api_key_allowed:
                    return JSONResponse(
                        status_code=401,
                        content={"detail": "Not authenticated"},
                    )
                # else: fall through to API-key auth below.

        # API-key fallback (HTTP Basic api_key:api_secret, or X-Api-Key/-Secret)
        # for programmable-voice endpoints only. Sets the same claims shape the
        # JWT path sets, so downstream dependencies are unchanged.
        if api_key_allowed:
            claims = await authenticate_api_key(request)
            if claims is not None:
                request.state.user = claims
                return await call_next(request)

        return JSONResponse(
            status_code=401,
            content={"detail": "Not authenticated"},
        )
