import { apiRequest } from './client';
import type { MyCustomer, TeamMember } from '../types/account';

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
 * List the user accounts associated with the caller's customer account.
 *
 * `GET /auth/team` — returns every teammate on the same customer, with the
 * requesting user flagged via `is_self`.
 */
export async function listMyTeam(): Promise<TeamMember[]> {
  return apiRequest<TeamMember[]>('GET', '/auth/team');
}
