#!/usr/bin/python3 -I
"""vz-healthd — Verizon IPsec gateway health endpoint (plan §3.5).

Installed to /usr/local/sbin/vz-healthd.py, run by vz-healthd.service with /etc/vz-ipsec/vz-gateway.env as environment.

GET /healthz on 0.0.0.0:8081 -> 200 only when ALL of these hold, else 503 with a JSON body naming the failed checks:
  sa_up        `swanctl --list-sas --raw` shows a CHILD_SA named `vz` in state INSTALLED
  xfrm_up      interface xfrm-vz is UP with mtu 1400
  route_ok     `ip route get <first Verizon prefix>` resolves via xfrm-vz
  nft_ok       `nft list table ip vz` succeeds (the stateless NAT table is loaded)
  nostates_ok  /proc/net/xfrm_stat XfrmOutNoStates delta over the last 30 s == 0 (no black-holed outbound packets)
  not_drained  the drain file (VZ_DRAIN_FILE, default /run/vz-drain) is absent

Deliberately NOT a check (§3.5): "inbound ESP bytes increasing" — Verizon will likely send only on its preferred tunnel.

The same booleans are written every cycle to the node_exporter textfile
  /var/lib/node_exporter/textfile_collector/vz_ipsec.prom
as vz_ipsec_sa_up{zone,gw}, vz_ipsec_xfrm_up, vz_ipsec_route_ok, vz_ipsec_nft_ok, vz_ipsec_nostates_ok,
vz_ipsec_drained, vz_ipsec_healthy (plus the raw XfrmOutNoStates counter and a heartbeat timestamp).

Design: a sampler thread evaluates everything every 2 s and keeps the latest result; HTTP requests serve that result
(<= 2 s stale, well inside the ILB's 5 s probe interval) so three probers never fork 4 subprocesses each per probe.
Stdlib only — nothing to install. Python 3.11 on Debian 12.
"""
import json
import os
import re
import subprocess
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ZONE = os.environ.get("VZ_ZONE", "unknown")
GW = os.environ.get("VZ_GW", "unknown")
PREFIXES = [p.strip() for p in os.environ.get("VZ_PREFIXES", "").split(",") if p.strip()]
DRAIN_FILE = os.environ.get("VZ_DRAIN_FILE", "/run/vz-drain")
PORT = int(os.environ.get("VZ_HEALTH_PORT", "8081"))
TEXTFILE = os.environ.get("VZ_TEXTFILE", "/var/lib/node_exporter/textfile_collector/vz_ipsec.prom")
IFACE = "xfrm-vz"
MTU = 1400
CONN = "vz"
XFRM_STAT = os.environ.get("VZ_XFRM_STAT", "/proc/net/xfrm_stat")   # overridable only for local tests
WINDOW_S = 30.0      # §3.5: XfrmOutNoStates delta window
INTERVAL_S = 2.0     # sampler period
CMD_TIMEOUT_S = 5.0

CHECKS = ("sa_up", "xfrm_up", "route_ok", "nft_ok", "nostates_ok", "not_drained")


def run(cmd):
    """Run a command; return (rc, stdout). Never raises — a missing binary is just a failed check."""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=CMD_TIMEOUT_S, check=False)
        return p.returncode, p.stdout
    except (OSError, subprocess.SubprocessError):
        return 127, ""


# Child-SA entries in `swanctl --list-sas --raw` look like:  ... name = vz  uniqueid = 3  reqid = 1  state = INSTALLED ...
# The tempered pattern stays inside ONE child entry (it refuses to cross the next `name =`).
_CHILD_RE = re.compile(r"name = (?P<name>\S+)(?:(?!name = ).)*?state = (?P<state>[A-Z_]+)", re.S)
_ENCAP_RE = re.compile(r"\bencap = yes\b")
_NATLOCAL_RE = re.compile(r"\bnat-(?:local|remote|any) = yes\b")


