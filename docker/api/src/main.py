"""
Voice Platform API - High Performance FastAPI Application
Optimized for high-volume voice operations with async throughout
"""
import orjson
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.responses import ORJSONResponse
from starlette.middleware.cors import CORSMiddleware
import logging

from db.database import init_db, close_db
from db.redis_client import init_redis, close_redis
from routers import rcf, calls, trunks, cdrs, customers, health, tiers, api_dids, rates, ivr, carriers

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize and cleanup resources."""
    logger.info("Starting Voice Platform API...")

    # Initialize database pool
    await init_db()
    logger.info("Database pool initialized")

    # Initialize Redis
    await init_redis()
    logger.info("Redis connection initialized")

    yield

    # Cleanup
    logger.info("Shutting down...")
    await close_db()
    await close_redis()


app = FastAPI(
    title="Voice Platform API",
    version="1.0.0",
    description="High-performance API for RCF, API Calling, and SIP Trunk services",
    lifespan=lifespan,
    default_response_class=ORJSONResponse,  # 10x faster JSON serialization
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Restrict in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Request timing middleware
@app.middleware("http")
async def add_timing_header(request: Request, call_next):
    import time
    start = time.perf_counter()
    response = await call_next(request)
    duration = (time.perf_counter() - start) * 1000
    response.headers["X-Response-Time-Ms"] = f"{duration:.2f}"
    return response


# Include routers
app.include_router(health.router, tags=["Health"])
app.include_router(customers.router, prefix="/v1/customers", tags=["Customers"])
app.include_router(rcf.router, prefix="/v1/rcf", tags=["RCF"])
app.include_router(calls.router, prefix="/v1/calls", tags=["Calls"])
app.include_router(trunks.router, prefix="/v1/trunks", tags=["SIP Trunks"])
app.include_router(cdrs.router, prefix="/v1/cdrs", tags=["CDRs"])
app.include_router(tiers.router, prefix="/v1/tiers", tags=["CPS Tiers"])
app.include_router(api_dids.router, prefix="/v1/api-dids", tags=["API DIDs"])
app.include_router(rates.router, prefix="/v1/rates", tags=["Rates"])
app.include_router(ivr.router, prefix="/v1/ivr", tags=["IVR Builder"])
app.include_router(carriers.router, prefix="/v1/carriers", tags=["Carriers"])

# Backward-compatible routes (no /v1/ prefix) for testing
app.include_router(customers.router, prefix="/customers", tags=["Customers"])
app.include_router(rcf.router, prefix="/rcf", tags=["RCF"])
app.include_router(calls.router, prefix="/calls", tags=["Calls"])
app.include_router(trunks.router, prefix="/trunks", tags=["SIP Trunks"])
app.include_router(cdrs.router, prefix="/cdrs", tags=["CDRs"])
app.include_router(tiers.router, prefix="/tiers", tags=["CPS Tiers"])
app.include_router(api_dids.router, prefix="/api-dids", tags=["API DIDs"])
app.include_router(rates.router, prefix="/rates", tags=["Rates"])
app.include_router(ivr.router, prefix="/ivr", tags=["IVR Builder"])
app.include_router(carriers.router, prefix="/carriers", tags=["Carriers"])


@app.get("/")
async def root():
    return {"message": "Voice Platform API", "version": "1.0.0"}
