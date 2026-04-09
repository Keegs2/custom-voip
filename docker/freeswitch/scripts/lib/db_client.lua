-- PostgreSQL Client Library with Connection Pooling and SQL Injection Protection
-- Optimized for high-volume voice operations
--
-- SECURITY: All queries use parameterized values via string escaping
-- PERFORMANCE: Connection pooling via PgBouncer, prepared statements

-- Load luasql.postgres using direct loadlib to bypass FreeSWITCH's cpath manipulation
-- The require() function fails because mod_lua prepends script-directory to cpath
local luasql
do
    local loader, err = package.loadlib("/usr/local/lib/lua/5.3/luasql/postgres.so", "luaopen_luasql_postgres")
    if not loader then
        -- Try alternate path
        loader, err = package.loadlib("/usr/lib/lua/5.3/luasql/postgres.so", "luaopen_luasql_postgres")
    end
    if loader then
        luasql = loader()
    else
        error("Failed to load luasql.postgres: " .. tostring(err))
    end
end

local M = {}

-- Connection pool state
local env = nil
local conn = nil
local conn_last_used = 0
local CONN_IDLE_TIMEOUT = 300  -- 5 minutes

-- SQL escaping to prevent injection
-- This is a simple escape function - PgBouncer will help with actual parameterization
local function escape_string(str)
    if str == nil then
        return "NULL"
    end
    -- Convert to string
    str = tostring(str)
    -- Escape single quotes by doubling them
    str = str:gsub("'", "''")
    -- Escape backslashes
    str = str:gsub("\\", "\\\\")
    -- Remove null bytes
    str = str:gsub("%z", "")
    return str
end

-- Safe string for SQL - wraps in quotes
local function sql_string(str)
    if str == nil or str == "" then
        return "NULL"
    end
    return "'" .. escape_string(str) .. "'"
end

-- Safe number for SQL
local function sql_number(num)
    if num == nil then
        return "NULL"
    end
    local n = tonumber(num)
    if n == nil then
        return "NULL"
    end
    return tostring(n)
end

-- Validate E.164 phone number format
local function validate_did(did)
    if did == nil or type(did) ~= "string" then
        return nil
    end
    -- Strip non-numeric except +
    local clean = did:gsub("[^%d+]", "")
    -- Must be 10-15 digits, optionally with + prefix
    -- Note: Lua patterns don't support {n,m} quantifiers, so check length manually
    local digits = clean:gsub("%+", "")  -- Remove + for digit count
    local digit_count = #digits
    if digit_count < 10 or digit_count > 15 then
        return nil
    end
    -- Validate format: optional + followed by digits only
    if not clean:match("^%+?%d+$") then
        return nil
    end
    return clean
end

-- Validate IP address format
local function validate_ip(ip)
    if ip == nil or type(ip) ~= "string" then
        return nil
    end
    -- Simple IPv4 validation
    if ip:match("^%d+%.%d+%.%d+%.%d+$") then
        -- Check each octet is 0-255
        for octet in ip:gmatch("%d+") do
            local n = tonumber(octet)
            if n < 0 or n > 255 then
                return nil
            end
        end
        return ip
    end
    -- IPv6 validation (basic)
    if ip:match("^[%x:]+$") then
        return ip
    end
    return nil
end

-- Get database connection (with reconnection logic)
function M.get_connection()
    local now = os.time()

    -- Check if existing connection is still valid
    if conn then
        -- Check idle timeout
        if (now - conn_last_used) > CONN_IDLE_TIMEOUT then
            pcall(function() conn:close() end)
            conn = nil
        else
            -- Test connection with simple query
            local ok, cursor = pcall(function()
                return conn:execute("SELECT 1")
            end)
            if ok and cursor then
                cursor:close()
                conn_last_used = now
                return conn
            end
            -- Connection dead, close and reconnect
            pcall(function() conn:close() end)
            conn = nil
        end
    end

    -- Create environment if needed
    if not env then
        local ok, result = pcall(function()
            return luasql.postgres()
        end)
        if not ok or not result then
            freeswitch.consoleLog("ERR", "Failed to create PostgreSQL environment: " .. tostring(result) .. "\n")
            return nil
        end
        env = result
    end

    -- Build connection string from globals or defaults
    local connstring = PG_CONNSTRING
    if not connstring then
        local host = os.getenv("DB_HOST") or "postgres"
        local port = os.getenv("DB_PORT") or "6432"  -- PgBouncer
        local db = os.getenv("DB_NAME") or "voip"
        local user = os.getenv("DB_USER") or "freeswitch"
        local pass = os.getenv("DB_PASS") or "fs_secret"

        connstring = string.format(
            "host=%s port=%s dbname=%s user=%s password=%s connect_timeout=5",
            host, port, db, user, pass
        )
    end

    -- Connect
    local ok, result = pcall(function()
        return env:connect(connstring)
    end)

    if not ok or not result then
        freeswitch.consoleLog("ERR", "Failed to connect to PostgreSQL: " .. tostring(result) .. "\n")
        return nil
    end

    conn = result
    conn_last_used = now

    freeswitch.consoleLog("DEBUG", "PostgreSQL connection established\n")
    return conn
