# Full-Platform Audit — revup VoIP Platform

**Date:** 2026-07-01
**Branch audited:** `unified` (working tree includes the uncommitted glass redesign)
**Method:** Five parallel expert reviews — telephony/SIP, backend/API, frontend/UX, market-intelligence, and infra/SRE. Read-only.

> Deployment reality that colors every grade: **production (`RCF-V1`, 4 VMs, GCP us-east1-b) runs RCF only.** Programmable Voice, SIP Trunking, and all UCaaS live on `unified`, verified on a single-VM sandbox and **not cleared for live carrier traffic.** So the audit findings split cleanly into two buckets: those that endanger the **live RCF production** today (data safety, alerting, fraud) and those that **gate GA** of the other products (authorization, E911, STIR/SHAKEN, API keys).

---

## Bottom line

The **call-path engineering is genuinely carrier-grade and frequently above industry par.** The multi-SBC record-route work, the SBC×carrier failover engine, session-timer normalization, Bandwidth quirk handling, the async ESL control plane, webhook HMAC signing, envelope-encrypted voicemail, the zero-`any` TypeScript frontend, and the native SIP-ladder diagnostics are all real, hard-won, and better than what many mid-market competitors ship.

The gaps are **concentrated, not diffuse.** They sit in the unglamorous armor that surrounds the call path: **data safety, operational alerting, authorization completeness, US regulatory compliance, and the AI-voice layer that now defines the market.** Almost none of the fixes require redesign — they land in existing seams.

Two findings are severe enough to name at the top:

1. **There are no database backups of any kind.** If the services VM disk is lost today, every customer account, every DID→forward_to mapping (the product itself), trunk config, rates, and up to 90 days of CDRs (billing evidence) are **gone forever.** Unbounded RPO on the revenue database. (infra)
2. **Three backend endpoints have no working authorization.** Any authenticated user of any tenant can list all customers with balances, delete customers, and **add arbitrary credit to any account** (`customers.py`); read every tenant's CDRs (`cdrs.py`); and originate calls on any tenant's DID (`calls.create_call`, which also has an ESL command-injection surface). (backend)

Neither requires new architecture. Item 1 is ~1 day to bound; the auth holes are S-effort fixes in existing patterns.

---

## What is genuinely strong (credit where due)

- **Multi-SBC in-dialog routing** — double Record-Route with `;r2=on` on the inner entry only (`kamailio.cfg:609,1472`); a correct, advanced solution to GCP passthrough-NLB statelessness that most teams get wrong. **Above par.**
- **SBC×carrier failover engine** — cached TCP reachability pre-check + 4-attempt loop with correct `progress_timeout` (not `originate_timeout`) discipline (`lib/sbc.lua`, `handlers/rcf.lua:777-811`). Better than default CUBE/AudioCodes behavior. **Above par.**
- **Async ESL control plane** (`services/esl_client.py`) — persistent connection, futures-based command correlation, supervised reconnect with bounded backoff, event-confirmed live modification, graceful degradation. **Above par for a homegrown platform.**
- **Webhook HMAC-SHA256 signing** (`services/webhook_signing.py`) — Twilio-style, constant-time verify, real SSRF guard (blocks RFC1918/loopback/metadata), published KAT vector, Lua↔Python byte-identity test. **At/above par.**
- **Envelope-encrypted voicemail** (`routers/voicemail.py`, `services/voicemail_crypto.py`) — per-object AES-256-GCM DEK + KMS-wrapped KEK, crypto-erase, tokenized decrypt-stream playback, audit log. A **genuine compliance differentiator** neither RingCentral nor Zoom sell per-mailbox.
- **TypeScript rigor** — 525 files, **zero** `: any`, zero `as any`, zero `@ts-ignore`; `tsc` exits clean under full strict. **Top ~1% for a codebase this size.**
- **Native SIP-ladder diagnostics** (`components/sip-ladder/`) — per-call ladder, packet inspector, cross-Call-ID correlation, tested against a real broken production call. **Exceeds what Twilio/Telnyx expose in-console.**
- **SIP observability** — Homer/HEP from both Kamailio and FreeSWITCH, per-call MOS/R-factor written into CDRs (`cdrs.py:284-308`). Many wholesale shops never wire MOS into billing records.
- **Documentation & test culture** — root `CLAUDE.md` encodes hard-won lessons as ground truth; 13 pytest files + 15 Lua specs + TwiML conformance corpus + regression "lesson" guards, all runnable via the `Makefile`. **Above par for team size.**
- **Git secrets hygiene** — verified clean across all branches; only `.env.*.example` ever committed; `config_guard.py` fail-fasts on dev-sentinel secrets in production.

