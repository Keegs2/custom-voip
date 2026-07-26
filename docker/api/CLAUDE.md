# RCF Platform API

FastAPI backend for the RCF-V1 (Remote Call Forwarding) voice platform. Provides provisioning, CDR ingestion, call control, number inventory, and admin search for a multi-tenant VoIP system built on FreeSWITCH + Kamailio.

## Architecture Overview

- **Framework**: FastAPI 0.109+ with ORJSONResponse (10x faster JSON serialization)
- **Runtime**: Python 3.12, uvicorn with 4 workers, uvloop + httptools for performance
- **Database**: PostgreSQL via asyncpg, accessed through PgBouncer (port 6432)
- **Cache**: Redis 5+ (async, via redis-py)
- **Auth**: JWT (HS256) via python-jose, bcrypt password hashing
- **HTTP Client**: httpx (async, for Bandwidth API calls)
- **Container**: Multi-stage Docker build, runs as non-root user `api` (UID 1000)

## Deployment

Runs on VM3 (application services) in the RCF-V1 GCP architecture. Deployed via `docker-compose.services.yml` as the `voip-api` container.

```
Host port 8088 -> Container port 8000
```

The API container uses `host.docker.internal:host-gateway` to reach bare-metal PostgreSQL/PgBouncer on the same VM. Redis runs on VM2 and is reached via `REDIS_URL`.

Resource limits: 2 CPU / 1G RAM (reservation: 0.5 CPU / 256M).

## Dockerfile

Two-stage build:
1. **Builder** (`python:3.12-slim-bookworm`): installs build-essential + libffi-dev, creates a venv at `/opt/venv`, pip-installs requirements.txt
2. **Runtime** (`python:3.12-slim-bookworm`): copies `/opt/venv` from builder, copies `src/` to `/app/`, creates non-root `api` user

CMD: `uvicorn main:app --host 0.0.0.0 --port 8000 --workers 4 --loop uvloop --http httptools`

## Dependencies (requirements.txt)

| Package | Purpose |
|---|---|
| `fastapi>=0.109.0` | Web framework |
| `uvicorn[standard]>=0.27.0` | ASGI server |
| `uvloop>=0.19.0` | Fast event loop |
| `httptools>=0.6.0` | Fast HTTP parsing |
| `asyncpg>=0.29.0` | Async PostgreSQL driver |
| `redis>=5.0.0` | Async Redis client |
| `pydantic>=2.5.0` | Request/response validation (V2 syntax) |
| `orjson>=3.9.0` | Fast JSON serialization |
| `httpx>=0.26.0` | Async HTTP client (Bandwidth API) |
| `python-jose[cryptography]>=3.3.0` | JWT encode/decode |
| `passlib[bcrypt]>=1.7.4` | Password hashing utilities |
| `bcrypt>=4.0.0` | bcrypt implementation |
| `python-multipart>=0.0.6` | Form data parsing (CDR ingest) |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://api:api_secret@postgres:6432/voip` | PgBouncer connection string (production `.env` overrides host to `host.docker.internal`) |
| `REDIS_URL` | `redis://redis:6379` | Redis connection |
| `FREESWITCH_ESL_HOST` | _(empty, required)_ | FreeSWITCH ESL IP (VPC IP of FS VM) |
| `FREESWITCH_ESL_PORT` | `8021` | FreeSWITCH ESL port |
| `FREESWITCH_ESL_PASSWORD` | `ClueCon` | FreeSWITCH ESL password |
| `JWT_SECRET_KEY` | _(required, crashes on missing)_ | HMAC secret for JWT signing |
| `JWT_EXPIRE_MINUTES` | `480` (8 hours) | JWT token lifetime |
| `CORS_ORIGINS` | `http://localhost:8080` | Comma-separated allowed origins |
| `SBC_PROXY_IP` | `127.0.0.1` | Kamailio SBC IP for outbound SIP |
| `BANDWIDTH_API_CLIENT_ID` | _(empty)_ | Bandwidth OAuth2 client ID |
| `BANDWIDTH_API_CLIENT_SECRET` | _(empty)_ | Bandwidth OAuth2 client secret |
| `BANDWIDTH_ACCOUNT_ID` | `9900717` | Bandwidth main account ID |
| `BANDWIDTH_SIP_PEER_ID` | `1162116` | Bandwidth SIP Peer (location) ID |
| `TEST_MODE` | `false` | When `true`, ESL uses loopback instead of SBC proxy |
| `ENABLE_DOCS` | `true` | Set `false` to disable Swagger UI / ReDoc |

## PostgreSQL Connection

Uses asyncpg with connection pooling. Critical setting: **`statement_cache_size=0`** is required because PgBouncer runs in transaction-mode pooling. Without this, asyncpg's prepared statement cache causes errors when connections are reassigned between requests.

