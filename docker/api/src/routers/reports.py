"""Customer Reporting API — /v1/reports (+ legacy /reports).

Contract: docs/CUSTOMER_REPORTING_DESIGN.md (implemented exactly). An ELI5
view of ONE customer's own calls, built from `cdrs`.

Hard rules (see the design doc + services/tenant_redaction.py):
  * Minutes only, from TALK time (`end_time - answer_time`, contract
    "Customer minutes" — never duration_ms, which includes ring, nor
    billable_ms). Per-call length = tr.call_minutes_sql('talk_ms'); totals
    round the answered talk-ms total ONCE (`aggregate_minutes`); averages are
    the mean of per-call whole minutes (`average_minutes`). No seconds, no
    costs, no answer/end timestamps anywhere in a response (start time only).
  * One row per call: every scan carries `leg IS DISTINCT FROM 'B'` (carrier
    B-leg rows never reach a report; there is no leg param).
  * Scoping: `get_support_read_filter`. Tenants are forced to their own
    customer_id (any `customer_id` / `all_customers` param ignored); staff
    (admin/support) must pass `customer_id` OR `all_customers=true` (422 if
    neither, 422 if both). All customers = `ReportScope.customer_id is None`:
    the same shapes aggregated over every customer (unattributed
    `customer_id = 0` CDRs excluded), per-row `customer_id` + `customer_name`
    on /numbers, /calls, /my-numbers and a leading "Customer" CSV column; the
    `numbers` filter needs one customer (422). Its SQL is DERIVED from the
    per-customer SQL by checked substitutions (`_variant`), so the
    per-customer strings stay byte-identical (tests pin their sha256).
  * `numbers` only ever NARROWS: requested numbers are intersected with the
    customer's own numbers in SQL (unknown / not-owned -> silently dropped).
  * "The customer's numbers" is services/customer_numbers.py — the ONE
    product-agnostic definition (the number_routing view: rcf, trunk,
    voicemail and any future arm; api hidden). Never re-list product tables
    here.
  * No routing internals: the raw hangup cause is read only to pick a
    plain-English missed reason; it is never returned.

Performance / safety (this runs on the East primary next to CDR ingest):
  * Every cdrs scan is `customer_id = $1 AND start_time >= lo AND start_time
    < hi` (the `(customer_id, start_time DESC)` index); lo/hi are the local
    dates converted to timestamptz in SQL (`date::timestamp AT TIME ZONE tz`)
    — stable expressions of bind params, so the index range is used. The
    staff all-customers scan has no customer predicate: it range-scans the
    hypertable's `start_time` index (chunk exclusion on the same bounds),
    so its cost is the PLATFORM's call volume in range — the statement
    timeout below bounds it like any other report.
  * ≤ 2 queries per endpoint, aggregated in SQL, everything LIMITed.
  * Each endpoint runs its queries in ONE short `BEGIN READ ONLY` transaction
    with `SET LOCAL statement_timeout` — SET LOCAL is transaction-scoped, so
    it is safe under PgBouncer transaction pooling (it can never leak onto
    another client's server connection). A timeout -> HTTP 503.
  * The CSV export streams in keyset-paginated chunks, each its own short
    transaction, so a slow download never pins a pool connection.
  * Explicit `::type` casts on every bind parameter (PgBouncer +
    statement_cache_size=0).
"""
from __future__ import annotations

import csv
import io
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Literal, Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse

from auth.dependencies import get_support_read_filter
from db import database as db
from services import customer_numbers as cn
from services import reporting as rp
from services import tenant_redaction as tr

logger = logging.getLogger(__name__)

router = APIRouter()


def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    try:
        v = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return max(lo, min(hi, v))


#: Per-statement ceiling for report queries (ms). Env-tunable, clamped.
REPORT_STATEMENT_TIMEOUT_MS = _env_int("REPORT_STATEMENT_TIMEOUT_MS", 15_000, 1_000, 60_000)
#: CSV keyset chunk size.
CSV_CHUNK_ROWS = 5_000

MSG_STAFF_NEEDS_CUSTOMER = "customer_id is required for staff (a report is about one customer)"
MSG_ONE_OR_ALL = "Pick one customer or all customers, not both."
MSG_NUMBERS_NEED_CUSTOMER = "Number filters need one customer."

# ---------------------------------------------------------------------------
# SQL building blocks (fixed fragments only — user values are ALWAYS binds)
# ---------------------------------------------------------------------------
# Standard bind layout shared by every report query:
#   $1 customer_id::int   $2 range-start::date   $3 range-end::date (inclusive)
#   $4 tz::text           $5 numbers::text[] (NULL = no number filter)


#: SQL twin of utils.phone.normalize_e164 (31_did_canonicalize.sql CASE) —
#: lives in services/customer_numbers.py, shared with the CDR filters.
_canon_sql = cn.canonical_e164_sql

