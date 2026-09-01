#!/usr/bin/env bash
# =============================================================================
# Show the LIVE values of every PG setting apply_pg_32gb.sh touches (read-only).
# =============================================================================
# Run before AND after the tuning restart so the change is verifiable:
#   before: values from the old config (source = default / configuration file /
#           postgresql.auto.conf), pending_restart=f
#   after apply (pre-restart): unchanged values; shared_buffers etc. may show
#           pending_restart=t once the file is read by a reload
#   after restart: new values, source=configuration file, sourcefile ending in
#           conf.d/90-revup-32gb.conf
#
# Also prints context (MemTotal, max_connections, hash_mem_multiplier — the
# PG16 default of 2.0 is why work_mem is 32MB not 64MB) and whether the
# drop-in file exists. Zero writes; safe anywhere, but only meaningful on the
# services VM (the PG primary).
#
# Usage (single line):  sudo /opt/revup/scripts/services-tuning/show_pg_tuning.sh
# =============================================================================
set -u

echo "== revup PG 32GB tuning — live values — $(hostname) — $(date -u +%FT%TZ) =="
echo "MemTotal: $(awk '/^MemTotal:/{printf "%d MiB", $2/1024}' /proc/meminfo)"

if ! sudo -u postgres psql -X -tAc "SELECT 1" > /dev/null 2>&1; then
    echo "ERROR: cannot reach PostgreSQL as postgres via local socket — is this the services VM?" >&2
    exit 1
fi

DROPIN_GLOB=(/etc/postgresql/*/*/conf.d/90-revup-32gb.conf)
if [ -f "${DROPIN_GLOB[0]}" ]; then
    echo "drop-in: ${DROPIN_GLOB[0]} (present)"
else
    echo "drop-in: NOT present (apply_pg_32gb.sh not run yet, or rolled back)"
fi

sudo -u postgres psql -X -P pager=off -c "
SELECT name,
       setting || COALESCE(' ' || unit, '') AS value,
       source,
       COALESCE(sourcefile, '')             AS sourcefile,
       pending_restart
FROM pg_settings
WHERE name IN ('shared_buffers',
               'effective_cache_size',
               'maintenance_work_mem',
               'work_mem',
               'wal_buffers',
               'checkpoint_completion_target',
               'random_page_cost',
               'effective_io_concurrency',
               'autovacuum_vacuum_cost_limit',
               -- context (NOT touched by the tuning — sanity/justification):
               'hash_mem_multiplier',
               'max_connections',
               'max_worker_processes',
               'shared_preload_libraries')
ORDER BY name;
"

echo "== read-only; nothing was changed =="
