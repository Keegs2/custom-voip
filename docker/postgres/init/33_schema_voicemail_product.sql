-- ===========================================================================
-- 33_schema_voicemail_product.sql
-- Standalone, encrypted-at-rest Visual Voicemail product (Phase 1).
-- See docs/VISUAL_VOICEMAIL_PRODUCT_PLAN.md §1 (schema) + §4 (encryption).
--
-- The unit of ownership is a Voicemail Box (mailbox), DECOUPLED from a UCaaS
-- extension so ANY account type (or a customer with no other product) can buy
-- it. v1 ships two deterministic delivery models, both resolving the mailbox by
-- the dialed DID:
--   1. dedicated_did  — a per-mailbox access DID the customer buys from us
--   2. attached       — the no-answer/busy fallback of an existing revup line
-- (forward_access / api binding types are reserved in the CHECK for
--  forward-compat but are NOT used by any v1 code path.)
--
-- Idempotent: wrapped in BEGIN/COMMIT, CREATE TABLE/INDEX IF NOT EXISTS,
-- ADD COLUMN IF NOT EXISTS, NOT-EXISTS-guarded back-fill. Safe to re-run and to
-- hand-apply on the bare production PG instance (init scripts only run on first
-- initdb; this must be applied manually on existing databases).
--
-- Depends on: 02_schema_core.sql (customers), 09_schema_users.sql (users),
--             10_schema_ucaas.sql (extensions, voicemails, voicemail_greetings),
--             17_did_inventory.sql (DID ownership gate for dedicated_did).
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Entitlement flag (mirrors 11c_ucaas_enabled_flag.sql). Gates mailbox
-- creation and un-gates the sidebar nav on the frontend.
-- ---------------------------------------------------------------------------
ALTER TABLE customers ADD COLUMN IF NOT EXISTS voicemail_enabled BOOLEAN DEFAULT false;

-- ---------------------------------------------------------------------------
-- did_inventory.product_type — allow 'voicemail' so the self-serve dedicated-DID
-- claim (POST /voicemail/mailboxes/{id}/bindings) can mark an AVAILABLE inventory
-- DID assigned to a customer for a voicemail mailbox, mirroring number_inventory
-- assign semantics (status='assigned', product_type set, product_ref_id = the
-- voicemail_box_bindings row id). 17_did_inventory.sql shipped the CHECK without
-- 'voicemail'. Idempotent: drop-and-recreate the named constraint. NULL still
-- passes (unassigned DIDs).
-- ---------------------------------------------------------------------------
ALTER TABLE did_inventory DROP CONSTRAINT IF EXISTS did_inventory_product_type_check;
ALTER TABLE did_inventory ADD CONSTRAINT did_inventory_product_type_check
    CHECK (product_type IN ('rcf', 'trunk', 'api', 'ucaas', 'voicemail'));

-- ---------------------------------------------------------------------------
-- §1.1 voicemail_boxes — the mailbox spine
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voicemail_boxes (
    id                SERIAL PRIMARY KEY,
    customer_id       INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    user_id           INT REFERENCES users(id) ON DELETE SET NULL,        -- optional owner
    extension_id      INT REFERENCES extensions(id) ON DELETE SET NULL,   -- optional UCaaS link
    label             VARCHAR(120),
    status            VARCHAR(20) NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'suspended', 'deleted')),
    pin_hash          VARCHAR(255),                 -- bcrypt; NULL = no PIN set
    timezone          VARCHAR(64) NOT NULL DEFAULT 'America/New_York',
    retention_days    INT NOT NULL DEFAULT 0,       -- 0 = retain indefinitely
    -- Encryption binding (envelope model). kek_provider selects the KMS seam;
    -- kek_key_ref is the opaque KEK handle returned by that provider.
    kek_provider      VARCHAR(20) NOT NULL DEFAULT 'local'
                          CHECK (kek_provider IN ('local', 'gcpkms')),
    kek_key_ref       TEXT,
    encryption_status VARCHAR(20) NOT NULL DEFAULT 'active'
                          CHECK (encryption_status IN ('pending', 'active', 'crypto_erased')),
    plan_sku          VARCHAR(60),
    legal_hold        BOOLEAN NOT NULL DEFAULT false,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A given extension maps to at most one mailbox (the back-fill + attach link).
