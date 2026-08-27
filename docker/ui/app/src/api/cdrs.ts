import { apiRequest } from './client';
import type { Cdr, CdrSearchParams, CdrSearchResult, CdrSummaryResponse } from '../types/cdr';

/**
 * Raw API shape — may use `cdrs` or `items` for the row list depending on
 * version. `count` is the number of rows in THIS response (== len(cdrs));
 * `total` is the full match count for the filters, independent of
 * limit/offset, and only exists on newer API builds. They are NOT
 * interchangeable — see the normalisation note in searchCdrs().
 */
interface CdrRawResult {
  cdrs?: Cdr[];
  items?: Cdr[];
  count?: number;
  total?: number;
  limit?: number;
  offset?: number;
}

/**
 * Normalise any parseable datetime string to an ISO 8601 UTC instant
 * ("...Z"). The API's `start_date`/`end_date` are timezone-aware datetimes;
 * sending a naive local wall-clock string would be misread as UTC and shift
 * the window by the caller's UTC offset.
 */
function toIsoUtc(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

/**
 * THE single serializer for CDR query params — used by BOTH `/cdrs` and
 * `/cdrs/summary` (the API accepts the identical filter set on both), and by
 * the CSV export path. Param names here are the API's declared names —
 * FastAPI silently ignores anything else (`start_from`/`start_to` was the bug
 * that made the search page permanently show the last-24h default).
 */
export function cdrSearchQuery(params: CdrSearchParams): URLSearchParams {
  const query = new URLSearchParams();
  if (params.customer_id !== undefined) query.set('customer_id', String(params.customer_id));
  if (params.product_type) query.set('product_type', params.product_type);
  if (params.direction) query.set('direction', params.direction);
  if (params.caller_id) query.set('caller_id', params.caller_id);
  if (params.destination) query.set('destination', params.destination);
  if (params.start_date) query.set('start_date', toIsoUtc(params.start_date));
  if (params.end_date) query.set('end_date', toIsoUtc(params.end_date));
  if (params.hangup_cause) query.set('hangup_cause', params.hangup_cause);
  if (params.zone) query.set('zone', params.zone);
  if (params.sbc_id) query.set('sbc_id', params.sbc_id);
  if (params.rated_only) query.set('rated_only', 'true');
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.offset !== undefined) query.set('offset', String(params.offset));
  if (params.sort_by) query.set('sort_by', params.sort_by);
  if (params.sort_dir) query.set('sort_dir', params.sort_dir);
  return query;
}

export async function searchCdrs(params: CdrSearchParams = {}): Promise<CdrSearchResult> {
  const qs = cdrSearchQuery(params).toString();
  const raw = await apiRequest<CdrRawResult>('GET', `/cdrs${qs ? `?${qs}` : ''}`);

  const items = raw.items ?? raw.cdrs ?? [];

  return {
    items,
    // ONLY the API's `total` is a real match count. The legacy `count` field
    // is the row count of THIS response, so falling back to it would report
    // a full page as the entire result set — the old "maxes out at 50" bug.
    // Absent (undefined) until the API that emits `total` is deployed.
    total: raw.total,
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

/**
 * `/cdrs/summary` accepts the SAME filter set as `/cdrs` (minus pagination),
 * plus the grouping dimension.
 */
export type CdrSummaryParams = Omit<CdrSearchParams, 'limit' | 'offset' | 'sort_by' | 'sort_dir'> & {
  group_by?: 'day' | 'hour' | 'destination';
};

export async function getCdrSummary(params: CdrSummaryParams = {}): Promise<CdrSummaryResponse> {
  const { group_by, ...filters } = params;
  // Reuse the exact same serializer as searchCdrs so Records, Summary, and
  // CSV export provably send the identical filter set.
  const query = cdrSearchQuery(filters);
  if (group_by) query.set('group_by', group_by);

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

  const raw = await apiRequest<CdrRawResult>('GET', `/cdrs?${query.toString()}`);
  const items = raw.items ?? raw.cdrs ?? [];

  return {
    items,
    total: raw.total, // real match count only — never the legacy `count`
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

  const raw = await apiRequest<CdrRawResult>('GET', `/cdrs?${query.toString()}`);
  const items = raw.items ?? raw.cdrs ?? [];

  return {
    items,
    total: raw.total, // real match count only — never the legacy `count`
    limit: raw.limit ?? limit,
    offset: raw.offset ?? 0,
  };
}
