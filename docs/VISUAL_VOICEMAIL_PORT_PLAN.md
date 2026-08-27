# Visual Voicemail — RCF-V1 Port Plan (survey of record, 2026-08-27)

**Status: surveyed + scoped, NOT started. This doc is the pickup point.**
Two-agent code audit (unified-branch inventory + RCF-V1 readiness). Verdict: **port-and-adapt, not a rewrite** — a complete Phase-1 VVM product exists on branch `unified` (~7,300 LOC) and RCF-V1 is pre-wired to receive it.

## Locked decisions (user, 2026-07-30, reaffirmed 2026-08-27)
- **v1 = dedicated-DID mailboxes only, $5/mo per mailbox.** Every mailbox gets its own DID; customers point calls at it (including RCF `forward_to` → box DID, which rides ON-NET with zero carrier hairpin).
- The "attached" no-answer/busy fallback model ($2/mo) is a LATER phase (its FS hook lands inside the hardened 4-attempt carrier failover loop — deliberately deferred risk).

## What exists on `unified` (815aa46; spec `docs/VISUAL_VOICEMAIL_PRODUCT_PLAN.md` there)
- **Deposit pipeline**: FS `handlers/voicemail.lua` + `lib/vm_record.lua` (answer → beep → record to tmpfs `/dev/shm`, 300s cap, silence detect → multipart curl POST to API → shred on every exit path; API-down = drop, accepted) + `lib/vm_notify.lua`. FS never touches the DB, never persists plaintext.
- **Crypto**: `services/envelope_crypto.py` (AES-256-GCM per-object DEK, KEK-wrapped; `LocalKmsProvider` = MultiFernet env KEK ≥32 chars, WORKS; `GcpKmsProvider` = untested stub). Only ciphertext + wrapped DEK persist.
- **API**: `routers/voicemail.py` (1,620 LOC) — X-Ingest-Secret FS endpoints (ingest/resolve/pin-verify/greeting-ingest); tenant-scoped mailboxes/messages(inbox|saved|trash + restore/purge)/bindings/greetings/settings with 404-no-leak; 120s scoped-token → in-memory decrypt-stream playback with Range/206; **atomic DID-claim** (FOR UPDATE, flips did_inventory in one tx, commented billing seam).
- **Schema**: `33_schema_voicemail_product.sql` — voicemail_boxes (spine)/box_bindings/settings/access_log/plans+subscriptions ($5 dedicated / $2 attached seeds, 90d retention), `customers.voicemail_enabled` entitlement.
- **UI** (~3,600 LOC, GLASS style): master-detail inbox, SVG waveform player + token-refreshing audio hook, 4-step setup wizard (delivery model → buy/attach number → PIN/label/notify → review), trash flow, EncryptionBadge, entitlement guard.
- **NOT built anywhere** (Phase-2 vapor): transcription (rows land `transcript_status='skipped'`), email/SMS sender, TUI dial-in, retention purge worker, greeting playback to caller, GCP KMS, mailbox crypto-erase endpoint.

## What RCF-V1 already provides (code-verified)
- **Routing**: on-net framework LIVE — `number_routing` view + `resolve_destination()` + TERMINATORS dispatch (`inbound_router.lua:1487-1516`); in-code enrollment recipe at 1484-86: add a `voicemail` UNION arm + `terminate_vvm`. **Also needed**: a STEP-1 lookup arm for direct PSTN dial (the sequential lookup chain at 531-604 does not use the view).
- **DID lifecycle**: intake/assign/unassign/reconcile machinery complete; needs `voicemail` in the `did_inventory.product_type` CHECK (named-CHECK-swap pattern of migration 34) + Pydantic validators + assign/unassign/reconcile/`/my` arms in `number_inventory.py`.
- **FS media**: records TODAY via mod_dptools `record` + tone_stream beep + sndfile. mod_voicemail NOT COMPILED — not needed by design. No sounds packages → v1 greetings = uploaded audio + beep default. Compose needs `shm_size`/tmpfs on media VMs (encode-in-repo rule).
- **Billing**: estimate line ready — `customers.py:164-184` commented enable-me block + `VOICEMAIL_BOX_MRC` constant (set to $5.00 per locked decision) + UI line types.
- **Onboarding**: already collects VVM orders (ProductKey `voicemail`, `VoicemailIntake`, migration 36).
- **Portal**: `/voicemail` route live with a coming-soon showcase page — see Promise Gap.

## Gaps (the real work)
1. **Object storage is net-new on production** — zero object storage exists on RCF-V1. Needs: GCS bucket (`voip-voicemail` or similar), auth (Grafana's keyless GCE-metadata SA pattern is the in-repo precedent; unified used HMAC interop keys), `.env` secrets on East services VM: `STORAGE_*`, `VOICEMAIL_LOCAL_KEK` (≥32 chars or feature 503s — never plaintext), `INGEST_SHARED_SECRET`. **All GCP-side steps operator-executed.**
2. **Schema adaptation**: `voicemails`/`voicemail_greetings` must be recreated PRODUCT-NATIVE (unified ALTERs UCaaS tables from `10_schema_ucaas.sql` that RCF-V1 lacks). Drop extension_id/back-fill/legacy endpoints/spool branch/softphone hooks entirely. Renumber migration → **43** (next free), hand-apply on East primary (init scripts only run on fresh initdb; replicates to zones).
3. **FS integration re-scaffold**: port vm_record/vm_notify verbatim-ish; the router hookup is NET-NEW scaffolding onto TERMINATORS (cleaner than unified's cascade) — full telephony-expert + §8.10-style invariant audit treatment; mailbox lookups hit zone-local replicas (same property number_routing relies on).
4. **Cross-zone deposit**: W/C FS → East-only API over VPC (`API_HOST` already East in every zone's .env). v1 durability: bounded retry then drop, documented (queue = later).
5. **UI restyle**: glass → daylight; replace the showcase page; strip softphone/`useSoftphone` deps.
6. **Promise gap**: the live coming-soon page sells transcription + instant email/webhook delivery — none exists. Resolve per open decision #1 below BEFORE launch.

## Open decisions (with recommendations; decide before build)
1. Promise gap: trim page to shipped truth (rec) vs build email-notify at launch (needs an email provider — platform has none) with transcription deferred.
2. Encryption bar v1: local-KEK envelope now, Cloud KMS fast-follow (rec) vs block on GCP KMS wiring.
3. Retention: build the auto-purge worker at launch (rec — 90d default seeded) vs defer.
4. Entitlement: `customers.voicemail_enabled` flag, any account type (rec — matches all existing wiring) vs new account_type.
5. Caps: 300s/message (seeded); pick max messages/box + per-box storage quota.
6. PIN/TUI: web-only retrieval v1, PIN stored for future dial-in (rec) vs TUI at launch.
Also inherited-open: cross-customer on-net settlement (CDR records both parties; policy deferred), `product_type` token = `voicemail` (fits CDR VARCHAR(10) + existing UI types).

## Build sequence (dependency order, when green-lit)
1. Migration 43 (product-native schema + did_inventory CHECK) → 2. GCS bucket + secrets (operator) + port storage/crypto/ingest-auth → 3. `routers/voicemail.py` port (adapted tables; platform's first StreamingResponse) + middleware exemptions + tests → 4. FS: vm_record/vm_notify port + number_routing arm + terminate_vvm + STEP-1 lookup + compose tmpfs → 5. number_inventory arms + admin endpoints (TED tool rides the bridge later) → 6. UI port/restyle replacing showcase + billing switch-on ($5) → 7. Deploy: migration on primary → services (api/ui) → media VMs ×3 → live deposit/retrieve test per zone.
