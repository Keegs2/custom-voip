/**
 * Machine Payments Demo — local endpoint payload types.
 *
 * These map 1:1 to the RCF-V1 payments router (`docker/api/src/routers/
 * payments.py`, mounted at `/v1/payments`) and the billing reads
 * (`routers/billing.py`). Shapes were verified against the live demo API:
 * FastAPI's encoder converts every DECIMAL money column to a plain JSON
 * number before orjson serializes it, so money fields here are `number`
 * dollars (4-dp precision survives; the only true integer minor unit is the
 * on-chain USDC `amount_minor`).
 *
 * The demo-state read (`GET /demo/state`) returns TRIMMED row shapes (e.g.
 * its `mpp_sessions` rows omit `provider`/`currency`, its `auto_recharge`
 * omits `customer_id`/`payment_method_id`) — those differences are modeled
 * as separate interfaces rather than optionals on the full shapes.
 */

// ── Shared unions ────────────────────────────────────────────────────────────

/** Ledger `source` — the settlement rail a money event originated on. */
export type PaymentSource =
  | 'stripe_card'
  | 'stripe_crypto'
  | 'stripe_mpp'
  | 'x402'
  | 'admin'
  | 'rating';

export type LedgerEntryType =
  | 'topup'
  | 'usage'
  | 'fee'
  | 'refund'
  | 'adjustment'
  | 'promo'
  | 'chargeback';

export type MppSessionStatus = 'open' | 'settled' | 'closed';

/** The six control-panel scenarios (mpp is an orchestrated walkthrough). */
export type DemoScenario =
  | 'seed'
  | 'call-drain'
  | 'agent-usage'
  | 'mpp'
  | 'decline'
  | 'reset';

// ── Ledger rows (demo-state `transactions` + billing ledger) ─────────────────

/** One append-only ledger row as returned inside `GET /demo/state`. */
export interface LedgerEntry {
  id: number;
  /** Signed dollars — positive credit, negative debit. */
  amount: number;
  currency: string;
  entry_type: LedgerEntryType;
  source: PaymentSource;
  external_ref: string | null;
  /** Running balance (dollars) after this entry. */
  balance_after: number;
  metadata?: Record<string, unknown> | null;
  created_at: string;
}

// ── Payment methods ──────────────────────────────────────────────────────────

/** A saved card-on-file — provider tokens + display metadata only (SAQ-A). */
export interface PaymentMethod {
  id: number;
  provider: string;
  provider_pm_id: string;
  brand: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
  is_default: boolean;
  status: string;
}

/** Body for `POST /methods` — omit the token and the demo provider mints one. */
export interface CreatePaymentMethodRequest {
  brand?: string;
  make_default?: boolean;
}

// ── Auto-recharge (as embedded in `GET /demo/state`) ─────────────────────────

export interface AutoRechargeState {
  enabled: boolean;
  /** Fire an off-session top-up when balance drops below this (dollars). */
  threshold: number | null;
  /** How much each auto top-up adds (dollars). */
  recharge_amount: number | null;
  currency: string;
  daily_cap: number | null;
  cooldown_seconds: number;
  consecutive_failures: number;
  last_triggered_at: string | null;
  /** Set on decline — the dunning reason shown to the operator. */
  disabled_reason: string | null;
}

// ── MPP agent tabs ───────────────────────────────────────────────────────────

/** Trimmed session row as returned inside `GET /demo/state`. */
export interface MppSessionState {
  id: number;
  provider_session_id: string;
  spend_limit: number;
  total_charged: number;
  charge_count: number;
  status: MppSessionStatus;
  label: string | null;
  settlement_ref: string | null;
  created_at: string;
  settled_at: string | null;
}

/** Full session row from `POST /mpp/sessions`. */
export interface MppSession extends MppSessionState {
  provider: string;
  currency: string;
}

export interface MppSessionCreateRequest {
  spend_limit: number;
  label?: string;
}

export interface MppChargeRequest {
  amount: number;
  /** When true, settle the tab after adding this charge. */
  settle?: boolean;
}

export interface MppSettlement {
  provider_ref: string;
  amount: number;
  ledger_entry_id: number | null;
  balance: number | null;
}

/** Result of `POST /mpp/sessions/{id}/charge` (a refused overrun is a 409). */
export interface MppChargeResult {
  session_id: number;
  accepted: boolean;
  amount: number;
  total_charged: number;
  remaining: number;
  charge_count: number;
  status: MppSessionStatus;
  settled: boolean;
  settlement: MppSettlement | null;
  reason: string | null;
}

// ── x402 metered endpoint (`GET /demo/metered`) ──────────────────────────────

