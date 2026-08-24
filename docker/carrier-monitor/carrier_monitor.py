#!/usr/bin/env python3
"""
carrier_monitor.py — LIVE carrier-trunk connectivity poller (SBC sidecar).

Runs as a co-located sidecar next to Kamailio on every SBC VM. It reads the LIVE
per-gateway health that Kamailio's dispatcher module maintains (via its OPTIONS
keepalive probes to the Bandwidth carriers) and ships a compact per-carrier
up/down snapshot to the central API.

Two cadences drive a report (event-driven acceleration)
-------------------------------------------------------
1. HEARTBEAT: at least every POLL_INTERVAL seconds a full snapshot is sent even
   if nothing changed, so the API's view can never go stale.
2. TRANSITION (fast path): every EVENT_CHECK_INTERVAL seconds (default 3s) we do
   a CHEAP `kamcmd htable.get dsmon gen` read of a generation counter that
   Kamailio's dispatcher event routes (event_route[dispatcher:dst-up|dst-down])
   bump on EVERY carrier up/down transition. When that counter changes we fire a
   full snapshot IMMEDIATELY — so a carrier flap is reported within a few
   seconds instead of up to a full POLL_INTERVAL later. The cheap gen read does
   NOT run dispatcher.list; only the trigger does. If the gen read ever fails
   (Kamailio restarting, htable absent on an older config), we transparently
   fall back to plain POLL_INTERVAL heartbeat polling — never breaking, never
   hot-looping.

Data source
-----------
Kamailio's `dispatcher` module already OPTIONS-probes the carrier gateways
(setid 2,3 in dispatcher.list) every ds_ping_interval seconds and tracks each
one's active/inactive state. We do NOT re-probe anything here — we simply read
that authoritative live state out of the running Kamailio.

We read it over the EXISTING `ctl` binrpc UNIX socket
(/var/run/kamailio/kamailio_ctl) using the `kamcmd dispatcher.list` command.
This is the same socket the container healthcheck already uses
(`kamcmd -s unix:/var/run/kamailio/kamailio_ctl core.uptime`), shared into this
sidecar via a read/write docker volume. Reusing it means:
  - zero new listeners, zero new modules, zero SIP-routing changes
  - localhost-only (a UNIX socket — never on the network)
  - no attack surface added to the SBC

Robustness contract (CRITICAL)
------------------------------
This process MUST NEVER crash-loop or exit on an error. Every foreseeable
failure — Kamailio not up yet, socket missing, kamcmd nonzero exit, malformed
output, no carrier gateways parsed, API unreachable/5xx, JSON errors — is
caught, logged as a single line, and followed by a sleep + retry on the next
tick. Repeated API failures trigger exponential backoff (capped) so a down
API does not turn into a request storm. The only thing that stops the loop is
an explicit SIGTERM/SIGINT (clean shutdown for `docker stop`).
"""

import json
import logging
import os
import re
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone

try:
    import requests
except ImportError:  # pragma: no cover - requests is installed in the image
    requests = None


# --------------------------------------------------------------------------- #
# Configuration (all via env; sane defaults so a missing var never crashes)
# --------------------------------------------------------------------------- #

def _get_int(name: str, default: int, minimum: int = 1) -> int:
    """Parse an int env var, clamping to `minimum`, falling back on garbage."""
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        val = int(raw.strip())
    except (TypeError, ValueError):
        logging.warning("Invalid %s=%r; using default %d", name, raw, default)
        return default
    return val if val >= minimum else minimum


SBC_ID = os.environ.get("SBC_ID", "unknown-sbc").strip() or "unknown-sbc"
CARRIER_STATUS_URL = os.environ.get("CARRIER_STATUS_URL", "").strip()
CARRIER_STATUS_TOKEN = os.environ.get("CARRIER_STATUS_TOKEN", "").strip()

