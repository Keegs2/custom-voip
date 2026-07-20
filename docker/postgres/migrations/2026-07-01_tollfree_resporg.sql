-- Migration: Toll-free / RespOrg data model  (toll_free_numbers + tfn_import_batches)
-- ============================================================================
-- Backs the API-first toll-free RespOrg product (routers/tollfree.py): a
-- carrier-grade toll-free number record with the RespOrg / SMS/800 Customer
-- Record (CR) fields a bulk CR workflow needs, per-TFN inbound carrier steering
-- (Least-Cost Origination), and a batch/job record for idempotent bulk import
-- at scale (the audit benchmark is 100K TFNs / request).
--
-- Why a migration (not init/): init/*.sql only runs on first `initdb`. Existing
-- databases (production services VM + any already-initialized local volume) must
-- get these tables via this file. **Migrations are applied BY HAND** — there is
-- no Alembic/auto-runner yet. Apply this BEFORE deploying the API build that
-- references toll_free_numbers / tfn_import_batches.
--
-- Idempotent: every object uses IF NOT EXISTS / catalog guards, so this file is
-- safe to run repeatedly.
--
-- Apply (production services VM, bare-metal PostgreSQL, DB 'voip'):
--   sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/migrations/2026-07-01_tollfree_resporg.sql
-- Verify:
--   sudo -u postgres psql -d voip -c "\d+ toll_free_numbers" -c "\d+ tfn_import_batches"
-- ============================================================================
BEGIN;

-- --------------------------------------------------------------------------
-- Bulk-import batch / job record. One row per import request; the unique
-- batch_key is the idempotency handle (re-submitting the same key returns the
-- prior batch instead of re-processing). Created BEFORE toll_free_numbers so
-- the latter can FK its provenance column to it.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tfn_import_batches (
    id              BIGSERIAL PRIMARY KEY,
    batch_key       VARCHAR(64) NOT NULL UNIQUE,        -- client idempotency key
    customer_id     INT REFERENCES customers(id) ON DELETE SET NULL,  -- optional default owner
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','running','completed','failed','partial')),
    total           INT NOT NULL DEFAULT 0,             -- input rows received
    processed       INT NOT NULL DEFAULT 0,             -- valid rows processed
    inserted        INT NOT NULL DEFAULT 0,
    updated         INT NOT NULL DEFAULT 0,
    skipped         INT NOT NULL DEFAULT 0,             -- invalid / de-duped input rows
    failed          INT NOT NULL DEFAULT 0,
    errors          JSONB NOT NULL DEFAULT '[]'::jsonb, -- small sample of row-level errors
    created_by      INT REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tfn_batch_key    ON tfn_import_batches(batch_key);
CREATE INDEX IF NOT EXISTS idx_tfn_batch_status ON tfn_import_batches(status);

-- --------------------------------------------------------------------------
-- Toll-free number record. Separate from did_inventory because a TFN carries a
-- RespOrg / CR model that regular geographic DIDs do not. UNIQUE(tfn) is the
-- authoritative double-allocation guard (mirrors did_inventory's UNIQUE(did)).
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS toll_free_numbers (
    id              BIGSERIAL PRIMARY KEY,
    tfn             VARCHAR(20) NOT NULL UNIQUE,        -- E.164 (+18XXNXXXXXX)

    -- Tenant ownership (NULL = unassigned house inventory).
    customer_id     INT REFERENCES customers(id) ON DELETE SET NULL,

    -- Lifecycle / RespOrg record state (SMS/800 record states, condensed).
    status          VARCHAR(20) NOT NULL DEFAULT 'spare'
                        CHECK (status IN ('spare','reserved','assigned','active','suspend',
                                          'disconnect','transitional','unavailable','aging')),

    -- RespOrg / Somos Customer-Record fields.
    resp_org_id         VARCHAR(20),                    -- controlling RespOrg ID (Granite's)
    template_name       VARCHAR(64),                    -- SMS/800 CR template reference
    cr_data             JSONB NOT NULL DEFAULT '{}'::jsonb, -- CR payload: AOS, carrier, LATA, labels
    effective_date      TIMESTAMPTZ,                    -- CR effective date

    -- CR submission workflow (see routers/tollfree.py CR adapter; default-off).
    cr_status           VARCHAR(20) NOT NULL DEFAULT 'none'
                        CHECK (cr_status IN ('none','pending','submitted','confirmed','active','rejected','error')),
    cr_reference        VARCHAR(64),                    -- external Somos/800 order/txn id
    cr_last_submitted_at TIMESTAMPTZ,
    cr_error            TEXT,

    -- Per-TFN inbound carrier steering (Least-Cost Origination) -> carrier_gateways.
    carrier_id      INT REFERENCES carrier_gateways(id) ON DELETE SET NULL,

    -- Metadata / provenance.
    label           VARCHAR(100),
    notes           TEXT,
    import_batch_id BIGINT REFERENCES tfn_import_batches(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hash index for O(1) exact TFN lookup at scale (mirrors idx_did_inv_did).
CREATE INDEX IF NOT EXISTS idx_tfn_lookup    ON toll_free_numbers USING hash(tfn);
-- Tenant filtering (partial: only owned rows).
CREATE INDEX IF NOT EXISTS idx_tfn_customer  ON toll_free_numbers(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tfn_status     ON toll_free_numbers(status);
CREATE INDEX IF NOT EXISTS idx_tfn_cr_status  ON toll_free_numbers(cr_status);
CREATE INDEX IF NOT EXISTS idx_tfn_resporg    ON toll_free_numbers(resp_org_id) WHERE resp_org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tfn_carrier    ON toll_free_numbers(carrier_id)  WHERE carrier_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tfn_batch      ON toll_free_numbers(import_batch_id) WHERE import_batch_id IS NOT NULL;

COMMENT ON TABLE  toll_free_numbers IS
    'Toll-free number inventory with RespOrg/SMS-800 Customer-Record fields and per-TFN inbound carrier steering (LCO). UNIQUE(tfn) is the double-allocation guard.';
COMMENT ON COLUMN toll_free_numbers.carrier_id IS
    'Inbound carrier that terminates this TFN to us (per-TFN LCO steering) -> carrier_gateways.id.';
COMMENT ON COLUMN toll_free_numbers.cr_data IS
    'SMS/800 Customer-Record payload (area-of-service, inter/intra-LATA carrier, template overrides).';

-- --------------------------------------------------------------------------
-- Grants. Match the did_inventory convention: api = ALL, freeswitch = SELECT
-- (the FS call path may look up a TFN for inbound treatment / per-TFN carrier).
-- --------------------------------------------------------------------------
GRANT ALL           ON toll_free_numbers, tfn_import_batches TO api;
GRANT SELECT        ON toll_free_numbers                     TO freeswitch;
GRANT USAGE, SELECT ON toll_free_numbers_id_seq, tfn_import_batches_id_seq TO api;

COMMIT;
