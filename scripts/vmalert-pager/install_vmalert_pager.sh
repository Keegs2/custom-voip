#!/usr/bin/env bash
# =============================================================================
# Install/refresh the vmalert pager on the SERVICES VM (where voip-vmalert runs).
# =============================================================================
# Encodes the host schedule in the repo (no ad-hoc VM cron): copies the units
# from scripts/vmalert-pager/systemd/ (plus the shared revup-alert@ page relay
# from scripts/backup/systemd/) into /etc/systemd/system and enables the 60s
# timer. Idempotent — re-run after any `git pull` that touches
# scripts/vmalert-pager/ to pick up changes.
#
# What it pages: any vmalert `alert:` rule (docker/vmalert/rules/*.yml) that
# transitions to FIRING — vmalert has no notifier/Alertmanager, so without this
# relay those alerts were visible only in vmalert's UI. Pages through the
# EXISTING revup-alert log-match policy via the Ops Agent; zero new GCP
# resources. Also pages once if the vmalert API itself stays unreachable.
# Prereqs (already true on the services VM): google-cloud-ops-agent running,
# curl + python3 present, docker-compose.services.yml up (voip-vmalert :8880).
#
# Usage (single line):  sudo /opt/revup/scripts/vmalert-pager/install_vmalert_pager.sh
# =============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: run with sudo" >&2
    exit 1
fi

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SRC_DIR}/../.." && pwd)"

say() { echo "==> $*"; }

# --- sanity: this only makes sense where vmalert runs --------------------------
if ! command -v docker > /dev/null 2>&1; then
    echo "ERROR: docker not found — this installer is for the services VM (voip-vmalert)" >&2
    exit 1
fi
for bin in curl python3; do
    if ! command -v "${bin}" > /dev/null 2>&1; then
        say "WARNING: ${bin} not found — the pager needs it; the unit will fail and OnFailure will page the generic line until it is installed"
    fi
done
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^voip-vmalert$'; then
    say "WARNING: voip-vmalert container is not running on this host — installing anyway; the pager WILL page 'vmalert API unreachable' in ~5 min unless docker-compose.services.yml is up (or VMALERT_PAGER_API_URL is overridden in /etc/revup/vmalert-pager.env)"
fi
if ! systemctl is-active --quiet google-cloud-ops-agent; then
    say "WARNING: google-cloud-ops-agent is not active — revup-alert lines will NOT reach Cloud Logging/paging. Fix: sudo bash /opt/revup/scripts/monitoring/install_ops_agent.sh"
fi

# --- units + script ------------------------------------------------------------
chmod +x "${SRC_DIR}/vmalert_pager.sh"
install -m 0644 "${SRC_DIR}/systemd/revup-vmalert-pager.service" "${SRC_DIR}/systemd/revup-vmalert-pager.timer" /etc/systemd/system/
# Shared generic failure->page relay (same unit the backup timers + fs-watchdog use).
install -m 0644 "${REPO_ROOT}/scripts/backup/systemd/revup-alert@.service" /etc/systemd/system/
mkdir -p /etc/revup
systemctl daemon-reload
say "units installed to /etc/systemd/system"

# --- enable --------------------------------------------------------------------
systemctl enable --now revup-vmalert-pager.timer
say "revup-vmalert-pager.timer enabled (60s tick; pages each newly-firing vmalert alert once, API-unreachable after 5 consecutive failed polls)"

echo
systemctl list-timers --no-pager 'revup-vmalert-*' || true
echo
say "done. Smoke-test now (single line): sudo systemctl start revup-vmalert-pager.service && journalctl -u revup-vmalert-pager.service -n 5 --no-pager && sudo cat /run/revup/vmalert-pager.state"
