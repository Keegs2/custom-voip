-- Add sbc_id column to cdrs table for SBC failover tracking.
-- Idempotent: uses IF NOT EXISTS so safe to run on existing databases.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cdrs' AND column_name='sbc_id') THEN
        ALTER TABLE cdrs ADD COLUMN sbc_id VARCHAR(30);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_cdrs_sbc_id_time ON cdrs(sbc_id, start_time DESC) WHERE sbc_id IS NOT NULL;
