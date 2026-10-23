-- ==========================================================================
-- 56_voicemail_transcription.sql
-- Voicemail transcription v1.1 — per-mailbox settings, the transcript /
-- job table, the purge trigger and a counts-only NOC view.
--
-- Contract: docs/VOICEMAIL_TRANSCRIPTION_PLAN.md §4 (owner decisions §0.1
-- override the rest of that document). Requires 54_voicemail.sql.
--
-- WHAT THIS DOES (idempotent — every object is IF NOT EXISTS / guarded /
-- CREATE OR REPLACE, so a re-run is clean; TWO transactions):
--   Part 1 (voicemail_boxes only — it is on the call path, see LOCKING):
--     * transcription_enabled BOOLEAN NOT NULL DEFAULT false — every mailbox,
--       existing and new, starts OFF (O1: a later paid add-on; O2: only a
--       platform admin may switch it). Metadata-only ADD COLUMN (PG >= 11).
--     * transcription_language VARCHAR(16) NOT NULL DEFAULT 'en-US' + a
--       SHAPE-only CHECK. The supported list (en-US / es-US / fr-CA) lives in
--       code (services/voicemail/transcription/config.py): adding a language
--       is not a migration.
--   Part 2:
--     a. voicemail_messages UNIQUE (id, mailbox_id, customer_id) — the target
--        of the transcript's composite FK, so a transcript's mailbox_id and
--        customer_id (AAD inputs AND the tenant filter) can never disagree
--        with its message (same pattern as 54's voicemail_boxes_id_customer_key).
--     b. idx_vm_messages_stored_created — the worker's discovery range scan
--        over recently stored messages.
--     c. voicemail_transcripts — ONE row per message: durable job state
--        (status / attempts / next_attempt_at / lease_until / fencing
--        attempt_id) + the SEALED transcript (AES-256-GCM ciphertext, KMS-
--        wrapped DEK, iv, kek_version). Ciphertext only — never plaintext.
--        CHECKs: crypto fields present exactly when status='done' (a half-
--        written row can never be served, a re-queued row can never keep
--        stale ciphertext), a 'processing' row always holds a lease + token,
--        iv 12 bytes, ciphertext 17..65552 bytes (1..65536 plaintext + 16-byte
--        tag), confidence 0..1, machine-only error codes. ON DELETE CASCADE
--        from the message.
--     d. trg_vm_messages_purge_transcript — EVERY transition of a message to
--        'purged' (retention, user purge, mailbox delete, crypto-erase, any
--        future path) deletes its transcript in the SAME transaction. The
--        WHEN clause is false for every deposit transition (pending/failed ->
--        stored), so the deposit path pays one predicate check per finalize
--        and nothing else. Invoker rights: the api role's DELETE grant (below)
--        is all it needs, so the v1 API keeps working with 56 applied.
--     e. voicemail_transcription_stats — counts only (no customer, no
--        content) for the NOC Grafana. A plain (owner-rights) view, so
--        grafana_ro reads it with NO access to the table.
--     f. Grants, role-guarded (an unguarded GRANT aborts the migration on a
--        cluster without the role — see 47's header): api = SELECT, INSERT,
--        UPDATE, DELETE on the table + SELECT on the view; freeswitch,
--        grafana_ro and PUBLIC get NOTHING on the table. NOTE: 24_grafana_ro's
--        ALTER DEFAULT PRIVILEGES hands grafana_ro SELECT on every new table
--        the superuser creates — the REVOKE is load-bearing, not cosmetic.
--
-- LOCKING: both parts SET LOCAL lock_timeout = '5s' and FAIL FAST instead of
-- queueing behind a long reader; on a timeout, just re-run the file.
--   * Part 1 holds ACCESS EXCLUSIVE on voicemail_boxes for milliseconds (two
--     metadata-only ADD COLUMNs and a CHECK over a tiny table). number_routing
--     reads it on the call path, on the primary and in every replica's WAL
--     replay — which is why Part 1 is its own short transaction.
--   * Part 2's UNIQUE constraint and index build lock voicemail_messages (not
--     on the call path); a deposit that arrives meanwhile waits inside its
--     11 s deadline. Milliseconds to ~1 s at today's table size.
--   Apply in a quiet period; no further ceremony needed.
--
-- PRODUCTION NOTE: init scripts only run on the first initdb of a fresh data
-- directory. Apply MANUALLY on the East primary (services VM) as a SUPERUSER;
-- it replicates to every zone replica:
--     sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/56_voicemail_transcription.sql
-- Apply BEFORE the API build that reads these columns. The v1 API tolerates
-- 56 (new columns have defaults; the purge trigger only DELETEs transcript
-- rows, which the api role may do).
--
-- Verification (after applying):
--     sudo -u postgres psql -d voip -f /opt/revup/scripts/db/check_migrations.sql
--   Expect "56_voicemail_transcription | applied".
--
-- Emergency-only down (ONLY if transcription was never switched on; not
-- needed for a rollback — the platform flag is the kill switch):
--     DROP TRIGGER trg_vm_messages_purge_transcript ON voicemail_messages;
--     DROP VIEW voicemail_transcription_stats;
--     DROP TABLE voicemail_transcripts;
--     ALTER TABLE voicemail_boxes DROP COLUMN transcription_language, DROP COLUMN transcription_enabled;
--
-- Tests: tests/test_voicemail_migration56.py (real 02..34 prerequisites + 54,
-- then 56 twice).
-- ==========================================================================

-- ---------------------------------------------------------------------------
-- Part 1 — per-mailbox settings. voicemail_boxes is read by number_routing on
-- the call path: keep this ACCESS EXCLUSIVE window minimal.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE voicemail_boxes
    ADD COLUMN IF NOT EXISTS transcription_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE voicemail_boxes
    ADD COLUMN IF NOT EXISTS transcription_language VARCHAR(16) NOT NULL DEFAULT 'en-US';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'voicemail_boxes'::regclass
                      AND conname = 'voicemail_boxes_transcription_language_chk') THEN
        -- Shape only; the supported list lives in code (adding a language is
        -- not a migration).
        ALTER TABLE voicemail_boxes ADD CONSTRAINT voicemail_boxes_transcription_language_chk
            CHECK (transcription_language ~ '^[a-z]{2,3}-[A-Z]{2}$');
    END IF;
