/**
 * model.ts — the Flow assistant's pure logic (docs/IVR_ASSIST_INTERFACES.md
 * §5 + §7). No React, no network: the builder's hook and panels call these,
 * and the node-run self-test (assist.assert.ts) checks them.
 *
 *   parseAssistJob / parseAssistResult   untrusted job JSON → typed, or null
 *   jobErrorText                         §5.3 customer text (CRAG's, verbatim)
 *   placeholderIds / promptsToCreate     which new messages Accept still has
 *                                        to create (a retry reuses the ones
 *                                        already made — the mapping is kept)
 *   substitutePlaceholders               negative ids → the real prompt ids
 *   withTidyPositions / acceptedGraph    Tidy-up positions + the final draft
 *   proposalChanges                      which blocks are new / changed vs
 *                                        the draft (badges on the canvas)
 *
 * Placeholder ids are −1 … −20 in `new_prompts` order (§5.2). They are never
 * saved: Accept swaps every one for a real `ivr_prompts.id` first, and
 * refuses (MissingMessageError) if any is left.
 */
import type {
  AssistJob,
  AssistJobErrorCode,
  AssistJobStatus,
  AssistNewPrompt,
  AssistProposal,
  AssistResult,
  IvrGraph,
  IvrNode,
  Issue,
} from '../../types/ivr.ts';
import { fromGraph, type WorkEdge, type WorkNode } from '../model/graph.ts';
import { tidyLayout } from '../model/layout.ts';

/* ─── Limits (§5) ─────────────────────────────────────────── */

/** `message`: 1–2000 characters. */
export const MESSAGE_MAX_CHARS = 2000;
/** The builder polls a job this often… */
export const POLL_INTERVAL_MS = 1500;
/** …and gives up after this long (the server reads a job this old as failed too). */
export const POLL_LIMIT_MS = 300_000;

/* ─── §5.3 job error texts ────────────────────────────────── */

export const JOB_ERROR_TEXT: Readonly<Record<AssistJobErrorCode, string>> = {
  assistant_unavailable: 'The flow assistant is unavailable right now. You can keep building by hand.',
  assistant_busy: 'The flow assistant is busy. Try again in a minute.',
  assistant_failed: 'The flow assistant couldn’t finish that request. Try rewording it, or build it by hand.',
};

function isJobErrorCode(code: unknown): code is AssistJobErrorCode {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(JOB_ERROR_TEXT, code);
}

/**
 * The customer text for a failed job. Always CRAG's own §5.3 wording — never
 * a message the server passes through; an unknown code reads as
 * `assistant_failed`.
 */
export function jobErrorText(code: string | null | undefined): string {
  return isJobErrorCode(code) ? JOB_ERROR_TEXT[code] : JOB_ERROR_TEXT.assistant_failed;
}

/* ─── Parsing (the job body is untrusted) ─────────────────── */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];

function issues(v: unknown): Issue[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(isRecord)
    .filter((i) => typeof i.message === 'string' && i.message !== '')
    .map((i) => ({
      code: typeof i.code === 'string' ? i.code : 'invalid',
      message: i.message as string,
      node_id: typeof i.node_id === 'string' ? i.node_id : null,
      handle: typeof i.handle === 'string' ? i.handle : null,
    }));
}

function newPrompts(v: unknown): AssistNewPrompt[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<number>();
  const out: AssistNewPrompt[] = [];
  for (const p of v) {
    if (!isRecord(p)) continue;
    const id = p.placeholder_id;
    if (typeof id !== 'number' || !Number.isInteger(id) || id >= 0 || seen.has(id)) continue;
    if (typeof p.name !== 'string' || typeof p.text !== 'string' || p.text.trim() === '') continue;
    seen.add(id);
    out.push({ placeholder_id: id, name: p.name.trim() || 'New message', text: p.text });
  }
  return out;
}

/** A job's `result` → one of the three §5.2 shapes, or null when it isn't one. */
export function parseAssistResult(raw: unknown): AssistResult | null {
  if (!isRecord(raw)) return null;
  switch (raw.kind) {
    case 'proposal': {
      const g = raw.draft_graph;
      if (!isRecord(g) || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) return null;
      return {
        kind: 'proposal',
        draft_graph: g as unknown as IvrGraph,
        new_prompts: newPrompts(raw.new_prompts),
        summary: str(raw.summary),
        assumptions: strs(raw.assumptions),
        issues: issues(raw.issues),
        warnings: issues(raw.warnings),
      };
    }
    case 'clarify':
      return str(raw.question).trim() ? { kind: 'clarify', question: str(raw.question) } : null;
    case 'cannot_build':
      return str(raw.message).trim() ? { kind: 'cannot_build', message: str(raw.message) } : null;
    default:
      return null;
  }
}

