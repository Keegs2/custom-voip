# Visual IVR — Product Build Plan (plan of record, 2026-10-25)

**Status:** APPROVED by the owner on 2026-10-25. The build is in progress. Claude pushes the PRs; the owner reviews, merges and runs P5 live testing. The interface contract is in `docs/IVR_INTERFACES.md`.
**Pre-check done:** prod `ivr_flows` has 0 rows, so the legacy importer is cut.
**Scope:** the visual IVR product (CRAG API + FreeSWITCH + portal + TED), plus voicemail outage resilience (D11).
**Branch:** `feat/ivr-product`, off `RCF-V1` @ `cd69af1`.
**Source reviewed:**
- branch `unified` @ `815aa46`, the Call Flow Builder of 2026-06-19
- branch `origin/preserve/rcfv1-api-ivr`, the older `@dnd-kit` builder
- the TED NEXT repo (`grteng/ted-next` @ `75383e04`)

The review was done by three expert agents (UI, API, FreeSWITCH) plus a TED survey; key claims were spot-checked against source.

---

## 1. Locked decisions (owner, 2026-10-25)

| # | Decision |
|---|---|
| D1 | **IVR is its own product.** Any customer can buy it; it is not tied to an account type. It is an entitlement, like voicemail. |
| D2 | **Customers build IVRs visually** on a drag-and-drop canvas, and **the server turns the diagram into the call logic**. The browser never supplies executable call logic. |
| D3 | **An IVR can send callers to the customer's own numbers:** RCF numbers, voicemail boxes, other IVRs and SIP-trunk numbers. The builder loads the customer's numbers into a picker, so this is a click, not typing a number. |
| D4 | **Outside transfers are US only.** |
| D5 | **The customer chooses, per transfer, whether the original caller's ID is passed through** or the IVR number is shown. This is the same semantics as RCF `pass_caller_id`. |
| D6 | **Pricing comes later** (owner + boss). v1 rates IVR to zero, the voicemail D5 precedent, but records everything pricing will need (§4.4). |
| D7 | **TED admin is in scope:** entitlement, numbers, a read-only flow view and a kill switch (§8). |
| D8 | **IVR is independent of API Calling.** API Calling is switched off on RCF-V1 but stays on the roadmap. IVR uses no `api_dids`, no `voice_url`, no `API_CALLING_ENABLED` and no customer webhooks. |
| D9 | **No call-time dependency on East.** A live IVR call reads only from its own zone: the local PG replica and local disk. The East API is needed to *build/publish* (like editing RCF today), not to *answer* (§3). |
| D10 | **The builder keeps its product-agnostic seam.** It has a `product` column, a compiler registry and a per-product palette, so API/Trunk/UCaaS flows can join later, but v1 ships the IVR palette only. |
| D11 | **Voicemail must survive an East outage, and that fix is part of this project.** Today a message is lost if the East API is unreachable when the caller hangs up. Under the fix:<ul><li>A message that can't be delivered is **sealed** (encrypted to a platform key) on the media VM's disk.</li><li>It is forwarded automatically when East returns, keeping its original time.</li><li>Plaintext still never touches a persistent disk (voicemail D8).</li><li>The mailbox check falls back to the local replica.</li></ul>See §7.5. |

### Proposed defaults (owner can flip)
- **US-only rule:**
  - Allowed: +1 NANP numbers in the 50 states, DC and US territories, plus US toll-free (8YY).
  - Blocked: Canada, the Caribbean NANP countries, 900/976, N11 and anything non-+1.
- **v1 blocks:** Start, Play message, Menu, Business hours, Caller check, Transfer, Voicemail, Go to, Hang up (§6.2). Redirect, Conference, Record and Webhook are left out of v1. They are API-Calling/UCaaS territory, and on unified they were the SSRF and toll-fraud surface.
- **Text-to-speech:** a self-hosted Piper container on the services VM, rendering at publish time. There is no cloud dependency and no per-character cost. Voices are limited to models whose licence allows commercial use; this is to verify before ship.
- **Limits:**
  - 2 min per prompt, 100 prompts per customer, 50 MB of prompt audio per customer
  - 200 blocks per flow
  - a 30-minute IVR wall-clock cap
  - a per-IVR-number concurrent-call cap (like RCF `max_channels`)

---

## 2. Current state (verified 2026-10-25)