#: "The customer's number on a call": destination for inbound, caller_id for
#: outbound (anything that isn't 'outbound' counts as inbound).
_NUMBER_SQL = cn.cdr_customer_number_sql("c")

_LO_SQL = "($2::date::timestamp AT TIME ZONE $4::text)"
_HI_SQL = "(($3::date + 1)::timestamp AT TIME ZONE $4::text)"

#: The customer's own numbers — EVERY product arm of number_routing (rcf,
#: trunk, voicemail, any future product; api hidden), enabled or not, via the
#: ONE definition in services/customer_numbers.py. Stored DIDs are canonical
#: (CHECK constraints from 31_did_canonicalize.sql / 54). A DID present in two
#: product tables is listed once (FreeSWITCH precedence: rcf wins). Columns:
#: number, name, product, forwards_to, enabled, customer_id. Each arm reads
#: its customer index, so this stays a tiny CTE. `sel` = owned ∩ the
#: `numbers` filter.
_OWNED_CTES = f"""
owned AS ({cn.owned_numbers_sql("$1::int")}
)"""

_SEL_CTE = """
sel AS (
    SELECT * FROM owned WHERE ($5::text[] IS NULL OR number = ANY($5::text[]))
)"""

#: One row per call in range, with the derived fields reports need. Only the
#: columns listed here are ever read — never money/routing columns.
_BASE_CTE = f"""
base AS (
    SELECT c.id, c.uuid, c.start_time, c.answer_time, c.direction,
           c.caller_id, c.destination, c.hangup_cause,
           c.product_type AS product,
           -- call-level quality = the worse direction (migration 50,
           -- docs/CALL_QUALITY_ACCURACY_PLAN.md §C/§E.2): graded <=> grade set
           c.call_mos AS mos, c.call_quality_grade AS grade,
           {tr.TALK_MS_SQL} AS talk_ms,
           {_NUMBER_SQL} AS number
      FROM cdrs c
     WHERE c.customer_id = $1::int
       AND c.start_time >= {_LO_SQL}
       AND c.start_time <  {_HI_SQL}
       AND c.leg IS DISTINCT FROM 'B'
),
f AS (
    SELECT * FROM base
     WHERE ($5::text[] IS NULL OR number IN (SELECT number FROM sel))
)"""

_WITH = f"WITH {_OWNED_CTES},{_SEL_CTE},{_BASE_CTE}"

_ANSWERED = "answer_time IS NOT NULL"
_ANSWERED_MS = f"talk_ms > 0 AND {_ANSWERED}"
_MINUTES = tr.call_minutes_sql("talk_ms")


# ---------------------------------------------------------------------------
# Staff "all customers" variants (ReportScope.customer_id is None)
# ---------------------------------------------------------------------------
# Derived FROM the per-customer SQL by checked substitutions (`_variant`:
# each `old` must occur exactly once or the module refuses to import), so
#   * the per-customer strings are never edited — tenant reports stay
#     byte-identical (tests/test_reports.py pins the sha256 of the SQL every
#     per-customer request runs, and of its response);
#   * a metric added to a per-customer query reaches the all-customers one.
# Bind layout: the SAME $1..$5 (+ endpoint extras). $1 (customer) and $5
# (numbers) are always bound NULL here and appear only in fail-closed guards
# (`$1::int IS NULL`, `$5::text[] IS NULL`): this SQL returns NOTHING if a
# customer id or a number filter ever reaches it, and PostgreSQL can still
# type every bind. asyncpg's unnamed statements are planned with the bound
# values, so both guards fold to constants.
# Unattributed CDRs — `customer_id = 0`, the ingest default when FreeSWITCH
# sent no customer — are nobody's calls and are excluded (cdrs.customer_id is
# NOT NULL in 05; a NULL would be excluded too, `NULL <> 0` is not true).
# `<> 0` is not a range on (customer_id, start_time): the scan is the
# start_time range on the hypertable's start_time index.
def _variant(sql: str, *swaps: tuple[str, str]) -> str:
    for old, new in swaps:
        hits = sql.count(old)
        if hits != 1:
            raise RuntimeError(f"reports: all-customers substitution matched {hits}x "
                               f"(want exactly 1): {old[:80]!r}")
        sql = sql.replace(old, new)
    return sql


def _all_customers_sql(alias: str) -> str:
    """Row predicate of the all-customers variant (see above)."""
    return f"$1::int IS NULL AND {alias}.customer_id <> 0"


#: base (+ the row's customer_id, minus the customer predicate) and f (no
#: number filter: refused upstream, and guarded here).
_ALL_BASE_CTE = _variant(
    _BASE_CTE,
    (f"{_NUMBER_SQL} AS number\n      FROM cdrs c\n     WHERE c.customer_id = $1::int\n",
     f"{_NUMBER_SQL} AS number,\n           c.customer_id\n      FROM cdrs c\n"
     f"     WHERE {_all_customers_sql('c')}\n"),
    ("     WHERE ($5::text[] IS NULL OR number IN (SELECT number FROM sel))\n",
     "     WHERE $5::text[] IS NULL\n"),
)
_ALL_WITH = f"WITH {_ALL_BASE_CTE}"

