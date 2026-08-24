# Source Code Guide

This directory contains the FastAPI application source. The container copies `src/` to `/app/` and uvicorn runs `main:app`.

## Directory Structure

```
src/
  main.py                    # App factory, lifespan, middleware, router mounts
  auth/
    __init__.py
    security.py              # JWT creation/validation, bcrypt password hashing
    dependencies.py          # FastAPI Depends functions: get_current_user, require_admin
  middleware/
    __init__.py
    auth.py                  # JWTAuthMiddleware (Starlette BaseHTTPMiddleware)
  db/
    __init__.py
    database.py              # asyncpg connection pool, query helpers
    redis_client.py          # Async Redis client, caching, CPS rate limiting
  models/
    __init__.py              # Empty -- Pydantic models are defined inline in routers
  routers/
    __init__.py
    auth.py                  # Login, register, user CRUD
    health.py                # /health and /health/detailed
    customers.py             # Customer CRUD + balance/credit
    rcf.py                   # RCF number provisioning
    calls.py                 # API call origination + CPS enforcement
    trunks.py                # SIP trunk management + call path packages
    cdrs.py                  # CDR ingest (from FreeSWITCH) + query endpoints
    search.py                # Admin DID search, user search
    number_inventory.py      # DID lifecycle management (inventory, assign, sync, reconcile)
    carriers.py              # Carrier gateway CRUD + reachability test (admin)
    carrier_trunks.py        # Multi-carrier trunk registry CRUD (admin) — SBC sqlops trust-fallback contract
    rates.py                 # Rate table / rate entry CRUD, margins, lookup (admin)
    tiers.py                 # CPS tier CRUD (admin)
    sipp.py                  # SIPp load-test presets + run (admin; runner not yet deployed)
    sbc.py                   # Per-SBC call distribution stats from cdrs.sbc_id (admin)
    homer.py                 # SIP trace search via qryn/ClickHouse (Homer 10) (admin)
    onboarding.py            # New-customer intake pipeline (public POST + admin review)
  services/
    __init__.py
    esl_client.py            # FreeSWITCH ESL TCP client
    bandwidth_client.py      # Bandwidth Numbers API (OAuth2 + XML parsing)
```

## main.py -- Application Lifecycle

### Startup (lifespan context manager)
1. `init_db()` -- creates asyncpg connection pool (parses `DATABASE_URL` with regex)
2. `init_redis()` -- creates redis-py async client with retry logic (5 attempts, 2s backoff)

### Shutdown
1. `close_db()` -- closes asyncpg pool
2. `close_redis()` -- closes Redis connection

### Middleware Stack (order matters)
1. **Request timing** (`@app.middleware("http")`) -- adds `X-Response-Time-Ms` header
2. **JWTAuthMiddleware** -- validates Bearer tokens, sets `request.state.user`
3. **CORSMiddleware** -- handles preflight, sets CORS headers

Starlette middleware runs in reverse registration order: CORSMiddleware runs first (registered last), then JWTAuthMiddleware, then the timing middleware. This means CORS preflight passes before JWT validation.

### Router Mounting
Every router is mounted at two prefixes for backward compatibility:
- `/v1/<resource>` (canonical)
- `/<resource>` (legacy/testing)

Auth router is mounted at both `/auth` and `/v1/auth`.

The `ORJSONResponse` is the default response class for the entire app.

## Router Organization

### auth.py
Handles authentication and user management. Contains inline Pydantic models:
- `LoginRequest`, `RegisterRequest`, `UpdateMeRequest`, `UserUpdate`, `UserOut`
- Login queries the `users` table with a JOIN to `customers` for account_type/ucaas info
- JWT claims: `sub` (user ID as string), `email`, `role`, `customer_id`
- Registration is admin-only (`require_admin` dependency)
- Roles: `admin`, `user`, `readonly`
- Statuses: `active`, `disabled`
- UCaaS access computed from `account_type` + `ucaas_enabled` flag

### health.py
Two endpoints, no auth. Both check DB (`SELECT 1`) and Redis (`ping`). Returns `healthy` or `degraded`.

