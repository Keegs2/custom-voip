/**
 * <CallFlowCanvas> — the React Flow host.
 *
 * Renders the live `nodes`/`edges` from the flow store onto a pan/zoom canvas
 * with Background, MiniMap and Controls (dark palette). Accepts palette drops
 * (HTML5 DnD → `screenToFlowPosition` → `addNode`) and validates connections
 * (no edges into the Entry node; entry/menu fan-out is allowed).
 *
 * React #310: every hook is declared unconditionally at the top of each
 * component, before any early return.
 */
import { useCallback } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  MiniMap,
  Controls,
  useReactFlow,
  type OnMove,
  type IsValidConnection,
  type NodeMouseHandler,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useFlowStore } from './store/flowStore';
import { nodeTypes } from './canvas/nodeTypes';
import { nodeAccent } from './model/palette';
import { PALETTE_DND_MIME } from './palette/NodePalette';
import type { RFNode } from './store/serialize';
import type { NodeType } from './model/types';

function CanvasInner() {
  // All hooks first — React #310.
  const nodes = useFlowStore((s) => s.nodes);
  const edges = useFlowStore((s) => s.edges);
  const onNodesChange = useFlowStore((s) => s.onNodesChange);
  const onEdgesChange = useFlowStore((s) => s.onEdgesChange);
  const onConnect = useFlowStore((s) => s.onConnect);
  const addNode = useFlowStore((s) => s.addNode);
  const setSelected = useFlowStore((s) => s.setSelected);
  const setViewport = useFlowStore((s) => s.setViewport);
  const { screenToFlowPosition } = useReactFlow();

  const handleNodeClick = useCallback<NodeMouseHandler<RFNode>>(
    (_event, node) => setSelected(node.id),
    [setSelected],
  );
  const handlePaneClick = useCallback(() => setSelected(null), [setSelected]);
  const handleMoveEnd = useCallback<OnMove>(
    (_event, viewport) => setViewport(viewport),
    [setViewport],
  );

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData(PALETTE_DND_MIME) as NodeType;
      if (!type) return;
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const node = addNode(type, position);
      setSelected(node.id);
    },
    [addNode, screenToFlowPosition, setSelected],
  );

  // Connections may never terminate on the Entry node (it is source-only) and
  // a node may not connect to itself.
  const isValidConnection = useCallback<IsValidConnection>(
    (conn) => {
      if (conn.source === conn.target) return false;
      const target = useFlowStore.getState().nodes.find((n) => n.id === conn.target);
      return target?.type !== 'entry';
    },
    [],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onNodeClick={handleNodeClick}
      onPaneClick={handlePaneClick}
      onMoveEnd={handleMoveEnd}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      isValidConnection={isValidConnection}
      colorMode="dark"
      fitView
      deleteKeyCode={['Backspace', 'Delete']}
      proOptions={{ hideAttribution: true }}
      style={{ background: '#0f1117' }}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#2a2f45" />
      <MiniMap
        pannable
        zoomable
        style={{ background: '#13151d', border: '1px solid rgba(42,47,69,0.8)' }}
        maskColor="rgba(15,17,23,0.6)"
        nodeColor={(n) => nodeAccent(n.type as NodeType)}
      />
      <Controls />
    </ReactFlow>
  );
}

export function CallFlowCanvas() {
  return (
    <ReactFlowProvider>
      <div style={{ width: '100%', height: '100%' }}>
        <CanvasInner />
      </div>
    </ReactFlowProvider>
  );
}
