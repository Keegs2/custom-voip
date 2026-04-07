-- Channel Release Script - Called on hangup via api_hangup_hook
-- Releases trunk channel back to pool and performs cleanup
--
-- Usage: Set session variable api_hangup_hook="lua channel_release.lua"
-- The script will read trunk_id and uuid from the session

package.path = package.path .. ";/etc/freeswitch/scripts/lib/?.lua"

local ok, redis = pcall(require, "redis_client")
if not ok then
    freeswitch.consoleLog("ERR", "Failed to load redis_client in channel_release\n")
    return
end

-- Get variables from session or event
local trunk_id = nil
local call_uuid = nil

-- Try to get from session first
if session then
    local ok_tid, tid = pcall(function()
        return session:getVariable("trunk_id")
    end)
    if ok_tid and tid then
        trunk_id = tid
    end

    local ok_uuid, uid = pcall(function()
        return session:getVariable("uuid")
    end)
    if ok_uuid and uid then
        call_uuid = uid
    end
end

-- Fallback to arguments if provided
if not trunk_id or trunk_id == "" then
    trunk_id = argv and argv[1] or nil
end
if not call_uuid or call_uuid == "" then
    call_uuid = argv and argv[2] or nil
end

-- Try to get from event if still empty (for hangup_complete event)
if (not trunk_id or not call_uuid) and event then
    if not trunk_id then
        trunk_id = event:getHeader("variable_trunk_id")
    end
    if not call_uuid then
        call_uuid = event:getHeader("Unique-ID") or event:getHeader("variable_uuid")
    end
end

-- Execute release if we have required info
if trunk_id and call_uuid and trunk_id ~= "" and call_uuid ~= "" then
    local remaining = redis.release_channel(trunk_id, call_uuid)

    freeswitch.consoleLog("INFO", string.format(
        "[%s] Channel released for trunk %s, remaining: %d\n",
        call_uuid, trunk_id, remaining or 0
    ))
else
    freeswitch.consoleLog("WARNING", string.format(
        "Channel release called with incomplete data: trunk_id=%s uuid=%s\n",
        tostring(trunk_id), tostring(call_uuid)
    ))
end
