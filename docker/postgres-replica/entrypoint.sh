#!/bin/sh
# Self-bootstrapping PostgreSQL physical standby (read replica) of the prod
# primary. On first start (empty data dir) it clones the primary via
# pg_basebackup and configures streaming replication; on later starts it just
# resumes streaming. It is a HOT STANDBY — physically read-only, so it can never
# write back to prod (the infra-enforced "sandbox never mutates prod" guarantee).
#
# Required env: PRIMARY_HOST, REPL_PASSWORD.
# Optional:     PRIMARY_PORT(5432), REPL_USER(replicator), REPL_SLOT(sandbox_replica).
# NOTE: use an alphanumeric REPL_PASSWORD (no ':' or '\') to avoid .pgpass escaping.
set -e

: "${PGDATA:=/var/lib/postgresql/data}"
: "${PRIMARY_PORT:=5432}"
: "${REPL_USER:=replicator}"
: "${REPL_SLOT:=sandbox_replica}"
: "${PGHOME:=/var/lib/postgresql}"

[ -n "$PRIMARY_HOST" ]   || { echo "[replica] PRIMARY_HOST is required" >&2; exit 1; }
[ -n "$REPL_PASSWORD" ]  || { echo "[replica] REPL_PASSWORD is required" >&2; exit 1; }

# .pgpass so the walreceiver re-authenticates to the primary on EVERY restart.
# pg_basebackup -R writes primary_conninfo but NOT the password (by design), so
# without this the standby would fail to reconnect after a restart.
PGPASS="$PGHOME/.pgpass"
printf '%s:%s:*:%s:%s\n' "$PRIMARY_HOST" "$PRIMARY_PORT" "$REPL_USER" "$REPL_PASSWORD" > "$PGPASS"
chown postgres:postgres "$PGPASS"
chmod 600 "$PGPASS"

mkdir -p "$PGDATA"
chown postgres:postgres "$PGDATA"
chmod 700 "$PGDATA"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
    echo "[replica] empty data dir — cloning standby from ${PRIMARY_HOST}:${PRIMARY_PORT} (slot=${REPL_SLOT})..."
    rm -rf "${PGDATA:?}/"* 2>/dev/null || true
    # -R: write standby.signal + primary_conninfo (+ primary_slot_name with -S)
    # -Xs: stream WAL during the backup so the clone is immediately consistent
    su-exec postgres sh -c "PGPASSFILE='$PGPASS' pg_basebackup -h '$PRIMARY_HOST' -p '$PRIMARY_PORT' -U '$REPL_USER' -D '$PGDATA' -Fp -Xs -P -R -S '$REPL_SLOT'"
    # Allow the sandbox API (Docker bridge / VPC, RFC1918) to make read-only
    # connections to the standby. The standby is only reachable inside the
    # sandbox host; a valid scram credential is still required.
    {
        echo "host all all 10.0.0.0/8     scram-sha-256"
        echo "host all all 172.16.0.0/12  scram-sha-256"
        echo "host all all 192.168.0.0/16 scram-sha-256"
    } >> "$PGDATA/pg_hba.conf"
    chown postgres:postgres "$PGDATA/pg_hba.conf"
    echo "[replica] clone complete; starting as hot standby"
fi

# Hand off to PostgreSQL as the postgres user. PGPASSFILE points the walreceiver
# at .pgpass regardless of HOME. listen_addresses='*' so the API can reach it.
exec su-exec postgres env PGPASSFILE="$PGPASS" postgres -D "$PGDATA" -c listen_addresses='*' -c hot_standby=on
