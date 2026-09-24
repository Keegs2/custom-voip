"""Customer Reporting — pure logic (no DB, no FastAPI).

Contract: docs/CUSTOMER_REPORTING_DESIGN.md. The router (routers/reports.py)
owns the SQL; everything here is deterministic and unit-testable:

  * request validation   — local-date range, 366-day cap, tz name shape,
                           the `numbers` filter (canonical +E.164 only)
  * bucket selection     — day / week / month for the trend endpoint
  * plain-English labels — missed-call reasons (hangup_cause -> key/label),
                           outcomes, directions, call-quality grades (MOS)
  * shaping              — percentages, MOS rounding, CSV rows (with
                           spreadsheet formula-injection guarding)

Hard rules this module helps enforce (see the design doc):
  * Durations are WHOLE MINUTES only — minute math is delegated to
    services/tenant_redaction.py (`aggregate_minutes`, `average_minutes`,
    `TENANT_CALL_MINUTES_SQL`); nothing here ever emits seconds or costs.
  * No routing internals: a missed call's reason is a fixed plain-English
    label, never the raw hangup cause / SIP code.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Iterable, Optional

from services import call_quality as cq

from utils.phone import normalize_e164

#: Longest report window (inclusive local days).
MAX_SPAN_DAYS = 366
#: Default IANA zone when the caller passes none.
DEFAULT_TZ = "America/New_York"
#: At most this many numbers may be named in the `numbers` filter.
MAX_NUMBER_FILTER = 500
#: Hard caps (every query is LIMITed).
MAX_NUMBERS_ROWS = 500          # GET /reports/numbers
MAX_MY_NUMBERS_ROWS = 5000      # GET /reports/my-numbers (picker)
MAX_CALLS_PAGE = 500            # GET /reports/calls limit ceiling
CSV_ROW_CAP = 100_000           # GET /reports/calls.csv

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# IANA names (and PG's extra aliases) are letters, digits, '_', '+', '-', '/'.
# This is only a cheap pre-filter; the authority is pg_timezone_names.
_TZ_SHAPE_RE = re.compile(r"^[A-Za-z0-9_+\-/]{1,64}$")


class ReportValidationError(ValueError):
    """Bad report parameters -> the router maps this to HTTP 422."""


# ---------------------------------------------------------------------------
# Date range / timezone
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Period:
    start: date
    end: date   # inclusive

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1

    def previous(self) -> "Period":
        """The same number of days immediately before `start`."""
        prev_end = self.start - timedelta(days=1)
        return Period(prev_end - timedelta(days=self.days - 1), prev_end)


def parse_local_date(value: Optional[str], field: str) -> date:
    """Strict YYYY-MM-DD (no datetimes, no epoch ints)."""
    if not value or not _DATE_RE.match(value):
        raise ReportValidationError(f"{field} must be a date formatted YYYY-MM-DD")
    try:
        d = date.fromisoformat(value)
    except ValueError as e:
        raise ReportValidationError(f"{field} is not a real calendar date") from e
    # Keep far from date.min/max so previous-period / +1 day math never
    # overflows (and nothing sane asks for year 1 or 9999).
    if not (2000 <= d.year <= 2999):
        raise ReportValidationError(f"{field} is out of range")
    return d


def parse_period(start: Optional[str], end: Optional[str]) -> Period:
    """Validate the inclusive local-date range (end >= start, <= 366 days)."""
    s = parse_local_date(start, "start")
    e = parse_local_date(end, "end")
    if e < s:
        raise ReportValidationError("end must be on or after start")
    p = Period(s, e)
    if p.days > MAX_SPAN_DAYS:
        raise ReportValidationError(
            f"date range is too long ({p.days} days); the maximum is {MAX_SPAN_DAYS} days")
    return p


def tz_shape_ok(tz: Optional[str]) -> bool:
    """Cheap syntactic pre-check before the pg_timezone_names lookup."""
    return bool(tz) and bool(_TZ_SHAPE_RE.match(tz)) and ".." not in tz


def parse_numbers_filter(raw: Optional[str]) -> Optional[list[str]]:
    """`numbers` query param -> canonical +E.164 list, or None (no filter).

    Returns None when the parameter is absent/blank. Otherwise returns the
    de-duplicated canonical numbers; entries that don't parse as a phone
    number are dropped silently (the SQL then intersects with the customer's
    OWN numbers, so a not-owned or junk entry can only narrow — never widen —
    and never acts as an existence oracle). An all-junk list yields [] which
    matches nothing.
    """
    if raw is None or not raw.strip():
        return None
    out: list[str] = []
    seen: set[str] = set()
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            n = normalize_e164(part)
        except ValueError:
            continue
        if n not in seen:
            seen.add(n)
            out.append(n)
        if len(out) > MAX_NUMBER_FILTER:
            raise ReportValidationError(
                f"too many numbers (max {MAX_NUMBER_FILTER})")
    return out


# ---------------------------------------------------------------------------
# Trend buckets
# ---------------------------------------------------------------------------
BUCKETS = ("day", "week", "month")


def auto_bucket(days: int) -> str:
    """day if <= 62 days, week if <= 190, else month."""
    if days <= 62:
        return "day"
    if days <= 190:
        return "week"
    return "month"


def choose_bucket(requested: Optional[str], days: int) -> str:
    if requested is None or requested == "":
        return auto_bucket(days)
    if requested not in BUCKETS:
        raise ReportValidationError("bucket must be day, week or month")
    return requested


# ---------------------------------------------------------------------------
# Missed-call reasons, outcomes, directions
# ---------------------------------------------------------------------------
MISSED_REASONS: dict[str, str] = {
    "no_answer": "Nobody picked up",
    "caller_hung_up": "The caller hung up before it was answered",
    "busy": "The line was busy",
    "not_in_service": "The number called isn't in service",
    "declined": "The call was declined or blocked",
    "network": "A network problem stopped the call",
}

_CAUSE_TO_REASON: dict[str, str] = {
    "NO_ANSWER": "no_answer",
    "NO_USER_RESPONSE": "no_answer",
    "ALLOTTED_TIMEOUT": "no_answer",
    "ORIGINATOR_CANCEL": "caller_hung_up",
    "USER_BUSY": "busy",
    "UNALLOCATED_NUMBER": "not_in_service",
    "INVALID_NUMBER_FORMAT": "not_in_service",
    "NO_ROUTE_DESTINATION": "not_in_service",
    "CALL_REJECTED": "declined",
}

#: Stable display order for ties in the missed-reasons list.
_REASON_ORDER = {k: i for i, k in enumerate(MISSED_REASONS)}


def missed_reason_key(hangup_cause: Optional[str]) -> str:
    """FreeSWITCH hangup_cause -> plain-English reason key ("network" default)."""
    if not hangup_cause:
        return "network"
    return _CAUSE_TO_REASON.get(str(hangup_cause).strip().upper(), "network")


def missed_reasons_list(cause_counts: Iterable[tuple[Optional[str], int]]) -> list[dict]:
    """[(hangup_cause, missed_calls)] -> contract list, sorted by calls desc.

    Only reasons with at least one missed call are listed.
    """
    totals: dict[str, int] = {}
    for cause, n in cause_counts:
        if not n:
            continue
        k = missed_reason_key(cause)
        totals[k] = totals.get(k, 0) + int(n)
    ordered = sorted(totals.items(), key=lambda kv: (-kv[1], _REASON_ORDER[kv[0]]))
    return [{"key": k, "label": MISSED_REASONS[k], "calls": n} for k, n in ordered]


def direction_of(raw: Optional[str]) -> str:
    """cdrs.direction -> 'outbound' | 'inbound' (anything not outbound is
    inbound — the same rule the SQL uses to pick the customer's number)."""
    return "outbound" if (raw or "").lower() == "outbound" else "inbound"


def outcome_fields(answered: bool, hangup_cause: Optional[str]) -> dict:
    """outcome / outcome_label / missed_reason for one call."""
    if answered:
        return {"outcome": "answered", "outcome_label": "Answered", "missed_reason": None}
    key = missed_reason_key(hangup_cause)
    return {"outcome": "missed", "outcome_label": MISSED_REASONS[key], "missed_reason": key}


# ---------------------------------------------------------------------------
# Quality grade / numeric shaping
# ---------------------------------------------------------------------------
GRADE_LABELS = {"great": "Great", "good": "Good", "fair": "Fair", "poor": "Poor",
                "none": "Not rated"}


def grade_for_mos(mos: Any) -> str:
    """Stored 2-dp MOS -> great / good / fair / poor, or "none" (not graded).

    Delegates to services/call_quality.grade_for_mos — the ONE grade
    definition (docs/CALL_QUALITY_ACCURACY_PLAN.md §D, G.107/G.109 R bands
    90/80/70): great >= 4.34, good >= 4.02, fair >= 3.60, poor < 3.60. A
    one-way-audio call (quality_status 'no_rtp') is graded poor with no MOS;
    per-call report rows therefore take the stored grade word
    (cdrs.call_quality_grade), not this function. Only answered calls of 5 s
    or more with measurable audio are graded.
    """
    return cq.grade_for_mos(mos) or "none"


def _q(value: Any, places: str) -> float:
    return float(Decimal(str(value)).quantize(Decimal(places), rounding=ROUND_HALF_UP))


def pct(numerator: Any, denominator: Any) -> Optional[float]:
    """1-decimal percentage; None when there is no denominator."""
    if not denominator:
        return None
    return _q(Decimal(int(numerator or 0)) * 100 / Decimal(int(denominator)), "0.1")


def round_mos(mos: Any) -> Optional[float]:
    return None if mos is None else _q(mos, "0.01")


# ---------------------------------------------------------------------------
# Timestamps / CSV
# ---------------------------------------------------------------------------
def format_offset(seconds: int) -> str:
    """UTC offset in seconds -> '+HH:MM' / '-HH:MM'."""
    sign = "+" if seconds >= 0 else "-"
    s = abs(int(seconds))
    return f"{sign}{s // 3600:02d}:{(s % 3600) // 60:02d}"


def iso_local(local_ts, offset_seconds: int) -> str:
    """Naive local timestamp + offset -> ISO-8601 with offset, to the second."""
    return local_ts.replace(microsecond=0).isoformat() + format_offset(offset_seconds)


CSV_COLUMNS = (
    "Date", "Time", "Direction", "From", "To", "Your number", "Outcome",
    "Length (minutes, rounded)", "Call quality",
)

_PHONE_RE = re.compile(r"^\+[0-9 ().-]*$")


def csv_safe(value: Any) -> str:
    """Neutralize spreadsheet formula injection (=, +, -, @, tab, CR prefixes)
    while leaving E.164-style phone numbers like '+16175551234' untouched."""
    if value is None:
        return ""
    s = str(value)
    if s and s[0] in ("=", "@", "-", "\t", "\r"):
        return "'" + s
    if s and s[0] == "+" and not _PHONE_RE.match(s):
        return "'" + s
    return s


def csv_row(row: dict) -> list[str]:
    """A shaped call (see routers/reports.py `_shape_call`) -> CSV cells."""
    local = row["_local"]
    return [
        local.strftime("%Y-%m-%d"),
        local.strftime("%H:%M"),
        row["direction"].capitalize(),
        csv_safe(row["from"]),
        csv_safe(row["to"]),
        csv_safe(row["number"]),
        row["outcome_label"],
        str(row["length_minutes"]),
        GRADE_LABELS[row["quality"]],
    ]
