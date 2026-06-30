/**
 * ShellOutlet — renders the active child tab page inside a tab shell, with a
 * subtle fade-in keyed on the route so switching tabs feels alive. The child
 * <Outlet /> is preserved exactly; only the entrance animation wraps it.
 */

import { Outlet } from 'react-router-dom';

export function ShellOutlet({ routeKey }: { routeKey: string }) {
  return (
    <>
      <style>{`
        @keyframes shellTabFadeIn {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0);   }
        }
      `}</style>
      <div key={routeKey} style={{ animation: 'shellTabFadeIn 0.25s ease both' }}>
        <Outlet />
      </div>
    </>
  );
}
