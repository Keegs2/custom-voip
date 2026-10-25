/**
 * graph.ts — §2 draft graph ⇄ the builder's working nodes and edges.
 *
 * Contract rules carried here:
 *  - ids match ^[A-Za-z0-9_-]{1,40}$ (`n_<nanoid>` / `e_<nanoid>`);
 *  - at most one edge per (source, sourceHandle); no edge targets `entry`;
 *  - unknown fields are PRESERVED round-trip: keys the UI doesn't know at the
 *    node, data, edge and graph level ride along in `keep*` and are written
 *    back unchanged; a block of a type this UI doesn't know (a future
 *    product's) is kept aside and re-emitted, never dropped.
 *
 * Pure (no React Flow runtime) so the node-run self-tests can import it.
 */
import { customAlphabet } from 'nanoid';
import type { IvrConfigMap, IvrEdge, IvrGraph, IvrNode, IvrNodeType, IvrViewport } from '../../types/ivr.ts';
import { defaultConfig, isIvrNodeType, isMenuDigit, sortDigits } from './blocks.ts';

export type Keep = Record<string, unknown>;

/** What a block carries on the canvas. `keep*` = fields this UI doesn't know. */
export type BlockData = {
  label?: string;
  config: IvrConfigMap[IvrNodeType];
  keepNode?: Keep;
  keepData?: Keep;
};

/** A working node — structurally a React Flow node (the store adds UI-only props). */
export interface WorkNode {
  id: string;
  type: IvrNodeType;
  position: { x: number; y: number };
  data: BlockData;
  deletable?: boolean;
}

export interface WorkEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  data?: { keep?: Keep };
}

export interface WorkGraph {
  nodes: WorkNode[];
  edges: WorkEdge[];
  viewport: IvrViewport | null;
  /** Graph-level unknown keys + blocks of unknown types, re-emitted by toGraph. */
  keepGraph: Keep;
  foreignNodes: Keep[];
}

export const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

const nano = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 10);

export function newNodeId(): string {
  return `n_${nano()}`;
}

