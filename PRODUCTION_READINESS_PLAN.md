# Production Readiness Plan — Unified UCaaS Platform

**Status:** Draft for execution · **Owner (PM):** Claude · **Started:** 2026-06-18
**Mission:** Produce ONE unified branch that runs the **complete UCaaS / customer-products stack**
(conferencing, voicemail, IVR builder, WebRTC softphone, chat, presence, documents, programmable
voice) on top of the **production-hardened SIP/infra foundation** from RCF-V1 — then harden the
restored features and build the genuinely net-new services (call recording, media streaming for AI,
async ESL control, webhook security) on top. Verified end-to-end before we call it done.

This system is **pre-production / homegrown**. No live carrier traffic depends on it yet, so we build
the test harness FIRST and make every change provably correct against it.

---

## Branch Topology (the foundational fact)

- `Full-System` (= `main`, d456297) is the **common ancestor** — the pre-strip snapshot with the full
  UCaaS stack (all SOLID, not stubs).
- `RCF-V1` is **223 commits ahead** of it. Those commits BOTH (a) added all production hardening AND
  (b) stripped the UCaaS stack to make RCF lean.
- **Decision (locked): build the unified branch FROM RCF-V1** (hardening intact, untouched) and
  **restore the ~50 additive UCaaS files** on top. We do NOT port hardening onto Full-System — that
  would re-derive the riskiest SIP code (record-route/`r2=on`, Cloud NAT, failover) and risk
  reintroducing solved production bugs.

**End state = exactly what was asked:** full UCaaS running on the hardened foundation. We just carry
the dangerous code as-is and re-apply the safe (additive) code, instead of the reverse.

---

## What Already Exists vs What's Net-New (from the Full-System audit)

**Already built (SOLID) — RESTORE + HARDEN, do not rebuild:**

| Feature | API | FreeSWITCH | UI |
|---|---|---|---|
| Conferencing | `conference.py` (810L), ESL live control, `13_schema_conferencing.sql` | `mod_conference` + `conference.conf.xml` | `ConferencePage` (2493L) |
| Voicemail | `voicemail.py` (243L) + ingest, `10_schema_ucaas.sql` | `mod_voicemail` + `voicemail.conf.xml` | `VoicemailPage` (832L) |
| IVR builder | `ivr.py` (603L) — JSON tree → TwiML, served to voice_webhook | (runs via voice_webhook.lua) | `IvrBuilderPage` (800L) |
| WebRTC softphone | `webrtc.py` creds | `mod_verto` + `mod_rtc` + `verto.conf.xml` | `verto.ts` + 8 softphone components, `SoftphoneContext` |
| Chat / Presence / Documents / Extensions | full routers + schemas | — | full pages |

**Genuinely net-new (absent on BOTH branches) — BUILD:**
- Standalone **call recording** (only conference recording exists today)
- **Media streaming / event-driven ESL** (switchio) — current `esl_client.py` is command-only
- TwiML **`<Record>` / `<Stream>` / `<Conference>` verbs** (current engine has 8 verbs, none of these)
- **Webhook signing** + **real XML parser** for the programmable-voice engine

---

## Operating Rules

1. **Every phase is owned by expert agent(s).** PM (Claude) dispatches, reviews the diff, gates the next
   phase. We go one phase at a time, together. Nothing in phase N+1 starts until phase N passes + you approve.
2. **Behavior-preserving work is proven, not asserted** — against the golden baseline from Phase 0.
3. **The RCF simplicity rule is law:** RCF customers NEVER see UCaaS features. UCaaS applies only to
   `api`/`trunk`/`hybrid`/`ucaas` account types. Enforced at API + UI + call routing.
4. **No phase merges with a failing test or a dead-code regression.** Definition of Done is non-negotiable.
5. **Secrets stay in `.env`.** No signing keys, ESL passwords, TLS keys, storage creds in git.
6. **Type-check the UI** (`tsc --noEmit`) on any frontend phase — unused imports break the Docker build.