---

## Scorecard vs. industry standard

| Layer / Area | Rating | Note |
|---|---|---|
| SIP in-dialog routing / multi-SBC HA | **ABOVE** | Double-RR/`r2=on`; matches Oracle/Ribbon practice for stateless-LB backends |
| Carrier failover & PDD control | **ABOVE** | Cached TCP pre-check + progress_timeout discipline |
| Session-timer handling | **AT** | Bidirectional 1800 normalization + 422 retry |
| SIP diagnostics / MOS-in-CDR | **ABOVE** | Homer on both nodes + native ladder |
| ESL control plane reliability | **ABOVE** | (for homegrown) reconnect/backoff/timeout/degrade |
| Webhook signing (outbound) | **AT/ABOVE** | HMAC + KAT; missing timestamp/replay window |
| Programmable-voice verbs & call control | **AT** | ~14 TwiML-equivalent verbs incl. Stream/Connect; REST originate/modify |
| Frontend TS rigor & architecture | **ABOVE** | Zero-any strict; uniform feature folders; disciplined React Query |
| Encrypted voicemail | **ABOVE** | Envelope crypto + crypto-erase is a differentiator |
| **Signaling/media security (TLS/SRTP for SIP customers, scanner defense)** | **BELOW** | No SIP-TLS/SRTP option; behavioral-only scanner defense; RTP open 0.0.0.0/0 |
| **STIR/SHAKEN & robocall compliance** | **BELOW (absent)** | No signing/verification anywhere; RMD status undetermined |
| **E911 / Kari's Law / RAY BAUM** | **BELOW (broken)** | 911 shadowed for softphones; no dispatchable location |
| **Fraud controls (RCF path)** | **BELOW** | Redis fraud removed from RCF; per-DID cap defaults to unlimited; no international blocklist |
| **Backend tenant isolation (customers/cdrs/create_call)** | **BELOW** | Three unscoped/ungated surfaces incl. a financial-write |
| **API-key auth model** | **BELOW** | None; programmatic access uses the user JWT |
| **Data safety / backups / DR** | **FAR BELOW** | Zero backups; unbounded RPO; 90-day CDR purge with no archive |
| **Monitoring / alerting / on-call** | **FAR BELOW** | No metrics, no alerts, no paging — customers are the monitoring |
| Media HA (single FS/zone) | **BELOW** | Media SPOF; blast radius = all in-zone calls |
| Change management / CI / release eng | **BELOW** | No CI; non-reproducible source builds; no registry |
| Softphone / real-time UX | **BELOW** | No transfer, no multi-call, cosmetic device selection, no notifications |
| UCaaS client parity | **BELOW** | No SMS/fax/video/mobile; queues are monitor-only; **no AI layer** |
| Accessibility (glass surfaces) | **BELOW** | Measured contrast failures; no modal focus trap; broken mobile layout |
| Application security (backend, post-SEC-1/2/3) | **AT** | Real remediation round with tests; the 3 holes above are the exceptions |
| App-layer secrets hygiene (git) | **AT/ABOVE** | Clean history + fail-fast guards |
| Infra security (patching, firewall-as-code, TLS) | **BELOW** | Unverifiable firewall state; self-signed admin TLS; no patch cadence |

---

## Cross-cutting critical findings (corroborated by ≥2 experts)

These carry the most weight because independent reviews converged on them.

