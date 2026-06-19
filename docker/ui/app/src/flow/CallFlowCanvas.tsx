/**
 * <CallFlowCanvas> — the React Flow host (P0 scaffold).
 *
 * Renders the live `nodes`/`edges` from the flow store onto a pan/zoom canvas
 * with Background, MiniMap and Controls, styled to the app's dark palette. A
 * small in-canvas Panel proves the store + undo/redo end-to-end (add a node,
 * connect handles, undo, redo, reset). The real palette / config panel /
 * validation surfaces are P1.
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
  Panel,
  type OnMove,
  type NodeMouseHandler,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useFlowStore, useFlowTemporal } from './store/flowStore';
import { nodeTypes } from './canvas/nodeTypes';
import type { RFNode } from './store/serialize';
import type { NodeType } from './model/types';

/* ─── Toolbar button ───────────────────────────────────────────────────── */

function ToolButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '5px 10px',
        borderRadius: 8,
        fontSize: '0.72rem',
        fontWeight: 600,
        letterSpacing: '-0.01em',
        color: disabled ? '#475569' : '#cbd5e1',
        background: 'rgba(26,29,39,0.9)',
        border: '1px solid rgba(42,47,69,0.8)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'border-color 0.15s, color 0.15s',
      }}
    >
      {children}
    </button>
  );
}

/* ─── Inner canvas (inside ReactFlowProvider) ──────────────────────────── */

function CanvasInner() {
  // All hooks first — React #310.
  const nodes = useFlowStore((s) => s.nodes);
  const edges = useFlowStore((s) => s.edges);
  const onNodesChange = useFlowStore((s) => s.onNodesChange);
  const onEdgesChange = useFlowStore((s) => s.onEdgesChange);
  const onConnect = useFlowStore((s) => s.onConnect);
  const addNode = useFlowStore((s) => s.addNode);
  const removeNode = useFlowStore((s) => s.removeNode);
  const setSelected = useFlowStore((s) => s.setSelected);
  const setViewport = useFlowStore((s) => s.setViewport);
  const reset = useFlowStore((s) => s.reset);

  const undo = useFlowTemporal((s) => s.undo);
  const redo = useFlowTemporal((s) => s.redo);
  const canUndo = useFlowTemporal((s) => s.pastStates.length > 0);
  const canRedo = useFlowTemporal((s) => s.futureStates.length > 0);

  const handleNodeClick = useCallback<NodeMouseHandler<RFNode>>(
    (_event, node) => setSelected(node.id),
    [setSelected],
  );
  const handlePaneClick = useCallback(() => setSelected(null), [setSelected]);
  const handleMoveEnd = useCallback<OnMove>(
    (_event, viewport) => setViewport(viewport),
    [setViewport],
  );
  const handleAdd = useCallback(
    (type: NodeType) => {
      // Drop near the canvas centre with a little jitter so stacked adds are visible.
      addNode(type, { x: 200 + Math.random() * 240, y: 220 + Math.random() * 160 });
    },
    [addNode],
  );
  const handleDeleteSelected = useCallback(() => {
    const selectedId = useFlowStore.getState().selectedId;
    if (selectedId) removeNode(selectedId);
  }, [removeNode]);

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
      colorMode="dark"
      fitView
      proOptions={{ hideAttribution: true }}
      style={{ background: '#0f1117' }}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#2a2f45" />
      <MiniMap
        pannable
        zoomable
        style={{ background: '#13151d', border: '1px solid rgba(42,47,69,0.8)' }}
        maskColor="rgba(15,17,23,0.6)"
        nodeColor="#3b82f6"
      />
      <Controls />

      <Panel position="top-left">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', maxWidth: 360 }}>
          <ToolButton onClick={() => handleAdd('say')}>+ Say</ToolButton>
          <ToolButton onClick={() => handleAdd('menu')}>+ Menu</ToolButton>
          <ToolButton onClick={() => handleAdd('dial')}>+ Dial</ToolButton>
          <ToolButton onClick={() => handleAdd('hangup')}>+ Hangup</ToolButton>
          <ToolButton onClick={handleDeleteSelected}>Delete</ToolButton>
          <ToolButton onClick={() => undo()} disabled={!canUndo}>
            Undo
          </ToolButton>
          <ToolButton onClick={() => redo()} disabled={!canRedo}>
            Redo
          </ToolButton>
          <ToolButton onClick={reset}>Reset</ToolButton>
        </div>
      </Panel>
    </ReactFlow>
  );
}

/* ─── Public component ─────────────────────────────────────────────────── */

export function CallFlowCanvas() {
  return (
    <ReactFlowProvider>
      <div style={{ width: '100%', height: '100%' }}>
        <CanvasInner />
      </div>
    </ReactFlowProvider>
  );
}
