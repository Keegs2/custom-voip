"""Unit tests for RTP quality extraction in routers/cdrs.py (plan §B.3 / §B.5).

`_extract_quality_metrics(variables, *, answered, billable_ms)` is a thin
caller of services/call_quality.assess_leg() plus the raw FS counters that
are written unchanged. Covers every B.3 column for patched / legacy / garbage
inputs, the deprecated columns (always None), the skip counter landing in
`rtp_audio_in_skip_packet_count` and NEVER in `packet_loss_count`, the
column-bound clamping that guarantees a bad quality metric can never overflow
a NUMERIC column and drop the whole CDR row, and the INSERT binds of the
$61..$73 tail.

Runnable WITHOUT a live DB — same sys.path + fake-db pattern as
tests/test_cdr_onnet_ingest.py.

Run:
    python3 -m pytest tests/test_cdr_quality_metrics.py -v
"""
import asyncio
import math
import pathlib
import sys

import pytest

_SRC = pathlib.Path(__file__).resolve().parents[1] / "docker" / "api" / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from db import database as db  # noqa: E402
from routers import cdrs  # noqa: E402
from services import call_quality as cq  # noqa: E402


# ---------------------------------------------------------------------------
# Fake db: capture every db.execute; the CDR INSERT is picked out by text.
# ---------------------------------------------------------------------------
class _Capture:
    def __init__(self):
        self.calls = []

    async def execute(self, sql, *params):
        self.calls.append((sql, params))
        return "INSERT 0 1"

    @property
    def params(self):
        ins = [p for s, p in self.calls if "INSERT INTO cdrs" in s]
        return ins[-1] if ins else None

    @property
    def sql(self):
        ins = [s for s, _ in self.calls if "INSERT INTO cdrs" in s]
        return ins[-1] if ins else None


@pytest.fixture
def cap(monkeypatch):
    c = _Capture()
    monkeypatch.setattr(db, "execute", c.execute)

    async def _no_refresh(sql, *args):   # refresh runs via fetch_one; no DB here
        return None
    monkeypatch.setattr(db, "fetch_one", _no_refresh)
    return c


def _base_variables(**overrides):
    v = {
        "uuid": "quality-test-1",
        "direction": "inbound",
        "product_type": "rcf",
        "destination_number": "+17744045256",
        "caller_id_number": "+15087282017",
        "start_epoch": "1700000000",
        "end_epoch": "1700000065",
        "answer_epoch": "1700000005",
        "duration": "65",
        "billsec": "60",
        "hangup_cause": "NORMAL_CLEARING",
        "customer_id": "20",
    }
    v.update(overrides)
    return v


# INSERT bind-parameter indices (0-based) — must match cdrs.py.
IDX_MOS = 18
IDX_QUALITY_PCT = 19
IDX_JITTER_MIN = 20
IDX_JITTER_MAX = 21
IDX_JITTER_AVG = 22
IDX_LOSS_COUNT = 23
IDX_TOTAL_COUNT = 24
IDX_LOSS_PCT = 25
IDX_FLAW = 26
IDX_R = 27
# migration 50 tail $61..$73
IDX_Q = {col: 60 + i for i, col in enumerate(cdrs._QUALITY_COLUMNS)}

#: 60 s answered at 20 ms -> 3000 expected packets.
TALK_MS = 60_000


def _run(body):
    return asyncio.run(cdrs._process_cdr_body(body))


def _qm(variables, answered=True, billable_ms=TALK_MS):
    return cdrs._extract_quality_metrics(variables, answered=answered,
                                         billable_ms=billable_ms)


