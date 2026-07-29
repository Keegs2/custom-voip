#!/usr/bin/env python3
"""
ops_metrics.py — FreeSWITCH ESL Prometheus exporter for the ops-agent (:9103).

Runs INSIDE the already-deployed carrier-monitor / ops-agent sidecar, but ONLY on
the FreeSWITCH (media) VMs (FS role). It gives the metrics plane the LIVE call
splits that CDRs cannot — CDRs are written at hangup, so they can never show
currently-active channels, their inbound/outbound direction, or the on-net share.

WHAT IT DOES
------------
A background DAEMON thread polls FreeSWITCH's local Event Socket every
OPS_METRICS_INTERVAL seconds (default 10) with a single read-only
`show channels as json` verb (reusing ops_esl.esl_api — the SAME synchronous ESL
client the ops-agent command API already uses). It parses the rows, BUCKETS them
by `direction` (inbound/outbound) and the `on_net` channel variable, RENDERS a
Prometheus text exposition into a string, and CACHES that string.

A tiny separate ThreadingHTTPServer on :9103 serves `GET /metrics` by returning
that CACHED string verbatim. The HTTP handler NEVER touches ESL — a Prometheus
scrape can therefore never block on FreeSWITCH, and a stuck/slow ESL never stalls
vmagent. This is the same "serve last-good, never block the reader" contract the
carrier poller uses.

WHY A SEPARATE PORT / SERVER (not the ops-agent /run API)
--------------------------------------------------------
The ops-agent command API (:8710) is bearer-gated and POST-only — it is an admin
control surface. Prometheus metrics are, by convention, UNAUTHENTICATED plaintext
scraped by a co-located vmagent over the loopback of the shared host netns. Mixing
the two would either force auth onto the scraper or weaken the command API. So
this is a distinct, unauthenticated, GET-only listener on its own port (:9103).
Exposure is controlled the same way as :9102 / :8710 — a VPC firewall + the fact
that vmagent scrapes `127.0.0.1` on the host-net media VM.

FAIL-OPEN CONTRACT (CRITICAL — mirrors carrier_monitor.py)
----------------------------------------------------------
Any ESL error (FS down/restarting, connection refused, timeout, malformed JSON)
is caught, logged as a single line, and the poll thread KEEPS the previous
last-good sample while flipping `freeswitch_esl_scrape_ok` to 0. It NEVER raises,
NEVER exits, and NEVER blocks a scrape. The first poll (before any success) serves
a valid, well-formed sample with zeroed gauges and `esl_scrape_ok 0` so a scrape
during startup still returns 200 with parseable metrics.

CARDINALITY (bounded by design)
-------------------------------
Every label value is drawn from a CLOSED set:
  - freeswitch_node : this VM's id (one value per process)
  - direction       : inbound | outbound | unknown           (3)
  - on_net          : true | false | unknown                 (3)
So `freeswitch_channels_active` is at most ~9 series per node — customer/DID
identifiers are NEVER labels (the cardinality contract in the metrics plan).

EMITTED METRICS (names/labels fixed by the reconciled registry — do NOT rename)
-------------------------------------------------------------------------------
  freeswitch_channels_active{freeswitch_node,direction,on_net}  gauge
  freeswitch_calls_bridged{freeswitch_node}                     gauge
  freeswitch_channels_total{freeswitch_node}                    gauge
  freeswitch_esl_scrape_ok{freeswitch_node}                     gauge (1 ok / 0 fail)
"""

import json
import logging
import os
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from ops_esl import esl_api


LOG = logging.getLogger("ops-agent.metrics")


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


# Bind config for the /metrics listener. 0.0.0.0 so the co-located host-net
# vmagent can scrape it on 127.0.0.1; a firewall rule restricts who else can.
# Port is FIXED at 9103 by the reconciled registry (overridable only for odd
# deployments / tests — vmagent's scrape file targets 9103).
BIND_HOST = os.environ.get("OPS_METRICS_BIND", "0.0.0.0").strip() or "0.0.0.0"
BIND_PORT = _get_int("OPS_METRICS_PORT", 9103, minimum=1)

