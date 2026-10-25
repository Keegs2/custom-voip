/**
 * layout.ts — "Tidy up": arranges blocks left to right in the order a
 * caller meets them. A depth-first walk from Start over each block's exits
 * (in exit order) gives every block a column (its depth at first visit) and
 * a row (a cursor that only moves down when a branch ends), so a parent
 * lines up with its first child and siblings stack beneath. Blocks the
 * walk never reaches go in a final column. Pure and deterministic.
 */
import type { IvrNodeType } from '../../types/ivr.ts';
import { outHandles, type BlockLike } from './blocks.ts';

export interface LayoutNode extends BlockLike {
  id: string;
  type: IvrNodeType;
}

export interface LayoutEdge {
  source: string;
  sourceHandle?: string | null;
  target: string;
}

export const COLUMN_WIDTH = 320;
export const ROW_GAP = 36;

/** Rendered height of a block card (kept in step with canvas/BlockNode). */
export function estimateHeight(node: BlockLike): number {
  const exits = outHandles(node).length;
  return 84 + (exits > 0 ? 10 + exits * 30 : 0);
}

/**
 * The order a caller meets the blocks: Tidy up's walk (depth-first from
 * Start over each block's exits, in exit order — a Map keeps insertion
 * order), then the blocks it never reaches. The Flow assistant reveals a
 * proposal's blocks in this order, so it always matches the layout.
 */
export function callingOrder(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): string[] {
  return [...tidyLayout(nodes, edges).keys()];
}

export function tidyLayout(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
): Map<string, { x: number; y: number }> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, { x: number; y: number }>();
  const bySlot = new Map<string, string>();
  for (const e of edges) bySlot.set(`${e.source}\u0000${e.sourceHandle ?? 'next'}`, e.target);

  let cursor = 0;
  let maxDepth = 0;
  const visit = (id: string, depth: number) => {
    const node = byId.get(id);
    if (!node || out.has(id)) return;
    maxDepth = Math.max(maxDepth, depth);
    // Insertion order = visit order: callingOrder() reads it back.
    out.set(id, { x: depth * COLUMN_WIDTH, y: cursor });
    const children = outHandles(node)
      .map((h) => bySlot.get(`${id}\u0000${h.id}`))
      .filter((t): t is string => t !== undefined && !out.has(t));
    if (children.length === 0) {
      cursor += estimateHeight(node) + ROW_GAP;
      return;
    }
    const start = cursor;
    for (const child of children) visit(child, depth + 1);
    // A parent taller than its subtree still needs its own room.
    cursor = Math.max(cursor, start + estimateHeight(node) + ROW_GAP);
  };

  const entry = nodes.find((n) => n.type === 'entry');
  if (entry) visit(entry.id, 0);

  const orphans = nodes.filter((n) => !out.has(n.id));
  if (orphans.length) {
    let y = 0;
    const x = (maxDepth + 1) * COLUMN_WIDTH + 80;
    for (const n of orphans) {
      out.set(n.id, { x, y });
      y += estimateHeight(n) + ROW_GAP;
    }
  }
  return out;
}
