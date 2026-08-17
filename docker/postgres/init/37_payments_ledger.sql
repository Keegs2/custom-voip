-- ==========================================================================
-- 37_payments_ledger.sql
-- Payments foundation — append-only ledger spine + payment tables.
--
-- Ported from the unified branch's Wave-1 payments migration
-- (2026-07-20_payments_ledger.sql) with ONE deliberate scope divergence for
-- RCF-V1 (see below). Creates:
--   1) ledger_entries        — append-only signed money events (immutable)
--   2) payment_methods       — tokenised cards-on-file (NO PAN/CVV — PCI SAQ-A)
--   3) payment_transactions  — provider-agnostic processor-operation records
--   4) auto_recharge_settings— per-customer auto-recharge trigger config
--   5) invoices              — minimal invoice records (plan fees)
--
-- --------------------------------------------------------------------------
-- RCF-V1 SCOPE (deliberate divergence from unified — do NOT "fix" this):
-- --------------------------------------------------------------------------
-- Unified's Wave 1 also REWROTE rate_cdr() to post `usage` ledger entries and
-- rewired add-credit through the ledger. RCF-V1 does NOT: billing here is
-- estimates-only (CDRs export to Equinox) and rate_cdr() / the customers
-- add-credit path are left completely untouched by this migration. The ledger
-- on this branch backs ONLY:
--   * the machine-payments DEMO (PAYMENTS_DEMO_MODE, is_demo customers — see
--     38_payments_demo.sql), and
--   * (next task) per-call x402 charges on the API-calling product.
-- `customers.balance` remains live prod-shaped data for everyone else; the
-- ledger's balance-as-cache invariant (SUM(entries) == balance) holds only for
-- customers whose balance is moved exclusively through post_ledger_entry
-- (demo customers + future API-calling charge flows).
--
-- --------------------------------------------------------------------------
-- MONETARY REPRESENTATION — DECIMAL(12,4) dollars, NOT integer minor units.
-- Matches customers.balance / credit_limit (02_schema_core.sql) exactly.
-- DECIMAL is exact fixed-point (never floats); asyncpg maps it to Python
-- decimal.Decimal. Processor integer-cents / USDC-6-decimals conversions
-- happen at the provider seam, never in the ledger.
--
-- --------------------------------------------------------------------------
-- APPEND-ONLY IS ENFORCED BY PRIVILEGE
-- ledger_entries: the `api` role gets SELECT + INSERT ONLY (no UPDATE, no
-- DELETE) so the application PHYSICALLY cannot mutate or delete a posted
-- entry. The customers.balance cache is updated in the SAME transaction as
-- each INSERT (services/ledger.py post_ledger_entry).
--
-- IDEMPOTENT: CREATE TABLE/INDEX IF NOT EXISTS + re-runnable GRANTs. Safe to
-- re-run on a live database.
--
-- PRODUCTION NOTE: init scripts only run on the first initdb of a fresh data
-- directory. Apply MANUALLY on the bare-metal prod primary (services VM,
-- 10.142.0.103), then let it replicate:
--     sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/init/37_payments_ledger.sql
--
-- Verify afterwards:
--     sudo -u postgres psql -d voip -c "\d ledger_entries"
--     -- append-only proof: api must have SELECT+INSERT but NOT update/delete
--     sudo -u postgres psql -d voip -c "SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee='api' AND table_name='ledger_entries' ORDER BY privilege_type;"
-- ==========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) ledger_entries — the APPEND-ONLY spine. One signed row per money event.
--    Never UPDATEd, never DELETEd (enforced by GRANT below). `balance_after`
--    snapshots the running balance AT THE TIME OF POST for audit + history.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledger_entries (
    id              BIGSERIAL PRIMARY KEY,
    customer_id     INT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    -- Signed: positive = money IN (topup/refund/promo), negative = money OUT
    -- (usage/fee/chargeback). `adjustment` may be either sign.
    amount          DECIMAL(12,4) NOT NULL,
    currency        VARCHAR(3) NOT NULL DEFAULT 'USD',
    entry_type      VARCHAR(20) NOT NULL
                        CHECK (entry_type IN ('topup', 'usage', 'fee', 'refund',
                                              'adjustment', 'promo', 'chargeback')),
    -- Which rail/actor produced the entry.
    source          VARCHAR(20) NOT NULL
                        CHECK (source IN ('stripe_card', 'stripe_crypto',
                                          'stripe_mpp', 'x402', 'admin', 'rating')),
    -- Idempotency: a repeated post with the same key returns the existing row
    -- and does NOT double-apply.
    idempotency_key TEXT NOT NULL UNIQUE,
    -- Processor/on-chain reference (pi_…/spt_…/tx hash), NULL for internal posts.
    external_ref    TEXT,
    -- Running balance immediately AFTER this entry was applied.
    balance_after   DECIMAL(12,4),
    metadata        JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tenant history read: newest-first entries for one customer.
CREATE INDEX IF NOT EXISTS idx_ledger_customer_created
    ON ledger_entries(customer_id, created_at DESC);
-- Reconciliation / external-ref lookups.
CREATE INDEX IF NOT EXISTS idx_ledger_external_ref
    ON ledger_entries(external_ref) WHERE external_ref IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2) payment_methods — tokenised cards-on-file. NO PAN/CVV EVER (PCI SAQ-A):
