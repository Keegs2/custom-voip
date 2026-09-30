"""CDR call-activity aggregate — GET /v1/cdrs/activity (RCF "Call Activity" tab).

Replaces the UI's client-side roll-up of the latest 200 CDRs with ONE
server-side aggregate over a fixed, zero-filled time window.

Everything here except `run_activity_query` is pure (no DB, no FastAPI) so it
is unit-testable: window/bucket math, SQL text + bind list, response shaping.

Row semantics mirror the UI math 1:1 so numbers do not shift when the tab
switches from the 200-row client roll-up to this endpoint:

  * One row per call — `leg IS DISTINCT FROM 'B'` (the canonical
    ONE_ROW_PER_CALL_SQL, same as GET /v1/cdrs leg="calls"); carrier B-legs
    never count.
  * answered — UI: `answer_time != null && hasTalkTime(cdr)`, where
    hasTalkTime reads the row shape the caller actually receives:
      staff rows  -> duration_seconds > 0  == COALESCE(duration_ms, 0) > 0
      tenant rows -> duration_minutes > 0  == TALK_MS_SQL > 0
                     (tenant_redaction.duration_minutes: >= 1 iff talk ms > 0)
  * quality — mirrors ui/.../calls/quality.ts summarizeCallQuality:
      graded         = call_quality_grade IS NOT NULL
      good_or_better = grade IN ('great','good')
      poor           = grade = 'poor'
      one_way        = call_quality_status = 'no_rtp'   (counted ungraded too)
      median_mos     = percentile_cont(0.5) over GRADED rows with
                       call_quality_status = 'rated' AND call_mos IS NOT NULL
  * avg duration — staff: mean duration_ms/1000 over answered calls
    (fmtAvgCallDuration's exact branch). Tenant: mean of per-call WHOLE
    minutes over answered calls, 1 decimal (tenant_redaction conventions;
    tenants never receive seconds or costs).

Windows / buckets (all in the caller's IANA `tz`):
  24h -> 24 hourly buckets ending with the current (partial) local hour.
         Buckets are 24 consecutive ABSOLUTE hours anchored on the local hour
         boundary, so a DST change never drops or merges a bucket.
  7d  -> 7 local days (today + previous 6).
  30d -> 30 local days.
  90d -> ISO weeks (Monday start, local) covering the last 90 local days
         (13 or 14 points; the first week is clipped at the window start —
         its `t` is still that week's Monday).
The scan window is always the sargable `start_time >= lo AND start_time < hi`
over bind params, so the (customer_id, start_time) / start_time indexes and
Timescale chunk exclusion apply.
"""
from __future__ import annotations

import logging
import os
import zoneinfo
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone, tzinfo
from typing import Any, Literal, Optional

import asyncpg
from fastapi import HTTPException

from db import database as db
from services import tenant_redaction as tr

logger = logging.getLogger(__name__)

ActivityRange = Literal["24h", "7d", "30d", "90d"]
BucketUnit = Literal["hour", "day", "week"]


def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    try:
        v = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return max(lo, min(hi, v))


#: Per-statement ceiling (ms) for the activity aggregate. Short on purpose:
#: this runs on the East primary next to CDR ingest. Env-tunable, clamped.
ACTIVITY_STATEMENT_TIMEOUT_MS = _env_int("CDR_ACTIVITY_STATEMENT_TIMEOUT_MS", 8_000, 1_000, 30_000)

#: One row per call (== routers.cdrs.ONE_ROW_PER_CALL_SQL; kept textually
#: identical so `grep "leg IS DISTINCT FROM 'B'"` finds every call counter).
ONE_ROW_PER_CALL_SQL = "leg IS DISTINCT FROM 'B'"


# ---------------------------------------------------------------------------
# Time zone validation
# ---------------------------------------------------------------------------
_TZ_NAMES: Optional[dict[str, str]] = None


def canonical_tz(name: Optional[str]) -> Optional[str]:
    """Case-insensitive IANA name -> canonical spelling, or None if unknown.

    Validated against the system tz database (zoneinfo), never by opening an
    arbitrary path: only names in `available_timezones()` are accepted.
    "UTC" is always accepted (no tzdata needed for it)."""
    global _TZ_NAMES
    if not name or len(name) > 64:
        return None
    if name.upper() == "UTC":
        return "UTC"
    if _TZ_NAMES is None:
        _TZ_NAMES = {n.lower(): n for n in zoneinfo.available_timezones()}
    return _TZ_NAMES.get(name.lower())


def tzinfo_for(name: str) -> tzinfo:
    return timezone.utc if name == "UTC" else zoneinfo.ZoneInfo(name)


# ---------------------------------------------------------------------------
# Window / buckets
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class ActivityWindow:
    range: str
    bucket: BucketUnit
    tz: str
    lo: datetime                 # inclusive, aware UTC
    hi: datetime                 # exclusive, aware UTC
    bucket_starts: tuple[datetime, ...]   # aware, in `tz`, one per point
    anchor_date: Optional[date]  # day/week: local date of bucket 0 (None for hour)


