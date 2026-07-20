/**
 * Payments API module — the frontend client + ANTI-CORRUPTION ADAPTER for the
 * exec DEMO monetary system (docs/PAYMENTS_SYSTEM_DESIGN.md §9).
 *
 * This is the single seam where the REAL backend wire shape is translated into
 * the component-facing view types. The backend returns money as DECIMAL DOLLAR
 * values (`"100.0000"`, `"0.0075"`) with NO `_minor` suffix; every mapper here
 * parses those to full-precision dollar `number`s via `parseMoney` (never
 * rounding to cents, so sub-cent micro-charges survive). Field names, envelopes
 * (`{ methods: [...] }`, `{ entries: [...] }`, `accepts: [...]`), and request
 * bodies/params are all normalised HERE so components never touch the raw shape.
 *
 * Every call goes through the shared `apiRequest` wrapper (JWT auth, ApiError
 * shaping) except the x402 metered probe, which must observe a real 402 status
 * without throwing — that one uses a thin dedicated fetch mirroring `apiRequest`.
 */

import { apiRequest, ApiError } from './client';
import { parseMoney, type MoneyInput } from '../components/payments/format';
import type {
  AutoRechargeSettings,
  AutoRechargeUpdate,
  BillingBalance,
  ComplianceStatus,
  CreatePaymentMethodRequest,
  DemoScenario,
  DemoState,
  Invoice,
  LedgerEntry,
  MeteredResponse,
  MppChargeRequest,
  MppChargeResult,
  MppSession,
  MppSessionCreateRequest,
  MppSettlement,
  PaymentMethod,
  PaymentsSummary,
  RevenueByRail,
  RevenueSummary,
  SetupIntent,
  TopupRequest,
  TopupResult,
  UsageSummary,
  X402Challenge,
  X402Settlement,
} from '../types/payments';

const AUTH_TOKEN_KEY = 'auth_token';

// ── Raw wire shapes (money as string|number) ─────────────────────────────────
// Only the fields the UI reads are typed; the backend may send more.

interface RawBalance {
  customer_id: number;
  balance: MoneyInput;
  currency: string;
}

interface RawLedgerEntry {
  id: number | string;
  customer_id?: number;
  amount: MoneyInput;
  currency: string;
  entry_type: LedgerEntry['entry_type'];
  source: LedgerEntry['source'];
  balance_after: MoneyInput;
  external_ref?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at: string;
}

interface RawLedgerPage {
  customer_id: number;
  entries: RawLedgerEntry[];
  next_cursor: number | null;
}

interface RawAutoRecharge {
  customer_id: number;
  enabled: boolean;
  threshold: MoneyInput;
  recharge_amount: MoneyInput;
  payment_method_id: number | null;
  currency: string;
  daily_cap: MoneyInput;
  cooldown_seconds: number;
  consecutive_failures: number;
  last_triggered_at?: string | null;
  disabled_reason?: string | null;
}

interface RawTopupResult {
  status: string;
  amount: MoneyInput;
  currency: string;
  rail: string;
  provider_ref: string | null;
  ledger_entry_id: number | null;
  balance: MoneyInput;
}

interface RawMppSession {
  id: number | string;
  provider: string;
  provider_session_id: string;
  spend_limit: MoneyInput;
  total_charged: MoneyInput;
  charge_count: number;
  currency: string;
  status: MppSession['status'];
  label: string | null;
  created_at: string;
  settlement_ref?: string | null;
  settled_at?: string | null;
}

interface RawMppSettlement {
  provider_ref: string;
  amount: MoneyInput;
  ledger_entry_id: number | null;
  balance: MoneyInput;
}

interface RawMppChargeResult {
  session_id: number | string;
  accepted: boolean;
  amount: MoneyInput;
  total_charged: MoneyInput;
  remaining: MoneyInput;
  charge_count: number;
  status: MppSession['status'];
  settled: boolean;
  settlement: RawMppSettlement | null;
  reason: string | null;
}

