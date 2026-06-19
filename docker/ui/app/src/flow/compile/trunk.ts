/**
 * SIP-trunk inbound compiler — graph → the FLAT route-plan artifact the backend
 * writes to `trunk_dids.route_plan`.
 *
 * Trunk inbound is a focused product (plan §3 / §12): a trunk DID delivers the
 * call to the trunk's PBX endpoints, either in order (failover) or all at once
 * (parallel), with per-attempt timeouts. The graph is always the line
 * `entry → route → hangup`, and we compile it NOT to a node tree but to a flat
 * artifact:
 *
 *   {
 *     strategy: 'failover' | 'parallel',
 *     timeout: number,
 *     endpoints: [{ to, timeout? }],
 *   }
 *
 * Keys are snake_case to match the pinned backend/telephony contract — every key
 * here (`strategy`/`timeout`/`endpoints`/`to`) is already a single lowercase word,
 * so the model config (which is also single-word camelCase) maps 1:1. This mirrors
 * the UCaaS compiler's flat ring-plan, structurally: a strategy + ordered legs.
 */
import type { CallFlowDoc, FlowEdge, FlowNode } from '../model/types';
import type { FlowCompiler, ValidationIssue, ValidationResult } from './types';
import { NEXT_HANDLE } from '../canvas/handles';

/** One compiled trunk endpoint. */
export interface TrunkEndpointArtifact {
  to: string;
  timeout?: number;
}

/** The flat artifact written to `trunk_dids.route_plan` on publish. */
export interface TrunkArtifact {
  strategy: 'failover' | 'parallel';
  timeout: number;
  endpoints: TrunkEndpointArtifact[];
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

/** Locate the `route` node reached from the entry node (entry → route). */
function findRoute(graph: Graph, doc: CallFlowDoc): FlowNode | undefined {
  const entry = doc.nodes.find((n) => n.type === 'entry');
  if (!entry) return undefined;
  const first = nextTarget(graph, entry.id);
  return first?.type === 'route' ? first : undefined;
}

/* ─── Compile ──────────────────────────────────────────────────────────── */

export function compileTrunk(doc: CallFlowDoc): TrunkArtifact {
  const graph = buildGraph(doc);
  const route = findRoute(graph, doc);
  const c = route?.data.config;

  const endpoints: TrunkEndpointArtifact[] = [];
  let strategy: 'failover' | 'parallel' = 'failover';
  let timeout = 30;

  if (c?.type === 'route') {
    strategy = c.strategy;
    timeout = c.timeout;
    for (const ep of c.endpoints) {
      const to = ep.to.trim();
      if (!to) continue; // drop empty rows
      const out: TrunkEndpointArtifact = { to };
      if (typeof ep.timeout === 'number') out.timeout = ep.timeout;
      endpoints.push(out);
    }
  }

  return { strategy, timeout, endpoints };
}

/* ─── Validation ───────────────────────────────────────────────────────── */

export function validateTrunk(doc: CallFlowDoc): ValidationResult {
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

  // 2) Entry → exactly one Route.
  let route: FlowNode | undefined;
  if (entry) {
    const entryEdges = graph.out.get(entry.id) ?? [];
    if (entryEdges.length === 0) {
      issues.push({ severity: 'error', message: 'Entry node is not connected to a Route step.', nodeId: entry.id });
    } else if (entryEdges.length > 1) {
      issues.push({ severity: 'error', message: 'A trunk DID has one Route step — Entry must have a single outgoing connection.', nodeId: entry.id });
    } else {
      const first = nextTarget(graph, entry.id);
      if (first?.type === 'route') {
        route = first;
      } else {
        issues.push({ severity: 'error', message: 'Entry must connect to a Route step.', nodeId: first?.id ?? entry.id });
      }
    }
  }

  // 3) Route must have ≥1 endpoint, each with a destination.
  if (route && route.data.config.type === 'route') {
    const c = route.data.config;
    const live = c.endpoints.filter((e) => e.to.trim());
    if (live.length === 0) {
      issues.push({ severity: 'error', message: 'Route needs at least one endpoint.', nodeId: route.id });
    }
    if (c.endpoints.some((e) => !e.to.trim())) {
      issues.push({ severity: 'warning', message: 'Route has an empty endpoint row — it will be ignored.', nodeId: route.id });
    }

    // Route → Hangup completes the line (warn only — the call ends regardless).
    const after = nextTarget(graph, route.id);
    if (after && after.type !== 'hangup') {
      issues.push({ severity: 'warning', message: 'A trunk Route delivers to its endpoints — only a Hangup may follow it.', nodeId: after.id });
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

export const trunkCompiler: FlowCompiler<TrunkArtifact> = {
  product: 'trunk',
  validate: validateTrunk,
  compile: compileTrunk,
};
