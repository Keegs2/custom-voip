"""Pure helpers for GET /v1/homer/pcap — edge/internal classification + PCAP synthesis.

This module is STDLIB-ONLY by design (like homer_pipeline.py): the unit tests
(tests/test_homer_pcap_export.py) load it by file path and exercise the
classification truth table and the pcap byte format without fastapi/httpx/auth
installed.  routers/homer.py imports it for the /pcap endpoint.

WHY A MIRRORED ALIAS MAP EXISTS HERE
------------------------------------
heplify-server runs docker/homer/scripts/ip-alias.lua at HEP ingest and
REWRITES the src_ip/dst_ip Loki labels from raw IPs to friendly node names
("SBC-1", "FreeSWITCH", "BW-DAL", ...).  By the time a packet is stored in
ClickHouse the on-wire IP is GONE — only the name (or, for unknown sources
like customer PBXes, the raw pass-through IP) survives.  To classify packets
and to synthesize IPv4 headers for the pcap we need the name→IP direction
back, so ``HEP_IP_ALIASES`` below mirrors the Lua ``aliases`` table ENTRY FOR
ENTRY, IN FILE ORDER.

DRIFT PROTECTION (the runtime cannot parse the Lua file — it is not shipped
inside the API container image, which only copies docker/api/src):
  * tests/test_homer_pcap_export.py parses docker/homer/scripts/ip-alias.lua
    with a regex and asserts the parsed table is EXACTLY equal to
    HEP_IP_ALIASES — any lua edit without a matching edit here fails CI.
  * A second guard asserts every alias NAME is classifiable (carrier prefix
    or platform pattern) so a brand-new carrier family (e.g. "Telnyx-...")
    cannot be silently mis-bucketed as platform: adding it to the lua breaks
    the test until CARRIER_NAME_PREFIXES (or the platform pattern) is
    consciously extended.

EDGE / INTERNAL CLASSIFICATION (the privacy core)
-------------------------------------------------
An endpoint label is EXTERNAL when it is:
  (a) a carrier node — any alias entry whose name starts with a
      CARRIER_NAME_PREFIXES prefix (derived FROM the alias map, so new
      BW-*/Sinch-* PoPs inherit automatically), or a raw IP in the carrier
      IP set; or
  (b) a public (globally routable) IP that is NOT in the platform set
      (= customer PBX / unknown outside party).
PLATFORM = every non-carrier alias-map entry (name or IP) + RFC1918 +
loopback + link-local (169.254/16) + any other non-global address.

A packet is EDGE iff AT LEAST ONE endpoint is EXTERNAL.

Truth table (implemented by is_edge_packet, pinned by tests):
    carrier          <-> NLB VIP              = EDGE
    carrier          <-> SBC public IP        = EDGE
    PBX (unk public) <-> NLB VIP              = EDGE
    PBX (unk public) <-> platform PRIVATE IP  = EDGE  (external party present;
                         shouldn't occur on the wire, but classify edge)
    unk public       <-> unk public           = EDGE  (neither end is ours ->
                         the packet contains no internal topology to protect)
    SBC              <-> FreeSWITCH           = INTERNAL
    FreeSWITCH       <-> FreeSWITCH-2         = INTERNAL
    SBC              <-> SBC / SigVIP         = INTERNAL
    unknown NAME     <-> anything platform    = INTERNAL (fail-CLOSED: a name
                         we cannot classify is one WE aliased at ingest, i.e.
                         one of our nodes or a not-yet-classified carrier —
                         excluding it from shareable edge exports is the safe
                         privacy default; the drift test makes this state
                         short-lived)

PCAP SYNTHESIS
--------------
Classic libpcap format, no dependencies: global header (magic 0xa1b2c3d4,
v2.4, linktype 1 = Ethernet), then per packet a record header (ts from
timestamp_ns) + fabricated Ethernet (zero MACs, ethertype 0x0800) + IPv4
(computed header checksum — Wireshark flags bad ones; TTL 64; proto 17) +
UDP (ports from labels, checksum 0 = legal for IPv4) + the raw SIP text.
Endpoints that resolve to an IPv6 address (or oversized payloads) are
SKIPPED and counted (surfaced via the X-Pcap-Skipped response header) rather
than failing the export.  A NAME with no known IP (drifted alias) renders as
0.0.0.0 — classic pcap has no comment blocks, so this is the documented
sentinel for "node known at ingest, IP unknown at export".
"""
import ipaddress
import struct
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Alias map — MIRRORS docker/homer/scripts/ip-alias.lua (entry order preserved)
# ---------------------------------------------------------------------------
# DO NOT edit this without editing the lua (or vice versa):
# tests/test_homer_pcap_export.py asserts byte-for-byte agreement.
HEP_IP_ALIASES: dict[str, str] = {
    # Bandwidth origination (inbound to us)
    "67.231.13.185": "BW-ATL",
    "67.231.9.142": "BW-NY",
    # Bandwidth termination (outbound from us)
    "67.231.2.12": "BW-DAL",
    "216.82.238.134": "BW-LA",
    "67.231.1.188": "BW-TC2-DAL",
    "67.231.4.138": "BW-TC2-LA",
    # Sinch origination (inbound to us)
    "206.146.100.24": "Sinch-Denver",
    "206.146.101.39": "Sinch-Chicago",
    # Sinch termination (outbound from us)
    "206.146.98.26": "Sinch-Atlanta-LD",
    "206.146.100.26": "Sinch-Denver-TF",
    # ── EAST ZONE ──
    "34.24.133.82": "SBC-VIP",
    "10.142.0.250": "SBC-SigVIP",
    "10.142.0.100": "SBC-1",
    "34.74.71.32": "SBC-1",
    "10.142.0.101": "SBC-2",
    "35.243.136.35": "SBC-2",
    "192.168.10.2": "FreeSWITCH",
    "34.139.119.135": "FreeSWITCH",
    "192.168.10.3": "FreeSWITCH-2",
    "35.196.226.123": "FreeSWITCH-2",
    "10.142.0.103": "Services",
    # ── WEST ZONE ──
    "35.252.214.40": "West-SBC-VIP",
    "10.138.0.250": "West-SBC-SigVIP",
    "10.138.0.100": "West-SBC-1",
    "8.229.41.59": "West-SBC-1",
    "10.138.0.101": "West-SBC-2",
    "136.117.230.166": "West-SBC-2",
    "192.168.20.2": "West-FreeSWITCH",
    "8.229.177.165": "West-FreeSWITCH",
    "192.168.20.3": "West-FreeSWITCH-2",
    "35.197.95.171": "West-FreeSWITCH-2",
    "10.138.0.2": "West-Services",
    "10.138.0.103": "West-Services",
    # ── CENTRAL ZONE ──
    "35.253.133.230": "Central-SBC-VIP",
    "10.128.0.250": "Central-SBC-SigVIP",
    "10.128.0.100": "Central-SBC-1",
    "34.41.188.100": "Central-SBC-1",
    "10.128.0.101": "Central-SBC-2",
    "35.184.151.64": "Central-SBC-2",
    "192.168.30.2": "Central-FreeSWITCH",
    "35.253.103.114": "Central-FreeSWITCH",
    "192.168.30.3": "Central-FreeSWITCH-2",
    "34.63.100.161": "Central-FreeSWITCH-2",
    "10.128.0.2": "Central-Services",
}