# POLL_INTERVAL is the STEADY-STATE HEARTBEAT: a full dispatcher.list snapshot +
# report is sent at least this often even when nothing changes (so the API's
# view never goes stale and a missed transition event self-heals within one
# heartbeat). Default 15s.
POLL_INTERVAL = _get_int("POLL_INTERVAL", 15, minimum=1)

# EVENT_CHECK_INTERVAL is the fast EVENT-POLL cadence: how often we do the CHEAP
# `kamcmd htable.get dsmon gen` read to detect a carrier up/down transition that
# Kamailio's dispatcher event routes just recorded. On a detected change we fire
# a full report immediately instead of waiting up to POLL_INTERVAL — cutting
# transition-to-report latency from ~POLL_INTERVAL down to ~EVENT_CHECK_INTERVAL.
# Default 3s. Clamped so it never exceeds POLL_INTERVAL (a longer event check
# than the heartbeat would be pointless — the heartbeat would always win).
EVENT_CHECK_INTERVAL = min(
    _get_int("EVENT_CHECK_INTERVAL", 3, minimum=1), POLL_INTERVAL
)

# Path to the Kamailio ctl binrpc UNIX socket (shared volume). Matches the
# `ctl` modparam and kamcmd's compiled-in default.
KAMCMD_SOCKET = os.environ.get(
    "KAMCMD_SOCKET", "unix:/var/run/kamailio/kamailio_ctl"
).strip()
KAMCMD_BIN = os.environ.get("KAMCMD_BIN", "kamcmd").strip() or "kamcmd"

# HTTP timeouts (connect, read) for the report POST — kept short so a hung
# API socket can never wedge the poll loop for longer than a tick.
HTTP_CONNECT_TIMEOUT = float(os.environ.get("HTTP_CONNECT_TIMEOUT", "5") or 5)
HTTP_READ_TIMEOUT = float(os.environ.get("HTTP_READ_TIMEOUT", "10") or 10)

# API-failure backoff: after consecutive POST failures, sleep an extra
# min(BACKOFF_BASE * 2**(n-1), BACKOFF_MAX) seconds on top of the normal tick.
BACKOFF_BASE = _get_int("BACKOFF_BASE", 5, minimum=1)
BACKOFF_MAX = _get_int("BACKOFF_MAX", 120, minimum=1)


# --------------------------------------------------------------------------- #
# Carrier gateway model
#
# We report ONLY the live carriers. In dispatcher.list:
#   setid 1     = FreeSWITCH backends (NOT a carrier)             -> EXCLUDED
#   setid 2,3   = Bandwidth Dallas / LA (live, orig+term)         -> reported
#   setid 4,5   = Bandwidth TC1/TC2 PoPs (UNUSED)                 -> EXCLUDED
#   setid 6,7   = Sinch Denver / Chicago (live, origination-only) -> reported
#
# duid -> friendly name mapping (the dispatcher RPC does not carry a friendly
# name, only the duid attribute we set in dispatcher.list). Any carrier duid
# not in this map still gets reported with a derived fallback name.
# --------------------------------------------------------------------------- #

CARRIER_SETIDS = frozenset({2, 3, 6, 7})
FS_SETID = 1  # FreeSWITCH — explicitly excluded from carrier reporting

DUID_NAMES = {
    "bw-dallas-primary": "Bandwidth Dallas",
    "bw-la-secondary": "Bandwidth LA",
    "bw-tc1-ny": "Bandwidth TC1 NY",
    "bw-tc1-atl": "Bandwidth TC1 ATL",
    "bw-tc2-dal": "Bandwidth TC2 Dallas",
    "bw-tc2-la": "Bandwidth TC2 LA",
    "sinch-denver": "Sinch Denver",
    "sinch-chicago": "Sinch Chicago",
}