1. **E911 is broken *and* non-compliant** — *telephony + market.* A registered softphone dialing `911`/`933` is matched by `local_extension` (`public.xml:60-83`) **before** the emergency handler, which itself sits dead in the carrier-inbound `public` context (`public.xml:573`). 911 never reaches a PSAP for softphone users. No dispatchable location (RAY BAUM), no Kari's Law notification. Legally required for trunk/UCaaS GA; life-safety liability.
2. **STIR/SHAKEN entirely absent** — *telephony + market.* Zero signing/verification. Since the **FCC Third-Party Rule (effective 2025-09-18)** a provider with a signing obligation must sign with **its own SPC token** — "Bandwidth signs for us" is no longer sufficient unless they act under *our* cert. RCF adds a wrinkle: forwarded legs need a `div` PASSporT (RFC 8946) or terminating analytics increasingly spam-label/block them — silent deliverability decay for a utility that must reach customers.
3. **No operational alerting of any kind** — *telephony + infra.* No metrics, uptime probes, or paging. Per-call MOS is captured but nothing watches it. heplify even exports Prometheus metrics on `:9096` that nothing scrapes. Today's outage detection is "a customer calls Granite."
4. **Services VM is a total-loss SPOF for all new call routing** — *telephony + infra.* FreeSWITCH does a per-call PostgreSQL DID lookup through PgBouncer on this VM. The docs' mitigating claim (Redis DID cache) is **stale — the cache was deliberately removed from the RCF path**, so 100% of new calls fail if this VM dies. No prod replica; recovery is manual and unrehearsed.
5. **RCF international/premium toll-fraud exposure** — *telephony + backend.* `forward_to` is format-validated only (`rcf.py:132` accepts any E.164); Redis velocity/prefix-fraud was removed from the RCF path; per-DID concurrent cap **defaults to 0 = unlimited** (`inbound_router.lua:260`); no per-customer cap; no international destination blocklist. A compromised `forward_to` becomes uncapped international fraud on Granite's Bandwidth account.
6. **No CI, and the frontend lint gate is currently red** — *frontend + infra.* The documented pre-push gate (`npm run lint`) fails with 55 errors; the excellent pytest/Lua suites run only when a human remembers. React error #310 has shipped **three times** and the linter is the only structural defense.

---

## Where we stand per product line

### RCF (production, for Granite)
Table stakes met on the mechanics — routing, failover, carrier hardening, portal, admin suite, CDRs, observability are all shipped and strong. **Missing:** STIR/SHAKEN (deliverability + compliance), fraud controls on the forward path, LNP/porting automation, CNAM, and the planned toll-free RespOrg + LCO (blocks the 22K-TFN migration). Grade: **solid product, exposed on compliance and fraud.**

### Programmable Voice (`unified`)
Verb engine (~14 verbs incl. Stream/Connect bidirectional media), REST call control, and webhook signing are **architecturally at parity with Twilio/Telnyx.** Behind on **packaging** (no server-side SDKs, no published SLA, no AMD, single TTS voice, STT hook is a Noop) and **entirely absent from the AI-agent layer** that now defines CPaaS. Add timestamp/replay protection to webhooks (cheap, already flagged).

### SIP Trunking (`unified`)
IP-auth trunks, inbound routing, per-trunk CPS/channel limits shipped. **Missing** vs Twilio Elastic/Telnyx: TLS+SRTP toggle, credential/digest auth, customer-self-serve capacity + fraud controls, disaster-routing URL, porting automation, CNAM, E911. Our edge is infrastructure quality, not customer-facing feature breadth.

### UCaaS (`unified`, sandbox only)
Softphone, encrypted voicemail, conferencing, chat, IVR/flow builder, live dashboards shipped. **Missing** table stakes: SMS/MMS, fax, video, desktop+mobile apps, full ACD (queues are monitor-only), SSO/SCIM, and **the AI layer** (live transcription, summaries, sentiment, AI receptionist) that RingCentral/Zoom/Dialpad now ship at SMB price points. This is the headline competitive gap.

---

## Regulatory checklist (US, mid-2026)

| Obligation | Applies to | Status → Severity |
|---|---|---|
| **Robocall Mitigation Database** registration + annual recert | Whole platform once we're a VSP/intermediate provider in our own right | **CRITICAL/existential** — unlisted = downstream carriers must block all traffic. First determine: whose RMD filing covers this traffic — Granite's or ours? |
| **STIR/SHAKEN own-cert signing** (Third-Party Rule, 2025-09-18) | All outbound legs | **HIGH** — zero capability today; determine VSP-of-record with counsel |
| **Forwarded-call attestation** (`div` PASSporT, RFC 8946) | RCF core mechanics | **MEDIUM-HIGH** — deliverability risk (spam-labeling) |
| **E911: Kari's Law + RAY BAUM** dispatchable location | Trunk + UCaaS | **CRITICAL for GA** — currently broken + absent |
| **CPNI annual certification** (officer-signed) | All interconnected-VoIP | **HIGH** — no program artifacts; audit logging is a good input |
| **CALEA** lawful intercept | Trunk, UCaaS, API | **MEDIUM-HIGH at GA** — typically via Trusted Third Party |
| **TCPA + AI-voice** (AI voices are "artificial"; consent + disclosure) | Programmable Voice, any AI agent | **MEDIUM now → HIGH when we ship AI** — design consent/opt-out from day one |
| **10DLC / TCR** | Only if SMS ships | N/A today |
| **SOC 2 Type II + HIPAA BAA** | Enterprise/healthcare/gov sales | **HIGH commercially** — deal-blocking; strong technical inputs exist, no audit program |