# Carrier families, derived from the lua comment grouping ("Bandwidth ...",
# "Sinch ...").  Every alias name starting with one of these prefixes is a
# carrier node — new PoPs of an existing carrier inherit automatically.  A
# brand-new carrier family must be added HERE (the alias-name drift test
# fails loudly until it is).
CARRIER_NAME_PREFIXES: tuple[str, ...] = ("BW-", "Sinch-")

CARRIER_IPS: frozenset[str] = frozenset(
    ip for ip, name in HEP_IP_ALIASES.items()
    if name.startswith(CARRIER_NAME_PREFIXES)
)
# Platform = every non-carrier alias-map IP (RFC1918/loopback/link-local are
# handled by ipaddress properties in is_external_endpoint).
PLATFORM_IPS: frozenset[str] = frozenset(HEP_IP_ALIASES) - CARRIER_IPS

# name -> ONE representative IP for IPv4 header synthesis.  Where the alias
# collapses several interfaces into one name (e.g. "SBC-1" = VPC 10.142.0.100
# + public 34.74.71.32) we prefer the PUBLIC (globally routable) interface:
# edge exports — the shareable flavor — then show only the node's public face
# (which is what the outside party actually saw on the wire), never a private
# VPC address.  Internal exports pay a cosmetic price (collapsed nodes render
# with their public IP on private-leg packets) which is acceptable: the IP is
# a stable node identity, not wire truth — the wire IP was destroyed at
# ingest by the alias rewrite.
NAME_TO_IP: dict[str, str] = {}
for _ip, _name in HEP_IP_ALIASES.items():
    _current = NAME_TO_IP.get(_name)
    if _current is None:
        NAME_TO_IP[_name] = _ip
    else:
        try:
            if (not ipaddress.ip_address(_current).is_global
                    and ipaddress.ip_address(_ip).is_global):
                NAME_TO_IP[_name] = _ip
        except ValueError:  # pragma: no cover - map contains only valid IPs
            pass


