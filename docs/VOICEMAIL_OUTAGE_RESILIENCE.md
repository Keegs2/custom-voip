# Voicemail survives an East outage

**Status:** built 2026-10-25 on `feat/vm-outage-resilience` (Visual IVR project phase P2V).
**Decision:** plan D11 and §7.5 in `docs/IVR_PRODUCT_PLAN.md`. Contract: `docs/IVR_INTERFACES.md` §7 and §8.4.
**Builds on:** encrypted voicemail v1 (`docs/ENCRYPTED_VOICEMAIL_BUILD_PLAN.md`, `docs/ENCRYPTED_VOICEMAIL_INTERFACES.md`). Its decision D8 still holds: plaintext audio exists only in RAM. It never touches a persistent disk, swap or a core dump.
**Deploy:** `docs/runbooks/VOICEMAIL_OUTAGE_RESILIENCE_DEPLOY.md`.

---

## 1. The problem

Voicemail ran in every zone, but it depended on the East-only API during the call:

| Step | Before | When East was down |
|---|---|---|
| Mailbox check after the answer | `GET /v1/voicemail/fs/mailbox/{id}` (2 s connect, 3 s total) | Blind defaults: 300 s, default greeting. A full or suspended mailbox still recorded. |
| Custom greeting | `GET .../greetings/{id}/audio` | Default greeting |
| Deposit after hang-up | `POST /v1/voicemail/fs/deposit`, 3 attempts over about 3 s | **The message was lost.** `vm_deposit.lua` logged "message lost" and unlinked the recording. |

So an East outage lost every voicemail left in every zone.

## 2. What a caller hears during an East outage

- **Ringing and answer:** unchanged. Routing reads the zone replica, as before.
- **Dead air after the answer:** at most about **1 s**. The mailbox check gives up at its 1 s connect timeout. Before this change it was 2 s.
- **Mailbox checks:** made against the zone replica (§4), with the same rules as the API.
  - A full mailbox plays "mailbox full" and hangs up.
  - A suspended mailbox, or a customer without voicemail, plays "unavailable".
  - A deleted mailbox plays "unavailable".
  - Before this change, all of these recorded anyway.
- **Greeting:** always the **default greeting**. A custom greeting is encrypted under the customer's KMS key, and only the East API can decrypt it. This is accepted (plan §7.5).
- **The message:** recorded as usual, then sealed to the media VM's spool (§5). The caller hears nothing different.
- **After the caller hangs up:** FS keeps the channel for about 12 s (three failed deposit attempts plus backoff), then seals in about 50 ms. The CDR's `billsec` includes this time, as it did before.
- **When East is back:** the zone's `vm-forwarder` delivers the message within about 10–20 s (its reachability probe, §6).
  - The inbox shows the **time the caller left it**, not the delivery time.
  - Transcription, if the mailbox has it, starts within the worker's 15-minute catch-up.

With the API up, the call is byte-identical to before. The Lua harness proves this (§9).

## 3. The pieces

```
FS (each media VM)                                       services VM (East)
 lib/vm_box.lua
  ├─ GET /fs/mailbox ──── fails ──> lib/vm_replica.lua ── zone replica: view vm_fs_mailbox (58)
  ├─ record to /dev/shm/vm (RAM)
  ├─ POST /fs/deposit ─── 3 x fails ─> lib/vm_spool.lua
  │                                    openssl cms -encrypt (AES-256-GCM, RSA-OAEP)
  │                                    -> /var/lib/crag/vm-spool/<uuid>.cms + .json
  │                                    unlink the plaintext
  └─ (API up: unchanged)
 vm-forwarder (container, no keys)
  └─ POST /v1/voicemail/fs/deposit-sealed ─────────────>  services/voicemail/sealed.py
     oldest first, backoff, caps                           unseal IN RAM (spool_crypto.py)
                                                           -> the EXISTING deposit pipeline
                                                              (per-customer KMS, GCS, audit)
```

