#!/usr/bin/env bash
# =============================================================================
# Replication-slot WAL watchdog — pages before a dead standby fills the disk.
# =============================================================================
# THE TRAP (audit finding): the sandbox standby streams from prod via the
# `sandbox_replica` physical slot (infra/replica/). A physical slot makes the
# primary RETAIN WAL until the standby consumes it. If the standby is down or
# unreachable, prod retains WAL forever and silently fills the services VM
# disk — taking down PostgreSQL and with it 100% of new-call DID lookups.
#
# Two defenses, both delivered by this repo:
#   1. max_slot_wal_keep_size='16GB' (set by setup_pgbackrest.sh) — hard cap:
#      PostgreSQL invalidates the slot instead of dying. The standby then
#      needs a re-clone (re-run its pg_basebackup bootstrap) — annoying,
#      survivable. The alternative is a prod outage.
#   2. This watchdog (every 15 min via systemd timer): logs retained-WAL per
#      slot for trending, and emits a "revup-alert" syslog line when a slot
#      retains > $SLOT_WAL_ALERT_BYTES or its wal_status degrades — Cloud
#      Monitoring's log-match policy (infra/monitoring) pages on that tag.
#
# Manual run (single line):  sudo /opt/revup/scripts/backup/slot_wal_guard.sh
# =============================================================================
set -euo pipefail

[ -f /etc/revup/backup.env ] && . /etc/revup/backup.env
SLOT_WAL_ALERT_BYTES="${SLOT_WAL_ALERT_BYTES:-8589934592}" # 8 GiB

if [ "$(id -un)" != "postgres" ]; then
    exec sudo -u postgres -- "$0" "$@"
fi

# slot_name|active|wal_status|retained_bytes  (physical + logical slots)
ROWS="$(psql -X -tA -F'|' -c \
    "SELECT slot_name, active::text, coalesce(wal_status,'unknown'),
            coalesce(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn), 0)::bigint
     FROM pg_replication_slots")"

if [ -z "$ROWS" ]; then
    logger -t revup-backup -- "slot-wal-guard: no replication slots present"
    exit 0
fi

STATUS=0
while IFS='|' read -r slot active wal_status retained; do
    [ -z "$slot" ] && continue
    # Always log an info line — Cloud Logging keeps the trend.
    logger -t revup-backup -- "slot-wal-guard: slot=${slot} active=${active} wal_status=${wal_status} retained_bytes=${retained}"

    if [ "$wal_status" = "lost" ] || [ "$wal_status" = "unreserved" ]; then
        logger -p user.err -t revup-alert -- "replication-slot slot=${slot} wal_status=${wal_status} — slot invalidated or at the max_slot_wal_keep_size cap; the standby needs a re-clone (see infra/replica/README.md)"
        STATUS=1
    elif [ "$retained" -gt "$SLOT_WAL_ALERT_BYTES" ]; then
        logger -p user.err -t revup-alert -- "replication-slot slot=${slot} retained_bytes=${retained} exceeds ${SLOT_WAL_ALERT_BYTES} — standby down/lagging? Prod disk at risk. Check the sandbox standby, or drop the slot: SELECT pg_drop_replication_slot('${slot}');"
        STATUS=1
    fi
done <<< "$ROWS"

exit "$STATUS"