### 2.1 `unified`: what exists
- **UI:** `docker/ui/app/src/flow/*` (React Flow 12, 31 files, about 7,250 LOC) plus `CallFlowBuilderPage.tsx`, built 2026-06-19.
  - It includes a palette, typed config panel, validation, draft/publish, version history + restore, a server simulator and a legacy importer.
  - `tsc`/`vite`/`eslint` are clean. It has no tests.
- **API:** `routers/call_flows.py` (admin-only) and `routers/ivr.py`, with schema in `23_schema_ivr.sql`, `27_schema_call_flows.sql` and `31_schema_call_flow_versions.sql`.
- **Runtime:** an IVR number is an `api_did` whose `voice_url` points at `http://api:8000/ivr/webhook/{id}`. FreeSWITCH runs `handlers/api_voice.lua` (a TwiML engine), which re-fetches from the East API on every call and every key press.

### 2.2 Why it can't ship as-is
1. **It has never answered a real call, and as configured it cannot.**
   - FS uses host networking, so `api` does not resolve.
   - `WEBHOOK_ALLOW_HTTP` defaults to false (`docker-compose.media.yml:52`, `api_voice.lua:404-419`).
   - The result is answer → error tone → hang-up.
   - `tests/twiml/test_conformance.py:21-24`: "the EXECUTOR does not [run]".
2. **The server trusts the browser.** Publish stores the client-compiled tree verbatim (`call_flows.py:390,413-431`) and repoints `api_dids.voice_url` with no ownership check (`:441-446`). The consequences:
   - any `<Dial>` destination (toll fraud) and any `callerId` (spoofing)
   - any Play/Redirect URL (SSRF)
   - `ivr.py:817-819` lets a tenant repoint another tenant's DID
   - the webhook is unauthenticated, with sequential flow ids
3. **Customer text reaches `session:execute` arguments,** where FS expands `${...}`. This is likely critical.
4. **Caller-facing bugs:**
   - no barge-in (prompts play fully, then `getDigits`)
   - the no-input branch never runs
   - "repeat menu" loops compile to nothing
   - menu prompts play in reverse order
   - a deleted menu digit still routes; a probe dialled a 900 number
5. **Transfers bypass production egress:** a single attempt, no SBC×carrier failover, no STIR, no B-leg CDR, and `sip_enable_soa=false`.
6. **Builder gaps:** admin-only, no autosave, broken undo, no keyboard editing, and 254 dark-only colour literals.
7. **It can't merge:** 84 vs 466 commits, 17 telephony files changed on both sides, and the migration numbers and `ivr_flows` schemas collide.

### 2.3 RCF-V1: what we build on

**Routing and media:**
- `inbound_router.lua`:
  - STEP 1 lookups at 700-860 (rcf → api → trunk → voicemail)
  - `terminate_rcf` at 1033, `terminate_vvm` at 2067
  - the `TERMINATORS` map at 2136 and `dispatch_terminal` at 2146
  - the on-net chain loop at about 2195-2343
- `number_routing` arms are in `54_voicemail.sql:369-460`. The `did_inventory` product CHECK swap is at `54_voicemail.sql:96-140`.
- The voicemail entitlement column `customers.voicemail_enabled` is at `54_voicemail.sql:93`. This is the pattern for `ivr_enabled`.
- The media precedent is `lib/vm_box.lua`: the per-leg `rtp_timer_name=soft` + jitter buffer before answer.

**Numbers:**
- `services/customer_numbers.py` is the one product-agnostic "customer's numbers" list (`PRECEDENCE`, `HIDDEN_PRODUCTS`). A product enrols by adding a `number_routing` arm.
- `number_inventory.py` assign branches: rcf at :865, voicemail at :914. Onboarding products are in migration 36 (rcf/trunk/api/voicemail).

**Old IVR leftovers:**
- The `pages/ivr/*` `@dnd-kit` builder is still in the tree, unrouted. `/ivr` shows "Coming soon". It cannot be revived: its save drops every branch and prompt.
- `30_schema_ivr.sql` defines a different `ivr_flows` (with a `definition` column). The new design does not use it.

