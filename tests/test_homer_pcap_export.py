"""PCAP export — GET /v1/homer/pcap (edge/internal classification + synthesis).

The pinned contract (UI is built against this):
  * GET /v1/homer/pcap?call_id=<sip call-id>&internal=<bool, default false>
    &correlated=<bool, default true> — same auth gate as POST /search
    (support/admin).
  * 200: binary body, Content-Type application/vnd.tcpdump.pcap,
    Content-Disposition attachment; filename="sip_<sanitized-callid>
    [_internal].pcap" — "_internal" suffix ONLY when internal=true.
  * internal=false is the API-LEVEL default: EDGE packets only (our SBCs
    <-> carriers/customer PBXes); internal topology entirely absent.
  * 404 with detail when no stored packets at all, AND when edge filtering
    leaves zero packets (never an empty-but-valid pcap; the on-net detail
    says to retry with internal=true).
  * 400 on malformed/empty call_id; 413 with detail above ~2000 packets.
  * X-Pcap-Skipped header counts unrepresentable rows (IPv6 endpoints).

Two layers (mirrors tests/test_homer_number_search.py):

  1) PURE layer — routers/homer_pcap.py loaded directly by file path
     (stdlib-only): the lua alias-drift guard, the classification truth
     table, and a pcap ROUND-TRIP through an INDEPENDENT struct-unpack
     parser written here (not the builder's own code).

  2) ENDPOINT layer — the REAL homer router behind the REAL
     JWTAuthMiddleware with REAL minted JWTs; only the qryn/ClickHouse HTTP
     hop is mocked via httpx.MockTransport (the ClickHouse mock answers the
     actual SQL the router ships, keyed on the Call-IDs in the IN clause).

Run:  JWT_SECRET_KEY=x python3 -m pytest tests/test_homer_pcap_export.py -q
"""
import asyncio
import importlib.util
import json
import os
import pathlib
import re
import struct
import sys
import time

import pytest

# Env BEFORE any app-module import (auth.security reads JWT_SECRET_KEY at
# import; dead local ports make any request that escapes the mock fail fast).
os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
os.environ.setdefault("ENV", "development")
os.environ.setdefault("QRYN_URL", "http://127.0.0.1:1")
os.environ.setdefault("CLICKHOUSE_URL", "http://127.0.0.1:1")

REPO = pathlib.Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
LUA_ALIAS_FILE = REPO / "docker" / "homer" / "scripts" / "ip-alias.lua"
sys.path.insert(0, str(API_SRC))

# ---------------------------------------------------------------------------
# Layer 1 — pure module, loaded by file path (no fastapi required)
# ---------------------------------------------------------------------------

_PCAP_PATH = API_SRC / "routers" / "homer_pcap.py"
_spec = importlib.util.spec_from_file_location("homer_pcap", _PCAP_PATH)
hpc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hpc)


# ---- alias-drift protection ------------------------------------------------

def _parse_lua_aliases() -> dict:
    """Independent regex parse of the REAL ip-alias.lua aliases table."""
    text = LUA_ALIAS_FILE.read_text()
    body = text.split("local aliases", 1)[1].split("function ", 1)[0]
    return dict(re.findall(r'\[\s*"([^"]+)"\s*\]\s*=\s*"([^"]+)"', body))


def test_alias_map_agrees_with_lua_file():
    """THE drift guard: the Python mirror must equal the lua table exactly.

    ip-alias.lua is not shipped inside the API container, so the runtime
    cannot parse it — this test is what makes silent drift impossible.
    """
    lua = _parse_lua_aliases()
    assert lua, "failed to parse any aliases out of ip-alias.lua"
    assert hpc.HEP_IP_ALIASES == lua, (
        "HEP_IP_ALIASES (routers/homer_pcap.py) has drifted from "
        "docker/homer/scripts/ip-alias.lua — update the mirror.\n"
        f"only-in-lua: {set(lua.items()) - set(hpc.HEP_IP_ALIASES.items())}\n"
        f"only-in-py:  {set(hpc.HEP_IP_ALIASES.items()) - set(lua.items())}"
    )


def test_every_alias_name_is_classifiable():
    """A NEW carrier family added to the lua must not silently classify as
    platform: every name must match a carrier prefix or a known platform
    node pattern, else this fails until homer_pcap.py is consciously
    extended."""
    platform_pat = re.compile(r"SBC|FreeSWITCH|Services")
    for ip, name in _parse_lua_aliases().items():
        assert (
            name.startswith(hpc.CARRIER_NAME_PREFIXES)
            or platform_pat.search(name)
        ), (
            f"alias {ip} -> {name!r} matches neither CARRIER_NAME_PREFIXES "
            "nor the platform node pattern — extend homer_pcap.py"
        )


