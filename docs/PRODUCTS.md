# Shale — Product Guide

**Shale** is Granite's carrier‑grade voice platform: distributed voice infrastructure built for the enterprise. It runs your phone numbers, your calls, and your communications on the same hardened network that carries nationwide utility traffic — with automatic failover across multiple availability zones so calls simply don't drop.

This guide is the single source of truth for what Shale does. It's written two ways at once: **plain English** for anyone evaluating Shale or signing up, and a **"For developers"** section on each product for the technical details. It doubles as the content behind the in‑app Docs pages (`/docs`).

> **Who Shale is for.** From a small business that needs one number to always ring the right phone, to a developer building a calling app, to an enterprise running its whole phone system in the cloud, to a wholesale buyer managing tens of thousands of numbers. You pick the products you need; they all run on one account, one balance, one platform.

---

## The products at a glance

| Product | In one sentence | Best for |
|---|---|---|
| **Remote Call Forwarding (RCF)** | Point any phone number wherever you want, and change it instantly. | Businesses that need numbers to always reach the right place. |
| **Programmable Voice** | Control calls with code — build phone apps and automations. | Developers and product teams. |
| **SIP Trunking** | Connect your existing phone system (PBX) to the world. | Companies with an on‑prem or cloud PBX. |
| **Unified Communications** | A full business phone system in your browser and apps. | Teams that want calling, voicemail, chat, and meetings in one place. |
| **AI Voice Agents** | AI that answers and handles calls — and can run entirely inside your own boundary. | Anyone automating phone conversations who cares about privacy. |
| **Toll‑Free & Wholesale** | 8XX numbers, bulk number management, and least‑cost routing. | High‑volume and wholesale buyers. |
| **Billing & Payments** | Prepaid balance with automatic top‑ups — pay only for what you use. | Every customer. |

---

## Remote Call Forwarding (RCF)

**In plain English.** RCF gives you a phone number that you can point anywhere — a cell phone, a call center, another office — and repoint in seconds whenever you want. Your published number never changes; where it rings is entirely up to you.

**Who it's for.** Businesses with published numbers that must always reach a live destination: utilities, multi‑location retailers, service companies, anyone who can't afford a number to go dead when a location, vendor, or on‑call person changes.

**What you get.**
- Nationwide phone numbers (DIDs) in the area codes you need.
- Instant forwarding changes — update the destination and the next call follows the new rule immediately.
- Carrier‑grade reliability: every call is routed through redundant SBCs and multiple carrier paths, with automatic failover across availability zones. If one zone or carrier has trouble, the call takes another path.
- A clean portal to manage your numbers, see call activity, and edit forwarding.

**How it works.** Shale owns the phone number on a carrier network. When someone dials it, the call enters Shale's session border controllers, which look up your forwarding rule and bridge the call out to your destination over a carrier trunk — trying multiple SBC and carrier combinations until one connects. You never touch the plumbing; you just set "forward to."

**Getting started.** Sign up, get a number assigned (or port your own), and set its **forward‑to** destination in the portal. That's it — the number is live.

**For developers.** RCF is a DID → `forward_to` mapping with per‑number ring timeout, caller‑ID passthrough, and optional multi‑destination ring plans (sequential or simultaneous). Routing is a real‑time database lookup on every inbound call, followed by a 4‑attempt SBC × carrier failover bridge with sub‑second dead‑path detection. International/premium destinations are gated by a fraud policy. REST: `/v1/rcf`.

---

## Programmable Voice

**In plain English.** Programmable Voice lets you control phone calls with code. When someone calls your number, Shale asks *your* server what to do — say something, play audio, gather digits, connect the call, record it, run a menu — and does it. It's how you build phone apps: appointment reminders, IVRs, click‑to‑call, notifications, surveys.

**Who it's for.** Developers and product teams who want to add calling to their software.