# ---------------------------------------------------------------------------
# Endpoint classification
# ---------------------------------------------------------------------------

def _parse_ip(label: str) -> Optional[ipaddress._BaseAddress]:
    """Parse a src_ip/dst_ip label as an IP address, or None (it's a name)."""
    try:
        return ipaddress.ip_address(label)
    except ValueError:
        return None


def is_external_endpoint(label: str) -> bool:
    """True when the label denotes a party OUTSIDE the platform.

    Labels arrive either as alias NAMES (ip-alias.lua rewrote them at ingest)
    or as raw IPs (unknown sources pass through unchanged).  See the module
    docstring for the full classification contract + truth table.
    """
    if label in NAME_TO_IP:
        # Aliased node: carrier families are external, everything else in the
        # map is our own infrastructure.
        return label.startswith(CARRIER_NAME_PREFIXES)
    ip = _parse_ip(label)
    if ip is None:
        # A name we did not alias cannot exist (heplify only writes names
        # FROM the lua map) — unless this mirror has drifted.  Fail CLOSED
        # for privacy: treat as platform so it never leaks into edge exports.
        return False
    ip_str = str(ip)
    if ip_str in CARRIER_IPS:
        return True
    if ip_str in PLATFORM_IPS:
        return False
    # Unknown IP: public (globally routable) = outside party (customer PBX);
    # anything else (RFC1918, loopback, 169.254/16, ...) = inside our network.
    return ip.is_global


def is_edge_packet(src_label: str, dst_label: str) -> bool:
    """EDGE iff at least one endpoint is external (see truth table above)."""
    return is_external_endpoint(src_label) or is_external_endpoint(dst_label)


def resolve_ip(label: str) -> str:
    """Resolve a label to the IP written into the synthesized IPv4 header.

    Alias name -> its representative IP (public interface preferred); raw
    IP -> itself; unrecognized name (drifted alias) -> the documented
    "0.0.0.0" sentinel.
    """
    known = NAME_TO_IP.get(label)
    if known is not None:
        return known
    ip = _parse_ip(label)
    if ip is not None:
        return str(ip)
    return "0.0.0.0"


# ---------------------------------------------------------------------------
# PCAP synthesis (classic libpcap, linktype 1 Ethernet)
# ---------------------------------------------------------------------------