def test_carrier_set_derived_from_map():
    # Derived FROM the alias map: every BW-*/Sinch-* IP, nothing else.
    assert "67.231.2.12" in hpc.CARRIER_IPS          # BW-DAL
    assert "206.146.100.24" in hpc.CARRIER_IPS       # Sinch-Denver
    assert "206.146.98.26" in hpc.CARRIER_IPS        # Sinch-Atlanta-LD (term)
    assert "34.24.133.82" not in hpc.CARRIER_IPS     # SBC-VIP is platform
    assert hpc.CARRIER_IPS.isdisjoint(hpc.PLATFORM_IPS)
    assert hpc.CARRIER_IPS | hpc.PLATFORM_IPS == set(hpc.HEP_IP_ALIASES)


def test_name_to_ip_prefers_public_interface():
    # Collapsed nodes render as their PUBLIC face (what the outside party
    # saw) — a private VPC IP must never be elected for a dual-homed node.
    assert hpc.NAME_TO_IP["SBC-1"] == "34.74.71.32"
    assert hpc.NAME_TO_IP["FreeSWITCH"] == "34.139.119.135"
    assert hpc.NAME_TO_IP["West-FreeSWITCH"] == "8.229.177.165"
    # Single-interface / private-only nodes keep their (only) IP.
    assert hpc.NAME_TO_IP["SBC-SigVIP"] == "10.142.0.250"
    assert hpc.NAME_TO_IP["West-Services"] == "10.138.0.2"
    assert hpc.NAME_TO_IP["BW-DAL"] == "67.231.2.12"


# ---- classification truth table --------------------------------------------

# (src_label, dst_label, is_edge, description) — every row from the design.
TRUTH_TABLE = [
    ("BW-ATL", "SBC-VIP", True, "carrier <-> NLB VIP"),
    ("SBC-VIP", "BW-DAL", True, "VIP <-> carrier (reverse dir)"),
    ("BW-DAL", "34.74.71.32", True, "carrier <-> SBC public (raw IP label)"),
    ("67.231.2.12", "34.74.71.32", True, "carrier raw IP <-> SBC public raw"),
    ("Sinch-Denver", "SBC-VIP", True, "Sinch carrier <-> VIP"),
    # NOTE: genuinely routable public IPs on purpose — TEST-NET documentation
    # ranges (203.0.113/24 etc.) are NON-global per the IANA registry and
    # correctly fail CLOSED to platform/internal.
    ("66.102.0.5", "SBC-VIP", True, "customer PBX (unknown public) <-> VIP"),
    ("66.102.0.5", "10.142.0.100", True,
     "unknown public <-> platform private (external party present)"),
    ("66.102.0.5", "99.83.128.4", True,
     "unknown public <-> unknown public (neither is ours -> no internal "
     "info in the packet)"),
    ("SBC-1", "FreeSWITCH", False, "SBC <-> FS"),
    ("FreeSWITCH", "FreeSWITCH-2", False, "FS <-> FS (media HA pair)"),
    ("SBC-1", "SBC-2", False, "SBC <-> SBC"),
    ("SBC-SigVIP", "FreeSWITCH", False, "signaling ILB VIP <-> FS"),
    ("10.142.0.100", "192.168.10.2", False, "raw private <-> raw private"),
    ("34.74.71.32", "34.139.119.135", False,
     "SBC public <-> FS public (both raw IPs, both in platform set)"),
    ("127.0.0.1", "SBC-1", False, "loopback <-> platform"),
    ("169.254.1.1", "10.142.0.100", False, "link-local <-> platform"),
    ("Mystery-Node", "SBC-1", False,
     "drifted/unknown NAME fails CLOSED to platform (privacy default)"),
    ("Services", "West-Services", False, "services <-> services"),
]


@pytest.mark.parametrize(
    "src,dst,expected,desc", TRUTH_TABLE,
    ids=[t[3][:48] for t in TRUTH_TABLE])
def test_truth_table(src, dst, expected, desc):
    assert hpc.is_edge_packet(src, dst) is expected, desc
    # Edge-ness is symmetric (at-least-one-external is commutative).
    assert hpc.is_edge_packet(dst, src) is expected, f"{desc} (swapped)"


