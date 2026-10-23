-- ==========================================================================
-- 54_voicemail.sql
-- Encrypted voicemail v1 (dedicated-DID mailboxes) — schema + on-net arm.
--
-- Contract: docs/ENCRYPTED_VOICEMAIL_INTERFACES.md §1 (plan of record:
-- docs/ENCRYPTED_VOICEMAIL_BUILD_PLAN.md). No price/plan seeds (D5).
--
-- WHAT THIS DOES (one transaction, idempotent — re-running is a no-op):
--   1. customers.voicemail_enabled BOOLEAN NOT NULL DEFAULT false
--      (metadata-only ADD COLUMN on PG >= 11; no table rewrite).
--   2. did_inventory.product_type CHECK gains 'voicemail'. The original CHECK
--      in 17_did_inventory.sql is INLINE/UNNAMED, so it is located by
--      DEFINITION (every CHECK whose constrained column set is exactly
--      {product_type}, same catalog walk as 34_release_requested_status.sql),
--      dropped, and re-added as the NAMED did_inventory_product_type_check.
--      Skipped entirely when the canonical constraint already admits
--      'voicemail' (so a re-run takes no lock and revalidates nothing).
--   3. Tables voicemail_customer_keys / voicemail_boxes / voicemail_messages /
--      voicemail_greetings / voicemail_access_log + indexes + the
--      voicemail_boxes.active_greeting_id FK.
--   4. number_routing view: CREATE OR REPLACE with the three existing arms
--      BYTE-IDENTICAL to 22_number_routing.sql (no later migration redefined
--      the view — 24 only grants on it) plus a 4th 'voicemail' arm.
--   5. Grants: api = ALL on the voicemail tables (voicemail_access_log is
--      SELECT + INSERT only — append-only audit) + USAGE/SELECT on their
--      sequences. freeswitch, grafana_ro and PUBLIC get NOTHING on these
--      tables. NOTE: 24_grafana_ro.sql set ALTER DEFAULT PRIVILEGES ... GRANT
--      SELECT ON TABLES TO grafana_ro, so every table the superuser creates
--      would otherwise be readable by the anonymous NOC Grafana — the REVOKE
--      below is load-bearing, not cosmetic. FreeSWITCH reads ONLY the
--      number_routing view (which runs with the view owner's rights) and
--      talks to the API for everything else.
--   6. rate_cdr(): 05's definition + a voicemail clause — a CDR with
--      product_type='voicemail' rates to ZERO and never debits the balance
--      (decision D5, no voicemail billing in v1).
--
-- Added by the API workstream (backend-B) — also documented in the
-- contract §1 "As built (backend-B)":
--   * voicemail_messages.deposit_attempt_id / deposit_lease_until — the
--     deposit lease/fencing token that makes msg_uuid retries idempotent
--     and race-free across the 4 API worker processes;
--   * idx_vm_messages_live_mailbox — every non-purged row of a mailbox;
--   * uq_vm_access_log_playback_jti — "audit once per playback token"
--     across worker processes (INSERT ... ON CONFLICT DO NOTHING).
--
-- Guards beyond the contract column list (documented in the contract §1):
--   * voicemail_boxes.did must be canonical E.164 (same predicate as 31's
--     *_e164_chk constraints).
--   * voicemail_messages / voicemail_greetings carry (mailbox_id,
--     customer_id) composite FKs to voicemail_boxes (id, customer_id), so the
--     denormalized customer_id (tenant filter + AAD input) can never disagree
--     with the mailbox's owner.
--   * voicemail_boxes.active_greeting_id is a composite FK
--     (active_greeting_id, id) -> voicemail_greetings (id, mailbox_id)
--     ON DELETE SET NULL (active_greeting_id): the active greeting must belong
--     to THIS mailbox (a cross-mailbox greeting would be played to callers of
--     another tenant). Requires PG >= 15 (prod and dev run PG 16).
--   * status='stored' rows must carry every crypto field (a half-written row
--     can never be served).
--
-- LOCKING: every DDL here takes a brief ACCESS EXCLUSIVE lock — on customers
-- and the number_routing view these are ON THE CALL PATH (and the lock is
-- WAL-replayed on every zone replica). lock_timeout makes the migration FAIL
-- FAST instead of queueing call-setup queries behind a long-running reader;
-- if it times out, just re-run it.
--
-- PRODUCTION NOTE: init scripts only run on the first initdb of a fresh data
-- directory. The production primary already exists, so apply MANUALLY on the
-- bare-metal East primary (services VM, 10.142.0.103) as a SUPERUSER; it
-- replicates to every zone replica (the view must exist on the primary
-- before any replica is re-cloned):
--     sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/54_voicemail.sql
-- Apply BEFORE deploying the API build that reads these tables and BEFORE
-- the FreeSWITCH Lua that expects product_type='voicemail' rows. The old API
-- and old Lua tolerate 54 (a 'voicemail' row only appears once a mailbox is
-- created by the new API; the old Lua treats an unknown product_type as a
-- hard reject — never a carrier hairpin).
--
-- Verification (after applying):
--     sudo -u postgres psql -d voip -f /opt/revup/scripts/db/check_migrations.sql
--     sudo -u postgres psql -d voip -c "EXPLAIN SELECT * FROM number_routing WHERE did = '+16174544217';"
--   Expect the three idx_{rcf,api,trunk}_did_lookup scans plus a scan of
--   uq_voicemail_boxes_did_live (or a Seq Scan while voicemail_boxes is tiny).
-- ==========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Entitlement flag.
-- ---------------------------------------------------------------------------
ALTER TABLE customers ADD COLUMN IF NOT EXISTS voicemail_enabled BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 2. did_inventory.product_type CHECK += 'voicemail' (name-agnostic swap).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    con          RECORD;
    have_target  BOOLEAN;
    n_checks     INT;
BEGIN
    SELECT count(*),
           bool_or(c.conname = 'did_inventory_product_type_check'
                   AND pg_get_constraintdef(c.oid) LIKE '%''voicemail''%')
      INTO n_checks, have_target
      FROM pg_constraint c
     WHERE c.conrelid = 'did_inventory'::regclass
       AND c.contype = 'c'
       AND (SELECT array_agg(a.attname ORDER BY a.attname)
              FROM unnest(c.conkey) AS k
              JOIN pg_attribute a
                ON a.attrelid = c.conrelid AND a.attnum = k
           ) = ARRAY['product_type'::name];

    IF n_checks = 1 AND have_target THEN
        RETURN;  -- already migrated: no lock, no revalidation
    END IF;

    FOR con IN
        SELECT c.conname
          FROM pg_constraint c
         WHERE c.conrelid = 'did_inventory'::regclass
           AND c.contype = 'c'
           AND (SELECT array_agg(a.attname ORDER BY a.attname)
                  FROM unnest(c.conkey) AS k
                  JOIN pg_attribute a
                    ON a.attrelid = c.conrelid AND a.attnum = k
               ) = ARRAY['product_type'::name]
    LOOP
        EXECUTE format('ALTER TABLE did_inventory DROP CONSTRAINT %I', con.conname);
    END LOOP;

    -- Every value the old CHECK admitted is kept ('ucaas' included — rows
    -- may exist on long-lived databases), so revalidation cannot fail.
    EXECUTE $ck$
        ALTER TABLE did_inventory
            ADD CONSTRAINT did_inventory_product_type_check
            CHECK (product_type IN ('rcf', 'trunk', 'api', 'ucaas', 'voicemail'))
    $ck$;
END $$;

-- ---------------------------------------------------------------------------
-- 3a. voicemail_customer_keys — one KEK per customer, PERSISTED (defect 11).
--     gcpkms: key_ref = projects/../keyRings/../cryptoKeys/vm-cust-<id>
--     local : key_ref = 'local:<id>' (dev/CI only; refused in production)
--     ON DELETE RESTRICT: a customer that ever held voicemail keeps its key
--     row (crypto-erase marks it 'destroyed'; it is never deleted).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voicemail_customer_keys (
    customer_id     INT PRIMARY KEY REFERENCES customers(id) ON DELETE RESTRICT,
    provider        VARCHAR(16) NOT NULL CHECK (provider IN ('gcpkms', 'local')),
    key_ref         TEXT NOT NULL,
    status          VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'destroyed')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    destroyed_at    TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- 3b. voicemail_boxes — the mailbox (v1: dedicated DID, D6).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voicemail_boxes (
    id                   SERIAL PRIMARY KEY,
    customer_id          INT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    did                  VARCHAR(20) NOT NULL,         -- E.164 +1NXXNXXXXXX
    label                VARCHAR(120) NOT NULL DEFAULT 'Voicemail',
    status               VARCHAR(16) NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'suspended', 'deleted')),
    timezone             VARCHAR(64) NOT NULL DEFAULT 'America/New_York',
    pin_hash             VARCHAR(255),                 -- bcrypt; NULL = no PIN (D7)
    pin_failed_count     INT NOT NULL DEFAULT 0,
    pin_locked_until     TIMESTAMPTZ,
    greeting_mode        VARCHAR(16) NOT NULL DEFAULT 'standard'
                           CHECK (greeting_mode IN ('standard', 'custom')),
    active_greeting_id   INT,                          -- FK added in 3e
    retention_days       INT NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 1 AND 3650),
    max_message_seconds  INT NOT NULL DEFAULT 300 CHECK (max_message_seconds BETWEEN 10 AND 300),
    max_messages         INT NOT NULL DEFAULT 100,
    max_bytes            BIGINT NOT NULL DEFAULT 524288000,
    created_by           INT REFERENCES users(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at           TIMESTAMPTZ,
    CONSTRAINT voicemail_boxes_did_e164_chk CHECK (did ~ '^\+[1-9]\d{1,14}$'),
    -- Target of the composite tenant-consistency FKs below.
    CONSTRAINT voicemail_boxes_id_customer_key UNIQUE (id, customer_id)
);

