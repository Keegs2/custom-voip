"""services/call_quality.py — the E-model, rating rule and grade (plan §B.1,
§B.2, §C, §D). Pure; no DB. The SQL mirror is proven equal in
tests/test_cdr_quality_migration50.py.

Run:  python3 -m pytest tests/test_call_quality_model.py -q
"""
import math
import pathlib
import sys

import pytest

_SRC = pathlib.Path(__file__).resolve().parents[1] / "docker" / "api" / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from services import call_quality as cq  # noqa: E402


def mos2(loss, burst=1.0, ie=0.0, bpl=25.1):
    return cq.round_half_up(cq.mos_from_r(cq.r_factor(loss, burst, ie, bpl)), 2)


def r2(loss, burst=1.0, ie=0.0, bpl=25.1):
    return cq.round_half_up(cq.r_factor(loss, burst, ie, bpl), 2)


# ---------------------------------------------------------------------------
# B.1 reference points (exact 2 dp, BurstR = 1, G.711 + PLC)
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("loss,r,mos", [
    (0, 93.20, 4.41), (0.5, 91.34, 4.37), (1, 89.56, 4.33), (2, 86.19, 4.23),
    (3, 83.06, 4.13), (5, 77.42, 3.92), (8, 70.24, 3.61), (10, 66.13, 3.41),
    (20, 51.07, 2.63),
])
def test_reference_table(loss, r, mos):
    assert r2(loss) == r
    assert mos2(loss) == mos


def test_constants_are_the_contract():
    assert (cq.R0, cq.ID, cq.A) == (93.2, 0.0, 0)
    assert cq.CODEC_PARAMS == {"PCMU": (0.0, 25.1), "PCMA": (0.0, 25.1), "G729": (11.0, 19.0)}
    assert cq.DEFAULT_CODEC == (0.0, 25.1)
    assert (cq.BURST_R_MIN, cq.BURST_R_MAX) == (1.0, 10.0)
    assert (cq.MIN_TALK_MS, cq.MIN_PACKETS, cq.NO_RTP_RATIO) == (5000, 250, 0.10)


def test_clean_g711_ceiling_is_4_41_not_4_50():
    assert mos2(0) == 4.41
    assert cq.grade_for_mos(mos2(0)) == "great"


def test_mos_monotone_non_increasing_in_loss():
    prev = math.inf
    prev_raw = math.inf
    for i in range(0, 10001):              # 0..100 step 0.01
        loss = i / 100
        raw = cq.mos_from_r(cq.r_factor(loss, 1.0))
        rounded = cq.round_half_up(raw, 2)
        assert raw <= prev_raw + 1e-12, loss
        assert rounded <= prev, loss
        prev, prev_raw = rounded, raw


@pytest.mark.parametrize("loss", [0.5, 1, 3, 8, 20])
def test_mos_monotone_non_increasing_in_burst(loss):
    prev = math.inf
    for i in range(0, 91):                 # BurstR 1.0 .. 10.0
        b = 1 + i / 10
        m = cq.mos_from_r(cq.r_factor(loss, b))
        assert m <= prev + 1e-12, (loss, b)
        prev = m
    # bursty loss is worse than random loss at the same mean loss
    assert cq.mos_from_r(cq.r_factor(loss, 5)) < cq.mos_from_r(cq.r_factor(loss, 1))


def test_clamps_negative_over_100_nan_none():
    assert cq.r_factor(None) is None and cq.mos_from_r(None) is None
    assert cq.r_factor(float("nan")) is None
    assert cq.r_factor("garbage") is None
    assert cq.r_factor(-5) == cq.r_factor(0)
    assert cq.r_factor(250) == cq.r_factor(100)
    # BurstR: None/NaN -> 1, below 1 -> 1, above 10 -> 10
    assert cq.r_factor(3, None) == cq.r_factor(3, 1.0)
    assert cq.r_factor(3, float("nan")) == cq.r_factor(3, 1.0)
    assert cq.r_factor(3, 0.2) == cq.r_factor(3, 1.0)
    assert cq.r_factor(3, 99) == cq.r_factor(3, 10)
    # R and MOS boundaries
    assert cq.mos_from_r(0) == 1.0 and cq.mos_from_r(-3) == 1.0
    assert cq.mos_from_r(100) == 4.5 and cq.mos_from_r(120) == 4.5
    assert 0.0 <= cq.r_factor(100, 10, 11.0, 19.0) <= 100.0
    assert cq.round_half_up(None) is None
    assert cq.round_half_up(float("inf")) is None


