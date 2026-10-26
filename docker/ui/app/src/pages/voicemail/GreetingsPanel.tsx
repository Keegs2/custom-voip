/**
 * GreetingsPanel — what callers hear before the beep.
 *
 *   ( ) Standard greeting   — the platform's default prompt
 *   ( ) Custom greeting     — one of the mailbox's own recordings
 *   [list: ▶ name · 0:14 · Oct 20   Active | Use this · Delete]   [+ Add a greeting]
 *
 * "Custom" needs a stored greeting (the API answers 422 otherwise), so it is
 * disabled until one exists; choosing it with none active activates the
 * newest. Deleting the active greeting drops the mailbox back to standard
 * (server-side, contract §4.3). Readonly viewers can listen only. The list
 * shows the first 4 greetings, then "Show all N greetings" (layout kit).
 */
import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import type { Greeting, GreetingMode, Mailbox, MailboxUpdate } from '../../types/voicemail';
import { deleteGreeting, getGreetingPlaybackToken, updateMailbox } from '../../api/voicemail';
import { useToast } from '../../components/ui/ToastContext';
import { Spinner } from '../../components/ui/Spinner';
import { invalidateVoicemail, isUnavailable, UNAVAILABLE_TEXT, useGreetings, vmErrorText, type VoicemailScope } from './voicemailData';
import { Player } from './Player';
import { ConfirmDialog } from './VmDialog';
import { GreetingDialog } from './GreetingDialog';
import { formatDate, formatDurationMs, safeTimeZone } from './format';
import { ShowMoreButton, useShowMore } from '../../components/layout/kit';

/** Greetings listed before "Show all". */
const GREETINGS_SHOWN = 4;

export interface GreetingsPanelProps {
  scope: VoicemailScope;
  mailbox: Mailbox;
  canEdit: boolean;
  /** Layout classes from the parent (e.g. the kit's `lk-grow`). */
  className?: string;
}