-- A live DID belongs to at most one mailbox; a deleted mailbox frees its DID.
-- Also the number_routing voicemail arm's point-lookup index (the arm's
-- WHERE status <> 'deleted' implies this predicate).
CREATE UNIQUE INDEX IF NOT EXISTS uq_voicemail_boxes_did_live
    ON voicemail_boxes (did) WHERE status <> 'deleted';
CREATE INDEX IF NOT EXISTS idx_voicemail_boxes_customer
    ON voicemail_boxes (customer_id);

-- ---------------------------------------------------------------------------
-- 3c. voicemail_messages — one row per deposited message (ciphertext in GCS).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voicemail_messages (
    id                BIGSERIAL PRIMARY KEY,
    msg_uuid          UUID NOT NULL UNIQUE,            -- FS-generated; deposit idempotency key
    mailbox_id        INT NOT NULL REFERENCES voicemail_boxes(id) ON DELETE CASCADE,
    customer_id       INT NOT NULL,                    -- denormalized (tenant filter + AAD)
    caller_id_number  VARCHAR(40),
    caller_id_name    VARCHAR(100),
    duration_ms       INT NOT NULL DEFAULT 0,
    size_bytes        INT NOT NULL,                    -- plaintext WAV bytes (quota)
    status            VARCHAR(16) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'stored', 'failed', 'purged')),
    object_key        TEXT,
    ciphertext_crc32c BIGINT,                          -- CRC32C of the stored ciphertext object
    wrapped_dek       BYTEA,
    kek_version       TEXT,                            -- CryptoKeyVersion that wrapped the DEK
    iv                BYTEA,                           -- 12-byte AES-GCM nonce
    enc_algo          VARCHAR(32) NOT NULL DEFAULT 'AES-256-GCM',
    is_read           BOOLEAN NOT NULL DEFAULT false,
    is_saved          BOOLEAN NOT NULL DEFAULT false,
    deleted_at        TIMESTAMPTZ,                     -- trash
    expires_at        TIMESTAMPTZ NOT NULL,            -- created_at + mailbox.retention_days
    call_uuid         VARCHAR(64),
    fs_node           VARCHAR(64),
    zone              VARCHAR(16),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    purged_at         TIMESTAMPTZ,
    -- Deposit lease (API, routers/voicemail.py + services/voicemail/deposit.py):
    -- the attempt that owns a 'pending' row stamps its own fencing token and a
    -- lease expiry. A retry of the same msg_uuid may take the row over only
    -- after the lease expired (or the row is 'failed'), and the finalising
    -- UPDATE matches the token — so two attempts can never both seal, and a
    -- timed-out attempt's late upload can never land after a takeover's.
    deposit_attempt_id  UUID,
    deposit_lease_until TIMESTAMPTZ,
    CONSTRAINT voicemail_messages_box_customer_fk
        FOREIGN KEY (mailbox_id, customer_id)
        REFERENCES voicemail_boxes (id, customer_id) ON DELETE CASCADE,
    CONSTRAINT voicemail_messages_stored_complete_chk CHECK (
        status <> 'stored'
        OR (object_key IS NOT NULL AND ciphertext_crc32c IS NOT NULL
            AND wrapped_dek IS NOT NULL AND kek_version IS NOT NULL
            AND iv IS NOT NULL)),
    CONSTRAINT voicemail_messages_iv_len_chk CHECK (iv IS NULL OR octet_length(iv) = 12)
);