END $$;

COMMIT;

-- ---------------------------------------------------------------------------
-- Part 2 — transcripts.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL lock_timeout = '5s';

-- 2a. FK target so a transcript's (mailbox_id, customer_id) — AAD inputs and
--     the tenant filter — can never disagree with its message (pattern of
--     54's voicemail_boxes_id_customer_key).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'voicemail_messages'::regclass
                      AND conname = 'voicemail_messages_id_box_customer_key') THEN
        ALTER TABLE voicemail_messages ADD CONSTRAINT voicemail_messages_id_box_customer_key
            UNIQUE (id, mailbox_id, customer_id);
    END IF;
END $$;

-- 2b. Discovery: the worker range-scans recently stored messages.
CREATE INDEX IF NOT EXISTS idx_vm_messages_stored_created
    ON voicemail_messages (created_at) WHERE status = 'stored';

-- 2c. One row per transcribed (or to-be-transcribed) message: job state +
--     sealed transcript. Ciphertext only — never plaintext.
CREATE TABLE IF NOT EXISTS voicemail_transcripts (
    message_id       BIGINT PRIMARY KEY,
    mailbox_id       INT NOT NULL,
    customer_id      INT NOT NULL,
    status           VARCHAR(16) NOT NULL DEFAULT 'pending',
    language         VARCHAR(16) NOT NULL,
    attempts         SMALLINT NOT NULL DEFAULT 0,
    next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_until      TIMESTAMPTZ,
    attempt_id       UUID,                 -- fencing token of the live attempt
    error_code       VARCHAR(40),          -- machine code only (plan §6.7), never provider text
    provider         VARCHAR(16),          -- 'gcp_stt_v2' | 'fake'
    model            VARCHAR(32),          -- 'telephony' | 'chirp_3' | 'fake'
    confidence       REAL,                 -- duration-weighted utterance confidence, 0..1
    audio_ms         INT,                  -- audio actually sent (after trim / silent-piece skip)
    billed_ms        INT,                  -- provider-reported billed duration (fallback: rounded sent)
    chunk_count      SMALLINT,
    ciphertext       BYTEA,                -- AES-256-GCM(DEK, iv, aad=vmt:..) of the transcript JSON (incl. tag)
    wrapped_dek      BYTEA,                -- KMS-wrapped DEK, same AAD
    kek_version      TEXT,                 -- CryptoKeyVersion that wrapped the DEK
    iv               BYTEA,
    enc_algo         VARCHAR(32) NOT NULL DEFAULT 'AES-256-GCM',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at     TIMESTAMPTZ,
    CONSTRAINT voicemail_transcripts_message_fk
        FOREIGN KEY (message_id, mailbox_id, customer_id)
        REFERENCES voicemail_messages (id, mailbox_id, customer_id) ON DELETE CASCADE,
    CONSTRAINT voicemail_transcripts_status_chk
        CHECK (status IN ('pending', 'processing', 'done', 'empty', 'failed', 'disabled')),
    CONSTRAINT voicemail_transcripts_language_chk
        CHECK (language ~ '^[a-z]{2,3}-[A-Z]{2}$'),
    CONSTRAINT voicemail_transcripts_attempts_chk CHECK (attempts BETWEEN 0 AND 100),
    CONSTRAINT voicemail_transcripts_lease_chk CHECK (
        status <> 'processing' OR (lease_until IS NOT NULL AND attempt_id IS NOT NULL)),
    -- Ciphertext exists exactly when status = 'done' (a half-written row can
    -- never be served; a re-queued row can never keep stale ciphertext).
    CONSTRAINT voicemail_transcripts_crypto_chk CHECK (
        (status = 'done' AND ciphertext IS NOT NULL AND wrapped_dek IS NOT NULL
                         AND kek_version IS NOT NULL AND iv IS NOT NULL)
        OR (status <> 'done' AND ciphertext IS NULL AND wrapped_dek IS NULL
                             AND kek_version IS NULL AND iv IS NULL)),
    CONSTRAINT voicemail_transcripts_iv_len_chk CHECK (iv IS NULL OR octet_length(iv) = 12),
    CONSTRAINT voicemail_transcripts_ct_len_chk
        CHECK (ciphertext IS NULL OR octet_length(ciphertext) BETWEEN 17 AND 65552),
    CONSTRAINT voicemail_transcripts_confidence_chk
        CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    CONSTRAINT voicemail_transcripts_error_code_chk
        CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,40}$')
);

