# Compliance Posture — revup / Granite Voice Platform

**Last updated:** 2026-07-02
**Scope:** the `unified` branch platform (RCF, Programmable Voice, SIP Trunking, UCaaS, AI voice agents).

This document maps **what the platform enforces in code today** to the controls that
matter for **SOC 2 Type II** and the **HIPAA Security Rule**, and — just as important —
states honestly what is **still process/organizational work**, not code. It is the
technical half of the "compliance-as-product" story: the encryption, audit, and
isolation controls below are real, per-object, and customer-verifiable, which is the
wedge into healthcare / government / utility buyers that the mid-market incumbents do
not sell per-tenant.

> **Code-enforced vs. process.** A control is only listed as *Enforced* if it is
> implemented in this repository and exercised by a test or a live path. Everything
> that requires a signed document, an external audit, a written policy, or a human
> procedure is listed under **Organizational gaps** and is explicitly NOT claimed as
> done.

---

## 1. Encryption at rest — envelope encryption (`services/envelope_crypto.py`)

One auditable key-management surface for every sensitive object type.

| Object | Status | Where |
|---|---|---|
| Voicemail | **Enforced** (shipped) | `services/voicemail_crypto.py` → now delegates to `envelope_crypto.py` |
| Call recordings | **Enforced** (new; default-off per-write flag `RECORDINGS_ENCRYPTION`) | `routers/recordings.py` |
| Chat messages + attachment refs | **Enforced** (new; default-off flag `CHAT_ENCRYPTION`) | `routers/chat.py` |
| AI-agent transcripts | Handoff available (call `envelope_crypto`) | `services/ai_agent.py` (`store_transcript` per agent) |

**Model (per object):** a fresh random 256-bit **DEK** encrypts the object with
AES-256-GCM; the DEK is **wrapped by a KEK** (KMS) and only `(ciphertext, iv,
wrapped_dek)` is ever persisted. The plaintext DEK lives in memory for exactly one
seal/open and is scrubbed. **Two KEK providers**, selected per object:
- `local` — MultiFernet from an env KEK (`ENVELOPE_LOCAL_KEK` / legacy
  `VOICEMAIL_LOCAL_KEK`), comma-separated for rotation.
- `gcpkms` — Cloud KMS/HSM (FIPS 140-2 L3) seam present; wire at deploy.

**Crypto-erase (NIST SP 800-88 §2.5):** destroy an object's `wrapped_dek` (per-object,
right-to-erasure) or a scope's KEK (`crypto_erase_scope`, e.g. customer offboarding) →
the data is mathematically unrecoverable at once. One KEK per `(type:customer)` scope
avoids a KMS call per object.

**Back-compat:** already-stored plaintext recordings/chat keep serving; encryption
applies to new writes when the flag is on (mixed state handled).

---

## 2. Access, isolation, and audit

| Control | Status | Where |
|---|---|---|
| Multi-tenant isolation on every data endpoint (get_customer_filter + 404-no-leak) | **Enforced** | all routers; `tests/test_multitenant_isolation.py` |
| Admin-only provisioning (`require_admin`) incl. customer CRUD, credit, CDR re-rating | **Enforced** | `routers/{customers,cdrs}.py` |
| Durable admin audit log (actor, action, target, detail, ip, ts) | **Enforced** (new) | `admin_audit_log` table; credit/delete persist rows |
| Ingest authentication (constant-time shared secret) | **Enforced** | `auth/ingest.py` (CDR/recording/voicemail/AI-WS) |
| Outbound webhook signing (HMAC-SHA256, `X-Revup-Signature`) | **Enforced** | `services/webhook_signing.py` (+ Lua KAT parity) |
| SSRF guard on webhook targets (blocks RFC1918/loopback/metadata) | **Enforced** | `services/webhook_signing.py` |
| JWT auth; production secret fail-fast | **Enforced** | `auth/security.py`, `config_guard.py` |
| ESL / shell / SQL injection guards | **Enforced** | `services/esl_client.py`, `db/*`, Lua `db_client.lua` |

**AI in-boundary guarantee:** an AI agent's `runtime-config` reports
`data_stays_in_vpc = true` only when STT **and** LLM **and** TTS are all self-hosted
(`services/ai_config.py`). Cloud providers are an explicit per-agent opt-in. Secrets are
env-var *names* in config, never stored in the DB or transcripts.

---

## 3. Carrier / regulatory controls (we are the VSP of record)

| Obligation | Status | Where |
|---|---|---|
| STIR/SHAKEN signing (own cert, attestation; `div` for RCF forwards) | **Enforced** (default-off until cert provisioned) | Kamailio `secsipid` (`route[STIR_SIGN]`) |
| STIR/SHAKEN inbound verification (`verstat` → CDR) | **Enforced** | `route[STIR_VERIFY]`, `inbound_router.lua` |
| E911 correct routing (911/933 above extension match) | **Enforced** | `dialplan/public.xml`, `emergency.lua` |
| E911 dispatchable location (RAY BAUM) + Kari's Law notification | **Enforced** (per-DID location provisioning is the remaining data step) | `emergency.lua` |
| Toll-fraud controls on RCF (intl gate, per-customer caps, prefix blocklist) | **Enforced** | `handlers/rcf.lua`, `rcf.py`, `customers` flags |

