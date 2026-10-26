# Source Code Guide

This directory contains the FastAPI application source. The container copies `src/` to `/app/` and uvicorn runs `main:app`.

## Directory Structure

```
src/
  main.py                    # App factory, lifespan, middleware, router mounts
  config.py                  # Feature flags read LIVE from env — API_CALLING_ENABLED (api_calling_enabled / require_api_calling_enabled), CDR_B_LEG_ROWS (cdr_b_leg_rows_enabled; ON unless exactly `false`)
  auth/
    __init__.py
    security.py              # JWT creation/validation, bcrypt password hashing
    dependencies.py          # FastAPI Depends functions: get_current_user, require_admin
    ingest.py                # require_ingest_secret — X-Ingest-Secret for FreeSWITCH voicemail /fs/ endpoints (fail-closed 503 when INGEST_SHARED_SECRET unset/short)
    playback.py              # mint/verify 120 s playback tokens (separate key, aud+typ 'vm-playback', bound to kind+object id; kinds message | greeting | ivr_prompt)
  middleware/
    __init__.py
    auth.py                  # JWTAuthMiddleware (Starlette BaseHTTPMiddleware)
  db/
    __init__.py
    database.py              # asyncpg connection pool, query helpers
    schema_check.py          # Deploy-order guard: are the migration-47 + 48 cdrs columns present? (startup CRITICAL + /health/detailed)
    redis_client.py          # Async Redis client, caching, CPS rate limiting
  models/
    __init__.py              # Empty -- Pydantic models are defined inline in routers
  routers/
    __init__.py
    auth.py                  # Login, register, user CRUD
    health.py                # /health and /health/detailed
    customers.py             # Customer CRUD + balance/credit
    rcf.py                   # RCF number provisioning
    calls.py                 # API call origination + CPS enforcement — RETIRED product, mounted only if API_CALLING_ENABLED
    trunks.py                # SIP trunk management + call path packages
    cdrs.py                  # CDR ingest (from FreeSWITCH) + query endpoints
    reports.py               # Customer Reporting (/v1/reports): overview, trend, numbers, calls, calls.csv, my-numbers
    search.py                # Admin DID search, user search
    number_inventory.py      # DID lifecycle management (inventory, assign, sync, reconcile)
    carriers.py              # Carrier gateway CRUD + reachability test (admin)
    carrier_trunks.py        # Multi-carrier trunk registry CRUD (admin) — SBC sqlops trust-fallback contract
    rates.py                 # Rate table / rate entry CRUD, margins, lookup (admin)
    tiers.py                 # CPS tier CRUD (admin)
    sipp.py                  # SIPp load-test presets + run (admin; runner not yet deployed)
    sbc.py                   # Per-SBC call distribution stats from cdrs.sbc_id (admin)
    homer.py                 # SIP trace search via qryn/ClickHouse (Homer 10) (admin)
    homer_correlation.py     # Pure A/B leg correlation helpers (X-CID parse, windows, ClickHouse SQL, groups)
    onboarding.py            # New-customer intake pipeline (public POST + admin review)
    billing.py               # Read-only tenant-scoped ledger views (/billing/balance, /billing/ledger)
    voicemail.py             # Encrypted voicemail product API (/v1/voicemail): mailboxes, messages, playback tokens + Range audio, greetings, crypto-erase, FS lookup/greeting/deposit (contract docs/ENCRYPTED_VOICEMAIL_INTERFACES.md §4/§5)
    ivr.py                   # Visual IVR product API (/v1/ivr): flows + versions (server compile/publish), IVR numbers, destinations, prompts (TTS/upload, playback tokens), simulate, TED admin (contract docs/IVR_INTERFACES.md §8.2/§8.3)
    ivr_assist.py            # Visual IVR Flow assistant (/v1/ivr/flows/{id}/assist…): start a job, poll it, record the outcome (contract docs/IVR_ASSIST_INTERFACES.md §5)
  services/
    __init__.py
    esl_client.py            # FreeSWITCH ESL TCP client
    bandwidth_client.py      # Bandwidth Numbers API (OAuth2 + XML parsing)
    tenant_redaction.py      # What a CUSTOMER may see of a call (CDR allowlist, minutes-only durations)
    customer_numbers.py      # The ONE definition of "a customer's numbers" (number_routing view; pure SQL builders + shaping)
    ledger.py                # Append-only ledger (migration 37) — read by billing.py; no in-tree writer since the payments demo was removed
    call_pricing.py          # Rate-deck lookups shared with rates.py (quote_call_price now unused)
    reporting.py             # Customer Reporting pure logic (date/tz validation, buckets, missed reasons, grades, CSV)
    voicemail/               # Encrypted voicemail crypto layer: AES-256-GCM envelope, per-customer Cloud KMS KEKs (keys.py), GCS ciphertext store, CRC32C, AAD (contract docs/ENCRYPTED_VOICEMAIL_INTERFACES.md §2)
                             #   + product logic (§4/§5): mailboxes.py (create/delete/erase/purge, shared with number_inventory), deposit.py (FS deposit: leases, idempotency, deadline), greetings.py, audio.py + plaintext_cache.py (decrypt-once LRU, Range), retention.py (lifespan sweep), wav.py, meta.py (X-VM-Meta), body.py (capped raw body), audit.py (fail-closed access log)
    ivr/                     # Visual IVR (docs/IVR_INTERFACES.md): compiler.py (graph -> plan, the ONLY plan writer), policy.py (US-only dial policy, pinned NANPA tables), simulator.py, audio.py (canonical 8 kHz WAV + sha), tts.py (Piper sidecar client, render cache, preview limiter), store.py (shared SQL/shapes, inventory assign), limits.py
      ivr/assist/            # Flow assistant, CRAG side (docs/IVR_ASSIST_INTERFACES.md): config.py (env), aliases.py (number detection, [D]/[N]/[P] tokens, rendering), graph.py (draft <-> alias graph), schemas/ + schema.py (byte copies of docs/ivr_assist/ + strict evaluator), ted_client.py (the one TED call), pipeline.py (propose + <= 2 repairs, no DB), jobs.py (ivr_assist_jobs state, asyncio task, caps), eval.py (`python -m services.ivr.assist.eval`)
      voicemail/transcription/  # Transcription v1.1 (docs/VOICEMAIL_TRANSCRIPTION_PLAN.md): config.py (flag, available(), env), document.py (sealed JSON), chunking.py (<= 55 s pieces), provider.py + gcp_stt.py (Speech-to-Text V2, us, lazy) + fake_stt.py (dev/CI), queue.py (§6 worker SQL), worker.py (lifespan worker), smoke.py (`python -m services.voicemail.transcription.smoke`)
```

## Retired / removed products (2026-09)

- **API Calling — RETIRED, code kept, OFF.** One flag: `config.api_calling_enabled()` — ON only when env `API_CALLING_ENABLED` is exactly `true` (trimmed, case-insensitive), read live on every call (tests use `monkeypatch.setenv`). While OFF: `main.py` does not mount `routers/calls.py` (`/v1/calls`, `/calls` → 404) and the router carries `Depends(require_api_calling_enabled)` as defense in depth; `GET /tiers/api` → 404 and tier validators reject `tier_type='api'`; `CustomerCreate` rejects `account_type='api'` (422; `hybrid` = RCF + SIP Trunking stays allowed); `compute_billing_estimate` emits no api line for any account_type; `/customers/me` returns `counts.api_dids = 0` (key kept); `AssignRequest` / `NumberRequest` reject `product_type='api'` (422; listing/reconcile/unassign of existing api rows unchanged); onboarding `ProductsPayload` rejects any `'api'` selection or block (422). All 422 messages start with `config.API_CALLING_RETIRED_MESSAGE` ("API Calling is retired"). Adding a new API-Calling surface? Gate it on `api_calling_enabled()` (read at request/validation time, not import time — except router mounting in main.py). Tests: `tests/test_api_calling_retired.py` (flag off, hermetic) + `tests/test_api_calls.py` (kept code, flag on, ephemeral PG).
- **Payments demo — REMOVED.** `routers/payments.py`, `services/payments/`, `services/demo_seed.py`, `services/auto_recharge.py` and `PAYMENTS_DEMO_*` are gone. The demo-only branches of `calls.py` (x402 pay-per-call with a simulated facilitator that accepted any signature, ledger-posted per-call fee, `PAYMENTS_DEMO_FAKE_ORIGINATE`) went with it; calls.py is the former flag-off legacy flow. Migrations 37/38 and their tables are untouched.