def test_resolve_ip():
    assert hpc.resolve_ip("BW-DAL") == "67.231.2.12"
    assert hpc.resolve_ip("SBC-1") == "34.74.71.32"
    assert hpc.resolve_ip("203.0.113.5") == "203.0.113.5"   # raw passthrough
    assert hpc.resolve_ip("Mystery-Node") == "0.0.0.0"      # drifted alias
    assert hpc.resolve_ip("") == "0.0.0.0"


# ---- pcap synthesis: round-trip through an INDEPENDENT parser --------------

def _parse_pcap(data: bytes) -> tuple[dict, list[dict]]:
    """Minimal independent libpcap parser (struct-unpack only — deliberately
    NOT reusing any builder code)."""
    magic, vmaj, vmin, thiszone, sigfigs, snaplen, linktype = struct.unpack(
        "<IHHiIII", data[:24])
    hdr = dict(magic=magic, vmaj=vmaj, vmin=vmin, snaplen=snaplen,
               linktype=linktype)
    packets = []
    off = 24
    while off < len(data):
        ts_sec, ts_usec, incl_len, orig_len = struct.unpack(
            "<IIII", data[off:off + 16])
        off += 16
        frame = data[off:off + incl_len]
        off += incl_len
        assert len(frame) == incl_len == orig_len
        ethertype = struct.unpack("!H", frame[12:14])[0]
        ip = frame[14:34]
        (ver_ihl, tos, total_len, ident, flags_frag,
         ttl, proto) = struct.unpack("!BBHHHBB", ip[:10])
        cksum = struct.unpack("!H", ip[10:12])[0]
        src_ip = ".".join(str(b) for b in ip[12:16])
        dst_ip = ".".join(str(b) for b in ip[16:20])
        sport, dport, udp_len, udp_cksum = struct.unpack(
            "!HHHH", frame[34:42])
        payload = frame[42:]
        # RFC 1071 verification: folding the sum over the WHOLE header
        # (checksum field included) must give 0xFFFF.
        s = sum((ip[i] << 8) | ip[i + 1] for i in range(0, 20, 2))
        s = (s >> 16) + (s & 0xFFFF)
        s += s >> 16
        packets.append(dict(
            ts_sec=ts_sec, ts_usec=ts_usec, eth_zero=frame[:12] == b"\x00" * 12,
            ethertype=ethertype, ver_ihl=ver_ihl, total_len=total_len,
            ttl=ttl, proto=proto, checksum_ok=(s == 0xFFFF),
            src_ip=src_ip, dst_ip=dst_ip, sport=sport, dport=dport,
            udp_len=udp_len, udp_cksum=udp_cksum, payload=payload))
    return hdr, packets


def _row(cid, ts_ns, src, dst, msg, sport="5060", dport="5080", node="100"):
    return {"callid": cid, "timestamp_ns": ts_ns, "src_ip": src,
            "dst_ip": dst, "src_port": sport, "dst_port": dport,
            "node": node, "raw_msg": msg}


def test_pcap_roundtrip():
    msg1 = "INVITE sip:+17744045256@34.24.133.82 SIP/2.0\r\nCSeq: 1 INVITE\r\n\r\n"
    msg2 = "SIP/2.0 200 OK\r\nCSeq: 1 INVITE\r\n\r\n"
    ts1 = 1_781_107_707_709_698_000
    ts2 = ts1 + 42_000_000  # +42 ms
    data, count, skipped = hpc.build_pcap([
        _row("c1", ts1, "BW-ATL", "SBC-VIP", msg1),
        _row("c1", ts2, "SBC-VIP", "BW-ATL", msg2, sport="5080", dport="5060"),
    ])
    assert (count, skipped) == (2, 0)

    hdr, pkts = _parse_pcap(data)
    assert hdr["magic"] == 0xA1B2C3D4
    assert (hdr["vmaj"], hdr["vmin"]) == (2, 4)
    assert hdr["linktype"] == 1                    # Ethernet
    assert len(pkts) == 2

    p1, p2 = pkts
    for p in pkts:
        assert p["eth_zero"] and p["ethertype"] == 0x0800
        assert p["ver_ihl"] == 0x45 and p["proto"] == 17 and p["ttl"] == 64
        assert p["checksum_ok"], "IPv4 header checksum must verify"
        assert p["udp_cksum"] == 0                 # legal for UDP/IPv4

    assert p1["ts_sec"] == ts1 // 1_000_000_000
    assert p1["ts_usec"] == (ts1 % 1_000_000_000) // 1000
    assert p2["ts_usec"] - p1["ts_usec"] == 42_000
    assert p1["src_ip"] == "67.231.13.185"         # BW-ATL resolved
    assert p1["dst_ip"] == "34.24.133.82"          # SBC-VIP resolved
    assert (p1["sport"], p1["dport"]) == (5060, 5080)
    assert (p2["sport"], p2["dport"]) == (5080, 5060)
    assert p1["payload"] == msg1.encode()
    assert p2["payload"] == msg2.encode()
    assert p1["total_len"] == 20 + 8 + len(msg1)
    assert p1["udp_len"] == 8 + len(msg1)


