# Calendar Integration Plan — Unified Comms (v1, read-only)

**Status:** Design only — no code written. Two expert plans (backend + frontend) reconciled and verified.
**Branch:** `unified` · **Scope:** v1 = read-only, per-user, **direct** OAuth (Google Calendar API + Microsoft Graph), **no aggregator**.
**Product home:** Unified Comms → a new **Calendar** child under the existing `ExpandableNavItem`, route `/calendar`.

---

## 1. Overview & locked decisions

A user connects their **Google Calendar** and/or **Microsoft 365 (Outlook)** calendar via OAuth and views a unified, read-only calendar inside Unified Comms (month / week / agenda). v1 is connect → view → disconnect. No create/edit/delete, no write scopes.

**Decision log**
- **Direct integration, not an aggregator (Nylas/Cronofy).** Granite is carrier-grade, cost-sensitive, and data-sovereignty-conscious; an aggregator adds per-connection cost, an external sub-processor holding all customer calendar tokens (GDPR/contractual liability), and a dependency in the data path. Two well-documented providers reachable with the `httpx` we already ship. We own refresh/normalization/(later) webhooks — accepted.
- **Read-only first.** Minimal scopes (Google `calendar.readonly` + `calendar.calendarlist.readonly`; Microsoft `Calendars.Read`). Smallest blast radius, fastest Google verification.
- **Per-user, not per-customer.** Calendar connections key on the JWT `sub` (user id), finer-grained than the customer-scoped routers — `get_customer_filter` is **not** used here.
- **Signed-state + PKCE OAuth** so the JWT-exempt provider callback can authenticate the user without a bearer token (mirrors the existing `auth/ingest.py` exempt-in-middleware/validate-in-router pattern).
- **Tokens encrypted at rest** (Fernet via `cryptography`); on-demand event fetch + short Redis cache; **webhooks deferred to Phase 2**.

**Verified against the codebase (load-bearing):** next migration = **32**; `users.id` is `SERIAL` (INT) → FK target; the `RequireUcaas` `<Outlet>` group wraps the comms routes (App.tsx ~104–125) → `/calendar` goes inside it; `auth/ingest.py` (`ingest_secret_ok` + `hmac.compare_digest`) is the exemption pattern to model.

---

## 2. Canonical API contract (single source of truth)

> ⚠️ **Reconciliation note.** The backend and frontend plans were written in parallel and chose **different field names/enums** in 6 places. The shapes below are the *authoritative* contract — both layers must build to these exactly. Differences resolved:
> 1. **Connection.status** → `connected | needs_reauth | revoked` (was frontend `active|expired|revoked|error`).
> 2. **organizer/attendee name field** → `display_name` (was backend `name`).
> 3. **organizer** object and **organizer.email** are nullable.
> 4. **html_link** → `string | null` (was frontend non-null).
> 5. **conferencing** → `{ type, join_url }`, `type ∈ google_meet|microsoft_teams|zoom|other` (was frontend `{provider, join_url, label}`; UI derives the label from `type`).
> 6. **events response** → `{ events, providers }` — the `providers[]` partial-failure array **must** be consumed by the UI (was frontend `{events}` only).

All endpoints mounted at **both** `/v1/calendar` and `/calendar` (per repo convention). All require a valid JWT and operate on `user_id = int(user["sub"])` — **except the callback**, which is JWT-exempt and state-validated.

### `GET /calendar/connections` → `Connection[]`
```jsonc
{
  "provider": "google",                 // "google" | "microsoft"
  "account_email": "alice@example.com",
  "status": "connected",                // "connected" | "needs_reauth" | "revoked"
  "scopes": ["calendar.readonly", "calendar.calendarlist.readonly"],
  "connected_at": "2026-06-18T14:03:11Z",
  "last_synced_at": "2026-06-18T15:22:40Z"   // null until first sync
}
```

### `GET /calendar/connect/{provider}?return_to=<spa-path>` → `{ "authorize_url": string }`
- `provider ∈ google|microsoft` (validated). `return_to` must be a **relative** path starting with `/` (open-redirect guard; default `/calendar`).
- Builds signed `state` (HS256, `JWT_SECRET_KEY`, `typ=cal_state`, exp 10m, carries `sub`+`nonce`+`return_to`) and a PKCE verifier stashed in Redis (`cal:pkce:{nonce}`, TTL 600s, single-use).
- Frontend then `window.location.assign(authorize_url)`.

