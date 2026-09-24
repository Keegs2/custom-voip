#!/usr/bin/env python3
"""Evaluate the call-quality acceptance lab (docs/CALL_QUALITY_ACCURACY_PLAN.md G.3).

Reads the on-disk mod_json_cdr files written by lab-fs (one directory per
scenario, produced by run_matrix.sh), scores every leg with the SAME pure model
the API ingest uses (docker/api/src/services/call_quality.py, imported
read-only by file path), and asserts the 13 acceptance checks.

    python3 eval_cdrs.py --runs out/runs-patched --report out/runs-patched/REPORT.txt
    python3 eval_cdrs.py --runs out/runs-patched --compare out/runs-unpatched --only S01_clean,S02_loss3

Exit code 0 = every evaluated check passed; 1 = at least one FAIL; 2 = usage /
missing data. stdlib only (runs on the bare west-loadtest host).
"""
from __future__ import annotations

import argparse
import glob
import importlib.util
import json
import math
import os
import re
import statistics
import sys
from collections import Counter, defaultdict
from typing import Any, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
CQ_PATH = os.path.normpath(os.path.join(HERE, "..", "..", "api", "src", "services", "call_quality.py"))

# ---- the contract (plan A.5): variables the patch ADDS ----------------------
NEW_VARS = (
    "rtp_audio_in_qpatch", "rtp_audio_in_seq_expected", "rtp_audio_in_seq_received",
    "rtp_audio_in_seq_lost", "rtp_audio_in_seq_loss_events", "rtp_audio_in_seq_reordered",
    "rtp_audio_in_seq_epochs", "rtp_audio_in_rfc3550_jitter_avg_ms",
    "rtp_audio_in_rfc3550_jitter_max_ms", "rtp_audio_in_rfc3550_clock",
)
# pre-existing audio stats exported by set_stats() @0a54a48 (switch_core_media.c:1868-1896)
LEGACY_INT_VARS = (
    "in_raw_bytes", "in_media_bytes", "in_packet_count", "in_media_packet_count",
    "in_skip_packet_count", "in_jitter_packet_count", "in_dtmf_packet_count",
    "in_cng_packet_count", "in_flush_packet_count", "in_largest_jb_size", "in_flaw_total",
    "out_raw_bytes", "out_media_bytes", "out_packet_count", "out_media_packet_count",
    "out_skip_packet_count", "out_dtmf_packet_count", "out_cng_packet_count",
    "rtcp_packet_count", "rtcp_octet_count",
)
LEGACY_DBL_VARS = (
    "in_jitter_min_variance", "in_jitter_max_variance", "in_jitter_loss_rate",
    "in_jitter_burst_rate", "in_mean_interval", "in_quality_percentage", "in_mos",
)
LEGACY_VARS = tuple("rtp_audio_" + v for v in LEGACY_INT_VARS + LEGACY_DBL_VARS)
RE_INT = re.compile(r"^\d+$")
RE_DBL = re.compile(r"^-?(\d+\.\d{2}|nan|inf)$")
# no-behaviour-change proof: legacy values compared patched vs unpatched
COMPARE_VARS = (
    "rtp_audio_in_mos", "rtp_audio_in_flaw_total", "rtp_audio_in_quality_percentage",
    "rtp_audio_in_jitter_min_variance", "rtp_audio_in_jitter_max_variance",
    "rtp_audio_in_jitter_loss_rate", "rtp_audio_in_jitter_burst_rate",
    "rtp_audio_in_packet_count", "rtp_audio_in_media_packet_count",
    "rtp_audio_in_skip_packet_count", "rtp_audio_in_flush_packet_count",
    "rtp_audio_in_mean_interval",
)

JITTER_THEORY_MS = 2 * 5.0 / math.sqrt(math.pi)   # netem delay 30ms 5ms normal -> E|D| = 5.642 ms


def load_cq():
    if not os.path.exists(CQ_PATH):
        sys.exit(f"eval_cdrs: {CQ_PATH} not found (API agent's services/call_quality.py, plan B.1)")
    spec = importlib.util.spec_from_file_location("rcf_call_quality", CQ_PATH)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    for name in ("assess_leg", "combine_call", "grade_for_mos"):
        if not hasattr(mod, name):
            sys.exit(f"eval_cdrs: call_quality.py lacks {name}() (plan B.1/C)")
    return mod


CQ = None  # loaded in main()


