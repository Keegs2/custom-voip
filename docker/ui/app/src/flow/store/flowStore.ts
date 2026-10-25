/**
 * flowStore — the builder's state (zustand), ONE store per mounted builder.
 *
 * `createFlowStore()` is called by FlowBuilder (in a ref), so a customer
 * switch, a different flow, or leaving the page drops the store with the
 * component — nothing of one account's draft can leak into another's.
 * `useFlow(selector)` reads it through FlowStoreContext.
 *
 * Every graph edit goes through `commit()`, which records undo history
 * (model/history.ts: real changes only, bursts coalesced to their FIRST
 * snapshot) and bumps `changeSeq`, the autosave's "dirty" signal. React
 * Flow's own bookkeeping — selection, measuring, drag-in-progress flags —
 * is applied without touching either.
 *
 * Invariants kept here (contract §2):
 *  - exactly one Start, never deletable, nothing connects into it;
 *  - at most one edge per (source, exit); an exit that disappears (a menu
 *    key removed) takes its edge with it;
 *  - connections never form a cycle — loops are Go to blocks, which the
 *    compiler resolves (the old builder compiled back-edges to nothing);
 *  - a Go to whose target is deleted is cleared, not left dangling.
 */
import { createContext, useContext } from 'react';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { applyEdgeChanges, applyNodeChanges, type Edge, type EdgeChange, type Node, type NodeChange } from '@xyflow/react';
import type { Flow, IvrConfigMap, IvrGraph, IvrNodeType, IvrViewport } from '../../types/ivr';
import { defaultConfig, outHandles, sortDigits } from '../model/blocks';
import { fromGraph, newEdgeId, newNodeId, toGraph, type BlockData, type Keep } from '../model/graph';
import {
  emptyHistory,
  record,
  redo as historyRedo,
  seal,
  snapshotOf,
  undo as historyUndo,
  type HistoryState,
  type Snapshot,
} from '../model/history';
import { estimateHeight, tidyLayout } from '../model/layout';

export type FlowNode = Node<BlockData, IvrNodeType>;
export type FlowEdge = Edge<{ keep?: Keep }>;

export interface PreviewGraph {
  version: number;
  publishedAt: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface FlowMeta {
  id: number;
  publishedVersion: number | null;
  publishedAt: string | null;
  numbers: string[];
}

export interface FlowState {
  meta: FlowMeta;
  name: string;
  /** The server revision the next write must carry (contract §8.2 lock). */
  revision: number;
  nodes: FlowNode[];
  edges: FlowEdge[];
  viewport: IvrViewport | null;
  keepGraph: Keep;
  foreignNodes: Keep[];
  selectedId: string | null;
  history: HistoryState;
  /** +1 on every content change (graph or name). Autosave saves up to a seq. */
  changeSeq: number;
  /** +1 when call logic may have changed (not on pure moves) — the compile mirror's key. */
  contentSeq: number;
  savedSeq: number;
  /** +1 whenever the whole graph is replaced (load / restore) → the canvas re-fits. */
  graphEpoch: number;
  /** A published version shown read-only instead of the draft (History → View). */
  preview: PreviewGraph | null;
  /** The block the simulator is on (canvas highlight). */
  simNodeId: string | null;
  /** Centre the canvas on this block (outline / issue clicks); token makes repeats fire. */
  focusRequest: { id: string; token: number } | null;
}

export interface FlowActions {
  load: (flow: Flow, opts?: { undoable?: boolean }) => void;
  onNodesChange: (changes: NodeChange<FlowNode>[]) => void;
  /** Accepts React Flow's untyped changes: the canvas also draws (ignored) Go to jump lines. */
  onEdgesChange: (changes: EdgeChange[]) => void;
  /** Measuring of a read-only version's blocks (so its minimap and edges render). */
  onPreviewNodesChange: (changes: NodeChange<FlowNode>[]) => void;
  /** Connects an exit to a block (replacing the exit's old edge). Null = done; else why not. */
  connect: (source: string, handle: string, target: string) => string | null;
  disconnect: (source: string, handle: string) => void;
  addBlock: (type: IvrNodeType, opts?: { position?: { x: number; y: number }; from?: { source: string; handle: string } }) => string;
  updateConfig: <T extends IvrNodeType>(id: string, patch: Partial<IvrConfigMap[T]>, coalesceKey?: string) => void;
  setLabel: (id: string, label: string) => void;
  removeBlocks: (ids: readonly string[]) => void;
  select: (id: string | null) => void;
  focusBlock: (id: string) => void;
  /** Centre the canvas on a block WITHOUT selecting it (test call steps). */
  revealBlock: (id: string) => void;
  setName: (name: string) => void;
  setViewport: (viewport: IvrViewport) => void;
  tidy: () => void;
  undo: () => void;
  redo: () => void;
  /** A save of everything up to `seq` succeeded at `revision`. */
  markSaved: (seq: number, revision: number) => void;
  setRevision: (revision: number) => void;
  setMeta: (patch: Partial<FlowMeta>) => void;
  enterPreview: (preview: PreviewGraph) => void;
  exitPreview: () => void;
  setSimNode: (id: string | null) => void;
  /** The §2 JSON of the current draft. */
  graph: () => IvrGraph;
  /**
   * The §2 JSON as of the last CONTENT change — the same object until call
   * logic changes (moves don't count), so it is safe as a selector result
   * and a memo key (compile mirror, server check, version diff).
   */
  contentGraph: () => IvrGraph;
}

export type FlowStore = StoreApi<FlowState & FlowActions>;

/* ─── Pure helpers (exported for the panels) ──────────────── */

/** "source\0handle" → edge. */
export function slotKey(source: string, handle: string | null | undefined): string {
  return `${source}\u0000${handle ?? 'next'}`;
}

/** True when `from` can reach `to` along edges (Go to jumps don't count: they are not edges). */
function reaches(edges: readonly FlowEdge[], from: string, to: string): boolean {
  const out = new Map<string, string[]>();
  for (const e of edges) out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
  const stack = [from];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop() as string;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(out.get(id) ?? []));
  }
  return false;
}