#: EVERY customer's numbers (customer_numbers.owned_numbers_sql(None): the
#: same view, api hidden, one row per DID — FreeSWITCH precedence across
#: customers too). Columns as `owned` + the owning customer_id.
_ALL_OWNED_CTES = f"""
owned AS ({cn.owned_numbers_sql(None)}
)"""

#: Keys an all-customers row adds to the per-customer row (/numbers, /calls,
#: /my-numbers). Staff-only mode; nothing else is added.
ALL_CUSTOMERS_ROW_KEYS = ("customer_id", "customer_name")


def _prelude(s: "ReportScope") -> str:
    return _ALL_WITH if s.all_customers else _WITH


# ---------------------------------------------------------------------------
# Scope (common params) + DB helpers
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class ReportScope:
    #: The one customer reported on; None = every customer (staff only —
    #: `all_customers=true`; `numbers` is then always None).
    customer_id: Optional[int]
    period: rp.Period
    tz: str
    numbers: Optional[list[str]]

    @property
    def all_customers(self) -> bool:
        return self.customer_id is None

    def args(self, start=None, end=None) -> list[Any]:
        """The standard $1..$5 bind list (optionally overriding the range).
        All customers: the same layout with $1 (and $5) bound NULL."""
        return [self.customer_id, start or self.period.start,
                end or self.period.end, self.tz, self.numbers]


_TZ_CACHE: dict[str, Any] = {"names": None, "at": 0.0}
_TZ_CACHE_TTL_S = 24 * 3600


async def _canonical_tz(tz: str) -> Optional[str]:
    """Validate against pg_timezone_names (cached per process for 24h).
    Case-insensitive; returns PostgreSQL's spelling, or None if unknown."""
    if not rp.tz_shape_ok(tz):
        return None
    names = _TZ_CACHE["names"]
    if names is None or time.monotonic() - _TZ_CACHE["at"] > _TZ_CACHE_TTL_S:
        rows = await db.fetch_all("SELECT name FROM pg_timezone_names")
        names = {r["name"].lower(): r["name"] for r in rows}
        _TZ_CACHE.update(names=names, at=time.monotonic())
    return names.get(tz.lower())


def _scope_customer(customer_filter: Optional[int], customer_id: Optional[int],
                    all_customers: bool) -> Optional[int]:
    """Who a report is about: a tenant's own customer (their `customer_id` /
    `all_customers` params are ignored, exactly like before); for staff, the
    chosen `customer_id`, or None for `all_customers=true`. Staff must pick
    exactly one of the two (422)."""
    if customer_filter is not None:
        return int(customer_filter)
    if all_customers:
        if customer_id is not None:
            raise HTTPException(422, MSG_ONE_OR_ALL)
        return None
    if customer_id is None:
        raise HTTPException(422, MSG_STAFF_NEEDS_CUSTOMER)
    return int(customer_id)


async def report_scope(
    start: Optional[str] = Query(None, description="YYYY-MM-DD, inclusive, local date in tz"),
    end: Optional[str] = Query(None, description="YYYY-MM-DD, inclusive, local date in tz"),
    tz: str = Query(rp.DEFAULT_TZ, description="IANA time zone"),
    numbers: Optional[str] = Query(None, description="comma list of your own numbers"),
    customer_id: Optional[int] = Query(
        None, ge=0, description="staff only (required for staff unless all_customers=true)"),
    all_customers: bool = Query(
        False, description="staff only: report on every customer (no customer_id, no numbers)"),
    customer_filter: Optional[int] = Depends(get_support_read_filter),
) -> ReportScope:
    """Common report params. Tenants are hard-scoped; staff choose one
    customer or all customers."""
    cid = _scope_customer(customer_filter, customer_id, all_customers)
    try:
        period = rp.parse_period(start, end)
        nums = rp.parse_numbers_filter(numbers)
    except rp.ReportValidationError as e:
        raise HTTPException(422, str(e)) from e
    if cid is None and nums is not None:
        # Numbers belong to a customer; "all customers" has no owned set to
        # intersect a filter with (and the all-customers SQL refuses one).
        raise HTTPException(422, MSG_NUMBERS_NEED_CUSTOMER)
    canon_tz = await _canonical_tz(tz)
    if canon_tz is None:
        raise HTTPException(422, "unknown time zone")
    return ReportScope(cid, period, canon_tz, nums)