interface RawInvoice {
  id: number | string;
  provider_invoice_id: string | null;
  amount: MoneyInput;
  currency: string;
  status: Invoice['status'];
  period_start: string;
  period_end: string;
  created_at?: string | null;
}

interface RawUsageBySource {
  source: UsageSummary['by_source'][number]['source'];
  label: string;
  usage: MoneyInput;
  count: number;
}

interface RawUsageSummary {
  customer_id: number;
  currency: string;
  total_usage: MoneyInput;
  by_source: RawUsageBySource[];
  entry_count: number;
}

interface RawRevenueByRail {
  rail: RevenueByRail['rail'];
  label: string;
  revenue: MoneyInput;
  count: number;
}

interface RawRevenueSummary {
  total_revenue: MoneyInput;
  by_rail: RawRevenueByRail[];
}

interface RawPaymentsSummary {
  scope: string;
  customer_id: number | null;
  revenue: RawRevenueSummary;
  usage: { total_usage: MoneyInput };
  reconciled: boolean;
}

interface RawX402Accept {
  scheme: string;
  network: string;
  asset: string;
  amount_minor: number;
  amount: MoneyInput;
  pay_to: string;
  resource: string;
  nonce: string;
}

interface RawX402Settlement {
  tx_hash: string;
  network: string;
  asset: string;
  amount_minor: number;
  payer: string;
}

interface RawMeteredBody {
  // 402 shape
  error?: string;
  accepts?: RawX402Accept[];
  // 200 shape
  ok?: boolean;
  resource?: Record<string, unknown>;
  charged?: MoneyInput;
  currency?: string;
  settlement?: RawX402Settlement;
  ledger_entry_id?: number | null;
  balance?: MoneyInput;
}

interface RawDemoCustomer {
  id: number;
  name: string;
  account_type: string;
  balance: MoneyInput;
  credit_limit: MoneyInput;
  is_demo: boolean;
}

interface RawDemoState {
  seeded: boolean;
  customer?: RawDemoCustomer | null;
  balance?: MoneyInput;
  transactions?: RawLedgerEntry[];
  mpp_sessions?: RawMppSession[];
  auto_recharge?: RawAutoRecharge | null;
  payment_methods?: PaymentMethod[];
  invoices?: RawInvoice[];
  revenue?: RawRevenueSummary;
  activity?: DemoState['activity'];
}

// ── Mappers (raw wire → view type; money parsed to dollars) ──────────────────

function mapLedgerEntry(r: RawLedgerEntry): LedgerEntry {
  return {
    id: r.id,
    customer_id: r.customer_id,
    amount: parseMoney(r.amount),
    currency: r.currency,
    entry_type: r.entry_type,
    source: r.source,
    balance_after: parseMoney(r.balance_after),
    external_ref: r.external_ref ?? null,
    metadata: r.metadata ?? null,
    created_at: r.created_at,
  };
}

function mapAutoRecharge(r: RawAutoRecharge): AutoRechargeSettings {
  return {
    customer_id: r.customer_id,
    enabled: r.enabled,
    threshold: r.threshold == null ? null : parseMoney(r.threshold),
    recharge_amount: r.recharge_amount == null ? null : parseMoney(r.recharge_amount),
    payment_method_id: r.payment_method_id ?? null,
    currency: r.currency,
    daily_cap: r.daily_cap == null ? null : parseMoney(r.daily_cap),
    cooldown_seconds: r.cooldown_seconds,
    consecutive_failures: r.consecutive_failures,
    last_triggered_at: r.last_triggered_at ?? null,
    disabled_reason: r.disabled_reason ?? null,
  };
}

