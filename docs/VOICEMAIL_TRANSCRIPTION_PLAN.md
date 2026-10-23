# Voicemail Transcription (v1.1): Design Plan

**Status:** design for review, 2026-10-23. Nothing is built yet. Branch `docs/voicemail-transcription-plan`, cut from `origin/RCF-V1` @ `541c1bd`.
**Extends:**
- `docs/ENCRYPTED_VOICEMAIL_BUILD_PLAN.md`: decisions D1–D8. Transcription was out of scope for v1 (§7).
- `docs/ENCRYPTED_VOICEMAIL_INTERFACES.md`: the v1 as-built contract. Where the two disagree, v1 wins unless this plan names the change.

**Migration:** `56_voicemail_transcription.sql`. Migration 55 is the CDR quality fix.
- The §4 DDL was dry-run on a throwaway local PostgreSQL 16.15, on top of the real 02–34 prerequisites and `54_voicemail.sql`.
- It applied twice cleanly (idempotent).
- These all behaved as specified: the discovery, claim, finalize, fence, reaper, retry, backfill and orphan SQL in §6, §9 and §10; the trigger; the CHECKs; the composite FK; and the `api`, `freeswitch` and `grafana_ro` grants.
**Audience:** three build agents working in parallel (§19). The owner runs every GCP step (§15).

---

## 0. Summary and decisions

When a stored voicemail lands in a mailbox that has transcription switched on, an API background worker transcribes it, typically 10–20 s after the deposit. The flow:
1. The worker decrypts the audio **in RAM**.
2. It splits the audio into ≤ 55 s pieces at quiet points.
3. It sends each piece inline to **Google Cloud Speech-to-Text V2 synchronous `Recognize`**, at the **`us`** multi-region endpoint, using the **`telephony`** model.
4. It seals the transcript under the customer's existing KMS KEK. Each transcript gets a fresh DEK, and the AAD is `vmt:{customer}:{mailbox}:{msg_uuid}`.
5. It stores the ciphertext in Postgres.

The FreeSWITCH deposit path does not change. `deposit.py` is untouched, and the queue is discovered by polling. Every purge path deletes the transcript too, and crypto-erase makes it unreadable at once. Nothing is sent to Google unless the platform flag is on **and** the mailbox has opted in.

| # | Decision | Why (details in the section named) |
|---|---|---|
| T1 | **Speech-to-Text V2, synchronous `Recognize`, inline `content`, one request per ≤ 55 s piece** | This is the only Google method that keeps audio in memory and covers 300 s. V1 `LongRunningRecognize` needs a GCS URI for audio over ~1 min, V2 `BatchRecognize` takes GCS only, and V2 streaming is capped at 5 min of near-real-time audio. Each of the GCS options would need a plaintext GCS object, which D8 forbids. §2.1 |
| T2 | **Location `us`.** Endpoint `us-speech.googleapis.com`, recognizer `projects/rugged-night-193017/locations/us/recognizers/_` | Keeps processing in the US. The implicit `_` recognizer means there is no recognizer resource to create, so no admin-write IAM is needed. §2.3 |
| T3 | **Model `telephony`** is the default. `chirp_3` can be chosen by env (`VOICEMAIL_STT_MODEL`). Language defaults to `en-US`; `es-US` and `fr-CA` are allowed. | Google recommends `telephony` for 8 kHz phone audio, and it supports confidence. Google says Chirp 3's confidence "isn't truly a confidence score". All three languages have `telephony` in `us`. §2.4 |
| T4 | **LINEAR16 at the WAV's native rate** (8000 Hz from FS), mono, `ExplicitDecodingConfig` | Lossless, no resampling (Google's best practice). §2.4 |
| T5 | **Chunk planner:** cut at the quietest 300 ms between 40 and 55 s, trim leading and trailing silence, skip silent pieces, and treat all-silent audio as `empty` with no API call | Respects the 60 s / 10 MB sync limit without cutting words. Avoids paying for FreeSWITCH's 5 s silence tail. §7 |
| T6 | **Transcript is encrypted** with the same customer KEK envelope: a fresh DEK, AES-256-GCM, AAD `vmt:`. The ciphertext goes in **Postgres** (`voicemail_transcripts.ciphertext`), not GCS. | It is small (≤ 64 KiB), it commits atomically with the job state, and it leaves no orphan objects. Erase and retention are row operations. §4, §5 |
| T7 | **Durable queue = `voicemail_transcripts` rows.** Columns hold status, attempts, `next_attempt_at`, lease and fencing `attempt_id`. A worker runs in every uvicorn process. One process at a time discovers new stored messages (`pg_try_advisory_xact_lock`), claims use `FOR UPDATE SKIP LOCKED`, and the finalize is fenced. | Leaves `deposit.py` and the 11 s FS deadline untouched. PgBouncer transaction mode rules out LISTEN/NOTIFY, so polling is needed anyway. §6 |
| T8 | **Lifecycle:** a purge trigger on `voicemail_messages`, an FK `ON DELETE CASCADE`, explicit deletes in mailbox delete and crypto-erase, and a retention orphan arm | Retention, user purge, mailbox delete and erase all remove transcripts automatically, including any future purge path. §9 |
| T9 | **`voicemail_boxes.transcription_enabled` defaults to `false`** for existing and new mailboxes. Tenant writers (`user`) and admins may change it; `readonly` may not. `transcription_language` defaults to `en-US`. | Sending audio to a new subprocessor is opt-in. Open question Q1 covers the new-mailbox default. §10 |
| T10 | **Fail-closed platform flag** `VOICEMAIL_TRANSCRIPTION_ENABLED`, on only if exactly `true`, default off. Plus a rolling 24 h billed-minutes cap (default 1000 min/day) and per-process circuit breakers. | Nothing leaves the platform until the owner turns it on. A bug cannot run up an unbounded bill. §6.8, §12 |
| T11 | **List endpoints never decrypt.** The message list carries `transcript.status` and `confidence` only. Snippets come from a separate batch endpoint that decrypts only the visible page (≤ 50 ids), is audited once per batch, and is cached per id in the browser. The full text is decrypted per request in the reading pane and audited as `transcript_view`. | The list stays fast and independent of KMS. KMS work is bounded and is not repeated on every list refetch. §10.3 |
| T12 | **IAM:** `roles/speech.client` on `vm-api`, a project-level additive binding, and `speech.googleapis.com` enabled. Both are owner-run on a **shared** project. | The narrowest predefined role with `speech.recognizers.recognize`. It cannot create or delete Speech resources. §2.5, §15 |
| T13 | **Client:** `google-cloud-speech>=2.38.0,<3` (`google.cloud.speech_v2`), on a dedicated `vm-stt` thread pool, `retry=None`, 60 s per RPC | Same pattern as KMS and GCS (`_gcp.py`). STT calls can never take the threads deposits use for KMS/GCS. §8 |
| T14 | **Cost:** $0.016/min (V2 standard, first 500k min/month, billed per second, each request rounded up to 1 s). About $0.008 per 30 s message, about $80/month at 10k messages. | §17 |

---

## 1. Invariants (carried over from v1 plus new ones)

1. **D8, RAM-only plaintext.** Decrypted audio and transcript text exist only in API process memory, the browser, and Google's in-memory processing.
   - Never write either to disk, a temp file, a log, an exception message, or a GCS object.
   - The API container keeps its `/tmp` tmpfs and `core: 0`.
2. **The deposit path is untouched.**
   - No edit to `deposit.py`, `vm_deposit.lua` or the deposit SQL.
   - The only thing migration 56 adds on that path is an `AFTER UPDATE OF status` trigger whose `WHEN` clause is false for every deposit transition (`pending`/`failed` → `stored`). It costs one predicate check per finalize.
3. **Envelope crypto.**
   - One fresh DEK per transcript. The KMS wrap and the AES-GCM use the same AAD.
   - The AAD prefix `vmt:` is distinct from `vm:` (audio) and `vmg:` (greetings), so a transcript blob or its wrapped DEK moved onto any other row fails authentication.
   - The worker **never creates** a KEK. It only uses an `active` key that already exists.
4. **Tenant scope is the same as for messages:** `vm_scope`, 404 no-leak, `support` → 403, `readonly` reads only.
5. **Audit is fail-closed.**
   - Showing transcript text requires a committed `transcript_view` row.
   - A stored transcript requires a `transcribe` row in the same transaction.
6. **Every query is bounded and indexed.** These are plain tables, not Timescale, but the 2026-10-23 incident applies anyway:
   - Every worker statement has a point or range predicate on an index and a `LIMIT`.
   - Every worker transaction starts with `SET LOCAL statement_timeout = '5s'`.
   - There is no table-wide UPDATE anywhere.
7. **Never log transcript text, snippets, request or response objects, or audio.**
   - Logs carry ids, counts, durations, the gRPC status code and the exception class only.
   - Library debug logging that could dump payloads is refused at config time (§12).
8. **US-only processing.** The location is pinned to `us`. Any other value makes transcription unavailable.

---

## 2. Choosing the Google API (verified against Google's docs on 2026-10-23)

### 2.1 Methods vs D8

| Method | Inline audio (no GCS)? | Covers a 300 s message? | Verdict |
|---|---|---|---|
| V2 `Recognize` (sync) | Yes. "Audio can be sent inline or as a Cloud Storage URI." | **No, alone.** Each request is "limited to 10 MB or 1 minute of audio duration (whichever is reached first)". | **Chosen**, with ≤ 55 s chunks |
| V1 `LongRunningRecognize` | Only up to ~1 min: "Audio longer than ~1 minute must use the uri field to reference an audio file in Cloud Storage." | Only via GCS | Rejected: it needs a plaintext GCS object, which D8 forbids |
| V2 `BatchRecognize` (incl. dynamic batch at $0.003/min) | No. "Audio must be a Cloud Storage URI." | Yes | Rejected (D8) |
| V2 `StreamingRecognize` | Yes, 25 KB per request | "A stream can stay open for up to 5 minutes. Audio must be sent close to real-time speed." | Rejected: a 300 s (+5 s grace) message takes ≥ 300 s of wall clock with plaintext held the whole time, and it hits the 5 min edge |

Synchronous recognition also has the strongest data-handling statement (§2.3): "Google processes it in memory and does not store any customer data." Asynchronous transcripts are stored "for a period of approximately 5 days".

### 2.2 Limits we design to

| Limit | Value | How we comply |
|---|---|---|
| Sync audio per request | ≤ 1 min **and** ≤ 10 MB | Pieces are ≤ 55 s. 55 s of 8 kHz LINEAR16 is 880 KB; at 16 kHz it is 1.76 MB. |
| Sync request rate | 300 / min per region (project quota, **shared with other teams**) | At most `4 processes × 1 job × 2 parallel pieces` = 8 RPCs in flight. Realistic peak is ≪ 100/min. |
| Billing | Per second; "Each request is rounded up to the nearest increment of 1 seconds" | A 300 s message is about 6 requests, so at most about 6 s of rounding (2 %). |
| Latency | Google publishes no SLO for sync | **Estimate:** a few seconds per ≤ 55 s piece. End to end it is about 10–20 s after the deposit (≤ 10 s poll + decrypt + STT), and up to about 30 s for a 300 s message. Every job logs `stt_ms` and `total_ms`, and the live test (§16) records real numbers. |

### 2.3 Data handling, residency and logging

- **No storage for sync requests.** Google's Data usage FAQ says of synchronous and streaming requests that "Google processes it in memory and does not store any customer data". Only request metadata (time, size) is logged temporarily.
  - That FAQ sits in the V1 docs section and says nothing either way about V2. That is why the live test (§16) checks the log side too.
- **Data logging is opt-in and off by default.** "By default, Cloud Speech-to-Text does not log customer audio data or transcripts."
  - The opt-in program and its discounted SKU exist **only for V1**: the pricing page lists "Speech Recognition (with data logging)" under V1 only, and V2 has a single Standard recognition SKU.
  - V1's opt-in is a **project-level** setting. In this **shared** project another team could switch it on without us knowing. Using V2 removes that exposure entirely. **This is a deciding reason for V2.**
- **US residency.** We use the `us` multi-region (`us-speech.googleapis.com`; the V2 Chirp 3 sample builds `f"{REGION}-speech.googleapis.com"` with `REGION = "us"`).
  - Google's regional-endpoint page says "your data at-rest and in-use will stay within the continental boundaries of Europe or the USA."
  - The V2 migration guide calls V2 "a fully regionalized service".
  - Single-region processing is not offered ("Limiting processing to a single Google Cloud region is not supported"); the multi-region is the finest grain available.
