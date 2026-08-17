-- ==========================================================================
-- 38_payments_demo.sql
-- Payments DEMO MODE support — demo-only state on top of the 37 ledger tables.
--
-- Ported from the unified branch's demo migration (2026-07-20_payments_demo.sql).
-- Adds:
--   1) customers.is_demo — marks a customer as demo-seeded. Reset deletes ONLY
--      rows for is_demo customers, so the demo can NEVER touch a real
--      customer's balance/ledger.
--   2) mpp_sessions — Stripe MPP "agent tab": a spend-limited session that
--      accumulates streamed micro-charges and settles as ONE ledger entry.
--   3) demo_scenarios — thin audit log of demo scenario buttons fired
--      (seed / call_drain / agent_usage / decline / mpp / reset).
--   4) reset_demo_ledger() — SECURITY DEFINER purge of ONLY demo-customer
--      ledger rows (the `api` role has no DELETE on ledger_entries; this
--      guarded function is the only way the app clears the DEMO ledger).
--
-- SAFETY: everything the demo writes is gated at the application layer by
-- PAYMENTS_DEMO_MODE=true AND require_admin (routers/payments.py). This
-- migration is pure schema; it touches NO carrier/call-path table and does not
-- change rate_cdr() or any existing billing path (RCF-V1 billing stays
-- estimates-only → Equinox).
--
-- MONETARY REPRESENTATION: DECIMAL(12,4) dollars, matching 37_payments_ledger
-- and customers.balance exactly (exact fixed-point, never floats).
--
-- IDEMPOTENT: CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- CREATE OR REPLACE FUNCTION, re-runnable GRANTs. Safe to re-run.
--
-- PRODUCTION NOTE: init scripts only run on the first initdb of a fresh data
-- directory. Apply MANUALLY on the bare-metal prod primary (services VM,
-- 10.142.0.103) AFTER 37, then let it replicate:
--     sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/init/38_payments_demo.sql
--
-- Verify afterwards:
--     sudo -u postgres psql -d voip -c "\d mpp_sessions" -c "\d demo_scenarios"
--     sudo -u postgres psql -d voip -c "SELECT column_name FROM information_schema.columns WHERE table_name='customers' AND column_name='is_demo';"
-- ==========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) customers.is_demo — the hard isolation flag. Defaults false: every
--    existing (real) customer is NOT a demo customer.
-- ---------------------------------------------------------------------------
ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;

-- Fast "find the demo customers" lookup used by seed/reset/state.
CREATE INDEX IF NOT EXISTS idx_customers_is_demo
    ON customers(is_demo) WHERE is_demo;

-- ---------------------------------------------------------------------------
-- 2) mpp_sessions — Stripe MPP agent "tab". An autonomous agent opens a
--    spend-limited session, streams micro-charges (each accumulates into
--    total_charged), then the tab settles as ONE ledger entry.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mpp_sessions (
    id               BIGSERIAL PRIMARY KEY,
    customer_id      INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    -- Provider session handle (mpp_sess_… for the demo; a real SPT session later).
    provider         VARCHAR(20) NOT NULL DEFAULT 'stripe_mpp',
    provider_session_id TEXT,
    -- Hard spend ceiling for the session; a charge that would exceed it is refused.
    spend_limit      DECIMAL(12,4) NOT NULL,
    -- Running tab: SUM of accepted micro-charges so far.
    total_charged    DECIMAL(12,4) NOT NULL DEFAULT 0,
    charge_count     INT NOT NULL DEFAULT 0,
    currency         VARCHAR(3) NOT NULL DEFAULT 'USD',
    status           VARCHAR(20) NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'settled', 'closed', 'expired')),
    -- What the agent/session is for (display).
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
-- 3) demo_scenarios — thin audit of demo control buttons. Not on any money path.
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
--    rows. ledger_entries is append-only for `api` (37 grants SELECT+INSERT
--    only — NO DELETE): that guarantee protects REAL customers' ledgers. The
--    demo Reset must still clear the demo customer's ledger, so this function
--    runs as its OWNER (the migration runner / table owner) and deletes ledger
--    rows ONLY for customers flagged is_demo. `api` gets EXECUTE on it — the
--    app can reset the DEMO ledger WITHOUT gaining any ability to delete a
--    real customer's entries. The WHERE clause is the hard guard.
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
-- 5) GRANTs — least privilege. Demo tables get full CRUD for `api` (reset
--    needs DELETE on them). customers.is_demo needs no new grant (the existing
--    table-level GRANT on customers covers new columns). The demo-ledger purge
--    is via EXECUTE on the SECURITY DEFINER function above, NOT a DELETE grant
--    on ledger_entries. FreeSWITCH gets NOTHING new.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mpp_sessions TO api;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE demo_scenarios TO api;

GRANT USAGE, SELECT ON SEQUENCE mpp_sessions_id_seq TO api;
GRANT USAGE, SELECT ON SEQUENCE demo_scenarios_id_seq TO api;

-- The app resets the demo ledger only through this guarded function.
GRANT EXECUTE ON FUNCTION reset_demo_ledger() TO api;

COMMIT;