def friendly_name(duid: str) -> str:
    """Map a duid to its friendly carrier name, deriving a fallback if unknown."""
    if duid in DUID_NAMES:
        return DUID_NAMES[duid]
    # Fallback: "bw-tc9-xyz" -> "Bandwidth Tc9 Xyz" (still human-readable so a
    # newly-added carrier PoP shows up sensibly before this map is updated).
    cleaned = duid[3:] if duid.startswith("bw-") else duid
    parts = [p for p in re.split(r"[-_]", cleaned) if p]
    label = " ".join(p.capitalize() for p in parts) if parts else duid
    return ("Bandwidth " + label) if duid.startswith("bw-") else (label or duid)


# --------------------------------------------------------------------------- #
# FLAGS -> is_up mapping
#
# Kamailio dispatcher FLAGS is a 2-letter code (dispatcher module docs):
#   1st letter = STATUS:  A=active  I=inactive  T=trying  D=disabled
#   2nd letter = PROBING: P=probing (OPTIONS continuously)  X=no probing
#
# is_up is derived from the STATUS letter ONLY (the probing letter is just
# whether keepalive is enabled and is irrelevant to reachability). With
# ds_probing_mode=1 every carrier is probed continuously, so healthy gateways
# read "AP" (active+probing) — matching the payload contract's examples. "AX"
# (active, no probing) is also up.
#
#   A (active)   -> is_up = True   (carrier answering OPTIONS)
#   I (inactive) -> is_up = False  (crossed ds_probing_threshold failures — down)
#   D (disabled) -> is_up = False  (admin-disabled — treat as down)
#   T (trying)   -> is_up = False  (transitional/unknown — fail safe to down)
#   anything else / unparseable -> is_up = False (fail safe to down)
# --------------------------------------------------------------------------- #

def flags_to_is_up(flags: str) -> bool:
    """Map a dispatcher FLAGS code to a boolean up/down. Fails safe to down."""
    if not flags:
        return False
    status = flags.strip()[0].upper()
    return status == "A"


# --------------------------------------------------------------------------- #
# kamcmd dispatcher.list parsing
#
# `kamcmd dispatcher.list` renders the binrpc reply as an indented text tree.
# Shape (fields per the dispatcher module docs — URI/FLAGS/PRIORITY/ATTRS/DUID):
#
#   SET: {
#       id: 2
#       TARGETS: {
#           DEST: {
#               URI: sip:67.231.2.12:5060
#               FLAGS: AP
#               PRIORITY: 0
#               ATTRS: {
#                   BODY: weight=100;duid=bw-dallas-primary
#                   DUID: bw-dallas-primary
#                   ...
#               }
#               LATENCY: { ... }   # present only if latency stats enabled
#           }
#           DEST: { ... }
#       }
#   }
#
# We DO NOT rely on exact indentation to associate a DEST with its SET. Instead
# we walk the lines in order, tracking the most-recent `id:` (current setid) and
# accumulating fields for the current `DEST` block, flushing a record whenever a
# new DEST/SET starts or at EOF. The duid is taken from the explicit `DUID:`
# field, or as a fallback parsed out of the ATTRS `BODY:` (duid=...). This makes
# parsing resilient to kamcmd rendering/whitespace differences across versions.
# --------------------------------------------------------------------------- #

# Token scanner. Rather than parse line-by-line (which breaks if kamcmd renders
# several keys on one line, e.g. "DEST: { URI: ... FLAGS: AP ... }"), we find
# every relevant token in DOCUMENT ORDER over the whole reply and reconstruct
# records by association. This is immune to brace/whitespace/newline layout.
#
# Each alternative is a named group so we can tell which token matched:
#   setid  — the set id ("id: 2"); word-boundary prefix so it never matches the
#            tail of DUID:/RWEIGHT:/etc.
#   dest   — a DEST block start (opens a new destination record)
#   uri    — "URI: sip:..."   (value = up to whitespace)
#   flags  — "FLAGS: AP"
#   duid   — "DUID: bw-..."
#   body   — "BODY: weight=100;duid=..." (value = rest of line; duid extracted)
# Values stop at whitespace (uri/flags/duid) or end-of-line (body) so trailing
# "}" on the same line as a value is not captured.
_RE_TOKEN = re.compile(
    r"(?:^|[^A-Za-z])id:\s*(?P<setid>\d+)\b"
    r"|(?P<dest>\bDEST\b\s*:?\s*\{?)"
    r"|\bURI:\s*(?P<uri>\S+)"
    r"|\bFLAGS:\s*(?P<flags>\S+)"
    r"|\bDUID:\s*(?P<duid>[^\s}]+)"
    r"|\bBODY:\s*(?P<body>[^\r\n]*)",
    re.IGNORECASE,
)
# Extract host from "sip:67.231.2.12:5060" / "sip:host:5060;transport=udp" /
# "sip:user@host:5060". Group 1 = host (v4/v6-in-brackets/FQDN).
_RE_URI_HOST = re.compile(
    r"^sip[s]?:(?:[^@]+@)?(\[[^\]]+\]|[^:;>\s]+)", re.IGNORECASE
)


