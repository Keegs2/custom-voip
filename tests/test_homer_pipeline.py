"""Acceptance tests for the Homer SIP-trace post-processing pipeline.

The record list below is hand-coded from the VERIFIED ground-truth fixture
    tests/fixtures/homer_ground_truth_20260610.md
(raw ClickHouse rows of a real production call whose ladder rendered broken:
timestamp corruption put the A-leg carrier INVITE after its own 100 Trying,
up to 3 capture copies per wire message, and genuine VIP->VIP hairpin rows).
Timestamps, src/dst aliases, methods, statuses, capture nodes and Via branches
are taken verbatim from the fixture; raw_msg is minimal synthetic SIP text
carrying the fixture's Via stacks and a CSeq line.

Runnable WITHOUT fastapi/network: it loads docker/api/src/routers/
homer_pipeline.py (pure stdlib) directly by file path, bypassing the routers
package (routers/homer.py imports fastapi/httpx/auth).

Run:
    python3 -m pytest tests/test_homer_pipeline.py -v
or
    python3 tests/test_homer_pipeline.py
"""
import importlib.util
import pathlib
import sys
import traceback

_PIPELINE_PATH = (
    pathlib.Path(__file__).resolve().parents[1]
    / "docker" / "api" / "src" / "routers" / "homer_pipeline.py"
)
_spec = importlib.util.spec_from_file_location("homer_pipeline", _PIPELINE_PATH)
hp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hp)


# ---------------------------------------------------------------------------
# Fixture call constants (homer_ground_truth_20260610.md)
# ---------------------------------------------------------------------------

A = "258530374_92210034@67.231.13.185"          # A-leg Call-ID
B = "7523baca-df89-123f-0b87-4201c0a80a02"      # B-leg Call-ID

# Via sent-by hosts (real IPs; src/dst labels below are heplify aliases)
VIP = "34.24.133.82:5060"
FS90 = "34.139.119.135:5090"
BWATL = "67.231.13.185:5060"

# Via (branch, sent-by host) per hop — branches from the fixture's Via section.
A_INV_CARRIER = ("z9hG4bK08Ba7efa3017830e2bd", BWATL)
A_INV_SBC = ("z9hG4bK79c3.49d25b1a6d3a4e506a2af21826383424.0", VIP)
A_ACK_CARRIER = ("z9hG4bK08Baa84e66caef5a95f", BWATL)
# The fixture does not list the SBC's own branch on the A-leg SBC->FS ACK;
# any per-hop-unique value preserves the topology (synthetic placeholder).
A_ACK_SBC = ("z9hG4bK5ac3.ack0000000000000000000000000000000.0", VIP)
A_BYE_CARRIER = ("z9hG4bK08Bab52184caef5a95f", BWATL)
A_BYE_SBC = ("z9hG4bK5ac3.5a172f63a79098c41d166db24090cd7a.0", VIP)

B_INV_FS = ("z9hG4bK27BQ6UKj92ZmK", FS90)
B_INV_SBC = ("z9hG4bK0084.73dcff95228238048cf2c298db7317bd.0", VIP)
B_ACK_FS = ("z9hG4bK3g5F8p4N6Bp7e", FS90)
B_ACK_SBC = ("z9hG4bK0084.32a8b9fec7117640447d5da94c17b911.0", VIP)
B_BYE_FS = ("z9hG4bK4Sy89HNS3mcta", FS90)
B_BYE_SBC1 = ("z9hG4bKdf74.5d4f729ab536b412e2ee083db179b161.0", VIP)   # hairpin hop
B_BYE_SBC2 = ("z9hG4bKdf74.19b28c42a94ee2b1ead233ea7cb92d08.0", VIP)  # final egress


def _raw(method, status, vias, cseq_num, cseq_method, callid):
    """Minimal synthetic SIP text with the right Via stack + CSeq."""
    if status is None:
        start = f"{method} sip:+16174544217@example.invalid SIP/2.0"
    else:
        reason = {100: "Trying", 183: "Session Progress", 200: "OK"}.get(status, "OK")
        start = f"SIP/2.0 {status} {reason}"
    lines = [start]
    for branch, host in vias:
        lines.append(f"Via: SIP/2.0/UDP {host};branch={branch}")
    lines.append(f"Call-ID: {callid}")
    lines.append(f"CSeq: {cseq_num} {cseq_method}")
    lines.append("Content-Length: 0")
    return "\r\n".join(lines) + "\r\n\r\n"