# ---------------------------------------------------------------------------
# data loading
# ---------------------------------------------------------------------------
class Leg:
    def __init__(self, path: str, v: dict):
        self.path = path
        self.v = v
        self.leg = "B" if str(v.get("cdr_leg", "")).upper() == "B" else "A"
        self.uuid = v.get("uuid") or os.path.basename(path)
        self.a_uuid = v.get("lab_a_uuid") if self.leg == "B" else self.uuid
        self.answered = str(v.get("answer_epoch", "0")) not in ("", "0")
        try:
            self.billable_ms = int(float(v.get("billmsec") or 0))
        except ValueError:
            self.billable_ms = 0
        self.q = CQ.assess_leg(v, answered=self.answered, billable_ms=self.billable_ms)

    def i(self, name: str) -> Optional[int]:
        try:
            return int(self.v[name])
        except (KeyError, ValueError, TypeError):
            return None

    def f(self, name: str) -> Optional[float]:
        try:
            return float(self.v[name])
        except (KeyError, ValueError, TypeError):
            return None


class Call:
    def __init__(self, a: Optional[Leg], b: Optional[Leg]):
        self.a, self.b = a, b
        self.combined = CQ.combine_call(a.q, b.q if b and b.answered else None) if a else None
        self.uac_manifest: Optional[dict] = None
        self.uas_manifest: Optional[dict] = None


def load_run(d: str) -> tuple[dict, list[Call]]:
    spec_txt = open(os.path.join(d, "spec.txt")).read().strip() if os.path.exists(os.path.join(d, "spec.txt")) else ""
    parts = spec_txt.split("|") if spec_txt else []
    spec = {"name": os.path.basename(d), "netem_target": parts[7] if len(parts) > 7 else "-",
            "netem": parts[8] if len(parts) > 8 else "", "secs": parts[6] if len(parts) > 6 else ""}
    legs = []
    for p in sorted(glob.glob(os.path.join(d, "cdr", "*.json"))):
        try:
            with open(p) as fh:
                doc = json.load(fh)
        except (OSError, ValueError) as e:
            print(f"  WARN unreadable CDR {p}: {e}")
            continue
        v = doc.get("variables") or {}
        legs.append(Leg(p, v))
    a_by = {l.uuid: l for l in legs if l.leg == "A"}
    b_by: dict[str, Leg] = {}
    for l in legs:
        if l.leg == "B" and l.a_uuid:
            prev = b_by.get(l.a_uuid)
            if prev is None or (l.answered and not prev.answered):
                b_by[l.a_uuid] = l
    calls = [Call(a, b_by.get(u)) for u, a in a_by.items()]
    for l in legs:
        if l.leg == "B" and l.a_uuid not in a_by:
            calls.append(Call(None, l))
    man = {}
    for p in glob.glob(os.path.join(d, "senders", "*.json")):
        try:
            m = json.load(open(p))
            man[(m.get("role"), m.get("call_id"))] = m
        except (OSError, ValueError):
            pass
    for c in calls:
        if c.a:
            c.uac_manifest = man.get(("uac", c.a.uuid))
        if c.b:
            c.uas_manifest = man.get(("uas", c.b.uuid))
    return spec, calls


# ---------------------------------------------------------------------------
# checks
# ---------------------------------------------------------------------------
class Report:
    def __init__(self):
        self.rows: list[tuple[str, str, str, str]] = []
        self.lines: list[str] = []

    def check(self, cid: str, desc: str, ok: Optional[bool], detail: str = "") -> None:
        st = "SKIP" if ok is None else ("PASS" if ok else "FAIL")
        self.rows.append((cid, st, desc, detail))
        self.lines.append(f"  [{st}] #{cid} {desc}" + (f"  -- {detail}" if detail else ""))

    def info(self, s: str) -> None:
        self.lines.append("  " + s)

    @property
    def failed(self) -> int:
        return sum(1 for r in self.rows if r[1] == "FAIL")


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return statistics.mean(xs) if xs else None


def _fmt(x, nd=3):
    return "None" if x is None else (f"{x:.{nd}f}" if isinstance(x, float) else str(x))


def legs_of(calls, which):
    return [getattr(c, which) for c in calls if getattr(c, which) is not None]


def binom_sigma_pp(p_pct: float, n: int) -> float:
    p = p_pct / 100.0
    return 100.0 * math.sqrt(max(p * (1 - p), 1e-12) / max(n, 1))


