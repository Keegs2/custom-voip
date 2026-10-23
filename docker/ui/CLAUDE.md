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
| Drag-and-drop | `@dnd-kit/core` + `@dnd-kit/sortable` (IVR builder only) |
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
  QueryClientProvider     (TanStack React Query)
    ToastProvider         (global toast notifications)
      App                 (BrowserRouter + AuthProvider + Routes)
```

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
/ivr                      IvrBuilderPage (placeholder)
/voicemail                VisualVoicemailPage (coming-soon preview)
/reporting                ReportingPage (lazy; RequireReportingAccess — rcf/trunk/hybrid + admin)
/docs/guides/:product?    GuidesPage        (/documentation, /docs/rcf redirect here)
/docs/api/:product?       ApiDocsPage       (/docs/integration redirects here)
/call-quality             CallsPage (tenant-reachable; cost/fleet UI hidden for non-staff)
/cdrs                     CallsPage (RequireSupportOrAdmin)   (/admin/platform/cdrs redirects here)
/my-account               MyAccountPage     (/account redirects here)

── full-screen, outside AppLayout, RequireAuth ──
/troubleshooting          TroubleshootingPage      (renders its own Sidebar)

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
| `cdrs.ts` | `/cdrs` | `searchCdrs`, `getCdr`, `rateCdr`, `getCdrSummary`, customer-scoped helpers |
| `rates.ts` | `/rates` | CRUD + `getMarginsData`, `lookupRate` |
| `ivr.ts` | `/ivr` | CRUD for IVR flows |
| `documents.ts` | `/documents` | folders CRUD, document upload/download/update/delete, stats |
| `sipp.ts` | `/sipp` | `listSippPresets`, `runSipp` |
| `health.ts` | `/health` | `getHealth`, `getDetailedHealth` |
| `homer.ts` | `/homer` | `searchSipTraces` — `POST /homer/search`, returns `{ data: HomerSearchResult[], correlations: Record<string, string[]> }`. Powers the Troubleshooting SIP-trace page. |
| `didInventory.ts` | `/dids` (inventory) | `listDidInventory`, `listAvailableDids`, `getDidStats`, `listMyDids`, `syncDidInventory`, `assignDid`, `unassignDid`, `requestDid` |
| `onboarding.ts` | `/onboarding` | `submitOnboardingRequest`, `listOnboardingRequests`, `getOnboardingRequest`, `verifyBilling`, `approveOnboarding`, `rejectOnboarding` |
| `sbc.ts` | (SBC stats) | `getSbcStats(minutes)` — per-SBC call distribution for the admin `SbcDistribution` panel |

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
['ivr-flows']
```

### Client state — React `useState` / `useReducer`

- **Form state:** local `useState` inside each page.
- **IVR builder:** `useReducer` in `src/pages/ivr/useIvrFlow.ts` — all mutations
  to the node tree go through typed `IvrAction` dispatches.
- **Sidebar group open/close:** `useState` + persisted to `localStorage` under
  key `sidebar_groups_open`.

### Global UI state — Contexts

| Context | File | Purpose |
|---|---|---|
| `AuthContext` | `src/contexts/AuthContext.tsx` | Auth state, login, logout |
| `ToastContext` | `src/components/ui/ToastContext.tsx` | Global toast notifications |

---

## 7. Pages

### Customer-facing pages (inside AppLayout)

**`DashboardPage`** (`/`)
Navigation hub. Static card grid linking to all product areas. No API calls.
API Calling copy + product card render only while `API_CALLING_ENABLED` (src/config/features.ts) is true — the product is retired (2026-09), so they are hidden.

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
  optional product switcher (`products.ts`: RCF live; SIP Trunking / Visual
  Voicemail dimmed "Soon", aria-disabled), a quiet glass secondary action and
  the azure-glow primary action. Also used by the admin `/rcf` console.
- `KpiCards` (`KpiRow`) — six cards. Account scope: Numbers · Forwarding
  (paused count) · Calls 7d · Answered · Sounded good (quality.ts tone + word)
  · Team. Platform scope (`scope="platform"`): Customers leads, Team dropped.
  3px tone edge, icon chip, 7-day sparklines; `numbersHref` (tenant `/rcf`,
  admin `/rcf?customer=…`), call cards open Call activity; Team links My
  account (tenant/preview) or nothing (admin).
- `NumbersCard` — small table (8 rows), search + All/Forwarding/Paused chips,
  row → shared `RowEditor` inline (`isAdmin` = admin fields such as max
  channels, admin dashboard only), "View all N numbers" → `allHref`.
