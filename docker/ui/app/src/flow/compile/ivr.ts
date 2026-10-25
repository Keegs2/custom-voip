/**
 * compile/ivr.ts — the browser MIRROR of the server's IVR compiler
 * (`services/ivr/compiler.py`, contract §3). It exists for instant
 * feedback only: live validation pinned to blocks and exits, and the "what
 * callers hear" preview. Its plan is never sent anywhere — publish sends
 * `{ revision }` and the server compiles the stored draft (plan D2).
 *
 * Bugs the transplanted compiler had, fixed here and covered by
 * ivr.assert.ts:
 *  - menu prompts were emitted in REVERSE order → kept in config order;
 *  - loops compiled to empty branches → a Go to block is compiled away, its
 *    pointer aimed straight at its target (cycles allowed, §3), and a Go to
 *    chain that loops on itself is an error;
 *  - a deleted menu key still routed → only keys in `digits` produce
 *    `d:<key>` branches, any other `d:` edge is ignored and reported;
 *  - transfer targets were never checked → own numbers must be on the
 *    account (and not this IVR's own), outside numbers pass the US rule.
 */
import type {
  DayKey,
  DestinationProduct,
  Destinations,
  IvrConfigMap,
  IvrGraph,
  IvrNode,
  IvrNodeType,
  IvrTimezone,
  MenuDigit,
  PromptId,
} from '../../types/ivr.ts';
import {
  BLOCKS,
  CLOSED,
  DAY_KEYS,
  DAY_LABELS,
  DIGIT_ORDER,
  LIMITS,
  MATCH,
  NEXT,
  NO_ANSWER,
  NO_INPUT,
  NO_MATCH,
  OPEN,
  digitHandle,
  digitOfHandle,
  isIvrTimezone,
  isMenuDigit,
  outHandles,
  timezoneLabel,
} from '../model/blocks.ts';
import { ID_RE } from '../model/graph.ts';
import {
  blockTitle,
  describeOwnNumber,
  formatWeekly,
  quoteList,
} from '../model/summary.ts';
import { callerValueProblem, checkExternalNumber, prettyNumber } from './policy.ts';

/* ─── Types ───────────────────────────────────────────────── */

export type Severity = 'error' | 'warning';

export interface ClientIssue {
  severity: Severity;
  code: string;
  message: string;
  nodeId?: string;
  handle?: string;
}

export interface PromptInfo {
  id: PromptId;
  name: string;
}

export interface CompileContext {
  /** The customer's live prompts. Null = not loaded yet (prompt checks skipped). */
  prompts: ReadonlyMap<PromptId, PromptInfo> | null;
  /** The transfer picker's list. Null = not loaded yet (ownership checks skipped). */
  destinations: Destinations | null;
  /** DIDs bound to THIS flow — transferring to one is a loop onto itself. */
  ownDids: readonly string[];
  maxBlocks?: number;
}

/** A pointer to the next plan node, or null = hang up (no prompt). */
export type PlanRef = string | null;

export type PlanNode =
  | { t: 'play'; prompts: PromptId[]; next: PlanRef }
  | {
      t: 'menu';
      prompts: PromptId[];
      digits: Partial<Record<MenuDigit, PlanRef>>;
      timeout_ms: number;
      retries: number;
      invalid_prompts: PromptId[];
      noinput_prompts: PromptId[];
      on_noinput: PlanRef;
      on_nomatch: PlanRef;
    }
  | {
      t: 'hours';
      tz: IvrTimezone;
      weekly: Record<DayKey, [number, number][]>;
      closed_dates: string[];
      open: PlanRef;
      closed: PlanRef;
    }
  | { t: 'caller'; mode: 'prefix' | 'equals' | 'anonymous'; values: string[]; match: PlanRef; nomatch: PlanRef }
  | {
      t: 'transfer';
      dest: { kind: 'external'; e164: string } | { kind: 'own'; did: string; product: DestinationProduct | null };
      pass_caller_id: boolean;
      ring_timeout: number;
      on_noanswer: PlanRef;
    }
  | { t: 'voicemail'; did: string }
  | { t: 'hangup'; prompts: PromptId[] };

/** §3 shape, with prompt IDS where the server writes sha256s. */
export interface PlanPreview {
  v: 1;
  start: PlanRef;
  limits: { max_steps: number; max_seconds: number };
  prompts: PromptId[];
  nodes: Record<string, PlanNode>;
}

