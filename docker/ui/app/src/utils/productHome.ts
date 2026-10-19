import type { User } from '../types/auth';
import { API_CALLING_ENABLED } from '../config/features';

/**
 * The signed-in home for a user. The public landing page (`/`) is never
 * shown to authenticated users; DashboardPage redirects here instead.
 *
 * `effectiveAdmin` must be the customerViewMode-aware `isAdmin` from
 * AuthContext, NOT `user.role === 'admin'`: an admin previewing the app in
 * customer view must land on the customer home, or the `/` → home →
 * RequireAdmin → `/` redirects loop forever.
 *
 * - Admins land on `/cdrs` (CDR Search) — platform + customer administration
 *   lives in TED, so there is no revup `/admin` to send them to.
 * - Support lands on `/troubleshooting`.
 * - Customers (rcf / hybrid / ucaas / unknown type) land on the account
 *   `/dashboard` — readonly users too (it is read-only for them: RowEditor
 *   and number requests are gated on role). An admin in customer view is
 *   "a customer" here; the dashboard asks them to pick a preview customer.
 * - `trunk` accounts keep `/trunks`; `api` accounts (API Calling retired,
 *   API_CALLING_ENABLED=false) land on My Account instead of the disabled
 *   /api-dids page (which itself redirects here — pointing it back at
 *   /api-dids would loop).
 * - A tenant login with no customer account has no dashboard to show (it
 *   would redirect back here and loop), so it lands on My Account.
 */
export function productHome(user: User | null, effectiveAdmin: boolean): string {
  if (!user) return '/rcf';
  if (effectiveAdmin) return '/cdrs';
  if (user.role === 'support') return '/troubleshooting';
  const hasAccount = user.customer_id != null || user.role === 'admin';
  if (!hasAccount) return '/my-account';
  switch (user.account_type) {
    case 'trunk':
      return '/trunks';
    case 'api':
      return API_CALLING_ENABLED ? '/api-dids' : '/my-account';
    case 'rcf':
    case 'hybrid':
    case 'ucaas':
    default:
      return '/dashboard';
  }
}
