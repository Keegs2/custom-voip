-- API Calling Product Tables

CREATE TABLE api_credentials (
    id SERIAL PRIMARY KEY,
    customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    api_key VARCHAR(64) NOT NULL,
    api_secret_hash VARCHAR(128) NOT NULL,  -- Store hashed, not plaintext
    webhook_url VARCHAR(512),
    status_callback_url VARCHAR(512),
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT api_key_unique UNIQUE (api_key)
);

-- Fast API key lookup for authentication
CREATE INDEX idx_api_key_lookup ON api_credentials USING hash (api_key);
CREATE INDEX idx_api_customer ON api_credentials(customer_id);

-- API DIDs with voice URLs
CREATE TABLE api_dids (
    id SERIAL PRIMARY KEY,
    customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    did VARCHAR(20) NOT NULL,
    voice_url VARCHAR(512) NOT NULL,
    fallback_url VARCHAR(512),
    status_callback VARCHAR(512),
    voice_method VARCHAR(10) DEFAULT 'POST',
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT api_did_unique UNIQUE (did)
);

CREATE INDEX idx_api_did_lookup ON api_dids USING hash (did);
CREATE INDEX idx_api_did_enabled ON api_dids(did, enabled) WHERE enabled = true;
CREATE INDEX idx_api_did_customer ON api_dids(customer_id);

-- Active calls tracking (for real-time status queries)
CREATE TABLE active_calls (
    uuid UUID PRIMARY KEY,
    customer_id INT NOT NULL,
    product_type VARCHAR(10) NOT NULL,
    trunk_id INT,
    direction VARCHAR(10) NOT NULL,
    caller_id VARCHAR(30),
    destination VARCHAR(30),
    start_time TIMESTAMPTZ DEFAULT NOW(),
    answer_time TIMESTAMPTZ,
    state VARCHAR(20) DEFAULT 'ringing'
);

-- Fast lookups for active call management
CREATE INDEX idx_active_customer ON active_calls(customer_id);
CREATE INDEX idx_active_trunk ON active_calls(trunk_id) WHERE trunk_id IS NOT NULL;
CREATE INDEX idx_active_state ON active_calls(state);

-- Grant permissions
GRANT SELECT ON api_credentials, api_dids TO freeswitch;
GRANT ALL ON api_credentials, api_dids, active_calls TO api;
GRANT SELECT, INSERT, UPDATE, DELETE ON active_calls TO freeswitch;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO freeswitch;
