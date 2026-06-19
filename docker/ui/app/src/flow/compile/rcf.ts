/**
 * RCF compiler — DUAL-MODE (plan §3 rich-RCF, §12 verified truth).
 *
 * RCF is simple by DEFAULT and rich ON DEMAND, decided purely by the graph:
 *
 *   SIMPLE  — the flow is just `entry → dial → hangup` (no advanced verb). It
 *             compiles to the FLAT artifact mapping 1:1 onto the existing
 *             `rcf_numbers` columns, UNCHANGED from the original compiler:
 *
 *                 { forward_to, ring_timeout?, pass_caller_id?, max_channels? }
 *
 *             The backend detects simple by the ABSENCE of a `rules` key.
 *
 *   RICH    — the flow contains an advanced verb (`ringGroup`, `schedule`,
 *             `condition`, or `voicemail`). It compiles to the `routing_plan`:
 *
 *                 {
 *                   rules: [
 *                     { match: null | { schedule?: {days,start,end,tz},
 *                                       caller_id?: {prefix?,equals?} },
 *                       ring:  { strategy, ring_timeout, legs: [{to, timeout?}] } },
 *                     ...
 *                   ],
 *                   fallback: { type: 'voicemail'|'forward'|'hangup', to? },
 *                 }
 *
 *             All artifact keys are snake_case exactly as the backend contract
 *             pins them (`ring_timeout`, `caller_id`). The model config stays
 *             camelCase (`ringTimeout`, `callerId`) like every other NodeConfig
 *             arm; the translation happens here.
 *
 * Walk (rich): start at the entry's successor and follow the chain.
 *   - A guard (`schedule`/`condition`) emits an ordered RULE for its POSITIVE
 *     branch (the action it points to → a `ring`), then the walk continues down
 *     its NEGATIVE (fall-through) branch — so guards stack into ordered rules.
 *   - An unguarded action (`ringGroup`, or a `dial` that still has a successor)
 *     becomes a `match: null` DEFAULT rule; the walk continues to its successor.
 *   - A terminal (`voicemail`, `hangup`, or a `dial` with no successor) becomes
 *     the single global `fallback`.
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

/** SIMPLE: the flat artifact written to `rcf_numbers` columns. No `rules` key. */
export interface RcfArtifact {
  forward_to: string;
  ring_timeout?: number;
  pass_caller_id?: boolean;
  max_channels?: number;
}

/** RICH: one compiled ring leg. */
export interface RcfRingLeg {
  to: string;
  timeout?: number;
}

/** RICH: the ring action a rule performs. */
export interface RcfRing {
  strategy: 'sequential' | 'parallel';
  ring_timeout: number;
  legs: RcfRingLeg[];
}

/** RICH: a rule's guard. `null` = the unconditional default rule. */
export interface RcfMatch {
  schedule?: { days: string[]; start: string; end: string; tz: string };
  caller_id?: { prefix?: string; equals?: string };
}

/** RICH: one ordered routing rule. */
export interface RcfRule {
  match: RcfMatch | null;
  ring: RcfRing;
}

/** RICH: the terminal fallback once every rule is exhausted. */
export type RcfFallback =
  | { type: 'voicemail' }
  | { type: 'forward'; to: string }
  | { type: 'hangup' };

/** RICH: the `routing_plan` artifact. Detected by the backend via the `rules` key. */
export interface RcfRoutingPlan {
  rules: RcfRule[];
  fallback: RcfFallback;
}

/** Either compiled shape — simple (flat) or rich (routing_plan). */
export type RcfCompiled = RcfArtifact | RcfRoutingPlan;

/* ─── Mode detection ───────────────────────────────────────────────────── */

/** Advanced verbs that flip RCF into rich (`routing_plan`) mode. */
const ADVANCED_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
  'ringGroup',
  'schedule',
  'condition',
  'voicemail',
]);