PATCHED_CLEAN = {
    "rtp_audio_in_qpatch": "1",
    "rtp_audio_in_packet_count": "3000",
    "rtp_audio_in_seq_expected": "3000",
    "rtp_audio_in_seq_received": "3000",
    "rtp_audio_in_seq_lost": "0",
    "rtp_audio_in_seq_loss_events": "0",
    "rtp_audio_in_seq_reordered": "2",
    "rtp_audio_in_seq_epochs": "1",
    "rtp_audio_in_rfc3550_jitter_avg_ms": "1.93",
    "rtp_audio_in_rfc3550_jitter_max_ms": "4.20",
    "rtp_audio_in_rfc3550_clock": "kernel",
    "rtp_use_codec_name": "PCMU",
    "rtp_use_codec_ptime": "20",
    # raw FS values (traceability only)
    "rtp_audio_in_mos": "4.50",
    "rtp_audio_in_quality_percentage": "100.00",
    "rtp_audio_in_jitter_max_variance": "400.0",
    "rtp_audio_in_jitter_min_variance": "0.25",
    "rtp_audio_in_skip_packet_count": "37",
    "rtp_audio_in_flaw_total": "30",
}


# ---------------------------------------------------------------------------
# Every B.3 column — patched image
# ---------------------------------------------------------------------------

def test_patched_clean_call_every_column():
    qm = _qm(PATCHED_CLEAN)
    assert qm["quality_source"] == "fs_patch_v1"
    assert qm["quality_status"] == "rated"
    assert qm["quality_grade"] == "great"
    assert qm["mos"] == 4.41 and qm["r_factor"] == 93.2
    assert qm["packet_loss_pct"] == 0.0 and qm["packet_loss_count"] == 0
    assert qm["jitter_avg_ms"] == 1.93 and qm["jitter_max_ms"] == 4.2
    assert qm["jitter_min_ms"] is None and qm["quality_pct"] is None
    assert qm["burst_ratio"] == 1.0
    assert qm["inbound_media_ratio"] == 1.0
    assert qm["packets_expected"] == 3000
    assert qm["loss_bursts"] == 0
    assert qm["packets_reordered"] == 2
    assert qm["ssrc_changes"] == 0
    # traceability
    assert qm["fs_mos"] == 4.5 and qm["fs_quality_pct"] == 100.0
    assert qm["fs_jitter_max_std_ms"] == 20.0
    assert qm["rtp_audio_in_skip_packet_count"] == 37
    # raw FS counters unchanged
    assert qm["flaw_total"] == 30
    assert qm["rtp_audio_in_packet_count"] == 3000


def test_patched_loss_is_seq_lost_over_expected_not_flaws():
    """flaw_total=30 must NOT drive loss; seq_lost=10 / seq_expected=1000 = 1.00%."""
    v = dict(PATCHED_CLEAN, rtp_audio_in_packet_count="990",
             rtp_audio_in_seq_expected="1000", rtp_audio_in_seq_lost="10",
             rtp_audio_in_seq_loss_events="10", rtp_audio_in_flaw_total="30")
    qm = _qm(v, billable_ms=20_000)
    assert qm["quality_status"] == "rated"
    assert qm["packet_loss_pct"] == 1.0
    assert qm["packet_loss_count"] == 10
    assert qm["flaw_total"] == 30
    assert qm["mos"] == 4.33 and qm["quality_grade"] == "good"


def test_patched_ssrc_changes_and_burst_ratio():
    v = dict(PATCHED_CLEAN, rtp_audio_in_seq_expected="3000", rtp_audio_in_seq_lost="90",
             rtp_audio_in_seq_loss_events="10", rtp_audio_in_seq_epochs="3")
    qm = _qm(v)
    assert qm["ssrc_changes"] == 2
    # (90/10) * (1 - 0.03) = 8.73
    assert qm["burst_ratio"] == 8.73
    # bursty 3% scores worse than random 3% (4.13)
    assert qm["mos"] < 4.13


def test_patched_but_no_rtp_ever_is_no_rtp_with_zero_expected():
    v = dict(PATCHED_CLEAN, rtp_audio_in_packet_count="0", rtp_audio_in_seq_expected="0",
             rtp_audio_in_seq_received="0", rtp_audio_in_seq_lost="0",
             rtp_audio_in_seq_epochs="0", rtp_audio_out_packet_count="750")
    qm = _qm(v, billable_ms=15_000)
    assert qm["quality_status"] == "no_rtp" and qm["quality_grade"] == "poor"
    assert qm["mos"] is None and qm["r_factor"] is None
    assert qm["packets_expected"] == 0          # "measured zero", not NULL
    assert qm["inbound_media_ratio"] == 0.0


