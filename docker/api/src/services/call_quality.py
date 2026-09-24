"""Call-quality model — the ONE place MOS / R / loss / grade are computed.

Contract: docs/CALL_QUALITY_ACCURACY_PLAN.md (sections B.1, B.2, B.3, C, D).
This module is PURE (stdlib only: no DB, no FastAPI, no project imports) so it
can be imported read-only by:

  * routers/cdrs.py            — ingest (`assess_leg`), per A and B row
  * services/reporting.py      — `grade_for_mos` delegates here
  * docker/freeswitch/lab/eval_cdrs.py — the SIPp/netem acceptance lab
  * tests                      — incl. the Python/SQL parity test against the
                                 IMMUTABLE `cq_*` functions of migrations 50/51

Model: ITU-T G.107 E-model, packet-loss impairment only.

    R0      = 93.2    G.107 default Ro - Is (all default parameters, T=Ta=Tr=0)
    ID      = 0.0     delay impairment: no mouth-to-ear delay measurement exists
                      on this path (RTCP RTT at FS covers one segment only);
                      G.107 default T=0 -> Id ~ 0
    A       = 0       advantage factor
    Ie_eff  = Ie + (95 - Ie) * Ppl / (Ppl / BurstR + Bpl)          G.107 (7-29)
    R       = clamp(R0 - ID - Ie_eff + A, 0, 100)
    MOS     = 1 + 0.035 R + 7e-6 R (R-60)(100-R)                   G.107 Annex B
              (1.0 for R <= 0, 4.5 for R >= 100)

A perfectly clean G.711 call is 4.41 (the G.107 ceiling for G.711 at default
delay), not 4.50. Bpl = 25.1 (G.711 WITH PLC): FS relays bridged audio frame by
frame in default media mode and never forwards the CNG frame that stands in
for a missing packet, so the far-end receiver conceals the gap. See plan B.1.

The float arithmetic below is written in EXACTLY the operation order of the
SQL functions `cq_r_factor` / `cq_mos` (migration 50) so both engines produce
bit-identical float8 results; `round_half_up` mirrors `round(x::numeric, 2)`.
"""
from __future__ import annotations

import logging
import math
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Mapping, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# B.1 — model constants (named; changing one is a one-line change + a history
# re-run of docker/postgres/backfill/50_cdr_quality_backfill.psql)
# ---------------------------------------------------------------------------
R0 = 93.2
ID = 0.0
A = 0
#: (Ie, Bpl) per codec — ITU-T G.113 Appendix I.
CODEC_PARAMS: dict[str, tuple[float, float]] = {
    "PCMU": (0.0, 25.1),
    "PCMA": (0.0, 25.1),
    "G729": (11.0, 19.0),
}
#: Unknown codec -> G.711 params (logged once per codec name).
DEFAULT_CODEC: tuple[float, float] = (0.0, 25.1)
BURST_R_MIN, BURST_R_MAX = 1.0, 10.0

# ---------------------------------------------------------------------------
# B.2 — rating rule constants
# ---------------------------------------------------------------------------
MIN_TALK_MS = 5000
MIN_PACKETS = 250
#: Inbound media gate: a leg whose inbound packets are < NO_RTP_RATIO of the
#: packets its talk time implies (billable_ms / ptime) received (almost) no
#: audio. Which of the two "no inbound audio" statuses it gets depends on the
#: OUTBOUND side (migration 51, owner-approved 2026-09-24):
NO_RTP_RATIO = 0.10
#: ... we SENT >= ONE_WAY_MIN_OUT_RATIO of the expected packets -> TRUE
#: one-way audio (`no_rtp`, graded poor). We sent less, or the outbound count
#: is unknown -> no media in EITHER direction (`no_media`, not graded): a
#: failed / test call, or both parties silent (hold, DTX). Same expected basis
#: as the inbound gate. Mirrored by SQL cq_leg_status(bool,int,int,int,int).
ONE_WAY_MIN_OUT_RATIO = 0.50
DEFAULT_PTIME_MS = 20
PTIME_MIN_MS, PTIME_MAX_MS = 10, 120