-- Contract indexes: folder listing / counts / quota, and the retention scan.
CREATE INDEX IF NOT EXISTS idx_vm_messages_mailbox_created
    ON voicemail_messages (mailbox_id, created_at DESC) WHERE status = 'stored';
CREATE INDEX IF NOT EXISTS idx_vm_messages_expires
    ON voicemail_messages (expires_at) WHERE status = 'stored';
-- Retention worker helpers: trash older than 30 d, and the orphan sweep of
-- pending/failed rows (both would otherwise be full scans every 15 min).
CREATE INDEX IF NOT EXISTS idx_vm_messages_trash
    ON voicemail_messages (deleted_at) WHERE status = 'stored' AND deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vm_messages_unfinished
    ON voicemail_messages (created_at) WHERE status IN ('pending', 'failed');
-- Every not-yet-purged row of a mailbox (any status): mailbox delete, the
-- crypto-erase purge and the retention arm for deleted mailboxes / destroyed
-- keys. The stored-only index above cannot serve pending/failed rows.
CREATE INDEX IF NOT EXISTS idx_vm_messages_live_mailbox
    ON voicemail_messages (mailbox_id) WHERE status <> 'purged';

-- Columns added to voicemail_messages after the table shape above was first
-- drafted (dev databases may hold an earlier 54): idempotent no-ops otherwise.
ALTER TABLE voicemail_messages ADD COLUMN IF NOT EXISTS deposit_attempt_id UUID;
ALTER TABLE voicemail_messages ADD COLUMN IF NOT EXISTS deposit_lease_until TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 3d. voicemail_greetings — custom greetings (ciphertext in GCS).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voicemail_greetings (
    id                SERIAL PRIMARY KEY,
    greeting_uuid     UUID NOT NULL UNIQUE,
    mailbox_id        INT NOT NULL REFERENCES voicemail_boxes(id) ON DELETE CASCADE,
    customer_id       INT NOT NULL,
    label             VARCHAR(120) NOT NULL DEFAULT 'Greeting',
    duration_ms       INT NOT NULL DEFAULT 0,
    size_bytes        INT NOT NULL,
    status            VARCHAR(16) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'stored', 'failed', 'purged')),
    object_key        TEXT,
    ciphertext_crc32c BIGINT,
    wrapped_dek       BYTEA,
    kek_version       TEXT,
    iv                BYTEA,
    enc_algo          VARCHAR(32) NOT NULL DEFAULT 'AES-256-GCM',
    created_by        INT REFERENCES users(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT voicemail_greetings_box_customer_fk
        FOREIGN KEY (mailbox_id, customer_id)
        REFERENCES voicemail_boxes (id, customer_id) ON DELETE CASCADE,
    -- Target of voicemail_boxes_active_greeting_fk (same-mailbox guarantee).
    CONSTRAINT voicemail_greetings_id_mailbox_key UNIQUE (id, mailbox_id),
    CONSTRAINT voicemail_greetings_stored_complete_chk CHECK (
        status <> 'stored'
        OR (object_key IS NOT NULL AND ciphertext_crc32c IS NOT NULL
            AND wrapped_dek IS NOT NULL AND kek_version IS NOT NULL
            AND iv IS NOT NULL)),
    CONSTRAINT voicemail_greetings_iv_len_chk CHECK (iv IS NULL OR octet_length(iv) = 12)
);

