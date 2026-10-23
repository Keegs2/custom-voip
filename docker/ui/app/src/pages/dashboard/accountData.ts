/**
 * accountData.ts — server state for the customer-facing account views (the
 * /dashboard cards and the customer /rcf numbers page), one hook per feed,
 * plus the small pure helpers they share.
 *
 * Every hook takes a `DashboardScope`: the account being viewed and whether
 * the VIEWER is staff. Tenants read the self-scoped endpoints; an admin
 * previewing a customer in "View as Customer" mode is still staff to the
 * API, so the self-scoped endpoints would describe the admin (no account) or
 * the whole platform — those feeds switch to the admin equivalents:
 *
 *   feed            tenant                         staff preview
 *   ─────────────   ────────────────────────────   ──────────────────────────────────
 *   account         GET /customers/me               GET /customers/{id} (fields picked)
 *   all numbers     GET /reports/my-numbers         same + customer_id (required for staff)
 *   rcf numbers     GET /rcf?customer_id            same (param ignored for tenants)
 *   activity (7d)   GET /cdrs/activity?customer_id  same      (product_type=all)
 *   per-number 7d   GET /reports/numbers            same + customer_id (required for staff)
 *   recent calls    GET /cdrs?customer_id           same      (no product filter)
 *   team            GET /auth/team                  GET /search/user/by-customer/{id}
 *   number requests GET /numbers/my                 GET /numbers/inventory?customer_id
 *
 * "The account's numbers" are EVERY product's numbers (call forwarding,
 * voicemail, SIP trunk, any future product): the product-agnostic list from
 * /reports/my-numbers — the same list the Reporting picker shows — merged
 * with the editable /rcf entries (`toNumberRows`). If that list fails, or an
 * older API answers without `enabled`, the rows are the /rcf entries alone,
 * exactly as before. Call feeds cover every product on the account too.
 *
 * Query keys share prefixes with the rest of the console so existing
 * mutations keep these fresh: RowEditor invalidates ['rcf'], DID management
 * invalidates ['my-dids'], My Account shares ['my-customer'] / ['my-team'],
 * voicemail mailbox create/delete/suspend call `invalidateAccountNumbers`.
 * Staff keys add a discriminator so a differently-shaped (or differently
 * scoped) response never lands in a tenant cache entry; feeds whose product
 * scope changed (rcf → all products) changed key, so no cache mixes them.
 *
 * Redaction: nothing here carries money to the UI. The admin customer row
 * includes financial columns; `toSummary` copies only identity fields.
 */
import { useRef } from 'react';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { getMyCustomer, listCustomerTeam, listMyTeam } from '../../api/account';
import { getCustomer } from '../../api/customers';
import { listRcf } from '../../api/rcf';
import { getCdrActivity, isTimeZoneRejection, searchCdrs } from '../../api/cdrs';
import { getMyNumbers, getReportNumbers } from '../../api/reports';
import { listCustomerInventory, listMyDids } from '../../api/didInventory';
import { ApiError } from '../../api/client';
import { countByProduct, isProductHidden, productMix, type ProductCount } from '../../config/products';
import type { AccountType, CustomerStatus } from '../../types/customer';
import type { CdrActivityResponse } from '../../types/cdrActivity';
import type { RcfEntry } from '../../types/rcf';
import type { MyNumbers, ReportNumberRow, ReportNumbers } from '../../types/reports';
import { BAD, GOOD, WARN } from '../calls/quality';

/** GET /rcf returns at most this many rows (server-side LIMIT). */
export const RCF_LIST_CAP = 100;

/** Which account a view is about, and how the viewer is allowed to read it. */
export interface DashboardScope {
  customerId: number;
  /** True for an admin previewing a customer (staff token). */
  staff: boolean;
}

/** The identity fields every account view shows — never financials. */
export interface AccountSummary {
  id: number;
  name: string;
  account_type: AccountType;
  status: CustomerStatus;
  created_at: string | null;
  /** Numbers on the account per the API, or null when the source has no count. */
  rcfCount: number | null;
}

interface SummarySource {
  id: number;
  name: string;
  account_type: AccountType;
  status: CustomerStatus;
  created_at: string | null;
}

function toSummary(c: SummarySource, rcfCount: number | null): AccountSummary {
  return {
    id: c.id,
    name: c.name,
    account_type: c.account_type,
    status: c.status,
    created_at: c.created_at ?? null,
    rcfCount,
  };
}

export function useAccountSummary({ customerId, staff }: DashboardScope) {
  return useQuery({
    // Tenant key sits under My Account's ['my-customer'] prefix (so its
    // invalidations reach it) but is suffixed: My Account caches the raw
    // MyCustomer there, this entry caches the mapped summary.
    queryKey: staff ? ['dash-customer', customerId] : ['my-customer', 'summary'],
    queryFn: async (): Promise<AccountSummary> => {
      if (staff) return toSummary(await getCustomer(customerId), null);
      const me = await getMyCustomer();
      return toSummary(me, typeof me.counts?.rcf === 'number' ? me.counts.rcf : null);
    },
    retry: false,
  });
}