def test_pcap_skips_ipv6_and_unknown_name_renders_zero_ip():
    data, count, skipped = hpc.build_pcap([
        _row("c1", 10**18, "2001:db8::1", "SBC-VIP", "OPTIONS x\r\n\r\n"),
        _row("c1", 10**18, "Mystery-Node", "SBC-VIP", "OPTIONS y\r\n\r\n"),
    ])
    assert (count, skipped) == (1, 1)              # IPv6 skipped, not fatal
    _hdr, pkts = _parse_pcap(data)
    assert pkts[0]["src_ip"] == "0.0.0.0"          # documented sentinel
    assert pkts[0]["dst_ip"] == "34.24.133.82"


def test_pcap_port_defaults_and_garbage():
    data, count, skipped = hpc.build_pcap([
        _row("c1", 10**18, "BW-DAL", "SBC-VIP", "X\r\n\r\n",
             sport=None, dport="junk"),
    ])
    assert (count, skipped) == (1, 0)
    _hdr, pkts = _parse_pcap(data)
    assert (pkts[0]["sport"], pkts[0]["dport"]) == (5060, 5060)


def test_pcap_skips_oversized_payload():
    data, count, skipped = hpc.build_pcap([
        _row("c1", 10**18, "BW-DAL", "SBC-VIP", "A" * 70000),
    ])
    assert (count, skipped) == (0, 1)
    assert data == hpc.PCAP_GLOBAL_HEADER


# ---------------------------------------------------------------------------
# Layer 2 — endpoint tests over the REAL router + REAL JWT middleware
# ---------------------------------------------------------------------------

try:
    import fastapi  # noqa: F401
    import httpx
    _WEB = True
except ImportError:  # pragma: no cover - dev envs have these installed
    httpx = None
    _WEB = False

needs_web = pytest.mark.skipif(not _WEB, reason="fastapi/httpx required")

_REAL_ASYNC_CLIENT = httpx.AsyncClient if _WEB else None

_LOOP = asyncio.new_event_loop()


def _run(coro):
    return _LOOP.run_until_complete(coro)


# Recent timestamps (1h ago) so the endpoint's 30-day lookback covers them.
BASE_NS = (int(time.time()) - 3600) * 1_000_000_000

A_LEG = "aleg-test-1@67.231.13.185"
B_LEG = "bleg-test-1@192.168.10.2"


def _sipmsg(cid, first_line="INVITE sip:+17744045256@x SIP/2.0", xcid=None):
    xcid_hdr = f"X-CID: {xcid}\r\n" if xcid else ""
    return (
        f"{first_line}\r\n"
        f"Call-ID: {cid}\r\n"
        f"{xcid_hdr}"
        "CSeq: 1 INVITE\r\nContent-Length: 0\r\n\r\n"
    )


def _ch_row(cid, ts_ns, src, dst, msg, sport="5060", dport="5060",
            node="100", method="INVITE"):
    """One ClickHouse JSONEachRow row exactly as samples_v3/time_series
    produce it (labels is a JSON STRING)."""
    return {
        "timestamp_ns": ts_ns,
        "msg": msg,
        "labels": json.dumps({
            "type": "sip", "method": method, "call_id": cid,
            "src_ip": src, "dst_ip": dst,
            "src_port": sport, "dst_port": dport, "node": node,
        }),
    }


def _aleg_rows():
    """A realistic mixed capture: 2 EDGE packets (carrier <-> VIP) and
    2 INTERNAL packets (SBC <-> FS) for the same call."""
    m_in = _sipmsg(A_LEG)
    m_ok = _sipmsg(A_LEG, first_line="SIP/2.0 200 OK")
    return [
        _ch_row(A_LEG, BASE_NS + 0, "BW-ATL", "SBC-VIP", m_in),
        _ch_row(A_LEG, BASE_NS + 1_000_000, "SBC-1", "FreeSWITCH", m_in,
                dport="5080"),
        _ch_row(A_LEG, BASE_NS + 5_000_000, "FreeSWITCH", "SBC-1", m_ok,
                sport="5080", node="200"),
        _ch_row(A_LEG, BASE_NS + 6_000_000, "SBC-VIP", "BW-ATL", m_ok),
    ]


