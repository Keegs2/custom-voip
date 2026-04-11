-- Core tables with performance optimizations
-- Using appropriate data types to minimize storage and maximize cache efficiency

-- Customer lookup is on hot path - optimize heavily
CREATE TABLE customers (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    account_type VARCHAR(20) NOT NULL CHECK (account_type IN ('rcf', 'api', 'trunk', 'hybrid', 'ucaas')),
    balance DECIMAL(12,4) DEFAULT 0,
    credit_limit DECIMAL(12,4) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
    traffic_grade VARCHAR(10) DEFAULT 'standard' CHECK (traffic_grade IN ('premium', 'standard', 'economy')),
    fraud_score SMALLINT DEFAULT 0 CHECK (fraud_score BETWEEN 0 AND 100),
    daily_limit DECIMAL(12,4) DEFAULT 500,
    cpm_limit INT DEFAULT 60,  -- calls per minute limit
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast status checks during call setup
CREATE INDEX idx_customers_status ON customers(status) WHERE status = 'active';
CREATE INDEX idx_customers_id_status ON customers(id, status);

-- RCF Numbers - hot path lookup by DID
CREATE TABLE rcf_numbers (
    id SERIAL PRIMARY KEY,
    did VARCHAR(20) NOT NULL,
    name VARCHAR(100),
    customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    forward_to VARCHAR(20) NOT NULL,
    pass_caller_id BOOLEAN DEFAULT true,
    enabled BOOLEAN DEFAULT true,
    failover_to VARCHAR(20),  -- Optional failover destination
    ring_timeout INT DEFAULT 30,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT rcf_did_unique UNIQUE (did)
);

-- Critical: Hash index for O(1) DID lookup during call routing
CREATE INDEX idx_rcf_did_lookup ON rcf_numbers USING hash (did);
-- Composite for enabled check
CREATE INDEX idx_rcf_did_enabled ON rcf_numbers(did, enabled) WHERE enabled = true;
-- For cache invalidation queries
CREATE INDEX idx_rcf_customer ON rcf_numbers(customer_id);

-- SIP Trunks
CREATE TABLE sip_trunks (
    id SERIAL PRIMARY KEY,
    customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    trunk_name VARCHAR(100),
    max_channels INT NOT NULL CHECK (max_channels > 0),
    cps_limit INT DEFAULT 10 CHECK (cps_limit > 0),
    auth_type VARCHAR(20) DEFAULT 'ip' CHECK (auth_type IN ('ip', 'credential', 'both')),
    tech_prefix VARCHAR(10),  -- Optional tech prefix for routing
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_trunks_customer ON sip_trunks(customer_id);
CREATE INDEX idx_trunks_enabled ON sip_trunks(id, enabled) WHERE enabled = true;

-- Trunk IP Authentication - frequently queried
CREATE TABLE trunk_auth_ips (
    id SERIAL PRIMARY KEY,
    trunk_id INT NOT NULL REFERENCES sip_trunks(id) ON DELETE CASCADE,
    ip_address INET NOT NULL,
    description VARCHAR(100),
    CONSTRAINT trunk_ip_unique UNIQUE (trunk_id, ip_address)
);

-- Critical: Fast IP lookup for SIP authentication
CREATE INDEX idx_trunk_ip_lookup ON trunk_auth_ips USING hash (ip_address);
CREATE INDEX idx_trunk_ip_trunk ON trunk_auth_ips(trunk_id);

-- Trunk DIDs
CREATE TABLE trunk_dids (
    id SERIAL PRIMARY KEY,
    trunk_id INT NOT NULL REFERENCES sip_trunks(id) ON DELETE CASCADE,
    did VARCHAR(20) NOT NULL,
    CONSTRAINT trunk_did_unique UNIQUE (did)
);

CREATE INDEX idx_trunk_did_lookup ON trunk_dids USING hash (did);

-- Grant permissions
GRANT SELECT ON customers, rcf_numbers, sip_trunks, trunk_auth_ips, trunk_dids TO freeswitch;
GRANT ALL ON customers, rcf_numbers, sip_trunks, trunk_auth_ips, trunk_dids TO api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO api;
