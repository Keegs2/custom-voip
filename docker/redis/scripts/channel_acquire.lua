-- CHANNEL ACQUIRE - Atomic channel acquisition for SIP trunks
-- Attempts to acquire a channel, returns success/failure atomically
-- KEYS[1] = trunk_id
-- ARGV[1] = max_channels
-- ARGV[2] = call_uuid
--
-- Returns: {acquired (0/1), current_channels, max_channels}

local trunk_id = KEYS[1]
local max_channels = tonumber(ARGV[1])
local call_uuid = ARGV[2]

local channel_key = 'trunk:' .. trunk_id .. ':channels'
local calls_key = 'trunk:' .. trunk_id .. ':calls'

-- Get current channel count
local current = tonumber(redis.call('SCARD', calls_key) or 0)

if current >= max_channels then
    -- No channels available
    return {0, current, max_channels}
end

-- Acquire channel - add call UUID to set
redis.call('SADD', calls_key, call_uuid)

-- Set expiry on the set (failsafe - calls should be removed on hangup)
redis.call('EXPIRE', calls_key, 7200)  -- 2 hour max call duration

return {1, current + 1, max_channels}
