# UI Frontend — CLAUDE.md

Complete reference for the React SPA living under `docker/ui/app/`.
Read this before touching any frontend code.

---

## 1. Tech Stack

| Concern | Library / Tool |
|---|---|
| Framework | React 19, functional components + hooks only |
| Language | TypeScript 6, strict mode, `noEmit`, `noUnusedLocals/Parameters` |
| Bundler | Vite 8 with `@vitejs/plugin-react` |
| Routing | React Router v7 (`BrowserRouter`) |
| Server state | TanStack React Query v5 |
| Styling | Tailwind CSS v4 (via `@tailwindcss/vite` plugin) + inline styles |
| UI primitives | Hand-rolled components in `src/components/ui/` — no third-party UI library |
| Icons | `lucide-react` (product icons wrapped in `src/components/icons/ProductIcons.tsx`) |
| Flow canvas | `@xyflow/react` 12 (React Flow) + `zustand` 5 + `nanoid` 5 — the Visual IVR builder only, in its own lazy chunk (§19) |
| Class merging | `clsx` + `tailwind-merge` via `src/utils/cn.ts` |
| Build check | `tsc -b && vite build` (TypeScript errors block the Docker build) |

> Note: `class-variance-authority` is listed in `package.json` dependencies but is
> currently **unused** — the codebase hand-rolls variant logic instead.

Path alias: `@/` resolves to `src/` (configured in `vite.config.ts`).

---

## 2. Build Process

### Multi-Stage Dockerfile (`docker/ui/Dockerfile`)

Two stages — no Homer frontend is built or bundled any more.

**Stage 1 — build** (`node:20-alpine`)
```
npm ci
npm run build   # tsc -b && vite build
```
Output lands in `/app/dist`.

**Stage 2 — nginx:alpine**
- Removes the stock `default.conf`.
- Generates a self-signed TLS cert at build time (10-year, `voiceplatform.local`).
  WebRTC (`getUserMedia`) requires HTTPS — both ports 80 and 443 are served.
- Copies `nginx-maps.conf` as `00-maps.conf` (WebSocket upgrade map).
- Copies `nginx.conf` as `rcf-ui.conf`.
- Copies React `dist/` to `/usr/share/nginx/html`.

> The old 3-stage build that extracted `ghcr.io/sipcapture/homer-app`, patched its
> `index.html` to `PREFIX: "/homer/"`, and copied Homer assets into the image is
> **gone**. SIP-trace troubleshooting is now a native React page (see
> `TroubleshootingPage` + `components/sip-ladder/`) backed by the API's
> `/homer/search` endpoint. Grafana provides the optional deep-link dashboard.

### nginx routing (`docker/ui/nginx.conf`)

There is **no** `homer-webapp` upstream and **no** `/api/v3` or `/homer/` location.
The route table, in nginx match order:

| Path | Destination | Notes |
|---|---|---|
| `/grafana/*` | `grafana:3000` | Homer 10 / SIP visualization dashboard. Strips `X-Frame-Options` for embedding. Must come before `/api/`. |
| `/ws/verto/*` | `http://10.142.0.100:8082/` | FreeSWITCH `mod_verto` WebSocket (wss→ws unwrap). **⚠ HARDCODED East SBC-1 IP (`10.142.0.100`)** — this is East-specific and would break in West/Central zones during multi-datacenter expansion. Needs to become an env-driven upstream. |
| `/api/ws/*` | FastAPI WebSocket (`api:8000`) with Upgrade headers | strips `/api` prefix |
| `/api/v1/voicemail/*` | FastAPI backend, same rewrite/headers as `/api/` | **unbuffered**: `client_max_body_size 6m`, `client_body_buffer_size 6m`, `proxy_request_buffering off`, `proxy_buffering off`, `proxy_max_temp_file_size 0` — greeting uploads and decrypted playback audio never touch nginx temp files (voicemail plan D8). Access log uses `log_format vm_noquery` (`nginx-maps.conf`): request PATH only, so playback tokens (`?t=`) are never logged. Sits before `/api/`. |
| `/api/*` | FastAPI backend (`api:8000`), strips `/api` prefix | uses `$http_host` to preserve port |
| `/docs`, `/redoc`, `/openapi.json` | FastAPI docs direct | |
| `/api/sipp/*` | SIPp runner (`sipp:8001`), rewritten to `/sipp/*` | variable upstream (`resolver`) |
| `/*` | React SPA (`try_files $uri $uri/ /index.html`) | |
| `/health` (exact) | FastAPI health (`api:8000/health`), no logging | |

### Local development

```bash
cd docker/ui/app
npm run dev      # Vite on :5173 — proxies /api → localhost:8000
npm run build    # Production build (runs tsc first)
npm run lint     # ESLint
```

The Vite dev proxy (`vite.config.ts`) forwards `/api/*` to `http://localhost:8000`
so the frontend behaves identically to production without changing any URLs.

---

## 3. App Entry Points

### `src/main.tsx`

Bootstraps the app. Provider nesting order (outermost first):
```
StrictMode
  ThemeProvider           (light / dark — §18)
    QueryClientProvider   (TanStack React Query)
      ToastProvider       (global toast notifications)
        App               (BrowserRouter + AuthProvider + Routes)
```
Global CSS, in order: `index.css` (Tailwind, `@theme`, brand tokens, base
rules, the daylight console primitives + their `--dl-*` page palette — §18.5),
`styles/theme.css` (the `--t-*` theme tokens),
`styles/app-shell.css` (canvas, sidebar, collapse tab, theme toggle).
`index.html` carries a tiny inline script that sets the theme before first
paint (§18).

QueryClient defaults:
- Queries: `staleTime: 30_000`, retry up to 2x — **no retries on 4xx**
- Mutations: `retry: false`

### `src/App.tsx` — Route Map

```
/login                    → redirect to /          (old bookmarks)
/ (index)                 DashboardPage            (PUBLIC — outside RequireAuth, inside AppLayout)

── inside AppLayout + RequireAuth ──
/dashboard                AccountDashboard (pages/dashboard/) — account home: tenants, admin "View as
                          Customer" preview, and the ADMIN dashboard (?customer=ID | All customers);
                          support / no account → productHome
/rcf                      RcfPage (customer numbers manager / admin console, + pages/rcf/ Call Activity)
/api-dids                 ApiDidsPage — RETIRED: ProductHomeRedirect while API_CALLING_ENABLED=false
/trunks                   TrunksPage
/voicemail                VisualVoicemailPage (lazy) — Visual Voicemail (§17): tenant inbox, admin preview,
                          admin console (?customer=ID | All customers); support → productHome
/reporting                ReportingPage (lazy; RequireReportingAccess — rcf/trunk/hybrid + admin)
/docs/guides/:product?    GuidesPage        (/documentation, /docs/rcf redirect here)
/docs/api/:product?       ApiDocsPage       (/docs/integration redirects here)
/call-quality             CallsPage (tenant-reachable; cost/fleet UI hidden for non-staff)
/cdrs                     CallsPage (RequireSupportOrAdmin)   (/admin/platform/cdrs redirects here)
/my-account               MyAccountPage     (/account redirects here)

── full-screen, outside AppLayout, RequireAuth ──
/troubleshooting          TroubleshootingPage      (renders its own Sidebar)
/ivr, /ivr/flows/:id      IvrPage (lazy; renders its own Sidebar) — Visual IVR: numbers,
                          flows, messages; the builder is a second lazy chunk (§19)

*                         → redirect to /
```

**Key facts that bite:**
- The **homepage (`DashboardPage`) is PUBLIC**. Login is the sidebar form
  (`SidebarLoginForm`) / landing `SignInModal`; `LoginPage.tsx` is orphaned.
- **There is no admin UI in this SPA any more.** Customer + platform
  administration (customers, trunks, carriers, rates, tiers, DIDs, onboarding)
  lives in **TED** (the CRAG console). Staff-facing pages here are the admin
  dashboard (`/dashboard`), the admin `/rcf` console, Calls & Quality (`/cdrs`)
  and Troubleshooting.

`AuthProvider` is intentionally **inside** `BrowserRouter` so it can call `useNavigate`.

---

## 4. Authentication Flow

### `src/contexts/AuthContext.tsx`

Single context that owns all auth state. Exposed via `useAuth()`.

**Context shape:**
```typescript
{
  user: User | null
  token: string | null
  isAuthenticated: boolean
  isAdmin: boolean           // role === 'admin' AND not in customer view
  isActualAdmin: boolean     // role === 'admin' regardless of customer view
  isSupport: boolean
  customerViewMode: boolean  // admin "View as Customer" (memory only — resets on refresh)
  toggleCustomerView(): void // entering navigates to / → productHome → /dashboard
  previewCustomer: EffectiveCustomer | null      // the customer an admin previews (memory only,
  setPreviewCustomer(c): void                    //   cleared on logout; sidebar picker sets it)
  effectiveCustomer: EffectiveCustomer | null    // {id, name, account_type} every customer page
                             // scopes to: tenant → own account; admin in customer view →
                             // previewCustomer; admin (normal view) / support → null
  isLoading: boolean         // true while validating persisted token on mount
  login(email, password): Promise<void>
  logout(): void
  refreshUser(): Promise<void>  // re-fetches /auth/me, use after profile edits
}
```

**Bootstrap sequence:**
1. On mount, reads `auth_token` from `localStorage`.
2. If token exists, calls `GET /auth/me` to validate it.
3. Sets `isLoading = false` when done (either way).
4. On 401, clears token and stays unauthenticated.

**Login:** calls `POST /auth/login`, stores JWT in `localStorage`, sets user in state.
There is **no standalone login page** — the login form lives in the sidebar on the
public homepage (`DashboardPage`). `LoginPage.tsx` still exists but is orphaned.

**Logout:** clears localStorage, nulls state (incl. customer view + preview
customer), clears the React Query cache, navigates to `/` (the public home).
Login also clears the cache before the new identity renders — tenant query keys
(`['my-customer', …]`, `['my-team']`) are not customer-scoped, so without this a
second login on the same tab was served the previous tenant's data.

**Customer preview (admin "View as Customer").** The admin user has
`customer_id = null` / `account_type = null`, so customer pages must never read
`user.customer_id` — they read `effectiveCustomer`. The sidebar's amber
customer-view banner carries `components/preview/CustomerPreviewPicker`
(GET /customers, key `['customers-dropdown']`); entering customer view with no
pick defaults to the admin's own account, else the first rcf/hybrid customer by
name. Customer pages key their view component on `effectiveCustomer.id` so a
switch remounts (no hook-order change). The admin is still STAFF to the API, so
customer pages swap self-scoped endpoints for the admin ones (see
`pages/dashboard/accountData.ts`). With no pick yet, /dashboard and /rcf show
`PreviewPrompt` (same picker).

**`utils/productHome.ts`** — signed-in home: admin → `/dashboard` (the admin
dashboard, All customers), support →
`/troubleshooting`, `trunk` → `/trunks`, `api` → `/my-account` (API Calling
retired), a tenant login with no customer → `/my-account`, everyone else
(rcf/hybrid/ucaas/unknown, readonly included, admin in customer view) →
`/dashboard`.

**401 interceptor in `src/api/client.ts`:** any API call that gets a 401 clears
the token and calls `window.location.replace('/')` (the homepage with the sidebar
login form) as a safety net on top of the context-level handling.

### `src/components/auth/RequireAuth.tsx`

Wraps protected route subtrees. Usable as a layout route (`<Outlet />`) or as a
wrapper component (`children`). Shows a full-page spinner while `isLoading` is true
(prevents flash of redirect). When unauthenticated, redirects to `/` (the public
homepage, where the sidebar login form lives) with `state.from` set to the intended
destination so the app can navigate there post-login.

### `src/components/auth/RequireAdmin.tsx`

Wraps admin-only routes. Must be rendered inside `RequireAuth`. Redirects
non-admin users to `/` silently.

---

## 5. API Client Layer

### `src/api/client.ts` — `apiRequest<T>()`

The single fetch wrapper used by all API modules.

```typescript
apiRequest<T>(method, path, body?): Promise<T>
```

- **Base URL:** `/api` — always relative, proxied by nginx in production and Vite
  in development.
- **Auth header:** reads `localStorage.getItem('auth_token')` and sets
  `Authorization: Bearer <token>` automatically.
- **Content-Type:** set to `application/json` when `body` is provided.
- **204 No Content:** returns `undefined as T`.
- **Error handling:** throws `ApiError` (subclass of `Error`) with:
  - `status: number` — HTTP status code
  - `message: string` — extracted from FastAPI `{ detail: string }` or
    `{ detail: [{ msg, loc }] }` shapes
  - `raw?: unknown` — raw parsed body for debugging

**`ApiError` is the only error type thrown by the API layer.**
Callers can check `err instanceof ApiError` then `err.status`.

### File Upload (`src/api/documents.ts`)

`uploadDocument()` uses `XMLHttpRequest` directly (not `apiRequest`) to support
`onProgress` callbacks (0–100). Reads the token from `localStorage` manually and
sets the `Authorization` header.

### Normalisation pattern

Several list endpoints may return either a plain array or `{ items, total }`.
The API modules all normalise to `{ items: T[], total: number }` so consumers
never need to branch on the response shape:

```typescript
const raw = await apiRequest<T[] | ListResponse<T>>('GET', '/foo');
if (Array.isArray(raw)) return { items: raw, total: raw.length };
return { items: raw.items ?? [], total: raw.total ?? raw.items?.length ?? 0 };
```

### API modules

| Module | Path prefix | Key operations |
|---|---|---|
| `auth.ts` | `/auth` | `login`, `getMe`, `listUsers`, `createUser`, `updateUser`, `deleteUser` |
| `customers.ts` | `/customers` | CRUD + search/filter/pagination |
| `rcf.ts` | `/rcf` | CRUD + search/filter |
| `trunks.ts` | `/trunks` | CRUD + IPs, DIDs, stats, call-path packages |
| `apiDids.ts` | `/api-dids` | CRUD + filter |
| `carriers.ts` | `/carriers` | CRUD + `testCarrier` |
| `cdrs.ts` | `/cdrs` | `searchCdrs`, `getCdr`, `rateCdr`, `getCdrSummary`, `getCdrActivity`, customer-scoped helpers. `product_type` may be `'all'` (= no product filter; `/cdrs/activity` defaults to rcf when omitted); `number` = one of the customer's own numbers (inbound destination OR outbound caller ID), sent only when set |
| `reports.ts` | `/reports` | Reporting endpoints; `getMyNumbers(customerId?)` = the customer's numbers, EVERY product — also the dashboard's numbers list (§7) |
| `rates.ts` | `/rates` | CRUD + `getMarginsData`, `lookupRate` |
| `ivr.ts` | `/v1/ivr` | Visual IVR, typed 1:1 to `docs/IVR_INTERFACES.md` §8.2: summary, flows (CRUD, validate, publish `{revision}`, versions, restore, simulate), numbers, destinations, prompts (TTS, multipart upload, rename, delete, tts-preview, playback URL), voices. Plus the Flow assistant (`docs/IVR_ASSIST_INTERFACES.md` §5): `startAssist` (202 `{job_id, conversation_id}`), `getAssistJob`, `postAssistOutcome`, `simulate` with `assist_job_id`. Staff pass `customer_id` on EVERY route (§19) |
| `documents.ts` | `/documents` | folders CRUD, document upload/download/update/delete, stats |
| `sipp.ts` | `/sipp` | `listSippPresets`, `runSipp` |
| `health.ts` | `/health` | `getHealth`, `getDetailedHealth` |
| `homer.ts` | `/homer` | `searchSipTraces` — `POST /homer/search`, returns `{ data: HomerSearchResult[], correlations: Record<string, string[]> }`. Powers the Troubleshooting SIP-trace page. |
| `didInventory.ts` | `/dids` (inventory) | `listDidInventory`, `listAvailableDids`, `getDidStats`, `listMyDids`, `syncDidInventory`, `assignDid`, `unassignDid`, `requestDid` |
| `onboarding.ts` | `/onboarding` | `submitOnboardingRequest`, `listOnboardingRequests`, `getOnboardingRequest`, `verifyBilling`, `approveOnboarding`, `rejectOnboarding` |
| `sbc.ts` | (SBC stats) | `getSbcStats(minutes)` — per-SBC call distribution for the admin `SbcDistribution` panel |
| `voicemail.ts` | `/v1/voicemail` | Visual Voicemail, typed 1:1 to `docs/ENCRYPTED_VOICEMAIL_INTERFACES.md` §4.1–4.4 (summary, mailboxes, available-numbers, messages, playback tokens, greetings incl. raw-WAV upload, crypto-erase) + transcription v1.1 (`getTranscript`, `retryTranscript`, `getTranscriptSnippets` ≤ 50 ids, `backfillTranscripts`). See §17. |

`apiRequestRaw<T>(method, path, body, contentType)` (client.ts) is the raw-body
sibling of `apiRequest` (same auth / 401 / ApiError handling) — used for the
voicemail greeting upload (`audio/wav` bytes, never multipart).
`apiRequestForm<T>(method, path, FormData)` (multipart — the IVR prompt
upload) and `apiPostForBlob(path, body)` (JSON in, binary out — the IVR
text-to-speech preview) are siblings with the same handling.

---

## 6. State Management

### Server state — TanStack React Query

All remote data lives in React Query. Pages use `useQuery` for reads and
`useMutation` for writes. After a successful mutation, call
`queryClient.invalidateQueries({ queryKey: ['...'] })` to refresh.

Standard query key conventions:
```
['customers', { search, offset }]
['customers-dropdown']          // lightweight list for selectors
['rcf', { customerId, search }]
['trunks', { customerId }]
['api-dids', { customerId }]
['cdrs', { ...params }]
['rates', { ...params }]
['carriers']
['tiers']
['ivr', <scope key>, …]         // Visual IVR — §19
```

### Client state — React `useState` / `useReducer`

- **Form state:** local `useState` inside each page.
- **IVR builder:** one zustand store per mounted builder
  (`src/flow/store/flowStore.ts`, created in `FlowBuilder`) — §19.
- **Sidebar group open/close:** `useState` + persisted to `localStorage` under
  key `sidebar_groups_open`.

### Global UI state — Contexts

| Context | File | Purpose |
|---|---|---|
| `AuthContext` | `src/contexts/AuthContext.tsx` | Auth state, login, logout |
| `ThemeContext` | `src/contexts/ThemeContext.tsx` | Light/dark: `useTheme()` → `{ theme, source, setTheme, toggleTheme, followSystem }`; `useResolvedToken()` (§18) |
| `ToastContext` | `src/components/ui/ToastContext.tsx` | Global toast notifications |

---

## 7. Pages

### Customer-facing pages (inside AppLayout)

