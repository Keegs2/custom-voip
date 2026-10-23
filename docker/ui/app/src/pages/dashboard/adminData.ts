/**
 * adminData.ts — server state for the platform admin's dashboard (the
 * "All customers" view and the scope dropdown). Every endpoint here is
 * admin-only on the API; the hooks run only inside AdminDashboard, which
 * renders only for `isAdmin`.
 *
 *   feed               endpoint                                        notes
 *   ────────────────   ─────────────────────────────────────────────   ──────────────────────────────
 *   customers          GET /customers?limit=500                        shared ['customers-dropdown'] key
 *   owned numbers      GET /numbers/owned                              EVERY product's numbers, exact:
 *                                                                       platform + per-customer totals,
 *                                                                       per product, enabled counts
 *   rcf inventory      GET /numbers/inventory?product_type=rcf         FALLBACK only, when /numbers/owned
 *                          &limit=1000                                  fails (an older API): today's
 *                                                                       call-forwarding counts (cap → "at least")
 *   paused numbers     GET /rcf?enabled=false                          server LIMIT 100 → "100+" (Paused card)
 *   open requests      GET /numbers/inventory?status=reserved          + ?status=release_requested
 *   inventory stats    GET /numbers/stats                              pool / assigned / waiting / per product
 *
 * Platform-wide calls (GET /cdrs/activity and GET /cdrs without
 * customer_id) reuse accountData.ts's hooks with a null customer.
 *
 * What is deliberately NOT here: per-customer call counts and a
 * cross-customer "busiest numbers" list. The API has no cross-customer
 * per-number or per-customer call roll-up (/cdrs/summary groups by
 * day/hour/prefix; /reports/* are one-customer only), and fanning a report
 * query out per customer is not a dashboard-load cost worth paying.
 *
 * Redaction: the admin /customers rows carry financial columns
 * (balance, credit_limit, …). Nothing below copies them — `toCustomerRow`
 * picks identity fields only, so the dashboard stays money-free.
 */
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../../api/client';
import { listCustomers } from '../../api/customers';
import { listRcf } from '../../api/rcf';
import { isProductHidden, productMix, type ProductCount } from '../../config/products';
import type { AccountType, CustomerStatus } from '../../types/customer';
import type { DidInventoryItem, DidStatus } from '../../types/didInventory';
import { DASHBOARD_PRODUCTS } from './products';

/** Rows asked of GET /numbers/inventory for the platform number count. */
export const INVENTORY_PAGE = 1000;

/** Account types that have the dashboard's live product (call forwarding). */
const RCF_TYPES: readonly AccountType[] = DASHBOARD_PRODUCTS.find((p) => p.id === 'rcf')?.accountTypes ?? ['rcf'];

export function hasCallForwarding(type: AccountType | null | undefined): boolean {
  return RCF_TYPES.includes(type ?? 'rcf');
}

/** One customer as the admin dashboard shows it — identity only, no money. */
export interface CustomerRow {
  id: number;
  name: string;
  account_type: AccountType;
  status: CustomerStatus;
  created_at: string | null;
}

interface CustomerSource {
  id: number;
  name: string;
  account_type: AccountType;
  status: CustomerStatus;
  created_at?: string | null;
}

function toCustomerRow(c: CustomerSource): CustomerRow {
  return { id: c.id, name: c.name, account_type: c.account_type, status: c.status, created_at: c.created_at ?? null };
}

// Module-level so React Query memoises the mapped list across renders.
function selectCustomerRows(data: { items: CustomerSource[] }): CustomerRow[] {
  return data.items.map(toCustomerRow).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every customer, sorted by name. Shares the ['customers-dropdown'] cache
 * entry (raw list) with the console scope select and the preview picker;
 * `select` maps it so no financial field reaches a component.
 */
export function useAdminCustomers(enabled = true) {
  return useQuery({
    queryKey: ['customers-dropdown'],
    queryFn: () => listCustomers({ limit: 500 }),
    enabled,
    staleTime: 60_000,
    select: selectCustomerRows,
  });
}

export interface InventoryPage {
  items: DidInventoryItem[];
  total: number;
}

async function getInventory(params: Record<string, string>): Promise<InventoryPage> {
  const qs = new URLSearchParams(params);
  const raw = await apiRequest<DidInventoryItem[] | { items?: DidInventoryItem[]; total?: number }>(
    'GET',
    `/numbers/inventory?${qs.toString()}`,
  );
  if (Array.isArray(raw)) return { items: raw, total: raw.length };
  const items = raw.items ?? [];
  return { items, total: typeof raw.total === 'number' ? raw.total : items.length };
}

/**
 * Every call forwarding number in the platform inventory (first 1,000 rows +
 * exact total). The fallback source for the platform number counts — runs
 * only when `enabled` (GET /numbers/owned is unavailable).
 */
export function useRcfInventory(enabled = true) {
  return useQuery({
    queryKey: ['admin-dash', 'rcf-inventory'],
    queryFn: () => getInventory({ product_type: 'rcf', limit: String(INVENTORY_PAGE) }),
    staleTime: 60_000,
    enabled,
  });
}

// ─── Owned numbers (every product) ───────────────────────────────────────────

/** A count of numbers and how many of them are switched on. */
export interface OwnedCounts {
  total: number;
  enabled: number;
}

export interface OwnedCustomerNumbers extends OwnedCounts {
  customer_id: number;
  by_product: Record<string, OwnedCounts>;
}

/** GET /numbers/owned — every customer's numbers, any product (admin only). */
export interface OwnedNumbers extends OwnedCounts {
  by_product: Record<string, OwnedCounts>;
  customers: OwnedCustomerNumbers[];
}

function isCounts(v: unknown): v is OwnedCounts {
  return typeof v === 'object' && v !== null && typeof (v as OwnedCounts).total === 'number';
}

/** Shape guard: an unexpected body degrades to the inventory fallback, never a broken card. */
export function isOwnedNumbers(v: unknown): v is OwnedNumbers {
  if (!isCounts(v)) return false;
  const o = v as OwnedNumbers;
  return typeof o.by_product === 'object' && o.by_product !== null && Array.isArray(o.customers);
}

/** Every number on every customer's account, exact, per product (GET /numbers/owned). */
export function useOwnedNumbers() {
  return useQuery({
    queryKey: ['admin-dash', 'owned-numbers'],
    queryFn: () => apiRequest<OwnedNumbers>('GET', '/numbers/owned'),
    staleTime: 60_000,
    // An older API answers 404 — fall back at once instead of retrying.
    retry: false,
  });
}

/** Statuses that mean "the number is on a customer's account" (not merely requested). */
const ON_ACCOUNT: ReadonlySet<DidStatus> = new Set<DidStatus>([
  'assigned',
  'release_requested',
  'suspended',
  'porting_in',
  'porting_out',
]);

export interface PlatformNumberCounts {
  /** Numbers on any customer's account. */
  total: number;
  byCustomer: ReadonlyMap<number, number>;
  /** The inventory had more rows than one page — counts are "at least". */
  partial: boolean;
  /** Exact source (/numbers/owned) only: platform numbers per product, catalog order. */
  mix?: readonly ProductCount[];
  /** Exact source only: each customer's numbers per product. */
  mixByCustomer?: ReadonlyMap<number, readonly ProductCount[]>;
  /** Exact source only: call forwarding numbers on / off, platform-wide. */
  rcf?: { forwarding: number; paused: number };
  /** Exact source only: each customer's paused call forwarding numbers. */
  pausedByCustomer?: ReadonlyMap<number, number>;
}

/** Visible products' totals (the API already hides `api`; the UI hides it too). */
function visibleTotals(byProduct: Record<string, OwnedCounts>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [product, c] of Object.entries(byProduct)) {
    if (!isProductHidden(product) && isCounts(c)) out[product] = c.total;
  }
  return out;
}

