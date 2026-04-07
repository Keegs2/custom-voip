-- CPS (Calls Per Second) Tier System
-- Implements tiered rate limiting for SIP Trunks and API Calling

-- CPS tier definitions table
CREATE TABLE cps_tiers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    tier_type VARCHAR(20) NOT NULL CHECK (tier_type IN ('trunk', 'api')),
    cps_limit INTEGER NOT NULL CHECK (cps_limit > 0),
    monthly_fee DECIMAL(10,2) NOT NULL DEFAULT 0,
    per_call_fee DECIMAL(10,4) NOT NULL DEFAULT 0,
    description TEXT,
    features JSONB DEFAULT '{}',  -- Additional tier features as JSON
    is_active BOOLEAN DEFAULT true,
    sort_order INTEGER DEFAULT 0,  -- For UI display ordering
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for tier lookups
CREATE INDEX idx_cps_tiers_type ON cps_tiers(tier_type) WHERE is_active = true;
CREATE INDEX idx_cps_tiers_name ON cps_tiers USING hash (name);

-- Add CPS tier columns to customers table
ALTER TABLE customers ADD COLUMN IF NOT EXISTS trunk_tier_id INTEGER REFERENCES cps_tiers(id);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS api_tier_id INTEGER REFERENCES cps_tiers(id);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS cps_tier_updated_at TIMESTAMPTZ;

-- Index for finding customers by tier (useful for billing/reports)
CREATE INDEX idx_customers_trunk_tier ON customers(trunk_tier_id) WHERE trunk_tier_id IS NOT NULL;
CREATE INDEX idx_customers_api_tier ON customers(api_tier_id) WHERE api_tier_id IS NOT NULL;

