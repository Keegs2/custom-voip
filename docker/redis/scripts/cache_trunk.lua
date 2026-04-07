-- CACHE TRUNK LOOKUP - Cache trunk config by IP for fast auth
-- KEYS[1] = ip_address
-- ARGV[1] = trunk_id (if setting)
-- ARGV[2] = customer_id (if setting)
-- ARGV[3] = max_channels (if setting)
-- ARGV[4] = cps_limit (if setting)
-- ARGV[5] = traffic_grade (if setting)
-- ARGV[6] = ttl (seconds, default 300)
--
-- Returns: {found (0/1), trunk_id, customer_id, max_channels, cps_limit, traffic_grade}

local ip = KEYS[1]
local key = 'trunk_ip:' .. ip

-- If ARGV[1] is set, we're writing to cache
if ARGV[1] and ARGV[1] ~= '' then
    local ttl = tonumber(ARGV[6]) or 300
    redis.call('HSET', key,
        'trunk_id', ARGV[1],
        'customer_id', ARGV[2],
        'max_channels', ARGV[3],
        'cps_limit', ARGV[4],
        'traffic_grade', ARGV[5]
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
    result['trunk_id'] or '',
    result['customer_id'] or '',
    result['max_channels'] or '',
    result['cps_limit'] or '',
    result['traffic_grade'] or ''
}