def _bleg_rows(xcid=A_LEG):
    """B-leg (FS -> SBC -> carrier). The FS-originated INVITE carries
    X-CID: <a-leg> — the correlation hook the search pipeline uses."""
    m_inv = _sipmsg(B_LEG, xcid=xcid)
    return [
        _ch_row(B_LEG, BASE_NS + 2_000_000, "FreeSWITCH", "SBC-SigVIP",
                m_inv, sport="5090", node="200"),
        _ch_row(B_LEG, BASE_NS + 3_000_000, "SBC-VIP", "BW-DAL", m_inv),
    ]


def _loki_xcid_hit(bleg_cid=B_LEG, aleg_cid=A_LEG):
    """qryn Step-2 style response: one B-leg message whose body carries
    X-CID: <a-leg> (what the |~ "X-CID:" scan returns)."""
    raw = _sipmsg(bleg_cid, xcid=aleg_cid)
    return {"data": {"result": [{
        "stream": {"type": "sip", "method": "INVITE", "call_id": bleg_cid,
                   "src_ip": "FreeSWITCH", "dst_ip": "SBC-SigVIP",
                   "node": "200"},
        "values": [[str(BASE_NS + 2_000_000), raw]],
    }]}}


class _UpstreamMock:
    """MockTransport for BOTH upstream hops: qryn (GET query_range) and
    ClickHouse (POST SQL).  The ClickHouse handler answers the router's real
    SQL by extracting the Call-IDs from the ``val IN (...)`` clause and
    returning the fixture rows for exactly those calls — so the correlated
    refetch is exercised end-to-end, not stubbed."""

    def __init__(self, ch_rows=None, loki_json=None):
        self.requests = []
        self.ch_rows = ch_rows or {}   # {call_id: [JSONEachRow dict, ...]}
        self.loki_json = loki_json if loki_json is not None \
            else {"data": {"result": []}}

    def _handle(self, request):
        self.requests.append(request)
        if "/loki/api/v1/query_range" in request.url.path:
            return httpx.Response(200, json=self.loki_json)
        # ClickHouse SQL over HTTP
        sql = request.content.decode()
        m = re.search(r"val IN \(([^)]*)\)", sql)
        cids = re.findall(r"'([^']*)'", m.group(1)) if m else []
        limit = int(re.search(r"LIMIT (\d+)", sql).group(1))
        rows = []
        for cid in cids:
            rows.extend(self.ch_rows.get(cid, []))
        rows.sort(key=lambda r: r["timestamp_ns"])
        return httpx.Response(
            200, text="\n".join(json.dumps(r) for r in rows[:limit]))

    def factory(self, *args, **kwargs):
        return _REAL_ASYNC_CLIENT(transport=httpx.MockTransport(self._handle))


@pytest.fixture(scope="module")
def api():
    """Real homer router behind the real JWT middleware + real minted JWTs."""
    if not _WEB:
        pytest.skip("fastapi/httpx required")
    try:
        from fastapi import FastAPI
        from middleware.auth import JWTAuthMiddleware
        from auth.security import create_access_token
        from routers import homer as homer_mod
    except ImportError as exc:  # pragma: no cover
        pytest.skip(f"API deps missing: {exc}")

    app = FastAPI()
    app.add_middleware(JWTAuthMiddleware)
    app.include_router(homer_mod.router, prefix="/v1/homer")
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    client = httpx.AsyncClient(transport=transport, base_url="http://test")

    def mint(sub, email, role, customer_id):
        return create_access_token(
            {"sub": sub, "email": email, "role": role,
             "customer_id": customer_id})

    ctx = {
        "client": client,
        "homer": homer_mod,
        "tokens": {
            "admin": mint("1", "admin@test.local", "admin", None),
            "support": mint("2", "support@test.local", "support", None),
            "user": mint("3", "tenant@test.local", "user", 42),
            "readonly": mint("4", "tenant-ro@test.local", "readonly", 42),
        },
    }
    try:
        yield ctx
    finally:
        _run(client.aclose())


def _auth(api, role):
    return {"Authorization": f"Bearer {api['tokens'][role]}"}