def _duid_from_body(body: str) -> str:
    """Pull duid=... out of an ATTRS BODY string; '' if absent.

    A duid value has no whitespace, ';', or '}' — stopping at those keeps a
    trailing brace ("duid=bw-tc1-atl } }") or the next attr out of the value.
    """
    if not body:
        return ""
    m = re.search(r"(?:^|;)\s*duid=([^\s;}]+)", body, re.IGNORECASE)
    return m.group(1).strip() if m else ""


def _host_from_uri(uri: str) -> str:
    """Extract the bare host/IP from a SIP URI; '' if it can't be parsed."""
    if not uri:
        return ""
    m = _RE_URI_HOST.match(uri.strip())
    if not m:
        return ""
    host = m.group(1)
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]  # unwrap bracketed IPv6
    return host


def parse_dispatcher_list(text: str):
    """
    Parse `kamcmd dispatcher.list` text into a list of carrier trunk dicts
    matching the payload contract. Returns only setid 2,3 gateways.

    Each dict: {duid, name, ip, setid, is_up, flags}.
    Never raises — on any structural surprise it returns whatever it parsed.
    """
    trunks = []
    current_setid = None
    dest = None  # accumulator for the DEST block currently being read

    def flush():
        nonlocal dest
        if not dest:
            return
        setid = dest.get("setid")
        # Only carrier sets (2-5); skip FreeSWITCH (setid 1) and anything else.
        if setid in CARRIER_SETIDS:
            duid = dest.get("duid") or _duid_from_body(dest.get("body", ""))
            flags = dest.get("flags", "")
            trunks.append({
                "duid": duid,
                "name": friendly_name(duid) if duid else "Bandwidth (unknown)",
                "ip": _host_from_uri(dest.get("uri", "")),
                "setid": setid,
                "is_up": flags_to_is_up(flags),
                "flags": flags,
            })
        dest = None

    # Walk every token in document order and reconstruct records by association.
    for m in _RE_TOKEN.finditer(text):
        if m.group("setid") is not None:
            # New set id: close any in-flight DEST, update the setid context.
            flush()
            try:
                current_setid = int(m.group("setid"))
            except (TypeError, ValueError):
                current_setid = None
        elif m.group("dest") is not None:
            flush()  # close the previous DEST before starting a new one
            dest = {"setid": current_setid}
        elif dest is None:
            # A field token outside any DEST block — ignore (can't attribute it).
            continue
        elif m.group("uri") is not None:
            # Keep only the FIRST URI seen in a DEST (defensive vs stray matches).
            dest.setdefault("uri", m.group("uri"))
        elif m.group("flags") is not None:
            dest.setdefault("flags", m.group("flags"))
        elif m.group("duid") is not None:
            dest.setdefault("duid", m.group("duid"))
        elif m.group("body") is not None:
            dest.setdefault("body", m.group("body").strip())

    flush()  # flush the final DEST at EOF
    return trunks


# --------------------------------------------------------------------------- #
# kamcmd invocation
# --------------------------------------------------------------------------- #

