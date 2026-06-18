"""WebRTC credential endpoints for UCaaS.

Returns Verto login credentials and ICE server configuration so the
browser-based softphone can connect to FreeSWITCH.
"""
import os
import time
import hmac
import base64
import hashlib
import logging
from fastapi import APIRouter, HTTPException, Depends, Request

from db import database as db
from auth.dependencies import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter()

# Configuration from environment with sensible defaults
VERTO_WS_URL = os.getenv("VERTO_WS_URL", "ws://localhost:8082")
SIP_DOMAIN = os.getenv("SIP_DOMAIN", "voiceplatform.local")

# TURN / STUN — coturn `use-auth-secret` (REST) scheme. The coturn server is
# configured with the SAME TURN_SECRET (telephony agent), so it can verify the
# time-limited credentials we mint here without any shared user database.
TURN_HOST = os.getenv("TURN_HOST", "")
TURN_PORT = os.getenv("TURN_PORT", "3478")
TURN_TLS_PORT = os.getenv("TURN_TLS_PORT", "5349")
TURN_SECRET = os.getenv("TURN_SECRET", "")
TURN_REALM = os.getenv("TURN_REALM", "")
# Lifetime of a minted TURN credential (seconds). Default 12h covers a long
# softphone session; the browser re-fetches /credentials to refresh.
TURN_TTL = int(os.getenv("TURN_TTL", str(12 * 3600)))


def _build_ice_servers(user_id: int) -> list[dict]:
    """Build the ICE servers list using coturn time-limited REST credentials.

    coturn `use-auth-secret` scheme:
      username   = "<unix_expiry>:<user_id>"
      credential = base64( HMAC_SHA1(TURN_SECRET, username) )

    STUN is always advertised (works for cone NATs); TURN/TURNS are added only
    when TURN_HOST + TURN_SECRET are configured — STUN-only fails behind
    symmetric NAT, so production MUST set these.
    """
    servers: list[dict] = []

    if TURN_HOST:
        servers.append({"urls": f"stun:{TURN_HOST}:{TURN_PORT}"})

    if TURN_HOST and TURN_SECRET:
        expiry = int(time.time()) + TURN_TTL
        username = f"{expiry}:{user_id}"
        credential = base64.b64encode(
            hmac.new(
                TURN_SECRET.encode("utf-8"),
                username.encode("utf-8"),
                hashlib.sha1,
            ).digest()
        ).decode("ascii")

        turn_entry: dict = {
            "urls": [
                f"turn:{TURN_HOST}:{TURN_PORT}?transport=udp",
                f"turns:{TURN_HOST}:{TURN_TLS_PORT}?transport=tcp",
            ],
            "username": username,
            "credential": credential,
        }
        servers.append(turn_entry)
    elif TURN_HOST:
        logger.warning(
            "TURN_HOST set but TURN_SECRET missing — serving STUN only; "
            "calls behind symmetric NAT will fail"
        )

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
    # Nginx passes $http_host (includes port) so host header has host:port.
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    if proto == "https":
        host = request.headers.get("host", "localhost")
        ws_url = f"wss://{host}/ws/verto/"
    else:
        ws_url = VERTO_WS_URL

    ice_servers = _build_ice_servers(user_id)

    return {
        "ws_url": ws_url,
        "login": login,
        "password": ext["voicemail_pin"],
        "display_name": ext["display_name"] or ext["extension"],
        "extension": ext["extension"],
        "extension_id": ext["id"],
        "customer_domain": customer_domain,
        # Both keys returned: snake_case for existing clients, camelCase
        # `iceServers` for the standard RTCPeerConnection config shape.
        "ice_servers": ice_servers,
        "iceServers": ice_servers,
    }