## Tenant redaction (customers never see how we bill/rate)

Owner rule: tenant (non-staff) callers must NEVER receive rates, costs, carrier
cost, margin, rating state, fraud internals, routing/supplier internals, or an
exact call duration. "Tenant" = the endpoint's `customer_filter` is not None
(`get_support_read_filter` → admin + support are staff; `get_customer_filter`
→ admin only is staff; `user`/`readonly` with a customer_id are tenants).
Staff shapes are unchanged. Everything lives in `services/tenant_redaction.py`:

- **Two layers.** SQL: tenant queries SELECT only `TENANT_CDR_SELECT_COLUMNS`
  (sensitive columns are never read). Response: every tenant CDR row is rebuilt
  by `redact_cdr_row()` from the ALLOWLIST `TENANT_CDR_FIELDS` — a new `cdrs`
  column does NOT reach tenants unless someone adds it to the allowlist.
  `FORBIDDEN_TENANT_CDR_KEYS` is the test denylist (money, `rated_at`,
  `destination_prefix`, `billable_*`/`duration_seconds`, RTP byte/packet
  counters — duration proxies, `fraud_*`, `traffic_grade`, `carrier_used`,
  `inbound_carrier*`, `on_net*`, `sbc_id`, `freeswitch_node`, `network_addr`,
  `sip_user_agent`, `bridge_uuid`).
- **Duration = TALK time.** Per call `duration_minutes` = whole minutes, half-up,
  from `end_time - answer_time` (`tr.TALK_MS_SQL`, selected as `talk_ms`; Python
  twin `tr.talk_ms()`) — never `duration_ms` (includes ring) nor `billable_ms`
  (contract "Customer minutes"); unanswered → 0; any answered call with >0 ms → at least 1.
  Totals (`total_minutes`) round the answered-call ms total ONCE (never a sum
  of per-call minimums — that would mimic billing increments). Averages
  (`avg_duration_minutes`) are the mean of per-call whole minutes, 1 decimal
  ("2.3 min") — so a one-call window cannot leak sub-minute precision.
  `answer_time`/`end_time` are floored to the minute for tenants (otherwise
  `end - answer` re-derives the exact duration); `start_time` stays exact.
- **One row per call.** Every tenant CDR query carries `leg IS DISTINCT FROM 'B'`
  (list/total/summary via the shared builder, `GET /v1/cdrs/{uuid}` → a B uuid
  is a 404, trunk stats, `/v1/calls/{id}`, every report). The staff `leg` /
  `call_id` params are ignored for tenants; `leg`/`leg_attempt` are on the
  forbidden list and never on the allowlist.
- **Filters.** `rated_only`, `sbc_id`, `zone` are ignored for tenants on
  `/v1/cdrs` + `/summary` (no inference oracle for rating state / withheld
  routing columns). No cost/duration sort or filter params exist.
- **Applied at:** `GET /v1/cdrs`, `GET /v1/cdrs/{uuid}`, `GET /v1/cdrs/summary`
  (tenant rows: counts + `total_minutes` [+ `avg_duration_minutes` for
  group_by=destination]; no `total_cost`), `GET /v1/trunks/{id}/stats`
  (`last_hour.avg_duration_minutes`; no `total_cost`/`avg_duration_sec`),
  `GET /v1/calls/{id}` (`duration_minutes`, minute-floored answer/end — only
  reachable while `API_CALLING_ENABLED`).
- **Adding a tenant-reachable endpoint that returns call data?** Route tenant
  rows through `redact_cdr_row()` / `redact_summary_row()` and add a case to
  `tests/test_tenant_redaction.py` (asserts the full denylist recursively).
- **Deliberately NOT redacted:** `/customers/me/billing` (the customer's own
  contracted plan line items — qty × unit_price), `/trunks/call-paths`
  (package `monthly_fee` list prices), the `POST /calls` `per_call_fee`
  (the caller's own tier fee; retired product), and `/billing/ledger` entries
  (the customer's own money movements; legacy x402 demo entries carry quote
  metadata).

## Reporting (customer-facing, `/v1/reports` + `/reports`)

Contract: `docs/CUSTOMER_REPORTING_DESIGN.md` (implemented exactly — read its
"Implementation notes" for null/edge semantics). `routers/reports.py` owns the
SQL; `services/reporting.py` is the pure logic (unit-tested without a DB).
Tests: `tests/test_reports.py` (ephemeral PG 16).

- **Endpoints:** `GET overview | trend | numbers | calls | calls.csv | my-numbers`.
  Common params `start`/`end` (inclusive local `YYYY-MM-DD`, span ≤ 366 days),
  `tz` (IANA, default America/New_York, validated case-insensitively against
  `pg_timezone_names`, cached 24h per process), `numbers` (comma list),
  `customer_id` (staff only). Parsed once by the `report_scope` dependency.
- **Scoping:** `get_support_read_filter`. Tenants forced to their own customer
  (the `customer_id` param is ignored); staff (admin/support) MUST pass
  `customer_id` (422). Staff and tenants get the SAME redacted shape — there is
  no staff-only variant of a report.
- **One row per call:** the `base` CTE (and the `data_from` probe) carry
  `c.leg IS DISTINCT FROM 'B'`; no report has a `leg` param.
- **Redaction:** minutes only via `tenant_redaction` — TALK time: `base` selects
  `tr.TALK_MS_SQL AS talk_ms`, per call `tr.call_minutes_sql('talk_ms')`,
  `aggregate_minutes` on each row/bucket/total talk-ms sum — rounded once,
  `average_minutes` for avg). Never selected/returned: costs, rates, billable,
  answer/end times, carrier/SBC/FS/network columns. `hangup_cause` is read only
  to map to a plain-English missed reason (`services/reporting.MISSED_REASONS`)
  and never returned; no SIP codes. `tests/test_reports.py::assert_report_safe`
  walks every response (and the CSV text) for forbidden keys/values.
- **"The customer's number"** = `destination` for inbound, `caller_id` for
  outbound (anything not `'outbound'` is inbound), canonicalized in SQL with the
  `31_did_canonicalize.sql` CASE (`customer_numbers.cdr_customer_number_sql`),
  matched against **the customer's numbers** = `customer_numbers.owned_numbers_sql`
  over the `number_routing` view (every product: rcf, trunk, voicemail, future
  arms; api hidden — see "Customer numbers" below). Never re-list product
  tables in reports.py. The `numbers` filter is
  canonicalized in Python and intersected with the owned set IN SQL (`sel` CTE)
  — it can only narrow; a not-owned/junk entry is dropped, none left = empty.