/**
 * Why `source`'s `handle` can't connect to `target` (customer wording), or
 * null when it can. Shared by the canvas drag, the "Connect to…" menus and
 * the store itself.
 */
export function connectionProblem(
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
  source: string,
  handle: string,
  target: string,
): string | null {
  const s = nodes.find((n) => n.id === source);
  const t = nodes.find((n) => n.id === target);
  if (!s || !t) return 'That block no longer exists.';
  if (t.type === 'entry') return 'Nothing can connect into Start.';
  if (source === target) return 'A block can’t connect to itself. To repeat it, add a Go to block.';
  if (!outHandles(s).some((h) => h.id === handle)) return 'That exit no longer exists.';
  const others = edges.filter((e) => !(e.source === source && e.sourceHandle === handle));
  if (reaches(others, target, source)) {
    return 'That would loop the call back to an earlier block. To repeat a step, add a Go to block.';
  }
  return null;
}

function toFlowNode(n: { id: string; type: IvrNodeType; position: { x: number; y: number }; data: BlockData }): FlowNode {
  return {
    id: n.id,
    type: n.type,
    position: n.position,
    data: n.data,
    ...(n.type === 'entry' ? { deletable: false } : {}),
  };
}

function toFlowEdge(e: { id: string; source: string; sourceHandle: string; target: string; data?: { keep?: Keep } }): FlowEdge {
  // targetHandle is UI-only (never stored, §2 edges have none): every exit enters a block's left "in" handle.
  return { id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target, targetHandle: 'in', type: 'exit', data: e.data ?? {} };
}

