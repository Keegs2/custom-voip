/**
 * Dashboard page logic hook.
 *
 * The Dashboard is a static navigation hub with no server state, so this hook is
 * thin: it surfaces the auth flag that drives the public/authenticated card
 * behaviour and the "Request Access" dispatch. Keeping it here (instead of inline
 * in the page) preserves the feature-folder separation of concerns and keeps the
 * page a pure composition surface.
 *
 * React #310: this is a custom hook — its internal hooks (`useAuth`,
 * `useCallback`) sit unconditionally at the top with no early return.
 */

import { useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';

export interface DashboardState {
  /** Whether a signed-in user is viewing the hub (drives card click behaviour). */
  isAuthenticated: boolean;
  /** Opens the global "Request Access" form (public-homepage CTA + product tiles). */
  openRequestAccess: () => void;
}

export function useDashboard(): DashboardState {
  const { isAuthenticated } = useAuth();

  const openRequestAccess = useCallback(() => {
    window.dispatchEvent(new Event('open-access-request'));
  }, []);

  return { isAuthenticated, openRequestAccess };
}
