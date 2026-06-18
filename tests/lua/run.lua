-- Standalone runner for the Lua characterization specs WITHOUT busted.
--
-- Loads the busted-compatible shim (which installs the describe/it/assert
-- globals), then runs every spec in tests/lua/spec/. Exits non-zero if any
-- assertion fails. The Makefile `test-lua` target prefers real `busted` and
-- falls back to this runner when busted is not installed.
--
-- Run:  lua tests/lua/run.lua   (from the repo root)
local this_dir = (debug.getinfo(1, "S").source:match("^@(.*/)") or "./")

-- Make `require("mocks.xxx")`, `require("helpers")` resolve from tests/lua/.
package.path = this_dir .. "?.lua;" .. this_dir .. "?/init.lua;" .. package.path

local Shim = dofile(this_dir .. "busted_shim.lua")

local specs = {
    "spec/normalization_spec.lua",
    "spec/inbound_router_spec.lua",
    "spec/ucaas_inbound_spec.lua",
    "spec/trunk_outbound_spec.lua",
}

for _, rel in ipairs(specs) do
    dofile(this_dir .. rel)
end

local failed = Shim.report()
os.exit(failed > 0 and 1 or 0)