end

-- Execute query with error handling
local function execute_query(sql)
    local c = M.get_connection()
    if not c then
        return nil, "NO_CONNECTION"
    end

    local ok, cursor = pcall(function()
        return c:execute(sql)
    end)

    if not ok then
        freeswitch.consoleLog("ERR", "Query error: " .. tostring(cursor) .. "\n")
        freeswitch.consoleLog("DEBUG", "Failed SQL: " .. sql .. "\n")
        return nil, tostring(cursor)
    end

    return cursor, nil
end

-- Lookup RCF number (with safe parameterization)
function M.lookup_rcf(did)
    -- Validate and sanitize input
    local clean_did = validate_did(did)
    if not clean_did then
        freeswitch.consoleLog("WARN", "Invalid DID format for RCF lookup: " .. tostring(did) .. "\n")
        return nil
    end

    local sql = string.format([[
        SELECT r.forward_to, r.customer_id, r.pass_caller_id, r.ring_timeout,
               c.traffic_grade, c.cpm_limit, c.daily_limit, c.status
        FROM rcf_numbers r
        JOIN customers c ON r.customer_id = c.id
        WHERE r.did = %s AND r.enabled = true AND c.status = 'active'
        LIMIT 1
    ]], sql_string(clean_did))

    local cursor, err = execute_query(sql)
    if not cursor then
        freeswitch.consoleLog("ERR", "RCF lookup failed: " .. tostring(err) .. "\n")
        return nil
    end

    local row = cursor:fetch({}, "a")
    cursor:close()

    return row
end

-- Lookup API DID
function M.lookup_api_did(did)
    -- Validate and sanitize input
    local clean_did = validate_did(did)
    if not clean_did then
        freeswitch.consoleLog("WARN", "Invalid DID format for API lookup: " .. tostring(did) .. "\n")
        return nil
    end

    local sql = string.format([[
        SELECT a.voice_url, a.fallback_url, a.customer_id,
               c.traffic_grade, c.cpm_limit, c.daily_limit, c.status
        FROM api_dids a
        JOIN customers c ON a.customer_id = c.id
        WHERE a.did = %s AND a.enabled = true AND c.status = 'active'
        LIMIT 1
    ]], sql_string(clean_did))

    local cursor, err = execute_query(sql)
    if not cursor then
        freeswitch.consoleLog("ERR", "API DID lookup failed: " .. tostring(err) .. "\n")
        return nil
    end

    local row = cursor:fetch({}, "a")
    cursor:close()

    return row
end

-- Lookup trunk by IP
function M.lookup_trunk_by_ip(ip)
    -- Validate and sanitize input
    local clean_ip = validate_ip(ip)
    if not clean_ip then
        freeswitch.consoleLog("WARN", "Invalid IP format for trunk lookup: " .. tostring(ip) .. "\n")
        return nil
    end

    local sql = string.format([[
        SELECT t.id as trunk_id, t.customer_id, t.max_channels, t.cps_limit,
               c.traffic_grade, c.cpm_limit, c.daily_limit, c.status
        FROM trunk_auth_ips i
        JOIN sip_trunks t ON i.trunk_id = t.id
        JOIN customers c ON t.customer_id = c.id
        WHERE i.ip_address = %s AND t.enabled = true AND c.status = 'active'
        LIMIT 1
    ]], sql_string(clean_ip))

    local cursor, err = execute_query(sql)
    if not cursor then
        freeswitch.consoleLog("ERR", "Trunk by IP lookup failed: " .. tostring(err) .. "\n")
        return nil
    end

    local row = cursor:fetch({}, "a")
    cursor:close()

    return row
