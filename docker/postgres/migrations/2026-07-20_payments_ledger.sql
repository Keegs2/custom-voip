-- Migration: payments/monetary system — Wave 1 (append-only ledger foundation)
-- ============================================================================
-- Builds the append-only, idempotent LEDGER SPINE that every future payment rail
-- (Stripe card, Stripe crypto, Stripe MPP, x402) plugs into. This wave is PURE
-- INTERNAL: no external processor, no money movement, no network calls, no
-- compliance exposure. It only reshapes how the balance is mutated.
--
-- Design: docs/PAYMENTS_SYSTEM_DESIGN.md §0-§3, §7 Wave 1.
-- Backs:
--   * docker/api/src/services/ledger.py            (post_ledger_entry — the ONLY writer of customers.balance)
--   * docker/api/src/services/payments/*           (PaymentProvider abstraction + NoopProvider)
--   * docker/api/src/routers/customers.py          (add_credit → ledger entry)
--   * docker/api/src/routers/calls.py              (per-call fee → ledger entry)
--   * docker/api/src/routers/billing.py            (tenant-scoped read-only ledger/balance)
--   * rate_cdr()                                    (rewritten below → posts a `usage` entry)
--
-- --------------------------------------------------------------------------
-- MONETARY REPRESENTATION — DECIMAL(12,4), NOT integer minor units (deliberate)
-- --------------------------------------------------------------------------
-- The design doc (§2) describes `amount_minor BIGINT`. We instead use
-- DECIMAL(12,4) to MATCH the live money code exactly: `customers.balance` /
-- `customers.credit_limit` are DECIMAL(12,4) (02_schema_core.sql) and the whole
-- telecom rating math in rate_cdr() / get_rate() is DECIMAL. DECIMAL is EXACT
-- (fixed-point, not float), so it fully satisfies the design's "never floats"
-- rule WITHOUT a risky rewrite of the billing-critical rating path. asyncpg maps
-- DECIMAL <-> Python decimal.Decimal (also exact). The Stripe boundary will
-- convert DECIMAL dollars <-> integer cents at the PROCESSOR seam in a LATER
-- wave; the internal ledger stays DECIMAL dollars end-to-end.
--
-- --------------------------------------------------------------------------
-- APPEND-ONLY IS ENFORCED BY PRIVILEGE
-- --------------------------------------------------------------------------
-- `ledger_entries` is immutable. The `api` role is granted SELECT + INSERT ONLY
-- (no UPDATE, no DELETE) so the application PHYSICALLY cannot mutate or delete a
-- posted entry. The `customers.balance` cache is updated in the SAME transaction
-- as each INSERT (see post_ledger_entry / rate_cdr) so the reconciliation
-- invariant holds:  SUM(ledger_entries.amount for a customer) == customers.balance.
--
-- --------------------------------------------------------------------------
-- Why a migration (not init/): init/*.sql only runs on first `initdb`. Existing
-- databases (production services VM + any already-initialised local volume) must
-- get these tables + the rewritten rate_cdr() via this migration. **Migrations
-- are applied BY HAND** — there is no Alembic/auto-runner yet (infra may add one
-- later). Run this on every environment that already has a `customers` table,
-- BEFORE deploying the API build that references the ledger service.
--
-- Idempotent: CREATE TABLE / INDEX / CONSTRAINT IF NOT EXISTS, CREATE OR REPLACE
-- FUNCTION, and re-runnable GRANTs. Safe to run repeatedly.
--
-- BACK-COMPAT (critical): re-running rate_cdr() on an ALREADY-RATED CDR is still
-- a no-op (the `rated_at IS NULL` guard is preserved) — so the rewrite never
-- double-charges. On first apply, existing customers have a `customers.balance`
-- that predates the ledger; that balance is treated as the ledger's opening
-- position. The reconciliation invariant is defined over entries POSTED by this
-- system going forward (a one-time `adjustment` seed can reconcile historical
-- balances later if/when a full ledger backfill is desired — deferred).
--
-- Apply (production services VM, bare-metal PostgreSQL, DB 'voip'):
--
--   sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/migrations/2026-07-20_payments_ledger.sql
--
-- Verify afterwards:
--
--   sudo -u postgres psql -d voip -c "\d ledger_entries" -c "\d payment_transactions"
--   sudo -u postgres psql -d voip -c "SELECT proname FROM pg_proc WHERE proname='rate_cdr';"
--   -- append-only proof: api must have SELECT+INSERT but NOT update/delete on ledger_entries
--   sudo -u postgres psql -d voip -c "SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee='api' AND table_name='ledger_entries' ORDER BY privilege_type;"
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) ledger_entries — the APPEND-ONLY spine. One signed row per money event.
--    Never UPDATEd, never DELETEd (enforced by GRANT below). `balance_after`
--    snapshots the running balance AT THE TIME OF POST for audit + fast history.
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
    -- Idempotency: a repeated post with the same key returns the existing row and
    -- does NOT double-apply. For usage entries this key is the CDR uuid, so
    -- re-rating a CDR can never double-charge.
    idempotency_key TEXT NOT NULL UNIQUE,
    -- Processor/on-chain reference (pi_…/spt_…/tx hash), NULL for internal posts.
    external_ref    TEXT,
    -- Running balance immediately AFTER this entry was applied.
    balance_after   DECIMAL(12,4),
    metadata        JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tenant history read: newest-first entries for one customer (backs GET ledger).
CREATE INDEX IF NOT EXISTS idx_ledger_customer_created
    ON ledger_entries(customer_id, created_at DESC);
-- Reconciliation / external-ref lookups.
CREATE INDEX IF NOT EXISTS idx_ledger_external_ref
    ON ledger_entries(external_ref) WHERE external_ref IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2) payment_methods — tokenised cards-on-file. NO PAN/CVV EVER (PCI SAQ-A):
--    we store ONLY processor tokens (pm_…/cus_…) + display metadata (brand/last4).
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
--    On `succeeded` a later wave posts the matching ledger_entries row (same txn).
--    Idempotency by (processor event / our key) closes the "no idempotency" gap.
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
-- 4) auto_recharge_settings — one row per customer. WE build the trigger (Stripe
--    has none). `daily_cap` MUST stay <= the closed-loop cap (design §1). All the
--    columns needed for backoff/cooldown/dunning are here; the TRIGGER logic
--    lands in a later wave.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auto_recharge_settings (
    id                   BIGSERIAL PRIMARY KEY,
    customer_id          INT NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
    enabled              BOOLEAN NOT NULL DEFAULT false,
    threshold            DECIMAL(12,4),    -- fire when balance < threshold
    recharge_amount      DECIMAL(12,4),    -- how much to top up
    payment_method_id    BIGINT REFERENCES payment_methods(id) ON DELETE SET NULL,
    currency             VARCHAR(3) NOT NULL DEFAULT 'USD',
    daily_cap            DECIMAL(12,4),    -- <= closed-loop cap (design §1)
    cooldown_seconds     INT NOT NULL DEFAULT 3600,
    consecutive_failures INT NOT NULL DEFAULT 0,
    last_triggered_at    TIMESTAMPTZ,
    disabled_reason      TEXT,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 5) invoices — postpaid (credit_limit) customers + monthly plan fees. Minimal
--    now; the Stripe subscription/meter wiring is a later wave.
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
-- 6) rate_cdr() — REWRITTEN to post a `usage` ledger entry instead of mutating
--    customers.balance directly. Behaviour is preserved EXACTLY:
--      * `rated_at IS NULL` guard kept → re-rating a CDR is still a no-op (never
--        double-charges).
--      * The balance still DECREASES by exactly v_total_cost.
--      * Return value is still v_total_cost (or NULL when nothing to rate).
--    Now it ALSO writes an immutable audit row into ledger_entries, keyed by the
--    CDR uuid (idempotency_key). The INSERT + the balance-cache UPDATE happen in
--    ONE statement flow inside this function, so they are atomic with the CDR
--    UPDATE (the whole function body runs in the caller's transaction). This is
--    written in SQL (not via the Python service) so it stays atomic and available
--    to whichever role calls the function.
--
--    GRANT: rate_cdr is granted EXECUTE to `api` only (05_schema_cdr.sql) — the
--    FreeSWITCH call path does NOT rate CDRs (verified: no rate_cdr caller in
--    docker/freeswitch, no trigger). The `api` role already has INSERT on
--    ledger_entries + UPDATE on customers, so the rewritten body works under the
--    existing grant with no new privilege. (This function is NOT SECURITY
--    DEFINER, so it runs with the caller's privileges — the `api` role.)
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
    v_new_balance DECIMAL;
BEGIN
    -- Get CDR details (the rated_at IS NULL guard makes re-rating a no-op).
    SELECT customer_id, direction, destination, duration_ms
    INTO v_customer_id, v_direction, v_destination, v_duration_ms
    FROM cdrs WHERE uuid = p_uuid AND rated_at IS NULL;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

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

    -- Update CDR (sets rated_at → makes this uuid ineligible for re-rating).
    UPDATE cdrs
    SET billable_ms = v_billable_ms,
        rate_per_min = v_rate,
        total_cost = v_total_cost,
        carrier_cost = v_carrier_cost,
        margin = v_total_cost - v_carrier_cost,
        rated_at = NOW()
    WHERE uuid = p_uuid;

    -- LEDGER: usage is money OUT, so post a NEGATIVE amount. Update the balance
    -- cache in the SAME statement and capture the new balance for balance_after.
    -- Net effect on the balance is identical to the old `balance = balance -
    -- v_total_cost`.
    UPDATE customers
    SET balance = balance - v_total_cost, updated_at = NOW()
    WHERE id = v_customer_id
    RETURNING balance INTO v_new_balance;

    -- Append the immutable ledger row. idempotency_key = CDR uuid: because the
    -- `rated_at IS NULL` guard already prevents re-entry, this INSERT runs at most
    -- once per CDR; ON CONFLICT DO NOTHING is a belt-and-suspenders guard so a
    -- concurrent double-call can never raise a unique violation nor double-post.
    INSERT INTO ledger_entries
        (customer_id, amount, currency, entry_type, source, idempotency_key,
         external_ref, balance_after, metadata)
    VALUES
        (v_customer_id, -v_total_cost, 'USD', 'usage', 'rating', p_uuid,
         p_uuid, v_new_balance,
         jsonb_build_object('cdr_uuid', p_uuid, 'destination', v_destination,
                            'billable_ms', v_billable_ms, 'rate_per_min', v_rate))
    ON CONFLICT (idempotency_key) DO NOTHING;

    RETURN v_total_cost;
END;
$$;

-- ---------------------------------------------------------------------------
-- 7) GRANTs — least privilege.
--    * ledger_entries: `api` gets SELECT + INSERT ONLY (append-only enforced by
--      privilege — NO update/delete). The rewritten rate_cdr() runs as `api`, so
--      this covers the function's INSERT too.
--    * The other new tables: `api` gets full CRUD (customer/admin management).
--    * freeswitch: gets NOTHING new. The call path does not touch these tables
--      and does not call rate_cdr() (verified). Balance decrement for calls
--      happens via the API (rate_cdr / per-call fee), all as the `api` role.
--    Re-running these GRANTs is harmless (idempotent).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT ON TABLE ledger_entries TO api;   -- append-only: NO UPDATE/DELETE
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE payment_methods TO api;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE payment_transactions TO api;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE auto_recharge_settings TO api;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE invoices TO api;

-- Sequences — api needs USAGE,SELECT to INSERT (nextval) on the BIGSERIAL PKs.
-- (ledger_entries_id_seq included: append-only means no UPDATE/DELETE, but api
-- still INSERTs, which needs the sequence.)
GRANT USAGE, SELECT ON SEQUENCE ledger_entries_id_seq TO api;
GRANT USAGE, SELECT ON SEQUENCE payment_methods_id_seq TO api;
GRANT USAGE, SELECT ON SEQUENCE payment_transactions_id_seq TO api;
GRANT USAGE, SELECT ON SEQUENCE auto_recharge_settings_id_seq TO api;
GRANT USAGE, SELECT ON SEQUENCE invoices_id_seq TO api;

COMMIT;
