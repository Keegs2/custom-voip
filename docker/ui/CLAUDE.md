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

Path alias: `@/` resolves to `src/` (configured in `vite.config.ts`).

---

## 2. Build Process

### Multi-Stage Dockerfile (`docker/ui/Dockerfile`)

**Stage 1 — homer-source** (`ghcr.io/sipcapture/homer-app`)
Extracts the Homer SIP capture frontend. Patches its `index.html` to set
`PREFIX: "/homer/"` so asset paths resolve correctly when served at `/homer/`.

**Stage 2 — build** (`node:20-alpine`)
```
npm ci
npm run build   # tsc -b && vite build
```
Output lands in `/app/dist`.

**Stage 3 — nginx:alpine**
- Generates a self-signed TLS cert at build time (10-year, `voiceplatform.local`).
  WebRTC (`getUserMedia`) requires HTTPS — both ports 80 and 443 are served.
- Copies `nginx-maps.conf` as `00-maps.conf` (WebSocket upgrade map).
- Copies `nginx.conf` as `rcf-ui.conf`.
- Copies React `dist/` to `/usr/share/nginx/html`.
- Copies Homer assets to `/usr/share/nginx/html/homer/`.

### nginx routing (`docker/ui/nginx.conf`)

| Path | Destination |
|---|---|
| `/api/v3/*` | Homer backend (`homer-webapp:80`) — must be first |
| `/api/ws/*` | FastAPI WebSocket (`api:8000`) with Upgrade headers |
| `/api/sipp/*` | SIPp runner (`sipp:8001`) |
| `/api/*` | FastAPI backend (`api:8000`), strips `/api` prefix |
| `/docs`, `/redoc`, `/openapi.json` | FastAPI docs direct |
| `/homer/` (exact) | Patched Homer `index.html` from disk |
| `/homer/*` | Proxied to `homer-webapp:80` with `/homer/` stripped |
| `/health` | FastAPI health, no logging |
| `/*` | React SPA (`try_files $uri $uri/ /index.html`) |

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
/login                    LoginPage          (public)
/                         DashboardPage      (auth required, inside AppLayout)
/rcf                      RcfPage
/api-dids                 ApiDidsPage
/trunks                   TrunksPage
/ivr                      IvrBuilderPage
/documentation            DocsPage
/call-quality             CallQualityPage
/account                  AccountPage
/troubleshooting          TroubleshootingPage  (full-screen, no AppLayout)

/admin                    AdminPage (tab shell, admin only)
  /admin/customers        CustomersAdminPage
  /admin/trunks           TrunksAdminPage
  /admin/cdrs             CdrsAdminPage
  /admin/rates            RatesAdminPage
  /admin/tiers            TiersAdminPage
  /admin/carriers         CarriersAdminPage
  /admin/sipp             SippAdminPage

