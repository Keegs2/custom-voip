"""West Sinch->Sinch teardown replay — SIP data-fidelity acceptance tests.

Synthetic replay of the operator-reported production call (2026-09):

    A-leg  51127909_111588655@206.146.100.24
           Sinch-Denver -> West-SBC-VIP -> West-SBC-2 -> West-FreeSWITCH
    B-leg  bd645f41-22e0-1240-11ad-4201c0a81402
           West-FreeSWITCH -> West-SBC-SigVIP -> West-SBC-2(VIP) -> Sinch-Atlanta-LD

The Grafana sip-search panel (raw rows, no dedup) showed a RICHER teardown
than the UI ladder: repeated BYE West-SBC-2 -> West-FreeSWITCH capture pairs
with their 200s, repeated BYE West-FreeSWITCH -> West-SBC-SigVIP, and the
long-span rows to/from Sinch-Atlanta-LD were not all rendered.

Fidelity contract asserted here (through the REAL pipeline functions):

  1. Every DISTINCT wire message renders exactly one row on its correct hop —
     including two distinct hops whose stored copies share the same topmost
     Via branch (a forwarding element's trace copy serialized without its own
     new Via).  Pre-fix, the branch-keyed identity merged those and the
     carrier-side hop (SBC -> Sinch-Atlanta) VANISHED because its only
     capture was absorbed into the FS -> SigVIP cluster.
  2. Per-capture duplicates (sender HEP node 110 + receiver HEP node 210 of
     ONE wire message; alias-collapsed src==dst self-captures) collapse to
     ONE row that merges the capture node ids.
  3. Retransmissions (same hop, same branch, T1-spaced) survive as their own
     rows AND display in wire-chronological order — pre-fix the causality
     DAG edged every response after EVERY same-branch request copy and
     zip-chained retransmitted copies across depths, interleaving the
     rounds (the +1 ms forwarded BYE displayed after the +500 ms
     retransmitted first-hop copy).

Runnable WITHOUT fastapi/network (same loader pattern as
tests/test_homer_pipeline.py).

Run:
    python3 -m pytest tests/test_homer_west_teardown.py -v
or
    python3 tests/test_homer_west_teardown.py
"""
import importlib.util
import pathlib
import sys
import traceback

_PIPELINE_PATH = (
    pathlib.Path(__file__).resolve().parents[1]
    / "docker" / "api" / "src" / "routers" / "homer_pipeline.py"
)
_spec = importlib.util.spec_from_file_location("homer_pipeline_west", _PIPELINE_PATH)
hp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hp)


# ---------------------------------------------------------------------------
# Fixture call constants (operator call, 2026-09, West zone)
# ---------------------------------------------------------------------------

A = "51127909_111588655@206.146.100.24"           # A-leg Call-ID (Sinch-Denver)
B = "bd645f41-22e0-1240-11ad-4201c0a81402"        # B-leg Call-ID (FS -> Atlanta)

# Via sent-by hosts (real West addresses; src/dst labels are heplify aliases)
SINCH_DEN = "206.146.100.24:5060"
WVIP = "35.252.214.40:5060"      # West external NLB VIP (SBC advertise)
FS90 = "8.229.177.165:5090"      # West FS public, external profile

# Via (branch, sent-by host) per hop
A_BYE_CARRIER = ("z9hG4bKsnch77bye01", SINCH_DEN)                    # Denver's BYE
A_BYE_SBC = ("z9hG4bK5cd1.a1f7bye.0", WVIP)                          # SBC's added Via
B_BYE_FS = ("z9hG4bKQm3vDgFXKp2Sa", FS90)                            # FS's B-leg BYE
B_BYE_SBC = ("z9hG4bK9df2.bleg0aa.0", WVIP)                          # SBC's added Via

BASE = 1_787_000_020_000_000_000     # HEP-stamped (ends in 000)
MS = 1_000_000


def _raw(method, status, vias, cseq_num, cseq_method, callid):
    if status is None:
        start = f"{method} sip:+15305480846@example.invalid SIP/2.0"
    else:
        start = f"SIP/2.0 {status} OK"
    lines = [start]
    for branch, host in vias:
        lines.append(f"Via: SIP/2.0/UDP {host};branch={branch}")
    lines.append(f"Call-ID: {callid}")
    lines.append(f"CSeq: {cseq_num} {cseq_method}")
    lines.append("Content-Length: 0")
    return "\r\n".join(lines) + "\r\n\r\n"


