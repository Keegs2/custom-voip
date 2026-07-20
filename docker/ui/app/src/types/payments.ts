/**
 * Payments / monetary-system types — the frontend contract for the exec DEMO
 * (see docs/PAYMENTS_SYSTEM_DESIGN.md §9). These map to the `/v1/billing/*` and
 * `/v1/payments/*` endpoints served by the demo backend (simulation providers
 * behind the Wave-1 `PaymentProvider` interface + the real append-only ledger).
 *
 * MONEY REPRESENTATION (the REAL backend contract)
 * ------------------------------------------------
 * The ledger is authoritative and stores DECIMAL(12,4) DOLLARS. Every money field
 * on the wire is a decimal dollar value — `amount`, `balance`, `threshold`,
 * `recharge_amount`, `daily_cap`, `total_charged`, `spend_limit`, `revenue`,
 * `charged`, `unit_price`, `total_usage`, `balance_after`, … — NOT integer minor
 * units, and WITHOUT a `_minor` suffix. There is exactly one true integer minor
 * field: the on-chain USDC `amount_minor` (6-dp) on an x402 settlement/challenge,
 * which is kept as a distinct field.
 *
 * These interfaces are split in two layers:
 *   • The API adapter (`src/api/payments.ts`) owns the raw wire → view mapping and
 *     parses every money string to a full-precision dollar `number` via
 *     `parseMoney` (see `components/payments/format.ts`) — NEVER rounding to cents.
 *   • The VIEW types below (what components consume) therefore carry plain dollar
 *     `number`s with clean names. Components do their own Intl formatting at the
 *     edge; sub-cent micro-charges keep 4dp.
 */

/** The three settlement rails the demo tells a story about (UI palette buckets). */
export type PaymentRail = 'card' | 'stablecoin' | 'machine';

/**
 * Backend ledger `source` / revenue-rail / usage-source string (the pluggable
 * rail origin). Carried verbatim from the API so labels/keys stay stable; mapped
 * to a `PaymentRail` bucket for the palette.
 */
export type PaymentSource =
  | 'stripe_card'
  | 'stripe_crypto'
  | 'stripe_mpp'
  | 'x402'
  | 'admin'
  | 'rating';

/** Ledger entry classes (append-only; never mutated). */
export type LedgerEntryType =
  | 'topup'
  | 'usage'
  | 'fee'
  | 'refund'
  | 'adjustment'
  | 'promo'
  | 'chargeback';

export type PaymentTransactionKind = 'topup' | 'charge' | 'refund' | 'dispute';

export type PaymentTransactionStatus =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'refunded'
  | 'disputed';

// ── Wave-1 ledger (GET /v1/billing/balance, /v1/billing/ledger) ──────────────

/**
 * The real-time authoritative balance.
 * Wire: `{ customer_id, balance: "…", currency }`.
 */
export interface BillingBalance {
  customer_id: number;
  /** Dollars (parsed from the decimal string) — source of truth for call auth. */
  balance: number;
  currency: string;
}

/**
 * One append-only ledger row (money in/out + running balance).
 * Wire: `{ id, amount:"…", currency, entry_type, source, balance_after:"…",
 *          external_ref?, metadata?, created_at }` (customer_id present on the
 * billing ledger read; absent from demo-state transactions).
 */
export interface LedgerEntry {
  id: number | string;
  customer_id?: number;
  /** Dollars, signed — positive = credit, negative = debit. */
  amount: number;
  currency: string;
  entry_type: LedgerEntryType;
  source: PaymentSource;
  /** Running balance (dollars) after this entry. */
  balance_after: number;
  /** Provider reference: pi_… / tx hash / etc. */
  external_ref?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at: string;
}

// ── Payment methods (POST /setup-intent, POST/GET/DELETE /methods) ───────────

/**
 * Response from `POST /v1/payments/setup-intent`. Carries the `client_secret` a
 * real Payment Element mounts against (PCI SAQ-A — card never touches us) PLUS
 * the pm/brand/last4 the demo mints so a method can be persisted in one call.
 * Wire: `{ provider, client_secret, provider_customer_id, payment_method, brand,
 *          last4, exp_month, exp_year }`.
 */
