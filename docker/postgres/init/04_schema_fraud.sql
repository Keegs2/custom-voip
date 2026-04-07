-- Fraud Detection Tables - Optimized for fast lookups during call setup

CREATE TABLE fraud_rules (
    id SERIAL PRIMARY KEY,
    rule_name VARCHAR(100) NOT NULL,
    rule_type VARCHAR(50) NOT NULL CHECK (rule_type IN ('destination', 'velocity', 'pattern', 'time')),
    condition JSONB NOT NULL,
    action VARCHAR(20) NOT NULL CHECK (action IN ('block', 'alert', 'limit', 'review')),
    priority INT DEFAULT 100,  -- Lower = higher priority
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_fraud_rules_type ON fraud_rules(rule_type) WHERE enabled = true;
CREATE INDEX idx_fraud_rules_priority ON fraud_rules(priority) WHERE enabled = true;

-- High-risk prefixes - critical for IRSF prevention
-- Using text pattern matching for prefix lookups
CREATE TABLE high_risk_prefixes (
    id SERIAL PRIMARY KEY,
    prefix VARCHAR(20) NOT NULL,
    country VARCHAR(100),
    risk_level VARCHAR(20) NOT NULL CHECK (risk_level IN ('elevated', 'high', 'critical', 'blocked')),
    notes TEXT,
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT prefix_unique UNIQUE (prefix)
);

-- Text pattern index for efficient prefix matching
CREATE INDEX idx_hrp_prefix ON high_risk_prefixes(prefix text_pattern_ops);
CREATE INDEX idx_hrp_risk ON high_risk_prefixes(risk_level) WHERE enabled = true;

-- Customer whitelist for high-risk destinations
CREATE TABLE customer_destination_whitelist (
    id SERIAL PRIMARY KEY,
    customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    prefix VARCHAR(20) NOT NULL,
    notes TEXT,
    approved_by VARCHAR(100),
    approved_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT customer_prefix_unique UNIQUE (customer_id, prefix)
);

CREATE INDEX idx_whitelist_customer_prefix ON customer_destination_whitelist(customer_id, prefix);

-- Rate tables for billing
CREATE TABLE rate_tables (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    is_default BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE rates (
    id SERIAL PRIMARY KEY,
    rate_table_id INT NOT NULL REFERENCES rate_tables(id) ON DELETE CASCADE,
    prefix VARCHAR(20) NOT NULL,
    description VARCHAR(100),
    rate_per_min DECIMAL(10,6) NOT NULL,
    cost_per_min DECIMAL(10,6) NOT NULL DEFAULT 0,
    connection_fee DECIMAL(10,6) DEFAULT 0,
    min_duration INT DEFAULT 0,  -- Minimum billable seconds
    increment INT DEFAULT 6,      -- Billing increment (6-second billing)
    effective_date TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT rate_prefix_unique UNIQUE (rate_table_id, prefix)
);

-- Critical: Fast rate lookup by prefix
CREATE INDEX idx_rates_prefix ON rates(prefix text_pattern_ops);
CREATE INDEX idx_rates_table_prefix ON rates(rate_table_id, prefix text_pattern_ops);

-- Customer rate table assignments
CREATE TABLE customer_rate_assignments (
    customer_id INT PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
    inbound_rate_table_id INT REFERENCES rate_tables(id),
    outbound_rate_table_id INT REFERENCES rate_tables(id)
);

-- Seed default high-risk prefixes (common IRSF destinations)
INSERT INTO high_risk_prefixes (prefix, country, risk_level, notes) VALUES
('1900', 'USA Premium', 'blocked', 'US premium rate'),
('1976', 'USA Premium', 'blocked', 'US premium rate'),
('53', 'Cuba', 'critical', 'High fraud risk'),
('225', 'Cote d''Ivoire', 'high', 'IRSF target'),
('231', 'Liberia', 'high', 'IRSF target'),
('232', 'Sierra Leone', 'high', 'IRSF target'),
('252', 'Somalia', 'critical', 'High fraud risk'),
('257', 'Burundi', 'high', 'IRSF target'),
('260', 'Zambia', 'elevated', 'Monitor'),
('267', 'Botswana', 'elevated', 'Monitor'),
('284', 'British Virgin Islands', 'high', 'Premium rate'),
('375', 'Belarus', 'high', 'IRSF target'),
('381', 'Serbia', 'elevated', 'Monitor'),
('670', 'East Timor', 'high', 'IRSF target'),
('675', 'Papua New Guinea', 'high', 'IRSF target'),
('678', 'Vanuatu', 'high', 'IRSF target'),
('679', 'Fiji', 'elevated', 'Monitor'),
('685', 'Samoa', 'high', 'IRSF target'),
('686', 'Kiribati', 'high', 'IRSF target'),
('687', 'New Caledonia', 'elevated', 'Monitor'),
('691', 'Micronesia', 'high', 'IRSF target'),
('880', 'Bangladesh', 'elevated', 'Monitor');

-- Grant permissions
GRANT SELECT ON fraud_rules, high_risk_prefixes, customer_destination_whitelist, rates, rate_tables, customer_rate_assignments TO freeswitch;
GRANT ALL ON fraud_rules, high_risk_prefixes, customer_destination_whitelist, rates, rate_tables, customer_rate_assignments TO api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO api;
