# Visual Voicemail — Product Plan (Encrypted at Rest)

**Status:** Design only — synthesized from three expert plans (telephony, backend, frontend), reconciled + verified by the orchestrator. No code written. Branch `unified`.
**Supersedes/extends:** `ENCRYPTED_VOICEMAIL_PLAN.md` (keeps its envelope-encryption + KMS hierarchy + crypto-erase; **replaces** its presigned-URL playback and GCS-only assumptions — see §5).

---

## 0. The headline question, answered

**"Do customers need to buy a number from us, or how do calls reach the voicemail box?"**

**No — a purchased number is one of four delivery models, not a requirement.** The mailbox is the durable entity; a number is just one way to address it. Two things must be true at answer time: (1) the call lands on a number we control on Bandwidth, and (2) we can resolve a `mailbox_id` from the SIP request. The **default, low-friction hero is "forward your existing number"** — the customer keeps their number/carrier/phone and points conditional (no-answer/busy/unreachable) forwarding at a shared access number we publish. That's "encrypted visual voicemail for the number you already have, set up in two minutes."

### Delivery models (the customer-facing answer)

| Model | Buy a number from us? | How the mailbox is resolved | Customer setup | When to use |
|---|---|---|---|---|
| **Forward your existing number** ⭐ default | **No** | Call lands on our shared **access DID** (`To`); the customer's original number rides in **Diversion / History-Info** → mapped to the mailbox | Set conditional/unconditional call-forward on their own carrier (mobile GSM codes / portal / PBX) to the access number | The marquee "add VVM to any phone, no port" play |
| **Forward — per-mailbox access DID** (fallback) | Cheap DID per mailbox | `To` = that mailbox's unique access DID → direct map (no diversion needed) | Forward to *their own* dedicated access DID | Automatic fallback when the forwarding carrier **strips** diversion headers |
| **Buy / port a number** | Yes | `To` = the mailbox's own DID (straight-to-VM, or ring-a-target-then-VM) | We provision/port the DID; they publish it | A clean dedicated voicemail number, or VVM-only line |
| **Attach to an existing revup number** | Already have one | Existing RCF/trunk/UCaaS resolves the customer; mailbox is the **no-answer/busy fallback** | Toggle "voicemail" on the existing product | Near-free upsell to the current base (mostly already built) |
| **API / pilot** | No | `mailbox_id` passed explicitly | Developer integration | Programmatic deposits / testing |

**The honest caveat (telephony):** model 1 depends on the *forwarding* carrier passing Diversion/History-Info. US carriers usually do on conditional forwards, but it's not guaranteed. Mitigations, in order: per-customer pilot DID (if the customer has one mailbox, resolve by access DID alone), a PIN-prompt fallback ("enter your mailbox number"), and—deterministically—offer the **per-mailbox access DID** (model 2). **Onboarding must run a real forward-test and gate "model 1 ready" on a confirmed diversion capture (verifiable in Homer), else auto-offer model 2.**

---

## 1. Product overview & positioning

A **standalone, separately-purchasable, encrypted-at-rest Visual Voicemail** product. The unit of ownership is a **Voicemail Box (mailbox)** — decoupled from a UCaaS extension, so any account type (or a customer with no other product) can buy it. Differentiators: one-tap "forward your number" setup, a waveform player with scrubbing/speed over encrypted audio, transcription + search across all messages, and "encrypted at rest" as a visible compliance selling point (HIPAA/gov via KMS key isolation + cryptographic erase).

**Decoupling switch:** a new `customers.voicemail_enabled` entitlement flag (orthogonal to `account_type`/`ucaas_enabled`, mirroring the `ucaas_enabled` pattern) + per-mailbox SKUs. The sidebar nav un-gates from `COMMS_ACCOUNT_TYPES` and reads this entitlement.

---

## 2. Architecture across the three layers (summary)

### Telephony (FreeSWITCH + Kamailio)
- **Mailbox resolution:** normalize Diversion/History-Info/RDNIS to a single `X-VM-Source` header **at Kamailio** (it already does nameaddr parsing on the outbound leg; FS reliably reads only `X-` headers). Inbound path otherwise unchanged.
- **Dispatch:** append a **voicemail lookup** to the `inbound_router.lua` cascade **after** rcf→api→trunk→ucaas (disjoint, never shadows revenue products) → new `handlers/voicemail.lua`.
- **Record flow:** pure-Lua `record` (NOT `mod_voicemail` for the standalone product — we need byte control for encryption), to **tmpfs (`/dev/shm`)** never persistent disk; time-of-day greeting via the existing `lib/schedule.lua`; beep/silence/hangup handling; `0`→operator via the existing RCF carrier path; `#` to finish. Caller review/re-record = Phase 2.
- **Handoff:** extend `lib/vm_notify.lua` (already does injection-safe multipart `curl` upload + ingest-secret) to send the file + metadata to `/voicemail/ingest`, then **shred the tmpfs file**. Plaintext never persists.
- **Reuse:** extract the duplicated `record_voicemail()` in `rcf.lua`/`ucaas.lua` into `lib/vm_record.lua`; thread `mailbox_id` so the existing RCF/UCaaS no-answer fallback becomes an encrypted deposit for free (legacy paths byte-unchanged when no mailbox bound).