### customers.py
CRUD for the `customers` table. Account types: `rcf`, `api`, `trunk`, `hybrid`, `ucaas`.
- Delete is transactional: wraps cascading deletes of `rcf_numbers`, `api_dids`, `trunk_dids`, `trunk_auth_ips`, `sip_trunks`, `api_credentials` in a single `conn.transaction()`.
- Balance operations: `GET /{id}/balance` computes `available = balance + credit_limit`, `POST /{id}/credit` adds to balance.

### rcf.py
RCF (Remote Call Forwarding) number provisioning. The core RCF product.
- **Authorization** (mirrors trunks.py): reads (`GET` list + by-DID) are tenant-scoped via `get_customer_filter` — non-admins only see their own customer's entries (the list endpoint force-overrides any `customer_id` query param; by-DID cross-tenant returns 404, never 403, so existence is not leaked). Create and delete are admin-only (`require_admin`) — provisioning flows; customer number release goes through `/numbers/{did}/unassign`. Update (PUT/PATCH) is customer self-service, tenant-scoped, with `max_channels` admin-only.
- E.164 validation for DIDs, flexible validation for forward destinations (E.164 or 3-6 digit local extensions for PBX/Zoiper testing)
- `ring_timeout` validated between 5-120 seconds
- Update/Delete accept both numeric ID and E.164 DID string as the `{identifier}` path param
- On update, invalidates the Redis `rcf:{did}` cache so FreeSWITCH picks up changes immediately
- PATCH is an alias for PUT (both call `update_rcf`)

### calls.py
API call origination with tiered CPS enforcement.
- Tiers: `api_basic` (5 CPS, $0.01/call), `api_standard` (8 CPS, $0.008/call), `api_premium` (15 CPS, $0.005/call)
- CPS check uses Redis sliding window (`check_cps_limit` in redis_client)
- Velocity check (calls per minute) as a secondary guard
- Per-call fee applied as a `BackgroundTasks` job (deducted from customer balance)
- Call status: checks `active_calls` table first, then falls back to `cdrs` table for completed calls
- Uses ESL client to originate via FreeSWITCH

### trunks.py
SIP trunk management with call path packages.
- Trunk auth types: `ip`, `credential`, `both`
- Call path packages: predefined capacity tiers stored in `call_path_packages` table, assigned via `PUT /{trunk_id}/call-paths`
- Sub-resources: `/{trunk_id}/ips` for IP ACL management, `/{trunk_id}/dids` for DID assignment
- `GET /{trunk_id}/stats`: real-time channel count via ESL `show channels as json`, plus last-hour CDR aggregates (ASR, avg duration, cost)
- Cache invalidation on IP delete (`trunk_ip:{ip}`)

### cdrs.py
CDR ingestion and querying. The largest router file.
- **Ingest**: Parses FreeSWITCH JSON CDR format with robust field extraction:
  - Resolves fields from multiple locations: `variables` dict, `callflow[0].caller_profile`, top-level `core-uuid`
  - Cleans caller_id_number (handles SIP `"Display" <+1234>` format)
  - Computes R-factor from MOS using piecewise linear approximation
  - Extracts ~55 columns including full RTP quality metrics (jitter, packet loss, MOS, codec info), the on-net set `origin_customer_id`/`terminating_customer_id`/`on_net`/`on_net_hops` (records both parties of an internal call; `customer_id` stays the terminal so `rate_cdr()` is unchanged; off-net → `origin==customer`, `on_net=false`), and the inbound-carrier attribution pair `inbound_carrier`/`inbound_carrier_pop` (FS channel vars, migration 40; absent/empty → NULL)
  - Explicit `::type` casts on all INSERT parameters for asyncpg/PgBouncer compatibility (the INSERT binds 55 positional params, `$1`–`$55`; on-net columns are `$50::int`/`$51::int`/`$52::bool`/`$53::smallint`, inbound-carrier columns `$54::varchar`/`$55::varchar`)
  - Duplicate detection via `WHERE NOT EXISTS` (the cdrs table uses a composite PK for TimescaleDB)
  - Always returns 200 to prevent FreeSWITCH retry storms
- **Query**: `GET /v1/cdrs` with filters (customer, trunk, product_type, direction, destination, date range, rated_only). Defaults to last 24 hours.
- **Summary**: `GET /v1/cdrs/summary` grouped by day, hour, or destination prefix.
- **Rating**: `POST /v1/cdrs/{uuid}/rate` calls a PostgreSQL function `rate_cdr()`.