async def _run(queries: list[tuple[str, list[Any]]]) -> list[list[asyncpg.Record]]:
    """Run report queries in ONE read-only transaction with a statement
    timeout (SET LOCAL => transaction-scoped; PgBouncer-transaction-safe)."""
    pool = await db.get_pool()
    try:
        async with pool.acquire() as conn:
            async with conn.transaction(readonly=True):
                await conn.execute(
                    f"SET LOCAL statement_timeout = {int(REPORT_STATEMENT_TIMEOUT_MS)}")
                return [await conn.fetch(sql, *args) for sql, args in queries]
    except asyncpg.exceptions.QueryCanceledError as e:
        logger.warning("report query cancelled (statement_timeout %sms): %s",
                       REPORT_STATEMENT_TIMEOUT_MS, e)
        raise HTTPException(503, "This report is taking too long. Try a shorter date range.") from e


# ---------------------------------------------------------------------------
# /overview
# ---------------------------------------------------------------------------
_OVERVIEW_TOTALS_SQL = f"""{_WITH},
x AS (SELECT *, start_time >= ($6::date::timestamp AT TIME ZONE $4::text) AS cur FROM f)
SELECT
    count(*) FILTER (WHERE cur)                                      AS calls,
    count(*) FILTER (WHERE cur AND direction = 'outbound')           AS outbound,
    count(*) FILTER (WHERE cur AND {_ANSWERED})                      AS answered,
    COALESCE(sum(talk_ms) FILTER (WHERE cur AND {_ANSWERED_MS}), 0)::bigint AS answered_ms,
    avg({_MINUTES}) FILTER (WHERE cur AND {_ANSWERED})               AS avg_call_minutes,
    count(*) FILTER (WHERE cur AND grade IS NOT NULL)                AS rated,
    avg(mos) FILTER (WHERE cur AND grade IS NOT NULL AND mos IS NOT NULL) AS avg_mos,
    count(*) FILTER (WHERE cur AND grade IN ('great','good'))        AS good_or_better,
    count(*) FILTER (WHERE NOT cur)                                  AS prev_calls,
    count(*) FILTER (WHERE NOT cur AND {_ANSWERED})                  AS prev_answered,
    COALESCE(sum(talk_ms) FILTER (WHERE NOT cur AND {_ANSWERED_MS}), 0)::bigint AS prev_answered_ms,
    (SELECT (min(c2.start_time) AT TIME ZONE $4::text)::date
       FROM cdrs c2 WHERE c2.customer_id = $1::int
        AND c2.leg IS DISTINCT FROM 'B'
        -- Bounded so Timescale prunes chunks instead of scanning every
        -- (compressed) chunk; 400d covers the planned 13-month retention.
        AND c2.start_time >= now() - interval '400 days')            AS data_from
FROM x
"""

# One pass, three groupings: local day, local hour-of-day, missed hangup cause.
_OVERVIEW_GROUPS_SQL = f"""{_WITH},
g AS (
    SELECT (start_time AT TIME ZONE $4::text)::date                  AS d,
           extract(hour FROM start_time AT TIME ZONE $4::text)::int  AS h,
           CASE WHEN answer_time IS NULL THEN COALESCE(hangup_cause::text, '') END AS hc,
           answer_time
      FROM f
)
SELECT GROUPING(d, h, hc) AS gset, d, h, hc,
       count(*) AS calls,
       count(*) FILTER (WHERE answer_time IS NULL) AS missed
  FROM g
 GROUP BY GROUPING SETS ((d), (h), (hc))
 LIMIT 2000
"""
# GROUPING(d,h,hc) bitmask: (d) -> 0b011=3, (h) -> 0b101=5, (hc) -> 0b110=6
_GSET_DAY, _GSET_HOUR, _GSET_CAUSE = 3, 5, 6

#: All customers: the same two passes over every customer's calls;
#: `data_from` = the oldest retained attributed CDR of any customer.
_ALL_OVERVIEW_TOTALS_SQL = _variant(
    _OVERVIEW_TOTALS_SQL,
    (_WITH, _ALL_WITH),
    ("FROM cdrs c2 WHERE c2.customer_id = $1::int",
     f"FROM cdrs c2 WHERE {_all_customers_sql('c2')}"),
)
_ALL_OVERVIEW_GROUPS_SQL = _variant(_OVERVIEW_GROUPS_SQL, (_WITH, _ALL_WITH))


def _summary_grade(rated: int, mos: Optional[float]) -> str:
    """Grade word for an aggregate: from the average MOS of graded calls; when
    calls were graded but none carries a MOS (every one was one-way audio,
    graded poor with MOS NULL) the aggregate is poor, never "Not rated"."""
    if rated and mos is None:
        return "poor"
    return rp.grade_for_mos(mos)


def _quality(rated: int, avg_mos: Any, good: int) -> dict:
    mos = rp.round_mos(avg_mos) if rated and avg_mos is not None else None
    return {
        "rated_calls": int(rated),
        "avg_mos": mos,
        "grade": _summary_grade(rated, mos),
        "pct_good_or_better": rp.pct(good, rated),
    }


