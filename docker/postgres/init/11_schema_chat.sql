-- Chat / Messaging Schema for UCaaS
-- Depends on: 02_schema_core.sql (customers), 09_schema_users.sql (users)

-- ---------------------------------------------------------------------------
-- Conversations: direct (1:1) or group chats
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_conversations (
    id SERIAL PRIMARY KEY,
    customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    type VARCHAR(10) NOT NULL CHECK (type IN ('direct', 'group')),
    name VARCHAR(100),
    created_by INT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tenant-scoped listing sorted by most recent activity
CREATE INDEX IF NOT EXISTS idx_chat_conv_customer_updated
    ON chat_conversations(customer_id, updated_at DESC);

-- ---------------------------------------------------------------------------
-- Participants: members of each conversation with read tracking
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_participants (
    id SERIAL PRIMARY KEY,
    conversation_id INT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(10) NOT NULL DEFAULT 'member'
        CHECK (role IN ('owner', 'admin', 'member')),
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    last_read_message_id INT,
    last_read_at TIMESTAMPTZ,
    UNIQUE (conversation_id, user_id)
);

-- Find all conversations for a user quickly
CREATE INDEX IF NOT EXISTS idx_chat_part_user
    ON chat_participants(user_id);

-- Lookup participants of a conversation
CREATE INDEX IF NOT EXISTS idx_chat_part_conv
    ON chat_participants(conversation_id);

-- ---------------------------------------------------------------------------
-- Messages: message content with soft-delete support
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_messages (
    id SERIAL PRIMARY KEY,
    conversation_id INT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    sender_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT,
    message_type VARCHAR(20) NOT NULL DEFAULT 'text'
        CHECK (message_type IN ('text', 'file', 'image', 'system')),
    reply_to_id INT REFERENCES chat_messages(id) ON DELETE SET NULL,
    edited_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Paginated message listing (newest first) within a conversation
CREATE INDEX IF NOT EXISTS idx_chat_msg_conv_created
    ON chat_messages(conversation_id, created_at DESC);

-- Also index by id descending for cursor-based pagination (WHERE id < ?)
CREATE INDEX IF NOT EXISTS idx_chat_msg_conv_id
    ON chat_messages(conversation_id, id DESC);

-- Unread counting: messages after a given id in a conversation
-- (covered by idx_chat_msg_conv_id above)

-- ---------------------------------------------------------------------------
-- Attachments: file metadata for uploads
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_attachments (
    id SERIAL PRIMARY KEY,
    message_id INT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    mime_type VARCHAR(100),
    file_size INT,
    storage_path VARCHAR(500) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_attach_message
    ON chat_attachments(message_id);

-- ---------------------------------------------------------------------------
-- Add FK from participants.last_read_message_id -> messages after both exist
-- ---------------------------------------------------------------------------
ALTER TABLE chat_participants
    ADD CONSTRAINT fk_chat_part_last_read
    FOREIGN KEY (last_read_message_id) REFERENCES chat_messages(id)
    ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

-- API service needs full CRUD
GRANT ALL ON chat_conversations, chat_participants, chat_messages, chat_attachments TO api;
GRANT USAGE, SELECT ON chat_conversations_id_seq, chat_participants_id_seq,
    chat_messages_id_seq, chat_attachments_id_seq TO api;

-- FreeSWITCH only needs read access (e.g. for presence-aware features)
GRANT SELECT ON chat_conversations, chat_participants, chat_messages, chat_attachments TO freeswitch;