# quality_status values (cdrs.quality_status / call_quality_status, VARCHAR(12))
STATUS_UNANSWERED = "unanswered"
STATUS_NO_DATA = "no_data"
STATUS_SHORT = "short"
STATUS_NO_RTP = "no_rtp"
STATUS_NO_MEDIA = "no_media"
STATUS_LOW_SAMPLE = "low_sample"
STATUS_RATED = "rated"
STATUSES = (STATUS_RATED, STATUS_NO_RTP, STATUS_NO_MEDIA, STATUS_LOW_SAMPLE,
            STATUS_SHORT, STATUS_UNANSWERED, STATUS_NO_DATA)
#: statuses that carry a grade: rated (from the MOS) and no_rtp (poor)
GRADED_STATUSES = frozenset({STATUS_RATED, STATUS_NO_RTP})
#: statuses for which inbound_media_ratio is meaningful (B.3; no_media since 51)
MEDIA_RATIO_STATUSES = frozenset({STATUS_RATED, STATUS_NO_RTP, STATUS_NO_MEDIA,
                                  STATUS_LOW_SAMPLE})

# quality_source values (cdrs.quality_source, VARCHAR(16))
SOURCE_PATCH = "fs_patch_v1"      # patched FS image (rtp_audio_in_qpatch=1 + seq vars)
SOURCE_LEGACY = "fs_legacy"       # unpatched image: loss from rtp_audio_in_jitter_loss_rate
SOURCE_BACKFILL = "backfill_v1"   # history recomputed by the migration-50 backfill

# ---------------------------------------------------------------------------
# D — the ONE grade definition (G.109 R bands 90/80/70 -> MOS, 2 dp), applied
# to the STORED 2-dp MOS.
# ---------------------------------------------------------------------------
GRADE_GREAT_MIN = Decimal("4.34")   # R >= 90  "very satisfied"
GRADE_GOOD_MIN = Decimal("4.02")    # R >= 80  "satisfied"
GRADE_FAIR_MIN = Decimal("3.60")    # R >= 70  "some users dissatisfied"
GRADES = ("great", "good", "fair", "poor")
_GRADE_RANK = {"poor": 0, "fair": 1, "good": 2, "great": 3}

# Column bounds (05_schema_cdr.sql / 50_cdr_quality_accuracy.sql)
_INT32_MAX = 2**31 - 1
_SMALLINT_MAX = 32767
_NUMERIC_3_2_MAX = 9.99
_NUMERIC_5_2_MAX = 999.99
_NUMERIC_6_3_MAX = 999.999
_NUMERIC_8_3_MAX = 99999.999
_NUMERIC_8_4_MAX = 9999.9999

_logged_unknown_codecs: set[str] = set()


# ---------------------------------------------------------------------------
# Small, defensive parsers (FS variables are strings; anything may be garbage)
# ---------------------------------------------------------------------------

