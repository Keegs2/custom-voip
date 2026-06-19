/**
 * SIP-trunk inbound compiler — DUAL-MODE (mirrors the rich-RCF compiler).
 *
 * Trunk inbound is SIMPLE by DEFAULT and RICH ON DEMAND, decided purely by the
 * graph — exactly like RCF:
 *
 *   SIMPLE  — the flow is just `entry → route → hangup` (no advanced verb). It
 *             compiles to the FLAT artifact the backend writes to
 *             `trunk_dids.route_plan`, UNCHANGED from the original compiler:
 *
 *                 { strategy, timeout, endpoints: [{ to, timeout? }] }
 *
 *             The backend detects simple by the ABSENCE of a `rules` key.
 *
 *   RICH    — the flow contains an advanced verb (`schedule` or `condition`). It
 *             compiles to an ordered route plan:
 *
 *                 {
 *                   rules: [
 *                     { match: null | { schedule?: {days,start,end,tz},
 *                                       caller_id?: {prefix?,equals?} },
 *                       strategy, timeout, endpoints: [{ to, timeout? }] },
 *                     ...
 *                   ],
 *                 }
 *
 *             The backend detects rich by the `rules` key. All artifact keys are
 *             snake_case as the pinned backend/telephony contract requires
 *             (`caller_id`); the model config stays camelCase (`callerId`) like
 *             every other NodeConfig arm — the translation happens here.
 *
 * Walk (rich): start at the entry's successor and follow the chain — IDENTICAL in
 * spirit to `compileRichRcf`, only each rule's ACTION is a `route` delivery
 * (`{strategy,timeout,endpoints}`) instead of RCF's `ring`.
 *   - A guard (`schedule`/`condition`) emits an ordered RULE for its POSITIVE
 *     branch (the `route` it points to), then the walk continues down its NEGATIVE
 *     (fall-through) branch — so guards stack into ordered rules.
 *   - An unguarded `route` becomes a `match: null` DEFAULT rule; the walk continues
 *     to its successor (typically `hangup`, which ends the walk).
 */
import type { CallFlowDoc, FlowEdge, FlowNode, NodeType } from '../model/types';
import type { FlowCompiler, ValidationIssue, ValidationResult } from './types';
import {
  NEXT_HANDLE,
  SCHEDULE_IN,
  SCHEDULE_ELSE,
  COND_MATCH,
  COND_NOMATCH,
} from '../canvas/handles';

/* ─── Artifacts ────────────────────────────────────────────────────────── */

/** One compiled trunk endpoint. */
export interface TrunkEndpointArtifact {
  to: string;
  timeout?: number;
}

/** SIMPLE: the flat artifact written to `trunk_dids.route_plan`. No `rules` key. */
export interface TrunkArtifact {
  strategy: 'failover' | 'parallel';
  timeout: number;
  endpoints: TrunkEndpointArtifact[];
}

/** RICH: a rule's guard. `null` = the unconditional default rule. */
export interface TrunkMatch {
  schedule?: { days: string[]; start: string; end: string; tz: string };
  caller_id?: { prefix?: string; equals?: string };
}

/** RICH: one ordered routing rule — a guard plus the `route` delivery it performs. */
export interface TrunkRule {
  match: TrunkMatch | null;
  strategy: 'failover' | 'parallel';
  timeout: number;
  endpoints: TrunkEndpointArtifact[];
}

/** RICH: the ordered route plan. Detected by the backend via the `rules` key. */
export interface TrunkRoutePlan {
  rules: TrunkRule[];
}

/** Either compiled shape — simple (flat) or rich (rules). */
export type TrunkCompiled = TrunkArtifact | TrunkRoutePlan;

/* ─── Mode detection ───────────────────────────────────────────────────── */

/** Advanced verbs that flip trunk inbound into rich (`rules`) mode. */
const ADVANCED_TYPES: ReadonlySet<NodeType> = new Set<NodeType>(['schedule', 'condition']);

