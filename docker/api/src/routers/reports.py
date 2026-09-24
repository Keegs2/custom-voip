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
    customer_id (any `customer_id` param ignored); staff (admin/support) must
    pass `customer_id` (422 otherwise).
  * `numbers` only ever NARROWS: requested numbers are intersected with the
    customer's own numbers in SQL (unknown / not-owned -> silently dropped).
  * No routing internals: the raw hangup cause is read only to pick a
    plain-English missed reason; it is never returned.

Performance / safety (this runs on the East primary next to CDR ingest):
  * Every cdrs scan is `customer_id = $1 AND start_time >= lo AND start_time
    < hi` (the `(customer_id, start_time DESC)` index); lo/hi are the local
    dates converted to timestamptz in SQL (`date::timestamp AT TIME ZONE tz`)
    — stable expressions of bind params, so the index range is used.
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

# ---------------------------------------------------------------------------
# SQL building blocks (fixed fragments only — user values are ALWAYS binds)
# ---------------------------------------------------------------------------
# Standard bind layout shared by every report query:
#   $1 customer_id::int   $2 range-start::date   $3 range-end::date (inclusive)
#   $4 tz::text           $5 numbers::text[] (NULL = no number filter)


def _canon_sql(col: str) -> str:
    """SQL twin of utils.phone.normalize_e164 (same CASE as
    31_did_canonicalize.sql) so a CDR's raw caller_id/destination matches the
    canonical DIDs stored in rcf_numbers / trunk_dids."""
    digits = f"regexp_replace({col}, '[^0-9]', '', 'g')"
    return (
        f"(CASE WHEN {col} ~ '^\\+[1-9][0-9]{{1,14}}$' THEN {col} "
        f"WHEN {digits} ~ '^1[2-9][0-9]{{9}}$' THEN '+' || {digits} "
        f"WHEN {digits} ~ '^[2-9][0-9]{{9}}$' THEN '+1' || {digits} "
        f"ELSE {col} END)"
    )


#: "The customer's number on a call": destination for inbound, caller_id for
#: outbound (anything that isn't 'outbound' counts as inbound).
_NUMBER_SQL = _canon_sql(
    "(CASE WHEN c.direction = 'outbound' THEN c.caller_id ELSE c.destination END)")

_LO_SQL = "($2::date::timestamp AT TIME ZONE $4::text)"
_HI_SQL = "(($3::date + 1)::timestamp AT TIME ZONE $4::text)"

