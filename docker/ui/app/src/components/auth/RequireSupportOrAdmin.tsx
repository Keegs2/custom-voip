import { Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import type { ReactNode } from 'react';

interface RequireSupportOrAdminProps {
  children: ReactNode;
}

/**
 * Guards routes readable by platform staff: admins OR support users
 * (platform-wide read-only role). Everyone else is redirected to the
 * dashboard. Like RequireAdmin, this must be rendered inside RequireAuth so
 * it can safely assume `user` is non-null. Note isAdmin is the
 * customerViewMode-aware flag, so an admin previewing as a customer is
 * redirected too — matching RequireAdmin behavior.
 */
export function RequireSupportOrAdmin({ children }: RequireSupportOrAdminProps) {
  const { isAdmin, isSupport } = useAuth();

  if (!isAdmin && !isSupport) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