**`DashboardPage`** (`/`)
The PUBLIC landing page (signed-in users are redirected to `productHome`). No
API calls except the intake form's `POST /onboarding`. All landing styles
live in `src/styles/landing.css` (imported by DashboardPage; the old
"LANDING PAGE" block of index.css is gone). One continuous granite canvas;
every section sits on `.landing-grid12` and opens on a hairline + split head.
Every list (KPIs, pillars, products, capabilities) is data at the top of
DashboardPage.tsx and the layouts take any count.
- **Copy is fact-checked against the code (2026-10)** — keep it that way.
  Never claim AI voice agents, API Calling (retired; nothing on the page reads
  `API_CALLING_ENABLED` any more), DNS steering (not built), STIR/SHAKEN on
  "every call" (signing fails open) or a "nationwide network" of Granite's
  own. Owner rules: never name the cloud provider, any carrier or any PoP
  city; 99.999% is shown as the availability DESIGN target (the paging SLO is
  99.95%); design figures (~10 s SBC failover, up to 8 routes) carry a note.
  Products: RCF generally available; SIP Trunking + Visual Voicemail early
  access. TED is described neutrally (no "AI", no "verifies"); no follow-up SLA.
- Hero: the H1 is the CRAG acrostic, one word per line (`ACROSTIC`), initials
  coloured with `::first-letter` so the DOM text stays plain. Each initial has a
  per-letter `margin-left` in landing.css that cancels its side bearing
  (measured for Archivo 900 @ `font-stretch: 104%`) — re-measure if the H1
  font, weight or width changes. Art: `public/crag-cube.{webp,png}` (nav +
  viz: `crag-mark.{webp,png}`), transparent cut-outs of `crag.png`, which
  stays for the favicon. The Sidebar uses the nav lockup (`crag-mark` +
  "GRANITE CRAG" wordmark) since the theming work (§18).
- **Theme-exempt.** The landing (and its `SignInModal`) is dark whatever the
  user's theme: `<html data-landing>` forces the dark token set while `/` is
  on screen (§18). landing.css keeps its own `--lg-*` palette. The tag and proof strip respond to
  the copy column's width (container `lg-hero-copy`). `index.html` loads
  Archivo as a variable font (`wdth 62..125`) for the wide wordmarks.
- `components/layout/HaArchitectureViz.tsx` (landing only) models the real
  inbound path: PSTN → three regions, each a health-checked load balancer →
  active/standby SBC pair → FS-1 active / FS-2 hot standby → termination
  routes A/B, with four scripted failover scenarios (standby SBC lost, region
  drained by its health check, route lost, active SBC flip ~10 s) driving
  the status chip and the numbered timeline. Generic labels only (see the
  owner rules above). Below 760px the SVG scrolls sideways inside its frame.
- `RequestAccessSection` groups the intake into six numbered groups
  (`GroupHead`); fields, validation and payload are unchanged by that.

