#!/usr/bin/env bash
# =============================================================================
# HA replication watchdog — pages when the East hot standby disconnects or lags
# =============================================================================
# Runs on the PRIMARY (services VM). Complements slot_wal_guard.sh (which caps
# the WAL a slot may retain, protecting the disk); THIS one answers "is the
# failover target actually connected and caught up?" — so a silently dead or
# lagging standby (lost / degraded HA) pages BEFORE you need to fail onto it.
#
# Pages via the shared revup-alert syslog hook (the Cloud Monitoring log-match
# policy in infra/monitoring). No new GCP/Terraform resources.
#
# Tunables (via /etc/revup/backup.env):
#   REPL_GUARD_STANDBY_IP  the HA standby's IP           (default 10.142.0.87)
#   REPL_GUARD_LAG_MB      page above this byte-lag (MB)  (default 256)
#
# Manual run:  sudo /opt/revup/scripts/backup/replication_guard.sh
# =============================================================================
set -euo pipefail

[ -f /etc/revup/backup.env ] && . /etc/revup/backup.env
REPL_GUARD_STANDBY_IP="${REPL_GUARD_STANDBY_IP:-10.142.0.87}"
REPL_GUARD_LAG_MB="${REPL_GUARD_LAG_MB:-256}"

if [ "$(id -un)" != "postgres" ]; then
    exec sudo -u postgres -- "$0" "$@"
fi

# Byte-lag (MB) of the HA standby. The subquery returns no row when the standby
# is not connected -> coalesce -> -1 (treated as "HA down").
LAG_MB="$(psql -X -tA -c "SELECT coalesce((SELECT round(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) / 1048576.0) FROM pg_stat_replication WHERE client_addr = '${REPL_GUARD_STANDBY_IP}'), -1)")"

# Not connected at all — HA is gone.
if [ "${LAG_MB:-}" = "-1" ]; then
    logger -p user.err -t revup-alert -- "HA standby ${REPL_GUARD_STANDBY_IP} is NOT connected to the primary — replication down, no failover target. Check east-db-standby (pg_stat_wal_receiver) + the east_standby slot."
    exit 1
fi

# Always log the trend for Cloud Logging.
logger -t revup-backup -- "replication-guard: HA standby ${REPL_GUARD_STANDBY_IP} streaming, lag=${LAG_MB}MB"

# Connected but falling behind — RPO is growing.
if [ "$LAG_MB" -gt "$REPL_GUARD_LAG_MB" ]; then
    logger -p user.err -t revup-alert -- "HA standby ${REPL_GUARD_STANDBY_IP} lag ${LAG_MB}MB exceeds ${REPL_GUARD_LAG_MB}MB — replication falling behind, failover RPO growing."
    exit 1
fi
exit 0