def _to_float(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(v) or math.isinf(v):
        return None
    return v


def _to_int(value: Any) -> Optional[int]:
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        v = _to_float(value)
        return int(v) if v is not None and v.is_integer() else None


def _clamp_int(value: Any, lo: int = 0, hi: int = _INT32_MAX) -> Optional[int]:
    v = _to_int(value)
    if v is None:
        return None
    return min(max(v, lo), hi)


def round_half_up(x: Optional[float], places: int = 2) -> Optional[float]:
    """Contract rounding: Decimal(repr(x)).quantize(10**-places, ROUND_HALF_UP).

    Mirrors SQL `round(x::numeric, places)` (numeric round is half away from
    zero; every value rounded here is >= 0). None / NaN / inf -> None.
    """
    if x is None:
        return None
    try:
        if math.isnan(x) or math.isinf(x):
            return None
        q = Decimal(1).scaleb(-places)
        return float(Decimal(repr(float(x))).quantize(q, rounding=ROUND_HALF_UP))
    except (InvalidOperation, ValueError, TypeError):
        return None


def _clamped(x: Optional[float], lo: float, hi: float, places: int) -> Optional[float]:
    if x is None:
        return None
    return round_half_up(min(max(x, lo), hi), places)


# ---------------------------------------------------------------------------
# B.1 — the model
# ---------------------------------------------------------------------------

def codec_params(codec_name: Any) -> tuple[float, float]:
    """(Ie, Bpl) for a codec name (case-insensitive). Unknown -> G.711 params,
    logged once per distinct name per process."""
    key = str(codec_name or "").strip().upper()
    if key in CODEC_PARAMS:
        return CODEC_PARAMS[key]
    if key and key not in _logged_unknown_codecs:
        _logged_unknown_codecs.add(key)
        logger.info("call_quality: unknown codec %r — using G.711 E-model "
                    "params (Ie=%s, Bpl=%s)", key, *DEFAULT_CODEC)
    return DEFAULT_CODEC


def clamp_burst_r(burst_r: Any) -> float:
    """clamp(burst_r or 1.0, 1, 10). None/NaN/garbage -> 1.0."""
    b = _to_float(burst_r)
    if b is None or b == 0:
        b = 1.0
    return min(max(b, BURST_R_MIN), BURST_R_MAX)


def r_factor(loss_pct: Any, burst_r: Any = 1.0, ie: float = 0.0,
             bpl: float = 25.1) -> Optional[float]:
    """Unrounded G.107 R for a loss percentage (None/NaN -> None).

    Same float8 operation order as SQL cq_r_factor(): loss clamped [0,100],
    BurstR COALESCE'd to 1 then clamped [1,10].
    """
    p = _to_float(loss_pct)
    if p is None:
        return None
    p = min(max(p, 0.0), 100.0)
    b = _to_float(burst_r)
    b = min(max(1.0 if b is None else b, 1.0), 10.0)
    ie = float(ie)
    bpl = float(bpl)
    r = R0 - ID - (ie + (95 - ie) * p / (p / b + bpl)) + A
    return max(0.0, min(100.0, r))


def mos_from_r(r: Optional[float]) -> Optional[float]:
    """Unrounded MOS from R (G.107 Annex B). Mirrors SQL cq_mos()."""
    if r is None:
        return None
    if r <= 0:
        return 1.0
    if r >= 100:
        return 4.5
    return 1 + 0.035 * r + 0.000007 * r * (r - 60) * (100 - r)


def grade_for_mos(mos: Any) -> Optional[str]:
    """great >= 4.34 · good >= 4.02 · fair >= 3.60 · poor < 3.60 · None.

    Input is the STORED 2-dp MOS; any other value is first rounded half-up to
    2 dp so Python, SQL (cq_grade) and the UI always agree."""
    if mos is None:
        return None
    try:
        d = Decimal(str(mos)) if not isinstance(mos, float) else Decimal(repr(mos))
        d = d.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError, TypeError):
        return None
    if d.is_nan():
        return None
    if d >= GRADE_GREAT_MIN:
        return "great"
    if d >= GRADE_GOOD_MIN:
        return "good"
    if d >= GRADE_FAIR_MIN:
        return "fair"
    return "poor"


def grade_rank(grade: Optional[str]) -> Optional[int]:
    """poor 0 < fair 1 < good 2 < great 3; None for anything else (cq_grade_rank)."""
    return _GRADE_RANK.get(grade) if grade is not None else None


def burst_ratio(lost: Any, loss_events: Any, expected: Any) -> float:
    """G.107 BurstR = mean observed burst length / mean random burst length.

        p = lost / expected;  BurstR = (lost / loss_events) * (1 - p)

    clamped to [1, 10]. 1.0 when there is no loss / no events / no expected.
    The lower clamp is deliberate: reorder can inflate loss_events and quality
    must never be overstated.
    """
    lo, ev, ex = _to_int(lost), _to_int(loss_events), _to_int(expected)
    if lo is None or ev is None or ex is None or not (lo > 0 and ev > 0 and ex > 0):
        return 1.0
    p = lo / ex
    return clamp_burst_r((lo / ev) * (1 - p))


# ---------------------------------------------------------------------------
# B.2 — rating rule
# ---------------------------------------------------------------------------

def ptime_ms(value: Any) -> int:
    """int(rtp_use_codec_ptime) if 10 <= x <= 120, else 20."""
    v = _to_int(value)
    if v is None or not (PTIME_MIN_MS <= v <= PTIME_MAX_MS):
        return DEFAULT_PTIME_MS
    return v


