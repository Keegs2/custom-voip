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
        local ok, result = pcall(loader)
        if ok then
            luasql = result
        else
            if freeswitch and freeswitch.consoleLog then
                freeswitch.consoleLog("ERR", "luasql.postgres loader failed: " .. tostring(result) .. "\n")
            end
        end
    else
        if freeswitch and freeswitch.consoleLog then
            freeswitch.consoleLog("ERR", "Failed to load luasql.postgres: " .. tostring(err) .. "\n")
        end
    end
end

local M = {}

-- Lazy JSON decoder (lib/json.lua). Only the UCaaS extension lookup needs it
-- (to parse the extensions.ring_plan JSONB column), so it is loaded on first
-- use via the same loadfile() pattern the dispatcher uses for lib modules
-- (CLAUDE.md gotcha #10 — require() is broken under mod_lua). Cached after the
-- first successful load; a load failure is non-fatal (ring_plan just stays nil
-- and the caller degrades to the legacy single-bridge path).
local _json = nil
local _json_tried = false
local function get_json()
    if _json then return _json end
    if _json_tried then return nil end
    _json_tried = true
    for _, path in ipairs({
        "/usr/local/freeswitch/scripts/lib/json.lua",
        "/usr/share/freeswitch/scripts/lib/json.lua",
    }) do
        local chunk = loadfile(path)
        if chunk then
            local ok, mod = pcall(chunk)
            if ok and type(mod) == "table" and mod.decode then
                _json = mod
                return _json
            end
        end
    end
    if freeswitch and freeswitch.consoleLog then
        freeswitch.consoleLog("WARN",
            "lib/json.lua not loadable; ring_plan parsing disabled (single-bridge fallback)\n")
    end
    return nil
end

-- Decode a JSONB column handed back by luasql as ::text into a Lua table, or
-- nil. Shared by the two read-only routing-plan columns: extensions.ring_plan
-- (UCaaS find-me/follow-me) and trunk_dids.route_plan (SIP-trunk multi-endpoint
-- delivery). The backend OWNS/writes these columns; we only READ them.
--
-- FAIL-SAFE: a NULL/empty/"null" value, a missing JSON decoder, OR malformed
-- JSON all yield nil so the caller degrades cleanly to its legacy single-bridge
-- path — a bad plan must NEVER abort the call. `label` is used only for the
-- warning log on malformed input.
local function decode_jsonb_column(raw, label)
    if not raw or type(raw) ~= "string" then return nil end
    local trimmed = raw:gsub("^%s*(.-)%s*$", "%1")
    if trimmed == "" or trimmed == "null" then return nil end
    local json = get_json()
    if not json then return nil end
    local parsed, perr = json.decode(trimmed)
    if type(parsed) == "table" then return parsed end
    if freeswitch and freeswitch.consoleLog then
        freeswitch.consoleLog("WARN", string.format(
            "%s has unparseable JSON (%s) — using single-bridge fallback\n",
            tostring(label), tostring(perr)))
    end
    return nil
end

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
    -- If luasql library isn't available, return nil
    if not luasql then
        return nil
    end

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

    -- routing_plan is JSONB; cast to ::text so luasql hands it back as a string
    -- we can parse with lib/json.lua. The backend owns/writes this column (the
    -- Call Flow Builder's RICH RCF artifact — ordered match rules + fallback);
    -- we only READ it here. NULL when no rich plan exists -> handlers/rcf.lua
    -- keeps the legacy single-forward_to bridge (backward compatible).
    local sql = string.format([[
        SELECT r.forward_to, r.customer_id, r.pass_caller_id, r.ring_timeout,
               r.max_channels, r.name, r.routing_plan::text AS routing_plan,
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

    -- Parse the routing_plan JSONB text into a Lua table (or nil). A nil/empty/
    -- "null"/malformed plan -> row.routing_plan = nil -> handlers/rcf.lua keeps
    -- the legacy single-forward path (fail-safe: a bad plan must NEVER abort the
    -- LIVE RCF call path). Shared decoder with the trunk/extension plan columns.
    if row then
        row.routing_plan = decode_jsonb_column(
            row.routing_plan, "rcf " .. tostring(clean_did) .. " routing_plan")
    end

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
               c.traffic_grade, c.cpm_limit, c.daily_limit, c.status,
               c.webhook_signing_secret
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
        WHERE host(i.ip_address) = %s AND t.enabled = true AND c.status = 'active'
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

    -- route_plan is JSONB; cast to ::text so luasql hands it back as a string we
    -- can parse with lib/json.lua. The backend owns/writes this column (SIP-trunk
    -- inbound multi-endpoint delivery — failover ordering / parallel); we only
    -- READ it here. NULL when no route plan exists -> legacy single-endpoint bridge.
    local sql = string.format([[
        SELECT td.trunk_id, t.customer_id, t.max_channels,
               c.traffic_grade, c.status, td.route_plan::text AS route_plan
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

    -- Parse the route_plan JSONB text into a Lua table (or nil). A nil/empty/
    -- "null"/malformed plan -> row.route_plan = nil -> handlers/trunk.lua keeps
    -- the legacy single-endpoint bridge (backward compatible / fail-safe).
    if row then
        row.route_plan = decode_jsonb_column(
            row.route_plan, "trunk_did " .. tostring(clean_did) .. " route_plan")
    end

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

-- ---------------------------------------------------------------------------
-- Fraud / toll-fraud controls (RCF international + premium-destination blocklist).
--
-- These use the SYNCHRONOUS PostgreSQL path — NOT Redis. The redis-lua threading
-- issue that removed Redis from the RCF path does NOT affect db_client (one
-- persistent conn per mod_lua thread, connect_timeout=5). The `high_risk_prefixes`
-- table is the ONE source of truth for the fraud-prefix blocklist: trunk_outbound
-- and outbound_api read it via the Redis CACHE (hrp:{prefix}) of this same table;
-- the RCF path reads the table DIRECTLY here so there is a single source extended
-- to RCF without re-introducing Redis.
-- ---------------------------------------------------------------------------

-- Longest-prefix match of an outbound destination against high_risk_prefixes.
-- `destination` must be the E.164 number WITHOUT the leading "+" (digits only):
-- NANP carries the leading 1 (e.g. "17775556666"), international is CC+number
-- (e.g. "5312345678"). Returns: is_risky(bool), risk_level(string|nil),
-- prefix(string|nil). Seeded risk_level values: elevated|high|critical|blocked.
--
-- FAIL-OPEN: any DB error / no match -> (false, nil, nil), so a DB hiccup never
-- blocks calls (consistent with the RCF degrade philosophy). A definitive
-- 'blocked' match is the caller's cue to fail CLOSED (reject the forward).
function M.check_high_risk_prefix(destination)
    local digits = tostring(destination or ""):gsub("[^%d]", "")
    if digits == "" then return false, nil, nil end

    -- "<dest> LIKE prefix || '%'" == "destination starts with prefix". Prefixes
    -- are digit strings (no LIKE metacharacters), longest match wins. The %% in
    -- string.format renders a single literal % for SQL.
    local sql = string.format([[
        SELECT prefix, risk_level
        FROM high_risk_prefixes
        WHERE enabled = true AND %s LIKE prefix || '%%'
        ORDER BY length(prefix) DESC
        LIMIT 1
    ]], sql_string(digits))

    local cursor, err = execute_query(sql)
    if not cursor then
        freeswitch.consoleLog("WARNING",
            "high_risk_prefixes lookup failed (fail-open): " .. tostring(err) .. "\n")
        return false, nil, nil
    end
    local row = cursor:fetch({}, "a")
    cursor:close()
    if not row then return false, nil, nil end
    return true, row.risk_level, row.prefix
end

-- Per-customer fraud policy (RCF international gate + concurrent-call cap).
-- Reads the two columns the BACKEND adds to `customers` (contract — do NOT create
-- them here, only READ):
--   international_calling_enabled BOOLEAN NOT NULL DEFAULT false
--   max_concurrent_calls         INTEGER NOT NULL DEFAULT 30
-- Returns (policy, nil) on success where policy = { intl_enabled=bool,
-- max_concurrent=int }; on failure returns (nil, reason) where reason is
-- "schema_missing" (rollout: the columns not added yet — a PostgreSQL "does not
-- exist" error), "db_error" (transient), "no_customer", or "invalid_customer".
-- H-5: the RCF caller now FAILS CLOSED for INTERNATIONAL / high-cost-NPA
-- destinations on a nil policy (a schema gap or a DB blip must never leave
-- international ungated) while DOMESTIC NANP keeps flowing; the per-customer
-- concurrency cap still fails OPEN (the per-DID mod_hash cap is the backstop). The
-- reason lets the caller page loudly ONCE on the rollout gap vs a transient error.
-- Enforcement of the real flag activates automatically once the columns exist and
-- the query succeeds. (SEPARATE query from lookup_rcf on purpose: it keeps the LIVE
-- hot-path DID lookup untouched, so a missing column can never break DID resolution.)
function M.get_customer_fraud_policy(customer_id)
    local clean_id = sql_number(customer_id)
    if clean_id == "NULL" then return nil, "invalid_customer" end

    local sql = string.format([[
        SELECT international_calling_enabled, max_concurrent_calls
        FROM customers
        WHERE id = %s
        LIMIT 1
    ]], clean_id)

    local cursor, err = execute_query(sql)
    if not cursor then
        -- Distinguish a ROLLOUT schema gap (columns not present -> PostgreSQL
        -- "does not exist") from a transient DB error, so the caller can page
        -- loudly ONCE on the former. Either way the caller FAILS CLOSED for intl.
        local reason = "db_error"
        if tostring(err):lower():find("does not exist", 1, true) then
            reason = "schema_missing"
        end
        freeswitch.consoleLog("WARNING",
            "customer fraud policy lookup failed (international now FAIL-CLOSED; reason="
            .. reason .. " — is the international_calling_enabled/max_concurrent_calls "
            .. "migration applied?): " .. tostring(err) .. "\n")
        return nil, reason
    end
    local row = cursor:fetch({}, "a")
    cursor:close()
    if not row then return nil, "no_customer" end

    local intl = (row.international_calling_enabled == "t"
        or row.international_calling_enabled == true
        or row.international_calling_enabled == "true"
        or row.international_calling_enabled == "1")
    return {
        intl_enabled = intl,
        max_concurrent = tonumber(row.max_concurrent_calls) or 0,
    }, nil
end

-- Least-Cost Outbound (LCO) carrier ordering — READ-ONLY longest-prefix lookup.
-- Reads the BACKEND-owned `lco_route` view (CONTRACT — telephony NEVER
-- writes it; the backend owns the rate deck + LCO decision). Returns the ORDERED
-- array of carrier tokens (x_carrier_value) for the destination's LONGEST matching
-- prefix, or nil on no-match / ANY error.
--
-- FAIL-OPEN (nil): a missing view (rollout lag) or a DB hiccup returns nil, and
-- the caller (lib/lco -> handlers/rcf) then keeps its DEFAULT carrier ordering —
-- so LCO can never break or weaken the LIVE carrier failover path. Enforcement
-- activates automatically once the backend creates + populates the view. This is
-- a SEPARATE query from the DID lookups on purpose (a missing lco_route view can
-- never break DID resolution).
--
-- Contract columns (see lib/lco.lua for the full contract): prefix TEXT,
-- x_carrier_value TEXT (primary|secondary|tc1|tc2|tc4), priority INT. The view is
-- pre-filtered on enabled rows by the backend, so there is no `enabled` column here.
function M.lookup_lco_route(destination)
    local digits = tostring(destination or ""):gsub("[^%d]", "")
    if digits == "" then return nil end

    -- Longest-prefix match, then order THAT prefix's carriers by priority. The
    -- inner subquery pins the SINGLE longest matching prefix so carriers from a
    -- shorter prefix never dilute the order. Prefixes are digit strings (no LIKE
    -- metacharacters); %% renders a single literal % for SQL.
    local sql = string.format([[
        SELECT x_carrier_value
        FROM lco_route
        WHERE %s LIKE prefix || '%%'
          AND length(prefix) = (
              SELECT max(length(p.prefix)) FROM lco_route p
              WHERE %s LIKE p.prefix || '%%'
          )
        ORDER BY priority ASC, x_carrier_value ASC
        LIMIT 8
    ]], sql_string(digits), sql_string(digits))

    local cursor, err = execute_query(sql)
    if not cursor then
        freeswitch.consoleLog("WARNING",
            "lco_route lookup failed (fail-open — is the lco_route view present?): "
            .. tostring(err) .. "\n")
        return nil
    end

    local out = {}
    local row = cursor:fetch({}, "a")
    while row do
        if row.x_carrier_value and row.x_carrier_value ~= "" then
            out[#out + 1] = row.x_carrier_value
        end
        row = cursor:fetch({}, "a")
    end
    cursor:close()

    if #out == 0 then return nil end
    return out
end

-- Microsoft Teams Direct Routing — READ-ONLY "is this DID Teams-enabled?" lookup.
-- Reads the BACKEND-owned `teams_dids` view/table (CONTRACT — telephony NEVER
-- writes it). Returns { customer_id, teams_tenant } on a hit, or nil.
--
-- FAIL-SAFE (nil): a missing view (Teams not provisioned / rollout lag) or a DB
-- error returns nil, so the caller falls through to the normal RCF/API/trunk/UCaaS
-- cascade — Teams can never break existing DID routing. The caller ALSO gates this
-- behind TEAMS_DIRECT_ROUTING_ENABLED, so when Teams is off this query never runs.
--
-- Contract: teams_dids(did TEXT, customer_id INT, enabled BOOL[, teams_tenant TEXT]).
-- Equivalent alternative the backend may prefer: a routing_target='teams' column on
-- the existing DID tables — if chosen, repoint this query (read-only either way).
function M.lookup_teams_did(did)
    local clean_did = validate_did(did)
    if not clean_did then return nil end

    local sql = string.format([[
        SELECT customer_id, teams_tenant
        FROM teams_dids
        WHERE did = %s AND enabled = true
        LIMIT 1
    ]], sql_string(clean_did))

    local cursor, err = execute_query(sql)
    if not cursor then
        freeswitch.consoleLog("WARNING",
            "teams_dids lookup failed (fail-open — is the teams_dids view present?): "
            .. tostring(err) .. "\n")
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

-- Lookup UCaaS extension by assigned DID (for inbound routing to user extension)
function M.lookup_extension_did(did)
    -- Validate and sanitize input
    local clean_did = validate_did(did)
    if not clean_did then
        freeswitch.consoleLog("WARN", "Invalid DID format for extension DID lookup: " .. tostring(did) .. "\n")
        return nil
    end

    -- ring_plan is JSONB; cast to ::text so luasql hands it back as a string we
    -- can parse with lib/json.lua. The backend owns/writes this column (UCaaS
    -- find-me/follow-me); we only READ it here. NULL when no ring plan exists.
    local sql = string.format([[
        SELECT e.extension, e.customer_id, e.display_name, e.ring_plan::text AS ring_plan
        FROM extensions e
        WHERE e.assigned_did = %s AND e.status = 'active'
        LIMIT 1
    ]], sql_string(clean_did))

    local cursor, err = execute_query(sql)
    if not cursor then
        freeswitch.consoleLog("ERR", "Extension DID lookup failed: " .. tostring(err) .. "\n")
        return nil
    end

    local row = cursor:fetch({}, "a")
    cursor:close()

    -- Parse the ring_plan JSONB text into a Lua table. A nil/empty/"null"
    -- column means "no ring plan" -> ring_plan = nil -> caller keeps the legacy
    -- single-extension bridge. A malformed plan is logged and treated as nil
    -- (fail-safe: a bad plan must NEVER abort the call), so handlers/ucaas.lua
    -- always receives either a well-formed table or nil. (Shared decoder with
    -- the trunk route_plan path — see decode_jsonb_column above.)
    if row then
        row.ring_plan = decode_jsonb_column(
            row.ring_plan, "extension " .. tostring(row.extension) .. " ring_plan")
    end

    return row
end

-- ---------------------------------------------------------------------------
-- Visual Voicemail (Phase 1) — mailbox resolution against voicemail_box_bindings.
-- The backend OWNS/writes these tables; FreeSWITCH has READ-ONLY SELECT
-- (granted in 33_schema_voicemail_product.sql). v1 resolution is DETERMINISTIC:
-- by the dialed DID (dedicated_did) or by the originating product+ref (attached).
-- No diversion / History-Info / carrier-header dependency.
-- ---------------------------------------------------------------------------

-- Lookup a DEDICATED-DID mailbox: the dialed DID is a mailbox's own access DID
-- (voicemail_box_bindings.binding_type='dedicated_did' AND did = to_did). Used by
-- the inbound_router dispatch cascade (LAST, after rcf/api/trunk/ucaas) to route
-- the call to handlers/voicemail.lua. Returns product_type='voicemail' with the
-- mailbox id + mode, or nil. ring_target/ring_timeout are reserved for the
-- Phase-2 ring-target-then-VM feature (not in the v1 schema → stay nil).
function M.lookup_voicemail_did(did)
    local clean_did = validate_did(did)
    if not clean_did then
        freeswitch.consoleLog("WARN", "Invalid DID format for voicemail lookup: " .. tostring(did) .. "\n")
        return nil
    end

    local sql = string.format([[
        SELECT bd.mailbox_id, b.customer_id, b.timezone
        FROM voicemail_box_bindings bd
        JOIN voicemail_boxes b ON bd.mailbox_id = b.id
        WHERE bd.binding_type = 'dedicated_did' AND bd.did = %s
          AND b.status = 'active'
        LIMIT 1
    ]], sql_string(clean_did))

    local cursor, err = execute_query(sql)
    if not cursor then
        freeswitch.consoleLog("ERR", "Voicemail DID lookup failed: " .. tostring(err) .. "\n")
        return nil
    end

    local row = cursor:fetch({}, "a")
    cursor:close()
    if not row then return nil end

    return {
        product_type = "voicemail",
        mailbox_id   = row.mailbox_id,
        customer_id  = row.customer_id,
        timezone     = row.timezone,
        mode         = "direct",
    }
end

-- Lookup an ATTACHED mailbox: a mailbox bound as the no-answer/busy fallback of
-- an existing revup line (binding_type='attached', keyed by (attach_product,
-- attach_ref)). Called ONLY from the rcf/ucaas voicemail-fallback path (NOT on
-- the call-setup hot path) to decide whether a no-answer becomes an ENCRYPTED
-- deposit (mailbox bound) or the LEGACY spool deposit (no mailbox bound — gate
-- returns nil). attach_ref is the normalized E.164 DID the handler also sends to
-- the ingest, so the FS gate and the API resolution agree on the same binding.
function M.lookup_attached_mailbox(attach_product, attach_ref)
    if not attach_product or attach_product == "" then return nil end
    if not attach_ref or attach_ref == "" then return nil end
    local p = tostring(attach_product)
    -- attach_product is a fixed enum (schema CHECK) — whitelist it.
    if p ~= "rcf" and p ~= "trunk" and p ~= "ucaas" and p ~= "api" then return nil end

    local sql = string.format([[
        SELECT bd.mailbox_id, b.customer_id, b.timezone
        FROM voicemail_box_bindings bd
        JOIN voicemail_boxes b ON bd.mailbox_id = b.id
        WHERE bd.binding_type = 'attached' AND bd.attach_product = %s
          AND bd.attach_ref = %s AND b.status = 'active'
        LIMIT 1
    ]], sql_string(p), sql_string(tostring(attach_ref)))

    local cursor, err = execute_query(sql)
    if not cursor then
        freeswitch.consoleLog("ERR", "Attached mailbox lookup failed: " .. tostring(err) .. "\n")
        return nil
    end

    local row = cursor:fetch({}, "a")
    cursor:close()
    if not row then return nil end

    return {
        mailbox_id  = row.mailbox_id,
        customer_id = row.customer_id,
        timezone    = row.timezone,
    }
end

-- Lookup assigned DID for an extension (for outbound caller ID)
function M.lookup_did_for_extension(ext)
    if not ext or ext == "" then
        return nil
    end

    -- Extensions are short digit strings (e.g., "1001"), sanitize
    local clean_ext = tostring(ext):gsub("[^%d]", "")
    if clean_ext == "" then
        return nil
    end

    local sql = string.format([[
        SELECT assigned_did
        FROM extensions
        WHERE extension = %s AND assigned_did IS NOT NULL AND status = 'active'
        LIMIT 1
    ]], sql_string(clean_ext))

    local cursor, err = execute_query(sql)
    if not cursor then
        freeswitch.consoleLog("ERR", "DID for extension lookup failed: " .. tostring(err) .. "\n")
        return nil
    end

    local row = cursor:fetch({}, "a")
    cursor:close()

    return row
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
