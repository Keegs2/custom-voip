-- ==========================================================================
-- 61_ivr_assist.sql
-- Visual IVR Flow assistant — the per-customer opt-in and the job table.
--
-- Contract: docs/IVR_ASSIST_INTERFACES.md §8 (opt-in) and §9 (data). The
-- assistant drafts a call flow from the customer's description: CRAG builds an
-- aliased request (no phone number, no customer identity), TED runs the single
-- AI step, CRAG validates the proposal with its own compiler and the builder
-- shows it. Nothing here is on the call path.
--
-- WHAT THIS DOES (one transaction, idempotent — re-running is a no-op):
--   1. customers.ivr_assist_enabled BOOLEAN NOT NULL DEFAULT false
--      (metadata-only ADD COLUMN on PG >= 11; no table rewrite). Set by TED's
--      Customer 360 through PUT /v1/ivr/admin/customers/{id}/entitlement
--      {"assist_enabled": true}. The assistant is available only when this is
--      true AND customers.ivr_enabled AND the API's IVR_ASSIST_ENABLED flag
--      AND TED_BASE_URL + TED_IVR_ASSIST_TOKEN are set.
--   2. ivr_assist_jobs — one row per customer message (one "job"). The API
--      worker that accepted the message runs it (an asyncio task) and keeps
--      ALL state here, so any API worker answers the poll.
--        * status running -> done | failed (a row still 'running' after
--          300 s reads as failed: the worker died);
--        * message = the customer's own words, UN-aliased, 1..2000 chars
--          (the aliased form is rebuilt per request, never stored);
--        * result = {"public": <the customer-facing result>, "state":
--          {"external_numbers": [...]}} — the conversation's outside numbers
--          (stable [N<n>] aliases) live in "state" and never reach a client;
--        * error_code = the customer-facing job error (§5.3);
--        * rounds / ted_request_ids = TED calls made (propose + <= 2 repairs);
--        * outcome = what the customer did with a proposal, recorded once.
--   3. Indexes: the per-customer daily cap (customer_id, created_at); the
--      running-job check as a UNIQUE partial index (at most ONE running job
--      per flow, enforced by the database); conversation history
--      (conversation_id, created_at); the 90-day retention delete
--      (created_at).
--   4. Grants: api = SELECT/INSERT/UPDATE/DELETE on ivr_assist_jobs; nothing
--      for freeswitch, grafana_ro or PUBLIC (24's ALTER DEFAULT PRIVILEGES
--      would otherwise make the table readable by the anonymous NOC Grafana —
--      the REVOKE below is load-bearing, as in 54/59).
--
-- Guards beyond the contract column list (all additive):
--   * (flow_id, customer_id) -> call_flows (id, customer_id) ON DELETE
--     CASCADE: a job can only ever belong to a flow of ITS OWN customer
--     (59's call_flows_id_customer_key is the target).
--   * CHECKs tie the state machine together: failed <=> error_code set;
--     running <=> finished_at NULL; an outcome only on a done job and
--     together with outcome_at; rounds 0..3 (propose + 2 repairs).
--   * user_id -> users(id) ON DELETE SET NULL (the job outlives a deleted
--     user; the per-user rate limit is in Redis / memory, not here).
--
-- RETENTION: rows older than 90 days are deleted opportunistically by the API
-- whenever a job is created (bounded batch) — no cron.
--
-- LOCKING: the customers ADD COLUMN takes a brief ACCESS EXCLUSIVE lock and
-- customers is read on the call path (and the lock is WAL-replayed on every
-- zone replica). lock_timeout makes the migration FAIL FAST instead of
-- queueing call-setup reads behind it; if it times out, just re-run it.
--
-- PRODUCTION NOTE: init scripts only run on the first initdb of a fresh data
-- directory. The production primary already exists, so apply MANUALLY on the
-- bare-metal East primary (services VM) as a SUPERUSER; it replicates to every
-- zone replica. Requires 59 (call_flows) — refuses to run without it. Apply
-- BEFORE the API build that serves the Flow assistant (the API reads the new
-- column only once it exists — an older schema simply reports the assistant
-- as unavailable):
--     hostname | grep -q '^services$' && sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/61_ivr_assist.sql
--
-- Verification (after applying):
--     sudo -u postgres psql -d voip -f /opt/revup/scripts/db/check_migrations.sql
--   Expect "61_ivr_assist | applied".
--
-- Rollback: set IVR_ASSIST_ENABLED=false on the services VM (the assistant
-- disappears from every builder). Never DROP the table or the column.
-- ==========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- 61's jobs belong to call flows (59).
DO $$
BEGIN
    IF to_regclass('public.call_flows') IS NULL THEN
        RAISE EXCEPTION '61_ivr_assist.sql requires 59_ivr.sql (call_flows is missing) — apply 59 first';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Per-customer opt-in (contract §8). Turning IVR off leaves this as it is;
--    the assistant also needs IVR, so it is unavailable either way.
-- ---------------------------------------------------------------------------
ALTER TABLE customers ADD COLUMN IF NOT EXISTS ivr_assist_enabled BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 2. ivr_assist_jobs (contract §9).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ivr_assist_jobs (
    id               UUID PRIMARY KEY,
    customer_id      INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    flow_id          BIGINT NOT NULL REFERENCES call_flows(id) ON DELETE CASCADE,
    user_id          INT NULL REFERENCES users(id) ON DELETE SET NULL,
    conversation_id  UUID NOT NULL,
    status           VARCHAR(10) NOT NULL DEFAULT 'running',
    message          TEXT NOT NULL,
    result           JSONB NULL,
    error_code       VARCHAR(32) NULL,
    rounds           SMALLINT NOT NULL DEFAULT 0,
    ted_request_ids  TEXT[] NOT NULL DEFAULT '{}',
    outcome          VARCHAR(10) NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at      TIMESTAMPTZ NULL,
    outcome_at       TIMESTAMPTZ NULL,
    CONSTRAINT ivr_assist_jobs_status_chk
        CHECK (status IN ('running', 'done', 'failed')),
    CONSTRAINT ivr_assist_jobs_message_chk
        CHECK (char_length(message) BETWEEN 1 AND 2000),
    CONSTRAINT ivr_assist_jobs_error_code_chk
        CHECK (error_code IS NULL
               OR error_code IN ('assistant_unavailable', 'assistant_busy', 'assistant_failed')),
    CONSTRAINT ivr_assist_jobs_failed_has_code_chk
        CHECK ((status = 'failed') = (error_code IS NOT NULL)),
    CONSTRAINT ivr_assist_jobs_finished_chk
        CHECK ((status = 'running') = (finished_at IS NULL)),
    CONSTRAINT ivr_assist_jobs_rounds_chk
        CHECK (rounds BETWEEN 0 AND 3),
    CONSTRAINT ivr_assist_jobs_request_ids_chk
        CHECK (cardinality(ted_request_ids) <= 3),
    CONSTRAINT ivr_assist_jobs_outcome_chk
        CHECK (outcome IS NULL OR outcome IN ('accepted', 'discarded')),
    CONSTRAINT ivr_assist_jobs_outcome_at_chk
        CHECK ((outcome IS NULL) = (outcome_at IS NULL)),
    CONSTRAINT ivr_assist_jobs_outcome_done_chk
        CHECK (outcome IS NULL OR status = 'done'),
    CONSTRAINT ivr_assist_jobs_result_object_chk
        CHECK (result IS NULL OR jsonb_typeof(result) = 'object')
);

-- A job's flow must be a flow of the job's own customer.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'ivr_assist_jobs'::regclass
           AND conname = 'ivr_assist_jobs_flow_same_customer_fk'
    ) THEN
        ALTER TABLE ivr_assist_jobs
            ADD CONSTRAINT ivr_assist_jobs_flow_same_customer_fk
            FOREIGN KEY (flow_id, customer_id)
            REFERENCES call_flows (id, customer_id) ON DELETE CASCADE;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Indexes.