- **Cloud Audit Logs.** V2 `Recognize` is a **Data Access (DATA_READ)** method (`speech.recognizers.recognize - DATA_READ`).
  - Data Access logs are off unless enabled. The voicemail v1 setup enabled them for `cloudkms` and `storage` only.
  - In a shared project other teams can often read Cloud Logging, so a log that carried response payloads would leak transcripts.
  - Google's audit-logging page does not say whether request or response content is included. §15.1 step 4 checks that `speech.googleapis.com` (or `allServices`) is **not** Data-Access-logged. The conditional branch in §15.4 covers the case where it is.
- **Our own audit:** every transcription writes `transcribe` to `voicemail_access_log` (provider, model, location, language, durations; no text). This is the record of each disclosure to the subprocessor.

### 2.4 Model, language, encoding and features

- **Model `telephony`:** "Use this model for audio that originates from an audio phone call, typically recorded at an 8 kHz sampling rate."
  - In `us`, en-US `telephony` supports automatic punctuation, model adaptation, **word-level confidence**, profanity filter, spoken punctuation and spoken emoji.
- **`chirp_3`** is GA in `us`, and en-US is GA for Recognize, Streaming and Batch.
  - It adds diarization and a denoiser.
  - It may be more accurate overall, but Google says its confidence value "isn't truly a confidence score", and it has no 8 kHz guidance.
  - Selectable by env for an A/B on the internal test mailbox (§16). When `chirp_3` is used, `confidence` is stored as NULL.
- **Languages in `us` with `telephony`:** `en-US`, `es-US`, `fr-CA`. Those three are the allowlist, with labels English (US), Spanish (US) and French (Canada). Adding more is a code change after checking Google's table.
- **Encoding:**
  - Use `ExplicitDecodingConfig(encoding=LINEAR16, sample_rate_hertz=<WAV rate>, audio_channel_count=1)`, sending the raw PCM slice (no WAV header) for each piece.
  - Google's guidance: "avoid re-sampling", "in telephony the rate is commonly 8000 Hz, which is the rate that should be sent", and use "a lossless codec … FLAC or LINEAR16".
  - We never transcode to MULAW (lossy) and never resample.
- **Features:**
  - `RecognitionFeatures(enable_automatic_punctuation=True, profanity_filter=False, max_alternatives=1)`.
  - No adaptation in v1.1.
  - Word time offsets and word confidence are off. We store per-result (utterance) confidence and offsets only.
- **Response fields we use:**
  - `results[].alternatives[0].transcript`
  - `results[].alternatives[0].confidence` (0.0–1.0)
  - `results[].result_end_offset` (Duration, relative to the start of the request audio)
  - `metadata.total_billed_duration` ("when available")

### 2.5 IAM and the API to enable

- **API:** `speech.googleapis.com`.
- **Role:** `roles/speech.client`, "Grants access to the recognition APIs." Its permissions:
  - `speech.adaptations.execute`
  - `speech.customClasses.{get,list}`
  - `speech.locations.{get,list}`
  - `speech.operations.{get,list,wait}`
  - `speech.phraseSets.{get,list}`
  - `speech.recognizers.{get,list,recognize}`

  It has no create, update or delete permission.
- Speech recognizers are project-scoped, so the binding is **project-level**. It is an additive `add-iam-policy-binding` for `vm-api` only. Owner commands are in §15.
- Credentials are unchanged.
  - The worker uses `_gcp.get_credentials(cfg)`: ADC as `vm-api` (runbook option A), or option B impersonation of `vm-api` through `VOICEMAIL_IMPERSONATE_SA`.
  - The VM scope `cloud-platform` already covers Speech.

### 2.6 Client library

- Add to `docker/api/requirements.txt`: `google-cloud-speech>=2.38.0,<3.0.0`, using `from google.cloud import speech_v2` and `from google.cloud.speech_v2.types import cloud_speech`.
  - The latest release is 2.41.0 (2026-10-01).
  - It requires Python ≥ 3.10 and `protobuf>=6.33.5`, and it pulls `grpcio` and `google-api-core`, which `google-cloud-kms` already brings in.
  - The builder must confirm that the resolver accepts the combination with the existing kms and storage pins by running the production Docker build.
- The client is built lazily in a worker thread with:
  - `SpeechClient(credentials=creds, client_options=ClientOptions(api_endpoint="us-speech.googleapis.com"))`
  - gRPC transport, one client per process.

---

## 3. Architecture

```
FreeSWITCH ──POST /fs/deposit──► API deposit.py (UNCHANGED) ──► voicemail_messages.status='stored'
                                                                     │  (row is the "job source")
 every uvicorn worker process (4) — lifespan task "voicemail-transcription"
 ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
 │ tick (10 s ±20 %)                                                                            │
 │  1. [pg_try_advisory_xact_lock 'vm_trx'] reap expired leases → discover new stored messages │
 │     → INSERT voicemail_transcripts (status pending | disabled per mailbox)                   │
 │  2. claim ≤ VOICEMAIL_STT_CONCURRENCY jobs: FOR UPDATE SKIP LOCKED → status processing,      │
 │     attempts+1, attempt_id, lease 600 s                                                      │
 │  3. job: load row → load_and_open (GCS ciphertext → KMS unwrap → AES-GCM, RAM) → parse WAV   │
 │     → plan chunks (to_thread) → re-check row → STT V2 Recognize ×N (vm-stt pool, 2 parallel) │
 │     → drop audio refs → build transcript JSON → seal_transcript (KMS wrap, AES-GCM)          │
 │     → fenced UPDATE status done|empty + audit 'transcribe' (one txn)                         │
 └──────────────────────────────────────────────────────────────────────────────────────────────┘
        │                                        ▲
        ▼                                        │ us-speech.googleapis.com (gRPC, TLS)
 voicemail_transcripts (ciphertext, crypto, job state)          Google STT V2 (in-memory)
        │
 UI ── GET /messages (status only) ── GET /mailboxes/{id}/transcript-snippets (≤50, decrypt) ──
    ── GET /messages/{id}/transcript (decrypt, audit transcript_view) ── retry/backfill ──
```

---

## 4. Schema: migration `56_voicemail_transcription.sql`

The migration is idempotent (`IF NOT EXISTS`, guarded constraint adds, `CREATE OR REPLACE`). It runs as **two transactions**:
- **Part 1** touches only `voicemail_boxes`, which the call path reads through the `number_routing` voicemail arm, so its ACCESS EXCLUSIVE window covers just two metadata-only `ADD COLUMN`s and a tiny CHECK.
- **Part 2** does the rest.

Both set `lock_timeout = '5s'`; on a timeout, re-run. Apply it by hand on the East primary; it replicates to every zone.

Add the 56 line to `scripts/db/check_migrations.sql`, and add 56 to `tests/voicemail_db.py`'s script chain.

```sql
-- ==========================================================================
-- 56_voicemail_transcription.sql — voicemail transcription v1.1
-- Contract: docs/VOICEMAIL_TRANSCRIPTION_PLAN.md §4. Idempotent; two transactions.
-- Apply on the East primary (replicates to every zone):
--   sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/56_voicemail_transcription.sql
-- Apply BEFORE the API build that reads these columns. The v1 API tolerates 56
-- (new columns have defaults; the purge trigger only DELETEs transcript rows,
-- which the api role may do).
-- ==========================================================================

-- Part 1 — per-mailbox settings. voicemail_boxes is read by number_routing on
-- the call path: keep this ACCESS EXCLUSIVE window minimal.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE voicemail_boxes
    ADD COLUMN IF NOT EXISTS transcription_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE voicemail_boxes
    ADD COLUMN IF NOT EXISTS transcription_language VARCHAR(16) NOT NULL DEFAULT 'en-US';
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'voicemail_boxes'::regclass
                      AND conname = 'voicemail_boxes_transcription_language_chk') THEN
        -- Shape only; the supported list lives in code (adding a language is
        -- not a migration).
        ALTER TABLE voicemail_boxes ADD CONSTRAINT voicemail_boxes_transcription_language_chk
            CHECK (transcription_language ~ '^[a-z]{2,3}-[A-Z]{2}$');
    END IF;
END $$;
COMMIT;

-- Part 2 — transcripts.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- 2a. FK target so a transcript's (mailbox_id, customer_id) — AAD inputs and
--     the tenant filter — can never disagree with its message (pattern of
--     54's voicemail_boxes_id_customer_key).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'voicemail_messages'::regclass
                      AND conname = 'voicemail_messages_id_box_customer_key') THEN
        ALTER TABLE voicemail_messages ADD CONSTRAINT voicemail_messages_id_box_customer_key
            UNIQUE (id, mailbox_id, customer_id);
    END IF;
END $$;

-- 2b. Discovery: the worker range-scans recently stored messages.
CREATE INDEX IF NOT EXISTS idx_vm_messages_stored_created
    ON voicemail_messages (created_at) WHERE status = 'stored';

-- 2c. One row per transcribed (or to-be-transcribed) message: job state +
--     sealed transcript. Ciphertext only — never plaintext.
CREATE TABLE IF NOT EXISTS voicemail_transcripts (
    message_id       BIGINT PRIMARY KEY,
    mailbox_id       INT NOT NULL,
    customer_id      INT NOT NULL,
    status           VARCHAR(16) NOT NULL DEFAULT 'pending',
    language         VARCHAR(16) NOT NULL,
    attempts         SMALLINT NOT NULL DEFAULT 0,
    next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_until      TIMESTAMPTZ,
    attempt_id       UUID,                 -- fencing token of the live attempt
    error_code       VARCHAR(40),          -- machine code only (§6.7), never provider text
    provider         VARCHAR(16),          -- 'gcp_stt_v2' | 'fake'
    model            VARCHAR(32),          -- 'telephony' | 'chirp_3' | 'fake'
    confidence       REAL,                 -- duration-weighted utterance confidence, 0..1
    audio_ms         INT,                  -- audio actually sent (after trim / silent-piece skip)
    billed_ms        INT,                  -- provider-reported billed duration (fallback: rounded sent)
    chunk_count      SMALLINT,
    ciphertext       BYTEA,                -- AES-256-GCM(DEK, iv, aad=vmt:..) of the transcript JSON (incl. tag)
    wrapped_dek      BYTEA,                -- KMS-wrapped DEK, same AAD
    kek_version      TEXT,                 -- CryptoKeyVersion that wrapped the DEK
    iv               BYTEA,
    enc_algo         VARCHAR(32) NOT NULL DEFAULT 'AES-256-GCM',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at     TIMESTAMPTZ,
    CONSTRAINT voicemail_transcripts_message_fk
        FOREIGN KEY (message_id, mailbox_id, customer_id)
        REFERENCES voicemail_messages (id, mailbox_id, customer_id) ON DELETE CASCADE,
    CONSTRAINT voicemail_transcripts_status_chk
        CHECK (status IN ('pending', 'processing', 'done', 'empty', 'failed', 'disabled')),
    CONSTRAINT voicemail_transcripts_language_chk
        CHECK (language ~ '^[a-z]{2,3}-[A-Z]{2}$'),
    CONSTRAINT voicemail_transcripts_attempts_chk CHECK (attempts BETWEEN 0 AND 100),
    CONSTRAINT voicemail_transcripts_lease_chk CHECK (
        status <> 'processing' OR (lease_until IS NOT NULL AND attempt_id IS NOT NULL)),
    -- Ciphertext exists exactly when status = 'done' (a half-written row can
    -- never be served; a re-queued row can never keep stale ciphertext).
    CONSTRAINT voicemail_transcripts_crypto_chk CHECK (
        (status = 'done' AND ciphertext IS NOT NULL AND wrapped_dek IS NOT NULL
                         AND kek_version IS NOT NULL AND iv IS NOT NULL)
        OR (status <> 'done' AND ciphertext IS NULL AND wrapped_dek IS NULL
                             AND kek_version IS NULL AND iv IS NULL)),
    CONSTRAINT voicemail_transcripts_iv_len_chk CHECK (iv IS NULL OR octet_length(iv) = 12),
    CONSTRAINT voicemail_transcripts_ct_len_chk
        CHECK (ciphertext IS NULL OR octet_length(ciphertext) BETWEEN 17 AND 65552),
    CONSTRAINT voicemail_transcripts_confidence_chk
        CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    CONSTRAINT voicemail_transcripts_error_code_chk
        CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,40}$')
);

CREATE INDEX IF NOT EXISTS idx_vm_transcripts_due
    ON voicemail_transcripts (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_vm_transcripts_lease
    ON voicemail_transcripts (lease_until) WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS idx_vm_transcripts_mailbox
    ON voicemail_transcripts (mailbox_id);
CREATE INDEX IF NOT EXISTS idx_vm_transcripts_completed
    ON voicemail_transcripts (completed_at) WHERE status IN ('done', 'empty');

-- 2d. Every transition of a message to 'purged' (retention, user purge,
--     mailbox delete, crypto-erase, any future path) deletes its transcript
--     in the SAME transaction. WHEN is false for every deposit transition.
CREATE OR REPLACE FUNCTION voicemail_messages_purge_transcript() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
AS $$
BEGIN
    DELETE FROM public.voicemail_transcripts WHERE message_id = NEW.id;
    RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION voicemail_messages_purge_transcript() FROM PUBLIC;

CREATE OR REPLACE TRIGGER trg_vm_messages_purge_transcript
    AFTER UPDATE OF status ON voicemail_messages
    FOR EACH ROW
    WHEN (NEW.status = 'purged' AND OLD.status IS DISTINCT FROM 'purged')
    EXECUTE FUNCTION voicemail_messages_purge_transcript();

-- 2e. Counts-only view for the NOC Grafana (no customer, no content). Runs
--     with the view owner's rights, so grafana_ro needs no table access.
CREATE OR REPLACE VIEW voicemail_transcription_stats AS
SELECT status,
       count(*)::bigint                                                         AS jobs,
       min(created_at)                                                          AS oldest_created_at,
       COALESCE(sum(billed_ms) FILTER (WHERE completed_at >= now() - interval '24 hours'), 0)::bigint
                                                                                AS billed_ms_24h
  FROM voicemail_transcripts
 GROUP BY status;

-- 2f. Grants (role-guarded, pattern of 54). 24_grafana_ro's ALTER DEFAULT
--     PRIVILEGES would otherwise hand grafana_ro SELECT on the new TABLE — the
--     REVOKE is load-bearing.
REVOKE ALL ON voicemail_transcripts FROM PUBLIC;
REVOKE ALL ON voicemail_transcription_stats FROM PUBLIC;
DO $$
DECLARE
    r TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'api') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON voicemail_transcripts TO api;
        GRANT SELECT ON voicemail_transcription_stats TO api;
    END IF;
    FOREACH r IN ARRAY ARRAY['freeswitch', 'grafana_ro'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('REVOKE ALL ON voicemail_transcripts FROM %I', r);
        END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_ro') THEN
        GRANT SELECT ON voicemail_transcription_stats TO grafana_ro;
    END IF;
END $$;

COMMIT;
```

