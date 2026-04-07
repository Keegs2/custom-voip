-- PREFIX CHECK - Check if destination matches blocked/high-risk prefix
-- Uses cached prefix list for fast lookups
-- KEYS[1] = destination number
--
-- Returns: {matched (0/1), risk_level, prefix}

local destination = KEYS[1]

-- Check progressively shorter prefixes (longest match first)
local len = math.min(#destination, 10)

for i = len, 1, -1 do
    local prefix = string.sub(destination, 1, i)
    local key = 'hrp:' .. prefix
    local risk = redis.call('GET', key)

    if risk then
        return {1, risk, prefix}
    end
end

return {0, '', ''}