#: The customer's own numbers (rcf + trunk DIDs). Stored DIDs are canonical
#: (CHECK constraints from 31_did_canonicalize.sql). A DID present in both
#: tables is listed once (rcf wins). `sel` = owned ∩ the `numbers` filter.
_OWNED_CTES = """
owned AS (
    SELECT DISTINCT ON (u.number) u.number, u.name, u.product, u.forwards_to
    FROM (
        SELECT r.did::text AS number, r.name::text AS name, 'rcf'::text AS product,
               r.forward_to::text AS forwards_to, 0 AS pri
          FROM rcf_numbers r
         WHERE r.customer_id = $1::int
        UNION ALL
        SELECT td.did::text, st.trunk_name::text, 'trunk'::text, NULL::text, 1
          FROM trunk_dids td
          JOIN sip_trunks st ON st.id = td.trunk_id
         WHERE st.customer_id = $1::int
    ) u
    ORDER BY u.number, u.pri
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
# Scope (common params) + DB helpers
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class ReportScope:
    customer_id: int
    period: rp.Period
    tz: str
    numbers: Optional[list[str]]

    def args(self, start=None, end=None) -> list[Any]:
        """The standard $1..$5 bind list (optionally overriding the range)."""
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


async def report_scope(
    start: Optional[str] = Query(None, description="YYYY-MM-DD, inclusive, local date in tz"),
    end: Optional[str] = Query(None, description="YYYY-MM-DD, inclusive, local date in tz"),
    tz: str = Query(rp.DEFAULT_TZ, description="IANA time zone"),
    numbers: Optional[str] = Query(None, description="comma list of your own numbers"),
    customer_id: Optional[int] = Query(None, ge=0, description="staff only (required for staff)"),
    customer_filter: Optional[int] = Depends(get_support_read_filter),
) -> ReportScope:
    """Common report params. Tenants are hard-scoped; staff must choose."""
    if customer_filter is not None:
        cid = customer_filter           # tenant: any customer_id param ignored
    elif customer_id is None:
        raise HTTPException(422, "customer_id is required for staff (a report is about one customer)")
    else:
        cid = customer_id
    try:
        period = rp.parse_period(start, end)
        nums = rp.parse_numbers_filter(numbers)
    except rp.ReportValidationError as e:
        raise HTTPException(422, str(e)) from e
    canon_tz = await _canonical_tz(tz)
    if canon_tz is None:
        raise HTTPException(422, "unknown time zone")
    return ReportScope(int(cid), period, canon_tz, nums)


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
    totals_rows, group_rows = await _run([
        (_OVERVIEW_TOTALS_SQL, s.args(start=prev.start) + [s.period.start]),
        (_OVERVIEW_GROUPS_SQL, s.args()),
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


async def build_trend(s: ReportScope, bucket: Optional[str]) -> dict:
    try:
        unit = rp.choose_bucket(bucket, s.period.days)
    except rp.ReportValidationError as e:
        raise HTTPException(422, str(e)) from e
    (rows,) = await _run([(_TREND_SQL, s.args() + [unit])])
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


async def build_numbers(s: ReportScope) -> dict:
    (rows,) = await _run([(_NUMBERS_SQL, s.args())])
    out = []
    for r in rows:
        calls, answered = int(r["calls"]), int(r["answered"])
        mos = rp.round_mos(r["avg_mos"]) if r["rated"] and r["avg_mos"] is not None else None
        out.append({
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
        })
    return {"numbers": out}


_MY_NUMBERS_SQL = f"""WITH {_OWNED_CTES}
SELECT number, name, product FROM owned ORDER BY number LIMIT {rp.MAX_MY_NUMBERS_ROWS}
"""


async def build_my_numbers(customer_id: int) -> dict:
    (rows,) = await _run([(_MY_NUMBERS_SQL, [customer_id])])
    return {"numbers": [{"number": r["number"], "name": r["name"], "product": r["product"]}
                        for r in rows]}


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
#: (length is the whole-minute call_minutes_sql('talk_ms')).
_CALL_COLS = f"""
    id, uuid, direction, caller_id, destination, number, hangup_cause, mos, grade,
    ({_ANSWERED}) AS answered,
    {_MINUTES} AS length_minutes,
    (start_time AT TIME ZONE $4::text) AS local_ts,
    extract(epoch FROM (start_time AT TIME ZONE $4::text)
                     - (start_time AT TIME ZONE 'UTC'))::int AS utc_offset_s,
    start_time"""


def _call_filter(outcome: str, direction: str) -> str:
    return _OUTCOME_SQL[outcome] + _DIRECTION_SQL[direction]


def _shape_call(r: asyncpg.Record) -> dict:
    answered = bool(r["answered"])
    out = {
        "id": r["uuid"],
        "started_at": rp.iso_local(r["local_ts"], r["utc_offset_s"]),
        "direction": rp.direction_of(r["direction"]),
        "from": r["caller_id"],
        "to": r["destination"],
        "number": r["number"],
        **rp.outcome_fields(answered, r["hangup_cause"]),
        "length_minutes": int(r["length_minutes"]),
        # the STORED call grade (worse direction); one-way audio (no_rtp)
        # is 'poor' with no MOS -> "Poor" in the CSV, never "Not rated"
        "quality": r["grade"] or "none",
    }
    return out


async def build_calls(s: ReportScope, outcome: str, direction: str,
                      limit: int, offset: int) -> dict:
    cond = _call_filter(outcome, direction)
    n = len(s.args())
    count_rows, page_rows = await _run([
        (f"{_WITH} SELECT count(*) AS total FROM f WHERE TRUE{cond}", s.args()),
        (f"{_WITH} SELECT {_CALL_COLS} FROM f WHERE TRUE{cond} "
         f"ORDER BY start_time DESC, id DESC LIMIT ${n + 1}::int OFFSET ${n + 2}::int",
         s.args() + [limit, offset]),
    ])
    return {"total": int(count_rows[0]["total"]),
            "calls": [_shape_call(r) for r in page_rows]}


async def _csv_stream(s: ReportScope, cond: str, cap: int):
    """Yield CSV text: header, then keyset-paginated chunks (each chunk is its
    own short read-only transaction; nothing is held across client I/O)."""
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(rp.CSV_COLUMNS)
    yield buf.getvalue()

    n = len(s.args())
    first_sql = (f"{_WITH} SELECT {_CALL_COLS} FROM f WHERE TRUE{cond} "
                 f"ORDER BY start_time DESC, id DESC LIMIT ${n + 1}::int")
    next_sql = (f"{_WITH} SELECT {_CALL_COLS} FROM f WHERE TRUE{cond} "
                f"AND (start_time, id) < (${n + 2}::timestamptz, ${n + 3}::bigint) "
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
            w.writerow(rp.csv_row(shaped))
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
        f"{_WITH} SELECT count(*) AS n FROM "
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
                     customer_filter: Optional[int] = Depends(get_support_read_filter)):
    """Number-picker list. Tenants: own numbers; staff: customer_id required."""
    if customer_filter is None and customer_id is None:
        raise HTTPException(422, "customer_id is required for staff (a report is about one customer)")
    return await build_my_numbers(customer_filter if customer_filter is not None else customer_id)
