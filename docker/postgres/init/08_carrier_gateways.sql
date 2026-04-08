-- Carrier Gateway Configuration
-- Stores SIP trunk connections to upstream carriers

CREATE TABLE IF NOT EXISTS carrier_gateways (
    id SERIAL PRIMARY KEY,
    gateway_name VARCHAR(50) NOT NULL UNIQUE,
    display_name VARCHAR(100) NOT NULL,
    description TEXT,
    sip_proxy VARCHAR(255) NOT NULL,
    port INT DEFAULT 5060,
    transport VARCHAR(10) DEFAULT 'udp' CHECK (transport IN ('udp', 'tcp', 'tls')),
    auth_type VARCHAR(20) DEFAULT 'ip' CHECK (auth_type IN ('ip', 'credential', 'both')),
    username VARCHAR(100),
    password VARCHAR(100),
    register BOOLEAN DEFAULT false,
    caller_id_in_from BOOLEAN DEFAULT true,
    codec_prefs VARCHAR(255) DEFAULT 'PCMU,PCMA',
    max_channels INT,
    cps_limit INT,
    product_types TEXT[] DEFAULT '{}',
    is_primary BOOLEAN DEFAULT false,
    is_failover BOOLEAN DEFAULT false,
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed Bandwidth Trunk Configuration 4 gateways
INSERT INTO carrier_gateways
    (gateway_name, display_name, description, sip_proxy, port, product_types, is_primary, is_failover, enabled)
VALUES
    ('carrier_standard', 'Bandwidth Standard (Dallas)',
     'Low-CPS trunk for RCF and SIP Trunk customers via Kamailio SBC.',
     '67.231.2.12', 5060, ARRAY['rcf','trunk'], true, false, true),
    ('carrier_premium', 'Bandwidth Premium (LA)',
     'High-CPS trunk for API Calling customers via Kamailio SBC.',
     '216.82.238.134', 5060, ARRAY['api'], true, false, true),
    ('carrier_backup', 'Bandwidth Backup (Dallas)',
     'Failover gateway for both trunks.',
     '67.231.2.12', 5060, ARRAY['rcf','trunk','api'], false, true, true)
ON CONFLICT (gateway_name) DO NOTHING;

-- Grant permissions
GRANT ALL ON carrier_gateways TO api;
GRANT SELECT ON carrier_gateways TO freeswitch;
GRANT USAGE, SELECT ON carrier_gateways_id_seq TO api;
