#!/usr/bin/env bash
# =============================================================================
# Backup preflight — verify the services VM can actually run the backup stack.
# =============================================================================
# Read-mostly checks (the only write is a small GCS probe object, removed
# after). Run BEFORE setup_pgbackrest.sh / install_backup_timers.sh, and any
# time backups misbehave.
#
# Usage (single line):  sudo /opt/revup/scripts/backup/preflight.sh
# =============================================================================
set -u

[ -f /etc/revup/backup.env ] && . /etc/revup/backup.env
BACKUP_BUCKET="${BACKUP_BUCKET:-revup-db-backups}"
BACKUP_DB="${BACKUP_DB:-voip}"
BACKUP_WORK_DIR="${BACKUP_WORK_DIR:-/var/backups/revup}"

PASS=0; FAIL=0; WARN=0
ok()   { echo "PASS  $*"; PASS=$((PASS + 1)); }
bad()  { echo "FAIL  $*"; FAIL=$((FAIL + 1)); }
warn() { echo "WARN  $*"; WARN=$((WARN + 1)); }

echo "== revup backup preflight — $(hostname) — $(date -u +%FT%TZ) =="

# --- PostgreSQL --------------------------------------------------------------
if sudo -u postgres psql -X -tAc "SELECT 1" > /dev/null 2>&1; then
    ok "PostgreSQL reachable via local socket as postgres"
    PGVER="$(sudo -u postgres psql -X -tAc "SHOW server_version")"
    ok "server_version=${PGVER}"
    WAL_LEVEL="$(sudo -u postgres psql -X -tAc "SHOW wal_level")"
    if [ "$WAL_LEVEL" = "replica" ] || [ "$WAL_LEVEL" = "logical" ]; then
        ok "wal_level=${WAL_LEVEL} (adequate for WAL archiving)"
    else
        bad "wal_level=${WAL_LEVEL} — must be replica/logical for pgBackRest"
    fi
    AM="$(sudo -u postgres psql -X -tAc "SHOW archive_mode")"
    [ "$AM" = "on" ] && ok "archive_mode=on" || warn "archive_mode=${AM} (setup_pgbackrest.sh will set it; needs one PG restart)"
    if sudo -u postgres psql -X -tAc "SELECT 1 FROM pg_database WHERE datname='${BACKUP_DB}'" | grep -q 1; then
        ok "database '${BACKUP_DB}' exists"
    else
        bad "database '${BACKUP_DB}' not found"
    fi
    SLOTS="$(sudo -u postgres psql -X -tAc "SELECT count(*) FROM pg_replication_slots")"
    ok "replication slots present: ${SLOTS} (slot_wal_guard will watch them)"
else
    bad "cannot reach PostgreSQL as postgres via local socket — is this the services VM?"
fi

# --- Tooling -----------------------------------------------------------------
command -v pgbackrest > /dev/null 2>&1 \
    && ok "pgbackrest installed ($(pgbackrest version 2>/dev/null | head -1))" \
    || warn "pgbackrest not installed — run: sudo apt-get update && sudo apt-get install -y pgbackrest"
command -v gcloud > /dev/null 2>&1 || command -v gsutil > /dev/null 2>&1 \
    && ok "gcloud/gsutil present" \
    || bad "neither gcloud nor gsutil found — GCS uploads impossible"

# --- GCE service account + scopes (the classic silent blocker) ---------------
MD="http://metadata.google.internal/computeMetadata/v1"
if SCOPES="$(curl -s -f -H 'Metadata-Flavor: Google' "${MD}/instance/service-accounts/default/scopes" 2>/dev/null)"; then
    SA="$(curl -s -f -H 'Metadata-Flavor: Google' "${MD}/instance/service-accounts/default/email" 2>/dev/null)"
    ok "VM service account: ${SA}"
    if echo "$SCOPES" | grep -Eq 'cloud-platform|devstorage\.(read_write|full_control)'; then
        ok "access scopes allow GCS writes"
    else
        bad "VM access scopes do NOT allow GCS writes (found: $(echo "$SCOPES" | tr '\n' ' ')). Fix option A (needs VM stop/start — brief FULL new-call outage since PG lives here, schedule it): gcloud compute instances set-service-account services --zone=us-east1-b --scopes=cloud-platform ; Fix option B (no restart): use a dedicated SA key at /etc/pgbackrest/gcs-key.json and set repo1-gcs-key-type=service in /etc/pgbackrest/pgbackrest.conf"
    fi
else
    warn "not on GCE (no metadata server) — skipping scope check"
fi

# --- Bucket write probe ------------------------------------------------------
PROBE="gs://${BACKUP_BUCKET}/preflight/$(hostname)_$(date -u +%s).txt"
if command -v gcloud > /dev/null 2>&1 && echo "preflight" | gcloud storage cp - "$PROBE" --quiet 2> /dev/null; then
    ok "GCS write probe succeeded (${PROBE})"
    gcloud storage rm "$PROBE" --quiet 2> /dev/null || true
elif command -v gsutil > /dev/null 2>&1 && echo "preflight" | gsutil -q cp - "$PROBE" 2> /dev/null; then
    ok "GCS write probe succeeded via gsutil (${PROBE})"
    gsutil -q rm "$PROBE" 2> /dev/null || true
else
    bad "cannot write to gs://${BACKUP_BUCKET} — create it first (infra/backups: tofu apply) and check IAM/scopes above"
fi

# --- Disk headroom -----------------------------------------------------------
mkdir -p "$BACKUP_WORK_DIR" 2> /dev/null || true
AVAIL_KB="$(df -Pk "$BACKUP_WORK_DIR" 2>/dev/null | awk 'NR==2{print $4}')"
DB_KB="$(sudo -u postgres psql -X -tAc "SELECT pg_database_size('${BACKUP_DB}')/1024" 2>/dev/null || echo 0)"
DB_KB="${DB_KB//[^0-9]/}"
DB_KB="${DB_KB:-0}"
if [ -n "${AVAIL_KB:-}" ] && [ "${AVAIL_KB:-0}" -gt "$((DB_KB + 1048576))" ]; then
    ok "disk headroom for local dump: $((AVAIL_KB / 1024)) MiB free vs DB $((DB_KB / 1024)) MiB"
else
    warn "low disk headroom for local dumps: $((${AVAIL_KB:-0} / 1024)) MiB free vs DB $((DB_KB / 1024)) MiB — dumps are compressed so this may still fit, but watch it"
fi

# --- Systemd timers ----------------------------------------------------------
if systemctl list-timers 2>/dev/null | grep -q revup-pgdump; then
    ok "revup backup timers installed ($(systemctl list-timers --no-legend 'revup-*' 2>/dev/null | wc -l | tr -d ' ') active)"
else
    warn "backup timers not installed yet — run: sudo /opt/revup/scripts/backup/install_backup_timers.sh"
fi

echo "== result: ${PASS} pass, ${WARN} warn, ${FAIL} fail =="
[ "$FAIL" -eq 0 ]