def leg_status(answered: bool, billable_ms: Any, in_packets: Any,
               ptime: int = DEFAULT_PTIME_MS, out_packets: Any = None) -> str:
    """Rules 1-5 + 7 of B.2 (first match wins). Rule 6 (loss input unavailable)
    is applied by the caller. Mirrors SQL cq_leg_status(bool,int,int,int,int)
    (migration 51).

    Rule 4 (inbound < NO_RTP_RATIO of expected) splits on the outbound side:
    out_packets >= ONE_WAY_MIN_OUT_RATIO of expected -> no_rtp (true one-way);
    otherwise, or out_packets None -> no_media (no audio either way).
    """
    if not answered:
        return STATUS_UNANSWERED
    if in_packets is None:
        return STATUS_NO_DATA
    bms = 0 if billable_ms is None else billable_ms
    if bms < MIN_TALK_MS:
        return STATUS_SHORT
    if in_packets < NO_RTP_RATIO * float(bms) / ptime:
        if out_packets is not None and out_packets >= ONE_WAY_MIN_OUT_RATIO * float(bms) / ptime:
            return STATUS_NO_RTP
        return STATUS_NO_MEDIA
    if in_packets < MIN_PACKETS:
        return STATUS_LOW_SAMPLE
    return STATUS_RATED


def inbound_media_ratio(in_packets: Optional[int], billable_ms: Optional[int],
                        ptime: int = DEFAULT_PTIME_MS) -> Optional[float]:
    """min(in_packets / (billable_ms / ptime), 999.999), 3 dp, exact decimal."""
    if in_packets is None or not billable_ms or billable_ms <= 0 or ptime <= 0:
        return None
    ratio = Decimal(int(in_packets)) * Decimal(int(ptime)) / Decimal(int(billable_ms))
    ratio = min(ratio.quantize(Decimal("0.001"), rounding=ROUND_HALF_UP),
                Decimal("999.999"))
    return float(ratio)


# ---------------------------------------------------------------------------
# B.3 — one leg's full quality column set
# ---------------------------------------------------------------------------

#: The quality keys assess_leg() returns (every B.3 column except call_*,
#: flaw_total / packet_total_count / raw byte+packet counters / FS rates,
#: which the ingest writes unchanged).
LEG_QUALITY_KEYS: tuple[str, ...] = (
    "mos", "r_factor", "packet_loss_pct", "packet_loss_count",
    "jitter_avg_ms", "jitter_max_ms", "jitter_min_ms", "quality_pct",
    "quality_status", "quality_grade", "quality_source",
    "fs_mos", "fs_quality_pct", "fs_jitter_max_std_ms",
    "rtp_audio_in_skip_packet_count",
    "packets_expected", "loss_bursts", "packets_reordered", "ssrc_changes",
    "burst_ratio", "inbound_media_ratio",
)


def _fs_jitter_max_std_ms(variables: Mapping[str, Any]) -> Optional[float]:
    var = _to_float(variables.get("rtp_audio_in_jitter_max_variance"))
    if var is None or var < 0:
        return None
    return _clamped(math.sqrt(var), 0.0, _NUMERIC_8_3_MAX, 3)


def detect_source(variables: Mapping[str, Any]) -> str:
    """fs_patch_v1 iff rtp_audio_in_qpatch == "1" AND the seq vars the model
    needs (seq_expected, seq_lost) parse as non-negative ints; else fs_legacy.
    (qpatch present but seq vars missing/garbage -> legacy, per G.1.)"""
    if str(variables.get("rtp_audio_in_qpatch", "")).strip() != "1":
        return SOURCE_LEGACY
    exp = _to_int(variables.get("rtp_audio_in_seq_expected"))
    lost = _to_int(variables.get("rtp_audio_in_seq_lost"))
    if exp is None or lost is None or exp < 0 or lost < 0:
        return SOURCE_LEGACY
    return SOURCE_PATCH


def legacy_loss_pct(loss_rate: Optional[float], uuid_hint: Any = None) -> Optional[float]:
    """Legacy loss % from FS `rtp_audio_in_jitter_loss_rate`.

    FS `lossrate` (burstr_calculate: lost/received) is a 0..1 FRACTION — the
    production distribution (<0.001 / <0.01 / <0.03 buckets = 0% / 1-3% / >=3%
    populations) confirms it. Guard: a value > 1 cannot be a fraction of
    received packets in normal operation; it is logged and treated as a
    PERCENT. Result clamped to [0, 100]. Mirrored by the backfill.
    """
    if loss_rate is None:
        return None
    if loss_rate > 1:
        logger.warning("call_quality: rtp_audio_in_jitter_loss_rate=%s > 1 "
                       "(uuid=%s) — expected a 0..1 fraction; treating it as a "
                       "percent", loss_rate, uuid_hint)
        pct = loss_rate
    else:
        pct = loss_rate * 100
    return min(max(pct, 0.0), 100.0)


