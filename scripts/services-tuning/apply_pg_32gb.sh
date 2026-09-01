#!/usr/bin/env bash
# =============================================================================
# Apply the 32GB-VM PostgreSQL tuning to the East PRIMARY (services VM ONLY).
# =============================================================================
# Companion to the e2-standard-4 (16GB) -> e2-highmem-4 (32GB) resize of the
# `services` VM. Writes ONE conf.d drop-in (90-revup-32gb.conf) with memory /
# planner / autovacuum tuning sized for a 32GB host that also runs the Docker
# services stack (docker-compose.services.yml, ~16.5G of container limits).
# Full budget + rationale: docs/SERVICES_VM_32GB_TUNING.md.
#
# What it does:
#   1. HOSTNAME GUARD — hard-refuses on any host that is not `services`.
#      (A wrong-box paste once wiped a prod PG data dir on this platform —
#      docs/runbooks/DB_RESTORE_RUNBOOK.md. The guard is not optional.)
#   2. Detects the Debian/Ubuntu cluster layout dynamically (pg_lsclusters →
#      version/cluster/datadir; falls back to globbing /etc/postgresql/*/).
#      Bails clearly if the layout is not the expected single-cluster shape.
#   3. Verifies postgresql.conf actually includes conf.d (include_dir) — a
#      drop-in into an un-included directory would be a silent no-op.
#   4. Writes /etc/postgresql/<ver>/<cluster>/conf.d/90-revup-32gb.conf
#      atomically, showing a unified diff of what changed. Idempotent:
#      identical content -> "already applied", no write.
#   5. Scans postgresql.auto.conf (ALTER SYSTEM output — it OVERRIDES conf.d!)
#      for conflicting copies of the params we set and prints the exact
#      one-liner RESET commands if any are found. setup_pgbackrest.sh uses
#      ALTER SYSTEM on this box, so auto.conf exists; local-dev init SQL
#      (01_extensions.sql) also ALTER SYSTEMs several of these params, so a
#      primary ever initialized from it WILL conflict.
#   6. Prints the restart command but NEVER restarts PostgreSQL itself —
#      shared_buffers/wal_buffers need a restart, a restart is a brief
#      East-zone DID-lookup + fleet-wide write blip, and the OPERATOR picks
#      the moment.
#
# Touches ONLY memory/planner/autovacuum tuning. Explicitly does NOT touch:
# max_connections, listen_addresses, wal_level, archive_* / pgBackRest,
# replication (slots, senders, workers), shared_preload_libraries,
# statement_timeout. Nothing here is in the replica >=-primary parameter set
# (max_worker_processes / max_connections / max_locks_per_transaction /
# max_prepared_transactions / max_wal_senders), so the West/Central/standby
# replicas need no matching change.
#
# Pre-resize staging (still 16GB): REVUP_PG_TUNE_FORCE=1 skips the RAM check
# so the file can be staged BEFORE the resize stop/start — PG then boots
# straight into the tuned config when the VM comes back at 32GB (one restart
# total). Do NOT restart PG on a 16GB box with this file in place.
#
# Usage (single line):  sudo /opt/revup/scripts/services-tuning/apply_pg_32gb.sh
# Verify before/after:  sudo /opt/revup/scripts/services-tuning/show_pg_tuning.sh
# Rollback:             sudo rm /etc/postgresql/<ver>/main/conf.d/90-revup-32gb.conf && sudo systemctl restart postgresql@<ver>-main
# =============================================================================
set -euo pipefail

# --- 1. hostname guard — FIRST, before anything else -------------------------
# This tuning (8GB shared_buffers) is sized for the 32GB services VM only.
# On a 16GB replica it would starve the OS; on any other box it is a
# wrong-box paste. Refuse loudly.
if [ "$(hostname)" != "services" ]; then
    echo "REFUSED: this is '$(hostname)', not 'services'." >&2
    echo "apply_pg_32gb.sh tunes the East PG PRIMARY on the 32GB services VM ONLY." >&2
    echo "It must never run on replicas (west-db/central-db/east-db-standby) or any other host." >&2
    exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: run with sudo (writes /etc/postgresql)" >&2
    exit 1
fi

say() { echo "==> $*"; }

# --- 2. RAM sanity — this file assumes the 32GB resize -----------------------
MEM_KB="$(awk '/^MemTotal:/{print $2}' /proc/meminfo)"
if [ "${MEM_KB:-0}" -lt 30000000 ] && [ "${REVUP_PG_TUNE_FORCE:-0}" != "1" ]; then
    echo "REFUSED: MemTotal is $((MEM_KB / 1024)) MiB — this host does not look resized to 32GB yet." >&2
    echo "shared_buffers=8GB on a 16GB box would starve the OS + container stack." >&2
    echo "To STAGE the file before the resize stop/start (PG keeps running on old settings" >&2
    echo "until the resize reboot picks the file up): REVUP_PG_TUNE_FORCE=1 $0" >&2
    exit 1
