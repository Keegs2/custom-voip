#!/usr/bin/env python3
"""
live_trunk_feeder.py — LIVE per-CUSTOMER-trunk stats feeder (SBC sidecar).

Runs co-located with Kamailio on every SBC VM, in the SAME ops-agent process as
the carrier-status poller — but on ITS OWN cadence and ITS OWN daemon thread, so
it can NEVER perturb the carrier-status poll path (that loop is untouched).

WHY THIS EXISTS (the cardinality escape hatch)
----------------------------------------------
Customer SIP trunks number in the hundreds→thousands. Per the metrics plan's
cardinality contract, customer identifiers must NEVER become Prometheus labels.
So live per-customer-trunk detail is shipped to POSTGRES instead: this feeder
derives per-trunk stats from Kamailio via kamcmd and POSTs them to the East API
(`POST /v1/live-trunk-stats/report`), which UPSERTs one row per
(customer_id, trunk_id, sbc_id) into `live_trunk_stats`. Grafana/CRAG then drills
into that table for the per-customer view; Prometheus only ever carries the
bounded aggregate + carrier-trunk metrics.

DATA SOURCES (kamcmd — the SAME ctl binrpc socket the poller already uses)
--------------------------------------------------------------------------
- CPS per customer trunk  ← `kamcmd htable.dump trunk_cps`
      The `trunk_cps` htable is keyed by the customer trunk id as `<trunk_id>::cps`
      (see kamailio.cfg route[TRUNK_AUTH]: `$sht(trunk_cps=>$var(trunk_id)::cps)`).
      Its value is the call count in the CURRENT 1-second window (autoexpire=1),
      i.e. an instantaneous CPS sample for that trunk. We report it as `cps_1m`
      (the field the endpoint stores); it is a 1-second-window instantaneous
      sample, NOT a true 1-minute rate — the East API can smooth/rename if it
      chooses. This is the ONE field that is genuinely, cheaply derivable per
      customer trunk from kamcmd today.

- active_channels / registered  ← BEST-EFFORT, currently NOT cheaply derivable.
      Kamailio's dialogs do NOT carry a customer-trunk identifier: the dialog
      module here uses only `profiles_with_value "caller"` and the trunk id is
      passed to FreeSWITCH as the X-Trunk-ID *header* (not stored in a dialog
      profile or `$dlg_var`). So `kamcmd dlg.list` cannot be bucketed by trunk
      without a config change. And these are IP-authenticated trunks (no SIP
      REGISTER), so there is no registration state to read either.
      => We populate active_channels=0 and registered=null, with the TODO below.
      The endpoint accepts partial rows, so CPS still flows through immediately.

- asr_5m  ← left null here on purpose. ASR is CDR-derived; the plan fills it via a
      periodic East-API query over `cdrs`, NOT from the SBC (the SBC has no CDRs).

TODO (to populate active_channels per customer trunk without this feeder guessing):
  In kamailio.cfg add a VALUED dialog profile keyed by the customer trunk, e.g.
  `modparam("dialog","profiles_with_value","caller;customer_trunk")` and
  `set_dlg_profile("customer_trunk","$var(trunk_id)")` in route[TRUNK_AUTH]
  (and the trunk-inbound leg). Then this feeder can read
  `kamcmd profile_get_size customer_trunk <trunk_id>` per active trunk id to fill
  active_channels exactly. Until that Kamailio change ships (a windowed restart),
  active_channels stays 0 here. (Same "self-heals after the windowed change"
  caveat the plan notes for the carrier dialog-profile metric.)

customer_id RESOLUTION (best-effort):
  The `trunk_cps` htable yields only the trunk id, not its owning customer_id, and
  this sidecar has NO database connection (by design — it is a read-only Kamailio/
  Docker diagnostic agent). The POST body requires an int customer_id. We therefore
  send customer_id=0 as a SENTINEL meaning "resolve from trunk_id server-side": the
  East API owns `sip_trunks` (id → customer_id is a single indexed lookup) and, per
  the endpoint contract, backfills the real customer_id from trunk_id before the
  UPSERT. trunk_id is always the accurate key. (If a future revision gives this
  sidecar a read-only replica handle, resolve customer_id here and drop the
  sentinel — the body shape does not change.)

ROBUSTNESS CONTRACT (mirrors carrier_monitor.py — best-effort, fail-open)
-------------------------------------------------------------------------
Every failure — Kamailio not up, socket missing, kamcmd nonzero/empty, malformed
dump, API unreachable/5xx — is caught, logged as ONE line, and followed by a
sleep + retry on the next tick with exponential backoff (capped) on repeated API
failures. It NEVER crashes and NEVER blocks the carrier-status poll (separate
thread, separate socket invocation, separate cadence). The only thing that stops
it is process teardown (it is a daemon thread; the poller owns SIGTERM).
"""

