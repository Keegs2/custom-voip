"""Tenant redaction — what a CUSTOMER (non-staff) caller may see of a call.

Business rule (owner, 2026-09): customers must NEVER see how we bill or rate
a call. That means no rates, no costs, no carrier cost, no margin, no rating
state, no fraud internals, no routing/supplier internals — and NO exact call
duration (no seconds, no billable seconds, nothing that exposes the 6-second
billing increment). Staff (admin + support — i.e. `customer_filter is None`
from `get_support_read_filter` / `get_customer_filter`) are unaffected and
keep the full historical shapes.

Design (defense in depth, two layers):

  1. SQL — tenant queries select ONLY `TENANT_CDR_SELECT_COLUMNS` (plus the
     derived `talk_ms`, consumed here and never returned). Sensitive columns
     are not even read for a tenant request. Tenant queries are always
     one-row-per-call (`leg IS DISTINCT FROM 'B'`) — a carrier B-leg row is
     never shown to, or counted for, a customer.
  2. Response — every tenant CDR row passes through `redact_cdr_row()`, which
     builds the output from the ALLOWLIST `TENANT_CDR_FIELDS`. A column added
     to the SELECT later (or a `SELECT *` regression) cannot leak by default:
     anything not on the allowlist is dropped.

Duration for tenants (`duration_minutes`, whole minutes) = TALK TIME:
  * unanswered call               -> 0
  * answered, talk_ms <= 0        -> 0
  * answered, talk_ms  > 0        -> max(1, round_half_up(ms / 60000))
    (1s..89s -> 1, 90s -> 2, 3600s -> 60). "Never 0 for an answered call."
  Source (contract "Customer minutes", docs/CDR_LEG_SPLIT_CONTRACT.md) is the
  talk time computed from the timestamps, `end_time - answer_time`
  (`TALK_MS_SQL`) — NEVER `duration_ms` (start->end, includes ring time) and
  NEVER `billable_ms` (rate_cdr() can overwrite it with billing increments).

Aggregates:
  * totals   -> `total_minutes`: the ANSWERED-call ms total, rounded half-up
    ONCE at the aggregate level (min 1 if any answered talk time). Never the
    sum of per-call minimums/ceilings — that would reproduce per-call billing
    increments.
  * averages -> `avg_duration_minutes`: mean of the per-call whole-minute
    values, 1 decimal ("avg 2.3 min"). Averaging the already-rounded per-call
    minutes (not raw ms) means a window holding a single call cannot reveal
    that call's duration below minute resolution.

Timestamps: `answer_time` / `end_time` are floored to the minute for tenants —
otherwise `end_time - answer_time` re-derives the exact duration and defeats
the rule. `start_time` stays exact (it is not a duration and the tenant tables
sort/display it); floored end minus exact start is still only +/-1 minute.

Everything here is a pure function (no DB, no FastAPI) so it is unit-testable.
"""
from __future__ import annotations

from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Mapping, Optional

from services import stir_outcome as stir_oc

_MS_PER_MIN = 60_000
_HALF_MIN_MS = 30_000

# ---------------------------------------------------------------------------
# CDR rows
# ---------------------------------------------------------------------------

#: Talk time in ms from the timestamps (0 when unanswered / non-positive).
#: Unqualified column names: valid wherever `cdrs` is the only relation (or
#: the unaliased one) in scope. EXTRACT(EPOCH FROM interval) is exact to the
#: microsecond; rounded to whole ms.
TALK_MS_SQL = (
    "(CASE WHEN answer_time IS NOT NULL AND end_time > answer_time "
    "THEN round(EXTRACT(EPOCH FROM (end_time - answer_time)) * 1000)::bigint "
    "ELSE 0 END)"
)

