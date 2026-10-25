/**
 * conversation.ts — the Flow assistant panel's state machine (pure; the
 * builder's useFlowAssistant hook drives it, assist.assert.ts tests it).
 *
 *   idle ──send──► sending ──started──► running ──done──► proposal on canvas
 *     ▲               │                    │      └──────► question / refusal
 *     │           startFailed            failed ─────────► error turn
 *     │                                                       │
 *     └────── accepted · discarded · (a clarify keeps the proposal) ┘
 *
 * Rules (docs/IVR_ASSIST_INTERFACES.md §5, §7):
 *  - ONE conversation per builder: the server's `conversation_id` is kept
 *    and sent with every later message, so the assistant sees the history.
 *  - While a proposal is on the canvas the message box is closed until the
 *    customer chooses: Accept, Discard, or Refine — Refine opens it and the
 *    next message carries `refine_job_id` (that proposal becomes the base).
 *    Without Refine a message carries the in-memory draft instead.
 *  - A newer proposal replaces the one on screen (its turn reads "Replaced").
 *    A question or refusal leaves the proposal (and Refine mode) as it was.
 */
import type { AssistProposal, AssistResult, AssistStartRequest, IvrGraph } from '../../types/ivr.ts';
import { JOB_ERROR_TEXT, MESSAGE_MAX_CHARS } from './model.ts';

export type ProposalTurnState = 'shown' | 'accepted' | 'discarded' | 'replaced';

export type Turn =
  | { id: number; who: 'customer'; text: string; refining: boolean }
  | { id: number; who: 'assistant'; kind: 'proposal'; jobId: string; text: string; state: ProposalTurnState }
  | { id: number; who: 'assistant'; kind: 'clarify' | 'cannot_build'; text: string }
  | { id: number; who: 'error'; text: string };

export interface RunningJob {
  jobId: string;
  /** Local clock (ms) when the job was accepted — the 300 s poll limit counts from here. */
  startedAt: number;
}

export interface ShownProposal {
  jobId: string;
  result: AssistProposal;
}

export interface ConversationState {
  conversationId: string | null;
  turns: Turn[];
  nextId: number;
  /** The POST that starts a job is in flight. */
  sending: boolean;
  running: RunningJob | null;
  /** The proposal on the canvas (not yet accepted or discarded). */
  proposal: ShownProposal | null;
  /** Refine mode: the next message changes this job's proposal. */
  refineOf: string | null;
  accepting: boolean;
  acceptError: string | null;
  /** Why the last message couldn't be sent (shown under the message box). */
  notice: string | null;
  /** Set when the account can't use the assistant (403): the box stays closed. */
  blocked: string | null;
  /** The polite live-region line: what just happened. */
  announcement: string;
  /** +1 with every announcement, so the same words twice are still read out. */
  announceSeq: number;
}

export type ConversationAction =
  | { type: 'send' }
  | { type: 'started'; jobId: string; conversationId: string; text: string; refining: boolean; at: number }
  | { type: 'startFailed'; text: string; blocked?: boolean }
  | { type: 'done'; jobId: string; result: AssistResult }
  | { type: 'failed'; jobId: string; text: string }
  | { type: 'refine' }
  | { type: 'cancelRefine' }
  | { type: 'acceptStart' }
  | { type: 'acceptFailed'; text: string }
  | { type: 'accepted' }
  | { type: 'discarded' }
  | { type: 'reset' };

export function initialConversation(): ConversationState {
  return {
    conversationId: null,
    turns: [],
    nextId: 1,
    sending: false,
    running: null,
    proposal: null,
    refineOf: null,
    accepting: false,
    acceptError: null,
    notice: null,
    blocked: null,
    announcement: '',
    announceSeq: 0,
  };
}

/** The live-region line, counted so a repeat is still announced. */
function say(s: ConversationState, text: string): Pick<ConversationState, 'announcement' | 'announceSeq'> {
  return { announcement: text, announceSeq: s.announceSeq + 1 };
}

/** Omit that distributes over a union (plain Omit would merge the members). */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
/** A turn before it gets its id. */
type NewTurn = WithoutId<Turn>;

function append(s: ConversationState, ...turns: NewTurn[]): Pick<ConversationState, 'turns' | 'nextId'> {
  let id = s.nextId;
  const added = turns.map((t) => ({ ...t, id: id++ }) as Turn);
  return { turns: [...s.turns, ...added], nextId: id };
}

function markProposal(turns: readonly Turn[], jobId: string | null, state: ProposalTurnState): Turn[] {
  return turns.map((t) =>
    t.who === 'assistant' && t.kind === 'proposal' && t.state === 'shown' && (jobId === null || t.jobId === jobId)
      ? { ...t, state }
      : t,
  );
}

