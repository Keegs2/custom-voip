#!/usr/bin/env bash
# =============================================================================
# Nightly logical backup of the production voip database -> versioned GCS.
# =============================================================================
# Layer 1 of the backup strategy (crude safety net; pgBackRest is the real
# PITR layer — see scripts/backup/README.md). Runs on the SERVICES VM where
# bare-metal PostgreSQL 16 + TimescaleDB live.
#
# What it does, in order:
#   1. pg_dump -Fc of $BACKUP_DB (custom format, compressed)
#   2. pg_dumpall --globals-only (roles/passwords — pg_dump does NOT include them)
#   3. Integrity check: pg_restore --list on the dump (catches truncated files)
#   4. Upload both to gs://$BACKUP_BUCKET/pgdump/<UTC timestamp>/
#   5. Prune local copies older than $BACKUP_LOCAL_KEEP_DAYS days
#
# Auth: GCS writes use the VM's attached service account via the metadata
# server (no key files). The service account needs objectAdmin on the bucket
# (granted by infra/backups) AND the VM's access scopes must permit storage
# writes — run scripts/backup/preflight.sh first to verify both.
#
# Failure behavior: any step failing exits non-zero; the systemd unit's
# OnFailure= fires revup-alert@ which writes a "revup-alert" syslog line that
# Cloud Monitoring pages on (see infra/monitoring).
#
# Manual run (single line):  sudo /opt/revup/scripts/backup/pg_dump_nightly.sh
#
# TimescaleDB restore caveat: restoring this dump requires
# timescaledb_pre_restore()/timescaledb_post_restore() — see
# docs/runbooks/DB_RESTORE_RUNBOOK.md. A dump you have not restored is not a
# backup: run the drill.
# =============================================================================
set -euo pipefail

# Config: systemd passes EnvironmentFile=/etc/revup/backup.env; source it for
# manual runs too, then apply defaults.
[ -f /etc/revup/backup.env ] && . /etc/revup/backup.env
BACKUP_BUCKET="${BACKUP_BUCKET:-revup-db-backups}"
BACKUP_DB="${BACKUP_DB:-voip}"
BACKUP_WORK_DIR="${BACKUP_WORK_DIR:-/var/backups/revup}"
BACKUP_LOCAL_KEEP_DAYS="${BACKUP_LOCAL_KEEP_DAYS:-2}"

# Everything DB-side must run as postgres (peer auth on the local socket).
# Re-exec so both `sudo script` and the User=postgres systemd unit work.
if [ "$(id -un)" != "postgres" ]; then
    exec sudo -u postgres -- "$0" "$@"
fi

TS="$(date -u +%Y%m%d_%H%M%S)"
OUT_DIR="${BACKUP_WORK_DIR}/pgdump"
DUMP_FILE="${OUT_DIR}/${BACKUP_DB}_${TS}.dump"
GLOBALS_FILE="${OUT_DIR}/globals_${TS}.sql.gz"
DEST="gs://${BACKUP_BUCKET}/pgdump/${TS}"

log() { logger -t revup-backup -- "pgdump: $*"; echo "[pg_dump_nightly] $*"; }

mkdir -p "$OUT_DIR"

log "starting nightly dump of ${BACKUP_DB} -> ${DEST}"

# 1. Main database, custom format (parallel-restorable, compressed).
pg_dump --format=custom --compress=6 --file="$DUMP_FILE" "$BACKUP_DB"

# 2. Cluster globals (roles + grants) — required to rebuild a fresh server.
pg_dumpall --globals-only | gzip -6 > "$GLOBALS_FILE"

# 3. Integrity check — pg_restore --list fails on a truncated/corrupt archive.
pg_restore --list "$DUMP_FILE" > /dev/null

DUMP_SIZE="$(du -h "$DUMP_FILE" | cut -f1)"
log "dump complete (${DUMP_SIZE}); uploading"

# 4. Upload. Prefer `gcloud storage` (bundled on GCE images); fall back to gsutil.
if command -v gcloud > /dev/null 2>&1; then
    gcloud storage cp "$DUMP_FILE" "$GLOBALS_FILE" "${DEST}/" --quiet
else
    gsutil -q cp "$DUMP_FILE" "$GLOBALS_FILE" "${DEST}/"
fi

# Verify the upload landed (list must return both objects).
if command -v gcloud > /dev/null 2>&1; then
    UPLOADED="$(gcloud storage ls "${DEST}/" | wc -l | tr -d ' ')"
else
    UPLOADED="$(gsutil ls "${DEST}/" | wc -l | tr -d ' ')"
fi
if [ "$UPLOADED" -lt 2 ]; then
    log "ERROR: upload verification failed — expected 2 objects at ${DEST}, found ${UPLOADED}"
    exit 1
fi

# 5. Prune local copies (GCS lifecycle governs remote retention).
find "$OUT_DIR" -type f -mtime "+${BACKUP_LOCAL_KEEP_DAYS}" -delete

log "OK — ${DEST} (size ${DUMP_SIZE})"