-- ---------------------------------------------------------------------------
-- Daily cap: count(*) WHERE customer_id = $1 AND created_at >= <UTC midnight>.
CREATE INDEX IF NOT EXISTS idx_ivr_assist_jobs_customer_created
    ON ivr_assist_jobs (customer_id, created_at);
-- Running-job check, enforced: at most one running job per flow.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ivr_assist_jobs_running_flow
    ON ivr_assist_jobs (flow_id) WHERE status = 'running';
-- History: the earlier jobs of one conversation, oldest first.
CREATE INDEX IF NOT EXISTS idx_ivr_assist_jobs_conversation
    ON ivr_assist_jobs (conversation_id, created_at);
-- Retention: DELETE ... WHERE created_at < now() - 90 days (bounded batch).
CREATE INDEX IF NOT EXISTS idx_ivr_assist_jobs_created
    ON ivr_assist_jobs (created_at);

COMMENT ON TABLE ivr_assist_jobs IS
    'Visual IVR Flow assistant jobs (docs/IVR_ASSIST_INTERFACES.md §5/§9): one row per customer message; state for every API worker.';
COMMENT ON COLUMN ivr_assist_jobs.message IS
    'The customer''s own words, un-aliased (1..2000 chars). The aliased request is rebuilt per TED call and never stored.';
COMMENT ON COLUMN ivr_assist_jobs.result IS
    '{"public": customer-facing result (§5.2), "state": {"external_numbers": [...]}} — "state" never reaches a client.';
COMMENT ON COLUMN customers.ivr_assist_enabled IS
    'Visual IVR Flow assistant opt-in (TED Customer 360). Also needs ivr_enabled and the API flag.';

-- ---------------------------------------------------------------------------
-- 4. Grants (role-guarded: an unguarded GRANT aborts the whole migration on
--    a cluster that lacks the role — see 47's header).
-- ---------------------------------------------------------------------------
REVOKE ALL ON ivr_assist_jobs FROM PUBLIC;

DO $$
DECLARE
    r TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON ivr_assist_jobs TO api;
    END IF;

    -- No access for the call-path role or the (anonymous) NOC Grafana role;
    -- undo 24's ALTER DEFAULT PRIVILEGES for this table.
    FOREACH r IN ARRAY ARRAY['freeswitch', 'grafana_ro'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('REVOKE ALL ON ivr_assist_jobs FROM %I', r);
        END IF;
    END LOOP;
END $$;

COMMIT;