## Definition of Done (every phase)

- [ ] Reviewed by PM against the phase's acceptance criteria.
- [ ] Automated tests exist and pass (pytest / Lua busted / SIPp scenario / TwiML conformance).
- [ ] No dead code; anything obsoleted is deleted, not commented out.
- [ ] Docs updated: `CLAUDE.md` + this plan's checkboxes.
- [ ] Local stack (`docker compose up -d`) comes up clean; smoke path works for every product.

## Expert Agent Ownership

| Agent | Domain |
|-------|--------|
| `telephony-systems-expert` | Lua, FreeSWITCH XML/dialplan/sofia, Dockerfile module builds, SIPp, TwiML verbs, mod_conference/verto/voicemail/audio_stream |
| `python-backend-architect` | FastAPI routers, main.py wiring, DB schemas/migrations, switchio ESL, webhook signing, media WS consumer, recordings API |
| `frontend-fullstack-expert` | React: restore UCaaS pages/components, new recordings/live-control UI, type-safe clients |
| PM (Claude) | Dispatch, diff review, gating, final end-to-end verification |

---

## Phase Map & Dependencies

```
Phase 0  Safety Net & RCF Characterization        (telephony + python)   ── FIRST
   │       (golden baseline of RCF-V1 hardened behavior + test harness)
   │
Phase 1  UNIFY — restore UCaaS onto RCF-V1 base   (telephony + python + frontend)
   │       (the "catch Full-System up to the hardening" goal)
   │
Phase 2  Lua Refactor (behavior-preserving)        (telephony)
   │       (handlers/* + lib/* separation, kill dup, delete dead code)
   │
Phase 3  Harden Programmable-Voice Engine          (telephony + python)
   │       (real XML parser · webhook signing · fix record-lie · robust fetch) — also fixes IVR
   │
Phase 4  Harden Restored UCaaS Features            (telephony + python + frontend)
   │       (shared storage · WebRTC TLS+TURN · upload security · ESL pw · ReDoS · tenant audit)
   │
Phase 5  ESL Control Plane — switchio              (python)
   │
Phase 6  Media Plane + Record/Stream + Recording   (telephony + python)
   │
Phase 7  Net-New TwiML Verbs                        (telephony)
   │       (<Conference> wiring to existing mod_conference, <Enqueue>, Dial SIP/Client, TTS)
   │
Phase 8  UI for Net-New Services                    (frontend)
   │       (recordings browser, live call control, stream/AI monitoring)
   │
Phase 9  PM End-to-End Verification & Sign-off      (PM)
```

---

## Phase 0 — Safety Net & RCF Characterization

**Why first:** Phase 1 reconciliation must provably NOT break RCF-V1's hardened SIP paths. We snapshot
today's RCF-V1 behavior as a golden baseline and build the harness everything else is tested against.

**Owner:** `telephony-systems-expert` (Lua/SIPp) + `python-backend-architect` (pytest/webhook harness)

**Tasks**
1. Lua unit-test harness: `busted` + a FreeSWITCH `session`/`freeswitch.*` mock; `make test-lua` target.
2. TwiML conformance corpus under `tests/twiml/` (all 8 current verbs + fragile inputs: escaped quotes,
   entities, 2-level nesting, missing close tags). Extend `docker/webhook-test/webhook_server.py` to
   serve it and record what the engine fetched/POSTed.
3. SIPp scenarios per RCF-V1 product (RCF inbound, API-voice inbound, trunk outbound) beside
   `docker/sipp/scenarios/uac_short_call.xml`.
4. **Golden baseline:** run the full suite against `RCF-V1` HEAD; commit goldens under `tests/golden/`.
   This is what Phase 1 + Phase 2 must reproduce for the RCF/trunk/api paths.

**Acceptance:** `make test-lua` runs; conformance suite green on current engine; SIPp smoke passes per
product on local `docker compose`; golden baseline committed.

