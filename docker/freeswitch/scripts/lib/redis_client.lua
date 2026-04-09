-- Redis Client Library with Connection Pooling
-- Optimized for high-volume voice operations
--
-- Features:
-- - Automatic reconnection on failure
-- - Atomic operations via Lua scripts
-- - Connection health checks
-- - Proper error handling
--
-- Uses redis-lua library (pure Lua Redis client)
-- Compatible with Lua 5.1, 5.2, 5.3

local M = {}

-- Fix package paths BEFORE require("redis") so luarocks-installed redis-lua
-- is found before mod_lua's custom searcher tries the scripts directory.
-- Without this, require("redis") matches /usr/local/freeswitch/scripts/ (a directory)
-- because mod_lua adds script-directory as a searcher, causing:
--   "cannot read /usr/local/freeswitch/scripts/: Is a directory"
package.path = "/usr/local/share/lua/5.3/?.lua;/usr/local/share/lua/5.3/?/init.lua;/usr/share/lua/5.3/?.lua;/usr/share/lua/5.3/?/init.lua;" .. (package.path or "")
package.cpath = "/usr/local/lib/lua/5.3/?.so;/usr/local/lib/lua/5.3/?/?.so;/usr/lib/lua/5.3/?.so;/usr/lib/lua/5.3/?/?.so;" .. (package.cpath or "")

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
        freeswitch.consoleLog("WARNING", "Redis library not available: " .. tostring(result) .. "\n")
    end
    redis = nil
end

-- Connection state
local redis_conn = nil
local conn_last_checked = 0
local CONN_CHECK_INTERVAL = 30  -- Check connection every 30 seconds
local MAX_RETRY_ATTEMPTS = 3

-- Get or create Redis connection
function M.get_connection()
    -- If redis library isn't available, return nil
    if not redis then
        return nil
    end

    local now = os.time()

    -- Check if existing connection is valid
    if redis_conn then
        -- Periodic health check
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

        -- Connection dead, clear it
        if freeswitch and freeswitch.consoleLog then
            freeswitch.consoleLog("WARN", "Redis connection lost, reconnecting...\n")
        end
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
            if freeswitch and freeswitch.consoleLog then
                freeswitch.consoleLog("INFO", string.format(
                    "Redis connected to %s:%d (attempt %d)\n",
                    host, port, attempt
                ))
            end
            return redis_conn
        end

        if freeswitch and freeswitch.consoleLog then
            freeswitch.consoleLog("WARN", string.format(
                "Redis connection attempt %d failed: %s\n",
                attempt, tostring(result)
            ))
        end

        -- Brief pause between retries
        if attempt < MAX_RETRY_ATTEMPTS then
            os.execute("sleep 0.1")
        end
    end

    if freeswitch and freeswitch.consoleLog then
        freeswitch.consoleLog("ERR", "Failed to connect to Redis after " .. MAX_RETRY_ATTEMPTS .. " attempts\n")
    end
    return nil
end

-- Safe command execution with error handling
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
        if freeswitch and freeswitch.consoleLog then
            freeswitch.consoleLog("ERR", "Redis command error: " .. tostring(result) .. "\n")
        end
        -- Clear connection to force reconnect on next call
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
        if freeswitch and freeswitch.consoleLog then
            freeswitch.consoleLog("ERR", "Redis EVAL error: " .. tostring(result) .. "\n")
        end
        redis_conn = nil
        return nil, tostring(result)
    end

    return result, nil
end