const STATUSES: readonly AssistJobStatus[] = ['running', 'done', 'failed'];

/**
 * A poll response → a job, or null when it isn't one. A `done` job whose
 * result can't be read comes back `failed` / `assistant_failed`, so the
 * caller has exactly three cases to handle.
 */
export function parseAssistJob(raw: unknown): AssistJob | null {
  if (!isRecord(raw) || typeof raw.job_id !== 'string' || !STATUSES.includes(raw.status as AssistJobStatus)) return null;
  const base = {
    job_id: raw.job_id,
    conversation_id: str(raw.conversation_id),
    elapsed_ms: typeof raw.elapsed_ms === 'number' ? raw.elapsed_ms : 0,
  };
  const status = raw.status as AssistJobStatus;
  if (status === 'done') {
    const result = parseAssistResult(raw.result);
    return result
      ? { ...base, status, result }
      : { ...base, status: 'failed', error: { code: 'assistant_failed', message: JOB_ERROR_TEXT.assistant_failed } };
  }
  if (status === 'failed') {
    const err = isRecord(raw.error) ? raw.error : {};
    return { ...base, status, error: { code: str(err.code) || 'assistant_failed', message: str(err.message) } };
  }
  return { ...base, status };
}

/* ─── Placeholders ────────────────────────────────────────── */

/** Every config key that holds prompt ids (§2: play, menu, hang up). */
const PROMPT_KEYS = ['prompts', 'invalidPrompts', 'noInputPrompts'] as const;

function configOf(node: IvrNode): Record<string, unknown> | null {
  const data = (node as { data?: unknown }).data;
  if (!isRecord(data) || !isRecord(data.config)) return null;
  return data.config;
}

