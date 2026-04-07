# High-performance Redis for real-time voice platform
FROM redis:7-alpine

# Copy custom configuration with proper permissions
COPY redis.conf /usr/local/etc/redis/redis.conf
RUN chmod 644 /usr/local/etc/redis/redis.conf && chown redis:redis /usr/local/etc/redis/redis.conf

# Copy Lua scripts for atomic operations
COPY --chmod=644 scripts/ /usr/local/etc/redis/scripts/

# Pre-load scripts on startup
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/custom-entrypoint.sh

EXPOSE 6379

CMD ["redis-server", "/usr/local/etc/redis/redis.conf"]
