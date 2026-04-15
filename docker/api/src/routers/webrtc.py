"""WebRTC credential endpoints for UCaaS.

Returns Verto login credentials and ICE server configuration so the
browser-based softphone can connect to FreeSWITCH.
"""
import os
import logging
from fastapi import APIRouter, HTTPException, Depends, Request

from db import database as db
from auth.dependencies import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter()

# Configuration from environment with sensible defaults
VERTO_WS_URL = os.getenv("VERTO_WS_URL", "ws://localhost:8082")
SIP_DOMAIN = os.getenv("SIP_DOMAIN", "voiceplatform.local")

# STUN / TURN configuration
STUN_SERVER = os.getenv("STUN_SERVER", "stun:stun.l.google.com:19302")
TURN_SERVER = os.getenv("TURN_SERVER", "")  # e.g. "turn:turn.example.com:3478"
TURN_USERNAME = os.getenv("TURN_USERNAME", "")
TURN_PASSWORD = os.getenv("TURN_PASSWORD", "")


def _build_ice_servers() -> list[dict]:
    """Build the ICE servers list from environment configuration."""
    servers = []

    if STUN_SERVER:
        servers.append({"urls": STUN_SERVER})

    if TURN_SERVER:
        turn_entry: dict = {"urls": TURN_SERVER}
        if TURN_USERNAME:
            turn_entry["username"] = TURN_USERNAME
        if TURN_PASSWORD:
            turn_entry["credential"] = TURN_PASSWORD
        servers.append(turn_entry)

    return servers


@router.get("/credentials")
async def get_webrtc_credentials(request: Request, user: dict = Depends(get_current_user)):
    """Return Verto / WebRTC login credentials for the authenticated user.

    The response contains everything the browser softphone needs to register:
    - ws_url: the FreeSWITCH Verto WebSocket endpoint
    - login: extension@domain for SIP registration
    - password: the extension's voicemail PIN (used as SIP password in dev;
      production should use a dedicated SIP credential store)
    - ice_servers: STUN and optional TURN servers for NAT traversal

    Status codes:
    - 200: credentials returned successfully
    - 403: customer does not have UCaaS access at all (hide everything)
    - 404: user has no active extension (chat-only user; show chat, not softphone)
    """
    user_id = int(user["sub"])
    customer_id = user.get("customer_id")
    is_admin = user.get("role") == "admin"

    # --- Step 1: Check UCaaS access at the customer level FIRST ---
    # This determines whether the customer has UCaaS at all.
    # 403 = no UCaaS, frontend hides the entire Communications sidebar.
    if not is_admin and customer_id is not None:
        cust = await db.fetch_one(
            "SELECT account_type, ucaas_enabled FROM customers WHERE id = $1",
            customer_id,
        )
        if not cust:
            raise HTTPException(status_code=403, detail="UCaaS features are not enabled for this account")

        has_ucaas = (
            cust["account_type"] == "ucaas"
            or (cust["account_type"] in ("api", "trunk", "hybrid") and cust.get("ucaas_enabled"))
        )
        if not has_ucaas:
            raise HTTPException(
                status_code=403,
                detail="UCaaS features are not enabled for this account",
            )

    # --- Step 2: Look up the user's active extension ---
    # 404 = user has UCaaS but no extension yet (chat-only user).
    row = await db.fetch_one(
        """SELECT e.id, e.extension, e.voicemail_pin, e.customer_id,
                  e.display_name, e.status
           FROM extensions e
           WHERE e.user_id = $1 AND e.status = 'active'""",
        user_id,
    )
    if not row:
        raise HTTPException(
            status_code=404,
            detail="No active extension assigned to your account",
        )

    ext = dict(row)

    # Multi-tenant domain: customer_{id}.voiceplatform.local
    # This ensures FreeSWITCH resolves the extension within the correct
    # customer namespace via mod_xml_curl directory lookups.
    customer_domain = f"customer_{ext['customer_id']}.{SIP_DOMAIN}"
    login = f"{ext['extension']}@{customer_domain}"

    # When the frontend is on HTTPS, browsers block insecure ws:// connections
    # (mixed content). Detect this via X-Forwarded-Proto (set by nginx) and
    # return the WSS URL proxied through nginx instead of direct ws:// to FS.
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    if proto == "https":
        # Nginx proxies wss://host/ws/verto/ → ws://FS:8082
        host = request.headers.get("host", request.url.hostname or "localhost")
        ws_url = f"wss://{host}/ws/verto/"
    else:
        ws_url = VERTO_WS_URL

    return {
        "ws_url": ws_url,
        "login": login,
        "password": ext["voicemail_pin"],
        "display_name": ext["display_name"] or ext["extension"],
        "extension": ext["extension"],
        "extension_id": ext["id"],
        "customer_domain": customer_domain,
        "ice_servers": _build_ice_servers(),
    }