function mapMppSession(r: RawMppSession): MppSession {
  return {
    id: r.id,
    provider: r.provider,
    provider_session_id: r.provider_session_id,
    spend_limit: parseMoney(r.spend_limit),
    total_charged: parseMoney(r.total_charged),
    charge_count: r.charge_count,
    currency: r.currency,
    status: r.status,
    label: r.label ?? null,
    created_at: r.created_at,
    settlement_ref: r.settlement_ref ?? null,
    settled_at: r.settled_at ?? null,
  };
}

function mapMppSettlement(r: RawMppSettlement | null): MppSettlement | null {
  if (!r) return null;
  return {
    provider_ref: r.provider_ref,
    amount: parseMoney(r.amount),
    ledger_entry_id: r.ledger_entry_id ?? null,
    balance: r.balance == null ? null : parseMoney(r.balance),
  };
}

function mapInvoice(r: RawInvoice): Invoice {
  return {
    id: r.id,
    provider_invoice_id: r.provider_invoice_id ?? null,
    amount: parseMoney(r.amount),
    currency: r.currency,
    status: r.status,
    period_start: r.period_start,
    period_end: r.period_end,
    created_at: r.created_at ?? null,
  };
}

function mapRevenue(r: RawRevenueSummary | undefined): RevenueSummary {
  return {
    total_revenue: parseMoney(r?.total_revenue),
    by_rail: (r?.by_rail ?? []).map((b) => ({
      rail: b.rail,
      label: b.label,
      revenue: parseMoney(b.revenue),
      count: b.count,
    })),
  };
}

// ── Wave-1 ledger ─────────────────────────────────────────────────────────────

export async function getBalance(): Promise<BillingBalance> {
  const r = await apiRequest<RawBalance>('GET', '/v1/billing/balance');
  return { customer_id: r.customer_id, balance: parseMoney(r.balance), currency: r.currency };
}

/** Read the append-only ledger, newest first. Unwraps the `{ entries: [...] }` envelope. */
export async function getLedger(limit = 50): Promise<LedgerEntry[]> {
  const r = await apiRequest<RawLedgerPage>('GET', `/v1/billing/ledger?limit=${limit}`);
  return (r.entries ?? []).map(mapLedgerEntry);
}

// ── Payment methods ───────────────────────────────────────────────────────────

export async function createSetupIntent(brand = 'visa'): Promise<SetupIntent> {
  return apiRequest<SetupIntent>('POST', '/v1/payments/setup-intent', { brand });
}

/** List active payment methods. Unwraps the `{ methods: [...] }` envelope. */
export async function listPaymentMethods(): Promise<PaymentMethod[]> {
  const r = await apiRequest<{ customer_id: number; methods?: PaymentMethod[] }>(
    'GET',
    '/v1/payments/methods',
  );
  return r.methods ?? [];
}

export function createPaymentMethod(body: CreatePaymentMethodRequest): Promise<PaymentMethod> {
  return apiRequest('POST', '/v1/payments/methods', body);
}

export function deletePaymentMethod(id: number | string): Promise<{ status: string; id: number }> {
  return apiRequest('DELETE', `/v1/payments/methods/${id}`);
}

// ── Top-up ────────────────────────────────────────────────────────────────────

export async function topup(body: TopupRequest): Promise<TopupResult> {
  const r = await apiRequest<RawTopupResult>('POST', '/v1/payments/topup', body);
  return {
    status: r.status,
    amount: parseMoney(r.amount),
    currency: r.currency,
    rail: r.rail,
    provider_ref: r.provider_ref ?? null,
    ledger_entry_id: r.ledger_entry_id ?? null,
    balance: parseMoney(r.balance),
  };
}

// ── Auto-recharge ─────────────────────────────────────────────────────────────

export async function getAutoRecharge(): Promise<AutoRechargeSettings> {
  const r = await apiRequest<RawAutoRecharge>('GET', '/v1/payments/auto-recharge');
  return mapAutoRecharge(r);
}

