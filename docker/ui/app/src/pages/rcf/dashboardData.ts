/**
 * dashboardData.ts — the customer RCF dashboard's server state, one hook per
 * feed, plus the small pure helpers the panels share.
 *
 * Feeds (all existing endpoints):
 *   - useMyCustomer       GET /customers/me        name, status, since, total numbers
 *   - useDashboardNumbers GET /rcf?customer_id     every number + forwarding state
 *   - useWeekActivity     GET /cdrs/activity 7d    calls, answer rate, quality share, daily bars
 *   - useWeekNumberStats  GET /reports/numbers     per-number calls / answer rate, 7 days
 *   - useTeam             GET /auth/team           users on the account
 *   - useMyDids           GET /numbers/my          pending requests / releases
 *
 * Query keys deliberately share prefixes with the rest of the console so the
 * existing mutations keep everything fresh: RowEditor invalidates ['rcf'],
 * DID management invalidates ['my-dids'], My Account shares ['my-customer']
 * and ['my-team'].
 *
 * `customerId` is always the viewer's own account. It is sent to the
 * tenant-scoped endpoints anyway: tenants are hard-scoped server-side (the
 * param is ignored), and an admin previewing customer view — who is still
 * staff to the API — would otherwise get platform-wide figures.
 */
import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getMyCustomer, listMyTeam } from '../../api/account';
import { listRcf } from '../../api/rcf';
import { getCdrActivity, isTimeZoneRejection } from '../../api/cdrs';
import { getReportNumbers } from '../../api/reports';
import { listMyDids } from '../../api/didInventory';
import { ApiError } from '../../api/client';
import type { CdrActivityResponse } from '../../types/cdrActivity';
import type { ReportNumbers } from '../../types/reports';

/** GET /rcf returns at most this many rows (server-side LIMIT). */
export const RCF_LIST_CAP = 100;

export function useMyCustomer() {
  return useQuery({
    queryKey: ['my-customer'],
    queryFn: getMyCustomer,
    retry: false,
  });
}

export function useDashboardNumbers(customerId: number) {
  return useQuery({
    queryKey: ['rcf', customerId, 'dashboard'],
    queryFn: () => listRcf({ customer_id: customerId, limit: 500 }),
  });
}

/**
 * Runs `fetcher` in the browser's zone; if the API refuses the zone itself
 * (422 on tz — a zone newer than the server's tzdata) it retries once in UTC
 * and latches UTC for later fetches. Same policy as CallActivityTab.
 */
function useTzFallback() {
  const rejectedRef = useRef(false);
  return async function run<T>(tz: string, fetcher: (zone: string) => Promise<T>, isZoneError: (err: unknown) => boolean): Promise<T> {
    if (!rejectedRef.current && tz !== 'UTC') {
      try {
        return await fetcher(tz);
      } catch (err) {
        if (!isZoneError(err)) throw err;
        rejectedRef.current = true;
      }
    }
    return fetcher('UTC');
  };
}

export function useWeekActivity(customerId: number, tz: string) {
  const run = useTzFallback();
  return useQuery({
    queryKey: ['rcf-dash-activity', customerId, tz],
    queryFn: (): Promise<CdrActivityResponse> =>
      run(
        tz,
        (zone) => getCdrActivity({ range: '7d', tz: zone, customer_id: customerId, product_type: 'rcf' }),
        isTimeZoneRejection,
      ),
    staleTime: 60_000,
  });
}

/** Local calendar date → `YYYY-MM-DD` (inlined rather than imported from
 *  reporting/reportFormat so the lazy Reporting chunk stays lazy). */
function localIsoDate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Reports API: an unknown zone is a plain 422 "unknown time zone". */
function isReportZoneRejection(err: unknown): boolean {
  return err instanceof ApiError && err.status === 422 && /time zone/i.test(err.message);
}

export function useWeekNumberStats(customerId: number, tz: string) {
  const run = useTzFallback();
  return useQuery({
    queryKey: ['rcf-dash-number-stats', customerId, tz],
    queryFn: (): Promise<ReportNumbers> => {
      const today = new Date();
      const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
      return run(
        tz,
        (zone) =>
          getReportNumbers({
            start: localIsoDate(start),
            end: localIsoDate(today),
            tz: zone,
            numbers: [],
            customer_id: customerId,
          }),
        isReportZoneRejection,
      );
    },
    staleTime: 60_000,
    // Per-row figures are an enhancement: one quiet attempt, no retry storm.
    retry: false,
  });
}

export function useTeam() {
  return useQuery({ queryKey: ['my-team'], queryFn: listMyTeam });
}

export function useMyDids(customerId: number) {
  return useQuery({
    // Same key as DIDManagementTab so request/release mutations refresh this.
    queryKey: ['my-dids', customerId],
    queryFn: () => listMyDids(),
    staleTime: 30_000,
  });
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** Formatting-insensitive key for matching the same number across feeds. */
export function numberKey(n: string): string {
  return n.replace(/\D/g, '').slice(-10);
}

/** "March 2026" — the month an ISO timestamp falls in, or null. */
export function fmtMonthYear(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  // UTC: account timestamps are stored at UTC midnight, so a local zone
  // west of UTC would otherwise report the previous month.
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** "just now" / "5 minutes ago" / "3 days ago" / "Mar 4, 2026" — or null.
 *  Reads as the tail of a sentence: `Signed in ${fmtRelative(...)}`. */
export function fmtRelative(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const diff = Math.max(0, nowMs - t);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} ${min === 1 ? 'minute' : 'minutes'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} ${hr === 1 ? 'hour' : 'hours'} ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} ${day === 1 ? 'day' : 'days'} ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Initials for an avatar: "Dana Whitfield" → "DW", "ops@x.com" → "O". */
export function initials(name: string | null | undefined, email: string): string {
  const source = (name ?? '').trim();
  if (source) {
    const parts = source.split(/\s+/).filter(Boolean);
    const first = parts[0]?.charAt(0) ?? '';
    const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
    return `${first}${last}`.toUpperCase();
  }
  return email.charAt(0).toUpperCase();
}
