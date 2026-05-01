-- Add per-DID concurrent call limit to rcf_numbers.
-- 0 = unlimited (no limit enforced), matching current behavior.
-- FreeSWITCH uses limit_hash to enforce this before bridging.
-- Idempotent: uses IF NOT EXISTS so safe to run on existing databases.

ALTER TABLE rcf_numbers ADD COLUMN IF NOT EXISTS max_channels INT DEFAULT 0;
