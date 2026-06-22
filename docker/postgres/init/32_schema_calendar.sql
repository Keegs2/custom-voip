-- ---------------------------------------------------------------------------
-- 32_schema_calendar.sql — Read-only Calendar integration (Phase 1)
-- ---------------------------------------------------------------------------
-- Per-USER (not per-customer) OAuth connections to external calendar providers
-- (Google Calendar API v3 + Microsoft Graph). v1 is read-only: connect → view →
-- disconnect. This table stores ONLY OAuth tokens (encrypted at rest) + identity
-- metadata — NEVER event bodies. Events are fetched on demand and held only in a
-- short Redis cache + the HTTP response (GDPR: minimal data at rest).
--
-- Keyed on user_id (the JWT `sub`), finer-grained than the customer-scoped
-- product tables. `get_customer_filter` is intentionally NOT used by the router.
--
-- Tokens (access_token_enc / refresh_token_enc) hold Fernet CIPHERTEXT only —
-- the API 503s `calendar_disabled` if CALENDAR_TOKEN_ENC_KEY is unset rather
-- than ever storing plaintext. A DB dump is useless without the key.
--
-- Least-privilege: the runtime `api` role has no CREATE on schema public, so
-- this table is provisioned by migration (same pattern as 27_schema_call_flows.sql)
-- WITH explicit grants to `api`. Idempotent + self-contained so it can be applied
-- by hand to existing production databases (init scripts only run on first initdb).
--
-- `id SERIAL` (not IDENTITY) so the owning sequence has the predictable
-- `calendar_connections_id_seq` name we grant USAGE,SELECT on below.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS calendar_connections (
    id                  SERIAL PRIMARY KEY,
    user_id             INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider            VARCHAR(20) NOT NULL
                        CHECK (provider IN ('google', 'microsoft')),
    account_email       TEXT,
    provider_account_id TEXT,
    access_token_enc    TEXT,          -- Fernet ciphertext only
    refresh_token_enc   TEXT,          -- Fernet ciphertext only
    token_expires_at    TIMESTAMPTZ,
    scopes              TEXT[],
    status              VARCHAR(20) NOT NULL DEFAULT 'connected'
                        CHECK (status IN ('connected', 'needs_reauth', 'revoked')),
    last_synced_at      TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One connection per (user, provider, account). Re-auth UPSERTs in place.
    CONSTRAINT uq_calendar_connections_user_provider_account
        UNIQUE (user_id, provider, account_email)
);

-- Per-user listing (the only access pattern: WHERE user_id = $1).
CREATE INDEX IF NOT EXISTS idx_calendar_connections_user_id
    ON calendar_connections (user_id);

-- Grants — runtime API role needs full row CRUD (least-privilege: no DDL).
GRANT ALL ON TABLE calendar_connections TO api;

-- SERIAL owns calendar_connections_id_seq; grant nextval/currval access so
-- INSERTs can draw the id. Resolved dynamically + idempotently.
DO $$
DECLARE
    seqname TEXT;
BEGIN
    seqname := pg_get_serial_sequence('public.calendar_connections', 'id');
    IF seqname IS NOT NULL THEN
        EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO api', seqname);
    END IF;
END $$;

COMMIT;