# Poll cadence: how often the background thread reads `show channels as json`
# and refreshes the cached sample. Default 10s (finer than the carrier poller's
# 15s heartbeat — this feeds a live wall). The ESL read itself uses a short,
# bounded timeout so a wedged FS can't stall the poll thread past one interval.
POLL_INTERVAL = _get_int("OPS_METRICS_INTERVAL", 10, minimum=1)

# Per-poll ESL read timeout (seconds). `show channels as json` can be a large
# payload on a busy switch; the ESL client reads the full Content-Length. Kept
# short so a hung socket unblocks well within a poll interval. Bounded to the
# poll interval so it can never overrun a tick.
ESL_TIMEOUT = float(_get_int("OPS_METRICS_ESL_TIMEOUT", 5, minimum=1))
ESL_TIMEOUT = min(ESL_TIMEOUT, float(POLL_INTERVAL))

# The FreeSWITCH node identity stamped into every metric's `freeswitch_node`
# label. Explicit FREESWITCH_NODE wins (set per-VM in the media .env, matching
# the vmagent external label); otherwise the OS hostname of this shared host
# netns — which on a host-networked media VM is the FS VM's hostname.
def _default_node() -> str:
    try:
        return socket.gethostname() or "unknown-fs"
    except OSError:
        return "unknown-fs"


FREESWITCH_NODE = (
    os.environ.get("FREESWITCH_NODE", "").strip() or _default_node()
)


# --------------------------------------------------------------------------- #
# Bounded label sets. Every emitted series is a product of these closed sets, so
# total cardinality per node is fixed regardless of call volume or customer count.
# --------------------------------------------------------------------------- #

_DIRECTIONS = ("inbound", "outbound", "unknown")
_ONNET = ("true", "false", "unknown")

# The exact channel variable another agent exports in inbound_router.lua for the
# on-net terminator. If a channel does not carry it (older calls, non-RCF paths),
# we bucket it as "unknown" — still one of the bounded values above.
ONNET_VAR = "on_net"


# --------------------------------------------------------------------------- #
# The cached sample. A single module-level string, swapped atomically under a
# lock by the poll thread and read (copied) by HTTP handler threads. A str
# assignment is already atomic in CPython, but the lock makes the read/refresh
# contract explicit and future-proof.
# --------------------------------------------------------------------------- #

_SAMPLE_LOCK = threading.Lock()
_CACHED_SAMPLE = ""  # set to a valid initial exposition by _init_sample()


def _norm_direction(value) -> str:
    """Map a raw FreeSWITCH channel `direction` to one of the bounded buckets."""
    s = ("" if value is None else str(value)).strip().lower()
    if s == "inbound":
        return "inbound"
    if s == "outbound":
        return "outbound"
    return "unknown"


def _norm_onnet(value) -> str:
    """
    Map a raw `on_net` channel-variable value to one of the bounded buckets.

    inbound_router.lua sets it to "true"/"false"; anything missing/other becomes
    "unknown" (the plan's documented default until the var is universally set).
    Common truthy/falsey spellings are normalized defensively so a "1"/"yes"
    never leaks as its own label value and blows the (otherwise closed) set.
    """
    s = ("" if value is None else str(value)).strip().lower()
    if s in ("true", "1", "yes", "y", "t", "on"):
        return "true"
    if s in ("false", "0", "no", "n", "f", "off"):
        return "false"
    return "unknown"


def _empty_buckets():
    """A fresh {(direction,on_net): 0} grid over the full bounded label space so
    EVERY series is emitted every scrape (Prometheus prefers a stable series set
    to sparse appearance/disappearance)."""
    return {(d, o): 0 for d in _DIRECTIONS for o in _ONNET}


