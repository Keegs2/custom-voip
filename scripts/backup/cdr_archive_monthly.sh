#!/usr/bin/env bash
# =============================================================================
# Monthly CDR archival to GCS — runs BEFORE the 90-day TimescaleDB purge.
# =============================================================================
# WHY: docker/postgres/init/05_schema_cdr.sql adds a 90-day retention policy
# that silently DELETES old CDR chunks. CDRs are billing evidence — this
# exports each completed calendar month to gs://$BACKUP_BUCKET/cdr-archive/
# as compressed CSV so billing data survives the purge indefinitely.
#
# Timing math (why archiving months M-1 and M-2 is always safe): the purge
# drops rows older than 90 days. On the 1st of month M, the oldest row of
# month M-2 is at most ~62 days old — comfortably inside the retention
# window. Each month is therefore archived while fully present, and gets a
# second (idempotent, skipped) pass the following month as a safety margin.
#
# Idempotent: a _COMPLETE marker object per month prevents re-export. Delete
# the marker to force a re-run for that month.
#
# Manual run (single line):  sudo /opt/revup/scripts/backup/cdr_archive_monthly.sh
# Force one month (single line):  sudo /opt/revup/scripts/backup/cdr_archive_monthly.sh 2026-05
# =============================================================================
set -euo pipefail

[ -f /etc/revup/backup.env ] && . /etc/revup/backup.env
BACKUP_BUCKET="${BACKUP_BUCKET:-revup-db-backups}"
BACKUP_DB="${BACKUP_DB:-voip}"
BACKUP_WORK_DIR="${BACKUP_WORK_DIR:-/var/backups/revup}"

if [ "$(id -un)" != "postgres" ]; then
    exec sudo -u postgres -- "$0" "$@"
fi

OUT_DIR="${BACKUP_WORK_DIR}/cdr-archive"
mkdir -p "$OUT_DIR"

log() { logger -t revup-backup -- "cdr-archive: $*"; echo "[cdr_archive_monthly] $*"; }

gcs() { # gcs <cp|ls|cat> args...  — gcloud storage with gsutil fallback
    local op="$1"; shift
    if command -v gcloud > /dev/null 2>&1; then
        gcloud storage "$op" "$@" --quiet 2> /dev/null
    else
        gsutil -q "$op" "$@"
    fi
}

archive_month() {
    local month="$1" # YYYY-MM
    local month_start="${month}-01"
    # First day of the following month (GNU date is standard on the GCE Debian/Ubuntu images).
    local month_end
    month_end="$(date -u -d "${month_start} +1 month" +%Y-%m-%d)"

    local dest="gs://${BACKUP_BUCKET}/cdr-archive/${month}"
    local csv="${OUT_DIR}/cdrs_${month}.csv.gz"

    # Idempotency: skip when this month's _COMPLETE marker already exists.
    if gcs ls "${dest}/_COMPLETE" > /dev/null 2>&1; then
        log "${month}: already archived (marker present) — skipping"
        return 0
    fi

    log "${month}: exporting cdrs [${month_start} .. ${month_end})"

    # Stream server->client->gzip; no superuser COPY TO PROGRAM needed.
    psql -d "$BACKUP_DB" -X -v ON_ERROR_STOP=1 -c \
        "COPY (SELECT * FROM cdrs WHERE start_time >= '${month_start}' AND start_time < '${month_end}' ORDER BY start_time) TO STDOUT WITH (FORMAT csv, HEADER)" \
        | gzip -6 > "$csv"

    local rows
    rows="$(psql -d "$BACKUP_DB" -X -tAc \
        "SELECT count(*) FROM cdrs WHERE start_time >= '${month_start}' AND start_time < '${month_end}'")"
    local sha
    sha="$(sha256sum "$csv" | cut -d' ' -f1)"

    gcs cp "$csv" "${dest}/"

    # Marker carries row count + sha256 so restores can verify completeness.
    printf 'rows=%s\nsha256=%s\nexported_at=%s\n' "$rows" "$sha" "$(date -u +%FT%TZ)" \
        | gcs cp - "${dest}/_COMPLETE"

    rm -f "$csv"
    log "${month}: OK — ${rows} rows -> ${dest}/ (sha256 ${sha})"
}

if [ "$#" -ge 1 ]; then
    archive_month "$1"
else
    # The two most recent COMPLETED months (see timing math in the header).
    archive_month "$(date -u -d "$(date -u +%Y-%m-01) -1 month" +%Y-%m)"
    archive_month "$(date -u -d "$(date -u +%Y-%m-01) -2 month" +%Y-%m)"
fi

log "monthly CDR archive pass complete"
