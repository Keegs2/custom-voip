/**
 * IVR compiler (P1) — graph → the nested IVR tree `ivr.py` already consumes.
 *
 * The runtime sink is `ivr_flows.flow_config`, walked by
 * `routers/ivr.py:_node_to_xml` / `generate_xml` / `_find_gather_node` and the
 * `/ivr/webhook/{id}` branch handler. We emit EXACTLY that shape:
 *
 *   { nodes: [ { id, type, config, prompt?, branches? } ] }
 *
 * with `type` pinned to `say | play | pause | gather | dial | record |
 * redirect | reject | hangup | conference`. (`entry` is the trigger, not a
 * runtime verb — compilation starts from the node the entry points at.)
 *
 * Graph → tree mapping (mirrors the legacy `ivrUtils.nodesToXml` semantics):
 *  - The main sequence is the linear `next`-handle chain from `entry`.
 *  - A run of Say/Play/Pause nodes that flows straight into a `menu` is folded
 *    into that Gather's `prompt[]` (played while collecting input); otherwise
 *    those nodes stay as top-level siblings.
 *  - A `menu` becomes a `gather`; each per-digit / timeout / noMatch edge
 *    becomes a `branches[key]` sub-sequence (compiled by the same walk).
 *  - A Gather ends the linear flow — continuation happens through its branches
 *    (served via the webhook), exactly like the runtime expects.
 */
import type { CallFlowDoc, FlowEdge, FlowNode, NodeConfig } from '../model/types';
import type { FlowCompiler, ValidationIssue, ValidationResult } from './types';
import {
  MENU_NOMATCH,
  MENU_TIMEOUT,
  NEXT_HANDLE,
  handleToBranchKey,
  isDigitHandle,
  isTerminalType,
} from '../canvas/handles';

/** A node in the compiled tree `ivr.py` reads from `ivr_flows.flow_config`. */
export type CompiledType =
  | 'say'
  | 'play'
  | 'pause'
  | 'gather'
  | 'dial'
  | 'record'
  | 'redirect'
  | 'reject'
  | 'hangup'
  | 'conference';

export interface CompiledNode {
  id: string;
  type: CompiledType;
  config: Record<string, unknown>;
  /** Prompt verbs nested inside a <Gather>. */
  prompt?: CompiledNode[];
  /** Gather branch routing, keyed by digit / 'timeout' / 'default'. */
  branches?: Record<string, CompiledNode[]>;
}

