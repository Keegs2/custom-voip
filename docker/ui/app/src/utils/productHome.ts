import type { User } from '../types/auth';

/**
 * The signed-in home for a user — the page for the product they
 * purchased. The public landing page (`/`) is never shown to
 * authenticated users; DashboardPage redirects here instead.
 *
 * `effectiveAdmin` must be the customerViewMode-aware `isAdmin` from
 * AuthContext, NOT `user.role === 'admin'`: an admin previewing the
 * app in customer view must land on the customer product page, or the
 * `/` → `/admin` → RequireAdmin → `/` redirects loop forever.
 */
export function productHome(user: User | null, effectiveAdmin: boolean): string {
  if (!user) return '/rcf';
  if (effectiveAdmin) return '/admin';
  if (user.role === 'support') return '/troubleshooting';
  if (user.role === 'readonly') return '/call-quality';
  switch (user.account_type) {
    case 'trunk':
      return '/trunks';
    case 'api':
      return '/api-dids';
    case 'rcf':
    case 'hybrid':
    case 'ucaas':
    default:
      return '/rcf';
  }
}
