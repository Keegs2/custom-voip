import { Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import type { ReactNode } from 'react';

interface RequireAdminProps {
  children: ReactNode;
}

/**
 * Guards admin-only routes. Non-admin authenticated users are redirected to
 * the dashboard. This component must be rendered inside RequireAuth so it can
 * safely assume `user` is non-null.
 */
export function RequireAdmin({ children }: RequireAdminProps) {
  const { isAdmin } = useAuth();

  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
