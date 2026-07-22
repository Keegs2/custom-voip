#!/usr/bin/env bash
# =============================================================================
# One-time pgBackRest setup on the SERVICES VM (bare-metal PG16 + TimescaleDB).
# =============================================================================
# Idempotent and staged — run it, do what it says, run it again:
#
#   Stage 1 (first run):   installs /etc/pgbackrest/pgbackrest.conf, sets
#                          archive_command / archive_mode / max_slot_wal_keep_size
#                          via ALTER SYSTEM. If archive_mode was off it STOPS and
#                          prints the required PostgreSQL restart command.
#   Stage 2 (after the restart): creates the stanza, runs `pgbackrest check`
#                          (verifies a real WAL segment lands in GCS), and prints
#                          the command to take the first full backup.
#
# !!! The archive_mode restart is a ~5-10 second PostgreSQL restart. During it,
# !!! new-call DID lookups fail (active calls are unaffected). Pick a quiet
# !!! minute. archive_command changes later are reload-only.
#
# Prerequisites (single-line each, run first):
#   sudo apt-get update && sudo apt-get install -y pgbackrest
#   sudo /opt/revup/scripts/backup/preflight.sh
#
# Usage (single line):  sudo /opt/revup/scripts/backup/setup_pgbackrest.sh
# =============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: run with sudo (needs /etc/pgbackrest + ALTER SYSTEM as postgres)" >&2
    exit 1
fi

[ -f /etc/revup/backup.env ] && . /etc/revup/backup.env
BACKUP_BUCKET="${BACKUP_BUCKET:-revup-db-backups}"
STANZA="main"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

say() { echo "==> $*"; }

command -v pgbackrest > /dev/null 2>&1 || {
    echo "ERROR: pgbackrest not installed. Run: sudo apt-get update && sudo apt-get install -y pgbackrest" >&2
    exit 1
}
say "pgbackrest $(pgbackrest version 2>/dev/null || true)"

# --- 1. Config file ----------------------------------------------------------
mkdir -p /etc/pgbackrest /var/log/pgbackrest
sed "s|__BACKUP_BUCKET__|${BACKUP_BUCKET}|g" "${REPO_DIR}/pgbackrest.conf" > /etc/pgbackrest/pgbackrest.conf
chown -R postgres:postgres /var/log/pgbackrest
chown postgres:postgres /etc/pgbackrest/pgbackrest.conf
chmod 0640 /etc/pgbackrest/pgbackrest.conf
say "installed /etc/pgbackrest/pgbackrest.conf (bucket: gs://${BACKUP_BUCKET}/pgbackrest)"

# --- 2. PostgreSQL settings --------------------------------------------------
psql_super() { sudo -u postgres psql -X -tAc "$1"; }

WAL_LEVEL="$(psql_super "SHOW wal_level")"
if [ "$WAL_LEVEL" != "replica" ] && [ "$WAL_LEVEL" != "logical" ]; then
    echo "ERROR: wal_level='${WAL_LEVEL}' — must be replica or logical for WAL archiving." >&2
    echo "Fix (then restart PG): sudo -u postgres psql -c \"ALTER SYSTEM SET wal_level='replica'\"" >&2
    exit 1
fi
say "wal_level=${WAL_LEVEL} (ok)"

ARCHIVE_MODE_BEFORE="$(psql_super "SHOW archive_mode")"

psql_super "ALTER SYSTEM SET archive_command = 'pgbackrest --stanza=${STANZA} archive-push %p'" > /dev/null
psql_super "ALTER SYSTEM SET archive_mode = 'on'" > /dev/null
psql_super "ALTER SYSTEM SET archive_timeout = '300'" > /dev/null
# Slot-WAL disk-fill cap (audit finding): bound WAL retained by a dead standby's
# replication slot. The slot gets invalidated instead of prod's disk filling;
# slot_wal_guard.sh pages when that is about to happen / happens.
psql_super "ALTER SYSTEM SET max_slot_wal_keep_size = '16GB'" > /dev/null
psql_super "SELECT pg_reload_conf()" > /dev/null
say "ALTER SYSTEM applied: archive_command, archive_mode=on, archive_timeout=300, max_slot_wal_keep_size=16GB (+reload)"

if [ "$ARCHIVE_MODE_BEFORE" != "on" ]; then
    cat << EOF

*** RESTART REQUIRED (archive_mode change only takes effect on restart) ***

Run this during a quiet minute (~5-10s of failed new-call lookups; active calls unaffected):

  sudo systemctl restart postgresql@16-main

Then re-run this script to finish (stanza-create + check):

  sudo /opt/revup/scripts/backup/setup_pgbackrest.sh

EOF
    exit 0
fi
say "archive_mode already on — continuing to stanza setup"

# --- 3. Stanza + end-to-end check -------------------------------------------
# stanza-create initializes the repo info files (backup.info + archive.info). It
# is idempotent — safe to run every time (a no-op if the stanza already exists and
# is valid). Do NOT gate this on `pgbackrest info`: info exits 0 even when the
# stanza was never created, which silently skips creation and makes `check` fail on
# a fresh repo with "unable to load info file .../archive.info".
say "ensuring stanza '${STANZA}' exists (stanza-create is idempotent)"
sudo -u postgres pgbackrest --stanza="$STANZA" stanza-create

say "running pgbackrest check (forces a WAL switch and verifies it lands in GCS)..."
sudo -u postgres pgbackrest --stanza="$STANZA" check
say "check PASSED — WAL archiving to gs://${BACKUP_BUCKET}/pgbackrest is live"

cat << EOF

Done. Next steps (single lines):

  1. First full backup NOW (takes minutes, online, safe):
       sudo -u postgres pgbackrest --stanza=main --type=full backup
  2. Install the schedules (weekly full + daily diff + nightly pg_dump + CDR archive + slot guard):
       sudo /opt/revup/scripts/backup/install_backup_timers.sh
  3. Verify state anytime:
       sudo -u postgres pgbackrest --stanza=main info
  4. SCHEDULE THE RESTORE DRILL (a backup you have not restored is not a backup):
       see docs/runbooks/DB_RESTORE_RUNBOOK.md
EOF