def _local_midnight(d: date, tz: tzinfo) -> datetime:
    return datetime.combine(d, time(0), tzinfo=tz)


def compute_window(range_: str, tz_name: str, now: datetime) -> ActivityWindow:
    """Fixed bucket layout for `range_` ending at `now` (aware) in `tz_name`."""
    tz = tzinfo_for(tz_name)
    local_now = now.astimezone(tz)

    if range_ == "24h":
        cur_hour = local_now.replace(minute=0, second=0, microsecond=0)
        hi = cur_hour.astimezone(timezone.utc) + timedelta(hours=1)
        lo = hi - timedelta(hours=24)
        starts = tuple((lo + timedelta(hours=i)).astimezone(tz) for i in range(24))
        return ActivityWindow(range_, "hour", tz_name, lo, hi, starts, None)

    today = local_now.date()
    hi = _local_midnight(today + timedelta(days=1), tz).astimezone(timezone.utc)
    if range_ in ("7d", "30d"):
        n = 7 if range_ == "7d" else 30
        first = today - timedelta(days=n - 1)
        lo = _local_midnight(first, tz).astimezone(timezone.utc)
        starts = tuple(_local_midnight(first + timedelta(days=i), tz) for i in range(n))
        return ActivityWindow(range_, "day", tz_name, lo, hi, starts, first)

    if range_ == "90d":
        first_day = today - timedelta(days=89)
        lo = _local_midnight(first_day, tz).astimezone(timezone.utc)
        first_monday = first_day - timedelta(days=first_day.weekday())
        last_monday = today - timedelta(days=today.weekday())
        n = (last_monday - first_monday).days // 7 + 1
        starts = tuple(_local_midnight(first_monday + timedelta(weeks=i), tz)
                       for i in range(n))
        return ActivityWindow(range_, "week", tz_name, lo, hi, starts, first_monday)

    raise ValueError(f"unknown range {range_!r}")


# ---------------------------------------------------------------------------
# SQL
# ---------------------------------------------------------------------------
#: Bucket index expressions (0..n-1). Only fixed text; $1 lo, $3 tz, $4 anchor
#: (local date of bucket 0 — the first day, or the first week's Monday).
_BUCKET_SQL: dict[str, str] = {
    "hour": "floor(EXTRACT(EPOCH FROM (start_time - $1::timestamptz)) / 3600)::int",
    "day": "((start_time AT TIME ZONE $3::text)::date - $4::date)",
    "week": "(((date_trunc('week', start_time AT TIME ZONE $3::text))::date - $4::date) / 7)",
}

_STAFF_ANSWERED_SQL = "(answer_time IS NOT NULL AND COALESCE(duration_ms, 0) > 0)"
_TENANT_ANSWERED_SQL = f"(answer_time IS NOT NULL AND {tr.TALK_MS_SQL} > 0)"


def build_activity_query(
    window: ActivityWindow,
    *,
    staff: bool,
    customer_id: Optional[int],
    product_type: Optional[str],
    destination: Optional[str],
) -> tuple[str, list[Any]]:
    """ONE statement: per-bucket rows + the window total via GROUPING SETS.

    Every user value is a bind with an explicit ::type cast (PgBouncer +
    statement_cache_size=0); only fixed fragments are concatenated. Tenant
    SQL never references duration_ms/billable_ms/cost columns at all.
    """
    args: list[Any] = [window.lo, window.hi]
    if window.bucket == "hour":
        # The hour bucket is absolute (anchored on lo); tz/anchor are not
        # referenced, so they are not bound (asyncpg rejects unused binds).
        bucket_sql = _BUCKET_SQL["hour"]
        idx = 3
    else:
        bucket_sql = _BUCKET_SQL[window.bucket]
        args += [window.tz, window.anchor_date]
        idx = 5

    where = (
        "WHERE start_time >= $1::timestamptz AND start_time < $2::timestamptz"
        f" AND {ONE_ROW_PER_CALL_SQL}"
    )
    # `is not None`: customer_id=0 (unmatched-call ingest default) is a real
    # filter, same rule as _build_cdr_filters.
    if customer_id is not None:
        where += f" AND customer_id = ${idx}::int"
        args.append(customer_id)
        idx += 1
    if product_type:
        where += f" AND product_type = ${idx}::varchar"
        args.append(product_type)
        idx += 1
    if destination:
        # EXACT match: the UI filters `c.destination === selectedDid`.
        where += f" AND destination = ${idx}::varchar"
        args.append(destination)
        idx += 1

    answered_sql = _STAFF_ANSWERED_SQL if staff else _TENANT_ANSWERED_SQL
    if staff:
        duration_col = "duration_ms::float8 AS dur_ms"
        duration_agg = "avg(dur_ms) FILTER (WHERE ans) / 1000.0 AS avg_duration_sec"
    else:
        duration_col = f"{tr.TENANT_CALL_MINUTES_SQL} AS call_minutes"
        duration_agg = "avg(call_minutes) FILTER (WHERE ans) AS avg_call_minutes"

    sql = f"""
WITH f AS (
    SELECT {bucket_sql} AS b,
           {answered_sql} AS ans,
           call_quality_grade AS grade,
           call_quality_status AS qstatus,
           call_mos::float8 AS mos,
           {duration_col}
      FROM cdrs
     {where}
)
SELECT (GROUPING(b) = 1) AS is_total,
       b,
       count(*) AS calls,
       count(*) FILTER (WHERE ans) AS answered,
       count(*) FILTER (WHERE grade IS NOT NULL) AS graded,
       count(*) FILTER (WHERE grade IN ('great', 'good')) AS good_or_better,
       count(*) FILTER (WHERE grade = 'poor') AS poor,
       count(*) FILTER (WHERE qstatus = 'no_rtp') AS one_way,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY mos)
           FILTER (WHERE grade IS NOT NULL AND qstatus = 'rated' AND mos IS NOT NULL)
           AS median_mos,
       {duration_agg}
  FROM f
 GROUP BY GROUPING SETS ((b), ())
"""
    return sql, args


