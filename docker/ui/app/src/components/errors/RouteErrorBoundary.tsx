/**
 * Route-level error boundary. Wraps a routed page (or an `<Outlet />` subtree)
 * so ONE page crashing cannot take down the app chrome — the Sidebar, the
 * SoftphoneWidget, and any active call keep running. `resetKey={pathname}`
 * means simply navigating to another page clears the error automatically.
 *
 * Usable two ways, mirroring RequireAuth:
 *   • as a layout element:            <Route element={<RouteErrorBoundary />}>…
 *   • wrapping an explicit element:   <RouteErrorBoundary><Page /></RouteErrorBoundary>
 */
import { Outlet, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { ErrorBoundary } from './ErrorBoundary';
import { RouteErrorFallback } from './fallbacks';

interface RouteErrorBoundaryProps {
  /** Defaults to an `<Outlet />` so this can be used directly as a layout route element. */
  children?: ReactNode;
}

export function RouteErrorBoundary({ children }: RouteErrorBoundaryProps) {
  const { pathname } = useLocation();

  return (
    <ErrorBoundary
      scope="route"
      resetKey={pathname}
      fallback={(error, reset) => <RouteErrorFallback error={error} onReset={reset} />}
    >
      {children ?? <Outlet />}
    </ErrorBoundary>
  );
}