export function newEdgeId(): string {
  return `e_${nano()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pick(record: Record<string, unknown>, known: readonly string[]): Keep | undefined {
  const out: Keep = {};
  let any = false;
  for (const [k, v] of Object.entries(record)) {
    if (!known.includes(k)) {
      out[k] = v;
      any = true;
    }
  }
  return any ? out : undefined;
}

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const ids = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isInteger(x)) : [];
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * A server config made safe to edit: every known field present with the
 * right type (defaults fill gaps), every unknown field kept as-is.
 */
export function normalizeConfig<T extends IvrNodeType>(type: T, raw: unknown): IvrConfigMap[T] {
  const base = defaultConfig(type) as unknown as Record<string, unknown>;
  const src = isRecord(raw) ? raw : {};
  const out: Record<string, unknown> = { ...base, ...src };
  switch (type) {
    case 'play':
      out.prompts = ids(src.prompts);
      break;
    case 'menu':
      out.prompts = ids(src.prompts);
      out.digits = Array.isArray(src.digits) ? sortDigits(strs(src.digits).filter(isMenuDigit)) : base.digits;
      out.timeoutSec = num(src.timeoutSec, base.timeoutSec as number);
      out.retries = num(src.retries, base.retries as number);
      if (src.invalidPrompts !== undefined) out.invalidPrompts = ids(src.invalidPrompts);
      if (src.noInputPrompts !== undefined) out.noInputPrompts = ids(src.noInputPrompts);
      break;
    case 'schedule': {
      const weekly = isRecord(src.weekly) ? src.weekly : {};
      const baseWeekly = base.weekly as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...weekly };
      for (const day of Object.keys(baseWeekly)) {
        const ranges = Array.isArray(weekly[day]) ? (weekly[day] as unknown[]) : isRecord(src.weekly) ? [] : baseWeekly[day];
        merged[day] = (ranges as unknown[])
          .filter((r): r is [string, string] => Array.isArray(r) && r.length === 2 && r.every((x) => typeof x === 'string'))
          .map((r) => [r[0], r[1]]);
      }
      out.weekly = merged;
      out.tz = typeof src.tz === 'string' ? src.tz : base.tz;
      out.closedDates = strs(src.closedDates);
      break;
    }
    case 'condition':
      out.mode = src.mode === 'equals' || src.mode === 'anonymous' ? src.mode : 'prefix';
      out.values = strs(src.values);
      break;
    case 'dial': {
      const t = isRecord(src.target) ? src.target : {};
      out.target =
        t.kind === 'external'
          ? { ...t, kind: 'external', number: typeof t.number === 'string' ? t.number : '' }
          : { ...t, kind: 'own', did: typeof t.did === 'string' ? t.did : '' };
      out.passCallerId = typeof src.passCallerId === 'boolean' ? src.passCallerId : true;
      out.ringTimeoutSec = num(src.ringTimeoutSec, 30);
      break;
    }
    case 'voicemail':
      out.did = typeof src.did === 'string' ? src.did : '';
      break;
    case 'goto':
      out.targetNodeId = typeof src.targetNodeId === 'string' ? src.targetNodeId : '';
      break;
    case 'hangup':
      if (src.prompts !== undefined) out.prompts = ids(src.prompts);
      break;
    case 'entry':
      break;
  }
  return out as unknown as IvrConfigMap[T];
}

const NODE_KEYS = ['id', 'type', 'position', 'data'] as const;
const DATA_KEYS = ['label', 'config'] as const;
const EDGE_KEYS = ['id', 'source', 'sourceHandle', 'target'] as const;
const GRAPH_KEYS = ['schemaVersion', 'nodes', 'edges', 'viewport'] as const;

/**
 * Server graph → working graph. Defensive about anything malformed: it never
 * throws, keeps what it can't render, and guarantees exactly one editable
 * Start block (a graph with none gets one at the origin).
 */
export function fromGraph(input: unknown): WorkGraph {
  const g = isRecord(input) ? input : {};
  const rawNodes = Array.isArray(g.nodes) ? g.nodes : [];
  const rawEdges = Array.isArray(g.edges) ? g.edges : [];
  const nodes: WorkNode[] = [];
  const foreignNodes: Keep[] = [];
  const seen = new Set<string>();

  for (const raw of rawNodes) {
    if (!isRecord(raw)) continue;
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!id || seen.has(id)) continue;
    if (!isIvrNodeType(raw.type)) {
      foreignNodes.push(raw);
      seen.add(id);
      continue;
    }
    const type = raw.type;
    const pos = isRecord(raw.position) ? raw.position : {};
    const data = isRecord(raw.data) ? raw.data : {};
    nodes.push({
      id,
      type,
      position: { x: num(pos.x, 0), y: num(pos.y, 0) },
      data: {
        ...(typeof data.label === 'string' && data.label !== '' ? { label: data.label } : {}),
        config: normalizeConfig(type, data.config),
        keepNode: pick(raw, NODE_KEYS),
        keepData: pick(data, DATA_KEYS),
      },
    });
    seen.add(id);
  }

  // Exactly one Start, never deletable. Extra Starts stay (validation flags them).
  const firstEntry = nodes.find((n) => n.type === 'entry');
  if (firstEntry) {
    firstEntry.deletable = false;
  } else {
    nodes.unshift({
      id: newNodeId(),
      type: 'entry',
      position: { x: 0, y: 0 },
      data: { config: {} },
      deletable: false,
    });
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: WorkEdge[] = [];
  const usedHandles = new Set<string>();
  const edgeIds = new Set<string>();
  for (const raw of rawEdges) {
    if (!isRecord(raw)) continue;
    const source = typeof raw.source === 'string' ? raw.source : '';
    const target = typeof raw.target === 'string' ? raw.target : '';
    const handle = typeof raw.sourceHandle === 'string' && raw.sourceHandle ? raw.sourceHandle : 'next';
    if (!byId.has(source) || !byId.has(target)) continue;
    if (byId.get(target)?.type === 'entry') continue;
    const slot = `${source}\u0000${handle}`;
    if (usedHandles.has(slot)) continue;
    usedHandles.add(slot);
    let id = typeof raw.id === 'string' && raw.id ? raw.id : newEdgeId();
    if (edgeIds.has(id)) id = newEdgeId();
    edgeIds.add(id);
    const keep = pick(raw, EDGE_KEYS);
    edges.push({ id, source, sourceHandle: handle, target, ...(keep ? { data: { keep } } : {}) });
  }

  const vp = isRecord(g.viewport) ? g.viewport : null;
  const viewport =
    vp && typeof vp.x === 'number' && typeof vp.y === 'number' && typeof vp.zoom === 'number'
      ? { x: vp.x, y: vp.y, zoom: vp.zoom }
      : null;

  return { nodes, edges, viewport, keepGraph: pick(g, GRAPH_KEYS) ?? {}, foreignNodes };
}

/** Minimal structural input — the store's React Flow nodes satisfy it. */
export interface NodeInput {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: BlockData;
}

export interface EdgeInput {
  id: string;
  source: string;
  sourceHandle?: string | null;
  target: string;
  data?: { keep?: Keep };
}

/** Working graph → the §2 JSON the API stores. Positions are whole pixels. */
export function toGraph(
  nodes: readonly NodeInput[],
  edges: readonly EdgeInput[],
  viewport: IvrViewport | null,
  extra: { keepGraph?: Keep; foreignNodes?: readonly Keep[] } = {},
): IvrGraph {
  const outNodes: IvrNode[] = nodes
    .filter((n) => isIvrNodeType(n.type))
    .map((n) => {
      const { label, config, keepNode, keepData } = n.data;
      return {
        ...(keepNode ?? {}),
        id: n.id,
        type: n.type as IvrNodeType,
        position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
        data: { ...(keepData ?? {}), ...(label ? { label } : {}), config },
      } as IvrNode;
    });
  const foreign = (extra.foreignNodes ?? []) as unknown as IvrNode[];
  const outEdges: IvrEdge[] = edges.map((e) => ({
    ...(e.data?.keep ?? {}),
    id: e.id,
    source: e.source,
    sourceHandle: e.sourceHandle ?? 'next',
    target: e.target,
  }));
  return {
    ...(extra.keepGraph ?? {}),
    schemaVersion: 1,
    nodes: [...outNodes, ...foreign],
    edges: outEdges,
    ...(viewport
      ? {
          viewport: {
            x: Math.round(viewport.x),
            y: Math.round(viewport.y),
            zoom: Math.round(viewport.zoom * 1000) / 1000,
          },
        }
      : {}),
  };
}

/** A graph with just a Start block (what the server seeds on create). */
export function emptyGraph(): IvrGraph {
  return {
    schemaVersion: 1,
    nodes: [{ id: newNodeId(), type: 'entry', position: { x: 0, y: 0 }, data: { config: {} } }],
    edges: [],
  };
}
