"""WebRTC credential endpoints for UCaaS.

Returns Verto login credentials and ICE server configuration so the
browser-based softphone can connect to FreeSWITCH.
"""
import os
import logging
from fastapi import APIRouter, HTTPException, Depends

from db import database as db
from auth.dependencies import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter()

# Configuration from environment with sensible defaults
VERTO_WS_URL = os.getenv("VERTO_WS_URL", "wss://localhost:8082")
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
async def get_webrtc_credentials(user: dict = Depends(get_current_user)):
    """Return Verto / WebRTC login credentials for the authenticated user.

    The response contains everything the browser softphone needs to register:
    - ws_url: the FreeSWITCH Verto WebSocket endpoint
    - login: extension@domain for SIP registration
    - password: the extension's voicemail PIN (used as SIP password in dev;
      production should use a dedicated SIP credential store)
    - ice_servers: STUN and optional TURN servers for NAT traversal
    """
    user_id = int(user["sub"])

    # Look up the user's active extension and verify UCaaS access
    row = await db.fetch_one(
        """SELECT e.extension, e.voicemail_pin, e.customer_id,
                  e.display_name, e.status,
                  c.account_type, c.ucaas_enabled
           FROM extensions e
           JOIN customers c ON e.customer_id = c.id
           WHERE e.user_id = $1 AND e.status = 'active'""",
        user_id,
    )
    if not row:
        raise HTTPException(
            status_code=404,
            detail="No active extension assigned to your account",
        )

    ext = dict(row)

    # Explicit UCaaS gate: only ucaas accounts or api/trunk/hybrid with ucaas_enabled
    account_type = ext.get("account_type")
    has_ucaas = (
        account_type is None  # Admin users always have access
        or account_type == "ucaas"
        or (account_type in ("api", "trunk", "hybrid") and ext.get("ucaas_enabled"))
    )
    if not has_ucaas:
        raise HTTPException(
            status_code=403,
            detail="UCaaS features are not enabled for this account",
        )
    login = f"{ext['extension']}@{SIP_DOMAIN}"

    return {
        "ws_url": VERTO_WS_URL,
        "login": login,
        "password": ext["voicemail_pin"],
        "display_name": ext["display_name"] or ext["extension"],
        "extension": ext["extension"],
        "ice_servers": _build_ice_servers(),
    }
