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
| Flow builder canvas | `@xyflow/react` (React Flow) + `@dagrejs/dagre` (auto-layout) + `zustand`/`zundo` (graph state + undo/redo) + `nanoid` — powers the Call Flow Builder (`src/flow/`). Replaced the old `@dnd-kit` IVR tree builder, which has been removed. |
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

── inside AppLayout + RequireAuth (auth required) ──
/rcf                      RcfPage
/api-dids                 ApiDidsPage
/trunks                   TrunksPage
/flows                    CallFlowBuilderPage      (Universal Call Flow Builder — wrapped in RequireAdmin)
/documentation            → redirect to /docs/rcf
/docs/rcf                 RcfDocsPage
/docs/api                 ApiDocsPage
/docs/integration         → redirect to /docs/api
/call-quality             CallQualityPage
/account                  AccountPage

  ── legacy redirects ──
  /admin/did-search       → redirect to /admin/platform/dids
  /admin/user             → redirect to /admin/customers/users
  /admin/user/:userId     → redirect to /admin/customers/users/:userId

  ── Customer Management shell: AdminPage (tab shell, RequireAdmin) ──
  /admin                          → redirect to /admin/customers (index)
  /admin/onboarding               OnboardingAdminPage
  /admin/customers                CustomersAdminPage
  /admin/customers/:customerId    CustomerAccountPage
  /admin/trunks                   TrunksAdminPage
  /admin/customers/users          UserDetailPage
  /admin/customers/users/:userId  UserDetailPage

  ── Platform Management shell: PlatformManagementPage (tab shell, RequireAdmin) ──
  /admin/platform                 → redirect to /admin/platform/carriers (index)
  /admin/platform/carriers        CarriersAdminPage
  /admin/platform/cdrs            CdrsAdminPage
  /admin/platform/rates           RatesAdminPage
  /admin/platform/tiers           TiersAdminPage
  /admin/platform/sipp            SippAdminPage
  /admin/platform/dids            DIDSearchPage

── full-screen, outside AppLayout, RequireAuth ──
/troubleshooting          TroubleshootingPage      (renders its own Sidebar)