export interface SetupIntent {
  provider: string;
  client_secret: string | null;
  provider_customer_id: string | null;
  /** The minted `pm_…` token (backend field: `payment_method`). */
  payment_method: string | null;
  brand: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
}

/** A saved card-on-file. Stores ONLY provider tokens — never a PAN/CVV. */
export interface PaymentMethod {
  id: number | string;
  provider: string;
  /** Stripe payment-method token, e.g. `pm_…`. Never a card number. */
  provider_pm_id: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  is_default: boolean;
  status: string;
  created_at?: string;
}

/**
 * Body for `POST /v1/payments/methods`. The (simulated) Payment Element confirms
 * a SetupIntent and the client posts back the resulting token + display metadata;
 * omitting the token lets the provider mint a card in one call (demo). No PAN/CVV
 * ever leaves the iframe boundary (SAQ-A).
 */
export interface CreatePaymentMethodRequest {
  provider_pm_id?: string;
  provider_customer_id?: string | null;
  brand?: string;
  last4?: string;
  exp_month?: number;
  exp_year?: number;
  make_default?: boolean;
  client_secret?: string | null;
}

// ── Top-up (POST /topup) ─────────────────────────────────────────────────────

/**
 * Body for `POST /v1/payments/topup`.
 * Wire body: `{ amount: <float dollars>, rail: "card" | "usdc" }`.
 */
export interface TopupRequest {
  /** Dollars (a plain number the backend coerces to Decimal). */
  amount: number;
  /** Which rail settles the top-up. Backend accepts only `card` | `usdc`. */
  rail: 'card' | 'usdc';
}

/**
 * Result of a top-up.
 * Wire: `{ status, amount:"…", currency, rail, provider_ref, ledger_entry_id,
 *          balance:"…" }`.
 */
export interface TopupResult {
  status: string;
  /** Dollars added. */
  amount: number;
  currency: string;
  rail: string;
  provider_ref: string | null;
  ledger_entry_id: number | null;
  /** New balance (dollars) after the top-up posted. */
  balance: number;
}

// ── Auto-recharge (GET/PUT /auto-recharge) ───────────────────────────────────

export interface AutoRechargeSettings {
  customer_id: number;
  enabled: boolean;
  /** Fire an off-session charge when balance drops below this (dollars). null when unset. */
  threshold: number | null;
  /** How much to add each time (dollars). null when unset. */
  recharge_amount: number | null;
  /** Which saved card funds the recharge. */
  payment_method_id: number | null;
  currency: string;
  /** Closed-loop cap: max auto-recharged value per day (dollars, ≤ $2k). null when unset. */
  daily_cap: number | null;
  cooldown_seconds: number;
  consecutive_failures: number;
  last_triggered_at?: string | null;
  /** Human-readable dunning reason; set on decline / disable. */
  disabled_reason?: string | null;
}

/**
 * Body for `PUT /v1/payments/auto-recharge`. All fields optional (patch-like);
 * money fields are plain-number dollars matching the backend names.
 */
export interface AutoRechargeUpdate {
  enabled?: boolean;
  threshold?: number;
  recharge_amount?: number;
  payment_method_id?: number | null;
  daily_cap?: number;
  cooldown_seconds?: number;
}

// ── Machine payments: x402 (GET /demo/metered) ───────────────────────────────

/**
 * The x402 402-challenge → pay → settle loop, surfaced for VISUALIZATION. The
 * `/demo/metered` endpoint returns a 402 with an `accepts: [challenge]` envelope,
 * then 200 with a `settlement` once a (demo) PAYMENT-SIGNATURE is presented.
 *
 * One `accepts[]` entry. `amount_minor` is the TRUE integer USDC 6-dp minor unit;
 * `amount` is the decimal dollar value (parsed to a dollar number here).
 */