- **Products:** `/calls` rows carry `product` (the CDR's `product_type`); a
  call a voicemail box answered is `outcome: "answered"` with
  `outcome_label: "Answered by voicemail"` (`reporting.outcome_fields`; owner
  decision O2 — counts as answered, also in the CSV Outcome cell).
  `/my-numbers` = `{number, name, product, enabled, forwards_to}`
  (`customer_numbers.shape_number`) and is ALSO the dashboard's numbers list.
  An on-net RCF -> voicemail forward belongs to the DIALED RCF number (CDR
  `destination` = first-hop DID); the mailbox's own row counts direct dials.
- **Query shape (all endpoints):** one `WITH owned, sel, base, f` prelude; bind
  layout `$1 customer_id::int, $2 start::date, $3 end::date, $4 tz::text,
  $5 numbers::text[]` (+ endpoint extras `$6…`), every bind explicitly cast.
  The time predicate is `start_time >= ($2::date::timestamp AT TIME ZONE $4)`
  AND `< (($3::date + 1)::timestamp AT TIME ZONE $4)` — stable expressions of
  binds, so the `(customer_id, start_time DESC)` index range is used
  (`test_report_scan_uses_customer_time_index` asserts it via EXPLAIN). Local
  bucketing is `date_trunc(unit, start_time AT TIME ZONE tz)` (portable — no
  Timescale `time_bucket`); trend zero-fill is `generate_series`. Overview is 2
  queries (totals+previous-period in one FILTERed pass; day/hour/cause in one
  `GROUPING SETS` pass), calls 2 (count + page), others 1. All LIMITed.
- **Statement timeout:** every endpoint runs its queries in ONE
  `BEGIN READ ONLY` transaction that first does `SET LOCAL statement_timeout =
  REPORT_STATEMENT_TIMEOUT_MS` (env, default 15000, clamped 1000-60000).
  `SET LOCAL` is transaction-scoped, so it is safe under PgBouncer transaction
  pooling (never leaks to another client's server connection — asserted by the
  test). A cancel → HTTP 503 "try a shorter date range". The pool's
  `command_timeout=30` stays as the client-side backstop.
- **CSV:** `StreamingResponse`; a `count(*) … LIMIT cap+1` probe sets
  `X-Report-Truncated` (always sent, `true`/`false`) BEFORE streaming, then
  keyset pages of `CSV_CHUNK_ROWS` (5000) on `(start_time, id)` DESC, each its
  own short read-only transaction — a slow download never pins a pool
  connection or holds a long snapshot. Cap `rp.CSV_ROW_CAP` = 100,000.
  Formula-injection guard (`rp.csv_safe`) prefixes `'` on `= @ - \t \r` and on
  `+` not followed by a phone number. CORS exposes `Content-Disposition` and
  `X-Report-Truncated` (main.py) so the SPA can read them.
- **Adding a metric?** Aggregate in SQL inside the existing passes (no N+1, no
  per-row Python loops over CDRs), minutes through `tenant_redaction`, and extend
  `assert_report_safe` coverage in the test.

## Customer numbers (`services/customer_numbers.py` — the ONE definition)

Plan: `docs/CUSTOMER_NUMBERS_HOLISTIC_PLAN.md`. "A customer's numbers" is read
from the `number_routing` view (22 + 54's voicemail arm) — the oracle
FreeSWITCH routes on — through ONE pure helper, never a hand-written union of
product tables. Readers: Reporting (`/reports/numbers`, `/reports/my-numbers`,
the `numbers` filter), the dashboard (via `/reports/my-numbers`),
`/customers/me` `counts.numbers`, `/numbers/owned` (admin), `/numbers/my`
(fallback arm, raw view) and `/search/did` (raw view, admin).

- **Owned** = on the account in ANY product, enabled or not: disabled RCF
  numbers, disabled trunks, suspended mailboxes and mailboxes of a customer
  with `voicemail_enabled=false` are IN with `enabled: false`; a deleted
  mailbox is OUT (54's arm filters it); customer status is NOT applied.
- **`HIDDEN_PRODUCTS = ("api",)`** — API Calling is retired: hidden from every
  customer-facing list and the admin counts regardless of
  `API_CALLING_ENABLED` (the arm stays in the view — FS must 603 it — and in
  `/numbers/my` + `/search/did`). It is pruned at plan time (constant-false
  arm), so `api_dids` is not even read.
- **`PRECEDENCE`** (rcf, api, trunk, voicemail, ivr) = FreeSWITCH's STEP-1 order:
  a DID in two product tables is listed once, the earlier product wins; also
  the display order of every `by_product` object (unknown products after, by
  name).
- **Tenant shape** = `TENANT_NUMBER_KEYS` (`number, name, product, enabled,
  forwards_to`; `forwards_to` rcf only). `product_ref_id` / `customer_status`
  are never selected; `customer_id` only reaches the admin `/numbers/owned`.
- **Performance:** `owned_numbers_sql("$1::int")` pushes `customer_id = $1`
  into every UNION ALL arm: `idx_rcf_customer`, `idx_trunks_customer` ->
  `idx_trunk_dids_trunk` (migration 57), `idx_voicemail_boxes_customer`,
  `idx_ivr_numbers_customer` (59) (`idx_api_did_customer` for the raw view).
- **IVR (59) enrolled:** the `ivr` arm lists every IVR number of the customer
  (`product_name` = the number's name, `enabled` = number on AND
  `ivr_enabled` AND a published flow bound) — so Reporting, the dashboard,
  `/customers/me`, `/numbers/owned`, `/numbers/my`, `/search/did` and the IVR
  transfer picker (`GET /v1/ivr/destinations`) pick it up with no further code. It is a tiny CTE; the CDR scan
  stays on `idx_cdrs_customer_time`. `tests/test_customer_numbers.py` EXPLAINs
  it on production-like volume (default planner too).
- **CDR filters:** `product_filter()` — `product_type` `all`/empty = no
  filter (`/cdrs`, `/cdrs/summary`, `/cdrs/activity`; `/activity` still
  defaults to rcf when omitted). `parse_number_param()` + `cdr_customer_number_sql()`
  back the `number` param (exact canonical match on the customer-side number,
  422 `number must be a phone number`). The SQL canonicalizer agrees with
  `utils.phone.normalize_e164` on every CDR-shaped input; where they differ
  (formatted international, too-short `+`) SQL passes the raw value through —
  it can drop a call from a number, never attribute it to the wrong one.

### How a future product enrolls (checklist)

1. **Migration** (product table, then `CREATE OR REPLACE VIEW number_routing`):
   - add ONE arm, with every existing arm copied verbatim — same column list,
     order and types (CREATE OR REPLACE refuses any change);
   - arm columns: `product_type='<p>'` (a plain `^[a-z_]+$` word), `customer_id`,
     `product_ref_id`, `product_enabled` (the CUSTOMER-visible on/off),
     `product_name` (a **customer-safe label** — tenants see it), `forward_to`
     (NULL unless it forwards);
   - index the arm's customer path (`<table>(customer_id)`; see 57) and its
     `did` point lookup (FS);
   - `did_inventory_product_type_check += '<p>'`;
   - a `scripts/db/check_migrations.sql` row.
2. **FreeSWITCH:** `terminate_<p>` + a `TERMINATORS` entry in `inbound_router.lua`.
3. **Automatic from there:** Reporting numbers / picker / `numbers` filter, the
   dashboard numbers card + Numbers KPI + activity picker, `/customers/me`
   `counts.numbers`, `/numbers/owned`, `/numbers/my`, `/search/did` (generic
   `{name, enabled}` details) — no backend change.
4. **Optional UI polish:** one entry in `docker/ui/app/src/config/products.ts`
   (unknown products render with a title-cased fallback).
5. **Per product by design** (not lists of numbers): `number_inventory`
   assign / unassign / reconcile, `rate_cdr()`, the billing-estimate line, the
   product's own console page. Add a product-specific `details` branch to
   `/search/did` only if admins need more than `{name, enabled}`.

## main.py -- Application Lifecycle

### Startup (lifespan context manager)
1. `init_db()` -- creates asyncpg connection pool (parses `DATABASE_URL` with regex)
2. `schema_check.run_startup_check()` -- probes `information_schema.columns` for `cdrs.stir_outcome` / `stir_eff_actual` (47) and `leg` / `call_id` / `leg_attempt` (48), all bound by the ingest INSERT. Missing → logs **CRITICAL** with the exact remedy per migration file (`sudo -u postgres psql -d voip -f …/47_cdr_stir_outcome.sql`, `sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f …/48_cdr_call_legs.sql`); DB unreachable → WARNING. Never raises — the API keeps serving.
3. `init_redis()` -- creates redis-py async client with retry logic (5 attempts, 2s backoff)
4. Voicemail retention task (`services/voicemail/retention.run_forever`, unless `VOICEMAIL_RETENTION_ENABLED=false`)
5. Voicemail transcription worker (`services/voicemail/transcription/worker.start_if_enabled`) — ONLY when `VOICEMAIL_TRANSCRIPTION_ENABLED` is exactly `true`; one per uvicorn worker, cancelled at shutdown like retention (in-flight jobs are abandoned; the lease reaper re-queues them). See `docs/VOICEMAIL_TRANSCRIPTION_PLAN.md` §6
- Before all of that, at import AND at the top of the lifespan: `utils.access_log.install_access_log_redaction()` — a filter on the `uvicorn.access` logger ONLY that rewrites `t=<value>` (the voicemail playback token) to `t=<redacted>`. Import time matters: each `--workers 4` child runs uvicorn's `configure_logging()` and then imports `main`, so the filter survives uvicorn's dictConfig in every worker. Test: `tests/test_access_log_redaction.py` (incl. a fresh-process worker simulation).

### Shutdown
1. `services.ivr.assist.jobs.shutdown()` -- cancels in-flight Flow assistant jobs; each marks its `ivr_assist_jobs` row failed so the builder's poll ends
2. the transcription worker and the voicemail retention task are cancelled
3. `close_db()` -- closes asyncpg pool
4. `close_redis()` -- closes Redis connection

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
Two endpoints, no auth. Both check DB (`SELECT 1`) and Redis (`ping`). Returns `healthy` or `degraded`. `/health/detailed` additionally reports `components.schema` via `db.schema_check.check_cdr_schema()` (time-bounded): `healthy`, `degraded: cdrs is missing column(s) … <remedy>`, or `unknown: <error>`. `/health` (Docker healthcheck) deliberately does NOT include it.

### customers.py
CRUD for the `customers` table. Account types: `rcf`, `api` (RETIRED — create → 422 unless `API_CALLING_ENABLED`), `trunk`, `hybrid` (= RCF + SIP Trunking), `ucaas`.
- **Billing estimate** (`compute_billing_estimate`, `/me/billing` + `/{id}/billing`): RCF line (by provisioned rcf_numbers count), SIP Trunking line (trunk/hybrid), API Calling line ONLY when `API_CALLING_ENABLED` — retired ⇒ hybrid (Granite Telephony) shows rcf + trunk only.
- **`/me` counts**: `{rcf, api_dids, trunks, numbers}` — `api_dids` is 0 (not queried) while API Calling is retired; `numbers = {total, by_product}` is product-agnostic (`customer_numbers.count_by_product_sql` + `numbers_count`; zero-count products omitted, api hidden even with the flag on).
- **Voicemail billing:** NO estimate line (decision D5 / owner decision O1); the commented-out block in `compute_billing_estimate` shows the shape if it is ever priced (count live boxes only).
- Delete is transactional: wraps cascading deletes of `rcf_numbers`, `api_dids`, `trunk_dids`, `trunk_auth_ips`, `sip_trunks`, `api_credentials` in a single `conn.transaction()`.
- Delete refuses (409, never a FK 500) a customer with a live voicemail mailbox or active voicemail key ("Erase their voicemail first") and, after a crypto-erase, a customer whose erased key row is the permanent tombstone (migration 54 `ON DELETE RESTRICT`). Guarded by `voicemail_schema_present` so it works before 54 is applied.
- Balance operations: `GET /{id}/balance` computes `available = balance + credit_limit`, `POST /{id}/credit` adds to balance.

### rcf.py
RCF (Remote Call Forwarding) number provisioning. The core RCF product.
- **Authorization** (mirrors trunks.py): reads (`GET` list + by-DID) are tenant-scoped via `get_customer_filter` — non-admins only see their own customer's entries (the list endpoint force-overrides any `customer_id` query param; by-DID cross-tenant returns 404, never 403, so existence is not leaked). Create and delete are admin-only (`require_admin`) — provisioning flows; customer number release goes through `/numbers/{did}/unassign`. Update (PUT/PATCH) is customer self-service, tenant-scoped, with `max_channels` admin-only.
- E.164 validation for DIDs, flexible validation for forward destinations (E.164 or 3-6 digit local extensions for PBX/Zoiper testing)
- `ring_timeout` validated between 5-120 seconds
- Update/Delete accept both numeric ID and E.164 DID string as the `{identifier}` path param
- On update, still deletes the Redis `rcf:{did}` key (harmless legacy). FreeSWITCH no longer reads that cache — it looks up PostgreSQL on every call (`inbound_router.lua`), so a change applies on the next call regardless
- PATCH is an alias for PUT (both call `update_rcf`)

### calls.py
API call origination with tiered CPS enforcement. **RETIRED product** — mounted only when `API_CALLING_ENABLED` (see "Retired / removed products"); every route also depends on `config.require_api_calling_enabled` (404 when off).
- **STIR/SHAKEN attestation-A gate (Task 2.2, layer 1):** the from_did lookup in `create_call` (enabled `api_dids` row + tenant-scope check, cross-tenant → 404 no-leak) is the ownership verification that justifies attestation A. The single originate site passes `stir_attest="A"` to `originate_call`; `api_outbound.lua` re-verifies on dialplan paths and Kamailio coerces anything else to B. Do NOT weaken the from_did lookup without revisiting the STIR policy.
- Tiers: `api_basic` (5 CPS, $0.01/call), `api_standard` (8 CPS, $0.008/call), `api_premium` (15 CPS, $0.005/call)
- CPS check uses Redis sliding window (`check_cps_limit` in redis_client)
- Velocity check (calls per minute) as a secondary guard
- Per-call fee applied as a `BackgroundTasks` job (raw `customers.balance` decrement; the demo's ledger-posted variant was removed)
- Call status: checks `active_calls` table first, then falls back to `cdrs` table for completed calls
- Uses ESL client to originate via FreeSWITCH

### trunks.py
SIP trunk management with call path packages.
- Trunk auth types: `ip`, `credential`, `both`
- Call path packages: predefined capacity tiers stored in `call_path_packages` table, assigned via `PUT /{trunk_id}/call-paths`
- Sub-resources: `/{trunk_id}/ips` for IP ACL management, `/{trunk_id}/dids` for DID assignment
- `GET /{trunk_id}/stats`: real-time channel count via ESL `show channels as json`, plus last-hour CDR aggregates (ASR, avg duration, cost). Tenants get `avg_duration_minutes` and no cost (see Tenant redaction); admins keep `avg_duration_sec` + `total_cost`.
- Cache invalidation on IP delete (`trunk_ip:{ip}`)

### cdrs.py
CDR ingestion and querying. The largest router file.
- **Ingest**: Parses FreeSWITCH JSON CDR format with robust field extraction:
  - Resolves fields from multiple locations: `variables` dict, `callflow[0].caller_profile`, top-level `core-uuid`
  - Cleans caller_id_number (handles SIP `"Display" <+1234>` format)
  - Quality (migration 50, `services/call_quality.py`): mos / r_factor come from OUR ITU-T G.107 E-model over TRUE loss (patched FS `rtp_audio_in_seq_*` vars, else `rtp_audio_in_jitter_loss_rate` fraction); per-leg rating rule (unanswered / short / no_rtp / no_media / low_sample / no_data / rated; no_rtp = in < 10 % while out ≥ 50 % of expected, no_media = no audio either way, not graded — migration 51); call-level worst-direction via `cdr_refresh_call_quality()`. Raw FS values kept in `fs_*` columns. See docs/CALL_QUALITY_ACCURACY_PLAN.md.
  - Extracts ~55 columns including full RTP quality metrics (jitter, packet loss, MOS, codec info), the on-net set `origin_customer_id`/`terminating_customer_id`/`on_net`/`on_net_hops` (records both parties of an internal call; `customer_id` stays the terminal so `rate_cdr()` is unchanged; off-net → `origin==customer`, `on_net=false`), and the inbound-carrier attribution pair `inbound_carrier`/`inbound_carrier_pop` (FS channel vars, migration 40; absent/empty → NULL)
  - Explicit `::type` casts on all INSERT parameters for asyncpg/PgBouncer compatibility (the INSERT binds 60 positional params, `$1`–`$60`; on-net columns are `$50::int`/`$51::int`/`$52::bool`/`$53::smallint`, inbound-carrier `$54::varchar`/`$55::varchar`, STIR outcome `$56::text`/`$57::text`, leg split `$58::varchar` leg / `$59::varchar` call_id / `$60::smallint` leg_attempt)
  - Millisecond durations (`billmsec`/`mduration`, seconds×1000 fallback) and µs timestamps (`*_uepoch`, `*_epoch` fallback) — `_ms_duration` / `_leg_timestamp`
  - Duplicate detection via `WHERE NOT EXISTS` (the cdrs table uses a composite PK for TimescaleDB)
  - **Three-tier fallback** (`_cdr_insert_sql(with_stir_outcome, with_call_legs)` / `_execute_cdr_insert`): full 60 → pre-48 57 → pre-47 55, strict tail truncations, on `asyncpg.UndefinedColumnError` naming a 48 / 47 column; ERROR once per 300s per tier. Other missing columns are NOT swallowed. `allow_fallback=False` for B rows (dropped instead — a B row without `leg` would count as a call).
  - **A/B leg split** (contract `docs/CDR_LEG_SPLIT_CONTRACT.md`): A-legs write `leg='A'`, `call_id=uuid`. Topology B-leg (`stir_outcome.b_leg_a_uuid`) + `cdr_leg=B` + `cdr_carrier_leg=true` + `CDR_B_LEG_ROWS` on → `_b_leg_row_context` (attribution ONLY from `cdr_*` vars; `cdr_customer_id`/`cdr_call_id`/`cdr_product_type` required else dropped; direction forced `outbound`) → `_insert_b_leg_row`. Otherwise no row. `_b_leg_stir_update`: STIR UPDATE onto the A-leg only from an ANSWERED carrier leg. `_store_call_attestation`: A-leg only. `cdr_leg=B` on a topology A-leg → kept as the A row (ERROR). Result status for every B-leg body is `b_leg`.
  - Always returns 200 to prevent FreeSWITCH retry storms
  - **Visual IVR (migration 60):** when an A-leg CDR carries any `ivr_*` var (`ivr_flow_id`, `ivr_flow_version`, `ivr_exit`, `ivr_path`, `ivr_transfer_to`, `ivr_seconds` — contract §5.5), `_apply_ivr_columns` runs ONE `UPDATE cdrs … WHERE uuid = $1 AND start_time = $2` after the INSERT (inserted or duplicate; idempotent; constant `start_time` bound = one chunk). Junk values -> NULL (exit `^[a-z_]{1,16}$`, transfer_to E.164, path truncated at 512 with `…`, seconds clamped >= 0). No ivr var -> no statement at all: every other product's ingest is unchanged and the 73-param INSERT / tier fallback is untouched (so 60's columns are NOT in `schema_check.REQUIRED_CDR_COLUMNS`). A missing 60 is an ERROR log (rate-limited) with the remedy; the call row still lands.
- **Query**: `GET /v1/cdrs` with filters (customer, trunk, product_type — `all`/empty = every product —, direction, destination, `number` — the customer's number on the call, exact canonical, `customer_numbers.cdr_customer_number_sql` —, date range, rated_only). Defaults to last 24 hours. Tenant callers get the redacted allowlist shape (see the Tenant redaction section). **One row per call by default** (`ONE_ROW_PER_CALL_SQL` = `leg IS DISTINCT FROM 'B'`, applied in `_build_cdr_filters`, so list + total + all summary groupings agree). Staff-only `leg=calls|all|b` (`LegView`) and `call_id=` (all legs of one call: `(call_id = $1 OR uuid = $1)` — chosen over `COALESCE(call_id, uuid) = $1` so idx_cdrs_call_id + idx_cdrs_uuid BitmapOr; REPLACES the date window; page capped at `CALL_ID_LOOKUP_LIMIT`=50). Staff rows add `leg`, `call_id` (`COALESCE(call_id, uuid)`), `leg_attempt` (`_STAFF_LEG_COLUMNS_SQL`).
- **Summary**: `GET /v1/cdrs/summary` grouped by day, hour, or destination prefix — same builder, same `leg`/`call_id` semantics.
- **Other one-row-per-call surfaces** (`leg IS DISTINCT FROM 'B'`): `trunks.py` last-hour stats (tenant + staff), `sbc.py` `/stats`, `search.py` DID call history, `calls.py` completed-call lookup, `reports.py` (all), `scripts/backup/asr_guard.sh` (no longer depends on `direction`). The `call_attestations` → `cdrs` LATERAL joins match by `uuid` = the A-leg uuid, so they never hit a B row.
- **Rating**: `POST /v1/cdrs/{uuid}/rate` calls a PostgreSQL function `rate_cdr()`.

### search.py
Admin-only search tools. Uses `require_admin` dependency on all endpoints.
- **DID search**: `GET /v1/search/did?q=617` -- rows from the `number_routing` view (every product incl. voicemail and api) JOIN customers, LIKE on normalized digits, paged FIRST (`ORDER BY did, product precedence`), then `details` built for the page only by correlated sub-selects on `product_ref_id` / `trunk_id`: rcf/api/trunk keys + `status` byte-identical to the old per-table UNION (golden-compared in `tests/test_customer_numbers.py`), voicemail `{label, mailbox_id, enabled}`, a future product `{name, enabled}`.
- **DID call history**: `GET /v1/search/did/{did}/calls` -- matches CDRs where the DID appears as caller or callee.
- **User search**: `GET /v1/search/user?q=john` -- ILIKE on name/email, optionally scoped to a customer_id.
- **Users by customer**: `GET /v1/search/user/by-customer/{id}` -- all users for a customer.
- All search endpoints use `COUNT(*) OVER()` window function for total count with pagination.

### number_inventory.py
Complete DID lifecycle management backed by the `did_inventory` table.
- **Admin endpoints**: `GET /inventory` (paginated, filterable — incl. `carrier=`, matching the COALESCEd attribution so `carrier=bandwidth` also finds legacy NULL rows), `GET /stats` (counts by status/product/state/carrier), `POST /sync` (upsert from Bandwidth API, then reconciles product tables), `POST /reconcile` (reconcile `did_inventory` against rcf/api/trunk product tables without calling Bandwidth — internal `_reconcile_product_tables()`; never touches `source`/`carrier_trunk_id`), `POST /add` (manual DID intake), `PUT /{did}/carrier-trunk` (re-associate/clear attribution), `POST /{did}/assign`, `POST /{did}/unassign`
- **Manual intake + carrier attribution (migrations 41 + 42)**: every row carries `source` (`bandwidth_sync`|`manual`), nullable `carrier_trunk_id` FK → `carrier_trunks`, and a first-class `carrier` column (42; NULL = legacy implicit Bandwidth). Item/filter/stats carrier is `COALESCE(d.carrier, ct.carrier, 'bandwidth')` (`_CARRIER_COALESCE`; the item shape folds it in Python via `_shape_item` — d.* already emits a `carrier` column, and `dict(asyncpg.Record)` resolves duplicate names to the FIRST occurrence, so a SQL alias would silently return the raw NULL). `POST /add` takes `{dids: [1..500], carrier (REQUIRED, lowercased), carrier_trunk_id?, notes?}`: the carrier must have ≥1 ENABLED trunk row (404 "unknown carrier" otherwise — a carrier with only disabled trunks counts as unknown); the optional trunk must belong to that carrier and be enabled (422 otherwise — body-consistency, unlike the 404-able carrier). Normalizes via the shared `utils.phone` E.164 helper, dedupes in-batch, `ON CONFLICT DO NOTHING`, inserts `carrier` + nullable `carrier_trunk_id`, and returns the EXACT envelope `{"added": [e164], "skipped_existing": [e164], "invalid": [raw], "count": n}` (TED UI codes against it). Added DIDs land `available`/`manual` and flow through the existing assign path unchanged. **Sync ownership guard**: `POST /sync` only manages `source='bandwidth_sync'` rows (`_compute_sync_sets()`) — manual rows never appear in its report-only `removed` list and are never metadata-updated, even when their DID shows up in the Bandwidth feed (sync-inserted rows leave `carrier` NULL → render 'bandwidth'). `PUT /{did}/carrier-trunk` accepts a disabled trunk (attribution is metadata; only NEW intake demands an enabled one); setting a trunk also syncs `d.carrier` to that trunk's carrier, clearing (null) drops only the trunk and leaves `d.carrier` as-is; returns the full inventory-item shape.
- **Owned numbers**: `GET /owned` (admin) — counts from `number_routing` via `customer_numbers.owned_counts_sql` / `shape_owned_counts` (`did_inventory` lags: `POST /rcf` and `POST /trunks/{id}/dids` never write it). `/stats` stays the inventory/lifecycle view.
- **Customer endpoints**: `GET /available` (browse available DIDs), `GET /my` (customer's assigned numbers, includes `status`; `did_inventory` rows UNION ONE `number_routing` fallback arm with the same `NOT IN did_inventory` predicates as before — every product incl. voicemail/api, fallback-only rows `assigned_at: null`), `POST /{did}/request` (reserve a number for admin review), `POST /{did}/request-release`, `POST /{did}/cancel-release`
- **Release workflow (request-based)**: customers cannot unassign directly. `POST /{did}/request-release` (tenant-scoped: non-admins only their own DIDs, cross-tenant → 404 no-leak; 409 unless status is 'assigned') sets `assigned` → `release_requested` and appends an audit line to `notes`. Admin approves via `POST /{did}/unassign` (its status guard accepts 'assigned', 'reserved', and 'release_requested') or denies via `POST /{did}/cancel-release` (back to 'assigned'; the customer can use it to withdraw). The `release_requested` status is added to the CHECK constraint by `34_release_requested_status.sql`; `GET /my` includes it in its status filters so pending-release numbers still show for the customer.
- Assign creates the product record (e.g., `rcf_numbers` row for RCF) inside a transaction
- **IVR (`product_type: "ivr"`, optional `name`; contract §8.3):** `services/ivr/store.assign_number` — one transaction: lock the inventory row (available/reserved), refuse a DID `number_routing` already routes (409), INSERT `ivr_numbers`, assign `did_inventory` (`product_ref_id` = ivr_numbers.id) and set `customers.ivr_enabled = true` if it was false (the voicemail side-effect rule). Unassign deletes the `ivr_numbers` row (the customer's flows stay, unbound) and frees the DID; reconcile has an `ivr` arm (`by_product.ivr`). Voicemail assign still takes `label`; only ivr takes `name`.
- **API Calling retired:** `AssignRequest` / `NumberRequest` reject `product_type='api'` (422 "API Calling is retired: …") unless `API_CALLING_ENABLED`; `/inventory`, `/my`, `/stats`, `/reconcile` and `/unassign` still handle existing api rows (admin cleanup)
- Unassign removes the product record and resets status to 'available'
- Sync is idempotent: inserts new TNs as 'available', updates metadata on existing, flags removed TNs
- All assignment changes invalidate relevant Redis caches and are logged

### voicemail.py
Encrypted voicemail product API (contract `docs/ENCRYPTED_VOICEMAIL_INTERFACES.md` §4/§5 — §4.9 and the §5 server notes are the as-built refinements). Mounted at `/v1/voicemail` + `/voicemail`; logic in `services/voicemail/`.
- **Scope** (`vm_scope`): admin = `customer_id` param (lists) / unscoped per-id; `user`/`readonly` = own customer, another customer's object or param → 404, voicemail-disabled customer → `[]` / `enabled:false` / 404; `readonly` = reads + playback tokens only (`vm_writer` 403s mutations); `support` → 403. Handler `detail`s are short user-facing sentences (the UI shows them).
- **FS routes** `/fs/mailbox/{id}`, `/fs/greetings/{id}/audio`, `/fs/deposit` are JWT-exempt and carry `Depends(require_ingest_secret)`. Deposit (`services/voicemail/deposit.py`): strict X-VM-Meta (`meta.py`), 10 MB cap (Content-Length 413 before reading + streamed counter), 5 concurrent per worker (503 + Retry-After 2), lenient-size WAV parse (`wav.py`, mirrors FS `wav_duration_ms`), `pending` row FIRST with a fencing token + lease (`deposit_attempt_id`/`deposit_lease_until`, migration 54), idempotent on msg_uuid (stored → 200 same id; live lease → 503; failed/expired → takeover; purged → 409), 11 s deadline WITHOUT cancelling the seal (late seals finalize in the background under a renewed lease), `deposit` audit in the same transaction as `stored`.
- **Playback**: `POST …/playback-token` (body optional) → `{url: /api/v1/voicemail/{kind}s/{id}/audio?t=…, expires_in: 120}`; marks read. `GET/HEAD …/audio?t=` (JWT-exempt): decrypt once per token per worker into `audio.PLAYBACK_CACHE` (64 MB), audit `play`/`download`/`greeting_play` once per token across workers (`uq_vm_access_log_playback_jti` + ON CONFLICT DO NOTHING) BEFORE serving (audit failure → 503), Range/206/416, HEAD from `size_bytes`, `Cache-Control: no-store`.
- **Lifecycle**: `services/voicemail/mailboxes.create_mailbox` (KMS key ensured BEFORE the claim transaction; DID claim + box + `voicemail_enabled=true` + audit atomic) and `delete_mailbox` (deleted + DID available + audit, then purge objects→rows; leftovers → retention) are shared with `number_inventory.py`; `erase_customer` destroys the KMS key first. Retention (`retention.py`) runs in every worker under `pg_try_advisory_xact_lock`; `VOICEMAIL_RETENTION_ENABLED=false` disables it.
- **Transcription v1.1** (contract `docs/VOICEMAIL_TRANSCRIPTION_PLAN.md` §10/§13; owner decisions §0.1 win — O2 = admin-only switch). Logic in `services/voicemail/transcripts.py`; the router only scopes. Every Message carries `transcript {status, confidence}` via `LEFT JOIN voicemail_transcripts t ON t.message_id = m.id` (`vmt.SUMMARY_COLUMNS`/`SUMMARY_JOIN`) — the list stays one query and never decrypts; no row → `pending` if the mailbox transcribes else `disabled`. Mailboxes carry `transcription_enabled`/`transcription_language` (`MAILBOX_SELECT`/`MAILBOX_FIELDS`); PATCH of either from a non-admin → 403, off→on while `transcription.config.available()` is false → 409, bad language → 422, `false` flips that mailbox's `pending` rows to `disabled` in the PATCH transaction. `GET /messages/{id}/transcript` decrypts through `vmt.SLOTS` (4 per process, 2 s wait → 503; a slot is held until KMS returns even if the reader leaves — that bounds the shared vm-io pool) and commits a `transcript_view` audit BEFORE returning text (fail-closed 503); snippets share the slots with one 2 s budget, one audit row per batch and never 5xx. Retry (writer; `force` admin), backfill (admin), status + requeue (admin). Mailbox delete and crypto-erase delete transcripts in their transactions (plan §9). Never log transcript text — ids and exception class names only. Gotcha: never bound an `UPDATE … WHERE id IN (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)` — a rescanned subquery skips rows the same command already updated and the UPDATE exceeds n; use a `WITH pick AS MATERIALIZED (…)` CTE (`vmt.REQUEUE_SQL`).
- Tests: `tests/test_voicemail_api.py`, `test_voicemail_deposit.py` (incl. the REAL FS Lua encoder via `lua`), `test_voicemail_retention.py`, `test_voicemail_billing.py`, `test_voicemail_transcription_api.py` (shared harness `tests/voicemail_api_harness.py`; `Harness.seed_transcript` seals real transcripts with the local KMS).

### ivr.py
Visual IVR product API (contract `docs/IVR_INTERFACES.md` §8.2 customer / §8.3 admin; plan `docs/IVR_PRODUCT_PLAN.md`). Mounted at `/v1/ivr` + `/ivr`; main.py also registers `ivr.IvrApiError` -> `ivr_error_handler` (bodies `{"detail": <code>, ...extra}`: `stale_revision` + `current_revision`, `invalid_flow`/`invalid_graph` + `errors`/`warnings` (`Issue` = `{code, message, node_id?, handle?}`), `prompt_in_use` + `flows`, `flow_in_use` + `numbers`). Logic in `services/ivr/`; the router only scopes and runs the transactions.
- **Scope** (`ivr_scope`, the voicemail `vm_scope` pattern): admin = `?customer_id=` (or the admin JWT's own `customer_id`); an admin JWT with `customer_id = null` and no param -> **400 `customer_id required`** (the portal's "View as Customer" PreviewPrompt). `user`/`readonly` = own customer; another customer's param or object -> 404. `readonly` = GETs + the read-only POSTs `validate` / `simulate` / `playback-token` (`ivr_writer` 403s the rest). `support` -> 403.
- **Entitlement:** every route except `GET /summary` -> **403 `ivr_not_enabled`** while `customers.ivr_enabled` is false (TED `PUT /admin/customers/{id}/entitlement`, or set by the first IVR number assign).
- **Never trust the browser (D2):** `publish {revision}` compiles the STORED draft at that revision on the server. ONE transaction: `FOR UPDATE` the flow, revision check (409), per-customer advisory lock (`store.IVR_LOCK_CLASS`), compile + dial policy against the customer's live prompts and CURRENT numbers (`customer_numbers.owned_numbers_sql`) and the numbers bound to this flow (self-transfer), every prompt sha present in `ivr_prompt_audio` (`FOR KEY SHARE` — blocks the audio GC), INSERT the immutable `call_flow_versions` row (`published_by` = actor), flip `published_version_id`. Any failure rolls back everything (tested by an injected trigger fault).
- **Drafts:** `POST/PUT /flows` store `draft_graph` verbatim (unknown fields round-trip) after `compiler.check_graph_shape` (exactly one Start, valid unique ids, <= 200 blocks / 1000 edges / 512 KB) -> else 422 `invalid_graph`. `PUT` / `restore` need the current `revision` (+1 per write; stale -> 409). `DELETE` -> 409 `flow_in_use` while any `ivr_numbers.flow_id` points at it.
- **Numbers:** `PUT /numbers/{id} {name?, flow_id?}` — the flow must be the same customer's (404 otherwise; 59's composite FK backs it); binding a flow whose PUBLISHED plan transfers to this very number -> 422 (loop). `name: null` clears, absent leaves it.
- **Prompts:** TTS (`POST /prompts/tts`, sidecar render -> canonical 8 kHz WAV) or upload (`multipart` `file` + `name` [+ `kind` upload|recording]; Content-Length required, <= 24 MB raw, any PCM16 WAV 8-48 kHz mono/stereo -> canonical, else 422). Limits under the advisory lock: <= 100 live prompts, <= 50 MB distinct audio per customer. `DELETE` -> 409 `prompt_in_use {flows:[{id,name}]}` while any DRAFT uses it; soft delete (audio kept) while a published version plays it; otherwise the row is deleted and its audio garbage-collected once no prompt row and no version plan references the sha (audio row locked FIRST, then the checks). Playback: `POST /prompts/{id}/playback-token` -> `{url: /api/v1/ivr/prompts/{id}/audio?t=…, expires_in: 120}` (auth/playback kind `ivr_prompt`, `VOICEMAIL_PLAYBACK_SECRET`); `GET/HEAD …/audio` is JWT-exempt (middleware `is_ivr_exempt`) and serves the canonical WAV, `no-store`. `POST /prompts/tts-preview` (writers) renders without storing; 30 / minute / user (Redis fixed window shared by every worker; in-process sliding window when Redis is down — then per worker) -> 429 + Retry-After.
- **TTS render cache:** `sha256(engine_version|voice|text)` (engine_version = the sidecar's per-voice `version`) -> canonical sha, in-process LRU + Redis `ivr:tts:<key>` (30 days), used only while that audio row still exists. Piper (VITS) adds sampling noise, so two renders of the same text are NOT bit-identical: the cache is what makes the same text reuse one audio row.
- **Destinations** (`GET /destinations`): the customer's numbers from `customer_numbers` grouped rcf / voicemail / ivr / trunk with a human `detail` ("Forwards to +1 774-404-5256", "Mailbox: …", "IVR: <flow>", "SIP trunk: …").
- **Admin (TED, `require_admin`):** `GET /admin/customers/{id}` (+ `ivr_assist_enabled` once migration 61 exists), `PUT /admin/customers/{id}/entitlement {enabled?, assist_enabled?}` (at least one; one transaction; → `{ivr_enabled, ivr_assist_enabled}`; `{enabled}` alone is the unchanged pre-assistant request), `PUT /admin/numbers/{id} {enabled?, max_channels? (1-500), name? (null clears)}` (the kill switch), `GET /admin/flows/{id}/versions[/{v}]` (read-only). Tenants never see a staff publisher's email on `GET /flows/{id}/versions` (`published_by_email: null`).
- **Flow assistant hooks** (the assistant itself is `ivr_assist.py`): `GET /summary` adds `assist: {available}` (`assist_jobs.available(customer_flags)` — never says why); `POST /flows/{id}/simulate` takes `assist_job_id` (draft_graph ignored; the job's stored proposal is compiled by `assist.pipeline.compile_proposal` = the real context + one synthetic `PromptRef` per new message, so `says` shows the new messages by name). `assist_jobs.customer_flags` is the one reader of `ivr_enabled` / `ivr_assist_enabled` for summary and admin; before 61 it returns `ivr_assist_enabled: None` and nothing references the missing column.
- Tests: `tests/test_ivr_api.py` (ephemeral PG, real routers + middleware, fake sidecar; `IvrHarness.IVR_MIGRATIONS` = 59, 60, 61), `test_ivr_compiler.py` (golden fixtures `tests/fixtures/ivr/`), `test_ivr_policy.py`, `test_ivr_simulator.py`, `test_ivr_audio.py`, `test_ivr_migration.py`.

### ivr_assist.py
Visual IVR **Flow assistant** API (contract `docs/IVR_ASSIST_INTERFACES.md` §5; TED owns the AI step, CRAG never calls a model). Mounted next to `ivr.py` at `/v1/ivr` + `/ivr`, reusing its `ivr_scope` / `ivr_writer`, `_require_entitled` (403 `ivr_not_enabled`), `_scoped_flow` (404 for another tenant's flow), `_check_draft` and `IvrApiError` bodies. The router only validates and scopes; `services/ivr/assist/jobs.py` raises `AssistRejected(status, code, **extra)` which the router turns into `IvrApiError`.
- **`POST /flows/{id}/assist`** (writer) `{message, conversation_id?, refine_job_id?, draft_graph?}` → 202 `{job_id, conversation_id}`. Message: control characters → spaces, trimmed, 1-2000 chars (422). Base = the refine job's proposal (`refine_job_id`: same flow + customer, done, a proposal, no outcome yet — else 404 / 409 `assist_not_refinable`; the conversation follows it), else `draft_graph` (§2 shape checked like a save → 422 `invalid_graph`), else the stored draft; only the seeded Start → `base: null`; > 60 blocks / 300 connections → 422. Order of refusals: entitlement 403 → flow 404 → availability 403 `ivr_assist_not_enabled` → rate limit 429 `assist_rate_limited` (+ `retry_after_s`, `Retry-After`) → in the locked transaction: 409 `assist_busy`, 429 `assist_daily_limit`, refine 404/409. An unknown, foreign or > 24 h old `conversation_id` silently starts a new conversation (the response carries the id in use).
- **`GET /flows/{id}/assist/{job_id}`** (readers too) — a job of another flow / tenant or a malformed id → 404. `error` = `{code, message}` with CRAG's §5.3 sentence (+ `retry_after_s` for `assistant_busy` when TED sent one); TED's message is never returned.
- **`POST /flows/{id}/assist/{job_id}/outcome`** (writer) `{outcome}` → 204, recorded once.
- **Job internals** (`jobs.py`): row created `running` inside the POST transaction; the task (`jobs.start`, strong ref in `_TASKS`) loads `store.load_context` + live prompts (TTS text; uploads have none) + the conversation's earlier jobs (history = customer message + the assistant's summary / question / refusal of each DONE job, last 10 turns; outside numbers = the latest `result.state.external_numbers`), runs `pipeline.run` with a 280 s start-no-new-call deadline, and stores `result = {"public": §5.2 shape, "state": {...}}` + `rounds` + `ted_request_ids` with `WHERE status='running' AND created_at > now() - 300 s` (a stale row stays failed). Crash / cancel → `failed` `assistant_failed`. `max_new_prompts` = min(20, 100 − live prompts) so Accept never exceeds the prompt cap. Tests: `tests/test_ivr_assist_api.py`, `test_ivr_assist_pre61.py`, `test_ivr_assist_unit.py`, `test_ivr_assist_eval.py`.

### carriers.py
Admin-only CRUD for `carrier_gateways` (display/config cards — Bandwidth Dallas/LA + Sinch rows from migrations 46/53; not on the call path). `POST /{carrier_id}/test` probes carrier reachability.

### carrier_trunks.py
Admin-only CRUD for `carrier_trunks` (migrations 40 + 42) at `/v1/carrier-trunks` — the multi-carrier trunk registry (Bandwidth + Sinch). Uniqueness (migration 53): one ingress row (`inbound`/`both`) and one egress row (`outbound`/`both`) per `source_ip` (partial unique indexes `carrier_trunks_ingress_ip_key` / `carrier_trunks_egress_ip_key`) + UNIQUE (carrier, pop) — any lookup by IP must filter direction. TWO downstream SQL contracts ride these column names — never rename: (1) the Kamailio SBCs via sqlops (`freeswitch` DB role) as the DB-backed trust fallback for unknown-source INVITEs: `SELECT carrier, pop, cps_limit FROM carrier_trunks WHERE source_ip = '$si'::inet AND direction IN ('inbound','both') AND enabled = true`; (2) FreeSWITCH's outbound carrier-failover Lua, per zone `<z>` in east/west/central: `SELECT carrier, pop, host(source_ip) AS term_ip, COALESCE(priority_<z>, priority) AS eff_priority FROM carrier_trunks WHERE direction IN ('outbound','both') AND enabled = true ORDER BY eff_priority, id` (disable a trunk here → it leaves every zone's termination list on the next call). Priority fields (42): `priority` (default 100, lower = tried first, ≥1, NOT NULL — PUT rejects explicit null) + nullable zone overrides `priority_east`/`priority_west`/`priority_central` (≥1; explicit null on PUT clears back to inheriting `priority`). Validates `source_ip` with `ipaddress` (bare IP, no CIDR), direction as a `Literal` enum, `cps_limit > 0`; `_conflict_409` maps each unique index to a distinct 409 (ingress slot, egress slot, legacy pre-53 `carrier_trunks_source_ip_key`, carrier+pop) on POST and PUT; PUT is a partial update via `exclude_unset` (nullable fields clearable); `carrier` is immutable (delete + recreate to re-home an IP). Returns `host(source_ip)` as text.

### rates.py
Admin-only management of `rate_tables` / `rates`. Plus `GET /margins` (rate vs cost analysis) and `GET /lookup` (longest-prefix rate match for a destination).

### tiers.py
Admin-only CRUD for `cps_tiers`. Convenience filters `GET /trunk` and `GET /api` return tiers of that type. While API Calling is retired `GET /api` → 404 (route kept so it doesn't fall into `/{tier_id}`) and `tier_type='api'` is rejected (422) on create/update; `GET ""` still lists existing api rows.

### sipp.py
Admin-only SIPp load-test control. `GET /presets` lists scenarios; `POST /run` triggers a test. The SIPp runner service is not yet deployed, so `POST /run` returns a mock result or 503.

### sbc.py
Admin-only `GET /stats`: per-SBC call distribution over the last N minutes, aggregated from `cdrs.sbc_id` (the column added in `18_sbc_id_column.sql`). Used to monitor SBC failover/load-balancing health.

### homer.py
Admin-only SIP trace search for Homer 10. Queries qryn (Loki-compatible API over ClickHouse) — there is no Homer 7 JWT flow. `GET /aliases` returns a static IP-to-name map for ladder diagrams. `POST /search` runs a phone-number search (qryn) and A/B-leg correlation (`_correlate_legs`; pure helpers in `homer_correlation.py`): (a) X-CID harvested from fetched INVITEs, (b) a ClickHouse `samples_v3` X-CID scan bounded to each A call's setup window + fingerprint -> call_id via `time_series`, (c) the `cdrs` B rows (failure-isolated, 3 s). heplify's `call_id` label is each packet's OWN Call-ID — there is no A-leg label. Leg fetches go to ClickHouse directly via `IN (...)` (qryn's RE2 engine 500s on large Call-ID alternations), chunked + paginated. Additive response fields: `legs` (`{callid: {role, a_callid, attempt}}`), `correlation_status` (`ok`/`partial`/`degraded`), `correlation_reason`; `correlation_truncated` is deprecated. Correlation never fails a search. `GET /pcap?correlated=true` uses the same engine (`X-Pcap-Correlation` header). Tests: `tests/test_homer_leg_correlation.py` (+ shared ClickHouse fake `tests/homer_ch_fake.py`).

### onboarding.py
New-customer intake pipeline (`pending → completed`, or `→ rejected` — status-only since migration 27; billing/provisioning are external). Backed by `onboarding_requests`. `POST ""` is the **public, unauthenticated** intake form (exempted in middleware). All other endpoints (`GET` list/detail, `complete`, `reject`) require admin.

**FCC KYC (FCC 26-27 FNPRM, adopted 2026-04-30):** the POST requires a nested `kyc: KycPayload` — `{is_high_volume, standard: KycStandard, high_volume: KycHighVolume|null, declared_peak_cps, declared_max_concurrent_calls}` — validated with Pydantic V2 (`Literal` enums, `@field_validator` + `@model_validator(mode="after")` for cross-field rules: EIN format NN-NNNNNNN, `state_of_registration` required for `state_registration`, `intended_use_description` required for `other`, `high_volume` required iff `is_high_volume`, alternate phone must differ from main phone). **Capacity declarations (v2, REQUIRED, top level on KycPayload):** `declared_peak_cps` int 1-1000 + `declared_max_concurrent_calls` int 1-100000. **Granite's high-volume threshold** (provider-defined per FCC 26-27; REPLACES the old 50k calls/month `model_validator` on `OnboardingSubmit`, now removed — `monthly_volume` is informational only): `KycPayload.validate_high_volume` forces `is_high_volume=true` (+ the block) when `declared_peak_cps > 1` **or** `declared_max_concurrent_calls > 1000`; the 422 message contains "high-volume threshold" (frontend fuzzy mapping). Exactly at threshold = not over; voluntary opt-in below stays allowed; >1000 trunk call paths is declared here (TrunkIntake cap unchanged). `alternate_phone` reuses `utils.phone.normalize_e164`; originating IPs are validated syntactically with `ipaddress` (bare v4/v6 or CIDR ≤ /24 v4 / ≤ /64 v6; private ranges accepted). Persisted to the nullable `onboarding_requests.kyc` JSONB (migration `35_onboarding_kyc.sql` — the v2 capacity fields ride in the JSONB, no new migration) shaped `{standard, high_volume|null, declared_peak_cps, declared_max_concurrent_calls, submitted_at, form_version: 'fcc-26-27-fnprm-v2'}` via `json.dumps(...)` bound `$11::jsonb`. 4-year retention per FCC 26-27 is operational policy (no purge automation here).

**Product-aware intake (products-v2; v1 payloads still accepted):** v2 = v1 + an `ivr` product with block `IvrIntake {number_count 1-20, notes? <= 1000}` (present iff selected); a client may echo `form_version` `products-v1`|`products-v2` (v1 + ivr -> 422); the server stamps `products-v2` and a non-IVR document keeps v1's key set. The rest as v1: the POST also requires `products: ProductsPayload` — `{selected: list of 'rcf'|'trunk'|'api'|'voicemail' (min 1, no dupes), rcf?, trunk?, api?, voicemail?}` where each block must be **present iff selected** (`@model_validator` both directions). Rationale: each product needs different information to provision, so the form collects exactly the selected products' setup data. Blocks: `RcfIntake` (did_count/porting/forwarding_setup as `Literal`s of the exact form option strings — DID counts use EN dashes, porting uses EM dashes; `current_carrier` required when porting starts with Yes/Both), `TrunkIntake` (`signaling_ips` 1-10 validated with the same `_validate_ip_or_cidr` as KYC — **IP-peering only, no REGISTER auth**, so PBX/SBC public IPs are required to provision; `concurrent_call_paths` 1-1000; optional pbx_vendor/dids_needed), `ApiIntake` (use_case 1-300; optional expected_cps 1-1000 + http(s) webhook_url ≤255; needs_numbers bool; **retired — `ProductsPayload` 422s when `'api'` is selected or `api` is non-null unless `API_CALLING_ENABLED`, never silently dropped**), `VoicemailIntake` (mailbox_count 1-10000; attach_to Literal existing_numbers/new_numbers/unsure). Persisted to nullable `onboarding_requests.products` JSONB (migration `36_onboarding_products.sql`) as the validated payload + `form_version: 'products-v1'`, bound `$12::jsonb`. The legacy top-level RCF fields (`did_count`, `porting`, `current_carrier`, `forwarding_setup`) are now **Optional** on the model and nullable in the DB (36 drops NOT NULL); when 'rcf' is selected the INSERT backfills them from `products.rcf` (frontend-sent values win) so old admin queries stay meaningful — non-RCF submissions insert NULLs. Admin list/get decode `kyc` + `products` back to objects (`_decode_json_col` — no asyncpg JSONB codec is registered, so JSONB arrives as strings); pre-KYC/pre-products rows return null for those keys and stay fully operable.

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
- `create_access_token(data)` -- adds `exp` + `typ: "session"` (callers cannot override `typ`) and signs
- `decode_access_token(token)` -- validates and returns claims dict; rejects a token whose `typ` is present and != `"session"` (e.g. a voicemail playback token) and any token with an `aud`. Pre-`typ` tokens stay valid until they expire

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
- Encrypted voicemail (`is_voicemail_exempt`, evaluated on `scope["path"]`; control chars / dot segments never exempt): prefixes `/v1/voicemail/fs/` + `/voicemail/fs/` (every route there MUST `Depends(require_ingest_secret)`), and GET/HEAD `^/(v1/)?voicemail/(messages|greetings)/\d+/audio$` (route verifies the `?t=` playback token)
- Visual IVR prompt audio (`is_ivr_exempt`, same rules): GET/HEAD `^/(v1/)?ivr/prompts/\d+/audio$` only (route verifies the `?t=` token of kind `ivr_prompt`)

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
- `originate_call(uuid, from_did, to, customer_id, traffic_grade, webhook_url, timeout, stir_attest)` -- builds an originate command with channel variables. Routes through `sofia/external/{to}@{sbc_proxy}:5060` so Kamailio applies `ext-sip-ip`. The `sip_h_X-Carrier` header is hardcoded to `primary` (Dallas) — all products use the same 2-carrier model and `traffic_grade` is only passed as a channel var, it does NOT select the carrier. In TEST_MODE, uses `loopback/`. **STIR/SHAKEN (Task 2.2):** `stir_attest="A"` (passed by calls.py ONLY after the from_did ownership gate) adds `stir_attest=A`, `sip_h_X-Attestation=A`, `stir_attest_intent=A`, `stir_inbound_signed=0` to the originate vars — the header must ride the vars because the direct originate leg IS the carrier-bound INVITE (no dialplan/Lua runs pre-INVITE). Kamailio Step 8.5 consumes X-Attestation as the SHAKEN signing level and strips it unconditionally (dark-safe). Only "A"/"B" are honored; other values are logged + ignored.
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