async def build_overview(s: ReportScope) -> dict:
    prev = s.period.previous()
    if s.all_customers:
        totals_sql, groups_sql = _ALL_OVERVIEW_TOTALS_SQL, _ALL_OVERVIEW_GROUPS_SQL
    else:
        totals_sql, groups_sql = _OVERVIEW_TOTALS_SQL, _OVERVIEW_GROUPS_SQL
    totals_rows, group_rows = await _run([
        (totals_sql, s.args(start=prev.start) + [s.period.start]),
        (groups_sql, s.args()),
    ])
    t = totals_rows[0]
    calls, answered = int(t["calls"]), int(t["answered"])
    data_from = t["data_from"]

    prev_known = data_from is not None and prev.start >= data_from
    prev_calls, prev_answered = int(t["prev_calls"]), int(t["prev_answered"])
    previous = {
        "start": prev.start.isoformat(), "end": prev.end.isoformat(),
        "calls": prev_calls if prev_known else None,
        "answered": prev_answered if prev_known else None,
        "minutes": tr.aggregate_minutes(t["prev_answered_ms"]) if prev_known else None,
        "answer_rate_pct": rp.pct(prev_answered, prev_calls) if prev_known else None,
    }

    days, hours, causes = [], [], []
    for r in group_rows:
        if r["gset"] == _GSET_DAY:
            days.append((r["d"], int(r["calls"])))
        elif r["gset"] == _GSET_HOUR:
            hours.append((r["h"], int(r["calls"])))
        elif r["gset"] == _GSET_CAUSE and r["hc"] is not None:
            causes.append((r["hc"], int(r["missed"])))
    busiest_day = min(days, key=lambda x: (-x[1], x[0]), default=None)
    busiest_hour = min(hours, key=lambda x: (-x[1], x[0]), default=None)

    return {
        "period": {"start": s.period.start.isoformat(), "end": s.period.end.isoformat(),
                   "tz": s.tz, "days": s.period.days},
        "data_available_from": data_from.isoformat() if data_from else None,
        "totals": {
            "calls": calls,
            "inbound": calls - int(t["outbound"]),
            "outbound": int(t["outbound"]),
            "answered": answered,
            "missed": calls - answered,
            "answer_rate_pct": rp.pct(answered, calls),
            "minutes": tr.aggregate_minutes(t["answered_ms"]),
            "avg_minutes": tr.average_minutes(t["avg_call_minutes"]),
        },
        "previous_period": previous,
        "quality": _quality(int(t["rated"]), t["avg_mos"], int(t["good_or_better"])),
        "busiest_day": ({"date": busiest_day[0].isoformat(), "calls": busiest_day[1]}
                        if busiest_day else None),
        "busiest_hour": ({"hour": int(busiest_hour[0]), "calls": busiest_hour[1]}
                         if busiest_hour else None),
        "missed_reasons": rp.missed_reasons_list(causes),
    }


# ---------------------------------------------------------------------------
# /trend
# ---------------------------------------------------------------------------
# Buckets are date_trunc'd in LOCAL time (week = ISO, Monday start) and
# zero-filled by generate_series over the local range. `$6` is the bucket
# unit — validated against a fixed allowlist before binding.
_TREND_SQL = f"""{_WITH},
b AS (
    SELECT date_trunc($6::text, start_time AT TIME ZONE $4::text)::date AS d,
           count(*) AS calls,
           count(*) FILTER (WHERE {_ANSWERED}) AS answered,
           COALESCE(sum(talk_ms) FILTER (WHERE {_ANSWERED_MS}), 0)::bigint AS answered_ms
      FROM f
     GROUP BY 1
)
SELECT gs.d::date AS d,
       COALESCE(b.calls, 0) AS calls,
       COALESCE(b.answered, 0) AS answered,
       COALESCE(b.answered_ms, 0)::bigint AS answered_ms
  FROM generate_series(date_trunc($6::text, $2::date::timestamp),
                       $3::date::timestamp,
                       ('1 ' || $6::text)::interval) AS gs(d)
  LEFT JOIN b ON b.d = gs.d::date
 ORDER BY 1
 LIMIT 400
"""
_ALL_TREND_SQL = _variant(_TREND_SQL, (_WITH, _ALL_WITH))


async def build_trend(s: ReportScope, bucket: Optional[str]) -> dict:
    try:
        unit = rp.choose_bucket(bucket, s.period.days)
    except rp.ReportValidationError as e:
        raise HTTPException(422, str(e)) from e
    sql = _ALL_TREND_SQL if s.all_customers else _TREND_SQL
    (rows,) = await _run([(sql, s.args() + [unit])])
    return {
        "bucket": unit,
        "points": [{
            "date": r["d"].isoformat(),
            "calls": int(r["calls"]),
            "answered": int(r["answered"]),
            "missed": int(r["calls"]) - int(r["answered"]),
            "minutes": tr.aggregate_minutes(r["answered_ms"]),
        } for r in rows],
    }


