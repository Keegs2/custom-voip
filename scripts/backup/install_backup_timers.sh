#!/usr/bin/env bash
# =============================================================================
# Install/refresh the revup backup systemd units on the SERVICES VM.
# =============================================================================
# Encodes the host schedule in the repo (no ad-hoc VM cron): copies the units
# from scripts/backup/systemd/ into /etc/systemd/system, installs
# /etc/revup/backup.env from the example if absent, creates the work dir, and
# enables the timers. Idempotent — re-run after any `git pull` that touches
# scripts/backup/ to pick up changes.
#
# Enabled schedule:
#   revup-pgdump.timer            daily 07:17 UTC  (nightly logical dump -> GCS)
#   revup-cdr-archive.timer       monthly 1st 06:30 UTC (CDR export -> GCS)
#   revup-slot-wal-guard.timer    every 15 min     (slot WAL watchdog)
#   revup-pgbackrest-full.timer   Sun 05:45 UTC    (only if the stanza exists)
#   revup-pgbackrest-diff.timer   Mon-Sat 05:45 UTC (only if the stanza exists)
#
# Usage (single line):  sudo /opt/revup/scripts/backup/install_backup_timers.sh
# =============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: run with sudo" >&2
    exit 1
fi

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
UNIT_SRC="${SRC_DIR}/systemd"

say() { echo "==> $*"; }

# --- Config + work dir -------------------------------------------------------
mkdir -p /etc/revup
if [ ! -f /etc/revup/backup.env ]; then
    install -m 0644 "${SRC_DIR}/backup.env.example" /etc/revup/backup.env
    say "installed /etc/revup/backup.env from example — review the bucket name"
else
    say "/etc/revup/backup.env already present — leaving it alone"
fi
install -d -o postgres -g postgres -m 0750 /var/backups/revup
say "work dir /var/backups/revup ready (postgres-owned)"

# --- Units -------------------------------------------------------------------
install -m 0644 "${UNIT_SRC}"/revup-*.service "${UNIT_SRC}"/revup-*.timer /etc/systemd/system/
chmod +x "${SRC_DIR}"/pg_dump_nightly.sh "${SRC_DIR}"/cdr_archive_monthly.sh "${SRC_DIR}"/slot_wal_guard.sh
systemctl daemon-reload
say "units installed to /etc/systemd/system"

# --- Enable timers -----------------------------------------------------------
systemctl enable --now revup-pgdump.timer revup-cdr-archive.timer revup-slot-wal-guard.timer

# pgBackRest timers only make sense once the stanza exists (setup_pgbackrest.sh);
# enabling them earlier would just generate failure pages.
if sudo -u postgres pgbackrest --stanza=main info > /dev/null 2>&1; then
    systemctl enable --now revup-pgbackrest-full.timer revup-pgbackrest-diff.timer
    say "pgBackRest timers enabled (stanza 'main' found)"
else
    say "SKIPPED pgBackRest timers — stanza not initialized yet. Run: sudo /opt/revup/scripts/backup/setup_pgbackrest.sh — then re-run this installer"
fi

echo
systemctl list-timers --no-pager 'revup-*' || true
echo
say "done. Smoke-test the nightly dump now (single line): sudo systemctl start revup-pgdump.service && journalctl -u revup-pgdump.service -n 20 --no-pager"
