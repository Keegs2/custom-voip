-- Redis CPS (Calls Per Second) Checking Library
-- Implements sliding window CPS limiting with tier support
--
-- TIER STRUCTURE:
-- SIP Trunk Tiers:
--   - Free: 5 CPS (included with trunk)
--   - Paid: 6-10 CPS (requires upgrade)
--   - Over 10 CPS: Must upgrade to API calling
--
-- API Calling Tiers:
--   - Starter: 25 CPS
--   - Professional: 50 CPS
--   - Enterprise: 100 CPS
--   - Unlimited: Custom (no limit enforced here)
--
-- Key Patterns:
--   cps:{type}:{id} - Sorted set for sliding window CPS tracking
--   account:{id}:limits - Hash containing tier info and limits

local M = {}

-- Fix package paths BEFORE require("redis") so luarocks-installed redis-lua
-- is found before mod_lua's custom searcher tries the scripts directory.
-- Without this, require("redis") matches /usr/local/freeswitch/scripts/ (a directory)
-- because mod_lua adds script-directory as a searcher, causing:
--   "cannot read /usr/local/freeswitch/scripts/: Is a directory"
package.path = "/usr/local/share/lua/5.3/?.lua;/usr/local/share/lua/5.3/?/init.lua;/usr/share/lua/5.3/?.lua;/usr/share/lua/5.3/?/init.lua;" .. package.path
package.cpath = "/usr/local/lib/lua/5.3/?.so;/usr/local/lib/lua/5.3/?/?.so;/usr/lib/lua/5.3/?.so;/usr/lib/lua/5.3/?/?.so;" .. package.cpath

-- Try to load redis library
local redis
local ok, result = pcall(function()
    -- redis-lua uses "redis" as module name
    return require("redis")
end)

if ok then
    redis = result
else
    -- Log error but don't fail - allows startup without Redis
    if freeswitch and freeswitch.consoleLog then
        freeswitch.consoleLog("WARNING", "[redis_cps] Redis library not available: " .. tostring(result) .. "\n")
    end
    redis = nil
end

-- Connection state (shared with redis_client.lua if loaded together)
local redis_conn = nil
local conn_last_checked = 0
local CONN_CHECK_INTERVAL = 30
local MAX_RETRY_ATTEMPTS = 3

-- CPS window size in milliseconds
local CPS_WINDOW_MS = 1000

-- Default CPS limits by tier
M.TRUNK_TIERS = {
    free = { cps = 5, name = "Free", upgradable = true },
    paid = { cps = 10, name = "Paid", upgradable = true },
    -- Trunks cannot exceed 10 CPS - must upgrade to API
}

M.API_TIERS = {
    starter = { cps = 25, name = "Starter" },
    professional = { cps = 50, name = "Professional" },
    enterprise = { cps = 100, name = "Enterprise" },
    unlimited = { cps = 9999, name = "Unlimited" },  -- Effectively no limit
}

-- Maximum CPS for trunk (hard cap)
M.TRUNK_MAX_CPS = 10

-- Get or create Redis connection
function M.get_connection()
    -- If redis library isn't available, return nil
    if not redis then
        return nil
    end

    local now = os.time()

    -- Check if existing connection is valid
    if redis_conn then
        if (now - conn_last_checked) < CONN_CHECK_INTERVAL then
            return redis_conn
        end

        -- Test connection with PING
        local ok, result = pcall(function()
            return redis_conn:ping()
        end)

        if ok and result == "PONG" then
            conn_last_checked = now
            return redis_conn
        end

        freeswitch.consoleLog("WARN", "[redis_cps] Connection lost, reconnecting...\n")
        redis_conn = nil
    end

    -- Get connection parameters
    -- Default to 127.0.0.1 because FreeSWITCH runs with network_mode: host
    -- and Redis is exposed on the host at port 6380 (mapped from container 6379)
    local host = REDIS_HOST or os.getenv("REDIS_HOST") or "127.0.0.1"
    local port = tonumber(REDIS_PORT or os.getenv("REDIS_PORT") or 6380)

    -- Try to connect with retries
    for attempt = 1, MAX_RETRY_ATTEMPTS do
        local ok, result = pcall(function()
            return redis.connect(host, port)
        end)

        if ok and result then
            redis_conn = result
            conn_last_checked = now
            freeswitch.consoleLog("INFO", string.format(
                "[redis_cps] Connected to %s:%d (attempt %d)\n",
                host, port, attempt
            ))
            return redis_conn
        end

        freeswitch.consoleLog("WARN", string.format(
            "[redis_cps] Connection attempt %d failed: %s\n",
            attempt, tostring(result)
        ))

        if attempt < MAX_RETRY_ATTEMPTS then
            os.execute("sleep 0.1")
        end
    end

    freeswitch.consoleLog("ERR", "[redis_cps] Failed to connect after " .. MAX_RETRY_ATTEMPTS .. " attempts\n")
    return nil
