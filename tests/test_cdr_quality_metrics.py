"""Unit tests for RTP quality metric extraction in routers/cdrs.py.

Covers the jitter units fix (FreeSWITCH's rtp_audio_in_jitter_min/max_variance
are running inter-arrival VARIANCE in ms^2; the ingest stores sqrt(variance) =
jitter std-dev in real ms), the flaw_total-based packet_loss_pct, and the
column-bound clamping that guarantees a bad quality metric can never overflow
a NUMERIC column and drop the whole CDR row (billing loss).

Runnable WITHOUT a live DB — same sys.path + fake-db pattern as
tests/test_cdr_onnet_ingest.py.

Run:
    python3 -m pytest tests/test_cdr_quality_metrics.py -v
"""
import sys
import math
import pathlib
import asyncio

import pytest

_SRC = pathlib.Path(__file__).resolve().parents[1] / "docker" / "api" / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from db import database as db  # noqa: E402
from routers import cdrs  # noqa: E402


# ---------------------------------------------------------------------------
# Fake db.execute: capture the SQL + positional params of the CDR INSERT.
# ---------------------------------------------------------------------------
class _Capture:
    def __init__(self):
        self.sql = None
        self.params = None

    async def execute(self, sql, *params):
        self.sql = sql
        self.params = params
        return "INSERT 0 1"


@pytest.fixture
def cap(monkeypatch):
    c = _Capture()
    monkeypatch.setattr(db, "execute", c.execute)
    return c


def _base_variables(**overrides):
    v = {
        "uuid": "quality-test-1",
        "direction": "inbound",
        "product_type": "rcf",
        "destination_number": "+17744045256",
        "caller_id_number": "+15087282017",
        "start_epoch": "1700000000",
        "end_epoch": "1700000030",
        "answer_epoch": "1700000005",
        "duration": "30",
        "billsec": "25",
        "hangup_cause": "NORMAL_CLEARING",
        "customer_id": "20",
    }
    v.update(overrides)
    return v


# INSERT bind-parameter indices (0-based) — must match the column order in
# cdrs.py: $19 mos ... $23 jitter_avg_ms, $26 packet_loss_pct, $28 r_factor.
IDX_MOS = 18
IDX_QUALITY_PCT = 19
IDX_JITTER_MIN = 20
IDX_JITTER_MAX = 21
IDX_JITTER_AVG = 22
IDX_LOSS_COUNT = 23
IDX_TOTAL_COUNT = 24
IDX_LOSS_PCT = 25
IDX_FLAW = 26


def _run(body):
    return asyncio.run(cdrs._process_cdr_body(body))


# ---------------------------------------------------------------------------
# Pure-function tests: _extract_quality_metrics
# ---------------------------------------------------------------------------

def test_jitter_variance_converted_to_ms():
    """min/max variance (ms^2) -> sqrt = running jitter std-dev in ms;
    avg = sqrt((min_var+max_var)/2), the RMS mid-band estimate."""
    qm = cdrs._extract_quality_metrics({
        "rtp_audio_in_jitter_min_variance": "0.25",
        "rtp_audio_in_jitter_max_variance": "400.0",
    })
    assert qm["jitter_min_ms"] == 0.5
    assert qm["jitter_max_ms"] == 20.0
    assert qm["jitter_avg_ms"] == round(math.sqrt((0.25 + 400.0) / 2), 3)


def test_jitter_single_sided():
    """Only max present -> avg falls back to max (converted)."""
    qm = cdrs._extract_quality_metrics({
        "rtp_audio_in_jitter_max_variance": "100.0",
    })
    assert qm["jitter_min_ms"] is None
    assert qm["jitter_max_ms"] == 10.0
    assert qm["jitter_avg_ms"] == 10.0


def test_jitter_absent_or_garbage_is_none():
    qm = cdrs._extract_quality_metrics({})
    assert qm["jitter_min_ms"] is None
    assert qm["jitter_avg_ms"] is None
    qm = cdrs._extract_quality_metrics({
        "rtp_audio_in_jitter_min_variance": "not-a-number",
        "rtp_audio_in_jitter_max_variance": "-5",  # negative variance = bogus
    })
    assert qm["jitter_min_ms"] is None
    assert qm["jitter_max_ms"] is None


def test_jitter_overflow_clamped_not_dropped():
    """A variance that used to overflow NUMERIC(8,3) (>= 100000) now converts
    to a small real-ms value; even absurd values clamp at the column bound."""
    qm = cdrs._extract_quality_metrics({
        "rtp_audio_in_jitter_max_variance": "2500000.0",  # old code: row lost
    })
    assert qm["jitter_max_ms"] == round(math.sqrt(2500000.0), 3)  # 1581.139
    huge = cdrs._extract_quality_metrics({
        "rtp_audio_in_jitter_max_variance": "1e30",
    })
    assert huge["jitter_max_ms"] == 99999.999  # NUMERIC(8,3) bound