def _row(ts_ns, node, method, status, src, dst, callid, vias, cseq_num,
         cseq_method=None):
    cm = cseq_method or method
    return {
        "timestamp": None,
        "timestamp_ns": ts_ns,
        "from_user": "+15305480845",
        "to_user": "+15305480846",
        "callid": callid,
        "method": method,
        "cseq": f"{cseq_num} {cm}",
        "via_branch": vias[0][0],
        "src_ip": src,
        "dst_ip": dst,
        "status": status,
        "node": node,
        "raw_msg": _raw(method, status, vias, cseq_num, cm, callid),
    }


def _teardown_round(rows, t0):
    """One full teardown cascade starting at t0 (both legs, clean Via stacks).

    Internal wire messages captured TWICE (SBC node 110 + FS node 210, spread
    < 1 ms), carrier-side messages once (110 only).
    """
    r = rows.append
    # A-leg: carrier BYE -> VIP (1x)
    r(_row(t0, "110", "BYE", None, "Sinch-Denver", "West-SBC-VIP", A,
           [A_BYE_CARRIER], 103))
    # SBC BYE -> FS (2x)
    r(_row(t0 + 1 * MS, "110", "BYE", None, "West-SBC-2", "West-FreeSWITCH", A,
           [A_BYE_SBC, A_BYE_CARRIER], 103))
    r(_row(t0 + 1 * MS + 800_000, "210", "BYE", None, "West-SBC-2",
           "West-FreeSWITCH", A, [A_BYE_SBC, A_BYE_CARRIER], 103))
    # FS 200 -> SBC (2x)
    r(_row(t0 + 20 * MS, "210", "BYE", 200, "West-FreeSWITCH", "West-SBC-2", A,
           [A_BYE_SBC, A_BYE_CARRIER], 103))
    r(_row(t0 + 20 * MS + 700_000, "110", "BYE", 200, "West-FreeSWITCH",
           "West-SBC-2", A, [A_BYE_SBC, A_BYE_CARRIER], 103))
    # SBC 200 -> carrier (1x)
    r(_row(t0 + 21 * MS, "110", "BYE", 200, "West-SBC-VIP", "Sinch-Denver", A,
           [A_BYE_CARRIER], 103))
    # B-leg: FS BYE -> SigVIP (2x)
    r(_row(t0 + 30 * MS, "210", "BYE", None, "West-FreeSWITCH",
           "West-SBC-SigVIP", B, [B_BYE_FS], 79))
    r(_row(t0 + 30 * MS + 600_000, "110", "BYE", None, "West-FreeSWITCH",
           "West-SBC-SigVIP", B, [B_BYE_FS], 79))
    # SBC BYE -> Sinch-Atlanta (1x, egresses the external VIP socket)
    r(_row(t0 + 31 * MS, "110", "BYE", None, "West-SBC-VIP",
           "Sinch-Atlanta-LD", B, [B_BYE_SBC, B_BYE_FS], 79))
    # Atlanta 200 -> SBC (1x)
    r(_row(t0 + 70 * MS, "110", "BYE", 200, "Sinch-Atlanta-LD", "West-SBC-VIP",
           B, [B_BYE_SBC, B_BYE_FS], 79))
    # SBC 200 -> FS (2x)
    r(_row(t0 + 71 * MS, "110", "BYE", 200, "West-SBC-2", "West-FreeSWITCH", B,
           [B_BYE_FS], 79))
    r(_row(t0 + 71 * MS + 500_000, "210", "BYE", 200, "West-SBC-2",
           "West-FreeSWITCH", B, [B_BYE_FS], 79))


def build_clean_rows():
    """Original teardown + one T1 (500 ms) retransmission round: 24 stored
    rows = 16 distinct wire messages (8 per round)."""
    rows = []
    _teardown_round(rows, BASE)
    _teardown_round(rows, BASE + 500 * MS)
    return rows


def _hop(m):
    return (m["callid"], m["method"], m["status"], m["src_ip"], m["dst_ip"])


