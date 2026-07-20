# Monetary System Design — revup VoIP Platform

**Date:** 2026-07-20
**Status:** Wave 1 (ledger foundation) BUILT + verified. Live rails (Stripe/x402/MPP) BLOCKED — external accounts not yet approved. **Now building a production-shaped DEMO** (§9) so execs can see every flow end-to-end without live accounts. Swap demo→real provider behind the Wave-1 `PaymentProvider` interface when accounts land.
**Grounding:** two deep-research passes (Coinbase x402; Stripe usage-billing) + two direct-source syntheses (Stripe agentic/MPP/stablecoin; US compliance). Citations live in those reports; key facts summarized here.

> **This is not legal advice.** The compliance gates below are synthesized from primary regulator sources (PCI SSC, FinCEN, Federal Register, NYDFS) but MUST be confirmed with qualified payments/fintech counsel before we hold customer funds, take custody of any stablecoin, or self-host a facilitator. Every serious regulatory exposure in this design comes from crossing one of three lines (§1).

---

## 0. First principle

**Our real-time internal ledger stays the source of truth for call authorization. Every payment processor (Stripe, x402, MPP) is a pluggable RAIL that tops up or settles against that ledger — never the authority.**

This is forced by the research: Stripe Meters are asynchronous, eventually-consistent, and monthly-invoice-shaped — they are a *billing/reporting* layer, not a real-time balance. Our per-minute call rating needs a hard, real-time balance. So we keep the ledger and treat processors as rails. (Corollary: this also keeps Stripe/facilitators as the licensed/custodial parties, which is what keeps *us* out of money-transmitter status — see §1.)

---

## 1. Compliance boundary — the three lines we must never cross (shape everything)

These are DESIGN GATES, cited to regulators in the compliance research. Each crossing triggers heavy licensing/AML burden.