--    ONLY processor tokens (pm_…/cus_…) + display metadata (brand/last4).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_methods (
    id                   BIGSERIAL PRIMARY KEY,
    customer_id          INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    provider             VARCHAR(20) NOT NULL DEFAULT 'stripe',
    provider_pm_id       TEXT,            -- pm_… (processor token; never a PAN)
    provider_customer_id TEXT,            -- cus_…
    brand                VARCHAR(30),     -- visa / mastercard / … (display only)
    last4                VARCHAR(4),      -- display only — NOT the full PAN
    exp_month            SMALLINT,
    exp_year             SMALLINT,
    is_default           BOOLEAN NOT NULL DEFAULT false,
    status               VARCHAR(20) NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'inactive', 'expired', 'removed')),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_methods_customer
    ON payment_methods(customer_id);
-- At most one default payment method per customer.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_methods_one_default
    ON payment_methods(customer_id) WHERE is_default;

-- ---------------------------------------------------------------------------
-- 3) payment_transactions — provider-agnostic record of a processor operation.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_transactions (
    id              BIGSERIAL PRIMARY KEY,
    customer_id     INT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    provider        VARCHAR(20) NOT NULL,
    provider_ref    TEXT,                 -- pi_… / ch_… / tx hash
    kind            VARCHAR(20) NOT NULL
                        CHECK (kind IN ('topup', 'charge', 'refund', 'dispute')),
    amount          DECIMAL(12,4) NOT NULL,
    currency        VARCHAR(3) NOT NULL DEFAULT 'USD',
    status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'succeeded', 'failed',
                                          'refunded', 'disputed')),
    idempotency_key TEXT NOT NULL UNIQUE,
    raw_event       JSONB,                -- verified provider webhook payload
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_txn_customer
    ON payment_transactions(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_txn_provider_ref
    ON payment_transactions(provider_ref) WHERE provider_ref IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4) auto_recharge_settings — one row per customer. WE build the trigger
--    (services/auto_recharge.py); columns cover backoff/cooldown/dunning.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auto_recharge_settings (
    id                   BIGSERIAL PRIMARY KEY,
    customer_id          INT NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
    enabled              BOOLEAN NOT NULL DEFAULT false,
    threshold            DECIMAL(12,4),    -- fire when balance < threshold
    recharge_amount      DECIMAL(12,4),    -- how much to top up
    payment_method_id    BIGINT REFERENCES payment_methods(id) ON DELETE SET NULL,
    currency             VARCHAR(3) NOT NULL DEFAULT 'USD',
    daily_cap            DECIMAL(12,4),    -- <= closed-loop $2k/day cap
    cooldown_seconds     INT NOT NULL DEFAULT 3600,
    consecutive_failures INT NOT NULL DEFAULT 0,
    last_triggered_at    TIMESTAMPTZ,
    disabled_reason      TEXT,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 5) invoices — minimal invoice records (monthly plan fees). Demo-facing on
--    this branch; real invoicing stays external (Equinox).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
    id                  BIGSERIAL PRIMARY KEY,
    customer_id         INT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    provider_invoice_id TEXT,             -- in_… (Stripe invoice id)
    amount              DECIMAL(12,4) NOT NULL DEFAULT 0,
    currency            VARCHAR(3) NOT NULL DEFAULT 'USD',
    status              VARCHAR(20) NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
    period_start        TIMESTAMPTZ,
    period_end          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_customer
    ON invoices(customer_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- NOTE: unified's migration rewrote rate_cdr() here. RCF-V1 deliberately does
-- NOT touch rate_cdr() — see the scope note in the header.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 6) GRANTs — least privilege (roles from 01_extensions.sql).
--    * ledger_entries: `api` gets SELECT + INSERT ONLY (append-only enforced
--      by privilege — NO update/delete).
--    * The other new tables: `api` gets full CRUD.
--    * freeswitch: gets NOTHING new. The call path never touches these tables.
--    Re-running these GRANTs is harmless (idempotent).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON TABLE ledger_entries TO api;   -- append-only: NO UPDATE/DELETE
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE payment_methods TO api;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE payment_transactions TO api;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE auto_recharge_settings TO api;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE invoices TO api;

-- Sequences — api needs USAGE,SELECT to INSERT (nextval) on the BIGSERIAL PKs.
GRANT USAGE, SELECT ON SEQUENCE ledger_entries_id_seq TO api;
GRANT USAGE, SELECT ON SEQUENCE payment_methods_id_seq TO api;
GRANT USAGE, SELECT ON SEQUENCE payment_transactions_id_seq TO api;
GRANT USAGE, SELECT ON SEQUENCE auto_recharge_settings_id_seq TO api;
GRANT USAGE, SELECT ON SEQUENCE invoices_id_seq TO api;

COMMIT;
