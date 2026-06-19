/**
 * RCF compiler (P2) — graph → the FLAT `rcf_numbers` shape the runtime consumes.
 *
 * RCF is deliberately the simplest product (plan §0.1 decision 2, §12 verified
 * truth): a call arrives and is forwarded to a SINGLE destination. The graph is
 * always the line `entry → dial → hangup`, and we compile it NOT to a node tree
 * but to a flat artifact mapping 1:1 onto the existing `rcf_numbers` columns:
 *
 *   { forward_to, ring_timeout?, pass_caller_id?, max_channels? }
 *
 * There is NO second-destination / failover node: `rcf_numbers.failover_to` is
 * dead code (never read by the runtime — RCF "failover" is SBC×carrier redundancy
 * to the SAME number). The palette enforces this by construction (only `dial` +
 * `hangup`); this compiler enforces it on the artifact.
 */
import type { CallFlowDoc, FlowEdge, FlowNode } from '../model/types';
import type { FlowCompiler, ValidationIssue, ValidationResult } from './types';
import { NEXT_HANDLE } from '../canvas/handles';

/** The flat artifact written to `rcf_numbers` on publish. */
export interface RcfArtifact {
  forward_to: string;
  ring_timeout?: number;
  pass_caller_id?: boolean;
  max_channels?: number;
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

/** Locate the `dial` node reached from the entry node (entry → dial). */
function findDial(doc: CallFlowDoc): FlowNode | undefined {
  const graph = buildGraph(doc);
  const entry = doc.nodes.find((n) => n.type === 'entry');
  if (!entry) return undefined;
  const first = nextTarget(graph, entry.id);
  return first?.type === 'dial' ? first : undefined;
}

/* ─── Compile ──────────────────────────────────────────────────────────── */

export function compileRcf(doc: CallFlowDoc): RcfArtifact {
  const dial = findDial(doc);
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

/* ─── Validation ───────────────────────────────────────────────────────── */

export function validateRcf(doc: CallFlowDoc): ValidationResult {
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

  // 2) Entry → exactly one Dial.
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

  // 3) Dial needs a forward destination.
  if (dial && dial.data.config.type === 'dial') {
    if (!dial.data.config.number.trim()) {
      issues.push({ severity: 'error', message: 'Forward step needs a destination number.', nodeId: dial.id });
    }
    // Dial → Hangup completes the line (warn only — the call ends regardless).
    const after = nextTarget(graph, dial.id);
    if (after && after.type !== 'hangup') {
      issues.push({ severity: 'warning', message: 'RCF forwards to a single destination — only a Hangup may follow the Forward step.', nodeId: after.id });
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

export const rcfCompiler: FlowCompiler<RcfArtifact> = {
  product: 'rcf',
  validate: validateRcf,
  compile: compileRcf,
};
