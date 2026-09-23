/**
 * TanStack Query hooks for the Reporting page.
 *
 * Cache keys embed the full serialized scope (the exact query string the
 * server sees), so two components asking for the same slice share one
 * request and a changed filter can never serve a stale slice.
 *
 * staleTime: reports summarize finished calls, so a couple of minutes is
 * fresh enough (new calls trickle in, nothing a customer needs by the
 * second). The number list barely ever changes — 10 minutes.
 *
 * `enabled` is false until the scope is known (staff must pick a customer
 * first — the API 422s a staff report without `customer_id`).
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  getMyNumbers,
  getReportCalls,
  getReportNumbers,
  getReportOverview,
  getReportTrend,
  reportQuery,
} from '../../api/reports';
import type { ReportCallsParams, ReportScope } from '../../types/reports';

const REPORT_STALE_MS = 2 * 60 * 1000;
const NUMBERS_STALE_MS = 10 * 60 * 1000;

function scopeKey(scope: ReportScope): string {
  return reportQuery(scope).toString();
}

export function useReportOverview(scope: ReportScope, enabled: boolean) {
  return useQuery({
    queryKey: ['reports', 'overview', scopeKey(scope)],
    queryFn: () => getReportOverview(scope),
    staleTime: REPORT_STALE_MS,
    enabled,
  });
}

export function useReportTrend(scope: ReportScope, enabled: boolean) {
  return useQuery({
    queryKey: ['reports', 'trend', scopeKey(scope)],
    queryFn: () => getReportTrend(scope),
    staleTime: REPORT_STALE_MS,
    enabled,
  });
}

export function useReportNumbers(scope: ReportScope, enabled: boolean) {
  return useQuery({
    queryKey: ['reports', 'numbers', scopeKey(scope)],
    queryFn: () => getReportNumbers(scope),
    staleTime: REPORT_STALE_MS,
    enabled,
  });
}

/**
 * Paged call list. Previous rows stay on screen while the next page loads
 * (keepPreviousData) so the table keeps its height instead of flashing a
 * skeleton on every page flip; callers dim it via `isPlaceholderData`.
 */
export function useReportCalls(scope: ReportScope, params: ReportCallsParams, enabled: boolean) {
  return useQuery({
    queryKey: [
      'reports',
      'calls',
      scopeKey(scope),
      params.outcome,
      params.direction,
      params.limit,
      params.offset,
    ],
    queryFn: () => getReportCalls(scope, params),
    staleTime: REPORT_STALE_MS,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useMyNumbers(customerId: number | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['reports', 'my-numbers', customerId ?? 'self'],
    queryFn: () => getMyNumbers(customerId),
    staleTime: NUMBERS_STALE_MS,
    enabled,
  });
}