export async function updateAutoRecharge(body: AutoRechargeUpdate): Promise<AutoRechargeSettings> {
  const r = await apiRequest<RawAutoRecharge>('PUT', '/v1/payments/auto-recharge', body);
  return mapAutoRecharge(r);
}

// ── Invoices + usage ──────────────────────────────────────────────────────────

/** List invoices. Unwraps the `{ invoices: [...] }` envelope. */
export async function listInvoices(): Promise<Invoice[]> {
  const r = await apiRequest<{ customer_id: number; invoices?: RawInvoice[] }>(
    'GET',
    '/v1/payments/invoices',
  );
  return (r.invoices ?? []).map(mapInvoice);
}

export async function getUsage(): Promise<UsageSummary> {
  const r = await apiRequest<RawUsageSummary>('GET', '/v1/payments/usage');
  return {
    customer_id: r.customer_id,
    currency: r.currency,
    total_usage: parseMoney(r.total_usage),
    by_source: (r.by_source ?? []).map((s) => ({
      source: s.source,
      label: s.label,
      usage: parseMoney(s.usage),
      count: s.count,
    })),
    entry_count: r.entry_count,
  };
}

// ── Machine payments: x402 metered probe ──────────────────────────────────────

/** Map the 402 `accepts[0]` challenge (amount string → dollars; amount_minor kept). */
function mapChallenge(a: RawX402Accept): X402Challenge {
  return {
    scheme: a.scheme,
    network: a.network,
    asset: a.asset,
    amount_minor: a.amount_minor,
    amount: parseMoney(a.amount),
    pay_to: a.pay_to,
    resource: a.resource,
    nonce: a.nonce,
  };
}

/** Map the 200 settlement (charged string → dollars; amount_minor kept). */
function mapSettlement(body: RawMeteredBody): X402Settlement | undefined {
  const s = body.settlement;
  if (!s) return undefined;
  return {
    tx_hash: s.tx_hash,
    network: s.network,
    asset: s.asset,
    amount_minor: s.amount_minor,
    payer: s.payer,
    charged: parseMoney(body.charged),
    currency: body.currency ?? 'USDC',
  };
}

/**
 * Hits the demo metered endpoint. Unlike every other call this INTENTIONALLY
 * tolerates a `402 Payment Required` — the whole point of the x402 visualization
 * is to observe the challenge, so a 402 body is returned as a typed
 * `MeteredResponse` (`paid:false`, with `challenge` mapped from `accepts[0]`)
 * rather than thrown. A 200 body is returned as `paid:true` (with the mapped
 * `settlement`). Any OTHER non-2xx still throws `ApiError`.
 *
 * `signature` — when present, the (demo) PAYMENT-SIGNATURE header value; supplying
 * it flips the endpoint from 402 → 200.
 */
export async function probeMetered(signature?: string): Promise<MeteredResponse> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // x402 v2 header (design §4 — PAYMENT-SIGNATURE supersedes legacy X-PAYMENT).
  if (signature) headers['PAYMENT-SIGNATURE'] = signature;

  const res = await fetch('/api/v1/payments/demo/metered', { method: 'GET', headers });

  if (res.status === 401) {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    window.location.replace('/');
    throw new ApiError(401, 'Session expired. Please sign in again.');
  }

  // 402 is the challenge (expected). 200 is the paid resource. Both are data.
  if (res.status === 402 || res.ok) {
    const body = (await res.json().catch(() => ({}))) as RawMeteredBody;
    const accept = body.accepts && body.accepts.length > 0 ? body.accepts[0] : undefined;
    return {
      paid: res.ok,
      challenge: accept ? mapChallenge(accept) : undefined,
      settlement: mapSettlement(body),
      resource: body.resource,
    };
  }

  let errBody: unknown;
  try {
    errBody = await res.json();
  } catch {
    errBody = await res.text().catch(() => 'metered probe failed');
  }
  throw new ApiError(res.status, `Metered probe failed (${res.status})`, errBody);
}

