-- Migration: platform envelope encryption (recordings + chat) + durable admin audit log
-- ============================================================================
-- Extends the already-shipped Visual Voicemail envelope-encryption capability
-- (per-object AES-256-GCM DEK, KMS-wrapped KEK, crypto-erase) to CALL RECORDINGS
-- and CHAT, and adds the SOC 2 "audit trail" control table. Backs:
--   * docker/api/src/services/envelope_crypto.py   (generalised crypto module)
--   * docker/api/src/routers/recordings.py         (encrypt-on-write + decrypt-stream)
--   * docker/api/src/routers/chat.py               (per-conversation DEK, encrypt-at-rest)
--   * docker/api/src/routers/customers.py          (durable admin audit rows)
--
-- Why a migration (not init/): init/*.sql only runs on first `initdb`. Existing
-- databases (production services VM + any already-initialised local volume) must
-- get these tables/columns via this migration. **Migrations are applied BY HAND**
-- -- there is no Alembic/auto-runner yet. Run this on every environment that
-- already has the recordings / chat_* / customers tables, BEFORE deploying the
-- API build that references the new columns/tables.
--
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, and
-- a guarded UNIQUE constraint add. Safe to run repeatedly. Adding NOT-NULL
-- columns WITH a constant DEFAULT is a metadata-only change on PostgreSQL 11+
-- (no full table rewrite), so this does not lock the tables meaningfully.
--
-- BACK-COMPAT / MIXED STATE (critical):
--   * recordings.encryption_status DEFAULTs to 'plaintext', so every ALREADY-STORED
--     recording is served by the existing presigned path unchanged. Only NEW
--     ingests (with a configured KEK) are written encrypted. Nothing re-encrypts
--     or breaks old objects.
--   * chat_messages keeps the legacy `content TEXT` column; encrypted rows set it
--     NULL and populate content_ciphertext/content_iv. Old plaintext rows read
--     back exactly as before.
--
-- Apply (production services VM, bare-metal PostgreSQL, DB 'voip'):
--
--   sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/migrations/2026-07-01_envelope_encryption_and_audit.sql
--
-- Verify afterwards:
--
--   sudo -u postgres psql -d voip -c "\d envelope_keys" -c "\d admin_audit_log"
--   sudo -u postgres psql -d voip -c "SELECT column_name FROM information_schema.columns WHERE table_name='recordings' AND column_name LIKE '%enc%' OR column_name='wrapped_dek';"
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) envelope_keys — one KEK per scope, created once and reused.
--    scope examples: 'recordings:customer:1', 'chat:customer:1'. The KEK wraps
--    each object's per-object DEK; scope-level crypto-erase flips status +
--    destroys the KEK (see envelope_crypto.crypto_erase_scope). Voicemail is
--    NOT here -- it keeps per-mailbox KEK refs on voicemail_boxes (unchanged).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS envelope_keys (
    id            SERIAL PRIMARY KEY,
    scope         VARCHAR(120) NOT NULL UNIQUE,       -- stable, unique per KEK
    customer_id   INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    kek_provider  VARCHAR(20) NOT NULL DEFAULT 'local'
                      CHECK (kek_provider IN ('local', 'gcpkms')),
    kek_key_ref   TEXT,                               -- opaque KEK handle from the provider
    status        VARCHAR(20) NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'crypto_erased')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    erased_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_envelope_keys_customer ON envelope_keys(customer_id);

-- ---------------------------------------------------------------------------
-- 2) recordings — envelope columns (non-destructive; existing rows = plaintext).
--    A recording is served either as a presigned plaintext object (legacy /
--    encryption disabled) or via the token->stream decrypt path (encrypted).
-- ---------------------------------------------------------------------------
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS wrapped_dek       BYTEA;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS iv                BYTEA;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS kek_provider      VARCHAR(20);
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS kek_key_ref       TEXT;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS enc_algo          VARCHAR(32);
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS encryption_status VARCHAR(20) NOT NULL DEFAULT 'plaintext'
    CHECK (encryption_status IN ('plaintext', 'encrypted', 'pending', 'crypto_erased'));

-- ---------------------------------------------------------------------------
-- 3) chat — per-CONVERSATION DEK (wrapped under the customer chat KEK) lives on
--    the conversation; each message body is AES-256-GCM encrypted with that DEK
--    (fresh IV per message). Reading a thread unwraps the DEK ONCE, not per
--    message (no KMS N+1). Legacy plaintext messages keep `content`.
-- ---------------------------------------------------------------------------
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS wrapped_dek       BYTEA;
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS kek_provider      VARCHAR(20);
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS kek_key_ref       TEXT;
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS enc_algo          VARCHAR(32);
ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS encryption_status VARCHAR(20) NOT NULL DEFAULT 'plaintext'
    CHECK (encryption_status IN ('plaintext', 'encrypted', 'crypto_erased'));

-- Message body ciphertext. `content` stays for legacy plaintext rows; encrypted
-- rows set content = NULL and populate content_ciphertext + content_iv.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS content_ciphertext BYTEA;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS content_iv         BYTEA;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS enc_algo           VARCHAR(32);

-- ---------------------------------------------------------------------------
-- 4) admin_audit_log — durable audit trail for privileged admin mutations
--    (customer credit changes, customer deletes, media crypto-erase, ...).
--    Upgrades the prior structured-log-only hook to a queryable table (a direct
--    SOC 2 CC / audit-trail control). No FK on target_id (heterogeneous targets;
--    the log must survive the target's deletion).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_audit_log (
    id            BIGSERIAL PRIMARY KEY,
    actor_user_id INT,                                -- users.id of the acting admin (no FK: log outlives users)
    actor_email   VARCHAR(255),
    action        VARCHAR(60) NOT NULL,               -- customer_credit | customer_delete | recording_crypto_erase | ...
    target_type   VARCHAR(40),                        -- customer | recording | mailbox | ...
    target_id     VARCHAR(64),                        -- id of the target (text: ints and uuids)
    detail        JSONB,
    ip_address    VARCHAR(64),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit_log(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_actor ON admin_audit_log(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit_log(target_type, target_id);

-- ---------------------------------------------------------------------------
-- Grants — runtime API role needs CRUD on the new tables + their sequences.
-- (The recordings / chat_* tables already GRANT ALL ... TO api from their init
-- scripts; a table-level grant automatically covers columns added later, so the
-- new columns need no extra grant.) FreeSWITCH gets nothing new: it ingests
-- recordings via the API (which owns encrypt-on-write) and never reads these
-- audit/key tables.
-- ---------------------------------------------------------------------------
GRANT ALL ON envelope_keys, admin_audit_log TO api;
GRANT USAGE, SELECT ON envelope_keys_id_seq, admin_audit_log_id_seq TO api;

COMMIT;