---

## Prioritized roadmap

Effort: **S** ≤ 1 day · **M** = days · **L** = weeks.

### P0 — do now (live-production risk + GA blockers)

*Protect the running RCF production:*
1. **Database backups (S→M).** Same-day: GCE disk snapshot schedule + nightly `pg_dump` to versioned GCS. Then pgBackRest to GCS (WAL archiving = PITR) + a **tested restore drill.** Single highest-leverage fix in the whole audit — converts unbounded loss into bounded. *(infra)*
2. **Basic alerting (S).** GCP uptime checks (VIP:5060, API `/health`, UI) + alert policies (VM down, **disk >85%**, CPU) + an SMS/email notification channel. Also alert on retained replication-slot WAL (silent disk-fill trap). Nobody should be unpaged again. *(infra)*
3. **RCF fraud controls (M).** International/premium destination blocklist on the forward, per-customer concurrent + CPS caps, a sane default per-DID cap (not 0). Gate non-NANP `forward_to` behind an explicit per-customer flag in `validate_forward_destination`. Implement in Kamailio htable/DB (avoids the mod_lua Redis threading issue) or a synchronous Redis client. *(telephony + backend)*
4. **Fix E911 (S routing + M location).** Add `911|933` above `local_extension` in the `default` context; wire Bandwidth Dynamic Location Routing per DID; add a Kari's Law notification hook. *(telephony)*

