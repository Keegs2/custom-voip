/**
 * Machine Payments Demo — API client functions.
 *
 * Every call goes through the shared `apiRequest` wrapper (JWT auth, ApiError
 * shaping) EXCEPT the x402 metered probe, which must observe a real
 * `402 Payment Required` without throwing — the 402 challenge is the payload
 * the visualizer animates, so it is returned as typed data.
 *
 * All endpoints live under `/v1/payments/*` and are admin-gated demo ops;
 * when `PAYMENTS_DEMO_MODE` is off the whole router 404s (the page turns
 * that into a composed "demo off" state).
 */

import { apiRequest, ApiError } from '../../../api/client';
import type {
  AgentUsageResult,
  CallDrainResult,
  ComplianceStatus,
  CreatePaymentMethodRequest,
  DeclineResult,
  DemoState,
  MeteredResponse,
  MppChargeRequest,
  MppChargeResult,
  MppSession,
  MppSessionCreateRequest,
  PaymentMethod,
  PaymentsSummary,
  ResetResult,
  SeedResult,
} from './types';

const AUTH_TOKEN_KEY = 'auth_token';

// x402 v2 header names (design note: v2 uses PAYMENT-*, not X-PAYMENT-*).
const H_PAYMENT_SIGNATURE = 'PAYMENT-SIGNATURE';

// ── Demo control ─────────────────────────────────────────────────────────────

export function getDemoState(): Promise<DemoState> {
  return apiRequest<DemoState>('GET', '/v1/payments/demo/state');
}

export function seedDemo(): Promise<SeedResult> {
  return apiRequest<SeedResult>('POST', '/v1/payments/demo/seed');
}

export function resetDemo(): Promise<ResetResult> {
  return apiRequest<ResetResult>('POST', '/v1/payments/demo/reset');
}

/**
 * Drain simulated call minutes, then fire the real auto-recharge trigger.
 * `minutes` is computed by the caller so the drain reliably crosses the
 * auto-recharge threshold (the backend default of 220 min ≈ $4.40 does not).
 */
export function simulateCallDrain(minutes?: number): Promise<CallDrainResult> {
  const qs = minutes != null ? `?minutes=${minutes}` : '';
  return apiRequest<CallDrainResult>('POST', `/v1/payments/demo/simulate/call-drain${qs}`);
}

export function simulateAgentUsage(requests?: number): Promise<AgentUsageResult> {
  const qs = requests != null ? `?requests=${requests}` : '';
  return apiRequest<AgentUsageResult>('POST', `/v1/payments/demo/simulate/agent-usage${qs}`);
}

export function simulateDecline(): Promise<DeclineResult> {
  return apiRequest<DeclineResult>('POST', '/v1/payments/demo/simulate/decline');
}

// ── Payment methods ──────────────────────────────────────────────────────────

/** Mint + persist a demo card in one call (the provider mints when no token). */
export function createPaymentMethod(body: CreatePaymentMethodRequest): Promise<PaymentMethod> {
  return apiRequest<PaymentMethod>('POST', '/v1/payments/methods', body);
}

// ── MPP agent tabs ───────────────────────────────────────────────────────────

export function createMppSession(body: MppSessionCreateRequest): Promise<MppSession> {
  return apiRequest<MppSession>('POST', '/v1/payments/mpp/sessions', body);
}

/** Stream one micro-charge onto a tab. A refused overrun throws ApiError 409. */
export function chargeMppSession(id: number, body: MppChargeRequest): Promise<MppChargeResult> {
  return apiRequest<MppChargeResult>('POST', `/v1/payments/mpp/sessions/${id}/charge`, body);
}

// ── Dashboards ───────────────────────────────────────────────────────────────

export function getPaymentsSummary(): Promise<PaymentsSummary> {
  return apiRequest<PaymentsSummary>('GET', '/v1/payments/summary?scope=demo');
}

export function getComplianceStatus(): Promise<ComplianceStatus> {
  return apiRequest<ComplianceStatus>('GET', '/v1/payments/compliance');
}

// ── x402 metered probe ───────────────────────────────────────────────────────

/**
 * Hit the demo metered endpoint. Unlike every other call this INTENTIONALLY
 * tolerates `402 Payment Required` — the challenge is what the visualizer
 * animates — so both 402 and 200 come back as a typed `MeteredResponse`.
 * Any other non-2xx still throws `ApiError`. Mirrors `apiRequest`'s auth and
 * 401 handling.
 *
 * `signature` — when present, sent as the (demo) PAYMENT-SIGNATURE header;
 * supplying it flips the endpoint from 402 → 200 + settlement.
 */
export async function probeMetered(signature?: string): Promise<MeteredResponse> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (signature) headers[H_PAYMENT_SIGNATURE] = signature;

  const res = await fetch('/api/v1/payments/demo/metered', { method: 'GET', headers });

  if (res.status === 401) {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    window.location.replace('/');
    throw new ApiError(401, 'Session expired. Please sign in again.');
  }

  // 402 is the challenge (expected); 200 is the paid resource. Both are data.
  if (res.status === 402 || res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      accepts?: MeteredResponse['challenge'][];
      settlement?: MeteredResponse['settlement'];
      charged?: number;
      currency?: string;
      balance?: number | null;
    };
    return {
      paid: res.ok,
      challenge: body.accepts && body.accepts.length > 0 ? body.accepts[0] : undefined,
      settlement: body.settlement,
      charged: body.charged,
      currency: body.currency,
      balance: body.balance ?? null,
    };
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    raw = undefined;
  }
  throw new ApiError(res.status, `Metered probe failed (${res.status})`, raw);
}