### `GET /calendar/callback/{provider}` (JWT-exempt; state-validated)
- Provider redirect target. Verifies `state` (sig+exp+typ) → pops PKCE verifier (`GETDEL`, replay guard) → exchanges `code`→tokens → fetches account identity → encrypts + UPSERTs the connection → **302** to:
  - success: `{SPA_ORIGIN}{return_to}?calendar_connected={provider}`
  - failure: `{SPA_ORIGIN}{return_to}?calendar_error={code}` where `code ∈ state_invalid|denied|exchange_failed|provider_error` (`return_to` falls back to `/calendar`).
- `SPA_ORIGIN` derived from `CALENDAR_SPA_ORIGIN`/first `CORS_ORIGINS` — never attacker-supplied host.

### `DELETE /calendar/connections/{provider}` → `200 { "status": "disconnected", "provider": "google" }`
- Best-effort provider revoke (Google revoke endpoint; Microsoft = discard tokens) then delete the row. `404` if no connection. (Frontend ignores the body; 200-with-body is fine through `apiRequest`.)

### `GET /calendar/events?start=<ISO8601>&end=<ISO8601>[&provider=]` → `{ events, providers }`
- `start`/`end` required, tz-aware ISO8601, `end>start`, window ≤ 62 days (else 400). Runs connected providers concurrently (`asyncio.gather(return_exceptions=True)`) — **one provider failing never 500s the aggregate.**
```jsonc
{
  "events": [ /* NormalizedEvent[], sorted by start asc */ ],
  "providers": [
    { "provider": "google",    "ok": true,  "count": 12, "error": null },
    { "provider": "microsoft", "ok": false, "count": 0,  "error": "needs_reauth" }
  ]
}
```

### NormalizedEvent / CalendarEvent (canonical — verbatim both sides)
```jsonc
{
  "id": "string",                  // stable composite: "{provider}:{calendar_id}:{provider_event_id}"
  "provider": "google",            // "google" | "microsoft"
  "calendar_id": "string",
  "title": "string",               // "" if provider omits (never null)
  "description": "string | null",
  "start": "2026-06-18T14:00:00-04:00",  // ISO8601 tz-aware; all_day → date at 00:00 event tz
  "end":   "2026-06-18T15:00:00-04:00",
  "all_day": false,
  "location": "string | null",
  "organizer": { "display_name": "string | null", "email": "string | null" }, // object may be null
  "attendees": [ { "display_name": "string | null", "email": "string | null",
                   "response_status": "accepted|declined|tentative|needs_action|null" } ], // [] in v1 OK
  "status": "confirmed",           // "confirmed" | "tentative" | "cancelled"
  "html_link": "string | null",    // provider deep link
  "conferencing": { "type": "google_meet|microsoft_teams|zoom|other|null",
                    "join_url": "string | null" },  // object may be null
  "color": "string | null"
}
```
**Provider mapping:** Google `events.list?singleEvents=true&orderBy=startTime` (expands recurrences); Microsoft `/me/calendarView` with `Prefer: outlook.timezone="UTC"` (expands recurrences). Field mapping per the backend plan §2.

---

## 3. Backend architecture (`docker/api/src`)

**New files**
| File | Purpose |
|---|---|
| `docker/postgres/init/32_schema_calendar.sql` | `calendar_connections` table + grants (idempotent) |
| `routers/calendar.py` | All endpoints + inline Pydantic models |
| `services/calendar_providers.py` | Google/Microsoft OAuth, fetch, normalize, refresh-on-read |
| `services/calendar_crypto.py` | Fernet encrypt/decrypt + `MultiFernet` key rotation |

**Edits:** `middleware/auth.py` (add **only** `if "/calendar/callback/" in path: return await call_next(request)`), `main.py` (mount router twice), `db/redis_client.py` (`cal_pkce_put/pop`, `cal_events_get/set` — thin fail-open wrappers), `requirements.txt` (`cryptography>=42.0.0`; httpx already present).

**Schema (migration 32, idempotent + GRANT to `api`):** `calendar_connections(id SERIAL PK, user_id INT REFERENCES users(id) ON DELETE CASCADE, provider CHECK in (google,microsoft), account_email, provider_account_id, access_token_enc TEXT, refresh_token_enc TEXT, token_expires_at TIMESTAMPTZ, scopes TEXT[], status CHECK in (connected,needs_reauth,revoked), last_synced_at, created_at, updated_at, UNIQUE(user_id,provider,account_email))` + `INDEX(user_id)`. All writes use explicit `::type` casts (PgBouncer). UPSERT on the unique key with `COALESCE` to preserve an existing refresh token when the provider doesn't re-issue one.