import json
import logging
import os
import re
import subprocess
import threading
import time
from datetime import datetime, timezone

try:
    import requests
except ImportError:  # pragma: no cover - requests is installed in the image
    requests = None


LOG = logging.getLogger("ops-agent.live-trunk")


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


# Per-SBC identity — the same SBC_ID the carrier poller uses (goes into the
# payload's sbc_id; the endpoint's UPSERT PK is (customer_id, trunk_id, sbc_id)).
SBC_ID = os.environ.get("SBC_ID", "unknown-sbc").strip() or "unknown-sbc"

# Report cadence (seconds). Its OWN interval — deliberately independent of the
# carrier poller's POLL_INTERVAL so the two never couple. Default 15s.
LIVE_TRUNK_STATS_INTERVAL = _get_int("LIVE_TRUNK_STATS_INTERVAL", 15, minimum=1)

# Central receiver — the East services API. Same base host the carrier-status URL
# uses; the path is fixed by the endpoint contract (Component 6):
#     http://<east-services>:8080/api/v1/live-trunk-stats/report
LIVE_TRUNK_STATS_URL = os.environ.get("LIVE_TRUNK_STATS_URL", "").strip()

# Shared bearer token — DISTINCT from CARRIER_STATUS_TOKEN (the plan mandates a
# separate token per receiver). Fail-open on the wire: if unset we still attempt
# the POST (the endpoint decides), but we log the missing config each tick.
LIVE_TRUNK_STATS_TOKEN = os.environ.get("LIVE_TRUNK_STATS_TOKEN", "").strip()

# Kamailio ctl binrpc UNIX socket (shared volume) — identical resolution to the
# carrier poller / ops_commands so all three talk to the same running Kamailio.
KAMCMD_SOCKET = os.environ.get(
    "KAMCMD_SOCKET", "unix:/var/run/kamailio/kamailio_ctl"
).strip() or "unix:/var/run/kamailio/kamailio_ctl"
KAMCMD_BIN = os.environ.get("KAMCMD_BIN", "kamcmd").strip() or "kamcmd"

# HTTP timeouts (connect, read) — short so a hung API can't wedge this loop for
# longer than a tick. Reuse the same env knobs the carrier poller exposes.
HTTP_CONNECT_TIMEOUT = float(os.environ.get("HTTP_CONNECT_TIMEOUT", "5") or 5)
HTTP_READ_TIMEOUT = float(os.environ.get("HTTP_READ_TIMEOUT", "10") or 10)

# API-failure backoff (same shape/knobs as carrier_monitor).
BACKOFF_BASE = _get_int("BACKOFF_BASE", 5, minimum=1)
BACKOFF_MAX = _get_int("BACKOFF_MAX", 120, minimum=1)

# customer_id sentinel: the htable can't tell us the owning customer, so we send
# 0 = "server, resolve customer_id from trunk_id". See the module docstring.
CUSTOMER_ID_UNKNOWN = 0

# Hard cap on rows per POST — belt-and-suspenders vs a runaway htable dump (the
# endpoint also has a MAX_TRUNKS guard). Bounds payload size and memory.
MAX_TRUNK_ROWS = _get_int("LIVE_TRUNK_MAX_ROWS", 5000, minimum=1)


