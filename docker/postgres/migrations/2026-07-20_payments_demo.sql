-- Migration: payments/monetary system — DEMO MODE support (§9)
-- ============================================================================
-- Adds the small amount of demo-only state the exec-facing payments DEMO needs
-- ON TOP OF the Wave-1 ledger tables (ledger_entries / payment_methods /
-- payment_transactions / auto_recharge_settings / invoices — created by
-- 2026-07-20_payments_ledger.sql). This migration DOES NOT duplicate any Wave-1
-- table; it only adds:
--
--   1) customers.is_demo         — a boolean flag marking a customer as
--                                  demo-seeded. Reset (§9) deletes ONLY rows for
--                                  is_demo customers, so the demo can NEVER touch
--                                  a real customer's balance/ledger.
--   2) mpp_sessions              — Stripe MPP "agent tab": a spend-limited session
--                                  that accumulates streamed micro-charges and
--                                  settles as ONE topup/charge against the ledger.
--   3) demo_scenarios (audit)    — a thin log of which demo scenario buttons were
--                                  fired (seed / call-drain / agent-usage /
--                                  decline / reset), so GET /demo/state can show a
--                                  recent-activity trail.
--
-- Design: docs/PAYMENTS_SYSTEM_DESIGN.md §9 (DEMO MODE).
-- Backs:
--   * docker/api/src/routers/payments.py            (all §9 endpoints)
--   * docker/api/src/services/payments/demo_providers.py (Demo{Stripe,X402,Mpp}Provider)
--   * docker/api/src/services/auto_recharge.py      (threshold → off-session charge → topup)
--   * docker/api/src/services/demo_seed.py          (seed / reset — isolated to is_demo)
--
-- SAFETY: everything the demo writes is gated at the application layer by
-- PAYMENTS_DEMO_MODE=true AND require_admin. This migration is pure schema; it
-- adds no privileges beyond the new tables + the is_demo column (a table-level
-- GRANT already covers columns added to customers). It touches NO carrier/call
-- path table.
--
-- MONETARY REPRESENTATION: DECIMAL(12,4) dollars, matching the Wave-1 ledger and
-- customers.balance exactly (exact fixed-point, never floats). The would-be-Stripe
-- integer-cents / USDC-6-decimal conversions happen only at the provider seam
-- (demo_providers.py), never in these tables or the ledger.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- re-runnable GRANTs. Safe to run repeatedly.
--
-- Apply (production services VM, bare-metal PostgreSQL, DB 'voip'):
--
--   sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/migrations/2026-07-20_payments_demo.sql
--
-- Verify afterwards:
--
--   sudo -u postgres psql -d voip -c "\d mpp_sessions" -c "\d demo_scenarios"
--   sudo -u postgres psql -d voip -c "SELECT column_name FROM information_schema.columns WHERE table_name='customers' AND column_name='is_demo';"
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) customers.is_demo — marks a customer as demo-seeded. The Reset endpoint
--    (§9) deletes ledger/payment/mpp/auto-recharge rows ONLY for is_demo
--    customers, so the demo is physically isolated from real tenants. Defaults
--    false: every existing (real) customer is NOT a demo customer.
-- ---------------------------------------------------------------------------
ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;

-- Fast "find the demo customers" lookup used by seed/reset/state.
CREATE INDEX IF NOT EXISTS idx_customers_is_demo
    ON customers(is_demo) WHERE is_demo;

-- ---------------------------------------------------------------------------
-- 2) mpp_sessions — Stripe MPP agent "tab" (design §4 Rail B / §9 story 4).
--    An autonomous agent opens a spend-limited session, streams micro-charges
--    (each accumulates into total_charged), then the tab settles as ONE ledger
--    entry. Everything is DECIMAL dollars; the provider converts at ITS seam.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mpp_sessions (
    id               BIGSERIAL PRIMARY KEY,
    customer_id      INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    -- Provider session handle (mpp_sess_… for the demo; a real SPT session later).
    provider         VARCHAR(20) NOT NULL DEFAULT 'stripe_mpp',
    provider_session_id TEXT,
    -- Hard spend ceiling for the session; a charge that would exceed it is refused.
    spend_limit      DECIMAL(12,4) NOT NULL,
    -- Running tab: SUM of accepted micro-charges so far (money the agent owes).
    total_charged    DECIMAL(12,4) NOT NULL DEFAULT 0,
    charge_count     INT NOT NULL DEFAULT 0,
    currency         VARCHAR(3) NOT NULL DEFAULT 'USD',
    status           VARCHAR(20) NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'settled', 'closed', 'expired')),
    -- What the agent/session is for (display in the exec dashboard).
    label            TEXT,
    -- Ledger + provider refs stamped at settlement.
    settlement_ref   TEXT,             -- pi_… stamped when the tab settles
    metadata         JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    settled_at       TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mpp_sessions_customer
    ON mpp_sessions(customer_id, created_at DESC);
-- "Active tabs" panel: open sessions for a customer.
CREATE INDEX IF NOT EXISTS idx_mpp_sessions_open
    ON mpp_sessions(customer_id) WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- 3) demo_scenarios — thin audit of which demo control buttons fired, so the
--    exec state view can render a recent-activity trail ("seeded 2m ago",
--    "call-drain fired auto-recharge $50", …). Not on any money path.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS demo_scenarios (
    id           BIGSERIAL PRIMARY KEY,
    customer_id  INT REFERENCES customers(id) ON DELETE CASCADE,
    scenario     VARCHAR(40) NOT NULL,   -- seed | call_drain | agent_usage | decline | topup | mpp | reset
    detail       JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_demo_scenarios_created
    ON demo_scenarios(created_at DESC);

-- ---------------------------------------------------------------------------
-- 4) reset_demo_ledger() — SECURITY DEFINER purge of ONLY demo-customer ledger
--    rows. `ledger_entries` is append-only for the `api` role (Wave-1 migration
--    grants SELECT+INSERT only — NO DELETE), which is the whole point: a real
--    customer's ledger can never be mutated by the app. But the demo Reset MUST
--    clear the demo customer's ledger. We reconcile these with a SECURITY DEFINER
--    function that runs as the function OWNER (the migration runner / table owner)
--    and deletes ledger rows ONLY for customers flagged is_demo. The `api` role is
--    granted EXECUTE on it — so the app can reset the DEMO ledger WITHOUT gaining
--    any ability to delete a real customer's entries. The WHERE clause is the hard
--    guard: is_demo = true, always.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reset_demo_ledger()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_deleted INT;
BEGIN
    DELETE FROM ledger_entries le
    USING customers c
    WHERE le.customer_id = c.id
      AND c.is_demo = true;   -- HARD GUARD: only demo customers, never a real one
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5) GRANTs — least privilege. The demo tables get full CRUD for `api` (the
--    application role); reset needs DELETE on them. `customers.is_demo` needs no
--    new grant (the existing table-level GRANT on customers covers new columns).
--    The demo-ledger purge is via EXECUTE on the SECURITY DEFINER function above,
--    NOT a DELETE grant on ledger_entries (append-only stays intact for `api`).
--    FreeSWITCH gets NOTHING new — the demo never touches the call path.
--    Re-running these GRANTs is harmless (idempotent).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mpp_sessions TO api;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE demo_scenarios TO api;

GRANT USAGE, SELECT ON SEQUENCE mpp_sessions_id_seq TO api;
GRANT USAGE, SELECT ON SEQUENCE demo_scenarios_id_seq TO api;

-- The app resets the demo ledger only through this guarded function.
GRANT EXECUTE ON FUNCTION reset_demo_ledger() TO api;

COMMIT;