# ---------------------------------------------------------------------------
# Shaping
# ---------------------------------------------------------------------------
def pct(num: int, den: int) -> Optional[float]:
    """0-100, 1 decimal; None when the denominator is 0."""
    return round(num * 100.0 / den, 1) if den else None


def _mos(v: Any) -> Optional[float]:
    return None if v is None else round(float(v), 2)


def _counts(row: Optional[dict]) -> dict[str, Any]:
    r = row or {}
    calls = int(r.get("calls") or 0)
    answered = int(r.get("answered") or 0)
    graded = int(r.get("graded") or 0)
    good = int(r.get("good_or_better") or 0)
    return {
        "calls": calls,
        "answered": answered,
        "asr_pct": pct(answered, calls),
        "graded": graded,
        "good_or_better": good,
        "good_share_pct": pct(good, graded),
        "poor": int(r.get("poor") or 0),
        "one_way": int(r.get("one_way") or 0),
        "median_mos": _mos(r.get("median_mos")),
    }


def shape_activity(window: ActivityWindow, rows: list[Any], *, staff: bool) -> dict[str, Any]:
    """DB rows (GROUPING SETS output) -> the response contract, zero-filled."""
    total: Optional[dict] = None
    by_bucket: dict[int, dict] = {}
    for rec in rows:
        r = dict(rec)
        if r["is_total"]:
            total = r
        elif r["b"] is not None:
            by_bucket[int(r["b"])] = r

    kpis = _counts(total)
    if staff:
        avg = (total or {}).get("avg_duration_sec")
        kpis["avg_duration_sec"] = None if avg is None else round(float(avg), 1)
    else:
        kpis["avg_duration_minutes"] = tr.average_minutes((total or {}).get("avg_call_minutes"))

    points = []
    for i, start in enumerate(window.bucket_starts):
        c = _counts(by_bucket.get(i))
        points.append({
            "t": start.isoformat(),
            "calls": c["calls"],
            "answered": c["answered"],
            "missed": c["calls"] - c["answered"],
            "asr_pct": c["asr_pct"],
            "graded": c["graded"],
            "good_or_better": c["good_or_better"],
            "good_share_pct": c["good_share_pct"],
            "one_way": c["one_way"],
            "median_mos": c["median_mos"],
        })

    tz = tzinfo_for(window.tz)
    return {
        "range": window.range,
        "bucket": window.bucket,
        "tz": window.tz,
        "start": window.lo.astimezone(tz).isoformat(),
        "end": window.hi.astimezone(tz).isoformat(),
        "kpis": kpis,
        "points": points,
    }


# ---------------------------------------------------------------------------
# DB
# ---------------------------------------------------------------------------
async def run_activity_query(sql: str, args: list[Any]) -> list[asyncpg.Record]:
    """ONE short READ ONLY transaction with SET LOCAL statement_timeout
    (transaction-scoped => PgBouncer-transaction-pooling safe; same pattern
    as routers/reports.py `_run`). Timeout -> 503; a tz PostgreSQL does not
    recognise (zoneinfo/PG tzdata skew) -> 422."""
    pool = await db.get_pool()
    try:
        async with pool.acquire() as conn:
            async with conn.transaction(readonly=True):
                await conn.execute(
                    f"SET LOCAL statement_timeout = {int(ACTIVITY_STATEMENT_TIMEOUT_MS)}")
                return await conn.fetch(sql, *args)
    except asyncpg.exceptions.QueryCanceledError as e:
        logger.warning("cdr activity query cancelled (statement_timeout %sms): %s",
                       ACTIVITY_STATEMENT_TIMEOUT_MS, e)
        raise HTTPException(503, "Call activity is taking too long. Try a shorter range.") from e
    except asyncpg.exceptions.InvalidParameterValueError as e:
        logger.info("cdr activity: tz rejected by PostgreSQL: %s", e)
        raise HTTPException(422, "unknown time zone") from e


def utc_now() -> datetime:
    """Seam for tests (monkeypatch to pin the window)."""
    return datetime.now(timezone.utc)