# ---------------------------------------------------------------------------
# /numbers  and  /my-numbers
# ---------------------------------------------------------------------------
_NUMBERS_SQL = f"""{_WITH},
st AS (
    SELECT number,
           count(*) AS calls,
           count(*) FILTER (WHERE {_ANSWERED}) AS answered,
           COALESCE(sum(talk_ms) FILTER (WHERE {_ANSWERED_MS}), 0)::bigint AS answered_ms,
           avg(mos) FILTER (WHERE grade IS NOT NULL AND mos IS NOT NULL) AS avg_mos,
           count(*) FILTER (WHERE grade IS NOT NULL) AS rated
      FROM base
     WHERE number IN (SELECT number FROM sel)
     GROUP BY number
)
SELECT sel.number, sel.name, sel.product, sel.forwards_to,
       COALESCE(st.calls, 0) AS calls, COALESCE(st.answered, 0) AS answered,
       COALESCE(st.answered_ms, 0)::bigint AS answered_ms,
       st.avg_mos, COALESCE(st.rated, 0) AS rated
  FROM sel LEFT JOIN st ON st.number = sel.number
 ORDER BY 5 DESC, sel.number
 LIMIT {rp.MAX_NUMBERS_ROWS}
"""

#: All customers: every customer's numbers with their OWN calls. Calls are
#: aggregated per (customer_id, number) first — one hash aggregate over the
#: range, no per-number subquery — and matched to the owner on BOTH keys, so
#: a call keeps the per-customer attribution rule (a number that moved
#: between customers never shows the old owner's calls; the sum of the
#: per-customer reports == this). Top MAX_NUMBERS_ROWS by calls, like before.
_ALL_NUMBERS_SQL = f"""WITH {_ALL_OWNED_CTES},{_ALL_BASE_CTE},
st AS (
    SELECT customer_id, number,
           count(*) AS calls,
           count(*) FILTER (WHERE {_ANSWERED}) AS answered,
           COALESCE(sum(talk_ms) FILTER (WHERE {_ANSWERED_MS}), 0)::bigint AS answered_ms,
           avg(mos) FILTER (WHERE grade IS NOT NULL AND mos IS NOT NULL) AS avg_mos,
           count(*) FILTER (WHERE grade IS NOT NULL) AS rated
      FROM f
     WHERE (customer_id, number) IN (SELECT customer_id, number FROM owned)
     GROUP BY customer_id, number
)
SELECT o.number, o.name, o.product, o.forwards_to,
       COALESCE(st.calls, 0) AS calls, COALESCE(st.answered, 0) AS answered,
       COALESCE(st.answered_ms, 0)::bigint AS answered_ms,
       st.avg_mos, COALESCE(st.rated, 0) AS rated,
       o.customer_id, cu.name AS customer_name
  FROM owned o
  JOIN customers cu ON cu.id = o.customer_id
  LEFT JOIN st ON st.customer_id = o.customer_id AND st.number = o.number
 ORDER BY 5 DESC, o.number
 LIMIT {rp.MAX_NUMBERS_ROWS}
"""


def _with_customer(out: dict, r: asyncpg.Record) -> dict:
    """An all-customers row = the per-customer row + ALL_CUSTOMERS_ROW_KEYS."""
    out["customer_id"] = r["customer_id"]
    out["customer_name"] = r["customer_name"]
    return out


async def build_numbers(s: ReportScope) -> dict:
    sql = _ALL_NUMBERS_SQL if s.all_customers else _NUMBERS_SQL
    (rows,) = await _run([(sql, s.args())])
    out = []
    for r in rows:
        calls, answered = int(r["calls"]), int(r["answered"])
        mos = rp.round_mos(r["avg_mos"]) if r["rated"] and r["avg_mos"] is not None else None
        row = {
            "number": r["number"],
            "name": r["name"],
            "product": r["product"],
            "forwards_to": r["forwards_to"] if r["product"] == "rcf" else None,
            "calls": calls,
            "answered": answered,
            "missed": calls - answered,
            "answer_rate_pct": rp.pct(answered, calls),
            "minutes": tr.aggregate_minutes(r["answered_ms"]),
            "avg_mos": mos,
            "grade": _summary_grade(int(r["rated"]), mos),
        }
        out.append(_with_customer(row, r) if s.all_customers else row)
    return {"numbers": out}


_MY_NUMBERS_SQL = f"""WITH {_OWNED_CTES}
SELECT number, name, product, enabled, forwards_to
  FROM owned ORDER BY number LIMIT {rp.MAX_MY_NUMBERS_ROWS}
"""