/** The account's call forwarding entries (GET /rcf) — the editable rows. */
export function useAccountNumbers(customerId: number) {
  return useQuery({
    queryKey: ['rcf', customerId, 'dashboard'],
    queryFn: () => listRcf({ customer_id: customerId, limit: 500 }),
  });
}

/** Root of the account-wide (every product) number list cache. */
export const ACCOUNT_NUMBERS_KEY = ['account-numbers'] as const;

/**
 * Every number on the account, any product (GET /reports/my-numbers — the
 * list the Reporting picker shows too). Tenants are self-scoped; staff
 * (admin one-customer view, "View as Customer") must send the customer.
 * One quiet attempt: on failure the dashboard falls back to the /rcf rows.
 */
export function useAccountAllNumbers({ customerId, staff }: DashboardScope) {
  return useQuery({
    queryKey: [...ACCOUNT_NUMBERS_KEY, customerId, staff ? 'staff' : 'self'],
    queryFn: () => getMyNumbers(staff ? customerId : undefined),
    retry: false,
    staleTime: 60_000,
  });
}

/**
 * Refresh every cached "account's numbers" list — the dashboard's and the
 * Reporting picker's. Call after anything that adds, removes or switches a
 * number outside the /rcf editor (voicemail mailbox create / delete /
 * suspend / resume / relabel). NOT part of invalidateVoicemail(), which runs
 * after every message action.
 */
export function invalidateAccountNumbers(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ACCOUNT_NUMBERS_KEY });
  void queryClient.invalidateQueries({ queryKey: ['reports', 'my-numbers'] });
}

/**
 * Runs `fetcher` in the browser's zone; if the API refuses the zone itself
 * (422 on tz — a zone newer than the server's tzdata) it retries once in UTC
 * and latches UTC for later fetches. Same policy as CallActivityTab.
 */
