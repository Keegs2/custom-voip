/**
 * PromptListField — the ordered messages a Play message, Menu or Hang up
 * block plays. Pick existing messages (each can be played right here), put
 * them in order, or make a new one inline (PromptDialog) — it is added to
 * the block as soon as it's saved. Order is the order callers hear.
 */
import { useId, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { getPromptPlaybackUrl } from '../../api/ivr';
import type { Prompt, PromptId } from '../../types/ivr';
import { Select, type SelectOption } from '../../components/ui/Select';
import { Player } from '../../pages/voicemail/Player';
import { PromptDialog } from '../../pages/ivr/prompts/PromptDialog';
import { useIvrWorkspace } from '../../pages/ivr/IvrContext';
import { formatLength } from '../../pages/ivr/format';
import { LIMITS } from '../model/blocks';

const NEW = '__new__';

export interface PromptListFieldProps {
  label: string;
  help?: string;
  value: readonly PromptId[];
  prompts: readonly Prompt[] | undefined;
  onChange: (next: PromptId[]) => void;
  /** Block title, for the new-message dialog's subtitle. */
  forWhat: string;
  readOnly: boolean;
  /** "Add a message" wording when the list is empty. */
  emptyText?: string;
}

export function PromptListField({ label, help, value, prompts, onChange, forWhat, readOnly, emptyText }: PromptListFieldProps) {
  // ── Hooks first (React #310) ──
  const ws = useIvrWorkspace();
  const [creating, setCreating] = useState(false);
  const id = useId();

  const addOptions = useMemo<SelectOption[]>(
    () => [
      { value: NEW, label: '＋ New message (type, record or upload)' },
      ...(prompts ?? [])
        .filter((p) => !value.includes(p.id))
        .map((p) => ({ value: String(p.id), label: p.name, hint: formatLength(p.duration_ms), group: 'Your messages' })),
    ],
    [prompts, value],
  );

  const byId = new Map((prompts ?? []).map((p) => [p.id, p]));
  const full = value.length >= LIMITS.promptsPerBlock;

  const move = (index: number, delta: number) => {
    const next = [...value];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    onChange(next);
  };

  return (
    <div className="ivr-field">
      <span className="ivr-label" id={`${id}-label`}>
        {label}
      </span>
      {value.length === 0 ? (
        <p className="ivr-field-empty">{emptyText ?? 'No message yet.'}</p>
      ) : (
        <ol className="ivr-plist" aria-labelledby={`${id}-label`}>
          {value.map((pid, i) => {
            const p = byId.get(pid);
            return (
              <li key={`${pid}-${i}`} className={`ivr-pitem${p ? '' : ' ivr-pitem-missing'}`}>
                {p ? (
                  <Player
                    mint={() => getPromptPlaybackUrl(p.id, ws.scope.customerId).then((r) => ({ url: r.url, expires_in: 120 }))}
                    durationMs={p.duration_ms}
                    label={p.name}
                    compact
                  />
                ) : (
                  <span className="ivr-pitem-gap" aria-hidden="true" />
                )}
                <span className="ivr-pitem-name">
                  {p ? p.name : prompts ? 'A deleted message' : 'Loading…'}
                  {p && <span className="ivr-pitem-len">{formatLength(p.duration_ms)}</span>}
                </span>
                {!readOnly && (
                  <span className="ivr-pitem-tools">
                    <button
                      type="button"
                      className="ivr-mini-btn"
                      onClick={() => move(i, -1)}
                      disabled={i === 0}
                      aria-label={`Play ${p?.name ?? 'this message'} earlier`}
                      title="Earlier"
                    >
                      <ArrowUp size={13} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="ivr-mini-btn"
                      onClick={() => move(i, 1)}
                      disabled={i === value.length - 1}
                      aria-label={`Play ${p?.name ?? 'this message'} later`}
                      title="Later"
                    >
                      <ArrowDown size={13} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="ivr-mini-btn ivr-mini-btn-danger"
                      onClick={() => onChange(value.filter((_, j) => j !== i))}
                      aria-label={`Remove ${p?.name ?? 'this message'}`}
                      title="Remove"
                    >
                      <X size={13} aria-hidden="true" />
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {!readOnly && (
        // An ACTION menu: value stays '' (the placeholder shows), so every pick
        // fires — it adds the message (or opens the new-message dialog) and the
        // trigger reads "Add another message…" again. `nokey`: React Flow
        // ignores Delete / Backspace while it has focus.
        <Select
          className="dl-input ivr-add-select nokey"
          aria-label={`Add a message to ${label.toLowerCase()}`}
          value=""
          placeholder={full ? 'Up to 10 messages' : value.length ? 'Add another message…' : 'Add a message…'}
          disabled={full}
          onChange={(v) => {
            if (v === NEW) setCreating(true);
            else if (v) onChange([...value, Number(v)]);
          }}
          options={addOptions}
          searchPlaceholder="Search messages…"
        />
      )}
      {help && <p className="dl-help">{help}</p>}
      {creating && (
        <PromptDialog forWhat={forWhat} onClose={() => setCreating(false)} onCreated={(p) => onChange([...value, p.id])} />
      )}
    </div>
  );
}
