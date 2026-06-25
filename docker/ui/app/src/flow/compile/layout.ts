/**
 * Shared auto-layout helper for the reverse compilers (`fromLegacyIvr`,
 * `fromLiveConfig`, …). Both build a fresh `{ nodes, edges }` graph with
 * placeholder positions, then call this to assign top-down `@dagrejs/dagre`
 * coordinates in place — so a hydrated/imported flow lands on the canvas already
 * laid out instead of stacked at the origin.
 *
 * Pure: no React, no store. React Flow positions are top-left while dagre centres
 * nodes, so each node is offset back by half the node box.
 */
import { Graph, layout } from '@dagrejs/dagre';
import type { FlowEdge, FlowNode } from '../model/types';

/** Node box used for dagre spacing — matches the canvas node footprint. */
export const NODE_W = 220;
export const NODE_H = 84;

/** Assign top-down dagre positions to `nodes` in place (driven by `edges`). */
export function layoutTopDown(nodes: FlowNode[], edges: FlowEdge[]): void {
  const g = new Graph({ directed: true });
  g.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 90, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) g.setEdge(e.source, e.target);

  layout(g);

  for (const n of nodes) {
    const p = g.node(n.id) as { x?: number; y?: number } | undefined;
    if (p && typeof p.x === 'number' && typeof p.y === 'number') {
      n.position = { x: Math.round(p.x - NODE_W / 2), y: Math.round(p.y - NODE_H / 2) };
    }
  }
}
