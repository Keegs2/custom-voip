#!/usr/bin/env bash
# Backfill the SIP number index (qryn.sip_number_index) from qryn.samples_v3,
# ONE UTC DAY AT A TIME, NEWEST DAY FIRST, so recent days become searchable
# soonest. Resumable and idempotent:
#   * a day with a 'backfill' coverage row that started after the MV was
#     created is skipped ("already filled");
#   * re-running a day (after a failure, or with --redo) only re-inserts
#     rows the AggregatingMergeTree collapses (min/max/argMax), so no
#     duplicates are ever visible.
# Each day is inserted as 24 hourly INSERT ... SELECT statements, each capped
# (max_memory_usage 5e8 — an hour of SIP is ~25 MB; well under the 4e9 per-query limit —
# max_execution_time 900 s, max_threads 2) so the backfill can never starve
# heplify/qryn ingest or the API. A failed hour aborts the run with a non-zero
# exit; that day stays uncovered (the API keeps falling back for it) until a
# re-run completes it.
#
# The SELECT is read from docker/homer/clickhouse/10_sip_number_index.sql
# (between the BEGIN/END markers) — the same text the materialized view runs.
#
# PREREQUISITE: 10_sip_number_index.sql applied (the MV must exist first, or
# rows inserted between the backfill and the MV would be missed — the script
# refuses to run without it).
#
# Usage (services VM, single line; NOT during SBC flips or other maintenance
# steps — it adds ClickHouse load on the services VM):
#   sudo bash /opt/revup/scripts/homer/backfill_sip_number_index.sh
# Options: --days N (default 8: today + 7 days back, the qryn retention)
#          --redo YYYY-MM-DD (re-run one day even if already filled)
#          --dry-run (print the plan; no writes)
# Env: CH_CLIENT (default "docker exec -i voip-clickhouse clickhouse-client"),
#      CH_DB (default qryn), SQL_FILE (default: the repo DDL file).
set -euo pipefail

DAYS=8
REDO=""
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --days) DAYS="$2"; shift 2 ;;
    --redo) REDO="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
case "$DAYS" in ''|*[!0-9]*) echo "--days must be a number" >&2; exit 2 ;; esac
if [ -n "$REDO" ] && ! [[ "$REDO" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  echo "--redo must be YYYY-MM-DD" >&2; exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_FILE="${SQL_FILE:-$HERE/../../docker/homer/clickhouse/10_sip_number_index.sql}"
CH_DB="${CH_DB:-qryn}"
read -r -a CH <<< "${CH_CLIENT:-docker exec -i voip-clickhouse clickhouse-client}"
if ! [[ "$CH_DB" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then echo "bad CH_DB" >&2; exit 2; fi

LOCK=/tmp/sip_number_index_backfill.lock
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK"
  flock -n 9 || { echo "another backfill is running (lock $LOCK)" >&2; exit 1; }
fi

chq() { printf '%s' "$1" | "${CH[@]}"; }

MARK='/*BACKFILL_RANGE*/'
SELECT_SQL="$(sed -n '/^-- BEGIN sip_number_index extract$/,/^-- END sip_number_index extract$/p' "$SQL_FILE" | sed '1d;$d')"
if [ -z "$SELECT_SQL" ] || ! grep -q '/\*BACKFILL_RANGE\*/' <<< "$SELECT_SQL"; then
  echo "could not read the extract SELECT (markers) from $SQL_FILE" >&2; exit 1
fi
if [ "$CH_DB" != "qryn" ]; then SELECT_SQL="${SELECT_SQL//qryn.samples_v3/$CH_DB.samples_v3}"; fi

have=$(chq "SELECT count() FROM system.tables WHERE database = '$CH_DB' AND name IN ('sip_number_index', 'sip_number_index_mv', 'sip_number_index_coverage')")
if [ "$have" != "3" ]; then
  echo "index objects missing ($have/3): apply docker/homer/clickhouse/10_sip_number_index.sql first" >&2; exit 1
fi
# The MV start = the later of its creation time and its 'mv' coverage row.
MV_SINCE_MS=$(chq "SELECT greatest((SELECT toUnixTimestamp(metadata_modification_time) * 1000 FROM system.tables WHERE database = '$CH_DB' AND name = 'sip_number_index_mv'), (SELECT toInt64(ifNull(max(toUnixTimestamp64Milli(started_at)), 0)) FROM $CH_DB.sip_number_index_coverage FINAL WHERE kind = 'mv'))")
echo "materialized view capturing since $(chq "SELECT toString(fromUnixTimestamp64Milli(toInt64($MV_SINCE_MS), 'UTC'))") UTC"

SETTINGS="SETTINGS max_memory_usage = 500000000, max_execution_time = 900, max_threads = 2, max_insert_threads = 1"
DAY_LIST=()
if [ -n "$REDO" ]; then
  DAY_LIST=("$REDO")
else
  while IFS= read -r line; do DAY_LIST+=("$line"); done < <(chq "SELECT toString(today() - number) FROM numbers($DAYS) ORDER BY number")
fi

total_start=$SECONDS
for D in "${DAY_LIST[@]}"; do
  done_rows=$(chq "SELECT count() FROM $CH_DB.sip_number_index_coverage FINAL WHERE kind = 'backfill' AND day = toDate('$D') AND toUnixTimestamp64Milli(started_at) >= $MV_SINCE_MS")
  if [ "$done_rows" != "0" ] && [ -z "$REDO" ]; then
    echo "$D already filled — skipped"
    continue
  fi
  day_s=$(chq "SELECT toUnixTimestamp(toDateTime(toDate('$D'), 'UTC'))")
  if [ "$DRY" = "1" ]; then
    echo "$D would be filled (24 hourly inserts from $day_s)"
    continue
  fi
  started_ms=$(chq "SELECT toUnixTimestamp64Milli(now64(3))")
  t0=$SECONDS
  for h in $(seq 0 23); do
    lo=$(( (day_s + h * 3600) * 1000000000 ))
    hi=$(( (day_s + (h + 1) * 3600) * 1000000000 ))
    range="AND timestamp_ns >= $lo AND timestamp_ns < $hi"
    if ! chq "INSERT INTO $CH_DB.sip_number_index ${SELECT_SQL/"$MARK"/$range} $SETTINGS"; then
      echo "FAILED: $D hour $h — the day is NOT marked filled; re-run the same command to resume" >&2
      exit 1
    fi
  done
  rows=$(chq "SELECT count() FROM $CH_DB.sip_number_index WHERE day = toDate('$D')")
  chq "INSERT INTO $CH_DB.sip_number_index_coverage (kind, day, started_at, finished_at, index_rows, note) VALUES ('backfill', toDate('$D'), fromUnixTimestamp64Milli(toInt64($started_ms), 'UTC'), now64(3, 'UTC'), $rows, 'backfill_sip_number_index.sh')"
  echo "$D filled in $(( SECONDS - t0 )) s ($rows index rows before merges)"
done
echo "backfill finished in $(( SECONDS - total_start )) s"
echo "coverage now: $(chq "SELECT arrayStringConcat(groupArray(toString(day)), ' ') FROM (SELECT day FROM $CH_DB.sip_number_index_coverage FINAL WHERE kind = 'backfill' ORDER BY day DESC)")"
