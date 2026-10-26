/**
 * myAccountData.ts — server state for My Account (/my-account), one hook per
 * feed, for the two ways the page can be looked at:
 *
 *   scope      who                                     reads
 *   ─────────  ──────────────────────────────────────  ─────────────────────────────────────────
 *   self       a tenant (and staff with no customer —   GET /customers/me, /customers/me/billing,
 *              /customers/me 404s → "No customer")     /auth/team, /rcf, /trunks (self-scoped)
 *   staff      an admin in "View as Customer" with a    GET /customers/{id} (identity fields only)
 *              preview customer picked (§4: the admin   + /reports/my-numbers?customer_id (counts)
 *              is still STAFF to the API, customer_id   + /trunks?customer_id, /customers/{id}/billing,
 *              null — self endpoints would describe     /search/user/by-customer/{id},
 *              the admin, not the preview)              /rcf?customer_id
 *
 * Tenant query keys are the ones this page always used (['my-customer'],
 * ['my-billing'], ['my-team'], ['my-account-rcf'], ['my-account-trunks']),
 * so invalidations elsewhere still reach them. Staff keys add the customer,
 * so a preview never lands in (or reads) a tenant cache entry. The staff
 * team shares the dashboard's ['dash-team', id] entry (same request).
 *
 * The admin customer row carries financials; `staffCustomer` copies identity
 * fields only.
 */
import { useQuery } from '@tanstack/react-query';
import { getCustomerBilling, getMyBilling, getMyCustomer, listCustomerTeam, listMyTeam } from '../../api/account';
import { getCustomer } from '../../api/customers';
import { getMyNumbers } from '../../api/reports';
import { listRcf } from '../../api/rcf';
import { listTrunks } from '../../api/trunks';
import { countByProduct, isProductHidden } from '../../config/products';
import type { MyCustomer } from '../../types/account';

/** Whose account the page describes. */
export type AccountScope = { kind: 'self' } | { kind: 'staff'; customerId: number };

export const SELF_SCOPE: AccountScope = { kind: 'self' };

/** The customer id a staff scope is about, else undefined (self-scoped endpoints). */
export function scopedCustomerId(scope: AccountScope): number | undefined {
  return scope.kind === 'staff' ? scope.customerId : undefined;
}

/**
 * A preview customer in the shape of GET /customers/me: identity from the
 * admin row (never its financial columns), counts from the every-product
 * numbers list and the trunk list. A failed numbers list leaves
 * `counts.numbers` absent (the page then shows the per-product counts) and
 * falls back to the /rcf list for the call forwarding count.
 */
async function staffCustomer(customerId: number): Promise<MyCustomer> {
  const [row, numbers, trunks] = await Promise.all([
    getCustomer(customerId),
    getMyNumbers(customerId).catch(() => null),
    listTrunks({ customer_id: customerId, limit: 200 }).catch(() => null),
  ]);
  const products = (numbers?.numbers ?? []).map((n) => n.product).filter((p) => !isProductHidden(p));
  const byProduct = countByProduct(products);
  const rcf = numbers
    ? (byProduct.rcf ?? 0)
    : ((await listRcf({ customer_id: customerId }).catch(() => null))?.items.length ?? 0);
  return {
    id: row.id,
    name: row.name,
    account_type: row.account_type,
    status: row.status,
    daily_limit: null,
    cpm_limit: null,
    ucaas_enabled: row.ucaas_enabled,
    created_at: row.created_at,
    counts: {
      rcf,
      api_dids: 0,
      trunks: trunks?.items.length ?? 0,
      numbers: numbers ? { total: products.length, by_product: byProduct } : undefined,
    },
  };
}

/** The account record + product counts. Self: 404 = the login has no customer. */
export function useAccountRecord(scope: AccountScope) {
  return useQuery({
    queryKey: scope.kind === 'staff' ? ['my-customer', 'staff', scope.customerId] : ['my-customer'],
    queryFn: () => (scope.kind === 'staff' ? staffCustomer(scope.customerId) : getMyCustomer()),
    retry: false,
  });
}

/** The read-only estimated monthly bill. */
export function useAccountBilling(scope: AccountScope) {
  return useQuery({
    queryKey: scope.kind === 'staff' ? ['my-billing', 'staff', scope.customerId] : ['my-billing'],
    queryFn: () => (scope.kind === 'staff' ? getCustomerBilling(scope.customerId) : getMyBilling()),
    retry: false,
  });
}

/** Everyone who can sign in to the account (staff preview: `is_self` is always false). */
export function useAccountTeamList(scope: AccountScope) {
  return useQuery({
    queryKey: scope.kind === 'staff' ? ['dash-team', scope.customerId] : ['my-team'],
    queryFn: () => (scope.kind === 'staff' ? listCustomerTeam(scope.customerId) : listMyTeam()),
  });
}

/** The account's call forwarding numbers (GET /rcf — at most 100 rows). */
export function useAccountRcfList(scope: AccountScope) {
  return useQuery({
    queryKey: scope.kind === 'staff' ? ['my-account-rcf', scope.customerId] : ['my-account-rcf'],
    // No customer_id for a tenant → the backend scopes to the logged-in customer.
    queryFn: () => listRcf(scope.kind === 'staff' ? { customer_id: scope.customerId } : {}),
  });
}

/** The account's SIP trunks. */
export function useAccountTrunkList(scope: AccountScope) {
  return useQuery({
    queryKey: scope.kind === 'staff' ? ['my-account-trunks', scope.customerId] : ['my-account-trunks'],
    queryFn: () => listTrunks(scope.kind === 'staff' ? { customer_id: scope.customerId } : {}),
  });
}
