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
