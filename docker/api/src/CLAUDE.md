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
    number_inventory.py      # Bandwidth TN inventory
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
  - Extracts 48 columns including full RTP quality metrics (jitter, packet loss, MOS, codec info)
  - Explicit `::type` casts on all 48 INSERT parameters for asyncpg/PgBouncer compatibility
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
Cross-references Bandwidth TN inventory with internal product tables.
- Builds an assignment map by UNIONing `rcf_numbers`, `api_dids`, `trunk_dids`, and `extensions` (UCaaS)
- Normalizes TNs (strips `+`) for comparison between Bandwidth E.164 and internal E.164
- Three endpoints: inventory (all TNs with assignment status), available (unassigned only), stats (counts by product)

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
- `originate_call(uuid, from_did, to, customer_id, traffic_grade, webhook_url, timeout)` -- builds an originate command with channel variables. Routes through `sofia/external/{to}@{sbc_proxy}:5060` so Kamailio applies `ext-sip-ip`. X-Carrier header set based on traffic_grade. In TEST_MODE, uses `loopback/`.
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