The `check_migrations.sql` line:

```sql
('56_voicemail_transcription', to_regclass('public.voicemail_transcripts') IS NOT NULL AND EXISTS(SELECT 1 FROM c WHERE t='voicemail_boxes' AND col='transcription_enabled') AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trg_vm_messages_purge_transcript' AND NOT tgisinternal))
```

**Locks:**
- Part 1 holds ACCESS EXCLUSIVE on `voicemail_boxes` for milliseconds. That briefly queues `number_routing` reads on the primary and on every replica's WAL replay.
- Part 2's unique constraint and index build lock `voicemail_messages`, which is not on the call path. On a table this size the build takes milliseconds to about a second, and a deposit that arrives meanwhile waits inside its 11 s deadline.
- Apply it in a quiet period; per the owner's preferences, no ceremony is needed.

**Emergency-only down** (only if transcription was never switched on):
1. `DROP TRIGGER trg_vm_messages_purge_transcript ON voicemail_messages;`
2. `DROP VIEW voicemail_transcription_stats;`
3. `DROP TABLE voicemail_transcripts;`
4. `ALTER TABLE voicemail_boxes DROP COLUMN transcription_language, DROP COLUMN transcription_enabled;`

None of this is needed for a rollback (§16).

---

## 5. Crypto contract: additions to `services/voicemail/crypto.py` (re-exported from `services.voicemail`)

```python
TRANSCRIPT_AAD_PREFIX = "vmt"
MAX_TRANSCRIPT_PLAINTEXT = 65_536          # bytes of transcript JSON (ciphertext ≤ +16 tag)

def transcript_aad(customer_id: int, mailbox_id: int, msg_uuid: str | uuid.UUID) -> bytes:
    """b"vmt:{customer}:{mailbox}:{msg_uuid}" — same validation/canonicalisation as message_aad."""

@dataclass(frozen=True)
class SealedBlob:
    ciphertext: bytes      # AES-256-GCM output incl. 16-byte tag
    wrapped_dek: bytes
    kek_version: str
    iv: bytes              # 12 bytes
    enc_algo: str          # "AES-256-GCM"

async def seal_transcript(*, customer_id: int, mailbox_id: int, msg_uuid: str | uuid.UUID,
                          plaintext: bytes) -> SealedBlob:
    """Builds the vmt AAD itself (callers cannot pass a mismatched AAD).
    get_customer_key + _require_active — NEVER ensure_customer_key (the worker must not create keys);
    fresh 32-byte DEK (bytearray, zeroed) -> KMS wrap_dek(aad) -> AES-GCM(iv=os.urandom(12), aad).
    Raises ValueError (empty / > MAX_TRANSCRIPT_PLAINTEXT / bad ids), VoicemailKeyDestroyed,
    VoicemailCryptoUnavailable (KMS/DB), VoicemailIntegrityError (no key row; KMS CRC checks)."""

async def open_transcript(*, customer_id: int, mailbox_id: int, msg_uuid: str | uuid.UUID,
                          ciphertext: bytes, wrapped_dek: bytes, iv: bytes) -> bytes:
    """Validate shapes (iv 12 bytes, ciphertext 17..65552, wrapped non-empty) -> active key ->
    KMS unwrap_dek(aad) -> AES-GCM decrypt(aad). InvalidTag / KMS InvalidArgument ->
    VoicemailIntegrityError; erased -> VoicemailKeyDestroyed; KMS/DB down -> VoicemailCryptoUnavailable."""
```

- No object store and no CRC32C: the ciphertext lives in a DB row, and the GCM tag authenticates it.
- KMS calls go through the existing provider (`wrap_dek` / `unwrap_dek`: 5 s per RPC, at most 3 attempts) on the existing `vm-io` pool.
- `LocalKmsProvider` works unchanged in dev and CI.
- **Tests** (§14):
  - round trip;
  - a transcript blob or wrapped DEK moved to another message, mailbox or customer → `VoicemailIntegrityError`;
  - a transcript wrapped DEK replayed with the audio AAD (`vm:`) → integrity error, and the reverse;
  - erased key → `VoicemailKeyDestroyed`;
  - `seal_transcript` with no key row → integrity error, and **no** key is created.

**Transcript document** (the plaintext that gets sealed), in `services/voicemail/transcription/document.py`:

```json
{"v":1,"language":"en-US","model":"telephony",
 "text":"Hi, this is Dana from Granite. Please call me back about the outage on Elm Street.",
 "segments":[{"start_ms":300,"end_ms":5120,"text":"Hi, this is Dana from Granite.","confidence":0.94},
             {"start_ms":5120,"end_ms":9870,"text":"Please call me back about the outage on Elm Street.","confidence":0.89}]}
```

- Compact UTF-8 JSON.
- `text` is the segment texts joined with single spaces. Google returns them punctuated and capitalized.
- Caps: `text` ≤ 32,000 chars, ≤ 400 segments, encoded ≤ `MAX_TRANSCRIPT_PLAINTEXT`. Truncate segments and then text, with a WARNING log of counts only. A 305 s message is in practice < 10 KB.

```python
@dataclass(frozen=True)
class Segment: start_ms: int; end_ms: int; text: str; confidence: float | None
@dataclass(frozen=True)
class TranscriptDoc: language: str; model: str; text: str; segments: tuple[Segment, ...]
def encode(doc: TranscriptDoc) -> bytes                 # ≤ MAX_TRANSCRIPT_PLAINTEXT
def decode(data: bytes) -> TranscriptDoc                # ValueError on anything malformed (caller -> integrity 500)
def snippet(text: str, limit: int = 140) -> str         # whitespace collapsed; cut at a word boundary; "…" if cut
def overall_confidence(segments) -> float | None        # Σ(c·dur)/Σ(dur) over c not None and > 0; 3 dp; None if none
```

---

## 6. Worker pipeline (`services/voicemail/transcription/`)

### 6.1 Lifecycle
- `main.py` lifespan starts `transcription.worker.run_forever()` in **every** uvicorn worker, but only when `config.platform_enabled()` is true. It sits next to the retention task and is cancelled the same way on shutdown.
- The first tick comes 20–40 s after start, with jitter. After that the loop ticks every `VOICEMAIL_TRANSCRIPTION_POLL_S` (default 10, range 2–60) ± 20 %.
- The loop never raises. DB trouble, a missing migration 56 (`to_regclass('public.voicemail_transcripts') IS NULL`) and config errors are logged (ERROR at most once per 5 min) and retried on the next tick.

### 6.2 One tick

```text
if process breaker open or daily budget exhausted: return
txn A (statement_timeout 5 s):
    if pg_try_advisory_xact_lock(0x766D5F747278 /* "vm_trx" */):
        reap expired leases                         (§6.4)
        discover(window = 1 h, limit = 200)          (§6.3)
        every 15 min (process-local timer): discover(window = all, limit = 1000)   # catch-up / launch
while inflight < VOICEMAIL_STT_CONCURRENCY:
    job = claim()                                   (§6.5, own short txn)
    if job is None: break
    spawn(process(job))                             # tracked set, like deposit._spawn
```

### 6.3 Discovery: the stored message is the job source

```sql
INSERT INTO voicemail_transcripts (message_id, mailbox_id, customer_id, status, language)
SELECT m.id, m.mailbox_id, m.customer_id,
       CASE WHEN b.transcription_enabled THEN 'pending' ELSE 'disabled' END,
       b.transcription_language
  FROM voicemail_messages m
  JOIN voicemail_boxes b ON b.id = m.mailbox_id
 WHERE m.status = 'stored'
   AND m.created_at >= now() - make_interval(secs => $1::int)     -- omitted in the catch-up variant
   AND b.status <> 'deleted'
   AND NOT EXISTS (SELECT 1 FROM voicemail_transcripts t WHERE t.message_id = m.id)
 ORDER BY m.created_at
 LIMIT $2::int
ON CONFLICT (message_id) DO NOTHING;
```

- The query uses `idx_vm_messages_stored_created` plus PK anti-join probes, and both variants are LIMITed.
- **The 1 h window** covers late finalizes (a slow seal can finalize ~2 min after the INSERT).
- **The catch-up** covers worker downtime and the launch. At launch every existing message gets a `disabled` row, because every mailbox starts off.
- **Race:** a message can be purged between this SELECT and the INSERT. The FK does not check `status`, so the transcript row survives. The claim requires `m.status='stored'`, so such a row is never processed, and the retention orphan arm deletes it (§9).
- **Trashed messages** are discovered but never claimed (§6.5). Restoring one makes it claimable.

### 6.4 Lease reaper (crashed or killed process)

```sql
UPDATE voicemail_transcripts t
   SET status = CASE WHEN t.attempts >= $1::int THEN 'failed' ELSE 'pending' END,
       error_code = 'lease_expired', lease_until = NULL, attempt_id = NULL,
       next_attempt_at = now() + interval '1 minute', updated_at = now()
 WHERE t.message_id IN (SELECT message_id FROM voicemail_transcripts
                         WHERE status = 'processing' AND lease_until < now()
                         ORDER BY lease_until LIMIT 50
                         FOR UPDATE SKIP LOCKED);
```

### 6.5 Claim

```sql
WITH pick AS (
    SELECT t.message_id
      FROM voicemail_transcripts t
      JOIN voicemail_messages m        ON m.id = t.message_id
      JOIN voicemail_boxes b           ON b.id = t.mailbox_id
      JOIN customers c                 ON c.id = t.customer_id
      JOIN voicemail_customer_keys k   ON k.customer_id = t.customer_id
     WHERE t.status = 'pending' AND t.next_attempt_at <= now()
       AND m.status = 'stored' AND m.deleted_at IS NULL
       AND b.status <> 'deleted' AND b.transcription_enabled
       AND c.voicemail_enabled AND k.status = 'active'
     ORDER BY t.next_attempt_at, t.message_id
     LIMIT 1
     FOR UPDATE OF t SKIP LOCKED
)
UPDATE voicemail_transcripts t
   SET status = 'processing', attempts = t.attempts + 1, attempt_id = $1::uuid,
       lease_until = now() + make_interval(secs => $2::int),   -- LEASE_S = 600
       language = b.transcription_language, error_code = NULL, updated_at = now()
  FROM pick, voicemail_boxes b
 WHERE t.message_id = pick.message_id AND b.id = t.mailbox_id
RETURNING t.message_id, t.mailbox_id, t.customer_id, t.language, t.attempts;
```

- The claim uses `idx_vm_transcripts_due`.
- The language is taken from the mailbox **at claim time**, so changing the language affects every job that has not started.
- Pending rows that are not claimable (trashed message, customer with voicemail disabled) are skipped. There are few of them, and they are bounded.

### 6.6 Processing one job

All of this runs on the event loop except the blocking calls.

1. **Load:**
   `SELECT id, msg_uuid, mailbox_id, customer_id, object_key, wrapped_dek, iv, ciphertext_crc32c FROM voicemail_messages WHERE id=$1::bigint AND status='stored'`
   - No row → release as `failed`/`message_gone`. In practice the trigger has already deleted the row, so the UPDATE matches nothing.