def test_packet_loss_pct_from_flaw_total():
    """packet_loss_pct = flaw_total / inbound packets * 100 — NOT the
    autoflush skip count (which stays in packet_loss_count untouched)."""
    qm = cdrs._extract_quality_metrics({
        "rtp_audio_in_flaw_total": "15",
        "rtp_audio_in_packet_count": "1500",
        "rtp_audio_in_skip_packet_count": "900",   # autoflush discards
        "rtp_audio_in_media_packet_count": "1000",
    })
    assert qm["packet_loss_pct"] == 1.0  # 15/1500, not 900/1000
    assert qm["packet_loss_count"] == 900
    assert qm["packet_total_count"] == 1000


def test_packet_loss_pct_denominator_fallback_and_clamp():
    # No rtp_audio_in_packet_count -> falls back to media packet count
    qm = cdrs._extract_quality_metrics({
        "rtp_audio_in_flaw_total": "5",
        "rtp_audio_in_media_packet_count": "500",
    })
    assert qm["packet_loss_pct"] == 1.0
    # flaw_total > packets -> clamped to 100
    qm = cdrs._extract_quality_metrics({
        "rtp_audio_in_flaw_total": "5000",
        "rtp_audio_in_packet_count": "100",
    })
    assert qm["packet_loss_pct"] == 100.0
    # No denominator at all -> NULL, never a division error
    qm = cdrs._extract_quality_metrics({"rtp_audio_in_flaw_total": "5"})
    assert qm["packet_loss_pct"] is None


def test_numeric_bounds_clamped():
    """Every NUMERIC-bound metric is clamped so asyncpg can never overflow."""
    qm = cdrs._extract_quality_metrics({
        "rtp_audio_in_mos": "99.9",                     # NUMERIC(3,2)
        "rtp_audio_in_quality_percentage": "250",       # NUMERIC(5,2), 0-100
        "rtp_audio_in_mean_interval": "1e12",           # NUMERIC(8,3)
        "rtp_audio_in_jitter_burst_rate": "123456789",  # NUMERIC(8,4)
        "rtp_audio_in_jitter_loss_rate": "-3",
        "rtp_audio_in_packet_count": str(2**40),        # INTEGER
    })
    assert qm["mos"] == 9.99
    assert qm["quality_pct"] == 100.0
    assert qm["rtp_mean_interval"] == 99999.999
    assert qm["rtp_jitter_burst_rate"] == 9999.9999
    assert qm["rtp_jitter_loss_rate"] == 0.0
    assert qm["rtp_audio_in_packet_count"] == 2**31 - 1


# ---------------------------------------------------------------------------
# End-to-end ingest: metrics bound correctly, and a metric failure can never
# drop the CDR row (always-200 contract, billing row outranks metrics).
# ---------------------------------------------------------------------------

def test_ingest_binds_converted_jitter(cap):
    body = {"variables": _base_variables(
        rtp_audio_in_jitter_min_variance="1.0",
        rtp_audio_in_jitter_max_variance="900.0",
        rtp_audio_in_flaw_total="10",
        rtp_audio_in_packet_count="1000",
    )}
    result = _run(body)
    assert result["status"] == "ok"
    p = cap.params
    assert p[IDX_JITTER_MIN] == 1.0
    assert p[IDX_JITTER_MAX] == 30.0
    assert p[IDX_JITTER_AVG] == round(math.sqrt((1.0 + 900.0) / 2), 3)
    assert p[IDX_LOSS_PCT] == 1.0
    assert p[IDX_FLAW] == 10


def test_ingest_survives_metric_extraction_failure(cap, monkeypatch):
    """If quality extraction blows up, the CDR row is STILL inserted with
    NULL metrics — a bad quality number must never cost a billing CDR."""
    def _boom(_variables):
        raise RuntimeError("synthetic metric failure")
    monkeypatch.setattr(cdrs, "_extract_quality_metrics", _boom)
    body = {"variables": _base_variables(
        rtp_audio_in_jitter_max_variance="123.0",
    )}
    result = _run(body)
    assert result["status"] == "ok"
    p = cap.params
    assert p is not None, "INSERT was not executed"
    assert p[IDX_MOS] is None
    assert p[IDX_JITTER_MAX] is None
    assert p[IDX_LOSS_PCT] is None
    # Billing-critical fields still intact
    assert p[0] == "quality-test-1"
    assert p[1] == 20


def test_ingest_overflow_variance_row_not_lost(cap):
    """Regression: variance >= 100000 used to overflow NUMERIC(8,3), raise in
    asyncpg, and lose the ENTIRE row. Now it converts/clamps and inserts."""
    body = {"variables": _base_variables(
        rtp_audio_in_jitter_min_variance="150000.0",
        rtp_audio_in_jitter_max_variance="98765432.1",
    )}
    result = _run(body)
    assert result["status"] == "ok"
    p = cap.params
    assert p[IDX_JITTER_MIN] == round(math.sqrt(150000.0), 3)
    assert p[IDX_JITTER_MAX] == round(math.sqrt(98765432.1), 3)
    assert p[IDX_JITTER_MIN] < 100000 and p[IDX_JITTER_MAX] < 100000
