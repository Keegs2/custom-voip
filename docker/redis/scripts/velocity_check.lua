-- VELOCITY CHECK - Atomic fraud detection script
-- Checks and increments velocity counters in a single atomic operation
-- KEYS[1] = customer_id
-- ARGV[1] = cpm_limit (calls per minute)
-- ARGV[2] = cph_limit (calls per hour, optional, default 0 = no limit)
-- ARGV[3] = daily_limit (spend limit)
-- ARGV[4] = estimated_cost (for this call)
--
-- Returns: {allowed (0/1), reason, current_cpm, current_spend}

local customer_id = KEYS[1]
local cpm_limit = tonumber(ARGV[1]) or 60
local cph_limit = tonumber(ARGV[2]) or 0
local daily_limit = tonumber(ARGV[3]) or 500
local estimated_cost = tonumber(ARGV[4]) or 0.01

local now = redis.call('TIME')[1]
local minute_key = 'vel:' .. customer_id .. ':cpm'
local hour_key = 'vel:' .. customer_id .. ':cph'
local date = os.date('%Y%m%d', now)
local spend_key = 'spend:' .. customer_id .. ':' .. date

-- Check calls per minute
local current_cpm = tonumber(redis.call('GET', minute_key) or 0)
if current_cpm >= cpm_limit then
    return {0, 'CPM_EXCEEDED', current_cpm, 0}
end

-- Check calls per hour (if limit set)
if cph_limit > 0 then
    local current_cph = tonumber(redis.call('GET', hour_key) or 0)
    if current_cph >= cph_limit then
        return {0, 'CPH_EXCEEDED', current_cpm, 0}
    end
end

-- Check daily spend
local current_spend = tonumber(redis.call('GET', spend_key) or 0)
if current_spend + estimated_cost > daily_limit then
    return {0, 'DAILY_LIMIT_EXCEEDED', current_cpm, current_spend}
end

-- All checks passed - increment counters atomically
redis.call('INCR', minute_key)
redis.call('EXPIRE', minute_key, 60)

if cph_limit > 0 then
    redis.call('INCR', hour_key)
    redis.call('EXPIRE', hour_key, 3600)
end

-- Increment spend (we'll adjust after call ends)
redis.call('INCRBYFLOAT', spend_key, estimated_cost)
redis.call('EXPIRE', spend_key, 86400)

return {1, 'OK', current_cpm + 1, current_spend + estimated_cost}