| File | What |
|---|---|
| `docker/postgres/init/58_vm_outage_resilience.sql` | View `vm_fs_mailbox`; `freeswitch` gets SELECT on it only |
| `docker/freeswitch/scripts/lib/vm_replica.lua` | The replica mailbox check |
| `docker/freeswitch/scripts/lib/vm_spool.lua` | The seal, plus `selftest` |
| `docker/freeswitch/scripts/lib/vm_box.lua` | Wires both in, only on the failure paths |
| `docker/freeswitch/scripts/lib/vm_deposit.lua` | Mailbox connect timeout 2 s → 1 s |
| `docker/vm-forwarder/` | The replayer: Python stdlib, no keys |
| `docker/api/src/services/voicemail/spool_crypto.py` | Strict CMS AuthEnvelopedData unsealer |
| `docker/api/src/services/voicemail/sealed.py` | `POST /v1/voicemail/fs/deposit-sealed` |
| `docker/api/src/services/voicemail/deposit.py` | `Mode`: lets a sealed replay reuse the live pipeline |
| `docker-compose.media.yml` | `vm_spool` volume, `vm-forwarder`, plus P2's `IVR_ENABLED` and `ivr_prompts` |
| `docker-compose.services.yml` | `VOICEMAIL_SPOOL_PRIVATE_KEY_B64` |
| `docker/vmagent/scrape-media.yml` | Job `vm_forwarder` (dashboard tile) |

## 4. The zone-replica mailbox check

**When it runs.** `vm_box` asks the replica only when the East lookup failed with a transport error, a 5xx or a garbage body. A 404, 401 or 403 from the API keeps its old meaning. An answering API never triggers it.

**What it reads.** One statement, constant apart from the validated integer id:
```sql
SELECT mailbox_id, did, customer_id, status, accepting, max_message_seconds, reason
  FROM vm_fs_mailbox WHERE mailbox_id = <id> LIMIT 1
```
- **Connection:** `db_client.get_connection()`, the same local PgBouncer/replica as the DID lookups. A fresh `db_client` instance is used and closed afterwards.
- **What `freeswitch` can see:** the view runs with its owner's rights, so the role can read these routing facts and nothing else about voicemail. It sees no caller data, counts, PIN or greeting.

**The rules are the API's rules.** `accepting` and `reason` mirror `services/voicemail/mailboxes.py`, namely `MAILBOX_SELECT`'s per-mailbox stats and `accepting_state()`:
1. **Inactive:** mailbox status is not `active`, or the customer's `voicemail_enabled` is false. Inactive wins over full.
2. **Full:** live (untrashed) stored messages ≥ `max_messages`, or stored bytes *including trash* ≥ `max_bytes`.
3. **Deleted mailbox:** no row, just as the API answers 404.

`tests/test_voicemail_outage_migration58.py` compares the view with `accepting_state()` on every branch. If either changes, change both.

| Replica answer | Caller hears | `vm_result` | `vm_lookup_source` |
|---|---|---|---|
| accepting | default greeting, then records up to the view's `max_message_seconds` | (deposit outcome) | `replica` |
| full | `mailbox_full` | `not_accepting_full` | `replica` |
| inactive | `unavailable` | `not_accepting_inactive` | `replica` |
| no row | `unavailable` | `unavailable_404` | `replica` |
| unusable (view missing, no connection, malformed row) | default greeting, 300 s: today's defaults | (deposit outcome) | `defaults` |

**Staleness.** During an outage nothing new is stored, so the replica's counts are frozen at the last delivered message. Messages sealed during the outage can push a mailbox past its cap. The replay then re-checks (§7) and drops them with an audit row: the mailbox "is no longer accepting".

## 5. Sealing

### 5.1 Crypto choice