// ── Machine payments: Stripe MPP agent tab ────────────────────────────────────

/** List MPP sessions from the demo-state read (there is no standalone list endpoint). */
export async function listMppSessions(): Promise<MppSession[]> {
  const r = await apiRequest<RawDemoState>('GET', '/v1/payments/demo/state');
  return (r.mpp_sessions ?? []).map(mapMppSession);
}

export async function createMppSession(body: MppSessionCreateRequest): Promise<MppSession> {
  const r = await apiRequest<RawMppSession>('POST', '/v1/payments/mpp/sessions', body);
  return mapMppSession(r);
}

/** Append one streamed micro-charge to a tab (an explicit amount per tick is required). */
export async function chargeMppSession(
  id: number | string,
  body: MppChargeRequest,
): Promise<MppChargeResult> {
  const r = await apiRequest<RawMppChargeResult>(
    'POST',
    `/v1/payments/mpp/sessions/${id}/charge`,
    body,
  );
  return {
    session_id: r.session_id,
    accepted: r.accepted,
    amount: parseMoney(r.amount),
    total_charged: parseMoney(r.total_charged),
    remaining: parseMoney(r.remaining),
    charge_count: r.charge_count,
    status: r.status,
    settled: r.settled,
    settlement: mapMppSettlement(r.settlement),
    reason: r.reason ?? null,
  };
}

// ── Dashboards ────────────────────────────────────────────────────────────────

export async function getPaymentsSummary(scope = 'demo'): Promise<PaymentsSummary> {
  const r = await apiRequest<RawPaymentsSummary>(
    'GET',
    `/v1/payments/summary?scope=${encodeURIComponent(scope)}`,
  );
  return {
    scope: r.scope,
    customer_id: r.customer_id ?? null,
    revenue: mapRevenue(r.revenue),
    usage: { total_usage: parseMoney(r.usage?.total_usage) },
    reconciled: r.reconciled,
  };
}

export function getComplianceStatus(): Promise<ComplianceStatus> {
  return apiRequest('GET', '/v1/payments/compliance');
}

// ── Demo control (admin) ──────────────────────────────────────────────────────

export async function getDemoState(): Promise<DemoState> {
  const r = await apiRequest<RawDemoState>('GET', '/v1/payments/demo/state');
  if (!r.seeded) return { seeded: false };
  return {
    seeded: true,
    customer: r.customer
      ? {
          id: r.customer.id,
          name: r.customer.name,
          account_type: r.customer.account_type,
          balance: parseMoney(r.customer.balance),
          credit_limit: parseMoney(r.customer.credit_limit),
          is_demo: r.customer.is_demo,
        }
      : null,
    balance: parseMoney(r.balance),
    transactions: (r.transactions ?? []).map(mapLedgerEntry),
    mpp_sessions: (r.mpp_sessions ?? []).map(mapMppSession),
    auto_recharge: r.auto_recharge ? mapAutoRecharge(r.auto_recharge) : null,
    payment_methods: r.payment_methods ?? [],
    invoices: (r.invoices ?? []).map(mapInvoice),
    revenue: mapRevenue(r.revenue),
    activity: r.activity ?? [],
  };
}

/**
 * Fire a demo scenario. Backend control endpoints take QUERY params, not a body:
 *   • seed / reset       → POST /v1/payments/demo/{scenario}
 *   • call-drain / …     → POST /v1/payments/demo/simulate/{scenario}
 * The `simulate/*` endpoints accept sensible server-side defaults, so no params
 * are required for the one-click presenter flow.
 */
export function runDemoScenario(scenario: DemoScenario): Promise<unknown> {
  const path =
    scenario === 'seed' || scenario === 'reset'
      ? `/v1/payments/demo/${scenario}`
      : `/v1/payments/demo/simulate/${scenario}`;
  // No JSON body — params (when supplied) go on the query string.
  return apiRequest('POST', path);
}
