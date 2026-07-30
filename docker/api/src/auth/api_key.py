"""
API-key (machine-to-machine) authentication for programmable voice.

Programmable-voice customers authenticate to the REST API with an API key /
secret pair instead of a browser JWT. Credentials live in the `api_credentials`
table (`api_key` unique, `api_secret_hash` = bcrypt of the secret).

Two transports are accepted (Twilio-style):
  1. HTTP Basic — username = api_key, password = api_secret
  2. Headers    — X-Api-Key / X-Api-Secret

On success this module returns a claims dict shaped EXACTLY like the JWT claims
the auth middleware sets on `request.state.user`, so the existing
`get_current_user` / `get_customer_filter` dependencies work unchanged:

    {"sub": "<user-id-or-cred-marker>", "email": ..., "role": "user",
     "customer_id": <int>, "auth": "api_key", "api_credential_id": <int>}

The middleware calls `authenticate_api_key(request)`; it returns the claims dict
on success or None when no API-key material is present / verification fails.
"""
import base64
import binascii
import logging
import secrets
from typing import Optional

from starlette.requests import Request

from db import database as db
from auth.security import verify_password

logger = logging.getLogger(__name__)

# Generated api_key layout: "<prefix><urlsafe-token>". Prefix makes keys
# self-identifying in logs/dashboards; column is VARCHAR(64) so keep it short.
API_KEY_PREFIX = "rvk_"          # revup key
API_KEY_TOKEN_BYTES = 24         # ~32 urlsafe chars -> full key ~36 chars
API_SECRET_BYTES = 32            # ~43 urlsafe chars, well under bcrypt's 72-byte cap


def generate_api_key() -> str:
    """Generate a strong, self-identifying API key (prefix + urlsafe token)."""
    return API_KEY_PREFIX + secrets.token_urlsafe(API_KEY_TOKEN_BYTES)


def generate_api_secret() -> str:
    """Generate a strong API secret (urlsafe, < bcrypt's 72-byte limit)."""
    return secrets.token_urlsafe(API_SECRET_BYTES)


def _extract_credentials(request: Request) -> Optional[tuple[str, str]]:
    """Pull an (api_key, api_secret) pair from the request, or None.

    Precedence: HTTP Basic first (the documented Twilio-style transport), then
    the X-Api-Key / X-Api-Secret header pair. A Bearer Authorization header is
    ignored here (that is the JWT path).
    """
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Basic "):
        encoded = auth_header[6:].strip()
        try:
            decoded = base64.b64decode(encoded).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError, ValueError):
            return None
        # Only the FIRST colon separates username from password; secrets are
        # urlsafe (no ':') so this is safe, but split with maxsplit for safety.
        if ":" not in decoded:
            return None
        api_key, api_secret = decoded.split(":", 1)
        if api_key and api_secret:
            return api_key, api_secret
        return None

    header_key = request.headers.get("X-Api-Key")
    header_secret = request.headers.get("X-Api-Secret")
    if header_key and header_secret:
        return header_key, header_secret

    return None


async def authenticate_api_key(request: Request) -> Optional[dict]:
    """Verify API-key credentials on the request; return JWT-shaped claims or None.

    Returns None when no API-key material is present OR when it is present but
    invalid (unknown key / bad secret / disabled credential). Callers decide the
    response (the middleware falls back to a 401 only when NO auth succeeds).
    """
    creds = _extract_credentials(request)
    if creds is None:
        return None

    api_key, api_secret = creds

    row = await db.fetch_one(
        """
        SELECT id, customer_id, api_secret_hash, enabled
        FROM api_credentials
        WHERE api_key = $1::varchar
        """,
        api_key,
    )

    # Unknown key. Do a dummy verify to keep timing roughly uniform (avoid a
    # trivial user-enumeration oracle on response latency).
    if row is None:
        verify_password(api_secret, _DUMMY_HASH)
        return None

    if not row["enabled"]:
        logger.info("API-key auth rejected: credential %s is disabled", row["id"])
        return None

    try:
        if not verify_password(api_secret, row["api_secret_hash"]):
            logger.info("API-key auth rejected: bad secret for credential %s", row["id"])
            return None
    except (ValueError, TypeError) as exc:
        # Malformed stored hash — treat as auth failure, never 500.
        logger.warning("API-key auth: hash verify error for credential %s: %s", row["id"], exc)
        return None

    # Record usage. Fire-and-forget semantics: a failure here must not break the
    # authenticated request. `last_used_at` is added by the IVR/credential
    # migration; guard so auth still works if the column is absent.
    try:
        await db.execute(
            "UPDATE api_credentials SET last_used_at = NOW() WHERE id = $1::int",
            row["id"],
        )
    except Exception as exc:  # noqa: BLE001 — best-effort, must not fail auth
        logger.debug("API-key last_used_at update skipped: %s", exc)

    return {
        "sub": f"api_cred:{row['id']}",
        "email": None,
        "role": "user",
        "customer_id": row["customer_id"],
        "auth": "api_key",
        "api_credential_id": row["id"],
    }


# A fixed valid bcrypt hash used only for constant-work dummy verification on
# unknown-key lookups (it is bcrypt("dummy"); a supplied secret can never be the
# literal "dummy" for a real credential, so this never yields a false accept).
# Precomputed so a miss still does one bcrypt round rather than hashing live.
_DUMMY_HASH = "$2b$12$xB22w4Fcgql91nR79R2Zde/whPeI8dOdVPCrzjvCPkTC.Lc5h3jY6"