def test_patched_no_media_either_way_is_not_graded():
    """Migration 51: nothing received AND nothing sent -> no_media, not one-way."""
    v = dict(PATCHED_CLEAN, rtp_audio_in_packet_count="0", rtp_audio_in_seq_expected="0",
             rtp_audio_in_seq_received="0", rtp_audio_in_seq_lost="0",
             rtp_audio_in_seq_epochs="0", rtp_audio_out_packet_count="0")
    qm = _qm(v, billable_ms=15_000)
    assert qm["quality_status"] == "no_media" and qm["quality_grade"] is None
    assert qm["mos"] is None and qm["r_factor"] is None
    assert qm["packets_expected"] == 0 and qm["inbound_media_ratio"] == 0.0


def test_patched_expected_zero_but_packets_is_no_data():
    """Rule 6 (patched): seq_expected 0 while in_packets looks rated -> no_data."""
    v = dict(PATCHED_CLEAN, rtp_audio_in_seq_expected="0", rtp_audio_in_seq_lost="0")
    qm = _qm(v)
    assert qm["quality_source"] == "fs_patch_v1"
    assert qm["quality_status"] == "no_data" and qm["mos"] is None
    assert qm["quality_grade"] is None


# ---------------------------------------------------------------------------
# Legacy image (patch variables absent)
# ---------------------------------------------------------------------------

LEGACY = {
    "rtp_audio_in_packet_count": "3000",
    "rtp_audio_in_jitter_loss_rate": "0.02",       # a FRACTION -> 2 %
    "rtp_audio_in_mos": "4.50",
    "rtp_audio_in_jitter_min_variance": "1.0",
    "rtp_audio_in_jitter_max_variance": "900.0",
    "rtp_audio_in_skip_packet_count": "900",       # autoflush discards
    "rtp_audio_in_flaw_total": "15",
    "rtp_audio_in_media_packet_count": "1000",
    "read_codec": "PCMU",
}


def test_legacy_every_column():
    qm = _qm(LEGACY)
    assert qm["quality_source"] == "fs_legacy"
    assert qm["quality_status"] == "rated"
    assert qm["packet_loss_pct"] == 2.0
    assert qm["packet_loss_count"] == 60          # round(0.02 * 3000)
    assert qm["mos"] == 4.23 and qm["r_factor"] == 86.19
    assert qm["quality_grade"] == "good"
    assert qm["burst_ratio"] == 1.0               # FS burstrate is never used
    # jitter: NULL on legacy images — never fabricated from the variance
    assert qm["jitter_avg_ms"] is None and qm["jitter_max_ms"] is None
    assert qm["jitter_min_ms"] is None and qm["quality_pct"] is None
    assert qm["fs_jitter_max_std_ms"] == 30.0     # the old peak, preserved
    # patched-only counters are NULL
    for k in ("packets_expected", "loss_bursts", "packets_reordered", "ssrc_changes"):
        assert qm[k] is None, k
    # the skip counter is NOT loss
    assert qm["rtp_audio_in_skip_packet_count"] == 900
    assert qm["packet_loss_count"] != 900
    assert qm["packet_total_count"] == 1000 and qm["flaw_total"] == 15


def test_legacy_loss_rate_absent_is_no_data():
    v = {k: val for k, val in LEGACY.items() if k != "rtp_audio_in_jitter_loss_rate"}
    qm = _qm(v)
    assert qm["quality_status"] == "no_data"
    assert qm["mos"] is None and qm["packet_loss_pct"] is None


def test_legacy_loss_rate_above_one_is_treated_as_percent(caplog):
    qm = _qm(dict(LEGACY, rtp_audio_in_jitter_loss_rate="3"))
    assert qm["packet_loss_pct"] == 3.0
    assert qm["packet_loss_count"] == 90
    assert any("treating it as a percent" in r.getMessage() for r in caplog.records)