end

-- Safe command execution via method name
local function redis_command(cmd, ...)
    local r = M.get_connection()
    if not r then
        return nil, "REDIS_CONNECTION_FAILED"
    end

    local args = {...}
    local ok, result = pcall(function()
        return r[cmd](r, table.unpack(args))
    end)

    if not ok then
        freeswitch.consoleLog("ERR", "[redis_cps] Command error: " .. tostring(result) .. "\n")
        redis_conn = nil
        return nil, tostring(result)
    end

    return result, nil
end

-- Execute Lua script on Redis
local function redis_eval(script, numkeys, ...)
    local r = M.get_connection()
    if not r then
        return nil, "REDIS_CONNECTION_FAILED"
    end

    local args = {...}
    local ok, result = pcall(function()
        return r:eval(script, numkeys, table.unpack(args))
    end)

    if not ok then
        freeswitch.consoleLog("ERR", "[redis_cps] EVAL error: " .. tostring(result) .. "\n")
        redis_conn = nil
        return nil, tostring(result)
    end

    return result, nil
end

-- Get account limits from Redis hash
-- Returns: { tier, cps_limit, type } or nil
function M.get_account_limits(account_id, account_type)
    if not account_id or account_id == "" then
        return nil
    end

    local key = "account:" .. tostring(account_id) .. ":limits"
    local result, err = redis_command("hgetall", key)

    -- redis-lua hgetall returns a table {field=value,...} directly
    -- Check for nil, error, or empty table
    local has_data = false
    if result and not err and type(result) == "table" then
        for _ in pairs(result) do
            has_data = true
            break
        end
    end

    if not has_data then
        -- Return defaults based on type
        if account_type == "trunk" then
            return {
                tier = "free",
                cps_limit = M.TRUNK_TIERS.free.cps,
                type = "trunk",
                tier_name = M.TRUNK_TIERS.free.name
            }
        else
            return {
                tier = "starter",
                cps_limit = M.API_TIERS.starter.cps,
                type = "api",
                tier_name = M.API_TIERS.starter.name
            }
        end
    end

    -- redis-lua returns a proper {field=value} table, no conversion needed
    local limits = result

    local tier = limits.tier or (account_type == "trunk" and "free" or "starter")
    local tier_table = account_type == "trunk" and M.TRUNK_TIERS or M.API_TIERS
    local tier_info = tier_table[tier]

    if not tier_info then
        -- Invalid tier, use defaults
        tier = account_type == "trunk" and "free" or "starter"
        tier_info = tier_table[tier]
    end

    return {
        tier = tier,
        cps_limit = tonumber(limits.cps_limit) or tier_info.cps,
        type = account_type,
        tier_name = tier_info.name
    }
end

-- Set account limits in Redis
-- Used for provisioning/updates
function M.set_account_limits(account_id, tier, cps_limit, account_type)
    if not account_id then
        return false
    end

    local key = "account:" .. tostring(account_id) .. ":limits"

    local r = M.get_connection()
    if not r then
        return false
    end

    local ok, _ = pcall(function()
        r:hset(key, "tier", tostring(tier))
        r:hset(key, "cps_limit", tostring(cps_limit))
        r:hset(key, "type", tostring(account_type or "trunk"))
    end)

    return ok
end

-- Sliding Window CPS Check
-- Uses Redis sorted set with millisecond timestamps as scores
-- Returns: allowed (bool), current_cps (number), limit (number), tier (string)
function M.cps_check(id, cps_limit, prefix)
    -- Input validation
    id = tostring(id or "")
    cps_limit = tonumber(cps_limit) or 10
    prefix = prefix or "trunk"

    if id == "" then
        return true, 0, cps_limit, "unknown"
    end

    -- Lua script for atomic CPS check using sliding window
    local script = [[
        local key = KEYS[1]
        local limit = tonumber(ARGV[1])
        local now = tonumber(ARGV[2])
        local window_start = now - 1000
        local call_id = ARGV[3]

        -- Remove entries outside the sliding window
        redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

        -- Count current calls in window
        local current = tonumber(redis.call('ZCARD', key) or 0)

        if current >= limit then
            -- Over limit - don't add this call
            return {0, current, limit}
        end

        -- Add this call with timestamp as score (use call_id for uniqueness)
        redis.call('ZADD', key, now, call_id)

        -- Set expiry on the key (slightly longer than window)
        redis.call('EXPIRE', key, 2)

        return {1, current + 1, limit}
    ]]

    local key = "cps:" .. prefix .. ":" .. id
    local now = math.floor(os.time() * 1000)  -- Convert to milliseconds
    -- Add microsecond precision using clock if available
    local call_id = tostring(now) .. ":" .. tostring(math.random(1000000))

    local result, err = redis_eval(script, 1,
        key,
        tostring(cps_limit),
        tostring(now),
        call_id
    )

    if not result then
        freeswitch.consoleLog("ERR", "[redis_cps] CPS check error: " .. tostring(err) .. "\n")
        -- Fail open on Redis error
        return true, 0, cps_limit, "unknown"
    end

    if type(result) == "table" then
        local allowed = result[1] == 1
        local current = result[2] or 0
        local checked_limit = result[3] or cps_limit

        return allowed, current, checked_limit, prefix
    end

    return true, 0, cps_limit, "unknown"
