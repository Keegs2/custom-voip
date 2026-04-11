-- Multi-tenant extension namespacing
-- Depends on: 10_schema_ucaas.sql (extensions table)
--
-- Problem: The original schema enforced globally unique extension numbers
-- (idx_extensions_ext_unique) which prevents two customers from both having
-- extension "100". For multi-tenant UCaaS, extension numbers only need to
-- be unique WITHIN a customer.
--
-- Solution: Drop the global uniqueness constraint. The composite index
-- (customer_id, extension) already ensures per-customer uniqueness.

-- Drop the global uniqueness constraint that prevents overlapping extensions
DROP INDEX IF EXISTS idx_extensions_ext_unique;

-- The composite unique index (customer_id, extension) remains from
-- 10_schema_ucaas.sql and enforces per-customer uniqueness:
--   CREATE UNIQUE INDEX idx_extensions_customer_ext ON extensions(customer_id, extension);

-- Add a SIP password column for proper credential separation.
-- Currently voicemail_pin is reused as the SIP password, which is a security
-- concern at scale. This column stores a dedicated SIP/Verto auth password.
-- When NULL, the API falls back to voicemail_pin for backward compatibility.
ALTER TABLE extensions ADD COLUMN IF NOT EXISTS sip_password VARCHAR(128);

-- Comment for documentation
COMMENT ON COLUMN extensions.sip_password IS
    'Dedicated SIP/Verto authentication password. Falls back to voicemail_pin when NULL.';
