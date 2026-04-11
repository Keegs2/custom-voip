-- UCaaS Schema: Extensions, Presence, Voicemail, User Devices
-- Depends on: 02_schema_core.sql (customers), 09_schema_users.sql (users)

-- ---------------------------------------------------------------------------
-- Extensions: maps users to phone extensions within a customer account
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS extensions (
    id SERIAL PRIMARY KEY,
    extension VARCHAR(10) NOT NULL,
    user_id INT REFERENCES users(id) ON DELETE SET NULL,
    customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    display_name VARCHAR(100),
    voicemail_enabled BOOLEAN DEFAULT true,
    voicemail_pin VARCHAR(10) DEFAULT '1234',
    dnd BOOLEAN DEFAULT false,
    forward_on_busy VARCHAR(20),
    forward_on_no_answer VARCHAR(20),
    forward_timeout INT DEFAULT 30 CHECK (forward_timeout BETWEEN 5 AND 120),
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Extension numbers are globally unique across all customers.
-- (The composite index is kept for backward-compatibility but the real
-- uniqueness constraint is on extension alone.)
CREATE UNIQUE INDEX IF NOT EXISTS idx_extensions_customer_ext
    ON extensions(customer_id, extension);

-- Global uniqueness — no two customers may share the same extension number.
-- This also allows ON CONFLICT (extension) upserts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_extensions_ext_unique
    ON extensions(extension);

-- Fast lookup by user_id (resolve "which extension does this user own?")
CREATE INDEX IF NOT EXISTS idx_extensions_user ON extensions(user_id)
    WHERE user_id IS NOT NULL;

-- Customer-scoped listing
CREATE INDEX IF NOT EXISTS idx_extensions_customer ON extensions(customer_id);

-- ---------------------------------------------------------------------------
-- Presence status: real-time user status for BLF / contacts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS presence_status (
    user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'available'
        CHECK (status IN ('available', 'busy', 'away', 'dnd', 'offline')),
    status_message VARCHAR(200),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Voicemail messages
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voicemails (
    id SERIAL PRIMARY KEY,
    extension_id INT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
    caller_id VARCHAR(30),
    caller_name VARCHAR(100),
    duration_ms INT,
    storage_path VARCHAR(500),
    is_read BOOLEAN DEFAULT false,
    transcription TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- List voicemails for an extension, newest first
CREATE INDEX IF NOT EXISTS idx_voicemails_extension
    ON voicemails(extension_id, created_at DESC);

-- Fast unread count badge query
CREATE INDEX IF NOT EXISTS idx_voicemails_unread
    ON voicemails(extension_id, is_read) WHERE is_read = false;

-- ---------------------------------------------------------------------------
-- Voicemail greetings (per-extension, multiple types)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voicemail_greetings (
    id SERIAL PRIMARY KEY,
    extension_id INT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
    greeting_type VARCHAR(20) DEFAULT 'unavailable'
        CHECK (greeting_type IN ('unavailable', 'busy', 'name', 'temporary')),
    storage_path VARCHAR(500) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Only one greeting per type per extension
CREATE UNIQUE INDEX IF NOT EXISTS idx_vm_greetings_ext_type
    ON voicemail_greetings(extension_id, greeting_type);

-- ---------------------------------------------------------------------------
-- User devices (registered WebRTC / SIP endpoints)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_devices (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_type VARCHAR(20) NOT NULL
        CHECK (device_type IN ('webrtc', 'sip_phone', 'softphone', 'mobile')),
    device_name VARCHAR(100),
    user_agent VARCHAR(200),
    registered_at TIMESTAMPTZ,
    last_seen TIMESTAMPTZ,
    status VARCHAR(20) DEFAULT 'offline'
        CHECK (status IN ('online', 'offline', 'ringing', 'in_call'))
);

CREATE INDEX IF NOT EXISTS idx_user_devices_user ON user_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_user_devices_status
    ON user_devices(user_id, status) WHERE status != 'offline';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

-- API service needs full CRUD
GRANT ALL ON extensions, presence_status, voicemails, voicemail_greetings, user_devices TO api;
GRANT USAGE, SELECT ON extensions_id_seq, voicemails_id_seq, voicemail_greetings_id_seq, user_devices_id_seq TO api;

-- FreeSWITCH needs read access for call routing / voicemail deposit,
-- plus INSERT on voicemails so it can deposit messages directly.
GRANT SELECT ON extensions, presence_status, voicemail_greetings TO freeswitch;
GRANT SELECT, INSERT ON voicemails TO freeswitch;
GRANT USAGE, SELECT ON voicemails_id_seq TO freeswitch;
-- FreeSWITCH can update device registration status
GRANT SELECT, UPDATE, INSERT ON user_devices TO freeswitch;
GRANT USAGE, SELECT ON user_devices_id_seq TO freeswitch;

-- ---------------------------------------------------------------------------
-- Seed test UCaaS extensions for customer_id=5
-- ---------------------------------------------------------------------------
INSERT INTO extensions (extension, customer_id, display_name) VALUES
('2001', 5, 'UCaaS User 1'),
('2002', 5, 'UCaaS User 2')
ON CONFLICT (extension) DO NOTHING;
