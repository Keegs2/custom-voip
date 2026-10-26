/**
 * PromptManager — the "Messages" panel of /ivr: every recording and
 * text-to-speech message the account's flows can play. Play (a short-lived
 * signed URL, minted on first Play), rename, delete — a message still used
 * by a flow's draft answers 409 `prompt_in_use` and the dialog names the
 * flows. New messages come from PromptDialog.
 *
 * Layout (docker/ui/CLAUDE.md §20): one compact row per message — name, kind,
 * length, date and the spoken text on one clamped line; the player and the
 * actions on the right — the first 4, then "Show all N messages".
 */
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileAudio, Mic, PencilLine, Plus, Trash2, Type } from 'lucide-react';
import { deletePrompt, getPromptPlaybackUrl, renamePrompt } from '../../../api/ivr';
import type { Prompt, PromptKind } from '../../../types/ivr';
import { useToast } from '../../../components/ui/ToastContext';
import { Spinner } from '../../../components/ui/Spinner';
import { ShowMoreButton, useShowMore } from '../../../components/layout/kit';
import { Player } from '../../voicemail/Player';
import { ConfirmDialog } from '../../voicemail/VmDialog';
import { NameDialog } from '../IvrDialogs';
import { useIvrWorkspace } from '../IvrContext';
import { KIND_WORDS, formatLength, formatWhen } from '../format';
import { invalidateIvr, ivrErrorText, usePrompts, useVoices } from '../ivrData';
import { PromptDialog } from './PromptDialog';

export function KindIcon({ kind, size = 14 }: { kind: PromptKind; size?: number }) {
  if (kind === 'tts') return <Type size={size} aria-hidden="true" />;
  if (kind === 'recording') return <Mic size={size} aria-hidden="true" />;
  return <FileAudio size={size} aria-hidden="true" />;
}

/** Messages shown before "Show all N messages" (§20.3: short lists 4–6). */
const MESSAGES_LIMIT = 4;

type Dialog = { kind: 'none' } | { kind: 'new' } | { kind: 'rename'; prompt: Prompt } | { kind: 'delete'; prompt: Prompt };