def check_sa():
    rc, out = run(["swanctl", "--list-sas", "--raw"])
    if rc != 0:
        return False, {"error": "swanctl --list-sas failed (charon down?)"}
    installed = any(m.group("name") == CONN and m.group("state") == "INSTALLED" for m in _CHILD_RE.finditer(out))
    info = {
        "ike_established": "ESTABLISHED" in out,
        # Informational only (§11 Phase 0 remaining check): these must stay False — NAT-T would eat the §3.4 MTU margin.
        "udp_encap": bool(_ENCAP_RE.search(out)),
        "nat_detected": bool(_NATLOCAL_RE.search(out)),
    }
    return installed, info


_MTU_RE = re.compile(r"\bmtu (\d+)\b")
_FLAGS_RE = re.compile(r"<([^>]*)>")


def check_xfrm():
    rc, out = run(["ip", "-o", "link", "show", IFACE])
    if rc != 0:
        return False, {"error": f"{IFACE} does not exist"}
    mtu = int(_MTU_RE.search(out).group(1)) if _MTU_RE.search(out) else 0
    flags = _FLAGS_RE.search(out).group(1).split(",") if _FLAGS_RE.search(out) else []
    up = "UP" in flags
    return (up and mtu == MTU), {"up": up, "mtu": mtu}


def _network_addr(prefix):
    """198.18.0.0/24 -> 198.18.0.0 ; a bare host stays as is."""
    return prefix.split("/", 1)[0]


def check_route():
    if not PREFIXES:
        return False, {"error": "VZ_PREFIXES is empty/placeholder (pre-Verizon)"}
    target = _network_addr(PREFIXES[0])
    rc, out = run(["ip", "-o", "route", "get", target])
    if rc != 0:
        return False, {"error": f"ip route get {target} failed", "prefix": PREFIXES[0]}
    via_xfrm = f" dev {IFACE} " in f" {out} "
    return via_xfrm, {"prefix": PREFIXES[0], "route": " ".join(out.split())}


def check_nft():
    rc, _ = run(["nft", "list", "table", "ip", "vz"])
    return rc == 0, {}


def read_out_no_states():
    """XfrmOutNoStates from /proc/net/xfrm_stat (counter), or None if unreadable."""
    try:
        with open(XFRM_STAT, encoding="ascii") as f:
            for line in f:
                parts = line.split()
                if len(parts) == 2 and parts[0] == "XfrmOutNoStates":
                    return int(parts[1])
    except OSError:
        return None
    return None


class Sampler(threading.Thread):
    def __init__(self):
        super().__init__(name="vz-sampler", daemon=True)
        self.lock = threading.Lock()
        self.result = {"healthy": False, "failed": list(CHECKS), "checks": {}, "ts": 0, "note": "starting"}
        self.history = deque()   # (monotonic_ts, XfrmOutNoStates)
        self.last_healthy = None

    def nostates(self):
        now = time.monotonic()
        val = read_out_no_states()
        if val is not None:
            self.history.append((now, val))
        while self.history and now - self.history[0][0] > WINDOW_S:
            self.history.popleft()
        if val is None:
            return False, {"error": "/proc/net/xfrm_stat unreadable"}
        oldest = self.history[0][1]
        delta = val - oldest
        window = round(now - self.history[0][0], 1)
        return delta == 0, {"counter": val, "delta_30s": delta, "window_s": window}

    def sample(self):
        checks = {}
        for name, fn in (("sa_up", check_sa), ("xfrm_up", check_xfrm), ("route_ok", check_route),
                         ("nft_ok", check_nft), ("nostates_ok", self.nostates)):
            ok, info = fn()
            checks[name] = {"ok": bool(ok), **info}
        drained = os.path.exists(DRAIN_FILE)
        checks["not_drained"] = {"ok": not drained, "drain_file": DRAIN_FILE}
        failed = [c for c in CHECKS if not checks[c]["ok"]]
        healthy = not failed
        result = {"healthy": healthy, "failed": failed, "checks": checks,
                  "zone": ZONE, "gw": GW, "ts": int(time.time())}
        if healthy != self.last_healthy:
            print(f"vz-healthd: {'HEALTHY' if healthy else 'UNHEALTHY ' + ','.join(failed)}", flush=True)
            self.last_healthy = healthy
        with self.lock:
            self.result = result
        write_textfile(result, drained)

    def run(self):
        while True:
            try:
                self.sample()
            except Exception as e:  # noqa: BLE001 — the sampler must never die
                print(f"vz-healthd: sampler error: {e!r}", file=sys.stderr, flush=True)
            time.sleep(INTERVAL_S)

    def current(self):
        with self.lock:
            return self.result