Pool configuration:
- `min_size=3`, `max_size=25` (with 4 workers = up to 100 total connections for PgBouncer)
- `max_inactive_connection_lifetime=300` (5 min)
- `command_timeout=30`

## Redis Connection

Async redis-py client with retry logic (5 attempts, 2s backoff) at startup. All convenience functions (`cache_get`, `cache_set`, etc.) gracefully return None/no-op when Redis is unavailable, so the API degrades without crashing.

Redis is used for:
- RCF config caching (`rcf:{did}` keys)
- Trunk IP caching (`trunk_ip:{ip}` keys)
- CPS (Calls Per Second) rate limiting via Lua-scripted sorted-set sliding windows (`cps:{type}:{customer_id}`)
- CPS tier limits synced for FreeSWITCH (`account:{customer_id}:limits` hashes)
- Velocity tracking (`vel:{customer_id}:cpm` counters)
- Daily spend tracking (`spend:{customer_id}:{date}` counters)
- Bandwidth TN inventory cache (`bandwidth:tns`, 5 min TTL)

## JWT Authentication

- Middleware (`JWTAuthMiddleware`) runs on every request after CORS
- Extracts `Bearer` token from `Authorization` header
- Decodes JWT claims and stores them on `request.state.user`
- Exempt paths: `/auth/login`, `/v1/auth/login`, `/health`, `/health/detailed`, `/docs`, `/redoc`, `/openapi.json`, `/`
- FreeSWITCH paths exempt: anything starting with `/freeswitch/`, or ending with `/cdrs/ingest` or `/cdrs/ingest/bulk`
- Public onboarding exempt: `POST /v1/onboarding` and `POST /onboarding` (unauthenticated intake form submission). Only the POST method is exempt — GET/approve/reject still require admin.
- WebSocket paths exempt: anything starting with `/ws/`
- CORS preflight (`OPTIONS`) always passes through

JWT claims contain: `sub` (user ID), `email`, `role`, `customer_id`.

## CORS Configuration

`CORS_ORIGINS` env var split by comma. Defaults to `http://localhost:8080`. Middleware added before JWT middleware so preflight requests work.

## Health Check

Docker healthcheck: `curl -sf http://127.0.0.1:8000/health` every 15s.

`GET /health` checks API + DB (via `SELECT 1`) + Redis (via `ping`). Returns `{"status": "healthy"}` or `{"status": "degraded"}` with per-component status.

`GET /health/detailed` returns the same but with error messages when components are unhealthy.

## FreeSWITCH Integration

### ESL Client (`services/esl_client.py`)
Raw TCP socket connection to FreeSWITCH Event Socket (port 8021). Opens a new connection per command (no persistent connection). Supports:
- `originate_call()` -- builds a `sofia/external/dest@proxy` originate command with channel variables for customer_id, product_type, traffic_grade. The `X-Carrier` SIP header is hardcoded to `primary` (Dallas); `traffic_grade` is only passed as a channel var, it does NOT select the carrier.
- `get_call_status()` -- `uuid_dump` to get live call state
- `hangup_call()` -- `uuid_kill` with hangup cause
- `transfer_call()` -- `uuid_transfer`
- `send_dtmf()` -- `uuid_send_dtmf`

In `TEST_MODE=true`, originate uses `loopback/` instead of `sofia/external/`.

### CDR Ingest (`routers/cdrs.py`)
FreeSWITCH `mod_json_cdr` POSTs CDRs to `/v1/cdrs/ingest` after each call. The endpoint:
- Accepts `application/json`, `x-www-form-urlencoded` (mod_json_cdr encode-values mode), or raw body
- Extracts ~53 fields from the FreeSWITCH JSON CDR structure including full RTP quality metrics (the INSERT binds 53 positional params, `$1`–`$53`)
- **On-net routing (`$50`–`$53`):** `origin_customer_id`, `terminating_customer_id`, `on_net`, `on_net_hops` record BOTH parties of an internal call. `customer_id` stays the TERMINAL customer (so `rate_cdr()` is unchanged). Off-net calls: `origin_customer_id==customer_id`, `on_net=false`. See `docs/ONNET_ROUTING_DESIGN.md`.
- Handles duplicate detection via `WHERE NOT EXISTS (SELECT 1 FROM cdrs WHERE uuid = $1)`
- Always returns 200 to prevent FreeSWITCH retry storms
- No auth required (called over internal Docker network)

Bulk ingest: `/v1/cdrs/ingest/bulk` accepts a JSON array of CDR objects, max 1000 per batch.

## Bandwidth API Integration

OAuth2 client_credentials flow against `https://api.bandwidth.com/api/v1/oauth2/token`. Token cached in-memory with 30s pre-expiry refresh.