def test_codec_params():
    assert cq.codec_params("pcmu") == (0.0, 25.1)
    assert cq.codec_params("PCMA") == (0.0, 25.1)
    assert cq.codec_params("G729") == (11.0, 19.0)
    assert cq.codec_params("OPUS") == cq.DEFAULT_CODEC
    assert cq.codec_params(None) == cq.DEFAULT_CODEC
    # G.729 at zero loss: 93.2 - 11 = 82.2 -> MOS 4.10 (good, not great)
    assert r2(0, 1, 11.0, 19.0) == 82.2
    assert mos2(0, 1, 11.0, 19.0) == 4.10


def test_codec_key_prefers_rtp_use_codec_name():
    v = {"rtp_use_codec_name": "G729", "read_codec": "PCMU",
         "rtp_audio_in_packet_count": "3000", "rtp_audio_in_jitter_loss_rate": "0"}
    qm = cq.assess_leg(v, answered=True, billable_ms=60_000)
    assert qm["mos"] == 4.10
    v.pop("rtp_use_codec_name")
    assert cq.assess_leg(v, answered=True, billable_ms=60_000)["mos"] == 4.41


# ---------------------------------------------------------------------------
# D — the one grade definition
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("mos,grade", [
    (4.50, "great"), (4.41, "great"), (4.34, "great"), (4.33, "good"),
    (4.02, "good"), (4.01, "fair"), (3.60, "fair"), (3.59, "poor"),
    (1.00, "poor"), (None, None),
])
def test_grade_boundaries(mos, grade):
    assert cq.grade_for_mos(mos) == grade


def test_grade_cut_points_are_r_90_80_70():
    assert cq.round_half_up(cq.mos_from_r(90), 2) == 4.34
    assert cq.round_half_up(cq.mos_from_r(80), 2) == 4.02
    assert cq.round_half_up(cq.mos_from_r(70), 2) == 3.60


def test_grade_is_applied_to_the_2dp_value():
    # 4.335 -> stored 4.34 -> great ; 4.3349 -> 4.33 -> good
    assert cq.grade_for_mos(4.335) == "great"
    assert cq.grade_for_mos(4.3349) == "good"
    from decimal import Decimal
    assert cq.grade_for_mos(Decimal("3.60")) == "fair"


def test_grade_rank():
    assert [cq.grade_rank(g) for g in ("poor", "fair", "good", "great")] == [0, 1, 2, 3]
    assert cq.grade_rank(None) is None and cq.grade_rank("x") is None


# ---------------------------------------------------------------------------
# BurstR
# ---------------------------------------------------------------------------
def test_burst_ratio_formula_and_clamp():
    # 30 lost in 10 gaps out of 1000 -> (30/10) * (1 - 0.03) = 2.91
    assert cq.round_half_up(cq.burst_ratio(30, 10, 1000), 3) == 2.91
    # every loss its own gap -> (1)*(1-p) < 1 -> clamped UP to 1 (never overstate)
    assert cq.burst_ratio(10, 10, 1000) == 1.0
    # huge bursts clamp at 10
    assert cq.burst_ratio(500, 2, 1000) == 10.0
    for args in ((0, 0, 1000), (5, 0, 1000), (5, 1, 0), (None, 1, 10), ("x", 1, 10)):
        assert cq.burst_ratio(*args) == 1.0


# ---------------------------------------------------------------------------
# B.2 — rating rule
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("answered,bms,pkts,ptime,status", [
    (False, 0, 0, 20, "unanswered"),
    (False, 60_000, 3000, 20, "unanswered"),
    (True, 60_000, None, 20, "no_data"),
    (True, 0, 0, 20, "short"),                 # 0 s answered-then-hung-up
    (True, 1_000, 50, 20, "short"),            # 1 s
    (True, 4_999, 250, 20, "short"),
    (True, 11_000, 0, 20, "no_rtp"),           # the 11 s Sinch one-way call
    (True, 60_000, 299, 20, "no_rtp"),         # < 10% of 3000
    (True, 60_000, 300, 20, "rated"),          # exactly 10% -> not no_rtp
    (True, 5_000, 25, 20, "low_sample"),       # 10% of 250 = 25 -> not no_rtp
    (True, 5_000, 249, 20, "low_sample"),
    (True, 5_000, 250, 20, "rated"),
    (True, 60_000, 1500, 40, "rated"),
])
def test_leg_status_table(answered, bms, pkts, ptime, status):
    assert cq.leg_status(answered, bms, pkts, ptime) == status


def test_ptime_parsing():
    assert cq.ptime_ms("20") == 20 and cq.ptime_ms("30") == 30
    assert cq.ptime_ms("10") == 10 and cq.ptime_ms("120") == 120
    for bad in ("9", "121", "0", None, "abc", "-20"):
        assert cq.ptime_ms(bad) == 20