### search.py
Admin-only search tools. Uses `require_admin` dependency on all endpoints.
- **DID search**: `GET /v1/search/did?q=617` -- UNION across `rcf_numbers`, `api_dids`, `trunk_dids` with LIKE matching on normalized digits. Returns product type, customer info, and product-specific details as JSONB.
- **DID call history**: `GET /v1/search/did/{did}/calls` -- matches CDRs where the DID appears as caller or callee.
- **User search**: `GET /v1/search/user?q=john` -- ILIKE on name/email, optionally scoped to a customer_id.
- **Users by customer**: `GET /v1/search/user/by-customer/{id}` -- all users for a customer.
- All search endpoints use `COUNT(*) OVER()` window function for total count with pagination.

### number_inventory.py
Complete DID lifecycle management backed by the `did_inventory` table.
- **Admin endpoints**: `GET /inventory` (paginated, filterable — incl. `carrier=`, matching the COALESCEd attribution so `carrier=bandwidth` also finds legacy NULL rows), `GET /stats` (counts by status/product/state/carrier), `POST /sync` (upsert from Bandwidth API, then reconciles product tables), `POST /reconcile` (reconcile `did_inventory` against rcf/api/trunk product tables without calling Bandwidth — internal `_reconcile_product_tables()`; never touches `source`/`carrier_trunk_id`), `POST /add` (manual DID intake), `PUT /{did}/carrier-trunk` (re-associate/clear attribution), `POST /{did}/assign`, `POST /{did}/unassign`
- **Manual intake + carrier attribution (migrations 41 + 42)**: every row carries `source` (`bandwidth_sync`|`manual`), nullable `carrier_trunk_id` FK → `carrier_trunks`, and a first-class `carrier` column (42; NULL = legacy implicit Bandwidth). Item/filter/stats carrier is `COALESCE(d.carrier, ct.carrier, 'bandwidth')` (`_CARRIER_COALESCE`; the item shape folds it in Python via `_shape_item` — d.* already emits a `carrier` column, and `dict(asyncpg.Record)` resolves duplicate names to the FIRST occurrence, so a SQL alias would silently return the raw NULL). `POST /add` takes `{dids: [1..500], carrier (REQUIRED, lowercased), carrier_trunk_id?, notes?}`: the carrier must have ≥1 ENABLED trunk row (404 "unknown carrier" otherwise — a carrier with only disabled trunks counts as unknown); the optional trunk must belong to that carrier and be enabled (422 otherwise — body-consistency, unlike the 404-able carrier). Normalizes via the shared `utils.phone` E.164 helper, dedupes in-batch, `ON CONFLICT DO NOTHING`, inserts `carrier` + nullable `carrier_trunk_id`, and returns the EXACT envelope `{"added": [e164], "skipped_existing": [e164], "invalid": [raw], "count": n}` (TED UI codes against it). Added DIDs land `available`/`manual` and flow through the existing assign path unchanged. **Sync ownership guard**: `POST /sync` only manages `source='bandwidth_sync'` rows (`_compute_sync_sets()`) — manual rows never appear in its report-only `removed` list and are never metadata-updated, even when their DID shows up in the Bandwidth feed (sync-inserted rows leave `carrier` NULL → render 'bandwidth'). `PUT /{did}/carrier-trunk` accepts a disabled trunk (attribution is metadata; only NEW intake demands an enabled one); setting a trunk also syncs `d.carrier` to that trunk's carrier, clearing (null) drops only the trunk and leaves `d.carrier` as-is; returns the full inventory-item shape.
- **Customer endpoints**: `GET /available` (browse available DIDs), `GET /my` (customer's assigned numbers, includes `status`), `POST /{did}/request` (reserve a number for admin review), `POST /{did}/request-release`, `POST /{did}/cancel-release`
- **Release workflow (request-based)**: customers cannot unassign directly. `POST /{did}/request-release` (tenant-scoped: non-admins only their own DIDs, cross-tenant → 404 no-leak; 409 unless status is 'assigned') sets `assigned` → `release_requested` and appends an audit line to `notes`. Admin approves via `POST /{did}/unassign` (its status guard accepts 'assigned', 'reserved', and 'release_requested') or denies via `POST /{did}/cancel-release` (back to 'assigned'; the customer can use it to withdraw). The `release_requested` status is added to the CHECK constraint by `34_release_requested_status.sql`; `GET /my` includes it in its status filters so pending-release numbers still show for the customer.
- Assign creates the product record (e.g., `rcf_numbers` row for RCF) inside a transaction
- Unassign removes the product record and resets status to 'available'
- Sync is idempotent: inserts new TNs as 'available', updates metadata on existing, flags removed TNs
- All assignment changes invalidate relevant Redis caches and are logged

### carriers.py
Admin-only CRUD for `carrier_gateways` (Bandwidth Dallas/LA). `POST /{carrier_id}/test` probes carrier reachability.

### carrier_trunks.py
Admin-only CRUD for `carrier_trunks` (migrations 40 + 42) at `/v1/carrier-trunks` — the multi-carrier trunk registry (Bandwidth + Sinch, one row per carrier signaling IP). TWO downstream SQL contracts ride these column names — never rename: (1) the Kamailio SBCs via sqlops (`freeswitch` DB role) as the DB-backed trust fallback for unknown-source INVITEs: `SELECT carrier, pop, cps_limit FROM carrier_trunks WHERE source_ip = '$si'::inet AND direction IN ('inbound','both') AND enabled = true`; (2) FreeSWITCH's outbound carrier-failover Lua, per zone `<z>` in east/west/central: `SELECT carrier, pop, host(source_ip) AS term_ip, COALESCE(priority_<z>, priority) AS eff_priority FROM carrier_trunks WHERE direction IN ('outbound','both') AND enabled = true ORDER BY eff_priority, id` (disable a trunk here → it leaves every zone's termination list on the next call). Priority fields (42): `priority` (default 100, lower = tried first, ≥1, NOT NULL — PUT rejects explicit null) + nullable zone overrides `priority_east`/`priority_west`/`priority_central` (≥1; explicit null on PUT clears back to inheriting `priority`). Validates `source_ip` with `ipaddress` (bare IP, no CIDR), direction as a `Literal` enum, `cps_limit > 0`; maps the two named UNIQUE constraints (source_ip, carrier+pop) to distinct 409s; PUT is a partial update via `exclude_unset` (nullable fields clearable); `carrier` is immutable (delete + recreate to re-home an IP). Returns `host(source_ip)` as text.