def common_checks(rep: Report, name: str, calls: list[Call], expect_b: bool) -> None:
    a_legs = legs_of(calls, "a")
    rep.check("0", f"{name}: CDRs present (A={len(a_legs)}, B={len(legs_of(calls, 'b'))})",
              len(a_legs) > 0 and (not expect_b or all(c.b for c in calls if c.a)))
    # #13: every pre-existing rtp_audio_in_* var present with the unchanged format (media legs)
    bad = []
    media_legs = [l for c in calls for l in (c.a, c.b) if l and l.v.get("rtp_audio_in_packet_count") is not None]
    for l in media_legs:
        for var in LEGACY_VARS:
            val = l.v.get(var)
            rx = RE_INT if var[len("rtp_audio_"):] in LEGACY_INT_VARS else RE_DBL
            if val is None or not rx.match(str(val)):
                bad.append(f"{l.leg}:{os.path.basename(l.path)}:{var}={val!r}")
        # the patch's own vars: present + typed on every media leg
        if l.v.get("rtp_audio_in_qpatch") != "1":
            bad.append(f"{l.leg}:{os.path.basename(l.path)}:rtp_audio_in_qpatch={l.v.get('rtp_audio_in_qpatch')!r}")
        for var in NEW_VARS[1:7]:
            if not RE_INT.match(str(l.v.get(var, ""))):
                bad.append(f"{l.leg}:{os.path.basename(l.path)}:{var}={l.v.get(var)!r}")
        if l.v.get("rtp_audio_in_rfc3550_clock") not in ("kernel", "read"):
            bad.append(f"{l.leg}:{os.path.basename(l.path)}:rtp_audio_in_rfc3550_clock={l.v.get('rtp_audio_in_rfc3550_clock')!r}")
    rep.check("13", f"{name}: all pre-existing rtp_audio_* vars present, formats unchanged; A.5 vars present+typed ({len(media_legs)} media legs)",
              not bad if media_legs else None, "; ".join(bad[:6]) + (f" (+{len(bad)-6} more)" if len(bad) > 6 else ""))


def summarize(rep: Report, name: str, calls: list[Call]) -> None:
    for which in ("a", "b"):
        ls = legs_of(calls, which)
        if not ls:
            continue
        st = Counter(l.q["quality_status"] for l in ls)
        src = Counter(l.q["quality_source"] for l in ls)
        clk = Counter(l.v.get("rtp_audio_in_rfc3550_clock") for l in ls)
        loss = _mean([l.q["packet_loss_pct"] for l in ls])
        mos = _mean([l.q["mos"] for l in ls])
        jit = _mean([l.q["jitter_avg_ms"] for l in ls])
        br = _mean([l.q["burst_ratio"] for l in ls])
        flaw = _mean([100.0 * l.i("rtp_audio_in_flaw_total") / l.i("rtp_audio_in_packet_count")
                      for l in ls if l.i("rtp_audio_in_flaw_total") is not None and l.i("rtp_audio_in_packet_count")])
        rep.info(f"{name} {which.upper()}-in: n={len(ls)} status={dict(st)} source={dict(src)} clock={dict(clk)} "
                 f"loss%={_fmt(loss)} mos={_fmt(mos, 2)} jitter_avg_ms={_fmt(jit)} burst_r={_fmt(br)} "
                 f"legacy_flaws/packets%={_fmt(flaw)} fs_mos={_fmt(_mean([l.q['fs_mos'] for l in ls]), 2)}")
    paces = [c.uac_manifest.get("pace_late_us_mean") for c in calls if c.uac_manifest and "pace_late_us_mean" in c.uac_manifest]
    if paces:
        rep.info(f"{name} sender pacing: mean lateness {statistics.mean(paces):.0f} us (UAC)")


def rated_a(calls):
    return [c.a for c in calls if c.a and c.a.q["quality_status"] == "rated"]


def expected_vs_manifest(rep, cid, name, calls, which="a"):
    """seq_expected must equal packets sent (all epochs) minus trailing packets lost after the last
    received one; with no impairment on this direction that is exact."""
    diffs = []
    for c in calls:
        leg = getattr(c, which)
        man = c.uac_manifest if which == "a" else c.uas_manifest
        if not leg or not man or man.get("no_rtp"):
            continue
        exp = leg.i("rtp_audio_in_seq_expected")
        diffs.append((man.get("sent"), exp))
    if not diffs:
        rep.check(cid, f"{name}: {which.upper()} seq_expected == packets sent (sender manifest)", None, "no manifests")
        return
    bad = [(s, e) for s, e in diffs if s is None or e is None or e != s]
    rep.check(cid, f"{name}: {which.upper()} seq_expected == packets sent (sender manifest, {len(diffs)} calls)",
              not bad, f"mismatches (sent,expected): {bad[:5]}" if bad else "")


