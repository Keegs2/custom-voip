"""Tenant redaction — what a CUSTOMER (non-staff) caller may see of a call.

Business rule (owner, 2026-09): customers must NEVER see how we bill or rate
a call. That means no rates, no costs, no carrier cost, no margin, no rating
state, no fraud internals, no routing/supplier internals — and NO exact call
duration (no seconds, no billable seconds, nothing that exposes the 6-second
billing increment). Staff (admin + support — i.e. `customer_filter is None`
from `get_support_read_filter` / `get_customer_filter`) are unaffected and
keep the full historical shapes.

Design (defense in depth, two layers):

  1. SQL — tenant queries select ONLY `TENANT_CDR_SELECT_COLUMNS` (plus
     `duration_ms`, consumed here and never returned). Sensitive columns are
     not even read for a tenant request.
  2. Response — every tenant CDR row passes through `redact_cdr_row()`, which
     builds the output from the ALLOWLIST `TENANT_CDR_FIELDS`. A column added
     to the SELECT later (or a `SELECT *` regression) cannot leak by default:
     anything not on the allowlist is dropped.

Duration for tenants (`duration_minutes`, whole minutes):
  * unanswered call               -> 0
  * answered, duration_ms <= 0    -> 0
  * answered, duration_ms  > 0    -> max(1, round_half_up(ms / 60000))
    (1s..89s -> 1, 90s -> 2, 3600s -> 60). "Never 0 for an answered call."
  Source is `duration_ms` — the same field staff see as `duration_seconds`
  (FreeSWITCH `duration`, start->end) — so a staff and tenant view of one call
  agree to the minute.

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

#: cdrs columns a tenant query may SELECT (SQL layer). `duration_ms` is read
#: only to derive `duration_minutes` and is removed before the response.
TENANT_CDR_SELECT_COLUMNS: tuple[str, ...] = (
    "uuid", "customer_id", "product_type", "trunk_id", "direction",
    "caller_id", "destination", "start_time", "answer_time", "end_time",
    "duration_ms",
    "hangup_cause", "sip_code", "hangup_cause_q850", "sip_hangup_disposition",
    "sip_from_user", "sip_to_user",
    # Voice quality (customer-meaningful; no duration proxy)
    "mos", "quality_pct", "r_factor",
    "jitter_min_ms", "jitter_max_ms", "jitter_avg_ms",
    "packet_loss_count", "packet_loss_pct", "flaw_total",
    "rtp_audio_in_jitter_burst_rate", "rtp_audio_in_jitter_loss_rate",
    "rtp_audio_in_mean_interval",
    "read_codec", "write_codec", "read_rate", "write_rate",
    # STIR/SHAKEN badge inputs (actual outcome)
    "stir_outcome", "stir_eff_actual",
)

#: The ONLY keys a tenant CDR row may carry in a response (allowlist).
TENANT_CDR_FIELDS: frozenset[str] = frozenset(
    (set(TENANT_CDR_SELECT_COLUMNS) - {"duration_ms"})
    | {
        "duration_minutes",
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
})

assert not (TENANT_CDR_FIELDS & FORBIDDEN_TENANT_CDR_KEYS), (
    "tenant allowlist overlaps the forbidden set")

# Decimal columns that the staff detail endpoint also floats (JSON-friendly).
_FLOAT_KEYS = (
    "mos", "quality_pct", "jitter_min_ms", "jitter_max_ms", "jitter_avg_ms",
    "packet_loss_pct", "r_factor", "rtp_audio_in_jitter_burst_rate",
    "rtp_audio_in_jitter_loss_rate", "rtp_audio_in_mean_interval",
)


def tenant_cdr_select_sql() -> str:
    """Comma-joined tenant SELECT list (column names are module constants —
    never user input — so interpolating them into SQL is safe)."""
    return ", ".join(TENANT_CDR_SELECT_COLUMNS)


def _round_half_up_minutes(ms: int) -> int:
    """Whole minutes, half-up, in pure integer math (no float drift)."""
    return (int(ms) + _HALF_MIN_MS) // _MS_PER_MIN


def duration_minutes(duration_ms: Optional[int], answered: bool) -> int:
    """Per-call tenant duration in whole minutes (see module docstring)."""
    if not answered or duration_ms is None or duration_ms <= 0:
        return 0
    return max(1, _round_half_up_minutes(duration_ms))


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


#: SQL mirror of `duration_minutes()` for server-side averages. Integer
#: division on positive ints == floor, so this is exactly
#: max(1, (ms + 30000) // 60000) for answered calls with ms > 0, else 0.
TENANT_CALL_MINUTES_SQL = (
    "(CASE WHEN answer_time IS NOT NULL AND duration_ms > 0 "
    "THEN GREATEST(1, (duration_ms + 30000) / 60000) ELSE 0 END)"
)


def redact_cdr_row(row: Mapping[str, Any]) -> dict[str, Any]:
    """Tenant CDR row -> response dict, built from the allowlist ONLY.

    Accepts an asyncpg Record or dict. Computes `duration_minutes`, folds the
    STIR badge (same serializer as staff), floors answer/end to the minute,
    floats Decimal quality metrics, then drops every non-allowlisted key.
    """
    src = dict(row)
    answered = src.get("answer_time") is not None
    out: dict[str, Any] = {
        k: v for k, v in src.items()
        if k in TENANT_CDR_FIELDS
    }
    out["duration_minutes"] = duration_minutes(src.get("duration_ms"), answered)
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