export interface X402Challenge {
  scheme: string;
  network: string;
  asset: string;
  /** On-chain USDC minor units (6-dp integer) — NOT dollars. */
  amount_minor: number;
  /** Price in dollars (parsed from the decimal string). */
  amount: number;
  pay_to: string;
  resource: string;
  nonce: string;
}

/**
 * Settlement from the paid retry.
 * Wire (200): `settlement: { tx_hash, network, asset, amount_minor, payer }`,
 * with `charged:"…"` (dollars) and `currency:"USDC"` alongside it.
 */
export interface X402Settlement {
  tx_hash: string;
  network: string;
  asset: string;
  /** On-chain USDC minor units (6-dp integer). */
  amount_minor: number;
  payer: string;
  /** Amount charged in dollars (from the response `charged`). */
  charged: number;
  currency: string;
}

/**
 * The demo metered endpoint returns EITHER a 402 challenge (unpaid) OR a 200
 * with the resource + settlement (paid). The API client models the 402 as a typed
 * value rather than a throw so the UI can animate the handshake.
 */
export interface MeteredResponse {
  paid: boolean;
  challenge?: X402Challenge;
  settlement?: X402Settlement;
  /** The unlocked resource payload once paid (demo — an opaque JSON blob). */
  resource?: Record<string, unknown>;
}

// ── Machine payments: Stripe MPP agent "tab" (POST /mpp/sessions[/charge]) ────

export type MppSessionStatus = 'open' | 'settled' | 'closed';

/**
 * A spend-limited agent session ("tab") that streams micro-charges.
 * Wire: `{ id, provider, provider_session_id, spend_limit:"…", total_charged:"…",
 *          charge_count, currency, status, label, created_at }` plus
 * `settlement_ref`/`settled_at` on the demo-state read.
 */
export interface MppSession {
  id: number | string;
  provider: string;
  provider_session_id: string;
  /** Hard ceiling the agent may spend before settle (dollars). */
  spend_limit: number;
  /** Running total charged so far (dollars). */
  total_charged: number;
  charge_count: number;
  currency: string;
  status: MppSessionStatus;
  label: string | null;
  created_at: string;
  /** Settlement ref once the tab settles (demo-state read only). */
  settlement_ref?: string | null;
  settled_at?: string | null;
}

/** Body for `POST /v1/payments/mpp/sessions`. */
export interface MppSessionCreateRequest {
  /** Dollars. */
  spend_limit: number;
  label?: string;
}

/** Body for `POST /v1/payments/mpp/sessions/{id}/charge` — an explicit amount per tick. */
export interface MppChargeRequest {
  /** Dollars charged this tick (backend REQUIRES an explicit amount). */
  amount: number;
  /** When true, settle the tab after adding this charge. */
  settle?: boolean;
}

/**
 * Result of streaming one micro-charge onto the tab.
 * Wire: `{ session_id, accepted, amount:"…", total_charged:"…", remaining:"…",
 *          charge_count, status, settled, settlement:{…}|null, reason }`.
 */
export interface MppChargeResult {
  session_id: number | string;
  accepted: boolean;
  /** Dollars charged this tick. */
  amount: number;
  /** Running total (dollars) after this charge. */
  total_charged: number;
  /** Remaining budget (dollars). */
  remaining: number;
  charge_count: number;
  status: MppSessionStatus;
  settled: boolean;
  settlement: MppSettlement | null;
  reason: string | null;
}

/** MPP settlement summary (dollars parsed). */
export interface MppSettlement {
  provider_ref: string;
  amount: number;
  ledger_entry_id: number | null;
  balance: number | null;
}

// ── Invoices + usage (GET /invoices, /usage) ─────────────────────────────────

export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'past_due' | 'void';

/**
 * One invoice.
 * Wire: `{ id, provider_invoice_id, amount:"…", currency, status, period_start,
 *          period_end, created_at }`.
 */
