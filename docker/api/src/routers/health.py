"""Health check endpoints."""
from fastapi import APIRouter
from db import database as db
from db import redis_client as cache

router = APIRouter()


@router.get("/health")
async def health_check():
    """Health check with DB and Redis connectivity verification."""
    checks = {"api": "ok"}
    try:
        await db.fetch_one("SELECT 1")
        checks["database"] = "ok"
    except Exception:
        checks["database"] = "error"
    try:
        rc = await cache.get_client()
        await rc.ping()
        checks["redis"] = "ok"
    except Exception:
        checks["redis"] = "error"

    healthy = all(v == "ok" for v in checks.values())
    return {"status": "healthy" if healthy else "degraded", "checks": checks}


@router.get("/health/detailed")
async def detailed_health():
    """Detailed health check including dependencies."""
    status = {"api": "healthy", "database": "unknown", "redis": "unknown"}

    # Check database
    try:
        await db.fetch_one("SELECT 1")
        status["database"] = "healthy"
    except Exception as e:
        status["database"] = f"unhealthy: {str(e)}"

    # Check Redis
    try:
        client = await cache.get_client()
        await client.ping()
        status["redis"] = "healthy"
    except Exception as e:
        status["redis"] = f"unhealthy: {str(e)}"

    overall = all(v == "healthy" for v in status.values())
    return {"status": "healthy" if overall else "degraded", "components": status}
