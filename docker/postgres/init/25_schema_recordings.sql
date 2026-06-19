-- ---------------------------------------------------------------------------
-- 25_schema_recordings.sql — Standalone call recording metadata (Phase 6)
-- ---------------------------------------------------------------------------
-- The media plane records calls (programmable <Record>, ad-hoc call recording,
-- and conference recording) to the shared media spool. FreeSWITCH then notifies
-- the API (POST /v1/recordings/ingest, JWT-exempt like CDR/voicemail ingest),
-- which uploads the WAV to the voip-recordings object-storage bucket under a
-- tenant-scoped key and persists one row here. See docker/api/src/routers/
-- recordings.py.
--
-- object_key/bucket point at the S3-compatible object (NOT a local path) so any
-- media node can serve the audio via a short-lived presigned URL. Both are
-- nullable so a failed upload still records the call's existence (resilient
-- ingest never drops the notification).
--
-- Ordering: runs after 23_ (last schema) and before 26_resync_sequences.sql.
-- recordings has no explicit-id seed, so its sequence does not need resync; the
-- resync's MAX()=0 skip leaves it untouched. The resync still sorts LAST.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS recordings (
    id             SERIAL PRIMARY KEY,
    customer_id    INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    call_uuid      VARCHAR(64),
    recording_uuid VARCHAR(64) NOT NULL UNIQUE,   -- idempotency key from FreeSWITCH
    object_key     TEXT,                           -- tenant-scoped S3 key (NULL if upload failed)
    bucket         VARCHAR(100),                   -- storage bucket holding the object
    duration_ms    INT,
    kind           VARCHAR(20) NOT NULL DEFAULT 'call',  -- programmable | call | conference
    created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Lookups: list/scope by customer; correlate to a call leg by call_uuid.
CREATE INDEX IF NOT EXISTS idx_recordings_customer ON recordings (customer_id);
CREATE INDEX IF NOT EXISTS idx_recordings_call_uuid ON recordings (call_uuid);

-- Grants — runtime API role needs full CRUD; sequence for inserts.
GRANT ALL ON TABLE recordings TO api;
GRANT USAGE, SELECT ON SEQUENCE recordings_id_seq TO api;
