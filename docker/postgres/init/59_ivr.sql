-- ==========================================================================
-- 59_ivr.sql
-- Visual IVR v1 — entitlement, flows + immutable versions, IVR numbers,
-- content-addressed prompt audio, the number_routing 'ivr' arm, FreeSWITCH's
-- read view, and rate_cdr() rating IVR to zero.
--
-- Contract: docs/IVR_INTERFACES.md §1 (plan of record:
-- docs/IVR_PRODUCT_PLAN.md §4). No price/plan seeds (decision D6).
--
-- WHAT THIS DOES (one transaction, idempotent — re-running is a no-op):
--   1. customers.ivr_enabled BOOLEAN NOT NULL DEFAULT false (metadata-only
--      ADD COLUMN on PG >= 11; no table rewrite).
--   2. did_inventory.product_type CHECK gains 'ivr' — the same name-agnostic
--      swap as 54 (every CHECK whose constrained column set is exactly
--      {product_type} is dropped and re-added as the NAMED
--      did_inventory_product_type_check). Skipped when the canonical
--      constraint already admits 'ivr' (a re-run takes no lock).
--   3. Tables call_flows / call_flow_versions / ivr_numbers / ivr_prompts /
--      ivr_prompt_audio + indexes + the call_flows.published_version_id FK
--      (added after both tables exist).
--   4. number_routing: CREATE OR REPLACE with 54's four arms (rcf, api,
--      trunk, voicemail) BYTE-IDENTICAL plus a 5th 'ivr' arm
--      (product_enabled = number enabled AND customer entitled AND flow
--      published). No migration after 54 redefined the view.
--   5. View ivr_fs_number — FreeSWITCH's ONLY IVR read path (one row per
--      IVR DID: entitlement/status, flow id + version, the plan as text).
--   6. Grants: api = ALL on the new tables + their sequences + SELECT on the
--      views. freeswitch = SELECT on ivr_fs_number and ivr_prompt_audio ONLY
--      (plus number_routing, re-asserted). grafana_ro and PUBLIC get NOTHING
--      on the new tables/views. NOTE: 24_grafana_ro.sql set ALTER DEFAULT
--      PRIVILEGES ... GRANT SELECT ON TABLES TO grafana_ro, so every table the
--      superuser creates would otherwise be readable by the anonymous NOC
--      Grafana — the REVOKE below is load-bearing (same as 54).
--   7. rate_cdr(): 54's definition BYTE-FOR-BYTE plus an 'ivr' clause — an
--      IVR CDR (A-leg or transfer B-leg, product_type='ivr') rates to ZERO and
--      never debits the balance (decision D6, the voicemail D5 precedent).
--
-- Guards beyond the contract column list (all additive, documented in
-- docs/IVR_INTERFACES.md "Changes"):
--   * ivr_numbers.did must be canonical E.164 (same predicate as 31/54).
--   * ivr_numbers (flow_id, customer_id) -> call_flows (id, customer_id)
--     ON DELETE SET NULL (flow_id): a number can only ever be bound to a flow
--     of ITS OWN customer (the unified build let a tenant repoint another
--     tenant's DID). Requires PG >= 15 (prod and dev run PG 16).
--   * call_flows (published_version_id, id) -> call_flow_versions (id,
--     flow_id): a flow can only publish ITS OWN version — ivr_fs_number can
--     never serve another flow's (another tenant's) plan.
--   * call_flow_versions is immutable: a BEFORE UPDATE trigger refuses every
--     UPDATE (rows are only ever inserted, or deleted with their flow).
--   * ivr_prompts.sha256 REFERENCES ivr_prompt_audio — a prompt can never
--     point at audio that is not there, and audio garbage collection can
--     never delete audio a prompt row still uses.
--   * sha256 columns are lowercase hex; audio is bounded (<= 120 s at 8 kHz
--     PCM16 + a 44-byte header) and `bytes` = octet_length(wav).
--   * ivr_numbers.id / product_ref_id: ivr_numbers.id is BIGSERIAL (contract)
--     but number_routing.product_ref_id is INT (22's rcf arm) — CREATE OR
--     REPLACE VIEW refuses a type change, so the arm casts n.id::int.
--
-- LOCKING: every DDL here takes a brief ACCESS EXCLUSIVE lock — on customers
-- and the number_routing view these are ON THE CALL PATH (and the lock is
-- WAL-replayed on every zone replica). lock_timeout makes the migration FAIL
-- FAST instead of queueing call-setup queries behind a long-running reader;
-- if it times out, just re-run it.
--
-- SAFETY FOR AN OLD FREESWITCH (pre-IVR Lua): an 'ivr' row only appears once
-- TED assigns the first IVR number (POST /v1/numbers/{did}/assign with
-- product_type 'ivr'); the FS runtime with IVR_ENABLED (default off) deploys
-- before that, and an old Lua treats an unknown product_type as a hard
-- reject — never a carrier hairpin.
--
-- PRODUCTION NOTE: init scripts only run on the first initdb of a fresh data
-- directory. The production primary already exists, so apply MANUALLY on the
-- bare-metal East primary (services VM, 10.142.0.103) as a SUPERUSER; it
-- replicates to every zone replica. Requires 54 (the voicemail arm) — refuses
-- to run without it. Apply BEFORE 60 and BEFORE the API build that reads
-- these tables:
--     hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/59_ivr.sql
--
-- Verification (after applying):
--     sudo -u postgres psql -d voip -f /opt/revup/scripts/db/check_migrations.sql
--     sudo -u postgres psql -d voip -c "EXPLAIN SELECT * FROM number_routing WHERE did = '+16174544217';"
--   Expect the idx_{rcf,api,trunk}_did_lookup scans, uq_voicemail_boxes_did_live
--   and ivr_numbers_did_key (or Seq Scans while the new tables are tiny).
-- ==========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- 59 rebuilds the number_routing view on top of 54's voicemail arm.
DO $$
BEGIN
    IF to_regclass('public.voicemail_boxes') IS NULL THEN
        RAISE EXCEPTION '59_ivr.sql requires 54_voicemail.sql (voicemail_boxes is missing) — apply 54 first';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Entitlement flag (D1: IVR is its own product, like voicemail_enabled).
-- ---------------------------------------------------------------------------
ALTER TABLE customers ADD COLUMN IF NOT EXISTS ivr_enabled BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 2. did_inventory.product_type CHECK += 'ivr' (name-agnostic swap, as 54).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    con          RECORD;
    have_target  BOOLEAN;
    n_checks     INT;
BEGIN
    SELECT count(*),
           bool_or(c.conname = 'did_inventory_product_type_check'
                   AND pg_get_constraintdef(c.oid) LIKE '%''ivr''%')
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

    -- Every value 54's CHECK admitted is kept, so revalidation cannot fail.
    EXECUTE $ck$
        ALTER TABLE did_inventory
            ADD CONSTRAINT did_inventory_product_type_check
            CHECK (product_type IN ('rcf', 'trunk', 'api', 'ucaas', 'voicemail', 'ivr'))
    $ck$;
END $$;

-- ---------------------------------------------------------------------------
-- 3a. call_flows — one editable draft per flow (product-agnostic seam, D10).
--     draft_graph = the UI graph (contract §2), stored verbatim (unknown
--     fields round-trip). revision = optimistic lock, +1 per draft write.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS call_flows (
    id                   BIGSERIAL PRIMARY KEY,
    customer_id          INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    product              VARCHAR(20) NOT NULL DEFAULT 'ivr' CHECK (product IN ('ivr')),
    name                 VARCHAR(100) NOT NULL,
    draft_graph          JSONB NOT NULL,
    revision             INT NOT NULL DEFAULT 1,
    published_version_id BIGINT NULL,                  -- FK added in 3c
    created_by           INT NULL,
    updated_by           INT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Target of the same-customer FK from ivr_numbers (3d).
    CONSTRAINT call_flows_id_customer_key UNIQUE (id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_call_flows_customer ON call_flows (customer_id);

-- ---------------------------------------------------------------------------
-- 3b. call_flow_versions — immutable published versions. plan = the compiled
--     state machine FreeSWITCH executes (contract §3; written ONLY by the
--     server compiler, services/ivr/compiler.py).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS call_flow_versions (
    id               BIGSERIAL PRIMARY KEY,
    flow_id          BIGINT NOT NULL REFERENCES call_flows(id) ON DELETE CASCADE,
    version          INT NOT NULL CHECK (version >= 1),
    graph            JSONB NOT NULL,
    plan             JSONB NOT NULL,
    compiler_version VARCHAR(20) NOT NULL,
    published_by     INT NULL,
    published_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (flow_id, version),
    -- Target of the same-flow FK from call_flows.published_version_id (3c).
    CONSTRAINT call_flow_versions_id_flow_key UNIQUE (id, flow_id)
);

-- Immutable once inserted: every UPDATE is refused (DELETE only happens via
-- the flow's ON DELETE CASCADE).
CREATE OR REPLACE FUNCTION call_flow_versions_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'call_flow_versions rows are immutable (version % of flow %)',
        OLD.version, OLD.flow_id;
END;
$$;

CREATE OR REPLACE TRIGGER trg_call_flow_versions_immutable
    BEFORE UPDATE ON call_flow_versions
    FOR EACH ROW EXECUTE FUNCTION call_flow_versions_immutable();

-- ---------------------------------------------------------------------------
-- 3c. call_flows.published_version_id -> a version OF THIS FLOW.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'call_flows'::regclass
           AND conname = 'call_flows_published_version_fk'
    ) THEN
        ALTER TABLE call_flows
            ADD CONSTRAINT call_flows_published_version_fk
            FOREIGN KEY (published_version_id, id)
            REFERENCES call_flow_versions (id, flow_id);
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3d. ivr_numbers — one row per IVR DID (created by number_inventory assign
--     with product_type 'ivr'; deleted by unassign). enabled = the admin kill
--     switch (TED); max_channels = per-number concurrent-call cap (FS limit).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ivr_numbers (
    id           BIGSERIAL PRIMARY KEY,
    customer_id  INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    did          VARCHAR(20) NOT NULL UNIQUE,
    name         VARCHAR(100) NULL,
    flow_id      BIGINT NULL REFERENCES call_flows(id) ON DELETE SET NULL,
    enabled      BOOLEAN NOT NULL DEFAULT true,
    max_channels INT NOT NULL DEFAULT 10 CHECK (max_channels BETWEEN 1 AND 500),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ivr_numbers_did_e164_chk CHECK (did ~ '^\+[1-9]\d{1,14}$')
);

-- The number_routing ivr arm's customer path (customer_numbers.owned_numbers_sql
-- pushes customer_id = $1 into every arm; see 57) and the "numbers bound to
-- this flow" lookups (flow delete 409, publish self-transfer check, FK SET NULL).
-- The FS point lookup by did rides the UNIQUE constraint's index.
CREATE INDEX IF NOT EXISTS idx_ivr_numbers_customer ON ivr_numbers (customer_id);
CREATE INDEX IF NOT EXISTS idx_ivr_numbers_flow ON ivr_numbers (flow_id) WHERE flow_id IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'ivr_numbers'::regclass
           AND conname = 'ivr_numbers_flow_same_customer_fk'
    ) THEN
        ALTER TABLE ivr_numbers
            ADD CONSTRAINT ivr_numbers_flow_same_customer_fk
            FOREIGN KEY (flow_id, customer_id)
            REFERENCES call_flows (id, customer_id)
            ON DELETE SET NULL (flow_id);
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3e. ivr_prompt_audio — content-addressed, shared across customers,
--     immutable. sha256 = lowercase hex of the EXACT stored bytes (canonical
--     RIFF/WAVE PCM16 LE mono 8000 Hz, contract §4). FreeSWITCH fetches by
--     sha from its LOCAL replica on a cache miss.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ivr_prompt_audio (
    sha256     CHAR(64) PRIMARY KEY,
    wav        BYTEA NOT NULL,
    bytes      INT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ivr_prompt_audio_sha_chk CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ivr_prompt_audio_bytes_chk CHECK (
        bytes = octet_length(wav) AND bytes BETWEEN 46 AND 1920044)
);

-- ---------------------------------------------------------------------------
-- 3f. ivr_prompts — a customer's named prompt (TTS text, upload or browser
--     recording) -> its audio by sha. Soft-deleted when a published version
--     still plays it (the audio is kept).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ivr_prompts (
    id          BIGSERIAL PRIMARY KEY,
    customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    name        VARCHAR(100) NOT NULL,
    kind        VARCHAR(10) NOT NULL CHECK (kind IN ('tts', 'upload', 'recording')),
    tts_text    TEXT NULL,
    tts_voice   VARCHAR(40) NULL,
    sha256      CHAR(64) NOT NULL REFERENCES ivr_prompt_audio(sha256),
    duration_ms INT NOT NULL CHECK (duration_ms BETWEEN 1 AND 120000),
    bytes       INT NOT NULL CHECK (bytes > 0),
    deleted_at  TIMESTAMPTZ NULL,
    created_by  INT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ivr_prompts_tts_fields_chk CHECK (
        (kind = 'tts') = (tts_text IS NOT NULL AND tts_voice IS NOT NULL)),
    CONSTRAINT ivr_prompts_tts_text_len_chk CHECK (
        tts_text IS NULL OR char_length(tts_text) BETWEEN 1 AND 1000)
);

