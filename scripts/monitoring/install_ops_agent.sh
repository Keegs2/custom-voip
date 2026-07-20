#!/usr/bin/env bash
# =============================================================================
# Install the Google Cloud Ops Agent on a revup VM (all 4 production VMs).
# =============================================================================
# The agent's DEFAULTS provide everything infra/monitoring alerts on:
#   - host metrics: cpu / memory / disk / network  (disk>85% + memory alerts)
#   - syslog shipping to Cloud Logging             (the revup-alert page hook)
#
# On the SERVICES VM only, `--with-heplify-prom` additionally installs a config
# that scrapes heplify-server's Prometheus metrics (127.0.0.1:9096, published
# loopback-only by docker-compose.services.yml) into Managed Prometheus.
#
# Idempotent — safe to re-run after `git pull` to refresh the config.
#
# Usage (single line, per VM):
#   sudo bash /opt/revup/scripts/monitoring/install_ops_agent.sh
# Services VM with heplify scrape (single line):
#   sudo bash /opt/revup/scripts/monitoring/install_ops_agent.sh --with-heplify-prom
# =============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: run with sudo" >&2
    exit 1
fi

WITH_HEPLIFY=false
[ "${1:-}" = "--with-heplify-prom" ] && WITH_HEPLIFY=true

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Install (official Google one-liner, pinned to their repo script) --------
if systemctl list-unit-files google-cloud-ops-agent.service > /dev/null 2>&1 \
    && systemctl is-enabled google-cloud-ops-agent > /dev/null 2>&1; then
    echo "==> Ops Agent already installed"
else
    echo "==> installing Google Cloud Ops Agent"
    curl -sS https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh | bash -s -- --also-install
fi

# --- Optional heplify Prometheus receiver (services VM) ----------------------
if [ "$WITH_HEPLIFY" = "true" ]; then
    echo "==> enabling heplify Prometheus scrape (127.0.0.1:9096)"
    mkdir -p /etc/google-cloud-ops-agent
    install -m 0644 "${SRC_DIR}/ops-agent-config.services.yaml" /etc/google-cloud-ops-agent/config.yaml
fi

systemctl restart google-cloud-ops-agent
sleep 3
systemctl --no-pager --quiet is-active google-cloud-ops-agent && echo "==> Ops Agent active" || {
    echo "ERROR: agent not active — check: sudo journalctl -u google-cloud-ops-agent -n 50" >&2
    exit 1
}

echo "==> verify in ~2 min: Cloud Console -> Monitoring -> Metrics explorer -> agent.googleapis.com/disk/percent_used for $(hostname)"
echo "==> test the paging hook (fires the revup-alert policy): logger -p user.err -t revup-alert -- 'test page — ignore'"
