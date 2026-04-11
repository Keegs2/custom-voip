-- Migration: Per-customer extension uniqueness
-- Depends on: 10_schema_ucaas.sql
--
-- Previously extension numbers were globally unique across all customers
-- (idx_extensions_ext_unique). At 100K+ users this is unworkable — every
-- customer should be able to have extension 100, 101, etc.
--
-- This migration:
--   1. Drops the global uniqueness constraint on extension alone.
--   2. Ensures the composite (customer_id, extension) unique index exists
--      so extension numbers are unique *within* each customer.

-- Drop the global uniqueness constraint
DROP INDEX IF EXISTS idx_extensions_ext_unique;

-- Ensure per-customer uniqueness (composite unique on customer_id + extension)
CREATE UNIQUE INDEX IF NOT EXISTS idx_extensions_customer_ext
    ON extensions(customer_id, extension);