### 2.4 TED (`grteng/ted-next`): how CRAG admin works today
- **HTTP only, to the CRAG API** (`REVUP_ADMIN_API_BASE_URL`, a JWT service account).
- **A closed catalog of 78 operations** in `ted-next-toolkit/.../revup_platform/catalog.py:135-321`. Each operation has an explicit backend route (`ted/platform/revup_platform/routes.py`), is recorded as an Operator Activity, and is used through `useCragMutation` in `ted-next-frontend/src/features/crag-admin/`.
- **No CRAG product catalog.** Products are literals in `customerTypes.ts:8`, `customerMeta.ts` and `didTypes.ts:99` (`rcf|api|trunk|ucaas`).
- **Voicemail is not in TED yet either.** There is no entitlement toggle and no voicemail assignment in the UI.
- **Reference material:**
  - TED's MetaSwitch Auto Attendant schema (`ted/features/build_subscribers/auto_attendant_schemas.py`): GoToMenu, CallTransfer, MailboxTransfer, and 168-slot business hours. It is a useful vocabulary check, because Granite customers know those terms.
  - `ditco-afb-ivr` is a separate, hard-coded ZIP-code IVR, not related to CRAG.

---

## 3. Architecture

```
  BUILD (East, portal)                                   CALL (every zone, local only)
  ────────────────────                                   ─────────────────────────────
  Browser canvas ──graph JSON──► API (East)               Carrier ─► SBC ─► FS (zone)
                                  │ validate + compile           inbound_router STEP 1:
                                  │ dial policy / ownership       number_routing → 'ivr'
                                  │ TTS render (piper sidecar)    TERMINATORS.ivr
                                  ▼                                   │
                        PG primary (East): publish txn               ▼
                          call_flow_versions(plan, prompts)   lib/ivr_engine.lua
                          ivr_prompt_audio(sha256, wav)         reads plan from LOCAL replica
                          flip published_version_id             prompts: local disk cache,
                                  │                                miss → LOCAL replica
                                  └── streaming replication ──►  menus: play_and_get_digits
                                      (East standby, West, Central) transfer: RCF egress loop
                                                                 voicemail: terminate_vvm
```

- **The executable artifact is a "plan":** a small JSON state machine `{version, nodes: {id: {type, cfg, next|branches}}, prompts: [sha256...]}`. Only the server's compiler writes it. The browser's compile step stays for instant validation and preview, and its output is never trusted or stored.
- **Prompt audio lives in Postgres,** `ivr_prompt_audio(sha256 PK, wav bytea)`, content-addressed and deduplicated.
  - It replicates to every zone with the plan, in the same transaction, so a published version can never reference audio the zone doesn't have.
  - FS caches by sha256 on a local volume. On a miss it reads from the local replica, checks the sha256 and the RIFF/8 kHz header, then writes atomically.
  - No new GCP bucket and no East fetch.
- **No customer text ever reaches an FS app argument.** Prompts are file paths `<cache>/<sha256>.wav`, digits are validated `[0-9*#]`, and transfer targets are validated E.164. This removes the `${}` expansion risk structurally; a guard test asserts it.
- **Version pinning:** a call reads `published_version_id` once at call start and runs that version to the end. A mid-call publish never changes the caller's menu.
- **What still needs East (unchanged from today):**
  - editing/publishing flows, because the portal is East-only
  - CDR ingest; FS spools failed posts to `err-log-dir`
  - **delivering** a voicemail into the inbox, because encryption and storage happen in the East API.
    - After D11 / §7.5, a message left during an East outage is held sealed on the zone's media VM and delivered when East returns.
    - The caller-facing behaviour is unchanged, apart from the default greeting being played instead of a custom one.

---

## 4. Data model — migrations `59_ivr.sql` + `60_cdr_ivr.sql` (and `58_vm_outage_resilience.sql` for §7.5)

Both are idempotent, and both are applied by hand on the prod primary, in the house style (`check_migrations` row, grants and revokes).

### 4.1 Entitlement + numbers
- `customers.ivr_enabled BOOLEAN NOT NULL DEFAULT false`
- `ivr_numbers`:
  - `id`, `customer_id`, `did` UNIQUE, `name`, `flow_id` NULL
  - `enabled`, `max_channels`, `created_at`, `updated_at`
- The `did_inventory.product_type` CHECK gains `'ivr'`, using the name-agnostic swap from 54.
- **A `number_routing` arm `'ivr'`:** `product_enabled = ivr_numbers.enabled AND customers.ivr_enabled AND flow published`.
  - FS then routes it.
  - `customer_numbers` lists it everywhere: Reporting, dashboard, My Account, search.
  - On-net RCF→IVR forwards work with no further change.