/** True when the graph contains any advanced verb → compile to an ordered route plan. */
export function isRichTrunk(doc: CallFlowDoc): boolean {
  return doc.nodes.some((n) => ADVANCED_TYPES.has(n.type));
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

/** The successor reached via a specific source handle (branch), if any. */
function targetByHandle(graph: Graph, id: string, handle: string): FlowNode | undefined {
  const edges = graph.out.get(id);
  if (!edges) return undefined;
  const e = edges.find((edge) => edge.sourceHandle === handle);
  return e ? graph.byId.get(e.target) : undefined;
}

/** Locate the `route` node reached from the entry node (entry → route). */
function findRoute(graph: Graph, doc: CallFlowDoc): FlowNode | undefined {
  const entry = doc.nodes.find((n) => n.type === 'entry');
  if (!entry) return undefined;
  const first = nextTarget(graph, entry.id);
  return first?.type === 'route' ? first : undefined;
}

function isGuard(type: NodeType): boolean {
  return type === 'schedule' || type === 'condition';
}

function posHandle(type: NodeType): string {
  return type === 'schedule' ? SCHEDULE_IN : COND_MATCH;
}

function negHandle(type: NodeType): string {
  return type === 'schedule' ? SCHEDULE_ELSE : COND_NOMATCH;
}

/* ─── Shared mappers (camelCase config → snake_case artifact) ───────────── */

/** A `route` config → its compiled `{to,timeout?}` endpoints (drops empty rows). */
function endpointsFromRoute(c: Extract<FlowNode['data']['config'], { type: 'route' }>): TrunkEndpointArtifact[] {
  const endpoints: TrunkEndpointArtifact[] = [];
  for (const ep of c.endpoints) {
    const to = ep.to.trim();
    if (!to) continue; // drop empty rows
    const out: TrunkEndpointArtifact = { to };
    if (typeof ep.timeout === 'number') out.timeout = ep.timeout;
    endpoints.push(out);
  }
  return endpoints;
}

/** A guard node → the `match` guard for its rule. */
function matchFromGuard(node: FlowNode): TrunkMatch {
  const c = node.data.config;
  if (c.type === 'schedule') {
    return { schedule: { days: c.days, start: c.start, end: c.end, tz: c.tz } };
  }
  if (c.type === 'condition') {
    const caller_id: { prefix?: string; equals?: string } = {};
    if (c.callerId.prefix?.trim()) caller_id.prefix = c.callerId.prefix.trim();
    if (c.callerId.equals?.trim()) caller_id.equals = c.callerId.equals.trim();
    return { caller_id };
  }
  return {};
}

/** A `route` action node + a guard → one ordered rule. */
function ruleFrom(match: TrunkMatch | null, routeNode: FlowNode): TrunkRule {
  const c = routeNode.data.config;
  if (c.type === 'route') {
    return { match, strategy: c.strategy, timeout: c.timeout, endpoints: endpointsFromRoute(c) };
  }
  return { match, strategy: 'failover', timeout: 30, endpoints: [] };
}

/* ─── Compile (rich) ───────────────────────────────────────────────────── */

export function compileRichTrunk(doc: CallFlowDoc): TrunkRoutePlan {
  const graph = buildGraph(doc);
  const entry = doc.nodes.find((n) => n.type === 'entry');
  const rules: TrunkRule[] = [];

  const visited = new Set<string>();
  let cursor = entry ? nextTarget(graph, entry.id) : undefined;

  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    const type = cursor.type;

    if (isGuard(type)) {
      const pos = targetByHandle(graph, cursor.id, posHandle(type));
      if (pos && pos.type === 'route') {
        rules.push(ruleFrom(matchFromGuard(cursor), pos));
      }
      cursor = targetByHandle(graph, cursor.id, negHandle(type));
      continue;
    }

    if (type === 'route') {
      // Unguarded route → the `match: null` default rule; continue to its successor.
      rules.push(ruleFrom(null, cursor));
      cursor = nextTarget(graph, cursor.id);
      continue;
    }

    // hangup (or any other terminal) → the walk ends.
    break;
  }

  return { rules };
}

/* ─── Compile (simple — UNCHANGED flat artifact) ───────────────────────── */

export function compileSimpleTrunk(doc: CallFlowDoc): TrunkArtifact {
  const graph = buildGraph(doc);
  const route = findRoute(graph, doc);
  const c = route?.data.config;

  let strategy: 'failover' | 'parallel' = 'failover';
  let timeout = 30;
  let endpoints: TrunkEndpointArtifact[] = [];

  if (c?.type === 'route') {
    strategy = c.strategy;
    timeout = c.timeout;
    endpoints = endpointsFromRoute(c);
  }

  return { strategy, timeout, endpoints };
}

/* ─── Compile (dispatch) ───────────────────────────────────────────────── */

export function compileTrunk(doc: CallFlowDoc): TrunkCompiled {
  return isRichTrunk(doc) ? compileRichTrunk(doc) : compileSimpleTrunk(doc);
}