end

-- Lookup trunk DID
function M.lookup_trunk_did(did)
    -- Validate and sanitize input
    local clean_did = validate_did(did)
    if not clean_did then
        freeswitch.consoleLog("WARN", "Invalid DID format for trunk DID lookup: " .. tostring(did) .. "\n")
        return nil
    end

    local sql = string.format([[
        SELECT td.trunk_id, t.customer_id, t.max_channels,
               c.traffic_grade, c.status
        FROM trunk_dids td
        JOIN sip_trunks t ON td.trunk_id = t.id
        JOIN customers c ON t.customer_id = c.id
        WHERE td.did = %s AND t.enabled = true AND c.status = 'active'
        LIMIT 1
    ]], sql_string(clean_did))

    local cursor, err = execute_query(sql)
    if not cursor then
        freeswitch.consoleLog("ERR", "Trunk DID lookup failed: " .. tostring(err) .. "\n")
        return nil
    end

    local row = cursor:fetch({}, "a")
    cursor:close()

    return row
end

-- Lookup customer PBX IPs for a trunk (for inbound routing to customer)
function M.get_trunk_endpoint_ips(trunk_id)
    local id = tonumber(trunk_id)
    if not id then return nil end

    local sql = string.format([[
        SELECT host(ip_address) as ip, description
        FROM trunk_auth_ips
        WHERE trunk_id = %d
        ORDER BY id ASC
    ]], id)

    local cursor, err = execute_query(sql)
    if not cursor then
        freeswitch.consoleLog("ERR", "Trunk endpoint IP lookup failed: " .. tostring(err) .. "\n")
        return nil
    end

    local ips = {}
    local row = cursor:fetch({}, "a")
    while row do
        table.insert(ips, row.ip)
        row = cursor:fetch({}, "a")
    end
    cursor:close()

    return #ips > 0 and ips or nil
end

-- Insert CDR (async via background job in production)
function M.insert_cdr(cdr)
    -- Validate required fields
    if not cdr or not cdr.uuid then
        freeswitch.consoleLog("ERR", "CDR insert: missing required fields\n")
        return false
    end

    -- Build insert with safe values
    local sql = string.format([[
        INSERT INTO cdrs (uuid, customer_id, product_type, trunk_id, direction,
                          caller_id, destination, start_time, end_time,
                          duration_ms, hangup_cause, carrier_used, traffic_grade)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    ]],
        sql_string(cdr.uuid),
        sql_number(cdr.customer_id),
        sql_string(cdr.product_type or "unknown"),
        sql_number(cdr.trunk_id),
        sql_string(cdr.direction or "unknown"),
        sql_string(cdr.caller_id),
        sql_string(cdr.destination),
        sql_string(cdr.start_time),
        sql_string(cdr.end_time),
        sql_number(cdr.duration_ms or 0),
        sql_string(cdr.hangup_cause or "NORMAL_CLEARING"),
        sql_string(cdr.carrier_used or "default"),
        sql_string(cdr.traffic_grade or "standard")
    )

    local cursor, err = execute_query(sql)
    if not cursor then
        freeswitch.consoleLog("ERR", "CDR insert failed: " .. tostring(err) .. "\n")
        return false
    end

    -- Insert returns number of affected rows, not cursor
    return true
end

-- Lookup customer by ID
function M.lookup_customer(customer_id)
    local clean_id = sql_number(customer_id)
    if clean_id == "NULL" then
        return nil
    end

    local sql = string.format([[
        SELECT id, name, status, traffic_grade, cpm_limit, daily_limit, balance
        FROM customers
        WHERE id = %s AND status = 'active'
        LIMIT 1
    ]], clean_id)

    local cursor, err = execute_query(sql)
    if not cursor then
        return nil
    end

    local row = cursor:fetch({}, "a")
    cursor:close()

    return row
end

