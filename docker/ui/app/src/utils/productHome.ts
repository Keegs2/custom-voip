import type { User } from '../types/auth';
import { API_CALLING_ENABLED } from '../config/features';

/**
 * The signed-in home for a user — the page for the product they
 * purchased. The public landing page (`/`) is never shown to
 * authenticated users; DashboardPage redirects here instead.
 *
 * `effectiveAdmin` must be the customerViewMode-aware `isAdmin` from
 * AuthContext, NOT `user.role === 'admin'`: an admin previewing the
 * app in customer view must land on the customer product page, or the
 * `/` → home → RequireAdmin → `/` redirects loop forever.
 *
 * Admins land on `/cdrs` (CDR Search) — platform + customer administration
 * moved to TED (the CRAG console), so the revup `/admin` tree no longer
 * exists; sending admins to `/admin` here would loop forever.
 *
 * `api` accounts: API Calling is retired (API_CALLING_ENABLED=false), so they
 * land on My Account instead of the disabled /api-dids page (which itself
 * redirects here — pointing it back at /api-dids would loop).
 */
export function productHome(user: User | null, effectiveAdmin: boolean): string {
  if (!user) return '/rcf';
  if (effectiveAdmin) return '/cdrs';
  if (user.role === 'support') return '/troubleshooting';
  if (user.role === 'readonly') return '/call-quality';
  switch (user.account_type) {
    case 'trunk':
      return '/trunks';
    case 'api':
      return API_CALLING_ENABLED ? '/api-dids' : '/my-account';
    case 'rcf':
    case 'hybrid':
    case 'ucaas':
    default:
      return '/rcf';
  }
}