### 4.2 Flows (product-agnostic seam, D10)
- `call_flows`:
  - `id`, `customer_id`, `product` (CHECK `'ivr'` for now), `name`
  - `draft_graph` JSONB, `revision` (optimistic lock)
  - `published_version_id`, `created_by`, `updated_by`, timestamps
- `call_flow_versions`:
  - `id`, `flow_id`, `version` (UNIQUE per flow)
  - `graph` JSONB, `plan` JSONB, `compiler_version`
  - `published_by`, `published_at`
  - Immutable.

### 4.3 Prompts
- `ivr_prompts`:
  - `id`, `customer_id`, `name`, `kind` (`tts|upload|recording`)
  - `text`, `voice` (tts), `sha256`, `duration_ms`, `bytes`, timestamps
- `ivr_prompt_audio`: `sha256` PK, `wav` BYTEA (8 kHz mono PCM16), `bytes`, `created_at`.
  - Shared and deduplicated.
  - Garbage-collected when no prompt and no version references the hash.
- **Grants:**
  - `freeswitch`: SELECT on `ivr_numbers`, `call_flows` (`published_version_id` only via a view), `call_flow_versions` and `ivr_prompt_audio`
  - `grafana_ro`: revoked on audio and graphs

### 4.4 CDRs + rating (`60_cdr_ivr.sql`)
- **New columns on `cdrs`:**
  - `ivr_flow_id`, `ivr_flow_version`
  - `ivr_exit` (`transfer|voicemail|hangup|caller_hangup|timeout|error|limit`)
  - `ivr_path` (bounded, e.g. `start>menu:1>xfer`)
  - `ivr_transfer_to`, `ivr_seconds` (time spent in the IVR before transfer)
- `product_type='ivr'`. The CDR ingest truncates `product_type` at 10 characters (`cdrs.py:992`), which `ivr` fits.
- `rate_cdr()`: `ivr` rates to **zero** in v1 (D6). Off-net transfer legs still carry the B-leg data from the existing leg split, so a price can be applied when pricing is decided.
- **Re-rating is not automatic.** If pricing must be retroactive, that is a separate one-off job.

---

## 5. API (FastAPI, services VM)

### 5.1 Compiler + policy: `services/ivr/` (pure, unit-tested)
- **`compiler.py`:** graph → plan.
  - It ports `compile/ivr.ts` and fixes the review bugs: prompt order, explicit Go-to/retry instead of silently dropped loops, pruning edges for deleted digits, and protecting the Start block.
  - It ports unified's schedule/condition matchers from `ivr.py:413-427` (zoneinfo).
  - The compiler is versioned (`compiler_version`).
- **`policy.py`:**
  - Transfer targets are either the customer's own number, verified against `customer_numbers` at publish **and** at call time (by DID ownership in the plan), or a US E.164 number that passes the D4 rule.
  - Caller-ID mode is a boolean only. When false, the From is the IVR DID.
  - Prompts are by owned id only. There are no URLs anywhere.
  - Size, block-count and step limits apply.
- **`simulator.py`:** walks a plan with chosen digits, time and caller ID, and returns a "what the caller hears" transcript. It runs on the **current draft**, not only on the last save.
- **`tts.py`:** a client for the `tts` sidecar. It renders to 8 kHz WAV, keyed by `sha256(engine_version|voice|text)`, so re-publishing never re-renders.

### 5.2 Customer endpoints: `routers/ivr.py`
Tenant-scoped and role-aware on the voicemail `vm_scope` pattern: `readonly` reads, writers write, and an admin in "View as Customer" with `customer_id = null` gets the `PreviewPrompt`.
- `GET /v1/ivr/summary`: entitlement, numbers and flows.
- `GET|POST|PUT|DELETE /v1/ivr/flows[/{id}]`: draft graph, with `revision` → 409 on a stale write.
- `POST /v1/ivr/flows/{id}/validate`: server compile, returning errors keyed by block id.
- `POST /v1/ivr/flows/{id}/publish`: compile, policy, TTS render and store, all in one transaction, then flip `published_version_id`. It records the actor.
- `GET /v1/ivr/flows/{id}/versions`, `POST .../versions/{v}/restore` (restore into the draft).
- `POST /v1/ivr/flows/{id}/simulate`.
- `PUT /v1/ivr/numbers/{id}`: bind a flow and rename the number. Only the customer's own `ivr_numbers` can be bound.
- `GET /v1/ivr/destinations`: the customer's numbers grouped by product (RCF with its forward-to, voicemail boxes, other IVRs, trunk numbers), from `customer_numbers`. This feeds the picker (D3).
- **Prompts:**
  - `GET|POST|DELETE /v1/ivr/prompts`; upload takes WAV from the voicemail recorder/transcoder pipeline.
  - `POST /v1/ivr/prompts/tts-preview`.
  - Playback uses a signed short-TTL token, like voicemail greetings.