export function conversationReducer(s: ConversationState, a: ConversationAction): ConversationState {
  switch (a.type) {
    case 'send':
      return { ...s, sending: true, notice: null };
    case 'started':
      return {
        ...s,
        ...append(s, { who: 'customer', text: a.text, refining: a.refining }),
        conversationId: a.conversationId || s.conversationId,
        sending: false,
        running: { jobId: a.jobId, startedAt: a.at },
        ...say(s, 'The flow assistant is working on your request.'),
      };
    case 'startFailed':
      return {
        ...s,
        sending: false,
        notice: a.text,
        blocked: a.blocked ? a.text : s.blocked,
        ...say(s, a.text),
      };
    case 'done': {
      if (s.running?.jobId !== a.jobId) return s;
      const r = a.result;
      if (r.kind === 'proposal') {
        const turns = markProposal(s.turns, null, 'replaced');
        return {
          ...s,
          ...append({ ...s, turns }, {
            who: 'assistant',
            kind: 'proposal',
            jobId: a.jobId,
            text: r.summary || 'Here is a proposed flow.',
            state: 'shown',
          }),
          running: null,
          proposal: { jobId: a.jobId, result: r },
          refineOf: null,
          acceptError: null,
          ...say(s, 'A proposed flow is ready. It is shown on the canvas, and nothing has changed yet.'),
        };
      }
      const text = r.kind === 'clarify' ? r.question : r.message;
      return {
        ...s,
        ...append(s, { who: 'assistant', kind: r.kind, text }),
        running: null,
        ...say(s, r.kind === 'clarify' ? `The flow assistant asks: ${text}` : text),
      };
    }
    case 'failed':
      if (s.running?.jobId !== a.jobId) return s;
      return { ...s, ...append(s, { who: 'error', text: a.text }), running: null, ...say(s, a.text) };
    case 'refine':
      return s.proposal ? { ...s, refineOf: s.proposal.jobId, notice: null } : s;
    case 'cancelRefine':
      return { ...s, refineOf: null };
    case 'acceptStart':
      return { ...s, accepting: true, acceptError: null };
    case 'acceptFailed':
      return { ...s, accepting: false, acceptError: a.text, ...say(s, a.text) };
    case 'accepted':
      return {
        ...s,
        turns: markProposal(s.turns, s.proposal?.jobId ?? null, 'accepted'),
        proposal: null,
        refineOf: null,
        accepting: false,
        acceptError: null,
        ...say(s, 'The proposal is now your draft. Nothing is live until you publish.'),
      };
    case 'discarded':
      return {
        ...s,
        turns: markProposal(s.turns, s.proposal?.jobId ?? null, 'discarded'),
        proposal: null,
        refineOf: null,
        accepting: false,
        acceptError: null,
        ...say(s, 'Proposal discarded. Your draft is unchanged.'),
      };
    case 'reset':
      return { ...initialConversation(), blocked: s.blocked };
  }
}

/* ─── Derived ─────────────────────────────────────────────── */

/** May the customer type and send right now? */
export function canCompose(s: ConversationState): boolean {
  return s.blocked === null && !s.sending && s.running === null && !s.accepting && (s.proposal === null || s.refineOf !== null);
}

/** Why the message box is closed (null = it's open). */
export function composeBlockedReason(s: ConversationState): string | null {
  if (s.blocked) return s.blocked;
  if (s.sending || s.running) return null; // the live status says it
  if (s.accepting) return 'Adding the proposal to your draft…';
  if (s.proposal && s.refineOf === null) return 'Accept, refine or discard the proposal to continue.';
  return null;
}

/**
 * The body of `POST /ivr/flows/{id}/assist` (§5): the trimmed message, the
 * conversation to continue, and the base — the proposal being refined, or
 * else the builder's in-memory draft.
 */
export function buildStartRequest(text: string, s: ConversationState, draft: IvrGraph): AssistStartRequest {
  const body: AssistStartRequest = { message: text.trim().slice(0, MESSAGE_MAX_CHARS) };
  if (s.conversationId) body.conversation_id = s.conversationId;
  if (s.refineOf) body.refine_job_id = s.refineOf;
  else body.draft_graph = draft;
  return body;
}

/* ─── Start errors (the POST, before any job exists) ──────── */

export interface StartFailure {
  status: number | null;
  code: string | null;
  retryAfterS: number | null;
}

/** `retry_after_s` wherever FastAPI put it (top level, or inside `detail`). */
export function readRetryAfter(raw: unknown): number | null {
  const pick = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.ceil(v) : null);
  if (typeof raw !== 'object' || raw === null) return null;
  const top = raw as Record<string, unknown>;
  const inner = typeof top.detail === 'object' && top.detail !== null ? (top.detail as Record<string, unknown>) : {};
  return pick(top.retry_after_s) ?? pick(inner.retry_after_s);
}

/**
 * Customer text for a refused start. `blocked` = the account can't use the
 * assistant at all, so the message box stays closed.
 */
export function startErrorText(f: StartFailure): { text: string; blocked: boolean } {
  switch (f.code) {
    case 'ivr_assist_not_enabled':
      return { text: 'The flow assistant isn’t available for this account. You can keep building by hand.', blocked: true };
    case 'assist_busy':
      return { text: 'The flow assistant is already working on a request for this flow. Try again in a minute.', blocked: false };
    case 'assist_rate_limited':
      return {
        text: f.retryAfterS
          ? `That’s a lot of requests in a row. Try again in ${f.retryAfterS} second${f.retryAfterS === 1 ? '' : 's'}.`
          : 'That’s a lot of requests in a row. Try again in a minute.',
        blocked: false,
      };
    case 'assist_daily_limit':
      return { text: 'You’ve reached today’s limit for the flow assistant. You can keep building by hand.', blocked: false };
    case 'ivr_not_enabled':
      return { text: 'IVR isn’t switched on for this account.', blocked: true };
    default:
      break;
  }
  if (f.status === 404) return { text: 'This flow doesn’t exist any more. Go back to IVR and open it again.', blocked: true };
  if (f.status === 403) return { text: 'You don’t have permission to use the flow assistant on this flow.', blocked: true };
  if (f.status === 422) return { text: 'The flow assistant couldn’t take that request. Shorten it and try again.', blocked: false };
  return { text: JOB_ERROR_TEXT.assistant_unavailable, blocked: false };
}