def parse_channels(raw: str):
    """
    Parse a `show channels as json` payload into (buckets, total, bridged).

    - buckets : dict {(direction, on_net): count} over the bounded label grid.
    - total   : total channel count.
    - bridged : channels that are part of a bridged (two-legged) call, counted
                from a present-and-non-empty `call_uuid` (FreeSWITCH sets
                call_uuid on both legs of a bridge; an unbridged channel has an
                empty call_uuid). This is a live proxy for connected-call legs.

    FreeSWITCH renders `show channels as json` as:
        {"row_count": N, "rows": [ {..per-channel fields..}, ... ]}
    On an IDLE switch it returns {"row_count": 0} with NO "rows" key. Both shapes
    (and a stray non-JSON error string) are handled without raising — a parse
    problem returns zeroed buckets so the caller can still emit a valid sample.

    Never raises: any structural surprise yields zeroed/partial counts.
    """
    buckets = _empty_buckets()
    total = 0
    bridged = 0

    if not raw or not raw.strip():
        return buckets, total, bridged

    try:
        doc = json.loads(raw)
    except (ValueError, TypeError):
        # e.g. FreeSWITCH returned "-ERR ..." or an empty-result sentinel.
        LOG.debug("channels payload was not JSON (%d bytes)", len(raw))
        return buckets, total, bridged

    if not isinstance(doc, dict):
        return buckets, total, bridged

    rows = doc.get("rows")
    if rows is None:
        # Idle switch: {"row_count": 0} with no rows array. Zero is correct.
        return buckets, total, bridged
    if not isinstance(rows, list):
        return buckets, total, bridged

    for row in rows:
        if not isinstance(row, dict):
            continue
        total += 1
        direction = _norm_direction(row.get("direction"))
        # The on_net channel variable. `show channels` flattens exported channel
        # variables into row keys, so it appears as row["on_net"] when set.
        on_net = _norm_onnet(row.get(ONNET_VAR))
        key = (direction, on_net)
        # key is always in the grid (both components are normalized to bounded
        # values), but guard defensively in case the grid ever changes.
        buckets[key] = buckets.get(key, 0) + 1

        call_uuid = row.get("call_uuid")
        if call_uuid is not None and str(call_uuid).strip():
            bridged += 1

    return buckets, total, bridged


# --------------------------------------------------------------------------- #
# Prometheus text rendering. Hand-rolled (no client library) to keep the sidecar
# stdlib-only — same posture as ops_api's hand-rolled HTTP. Label values here are
# all from closed sets (node id, bounded direction/on_net), none containing a
# quote/backslash/newline, so no label-value escaping is required; we still keep
# the renderer simple and explicit.
# --------------------------------------------------------------------------- #

def _render(buckets, total: int, bridged: int, scrape_ok: bool) -> str:
    """Render the four gauges into a Prometheus text exposition string."""
    node = FREESWITCH_NODE
    lines = []

    # freeswitch_channels_active{freeswitch_node,direction,on_net}
    lines.append(
        "# HELP freeswitch_channels_active Live FreeSWITCH channels, "
        "bucketed by direction and on-net status (from the ESL exporter)."
    )
    lines.append("# TYPE freeswitch_channels_active gauge")
    for d in _DIRECTIONS:
        for o in _ONNET:
            count = buckets.get((d, o), 0)
            lines.append(
                'freeswitch_channels_active'
                '{freeswitch_node="%s",direction="%s",on_net="%s"} %d'
                % (node, d, o, count)
            )

    # freeswitch_calls_bridged{freeswitch_node}
    lines.append(
        "# HELP freeswitch_calls_bridged Live FreeSWITCH channels that are part "
        "of a bridged call (call_uuid present)."
    )
    lines.append("# TYPE freeswitch_calls_bridged gauge")
    lines.append(
        'freeswitch_calls_bridged{freeswitch_node="%s"} %d' % (node, bridged)
    )

    # freeswitch_channels_total{freeswitch_node}
    lines.append(
        "# HELP freeswitch_channels_total Total live FreeSWITCH channels "
        "(cross-check for the bucketed active gauge)."
    )
    lines.append("# TYPE freeswitch_channels_total gauge")
    lines.append(
        'freeswitch_channels_total{freeswitch_node="%s"} %d' % (node, total)
    )

    # freeswitch_esl_scrape_ok{freeswitch_node}
    lines.append(
        "# HELP freeswitch_esl_scrape_ok 1 if the last ESL poll succeeded, 0 if "
        "it failed (sample is then last-good/zeroed)."
    )
    lines.append("# TYPE freeswitch_esl_scrape_ok gauge")
    lines.append(
        'freeswitch_esl_scrape_ok{freeswitch_node="%s"} %d'
        % (node, 1 if scrape_ok else 0)
    )

    # Prometheus text format wants a trailing newline.
    return "\n".join(lines) + "\n"


