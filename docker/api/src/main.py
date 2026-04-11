"""
Voice Platform API - High Performance FastAPI Application
Optimized for high-volume voice operations with async throughout
"""
import orjson
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, ORJSONResponse
from starlette.middleware.cors import CORSMiddleware
import asyncio
import logging

from db.database import init_db, close_db
from db.redis_client import init_redis, close_redis
from routers import (
    rcf, calls, trunks, cdrs, customers, health, tiers, api_dids, rates,
    ivr, carriers, auth, extensions, presence, voicemail, webrtc, search,
    freeswitch,
)
from routers.chat import router as chat_router
from routers.conference import router as conference_router
from routers.documents import router as documents_router
from middleware.auth import JWTAuthMiddleware

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

    # Start background presence subscriber for WebSocket fanout
    presence_task = asyncio.create_task(_presence_subscriber())
    logger.info("Presence WebSocket subscriber started")

    # Start background chat subscriber for WebSocket fanout
    chat_task = asyncio.create_task(_chat_subscriber())
    logger.info("Chat WebSocket subscriber started")

    yield

    # Cleanup
    logger.info("Shutting down...")
    presence_task.cancel()
    chat_task.cancel()
    try:
        await presence_task
    except asyncio.CancelledError:
        pass
    try:
        await chat_task
    except asyncio.CancelledError:
        pass
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

# JWT Authentication (runs after CORS so preflight still works)
app.add_middleware(JWTAuthMiddleware)


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
app.include_router(auth.router, prefix="/auth", tags=["Auth"])
app.include_router(auth.router, prefix="/v1/auth", tags=["Auth"])
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
app.include_router(extensions.router, prefix="/v1/extensions", tags=["Extensions"])
app.include_router(presence.router, prefix="/v1/presence", tags=["Presence"])
app.include_router(voicemail.router, prefix="/v1/voicemail", tags=["Voicemail"])
app.include_router(webrtc.router, prefix="/v1/webrtc", tags=["WebRTC"])
app.include_router(chat_router, prefix="/v1/chat", tags=["Chat"])
app.include_router(conference_router, prefix="/v1/conferences", tags=["Conferences"])
app.include_router(documents_router, prefix="/v1/documents", tags=["Documents"])
app.include_router(search.router, prefix="/v1/search", tags=["Search"])

# FreeSWITCH mod_xml_curl directory endpoint (no auth, called over loopback)
app.include_router(freeswitch.router, prefix="/freeswitch", tags=["FreeSWITCH"])

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
app.include_router(extensions.router, prefix="/extensions", tags=["Extensions"])
app.include_router(presence.router, prefix="/presence", tags=["Presence"])
app.include_router(voicemail.router, prefix="/voicemail", tags=["Voicemail"])
app.include_router(webrtc.router, prefix="/webrtc", tags=["WebRTC"])
app.include_router(chat_router, prefix="/chat", tags=["Chat"])
app.include_router(conference_router, prefix="/conferences", tags=["Conferences"])
app.include_router(documents_router, prefix="/documents", tags=["Documents"])
app.include_router(search.router, prefix="/search", tags=["Search"])


@app.get("/")
async def root():
    return {"message": "Voice Platform API", "version": "1.0.0"}


# ---------------------------------------------------------------------------
# WebSocket: Real-time presence updates
# ---------------------------------------------------------------------------

class PresenceConnectionManager:
    """Manages WebSocket connections for presence pub/sub fanout.

    Each connection is tagged with the user's customer_id so updates
    are only sent to users within the same customer scope. Admin
    connections (customer_id=None) receive all updates.
    """

    def __init__(self):
        # Map of websocket -> {"customer_id": int|None, "user_id": int}
        self.active: dict[WebSocket, dict] = {}

    async def connect(self, websocket: WebSocket, user_info: dict):
        await websocket.accept()
        self.active[websocket] = user_info

    def disconnect(self, websocket: WebSocket):
        self.active.pop(websocket, None)

    async def broadcast(self, message: dict):
        """Send a presence update to all connections that should see it."""
        source_customer_id = message.get("customer_id")
        payload = orjson.dumps(message)

        stale: list[WebSocket] = []
        for ws, info in self.active.items():
            # Admin (customer_id=None) sees everything;
            # otherwise must match the source customer
            if info["customer_id"] is not None and info["customer_id"] != source_customer_id:
                continue
            try:
                await ws.send_bytes(payload)
            except Exception:
                stale.append(ws)

        for ws in stale:
            self.disconnect(ws)


presence_manager = PresenceConnectionManager()


async def _presence_subscriber():
    """Background task: subscribe to Redis presence channel and fan out."""
    from db.redis_client import get_client

    while True:
        try:
            rc = await get_client()
            pubsub = rc.pubsub()
            await pubsub.subscribe("presence:updates")

            async for msg in pubsub.listen():
                if msg["type"] != "message":
                    continue
                try:
                    data = orjson.loads(msg["data"])
                    await presence_manager.broadcast(data)
                except Exception:
                    logging.getLogger(__name__).debug(
                        "Failed to broadcast presence message", exc_info=True
                    )

        except asyncio.CancelledError:
            break
        except Exception:
            logging.getLogger(__name__).warning(
                "Presence subscriber reconnecting in 2s", exc_info=True
            )
            await asyncio.sleep(2)