CREATE INDEX IF NOT EXISTS idx_vm_greetings_mailbox
    ON voicemail_greetings (mailbox_id);

-- ---------------------------------------------------------------------------
-- 3e. voicemail_boxes.active_greeting_id -> a greeting OF THIS MAILBOX.
--     Deleting the greeting nulls ONLY active_greeting_id (PG >= 15 syntax).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'voicemail_boxes'::regclass
           AND conname = 'voicemail_boxes_active_greeting_fk'
    ) THEN
        ALTER TABLE voicemail_boxes
            ADD CONSTRAINT voicemail_boxes_active_greeting_fk
            FOREIGN KEY (active_greeting_id, id)
            REFERENCES voicemail_greetings (id, mailbox_id)
            ON DELETE SET NULL (active_greeting_id);
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3f. voicemail_access_log — append-only audit. NO FKs: it must survive
--     purge, mailbox delete and crypto-erase. The api role may only INSERT
--     and SELECT (grants below); nothing in the product updates/deletes it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voicemail_access_log (
    id             BIGSERIAL PRIMARY KEY,
    customer_id    INT,
    mailbox_id     INT,
    message_id     BIGINT,
    greeting_id    INT,
    action         VARCHAR(40) NOT NULL,
    actor_user_id  INT,
    source         VARCHAR(16) NOT NULL,   -- ui | freeswitch | system | admin
    ip_address     VARCHAR(64),
    user_agent     VARCHAR(255),
    detail         JSONB,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vm_access_log_customer_created
    ON voicemail_access_log (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vm_access_log_message
    ON voicemail_access_log (message_id) WHERE message_id IS NOT NULL;
-- "Audit once per playback token" across ALL API worker processes (uvicorn
-- runs 4): the router inserts the play/download/greeting_play row with
-- ON CONFLICT ((detail->>'jti')) WHERE <this predicate> DO NOTHING, so the
-- many Range requests of one token (spread over workers) write exactly one
-- row. Needs only INSERT (the api role has no UPDATE on this table).
CREATE UNIQUE INDEX IF NOT EXISTS uq_vm_access_log_playback_jti
    ON voicemail_access_log ((detail->>'jti'))
    WHERE action IN ('play', 'download', 'greeting_play');

-- ---------------------------------------------------------------------------
-- 4. number_routing — 22's three arms VERBATIM + the voicemail arm.
--    Same column list / types / order (CREATE OR REPLACE VIEW refuses any
--    change). Existing grants on the view (freeswitch, api, grafana_ro) are
--    preserved by CREATE OR REPLACE and re-asserted below.
--    Voicemail arm: product_enabled = mailbox active AND customer entitled;
--    a 'deleted' mailbox is filtered out so its DID is "not ours" again
--    (0 rows -> carrier path), while 'suspended' / entitlement off keeps the
--    row with product_enabled=false -> FS hard-rejects 603.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW number_routing AS
    -- ---- RCF ------------------------------------------------------------
    SELECT
        r.did                          AS did,
        'rcf'::varchar(20)             AS product_type,
        r.customer_id                  AS customer_id,
        r.id                           AS product_ref_id,
        r.enabled                      AS product_enabled,
        c.status                       AS customer_status,
        r.forward_to                   AS forward_to,
        r.pass_caller_id               AS pass_caller_id,
        r.ring_timeout                 AS ring_timeout,
        r.max_channels                 AS max_channels,
        r.name                         AS product_name,
        NULL::varchar(512)             AS voice_url,
        NULL::varchar(512)             AS fallback_url,
        NULL::int                      AS trunk_id
    FROM rcf_numbers r
    JOIN customers c ON c.id = r.customer_id

    UNION ALL

    -- ---- API DID --------------------------------------------------------
    SELECT
        a.did                          AS did,
        'api'::varchar(20)             AS product_type,
        a.customer_id                  AS customer_id,
        a.id                           AS product_ref_id,
        a.enabled                      AS product_enabled,
        c.status                       AS customer_status,
        NULL::varchar(20)              AS forward_to,
        NULL::boolean                  AS pass_caller_id,
        NULL::int                      AS ring_timeout,
        NULL::int                      AS max_channels,
        NULL::varchar(100)             AS product_name,
        a.voice_url                    AS voice_url,
        a.fallback_url                 AS fallback_url,
        NULL::int                      AS trunk_id
    FROM api_dids a
    JOIN customers c ON c.id = a.customer_id

    UNION ALL

    -- ---- Trunk DID ------------------------------------------------------
    -- product_enabled comes from sip_trunks.enabled (trunk DIDs have no
    -- per-DID enable flag); max_channels / product_name also come from the
    -- parent trunk. customer_id resolves via the trunk.
    SELECT
        td.did                         AS did,
        'trunk'::varchar(20)           AS product_type,
        t.customer_id                  AS customer_id,
        td.id                          AS product_ref_id,
        t.enabled                      AS product_enabled,
        c.status                       AS customer_status,
        NULL::varchar(20)              AS forward_to,
        NULL::boolean                  AS pass_caller_id,
        NULL::int                      AS ring_timeout,
        t.max_channels                 AS max_channels,
        t.trunk_name                   AS product_name,
        NULL::varchar(512)             AS voice_url,
        NULL::varchar(512)             AS fallback_url,
        td.trunk_id                    AS trunk_id
    FROM trunk_dids td
    JOIN sip_trunks t ON t.id = td.trunk_id
    JOIN customers c ON c.id = t.customer_id

    UNION ALL

    -- ---- Voicemail mailbox DID (54) ---------------------------------------
    -- product_ref_id = voicemail_boxes.id (the mailbox id FS hands the API).
    SELECT
        b.did                          AS did,
        'voicemail'::varchar(20)       AS product_type,
        b.customer_id                  AS customer_id,
        b.id                           AS product_ref_id,
        (b.status = 'active' AND c.voicemail_enabled) AS product_enabled,
        c.status                       AS customer_status,
        NULL::varchar(20)              AS forward_to,
        NULL::boolean                  AS pass_caller_id,
        NULL::int                      AS ring_timeout,
        NULL::int                      AS max_channels,
        b.label::varchar(100)          AS product_name,
        NULL::varchar(512)             AS voice_url,
        NULL::varchar(512)             AS fallback_url,
        NULL::int                      AS trunk_id
    FROM voicemail_boxes b
    JOIN customers c ON c.id = b.customer_id
    WHERE b.status <> 'deleted';

-- ---------------------------------------------------------------------------
-- 5. Grants (role-guarded: an unguarded GRANT aborts the whole migration on
--    a cluster that lacks the role — see 47's header).
-- ---------------------------------------------------------------------------
REVOKE ALL ON voicemail_customer_keys, voicemail_boxes, voicemail_messages,
              voicemail_greetings, voicemail_access_log FROM PUBLIC;

DO $$
DECLARE
    r TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api') THEN
        GRANT ALL ON voicemail_customer_keys, voicemail_boxes, voicemail_messages,
                     voicemail_greetings TO api;
        -- Append-only audit: INSERT + SELECT, nothing else (re-asserted on
        -- every run in case someone granted more by hand).
        REVOKE ALL ON voicemail_access_log FROM api;
        GRANT SELECT, INSERT ON voicemail_access_log TO api;
        GRANT USAGE, SELECT ON SEQUENCE voicemail_boxes_id_seq, voicemail_messages_id_seq,
                                        voicemail_greetings_id_seq, voicemail_access_log_id_seq TO api;
        GRANT SELECT ON number_routing TO api;
    END IF;

    -- No direct access for the call-path role or the (anonymous) NOC Grafana
    -- role; undo 24's ALTER DEFAULT PRIVILEGES for these tables.
    FOREACH r IN ARRAY ARRAY['freeswitch', 'grafana_ro'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format(
                'REVOKE ALL ON voicemail_customer_keys, voicemail_boxes, voicemail_messages, '
                'voicemail_greetings, voicemail_access_log FROM %I', r);
            EXECUTE format(
                'REVOKE ALL ON SEQUENCE voicemail_boxes_id_seq, voicemail_messages_id_seq, '
                'voicemail_greetings_id_seq, voicemail_access_log_id_seq FROM %I', r);
        END IF;
    END LOOP;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freeswitch') THEN
        GRANT SELECT ON number_routing TO freeswitch;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. rate_cdr(): voicemail CDRs rate to ZERO (decision D5 — no voicemail
--    billing in v1). FreeSWITCH writes product_type='voicemail',
--    direction='inbound', customer_id = mailbox owner for a call answered by
--    a mailbox; without this clause rate_cdr() would charge it like any
--    inbound minute and debit customers.balance.
--    The LATEST definition is 05_schema_cdr.sql (no later migration
--    redefined it — 23/28/29/37/38 only mention it). This is that function
--    BYTE-FOR-BYTE plus the v_product_type declaration and the block between
--    the '>>> 54_voicemail.sql' / '<<< 54_voicemail.sql' markers
--    (tests/test_voicemail_billing.py strips exactly those and compares).
--    plpgsql resolves cdrs/customers/get_rate at CALL time, so this also
--    applies on a scratch DB without the cdrs hypertable. CREATE OR REPLACE
--    keeps 05's EXECUTE grant; it is re-asserted (role-guarded) anyway.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rate_cdr(p_uuid VARCHAR(64))
RETURNS DECIMAL
LANGUAGE plpgsql
AS $$
DECLARE
    v_customer_id INT;
    v_direction VARCHAR;
    v_destination VARCHAR;
    v_duration_ms INT;
    v_rate_table_id INT;
    v_rate DECIMAL;
    v_cost DECIMAL;
    v_carrier_cost DECIMAL;
    v_connection_fee DECIMAL;
    v_min_duration INT;
    v_increment INT;
    v_billable_ms INT;
    v_total_cost DECIMAL;
    v_product_type VARCHAR;  -- 54_voicemail.sql (D5)
BEGIN
    -- Get CDR details
    SELECT customer_id, direction, destination, duration_ms
    INTO v_customer_id, v_direction, v_destination, v_duration_ms
    FROM cdrs WHERE uuid = p_uuid AND rated_at IS NULL;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    -- >>> 54_voicemail.sql (decision D5 — no voicemail billing in v1) >>>
    -- A voicemail CDR (product_type='voicemail', written by FreeSWITCH for a
    -- call answered by a mailbox) is marked rated at ZERO and never touches
    -- the customer balance. Returns 0 (not NULL: NULL means 'not found or
    -- already rated' to POST /v1/cdrs/{uuid}/rate).
    SELECT product_type INTO v_product_type
    FROM cdrs WHERE uuid = p_uuid AND rated_at IS NULL LIMIT 1;
    IF v_product_type = 'voicemail' THEN
        UPDATE cdrs
        SET billable_ms = 0,
            rate_per_min = 0,
            total_cost = 0,
            carrier_cost = 0,
            margin = 0,
            rated_at = NOW()
        WHERE uuid = p_uuid;
        RETURN 0;
    END IF;
    -- <<< 54_voicemail.sql <<<

    -- Get rate table
    SELECT CASE WHEN v_direction = 'inbound' THEN inbound_rate_table_id ELSE outbound_rate_table_id END
    INTO v_rate_table_id
    FROM customer_rate_assignments WHERE customer_id = v_customer_id;

    -- Default rate table if not assigned
    v_rate_table_id := COALESCE(v_rate_table_id, 1);

    -- Get rate
    SELECT rate_per_min, cost_per_min, connection_fee, min_duration, increment
    INTO v_rate, v_cost, v_connection_fee, v_min_duration, v_increment
    FROM get_rate(v_rate_table_id, v_destination);

    -- Default rate if no match
    v_rate := COALESCE(v_rate, 0.01);
    v_connection_fee := COALESCE(v_connection_fee, 0);
    v_min_duration := COALESCE(v_min_duration, 0) * 1000;  -- Convert to ms
    v_increment := COALESCE(v_increment, 6) * 1000;        -- Convert to ms

    -- Calculate billable duration
    v_billable_ms := GREATEST(v_duration_ms, v_min_duration);
    v_billable_ms := CEIL(v_billable_ms::DECIMAL / v_increment) * v_increment;

    -- Calculate cost
    v_total_cost := v_connection_fee + (v_billable_ms / 60000.0 * v_rate);

    -- Calculate carrier cost and margin
    v_carrier_cost := v_billable_ms / 60000.0 * COALESCE(v_cost, 0);

    -- Update CDR
    UPDATE cdrs
    SET billable_ms = v_billable_ms,
        rate_per_min = v_rate,
        total_cost = v_total_cost,
        carrier_cost = v_carrier_cost,
        margin = v_total_cost - v_carrier_cost,
        rated_at = NOW()
    WHERE uuid = p_uuid;

    -- Update customer balance
    UPDATE customers
    SET balance = balance - v_total_cost
    WHERE id = v_customer_id;

    RETURN v_total_cost;
END;
$$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api') THEN
        GRANT EXECUTE ON FUNCTION rate_cdr(VARCHAR) TO api;
    END IF;
END $$;

COMMIT;
