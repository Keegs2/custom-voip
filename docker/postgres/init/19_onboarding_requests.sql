-- ==========================================================================
-- 19_onboarding_requests.sql
-- Onboarding pipeline for new RCF customer requests
-- Stores the public intake form and tracks a lightweight status.
-- Status model: pending -> completed  (or -> rejected)
--   Billing verification + provisioning are handled by an EXTERNAL system
--   (integrated later); "completed" is a status-only transition here.
-- NOTE: kept in sync with migration 27_onboarding_simplify.sql, which brings
--   an already-initialized prod DB to this same 3-status state.
-- ==========================================================================

CREATE TABLE IF NOT EXISTS onboarding_requests (
    id SERIAL PRIMARY KEY,

    -- Contact information (from intake form)
    company_name VARCHAR(255) NOT NULL,
    contact_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NOT NULL,

    -- RCF requirements (from intake form)
    did_count VARCHAR(50) NOT NULL,
    porting VARCHAR(100) NOT NULL,
    current_carrier VARCHAR(255),
    forwarding_setup VARCHAR(255) NOT NULL,
    monthly_volume VARCHAR(100) NOT NULL,
    timeline VARCHAR(100) NOT NULL,

    -- Status workflow: pending -> completed (or -> rejected)
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CONSTRAINT onboarding_requests_status_check
        CHECK (status IN ('pending', 'completed', 'rejected')),

    -- Completion (status-only; external system handles actual provisioning)
    completed_by INT REFERENCES users(id) ON DELETE SET NULL,
    completed_at TIMESTAMPTZ,

    -- Admin notes
    admin_notes TEXT,

    -- Rejection
    rejected_by INT REFERENCES users(id) ON DELETE SET NULL,
    rejected_at TIMESTAMPTZ,
    rejection_reason TEXT,

    -- Dormant columns (retained for a future external-billing integration;
    -- no longer written by the API). See migration 27_onboarding_simplify.sql.
    billing_verified_by INT REFERENCES users(id) ON DELETE SET NULL,
    billing_verified_at TIMESTAMPTZ,
    billing_notes TEXT,
    reviewed_by INT REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,

    -- Provisioning config (set by admin at approve time)
    -- JSONB array: [{"did": "+16175551234", "forward_to": "+17745559876"}, ...]
    provisioning_config JSONB,

    -- Post-provisioning links
    customer_id INT REFERENCES customers(id) ON DELETE SET NULL,
    user_id INT REFERENCES users(id) ON DELETE SET NULL,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_status ON onboarding_requests(status);
CREATE INDEX IF NOT EXISTS idx_onboarding_email ON onboarding_requests USING hash(email);
CREATE INDEX IF NOT EXISTS idx_onboarding_created ON onboarding_requests(created_at DESC);

GRANT ALL ON onboarding_requests TO api;
GRANT USAGE, SELECT ON onboarding_requests_id_seq TO api;
