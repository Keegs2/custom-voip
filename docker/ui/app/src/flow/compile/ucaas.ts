/**
 * UCaaS (find-me/follow-me) compiler — graph → the FLAT ring-plan artifact the
 * backend writes to `extensions.ring_plan`.
 *
 * UCaaS is a focused product (plan §3): an extension rings a group of
 * destinations, then falls back to voicemail / forward / hangup. The graph is
 * always the line `entry → ringGroup → <fallback node>`, and we compile it NOT
 * to a node tree but to a flat artifact:
 *
 *   {
 *     strategy: 'sequential' | 'parallel',
 *     ring_timeout: number,
 *     legs: [{ to, timeout? }],
 *     fallback: { type: 'voicemail' | 'forward' | 'hangup', to? },
 *   }
 *
 * Keys are snake_case (`ring_timeout`) to match the pinned backend contract.
 * The `fallback` is derived from the node AFTER the ringGroup:
 *   - `voicemail` node → { type: 'voicemail' }
 *   - `dial` node     → { type: 'forward', to: <number> }
 *   - `hangup` node   → { type: 'hangup' }
 *
 * The model config uses camelCase (`ringTimeout`) like every other NodeConfig
 * arm; the snake_case translation happens here, exactly as the RCF compiler maps
 * `timeout`/`passCallerId` → `ring_timeout`/`pass_caller_id`.
 */
import type { CallFlowDoc, FlowEdge, FlowNode } from '../model/types';
import type { FlowCompiler, ValidationIssue, ValidationResult } from './types';
import { NEXT_HANDLE } from '../canvas/handles';

/** One compiled ring leg. */
export interface RingLegArtifact {
  to: string;
  timeout?: number;
}

/** The terminal fallback once the ring group is exhausted. */
export type UcaasFallback =
  | { type: 'voicemail' }
  | { type: 'forward'; to: string }
  | { type: 'hangup' };

/** The flat artifact written to `extensions.ring_plan` on publish. */
export interface UcaasArtifact {
  strategy: 'sequential' | 'parallel';
  ring_timeout: number;
  legs: RingLegArtifact[];
  fallback: UcaasFallback;
}

/* ─── Internal graph helpers ───────────────────────────────────────────── */

interface Graph {
  byId: Map<string, FlowNode>;
  out: Map<string, FlowEdge[]>;
}

function buildGraph(doc: CallFlowDoc): Graph {
  const byId = new Map<string, FlowNode>();
  for (const n of doc.nodes) byId.set(n.id, n);
  const out = new Map<string, FlowEdge[]>();
  for (const e of doc.edges) {
    const list = out.get(e.source);
    if (list) list.push(e);
    else out.set(e.source, [e]);
  }
  return { byId, out };
}

/** The single sequential (`next`) successor of a node, if any. */
function nextTarget(graph: Graph, id: string): FlowNode | undefined {
  const edges = graph.out.get(id);
  if (!edges) return undefined;
  const seq = edges.find((e) => e.sourceHandle == null || e.sourceHandle === NEXT_HANDLE);
  return seq ? graph.byId.get(seq.target) : undefined;
}

/** Locate the `ringGroup` reached from the entry node (entry → ringGroup). */
function findRingGroup(graph: Graph, doc: CallFlowDoc): FlowNode | undefined {
  const entry = doc.nodes.find((n) => n.type === 'entry');
  if (!entry) return undefined;
  const first = nextTarget(graph, entry.id);
  return first?.type === 'ringGroup' ? first : undefined;
}

/** Derive the flat fallback from the node after the ring group. */
function deriveFallback(node: FlowNode | undefined): UcaasFallback {
  const c = node?.data.config;
  if (c?.type === 'voicemail') return { type: 'voicemail' };
  if (c?.type === 'dial') return { type: 'forward', to: c.number.trim() };
  // `hangup` (or no/unknown fallback node) → end the call.
  return { type: 'hangup' };
}

/* ─── Compile ──────────────────────────────────────────────────────────── */

