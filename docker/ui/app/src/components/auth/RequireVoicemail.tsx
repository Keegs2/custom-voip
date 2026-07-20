import { Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/useAuth';
import { voicemailEntitled } from './entitlements';
import type { ReactNode } from 'react';

interface RequireVoicemailProps {
  children: ReactNode;
}

/**
 * Guards /voicemail — the standalone Visual Voicemail product.
 *
 * Predicate: `voicemail_enabled === true || hasUcaas` via the SHARED
 * `voicemailEntitled` predicate (components/auth/entitlements.ts), the same
 * source of truth the Sidebar's nav gate derives from. This closes the 2026-07
 * audit blocker where the nav showed Voicemail for `voicemail_enabled`
 * customers while the route (then wrapped in RequireUcaas, which never checks
 * `voicemail_enabled`) bounced them to the dashboard.
 *
 *   - A voicemail-only customer (`voicemail_enabled === true`, ANY account
 *     type) gets in — this is the product's flagship persona.
 *   - UCaaS-entitled accounts and admins keep access, exactly as before.
 *   - An `rcf` user with NEITHER flag is still redirected — RCF isolation
 *     preserved (CLAUDE.md: RCF customers never see UCaaS surfaces).
 *
 * Must be rendered inside RequireAuth. Uses the raw role for the admin bypass,
 * matching RequireUcaas/RequireAdmin route-guard behaviour.
 */
export function RequireVoicemail({ children }: RequireVoicemailProps) {
  const { user } = useAuth();

  if (!voicemailEntitled(user, user?.role === 'admin')) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
