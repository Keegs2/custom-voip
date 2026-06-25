/**
 * Legacy IVR importer — the REVERSE of `compile/ivr.ts`.
 *
 * Input is a legacy `ivr_flows.flow_config` nested tree: the exact shape that
 * `routers/ivr.py:_node_to_xml` consumes and `compile/ivr.ts` emits —
 *
 *   { nodes: [ { id?, type, config?, prompt?, branches? } ] }
 *
 * Output is a product-agnostic `CallFlowDoc` graph the new Call Flow Builder
 * renders, edits, and re-compiles. The mapping is the inverse of the compiler:
 *
 *  - Each tree node  → one `FlowNode`. Compiled `type`s map back to builder
 *    `NodeType`s (`gather → menu`, the rest 1:1).
 *  - A linear node run → a chain of `next`-handle edges.
 *  - A Gather's `prompt[]` verbs → say/play/pause `FlowNode`s wired INTO the
 *    menu via the `next` chain (the compiler folds a leading prompt run back
 *    into `prompt[]`, so this round-trips). The compiler's synthetic
 *    `${id}_prompt` Say (produced from a menu's inline `prompt` string) is
 *    detected by id and restored to `config.prompt`/`voice` instead.
 *  - `branches{ digit | timeout | default }` → edges off the menu's per-digit /
 *    timeout / noMatch source handles.
 *  - `schedule.branches{ in | out }` → the schedule node's inWindow / otherwise
 *    handles; `condition.branches{ match | nomatch }` → match / noMatch handles.
 *
 * Node positions are auto-laid-out top-down with dagre.
 *
 * Pure + fully typed: no React, no store, no side effects. The product is
 * pinned to `'ivr'` and the document is returned as an unsaved draft
 * (`id: null`, `status: 'draft'`) so saving it creates a fresh `call_flows`
 * row rather than mutating the source `ivr_flows` row.
 *
 * Lossy / normalised cases (see report):
 *  - A menu's inline prompt string and separate Say prompt nodes are normalised
 *    to the same representation (standalone Say nodes) when the synthetic
 *    `${id}_prompt` marker is absent; the re-compiled XML is identical.
 *  - Node ids are regenerated (nanoid); original tree ids are not preserved.
 *  - Hand-authored advanced TwiML attributes the builder model does not carry
 *    (e.g. Dial `action`/`timeLimit`/nested `<Sip>`, Conference
 *    `waitUrl`/`video`, Record `action`/`method`) are dropped.
 */
import type {
  CallFlowDoc,
  CallerIdMatch,
  DayCode,
  FlowEdge,
  FlowNode,
  NodeConfig,
  NodeType,
} from '../model/types';
import { defaultLabel, newId } from '../model/defaults';
import { layoutTopDown } from './layout';
import {
  COND_MATCH,
  COND_NOMATCH,
  IN_HANDLE,
  MENU_DIGIT_KEYS,
  MENU_NOMATCH,
  MENU_TIMEOUT,
  NEXT_HANDLE,
  SCHEDULE_ELSE,
  SCHEDULE_IN,
  isTerminalType,
} from '../canvas/handles';

/* ─── Legacy input contract (mirror of compile/ivr.ts `CompiledNode`) ───── */

/** One node in a legacy `ivr_flows.flow_config` tree. */
export interface LegacyIvrNode {
  id?: string;
  type: string;
  config?: Record<string, unknown>;
  /** Verbs nested inside a Gather (`gather` nodes only). */
  prompt?: LegacyIvrNode[];
  /** Outcome sub-sequences, keyed by digit / 'timeout' / 'default' / branch key. */
  branches?: Record<string, LegacyIvrNode[]>;
}

/** Root of a legacy `ivr_flows.flow_config` value. */
export interface LegacyFlowConfig {
  nodes?: LegacyIvrNode[];
}

/** Identity to stamp on the produced draft document. */
export interface LegacyIvrMeta {
  name: string;
  customerId?: number | null;
  did?: string | null;
}

/* ─── Coercion helpers (legacy config is loosely typed JSON) ────────────── */

function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
  }
  return undefined;
}

/* ─── Compiled-type → builder-type map ──────────────────────────────────── */

const TYPE_MAP: Record<string, NodeType> = {
  say: 'say',
  play: 'play',
  pause: 'pause',
  gather: 'menu',
  dial: 'dial',
  record: 'record',
  redirect: 'redirect',
  reject: 'reject',
  hangup: 'hangup',
  conference: 'conference',
  schedule: 'schedule',
  condition: 'condition',
};

