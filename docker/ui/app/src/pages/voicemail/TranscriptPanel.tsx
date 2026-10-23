/**
 * TranscriptPanel — the open message's transcript, in the reading pane
 * between the player and the actions (docs/VOICEMAIL_TRANSCRIPTION_PLAN.md
 * §11.4; owner decision O2 overrides the plan where they differ).
 *
 *   status                     shows
 *   ─────────────────────────  ──────────────────────────────────────────────
 *   pending / processing       spinner + "Transcribing…" (5 s poll, stops after
 *                              3 min → "Still transcribing — check back shortly.";
 *                              "Transcription is paused." when unavailable)
 *   done                       the text (selectable) + Copy; low-confidence note
 *                              under 0.6; language when not en-US
 *   empty                      "No speech detected in this message."
 *   failed                     "We couldn't transcribe this message." + Try again
 *   disabled, mailbox off      "Transcription is off for this mailbox." — the
 *                              "Turn it on" link is for platform admins ONLY (O2)
 *   disabled, mailbox on       "This message arrived while transcription was off."
 *                              + Transcribe
 *   503 / other error          "The transcript is temporarily unavailable." + Retry
 *   500                        the API detail, verbatim
 *
 * Every retry button follows the API's `can_retry` (writer, available, mailbox
 * on, not trashed, retryable status — admins also get it for `done`, as a
 * forced re-run). Reading a done transcript counts as reading the message:
 * writers mark it read once (readonly users can't — PATCH is writer-only).
 *
 * The panel renders nothing while there is nothing to say: transcription not
 * live on the platform and this mailbox never used it, or a not-yet-transcribed
 * message sitting in Trash (Trash is never transcribed).
 *
 * The text lives only in React Query memory (D8) — never storage.
 */
import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Copy, RefreshCw, RotateCcw } from 'lucide-react';
import type { Mailbox, TranscriptStatus, VoicemailFolder, VoicemailMessage } from '../../types/voicemail';
import { TRANSCRIPTION_LANGUAGES } from '../../types/voicemail';
import { retryTranscript } from '../../api/voicemail';
import { ApiError } from '../../api/client';
import { useToast } from '../../components/ui/ToastContext';
import {
  FOLDER_TRANSCRIPT_POLL_MS,
  invalidateTranscript,
  invalidateVoicemail,
  isTranscriptActive,
  isTranscriptStalled,
  isUnavailable,
  transcriptErrorText,
  transcriptStatusOf,
  useTranscript,
  vmErrorText,
  vmTranscriptKeys,
  type TranscriptEntry,
  type VoicemailScope,
} from './voicemailData';

/** Below this the panel suggests listening to be sure (plan §11.4). */
const LOW_CONFIDENCE = 0.6;
/** How far the folder list (polled every 10 s) can trail this pane's own fetch. */
const LIST_LAG_MS = 2 * FOLDER_TRANSCRIPT_POLL_MS + 5_000;

export interface TranscriptPanelProps {
  scope: VoicemailScope;
  message: VoicemailMessage;
  mailbox: Mailbox;
  folder: VoicemailFolder;
  /** Writer (tenant `user`, or staff). Reading a done transcript marks the message read. */
  canEdit: boolean;
  /** Platform admin, incl. "View as Customer" (O2: the only role that may turn transcription on). */
  canManage: boolean;
  /** summary.transcription_available. */
  transcriptionAvailable: boolean;
  /** Marks this message read (InboxView's 'read' action). */
  onMarkRead: () => void;
  /** Switches the workspace to the "Greeting & settings" tab. */
  onOpenSettings: () => void;
}

/** The language's name ("Spanish (US)"), or null for en-US / unknown-null. */
function languageLabel(language: string | null): string | null {
  if (!language || language === 'en-US') return null;
  return TRANSCRIPTION_LANGUAGES.find((l) => l.id === language)?.label ?? language;
}

