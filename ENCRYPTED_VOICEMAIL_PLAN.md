# Plan: Encrypted-at-Rest Voicemail for Granite CRAG

## Context

Government agency customers need encrypted-at-rest voicemail. ALL voicemail is encrypted — there is no "standard" unencrypted path. Every message uses AES-256-GCM envelope encryption with per-customer Cloud KMS keys (Cloud HSM backed, FIPS 140-2 Level 3).

## Architecture

```
Call → no answer → FS records to tmpfs (RAM, never persistent disk)
  → Lua base64-encodes WAV → POSTs to API /v1/voicemail/deposit
  → API generates DEK → AES-256-GCM encrypts WAV → wraps DEK via Cloud KMS
  → Uploads encrypted file to GCS (CMEK bucket) → stores metadata + wrapped_dek in PostgreSQL
  → Deletes tmpfs file → Caller hears goodbye tone

Playback → API unwraps DEK via KMS → decrypts → streams to browser
```

**NOT using mod_voicemail** — pure Lua recording for full encryption control.

---

## Phase 1: Core Implementation — Weeks 1-3

### Week 1: Database + API + Encryption Service

**New: `docker/postgres/init/20_schema_voicemail.sql`** (telephony/python agent)
- `voicemail_mailboxes` — per-DID config (did UNIQUE, customer_id, enabled, pin_hash, max_messages, retention_days, kms_key_name)
- `voicemails` — messages (mailbox_id, caller_id, duration_seconds, gcs_bucket, gcs_object_key, wrapped_dek BYTEA, iv BYTEA, kms_key_version, is_read, is_deleted, transcription)
- `voicemail_greetings` — custom greetings (mailbox_id, gcs_path, type, wrapped_dek, iv)
- `voicemail_access_log` — audit trail (action, source, ip_address, user_agent, detail JSONB)
- Add `voicemail_enabled BOOLEAN DEFAULT false` to `customers` table
- Grants: ALL to api, SELECT to freeswitch

**New: `docker/api/src/services/voicemail_storage.py`** (python agent)
- `VoicemailStorage` class
- `encrypt_and_upload(bucket, key, data, kms_key_name)` — generate DEK, AES-256-GCM encrypt, wrap DEK via KMS, upload to GCS, return (wrapped_dek, iv, kms_key_version)
- `download_and_decrypt(bucket, key, wrapped_dek, iv, kms_key_version)` — download from GCS, unwrap DEK via KMS, decrypt, return plaintext
- Use `asyncio.to_thread()` for sync GCS/KMS client calls

**New: `docker/api/src/routers/voicemail.py`** (python agent)
- Internal (no auth): `POST /v1/voicemail/deposit`, `POST /v1/voicemail/greeting/play`
- Customer: `GET /messages`, `GET /messages/{id}`, `GET /messages/{id}/audio` (StreamingResponse), `PUT /messages/{id}/read`, `DELETE /messages/{id}`, `GET /config`, `PUT /config`, `POST /greeting`, `GET /greeting`
- Admin: `GET /stats`, `PUT /config/{customer_id}`
- ALL actions logged to `voicemail_access_log`

**Modify: `docker/api/requirements.txt`** — add google-cloud-storage, google-cloud-kms, cryptography
**Modify: `docker/api/src/main.py`** — mount voicemail router
**Modify: `docker/api/src/middleware/auth.py`** — exempt /voicemail/deposit and /voicemail/greeting/play; token-in-query-param for /audio

### Week 2: FreeSWITCH Integration

**New: `docker/freeswitch/scripts/voicemail_handler.lua`** (telephony agent)
- Answer → fetch greeting from API → play greeting → beep → record to /dev/shm (tmpfs, max 300s) → base64-encode → POST to API → delete temp file → hangup

**Modify: `docker/freeswitch/scripts/inbound_router.lua`** (telephony agent, ~line 602)
- After bridge failure: check `last_bridge_hangup_cause`
- If NO_ANSWER/USER_BUSY/NO_USER_RESPONSE → check voicemail_mailboxes for DID → if enabled, execute voicemail_handler.lua

**Modify: `docker/freeswitch/scripts/lib/db_client.lua`** (telephony agent)
- Add `M.lookup_voicemail_config(did)` — query voicemail_mailboxes

### Week 3: Frontend + Admin

**New: `docker/ui/app/src/types/voicemail.ts`** (frontend agent)
**New: `docker/ui/app/src/api/voicemail.ts`** (frontend agent)
**New: `docker/ui/app/src/components/ui/AudioPlayer.tsx`** (frontend agent)
**New: `docker/ui/app/src/pages/VoicemailTab.tsx`** (frontend agent)
- Message list with caller, time, duration, read/unread, play, delete
- Inline AudioPlayer (play/pause, seek, speed, time display)
- Lock icon on every message (encrypted)
- Filter: All / Unread / Read

**New: `docker/ui/app/src/pages/VoicemailSettingsSection.tsx`** (frontend agent)
- Enable/disable toggle, PIN management, greeting upload, encryption status indicator