#: cdrs columns a tenant query may SELECT (SQL layer). `talk_ms` (derived,
#: TALK_MS_SQL) is read only to compute `duration_minutes` and is removed
#: before the response.
TENANT_CDR_SELECT_COLUMNS: tuple[str, ...] = (
    "uuid", "customer_id", "product_type", "trunk_id", "direction",
    "caller_id", "destination", "start_time", "answer_time", "end_time",
    "hangup_cause", "sip_code", "hangup_cause_q850", "sip_hangup_disposition",
    "sip_from_user", "sip_to_user",
    # Voice quality (customer-meaningful; no duration proxy). Since
    # migration 50 (docs/CALL_QUALITY_ACCURACY_PLAN.md §E.3) these carry
    # honest values: E-model mos / r_factor, TRUE loss % and lost packets,
    # RFC 3550 jitter — NULL on ungraded calls. quality_pct / jitter_min_ms
    # are deprecated (always NULL). The FS autoflush/CNG skip counter is the
    # staff-only rtp_audio_in_skip_packet_count, never a "loss" key here.
    "mos", "quality_pct", "r_factor",
    "jitter_min_ms", "jitter_max_ms", "jitter_avg_ms",
    "packet_loss_count", "packet_loss_pct", "flaw_total",
    "rtp_audio_in_jitter_burst_rate", "rtp_audio_in_jitter_loss_rate",
    "rtp_audio_in_mean_interval",
    # Migration 50 — grades + honest model inputs (deliberately allowlisted)
    "quality_status", "quality_grade",
    "call_quality_status", "call_quality_grade", "call_mos",
    "burst_ratio", "loss_bursts", "inbound_media_ratio",
    "read_codec", "write_codec", "read_rate", "write_rate",
    # STIR/SHAKEN badge inputs (actual outcome)
    "stir_outcome", "stir_eff_actual",
)

#: The ONLY keys a tenant CDR row may carry in a response (allowlist).
TENANT_CDR_FIELDS: frozenset[str] = frozenset(
    set(TENANT_CDR_SELECT_COLUMNS)
    | {
        "duration_minutes",
        # derived per-direction quality (plan §C.3), built by the CDR detail
        # endpoint from TENANT_QUALITY_DIRECTION_KEYS only
        "quality_by_direction",
        # stir_oc.badge_fields() output
        "stir_attestation", "stir_eff_actual", "stir_outcome",
        "stir_badge", "stir_badge_source",
    }
)

#: Keys that must NEVER appear in a tenant CDR-shaped response. Used by the
#: tests as the negative assertion and documented here so reviewers see the
#: intent; enforcement is the allowlist above, not this list.
FORBIDDEN_TENANT_CDR_KEYS: frozenset[str] = frozenset({
    # money / rating
    "rate_per_min", "total_cost", "carrier_cost", "margin", "rated_at",
    "destination_prefix",
    # exact duration / billing increments
    "duration_ms", "billable_ms", "duration_seconds", "billable_seconds",
    "talk_ms",
    "total_duration_sec", "avg_duration_sec", "avg_duration_ms",
    # duration proxies (RTP volume counters scale 1:1 with talk time)
    "rtp_audio_in_raw_bytes", "rtp_audio_in_media_bytes",
    "rtp_audio_out_raw_bytes", "rtp_audio_out_media_bytes",
    "rtp_audio_in_packet_count", "rtp_audio_out_packet_count",
    "packet_total_count",
    # fraud / grading internals
    "fraud_score", "fraud_flags", "traffic_grade",
    # routing / supplier / infrastructure internals
    "carrier_used", "inbound_carrier", "inbound_carrier_pop", "on_net",
    "on_net_hops", "origin_customer_id", "terminating_customer_id",
    "network_addr", "sip_user_agent", "freeswitch_node", "sbc_id",
    "bridge_uuid",
    # leg-split internals (migration 48) — staff only. (`call_id` is NOT
    # listed: the retired /v1/calls/{id} shape legitimately echoes the
    # caller's own `call_id`; the CDR allowlist excludes the column anyway.)
    "leg", "leg_attempt",
    # call-quality internals (migration 50) — staff only.
    # packets_expected is a 1:1 duration proxy (like packet_total_count);
    # the skip counter is FS autoflush/CNG discards — never shown as "loss".
    "packets_expected", "rtp_audio_in_skip_packet_count", "packets_reordered",
    "ssrc_changes", "fs_mos", "fs_quality_pct", "fs_jitter_max_std_ms",
    "quality_source", "call_quality_leg",
    # derived helper selected for the pre-backfill guard (never returned)
    "quality_legacy_row",
})

#: Keys of each `quality_by_direction` block a TENANT receives (plan §C.3).
#: Every one is also a tenant-allowlisted column.
TENANT_QUALITY_DIRECTION_KEYS: tuple[str, ...] = (
    "quality_status", "quality_grade", "mos", "r_factor",
    "packet_loss_pct", "packet_loss_count", "jitter_avg_ms", "jitter_max_ms",
    "burst_ratio", "inbound_media_ratio",
)

