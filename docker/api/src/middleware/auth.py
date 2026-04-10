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

        # Exempt any CDR ingest endpoint (called by FreeSWITCH without auth)
        if path.endswith("/cdrs/ingest"):
            return await call_next(request)

        # Extract Bearer token from Authorization header
        auth_header = request.headers.get("Authorization")
        if not auth_header or not auth_header.startswith("Bearer "):
            return JSONResponse(
                status_code=401,
                content={"detail": "Not authenticated"},
            )

        token = auth_header[7:]  # Strip "Bearer " prefix

        try:
            claims = decode_access_token(token)
        except JWTError as exc:
            logger.debug("JWT decode failed: %s", exc)
            return JSONResponse(
                status_code=401,
                content={"detail": "Not authenticated"},
            )

        # Attach decoded claims to request state for dependency injection
        request.state.user = claims
        return await call_next(request)
