-- ============================================================================
-- 29_tiers_cps_reprice.sql — CPS-as-exponential-premium reprice (supersedes 28)
-- ----------------------------------------------------------------------------
-- Idempotent, transactional, GUARDED. Hand-applied to the LIVE prod primary
-- (init scripts only run on first initdb; these same final values also live in
-- 07_cps_tiers.sql so a fresh initdb matches). Safe to re-run and safe against a
-- partially-applied state (all writes use ON CONFLICT (name) DO UPDATE, so a
-- re-run converges any prior state — including 28's numbers).
--
-- Why: CPS (call-setup rate) is repriced as an EXPONENTIALLY-priced premium lever.
-- Industry practice (Twilio / Bandwidth) charges exponentially for higher CPS and
-- gates >~10 CPS to sales, so the top of each self-serve product caps at 10 CPS and
-- the MRC climbs steeply with CPS. This supersedes the pricing set in
-- 28_tiers_reprice.sql (that file's numbers are now obsolete).
--
-- What changes (values ONLY — no schema change; call_paths column already exists
-- from 28 / 07_cps_tiers.sql, call_path_packages add-ons are untouched):
--   * SIP Trunking (tier_type='trunk') — bundled tiers, CPS + call paths climb together:
--       trunk_standard    1 CPS,  20 paths, $25.00/mo,  $0.0000/call
--       trunk_growth      3 CPS,  50 paths, $99.00/mo,  $0.0000/call
--       trunk_business    5 CPS, 100 paths, $249.00/mo, $0.0000/call
--       trunk_enterprise 10 CPS, 250 paths, $749.00/mo, $0.0000/call
--   * API Calling (tier_type='api') — premium programmable voice, call_paths NULL:
--       api_basic    "Starter"  3 CPS,  $199.00/mo, $0.0100/call
--       api_standard "Growth"   6 CPS,  $499.00/mo, $0.0080/call
--       api_premium  "Scale"   10 CPS, $1299.00/mo, $0.0050/call
--
-- Internal `name`s are STABLE — the auto-tier-assign trigger (set_default_cps_tiers)
-- references 'trunk_standard' and 'api_basic', and existing customer assignments
-- reference these names via FK. This reprice UPDATEs in place; it never renames or
-- deletes a tier, so all existing customers.trunk_tier_id / api_tier_id stay valid.
-- Customer-facing api display names stay Starter / Growth / Scale.
-- Does NOT touch RCF ($5/line), CDRs / rate_cdr() / the rates deck, the tiers.py
-- router, or the billing estimate (it reads cps_tiers.monthly_fee, so it auto-updates).
-- ============================================================================

BEGIN;

-- 1) SIP Trunking — bundled tiers (CPS is the exponential premium lever).
--    UPSERT on the unique `name` so re-runs and partially-applied states converge.
INSERT INTO cps_tiers
    (name, tier_type, cps_limit, call_paths, monthly_fee, per_call_fee, description, sort_order, features)
VALUES
    (
        'trunk_standard', 'trunk', 1, 20, 25.00, 0.0000,
        'Standard SIP trunk — 1 CPS, 20 call paths included. Buy extra call paths anytime.',
        1,
        '{"cps": 1, "call_paths": 20, "support": "email", "features": ["basic_routing", "failover", "cdr_access"]}'
    ),
    (
        'trunk_growth', 'trunk', 3, 50, 99.00, 0.0000,
        'Growth SIP trunk — 3 CPS, 50 call paths included. Buy extra call paths anytime.',
        2,
        '{"cps": 3, "call_paths": 50, "support": "email", "features": ["basic_routing", "failover", "cdr_access"]}'
    ),
    (
        'trunk_business', 'trunk', 5, 100, 249.00, 0.0000,
        'Business SIP trunk — 5 CPS, 100 call paths included. Buy extra call paths anytime.',
        3,
        '{"cps": 5, "call_paths": 100, "support": "priority", "features": ["basic_routing", "failover", "cdr_access"]}'
    ),
    (
        'trunk_enterprise', 'trunk', 10, 250, 749.00, 0.0000,
        'Enterprise SIP trunk — 10 CPS, 250 call paths included. Buy extra call paths anytime.',
        4,
        '{"cps": 10, "call_paths": 250, "support": "dedicated", "features": ["basic_routing", "failover", "cdr_access", "sla_guarantee"]}'
    )
ON CONFLICT (name) DO UPDATE SET
    tier_type    = EXCLUDED.tier_type,
    cps_limit    = EXCLUDED.cps_limit,
    call_paths   = EXCLUDED.call_paths,
    monthly_fee  = EXCLUDED.monthly_fee,
    per_call_fee = EXCLUDED.per_call_fee,
    description  = EXCLUDED.description,
    sort_order   = EXCLUDED.sort_order,
    features     = EXCLUDED.features,
    is_active    = true,
    updated_at   = NOW();

-- 2) API Calling — premium reprice. Names STABLE; call_paths stays NULL.
--    Display names Starter / Growth / Scale preserved in features.display_name.
INSERT INTO cps_tiers
    (name, tier_type, cps_limit, call_paths, monthly_fee, per_call_fee, description, sort_order, features)
VALUES
    (
        'api_basic', 'api', 3, NULL, 199.00, 0.0100,
        'Starter — 3 CPS premium programmable voice for launching applications.',
        10,
        '{"cps": 3, "display_name": "Starter", "support": "email", "features": ["webhooks", "call_control", "basic_analytics"]}'
    ),
    (
        'api_standard', 'api', 6, NULL, 499.00, 0.0080,
        'Growth — 6 CPS premium programmable voice for scaling businesses.',
        20,
        '{"cps": 6, "display_name": "Growth", "support": "priority", "features": ["webhooks", "call_control", "advanced_analytics", "recordings", "conference"]}'
    ),
    (
        'api_premium', 'api', 10, NULL, 1299.00, 0.0050,
        'Scale — 10 CPS high-volume premium programmable voice with SLA.',
        30,
        '{"cps": 10, "display_name": "Scale", "support": "dedicated", "features": ["webhooks", "call_control", "advanced_analytics", "recordings", "conference", "transcription", "custom_tts", "sla_guarantee"]}'
    )
ON CONFLICT (name) DO UPDATE SET
    tier_type    = EXCLUDED.tier_type,
    cps_limit    = EXCLUDED.cps_limit,
    call_paths   = EXCLUDED.call_paths,
    monthly_fee  = EXCLUDED.monthly_fee,
    per_call_fee = EXCLUDED.per_call_fee,
    description  = EXCLUDED.description,
    sort_order   = EXCLUDED.sort_order,
    features     = EXCLUDED.features,
    is_active    = true,
    updated_at   = NOW();

COMMIT;
