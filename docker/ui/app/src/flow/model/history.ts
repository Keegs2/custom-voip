/**
 * history.ts — undo / redo for the builder, as a small pure state machine.
 *
 * It replaces the transplanted zundo setup, which had three bugs:
 *  1. no `partialize`/`equality`, so selecting a block or React Flow
 *     measuring it (resize) pushed history entries;
 *  2. the debounce kept the LAST snapshot of a burst, so undoing a drag
 *     returned to a point mid-drag instead of where it started;
 *  3. it recorded every set(), including ones that changed nothing.
 *
 * Here a snapshot holds only what the customer edits (ids, types,
 * positions, labels, configs, edges — never `selected`, `dragging`,
 * `measured` or sizes), an entry is pushed only when the snapshot really
 * changed, and a burst of edits sharing a `key` (one drag, typing into one
 * field) coalesces into ONE entry that holds the state from BEFORE the
 * burst's first edit.
 */

export interface SnapNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: unknown;
}

export interface SnapEdge {
  id: string;
  source: string;
  sourceHandle: string | null;
  target: string;
  data?: unknown;
}

export interface Snapshot {
  nodes: SnapNode[];
  edges: SnapEdge[];
}

export interface HistoryState {
  past: Snapshot[];
  future: Snapshot[];
  /** Key of the last recorded burst (null after undo/redo/clear). */
  lastKey: string | null;
  lastAt: number;
}

/** Edits sharing a key closer together than this are one undo step. */
export const COALESCE_MS = 900;
export const HISTORY_LIMIT = 100;

export const emptyHistory = (): HistoryState => ({ past: [], future: [], lastKey: null, lastAt: 0 });

interface NodeShape {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: unknown;
}

interface EdgeShape {
  id: string;
  source: string;
  sourceHandle?: string | null;
  target: string;
  data?: unknown;
}

/** Strips everything UI-only. The data objects are shared (they are immutable). */
export function snapshotOf(nodes: readonly NodeShape[], edges: readonly EdgeShape[]): Snapshot {
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type ?? '',
      position: { x: n.position.x, y: n.position.y },
      data: n.data,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle ?? null,
      target: e.target,
      ...(e.data === undefined ? {} : { data: e.data }),
    })),
  };
}

export function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  if (a === b) return true;
  if (a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Records an edit that turned `before` into `after`.
 *  - no real change → history untouched (selection, measuring, no-op sets);
 *  - same `key` as the previous edit within COALESCE_MS → coalesced: the
 *    entry already pushed for the burst's FIRST edit stays the undo target;
 *  - otherwise `before` is pushed and the redo stack is dropped.
 */
export function record(
  h: HistoryState,
  before: Snapshot,
  after: Snapshot,
  key: string | null = null,
  now: number = Date.now(),
): HistoryState {
  const coalesce = key !== null && key === h.lastKey && now - h.lastAt <= COALESCE_MS;
  if (coalesce) {
    // The burst's first snapshot is already on the stack. Still drop redo:
    // anything redoable is now stale.
    return { ...h, future: [], lastAt: now };
  }
  if (sameSnapshot(before, after)) return h;
  const past = [...h.past, before];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return { past, future: [], lastKey: key, lastAt: now };
}

/** Ends a coalescing burst so the next edit with the same key starts a new step. */
export function seal(h: HistoryState): HistoryState {
  return h.lastKey === null ? h : { ...h, lastKey: null };
}

export function undo(h: HistoryState, current: Snapshot): { history: HistoryState; snapshot: Snapshot } | null {
  const target = h.past[h.past.length - 1];
  if (!target) return null;
  return {
    history: { past: h.past.slice(0, -1), future: [current, ...h.future], lastKey: null, lastAt: 0 },
    snapshot: target,
  };
}

export function redo(h: HistoryState, current: Snapshot): { history: HistoryState; snapshot: Snapshot } | null {
  const target = h.future[0];
  if (!target) return null;
  return {
    history: { past: [...h.past, current], future: h.future.slice(1), lastKey: null, lastAt: 0 },
    snapshot: target,
  };
}