### Backend (FastAPI)
- **Spine:** `voicemail_boxes` (mailbox, customer + optional user, optional `extension_id`, encryption binding, plan) + `voicemail_box_bindings` (the four delivery models in one table) + refactor `voicemails`/`voicemail_greetings` toward `mailbox_id` (non-destructive migration, legacy rows preserved/dual-mode). Migration **33** (next free).
- **Encryption:** keep envelope encryption (per-message/greeting/transcript DEK, AES-256-GCM, KEK in KMS) from `ENCRYPTED_VOICEMAIL_PLAN.md`; **pluggable provider** (`LocalKmsProvider` for the MinIO dev stack, `GcpKmsProvider` for prod) so it runs locally. Per-customer KEK (standard) / per-mailbox KEK (gov SKU → per-mailbox crypto-erase). Reuse the existing `services/storage.py` (S3/MinIO) + add an encryption layer.
- **Encrypt-on-write ingest:** `/voicemail/ingest` (ingest-secret, JWT-exempt) reads multipart audio, encrypts, stores ciphertext, inserts the row, enqueues transcription + notification jobs, always 200. **FS does not insert plaintext rows for encrypted mailboxes.**
- **Decrypt-stream playback (the hard part):** two-step — `POST /messages/{id}/playback-token` (auth'd, mints a 120s scoped HS256 token) → `GET /messages/{id}/stream?t=…` (JWT-exempt query-token carve-out; unwraps DEK, downloads ciphertext, decrypts in memory, serves the plaintext WAV with **HTTP Range/206** from the decrypted buffer — messages are small). Audit-logged. (NOT a presigned ciphertext URL — that was the original plan's fatal flaw.)
- **Transcription:** self-hosted **faster-whisper** worker (keeps PHI in-boundary; cloud STT pluggable behind a BAA SKU), **DB-backed job queue** (`SELECT … FOR UPDATE SKIP LOCKED`, no Redis), transcript stored **encrypted** in DB; off the ingest hot path.
- **Notifications:** email-with-transcription (link-only audio by default for compliance), SMS, push (Phase 3), MWI via ESL **only** for attached/ucaas (registered endpoints).
- **Lifecycle:** standalone create (provisions KEK) → bind number/forward/attach → greetings/PIN(bcrypt)/retention/legal-hold/crypto-erase. Per-tenant scoping via `get_customer_filter` + `_get_owned_mailbox` 404-no-leak (mirrors `api_dids.py`).

### Frontend (React)
- **Onboarding wizard** (`VoicemailSetupWizard`) — the headline UX: delivery-model chooser → **Forward-your-number** step with carrier-aware dial codes, copy-to-clipboard, `tel:` one-tap dial, and live "test it" verification → buy/port (reuse `didInventory.ts`/`onboarding.ts`) / attach / API → personalize (name/greeting/PIN/notify) → review with encryption badge.
- **Visual inbox** — 3-zone master-detail: folder/label rail (Inbox/Unread/Saved/Trash + mailbox switcher + `AdminCustomerSelector`), message list with transcript preview, reading pane with a hand-rolled **SVG waveform player** (scrub + speed, no heavy deps), **transcript panel** with word-sync, and **search across transcriptions**. Bulk actions, call-back, forward-to-email.
- **Greetings** — in-browser `MediaRecorder` recording + upload, multiple greetings (default/business-hours/out-of-office) with scheduling.
- **Settings** — PIN, notifications, retention, transcription language; danger zone.
- **Trust** — reusable `EncryptionBadge` + a short "your messages are encrypted" explainer at decision/consumption moments.
- **Encryption boundary lives in one place:** `getVoicemailPlaybackUrl(id)` — components never touch a raw object URL.

---

## 3. PINNED cross-layer contract (authoritative — reconciliations resolved)

> The three plans diverged in a few places; these are the **reconciled** decisions. Build to these.