#: Pre-migration-50 rows (quality_source IS NULL — written by the old API and
#: not yet backfilled) still hold the OLD meanings in these two columns: the
#: autoflush skip counter and flaws/packets. They are nulled for tenants so
#: that counter can never reach a customer under a "loss" name.
_LEGACY_MISLEADING_LOSS_KEYS = ("packet_loss_count", "packet_loss_pct")
LEGACY_ROW_FLAG_SQL = "(quality_source IS NULL) AS quality_legacy_row"

assert not (TENANT_CDR_FIELDS & FORBIDDEN_TENANT_CDR_KEYS), (
    "tenant allowlist overlaps the forbidden set")
assert set(TENANT_QUALITY_DIRECTION_KEYS) <= set(TENANT_CDR_SELECT_COLUMNS), (
    "quality_by_direction keys must be tenant-allowlisted columns")

# Decimal columns that the staff detail endpoint also floats (JSON-friendly).
_FLOAT_KEYS = (
    "mos", "quality_pct", "jitter_min_ms", "jitter_max_ms", "jitter_avg_ms",
    "packet_loss_pct", "r_factor", "rtp_audio_in_jitter_burst_rate",
    "rtp_audio_in_jitter_loss_rate", "rtp_audio_in_mean_interval",
    "call_mos", "burst_ratio", "inbound_media_ratio",
)


def tenant_cdr_select_sql() -> str:
    """Comma-joined tenant SELECT list + the derived `talk_ms` (column names
    and the expression are module constants — never user input — so
    interpolating them into SQL is safe)."""
    return (", ".join(TENANT_CDR_SELECT_COLUMNS) + f", {LEGACY_ROW_FLAG_SQL}"
            + f", {TALK_MS_SQL} AS talk_ms")


def neutralize_legacy_quality(row: Mapping[str, Any]) -> dict[str, Any]:
    """Tenant rows only: on a pre-migration-50 row (`quality_legacy_row`
    true) drop the two loss columns that still hold the old, misleading
    meanings. Returns a new dict; other keys untouched."""
    out = dict(row)
    if out.get("quality_legacy_row"):
        for key in _LEGACY_MISLEADING_LOSS_KEYS:
            out[key] = None
    return out


def _round_half_up_minutes(ms: int) -> int:
    """Whole minutes, half-up, in pure integer math (no float drift)."""
    return (int(ms) + _HALF_MIN_MS) // _MS_PER_MIN


def duration_minutes(talk_ms: Optional[int], answered: bool) -> int:
    """Per-call tenant duration in whole minutes from TALK time ms (see
    module docstring)."""
    if not answered or talk_ms is None or talk_ms <= 0:
        return 0
    return max(1, _round_half_up_minutes(talk_ms))


def talk_ms(answer_time: Any, end_time: Any) -> int:
    """Python twin of TALK_MS_SQL (end - answer, ms; 0 if unanswered)."""
    if not isinstance(answer_time, datetime) or not isinstance(end_time, datetime):
        return 0
    delta = end_time - answer_time
    ms = delta.days * 86_400_000 + delta.seconds * 1000 + round(delta.microseconds / 1000)
    return ms if ms > 0 else 0


def aggregate_minutes(total_answered_ms: Optional[int]) -> int:
    """Aggregate tenant minutes: round the answered-call TOTAL once (half-up);
    min 1 when any answered talk time exists."""
    if total_answered_ms is None or total_answered_ms <= 0:
        return 0
    return max(1, _round_half_up_minutes(total_answered_ms))


def average_minutes(avg: Any) -> Optional[float]:
    """1-decimal minutes from an average of per-call whole minutes."""
    if avg is None:
        return None
    return float(Decimal(str(avg)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP))


def floor_to_minute(value: Any) -> Any:
    """Floor a datetime to the minute; pass anything else through."""
    if isinstance(value, datetime):
        return value.replace(second=0, microsecond=0)
    return value


def call_minutes_sql(talk_ms_expr: str = TALK_MS_SQL) -> str:
    """SQL mirror of `duration_minutes()` over a talk-ms expression (a column
    alias such as `talk_ms`, or TALK_MS_SQL itself). Integer division on
    positive bigints == floor, so this is exactly max(1, (ms + 30000) // 60000)
    for answered calls with ms > 0, else 0."""
    return (f"(CASE WHEN answer_time IS NOT NULL AND {talk_ms_expr} > 0 "
            f"THEN GREATEST(1, ({talk_ms_expr} + 30000) / 60000) ELSE 0 END)")