def check_clean(rep, name, calls, strict_manifest=True):
    ra = legs_of(calls, "a")
    bad = []
    for l in ra:
        q = l.q
        if not (q["quality_status"] == "rated" and q["packet_loss_pct"] == 0.0 and q["mos"] == 4.41
                and q["quality_grade"] == "great" and l.i("rtp_audio_in_seq_epochs") == 1
                and l.v.get("rtp_audio_in_rfc3550_clock") == "kernel"
                and q["jitter_avg_ms"] is not None and q["jitter_avg_ms"] < 2.0):
            bad.append(f"{os.path.basename(l.path)}: st={q['quality_status']} loss={q['packet_loss_pct']} mos={q['mos']} "
                       f"grade={q['quality_grade']} epochs={l.i('rtp_audio_in_seq_epochs')} "
                       f"clock={l.v.get('rtp_audio_in_rfc3550_clock')} jit={q['jitter_avg_ms']}")
    rep.check("1", f"{name}: per call loss 0.00, MOS 4.41, great, seq_epochs=1, clock=kernel, jitter_avg<2ms ({len(ra)} A legs)",
              bool(ra) and not bad, "; ".join(bad[:3]))
    rb = [l for l in legs_of(calls, "b") if l.answered]
    badb = [os.path.basename(l.path) for l in rb if l.q["packet_loss_pct"] != 0.0 or l.q["mos"] != 4.41]
    rep.check("1b", f"{name}: B-in (unimpaired) also loss 0.00 / MOS 4.41 ({len(rb)} B legs)", bool(rb) and not badb, ", ".join(badb[:3]))
    if strict_manifest:
        expected_vs_manifest(rep, "1c", name, calls, "a")
        man = [c.uac_manifest for c in calls if c.uac_manifest]
        wrapped = [m for m in man if m["epochs"] and m["epochs"][0]["seq0"] >= 65000]
        rep.info(f"{name}: {len(wrapped)}/{len(man)} UAC streams started at seq>=65000 (65535->0 wrap exercised live)")


def check_loss(rep, name, calls, nominal):
    ra = rated_a(calls)
    if not ra:
        rep.check("2", f"{name}: rated A legs", False, "none")
        return None
    losses = [l.q["packet_loss_pct"] for l in ra]
    mean = statistics.mean(losses)
    rep.check("2", f"{name}: mean packet_loss_pct within +-0.3 pp of netem {nominal}% (n={len(ra)})",
              abs(mean - nominal) <= 0.3, f"mean={mean:.3f}")
    bad = []
    for l in ra:
        n = l.i("rtp_audio_in_seq_expected") or 0
        tol = max(1.0, 4 * binom_sigma_pp(nominal, n))
        if abs(l.q["packet_loss_pct"] - nominal) > tol:
            bad.append(f"{l.q['packet_loss_pct']:.2f} (tol {tol:.2f})")
    strict_bad = [x for x in losses if abs(x - nominal) > 1.0]
    rep.check("2p", f"{name}: per-call loss within max(1.0 pp, 4 sigma binomial) of netem", not bad,
              f"out: {bad[:5]}; plan's flat +-1.0 pp would flag {len(strict_bad)}/{len(losses)} calls "
              f"(1 sigma at n~{ra[0].i('rtp_audio_in_seq_expected')} = {binom_sigma_pp(nominal, ra[0].i('rtp_audio_in_seq_expected') or 1):.2f} pp)")
    flaw = _mean([100.0 * l.i("rtp_audio_in_flaw_total") / l.i("rtp_audio_in_packet_count") for l in ra
                  if l.i("rtp_audio_in_flaw_total") is not None and l.i("rtp_audio_in_packet_count")])
    rep.info(f"{name}: legacy flaw_total/packets = {_fmt(flaw)}% vs true {mean:.3f}% (x{(flaw / mean) if flaw and mean else float('nan'):.2f}; plan expects ~3x)")
    return mean, statistics.mean([l.q["mos"] for l in ra])


def check_mos_monotone(rep, pts):
    pts = [p for p in pts if p is not None]
    if len(pts) < 4:
        rep.check("2m", "MOS strictly decreasing across loss 1/3/5/10 %", None, "not all four loss runs present")
        return
    pts.sort()
    ok = all(pts[i][1] > pts[i + 1][1] for i in range(len(pts) - 1))
    rep.check("2m", "MOS strictly decreasing across loss 1/3/5/10 %", ok,
              ", ".join(f"{l:.2f}%->{m:.3f}" for l, m in pts))


def interp(pts, x):
    pts = sorted(p for p in pts if p is not None)
    if not pts:
        return None
    if x <= pts[0][0]:
        (x0, y0), (x1, y1) = pts[0], pts[1] if len(pts) > 1 else pts[0]
    elif x >= pts[-1][0]:
        (x0, y0), (x1, y1) = pts[-2] if len(pts) > 1 else pts[-1], pts[-1]
    else:
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            if x0 <= x <= x1:
                break
    return y0 if x1 == x0 else y0 + (y1 - y0) * (x - x0) / (x1 - x0)


