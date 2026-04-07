"""Health check endpoints."""
from fastapi import APIRouter
from db.database import get_pool
from db.redis_client import get_client

router = APIRouter()


@router.get("/health")
async def health_check():
    """Basic health check."""
    return {"status": "healthy"}


@router.get("/health/detailed")
async def detailed_health():
    """Detailed health check including dependencies."""
    status = {"api": "healthy", "database": "unknown", "redis": "unknown"}

    # Check database
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        status["database"] = "healthy"
    except Exception as e:
        status["database"] = f"unhealthy: {str(e)}"

    # Check Redis
    try:
        client = await get_client()
        await client.ping()
        status["redis"] = "healthy"
    except Exception as e:
        status["redis"] = f"unhealthy: {str(e)}"

    overall = all(v == "healthy" for v in status.values())
    return {"status": "healthy" if overall else "degraded", "components": status}