*                         → redirect to /
```

**Key facts that bite:**
- The **homepage (`DashboardPage`) is PUBLIC** — it lives outside `RequireAuth`.
  Every other route requires authentication.
- `/login` now just **redirects to `/`**. `LoginPage.tsx` still exists in
  `src/pages/` but is **orphaned** — it is not referenced by any route. Login is
  handled inline (see Auth section). Do not assume a `/login` page renders.
- Admin is split into **two tab shells**: `AdminPage` at `/admin` (Customer
  Management — onboarding, customers, customer 360, customer trunks, user lookup)
  and `PlatformManagementPage` at `/admin/platform` (carriers, CDRs, rates, tiers,
  SIPp testing, DID search). Both wrap their children in `RequireAdmin`.
- There is **no `DocsPage`**. Docs are split into `docs/RcfDocsPage` and
  `docs/ApiDocsPage` (shared bits in `docs/shared.tsx`).
- `UserDetailRedirect` is a tiny helper component that forwards
  `/admin/user/:userId` to `/admin/customers/users/:userId`.

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
  isAdmin: boolean           // user.role === 'admin'
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

**Logout:** clears localStorage, nulls state, navigates to `/` (the public home).

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
| `callFlows.ts` | `/call-flows` | CRUD + `publishFlow`, `simulateFlow`, version history (`listFlowVersions`/`getFlowVersion`/`restoreFlowVersion`) for the generalized `call_flows` backend. The primary module behind the Call Flow Builder. |
| `ivr.ts` | `/ivr` | Read-only list/get of legacy `ivr_flows` rows — now used only by the builder's **Import IVR** action (`flow/compile/fromLegacyIvr.ts`) to convert an old flow onto the canvas. |
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
- **Call Flow Builder graph:** `zustand` store with `zundo` temporal middleware in
  `src/flow/store/flowStore.ts` — nodes/edges, selection, undo/redo, and `loadDoc()`.
  (The old `@dnd-kit` `useReducer` IVR tree builder was removed.)
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
Shows a "Phase 2" badge on API Calling (the customer-facing `ApiDidsPage` is still
a placeholder).

**`RcfPage`** (`/rcf`)
Lists RCF entries for the authenticated customer (or all customers for admin via
`AdminCustomerSelector`). Supports card and table view modes, sorting, pagination,
and inline `forward_to` editing. API: `GET /rcf`.

**`TrunksPage`** (`/trunks`)
Currently a placeholder/coming-soon shell. Shows the page header but no data.
Full trunk management lives in `admin/TrunksAdminPage`.

**`ApiDidsPage`** (`/api-dids`)
Currently a placeholder/coming-soon shell.

**`CallFlowBuilderPage`** (`/flows`, **admin-only — wrapped in `RequireAdmin`**)
The Universal Call Flow Builder: a React Flow node-graph editor that designs the
call-handling logic for ANY product (IVR / API / RCF / Conference / Trunk / UCaaS).
A product selector drives the node palette, the per-product compiler, and the
validation rules. Save creates/updates a `call_flows` row; Publish compiles to the
product's native sink (e.g. IVR→`ivr_flows.flow_config`, RCF→`rcf_numbers`,
UCaaS→`extensions.ring_plan`, Trunk→`trunk_dids.route_plan`) and snapshots a
version. Also offers **Simulate** (dry-run a caller/time against the flow) and
**version history** (view/restore). See §11 for internals. This replaced the old
`/ivr` page entirely.

**`RcfDocsPage`** (`/docs/rcf`) and **`ApiDocsPage`** (`/docs/api`)
Static inline documentation pages. No API calls. `/documentation` redirects to
`/docs/rcf`; `/docs/integration` redirects to `/docs/api`. Shared layout helpers
live in `pages/docs/shared.tsx`. There is no single `DocsPage`.

**`CallQualityPage`** (`/call-quality`)
Platform-wide SIP quality analysis. Sections: filter bar, stat cards (ASR, MOS,
packet loss, jitter, R-factor), trend charts, paginated CDR table, slide-out
call detail panel. APIs: `GET /cdrs`, `GET /customers`, `GET /trunks`.

**`TroubleshootingPage`** (`/troubleshooting`)
Full-screen page (outside `AppLayout`, renders its own `Sidebar`). This is a
**native React SIP-trace search page** — there is no Homer iframe any more.

- A search form (From, To, Call-ID, date range) calls `searchSipTraces()`
  (`POST /api/homer/search` via `api/homer.ts`) using a React Query `useMutation`.
- The returned `data` (flat `HomerSearchResult[]`) plus the `correlations` map
  (Call-ID → related Call-IDs) are grouped into per-call rows via an in-component
  **union-find** (`groupMessagesByCall`) so A-leg and B-leg messages merge into one
  call. Each group computes a representative message, final status, and duration.
- Results render as a table; expanding a row renders the custom **`<SipLadder>`**
  diagram (see Components → SIP Ladder) for that call's messages.
- Each row also offers an "Open in Grafana" deep link (`/grafana/d/sip-search/...`)
  scoped to the call's correlated Call-IDs, and the header has an "Open SIP
  Dashboard" link to `/grafana/`.

**`AccountPage`** (`/account`)
Profile page. Lets users update their display name and password via
`PATCH /api/auth/me` (calls `apiRequest('PATCH', '/auth/me', ...)`).
Calls `refreshUser()` from `AuthContext` on success.

### Admin pages (require `RequireAdmin`)

Admin is split into **two tab shells**, each a tab bar + `<Outlet />`:

**`AdminPage`** (`/admin`) — **Customer Management** shell.
Tabs: Onboarding, Customers, Customer Trunks, User Lookup. Index redirects to
`/admin/customers`. Children: `OnboardingAdminPage`, `CustomersAdminPage`,
`CustomerAccountPage` (`customers/:customerId`), `TrunksAdminPage`, `UserDetailPage`
(`customers/users` and `customers/users/:userId`).

**`PlatformManagementPage`** (`/admin/platform`) — **Platform Management** shell.
Tabs: Carrier Trunks, CDRs, Rates, Tiers, Testing, DID Search. Index redirects to
`/admin/platform/carriers`. Children: `CarriersAdminPage`, `CdrsAdminPage`,
`RatesAdminPage`, `TiersAdminPage`, `SippAdminPage`, `DIDSearchPage` (`dids`).

**`OnboardingAdminPage`** (`/admin/onboarding`)
Customer onboarding request queue. Filter tabs by `OnboardingStatus`; verify
billing, approve (with DID config), or reject requests. APIs: `onboarding.ts`
(`listOnboardingRequests`, `verifyBilling`, `approveOnboarding`, `rejectOnboarding`)
+ `didInventory.ts` (`listAvailableDids`).

**`CustomersAdminPage`** (`/admin/customers`)
Searchable, paginated customer list (25 per page, load-more pattern). Inline
create form. Each row is a `CustomerRow` that links to `CustomerAccountPage`.
API: `GET /customers`, `POST /customers`.

**`CustomerAccountPage`** (`/admin/customers/:customerId`)
Full customer 360 view. Sections rendered conditionally by `account_type`:
- `CustomerRcfSection` — RCF entries (always shown for `rcf`/`hybrid`)
- `CustomerTrunkSection` — trunk management (for `trunk`/`hybrid`)
- `CustomerApiSection` — API DID management (for `api`/`hybrid`)
- `CustomerUcaasSection` — UCaaS extensions/voicemail (when `ucaas_enabled`)
- `CustomerEditForm` — edit customer fields
- `CustomerStatisticsTab` — 30-day CDR charts and quality stats
- Credit management (inline add-credit form via `POST /customers/:id/add-credit`)

APIs: `GET /customers/:id`, `GET /rcf`, `GET /trunks`, `GET /api-dids`,
`GET /cdrs/summary`, `GET /cdrs`.

**`TrunksAdminPage`** (`/admin/trunks`)
Full trunk CRUD across all customers. Create, edit, delete trunks. Manage IPs
and DIDs for each trunk inline. API: full `trunks` + `customers` APIs.

**`UserDetailPage`** (`/admin/customers/users`, `/admin/customers/users/:userId`)
User search and 360 view. Shows user profile, presence status, call history,
extension assignment, and quick admin actions. The legacy `/admin/user[/:userId]`
paths redirect here.

**`CdrsAdminPage`** (`/admin/platform/cdrs`) — thin wrapper around `CdrsTab`
Full CDR search across all customers. Filter bar, stat bar, expandable rows,
CSV export. APIs: `GET /cdrs`, `GET /cdrs/summary`.

**`RatesAdminPage`** (`/admin/platform/rates`) — thin wrapper around `RatesTab`
Rate deck management. Add/edit/delete rates, margin analysis grid.
APIs: `GET /rates`, `POST /rates`, `PATCH /rates/:id`, `DELETE /rates/:id`,
`GET /rates/margins`.

**`TiersAdminPage`** (`/admin/platform/tiers`) — thin wrapper around `TiersTab`
Service tier management. APIs: `GET /tiers`, tier CRUD.

**`CarriersAdminPage`** (`/admin/platform/carriers`) — thin wrapper around `CarriersTab`
Carrier/gateway management. Each carrier card includes a live connectivity test.
APIs: `GET /carriers`, carrier CRUD, `POST /carriers/:id/test`.

**`SippAdminPage`** (`/admin/platform/sipp`) — thin wrapper around `SippTab`
SIPp load-test runner. Preset grid, custom form, results with PASS/WARN/FAIL
verdict. APIs: `GET /sipp/presets`, `POST /sipp/run`.

**`DIDSearchPage`** (`/admin/platform/dids`)
Cross-product DID lookup / inventory. The legacy `/admin/did-search` path
redirects here. Uses `didInventory.ts`.

**`HomerAdminPage`** / **`HomerTab`** — **orphaned, not routed.**
`HomerAdminPage` is a thin wrapper around `HomerTab`, which still renders a Homer
iframe at `/homer/`. Neither is reachable from `App.tsx` — SIP troubleshooting now
lives in the native `TroubleshootingPage`. Treat these as dead/legacy code.

---

## 8. Components

### Layout (`src/components/layout/`)

**`AppLayout`**
Renders `Sidebar` on the left (fixed, 240px) and `<Outlet />` in the main
content area (max-width 1160px, centered). Background `#0f1117`.