def check_burst(rep, name, calls, loss_pts):
    ra = rated_a(calls)
    if not ra:
        rep.check("3", f"{name}: rated A legs", False, "none")
        return
    br = statistics.mean([l.q["burst_ratio"] for l in ra])
    rep.check("3a", f"{name}: mean burst_ratio > 1.5", br > 1.5, f"burst_ratio={br:.3f}")
    bad = [os.path.basename(l.path) for l in ra
           if (l.q["packet_loss_count"] or 0) > 0 and not (l.q["loss_bursts"] < l.q["packet_loss_count"])]
    rep.check("3b", f"{name}: loss_bursts < packet_loss_count on every lossy call", not bad, ", ".join(bad[:3]))
    # "MOS lower than #2 at equal mean loss". Asserted per call at EXACTLY equal loss: the call's
    # MOS (with its measured BurstR) vs the same model at the same loss with BurstR=1 (= what a
    # random-loss call with that loss scores; the #2 runs verify that branch empirically). The
    # empirical comparison against the #2 curve of means is reported too, but not asserted: at
    # ~2.2 % mean loss the burst penalty (~0.01 MOS with Bpl=25.1) is the same size as the
    # call-to-call spread of a 20-call GE sample, so a means-vs-means test would be a coin flip.
    # Compared on R (stored 2 dp) and MOS: R must be STRICTLY lower and the 2-dp MOS not higher.
    # (At ~2 % loss a BurstR of ~1.8 costs only ~0.25 R = ~0.006 MOS with Bpl=25.1, so the 2-dp
    # MOS can tie; R cannot.)
    bad = []
    for l in ra:
        if not l.q["packet_loss_pct"] or (l.q["burst_ratio"] or 1.0) <= 1.0:
            continue
        ie, bpl = CQ.codec_params(l.v.get("rtp_use_codec_name") or l.v.get("read_codec"))
        r_rand = CQ.r_factor(l.q["packet_loss_pct"], 1.0, ie, bpl)
        mos_rand = CQ.round_half_up(CQ.mos_from_r(r_rand), 2)
        r_rand = CQ.round_half_up(r_rand, 2)
        if not (l.q["r_factor"] < r_rand and l.q["mos"] <= mos_rand):
            bad.append(f"loss {l.q['packet_loss_pct']} R {l.q['r_factor']}/MOS {l.q['mos']} vs random R {r_rand}/MOS {mos_rand} (burst_r {l.q['burst_ratio']})")
    lossy = [l for l in ra if l.q["packet_loss_pct"] and (l.q["burst_ratio"] or 1.0) > 1.0]
    rep.check("3c", f"{name}: quality lower than random loss at equal loss (R strictly lower, MOS not higher; {len(lossy)} bursty calls)",
              bool(lossy) and not bad, "; ".join(bad[:3]))
    mean_loss = statistics.mean([l.q["packet_loss_pct"] for l in ra])
    mos = statistics.mean([l.q["mos"] for l in ra])
    ref = interp(loss_pts, mean_loss)
    rep.info(f"{name}: empirical: bursty mean loss {mean_loss:.3f}% mean MOS {mos:.3f} vs #2 random-loss curve {_fmt(ref)} (info only)")


def check_max_loss(rep, cid, name, calls, max_pct, extra=None):
    ra = rated_a(calls)
    bad = [f"{l.q['packet_loss_pct']:.2f}" for l in ra if l.q["packet_loss_pct"] > max_pct]
    rep.check(cid, f"{name}: per-call packet_loss_pct <= {max_pct}% ({len(ra)} rated A legs)", bool(ra) and not bad, ", ".join(bad[:5]))


def check_reorder(rep, name, calls):
    check_max_loss(rep, "4a", name, calls, 0.1)
    ra = rated_a(calls)
    bad = [os.path.basename(l.path) for l in ra if not (l.q["packets_reordered"] or 0) > 0]
    rep.check("4b", f"{name}: packets_reordered > 0 on every call", bool(ra) and not bad,
              f"mean reordered={_fmt(_mean([l.q['packets_reordered'] for l in ra]))}")


def check_dup(rep, name, calls):
    ra = rated_a(calls)
    bad = [f"{l.q['packet_loss_pct']}" for l in ra if l.q["packet_loss_pct"] != 0.0]
    rep.check("5", f"{name}: loss 0.00 on every call under duplicate 2%", bool(ra) and not bad, ", ".join(bad[:5]))


