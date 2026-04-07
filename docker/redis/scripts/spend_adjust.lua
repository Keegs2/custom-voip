-- SPEND ADJUST - Adjust daily spend after call completes
-- Called after call rating to correct estimated vs actual cost
-- KEYS[1] = customer_id
-- ARGV[1] = estimated_cost (what we added during velocity check)
-- ARGV[2] = actual_cost (real rated cost)
--
-- Returns: new_daily_spend

local customer_id = KEYS[1]
local estimated = tonumber(ARGV[1]) or 0
local actual = tonumber(ARGV[2]) or 0

local date = os.date('%Y%m%d')
local spend_key = 'spend:' .. customer_id .. ':' .. date

-- Adjust: remove estimate, add actual
local adjustment = actual - estimated
redis.call('INCRBYFLOAT', spend_key, adjustment)

-- Ensure key doesn't expire mid-day
redis.call('EXPIRE', spend_key, 86400)

return redis.call('GET', spend_key)