end

-- Full CPS check with tier lookup
-- This is the main entry point for CPS checking
-- Returns: { allowed, current_cps, limit, tier, tier_name, type, upgrade_message }
function M.check_cps_with_tier(account_id, account_type)
    account_type = account_type or "trunk"

    -- Get account limits (from Redis or defaults)
    local limits = M.get_account_limits(account_id, account_type)

    if not limits then
        -- Can't determine limits, fail open
        return {
            allowed = true,
            current_cps = 0,
            limit = 0,
            tier = "unknown",
            tier_name = "Unknown",
            type = account_type,
            upgrade_message = nil
        }
    end

    -- Perform CPS check
    local allowed, current_cps, limit = M.cps_check(
        account_id,
        limits.cps_limit,
        account_type
    )

    -- Build result
    local result = {
        allowed = allowed,
        current_cps = current_cps,
        limit = limits.cps_limit,
        tier = limits.tier,
        tier_name = limits.tier_name,
        type = account_type,
        upgrade_message = nil
    }

    -- Add upgrade message if denied
    if not allowed then
        if account_type == "trunk" then
            if limits.tier == "free" then
                result.upgrade_message = "CPS limit exceeded. Upgrade to Paid Trunk tier for up to 10 CPS."
            elseif limits.tier == "paid" then
                result.upgrade_message = "Maximum trunk CPS (10) exceeded. Upgrade to API Calling for higher limits."
            end
        else
            -- API calling
            if limits.tier == "starter" then
                result.upgrade_message = "CPS limit exceeded. Upgrade to Professional tier for 50 CPS."
            elseif limits.tier == "professional" then
                result.upgrade_message = "CPS limit exceeded. Upgrade to Enterprise tier for 100 CPS."
            elseif limits.tier == "enterprise" then
                result.upgrade_message = "CPS limit exceeded. Contact sales for Unlimited tier."
            end
        end
    end

    return result
end

-- Check if trunk customer should upgrade to API for higher CPS
function M.should_upgrade_to_api(account_id)
    local limits = M.get_account_limits(account_id, "trunk")

    if limits and limits.cps_limit >= M.TRUNK_MAX_CPS then
        return true, "Maximum trunk CPS is 10. Upgrade to API Calling for up to 100 CPS."
    end

    return false, nil
end

-- Get current CPS for an account (for monitoring)
function M.get_current_cps(account_id, account_type)
    local key = "cps:" .. (account_type or "trunk") .. ":" .. tostring(account_id)
    local now = math.floor(os.time() * 1000)
    local window_start = now - 1000

    -- Clean old entries and count
    local script = [[
        local key = KEYS[1]
        local window_start = tonumber(ARGV[1])

        redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)
        return redis.call('ZCARD', key)
    ]]

    local result, err = redis_eval(script, 1, key, tostring(window_start))

    if not result or err then
        return 0
    end

    return tonumber(result) or 0
end

-- Record a call for CPS tracking (used when bypassing check)
function M.record_call(account_id, account_type)
    local key = "cps:" .. (account_type or "trunk") .. ":" .. tostring(account_id)
    local now = math.floor(os.time() * 1000)
    local call_id = tostring(now) .. ":" .. tostring(math.random(1000000))

    local r = M.get_connection()
    if not r then
        return false
    end

    local ok, _ = pcall(function()
        r:zadd(key, now, call_id)
        r:expire(key, 2)
    end)

    return ok
end

-- Health check
function M.health_check()
    local r = M.get_connection()
    if not r then
        return false, "CONNECTION_FAILED"
    end

    local ok, result = pcall(function()
        return r:ping()
    end)

    if ok and result == "PONG" then
        return true, "OK"
    end

    return false, tostring(result)
end

-- Close connection
function M.close()
    if redis_conn then
        pcall(function() redis_conn:quit() end)
        redis_conn = nil
    end
end

return M