/admin/customers/:id      CustomerAccountPage  (standalone, admin only)
/admin/did-search         DIDSearchPage        (standalone, admin only)
/admin/user               UserDetailPage       (standalone, admin only)
/admin/user/:userId       UserDetailPage       (standalone, admin only)
*                         → redirect to /
```

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

**Logout:** clears localStorage, nulls state, navigates to `/login`.

**401 interceptor in `src/api/client.ts`:** any API call that gets a 401 clears
the token and calls `window.location.replace('/login')` as a safety net on top of
the context-level handling.

### `src/components/auth/RequireAuth.tsx`

Wraps protected route subtrees. Shows a full-page spinner while `isLoading` is
true (prevents flash of login redirect). On failure redirects to `/login` with
`state.from` set so `LoginPage` can redirect back after authentication.

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
Shows "Phase 2" badges on API Calling and IVR Builder.

**`RcfPage`** (`/rcf`)
Lists RCF entries for the authenticated customer (or all customers for admin via
`AdminCustomerSelector`). Supports card and table view modes, sorting, pagination,
and inline `forward_to` editing. API: `GET /rcf`.

**`TrunksPage`** (`/trunks`)
Currently a placeholder/coming-soon shell. Shows the page header but no data.
Full trunk management lives in `admin/TrunksAdminPage`.

**`ApiDidsPage`** (`/api-dids`)
Currently a placeholder/coming-soon shell.

**`IvrBuilderPage`** (`/ivr`)
Currently a placeholder/coming-soon shell. The IVR engine code
(`src/pages/ivr/`) is complete but the page wrapper shows "Phase 2".

**`DocsPage`** (`/documentation`)
Static inline API documentation. No API calls. Self-contained reference with
collapsible sections for auth, RCF, Trunks, API Calling.

**`CallQualityPage`** (`/call-quality`)
Platform-wide SIP quality analysis. Sections: filter bar, stat cards (ASR, MOS,
packet loss, jitter, R-factor), trend charts, paginated CDR table, slide-out
call detail panel. APIs: `GET /cdrs`, `GET /customers`, `GET /trunks`.

**`TroubleshootingPage`** (`/troubleshooting`)
Full-screen page (outside `AppLayout`) that renders Homer SIP capture in an
iframe at `/homer/`. Renders its own `Sidebar` directly. Error state shown if
Homer iframe fails to load.

**`AccountPage`** (`/account`)
Profile page. Lets users update their display name and password via
`PATCH /api/auth/me` (calls `apiRequest('PATCH', '/auth/me', ...)`).
Calls `refreshUser()` from `AuthContext` on success.

### Admin pages (require `RequireAdmin`)

**`AdminPage`** (`/admin`)
Tab shell. Renders a horizontal tab bar linking to the 7 admin sub-routes.
Uses `<Outlet />` — does not render content itself.

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

**`CdrsAdminPage`** (`/admin/cdrs`) — thin wrapper around `CdrsTab`
Full CDR search across all customers. Filter bar, stat bar, expandable rows,
CSV export. APIs: `GET /cdrs`, `GET /cdrs/summary`.

**`RatesAdminPage`** (`/admin/rates`) — thin wrapper around `RatesTab`
Rate deck management. Add/edit/delete rates, margin analysis grid.
APIs: `GET /rates`, `POST /rates`, `PATCH /rates/:id`, `DELETE /rates/:id`,
`GET /rates/margins`.

**`TiersAdminPage`** (`/admin/tiers`) — thin wrapper around `TiersTab`
Service tier management. APIs: `GET /tiers`, tier CRUD.

**`CarriersAdminPage`** (`/admin/carriers`) — thin wrapper around `CarriersTab`
Carrier/gateway management. Each carrier card includes a live connectivity test.
APIs: `GET /carriers`, carrier CRUD, `POST /carriers/:id/test`.

**`SippAdminPage`** (`/admin/sipp`) — thin wrapper around `SippTab`
SIPp load-test runner. Preset grid, custom form, results with PASS/WARN/FAIL
verdict. APIs: `GET /sipp/presets`, `POST /sipp/run`.

**`DIDSearchPage`** (`/admin/did-search`)
Cross-product DID lookup. Searches RCF, API, trunk, and UCaaS DIDs.
Shows recent calls for the found DID. API: `GET /admin/did-search` (custom
endpoint via `apiRequest`).

**`UserDetailPage`** (`/admin/user`, `/admin/user/:userId`)
User search and 360 view. Shows user profile, presence status, call history,
extension assignment, and quick admin actions. APIs: `GET /admin/users/search`,
`GET /admin/users/:id`, `GET /cdrs`.

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
- `ucaas`: IVR Builder shown
- Admin/support: all items shown

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

### Icons (`src/components/icons/ProductIcons.tsx`)

Named wrappers around `lucide-react` icons. All accept `size?: number` (default 18).
Available: `IconRCF`, `IconTrunk`, `IconAPI`, `IconIVR`, `IconDocs`, `IconAdmin`,
`IconSignal`, `IconTroubleshoot`.

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
- **Troubleshooting** — Homer SIP capture embedded in iframe.
- **Documents** — shared document store with folder hierarchy.

### Phase 2 / Not yet customer-facing

- **API Calling** (`account_type: 'api'`) — `ApiDidsPage` is a placeholder. Admin-side
  `CustomerApiSection` works for admin config. DID management exists in admin only.
- **IVR Builder** — `IvrBuilderPage` is a placeholder. The IVR engine in `src/pages/ivr/`
  is complete code but not exposed to customers yet.
- **UCaaS** (`ucaas_enabled: true`) — `CustomerUcaasSection` provides extension/voicemail
  management for admin. The softphone widget (WebRTC/Verto) is referenced in nginx
  (`/ws/verto/` proxy) but the softphone component itself is not in this codebase.

### RCF customers specifically

RCF customers (`account_type: 'rcf'`) see only: RCF page, API Docs, Call Quality,
Troubleshooting, and Account in the sidebar. They never see SIP Trunks, API Calling,
or IVR Builder. This is enforced in `Sidebar.tsx` by filtering `allProductNavItems`
against `user.account_type`.

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
(`#4ade80` for RCF, `#fbbf24` for trunks, `#c084fc` for API, `#22d3ee` for IVR).