def _init_sample():
    """Seed the cache with a valid, zeroed exposition (scrape_ok=0) so a scrape
    BEFORE the first successful poll still returns well-formed, parseable metrics
    instead of an empty body."""
    global _CACHED_SAMPLE
    with _SAMPLE_LOCK:
        _CACHED_SAMPLE = _render(_empty_buckets(), 0, 0, scrape_ok=False)


def _refresh_sample() -> bool:
    """
    Execute ONE poll: read channels over ESL, parse, render, and swap the cache.

    Returns True on a successful ESL read (scrape_ok will be 1), False on ANY
    failure (the cache is refreshed with scrape_ok=0 but the LAST-GOOD counts are
    preserved so the wall doesn't blank on a transient ESL hiccup). Never raises.
    """
    global _CACHED_SAMPLE
    try:
        ok, out, err = esl_api("show channels as json", timeout=ESL_TIMEOUT)
    except Exception as exc:  # noqa: BLE001 - esl_api shouldn't raise, belt-and-suspenders
        LOG.warning("ESL poll raised (serving last-good, ok=0): %s", exc)
        _mark_scrape_failed()
        return False

    if not ok:
        # Transport-level failure (connect refused, auth, timeout). Keep the
        # previous counts; just flip the ok marker to 0.
        LOG.warning("ESL channels read failed (serving last-good, ok=0): %s", err)
        _mark_scrape_failed()
        return False

    try:
        buckets, total, bridged = parse_channels(out)
    except Exception as exc:  # noqa: BLE001 - parser is defensive; last-resort guard
        LOG.error("failed to parse channels (serving last-good, ok=0): %s", exc)
        _mark_scrape_failed()
        return False

    sample = _render(buckets, total, bridged, scrape_ok=True)
    with _SAMPLE_LOCK:
        _CACHED_SAMPLE = sample
    LOG.debug(
        "metrics refreshed: total=%d bridged=%d node=%s", total, bridged,
        FREESWITCH_NODE,
    )
    return True


def _mark_scrape_failed():
    """
    Re-render the cache flipping ONLY `freeswitch_esl_scrape_ok` to 0 while
    preserving the last-good channel counts. We recompute from the last-good
    numbers by re-parsing our own last exposition is overkill; instead we keep
    the previous body but rewrite the ok line. Simpler and race-free: hold the
    lock, string-replace the single ok metric line's value.
    """
    global _CACHED_SAMPLE
    with _SAMPLE_LOCK:
        good = _CACHED_SAMPLE
        ok_1 = (
            'freeswitch_esl_scrape_ok{freeswitch_node="%s"} 1' % FREESWITCH_NODE
        )
        ok_0 = (
            'freeswitch_esl_scrape_ok{freeswitch_node="%s"} 0' % FREESWITCH_NODE
        )
        if ok_1 in good:
            _CACHED_SAMPLE = good.replace(ok_1, ok_0)
        elif ok_0 not in good and good:
            # Cache exists but has neither marker (shouldn't happen) — leave it.
            pass
        # If the cache was never seeded, _init_sample already wrote ok=0.