# Distinct wire-message inventory per round (8 hops x 2 rounds = 16 rows).
ROUND_HOPS = [
    (A, "BYE", None, "Sinch-Denver", "West-SBC-VIP"),
    (A, "BYE", None, "West-SBC-2", "West-FreeSWITCH"),
    (A, "BYE", 200, "West-FreeSWITCH", "West-SBC-2"),
    (A, "BYE", 200, "West-SBC-VIP", "Sinch-Denver"),
    (B, "BYE", None, "West-FreeSWITCH", "West-SBC-SigVIP"),
    (B, "BYE", None, "West-SBC-VIP", "Sinch-Atlanta-LD"),
    (B, "BYE", 200, "Sinch-Atlanta-LD", "West-SBC-VIP"),
    (B, "BYE", 200, "West-SBC-2", "West-FreeSWITCH"),
]


# ---------------------------------------------------------------------------
# (1) Clean replay: dedup keeps every hop, collapses per-capture pairs,
#     preserves both retransmission rounds
# ---------------------------------------------------------------------------

def test_clean_replay_full_inventory():
    data, _warnings = hp._finalize_pipeline(build_clean_rows())
    assert len(data) == 16, f"expected 16 wire messages, got {len(data)}"
    got = [_hop(m) for m in data]
    for hop in ROUND_HOPS:
        assert got.count(hop) == 2, (
            f"hop {hop} expected 2 rows (original + retransmission), "
            f"got {got.count(hop)}"
        )


def test_clean_replay_capture_pairs_merge_nodes():
    data, _warnings = hp._finalize_pipeline(build_clean_rows())
    dual_capture_hops = {
        (A, "BYE", None, "West-SBC-2", "West-FreeSWITCH"),
        (A, "BYE", 200, "West-FreeSWITCH", "West-SBC-2"),
        (B, "BYE", None, "West-FreeSWITCH", "West-SBC-SigVIP"),
        (B, "BYE", 200, "West-SBC-2", "West-FreeSWITCH"),
    }
    for m in data:
        if _hop(m) in dual_capture_hops:
            assert m["node"] == "110,210", (
                f"{_hop(m)}: capture pair not merged, node={m['node']}"
            )
        else:
            assert m["node"] == "110", f"{_hop(m)}: node={m['node']}"


def test_clean_replay_rounds_stay_chronological():
    """Retransmission rounds must NOT interleave: with trustworthy stamps and
    no violated constraint, display order == wire order.  Pre-fix, R1 edged
    every 200 after EVERY same-branch BYE copy and R2 zip-chained
    retransmitted copies across depths, so the +1 ms forwarded BYE displayed
    after the +500 ms retransmitted carrier BYE."""
    data, warnings = hp._finalize_pipeline(build_clean_rows())
    ts = [m["timestamp_ns"] for m in data]
    assert ts == sorted(ts), "display order violated wire chronology"
    assert not any("reordered" in w for w in warnings), warnings
    assert not any(m["ts_corrected"] for m in data)


def test_clean_replay_no_hairpins_no_drops():
    data, _warnings = hp._finalize_pipeline(build_clean_rows())
    assert not any(m["hairpin"] for m in data)
    assert [m["seq"] for m in data] == list(range(len(data)))


# ---------------------------------------------------------------------------
# (2) THE DEFECT: distinct hops whose stored copies share the topmost Via
#     branch (forwarding element's trace copy serialized without its own Via)
# ---------------------------------------------------------------------------

