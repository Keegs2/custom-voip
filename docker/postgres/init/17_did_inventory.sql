-- ==========================================================================
-- 17_did_inventory.sql
-- DID inventory and assignment management
-- Tracks all DIDs from Bandwidth and their assignment to customers/products
-- ==========================================================================

CREATE TABLE IF NOT EXISTS did_inventory (
    id SERIAL PRIMARY KEY,
    did VARCHAR(20) NOT NULL UNIQUE,          -- E.164 format (+1NPANXXXXXX)

    -- Bandwidth metadata (synced from API)
    city VARCHAR(100),
    state VARCHAR(50),
    lata VARCHAR(10),
    rate_center VARCHAR(100),

    -- Assignment
    customer_id INT REFERENCES customers(id) ON DELETE SET NULL,
    product_type VARCHAR(20) CHECK (product_type IN ('rcf', 'trunk', 'api', 'ucaas')),
    product_ref_id INT,                        -- ID in the product table (rcf_numbers.id, etc.)
    status VARCHAR(20) NOT NULL DEFAULT 'available'
        CHECK (status IN ('available', 'assigned', 'reserved', 'porting_in', 'porting_out', 'suspended')),

    -- Audit
    assigned_at TIMESTAMPTZ,
    assigned_by INT REFERENCES users(id),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_did_inv_status ON did_inventory(status);
CREATE INDEX IF NOT EXISTS idx_did_inv_customer ON did_inventory(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_did_inv_did ON did_inventory USING hash(did);

GRANT ALL ON did_inventory TO api;
GRANT SELECT ON did_inventory TO freeswitch;
GRANT USAGE, SELECT ON did_inventory_id_seq TO api;