/* ─── Validation shared helpers ────────────────────────────────────────── */

/** Push the standard "exactly one entry" findings; returns the first entry. */
function checkEntry(doc: CallFlowDoc, issues: ValidationIssue[]): FlowNode | undefined {
  const entries = doc.nodes.filter((n) => n.type === 'entry');
  if (entries.length === 0) {
    issues.push({ severity: 'error', message: 'Flow needs exactly one Entry (Call Arrives) node.' });
  } else if (entries.length > 1) {
    for (const extra of entries.slice(1)) {
      issues.push({ severity: 'error', message: 'Only one Entry node is allowed.', nodeId: extra.id });
    }
  }
  return entries[0];
}

/** Push reachability findings — every non-entry node must be reachable from entry. */
function checkReachability(doc: CallFlowDoc, graph: Graph, entry: FlowNode | undefined, issues: ValidationIssue[]): void {
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
}

/* ─── Validation (simple — UNCHANGED) ──────────────────────────────────── */

export function validateSimpleTrunk(doc: CallFlowDoc): ValidationResult {
  const issues: ValidationIssue[] = [];
  const graph = buildGraph(doc);

  const entry = checkEntry(doc, issues);

  // Entry → exactly one Route.
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

  // Route must have ≥1 endpoint, each with a destination.
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

  checkReachability(doc, graph, entry, issues);

  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

/* ─── Validation (rich) ────────────────────────────────────────────────── */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateRichTrunk(doc: CallFlowDoc): ValidationResult {
  const issues: ValidationIssue[] = [];
  const graph = buildGraph(doc);

  const entry = checkEntry(doc, issues);
  if (entry) {
    const entryEdges = graph.out.get(entry.id) ?? [];
    if (entryEdges.length === 0) {
      issues.push({ severity: 'error', message: 'Entry node is not connected to the first routing step.', nodeId: entry.id });
    }
  }

  // Per-node well-formedness.
  for (const n of doc.nodes) {
    const c = n.data.config;
    if (c.type === 'schedule') {
      if (c.days.length === 0) {
        issues.push({ severity: 'error', message: 'Schedule needs at least one active day.', nodeId: n.id });
      }
      if (!HHMM.test(c.start) || !HHMM.test(c.end)) {
        issues.push({ severity: 'error', message: 'Schedule needs a valid start and end time (HH:MM).', nodeId: n.id });
      }
      if (!c.tz.trim()) {
        issues.push({ severity: 'error', message: 'Schedule needs a timezone.', nodeId: n.id });
      }
      if (!targetByHandle(graph, n.id, SCHEDULE_IN)) {
        issues.push({ severity: 'warning', message: 'Schedule “In window” branch is not connected — it routes nowhere.', nodeId: n.id });
      }
    } else if (c.type === 'condition') {
      if (!c.callerId.prefix?.trim() && !c.callerId.equals?.trim()) {
        issues.push({ severity: 'error', message: 'Condition needs a caller-ID prefix or an exact match.', nodeId: n.id });
      }
      if (!targetByHandle(graph, n.id, COND_MATCH)) {
        issues.push({ severity: 'warning', message: 'Condition “Match” branch is not connected — it routes nowhere.', nodeId: n.id });
      }
    } else if (c.type === 'route') {
      const live = c.endpoints.filter((e) => e.to.trim());
      if (live.length === 0) {
        issues.push({ severity: 'error', message: 'Route needs at least one endpoint.', nodeId: n.id });
      }
      if (c.endpoints.some((e) => !e.to.trim())) {
        issues.push({ severity: 'warning', message: 'Route has an empty endpoint row — it will be ignored.', nodeId: n.id });
      }
    }
  }

  // Structural: the compiled plan must have ≥1 rule.
  const plan = compileRichTrunk(doc);
  if (plan.rules.length === 0) {
    issues.push({ severity: 'error', message: 'Add at least one routing rule — a schedule/condition branch or a default Route.' });
  }

  checkReachability(doc, graph, entry, issues);

  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

/* ─── Validation (dispatch) ────────────────────────────────────────────── */

export function validateTrunk(doc: CallFlowDoc): ValidationResult {
  return isRichTrunk(doc) ? validateRichTrunk(doc) : validateSimpleTrunk(doc);
}

/* ─── Compiler registration ────────────────────────────────────────────── */

export const trunkCompiler: FlowCompiler<TrunkCompiled> = {
  product: 'trunk',
  validate: validateTrunk,
  compile: compileTrunk,
};