### rates.py
Admin-only management of `rate_tables` / `rates`. Plus `GET /margins` (rate vs cost analysis) and `GET /lookup` (longest-prefix rate match for a destination).

### tiers.py
Admin-only CRUD for `cps_tiers`. Convenience filters `GET /trunk` and `GET /api` return tiers of that type.

### sipp.py
Admin-only SIPp load-test control. `GET /presets` lists scenarios; `POST /run` triggers a test. The SIPp runner service is not yet deployed, so `POST /run` returns a mock result or 503.

### sbc.py
Admin-only `GET /stats`: per-SBC call distribution over the last N minutes, aggregated from `cdrs.sbc_id` (the column added in `18_sbc_id_column.sql`). Used to monitor SBC failover/load-balancing health.

### homer.py
Admin-only SIP trace search for Homer 10. Queries qryn (Loki-compatible API over ClickHouse) — there is no Homer 7 JWT flow. `GET /aliases` returns a static IP-to-name map for ladder diagrams. `POST /search` runs a phone-number search and A/B-leg correlation; correlation (Step 3) queries ClickHouse directly via `IN (...)` because qryn's RE2 engine 500s on large Call-ID regex alternations.

### onboarding.py
New-customer intake pipeline (`pending → completed`, or `→ rejected` — status-only since migration 27; billing/provisioning are external). Backed by `onboarding_requests`. `POST ""` is the **public, unauthenticated** intake form (exempted in middleware). All other endpoints (`GET` list/detail, `complete`, `reject`) require admin.