def _legacy_loss_count(loss_rate: float, in_packets: int) -> int:
    """round(loss_rate * in_packets) as exact decimal half-up (numeric round in
    SQL). A > 1 rate is a percent (see legacy_loss_pct)."""
    rate = Decimal(repr(float(loss_rate)))
    if rate > 1:
        rate = rate / 100
    n = (rate * Decimal(int(in_packets))).quantize(Decimal(1), rounding=ROUND_HALF_UP)
    return min(max(int(n), 0), _INT32_MAX)


def empty_assessment(variables: Optional[Mapping[str, Any]] = None) -> dict:
    """The contract's failure shape: every quality value NULL, status no_data,
    source still set (never NULL from the new API)."""
    out = {k: None for k in LEG_QUALITY_KEYS}
    out["quality_status"] = STATUS_NO_DATA
    try:
        out["quality_source"] = detect_source(variables or {})
    except Exception:  # noqa: BLE001 — failure path must itself never fail
        out["quality_source"] = SOURCE_LEGACY
    return out


def assess_leg(variables: Mapping[str, Any], *, answered: bool,
               billable_ms: Optional[int]) -> dict:
    """Every B.3 column for ONE leg (A or B row), from its FS variables.

    Pure and defensive: garbage inputs become NULLs, every value is clamped to
    its column bounds. Keys: LEG_QUALITY_KEYS.
    """
    v = variables or {}
    out = {k: None for k in LEG_QUALITY_KEYS}
    source = detect_source(v)
    out["quality_source"] = source

    # ---- raw / traceability (always, when present) ----------------------
    out["fs_mos"] = _clamped(_to_float(v.get("rtp_audio_in_mos")), 0.0, _NUMERIC_3_2_MAX, 2)
    out["fs_quality_pct"] = _clamped(
        _to_float(v.get("rtp_audio_in_quality_percentage")), 0.0, 100.0, 2)
    out["fs_jitter_max_std_ms"] = _fs_jitter_max_std_ms(v)
    out["rtp_audio_in_skip_packet_count"] = _clamp_int(v.get("rtp_audio_in_skip_packet_count"))
    # quality_pct / jitter_min_ms: deprecated, ALWAYS NULL (already None).

    seq_expected = seq_lost = seq_events = None
    if source == SOURCE_PATCH:
        seq_expected = _clamp_int(v.get("rtp_audio_in_seq_expected"))
        seq_lost = _clamp_int(v.get("rtp_audio_in_seq_lost"))
        seq_events = _clamp_int(v.get("rtp_audio_in_seq_loss_events"))
        out["packets_expected"] = seq_expected
        out["loss_bursts"] = seq_events
        out["packets_reordered"] = _clamp_int(v.get("rtp_audio_in_seq_reordered"))
        epochs = _to_int(v.get("rtp_audio_in_seq_epochs"))
        if epochs is not None:
            out["ssrc_changes"] = min(max(epochs - 1, 0), _SMALLINT_MAX)

    # ---- rating rule -----------------------------------------------------
    in_packets = _clamp_int(v.get("rtp_audio_in_packet_count"))
    out_packets = _clamp_int(v.get("rtp_audio_out_packet_count"))
    pt = ptime_ms(v.get("rtp_use_codec_ptime"))
    bms = billable_ms if billable_ms is not None else 0
    status = leg_status(bool(answered), bms, in_packets, pt, out_packets)

    loss_rate = None
    if source == SOURCE_LEGACY:
        # Same clamp/rounding the ingest applies to the stored column, so a
        # recompute from the STORED value reproduces this exact number.
        loss_rate = _clamped(_to_float(v.get("rtp_audio_in_jitter_loss_rate")),
                             0.0, _NUMERIC_8_4_MAX, 4)
    if status == STATUS_RATED:
        if source == SOURCE_PATCH and not seq_expected:
            status = STATUS_NO_DATA           # rule 6 (patched)
        elif source == SOURCE_LEGACY and loss_rate is None:
            status = STATUS_NO_DATA           # rule 6 (legacy)

    out["quality_status"] = status
    if status in MEDIA_RATIO_STATUSES:
        out["inbound_media_ratio"] = inbound_media_ratio(in_packets, bms, pt)

    if status == STATUS_NO_RTP:
        out["quality_grade"] = "poor"          # one-way audio; MOS stays NULL
        return out
    # no_media (and every other non-rated status): not graded, MOS NULL.
    if status != STATUS_RATED:
        return out

    # ---- rated: loss, BurstR, R, MOS, grade, jitter ----------------------
    if source == SOURCE_PATCH:
        loss_pct = min(max(100.0 * seq_lost / seq_expected, 0.0), 100.0)
        loss_count = seq_lost
        burst = burst_ratio(seq_lost, seq_events, seq_expected)
        out["jitter_avg_ms"] = _clamped(
            _to_float(v.get("rtp_audio_in_rfc3550_jitter_avg_ms")), 0.0, _NUMERIC_8_3_MAX, 3)
        out["jitter_max_ms"] = _clamped(
            _to_float(v.get("rtp_audio_in_rfc3550_jitter_max_ms")), 0.0, _NUMERIC_8_3_MAX, 3)
    else:
        loss_pct = legacy_loss_pct(loss_rate, v.get("uuid"))
        loss_count = _legacy_loss_count(loss_rate, in_packets)
        burst = 1.0                            # FS burstrate is not a G.107 BurstR
        # jitter: NULL on legacy images — never fabricated.

    codec = v.get("rtp_use_codec_name") or v.get("read_codec")
    ie, bpl = codec_params(codec)
    r = r_factor(loss_pct, burst, ie, bpl)
    mos = round_half_up(mos_from_r(r), 2)
    out["r_factor"] = round_half_up(r, 2)
    out["mos"] = mos
    out["quality_grade"] = grade_for_mos(mos)
    out["packet_loss_pct"] = _clamped(loss_pct, 0.0, 100.0, 2)
    out["packet_loss_count"] = loss_count
    out["burst_ratio"] = round_half_up(burst, 3)
    return out


