/**
 * Builder layout shell: toolbar across the top, then a three-pane row —
 * draggable palette (left), the React Flow canvas (centre), and the
 * config + validation panels (right).
 *
 * The flow store is a module singleton, so every pane shares state without
 * prop-drilling. React #310: no hooks in this layout component.
 */
import { FlowToolbar } from './toolbar/FlowToolbar';
import { NodePalette } from './palette/NodePalette';
import { CallFlowCanvas } from './CallFlowCanvas';
import { NodeConfigPanel } from './config/NodeConfigPanel';
import { ValidationPanel } from './validation/ValidationPanel';

export function FlowBuilderShell() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <FlowToolbar />

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <NodePalette />

        <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          <CallFlowCanvas />
        </div>

        <div
          style={{
            width: 280,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            background: '#13151d',
            borderLeft: '1px solid rgba(42,47,69,0.6)',
            minHeight: 0,
          }}
        >
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <NodeConfigPanel />
          </div>
          <div style={{ height: 220, flexShrink: 0, borderTop: '1px solid rgba(42,47,69,0.6)' }}>
            <ValidationPanel />
          </div>
        </div>
      </div>
    </div>
  );
}
