#!/usr/bin/env python3
"""
fsdisp_metrics.py — FS-dispatcher maintenance-state Prometheus exporter (:9104).

Runs INSIDE the carrier-monitor / ops-agent sidecar, SBC role only. It exposes
the SAME ground truth the FS drain tooling verifies against — the admin state of
every dispatcher GROUP 1 (FreeSWITCH) destination in the co-located Kamailio —
so Grafana's "FS drained" panel can never drift from what the SBC actually
routes on.

WHAT IT DOES (push model — NO poll loop of its own)
---------------------------------------------------
The EXISTING carrier poller (carrier_monitor.py) already runs
`kamcmd dispatcher.list` on every heartbeat/transition tick. This module adds
ZERO kamcmd invocations: the poller hands us the group-1 destinations it parsed
out of that same reply (update_from_destinations), we render a Prometheus text
exposition and CACHE it, and a tiny GET-only ThreadingHTTPServer on :9104
serves the cached string verbatim. The HTTP handler NEVER touches kamcmd — a
scrape can never block on Kamailio, and a wedged Kamailio never stalls vmagent.
Same "serve last-good, never block the reader" contract as ops_metrics (:9103).

EMITTED METRICS (names/labels PINNED by the Grafana metric contract — do NOT
rename; the NOC panels are written against these exact series)
------------------------------------------------------------------------------
  fs_dispatcher_disabled{fs_ip="<bare IP, e.g. 192.168.10.2>"}  gauge
      One series per dispatcher group-1 destination. Value 1 iff that
      destination's FLAGS first char == 'D' (admin-Disabled — i.e. MAINTENANCE,
      set via kamcmd ds_set_state d / the fs.drain agent verb), else 0.
      'I' (Inactive = probe-down/dead), 'T' (Trying) and 'A' (Active) all
      render 0 — Inactive is a FAILURE state, NOT maintenance, and the panels
      must be able to tell the two apart (probe-down alerting reads the
      dispatcher stats / carrier-monitor pipeline, not this gauge).
  fsdisp_scrape_ok  gauge (no labels)
      1 when the dispatcher.list parse succeeded this cycle (>= 1 group-1
      destination parsed), 0 on any failure (kamcmd error, parse error, or an
      implausible empty group 1). On failure the last-good per-destination
      series are RETAINED at their previous values — fail-open, mirroring
      freeswitch_esl_scrape_ok in ops_metrics.py.

zone / reporting_instance are stamped EXTERNALLY by the vmagent external_labels
(%{ZONE} / %{INSTANCE_ID} in scrape-sbc.yml) — deliberately NOT added here.

CARDINALITY: bounded by dispatcher.list group 1 — 1 destination per zone today,
2 in FS-HA-pair zones. Never a customer identifier.

FAIL-OPEN CONTRACT (mirrors carrier_monitor.py / ops_metrics.py)
----------------------------------------------------------------
Nothing in this module may ever raise into the carrier poller or kill a thread.
Before the first successful update the exporter serves a valid, parseable
exposition containing only `fsdisp_scrape_ok 0` (no per-destination series yet
— there is no last-good to retain). A bind failure on :9104 is logged loudly
and disables /metrics only; the poller and the command API keep running.
"""

import logging
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


LOG = logging.getLogger("ops-agent.fsdisp")


# --------------------------------------------------------------------------- #
# Configuration (all via env; sane defaults so a missing var never crashes).
# --------------------------------------------------------------------------- #

def _get_int(name: str, default: int, minimum: int = 1) -> int:
    """Parse an int env var, clamping to `minimum`, falling back on garbage."""
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        val = int(raw.strip())
    except (TypeError, ValueError):
        LOG.warning("Invalid %s=%r; using default %d", name, raw, default)
        return default
    return val if val >= minimum else minimum


# Bind config for the /metrics listener. 0.0.0.0 INSIDE the container; the SBC
# compose publishes it as 127.0.0.1:9104 on the host (the carrier-monitor
# service is bridge-networked, unlike the host-net FS-role agent), so only the
# co-located host-net vmagent can reach it. Port is FIXED at 9104 by the
# pinned metric contract (overridable only for odd deployments / tests —
# vmagent's scrape-sbc.yml targets 127.0.0.1:9104).
BIND_HOST = os.environ.get("OPS_FSDISP_BIND", "0.0.0.0").strip() or "0.0.0.0"
BIND_PORT = _get_int("OPS_FSDISP_PORT", 9104, minimum=1)


