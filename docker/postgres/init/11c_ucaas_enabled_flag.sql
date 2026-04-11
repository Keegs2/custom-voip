-- Migration: Add ucaas_enabled flag to customers table
-- Allows api/trunk/hybrid customers to opt into UCaaS features
-- (chat, voicemail, softphone, presence) as an explicit add-on.

ALTER TABLE customers ADD COLUMN IF NOT EXISTS ucaas_enabled BOOLEAN DEFAULT false;

-- UCaaS account types always have it enabled implicitly, but set the flag for consistency
UPDATE customers SET ucaas_enabled = true WHERE account_type = 'ucaas';
