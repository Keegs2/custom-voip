import { Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import type { ReactNode } from 'react';

interface RequireProgrammableVoiceProps {
  children: ReactNode;
}

/**
 * Guards the programmable-voice configuration surface (per-DID voice_url /
 * status_callback editor + webhook signing-secret panel). Programmable voice is an
 * `api` / `hybrid` product feature, so this guard is intentionally distinct from
 * `RequireUcaas`:
 *
 *   - `account_type === 'rcf'` fails every clause → an RCF customer can NEVER
 *     reach this route, even by typing the URL directly (CLAUDE.md /
 *     feedback_rcf_simplicity: RCF customers see ZERO of this surface).
 *   - admins are allowed so support/operators can configure on a customer's
 *     behalf (and only admins can read/rotate the webhook secret server-side).
 *   - `api` and `hybrid` accounts are allowed — these are the programmable-voice
 *     products.
 *
 * Mirrors the same predicate used by the sidebar nav gating in `Sidebar.tsx`,
 * keeping the route guard and nav visibility in lockstep.
 */
export function RequireProgrammableVoice({ children }: RequireProgrammableVoiceProps) {
  const { user } = useAuth();

  const hasProgrammableVoice =
    user?.role === 'admin' ||
    user?.account_type === 'api' ||
    user?.account_type === 'hybrid';

  if (!hasProgrammableVoice) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