CREATE UNIQUE INDEX IF NOT EXISTS idx_vm_boxes_extension
    ON voicemail_boxes(extension_id) WHERE extension_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vm_boxes_customer ON voicemail_boxes(customer_id);
CREATE INDEX IF NOT EXISTS idx_vm_boxes_user ON voicemail_boxes(user_id) WHERE user_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- §1.2 voicemail_box_bindings — single-table mailbox resolution
-- v1 uses only 'dedicated_did' and 'attached'. 'forward_access'/'api' stay in
-- the CHECK for forward-compat but no v1 code path handles them.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voicemail_box_bindings (
    id            SERIAL PRIMARY KEY,
    mailbox_id    INT NOT NULL REFERENCES voicemail_boxes(id) ON DELETE CASCADE,
    binding_type  VARCHAR(20) NOT NULL
                      CHECK (binding_type IN ('dedicated_did', 'attached', 'forward_access', 'api')),
    -- dedicated_did: the mailbox's own access DID (To = did → this mailbox)
    did           VARCHAR(20),
    -- attached: the originating revup product + its DID/extension ref
    attach_product VARCHAR(20)
                      CHECK (attach_product IS NULL OR attach_product IN ('rcf', 'trunk', 'ucaas', 'api')),
    attach_ref    VARCHAR(64),
    -- forward_access (DEFERRED model): shared access DID + caller's diversion #.
    -- Reserved columns; never read in v1.
    access_did    VARCHAR(20),
    diversion     VARCHAR(20),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- v1 resolution #1: dedicated DID is globally unique among dedicated bindings.
CREATE UNIQUE INDEX IF NOT EXISTS idx_vm_bind_dedicated_did
    ON voicemail_box_bindings(did) WHERE binding_type = 'dedicated_did';
-- v1 resolution #2: attach by (product, ref).
CREATE INDEX IF NOT EXISTS idx_vm_bind_attached
    ON voicemail_box_bindings(attach_product, attach_ref) WHERE binding_type = 'attached';
CREATE INDEX IF NOT EXISTS idx_vm_bind_mailbox ON voicemail_box_bindings(mailbox_id);

-- ---------------------------------------------------------------------------
-- §1.3 Extend voicemails toward the mailbox (non-destructive).
-- Legacy columns (storage_path, transcription, extension_id) are PRESERVED and
-- legacy plaintext rows (wrapped_dek IS NULL) remain served by the legacy path.
-- New encrypted rows carry bucket/object_key/wrapped_dek/audio_iv.
-- ---------------------------------------------------------------------------
ALTER TABLE voicemails ADD COLUMN IF NOT EXISTS mailbox_id INT REFERENCES voicemail_boxes(id) ON DELETE CASCADE;
ALTER TABLE voicemails ADD COLUMN IF NOT EXISTS bucket VARCHAR(100);
ALTER TABLE voicemails ADD COLUMN IF NOT EXISTS object_key TEXT;
ALTER TABLE voicemails ADD COLUMN IF NOT EXISTS wrapped_dek BYTEA;
ALTER TABLE voicemails ADD COLUMN IF NOT EXISTS audio_iv BYTEA;
ALTER TABLE voicemails ADD COLUMN IF NOT EXISTS kek_key_ref TEXT;
ALTER TABLE voicemails ADD COLUMN IF NOT EXISTS enc_algo VARCHAR(32);
ALTER TABLE voicemails ADD COLUMN IF NOT EXISTS transcript_status VARCHAR(20) NOT NULL DEFAULT 'skipped'
    CHECK (transcript_status IN ('pending', 'processing', 'done', 'failed', 'skipped'));
ALTER TABLE voicemails ADD COLUMN IF NOT EXISTS is_saved BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE voicemails ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE voicemails ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE voicemails ADD COLUMN IF NOT EXISTS caller_name VARCHAR(100);

-- extension_id becomes nullable: dedicated-DID mailboxes have no extension.
-- (Wrapped so a re-run / already-nullable column does not error.)
DO $$
BEGIN
    BEGIN
        ALTER TABLE voicemails ALTER COLUMN extension_id DROP NOT NULL;
    EXCEPTION WHEN others THEN
        NULL;  -- already nullable
    END;
END $$;

CREATE INDEX IF NOT EXISTS idx_voicemails_mailbox
    ON voicemails(mailbox_id, created_at DESC) WHERE mailbox_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- §1.4 Extend voicemail_greetings toward the mailbox (non-destructive).
-- ---------------------------------------------------------------------------
ALTER TABLE voicemail_greetings ADD COLUMN IF NOT EXISTS mailbox_id INT REFERENCES voicemail_boxes(id) ON DELETE CASCADE;
ALTER TABLE voicemail_greetings ADD COLUMN IF NOT EXISTS bucket VARCHAR(100);
ALTER TABLE voicemail_greetings ADD COLUMN IF NOT EXISTS object_key TEXT;
ALTER TABLE voicemail_greetings ADD COLUMN IF NOT EXISTS wrapped_dek BYTEA;
ALTER TABLE voicemail_greetings ADD COLUMN IF NOT EXISTS iv BYTEA;
ALTER TABLE voicemail_greetings ADD COLUMN IF NOT EXISTS kek_key_ref TEXT;
ALTER TABLE voicemail_greetings ADD COLUMN IF NOT EXISTS enc_algo VARCHAR(32);
ALTER TABLE voicemail_greetings ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE voicemail_greetings ADD COLUMN IF NOT EXISTS schedule_kind VARCHAR(20) NOT NULL DEFAULT 'always'
    CHECK (schedule_kind IN ('always', 'business_hours', 'after_hours', 'custom'));
ALTER TABLE voicemail_greetings ADD COLUMN IF NOT EXISTS schedule_json JSONB;
ALTER TABLE voicemail_greetings ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- extension_id + storage_path become nullable (mailbox greetings use object_key).
DO $$
BEGIN
    BEGIN
        ALTER TABLE voicemail_greetings ALTER COLUMN extension_id DROP NOT NULL;
    EXCEPTION WHEN others THEN NULL;
    END;
    BEGIN
        ALTER TABLE voicemail_greetings ALTER COLUMN storage_path DROP NOT NULL;
    EXCEPTION WHEN others THEN NULL;
    END;
END $$;

CREATE INDEX IF NOT EXISTS idx_vm_greetings_mailbox
    ON voicemail_greetings(mailbox_id) WHERE mailbox_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- §1.5 voicemail_settings — per-mailbox preferences
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voicemail_settings (
    mailbox_id              INT PRIMARY KEY REFERENCES voicemail_boxes(id) ON DELETE CASCADE,
    notify_email            BOOLEAN NOT NULL DEFAULT false,
    notify_email_address    VARCHAR(255),
    attach_audio_to_email   BOOLEAN NOT NULL DEFAULT false,  -- link-only by default (compliance)
    notify_sms              BOOLEAN NOT NULL DEFAULT false,
    notify_sms_number       VARCHAR(20),
    transcription_enabled   BOOLEAN NOT NULL DEFAULT false,
    transcription_language  VARCHAR(10) NOT NULL DEFAULT 'en',
    greeting_mode           VARCHAR(20) NOT NULL DEFAULT 'standard'
                                CHECK (greeting_mode IN ('standard', 'name', 'custom')),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- §1.6 voicemail_access_log — audit every decrypt (play/download) + key op
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voicemail_access_log (
    id                SERIAL PRIMARY KEY,
    mailbox_id        INT REFERENCES voicemail_boxes(id) ON DELETE SET NULL,
    message_id        INT,                            -- voicemails.id (no FK: log survives purge)
    action            VARCHAR(40) NOT NULL,           -- play | download | greeting_play | key_create | crypto_erase | ...
    actor_user_id     INT,
    actor_customer_id INT,
    source            VARCHAR(20),                    -- ui | api | freeswitch
    ip_address        VARCHAR(64),
    user_agent        VARCHAR(255),
    detail            JSONB,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vm_access_mailbox ON voicemail_access_log(mailbox_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vm_access_message ON voicemail_access_log(message_id);

-- ---------------------------------------------------------------------------
-- §1.7 / §5 Billing — plan catalog + per-customer subscriptions (shape only;
-- enforcement is light in Phase 1).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voicemail_plans (
    id                    SERIAL PRIMARY KEY,
    sku                   VARCHAR(60) NOT NULL UNIQUE,
    name                  VARCHAR(120) NOT NULL,
    model                 VARCHAR(20) NOT NULL
                              CHECK (model IN ('dedicated_did', 'attached', 'gov')),
    monthly_price_cents   INT NOT NULL DEFAULT 0,
    included_messages     INT NOT NULL DEFAULT 0,      -- 0 = unlimited
    overage_cents         INT NOT NULL DEFAULT 0,      -- per message over included
    transcription_metered BOOLEAN NOT NULL DEFAULT false,
    retention_days        INT NOT NULL DEFAULT 0,
    dedicated_kek         BOOLEAN NOT NULL DEFAULT false,  -- gov SKU → per-mailbox KEK
    active                BOOLEAN NOT NULL DEFAULT true,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_voicemail_subscriptions (
    id                  SERIAL PRIMARY KEY,
    customer_id         INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    mailbox_id          INT REFERENCES voicemail_boxes(id) ON DELETE CASCADE,
    plan_sku            VARCHAR(60) NOT NULL REFERENCES voicemail_plans(sku),
    status              VARCHAR(20) NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'suspended', 'cancelled')),
    started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    current_period_end  TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vm_subs_customer ON customer_voicemail_subscriptions(customer_id);
CREATE INDEX IF NOT EXISTS idx_vm_subs_mailbox ON customer_voicemail_subscriptions(mailbox_id) WHERE mailbox_id IS NOT NULL;

-- Seed the two v1 base plans (idempotent).
INSERT INTO voicemail_plans (sku, name, model, monthly_price_cents, retention_days, dedicated_kek)
VALUES
    ('vm_dedicated_did', 'Voicemail + Dedicated Number', 'dedicated_did', 500, 90, false),
    ('vm_attached',      'Voicemail Add-on (existing line)', 'attached',   200, 90, false)
ON CONFLICT (sku) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Back-fill (§1.3) — non-destructive. For each extension that currently has
-- voicemail enabled, materialise a mailbox row (extension_id set,
-- encryption_status='pending' because any existing legacy audio is plaintext),
-- then point that extension's existing voicemails at the new mailbox.
--
-- NOT-EXISTS guarded so the migration is idempotent and never violates the
-- partial UNIQUE(extension_id) index. Legacy rows keep storage_path/
-- transcription and remain resolvable via the legacy serve path.
-- ---------------------------------------------------------------------------
INSERT INTO voicemail_boxes (customer_id, user_id, extension_id, label, encryption_status, kek_provider)
SELECT e.customer_id,
       e.user_id,
       e.id,
       COALESCE(e.display_name, 'Extension ' || e.extension),
       'pending',
       'local'
FROM extensions e
WHERE e.voicemail_enabled = true
  AND NOT EXISTS (
        SELECT 1 FROM voicemail_boxes b WHERE b.extension_id = e.id
  );

-- Link existing voicemails to their back-filled mailbox (only those still
-- unlinked). Legacy plaintext rows keep wrapped_dek NULL → served by legacy path.
UPDATE voicemails v
SET mailbox_id = b.id
FROM voicemail_boxes b
WHERE v.extension_id IS NOT NULL
  AND v.mailbox_id IS NULL
  AND b.extension_id = v.extension_id;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- API service: full CRUD on all new tables + sequences.
GRANT ALL ON voicemail_boxes, voicemail_box_bindings, voicemail_settings,
             voicemail_access_log, voicemail_plans, customer_voicemail_subscriptions TO api;
GRANT USAGE, SELECT ON
    voicemail_boxes_id_seq,
    voicemail_box_bindings_id_seq,
    voicemail_access_log_id_seq,
    voicemail_plans_id_seq,
    customer_voicemail_subscriptions_id_seq
    TO api;

-- FreeSWITCH: READ-ONLY for mailbox resolution + greeting selection. It does
-- NOT insert encrypted rows — the API owns encrypt-on-write (deposits arrive
-- via POST /voicemail/ingest). (It already has SELECT,INSERT on voicemails from
-- 10_schema_ucaas.sql; the encrypted product path does not use FS INSERT.)
GRANT SELECT ON voicemail_boxes, voicemail_box_bindings, voicemail_greetings,
                voicemail_settings TO freeswitch;

COMMIT;