const VALID_DAYS: readonly DayCode[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/* ─── Per-type config reconstruction ────────────────────────────────────── */

/** Reverse a leaf node's compiled `config` into a typed builder `NodeConfig`. */
function leafConfig(type: NodeType, raw: Record<string, unknown>): NodeConfig {
  switch (type) {
    case 'say':
      return { type: 'say', text: asString(raw.text) ?? '', voice: asString(raw.voice) ?? 'default', language: asString(raw.language) };
    case 'play':
      return { type: 'play', url: asString(raw.url) ?? '', loop: asNumber(raw.loop) };
    case 'pause':
      // Compiler emits `length`; the old @dnd-kit tree used `duration`.
      return { type: 'pause', seconds: asNumber(raw.length) ?? asNumber(raw.duration) ?? asNumber(raw.seconds) ?? 1 };
    case 'dial':
      return { type: 'dial', number: asString(raw.number) ?? '', callerId: asString(raw.callerId), timeout: asNumber(raw.timeout) ?? 30, record: asBool(raw.record) };
    case 'record':
      return { type: 'record', maxLength: asNumber(raw.maxLength), playBeep: asBool(raw.playBeep), finishOnKey: asString(raw.finishOnKey), transcribe: asBool(raw.transcribe) };
    case 'redirect': {
      const method = asString(raw.method);
      return { type: 'redirect', url: asString(raw.url) ?? '', method: method === 'GET' ? 'GET' : method === 'POST' ? 'POST' : undefined };
    }
    case 'reject':
      return { type: 'reject', reason: asString(raw.reason) };
    case 'conference':
      return {
        type: 'conference',
        room: asString(raw.room) ?? asString(raw.name) ?? asString(raw.roomName) ?? '',
        muted: asBool(raw.muted),
        beep: asBool(raw.beep),
        waitForModerator: asBool(raw.waitForModerator),
        maxParticipants: asNumber(raw.maxParticipants),
        record: asBool(raw.record),
      };
    case 'hangup':
    default:
      return { type: 'hangup' };
  }
}

function scheduleConfig(raw: Record<string, unknown>): NodeConfig {
  const daysRaw = Array.isArray(raw.days) ? raw.days : [];
  const days = daysRaw
    .map((d) => asString(d)?.toLowerCase().slice(0, 3))
    .filter((d): d is DayCode => d != null && (VALID_DAYS as readonly string[]).includes(d));
  return { type: 'schedule', days, start: asString(raw.start) ?? '', end: asString(raw.end) ?? '', tz: asString(raw.tz) ?? '' };
}

function conditionConfig(raw: Record<string, unknown>): NodeConfig {
  // Compiler pins snake_case `caller_id`; accept camelCase for hand-authored flows.
  const cidRaw = (raw.caller_id ?? raw.callerId) as unknown;
  const callerId: CallerIdMatch = {};
  if (cidRaw && typeof cidRaw === 'object') {
    const cid = cidRaw as Record<string, unknown>;
    const prefix = asString(cid.prefix);
    const equals = asString(cid.equals);
    if (prefix) callerId.prefix = prefix;
    if (equals) callerId.equals = equals;
  }
  return { type: 'condition', callerId };
}

/* ─── Branch-key → source-handle maps (inverse of handleToBranchKey) ────── */

function menuBranchHandle(key: string): string {
  if (key === 'timeout') return MENU_TIMEOUT;
  if (key === 'default') return MENU_NOMATCH;
  return key; // digit handle ('1'..'#')
}

function scheduleBranchHandle(key: string): string | null {
  if (key === 'in') return SCHEDULE_IN;
  if (key === 'out') return SCHEDULE_ELSE;
  return null;
}

function conditionBranchHandle(key: string): string | null {
  if (key === 'match') return COND_MATCH;
  if (key === 'nomatch') return COND_NOMATCH;
  return null;
}

/* ─── Conversion ────────────────────────────────────────────────────────── */

export function fromLegacyIvr(flowConfig: LegacyFlowConfig, meta: LegacyIvrMeta): CallFlowDoc {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];

  function makeFlowNode(type: NodeType, config: NodeConfig): FlowNode {
    const node: FlowNode = {
      id: newId(),
      type,
      position: { x: 0, y: 0 }, // placeholder — dagre assigns real positions below
      data: { label: defaultLabel(type), config },
    };
    nodes.push(node);
    return node;
  }

  function addEdge(source: string, sourceHandle: string, target: string): void {
    edges.push({ id: newId(), source, sourceHandle, target, targetHandle: IN_HANDLE });
  }

  /**
   * Emit a single legacy node (and its sub-tree). Returns the entry node id (the
   * first node a parent's `next` edge should reach) and the exit node id (the
   * node a following sibling's `next` edge should leave from), or `null` when the
   * node terminates the linear flow (menu / branch / terminal). Unknown node
   * types are skipped (`null` result).
   */
  function emitOne(ln: LegacyIvrNode): { entryId: string; exitId: string | null } | null {
    const nodeType = TYPE_MAP[(ln.type ?? '').toLowerCase()];
    if (!nodeType) return null;
    const raw = ln.config ?? {};

    if (nodeType === 'menu') return emitMenu(ln, raw);
    if (nodeType === 'schedule' || nodeType === 'condition') return emitBranch(ln, nodeType, raw);

    const node = makeFlowNode(nodeType, leafConfig(nodeType, raw));
    return { entryId: node.id, exitId: isTerminalType(nodeType) ? null : node.id };
  }

  function emitMenu(ln: LegacyIvrNode, raw: Record<string, unknown>): { entryId: string; exitId: string | null } {
    const promptList = ln.prompt ?? [];
    const syntheticId = ln.id ? `${ln.id}_prompt` : undefined;

    // Split the synthetic inline-prompt Say (restored to config.prompt) from the
    // standalone prompt verbs (re-materialised as their own nodes).
    let promptText = '';
    let promptVoice: string | undefined;
    const standalone: LegacyIvrNode[] = [];
    for (const p of promptList) {
      if (syntheticId && p.id === syntheticId && (p.type ?? '').toLowerCase() === 'say') {
        const pc = p.config ?? {};
        promptText = asString(pc.text) ?? '';
        promptVoice = asString(pc.voice);
      } else {
        standalone.push(p);
      }
    }

    const branches = ln.branches ?? {};
    const digits = (MENU_DIGIT_KEYS as readonly string[]).filter((k) => k in branches);

    const menu = makeFlowNode('menu', {
      type: 'menu',
      prompt: promptText,
      voice: promptVoice ?? 'default',
      digits,
      numDigits: asNumber(raw.numDigits),
      timeout: asNumber(raw.timeout) ?? 5,
      finishOnKey: asString(raw.finishOnKey),
    });

    // Standalone prompt verbs feed INTO the menu via the next-chain, matching the
    // compiler which folds the leading say/play/pause run into the gather prompt.
    let entryId = menu.id;
    let prevExit: string | null = null;
    let first = true;
    for (const p of standalone) {
      const r = emitOne(p);
      if (!r) continue;
      if (first) {
        entryId = r.entryId;
        first = false;
      }
      if (prevExit !== null) addEdge(prevExit, NEXT_HANDLE, r.entryId);
      prevExit = r.exitId;
    }
    if (prevExit !== null) addEdge(prevExit, NEXT_HANDLE, menu.id);

    for (const [key, seq] of Object.entries(branches)) {
      const head = emitSequence(seq);
      if (head) addEdge(menu.id, menuBranchHandle(key), head);
    }

    return { entryId, exitId: null };
  }

  function emitBranch(
    ln: LegacyIvrNode,
    nodeType: 'schedule' | 'condition',
    raw: Record<string, unknown>,
  ): { entryId: string; exitId: string | null } {
    const node = makeFlowNode(nodeType, nodeType === 'schedule' ? scheduleConfig(raw) : conditionConfig(raw));
    const handleFor = nodeType === 'schedule' ? scheduleBranchHandle : conditionBranchHandle;
    for (const [key, seq] of Object.entries(ln.branches ?? {})) {
      const handle = handleFor(key);
      if (!handle) continue;
      const head = emitSequence(seq);
      if (head) addEdge(node.id, handle, head);
    }
    return { entryId: node.id, exitId: null };
  }

  /** Walk a node array, wiring `next` edges, and return its entry node id. */
  function emitSequence(seq: LegacyIvrNode[] | undefined): string | null {
    let head: string | null = null;
    let prevExit: string | null = null;
    for (const ln of seq ?? []) {
      const r = emitOne(ln);
      if (!r) continue;
      if (head === null) head = r.entryId;
      if (prevExit !== null) addEdge(prevExit, NEXT_HANDLE, r.entryId);
      prevExit = r.exitId;
    }
    return head;
  }

  // Entry node — the trigger the compiler walks from.
  const entryNode = makeFlowNode('entry', { type: 'entry' });
  const rootHead = emitSequence(flowConfig.nodes);
  if (rootHead) addEdge(entryNode.id, NEXT_HANDLE, rootHead);

  layoutTopDown(nodes, edges);

  return {
    schemaVersion: 1,
    id: null,
    product: 'ivr',
    name: meta.name,
    customerId: meta.customerId ?? null,
    entry: { kind: 'did', did: meta.did ?? '' },
    nodes,
    edges,
    viewport: { x: 0, y: 0, zoom: 1 },
    status: 'draft',
    version: 1,
  };
}
