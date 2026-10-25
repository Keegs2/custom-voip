-- lib/vm_replica.lua — encrypted voicemail: the zone-replica mailbox check.
--
-- Contract: docs/IVR_INTERFACES.md §8.4 (view vm_fs_mailbox, migration
-- 58_vm_outage_resilience.sql); design: docs/VOICEMAIL_OUTAGE_RESILIENCE.md.
-- Used ONLY by lib/vm_box.lua, and ONLY after GET /v1/voicemail/fs/mailbox/{id}
-- on the East API failed with a transport error / 5xx / garbage (the
-- "anything else" row of vm_box's lookup table). When the API answers, none
-- of this runs (no query, no connection): the call is byte-identical to the
-- pre-58 behavior.
--
-- WHAT IT READS
--   SELECT ... FROM vm_fs_mailbox WHERE mailbox_id = <integer>
--   on the zone's LOCAL PgBouncer/replica (DB_HOST — the same connection
--   string inbound_router.lua's DID lookups use), through
--   lib/db_client.lua's exported get_connection(). The view (58) mirrors the
--   API's accepting_state(): status, accepting, reason ('inactive'|'full'|
--   NULL) and max_message_seconds. A deleted mailbox has no row — the same
--   "not found" the API answers with 404. The freeswitch role can read the
--   view and nothing else voicemail-related (no greeting, no caller data,
--   no counts).
--
-- WHAT IT CANNOT DO: the custom greeting is ciphertext under the customer's
-- KMS key and only the East API can decrypt it, so with the API down the
-- caller hears the default greeting (vm_box plays `default_greeting`).
--
-- CONNECTION: a FRESH db_client instance is loaded per fallback call
-- (vm_box cannot reach inbound_router's instance — it is a local there) and
-- CLOSED before returning, so a fallback never leaves a connection behind in
-- the session thread. Outages only: the normal path never opens it. If the
-- replica is unreachable too, db_client's connect_timeout (startup.lua
-- PG_CONNSTRING, 5 s) bounds the wait — but the call reached vm_box through
-- the router's own lookups on the same replica moments earlier, so in
-- practice the replica answers in milliseconds.
--
-- FAILURE SEMANTICS (never raises):
--   { kind = "ok", data = { mailbox_id, did, customer_id, status,
--                           accepting = bool, reason = "inactive"|"full"|nil,
--                           max_message_seconds = int|nil } }
--   { kind = "not_found" }                 0 rows (deleted / unknown mailbox)
--   { kind = "error", detail = "..." }     anything else: no luasql, no
--                                          connection, view missing (58 not
--                                          applied), permission denied, a
--                                          malformed row -> vm_box keeps
--                                          today's defaults (300 s, default
--                                          greeting, deposit with retries).
--
-- SQL SAFETY: the statement is a constant apart from the mailbox id, which is
-- re-validated here as a positive 31-bit integer and formatted with %d.
--
-- Syntax: Lua 5.1/5.3-common (FS runs 5.3). Loaded with loadfile().

local M = {}

local LIB_DIR = "/usr/local/freeswitch/scripts/lib/"

M.SQL = "SELECT mailbox_id, did, customer_id, status, accepting, max_message_seconds, reason"
    .. " FROM vm_fs_mailbox WHERE mailbox_id = %d LIMIT 1"

local REASONS = { inactive = true, full = true }

local function log(level, msg)
    if freeswitch and freeswitch.consoleLog then
        freeswitch.consoleLog(level, "[vm_replica] " .. msg .. "\n")
    end
end

-- Positive 31-bit integer, or nil (same rule as vm_deposit's id_string).
local function int_id(v)
    local n = tonumber(v)
    if not n or n ~= math.floor(n) or n < 1 or n > 2147483647 then
        return nil
    end
    return n
end
M._int_id = int_id

-- luasql-postgres returns booleans as "t"/"f" strings.
local function pg_bool(v)
    if v == true or v == "t" or v == "true" then return true end
    if v == false or v == "f" or v == "false" then return false end
    return nil
end
M._pg_bool = pg_bool

function M.query(mailbox_id)
    local id = int_id(mailbox_id)
    if not id then return nil end
    return string.format(M.SQL, id)
end

local function load_db()
    local chunk, err = loadfile(LIB_DIR .. "db_client.lua")
    if not chunk then
        return nil, "db_client load failed: " .. tostring(err)
    end
    local ok, mod = pcall(chunk)
    if not ok or type(mod) ~= "table" then
        return nil, "db_client execute failed: " .. tostring(mod)
    end
    return mod
end

-- Validate one view row -> data table, or nil + reason.
local function shape(row, id)
    if type(row) ~= "table" then return nil, "no row" end
    if int_id(row.mailbox_id) ~= id then
        return nil, "row is for a different mailbox"
    end
    local accepting = pg_bool(row.accepting)
    if accepting == nil then
        return nil, "accepting is not a boolean"
    end
    local reason = row.reason
    if reason == "" then reason = nil end
    if reason ~= nil and not REASONS[reason] then
        return nil, "unknown reason"
    end
    if accepting and reason ~= nil then
        return nil, "accepting row carries a reason"
    end
    if not accepting and reason == nil then
        return nil, "not-accepting row has no reason"
    end
    local secs = tonumber(row.max_message_seconds)
    return {
        mailbox_id = id,
        did = row.did,
        customer_id = tonumber(row.customer_id),
        status = row.status,
        accepting = accepting,
        reason = reason,
        max_message_seconds = secs,
    }
end

-- opts.db : an already-loaded db_client (tests); default = a fresh instance,
--           closed before returning.
function M.fetch_mailbox(mailbox_id, opts)
    opts = opts or {}
    local id = int_id(mailbox_id)
    if not id then
        return { kind = "error", detail = "invalid mailbox id" }
    end
    local db, own = opts.db, false
    if not db then
        local err
        db, err = load_db()
        if not db then
            return { kind = "error", detail = err }
        end
        own = true
    end

    local result
    local ok, perr = pcall(function()
        if type(db.get_connection) ~= "function" then
            result = { kind = "error", detail = "db_client has no get_connection" }
            return
        end
        local conn = db.get_connection()
        if not conn then
            result = { kind = "error", detail = "no replica connection" }
            return
        end
        local cok, cursor, cerr = pcall(function() return conn:execute(M.query(id)) end)
        if not cok or not cursor then
            -- e.g. relation "vm_fs_mailbox" does not exist (58 not applied)
            result = { kind = "error", detail = "query failed: " .. tostring(cok and cerr or cursor) }
            return
        end
        local fok, row = pcall(function() return cursor:fetch({}, "a") end)
        pcall(function() cursor:close() end)
        if not fok then
            result = { kind = "error", detail = "fetch failed: " .. tostring(row) }
            return
        end
        if row == nil then
            result = { kind = "not_found" }
            return
        end
        local data, why = shape(row, id)
        if not data then
            result = { kind = "error", detail = "malformed row: " .. why }
            return
        end
        result = { kind = "ok", data = data }
    end)
    if own and type(db.close) == "function" then
        pcall(db.close)
    end
    if not ok then
        log("ERR", "replica lookup raised: " .. tostring(perr))
        return { kind = "error", detail = "replica lookup raised" }
    end
    return result or { kind = "error", detail = "no result" }
end

return M