**`AccountDashboard`** (`/dashboard`, `pages/dashboard/`)
The account home — everything at a glance, as cards. `AccountDashboard.tsx` is
only the route entry: tenant → `AccountDashboardView viewer="tenant"`; admin in
customer view → `viewer="preview"` on the preview customer (or `PreviewPrompt`
until one is picked); admin (normal view) → `AdminDashboard`; support / no
account → `productHome`. Every view is KEYED (customer id / `all`), so a scope
switch remounts instead of changing hook order.
- `DashboardHeader` — compact granite band: kicker + amber tag ("Staff
  preview" / "Staff" / "Support"), name, status word + dot, "Customer since",
  optional meta; tools row: optional scope dropdown (`AdminScopeSelect`),
  optional product switcher (`products.ts`: RCF live; SIP Trunking dimmed
  "Soon", aria-disabled; Visual Voicemail dimmed "Soon" UNLESS the account has
  it on — then `ProductSwitch.links` makes it a plain link to `/voicemail`
  (admin one-customer view: `/voicemail?customer=ID`), driven by the same
  `/v1/voicemail/summary` query + cache key as the sidebar; no dashboard
  panel), a quiet glass secondary action and the azure-glow primary action.
  Also used by the admin `/rcf` console. **Dark in both themes:** the band's
  frame reads `--t-band-*`, and its two content columns (`.ad-header-id`,
  `.ad-header-tools`) carry `data-force-theme="dark"`, so every token inside
  — and the native `<select>` popup — is the dark set on the light theme
  too; band-only constants are `--adh-*` (§18.5).
- **Holistic (every product).** The account view's numbers card, Numbers
  KPI, every call card and the Call activity overlay cover every product on
  the account (call forwarding, voicemail, SIP trunk, any future product via
  `config/products.ts`). Numbers = `GET /reports/my-numbers` (the Reporting
  picker's list) merged with the editable `/rcf` entries
  (`accountData.toNumberRows`); calls = `/cdrs/activity?product_type=all` and
  `/cdrs` with no product filter. A call-forwarding-only account renders
  exactly as before (header "Forwards to", chips All/Forwarding/Paused,
  same KPI values). If my-numbers fails or an older API answers without
  `enabled` (`isHolisticNumbers`), the card + KPIs fall back to the `/rcf`
  entries. **Deploy the API first:** an older `/cdrs/activity` reads
  `product_type=all` literally (0 calls).
- **Layout (§20):** KPIs in ONE row of six (≥ 980px of content); every
  grid row one height — Numbers (8 rows, "Show all N" scrolls inside a
  capped table with sticky heads) beside an `.ad-col` of Call volume
  (absorbs slack) + Call quality; Recent calls beside Team (`follow`);
  Busiest · Requests · Quick actions. Admin one-customer view (seven
  quick actions): Recent calls beside Requests + Team (`follow`), then
  Busiest beside two-column Quick actions (the requests card has no footer
  button there — the header's "Manage numbers" opens the same overlay).
  Admin All customers: Customers (first
  5, "Show all") + Number requests (`follow`, two columns) beside Volume +
  Quality; Recent calls beside Paused (`follow`); Inventory (tight rows)
  beside two-column Quick actions. Below 1100px the columns dissolve
  (`display: contents`, dense flow) and followers go natural.
- `KpiCards` (`KpiRow`) — six cards. Account scope: Numbers (every product;
  with 2+ products the context line is the mix, "3 forwarding · 2 SIP trunk ·
  2 voicemail") · Forwarding (call forwarding only — "No call forwarding
  numbers" when there are none) · Calls 7d · Answered · Sounded good
  (quality.ts tone + word) · Team. Platform scope (`scope="platform"`): Customers leads, Team dropped.
  3px tone edge, icon chip, 7-day sparklines; `numbersHref` (tenant `/rcf`,
  admin `/rcf?customer=…`), call cards open Call activity; Team links My
  account (tenant/preview) or nothing (admin).
- `NumbersCard` — small table (8 rows) of `NumberRow`s, search + chips (All ·
  Forwarding · Paused when there are rcf numbers · one chip per other
  product). rcf row → shared `RowEditor` inline (`isAdmin` = admin fields
  such as max channels, admin dashboard only; past the 100-row `/rcf` cap a
  read-only row with "Manage in call forwarding"); voicemail row → a link
  (`ad-row-link`, → chevron) to `/voicemail` (admin one-customer view:
  `/voicemail?customer=ID`); SIP trunk / other products → plain
  non-interactive rows (`ad-row-static`) with catalog words. Column 2 reads
  "Forwards to" when every row is rcf, else "Where calls go". Footer "View all
  N numbers" (rcf only) / "Manage call forwarding" (mixed) → `allHref`.
- `CallCards` — Call volume (daily answered/missed bars), Call quality
  (good-share ring + one-way/poor/graded), Recent calls (last 6, outcome +
  quality words from `pages/rcf/callOutcome.ts`; optional Customer column via
  `customerNames`, names are buttons to that customer's dashboard), Busiest
  numbers (non-forwarding numbers name their product, "Front desk ·
  Voicemail"). A call voicemail answered reads **Voicemail** (INFO tone,
  `callOutcome.callStatusInfo`) here and in the Call activity table; it
  counts as answered. `CustomerName` is shared with the admin cards.
- `AccountCards` — Team (header link optional), Number requests (optional
  footer action; optional customer names), `QuickActionsCard` (renders a list
  built by `quickActions.tsx`: `customerQuickActions` — Request/Manage numbers →
  `DidManagement` overlay, Open call activity → `CallActivityTab` overlay
  (`scope="account"`), Open voicemail (while voicemail is on), Download a
  report, Manage all numbers ("Manage call forwarding" once other products
  share the account); `adminCustomerActions` (+ "Voicemail console" →
  `voicemailConsoleHref(id)` while voicemail is on) / `adminPlatformActions`
  — see below).
- **Admin dashboard** (`AdminDashboard.tsx`, admin in normal view). Same look,
  "Viewing" dropdown in the header (All customers default | each call
  forwarding customer; a deep-linked customer of another type is added).
  Scope in the URL: `?customer=<id>`, absent = All customers (push history, so
  Back works; an unknown id → "We couldn't find customer #id"). Helpers in
  `adminLinks.ts` (`parseCustomerParam`, `dashboardHref`, `rcfConsoleHref`,
  `callsHref`, `reportingHref`, `READS_CUSTOMER_PARAM`).
  - **All customers** (`AdminOverview`): KPIs platform-wide (Customers ·
    Numbers (every product, exact, with the mix) · Forwarding/paused · Calls
    7d · Answered · Sounded good — calls every product); cards
    `CustomersCard` (name/since · type · status · numbers (every product,
    hover = mix) · paused; row → that customer; search + show-all above 8),
    Call volume, Call quality, Recent calls (+ Customer column), Number
    requests across customers (waiting approval / release pending — the
    admin's to-dos), `PausedCard`, `InventoryCard` (pool: available ·
    assigned · one line per visible product · waiting · releasing), admin
    quick actions (Numbers console `/rcf?customer=all`, Call activity overlay
    for all customers (`scope="account"`, static "All Numbers"), Calls &
    Quality, Reporting, Troubleshooting). `AdminCards.tsx`.
  - **One customer**: `AccountDashboardView viewer="admin"` — the customer
    cards with admin actions: header "View as customer" (sets
    `previewCustomer` + turns on customer view → lands on that customer's
    dashboard as the customer sees it) and "Manage numbers" (DID management
    overlay); RowEditor admin fields; numbers links → `/rcf?customer=ID`;
    read-only team; quick actions View as this customer · Numbers console ·
    Call activity · Calls & Quality (`/cdrs?customer=ID`) · Reporting
    (`/reporting?customer=ID`) · Troubleshooting. No "Request numbers".
  - `/cdrs` and `/reporting` do NOT read `?customer=` yet — their action
    sub-lines say "pick X in Customer" until `READS_CUSTOMER_PARAM` flips.
- Data (`accountData.ts`) — tenant vs staff:
  account `GET /customers/me` vs `GET /customers/{id}` (identity fields only —
  the admin row carries financials, never copied); team `GET /auth/team` vs
  `GET /search/user/by-customer/{id}` (is_self false); number requests
  `GET /numbers/my` vs `GET /numbers/inventory?customer_id=`; both pass
  `customer_id` to `GET /rcf`, `/cdrs/activity` (7d), `/reports/numbers` (7d),
  `/cdrs` (recent); every-product numbers `GET /reports/my-numbers` (staff +
  `customer_id`, key `['account-numbers', id, 'staff'|'self']`). Number
  counts are exact from that list; only the fallback (no list) reads the
  /rcf list (100-row cap → "100+"). `useWeekActivity(null)` /
  `useRecentCalls(null)` = every customer. Keys of the all-products feeds:
  `['dash-activity','all-products',…]`, `['dash-recent-calls','all-products',…]`.
  `invalidateAccountNumbers(qc)` refreshes `['account-numbers']` +
  `['reports','my-numbers']` — called by voicemail mailbox create / delete /
  suspend / resume / relabel (NOT inside `invalidateVoicemail()`).
- Admin data (`adminData.ts`, admin-only endpoints): customers
  `GET /customers?limit=500` (shared `['customers-dropdown']`, `select` maps to
  identity fields — no money); platform numbers + per-customer counts
  `GET /numbers/owned` (every product, exact; key
  `['admin-dash','owned-numbers']`) — fallback when it fails (older API):
  `GET /numbers/inventory?product_type=rcf&limit=1000` (statuses on an
  account; "1,000+" past one page); paused list `GET /rcf?enabled=false`
  (server cap 100 → "+"; the per-customer Paused column is exact from
  /numbers/owned); open requests `GET /numbers/inventory?status=reserved`
  + `?status=release_requested`; pool `GET /numbers/stats`. NOT available
  without a backend change: per-customer call counts and a cross-customer
  "busiest numbers" (no cross-customer per-number/per-customer roll-up).
- Styles `styles/account-dashboard.css` (`ad-`): 12-col card grid (8/4 spans) →
  2 cols → 1 col by CONTENT width (container queries); balanced rows via the
  kit classes (`.ad-col`, `.lk-follow`, `.ad-tablewrap-cap`); one load-in
  stagger; reduced motion respected. Colour: theme tokens + the `--ad-*` page tokens
  (§18.5). No money anywhere.

**`RcfPage`** (`/rcf`)
Picks one of three views (separate components, so toggling customer view or
the preview can't break hook order):
- **Customer** (`effectiveCustomer` set and not admin — tenant or admin
  preview): `pages/rcf/CustomerNumbersPage.tsx`, keyed by customer id — quiet
  header "Call forwarding numbers" (breadcrumb back to Dashboard) + Request /
  Manage numbers (opens `DidManagement` in `DashboardOverlay`) + the full
  `RoutingBoard` (search, chips, sort, paging, rows open `RowEditor`). Same
  `accountData.ts` hooks as the dashboard. Styles `styles/rcf-dashboard.css`
  (`rcfd-`/`rcfn-`).
- **Admin in customer view, no preview picked**: `PreviewPrompt`.
- **Admin / support**: the Administrative Call Forwarding Console (`RcfConsole`),
  in the dashboard's look: `.rcf-scope.ad-scope.rcfc` + `.ad-shell`, granite
  `DashboardHeader` (Staff/Support tag, "Viewing X", Forwards / Forwarding /
  Paused figures, the `AdminScopeSelect` dropdown incl. All customers, "Open
  dashboard" → `/dashboard?customer=…`), a segmented tab rail (Numbers / Call
  activity / DID management; WAI-ARIA tabs, arrow keys), Numbers as a dashboard
  `Card` with the `.ad-table` look (search incl. customer, area-code filter,
  sortable header BUTTONS, Forwarding/Paused words + dot, Customer column on
  All customers, rows → `RowEditor` with admin fields, browser paging).
  Scope is in the URL: `?customer=all|<id>`; absent = nothing chosen (prompt,
  nothing loads). Numbers / Activity / DID state is keyed per scope. DID
  management on All customers asks for one customer. `.rcfc .rcf-panel`
  re-skins the Call activity / DID panels as cards (console only — the shared
  `.rcf-panel/.dl-panel` rule is untouched). Styles: `rcfc-` in
  `styles/rcf-dashboard.css`.
`GET /rcf` is capped at 100 rows server-side and ignores limit/offset; both
the board and the console fetch once and page in the browser, and say so at
100.

**`ReportingPage`** (`/reporting`, lazy)
Staff pick a customer; an admin in customer view reports on the sidebar's
preview customer (no page picker; the page is keyed on it). "Your numbers"
and the number picker list EVERY product's numbers (`/reports/my-numbers`,
`/reports/numbers`): the picker tags each option with its product when the
list spans more than one; the table / PDF sub-line adds the product for
non-forwarding numbers ("Front desk · Voicemail"); the call list shows the
server's `outcome_label` ("Answered by voicemail"); the glossary explains it.
- **Layout (§20, 2026-10):** `CompactHeader` in one row — crumb (the
  preview customer's name + amber "Staff preview" / "Staff" tag), title,
  subtitle; staff **Customer** picker as `tools` (not while previewing);
  the downloads **Spreadsheet (CSV)** + **PDF summary** as `actions`
  (accessible names "Download …"; shown once a customer is in scope). Then
  ONE slim scope bar (`ReportControls`): Period presets · Numbers picker
  (label inline) · "Oct 1 – Oct 22, 2026 · New York time" (full zone in
  the tooltip); Custom dates open From/To inline in the same bar (it wraps
  to a second line). Body rows: **Summary | Calls over time** (one
  `BalancedGrid` row, 1 : 1.6 — the summary leads; the chart's `fill` mode
  takes the row's height, min 190px, its frame absolutely placed so the
  SVG never feeds back into the row height); **Busiest · Missed · Quality**
  (three equal columns, one height; Busiest shares its height between day
  and hour); **Your numbers** (8 rows, "Show all N numbers" opens the rest
  inside a scroll capped at ~8 rows with sticky heads — `useShowMore`,
  `.rpt-tablewrap-cap`); **Every call** (filters, the page's rows in a
  capped scroll ~440px with sticky heads, ONE pager under it; paging, page
  size, filters and the CSV filters unchanged; a page change scrolls the
  box to its first row); **Words on this page** (`Disclosure` card,
  collapsed, `reporting:glossary`). Every card's "What does this mean?" is
  a kit `Disclosure variant="bare"` (`Explainer` in `ReportBits.tsx`).
  Both grids stack below 960px of content; the bar's range line drops
  under the pickers below 900px; everything is full width below 560px
  (container queries on `.rpt-body`). 1440 × 900: header, bar, summary,
  chart and the three insight cards' figures are on the first screen
  (≈2,500px page, was ≈5,500px). The PDF (`ReportPdfDocument`) is
  untouched — it renders from data, not the page.

**`CallActivityTab`** (`pages/rcf/`) — `scope` prop: `'rcf'` (default, the
/rcf console — GET /rcf picker, `product_type=rcf` + `destination`,
unchanged) or `'account'` (the dashboard overlay — `numbers` prop picker, any
product, `ad-prodtag` on non-forwarding options; `product_type=all` + `number`
on the activity feed, no product + `number` on the table; GET /rcf disabled
via `enabled:`). Keys carry the scope.

**`MyAccountPage`** — with `counts.numbers` (holistic API): one tile + header
metric per product (`by_product`, catalog order) plus the SIP trunks tile, and
a Voicemail section on Products when the account has mailbox numbers (same
`['account-numbers', id, 'self']` list). Without it: the old tiles. At
phone widths its tab rail and header metrics opt into `.dl-tabs-scroll` /
`.dl-metrics-wrap` (§18.6) — before that the page scrolled sideways at 390px.

**`TrunksPage`** (`/trunks`)
The customer **SIP Trunking portal** — read + self-serve; trunk creation and
administration stay admin-only in TED (no admin pages in this SPA).
- **Gate:** `user.account_type` ∈ `trunk`/`hybrid`, or any platform admin
  (`isActualAdmin`); everyone else gets "SIP Trunking isn't part of your
  plan". It reads `user`, not `effectiveCustomer`, so an admin in "View as
  Customer" still sees the admin list, not the preview customer's.
- **Data:** `listTrunks({ limit: 200 })` (owner-scoped by the API; admins get
  every trunk), key `['trunks', { scope: 'portal' }]`; per trunk
  `getTrunkStats` (`['trunk-stats', id]`, polls every 15 s), `getTrunkIps`,
  `getTrunkDids`. No new endpoints.
- **Per trunk (`TrunkPanel`):** live activity tiles (channels in use vs max,
  answer rate 1 h, calls today, minutes today), plan summary (CPS tier,
  call paths), connection / setup details for the PBX, authorized source IPs
  (add with IPv4 validation, remove — `readonly` and `support` view only),
  and its DIDs. States: loading, error + retry, "not provisioned yet".
- **Styles:** the daylight `dl-*` primitives + `.dlx-trunks` page tokens in
  `styles/dl-portal-pages.css`. Reached from the sidebar's Coming Soon group
  (SIP Trunking is early access); `productHome` sends `trunk` accounts here.

**`ApiDidsPage`** (`/api-dids`)
API Calling showcase. **Retired 2026-09** — the page is kept in code but the route
redirects to the user's product home while `API_CALLING_ENABLED` is false.

**`IvrPage`** (`/ivr`, `/ivr/flows/:id`, lazy) — Visual IVR: see §19.

**`GuidesPage`** (`/docs/guides/:product?`, content in `pages/docs/guides/`) — Guides
The CUSTOMER help hub (2026-10 rewrite). Staff/admin guides live elsewhere;
nothing here may describe staff tools. No API calls; reads the same for
every persona.
- **Routes:** no slug = the overview; `rcf` · `voicemail` · `ivr` = a
  product guide; any other slug (incl. the old `trunking` / `calling`)
  redirects to `/docs/guides`. `/docs/rcf` → `/docs/guides/rcf`.
  `#<task id>` deep-links (opens + scrolls to) one task. Slugs + content
  types: `guides/guideTopics.ts` (the page no longer reads
  `GUIDE_PRODUCTS` from `docProducts.ts`; that type only feeds the shared
  `ProductSelector`).
- **Layout (§20):** `CompactHeader` · `GuideSwitcher` (one row of four
  link cards — Overview, RCF, Visual Voicemail, IVR — `aria-current`,
  2 × 2 below ~860px of content) · then the guide. A product guide is ONE
  `BalancedGrid` row (`GuideKit.ProductGuide`): "How to" (tasks as
  `Disclosure` rows + Expand all) leads; "At a glance" + "Questions &
  fixes" stack beside it, the FAQ a `.lk-follow` that scrolls inside. The
  overview is two rows: three product cards, then "Find your way around
  the sidebar" + "Access & help". All three guides fit 1440 × 900 closed.
- **Content = files of data** (`RcfGuide.tsx`, `VoicemailGuide.tsx`,
  `IvrGuide.tsx`, `OverviewGuide.tsx`): each exports one component over a
  `ProductGuideContent` constant. Helpers in `GuideKit.tsx`: `<Ui>` (an
  on-screen label, spelled EXACTLY as the app spells it), `<Path>`
  (`Products › RCF`), `<Steps>`, `<Bullets>`, `<Para>`, `<Note>`,
  `<Terms>`. Styles `styles/dl-guides.css` (`gd-`, tokens only).
- **Copy rules (owner):** describe only what a tenant `user` / `readonly`
  can see and do today, verified against the code (each guide's header
  comment lists its sources). Never: carrier / cloud / vendor names,
  regions, IPs, internal components, prices, CPS or other limits not shown
  to customers, staff pages (troubleshooting, admin console, View as
  Customer, mailbox suspend / delete / crypto-erase), key or algorithm
  names (voicemail = "encrypted at rest"; the in-app Transcription card
  carries the processing disclosure — the guide points to it), env flags,
  migrations, error codes. API Calling is not documented (switched off; if
  ever mentioned: "on our roadmap"). Reliability: "redundant regions with
  automatic failover" only.
- **Deliberately not documented** (re-check before adding): the RCF
  editor's "Failover destination" (stored, but call routing does not use
  it), the IVR Flow assistant (off unless enabled per account), SIP
  Trunking (early access, not in the owner's scope for this hub).
- **Gotchas:** this page is imported statically by `App.tsx`, so its CSS
  loads BEFORE `layout-kit.css` — overrides of kit rules carry the
  `.gd-scope` prefix. The kit's `.lk-col > .lk-follow { flex: 1 1 0 }`
  collapses a follower when the grid STACKS (content-height column) —
  `dl-guides.css` resets it to `flex: none` below the grid's md width.
- Harness slugs: `docs-guides`, `docs-guides-{rcf,voicemail,ivr}`,
  `state-guides-{task,expand-all,deeplink,ivr-open}`.

**`RcfDocsPage`** (`/docs/rcf`) and **`ApiDocsPage`** (`/docs/api`)
Static inline documentation pages. No API calls. `/documentation` redirects to
`/docs/rcf`; `/docs/integration` redirects to `/docs/api`. Shared layout helpers
live in `pages/docs/shared.tsx`. There is no single `DocsPage`.

**`ApiDocsPage`** (`/docs/api/:product?`) — the customer API Reference
(`pages/docs/ApiDocsPage.tsx` = route entry; body + content in `pages/docs/api/`).
Rewritten 2026-10-26: the owner's rule is "customers only, accurate to our
current status, nothing we don't want customers to know".
- **Sections** (`docProducts.ts` `API_SECTIONS`, `apiSectionHref`): Getting
  started at the bare `/docs/api` (base URL, sign-in, roles, errors,
  conventions + the account endpoints), then `numbers` (numbers & call
  forwarding), `calls` (CDRs + Reporting), `voicemail` (Visual Voicemail),
  `trunking` (SIP Trunking, "Early access"). Old slugs still land
  (`apiSectionForLegacySlug`: `rcf` → numbers, `telemetry` → calls); any other
  slug, `calling` included, → `/docs/api`. `#<entry-id>` deep-links an entry
  (opened + scrolled into view on arrival; a Contents click writes it).
  `ApiProduct` / `API_PRODUCTS` / `isApiProduct` are deprecated leftovers kept
  only because `ProductSelector`'s card map is typed over them.
- **Truth contract** (header of `api/types.ts`): document ONLY routes a tenant
  `user` / `readonly` can call today, with the fields a tenant actually gets
  (CDRs: the `services/tenant_redaction.py` allowlist — whole minutes,
  answer/end to the minute, no money, rating, fraud or routing fields; examples
  show documented fields only and the page says unlisted fields may appear).
  Never: admin/staff-only routes or fields, ingest / FreeSWITCH / carrier /
  Homer / SBC / rates / tiers / onboarding / inventory-admin routes, vendor,
  cloud, region, host, IP or component names, env flags, migration numbers,
  signing details, or rate limits that aren't enforced for tenants. API
  Calling (`/v1/calls`) is switched off: mentioned once, as "on our roadmap".
  No IVR section (the `/v1/ivr` routes serve the builder; the product is
  still rolling out). Base URL is the placeholder `https://<your portal
  host>/api/v1`; paths are relative to it; curl examples use `$BASE` and
  `$TOKEN` (defined in Getting started). Writes a `readonly` user may not
  make carry `roles: WRITE_ROLES` → an "Edit access" tag. When an API
  changes, re-verify the affected `api/sections/*.ts` entry against its router.
- **Content is data**: `api/sections/{start,numbers,calls,voicemail,trunking}.ts`
  export a `SectionDoc` (groups → `TopicDoc` prose blocks | `EndpointDoc`:
  method, path, title, summary, roles, params, returns + fields, statuses,
  example), registered in `api/sections/index.ts` (exhaustive over
  `ApiSection`). Text is plain; a `` `code` `` span renders as inline code
  (`RichText`). Shared status lines / `BASE_URL` / the auth header: `api/common.ts`.
- **Layout (§20)** — `api/ApiReference.tsx`: `CompactHeader` (crumb Docs / API
  Reference, stats Endpoints · Token life · Format) · section rail (links in
  `dl-tabs dl-tabs-scroll`; the current tab scrolls into view on phones) ·
  `MasterDetail` Contents | reference, bounded to the first screen (the shell
  ends with it: `.dl-shell.dxa-shell { padding-bottom: 24px }`). Contents =
  groups → entries (method chip + task name), a click opens the entry, scrolls
  it to the top of its pane and focuses its toggle. Endpoints are `Disclosure`
  rows (`api/EndpointCard.tsx`), collapsed by default; open = description,
  "Who can call it", parameters, response fields (first 8 + "Show all N" when
  a table has more than 10 rows), status codes, then a collapsed, lazily
  mounted "Example request and response". "Expand all / Collapse all" in the
  pane head. Getting started topics (`api/TopicSection.tsx`) are always open.
  Below 720px of content the panes stack (Contents capped at
  `min(36vh, 300px)`). Styles `api/apiReference.css` (`dxa-`) over the docs
  `dlx-` primitives — theme tokens only.
- Static: no API calls, so tenant, readonly, admin and admin "View as
  Customer" see the same page; the view is keyed by section (fresh state on a
  switch). Harness: `docs-api*` routes and `state-docs-api-{endpoint,fields,expanded}`.

**`CallsPage`** (`/call-quality` and `/cdrs`, `pages/calls/`) — Calls & Quality
The merged CDR search + voice-quality page. Top composition (2026-10 rework):
- **Search row** (`CallsFilterBar`) — ONE centred row at ≥1366px: Customer
  (staff) · Trunk · Product (+ Voicemail: always for staff, for others while
  Visual Voicemail is on — sidebar's summary key) · Direction · Dest. prefix · Time range (select;
  From/To appear inline only for "Custom range") · **More** popover (staff:
  Zone, Rows = Calls/All legs/Carrier legs, Rated only — the button turns blue
  with a count when any is non-default) · Search · Export (staff). Call-ID chip
  and range errors sit on a slim line below only when present.
- **KPI row** (`CallsKpiStrip`) — ONE row of equal tiles (staff 8, tenant 7):
  Calls on page · ASR · Avg duration · Graded calls · Good or better · Poor
  calls (incl. one-way) · Median call MOS · Cost (staff only). Shares and
  medians only. Wraps 4-up below ~1040px.
- **No charts.** The Quality Trends section (`QualityTrendsSection`,
  `components/charts/QualityTrendChart`) was removed 2026-10 at the owner's
  request — do not re-add graphs to this page.
- **Header** — `CompactHeader`, one row (crumb Support/Voice, title,
  role-aware subtitle).
- **Records row** — ONE slim row: the Records/Summary switch (staff;
  Summary = tabular, staff-only) with the top pager beside it
  (`.cq-recordsbar`); tenants get the pager alone. The pager repeats under
  the table. The results block is the pagination scroll target.
- **`CallsTable` fits the content column at 1440 × 900** (staff and
  tenant; 11px cell sides, `.cq-table`). Columns: Time ("10-22 15:16:00";
  the year only when not the current one — full stamp in the tooltip) ·
  Leg (staff, All/Carrier legs only) · Customer (staff, clipped + title) ·
  **Call** (phone-in / phone-out icon — inbound azure, outbound slate, the
  word for screen readers and in the tooltip — + the product tag) · From ·
  To (NANP without "+1 "; full number in the tooltip and the modal) ·
  **Duration** (a red "N/A" pill when not answered — the old Status
  column) · Quality (pill; packet loss in its tooltip) · **Loss %** only
  where the panel has room (container query on `.cq-records`: tenants
  from 860px, staff from 1200px of panel) · Carrier (staff) · Trunk
  (clipped + title) · Cost Est. (staff). Everything moved out of the row
  is in `CdrDetailModal` (status, per-direction loss, full timestamps).
  Narrower (820 / 390, or the Leg column), the table pans INSIDE its panel
  (`.dlx4-tablewrap`) with a soft edge shade where there is more
  (`.cq-panwrap.is-left/.is-right`, set by `usePanEdges`); the page never
  scrolls sideways. Rows stay `tr.dl-row`; row click opens
  `CdrDetailModal`. Page CSS: `cq-`/`cqf-`/`cqk-` classes in
  `styles/dl-platform-b.css` (+ `--cq-pan-shade`). Grades: see §16.

**`TroubleshootingPage`** (`/troubleshooting`)
Full-screen page (outside `AppLayout`, renders its own `Sidebar`). This is a
**native React SIP-trace search page** — there is no Homer iframe any more.

- **Layout (§20):** a one-row `CompactHeader` (crumb · SIP Trace Search ·
  "Open SIP Dashboard"), then the search form as ONE row at desktop —
  omnibox · time-range presets · Search / Clear (all 40px) — with the live
  hint under the omnibox and the resolved window ("Oct 21, 3:21 PM → Oct 22,
  3:21 PM (local)") under the presets. Start / End appear only for
  **Custom** (one slim row, labels inline). Advanced (From · To · Call-ID)
  is a kit `Disclosure` (bare) whose row shows "N active" — the criteria
  apply while it is closed. The form restacks by the PANEL's width
  (container `tssearch`: presets + buttons under the omnibox below 980px,
  one column below 640px). The **results panel is bounded to the first
  screen** (`useViewportFit` → `--ts-res-top`, container `tsres` ≥ 480px):
  head on one line (Results · what was searched · count), the table
  scrolls inside under sticky column heads, the pager is pinned under it,
  and `.dl-shell.dlx5-shell` ends 24px under it, so the page itself does
  not scroll. Columns drop out by priority as the panel narrows (`dlx5-c-*`):
  the "Ladder" word < 1080px, Orig/Term < 960px, Attestation/Zone < 760px
  (parties stack, the date sits over the clock), Duration + the open column
  < 520px (the row itself opens the call) — the call panel always has all
  of them. No sideways page scroll at 390px.
- A search form (number or Call-ID, time range, optional From / To / Call-ID)
  calls `searchSipTraces()` (`POST /api/homer/search` via `api/homer.ts`)
  using a React Query `useMutation`.
- The returned `data` (flat `HomerSearchResult[]`) plus the `correlations` map
  (Call-ID → related Call-IDs) are grouped into per-call rows via an in-component
  **union-find** (`groupMessagesByCall`) so A-leg and B-leg messages merge into one
  call. Since 2026-09 grouping ALSO unions via the API's additive `legs` map
  (`legs[cid].a_callid`; absent on older APIs ⇒ correlations-only, as before).
  RESULT = final response to the A leg's INITIAL INVITE (a failed failover
  attempt — 503/487/481 — can never override an answered 200); duration = A-leg
  answer → A-leg BYE; B-leg bridge attempts are exposed as `group.attempts` and
  shown as a quiet "2 att · 503 → 200" badge. A `correlation_status` of
  partial/degraded (or `correlation_truncated`) shows a warning banner. The
  ladder receives the group-scoped `ladderCorrelations`. Self-test:
  `pages/troubleshooting/callGrouping.assert.ts` (esbuild | node).
- Results render as a table. **Clicking a row (or Enter/Space; ↑/↓ move between
  rows) opens `pages/troubleshooting/CallTraceModal.tsx`** — a portal modal
  (z 1200, 2px cobalt outline + azure-bright ring, blurred backdrop) holding everything for
  that call: summary facts (start/last msg, result + attempts, STIR
  attestation, duration, zone, orig/term, legs), "Open in Grafana"
  (`buildGrafanaLink` in `callDisplay.ts`), PCAP export, network path,
  correlation notice, and the full **`<SipLadder>`** with its packet inspector.
  Prev/Next buttons and ←/→ step through the page's calls (not while typing or
  inside the packet panel, which marks itself `data-trace-keys="local"`); Esc /
  backdrop closes and focus returns to the row. The selection is bound to the
  exact `callGroups` array, so paging/new searches close it. There is NO inline
  expanded row any more. Shared pills/banners: `CallBadges.tsx`.
- The header has an "Open SIP Dashboard" link to `/grafana/`.

**`AccountPage`** (`/account`)
Profile page. Lets users update their display name and password via
`PATCH /api/auth/me` (calls `apiRequest('PATCH', '/auth/me', ...)`).
Calls `refreshUser()` from `AuthContext` on success.

### Admin pages

None. All admin pages (customers, trunks, carriers, rates, tiers, SIPp, DID
search, onboarding, user lookup, Homer tab) were removed from this SPA; admin
lives in TED. `RequireAdmin` remains only for admin-gated pieces of shared pages.

---

## 8. Components

### Layout (`src/components/layout/`)

**`AppLayout`**
Renders `Sidebar` on the left (fixed, 240px) and `<Outlet />` in the main
content area. Root is `.app-canvas` (`--t-canvas-bg`: paper on light,
granite + a faint azure pool on dark). Also flips `<html data-landing>` on
`/` (the theme-exempt landing, §18).

**`Sidebar`**
Fixed left sidebar (collapsible on desktop via `SidebarCollapse`). Themed
(§18): a white daylight panel on light, the original dark shell on dark —
every colour is a `--t-sb-*` token via the `sb-*` classes in
`styles/app-shell.css`; the only inline colour is each row's product accent
(`--sb-accent` = `--t-sb-accent-azure|green|amber`, typed `SidebarAccent`).
Brand: the landing nav lockup (cube `crag-mark` + "GRANITE CRAG"). Footer
card, two rows: avatar + full name/email (→ /my-account), then the action
row — **theme switch** (`ThemeToggle`, sun/moon + "Switch to dark|light",
accessible name "Switch to dark theme") and "Sign out". Collapsed
(desktop): the switch rides a slim icon tab under the collapse tab. Mobile
(<768px): a real topbar (menu · lockup · icon switch) opens the drawer
(Esc or the scrim closes it) — it had been `display:none` inline since
April. Authenticated
order: **Dashboard (top-level item) → Products → Insights (Reporting) →
Administration/Support → Coming Soon**. **Dashboard** (`/dashboard`, normal live
active style) shows for platform admins (the admin dashboard) and every
non-support user with an `effectiveCustomer` (tenants, and an admin in
customer view once a preview is picked). Sidebar blues are the brand family
via tokens (`--t-sb-accent-azure`, sign-in button `--brand-btn-*`). There is no
Documentation group any more (2026-10). Coming Soon
is ALWAYS last and rendered darkened (muted header, dim slate rows + "Soon"
pill, no product accent even when active) — new pre-launch or de-prioritised
items go in `COMING_SOON_ITEMS`, never in the live groups. It currently holds
**SIP Trunking (`/trunks`), [API Calling while `API_CALLING_ENABLED`], Visual
Voicemail, Guides (`/docs/guides`), API Reference (`/docs/api`)** — all LINKED
rows (`sb-soon-row--link`), so their routes stay reachable (SIP Trunking hosts
the owner's test customer). A row may carry `isActiveFn` (the docs rows
prefix-match `/docs/guides/:product`, `/docs/api/:product`); the same
`isSoonItemActive()` drives the row's muted active style and the group's
auto-open. Coming Soon rows show to every non-support user regardless of
`account_type`. Support sees only its Support tools (no Products/Coming Soon).
**Visual Voicemail is live per ACCOUNT**: it moves from Coming Soon into
Products (with an unread badge) when `GET /v1/voicemail/summary` (same cache
key as the page; tenant = no customer_id, admin preview = the preview
customer) says `enabled`, and always for admins in normal view. A failed
summary call leaves it in Coming Soon (still linked). **IVR** follows the
same rule with `GET /v1/ivr/summary` (`ivrData.ts` scope + key).
Products holds only live products, filtered by the EFFECTIVE account type
(`effectiveCustomer.account_type`, falling back to `user.account_type`; admins in
normal view see all) — today just RCF (`rcf`, `hybrid`); the Products group
(header included) is hidden when the filtered list is empty (e.g. a
`trunk`-only account). In customer view the amber "Viewing as Customer" banner
holds the preview-customer picker.
Group open state persists in `localStorage` (`sidebar_groups_open`). Admins get
a "View as Customer" toggle above the user footer.

**`PageHeader`**
Standardised page title block: title (h1), optional subtitle, optional right-side
actions slot. Used as the first child of most page components.

**Layout kit (`kit/`)** — `CompactHeader`, `Disclosure`, `useShowMore` +
`ShowMoreButton`, `ClampText`, `BalancedGrid` (+ `.lk-col` / `.lk-grow` /
`.lk-follow` / `.lk-cap`), `ScrollArea`, `MasterDetail`. Balanced, compact,
expandable pages — the rulebook is §20.

### Auth (`src/components/auth/`)

See section 4 above.

### UI primitives (`src/components/ui/`)

| Component | Props summary |
|---|---|
| `Button` | `variant: 'primary'\|'ghost'\|'danger'\|'success'`, `size: 'xs'\|'sm'\|'default'`, `loading: boolean`, `icon: ReactNode` |
| `Badge` | `variant: BadgeVariant` — covers status, account types, directions, traffic grades, SIPp verdicts |
| `Modal` | `open`, `onClose`, `title`, `children`, `footer`, `maxWidth`. Closes on Escape, traps body scroll |
| `FormField` | Polymorphic: `as: 'input'\|'select'\|'textarea'`. Renders label, field, hint, error. Passes all native HTML attributes through |
| `Card` / `CardTitle` | Raised theme panel (`.glass-surface` = `--t-panel-bg` + hairline + `--t-shadow-card`), lifts on hover |
| `StatCard` | Displays a single large metric with label and optional background icon |
| `TabBar` | Horizontal tab bar with underline active indicator, optional count badges |
| `Table` / `TableWrap` / `Thead` / `Th` / `Td` | Table primitives on theme tokens (tint header, soft row rules) |
| `Pagination` | "Showing X of Y" with "Load More" button (offset-based, not page-based) |
| `Spinner` | Animated SVG ring, sizes `xs` and `sm` |
| `Toast` / `ToastContext` | Toast system — `useToast()` returns `{ toast, toastOk, toastErr }`; raised surface + status tone (`TONE`) |

**Using the toast system:**
```typescript
const { toastOk, toastErr } = useToast();
toastOk('Customer created');
toastErr(err.message);
```
Toasts auto-dismiss after 4 seconds. They stack in the bottom-right corner.

All `components/ui/*` primitives draw from the theme tokens only (no hex),
so they read right in both themes; `Modal` is elevation 2 (raised surface,
`--t-shadow-modal`, `--t-scrim` backdrop, azure keyline on dark).
`ThemeToggle` (`components/layout/`) is the one theme switch — reuse it,
never re-implement it.

### SIP Ladder (`src/components/sip-ladder/`)

The recently-shipped SIP ladder diagram used by `TroubleshootingPage` to visualize a
correlated call's signaling. Public surface (via `index.ts`): the `<SipLadder>`
component plus the `LadderLayout`, `LadderMessage`, `LadderNode` types.

| File | What |
|---|---|
| `SipLadder.tsx` | Main component. Props: `{ messages: HomerSearchResult[], correlations: Record<string, string[]> }`. Renders endpoint columns (carrier / load balancer / SBC / media server) and time-ordered message arrows. Owns selected-packet state and node role labels/colors. |
| `SipMessageRow.tsx` | One horizontal message row — arrow between source/dest columns, method/status label, retransmission and time-delta markers. Exports `TIMESTAMP_COL_WIDTH`. |
| `PacketDetailPanel.tsx` | Inline packet inspector shown when a message is selected. Parses the raw SIP message (`raw_msg`) into start line, headers (highlighting important ones — Via, Record-Route, Contact, From/To, Call-ID, CSeq, Session-Expires…), and SDP (c=, m=, codecs, ports). |
| `sipLadderLayout.ts` | `computeLayout()` — turns raw `HomerSearchResult[]` + correlations into a `LadderLayout` (ordered nodes, processed messages, A-leg/B-leg Call-ID sets, duration). Handles node ordering and B-leg column splitting. |
| `sipLadderTypes.ts` | `NodeRole`, `LadderNode`, `LadderMessage`, `LadderLayout` types. |
| `sipLadderUtils.ts` | `LADDER_COLORS` — the ladder's ONE colour object; every value is a `var()` string (`--t-*` theme tokens + the `--ladder-*` page tokens), so the ladder follows light/dark with no re-render. `ladderMix(color, pct)` builds translucent variants (`color-mix()`, never a hex-alpha suffix). Plus `formatTimeDelta` and related helpers. |
| `sipLadder.css` | The `--ladder-*` page tokens (§18.5), scrollbar pseudo-elements and the opaque sticky-header paint — what inline styles can't express. |
| `sipUtils.ts` | SIP parsing helpers (method/status extraction, leg detection, retransmission detection). |
| `index.ts` | Barrel export. |

Node names are pre-aliased by heplify-server (e.g. "BW-NY", "SBC-1", "FreeSWITCH"),
so no IP resolution happens in the frontend.

Theming: arrows, heads and markers paint through `style={{ fill, stroke }}`
or `currentColor` — never the SVG `fill=` / `stroke=` attributes (§18.3
rule 5). Message hues keep their meaning in both themes (A-leg INVITE azure,
B-leg amber, 1xx violet, 2xx green, 4xx/5xx red, ACK teal, BYE slate).

### Icons (`src/components/icons/ProductIcons.tsx`)

Named wrappers around `lucide-react` icons. All accept `size?: number` (default 18).
Available: `IconRCF`, `IconTrunk`, `IconAPI`, `IconIVR`, `IconDocs`, `IconAdmin`,
`IconSignal`, `IconTroubleshoot`, `IconVoicemail`.

### Entity cards

Per-entity card components used in list/grid views. They render one record with
inline edit/action affordances and live in the page directories (not `ui/`):

| Component | Location | Renders |
|---|---|---|
| `RcfCard` | `pages/RcfCard.tsx` | One RCF entry, inline `forward_to` editing |
| `TrunkCard` | `pages/TrunkCard.tsx` | One SIP trunk with IPs/DIDs/stats |
| `ApiDidCard` | `pages/ApiDidCard.tsx` | One API DID |
| `CarrierCard` | `pages/admin/CarrierCard.tsx` | One carrier + live connectivity test |
| `TierCard` | `pages/admin/TierCard.tsx` | One service tier |
| `CustomerExpandedView` | `pages/admin/CustomerExpandedView.tsx` | Inline expanded customer detail (RCF/API/trunk sections + add-credit) |
| `SbcDistribution` | `pages/admin/SbcDistribution.tsx` | Live per-SBC call distribution panel (polls `getSbcStats`) |

None of these render today: `RcfCard.tsx` and the `pages/admin/*` files no
longer exist, and `TrunkCard` / `ApiDidCard` are imported nowhere
(TrunksPage / ApiDidsPage don't use them) and were NOT converted to theme
tokens (§18.8).

### `AdminCustomerSelector`

Dropdown that lets admins filter portal pages by customer. Only renders when
`isAdmin` is true. Loads up to 500 customers and can filter by `accountTypes`.
Currently imported nowhere and NOT themed (still hex literals — convert to
tokens before reusing it). The
admin dashboard and `/rcf` console use `pages/dashboard/AdminScopeSelect`
(granite header dropdown) instead.

---

## 9. Types

All types live in `src/types/`. They map 1:1 to FastAPI Pydantic schemas.

| File | Key types |
|---|---|
| `auth.ts` | `User`, `LoginResponse`, `UserCreate`, `UserUpdate` |
| `customer.ts` | `Customer`, `AccountType`, `CustomerStatus`, `TrafficGrade` |
| `rcf.ts` | `RcfEntry`, `RcfCreate`, `RcfUpdate` |
| `trunk.ts` | `Trunk`, `TrunkIp`, `TrunkDid`, `TrunkStats`, `CallPathPackage`, `TrunkCreate` |
| `apiDid.ts` | `ApiDid`, `ApiDidCreate`, `ApiDidUpdate` |
| `carrier.ts` | `Carrier`, `CarrierCreate`, `CarrierUpdate`, `CarrierTestResult`, `CarrierTransport`, `CarrierAuthType` |
| `cdr.ts` | `Cdr` (with full RTP/quality fields), `CdrSearchParams`, `CdrSearchResult`, `ProductType`, `CallDirection` |
| `rate.ts` | `Rate`, `RateCreate`, `RateUpdate`, `RatesResponse`, `MarginsData`, `CdrSummaryRow`, `CdrSummaryResponse` |
| `ivr.ts` | §2 graph (`IvrGraph`, `IvrNode` — a union discriminated on `type`, `IvrEdge`, per-block configs) + §8.2 shapes (`IvrSummary`, `IvrNumber`, `FlowSummary`, `Flow`, `Prompt`, `Issue`, `Destinations`, `SimulateResult`, …) |
| `tier.ts` | `Tier`, `CustomerTierResponse`, `TierType` |
| `health.ts` | `HealthCheck`, `DetailedHealth`, `ComponentHealth`, `HealthStatus` |
| `documents.ts` | `SharedDocument`, `DocumentFolder`, `DocumentStats`, `DocumentListResult`, `UploadProgress` |
| `sipp.ts` | `SippPreset`, `SippRunConfig`, `SippRunResponse`, `SippResults`, `SippVerdict` |
| `didInventory.ts` | `DidStatus`, `DidInventoryItem`, `DidStats`, `DidAssignRequest`, `DidInventoryListParams`, `DidInventoryListResponse`, `DidAvailableParams` |
| `onboarding.ts` | `OnboardingStatus`, `OnboardingRequest`, `DIDConfigEntry`, `OnboardingSubmitPayload`, `ApprovePayload`, `ApproveResponse` |

Holistic-numbers additions (all OPTIONAL — older APIs omit them):
`reports.ts` `ReportProduct` is open-ended (`'rcf'|'trunk'|'api'|'voicemail'|
(string & {})`), `MyNumber.enabled?` / `forwards_to?`, `ReportCallRow.product?`;
`cdr.ts` `ProductType` adds `'voicemail'`, `ProductFilter = ProductType |
'all'`, `CdrSearchParams.number?`; `cdrActivity.ts` `product_type?:
ProductFilter`, `number?`; `account.ts` `counts.numbers?: {total, by_product}`.

**`User.account_type`** controls what the authenticated user sees in the sidebar
and on their pages. It is a nullable union: `'rcf' | 'api' | 'trunk' | 'hybrid' | 'ucaas' | null`.

**`User.role`** controls admin access: `'admin' | 'user' | 'readonly'`.
`'readonly'` users see the Administration group in the sidebar but can only view
call quality and troubleshooting (no edit access).

---

### Products catalog (`src/config/products.ts`)

The ONE place that names the product a customer's number belongs to (rcf ·
api (hidden while retired) · trunk · voicemail · ivr): `label` ("Call forwarding"),
`tag` ("RCF"), on/off words ("Forwarding"/"Paused", "Taking
messages"/"Off"), `mixWord`, "where calls go" copy, `order`, `hidden`.
Helpers: `productInfo`, `productLabel`, `productTag`, `isProductHidden`,
`compareProducts`, `productMix` / `countByProduct` / `mixSentence`,
`nameWithProduct`. An id it doesn't know still renders (title-cased label
"Fax Line", upper-case tag, Active/Off), so a NEW product (a new
`number_routing` arm on the API) appears on the dashboard, Reporting, My
Account and the admin counts with NO UI change; an entry here is optional
polish. Not the dashboard header's product SWITCHER (`pages/dashboard/products.ts`).

---

## 10. Utilities

### `src/utils/cn.ts`
```typescript
cn(...inputs: ClassValue[]): string
```
`clsx` + `tailwind-merge`. Use this everywhere Tailwind classes are conditionally
composed so conflicting utilities are resolved correctly.

### `src/utils/format.ts`
- `fmt(phone)` — formats E.164 / 10-digit US numbers as `+1 (XXX) XXX-XXXX`
- `fmtMoney(amount, decimals?)` — USD with `Intl.NumberFormat`
- `fmtRate(ratePerMin)` — `$0.0124/min`, trims trailing zeros
- `fmtDuration(seconds)` — `"2m 30s"` or `"45s"`
- `escHtml(str)` — HTML-escapes for innerHTML interop (prefer JSX escaping instead)

### `src/utils/csv.ts`
- `exportCdrsCsv(cdrs)` — serialises CDR array to CSV and triggers a browser
  download via `URL.createObjectURL`.

---

## 11. IVR Builder Internals

Moved to §19 (Visual IVR). The old `@dnd-kit` builder (`src/pages/ivr/*`,
`IvrBuilderPage`, TwiML XML generation) was deleted when the product
shipped — its save dropped every branch and prompt and could not be
revived.

---

## 12. RCF-V1 Product Scope

This is the RCF-V1 production architecture. Know what is and is not available:

### Fully implemented and deployed

- **RCF** (`account_type: 'rcf'`) — the primary product. Full CRUD, inline editing, bulk operations.
- **SIP Trunks** (`account_type: 'trunk'`) — early access: the call path is live, trunk
  administration lives in TED, and the customer portal (`/trunks`, §7) is
  self-serve: trunks, live activity, connection details, authorized IPs, DIDs.
- **Admin** — lives in TED (the CRAG console), not this SPA. Staff pages here: the admin
  dashboard, the admin `/rcf` console, Calls & Quality (`/cdrs`) and Troubleshooting.
- **Visual Voicemail** — encrypted voicemail v1 + optional transcription (merged
  2026-10-23), enabled per account; see §17.
- **Visual IVR** — per-account entitlement (`customers.ivr_enabled`, set in
  TED); the /ivr page, builder and messages; see §19. Calls only reach it
  once FreeSWITCH runs with `IVR_ENABLED=true` and a number is assigned.
- **Call Quality** — platform-wide CDR quality analysis with MOS/jitter/packet-loss metrics.
- **Troubleshooting** — native React SIP-trace search (`POST /homer/search`) with a
  custom `<SipLadder>` diagram and inline packet-detail inspection. Grafana
  (`/grafana/`) provides the optional deep-link dashboard. No Homer iframe.
- **Documents** — shared document store with folder hierarchy.

### Phase 2 / Not yet customer-facing

- **API Calling** (`account_type: 'api'`) — **RETIRED 2026-09, code kept.** Every
  API-product surface is gated on `API_CALLING_ENABLED` in `src/config/features.ts`
  (currently `false`; mirrors the backend/FreeSWITCH env var of the same name — flip
  BOTH to restore): the `/api-dids` route (redirects to product home), the Sidebar
  "Coming Soon" item, My Account's API DID section/tiles,
  the Guides "calling" section (slug redirects to the hub default; the API
  Reference has no calling section at all — it names programmable voice only
  as "on our roadmap", and `/docs/api/calling` lands on Getting started),
  the Calls "API" product filter and the onboarding API product option. (The
  landing page no longer has any API Calling copy, flag or not.) With the flag
  off nothing calls `/api-dids`. `productHome`
  sends `api` accounts to `/my-account`.
- **Hybrid** (`account_type: 'hybrid'`) now means **RCF + SIP Trunking** (no API
  section). Granite Telephony, the primary customer, is hybrid.
- **Payments Demo** — REMOVED 2026-09 (`pages/admin/payments-demo/*` incl.
  `X402Visualizer`, `styles/dl-payments.css`, its `/admin/payments-demo` route and
  sidebar item). There is no revup `/admin` UI left; admin lives in TED.
- **UCaaS** (`ucaas_enabled: true`) — `CustomerUcaasSection` provides extension/voicemail
  management for admin. The softphone widget (WebRTC/Verto) is referenced in nginx
  (`/ws/verto/` proxy) but the softphone component itself is not in this codebase.

### RCF customers specifically

RCF customers (`account_type: 'rcf'`) land on **Dashboard** (`/dashboard`, the
card overview — top-level sidebar item) and get RCF (`/rcf`, the full numbers
manager) under Products and Reporting under Insights. Coming Soon (darkened, last) lists SIP Trunking (NOT a link for them —
`linkAccountTypes` limits the link to admins and trunk/hybrid), Visual Voicemail
(until voicemail is enabled on the account — then it is under Products),
IVR (likewise, until IVR is enabled), Guides and API Reference. Products are filtered in `Sidebar.tsx` against
the effective account type (`allProductNavItems`) — an admin previewing an RCF
customer in "View as Customer" sees exactly this nav, scoped to that customer.

---

## 13. CRITICAL: React Hooks Ordering

**React error #310 ("rendered more hooks than during the previous render") has
occurred three times in this codebase, always from the same mistake.**

### The rule

**Every hook call must appear unconditionally at the top of the component function,
before any early returns, conditional renders, or derived values that depend on hooks.**

This is the React rules-of-hooks invariant. Violating it causes React to lose
track of hook call order between renders.

### What triggers the bug

```typescript
// WRONG — useState after an early return
function MyComponent({ id }: { id: number | null }) {
  if (!id) return null;          // <-- early return
  const [value, setValue] = useState(''); // <-- hook after return = #310
  ...
}
```

```typescript
// CORRECT
function MyComponent({ id }: { id: number | null }) {
  const [value, setValue] = useState(''); // hook first
  if (!id) return null;                   // early return after hooks
  ...
}
```

### Where this has bitten us

The `Sidebar` component has a comment explicitly warning about this. The SoftphoneWidget
(referenced in memory, not currently in this repo) caused React #310 three separate
times due to hooks placed after conditional early returns.

### Checklist when adding hooks to an existing component

1. Scan for any `if (...) return ...` above the hook line.
2. Move the hook above all early returns.
3. If the hook needs the guard value (e.g., to skip a query), use the `enabled`
   option rather than a conditional hook call:
   ```typescript
   const { data } = useQuery({
     queryKey: ['foo', id],
     queryFn: () => fetchFoo(id!),
     enabled: id !== null,   // query skips if id is null
   });
   ```
4. After any changes, run `npm run lint` — `eslint-plugin-react-hooks` catches
   most violations statically.

---

## 14. How to Add a New Page

1. **Create the type** in `src/types/yourThing.ts`.

2. **Create the API module** in `src/api/yourThing.ts` using `apiRequest`:
   ```typescript
   import { apiRequest } from './client';
   import type { YourThing } from '../types/yourThing';

   export async function listYourThings(): Promise<YourThing[]> {
     return apiRequest('GET', '/your-things');
   }
   ```

3. **Create the page component** in `src/pages/YourThingPage.tsx`:
   ```typescript
   import { useQuery } from '@tanstack/react-query';
   import { listYourThings } from '../api/yourThing';
   import { PageHeader } from '../components/layout/PageHeader';
   import { Spinner } from '../components/ui/Spinner';

   export function YourThingPage() {
     // ALL hooks unconditionally at the top
     const { data, isLoading, isError } = useQuery({
       queryKey: ['your-things'],
       queryFn: listYourThings,
     });

     // Early returns only after all hooks
     if (isLoading) return <Spinner />;
     if (isError) return <div>Failed to load</div>;

     return (
       <>
         <PageHeader title="Your Things" subtitle="..." />
         {/* content */}
       </>
     );
   }
   ```

4. **Register the route** in `src/App.tsx` inside the `RequireAuth > AppLayout`
   subtree (or `RequireAdmin` if admin-only).

5. **Add a nav item** to `allProductNavItems` or admin items in `Sidebar.tsx` if
   the page needs sidebar navigation. Include `accountTypes` filter if relevant.

6. **Run the type check** before pushing (CI runs the same on every PR):
   ```bash
   cd docker/ui/app && npm run build   # tsc -b && vite build
   ```
   Not `npx tsc --noEmit`: `tsconfig.json` is a solution file (`"files": []`
   plus references), so that command type-checks nothing and always passes.
   `npx tsc -b` alone is the type-check without the Vite bundle.

---

## 15. Design System Conventions

The codebase mixes Tailwind utility classes, page CSS files (`styles/*.css`,
prefix per page: `ad-`, `rcfd-`, `vm-`, `cq-`…) and inline styles. The pattern:
- **Structural layout** (flex, grid, gap, margin, padding): Tailwind classes
  via `cn()` or page CSS. Load-bearing responsive layout is hand-written
  `@media` / container queries, not Tailwind `md:*`.
- **Colour, borders, shadows, glow: THEME TOKENS ONLY.** Every colour is a
  `--t-*` custom property from `src/styles/theme.css`, defined for light AND
  dark (§18). In CSS: `var(--t-text-dim)`. In TSX: the typed `T.*` /
  `TONE.*` / `CHART.*` strings from `src/styles/theme.ts`
  (`style={{ color: T.textDim }}`). In Tailwind arbitrary values:
  `text-[color:var(--t-text-dim)]` (keep the `color:` hint). **No hex,
  `rgb()`/`rgba()` or Tailwind palette colours (`text-red-400`,
  `bg-blue-500/10`…) in new or touched code** — they cannot follow the theme.
- **Brand blues** are the `--brand-*` family (index.css `:root`; azure
  `#2f7df6`, azure-deep `#1d63dd`, azure-bright `#4f92ff`, cobalt `#113398`)
  and reach pages through the theme's accent roles: `--t-accent` (fills),
  `--t-accent-line` (indicators, rings), `--t-accent-text` (links, accent
  text), `--t-accent-tint` / `-wash` / `-border`. Never Tailwind blue
  `#3b82f6`. `styles/brand.ts` hex is print/PDF-only (§18).
- **Alpha variants** of a token: `color-mix(in srgb, var(--t-accent) 12%,
  transparent)` (TS: `tMix('accent', 12)`) — never `${hex}22` suffixes.
- **Status** (good / warning / bad / info / neutral): the `--t-{ok,warn,
  danger,info,neutral}-{fg,bg,border,solid}` tokens (TS: `TONE.ok.fg` …).
  Grade *logic* stays in `pages/calls/quality.ts`.
- **Elevation:** canvas (`--t-canvas-bg`) → panel (`--t-panel-bg` + 1px
  `--t-line` + `--t-shadow-card`) → raised (`--t-surface-raised` +
  `--t-shadow-pop`/`--t-shadow-modal`). Inputs sit in wells (`--t-field-*`).
- **Fonts never change with the theme.** Display: Archivo; body: Public Sans
  (daylight scope) / IBM Plex Sans (app default); mono: IBM Plex Mono.

Sidebar active rows: a product-accent gradient wash + accent border + soft
accent glow + dot. Accents are tokens per theme (`--t-sb-accent-azure` for
products/dashboard/reporting, `-green` for Calls & Quality, `-amber` for
Troubleshooting); the alpha steps live in `styles/app-shell.css`.

---

## 16. Voice-Quality Grades — ONE owner (`pages/calls/quality.ts`)

Contract: `docs/CALL_QUALITY_ACCURACY_PLAN.md` (§B.3 column semantics, §C.3
`quality_by_direction`, §D grade definition). Since migration 50 `mos` /
`r_factor` are our ITU-T G.107 E-model values from TRUE RTP sequence loss
(clean G.711 = 4.41, the ceiling) and are non-NULL ONLY when
`quality_status === 'rated'`; `jitter_*` are RFC 3550; `quality_pct` and
`jitter_min_ms` are always NULL; FreeSWITCH's own values live in `fs_*`
(staff only).

- **`quality.ts` is the single UI grade source.** `gradeForMos` (great ≥ 4.34 ·
  good ≥ 4.02 · fair ≥ 3.60 · poor), `gradeLabel`, `gradeColor` / `gradeTone`,
  `qualityStatusReason` / `qualityStatusShort` (why a call isn't graded, in
  customer or staff wording), `summarizeCallQuality`, `percentileCont`, and
  the colour-only thresholds (R 80/70, loss 4/8 %, jitter 20/50 ms). Never
  hard-code a MOS/R/loss threshold in a component — Python
  (`services/call_quality.py`), SQL (`cq_grade`) and Grafana use the same cut
  points and must agree on every stored row.
- **Colour constants (theming, §18).** `GOOD` / `WARN` / `BAD` / `INK_FAINT`
  and everything `gradeColor` / `gradeTone` return are theme `var()` strings
  (light = the old `#15803d` / `#b45309` / `#b91c1c` / `#8b99b0`; callers may
  still compare them by identity). `QUALITY_PRINT_HEX` is the same four as
  fixed hex for print / file output only. Reporting mirrors this in
  `pages/reporting/reportFormat.ts`: `GRADE_TONE` (screen) vs
  `GRADE_TONE_PRINT` (the PDF), and `TREND_SERIES` (screen chart roles,
  `CHART.*`); the hex `TREND_COLORS` is legacy and imported by nothing.
  STIR/SHAKEN pills: `components/stir/attestationColors.ts` exports
  `ATTEST_TONES` (attestation label → `{ text, bg, border }` theme tokens),
  shared by `AttestationChain` and the troubleshooting `CallBadges`.
- **`quality.assert.ts`** is the boundary self-test (4.34/4.33, 4.02/4.01,
  3.60/3.59 — identical to the Python tests). Dev-only dynamic import from
  `CdrDetailModal.tsx`; run by hand with node type-stripping or esbuild.
- **Call vs leg.** Call-level surfaces (tables, KPIs, RCF activity) read the
  CALL grade `call_quality_grade` / `call_quality_status` / `call_mos` — the
  worse of the two audio directions. Leg-level `quality_status` /
  `quality_grade` / `mos` describe ONE direction (A row = caller's audio).
- **Honesty rules.** One-way audio (`no_rtp`) renders as a red "One-way"
  (graded poor, MOS NULL) — never a score. Ungraded calls render "—" / "Not
  rated" with the reason. `no_media` (migration 51 — no audio in EITHER
  direction: failed/test call, both parties silent) is ungraded, never
  "One-way": customer reason "No audio either way — the call never carried
  sound". No averages of MOS/loss/jitter anywhere — shares
  and percentiles only. Tenants keep the existing redaction (no FS raw values,
  no packet/byte counters, no money).

---

## 17. Visual Voicemail (`/voicemail`, encrypted voicemail v1)

Contract: `docs/ENCRYPTED_VOICEMAIL_INTERFACES.md` §4 (API) + §7 (UI); plan
`docs/ENCRYPTED_VOICEMAIL_BUILD_PLAN.md`. Transcription (v1.1):
`docs/VOICEMAIL_TRANSCRIPTION_PLAN.md` §10–§11, owner decisions §0.1. Copy is
trimmed to what ships — **no transcript search, notifications, voicemail API
or prices** (D3/D5), web retrieval only (D7; the PIN is stored for a future
dial-in).

- **Route entry** `pages/VisualVoicemailPage.tsx` (lazy): tenant →
  `CustomerVoicemail` (own account; `readonly` = play + download only);
  admin in customer view → same view on the PREVIEW customer with staff
  controls (`PreviewPrompt` until one is picked); admin normal view →
  `AdminVoicemailConsole` (`?customer=<id>`, absent = All customers, a
  "Viewing" select); support → productHome. Views are keyed by scope.
- **Body** `pages/voicemail/VoicemailWorkspace.tsx` (layout kit, §20):
  `CompactHeader` in one row (crumb · Voicemail + `EncryptionBadge` ·
  admin "Viewing" picker · Unread / Messages / Mailboxes · New mailbox for
  staff), a slim one-row mailbox bar (grouped by customer on All
  customers), suspended banner, tabs **Messages** (`InboxView` =
  `MasterDetail`: Inbox/Saved/Trash with counts over the scrolling
  `MessageList` | `ReadingPane` — caller + Played/New badge, ONE inline
  meta row Received · Length · Mailbox, a one-row `Player`, the transcript
  clamped to 4 lines with "Show full transcript", actions + retention line
  pinned in the pane footer; both panes end at the bottom of the first
  screen) and **Greeting & settings** (`MailboxSettings`: `BalancedGrid`
  Greeting | Details + Transcription in one equal-height row, then
  expandable rows PIN · Storage · staff Administration (suspend / resume /
  delete — still typed-number confirmation), placed under the shorter
  column; open state remembered as `vm:pin` / `vm:storage` / `vm:admin`).
  States: loading, 503 → "temporarily unavailable", tenant not enabled →
  `VoicemailIntro`, no mailboxes (staff get the create CTA). Times render in the MAILBOX timezone (`format.ts`).
- **Scope + cache** (`voicemailData.ts`): tenant key `self:<own id>` with no
  customer_id; staff `c:<id>` with `customer_id`; console All = `all`. Every
  mutation invalidates `['voicemail']`. The sidebar shares the summary key.
- **Playback** (`useAudioPlayer.ts`): nothing is minted until Play (minting
  marks read). The `{url}` from `POST …/playback-token` is used verbatim as
  `<audio src>`; re-minted when ~100 s old (token = 120 s); a media error
  (e.g. a Range request after expiry → 401) is recovered once by minting and
  seeking back. Download = token with `download: true` + an `<a download>`.
- **Greetings** (`GreetingDialog.tsx` + `audio/`; the capture itself is the
  shared `useAudioCapture` + `AudioCapturePanel`, also used by the IVR prompt
  dialog at 8 kHz — §19): record (Web Audio PCM via
  AudioWorklet, ScriptProcessor fallback; auto-stop 2:00) or upload any audio
  file (`decodeAudioData`) → mono → 16 kHz (OfflineAudioContext) → PCM16 WAV
  → limits (≤ 120 s, ≤ 5,000,000 B) → local preview → raw `audio/wav` POST
  (`?label=&activate=`). `audio/wav.ts` is pure; its self-test runs with
  `node src/pages/voicemail/audio/wav.assert.ts` (Node type stripping).
- **Admin create** (`NewMailboxDialog.tsx`): customer fixed (preview / console
  customer) or picked; DID from `GET /available-numbers?q=`; name, timezone,
  optional PIN. 409 = number taken (list refreshes); 503 = nothing created.
- **Transcription (v1.1)** — everything keys off `summary.transcription_available`
  (platform flag on + valid config), read once in `VoicemailWorkspace`.
  - **Admin-only switch (owner decision O2):** on/off, language and "Transcribe
    earlier messages" (backfill) are editable ONLY when `canManage` (platform
    admin, incl. "View as Customer" with `customer_id = null`) —
    `MailboxSettings` → `TranscriptionPanel`. Tenants (`user`/`readonly`) get a
    read-only "Transcription: On — English (US)" line while it is on and no
    panel while it is off. `NewMailboxDialog` (admin) offers "Transcribe new
    messages", unchecked by default (O1), only while available.
  - **Cache:** transcripts live under their OWN root `['voicemail-transcript']`
    (`vmTranscriptKeys`) — `invalidateVoicemail()` must never refetch them
    (each `done` fetch = KMS decrypt + audit row). `useTranscript`:
    `staleTime: Infinity`, 5 s poll while pending/processing, stops after 3 min
    ("Still transcribing — check back shortly."); refetched only after a retry
    or when the list's status for that message changes. `useTranscriptSnippets`:
    per-id cache (`staleTime`/`gcTime: Infinity`), ids batched ≤ 50 per
    request via a per-mailbox loader. Folders poll every 10 s while a loaded
    message is pending/processing (never Trash). Never persisted (D8).
  - **UI:** `MessageList` third line (`vm-row-snippet`); `TranscriptPanel` in
    `ReadingPane` between `Player` and the actions — every state of plan §11.4;
    "disabled, mailbox off" shows the "Turn it on" link to admins only (O2);
    retry buttons follow the API's `can_retry` (admins: forced re-run on
    `done`); a rendered `done` transcript marks the message read once for
    writers. `VoicemailIntro` mentions optional transcripts only while available.
- Styles `styles/dl-voicemail.css` (`vm-`), container queries on `.vm-body`.
  Colour: theme tokens + the `--vm-*` roles on `.vm-scope` (§18.5).
  Dialogs are `VmDialog`, a portal to `<body>` that follows the theme like
  the page (the `--t-*` tokens inherit from `<html>`); its root carries
  `.dl-scope.vm-scope` for the `dl-*` primitive rules and the `--vm-*`
  roles. No longer a light-only portal.

---

## 18. Theming (light / dark)

The signed-in app has two themes. **Light** = the daylight console exactly as
it was (paper `#f4f6f9`, white cards, ink text) with a white sidebar in the
same family. **Dark** = the landing page's granite (`#070c16`), raised panels
with a hairline border and a soft inner top highlight, cloud/mist text,
azure fills with azure-bright lines, links and glow — and the sidebar keeps
its original dark colour. Fonts and layout never change between themes;
only colour, elevation and glow do.

Sources of truth: tokens `src/styles/theme.css` · typed names + helpers
`src/styles/theme.ts` · provider `src/contexts/ThemeContext.tsx` · toggle
`src/components/layout/ThemeToggle.tsx` · shell chrome
`src/styles/app-shell.css` · sync check `scripts/check-theme-tokens.mjs`.

### 18.1 Mechanism

- **Where it lives:** `<html data-theme="light|dark">` plus
  `style.colorScheme` (native controls, scrollbars and date pickers follow).
  Tokens are defined on `:root[data-theme=…]`, so portals, modals and toasts
  inherit them with no scope class.
- **Choice + default:** an explicit pick persists in localStorage
  **`crag_theme`** (`'light'` / `'dark'`; every access try/catch'd). With no
  pick, the OS `prefers-color-scheme` decides and is tracked live. Other tabs
  follow via the `storage` event. `useTheme()` →
  `{ theme, source: 'user'|'system', setTheme, toggleTheme, followSystem }`.
- **No flash:** an inline script in `index.html` sets `data-theme` (+
  `data-landing`, + `colorScheme`) before first paint; `ThemeProvider` takes
  over on mount. Keep the script and `styles/theme.ts` in step (same key,
  same rules). If a CSP is ever added, allow the script by hash.
- **Switching:** one cross-fade (View Transitions where supported, skipped
  under reduced motion); `.theme-switching` on `<html>` suspends per-element
  transitions for two frames so nothing animates out of step.
- **Landing exemption:** the public landing (`/`, signed out — marketing
  page, auth splash and `SignInModal`) is dark whatever the theme.
  `<html data-landing>` forces the dark token set and a dark color-scheme
  while `/` is on screen (index.html sets it before paint, `AppLayout` keeps
  it in step). `landing.css` keeps its own `--lg-*` palette; nothing in the
  theme layer reaches into `.landing-root`.
- **Toggle:** `ThemeToggle` — a real button named "Switch to dark theme" /
  "Switch to light theme", sun/moon icon showing the destination, visible
  focus ring. Seats: the sidebar footer's action row (icon + "Switch to
  dark", beside Sign out), the mobile topbar (icon), and a slim icon tab
  under the collapse tab while the desktop sidebar is collapsed.
- **Pinning a subtree:** `data-force-theme="light|dark"` on any element
  re-declares that theme's whole token set (and `color-scheme`) on it, so
  the subtree renders in that theme whatever `<html>` says. Use it for
  surfaces that are one theme by design: the granite `DashboardHeader`
  band's two content columns (`data-force-theme="dark"` keeps its native
  `<select>` and every token-based child dark on the light theme), a
  print/PDF preview (`"light"`). `--rcf-*` aliases and the `:root`-declared
  page palettes (`--dl-*`, `--cq-*`… §18.5) are re-declared there too;
  scope-keyed ones (`--vm-*`, `--dlx-*`) are not (§18.7).
- **Fallback:** `:root` without the attribute resolves to light.

### 18.2 Tokens

Naming: `--t-<role>[-<variant>]`; sidebar-only `--t-sb-*`. "Shorthand" =
a full `background` value (may carry gradients); "shadow" = a full
`box-shadow` list. `brand-*` = the `--brand-*` blues in index.css `:root`.
TS: `T.<camelCase>` (`T.textDim` = `'var(--t-text-dim)'`, `T.chart1` =
`'var(--t-chart-1)'`).

**Canvas, surfaces, lines**

| Token | Use | Light | Dark |
|---|---|---|---|
| `canvas` | page background colour | `#f4f6f9` | `#070c16` |
| `canvas-bg` | shorthand: the canvas incl. glow (`.dl-scope`, `.app-canvas`) | `#f4f6f9` | azure radial pool @ top-right + `#070c16` |
| `surface` | cards, panels, tables (a colour) | `#ffffff` | `#0f1727` |
| `panel-bg` | shorthand: a panel's full background | `#ffffff` | 5 % cloud sheen gradient + `#0f1727` |
| `surface-raised` | menus, popovers, tooltips, modals, toasts | `#ffffff` | `#151f33` |
| `surface-sunken` | wells, code blocks, inset areas | `#f7f9fc` | `#0a101c` |
| `tint` | subtle fill inside a panel (table heads, chips) | `#f7f9fc` | `#121b2d` |
| `tint-hover` | azure-leaning row/list hover | `#f2f7ff` | `#142036` |
| `hover` / `pressed` | neutral translucent state washes | ink 4 % / 7 % | cloud 8 % / 13 % |
| `scrim` | modal / drawer backdrop | `rgba(14,23,38,.34)` | `rgba(3,7,15,.72)` |
| `line` | borders, dividers | `#e2e8f2` | cloud 16 % (hairline) |
| `line-soft` | row rules, skeletons | `#edf1f7` | cloud 10 % |
| `line-strong` | emphasised borders, tracks, ghost buttons | `#cdd8e8` | cloud 28 % |

Surfaces are **opaque** in both themes (sticky headers and nested cards
must not show what scrolls beneath); lines are translucent hairlines on dark.

**Text**

| Token | Use | Light | Dark |
|---|---|---|---|
| `text` | body + headings | `#0e1726` | `#f2f6ff` |
| `text-strong` | display numerals, titles | `#0e1726` | `#ffffff` |
| `text-soft` | secondary text | `#46566f` | `#c6d3ea` |
| `text-dim` | labels, meta | `#5d6f8c` | `#97a8c6` |
| `text-faint` | decorative / disabled only (2.9:1 on light) | `#8b99b0` | `#6f7f9d` |
| `text-on-accent` | text on azure fills / solid status | `#ffffff` | `#ffffff` |

**Accent, focus, fields**

| Token | Use | Light | Dark |
|---|---|---|---|
| `accent` | fills: primary, selected, toggles, counts | brand-azure | brand-azure |
| `accent-hover` | fill hover/pressed; fills carrying small white text | brand-azure-deep | brand-azure-deep |
| `accent-line` | indicators, active borders, ticks, leading edges | brand-azure | brand-azure-bright |
| `accent-text` | links, accent text, accent icons | brand-azure-deep | brand-azure-bright |
| `accent-text-hover` | link hover | brand-cobalt | `#8ab6ff` |
| `accent-wash` | selected row / item background (opaque) | `#eef4fe` | `#172743` |
| `accent-tint` | chip / pill / active-tab fill | azure 9 % | azure-bright 14 % |
| `accent-border` | chip / pill / selected border | azure 24 % | azure-bright 36 % |
| `cobalt` | deep accent in gradients / secondary marks | brand-cobalt | `#6d8ff0` |
| `focus` | 2px focus outline colour (`--brand-focus-ring` aliases it) | brand-azure | brand-azure-bright |
| `focus-halo` | shadow: field focus halo | `0 0 0 3px` azure 16 % | `0 0 0 3px` azure-bright 30 % |
| `field-bg` | input / select background | `#ffffff` | `#0a101c` (well) |
| `field-border` / `-hover` | input border | `#c9d5e6` / `#a3b6d3` | cloud 28 % / 46 % |
| `field-placeholder` | placeholder text | `#9aa9c0` | `#6f7f9d` |
| `field-disabled-bg` | disabled field | `#f1f4f9` | `#0c1220` |
| `chevron` | `url()` select chevron in the accent-text colour | azure-deep svg | azure-bright svg |

**Status** — `fg` text/icon on a surface · `bg` + `border` pill/banner ·
`solid` dots, bars, accent edges. TS: `TONE.ok.fg` … (`StatusTone`).

| Tone | fg (L / D) | bg (L / D) | border (L / D) | solid (L / D) |
|---|---|---|---|---|
| `ok` | `#15803d` / `#6ee7b7` | green 10 % / emerald 12 % | 26 % / 34 % | `#16a34a` / `#34d399` |
| `warn` | `#b45309` / `#fbbf24` | amber-700 9 % / amber 12 % | 26 % / 36 % | `#d97706` / `#f59e0b` |
| `danger` | `#b91c1c` / `#f87171` | red 7 % / red-400 12 % | 26 % / 36 % | `#dc2626` / `#ef4444` |
| `info` | azure-deep / `#a9c8ff` | azure 9 % / azure-bright 13 % | 24 % / 38 % | azure / azure-bright |
| `neutral` | `#5d6f8c` / `#a9b6cf` | slate 8 % / cloud 8 % | 20 % / 24 % | `#8b99b0` / `#6f7f9d` |

Light values are exactly the `quality.ts` tones (`callOutcome.ts`'s
±0.02-alpha variants fold into them). Categorical hues for roles/tags:
`violet` (`#7c3aed` / `#b49cfc`) and `teal` (`#0e7490` / `#5eead4`) — use
`color-mix()` of them for washes.

**Elevation + glow**

| Token | Use | Light | Dark |
|---|---|---|---|
| `highlight` | shadow: inner top highlight alone | white 90 % | white 5 % |
| `shadow-xs` | shadow: hairline lift (inputs, chips) | ink 5 % | black 45 % |
| `shadow-card` | shadow: panels (= the old `--ad-shadow`) | highlight + soft cool drop | highlight + deep drop |
| `shadow-card-hover` | shadow: interactive panel lift | + azure-deep tint | + azure tint |
| `shadow-pop` | shadow: menus, popovers, toasts | soft cool | highlight + deep |
| `shadow-modal` | shadow: dialogs | soft cool, large | highlight + very deep |
| `glow` | shadow layer: azure bloom for primary/active | transparent no-op | `0 0 24px -6px` azure-bright 55 % |
| `glow-text` | text-shadow for big accent numerals | `none` | azure 32 % bloom |
| `keyline` | shorthand: 1px top keyline (`height:1px; background: var(--t-keyline)`) | `none` | azure-bright fade |

Compose shadows: `box-shadow: var(--t-shadow-card), var(--t-glow);`.

**Inverse band** — the granite header strip (`DashboardHeader`): dark in
both themes; on dark it is lifted by an edge + azure pool instead. The
`band-*` set paints the band's own frame; `DashboardHeader` puts
`data-force-theme="dark"` on its two content columns so everything inside
uses ordinary dark tokens (and band-only constants are `--adh-*`, §18.5).
`band-bg` (shorthand), `band-edge`, `band-shadow`, `band-text`
(`#e8eef9`), `band-text-strong` (`#fff`), `band-text-soft` (`#b4c2d9`),
`band-text-dim` (`#93a4c0`), `band-line` / `band-tint` (white 10 % / 5 %),
`band-accent` (azure-bright). Text tokens are equal in both themes.

**Charts** (screen; the Reporting PDF keeps print hex — §18.3). TS: `CHART.*`.

| Token | Use | Light | Dark |
|---|---|---|---|
| `chart-1` | primary series | brand-azure | brand-azure-bright |
| `chart-2` | secondary series | brand-cobalt | `#a3c2ff` |
| `chart-3` | tertiary (dashed) | brand-azure-bright | brand-azure |
| `chart-neutral` | "didn't happen" (missed calls) | `#c3cede` | `#56647e` |
| `chart-grid` / `chart-axis` | gridlines / baseline + axis | ink 7 % / 16 % | cloud 10 % / 28 % |
| `chart-label` / `-strong` | tick labels / hovered label | `#5d6f8c` / `#0e1726` | `#97a8c6` / `#f2f6ff` |
| `chart-hover-band` | hovered-bucket band | azure 7 % | azure-bright 10 % |
| `chart-tooltip-bg` / `-border` / `-text` | tooltip card | `#fff` / `#e2e8f2` / ink | `#151f33` / cloud 22 % / `#f2f6ff` |

**Document chrome:** `selection-bg` / `selection-fg`, `scrollbar` /
`scrollbar-hover` (global rules in index.css).

**Sidebar (`--t-sb-*`)** — light: white panel; dark: the original shell.

| Token(s) | Use | Light | Dark |
|---|---|---|---|
| `sb-bg` / `sb-bg-solid` | panel (shorthand) / mobile topbar | `#fff` / `#fff` | `#0c0e16→#0a0c13` / `#0a0c12` |
| `sb-border` / `sb-divider` | right edge / zone hairlines | `#e2e8f2` | `rgba(42,47,69,.7)` / `.8` |
| `sb-glow` | brand-area radial | azure 6 % | azure 10 % |
| `sb-wordmark` / `-dim` | "CRAG" / "GRANITE" | ink / `#5d6f8c` | `#f2f6ff` / `#97a8c6` |
| `sb-mark-glow` | `filter` on the cube mark | soft drop shadow | azure glow |
| `sb-text` / `-hover` / `-active` | nav row label | `#46566f` / ink / ink | `#74839b` / `#b4c2d9` / `#f1f5f9` |
| `sb-hover` | neutral hover wash | ink 4 % | white 6 % |
| `sb-icon*` | resting icon swatch (+ `-bg`, `-border`, `-hover`, `-bg-hover`, `-border-hover`) | paper swatch, `#5d6f8c` glyph | white 4 %/6 %, `#64748b` glyph |
| `sb-head` / `-head-hover` / `sb-subhead` | group headers / "Support" sub-label | `#5d6f8c` / ink / `#8b99b0` | `#6e7d95` / `#b4c2d9` / `#56647b` |
| `sb-muted*`, `sb-pill-*` | Coming Soon rows, header, "Soon" pill (≥ 3:1 by design) | `#7d8ba3` family | `#56647b` family |
| `sb-accent-azure` / `-green` / `-amber` | per-row product accent (`--sb-accent`) | azure / `#15803d` / `#b45309` | azure / `#22c55e` / `#fbbf24` |
| `sb-card-*`, `sb-name`, `sb-meta`, `sb-avatar-*` | user footer | `#f7f9fc` card, ink name | white 2 % card, `#a3b0c4` name |
| `sb-btn-border` / `sb-btn-icon` | footer actions (theme switch, Sign out) + topbar icon buttons | `#e2e8f2` / `#5d6f8c` | `rgba(42,47,69,.55)` / `#74839b` |
| `sb-scrollbar`, `sb-field-*` | nav scrollbar; sidebar sign-in form | daylight | original dark |
| `sb-banner-*` | amber customer-view banner, View-as "ON", preview picker (`cvp--dark`) | `#fff6e5` bg, `#92400e` text | amber 12 % bg, `#f59e0b` text |

The dark sidebar keeps today's background, border and accents exactly; only
label colours that failed AA were lifted (rows `#64748b→#74839b`, headers
`#475569→#6e7d95`, Coming Soon `#3f4b5e→#56647b`, footer meta
`#334155→#6e7d95`).

### 18.3 Rules for page authors

1. **No colour literals** — no `#hex`, `rgb()/rgba()`, `hsl()` or Tailwind
   palette colours in page CSS or TSX. Use `--t-*` tokens (CSS) or `T.*`,
   `TONE.*`, `CHART.*`, `tMix()` (TSX, from `styles/theme.ts`).
2. **Page-scoped tokens are allowed** in page CSS (`--ad-*`, `--vm-*`… —
   the full list is §18.5) but must resolve in BOTH themes. Prefer aliasing
   a theme token (`--ad-slate: var(--t-text-faint);`). If a page truly
   needs its own colour, its LIGHT value may be a literal (the old daylight
   value, kept for pixel parity) and its DARK value must point at a token.
   Preferred shape — the one `--dl-*`, `--cq-*`, `--ts-*`, `--rpt-*`,
   `--ladder-*`, `--ad-*` and `--rcfd-*` use:
   ```css
   :root,
   [data-force-theme='light'] { --x-ring: #c3d0e4; }          /* light value */
   :root[data-theme='dark'],
   [data-force-theme='dark']  { --x-ring: var(--t-line-strong); }
   ```
   Declared on `:root`, the token also reaches portals and modals that sit
   outside the page scope, and it follows a `data-force-theme` pin. The
   shorter scope-keyed form (`.x-scope { … }` + `:root[data-theme='dark']
   .x-scope { … }`, used by `--vm-*` and `--dlx-*`) is fine for content that
   is never pinned — it does NOT follow `data-force-theme` (§18.7).
   A colour more than one page needs belongs in `styles/theme.css` (or the
   `--dl-*` palette) — add it to BOTH blocks, to `THEME_TOKENS` in
   `styles/theme.ts` when it is a `--t-*` token, and to the tables here;
   `node scripts/check-theme-tokens.mjs` must pass.
3. **`--rcf-*` still works** — `.rcf-scope`/`.dl-scope` declare them as
   aliases (`--rcf-ink` → `--t-text`, `--rcf-card` → `--t-surface`,
   `--rcf-azure` → `--t-accent`, `--rcf-azure-deep` → `--t-accent-text`,
   …), so those uses flip already. Prefer `--t-*` in new code.
   **`--rcf-azure-deep` is now accent TEXT** (azure-bright on dark): a fill
   that carries white text must use `--t-accent-hover` instead.
4. **Status colours:** `--t-{ok,warn,danger,info,neutral}-{fg,bg,border,solid}`
   (TS `TONE`). A pill = `fg` on `bg` with a `border`; a dot/bar = `solid`.
   Grade logic stays in `quality.ts`; only its colour constants move to
   tokens (keep its hex for the PDF — rule 8).
5. **Charts and SVG:** series from `CHART.*` / `--t-chart-*`; gridlines,
   axes, labels, hover band and tooltip from the chart tokens. **Paint SVG
   through `style`** (`<rect style={{ fill: CHART.primary }} />`) or
   `currentColor` — not the `fill=`/`stroke=` attributes, which do not
   reliably resolve `var()`. Never dim a series below 3:1 against the panel.
6. **Modals, portals, overlays:** tokens live on `<html>`, so a portal needs
   no scope class for colour. Backdrop `--t-scrim`; panel
   `--t-surface-raised` + 1px `--t-line` + `--t-shadow-modal`; optional
   `--t-keyline` on the top edge. (A portal root may still carry
   `.rcf-scope`/`.dl-scope` for the daylight *primitives*' class rules.)
7. **Images and logos:** use transparent assets (`/crag-mark.*` — never the
   dark-square `/crag.png` on a surface). Raster art that only works on one
   ground needs a theme-aware swap or a token-coloured plate behind it.
   Inline SVG icons use `currentColor`.
8. **The Reporting PDF stays light** — `ReportPdfDocument` (@react-pdf) is
   print: it keeps its own hex palette (`INK`, `LINE`… in the file) and the
   print twins `GRADE_TONE_PRINT` (`reportFormat.ts`) / `QUALITY_PRINT_HEX`
   (`quality.ts`); `styles/brand.ts` hex is the same kind of constant.
   Never feed it `var()` strings (react-pdf can't resolve them). Same for
   anything rendered to a file or `<canvas>` — resolve with
   `useResolvedToken()` / `readToken()` first.
9. **Focus rings:** `outline: 2px solid var(--t-focus); outline-offset: 2px`
   (the global `:focus-visible` already does this); fields add
   `box-shadow: var(--t-focus-halo)`. Never remove a ring without a visible
   replacement.
10. **Contrast targets:** WCAG AA — 4.5:1 for body/label text, 3:1 for large
    text, UI component boundaries, icons and chart marks — in BOTH themes.
    Measured on `surface`: light text/soft/dim 18.0/7.4/5.1, dark
    16.6/11.9/7.5; accent-text 5.4 (L) / 5.9 (D); status fg ≥ 5.0 (L) /
    ≥ 6.5 (D). Known, kept-as-is light values: `text-faint` 2.9:1 and
    `field-placeholder` 2.4:1 (decorative/hint only — never the only carrier
    of information), light ok/warn pills 4.4–4.5:1 (keep pill text ≥ 600),
    light `chart-neutral` 1.6:1 (the de-emphasised "missed" series — pair it
    with a legend + value labels).
11. **Fonts are not theme-dependent**; neither is layout. Don't fork
    markup per theme — a component reads `useTheme()` only for things CSS
    can't express (e.g. which icon a toggle shows).
12. **Elevation recipe (dark = the landing's panels):** canvas
    `--t-canvas-bg` → panel `background: var(--t-panel-bg); border: 1px
    solid var(--t-line); box-shadow: var(--t-shadow-card)` → hover
    `border-color: var(--t-accent-border); box-shadow:
    var(--t-shadow-card-hover)` → raised `--t-surface-raised` +
    `--t-shadow-pop`. Primary actions use the `--brand-btn-*` recipe (same in
    both themes); add `var(--t-glow)` for the dark bloom.

**Legacy decisions (already done in the foundation):**
- Tailwind `@theme` `--color-*` / `--shadow*` are now `@theme inline`
  aliases of `--t-*` (`bg-surface`, `text-muted`… flip with the theme;
  nothing in `src/` uses them). Don't add hex there.
- The old `glass-*` classes (`.glass-surface`, `.glass-hover`,
  `.glass-header`, `.glass-row-hover`), `.form-control` and `.toggle` are
  theme panels/fields now (landing panel recipe, no backdrop blur).
- `styles/brand.ts` hex (`BRAND_*`, `brandAzureAlpha`, `CHART_SERIES`) is
  print/theme-less only; screen code uses `T` / `tMix` / `CHART`.
- The global `input[type=date…] { color-scheme: dark }` rule is gone —
  date pickers follow `<html>`'s color-scheme.

### 18.4 Checklists

**Converting a CSS file**
1. Replace every `--rcf-*` with its `--t-*` equivalent (rule 3) — optional
   but preferred; mandatory for `--rcf-azure-deep` used as a fill.
2. Map each literal to a token: paper → `canvas`, white card → `surface`
   (or `panel-bg` for a full panel background), `#f7f9fc`-ish fills →
   `tint`, hovers → `tint-hover`/`hover`, `#e2e8f2`/`#edf1f7`/`#cdd8e8` →
   `line`/`line-soft`/`line-strong`, ink ramp → `text`/`-soft`/`-dim`/
   `-faint`, azure washes → `accent-tint`/`accent-wash`/`accent-border` or
   `color-mix(in srgb, var(--t-accent) N%, transparent)`, status triples →
   `--t-<tone>-*`, shadows → `shadow-*`, input colours → `field-*`, modal
   backdrops → `scrim`, granite header → `band-*`.
3. Page-scoped colour variables: alias a `--t-*` token, or define both
   themes (rule 2).
4. Hard-coded white text on azure → `text-on-accent`; `#fff` backgrounds
   that are really "card" → `surface`.
5. `node scripts/check-theme-tokens.mjs --literals <file>` → zero left, or
   only the §18.8 exception kinds (a light-value page-token definition gets
   its dark twin and a comment). The scan strips comments first, so prose
   like "React #310" is ignored, and it does catch all-digit hex
   (`#475569`). Whole tree: `node scripts/check-theme-tokens.mjs --literals
   $(find src -name '*.css' -o -name '*.ts' -o -name '*.tsx')`.
6. Look at the page in BOTH themes (screenshot harness or `npm run dev` +
   the sidebar toggle); check hover, focus, empty/error/loading states, a
   modal, and a 390px width.

**Converting a TSX file**
1. `import { T, TONE, CHART, tMix } from '…/styles/theme'`.
2. Inline colours → `T.*` (`color: T.textDim`); alpha suffixes
   (`${hex}22`) → `tMix(token, pct)`; status triples → `TONE.<tone>`.
3. SVG: move `fill`/`stroke` to `style` or use `currentColor` (rule 5).
4. Local palette modules export `var()` strings for screen use (all
   converted: `pages/rcf/theme.ts` `INK`… + `DL`, `docs/tokens.ts` `C`,
   `sip-ladder/sipLadderUtils.ts` `LADDER_COLORS`,
   `stir/attestationColors.ts` `ATTEST_TONES`, `rcf/callOutcome.ts`,
   `calls/quality.ts`, `reporting/reportFormat.ts`); a separate hex export
   exists only where print/PDF needs it (`QUALITY_PRINT_HEX`,
   `GRADE_TONE_PRINT`). Reuse these before adding a new palette.
5. `onMouseEnter`/`onMouseLeave` colour hacks → a CSS `:hover` rule or
   Tailwind `hover:text-[color:var(--t-text)]`.
6. Need a resolved value (canvas, colour maths)? `useResolvedToken(name)`.
7. `npx tsc -p tsconfig.app.json --noEmit`, `npx eslint <files>`, the
   `--literals` scan, then both themes visually.

### 18.5 Page-scoped palettes (what the page conversions built)

Every page token below is defined for BOTH themes (light = the exact old
daylight value; dark = a `--t-*` token or a recipe of them). Use the
existing name before inventing one.

| Family | Where | What it carries |
|---|---|---|
| `--dl-*` | `index.css` — the **DAYLIGHT PAGE PALETTE** block (on `:root` + `[data-force-theme]`) | The daylight console's own greys/washes/shadows that no `--t-*` token carries exactly: `slate-soft`/`-mute`, `ctl-border`(`-hover`), `field-hover`, `rule`, `th-hover`, `well`(`-soft`), `icon-wash`(`-strong`/`-mute`), `note-wash`, `btn-disabled`(`-fg`/`-ring`), `ghost-hover-bg/-border`, `panel-border-hover`, `switch-track/-border`, `amber`, `warn-ink`, `sky`(`-solid`), `select-chevron`, the panel/pop/tip/dialog/detail shadows, `dialog-scrim`(`-strong`), `tab-hover-from/-to`, `detail-line`. Used by the shared `dl-*`/`rcf-*` primitives, account-dashboard.css and rcf-dashboard.css. |
| `DL` (TS) | `pages/rcf/theme.ts` | Typed `var(--dl-*)` strings for TSX (`DL.slateSoft`, `DL.rule`, `DL.iconWash`, `DL.sky`…) next to `INK`/`INK_SOFT`/`INK_DIM`/`INK_FAINT`/`AZURE`/`AZURE_DEEP`/`GREEN`/`RED` — TSX never spells a raw custom property. |
| `--ad-*` | `account-dashboard.css` | Scope aliases on `.ad-scope` (`--ad-slate`, `--ad-shadow`…) + `:root` page tokens: card/KPI/action gradients (`--ad-card-bg`, `--ad-kpi-bg`, `--ad-action-hover-bg`), bar tops, search well, selected row. |
| `--adh-*` | `account-dashboard.css` (`.ad-header`) | Granite-band constants (live dot, inset shade, the three radial glows, active product pill). Theme-INDEPENDENT on purpose — the band is dark in both themes. |
| `--rcfd-*` | `rcf-dashboard.css` | Board/overlay elevation, open-route wash, paused-status bg, overlay scrim + shadow, search well, filament tail. |
| `--cq-*` | `dl-platform-b.css` (Calls & Quality; also read by Reporting) | Ghost/note/link-off greys, control borders, ghost hover, amber ink, card/strip/seg/pop/modal shadows, scrim, KPI tile bg, and the dark-only keyline switch (`--cq-keyline-content`, `--cq-strip-position`). |
| `--ts-*` (+ `--dlx5-accent*`) | `dl-troubleshoot.css` | Troubleshooting: ghost greys, control borders, ghost hover, seg shadow, scrim, cobalt accent wash, the CallTraceModal lift (`--ts-modal-shadow`). |
| `--rpt-*` | `dl-reporting.css`, `dl-trend-chart.css` | Skeleton highlight, popover shadow, the trend chart's tick + grid ink (`--rpt-chart-tick`/`-grid`, painted via `style`). |
| `--qtc-tip-shadow` | `dl-trend-chart.css` | The chart tooltip's lift. |
| `--ladder-*` | `components/sip-ladder/sipLadder.css` | BYE + loopback arrow hues, card + panel shadows (read by `LADDER_COLORS`). |
| `--vm-*` | `dl-voicemail.css`, on `.vm-scope` (page root AND the `VmDialog` portal root) | Voicemail roles (select tint, amber, labels, thumb, dialog bg, player line/bg, danger fill/glow, elevation, scrim) + light-only shades re-pointed in the DARK block `:root[data-theme='dark'] .vm-scope`. |
| `--ivr-*` | `ivr.css` (on `:root` + `[data-force-theme]`) | One hue per IVR block (`--ivr-entry|play|menu|schedule|condition|dial|voicemail|goto|hangup`) and its text ink (`--ivr-<type>-ink`), canvas ground/dots, edge colours, keycap face/edge, `--ivr-key-on`. ALL aliases of `--t-*` tokens (voicemail = a `color-mix()` of violet + red), so there are no literals; dark marks ≥ 3:1, inks ≥ 4.5:1 in both themes. The MiniMap reads the same hues RESOLVED (`flow/canvas/useBlockHues.ts`). |
| `--dlx-*` | `dl-docs.css` (`.dlx-docs`: inline-code chip, admin tag line, warn ink; `.dlx-code`: the code theme), `dl-portal-pages.css` (`.dlx-trunks`: warn ink, disabled-DID dot) | Docs / code blocks / SIP Trunking page roles. The `--dlx-code-*` syntax colours are a code theme, the SAME in both themes (§18.8). |

**Consolidation candidate:** `--cq-*` and `--ts-*` duplicate `--dl-*`
value for value in BOTH themes — `#b6c2d4` (`--cq-ghost` = `--ts-ghost` =
`--dl-slate-soft`), `#d5deeb` / `#b7c7dd` (`--cq-`/`--ts-ctl-border(-hover)`
= `--dl-ctl-border(-hover)`), `#f2f6fc` / `#b5c4da` (`--cq-`/`--ts-ghost-hover-bg/-border`
= `--dl-ghost-hover-bg/-border`), `#92400e` (`--cq-amber-ink` = `--dl-warn-ink`,
also `--dlx-warn-ink`), with the same dark twins — so they could alias the
`--dl-*` names later with no visual change in either theme. A few others
share only the LIGHT value and chose a different dark twin
(`--dlx-dot-off` vs `--dl-slate-soft`, `--dlx-ic-bg` / `--vm-seg-bg` vs
`--dl-icon-wash-mute`, `--vm-iconbtn-hover-line` vs `--dl-field-hover`):
aliasing those would change dark slightly.

### 18.6 Shared opt-in modifiers and dialog classes (index.css)

- **`.dl-tabs-scroll`** (on a `.dl-tabs` rail): below 1024px the rail
  scrolls sideways inside itself instead of pushing the page wider; auto
  margins keep the tabs centred while they fit and never cut off the first
  one; the baseline becomes an inset shadow. Wide screens keep the plain
  rail on purpose (§18.7).
- **`.dl-metrics-wrap`** (on a `.dl-metrics` row): header metrics wrap
  instead of overflowing; a two-up grid below 560px.
  Both render exactly like the plain primitive where everything fits; opt
  in per page (MyAccountPage uses both).
- **`.rcf-dialog`** (+ `.rcf-dialog-strong`, `.rcf-dialog-scrim`,
  `.rcf-dialog-scrim-strong`): the DID-management confirmation dialogs — a
  raised card with the azure top edge over a dimmed page; `-strong` is the
  release dialog's heavier scrim + shadow.
- **`.rcf-didpick-*`** (`-menu`, `-opt`, `-opt-on`, `-opt-all`, `-clear`):
  the Call Activity DID picker popover (`ActivityDidPicker`) — raised menu,
  tint-on-hover options, a faint azure wash on the selected one.

### 18.7 Rendering gotchas (learned while keeping light pixel-identical)

- **A `color-mix()` stop inside a gradient changes Chrome's gradient
  interpolation** (it switches to float maths) and shifts the pixels by a
  level. Keep gradient stops as plain colours (`rgba()` light values, or a
  token that resolves to a plain colour); `color-mix()` is fine for flat
  fills, borders and shadows.
- **An `overflow: auto` scroller changes how Chrome rasterises the whole
  page**, so adding one can move pixels far from it. That is why
  `.dl-tabs-scroll` only scrolls below 1024px.
- **A visually-hidden `position: absolute` element inside a horizontal
  scroller needs a positioned ancestor** — otherwise it sits at its static
  x far past the viewport and widens the document. `.dlx4-tablewrap` /
  `.dlx5-tablewrap { position: relative }` fixed Reporting and
  Troubleshooting scrolling sideways at 390px.
- **Page tokens keyed on `:root[data-theme]` ignore `data-force-theme`
  pins.** `:root[data-theme='dark'] .vm-scope` (and the `.dlx-*` blocks)
  only look at `<html>`; a pinned subtree keeps the outer theme's values.
  Use the `:root, [data-force-theme=…]` shape of §18.3 rule 2 for anything
  that may sit under a pin.
- **Native range thumbs** paint on their own path: a `color-mix()` shadow
  there lands a few levels off at the anti-aliased edge, so
  `--vm-shadow-thumb` keeps a legacy `rgba()` on light.

### 18.8 Remaining colour literals — the allowed exceptions

`node scripts/check-theme-tokens.mjs --literals` over all of `src/` lists
only these kinds (anything else is a bug):
- **Theme and brand sources:** `styles/theme.css` (every token's values),
  the `:root` brand block in `index.css`, `styles/brand.ts`.
- **Light-value definitions of page tokens** (§18.5), each with a dark
  twin: `index.css` `--dl-*`, `account-dashboard.css`, `rcf-dashboard.css`,
  `dl-platform-b.css`, `dl-troubleshoot.css`, `dl-reporting.css`,
  `dl-voicemail.css`, `dl-portal-pages.css`, `dl-docs.css`,
  `sip-ladder/sipLadder.css`; plus the theme-independent `--adh-*` band
  constants.
- **Print / PDF hex:** `ReportPdfDocument.tsx`, `GRADE_TONE_PRINT`
  (`reportFormat.ts`), `QUALITY_PRINT_HEX` (`quality.ts`).
- **The code theme:** `--dlx-code-*` syntax colours (`dl-docs.css`).
- **The landing** (always dark, its own palette): `styles/landing.css`,
  `components/layout/HaArchitectureViz.tsx` (and `pages/DashboardPage.tsx`).
- **Not rendered, not converted** (convert before reviving any of them):
  `pages/TrunkCard.tsx`, `pages/ApiDidCard.tsx`,
  `components/AdminCustomerSelector.tsx`, the orphaned `pages/LoginPage.tsx`
  + `components/layout/AnimatedGridBackground.tsx`, and the unimported
  `styles/onboarding-brief.css` / `styles/dl-customer360.css`;
  `styles/dl-api-calling.css` belongs to the retired `ApiDidsPage`
  (unreachable while `API_CALLING_ENABLED` is false).

---

## 19. Visual IVR (`/ivr`)

Contract: `docs/IVR_INTERFACES.md` (§2 the draft graph, §8.2 the API this
page consumes); plan `docs/IVR_PRODUCT_PLAN.md` §6. **The server compiles.**
The browser edits the §2 graph and sends only that (autosave) and
`{ revision }` (publish); its own compile is a mirror for instant
validation and the "what callers hear" preview, never sent (plan D2).

### Files

| Where | What |
|---|---|
| `pages/IvrPage.tsx` | Route entry (lazy, full-bleed OUTSIDE AppLayout with its own `Sidebar` + `SidebarCollapseTab`, like Troubleshooting; `.dl-scope.ivr-canvas`). Picks the persona and provides `IvrWorkspaceContext`; inner routes `/ivr` and `/ivr/flows/:id` (the builder is a second lazy chunk, `flow/FlowBuilderRoute`). **Focus mode:** inside the builder the app sidebar starts collapsed — session-only state, the saved `sidebar_collapsed` preference is never touched. |
| `pages/ivr/IvrContext.ts` | `{ scope, viewer: tenant\|preview\|admin, staff, canEdit, customerName, href() }` — no IVR component reads `user` / `effectiveCustomer` itself. `href()` keeps the admin console's `?customer=`. |
| `pages/ivr/ivrData.ts` | Scope (tenant `self:<id>` / staff `c:<id>`, like voicemail), query keys `['ivr', key, …]`, hooks, and `readIvrError` / `ivrErrorText` (flattens `stale_revision` + `current_revision`, `invalid_flow` + `errors`, `prompt_in_use` + `flows`, `flow_in_use`, `ivr_not_enabled`, whether FastAPI puts them top-level or under `detail`). |
| `pages/ivr/IvrHome.tsx`, `IvrIntro.tsx`, `IvrDialogs.tsx`, `format.ts` | `/ivr`: not entitled → `IvrIntro`; entitled, no numbers → build now + "ask for a number"; else numbers (flow, live/not published, last publish; choose flow / rename), flows (status, used by, open, rename, delete → `flow_in_use`), messages. Layout below ("The /ivr page"). |
| `pages/ivr/prompts/` | `PromptManager` (play via a minted URL, rename, delete → `prompt_in_use` names the flows) and `PromptDialog` (Type text → voice + Preview (`tts-preview`, not stored) → save; Record / Upload through the SHARED voicemail capture `useAudioCapture` + `AudioCapturePanel` at **8 kHz** mono PCM16 → multipart upload with an additive `kind` field). |
| `flow/model/` (pure) | `blocks.ts` catalog + exits (§2 handles: `next`, `d:<key>`, `noInput`, `noMatch`, `open`, `closed`, `match`, `noAnswer`); `graph.ts` §2 ⇄ working graph (unknown fields kept in `keep*` and re-emitted; a Start is guaranteed and undeletable); `history.ts` undo; `layout.ts` Tidy up; `summary.ts` the wording. |
| `flow/compile/` (pure) | `ivr.ts` the compile mirror + `describePlan` (the transcript); `policy.ts` the US-only outside-number rule (mirror of the server's `services/ivr/policy.py`). |
| `flow/store/flowStore.ts` | ONE zustand store per mounted builder (created in `FlowBuilder`, keyed by flow id; the page is keyed by customer) — a customer switch or logout drops it. All graph edits go through `commit()` (history + `changeSeq` for autosave + `contentSeq` for analysis; pure moves don't bump `contentSeq`). |
| `flow/FlowBuilder.tsx`, `canvas/`, `panels/`, `config/` | The builder UI (below). |
| `flow/useAutosave.ts`, `useFlowAnalysis.ts` | Autosave under the revision lock; client mirror + debounced server `/validate`. |
| `styles/ivr.css`, `styles/ivr-builder.css` | Page + shared pieces / the builder (loaded with its chunk). Prefix `ivr-`. |
| `flow/assist/` | The Flow assistant (below): `model.ts` (pure: job parsing, §5.3 texts, placeholder substitution, accept planning, Tidy-up positions, New/Changed marks), `conversation.ts` (pure state machine), `guide.ts` (§6 wording, verbatim), `useFlowAssistant.ts` (the hook + `AssistProvider`), `useListen.ts`, `AssistPanel.tsx`, `KeywordGuide.tsx`, `ProposalBanner.tsx`. Styles `styles/ivr-assist.css` (prefixes `ivr-asst-`, `ivr-asg-`, `ivr-prop-`). |

### Personas

Tenant `user` edits; tenant `readonly` gets the same page and a VIEW-ONLY
builder (no palette, no publish, Outline tab first; test calls disabled —
`/simulate` is a POST). Admin in "View as Customer" works on the preview
customer as staff (`PreviewPrompt` until one is picked, same as voicemail).
Admin in normal view gets a console with a customer picker (`?customer=ID`)
— there is no "all customers" IVR view, because every §8.2 route needs a
customer (the API answers 400 `customer_id required`). Support → product home.

### The /ivr page (layout, §20)

- `CompactHeader` in one row: crumb (customer / IVR + amber Staff tag) ·
  IVR · the admin console's **Customer** picker inline (`.lk-head
  .ivr-scope-pick`) · stats IVR numbers | Flows | Live · **New flow**
  (writers; the page's primary action — the Flows card no longer has its
  own button).
- **Your IVR numbers | Flows** — ONE row of equal-height cards
  (`BalancedGrid`, stacks below 960px of content). Each row is two lines:
  number + name (or flow name + "Edited …") with the actions on the right,
  then the status word and the facts (answers with / used by, published,
  "Draft has unpublished changes"), wrapping when narrow. 6 rows, then
  "Show all N" opens the rest inside a capped scroll (`.lk-cap`, 400px).
  The numbers card's foot (`.ivr-card-foot`) says who assigns numbers and
  sits on the card's bottom edge.
- **Messages** (`PromptManager`) full width: one compact row per message
  (name; kind · length · date; the spoken text on ONE clamped line, full
  text in the tooltip/DOM) with the one-row player and actions on the
  right; the first 4, then "Show all N messages". Below 720px of content
  the player drops under the text.
- Breakpoints are container queries on `.ivr-sections` (`ivrpage`) and
  `.ivr-intro-host` (`ivrintro`), not the window. The shell ends 24px under
  the last card (`.dl-shell.ivr-shell`).

### The builder

- **Layout:** top bar (← IVR, name, live version, save state, undo / redo /
  Tidy up, Flow assistant (when available), Test call, History, Publish —
  below 1100 px the middle buttons go icon-only) · left Blocks | Outline · React
  Flow canvas · right settings panel or a sheet (Publish / Test call /
  History). Opens at a readable zoom anchored at Start when the whole flow
  wouldn't fit legibly (the MiniMap shows the rest); a saved viewport wins.
- **Panels (§20 — the canvas gets the room):** widths are
  `--ivr-left-w` / `--ivr-right-w` on `.ivr-work`. The LEFT panel folds
  (button beside the Blocks | Outline tabs) into a 56px rail of block icons
  — the SAME palette buttons (`Palette rail`: same drag / click-to-add,
  same accessible names, hint in the tooltip). The RIGHT panel can be made
  wider (`clamp(344px, 33vw, 480px)`) from any panel's head, and while it
  only shows the checklist it folds into a rail whose button carries the
  status (✓ or the error count). Selecting a block or opening a sheet
  always brings the panel back — "selecting a block opens its panel" is
  unchanged. The head controls are `PanelChromeButtons`
  (`flow/panels/panelChrome.ts` context, provided by `BuilderShell` on the
  desktop only — phone sheets have none), rendered in the `SideSheet` head
  and both Inspector heads. Choices are remembered in localStorage
  (`crag_open:ivr:blocks-panel`, `ivr:checklist`, `ivr:panel-wide` via the
  kit's `useOpenState`; a convenience only).
- **Keyboard:** blocks are focusable (Tab), Enter/Space selects — selecting
  a block opens its panel (click, keyboard, Outline or an issue link alike).
  Every exit has a "Where each choice goes" `<select>` (existing block,
  NEW block of any type, or nothing). ⌘Z / Ctrl+Z, ⇧⌘Z / Ctrl+Y, Esc
  deselects, Delete removes (never Start). Focus rings are restored on
  React Flow nodes.
- **Rules kept by the store:** one edge per exit; nothing into Start; no
  cycles (loops are Go to blocks — drawn as dashed return lines, compiled
  away); a removed menu key takes its edge; deleting a Go to's target
  clears it.
- **Validation:** the mirror on every content change; `POST /validate`
  2.5 s later; server findings win at the same block/exit. Publish is
  gated by the SERVER only.
- **Autosave:** 1.2 s after the last edit, `PUT {draft_graph, name?,
  revision}`; retries 2/5/15/30 s with "Save now"; 409 `stale_revision` →
  `ConflictDialog` (load the latest / keep mine at `current_revision`).
  `beforeunload` while anything is unsaved; leaving the builder flushes.
- **Publish panel:** saves, server-checks, shows errors (click → block),
  who hears it, changes since the live version, the transcript, then
  `POST /publish {revision}` (422 `invalid_flow` errors shown; 409 → conflict).
- **History:** View = the version read-only on the canvas (draft
  untouched); Restore = confirm → `…/restore {revision}` → loaded as an
  undoable edit. Nothing publishes.
- **Test call:** caller (number / withheld), time in the flow's time zone
  (first Business hours block), keys; `POST /simulate` with the CURRENT
  draft; steps one at a time, the canvas follows each step.
- **Transfer:** `TransferPicker` — the account's numbers from
  `GET /ivr/destinations`, grouped Call forwarding (RCF) / Voicemail /
  Other IVRs / SIP trunk with name + what it does, filter chips, search;
  this IVR's own numbers shown but disabled; or an outside US number
  checked as you type. Caller-ID choice, ring time, a visible "No answer
  or busy" exit. The Voicemail block picks from the voicemail group.
- **Phone width (< 768 px):** read-only diagram + the outline, "edit on a
  larger screen" — the Flow assistant still works there (full-screen sheet
  that steps aside when a proposal lands; the banner sits above the diagram). The canvas column never collapses to 0 px (React Flow
  warns while a window narrows into the phone view).

### Flow assistant (`docs/IVR_ASSIST_INTERFACES.md` §5–§7)

A customer describes a flow in plain English; the API returns a proposal
(it calls the separate AI step, aliases numbers first and compiles the
result itself); the builder draws it read-only; the customer accepts,
refines or discards it. **Nothing publishes.** The UI says "Flow
assistant" and never names a model or vendor.

- **Availability:** `summary.assist.available` (absent on an older API =
  hidden) AND the viewer can edit. Readonly users never see it; an admin in
  "View as Customer" with no pick still gets `PreviewPrompt` (no builder).
- **State:** `useFlowAssistant` is created once in `BuilderShell` and shared
  through `AssistProvider`, so closing the panel keeps the conversation, a
  running job and the proposal. `conversation.ts` is the state machine: one
  `conversation_id` per builder (sent with every later message); while a
  proposal is on the canvas the message box stays closed until Accept,
  Discard or **Refine** (the next message carries `refine_job_id`, no
  `draft_graph`); otherwise a message carries the in-memory draft. A newer
  proposal marks the older turn "Replaced"; a question or refusal leaves the
  proposal and Refine mode as they were.
- **Jobs:** POST → poll every 1.5 s, give up after 300 s; transient poll
  failures keep polling, 400/403/404 stop. Failed jobs show CRAG's own §5.3
  text for the code (never a server-passed message); start errors (403
  `ivr_assist_not_enabled`, 409 `assist_busy`, 429 `assist_rate_limited`
  with `retry_after_s`, 429 `assist_daily_limit`) have their own wording.
  `AssistAnnouncer` (a polite live region, keyed by `announceSeq`) is
  mounted whenever the assistant is available, so status is read out even
  with the panel closed.
- **Panel** (`AssistPanel`, a `SideSheet`; full screen + modal on a phone):
  intro, voice picker (`GET /ivr/voices`, the voice new messages are read in),
  "What can I say?" (`KeywordGuide`: the §6 table as phrase chips, the
  account's number names, the limits, three examples — a click fills the
  box), the transcript, the §6 disclosure verbatim above the message box
  (1–2000 chars, ⌘/Ctrl+Enter sends). Sending folds the guide away.
- **Proposal banner layout:** docked, it is capped at 48% of the canvas
  column (details scroll inside; Accept · Refine · Discard · Try a test call
  stay pinned underneath) and, from 680px of banner width (container
  `ivrprop`), the details sit in two balanced columns: what the flow does
  (summary, assumptions, still to fix, worth a look) beside the new
  messages with Listen. Layout only — the buttons, their order and their
  behaviour are unchanged.
- **Proposal on the canvas:** `store.showProposal()` — the store's
  `proposal` overlay (never the draft): Tidy-up positions, blocks revealed
  one at a time in calling order (`layout.callingOrder` = Tidy up's own walk;
  `revealNext()` on a ~2.4 s budget; at once under `prefers-reduced-motion`).
  Unrevealed blocks are laid out but invisible (`ivr-rf-pending`), so the
  first framing fits the whole flow. New messages (negative placeholder ids)
  are named on the blocks (`proposalPromptName`); blocks carry New / Changed
  marks vs the draft (`proposalChanges`). The canvas is `preview` mode; the
  palette, undo/redo/tidy (buttons and shortcuts), History and Publish are
  off; Test call tests the proposal. `ProposalBanner` is docked above the
  canvas (the canvas shrinks below it; it collapses, and does so by itself
  when a test call opens) or inline above the phone diagram: summary,
  assumptions, new messages with **Listen** (`tts-preview`, chosen voice,
  cached per voice+text), issues/warnings (click → centre the block),
  **Accept · Refine · Discard · Try a test call** (`SimulatorPanel` with a
  `target` → `simulate { assist_job_id }`, no `draft_graph`). The Outline
  follows any overlay (version or proposal).
- **Accept:** `createMissingPrompts` makes each new message the graph uses
  (`POST /ivr/prompts/tts`, chosen voice) one at a time, recording each real
  id at once; the first failure stops with the error and keeps the mapping,
  so "Try again" creates only what is missing. Then `acceptedGraph`
  (placeholders → real ids — a leftover placeholder throws, it can never be
  saved — plus Tidy-up positions, no viewport) → `store.replaceDraft()`: ONE
  undoable edit that autosave WRITES (changeSeq moves, savedSeq doesn't;
  unlike `load()`, which takes server content as already saved). Undo
  restores the previous draft (new messages stay in the account). Then
  `outcome: accepted` (fire-and-forget); a toast offers Undo while the accept
  is still the latest edit. **Discard** clears the overlay and posts
  `outcome: discarded`.

### Theming

React Flow `colorMode` follows `useTheme()`; every `--xy-*` variable is
mapped to a `--t-*` token in `ivr-builder.css`; the MiniMap gets RESOLVED
colours (`useBlockHues`, `useResolvedToken`). Block hues are the `--ivr-*`
palette (§18.5). `--literals` over `pages/ivr`, `flow`, `ivr*.css`: 0.

### Checks

`node scripts/run-ivr-tests.mjs` runs every builder self-test:
- Node suites (built-in type stripping, no bundler): the compile mirror's
  fixture tests (prompt order, Go to loops, removed keys, transfer policy,
  hours, transcript), the model (§2 round trip with unknown fields, undo
  coalescing, layout) and the Flow assistant's pure logic
  (`flow/assist/assist.assert.ts`: placeholder substitution, accept-retry
  mapping reuse, Tidy-up positions, calling order, job parsing + §5.3 texts,
  the conversation state machine; it also checks the guide's examples,
  disclosure and phrases against `docs/IVR_ASSIST_INTERFACES.md` word for
  word when the doc is in the checkout).
- A Vite-SSR pass for suites that import `.tsx` or the store
  (`flow/assist/assistUi.assert.ts`: the proposal overlay never touches the
  draft, the reveal steps, `replaceDraft` is one undoable dirty edit and
  undo restores the draft, `load()` is not dirty; the guide, panel and
  banner rendered to strings).

Visual: the theme harness with the §8.2 mock (2 IVR numbers, 3 flows incl.
one with errors and one that always 409s). The layout harness copy adds the
Flow assistant §5 mock (scripted provider) and the slugs `ivr*`,
`state-ivr-assist` / `-assist-proposal` / `-panels-folded` /
`-panel-wide` / `-menu-panel` / `-publish-errors` / … .

---

## 20. Layout — balanced, compact, expandable

Owner direction (2026-10): every signed-in page is **even and compact** —
a user sees everything that matters at a glance, and opens expandable areas
for more detail. This section governs **organisation only**: colours, type,
surfaces, radii and shadows stay exactly as §15/§18 define them. The kit is
structure; the page keeps its own surfaces (`.dl-panel`, the dashboard
`Card`, `components/ui` Card).

Pilots that follow it: Visual Voicemail (§17) and the dashboards (§7).
Screens: the visual harness (scratch) — `voicemail`, `state-vm-*`,
`dashboard*` slugs.

### 20.1 Page skeleton

```
.dl-scope (canvas) › shell
 1. Header ............ ONE row at desktop: <CompactHeader> (or the dashboard's granite band)
 2. Scope bar ......... optional, ONE slim row (≤ 56px): pickers + key facts (e.g. voicemail's mailbox bar)
 3. Tabs .............. optional rail (`dl-tabs`), margin-bottom 14px
 4. Body .............. rows of cards, each row ONE height (BalancedGrid / a page grid with kit classes)
                        OR a <MasterDetail> (list | open item), bounded to the first screen
 5. Secondary ......... expandable rows (<Disclosure>): rarely-changed settings, glossaries, staff blocks
```

Importance runs top to bottom. Nothing a user needs for the page's main task
sits below the fold.

### 20.2 Above the fold at 1440 × 900

- Header ≤ 110px tall (crumb, title + inline badges, ≤ 2-line subtitle on
  the left; tools · stats · primary action on the right, all one row).
  Scope bar ≤ 56px. Tabs ≤ 48px. A KPI row is ONE row (≤ 140px).
- The page's primary content must be visible without scrolling: the list
  and the open item (master–detail), the KPIs and the first card row
  (dashboards), the first rows of the main table.
- Primary actions must be visible without scrolling: the page's primary
  button, the open item's actions (pin them in the pane's footer), the Save
  of the main form.
- A MasterDetail page fits the screen exactly: the panes end 24px above the
  bottom edge and the page does not scroll (§20.8).

### 20.3 How tall a card may run

- Cards side by side are **one height** (grid stretch). Never a short card
  beside a tall one — if their natural heights differ by more than ~25 %,
  give the row a leader and make the others grow or follow:
  - **leader** — the card whose content sets the row height (usually the
    widest / most important: a table, the greeting card);
  - **`.lk-grow`** — absorbs spare height (a chart whose bars can grow; the
    last card of a stacked column);
  - **`.lk-follow`** — takes the row's height and scrolls inside (lists:
    team, requests, paused numbers). Never make every card of a row a
    follower — followers need a leader.
- A card body runs at most ~440px (`--lk-card-cap`) or **8 table rows**
  before it caps (`.lk-cap`, scroll inside) or collapses behind
  "Show all N" (`useShowMore`). Short lists: 4–6 items, then "Show all N".
  Inside a follower: every item, scrolling.
- "Show all" on a card beside other cards expands **inside a capped scroll**
  (sticky column heads), so the card never pushes its row taller
  (dashboard numbers / customers tables: `.ad-tablewrap-cap`).
- Put the Save button on the same line as short forms (fields + submit in
  one row, `align-items: flex-end`) rather than on a row of its own.

### 20.4 What collapses by default

| Content | How |
|---|---|
| Glossaries, "What does this mean?", "How is this worked out?" | `<Disclosure variant="bare">` (or `row`) |
| Tables beyond ~8 rows, lists beyond 4–6 items | `useShowMore` + `<ShowMoreButton>` ("Show all N …" / "Show less") |
| Long text (transcripts, notes, descriptions) | `<ClampText lines={4}>` ("Show full transcript") |
| Secondary metadata (ids, extra timestamps, technical fields) | a one-line inline meta row; the rest in `title` tooltips or a Disclosure |
| Rarely-changed settings (PIN, storage limits) | `<Disclosure variant="row">` with the current value as `summary` |
| Admin-only blocks (staff tools, suspend / delete) | `<Disclosure variant="row">` + the amber Staff tag as `badge`; destructive actions KEEP their typed confirmation dialog |

**Never collapse:** the page's primary content and action; errors, warnings
and "full" / "paused" states (show them in the row's `summary`, toned);
privacy or legal copy a contract or plan says to show (e.g. the
transcription disclosure, §17 / plan §11.4).

### 20.5 The kit — `src/components/layout/kit` (import from the barrel)

CSS: `src/styles/layout-kit.css` (`lk-`), loaded once in `main.tsx`. Every
colour is a `--t-*` token; nothing to add for dark mode.

| Primitive | Use | API |
|---|---|---|
| `<CompactHeader>` | The page header, one row at desktop | `crumb?`, `title`, `titleAside?` (badges inline with the h1), `subtitle?` (≤ 2 lines, clamped), `tools?` (scope pickers / filters), `stats?: {label, value, title?}[]` (a `<dl>`, figure over label, hairline dividers), `statsLabel?`, `actions?` (primary, last), `className?` |
| `<Disclosure>` | An expandable section: summary row → content | `title`, `summary?` (one line, open or closed), `count?`, `badge?`, `icon?`, `actions?` (on the row, OUTSIDE the toggle), `headingLevel?` (default 3), `variant?: 'card' \| 'row' \| 'bare'`, `defaultOpen?` / `open?` + `onOpenChange?`, `persistKey?` (`<page>:<section>`), `lazy?` (mount on first open), `className?`, `contentClassName?` |
| `useShowMore(items, limit, resetKey?)` + `<ShowMoreButton>` | First N rows, then expand | hook → `{ visible, expanded, needed, total, hiddenCount, toggle, setExpanded, listId, buttonProps }`; put `id={listId}` on the `<tbody>`/`<ul>`, render `<ShowMoreButton {...buttonProps} noun="numbers" />` only when `needed`. Button: `noun?`, `moreLabel?`, `lessLabel?`, `variant?: 'link' \| 'bar'`. A new `resetKey` (filter / search) collapses |
| `<ClampText>` | First lines of a long text | `lines?` (4), `moreLabel?`, `lessLabel?`, `className?` (the text), `wrapperClassName?` (the box — put padding/tint HERE, not on the clamped text). Toggle appears only when the text is really cut |
| `<BalancedGrid>` | Side-by-side cards, one height per row | `columns?` (grid-template-columns, default 2 equal), `stackBelow?: 'sm' \| 'md' \| 'lg'` (container 560 / 760 / 960px), `gap?`, `followMin?`, `label?`. Children are the cells: a card (stretches) or a `<div className="lk-col">` stacking cards |
| `.lk-col` · `.lk-grow` · `.lk-follow` · `.lk-cap` | Structure classes for any grid (page grids too) | `.lk-col` = a cell stacking cards (flex column, `--lk-gap`); `.lk-grow` = absorbs slack inside a `.lk-col`; `.lk-follow` = height follows the row (CSS `contain: var(--lk-follow)`, active only where a grid sets `--lk-follow: size`; floor `--lk-follow-min`), must be a flex column whose scrolling part has `min-height: 0`; `.lk-cap` = body capped at `--lk-cap` |
| `<ScrollArea>` (`.lk-scroll`) | The scrolling part of a bounded pane / follower | `label?` (→ region), `focusable?` (tab stop when it holds no focusable children), `maxHeight?` (`--lk-scroll-max`, for stacked layouts), `className?`, `id?` |
| `<MasterDetail>` | A list and the open item, equal-height panes bounded to the first screen | `list`, `detail`, `listLabel`, `detailLabel`, `listWidth?` (default `minmax(280px, 360px)`), `listClassName?` / `detailClassName?` (surfaces, e.g. `dl-panel`), `minHeight?` (460), `bottomGap?` (24). Each pane is a flex column: wrap the scrolling part in `<ScrollArea>`, keep tabs / toolbars / an action footer outside it |
| `useViewportFit(ref)` | Writes `--lk-md-top` (document offset, layout position — ignores entry-animation transforms) | used by MasterDetail; re-measures on resize and when anything above changes size |
| `useOpenState` / `readOpen` / `writeOpen` | Disclosure state + its optional memory | localStorage key `crag_open:<persistKey>`, every access try/catch'd; storage is a convenience only — the page renders the same without it |

Page grids that are not a `BalancedGrid` (the dashboard's 12-column
`.ad-grid`) opt in with the classes: set `--lk-follow: size` on the grid
where it is multi-column and `none` where it stacks (§20.6).

### 20.6 Responsive (1440 / 820 / 390)

All layout breakpoints are **container** queries on the kit's hosts (or the
page's own container), so they follow the space beside the 240px sidebar —
never viewport media queries, never Tailwind `md:*`.

| Width | Content column | Behaviour |
|---|---|---|
| 1440 × 900 | ~1100px | Multi-column rows, followers active, MasterDetail side by side and bounded to the screen, header one row, KPI rows of 6 |
| 820 × 1180 | ~520px (sidebar still shown) | `BalancedGrid` (md) stacks; MasterDetail stacks (list first, its ScrollArea capped at `min(50vh, 440px)`, detail at natural height, actions under it); CompactHeader's right side wraps under the title; the dashboard drops to 2 → 1 columns, `.ad-col` dissolves (`display: contents`, dense flow), followers go natural with a 420px cap |
| 390 × 844 | ~340px | One column everywhere; header tools / actions full width, stats spread across; KPIs 2-up; no horizontal page scroll (the harness's "layout warnings" must be empty) |

### 20.7 Accessibility

- **Disclosure** — a real `<button>` inside a heading (`headingLevel` keeps
  the outline right), `aria-expanded` + `aria-controls`; the content is a
  `role="region"` labelled by the button; closed content is
  `visibility: hidden` (not focusable, not read). Never put buttons or
  links inside the toggle — use `actions`.
- **ShowMoreButton** — `aria-expanded` + `aria-controls` = the list's id;
  "Show less" scrolls the button back into view.
- **ClampText** — the full text is always in the DOM (find, copy, screen
  readers); the toggle has `aria-expanded` / `aria-controls`.
- **ScrollArea** — a meaningful region gets `label`; one that may hold only
  text gets `focusable` (keyboard scrolling, WCAG 2.1.1).
- **MasterDetail** — two labelled sections, list before detail in the DOM;
  pinned action footers stay inside the detail section.
- **CompactHeader** — one `h1`; stats are a `<dl>` (read "Unread 5").
- Motion: only the disclosure height and chevrons animate, never under
  `prefers-reduced-motion`. Focus rings follow §18.3 rule 9.

### 20.8 Gotchas (learned in the pilots)

- **A MasterDetail page must end with it**, and the shell's bottom padding
  must equal `bottomGap` (voicemail: `.dl-shell.vm-shell { padding-bottom:
  24px }`). Otherwise the page scrolls by the difference — and the harness's
  full-page capture grows the viewport to the document height, which grows
  the panes with it (a screenshot taller than 900px means this).
- **Followers need a leader.** `contain: size` gives a follower no height of
  its own (only `--lk-follow-min`); a row of followers collapses to the
  floor. Turn followers off where the layout stacks (`--lk-follow: none`).
- **Nested auto-fit grids inside a Disclosure** used to overflow the row
  (an implicit `auto` grid column sizes to the content's min-content); the
  kit pins the disclosure's column to `minmax(0, 1fr)` — keep it.
- **Clamp padding:** padding on a `-webkit-line-clamp` element lets the next
  line peek out; pad the wrapper (`ClampText wrapperClassName`).
- **Class names:** kit classes are `lk-*`; page classes keep their page
  prefix. Check for an existing class before naming a new one (voicemail
  already had `.vm-more` for "Load more").
- Spans (`ad-span-*`) are ignored inside a flex `.lk-col` / `.ad-col` —
  put the span on the column, not on the cards in it.
- `useShowMore(items, Number.POSITIVE_INFINITY)` = "show everything" (a
  follower lists every item); `needed` is then false.

### 20.9 Roll-out checklist (per page)

1. Shoot the BEFORE (harness, 1440 dark + light) and note: header rows,
   short-beside-tall cards, columns that run long, page height.
2. Header → `<CompactHeader>` (or confirm the existing band is one row).
3. Scope / filter bars → one slim row.
4. Each row of cards: pick the leader; others `.lk-grow` / `.lk-follow`;
   cap bodies at 8 rows / ~440px; "Show all N" on long lists.
5. A list + item page → `<MasterDetail>`; pin the item's actions in its
   footer; end the page with it (§20.8).
6. Glossaries, rarely-changed settings, staff blocks → `<Disclosure>` with
   a `summary` of the current value; persist with `<page>:<section>` keys.
7. Every persona (tenant, readonly, admin console, admin `?customer=`,
   admin View as Customer) and every empty / loading / error state.
8. Harness at 1440×900, 820×1180, 390×844, dark + light: no layout
   warnings, no new console errors; `npm run build`, `npx eslint <files>`,
   `node scripts/check-theme-tokens.mjs`.