# Global header: magic, major 2, minor 4, thiszone 0, sigfigs 0,
# snaplen 65535, network 1 (LINKTYPE_ETHERNET).  Little-endian file.
PCAP_GLOBAL_HEADER = struct.pack("<IHHiIII", 0xA1B2C3D4, 2, 4, 0, 0, 65535, 1)

_ETH_HEADER = b"\x00" * 12 + b"\x08\x00"  # zero MACs, ethertype IPv4
_MAX_UDP_PAYLOAD = 65535 - 20 - 8         # IPv4 total_length is 16-bit


def _ipv4_checksum(header: bytes) -> int:
    """Standard RFC 1071 ones-complement sum over the IPv4 header."""
    total = 0
    for i in range(0, len(header), 2):
        total += (header[i] << 8) | header[i + 1]
    total = (total >> 16) + (total & 0xFFFF)
    total += total >> 16
    return ~total & 0xFFFF


def _sane_port(value: Any) -> int:
    """Parse a src_port/dst_port label; default 5060 (keeps Wireshark's SIP
    dissector engaged) when the label is absent/garbage."""
    try:
        port = int(value)
    except (TypeError, ValueError):
        return 5060
    return port if 0 <= port <= 65535 else 5060


def build_packet(
    src_ip: str, dst_ip: str, src_port: int, dst_port: int,
    payload: bytes, ts_ns: int,
) -> Optional[bytes]:
    """One pcap record (header + Ethernet + IPv4 + UDP + payload).

    Returns None when the packet cannot be represented (IPv6 endpoint or
    payload too large for a single IPv4 datagram) — callers count these.
    """
    try:
        src = ipaddress.ip_address(src_ip)
        dst = ipaddress.ip_address(dst_ip)
    except ValueError:
        return None
    if src.version != 4 or dst.version != 4:
        return None
    if len(payload) > _MAX_UDP_PAYLOAD:
        return None

    udp_len = 8 + len(payload)
    total_len = 20 + udp_len
    ip_header = struct.pack(
        "!BBHHHBBH4s4s",
        0x45, 0, total_len,      # version/IHL, TOS, total length
        0, 0,                    # identification, flags/fragment offset
        64, 17, 0,               # TTL, protocol UDP, checksum placeholder
        src.packed, dst.packed,
    )
    checksum = _ipv4_checksum(ip_header)
    ip_header = ip_header[:10] + struct.pack("!H", checksum) + ip_header[12:]

    # UDP checksum 0 = "not computed", legal for UDP over IPv4 (RFC 768).
    udp_header = struct.pack("!HHHH", src_port, dst_port, udp_len, 0)

    frame = _ETH_HEADER + ip_header + udp_header + payload
    ts_sec, rem_ns = divmod(max(int(ts_ns), 0), 1_000_000_000)
    record_header = struct.pack(
        "<IIII", ts_sec, rem_ns // 1000, len(frame), len(frame),
    )
    return record_header + frame


def build_pcap(rows: list[dict[str, Any]]) -> tuple[bytes, int, int]:
    """Synthesize a classic pcap from stored SIP rows.

    Each row needs: src_ip, dst_ip (label: alias name or raw IP), src_port,
    dst_port, timestamp_ns, raw_msg.  Rows are emitted in the given order —
    callers sort by timestamp_ns first.

    Returns (pcap_bytes, packet_count, skipped_count).  skipped counts rows
    that could not be represented (IPv6 endpoint / oversized payload).
    """
    out = [PCAP_GLOBAL_HEADER]
    packets = 0
    skipped = 0
    for row in rows:
        payload = (row.get("raw_msg") or "").encode("utf-8", "replace")
        record = build_packet(
            resolve_ip(str(row.get("src_ip") or "")),
            resolve_ip(str(row.get("dst_ip") or "")),
            _sane_port(row.get("src_port")),
            _sane_port(row.get("dst_port")),
            payload,
            int(row.get("timestamp_ns") or 0),
        )
        if record is None:
            skipped += 1
            continue
        out.append(record)
        packets += 1
    return b"".join(out), packets, skipped
