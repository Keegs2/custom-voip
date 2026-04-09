-- FreeSWITCH Startup Script
-- Initializes configuration and verifies connectivity
--
-- This script runs once when FreeSWITCH starts.
-- It sets up global variables and optionally tests service connectivity.

-- Fix package paths early so require() finds luarocks-installed libraries
-- before mod_lua's custom searcher tries the scripts directory as a file.
package.path = "/usr/local/share/lua/5.3/?.lua;/usr/local/share/lua/5.3/?/init.lua;/usr/share/lua/5.3/?.lua;/usr/share/lua/5.3/?/init.lua;" .. package.path
package.cpath = "/usr/local/lib/lua/5.3/?.so;/usr/local/lib/lua/5.3/?/?.so;/usr/lib/lua/5.3/?.so;/usr/lib/lua/5.3/?/?.so;" .. package.cpath

freeswitch.consoleLog("INFO", "\n")
freeswitch.consoleLog("INFO", "============================================\n")
freeswitch.consoleLog("INFO", "  Voice Platform - FreeSWITCH Starting     \n")
freeswitch.consoleLog("INFO", "============================================\n")

-- ============================================
-- CONFIGURATION FROM ENVIRONMENT
-- ============================================

-- Redis Configuration
-- Default to 127.0.0.1 because FreeSWITCH runs with network_mode: host
-- and Redis is exposed on the host at port 6380 (mapped from container 6379)
REDIS_HOST = os.getenv("REDIS_HOST") or "127.0.0.1"
REDIS_PORT = tonumber(os.getenv("REDIS_PORT") or 6380)

-- PostgreSQL Configuration (via PgBouncer for connection pooling)
PG_HOST = os.getenv("DB_HOST") or "postgres"
PG_PORT = os.getenv("DB_PORT") or "6432"  -- PgBouncer default port
PG_DB = os.getenv("DB_NAME") or "voip"
PG_USER = os.getenv("DB_USER") or "freeswitch"
PG_PASS = os.getenv("DB_PASS") or "fs_secret"

-- API Server Configuration
API_HOST = os.getenv("API_HOST") or "api"
API_PORT = os.getenv("API_PORT") or "8000"

-- Platform Mode
TEST_MODE = os.getenv("TEST_MODE") or "false"
LOG_LEVEL = os.getenv("LOG_LEVEL") or "INFO"

-- ============================================
-- BUILD CONNECTION STRINGS
-- ============================================

-- PostgreSQL connection string for luasql
PG_CONNSTRING = string.format(
    "host=%s port=%s dbname=%s user=%s password=%s connect_timeout=5",
    PG_HOST, PG_PORT, PG_DB, PG_USER, PG_PASS
)

-- ============================================
-- LOG CONFIGURATION
-- ============================================

freeswitch.consoleLog("INFO", "\n")
freeswitch.consoleLog("INFO", "Configuration:\n")
freeswitch.consoleLog("INFO", "  Redis:      " .. REDIS_HOST .. ":" .. tostring(REDIS_PORT) .. "\n")
freeswitch.consoleLog("INFO", "  PostgreSQL: " .. PG_HOST .. ":" .. PG_PORT .. "/" .. PG_DB .. "\n")
freeswitch.consoleLog("INFO", "  API Server: " .. API_HOST .. ":" .. API_PORT .. "\n")
freeswitch.consoleLog("INFO", "  Test Mode:  " .. TEST_MODE .. "\n")
freeswitch.consoleLog("INFO", "\n")

-- ============================================
-- CONNECTIVITY TESTS (Optional)
-- ============================================

local function test_redis()
    local ok, redis = pcall(require, "redis_client")
    if not ok then
        freeswitch.consoleLog("WARNING", "Redis client not available: " .. tostring(redis) .. "\n")
        return false
    end

    local healthy, status = redis.health_check()
    if healthy then
        freeswitch.consoleLog("INFO", "Redis:      CONNECTED\n")
        return true
    else
        freeswitch.consoleLog("WARNING", "Redis:      NOT CONNECTED - " .. tostring(status) .. "\n")
        return false
    end
end

local function test_postgres()
    local ok, db = pcall(require, "db_client")
    if not ok then
        freeswitch.consoleLog("WARNING", "DB client not available: " .. tostring(db) .. "\n")
        return false
    end

    local conn = db.get_connection()
    if conn then
        freeswitch.consoleLog("INFO", "PostgreSQL: CONNECTED\n")
        return true
    else
        freeswitch.consoleLog("WARNING", "PostgreSQL: NOT CONNECTED\n")
        return false
    end
end

-- Run connectivity tests (non-blocking, failures are warnings only)
-- These can fail during initial startup if services aren't ready yet
local function run_connectivity_tests()
    freeswitch.consoleLog("INFO", "Testing service connectivity...\n")

    -- Add delay to allow services to start
    -- os.execute("sleep 2")  -- Uncomment if needed

    local redis_ok = test_redis()
    local pg_ok = test_postgres()

    if redis_ok and pg_ok then
        freeswitch.consoleLog("INFO", "\n")
        freeswitch.consoleLog("INFO", "All services connected successfully!\n")
    else
        freeswitch.consoleLog("WARNING", "\n")
        freeswitch.consoleLog("WARNING", "Some services not connected - calls may fail until services are ready\n")
        freeswitch.consoleLog("WARNING", "Services will reconnect automatically when available\n")
    end
end

-- Run tests in protected mode to avoid blocking startup
pcall(run_connectivity_tests)

-- ============================================
-- STARTUP COMPLETE
-- ============================================

freeswitch.consoleLog("INFO", "\n")
freeswitch.consoleLog("INFO", "============================================\n")
freeswitch.consoleLog("INFO", "  Voice Platform - Ready for Calls         \n")
freeswitch.consoleLog("INFO", "============================================\n")
freeswitch.consoleLog("INFO", "\n")