export function PromptManager() {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const ws = useIvrWorkspace();
  const queryClient = useQueryClient();
  const { toastOk } = useToast();
  const prompts = usePrompts(ws.scope);
  const voices = useVoices(ws.scope);
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' });
  const close = () => setDialog({ kind: 'none' });
  const list = useMemo(() => [...(prompts.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [prompts.data]);
  const more = useShowMore(list, MESSAGES_LIMIT);

  const rename = useMutation({
    mutationFn: ({ prompt, name }: { prompt: Prompt; name: string }) => renamePrompt(prompt.id, name, ws.scope.customerId),
    onSuccess: () => {
      void invalidateIvr(queryClient, ws.scope);
      close();
      toastOk('Message renamed.');
    },
  });
  const remove = useMutation({
    mutationFn: (prompt: Prompt) => deletePrompt(prompt.id, ws.scope.customerId),
    onSuccess: (_v, prompt) => {
      void invalidateIvr(queryClient, ws.scope);
      close();
      toastOk(`Deleted “${prompt.name}”.`);
    },
  });

  // ── Derived (after all hooks) ──
  const voiceLabel = (id: string | null | undefined) => voices.data?.find((v) => v.id === id)?.label ?? null;

  return (
    <section className="dl-panel ivr-panel ivr-messages" aria-labelledby="ivr-messages-title">
      <div className="ivr-panel-head">
        <div>
          <h2 id="ivr-messages-title" className="ivr-panel-title">
            Messages
            {list.length > 0 && <span className="ivr-title-count">{list.length}</span>}
          </h2>
          <p className="ivr-panel-sub">Recordings and text read aloud. Use them in Play message, Menu and Hang up blocks.</p>
        </div>
        {ws.canEdit && (
          <button type="button" className="dl-btn dl-btn-ghost vm-btn-sm" onClick={() => setDialog({ kind: 'new' })}>
            <Plus size={14} aria-hidden="true" /> New message
          </button>
        )}
      </div>

      {prompts.isLoading ? (
        <div className="ivr-state" role="status">
          <Spinner /> Loading messages…
        </div>
      ) : prompts.isError ? (
        <div className="dl-banner dl-banner-err ivr-gap" role="alert">
          {ivrErrorText(prompts.error, 'Messages couldn’t be loaded.')}{' '}
          <button type="button" className="vm-linkbtn" onClick={() => void prompts.refetch()}>
            Try again
          </button>
        </div>
      ) : list.length === 0 ? (
        <div className="ivr-empty">
          <span className="ivr-empty-icon" aria-hidden="true">
            <Mic size={20} strokeWidth={1.8} />
          </span>
          <div>
            <p className="ivr-empty-title">No messages yet</p>
            <p className="ivr-empty-copy">
              {ws.canEdit
                ? 'Type what callers should hear and have it read aloud, or record your own voice.'
                : 'Nobody has added a message on this account yet.'}
            </p>
          </div>
        </div>
      ) : (
        <ul className="ivr-prompts" id={more.listId}>
          {more.visible.map((p) => (
            <li key={p.id} className="ivr-prompt">
              <div className="ivr-prompt-id">
                <span className="ivr-prompt-name">{p.name}</span>
                <span className="ivr-prompt-meta">
                  <span className={`ivr-kind ivr-kind-${p.kind}`}>
                    <KindIcon kind={p.kind} size={12} /> {KIND_WORDS[p.kind]}
                    {p.kind === 'tts' && voiceLabel(p.tts_voice) ? ` · ${voiceLabel(p.tts_voice)}` : ''}
                  </span>
                  <span>{formatLength(p.duration_ms)}</span>
                  <span>Added {formatWhen(p.created_at)}</span>
                </span>
                {p.kind === 'tts' && p.tts_text && (
                  <span className="ivr-prompt-text" title={p.tts_text}>
                    “{p.tts_text}”
                  </span>
                )}
              </div>
              <Player
                mint={() => getPromptPlaybackUrl(p.id, ws.scope.customerId).then((r) => ({ url: r.url, expires_in: 120 }))}
                durationMs={p.duration_ms}
                label={p.name}
                compact
              />
              {ws.canEdit && (
                <div className="ivr-prompt-actions">
                  <button
                    type="button"
                    className="vm-iconbtn"
                    aria-label={`Rename ${p.name}`}
                    title="Rename"
                    onClick={() => setDialog({ kind: 'rename', prompt: p })}
                  >
                    <PencilLine size={15} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="vm-iconbtn vm-iconbtn-danger"
                    aria-label={`Delete ${p.name}`}
                    title="Delete"
                    onClick={() => setDialog({ kind: 'delete', prompt: p })}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {more.needed && <ShowMoreButton {...more.buttonProps} noun="messages" variant="bar" />}

      {dialog.kind === 'new' && <PromptDialog onClose={close} />}
      {dialog.kind === 'rename' && (
        <NameDialog
          title="Rename message"
          label="Name"
          initial={dialog.prompt.name}
          confirmLabel="Rename"
          pendingLabel="Saving…"
          pending={rename.isPending}
          error={rename.error ? ivrErrorText(rename.error, 'The message couldn’t be renamed. Try again.') : null}
          onSubmit={(name) => rename.mutate({ prompt: dialog.prompt, name })}
          onClose={() => {
            rename.reset();
            close();
          }}
        />
      )}
      {dialog.kind === 'delete' && (
        <ConfirmDialog
          title={`Delete “${dialog.prompt.name}”?`}
          body={
            <p>
              Flows can’t use it any more. Versions already published keep playing it until you publish a change.
            </p>
          }
          confirmLabel="Delete message"
          danger
          pending={remove.isPending}
          error={remove.error ? ivrErrorText(remove.error, 'The message couldn’t be deleted. Try again.') : null}
          onConfirm={() => remove.mutate(dialog.prompt)}
          onCancel={() => {
            remove.reset();
            close();
          }}
        />
      )}
    </section>
  );
}
