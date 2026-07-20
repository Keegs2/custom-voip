/**
 * Least-Cost Outbound API client (`/lco`). Rate-deck + policy + route preview are
 * admin-only server-side; savings + billing-export are tenant-scoped.
 *
 * NOTE: the savings + billing-export endpoints take `start`/`end` query params
 * (ISO 8601), not `from`/`to`.
 */

import { apiRequest } from './client';
import type {
  RateDeck,
  RateDeckListResponse,
  RateDeckCreate,
  RateDeckUpdate,
  RateDeckImportRequest,
  RateDeckImportResult,
  CarrierPolicy,
  CarrierPolicyUpsert,
  LcoRouteDecision,
  SavingsReport,
  BillingExportFormat,
} from '../types/lco';

// ── LCO decision (route preview) ─────────────────────────────────────────────

export async function getLcoRoute(destination: string, customerId?: number): Promise<LcoRouteDecision> {
  const qs = new URLSearchParams();
  qs.set('destination', destination);
  if (customerId !== undefined) qs.set('customer_id', String(customerId));
  return apiRequest('GET', `/lco/route?${qs.toString()}`);
}

// ── Rate decks ───────────────────────────────────────────────────────────────

export interface ListDecksParams {
  carrier_id?: number;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listDecks(params: ListDecksParams = {}): Promise<RateDeckListResponse> {
  const qs = new URLSearchParams();
  if (params.carrier_id !== undefined) qs.set('carrier_id', String(params.carrier_id));
  if (params.search) qs.set('search', params.search);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const q = qs.toString();
  const raw = await apiRequest<RateDeckListResponse | RateDeck[]>('GET', `/lco/decks${q ? `?${q}` : ''}`);
  if (Array.isArray(raw)) return { items: raw, total: raw.length, limit: params.limit ?? raw.length, offset: params.offset ?? 0 };
  return raw;
}

export async function createDeck(data: RateDeckCreate): Promise<RateDeck> {
  return apiRequest('POST', '/lco/decks', data);
}

export async function updateDeck(id: number, data: RateDeckUpdate): Promise<RateDeck> {
  return apiRequest('PATCH', `/lco/decks/${id}`, data);
}

export async function deleteDeck(id: number): Promise<void> {
  await apiRequest('DELETE', `/lco/decks/${id}`);
}

export async function importDeck(data: RateDeckImportRequest): Promise<RateDeckImportResult> {
  return apiRequest('POST', '/lco/decks/import', data);
}

// ── Per-customer carrier policy ──────────────────────────────────────────────

export async function listPolicy(customerId?: number): Promise<CarrierPolicy[]> {
  const qs = new URLSearchParams();
  if (customerId !== undefined) qs.set('customer_id', String(customerId));
  const q = qs.toString();
  return apiRequest('GET', `/lco/policy${q ? `?${q}` : ''}`);
}

export async function upsertPolicy(data: CarrierPolicyUpsert): Promise<CarrierPolicy> {
  return apiRequest('PUT', '/lco/policy', data);
}

export async function deletePolicy(id: number): Promise<void> {
  await apiRequest('DELETE', `/lco/policy/${id}`);
}

// ── Savings report ───────────────────────────────────────────────────────────

export interface SavingsParams {
  start: string; // ISO 8601
  end: string; // ISO 8601
  customer_id?: number;
  limit?: number;
}

export async function getSavings(params: SavingsParams): Promise<SavingsReport> {
  const qs = new URLSearchParams();
  qs.set('start', params.start);
  qs.set('end', params.end);
  if (params.customer_id !== undefined) qs.set('customer_id', String(params.customer_id));
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  return apiRequest('GET', `/lco/savings?${qs.toString()}`);
}

// ── Billing export (streamed CSV/JSONL download) ─────────────────────────────

const AUTH_TOKEN_KEY = 'auth_token';

export interface BillingExportParams {
  start: string;
  end: string;
  customer_id?: number;
  fmt?: BillingExportFormat;
}

/**
 * Download the rated-CDR billing feed. The endpoint STREAMS the file, so we use
 * a raw fetch (auth header from localStorage) + a Blob download rather than
 * `apiRequest` (which parses JSON). Throws on a non-2xx response so the caller
 * can toast the error.
 */
export async function downloadBillingExport(params: BillingExportParams): Promise<void> {
  const qs = new URLSearchParams();
  qs.set('start', params.start);
  qs.set('end', params.end);
  if (params.customer_id !== undefined) qs.set('customer_id', String(params.customer_id));
  const fmt = params.fmt ?? 'csv';
  qs.set('fmt', fmt);

  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  const res = await fetch(`/api/lco/billing-export?${qs.toString()}`, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    let detail = `Export failed (${res.status})`;
    try {
      const body = (await res.json()) as { detail?: string };
      if (body?.detail) detail = body.detail;
    } catch {
      // non-JSON error body — keep the status-based message
    }
    throw new Error(detail);
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const ext = fmt === 'csv' ? 'csv' : 'jsonl';
  const a = document.createElement('a');
  a.href = url;
  a.download = `billing_${params.start.slice(0, 10)}_${params.end.slice(0, 10)}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
