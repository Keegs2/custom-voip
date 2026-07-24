-- CDR Export Forwarder — watermark column + export audit log.
--
-- Backs docker/api/src/services/cdr_export/ (the Equinox→FileMage FTP forwarder).
-- Adds a per-row "exported_at" watermark so CDRs are never double-sent, a partial
-- index for fast "find unexported", and an audit table recording every export file.
--
-- IDEMPOTENT: uses IF NOT EXISTS everywhere, so it is safe to run repeatedly and
-- safe to run on an existing, populated cdrs table.
--
-- PRODUCTION NOTE: Postgres init scripts in this directory ONLY run on the first
-- initdb of a fresh data directory. The production primary already exists, so this
-- migration must be APPLIED MANUALLY on the bare-metal prod primary
-- (services VM, 10.142.0.103):
--     sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/init/21_cdr_export.sql
-- Then let it replicate to the standbys. The `api` DB user already has ALL on cdrs.

-- ---------------------------------------------------------------------------
-- Watermark column on the cdrs hypertable
-- ---------------------------------------------------------------------------
-- ADD COLUMN on a TimescaleDB hypertable propagates to all chunks. NULL default
-- means every existing row is "unexported"; the forwarder fills exported_at once
-- a row's data has been successfully shipped.
ALTER TABLE cdrs ADD COLUMN IF NOT EXISTS exported_at TIMESTAMPTZ;

-- Partial index: only unexported rows are indexed, so the exporter's
-- "WHERE exported_at IS NULL ORDER BY start_time, id" batch selection stays
-- cheap even as the table grows. The index shrinks as rows get exported.
-- Column order (start_time, id) matches the exporter's ORDER BY.
CREATE INDEX IF NOT EXISTS idx_cdrs_unexported
    ON cdrs (start_time, id)
    WHERE exported_at IS NULL;

-- ---------------------------------------------------------------------------
-- Export audit log — one row per export FILE (not per CDR)
-- ---------------------------------------------------------------------------
-- status lifecycle: 'pending' (row inserted before the FTP upload) →
-- 'sent' (upload succeeded, CDR rows marked exported) OR
-- 'failed' (upload failed; the CDR rows are left unexported and retry next run).
CREATE TABLE IF NOT EXISTS cdr_export_log (
    id              BIGSERIAL PRIMARY KEY,
    filename        TEXT        NOT NULL,
    sequence        BIGINT,
    row_count       INT         NOT NULL,
    byte_size       INT,
    min_id          BIGINT,
    max_id          BIGINT,
    min_start_time  TIMESTAMPTZ,
    max_start_time  TIMESTAMPTZ,
    status          TEXT        NOT NULL DEFAULT 'pending',
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at         TIMESTAMPTZ
);

-- Recent-first listing (operator "what did we send lately") and status filtering
-- (find failed exports to investigate/retry).
CREATE INDEX IF NOT EXISTS idx_cdr_export_log_created_at
    ON cdr_export_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cdr_export_log_status
    ON cdr_export_log (status);

-- ---------------------------------------------------------------------------
-- Grants — mirror the existing grant style (05_schema_cdr.sql).
-- The exporter runs as the `api` DB user. freeswitch grants are UNCHANGED.
-- ---------------------------------------------------------------------------
GRANT ALL ON cdr_export_log TO api;
-- cdr_export_log uses a BIGSERIAL (sequence); the api user needs sequence usage
-- to INSERT. Blanket sequence grant mirrors 05_schema_cdr.sql's freeswitch grant.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO api;

-- ---------------------------------------------------------------------------
-- Single-instance lease for the exporter (PgBouncer-transaction-mode safe:
-- claim/release are single autocommit UPDATEs, unlike session advisory locks).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cdr_export_lock (
    id           INT PRIMARY KEY DEFAULT 1,
    locked_until TIMESTAMPTZ,
    locked_by    TEXT,
    CONSTRAINT cdr_export_lock_singleton CHECK (id = 1)
);
INSERT INTO cdr_export_lock (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
GRANT ALL ON cdr_export_lock TO api;
