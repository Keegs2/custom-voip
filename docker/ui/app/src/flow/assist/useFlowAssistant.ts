/**
 * useFlowAssistant — the Flow assistant's side of the builder
 * (docs/IVR_ASSIST_INTERFACES.md §5 + §7). Created ONCE in FlowBuilder (so
 * closing the panel keeps the conversation, a running job and the proposal)
 * and shared through AssistContext with the panel, the canvas banner and the
 * phone view.
 *
 *   send     POST …/assist with the in-memory draft (or `refine_job_id`),
 *            then poll the job every 1.5 s, giving up after 300 s
 *   done     a proposal is drawn read-only (store.showProposal) and revealed
 *            block by block in calling order — at once under reduced motion;
 *            a question or a refusal joins the transcript
 *   accept   create the new messages (POST /ivr/prompts/tts with the chosen
 *            voice; a retry reuses what was already made), swap the
 *            placeholder ids, apply Tidy up, store.replaceDraft (ONE undoable
 *            edit that autosave writes), then post `outcome: accepted`
 *   discard  drop the overlay, post `outcome: discarded`
 *
 * Nothing here publishes. React #310: every hook is unconditional.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type RefObject } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { createTtsPrompt, getAssistJob, postAssistOutcome, startAssist } from '../../api/ivr';
import type { Prompt, Voice } from '../../types/ivr';
import { useToast } from '../../components/ui/ToastContext';
import { ivrErrorText, ivrKeys, readIvrError, useVoices, type IvrScope } from '../../pages/ivr/ivrData';
import { useFlow, type FlowStore } from '../store/flowStore';
import {
  acceptedGraph,
  createMissingPrompts,
  JOB_ERROR_TEXT,
  jobErrorText,
  MESSAGE_MAX_CHARS,
  MissingMessageError,
  parseAssistJob,
  POLL_INTERVAL_MS,
  POLL_LIMIT_MS,
  promptsToCreate,
  PromptCreateError,
} from './model';
import {
  buildStartRequest,
  canCompose,
  conversationReducer,
  initialConversation,
  readRetryAfter,
  startErrorText,
  type ConversationState,
} from './conversation';

export interface FlowAssistant {
  /** The summary says the assistant is on for this account, and this viewer may edit. */
  available: boolean;
  state: ConversationState;
  canCompose: boolean;
  draft: string;
  setDraft: (text: string) => void;
  send: () => void;
  refine: () => void;
  cancelRefine: () => void;
  accept: () => void;
  discard: () => void;
  /** Start a new conversation (only while nothing is running or on the canvas). */
  reset: () => void;
  voices: readonly Voice[];
  voicesLoading: boolean;
  voicesFailed: boolean;
  /** The voice new messages are read in ('' = none available). */
  voice: string;
  setVoice: (id: string) => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  /** Bumped to ask an open panel to focus the message box (Refine, an example). */
  focusToken: number;
  requestFocus: () => void;
}

const AssistContext = createContext<FlowAssistant | null>(null);
export const AssistProvider = AssistContext.Provider;