def _export(api, monkeypatch, role="support", ch_rows=None, loki_json=None,
            **params):
    mock = _UpstreamMock(ch_rows, loki_json)
    monkeypatch.setattr(api["homer"].httpx, "AsyncClient", mock.factory)
    r = _run(api["client"].get(
        "/v1/homer/pcap", headers=_auth(api, role), params=params))
    return r, mock


def _payloads(pcap_bytes):
    _hdr, pkts = _parse_pcap(pcap_bytes)
    return [p["payload"].decode() for p in pkts], pkts


# ---- auth gate (same as POST /search) --------------------------------------

@needs_web
def test_pcap_no_token_is_401(api):
    r = _run(api["client"].get("/v1/homer/pcap", params={"call_id": A_LEG}))
    assert r.status_code == 401, r.text


@needs_web
@pytest.mark.parametrize("role", ["user", "readonly"])
def test_pcap_tenant_roles_403(api, monkeypatch, role):
    r, mock = _export(api, monkeypatch, role=role, call_id=A_LEG)
    assert r.status_code == 403, r.text
    assert mock.requests == []      # rejected before any upstream I/O


@needs_web
@pytest.mark.parametrize("role", ["support", "admin"])
def test_pcap_support_and_admin_pass_gate(api, monkeypatch, role):
    r, _mock = _export(api, monkeypatch, role=role,
                       ch_rows={A_LEG: _aleg_rows()}, call_id=A_LEG)
    assert r.status_code == 200, r.text


# ---- 400 on malformed/empty call_id ----------------------------------------

@needs_web
@pytest.mark.parametrize("bad", ["", "   ", "x" * 600])
def test_pcap_400_bad_callid(api, monkeypatch, bad):
    r, mock = _export(api, monkeypatch, call_id=bad)
    assert r.status_code == 400, r.text
    assert mock.requests == []      # validated before any upstream I/O


@needs_web
def test_pcap_400_missing_callid_param(api, monkeypatch):
    mock = _UpstreamMock()
    monkeypatch.setattr(api["homer"].httpx, "AsyncClient", mock.factory)
    r = _run(api["client"].get("/v1/homer/pcap", headers=_auth(api, "support")))
    assert r.status_code == 400, r.text


# ---- the privacy default: internal=false at the API level ------------------

@needs_web
def test_pcap_default_is_edge_only(api, monkeypatch):
    # NO internal param sent at all — the API default must exclude every
    # internal hop (this is the load-bearing privacy behavior).
    r, _mock = _export(api, monkeypatch,
                       ch_rows={A_LEG: _aleg_rows()},
                       call_id=A_LEG, correlated="false")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/vnd.tcpdump.pcap"
    assert r.headers["x-pcap-skipped"] == "0"

    payloads, pkts = _payloads(r.content)
    assert len(pkts) == 2           # only the carrier<->VIP pair survives
    ips = {p["src_ip"] for p in pkts} | {p["dst_ip"] for p in pkts}
    # Internal topology entirely absent: no VPC/media-subnet addresses, no
    # FS public address either (the FS hop itself is internal).
    assert ips == {"67.231.13.185", "34.24.133.82"}
    assert all("Call-ID" in p for p in payloads)

    # Filename: NO _internal suffix on the edge flavor.
    cd = r.headers["content-disposition"]
    assert cd.startswith('attachment; filename="sip_')
    assert "_internal" not in cd
    assert cd.endswith('.pcap"')


@needs_web
def test_pcap_internal_true_full_capture_and_suffix(api, monkeypatch):
    r, _mock = _export(api, monkeypatch,
                       ch_rows={A_LEG: _aleg_rows()},
                       call_id=A_LEG, internal="true", correlated="false")
    assert r.status_code == 200, r.text
    _payload_list, pkts = _payloads(r.content)
    assert len(pkts) == 4           # every hop, every capture point
    # SBC-1/FreeSWITCH hops present (rendered via their public faces).
    ips = {p["src_ip"] for p in pkts} | {p["dst_ip"] for p in pkts}
    assert "34.74.71.32" in ips and "34.139.119.135" in ips
    # Ordered by timestamp_ns.
    times = [(p["ts_sec"], p["ts_usec"]) for p in pkts]
    assert times == sorted(times)
    # Filename says which flavor a human is holding.
    assert "_internal.pcap" in r.headers["content-disposition"]