**FCC KYC (FCC 26-27 FNPRM, adopted 2026-04-30):** the POST requires a nested `kyc: KycPayload` — `{is_high_volume, standard: KycStandard, high_volume: KycHighVolume|null, declared_peak_cps, declared_max_concurrent_calls}` — validated with Pydantic V2 (`Literal` enums, `@field_validator` + `@model_validator(mode="after")` for cross-field rules: EIN format NN-NNNNNNN, `state_of_registration` required for `state_registration`, `intended_use_description` required for `other`, `high_volume` required iff `is_high_volume`, alternate phone must differ from main phone). **Capacity declarations (v2, REQUIRED, top level on KycPayload):** `declared_peak_cps` int 1-1000 + `declared_max_concurrent_calls` int 1-100000. **Granite's high-volume threshold** (provider-defined per FCC 26-27; REPLACES the old 50k calls/month `model_validator` on `OnboardingSubmit`, now removed — `monthly_volume` is informational only): `KycPayload.validate_high_volume` forces `is_high_volume=true` (+ the block) when `declared_peak_cps > 1` **or** `declared_max_concurrent_calls > 1000`; the 422 message contains "high-volume threshold" (frontend fuzzy mapping). Exactly at threshold = not over; voluntary opt-in below stays allowed; >1000 trunk call paths is declared here (TrunkIntake cap unchanged). `alternate_phone` reuses `utils.phone.normalize_e164`; originating IPs are validated syntactically with `ipaddress` (bare v4/v6 or CIDR ≤ /24 v4 / ≤ /64 v6; private ranges accepted). Persisted to the nullable `onboarding_requests.kyc` JSONB (migration `35_onboarding_kyc.sql` — the v2 capacity fields ride in the JSONB, no new migration) shaped `{standard, high_volume|null, declared_peak_cps, declared_max_concurrent_calls, submitted_at, form_version: 'fcc-26-27-fnprm-v2'}` via `json.dumps(...)` bound `$11::jsonb`. 4-year retention per FCC 26-27 is operational policy (no purge automation here).

**Product-aware intake (products-v1):** the POST also requires `products: ProductsPayload` — `{selected: list of 'rcf'|'trunk'|'api'|'voicemail' (min 1, no dupes), rcf?, trunk?, api?, voicemail?}` where each block must be **present iff selected** (`@model_validator` both directions). Rationale: each product needs different information to provision, so the form collects exactly the selected products' setup data. Blocks: `RcfIntake` (did_count/porting/forwarding_setup as `Literal`s of the exact form option strings — DID counts use EN dashes, porting uses EM dashes; `current_carrier` required when porting starts with Yes/Both), `TrunkIntake` (`signaling_ips` 1-10 validated with the same `_validate_ip_or_cidr` as KYC — **IP-peering only, no REGISTER auth**, so PBX/SBC public IPs are required to provision; `concurrent_call_paths` 1-1000; optional pbx_vendor/dids_needed), `ApiIntake` (use_case 1-300; optional expected_cps 1-1000 + http(s) webhook_url ≤255; needs_numbers bool), `VoicemailIntake` (mailbox_count 1-10000; attach_to Literal existing_numbers/new_numbers/unsure). Persisted to nullable `onboarding_requests.products` JSONB (migration `36_onboarding_products.sql`) as the validated payload + `form_version: 'products-v1'`, bound `$12::jsonb`. The legacy top-level RCF fields (`did_count`, `porting`, `current_carrier`, `forwarding_setup`) are now **Optional** on the model and nullable in the DB (36 drops NOT NULL); when 'rcf' is selected the INSERT backfills them from `products.rcf` (frontend-sent values win) so old admin queries stay meaningful — non-RCF submissions insert NULLs. Admin list/get decode `kyc` + `products` back to objects (`_decode_json_col` — no asyncpg JSONB codec is registered, so JSONB arrives as strings); pre-KYC/pre-products rows return null for those keys and stay fully operable.

## Database Module (db/)

### database.py
Module-level `pool` variable (asyncpg.Pool). Initialized lazily or via `init_db()` at startup.

The `DATABASE_URL` is parsed with a regex into user/password/host/port/database components because asyncpg does not accept URL strings directly.

**Query helper functions** -- all acquire a connection from the pool, execute, and release:
- `fetch_one(query, *args)` -- returns a single `asyncpg.Record` or None
- `fetch_all(query, *args)` -- returns list of `asyncpg.Record`
- `execute(query, *args)` -- for INSERT/UPDATE/DELETE, returns status string
- `execute_many(query, args_list)` -- batch operations
- `get_pool()` -- returns the raw pool for manual `async with pool.acquire()` patterns (used for transactions in `customers.py`)

