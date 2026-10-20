# Encrypted Voicemail — Build Plan (plan of record, 2026-10-20)

**Status:** decisions locked, Phase 0 underway (PR #145). Phases 1–7 not started.
**Supersedes:** `ENCRYPTED_VOICEMAIL_PLAN.md` (2026-04, per-customer HSM keys) and `docs/VISUAL_VOICEMAIL_PORT_PLAN.md` on branch `docs/vvm-port-plan` (2026-08, local-key v1). Their facts are re-checked here against `RCF-V1` @ `8b9fa40`.
**Source to port:** branch `unified` @ `815aa46`, about 7,800 LOC of Phase-1 Visual Voicemail. Approach: port and adapt, not a rewrite.

---

## 1. Locked decisions (owner, 2026-10-20)

| # | Decision |
|---|---|
| D1 | **Per-customer Cloud KMS keys, SOFTWARE protection level** (about $0.06/key version/month, $0.03 per 10k ops). One KEK per customer wraps a per-message AES-256-GCM DEK. HSM keys may come later as an add-on; they are not in v1. The local-key provider is for dev/CI only and **fails closed in production**. |
| D2 | **No FIPS 140-validated module requirement.** We sell "encrypted at rest". Standard `cryptography` wheels are fine; no FIPS image build. |
| D3 | **The `/voicemail` page is trimmed to what ships.** No transcription, email/SMS/webhook notification or voicemail API in v1. |
| D4 | **West/Central deposit = plain HTTP over the VPC** to the East API, the same path CDR ingest uses. Authenticated with a shared secret read from a root-only file. |
| D5 | **No prices or billing in v1.** Do not seed plan prices, do not switch on the `customers.py` billing seam (`VOICEMAIL_BOX_MRC` stays dormant), and show no price in the UI. Pricing is a later decision. |
| D6 | **Dedicated-DID mailboxes only** (locked 2026-07-30): each mailbox has its own DID, and RCF `forward_to` → mailbox DID rides on-net. The "attached" no-answer/busy fallback is a later phase. |
| D7 | **Web-only retrieval in v1.** The PIN is stored (hashed) for a future dial-in TUI. |
| D8 | **RAM-only plaintext.** Audio exists in plaintext only in RAM-backed filesystems or process memory: FS recording tmpfs, API request handling, playback decrypt. It never touches a persistent disk, swap or a core dump. See §3. |

Proposed, owner to confirm before Phase 2: retention default **90 days**; caps **300 s/message, 100 messages/mailbox, 500 MB/mailbox**.

---

## 2. Current state on RCF-V1 (verified 2026-10-20)

- **Routing.** The on-net TERMINATORS map is at `inbound_router.lua:2188-2192` (rcf/api/trunk). The enrollment recipe comment is at 2185-87 and `dispatch_terminal` at 2197-2215. Direct-dial STEP-1 chain: 838-940 (RCF→API→Trunk), which needs a voicemail arm. `number_routing` view: `22_number_routing.sql:47-110` (3 arms). PR #144 shifts these line numbers again.
- **DID lifecycle.** The `did_inventory.product_type` CHECK at `17_did_inventory.sql:19` has no `voicemail` value, and it is inline and unnamed. Swap it with the pattern at `34_release_requested_status.sql:34-54`. `number_inventory.py` allow-lists are at :80/:135, assign is rcf-only (~:862), and unassign is at ~:965.
- **Onboarding.** Already collects voicemail orders (`onboarding.py:268,335-338`, migration 36).
- **UI.** `/voicemail` → `VisualVoicemailPage.tsx` (235 LOC). It is already daylight-styled and listed under Coming Soon, but it still promises transcription, notifications and API access (D3).
- **FS.** mod_dptools, mod_lua, mod_curl, mod_tone_stream and mod_sndfile are loaded; mod_voicemail is not built (by design). Lua is bind-mounted, so Lua changes deploy with `git pull`.
- **Gaps.**
  - No RAM-disk or `shm_size` config anywhere. Containers get Docker's 64 MB `/dev/shm`.
  - No `INGEST_SHARED_SECRET`.
  - `decode_access_token` (`auth/security.py:35-37`) has no `typ`/`aud` check.
- **Next free migration: 54.** #144 takes 53.

### Defects in the `unified` code that must be fixed during the port
1. **Curl form injection.** `vm_notify.lua` sends caller name/ID as `-F name=value`, and a value starting with `@`/`<` makes curl upload a container file (e.g. `/proc/self/environ`). Use `--form-string`.
2. **Ingest secret in curl argv.** It is visible in `ps`/`/proc`. Pass it via `-H @file` / `curl -K`.
3. **Ingest auth fails open** when the secret is unset.
4. **The playback token works as a full Bearer token** (same `JWT_SECRET`, no `typ`). Use a separate key/audience, and have the middleware reject non-session tokens.
5. **No multipart size cap.** Starlette spools uploads over 1 MB to `/tmp` on disk, so plaintext lands on disk. See §3.
6. **No AAD and no CRC32C.** Ciphertext can be swapped between mailboxes.
7. **LocalKMS** uses one folded secret for all customers, its Fernet wrap is AES-128, and its "scrub" is a no-op. It is dev-only (D1).
8. **Messages are silently lost** when encryption is unconfigured: a 200 `{status:error}` is treated as success.
9. **Every Range request** does a full download, unwrap, decrypt and audit-row write.
10. **Audit writes are best-effort.** They must fail closed.
11. **Smaller issues:** ciphertext is uploaded before the DB row (orphans); KEKs are created at deposit time and never persisted; no PIN rate limit; leftover legacy/extension/UCaaS paths; `minioadmin` defaults.
12. **The recording file is removed only on the normal path.** There is no startup sweep.
13. **The greeting is fetched but never played.** `lib/json.lua` is missing on RCF-V1.
14. **No crypto or router unit tests exist.**

---

## 3. RAM infrastructure (plaintext never leaves memory)

Plaintext audio lives in four places. Each needs a bounded, RAM-backed home and a guarantee that it is never paged or dumped to disk.

### 3.1 FreeSWITCH recording tmpfs: all 6 FS nodes
The nodes are `fs-media-v2`, `east-fs-2`, `west-fs`, `west-fs-2`, `central-fs` and `central-fs-2`.

- **Mount.** Add a dedicated tmpfs to `docker-compose.media.yml` on the `freeswitch` service, kept in the repo, not hand-edited on VMs:
  `tmpfs: - /dev/shm/vm:size=512m,mode=0700,uid=<fs uid>,noexec,nosuid,nodev`
- **Sizing.** `record` writes L16 WAV at the channel rate:
  - 8 kHz (G.711) ≈ 16 KB/s, so 300 s ≈ **4.8 MB**
  - 16 kHz (G.722) ≈ 9.6 MB
  - 512 MB holds about 100 simultaneous max-length narrowband recordings, or about 50 wideband, per node.
- **Memory accounting.** tmpfs pages count against the container's memory cgroup. The FS limit is 16 GB (reservation 8 GB) on e2-standard-8 (32 GB). Worst case adds 0.5 GB per node, which fits.
- **Full tmpfs.** `record` fails. The Lua treats that as a failed deposit: log, play a short apology, hang up. It never falls back to disk.
- **Hygiene.**
  - unlink the file on every exit path (success, API error, hangup mid-record, Lua error)
  - sweep `/dev/shm/vm` at FS container start, as an entrypoint step
  - add a NOC gauge for tmpfs use
- **Rollout.** Adding a tmpfs needs an FS container recreate. Do FS-2 first, flip, then FS-1 per zone, in a window.

### 3.2 API request handling: services VM
- **Size cap at the edge.** Enforce **10 MB per deposit, 5 MB per greeting**: nginx `client_max_body_size` on the ingest location, plus a `Content-Length` check in the router (413).
- **No disk spooling.** Read the upload into memory, raising Starlette's spool threshold above the cap so it never spools. As a backstop, add `tmpfs: - /tmp:size=256m,mode=1777,noexec,nosuid,nodev` on the `api` service, so anything that does spool stays in RAM.
- **Memory budget.** About 3× the payload per in-flight deposit (upload, plaintext, ciphertext): 10 MB × 3 × 20 concurrent ≈ 600 MB. Plus the playback cache (§3.3) and the API baseline, inside the API container's **2 GB** limit. Limit concurrent deposits to 20 with a semaphore; extra deposits get 503, and FS retries.

### 3.3 Playback decrypt cache: services VM
- Decrypt **once per playback session**, not per HTTP Range request.
- Keep the plaintext in an in-process LRU keyed by the playback token: **256 MB total, 120 s TTL** (the token lifetime), evicted on expiry.
- Serve Range/206 from the cached bytes.
- Never write to disk. Audit **once per session**, not per Range.

### 3.4 No swap, no core dumps: all 7 hosts (6 FS + services)
- **Swap.** `swapon --show` must be empty on every host. GCE Debian images ship without swap; verify, and add a startup check that alerts if swap appears.
- **Core dumps.** Add `ulimits: core: 0` to the `freeswitch` service (the FS build uses `-g`) and to `api`. On the hosts, `kernel.core_pattern` must not write dumps to disk; set `|/bin/false` or confirm `systemd-coredump` storage is `none`.
- **Services VM headroom.** It is e2-standard-4 (16 GB) and also runs the PG primary, and it has a known history of qryn/heplify memory spikes. Before launch, record `free -m` and `docker stats --no-stream` at peak. Confirm at least 2 GB free beyond the API's 2 GB limit, or cap qryn/heplify first; that is an existing follow-up.

### 3.5 Verification (part of the Phase 7 live test)
- After a deposit, `find / -xdev -newer <marker> -name '*.wav'` on the FS and API hosts finds nothing on persistent disk.
- `/dev/shm/vm` is empty after the call.
- `docker exec voip-api ls /tmp` is empty.
- `cat /proc/sys/kernel/core_pattern` and `ulimit -c` inside both containers return the expected values.

---

## 4. Other infrastructure (operator-run GCP steps)

1. **Dedicated service account `vm-api`.** Grant `roles/cloudkms.cryptoKeyEncrypterDecrypter` on the `voicemail-prod` keyring and `roles/storage.objectAdmin` on the bucket. Do **not** grant these to the shared default compute SA, or every VM could decrypt.
   - Attaching a new SA requires **stop/start of the `services` VM, which holds the PG primary**. That needs its own maintenance window. Impersonation from the default SA is the weaker fallback if a window is not possible.
2. **Keyring `voicemail-prod` in us-east1.** The API creates one SOFTWARE key per customer: purpose ENCRYPT_DECRYPT, rotation 365 d, `destroy_scheduled_duration` 24 h.
3. **Bucket `voip-voicemail` in us-east1**, managed in OpenTofu beside `infra/backups/main.tf`:
   - CMEK default key, uniform access, public-access prevention
   - versioning off, soft-delete 7 d
   - grant the GCS service agent encrypterDecrypter on the bucket key
4. **Turn on Data Access audit logs** for Cloud KMS and Cloud Storage. They are off by default.
5. **Secrets.**
   - `services` `.env`: `VOICEMAIL_KMS_PROJECT`, `VOICEMAIL_KMS_LOCATION`, `VOICEMAIL_KMS_KEYRING`, `VOICEMAIL_BUCKET`, `VOICEMAIL_PLAYBACK_SECRET`, `INGEST_SHARED_SECRET`.
   - 6 FS nodes: `INGEST_SHARED_SECRET`, as a root-only file mounted read-only into the container.

---

## 5. Build phases (dependency order)

| Phase | Work | Size |
|---|---|---|
| **0** | Clean-up: dashboard cross-tenant cache fix (PR #145, done); deploy #140–#145 UI; move the main checkout off `feat/noc-concurrent-calls`. #144 is handled separately. | S |
| **1** | Infra: §3 RAM (compose changes in Phase 4/3 PRs, then the operator recreate) and §4 GCP steps. | M (operator; 2 windows: SA swap, FS recreate) |
| **2** | Migration 54, product-native. Tables: `voicemail_boxes`, `voicemail_messages`, `voicemail_greetings`, `voicemail_access_log`, `voicemail_settings`. Also `customers.voicemail_enabled`, the `did_inventory` CHECK swap (+`voicemail`), a `voicemail` arm in `number_routing`, and `check_migrations.sql`. **No price/plan seeds** (D5). Crypto service: a real `GcpKmsProvider` (per-customer keys, AAD `vm:{customer}:{box}:{msg_uuid}`, CRC32C, key-version recorded, timeouts and retries, erase destroys every version), prod refuses `local`. Auth: ingest secret required, playback-token audience, middleware rejects non-session `typ`. | M–L |
| **3** | API port of `routers/voicemail.py`: drop UCaaS/extension/legacy/attached code; §3.2/§3.3 memory rules; insert the row before upload with orphan sweep; fail-closed audit; PIN rate limit; tests. | L |
| **4** | FS deposit path. Port `vm_record`/`vm_notify` with the §2 fixes (`--form-string`, secret from file, status check, bounded retry, unlink on every path, startup sweep). Add `terminate_vvm` to TERMINATORS and a STEP-1 arm, play the greeting then a beep, and add `lib/json.lua`. Compose tmpfs + `ulimits`. Full telephony invariant review. | M |
| **5** | `number_inventory` voicemail arms (assign/unassign/reconcile/`/my`) and admin endpoints for TED. UI: port inbox, waveform player, setup wizard and trash into the existing daylight `/voicemail` page; trim the copy (D3); no prices (D5). | L |
| **6** | Retention purge worker (90 d default + caps) and per-customer crypto-erase (destroy key → immediate). Mailbox/message delete removes rows and objects. Note in the docs that wrapped DEKs survive in DB backups until pgBackRest/pg_dump expiry (~35 d). Key destruction is the immediate erase. | M |
| **7** | Testing and rollout (§6). | M |

**First testable milestone, the East-only alpha:** Phases 1–4 plus the API endpoints, with one internal test mailbox DID on `fs-media-v2`. Roughly 3 weeks in. The full build is roughly 5–7 weeks plus the two operator windows.

---

## 6. Test plan

**Automated (in each PR)**
- **Crypto:**
  - round-trip
  - a blob swapped between mailboxes, or the wrong AAD → InvalidTag
  - rotation: old versions still decrypt
  - every version destroyed → unrecoverable
  - `local` provider refused when `ENV=production`
  - KMS mocked; one real-KMS integration test against a dev keyring
- **API:**
  - tenant 404-no-leak
  - playback token rejected as a Bearer
  - 413 over the cap
  - `/tmp` stays empty during ingest
  - ingest without the secret → 401
  - PIN rate limit
  - exactly one audit row per playback session
  - deposit concurrency limit → 503
- **Lua harness**, following `tests/lua/onnet_router_harness.lua`:
  - direct dial → `terminate_vvm`
  - RCF → mailbox DID resolves on-net
  - disabled mailbox → 603
  - caller name `@/etc/passwd` sent literally
  - recording file removed on every exit path

**Live (no lab: real VMs, test DIDs)**
1. **East alpha.** Deposit, then playback through the API. Then check:
   - the GCS object is ciphertext with the CMEK key
   - the KMS Data Access log shows the encrypt and decrypt
   - §3.5 RAM checks pass
2. **Per zone.** East, West and Central, including each FS-2 node: deposit → playback → delete.
3. **Failure injection:**
   - API down: message dropped and logged, tmpfs cleared
   - KMS down: 503, no plaintext anywhere
   - GCS down: no orphan rows
   - FS killed mid-record: startup sweep clears the file
   - cross-zone timeout: retry, then drop
   - tmpfs full: graceful failure, no disk fallback

---

## 7. Out of scope for v1
Transcription; email, SMS or webhook notification; the dial-in TUI; the attached no-answer/busy fallback; HSM keys; FIPS image; pricing and billing; voicemail API for customers; cross-customer on-net settlement policy.
