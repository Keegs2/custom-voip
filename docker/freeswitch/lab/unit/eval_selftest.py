#!/usr/bin/env python3
"""Plumbing self-test for lab/eval_cdrs.py — runs anywhere (no Docker, no FS).

Generates a SYNTHETIC runset whose CDR variables have the exact shape the
patched FS writes (names/format per plan A.5 + the legacy set_stats() vars),
with per-scenario values drawn from the modelled impairment, then runs
eval_cdrs.py on it and expects ACCEPT; then corrupts it (a missing legacy var,
a wrong clock, a lossy "clean" call) and expects REJECT.

This proves the evaluator's parsing, pairing, model import and check logic —
NOT FreeSWITCH. Only the real lab run on west-loadtest proves FreeSWITCH.
    python3 docker/freeswitch/lab/unit/eval_selftest.py
"""
from __future__ import annotations

import json
import math
import os
import random
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
EVAL = os.path.normpath(os.path.join(HERE, "..", "eval_cdrs.py"))
rnd = random.Random(3550)

INT_VARS = ("in_raw_bytes", "in_media_bytes", "in_packet_count", "in_media_packet_count",
            "in_skip_packet_count", "in_jitter_packet_count", "in_dtmf_packet_count",
            "in_cng_packet_count", "in_flush_packet_count", "in_largest_jb_size", "in_flaw_total",
            "out_raw_bytes", "out_media_bytes", "out_packet_count", "out_media_packet_count",
            "out_skip_packet_count", "out_dtmf_packet_count", "out_cng_packet_count",
            "rtcp_packet_count", "rtcp_octet_count")
DBL_VARS = ("in_jitter_min_variance", "in_jitter_max_variance", "in_jitter_loss_rate",
            "in_jitter_burst_rate", "in_mean_interval", "in_quality_percentage", "in_mos")


def leg_vars(uuid, leg, answered, secs, sent, lost=0, events=0, reordered=0, epochs=1,
             jitter=0.8, clock="kernel", dtmf=0, a_uuid=None, media=True, out=None):
    v = {"uuid": uuid, "answer_epoch": "1790000000" if answered else "0",
         "billmsec": str(int(secs * 1000) if answered else 0), "rtp_use_codec_name": "PCMU",
         "rtp_use_codec_ptime": "20", "read_codec": "PCMU"}
    if leg == "B":
        v.update({"cdr_leg": "B", "cdr_carrier_leg": "true", "cdr_leg_attempt": "1", "lab_a_uuid": a_uuid})
    if not media:
        return v
    recv = sent - lost
    for k in INT_VARS:
        v["rtp_audio_" + k] = "0"
    for k in DBL_VARS:
        v["rtp_audio_" + k] = "0.00"
    # what FS SENT on this leg = what it relayed from the other leg (migration
    # 51 splits "no inbound RTP" on it: out >= 50% of expected -> no_rtp)
    v["rtp_audio_out_packet_count"] = str(sent if out is None else out)
    v.update({"rtp_audio_in_packet_count": str(recv), "rtp_audio_in_media_packet_count": str(recv - dtmf),
              "rtp_audio_in_dtmf_packet_count": str(dtmf), "rtp_audio_in_raw_bytes": str(recv * 172),
              "rtp_audio_in_flaw_total": str(lost * 3), "rtp_audio_in_mos": "4.50",
              "rtp_audio_in_quality_percentage": "100.00",
              "rtp_audio_in_jitter_loss_rate": f"{(lost / max(recv, 1)):.2f}"})
    exp = sent if sent else 0
    v.update({"rtp_audio_in_qpatch": "1", "rtp_audio_in_seq_expected": str(exp),
              "rtp_audio_in_seq_received": str(recv), "rtp_audio_in_seq_lost": str(lost),
              "rtp_audio_in_seq_loss_events": str(events), "rtp_audio_in_seq_reordered": str(reordered),
              "rtp_audio_in_seq_epochs": str(epochs if sent else 0), "rtp_audio_in_rfc3550_clock": clock})
    if sent > 60:
        v["rtp_audio_in_rfc3550_jitter_avg_ms"] = f"{jitter:.2f}"
        v["rtp_audio_in_rfc3550_jitter_max_ms"] = f"{jitter * 2.5:.2f}"
    return v


def bern_loss(n, p):
    lost = events = 0
    prev = False
    for _ in range(n):
        x = rnd.random() < p
        lost += x
        events += x and not prev
        prev = x
    return lost, events


def ge_loss(n, p=0.01, r=0.30, lb=0.70):
    bad = False
    lost = events = 0
    prev = False
    for _ in range(n):
        bad = (rnd.random() < p) if not bad else (rnd.random() >= r)
        x = bad and rnd.random() < lb
        lost += x
        events += x and not prev
        prev = x
    return lost, events


def write(d, name, spec, calls):
    rd = os.path.join(d, name)
    os.makedirs(os.path.join(rd, "cdr"))
    os.makedirs(os.path.join(rd, "senders"))
    with open(os.path.join(rd, "spec.txt"), "w") as fh:
        fh.write(spec + "\n")
    for i, (a, b, man) in enumerate(calls):
        json.dump({"variables": a}, open(os.path.join(rd, "cdr", f"a_{i}.cdr.json"), "w"))
        if b:
            json.dump({"variables": b}, open(os.path.join(rd, "cdr", f"b_{i}.cdr.json"), "w"))
        if man:
            json.dump(man, open(os.path.join(rd, "senders", f"uac_{a['uuid']}.json"), "w"))


