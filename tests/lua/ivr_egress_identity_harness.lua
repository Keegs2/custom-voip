-- RCF egress BYTE-IDENTITY harness for the Visual IVR extraction
-- (docs/IVR_INTERFACES.md §0 P2, plan §7.3 "proven byte-identical for RCF by
-- a harness over the existing scenarios").
--
-- WHAT IS COMPARED. Every scenario runs twice under tests/lua/ivr_sandbox.lua:
--   BASELINE  the pre-extraction router: BASELINE_REF=<commit> (git show
--             <commit>:docker/freeswitch/scripts/inbound_router.lua — c6aa829
--             = RCF-V1 + the no-redial fix, the router this extraction must
--             leave RCF identical to; cd69af1 before that fix) or
--             BASELINE_ROUTER=<file>. OPT-IN: with neither set the harness
--             prints SKIPPED and exits 0. It is a one-off proof for a refactor
--             of the router, not a standing regression test — once the router
--             changes on purpose it no longer matches any old baseline, and
--             CI's shallow checkout has no history to extract one from.
--   NEW       docker/freeswitch/scripts/inbound_router.lua
-- and the FULL ordered event log must be identical: every setVariable (name +
-- value, incl. sofia_session_timeout, CID/Diversion/PAI/RPID/STIR vars and the
-- on-net CDR set), every session:execute (bridge dial strings WITH the [cdr_*]
-- B-leg block, export, limit, playback, lua), answer, hangup cause, every
-- consoleLog line (level + text), every freeswitch.API / global-variable call
-- and every fake-db call except the one the new router adds (the last STEP-1
-- arm, db:lookup_ivr_did, which only runs for a DID every other arm missed —
-- i.e. the 404 scenarios — and is checked separately: it sets nothing).
-- The NEW router runs each scenario with IVR_ENABLED unset, "false" AND
-- "true": RCF / trunk / voicemail / API calls never consult the IVR gate.
--
-- Scenarios: every scenario of tests/lua/onnet_router_harness.lua (incl. the
-- [13] traffic-class cases) plus egress edge cases the IVR transfer reuses:
-- From pass-through on, BRIDGE_PROGRESS_TIMEOUT, max_channels limit (ok and
-- over), TEST_MODE, all SBCs down, caller hangs up mid-failover, hop limit,
-- resolve_destination raising, db_client missing, trunk without endpoints,
-- direct / on-net / disabled voicemail.
--
-- Run: lua tests/lua/ivr_egress_identity_harness.lua

local function script_dir()
    local src = debug.getinfo(1, "S").source
    return (src:match("^@(.*)/[^/]*$")) or "."
end
local SB = dofile(script_dir() .. "/ivr_sandbox.lua")

local BASELINE = os.getenv("BASELINE_ROUTER")
local BASELINE_REF = os.getenv("BASELINE_REF")
local tmp_baseline
if (not BASELINE or BASELINE == "") and (not BASELINE_REF or BASELINE_REF == "") then
    print("SKIPPED: the RCF egress byte-identity proof is opt-in. Run it against the router")
    print("from before a refactor: BASELINE_REF=c6aa829 lua tests/lua/ivr_egress_identity_harness.lua")
    print("ALL IVR EGRESS IDENTITY ASSERTIONS SKIPPED (no baseline requested)")
    SB.cleanup()
    os.exit(0)
end
if not BASELINE or BASELINE == "" then
    assert(BASELINE_REF:match("^[%w._/-]+$"), "BASELINE_REF must be a plain git ref")
    tmp_baseline = SB.SCRATCH .. "/inbound_router.baseline.lua"
    local ok = os.execute(string.format(
        "git -C '%s' show '%s:docker/freeswitch/scripts/inbound_router.lua' > '%s' 2>/dev/null",
        SB.REPO, BASELINE_REF, tmp_baseline))
    if not ok then
        print("cannot extract the baseline router (git show " .. BASELINE_REF .. ":...); set BASELINE_ROUTER=")
        os.exit(2)
    end
    BASELINE = tmp_baseline
end

local passes, failures = 0, 0
local function check(name, cond, detail)
    if cond then
        passes = passes + 1
        print("  PASS  " .. name)
    else
        failures = failures + 1
        print("  FAIL  " .. name .. " -- " .. tostring(detail))
    end
end

-- ------------------------------------------------------------------
-- Scenarios
-- ------------------------------------------------------------------
local SPLIT_HDRS = {
    ["sip_h_X-SBC-ID"] = "east-sbc-1",
    ["sip_h_X-Inbound-Carrier"] = "sinch",
    ["sip_h_X-Inbound-PoP"] = "denver",
    ["sip_h_X-In-Identity"] = "eyJhbGciOiJFUzI1NiJ9.base;info=<https://x5u.example/c.pem>",
    ["sip_h_X-Verstat"] = "TN-Validation-Passed",
    ["sip_h_X-Verstat-Source"] = "self",
    ["sip_h_X-Inbound-Attest"] = "A",
    ["sip_h_X-Inbound-TC"] = "tc4",
}
local function rcf(did, fwd, extra)
    local s = { product_type = "rcf", customer_id = 10, forward_to = fwd,
                pass_caller_id = true, ring_timeout = 30, max_channels = 0, rcf_name = "Main Office" }
    for k, v in pairs(extra or {}) do s[k] = v end
    return s
end
local function nr(did, ptype, cust, extra)
    local r = { did = did, product_type = ptype, customer_id = tostring(cust),
                product_ref_id = "1", product_enabled = "t", customer_status = "active",
                ring_timeout = "30", max_channels = "0" }
    for k, v in pairs(extra or {}) do r[k] = v end
    return r
end

local TF = {
    bw_dal  = { carrier = "bandwidth", pop = "dallas",     term_ip = "67.231.2.12",    traffic_class = "ld" },
    bw_la   = { carrier = "bandwidth", pop = "la",         term_ip = "216.82.238.134", traffic_class = "ld" },
    atl_ld  = { carrier = "sinch",     pop = "atlanta-ld", term_ip = "206.146.98.26",  traffic_class = "ld" },
    den_tf  = { carrier = "sinch",     pop = "denver-tf",  term_ip = "206.146.100.26", traffic_class = "tollfree" },
    any_row = { carrier = "future",    pop = "any",        term_ip = "198.51.100.9",   traffic_class = "any" },
}

local S = {}
-- onnet_router_harness.lua scenarios (same data)
S.rcf_mask_to_trunk = { inbound_did = "+16170000001", sip_from_user = "+15085550123",
    step1 = rcf(nil, "+16170000002", { rcf_name = "Origin" }),
    oracle = {
        ["+16170000002"] = nr("+16170000002", "rcf", 11, { forward_to = "+16170000003", pass_caller_id = "f", product_name = "Masker" }),
        ["+16170000003"] = nr("+16170000003", "trunk", 12, { max_channels = "10", product_name = "PBX-A", trunk_id = "7" }),
    }, trunk_endpoints = { ["7"] = { "203.0.113.9" } }, bridge_results = { "SUCCESS" } }
S.rcf_transparent_to_trunk = { inbound_did = "+16170000001", sip_from_user = "+15085550123",
    step1 = rcf(nil, "+16170000002", { rcf_name = "Origin" }),
    oracle = {
        ["+16170000002"] = nr("+16170000002", "rcf", 11, { forward_to = "+16170000003", pass_caller_id = "t", product_name = "Passer" }),
        ["+16170000003"] = nr("+16170000003", "trunk", 12, { max_channels = "10", product_name = "PBX-A", trunk_id = "7" }),
    }, trunk_endpoints = { ["7"] = { "203.0.113.9" } }, bridge_results = { "NO_ANSWER" } }
S.direct_trunk = { inbound_did = "+15550002222", sip_from_user = "+14045550199",
    step1 = { product_type = "trunk", customer_id = 30, trunk_id = "5" },
    trunk_endpoints = { ["5"] = { "198.51.100.7" } }, bridge_results = { "SUCCESS" } }
S.rcf_to_api = { inbound_did = "+16170000010", sip_from_user = "+15085550777",
    step1 = rcf(nil, "+15550001111", { rcf_name = "Origin" }),
    oracle = { ["+15550001111"] = nr("+15550001111", "api", 20, { voice_url = "https://app.example.com/voice",
        fallback_url = "https://app.example.com/fallback", ring_timeout = nil, max_channels = nil }) } }
S.direct_api = { inbound_did = "+15550003333", sip_from_user = "+14045550155",
    step1 = { product_type = "api", customer_id = 21, voice_url = "https://app.example.com/voice2",
              fallback_url = "https://app.example.com/fallback2" } }
S.rcf_offnet_legacy_allfail = { inbound_did = "+16170000020", sip_from_user = "+15085550101",
    extra_vars = SPLIT_HDRS, step1 = rcf(nil, "+17745550100"),
    bridge_results = { "NORMAL_TEMPORARY_FAILURE", "NORMAL_TEMPORARY_FAILURE",
                       "NORMAL_TEMPORARY_FAILURE", "NORMAL_TEMPORARY_FAILURE" } }
S.rcf_offnet_table_skip = { inbound_did = "+16170000021", sip_from_user = "+15085550102",
    extra_vars = SPLIT_HDRS, step1 = rcf(nil, "+17745550101", { pass_caller_id = false, ring_timeout = 25, rcf_name = "Masked Line" }),
    term_trunks = { TF.bw_dal, TF.bw_la }, sbc_down = { ["10.0.0.2"] = true }, bridge_results = { "NO_ANSWER", "SUCCESS" } }
S.rcf_chain_offnet = { inbound_did = "+16170000030", sip_from_user = "+15085550103",
    extra_vars = SPLIT_HDRS, step1 = rcf(nil, "+16170000031", { rcf_name = "Origin" }),
    oracle = { ["+16170000031"] = nr("+16170000031", "rcf", 11, { forward_to = "+17745550102", pass_caller_id = "f",
        ring_timeout = "20", product_name = "Terminal RCF" }) }, bridge_results = { "SUCCESS" } }
S.rcf_local_ext = { inbound_did = "+16170000040", sip_from_user = "+15085550104",
    extra_vars = SPLIT_HDRS, step1 = rcf(nil, "1001"), bridge_results = { "SUCCESS" } }
S.rcf_disabled_terminal = { inbound_did = "+16170000050", sip_from_user = "+15085550105",
    extra_vars = SPLIT_HDRS, step1 = rcf(nil, "+16170000051"),
    oracle = { ["+16170000051"] = nr("+16170000051", "rcf", 12, { product_enabled = "f", forward_to = "+17745550103" }) } }
S.rcf_loop = { inbound_did = "+16170000060", sip_from_user = "+15085550106",
    extra_vars = SPLIT_HDRS, step1 = rcf(nil, "+16170000061"),
    oracle = {
        ["+16170000061"] = nr("+16170000061", "rcf", 10, { forward_to = "+16170000060", pass_caller_id = "t" }),
        ["+16170000060"] = nr("+16170000060", "rcf", 10, { forward_to = "+16170000061", pass_caller_id = "t" }),
    } }
S.rcf_offnet_unsafe = { inbound_did = "+16170000070", sip_from_user = "+15085550107", uuid = "bad,uuid]x",
    extra_vars = { ["sip_h_X-SBC-ID"] = "east-sbc-2", ["sip_h_X-Inbound-Carrier"] = "bandwidth", ["sip_h_X-Inbound-PoP"] = "den,ver" },
    step1 = rcf(nil, "+17745550104"), bridge_results = { "SUCCESS" } }
-- [13] traffic class (table-driven)
local function tf(n, fwd, trunks, results)
    return { inbound_did = string.format("+1617000%04d", 60 + n), sip_from_user = "+15085550160",
        extra_vars = SPLIT_HDRS, step1 = rcf(nil, fwd, { rcf_name = "TF Test" }),
        term_trunks = trunks, bridge_results = results }
end
S.tf_8yy_ld_only = tf(1, "+18885550100", { TF.bw_dal, TF.bw_la, TF.atl_ld, TF.any_row })
S.tf_8yy_tollfree = tf(2, "18005550100", { TF.bw_dal, TF.bw_la, TF.atl_ld, TF.any_row, TF.den_tf }, { "SUCCESS" })
S.tf_8yy_fail = tf(3, "+18445550100", { TF.bw_dal, TF.den_tf, TF.atl_ld }, { "NORMAL_TEMPORARY_FAILURE", "NORMAL_TEMPORARY_FAILURE" })
S.tf_ld_mixed = tf(4, "+17745550160", { TF.bw_dal, TF.den_tf, TF.atl_ld, TF.any_row },
    { "NORMAL_TEMPORARY_FAILURE", "NORMAL_TEMPORARY_FAILURE", "NORMAL_TEMPORARY_FAILURE",
      "NORMAL_TEMPORARY_FAILURE", "NORMAL_TEMPORARY_FAILURE", "SUCCESS" })
S.tf_ld_only_tf = tf(5, "+17745550161", { TF.den_tf }, { "SUCCESS" })
do
    local trunks = {}
    for i = 1, 5 do trunks[i] = { carrier = "c" .. i, pop = "p", term_ip = "198.51.100." .. i, traffic_class = "ld" } end
    S.tf_cap = tf(6, "+17745550162", trunks, {})
end
-- egress edge cases the IVR transfer reuses
S.rcf_passthrough_on = { inbound_did = "+16170000080", sip_from_user = "+15085550180",
    caller_name = "Jane Q. Caller", extra_vars = SPLIT_HDRS, env = { RCF_FROM_PASSTHROUGH = "on" },
    step1 = rcf(nil, "+17745550180"), term_trunks = { TF.bw_dal, TF.bw_la }, bridge_results = { "SUCCESS" } }
S.rcf_passthrough_intl = { inbound_did = "+16170000081", sip_from_user = "+447911123456",
    caller_name = "", extra_vars = SPLIT_HDRS, env = { RCF_FROM_PASSTHROUGH = "1" },
    step1 = rcf(nil, "+17745550181"), bridge_results = { "SUCCESS" } }
S.rcf_passthrough_anon = { inbound_did = "+16170000082", sip_from_user = "anonymous",
    extra_vars = SPLIT_HDRS, env = { RCF_FROM_PASSTHROUGH = "true" },
    step1 = rcf(nil, "+17745550182"), bridge_results = { "SUCCESS" } }
S.rcf_progress_timeout = { inbound_did = "+16170000083", sip_from_user = "+15085550183",
    extra_vars = SPLIT_HDRS, env = { BRIDGE_PROGRESS_TIMEOUT = "7" },
    step1 = rcf(nil, "+17745550183", { ring_timeout = 45 }), term_trunks = { TF.bw_dal },
    bridge_results = { "RECOVERY_ON_TIMER_EXPIRE", "SUCCESS" } }
S.rcf_limit_ok = { inbound_did = "+16170000084", sip_from_user = "+15085550184",
    extra_vars = SPLIT_HDRS, step1 = rcf(nil, "+17745550184", { max_channels = 3 }), bridge_results = { "SUCCESS" } }
S.rcf_limit_over = { inbound_did = "+16170000085", sip_from_user = "+15085550185",
    extra_vars = SPLIT_HDRS, step1 = rcf(nil, "+17745550185", { max_channels = 1 }), limit_over = { inbound = true } }
S.rcf_test_mode = { inbound_did = "+16170000086", sip_from_user = "+15085550186",
    env = { TEST_MODE = "true" }, step1 = rcf(nil, "+17745550186") }
S.rcf_all_sbc_down = { inbound_did = "+16170000087", sip_from_user = "+15085550187",
    extra_vars = SPLIT_HDRS, step1 = rcf(nil, "+17745550187"),
    sbc_down = { ["10.0.0.1"] = true, ["10.0.0.2"] = true } }
S.rcf_caller_hangs_up = { inbound_did = "+16170000088", sip_from_user = "+15085550188",
    extra_vars = SPLIT_HDRS, step1 = rcf(nil, "+17745550188"), term_trunks = { TF.bw_dal, TF.bw_la },
    bridge_results = { "NO_ANSWER" }, hangup_on_bridge = 2 }
S.rcf_noanswer_redial = { inbound_did = "+16170000089", sip_from_user = "+15085550189",
    extra_vars = SPLIT_HDRS, step1 = rcf(nil, "+17745550189"), term_trunks = { TF.bw_dal, TF.bw_la },
    bridge_results = { "NO_ANSWER", "USER_BUSY", "NO_ANSWER", "NO_ANSWER" } }
do
    local oracle = {}
    for i = 1, 6 do
        local d = string.format("+161700001%02d", i)
        local nxt = string.format("+161700001%02d", i + 1)
        oracle[d] = nr(d, "rcf", 10 + i, { forward_to = nxt, pass_caller_id = "t" })
    end
    S.rcf_hop_limit = { inbound_did = "+16170000100", sip_from_user = "+15085550190",
        extra_vars = SPLIT_HDRS, step1 = rcf(nil, "+16170000101"), oracle = oracle }
end
S.rcf_resolve_raises = { inbound_did = "+16170000110", sip_from_user = "+15085550191",
    extra_vars = SPLIT_HDRS, step1 = rcf(nil, "+17745550191"), resolve_raises = true, bridge_results = { "SUCCESS" } }
S.no_db = { inbound_did = "+16170000111", sip_from_user = "+15085550192", no_db = true }
S.unknown_did = { inbound_did = "+16170000112", sip_from_user = "+15085550193", step1 = {} }
S.unknown_did_no_ivr_fn = { inbound_did = "+16170000113", sip_from_user = "+15085550194", step1 = {}, db_without_ivr = true }
S.trunk_no_endpoints = { inbound_did = "+15550002223", sip_from_user = "+14045550198",
    step1 = { product_type = "trunk", customer_id = 30, trunk_id = "9" } }
S.direct_voicemail = { inbound_did = "+15550009999", sip_from_user = "+15085550195", fake_vm_box = true,
    step1 = { product_type = "voicemail", customer_id = 77, mailbox_id = 42 } }
S.direct_voicemail_disabled = { inbound_did = "+15550009998", sip_from_user = "+15085550196", fake_vm_box = true,
    step1 = { product_type = "voicemail", customer_id = 77, mailbox_id = 43, enabled = false } }
S.rcf_to_voicemail = { inbound_did = "+16170000120", sip_from_user = "+15085550197", fake_vm_box = true,
    extra_vars = SPLIT_HDRS, step1 = rcf(nil, "+15550009997", { pass_caller_id = false }),
    oracle = { ["+15550009997"] = nr("+15550009997", "voicemail", 77, { product_ref_id = "44", product_name = "Front desk",
        pass_caller_id = nil, ring_timeout = nil, max_channels = nil }) } }
S.rcf_to_trunk_noep = { inbound_did = "+16170000121", sip_from_user = "+15085550198",
    step1 = rcf(nil, "+15550002224"),
    oracle = { ["+15550002224"] = nr("+15550002224", "trunk", 31, { trunk_id = "8" }) } }

-- ------------------------------------------------------------------
-- Comparison
-- ------------------------------------------------------------------
local function with_env(sc, extra)
    local c = {}
    for k, v in pairs(sc) do c[k] = v end
    local e = {}
    for k, v in pairs(sc.env or {}) do e[k] = v end
    for k, v in pairs(extra or {}) do e[k] = v end
    c.env = e
    return c
end

-- The new router's only extra observable on non-IVR calls: the IVR STEP-1
-- arm's db call (runs only after every other arm missed).
local function normalized(cap)
    local out, ivr_calls = {}, 0
    for _, e in ipairs(cap.events) do
        if e:match("^db:lookup_ivr_did:") then
            ivr_calls = ivr_calls + 1
        else
            out[#out + 1] = e
        end
    end
    return table.concat(out, "\n"), ivr_calls
end

local function first_diff(a, b)
    local la, lb = {}, {}
    for l in (a .. "\n"):gmatch("(.-)\n") do la[#la + 1] = l end
    for l in (b .. "\n"):gmatch("(.-)\n") do lb[#lb + 1] = l end
    for i = 1, math.max(#la, #lb) do
        if la[i] ~= lb[i] then
            return string.format("event %d\n   baseline: %s\n   new:      %s", i, tostring(la[i]), tostring(lb[i]))
        end
    end
    return "?"
end

print("== ivr_egress_identity_harness (baseline " .. BASELINE .. ") ==")
local names = {}
for n in pairs(S) do names[#names + 1] = n end
table.sort(names)

local variants = {
    { label = "IVR_ENABLED unset", env = {} },
    { label = "IVR_ENABLED=false", env = { IVR_ENABLED = "false" } },
    { label = "IVR_ENABLED=true",  env = { IVR_ENABLED = "true" } },
}
local api_variants = { {}, { API_CALLING_ENABLED = "true" } }

local compared, events_compared = 0, 0
for _, name in ipairs(names) do
    for _, av in ipairs(api_variants) do
        local base_sc = with_env(S[name], av)
        local base = SB.run(base_sc, BASELINE)
        local base_log = normalized(base)
        check(string.format("%s%s: baseline ran", name, av.API_CALLING_ENABLED and " (api on)" or ""),
            base.script_ok, base.script_err)
        for _, v in ipairs(variants) do
            local cap = SB.run(with_env(base_sc, v.env), SB.ROUTER)
            local new_log, ivr_calls = normalized(cap)
            local label = string.format("%s%s [%s]", name, av.API_CALLING_ENABLED and " (api on)" or "", v.label)
            check(label .. ": byte-identical event log (" .. #cap.events .. " events)",
                cap.script_ok and new_log == base_log,
                cap.script_ok and first_diff(base_log, new_log) or cap.script_err)
            local expect_ivr = (S[name].step1 and next(S[name].step1) == nil and not S[name].db_without_ivr) and 1 or 0
            check(label .. ": lookup_ivr_did ran " .. expect_ivr .. "x (only when every other arm missed)",
                ivr_calls == expect_ivr, ivr_calls)
            compared = compared + 1
            events_compared = events_compared + #cap.events
        end
    end
end

-- The identity runs above must have exercised the egress features they claim.
local function any_event(cap, pat)
    for _, e in ipairs(cap.events) do if e:find(pat) then return true end end
    return false
end
do
    print("[coverage] the compared scenarios really exercise the shared egress")
    local c = SB.run(S.rcf_offnet_table_skip, SB.ROUTER)
    check("table-driven X-Carrier-IP + [cdr_*] block + progress_timeout",
        any_event(c, "sip_h_X%-Carrier%-IP=67%.231%.2%.12") and any_event(c, "%[cdr_leg=B")
        and any_event(c, "progress_timeout=10,"), "")
    c = SB.run(S.rcf_offnet_legacy_allfail, SB.ROUTER)
    check("legacy 4-attempt loop + 503", #c.bridges == 4 and c.hangups[1] == "NORMAL_TEMPORARY_FAILURE", #c.bridges)
    check("STIR div + X-In-Identity echo + stir facts",
        c.setvars["sip_h_X-Attestation"] == "div" and c.setvars["stir_inbound_signed"] == "1", "")
    c = SB.run(S.rcf_limit_over, SB.ROUTER)
    check("limit hash inbound ... !USER_BUSY executed", any_event(c, "exec:limit:hash inbound %+16170000085 1 !USER_BUSY"), "")
    c = SB.run(S.rcf_passthrough_on, SB.ROUTER)
    check("From pass-through export", any_event(c, "exec:export:origination_caller_id_number=5085550180"), "")
    c = SB.run(S.rcf_noanswer_redial, SB.ROUTER)
    -- fix/rcf-no-redial-after-noanswer-busy: a far-end NO_ANSWER (ring 30 s >
    -- the 10 s PDD bound) ends the sweep for RCF too, and the cause goes back.
    check("RCF stops after a far-end NO_ANSWER (no re-dial) and returns it, not 503",
        #c.bridges == 1 and c.hangups[1] == "NO_ANSWER", #c.bridges .. " " .. tostring(c.hangups[1]))
end

do
    print("[guard] caller display names cannot inject ${...} into the From export (pass-through on)")
    -- sanitize_display_name strips '$', '{', '}' (and the SIP structural set)
    local sc = with_env(S.rcf_passthrough_on, {})
    sc.caller_name = "${system(touch /tmp/pwn)} $${hostname} Bob"
    local c = SB.run(sc, SB.ROUTER)
    local leaked = {}
    for _, e in ipairs(c.execs) do
        if tostring(e.data):find("$", 1, true) then leaked[#leaked + 1] = e.app .. ":" .. e.data end
    end
    check("no '$' in any execute argument", #leaked == 0, table.concat(leaked, " | "))
    for _, e in ipairs(c.execs) do
        if e.app == "export" and tostring(e.data):find("[{}]") then leaked[#leaked + 1] = e.data end
    end
    check("no '{' / '}' in the exported name either", #leaked == 0, table.concat(leaked, " | "))
    check("the export still carries the sanitized name",
        any_event(c, "exec:export:origination_caller_id_name=system%(touch /tmp/pwn%) hostname Bob"), "")
end

print("")
print(string.format("%d router runs compared (%d events), %d passed, %d failed",
    compared, events_compared, passes, failures))
SB.cleanup()
if failures == 0 then
    print("ALL IVR EGRESS IDENTITY ASSERTIONS PASSED")
    os.exit(0)
end
os.exit(1)