function sum(values: Iterable<number>): number {
  let n = 0;
  for (const v of values) n += v;
  return n;
}

/** /numbers/owned → the dashboard's platform counts (exact, every product). */
export function ownedToPlatformCounts(owned: OwnedNumbers): PlatformNumberCounts {
  const byCustomer = new Map<number, number>();
  const mixByCustomer = new Map<number, readonly ProductCount[]>();
  const pausedByCustomer = new Map<number, number>();
  for (const c of owned.customers) {
    if (!c || typeof c.customer_id !== 'number' || typeof c.by_product !== 'object' || c.by_product === null) continue;
    const totals = visibleTotals(c.by_product);
    byCustomer.set(c.customer_id, sum(Object.values(totals)));
    mixByCustomer.set(c.customer_id, productMix(totals));
    const rcf = c.by_product.rcf;
    if (isCounts(rcf)) pausedByCustomer.set(c.customer_id, Math.max(0, rcf.total - (rcf.enabled ?? 0)));
  }
  const totals = visibleTotals(owned.by_product);
  const rcf = owned.by_product.rcf;
  const rcfTotal = isCounts(rcf) ? rcf.total : 0;
  const rcfOn = isCounts(rcf) ? Math.min(rcf.enabled ?? 0, rcfTotal) : 0;
  return {
    total: sum(Object.values(totals)),
    byCustomer,
    partial: false,
    mix: productMix(totals),
    mixByCustomer,
    rcf: { forwarding: rcfOn, paused: rcfTotal - rcfOn },
    pausedByCustomer,
  };
}

/** Fallback: today's call-forwarding counts from the inventory page. */
export function toPlatformNumberCounts(page: InventoryPage): PlatformNumberCounts {
  const byCustomer = new Map<number, number>();
  let total = 0;
  for (const d of page.items) {
    if (!ON_ACCOUNT.has(d.status)) continue;
    total += 1;
    if (d.customer_id != null) byCustomer.set(d.customer_id, (byCustomer.get(d.customer_id) ?? 0) + 1);
  }
  return { total, byCustomer, partial: page.total > page.items.length };
}

/** RCF server cap: GET /rcf returns at most this many rows. */
export const PAUSED_CAP = 100;

/** Numbers that are not forwarding right now, across every customer. */
export function usePausedNumbers() {
  return useQuery({
    queryKey: ['rcf', 'all', 'paused'],
    queryFn: () => listRcf({ enabled: false }),
    staleTime: 60_000,
  });
}

/** Open number requests across customers — the admin's to-do list. */
export function useOpenRequests() {
  return useQuery({
    // Under ['my-dids'] so the DID-management mutations refresh it too.
    queryKey: ['my-dids', 'all', 'open-requests'],
    queryFn: async (): Promise<DidInventoryItem[]> => {
      const [waiting, releasing] = await Promise.all([
        getInventory({ status: 'reserved', limit: '200' }),
        getInventory({ status: 'release_requested', limit: '200' }),
      ]);
      return [...waiting.items, ...releasing.items];
    },
    staleTime: 30_000,
  });
}

export interface InventoryStats {
  total: number;
  available: number;
  assigned: number;
  reserved: number;
  by_status?: Record<string, number>;
  by_product?: Record<string, number>;
}

export function useInventoryStats() {
  return useQuery({
    queryKey: ['admin-dash', 'number-stats'],
    queryFn: () => apiRequest<InventoryStats>('GET', '/numbers/stats'),
    staleTime: 60_000,
    retry: false,
  });
}