def _legacy(pkts, loss_rate="0", **kw):
    v = {"rtp_audio_in_packet_count": str(pkts), "rtp_audio_in_jitter_loss_rate": loss_rate,
         "rtp_audio_in_mos": "4.50"}
    v.update(kw)
    return v


def test_production_case_short_answered_calls():
    for bms in (0, 400, 1000):
        qm = cq.assess_leg(_legacy(20), answered=True, billable_ms=bms)
        assert qm["quality_status"] == "short"
        assert qm["mos"] is None and qm["quality_grade"] is None
        assert qm["fs_mos"] == 4.5


def test_production_case_11s_one_way_sinch_call():
    """11 s answered, 591 packets SENT / 0 RECEIVED -> no_rtp, poor, MOS NULL."""
    v = _legacy(0, rtp_audio_out_packet_count="591")
    qm = cq.assess_leg(v, answered=True, billable_ms=11_000)
    assert qm["quality_status"] == "no_rtp"
    assert qm["quality_grade"] == "poor"
    assert qm["mos"] is None and qm["r_factor"] is None
    assert qm["fs_mos"] == 4.5              # FS scored silence 4.50 — traceability only
    assert qm["inbound_media_ratio"] == 0.0


def test_production_case_unanswered_with_fs_mos():
    qm = cq.assess_leg(_legacy(0), answered=False, billable_ms=0)
    assert qm["quality_status"] == "unanswered"
    assert qm["mos"] is None and qm["quality_grade"] is None and qm["fs_mos"] == 4.5


def test_production_case_clean_3000_packet_call():
    qm = cq.assess_leg(_legacy(3000), answered=True, billable_ms=60_000)
    assert qm["quality_status"] == "rated"
    assert qm["mos"] == 4.41 and qm["quality_grade"] == "great"
    assert qm["packet_loss_pct"] == 0.0 and qm["packet_loss_count"] == 0


def test_production_case_3pct_random_loss():
    """3% random loss -> MOS 4.13 = GOOD under the contract model (G.711+PLC,
    Bpl 25.1; D: good <= 4.05% loss, fair <= 8.11%, poor > 8.11%). Burstiness
    lowers the MOS but, with Bpl 25.1, 3% can never leave 'good'
    (Ie_eff -> 95*3/25.1 = 11.35 as BurstR -> inf, R >= 81.85). Fair needs
    > 4.05% random loss, poor > 8.11%."""
    qm = cq.assess_leg(_legacy(3000, "0.03"), answered=True, billable_ms=60_000)
    assert qm["packet_loss_pct"] == 3.0 and qm["mos"] == 4.13
    assert qm["quality_grade"] == "good"
    patched = {"rtp_audio_in_qpatch": "1", "rtp_audio_in_packet_count": "2910",
               "rtp_audio_in_seq_expected": "3000", "rtp_audio_in_seq_lost": "90",
               "rtp_audio_in_seq_loss_events": "15"}   # mean burst 6 -> BurstR 5.82
    qb = cq.assess_leg(patched, answered=True, billable_ms=60_000)
    assert qb["packet_loss_pct"] == 3.0 and qb["burst_ratio"] == 5.82
    assert qb["mos"] < qm["mos"] and qb["quality_grade"] == "good"
    # the fair / poor bands per the model
    assert cq.grade_for_mos(mos2(5)) == "fair"         # 3.92
    assert cq.grade_for_mos(mos2(8)) == "fair"         # 3.61
    assert cq.grade_for_mos(mos2(8.2)) == "poor"
    assert cq.grade_for_mos(mos2(7)) == "fair"         # random 7%
    assert cq.grade_for_mos(mos2(7, 10)) == "poor"     # bursty 7% -> poor


def test_status_rule_table_via_assess_leg():
    assert cq.assess_leg({}, answered=True, billable_ms=60_000)["quality_status"] == "no_data"
    assert cq.assess_leg(_legacy(200), answered=True, billable_ms=5_000)["quality_status"] == "low_sample"
    low = cq.assess_leg(_legacy(200), answered=True, billable_ms=5_000)
    assert low["mos"] is None and low["inbound_media_ratio"] == 0.8