2. **Decrypt:** `services.voicemail.audio.decrypt_message(row)`. This is the shared `decrypt_limiter` (6 per process); it returns bytes held in RAM.
   - `DecryptBusy` → deferral that does not count against attempts (§6.7).
3. **WAV:** `wav.parse_wav(data, noun="Recording", lenient_data_size=True)`. That gives the rate (8000 or 16000), the data offset and the size; the PCM is a `memoryview` slice with no copy.
4. **Plan:** `await asyncio.to_thread(chunking.plan_chunks, pcm, rate)` (§7).
   - `plan.speech is False` → skip STT and go to step 8 with the result `empty`. No byte leaves the platform.
5. **Re-check** right before sending, so a purge, trash or disable that happens mid-job is honoured:
   ```sql
   SELECT b.transcription_enabled FROM voicemail_transcripts t
     JOIN voicemail_messages m ON m.id = t.message_id JOIN voicemail_boxes b ON b.id = t.mailbox_id
    WHERE t.message_id = $1::bigint AND t.attempt_id = $2::uuid AND t.status = 'processing'
      AND m.status = 'stored' AND m.deleted_at IS NULL AND b.status <> 'deleted'
   ```
   - No row → abandon (drop the audio and exit; the row is gone or was reset).
   - `false` → release as `disabled`.
6. **STT:** `provider.transcribe([SttChunk(offset_ms, bytes(pcm[a:b])) for non-silent chunks], sample_rate_hz=rate, language=job.language)` (§8).
   - At most 2 pieces run in parallel on the `vm-stt` pool.
   - The whole of steps 2–6 runs under `asyncio.wait_for(..., JOB_DEADLINE_S = 300)`. On a timeout the release is transient `stt_timeout`. A thread still running is not cancelled, but the fence (step 8) discards its late result.
7. **Drop the audio.** `del` every reference to the plaintext bytes and PCM slices, and `_zero()` any `bytearray` copies (best effort; Python cannot scrub immutable `bytes`, as v1 already notes). Then build the `TranscriptDoc`:
   - text empty after stripping → result `empty`;
   - otherwise `encode()` → `seal_transcript(...)` → zero the JSON `bytearray`.
8. **Finalize.** One transaction with `statement_timeout 5s`:
   ```sql
   UPDATE voicemail_transcripts t
      SET status = $3::varchar,                         -- 'done' | 'empty'
          ciphertext = $4::bytea, wrapped_dek = $5::bytea, kek_version = $6::text,
          iv = $7::bytea, enc_algo = $8::varchar,       -- all NULL for 'empty'
          confidence = $9::real, provider = $10::varchar, model = $11::varchar,
          audio_ms = $12::int, billed_ms = $13::int, chunk_count = $14::smallint,
          error_code = NULL, lease_until = NULL, completed_at = now(), updated_at = now()
    WHERE t.message_id = $1::bigint AND t.attempt_id = $2::uuid AND t.status = 'processing'
      AND EXISTS (SELECT 1 FROM voicemail_messages m WHERE m.id = t.message_id AND m.status = 'stored')
   RETURNING t.message_id;
   ```
   - If a row came back, then in the **same transaction**: `audit.write_audit(conn, action='transcribe', source='system', customer_id, mailbox_id, message_id, detail={provider, model, location, language, status, chunks, audio_ms, billed_ms, attempts})`.
   - Zero rows → the result is discarded. The row was purged, reset by a retry, disabled or reaped, and the fence did its job.
   - A DB error → transient `db` release. The audio is re-sent on retry, which costs billing seconds only.
   - **Never** `INSERT … ON CONFLICT` here. The worker only UPDATEs a row it holds, so a purged message can never come back.
9. **Log** one INFO line, with no text: `voicemail transcription: message=%d status=%s attempts=%d chunks=%d audio_ms=%d billed_ms=%d stt_ms=%d total_ms=%d model=%s lang=%s conf=%s`.

### 6.7 Failure classes, backoff and terminal states

Every release is fenced (`WHERE message_id=$1 AND attempt_id=$2 AND status='processing'`) and sets `lease_until=NULL, attempt_id=NULL, error_code=<code>`.

| Class | Codes | Effect |
|---|---|---|
| **Transient** (counts) | `stt_unavailable` (UNAVAILABLE, INTERNAL, UNKNOWN, ABORTED, transport), `stt_timeout` (DEADLINE_EXCEEDED, job deadline), `decrypt_unavailable` (KMS or GCS down), `seal_unavailable`, `db`, `lease_expired` | `status='pending'`, `next_attempt_at = now() + BACKOFF[attempts]` ±20 %. BACKOFF is 60 s, 5 min, 30 min, 2 h. After `MAX_ATTEMPTS = 5` → `failed`. |
| **Deferral** (does not count: `attempts = attempts - 1`) | `decrypt_busy`, `stt_quota` (RESOURCE_EXHAUSTED), `stt_permission` (PERMISSION_DENIED incl. API disabled, UNAUTHENTICATED), `stt_config` (NOT_FOUND, FAILED_PRECONDITION), `budget` | `status='pending'`, `next_attempt_at = now() + 30 s` (busy) or `+ 10 min`. A permission, config or quota error also **opens the process breaker** (§6.8). |
| **Permanent** | `stt_rejected` (INVALID_ARGUMENT, OUT_OF_RANGE), `bad_wav`, `integrity` (CRC, tag or AAD failure on the audio), `key_destroyed`, `message_gone` | `status='failed'` at once. `integrity` logs ERROR; it is the same signal as an integrity failure on playback. |
| **Disabled mid-flight** | — | `status='disabled'`, no error. |

- The API shows `failed` as "Couldn't transcribe" with a retry option (§10.2).
- `error_code` is our own short code. **Never** store or return provider error text.
- Logs carry `type(exc).__name__`, the gRPC code, and at most 200 chars of `exc.message`, never `exc.details`, a request or a response.

### 6.8 Breakers and the budget (per process, in memory)

- **Process breaker.**
  - `stt_permission`/`stt_config` opens it for 10 min, and `stt_quota` for 5 min.
  - Three `stt_rejected` in a row on different messages also open it for 10 min, because that usually means a model or language config error.
  - While it is open, the process claims nothing. It logs ERROR once on opening and INFO on closing.
- **Daily budget.** Every 60 s the process reads `SELECT COALESCE(sum(billed_ms),0) FROM voicemail_transcripts WHERE status IN ('done','empty') AND completed_at >= now() - interval '24 hours'` (`idx_vm_transcripts_completed`).
  - At or above `VOICEMAIL_STT_DAILY_MINUTES_CAP × 60 000`, no claims are made. ERROR is logged at most once an hour, and jobs stay `pending`.
  - The figure is approximate: rows deleted by a purge drop out, so the cap errs toward allowing slightly more. That is acceptable for a breaker.

### 6.9 Shutdown, concurrency and memory

- **Shutdown:** the lifespan cancels the task. In-flight jobs are abandoned, and their leases expire within ≤ 600 s.
  - The reaper re-queues them as `lease_expired`, which counts as one attempt.
  - A Google call that finishes after the cancel is discarded by the fence.
- **Concurrency:** `VOICEMAIL_STT_CONCURRENCY` (default **1**, range 1–4) jobs per process, so 4 platform-wide by default. Pieces run 2 at a time on a dedicated `ThreadPoolExecutor(max_workers=2×concurrency, thread_name_prefix="vm-stt")`.
- **Thread isolation:** the 16-thread `vm-io` pool is used only for the job's KMS and GCS calls (1 unwrap + 1 download + 1 wrap). Deposits keep their threads.
- **RAM per job:** ≤ 4.8 MB of audio, plus ≤ 2 × 0.9 MB of piece copies, plus a few KB of transcript. That is about 30 MB worst case across 4 processes, well inside the API's 2 GB limit and the plan §3.2 budget.

### 6.10 Backfill and re-runs

| Operation | Who | What it does (bounded) |
|---|---|---|
| Discovery catch-up | worker | Creates the missing rows (`pending` or `disabled`). Never re-queues existing rows. |
| `POST /mailboxes/{id}/transcripts/backfill` | writer | The newest 200 stored, untrashed messages of the mailbox: inserts missing rows as `pending`, and flips `disabled` → `pending` with `attempts=0`. A mailbox holds ≤ 100 live messages, so the bound is real. |
| `POST /messages/{id}/transcript/retry` | writer | One message: `failed`/`disabled`/`empty` → `pending`, `attempts=0`. Admin `force:true` also re-runs `done` (for a model or language A/B). |
| `POST /transcription/requeue` | admin | Up to 500 `failed` rows (optionally filtered by `error_code`) → `pending`, `attempts=0`. Used after an outage or config fix. |

---

## 7. Chunk planner contract (`transcription/chunking.py`, pure, no I/O)

```python
FRAME_MS = 20
SILENCE_MEAN_ABS = 200        # = vm_box.lua M.SILENCE_THRESHOLD (FS `record` energy threshold)
MAX_CHUNK_MS = 55_000         # < Google's 60 s sync limit
MIN_CUT_MS = 40_000           # cut window [40 s, 55 s] from the piece start
QUIET_WINDOW_MS = 300
LEAD_PAD_MS = 300
TRAIL_PAD_MS = 500

@dataclass(frozen=True)
class Chunk:
    start_ms: int; end_ms: int          # on the original recording's timeline
    byte_start: int; byte_end: int      # into the PCM data (even, sample-aligned)
    silent: bool                        # every frame below SILENCE_MEAN_ABS -> not sent

@dataclass(frozen=True)
class ChunkPlan:
    sample_rate: int
    chunks: tuple[Chunk, ...]
    speech: bool                        # False -> 'empty' with no API call
    audio_ms: int                       # sum of non-silent chunk durations (what is sent)

def plan_chunks(pcm: bytes | memoryview, sample_rate: int) -> ChunkPlan: ...
```

**Algorithm:**
1. Frame energy = mean |sample| per 20 ms frame. Read the s16le samples with `array('h')` and byteswap on a big-endian host; there is no numpy and no `audioop`, which Python 3.13 removed. 300 s of audio takes about 50–150 ms of CPU, so it runs in `to_thread`.
2. A frame is **voiced** when its energy is ≥ `SILENCE_MEAN_ABS`. No voiced frame → `speech=False`, `chunks=()`.
3. Window = [first voiced − 300 ms, last voiced + 500 ms], clamped to the recording. This removes FreeSWITCH's trailing ~5 s of silence (by construction it is FS-defined silence) and the gap after the beep.
4. While the remainder is > 55 s: within [cursor + 40 s, cursor + 55 s − 300 ms], find the 300 ms run (15 frames) with the lowest summed energy, preferring the later one on ties. Cut at its centre frame boundary.
5. The final piece is ≤ 55 s and may be short.
6. Mark pieces whose every frame is below the threshold as `silent`; they are not sent.

Segment offsets are `chunk.start_ms + result offsets`, so the timeline matches the recording for a future "click a sentence to seek".

**Unit tests:**
- ≤ 55 s → one piece;
- 305 s of synthetic speech-like noise with quiet gaps → every piece ≤ 55 s, the pieces are contiguous, and every cut lies in the gap;
- a trailing 5 s at energy 150 → trimmed to 500 ms;
- all silent → `speech=False`;
- 16 kHz input;
- an odd byte count;
- a 1-frame recording;
- the plan is deterministic.

---

## 8. STT provider contract (`transcription/provider.py`, `gcp_stt.py`, `fake_stt.py`)

```python
@dataclass(frozen=True)
class SttChunk:   offset_ms: int; pcm: bytes                  # LINEAR16 mono, little-endian, no header
@dataclass(frozen=True)
class SttSegment: start_ms: int; end_ms: int; text: str; confidence: float | None
@dataclass(frozen=True)
class SttOutcome: segments: tuple[SttSegment, ...]; billed_ms: int
                  provider: str; model: str; location: str

class SttError(Exception):
    code: str                                                  # §6.7 codes
class SttTransient(SttError): ...                              # retry with backoff (counts)
class SttUnavailable(SttError): pause_s: int                   # deferral + process breaker
class SttRejected(SttError): ...                               # permanent for this audio

class SttProvider(Protocol):
    name: str; model: str; location: str
    async def transcribe(self, chunks: Sequence[SttChunk], *, sample_rate_hz: int,
                         language: str) -> SttOutcome: ...
    async def smoke(self) -> SttOutcome: ...                   # 1.0 s of digital silence, bypasses the planner

def get_stt_provider() -> SttProvider                          # per-process cache; fail closed (TranscriptionUnavailable)
```

### 8.1 `GcpSttV2Provider`