*Gate GA of trunk/api/UCaaS:*
5. **Backend authorization holes (S–M).** `require_admin`/tenant-scoping on `customers.py` (esp. `add_credit`, `delete`); `get_customer_filter` on all `cdrs.py` query endpoints; DID-ownership check + Pydantic validation + ESL newline-escaping on `calls.create_call`. Add multi-tenant isolation tests for `customers` and `cdrs` (the two routers the existing suite doesn't cover — which is why these survived). *(backend)*
6. **Verify-and-close unauthenticated admin surfaces (S).** Confirm in GCP that Grafana :3000 (anon + default pw), qryn :3100 (no auth), HEP :9060/:9061 are not internet-reachable; confirm prod coturn is not running the committed `dev-turn-secret-change-me`. *(infra)*

### P1 — table stakes (weeks)
7. **STIR/SHAKEN posture (M–L)** — determine VSP-of-record; register in RMD; capture inbound `Identity`/`verstat`; long-term own-cert signing at the SBC. *(telephony + market)*
8. **CI gate (S–M)** — GitHub Actions running the existing Makefile suites + `tsc --noEmit` + `eslint` + `kamailio -c` + compose validate; branch protection; get lint to green; commit/branch the 104-file working tree. *(frontend + infra)*
9. **Reproducible builds (M)** — pin FreeSWITCH + sofia-sip/spandsp/libks source to tags, base images by digest, exact pip pins; build once → Artifact Registry → deploy by digest. Rollback stops being a gamble. *(infra)*
10. **East PG streaming standby (M)** — ~$97/mo; the self-bootstrapping replica pattern already exists; doubles as the West replica template. Cheapest real reduction of the services-VM blast radius. *(infra)*
11. **API-key auth model (L)** — account-scoped keys, hashed at rest, scopes, rotation; auth path resolves JWT (console) or API key (programmatic). *(backend)*
12. **JWT revocation + status recheck (M)** — `jti` + refresh, or minimally re-validate `users.status`/role per request. *(backend)*
13. **Rate limiting (M)** — Redis-backed per-IP/per-account on `/auth/login` + write endpoints (reuse the CPS sliding-window Lua). *(backend)*
14. **Migration discipline (M)** — Alembic or a versioned SQL runner with a `schema_migrations` table. *(backend)*
15. **NLB health = downstream FS reachability (M)** — dispatcher-aware HTTP 200/503 health agent before any multi-zone cutover, or the documented zone-failover silently won't happen. *(infra)*
16. **CDR dead-letter (S)** — spool to disk/GCS on DB-insert failure so "always return 200" stops meaning "silently dropped." *(backend + infra)*
17. **SIP-TLS + SRTP for trunk customers (M)**; **RTP firewall** restricted to Bandwidth ranges (S); **SIP scanner UA blocking** (S). *(telephony)*
18. **Frontend blockers (S each)** — `RequireVoicemail` guard (voicemail-only customers are currently bounced), root + per-route ErrorBoundaries, responsive layout fix (`AppLayout` unconditional 240px margin). *(frontend)*
19. **Secret Manager + rotation runbooks (M)**; **CPNI program** artifacts (legal-ops). *(infra + market)*

### P2 — competitive parity
- **Durable billing + call-status callbacks** (outbox/broker; today per-call fee is fire-and-forget `BackgroundTasks`) *(backend)*; cursor pagination + CDR retention/archival to GCS before the 90-day purge.
- **Softphone UX** — real device selection (`deviceId` + `setSinkId`), multi-call + blind/attended transfer, incoming-call notifications + ringtone gesture fix, reconnect UX. *(frontend)*
- **T.38 fax, CNAM, digest trunk auth** *(telephony)*; idempotency keys on `POST /calls`; hard API-layer UCaaS gate for `rcf` accounts.
- **OpenTofu East import + firewall-as-code** (ground truth already captured); GCP Ops Agent metrics + dashboards; **Ansible** deploy layer (gate for sustainable 3-zone ops). *(infra)*
- **A11y pass** — modal focus trap/restore, contrast tokens (`textFaint` fails AA), chip font size; **route-level code-splitting** (single 1.9 MB chunk today). *(frontend)*
- **Queues → supervisor console** (agent states, barge/whisper/monitor, wallboard); wire chat attachments/read-receipts. *(frontend)*
- **Vitest + first suites** — guard-predicate matrix, verto message handling, flow compilers. *(frontend)*

### P3 — differentiators / "get above par" (see next section)

---

## How we get *above* par — leapfrog plays

Ordered by leverage relative to what we already own.

1. **In-boundary "BYO-AI" voice-agent runtime for regulated buyers.** We own the hard parts — bidirectional WebSocket media (`Connect`/`Stream`), a TwiML engine, self-hosted TTS, and an STT hook. Wiring OpenAI Realtime/Deepgram/ElevenLabs behind that yields a Twilio-ConversationRelay-equivalent **deployable inside the customer's compliance boundary** (no PHI/CPNI leaving the VPC) — which the usage-metered hyperscalers won't offer. Our marginal cost on owned FreeSWITCH is carrier minutes vs Telnyx's $0.05/min bundled. Bandwidth's own BYO-AI pivot validates the posture. **This is the smallest distance-to-frontier gap we have, and the market repriced around it in 2025-26.**
2. **Compliance-as-product.** The envelope-encrypted voicemail (customer-verifiable crypto-erase, decrypt-audit log) is *already built* and unmatched per-mailbox in mid-market UCaaS. Extend the pattern to recordings + chat, wrap SOC 2 Type II + BAA, and it's the wedge into healthcare/gov/utility — exactly Granite's buyers.
3. **Sell the SIP ladder.** Our native Homer-backed troubleshooting (per-call ladder, packet inspection, cross-Call-ID, MOS/jitter) exceeds Twilio Voice Insights. Productize it for wholesale/carrier buyers as self-service call-trace + PCAP export for Bandwidth disputes — near-zero net-new engineering.
4. **Call Flow Builder as the headline.** Product-agnostic compile targets + simulate + version history already exceed Twilio Studio's single-product model. Ship customer-facing read-only view, then scoped self-service editing (palette-per-product was built for this).
5. **API-first toll-free RespOrg with LCO.** The 22K-TFN migration forces multi-carrier inbound + SMS/800 CR management anyway; done as a product (bulk CR ops, per-TFN carrier steering, transparent LCO savings reporting) it competes in a thin field, and Granite's carrier contracts are an unfair supply-side advantage.
6. **Teams Direct Routing / Operator-Connect PSTN for the Granite base.** Pure SBC+trunk play on infrastructure we already run — monetizes it for M365-standardized utility customers *without* building the mobile/desktop clients that are our biggest UCaaS gap.

---

## The honest summary

This is a small team that shipped a real, security-conscious, exceptionally documented carrier deployment with above-par SIP engineering and diagnostics. The risk is concentrated in two places: **(a) one un-backed-up VM, and (b) the absence of anyone being told when things break** — plus a **regulatory/authorization layer** that must close before the non-RCF products can be sold. P0 items 1–2 are roughly a week and move the platform from "one disk failure from catastrophe" to "boringly recoverable." The competitive frontier gap (AI voice) is real but reachable — the media plane is already built for it.

*Per-domain detail, file:line references, and effort estimates are preserved in the audit run that produced this document.*