-- Execute velocity check using atomic Lua script
-- Returns: success (bool), reason (string), current_count (number)
function M.velocity_check(customer_id, cpm_limit, cph_limit, daily_limit, estimated_cost)
    -- Input validation
    customer_id = tonumber(customer_id)
    if not customer_id or customer_id <= 0 then
        return false, "INVALID_CUSTOMER_ID", 0
    end

    cpm_limit = tonumber(cpm_limit) or 60
    daily_limit = tonumber(daily_limit) or 500
    estimated_cost = tonumber(estimated_cost) or 0.01

    local script = [[
        local customer_id = KEYS[1]
        local cpm_limit = tonumber(ARGV[1]) or 60
        local daily_limit = tonumber(ARGV[2]) or 500
        local estimated_cost = tonumber(ARGV[3]) or 0.01

        local minute_key = 'vel:' .. customer_id .. ':cpm'
        local date = os.date('%Y%m%d')
        local spend_key = 'spend:' .. customer_id .. ':' .. date

        -- Check CPM limit
        local current_cpm = tonumber(redis.call('GET', minute_key) or 0)
        if current_cpm >= cpm_limit then
            return {0, 'CPM_EXCEEDED', current_cpm}
        end

        -- Check daily spend limit
        local current_spend = tonumber(redis.call('GET', spend_key) or 0)
        if current_spend + estimated_cost > daily_limit then
            return {0, 'DAILY_LIMIT_EXCEEDED', current_spend}
        end

        -- Increment counters atomically
        redis.call('INCR', minute_key)
        redis.call('EXPIRE', minute_key, 60)
        redis.call('INCRBYFLOAT', spend_key, estimated_cost)
        redis.call('EXPIRE', spend_key, 86400)

        return {1, 'OK', current_cpm + 1}
    ]]

    local result, err = redis_eval(script, 1,
        tostring(customer_id),
        tostring(cpm_limit),
        tostring(daily_limit),
        tostring(estimated_cost)
    )

    if not result then
        if freeswitch and freeswitch.consoleLog then
            freeswitch.consoleLog("ERR", "Velocity check Redis error: " .. tostring(err) .. "\n")
        end
        -- Fail open on Redis error (configurable - could fail closed for security)
        return true, "REDIS_ERROR", 0
    end

    if type(result) == "table" and result[1] == 1 then
        return true, result[2], result[3] or 0
    else
        return false, result and result[2] or "UNKNOWN", result and result[3] or 0
    end
end