**`Sidebar`**
Fixed left sidebar. Two collapsible groups: "Products" and "Administration".
Product items are filtered at render time by the user's `account_type` and `role`.
Collapse state is persisted to `localStorage`. Bottom section shows user avatar,
name/email, and sign-out button.

Navigation items are shown/hidden based on `account_type`:
- `rcf` variant: only RCF shown in Products
- `trunk` variant: only SIP Trunks shown
- `hybrid`: RCF + SIP Trunks
- `ucaas`: UCaaS extension/voicemail surfaces shown
- Admin/support: all items shown, **plus** the Call Flow Builder (`/flows`)

The **Call Flow Builder** nav item (`flowsItem`, `/flows`) is admin-only — it is in
`adminPaths` and the route is `RequireAdmin`-gated. It is not a per-`account_type`
product item; customers never see it.

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
Used on `RcfPage` and `CallQualityPage`.

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

## 11. Call Flow Builder Internals (`src/flow/`)

The Universal Call Flow Builder is a React Flow node-graph editor at `/flows`
(`CallFlowBuilderPage`, admin-only). One product-agnostic graph drives every
product; per-product compilers emit each backend's native artifact. The legacy
`@dnd-kit` IVR tree builder (`src/pages/ivr/`) was **removed** — this is the single
flow/IVR editor.