function useTzFallback() {
  const rejectedRef = useRef(false);
  return async function run<T>(
    tz: string,
    fetcher: (zone: string) => Promise<T>,
    isZoneError: (err: unknown) => boolean,
  ): Promise<T> {
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

/**
 * The last 7 days of calls on EVERY product (`product_type=all` — the
 * activity endpoint's default is rcf only). `customerId` null = every
 * customer (staff only — the admin dashboard's All customers view); tenants
 * are hard-scoped by the API either way.
 */
export function useWeekActivity(customerId: number | null, tz: string) {
  const run = useTzFallback();
  return useQuery({
    queryKey: ['dash-activity', 'all-products', customerId ?? 'all', tz],
    queryFn: (): Promise<CdrActivityResponse> =>
      run(
        tz,
        (zone) =>
          getCdrActivity({ range: '7d', tz: zone, customer_id: customerId ?? undefined, product_type: 'all' }),
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

/** How many calls the Recent calls card lists. */
export const RECENT_CALLS = 6;

/** The newest calls on the account's numbers in the last 7 days, every
 *  product — GET /cdrs with no product filter (`customerId` null = every
 *  customer, staff only). */
export function useRecentCalls(customerId: number | null) {
  return useQuery({
    queryKey: ['dash-recent-calls', 'all-products', customerId ?? 'all'],
    queryFn: () => {
      const end = new Date();
      const start = new Date(end.getTime() - 7 * 24 * 3_600_000);
      return searchCdrs({
        customer_id: customerId ?? undefined,
        start_date: start.toISOString(),
        end_date: end.toISOString(),
        limit: RECENT_CALLS,
      });
    },
    staleTime: 60_000,
  });
}

export function useAccountTeam({ customerId, staff }: DashboardScope) {
  return useQuery({
    queryKey: staff ? ['dash-team', customerId] : ['my-team'],
    queryFn: () => (staff ? listCustomerTeam(customerId) : listMyTeam()),
  });
}

export function useAccountDids({ customerId, staff }: DashboardScope) {
  return useQuery({
    // Under the ['my-dids'] prefix so request/release mutations refresh it;
    // the staff entry is suffixed because its queryFn differs from the one
    // DIDManagementTab registers on ['my-dids', id].
    queryKey: staff ? ['my-dids', customerId, 'inventory'] : ['my-dids', customerId],
    queryFn: () => (staff ? listCustomerInventory(customerId) : listMyDids()),
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

// ─── Derived shapes ──────────────────────────────────────────────────────────

/** One of the account's numbers as the dashboard lists it — any product. */
export interface NumberRow {
  /** E.164, as the API lists it. */
  number: string;
  /** Customer-safe label (rcf name, mailbox label, trunk name), or null. */
  name: string | null;
  /** Product id (config/products.ts). */
  product: string;
  /** Switched on: forwarding / taking messages / trunk active. */
  enabled: boolean;
  /** rcf only — where calls ring today. */
  forwardsTo: string | null;
  /** rcf only — the editable /rcf entry; null past the /rcf list cap (read-only row). */
  rcf: RcfEntry | null;
  /** Where selecting the row leads (voicemail → its page), or null. */
  href: string | null;
}

export interface NumberRows {
  rows: NumberRow[];
  /** 'all' = the every-product list; 'rcf' = the /rcf entries alone (fallback). */
  source: 'all' | 'rcf';
}

/**
 * True when GET /reports/my-numbers answered in the holistic shape (every
 * row carries a boolean `enabled`). An older API lists rcf + trunk numbers
 * without it — the dashboard then keeps its call-forwarding-only view.
 */
export function isHolisticNumbers(data: MyNumbers | undefined): data is MyNumbers {
  return (
    data !== undefined &&
    Array.isArray(data.numbers) &&
    data.numbers.every((n) => n != null && typeof n.number === 'string' && typeof n.enabled === 'boolean')
  );
}

function rcfRow(entry: RcfEntry): NumberRow {
  return {
    number: entry.did,
    name: entry.name ?? null,
    product: 'rcf',
    enabled: entry.enabled,
    forwardsTo: entry.forward_to,
    rcf: entry,
    href: null,
  };
}

/**
 * Merges the every-product list with the editable /rcf entries:
 *  - an rcf number takes its /rcf entry (fresh after RowEditor saves, so
 *    the row and the KPIs follow an edit at once); past the 100-row /rcf
 *    cap it stays a read-only row from the list;
 *  - other products come from the list (`voicemailHref` makes mailbox rows
 *    links; other products are plain rows);
 *  - an /rcf entry the cached list doesn't have yet is still shown;
 *  - hidden products (retired API Calling) never appear.
 * Without a usable list (failed, loading, or an older API) the rows are the
 * /rcf entries alone — today's view.
 *
 * Example: list [{+1617…, rcf}, {+1508…, voicemail}] + /rcf [{+1617…}]
 *   → [rcf row with its entry, voicemail row linking to voicemailHref]
 */
export function toNumberRows(
  myNumbers: MyNumbers | undefined,
  rcfEntries: readonly RcfEntry[],
  { voicemailHref }: { voicemailHref: string | null },
): NumberRows {
  if (!isHolisticNumbers(myNumbers)) return { source: 'rcf', rows: rcfEntries.map(rcfRow) };

  const entries = new Map(rcfEntries.map((e) => [numberKey(e.did), e]));
  const seen = new Set<string>();
  const rows: NumberRow[] = [];
  for (const n of myNumbers.numbers) {
    if (isProductHidden(n.product)) continue;
    const key = numberKey(n.number);
    if (seen.has(key)) continue; // the API de-duplicates; belt and braces
    seen.add(key);
    if (n.product === 'rcf') {
      const entry = entries.get(key);
      rows.push(
        entry
          ? rcfRow(entry)
          : {
              number: n.number,
              name: n.name ?? null,
              product: 'rcf',
              enabled: n.enabled === true,
              forwardsTo: n.forwards_to ?? null,
              rcf: null,
              href: null,
            },
      );
    } else {
      rows.push({
        number: n.number,
        name: n.name ?? null,
        product: n.product,
        enabled: n.enabled === true,
        forwardsTo: null,
        rcf: null,
        href: n.product === 'voicemail' ? voicemailHref : null,
      });
    }
  }
  for (const entry of rcfEntries) {
    const key = numberKey(entry.did);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(rcfRow(entry));
  }
  return { source: 'all', rows };
}

/** The rows' product mix, visible products only, in catalog order. */
export function numberMix(rows: readonly NumberRow[]): ProductCount[] {
  return productMix(countByProduct(rows.map((r) => r.product)));
}

/** A feed's state as a card needs it. */
export type Feed<T> =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; value: T };

/** Per-number weekly figures (GET /reports/numbers), or why they're absent. */
export type NumberStats =
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'ready'; byNumber: ReadonlyMap<string, ReportNumberRow> };

/**
 * Shape-guarded: per-number figures are an enhancement, so anything
 * unexpected degrades to "unavailable" instead of breaking a table.
 */
export function toNumberStats(data: ReportNumbers | undefined, isError: boolean): NumberStats {
  const rows = data?.numbers;
  if (Array.isArray(rows)) {
    const byNumber = new Map<string, ReportNumberRow>();
    for (const row of rows) {
      if (row && typeof row.number === 'string') byNumber.set(numberKey(row.number), row);
    }
    return { state: 'ready', byNumber };
  }
  if (data || isError) return { state: 'unavailable' };
  return { state: 'loading' };
}

/** The word for a good-share tone — mapped from the colour quality.ts's
 *  goodShareColor picks, so the thresholds live in exactly one place. */
export function shareWord(color: string): string | null {
  if (color === GOOD) return 'Healthy';
  if (color === WARN) return 'Worth a look';
  if (color === BAD) return 'Needs attention';
  return null;
}