fi
[ "${MEM_KB:-0}" -lt 30000000 ] && say "FORCE: staging on a $((MEM_KB / 1024)) MiB host — do NOT restart PG until the VM is resized to 32GB"

# --- 3. detect the Debian/Ubuntu cluster layout ------------------------------
PGVER="" PGCLUSTER="" PGDATA=""
if command -v pg_lsclusters > /dev/null 2>&1; then
    CLUSTERS="$(pg_lsclusters --no-header 2>/dev/null || true)"
    NCLUSTERS="$(printf '%s' "${CLUSTERS}" | grep -c . || true)"
    if [ "${NCLUSTERS}" -ne 1 ]; then
        echo "ERROR: expected exactly ONE PostgreSQL cluster on this VM, found ${NCLUSTERS}:" >&2
        printf '%s\n' "${CLUSTERS}" >&2
        echo "Refusing to guess. Fix the layout (or this script's detection) first." >&2
        exit 1
    fi
    PGVER="$(printf '%s' "${CLUSTERS}" | awk '{print $1}')"
    PGCLUSTER="$(printf '%s' "${CLUSTERS}" | awk '{print $2}')"
    PGDATA="$(printf '%s' "${CLUSTERS}" | awk '{print $6}')"
else
    # Fallback: glob the conf tree (pg_lsclusters ships with postgresql-common
    # on every Debian/Ubuntu PG install, so this is belt-and-braces).
    CONF_DIRS=(/etc/postgresql/*/*)
    if [ "${#CONF_DIRS[@]}" -ne 1 ] || [ ! -d "${CONF_DIRS[0]}" ]; then
        echo "ERROR: pg_lsclusters missing and /etc/postgresql/<ver>/<cluster> is not a single dir (found: ${CONF_DIRS[*]})." >&2
        echo "Unexpected layout — bailing rather than guessing." >&2
        exit 1
    fi
    PGVER="$(basename "$(dirname "${CONF_DIRS[0]}")")"
    PGCLUSTER="$(basename "${CONF_DIRS[0]}")"
    PGDATA="/var/lib/postgresql/${PGVER}/${PGCLUSTER}"
fi

CONF_DIR="/etc/postgresql/${PGVER}/${PGCLUSTER}"
MAIN_CONF="${CONF_DIR}/postgresql.conf"
DROPIN_DIR="${CONF_DIR}/conf.d"
DROPIN="${DROPIN_DIR}/90-revup-32gb.conf"
AUTO_CONF="${PGDATA}/postgresql.auto.conf"

say "cluster: PostgreSQL ${PGVER}/${PGCLUSTER}  conf=${CONF_DIR}  data=${PGDATA}"
if [ ! -f "${MAIN_CONF}" ]; then
    echo "ERROR: ${MAIN_CONF} not found — unexpected layout, bailing." >&2
    exit 1
fi

# --- 4. verify conf.d is actually included -----------------------------------
# Debian ships `include_dir = 'conf.d'` at the end of postgresql.conf. If an
# operator ever removed it, our drop-in would be silently ignored — check.
if ! grep -Eq "^[[:space:]]*include_dir[[:space:]]*=[[:space:]]*'?conf\.d'?" "${MAIN_CONF}"; then
    echo "ERROR: ${MAIN_CONF} has no active \"include_dir = 'conf.d'\" line — a conf.d drop-in would be a silent no-op." >&2
    echo "Unexpected layout — bailing. (Restore the Debian-default include_dir line first.)" >&2
    exit 1
fi
if [ ! -d "${DROPIN_DIR}" ]; then
    install -d -o postgres -g postgres -m 0755 "${DROPIN_DIR}"
    say "created ${DROPIN_DIR}"
fi

# --- 5. the tuning ------------------------------------------------------------
# Sized for: 32GB host, ~16.5G Docker limit ceiling, PG primary serving
# PgBouncer transaction pooling (pool_size=100 + reserve 20 -> <=120 pooled
# backends of max_connections=300) + Grafana direct + exporters + 4 wal
# senders. Rationale per value: docs/SERVICES_VM_32GB_TUNING.md.
TMP="$(mktemp)"
trap 'rm -f "${TMP}"' EXIT
cat > "${TMP}" << 'EOF'
# =============================================================================
# revup 32GB services-VM tuning — MANAGED BY scripts/services-tuning/apply_pg_32gb.sh
# Do NOT hand-edit on the VM; change the script in the repo and re-run it.
# Rationale + budget: docs/SERVICES_VM_32GB_TUNING.md
# Rollback: delete this file + restart the cluster.
# =============================================================================

# --- memory ---
shared_buffers = 8GB                     # 25% of 32GB (restart required)
effective_cache_size = 20GB              # planner hint: shared_buffers + expected OS page cache
maintenance_work_mem = 1GB               # index builds / VACUUM (PG16 caps autovac dead-TID use at 1GB anyway)
work_mem = 32MB                          # per sort/hash NODE, per query. NOT per connection:
                                         #   max_connections=300 but only <=120 can arrive via the
                                         #   PgBouncer pool (100+20) and the memory-hungry consumers
                                         #   (Grafana CDR aggregations, CDR export batches) number
                                         #   ~10-25 concurrent nodes worst case ≈ 0.8-1.6GB.
                                         #   NOTE PG16 hash_mem_multiplier defaults to 2.0 -> hash
                                         #   aggs may use 64MB/node; that is why this is 32MB and
                                         #   not 64MB. Hot-path DID lookups are point reads and
                                         #   never touch work_mem.
wal_buffers = 64MB                       # heavy-insert CDR workload; auto default caps at 16MB (restart required)

# --- checkpoints / planner / IO (pd-SSD) ---
checkpoint_completion_target = 0.9       # PG14+ default; pinned so it survives any legacy override
random_page_cost = 1.1                   # SSD persistent disk — stop punishing index scans
effective_io_concurrency = 200           # SSD: deeper bitmap-heap prefetch

# --- autovacuum ---
autovacuum_vacuum_cost_limit = 1000      # default 200 (via vacuum_cost_limit) is anemic for the
                                         # cdrs hypertable churn; SSD absorbs the extra IO easily
EOF

# --- 6. idempotent install + diff summary ------------------------------------
if [ -f "${DROPIN}" ] && cmp -s "${TMP}" "${DROPIN}"; then
    say "already applied — ${DROPIN} is up to date, nothing written"
else
    say "writing ${DROPIN} — diff (old -> new):"
    if [ -f "${DROPIN}" ]; then
        diff -u "${DROPIN}" "${TMP}" || true
    else
        echo "(new file)"
        sed 's/^/    + /' "${TMP}"
    fi
    install -o postgres -g postgres -m 0644 "${TMP}" "${DROPIN}"
    say "written: ${DROPIN}"
fi

# --- 7. postgresql.auto.conf conflict scan -----------------------------------
# ALTER SYSTEM output overrides conf.d (auto.conf is read LAST). If any of our
# params were ever ALTER SYSTEMed (e.g. a primary initialized from the local-dev
# 01_extensions.sql), the drop-in is dead-on-arrival for that param.
PARAMS="shared_buffers effective_cache_size maintenance_work_mem work_mem wal_buffers checkpoint_completion_target random_page_cost effective_io_concurrency autovacuum_vacuum_cost_limit"
CONFLICTS=0
if [ -f "${AUTO_CONF}" ]; then
    for p in ${PARAMS}; do
        if line="$(grep -E "^[[:space:]]*${p}[[:space:]]*=" "${AUTO_CONF}" 2>/dev/null)"; then
            [ "${CONFLICTS}" -eq 0 ] && { echo; echo "!! WARNING: postgresql.auto.conf overrides found — auto.conf WINS over conf.d, so these params will IGNORE the new file:"; }
            CONFLICTS=$((CONFLICTS + 1))
            echo "!!   ${line}"
            echo "!!   fix (single line): sudo -u postgres psql -X -c \"ALTER SYSTEM RESET ${p}\""
        fi
    done
fi
if [ "${CONFLICTS}" -gt 0 ]; then
    echo "!! Run the RESET line(s) above BEFORE the restart or the tuning will silently not take for those params."
    echo "!! (ALTER SYSTEM RESET only edits auto.conf; it takes effect at the same restart.)"
else
    say "no postgresql.auto.conf conflicts with the tuned params"
fi

# --- 8. hand off the restart to the operator ---------------------------------
echo
say "NOT restarting PostgreSQL (shared_buffers/wal_buffers need one — brief East DID-lookup + fleet-wide write blip; you pick the moment)."
say "Verify current (pre-restart) values: sudo /opt/revup/scripts/services-tuning/show_pg_tuning.sh"
say "Apply (single line, when ready):     sudo systemctl restart postgresql@${PGVER}-${PGCLUSTER}"
say "Then verify again — every param should show source=configuration file and the new value."