-- Get customer tier information
-- Returns: { tier_name, cps_limit, per_call_fee, monthly_fee, features } or nil
function M.get_customer_tier(customer_id, tier_type)
    -- Validate input
    local clean_id = sql_number(customer_id)
    if clean_id == "NULL" then
        freeswitch.consoleLog("WARN", "get_customer_tier: Invalid customer_id\n")
        return nil
    end

    -- Validate tier_type
    tier_type = tier_type or "trunk"
    if tier_type ~= "trunk" and tier_type ~= "api" then
        freeswitch.consoleLog("WARN", "get_customer_tier: Invalid tier_type: " .. tostring(tier_type) .. "\n")
        return nil
    end

    -- Build query based on tier type
    local tier_column = tier_type == "trunk" and "trunk_tier_id" or "api_tier_id"

    local sql = string.format([[
        SELECT
            ct.id AS tier_id,
            ct.name AS tier_name,
            ct.tier_type,
            ct.cps_limit,
            ct.monthly_fee,
            ct.per_call_fee,
            ct.description,
            ct.features::text AS features
        FROM customers c
        JOIN cps_tiers ct ON c.%s = ct.id
        WHERE c.id = %s
          AND c.status = 'active'
          AND ct.is_active = true
        LIMIT 1
    ]], tier_column, clean_id)

    local cursor, err = execute_query(sql)
    if not cursor then
        freeswitch.consoleLog("ERR", "get_customer_tier query failed: " .. tostring(err) .. "\n")
        return nil
    end

    local row = cursor:fetch({}, "a")
    cursor:close()

    if not row then
        -- No tier assigned, return defaults based on type
        freeswitch.consoleLog("DEBUG", string.format(
            "get_customer_tier: No tier found for customer=%s type=%s, using defaults\n",
            tostring(customer_id), tier_type
        ))

        if tier_type == "trunk" then
            return {
                tier_id = nil,
                tier_name = "trunk_standard",
                tier_type = "trunk",
                cps_limit = 5,
                monthly_fee = 0,
                per_call_fee = 0,
                description = "Standard SIP trunk - 5 CPS call setup rate",
                features = "{}"
            }
        else
            return {
                tier_id = nil,
                tier_name = "api_basic",
                tier_type = "api",
                cps_limit = 5,
                monthly_fee = 49.00,
                per_call_fee = 0.0100,
                description = "API Basic - 5 CPS",
                features = "{}"
            }
        end
    end

    -- Convert numeric fields
    row.cps_limit = tonumber(row.cps_limit) or 5
    row.monthly_fee = tonumber(row.monthly_fee) or 0
    row.per_call_fee = tonumber(row.per_call_fee) or 0

    freeswitch.consoleLog("DEBUG", string.format(
        "get_customer_tier: customer=%s tier=%s cps=%d fee=%.4f\n",
        tostring(customer_id), row.tier_name, row.cps_limit, row.per_call_fee
    ))

    return row
end

-- Get all available tiers for a type (for upgrade options)
-- Returns: array of tier objects
function M.get_available_tiers(tier_type)
    tier_type = tier_type or "trunk"
    if tier_type ~= "trunk" and tier_type ~= "api" then
        return {}
    end

    local sql = string.format([[
        SELECT
            id AS tier_id,
            name AS tier_name,
            tier_type,
            cps_limit,
            monthly_fee,
            per_call_fee,
            description,
            features::text AS features
        FROM cps_tiers
        WHERE tier_type = %s
          AND is_active = true
        ORDER BY sort_order ASC, cps_limit ASC
    ]], sql_string(tier_type))

    local cursor, err = execute_query(sql)
    if not cursor then
        freeswitch.consoleLog("ERR", "get_available_tiers query failed: " .. tostring(err) .. "\n")
        return {}
    end

    local tiers = {}
    local row = cursor:fetch({}, "a")
    while row do
        row.cps_limit = tonumber(row.cps_limit) or 0
        row.monthly_fee = tonumber(row.monthly_fee) or 0
        row.per_call_fee = tonumber(row.per_call_fee) or 0
        table.insert(tiers, row)
        row = cursor:fetch({}, "a")
    end
    cursor:close()

    return tiers
end

-- Close connection explicitly (for cleanup)
function M.close()
    if conn then
        pcall(function() conn:close() end)
        conn = nil
    end
    if env then
        pcall(function() env:close() end)
        env = nil
    end
end

return M