- **Request per piece:**
  ```python
  cloud_speech.RecognizeRequest(
      recognizer=f"projects/{project}/locations/us/recognizers/_",
      config=cloud_speech.RecognitionConfig(
          explicit_decoding_config=cloud_speech.ExplicitDecodingConfig(
              encoding=cloud_speech.ExplicitDecodingConfig.AudioEncoding.LINEAR16,
              sample_rate_hertz=sample_rate_hz, audio_channel_count=1),
          language_codes=[language], model=model,
          features=cloud_speech.RecognitionFeatures(
              enable_automatic_punctuation=True, profanity_filter=False, max_alternatives=1)),
      content=chunk.pcm)
  client.recognize(request=req, timeout=60.0, retry=None)      # on the vm-stt pool
  ```
- **Response:**
  - For each `result` in order that has `alternatives`: `alt = result.alternatives[0]` and `text = alt.transcript.strip()`; skip it if empty.
  - `end = chunk.offset_ms + ms(result.result_end_offset)`.
  - `start` is the previous result's end within the same piece, or `chunk.offset_ms` for the first result.
  - `confidence = alt.confidence if model == 'telephony' and alt.confidence > 0 else None`.
  - `billed_ms` = the sum of `response.metadata.total_billed_duration` over the pieces. Where Google does not return it, use the sum of `ceil(piece_seconds) × 1000` for that piece.
- **Error mapping** (`google.api_core.exceptions` and `google.auth.exceptions`):

  | Exception | Class / code |
  |---|---|
  | `ServiceUnavailable`, `InternalServerError`, `Unknown`, `Aborted`, `GatewayTimeout`, auth `TransportError`, `ConnectionError` | `SttTransient('stt_unavailable')` |
  | `DeadlineExceeded` | `SttTransient('stt_timeout')` |
  | `ResourceExhausted`/`TooManyRequests` | `SttUnavailable('stt_quota', 300)` |
  | `PermissionDenied`, `Unauthenticated`, `Forbidden` | `SttUnavailable('stt_permission', 600)` |
  | `NotFound`, `FailedPrecondition` | `SttUnavailable('stt_config', 600)` |
  | `InvalidArgument`, `OutOfRange` | `SttRejected('stt_rejected')` |
  | anything else | `SttTransient('stt_unavailable')` + ERROR log with the class name |

- **Parallelism:** 2 pieces in flight per job. If any piece raises, wait for the others, then raise the most severe class (Unavailable > Rejected > Transient). There are no partial transcripts.

### 8.2 `FakeSttProvider` (dev and CI only)

- Selected only by `VOICEMAIL_STT_PROVIDER=fake`. It is refused unless `VOICEMAIL_ALLOW_LOCAL_KMS=true` and `ENV`/`ENVIRONMENT` ≠ `production`, the same gate as the local KMS. Compose never passes `VOICEMAIL_STT_PROVIDER`.
- It is deterministic. Each piece returns one segment covering the piece, with confidence 0.9 and the text `VOICEMAIL_STT_FAKE_TEXT` (default `"This is a test transcript."`). `billed_ms` is `ceil(piece s) × 1000`.
- `VOICEMAIL_STT_FAKE_MODE` = `ok` (default) | `empty` | `transient` | `unavailable` | `rejected` | `slow` (sleeps 70 s → job deadline paths). This drives every UI state locally.
- It records the calls it received (`.calls`) so tests can assert piece bounds, rate and language.

### 8.3 `smoke.py`

Run it inside the container: `python -m services.voicemail.transcription.smoke`.
- It validates the config regardless of the platform flag, calls `provider.smoke()`, and prints `stt smoke ok: provider=gcp_stt_v2 endpoint=us-speech.googleapis.com location=us model=telephony results=0 billed_ms=1000`.
- It exits 1 with `stt smoke FAILED: <code> <ExceptionClass>`.
- It sends only generated silence, never customer data, at a cost of about 1 s.

---

## 9. Lifecycle coverage (retention, trash, purge, delete, erase, disable)

| Event | What happens to the transcript | Mechanism |
|---|---|---|
| Message moved to Trash | Kept (Trash is restorable). Not transcribed while trashed. | The claim excludes `deleted_at IS NOT NULL`. |
| Restore | Becomes claimable if still `pending`. | — |
| User purge (`DELETE /messages/{id}/purge`) | Row deleted in the purge transaction. | Trigger (`status→'purged'`). |
| Retention (expiry, trash > 30 d, deleted mailbox, erased key) | Row deleted with the message row. | Trigger. |
| Mailbox delete (`mailboxes.delete_mailbox`) | Rows deleted **immediately**, even if GCS is down and the message purge is deferred. | Added to its transaction: `DELETE FROM voicemail_transcripts WHERE mailbox_id = $1::int` (`idx_vm_transcripts_mailbox`, ≤ ~100 + trash rows). Plus the trigger later. |
| Crypto-erase (`mailboxes.erase_customer`) | Unreadable the moment the key row is marked destroyed (`open_transcript` → `VoicemailKeyDestroyed`), and the rows are deleted in the erase transaction. | Added to the erase transaction: `DELETE FROM voicemail_transcripts WHERE mailbox_id = ANY($1::int[])` over the customer's boxes. The worker's claim requires `k.status='active'`, and `seal_transcript` refuses a destroyed key. |
| Transcription disabled on a mailbox | Existing transcripts stay with their messages. `pending` jobs → `disabled`. A `processing` job is caught at the step-5 re-check. | In the PATCH transaction: `UPDATE voicemail_transcripts SET status='disabled', updated_at=now() WHERE mailbox_id=$1::int AND status='pending'`. |
| Orphan safety net | Deletes rows whose message is not `stored`, whose mailbox is deleted, or whose customer key is destroyed. This should always find 0; WARNING if not. | New step at the end of `retention.sweep_once` (under the same advisory lock), bounded: `DELETE FROM voicemail_transcripts WHERE message_id IN (SELECT t.message_id FROM voicemail_transcripts t JOIN voicemail_messages m ON m.id=t.message_id JOIN voicemail_boxes b ON b.id=t.mailbox_id LEFT JOIN voicemail_customer_keys k ON k.customer_id=t.customer_id WHERE m.status <> 'stored' OR b.status='deleted' OR k.status IS DISTINCT FROM 'active' LIMIT 500)`, looped within the run budget. |
| DB backups | Ciphertext and wrapped DEKs sit in pgBackRest and pg_dump until expiry (~35 d), exactly like v1's wrapped DEKs. Unreadable once the KEK is destroyed. | Same note as build plan Phase 6. |
| Zone replicas | Ciphertext only (physical replication), the same as v1 rows. `freeswitch` and `grafana_ro` have no grant. | Migration 56 grants. |

---

## 10. API contract (`routers/voicemail.py` + `services/voicemail/transcripts.py`)

All routes are mounted at `/v1/voicemail` and `/voicemail`; the UI calls `/api/v1/voicemail/…`. They use JWT session auth, and none is JWT-exempt.

**Scope** is exactly v1's `vm_scope`:
- admin: unscoped per id;
- tenant (`user`/`readonly`): own customer only; another customer → 404; customer with voicemail disabled → 404;
- `support` → 403;
- writer-only routes use `vm_writer`.

Every `detail` is one short sentence that the UI shows verbatim. Transcript and snippet responses carry `Cache-Control: no-store`.

### 10.1 Changed shapes (additive; existing fields unchanged)

```jsonc
// Mailbox (§4.1) — + 2 fields
{ "...": "...", "transcription_enabled": false, "transcription_language": "en-US" }

// Message (§4.2) — + 1 nested object, on EVERY route that returns a Message
// (list, PATCH, DELETE→trash, restore). confidence only when status='done'.
{ "...": "...", "transcript": { "status": "done", "confidence": 0.912 } }

// GET /summary — + 1 field (live: platform flag on AND config valid)
{ "enabled": true, "mailbox_count": 2, "unread_count": 1, "can_manage": false,
  "transcription_available": true }
```