The design uses **CMS AuthEnvelopedData** (RFC 5083), made by the FS image's own openssl CLI. The image is Debian bookworm with **OpenSSL 3.0.22**, from the `openssl` package at `docker/freeswitch/Dockerfile:281`. The blob uses:
- **Content:** AES-256-GCM (RFC 5084), with a 12-byte nonce, a 16-byte tag and a fresh random content key per message.
- **Key transport:** RSAES-OAEP with SHA-256 and MGF1-SHA-256, to every recipient certificate.
- **Recipient id:** the certificate's subjectKeyIdentifier (`-keyid`).

Why this design:
1. **It needs no new code or package on the media VMs.** The CLI is already in the runtime image, so no image rebuild is needed (plan §7.5). It was verified in a `debian:bookworm-slim` container: `openssl cms -encrypt -aes-256-gcm` produces `id-smime-ct-authEnvelopedData` with `rsaesOaep`/`sha256`/`mgf1`. The local E2E seals with exactly that binary.
2. **It is authenticated encryption.** The GCM tag covers the content. A flipped bit, a truncation or a spliced blob is rejected.
3. **It is a standard envelope with multiple recipients.** It seals to the "current" and the "next" certificate during a rotation (§10).
4. **OAEP, not PKCS#1 v1.5:** no padding-oracle class.

**The API side.** `cryptography`, the API's existing dependency, cannot open AuthEnvelopedData. Its PKCS#7 decryptor handles only EnvelopedData with PKCS#1 v1.5 (checked: `pkcs7_decrypt_der` rejects the blob). So `spool_crypto.py` parses the DER with a small, **strict** reader and uses `cryptography` only for the two primitives: RSA-OAEP decrypt and AES-GCM decrypt-and-verify. This was chosen over the openssl CLI as a subprocess because:
- the API image needs no new package, and there is no subprocess;
- the private key never leaves the Python process, not even through a pipe or `/dev/fd`;
- the parser is an **allow-list** of exactly what `vm_spool.lua` produces. It refuses:
  - OAEP's SHA-1 defaults, PKCS#1 v1.5 key transport, AES-CBC EnvelopedData, issuerAndSerial recipient ids and BER/`-stream`;
  - originatorInfo, authAttrs, unauthAttrs and trailing bytes.
  Each refusal is pinned by `tests/test_voicemail_outage_crypto.py`.

**The metadata is sealed too.** The plaintext inside the envelope is a frame:
```
"CRAGVMS1\n" <decimal length of META> "\n" META <the WAV bytes>
```
- **META** is the JSON of the contract §8.4 fields plus `v`: `msg_uuid`, `mailbox_id`, `did`, `caller_number`, `caller_name` (optional), `received_at` (ISO-8601 UTC, when the caller hung up), `duration_ms`, `zone`.
- **Binding:** the API requires the sealed META to equal `X-VM-Meta`. The sidecar can't be edited to deliver one tenant's message into another tenant's mailbox; the API answers 422.

### 5.2 Files and hygiene

**Spool layout.** The spool is the Docker volume `vm_spool`, at `/var/lib/crag/vm-spool` in both FS and `vm-forwarder`:
- `<msg_uuid>.cms`: the DER blob, mode `0600`.
- `<msg_uuid>.json`: the META bytes, plaintext **metadata** only, mode `0600`.
- `rejected/`, `audit/spool-audit.jsonl`: owned by the forwarder, mode `0700`.

**How a seal is written:**
1. Write `.tmp` files: openssl with `umask 077`, and `install -m 0600` for the META.
2. `sync` both files.
3. Rename `.json` first and `.cms` last, then `sync` the directory.

The forwarder only ever picks up a `.cms` whose `.json` exists.

**Plaintext stays in RAM.**
- openssl reads the frame from tmpfs. The frame (`s_<uuid>.bin`), the META copy (`j_<uuid>.json`) and the recipient certificates (`r<k>_<uuid>.pem`) live in `/dev/shm/vm`.
- They are registered with `vm_box`'s cleanup before they exist, and unlinked as soon as openssl returns. The recording is unlinked right after a successful seal.
- The existing 15-minute tmpfs sweep catches a crash.
- openssl runs without `-stream`, so it holds the input in memory and writes no temporary file.
- The E2E scanned the spool and the FS container's writable layer: **0 RIFF/WAVE bytes** (§9).

