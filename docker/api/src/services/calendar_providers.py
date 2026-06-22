"""OAuth + fetch + normalize for Google Calendar and Microsoft Graph (read-only).

This module owns all provider-specific HTTP. It is deliberately DB-free except
for using :mod:`services.calendar_crypto` to (de/re)crypt tokens in
``get_valid_access_token`` — the router does the actual persistence.

Design points:
  * **Missing creds degrade gracefully.** Config is read at import but a missing
    client id/secret only raises :class:`ProviderNotConfigured` when a connect is
    attempted — import and app startup never crash.
  * **Read-only scopes** (Google calendar.readonly + calendarlist.readonly;
    Microsoft Calendars.Read).
  * **PKCE S256** for both providers; the verifier lives server-side in Redis.
  * **Refresh-on-read**: ``get_valid_access_token`` refreshes a near-expiry token
    and returns the re-encrypted material for the router to persist; an
    ``invalid_grant`` raises :class:`NeedsReauth` so the caller flips status.
  * **Never log** tokens, ``code``, ``code_verifier``, or ``state``.

Recurrence is expanded provider-side: Google ``singleEvents=true&orderBy=startTime``;
Microsoft ``/me/calendarView`` (always expands) with ``Prefer: outlook.timezone="UTC"``.
"""
import os
import base64
import hashlib
import logging
import secrets
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from typing import Optional, Any
from urllib.parse import urlencode

import httpx

from services import calendar_crypto

logger = logging.getLogger(__name__)

PROVIDERS = ("google", "microsoft")

# Refresh a token this many seconds before its expiry (refresh-on-read window).
_REFRESH_SKEW_SEC = 60
_HTTP_TIMEOUT = httpx.Timeout(15.0, connect=8.0)

# ---------------------------------------------------------------------------
# Config (read once at import; missing values surface only on connect attempts)
# ---------------------------------------------------------------------------
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CALENDAR_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CALENDAR_CLIENT_SECRET", "")
MICROSOFT_CLIENT_ID = os.getenv("MICROSOFT_CLIENT_ID", "")
MICROSOFT_CLIENT_SECRET = os.getenv("MICROSOFT_CLIENT_SECRET", "")
MICROSOFT_TENANT = os.getenv("MICROSOFT_TENANT", "common") or "common"
OAUTH_REDIRECT_BASE = os.getenv("CALENDAR_OAUTH_REDIRECT_BASE", "").rstrip("/")

# Google OAuth request scopes (full URIs the consent screen needs).
_GOOGLE_OAUTH_SCOPES = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "openid",
    "email",
    "profile",
]
# Microsoft Graph delegated scopes.
_MICROSOFT_OAUTH_SCOPES = [
    "Calendars.Read",
    "offline_access",
    "openid",
    "profile",
    "email",
]

# Short canonical scope names stored on the connection row / returned by the API
# (per the §2 contract — NOT the full request URIs above).
_CANONICAL_SCOPES = {
    "google": ["calendar.readonly", "calendar.calendarlist.readonly"],
    "microsoft": ["Calendars.Read"],
}

# Endpoints
_GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
_GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
_GOOGLE_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events"
_GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke"
_GOOGLE_CALENDAR_ID = "primary"

_MS_AUTH_URL = "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize"
_MS_TOKEN_URL = "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"
_MS_ME_URL = "https://graph.microsoft.com/v1.0/me"
_MS_CALENDARVIEW_URL = "https://graph.microsoft.com/v1.0/me/calendarView"
_MS_CALENDAR_ID = "default"


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------
class CalendarProviderError(Exception):
    """Base for provider errors."""


class ProviderNotConfigured(CalendarProviderError):
    """Provider OAuth client id/secret (or redirect base) is not configured."""


class ExchangeFailed(CalendarProviderError):
    """The authorization-code/token exchange failed."""


class NeedsReauth(CalendarProviderError):
    """The refresh token is invalid/expired (invalid_grant) — user must reconnect."""


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------
@dataclass
class TokenSet:
    """Tokens from an authorization-code exchange or refresh."""
    access_token: str
    refresh_token: Optional[str]
    expires_at: Optional[datetime]
    scopes: list[str] = field(default_factory=list)


