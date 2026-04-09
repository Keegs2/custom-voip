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
        <div className="flex flex-col items-center justify-center py-8 text-center opacity-60">
          <p className="text-[#4a5568] text-sm font-medium">Flow is empty</p>
          <p className="text-[#4a5568] text-xs mt-1">
            Drag a verb from the left panel and drop it above to begin.
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