export interface CompileResult {
  ok: boolean;
  issues: ClientIssue[];
  plan: PlanPreview;
  /** Blocks a caller can reach from Start (Go to blocks on the way included). */
  reachable: ReadonlySet<string>;
}

/* ─── Helpers ─────────────────────────────────────────────── */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

/** "HH:MM" → minutes since midnight ("24:00" → 1440); null when malformed. */
export function toMinutes(hhmm: string): number | null {
  const m = TIME_RE.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h === 24 && min === 0) return 1440;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Sorts and merges overlapping / touching [start, end) ranges. */
export function mergeRanges(ranges: readonly [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function isRealDate(ymd: string): boolean {
  if (!DATE_RE.test(ymd)) return false;
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function ownProduct(did: string, destinations: Destinations | null): DestinationProduct | null {
  for (const g of destinations?.groups ?? []) if (g.numbers.some((n) => n.did === did)) return g.product;
  return null;
}

function findOwn(did: string, destinations: Destinations | null) {
  for (const g of destinations?.groups ?? []) {
    const n = g.numbers.find((x) => x.did === did);
    if (n) return { group: g, number: n };
  }
  return null;
}

/* ─── Compile ─────────────────────────────────────────────── */

export function compileIvr(graph: IvrGraph, ctx: CompileContext): CompileResult {
  const issues: ClientIssue[] = [];
  const add = (severity: Severity, code: string, message: string, nodeId?: string, handle?: string) =>
    issues.push({ severity, code, message, ...(nodeId ? { nodeId } : {}), ...(handle ? { handle } : {}) });

  const nodes = graph.nodes;
  const byId = new Map<string, IvrNode>(nodes.map((n) => [n.id, n]));
  const slot = new Map<string, string>(); // "source\0handle" → target

  /* Graph-level rules */
  const maxBlocks = ctx.maxBlocks ?? LIMITS.blocks;
  if (nodes.length > maxBlocks) {
    add('error', 'too_many_blocks', `A flow can have up to ${maxBlocks} blocks. This one has ${nodes.length}.`);
  }
  for (const n of nodes) {
    if (!ID_RE.test(n.id)) add('error', 'bad_id', 'This block has an invalid id. Delete it and add it again.', n.id);
  }
  const entries = nodes.filter((n) => n.type === 'entry');
  const entry = entries[0];
  if (!entry) add('error', 'no_start', 'The flow has no Start block.');
  for (const extra of entries.slice(1)) add('error', 'extra_start', 'A flow has exactly one Start block.', extra.id);

  for (const e of graph.edges) {
    const source = byId.get(e.source);
    const target = byId.get(e.target);
    if (!source || !target) continue;
    if (target.type === 'entry') {
      add('error', 'edge_into_start', 'Nothing can connect into Start.', e.source, e.sourceHandle);
      continue;
    }
    const key = `${e.source}\u0000${e.sourceHandle}`;
    if (slot.has(key)) {
      add('error', 'duplicate_exit', 'This exit is connected twice. Remove one connection.', e.source, e.sourceHandle);
      continue;
    }
    if (!outHandles(source).some((h) => h.id === e.sourceHandle)) {
      const digit = digitOfHandle(e.sourceHandle);
      add(
        'warning',
        'stale_exit',
        digit ? `Key ${digit} is no longer in this menu, so its connection is ignored.` : 'A connection leaves from an exit this block no longer has; it is ignored.',
        e.source,
        e.sourceHandle,
      );
      continue;
    }
    slot.set(key, e.target);
  }

  /* Go to resolution: aim pointers at the final non-Go-to block. */
  const gotoProblems = new Map<string, string>();
  const resolve = (targetId: string | undefined): PlanRef => {
    let id = targetId;
    const seen = new Set<string>();
    while (id !== undefined) {
      const node = byId.get(id);
      if (!node) return null;
      if (node.type !== 'goto') return node.type === 'entry' ? null : node.id;
      if (seen.has(id)) {
        for (const g of seen) gotoProblems.set(g, 'goto_loop');
        return null;
      }
      seen.add(id);
      const t = (node.data.config as IvrConfigMap['goto']).targetNodeId;
      id = t ? t : undefined;
    }
    return null;
  };
  const ptr = (nodeId: string, handle: string): PlanRef => resolve(slot.get(`${nodeId}\u0000${handle}`));

  /* Reachability over edges + Go to jumps. */
  const reachable = new Set<string>();
  if (entry) {
    const stack = [entry.id];
    while (stack.length) {
      const id = stack.pop() as string;
      if (reachable.has(id)) continue;
      const node = byId.get(id);
      if (!node) continue;
      reachable.add(id);
      for (const h of outHandles(node)) {
        const t = slot.get(`${id}\u0000${h.id}`);
        if (t) stack.push(t);
      }
      if (node.type === 'goto') {
        const t = (node.data.config as IvrConfigMap['goto']).targetNodeId;
        if (t && byId.has(t)) stack.push(t);
      }
    }
  }
  for (const n of nodes) {
    if (n.type === 'entry' || reachable.has(n.id)) continue;
    add('warning', 'unreachable', `“${blockTitle(n)}” isn’t connected, so callers never reach it.`, n.id);
  }

  /* Per-block checks + plan nodes (reachable blocks only). */
  const planNodes: Record<string, PlanNode> = {};
  const promptOrder: PromptId[] = [];
  const takePrompts = (list: readonly PromptId[] | undefined, nodeId: string, what: string): PromptId[] => {
    const out = [...(list ?? [])];
    if (out.length > LIMITS.promptsPerBlock) {
      add('error', 'too_many_prompts', `${what}: up to ${LIMITS.promptsPerBlock} messages.`, nodeId);
    }
    for (const id of out) {
      if (ctx.prompts && !ctx.prompts.has(id)) {
        add('error', 'prompt_missing', `${what} uses a message that was deleted. Choose another one.`, nodeId);
      }
      if (!promptOrder.includes(id)) promptOrder.push(id);
    }
    return out;
  };
  const exitWarning = (nodeId: string, handle: string, message: string) => {
    if (!slot.has(`${nodeId}\u0000${handle}`)) add('warning', 'exit_hangs_up', message, nodeId, handle);
  };

  for (const n of nodes) {
    if (!reachable.has(n.id)) continue;
    switch (n.type) {
      case 'entry': {
        if (!slot.has(`${n.id}\u0000${NEXT}`)) {
          add('error', 'start_unconnected', 'Connect Start to the first block callers hear.', n.id, NEXT);
        }
        break;
      }
      case 'play': {
        const c = n.data.config;
        if (c.prompts.length === 0) add('error', 'play_no_prompts', 'Choose at least one message to play.', n.id);
        const prompts = takePrompts(c.prompts, n.id, 'This block');
        exitWarning(n.id, NEXT, 'After this message the call hangs up. Connect “Then” to keep going.');
        planNodes[n.id] = { t: 'play', prompts, next: ptr(n.id, NEXT) };
        break;
      }
      case 'menu': {
        const c = n.data.config;
        if (c.prompts.length === 0) add('error', 'menu_no_prompts', 'Choose the message that lists the options.', n.id);
        const digits = c.digits.filter(isMenuDigit);
        if (digits.length < LIMITS.digitsMin) add('error', 'menu_no_keys', 'Add at least one key callers can press.', n.id);
        if (digits.length > LIMITS.digitsMax) add('error', 'menu_too_many_keys', 'A menu can offer up to 12 keys.', n.id);
        if (new Set(digits).size !== digits.length) add('error', 'menu_duplicate_key', 'Each key can appear once.', n.id);
        if (!(c.timeoutSec >= LIMITS.timeoutSec.min && c.timeoutSec <= LIMITS.timeoutSec.max)) {
          add('error', 'menu_timeout', 'Wait between 1 and 30 seconds for a key.', n.id);
        }
        if (!(Number.isInteger(c.retries) && c.retries >= LIMITS.retries.min && c.retries <= LIMITS.retries.max)) {
          add('error', 'menu_retries', 'Ask again between 0 and 5 times.', n.id);
        }
        const map: Partial<Record<MenuDigit, PlanRef>> = {};
        for (const d of digits) {
          const handle = digitHandle(d);
          if (!slot.has(`${n.id}\u0000${handle}`)) {
            add('error', 'menu_key_unconnected', `Press ${d} isn’t connected to anything.`, n.id, handle);
          }
          map[d] = ptr(n.id, handle);
        }
        exitWarning(n.id, NO_INPUT, 'If the caller presses nothing, the call hangs up.');
        exitWarning(n.id, NO_MATCH, 'If the caller presses a wrong key, the call hangs up.');
        planNodes[n.id] = {
          t: 'menu',
          prompts: takePrompts(c.prompts, n.id, 'This menu'),
          digits: map,
          timeout_ms: Math.round(c.timeoutSec * 1000),
          retries: c.retries,
          invalid_prompts: takePrompts(c.invalidPrompts, n.id, 'The wrong-key message'),
          noinput_prompts: takePrompts(c.noInputPrompts, n.id, 'The no-key message'),
          on_noinput: ptr(n.id, NO_INPUT),
          on_nomatch: ptr(n.id, NO_MATCH),
        };
        break;
      }
      case 'schedule': {
        const c = n.data.config;
        if (!isIvrTimezone(c.tz)) add('error', 'hours_timezone', 'Choose a time zone.', n.id);
        const weekly = {} as Record<DayKey, [number, number][]>;
        let anyOpen = false;
        for (const day of DAY_KEYS) {
          const ranges = c.weekly[day] ?? [];
          if (ranges.length > LIMITS.rangesPerDay) {
            add('error', 'hours_too_many', `${DAY_LABELS[day].long}: up to 4 time ranges.`, n.id);
          }
          const mins: [number, number][] = [];
          for (const [a, b] of ranges) {
            const s = toMinutes(a);
            const e = toMinutes(b);
            if (s === null || e === null || s === 1440) {
              add('error', 'hours_bad_time', `${DAY_LABELS[day].long}: use times like 09:00 and 17:00.`, n.id);
            } else if (s >= e) {
              add('error', 'hours_backwards', `${DAY_LABELS[day].long}: each range must end after it starts.`, n.id);
            } else {
              mins.push([s, e]);
            }
          }
          weekly[day] = mergeRanges(mins);
          if (weekly[day].length) anyOpen = true;
        }
        if (!anyOpen) add('warning', 'hours_never_open', 'No open hours are set, so callers always take the Closed path.', n.id);
        const dates = [...new Set(c.closedDates)].sort();
        for (const d of dates) {
          if (!isRealDate(d)) add('error', 'hours_bad_date', `“${d}” isn’t a valid date.`, n.id);
        }
        exitWarning(n.id, OPEN, 'While you are open, the call hangs up. Connect “Open”.');
        exitWarning(n.id, CLOSED, 'While you are closed, the call hangs up. Connect “Closed”.');
        planNodes[n.id] = {
          t: 'hours',
          tz: c.tz,
          weekly,
          closed_dates: dates.filter(isRealDate),
          open: ptr(n.id, OPEN),
          closed: ptr(n.id, CLOSED),
        };
        break;
      }
      case 'condition': {
        const c = n.data.config;
        if (c.mode === 'anonymous') {
          if (c.values.length) add('warning', 'caller_values_ignored', 'The numbers listed are ignored when checking for a withheld caller ID.', n.id);
        } else {
          if (c.values.length < LIMITS.conditionValues.min) add('error', 'caller_no_values', 'Add at least one number to check.', n.id);
          if (c.values.length > LIMITS.conditionValues.max) add('error', 'caller_too_many', 'Check up to 50 numbers.', n.id);
          for (const v of c.values) {
            const problem = callerValueProblem(v, c.mode);
            if (problem) add('error', 'caller_bad_value', problem, n.id);
          }
        }
        exitWarning(n.id, MATCH, 'When the number matches, the call hangs up. Connect “Matches”.');
        exitWarning(n.id, NO_MATCH, 'When the number doesn’t match, the call hangs up. Connect “Doesn’t match”.');
        planNodes[n.id] = {
          t: 'caller',
          mode: c.mode,
          values: c.mode === 'anonymous' ? [] : [...c.values],
          match: ptr(n.id, MATCH),
          nomatch: ptr(n.id, NO_MATCH),
        };
        break;
      }
      case 'dial': {
        const c = n.data.config;
        let dest: Extract<PlanNode, { t: 'transfer' }>['dest'] | null = null;
        if (c.target.kind === 'own') {
          const did = c.target.did;
          if (!did) {
            add('error', 'transfer_no_target', 'Choose where to transfer the call.', n.id);
          } else if (ctx.ownDids.includes(did)) {
            add('error', 'transfer_self', 'A transfer can’t ring this IVR’s own number — that would loop the caller back here.', n.id);
          } else {
            const own = findOwn(did, ctx.destinations);
            if (ctx.destinations && !own) {
              add('error', 'transfer_not_owned', `${prettyNumber(did)} is no longer one of your numbers. Choose another destination.`, n.id);
            } else if (own && !own.number.enabled) {
              add('warning', 'transfer_target_off', `${own.number.name ?? prettyNumber(did)} is switched off, so this transfer will go to “No answer”.`, n.id);
            }
            dest = { kind: 'own', did, product: ownProduct(did, ctx.destinations) };
          }
        } else {
          const check = checkExternalNumber(c.target.number);
          if (check.problem) add('error', `transfer_${check.problem}`, check.message ?? 'That number can’t be dialed.', n.id);
          else if (check.e164) dest = { kind: 'external', e164: check.e164 };
        }
        if (!(c.ringTimeoutSec >= LIMITS.ringTimeoutSec.min && c.ringTimeoutSec <= LIMITS.ringTimeoutSec.max)) {
          add('error', 'transfer_ring_time', 'Ring for between 5 and 120 seconds.', n.id);
        }
        exitWarning(n.id, NO_ANSWER, 'If nobody answers, the call hangs up. Connect “No answer or busy”, for example to voicemail.');
        if (dest) {
          planNodes[n.id] = {
            t: 'transfer',
            dest,
            pass_caller_id: c.passCallerId === true,
            ring_timeout: c.ringTimeoutSec,
            on_noanswer: ptr(n.id, NO_ANSWER),
          };
        }
        break;
      }
      case 'voicemail': {
        const c = n.data.config;
        if (!c.did) {
          add('error', 'voicemail_no_box', 'Choose a mailbox.', n.id);
        } else {
          const own = findOwn(c.did, ctx.destinations);
          if (ctx.destinations && (!own || own.group.product !== 'voicemail')) {
            add('error', 'voicemail_not_owned', 'That mailbox is no longer on your account. Choose another one.', n.id);
          } else if (own && !own.number.enabled) {
            add('warning', 'voicemail_off', 'That mailbox is switched off, so callers can’t leave a message.', n.id);
          }
          planNodes[n.id] = { t: 'voicemail', did: c.did };
        }
        break;
      }
      case 'goto': {
        const target = n.data.config.targetNodeId;
        const t = target ? byId.get(target) : undefined;
        if (!target) add('error', 'goto_no_target', 'Choose the block to go to.', n.id);
        else if (!t) add('error', 'goto_missing', 'The block this went to was deleted. Choose another one.', n.id);
        else if (t.type === 'entry') add('error', 'goto_start', 'Go to can’t point at Start. Point it at the first block instead.', n.id);
        else if (t.id === n.id) add('error', 'goto_self', 'A Go to block can’t point at itself.', n.id);
        break;
      }
      case 'hangup': {
        const prompts = takePrompts(n.data.config.prompts, n.id, 'This block');
        planNodes[n.id] = { t: 'hangup', prompts };
        break;
      }
    }
  }
  // Resolve once more for loop detection on Go to blocks reached only by jumps.
  for (const n of nodes) if (n.type === 'goto' && reachable.has(n.id)) resolve(n.id);
  for (const [id, code] of gotoProblems) {
    if (code === 'goto_loop') add('error', 'goto_loop', 'These Go to blocks point at each other in a circle.', id);
  }

  const start = entry ? ptr(entry.id, NEXT) : null;
  return {
    ok: !issues.some((i) => i.severity === 'error'),
    issues,
    plan: { v: 1, start, limits: { max_steps: 200, max_seconds: 1800 }, prompts: promptOrder, nodes: planNodes },
    reachable,
  };
}

/* ─── "What callers hear" ─────────────────────────────────── */

export interface TranscriptBranch {
  label: string;
  /** Plan node the branch goes to; null = the call ends there. */
  toId: string | null;
  toTitle: string;
  /** The target was already described above (a loop, or a shared block). */
  earlier: boolean;
}

export interface TranscriptEntry {
  nodeId: string;
  type: IvrNodeType;
  title: string;
  says: string;
  branches: TranscriptBranch[];
}

export interface TranscriptContext {
  promptName: (id: PromptId) => string | null;
  destinations: Destinations | null;
}

function promptPhrase(ids: readonly PromptId[], ctx: TranscriptContext): string {
  return quoteList(ids.map((id) => ctx.promptName(id) ?? 'a deleted message'));
}

/**
 * Walks the compiled plan breadth-first from Start and says, block by block,
 * what a caller hears and where each choice leads. Unconnected exits read
 * "the call ends", which is exactly what FreeSWITCH does with a null pointer.
 */
export function describePlan(graph: IvrGraph, plan: PlanPreview, ctx: TranscriptContext): TranscriptEntry[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const titleOf = (id: string | null) => {
    if (id === null) return 'The call ends';
    const n = byId.get(id);
    return n ? blockTitle(n) : 'The call ends';
  };
  const out: TranscriptEntry[] = [];
  const order: string[] = [];
  const queued = new Set<string>();
  const enqueue = (id: PlanRef) => {
    if (id !== null && plan.nodes[id] && !queued.has(id)) {
      queued.add(id);
      order.push(id);
    }
  };
  enqueue(plan.start);
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    const p = plan.nodes[id];
    const node = byId.get(id);
    if (!p || !node) continue;
    const branches: TranscriptBranch[] = [];
    const branch = (label: string, to: PlanRef) => {
      const earlier = to !== null && queued.has(to) && order.indexOf(to) <= i;
      branches.push({ label, toId: to, toTitle: titleOf(to), earlier });
      enqueue(to);
    };
    let says = '';
    switch (p.t) {
      case 'play':
        says = p.prompts.length ? `Plays ${promptPhrase(p.prompts, ctx)}.` : 'Plays nothing yet.';
        branch('Then', p.next);
        break;
      case 'menu': {
        const tries = p.retries === 0 ? 'once' : `up to ${p.retries + 1} times`;
        says = `Plays ${p.prompts.length ? promptPhrase(p.prompts, ctx) : 'nothing yet'} and listens for a key, asking ${tries}.`;
        // Keypad order (Object.entries would put "0" before "1").
        for (const digit of DIGIT_ORDER) {
          if (digit in p.digits) branch(`Press ${digit}`, p.digits[digit] ?? null);
        }
        branch('No key pressed', p.on_noinput);
        branch('Wrong key', p.on_nomatch);
        break;
      }
      case 'hours':
        says = `Checks your hours (${timezoneLabel(p.tz).replace(/ \(.*$/, '')}): ${formatWeekly(
          (node.data.config as IvrConfigMap['schedule']).weekly,
        )}${p.closed_dates.length ? `, closed on ${p.closed_dates.length} holiday${p.closed_dates.length === 1 ? '' : 's'}` : ''}.`;
        branch('Open', p.open);
        branch('Closed', p.closed);
        break;
      case 'caller':
        says =
          p.mode === 'anonymous'
            ? 'Checks whether the caller withheld their number.'
            : `Checks whether the caller’s number ${p.mode === 'prefix' ? 'starts with' : 'is'} ${p.values.join(', ')}.`;
        branch(p.mode === 'anonymous' ? 'Withheld' : 'Matches', p.match);
        branch(p.mode === 'anonymous' ? 'Not withheld' : 'Doesn’t match', p.nomatch);
        break;
      case 'transfer': {
        const where =
          p.dest.kind === 'external'
            ? `the outside number ${prettyNumber(p.dest.e164)}`
            : describeOwnNumber(p.dest.did, ctx.destinations);
        says = `Transfers the caller to ${where}, ringing up to ${p.ring_timeout} seconds and showing ${
          p.pass_caller_id ? 'the caller’s number' : 'this IVR’s number'
        }.`;
        branch('No answer or busy', p.on_noanswer);
        break;
      }
      case 'voicemail':
        says = `Sends the caller to voicemail: ${describeOwnNumber(p.did, ctx.destinations)}.`;
        break;
      case 'hangup':
        says = p.prompts.length ? `Plays ${promptPhrase(p.prompts, ctx)}, then hangs up.` : 'Hangs up.';
        break;
    }
    out.push({ nodeId: id, type: node.type, title: blockTitle(node), says, branches });
  }
  return out;
}

/** Every block a palette type stands for, for messages. */
export function typeLabel(type: IvrNodeType): string {
  return BLOCKS[type].label;
}
