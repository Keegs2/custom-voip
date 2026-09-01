#!/usr/bin/env bash
# =============================================================================
# Install/refresh the FreeSWITCH watchdog on a MEDIA VM (FS-1 or FS-2 — all 6).
# =============================================================================
# Encodes the host schedule in the repo (no ad-hoc VM cron): copies the units
# from scripts/fs-watchdog/systemd/ (plus the shared revup-alert@ page relay
# from scripts/backup/systemd/) into /etc/systemd/system and enables the 60s
# timer. Idempotent — re-run after any `git pull` that touches
# scripts/fs-watchdog/ to pick up changes.
#
# What it pages: FS container dead, or container up but ESL unresponsive —
# the container-level media death that no GCM policy sees (any-FS healthz keeps
# the VIP up, vm_down only sees VM death). Pages through the EXISTING
# revup-alert log-match policy via the Ops Agent; zero new GCP resources.
# Prereq (already true on all media VMs): google-cloud-ops-agent running.
#
# Usage (single line):  sudo /opt/revup/scripts/fs-watchdog/install_fs_watchdog.sh
# =============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: run with sudo" >&2
    exit 1
fi

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SRC_DIR}/../.." && pwd)"

say() { echo "==> $*"; }

# --- sanity: this only makes sense where the media stack runs ---------------
if ! command -v docker > /dev/null 2>&1; then
    echo "ERROR: docker not found — this installer is for the media (FreeSWITCH) VMs" >&2
    exit 1
fi
if ! docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q '^voip-freeswitch$'; then
    say "WARNING: no voip-freeswitch container on this host — installing anyway; the watchdog WILL page in ~2 min unless docker-compose.media.yml is up (or FS_WATCHDOG_CONTAINER is overridden in /etc/revup/fs-watchdog.env)"
fi
if ! systemctl is-active --quiet google-cloud-ops-agent; then
    say "WARNING: google-cloud-ops-agent is not active — revup-alert lines will NOT reach Cloud Logging/paging. Fix: sudo bash /opt/revup/scripts/monitoring/install_ops_agent.sh"
fi

# --- units + script ----------------------------------------------------------
chmod +x "${SRC_DIR}/fs_watchdog.sh"
install -m 0644 "${SRC_DIR}/systemd/revup-fs-watchdog.service" "${SRC_DIR}/systemd/revup-fs-watchdog.timer" /etc/systemd/system/
# Shared generic failure->page relay (same unit the services VM uses).
install -m 0644 "${REPO_ROOT}/scripts/backup/systemd/revup-alert@.service" /etc/systemd/system/
mkdir -p /etc/revup
systemctl daemon-reload
say "units installed to /etc/systemd/system"

# --- enable ------------------------------------------------------------------
systemctl enable --now revup-fs-watchdog.timer
say "revup-fs-watchdog.timer enabled (60s tick, pages after 2 consecutive fails)"

echo
systemctl list-timers --no-pager 'revup-fs-*' || true
echo
say "done. Smoke-test now (single line): sudo systemctl start revup-fs-watchdog.service && journalctl -u revup-fs-watchdog.service -n 10 --no-pager && sudo cat /run/revup/fs-watchdog.state"
