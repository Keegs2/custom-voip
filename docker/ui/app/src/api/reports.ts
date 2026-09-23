/**
 * Customer Reporting API client — `/reports/*` (docs/CUSTOMER_REPORTING_DESIGN.md).
 *
 * Paths are un-prefixed like every other module here (`/cdrs`, `/rcf`, …):
 * the API mounts the router at both `/v1/reports` and `/reports`, and the
 * `/api` base in client.ts is stripped by nginx / the Vite proxy.
 *
 * One serializer (`reportQuery`) builds the common scope for EVERY endpoint,
 * including the CSV export, so the page, the table and the spreadsheet
 * provably ask the server for the identical slice of data.
 */
import { apiRequest, apiRequestBlob } from './client';
import type {
  MyNumbers,
  ReportCalls,
  ReportCallsParams,
  ReportCsvDownload,
  ReportNumbers,
  ReportOverview,
  ReportScope,
  ReportTrend,
  TrendBucket,
} from '../types/reports';

/**
 * Common query params. `numbers` is sorted so the same selection always
 * serializes identically (stable cache keys, stable URLs); `customer_id` is
 * only ever present for staff — callers pass `undefined` for tenants.
 */
export function reportQuery(scope: ReportScope): URLSearchParams {
  const query = new URLSearchParams();
  query.set('start', scope.start);
  query.set('end', scope.end);
  query.set('tz', scope.tz);
  if (scope.numbers.length > 0) {
    query.set('numbers', [...scope.numbers].sort().join(','));
  }
  if (scope.customer_id !== undefined) {
    query.set('customer_id', String(scope.customer_id));
  }
  return query;
}

/** Filter params shared by `/reports/calls` and `/reports/calls.csv`. */
function applyCallFilters(
  query: URLSearchParams,
  filters: Pick<ReportCallsParams, 'outcome' | 'direction'>,
): URLSearchParams {
  if (filters.outcome !== 'all') query.set('outcome', filters.outcome);
  if (filters.direction !== 'all') query.set('direction', filters.direction);
  return query;
}

export function getReportOverview(scope: ReportScope): Promise<ReportOverview> {
  return apiRequest('GET', `/reports/overview?${reportQuery(scope).toString()}`);
}

/** `bucket` omitted → server default (day ≤ 62 days, week ≤ 190, else month). */
export function getReportTrend(scope: ReportScope, bucket?: TrendBucket): Promise<ReportTrend> {
  const query = reportQuery(scope);
  if (bucket) query.set('bucket', bucket);
  return apiRequest('GET', `/reports/trend?${query.toString()}`);
}

export function getReportNumbers(scope: ReportScope): Promise<ReportNumbers> {
  return apiRequest('GET', `/reports/numbers?${reportQuery(scope).toString()}`);
}

export function getReportCalls(scope: ReportScope, params: ReportCallsParams): Promise<ReportCalls> {
  const query = applyCallFilters(reportQuery(scope), params);
  query.set('limit', String(params.limit));
  query.set('offset', String(params.offset));
  return apiRequest('GET', `/reports/calls?${query.toString()}`);
}

/**
 * The number picker's options. Takes only the staff customer id — the list
 * is the customer's numbers, independent of the period being viewed.
 */
export function getMyNumbers(customerId?: number): Promise<MyNumbers> {
  const qs = customerId !== undefined ? `?customer_id=${customerId}` : '';
  return apiRequest('GET', `/reports/my-numbers${qs}`);
}

/**
 * Spreadsheet export — same scope + filters as the call list, no paging (the
 * server caps at 100,000 rows and flags it with `X-Report-Truncated: true`).
 * Goes through apiRequestBlob so auth, the 401 bounce and ApiError parsing
 * are identical to every JSON call.
 */
export async function downloadReportCsv(
  scope: ReportScope,
  filters: Pick<ReportCallsParams, 'outcome' | 'direction'>,
): Promise<ReportCsvDownload> {
  const query = applyCallFilters(reportQuery(scope), filters);
  const result = await apiRequestBlob(`/reports/calls.csv?${query.toString()}`);
  return {
    blob: result.blob,
    filename: result.filename ?? `calls_${scope.start}_${scope.end}.csv`,
    truncated: result.headers.get('X-Report-Truncated')?.toLowerCase() === 'true',
  };
}