CREATE INDEX IF NOT EXISTS idx_ivr_prompts_customer_live
    ON ivr_prompts (customer_id) WHERE deleted_at IS NULL;
-- Audio garbage collection + the FK's referencing-row checks.
CREATE INDEX IF NOT EXISTS idx_ivr_prompts_sha ON ivr_prompts (sha256);

-- ---------------------------------------------------------------------------
-- 4. number_routing — 54's four arms VERBATIM + the ivr arm.
--    Same column list / types / order (CREATE OR REPLACE VIEW refuses any
--    change). Existing grants on the view (freeswitch, api, grafana_ro) are
--    preserved by CREATE OR REPLACE and re-asserted below.
--    IVR arm: product_enabled = number enabled AND customer entitled AND a
--    published flow bound; customer_status as every other arm (the resolver
--    applies it). product_name = the IVR number's name (customer-set label,
--    shown back to the same customer only).
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
    WHERE b.status <> 'deleted'

    UNION ALL

    -- ---- IVR number DID (59) ----------------------------------------------
    -- product_ref_id = ivr_numbers.id (cast: the view column is INT).
    SELECT
        n.did                          AS did,
        'ivr'::varchar(20)             AS product_type,
        n.customer_id                  AS customer_id,
        n.id::int                      AS product_ref_id,
        (n.enabled AND c.ivr_enabled AND f.published_version_id IS NOT NULL) AS product_enabled,
        c.status                       AS customer_status,
        NULL::varchar(20)              AS forward_to,
        NULL::boolean                  AS pass_caller_id,
        NULL::int                      AS ring_timeout,
        n.max_channels                 AS max_channels,
        n.name::varchar(100)           AS product_name,
        NULL::varchar(512)             AS voice_url,
        NULL::varchar(512)             AS fallback_url,
        NULL::int                      AS trunk_id
    FROM ivr_numbers n
    JOIN customers c ON c.id = n.customer_id
    LEFT JOIN call_flows f ON f.id = n.flow_id;