export interface Invoice {
  id: number | string;
  provider_invoice_id: string | null;
  /** Total due (dollars). */
  amount: number;
  currency: string;
  status: InvoiceStatus;
  period_start: string;
  period_end: string;
  created_at?: string | null;
}

/** One usage-by-source row (dollars). */
export interface UsageBySource {
  source: PaymentSource;
  label: string;
  /** Usage spend on this source (dollars). */
  usage: number;
  count: number;
}

/**
 * Metered-usage summary by rail (money OUT).
 * Wire: `{ customer_id, currency, total_usage:"…", by_source:[{source, label,
 *          usage:"…", count}], entry_count }`.
 */
export interface UsageSummary {
  customer_id: number;
  currency: string;
  /** Total metered spend (dollars). */
  total_usage: number;
  by_source: UsageBySource[];
  entry_count: number;
}

// ── Dashboards (GET /summary, /compliance) ───────────────────────────────────

/**
 * Revenue rolled up by settlement rail (§9.8 dashboard).
 * Wire item: `{ rail, label, revenue:"…", count }` (rail == a backend source key).
 */
export interface RevenueByRail {
  /** Backend source key (e.g. `stripe_card`). */
  rail: PaymentSource;
  label: string;
  /** Gross revenue on this rail (dollars). */
  revenue: number;
  count: number;
}

/** Revenue block shared by `/summary` and `/demo/state`. */
export interface RevenueSummary {
  /** Total gross across all rails (dollars). */
  total_revenue: number;
  by_rail: RevenueByRail[];
}

/**
 * The exec revenue + usage summary.
 * Wire: `{ scope, customer_id, revenue:{total_revenue:"…", by_rail:[…]},
 *          usage:{total_usage:"…"}, reconciled }`.
 */
export interface PaymentsSummary {
  scope: string;
  customer_id: number | null;
  revenue: RevenueSummary;
  usage: { total_usage: number };
  reconciled: boolean;
}

/** One of the three compliance GATES (§1). */
export type ComplianceGateId = 'pci_saq_a' | 'closed_loop_prepaid' | 'non_custodial_crypto';

/** Backend gate status. */
export type ComplianceGateStatus = 'green' | 'red';

/**
 * One compliance gate.
 * Wire: `{ id, name, status:"green"|"red", detail, evidence }`.
 */
export interface ComplianceGate {
  id: ComplianceGateId;
  name: string;
  status: ComplianceGateStatus;
  detail: string;
  evidence?: Record<string, unknown> | null;
}

/** Wire: `{ gates:[…], all_green }`. */
export interface ComplianceStatus {
  gates: ComplianceGate[];
  all_green: boolean;
}

// ── Demo control (admin — POST /demo/*, GET /demo/state) ─────────────────────

export type DemoScenario =
  | 'seed'
  | 'call-drain'
  | 'agent-usage'
  | 'decline'
  | 'reset';

/** The demo customer sub-object on `/demo/state`. */
export interface DemoCustomer {
  id: number;
  name: string;
  account_type: string;
  /** Cached balance (dollars). */
  balance: number;
  credit_limit: number;
  is_demo: boolean;
}

/** One demo-activity trail row. */
export interface DemoActivity {
  scenario: string;
  detail?: Record<string, unknown> | null;
  created_at: string;
}

/**
 * Snapshot of the demo world (GET /v1/payments/demo/state) for the presenter.
 * Wire: `{ seeded, customer:{…}, balance:"…", transactions:[…], mpp_sessions:[…],
 *          auto_recharge:{…}, payment_methods:[…], invoices:[…],
 *          revenue:{…}, activity:[…] }` — or `{ seeded:false }`.
 */
export interface DemoState {
  seeded: boolean;
  customer?: DemoCustomer | null;
  /** Current balance (dollars). */
  balance?: number;
  transactions?: LedgerEntry[];
  mpp_sessions?: MppSession[];
  auto_recharge?: AutoRechargeSettings | null;
  payment_methods?: PaymentMethod[];
  invoices?: Invoice[];
  revenue?: RevenueSummary;
  activity?: DemoActivity[];
}
