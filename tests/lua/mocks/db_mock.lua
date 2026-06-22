-- Mock of lib/db_client.lua (and lib/redis_client.lua / lib/redis_cps.lua)
-- for headless Lua testing.
--
-- The production scripts load these via load_module(name) which does
-- loadfile(".../lib/<name>.lua")() — the test harness intercepts loadfile and
-- returns these mocks instead, so no PostgreSQL / Redis / luasql is needed.
--
-- Only the query functions the routing scripts actually call are implemented;
-- each returns a configurable canned row (or nil for "not found").
local M = {}

-- Build a db_client mock. `cfg` controls the canned responses:
--   cfg.rcf            : table returned by lookup_rcf (or nil)
--   cfg.api_did        : table returned by lookup_api_did (or nil)
--   cfg.trunk_did      : table returned by lookup_trunk_did (or nil)
--   cfg.extension_did  : table returned by lookup_extension_did (or nil)
--   cfg.endpoint_ips   : array returned by get_trunk_endpoint_ips
--   cfg.trunk_by_ip    : table returned by lookup_trunk_by_ip
function M.new_db(cfg)
    cfg = cfg or {}
    local db = {}
    db._cfg = cfg

    function db.lookup_rcf(did)
        cfg.last_rcf_did = did
        return cfg.rcf
    end

    function db.lookup_api_did(did)
        cfg.last_api_did = did
        return cfg.api_did
    end

    function db.lookup_trunk_did(did)
        cfg.last_trunk_did = did
        return cfg.trunk_did
    end

    -- UCaaS extension-by-DID lookup (extensions.assigned_did). Returns a row
    -- with extension / customer_id / display_name, or nil for "not found".
    function db.lookup_extension_did(did)
        cfg.last_extension_did = did
        return cfg.extension_did
    end

    function db.lookup_trunk_by_ip(ip)
        cfg.last_trunk_ip = ip
        return cfg.trunk_by_ip
    end

    function db.get_trunk_endpoint_ips(trunk_id)
        cfg.last_endpoint_trunk = trunk_id
        return cfg.endpoint_ips
    end

    function db.lookup_customer(id) return cfg.customer end

    -- Visual Voicemail mailbox resolution. Default nil (no mailbox) so existing
    -- rcf/ucaas specs take the LEGACY spool path unchanged; a spec can set
    -- cfg.voicemail / cfg.attached_mailbox to exercise the new encrypted paths.
    function db.lookup_voicemail_did(did)
        cfg.last_voicemail_did = did
        return cfg.voicemail
    end

    function db.lookup_attached_mailbox(product, ref)
        cfg.last_attached = { product = product, ref = ref }
        return cfg.attached_mailbox
    end

    -- trunk_outbound.lua's default-DID fallback uses get_connection():execute().
    function db.get_connection()
        if cfg.connection == false then return nil end
        return {
            execute = function(_, _sql)
                return {
                    fetch = function() return cfg.default_did_row end,
                    close = function() end,
                }
            end,
        }
    end

    return db
end

-- Minimal redis mocks (fail-open no-ops). Returning these from load_module is
-- optional; passing nil also works since every redis call is `if redis then`.
function M.new_redis()
    local r = {}
    function r.check_prefix() return false, nil, nil end
    function r.cps_check() return true, 0 end
    function r.acquire_channel() return true, 0, 999 end
    function r.release_channel() return 0 end
    function r.velocity_check() return true, nil, 0 end
    function r.health_check() return true, "OK" end
    return r
end

function M.new_redis_cps()
    local r = {}
    function r.check_cps_with_tier()
        return { allowed = true, current_cps = 0, limit = 9999, tier = "free", tier_name = "Free" }
    end
    return r
end

return M
