import { Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/useAuth';
import { ucaasEntitled } from './entitlements';
import type { ReactNode } from 'react';

interface RequireUcaasProps {
  children: ReactNode;
}

/**
 * Guards UCaaS-only routes (communications, chat, conference, documents,
 * live calls/recordings/queues/media streams). Users without UCaaS entitlement
 * are redirected to the dashboard instead of rendering any UCaaS surface. This
 * component must be rendered inside RequireAuth so it can safely assume `user`
 * is non-null. (/voicemail has its OWN guard — RequireVoicemail — because the
 * standalone Visual Voicemail entitlement is independent of UCaaS.)
 *
 * The predicate is the SHARED `ucaasEntitled` (components/auth/entitlements.ts)
 * — the same source of truth the sidebar nav gate derives from — keeping the
 * route guard and nav visibility in lockstep:
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

  if (!ucaasEntitled(user, user?.role === 'admin')) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
