-- Outbound Caller ID Lookup
-- Queries the extensions table for the calling user's assigned DID.
-- Sets effective_caller_id_number so the carrier receives a valid DID
-- instead of a short extension number (e.g., "1001").
--
-- Called from the default_outbound dialplan extension before bridging.
-- Falls back to the platform default DID if the user has no assigned DID.

-- Load db_client using the same loadfile pattern as inbound_router.lua
-- (require() is broken by mod_lua's searcher path manipulation)
local function load_module(name)
    local path = "/usr/local/freeswitch/scripts/lib/" .. name .. ".lua"
    local func, err = loadfile(path)
    if not func then
        freeswitch.consoleLog("ERR", "lookup_user_did: Failed to load " .. name .. ": " .. tostring(err) .. "\n")
        return nil
    end
    local ok, result = pcall(func)
    if not ok then
        freeswitch.consoleLog("ERR", "lookup_user_did: Failed to execute " .. name .. ": " .. tostring(result) .. "\n")
        return nil
    end
    return result
end

-- Default platform DID used when the user has no assigned DID
local DEFAULT_DID = "+17743260301"
local DEFAULT_NAME = "Custom VoIP"

-- Ensure session exists
if not session then
    freeswitch.consoleLog("ERR", "lookup_user_did: No session object\n")
    return
end

-- Get the calling extension number
local ext = session:getVariable("caller_id_number")
if not ext or ext == "" then
    freeswitch.consoleLog("WARNING", "lookup_user_did: No caller_id_number, using default DID\n")
    session:setVariable("effective_caller_id_number", DEFAULT_DID)
    session:setVariable("effective_caller_id_name", DEFAULT_NAME)
    return
end

-- Load database client
local db = load_module("db_client")
if not db then
    freeswitch.consoleLog("ERR", "lookup_user_did: DB client unavailable, using default DID for ext " .. ext .. "\n")
    session:setVariable("effective_caller_id_number", DEFAULT_DID)
    session:setVariable("effective_caller_id_name", DEFAULT_NAME)
    return
end

-- Query for the user's assigned DID
local ok, row = pcall(function()
    return db.lookup_did_for_extension(ext)
end)

if ok and row and row.assigned_did then
    session:setVariable("effective_caller_id_number", row.assigned_did)
    -- Preserve existing caller name if set, otherwise use platform name
    local existing_name = session:getVariable("effective_caller_id_name")
    if not existing_name or existing_name == "" or existing_name == ext then
        session:setVariable("effective_caller_id_name", DEFAULT_NAME)
    end
    freeswitch.consoleLog("INFO", string.format(
        "lookup_user_did: ext %s -> DID %s\n", ext, row.assigned_did
    ))
else
    -- No assigned DID: fall back to platform default
    session:setVariable("effective_caller_id_number", DEFAULT_DID)
    session:setVariable("effective_caller_id_name", DEFAULT_NAME)
    if not ok then
        freeswitch.consoleLog("ERR", string.format(
            "lookup_user_did: DB error for ext %s: %s\n", ext, tostring(row)
        ))
    else
        freeswitch.consoleLog("INFO", string.format(
            "lookup_user_did: No assigned DID for ext %s, using default\n", ext
        ))
    end
end