/** Drops edges whose exit no longer exists or whose ends are gone; keeps one per exit. */
function pruneEdges(nodes: readonly FlowNode[], edges: readonly FlowEdge[]): FlowEdge[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  return edges.filter((e) => {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t || t.type === 'entry') return false;
    if (!outHandles(s).some((h) => h.id === e.sourceHandle)) return false;
    const key = slotKey(e.source, e.sourceHandle);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fromSnapshot(snap: Snapshot): { nodes: FlowNode[]; edges: FlowEdge[] } {
  return {
    nodes: snap.nodes.map((n) =>
      toFlowNode({ id: n.id, type: n.type as IvrNodeType, position: n.position, data: n.data as BlockData }),
    ),
    edges: snap.edges.map((e) =>
      toFlowEdge({
        id: e.id,
        source: e.source,
        sourceHandle: e.sourceHandle ?? 'next',
        target: e.target,
        data: e.data as { keep?: Keep } | undefined,
      }),
    ),
  };
}

const metaOf = (flow: Flow): FlowMeta => ({
  id: flow.id,
  publishedVersion: flow.published_version,
  publishedAt: flow.published_at,
  numbers: flow.numbers,
});

/* ─── Store ───────────────────────────────────────────────── */

export function createFlowStore(flow: Flow): FlowStore {
  const initial = fromGraph(flow.draft_graph);
  let cached: { seq: number; graph: IvrGraph } | null = null;
  return createStore<FlowState & FlowActions>()((set, get) => {
    /** Applies a graph edit with history + dirty tracking. */
    const commit = (
      next: { nodes?: FlowNode[]; edges?: FlowEdge[] },
      key: string | null = null,
      extra: Partial<FlowState> = {},
      positionOnly = false,
    ) => {
      const s = get();
      const nodes = next.nodes ?? s.nodes;
      const edges = next.edges ?? s.edges;
      const history = record(s.history, snapshotOf(s.nodes, s.edges), snapshotOf(nodes, edges), key);
      const changed = history !== s.history;
      set({
        nodes,
        edges,
        history,
        changeSeq: changed ? s.changeSeq + 1 : s.changeSeq,
        contentSeq: changed && !positionOnly ? s.contentSeq + 1 : s.contentSeq,
        ...extra,
      });
    };

    return {
      meta: metaOf(flow),
      name: flow.name,
      revision: flow.revision,
      nodes: initial.nodes.map(toFlowNode),
      edges: initial.edges.map(toFlowEdge),
      viewport: initial.viewport,
      keepGraph: initial.keepGraph,
      foreignNodes: initial.foreignNodes,
      selectedId: null,
      history: emptyHistory(),
      changeSeq: 0,
      contentSeq: 0,
      savedSeq: 0,
      graphEpoch: 0,
      preview: null,
      simNodeId: null,
      focusRequest: null,

      load: (next, opts = {}) => {
        const s = get();
        const g = fromGraph(next.draft_graph);
        const nodes = g.nodes.map(toFlowNode);
        const edges = g.edges.map(toFlowEdge);
        const history = opts.undoable
          ? record(s.history, snapshotOf(s.nodes, s.edges), snapshotOf(nodes, edges), null)
          : emptyHistory();
        set({
          meta: metaOf(next),
          name: next.name,
          revision: next.revision,
          nodes,
          edges,
          viewport: g.viewport,
          keepGraph: g.keepGraph,
          foreignNodes: g.foreignNodes,
          selectedId: null,
          history,
          // Loaded content is what the server holds: nothing to save.
          changeSeq: s.changeSeq + 1,
          savedSeq: s.changeSeq + 1,
          contentSeq: s.contentSeq + 1,
          graphEpoch: s.graphEpoch + 1,
          preview: null,
          simNodeId: null,
        });
      },

      onNodesChange: (changes) => {
        const s = get();
        // Start can never be removed, whatever React Flow asks for.
        const startIds = new Set(s.nodes.filter((n) => n.type === 'entry').map((n) => n.id));
        const safe = changes.filter((c) => !(c.type === 'remove' && startIds.has(c.id)));
        if (safe.length === 0) return;
        const content = safe.filter((c) => c.type !== 'select' && c.type !== 'dimensions');
        const nodes = applyNodeChanges(safe, s.nodes);
        let selectedId = s.selectedId;
        for (const c of safe) {
          if (c.type === 'select' && c.selected) selectedId = c.id;
          if (c.type === 'select' && !c.selected && selectedId === c.id) selectedId = null;
        }
        if (content.length === 0) {
          set({ nodes, selectedId });
          return;
        }
        const removed = new Set(content.filter((c) => c.type === 'remove').map((c) => (c as { id: string }).id));
        if (removed.size) {
          get().removeBlocks([...removed]);
          return;
        }
        const moving = content.filter((c) => c.type === 'position');
        const key = moving.length ? `move:${moving.map((c) => (c as { id: string }).id).sort().join(',')}` : null;
        commit({ nodes }, key, { selectedId }, moving.length === content.length);
        // The end of a drag closes the burst: the next drag is its own undo step.
        if (moving.some((c) => c.type === 'position' && c.dragging === false)) set({ history: seal(get().history) });
      },

      onEdgesChange: (changes) => {
        const s = get();
        // Go to jump lines are drawn, not stored: ignore anything about them.
        const own = changes.filter((c) => !('id' in c && typeof c.id === 'string' && c.id.startsWith('jump:')));
        if (own.length === 0) return;
        const edges = applyEdgeChanges(own as EdgeChange<FlowEdge>[], s.edges);
        if (own.every((c) => c.type === 'select')) set({ edges });
        else commit({ edges });
      },

      onPreviewNodesChange: (changes) => {
        const p = get().preview;
        const dims = changes.filter((c) => c.type === 'dimensions');
        if (!p || dims.length === 0) return;
        set({ preview: { ...p, nodes: applyNodeChanges(dims, p.nodes) } });
      },

      connect: (source, handle, target) => {
        const s = get();
        const problem = connectionProblem(s.nodes, s.edges, source, handle, target);
        if (problem) return problem;
        const edges = [
          ...s.edges.filter((e) => !(e.source === source && e.sourceHandle === handle)),
          toFlowEdge({ id: newEdgeId(), source, sourceHandle: handle, target }),
        ];
        commit({ edges });
        return null;
      },

      disconnect: (source, handle) => {
        const s = get();
        commit({ edges: s.edges.filter((e) => !(e.source === source && e.sourceHandle === handle)) });
      },

      addBlock: (type, opts = {}) => {
        const s = get();
        const id = newNodeId();
        let position = opts.position;
        if (!position && opts.from) {
          const src = s.nodes.find((n) => n.id === opts.from?.source);
          if (src) {
            const siblings = s.edges.filter((e) => e.source === src.id).length;
            position = { x: src.position.x + 320, y: src.position.y + siblings * (estimateHeight({ type, data: { config: {} } }) + 24) };
          }
        }
        const node = toFlowNode({
          id,
          type,
          position: position ?? { x: 0, y: 0 },
          data: { config: defaultConfig(type) },
        });
        const nodes = [...s.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), { ...node, selected: true }];
        let edges = s.edges;
        if (opts.from && connectionProblem(nodes, edges, opts.from.source, opts.from.handle, id) === null) {
          edges = [
            ...edges.filter((e) => !(e.source === opts.from?.source && e.sourceHandle === opts.from?.handle)),
            toFlowEdge({ id: newEdgeId(), source: opts.from.source, sourceHandle: opts.from.handle, target: id }),
          ];
        }
        commit({ nodes, edges }, null, { selectedId: id });
        return id;
      },

      updateConfig: (id, patch, coalesceKey) => {
        const s = get();
        const nodes = s.nodes.map((n) => {
          if (n.id !== id) return n;
          const config = { ...(n.data.config as object), ...(patch as object) } as IvrConfigMap[IvrNodeType];
          if (n.type === 'menu' && 'digits' in (patch as object)) {
            (config as IvrConfigMap['menu']).digits = sortDigits((config as IvrConfigMap['menu']).digits);
          }
          return { ...n, data: { ...n.data, config } };
        });
        // A removed menu key (or any vanished exit) takes its edge with it.
        commit({ nodes, edges: pruneEdges(nodes, s.edges) }, coalesceKey ?? null);
      },

      setLabel: (id, label) => {
        const s = get();
        const nodes = s.nodes.map((n) => {
          if (n.id !== id) return n;
          const data = { ...n.data };
          if (label.trim()) data.label = label;
          else delete data.label;
          return { ...n, data };
        });
        commit({ nodes }, `label:${id}`);
      },

      removeBlocks: (ids) => {
        const s = get();
        const gone = new Set(ids.filter((id) => s.nodes.find((n) => n.id === id)?.type !== 'entry'));
        if (gone.size === 0) return;
        const nodes = s.nodes
          .filter((n) => !gone.has(n.id))
          .map((n) => {
            if (n.type !== 'goto') return n;
            const cfg = n.data.config as IvrConfigMap['goto'];
            return gone.has(cfg.targetNodeId) ? { ...n, data: { ...n.data, config: { ...cfg, targetNodeId: '' } } } : n;
          });
        const edges = s.edges.filter((e) => !gone.has(e.source) && !gone.has(e.target));
        commit({ nodes, edges }, null, { selectedId: s.selectedId && gone.has(s.selectedId) ? null : s.selectedId });
      },

      select: (id) => {
        const s = get();
        set({
          selectedId: id,
          nodes: s.nodes.map((n) => (n.selected === (n.id === id) ? n : { ...n, selected: n.id === id })),
        });
      },

      focusBlock: (id) => {
        get().select(id);
        set({ focusRequest: { id, token: (get().focusRequest?.token ?? 0) + 1 } });
      },

      revealBlock: (id) => set({ focusRequest: { id, token: (get().focusRequest?.token ?? 0) + 1 } }),

      setName: (name) => {
        const s = get();
        if (name === s.name) return;
        set({ name, changeSeq: s.changeSeq + 1 });
      },

      // The viewport is saved with the draft but is not an edit: no history, no dirty.
      setViewport: (viewport) => set({ viewport }),

      tidy: () => {
        const s = get();
        const pos = tidyLayout(s.nodes as unknown as Parameters<typeof tidyLayout>[0], s.edges);
        commit(
          { nodes: s.nodes.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })) },
          null,
          { graphEpoch: s.graphEpoch + 1 },
          true,
        );
      },

      undo: () => {
        const s = get();
        const step = historyUndo(s.history, snapshotOf(s.nodes, s.edges));
        if (!step) return;
        const { nodes, edges } = fromSnapshot(step.snapshot);
        set({
          nodes: nodes.map((n) => ({ ...n, selected: n.id === s.selectedId })),
          edges,
          history: step.history,
          changeSeq: s.changeSeq + 1,
          contentSeq: s.contentSeq + 1,
          selectedId: nodes.some((n) => n.id === s.selectedId) ? s.selectedId : null,
        });
      },

      redo: () => {
        const s = get();
        const step = historyRedo(s.history, snapshotOf(s.nodes, s.edges));
        if (!step) return;
        const { nodes, edges } = fromSnapshot(step.snapshot);
        set({
          nodes: nodes.map((n) => ({ ...n, selected: n.id === s.selectedId })),
          edges,
          history: step.history,
          changeSeq: s.changeSeq + 1,
          contentSeq: s.contentSeq + 1,
          selectedId: nodes.some((n) => n.id === s.selectedId) ? s.selectedId : null,
        });
      },

      markSaved: (seq, revision) => set((s) => ({ savedSeq: Math.max(s.savedSeq, seq), revision })),
      setRevision: (revision) => set({ revision }),
      setMeta: (patch) => set((s) => ({ meta: { ...s.meta, ...patch } })),
      enterPreview: (preview) => set((s) => ({ preview, selectedId: null, graphEpoch: s.graphEpoch + 1 })),
      exitPreview: () => set((s) => ({ preview: null, graphEpoch: s.graphEpoch + 1 })),
      setSimNode: (id) => set({ simNodeId: id }),

      graph: () => {
        const s = get();
        return toGraph(s.nodes, s.edges, s.viewport, { keepGraph: s.keepGraph, foreignNodes: s.foreignNodes });
      },

      contentGraph: () => {
        const seq = get().contentSeq;
        if (cached?.seq !== seq) cached = { seq, graph: get().graph() };
        return cached.graph;
      },
    };
  });
}

/** A published version's graph, ready for the read-only canvas. */
export function previewFromGraph(version: number, publishedAt: string, graph: IvrGraph): PreviewGraph {
  const g = fromGraph(graph);
  return { version, publishedAt, nodes: g.nodes.map(toFlowNode), edges: g.edges.map(toFlowEdge) };
}

/* ─── React glue ──────────────────────────────────────────── */

export const FlowStoreContext = createContext<FlowStore | null>(null);

export function useFlowStoreApi(): FlowStore {
  const store = useContext(FlowStoreContext);
  if (!store) throw new Error('useFlow outside FlowStoreContext');
  return store;
}

export function useFlow<T>(selector: (state: FlowState & FlowActions) => T): T {
  return useStore(useFlowStoreApi(), selector);
}
