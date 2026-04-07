#!/bin/sh
# Custom entrypoint to load Lua scripts into Redis on startup

# Start Redis in background
redis-server /usr/local/etc/redis/redis.conf &
REDIS_PID=$!

# Wait for Redis to be ready
until redis-cli ping | grep -q PONG; do
    echo "Waiting for Redis..."
    sleep 1
done

echo "Redis is ready, loading Lua scripts..."

# Load scripts and store their SHA1 hashes
# These can be called with EVALSHA for better performance

redis-cli SCRIPT LOAD "$(cat /usr/local/etc/redis/scripts/velocity_check.lua)" > /tmp/velocity_check.sha
redis-cli SCRIPT LOAD "$(cat /usr/local/etc/redis/scripts/channel_acquire.lua)" > /tmp/channel_acquire.sha
redis-cli SCRIPT LOAD "$(cat /usr/local/etc/redis/scripts/channel_release.lua)" > /tmp/channel_release.sha
redis-cli SCRIPT LOAD "$(cat /usr/local/etc/redis/scripts/cps_check.lua)" > /tmp/cps_check.sha
redis-cli SCRIPT LOAD "$(cat /usr/local/etc/redis/scripts/cache_rcf.lua)" > /tmp/cache_rcf.sha
redis-cli SCRIPT LOAD "$(cat /usr/local/etc/redis/scripts/cache_trunk.lua)" > /tmp/cache_trunk.sha
redis-cli SCRIPT LOAD "$(cat /usr/local/etc/redis/scripts/spend_adjust.lua)" > /tmp/spend_adjust.sha
redis-cli SCRIPT LOAD "$(cat /usr/local/etc/redis/scripts/prefix_check.lua)" > /tmp/prefix_check.sha

echo "Lua scripts loaded successfully"
echo "SHA1 hashes stored in /tmp/*.sha"

# Keep Redis running in foreground
wait $REDIS_PID