# --------------------------------------------------------------------------- #
# FLAGS -> maintenance mapping.
#
# Kamailio dispatcher FLAGS is a 2-letter code (1st = STATUS, 2nd = PROBING):
#   A=active  I=inactive(probe-down)  T=trying  D=disabled(ADMIN)
# ONLY 'D' is maintenance: it is the state `kamcmd dispatcher.set_state d ...`
# (the fs.drain verb) puts a destination in, it survives probe results, and it
# is what the drain tool verifies against. 'I' means the OPTIONS probes are
# failing — a dead/unreachable FS, which must NOT light the maintenance panel.
# --------------------------------------------------------------------------- #

def flags_to_disabled(flags: str) -> bool:
    """True iff the FLAGS first char is 'D' (admin-Disabled = maintenance).

    'I'/'T'/'A' (and anything unparseable) -> False. Case-insensitive on the
    status letter, tolerant of surrounding whitespace — same normalization as
    carrier_monitor.flags_to_is_up.
    """
    if not flags:
        return False
    stripped = flags.strip()
    if not stripped:
        return False
    return stripped[0].upper() == "D"


# --------------------------------------------------------------------------- #
# The cached sample + last-good state. Swapped atomically under one lock by the
# carrier poller's tick (push) and read by HTTP handler threads.
# --------------------------------------------------------------------------- #

_SAMPLE_LOCK = threading.Lock()
_CACHED_SAMPLE = ""      # set to a valid initial exposition by _init_sample()
# Last successfully-published [(fs_ip, disabled_bool)] — retained verbatim
# (values included) while scrape_ok is 0, per the fail-open contract.
_LAST_GOOD = []


def _render(dests, scrape_ok: bool) -> str:
    """Render the pinned metrics into a Prometheus text exposition string.

    `dests` is a list of (fs_ip, disabled_bool) tuples, already deduplicated
    and ordered (dispatcher.list order). Label values are bare IPs/hosts from
    SIP URIs — no quote/backslash/newline is possible after the URI parse, so
    no label escaping is needed (same posture as ops_metrics).
    """
    lines = []
    lines.append(
        "# HELP fs_dispatcher_disabled 1 iff this dispatcher group-1 "
        "(FreeSWITCH) destination is admin-Disabled (FLAGS 'D' = maintenance); "
        "Inactive/Trying/Active render 0."
    )
    lines.append("# TYPE fs_dispatcher_disabled gauge")
    for fs_ip, disabled in dests:
        lines.append(
            'fs_dispatcher_disabled{fs_ip="%s"} %d' % (fs_ip, 1 if disabled else 0)
        )
    lines.append(
        "# HELP fsdisp_scrape_ok 1 if the last dispatcher.list parse "
        "succeeded, 0 on failure (per-destination series are then last-good)."
    )
    lines.append("# TYPE fsdisp_scrape_ok gauge")
    lines.append("fsdisp_scrape_ok %d" % (1 if scrape_ok else 0))
    # Prometheus text format wants a trailing newline.
    return "\n".join(lines) + "\n"


def _init_sample():
    """Seed the cache with a valid exposition (scrape_ok=0, no per-destination
    series — there is no last-good yet) so a scrape BEFORE the first poller
    tick still returns 200 with parseable metrics."""
    global _CACHED_SAMPLE
    with _SAMPLE_LOCK:
        _CACHED_SAMPLE = _render(list(_LAST_GOOD), scrape_ok=False)


def update_from_destinations(fs_dests) -> bool:
    """
    Publish a fresh sample from the carrier poller's parsed dispatcher output.

    `fs_dests` is a list of {"fs_ip": <bare ip str>, "flags": <FLAGS str>}
    dicts for dispatcher GROUP 1 (see carrier_monitor.fs_destinations). An
    EMPTY list is treated as a parse failure (group 1 always exists on a live
    SBC — zero destinations means the reply was malformed/truncated), so the
    last-good series are retained and scrape_ok goes 0.

    Returns True when a fresh sample was published, False when it degraded to
    the failure path. NEVER raises (the caller is the carrier poller's tick).
    """
    global _CACHED_SAMPLE, _LAST_GOOD
    try:
        dests = []
        seen = set()
        for d in fs_dests or []:
            if not isinstance(d, dict):
                continue
            fs_ip = str(d.get("fs_ip") or "").strip()
            if not fs_ip or fs_ip in seen:
                # No parseable host, or a duplicate IP (duplicate series lines
                # would make the whole exposition unparseable to vmagent).
                continue
            seen.add(fs_ip)
            dests.append((fs_ip, flags_to_disabled(str(d.get("flags") or ""))))
        if not dests:
            mark_scrape_failed()
            return False
        sample = _render(dests, scrape_ok=True)
        with _SAMPLE_LOCK:
            _LAST_GOOD = dests
            _CACHED_SAMPLE = sample
        return True
    except Exception as exc:  # noqa: BLE001 - must never propagate into the poller
        LOG.error("fsdisp update failed (serving last-good, ok=0): %s", exc)
        try:
            mark_scrape_failed()
        except Exception:  # noqa: BLE001 - absolute last resort
            pass
        return False


