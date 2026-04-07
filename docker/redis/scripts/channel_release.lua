-- CHANNEL RELEASE - Release a channel when call ends
-- KEYS[1] = trunk_id
-- ARGV[1] = call_uuid
--
-- Returns: remaining_channels

local trunk_id = KEYS[1]
local call_uuid = ARGV[1]

local calls_key = 'trunk:' .. trunk_id .. ':calls'

-- Remove call from set
redis.call('SREM', calls_key, call_uuid)

-- Return current count
return redis.call('SCARD', calls_key) or 0