**Query patterns used throughout**: positional parameters (`$1`, `$2`, ...), dynamic WHERE/SET clause building with an incrementing `idx` counter.

### redis_client.py
Module-level `client` variable. All convenience functions check `if not client: return None/0/False` so the app never crashes on Redis unavailability.

**Convenience functions**:
- `cache_get/set/delete` -- basic string caching with TTL
- `incr_with_ttl` -- atomic increment + expire (velocity tracking)
- `get_velocity(customer_id)` -- reads CPM and daily spend from Redis
- `invalidate_rcf_cache(did)` -- deletes `rcf:{did}`
- `invalidate_trunk_cache(ip)` -- deletes `trunk_ip:{ip}`

**CPS tier functions**:
- `sync_cps_tier_to_redis()` -- writes `account:{customer_id}:limits` hash (read by FreeSWITCH Lua scripts)
- `get_cps_tier_from_redis()` -- reads the limits hash
- `check_cps_limit()` -- **Lua-scripted sorted-set sliding window** for atomic CPS enforcement. Uses ZRANGEBYSCORE to clean old entries, ZCARD to count, ZADD to record. Returns `(allowed, current_cps)`. Fails open when Redis is down.
- `get_current_cps()` -- read-only CPS count for monitoring
- `record_cps_hit()` -- track without enforcing

## Auth Module (auth/)

### security.py
- `JWT_SECRET_KEY` is **required** (raises `RuntimeError` at import time if missing)
- `JWT_ALGORITHM = "HS256"`, `JWT_EXPIRE_MINUTES = 480` (8 hours)
- `verify_password()` / `hash_password()` -- direct bcrypt usage
- `create_access_token(data)` -- adds `exp` claim and signs
- `decode_access_token(token)` -- validates and returns claims dict

### dependencies.py
FastAPI `Depends` functions:
- `get_current_user(request)` -- reads `request.state.user` (set by middleware), raises 401 if missing
- `require_admin(request)` -- calls `get_current_user`, checks `role == "admin"`, raises 403 if not
- `get_customer_filter(request)` -- returns `customer_id` for row-level filtering (None for admins)

## Middleware Module (middleware/)

### auth.py (JWTAuthMiddleware)
Starlette `BaseHTTPMiddleware`. Exempt paths are hardcoded in `EXEMPT_PATHS` set. Also exempts:
- `OPTIONS` requests (CORS preflight)
- `/freeswitch/*` paths (FreeSWITCH internal endpoints)
- `POST /v1/onboarding` and `POST /onboarding` (public intake form; GET/approve/reject still require admin)
- Paths ending with `/cdrs/ingest` or `/cdrs/ingest/bulk`
- `/ws/*` paths (WebSocket auth handled via query params)

On auth failure, returns a `JSONResponse(status_code=401)` directly (never raises HTTPException from middleware).

## Services Module (services/)

### esl_client.py
Implements a raw TCP ESL client (no third-party ESL library). Each command opens a new TCP connection to FreeSWITCH:

1. Open TCP connection to `ESL_HOST:ESL_PORT`
2. Read `auth/request` prompt
3. Send `auth {password}\n\n`
4. Read `+OK`
5. Send `api {command}\n\n`
6. Read response until `\n\n`
7. Close connection

All operations have 5-10 second timeouts. Returns None on any error.

**Public functions**:
- `originate_call(uuid, from_did, to, customer_id, traffic_grade, webhook_url, timeout)` -- builds an originate command with channel variables. Routes through `sofia/external/{to}@{sbc_proxy}:5060` so Kamailio applies `ext-sip-ip`. The `sip_h_X-Carrier` header is hardcoded to `primary` (Dallas) — all products use the same 2-carrier model and `traffic_grade` is only passed as a channel var, it does NOT select the carrier. In TEST_MODE, uses `loopback/`.
- `get_call_status(call_id)` -- `uuid_dump`, parses key:value pairs
- `hangup_call(call_id, cause)` -- `uuid_kill`
- `transfer_call(call_id, destination)` -- `uuid_transfer`
- `send_dtmf(call_id, digits)` -- `uuid_send_dtmf`

