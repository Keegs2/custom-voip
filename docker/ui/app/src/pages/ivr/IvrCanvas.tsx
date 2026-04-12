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
          className="flex flex-col items-center justify-center py-10 text-center mx-auto"
          style={{
            maxWidth: 400,
            background: 'linear-gradient(135deg, rgba(30,33,48,0.4) 0%, rgba(19,21,29,0.5) 100%)',
            border: '1px dashed rgba(42,47,69,0.5)',
            borderRadius: 16,
            padding: '32px 24px',
            marginTop: 8,
          }}
        >
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center mx-auto mb-4"
            style={{
              background: 'rgba(6,182,212,0.08)',
              border: '1px solid rgba(6,182,212,0.2)',
            }}
            aria-hidden="true"
          >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ width: 20, height: 20, color: '#06b6d4' }}>
              <path d="M10 3v14M3 10h14" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <p className="text-[#718096] text-sm font-semibold">Flow is empty</p>
          <p className="text-[#4a5568] text-xs mt-2 leading-relaxed">
            Drag a verb from the toolbar above and drop it here to begin building your call flow.
          </p>
        </div>
      </>
    );
  }

  return (
    <div className="flex flex-col gap-0">
      {/* Leading drop zone (position 0) */}
      <IvrDropZone path={path} position={0} />

      {nodes.map((node, idx) => (
        <div key={node.id} className="flex flex-col">
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
            className="w-[2px] min-h-[12px] bg-[#2a2f45] mx-auto"
            aria-hidden="true"
          />

          {/* Drop zone after this node */}
          <IvrDropZone path={path} position={idx + 1} />
        </div>
      ))}
    </div>
  );
}
