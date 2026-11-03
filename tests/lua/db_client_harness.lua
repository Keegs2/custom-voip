-- Unit harness for docker/freeswitch/scripts/lib/db_client.lua — the two
-- premium-routing reads (TED contract C7). NOT loaded by FreeSWITCH. The real
-- db_client runs on a FAKE luasql (package.loadlib stub) whose connection
-- scripts each SQL statement, so the error paths are exercised for real:
--
--   [1] get_termination_trunks: selects tier1; when that SELECT fails on a
--       LIVE connection (migration 64 missing / not replicated) it retries
--       the pre-64 SELECT once and still returns the trunk list (tier1 nil);
--       when the DB is unreachable (NO_CONNECTION) it does NOT retry (no
--       second connect_timeout) and returns nil.
--   [2] lookup_customer_grade: one PK read on the connection already in use;
--       no live connection -> nil WITHOUT connecting; a query error or a bad
--       id -> nil; never reconnects or probes.
--
-- Usage: lua tests/lua/db_client_harness.lua

local LIB_DIR = "docker/freeswitch/scripts/lib/"

local failures = 0
local function check(name, cond, detail)
    if cond then print("  PASS  " .. name)
    else failures = failures + 1; print("  FAIL  " .. name .. " -- " .. tostring(detail)) end
end

-- Build a fresh db_client over a scripted fake luasql.
--   behave(sql) -> rows (array of tables) | error string (raises)
local function load_db(behave, opts)
    opts = opts or {}
    local st = { connects = 0, sql = {} }
    local function cursor(rows)
        local i = 0
        return setmetatable({}, { __index = {
            fetch = function(_, t, _) i = i + 1; return rows[i] end,
            close = function() end,
        } })
    end
    local conn = {
        execute = function(_, sql)
            st.sql[#st.sql + 1] = sql
            if sql == "SELECT 1" then return cursor({ {} }) end
            local r = behave(sql)
            if type(r) == "string" then error(r) end
            return cursor(r)
        end,
        close = function() end,
    }
    local luasql = { postgres = function()
        return { connect = function()
            st.connects = st.connects + 1
            if opts.down then error("could not connect to server") end
            return conn
        end }
    end }
    local env = setmetatable({
        freeswitch = { consoleLog = function() end },
        os = setmetatable({ getenv = function() return nil end, time = os.time }, { __index = os }),
    }, { __index = _G })
    env.package = setmetatable({
        loadlib = function() return function() return luasql end end,
    }, { __index = package })
    env.loadfile = function(path)
        local lib = tostring(path):match("/lib/([%w_]+)%.lua$")
        if lib then return loadfile(LIB_DIR .. lib .. ".lua", "t", env) end
        return loadfile(path)
    end
    local chunk = assert(loadfile(LIB_DIR .. "db_client.lua", "t", env))
    return chunk(), st
end

local ROWS = {
    { carrier = "bandwidth", pop = "dallas", term_ip = "67.231.2.12", traffic_class = "ld", tier1 = "t" },
    { carrier = "sinch", pop = "atlanta-ld", term_ip = "206.146.98.26", traffic_class = "ld", tier1 = "f" },
}

print("== db_client_harness ==")

do
    print("[1] get_termination_trunks: tier1, then the pre-64 retry")
    local db, st = load_db(function(sql)
        if sql:find("tier1", 1, true) then return ROWS end
        return "unexpected"
    end)
    local t = db.get_termination_trunks("west")
    check("1a tier1 SELECT: rows returned with tier1", t and #t == 2 and t[1].tier1 == "t"
          and t[2].tier1 == "f", t and #t)
    check("1a zone column interpolated", st.sql[#st.sql]:find("priority_west", 1, true) ~= nil)

    local db2, st2 = load_db(function(sql)
        if sql:find("tier1", 1, true) then
            return 'ERROR: column "tier1" does not exist'
        end
        return { { carrier = "bandwidth", pop = "dallas", term_ip = "67.231.2.12",
                   traffic_class = "ld" } }
    end)
    local t2 = db2.get_termination_trunks("east")
    check("1b missing column: the pre-64 SELECT ran and the list came back",
          t2 and #t2 == 1 and t2[1].carrier == "bandwidth" and t2[1].tier1 == nil, t2 and #t2)
    local tier_sqls, plain_sqls = 0, 0
    for _, q in ipairs(st2.sql) do
        if q:find("carrier_trunks", 1, true) then
            if q:find("tier1", 1, true) then tier_sqls = tier_sqls + 1 else plain_sqls = plain_sqls + 1 end
        end
    end
    check("1b exactly one try with tier1 and one retry without",
          tier_sqls == 1 and plain_sqls == 1, tier_sqls .. "/" .. plain_sqls)
    check("1b one connection, no reconnect for the retry", st2.connects == 1, st2.connects)

    local db3, st3 = load_db(function() return "boom" end)
    check("1c both SELECTs fail -> nil (legacy loop)", db3.get_termination_trunks("east") == nil)

    local db4, st4 = load_db(function() return ROWS end, { down = true })
    check("1d DB down -> nil", db4.get_termination_trunks("east") == nil)
    check("1d DB down -> ONE connect attempt (no retry, no second connect_timeout)",
          st4.connects == 1, st4.connects)
end

do
    print("[2] lookup_customer_grade: cheap and fail-safe")
    local db, st = load_db(function(sql)
        if sql:find("FROM customers", 1, true) then
            if sql:find("id = 77", 1, true) then return { { traffic_grade = "premium" } } end
            if sql:find("id = 66", 1, true) then return "server closed the connection" end
            return {}
        end
        return ROWS
    end)
    check("2a no live connection yet -> nil without connecting",
          db.lookup_customer_grade(77) == nil and st.connects == 0, st.connects)
    db.get_termination_trunks("east")             -- the call's connection is now live
    local before = st.connects
    check("2b live connection -> the customer's grade", db.lookup_customer_grade("77") == "premium")
    check("2b unknown customer -> nil", db.lookup_customer_grade(78) == nil)
    check("2c query error -> nil (no raise)", db.lookup_customer_grade(66) == nil)
    check("2d bad ids -> nil, no query", db.lookup_customer_grade("7; DROP") == nil
          and db.lookup_customer_grade(nil) == nil and db.lookup_customer_grade(1.5) == nil
          and db.lookup_customer_grade(0) == nil)
    local probes = 0
    for _, q in ipairs(st.sql) do if q == "SELECT 1" then probes = probes + 1 end end
    check("2e never connects or probes", st.connects == before and probes == 0,
          st.connects .. " connects, " .. probes .. " probes")
end

print("")
if failures == 0 then
    print("ALL DB_CLIENT HARNESS ASSERTIONS PASSED"); os.exit(0)
else
    print(failures .. " DB_CLIENT HARNESS ASSERTION(S) FAILED"); os.exit(1)
end