def _run_kamcmd(rpc_args, timeout: float) -> str:
    """
    Run `kamcmd -s <socket> <rpc_args...>` and return stdout.
    Raises RuntimeError on any failure (missing binary, nonzero exit, timeout,
    empty output) so callers can log + skip. Shared by the full dispatcher.list
    read and the cheap dsmon-gen read so both get identical hardened handling.
    """
    cmd = [KAMCMD_BIN, "-s", KAMCMD_SOCKET, *rpc_args]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(f"{KAMCMD_BIN} not found: {exc}") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"kamcmd timed out: {exc}") from exc
    except OSError as exc:
        raise RuntimeError(f"kamcmd failed to execute: {exc}") from exc

    if proc.returncode != 0:
        # Non-zero almost always means Kamailio isn't up / socket not ready yet.
        err = (proc.stderr or proc.stdout or "").strip().replace("\n", " ")
        raise RuntimeError(
            f"kamcmd exit {proc.returncode}: {err[:200] or 'no output'}"
        )
    if not proc.stdout or not proc.stdout.strip():
        raise RuntimeError("kamcmd returned empty output")
    return proc.stdout


def run_kamcmd_dispatcher_list() -> str:
    """
    Run `kamcmd -s <socket> dispatcher.list` and return stdout.
    Raises RuntimeError on any failure so the caller logs + skips this tick.
    """
    return _run_kamcmd(["dispatcher.list"], timeout=max(5, min(POLL_INTERVAL, 30)))


# Pull the integer out of the `value:` line of an `htable.get dsmon gen` reply.
# kamcmd renders the binrpc reply as an indented record, e.g.:
#     {
#         entry: 3
#         size: 1
#         slot: {
#             {
#                 name: gen
#                 value: 7
#                 type: int
#             }
#         }
#     }
# (A single-cell get is wrapped the same way htable.dump wraps cells.) We only
# need the counter, so we grab the first integer `value:` field. Matching just
# `value:` keeps this immune to whitespace/brace-layout differences across
# kamcmd versions — the same resilience strategy as the dispatcher.list parser.
_RE_HT_VALUE = re.compile(r"\bvalue:\s*(-?\d+)\b")


def read_dsmon_gen():
    """
    CHEAP read of the dispatcher-event generation counter via
    `kamcmd htable.get dsmon gen`. Returns the counter as an int, or None if it
    cannot be read for ANY reason (Kamailio down/restarting, dsmon htable absent
    on an older config, key not yet seeded, malformed output, kamcmd missing).

    NEVER raises: a None return is the caller's signal to fall back to plain
    time-based heartbeat polling for this tick. This must be lightweight — it
    runs every EVENT_CHECK_INTERVAL (~3s) — so it uses a short fixed timeout and
    does NOT invoke the heavy dispatcher.list RPC.
    """
    try:
        # `htable.get <table> <key>` — a single-cell point read. Short timeout:
        # this is a tiny local UNIX-socket RPC; if it can't answer in a couple
        # seconds Kamailio is wedged and we'd rather fall through to heartbeat.
        out = _run_kamcmd(["htable.get", "dsmon", "gen"], timeout=3)
    except Exception as exc:  # noqa: BLE001 - fail-open: never propagate
        # DBG not WARN: a transient miss here is harmless (heartbeat still
        # fires) and would otherwise spam the log every EVENT_CHECK_INTERVAL
        # while Kamailio is starting. The heartbeat path logs real problems.
        logging.debug("dsmon gen read unavailable (will heartbeat): %s", exc)
        return None

    m = _RE_HT_VALUE.search(out)
    if not m:
        # Key absent (never seeded / wrong table) renders without a value line,
        # or output shape was unexpected. Treat as "can't tell" -> heartbeat.
        logging.debug("dsmon gen not found in htable.get output; will heartbeat")
        return None
    try:
        return int(m.group(1))
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------- #
# Report POST
# --------------------------------------------------------------------------- #

