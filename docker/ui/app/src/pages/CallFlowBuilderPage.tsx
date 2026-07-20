/**
 * Call Flow Builder route — a FULL-SCREEN workspace.
 *
 * The node-graph editor benefits from maximum canvas real estate (flows can be
 * very wide AND very tall), so this page renders OUTSIDE AppLayout's 1160px
 * centered column. It draws its own `Sidebar` (so the left app nav keeps
 * working) and lets `FlowBuilderShell` fill the entire remaining width and the
 * full viewport height — mirroring the `/troubleshooting` precedent. Admin-gated
 * (RequireAuth → RequireAdmin in App.tsx).
 *
 * React #310: no hooks here; the stateful work lives inside the shell panes.
 */
import { Sidebar } from '../components/layout/Sidebar';
import { FlowBuilderShell } from '../flow/FlowBuilderShell';

export function CallFlowBuilderPage() {
  return (
    <div style={{ height: '100vh', overflow: 'hidden', background: '#0f1117' }}>
      <Sidebar />

      {/* The Sidebar is fixed at 240px on the left; offset the workspace by it
          ONLY at md+ (`sidebar-offset` = 240px) — below md the Sidebar is off-canvas
          behind the hamburger topbar, so an unconditional margin would leave a
          240px dead gutter. Let the builder consume every remaining pixel. */}
      <div
        className="sidebar-offset"
        style={{
          height: '100vh',
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          boxSizing: 'border-box',
          borderLeft: '1px solid rgba(42,47,69,0.6)',
        }}
      >
        <FlowBuilderShell />
      </div>
    </div>
  );
}
