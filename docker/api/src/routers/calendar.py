"""Read-only Calendar integration endpoints (Phase 1).

Per-USER (JWT `sub`), direct OAuth to Google Calendar + Microsoft Graph. v1 is
connect → view → disconnect; no write scopes. Mounted at both /v1/calendar and
/calendar (see main.py). All endpoints require a JWT EXCEPT the provider
``/callback/{provider}`` which is JWT-exempt (middleware) and authenticated by a
signed ``state`` (HS256, typ=cal_state) + single-use PKCE nonce in Redis — the
same exempt-in-middleware/validate-in-router pattern as auth/ingest.py.

Isolation: every query is ``WHERE user_id = $1`` with user_id from the JWT sub.
A client-supplied id is NEVER trusted. Tokens are Fernet-encrypted at rest; the
columns hold ciphertext only. Secrets (tokens, code, code_verifier, state) are
never logged.
"""
import os
import asyncio
import logging
import secrets
from datetime import datetime, timezone, timedelta
from typing import Optional, Any
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Request, Query
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from jose import jwt, JWTError

from auth.security import JWT_SECRET, JWT_ALGORITHM
from auth.dependencies import get_current_user
from db import database as db
from db import redis_client as cache
from services import calendar_providers as providers
from services import calendar_crypto

logger = logging.getLogger(__name__)

router = APIRouter()

_STATE_TYP = "cal_state"
_STATE_TTL_MIN = 10
_MAX_WINDOW_DAYS = 62
_DEFAULT_RETURN_TO = "/calendar"
_ERROR_CODES = ("state_invalid", "denied", "exchange_failed", "provider_error")


# ---------------------------------------------------------------------------
# Inline Pydantic models (canonical §2 shapes)
# ---------------------------------------------------------------------------
class Connection(BaseModel):
    provider: str                       # "google" | "microsoft"
    account_email: Optional[str]
    status: str                         # "connected" | "needs_reauth" | "revoked"
    scopes: list[str]
    connected_at: Optional[datetime]
    last_synced_at: Optional[datetime]  # null until first sync


class Organizer(BaseModel):
    display_name: Optional[str] = None
    email: Optional[str] = None


class Attendee(BaseModel):
    display_name: Optional[str] = None
    email: Optional[str] = None
    response_status: Optional[str] = None  # accepted|declined|tentative|needs_action|null


class Conferencing(BaseModel):
    type: Optional[str] = None          # google_meet|microsoft_teams|zoom|other|null
    join_url: Optional[str] = None


class NormalizedEvent(BaseModel):
    id: str                             # "{provider}:{calendar_id}:{provider_event_id}"
    provider: str
    calendar_id: str
    title: str                          # "" if provider omits (never null)
    description: Optional[str] = None
    start: str                          # ISO8601 tz-aware
    end: str
    all_day: bool
    location: Optional[str] = None
    organizer: Optional[Organizer] = None
    attendees: list[Attendee] = []
    status: str                         # confirmed|tentative|cancelled
    html_link: Optional[str] = None
    conferencing: Optional[Conferencing] = None
    color: Optional[str] = None


class ProviderResult(BaseModel):
    provider: str
    ok: bool
    count: int
    error: Optional[str] = None


class EventsResponse(BaseModel):
    events: list[NormalizedEvent]
    providers: list[ProviderResult]


class ConnectResponse(BaseModel):
    authorize_url: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _require_enabled() -> None:
    """503 calendar_disabled when no encryption key is configured.

    Never store plaintext tokens: if Fernet is unconfigured the whole feature is
    off. Read-only listing/disconnect 503 too so the UI shows a single disabled
    state rather than partial behavior.
    """
    if not calendar_crypto.encryption_configured():
        raise HTTPException(status_code=503, detail="calendar_disabled")


def _validate_provider(provider: str) -> None:
    if provider not in providers.PROVIDERS:
        raise HTTPException(status_code=400, detail="unknown provider")


def _safe_return_to(value: Optional[str]) -> str:
    """Open-redirect guard: only allow a relative path starting with a single '/'.

    Rejects absolute URLs, scheme-relative '//host', and backslash tricks —
    falls back to /calendar. The SPA origin is supplied by the server, so the
    return_to can only ever be a path within our own app.
    """
    if not value or not isinstance(value, str):
        return _DEFAULT_RETURN_TO
    if not value.startswith("/") or value.startswith("//"):
        return _DEFAULT_RETURN_TO
    if "://" in value or "\\" in value:
        return _DEFAULT_RETURN_TO
    return value


