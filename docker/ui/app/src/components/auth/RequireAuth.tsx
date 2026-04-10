import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import type { ReactNode } from 'react';

interface RequireAuthProps {
  children: ReactNode;
}

/**
 * Wraps protected routes. While the initial token validation is running a
 * full-page spinner is shown to prevent a flash of the login redirect. Once
 * loading completes, unauthenticated users are sent to /login with the
 * intended path preserved in location state so LoginPage can redirect back.
 */
export function RequireAuth({ children }: RequireAuthProps) {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return <FullPageSpinner />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}

/* ─── Full-page loading state ────────────────────────────── */

function FullPageSpinner() {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#0f1117',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        {/* Animated spinner ring */}
        <svg
          viewBox="0 0 48 48"
          fill="none"
          style={{
            width: 40,
            height: 40,
            animation: 'auth-spin 0.8s linear infinite',
          }}
        >
          <style>{`@keyframes auth-spin { to { transform: rotate(360deg); } }`}</style>
          <circle cx="24" cy="24" r="18" stroke="rgba(59,130,246,0.15)" strokeWidth="4" />
          <path
            d="M42 24a18 18 0 0 0-18-18"
            stroke="#3b82f6"
            strokeWidth="4"
            strokeLinecap="round"
          />
        </svg>
        <span
          style={{
            fontSize: '0.8rem',
            fontWeight: 600,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: '#334155',
          }}
        >
          Authenticating
        </span>
      </div>
    </div>
  );
}