**What you get.**
- A familiar, TwiML‑compatible instruction set (~14 verbs): Say, Play, Gather, Dial, Record, Conference, Enqueue, Stream/Connect, and more — so if you've used other CPaaS platforms, you're already fluent.
- REST call control: start calls, hang up, transfer, send DTMF, redirect a live call to new instructions.
- Webhooks for every call event, cryptographically signed (`X‑Revup‑Signature`, HMAC‑SHA256) so you can trust they came from us.
- Real‑time media streaming (fork call audio to your own service over WebSocket) — the on‑ramp for transcription and AI.
- Call recording to secure object storage with tokenized playback.

**How it works.** You point a number's **voice URL** at your server. When a call comes in, Shale POSTs the call details to your URL; you respond with XML instructions; Shale executes them and calls back for the next step. Outbound is the mirror image: you originate a call via the REST API and drive it the same way.

**Getting started.** Get an API‑enabled number, set its webhook URL to your endpoint, and return your first `<Response><Say>Hello</Say></Response>`.

**For developers.** Verb engine with `<Dial>` children (`<Number>`/`<Sip>`/`<Client>`/`<Conference>`/`<Queue>`), Gather with speech/DTMF, `<Record>` and `<Stream>`/`<Connect><Stream>` (mod_audio_stream), pluggable TTS (Piper/self‑hosted) and STT. REST originate + live in‑call update at `/v1/calls`. Webhooks are HMAC‑signed with a per‑customer secret and verified with an SSRF‑guarded fetch. Idempotency and per‑customer CPS limits apply.

---

## SIP Trunking

**In plain English.** If you already have a phone system — an on‑prem PBX or a cloud PBX — SIP Trunking is the pipe that connects it to the rest of the world's phone network. Bring your own equipment; we provide the dial tone, the numbers, and the carrier connections.

**Who it's for.** Businesses with an existing PBX (FreePBX, 3CX, Asterisk, Microsoft Teams, etc.) who want reliable, elastic calling without being locked into a hardware carrier.

**What you get.**
- IP‑authenticated trunks — register your PBX's IP and you're connected; no fragile credentials to leak.
- Inbound DID routing to your PBX and outbound calling to any destination.
- Elastic capacity with per‑trunk concurrent‑channel and calls‑per‑second controls.
- Built‑in fraud protection (high‑risk destination blocking, velocity limits) and automatic carrier failover.

**How it works.** You tell us the IP address(es) your PBX will send calls from. Inbound calls to your DIDs are delivered to your PBX; outbound calls from your PBX are authenticated by IP, checked against your limits and fraud rules, and routed out over carrier trunks with failover.

**Getting started.** An admin provisions your trunk, adds your authorized IP(s), and assigns your DIDs. Point your PBX at Shale and place a test call.

**For developers.** Kamailio‑based SBC does IP auth against `trunk_auth_ips`; DID routing via `trunk_dids`; per‑trunk CPS/channel limits and Redis‑backed velocity/fraud checks; outbound bridges carry carrier‑selection headers with 5xx/422 failover. Managed under `/v1/trunks`.

---

## Unified Communications (UCaaS)

**In plain English.** Unified Communications is a complete business phone system that lives in your browser and apps — no desk phones required. Make and take calls, get visual voicemail with transcripts, chat with your team, hold video meetings, run call queues, and share a calendar and documents, all in one place.

**Who it's for.** Teams and offices that want to replace (or skip) a traditional phone system with something modern, mobile, and all‑in‑one.

**What you get.**
- **Softphone** — a WebRTC calling client right in the browser (secure, encrypted media).
- **Visual voicemail** — see your messages as a list, play them, read transcripts. Messages are **encrypted at rest** with per‑message keys and a customer‑verifiable "erase" — a genuine privacy feature most business phone systems don't offer per mailbox.
- **Team chat & presence** — see who's available, message your team.
- **Meetings & conferencing** — audio/video rooms with scheduling and invites.
- **Call queues** — route inbound callers to the right group with hold treatment.
- **Calendar & shared documents** — read‑only calendar integration (Google/Microsoft) and a shared document library for your organization.