**Checkpoint:** ⛔ Gate — no reconciliation until the net exists.

---

## Phase 1 — UNIFY: Restore UCaaS onto the Hardened RCF-V1 Base

**Why:** the "bring Full-System up to date with the hardening" goal — achieved by carrying RCF-V1's
hardening as-is and re-adding the additive UCaaS layer on top.

**Owner:** `python-backend-architect` (API/DB) + `telephony-systems-expert` (FS) + `frontend-fullstack-expert` (UI)

**1.0 — Reconciliation map (do BEFORE touching code).** Diff the 223 commits to enumerate: (i) the exact
stripped UCaaS files to restore (~50), (ii) the SHARED files RCF-V1 changed that UCaaS depends on — the
integration points — namely `docker/api/src/main.py` (router registration), `inbound_router.lua` +
`dialplan/public.xml` (voicemail/extension/conference routing), sofia profiles (WSS for Verto), postgres
`init/` ordering, `docker-compose*.yml`, nginx. Write the map to `docs/UNIFY_INTEGRATION_MAP.md`.

**1.1 — Create branch** `unified` off `RCF-V1`.

**1.2 — API layer (python).** Restore routers: `conference, voicemail, ivr, webrtc, chat, presence,
documents, extensions, api_dids`; register in `main.py`. Restore schemas `10_,11_,11b,11c,11d,12,13,15,17`;
reconcile init ordering with RCF-V1's schema changes (no number collisions, no FK breakage).

**1.3 — FreeSWITCH layer (telephony) — HIGHEST RISK.** Re-enable modules in the Dockerfile
(`mod_conference, mod_verto, mod_rtc, mod_voicemail, mod_callcenter, mod_valet_parking, mod_spy, mod_av`).
Restore `conference.conf.xml, verto.conf.xml, voicemail.conf.xml`. Reconcile sofia profiles + dialplan +
`inbound_router.lua` to route voicemail/extension/conference **without regressing** the hardened
RCF/trunk/api SIP paths (record-route/`r2=on`, Cloud NAT, failover, session timers MUST stay intact).