### bandwidth_client.py
Bandwidth Numbers API client. The upstream API returns **XML**, not JSON.

**OAuth2 flow**: `client_credentials` grant to `https://api.bandwidth.com/api/v1/oauth2/token`. Token cached in module-level `_token` / `_token_expires_at` with 30s pre-expiry refresh. Automatic retry on 401.

**XML parsing**: Uses `xml.etree.ElementTree` to parse `<TelephoneNumbersResponse>`. Each `<TelephoneNumber>` is converted to a dict with `fullNumber` normalized to E.164 (+1NPANXXXXXX).

**Pagination**: follows `<Links><next>` URLs. Page size 500, safety limit 200 pages.

**Caching**: Results stored in Redis (`bandwidth:tns`, 5 min TTL) via orjson serialization. On upstream failure, serves stale cached data if available.

**Public functions**:
- `list_tns(page, size)` -- single page fetch
- `get_all_tns()` -- full paginated fetch with caching
- `invalidate_cache()` -- force-expire Redis cache
- `_credentials_configured()` -- checks if env vars are set (used by router to return 503)

## Key Patterns

### Adding a New Endpoint

1. Create or edit a router file in `routers/`
2. Define Pydantic request/response models inline (this codebase does not use a separate models package)
3. Use `@field_validator` (Pydantic V2) for validation
4. Import `db` module: `from db import database as db`
5. Use `db.fetch_one()`, `db.fetch_all()`, `db.execute()` for queries
6. Use positional params (`$1`, `$2`) and dynamic `idx` counter for building queries
7. Mount the router in `main.py` at both `/v1/<prefix>` and `/<prefix>`
8. If the endpoint should be admin-only, add `admin: dict = Depends(require_admin)` as a parameter
9. If the endpoint should be auth-exempt, add the path to `EXEMPT_PATHS` in `middleware/auth.py`

### Database Query Pattern

All queries use asyncpg positional parameters. Dynamic filters are built with an incrementing index:

```python
query = "SELECT * FROM table WHERE 1=1"
values = []
idx = 1

if some_filter is not None:
    query += f" AND column = ${idx}"
    values.append(some_filter)
    idx += 1

query += f" ORDER BY id LIMIT ${idx} OFFSET ${idx + 1}"
values.extend([limit, offset])

results = await db.fetch_all(query, *values)
```

For transactions, acquire a connection directly from the pool:

```python
pool = await db.get_pool()
async with pool.acquire() as conn:
    async with conn.transaction():
        await conn.execute(...)
        await conn.execute(...)
```

### Sending ESL Commands to FreeSWITCH

```python
from services.esl_client import originate_call, hangup_call, _send_esl_command

# High-level: originate a call
success = await originate_call(
    uuid=call_uuid,
    from_did="+15087282017",
    to="+15551234567",
    customer_id=1,
    traffic_grade="standard"
)

# Low-level: any FreeSWITCH API command
response = await _send_esl_command("show channels as json")
```

### Cache Invalidation Pattern

When a provisioning change is made (RCF forward_to update, trunk IP removal), the corresponding Redis cache key is invalidated so FreeSWITCH reads the new value on the next call:

```python
from db import redis_client as cache

# After updating RCF config
await cache.invalidate_rcf_cache(did)

# After removing a trunk IP
await cache.invalidate_trunk_cache(ip_address)
```

### Authorization Pattern

Three levels of access enforced by FastAPI dependencies:

```python
# Any authenticated user
async def some_endpoint(user: dict = Depends(get_current_user)):
    user_id = int(user["sub"])

# Admin only
async def admin_endpoint(admin: dict = Depends(require_admin)):
    pass

# Row-level filtering (admin sees all, user sees own customer)
async def filtered_endpoint(customer_filter: int | None = Depends(get_customer_filter)):
    if customer_filter is not None:
        query += " AND customer_id = $1"
```

### Pydantic V2 Conventions

All models use Pydantic V2 syntax:
- `@field_validator("field_name")` instead of `@validator`
- `@classmethod` decorator required on validators
- `model_dump(exclude_none=True)` for building dynamic UPDATE queries
- `BaseModel` with `Optional[type] = None` for partial update models