@dataclass
class ValidAccessToken:
    """Result of refresh-on-read.

    ``token`` is the usable plaintext access token. When ``refreshed`` is True the
    ``*_enc`` / ``token_expires_at`` fields carry the re-encrypted material the
    router should persist back to the row.
    """
    token: str
    refreshed: bool = False
    access_token_enc: Optional[str] = None
    refresh_token_enc: Optional[str] = None
    token_expires_at: Optional[datetime] = None


# ---------------------------------------------------------------------------
# Config helpers
# ---------------------------------------------------------------------------
def canonical_scopes(provider: str) -> list[str]:
    """Short scope names stored on the row / returned by the API."""
    return list(_CANONICAL_SCOPES.get(provider, []))


def provider_configured(provider: str) -> bool:
    """True iff this provider has client id/secret AND a redirect base set."""
    if not OAUTH_REDIRECT_BASE:
        return False
    if provider == "google":
        return bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)
    if provider == "microsoft":
        return bool(MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET)
    return False


def _client_creds(provider: str) -> tuple[str, str]:
    if provider == "google":
        return GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
    if provider == "microsoft":
        return MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET
    raise ProviderNotConfigured(f"unknown provider: {provider}")


def redirect_uri(provider: str) -> str:
    """Provider redirect target. MUST match the registered OAuth redirect URI."""
    if not OAUTH_REDIRECT_BASE:
        raise ProviderNotConfigured("CALENDAR_OAUTH_REDIRECT_BASE is not set")
    return f"{OAUTH_REDIRECT_BASE}/v1/calendar/callback/{provider}"


# ---------------------------------------------------------------------------
# PKCE
# ---------------------------------------------------------------------------
def generate_pkce() -> tuple[str, str]:
    """Return (verifier, challenge) for PKCE S256.

    The verifier is a high-entropy URL-safe string kept server-side (Redis); the
    S256 challenge is sent in the authorize URL.
    """
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(64)).decode().rstrip("=")
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).decode().rstrip("=")
    return verifier, challenge


# ---------------------------------------------------------------------------
# Authorize URL
# ---------------------------------------------------------------------------
def build_authorize_url(provider: str, state: str, code_challenge: str) -> str:
    """Build the provider authorize URL (PKCE S256, read-only scopes).

    Raises :class:`ProviderNotConfigured` when creds/redirect base are missing.
    """
    if not provider_configured(provider):
        raise ProviderNotConfigured(f"{provider} OAuth is not configured")

    client_id, _ = _client_creds(provider)
    if provider == "google":
        params = {
            "client_id": client_id,
            "redirect_uri": redirect_uri("google"),
            "response_type": "code",
            "scope": " ".join(_GOOGLE_OAUTH_SCOPES),
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
            # offline + consent guarantee a refresh_token is issued.
            "access_type": "offline",
            "prompt": "consent",
            "include_granted_scopes": "true",
        }
        return f"{_GOOGLE_AUTH_URL}?{urlencode(params)}"

    # microsoft
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri("microsoft"),
        "response_type": "code",
        "response_mode": "query",
        "scope": " ".join(_MICROSOFT_OAUTH_SCOPES),
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    return f"{_MS_AUTH_URL.format(tenant=MICROSOFT_TENANT)}?{urlencode(params)}"


# ---------------------------------------------------------------------------
# Token exchange / refresh
# ---------------------------------------------------------------------------
def _token_url(provider: str) -> str:
    if provider == "google":
        return _GOOGLE_TOKEN_URL
    return _MS_TOKEN_URL.format(tenant=MICROSOFT_TENANT)


def _parse_token_response(data: dict) -> TokenSet:
    expires_at = None
    expires_in = data.get("expires_in")
    if isinstance(expires_in, (int, float)):
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=int(expires_in))
    scope_str = data.get("scope") or ""
    scopes = scope_str.split() if isinstance(scope_str, str) else []
    return TokenSet(
        access_token=data["access_token"],
        refresh_token=data.get("refresh_token"),
        expires_at=expires_at,
        scopes=scopes,
    )