The Numbers API returns **XML** (not JSON). The client parses `TelephoneNumbersResponse` XML, extracts `<TelephoneNumber>` elements, and normalizes to E.164.

Paginated: follows `<Links><next>` URLs, page size 500, safety limit 200 pages.

Results cached in Redis (`bandwidth:tns` key, 5 min TTL). Falls back to stale cache if upstream is unreachable.

Three endpoints under `/v1/numbers`:
- `GET /inventory` -- full TN list cross-referenced with internal product tables
- `GET /available` -- only unassigned TNs
- `GET /stats` -- summary counts (total, assigned, available, by product)

## Complete Endpoint List

All endpoints are mounted at both `/v1/<path>` and `/<path>` (backward compatibility). Auth router also at `/auth` and `/v1/auth`.

### Health (no auth)
| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Root -- returns API name + version |
| `GET` | `/health` | Health check (DB + Redis) |
| `GET` | `/health/detailed` | Detailed health with error messages |

### Auth
| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/v1/auth/login` | None | Login, returns JWT |
| `GET` | `/v1/auth/me` | User | Get current user info |
| `PUT` | `/v1/auth/me` | User | Update own name/password |
| `POST` | `/v1/auth/register` | Admin | Create new user |
| `GET` | `/v1/auth/users` | Admin | List all users |
| `PUT` | `/v1/auth/users/{user_id}` | Admin | Update any user |
| `DELETE` | `/v1/auth/users/{user_id}` | Admin | Delete a user |

### Customers
| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/customers` | List customers (filterable by status, account_type) |
| `POST` | `/v1/customers` | Create customer |
| `GET` | `/v1/customers/{id}` | Get customer by ID |
| `PUT` | `/v1/customers/{id}` | Update customer |
| `DELETE` | `/v1/customers/{id}` | Delete customer (cascading, transactional) |
| `GET` | `/v1/customers/{id}/balance` | Get balance + credit info |
| `POST` | `/v1/customers/{id}/credit` | Add credit to balance |

### RCF (Remote Call Forwarding)
| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/rcf` | List RCF numbers (filter by customer_id, enabled) |
| `POST` | `/v1/rcf` | Create RCF number |
| `GET` | `/v1/rcf/{did}` | Get RCF config by DID |
| `PUT` | `/v1/rcf/{identifier}` | Update RCF (by ID or DID) |
| `PATCH` | `/v1/rcf/{identifier}` | Partial update (alias for PUT) |
| `DELETE` | `/v1/rcf/{identifier}` | Delete RCF number (by ID or DID) |

### Calls (API Calling)
| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/calls` | Originate outbound call via ESL (CPS-limited) |
| `GET` | `/v1/calls/{call_id}` | Get call status (active or completed CDR) |
| `POST` | `/v1/calls/{call_id}/update` | Control live call (hangup, transfer) |

### SIP Trunks
| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/trunks` | List trunks (filter by customer_id, enabled) |
| `POST` | `/v1/trunks` | Create trunk |
| `GET` | `/v1/trunks/call-paths` | List call path packages |
| `GET` | `/v1/trunks/{id}` | Get trunk detail |
| `PUT` | `/v1/trunks/{id}` | Update trunk |
| `PUT` | `/v1/trunks/{id}/call-paths` | Assign call path package |
| `POST` | `/v1/trunks/{id}/ips` | Add auth IP |
| `GET` | `/v1/trunks/{id}/ips` | List auth IPs |
| `DELETE` | `/v1/trunks/{id}/ips/{ip_id}` | Remove auth IP |
| `POST` | `/v1/trunks/{id}/dids` | Assign DID to trunk |
| `GET` | `/v1/trunks/{id}/dids` | List trunk DIDs |
| `GET` | `/v1/trunks/{id}/stats` | Real-time trunk stats (ESL + DB) |

### CDRs
| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/v1/cdrs/ingest` | None | FreeSWITCH CDR webhook |
| `POST` | `/v1/cdrs/ingest/bulk` | None | Bulk CDR re-ingest |
| `GET` | `/v1/cdrs` | User | Query CDRs with filters |
| `GET` | `/v1/cdrs/summary` | User | CDR summary stats (by day/hour/destination) |
| `GET` | `/v1/cdrs/{uuid}` | User | Get single CDR with full RTP metrics |
| `POST` | `/v1/cdrs/{uuid}/rate` | User | Manually trigger CDR rating |

