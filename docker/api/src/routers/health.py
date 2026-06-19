"""Health check endpoints."""
import asyncio

from fastapi import APIRouter
from db import database as db
from db import redis_client as cache

router = APIRouter()

# Docker healthcheck curls /health with a 5s timeout — every check below is
# time-bounded so the endpoint always responds well inside that window.
_DB_CHECK_TIMEOUT_SEC = 3
_REDIS_PING_TIMEOUT_SEC = 2


async def _check_redis() -> tuple[str, str]:
    """Probe Redis WITHOUT triggering a (re)connect.

    Never calls cache.get_client() — when Redis is down that would attempt a
    fresh connection on every health probe. Only inspects the existing
    module-level client. Returns (status, detail).
    """
    if cache.client is None:
        return "unavailable", "unavailable: no active connection"
    try:
        await asyncio.wait_for(cache.client.ping(), timeout=_REDIS_PING_TIMEOUT_SEC)
        return "ok", "healthy"
    except Exception as e:
        return "error", f"unhealthy: {str(e) or type(e).__name__}"


def _esl_health() -> dict:
    """ESL consumer health WITHOUT touching the connection (pure in-memory read).

    Phase 5: FreeSWITCH being unreachable is NOT fatal and does NOT affect the
    overall health verdict — locally (Docker Desktop host-net isolation) the
    consumer can never connect, and the API must still report healthy. This
    field is informational: connected bool + last_event_ts + reconnect count.
    """
    try:
        from services.esl_client import get_esl_client
        return get_esl_client().health()
    except Exception as e:  # noqa: BLE001 — health must never raise
        return {"configured": False, "connected": False, "error": str(e)}


@router.get("/health")
async def health_check():
    """Health check with DB and Redis connectivity verification.

    Always returns HTTP 200 — Redis being down is "degraded", not fatal
    (cache is fail-open by design); Docker must not restart-loop the API.

    The ESL consumer status is reported but is intentionally NOT part of the
    health verdict (FS may be unreachable locally / during maintenance).
    """
    checks = {"api": "ok"}
    try:
        await asyncio.wait_for(db.fetch_one("SELECT 1"), timeout=_DB_CHECK_TIMEOUT_SEC)
        checks["database"] = "ok"
    except Exception:
        checks["database"] = "error"

    checks["redis"], _ = await _check_redis()

    healthy = all(v == "ok" for v in checks.values())
    return {
        "status": "healthy" if healthy else "degraded",
        "checks": checks,
        "esl": _esl_health(),
    }


@router.get("/health/detailed")
async def detailed_health():
    """Detailed health check including dependencies."""
    status = {"api": "healthy", "database": "unknown", "redis": "unknown"}

    # Check database
    try:
        await asyncio.wait_for(db.fetch_one("SELECT 1"), timeout=_DB_CHECK_TIMEOUT_SEC)
        status["database"] = "healthy"
    except Exception as e:
        status["database"] = f"unhealthy: {str(e) or type(e).__name__}"

    # Check Redis (no connection attempt — see _check_redis)
    redis_status, redis_detail = await _check_redis()
    status["redis"] = "healthy" if redis_status == "ok" else (
        "unavailable" if redis_status == "unavailable" else redis_detail
    )

    overall = all(v == "healthy" for v in status.values())
    return {"status": "healthy" if overall else "degraded", "components": status}
