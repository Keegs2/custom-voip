# Customer Reporting — design + API contract

Customer-facing **Reporting** page (sidebar: directly above **Guides**). Goal: an
insanely easy, ELI5 view of a customer's own calls — built from the platform's own
`cdrs` table (NOT the Equinox/FileMage export, which carries billing internals).

## Hard rules

1. **Never reveal how we rate/bill.** No rates, costs, carrier cost, margin,
   billable seconds, 6-second increments, or exact durations. Every duration a
   customer sees is **whole minutes** computed server-side with
   `services/tenant_redaction.py` (`duration_minutes`, `aggregate_minutes`,
   `average_minutes`, `TENANT_CALL_MINUTES_SQL`). Totals are rounded ONCE at the
   aggregate (never a sum of per-call ceilings). No answer/end timestamps in any
   report response (start time only), so length can't be re-derived.
2. **Tenant scoping** exactly like `/v1/cdrs`: `get_support_read_filter`. Tenants
   are forced to their own `customer_id`; staff (admin/support) must pass
   `customer_id` (422 if missing — a report is always about one customer).
3. **No routing internals**: no carrier, PoP, SBC, FS node, network address,
   SIP codes in customer-facing fields (a plain-English outcome label only).
4. Reporting is **read-only** and must never slow call routing: queries hit
   `cdrs` via the `(customer_id, start_time DESC)` index, bounded date ranges
   (max 366 days), no Timescale-only functions (portable `date_trunc(... AT TIME
   ZONE tz)`), LIMITs everywhere.

## Common query params (all endpoints)

| Param | Type | Notes |
|---|---|---|
| `start` | `YYYY-MM-DD` | required, inclusive, local date in `tz` |
| `end` | `YYYY-MM-DD` | required, inclusive, local date in `tz`; `end >= start`; span ≤ 366 days |
| `tz` | IANA name | default `America/New_York`; validated against `pg_timezone_names` (422 if unknown) |
| `numbers` | comma list | optional; restrict to these of the customer's own numbers (any not owned → ignored, never an oracle) |
| `customer_id` | int | staff only (required for staff; ignored for tenants) |

"The customer's number on a call" = `destination` for inbound, `caller_id` for
outbound, matched against the customer's `rcf_numbers.did` + `trunk_dids.did`
(via `sip_trunks.customer_id`) — canonicalize like `31_did_canonicalize.sql`.

Missed-call reasons (plain English; `hangup_cause` → key):

| key | label | causes |
|---|---|---|
| `no_answer` | Nobody picked up | NO_ANSWER, NO_USER_RESPONSE, ALLOTTED_TIMEOUT |
| `caller_hung_up` | The caller hung up before it was answered | ORIGINATOR_CANCEL |
| `busy` | The line was busy | USER_BUSY |
| `not_in_service` | The number called isn't in service | UNALLOCATED_NUMBER, INVALID_NUMBER_FORMAT, NO_ROUTE_DESTINATION |
| `declined` | The call was declined or blocked | CALL_REJECTED |
| `network` | A network problem stopped the call | everything else |

Quality grade from MOS: `great` ≥ 4.0 · `good` ≥ 3.6 · `fair` ≥ 3.1 · `poor` < 3.1 ·
`none` (no rated calls). Only calls with `mos IS NOT NULL` count as rated.

## Endpoints (router `routers/reports.py`, mounted at `/v1/reports` and `/reports`)

### `GET /reports/overview`
```json
{
  "period": {"start": "2026-08-01", "end": "2026-08-31", "tz": "America/Boise", "days": 31},
  "data_available_from": "2026-06-24",
  "totals": {"calls": 1204, "inbound": 1100, "outbound": 104, "answered": 1156, "missed": 48,
             "answer_rate_pct": 96.0, "minutes": 2890, "avg_minutes": 2.5},
  "previous_period": {"start": "2026-07-01", "end": "2026-07-31",
                      "calls": 1075, "answered": 1020, "minutes": 2600, "answer_rate_pct": 94.9},
  "quality": {"rated_calls": 1100, "avg_mos": 4.31, "grade": "great", "pct_good_or_better": 98.2},
  "busiest_day": {"date": "2026-08-14", "calls": 88},
  "busiest_hour": {"hour": 10, "calls": 190},
  "missed_reasons": [{"key": "no_answer", "label": "Nobody picked up", "calls": 30}]
}
```
`previous_period` = same number of days immediately before `start` (null fields if
before `data_available_from`). `busiest_hour.hour` is 0–23 in `tz`, `calls` = total
calls started in that hour-of-day across the period. `data_available_from` = local
date of the customer's oldest retained CDR (or null if none).

### `GET /reports/trend`
Extra param `bucket` = `day` | `week` | `month` (default: day if ≤ 62 days, week if
≤ 190, else month). Weeks start Monday. Every bucket in range present (zero-filled).
```json
{"bucket": "day", "points": [{"date": "2026-08-01", "calls": 40, "answered": 39, "missed": 1, "minutes": 97}]}
```

