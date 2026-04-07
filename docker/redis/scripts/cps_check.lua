-- CPS CHECK - Calls Per Second rate limiting
-- Uses sliding window for accurate CPS limiting
-- KEYS[1] = trunk_id or customer_id
-- ARGV[1] = cps_limit
-- ARGV[2] = key_prefix ('trunk' or 'customer')
--
-- Returns: {allowed (0/1), current_cps}

local id = KEYS[1]
local cps_limit = tonumber(ARGV[1])
local prefix = ARGV[2] or 'trunk'

local now = redis.call('TIME')
local timestamp = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local window_start = timestamp - 1000  -- 1 second window

local key = 'cps:' .. prefix .. ':' .. id

-- Remove old entries outside the window
redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

-- Count current entries in window
local current_cps = redis.call('ZCARD', key)

if current_cps >= cps_limit then
    return {0, current_cps}
end

-- Add this call to the window
redis.call('ZADD', key, timestamp, timestamp .. ':' .. math.random(1000000))
redis.call('EXPIRE', key, 2)  -- Expire after 2 seconds

return {1, current_cps + 1}
