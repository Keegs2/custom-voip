# Calendar Integration — Status & Resume Guide

**Last updated:** 2026-06 · **State:** Phase 1 **built + verified + committed**, NOT deployed, NOT live.
**Paused on:** picking a public **HTTPS domain** for the OAuth redirect (a future decision). Resume here once the domain exists.

Design: `docs/CALENDAR_INTEGRATION_PLAN.md` (canonical contract in §2). This file tracks what's done and exactly what's left.

---

## ✅ Done (committed `0a638de` on `unified`)

Phase 1 = read-only Calendar in Unified Comms, direct OAuth to **Google Calendar API** + **Microsoft Graph** (no aggregator), per-user, tokens encrypted at rest. Built by the backend + frontend experts to the §2 contract and orchestrator-verified end to end (py_compile/import/Fernet round-trip; migration idempotent; per-user isolation; frontend tsc/eslint/vite build; **backend emitted keys ≡ frontend TS types field-for-field**; FullCalendar 6.1.21 React-19 OK).

**Backend** (`docker/api/src`): `routers/calendar.py` (connections / connect / callback / disconnect / events), `services/calendar_providers.py` (Google + MS clients, PKCE, refresh-on-read, normalize), `services/calendar_crypto.py` (Fernet/MultiFernet), migration `docker/postgres/init/32_schema_calendar.sql` (`calendar_connections`), edits to `middleware/auth.py` (exempt only `/calendar/callback/`), `main.py` (mount ×2), `db/redis_client.py` (PKCE + events cache helpers), `requirements.txt` (`cryptography`).

**Frontend** (`docker/ui/app/src`): `pages/CalendarPage.tsx` + `pages/calendar/*` (connect card, event slide-over, empty state, FullCalendar dark theme, providerMeta), `api/calendar.ts`, `types/calendar.ts`; `components/layout/Sidebar.tsx` (Calendar nav child under Unified Comms, `#2dd4bf`) + `App.tsx` (`/calendar` route inside `RequireUcaas`) + `RcfPage.tsx` (`PortalHeader` 'calendar' variant).

Today the code is live-safe: with no provider creds / no `CALENDAR_TOKEN_ENC_KEY`, the page renders the empty state and Connect returns a friendly error (feature 503s rather than storing plaintext). Nothing else in the app is affected.

---

## ⛔ Blocked on (the one decision)

**A public HTTPS domain pointed at the sandbox.** Google and Microsoft reject raw IPs and plain `http://` for OAuth redirect URIs (only `https://` + real domain, or `http://localhost`). The sandbox `http://34.24.231.249:8080` will NOT work. This domain is what `CALENDAR_OAUTH_REDIRECT_BASE` encodes.

---

## ▶️ Resume checklist (when the domain is decided)

Let `DOMAIN` = the chosen HTTPS host. The API is reached publicly via the UI nginx `/api/*` proxy (strips `/api` → api:8000), so:

- **Redirect URIs to register** (exact, no trailing slash):
  - Google:  `https://DOMAIN/api/v1/calendar/callback/google`
  - Microsoft: `https://DOMAIN/api/v1/calendar/callback/microsoft`
- Backend builds them as `{CALENDAR_OAUTH_REDIRECT_BASE}/v1/calendar/callback/{provider}`, so set **`CALENDAR_OAUTH_REDIRECT_BASE=https://DOMAIN/api`**.

### 1. Google Cloud (→ `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`)
- Project `rugged-night-193017` (or dedicated) → APIs & Services → **enable Google Calendar API**.
- OAuth consent screen: External; scopes `calendar.readonly` + `calendar.calendarlist.readonly` (+ openid/email/profile); add **test users**.
- Credentials → Create OAuth client ID → **Web application** → add the Google redirect URI above → copy client id + secret.
- ⚠️ `calendar.readonly` is **sensitive** → app stays in **Testing** until verified; **Testing-mode refresh tokens expire after 7 days** (testers reconnect weekly; the UI's `needs_reauth` → Reconnect handles it). Publish/verify for production.

### 2. Azure / Microsoft Entra ID (→ `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`; `MICROSOFT_TENANT=common`)
- Entra ID → App registrations → New registration. Account types: **"any org directory + personal Microsoft accounts"** (= `common`); or single-tenant → set `MICROSOFT_TENANT` to the tenant GUID.
- Redirect URI: platform **Web** → the Microsoft redirect URI above. Copy **Application (client) ID**.
- API permissions → Microsoft Graph → **Delegated**: `Calendars.Read`, `offline_access`, `openid`, `profile`, `email` (grant admin consent if required).
- Certificates & secrets → New client secret → **copy the `Value` immediately** (shown once).

### 3. `.env` on the Services VM (`/opt/revup/.env`, NOT in git)
```
CALENDAR_TOKEN_ENC_KEY=<Fernet key>          # python -c "from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())"
CALENDAR_OAUTH_REDIRECT_BASE=https://DOMAIN/api
GOOGLE_CALENDAR_CLIENT_ID=...
GOOGLE_CALENDAR_CLIENT_SECRET=...
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
MICROSOFT_TENANT=common
# optional: CALENDAR_CACHE_TTL=120 ; CALENDAR_SPA_ORIGIN=https://DOMAIN
```
Without `CALENDAR_TOKEN_ENC_KEY` the feature 503s by design (never stores plaintext tokens).

### 4. Deploy (includes migration 32)
```
cd /opt/revup && sudo git pull && sudo docker exec -i voip-postgres psql -U voip -d voip < docker/postgres/init/32_schema_calendar.sql && sudo docker compose up -d --build api ui
```

### 5. Live e2e (the only step that needs real provider creds)
As a ucaas/hybrid (or admin) user: open `/calendar` → Connect Google → consent → returns to `/calendar?calendar_connected=google` → events render. Repeat Outlook. Verify Disconnect, and that `calendar_connections.access_token_enc`/`refresh_token_enc` hold ciphertext (not plaintext) in Postgres.

---

## Phase 2 (future, scoped in plan §5)
Two-way write; schedule-a-Meeting + calendar invite (ties to conferencing); presence-from-calendar (free/busy → Busy); webhooks (Google watch / Graph subscriptions, drop polling); per-calendar visibility/colors. Then Phase 3: CalDAV/Apple + others.