# ---------------------------------------------------------------------------
# C — call quality = the worse direction (Python mirror of the SQL
# cdr_refresh_call_quality(); the SQL function is what production runs).
# ---------------------------------------------------------------------------

def combine_call(a: Mapping[str, Any], b: Optional[Mapping[str, Any]] = None) -> dict:
    """Combine the A row (caller->platform) and the answered carrier B row
    (callee->platform) into the call_* columns.

    * worse direction = lowest grade rank; tie -> no_rtp first, then lower
      MOS (NULL last), then A.
    * call_quality_status = no_rtp if either leg is no_rtp, else rated if
      either is rated, else the A status (so a no_media A with no graded B is
      no_media — not graded; no_media legs never carry a grade and never win
      the worse-direction pick).
    * call_mos = min MOS over rated legs; NULL when the status is no_rtp.
    No B row -> call quality = A quality.
    """
    legs = [("A", a)] + ([("B", b)] if b is not None else [])
    graded = [(leg, r) for leg, r in legs if r.get("quality_grade") is not None]

    def _key(item):
        leg, r = item
        mos = r.get("mos")
        return (grade_rank(r.get("quality_grade")),
                0 if r.get("quality_status") == STATUS_NO_RTP else 1,
                (0, float(mos)) if mos is not None else (1, 0.0),
                leg)

    worst = min(graded, key=_key) if graded else None
    statuses = [r.get("quality_status") for _, r in legs]
    any_no_rtp = STATUS_NO_RTP in statuses
    any_rated = STATUS_RATED in statuses
    rated_mos = [float(r["mos"]) for _, r in legs
                 if r.get("quality_status") == STATUS_RATED and r.get("mos") is not None]
    if any_no_rtp:
        status = STATUS_NO_RTP
    elif any_rated:
        status = STATUS_RATED
    else:
        status = a.get("quality_status")
    return {
        "call_quality_status": status,
        "call_quality_grade": worst[1].get("quality_grade") if worst else None,
        "call_quality_leg": worst[0] if worst else None,
        "call_mos": None if any_no_rtp else (min(rated_mos) if rated_mos else None),
    }