# --------------------------------------------------------------------------- #
# kamcmd invocation — hardened, never raises to the loop (own copy so this module
# stays self-contained; identical contract to carrier_monitor._run_kamcmd).
# --------------------------------------------------------------------------- #

def _run_kamcmd(rpc_args, timeout: float) -> str:
    """
    Run `kamcmd -s <socket> <rpc_args...>` and return stdout.
    Raises RuntimeError on any failure (missing binary, nonzero exit, timeout,
    empty output) so the caller can log + skip this tick.
    """
    cmd = [KAMCMD_BIN, "-s", KAMCMD_SOCKET, *rpc_args]
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(f"{KAMCMD_BIN} not found: {exc}") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"kamcmd timed out: {exc}") from exc
    except OSError as exc:
        raise RuntimeError(f"kamcmd failed to execute: {exc}") from exc

    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip().replace("\n", " ")
        raise RuntimeError(
            f"kamcmd exit {proc.returncode}: {err[:200] or 'no output'}"
        )
    if not proc.stdout or not proc.stdout.strip():
        # An EMPTY trunk_cps dump (no trunk sent a call this second) renders as
        # empty output — that's a valid "no active trunks" state, not an error.
        # We surface it as empty and let the parser return []. But _run_kamcmd's
        # contract is "raise on empty" (matches the poller); callers of the
        # trunk_cps dump catch this and treat it as "no rows this tick".
        raise RuntimeError("kamcmd returned empty output")
    return proc.stdout


# --------------------------------------------------------------------------- #
# trunk_cps htable dump parsing.
#
# `kamcmd htable.dump trunk_cps` renders the binrpc reply as an indented record
# tree. Each stored cell appears as a name/value/type triple, e.g.:
#
#   {
#       entry: 5
#       size: 1
#       slot: {
#           {
#               name: 42::cps
#               value: 3
#               type: int
#           }
#       }
#   }
#   { entry: 6 ... }
#
# The htable key is "<trunk_id>::cps" (route[TRUNK_AUTH]); the value is the
# current-second call count for that trunk. We scan every `name:`/`value:` pair
# in DOCUMENT ORDER (immune to brace/whitespace/newline layout across kamcmd
# versions — the same resilience strategy as the dispatcher.list parser), pair
# each `name:` with the NEXT `value:`, and keep only keys ending in "::cps".
# --------------------------------------------------------------------------- #

# One scanner that finds either a `name:` token or a `value:` token, in order.
# name value = up to end-of-line (a trunk id has no spaces, but ::cps suffix is
#              safe either way); value = a signed integer.
_RE_HT_CELL = re.compile(
    r"\bname:\s*(?P<name>[^\r\n}]+)"
    r"|\bvalue:\s*(?P<value>-?\d+)",
    re.IGNORECASE,
)

# Extract the numeric trunk id from a "<trunk_id>::cps" key. trunk_id is a SERIAL
# int in sip_trunks, so it is all digits.
_RE_CPS_KEY = re.compile(r"^\s*(\d+)::cps\s*$")


def parse_trunk_cps(text: str):
    """
    Parse a `kamcmd htable.dump trunk_cps` payload into {trunk_id: cps}.

    - Pairs each `name:` with the immediately-following `value:`.
    - Keeps only keys matching "<digits>::cps"; ignores any other cells.
    - Coerces the value to int; a missing/garbage value defaults the pair to 0.

    Returns a dict {int trunk_id: int cps}. Never raises — on any structural
    surprise it returns whatever it parsed so far (possibly empty).
    """
    result = {}
    pending_name = None
    for m in _RE_HT_CELL.finditer(text or ""):
        if m.group("name") is not None:
            pending_name = m.group("name").strip()
        elif m.group("value") is not None:
            if pending_name is None:
                continue  # a value with no preceding name — can't attribute it
            key_match = _RE_CPS_KEY.match(pending_name)
            pending_name = None
            if not key_match:
                continue  # not a "<trunk_id>::cps" cell
            try:
                trunk_id = int(key_match.group(1))
                cps = int(m.group("value"))
            except (TypeError, ValueError):
                continue
            # Keep the max if a trunk id somehow appears twice (defensive).
            result[trunk_id] = max(result.get(trunk_id, 0), cps)
    return result


