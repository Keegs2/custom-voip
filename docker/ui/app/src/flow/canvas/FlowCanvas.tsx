/**
 * FlowCanvas — the React Flow host for the IVR builder.
 *
 *  - Controlled by the builder store (or shows a read-only published
 *    version / a phone-width read-only view — `mode`).
 *  - Light / dark: `colorMode` follows useTheme(); every --xy-* variable is
 *    mapped to a --t-* token in styles/ivr-builder.css; the MiniMap gets
 *    RESOLVED hues (useBlockHues) because it can't take var().
 *  - Palette drops (HTML5 DnD) land where the block is dropped; a dragged
 *    connection that would loop or enter Start is refused with the reason.
 *  - Keyboard: blocks are focusable (Tab), Enter/Space selects (which opens
 *    its panel), arrows move a selected block, Delete removes it (never
 *    Start). Edits made through the panels need no mouse at all.
 *
 * React #310: all hooks at the top.
 */
import { useCallback, useEffect, useMemo, useRef, type DragEvent } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeTypes,
  type IsValidConnection,
  type NodeTypes,
  type OnMove,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useResolvedToken, useTheme } from '../../contexts/ThemeContext';
import { useToast } from '../../components/ui/ToastContext';
import type { IvrNodeType } from '../../types/ivr';
import { isIvrNodeType } from '../model/blocks';
import { connectionProblem, useFlow, useFlowStoreApi, type FlowEdge, type FlowNode } from '../store/flowStore';
import { gotoJumps } from '../useFlowAnalysis';
import { BlockNode } from './BlockNode';
import { ExitEdge, JumpEdge } from './edges';
import { useBlockHues, withAlpha } from './useBlockHues';

/** MIME type of a palette drag. */
export const BLOCK_DND_MIME = 'application/x-crag-ivr-block';

/** Stable identity — React Flow re-renders hard if this object changes. */
const NODE_TYPES: NodeTypes = {
  entry: BlockNode,
  play: BlockNode,
  menu: BlockNode,
  schedule: BlockNode,
  condition: BlockNode,
  dial: BlockNode,
  voicemail: BlockNode,
  goto: BlockNode,
  hangup: BlockNode,
};

const EDGE_TYPES: EdgeTypes = { exit: ExitEdge, jump: JumpEdge };

const FIT = { padding: 0.12, maxZoom: 1, minZoom: 0.2 } as const;
/** Below this zoom block text stops being readable: open there, anchored at Start, instead. */
const READABLE_ZOOM = 0.7;
const READABLE_ZOOM_COMPACT = 0.55;
const EDGE_PAD = 36;
const DELETE_KEYS = ['Backspace', 'Delete'];

export type CanvasMode = 'edit' | 'readonly' | 'preview';

export interface FlowCanvasProps {
  mode: CanvasMode;
  /** Nodes/edges to show instead of the draft (a published version). */
  override?: { nodes: FlowNode[]; edges: FlowEdge[] } | null;
  /** Phone width: no minimap, compact controls. */
  compact?: boolean;
}