@app.websocket("/ws/presence")
async def presence_websocket(websocket: WebSocket):
    """Real-time presence updates over WebSocket.

    Authentication: pass the JWT as a query parameter:
        ws://host/ws/presence?token=<jwt>

    After connecting, the server pushes presence change events as JSON:
        {"user_id": 1, "status": "busy", "status_message": "In a meeting", ...}
    """
    from auth.security import decode_access_token
    from jose import JWTError

    token = websocket.query_params.get("token")
    if not token:
        await websocket.close(code=4001, reason="Missing token query parameter")
        return

    try:
        claims = decode_access_token(token)
    except JWTError:
        await websocket.close(code=4003, reason="Invalid or expired token")
        return

    user_info = {
        "user_id": int(claims["sub"]),
        "customer_id": claims.get("customer_id"),  # None for admins
    }
    # Admins have customer_id=None which means "see everything"
    if claims.get("role") == "admin":
        user_info["customer_id"] = None

    await presence_manager.connect(websocket, user_info)
    try:
        # Keep connection alive; client can send pings or text (ignored)
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        presence_manager.disconnect(websocket)


# ---------------------------------------------------------------------------
# WebSocket: Real-time chat messaging
# ---------------------------------------------------------------------------

class ChatConnectionManager:
    """Manages WebSocket connections for chat message fanout.

    A user can have multiple active connections (e.g. multiple browser tabs).
    Messages are sent to all connections belonging to a participant of the
    conversation.
    """

    def __init__(self):
        # Map of user_id -> set of (websocket, customer_id)
        self.connections: dict[int, set[tuple[WebSocket, int | None]]] = {}
        # Reverse map for fast disconnect
        self._ws_to_user: dict[WebSocket, int] = {}

    async def connect(self, websocket: WebSocket, user_id: int, customer_id: int | None):
        await websocket.accept()
        if user_id not in self.connections:
            self.connections[user_id] = set()
        self.connections[user_id].add((websocket, customer_id))
        self._ws_to_user[websocket] = user_id

    def disconnect(self, websocket: WebSocket):
        user_id = self._ws_to_user.pop(websocket, None)
        if user_id is not None and user_id in self.connections:
            self.connections[user_id] = {
                (ws, cid) for ws, cid in self.connections[user_id] if ws is not websocket
            }
            if not self.connections[user_id]:
                del self.connections[user_id]

    async def broadcast_to_user(self, user_id: int, data: bytes):
        """Send raw bytes to all connections of a user."""
        conns = self.connections.get(user_id)
        if not conns:
            return
        stale: list[WebSocket] = []
        for ws, _cid in conns:
            try:
                await ws.send_bytes(data)
            except Exception:
                stale.append(ws)
        for ws in stale:
            self.disconnect(ws)


chat_manager = ChatConnectionManager()


async def _chat_subscriber():
    """Background task: subscribe to Redis chat channels and fan out to
    connected WebSocket clients."""
    from db.redis_client import get_client

    while True:
        try:
            rc = await get_client()
            pubsub = rc.pubsub()
            await pubsub.subscribe("chat:events", "chat:typing")

            async for msg in pubsub.listen():
                if msg["type"] != "message":
                    continue
                try:
                    data = orjson.loads(msg["data"])

                    # Both channels include participant_user_ids for targeting
                    participant_ids = data.get("participant_user_ids", [])
                    payload = orjson.dumps(data)

                    for uid in participant_ids:
                        await chat_manager.broadcast_to_user(uid, payload)

                except Exception:
                    logging.getLogger(__name__).debug(
                        "Failed to broadcast chat message", exc_info=True
                    )

        except asyncio.CancelledError:
            break
        except Exception:
            logging.getLogger(__name__).warning(
                "Chat subscriber reconnecting in 2s", exc_info=True
            )
            await asyncio.sleep(2)


@app.websocket("/ws/chat")
async def chat_websocket(websocket: WebSocket):
    """Real-time chat updates over WebSocket.

    Authentication: pass the JWT as a query parameter:
        ws://host/ws/chat?token=<jwt>

    After connecting, the server pushes chat events as JSON:
        {"type": "new_message", "conversation_id": 1, "message": {...}, ...}
        {"type": "typing", "conversation_id": 1, "user_id": 5, ...}
        {"type": "read_receipt", ...}
        {"type": "message_edited", ...}
        {"type": "message_deleted", ...}
    """
    from auth.security import decode_access_token
    from jose import JWTError

    token = websocket.query_params.get("token")
    if not token:
        await websocket.close(code=4001, reason="Missing token query parameter")
        return

    try:
        claims = decode_access_token(token)
    except JWTError:
        await websocket.close(code=4003, reason="Invalid or expired token")
        return

    user_id = int(claims["sub"])
    customer_id = claims.get("customer_id")

    await chat_manager.connect(websocket, user_id, customer_id)
    try:
        # Keep connection alive; client can send pings or text (ignored)
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        chat_manager.disconnect(websocket)


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