def build_trunk_rows():
    """
    Read Kamailio and build the list of per-customer-trunk row dicts for the POST.

    Returns (rows, note) where rows is a list of dicts in the endpoint's shape and
    note is a short human string for the log line. Never raises — a kamcmd failure
    returns ([], "<reason>") so the caller simply skips the POST this tick.

    Field population (see module docstring for the why):
      customer_id     : 0 sentinel — endpoint resolves from trunk_id.
      trunk_id        : from the trunk_cps htable key. ACCURATE.
      trunk_name      : null — not known to the sidecar (endpoint has it).
      active_channels : 0 — TODO: needs a customer_trunk dialog profile in Kamailio.
      cps_1m          : instantaneous 1s-window CPS from trunk_cps. POPULATED.
      asr_5m          : null — CDR-derived, filled by the East API, not the SBC.
      registered      : null — IP-auth trunks have no REGISTER state to read.
    """
    # trunk_cps is a fixed 1-second window: an EMPTY dump (raises "empty output")
    # simply means no customer trunk sent a call in the current second. Treat
    # that as "no rows this tick" rather than an error.
    try:
        raw = _run_kamcmd(
            ["htable.dump", "trunk_cps"],
            timeout=max(5, min(LIVE_TRUNK_STATS_INTERVAL, 30)),
        )
    except RuntimeError as exc:
        msg = str(exc)
        if "empty output" in msg:
            return [], "trunk_cps empty (no active customer trunks this second)"
        # Kamailio down / socket missing / htable absent → skip this tick.
        return [], f"trunk_cps read skipped: {msg}"

    cps_by_trunk = parse_trunk_cps(raw)
    if not cps_by_trunk:
        return [], "no <trunk_id>::cps cells parsed from trunk_cps dump"

    rows = []
    for trunk_id, cps in sorted(cps_by_trunk.items()):
        rows.append({
            "customer_id": CUSTOMER_ID_UNKNOWN,  # sentinel; endpoint resolves it
            "trunk_id": trunk_id,
            "trunk_name": None,
            "active_channels": 0,   # TODO: customer_trunk dialog profile (see docstring)
            "cps_1m": cps,          # instantaneous 1s-window CPS sample
            "asr_5m": None,         # CDR-derived; filled by the East API
            "registered": None,     # IP-auth trunks: no registration state
        })
        if len(rows) >= MAX_TRUNK_ROWS:
            LOG.warning(
                "trunk_cps yielded >= %d trunks; truncating payload", MAX_TRUNK_ROWS
            )
            break

    return rows, f"{len(rows)} customer trunk(s) with live CPS"


# --------------------------------------------------------------------------- #
# Report POST — mirrors carrier_monitor.post_status byte-for-byte in shape
# (bearer header, json body, short (connect,read) timeout, 2xx check, raises on
# failure so the caller applies backoff).
# --------------------------------------------------------------------------- #

def post_stats(rows) -> None:
    """
    POST the live per-trunk snapshot to LIVE_TRUNK_STATS_URL with a bearer token.
    Raises on any failure (config missing, network error, non-2xx) so the caller
    can apply backoff. Same resilience posture as the carrier-status POST.
    """
    if requests is None:
        raise RuntimeError("python 'requests' library not available")
    if not LIVE_TRUNK_STATS_URL:
        raise RuntimeError("LIVE_TRUNK_STATS_URL not set — cannot report")

    payload = {
        "sbc_id": SBC_ID,
        # Same UTC, Z-suffixed, second-precision stamp the carrier poller sends.
        "reported_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "trunks": rows,
    }
    headers = {"Content-Type": "application/json"}
    if LIVE_TRUNK_STATS_TOKEN:
        headers["Authorization"] = f"Bearer {LIVE_TRUNK_STATS_TOKEN}"

    resp = requests.post(
        LIVE_TRUNK_STATS_URL,
        data=json.dumps(payload),
        headers=headers,
        timeout=(HTTP_CONNECT_TIMEOUT, HTTP_READ_TIMEOUT),
    )
    if not (200 <= resp.status_code < 300):
        body = (resp.text or "").strip().replace("\n", " ")[:200]
        raise RuntimeError(f"API returned {resp.status_code}: {body}")


