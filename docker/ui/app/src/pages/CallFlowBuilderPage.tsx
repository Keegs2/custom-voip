/**
 * Call Flow Builder route (P0 scaffold). Hosts the node-graph canvas. This is
 * the future home of the universal call flow builder (CALL_FLOW_BUILDER_PLAN.md)
 * that will eventually replace the legacy `pages/ivr/` tree builder — but the
 * legacy IVR route stays intact until P1.
 *
 * Admin-gated (RequireAdmin in App.tsx). React #310: all hooks unconditionally
 * at the top.
 */
import { PageHeader } from '../components/layout/PageHeader';
import { CallFlowCanvas } from '../flow/CallFlowCanvas';

export function CallFlowBuilderPage() {
  return (
    <div>
      <PageHeader
        title="Call Flow Builder"
        subtitle="Node-graph editor for call-handling logic (preview)."
      />

      <div
        style={{
          height: 'calc(100vh - 220px)',
          minHeight: 560,
          borderRadius: 16,
          overflow: 'hidden',
          border: '1px solid rgba(42,47,69,0.6)',
          background: '#0f1117',
        }}
      >
        <CallFlowCanvas />
      </div>
    </div>
  );
}
