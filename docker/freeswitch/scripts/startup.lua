-- FreeSWITCH Startup Script
-- Initializes configuration and verifies connectivity
--
-- This script runs once when FreeSWITCH starts.
-- It sets up global variables and optionally tests service connectivity.

-- Fix package paths early so require() finds our lib modules and luarocks-installed
-- libraries before mod_lua's custom searcher tries the scripts directory as a file.
-- The scripts/lib/ path is needed for require("db_client"), require("redis_client"), etc.
package.path = "/usr/local/freeswitch/scripts/lib/?.lua;/usr/local/freeswitch/scripts/?.lua;/usr/local/share/lua/5.3/?.lua;/usr/local/share/lua/5.3/?/init.lua;/usr/share/lua/5.3/?.lua;/usr/share/lua/5.3/?/init.lua;" .. (package.path or "")
package.cpath = "/usr/local/lib/lua/5.3/?.so;/usr/local/lib/lua/5.3/?/?.so;/usr/lib/lua/5.3/?.so;/usr/lib/lua/5.3/?/?.so;" .. (package.cpath or "")

freeswitch.consoleLog("INFO", "\n")
freeswitch.consoleLog("INFO", "============================================\n")
freeswitch.consoleLog("INFO", "  Voice Platform - FreeSWITCH Starting     \n")
freeswitch.consoleLog("INFO", "============================================\n")

-- ============================================
-- CONFIGURATION FROM ENVIRONMENT
-- ============================================

-- Redis Configuration
-- Default to 127.0.0.1 because FreeSWITCH runs with network_mode: host
-- and Redis is exposed on the host at port 6379
REDIS_HOST = os.getenv("REDIS_HOST") or "127.0.0.1"
REDIS_PORT = tonumber(os.getenv("REDIS_PORT") or 6379)

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
-- ENCRYPTED VOICEMAIL: tmpfs sweep + readiness
-- ============================================
-- docs/ENCRYPTED_VOICEMAIL_INTERFACES.md §6 / build plan §3.1 "sweep
-- /dev/shm/vm at FS start". Done HERE (bind-mounted, deploys with git pull)
-- rather than in entrypoint.sh: the image ENTRYPOINT is the freeswitch binary
-- itself and docker-compose.media.yml has no entrypoint override, so
-- entrypoint.sh never runs in production — and changing either would need an
-- FS image rebuild / startup-path change.
-- The tmpfs is created empty on every container start anyway; this sweep is
-- the belt-and-braces for an in-container FS restart. It deletes regular
-- files older than 1 minute only, so a `reload mod_lua` (which re-runs this
-- startup script) can never delete a recording that is still being written
-- (its mtime is seconds old) or awaiting its deposit (< 1 min).
-- Readiness problems are only LOGGED — voicemail calls fail closed per call
-- (play `unavailable`), RCF/trunk routing is never affected.
local function voicemail_startup()
    local chunk, err = loadfile("/usr/local/freeswitch/scripts/lib/vm_box.lua")
    if not chunk then
        freeswitch.consoleLog("WARNING", "Voicemail:  lib/vm_box.lua not loadable (" .. tostring(err) .. ")\n")
        return
    end
    local ok, vm = pcall(chunk)
    if not ok or type(vm) ~= "table" or not vm.dep then
        freeswitch.consoleLog("WARNING", "Voicemail:  lib/vm_box.lua failed to initialise\n")
        return
    end
    if vm.tmpfs_mounted() then
        vm.sweep(1, true)
        freeswitch.consoleLog("INFO", "Voicemail:  tmpfs " .. vm.dep.VM_DIR .. " mounted, swept\n")
    else
        freeswitch.consoleLog("WARNING", "Voicemail:  tmpfs " .. vm.dep.VM_DIR
            .. " NOT mounted — voicemail calls will play 'unavailable' until the FS container is recreated with docker-compose.media.yml\n")
    end
    local hok, why = vm.dep.ingest_header_ok()
    if hok then
        freeswitch.consoleLog("INFO", "Voicemail:  ingest header file present\n")
    else
        freeswitch.consoleLog("WARNING", "Voicemail:  " .. tostring(why)
            .. " — voicemail calls will play 'unavailable' until it is provisioned\n")
    end
end
pcall(voicemail_startup)

-- ============================================
-- STARTUP COMPLETE
-- ============================================

freeswitch.consoleLog("INFO", "\n")
freeswitch.consoleLog("INFO", "============================================\n")
freeswitch.consoleLog("INFO", "  Voice Platform - Ready for Calls         \n")
freeswitch.consoleLog("INFO", "============================================\n")
freeswitch.consoleLog("INFO", "\n")