export function FlowCanvas({ mode, override = null, compact = false }: FlowCanvasProps) {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const store = useFlowStoreApi();
  const draftNodes = useFlow((s) => s.nodes);
  const draftEdges = useFlow((s) => s.edges);
  const graphEpoch = useFlow((s) => s.graphEpoch);
  const focusRequest = useFlow((s) => s.focusRequest);
  const { theme } = useTheme();
  const { toastErr } = useToast();
  const { screenToFlowPosition, fitView, setCenter, setViewport, getNode, getNodes, getNodesBounds } = useReactFlow<FlowNode, Edge>();
  const wrapRef = useRef<HTMLDivElement>(null);
  const hues = useBlockHues();
  const canvas = useResolvedToken('canvas');
  const lineStrong = useResolvedToken('line-strong');

  const nodes = override?.nodes ?? draftNodes;
  const edges = override?.edges ?? draftEdges;
  const editable = mode === 'edit' && override === null;

  const allEdges = useMemo<Edge[]>(() => {
    const exitMarker = { type: MarkerType.ArrowClosed, width: 16, height: 16, color: 'var(--ivr-edge-color)' };
    const jumpMarker = { type: MarkerType.ArrowClosed, width: 14, height: 14, color: 'var(--ivr-goto)' };
    const jumps: Edge[] = gotoJumps(nodes).map((j) => ({
      id: j.id,
      source: j.source,
      sourceHandle: 'jump',
      target: j.target,
      targetHandle: 'jumpin',
      type: 'jump',
      selectable: false,
      deletable: false,
      focusable: false,
      markerEnd: jumpMarker,
      zIndex: 0,
    }));
    return [...edges.map((e) => ({ ...e, markerEnd: exitMarker })), ...jumps];
  }, [nodes, edges]);

  // Frame the graph when a whole graph is swapped in (open, restore, version
  // view, tidy): the saved viewport on first open; else the whole flow when
  // it fits at a readable zoom; else a readable zoom anchored at Start (the
  // minimap shows the rest) — a thumbnail of unreadable blocks helps nobody.
  useEffect(() => {
    const t = window.setTimeout(() => {
      const saved = store.getState().viewport;
      if (graphEpoch === 0 && saved && override === null) {
        void setViewport(saved);
        return;
      }
      const all = getNodes();
      const el = wrapRef.current;
      if (all.length === 0 || !el) return;
      const b = getNodesBounds(all);
      const w = el.clientWidth;
      const h = el.clientHeight;
      const readable = compact ? READABLE_ZOOM_COMPACT : READABLE_ZOOM;
      const fit = Math.min((w - EDGE_PAD * 2) / Math.max(1, b.width), (h - EDGE_PAD * 2) / Math.max(1, b.height));
      if (fit >= readable) {
        void fitView({ ...FIT, duration: graphEpoch === 0 ? 0 : 260 });
        return;
      }
      const start = all.find((n) => n.type === 'entry');
      const z = readable;
      const tallFit = b.height * z <= h - EDGE_PAD * 2;
      const anchorY = tallFit ? (h - b.height * z) / 2 - b.y * z : EDGE_PAD - (start ? start.position.y - 40 : b.y) * z;
      void setViewport({ x: EDGE_PAD - b.x * z, y: anchorY, zoom: z }, { duration: graphEpoch === 0 ? 0 : 260 });
    }, 50);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphEpoch, override === null]);

  // Centre on a block asked for by the outline / an issue link.
  useEffect(() => {
    if (!focusRequest) return;
    const n = getNode(focusRequest.id);
    if (!n) return;
    const w = n.measured?.width ?? 272;
    const h = n.measured?.height ?? 140;
    void setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: 1, duration: 280 });
  }, [focusRequest, getNode, setCenter]);

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || !c.sourceHandle) return;
      const problem = store.getState().connect(c.source, c.sourceHandle, c.target);
      if (problem) toastErr(problem);
    },
    [store, toastErr],
  );

  const isValidConnection = useCallback<IsValidConnection>(
    (c) => {
      if (!c.source || !c.target || !c.sourceHandle) return false;
      const s = store.getState();
      return connectionProblem(s.nodes, s.edges, c.source, c.sourceHandle, c.target) === null;
    },
    [store],
  );

  const onMoveEnd = useCallback<OnMove>(
    (_e, vp) => {
      if (editable) store.getState().setViewport(vp);
    },
    [store, editable],
  );

  const onDragOver = useCallback((e: DragEvent) => {
    if (!e.dataTransfer.types.includes(BLOCK_DND_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDrop = useCallback(
    (e: DragEvent) => {
      const type = e.dataTransfer.getData(BLOCK_DND_MIME);
      if (!editable || !isIvrNodeType(type)) return;
      e.preventDefault();
      const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      // Drop point = the card's top-left, nudged so the cursor sits in its header.
      store.getState().addBlock(type as IvrNodeType, { position: { x: p.x - 40, y: p.y - 18 } });
    },
    [editable, screenToFlowPosition, store],
  );

  const onPaneClick = useCallback(() => {
    if (store.getState().selectedId) store.getState().select(null);
  }, [store]);

  return (
    <div ref={wrapRef} className="ivr-flow-wrap">
    <ReactFlow<FlowNode, Edge>
      className="ivr-flow"
      nodes={nodes}
      edges={allEdges}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      colorMode={theme}
      onNodesChange={
        mode === 'preview' ? store.getState().onPreviewNodesChange : store.getState().onNodesChange
      }
      onEdgesChange={editable ? store.getState().onEdgesChange : undefined}
      onConnect={editable ? onConnect : undefined}
      isValidConnection={isValidConnection}
      onMoveEnd={onMoveEnd}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onPaneClick={onPaneClick}
      nodesDraggable={editable}
      nodesConnectable={editable}
      elementsSelectable={mode !== 'preview'}
      nodesFocusable={mode !== 'preview'}
      edgesFocusable={editable}
      deleteKeyCode={editable ? DELETE_KEYS : null}
      selectionOnDrag={false}
      multiSelectionKeyCode={editable ? 'Shift' : null}
      minZoom={0.2}
      maxZoom={1.6}
      attributionPosition="top-right"
      connectionRadius={28}
      autoPanOnNodeFocus
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
      {!compact && (
        <MiniMap<FlowNode>
          className="ivr-minimap"
          style={{ width: 176, height: 116 }}
          pannable
          zoomable
          ariaLabel="Overview of the flow"
          nodeColor={(n) => hues[n.type as IvrNodeType] ?? lineStrong}
          nodeStrokeColor={(n) => hues[n.type as IvrNodeType] ?? lineStrong}
          nodeBorderRadius={6}
          maskColor={withAlpha(canvas, 0.62)}
        />
      )}
      <Controls className="ivr-controls" showInteractive={false} position="bottom-left" fitViewOptions={FIT} />
    </ReactFlow>
    </div>
  );
}