**No key on a media VM.**
- `/run/revup/vm_spool_recipients.pem` holds 1–4 public certificates.
- `vm_spool.lua` refuses a file that contains a `PRIVATE KEY` block.
- The private key exists only in the API's environment.

**When a seal is refused (fail closed).** The message is then lost exactly as before this change, with an ERROR naming the reason:
- the spool is not a mount (FS not recreated);
- the recipients file is missing or bad;
- openssl failed, or its output is not AuthEnvelopedData;
- the **safety ceiling** is hit: the spool already holds 4 GiB (twice the forwarder's cap, so the forwarder is not running), or the filesystem has less than 1 GiB free. A media VM's disk must never fill up because of voicemail.

**`vm_result=spooled`** marks a sealed message in the CDR.

**Self-test** (deploy check): `fs_cli -x 'lua lib/vm_spool.lua selftest'`. It seals a synthetic non-audio payload into tmpfs, never the spool, and checks the output. It prints `vm_spool selftest OK: spool mounted, sealed to N recipient(s), spool … KiB used, … KiB free`.

## 6. Forwarding (`docker/vm-forwarder`)

There is one container per media VM. It has no keys and uses no third-party code. Every 10 s it:
1. **Enforces the caps.**
   - **Age:** anything older than 7 days, by `received_at`, is dropped, whether pending or rejected.
   - **Size:** while the spool holds more than 2 GiB, the oldest **rejected** pair goes first, then the oldest pending one.
   - **Every drop** is journaled to `audit/spool-audit.jsonl` (fsync'd) and logged.
2. **Sweeps crash leftovers older than an hour.** `*.tmp` and a lone `.json` are deleted. A lone `.cms` moves to `rejected/` and is journaled.
3. **Replays pending messages oldest first**, unless it is backing off: `POST /v1/voicemail/fs/deposit-sealed`.
   - **Body:** the `.cms` bytes.
   - **`X-VM-Meta`:** base64url of the sidecar's exact bytes.
   - **`X-Ingest-Secret`:** read from the same header file FS uses, on every send.

| API answer | Forwarder |
|---|---|
| 201 `{"status":"stored"}` / 200 `{"status":"duplicate"}` | delete the pair |
| 410 `dropped: <reason>` | delete, journal (the API audited it) |
| 422 `bad_blob` / `bad_meta` | move to `rejected/`, journal |
| anything else: 503, 5xx, 401, 404 (an API without the route), network error, a 2xx without a status | keep; global backoff of 5 s, doubling to 5 min, ±20 % jitter. The pass stops at the first failure, so an outage doesn't hammer East. |

**Recovery is fast.** After a *network* failure (no HTTP answer at all, meaning East is unreachable), the backoff is cut short by a cheap probe. The forwarder sends `GET /`, which is JWT-exempt and touches no DB, once per scan. The moment East answers, the queue is retried, so messages arrive about one scan interval (10 s) after East returns, not up to 6 minutes later. After an *HTTP* failure (the API is up but refusing, for example 503 because the key is unset, or 401), the full backoff holds: retrying sooner would only resend the blob.

The journal and logs carry `msg_uuid`, `mailbox_id`, `received_at`, sizes and reasons. They **never** carry the caller's number or name, or the secret.

**Metrics.** Prometheus text on `127.0.0.1:9105/metrics`, scraped by the co-located vmagent (`vm_forwarder` job). They feed a dashboard tile, with **no alert** (owner rule: no pagers):

| Metric | Type |
|---|---|
| `vm_spool_messages{state="pending"\|"rejected"}` | gauge |
| `vm_spool_bytes{state}` | gauge |
| `vm_spool_oldest_age_seconds` | gauge |
| `vm_spool_forwarded_total{result="stored"\|"duplicate"\|"dropped"\|"rejected"}` | counter |
| `vm_spool_dropped_total{reason="age"\|"size"\|"orphan"\|"bad_sidecar"}` | counter |
| `vm_spool_send_failures_total` | counter |
| `vm_spool_api_reachable` | gauge |
| `vm_spool_last_scan_timestamp_seconds` | gauge |

Suggested tile: `sum by (zone, reporting_instance) (vm_spool_messages{state="pending"})` next to `max by (zone) (vm_spool_oldest_age_seconds)`.

**Container hardening:** `network_mode: host` (it reaches the API like FS does), read-only root, `cap_drop: ALL`, `no-new-privileges`, `core 0`, no `depends_on: freeswitch`. It runs as uid 0 only to own the root `0600` spool and header files.

## 7. `POST /v1/voicemail/fs/deposit-sealed`

The route is protected by `require_ingest_secret`, the same gate and header file as the live deposit. The checks run cheapest first, and nothing is decrypted before the request is well-formed:

1. **`X-VM-Meta`:** strict base64url JSON with the §8.4 fields. A bad header gives 422 `bad_meta`.
2. **`Content-Type: application/octet-stream`** and the size cap (10 MB + 256 KB). Otherwise 422.
3. **The spool key** from `VOICEMAIL_SPOOL_PRIVATE_KEY_B64`: base64 of a PEM bundle of 1–4 RSA keys of at least 3072 bits. If it is unset or unusable, the answer is **503** and the forwarder keeps the file.
4. **`received_at`:** a future time (FS clock ahead) is clamped to now. A time older than 31 days gives 422.
5. **Concurrency:** a deposit slot, shared with the live deposit (5 per worker); otherwise 503.
6. **Unseal in RAM** into `bytearray`s that are zeroed after use.
   - The key is matched by subjectKeyIdentifier. A blob sealed only to keys the API doesn't hold gives **503**, because that is a rotation mistake, not tampering.
   - A tag or OAEP failure gives **422**.
7. **Binding:** the frame is parsed, and the sealed META must equal `X-VM-Meta` (otherwise 422). The WAV is parsed (otherwise 422).
8. **The existing deposit pipeline**, run with `Mode(sealed=True)`:
   - **Claim:** the same lease and fencing, idempotent on `msg_uuid`. The mailbox is **re-checked**.
   - **Seal:** per-customer KMS key, upload to GCS.
   - **Finalize:** together with the `deposit` audit row, whose detail adds `"via":"spool"` and `"received_at"`.
   - **Timing:** the same 11 s deadline and late finisher as a live deposit.

What changes in sealed mode:

| Situation | Live deposit | Sealed replay |
|---|---|---|
| New message stored | 200 | **201** `{"status":"stored"}` |
| Already stored (incl. by a live deposit whose answer FS never saw) | 200 | **200** `{"status":"duplicate"}` |
| A `purged` row that **was** stored (a `deposit` audit row exists) | 409 | 200 duplicate. It is never resurrected. |
| A `purged` row that was **never** stored (an orphaned failed attempt the retention worker swept) | 409 | taken over and stored |
| Mailbox deleted / not accepting / longer than allowed / customer crypto-erased | 404 / 409 / 422 / 404 | **410** `dropped: mailbox_deleted` / `not_accepting_full` / `not_accepting_inactive` / `too_long` / `key_destroyed`, after a committed `spool_drop` audit row (no caller data). If that audit write fails, the answer is 503 and the message is never dropped unaudited. |
| `msg_uuid` belongs to another mailbox | 409 | 422 |
| `created_at` | `now()` | **`received_at`**: the inbox sorts and shows the original time |
| `expires_at` | `now() + retention_days` | `received_at + retention_days`, but never less than one day from now |

A sealed message has no `call_uuid` or `fs_node` (the contract keeps the sidecar to routing fields). The CDR links it through `vm_msg_uuid`.

## 8. Threat model

**What is protected:**
- the audio and caller metadata of messages that wait on a media VM;
- the integrity of what gets delivered.

| Threat | Mitigation |
|---|---|
| Media VM disk read: snapshot, stolen disk, a backup, another container on the VM | The spool holds ciphertext only. The private key is never on a media VM. Plaintext stays in tmpfs (RAM) as before, and `core 0` keeps it out of core dumps. |
| Media VM root compromise **during** an outage | It can read new recordings in tmpfs and RAM, as it always could. It still can't read messages already sealed. It holds the ingest secret, so it could deposit fabricated messages, as it already can through `/fs/deposit`. |
| Tampering in the spool or on the wire | The AES-GCM tag gives 422 and nothing is stored. A sidecar edited to redirect a message gives 422 (the sealed META binding). |
| Replay of an old blob | Idempotent on `msg_uuid`: 200 duplicate. A delivered message that was later deleted is never resurrected. |
| Algorithm downgrade (SHA-1 OAEP, PKCS#1 v1.5, CBC, BER tricks) | The allow-list parser refuses it (422). |
| Disk exhaustion from an endless outage or a stuck forwarder | Forwarder caps (7 days / 2 GiB, oldest first, journaled), plus FS's safety ceiling (4 GiB or less than 1 GiB free, then no seal). |
| Lost key or wrong key on the API | 503, so the forwarder keeps the files until the key is fixed. Up to 7 days, then they are dropped by age and journaled. |
| Private key exposure | It lives only in the services VM's `.env` and the root-only `/opt/revup/secrets/vm-spool/`, the same posture as `INGEST_SHARED_SECRET` and the playback secret. Rotation is in §10. |

**What sealing does NOT give** (stated plainly):
- **Sender authentication.** The recipient certificate is public, so anyone holding it could build a valid blob. The endpoint's ingest secret decides who may submit one.
- **Forward secrecy for the spool.** Whoever later obtains the spool private key can open spool files captured before. Rotate and destroy old keys (§10).
- **Confidentiality of the `.json` sidecar.** It is plaintext metadata: caller number and name, mailbox and time. It has the same sensitivity as a CDR row, and it is `0600` and root-owned.

## 9. Verification

| Suite | Count |
|---|---|
| `tests/test_voicemail_outage_sealed.py` | 20 |
| `tests/test_voicemail_outage_crypto.py` | 35 |
| `tests/test_voicemail_outage_forwarder.py` | 20 |
| `tests/test_voicemail_outage_migration58.py` | 5 |

**pytest.** Run `JWT_SECRET_KEY=x python -m pytest tests/ -q`. The suites above cover:
- the round trip through the real playback path (same SHA-256);
- duplicates, takeovers, every 410 with its audit row, every 422, the 503s and rotation;
- downgrades refused;
- the forwarder's response table, caps, leftovers and metrics;
- view-vs-`accepting_state()` parity and grants.

**Lua.** `lua tests/lua/voicemail_harness.lua` covers:
- `[14]`: the replica outcomes, the exact openssl command, frame and META, spool contents, unlink order and every fail-closed path;
- `[15]`, run with `BASELINE_LIBDIR=<dir with the pre-change vm_box.lua + vm_deposit.lua>`: 17 API-up scenarios produce identical commands, CDR variables, prompts, records, events and logs. The single intended difference is the connect timeout.

**Local E2E (2026-10-25).** The setup was:
- real PG from `docker/postgres/init`, minus `11a`, with 58 applied twice;
- the real API image with local KMS and memory storage;
- the real `vm-forwarder` image;
- the **real** `vm_box`/`vm_deposit`/`vm_replica`/`vm_spool`/`db_client`, driven by a fake session inside `debian:bookworm-slim` with lua5.3, luasql-postgres, OpenSSL 3.0.22 and curl 7.88. These are the FS runtime image's tools, with a real `/dev/shm/vm` tmpfs and the `vm_spool` volume.

Results:
- **API up:** stored directly, the spool untouched, `vm_lookup_source` unset.
- **API stopped:** the lookup gave up after 1010 ms (curl exit 28), and the replica answered (`vm_lookup_source=replica`). Three deposit attempts failed, the message was sealed (`vm_result=spooled`), and tmpfs was empty. The `.cms` and `.json` were `0600`, and the blob was `id-smime-ct-authEnvelopedData` / `aes-256-gcm` / `rsaesOaep` / `sha256`.
- **Scan:** RIFF/WAVE across the spool gave 0. The FS container's writable layer held only mount points.
- **API restarted, forwarder run:** 201. The inbox shows **15:58:09**, the original time (delivered 15:58:46). The playback-path SHA-256 equals the caller WAV's.
- **Same blob replayed twice:** `200 duplicate` both times, with 1 row and 1 `deposit` audit row.
- **Mailbox deleted before the replay:** 410 `dropped: mailbox_deleted`. A `spool_drop` audit row was written (customer 501, mailbox 2, no caller data), plus the forwarder journal line.
- **Over-cap spool** (`VM_SPOOL_MAX_BYTES=1 MiB`, three 30 s messages): the oldest was dropped and journaled. Metrics read 2 pending, 962168 bytes. The other two were delivered later with their original times (16:00:15 and 16:00:25).
- **Recovery latency:** the API was down for 88 s while the forwarder backoff had reached 40 s. The API came back at 16:08:28; the probe saw it and the message was delivered at 16:08:44.
- **`vm_spool.lua selftest`:** OK with the mount, FAIL without it.

## 10. Operations

**Deploy order.** Migration 58, then the API with `VOICEMAIL_SPOOL_PRIVATE_KEY_B64`, then the 6 media VMs. Each media VM needs the recipients certificate, `git pull`, an FS recreate for the new volumes, and `vm-forwarder`. Every step is in the runbook.

**Each step is safe on its own:**
- **58 before the Lua:** the view is unused.
- **The Lua before 58:** the view is missing, so FS keeps today's defaults.
- **FS before the API or key:** messages are sealed and kept, the forwarder gets 404 or 503 and retries, and they are delivered once the API is ready.
- **No recipients file:** the seal is refused, which is today's "lost".

**Key rotation** (runbook §6). Never strand a sealed message:
1. Add the new key to the **API** first. The env holds a bundle of the old and new keys.
2. Then switch the **FS recipients** file to the new certificate. Both certificates during the switch are fine.
3. Wait until every spool is empty: `vm_spool_messages{state="pending"} == 0`.
4. Drop the old key from the API and destroy it.

A blob sealed to a key the API doesn't hold gets 503 and stays in the spool. It is never 422'd away.

**Failure modes:**

| Symptom | Meaning | Action |
|---|---|---|
| `vm_result=lost` + `could not seal ... (not mounted)` | FS not recreated after the pull | `up -d freeswitch` on that node |
| `... recipients file ... missing` | No certificate on the node | Runbook §3 |
| Forwarder log `http 503` repeating while the API is up | `VOICEMAIL_SPOOL_PRIVATE_KEY_B64` unset or wrong; API log says which | Fix the `.env`, recreate the API |
| Forwarder log `http 401` | The FS header file doesn't match `INGEST_SHARED_SECRET` | Same fix as for live deposits |
| Files in `rejected/` | 422 (tampered, corrupt, bad meta) or a lone `.cms` | Inspect the journal. The API log names the reason. They age out at 7 days. |
| `vm_spool_oldest_age_seconds` growing with the API up | The forwarder is not running (`docker ps`) or can't reach the API | `up -d --no-deps vm-forwarder`; check `API_HOST` |

**Known limits:**
- **Custom greetings:** not available during an outage (§2).
- **Caps:** the replica's caps are frozen during an outage (§4).
- **Drop audit:** drops made by the forwarder itself (age, size, orphan) are journaled on the media VM, not in `voicemail_access_log`. No endpoint exists for that. API-side drops (410) are in `voicemail_access_log`.
- **Spool scope:** the spool belongs to its VM. If a media VM is destroyed during an outage, its unsent messages go with it. A volume snapshot keeps them, as ciphertext.
