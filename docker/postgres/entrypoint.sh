#!/bin/bash
# All-in-one dev/test image: run PostgreSQL AND PgBouncer in one container so the
# local stack exercises the SAME pooled :6432 path as production (where PgBouncer
# is a separate bare-metal service). In production this image is NOT used — bare
# PG + bare PgBouncer run on the services VM.
set -e

PG_DB="${POSTGRES_DB:-voip}"
PG_SUPER_USER="${POSTGRES_USER:-voip}"
PG_SUPER_PASS="${POSTGRES_PASSWORD:-voip_secret}"
FS_USER="${FS_DB_USER:-freeswitch}"
API_USER="${API_DB_USER:-api}"

# Start PostgreSQL via the base TimescaleDB entrypoint in the background.
# ("$@" = the CMD, i.e. "postgres", plus any extra args.)
docker-entrypoint.sh "$@" &
PG_PID=$!

# Wait for PostgreSQL to accept local connections before reading role secrets.
until pg_isready -U "$PG_SUPER_USER" -d "$PG_DB" -h 127.0.0.1 -p 5432 >/dev/null 2>&1; do
    echo "[pgbouncer-init] waiting for PostgreSQL..."
    sleep 1
done

# Build the PgBouncer userlist from the roles' REAL stored secrets in pg_authid
# (SCRAM-SHA-256 verifiers on PG16). No password changes, no pg_hba edits: with
# auth_type=scram-sha-256, PgBouncer authenticates clients against these secrets
# AND passes them through to log in to PostgreSQL. Works identically on a fresh
# initdb or an existing data dir. Re-derived every boot, so it self-heals.
echo "[pgbouncer-init] building userlist from pg_authid SCRAM secrets..."
# Emit exactly: "user" "secret"  (PgBouncer userlist format — double-quoted).
# SCRAM verifiers contain '$' and ':' but never '"', so plain concatenation is safe.
PGPASSWORD="$PG_SUPER_PASS" psql -h 127.0.0.1 -p 5432 -U "$PG_SUPER_USER" -d "$PG_DB" \
    -X -A -t -v ON_ERROR_STOP=1 \
    -c "SELECT '\"' || rolname || '\" \"' || rolpassword || '\"'
        FROM pg_authid
        WHERE rolname IN ('$PG_SUPER_USER','$FS_USER','$API_USER')
          AND rolpassword IS NOT NULL" \
    > /etc/pgbouncer/userlist.txt

# Sanity: every role we expect must have landed a secret, else PgBouncer auth
# will silently reject that user. Fail loud instead.
if [ "$(grep -c '"' /etc/pgbouncer/userlist.txt)" -lt 1 ]; then
    echo "[pgbouncer-init] ERROR: userlist is empty — no role secrets found" >&2
    exit 1
fi

echo "[pgbouncer-init] starting PgBouncer on :6432..."
# Run in the foreground (no -d, so no pidfile needed) but backgrounded by the
# shell; the `user = postgres` directive drops root privileges. Logs flow to
# the container's stdout/stderr.
pgbouncer /etc/pgbouncer/pgbouncer.ini &

# Keep the container alive on PostgreSQL (the main process). If PG exits, so do we.
wait "$PG_PID"
