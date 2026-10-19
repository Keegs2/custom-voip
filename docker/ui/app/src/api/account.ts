import { apiRequest } from './client';
import type { BillingEstimate, MyCustomer, TeamMember } from '../types/account';

/**
 * Fetch the authenticated caller's own customer account summary.
 *
 * `GET /customers/me` — the backend scopes the response to the logged-in
 * customer. Throws `ApiError(404)` when the caller has no associated customer
 * (e.g. a platform admin with no customer_id); callers should handle that
 * case gracefully rather than treating it as a hard error.
 */
export async function getMyCustomer(): Promise<MyCustomer> {
  return apiRequest<MyCustomer>('GET', '/customers/me');
}

/**
 * Fetch the authenticated caller's estimated monthly bill.
 *
 * `GET /customers/me/billing` — a READ-ONLY estimate derived from the
 * customer's provisioned products. Real rating/invoicing happens in the
 * external system (Equinox); this is guidance only. Like `getMyCustomer`,
 * this throws `ApiError(404)` when the caller has no associated customer.
 */
export async function getMyBilling(): Promise<BillingEstimate> {
  return apiRequest<BillingEstimate>('GET', '/customers/me/billing');
}

/**
 * Fetch a specific customer's estimated monthly bill (admin-only).
 *
 * `GET /customers/{id}/billing` — the admin counterpart to `getMyBilling`,
 * used by the customer 360 view to show the same read-only estimate.
 */
export async function getCustomerBilling(id: number): Promise<BillingEstimate> {
  return apiRequest<BillingEstimate>('GET', `/customers/${id}/billing`);
}

/**
 * List the user accounts associated with the caller's customer account.
 *
 * `GET /auth/team` — returns every teammate on the same customer, with the
 * requesting user flagged via `is_self`.
 */
export async function listMyTeam(): Promise<TeamMember[]> {
  return apiRequest<TeamMember[]>('GET', '/auth/team');
}

/** One row of the admin `GET /search/user/by-customer/{id}` listing. */
interface CustomerUserRow {
  id: number;
  name: string | null;
  email: string;
  role: string;
  status: string;
  last_login: string | null;
}

function isTeamRole(role: string): role is TeamMember['role'] {
  return role === 'admin' || role === 'user' || role === 'readonly';
}

/**
 * Staff counterpart of `listMyTeam` for ONE customer (admin only) — used when
 * an admin previews a customer in "View as Customer" mode, where `/auth/team`
 * would return the admin's own (empty) team.
 *
 * `GET /search/user/by-customer/{id}` → `{results, total, customer_id}`.
 * Mapped onto TeamMember: the row has no `created_at` (left empty) and the
 * viewer is never on the previewed account, so `is_self` is always false.
 * Roles outside the tenant set (none expected) read as view-only.
 */
export async function listCustomerTeam(customerId: number): Promise<TeamMember[]> {
  const raw = await apiRequest<{ results?: CustomerUserRow[] }>(
    'GET',
    `/search/user/by-customer/${customerId}?limit=500`,
  );
  return (raw.results ?? []).map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name ?? '',
    role: isTeamRole(r.role) ? r.role : 'readonly',
    status: r.status,
    created_at: '',
    last_login: r.last_login,
    is_self: false,
  }));
}