/** Whether the panel has anything to say for this message (see the header comment). */
function panelVisible(status: TranscriptStatus, inTrash: boolean, available: boolean, mailboxOn: boolean): boolean {
  if (inTrash && isTranscriptActive(status)) return false;
  if (status === 'disabled' && !available && !mailboxOn) return false;
  return true;
}

export function TranscriptPanel({
  scope,
  message,
  mailbox,
  folder,
  canEdit,
  canManage,
  transcriptionAvailable,
  onMarkRead,
  onOpenSettings,
}: TranscriptPanelProps) {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const titleId = useId();
  const markedRead = useRef(false);

  const listStatus = transcriptStatusOf(message);
  const inTrash = folder === 'trash';
  const mailboxOn = mailbox.transcription_enabled === true;
  const visible = panelVisible(listStatus, inTrash, transcriptionAvailable, mailboxOn);

  const query = useTranscript(scope, message.id, visible, transcriptionAvailable && !inTrash);
  const entry: TranscriptEntry | undefined = query.data;
  const transcript = entry?.transcript;

  const retry = useMutation({
    mutationFn: (force: boolean) => retryTranscript(message.id, force),
    onSuccess: () => toastOk('Transcribing this message — the text appears here shortly.'),
    onError: (err) => toastErr(transcriptErrorText(err, 'The message couldn’t be sent for transcription. Try again.')),
    onSettled: () => {
      invalidateTranscript(queryClient, scope, message.id);
      invalidateVoicemail(queryClient);
    },
  });

  // The list (polled every 10 s while anything is in progress) is how this
  // pane learns a transcript moved on — after its own 3-min poll stopped, or
  // someone else retried it. Runs only when the LIST's status changes (and on
  // mount, for a cached transcript from an earlier visit): the cached
  // transcript is read imperatively, not as a dependency, so a list that lags
  // our own fetch can never loop a decrypt.
  useEffect(() => {
    if (!visible) return;
    const queryKey = vmTranscriptKeys.full(scope, message.id);
    const cached = queryClient.getQueryData<TranscriptEntry>(queryKey);
    if (!cached || cached.transcript.status === listStatus) return;
    if (queryClient.isFetching({ queryKey, exact: true }) > 0) return;
    // A list still catching up with our own fresh `done` fetch is not news —
    // refetching would decrypt (and audit) the same text again.
    if (cached.transcript.status === 'done' && Date.now() - cached.fetchedAt < LIST_LAG_MS) return;
    invalidateTranscript(queryClient, scope, message.id);
  }, [queryClient, scope, message.id, visible, listStatus]);

  // Reading the transcript counts as reading the message — once per opening
  // (Trash shows no read state, so nothing to update there).
  const showsText = transcript?.status === 'done';
  useEffect(() => {
    if (showsText && canEdit && !inTrash && !message.is_read && !markedRead.current) {
      markedRead.current = true;
      onMarkRead();
    }
  }, [showsText, canEdit, inTrash, message.is_read, onMarkRead]);

  const text = transcript?.text ?? '';
  const copy = useCallback(async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      toastOk('Transcript copied.');
    } catch {
      toastErr('The transcript couldn’t be copied — select the text and copy it instead.');
    }
  }, [text, toastOk, toastErr]);

  // ── Derived (after all hooks) ──
  if (!visible) return null;

  const status: TranscriptStatus = transcript?.status ?? listStatus;
  const canRetry = canEdit && transcript?.can_retry === true;
  const retrying = retry.isPending;

  const retryButton = (label: string, force: boolean): ReactNode => (
    <button type="button" className="dl-btn dl-btn-ghost vm-btn-sm" disabled={retrying} onClick={() => retry.mutate(force)}>
      {retrying ? <span className="vm-spin" aria-hidden="true" /> : <RotateCcw size={14} aria-hidden="true" />}
      {label}
    </button>
  );

  let body: ReactNode;
  let foot: ReactNode = null;
  let note: ReactNode = null;
  let tools: ReactNode = null;
  let sub: string | null = null;

  if (!transcript && query.isError) {
    const err = query.error;
    const verbatim = err instanceof ApiError && err.status === 500 && err.message ? err.message : null;
    body = (
      <p className="vm-tx-state vm-tx-state-err">
        {verbatim ??
          (isUnavailable(err) || !(err instanceof ApiError)
            ? 'The transcript is temporarily unavailable.'
            : vmErrorText(err, 'The transcript couldn’t load.'))}
        {!verbatim && (
          <button type="button" className="vm-linkbtn" onClick={() => void query.refetch()} disabled={query.isFetching}>
            <RefreshCw size={13} aria-hidden="true" /> Retry
          </button>
        )}
      </p>
    );
  } else if (!transcript && listStatus === 'done') {
    body = (
      <p className="vm-tx-state">
        <span className="vm-spin" aria-hidden="true" /> Loading transcript…
      </p>
    );
  } else if (isTranscriptActive(status)) {
    if (!transcriptionAvailable) {
      body = <p className="vm-tx-state">Transcription is paused.</p>;
    } else if (isTranscriptStalled(entry)) {
      body = <p className="vm-tx-state">Still transcribing — check back shortly.</p>;
    } else {
      body = (
        <p className="vm-tx-state">
          <span className="vm-spin" aria-hidden="true" /> Transcribing…
        </p>
      );
    }
  } else if (status === 'done' && transcript) {
    sub = 'Machine-generated — may contain mistakes.';
    const language = languageLabel(transcript.language);
    tools = (
      <>
        {language && <span className="dl-tag dl-tag-slate">{language}</span>}
        <button type="button" className="dl-btn dl-btn-ghost vm-btn-sm" onClick={() => void copy()} disabled={!text}>
          <Copy size={14} aria-hidden="true" /> Copy
        </button>
      </>
    );
    body = (
      // Focusable so keyboard users can scroll a long transcript.
      <div className="vm-tx-text" tabIndex={0}>
        {text}
      </div>
    );
    if (transcript.confidence !== null && transcript.confidence < LOW_CONFIDENCE) {
      note = (
        <p className="vm-tx-note">
          <AlertTriangle size={13} aria-hidden="true" />
          Low confidence — listen to the recording to be sure.
        </p>
      );
    }
    // can_retry on `done` only ever reaches admins (a forced re-run).
    if (canRetry) foot = retryButton('Transcribe again', true);
  } else if (status === 'empty') {
    body = <p className="vm-tx-state">No speech detected in this message.</p>;
    if (canRetry) foot = retryButton('Transcribe again', false);
  } else if (status === 'failed') {
    body = <p className="vm-tx-state">We couldn’t transcribe this message.</p>;
    if (canRetry) foot = retryButton('Try again', false);
  } else if (!mailboxOn) {
    // disabled, mailbox off — O2: only a platform admin may switch it on.
    body = (
      <p className="vm-tx-state">
        Transcription is off for this mailbox.
        {canManage && transcriptionAvailable && (
          <button type="button" className="vm-linkbtn" onClick={onOpenSettings}>
            Turn it on in Greeting &amp; settings
          </button>
        )}
      </p>
    );
  } else {
    // disabled, mailbox on — it arrived before transcription was switched on.
    body = <p className="vm-tx-state">This message arrived while transcription was off.</p>;
    if (canRetry) foot = retryButton('Transcribe', false);
  }

  // The section is the one live region (state changes and the arriving text
  // are announced politely); nothing inside carries its own live role.
  return (
    <section className="vm-tx" aria-labelledby={titleId} aria-live="polite">
      <div className="vm-tx-head">
        <div className="vm-tx-id">
          <h3 id={titleId} className="vm-tx-title">
            Transcript
          </h3>
          {sub && <p className="vm-tx-sub">{sub}</p>}
        </div>
        {tools && <div className="vm-tx-tools">{tools}</div>}
      </div>
      {body}
      {note}
      {foot && <div className="vm-tx-foot">{foot}</div>}
    </section>
  );
}
