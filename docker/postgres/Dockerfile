# High-performance PostgreSQL with TimescaleDB for CDR hypertables
FROM timescale/timescaledb:latest-pg16

# Install PgBouncer for connection pooling
RUN apk add --no-cache pgbouncer

# Copy initialization scripts (executed in alphabetical order)
COPY init/ /docker-entrypoint-initdb.d/

# Copy PgBouncer config
COPY pgbouncer.ini /etc/pgbouncer/pgbouncer.ini
COPY userlist.txt /etc/pgbouncer/userlist.txt

# Custom entrypoint to start both Postgres and PgBouncer
COPY entrypoint.sh /usr/local/bin/custom-entrypoint.sh
RUN chmod +x /usr/local/bin/custom-entrypoint.sh

# Postgres: 5432, PgBouncer: 6432
EXPOSE 5432 6432

# Performance-tuned postgres config
ENV POSTGRES_INITDB_ARGS="--data-checksums"

# Start BOTH Postgres and PgBouncer. Without this ENTRYPOINT the base image's
# default entrypoint runs Postgres ONLY and PgBouncer never starts (6432 dead) —
# the bug that made the all-in-one box diverge from production's pooled path.
ENTRYPOINT ["/usr/local/bin/custom-entrypoint.sh"]
CMD ["postgres"]