# ---------------------------------------------------------------------------
# Source selection + loss derivation
# ---------------------------------------------------------------------------
def test_source_selection():
    assert cq.detect_source({}) == "fs_legacy"
    assert cq.detect_source({"rtp_audio_in_qpatch": "1"}) == "fs_legacy"     # seq missing
    assert cq.detect_source({"rtp_audio_in_qpatch": "1", "rtp_audio_in_seq_expected": "10"}) == "fs_legacy"
    assert cq.detect_source({"rtp_audio_in_qpatch": "1", "rtp_audio_in_seq_expected": "x",
                             "rtp_audio_in_seq_lost": "0"}) == "fs_legacy"
    assert cq.detect_source({"rtp_audio_in_qpatch": "1", "rtp_audio_in_seq_expected": "10",
                             "rtp_audio_in_seq_lost": "0"}) == "fs_patch_v1"
    assert cq.detect_source({"rtp_audio_in_qpatch": "0", "rtp_audio_in_seq_expected": "10",
                             "rtp_audio_in_seq_lost": "0"}) == "fs_legacy"


def test_patched_loss_is_lost_over_expected_not_flaws_over_packets():
    v = {"rtp_audio_in_qpatch": "1", "rtp_audio_in_packet_count": "990",
         "rtp_audio_in_seq_expected": "1000", "rtp_audio_in_seq_lost": "10",
         "rtp_audio_in_seq_loss_events": "10", "rtp_audio_in_flaw_total": "30"}
    qm = cq.assess_leg(v, answered=True, billable_ms=20_000)
    assert qm["packet_loss_pct"] == 1.00       # NOT 30/990 = 3.03
    assert qm["packet_loss_count"] == 10


def test_legacy_loss_rate_is_a_fraction_with_percent_guard():
    assert cq.legacy_loss_pct(0.0) == 0.0
    assert cq.legacy_loss_pct(0.0125) == 1.25
    assert cq.legacy_loss_pct(1.0) == 100.0
    assert cq.legacy_loss_pct(2.5) == 2.5       # > 1 -> treated as percent
    assert cq.legacy_loss_pct(250) == 100.0
    assert cq.legacy_loss_pct(None) is None


def test_empty_assessment_shape():
    e = cq.empty_assessment({"rtp_audio_in_qpatch": "1", "rtp_audio_in_seq_expected": "1",
                             "rtp_audio_in_seq_lost": "0"})
    assert e["quality_status"] == "no_data" and e["quality_source"] == "fs_patch_v1"
    assert all(e[k] is None for k in cq.LEG_QUALITY_KEYS
               if k not in ("quality_status", "quality_source"))
    assert cq.empty_assessment(None)["quality_source"] == "fs_legacy"


# ---------------------------------------------------------------------------
# C — worse direction (Python mirror of cdr_refresh_call_quality)
# ---------------------------------------------------------------------------
def _leg(status, grade=None, mos=None):
    return {"quality_status": status, "quality_grade": grade, "mos": mos}


def test_combine_a_only():
    c = cq.combine_call(_leg("rated", "great", 4.41))
    assert c == {"call_quality_status": "rated", "call_quality_grade": "great",
                 "call_quality_leg": "A", "call_mos": 4.41}
    c = cq.combine_call(_leg("short"))
    assert c == {"call_quality_status": "short", "call_quality_grade": None,
                 "call_quality_leg": None, "call_mos": None}


def test_combine_b_loss_makes_call_worse_either_order():
    a, b = _leg("rated", "great", 4.41), _leg("rated", "fair", 3.92)
    c = cq.combine_call(a, b)
    assert (c["call_quality_grade"], c["call_quality_leg"], c["call_mos"]) == ("fair", "B", 3.92)


def test_combine_no_rtp_wins_and_nulls_call_mos():
    c = cq.combine_call(_leg("rated", "great", 4.41), _leg("no_rtp", "poor"))
    assert c == {"call_quality_status": "no_rtp", "call_quality_grade": "poor",
                 "call_quality_leg": "B", "call_mos": None}
    # tie on 'poor': no_rtp beats a rated poor leg
    c = cq.combine_call(_leg("rated", "poor", 3.10), _leg("no_rtp", "poor"))
    assert c["call_quality_leg"] == "B" and c["call_mos"] is None


def test_combine_tie_lower_mos_then_a():
    c = cq.combine_call(_leg("rated", "good", 4.20), _leg("rated", "good", 4.10))
    assert c["call_quality_leg"] == "B" and c["call_mos"] == 4.10
    c = cq.combine_call(_leg("rated", "good", 4.10), _leg("rated", "good", 4.10))
    assert c["call_quality_leg"] == "A"


def test_combine_ungraded_a_rated_b():
    c = cq.combine_call(_leg("low_sample"), _leg("rated", "good", 4.2))
    assert c == {"call_quality_status": "rated", "call_quality_grade": "good",
                 "call_quality_leg": "B", "call_mos": 4.2}
