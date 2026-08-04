"""
JWT Authentication Middleware.
Intercepts all requests (except exempt paths), validates the Bearer token,
and attaches decoded claims to request.state.user for downstream dependencies.
"""
import logging
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

        # Require a valid Bearer JWT for everything else.
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
