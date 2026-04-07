#!/bin/bash
set -e

# Start PostgreSQL in background
docker-entrypoint.sh postgres &
PG_PID=$!

# Wait for PostgreSQL to be ready
until pg_isready -U voip -d voip; do
    echo "Waiting for PostgreSQL..."
    sleep 1
done

echo "PostgreSQL is ready, starting PgBouncer..."

# Generate proper userlist with MD5 hashes
echo '"voip" "md5'$(echo -n "voip_secretvoip" | md5sum | cut -d' ' -f1)'"' > /etc/pgbouncer/userlist.txt
echo '"freeswitch" "md5'$(echo -n "fs_secretfreeswitch" | md5sum | cut -d' ' -f1)'"' >> /etc/pgbouncer/userlist.txt
echo '"api" "md5'$(echo -n "api_secretapi" | md5sum | cut -d' ' -f1)'"' >> /etc/pgbouncer/userlist.txt

# Start PgBouncer
pgbouncer -d /etc/pgbouncer/pgbouncer.ini

# Wait for PostgreSQL (main process)
wait $PG_PID
