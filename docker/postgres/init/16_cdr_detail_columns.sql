-- Add detailed SIP and codec fields to cdrs table for richer CDR capture.
-- Idempotent: uses IF NOT EXISTS so safe to run on existing databases.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cdrs' AND column_name='read_rate') THEN
        ALTER TABLE cdrs ADD COLUMN read_rate INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cdrs' AND column_name='write_rate') THEN
        ALTER TABLE cdrs ADD COLUMN write_rate INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cdrs' AND column_name='sip_from_user') THEN
        ALTER TABLE cdrs ADD COLUMN sip_from_user VARCHAR(64);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cdrs' AND column_name='sip_to_user') THEN
        ALTER TABLE cdrs ADD COLUMN sip_to_user VARCHAR(64);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cdrs' AND column_name='hangup_cause_q850') THEN
        ALTER TABLE cdrs ADD COLUMN hangup_cause_q850 SMALLINT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cdrs' AND column_name='sip_hangup_disposition') THEN
        ALTER TABLE cdrs ADD COLUMN sip_hangup_disposition VARCHAR(30);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cdrs' AND column_name='sip_user_agent') THEN
        ALTER TABLE cdrs ADD COLUMN sip_user_agent VARCHAR(128);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cdrs' AND column_name='network_addr') THEN
        ALTER TABLE cdrs ADD COLUMN network_addr VARCHAR(45);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cdrs' AND column_name='bridge_uuid') THEN
        ALTER TABLE cdrs ADD COLUMN bridge_uuid VARCHAR(64);
    END IF;
END $$;