**Modify: `docker/ui/app/src/pages/RcfPage.tsx`** (frontend agent)
- Add 5th tab "Voicemail" (shown when customer.voicemail_enabled)

**Modify: `docker/ui/app/src/pages/admin/CustomerAccountPage.tsx`** (frontend agent)
- CustomerVoicemailSection: toggle voicemail, set KMS key, view messages/audit

---

## Phase 2: Hardening — Week 4

- Key rotation testing (new messages use latest version, old still decrypt)
- Customer offboarding test (destroy key → messages unreadable)
- CMEK on GCS bucket verification
- Audit log completeness review
- Compliance documentation (SSP, encryption attestation, data flow diagram)

## Phase 3: Enhanced Features — Later

- Voicemail-to-email (SendGrid/SMTP)
- Speech-to-text transcription (Cloud Speech-to-Text)
- Custom greetings via phone (DTMF recording)
- MWI notifications (ESL NOTIFY)
- Voicemail PIN check via phone (*97)

---

## File Summary

### New Files
| File | Agent | Purpose |
|------|-------|---------|
| `docker/postgres/init/20_schema_voicemail.sql` | python-backend | Schema |
| `docker/api/src/routers/voicemail.py` | python-backend | API endpoints (~500 lines) |
| `docker/api/src/services/voicemail_storage.py` | python-backend | GCS + KMS encryption (~150 lines) |
| `docker/freeswitch/scripts/voicemail_handler.lua` | telephony | Recording + API deposit (~120 lines) |
| `docker/ui/app/src/types/voicemail.ts` | frontend | Types |
| `docker/ui/app/src/api/voicemail.ts` | frontend | API client |
| `docker/ui/app/src/components/ui/AudioPlayer.tsx` | frontend | Audio player |
| `docker/ui/app/src/pages/VoicemailTab.tsx` | frontend | Voicemail tab |
| `docker/ui/app/src/pages/VoicemailSettingsSection.tsx` | frontend | Settings |

### Modified Files
| File | Agent | Changes |
|------|-------|---------|
| `docker/api/requirements.txt` | python-backend | +3 packages |
| `docker/api/src/main.py` | python-backend | Mount router |
| `docker/api/src/middleware/auth.py` | python-backend | Exemptions + token-in-query |
| `docker/freeswitch/scripts/inbound_router.lua` | telephony | VM fallback after bridge fail |
| `docker/freeswitch/scripts/lib/db_client.lua` | telephony | lookup_voicemail_config() |
| `docker/ui/app/src/pages/RcfPage.tsx` | frontend | 5th tab |
| `docker/ui/app/src/pages/admin/CustomerAccountPage.tsx` | frontend | VM section |
| `docker-compose.services.yml` | any | GCS/KMS env vars |

---

## Encryption Details

### Envelope Encryption Pattern
```
DEPOSIT:
1. Generate random 32-byte DEK (os.urandom(32))
2. Generate random 12-byte IV (os.urandom(12))  
3. AES-256-GCM encrypt: ciphertext = AESGCM(dek).encrypt(iv, wav_bytes, None)
4. Cloud KMS wrap: wrapped_dek = kms.encrypt(customer_kms_key, dek)
5. Upload ciphertext to GCS as .wav.enc
6. Store in DB: wrapped_dek, iv, kms_key_version
7. Shred DEK from memory

PLAYBACK:
1. Download .wav.enc from GCS
2. Cloud KMS unwrap: dek = kms.decrypt(kms_key_version, wrapped_dek)
3. AES-256-GCM decrypt: wav_bytes = AESGCM(dek).decrypt(iv, ciphertext, None)
4. StreamingResponse(wav_bytes, media_type="audio/wav")
5. Shred DEK from memory
```

### KMS Key Hierarchy
```
projects/granite-crag-prod/locations/us-east1/keyRings/voicemail-prod/
  cryptoKeys/customer-{customer_id}/  (Cloud HSM protection, FIPS 140-2 Level 3)
    versions/1 (auto-rotated every 90 days)
```

### Government Compliance Coverage
| Requirement | Solution |
|---|---|
| AES-256 at rest | Envelope encryption + GCS CMEK |
| FIPS 140-2 Level 3 keys | Cloud HSM |
| Per-customer key isolation | One KMS key per customer |
| Audit trail | voicemail_access_log table |
| Key rotation | Cloud KMS auto-rotation |
| Cryptographic deletion | Destroy KMS key = all data unreadable |
| FedRAMP High infrastructure | GCP |

---

## Verification

1. Enable voicemail for Granite Telephony → create mailbox for +16174544217
2. Call +16174544217, let it ring 30s → greeting plays → leave message → hangup
3. Verify: encrypted .wav.enc in GCS, wrapped_dek/iv/kms_key_version in DB, access_log entry
4. Open web UI → Voicemail tab → message appears → play it → audio streams correctly
5. Mark read, delete → verify DB state
6. Upload custom greeting → verify next call plays it
7. Rotate KMS key → new message uses new version → old message still plays
8. Destroy KMS key → all messages unplayable (cryptographic deletion)
