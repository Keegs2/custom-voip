"""Is the user behind a session JWT still allowed in? (``users.status``)

A session JWT is valid for up to ``JWT_EXPIRE_MINUTES`` (8 h). Without this
check, disabling or deleting a user did nothing until the token expired.
``JWTAuthMiddleware`` calls :func:`session_user_active` after the signature,
expiry and ``typ`` checks pass:

  * ``users.status = 'active'``          -> allowed
  * ``'disabled'``, row deleted/missing,
    or a ``sub`` that is not a user id    -> 401 (same body as a bad token)

Per-process TTL cache (``STATUS_TTL_S``, 30 s) keyed by user id, so a burst
of requests costs one indexed PK read per user per worker per TTL, not one
per request. A disabled / deleted user is locked out within that TTL (each
uvicorn worker re-reads on its own expiry); a re-enabled user gets back in
within the same window.

DB unavailable (pool missing, connection/query error, or no answer within
``LOOKUP_TIMEOUT_S``): FAIL OPEN for this check only — the request proceeds
on the JWT alone (signature + expiry are still enforced by the caller) and a
WARNING is logged (at most once per ``WARN_INTERVAL_S`` per process). A DB
blip must not sign every customer and the TED service account out at once,
and nearly every route needs the DB anyway, so a real outage already fails
those requests on their own queries. The fail-open answer is cached for
``FAIL_OPEN_TTL_S`` only, so a struggling database is not hammered by one
retry per request and the real status is re-read as soon as it answers.

Machine-authenticated / exempt paths (FreeSWITCH ``/freeswitch/*`` and CDR
ingest, voicemail ``/fs/*``, playback-token audio, the SBC report feeds,
login, health) never reach this check — the middleware returns before it.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Mapping

from db import database as db

logger = logging.getLogger(__name__)

#: Seconds a looked-up status is trusted in this process.
STATUS_TTL_S = 30.0
#: Seconds a fail-open answer (DB unavailable) is reused before retrying.
FAIL_OPEN_TTL_S = 5.0
#: Upper bound on one status lookup (pool acquire + query).
LOOKUP_TIMEOUT_S = 2.0
#: At most one fail-open WARNING per this many seconds per process.
WARN_INTERVAL_S = 60.0
#: Cache bound (entries). Only signed session tokens reach the cache, so the
#: key space is the set of real users; the bound is belt and braces.
MAX_ENTRIES = 10_000

_INT32_MAX = 2_147_483_647

STATUS_SQL = "SELECT status FROM users WHERE id = $1::int"

#: Monotonic clock (a module attribute so tests can drive the TTLs without
#: patching time.monotonic, which the event loop itself uses).
_clock = time.monotonic

#: user id -> (expires_at on _clock, allowed)
_cache: dict[int, tuple[float, bool]] = {}
_last_warning = float("-inf")


def reset() -> None:
    """Forget every cached status (tests; also safe at runtime)."""
    global _last_warning
    _cache.clear()
    _last_warning = float("-inf")


def _user_id(claims: Mapping[str, Any]) -> int | None:
    """The ``sub`` claim as a users.id, or None when it cannot be one."""
    sub = claims.get("sub")
    if isinstance(sub, bool):
        return None
    if isinstance(sub, int):
        uid = sub
    elif isinstance(sub, str) and sub.isascii() and sub.isdigit() and len(sub) <= 10:
        uid = int(sub)
    else:
        return None
    return uid if 1 <= uid <= _INT32_MAX else None


def _remember(uid: int, allowed: bool, ttl: float, now: float) -> None:
    if len(_cache) >= MAX_ENTRIES:
        for key in [k for k, (exp, _) in _cache.items() if exp <= now]:
            del _cache[key]
        if len(_cache) >= MAX_ENTRIES:
            _cache.clear()
    _cache[uid] = (now + ttl, allowed)


def _warn_fail_open(uid: int, exc: BaseException) -> None:
    global _last_warning
    now = _clock()
    if now - _last_warning >= WARN_INTERVAL_S:
        _last_warning = now
        logger.warning(
            "user status check unavailable (%s) — allowing the session on its JWT "
            "alone (fail open; user %s; next warning in >= %.0fs)",
            type(exc).__name__, uid, WARN_INTERVAL_S)


async def _lookup(uid: int) -> str | None:
    pool = db.pool
    if pool is None:
        raise RuntimeError("database pool not initialized")
    async with pool.acquire() as conn:
        return await conn.fetchval(STATUS_SQL, uid)


async def session_user_active(claims: Mapping[str, Any]) -> bool:
    """True when the token's user may proceed (see module docstring)."""
    uid = _user_id(claims)
    if uid is None:
        return False
    now = _clock()
    hit = _cache.get(uid)
    if hit is not None and hit[0] > now:
        return hit[1]
    try:
        status = await asyncio.wait_for(_lookup(uid), timeout=LOOKUP_TIMEOUT_S)
    except Exception as exc:  # noqa: BLE001 — DB down/slow: fail open, logged
        _warn_fail_open(uid, exc)
        _remember(uid, True, FAIL_OPEN_TTL_S, _clock())
        return True
    allowed = status == "active"
    _remember(uid, allowed, STATUS_TTL_S, _clock())
    if not allowed:
        logger.info("session refused: user %s is %s", uid,
                    "missing" if status is None else repr(status))
    return allowed