def post_status(trunks) -> None:
    """
    POST the carrier snapshot to CARRIER_STATUS_URL with a bearer token.
    Raises on any failure (config missing, network error, non-2xx) so the
    caller can apply backoff.
    """
    if requests is None:
        raise RuntimeError("python 'requests' library not available")
    if not CARRIER_STATUS_URL:
        raise RuntimeError("CARRIER_STATUS_URL not set — cannot report")

    payload = {
        "sbc_id": SBC_ID,
        # Contract format: UTC, Z-suffixed, second precision (e.g. 2026-07-27T15:00:00Z)
        "probed_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "trunks": trunks,
    }
    headers = {"Content-Type": "application/json"}
    if CARRIER_STATUS_TOKEN:
        headers["Authorization"] = f"Bearer {CARRIER_STATUS_TOKEN}"

    resp = requests.post(
        CARRIER_STATUS_URL,
        data=json.dumps(payload),
        headers=headers,
        timeout=(HTTP_CONNECT_TIMEOUT, HTTP_READ_TIMEOUT),
    )
    if not (200 <= resp.status_code < 300):
        body = (resp.text or "").strip().replace("\n", " ")[:200]
        raise RuntimeError(f"API returned {resp.status_code}: {body}")


# --------------------------------------------------------------------------- #
# Main loop
# --------------------------------------------------------------------------- #

_RUNNING = True


def _handle_signal(signum, _frame):
    global _RUNNING
    logging.info("Received signal %s — shutting down after current tick", signum)
    _RUNNING = False


def poll_once() -> bool:
    """
    Execute one full poll: read dispatcher state, parse carriers, POST.
    Returns True on a successful POST, False on ANY failure (already logged).
    Never raises.
    """
    try:
        raw = run_kamcmd_dispatcher_list()
    except Exception as exc:  # noqa: BLE001 - must never propagate
        logging.warning("dispatcher read skipped: %s", exc)
        return False

    try:
        trunks = parse_dispatcher_list(raw)
    except Exception as exc:  # noqa: BLE001 - parser is defensive, belt-and-suspenders
        logging.error("failed to parse dispatcher.list: %s", exc)
        return False

    if not trunks:
        # No carrier gateways parsed. Could be a transient startup race or a
        # rendering change. Log and skip rather than POST an empty carrier set.
        logging.warning(
            "no carrier gateways (setid 2,3) found in dispatcher.list — skipping report"
        )
        return False

    up = sum(1 for t in trunks if t["is_up"])
    try:
        post_status(trunks)
    except Exception as exc:  # noqa: BLE001 - must never propagate
        logging.warning(
            "report POST failed (%d carriers, %d up): %s", len(trunks), up, exc
        )
        return False

    logging.info(
        "reported %d carriers (%d up, %d down): %s",
        len(trunks), up, len(trunks) - up,
        ", ".join(f"{t['duid'] or '?'}={t['flags'] or '?'}" for t in trunks),
    )
    return True