### Search (Admin only)
| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/search/did` | Search DIDs across RCF, API, Trunk products |
| `GET` | `/v1/search/did/{did}/calls` | Call history for a specific DID |
| `GET` | `/v1/search/user` | Search users by name/email |
| `GET` | `/v1/search/user/by-customer/{id}` | List users for a customer |

### Number Inventory (DID Lifecycle Management)
| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/v1/numbers/inventory` | Admin | Full DID inventory with filters and pagination |
| `GET` | `/v1/numbers/stats` | Admin | Inventory summary stats (by status/product/state) |
| `POST` | `/v1/numbers/sync` | Admin | Sync Bandwidth TN inventory into did_inventory table (also reconciles product tables) |
| `POST` | `/v1/numbers/reconcile` | Admin | Reconcile did_inventory against product tables (rcf/api/trunk) without hitting Bandwidth |
| `POST` | `/v1/numbers/{did}/assign` | Admin | Assign DID to customer (creates product record) |
| `POST` | `/v1/numbers/{did}/unassign` | Admin | Unassign DID (removes product record) |
| `GET` | `/v1/numbers/available` | User | Browse available DIDs with filters |
| `GET` | `/v1/numbers/my` | User | Customer's assigned numbers |
| `POST` | `/v1/numbers/{did}/request` | User | Reserve a number for admin review |

### Carriers (Admin only)
Carrier gateway management — backed by `carrier_gateways` (Bandwidth Dallas/LA).
| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/carriers` | List carrier gateways |
| `POST` | `/v1/carriers` | Create carrier gateway |
| `GET` | `/v1/carriers/{carrier_id}` | Get carrier detail |
| `PATCH` | `/v1/carriers/{carrier_id}` | Update carrier |
| `DELETE` | `/v1/carriers/{carrier_id}` | Delete carrier |
| `POST` | `/v1/carriers/{carrier_id}/test` | Probe carrier reachability |

### Rates (Admin only)
Rate table / rate entry management — backed by `rate_tables`, `rates`.
| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/rates` | List rate entries (filterable) |
| `POST` | `/v1/rates` | Create rate entry |
| `GET` | `/v1/rates/margins` | Margin analysis (rate vs cost) |
| `GET` | `/v1/rates/lookup` | Longest-prefix rate lookup for a destination |
| `GET` | `/v1/rates/{rate_id}` | Get rate entry |
| `PATCH` | `/v1/rates/{rate_id}` | Update rate entry |
| `DELETE` | `/v1/rates/{rate_id}` | Delete rate entry |

### Tiers (Admin only)
CPS tier management — backed by `cps_tiers`.
| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/tiers` | List all tiers |
| `GET` | `/v1/tiers/trunk` | List trunk-type tiers |
| `GET` | `/v1/tiers/api` | List api-type tiers |
| `GET` | `/v1/tiers/{tier_id}` | Get tier |
| `POST` | `/v1/tiers` | Create tier |
| `PATCH` | `/v1/tiers/{tier_id}` | Update tier |
| `DELETE` | `/v1/tiers/{tier_id}` | Delete tier |

### SIPp (Admin only)
SIPp load-test control. The runner service is not yet deployed — `POST /run` returns a mock result or 503.
| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/sipp/presets` | List load-test presets |
| `POST` | `/v1/sipp/run` | Trigger a SIPp load test (mock/503 until runner deployed) |

### SBC (Admin only)
| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/sbc/stats` | Per-SBC call distribution over last N minutes (reads `cdrs.sbc_id`) |

### Homer (Admin only)
SIP trace search via qryn (Loki-compatible API over ClickHouse). Homer 10 — no JWT flow to Homer itself; these endpoints require platform admin auth.
| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/homer/aliases` | Static IP-to-name alias map for ladder diagrams |
| `POST` | `/v1/homer/search` | Search SIP traces with A/B-leg correlation (qryn LogQL + direct ClickHouse) |

### Onboarding
New-RCF-customer intake pipeline (`pending → billing_verified → approve → active`, or `rejected`). Backed by `onboarding_requests`.
| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/v1/onboarding` | None | Public intake form submission |
| `GET` | `/v1/onboarding` | Admin | List onboarding requests |
| `GET` | `/v1/onboarding/{request_id}` | Admin | Get request detail |
| `POST` | `/v1/onboarding/{request_id}/verify-billing` | Admin | Mark billing verified |
| `POST` | `/v1/onboarding/{request_id}/approve` | Admin | Approve + provision (creates customer/user/RCF) |
| `POST` | `/v1/onboarding/{request_id}/reject` | Admin | Reject request |

### Docs (when ENABLE_DOCS=true)
| Method | Path | Description |
|---|---|---|
| `GET` | `/docs` | Custom dark-themed Swagger UI |
| `GET` | `/redoc` | Custom dark-themed ReDoc |

## Custom Documentation UI

Swagger UI and ReDoc are served via custom HTML with a dark theme matching the dashboard design (background #0f1117, text #e2e8f0, blue accent #3b82f6). The default FastAPI docs are disabled (`docs_url=None, redoc_url=None`) and replaced with these custom routes.

## Request Timing

Every HTTP response includes an `X-Response-Time-Ms` header with the request duration in milliseconds.