### 5.3 Admin endpoints (for TED, `require_admin`)
- `PUT /v1/ivr/admin/customers/{id}/entitlement`: on/off.
- `number_inventory.assign` with `product_type='ivr'` creates the `ivr_numbers` row, mirroring the voicemail branch at :914. `unassign` does the reverse.
- `GET /v1/ivr/admin/customers/{id}/flows`: read-only, with versions.
- `PUT /v1/ivr/admin/numbers/{id}/enabled`: the kill switch.
- `onboarding.py` gains `'ivr'` in the product intake (migration 36 JSON contract, `form_version` bump).

### 5.4 TTS sidecar: `docker/tts/` (new container, services VM only)
- **Runtime:** Piper on CPU, internal to `services-network`, with no published port.
- **Voices:** 2–3 US-English voices, baked into the image.
- **Wiring:** `docker-compose.services.yml` gains `tts`. The API reaches it at `http://tts:5000`.
- **Not on the media VMs:** TTS never runs on them.

---

## 6. CRAG portal UI

### 6.1 Product surface
- `src/config/products.ts` gains `ivr`.
- The sidebar gets an **IVR** entry under Products when `ivr_enabled` is on; until then it shows the existing "Coming soon" placeholder.
- **The `/ivr` landing page** has three states:
  - not entitled → explainer
  - entitled, no numbers → "contact us / request a number"
  - otherwise → the customer's IVR numbers, each with its bound flow, publish state and last-published time, plus a "Build / Edit" action
- **Reporting:** IVR numbers and calls appear in Reporting/dashboard automatically through `number_routing`. An "IVR outcomes" breakdown (transferred / voicemail / hung up / timed out) is an optional extra.

### 6.2 The builder (transplant of `unified/src/flow`, trimmed to IVR)
**Palette v1:**

| Block | What the customer sets | Notes |
|---|---|---|
| Start | — | Exactly one; cannot be deleted. |
| Play message | Pick or create a prompt: type text (TTS, voice, preview) or record/upload | Plays in order. |
| Menu | Prompt, digits 0–9 * #, timeout, invalid-key prompt, retries | Each digit is its own exit, plus "no input" and "invalid". Barge-in on. "After N tries" exit. |
| Business hours | Timezone, weekly open hours, closed dates (holidays) | Open/Closed exits. |
| Caller check | Caller-ID starts with / equals / is in a list / is anonymous | Match/No-match exits. |
| Transfer | **Your number** (picker grouped RCF / Voicemail / IVR / Trunk, each showing what it does) **or** an outside US number; show the caller's ID or the IVR number; ring time | "No answer / busy" exit, e.g. to voicemail (§7.3). |
| Voicemail | Pick one of your mailboxes | Terminal. |
| Go to | Pick a block, e.g. "back to main menu" | Bounded by the step budget, which is how "press 9 to repeat" works. |
| Hang up | Optional goodbye prompt | Terminal. |

**Fixes carried in:**
- **Undo:** reworked with zundo `equality` + `partialize`, first-snapshot debounce, and no selection/resize noise.
- **Saving:** autosave drafts with the `revision` lock, an unsaved-changes guard, and History "View" that no longer overwrites or duplicates.
- **Keyboard:** selecting a block opens its panel; per-exit "Connect to…" menus; an outline view; labels and focus rings.
- **Themes:** light and dark per `docker/ui/CLAUDE.md` §18. React Flow `colorMode` follows `useTheme`, `--xy-*` maps to `--t-*`, an `--ivr-*` accent palette, and `--literals` reports 0.
- **Phone width:** a read-only diagram plus "edit on a larger screen".
- **Publishing:** the panel shows server validation errors pinned to blocks, a "what callers hear" transcript, a version diff summary and confirmation.