**OAuth flow:** signed-state JWT (carries `sub`) + PKCE S256 (verifier server-side in Redis, single-use nonce). Callback is the only JWT-exempt path, validated in-router. Google `access_type=offline&prompt=consent` (guarantees refresh_token). Microsoft `{tenant}` env-driven (`common` default).

**Encryption:** Fernet (`cryptography`), key from `CALENDAR_TOKEN_ENC_KEY` (comma-separated → `MultiFernet` for rotation). If the key is unset, the calendar router **503s `calendar_disabled`** — never stores plaintext. Tokens are ciphertext at rest; a DB dump is useless without the key.

**Refresh-on-read:** if access token within 60s of expiry, refresh via refresh_token, re-encrypt + persist; on `invalid_grant` set `status=needs_reauth` and surface it through the events `providers[]` array (no 500).

**Sync (v1):** on-demand fetch + Redis cache `cal:events:{user}:{provider}:{day-bucketed range}`, TTL `CALENDAR_CACHE_TTL` (default 120s), fail-open. Rate-limit handling (Google backoff, Microsoft `Retry-After`). **Webhooks (Google watch / Graph subscriptions) deferred to Phase 2.**

**Security:** per-user isolation (`WHERE user_id=$1`), read-only scopes, encrypted tokens, disconnect/revoke, never log tokens/`code`/`code_verifier`/`state`, open-redirect guard on `return_to`, PKCE replay guard. GDPR: store **tokens only** (not event bodies); events held only in the ≤2-min cache + response; user delete cascades; note Google sensitive-scope verification + Granite DPA covering Google/Microsoft as sub-processors.

---

## 4. Frontend architecture (`docker/ui/app`)

**New files:** `src/types/calendar.ts`, `src/api/calendar.ts`, `src/pages/CalendarPage.tsx`, `src/pages/calendar/{CalendarConnectCard,EventDetailPanel,CalendarEmptyState}.tsx`, `src/pages/calendar/fullcalendar-theme.css`.
**Edits:** `Sidebar.tsx` (add `Calendar` to `allCommsNavItems` + `/calendar` to the `commPaths` auto-expand array), `App.tsx` (add `<Route path="calendar" element={<CalendarPage/>} />` **inside the existing `RequireUcaas` Outlet group**, ~line 115), `package.json` (FullCalendar deps).

**Nav:** `{ label: 'Calendar', icon: <CalendarDays size={15} strokeWidth={1.8}/>, to: '/calendar', color: '#2dd4bf', accountTypes: COMMS_ACCOUNT_TYPES }` — falls through the existing `commsNavItems.map` default (no badge branch). Inherits the `hasUcaas` + accountTypes double-gate (admins always see it; RCF never does).

**Library:** **FullCalendar** (`@fullcalendar/react` + `daygrid`/`timegrid`/`list`), `headerToolbar={false}` (we render our own chrome), `editable/selectable={false}`, themed via scoped `--fc-*` CSS variables to the §15 palette. ⚠️ **Build risk to verify first:** pin a `@fullcalendar/react` 6.1.x that officially supports **React 19** (strict `tsc -b` + `noUnusedLocals` will fail the Docker build on a peer mismatch). Documented fallback: `react-big-calendar` with the same data adapter.

**Data layer** (`src/api/calendar.ts`): `listConnections()`, `getConnectUrl(provider, returnTo)`, `disconnect(provider)`, `listEvents({start,end,provider?})`. Types in `src/types/calendar.ts` mirror §2 **verbatim** (apply the reconciliation: `ConnectionStatus = 'connected'|'needs_reauth'|'revoked'`; `html_link: string|null`; `conferencing: {type, join_url}`; attendee/organizer use `display_name`; add a `providers` field to the events response type). Query keys `['calendar','connections']`, `['calendar','events',{start,end,provider}]`; events query `enabled` on `connections.length>0`, `placeholderData: keepPreviousData`.

