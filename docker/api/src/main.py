"""
Voice Platform API - High Performance FastAPI Application
Optimized for high-volume voice operations with async throughout
"""
import orjson
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, ORJSONResponse
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
    docs_url=None,    # Disabled — served via custom dark-themed route below
    redoc_url=None,   # Disabled — served via custom dark-themed route below
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


# ---------------------------------------------------------------------------
# Custom dark-themed Swagger UI and ReDoc
# ---------------------------------------------------------------------------

SWAGGER_HTML = """
<!DOCTYPE html>
<html>
<head>
    <title>Custom VoIP API</title>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css"/>
    <style>
        /* Dark theme overrides matching our dashboard */
        html, body {
            background: #0f1117;
            color: #e2e8f0;
        }
        .swagger-ui {
            color: #e2e8f0;
        }
        .swagger-ui .topbar {
            display: none;
        }
        .swagger-ui .info {
            margin: 20px 0;
        }
        .swagger-ui .info .title {
            color: #e2e8f0;
        }
        .swagger-ui .info .description p {
            color: #718096;
        }
        .swagger-ui .info a {
            color: #3b82f6;
        }
        .swagger-ui .scheme-container {
            background: #1a1d27;
            box-shadow: none;
            border: 1px solid #2a2f45;
            border-radius: 8px;
            padding: 10px 20px;
        }
        .swagger-ui .opblock-tag {
            color: #e2e8f0;
            border-bottom: 1px solid #2a2f45;
        }
        .swagger-ui .opblock-tag:hover {
            background: rgba(59,130,246,0.05);
        }
        /* GET - blue */
        .swagger-ui .opblock.opblock-get {
            background: rgba(59,130,246,0.08);
            border-color: rgba(59,130,246,0.3);
        }
        .swagger-ui .opblock.opblock-get .opblock-summary {
            border-color: rgba(59,130,246,0.3);
        }
        /* POST - green */
        .swagger-ui .opblock.opblock-post {
            background: rgba(34,197,94,0.08);
            border-color: rgba(34,197,94,0.3);
        }
        .swagger-ui .opblock.opblock-post .opblock-summary {
            border-color: rgba(34,197,94,0.3);
        }
        /* PUT - amber */
        .swagger-ui .opblock.opblock-put {
            background: rgba(245,158,11,0.08);
            border-color: rgba(245,158,11,0.3);
        }
        .swagger-ui .opblock.opblock-put .opblock-summary {
            border-color: rgba(245,158,11,0.3);
        }
        /* DELETE - red */
        .swagger-ui .opblock.opblock-delete {
            background: rgba(239,68,68,0.08);
            border-color: rgba(239,68,68,0.3);
        }
        .swagger-ui .opblock.opblock-delete .opblock-summary {
            border-color: rgba(239,68,68,0.3);
        }
        .swagger-ui .opblock .opblock-summary-path {
            color: #e2e8f0;
        }
        .swagger-ui .opblock .opblock-summary-description {
            color: #718096;
        }
        .swagger-ui .opblock-body {
            background: #1a1d27;
        }
        .swagger-ui .opblock-description-wrapper,
        .swagger-ui .opblock-section-header {
            background: #1a1d27;
            color: #e2e8f0;
        }
        .swagger-ui .opblock-section-header h4 {
            color: #e2e8f0;
        }
        .swagger-ui table thead tr td,
        .swagger-ui table thead tr th {
            color: #718096;
            border-bottom: 1px solid #2a2f45;
        }
        .swagger-ui .parameter__name,
        .swagger-ui .parameter__type,
        .swagger-ui .parameter__in {
            color: #e2e8f0;
        }
        .swagger-ui .parameter__name.required span {
            color: #ef4444;
        }
        .swagger-ui textarea, .swagger-ui input[type=text], .swagger-ui input[type=file] {
            background: #1e2130;
            color: #e2e8f0;
            border: 1px solid #2a2f45;
            border-radius: 4px;
        }
        .swagger-ui textarea:focus, .swagger-ui input[type=text]:focus {
            border-color: #3b82f6;
            outline: none;
        }
        .swagger-ui select {
            background: #1e2130;
            color: #e2e8f0;
            border: 1px solid #2a2f45;
        }
        .swagger-ui .btn {
            border-radius: 4px;
        }
        .swagger-ui .btn.execute {
            background: #3b82f6;
            border-color: #3b82f6;
            color: #fff;
        }
        .swagger-ui .btn.execute:hover {
            background: #2563eb;
        }
        .swagger-ui .responses-inner {
            background: #1a1d27;
        }
        .swagger-ui .response-col_status {
            color: #e2e8f0;
        }
        .swagger-ui .response-col_description {
            color: #718096;
        }
        .swagger-ui .highlight-code {
            background: #0d0f15;
            border-radius: 4px;
        }
        .swagger-ui .highlight-code .microlight {
            background: #0d0f15;
            color: #e2e8f0;
        }
        .swagger-ui .model-box {
            background: #1a1d27;
        }
        .swagger-ui .model {
            color: #e2e8f0;
        }
        .swagger-ui .model-title {
            color: #e2e8f0;
        }
        .swagger-ui .model .property {
            color: #3b82f6;
        }
        .swagger-ui section.models {
            border: 1px solid #2a2f45;
            border-radius: 8px;
        }
        .swagger-ui section.models h4 {
            color: #e2e8f0;
        }
        .swagger-ui .loading-container .loading {
            color: #3b82f6;
        }
        .swagger-ui .loading-container .loading::after {
            border-color: #3b82f6 transparent transparent;
        }
        /* Try it out button */
        .swagger-ui .try-out__btn {
            color: #3b82f6;
            border-color: #3b82f6;
        }
        .swagger-ui .try-out__btn:hover {
            background: rgba(59,130,246,0.1);
        }
        /* Response body */
        .swagger-ui .microlight {
            background: #0d0f15 !important;
            color: #e2e8f0 !important;
        }
        /* Copy button */
        .swagger-ui .copy-to-clipboard {
            background: #1e2130;
        }
        /* Model toggle */
        .swagger-ui .model-toggle::after {
            background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath fill='%23e2e8f0' d='M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z'/%3E%3C/svg%3E") center no-repeat;
        }
        /* Authorization */
        .swagger-ui .auth-wrapper {
            background: #1a1d27;
        }
        .swagger-ui .dialog-ux .modal-ux {
            background: #1a1d27;
            border: 1px solid #2a2f45;
            color: #e2e8f0;
        }
        .swagger-ui .dialog-ux .modal-ux-header h3 {
            color: #e2e8f0;
        }
        /* Version badge */
        .swagger-ui .info .title small.version-stamp {
            background: #3b82f6;
        }
    </style>
</head>
<body>
    <div id="swagger-ui"></div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
        SwaggerUIBundle({
            url: '/openapi.json',
            dom_id: '#swagger-ui',
            presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
            layout: 'BaseLayout',
            docExpansion: 'list',
            defaultModelsExpandDepth: -1,
            syntaxHighlight: { theme: 'monokai' },
            tryItOutEnabled: true,
        });
    </script>
</body>
</html>
"""

REDOC_HTML = """
<!DOCTYPE html>
<html>
<head>
    <title>Custom VoIP API</title>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <style>
        body { margin: 0; padding: 0; }
    </style>
</head>
<body>
    <div id="redoc-container"></div>
    <script src="https://cdn.jsdelivr.net/npm/redoc@latest/bundles/redoc.standalone.js"></script>
    <script>
        Redoc.init('/openapi.json', {
            theme: {
                colors: { primary: { main: '#3b82f6' } },
                typography: { fontFamily: 'system-ui, -apple-system, sans-serif', fontSize: '15px' },
                sidebar: { backgroundColor: '#0d0f15', textColor: '#e2e8f0' },
                rightPanel: { backgroundColor: '#1a1d27', textColor: '#e2e8f0' },
                schema: { nestedBackground: '#1e2130' },
            },
            scrollYOffset: 0,
            hideDownloadButton: true,
        }, document.getElementById('redoc-container'));
    </script>
</body>
</html>
"""


@app.get("/docs", include_in_schema=False)
async def custom_swagger_ui():
    return HTMLResponse(content=SWAGGER_HTML)


@app.get("/redoc", include_in_schema=False)
async def custom_redoc():
    return HTMLResponse(content=REDOC_HTML)