**Cut from the transplant (about 3,000 LOC):**
- the RCF/trunk/UCaaS compilers and `fromLiveConfig`
- the product selector and customer wizard
- the Redirect/Conference/Record/Webhook blocks
- the 409 RCF modal
- the legacy importer (prod `ivr_flows` has 0 rows, checked 2026-10-25)

**Removed:**
- the old `pages/ivr/*`, `api/ivr.ts`, `types/ivr.ts` and `@dnd-kit/*`
- stale `docker/ui/CLAUDE.md` §11/§12 text

**New dependencies:** `@xyflow/react` ^12, `zustand` ^5, `zundo`, `nanoid`. The route is lazy-loaded, so the main bundle doesn't grow.

---

## 7. FreeSWITCH runtime (Lua; no image rebuild, no Kamailio change)

### 7.1 Routing
- `IVR_ENABLED` env gate, **default off.** When off, an IVR number gets 603 with `lua_routed=true`, the same shape as the API gate.
- STEP 1 gains an `ivr` lookup via `number_routing`, and `TERMINATORS.ivr = terminate_ivr`. On-net chains (RCF forward → IVR number) reach it with no other change.
- Per-number concurrency is enforced with `limit hash ivr_<did> <max_channels>`.

### 7.2 Media
- `lib/media_leg.lua` is extracted from `vm_box.lua` (timer + jitter buffer before answer). Both `vm_box` and `terminate_ivr` use it.
- The relay legs (RCF) are untouched; the timer is never set on a profile.

### 7.3 `lib/ivr_engine.lua` (new, closed-world)
- **Load:** one local-replica query at call start: number → published version → plan + prompt hashes.
  - Prompts are prefetched into the local cache **before answer**, so the caller hears ringback, not silence.
- **Execute blocks:**
  - Menus use `play_and_get_digits`, which gives barge-in, retries, and invalid/timeout prompts.
  - Business hours and caller check reuse unified's `lib/schedule.lua` and `lib/rules.lua`, with their specs.
- **Transfer:** the RCF egress/chain loop is **extracted into a callable function**, proven byte-identical for RCF by a harness over the existing scenarios. `terminate_ivr` calls it with a pseudo-hop (`did = ivr_did`, `forward_to = target`, `pass_caller_id = block setting`). That reuses:
  - the TCP pre-check
  - the SBC×carrier failover and `progress_timeout`
  - the table-driven term trunks + 8YY class
  - From/PAI/Diversion, STIR `div` and the outcome capture
  - the B-leg CDR and on-net resolution (own RCF/voicemail/IVR/trunk numbers)
  - **The one new behaviour** is a "return disposition" mode, so a no-answer/busy transfer can continue to the block's "No answer" exit instead of hanging up.
- **Voicemail block:** hands off to `terminate_vvm` for the chosen mailbox's DID.
- **Budgets:**
  - a step budget, the 30-minute wall-clock cap, and a max Go-to depth
  - on any internal error, a fixed system "sorry, goodbye" prompt (shipped in the repo like `sounds/vm/*`), then hang up, with `ivr_exit=error`
- **CDR channel variables:** set for the §4.4 columns.

### 7.4 Prompt cache
- **`lib/ivr_prompts.lua`:** a content-addressed cache at `/var/lib/crag/ivr-prompts/<sha256>.wav`.
  - It runs on the persistent volume added to `docker-compose.media.yml`, which needs a one-time FS container recreate.
  - On a miss it reads the local replica, verifies, and does an atomic rename.
- **System prompts** ship in the repo. FS images have no sound packages.

### 7.5 Voicemail survives an East outage (D11)

**Today** (`lib/vm_box.lua`, `lib/vm_deposit.lua`):
- answer → `GET /v1/voicemail/fs/mailbox/{id}` (3 s; on failure, defaults)
- custom greeting `GET` (on failure, the default greeting)
- record to the `/dev/shm/vm` tmpfs
- after hang-up, `POST /v1/voicemail/fs/deposit`: 3 attempts in about 3 s, then **"message lost"** (`vm_deposit.lua:441-491`)

The API encrypts each message under the customer's KMS key and stores it. Plaintext exists only in RAM (voicemail D8).

**Change:**
1. **Mailbox check falls back to the local replica.** When the API lookup fails, FS reads a narrow view `vm_fs_mailbox` on the zone replica: status, the `accepting` flag computed from the replicated counts and caps, and max seconds. This replaces today's blind defaults.
   - The custom greeting needs the East API to decrypt it, so during an outage callers hear the default greeting. That is acceptable and documented.
   - The lookup gets a short connect timeout, so the caller doesn't wait 3 s before answer.