### Architecture

```
CallFlowBuilderPage → FlowBuilderShell
  ├─ FlowToolbar          (product selector, Save/Publish, Simulate, History, Import IVR)
  ├─ NodePalette          (product-filtered node source — model/palette.ts)
  ├─ CallFlowCanvas       (@xyflow/react canvas; node renderers in canvas/nodes/)
  ├─ NodeConfigPanel      (selected-node editor — config/)
  └─ ValidationPanel      (per-product validation — validation/)
state: store/flowStore.ts (zustand + zundo undo/redo, loadDoc/serialize)
```

### Core model — `CallFlowDoc` (`model/types.ts`)

One portable JSON document is the source of truth: a flat `{ nodes[], edges[] }`
graph (Twilio-Studio style) plus an `entry` binding and `product` kind. Node
`config` is a discriminated union (`NodeConfig`) keyed by node type. `model/
defaults.ts` seeds new nodes; `model/palette.ts` exports `PALETTE_BY_PRODUCT` (the
allowed node set per product — this is how RCF stays simple: its palette only
exposes customer-allowed capabilities).

### Canvas (`canvas/`)

Custom React Flow node renderers in `canvas/nodes/`: `EntryFlowNode` (the call
entry point), `StepNode` (linear verbs: say/play/dial/record/…), `MenuNode`
(per-digit handles for IVR menus), `BranchNode` (schedule/condition with
in/out + match/nomatch source handles), and `GenericFlowNode` (fallback).
`canvas/handles.ts` + `nodeTypes.ts` register handle ids and node-type map.

### Compilers (`compile/`)

Each product has a pure `compile()` (`compile/{ivr,rcf,trunk,ucaas}.ts`,
dispatched by `compile/registry.ts`, shared types in `compile/types.ts`) that
turns the `CallFlowDoc` into the backend's native artifact written to the sink on
publish. Several are **dual-mode**: a simple flat shape when the graph is trivial,
or a rich rules/plan shape otherwise (RCF, trunk). `compile/fromLegacyIvr.ts` is
the **reverse** compiler: it converts a legacy `ivr_flows.flow_config` nested tree
back into a `CallFlowDoc` graph (with `@dagrejs/dagre` top-down auto-layout) for
the toolbar's **Import IVR** action — the source `ivr_flows` row is never mutated.

