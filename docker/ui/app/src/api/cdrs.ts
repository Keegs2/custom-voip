import { apiRequest } from './client';
import type { Cdr, CdrSearchParams, CdrSearchResult } from '../types/cdr';
import type { CdrSummaryResponse } from '../types/rate';

/** Raw API shape — may use `cdrs`/`count` OR `items`/`total` depending on version. */
interface CdrRawResult {
  cdrs?: Cdr[];
  items?: Cdr[];
  count?: number;
  total?: number;
  limit?: number;
  offset?: number;
}

export async function searchCdrs(params: CdrSearchParams = {}): Promise<CdrSearchResult> {
  const query = new URLSearchParams();
  if (params.customer_id !== undefined) query.set('customer_id', String(params.customer_id));
  if (params.product_type) query.set('product_type', params.product_type);
  if (params.direction) query.set('direction', params.direction);
  if (params.caller_id) query.set('caller_id', params.caller_id);
  if (params.destination) query.set('destination', params.destination);
  if (params.start_from) query.set('start_from', params.start_from);
  if (params.start_to) query.set('start_to', params.start_to);
  if (params.hangup_cause) query.set('hangup_cause', params.hangup_cause);
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.offset !== undefined) query.set('offset', String(params.offset));
  if (params.sort_by) query.set('sort_by', params.sort_by);
  if (params.sort_dir) query.set('sort_dir', params.sort_dir);

  const qs = query.toString();
  const raw = await apiRequest<CdrRawResult>('GET', `/cdrs${qs ? `?${qs}` : ''}`);

  // Normalise field names: API returns either `cdrs`/`count` or `items`/`total`
  const items = raw.items ?? raw.cdrs ?? [];
  const total = raw.total ?? raw.count ?? items.length;

  return {
    items,
    total,
    limit: raw.limit ?? params.limit ?? 50,
    offset: raw.offset ?? params.offset ?? 0,
  };
}

export async function getCdr(uuid: string): Promise<Cdr> {
  return apiRequest('GET', `/cdrs/${uuid}`);
}

export async function rateCdr(uuid: string): Promise<Cdr> {
  return apiRequest('POST', `/cdrs/${encodeURIComponent(uuid)}/rate`);
}

export interface CdrSummaryParams {
  customer_id?: number;
  group_by?: 'day' | 'hour' | 'destination';
}

export async function getCdrSummary(params: CdrSummaryParams = {}): Promise<CdrSummaryResponse> {
  const query = new URLSearchParams();
  if (params.customer_id !== undefined) query.set('customer_id', String(params.customer_id));
  if (params.group_by) query.set('group_by', params.group_by);

  const qs = query.toString();
  return apiRequest('GET', `/cdrs/summary${qs ? `?${qs}` : ''}`);
}

/**
 * Fetch recent CDRs for a specific customer, scoped to a date range.
 * The API uses `start_date` / `end_date` query params (ISO 8601 strings).
 */
export async function getCustomerRecentCdrs(
  customerId: number,
  limit = 20,
  startDate?: Date,
): Promise<CdrSearchResult> {
  const query = new URLSearchParams();
  query.set('customer_id', String(customerId));
  query.set('limit', String(limit));
  if (startDate) {
    query.set('start_date', startDate.toISOString());
    query.set('end_date', new Date().toISOString());
  }

  interface RawResult {
    cdrs?: Cdr[];
    items?: Cdr[];
    count?: number;
    total?: number;
    limit?: number;
    offset?: number;
  }

  const raw = await apiRequest<RawResult>('GET', `/cdrs?${query.toString()}`);
  const items = raw.items ?? raw.cdrs ?? [];
  const total = raw.total ?? raw.count ?? items.length;

  return {
    items,
    total,
    limit: raw.limit ?? limit,
    offset: raw.offset ?? 0,
  };
}

/**
 * Fetch 30-day daily CDR summary for a customer.
 * Returns day-grouped rows that drive the bar chart and aggregate stats.
 */
export async function getCustomerCdrDailySummary(
  customerId: number,
): Promise<CdrSummaryResponse> {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 30);

  const query = new URLSearchParams();
  query.set('customer_id', String(customerId));
  query.set('group_by', 'day');
  query.set('start_date', start.toISOString());
  query.set('end_date', end.toISOString());

  return apiRequest<CdrSummaryResponse>('GET', `/cdrs/summary?${query.toString()}`);
}

/**
 * Fetch up to 500 CDRs for the statistics tab, including quality/RTP fields.
 * Uses a 30-day window and returns all answered calls so quality trends
 * can be computed client-side from the MOS/jitter/packet-loss fields.
 */
export async function getCustomerStatsCdrs(
  customerId: number,
  limit = 500,
): Promise<CdrSearchResult> {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 30);

  const query = new URLSearchParams();
  query.set('customer_id', String(customerId));
  query.set('limit', String(limit));
  query.set('start_date', start.toISOString());
  query.set('end_date', end.toISOString());

  interface RawResult {
    cdrs?: Cdr[];
    items?: Cdr[];
    count?: number;
    total?: number;
    limit?: number;
    offset?: number;
  }

  const raw = await apiRequest<RawResult>('GET', `/cdrs?${query.toString()}`);
  const items = raw.items ?? raw.cdrs ?? [];
  const total = raw.total ?? raw.count ?? items.length;

  return {
    items,
    total,
    limit: raw.limit ?? limit,
    offset: raw.offset ?? 0,
  };
}