# --------------------------------------------------------------------------- #
# The poll loop (background daemon thread).
# --------------------------------------------------------------------------- #

def _poll_loop():
    """
    Refresh the cached sample every POLL_INTERVAL seconds, forever. Fail-open:
    a failed poll logs + keeps last-good; the loop itself is wrapped so no single
    tick's error can ever kill the thread (which would freeze the metrics at the
    last value with no way to recover until a container restart).
    """
    LOG.info(
        "ops-metrics poll loop started: interval=%ds esl_timeout=%.0fs node=%s",
        POLL_INTERVAL, ESL_TIMEOUT, FREESWITCH_NODE,
    )
    while True:
        started = time.monotonic()
        try:
            _refresh_sample()
        except Exception as exc:  # noqa: BLE001 - the loop must never die
            LOG.error("ops-metrics poll tick failed unexpectedly: %s", exc)
        # Sleep the remainder of the interval in short slices (responsive to
        # process teardown even though this is a daemon thread).
        elapsed = time.monotonic() - started
        deadline = time.monotonic() + max(0.0, POLL_INTERVAL - elapsed)
        while time.monotonic() < deadline:
            time.sleep(min(1.0, deadline - time.monotonic()))


# --------------------------------------------------------------------------- #
# The /metrics HTTP listener. Serves the CACHED sample only — never calls ESL.
# --------------------------------------------------------------------------- #

# Prometheus text format 0.0.4 content type (what vmagent expects).
_METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"


class MetricsHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "revup-ops-metrics/1"

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
                return self._send(
                    200, b"ok\n", "text/plain; charset=utf-8"
                )
            return self._send(
                404, b"not found\n", "text/plain; charset=utf-8"
            )
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
    DAEMON thread; the poller (carrier_monitor.main) owns the main thread + signal
    handling, so when it exits on SIGTERM the process ends and this daemon thread
    is torn down cleanly.

    Never raises out: a bind failure is logged loudly and the thread exits, but
    the poller (and the ops-agent command API) keep running — the metrics exporter
    being down must not take carrier monitoring or the command API down with it.
    """
    try:
        httpd = ThreadingHTTPServer((BIND_HOST, BIND_PORT), MetricsHandler)
    except OSError as exc:
        LOG.error(
            "ops-metrics failed to bind %s:%d (%s) — /metrics disabled, "
            "poller continues", BIND_HOST, BIND_PORT, exc,
        )
        return

    httpd.daemon_threads = True
    LOG.info(
        "ops-metrics /metrics listening on %s:%d node=%s interval=%ds",
        BIND_HOST, BIND_PORT, FREESWITCH_NODE, POLL_INTERVAL,
    )
    try:
        httpd.serve_forever(poll_interval=0.5)
    except Exception as exc:  # noqa: BLE001 - keep the process alive regardless
        LOG.exception("ops-metrics serve loop exited unexpectedly: %s", exc)


def start_in_background():
    """
    Seed the cache, spawn the poll loop and the /metrics HTTP server, each on its
    own DAEMON thread, and return them. Mirrors ops_api.start_in_background()'s
    shape (called from ops_agent.py on the FS role). Never raises: the caller
    wraps this in try/except too, but a failure here must not block the poller.

    Returns (poll_thread, http_thread).
    """
    # Always seed a valid zeroed sample FIRST so a scrape arriving before the
    # first poll (or if the poll thread is slow to start) gets parseable metrics.
    _init_sample()

    poll_thread = threading.Thread(
        target=_poll_loop, name="ops-metrics-poll", daemon=True
    )
    poll_thread.start()

    http_thread = threading.Thread(
        target=serve_forever, name="ops-metrics-http", daemon=True
    )
    http_thread.start()

    return poll_thread, http_thread