### `GET /reports/numbers`
Per customer number, sorted by calls desc, max 500.
```json
{"numbers": [{"number": "+16174544217", "name": "Main line", "product": "rcf",
  "forwards_to": "+17744045256", "calls": 300, "answered": 290, "missed": 10,
  "answer_rate_pct": 96.7, "minutes": 700, "avg_mos": 4.3, "grade": "great"}]}
```
`forwards_to` = the number's CURRENT forwarding target (rcf only, else null) — the
UI labels it "currently forwards to". Includes the customer's numbers with 0 calls.

### `GET /reports/calls`
Extra params: `outcome` = `all|answered|missed` (default all), `direction` =
`all|inbound|outbound`, `limit` ≤ 500 (default 50), `offset`.
```json
{"total": 1204, "calls": [{"id": "<cdr uuid>", "started_at": "2026-08-14T10:02:31-06:00",
  "direction": "inbound", "from": "+12085550100", "to": "+16174544217",
  "number": "+16174544217", "outcome": "answered", "outcome_label": "Answered",
  "missed_reason": null, "length_minutes": 3, "quality": "great"}]}
```
Newest first. `length_minutes` = `duration_minutes` (0 for missed, ≥1 answered).
`outcome_label` for missed = the missed-reason label.

### `GET /reports/calls.csv`
Same filters as `/reports/calls` (no limit/offset; hard cap 100,000 rows — header
`X-Report-Truncated: true` if capped). Streaming `text/csv`,
`Content-Disposition: attachment; filename="calls_<start>_<end>.csv"`. Columns
(plain English): `Date, Time, Direction, From, To, Your number, Outcome, Length
(minutes, rounded), Call quality`. Date/Time in `tz`, time to the minute.

### `GET /reports/my-numbers`
For the number picker: `{"numbers": [{"number", "name", "product"}]}`.

### Implementation notes / clarifications (backend, 2026-09)

These pin down behaviour the contract above left implicit; the shapes are unchanged.

- **Nulls when there is nothing to divide by:** `answer_rate_pct` is `null` when
  `calls == 0`; `avg_minutes` is `null` when no call was answered; `avg_mos` /
  `pct_good_or_better` are `null` (and `grade` = `none`) when no call is rated.
  `busiest_day` / `busiest_hour` are `null` when the period has no calls
  (ties go to the earliest date / lowest hour).
- **`previous_period`** is always an object; its `start`/`end` are always
  set and its counts are `null` when `data_available_from` is null or later
  than the previous period's `start` (a partially-covered comparison would
  mislead).
- **`avg_minutes`** = mean of the per-call whole minutes of ANSWERED calls,
  1 decimal. `minutes` (totals, trend points, number rows) = the answered-ms
  total of that row/bucket rounded ONCE.
- **Trend `date`** is the bucket start (week = Monday, month = the 1st), so the
  first week/month bucket can be earlier than `start`; each bucket only counts
  calls inside `[start, end]`.
- **`numbers` filter** entries are canonicalized to +E.164; entries that aren't
  the customer's own numbers (or aren't phone numbers) are dropped. If none
  remain, every endpoint returns an empty result (the filter never widens).
  Max 500 entries (422 beyond).
- **Per-call `quality`** is `none` for unrated calls. `from`/`to` are the raw
  CDR caller/destination; `number` is canonical +E.164.
- **`/reports/my-numbers`** takes only `customer_id` (staff: required, 422
  otherwise; tenants: ignored). Max 5,000 rows. "Numbers" = rcf + trunk DIDs.
- **`/reports/numbers`** `name` for a trunk DID is its trunk's name.
- **CSV:** `X-Report-Truncated` is always sent (`true`/`false`); cells that
  start with `=`, `@`, `-`, tab/CR (or `+` not followed by a phone number) are
  prefixed with `'` (spreadsheet formula-injection guard). CORS exposes
  `Content-Disposition` + `X-Report-Truncated`.
- **Errors:** 422 for bad dates / span > 366 days / unknown tz / bad
  bucket/outcome/direction/limit; **503** "This report is taking too long.
  Try a shorter date range." when a report query hits its statement timeout
  (`REPORT_STATEMENT_TIMEOUT_MS`, default 15 s).
- `tz` is matched case-insensitively and echoed in PostgreSQL's spelling.

## UI (`/reporting`)

Visible to every signed-in customer (rcf / trunk / hybrid) and to admins (with a
customer picker); hidden for support. Sidebar entry directly above Guides.

- Header sentence built client-side from `overview`: "You got **1,204 calls** in
  August. **96 of every 100** were answered. Call quality was **great**."
  + change vs previous period ("12% more calls than July").
- Controls: period presets (This month · Last month · Last 3 months · This year ·
  Custom), number multi-select, Download CSV (server) / Download PDF (client,
  `@react-pdf/renderer`, lazy-loaded).
- Cards: calls over time (SVG chart, matching `components/charts/QualityTrendChart.tsx`),
  busiest day & hour, missed calls and why, call quality, your numbers table,
  paginated call list.
- Every metric has a "What does this mean?" explainer; glossary at the bottom.
- Data-availability note when the chosen range starts before `data_available_from`.
