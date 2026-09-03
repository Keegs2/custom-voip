#!/usr/bin/env python3
"""
ops_agent.py — revup-ops-agent entrypoint (poller + read-only command API).

This is the single process the sidecar container runs. It does TWO things:

  1. Serves the read-only, allow-listed HTTP command API (ops_api) that the
     ted-next NOC console calls for reads — on a DAEMON thread.
  2. Runs the EXISTING carrier-status poller (carrier_monitor.main) UNCHANGED —
     on the MAIN thread.

Why this split (and why it's safe)
----------------------------------
`carrier_monitor.main()` installs SIGTERM/SIGINT handlers, and in CPython signal
handlers can ONLY be installed from the main thread. So the poller MUST own the
main thread. We therefore start the HTTP API on a daemon thread FIRST, then hand
the main thread to the poller. Consequences, all desirable:

  - `carrier_monitor.py` is imported and called with ZERO modifications — PR #8's
    poller (its loop, backoff, event-acceleration, clean shutdown) is byte-for-byte
    intact and remains the process's lifecycle owner.
  - `docker stop` -> SIGTERM -> the poller's handler flips its run flag and the
    loop exits cleanly; the process ends and the daemon API thread is torn down
    with it. No second signal path to reason about.
  - If the API can't bind its port, it logs and its thread exits, but the poller
    keeps running — carrier monitoring never goes down because the command API did.

The image's ENTRYPOINT points here (was carrier_monitor.py). Running
carrier_monitor.py directly still works for a poller-only deployment.
"""

import logging
import os
import sys

# Both siblings live next to this file in /usr/local/bin (see Dockerfile COPY).
import carrier_monitor
import ops_api
# Role catalog — its detected ROLE gates which metrics subsystem we start.
import ops_commands
# Role-specific metrics-plane feeders (each a daemon thread, fail-open):
#   - ops_metrics       : FS ESL Prometheus exporter (:9103), FS role only.
#   - live_trunk_feeder : per-customer-trunk stats → East API, SBC role only.
#   - fsdisp_metrics    : FS-dispatcher maintenance-state exporter (:9104),
#                         SBC role only. HTTP server only — it is FED by the
#                         carrier poller's own dispatcher.list parse (push
#                         model, zero extra kamcmd invocations).
import ops_metrics
import live_trunk_feeder
import fsdisp_metrics


def main() -> int:
    # Configure logging ONCE here, before either subsystem starts, so the API
    # thread's logs and the poller's logs share one format/stream. carrier_monitor
    # also calls logging.basicConfig in its main(); basicConfig is a no-op if the
    # root logger already has handlers, so this call wins and the poller inherits
    # it (its per-message prefix "carrier-monitor" still appears in its own lines).
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        stream=sys.stdout,
    )
    log = logging.getLogger("ops-agent")
    log.info(
        "revup-ops-agent starting (poller + read-only command API), pid=%d",
        os.getpid(),
    )

    # 1) Start the read-only command API on a daemon thread. Never fatal: a bind
    #    failure inside serve_forever is logged and the thread exits; the poller
    #    still runs. We guard the spawn too, belt-and-suspenders.
    try:
        ops_api.start_in_background()
    except Exception as exc:  # noqa: BLE001 - API must never block the poller
        log.error("failed to start ops-agent API thread: %s", exc)

    # 1b) Start the metrics-plane feeder for THIS host's role, on its own daemon
    #     thread(s). Same posture as the command API: role-gated (using the
    #     catalog's already-detected ROLE — the same value /healthz advertises),
    #     wrapped in try/except so a feeder failure NEVER blocks or perturbs the
    #     carrier poller (the process's primary duty). Only the matching role's
    #     feeder starts; the other is a no-op on this VM.
    #
    #   FS role  -> ops_metrics: FreeSWITCH ESL Prometheus exporter on :9103.
    #   SBC role -> live_trunk_feeder: per-customer-trunk stats POSTed to the
    #               East API on its own cadence (carrier-status poll untouched).
    if ops_commands.ROLE == ops_commands.ROLE_FS:
        try:
            ops_metrics.start_in_background()
        except Exception as exc:  # noqa: BLE001 - metrics must never block the poller
            log.error("failed to start ops-metrics exporter thread: %s", exc)
    elif ops_commands.ROLE == ops_commands.ROLE_SBC:
        try:
            live_trunk_feeder.start_in_background()
        except Exception as exc:  # noqa: BLE001 - feeder must never block the poller
            log.error("failed to start live-trunk feeder thread: %s", exc)
        # fsdisp exporter (:9104): HTTP thread only. The carrier poller (main
        # thread, below) pushes samples into it from its dispatcher.list parse.
        try:
            fsdisp_metrics.start_in_background()
        except Exception as exc:  # noqa: BLE001 - metrics must never block the poller
            log.error("failed to start fsdisp-metrics exporter thread: %s", exc)

    # 2) Hand the MAIN thread to the UNCHANGED carrier poller. It installs its own
    #    signal handlers and blocks until SIGTERM/SIGINT, then returns 0. Its
    #    return code becomes the process exit code.
    return carrier_monitor.main()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 - last-resort guard (should be unreachable)
        # Mirror carrier_monitor's last-resort guard: log + nonzero exit so the
        # container's `restart: unless-stopped` brings the agent back.
        logging.critical("fatal error in ops-agent: %s", exc, exc_info=True)
        sys.exit(1)
