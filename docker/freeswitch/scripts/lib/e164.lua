-- lib/e164.lua — E.164 number normalization helpers (RCF-V1)
--
-- Single source of truth for the number-format helpers that were previously
-- copy-pasted verbatim into inbound_router.lua, trunk_outbound.lua and
-- outbound_api.lua (the tier-aware api_outbound.lua copy was deleted in the
-- Phase 9 remediation as dead code). The function BODIES here are
-- byte-for-byte the shipped logic — this extraction is behavior-preserving and
-- is independently characterized by tests/lua/spec/e164_spec.lua and pinned by
-- the existing normalization_spec.lua (which extracts these same names out of
-- the production scripts after they bind `local x = e164.x`).
--
-- Loaded the same proven way as the other lib/ modules — via the load_module()
-- loadfile() pattern (see CLAUDE.md gotcha #10: mod_lua's package searcher
-- breaks bare require() for script-directory modules).

local M = {}

-- Convert an E.164 or 11-digit number to 10-digit format for carrier delivery.
-- Strips +1 / a leading 1; passes through anything that is not 10/11 digits.
function M.to_10digit(number)
    if not number or number == "" then return number end
    local digits = number:gsub("[^%d]", "")
    if #digits == 11 and digits:sub(1, 1) == "1" then
        return digits:sub(2)
    elseif #digits == 10 then
        return digits
    end
    return digits
end

-- Normalize a DID to E.164 format.
-- Keeps an existing leading +; 10-digit US -> +1; 11-digit leading 1 -> +;
-- otherwise prefixes a bare "+". (Inbound/DID-lookup semantics.)
function M.normalize_did(number)
    -- Remove any non-digit characters except +
    local clean = number:gsub("[^%d+]", "")

    -- If starts with +, keep as-is
    if clean:match("^%+") then
        return clean
    end

    -- Get digit count (Lua patterns don't support {n} quantifiers)
    local digit_count = #clean

    -- If 10 digits (US), prepend +1
    if digit_count == 10 and clean:match("^%d+$") then
        return "+1" .. clean
    end

    -- If 11 digits starting with 1 (US), prepend +
    if digit_count == 11 and clean:match("^1%d+$") then
        return "+" .. clean
    end

    -- Otherwise, assume needs + prefix
    return "+" .. clean
end

-- Normalize a dialed destination to E.164 format.
-- Same as normalize_did but additionally (a) preserves * and # service codes
-- and (b) converts an 011 international prefix to "+". (Outbound-dial semantics.)
function M.normalize_destination(number)
    local clean = number:gsub("[^%d+*#]", "")
    if clean:match("^%+") then
        return clean
    end
    local digit_count = #clean
    if digit_count == 10 and clean:match("^%d+$") then
        return "+1" .. clean
    end
    if digit_count == 11 and clean:match("^1%d+$") then
        return "+" .. clean
    end
    if clean:match("^011") then
        return "+" .. clean:gsub("^011", "")
    end
    return "+" .. clean
end

return M