def build_same_branch_rows():
    """One teardown round where the SBC's stored copy of each FORWARDED
    request carries the UPSTREAM topmost Via branch (no own Via in the
    stored text) — the storage shape that collapses hops under a purely
    branch-keyed identity:

      * A-leg: BYE West-SBC-2 -> West-FreeSWITCH stored with topmost
        branch == the carrier's (same identity as BYE Sinch-Denver -> VIP,
        1 ms apart).
      * B-leg: BYE West-SBC-VIP -> Sinch-Atlanta-LD (the hop's ONLY capture)
        stored with topmost branch == FS's (same identity as the
        FS -> SigVIP pair, 1 ms apart)  ->  pre-fix the Atlanta hop merged
        away ENTIRELY and the long-span carrier arrow vanished.
    """
    rows = []
    t0 = BASE
    r = rows.append
    # A-leg BYE: carrier hop + forwarded hop, SAME topmost branch
    r(_row(t0, "110", "BYE", None, "Sinch-Denver", "West-SBC-VIP", A,
           [A_BYE_CARRIER], 103))
    r(_row(t0 + 1 * MS, "110", "BYE", None, "West-SBC-2", "West-FreeSWITCH", A,
           [A_BYE_CARRIER], 103))
    # FS 200 -> SBC + SBC 200 -> carrier (normal response stacks)
    r(_row(t0 + 20 * MS, "210", "BYE", 200, "West-FreeSWITCH", "West-SBC-2", A,
           [A_BYE_SBC, A_BYE_CARRIER], 103))
    r(_row(t0 + 21 * MS, "110", "BYE", 200, "West-SBC-VIP", "Sinch-Denver", A,
           [A_BYE_CARRIER], 103))
    # B-leg BYE: FS -> SigVIP captured twice, then the SBC -> Atlanta hop's
    # ONLY capture with the SAME topmost branch as FS's copies.
    r(_row(t0 + 30 * MS, "210", "BYE", None, "West-FreeSWITCH",
           "West-SBC-SigVIP", B, [B_BYE_FS], 79))
    r(_row(t0 + 30 * MS + 600_000, "110", "BYE", None, "West-FreeSWITCH",
           "West-SBC-SigVIP", B, [B_BYE_FS], 79))
    r(_row(t0 + 31 * MS, "110", "BYE", None, "West-SBC-VIP",
           "Sinch-Atlanta-LD", B, [B_BYE_FS], 79))
    # Atlanta 200 -> SBC, then SBC 200 -> FS
    r(_row(t0 + 70 * MS, "110", "BYE", 200, "Sinch-Atlanta-LD", "West-SBC-VIP",
           B, [B_BYE_SBC, B_BYE_FS], 79))
    r(_row(t0 + 71 * MS, "110", "BYE", 200, "West-SBC-2", "West-FreeSWITCH", B,
           [B_BYE_FS], 79))
    return rows


def test_same_branch_distinct_hops_all_survive():
    """The fix: rows with different directional (src, dst) pairs are distinct
    wire messages even under an identical branch identity."""
    data, _warnings = hp._finalize_pipeline(build_same_branch_rows())
    got = {_hop(m) for m in data}
    expected = {
        (A, "BYE", None, "Sinch-Denver", "West-SBC-VIP"),
        (A, "BYE", None, "West-SBC-2", "West-FreeSWITCH"),
        (A, "BYE", 200, "West-FreeSWITCH", "West-SBC-2"),
        (A, "BYE", 200, "West-SBC-VIP", "Sinch-Denver"),
        (B, "BYE", None, "West-FreeSWITCH", "West-SBC-SigVIP"),
        (B, "BYE", None, "West-SBC-VIP", "Sinch-Atlanta-LD"),   # the dropped hop
        (B, "BYE", 200, "Sinch-Atlanta-LD", "West-SBC-VIP"),
        (B, "BYE", 200, "West-SBC-2", "West-FreeSWITCH"),
    }
    assert got == expected, (
        f"missing={expected - got} extra={got - expected}"
    )
    assert len(data) == 8


def test_same_branch_capture_pair_still_merges():
    """The FS -> SigVIP pair (two captures of ONE wire message) must still
    merge to one row even while the same-branch Atlanta hop splits off."""
    data, _warnings = hp._finalize_pipeline(build_same_branch_rows())
    sig = [m for m in data
           if _hop(m) == (B, "BYE", None, "West-FreeSWITCH", "West-SBC-SigVIP")]
    assert len(sig) == 1
    assert sig[0]["node"] == "110,210"
    atl = [m for m in data
           if _hop(m) == (B, "BYE", None, "West-SBC-VIP", "Sinch-Atlanta-LD")]
    assert len(atl) == 1 and atl[0]["node"] == "110"