1. **PCI SAQ-A gate.** Card data is collected ONLY inside a Stripe-hosted iframe (Payment Element / Checkout). Our servers store ONLY Stripe tokens (`pm_…`/`cus_…`) — never a PAN/CVV, not in transit, logs, DB, or analytics. We implement PCI DSS v4.0 client-side script-integrity + change-detection (Req 6.4.3 / 11.6.1) on the page that hosts the iframe. **MUST NOT** self-host or self-assemble a card form (that forfeits SAQ-A → SAQ-A-EP, a much larger scope).
2. **Closed-loop prepaid gate.** The prepaid balance is redeemable ONLY for our own telecom services; it is **never** cashable-out, refundable-to-cash, or transferable to another user/merchant. We keep per-account daily associable value **≤ $2,000** (configurable cap) to sit inside the FinCEN closed-loop prepaid-access exclusion (phone cards are FinCEN's named example). This keeps us out of "provider/seller of prepaid access" MSB status. Above $2k or any cash-out → we risk becoming a regulated money transmitter / open-loop prepaid-access provider.
3. **Non-custodial crypto gate.** Any USDC/x402/MPP-stablecoin flow is strictly non-custodial: funds move payer→payee directly; the facilitator only broadcasts a signed authorization and never holds funds. We **never** pool, sweep-through, or take even momentary custody of customer crypto, and we **use a hosted facilitator (Coinbase CDP), NOT a self-hosted one** — a self-hosted/custodial facilitator "almost certainly" becomes money transmission (a CVC processor generally cannot use the payment-processor exemption) → FinCEN MSB + state MTLs + NY BitLicense + full AML program. We OFAC-screen counterparties/addresses (strict liability) and accept only GENIUS-compliant issuer stablecoin (e.g., Circle USDC). The 2026 stablecoin AML rule + GENIUS Act target *issuers*, not merchants/non-custodial facilitators — no direct duty on us while non-custodial.

**Counsel gate (process, not code):** before any live fund/crypto holding or facilitator self-hosting → payments/fintech counsel sign-off + a 50-state money-transmission / stored-value / unclaimed-property (escheat) review + PCI SAQ-A attestation.

---

## 2. Ledger core (Layer 1) — append-only, idempotent [buildable now; no external deps]

Today `customers.balance DECIMAL` is a single mutable column that `rate_cdr()` decrements in place, with money-in only via admin `add_credit`. Replace with:

- **`ledger_entries`** (append-only, never UPDATE/DELETE): `id`, `customer_id`, `amount_minor BIGINT` (signed integer minor units — never floats), `currency`, `entry_type` (`topup|usage|fee|refund|adjustment|promo|chargeback`), `source` (`stripe_card|stripe_crypto|stripe_mpp|x402|admin|rating`), `idempotency_key` UNIQUE, `external_ref` (pi_…/spt_…/tx hash), `balance_after_minor`, `metadata JSONB`, `created_at`.
- **`customers.balance`** becomes a cache: updated ONLY inside the same DB transaction that inserts a ledger entry (one service function `post_ledger_entry()` + a guard so nothing writes balance directly). `rate_cdr()` is rewritten to call it with a `usage` entry instead of `balance = balance - cost`.
- **`payment_methods`**: `customer_id`, `provider`, `provider_pm_id` (`pm_…`), `provider_customer_id` (`cus_…`), `brand`, `last4`, `exp_month/year`, `is_default`, `status`. NO PAN/CVV ever.
- **`payment_transactions`** (provider-agnostic): `id`, `customer_id`, `provider`, `provider_ref`, `kind` (`topup|charge|refund|dispute`), `amount_minor`, `currency`, `status` (`pending|succeeded|failed|refunded|disputed`), `idempotency_key` UNIQUE, `raw_event JSONB`, `created_at`. On `succeeded` → posts a `ledger_entries` row (same txn).
- **`auto_recharge_settings`**: `customer_id`, `enabled`, `threshold_minor`, `recharge_amount_minor`, `payment_method_id`, `currency`, `daily_cap_minor` (≤ closed-loop cap), `cooldown_seconds`, `consecutive_failures`, `last_triggered_at`, `disabled_reason`.
- **`invoices`** (postpaid `credit_limit` customers + monthly plan fees): standard fields + `provider_invoice_id`.

Rules: all money in integer minor units; every mutation carries an idempotency key (closes the P1 "no idempotency keys" gap); balance is derivable by summing entries (reconciliation invariant: `SUM(amount_minor) == balance cache`); admin adjustments audited into the existing `admin_audit_log`.

---

## 3. Provider abstraction (Layer 2) — pluggable rails [buildable now]

Mirror the STT/LLM/TTS + KMS provider pattern already in the codebase.

- `PaymentProvider` interface: `create_setup()` (card-on-file), `charge(amount, idempotency_key)` (topup), `refund()`, `verify_and_parse_webhook(headers, body) -> NormalizedEvent`.
- Concrete: `StripeProvider` (Rail A/C), `X402Provider` + `StripeMppProvider` (Rail B).
- **Webhook ingress** (one hardened endpoint): verify signature (Stripe: `Stripe-Signature` `t=,v1=` HMAC-SHA256 + timestamp tolerance, ignore `v0`), dedupe by provider event id (idempotent), normalize → `payment_transactions` → ledger. Always 200 after enqueue (no retry storms); process async.

---

## 4. The rails (Layer 3)

### Rail A — Human card + auto-recharge (Stripe) — the load-bearing rail
- **Card on file:** SetupIntent (`customer`, `automatic_payment_methods.enabled=true`) → Payment Element (Stripe iframe = SAQ-A) → save `pm_…` to Customer.
- **Auto-recharge (Twilio model — WE build the trigger; Stripe has none):** our ledger service detects `balance < threshold` (off the call path) → off-session PaymentIntent (`off_session=true`, `confirm=true`, `customer`, `payment_method`, idempotency key) → on `payment_intent.succeeded` webhook → `topup` ledger entry. **Failure handling:** off-session decline returns 402 / `requires_payment_method` → dunning: `authentication_required` → email customer to authenticate (on-session `confirmPayment`); other declines (insufficient funds) → prompt new card; exponential backoff + cooldown + disable after N consecutive failures.
- **Monthly plan fees:** Stripe subscription for the `cps_tiers.monthly_fee` plans.
- **Usage mirror:** emit per-minute usage to Stripe Meters (`/v1/billing/meter_events`, `formula=sum`; v2 `meter_event_stream` if volume demands) for invoicing/analytics — but OUR ledger stays authoritative (Stripe is async). Optionally model prepaid via Stripe Billing Credit Grants (append-only) — but note the hard constraint: credits apply ONLY to metered subscription prices, never one-offs, so our internal ledger remains primary.
- **Webhooks consumed:** `payment_intent.succeeded`, `payment_intent.payment_failed`, `invoice.paid`, `invoice.payment_failed`, `charge.dispute.created`, `charge.refunded`.
- **Tax:** Stripe Tax for standard sales tax; **OPEN ITEM** — telecom-specific taxes/surcharges (USF, E911, state telecom) are specialized and Stripe Tax may not cover them; likely a dedicated telecom-tax engine (flag for a later wave / vendor).

### Rail B — Machine/agent payments (Stripe MPP + x402) — the frontier rail
- **Stripe MPP** (the real "Stripe MPP" — Machine Payments Protocol, GA): our programmable-voice API + AI voice-agent runtime respond `HTTP 402` → the customer's agent opens a spend-limited session ("tab") → streams micro-charges as minutes/requests are consumed → batch settle. Payment-method-agnostic: stablecoin on Tempo OR the customer's card via **Shared Payment Tokens (SPT)**. Accept via the PaymentIntents API; appears as normal Stripe payments. Best fit for "a customer's autonomous agent pays per-request."
- **x402** (crypto-native, USDC-on-Base): official Python SDK `x402[fastapi]` `PaymentMiddlewareASGI` on metered endpoints; **hosted Coinbase CDP facilitator** (`/v2/x402/verify` + `/settle`) — NOT self-hosted (compliance gate); EIP-3009 gasless, payer→payee direct, USDC 6-decimal minor units. Note: x402 **v2 headers** are `PAYMENT-SIGNATURE`/`PAYMENT-REQUIRED`/`PAYMENT-RESPONSE` (the `X-PAYMENT` names are legacy v1). Stripe also has a first-party x402 product (beta, USDC-on-Base, **excluded in New York**) that keeps PaymentIntents as the settlement layer but still needs an external facilitator.
- **"humanOrPay" gate:** metered API / agent endpoints accept EITHER an authenticated tenant session (drawn from the ledger) OR an x402/MPP payment. Both feed the same ledger.
- **Compliance:** non-custodial only; CDP hosted facilitator; OFAC screening; GENIUS-compliant stablecoin.

### Rail C — Stablecoin top-up (Stripe "pay with crypto") — optional, large B2B prepay
- USDC top-up via Stripe's stablecoin acceptance (`payment_method_types:['card','crypto']`): 1.5% fee, no chargebacks, settles USD to our Stripe balance → `topup` ledger entry. Stripe/Bridge custodies the crypto, so WE stay non-custodial (Stripe is the licensed party). GA in the US; $10k/tx cap; refunds return as stablecoin to the origin wallet.

---

## 5. Telephony integration (Layer 4) [telephony expert]
- Pre-call/pre-origination balance + credit_limit check against the real-time ledger (reject or route-to-top-up when insufficient) — enhance what exists in the Lua/Kamailio path.
- Auto-recharge fires from the ledger service (async, OFF the call path) so a top-up never blocks call setup.

## 6. UI (Layer 5) [frontend expert]
- **Customer:** payment methods (Payment Element), balance + ledger history, auto-recharge settings, invoices, add-funds (card / crypto). **Admin:** balances (audited adjustments), transactions, disputes, reconciliation dashboard.

---

## 7. Build decomposition → expert-agent work packages (waves)

**Wave 1 — Ledger foundation** [NOW; no external deps; no money movement; fully verifiable]
- `python-backend-architect`: ledger schema + migration; `post_ledger_entry()` service (idempotent, balance-as-cache, reconciliation invariant); rewrite `rate_cdr()` → `usage` entry; `PaymentProvider` abstract interface + no-op provider; provider-agnostic `payment_transactions`/`payment_methods`/`auto_recharge_settings`/`invoices` tables; tests (idempotency, balance invariant, tenant isolation).

**Wave 2 — Stripe card rail + auto-recharge** [needs Stripe account + keys; PCI SAQ-A gate]
- `python-backend-architect`: `StripeProvider` (SetupIntent, off-session PaymentIntent, refund), hardened webhook ingress (signature verify + idempotent → ledger), auto-recharge trigger service (threshold/backoff/cooldown/dunning), subscriptions + meter mirror.
- `frontend-fullstack-expert`: Payment Element onboarding (SAQ-A iframe), balance/history, auto-recharge settings, invoices UI; v4.0 script-integrity.
- `general-purpose` (infra): PCI boundary (CSP + script-integrity monitoring), Stripe keys → Secret Manager, webhook endpoint exposure + verification.

**Wave 3 — Machine rails (x402 + Stripe MPP)** [needs Coinbase CDP account + wallet; non-custodial gate; counsel]
- `evm-solidity-expert` (+ `typescript-backend-architect` if needed): x402 FastAPI middleware + CDP hosted facilitator verify/settle (EIP-3009, USDC-on-Base), OFAC screening; Stripe MPP session handling + SPT redemption.
- `python-backend-architect`: wire x402/MPP into the programmable-voice API + AI agent runtime (402 responses, session→ledger); "humanOrPay" gate.
- `telephony-systems-expert`: gate call origination / API usage on real-time balance.

**Wave 4 — Compliance hardening + reconciliation + telecom tax**
- `general-purpose`/infra: reconciliation jobs (Stripe balance ↔ ledger; on-chain settle ↔ ledger), dispute/chargeback handling, closed-loop cap enforcement (≤ $2k/day), OFAC screening, audit surfacing, telecom-tax engine evaluation (USF/E911).
- **Legal (process, not code):** MTL/stored-value/escheat review + PCI SAQ-A attestation + counsel sign-off BEFORE Rail B/C go live.

**Verification (me):** after each wave — tests, tenant isolation, idempotency, the ledger reconciliation invariant, and adherence to the three compliance gates.

---

## 8. Hard external dependencies / open items (gate the money-touching waves)
- Stripe account + API keys + Stripe Tax config (Wave 2).
- Coinbase CDP account + a receiving wallet + mainnet facilitator access (Wave 3).
- Counsel sign-off + state MTL/stored-value review + PCI attestation (before Rail B/C live).
- Telecom tax (USF/E911) engine decision — Stripe Tax likely insufficient.
- Reconfirm at build time: x402/CDP facilitator pricing; Stripe SPT/MPP still on preview API version; Stripe-x402 NY exclusion.

---

## 9. DEMO MODE (built 2026-07-20 — accounts not yet approved)

Goal: a convincing, production-shaped, exec-facing demo of the whole monetary system that runs with **no live Stripe/Coinbase accounts and moves no real money**, by driving the real ledger + real rail logic through **simulation providers** behind the Wave-1 `PaymentProvider` interface. When real keys arrive, swap the provider — the ledger, auto-recharge, webhook, and 402 machine-payment logic are unchanged.

**Gating:** `PAYMENTS_DEMO_MODE=true` (env; default false). When on, the provider factory returns `DemoStripeProvider`/`DemoX402Provider`/`DemoMppProvider` (mint realistic fake `pm_…`/`pi_…`/tx-hash ids, realistic latency, configurable success/decline) instead of `NoopProvider`/live. Every demo action posts REAL `ledger_entries`/`payment_transactions`. Demo endpoints are clearly namespaced and admin-gated; nothing demo touches production carrier/call flow.

**What it demonstrates (the exec story):**
1. **Prepaid ledger, live:** balance + transaction history that decrements as (simulated) calls consume minutes.
2. **Human card auto-recharge (Stripe rail):** add a demo card (simulated Payment Element) → watch balance cross the threshold → off-session charge fires → balance tops up → txn appears. Plus a **decline → dunning** path.
3. **Machine payments (x402):** an AI agent / API client hits a metered demo endpoint → gets `402` with `PAYMENT-REQUIRED` → retries with a (demo) `PAYMENT-SIGNATURE` → 200 + a USDC micro-charge settles to the ledger.
4. **Stripe MPP agent "tab":** open a spend-limited session → stream batched micro-charges → settle. The wow: "our AI voice agents pay for themselves per-request."
5. **USDC top-up (Stripe stablecoin):** a large B2B top-up, simulated.
6. **Invoices + usage billing:** monthly plan fee + metered usage summary.
7. **Exec demo control panel:** buttons to trigger each scenario live (seed / call-drain / agent-usage / decline / reset).
8. **Revenue + compliance dashboard:** revenue by rail, and a panel showing the three compliance gates (SAQ-A / closed-loop ≤$2k/day / non-custodial) as GREEN — the "we designed this compliant" narrative.

**Demo API contract** (both backend + frontend build to this; all tenant/admin-scoped, `PAYMENTS_DEMO_MODE`-gated where noted):
- Payment methods: `POST /v1/payments/setup-intent`, `POST/GET/DELETE /v1/payments/methods[/{id}]`, `POST /v1/payments/topup`.
- Auto-recharge: `GET/PUT /v1/payments/auto-recharge`.
- Machine: `GET /v1/payments/demo/metered` (returns 402 then 200-on-payment), `POST /v1/payments/mpp/sessions`, `POST /v1/payments/mpp/sessions/{id}/charge`.
- Invoices/usage: `GET /v1/payments/invoices`, `GET /v1/payments/usage`.
- Exec/demo control (admin): `POST /v1/payments/demo/{seed|simulate/call-drain|simulate/agent-usage|simulate/decline|reset}`, `GET /v1/payments/demo/state`.
- Dashboards: `GET /v1/payments/summary` (revenue by rail), `GET /v1/payments/compliance` (three-gate status).

**Swap-to-production path:** flip `PAYMENTS_DEMO_MODE=false` + provide Stripe/CDP keys → the factory returns the real providers → same endpoints, same ledger, real money. Demo endpoints stay dormant (admin+demo-gated).