def test_qpatch_present_but_seq_missing_falls_back_to_legacy():
    qm = _qm(dict(LEGACY, rtp_audio_in_qpatch="1"))
    assert qm["quality_source"] == "fs_legacy"
    assert qm["packet_loss_pct"] == 2.0


# ---------------------------------------------------------------------------
# Garbage / clamping
# ---------------------------------------------------------------------------

def test_garbage_inputs_become_null_not_errors():
    qm = _qm({
        "rtp_audio_in_packet_count": "lots",
        "rtp_audio_in_jitter_loss_rate": "NaN",
        "rtp_audio_in_mos": "nope",
        "rtp_audio_in_jitter_max_variance": "-5",
        "rtp_audio_in_skip_packet_count": "x",
    })
    assert qm["quality_status"] == "no_data"     # in_packets unparseable
    for k in ("mos", "r_factor", "fs_mos", "fs_jitter_max_std_ms",
              "rtp_audio_in_skip_packet_count", "rtp_jitter_loss_rate"):
        assert qm[k] is None, k


def test_numeric_bounds_clamped():
    """Every NUMERIC-bound metric is clamped so asyncpg can never overflow."""
    qm = _qm({
        "rtp_audio_in_mos": "99.9",                     # fs_mos NUMERIC(3,2)
        "rtp_audio_in_quality_percentage": "250",       # NUMERIC(5,2), 0-100
        "rtp_audio_in_mean_interval": "1e12",           # NUMERIC(8,3)
        "rtp_audio_in_jitter_burst_rate": "123456789",  # NUMERIC(8,4)
        "rtp_audio_in_jitter_loss_rate": "-3",
        "rtp_audio_in_packet_count": str(2**40),        # INTEGER
        "rtp_audio_in_jitter_max_variance": "1e30",     # NUMERIC(8,3)
    })
    assert qm["fs_mos"] == 9.99
    assert qm["fs_quality_pct"] == 100.0
    assert qm["rtp_mean_interval"] == 99999.999
    assert qm["rtp_jitter_burst_rate"] == 9999.9999
    assert qm["rtp_jitter_loss_rate"] == 0.0
    assert qm["rtp_audio_in_packet_count"] == 2**31 - 1
    assert qm["fs_jitter_max_std_ms"] == 99999.999
    assert qm["inbound_media_ratio"] == 999.999          # NUMERIC(6,3)
    assert qm["mos"] <= 4.5


def test_deprecated_columns_always_none():
    for v in (PATCHED_CLEAN, LEGACY, {}, {"rtp_audio_in_quality_percentage": "97"}):
        qm = _qm(v)
        assert qm["quality_pct"] is None and qm["jitter_min_ms"] is None


def test_ungraded_statuses_null_the_rated_only_columns():
    # unanswered call with FS mos 4.5 (production case) -> mos None
    qm = _qm(PATCHED_CLEAN, answered=False, billable_ms=0)
    assert qm["quality_status"] == "unanswered"
    assert qm["mos"] is None and qm["quality_grade"] is None
    assert qm["fs_mos"] == 4.5
    assert qm["packets_expected"] == 3000        # raw sequence counters: any status
    assert qm["inbound_media_ratio"] is None
    # short
    qm = _qm(PATCHED_CLEAN, billable_ms=900)
    assert qm["quality_status"] == "short" and qm["mos"] is None
    for k in ("r_factor", "packet_loss_pct", "packet_loss_count", "jitter_avg_ms",
              "jitter_max_ms", "burst_ratio", "inbound_media_ratio"):
        assert qm[k] is None, k


# ---------------------------------------------------------------------------
# End-to-end ingest: $19..$28 carry the honest values, $61..$73 the tail, and
# a metric failure can never drop the CDR row.
# ---------------------------------------------------------------------------