### 3.1 Mailbox resolution schema — use the backend's single table
**Reconciliation:** telephony proposed three tables (`voicemail_dids`/`voicemail_pilots`/`voicemail_diversion_map`); backend proposed one (`voicemail_box_bindings` with a `binding_type` discriminator). **Adopt the backend's `voicemail_box_bindings`** (single source of truth, owned by the DB layer). Telephony's `lookup_voicemail_did()` (in `lib/db_client.lua`) and the API's ingest both resolve against it, in priority order:
1. `binding_type='dedicated_did'` where `did = to_did`
2. `binding_type='forward_access'` where `access_did = to_did AND original_did = diversion` (or access-DID-only when the customer has a single mailbox)
3. `binding_type='attached'` where `(attach_product, attach_ref)` matches the originating product/DID/extension

### 3.2 Ingest contract (FS → API)
`POST /v1/voicemail/ingest` — `X-Ingest-Secret`, multipart `file` (raw 8k mono PCM WAV from tmpfs) + fields: `to_did`, `diversion` (original DID for forward-access; from `X-VM-Source`), `access_did`, `caller_id`, `caller_name`, `duration_ms`, `greeting_type?`, `source_model?`. Legacy `extension`+`customer_id` accepted as fallback. **The API authoritatively resolves the mailbox via `voicemail_box_bindings` and inserts the (encrypted) row** — FS does not insert. Always returns 200.

### 3.3 Greeting fetch (FS ← API)
`GET /v1/voicemail/resolve?to_did=&diversion=&access_did=` (ingest-secret) → `{ mailbox_id, exists, active_greeting }` so FS knows the mailbox + which greeting to play (chosen server-side by schedule, or FS evaluates via `lib/schedule.lua` against returned schedule data). Greeting audio is encrypted → FS fetches it via the same decrypt-stream mechanism (tokenized) or the API returns it decrypted over the ingest-secret channel to tmpfs.

### 3.4 Playback contract (Frontend ↔ API)
`POST /v1/voicemail/messages/{id}/playback-token` → `{ stream_url, expires_in }`. Frontend's `getVoicemailPlaybackUrl(id)` calls this and returns `PlaybackSource = { kind:'url', url, expires_at, mime }` (URL mode) — `GET …/stream?t=` is Range-capable so `<audio src>` works natively. (Authed-bytes mode `{kind:'bytes'}` is the documented fallback if the contract changes.)

### 3.5 Message + transcript shape (API → Frontend)
Message detail returns the decrypted `transcript: { status: 'pending'|'processing'|'done'|'failed'|'skipped', text, language, confidence, words? }`. **Alignment item:** frontend word-sync highlighting needs word-level timings → the transcription worker must run faster-whisper with `word_timestamps=True` to populate `words[]` (Phase 3 feature; segment-level is fine for MVP). `peaks?: number[]` for the waveform is optional (frontend has a 3-tier fallback).

### 3.6 Notifications / MWI
Deposit is API-initiated (FS posts audio → API ingest), so the backend owns the trigger — it enqueues email/SMS/push + MWI jobs inside ingest. **MWI (ESL NOTIFY) only for attached/ucaas mailboxes** (registered endpoints); forward/dedicated standalone mailboxes rely on the UI badge + email/SMS.

### 3.7 Entitlement / gating
New `customers.voicemail_enabled` flag (migration 33) gates mailbox creation and un-gates the sidebar nav (frontend reads the entitlement, not hardcoded `COMMS_ACCOUNT_TYPES`). SKUs in `voicemail_plans`.

---

## 4. Encryption & compliance (the selling point)

Keep `ENCRYPTED_VOICEMAIL_PLAN.md`'s envelope model; key deltas pinned:
- **Per-object DEK (AES-256-GCM)** wrapped by a **per-customer KEK** (standard) or **per-mailbox KEK** (gov SKU) in KMS (Cloud HSM, FIPS 140-2 L3 in prod; `LocalKmsProvider` for dev). Separate DEKs for audio / greeting / transcript.
- **Plaintext never at rest:** FS records to tmpfs and shreds after upload; the API encrypts on write; transcripts encrypted in DB; playback decrypts in-memory and streams over TLS.
- **Crypto-erase = KMS key destruction** (NIST SP 800-88): per-mailbox for gov, per-customer for standard — the headline decommissioning/right-to-deletion feature.
- **Audit:** `voicemail_access_log` on every decrypt (play/download) and key op (HIPAA §164.312(b)).
- **Compliance posture as product:** the *gov SKU* sells key isolation + audit + BAA + self-hosted transcription (no third-party PHI) — encryption itself is universal across all mailboxes.

---

## 5. Billing / SKU model