def _spa_origin() -> str:
    """SPA origin for callback redirects — NEVER request-supplied.

    From CALENDAR_SPA_ORIGIN, else the first CORS_ORIGINS entry.
    """
    explicit = os.getenv("CALENDAR_SPA_ORIGIN", "").strip()
    if explicit:
        return explicit.rstrip("/")
    cors = os.getenv("CORS_ORIGINS", "http://localhost:8080").split(",")
    return (cors[0].strip() if cors else "http://localhost:8080").rstrip("/")


def _make_state(sub: str, nonce: str, return_to: str) -> str:
    exp = datetime.now(timezone.utc) + timedelta(minutes=_STATE_TTL_MIN)
    return jwt.encode(
        {"sub": sub, "nonce": nonce, "return_to": return_to, "typ": _STATE_TYP, "exp": exp},
        JWT_SECRET,
        algorithm=JWT_ALGORITHM,
    )


def _redirect(return_to: str, *, connected: Optional[str] = None,
              error: Optional[str] = None) -> RedirectResponse:
    """Build the 302 back to the SPA with a single result query param."""
    return_to = _safe_return_to(return_to)
    if connected:
        qs = urlencode({"calendar_connected": connected})
    else:
        qs = urlencode({"calendar_error": error or "provider_error"})
    sep = "&" if "?" in return_to else "?"
    return RedirectResponse(url=f"{_spa_origin()}{return_to}{sep}{qs}", status_code=302)


def _parse_tz_aware(value: str, field: str) -> datetime:
    s = (value or "").strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{field} is not valid ISO8601")
    if dt.tzinfo is None:
        raise HTTPException(status_code=400, detail=f"{field} must be timezone-aware")
    return dt