**How it works.** You log in and your extension is live in the browser softphone. Calls to your DID ring your softphone; unanswered calls fall to encrypted voicemail and notify you. Chat, presence, meetings, and queues are real‑time features layered on the same account.

**Getting started.** Get Unified Communications enabled on your account, set up your voicemail greeting, and start calling from the softphone.

**For developers / admins.** WebRTC via FreeSWITCH mod_verto (TLS) + coturn TURN relay; voicemail uses envelope encryption (per‑object AES‑256‑GCM data key wrapped by a KMS key) with tokenized playback; chat/presence over Redis pub/sub + WebSockets; conferencing via mod_conference; queues via mod_fifo. Not shown to RCF‑only accounts — feature access is enforced by account type at the API, not just the UI.

---

## AI Voice Agents

**In plain English.** AI Voice Agents are AI assistants that can answer and handle phone calls for you — take a message, route the caller, answer questions, book something, escalate to a human. The Shale twist: an agent can run **entirely inside your own boundary**, so the caller's conversation never leaves your infrastructure. That's a privacy guarantee the big cloud platforms structurally can't make.

**Who it's for.** Anyone who wants to automate phone conversations — reception, triage, after‑hours, high‑volume Q&A — especially in regulated industries (healthcare, government, utilities) where call content can't leave your walls.

**What you get.**
- Build an agent in minutes: a name, a greeting, a personality/system prompt, a voice, and the "tools" it's allowed to use.
- **In‑boundary by default** — the speech‑to‑text, language model, and text‑to‑speech can all be self‑hosted, so no call audio or transcript leaves your VPC. The console shows a live **"in‑boundary" compliance badge** when every layer is self‑hosted (and a clear warning if you opt into a cloud provider).
- Real actions via tool‑calling: transfer to a human, send touch‑tones, capture structured data, look things up — all guarded so a caller can't talk the agent into, say, dialing a premium number.
- Pay per use (see Billing) — including the ability for a customer's own agents to pay per request.

**How it works.** You configure an agent and point a phone number or a Call Flow at it. When a call reaches the agent, Shale streams the caller's audio to speech‑to‑text, feeds the transcript plus your prompt and tools to a language model, speaks the reply back with text‑to‑speech, and executes any actions the model chooses — all in a live loop with barge‑in.

**Getting started.** Create an agent in the console, choose your providers (self‑hosted for in‑boundary, or a cloud provider), define its greeting and tools, and attach it to a number or flow.

**For developers.** Pluggable STT/LLM/TTS providers behind one interface; the LLM sees an OpenAI‑style tool schema mapping to real call actions; media arrives over the mod_audio_stream WebSocket; guardrails include an env‑name allow‑list for keys, SSRF‑guarded tool HTTP, and a fraud gate on transfers. `runtime‑config` reports whether the agent is fully in‑boundary. Managed under `/v1/ai-agents`.

---

## Toll‑Free & Wholesale

**In plain English.** This is the heavy‑duty side of the platform: 8XX toll‑free numbers, managing thousands of numbers at once, and automatically sending each call over the cheapest quality route.

**Who it's for.** High‑volume and wholesale buyers — anyone managing a large inventory of numbers or reselling voice.

**What you get.**
- **Toll‑free / RespOrg** — provision and control 8XX numbers, manage their routing records, and steer them across carriers.
- **Bulk operations** — import and reassign numbers by the thousands in one action.
- **Least‑Cost Outbound (LCO)** — every outbound call is routed over the cheapest carrier that meets your quality bar, with a **transparent savings report** showing exactly what you saved versus a baseline.
- **CNAM and porting** workflows for large inventories.

**How it works.** You manage a toll‑free inventory and a per‑carrier rate deck. When a call goes out, the routing engine longest‑prefix‑matches the destination against the rate deck and picks the cheapest‑first carrier ordering, honoring any per‑customer carrier preferences — then reports the savings.

**Getting started.** Wholesale onboarding is admin‑assisted: load your numbers and rate decks, set carrier preferences, and route.