2. **Seal instead of lose.** If the deposit's fast path fails, FS seals the recording before it leaves RAM:
   - The `openssl cms -encrypt` CLI (already in the FS runtime image, `Dockerfile:281`) runs from tmpfs into a persistent spool `/var/lib/crag/vm-spool/<msg_uuid>.cms`. It uses AES-256-GCM content encryption plus RSA-OAEP to a **platform spool public key**.
   - A small JSON sidecar holds only routing metadata: mailbox id, original received time, caller number and duration.
   - Then the tmpfs plaintext is unlinked.
   - The spool holds only ciphertext: no plaintext or key ever touches disk on the media VM.
3. **Forward when East returns.** A tiny `vm-forwarder` container on each media VM shares the spool volume and the existing ingest header file. It is stdlib-only and has no keys.
   - It retries sealed messages to a new `POST /v1/voicemail/fs/deposit-sealed` with backoff. This is decoupled from FreeSWITCH threads and restarts.
   - The API unseals **in memory** with the spool private key, which exists only on the services VM: a root-only secret file the owner places, like the existing voicemail secrets.
   - It then runs the normal deposit path: per-customer KMS encryption, storage, transcription and notifications. The original received time is kept, and the message UUID is idempotent, so a replay never duplicates.
   - The mailbox is re-checked when the message arrives. If the mailbox was deleted meanwhile, the message is dropped and the drop is audited.
4. **Bounds and visibility:**
   - The spool is capped by age (7 days) and size (2 GB per VM). Anything over the cap is dropped oldest-first and audited.
   - Spool depth and oldest-message age are exported to the existing vmagent metrics for a dashboard tile. There is no pager (owner preference).
5. **Keys:** the public key is in the repo or env, and the private key is a services-VM secret.
   - Multiple recipients are supported for rotation: seal to the current and next keys.
   - Key generation is one owner-run command; Claude supplies it.

**No change:** the direct and IVR→voicemail call paths, the recording format, the encryption at rest, and the API's storage.

---

## 8. TED (separate repo `grteng/ted-next`, separate PR)

1. **Toolkit** `revup_platform/catalog.py` gets a new `RevupArea` "ivr" with operations:
   - `ivr.entitlement.set`, `ivr.flows.list`, `ivr.flows.get`, `ivr.numbers.set_enabled`
   - `numbers.assign`/`unassign` with `product_type='ivr'` (and `voicemail`, which TED also lacks)
   - The writes are added to `repeat_guard._GUARDED`, and the catalog counts are updated in `tests/revup_platform/test_catalog.py` and `tests/features/crag_admin/test_revup_routes.py`.
2. **Backend:** explicit routes in `routes.py`, and Operator-Activity targets in `forwarding.py:30-45`.
3. **Frontend:**
   - `didTypes.ts`/`didMeta.ts` gain `ivr` (+ `voicemail`).
   - A Customer 360 **Products** section gets an IVR toggle, the IVR numbers (assign from inventory, enable/disable), and the flows with publish history (read-only).
   - Onboarding review shows IVR orders.
4. **Docs:** `crag-admin.md` operation table, `docs/operations/external-dependency-contracts.md`, feature `AGENTS.md`.
5. **Pricing:** none (D6). When pricing lands it goes through the existing `tiers.*`/`rates.*` path.

---

## 9. Build phases and PRs (each PR targets `RCF-V1`; TED PR to `ted-next` main)

| Phase | Content | Ships |
|---|---|---|
| P1 Backend | 59/60, `services/ivr/*` + tests, `routers/ivr.py`, admin endpoints, inventory/onboarding branches, `customer_numbers` enrolment, `tts` sidecar | **Dark:** no UI, no FS change. Safe to deploy first. |
| P2 Runtime | `media_leg` extraction, RCF egress extraction + byte-identity harness, `ivr_engine`, `ivr_prompts`, `terminate_ivr`, gate off, media volume | **Dark:** `IVR_ENABLED` unset ⇒ byte-identical RCF/voicemail behaviour. |
| P2V Voicemail resilience | §7.5: `58_vm_outage_resilience.sql` (`vm_fs_mailbox` view), replica fallback, seal-to-spool, `vm-forwarder` container, `deposit-sealed` endpoint, spool key secret, metrics | Live as soon as deployed. The normal path is unchanged; the fallback only engages when East is unreachable. It can ship before IVR. |
| P3 Portal | `/ivr` page + builder, themes, nav, old builder removed | Visible only to entitled customers (none until TED turns one on). |
| P4 TED | §8 | Admin can entitle + assign. |
| P5 Live | Enable on one test customer + one IVR number; then `IVR_ENABLED=true` per zone | Real calls (§10). |