def write_textfile(result, drained):
    """Atomic write of the node_exporter textfile (tmp + rename). Missing directory = metrics silently off, HC unaffected."""
    labels = f'zone="{ZONE}",gw="{GW}"'
    c = result["checks"]
    lines = []

    def gauge(name, help_, value):
        lines.append(f"# HELP {name} {help_}")
        lines.append(f"# TYPE {name} gauge")
        lines.append(f"{name}{{{labels}}} {value}")

    gauge("vz_ipsec_sa_up", "CHILD_SA vz INSTALLED (swanctl)", int(c["sa_up"]["ok"]))
    gauge("vz_ipsec_xfrm_up", "xfrm-vz UP with mtu 1400", int(c["xfrm_up"]["ok"]))
    gauge("vz_ipsec_route_ok", "first Verizon prefix routes via xfrm-vz", int(c["route_ok"]["ok"]))
    gauge("vz_ipsec_nft_ok", "nft table ip vz loaded", int(c["nft_ok"]["ok"]))
    gauge("vz_ipsec_nostates_ok", "XfrmOutNoStates delta over 30s == 0", int(c["nostates_ok"]["ok"]))
    gauge("vz_ipsec_drained", "drain file present (deliberate failover)", int(drained))
    gauge("vz_ipsec_healthy", "all plan 3.5 checks pass (what the ILB health check sees)", int(result["healthy"]))
    gauge("vz_ipsec_udp_encap", "SA negotiated UDP encapsulation (must be 0, plan 3.4)", int(c["sa_up"].get("udp_encap", False)))
    counter = c["nostates_ok"].get("counter")
    if counter is not None:
        lines.append("# HELP vz_ipsec_xfrm_out_no_states_total raw XfrmOutNoStates from /proc/net/xfrm_stat")
        lines.append("# TYPE vz_ipsec_xfrm_out_no_states_total counter")
        lines.append(f"vz_ipsec_xfrm_out_no_states_total{{{labels}}} {counter}")
    gauge("vz_ipsec_healthd_timestamp_seconds", "last sampler run (unix time)", result["ts"])
    body = "\n".join(lines) + "\n"
    tmp = TEXTFILE + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(body)
        os.chmod(tmp, 0o644)
        os.replace(tmp, TEXTFILE)
    except OSError:
        pass


SAMPLER = Sampler()


class Handler(BaseHTTPRequestHandler):
    server_version = "vz-healthd/1"

    def do_GET(self):  # noqa: N802 — http.server API
        if self.path not in ("/healthz", "/healthz/", "/"):
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        result = SAMPLER.current()
        body = json.dumps(result, separators=(",", ":")).encode()
        self.send_response(200 if result["healthy"] else 503)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):  # noqa: A002 — silence per-probe access logging (3 probers x 5 s)
        return


def main():
    SAMPLER.start()
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)   # 0.0.0.0: probes arrive on the ILB address (local on lo), ops curl the NIC IP
    srv.daemon_threads = True
    print(f"vz-healthd: zone={ZONE} gw={GW} listening on 0.0.0.0:{PORT} prefixes={PREFIXES or 'NONE (pre-Verizon)'} drain={DRAIN_FILE}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