**For developers / admins.** `toll_free_numbers` + batch import; `carrier_rate_decks` + a `lco_route` view/`lco_decide()` that FreeSWITCH reads on the call path; per‑customer allow/deny policy; savings computed over rated CDRs. Managed under `/v1/toll-free` and `/v1/lco`.

---

## Billing & Payments

**In plain English.** Shale is pay‑as‑you‑go on a prepaid balance. You add funds, calls draw down the balance, and — if you turn it on — your card is charged automatically to top up when the balance runs low, so service never stops. You can pay by card, and (for automated/machine use) even settle per request. Everything is transparent: every charge is a line item you can see.

**Who it's for.** Every customer — this is how you pay for whatever products you use.

**What you get.**
- **Prepaid balance with a full ledger** — every top‑up and every usage charge is an immutable line item you can audit.
- **Auto‑recharge** — set a threshold and an amount; when your balance drops below the threshold, your saved card is charged to top it back up. If a charge fails, we handle the retry/notify flow (dunning) gracefully.
- **Usage billing** — per‑minute and per‑request usage is metered and reflected in your balance in real time.
- **Machine payments** — automated clients and AI agents can pay per request using modern rails (stablecoin over the x402 protocol, or Stripe's Machine Payments Protocol), so an agent can literally pay for itself as it works.
- **Invoices** for recurring plan fees, and a revenue view for admins.

**How it works.** Your card is stored safely with our payment processor — Shale never sees or stores your card number (see Security below). Your real‑time balance is the source of truth for whether calls are allowed; the payment rails simply top it up. Auto‑recharge watches your balance and charges your card off‑session when it crosses your threshold.

**Getting started.** Add a payment method, set your auto‑recharge threshold and amount, and you're done — the balance keeps itself full.

**For developers / compliance.** An append‑only, idempotent ledger is the authority; `customers.balance` is a cache updated only alongside a ledger entry. Payment rails are pluggable providers (Stripe card + auto‑recharge, x402/USDC, Stripe MPP) behind one interface. The design is built to stay inside three compliance lines (see Security): PCI **SAQ‑A** (card data only in the processor's iframe), **closed‑loop prepaid** (balance is only spendable on Shale services), and **non‑custodial crypto** (we never hold customer crypto). Managed under `/v1/billing` and `/v1/payments`.

---

## Platform: quality, tooling, and trust

Beyond the products, every Shale account rides on the same platform:

- **Call Quality analytics** — MOS, jitter, packet loss, and R‑factor per call, with trends and a call‑detail drill‑down, so you can prove and troubleshoot audio quality.
- **Troubleshooting (SIP ladder)** — a native, per‑call signaling ladder with packet inspection and cross‑leg correlation — self‑service call tracing that's more detailed than what most carriers expose to customers.
- **Call Flow Builder** — a visual, drag‑and‑drop editor to design call handling (menus, schedules, routing) for any product, with simulate and version history.

### Security & compliance (why you can trust it)

- **STIR/SHAKEN** call authentication (as the carrier of record) to fight spoofing and keep your calls trusted.
- **E911** with dispatchable location and Kari's Law notification for outbound‑capable products — a life‑safety requirement we treat as a launch gate.
- **Encryption at rest** for voicemail, recordings, and chat using envelope encryption with a customer‑verifiable crypto‑erase.
- **Strict tenant isolation** — your data is scoped to your account on every endpoint, with a durable admin audit trail.
- **Fraud controls** — international/premium destination gating, per‑customer concurrency and rate caps.
- **Payments compliance** — PCI SAQ‑A boundary (we never touch card numbers), closed‑loop prepaid balances, and non‑custodial crypto.

> Compliance items that require external provisioning or legal sign‑off (e.g., STIR/SHAKEN certificate issuance, per‑line E911 location, and holding funds) are treated as explicit gates before the relevant feature goes live.

---

*This document reflects the current state of the Shale platform. It is the source of truth for the in‑app Docs pages at `/docs`.*