def main() -> int:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s carrier-monitor %(levelname)s %(message)s",
        stream=sys.stdout,
    )
    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    logging.info(
        "starting: sbc_id=%s heartbeat=%ds event_check=%ds socket=%s url=%s token=%s",
        SBC_ID, POLL_INTERVAL, EVENT_CHECK_INTERVAL, KAMCMD_SOCKET,
        CARRIER_STATUS_URL or "<UNSET>",
        "set" if CARRIER_STATUS_TOKEN else "<UNSET>",
    )
    if not CARRIER_STATUS_URL:
        # Do NOT exit — keep running so a later env fix (compose recreate) works
        # without a crash-loop in between. Every tick logs the missing config.
        logging.error(
            "CARRIER_STATUS_URL is not set; will keep polling and log until configured"
        )

    # --- Event-aware loop state ---------------------------------------------- #
    # last_gen           — last dsmon generation we successfully accounted for
    #                      (None until we first read it, or whenever the read is
    #                      unavailable — in which case we run pure heartbeat).
    # last_full_time     — monotonic timestamp of the last FULL report ATTEMPT.
    #                      Drives the heartbeat: a full report fires when
    #                      POLL_INTERVAL has elapsed since this, regardless of
    #                      events. Seeded to the past so tick #1 always reports
    #                      an initial baseline snapshot.
    # consecutive_failures — powers the exponential API backoff (unchanged).
    last_gen = None
    last_full_time = time.monotonic() - POLL_INTERVAL  # force an immediate first report
    consecutive_failures = 0

    while _RUNNING:
        tick_started = time.monotonic()
        extra_backoff = 0

        # CHEAP event check: read the dispatcher-event generation counter. None
        # means "can't tell" (Kamailio starting, dsmon htable absent) -> we
        # simply rely on the heartbeat this tick. read_dsmon_gen() is fail-open
        # by contract (returns None, never raises) and never runs the heavy
        # dispatcher.list RPC. The surrounding try is belt-and-suspenders: even
        # a hypothetical future bug in the reader must degrade to heartbeat
        # polling, never kill the loop — same posture as poll_once()'s catch.
        try:
            gen = read_dsmon_gen()
        except Exception as exc:  # noqa: BLE001 - must never propagate
            logging.debug("dsmon gen read raised (will heartbeat): %s", exc)
            gen = None

        # A transition is only asserted when we have BOTH a prior and a current
        # reading and they differ. (last_gen None -> we just (re)gained the
        # counter; don't treat that as a flap — the heartbeat covers baseline.)
        transition = (
            gen is not None and last_gen is not None and gen != last_gen
        )
        heartbeat_due = (time.monotonic() - last_full_time) >= POLL_INTERVAL
        should_report = transition or heartbeat_due

        if transition:
            logging.info(
                "carrier transition detected (dsmon gen %s -> %s) — reporting now",
                last_gen, gen,
            )

        if should_report:
            last_full_time = time.monotonic()
            ok = poll_once()
            if ok:
                consecutive_failures = 0
                # Only advance the accounted-for generation on a SUCCESSFUL
                # report. If a transition report FAILED, we intentionally leave
                # last_gen behind so the change is re-detected and retried on
                # the next tick (bounded by the backoff below) rather than lost.
                if gen is not None:
                    last_gen = gen
            else:
                consecutive_failures += 1
                # Exponential backoff on repeated failures, capped. Applied ON
                # TOP of the tick interval so a down API can't become a request
                # storm. Cap the exponent (at 30) before the shift so a long
                # outage never computes an enormous power just to clamp it away.
                exp = min(consecutive_failures - 1, 30)
                extra_backoff = min(BACKOFF_BASE * (2 ** exp), BACKOFF_MAX)
                if consecutive_failures > 1:
                    logging.info(
                        "%d consecutive failures — backing off extra %ds",
                        consecutive_failures, extra_backoff,
                    )
        else:
            # No report this tick. Track the current generation so the NEXT real
            # change is measured against it. (Safe: with no report there was no
            # transition, or we simply lack a prior reading to compare.)
            if gen is not None:
                last_gen = gen

        # Sleep the remainder of the EVENT_CHECK_INTERVAL (+ any backoff), in
        # short slices so SIGTERM is honored within ~1s instead of a full tick.
        elapsed = time.monotonic() - tick_started
        remaining = max(0.0, EVENT_CHECK_INTERVAL - elapsed) + extra_backoff
        deadline = time.monotonic() + remaining
        while _RUNNING and time.monotonic() < deadline:
            time.sleep(min(1.0, deadline - time.monotonic()))

    logging.info("carrier-monitor stopped cleanly")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 - last-resort guard; should be unreachable
        # Even a truly unexpected error should not silently kill the container
        # with a confusing traceback. Log it and exit non-zero so `restart:
        # unless-stopped` brings us back.
        logging.critical("fatal error in carrier-monitor: %s", exc, exc_info=True)
        sys.exit(1)
