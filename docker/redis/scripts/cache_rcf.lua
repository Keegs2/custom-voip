-- CACHE RCF LOOKUP - Cache RCF config for fast repeated lookups
-- Avoids DB hit on every call to same DID
-- KEYS[1] = did
-- ARGV[1] = forward_to (if setting)
-- ARGV[2] = customer_id (if setting)
-- ARGV[3] = pass_caller_id (if setting)
-- ARGV[4] = traffic_grade (if setting)
-- ARGV[5] = ring_timeout (if setting)
-- ARGV[6] = ttl (seconds, default 300)
--
-- Returns: {found (0/1), forward_to, customer_id, pass_caller_id, traffic_grade, ring_timeout}

local did = KEYS[1]
local key = 'rcf:' .. did

-- If ARGV[1] is set, we're writing to cache
if ARGV[1] and ARGV[1] ~= '' then
    local ttl = tonumber(ARGV[6]) or 300
    redis.call('HSET', key,
        'forward_to', ARGV[1],
        'customer_id', ARGV[2],
        'pass_caller_id', ARGV[3],
        'traffic_grade', ARGV[4],
        'ring_timeout', ARGV[5]
    )
    redis.call('EXPIRE', key, ttl)
    return {1, ARGV[1], ARGV[2], ARGV[3], ARGV[4], ARGV[5]}
end

-- Reading from cache
local data = redis.call('HGETALL', key)
if #data == 0 then
    return {0, '', '', '', '', ''}
end

-- Convert array to hash
local result = {}
for i = 1, #data, 2 do
    result[data[i]] = data[i+1]
end

return {1,
    result['forward_to'] or '',
    result['customer_id'] or '',
    result['pass_caller_id'] or '',
    result['traffic_grade'] or '',
    result['ring_timeout'] or '30'
}