def _row(ts_ns, node, method, status, src, dst, callid, vias, cseq_num, cseq_method=None):
    """A record in the exact shape homer.py's parsers emit."""
    cm = cseq_method or method
    return {
        "timestamp": None,
        "timestamp_ns": ts_ns,
        "from_user": "+15087282017",
        "to_user": "+16174544217",
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


def build_fixture_rows():
    """All 54 stored rows of the fixture call (Command 1 table, in stored order)."""
    r = _row
    return [
        # --- A-leg INVITE transaction (timestamp corruption: ALL request copies
        # are ingest-stamped ns-entropy values; the 100 Trying sorts FIRST) ----
        r(1781107707709698000, "100", "INVITE", 100, "SBC-VIP", "BW-ATL", A, [A_INV_CARRIER], 102),
        r(1781107707711764000, "200", "INVITE", 100, "FreeSWITCH:5080", "SBC-1", A, [A_INV_SBC, A_INV_CARRIER], 102),
        r(1781107707711906000, "100", "INVITE", 100, "FreeSWITCH:5080", "SBC-1", A, [A_INV_SBC, A_INV_CARRIER], 102),
        r(1781107707711975000, "100", "INVITE", 100, "FreeSWITCH:5080", "SBC-1", A, [A_INV_SBC, A_INV_CARRIER], 102),
        r(1781107707725832231, "200", "INVITE", None, "SBC-1", "FreeSWITCH:5080", A, [A_INV_SBC, A_INV_CARRIER], 102),
        r(1781107707725964951, "100", "INVITE", None, "BW-ATL", "SBC-VIP", A, [A_INV_CARRIER], 102),
        r(1781107707726162321, "100", "INVITE", None, "SBC-1", "FreeSWITCH:5080", A, [A_INV_SBC, A_INV_CARRIER], 102),
        # --- B-leg INVITE transaction ----------------------------------------
        r(1781107707742226000, "200", "INVITE", None, "FreeSWITCH:5090", "SBC-1", B, [B_INV_FS], 51234),
        r(1781107707742493000, "100", "INVITE", None, "FreeSWITCH:5090", "SBC-1", B, [B_INV_FS], 51234),
        r(1781107707743538000, "100", "INVITE", None, "SBC-1", "BW-DAL", B, [B_INV_SBC, B_INV_FS], 51234),
        r(1781107707743660000, "200", "INVITE", 100, "SBC-1", "FreeSWITCH:5090", B, [B_INV_FS], 51234),
        r(1781107707744163757, "100", "INVITE", 100, "SBC-1", "FreeSWITCH:5090", B, [B_INV_FS], 51234),
        r(1781107707782462000, "100", "INVITE", 100, "BW-DAL", "SBC-1", B, [B_INV_SBC, B_INV_FS], 51234),
        r(1781107707783249707, "100", "INVITE", 100, "BW-DAL", "SBC-1", B, [B_INV_SBC, B_INV_FS], 51234),
        # --- 183 Session Progress --------------------------------------------
        r(1781107709185304000, "100", "INVITE", 183, "BW-DAL", "SBC-1", B, [B_INV_SBC, B_INV_FS], 51234),
        r(1781107709185408000, "100", "INVITE", 183, "BW-DAL", "SBC-1", B, [B_INV_SBC, B_INV_FS], 51234),
        r(1781107709185708000, "100", "INVITE", 183, "SBC-1", "FreeSWITCH:5090", B, [B_INV_FS], 51234),
        r(1781107709186068000, "200", "INVITE", 183, "SBC-1", "FreeSWITCH:5090", B, [B_INV_FS], 51234),
        r(1781107709192878000, "200", "INVITE", 183, "FreeSWITCH:5080", "SBC-1", A, [A_INV_SBC, A_INV_CARRIER], 102),
        r(1781107709193095000, "100", "INVITE", 183, "FreeSWITCH:5080", "SBC-1", A, [A_INV_SBC, A_INV_CARRIER], 102),
        r(1781107709193198000, "100", "INVITE", 183, "FreeSWITCH:5080", "SBC-1", A, [A_INV_SBC, A_INV_CARRIER], 102),
        r(1781107709193498000, "100", "INVITE", 183, "SBC-VIP", "BW-ATL", A, [A_INV_CARRIER], 102),
        # --- 200 OK (INVITE) ---------------------------------------------------
        r(1781107716961399000, "100", "INVITE", 200, "BW-DAL", "SBC-1", B, [B_INV_SBC, B_INV_FS], 51234),
        r(1781107716961507000, "100", "INVITE", 200, "BW-DAL", "SBC-1", B, [B_INV_SBC, B_INV_FS], 51234),
        r(1781107716961845000, "100", "INVITE", 200, "SBC-1", "FreeSWITCH:5090", B, [B_INV_FS], 51234),
        r(1781107716962111000, "200", "INVITE", 200, "SBC-1", "FreeSWITCH:5090", B, [B_INV_FS], 51234),
        # --- B-leg ACK (incl. the genuine VIP->VIP hairpin row) ----------------
        r(1781107716963730000, "100", "ACK", None, "FreeSWITCH:5090", "SBC-1", B, [B_ACK_FS], 51234),
        r(1781107716964232921, "200", "ACK", None, "FreeSWITCH:5090", "SBC-1", B, [B_ACK_FS], 51234),
        r(1781107716964553000, "100", "ACK", None, "SBC-VIP", "SBC-VIP", B, [B_ACK_SBC, B_ACK_FS], 51234),
        # --- A-leg 200 OK + ACK -------------------------------------------------
        r(1781107716968394000, "100", "INVITE", 200, "FreeSWITCH:5080", "SBC-1", A, [A_INV_SBC, A_INV_CARRIER], 102),
        r(1781107716969065850, "200", "INVITE", 200, "FreeSWITCH:5080", "SBC-1", A, [A_INV_SBC, A_INV_CARRIER], 102),
        r(1781107716969202430, "100", "INVITE", 200, "FreeSWITCH:5080", "SBC-1", A, [A_INV_SBC, A_INV_CARRIER], 102),
        r(1781107716969222690, "100", "INVITE", 200, "SBC-VIP", "BW-ATL", A, [A_INV_CARRIER], 102),
        r(1781107716982023000, "100", "ACK", None, "BW-ATL", "SBC-VIP", A, [A_ACK_CARRIER], 102),
        r(1781107716982951000, "200", "ACK", None, "SBC-1", "FreeSWITCH:5080", A, [A_ACK_SBC, A_ACK_CARRIER], 102),
        # --- A-leg BYE (carrier-initiated) --------------------------------------
        r(1781107719831940000, "100", "BYE", None, "BW-ATL", "SBC-VIP", A, [A_BYE_CARRIER], 103),
        r(1781107719832565000, "100", "BYE", None, "SBC-1", "FreeSWITCH:5080", A, [A_BYE_SBC, A_BYE_CARRIER], 103),
        r(1781107719832982000, "200", "BYE", None, "SBC-1", "FreeSWITCH:5080", A, [A_BYE_SBC, A_BYE_CARRIER], 103),
        r(1781107719855009000, "100", "BYE", 200, "FreeSWITCH:5080", "SBC-1", A, [A_BYE_SBC, A_BYE_CARRIER], 103),
        r(1781107719855154000, "100", "BYE", 200, "SBC-VIP", "BW-ATL", A, [A_BYE_CARRIER], 103),
        r(1781107719855833958, "100", "BYE", 200, "FreeSWITCH:5080", "SBC-1", A, [A_BYE_SBC, A_BYE_CARRIER], 103),
        r(1781107719855856089, "200", "BYE", 200, "FreeSWITCH:5080", "SBC-1", A, [A_BYE_SBC, A_BYE_CARRIER], 103),
        # --- B-leg BYE: FS -> SBC-1 -> hairpin VIP->VIP -> BW-DAL ---------------
        r(1781107719859529000, "200", "BYE", None, "FreeSWITCH:5090", "SBC-1", B, [B_BYE_FS], 51235),
        r(1781107719859695000, "100", "BYE", None, "FreeSWITCH:5090", "SBC-1", B, [B_BYE_FS], 51235),
        r(1781107719860191000, "100", "BYE", None, "SBC-VIP", "SBC-VIP", B, [B_BYE_SBC1, B_BYE_FS], 51235),
        r(1781107719860515000, "100", "BYE", None, "SBC-VIP", "SBC-VIP", B, [B_BYE_SBC1, B_BYE_FS], 51235),
        r(1781107719860949000, "100", "BYE", None, "SBC-1", "BW-DAL", B, [B_BYE_SBC2, B_BYE_SBC1, B_BYE_FS], 51235),
        # --- B-leg BYE 200s retracing the hairpin (3 / 2 / 1 Via stacks) --------
        r(1781107719898013000, "100", "BYE", 200, "BW-DAL", "SBC-1", B, [B_BYE_SBC2, B_BYE_SBC1, B_BYE_FS], 51235),
        r(1781107719898138000, "100", "BYE", 200, "BW-DAL", "SBC-1", B, [B_BYE_SBC2, B_BYE_SBC1, B_BYE_FS], 51235),
        r(1781107719898207000, "100", "BYE", 200, "SBC-VIP", "SBC-VIP", B, [B_BYE_SBC1, B_BYE_FS], 51235),
        r(1781107719898705000, "100", "BYE", 200, "SBC-1", "FreeSWITCH:5090", B, [B_BYE_FS], 51235),
        r(1781107719899101758, "100", "BYE", 200, "SBC-VIP", "SBC-VIP", B, [B_BYE_SBC1, B_BYE_FS], 51235),
        r(1781107719899201658, "100", "BYE", 200, "SBC-VIP", "SBC-VIP", B, [B_BYE_SBC1, B_BYE_FS], 51235),
        r(1781107719899410898, "200", "BYE", 200, "SBC-1", "FreeSWITCH:5090", B, [B_BYE_FS], 51235),
    ]


# Unique wire-message inventory derived from the fixture:
# A-leg: INVITE/100/183/200/ACK/BYE/200-BYE at two hops each   = 14
# B-leg: same 14 plus the hairpin ACK copy and hairpin BYE hop = 16
EXPECTED_INVENTORY = {
    # ---- A-leg (14) ----
    (A, "INVITE", None, A_INV_CARRIER[0]),
    (A, "INVITE", None, A_INV_SBC[0]),
    (A, "INVITE", 100, A_INV_CARRIER[0]),
    (A, "INVITE", 100, A_INV_SBC[0]),
    (A, "INVITE", 183, A_INV_CARRIER[0]),
    (A, "INVITE", 183, A_INV_SBC[0]),
    (A, "INVITE", 200, A_INV_CARRIER[0]),
    (A, "INVITE", 200, A_INV_SBC[0]),
    (A, "ACK", None, A_ACK_CARRIER[0]),
    (A, "ACK", None, A_ACK_SBC[0]),
    (A, "BYE", None, A_BYE_CARRIER[0]),
    (A, "BYE", None, A_BYE_SBC[0]),
    (A, "BYE", 200, A_BYE_CARRIER[0]),
    (A, "BYE", 200, A_BYE_SBC[0]),
    # ---- B-leg (16) ----
    (B, "INVITE", None, B_INV_FS[0]),
    (B, "INVITE", None, B_INV_SBC[0]),
    (B, "INVITE", 100, B_INV_FS[0]),
    (B, "INVITE", 100, B_INV_SBC[0]),
    (B, "INVITE", 183, B_INV_FS[0]),
    (B, "INVITE", 183, B_INV_SBC[0]),
    (B, "INVITE", 200, B_INV_FS[0]),
    (B, "INVITE", 200, B_INV_SBC[0]),
    (B, "ACK", None, B_ACK_FS[0]),
    (B, "ACK", None, B_ACK_SBC[0]),       # hairpin VIP->VIP copy
    (B, "BYE", None, B_BYE_FS[0]),
    (B, "BYE", None, B_BYE_SBC1[0]),      # hairpin VIP->VIP hop
    (B, "BYE", None, B_BYE_SBC2[0]),      # final egress to BW-DAL
    (B, "BYE", 200, B_BYE_SBC2[0]),
    (B, "BYE", 200, B_BYE_SBC1[0]),       # hairpin reply leg
    (B, "BYE", 200, B_BYE_FS[0]),
}


def _key(m):
    return (m["callid"], m["method"], m["status"], m["via_branch"])


def _finalized():
    return hp._finalize_pipeline(build_fixture_rows())


def _find(data, callid, method, status, branch):
    matches = [
        m for m in data
        if _key(m) == (callid, method, status, branch)
    ]
    assert len(matches) == 1, f"expected exactly 1 match, got {len(matches)}"
    return matches[0]


# ---------------------------------------------------------------------------
# (a) dedup yields the exact unique wire-message inventory
# ---------------------------------------------------------------------------

def test_dedup_inventory():
    deduped = hp._deduplicate_results(build_fixture_rows())
    got = {_key(m) for m in deduped}
    assert len(deduped) == 30, f"expected 30 unique wire messages, got {len(deduped)}"
    assert got == EXPECTED_INVENTORY, (
        f"missing={EXPECTED_INVENTORY - got} extra={got - EXPECTED_INVENTORY}"
    )


def test_dedup_merges_capture_nodes():
    deduped = hp._deduplicate_results(build_fixture_rows())
    # FS 100 Trying captured 3x (.711764 node 200 / .711906 + .711975 node 100)
    m = _find(deduped, A, "INVITE", 100, A_INV_SBC[0])
    assert m["node"] == "100,200", m["node"]


def test_survivor_timestamp_election():
    deduped = hp._deduplicate_results(build_fixture_rows())
    # Mixed cluster: HEP-stamped .716968394000 beats the two ingest-stamped
    # copies (.716969065850 / .716969202430) — µs precision preferred.
    m = _find(deduped, A, "INVITE", 200, A_INV_SBC[0])
    assert m["timestamp_ns"] == 1781107716968394000, m["timestamp_ns"]
    # All-corrupted cluster (A-leg SBC->FS INVITE: .725832231 / .726162321):
    # no HEP copy exists, so the MINIMUM survives (ingest stamps are always
    # LATE, never early).
    m = _find(deduped, A, "INVITE", None, A_INV_SBC[0])
    assert m["timestamp_ns"] == 1781107707725832231, m["timestamp_ns"]
    # B-leg 100 Trying: HEP .743660000 beats ingest .744163757.
    m = _find(deduped, B, "INVITE", 100, B_INV_FS[0])
    assert m["timestamp_ns"] == 1781107707743660000, m["timestamp_ns"]


# ---------------------------------------------------------------------------
# (b) post-causality ordering
# ---------------------------------------------------------------------------

def test_causality_ordering_aleg_invite():
    data, warnings = _finalized()
    inv_carrier = _find(data, A, "INVITE", None, A_INV_CARRIER[0])
    inv_sbc = _find(data, A, "INVITE", None, A_INV_SBC[0])
    trying_carrier = _find(data, A, "INVITE", 100, A_INV_CARRIER[0])
    trying_fs = _find(data, A, "INVITE", 100, A_INV_SBC[0])
    # The broken-render bug: stored timestamps put the INVITE after its own
    # 100 Trying.  Causality ordering must fix it.
    assert inv_carrier["seq"] < trying_carrier["seq"]
    assert inv_carrier["seq"] < inv_sbc["seq"]
    assert inv_sbc["seq"] < trying_fs["seq"]
    assert "2 messages reordered for SIP causality" in warnings


def test_no_response_precedes_its_request_anywhere():
    data, _warnings = _finalized()
    requests = {
        (m["callid"], m["via_branch"]): m
        for m in data
        if m["status"] is None
    }
    checked = 0
    for m in data:
        if m["status"] is None:
            continue
        req = requests.get((m["callid"], m["via_branch"]))
        assert req is not None, f"no request found for response {_key(m)}"
        assert req["seq"] < m["seq"], (
            f"response {_key(m)} (seq {m['seq']}) precedes its request (seq {req['seq']})"
        )
        checked += 1
    # A-leg: 100/183/200/BYE-200 x 2 hops = 8; B-leg: 100/183/200 x 2 hops
    # + BYE-200 x 3 hops (incl. hairpin) = 9.
    assert checked == 17


def test_ack_never_precedes_2xx_and_request_chains_hold():
    data, _warnings = _finalized()
    # ACK after the 2xx it acknowledges (both legs, every hop).
    for leg, inv_hops, ack_hops in (
        (A, (A_INV_CARRIER, A_INV_SBC), (A_ACK_CARRIER, A_ACK_SBC)),
        (B, (B_INV_FS, B_INV_SBC), (B_ACK_FS, B_ACK_SBC)),
    ):
        for ok_branch, _h in inv_hops:
            ok = _find(data, leg, "INVITE", 200, ok_branch)
            for ack_branch, _h2 in ack_hops:
                ack = _find(data, leg, "ACK", None, ack_branch)
                assert ok["seq"] < ack["seq"]
    # Forwarded request copies ordered by hop (Via-stack depth).
    bye_fs = _find(data, B, "BYE", None, B_BYE_FS[0])
    bye_hairpin = _find(data, B, "BYE", None, B_BYE_SBC1[0])
    bye_final = _find(data, B, "BYE", None, B_BYE_SBC2[0])
    assert bye_fs["seq"] < bye_hairpin["seq"] < bye_final["seq"]
    # Retraced 200-BYE copies: deeper Via stack (carrier side) first.
    ok_bw = _find(data, B, "BYE", 200, B_BYE_SBC2[0])
    ok_hairpin = _find(data, B, "BYE", 200, B_BYE_SBC1[0])
    ok_fs = _find(data, B, "BYE", 200, B_BYE_FS[0])
    assert ok_bw["seq"] < ok_hairpin["seq"] < ok_fs["seq"]


def test_ts_corrected_flags():
    data, warnings = _finalized()
    flagged = {_key(m) for m in data if m["ts_corrected"]}
    # Exactly the two ingest-stamped A-leg INVITE request hops were moved;
    # raw timestamps stay untouched.
    assert flagged == {
        (A, "INVITE", None, A_INV_CARRIER[0]),
        (A, "INVITE", None, A_INV_SBC[0]),
    }, flagged
    inv = _find(data, A, "INVITE", None, A_INV_CARRIER[0])
    assert inv["timestamp_ns"] == 1781107707725964951  # raw stamp NOT altered
    # 14 rows in the fixture carry ingest (sub-µs entropy) stamps:
    # .725832231 .725964951 .726162321 .744163757 .783249707 .964232921
    # .969065850 .969202430 .969222690 .855833958 .855856089 .899101758
    # .899201658 .899410898
    assert "14 ingest-stamped rows detected" in warnings


# ---------------------------------------------------------------------------
# (c) hairpin rows flagged (kept, never dropped)
# ---------------------------------------------------------------------------

def test_hairpin_flags():
    data, _warnings = _finalized()
    hairpins = {_key(m) for m in data if m["hairpin"]}
    assert hairpins == {
        (B, "ACK", None, B_ACK_SBC[0]),     # VIP->VIP in-dialog ACK
        (B, "BYE", None, B_BYE_SBC1[0]),    # VIP->VIP BYE hop 1
        (B, "BYE", 200, B_BYE_SBC1[0]),     # VIP->VIP 200 retracing
    }, hairpins
    # The final SBC->BW-DAL BYE carries TWO SBC Vias (double traversal proof)
    # but is the real carrier egress — it must NOT be collapsed as hairpin.
    assert _find(data, B, "BYE", None, B_BYE_SBC2[0])["hairpin"] is False
    assert _find(data, B, "BYE", 200, B_BYE_SBC2[0])["hairpin"] is False


# ---------------------------------------------------------------------------
# (d) seq is unique, dense, and data is returned in seq order
# ---------------------------------------------------------------------------

def test_seq_unique_dense_ordered():
    data, _warnings = _finalized()
    assert [m["seq"] for m in data] == list(range(len(data)))
    assert len(data) == 30


def test_response_contract_fields():
    data, warnings = _finalized()
    assert isinstance(warnings, list) and all(isinstance(w, str) for w in warnings)
    for m in data:
        assert isinstance(m["node"], str) and m["node"]
        assert isinstance(m["hairpin"], bool)
        assert isinstance(m["ts_corrected"], bool)
        assert isinstance(m["seq"], int)
        # Pre-existing fields still present (backward compatible).
        for field in (
            "timestamp", "timestamp_ns", "from_user", "to_user", "callid",
            "method", "cseq", "via_branch", "src_ip", "dst_ip", "status",
            "raw_msg",
        ):
            assert field in m, f"missing existing field {field}"


def test_clean_input_passthrough():
    """With trustworthy stamps and no duplicates, order is pure timestamp
    order: nothing reordered, nothing flagged, no warnings."""
    rows = [
        _row(1000_000_000_000, "100", "INVITE", None, "BW-ATL", "SBC-VIP", A, [A_INV_CARRIER], 102),
        _row(1001_000_000_000, "100", "INVITE", 100, "SBC-VIP", "BW-ATL", A, [A_INV_CARRIER], 102),
        _row(1002_000_000_000, "100", "INVITE", 200, "SBC-VIP", "BW-ATL", A, [A_INV_CARRIER], 102),
        _row(1003_000_000_000, "100", "ACK", None, "BW-ATL", "SBC-VIP", A, [A_ACK_CARRIER], 102),
    ]
    data, warnings = hp._finalize_pipeline(rows)
    assert [m["timestamp_ns"] for m in data] == sorted(m["timestamp_ns"] for m in data)
    assert not any(m["ts_corrected"] for m in data)
    assert not any(m["hairpin"] for m in data)
    assert warnings == []


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