async def exchange_code(provider: str, code: str, code_verifier: str) -> TokenSet:
    """Exchange an authorization code for tokens (PKCE). Raises ExchangeFailed."""
    if not provider_configured(provider):
        raise ProviderNotConfigured(f"{provider} OAuth is not configured")
    client_id, client_secret = _client_creds(provider)
    payload = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri(provider),
        "client_id": client_id,
        "client_secret": client_secret,
        "code_verifier": code_verifier,
    }
    if provider == "microsoft":
        payload["scope"] = " ".join(_MICROSOFT_OAUTH_SCOPES)
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as http:
            resp = await http.post(_token_url(provider), data=payload)
    except httpx.HTTPError as exc:
        raise ExchangeFailed(f"token endpoint unreachable: {type(exc).__name__}") from exc
    if resp.status_code != 200:
        # Never log the code/verifier; the provider error body has no secrets of ours.
        logger.warning("Calendar %s code exchange failed: HTTP %s", provider, resp.status_code)
        raise ExchangeFailed(f"token exchange HTTP {resp.status_code}")
    try:
        return _parse_token_response(resp.json())
    except (KeyError, ValueError) as exc:
        raise ExchangeFailed("malformed token response") from exc


async def _refresh(provider: str, refresh_token: str) -> TokenSet:
    """Refresh an access token. Raises NeedsReauth on invalid_grant."""
    if not provider_configured(provider):
        raise ProviderNotConfigured(f"{provider} OAuth is not configured")
    client_id, client_secret = _client_creds(provider)
    payload = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": client_id,
        "client_secret": client_secret,
    }
    if provider == "microsoft":
        payload["scope"] = " ".join(_MICROSOFT_OAUTH_SCOPES)
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as http:
            resp = await http.post(_token_url(provider), data=payload)
    except httpx.HTTPError as exc:
        raise ExchangeFailed(f"refresh endpoint unreachable: {type(exc).__name__}") from exc
    if resp.status_code == 400:
        body = ""
        try:
            body = (resp.json() or {}).get("error", "")
        except ValueError:
            pass
        if body == "invalid_grant":
            raise NeedsReauth("refresh token rejected (invalid_grant)")
        raise ExchangeFailed(f"refresh HTTP 400 ({body or 'unknown'})")
    if resp.status_code != 200:
        raise ExchangeFailed(f"refresh HTTP {resp.status_code}")
    try:
        return _parse_token_response(resp.json())
    except (KeyError, ValueError) as exc:
        raise ExchangeFailed("malformed refresh response") from exc


async def get_valid_access_token(row: Any) -> ValidAccessToken:
    """Return a usable access token, refreshing on-read when near expiry.

    ``row`` is the connection record (access_token_enc / refresh_token_enc /
    token_expires_at). Raises :class:`NeedsReauth` when no usable token can be
    produced (no/expired access token AND refresh fails or is missing) — the
    caller flips ``status=needs_reauth`` and surfaces it via ``providers[]``.
    """
    provider = row["provider"]
    access_token = calendar_crypto.decrypt(row.get("access_token_enc"))
    refresh_token = calendar_crypto.decrypt(row.get("refresh_token_enc"))
    expires_at = row.get("token_expires_at")

    now = datetime.now(timezone.utc)
    near_expiry = True
    if access_token and expires_at is not None:
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        near_expiry = expires_at <= now + timedelta(seconds=_REFRESH_SKEW_SEC)

    if access_token and not near_expiry:
        return ValidAccessToken(token=access_token, refreshed=False)

    # Need a refresh.
    if not refresh_token:
        raise NeedsReauth("no refresh token available")

    new = await _refresh(provider, refresh_token)
    # Providers may omit a new refresh token — preserve the existing one.
    new_refresh = new.refresh_token or refresh_token
    return ValidAccessToken(
        token=new.access_token,
        refreshed=True,
        access_token_enc=calendar_crypto.encrypt(new.access_token),
        refresh_token_enc=calendar_crypto.encrypt(new_refresh),
        token_expires_at=new.expires_at,
    )


# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------
async def fetch_identity(provider: str, access_token: str) -> tuple[Optional[str], Optional[str]]:
    """Return (account_email, provider_account_id) for the connected account."""
    headers = {"Authorization": f"Bearer {access_token}"}
    async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as http:
        if provider == "google":
            resp = await http.get(_GOOGLE_USERINFO_URL, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            return data.get("email"), data.get("sub")
        # microsoft
        resp = await http.get(_MS_ME_URL, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        email = data.get("mail") or data.get("userPrincipalName")
        return email, data.get("id")


# ---------------------------------------------------------------------------
# Revoke (best-effort)
# ---------------------------------------------------------------------------
async def revoke(provider: str, access_token: Optional[str], refresh_token: Optional[str]) -> None:
    """Best-effort token revoke. Never raises — disconnect proceeds regardless."""
    try:
        if provider == "google":
            token = refresh_token or access_token
            if not token:
                return
            async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as http:
                await http.post(_GOOGLE_REVOKE_URL, data={"token": token})
        # Microsoft Graph has no delegated-token revoke endpoint — discarding the
        # stored tokens (row delete by the caller) is the disconnect.
    except httpx.HTTPError as exc:
        logger.info("Calendar %s revoke best-effort failed: %s", provider, type(exc).__name__)


# ---------------------------------------------------------------------------
# Event listing + normalization
# ---------------------------------------------------------------------------
async def list_events(
    provider: str, access_token: str, start: datetime, end: datetime
) -> list[dict]:
    """Fetch events in [start, end] and map each to a canonical NormalizedEvent."""
    if provider == "google":
        return await _list_google_events(access_token, start, end)
    return await _list_microsoft_events(access_token, start, end)


def _iso_utc(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---- Google ---------------------------------------------------------------
_GOOGLE_ATTENDEE_STATUS = {
    "accepted": "accepted",
    "declined": "declined",
    "tentative": "tentative",
    "needsAction": "needs_action",
}


async def _list_google_events(access_token: str, start: datetime, end: datetime) -> list[dict]:
    headers = {"Authorization": f"Bearer {access_token}"}
    params = {
        "singleEvents": "true",
        "orderBy": "startTime",
        "timeMin": _iso_utc(start),
        "timeMax": _iso_utc(end),
        "maxResults": "250",
    }
    events: list[dict] = []
    page_token: Optional[str] = None
    async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as http:
        for _ in range(20):  # safety cap on pagination
            if page_token:
                params["pageToken"] = page_token
            resp = await http.get(_GOOGLE_EVENTS_URL, headers=headers, params=params)
            resp.raise_for_status()
            data = resp.json()
            for item in data.get("items", []):
                events.append(_map_google_event(item))
            page_token = data.get("nextPageToken")
            if not page_token:
                break
    return events


def _g_time(node: dict) -> tuple[str, bool]:
    """Return (iso_string, all_day) from a Google start/end node."""
    if node.get("date"):  # all-day
        return node["date"], True
    return node.get("dateTime", ""), False


def _map_google_event(item: dict) -> dict:
    start_iso, all_day = _g_time(item.get("start", {}))
    end_iso, _ = _g_time(item.get("end", {}))

    organizer = None
    org = item.get("organizer")
    if org:
        organizer = {"display_name": org.get("displayName"), "email": org.get("email")}

    attendees = []
    for a in item.get("attendees", []) or []:
        attendees.append({
            "display_name": a.get("displayName"),
            "email": a.get("email"),
            "response_status": _GOOGLE_ATTENDEE_STATUS.get(a.get("responseStatus")),
        })

    status = item.get("status") or "confirmed"
    if status not in ("confirmed", "tentative", "cancelled"):
        status = "confirmed"

    # Conferencing: hangoutLink or conferenceData video entry point.
    conferencing = None
    join_url = item.get("hangoutLink")
    ctype = "google_meet" if join_url else None
    conf = item.get("conferenceData")
    if conf and not join_url:
        for ep in conf.get("entryPoints", []) or []:
            if ep.get("entryPointType") == "video" and ep.get("uri"):
                join_url = ep["uri"]
                break
        sol = (conf.get("conferenceSolution") or {}).get("key", {}).get("type")
        ctype = "google_meet" if sol == "hangoutsMeet" else ("other" if join_url else None)
    if join_url:
        conferencing = {"type": ctype, "join_url": join_url}

    return {
        "id": f"google:{_GOOGLE_CALENDAR_ID}:{item.get('id', '')}",
        "provider": "google",
        "calendar_id": _GOOGLE_CALENDAR_ID,
        "title": item.get("summary") or "",
        "description": item.get("description"),
        "start": start_iso,
        "end": end_iso,
        "all_day": all_day,
        "location": item.get("location"),
        "organizer": organizer,
        "attendees": attendees,
        "status": status,
        "html_link": item.get("htmlLink"),
        "conferencing": conferencing,
        "color": item.get("colorId"),
    }


# ---- Microsoft ------------------------------------------------------------
_MS_ATTENDEE_STATUS = {
    "accepted": "accepted",
    "declined": "declined",
    "tentativelyAccepted": "tentative",
    "notResponded": "needs_action",
    "none": "needs_action",
    "organizer": "accepted",
}


async def _list_microsoft_events(access_token: str, start: datetime, end: datetime) -> list[dict]:
    headers = {
        "Authorization": f"Bearer {access_token}",
        # Return all event times in UTC so we can emit consistent tz-aware ISO.
        "Prefer": 'outlook.timezone="UTC"',
    }
    params = {
        "startDateTime": _iso_utc(start),
        "endDateTime": _iso_utc(end),
        "$orderby": "start/dateTime",
        "$top": "250",
        "$select": (
            "id,subject,bodyPreview,start,end,isAllDay,location,organizer,"
            "attendees,isCancelled,showAs,webLink,isOnlineMeeting,onlineMeeting,"
            "onlineMeetingProvider"
        ),
    }
    events: list[dict] = []
    url: Optional[str] = _MS_CALENDARVIEW_URL
    async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as http:
        for _ in range(20):  # safety cap on pagination
            # @odata.nextLink already carries query params; only send params on first call.
            resp = await http.get(url, headers=headers, params=params if url == _MS_CALENDARVIEW_URL else None)
            resp.raise_for_status()
            data = resp.json()
            for item in data.get("value", []):
                events.append(_map_microsoft_event(item))
            url = data.get("@odata.nextLink")
            if not url:
                break
    return events


def _ms_time(node: Optional[dict], all_day: bool) -> str:
    """Map a Graph dateTimeTimeZone node to an ISO8601 string.

    With ``Prefer: outlook.timezone="UTC"`` the value is UTC. Graph returns a
    7-digit fractional second with no offset, e.g. ``2026-06-18T14:00:00.0000000``.
    """
    if not node:
        return ""
    raw = node.get("dateTime", "")
    if not raw:
        return ""
    # Drop fractional seconds for a clean ISO string.
    base = raw.split(".")[0]
    if all_day:
        return base.split("T")[0]
    return f"{base}Z"


def _map_microsoft_event(item: dict) -> dict:
    all_day = bool(item.get("isAllDay"))
    start_iso = _ms_time(item.get("start"), all_day)
    end_iso = _ms_time(item.get("end"), all_day)

    organizer = None
    org_ea = (item.get("organizer") or {}).get("emailAddress")
    if org_ea:
        organizer = {"display_name": org_ea.get("name"), "email": org_ea.get("address")}

    attendees = []
    for a in item.get("attendees", []) or []:
        ea = a.get("emailAddress") or {}
        resp_status = (a.get("status") or {}).get("response")
        attendees.append({
            "display_name": ea.get("name"),
            "email": ea.get("address"),
            "response_status": _MS_ATTENDEE_STATUS.get(resp_status),
        })

    if item.get("isCancelled"):
        status = "cancelled"
    elif item.get("showAs") == "tentative":
        status = "tentative"
    else:
        status = "confirmed"

    conferencing = None
    if item.get("isOnlineMeeting") and item.get("onlineMeeting"):
        join_url = (item.get("onlineMeeting") or {}).get("joinUrl")
        if join_url:
            mp = item.get("onlineMeetingProvider")
            ctype = "microsoft_teams" if mp == "teamsForBusiness" else "other"
            conferencing = {"type": ctype, "join_url": join_url}

    color = item.get("color")
    if color == "auto":
        color = None

    location = (item.get("location") or {}).get("displayName") or None

    return {
        "id": f"microsoft:{_MS_CALENDAR_ID}:{item.get('id', '')}",
        "provider": "microsoft",
        "calendar_id": _MS_CALENDAR_ID,
        "title": item.get("subject") or "",
        "description": item.get("bodyPreview"),
        "start": start_iso,
        "end": end_iso,
        "all_day": all_day,
        "location": location,
        "organizer": organizer,
        "attendees": attendees,
        "status": status,
        "html_link": item.get("webLink"),
        "conferencing": conferencing,
        "color": color,
    }