def scenario(name, secs=60, a_imp=None, b_imp=None, mode="normal", answered=True, spec_netem="-|"):
    calls = []
    n = int((secs - 0.5) * 50)
    for i in range(20):
        au, bu = f"{name}-a-{i}", f"{name}-b-{i}"
        lost = events = reord = 0
        epochs, jit, dtmf, sent = 1, rnd.uniform(0.4, 1.2), 0, n
        if mode == "none":
            sent = 0
        if a_imp == "loss":
            lost, events = bern_loss(n, spec_p[name])
        elif a_imp == "ge":
            lost, events = ge_loss(n)
        elif a_imp == "reorder":
            reord = rnd.randint(60, 200)
            events = reord
        elif a_imp == "dup":
            reord = rnd.randint(40, 80)
        elif a_imp == "jitter":
            jit = rnd.gauss(5.64, 0.3)
        if mode == "dtmf":
            dtmf = 32
        if mode == "ssrc":
            epochs = 2
        a = leg_vars(au, "A", answered, secs, sent, lost, events, reord, epochs, jit, dtmf=dtmf, media=answered,
                     out=n - 50)
        blost, bev = bern_loss(n - 50, 0.03) if b_imp == "loss" else (0, 0)
        b = leg_vars(bu, "B", answered, secs, n - 50, blost, bev, a_uuid=au, media=answered)
        man = {"call_id": au, "role": "uac", "sent": sent, "no_rtp": sent == 0,
               "epochs": [{"seq0": 65200 if mode == "wrap" else 100, "sent": sent}], "pace_late_us_mean": 40.0}
        calls.append((a, b, man))
    return calls


spec_p = {"S02_loss1": 0.01, "S02_loss3": 0.03, "S02_loss5": 0.05, "S02_loss10": 0.10}


def build(d):
    write(d, "S01_clean", "S01_clean|uac_stream|uas_stream|7000|wrap|normal|60|-|", scenario("S01_clean", mode="wrap"))
    for k, p in spec_p.items():
        write(d, k, f"{k}|uac_stream|uas_stream|7000|normal|normal|60|uac|loss {int(p*100)}%", scenario(k, a_imp="loss"))
    write(d, "S03_gemodel", "S03_gemodel|x|x|7000|normal|normal|60|uac|loss gemodel 1% 30% 70% 0%", scenario("S03_gemodel", a_imp="ge"))
    write(d, "S04_reorder", "S04_reorder|x|x|7000|normal|normal|60|uac|delay 10ms reorder 5% 50%", scenario("S04_reorder", a_imp="reorder"))
    write(d, "S05_dup", "S05_dup|x|x|7000|normal|normal|60|uac|duplicate 2%", scenario("S05_dup", a_imp="dup"))
    write(d, "S06_jitter", "S06_jitter|x|x|7000|normal|normal|60|uac|delay 30ms 5ms distribution normal", scenario("S06_jitter", a_imp="jitter"))
    write(d, "S07_norpt", "S07_norpt|x|x|7000|none|normal|15|-|", scenario("S07_norpt", secs=15, mode="none"))
    write(d, "S08_short", "S08_short|x|x|7000|normal|normal|2|-|", scenario("S08_short", secs=2))
    write(d, "S09_cancel", "S09_cancel|x|x|7000|-|-|0|-|", scenario("S09_cancel", secs=0, answered=False))
    write(d, "S10_dtmf", "S10_dtmf|x|x|7000|dtmf|normal|60|-|", scenario("S10_dtmf", mode="dtmf"))
    write(d, "S11_ssrc", "S11_ssrc|x|x|7000|ssrc|normal|60|-|", scenario("S11_ssrc", mode="ssrc"))
    write(d, "S12_bloss", "S12_bloss|x|x|7000|normal|normal|60|uas|loss 3%", scenario("S12_bloss", b_imp="loss"))


def run_eval(d):
    p = subprocess.run([sys.executable, EVAL, "--runs", d], capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr


def main():
    tmp = tempfile.mkdtemp(prefix="eval_selftest_")
    try:
        good = os.path.join(tmp, "good")
        build(good)
        rc, out = run_eval(good)
        print(out[-2500:])
        assert rc == 0 and "ACCEPT" in out, f"expected ACCEPT on the synthetic good runset (rc={rc})"
        # corrupt: legacy var removed, clock 'read', loss on a clean call
        f = os.path.join(good, "S01_clean", "cdr", "a_0.cdr.json")
        doc = json.load(open(f))
        doc["variables"].pop("rtp_audio_in_flaw_total")
        doc["variables"]["rtp_audio_in_rfc3550_clock"] = "read"
        doc["variables"]["rtp_audio_in_seq_lost"] = "30"
        json.dump(doc, open(f, "w"))
        rc2, out2 = run_eval(good)
        fails = [l for l in out2.splitlines() if "[FAIL]" in l]
        print("\n".join(fails))
        assert rc2 == 1 and "REJECT" in out2 and any("#13 " in l for l in fails) and any("#1 " in l for l in fails), \
            "expected REJECT with #1 and #13 failures on the corrupted runset"
        print("eval_selftest: PASS (synthetic ACCEPT + corrupted REJECT)")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