/** One `accepts[]` entry from the 402 challenge body. */
export interface X402Challenge {
  scheme: string;
  network: string;
  asset: string;
  /** TRUE integer USDC minor units (6-dp) — NOT dollars. */
  amount_minor: number;
  /** Price in dollars. */
  amount: number;
  pay_to: string;
  resource: string;
  nonce: string;
}

/** `settlement` object from the paid 200 retry. */
export interface X402Settlement {
  tx_hash: string;
  network: string;
  asset: string;
  amount_minor: number;
  payer: string;
}

/**
 * The metered probe models BOTH statuses as data (the 402 challenge is the
 * point of the visualization, not an error): `paid:false` carries the
 * challenge, `paid:true` carries the settlement + charged amount.
 */
export interface MeteredResponse {
  paid: boolean;
  challenge?: X402Challenge;
  settlement?: X402Settlement;
  /** Dollars charged on the paid retry (`charged` in the 200 body). */
  charged?: number;
  currency?: string;
  balance?: number | null;
}

// ── Demo control (admin) ─────────────────────────────────────────────────────

/** `POST /demo/seed` response. */
export interface SeedResult {
  customer_id: number;
  name: string;
  fresh: boolean;
  balance: number | null;
  auto_recharge: {
    enabled: boolean;
    threshold: number;
    recharge_amount: number;
  };
}

/** The auto-recharge outcome block shared by call-drain / decline responses. */
export interface AutoRechargeOutcome {
  /** 'charged' | 'skipped' | 'declined' (see services/auto_recharge.py). */
  action: string;
  reason: string | null;
  amount?: number | null;
  new_balance?: number | null;
  provider_ref?: string | null;
  ledger_entry_id?: number | null;
  consecutive_failures: number;
  disabled: boolean;
}

/** `POST /demo/simulate/call-drain` response. */
export interface CallDrainResult {
  customer_id: number;
  drained: number;
  minutes: number;
  rate_per_min: number;
  balance_after_drain: number | null;
  auto_recharge: AutoRechargeOutcome;
  balance: number | null;
}

/** `POST /demo/simulate/agent-usage` response. */
export interface AgentUsageResult {
  customer_id: number;
  requests: number;
  unit_price: number;
  total_charged: number;
  currency: string;
  tx_hash: string;
  ledger_entry_id: number;
  balance: number | null;
}

/** `POST /demo/simulate/decline` response. */
export interface DeclineResult {
  customer_id: number;
  reason: string;
  auto_recharge: AutoRechargeOutcome;
  dunning: {
    consecutive_failures: number;
    disabled_reason: string | null;
    enabled: boolean;
  } | null;
}

/** `POST /demo/reset` response. */
export interface ResetResult {
  status: string;
  deleted_customers: number;
  customer_ids: number[];
  deleted_ledger_entries?: number;
}

export interface DemoCustomer {
  id: number;
  name: string;
  account_type: string;
  balance: number;
  credit_limit: number;
  is_demo: boolean;
}

export interface DemoActivity {
  scenario: string;
  detail: Record<string, unknown> | null;
  created_at: string;
}

export interface Invoice {
  id: number;
  provider_invoice_id: string | null;
  amount: number;
  currency: string;
  status: string;
  period_start: string;
  period_end: string;
}

export interface RevenueByRail {
  rail: PaymentSource;
  label: string;
  revenue: number;
  count: number;
}

export interface RevenueSummary {
  total_revenue: number;
  by_rail: RevenueByRail[];
}

/** `GET /demo/state` — `{seeded:false}` alone when not yet seeded. */
export interface DemoState {
  seeded: boolean;
  customer?: DemoCustomer | null;
  balance?: number;
  transactions?: LedgerEntry[];
  mpp_sessions?: MppSessionState[];
  auto_recharge?: AutoRechargeState | null;
  payment_methods?: PaymentMethod[];
  invoices?: Invoice[];
  revenue?: RevenueSummary;
  activity?: DemoActivity[];
}

// ── Dashboards ───────────────────────────────────────────────────────────────

/** `GET /summary` (revenue-by-rail across demo customers). */
export interface PaymentsSummary {
  scope: string;
  customer_id: number | null;
  revenue: RevenueSummary;
  usage: { total_usage: number };
  reconciled: boolean;
}

export type ComplianceGateStatus = 'green' | 'red';

export interface ComplianceGate {
  id: string;
  name: string;
  status: ComplianceGateStatus;
  detail: string;
  evidence?: Record<string, unknown> | null;
}

/** `GET /compliance` — the three gates the design sits inside. */
export interface ComplianceStatus {
  gates: ComplianceGate[];
  all_green: boolean;
}