-- Check high-risk prefix (fraud prevention)
-- Returns: is_risky (bool), risk_level (string), matched_prefix (string)
function M.check_prefix(destination)
    -- Input validation
    if not destination or type(destination) ~= "string" then
        return false, "", ""
    end

    local r = M.get_connection()
    if not r then
        -- Fail open on Redis error
        return false, "", ""
    end

    -- Clean destination - keep only digits
    local clean_dest = destination:gsub("[^%d]", "")
    if #clean_dest < 1 then
        return false, "", ""
    end

    -- Check progressively shorter prefixes (longest match first)
    local max_len = math.min(#clean_dest, 10)
    for i = max_len, 1, -1 do
        local prefix = string.sub(clean_dest, 1, i)

        local ok, risk = pcall(function()
            return r:get("hrp:" .. prefix)
        end)

        if ok and risk and risk ~= nil and risk ~= false then
            if freeswitch and freeswitch.consoleLog then
                freeswitch.consoleLog("DEBUG", string.format(
                    "High-risk prefix match: %s -> %s (level: %s)\n",
                    destination, prefix, tostring(risk)
                ))
            end
            return true, risk, prefix
        end
    end

    return false, "", ""
end

-- Get cached RCF configuration
-- Returns: table with RCF data or nil
function M.get_rcf_cache(did)
    if not did or type(did) ~= "string" then
        return nil
    end

    local r = M.get_connection()
    if not r then
        return nil
    end

    local ok, data = pcall(function()
        return r:hgetall("rcf:" .. did)
    end)

    if not ok or not data or type(data) ~= "table" then
        return nil
    end

    -- Check if we got any data
    local count = 0
    for _ in pairs(data) do count = count + 1 end
    if count == 0 then
        return nil
    end

    -- Validate required fields exist
    if not data.forward_to or not data.customer_id then
        return nil
    end

    return data
end

-- Set RCF cache
function M.set_rcf_cache(did, forward_to, customer_id, pass_caller_id, traffic_grade, ring_timeout, ttl)
    if not did or not forward_to or not customer_id then
        return false
    end

    local r = M.get_connection()
    if not r then
        return false
    end

    ttl = ttl or 300  -- 5 minute default
    local key = "rcf:" .. did

    local ok, _ = pcall(function()
        r:hmset(key,
            "forward_to", tostring(forward_to),
            "customer_id", tostring(customer_id),
            "pass_caller_id", pass_caller_id and "1" or "0",
            "traffic_grade", traffic_grade or "standard",
            "ring_timeout", tostring(ring_timeout or 30)
        )
        r:expire(key, ttl)
    end)

    return ok
end

-- Acquire trunk channel (atomic operation)
-- Returns: success (bool), current_count (number), max_channels (number)
function M.acquire_channel(trunk_id, max_channels, call_uuid)
    -- Input validation
    trunk_id = tostring(trunk_id or "")
    max_channels = tonumber(max_channels) or 50
    call_uuid = tostring(call_uuid or "")

    if trunk_id == "" or call_uuid == "" then
        return false, 0, max_channels
    end

    local script = [[
        local calls_key = KEYS[1]
        local max_ch = tonumber(ARGV[1])
        local uuid = ARGV[2]

        local current = tonumber(redis.call('SCARD', calls_key) or 0)
        if current >= max_ch then
            return {0, current, max_ch}
        end

        redis.call('SADD', calls_key, uuid)
        redis.call('EXPIRE', calls_key, 7200)  -- 2 hour max call

        return {1, current + 1, max_ch}
    ]]

    local calls_key = "trunk:" .. trunk_id .. ":calls"
    local result, err = redis_eval(script, 1,
        calls_key,
        tostring(max_channels),
        call_uuid
    )

    if not result then
        if freeswitch and freeswitch.consoleLog then
            freeswitch.consoleLog("ERR", "Channel acquire error: " .. tostring(err) .. "\n")
        end
        -- Fail open - allow the call
        return true, 0, max_channels
    end

    if type(result) == "table" then
        return result[1] == 1, result[2] or 0, result[3] or max_channels
    end

    return false, 0, max_channels
end

-- Release trunk channel
-- Returns: remaining channel count
function M.release_channel(trunk_id, call_uuid)
    trunk_id = tostring(trunk_id or "")
    call_uuid = tostring(call_uuid or "")

    if trunk_id == "" or call_uuid == "" then
        return 0
    end

    local calls_key = "trunk:" .. trunk_id .. ":calls"

    local ok, _ = pcall(function()
        return redis_command("srem", calls_key, call_uuid)
    end)

    if not ok then
        return 0
    end

    local result, _ = redis_command("scard", calls_key)
    return tonumber(result) or 0
end

-- CPS (Calls Per Second) check using sliding window
-- Returns: allowed (bool), current_cps (number)
function M.cps_check(id, cps_limit, prefix)
    -- Input validation
    id = tostring(id or "")
    cps_limit = tonumber(cps_limit) or 10
    prefix = prefix or "trunk"

    if id == "" then
        return true, 0
    end

    local script = [[
        local key = KEYS[1]
        local limit = tonumber(ARGV[1])
        local now = tonumber(ARGV[2])
        local window_start = now - 1000

        -- Remove old entries
        redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

        -- Count current
        local current = tonumber(redis.call('ZCARD', key) or 0)
        if current >= limit then
            return {0, current}
        end

        -- Add this call with unique score
        local score = now .. '.' .. math.random(1000000)
        redis.call('ZADD', key, now, score)
        redis.call('EXPIRE', key, 2)

        return {1, current + 1}
    ]]

    local key = "cps:" .. prefix .. ":" .. id
    local now = os.time() * 1000  -- milliseconds

    local result, err = redis_eval(script, 1,
        key,
        tostring(cps_limit),
        tostring(now)
    )

    if not result then
        if freeswitch and freeswitch.consoleLog then
            freeswitch.consoleLog("ERR", "CPS check error: " .. tostring(err) .. "\n")
        end
        -- Fail open
        return true, 0
    end

    if type(result) == "table" then
        return result[1] == 1, result[2] or 0
    end

    return true, 0
end

-- Get current channel count for a trunk
function M.get_channel_count(trunk_id)
    trunk_id = tostring(trunk_id or "")
    if trunk_id == "" then
        return 0
    end

    local result, _ = redis_command("scard", "trunk:" .. trunk_id .. ":calls")
    return tonumber(result) or 0
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

-- Close connection (for cleanup)
function M.close()
    if redis_conn then
        pcall(function() redis_conn:quit() end)
        redis_conn = nil
    end
end

return M