**`transcript.status`** (the API's view) is one of `pending | processing | done | empty | failed | disabled`.
- With no row yet (the first ≤ 10 s after a deposit, or before the launch catch-up), it is derived: `pending` if the mailbox currently has `transcription_enabled`, else `disabled`.
- Implement this with a `LEFT JOIN voicemail_transcripts t ON t.message_id = m.id` (a PK probe per row) in `list_messages` and `_scoped_message`. The list SQL stays one query, decrypts nothing and never touches KMS.

**PATCH `/mailboxes/{id}`** (writer) accepts `transcription_enabled?: boolean`, `transcription_language?: "en-US"|"es-US"|"fr-CA"`.
- `true` while `transcription_available` is false → **409** "Transcription isn't available yet."
- An unknown language → **422** "Choose a supported language."
- Setting `false` flips this mailbox's `pending` rows to `disabled` in the same transaction (§9).
- Audit is the existing `mailbox_update` with `detail.fields` (field names only).
- Changing the language affects jobs not yet claimed and later retries.

**POST `/mailboxes`** (admin) gains optional `transcription_enabled` (default false; `true` while unavailable → 409) and `transcription_language`. The number-inventory assign path keeps the defaults.

### 10.2 New endpoints

| Method / path | Who | Request | Response | Errors |
|---|---|---|---|---|
| GET `/messages/{id}/transcript` | admin, tenant (incl. readonly) | — | 200 `Transcript` (below) | 404 "Message not found." · 503 "The transcript is temporarily unavailable. Try again in a few minutes." (+`Retry-After: 5`) · 500 "This transcript could not be verified and was not shown." |
| POST `/messages/{id}/transcript/retry` | writer | optional `{ "force": false }` (`force` admin-only, also re-runs `done`) | 202 `{ "message_id": 9123, "status": "pending" }` | 404 · 409 "Transcription isn't available yet." · 409 "Transcription is turned off for this mailbox." · 409 "Restore the message before transcribing it." · 409 "This message is already being transcribed." (pending or processing) · 409 "This message already has a transcript." (done, non-force) · 403 tenant `force` |
| GET `/mailboxes/{id}/transcript-snippets?ids=1,2,3` | admin, tenant | 1–50 distinct positive int ids | 200 `{ "items": [TranscriptSnippet], "unavailable": false }` | 404 mailbox · 422 "Ask for at most 50 messages at a time." / "Message ids must be numbers." |
| POST `/mailboxes/{id}/transcripts/backfill` | writer | — | 202 `{ "queued": 12 }` | 404 · 409 not available · 409 mailbox off |
| GET `/transcription/status` | **admin** | — | 200 ops JSON (§13) | — |
| POST `/transcription/requeue` | **admin** | `{ "error_code": "stt_unavailable" \| null, "limit": 1..500 }` | 200 `{ "requeued": 7 }` | 422 bad code or limit |

**`Transcript`:**
```json
{
  "message_id": 9123,
  "status": "done",
  "language": "en-US",
  "model": "telephony",
  "confidence": 0.912,
  "text": "Hi, this is Dana from Granite. Please call me back about the outage on Elm Street.",
  "segments": [{"start_ms": 300, "end_ms": 5120, "text": "Hi, this is Dana from Granite.", "confidence": 0.94}],
  "completed_at": "2026-11-02T14:03:11.204000+00:00",
  "can_retry": false
}
```

- **For any status other than `done`:** `text: null`, `segments: []` and `confidence: null`; `model` and `language` are set once known.
- **`can_retry`** = the caller is a writer **and** `transcription_available` **and** the mailbox has `transcription_enabled` **and** the message is not trashed **and** the status is one of `failed|disabled|empty`. Admins also get it for `done`, via force.
- **Decrypt and audit:** for `done`, the handler:
  1. reads the row and the message's `msg_uuid`, `customer_id` and `mailbox_id`;
  2. calls `open_transcript` (§5) under the per-process **transcript-decrypt slots** (4, `asyncio.Semaphore`; they wait up to 2 s, then 503) so transcript KMS calls can never take more than 4 of the 16 `vm-io` threads that deposits use;
  3. calls `document.decode`;
  4. **writes `transcript_view`** (`source` ui or admin, `message_id`, `detail {"kind":"full"}`) in its own transaction **before** responding. If that write fails, the response is 503 and no text is sent (fail-closed).
- **No side effects.** The GET does **not** mark the message read; the UI does that (§11.4).

**Retry SQL** (one statement; zero rows means a 409, after re-reading the status to choose the message):
```sql
INSERT INTO voicemail_transcripts (message_id, mailbox_id, customer_id, status, language)
VALUES ($1::bigint, $2::int, $3::int, 'pending', $4::varchar)
ON CONFLICT (message_id) DO UPDATE
   SET status = 'pending', attempts = 0, next_attempt_at = now(), error_code = NULL,
       ciphertext = NULL, wrapped_dek = NULL, kek_version = NULL, iv = NULL,
       confidence = NULL, completed_at = NULL, lease_until = NULL, attempt_id = NULL,
       language = EXCLUDED.language, updated_at = now()
 WHERE voicemail_transcripts.status IN ('failed', 'disabled', 'empty')     -- + 'done' when force
RETURNING status;
```

**Backfill SQL** (writer; bounded by the mailbox; uses `idx_vm_messages_mailbox_created`):
```sql
WITH cand AS (
    SELECT m.id, m.mailbox_id, m.customer_id FROM voicemail_messages m
     WHERE m.mailbox_id = $1::int AND m.status = 'stored' AND m.deleted_at IS NULL
     ORDER BY m.created_at DESC LIMIT 200)
INSERT INTO voicemail_transcripts (message_id, mailbox_id, customer_id, status, language)
SELECT id, mailbox_id, customer_id, 'pending', $2::varchar FROM cand
ON CONFLICT (message_id) DO UPDATE
   SET status = 'pending', attempts = 0, next_attempt_at = now(), error_code = NULL,
       language = EXCLUDED.language, updated_at = now()
 WHERE voicemail_transcripts.status = 'disabled'
RETURNING message_id;
```

### 10.3 Snippets: decrypt only the visible page

**`TranscriptSnippet`** is `{ "message_id": 1, "status": "done", "snippet": "Hi, this is Dana from Granite. Please call me back about the outage on…" }`.

1. Resolve the ids against **this mailbox**: `m.mailbox_id = $1 AND m.status='stored' AND m.id = ANY($2::bigint[])` joined to `voicemail_transcripts`. Ids that are not in the mailbox are silently omitted (no leak).
2. Decrypt only rows with status `done`. Go through the per-process transcript-decrypt slots (4, shared with the full-text GET), with a 2 s budget for the whole request. `document.snippet(text, 140)`.
3. A row that fails or misses the budget gets `snippet: null`, and the response sets `unavailable: true`. Snippets **never** cause a 5xx; a snippet failure must not break the inbox.
4. Write **one** `transcript_view` row per request: `message_id` NULL, `mailbox_id` set, `detail {"kind":"snippets","message_ids":[…the decrypted ids…]}`. It is written before responding. If it fails, every snippet is nulled and `unavailable: true` (fail-closed).
5. **Cost:** at most 50 KMS Decrypts per call, about 150–300 ms at 4 in parallel. The UI caches per id (§11.3), so a list refetch triggers **no** new decrypts.

**Why not plaintext snippets in the DB?**
- That would be transcript content at rest unencrypted, which breaks the "encrypted at rest" promise.
- Decrypting in the list endpoint would add KMS latency and audit writes to every list refetch, and the UI refetches the list after every mutation.

### 10.4 Audit actions (new values for `voicemail_access_log.action`)

| Action | Source | When | `detail` (never text) |
|---|---|---|---|
| `transcribe` | `system` | Transcript stored (`done` or `empty`), same transaction | `{provider, model, location, language, status, chunks, audio_ms, billed_ms, attempts}` |
| `transcript_view` | `ui` / `admin` | Full text returned, or a snippet batch returned | `{"kind":"full"}` or `{"kind":"snippets","message_ids":[…]}` |
| `transcript_request` | `ui` / `admin` | Retry or backfill accepted | `{"kind":"retry","force":false}` or `{"kind":"backfill","count":12}` |
| `transcript_requeue` | `admin` | Ops requeue | `{"error_code":…, "count":7}` |

Mailbox setting changes keep using `mailbox_update`. Update the docstring list in `audit.py`.

---

## 11. UI contract (`docker/ui/app/src`)

### 11.1 Types (`types/voicemail.ts`, additive)

```ts
export type TranscriptStatus = 'pending' | 'processing' | 'done' | 'empty' | 'failed' | 'disabled';
export type TranscriptionLanguage = 'en-US' | 'es-US' | 'fr-CA';
export const TRANSCRIPTION_LANGUAGES: readonly { id: TranscriptionLanguage; label: string }[] = [
  { id: 'en-US', label: 'English (US)' }, { id: 'es-US', label: 'Spanish (US)' }, { id: 'fr-CA', label: 'French (Canada)' },
];
export interface MessageTranscriptSummary { status: TranscriptStatus; confidence: number | null; }
// VoicemailMessage   += transcript: MessageTranscriptSummary;
// Mailbox            += transcription_enabled: boolean; transcription_language: TranscriptionLanguage;
// MailboxUpdate      += transcription_enabled?: boolean; transcription_language?: TranscriptionLanguage;
// MailboxCreate      += transcription_enabled?: boolean; transcription_language?: TranscriptionLanguage;
// VoicemailSummary   += transcription_available: boolean;
export interface TranscriptSegment { start_ms: number; end_ms: number; text: string; confidence: number | null; }
export interface Transcript {
  message_id: number; status: TranscriptStatus; language: string | null; model: string | null;
  confidence: number | null; text: string | null; segments: TranscriptSegment[];
  completed_at: string | null; can_retry: boolean;
}
export interface TranscriptSnippet { message_id: number; status: TranscriptStatus; snippet: string | null; }
export interface TranscriptSnippetPage { items: TranscriptSnippet[]; unavailable: boolean; }
```

### 11.2 API functions (`api/voicemail.ts`)

```ts
getTranscript(messageId: number): Promise<Transcript>                                   // GET  /messages/{id}/transcript
retryTranscript(messageId: number, force = false): Promise<{ message_id: number; status: TranscriptStatus }>
getTranscriptSnippets(mailboxId: number, ids: number[]): Promise<TranscriptSnippetPage>  // ids.length ≤ 50, joined with ','
backfillTranscripts(mailboxId: number): Promise<{ queued: number }>
```

### 11.3 Server state (`pages/voicemail/voicemailData.ts`)

- **A separate cache root:** `vmTranscriptKeys = { root: ['voicemail-transcript'], full: (s, id) => ['voicemail-transcript', s.key, 'full', id], snippet: (s, id) => ['voicemail-transcript', s.key, 'snippet', id] }`.
  - `invalidateVoicemail()` (the `['voicemail']` prefix, run after every mutation) must **not** refetch transcripts. Each refetch would cost a KMS decrypt and an audit row.
  - Invalidate `full(id)` explicitly after a retry, and after a status change seen in the list.
- **`useTranscript(scope, messageId, enabled)`:**
  - `staleTime: Infinity`, `retry: false` on 4xx.
  - `refetchInterval` is 5000 while the status is `pending|processing`. It stops after 3 min of continuous pending; the panel then says "Still transcribing — check back shortly."
- **`useTranscriptSnippets(scope, mailboxId, messages)`:**
  - Takes the visible items with `transcript.status === 'done'` that have no `snippet(id)` cache entry.
  - Fetches them in batches of ≤ 50, then `setQueryData(snippet(id), …)` per id with `staleTime: Infinity`.
  - A done snippet is never fetched twice in a session.
- **Folder polling:** `useFolderMessages` gets `refetchInterval: (q) => (summary.transcription_available && folder !== 'trash' && anyLoadedItem(pending|processing)) ? 10_000 : false`. This uses the React Query default, so it does not refetch in the background.
- **Never persist** transcripts or snippets: no persister and no local/session storage. D8 allows the browser's memory, nothing more.

### 11.4 Components

| Where | What |
|---|---|
| `MessageList.tsx` | A third line `vm-row-snippet` (one line, ellipsis, muted) under `vm-row-bottom`. `done` + snippet → the snippet; `done` while the snippet loads → an empty placeholder line of the same height (no layout jump); `pending`/`processing` → `vm-spin` + "Transcribing…"; `empty` → "No speech detected"; `failed` → "No transcript". Nothing for `disabled`, and nothing in the **Trash** folder for pending or processing. |
| New `TranscriptPanel.tsx`, mounted in `ReadingPane.tsx` between `<Player>` and the actions | Header "Transcript" plus the sub-line "Machine-generated — may contain mistakes." The body (`vm-tx-text`, `white-space: pre-wrap`, selectable) shows `text`. A **Copy** button writes the text to the clipboard and toasts "Transcript copied." When `confidence < 0.6`: "Low confidence — listen to the recording to be sure." The language label shows when it is not en-US. The panel is `aria-live="polite"`. The states are listed in the next table. When a `done` transcript renders and `canEdit && !message.is_read`, call `onAction('read', true)` **once**: reading the transcript counts as reading the message, and readonly users are unchanged because PATCH is writer-only. |
| `MailboxSettings.tsx`, new `TranscriptionPanel` after Details | Render it when `summary.transcription_available` **or** `mailbox.transcription_enabled`. Off/On uses the `vm-seg` segmented control (same pattern as GreetingDialog). Language uses a `dl-input` select. "Save". When enabled, a "Transcribe earlier messages" button calls backfill and toasts "Transcribing N earlier messages." / "No earlier messages to transcribe." Copy: "Transcripts are created by Google Cloud Speech-to-Text in the United States. Audio is sent over an encrypted connection, processed in memory and not kept by Google. Transcripts are encrypted at rest like your recordings and deleted with the message." Readonly gets `dl-kv` values only. Enabled but unavailable → "Transcription is paused." |
| `NewMailboxDialog.tsx` (admin) | Only when available: `vm-check` "Transcribe new messages" (default unchecked) and a language select. |
| `VoicemailIntro.tsx` | When `transcription_available`, add a point: "Read it instead — optional transcripts appear next to each message." Update the D3 comment. |
| Marketing copy | `DashboardPage.tsx:97`, `docs/GuidesPage.tsx:606` ("searchable text"), `docs/ProductSelector.tsx:50`, `landing/RequestAccessSection.tsx:232`. Remove "searchable" and "API retrieval" claims, because v1.1 has no transcript search (it is encrypted at rest) and no voicemail API. Suggested: "Every message can arrive with a written transcript alongside the audio." |
| `styles/dl-voicemail.css` | `.vm-row-snippet`, `.vm-tx`, `.vm-tx-head`, `.vm-tx-text`, `.vm-tx-note`. Reuse the existing tokens and the dark/light variants; no new colours. |

**Transcript panel states:**

| Status | What the panel shows |
|---|---|
| `pending` / `processing` | spinner + "Transcribing…" |
| `empty` | "No speech detected in this message." |
| `failed` | "We couldn't transcribe this message." + a **Try again** button when `can_retry` |
| `disabled`, mailbox off | "Transcription is off for this mailbox." + a "Turn it on in Greeting & settings" link (switches the tab) for writers |
| `disabled`, mailbox on | "This message arrived while transcription was off." + a **Transcribe** button when `can_retry` |
| 503 | "The transcript is temporarily unavailable." + **Retry** (refetch) |
| 500 | The API detail verbatim |
| `transcription_available` false and pending | "Transcription is paused." |

**Rules:** Hooks go above every early return (CLAUDE.md gotcha 4). Run `tsc --noEmit` before pushing. Test admin "View as Customer" (`customer_id = null` admin) as well as a tenant.

---

## 12. Configuration (services `.env` → `docker-compose.services.yml` → `api`)

| Variable | Default | Meaning / validation |
|---|---|---|
| `VOICEMAIL_TRANSCRIPTION_ENABLED` | unset = **off** | On only if exactly `true` (trimmed, case-insensitive). Off: no worker task, `transcription_available=false`, enabling a mailbox → 409. Existing transcripts stay readable. |
| `VOICEMAIL_STT_PROJECT` | = `VOICEMAIL_KMS_PROJECT` | Project used for the recognizer path and billing. Same regex as the KMS project. |
| `VOICEMAIL_STT_LOCATION` | `us` | **Only `us` is accepted** (US residency). Anything else → unavailable plus an ERROR. |
| `VOICEMAIL_STT_MODEL` | `telephony` | `telephony` \| `chirp_3`. |
| `VOICEMAIL_STT_CONCURRENCY` | `1` | Jobs per worker process, 1–4. |
| `VOICEMAIL_STT_DAILY_MINUTES_CAP` | `1000` | Rolling 24 h billed-minute breaker (≈ $16/day), 1–100000. |
| `VOICEMAIL_TRANSCRIPTION_POLL_S` | `10` | Tick interval, 2–60. |

**Compose:** pass the seven variables above as `- NAME=${NAME:-}`, the same pattern as the KMS variables. Do **not** pass `VOICEMAIL_STT_PROVIDER`, `VOICEMAIL_STT_FAKE_*` or `VOICEMAIL_ALLOW_LOCAL_KMS`, so production can never select the fake.

**Dev/CI only:**
- `VOICEMAIL_STT_PROVIDER=fake`, which also requires `VOICEMAIL_ALLOW_LOCAL_KMS=true` and a non-production `ENV`;
- `VOICEMAIL_STT_FAKE_MODE`;
- `VOICEMAIL_STT_FAKE_TEXT`.

**`config.available()`** never raises. It is true only when all of these hold:
- the flag is on;
- the provider config is valid;
- `GOOGLE_SDK_PYTHON_LOGGING_SCOPE` and `GRPC_TRACE` are **unset**. Google documents that this env var enables the client library's DEBUG logging, and its docs warn that "logs may contain sensitive information". Debug output could carry request or response payloads.

The worker also pins `logging.getLogger("google")` and `logging.getLogger("grpc")` to WARNING.

Credentials reuse `VOICEMAIL_IMPERSONATE_SA` and ADC through `_gcp.get_credentials`.

---

## 13. Observability (dashboards and logs only; no pagers, per the owner)

- **Logs:**
  - one INFO line per job (§6.6 step 9);
  - one WARNING per transient failure (`code`, `attempts`, `next_in_s`);
  - ERROR (rate-limited) for breaker open, budget hit, integrity, and config unavailable.
  - A test asserts that no log record during a fake transcription contains the fake text.
- **`GET /v1/voicemail/transcription/status`** (admin):
  ```json
  {"available": true, "platform_enabled": true, "provider": "gcp_stt_v2", "location": "us", "model": "telephony",
   "counts": {"pending": 0, "processing": 1, "done": 412, "empty": 9, "failed": 2, "disabled": 1310},
   "oldest_pending_age_s": 4, "failed_by_code": {"stt_rejected": 1, "integrity": 1},
   "billed_minutes_24h": 37.4, "daily_cap_minutes": 1000, "budget_exhausted": false}
  ```
  Every query is grouped and bounded by the table, which retention keeps bounded. `failed_by_code` reads `status='failed'` rows only.
- **Grafana:** `voicemail_transcription_stats` (counts only, granted to `grafana_ro`). Suggested panels are jobs by status, oldest pending, and billed minutes over 24 h.
- **Billing:** the SKU "Speech-to-Text V2 Recognition (3099-B70F-0949)" in project `rugged-night-193017`. Other teams may use Speech in the same project, so compare it with `billed_minutes_24h`.

---

## 14. Test plan

**Python** (pytest, ephemeral PG 16 like `tests/voicemail_db.py`, local KMS, memory store, fake STT):

| File | Covers |
|---|---|
| `tests/test_voicemail_migration56.py` | Applies 54 → 56 twice (idempotent). Columns and defaults. Every CHECK: `done` requires crypto, non-`done` forbids it, iv length, confidence range, language shape. Composite FK: a transcript whose mailbox or customer differs from its message → FK violation. Trigger: purge deletes the row; `stored`/`pending`/`failed` transitions do not. CASCADE. Grants: `api` has SELECT/INSERT/UPDATE/DELETE; `freeswitch` and `grafana_ro` are denied on the table; `grafana_ro` can read the view. `check_migrations` line. `EXPLAIN` of the discovery, claim and due queries uses the new indexes. |
| `tests/test_voicemail_transcription_crypto.py` | §5: round trip; AAD swaps across message, mailbox and customer; `vm:` vs `vmt:` cross-replay; erased key; no key row → no key created; size limits. |
| `tests/test_voicemail_transcription_chunking.py` | §7 cases. |
| `tests/test_voicemail_transcription_provider.py` | The GCP provider against a fake client object: the exact `RecognizeRequest` (recognizer path, explicit LINEAR16 rate and mono, model, language, features), `timeout=60`, `retry=None`, offset merge, confidence rules (telephony vs chirp_3), the billed fallback, the error mapping table, and severity aggregation across parallel pieces. Fake-provider gating (refused in production and without the local flag). `available()` false when `GOOGLE_SDK_PYTHON_LOGGING_SCOPE` is set. |
| `tests/test_voicemail_transcription_worker.py` | Discovery (`pending` vs `disabled`, the 1 h window and catch-up, the LIMIT). **Two concurrent claimers → each job claimed exactly once.** Lease reaper. Backoff schedule and `MAX_ATTEMPTS` → `failed`. Deferrals do not count. The breaker opens and closes. The budget cap blocks claims. Fenced finalize: a stale attempt is discarded. Purge during processing → no resurrection and no audit row. Trash → not claimed, restore → claimed. Disable mid-flight → `disabled`. Crypto-erase → rows deleted and the worker refuses. All-silent audio → `empty` with **zero** provider calls. A `transcribe` audit row in the same transaction. **No plaintext:** caplog has no fake text, the ciphertext column has no fake text bytes, `/tmp` is unchanged. |
| `tests/test_voicemail_transcription_api.py` (shared `voicemail_api_harness.py`) | Scope: tenant cross-tenant 404, `readonly` 200 on GET and 403 on retry, `support` 403, voicemail-disabled customer 404. `transcript_view` written, and an audit failure → 503 with no text. Snippets: ≤ 50, foreign ids omitted, one audit row, KMS down → `unavailable:true` with a 200. Retry and backfill status matrix and 409 sentences. PATCH 409 and 422, and disable flips `pending`. Message shape on list, PATCH, trash and restore. `summary.transcription_available`. Admin status and requeue are admin-only. `Cache-Control: no-store`. |
| existing `test_voicemail_deposit.py`, `test_voicemail_retention.py`, `test_voicemail_api.py` | Must pass **unchanged**. That proves the deposit path did not move. Add the retention orphan-arm cases. |

**CI:** the existing `.github/workflows/ci.yml` pytest job. Optionally a `@pytest.mark.gcp_live` test that runs one smoke, skipped unless `VOICEMAIL_STT_LIVE_TEST=1`. Agents never run it.

**UI:** `npm run build` (`tsc -b && vite build`), `npm run lint`, and a manual check in the local E2E below. The app has no unit-test runner; do not add one for this.

**Local E2E without GCP** (extends the v1 recipe in the owner's notes):
1. PG with migrations 01–56. Apply 56 twice.
2. The API image with:
   - `VOICEMAIL_KMS_PROVIDER=local VOICEMAIL_ALLOW_LOCAL_KMS=true VOICEMAIL_LOCAL_MASTER_KEY=$(openssl rand -base64 32) VOICEMAIL_STORAGE=memory`
   - `VOICEMAIL_TRANSCRIPTION_ENABLED=true VOICEMAIL_STT_PROVIDER=fake VOICEMAIL_TRANSCRIPTION_POLL_S=2`
   - **command overridden to `--workers 1`**. The memory object store is per process, so with 4 workers the transcription worker could land in a process that does not hold the deposited object.
3. Deposit through the real `vm_box.lua` driver (the stub session copies an 8 kHz WAV, e.g. `espeak-ng` speech resampled with `sox -r 8000 -c 1 -b 16`). Also deposit a 70 s file to get two pieces, and a silent file to get `empty`.
4. In the UI: switch transcription on for the mailbox → the list shows "Transcribing…" → the snippet → the reading pane text. Then:
   - `VOICEMAIL_STT_FAKE_MODE=transient|unavailable|rejected|empty|slow` → each UI state;
   - retry, backfill, disable, purge, crypto-erase;
   - View as Customer, a readonly tenant, and a second tenant (404).
5. Check:
   - `docker exec api ls -A /tmp` is empty;
   - `docker logs api | grep -c "This is a test transcript"` → 0;
   - `SELECT octet_length(ciphertext) FROM voicemail_transcripts` shows ciphertext only;
   - the `voicemail_access_log` rows (`transcribe`, `transcript_view`, `transcript_request`).

---

## 15. Owner GCP command list

> **⚠ SHARED PROJECT `rugged-night-193017`.** Every step is **additive** and touches only `speech.googleapis.com` and `vm-api`.
>
> **Never:**
> - `gcloud services disable speech.googleapis.com` (another team may use it);
> - `set-iam-policy`;
> - removing any binding other than the exact one added here;
> - OpenTofu `google_project_iam_binding` or `google_project_iam_policy` for this. Those are **authoritative** and would wipe other teams' grants.
>
> Agents never run any of these.

### 15.1 Read-only checks (workstation)
1. Is the API already enabled?
   `gcloud services list --enabled --project rugged-night-193017 --filter='config.name=speech.googleapis.com' --format='value(config.name)'`
   → empty (go on to 15.2.1), or `speech.googleapis.com` (already enabled by someone; skip 15.2.1).
2. Which identity does the services VM use?
   `gcloud compute instances describe services --zone us-east1-b --project rugged-night-193017 --format='yaml(serviceAccounts)'`
   → `vm-api@rugged-night-193017.iam.gserviceaccount.com` + `cloud-platform` (option A), or the default SA + `cloud-platform` (option B, impersonating `vm-api`). Either way the grant goes to `vm-api`.
3. Record vm-api's current project roles:
   `gcloud projects get-iam-policy rugged-night-193017 --flatten='bindings[].members' --filter='bindings.members:serviceAccount:vm-api@rugged-night-193017.iam.gserviceaccount.com' --format='value(bindings.role)'`
   → (A) `roles/logging.logWriter`, `roles/monitoring.metricWriter`, `roles/monitoring.viewer`; (B) nothing.
4. Data Access audit config:
   `gcloud projects get-iam-policy rugged-night-193017 --format='json(auditConfigs)'`
   → only `cloudkms.googleapis.com` and `storage.googleapis.com`. **If `allServices` or `speech.googleapis.com` appears with `DATA_READ`**, follow 15.4 before enabling the platform flag.
5. Org policy on service usage:
   `gcloud org-policies describe gcp.restrictServiceUsage --project rugged-night-193017 --effective`
   → no rule that denies `speech.googleapis.com` (or "policy not found / not set").

### 15.2 Changes (additive)
1. `gcloud services enable speech.googleapis.com --project rugged-night-193017`
   → `Operation "operations/…" finished successfully.` (or no output if it was already enabled)
2. `gcloud projects add-iam-policy-binding rugged-night-193017 --member=serviceAccount:vm-api@rugged-night-193017.iam.gserviceaccount.com --role=roles/speech.client --condition=None`
   → `Updated IAM policy for project [rugged-night-193017].` followed by the policy, which now contains `roles/speech.client` with the vm-api member.
   This is an etag-guarded read-modify-write of one binding. On a concurrent-edit error, re-run it.

### 15.3 Verify
1. Re-run 15.1 step 3 → also `roles/speech.client`.
2. **[services VM, after the §16 API deploy]** `sudo docker exec voip-api python -m services.voicemail.transcription.smoke`
   → `stt smoke ok: provider=gcp_stt_v2 endpoint=us-speech.googleapis.com location=us model=telephony results=0 billed_ms=1000`
   - `stt smoke FAILED: stt_permission PermissionDenied` → the binding has not propagated yet (wait about 2 min), or 15.2 was missed.
   - `stt_config NotFound` → check `VOICEMAIL_STT_PROJECT`.

### 15.4 Only if 15.1 step 4 showed Speech Data Access logging
1. After the live test's first transcription:
   `gcloud logging read 'protoPayload.serviceName="speech.googleapis.com"' --project rugged-night-193017 --freshness=1h --limit=1 --format=json`
   Look at `protoPayload.request` and `protoPayload.response`: is there any audio `content` or `transcript` text?
2. **None** → done.
3. **Present** → switch the platform flag off (§16 rollback step 1) and decide on an audit-log exemption for `vm-api` on `speech.googleapis.com`. That is an edit to the **shared** project's audit config (open question Q2). Do not edit it without that decision.

### 15.5 Optional IaC mirror (later; converges with no changes after 15.2)
In `infra/voicemail/main.tf`:
- add `"speech.googleapis.com"` to `local.apis`. The existing resource already sets `disable_on_destroy = false`.
- add:
  ```hcl
  resource "google_project_iam_member" "vm_api_speech_client" {   # NON-authoritative (member), shared project
    project = var.project
    role    = "roles/speech.client"
    member  = local.vm_api_member
  }
  ```

---

## 16. Deploy order and rollback

Commands are single-line and run on the **services VM** unless noted. Each one is run and its output checked before the next (the owner's preference).

| # | Step | Command → expected |
|---|---|---|
| 0 | GCP (§15.1, §15.2), any time before step 5. Harmless while the flag is off. | — |
| 1 | Pull the merged code | `cd /opt/revup && sudo git pull` → fast-forward |
| 2 | Migration 56 on the East primary | `sudo -u postgres psql -d voip -v ON_ERROR_STOP=on -f /opt/revup/docker/postgres/init/56_voicemail_transcription.sql` → `BEGIN … COMMIT` twice, no ERROR. Then `sudo -u postgres psql -d voip -f /opt/revup/scripts/db/check_migrations.sql` → `56_voicemail_transcription | applied` |
| 3 | API with the **flag off** (new endpoints and columns live; nothing sent anywhere) | `sudo docker compose -f docker-compose.services.yml up -d --build api` → healthy. `curl -s localhost:8088/health` → `healthy` |
| 4 | UI (toggles are hidden while `transcription_available=false`) | `sudo docker compose -f docker-compose.services.yml up -d --build ui` |
| 5 | Turn transcription on | Add `VOICEMAIL_TRANSCRIPTION_ENABLED=true` to `/opt/revup/.env`, then `sudo docker compose -f docker-compose.services.yml up -d api` |
| 6 | Smoke | §15.3 step 2 |
| 7 | Live test (internal test mailbox only) | See below |
| 8 | Customers opt in per mailbox | — |

**Live test (step 7):**
1. Switch transcription on for the internal test mailbox in the UI.
2. Call its DID and leave about 20 s with distinctive words, then a second message of about 70 s (two pieces), then one of 5 s of silence (`empty`, no API call).
3. Within about 30 s the UI shows the snippet and the text. Note the `total_ms` values from `sudo docker logs voip-api --since 10m | grep "voicemail transcription"`.
4. Check:
   - `sudo docker logs voip-api --since 30m | grep -ci "<a distinctive word you said>"` → `0`
   - `sudo docker exec voip-api ls -A /tmp` → empty
   - `sudo -u postgres psql -d voip -c "SELECT action, count(*) FROM voicemail_access_log WHERE action LIKE 'transcri%' AND created_at > now() - interval '1 hour' GROUP BY 1"` → `transcribe` and `transcript_view` rows
5. Purge one message → `SELECT count(*) FROM voicemail_transcripts WHERE message_id = <id>` → `0`.
6. Optional model A/B: set `VOICEMAIL_STT_MODEL=chirp_3`, run `up -d api`, then admin **force retry** the same messages and compare.

**Rollback:**
1. **Stop sending to Google** (seconds, no data loss): remove the flag from `.env`, then `sudo docker compose -f docker-compose.services.yml up -d api`.
   - The worker stops and the toggles hide.
   - Existing transcripts stay readable; that only needs KMS.
   - Jobs stay `pending`, and the next enable resumes them.
2. **Code:** check out the previous commit and run `up -d --build api ui`. The v1 code tolerates 56: the defaults are additive, and the trigger needs only the DELETE grant that 56 gives `api`.
3. **Schema:** leave 56 in place. The emergency down in §4 applies only if transcription was never switched on.
4. **Wipe every transcript (crypto-shred style)**, only if asked:
   - `sudo -u postgres psql -d voip -c "DELETE FROM voicemail_transcripts"`. The table is bounded by message retention.
   - The rows are re-created as `disabled` or `pending` by discovery. With the flag off, nothing runs.
5. **GCP** (optional, shared project): `gcloud projects remove-iam-policy-binding rugged-night-193017 --member=serviceAccount:vm-api@rugged-night-193017.iam.gserviceaccount.com --role=roles/speech.client --condition=None` removes **only our** binding. **Do not** disable the API.

---

## 17. Cost

**Price:** V2 Standard recognition (SKU 3099-B70F-0949). The rate is a single Standard tier and does not depend on the model.

| Monthly minutes | Rate |
|---|---|
| 0–500k | **$0.016/min** |
| 500k–1M | $0.010/min |
| 1M–2M | $0.008/min |
| 2M+ | $0.004/min |

- Billing is per second, and each request is rounded up to 1 s.
- V2 lists no free tier. V1 without data logging would be $0.024/min, and that is a further reason for V2.

**Per message:**
- The audio sent is the recording minus the trimmed leading and trailing silence. FreeSWITCH's 5 s silence tail is not billed, and all-silent messages cost $0.
- Assume an average sent duration of about 28 s, plus ≤ 1 s rounding per piece → **≈ $0.0077 per message**.
- Worst case, a 300 s message (6 pieces) → **≈ $0.08**.
- Retries add a few percent at most.

| Volume | Minutes / month | STT cost / month |
|---|---|---|
| 1,000 messages | ~480 | **≈ $8** |
| 10,000 messages | ~4,800 | **≈ $77** |
| 100,000 messages | ~48,000 | **≈ $770** |
| Cap: 1000 min/day (default) | ≤ 30,000 | **≤ $480** (hard ceiling until the owner raises the cap) |

**Backfill:** at most 100 live messages per mailbox, so typically ≈ $0.80 per mailbox and $8 worst case.

**KMS:** about 4 operations per message (audio unwrap, transcript wrap, about 2 views), plus at most 50 per snippet batch (cached per session). At $0.03 per 10k operations that is about $1/month at 100k messages. No new key versions are created (the transcripts use the existing customer KEK).

**DB:** about 3–8 KB of ciphertext per transcript. Negligible.

---

## 18. Recording path: STT requirements for the telephony review

The telephony agent reviewing audio quality owns any change here. These are the requirements as seen from STT, checked against `docker/freeswitch/scripts/lib/vm_box.lua` on RCF-V1.

**Already satisfied (keep):**
1. **Native rate:** `record_sample_rate=8000` with G.711 PSTN legs. That is the 8 kHz Google says to send. Do **not** upsample.
2. **Lossless container:** the WAV is PCM s16le (LINEAR16). Do not switch the recording format to MP3, Opus or μ-law files.
3. **Caller audio only, mono:** the `record` app records the channel's read stream, so the greeting and beep are not in the file. Keep it that way. `record_session` or stereo would mix in prompts and hurt recognition.
4. **No processing:** do not add AGC, noise suppression, `record_*` gain or volume changes, or comfort-noise fill (`record_fill_cng`) on the voicemail leg. Google: "Don't use automatic gain control", "All noise reduction processing should be disabled", "Avoid audio clipping". CNG fill would also defeat FS's silence stop and our silence trim.

**Worth reviewing (telephony decides):**
5. **Silence stop `record … 200 5`:** threshold 200 and 5 s of silence end the message.
   - It is good for STT (the tail is trimmed server-side using the same 200 threshold).
   - It **truncates** callers who pause more than 5 s mid-message, for example while looking up a number. Consider 7–8 s.
6. **Wideband:** if an on-net leg ever negotiates G.722 (16 kHz), forcing 8000 throws the extra bandwidth away. Recording at the leg's native rate (8000 or 16000) is better. The API and STT already accept both.
7. **Packet loss and jitter:** `record` writes what it reads, so lost packets become gaps. If the quality review shows meaningful loss on carrier legs, a jitter buffer on the voicemail A-leg (e.g. `jitterbuffer_msec`) would give STT more continuous audio.
8. **DTMF:** `#` ends the recording. With RFC 2833 the tone is not in the audio. With in-band DTMF a short tone tail is harmless to STT.
9. **Length:** the 300 s cap and the 1 s minimum deposit are fine. Pieces are handled server-side.

---

## 19. Work split for parallel build agents

Each agent works in its own worktree off `RCF-V1`. Each runs `pytest`, plus `tsc`/build for the UI, and **never** runs gcloud, tofu, ssh or a push.

| Agent | Owns (files) | Delivers first (others code against it) |
|---|---|---|
| **backend-T** (worker, schema, crypto) | `docker/postgres/init/56_voicemail_transcription.sql`; `scripts/db/check_migrations.sql`; `tests/voicemail_db.py` (+56); `services/voicemail/crypto.py` + `__init__.py` re-exports; the new package `services/voicemail/transcription/` (`__init__`, `config`, `chunking`, `document`, `provider`, `gcp_stt`, `fake_stt`, `queue` (SQL of §6), `worker`, `smoke`); `services/voicemail/retention.py` (orphan step); `main.py` lifespan; `requirements.txt`; `docker-compose.services.yml` env passthrough; the test files for migration 56, crypto, chunking, provider and worker; `docker/api/CLAUDE.md` env table; `docker/postgres` CLAUDE.md migration list | Commit 1: migration 56, plus `crypto.py` §5, `transcription/config.py` (`platform_enabled`, `available`, `SUPPORTED_LANGUAGES`, `DEFAULT_LANGUAGE`) and `transcription/document.py`, each exactly as specified |
| **backend-A** (API) | `routers/voicemail.py`; the new `services/voicemail/transcripts.py` (status mapping, transcript read and audit, snippets, retry, backfill, ops status and requeue); `services/voicemail/mailboxes.py` (`MAILBOX_SELECT`/`MAILBOX_FIELDS` +2 fields, `create_mailbox` params, the 1-line DELETEs in `delete_mailbox` and `erase_customer` from §9); `services/voicemail/audit.py` docstring; `tests/test_voicemail_transcription_api.py` + harness | Codes against §4, §5 and §10. Until backend-T's commit 1 lands, it stubs `open_transcript` and `config.available()` with the signatures above. |
| **ui** | Everything in §11. Marketing copy edits. | Codes against §10–§11 JSON. It mocks with the fake provider in the local E2E. |

**Merge order:** backend-T, then backend-A, then ui.

**After the merge:** the lead appends "§9 Transcription (v1.1), as built" to `docs/ENCRYPTED_VOICEMAIL_INTERFACES.md` and writes `docs/runbooks/VOICEMAIL_TRANSCRIPTION_DEPLOY.md` from §15–§16.

---

## 20. Open questions for the owner (kept to the minimum)

1. **Q1: Default for new mailboxes.** This plan uses **off** for every mailbox, existing and new. A tenant writer or an admin turns it on per mailbox.
   - Do you want new mailboxes to default **on**? Existing mailboxes stay off either way, because their customers never agreed to a new subprocessor.
   - Related: should tenants be able to enable it themselves (as planned), or only admins (for example, if it will later be sold as an add-on; D5 says no pricing yet)?
2. **Q2: Conditional.** This applies only if check 15.1 step 4 shows Speech or `allServices` Data Access logging **and** check 15.4 finds transcript content in those logs. In that case, is an audit-log exemption for `vm-api` on `speech.googleapis.com` in the shared project acceptable? Otherwise transcription stays off.

Everything else is decided above with a default:
- the model (`telephony`, `chirp_3` switchable);
- the languages (en-US / es-US / fr-CA);
- the cap (1000 min/day);
- retry limits;
- storage (Postgres);
- UI copy naming Google as the processor (edit the wording freely).

---

## 21. Sources (Google documentation, checked 2026-10-23)

- V2 quotas and limits (sync 10 MB / 1 min; streaming 5 min, near real time, 25 KB per request; batch GCS-only; 300 sync requests/min/region): https://docs.cloud.google.com/speech-to-text/v2/quotas
- V1 quotas (async over ~1 min must use a GCS `uri`; 10 MB inline): https://docs.cloud.google.com/speech-to-text/quotas
- Transcription models (`telephony` for 8 kHz phone audio; `chirp_3`): https://docs.cloud.google.com/speech-to-text/v2/docs/transcription-model
- Supported languages and features by location (en-US/es-US/fr-CA `telephony` and `chirp_3` in `us`; telephony word-level confidence): https://docs.cloud.google.com/speech-to-text/v2/docs/speech-to-text-supported-languages
- Chirp 3 (GA in `us`/`eu`; Recognize under 1 min; confidence "isn't truly a confidence score"; sample with `REGION="us"` and `f"{REGION}-speech.googleapis.com"`): https://docs.cloud.google.com/speech-to-text/v2/docs/chirp_3-model
- Pricing (V2 Standard $0.016/min to 500k min; per-second billing; requests rounded up to 1 s; V1 with and without data-logging SKUs; dynamic batch): https://cloud.google.com/speech-to-text/pricing
- Data logging (opt-in; "By default, Cloud Speech-to-Text does not log customer audio data or transcripts"): https://docs.cloud.google.com/speech-to-text/docs/data-logging
- Data usage FAQ (sync and streaming processed in memory, not stored; async transcript about 5 days; processing location): https://docs.cloud.google.com/speech-to-text/docs/data-usage-faq
- Regional endpoints (`us-speech.googleapis.com`; data at rest and in use stays within the USA): https://docs.cloud.google.com/speech-to-text/docs/v1/endpoints
- V1→V2 migration (regional `ClientOptions(api_endpoint=f"{location}-speech.googleapis.com")`; V2 is "fully regionalized"; recognizer `_`): https://docs.cloud.google.com/speech-to-text/docs/migration
- V2 audit logging (`Recognize` = Data Access, `speech.recognizers.recognize - DATA_READ`): https://docs.cloud.google.com/speech-to-text/v2/docs/audit-logging
- IAM roles (`roles/speech.client` permission list): https://docs.cloud.google.com/iam/docs/roles-permissions/speech
- V2 RPC reference (`RecognizeRequest`, `ExplicitDecodingConfig` encodings, `SpeechRecognitionResult.result_end_offset`, `RecognitionResponseMetadata.total_billed_duration`): https://docs.cloud.google.com/speech-to-text/v2/docs/reference/rpc/google.cloud.speech.v2
- Best practices for audio (native 8 kHz, avoid resampling, lossless LINEAR16/FLAC, no AGC or noise reduction, avoid clipping): https://docs.cloud.google.com/speech-to-text/docs/best-practices-provide-speech-data
- Python client `google-cloud-speech` (2.41.0, 2026-10-01; requires Python ≥ 3.10, protobuf ≥ 6.33.5): https://pypi.org/project/google-cloud-speech/
- Client-library debug logging via `GOOGLE_SDK_PYTHON_LOGGING_SCOPE` ("logs may contain sensitive information"): https://pypi.org/project/google-cloud-service-usage/