Deploy order: **58 → 59 → 60 → spool key secret (services VM) → API + tts → FS scripts + recreate + `vm-forwarder` (each media VM) → UI → TED → live test.** The owner runs every VM command; Claude supplies paste-ready single-line lists.

**Effort (specialist estimates, engineer-days):**

| Work | Estimate |
|---|---|
| UI | about 14–19 |
| API + data | about 20–30 |
| FS runtime | about 17–25 |
| TED | about 4–6 |
| Voicemail resilience (§7.5) | about 5–8 |

Agents build in parallel on disjoint files; the critical path is P1 → P2's egress extraction → the live test.

---

## 10. Verification

There is no lab or staging step (owner preference); it is local proof, then real calls.

**Before any PR:**
- `pytest`: compiler, policy (US rule tables, own-number ownership, caller-ID modes, injection strings), simulator, endpoints (tenancy/IDOR incl. readonly + admin `customer_id=null`), publish atomicity, revision 409.
- **Lua harnesses** (the voicemail-recipe style, a fake `session`):
  - the engine over fixture plans: barge-in, retries, no-input/invalid, Go-to bounds, hours/caller rules, transfer dispositions, error path
  - `ivr_prompts` cache: miss → replica → verify → atomic write
  - **RCF egress byte-identity:** dial strings/vars before vs after extraction, every existing scenario
- **Guard test:** no customer-controlled string reaches `session:execute` except validated digits, sha-paths and E.164.
- **Local docker E2E:** real PG (all init + 58/59/60) + API + tts + UI.
  - Publish a flow, read it back as the `freeswitch` role from a replica-shaped connection, and drive the engine through it.
  - **Stop the API container and repeat the call** (proves D9).
- **Voicemail resilience** (local E2E, the voicemail recipe):
  1. Stop the API, leave a message: the mailbox check comes from the replica view, then seal → spool.
  2. Scan the spool and every persistent path for RIFF/WAV bytes: expect 0. tmpfs is empty.
  3. Start the API: the forwarder delivers, and the message appears in the inbox with its **original** time.
  4. Replay the same file twice: one message.
  5. Delete the mailbox before the replay: dropped and audited.
  6. Over-cap spool: oldest dropped, audited.
- **UI:** `tsc -b`, `vite build`, eslint, `check-theme-tokens --literals` = 0, and the theme harness at 1440/390 in both themes for admin, admin-preview, tenant and readonly.

**Live (P5):** one IVR test number per zone. Test:
- menu with barge-in, invalid key, no input, "press 9 to repeat"
- after-hours branch
- transfer to an outside US number (caller-ID on and off)
- transfer to the owner's RCF test DID (+16174544217 → +17744045256)
- transfer to a voicemail box, and no-answer → voicemail

Check CDR `ivr_*` columns, `rtp_use_timer_name=soft` on IVR legs only, and Homer ladders.

**Voicemail, live:**
- The normal deposit still delivers instantly, the spool stays empty and `vm-forwarder` is healthy in every zone.
- The outage fallback itself is proven locally. No East outage is staged in production.

**Owner checks before P1 deploy:**
1. `SELECT count(*) FROM ivr_flows;` on the prod primary. Old rows decide whether the legacy importer ships, and whether migration 30's table can be dropped later.
2. Piper voice licences, from the shortlist Claude provides.

---

## 11. Open items (not blocking P1)

| # | Item |
|---|---|
| O1 | ~~Voicemail survives an East outage?~~ **Resolved: in this project** (owner, 2026-10-25) → D11, §7.5, phase P2V. |
| O2 | Pricing for IVR minutes and transfer legs (owner + boss). The data is captured from day one. |
| O3 | Later IVR features: speech input, dial-by-name, live TTS, call recording, hold queues. These need a FS image rebuild or dedicated feature nodes (`fs-media-timer-roadmap`). |
| O4 | API Calling / Trunk / UCaaS flows in the same builder (D10 seam), when those products return. |