def mark_scrape_failed():
    """Re-render the cache with scrape_ok=0 while RETAINING the last-good
    per-destination series at their previous values (fail-open contract).
    Never raises."""
    global _CACHED_SAMPLE
    try:
        with _SAMPLE_LOCK:
            _CACHED_SAMPLE = _render(list(_LAST_GOOD), scrape_ok=False)
    except Exception as exc:  # noqa: BLE001 - keep whatever cache we had
        LOG.error("fsdisp mark_scrape_failed could not re-render: %s", exc)


# --------------------------------------------------------------------------- #
# The /metrics HTTP listener. Serves the CACHED sample only — never runs kamcmd.
# Same handler shape as ops_metrics.MetricsHandler.
# --------------------------------------------------------------------------- #

# Prometheus text format 0.0.4 content type (what vmagent expects).
_METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"


class MetricsHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "revup-fsdisp-metrics/1"

    # Route access-log spam to DEBUG so it doesn't drown the poller's INFO lines.
    def log_message(self, fmt, *args):  # noqa: A003 - matches base signature
        LOG.debug("http %s - %s", self.address_string(), fmt % args)

    def _send(self, status: int, body: bytes, content_type: str):
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            if body:
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, OSError) as exc:
            LOG.debug("scrape client dropped before response completed: %s", exc)

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler API
        try:
            path = self.path.split("?", 1)[0]
            if path == "/metrics":
                with _SAMPLE_LOCK:
                    sample = _CACHED_SAMPLE
                body = sample.encode("utf-8")
                return self._send(200, body, _METRICS_CONTENT_TYPE)
            if path in ("/", "/healthz"):
                # Convenience liveness for a Docker healthcheck / manual curl.
                return self._send(200, b"ok\n", "text/plain; charset=utf-8")
            return self._send(404, b"not found\n", "text/plain; charset=utf-8")
        except Exception as exc:  # noqa: BLE001 - never let the handler crash
            LOG.exception("unhandled error in GET %s", self.path)
            try:
                return self._send(
                    500, ("error: %s\n" % exc).encode("utf-8"),
                    "text/plain; charset=utf-8",
                )
            except Exception:  # noqa: BLE001
                return


def serve_forever():
    """
    Start the /metrics HTTP server and block serving it. Intended to run on a
    DAEMON thread (ops_agent starts it for the SBC role). Never raises out: a
    bind failure is logged loudly and the thread exits, but the carrier poller
    and the ops-agent command API keep running — this exporter being down must
    never take carrier monitoring down with it.
    """
    try:
        httpd = ThreadingHTTPServer((BIND_HOST, BIND_PORT), MetricsHandler)
    except OSError as exc:
        LOG.error(
            "fsdisp-metrics failed to bind %s:%d (%s) — /metrics disabled, "
            "poller continues", BIND_HOST, BIND_PORT, exc,
        )
        return

    httpd.daemon_threads = True
    LOG.info("fsdisp-metrics /metrics listening on %s:%d", BIND_HOST, BIND_PORT)
    try:
        httpd.serve_forever(poll_interval=0.5)
    except Exception as exc:  # noqa: BLE001 - keep the process alive regardless
        LOG.exception("fsdisp-metrics serve loop exited unexpectedly: %s", exc)


def start_in_background():
    """
    Seed the cache and spawn the /metrics HTTP server on a DAEMON thread.
    There is NO poll thread here — the carrier poller pushes fresh samples via
    update_from_destinations()/mark_scrape_failed() on its own cadence.
    Mirrors ops_metrics.start_in_background()'s shape (called from ops_agent.py
    on the SBC role). Never raises. Returns the HTTP thread.
    """
    # Always seed a valid sample FIRST so a scrape arriving before the first
    # poller tick gets parseable metrics (fsdisp_scrape_ok 0).
    _init_sample()

    http_thread = threading.Thread(
        target=serve_forever, name="fsdisp-metrics-http", daemon=True
    )
    http_thread.start()
    return http_thread
