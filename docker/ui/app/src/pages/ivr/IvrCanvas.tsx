/**
 * IVR Builder — Flow Canvas
 *
 * Recursively renders a list of BuilderNodes with IvrDropZones between them.
 * Used for both the top-level flow and nested gather branch flows.
 */

import { IvrNode } from './IvrNode';
import { IvrDropZone } from './IvrDropZone';
import { IvrGatherBranches } from './IvrGatherBranches';
import { type BuilderNode } from './ivrUtils';
import type { IvrAction } from './useIvrFlow';

interface IvrCanvasProps {
  nodes: BuilderNode[];
  /** Path prefix for this list of nodes in the tree, e.g. "nodes" or "nodes[0].branches.1" */
  path: string;
  selectedNodeId: string | null;
  dispatch: React.Dispatch<IvrAction>;
}

export function IvrCanvas({ nodes, path, selectedNodeId, dispatch }: IvrCanvasProps) {
  // Render prop passed down to IvrGatherBranches to avoid circular imports
  function renderSubCanvas(subNodes: BuilderNode[], subPath: string): React.ReactNode {
    return (
      <IvrCanvas
        nodes={subNodes}
        path={subPath}
        selectedNodeId={selectedNodeId}
        dispatch={dispatch}
      />
    );
  }

  if (nodes.length === 0) {
    return (
      <>
        <IvrDropZone path={path} position={0} />
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            margin: '40px auto 0',
            maxWidth: 400,
            width: '100%',
            padding: '40px',
            border: '2px dashed rgba(59,130,246,0.20)',
            borderRadius: 12,
          }}
        >
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 16px',
              background: 'rgba(59,130,246,0.10)',
              border: '1px solid rgba(59,130,246,0.20)',
            }}
            aria-hidden="true"
          >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ width: 20, height: 20, color: '#3b82f6' }}>
              <path d="M10 3v14M3 10h14" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <p style={{ color: '#475569', fontSize: '0.875rem', fontWeight: 600, margin: 0 }}>Flow is empty</p>
          <p style={{ color: '#334155', fontSize: '0.78rem', marginTop: 8, lineHeight: 1.6, marginBottom: 0 }}>
            Drag a verb from the toolbar above and drop it here to begin building your call flow.
          </p>
        </div>
      </>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Leading drop zone (position 0) */}
      <IvrDropZone path={path} position={0} />

      {nodes.map((node, idx) => (
        <div key={node.id} style={{ display: 'flex', flexDirection: 'column' }}>
          {/* The node card */}
          <IvrNode
            node={node}
            isSelected={node.id === selectedNodeId}
            dispatch={dispatch}
          />

          {/* Gather branches panel rendered directly below the gather node */}
          {node.type === 'gather' && (
            <IvrGatherBranches
              node={node}
              nodePath={path}
              nodeIndex={idx}
              dispatch={dispatch}
              renderCanvas={renderSubCanvas}
            />
          )}

          {/* Connector line */}
          <div
            style={{ width: 2, minHeight: 12, background: '#2a2f45', margin: '0 auto' }}
            aria-hidden="true"
          />

          {/* Drop zone after this node */}
          <IvrDropZone path={path} position={idx + 1} />
        </div>
      ))}
    </div>
  );
}