-- ---------------------------------------------------------------------------
-- 5. ivr_fs_number — FreeSWITCH's ONLY read path for IVR (contract §1.1):
--    exactly one row per IVR DID. enabled = number on AND customer entitled
--    AND customer active ('active' is the only live value of
--    customers.status, 02's CHECK: active | suspended | closed — the same
--    value the FS resolver treats as live for every other arm). A NULL
--    plan_json (no flow / never published) => FS 603. Runs with the view
--    owner's rights: freeswitch needs no grant on the underlying tables.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW ivr_fs_number AS
SELECT n.did, n.id AS ivr_number_id, n.customer_id, n.max_channels,
       (n.enabled AND c.ivr_enabled AND c.status = 'active') AS enabled,
       f.id AS flow_id, v.version AS flow_version, v.plan::text AS plan_json
FROM ivr_numbers n
JOIN customers c ON c.id = n.customer_id
LEFT JOIN call_flows f ON f.id = n.flow_id
LEFT JOIN call_flow_versions v ON v.id = f.published_version_id;

-- ---------------------------------------------------------------------------
-- 6. Grants (role-guarded: an unguarded GRANT aborts the whole migration on
--    a cluster that lacks the role — see 47's header).
-- ---------------------------------------------------------------------------
REVOKE ALL ON call_flows, call_flow_versions, ivr_numbers, ivr_prompts,
              ivr_prompt_audio, ivr_fs_number FROM PUBLIC;

DO $$
DECLARE
    r TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api') THEN
        GRANT ALL ON call_flows, call_flow_versions, ivr_numbers, ivr_prompts,
                     ivr_prompt_audio TO api;
        GRANT USAGE, SELECT ON SEQUENCE call_flows_id_seq, call_flow_versions_id_seq,
                                        ivr_numbers_id_seq, ivr_prompts_id_seq TO api;
        GRANT SELECT ON number_routing, ivr_fs_number TO api;
    END IF;

    -- No direct table access for the call-path role or the (anonymous) NOC
    -- Grafana role; undo 24's ALTER DEFAULT PRIVILEGES for these objects.
    FOREACH r IN ARRAY ARRAY['freeswitch', 'grafana_ro'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format(
                'REVOKE ALL ON call_flows, call_flow_versions, ivr_numbers, ivr_prompts, '
                'ivr_prompt_audio, ivr_fs_number FROM %I', r);
            EXECUTE format(
                'REVOKE ALL ON SEQUENCE call_flows_id_seq, call_flow_versions_id_seq, '
                'ivr_numbers_id_seq, ivr_prompts_id_seq FROM %I', r);
        END IF;
    END LOOP;

    -- FreeSWITCH: the routing oracle, its IVR view and the prompt audio (by
    -- sha on a cache miss, from the LOCAL replica) — nothing else.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freeswitch') THEN
        GRANT SELECT ON number_routing, ivr_fs_number, ivr_prompt_audio TO freeswitch;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7. rate_cdr(): IVR CDRs rate to ZERO (decision D6 — pricing comes later).
--    FreeSWITCH writes product_type='ivr' on the A-leg of a call an IVR
--    answered and cdr_product_type=ivr on its transfer B-legs; without this
--    clause rate_cdr() would charge them like any minute and debit
--    customers.balance.
--    The LATEST definition is 54_voicemail.sql (05 + the voicemail clause;
--    no migration after 54 redefined it). This is 54's function
--    BYTE-FOR-BYTE plus the block between the '>>> 59_ivr.sql' /
--    '<<< 59_ivr.sql' markers (tests/test_ivr_migration.py strips exactly
--    that block and compares with 54). CREATE OR REPLACE keeps the EXECUTE
--    grant; it is re-asserted (role-guarded) anyway.
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

    -- >>> 59_ivr.sql (decision D6 — IVR rates to zero in v1) >>>
    -- An IVR CDR (product_type='ivr': the A-leg of a call an IVR answered,
    -- and its transfer B-legs) is marked rated at ZERO and never touches the
    -- customer balance — the voicemail treatment above. The legs keep their
    -- own timing/duration columns, so a price can be applied later.
    IF v_product_type = 'ivr' THEN
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
    -- <<< 59_ivr.sql <<<

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