@needs_web
def test_pcap_filename_sanitization(api, monkeypatch):
    weird = "we ird/call:id<>@host"
    r, _mock = _export(
        api, monkeypatch,
        ch_rows={weird: [_ch_row(weird, BASE_NS, "BW-ATL", "SBC-VIP",
                                 _sipmsg(weird))]},
        call_id=weird, correlated="false")
    assert r.status_code == 200, r.text
    cd = r.headers["content-disposition"]
    assert cd == 'attachment; filename="sip_we_ird_call_id__@host.pcap"'


# ---- 404s: no packets at all / nothing left after edge filtering -----------

@needs_web
def test_pcap_404_when_no_packets_at_all(api, monkeypatch):
    r, _mock = _export(api, monkeypatch, call_id="ghost@nowhere")
    assert r.status_code == 404, r.text
    assert "ghost@nowhere" in r.json()["detail"]
    assert "no captured" in r.json()["detail"]


@needs_web
def test_pcap_404_onnet_detail_when_edge_filter_empties(api, monkeypatch):
    # An on-net call: every stored packet is internal (SBC<->FS, FS<->FS).
    onnet = "onnet-call-1@fs"
    rows = [
        _ch_row(onnet, BASE_NS, "SBC-1", "FreeSWITCH", _sipmsg(onnet)),
        _ch_row(onnet, BASE_NS + 1, "FreeSWITCH", "FreeSWITCH-2",
                _sipmsg(onnet), node="200"),
    ]
    r, _mock = _export(api, monkeypatch, ch_rows={onnet: rows},
                       call_id=onnet, correlated="false")
    assert r.status_code == 404, r.text
    detail = r.json()["detail"]
    assert "on-net" in detail and "internal=true" in detail

    # ...and the SAME call exports fine with internal=true (not an
    # empty-but-valid pcap situation).
    r2, _m = _export(api, monkeypatch, ch_rows={onnet: rows},
                     call_id=onnet, internal="true", correlated="false")
    assert r2.status_code == 200, r2.text
    _p, pkts = _payloads(r2.content)
    assert len(pkts) == 2


# ---- correlated legs (REUSED X-CID machinery) ------------------------------

@needs_web
def test_pcap_correlated_default_pulls_b_leg(api, monkeypatch):
    # correlated defaults TRUE: A-leg requested, the qryn X-CID scan finds
    # the B-leg, and the ClickHouse refetch returns both legs' packets.
    r, mock = _export(
        api, monkeypatch,
        ch_rows={A_LEG: _aleg_rows(), B_LEG: _bleg_rows()},
        loki_json=_loki_xcid_hit(),
        call_id=A_LEG, internal="true")
    assert r.status_code == 200, r.text
    payloads, pkts = _payloads(r.content)
    assert len(pkts) == 6           # 4 A-leg + 2 B-leg
    assert any(f"Call-ID: {B_LEG}" in p for p in payloads)
    # Upstream sequence: CH primary fetch, qryn X-CID scan, CH refetch.
    kinds = ["loki" if "loki" in q.url.path else "ch" for q in mock.requests]
    assert kinds == ["ch", "loki", "ch"]
    # The refetch's IN clause carries BOTH Call-IDs.
    refetch_sql = mock.requests[2].content.decode()
    assert A_LEG in refetch_sql and B_LEG in refetch_sql


@needs_web
def test_pcap_correlated_edge_flavor_includes_b_leg_edge_packets(api,
                                                                monkeypatch):
    # Edge flavor of a correlated export: EACH end of the call contributes
    # its own edge leg (A: BW-ATL<->VIP, B: VIP<->BW-DAL); all internal
    # hops of both legs are absent.
    r, _mock = _export(
        api, monkeypatch,
        ch_rows={A_LEG: _aleg_rows(), B_LEG: _bleg_rows()},
        loki_json=_loki_xcid_hit(),
        call_id=A_LEG)
    assert r.status_code == 200, r.text
    _payload_list, pkts = _payloads(r.content)
    assert len(pkts) == 3           # 2 A-leg edge + 1 B-leg edge
    ips = {p["src_ip"] for p in pkts} | {p["dst_ip"] for p in pkts}
    assert ips == {"67.231.13.185", "34.24.133.82", "67.231.2.12"}


@needs_web
def test_pcap_correlated_from_b_leg_side(api, monkeypatch):
    # Requesting the B-LEG Call-ID: its own packets carry X-CID: <a-leg>,
    # so the A-leg is discovered even with an EMPTY qryn scan result.
    r, _mock = _export(
        api, monkeypatch,
        ch_rows={A_LEG: _aleg_rows(), B_LEG: _bleg_rows()},
        call_id=B_LEG, internal="true")
    assert r.status_code == 200, r.text
    payloads, pkts = _payloads(r.content)
    assert len(pkts) == 6
    assert any(f"Call-ID: {A_LEG}" in p for p in payloads)


