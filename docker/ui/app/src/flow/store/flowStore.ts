/**
 * Authoritative flow store (zustand + zundo).
 *
 * Holds the live `CallFlowDoc` metadata plus the React Flow `nodes`/`edges`
 * arrays. React Flow is itself zustand-based, so this is the idiomatic pairing:
 * `onNodesChange`/`onEdgesChange`/`onConnect` forward React Flow's change events
 * into the store via `applyNodeChanges`/`applyEdgeChanges`/`addEdge`.
 *
 * Undo/redo is provided by zundo's `temporal` middleware, which snapshots only
 * `{ nodes, edges }` (via `partialize`) and debounces rapid sets (via
 * `handleSet`) so a drag gesture collapses to a single history entry.
 */
import { create } from 'zustand';
import { useStore } from 'zustand';
import { temporal, type TemporalState } from 'zundo';
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type Viewport,
} from '@xyflow/react';
import type { CallFlowDoc, NodeConfig, NodeType } from '../model/types';
import { emptyDoc, makeNode, newId } from '../model/defaults';
import {
  deserialize,
  serialize,
  type RFEdge,
  type RFNode,
} from './serialize';

/* ─── State shape ──────────────────────────────────────────────────────── */

export interface FlowState {
  /** Non-graph metadata (id, product, name, entry, status, version, …). */
  doc: CallFlowDoc;
  /** Live React Flow graph — the editable surface. */
  nodes: RFNode[];
  edges: RFEdge[];
  /** Currently-selected node (drives the config panel in P1). */
  selectedId: string | null;

  /* React Flow event forwarding */
  onNodesChange: (changes: NodeChange<RFNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<RFEdge>[]) => void;
  onConnect: (connection: Connection) => void;

  /* Typed graph mutations */
  addNode: (type: NodeType, position: { x: number; y: number }) => RFNode;
  updateNodeConfig: (id: string, patch: Partial<NodeConfig>) => void;
  updateNodeLabel: (id: string, label: string) => void;
  removeNode: (id: string) => void;
  connectEdge: (connection: Connection) => void;
  removeEdge: (id: string) => void;
  setViewport: (viewport: Viewport) => void;
  setSelected: (id: string | null) => void;

  /* Document metadata (name, entry binding, customer, persisted id/status). */
  patchDoc: (patch: Partial<CallFlowDoc>) => void;

  /* Lifecycle */
  loadDoc: (doc: CallFlowDoc) => void;
  reset: () => void;

  /** Assemble the current store state back into a persistable `CallFlowDoc`. */
  getDoc: () => CallFlowDoc;
}

/* ─── Small debounce (used by zundo's handleSet) ───────────────────────── */

function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/* ─── Store ────────────────────────────────────────────────────────────── */

const INITIAL_DOC = emptyDoc('ivr');
const INITIAL_GRAPH = serialize(INITIAL_DOC);

export const useFlowStore = create<FlowState>()(
  temporal(
    (set, get) => ({
      doc: INITIAL_DOC,
      nodes: INITIAL_GRAPH.nodes,
      edges: INITIAL_GRAPH.edges,
      selectedId: null,

      onNodesChange: (changes) =>
        set({ nodes: applyNodeChanges(changes, get().nodes) }),

      onEdgesChange: (changes) =>
        set({ edges: applyEdgeChanges(changes, get().edges) }),

      onConnect: (connection) =>
        set({
          // A source handle drives a single outcome — replace any existing edge
          // leaving the same source+handle so the compiled chain is deterministic.
          edges: addEdge<RFEdge>(
            { ...connection, id: newId() },
            get().edges.filter(
              (e) =>
                !(
                  e.source === connection.source &&
                  (e.sourceHandle ?? null) === (connection.sourceHandle ?? null)
                ),
            ),
          ),
        }),

      addNode: (type, position) => {
        const node = makeNode(type, position);
        const rfNode = serialize({ ...get().doc, nodes: [node], edges: [] }).nodes[0];
        set({ nodes: [...get().nodes, rfNode] });
        return rfNode;
      },

      updateNodeConfig: (id, patch) =>
        set({
          nodes: get().nodes.map((n) =>
            n.id === id
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    config: { ...n.data.config, ...patch } as NodeConfig,
                  },
                }
              : n,
          ),
        }),

      updateNodeLabel: (id, label) =>
        set({
          nodes: get().nodes.map((n) =>
            n.id === id ? { ...n, data: { ...n.data, label } } : n,
          ),
        }),

      removeNode: (id) =>
        set({
          nodes: get().nodes.filter((n) => n.id !== id),
          // Drop any edges touching the removed node.
          edges: get().edges.filter((e) => e.source !== id && e.target !== id),
          selectedId: get().selectedId === id ? null : get().selectedId,
        }),

      connectEdge: (connection) =>
        set({
          edges: addEdge<RFEdge>(
            { ...connection, id: newId() },
            get().edges.filter(
              (e) =>
                !(
                  e.source === connection.source &&
                  (e.sourceHandle ?? null) === (connection.sourceHandle ?? null)
                ),
            ),
          ),
        }),

      removeEdge: (id) =>
        set({ edges: get().edges.filter((e) => e.id !== id) }),

      setViewport: (viewport) =>
        set({ doc: { ...get().doc, viewport } }),

      setSelected: (id) => set({ selectedId: id }),

      patchDoc: (patch) => set({ doc: { ...get().doc, ...patch } }),

      loadDoc: (doc) => {
        const graph = serialize(doc);
        set({ doc, nodes: graph.nodes, edges: graph.edges, selectedId: null });
        // A fresh document starts a fresh undo timeline.
        useFlowStore.temporal.getState().clear();
      },

      reset: () => {
        const fresh = emptyDoc(get().doc.product);
        const graph = serialize(fresh);
        set({ doc: fresh, nodes: graph.nodes, edges: graph.edges, selectedId: null });
        useFlowStore.temporal.getState().clear();
      },

      getDoc: () => {
        const { doc, nodes, edges } = get();
        return deserialize(doc, { nodes, edges, viewport: doc.viewport });
      },
    }),
    {
      // Only the graph is undoable — metadata edits don't pollute history.
      partialize: (state) => ({ nodes: state.nodes, edges: state.edges }),
      limit: 100,
      // Collapse rapid sets (e.g. a drag) into one history entry.
      handleSet: (handleSet) => debounce(handleSet, 300),
    },
  ),
);

/* ─── Temporal (undo/redo) hook ────────────────────────────────────────── */

type FlowTemporal = TemporalState<Pick<FlowState, 'nodes' | 'edges'>>;

/**
 * Reactive accessor for zundo's temporal store. Use it to read `undo`, `redo`,
 * `clear`, and the `pastStates`/`futureStates` lengths (to disable buttons).
 *
 *   const undo = useFlowTemporal((s) => s.undo);
 *   const canUndo = useFlowTemporal((s) => s.pastStates.length > 0);
 */
export function useFlowTemporal<T>(selector: (state: FlowTemporal) => T): T {
  return useStore(useFlowStore.temporal, selector);
}