/** True when the graph contains any advanced verb → compile to a routing_plan. */
export function isRichRcf(doc: CallFlowDoc): boolean {
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

function isGuard(type: NodeType): boolean {
  return type === 'schedule' || type === 'condition';
}

function isAction(type: NodeType): boolean {
  return type === 'ringGroup' || type === 'dial';
}

function posHandle(type: NodeType): string {
  return type === 'schedule' ? SCHEDULE_IN : COND_MATCH;
}

function negHandle(type: NodeType): string {
  return type === 'schedule' ? SCHEDULE_ELSE : COND_NOMATCH;
}

/* ─── Rich mappers (camelCase config → snake_case artifact) ─────────────── */

/** A guard node → the `match` guard for its rule. */
function matchFromGuard(node: FlowNode): RcfMatch {
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

/** An action node (`ringGroup`/`dial`) → the `ring` it performs. */
function ringFrom(node: FlowNode): RcfRing {
  const c = node.data.config;
  if (c.type === 'ringGroup') {
    const legs: RcfRingLeg[] = [];
    for (const leg of c.legs) {
      const to = leg.to.trim();
      if (!to) continue;
      legs.push(leg.timeout !== undefined ? { to, timeout: leg.timeout } : { to });
    }
    return { strategy: c.strategy, ring_timeout: c.ringTimeout, legs };
  }
  if (c.type === 'dial') {
    return { strategy: 'sequential', ring_timeout: c.timeout, legs: [{ to: c.number.trim() }] };
  }
  return { strategy: 'sequential', ring_timeout: 30, legs: [] };
}

/** A terminal node → the global `fallback`. */
function fallbackFrom(node: FlowNode | undefined): RcfFallback {
  const c = node?.data.config;
  if (c?.type === 'voicemail') return { type: 'voicemail' };
  if (c?.type === 'dial') return { type: 'forward', to: c.number.trim() };
  return { type: 'hangup' };
}

/* ─── Compile (rich) ───────────────────────────────────────────────────── */

export function compileRichRcf(doc: CallFlowDoc): RcfRoutingPlan {
  const graph = buildGraph(doc);
  const entry = doc.nodes.find((n) => n.type === 'entry');
  const rules: RcfRule[] = [];
  let fallback: RcfFallback = { type: 'hangup' };

  const visited = new Set<string>();
  let cursor = entry ? nextTarget(graph, entry.id) : undefined;

  while (cursor && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    const type = cursor.type;

    if (isGuard(type)) {
      const pos = targetByHandle(graph, cursor.id, posHandle(type));
      if (pos && isAction(pos.type)) {
        rules.push({ match: matchFromGuard(cursor), ring: ringFrom(pos) });
      }
      cursor = targetByHandle(graph, cursor.id, negHandle(type));
      continue;
    }

    if (type === 'ringGroup') {
      rules.push({ match: null, ring: ringFrom(cursor) });
      cursor = nextTarget(graph, cursor.id);
      continue;
    }

    if (type === 'dial') {
      const after = nextTarget(graph, cursor.id);
      if (after) {
        // Unguarded dial that still leads somewhere → a default ring rule; its
        // successor is the global fallback.
        rules.push({ match: null, ring: ringFrom(cursor) });
        cursor = after;
        continue;
      }
      // Terminal dial → forward fallback.
      fallback = fallbackFrom(cursor);
      break;
    }

    // voicemail / hangup (or any other terminal) → global fallback.
    fallback = fallbackFrom(cursor);
    break;
  }

  return { rules, fallback };
}

/* ─── Compile (simple — UNCHANGED flat artifact) ───────────────────────── */

/** Locate the `dial` node reached from the entry node (entry → dial). */
function findDial(graph: Graph, doc: CallFlowDoc): FlowNode | undefined {
  const entry = doc.nodes.find((n) => n.type === 'entry');
  if (!entry) return undefined;
  const first = nextTarget(graph, entry.id);
  return first?.type === 'dial' ? first : undefined;
}

export function compileSimpleRcf(doc: CallFlowDoc): RcfArtifact {
  const dial = findDial(buildGraph(doc), doc);
  const c = dial?.data.config;
  const artifact: RcfArtifact = {
    forward_to: c?.type === 'dial' ? c.number.trim() : '',
  };
  if (c?.type === 'dial') {
    if (typeof c.timeout === 'number') artifact.ring_timeout = c.timeout;
    if (c.passCallerId !== undefined) artifact.pass_caller_id = c.passCallerId;
    if (c.maxChannels !== undefined) artifact.max_channels = c.maxChannels;
  }
  return artifact;
}

/* ─── Compile (dispatch) ───────────────────────────────────────────────── */

export function compileRcf(doc: CallFlowDoc): RcfCompiled {
  return isRichRcf(doc) ? compileRichRcf(doc) : compileSimpleRcf(doc);
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

export function validateSimpleRcf(doc: CallFlowDoc): ValidationResult {
  const issues: ValidationIssue[] = [];
  const graph = buildGraph(doc);

  const entry = checkEntry(doc, issues);

  // Entry → exactly one Dial.
  let dial: FlowNode | undefined;
  if (entry) {
    const entryEdges = graph.out.get(entry.id) ?? [];
    if (entryEdges.length === 0) {
      issues.push({ severity: 'error', message: 'Entry node is not connected to a Forward step.', nodeId: entry.id });
    } else if (entryEdges.length > 1) {
      issues.push({ severity: 'error', message: 'RCF allows a single forward destination — Entry must have one outgoing connection.', nodeId: entry.id });
    } else {
      const first = nextTarget(graph, entry.id);
      if (first?.type === 'dial') {
        dial = first;
      } else {
        issues.push({ severity: 'error', message: 'Entry must connect to a Forward (Dial) step.', nodeId: first?.id ?? entry.id });
      }
    }
  }

  // Dial needs a forward destination.
  if (dial && dial.data.config.type === 'dial') {
    if (!dial.data.config.number.trim()) {
      issues.push({ severity: 'error', message: 'Forward step needs a destination number.', nodeId: dial.id });
    }
    const after = nextTarget(graph, dial.id);
    if (after && after.type !== 'hangup') {
      issues.push({ severity: 'warning', message: 'RCF forwards to a single destination — only a Hangup may follow the Forward step.', nodeId: after.id });
    }
  }

  checkReachability(doc, graph, entry, issues);

  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

/* ─── Validation (rich) ────────────────────────────────────────────────── */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateRichRcf(doc: CallFlowDoc): ValidationResult {
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
    } else if (c.type === 'ringGroup') {
      if (c.legs.filter((l) => l.to.trim()).length === 0) {
        issues.push({ severity: 'error', message: 'Ring Group needs at least one destination.', nodeId: n.id });
      }
      if (c.legs.some((l) => !l.to.trim())) {
        issues.push({ severity: 'warning', message: 'Ring Group has an empty destination row — it will be ignored.', nodeId: n.id });
      }
    } else if (c.type === 'dial') {
      if (!c.number.trim()) {
        issues.push({ severity: 'error', message: 'Forward step needs a destination number.', nodeId: n.id });
      }
    }
  }

  // Structural: the compiled plan must have ≥1 rule and a valid fallback.
  const plan = compileRichRcf(doc);
  if (plan.rules.length === 0) {
    issues.push({ severity: 'error', message: 'Add at least one routing rule — a schedule/condition branch or a default Ring Group / Forward.' });
  }
  if (plan.fallback.type === 'forward' && !plan.fallback.to) {
    issues.push({ severity: 'error', message: 'Forward fallback needs a destination number.' });
  }

  checkReachability(doc, graph, entry, issues);

  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

/* ─── Validation (dispatch) ────────────────────────────────────────────── */

export function validateRcf(doc: CallFlowDoc): ValidationResult {
  return isRichRcf(doc) ? validateRichRcf(doc) : validateSimpleRcf(doc);
}

/* ─── Compiler registration ────────────────────────────────────────────── */

export const rcfCompiler: FlowCompiler<RcfCompiled> = {
  product: 'rcf',
  validate: validateRcf,
  compile: compileRcf,
};