@needs_web
def test_pcap_correlated_false_exports_single_leg(api, monkeypatch):
    r, mock = _export(
        api, monkeypatch,
        ch_rows={A_LEG: _aleg_rows(), B_LEG: _bleg_rows()},
        loki_json=_loki_xcid_hit(),
        call_id=A_LEG, internal="true", correlated="false")
    assert r.status_code == 200, r.text
    payloads, pkts = _payloads(r.content)
    assert len(pkts) == 4
    assert not any(f"Call-ID: {B_LEG}" in p for p in payloads)
    # correlated=false must not touch qryn at all.
    assert all("loki" not in q.url.path for q in mock.requests)
    assert len(mock.requests) == 1


# ---- packet cap ------------------------------------------------------------

@needs_web
def test_pcap_413_over_cap(api, monkeypatch):
    big = "big-call@host"
    rows = [
        _ch_row(big, BASE_NS + i, "BW-ATL", "SBC-VIP", _sipmsg(big))
        for i in range(2001)
    ]
    r, _mock = _export(api, monkeypatch, ch_rows={big: rows},
                       call_id=big, correlated="false")
    assert r.status_code == 413, r.text
    assert "2000" in r.json()["detail"]


@needs_web
def test_pcap_413_over_cap_via_correlation_suggests_single_leg(api,
                                                               monkeypatch):
    # Each leg fits, the correlated union does not: 413 tells the engineer
    # the correlated=false escape hatch.
    rows_a = [_ch_row(A_LEG, BASE_NS + i, "BW-ATL", "SBC-VIP", _sipmsg(A_LEG))
              for i in range(1500)]
    rows_b = [_ch_row(B_LEG, BASE_NS + i, "SBC-VIP", "BW-DAL",
                      _sipmsg(B_LEG, xcid=A_LEG)) for i in range(1500)]
    r, _mock = _export(
        api, monkeypatch, ch_rows={A_LEG: rows_a, B_LEG: rows_b},
        loki_json=_loki_xcid_hit(), call_id=A_LEG)
    assert r.status_code == 413, r.text
    assert "correlated=false" in r.json()["detail"]


# ---- X-Pcap-Skipped --------------------------------------------------------

@needs_web
def test_pcap_skipped_header_counts_ipv6(api, monkeypatch):
    cid = "v6-mix@host"
    rows = [
        _ch_row(cid, BASE_NS, "BW-ATL", "SBC-VIP", _sipmsg(cid)),
        _ch_row(cid, BASE_NS + 1, "2001:db8::1", "SBC-VIP", _sipmsg(cid)),
    ]
    r, _mock = _export(api, monkeypatch, ch_rows={cid: rows},
                       call_id=cid, internal="true", correlated="false")
    assert r.status_code == 200, r.text
    assert r.headers["x-pcap-skipped"] == "1"
    _p, pkts = _payloads(r.content)
    assert len(pkts) == 1


@needs_web
def test_pcap_404_when_every_packet_unrepresentable(api, monkeypatch):
    # Never an empty-but-valid pcap: all rows IPv6 -> 404, not a bare header.
    cid = "v6-only@host"
    rows = [_ch_row(cid, BASE_NS, "2001:db8::1", "2001:db8::2", _sipmsg(cid))]
    r, _mock = _export(api, monkeypatch, ch_rows={cid: rows},
                       call_id=cid, internal="true", correlated="false")
    assert r.status_code == 404, r.text


# ---------------------------------------------------------------------------
# Plain runner for the pure layer (no pytest required)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import traceback

    failures = 0
    checks = [
        lambda: hpc.HEP_IP_ALIASES == _parse_lua_aliases(),
        lambda: hpc.is_edge_packet("BW-ATL", "SBC-VIP"),
        lambda: not hpc.is_edge_packet("SBC-1", "FreeSWITCH"),
        lambda: hpc.build_pcap(
            [_row("c", 10**18, "BW-DAL", "SBC-VIP", "X\r\n\r\n")])[1] == 1,
    ]
    for fn in checks:
        try:
            assert fn()
            print("PASS")
        except Exception:
            failures += 1
            traceback.print_exc()
    sys.exit(1 if failures else 0)