**1.4 — UI layer (frontend).** Restore pages (Conference, Voicemail, IVR, Chat, Documents, Communications),
softphone components + `verto.ts` + `SoftphoneContext`, chat components + `ChatContext`, api clients, types,
routes/nav. `tsc --noEmit` clean (watch the SoftphoneWidget hooks-above-early-return trap → React #310).

**1.5 — Account-type gating.** Enforce the RCF simplicity rule: UCaaS features visible/usable only for
`api`/`trunk`/`hybrid`/`ucaas`, never `rcf` — at API authorization, UI nav, and call routing.

**Acceptance**
- Phase 0 golden baseline reproduced for RCF/trunk/api paths (hardening provably intact).
- Full stack builds; all services healthy; FS loads all restored modules without CRIT.
- Smoke per UCaaS feature: create+join a conference, deposit+list a voicemail, register the Verto
  softphone and place a call, build+execute an IVR flow.
- RCF account cannot see/reach any UCaaS feature (gating test).

**Checkpoint:** ⛔ Gate on ANY golden diff to the RCF/trunk/api paths. PM diff-reviews the FS reconciliation
(1.3) line by line — this is where regressions hide.

---

## Phase 2 — Lua Refactor (Behavior-Preserving)

**Why:** separate products into clean handlers AND kill duplication in one pass (separating without
factoring multiplies copy-paste). Now spans RCF + UCaaS routing. Zero behavior change.

**Owner:** `telephony-systems-expert`

**Target**
```
scripts/
  inbound_router.lua  → thin dispatcher: normalize → DID lookup → require(handler)
  handlers/ rcf.lua · api_voice.lua · trunk.lua · api_outbound.lua  (+ voicemail/extension routing)
  lib/ e164.lua · caller_id.lua · dialstring.lua · sbc.lua  (+ existing db/redis/redis_cps)
```
Delete dead code confirmed by audit: `outbound_api.lua` (unreferenced); verify+remove `xml_handler.lua`.

**Acceptance:** golden baseline reproduced exactly; ~−200 lines dup removed; no logic in two places; new
`lib/` modules unit-tested; `grep` shows no refs to deleted files.

**Checkpoint:** PM diff-review for true behavior-preservation.

---

## Phase 3 — Harden the Programmable-Voice Engine

**Why:** the three blockers in the TwiML engine (`api_voice.lua`). Also directly improves the **IVR**
product, which executes through this engine.

**Owner:** `telephony-systems-expert` (engine) + `python-backend-architect` (signing scheme + verifier)

**Tasks**
1. **Real XML parser** — replace the regex parser with `lua-expat` (lxp): decode entities, handle escaped
   quotes/CDATA, arbitrary nesting depth, reject malformed loudly (never silent wrong behavior). Also closes
   the ReDoS risk in the regex parser.
2. **Webhook signing + transport** — HMAC-SHA256 header (`X-Revup-Signature`, Twilio-style) over URL+sorted
   params; enforce `https://` (dev allowlist for `http`); per-customer secret in DB; publish verify recipe.
3. **Fix the `record` lie** — `<Dial record>` is parsed and ignored today; implement (ties to Phase 6) or
   reject loudly in the interim. No advertised attribute may silently no-op.
4. **Robust fetch** — apply `fallback_url` to action URLs (Gather/Dial/Redirect), bounded retry+backoff,
   env-tunable timeout.

**Acceptance:** every fragile conformance case now correct; malformed → defined error path; signature
round-trip verifies in pytest; no advertised attribute no-ops; action URLs honor fallback.

**Checkpoint:** PM verifies the parser swap regressed no working verb (RCF IVR flows included).

---

## Phase 4 — Harden the Restored UCaaS Features

**Why:** the audit's critical pre-production gaps in the existing UCaaS code.

**Owner:** `telephony-systems-expert` (FS storage/TURN) + `python-backend-architect` (security/storage) + `frontend-fullstack-expert` (any UI auth)

**Tasks**
1. **Shared storage for HA** — voicemail (`/var/lib/freeswitch/voicemail`) and conference recordings
   (`/data/recordings`) move to S3-compatible/NFS so any media node serves them. (Storage backend = open
   decision, decide at phase start.)
2. **WebRTC production transport** — replace self-signed Verto TLS with real CA certs; stand up a **TURN
   server** (coturn) — STUN-only fails behind symmetric NAT. Wire creds via `webrtc.py`.
3. **File-upload security** — chat attachments + document uploads: type/size validation, AV scan hook,
   tenant-scoped storage paths, no path traversal.
4. **ESL password** — eliminate the default `ClueCon`; require `ESL_PASSWORD` from `.env` everywhere.
5. **Multi-tenant authorization audit** — every UCaaS router enforces `customer_id` scoping (no IDOR);
   add tests that one tenant cannot read another's conferences/voicemails/chats/docs.

**Acceptance:** media artifacts served from shared storage; Verto call works over real TLS + TURN behind
NAT; upload abuse cases rejected (tested); no default ESL pw anywhere; cross-tenant access tests pass.

**Checkpoint:** PM runs the cross-tenant + upload-abuse test matrix personally.

---

## Phase 5 — ESL Control Plane (switchio)

**Why:** the event-stream gap. Raw `esl_client.py` is command-only (can't see `CHANNEL_ANSWER`/`DTMF`/
`HANGUP`). **Decision: switchio** (asyncio-native; fits FastAPI/uvicorn; greenswitch's gevent conflicts).

**Owner:** `python-backend-architect`

**Tasks**
1. Pin `switchio`; async inbound ESL event consumer in the FastAPI lifespan; authoritative live-call state.
2. Consolidate to one ESL client pattern (no drift between raw + switchio).
3. Live call-modification REST (redirect-to-new-TwiML / hangup / transfer / DTMF), event-confirmed.
4. Replace `uuid_dump` polling with real events where possible; reconnect/backoff + health metric.

**Acceptance:** test originate → observed events drive state (pytest + SIPp); live-modify redirects an
in-progress call; survives FS restart (reconnect test); one ESL client pattern remains.

**Checkpoint:** PM confirms event-driven state matches reality.

---

## Phase 6 — Media Plane + `Record`/`Stream` + Standalone Recording

**Why:** the future-facing layer — recording and real-time audio for AI/transcription. ESL is control-only;
media uses audio-fork over WebSocket.

**Owner:** `telephony-systems-expert` (module + verbs) + `python-backend-architect` (consumer + storage + API)

**Tasks**
1. Build **`mod_audio_stream`** into the FS image (clone → configure → enable, same pattern as other modules).
2. **`<Stream>`/`<Connect><Stream>`** verbs → fork call audio to a WebSocket. Python WS consumer with a
   transcription stub (provable path, vendor-agnostic).
3. **`<Record>` verb + standalone call recording** — real recording (`uuid_record`/`mod_sndfile`),
   `recordings` table + shared storage (reuse Phase 4 backend), `recordingUrl` in callbacks + REST fetch.
   Properly resolves Phase 3's record-lie. Unifies with existing conference recording paths.

**Acceptance:** call with `<Record>` → retrievable artifact + DB row + REST fetch; `<Stream>` delivers
frames to the consumer (count/duration asserted); `mod_audio_stream` loaded; FS starts clean.

**Checkpoint:** PM verifies artifacts are real (playback / frame counts), not stubbed.

---

## Phase 7 — Net-New TwiML Verbs

**Owner:** `telephony-systems-expert`

**Tasks**
1. **`<Conference>`** (nested in `<Dial>`) — wire the programmable-voice engine into the **already-built**
   `mod_conference` + `conference.py` (don't rebuild conferencing; expose it as a verb).
2. **`<Enqueue>`/`<Leave>`** — leverage `mod_callcenter` (now enabled) for queues.
3. **`<Dial>` `<Sip>`/`<Client>`** children (today only `<Number>`).
4. **TTS quality** — evaluate replacing `flite` (TTS engine = open decision); SSML if supported.

**Acceptance:** each verb has a conformance fixture + SIPp/local proof; `<Conference>` joins the same room a
UCaaS conference uses.

**Checkpoint:** PM reviews the parity matrix vs Twilio; documents intentional non-goals.

---

## Phase 8 — UI for Net-New Services

**Owner:** `frontend-fullstack-expert` (UCaaS pages already restored in Phase 1)

**Tasks**
1. Recordings browser (list/play/download) on Phase 6 API.
2. Live call view + control (redirect/hangup/DTMF) on Phase 5 endpoints.
3. Stream/AI-transcription monitoring view.
4. Programmable-voice config: per-DID `voice_url`/`fallback_url`/signing-secret management.
5. `tsc --noEmit` clean; hooks-above-early-return honored.

**Acceptance:** each screen reads/writes real APIs; no mock data; type-check passes.

**Checkpoint:** PM clicks through each flow.

---

## Phase 9 — PM End-to-End Verification & Sign-off

**Owner:** PM (Claude) — I run this myself.

1. Clean-room bring-up from scratch; every service healthy.
2. **Per-product proof (local, via SIPp/Verto):** RCF inbound routes & bridges with all hardening; trunk
   outbound passes CPS/velocity; API-voice/IVR fetches **signed** TwiML, executes verbs, records, streams;
   conference create+join+record; voicemail deposit+retrieve; Verto softphone call over TLS+TURN.
3. **Regression:** full suite green; RCF/trunk/api goldens unchanged.
4. **Security spot-checks:** signature verifies + tampered body rejected; non-HTTPS webhook refused;
   cross-tenant access denied; no default ESL pw; `git grep` finds no secrets.
5. **Dead-code/dup audit:** `outbound_api.lua` gone; E.164/dialstring/caller-id defined once (`grep` proof).
6. **Whole-branch diff review** for altitude/consistency.
7. **Sign-off report** appended here: what we built, what's proven, known limitations / intentional
   non-goals, honest production-readiness verdict per area — plainly stated, flagged where it isn't ready.

---

## Decision Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Unified branch base | **RCF-V1 + restore UCaaS** | Carry hard-won SIP/NAT/record-route fixes as-is; UCaaS is additive/isolated. Far lower risk than porting 223 commits onto Full-System |
| ~~ESL library: switchio~~ → **OWN asyncio ESL client** | **REVERSED at Phase 5.** switchio is non-viable: its ONLY PyPI releases are `0.1.0a0`/`0.1.0a1` (ancient alphas) — the latest uses `@asyncio.coroutine` (REMOVED in Python 3.11) and an undeclared `six` dep, so it cannot even import on Python 3.12/FS 1.11 (proven in the FS netns). greenswitch was also dropped (gevent vs asyncio/uvloop). We extended our own raw asyncio client (`services/esl_client.py`) into a single persistent inbound consumer + command channel: native asyncio, zero new deps, full control, no event-loop conflict. EITHER choice was acceptable per the task; the raw client wins on dependency risk. |
| Media path | **mod_audio_stream → WebSocket** | ESL is control-plane only; audio-fork is standard for STT/AI |
| XML parsing | **lua-expat (lxp)** | regex parser is fragile + ReDoS-prone; real parser is the correctness floor |
| Webhook security | **HMAC-SHA256 + HTTPS** | Twilio-parity; lets customers verify authenticity |
| Refactor safety | **characterize-then-refactor** | behavior-preservation proven against golden baseline |
| OPEN — storage backend | TBD @ Phase 4 | S3-compatible vs NFS for voicemail/recordings HA |
| OPEN — TTS engine | TBD @ Phase 7 | keep flite vs higher-quality engine |


## Live Verification Log

**2026-06-18 — Phases 0-2 verified on local Docker stack:**
- Postgres: fresh init 01→20 clean (fixed 2 init-abort bugs: NOW()-in-index, demo-reset); 13 UCaaS tables; Granite DID +16174544217 seed; ucaas account_type CHECK.
- FreeSWITCH: mod_verto/conference/voicemail/av/rtc/valet loaded, no CRIT; refactored handlers/+lib/ load in real mod_lua; verto ws:8082/wss:8083 + sofia internal:5080/external:5090 RUNNING.
- API: /health ok (db+redis); 229 routes incl. all 9 UCaaS routers; WS presence/chat subscribers running.

**2026-06-18 — Phase 3 verified live:** fresh init 01→22 clean (pgcrypto + customers.webhook_signing_secret 64-hex for cust 1/5); lib/xml.lua + lib/hmac_sha256.lua + api_voice.lua load in real mod_lua; HMAC KAT byte-identical Lua↔Python (+Lu6H/...); shell-injection neutralized (shq adversarial test). New env: WEBHOOK_HTTP_TIMEOUT, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_BACKOFF_MS, WEBHOOK_ALLOW_HTTP.

**2026-06-18 — Phase 4 verified live:** fresh init 01→23 clean; MinIO buckets auto-created (recordings/voicemail/uploads); presigned put→GET round-trip; coturn up (realm voip.local); FS entrypoint runs (spool symlinks + loopback), ESL=fs_esl_dev_pw works & ClueCon REJECTED, verto ws:8082/wss:8083 RUNNING, no CRIT; API healthy; webrtc creds mint coturn HMAC-SHA1 TURN creds; voicemail/ingest JWT-exempt (200); 2 IDOR holes (api_dids+ivr) fixed, 18 cross-tenant attempts denied; uploads reject 415/413. New infra: minio+coturn services, media_spool volume, STORAGE_*/TURN_* env.

**2026-06-18 — Phase 5 verified live (ESL control plane):** switchio REJECTED (only PyPI alphas 0.1.0a0/0.1.0a1; latest uses `@asyncio.coroutine` removed in py3.11 + undeclared `six` — cannot import on py3.12; proven in FS netns) → extended our OWN persistent asyncio ESL client. ONE pattern now: single inbound connection multiplexes event consumption (live-call registry) + api/bgapi commands; calls.py/trunks.py/conference.py all route through it (grep: 1 `open_connection` in esl_client.py, 1 `class ESLClient`). FastAPI lifespan starts the supervised consumer (exp backoff 1→2→4…30s, never blocks/crashes startup). `/health` gained an informational `esl` field (connected/last_event_ts/reconnects) that is NOT part of the health verdict. Event-confirmed live-modify on `/v1/calls/{id}/update` (hangup/transfer/redirect/dtmf — confirmed by observing the resulting CHANNEL event). `get_call_status` reads the event-derived registry first, falls back to `uuid_dump`. Tests: 16 new unit (registry transitions/waiter/backoff/graceful-degrade) + in-FS-netns integration (real FS: bgapi originate → CHANNEL_CREATE→ANSWER→event-confirmed HANGUP cause=NORMAL_CLEARING; fs_cli-originated channel independently observed dest=9999; FS-restart reconnect: down→2/4/8/16s backoff→reconnected). Full gate 64 passed/3 skipped; API stays HEALTHY through 3× FS restarts (connected:false, never crashes — DD host-net/bridge isolation). greenswitch removed from requirements.txt.

## Progress Tracker

- [x] Phase 0 — Safety Net & RCF Characterization  ✅ 34 char tests + 40 lessons guards + 33 TwiML fixtures, all green & PM-verified
- [x] Phase 1 — UNIFY: restore UCaaS onto RCF-V1  ✅ 55 files restored + grafted; hardening intact (43 char + 40 guards green); ucaas branch activated + bug fixed; RCF gated. Deferred to live env: postgres init dry-run, FS image build, live call test
- [x] Phase 2 — Lua Refactor (behavior-preserving)  ✅ inbound_router 1071→500 (thin dispatcher); handlers/{rcf,trunk,ucaas} + lib/{dialstring,caller_id,session_timer,sbc} extracted; 66 char tests + 40 guards green; guards re-targeted structure-flexibly; outbound_api kept (live via ESL)
- [x] Phase 3 — Harden Programmable-Voice Engine  ✅ real pure-Lua XML parser (9 known-bugs fixed) + HMAC-SHA256 webhook signing (KAT byte-identical Lua↔Python) + HTTPS enforce + record-warning + robust fetch; injection-safe curl transport (adversarially verified); 80 twiml/66 lua/51 lessons+signing green; live mod_lua + init-22 verified
- [x] Phase 4 — Harden Restored UCaaS Features  ✅ S3-compatible object storage (MinIO/GCS) for vm+recordings+uploads; coturn TURN + env-driven WebRTC TLS; upload security (type/size/sanitize/AV-hook); ESL ClueCon KILLED (entrypoint hard-fails); 2 critical IDOR holes fixed (api_dids+ivr) + 22-assert tenant-isolation suite; CLAUDE.md docs refreshed
- [x] Phase 5 — ESL Control Plane  ✅ switchio rejected (py3.12-incompatible alpha) → OWN persistent asyncio consumer+command client; ONE ESL pattern; live-call registry from real FS events; event-confirmed live-modify (hangup/transfer/redirect/dtmf); supervised reconnect/backoff + /health esl field; 16 unit + in-netns integration (originate→CREATE→ANSWER→confirmed HANGUP, fs_cli observe, FS-restart reconnect) all green; API stays healthy when FS unreachable
- [ ] Phase 6 — Media Plane + Record/Stream + Recording
- [ ] Phase 7 — Net-New TwiML Verbs
- [ ] Phase 8 — UI for Net-New Services
- [ ] Phase 9 — PM Verification & Sign-off