export function useAssist(): FlowAssistant {
  const a = useContext(AssistContext);
  if (!a) throw new Error('useAssist outside AssistProvider');
  return a;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Accept failures → what the banner says. Nothing in the draft has changed in any of them. */
function acceptErrorText(err: unknown): string {
  const keep = 'Your draft hasn’t changed. Try again — messages already made are reused.';
  if (err instanceof PromptCreateError) {
    return `The message “${err.prompt.name}” couldn’t be created: ${ivrErrorText(err.cause, 'try again in a moment.')} ${keep}`;
  }
  if (err instanceof MissingMessageError) {
    return 'This proposal uses a message that isn’t there. Refine it, or build that part by hand.';
  }
  if (err instanceof Error && err.message === 'no-voice') {
    return 'Text to speech is unavailable right now, so the new messages can’t be made. Try again later.';
  }
  return `The proposal couldn’t be added to your draft. ${keep}`;
}

export interface AssistInput {
  store: FlowStore;
  flowId: number;
  scope: IvrScope;
  /** `summary.assist.available` (false on an older API). */
  enabled: boolean;
  canEdit: boolean;
  /** Called when a new proposal lands on the canvas (the phone view closes its sheet to show it). */
  onProposal?: () => void;
}

export function useFlowAssistant({ store, flowId, scope, enabled, canEdit, onProposal }: AssistInput): FlowAssistant {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const available = enabled && canEdit;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [state, dispatch] = useReducer(conversationReducer, undefined, initialConversation);
  const [draft, setDraft] = useState('');
  const [voicePick, setVoice] = useState('');
  const [focusToken, setFocusToken] = useState(0);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  /** jobId → (placeholder id → real prompt id). Kept across Accept retries. */
  const mappings = useRef(new Map<string, Map<number, number>>());
  const voices = useVoices(scope, available);
  const onProposalRef = useRef(onProposal);
  useEffect(() => {
    onProposalRef.current = onProposal;
  });
  const proposalJob = useFlow((s) => s.proposal?.jobId ?? null);
  const revealing = useFlow((s) => (s.proposal ? s.proposal.revealed < s.proposal.order.length : false));

  const voiceList = useMemo(() => voices.data ?? [], [voices.data]);
  const voice = voiceList.some((v) => v.id === voicePick) ? voicePick : (voiceList[0]?.id ?? '');
  const customerId = scope.customerId;
  const runningJob = state.running?.jobId ?? null;
  const runningSince = state.running?.startedAt ?? 0;

  /* ── Poll the running job ── */
  useEffect(() => {
    if (runningJob === null) return undefined;
    const jobId = runningJob;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };
    const tick = async () => {
      if (!alive) return;
      if (Date.now() - runningSince >= POLL_LIMIT_MS) {
        dispatch({ type: 'failed', jobId, text: JOB_ERROR_TEXT.assistant_failed });
        return;
      }
      try {
        const job = parseAssistJob(await getAssistJob(flowId, jobId, customerId));
        if (!alive) return;
        if (!job) {
          dispatch({ type: 'failed', jobId, text: JOB_ERROR_TEXT.assistant_failed });
        } else if (job.status === 'running') {
          schedule();
        } else if (job.status === 'done' && job.result) {
          if (job.result.kind === 'proposal') {
            store.getState().showProposal(jobId, job.result.draft_graph, { instant: prefersReducedMotion() });
          }
          dispatch({ type: 'done', jobId, result: job.result });
          if (job.result.kind === 'proposal') onProposalRef.current?.();
        } else {
          dispatch({ type: 'failed', jobId, text: jobErrorText(job.error?.code) });
        }
      } catch (err) {
        if (!alive) return;
        // The job is gone or not ours any more: stop. Anything else (network,
        // a 5xx) is transient — keep polling until the 300 s limit.
        if (err instanceof ApiError && [400, 403, 404].includes(err.status)) {
          dispatch({ type: 'failed', jobId, text: JOB_ERROR_TEXT.assistant_failed });
        } else {
          schedule();
        }
      }
    };
    schedule();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [runningJob, runningSince, flowId, customerId, store]);

  /* ── Reveal the proposal's blocks one at a time ── */
  useEffect(() => {
    if (!revealing) return undefined;
    const total = store.getState().proposal?.order.length ?? 0;
    // ~2.4 s for the whole flow, never faster than 60 ms or slower than 160 ms a block.
    const step = Math.max(60, Math.min(160, Math.round(2400 / Math.max(1, total))));
    const t = setInterval(() => {
      if (!store.getState().revealNext()) clearInterval(t);
    }, step);
    return () => clearInterval(t);
  }, [proposalJob, revealing, store]);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!available || !text || text.length > MESSAGE_MAX_CHARS || !canCompose(state)) return;
    const refining = state.refineOf !== null;
    const body = buildStartRequest(text, state, store.getState().graph());
    dispatch({ type: 'send' });
    void (async () => {
      try {
        const r = await startAssist(flowId, body, customerId);
        if (typeof r?.job_id !== 'string' || r.job_id === '') throw new Error('bad-start');
        dispatch({ type: 'started', jobId: r.job_id, conversationId: r.conversation_id, text, refining, at: Date.now() });
        setDraft('');
      } catch (err) {
        const failure = {
          status: err instanceof ApiError ? err.status : null,
          code: readIvrError(err).code,
          retryAfterS: err instanceof ApiError ? readRetryAfter(err.raw) : null,
        };
        const { text: why, blocked } = startErrorText(failure);
        dispatch({ type: 'startFailed', text: why, blocked });
        // The account lost the assistant since the page loaded: refresh the summary.
        if (failure.code === 'ivr_assist_not_enabled') void queryClient.invalidateQueries({ queryKey: ivrKeys.summary(scope) });
      }
    })();
  }, [available, draft, state, store, flowId, customerId, queryClient, scope]);

  const accept = useCallback(() => {
    const p = state.proposal;
    if (!p || state.accepting) return;
    const voiceId = voice;
    let mapping = mappings.current.get(p.jobId);
    if (!mapping) {
      mapping = new Map();
      mappings.current.set(p.jobId, mapping);
    }
    const map = mapping;
    dispatch({ type: 'acceptStart' });
    void (async () => {
      try {
        if (promptsToCreate(p.result, map).length > 0 && !voiceId) throw new Error('no-voice');
        await createMissingPrompts(p.result, map, async (np) => {
          const prompt = await createTtsPrompt({ name: np.name, text: np.text, voice: voiceId }, customerId);
          // In the cache at once, so the accepted blocks show the message by name.
          queryClient.setQueryData<Prompt[]>(ivrKeys.prompts(scope), (old) =>
            old ? [...old.filter((x) => x.id !== prompt.id), prompt] : [prompt],
          );
          return prompt.id;
        });
        const graph = acceptedGraph(p.result.draft_graph, map);
        store.getState().replaceDraft(graph);
        const seq = store.getState().changeSeq;
        mappings.current.delete(p.jobId);
        dispatch({ type: 'accepted' });
        void queryClient.invalidateQueries({ queryKey: ivrKeys.prompts(scope) });
        // Recorded once server-side; a failure here changes nothing for the customer.
        void postAssistOutcome(flowId, p.jobId, 'accepted', customerId).catch(() => undefined);
        toast({
          variant: 'success',
          message: 'The proposal is now your draft. Nothing is live until you publish.',
          duration: 8000,
          action: {
            label: 'Undo',
            onClick: () => {
              // Only while the accept is still the latest edit.
              if (store.getState().changeSeq === seq) store.getState().undo();
            },
          },
        });
      } catch (err) {
        dispatch({ type: 'acceptFailed', text: acceptErrorText(err) });
      }
    })();
  }, [state.proposal, state.accepting, voice, customerId, queryClient, scope, store, flowId, toast]);

  const discard = useCallback(() => {
    const p = state.proposal;
    if (!p || state.accepting) return;
    store.getState().clearProposal();
    mappings.current.delete(p.jobId);
    dispatch({ type: 'discarded' });
    void postAssistOutcome(flowId, p.jobId, 'discarded', customerId).catch(() => undefined);
  }, [state.proposal, state.accepting, store, flowId, customerId]);

  const requestFocus = useCallback(() => setFocusToken((t) => t + 1), []);

  const refine = useCallback(() => {
    dispatch({ type: 'refine' });
    setFocusToken((t) => t + 1);
  }, []);

  const cancelRefine = useCallback(() => dispatch({ type: 'cancelRefine' }), []);

  const reset = useCallback(() => {
    if (state.running || state.sending || state.proposal) return;
    dispatch({ type: 'reset' });
    setDraft('');
  }, [state.running, state.sending, state.proposal]);

  return useMemo<FlowAssistant>(
    () => ({
      available,
      state,
      canCompose: available && canCompose(state),
      draft,
      setDraft,
      send,
      refine,
      cancelRefine,
      accept,
      discard,
      reset,
      voices: voiceList,
      voicesLoading: voices.isLoading,
      voicesFailed: voices.isError || (voices.isSuccess && voiceList.length === 0),
      voice,
      setVoice,
      composerRef,
      focusToken,
      requestFocus,
    }),
    [
      available,
      state,
      draft,
      send,
      refine,
      cancelRefine,
      accept,
      discard,
      reset,
      voiceList,
      voices.isLoading,
      voices.isError,
      voices.isSuccess,
      voice,
      focusToken,
      requestFocus,
    ],
  );
}