def report_once() -> bool:
    """
    One full cycle: read Kamailio, build rows, POST. Returns True on a successful
    POST, False on ANY failure (already logged). Never raises.

    An EMPTY row set is still POSTed (so the endpoint can age out trunks that went
    idle) — but only when we successfully read Kamailio; a kamcmd FAILURE returns
    False without POSTing (we don't want to wipe live state on a transient read
    error). build_trunk_rows() distinguishes the two: empty-but-read returns
    ([], "…empty…") and we DO post; a read failure returns ([], "…skipped…") and
    we do NOT — encoded by the `note` prefix.
    """
    rows, note = build_trunk_rows()

    # If the read itself failed (Kamailio down / socket missing), skip the POST
    # entirely to avoid clobbering the API's last-good view with an empty set.
    if not rows and "skipped" in note:
        LOG.warning("live-trunk report skipped: %s", note)
        return False

    try:
        post_stats(rows)
    except Exception as exc:  # noqa: BLE001 - must never propagate
        LOG.warning("live-trunk POST failed (%d rows): %s", len(rows), exc)
        return False

    LOG.info("live-trunk reported: %s", note)
    return True


# --------------------------------------------------------------------------- #
# The report loop (background daemon thread). Independent cadence + backoff; the
# carrier-status poll loop is NOT involved here in any way.
# --------------------------------------------------------------------------- #

def _report_loop():
    LOG.info(
        "live-trunk feeder started: sbc_id=%s interval=%ds url=%s token=%s",
        SBC_ID, LIVE_TRUNK_STATS_INTERVAL, LIVE_TRUNK_STATS_URL or "<UNSET>",
        "set" if LIVE_TRUNK_STATS_TOKEN else "<UNSET>",
    )
    if not LIVE_TRUNK_STATS_URL:
        LOG.error(
            "LIVE_TRUNK_STATS_URL is not set; live-trunk feeder will idle and log "
            "each tick until configured (carrier-status poll is unaffected)"
        )

    consecutive_failures = 0
    while True:
        started = time.monotonic()
        extra_backoff = 0

        try:
            ok = report_once()
        except Exception as exc:  # noqa: BLE001 - the loop must never die
            LOG.error("live-trunk report tick failed unexpectedly: %s", exc)
            ok = False

        if ok:
            consecutive_failures = 0
        else:
            consecutive_failures += 1
            exp = min(consecutive_failures - 1, 30)
            extra_backoff = min(BACKOFF_BASE * (2 ** exp), BACKOFF_MAX)
            if consecutive_failures > 1:
                LOG.info(
                    "%d consecutive live-trunk failures — backing off extra %ds",
                    consecutive_failures, extra_backoff,
                )

        # Sleep the remainder of the interval (+ backoff) in short slices so the
        # thread is responsive to process teardown (it is a daemon thread).
        elapsed = time.monotonic() - started
        remaining = max(0.0, LIVE_TRUNK_STATS_INTERVAL - elapsed) + extra_backoff
        deadline = time.monotonic() + remaining
        while time.monotonic() < deadline:
            time.sleep(min(1.0, deadline - time.monotonic()))


def start_in_background() -> threading.Thread:
    """
    Spawn the live-trunk feeder on a DAEMON thread and return it. Mirrors
    ops_api.start_in_background()'s shape (called from ops_agent.py on the SBC
    role). Never raises: the caller wraps this too, but a failure here must not
    block or perturb the carrier-status poller.
    """
    t = threading.Thread(
        target=_report_loop, name="live-trunk-feeder", daemon=True
    )
    t.start()
    return t
