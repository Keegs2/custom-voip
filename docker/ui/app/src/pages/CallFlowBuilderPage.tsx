/**
 * Call Flow Builder route. Hosts the node-graph IVR editor (the universal
 * builder from CALL_FLOW_BUILDER_PLAN.md) — now the single IVR editor, after
 * the legacy `pages/ivr/` drag-and-drop builder was retired. Admin-gated
 * (RequireAdmin in App.tsx).
 *
 * React #310: no hooks here; the stateful work lives inside the shell panes.
 */
import { PageHeader } from '../components/layout/PageHeader';
import { FlowBuilderShell } from '../flow/FlowBuilderShell';

export function CallFlowBuilderPage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <PageHeader
        title="Call Flow Builder"
        subtitle="Design IVR call-handling logic on a node graph, then publish to the live runtime."
      />

      <div
        style={{
          height: 'calc(100vh - 200px)',
          minHeight: 600,
          borderRadius: 16,
          overflow: 'hidden',
          border: '1px solid rgba(42,47,69,0.6)',
          background: '#0f1117',
        }}
      >
        <FlowBuilderShell />
      </div>
    </div>
  );
}