#: All customers (staff): every customer's numbers + the owner. No binds.
_ALL_MY_NUMBERS_SQL = f"""WITH {_ALL_OWNED_CTES}
SELECT o.number, o.name, o.product, o.enabled, o.forwards_to,
       o.customer_id, cu.name AS customer_name
  FROM owned o
  JOIN customers cu ON cu.id = o.customer_id
 ORDER BY o.number LIMIT {rp.MAX_MY_NUMBERS_ROWS}
"""


async def build_my_numbers(customer_id: Optional[int]) -> dict:
    """The customer's numbers, every product (shared by the Reporting picker
    and the dashboard): {number, name, product, enabled, forwards_to}.
    `customer_id` None (staff, all customers): every customer's numbers, each
    row + {customer_id, customer_name}."""
    if customer_id is None:
        (rows,) = await _run([(_ALL_MY_NUMBERS_SQL, [])])
        return {"numbers": [_with_customer(cn.shape_number(r), r) for r in rows]}
    (rows,) = await _run([(_MY_NUMBERS_SQL, [customer_id])])
    return {"numbers": [cn.shape_number(r) for r in rows]}


# ---------------------------------------------------------------------------
# /calls  and  /calls.csv
# ---------------------------------------------------------------------------
Outcome = Literal["all", "answered", "missed"]
Direction = Literal["all", "inbound", "outbound"]

_OUTCOME_SQL = {"all": "", "answered": f" AND {_ANSWERED}", "missed": " AND answer_time IS NULL"}
_DIRECTION_SQL = {"all": "", "inbound": " AND direction IS DISTINCT FROM 'outbound'",
                  "outbound": " AND direction = 'outbound'"}

#: Per-call projection. `hangup_cause` is read ONLY to choose the plain-English
#: missed reason and is dropped by _shape_call(); talk_ms never leaves SQL
#: (length is the whole-minute call_minutes_sql('talk_ms')). `product` is the
#: CDR's product_type (tenant-allowlisted) — a voicemail-answered call is
#: labelled "Answered by voicemail".
_CALL_COLS = f"""
    id, uuid, direction, caller_id, destination, number, product, hangup_cause, mos, grade,
    ({_ANSWERED}) AS answered,
    {_MINUTES} AS length_minutes,
    (start_time AT TIME ZONE $4::text) AS local_ts,
    extract(epoch FROM (start_time AT TIME ZONE $4::text)
                     - (start_time AT TIME ZONE 'UTC'))::int AS utc_offset_s,
    start_time"""


def _call_filter(outcome: str, direction: str) -> str:
    return _OUTCOME_SQL[outcome] + _DIRECTION_SQL[direction]


def _calls_sql(s: ReportScope, cond: str, tail: str) -> str:
    """One page of calls (`cond` = outcome/direction filter, `tail` = keyset
    predicate + ORDER BY + LIMIT/OFFSET). Per customer: byte-identical to the
    original SQL. All customers: the same page in a `page` CTE, THEN joined to
    customers for the name — at most one page of rows is ever joined."""
    if not s.all_customers:
        return f"{_WITH} SELECT {_CALL_COLS} FROM f WHERE TRUE{cond} {tail}"
    return (f"{_ALL_WITH}, page AS (SELECT {_CALL_COLS}, customer_id FROM f "
            f"WHERE TRUE{cond} {tail}) "
            "SELECT page.*, cu.name AS customer_name FROM page "
            "LEFT JOIN customers cu ON cu.id = page.customer_id "
            "ORDER BY page.start_time DESC, page.id DESC")


def _shape_call(r: asyncpg.Record) -> dict:
    answered = bool(r["answered"])
    out = {
        "id": r["uuid"],
        "started_at": rp.iso_local(r["local_ts"], r["utc_offset_s"]),
        "direction": rp.direction_of(r["direction"]),
        "from": r["caller_id"],
        "to": r["destination"],
        "number": r["number"],
        "product": r["product"],
        **rp.outcome_fields(answered, r["hangup_cause"], r["product"]),
        "length_minutes": int(r["length_minutes"]),
        # the STORED call grade (worse direction); one-way audio (no_rtp)
        # is 'poor' with no MOS -> "Poor" in the CSV, never "Not rated";
        # no audio either way (no_media) carries no grade -> "Not rated"
        "quality": r["grade"] or "none",
    }
    return out


def _shape_any_call(s: ReportScope, r: asyncpg.Record) -> dict:
    out = _shape_call(r)
    return _with_customer(out, r) if s.all_customers else out


async def build_calls(s: ReportScope, outcome: str, direction: str,
                      limit: int, offset: int) -> dict:
    cond = _call_filter(outcome, direction)
    n = len(s.args())
    count_rows, page_rows = await _run([
        (f"{_prelude(s)} SELECT count(*) AS total FROM f WHERE TRUE{cond}", s.args()),
        (_calls_sql(s, cond, f"ORDER BY start_time DESC, id DESC "
                             f"LIMIT ${n + 1}::int OFFSET ${n + 2}::int"),
         s.args() + [limit, offset]),
    ])
    return {"total": int(count_rows[0]["total"]),
            "calls": [_shape_any_call(s, r) for r in page_rows]}