def test_same_branch_hop_order_still_causal():
    """Even with an identical topmost branch, the forwarded copies must
    display in wire order (timestamp tiebreak — no constraint applies)."""
    data, _warnings = hp._finalize_pipeline(build_same_branch_rows())
    ts = [m["timestamp_ns"] for m in data]
    assert ts == sorted(ts)


# ---------------------------------------------------------------------------
# (3) Alias-collapse regression guard: a src==dst self-capture still merges
#     with its directional twin (never an orphan row) — the behavior the
#     direction-agnostic identity was built for must survive the hop split
# ---------------------------------------------------------------------------

def test_collapsed_self_capture_joins_nearest_hop():
    rows = build_same_branch_rows()
    # A third capture of the FS -> SigVIP BYE whose endpoints alias-collapsed
    # (both mapped to the same node name): must merge into the FS -> SigVIP
    # row (0.7 ms away), NOT the Atlanta row (0.3 ms further) and NOT survive
    # as its own orphan row.
    rows.append(_row(BASE + 30 * MS + 700_000, "110", "BYE", None,
                     "West-SBC-SigVIP", "West-SBC-SigVIP", B, [B_BYE_FS], 79))
    data, _warnings = hp._finalize_pipeline(rows)
    assert len(data) == 8, f"orphan row leaked: {len(data)}"
    assert not any(m["src_ip"] == m["dst_ip"] for m in data)


def test_collapsed_only_capture_still_survives():
    """A wire message whose ONLY capture is alias-collapsed must still be
    emitted (never lost entirely) — unchanged behavior."""
    rows = [
        _row(BASE, "110", "BYE", None, "West-SBC-VIP", "West-SBC-VIP", B,
             [B_BYE_SBC, B_BYE_FS], 79),
    ]
    data, _warnings = hp._finalize_pipeline(rows)
    assert len(data) == 1
    assert data[0]["hairpin"] is True


# ---------------------------------------------------------------------------
# (4) Retransmissions + same-branch hop split together (the full operator
#     scenario): nothing merges across hops, nothing merges across rounds
# ---------------------------------------------------------------------------

def test_retransmitted_same_branch_rounds_full_inventory():
    rows = build_same_branch_rows()
    t1 = BASE + 500 * MS
    r = rows.append
    # Denver retransmits its BYE; the SBC re-forwards (stored again without
    # its own Via); FS re-answers 200; FS retransmits its B-leg BYE; the SBC
    # re-forwards to Atlanta (same stored shape).
    r(_row(t1, "110", "BYE", None, "Sinch-Denver", "West-SBC-VIP", A,
           [A_BYE_CARRIER], 103))
    r(_row(t1 + 1 * MS, "110", "BYE", None, "West-SBC-2", "West-FreeSWITCH", A,
           [A_BYE_CARRIER], 103))
    r(_row(t1 + 20 * MS, "210", "BYE", 200, "West-FreeSWITCH", "West-SBC-2", A,
           [A_BYE_SBC, A_BYE_CARRIER], 103))
    r(_row(t1 + 30 * MS, "210", "BYE", None, "West-FreeSWITCH",
           "West-SBC-SigVIP", B, [B_BYE_FS], 79))
    r(_row(t1 + 31 * MS, "110", "BYE", None, "West-SBC-VIP",
           "Sinch-Atlanta-LD", B, [B_BYE_FS], 79))
    data, _warnings = hp._finalize_pipeline(rows)
    # 8 original + 5 retransmitted wire messages
    assert len(data) == 13, f"expected 13, got {len(data)}"
    atl = [m for m in data
           if _hop(m) == (B, "BYE", None, "West-SBC-VIP", "Sinch-Atlanta-LD")]
    assert len(atl) == 2, "retransmitted Atlanta hop must render too"
    ts = [m["timestamp_ns"] for m in data]
    assert ts == sorted(ts), "rounds interleaved in display order"


# ---------------------------------------------------------------------------
# Plain runner (no pytest required)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    failures = 0
    tests = [
        (name, fn)
        for name, fn in sorted(globals().items())
        if name.startswith("test_") and callable(fn)
    ]
    for name, fn in tests:
        try:
            fn()
            print(f"PASS {name}")
        except Exception:
            failures += 1
            print(f"FAIL {name}")
            traceback.print_exc()
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    sys.exit(1 if failures else 0)