#: Per-call whole minutes straight off `cdrs` columns (server-side averages).
TENANT_CALL_MINUTES_SQL = call_minutes_sql()

#: Answered-call talk-time total (ms) aggregate over `cdrs` columns.
TENANT_ANSWERED_TALK_MS_SQL = (
    f"COALESCE(SUM({TALK_MS_SQL}) FILTER (WHERE answer_time IS NOT NULL), 0)::bigint"
)


def redact_cdr_row(row: Mapping[str, Any]) -> dict[str, Any]:
    """Tenant CDR row -> response dict, built from the allowlist ONLY.

    Accepts an asyncpg Record or dict. Computes `duration_minutes`, folds the
    STIR badge (same serializer as staff), floors answer/end to the minute,
    floats Decimal quality metrics, then drops every non-allowlisted key.
    """
    src = neutralize_legacy_quality(row)
    answered = src.get("answer_time") is not None
    out: dict[str, Any] = {
        k: v for k, v in src.items()
        if k in TENANT_CDR_FIELDS
    }
    talk = src.get("talk_ms")
    if talk is None:
        talk = talk_ms(src.get("answer_time"), src.get("end_time"))
    out["duration_minutes"] = duration_minutes(talk, answered)
    out.update(stir_oc.badge_fields(
        src.get("stir_attestation"),
        src.get("stir_eff_actual"),
        src.get("stir_outcome"),
    ))
    for key in ("answer_time", "end_time"):
        if key in out:
            out[key] = floor_to_minute(out[key])
    for key in _FLOAT_KEYS:
        if out.get(key) is not None:
            out[key] = float(out[key])
    # Final allowlist pass (badge_fields keys are on it; belt and braces).
    return {k: v for k, v in out.items() if k in TENANT_CDR_FIELDS}


# ---------------------------------------------------------------------------
# /v1/cdrs/summary rows
# ---------------------------------------------------------------------------

#: The ONLY keys a tenant summary row may carry.
TENANT_SUMMARY_FIELDS: frozenset[str] = frozenset({
    "date", "hour", "prefix", "product_type", "direction",
    "total_calls", "answered_calls", "total_minutes", "avg_duration_minutes",
})


def redact_summary_row(row: Mapping[str, Any]) -> dict[str, Any]:
    """Tenant summary row: `answered_duration_ms` -> `total_minutes`,
    `avg_call_minutes` -> `avg_duration_minutes`, then allowlist."""
    src = dict(row)
    out = {k: v for k, v in src.items() if k in TENANT_SUMMARY_FIELDS}
    if "answered_duration_ms" in src:
        out["total_minutes"] = aggregate_minutes(src.get("answered_duration_ms"))
    if "avg_call_minutes" in src:
        out["avg_duration_minutes"] = average_minutes(src.get("avg_call_minutes"))
    return {k: v for k, v in out.items() if k in TENANT_SUMMARY_FIELDS}



# ---------------------------------------------------------------------------
# Customer objects (/v1/customers, /v1/customers/me, customer-joined rows)
# ---------------------------------------------------------------------------

#: Roles that see platform internals. Mirrors `get_support_read_filter`
#: (admin + support -> unscoped). An admin in the UI's "View as Customer"
#: mode is still role=admin to the API and therefore still staff.
STAFF_ROLES: frozenset[str] = frozenset({"admin", "support"})

#: Customer-record keys a tenant must NEVER receive. `traffic_grade` is an
#: internal routing grade (owner decision 2026-09); `fraud_score` and the
#: financial/limit columns are already withheld by the tenant SELECTs and are
#: listed here so a future SELECT regression still cannot leak them.
FORBIDDEN_TENANT_CUSTOMER_KEYS: frozenset[str] = frozenset({
    "traffic_grade", "fraud_score", "fraud_flags", "balance", "credit_limit",
})


def is_staff(user: Mapping[str, Any]) -> bool:
    """True for admin/support callers (full internal shapes)."""
    return user.get("role") in STAFF_ROLES


def redact_customer_fields(obj: Mapping[str, Any]) -> dict[str, Any]:
    """Tenant view of a customer (or customer-joined) object: drop every
    forbidden internal key, keep everything else unchanged."""
    return {k: v for k, v in dict(obj).items()
            if k not in FORBIDDEN_TENANT_CUSTOMER_KEYS}
