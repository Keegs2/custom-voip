-- Conferencing Schema for UCaaS
-- Depends on: 02_schema_core.sql (customers), 09_schema_users.sql (users)
--
-- Provides conference rooms, scheduling, participant invites, and session
-- history.  Conference rooms are namespaced per-customer in FreeSWITCH using
-- the format: room_{customer_id}_{room_number}

-- ---------------------------------------------------------------------------
-- Conference rooms managed by customers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conferences (
    id SERIAL PRIMARY KEY,
    customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    room_number VARCHAR(10) NOT NULL,   -- maps to FS conference room
    pin VARCHAR(10),                     -- optional access PIN
    moderator_pin VARCHAR(10),           -- separate moderator PIN
    max_members INT DEFAULT 50,
    recording_enabled BOOLEAN DEFAULT false,
    video_enabled BOOLEAN DEFAULT true,
    created_by INT REFERENCES users(id) ON DELETE SET NULL,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(customer_id, room_number)
);

-- Tenant-scoped listing
CREATE INDEX IF NOT EXISTS idx_conferences_customer
    ON conferences(customer_id);

-- Active conferences for a customer (most common query)
CREATE INDEX IF NOT EXISTS idx_conferences_customer_active
    ON conferences(customer_id, status) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- Scheduled conference sessions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conference_schedules (
    id SERIAL PRIMARY KEY,
    conference_id INT NOT NULL REFERENCES conferences(id) ON DELETE CASCADE,
    title VARCHAR(200),
    description TEXT,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    recurrence_rule VARCHAR(200),  -- iCal RRULE format
    created_by INT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Upcoming schedules for a conference
CREATE INDEX IF NOT EXISTS idx_conf_sched_conference
    ON conference_schedules(conference_id, start_time);

-- Find all upcoming schedules across a customer (for dashboard)
CREATE INDEX IF NOT EXISTS idx_conf_sched_start
    ON conference_schedules(start_time)
    WHERE start_time > NOW();

-- ---------------------------------------------------------------------------
-- Track who is invited to conferences
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conference_participants (
    id SERIAL PRIMARY KEY,
    conference_id INT NOT NULL REFERENCES conferences(id) ON DELETE CASCADE,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    extension VARCHAR(10),
    role VARCHAR(20) DEFAULT 'participant' CHECK (role IN ('moderator', 'participant')),
    invited_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(conference_id, user_id)
);

-- Find all conferences a user is invited to
CREATE INDEX IF NOT EXISTS idx_conf_part_user
    ON conference_participants(user_id);

-- List participants of a conference
CREATE INDEX IF NOT EXISTS idx_conf_part_conference
    ON conference_participants(conference_id);

-- ---------------------------------------------------------------------------
-- Historical session records
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conference_sessions (
    id SERIAL PRIMARY KEY,
    conference_id INT NOT NULL REFERENCES conferences(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    recording_path VARCHAR(500),
    participant_count INT DEFAULT 0
);

-- Session history for a conference
CREATE INDEX IF NOT EXISTS idx_conf_sessions_conference
    ON conference_sessions(conference_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

-- API service needs full CRUD
GRANT ALL ON conferences, conference_schedules, conference_participants, conference_sessions TO api;
GRANT USAGE, SELECT ON conferences_id_seq, conference_schedules_id_seq,
    conference_participants_id_seq, conference_sessions_id_seq TO api;

-- FreeSWITCH needs read access for conference routing and write on sessions
GRANT SELECT ON conferences, conference_participants TO freeswitch;
GRANT SELECT, INSERT, UPDATE ON conference_sessions TO freeswitch;
GRANT USAGE, SELECT ON conference_sessions_id_seq TO freeswitch;