def check_jitter(rep, name, calls):
    ra = rated_a(calls)
    js = [l.q["jitter_avg_ms"] for l in ra if l.q["jitter_avg_ms"] is not None]
    lo, hi = 0.75 * JITTER_THEORY_MS, 1.25 * JITTER_THEORY_MS
    m = statistics.mean(js) if js else None
    rep.check("6a", f"{name}: mean jitter_avg_ms in [{lo:.2f}, {hi:.2f}] (2 sigma/sqrt(pi) = {JITTER_THEORY_MS:.2f})",
              None if m is None else lo <= m <= hi, f"mean={_fmt(m)} n={len(js)} clock={dict(Counter(l.v.get('rtp_audio_in_rfc3550_clock') for l in ra))}")
    check_max_loss(rep, "6b", name, calls, 0.2)


def check_norpt(rep, name, calls):
    bad = []
    for c in calls:
        if not c.a:
            continue
        q = c.a.q
        if not (q["quality_status"] == "no_rtp" and q["quality_grade"] == "poor" and q["mos"] is None
                and q["packets_expected"] == 0):
            bad.append(f"{os.path.basename(c.a.path)}: st={q['quality_status']} grade={q['quality_grade']} mos={q['mos']} exp={q['packets_expected']}")
        if c.combined and c.combined["call_quality_status"] != "no_rtp":
            bad.append(f"call {c.a.uuid}: call_quality_status={c.combined['call_quality_status']}")
    rep.check("7", f"{name}: A no_rtp, grade poor, mos NULL, packets_expected=0; call no_rtp", bool(calls) and not bad, "; ".join(bad[:3]))


def check_short(rep, name, calls):
    bad = []
    for l in [l for c in calls for l in (c.a, c.b) if l]:
        q = l.q
        if q["quality_status"] != "short" or any(q[k] is not None for k in ("mos", "r_factor", "packet_loss_pct", "packet_loss_count", "jitter_avg_ms", "jitter_max_ms", "quality_grade", "burst_ratio")):
            bad.append(f"{l.leg}:{os.path.basename(l.path)} st={q['quality_status']} mos={q['mos']}")
    rep.check("8", f"{name}: every leg 'short' with all quality NULL", bool(calls) and not bad, "; ".join(bad[:3]))


def check_unanswered(rep, name, calls):
    bad, fsm = [], []
    for l in [l for c in calls for l in (c.a, c.b) if l]:
        if l.q["quality_status"] != "unanswered" or l.q["mos"] is not None:
            bad.append(f"{l.leg}:{os.path.basename(l.path)} st={l.q['quality_status']} mos={l.q['mos']}")
        fsm.append(l.q["fs_mos"])
    rep.check("9", f"{name}: every leg 'unanswered', mos NULL", bool(calls) and not bad,
              "; ".join(bad[:3]) + f" fs_mos seen: {sorted(Counter(fsm).items(), key=str)}")


def check_dtmf(rep, name, calls):
    ra = legs_of(calls, "a")
    bad = [f"{os.path.basename(l.path)} loss={l.q['packet_loss_pct']} epochs={l.i('rtp_audio_in_seq_epochs')} dtmf_pkts={l.i('rtp_audio_in_dtmf_packet_count')}"
           for l in ra if not (l.q["packet_loss_pct"] == 0.0 and l.i("rtp_audio_in_seq_epochs") == 1
                               and (l.i("rtp_audio_in_dtmf_packet_count") or 0) > 0)]
    rep.check("10", f"{name}: loss 0.00, seq_epochs=1, RFC 2833 packets received (shared seq space)", bool(ra) and not bad, "; ".join(bad[:3]))
    expected_vs_manifest(rep, "10b", name, calls, "a")


def check_ssrc(rep, name, calls):
    ra = legs_of(calls, "a")
    bad = [f"{os.path.basename(l.path)} ssrc_changes={l.q['ssrc_changes']} loss={l.q['packet_loss_pct']}"
           for l in ra if not ((l.q["ssrc_changes"] or 0) >= 1 and l.q["packet_loss_pct"] is not None and l.q["packet_loss_pct"] <= 0.1)]
    rep.check("11", f"{name}: ssrc_changes >= 1 and loss <= 0.1%", bool(ra) and not bad, "; ".join(bad[:3]))
    expected_vs_manifest(rep, "11b", name, calls, "a")


