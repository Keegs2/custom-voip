import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { canSeeReporting } from '../../utils/reportingAccess';

/**
 * Guards /reporting (render inside RequireAuth). Support staff and accounts
 * without the Reporting product are sent to `/`, which forwards signed-in
 * users to their own product home.
 */
export function RequireReportingAccess({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (!canSeeReporting(user)) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}
