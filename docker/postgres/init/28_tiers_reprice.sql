-- ============================================================================
-- 28_tiers_reprice.sql — v1 pricing reprice + bundled call paths on trunk tiers
-- ----------------------------------------------------------------------------
-- Idempotent, transactional, GUARDED. Hand-applied to the LIVE prod primary
-- (init scripts only run on first initdb; this file also lives in 07_cps_tiers.sql
-- so a fresh initdb matches). Safe to re-run and safe against a partially-applied
-- state (all writes use ON CONFLICT (name) DO UPDATE).
--
-- What changes:
--   * cps_tiers gains a `call_paths` column — bundled concurrent call paths that
--     ship WITH a trunk tier (NULL for api tiers). Trunk tiers remain UPSELLABLE:
--     customers can still buy extra paths via call_path_packages on top of the
--     bundle (sip_trunks.call_path_package_id). call_path_packages is untouched.
--   * SIP Trunking (tier_type='trunk') becomes bundled "standard tiers":
--       trunk_standard    1 CPS,  20 paths, $25.00/mo,  $0.0000/call
--       trunk_growth      2 CPS,  50 paths, $50.00/mo,  $0.0000/call
--       trunk_business    5 CPS, 100 paths, $110.00/mo, $0.0000/call
--       trunk_enterprise 10 CPS, 250 paths, $240.00/mo, $0.0000/call
--   * API Calling (tier_type='api') repriced (premium product):
--       api_basic    "Starter"  5 CPS,  $99.00/mo, $0.0100/call
--       api_standard "Growth"  10 CPS, $249.00/mo, $0.0080/call
--       api_premium  "Scale"   25 CPS, $599.00/mo, $0.0050/call
--
-- Internal `name`s are STABLE — the auto-tier-assign trigger (set_default_cps_tiers)
-- references 'trunk_standard' and 'api_basic', and existing customer assignments
-- reference these names via FK. This reprice UPDATEs in place; it never renames or
-- deletes a tier, so all existing customers.trunk_tier_id / api_tier_id stay valid.
-- Does NOT touch CDRs / rate_cdr() / the rates deck.
-- ============================================================================

BEGIN;

-- 1) Bundled call-path capacity column (NULL for api tiers).
ALTER TABLE cps_tiers ADD COLUMN IF NOT EXISTS call_paths INTEGER;

COMMENT ON COLUMN cps_tiers.call_paths IS
    'Bundled concurrent call paths included with a trunk tier (NULL for api tiers). '
    'Still upsellable via call_path_packages (sip_trunks.call_path_package_id).';

-- 2) SIP Trunking — bundled standard tiers.
--    UPSERT on the unique `name` so re-runs and partially-applied states converge.
INSERT INTO cps_tiers
    (name, tier_type, cps_limit, call_paths, monthly_fee, per_call_fee, description, sort_order, features)
VALUES
    (
        'trunk_standard', 'trunk', 1, 20, 25.00, 0.0000,
        'Standard SIP trunk — 1 CPS, 20 concurrent call paths included. Buy extra call paths anytime.',
        1,
        '{"cps": 1, "call_paths": 20, "support": "email", "features": ["basic_routing", "failover", "cdr_access"]}'
    ),
    (
        'trunk_growth', 'trunk', 2, 50, 50.00, 0.0000,
        'Growth SIP trunk — 2 CPS, 50 concurrent call paths included. Buy extra call paths anytime.',
        2,
        '{"cps": 2, "call_paths": 50, "support": "email", "features": ["basic_routing", "failover", "cdr_access"]}'
    ),
    (
        'trunk_business', 'trunk', 5, 100, 110.00, 0.0000,
        'Business SIP trunk — 5 CPS, 100 concurrent call paths included. Buy extra call paths anytime.',
        3,
        '{"cps": 5, "call_paths": 100, "support": "priority", "features": ["basic_routing", "failover", "cdr_access"]}'
    ),
    (
        'trunk_enterprise', 'trunk', 10, 250, 240.00, 0.0000,
        'Enterprise SIP trunk — 10 CPS, 250 concurrent call paths included. Buy extra call paths anytime.',
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

-- 3) API Calling — reprice (premium product). Names STABLE; call_paths stays NULL.
INSERT INTO cps_tiers
    (name, tier_type, cps_limit, call_paths, monthly_fee, per_call_fee, description, sort_order, features)
VALUES
    (
        'api_basic', 'api', 5, NULL, 99.00, 0.0100,
        'Starter — 5 CPS. Programmable voice for launching applications.',
        10,
        '{"cps": 5, "display_name": "Starter", "support": "email", "features": ["webhooks", "call_control", "basic_analytics"]}'
    ),
    (
        'api_standard', 'api', 10, NULL, 249.00, 0.0080,
        'Growth — 10 CPS. Scaling programmable voice for growing businesses.',
        20,
        '{"cps": 10, "display_name": "Growth", "support": "priority", "features": ["webhooks", "call_control", "advanced_analytics", "recordings", "conference"]}'
    ),
    (
        'api_premium', 'api', 25, NULL, 599.00, 0.0050,
        'Scale — 25 CPS. High-volume programmable voice with premium SLA.',
        30,
        '{"cps": 25, "display_name": "Scale", "support": "dedicated", "features": ["webhooks", "call_control", "advanced_analytics", "recordings", "conference", "transcription", "custom_tts", "sla_guarantee"]}'
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