async def _csv_stream(s: ReportScope, cond: str, cap: int):
    """Yield CSV text: header, then keyset-paginated chunks (each chunk is its
    own short read-only transaction; nothing is held across client I/O).
    All customers: a leading "Customer" column (rp.ALL_CUSTOMERS_CSV_COLUMNS);
    the per-customer columns and cells are unchanged."""
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(rp.ALL_CUSTOMERS_CSV_COLUMNS if s.all_customers else rp.CSV_COLUMNS)
    yield buf.getvalue()

    n = len(s.args())
    first_sql = _calls_sql(s, cond, f"ORDER BY start_time DESC, id DESC LIMIT ${n + 1}::int")
    next_sql = _calls_sql(
        s, cond, f"AND (start_time, id) < (${n + 2}::timestamptz, ${n + 3}::bigint) "
                 f"ORDER BY start_time DESC, id DESC LIMIT ${n + 1}::int")
    sent, key = 0, None
    while sent < cap:
        size = min(CSV_CHUNK_ROWS, cap - sent)
        if key is None:
            (rows,) = await _run([(first_sql, s.args() + [size])])
        else:
            (rows,) = await _run([(next_sql, s.args() + [size, key[0], key[1]])])
        if not rows:
            break
        buf = io.StringIO()
        w = csv.writer(buf, lineterminator="\r\n")
        for r in rows:
            shaped = _shape_call(r)
            shaped["_local"] = r["local_ts"]
            cells = rp.csv_row(shaped)
            if s.all_customers:
                cells = [rp.csv_customer_cell(r["customer_name"], r["customer_id"])] + cells
            w.writerow(cells)
        yield buf.getvalue()
        sent += len(rows)
        key = (rows[-1]["start_time"], rows[-1]["id"])
        if len(rows) < size:
            break


async def build_calls_csv(s: ReportScope, outcome: str, direction: str) -> StreamingResponse:
    cond = _call_filter(outcome, direction)
    cap = rp.CSV_ROW_CAP
    n = len(s.args())
    (probe,) = await _run([(
        f"{_prelude(s)} SELECT count(*) AS n FROM "
        f"(SELECT 1 FROM f WHERE TRUE{cond} LIMIT ${n + 1}::int) q",
        s.args() + [cap + 1])])
    truncated = int(probe[0]["n"]) > cap
    fname = f"calls_{s.period.start.isoformat()}_{s.period.end.isoformat()}.csv"
    return StreamingResponse(
        _csv_stream(s, cond, cap),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{fname}"',
            "X-Report-Truncated": "true" if truncated else "false",
            "Cache-Control": "no-store",
        },
    )


# ---------------------------------------------------------------------------
# Routes (thin — logic lives above / in services/reporting.py)
# ---------------------------------------------------------------------------
@router.get("/overview")
async def overview(scope: ReportScope = Depends(report_scope)):
    """Headline numbers for the period (+ previous period, quality, busiest
    day/hour, missed reasons). Minutes only; no seconds/costs."""
    return await build_overview(scope)


@router.get("/trend")
async def trend(scope: ReportScope = Depends(report_scope),
                bucket: Optional[Literal["day", "week", "month"]] = None):
    """Calls over time, zero-filled buckets (auto day/week/month)."""
    return await build_trend(scope, bucket)


@router.get("/numbers")
async def numbers(scope: ReportScope = Depends(report_scope)):
    """Per-number totals for the customer's own numbers (incl. 0-call ones)."""
    return await build_numbers(scope)


@router.get("/calls")
async def calls(scope: ReportScope = Depends(report_scope),
                outcome: Outcome = "all", direction: Direction = "all",
                limit: int = Query(50, ge=1, le=rp.MAX_CALLS_PAGE),
                offset: int = Query(0, ge=0, le=rp.CSV_ROW_CAP)):
    """Paginated call list, newest first (start time only; whole minutes)."""
    return await build_calls(scope, outcome, direction, limit, offset)


@router.get("/calls.csv")
async def calls_csv(scope: ReportScope = Depends(report_scope),
                    outcome: Outcome = "all", direction: Direction = "all"):
    """Streaming CSV of the same call list (cap 100,000; X-Report-Truncated)."""
    return await build_calls_csv(scope, outcome, direction)


@router.get("/my-numbers")
async def my_numbers(customer_id: Optional[int] = Query(None, ge=0),
                     all_customers: bool = Query(False, description="staff only: every customer"),
                     customer_filter: Optional[int] = Depends(get_support_read_filter)):
    """The customer's numbers, every product (Reporting picker + dashboard).
    Tenants: own numbers; staff: customer_id or all_customers=true."""
    return await build_my_numbers(_scope_customer(customer_filter, customer_id, all_customers))
