-- Migration: AI voice-agent runtime — config + per-call sessions
-- ============================================================================
-- Adds the two tables behind the in-boundary "Bring-Your-Own-AI" voice-agent
-- runtime (docker/api/src/services/ai_agent.py + routers/ai_agents.py):
--
--   ai_agents          — tenant-owned agent CONFIG (prompt, greeting, per-agent
--                        STT/LLM/TTS provider selection + base_urls, tool defs,
--                        fallback destination, guardrails). Read by the runtime
--                        via services/ai_config.load_agent_config().
--
--   ai_agent_sessions  — one row PER CALL handled by an agent (agent_id,
--                        call_uuid, customer_id, start/end, turn count, outcome,
--                        transcript, tool-call summary, and cost inputs:
--                        stt_seconds / llm_*_tokens / tts_characters).
--
-- SECRETS ARE NOT STORED HERE. A cloud agent references an ENV VAR NAME in
-- *_api_key_ref (e.g. 'OPENAI_API_KEY'); the runtime resolves the real key from
-- the process env. This keeps provider keys out of tenant-readable config and
-- out of any transcript/backup. Self-hosted providers need no key at all, which
-- is the default — nothing forces PHI/CPNI out of the VPC.
--
-- COMPLIANCE / transcript-at-rest: ai_agent_sessions.transcript is JSONB and is
-- written only when the agent's store_transcript flag is true. When a tenant
-- handles PHI/CPNI, transcripts should ride the platform's encryption-at-rest
-- story (see services/voicemail_crypto.py envelope pattern) OR store_transcript
-- should be set false so nothing is persisted. That crypto is a DOCUMENTED
-- HANDOFF to the compliance owner — intentionally NOT implemented in this wave.
--
-- Why a migration (not init/): init/*.sql only runs on first `initdb`. Existing
-- databases (production Services VM + any already-initialized local volume) must
-- get these tables via this migration. **Migrations are applied BY HAND** — there
-- is no Alembic/auto-runner yet. Run this on every environment BEFORE deploying
-- the API build that references these tables.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS, so it is
-- safe to run repeatedly. Least-privilege: the runtime `api` role has no CREATE
-- on schema public, so this is provisioned by migration WITH explicit grants to
-- `api` (same pattern as 27_schema_call_flows.sql / 25_schema_recordings.sql).
-- FreeSWITCH/Lua never read these tables (the flow layer emits the WS URL; the
-- API serves it), so no `freeswitch` grant is needed.
--
-- Apply (production Services VM, bare-metal PostgreSQL, DB 'voip'):
--
--   sudo -u postgres psql -d voip -f /opt/revup/docker/postgres/migrations/2026-07-01_ai_voice_agents.sql
--
-- Verify afterwards:
--
--   sudo -u postgres psql -d voip -c "\d ai_agents"
--   sudo -u postgres psql -d voip -c "\d ai_agent_sessions"
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- ai_agents — tenant-owned agent configuration
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_agents (
    id                    INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id           INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    name                  TEXT NOT NULL,
    enabled               BOOLEAN NOT NULL DEFAULT true,

    system_prompt         TEXT NOT NULL DEFAULT 'You are a helpful voice assistant answering a phone call. Keep replies short and spoken-friendly.',
    greeting              TEXT,

    -- Speech-to-text provider (self-hosted Whisper HTTP is the default path).
    stt_provider          TEXT,           -- whisper_http | deepgram | noop | ...
    stt_model             TEXT,
    stt_language          TEXT,
    stt_base_url          TEXT,           -- self-hosted whisper server base URL
    stt_api_key_ref       TEXT,           -- ENV VAR NAME (not the secret)

    -- LLM provider (OpenAI-compatible; self-hosted vLLM/Ollama by default).
    llm_provider          TEXT,           -- openai_compat | azure | ...
    llm_model             TEXT,
    llm_base_url          TEXT,           -- e.g. http://vllm:8000/v1
    llm_api_key_ref       TEXT,           -- ENV VAR NAME (not the secret)
    temperature           NUMERIC(4,2) NOT NULL DEFAULT 0.4,
    max_tokens            INT NOT NULL DEFAULT 512,

    -- TTS provider (self-hosted Piper/HTTP by default).
    tts_provider          TEXT,           -- http | openai | elevenlabs | ...
    tts_voice             TEXT,
    tts_model             TEXT,
    tts_base_url          TEXT,           -- self-hosted TTS server base URL
    tts_api_key_ref       TEXT,           -- ENV VAR NAME (not the secret)

    -- Behavior / guardrails.
    tools                 JSONB NOT NULL DEFAULT '[]'::jsonb,   -- extra tool/function defs
    fallback_destination  TEXT,           -- E.164/extension to transfer to on failure
    max_turns             INT NOT NULL DEFAULT 40,
    max_duration_seconds  INT NOT NULL DEFAULT 600,
    barge_in_enabled      BOOLEAN NOT NULL DEFAULT true,
    store_transcript      BOOLEAN NOT NULL DEFAULT true,          -- per-agent compliance switch

    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Listing: by owning customer (tenant scoping) + lifecycle filter.
CREATE INDEX IF NOT EXISTS idx_ai_agents_customer ON ai_agents (customer_id);
CREATE INDEX IF NOT EXISTS idx_ai_agents_customer_enabled
    ON ai_agents (customer_id, enabled) WHERE enabled = true;

-- ---------------------------------------------------------------------------
-- ai_agent_sessions — one row per call handled by an agent
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_agent_sessions (
    id                    INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    agent_id              INT NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
    call_uuid             VARCHAR(64),
    customer_id           INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

    status                VARCHAR(16) NOT NULL DEFAULT 'active',   -- active | completed | failed
    outcome               VARCHAR(32),                             -- transferred | completed_by_tool | no_input | max_duration | ...
    turn_count            INT NOT NULL DEFAULT 0,

    transcript            JSONB,          -- turn-by-turn (NULL when store_transcript=false)
    tool_calls            JSONB,          -- summary of tool invocations
    result                JSONB,          -- captured structured data / disposition

    -- Cost inputs (for metering / billing).
    stt_seconds           NUMERIC(10,2),
    llm_prompt_tokens     INT,
    llm_completion_tokens INT,
    tts_characters        INT,

    started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at              TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lookups: sessions for an agent; tenant scoping; correlate to a call leg.
CREATE INDEX IF NOT EXISTS idx_ai_sessions_agent ON ai_agent_sessions (agent_id);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_customer ON ai_agent_sessions (customer_id);
CREATE INDEX IF NOT EXISTS idx_ai_sessions_call_uuid ON ai_agent_sessions (call_uuid);

-- ---------------------------------------------------------------------------
-- Grants — runtime API role needs row CRUD (least-privilege: no DDL). No
-- freeswitch grant: the call path does not read these tables.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ai_agents TO api;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ai_agent_sessions TO api;

-- Grant USAGE on the owning IDENTITY sequences so INSERTs can draw nextval.
-- (Resolved dynamically + idempotently; identity sequences have generated names.)
DO $$
DECLARE
    seqname TEXT;
BEGIN
    seqname := pg_get_serial_sequence('public.ai_agents', 'id');
    IF seqname IS NOT NULL THEN
        EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO api', seqname);
    END IF;
    seqname := pg_get_serial_sequence('public.ai_agent_sessions', 'id');
    IF seqname IS NOT NULL THEN
        EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO api', seqname);
    END IF;
END $$;

COMMIT;
