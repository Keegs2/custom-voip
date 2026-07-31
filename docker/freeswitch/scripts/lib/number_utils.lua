-- number_utils.lua — Canonical phone-number normalization for the switch layer
-- =============================================================================
-- SINGLE SOURCE OF TRUTH for E.164 normalization on the FreeSWITCH/Lua side.
-- This is ONE THIRD of an app-wide, three-language implementation of the SAME
-- algorithm. All three MUST stay byte-for-byte equivalent in their outputs:
--
--     Lua  : docker/freeswitch/scripts/lib/number_utils.lua   (THIS FILE)
--     Python: docker/api/src/utils/phone.py                    (to_e164 / to_10digit)
--     TS    : docker/ui/src/utils/phone.ts                     (toE164 / to10Digit)
--
-- If you change the algorithm here, change it in phone.py AND phone.ts too, and
-- re-run the shared TEST VECTORS below in all three. Divergence between layers
-- causes DID lookups to miss (call rejected) or the wrong number to hit the
-- carrier (mis-billed / mis-routed call).
--
-- =============================================================================
-- THE CANONICAL SPEC
-- =============================================================================
-- Canonical form = E.164 WITH a leading '+', PRESERVING THE COUNTRY CODE.
-- Only a BARE 10-digit number (no '+') defaults to +1 (US). We NEVER strip a
-- '+' and NEVER force +1 onto a number that already carries a country code —
-- international numbers (+44…, +52…) pass through UNCHANGED.
--
-- to_e164(raw) -> canonical string, or (nil, err) on failure:
--   1. s = trim(raw); if empty -> fail
--   2. hasPlus = s starts with '+'
--   3. d = the digit characters of s (drop '+', space, '-', '(', ')', '.')
--   4. if hasPlus:
--        if 8 <= #d <= 15 and first digit in 1..9 -> return '+'..d   (preserve CC)
--        else fail
--   5. if #d == 11 and d[1]=='1' and d[2] in 2..9   -> return '+'..d   (1 + NANP)
--   6. if #d == 10 and d[1] in 2..9                 -> return '+1'..d   (bare US;
--                                                       the ONLY place +1 is added)
--   7. fail
--
-- to_10digit(raw) -> the LAST 10 digits (used ONLY for the outbound From /
--   caller-ID that authenticates to Bandwidth — keep this behavior/semantics).
--
-- =============================================================================
-- TEST VECTORS (must match across Lua / Python / TS)
-- =============================================================================
--   '5551234567'      -> '+15551234567'
--   '15551234567'     -> '+15551234567'
--   '+15551234567'    -> '+15551234567'
--   '(555) 123-4567'  -> '+15551234567'
--   '+447911123456'   -> '+447911123456'    (PRESERVED — NOT +1)
--   '+5215512345678'  -> '+5215512345678'   (PRESERVED — NOT +1)
-- =============================================================================

local M = {}

-- Extract only the ASCII digit characters [0-9] from a string.
-- gsub with "%D" (non-digit) is Unicode-agnostic and matches the Python
-- re.sub(r"\D", "", s) / TS replace(/\D/g, "") behavior for ASCII input.
local function digits_only(s)
    local d = s:gsub("%D", "")
    return d
end

-- to_e164(raw) -> canonical E.164 string (with '+'), or nil + error message.
-- Deterministic, allocation-light, no external deps — safe to call on the live
-- SIP path (per call, multiple times).
function M.to_e164(raw)
    if raw == nil then
        return nil, "nil input"
    end
    -- Accept numbers/other scalars defensively; the spec operates on a string.
    if type(raw) ~= "string" then
        raw = tostring(raw)
    end

    -- 1. trim leading/trailing ASCII whitespace; empty -> fail
    local s = raw:gsub("^%s+", ""):gsub("%s+$", "")
    if s == "" then
        return nil, "empty input"
    end

    -- 2. did the caller assert a country code with a leading '+'?
    local has_plus = s:sub(1, 1) == "+"

    -- 3. collapse to bare digits (drops '+', spaces, '-', '(', ')', '.', etc.)
    local d = digits_only(s)
    local n = #d

    -- 4. '+' asserted: preserve the country code as-is (8..15 digits, E.164).
    if has_plus then
        if n >= 8 and n <= 15 then
            local first = d:sub(1, 1)
            if first >= "1" and first <= "9" then
                return "+" .. d
            end
        end
        return nil, "invalid +E.164: " .. s
    end

    -- 5. 11 digits, leading 1 + a valid NANP area-code digit (2..9): 1+NANP.
    if n == 11 and d:sub(1, 1) == "1" then
        local second = d:sub(2, 2)
        if second >= "2" and second <= "9" then
            return "+" .. d
        end
    end

    -- 6. bare 10 digits with a valid NANP area-code digit (2..9): default +1.
    --    This is the ONLY branch that ADDS a +1 country code.
    if n == 10 then
        local first = d:sub(1, 1)
        if first >= "2" and first <= "9" then
            return "+1" .. d
        end
    end

    -- 7. anything else is not a routable number under this spec.
    return nil, "unnormalizable number: " .. s
end

-- to_10digit(raw) -> the LAST 10 digits of the number (or nil for empty input).
-- Used ONLY for the outbound From / caller-ID that Bandwidth authenticates
-- against (the platform-owned DID). This intentionally strips any country code
-- and is NOT the canonical routing form — do not use it as a DID lookup key.
--
-- Behavior preserved from the pre-consolidation copies in inbound_router.lua /
-- trunk_outbound.lua / api_outbound.lua:
--   * empty / nil                       -> returned unchanged (nil or "")
--   * exactly 11 digits starting with 1 -> drop the leading 1 (NANP)
--   * exactly 10 digits                 -> as-is
--   * everything else                   -> the bare digit string (fallback)
-- Note: for a full +E.164 with >11 digits (e.g. +447911123456 -> "447911123456")
-- this returns the whole digit run, exactly as the old helpers did.
function M.to_10digit(raw)
    if raw == nil or raw == "" then
        return raw
    end
    if type(raw) ~= "string" then
        raw = tostring(raw)
    end
    local d = digits_only(raw)
    if #d == 11 and d:sub(1, 1) == "1" then
        return d:sub(2)
    elseif #d == 10 then
        return d
    end
    return d
end

return M