/** The placeholder (negative) prompt ids the graph uses, in first-use order. */
export function placeholderIds(graph: IvrGraph): number[] {
  const out: number[] = [];
  for (const node of graph.nodes) {
    const config = configOf(node);
    if (!config) continue;
    for (const key of PROMPT_KEYS) {
      const list = config[key];
      if (!Array.isArray(list)) continue;
      for (const id of list) if (typeof id === 'number' && id < 0 && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** The new messages a proposal really uses (an unreferenced one is never created). */
export function usedNewPrompts(proposal: Pick<AssistProposal, 'draft_graph' | 'new_prompts'>): AssistNewPrompt[] {
  const used = new Set(placeholderIds(proposal.draft_graph));
  return proposal.new_prompts.filter((p) => used.has(p.placeholder_id));
}

/**
 * What Accept still has to create, in `new_prompts` order: every new message
 * the graph uses that has no real id yet. On a retry `created` holds the ids
 * made by the earlier attempt, so nothing is created twice.
 */
export function promptsToCreate(
  proposal: Pick<AssistProposal, 'draft_graph' | 'new_prompts'>,
  created: ReadonlyMap<number, number>,
): AssistNewPrompt[] {
  return usedNewPrompts(proposal).filter((p) => !created.has(p.placeholder_id));
}

/** Creating one new message failed; the ones before it are already in the mapping. */
export class PromptCreateError extends Error {
  readonly prompt: AssistNewPrompt;
  constructor(prompt: AssistNewPrompt, cause: unknown) {
    super(`Creating the message “${prompt.name}” failed.`, { cause });
    this.name = 'PromptCreateError';
    this.prompt = prompt;
  }
}

/**
 * Accept, step 1: creates every new message that has no real id yet, one at
 * a time in `new_prompts` order, recording each id in `mapping` AS SOON AS it
 * exists. The first failure stops the run (PromptCreateError) and leaves the
 * mapping holding everything made so far, so the retry — the same call with
 * the same mapping — creates only what is still missing.
 */
export async function createMissingPrompts(
  proposal: Pick<AssistProposal, 'draft_graph' | 'new_prompts'>,
  mapping: Map<number, number>,
  create: (prompt: AssistNewPrompt) => Promise<number>,
): Promise<void> {
  for (const prompt of promptsToCreate(proposal, mapping)) {
    let id: number;
    try {
      id = await create(prompt);
    } catch (err) {
      throw new PromptCreateError(prompt, err);
    }
    mapping.set(prompt.placeholder_id, id);
  }
}

/** A placeholder id reached the draft without a real message behind it. */
export class MissingMessageError extends Error {
  readonly placeholderId: number;
  constructor(placeholderId: number) {
    super(`No message was created for placeholder ${placeholderId}.`);
    this.name = 'MissingMessageError';
    this.placeholderId = placeholderId;
  }
}

/**
 * The graph with every placeholder id replaced by its real prompt id. Pure:
 * the input is not touched. Throws MissingMessageError when a negative id
 * has no mapping, so a placeholder can never be saved.
 */
export function substitutePlaceholders(graph: IvrGraph, mapping: ReadonlyMap<number, number>): IvrGraph {
  const swap = (id: unknown): unknown => {
    if (typeof id !== 'number' || id >= 0) return id;
    const real = mapping.get(id);
    if (real === undefined) throw new MissingMessageError(id);
    return real;
  };
  const nodes = graph.nodes.map((node) => {
    const config = configOf(node);
    if (!config || !PROMPT_KEYS.some((k) => Array.isArray(config[k]))) return node;
    const next: Record<string, unknown> = { ...config };
    for (const key of PROMPT_KEYS) {
      const list = config[key];
      if (Array.isArray(list)) next[key] = list.map(swap);
    }
    return { ...node, data: { ...node.data, config: next } } as IvrNode;
  });
  return { ...graph, nodes };
}

/**
 * Names for a proposal's blocks: a placeholder (negative) id is one of its
 * new messages, named before it exists; any other id is an existing message.
 */
export function proposalPromptName(
  newPrompts: readonly AssistNewPrompt[],
  existing: (id: number) => string | null,
): (id: number) => string | null {
  const names = new Map(newPrompts.map((p) => [p.placeholder_id, p.name]));
  return (id) => (id < 0 ? (names.get(id) ?? 'a new message') : existing(id));
}

/* ─── Layout ──────────────────────────────────────────────── */

/** The graph with the builder's Tidy-up positions (the server sends every block at 0,0). */
export function withTidyPositions(graph: IvrGraph): IvrGraph {
  const work = fromGraph(graph);
  const pos = tidyLayout(work.nodes, work.edges);
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const p = pos.get(n.id);
      return p ? ({ ...n, position: { x: p.x, y: p.y } } as IvrNode) : n;
    }),
  };
}

/**
 * The draft Accept writes: real prompt ids, Tidy-up positions, no viewport
 * (the canvas re-frames the new flow).
 */
export function acceptedGraph(proposalGraph: IvrGraph, mapping: ReadonlyMap<number, number>): IvrGraph {
  const out: IvrGraph = { ...withTidyPositions(substitutePlaceholders(proposalGraph, mapping)) };
  delete out.viewport;
  return out;
}

/* ─── What changed (vs the draft) ─────────────────────────── */

export type ProposalMark = 'new' | 'changed';

export interface ProposalChanges {
  marks: Map<string, ProposalMark>;
  added: number;
  changed: number;
  removed: number;
}

/** JSON with sorted keys, so two configs compare equal whatever their key order. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function signature(node: WorkNode, edges: readonly WorkEdge[]): string {
  const outs = edges
    .filter((e) => e.source === node.id)
    .map((e) => `${e.sourceHandle}>${e.target}`)
    .sort();
  return stable([node.type, node.data.label ?? '', node.data.config, outs]);
}

/**
 * Blocks the proposal adds or changes compared with the draft (ids are kept
 * for blocks that already exist, §5.2), plus how many draft blocks it drops.
 * Positions don't count — only what callers would notice. Start is never
 * marked or counted: every flow has exactly one, whatever its id.
 */
export function proposalChanges(draft: IvrGraph, proposal: IvrGraph): ProposalChanges {
  const before = fromGraph(draft);
  const after = fromGraph(proposal);
  const old = new Map(before.nodes.map((n) => [n.id, signature(n, before.edges)]));
  const marks = new Map<string, ProposalMark>();
  let added = 0;
  let changed = 0;
  for (const n of after.nodes) {
    if (n.type === 'entry') continue;
    const was = old.get(n.id);
    if (was === undefined) {
      marks.set(n.id, 'new');
      added += 1;
    } else if (was !== signature(n, after.edges)) {
      marks.set(n.id, 'changed');
      changed += 1;
    }
  }
  const kept = new Set(after.nodes.map((n) => n.id));
  const removed = before.nodes.filter((n) => n.type !== 'entry' && !kept.has(n.id)).length;
  return { marks, added, changed, removed };
}