### Store (`store/flowStore.ts`)

`zustand` store wrapped in `zundo` temporal middleware: holds nodes/edges +
selection, exposes graph mutations, undo/redo, and `loadDoc()` (used by both an
existing-flow load and the legacy importer). `store/serialize.ts` converts between
the React Flow runtime graph and the persisted `CallFlowDoc`.

### Toolbar actions (`toolbar/`)

- **Save / Publish** — `callFlows.ts` create/update then `publishFlow`; publish
  compiles + writes the sink + (for DID-bound products) repoints the DID.
- **FlowSimulateModal** — `POST /call-flows/{id}/simulate` with a test caller-id /
  timestamp; renders `{ product, result, trace }` (the backend reuses the real
  schedule/caller matchers, so the dry-run matches live routing).
- **FlowHistoryModal** — lists published versions (`listFlowVersions`), views a
  snapshot (`getFlowVersion`), and restores one as a new draft (`restoreFlowVersion`,
  no sink write until re-published).
- **Import IVR** — lists legacy flows via `ivr.ts`, converts the chosen one through
  `fromLegacyIvr.ts`, and `loadDoc`s it as an unsaved draft.

---

## 12. RCF-V1 Product Scope

This is the RCF-V1 production architecture. Know what is and is not available:

### Fully implemented and deployed

- **RCF** (`account_type: 'rcf'`) — the primary product. Full CRUD, inline editing, bulk operations.
- **Call Flow Builder** (`/flows`, admin-only) — Universal React Flow editor that
  designs + publishes call-handling logic for every product (IVR/API/RCF/Conference/
  Trunk/UCaaS), with simulate + version history. Compiles to each product's existing
  backend sink. See §11.
- **SIP Trunks** (`account_type: 'trunk'`) — full management in admin, customer portal is a placeholder.
- **Admin suite** — customers, trunks, CDRs, rates, tiers, carriers, SIPp, DID search, user lookup.
- **Call Quality** — platform-wide CDR quality analysis with MOS/jitter/packet-loss metrics.
- **Troubleshooting** — native React SIP-trace search (`POST /homer/search`) with a
  custom `<SipLadder>` diagram and inline packet-detail inspection. Grafana
  (`/grafana/`) provides the optional deep-link dashboard. No Homer iframe.
- **Documents** — shared document store with folder hierarchy.

### Phase 2 / Not yet customer-facing

- **API Calling** (`account_type: 'api'`) — `ApiDidsPage` is a placeholder. Admin-side
  `CustomerApiSection` works for admin config. DID management exists in admin only.
- **Customer self-service IVR/flow editing** — the Call Flow Builder is admin-only
  today (`/flows` is `RequireAdmin`). Customers don't yet author their own flows;
  admins build/publish on their behalf. (The legacy customer-facing `/ivr` page and
  its `@dnd-kit` builder were removed.)
- **UCaaS** (`ucaas_enabled: true`) — `CustomerUcaasSection` provides extension/voicemail
  management for admin. The softphone widget (WebRTC/Verto) is referenced in nginx
  (`/ws/verto/` proxy) but the softphone component itself is not in this codebase.

### RCF customers specifically

RCF customers (`account_type: 'rcf'`) see only: RCF page, API Docs, Call Quality,
Troubleshooting, and Account in the sidebar. They never see SIP Trunks or API
Calling (filtered in `Sidebar.tsx` against `user.account_type`), nor the admin-only
Call Flow Builder (`/flows`, `RequireAdmin`).

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

6. **Run the type check** before pushing:
   ```bash
   cd docker/ui/app && npx tsc --noEmit
   ```

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
(`#4ade80` for RCF, `#fbbf24` for trunks, `#c084fc` for API, `#22d3ee` for the
Call Flow Builder).