def _event_sort_key(ev: dict) -> datetime:
    s = (ev.get("start") or "").strip()
    try:
        if len(s) == 10:  # date-only (all_day)
            return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        d = datetime.fromisoformat(s)
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return d.astimezone(timezone.utc)
    except ValueError:
        return datetime.max.replace(tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# GET /connections
# ---------------------------------------------------------------------------
@router.get("/connections", response_model=list[Connection])
async def list_connections(user: dict = Depends(get_current_user)):
    """List the current user's calendar connections."""
    _require_enabled()
    user_id = int(user["sub"])
    rows = await db.fetch_all(
        """
        SELECT provider, account_email, status, scopes, created_at, last_synced_at
        FROM calendar_connections
        WHERE user_id = $1
        ORDER BY provider
        """,
        user_id,
    )
    return [
        Connection(
            provider=r["provider"],
            account_email=r["account_email"],
            status=r["status"],
            scopes=list(r["scopes"]) if r["scopes"] else [],
            connected_at=r["created_at"],
            last_synced_at=r["last_synced_at"],
        )
        for r in rows
    ]


# ---------------------------------------------------------------------------
# GET /connect/{provider}
# ---------------------------------------------------------------------------
@router.get("/connect/{provider}", response_model=ConnectResponse)
async def connect(
    provider: str,
    return_to: str = Query(default=_DEFAULT_RETURN_TO),
    user: dict = Depends(get_current_user),
):
    """Begin OAuth: return the provider authorize URL (signed state + PKCE)."""
    _require_enabled()
    _validate_provider(provider)
    if not providers.provider_configured(provider):
        raise HTTPException(
            status_code=400,
            detail=f"{provider} calendar OAuth is not configured on this server",
        )

    user_id = int(user["sub"])
    safe_return = _safe_return_to(return_to)
    nonce = secrets.token_urlsafe(24)
    verifier, challenge = providers.generate_pkce()
    state = _make_state(str(user_id), nonce, safe_return)

    # Stash the PKCE verifier server-side (single-use, TTL 600s).
    await cache.cal_pkce_put(nonce, verifier)

    try:
        authorize_url = providers.build_authorize_url(provider, state, challenge)
    except providers.ProviderNotConfigured as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return ConnectResponse(authorize_url=authorize_url)


# ---------------------------------------------------------------------------
# GET /callback/{provider}  (JWT-exempt; state-validated)
# ---------------------------------------------------------------------------
@router.get("/callback/{provider}")
async def callback(provider: str, request: Request):
    """OAuth redirect target. Validates state+PKCE, exchanges code, stores the
    encrypted connection, then 302s back to the SPA.

    This endpoint is JWT-exempt in the middleware; the user identity comes from
    the signed ``state`` (sub claim), not a bearer token.
    """
    # If the feature is disabled we cannot persist tokens — bounce with an error.
    if not calendar_crypto.encryption_configured():
        return _redirect(_DEFAULT_RETURN_TO, error="provider_error")

    if provider not in providers.PROVIDERS:
        return _redirect(_DEFAULT_RETURN_TO, error="provider_error")

    qp = request.query_params
    state = qp.get("state")
    code = qp.get("code")
    oauth_error = qp.get("error")

    # 1) Verify the signed state (sig + exp + typ). Recovers return_to + sub + nonce.
    if not state:
        return _redirect(_DEFAULT_RETURN_TO, error="state_invalid")
    try:
        claims = jwt.decode(state, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except JWTError:
        return _redirect(_DEFAULT_RETURN_TO, error="state_invalid")
    if claims.get("typ") != _STATE_TYP:
        return _redirect(_DEFAULT_RETURN_TO, error="state_invalid")

    return_to = _safe_return_to(claims.get("return_to"))
    nonce = claims.get("nonce")
    sub = claims.get("sub")
    if not nonce or not sub:
        return _redirect(return_to, error="state_invalid")
    try:
        user_id = int(sub)
    except (TypeError, ValueError):
        return _redirect(return_to, error="state_invalid")

    # 2) User denied consent at the provider.
    if oauth_error or not code:
        return _redirect(return_to, error="denied")

    # 3) Pop the single-use PKCE verifier (replay guard). Missing → fail closed.
    verifier = await cache.cal_pkce_pop(nonce)
    if not verifier:
        return _redirect(return_to, error="state_invalid")

    # 4) Exchange code → tokens.
    try:
        tokens = await providers.exchange_code(provider, code, verifier)
    except providers.ProviderNotConfigured:
        return _redirect(return_to, error="provider_error")
    except providers.ExchangeFailed:
        return _redirect(return_to, error="exchange_failed")
    except Exception:
        logger.warning("Calendar %s exchange unexpected error", provider, exc_info=True)
        return _redirect(return_to, error="exchange_failed")

    # 5) Fetch account identity (email + provider account id).
    try:
        account_email, provider_account_id = await providers.fetch_identity(
            provider, tokens.access_token
        )
    except Exception:
        logger.warning("Calendar %s identity fetch failed", provider, exc_info=True)
        return _redirect(return_to, error="provider_error")

    # 6) Encrypt + UPSERT the connection (COALESCE preserves an existing refresh
    #    token when the provider does not re-issue one).
    try:
        access_enc = calendar_crypto.encrypt(tokens.access_token)
        refresh_enc = calendar_crypto.encrypt(tokens.refresh_token)
        await db.execute(
            """
            INSERT INTO calendar_connections
                (user_id, provider, account_email, provider_account_id,
                 access_token_enc, refresh_token_enc, token_expires_at,
                 scopes, status, last_synced_at, updated_at)
            VALUES ($1::int, $2::text, $3::text, $4::text, $5::text, $6::text,
                    $7::timestamptz, $8::text[], 'connected', NULL, now())
            ON CONFLICT (user_id, provider, account_email)
            DO UPDATE SET
                provider_account_id = EXCLUDED.provider_account_id,
                access_token_enc    = EXCLUDED.access_token_enc,
                refresh_token_enc   = COALESCE(EXCLUDED.refresh_token_enc,
                                               calendar_connections.refresh_token_enc),
                token_expires_at    = EXCLUDED.token_expires_at,
                scopes              = EXCLUDED.scopes,
                status              = 'connected',
                updated_at          = now()
            """,
            user_id,
            provider,
            account_email,
            provider_account_id,
            access_enc,
            refresh_enc,
            tokens.expires_at,
            providers.canonical_scopes(provider),
        )
    except Exception:
        logger.warning("Calendar %s connection persist failed", provider, exc_info=True)
        return _redirect(return_to, error="provider_error")

    return _redirect(return_to, connected=provider)


# ---------------------------------------------------------------------------
# DELETE /connections/{provider}
# ---------------------------------------------------------------------------
@router.delete("/connections/{provider}")
async def disconnect(provider: str, user: dict = Depends(get_current_user)):
    """Best-effort provider revoke, then delete the connection row(s)."""
    _require_enabled()
    _validate_provider(provider)
    user_id = int(user["sub"])

    rows = await db.fetch_all(
        """
        SELECT id, access_token_enc, refresh_token_enc
        FROM calendar_connections
        WHERE user_id = $1 AND provider = $2
        """,
        user_id,
        provider,
    )
    if not rows:
        raise HTTPException(status_code=404, detail="connection not found")

    # Best-effort revoke per account (never blocks the delete).
    for r in rows:
        access = calendar_crypto.decrypt(r["access_token_enc"])
        refresh = calendar_crypto.decrypt(r["refresh_token_enc"])
        try:
            await providers.revoke(provider, access, refresh)
        except Exception:
            logger.info("Calendar %s revoke errored (ignored)", provider)

    await db.execute(
        "DELETE FROM calendar_connections WHERE user_id = $1 AND provider = $2",
        user_id,
        provider,
    )
    return {"status": "disconnected", "provider": provider}


# ---------------------------------------------------------------------------
# GET /events
# ---------------------------------------------------------------------------
async def _fetch_one_provider(row: Any, user_id: int, start: datetime, end: datetime) -> dict:
    """Fetch + normalize one provider's events. Returns a structured result;
    a single provider failing must NEVER raise out to the aggregate."""
    provider = row["provider"]
    bucket = f"{start.date().isoformat()}_{end.date().isoformat()}"
    cache_key = f"{user_id}:{provider}:{bucket}"

    cached = await cache.cal_events_get(cache_key)
    if cached is not None:
        return {"provider": provider, "ok": True, "count": len(cached), "error": None, "events": cached}

    try:
        token = await providers.get_valid_access_token(row)
    except providers.NeedsReauth:
        await db.execute(
            "UPDATE calendar_connections SET status = 'needs_reauth', updated_at = now() WHERE id = $1",
            row["id"],
        )
        return {"provider": provider, "ok": False, "count": 0, "error": "needs_reauth", "events": []}
    except Exception:
        logger.warning("Calendar %s token refresh failed", provider, exc_info=True)
        return {"provider": provider, "ok": False, "count": 0, "error": "provider_error", "events": []}

    # Persist refreshed tokens.
    if token.refreshed:
        try:
            await db.execute(
                """
                UPDATE calendar_connections
                SET access_token_enc = $2::text,
                    refresh_token_enc = $3::text,
                    token_expires_at = $4::timestamptz,
                    status = 'connected',
                    updated_at = now()
                WHERE id = $1
                """,
                row["id"], token.access_token_enc, token.refresh_token_enc, token.token_expires_at,
            )
        except Exception:
            logger.warning("Calendar %s token persist failed (continuing)", provider, exc_info=True)

    try:
        events = await providers.list_events(provider, token.token, start, end)
    except Exception:
        logger.warning("Calendar %s event fetch failed", provider, exc_info=True)
        return {"provider": provider, "ok": False, "count": 0, "error": "provider_error", "events": []}

    await cache.cal_events_set(cache_key, events)
    try:
        await db.execute(
            "UPDATE calendar_connections SET last_synced_at = now() WHERE id = $1",
            row["id"],
        )
    except Exception:
        logger.debug("Calendar %s last_synced_at update failed (ignored)", provider)

    return {"provider": provider, "ok": True, "count": len(events), "error": None, "events": events}


@router.get("/events", response_model=EventsResponse)
async def list_events(
    start: str = Query(...),
    end: str = Query(...),
    provider: Optional[str] = Query(default=None),
    user: dict = Depends(get_current_user),
):
    """Aggregate read-only events across connected providers for [start, end].

    Providers run concurrently; one failing provider degrades to a providers[]
    entry with ok=false and never 500s the aggregate.
    """
    _require_enabled()
    user_id = int(user["sub"])

    start_dt = _parse_tz_aware(start, "start")
    end_dt = _parse_tz_aware(end, "end")
    if end_dt <= start_dt:
        raise HTTPException(status_code=400, detail="end must be after start")
    if end_dt - start_dt > timedelta(days=_MAX_WINDOW_DAYS):
        raise HTTPException(status_code=400, detail=f"window must be <= {_MAX_WINDOW_DAYS} days")

    if provider is not None:
        _validate_provider(provider)

    query = """
        SELECT id, provider, account_email, access_token_enc, refresh_token_enc,
               token_expires_at, status
        FROM calendar_connections
        WHERE user_id = $1 AND status <> 'revoked'
    """
    values: list[Any] = [user_id]
    if provider is not None:
        query += " AND provider = $2"
        values.append(provider)
    rows = await db.fetch_all(query, *values)

    if not rows:
        return EventsResponse(events=[], providers=[])

    results = await asyncio.gather(
        *[_fetch_one_provider(r, user_id, start_dt, end_dt) for r in rows],
        return_exceptions=True,
    )

    # Aggregate events + per-provider status (merged by provider).
    all_events: list[dict] = []
    by_provider: dict[str, dict] = {}
    for idx, res in enumerate(results):
        if isinstance(res, Exception):
            # A leaked exception (should not happen) → mark that provider failed.
            pname = rows[idx]["provider"]
            agg = by_provider.setdefault(pname, {"provider": pname, "ok": True, "count": 0, "error": None})
            agg["ok"] = False
            if agg["error"] is None:
                agg["error"] = "provider_error"
            continue
        pname = res["provider"]
        all_events.extend(res["events"])
        agg = by_provider.setdefault(pname, {"provider": pname, "ok": True, "count": 0, "error": None})
        agg["count"] += res["count"]
        if not res["ok"]:
            agg["ok"] = False
            if agg["error"] is None:
                agg["error"] = res["error"]

    all_events.sort(key=_event_sort_key)

    return EventsResponse(
        events=[NormalizedEvent(**e) for e in all_events],
        providers=[ProviderResult(**p) for p in by_provider.values()],
    )
