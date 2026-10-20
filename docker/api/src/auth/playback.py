"""Short-lived voicemail playback tokens (contract §3; fixes build-plan defect 4).

The UI cannot attach an ``Authorization`` header to ``<audio src>``, so the
playback URL carries a token in ``?t=``. That token must be useless for
anything else:

* signed with ``VOICEMAIL_PLAYBACK_SECRET`` (HS256) — a DIFFERENT key from
  ``JWT_SECRET_KEY`` (enforced: an equal or < 32-char secret is refused);
* ``aud="vm-playback"`` and ``typ="vm-playback"`` — the session decoder
  (``auth/security.decode_access_token``) rejects both, so even a token signed
  with the session key could not act as a Bearer;
* bound to one object: ``k`` (``message``|``greeting``) and ``oid`` must match
  the URL being served;
* ``exp`` = issue time + 120 s; random ``jti`` (the router keys its
  decrypt-once cache and once-per-token audit on it).

Claims: ``aud, typ, k, oid (int), cid (int customer id), sub (str user id),
dl (bool download), jti (str), iat, exp``.
"""
from __future__ import annotations

import secrets
import time
from typing import Any

from jose import ExpiredSignatureError, JWTError, jwt

from services.voicemail.config import playback_secret
from services.voicemail.errors import VoicemailCryptoUnavailable

PLAYBACK_AUDIENCE = "vm-playback"
PLAYBACK_TOKEN_TYPE = "vm-playback"
PLAYBACK_TTL_SECONDS = 120
PLAYBACK_ALGORITHM = "HS256"
PLAYBACK_KINDS = ("message", "greeting")
_MAX_TOKEN_CHARS = 4096


class PlaybackTokenError(Exception):
    """Invalid, expired or mismatched playback token -> HTTP 401."""


class PlaybackNotConfigured(VoicemailCryptoUnavailable):
    """VOICEMAIL_PLAYBACK_SECRET unset / < 32 chars / equal to JWT_SECRET_KEY -> 503."""


def _secret() -> str:
    secret = playback_secret()
    if secret is None:
        raise PlaybackNotConfigured(
            "VOICEMAIL_PLAYBACK_SECRET must be set, >= 32 characters and different "
            "from JWT_SECRET_KEY")
    return secret


def _pos_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def mint_playback_token(kind: str, obj_id: int, customer_id: int, user_id: int | str,
                        download: bool = False) -> str:
    """Mint a 120-second playback token for one message/greeting.

    ``customer_id`` is the OWNER of the object (also for an admin previewing a
    customer). Raises ValueError on bad arguments, PlaybackNotConfigured (503)
    when the secret is unusable.
    """
    if kind not in PLAYBACK_KINDS:
        raise ValueError("kind must be 'message' or 'greeting'")
    if not _pos_int(obj_id):
        raise ValueError("obj_id must be a positive int")
    if not _pos_int(customer_id):
        raise ValueError("customer_id must be a positive int")
    if user_id is None or str(user_id) == "":
        raise ValueError("user_id is required")
    now = int(time.time())
    claims = {
        "aud": PLAYBACK_AUDIENCE,
        "typ": PLAYBACK_TOKEN_TYPE,
        "k": kind,
        "oid": obj_id,
        "cid": customer_id,
        "sub": str(user_id),
        "dl": bool(download),
        "jti": secrets.token_urlsafe(18),
        "iat": now,
        "exp": now + PLAYBACK_TTL_SECONDS,
    }
    return jwt.encode(claims, _secret(), algorithm=PLAYBACK_ALGORITHM)


def verify_playback_token(token: str, kind: str, obj_id: int) -> dict:
    """Verify a playback token for exactly (``kind``, ``obj_id``); return its claims.

    Raises PlaybackTokenError (-> 401) on any problem, PlaybackNotConfigured
    (-> 503) when the secret is unusable.
    """
    secret = _secret()
    if not isinstance(token, str) or not token or len(token) > _MAX_TOKEN_CHARS:
        raise PlaybackTokenError("missing or malformed playback token")
    try:
        claims = jwt.decode(
            token, secret, algorithms=[PLAYBACK_ALGORITHM], audience=PLAYBACK_AUDIENCE,
            options={"require_exp": True, "require_iat": True, "require_aud": True,
                     "require_jti": True, "require_sub": True})
    except ExpiredSignatureError as exc:
        raise PlaybackTokenError("playback token expired") from exc
    except JWTError as exc:
        raise PlaybackTokenError("invalid playback token") from exc

    if claims.get("typ") != PLAYBACK_TOKEN_TYPE:
        raise PlaybackTokenError("not a playback token")
    if claims.get("k") != kind or kind not in PLAYBACK_KINDS:
        raise PlaybackTokenError("playback token is for another kind of object")
    if not _pos_int(claims.get("oid")) or claims["oid"] != obj_id:
        raise PlaybackTokenError("playback token is for another object")
    if not _pos_int(claims.get("cid")):
        raise PlaybackTokenError("playback token has no customer")
    if not isinstance(claims.get("dl"), bool):
        raise PlaybackTokenError("playback token is malformed")
    if not isinstance(claims.get("jti"), str) or not claims["jti"]:
        raise PlaybackTokenError("playback token is malformed")
    iat, exp = claims.get("iat"), claims.get("exp")
    if not isinstance(iat, int) or not isinstance(exp, int) or exp - iat > PLAYBACK_TTL_SECONDS:
        raise PlaybackTokenError("playback token lifetime is invalid")
    return claims