-- Claim (due pending jobs), lease reaper, mailbox delete / disable flips, and
-- the rolling 24 h billed-minutes budget + stats.
CREATE INDEX IF NOT EXISTS idx_vm_transcripts_due
    ON voicemail_transcripts (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_vm_transcripts_lease
    ON voicemail_transcripts (lease_until) WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS idx_vm_transcripts_mailbox
    ON voicemail_transcripts (mailbox_id);
CREATE INDEX IF NOT EXISTS idx_vm_transcripts_completed
    ON voicemail_transcripts (completed_at) WHERE status IN ('done', 'empty');

-- 2d. Every transition of a message to 'purged' (retention, user purge,
--     mailbox delete, crypto-erase, any future path) deletes its transcript
--     in the SAME transaction. WHEN is false for every deposit transition.
CREATE OR REPLACE FUNCTION voicemail_messages_purge_transcript() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
BEGIN
    DELETE FROM public.voicemail_transcripts WHERE message_id = NEW.id;
    RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION voicemail_messages_purge_transcript() FROM PUBLIC;

CREATE OR REPLACE TRIGGER trg_vm_messages_purge_transcript
    AFTER UPDATE OF status ON voicemail_messages
    FOR EACH ROW
    WHEN (NEW.status = 'purged' AND OLD.status IS DISTINCT FROM 'purged')
    EXECUTE FUNCTION voicemail_messages_purge_transcript();

-- 2e. Counts-only view for the NOC Grafana (no customer, no content). Runs
--     with the view owner's rights, so grafana_ro needs no table access.
CREATE OR REPLACE VIEW voicemail_transcription_stats AS
SELECT status,
       count(*)::bigint                                                         AS jobs,
       min(created_at)                                                          AS oldest_created_at,
       COALESCE(sum(billed_ms) FILTER (WHERE completed_at >= now() - interval '24 hours'), 0)::bigint
                                                                                AS billed_ms_24h
  FROM voicemail_transcripts
 GROUP BY status;

-- 2f. Grants (role-guarded, pattern of 54). 24_grafana_ro's ALTER DEFAULT
--     PRIVILEGES would otherwise hand grafana_ro SELECT on the new TABLE — the
--     REVOKE is load-bearing.
REVOKE ALL ON voicemail_transcripts FROM PUBLIC;
REVOKE ALL ON voicemail_transcription_stats FROM PUBLIC;
DO $$
DECLARE
    r TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON voicemail_transcripts TO api;
        GRANT SELECT ON voicemail_transcription_stats TO api;
    END IF;
    FOREACH r IN ARRAY ARRAY['freeswitch', 'grafana_ro'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('REVOKE ALL ON voicemail_transcripts FROM %I', r);
        END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_ro') THEN
        GRANT SELECT ON voicemail_transcription_stats TO grafana_ro;
    END IF;
END $$;

COMMIT;