def check_bloss(rep, name, calls):
    rb = [c.b for c in calls if c.b and c.b.q["quality_status"] == "rated"]
    mb = statistics.mean([l.q["packet_loss_pct"] for l in rb]) if rb else None
    rep.check("12a", f"{name}: B-leg mean loss within +-0.3 pp of 3% (callee->platform impaired)",
              None if mb is None else abs(mb - 3.0) <= 0.3, f"mean={_fmt(mb)} n={len(rb)}")
    ra = legs_of(calls, "a")
    bad = [f"{l.q['packet_loss_pct']}" for l in ra if l.q["packet_loss_pct"] != 0.0]
    rep.check("12b", f"{name}: A-leg loss 0.00 (caller->platform clean)", bool(ra) and not bad, ", ".join(bad[:5]))
    badc = [f"{c.a.uuid}: call={c.combined['call_quality_grade']}/{c.combined['call_quality_leg']} B={c.b.q['quality_grade']}"
            for c in calls if c.a and c.b and c.combined and c.combined["call_quality_grade"] != c.b.q["quality_grade"]]
    rep.check("12c", f"{name}: call grade (worse direction, combine_call mirror) == B grade", bool(calls) and not badc, "; ".join(badc[:3]))


# ---------------------------------------------------------------------------
# patched vs unpatched (no-behaviour-change proof, #13 diff)
# ---------------------------------------------------------------------------
def welch_t(x, y):
    if len(x) < 2 or len(y) < 2:
        return None
    mx, my = statistics.mean(x), statistics.mean(y)
    vx, vy = statistics.variance(x), statistics.variance(y)
    if vx == 0 and vy == 0:
        return 0.0 if mx == my else float("inf")
    return (mx - my) / math.sqrt(vx / len(x) + vy / len(y))


def sip_ladders(d: str) -> Counter:
    """Per-call sequence of SIP start lines (method / status code) from SIPp -trace_msg logs."""
    out: Counter = Counter()
    for f in glob.glob(os.path.join(d, "sipp", "*_messages.log")):
        role = os.path.basename(f).split("_")[0]
        per: dict[str, list[str]] = defaultdict(list)
        txt = open(f, errors="replace").read()
        for blk in re.split(r"\n-{10,}[^\n]*\n", txt):
            m = re.search(r"message (sent|received)[^\n]*\n\s*\n?\s*(\S[^\n]*)", blk)
            cid = re.search(r"(?im)^\s*Call-ID:\s*(\S+)", blk)
            if not m or not cid:
                continue
            first = m.group(2).strip()
            tok = first.split()[1] if first.startswith("SIP/2.0") else first.split()[0]
            per[cid.group(1)].append(("<" if m.group(1) == "received" else ">") + tok)
        for seq in per.values():
            out[(role, tuple(seq))] += 1
    return out


def compare(rep: Report, pdir: str, udir: str) -> None:
    name = os.path.basename(pdir)
    _, pc = load_run(pdir)
    _, uc = load_run(udir)
    for which in ("a", "b"):
        pl = [l for l in legs_of(pc, which) if l.answered]
        ul = [l for l in legs_of(uc, which) if l.answered]
        if not pl or not ul:
            rep.check("13d", f"{name} {which.upper()}: patched vs unpatched legs present", False, f"patched={len(pl)} unpatched={len(ul)}")
            continue
        pvars = set().union(*[{k for k in l.v if k.startswith("rtp_")} for l in pl])
        uvars = set().union(*[{k for k in l.v if k.startswith("rtp_")} for l in ul])
        added, removed = pvars - uvars, uvars - pvars
        ok = removed == set() and added <= set(NEW_VARS)
        rep.check("13d", f"{name} {which.upper()}: rtp_* var names = unpatched + exactly the A.5 set",
                  ok, f"added={sorted(added)} removed={sorted(removed)}")
        fmt_bad = []
        for var in sorted(uvars & pvars):
            def cls(s):
                s = str(s)
                return "int" if RE_INT.match(s) else ("dbl2" if RE_DBL.match(s) else ("empty" if not s else "other"))
            pf = Counter(cls(l.v.get(var)) for l in pl if var in l.v)
            uf = Counter(cls(l.v.get(var)) for l in ul if var in l.v)
            if set(pf) != set(uf):
                fmt_bad.append(f"{var}: patched {dict(pf)} vs unpatched {dict(uf)}")
        rep.check("13f", f"{name} {which.upper()}: value formats identical for every shared rtp_* var", not fmt_bad, "; ".join(fmt_bad[:4]))
        stat_bad, stat_info = [], []
        for var in COMPARE_VARS:
            x = [l.f(var) for l in pl if l.f(var) is not None and math.isfinite(l.f(var))]
            y = [l.f(var) for l in ul if l.f(var) is not None and math.isfinite(l.f(var))]
            t = welch_t(x, y)
            stat_info.append(f"{var.replace('rtp_audio_in_', '')}: {_fmt(_mean(x))} vs {_fmt(_mean(y))} t={_fmt(t, 2)}")
            if t is not None and abs(t) > 3.0:
                stat_bad.append(var)
        rep.check("13s", f"{name} {which.upper()}: legacy FS stats statistically indistinguishable (|Welch t| <= 3)",
                  not stat_bad, f"differ: {stat_bad}" if stat_bad else "")
        for s in stat_info:
            rep.info(f"    {name} {which.upper()} {s}")
    pl, ul = sip_ladders(pdir), sip_ladders(udir)
    rep.check("13l", f"{name}: SIP setup/teardown ladders identical (multiset of per-call start-line sequences)",
              (pl == ul) if (pl and ul) else None,
              "" if pl == ul else f"only patched: {list((pl - ul).items())[:2]} only unpatched: {list((ul - pl).items())[:2]}")


