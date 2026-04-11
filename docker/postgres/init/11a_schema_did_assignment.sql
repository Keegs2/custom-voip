-- DID Assignment for UCaaS Extensions
-- Depends on: 10_schema_ucaas.sql (extensions table)
--
-- Links an E.164 DID to an extension as the user's "personal business number":
--   - Outbound caller ID on PSTN calls
--   - Inbound routing target (ring this extension when the DID is called)
--   - Displayed in the directory / chat user picker
--
-- This is separate from product DID tables (rcf_numbers, api_dids, trunk_dids)
-- which serve specific revenue-generating products.

-- Add assigned_did column to extensions
ALTER TABLE extensions ADD COLUMN IF NOT EXISTS assigned_did VARCHAR(20);

-- Partial unique index: each DID can only be assigned to one extension,
-- but many extensions may have NULL (no DID assigned).
CREATE UNIQUE INDEX IF NOT EXISTS idx_extensions_did
    ON extensions(assigned_did) WHERE assigned_did IS NOT NULL;
