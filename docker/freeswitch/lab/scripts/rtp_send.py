#!/usr/bin/env python3
"""Deterministic PCMU RTP sender for the call-quality acceptance lab (plan G.3).

Launched by the SIPp scenarios (<exec command=...>) inside the sipp-uac /
sipp-uas containers, AFTER the call is answered, towards the FS RTP address
taken from the SDP answer (UAC) or offer (UAS).

Why not SIPp's own rtp_stream: the matrix needs RFC 2833 events in the SAME
sequence/SSRC space as the audio (check #10), a mid-call SSRC switch (#11), a
"no RTP" variant (#7) and an exact per-call ground-truth manifest (packets
sent, seq range, SSRCs) — none of which SIPp's rtp_stream exposes. SIPp still
does all SIP signalling.

Source port: bound in 32768-49151 so run_matrix.sh's tc u32 filter
(`match ip sport 32768 0xc000`) impairs ONLY these RTP packets, never SIP.
FS does not filter RTP by source address (read_rtp_packet), so a source port
different from the SDP m= port is fine; FS keeps sending its own RTP to the
SDP port (SIPp's media port, which just drops it).

Pacing: absolute-deadline schedule (sleep to ~0.5 ms before the deadline, then
spin), so sender-side jitter stays well under 0.1 ms and does not pollute the
RFC 3550 jitter measured by FS.

Manifest: one JSON per call in --manifest-dir: packets sent per SSRC epoch,
first/last seq, DTMF packets, start/stop time. eval_cdrs.py uses it as ground
truth for seq_expected / seq_epochs.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import socket
import struct
import sys
import time
import zlib

PT_PCMU = 0
PT_TE = 101
PTIME_MS = 20
SAMPLES = 160  # 20 ms @ 8 kHz


def ulaw_encode(sample: int) -> int:
    """G.711 mu-law encode of a signed 16-bit linear sample."""
    BIAS, CLIP = 0x84, 32635
    sign = 0x80 if sample < 0 else 0
    if sample < 0:
        sample = -sample
    sample = min(sample, CLIP) + BIAS
    exponent = 7
    mask = 0x4000
    while exponent > 0 and not (sample & mask):
        exponent -= 1
        mask >>= 1
    mantissa = (sample >> (exponent + 3)) & 0x0F
    return (~(sign | (exponent << 4) | mantissa)) & 0xFF


def tone_payloads(freq: float = 440.0, amp: int = 8000) -> list[bytes]:
    """One second of a 440 Hz tone as 50 x 20 ms PCMU payloads (periodic)."""
    out = []
    for f in range(50):
        buf = bytearray()
        for i in range(SAMPLES):
            n = f * SAMPLES + i
            buf.append(ulaw_encode(int(amp * math.sin(2 * math.pi * freq * n / 8000.0))))
        out.append(bytes(buf))
    return out


def bind_sock(host_hint: str) -> socket.socket:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    for _ in range(200):
        port = random.randrange(32768, 49150, 2)
        try:
            s.bind(("0.0.0.0", port))
            return s
        except OSError:
            continue
    raise SystemExit(f"rtp_send: no free source port in 32768-49151 (dest {host_hint})")


SPIN_S = float(os.environ.get("RTP_SEND_SPIN_MS", "1.0")) / 1000.0


def wait_until(deadline: float) -> float:
    """Sleep until SPIN_S before the deadline, then spin. Returns lateness (s)."""
    while True:
        rem = deadline - time.monotonic()
        if rem <= 0:
            return -rem
        if rem > SPIN_S + 0.0005:
            time.sleep(rem - SPIN_S)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", required=True)
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--duration", type=float, required=True, help="seconds of media to send")
    ap.add_argument("--call-id", required=True)
    ap.add_argument("--role", default="uac")
    ap.add_argument("--manifest-dir", default="/lab/out/senders")
    ap.add_argument("--seq-start", type=int, default=-1, help="-1 = random")
    ap.add_argument("--dtmf-at", type=float, default=-1, help="send RFC 2833 digits at t seconds")
    ap.add_argument("--dtmf-digits", default="1234")
    ap.add_argument("--ssrc-switch-at", type=float, default=-1, help="new SSRC+seq+ts at t seconds")
    ap.add_argument("--no-rtp", action="store_true", help="send nothing (one-way audio case)")
    args = ap.parse_args()

    rnd = random.Random(zlib.crc32(f"{args.role}:{args.call_id}".encode()))
    manifest = {"call_id": args.call_id, "role": args.role, "dest": f"{args.host}:{args.port}",
                "epochs": [], "dtmf_packets": 0, "sent": 0, "no_rtp": bool(args.no_rtp),
                "started": time.time()}
    os.makedirs(args.manifest_dir, exist_ok=True)
    mpath = os.path.join(args.manifest_dir, f"{args.role}_{args.call_id}.json".replace("/", "_"))

    if args.no_rtp:
        time.sleep(max(args.duration, 0))
        manifest["stopped"] = time.time()
        with open(mpath, "w") as fh:
            json.dump(manifest, fh)
        return 0

    sock = bind_sock(args.host)
    dest = (args.host, args.port)
    payloads = tone_payloads()

    def new_epoch(first: bool) -> dict:
        seq = (args.seq_start if (first and args.seq_start >= 0) else rnd.randrange(0, 65536)) & 0xFFFF
        ep = {"ssrc": rnd.randrange(1, 2**32), "seq0": seq, "ts0": rnd.randrange(0, 2**32),
              "sent": 0, "last_seq": None}
        manifest["epochs"].append(ep)
        return ep

    ep = new_epoch(True)
    seq = ep["seq0"]
    ts_base = ep["ts0"]                      # media ts of frame f = ts_base + f*160 (mod 2^32)
    marker = 1
    n_frames = int(args.duration * 1000 / PTIME_MS)
    dtmf_frame = int(args.dtmf_at * 1000 / PTIME_MS) if args.dtmf_at >= 0 else -1
    switch_frame = int(args.ssrc_switch_at * 1000 / PTIME_MS) if args.ssrc_switch_at >= 0 else -1
    digit_map = {c: i for i, c in enumerate("0123456789*#")}
    # Per digit: 5 event packets (100 ms, growing duration) + 3 end packets (E bit),
    # then 2 frames (40 ms) of normal audio. Every packet gets its own seq (RFC 4733).
    dtmf_plan: list[tuple[int, int, bool]] = []
    for d in args.dtmf_digits:
        ev = digit_map.get(d, 1)
        dtmf_plan += [(ev, k * SAMPLES, False) for k in range(1, 6)]
        dtmf_plan += [(ev, 5 * SAMPLES, True)] * 3
        dtmf_plan += [(-1, 0, False)] * 2

    t0 = time.monotonic() + 0.02
    dtmf_idx = -1
    event_ts = 0
    late_sum = late_max = 0.0
    for frame in range(n_frames):
        late = wait_until(t0 + frame * PTIME_MS / 1000.0)
        late_sum += late
        late_max = max(late_max, late)
        if frame == switch_frame:
            ep = new_epoch(False)
            seq = ep["seq0"]
            ts_base = (ep["ts0"] - frame * SAMPLES) & 0xFFFFFFFF
            marker = 1
        if frame == dtmf_frame:
            dtmf_idx = 0
        cur_ts = (ts_base + frame * SAMPLES) & 0xFFFFFFFF
        pkt = None
        if 0 <= dtmf_idx < len(dtmf_plan):
            ev, dur, end = dtmf_plan[dtmf_idx]
            dtmf_idx += 1
            if ev >= 0:
                m = 0
                if dur == SAMPLES and not end:   # first packet of the event
                    event_ts = cur_ts            # RFC 4733: ts = event start, constant for the event
                    m = 1
                body = struct.pack("!BBH", ev, (0x80 if end else 0) | 10, dur)
                pkt = struct.pack("!BBHII", 0x80, (m << 7) | PT_TE, seq, event_ts, ep["ssrc"]) + body
                manifest["dtmf_packets"] += 1
        if pkt is None:
            pkt = struct.pack("!BBHII", 0x80, (marker << 7) | PT_PCMU, seq, cur_ts, ep["ssrc"]) + payloads[frame % 50]
            marker = 0
        try:
            sock.sendto(pkt, dest)
        except OSError:
            pass
        ep["sent"] += 1
        ep["last_seq"] = seq
        manifest["sent"] += 1
        seq = (seq + 1) & 0xFFFF

    manifest["stopped"] = time.time()
    # Sender pacing quality: RFC 3550 J measured at FS can never be below the
    # sender's own send-time jitter. eval_cdrs.py prints these next to #1/#6.
    manifest["pace_late_us_mean"] = round(late_sum / max(n_frames, 1) * 1e6, 1)
    manifest["pace_late_us_max"] = round(late_max * 1e6, 1)
    with open(mpath, "w") as fh:
        json.dump(manifest, fh)
    return 0


if __name__ == "__main__":
    sys.exit(main())
