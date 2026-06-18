import { Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import type { ReactNode } from 'react';

interface RequireUcaasProps {
  children: ReactNode;
}

/**
 * Guards UCaaS-only routes (communications, chat, conference, documents,
 * voicemail). Users without UCaaS entitlement are redirected to the dashboard
 * instead of rendering any UCaaS surface. This component must be rendered inside
 * RequireAuth so it can safely assume `user` is non-null.
 *
 * The `hasUcaas` predicate is the SAME one used by the sidebar nav
 * (`components/layout/Sidebar.tsx`) and the softphone widget
 * (`components/softphone/SoftphoneWidget.tsx`), keeping the route guard, the nav
 * visibility, and the softphone chrome in lockstep:
 *
 *   - `account_type === 'rcf'` fails every clause → an RCF customer can NEVER
 *     reach these routes, even by typing the URL directly. This enforces the
 *     hard rule (CLAUDE.md / feedback_rcf_simplicity): RCF customers see ZERO
 *     UCaaS surface.
 *   - admins are allowed (matching SoftphoneWidget, which renders the softphone
 *     for staff) so support can reach these pages.
 *   - `ucaas` accounts and any non-RCF account with `ucaas_enabled === true`
 *     (e.g. `hybrid`) are allowed.
 */
export function RequireUcaas({ children }: RequireUcaasProps) {
  const { user } = useAuth();

  const hasUcaas =
    user?.role === 'admin' ||
    user?.account_type === 'ucaas' ||
    (user?.account_type !== 'rcf' && user?.ucaas_enabled === true);

  if (!hasUcaas) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