export function GreetingsPanel({ scope, mailbox, canEdit, className }: GreetingsPanelProps) {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const greetings = useGreetings(scope, mailbox.id);
  const [adding, setAdding] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Greeting | null>(null);

  const patch = useMutation({
    mutationFn: (body: MailboxUpdate) => updateMailbox(mailbox.id, body),
    onSuccess: (_mb, body) =>
      toastOk(body.greeting_mode === 'standard' ? 'Callers now hear the standard greeting.' : 'Greeting updated — callers hear it now.'),
    onError: (err) => toastErr(vmErrorText(err, 'The greeting couldn’t be changed.')),
    onSettled: () => invalidateVoicemail(queryClient),
  });

  const remove = useMutation({
    mutationFn: (g: Greeting) => deleteGreeting(g.id),
    onSuccess: () => {
      setDeleteTarget(null);
      toastOk('Greeting deleted.');
    },
    onSettled: () => invalidateVoicemail(queryClient),
  });

  const mintFor = useCallback((id: number) => () => getGreetingPlaybackToken(id), []);
  const list = useMemo(() => greetings.data ?? [], [greetings.data]);
  const more = useShowMore(list, GREETINGS_SHOWN);

  // ── Derived (after all hooks) ──
  const tz = safeTimeZone(mailbox.timezone);
  const newest = [...list].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
  const activeId = mailbox.greeting_mode === 'custom' ? mailbox.active_greeting_id : null;

  const chooseMode = (mode: GreetingMode) => {
    if (mode === mailbox.greeting_mode || patch.isPending) return;
    if (mode === 'standard') {
      patch.mutate({ greeting_mode: 'standard' });
      return;
    }
    const target = list.find((g) => g.id === mailbox.active_greeting_id) ?? newest;
    if (target) patch.mutate({ greeting_mode: 'custom', active_greeting_id: target.id });
  };

  return (
    <section
      className={`dl-panel vm-settings-panel vm-greet-panel${className ? ` ${className}` : ''}`}
      aria-labelledby={`vm-greet-${mailbox.id}`}
    >
      <div className="dl-panel-head">
        <span id={`vm-greet-${mailbox.id}`} className="dl-panel-title">
          Greeting
        </span>
        {canEdit && (
          <button type="button" className="dl-btn dl-btn-primary vm-btn-sm vm-head-action" onClick={() => setAdding(true)}>
            <Plus size={14} aria-hidden="true" /> Add a greeting
          </button>
        )}
        <p className="dl-panel-sub">What callers hear before the beep.</p>
      </div>
      <div className="dl-panel-body">
        <div className="vm-modes" role="radiogroup" aria-label="Greeting callers hear">
          <label className={`vm-mode${mailbox.greeting_mode === 'standard' ? ' vm-mode-on' : ''}`}>
            <input
              type="radio"
              name={`vm-mode-${mailbox.id}`}
              checked={mailbox.greeting_mode === 'standard'}
              disabled={!canEdit || patch.isPending}
              onChange={() => chooseMode('standard')}
            />
            <span>
              <strong>Standard greeting</strong>
              <span className="dl-help">A short prompt asks the caller to leave a message after the tone.</span>
            </span>
          </label>
          <label className={`vm-mode${mailbox.greeting_mode === 'custom' ? ' vm-mode-on' : ''}${list.length === 0 ? ' vm-mode-off' : ''}`}>
            <input
              type="radio"
              name={`vm-mode-${mailbox.id}`}
              checked={mailbox.greeting_mode === 'custom'}
              disabled={!canEdit || patch.isPending || list.length === 0}
              onChange={() => chooseMode('custom')}
            />
            <span>
              <strong>Custom greeting</strong>
              <span className="dl-help">
                {list.length === 0 ? 'Add a greeting below to use your own.' : 'Plays the greeting marked Active.'}
              </span>
            </span>
          </label>
        </div>

        {greetings.isLoading ? (
          <div className="vm-state-line" role="status">
            <Spinner size="sm" /> Loading greetings…
          </div>
        ) : greetings.isError ? (
          <div className="vm-state-line vm-state-err" role="alert">
            <span>{isUnavailable(greetings.error) ? UNAVAILABLE_TEXT : 'Greetings couldn’t load.'}</span>
            <button type="button" className="vm-linkbtn" onClick={() => void greetings.refetch()}>
              Try again
            </button>
          </div>
        ) : list.length === 0 ? (
          <div className="dl-empty">
            No custom greetings yet.{canEdit ? ' Record one in your browser or upload an audio file.' : ''}
          </div>
        ) : (
          <>
            <ul className="vm-greetings" id={more.listId}>
              {more.visible.map((g) => {
                const active = g.id === activeId;
                return (
                  <li key={g.id} className={`vm-greeting${active ? ' vm-greeting-on' : ''}`}>
                    <div className="vm-greeting-id">
                      <span className="vm-greeting-name">{g.label}</span>
                      <span className="vm-greeting-meta">
                        {formatDurationMs(g.duration_ms)} · Added {formatDate(g.created_at, tz)}
                      </span>
                    </div>
                    <Player key={g.id} compact mint={mintFor(g.id)} durationMs={g.duration_ms} label={`greeting ${g.label}`} />
                    <div className="vm-greeting-actions">
                      {active ? (
                        <span className="dl-pill dl-pill-on">Active</span>
                      ) : (
                        canEdit && (
                          <button
                            type="button"
                            className="dl-btn dl-btn-ghost vm-btn-sm"
                            disabled={patch.isPending}
                            onClick={() => patch.mutate({ greeting_mode: 'custom', active_greeting_id: g.id })}
                          >
                            Use this
                          </button>
                        )
                      )}
                      {canEdit && (
                        <button
                          type="button"
                          className="vm-iconbtn vm-iconbtn-danger"
                          aria-label={`Delete greeting ${g.label}`}
                          title="Delete"
                          onClick={() => {
                            remove.reset();
                            setDeleteTarget(g);
                          }}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {more.needed && <ShowMoreButton {...more.buttonProps} noun="greetings" className="vm-greetings-more" />}
          </>
        )}
      </div>

      {adding && <GreetingDialog mailbox={mailbox} onClose={() => setAdding(false)} />}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete this greeting?"
          danger
          body={
            <p>
              <strong>{deleteTarget.label}</strong> will be erased.
              {deleteTarget.id === activeId ? ' It’s the active greeting, so callers will hear the standard greeting instead.' : ''}
            </p>
          }
          confirmLabel="Delete greeting"
          pending={remove.isPending}
          error={remove.isError ? vmErrorText(remove.error, 'The greeting couldn’t be deleted.') : null}
          onConfirm={() => remove.mutate(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </section>
  );
}