export interface IvrArtifact {
  nodes: CompiledNode[];
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
function nextTarget(graph: Graph, id: string): string | undefined {
  const edges = graph.out.get(id);
  if (!edges) return undefined;
  const seq = edges.find(
    (e) => e.sourceHandle == null || e.sourceHandle === NEXT_HANDLE,
  );
  return seq?.target;
}

/** Drop undefined / null / empty-string values so the artifact stays tidy. */
function clean(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}

/** Compile a single non-menu node into its runtime verb shape. */
function compileLeaf(node: FlowNode): CompiledNode {
  const c = node.data.config as NodeConfig;
  const id = node.id;
  switch (c.type) {
    case 'say':
      return { id, type: 'say', config: clean({ text: c.text, voice: c.voice, language: c.language }) };
    case 'play':
      return { id, type: 'play', config: clean({ url: c.url, loop: c.loop }) };
    case 'pause':
      // Runtime reads `config.length` (<Pause length="N"/>).
      return { id, type: 'pause', config: clean({ length: c.seconds }) };
    case 'dial':
      return { id, type: 'dial', config: clean({ number: c.number, callerId: c.callerId, timeout: c.timeout, record: c.record }) };
    case 'record':
      return { id, type: 'record', config: clean({ maxLength: c.maxLength, playBeep: c.playBeep, finishOnKey: c.finishOnKey, transcribe: c.transcribe }) };
    case 'redirect':
      return { id, type: 'redirect', config: clean({ url: c.url, method: c.method }) };
    case 'reject':
      return { id, type: 'reject', config: clean({ reason: c.reason }) };
    case 'hangup':
      return { id, type: 'hangup', config: {} };
    case 'conference':
      return { id, type: 'conference', config: clean({ room: c.room, muted: c.muted, beep: c.beep, waitForModerator: c.waitForModerator, maxParticipants: c.maxParticipants, record: c.record }) };
    default:
      // entry/menu/non-IVR types never reach compileLeaf.
      return { id, type: 'hangup', config: {} };
  }
}

function compileGather(
  graph: Graph,
  node: FlowNode,
  promptNodes: FlowNode[],
  visiting: ReadonlySet<string>,
): CompiledNode {
  const c = node.data.config;
  const prompt: CompiledNode[] = [];
  if (c.type === 'menu' && c.prompt && c.prompt.trim()) {
    prompt.push({ id: `${node.id}_prompt`, type: 'say', config: clean({ text: c.prompt, voice: c.voice }) });
  }
  for (const p of promptNodes) prompt.push(compileLeaf(p));

  const branches: Record<string, CompiledNode[]> = {};
  for (const edge of graph.out.get(node.id) ?? []) {
    const handle = edge.sourceHandle;
    if (!handle) continue;
    branches[handleToBranchKey(handle)] = walkChain(graph, edge.target, visiting);
  }

  const numDigits = c.type === 'menu' ? c.numDigits ?? 1 : 1;
  const timeout = c.type === 'menu' ? c.timeout : undefined;
  const finishOnKey = c.type === 'menu' ? c.finishOnKey : undefined;

  return {
    id: node.id,
    type: 'gather',
    config: clean({ numDigits, timeout, finishOnKey }),
    prompt: prompt.length ? prompt : undefined,
    branches,
  };
}

/**
 * Walk a linear `next` chain from `startId`, folding leading Say/Play/Pause
 * runs into a following Gather's prompt. `visiting` guards against loops on a
 * single path; branches fork with a fresh copy so convergence is allowed.
 */
function walkChain(
  graph: Graph,
  startId: string | undefined,
  visiting: ReadonlySet<string>,
): CompiledNode[] {
  const out: CompiledNode[] = [];
  const local = new Set(visiting);
  let promptBuf: FlowNode[] = [];
  let currentId = startId;

  while (currentId) {
    if (local.has(currentId)) break; // loop guard
    local.add(currentId);
    const node = graph.byId.get(currentId);
    if (!node) break;
    const t = node.type;

    if (t === 'say' || t === 'play' || t === 'pause') {
      promptBuf.push(node);
      currentId = nextTarget(graph, currentId);
      continue;
    }

    if (t === 'menu') {
      out.push(compileGather(graph, node, promptBuf, local));
      promptBuf = [];
      break; // Gather terminates the linear flow (branches continue it).
    }

    // Any buffered prompt run was NOT followed by a menu → emit as siblings.
    for (const p of promptBuf) out.push(compileLeaf(p));
    promptBuf = [];

    out.push(compileLeaf(node));
    if (isTerminalType(t)) break;
    currentId = nextTarget(graph, currentId);
  }

  // Trailing Say/Play/Pause with no following menu.
  for (const p of promptBuf) out.push(compileLeaf(p));
  return out;
}

/* ─── Compile ──────────────────────────────────────────────────────────── */

export function compileIvr(doc: CallFlowDoc): IvrArtifact {
  const graph = buildGraph(doc);
  const entry = doc.nodes.find((n) => n.type === 'entry');
  if (!entry) return { nodes: [] };
  const first = nextTarget(graph, entry.id);
  return { nodes: first ? walkChain(graph, first, new Set()) : [] };
}

/* ─── Validation (plan §6.1) ───────────────────────────────────────────── */

export function validateIvr(doc: CallFlowDoc): ValidationResult {
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

  // Entry must have exactly one outgoing connection.
  if (entry) {
    const entryEdges = graph.out.get(entry.id) ?? [];
    if (entryEdges.length === 0) {
      issues.push({ severity: 'error', message: 'Entry node is not connected to anything.', nodeId: entry.id });
    } else if (entryEdges.length > 1) {
      issues.push({ severity: 'error', message: 'Entry node must have a single outgoing connection.', nodeId: entry.id });
    }
  }

  // 2) Reachability — every node must be reachable from entry.
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

  // 3) Per-node rules.
  for (const n of doc.nodes) {
    const edges = graph.out.get(n.id) ?? [];
    const c = n.data.config;

    if (n.type === 'menu') {
      const digitEdges = edges.filter((e) => isDigitHandle(e.sourceHandle));
      const fallback = edges.some(
        (e) => e.sourceHandle === MENU_TIMEOUT || e.sourceHandle === MENU_NOMATCH,
      );
      if (digitEdges.length === 0) {
        issues.push({ severity: 'error', message: 'Menu needs at least one connected digit option.', nodeId: n.id });
      }
      if (!fallback) {
        issues.push({ severity: 'error', message: 'Menu needs a timeout / no-match path.', nodeId: n.id });
      }
      // Warn on a digit option declared but left unconnected, or duplicated.
      const seen = new Map<string, number>();
      for (const e of digitEdges) {
        const k = e.sourceHandle as string;
        seen.set(k, (seen.get(k) ?? 0) + 1);
      }
      for (const [k, count] of seen) {
        if (count > 1) {
          issues.push({ severity: 'warning', message: `Digit "${k}" has ${count} outgoing edges.`, nodeId: n.id });
        }
      }
      if (c.type === 'menu') {
        for (const d of c.digits) {
          if (!seen.has(d)) {
            issues.push({ severity: 'warning', message: `Digit "${d}" option is not connected.`, nodeId: n.id });
          }
        }
      }
    }

    if (n.type === 'dial' && c.type === 'dial' && !c.number.trim()) {
      issues.push({ severity: 'error', message: 'Dial node needs a destination number.', nodeId: n.id });
    }

    if (n.type === 'redirect' && c.type === 'redirect' && !c.url.trim()) {
      issues.push({ severity: 'error', message: 'Redirect node needs a target URL.', nodeId: n.id });
    }

    if (n.type === 'conference' && c.type === 'conference' && !c.room.trim()) {
      issues.push({ severity: 'error', message: 'Conference node needs a room name.', nodeId: n.id });
    }

    // 4) Terminal coverage — a non-terminal step that "falls off the end".
    const needsNext = ['say', 'play', 'pause', 'record'].includes(n.type);
    if (needsNext && reachable.has(n.id)) {
      const hasNext = edges.some((e) => e.sourceHandle == null || e.sourceHandle === NEXT_HANDLE);
      if (!hasNext) {
        issues.push({ severity: 'warning', message: `"${n.data.label ?? n.type}" has no next step — the call will end here.`, nodeId: n.id });
      }
    }
  }

  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

/* ─── Compiler registration ────────────────────────────────────────────── */

export const ivrCompiler: FlowCompiler<IvrArtifact> = {
  product: 'ivr',
  validate: validateIvr,
  compile: compileIvr,
};