**Page:** `PortalHeader` (recommend adding a `'calendar'` badge variant + `#2dd4bf` accent — one-line, non-breaking) → connections bar (chips + Connect/Disconnect) → our controls row (month/week/agenda switcher, prev/today/next, provider filter, color legend) → FullCalendar (range via `datesSet` → drives events query) → read-only `EventDetailPanel` slide-over (title, time, location, organizer, attendees, **Join** when `conferencing.join_url`, **Open in Google/Outlook** via `html_link` with `rel="noopener noreferrer"`; description rendered as escaped text, never `dangerouslySetInnerHTML`). Surface `providers[].error==='needs_reauth'` inline as a "Reconnect Outlook" affordance.

**OAuth return handling:** on mount, read `calendar_connected`/`calendar_error` from `useSearchParams`, toast + invalidate `['calendar',...]`, then `navigate('/calendar',{replace:true})` to clean the URL.

**Empty state:** TrunksPage/ApiDidsPage quality bar — "Bring your calendars together", 3 `HowItWorksStep`s (Connect securely / Read-only sync / Disconnect anytime), a privacy pill, and the two Connect buttons.

**Hard reqs:** all hooks unconditionally at top (#310); strict TS (no `any`/unused); reuse `components/ui` primitives + `useToast`; mobile defaults to agenda view; `tsc -b` + `eslint` + `vite build` clean before merge.

---

## 5. Phasing

- **Phase 1 (this plan):** connect/list/disconnect Google + Microsoft; aggregated read-only events (on-demand + cache); encrypted tokens; refresh-on-read; per-user isolation; partial-failure aggregate.
- **Phase 2:** write scopes (create/edit/delete); **schedule a Meeting + invite** against the existing conferencing product (write the conference join URL into a calendar event); **presence-from-calendar** (free/busy → flip UCaaS presence to Busy); webhooks (Google watch / Graph subscriptions) → drop polling; per-calendar (not just per-provider) visibility/colors.
- **Phase 3:** CalDAV (Apple iCloud, Fastmail), other providers.

v1 type/API names are chosen so Phase 2 only **adds** functions/optional fields — never reshapes the v1 contract.

---

## 6. Deploy prerequisites (before any build ships)

- **Google Cloud:** enable Calendar API; OAuth consent screen (External; scopes `calendar.readonly`, `calendar.calendarlist.readonly`, `openid`, `email`, `profile`; test users while unverified; **sensitive-scope verification required before GA**); OAuth Web client; **Authorized redirect URI** `{CALENDAR_OAUTH_REDIRECT_BASE}/v1/calendar/callback/google`.
- **Azure AD:** App registration → Web platform → redirect URI `{CALENDAR_OAUTH_REDIRECT_BASE}/v1/calendar/callback/microsoft`; Graph delegated `Calendars.Read offline_access openid profile email`; client secret.
- **`.env` (Services VM):** `GOOGLE_CALENDAR_CLIENT_ID/SECRET`, `MICROSOFT_CLIENT_ID/SECRET`, `MICROSOFT_TENANT` (`common`), `CALENDAR_OAUTH_REDIRECT_BASE`, `CALENDAR_TOKEN_ENC_KEY` (Fernet key; feature 503s if unset), optional `CALENDAR_CACHE_TTL`, `CALENDAR_SPA_ORIGIN`.

---

## 7. Suggested build sequence (when greenlit) + verification gates

1. **Backend foundation** — migration 32 (hand-apply), `calendar_crypto.py`, `requirements.txt` (`cryptography`). Gate: `py_compile`; migration applies idempotently; `Fernet` round-trips.
2. **OAuth + connections** — `calendar_providers.py` (OAuth/state/PKCE/refresh), `routers/calendar.py` (connect/callback/connections/disconnect), middleware exemption, main.py mount. Gate: `py_compile`; live connect→callback→row stored encrypted; cross-user isolation (404).
3. **Events aggregate** — `GET /events` + per-provider partial-failure + cache. Gate: events normalize to the canonical shape; one dead provider degrades, not 500s.
4. **Frontend data + nav** — types, `api/calendar.ts`, Sidebar child + route. Gate: `tsc -b`.
5. **Calendar page** — FullCalendar (verify React-19 peer first), controls, detail slide-over, empty state, OAuth-return handling. Gate: `tsc -b` + `eslint` + `vite build` clean; hooks-order lint clean.
6. **End-to-end verify** (the "you verify at the end" step) — connect both providers, view/paginate, disconnect, reconnect-on-needs_reauth; confirm tokens encrypted at rest and never logged.

Each layer follows the established agentic workflow (expert builds → orchestrator verifies). Deploy is the usual `git pull` + hand-apply migration 32 + rebuild `api ui`.