-- CPS usage tracking table (for billing and analytics)
CREATE TABLE cps_usage_log (
    id BIGSERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    tier_id INTEGER REFERENCES cps_tiers(id),
    usage_type VARCHAR(20) NOT NULL CHECK (usage_type IN ('trunk', 'api')),
    calls_count INTEGER NOT NULL DEFAULT 0,
    peak_cps DECIMAL(10,2) DEFAULT 0,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Partition by month for efficient querying and retention
CREATE INDEX idx_cps_usage_customer ON cps_usage_log(customer_id, period_start);
CREATE INDEX idx_cps_usage_period ON cps_usage_log(period_start, period_end);

-- CPS tier upgrade/downgrade history
CREATE TABLE cps_tier_changes (
    id BIGSERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    tier_type VARCHAR(20) NOT NULL CHECK (tier_type IN ('trunk', 'api')),
    old_tier_id INTEGER REFERENCES cps_tiers(id),
    new_tier_id INTEGER NOT NULL REFERENCES cps_tiers(id),
    change_reason VARCHAR(255),
    changed_by VARCHAR(100),  -- User or 'system' for auto-changes
    effective_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tier_changes_customer ON cps_tier_changes(customer_id, created_at DESC);

-- Insert default SIP Trunk tiers
INSERT INTO cps_tiers (name, tier_type, cps_limit, monthly_fee, per_call_fee, description, sort_order, features) VALUES
(
    'trunk_free',
    'trunk',
    5,
    0.00,
    0.0000,
    'Free SIP trunk tier - 5 CPS included with trunk',
    1,
    '{"included": true, "support": "community", "features": ["basic_routing", "failover"]}'
),
(
    'trunk_paid',
    'trunk',
    10,
    49.99,
    0.0000,
    'Paid SIP trunk tier - up to 10 CPS',
    2,
    '{"included": false, "support": "email", "features": ["basic_routing", "failover", "analytics", "priority_routing"]}'
);

-- Insert default API Calling tiers
INSERT INTO cps_tiers (name, tier_type, cps_limit, monthly_fee, per_call_fee, description, sort_order, features) VALUES
(
    'api_starter',
    'api',
    25,
    99.00,
    0.0100,
    'API Starter - 25 CPS, ideal for small applications',
    10,
    '{"support": "email", "features": ["webhooks", "call_control", "basic_analytics", "recordings"]}'
),
(
    'api_professional',
    'api',
    50,
    299.00,
    0.0080,
    'API Professional - 50 CPS, for growing businesses',
    20,
    '{"support": "priority", "features": ["webhooks", "call_control", "advanced_analytics", "recordings", "conference", "transcription"]}'
),
(
    'api_enterprise',
    'api',
    100,
    799.00,
    0.0050,
    'API Enterprise - 100 CPS, for high-volume operations',
    30,
    '{"support": "dedicated", "features": ["webhooks", "call_control", "advanced_analytics", "recordings", "conference", "transcription", "custom_tts", "speech_recognition", "sla_guarantee"]}'
),
(
    'api_unlimited',
    'api',
    1000,
    0.00,
    0.0000,
    'API Unlimited - Custom pricing, negotiated rates',
    40,
    '{"support": "dedicated", "custom_pricing": true, "features": ["all_features", "custom_sla", "dedicated_infrastructure"]}'
);

-- Function to automatically set default tiers for new customers
CREATE OR REPLACE FUNCTION set_default_cps_tiers()
RETURNS TRIGGER AS $$
BEGIN
    -- Set free trunk tier if customer has trunk account type
    IF NEW.account_type IN ('trunk', 'hybrid') AND NEW.trunk_tier_id IS NULL THEN
        SELECT id INTO NEW.trunk_tier_id FROM cps_tiers WHERE name = 'trunk_free';
    END IF;

    -- Set starter API tier if customer has API account type
    IF NEW.account_type IN ('api', 'hybrid') AND NEW.api_tier_id IS NULL THEN
        SELECT id INTO NEW.api_tier_id FROM cps_tiers WHERE name = 'api_starter';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to set default tiers on customer insert
DROP TRIGGER IF EXISTS trg_set_default_cps_tiers ON customers;
CREATE TRIGGER trg_set_default_cps_tiers
    BEFORE INSERT ON customers
    FOR EACH ROW
    EXECUTE FUNCTION set_default_cps_tiers();

-- Function to log tier changes
CREATE OR REPLACE FUNCTION log_tier_change()
RETURNS TRIGGER AS $$
BEGIN
    -- Log trunk tier changes
    IF OLD.trunk_tier_id IS DISTINCT FROM NEW.trunk_tier_id THEN
        INSERT INTO cps_tier_changes (customer_id, tier_type, old_tier_id, new_tier_id, change_reason, changed_by)
        VALUES (NEW.id, 'trunk', OLD.trunk_tier_id, NEW.trunk_tier_id, 'Tier changed via API', 'system');
        NEW.cps_tier_updated_at = NOW();
    END IF;

    -- Log API tier changes
    IF OLD.api_tier_id IS DISTINCT FROM NEW.api_tier_id THEN
        INSERT INTO cps_tier_changes (customer_id, tier_type, old_tier_id, new_tier_id, change_reason, changed_by)
        VALUES (NEW.id, 'api', OLD.api_tier_id, NEW.api_tier_id, 'Tier changed via API', 'system');
        NEW.cps_tier_updated_at = NOW();
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to log tier changes on customer update
DROP TRIGGER IF EXISTS trg_log_tier_change ON customers;
CREATE TRIGGER trg_log_tier_change
    BEFORE UPDATE ON customers
    FOR EACH ROW
    WHEN (OLD.trunk_tier_id IS DISTINCT FROM NEW.trunk_tier_id OR OLD.api_tier_id IS DISTINCT FROM NEW.api_tier_id)
    EXECUTE FUNCTION log_tier_change();

-- View for easy customer tier lookup
CREATE OR REPLACE VIEW customer_tiers AS
SELECT
    c.id AS customer_id,
    c.name AS customer_name,
    c.account_type,
    tt.id AS trunk_tier_id,
    tt.name AS trunk_tier_name,
    tt.cps_limit AS trunk_cps_limit,
    tt.monthly_fee AS trunk_monthly_fee,
    at.id AS api_tier_id,
    at.name AS api_tier_name,
    at.cps_limit AS api_cps_limit,
    at.monthly_fee AS api_monthly_fee,
    at.per_call_fee AS api_per_call_fee,
    c.cps_tier_updated_at
FROM customers c
LEFT JOIN cps_tiers tt ON c.trunk_tier_id = tt.id
LEFT JOIN cps_tiers at ON c.api_tier_id = at.id;

-- Grant permissions
GRANT SELECT ON cps_tiers TO api, freeswitch;
GRANT SELECT ON customer_tiers TO api, freeswitch;
GRANT SELECT, INSERT ON cps_usage_log TO api;
GRANT SELECT, INSERT ON cps_tier_changes TO api;
GRANT USAGE, SELECT ON cps_usage_log_id_seq TO api;
GRANT USAGE, SELECT ON cps_tier_changes_id_seq TO api;
GRANT UPDATE (trunk_tier_id, api_tier_id, cps_tier_updated_at) ON customers TO api;