def test_ingest_binds_patched_values(cap):
    body = {"variables": _base_variables(**PATCHED_CLEAN)}
    assert _run(body)["status"] == "ok"
    p = cap.params
    assert len(p) == 73
    assert p[IDX_MOS] == 4.41 and p[IDX_R] == 93.2
    assert p[IDX_QUALITY_PCT] is None and p[IDX_JITTER_MIN] is None
    assert p[IDX_JITTER_AVG] == 1.93 and p[IDX_JITTER_MAX] == 4.2
    assert p[IDX_LOSS_PCT] == 0.0 and p[IDX_LOSS_COUNT] == 0
    assert p[IDX_FLAW] == 30
    assert p[IDX_Q["quality_status"]] == "rated"
    assert p[IDX_Q["quality_grade"]] == "great"
    assert p[IDX_Q["quality_source"]] == "fs_patch_v1"
    assert p[IDX_Q["fs_mos"]] == 4.5
    assert p[IDX_Q["rtp_audio_in_skip_packet_count"]] == 37
    assert p[IDX_Q["packets_expected"]] == 3000
    assert p[IDX_Q["ssrc_changes"]] == 0
    assert p[IDX_Q["inbound_media_ratio"]] == 1.0


def test_ingest_skip_counter_never_bound_as_loss(cap):
    body = {"variables": _base_variables(**LEGACY)}
    assert _run(body)["status"] == "ok"
    p = cap.params
    assert p[IDX_LOSS_COUNT] == 60
    assert p[IDX_Q["rtp_audio_in_skip_packet_count"]] == 900


def test_ingest_unanswered_with_fs_mos_binds_null_mos(cap):
    body = {"variables": _base_variables(answer_epoch="0", billsec="0",
                                         rtp_audio_in_mos="4.50",
                                         rtp_audio_in_packet_count="0")}
    assert _run(body)["status"] == "ok"
    p = cap.params
    assert p[IDX_MOS] is None
    assert p[IDX_Q["quality_status"]] == "unanswered"
    assert p[IDX_Q["fs_mos"]] == 4.5


def test_ingest_survives_metric_extraction_failure(cap, monkeypatch):
    """If quality extraction blows up, the CDR row is STILL inserted with
    NULL metrics and quality_status 'no_data' (never NULL)."""
    def _boom(_variables, **_kw):
        raise RuntimeError("synthetic metric failure")
    monkeypatch.setattr(cdrs, "_extract_quality_metrics", _boom)
    body = {"variables": _base_variables(rtp_audio_in_jitter_max_variance="123.0")}
    result = _run(body)
    assert result["status"] == "ok"
    p = cap.params
    assert p is not None, "INSERT was not executed"
    assert p[IDX_MOS] is None and p[IDX_JITTER_MAX] is None and p[IDX_LOSS_PCT] is None
    assert p[IDX_Q["quality_status"]] == "no_data"
    assert p[IDX_Q["quality_source"]] == "fs_legacy"
    assert all(p[IDX_Q[c]] is None for c in cdrs._QUALITY_COLUMNS
               if c not in ("quality_status", "quality_source"))
    # Billing-critical fields still intact
    assert p[0] == "quality-test-1"
    assert p[1] == 20


def test_ingest_overflow_variance_row_not_lost(cap):
    """Regression: an absurd variance must clamp (fs_jitter_max_std_ms), never
    overflow NUMERIC(8,3) and lose the ENTIRE row."""
    body = {"variables": _base_variables(
        rtp_audio_in_jitter_min_variance="150000.0",
        rtp_audio_in_jitter_max_variance="98765432.1",
    )}
    assert _run(body)["status"] == "ok"
    p = cap.params
    assert p[IDX_Q["fs_jitter_max_std_ms"]] == round(math.sqrt(98765432.1), 3)
    assert p[IDX_JITTER_MAX] is None and p[IDX_JITTER_MIN] is None


def test_variance_helper_kept_for_traceability():
    assert cdrs._variance_to_jitter_ms(400.0) == 20.0
    assert cdrs._variance_to_jitter_ms(-1) is None
    assert cdrs._variance_to_jitter_ms(None) is None


def test_compute_r_factor_mos_relabel_is_gone():
    assert not hasattr(cdrs, "_compute_r_factor")


def test_extract_keys_cover_every_quality_insert_column():
    qm = _qm(PATCHED_CLEAN)
    assert set(cdrs._QUALITY_COLUMNS) <= set(qm)
    assert set(cq.LEG_QUALITY_KEYS) <= set(qm)