export function compileUcaas(doc: CallFlowDoc): UcaasArtifact {
  const graph = buildGraph(doc);
  const ring = findRingGroup(graph, doc);
  const c = ring?.data.config;

  const legs: RingLegArtifact[] = [];
  let strategy: 'sequential' | 'parallel' = 'sequential';
  let ring_timeout = 30;

  if (c?.type === 'ringGroup') {
    strategy = c.strategy;
    ring_timeout = c.ringTimeout;
    for (const leg of c.legs) {
      const to = leg.to.trim();
      if (!to) continue; // drop empty rows
      const out: RingLegArtifact = { to };
      if (typeof leg.timeout === 'number') out.timeout = leg.timeout;
      legs.push(out);
    }
  }

  const fallback = deriveFallback(ring ? nextTarget(graph, ring.id) : undefined);
  return { strategy, ring_timeout, legs, fallback };
}

/* ─── Validation ───────────────────────────────────────────────────────── */

export function validateUcaas(doc: CallFlowDoc): ValidationResult {
  const issues: ValidationIssue[] = [];
  const graph = buildGraph(doc);

  // 1) Exactly one entry node.
  const entries = doc.nodes.filter((n) => n.type === 'entry');
  if (entries.length === 0) {
    issues.push({ severity: 'error', message: 'Flow needs exactly one Entry (Call Arrives) node.' });
  } else if (entries.length > 1) {
    for (const extra of entries.slice(1)) {
      issues.push({ severity: 'error', message: 'Only one Entry node is allowed.', nodeId: extra.id });
    }
  }
  const entry = entries[0];

  // 2) Entry → exactly one Ring Group.
  let ring: FlowNode | undefined;
  if (entry) {
    const entryEdges = graph.out.get(entry.id) ?? [];
    if (entryEdges.length === 0) {
      issues.push({ severity: 'error', message: 'Entry node is not connected to a Ring Group.', nodeId: entry.id });
    } else if (entryEdges.length > 1) {
      issues.push({ severity: 'error', message: 'A find-me/follow-me plan has one Ring Group — Entry must have a single outgoing connection.', nodeId: entry.id });
    } else {
      const first = nextTarget(graph, entry.id);
      if (first?.type === 'ringGroup') {
        ring = first;
      } else {
        issues.push({ severity: 'error', message: 'Entry must connect to a Ring Group.', nodeId: first?.id ?? entry.id });
      }
    }
  }

  // 3) Ring Group must have ≥1 leg, each with a destination, and a fallback.
  if (ring && ring.data.config.type === 'ringGroup') {
    const c = ring.data.config;
    const live = c.legs.filter((l) => l.to.trim());
    if (live.length === 0) {
      issues.push({ severity: 'error', message: 'Ring Group needs at least one destination.', nodeId: ring.id });
    }
    if (c.legs.some((l) => !l.to.trim())) {
      issues.push({ severity: 'warning', message: 'Ring Group has an empty destination row — it will be ignored.', nodeId: ring.id });
    }

    // Exactly one fallback after the ring group.
    const ringEdges = graph.out.get(ring.id) ?? [];
    if (ringEdges.length === 0) {
      issues.push({ severity: 'error', message: 'Ring Group needs a fallback (voicemail, forward, or hangup) for unanswered calls.', nodeId: ring.id });
    } else {
      if (ringEdges.length > 1) {
        issues.push({ severity: 'warning', message: 'Ring Group has multiple fallback connections — only the first is used.', nodeId: ring.id });
      }
      const fb = nextTarget(graph, ring.id);
      if (!fb || !['voicemail', 'dial', 'hangup'].includes(fb.type)) {
        issues.push({ severity: 'error', message: 'Ring Group fallback must be a Voicemail, Forward (Dial), or Hangup node.', nodeId: fb?.id ?? ring.id });
      } else if (fb.type === 'dial' && fb.data.config.type === 'dial' && !fb.data.config.number.trim()) {
        issues.push({ severity: 'error', message: 'Forward fallback needs a destination number.', nodeId: fb.id });
      }
    }
  }

  // 4) Reachability — every node must be reachable from entry.
  const reachable = new Set<string>();
  if (entry) {
    const stack = [entry.id];
    while (stack.length) {
      const id = stack.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const e of graph.out.get(id) ?? []) stack.push(e.target);
    }
  }
  for (const n of doc.nodes) {
    if (n.type === 'entry') continue;
    if (!reachable.has(n.id)) {
      issues.push({ severity: 'error', message: `"${n.data.label ?? n.type}" is unreachable from Entry.`, nodeId: n.id });
    }
  }

  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

/* ─── Compiler registration ────────────────────────────────────────────── */

export const ucaasCompiler: FlowCompiler<UcaasArtifact> = {
  product: 'ucaas',
  validate: validateUcaas,
  compile: compileUcaas,
};