---

## 4. SOC 2 Type II — control mapping (Trust Services Criteria)

| TSC | Criterion | How this platform addresses it |
|---|---|---|
| CC6.1 | Logical access / least privilege | JWT + `require_admin` + per-tenant `get_customer_filter`; ingest shared-secret; ESL password hard-fail |
| CC6.6 | Boundary protection | SSRF guard; webhook HMAC; RTP/SIP firewall; admin surfaces internal-only (see infra `verify_gcp_security.sh`) |
| CC6.7 | Data in transit / at rest | Envelope encryption at rest (§1); SIP-TLS/SRTP paths (WebRTC now; trunk TLS staged); GCS at rest |
| CC7.2 | Monitoring / anomaly detection | Homer SIP capture; per-call MOS in CDR; **alerting now exists** (infra `infra/monitoring`) |
| CC7.3 / CC7.4 | Incident response | Alert→page path + DB restore runbook (`docs/runbooks/DB_RESTORE_RUNBOOK.md`) |
| CC8.1 | Change management | CI gate (`.github/workflows/ci.yml`): tests + typecheck + config validation |
| A1.2 / A1.3 | Availability / backup | pgBackRest PITR + snapshots + CDR archival (infra `scripts/backup/`); **restore drill required** |
| C1.1 / C1.2 | Confidentiality | Per-object crypto-erase; tenant isolation; audit log |
| P-series | Privacy | Crypto-erase supports right-to-erasure; audit trail of access |

**Evidence inputs are strong; the SOC 2 Type II *report* is not done** — that requires an
observation window + an external auditor (see §6).

---

## 5. HIPAA Security Rule — safeguard mapping

| Safeguard | § | How addressed |
|---|---|---|
| Access control | 164.312(a)(1) | Per-tenant isolation; RBAC; unique user IDs (JWT `sub`) |
| Audit controls | 164.312(b) | `admin_audit_log`; voicemail access log; CDR trail |
| Integrity | 164.312(c)(1) | AES-256-**GCM** (authenticated) at rest; webhook HMAC |
| Transmission security | 164.312(e)(1) | TLS/SRTP (WebRTC); in-boundary AI (no ePHI egress); GCS TLS |
| Encryption at rest | 164.312(a)(2)(iv) | Envelope encryption (§1), addressable spec satisfied |
| Disposal / crypto-erase | 164.310(d)(2)(i) | NIST 800-88 crypto-erase per object and per scope |

**In-boundary AI is the HIPAA-relevant differentiator:** a covered entity can run the
STT/LLM/TTS inside its own boundary, so ePHI in a call never reaches a third-party AI
vendor — no BAA needed with an AI subprocessor because there isn't one.

---

## 6. Organizational gaps (NOT code — required before selling a compliance claim)

These are honest, deliberate omissions. They are policy/audit/legal work:

1. **SOC 2 Type II report** — engage an auditor; run the observation window; the code
   controls above are the evidence, not the certification.
2. **HIPAA** — Business Associate Agreement templates (and subprocessor BAAs); a Security
   Risk Analysis; workforce training; formal policies.
3. **Penetration test** — independent, on the exposed surface.
4. **STIR/SHAKEN** — obtain the SPC token (iconectiv) + signing cert; register in the FCC
   **Robocall Mitigation Database**.
5. **E911** — per-DID dispatchable-location provisioning + Bandwidth DLR trunk enablement;
   the Kari's Law notification *delivery* handler (endpoint behind `EMERGENCY_NOTIFY_URL`).
6. **CPNI** annual certification; **CALEA** lawful-intercept plan (typically a Trusted
   Third Party).
7. **Formal policies** — data retention, key rotation, incident response, access review.

---

## 7. Configuration reference (default-off toggles)

| Env var | Default | Effect |
|---|---|---|
| `RECORDINGS_ENCRYPTION` | `false` | Seal new call recordings at rest |
| `CHAT_ENCRYPTION` | `false` | Seal new chat message bodies at rest |
| `ENVELOPE_LOCAL_KEK` | (unset) | Local-provider KEK (Fernet; comma-separated to rotate) |
| `VOICEMAIL_KEK_PROVIDER` | `local` | `local` or `gcpkms` |
| `AI_AGENTS_ENABLED` | `false` | Enable the AI voice-agent runtime |
| `STIRSHAKEN_PRIVKEY_PATH` | (unset) | Enable STIR/SHAKEN signing when the cert is provisioned |

Turning any of these on activates a control that is already implemented and tested; none
of them changes existing data or behavior until set.