- `CallCards` — Call volume (daily answered/missed bars), Call quality
  (good-share ring + one-way/poor/graded), Recent calls (last 6, outcome +
  quality words from `pages/rcf/callOutcome.ts`; optional Customer column via
  `customerNames`, names are buttons to that customer's dashboard), Busiest
  numbers. `CustomerName` is shared with the admin cards.
- `AccountCards` — Team (header link optional), Number requests (optional
  footer action; optional customer names), `QuickActionsCard` (renders a list
  built by `quickActions.tsx`: `customerQuickActions` — Request/Manage numbers →
  `DidManagement` overlay, Open call activity → `CallActivityTab` overlay,
  Download a report, Manage all numbers; `adminCustomerActions` /
  `adminPlatformActions` — see below).
- **Admin dashboard** (`AdminDashboard.tsx`, admin in normal view). Same look,
  "Viewing" dropdown in the header (All customers default | each call
  forwarding customer; a deep-linked customer of another type is added).
  Scope in the URL: `?customer=<id>`, absent = All customers (push history, so
  Back works; an unknown id → "We couldn't find customer #id"). Helpers in
  `adminLinks.ts` (`parseCustomerParam`, `dashboardHref`, `rcfConsoleHref`,
  `callsHref`, `reportingHref`, `READS_CUSTOMER_PARAM`).
  - **All customers** (`AdminOverview`): KPIs platform-wide (Customers ·
    Numbers · Forwarding/paused · Calls 7d · Answered · Sounded good); cards
    `CustomersCard` (name/since · type · status · numbers · paused; row →
    that customer; search + show-all above 8), Call volume, Call quality,
    Recent calls (+ Customer column), Number requests across customers
    (waiting approval / release pending — the admin's to-dos), `PausedCard`,
    `InventoryCard` (pool: available · assigned · call forwarding · waiting ·
    releasing), admin quick actions (Numbers console `/rcf?customer=all`, Call
    activity overlay for all customers, Calls & Quality, Reporting,
    Troubleshooting). `AdminCards.tsx`.
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
  `/cdrs` (recent). Staff number counts come from the /rcf list (100-row cap →
  "100+"). `useWeekActivity(null)` / `useRecentCalls(null)` = every customer.
- Admin data (`adminData.ts`, admin-only endpoints): customers
  `GET /customers?limit=500` (shared `['customers-dropdown']`, `select` maps to
  identity fields — no money); platform numbers + per-customer counts
  `GET /numbers/inventory?product_type=rcf&limit=1000` (statuses on an
  account; exact total, "1,000+" past one page); paused `GET /rcf?enabled=false`
  (server cap 100 → "+"); open requests `GET /numbers/inventory?status=reserved`
  + `?status=release_requested`; pool `GET /numbers/stats`. NOT available
  without a backend change: per-customer call counts and a cross-customer
  "busiest numbers" (no cross-customer per-number/per-customer roll-up).
- Styles `styles/account-dashboard.css` (`ad-`): 12-col card grid (8/4 spans) →
  2 cols → 1 col by CONTENT width (container queries); one load-in stagger;
  reduced motion respected. Brand blues via `--brand-*` tokens. No money
  anywhere.

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
preview customer (no page picker; the page is keyed on it).

**`TrunksPage`** (`/trunks`)
Currently a placeholder/coming-soon shell. Shows the page header but no data.
Full trunk management lives in `admin/TrunksAdminPage`.

**`ApiDidsPage`** (`/api-dids`)
API Calling showcase. **Retired 2026-09** — the page is kept in code but the route
redirects to the user's product home while `API_CALLING_ENABLED` is false.

**`IvrBuilderPage`** (`/ivr`)
Currently a placeholder/coming-soon shell. The IVR engine code
(`src/pages/ivr/`) is complete but the page wrapper shows "Phase 2".

**`RcfDocsPage`** (`/docs/rcf`) and **`ApiDocsPage`** (`/docs/api`)
Static inline documentation pages. No API calls. `/documentation` redirects to
`/docs/rcf`; `/docs/integration` redirects to `/docs/api`. Shared layout helpers
live in `pages/docs/shared.tsx`. There is no single `DocsPage`.

**`CallsPage`** (`/call-quality` and `/cdrs`, `pages/calls/`) — Calls & Quality
The merged CDR search + voice-quality page. Top composition (2026-10 rework):
- **Search row** (`CallsFilterBar`) — ONE centred row at ≥1366px: Customer
  (staff) · Trunk · Product · Direction · Dest. prefix · Time range (select;
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
- Records/Summary tabs (Summary = staff, tabular), paginated `CallsTable`,
  `CdrDetailModal` on row click. Page CSS: `cq-`/`cqf-`/`cqk-` classes in
  `styles/dl-platform-b.css`. Grades: see §16.

**`TroubleshootingPage`** (`/troubleshooting`)
Full-screen page (outside `AppLayout`, renders its own `Sidebar`). This is a
**native React SIP-trace search page** — there is no Homer iframe any more.

- A search form (From, To, Call-ID, date range) calls `searchSipTraces()`
  (`POST /api/homer/search` via `api/homer.ts`) using a React Query `useMutation`.
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
content area (max-width 1160px, centered). Background `#0f1117`.

**`Sidebar`**
Fixed left sidebar (collapsible on desktop via `SidebarCollapse`). Authenticated
order: **Dashboard (top-level item) → Products → Insights (Reporting) →
Administration/Support → Coming Soon**. **Dashboard** (`/dashboard`, normal live
active style) shows for platform admins (the admin dashboard) and every
non-support user with an `effectiveCustomer` (tenants, and an admin in
customer view once a preview is picked). Sidebar blues are the brand family
(`#2f7df6` accents, `#4f92ff` on dark, sign-in button `--brand-btn-*`). There is no
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

### Auth (`src/components/auth/`)

See section 4 above.

### UI primitives (`src/components/ui/`)

| Component | Props summary |
|---|---|
| `Button` | `variant: 'primary'\|'ghost'\|'danger'\|'success'`, `size: 'xs'\|'sm'\|'default'`, `loading: boolean`, `icon: ReactNode` |
| `Badge` | `variant: BadgeVariant` — covers status, account types, directions, traffic grades, SIPp verdicts |
| `Modal` | `open`, `onClose`, `title`, `children`, `footer`, `maxWidth`. Closes on Escape, traps body scroll |
| `FormField` | Polymorphic: `as: 'input'\|'select'\|'textarea'`. Renders label, field, hint, error. Passes all native HTML attributes through |
| `Card` / `CardTitle` | Dark glass-morphism card container |
| `StatCard` | Displays a single large metric with label and optional background icon |
| `TabBar` | Horizontal tab bar with underline active indicator, optional count badges |
| `Table` / `TableWrap` / `Thead` / `Th` / `Td` | Table primitives with dark theme styles |
| `Pagination` | "Showing X of Y" with "Load More" button (offset-based, not page-based) |
| `Spinner` | Animated SVG ring, sizes `xs` and `sm` |
| `Toast` / `ToastContext` | Toast system — `useToast()` returns `{ toastOk, toastErr }` |

**Using the toast system:**
```typescript
const { toastOk, toastErr } = useToast();
toastOk('Customer created');
toastErr(err.message);
```
Toasts auto-dismiss after 4 seconds. They stack in the bottom-right corner.

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
| `sipLadderUtils.ts` | `LADDER_COLORS` design tokens, `formatTimeDelta`, and related helpers. |
| `sipUtils.ts` | SIP parsing helpers (method/status extraction, leg detection, retransmission detection). |
| `index.ts` | Barrel export. |

Node names are pre-aliased by heplify-server (e.g. "BW-NY", "SBC-1", "FreeSWITCH"),
so no IP resolution happens in the frontend.

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

### `AdminCustomerSelector`

Dropdown that lets admins filter portal pages by customer. Only renders when
`isAdmin` is true. Loads up to 500 customers and can filter by `accountTypes`.
Currently imported nowhere (legacy dark style, brand accent `#2f7df6`). The
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
| `ivr.ts` | `IvrNode`, `IvrFlow`, `IvrFlowListItem`, `IvrFlowSave`, `IvrVerbType` |
| `tier.ts` | `Tier`, `CustomerTierResponse`, `TierType` |
| `health.ts` | `HealthCheck`, `DetailedHealth`, `ComponentHealth`, `HealthStatus` |
| `documents.ts` | `SharedDocument`, `DocumentFolder`, `DocumentStats`, `DocumentListResult`, `UploadProgress` |
| `sipp.ts` | `SippPreset`, `SippRunConfig`, `SippRunResponse`, `SippResults`, `SippVerdict` |
| `didInventory.ts` | `DidStatus`, `DidInventoryItem`, `DidStats`, `DidAssignRequest`, `DidInventoryListParams`, `DidInventoryListResponse`, `DidAvailableParams` |
| `onboarding.ts` | `OnboardingStatus`, `OnboardingRequest`, `DIDConfigEntry`, `OnboardingSubmitPayload`, `ApprovePayload`, `ApproveResponse` |

**`User.account_type`** controls what the authenticated user sees in the sidebar
and on their pages. It is a nullable union: `'rcf' | 'api' | 'trunk' | 'hybrid' | 'ucaas' | null`.

**`User.role`** controls admin access: `'admin' | 'user' | 'readonly'`.
`'readonly'` users see the Administration group in the sidebar but can only view
call quality and troubleshooting (no edit access).

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

The IVR builder (`src/pages/ivr/`) is fully implemented but the `IvrBuilderPage`
page wrapper currently shows a "Phase 2 / Coming Soon" placeholder.

### Architecture

```
IvrBuilderPage → useIvrFlow() (useReducer)
               → IvrTopbar    (save, load, new, name)
               → IvrPalette   (verb drag source)
               → IvrCanvas    (node tree render + drop targets)
               → IvrConfigPanel (selected node editor)
               → IvrXmlModal   (XML preview)
               → IvrLoadModal  (load existing flow)
```

### `BuilderNode` (internal type, extends `IvrNode`)

The API's `IvrNode.branches` is `Record<string, string>` (id references). The
builder extends this to `Record<string, BuilderNode[]>` (nested children) and adds
a `prompt: BuilderNode[]` array for Gather verbs and `_activeBranch: string | null`
for UI tab state.

### Reducer actions

All mutations dispatch typed `IvrAction` objects. Notable actions:
- `ADD_NODE` — deep-clones tree, splices new node at path/position
- `REMOVE_NODE` — deep-clones, removes by id
- `MOVE_NODE` — removes from source, inserts at target (adjusts index if same array)
- `UPDATE_CONFIG` — merges into `node.config`
- `ADD_BRANCH` / `REMOVE_BRANCH` / `SET_ACTIVE_BRANCH` — Gather verb branch management
- `LOAD_FLOW` — replaces entire state (used when loading a saved flow)

### XML generation

`nodesToXml()` and `generateXml()` in `ivrUtils.ts` produce TwiML-compatible XML.
Gather branch routing is emitted as XML comments (webhook callbacks handle routing).

---

## 12. RCF-V1 Product Scope

This is the RCF-V1 production architecture. Know what is and is not available:

### Fully implemented and deployed

- **RCF** (`account_type: 'rcf'`) — the primary product. Full CRUD, inline editing, bulk operations.
- **SIP Trunks** (`account_type: 'trunk'`) — full management in admin, customer portal is a placeholder.
- **Admin suite** — customers, trunks, CDRs, rates, tiers, carriers, SIPp, DID search, user lookup.
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
  "Coming Soon" item, My Account's API DID section/tiles, the IVR topbar DID fetch,
  the Guides + `/docs/api` "calling" sections (slug redirects to the hub default),
  the Calls "API" product filter, the onboarding API product option, and the landing
  page's API Calling copy. With the flag off nothing calls `/api-dids`. `productHome`
  sends `api` accounts to `/my-account`.
- **Hybrid** (`account_type: 'hybrid'`) now means **RCF + SIP Trunking** (no API
  section). Granite Telephony, the primary customer, is hybrid.
- **Payments Demo** — REMOVED 2026-09 (`pages/admin/payments-demo/*` incl.
  `X402Visualizer`, `styles/dl-payments.css`, its `/admin/payments-demo` route and
  sidebar item). There is no revup `/admin` UI left; admin lives in TED.
- **IVR Builder** — `IvrBuilderPage` is a placeholder. The IVR engine in `src/pages/ivr/`
  is complete code but not exposed to customers yet.
- **UCaaS** (`ucaas_enabled: true`) — `CustomerUcaasSection` provides extension/voicemail
  management for admin. The softphone widget (WebRTC/Verto) is referenced in nginx
  (`/ws/verto/` proxy) but the softphone component itself is not in this codebase.

### RCF customers specifically

RCF customers (`account_type: 'rcf'`) land on **Dashboard** (`/dashboard`, the
card overview — top-level sidebar item) and get RCF (`/rcf`, the full numbers
manager) under Products and Reporting under Insights. Coming Soon (darkened, last) lists SIP Trunking (NOT a link for them —
`linkAccountTypes` limits the link to admins and trunk/hybrid), Visual Voicemail,
Guides and API Reference. Products are filtered in `Sidebar.tsx` against
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

The codebase mixes Tailwind utility classes and inline styles. The pattern is:
- **Structural layout** (flex, grid, gap, margin, padding, min-height): Tailwind classes via `cn()`
- **Design tokens** (colours, shadows, borders): inline styles using CSS custom values

Colour palette used throughout:
```
Background:    #0f1117  (page)    #1a1d27 / #13151d  (surface)
Border:        rgba(42,47,69,0.6)
Text primary:  #e2e8f0
Text muted:    #718096 / #94a3b8
Text faint:    #475569 / #334155
Accent blue:   #3b82f6
Success green: #22c55e / #065f46
Warning amber: #f59e0b
Danger red:    #ef4444 / #7f1d1d
```

Active nav items use a coloured gradient background with a matching border and
glow shadow — each product has its own accent colour defined in `Sidebar.tsx`
(`#4ade80` for RCF, `#fbbf24` for trunks, `#c084fc` for API, `#22d3ee` for IVR).

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
