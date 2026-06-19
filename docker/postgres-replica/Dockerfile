# Physical read-replica (hot standby) of the prod East primary.
# Pinned to TimescaleDB 2.26.3 / PG16 to MATCH the prod primary exactly — a
# physical standby must boot the same shared_preload_libraries (timescaledb) and
# extension binaries as the primary, or it will refuse to start.
#
# Self-bootstraps from the primary via pg_basebackup on first run (see
# entrypoint.sh). Read-only by nature; consumes the prod did_inventory as the
# shared source of truth (INVENTORY_READ_URL on the sandbox API points here).
FROM timescale/timescaledb:2.26.3-pg16

COPY entrypoint.sh /replica-entrypoint.sh
RUN chmod +x /replica-entrypoint.sh

# Override the official entrypoint: a standby clones via pg_basebackup, never initdb.
ENTRYPOINT ["/replica-entrypoint.sh"]