# ---------------------------------------------------------------------------
def main() -> int:
    global CQ
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--runs", required=True, help="runset dir (out/runs-patched)")
    ap.add_argument("--compare", help="unpatched runset dir for the no-behaviour-change proof")
    ap.add_argument("--only", help="comma list of scenario names")
    ap.add_argument("--report", help="also write the report here")
    args = ap.parse_args()
    CQ = load_cq()
    if not os.path.isdir(args.runs):
        print(f"eval_cdrs: no runset {args.runs}")
        return 2
    only = set(args.only.split(",")) if args.only else None
    rep = Report()
    rep.lines.append(f"call_quality model: {CQ_PATH}")
    dirs = sorted(d for d in glob.glob(os.path.join(args.runs, "S*")) if os.path.isdir(d))
    runs = {}
    for d in dirs:
        n = os.path.basename(d)
        if only and n not in only:
            continue
        runs[n] = load_run(d)
    loss_pts = {}
    for n in sorted(runs):
        spec, calls = runs[n]
        rep.lines.append(f"\n== {n}  netem[{spec['netem_target']}]: {spec['netem'] or 'none'}  calls={len(calls)}")
        common_checks(rep, n, calls, expect_b=not n.startswith("S09"))
        summarize(rep, n, calls)
        if n == "S01_clean":
            check_clean(rep, n, calls)
        elif n.startswith("S02_loss"):
            nominal = float(n.split("loss")[1])
            r = check_loss(rep, n, calls, nominal)
            if r:
                loss_pts[nominal] = r
        elif n == "S03_gemodel":
            pass  # evaluated after all #2 runs (needs their curve)
        elif n == "S04_reorder":
            check_reorder(rep, n, calls)
        elif n == "S05_dup":
            check_dup(rep, n, calls)
        elif n == "S06_jitter":
            check_jitter(rep, n, calls)
        elif n == "S07_norpt":
            check_norpt(rep, n, calls)
        elif n == "S08_short":
            check_short(rep, n, calls)
        elif n == "S09_cancel":
            check_unanswered(rep, n, calls)
        elif n == "S10_dtmf":
            check_dtmf(rep, n, calls)
        elif n == "S11_ssrc":
            check_ssrc(rep, n, calls)
        elif n == "S12_bloss":
            check_bloss(rep, n, calls)
    if any(n.startswith("S02_loss") for n in runs):
        rep.lines.append("\n== S02 (across loss levels)")
        check_mos_monotone(rep, [loss_pts.get(k) for k in (1.0, 3.0, 5.0, 10.0)])
    if "S03_gemodel" in runs:
        rep.lines.append("\n== S03_gemodel (bursty; compared with the S02 random-loss curve)")
        check_burst(rep, "S03_gemodel", runs["S03_gemodel"][1], list(loss_pts.values()))
    if args.compare:
        rep.lines.append(f"\n== patched ({args.runs}) vs unpatched ({args.compare})")
        for n in sorted(runs):
            ud = os.path.join(args.compare, n)
            if os.path.isdir(ud):
                compare(rep, os.path.join(args.runs, n), ud)
    npass = sum(1 for r in rep.rows if r[1] == "PASS")
    nskip = sum(1 for r in rep.rows if r[1] == "SKIP")
    rep.lines.append(f"\nRESULT: {npass} PASS, {rep.failed} FAIL, {nskip} SKIP  -> {'ACCEPT' if rep.failed == 0 and npass else 'REJECT'}")
    text = "\n".join(rep.lines)
    print(text)
    if args.report:
        with open(args.report, "w") as fh:
            fh.write(text + "\n")
    return 1 if rep.failed else 0


if __name__ == "__main__":
    sys.exit(main())