`customers.voicemail_enabled` entitlement + `voicemail_plans` catalog (mirrors `cps_tiers`) + `customer_voicemail_subscriptions`:
- **Forward-only SKU** (no DID cost — cheapest entry) vs **Dedicated-DID SKU** (number rental) vs **Attached/fallback SKU** (cheapest, rides an existing number).
- Per-mailbox monthly base + optional per-message overage; **transcription as a metered add-on** (`voicemail_transcription_usage` minutes); **gov/compliance tier** (dedicated KEK, longer retention, BAA) at premium.
- Enforcement reuses the existing `customers.balance`/credit model + `BackgroundTasks` fee pattern from `calls.py`; admin plan CRUD mirrors `tiers.py`.

---

## 6. Phasing (unified) + build sequence + verification gates

**Phase 1 — MVP (decoupled + encrypted core, the forward path end-to-end):**
- Backend: migration 33 (mailbox spine, bindings, message/greeting columns, access_log, plans + `voicemail_enabled`; back-fill legacy extensions→mailboxes); `services/voicemail_crypto.py` (local+GCP providers); encrypt-on-write ingest; **decrypt-stream playback** (token→stream, Range); mailbox/message/greeting/settings/binding endpoints; keep legacy `/voicemail/*` dual-mode.
- Telephony: `handlers/voicemail.lua` + `lib/vm_record.lua` (tmpfs); dispatcher voicemail lookup against `voicemail_box_bindings`; Kamailio `X-VM-Source` normalization; `vm_notify.lua` gains `mailbox_id` + shred. Models **forward (shared pilot + diversion)** and **buy/dedicated straight-to-VM** working.
- Frontend: onboarding wizard (chooser + forward-your-number + personalize + review); inbox upgrade (waveform player over the decrypt-stream, transcript display + search); migrate `VoicemailPage` to React Query + new types; un-gate nav; `EncryptionBadge`.

**Phase 2 — hardening + greetings/settings:** transcription worker (faster-whisper) + encrypted transcripts + metered usage; email/SMS notifications; MWI for attached; retention auto-purge + legal hold + crypto-erase admin; KEK rotation; gov per-mailbox KEK SKU; dedicated-DID buy/port binding; greeting recorder/upload + scheduling; settings (PIN/notify/retention); time-of-day greetings; ring-target-then-VM; attach-to-existing fallback (`rcf.lua`/`ucaas.lua` encrypted).

**Phase 3 — enhanced:** phone-based PIN retrieval (`voicemail_check.lua` + decrypt-stream-to-FS); push; transcript blind-index search + word-level sync + redaction + language auto-detect + cloud-STT BAA option; chunked-GCM true range streaming; client-side decrypt for high-scale standard tier; team/shared mailboxes; CNAM enrichment.

**Build sequence (each layer: expert builds → orchestrator verifies the gate):**
1. Backend foundation — migration 33 + crypto service (Fernet/AES round-trip; migration idempotent + back-fill correct).
2. Backend ingest + decrypt-stream playback (encrypt-on-write; Range/206 stream of decrypted audio; per-tenant 404-no-leak). **The decrypt-stream is the load-bearing piece — verify first.**
3. Telephony — `vm_record`/`handlers/voicemail.lua` + dispatcher + Kamailio X-VM-Source (Lua test suite green; deposit lands encrypted; legacy rcf/ucaas unchanged).
4. Frontend data + nav + inbox/player (tsc/eslint/build; playback via token→stream; #310-safe).
5. Frontend onboarding wizard (forward-codes data-driven; copy/tel:/verify).
6. End-to-end: forward a real number → deposit → encrypted at rest (verify ciphertext in storage) → visual inbox playback + transcript → crypto-erase.

---

## 7. Open decisions to confirm before/while building
1. **Durability vs confidentiality on ingest failure:** if the encrypted-ingest API is down, telephony drops the message rather than persist plaintext to disk. Confirm that's acceptable (alternative: encrypt at the edge on the media VM — bigger lift).
2. **Transcript search under encryption:** MVP decrypt-and-filter per mailbox (small N); Phase-2 blind-index (HMAC word tokens). Confirm acceptable for gov mailboxes.
3. **Shared pilot DID vs per-mailbox access DID default** — default to shared+diversion, auto-fallback to per-mailbox on diversion failure (onboarding-verified). Confirm the per-region pilot pool sizing.
4. **Self-hosted faster-whisper vs cloud STT** default — self-hosted for PHI; cloud as a BAA upsell. Confirm infra (CPU/GPU worker on the Services VM).
5. **Standalone voicemail account_type vs entitlement flag** — plan uses `voicemail_enabled` flag (no new account_type). Confirm.

Per-layer detail (telephony routing/greeting/notify; backend schema/crypto/API/billing; frontend wizard/inbox/components) was produced by the three expert agents and is captured in the synthesis above; this document is the authoritative reconciled spec to build from.
