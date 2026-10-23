/**
 * MessageList — one folder's messages, newest first. Each row is a button
 * (Enter/Space open it; ↑/↓ move between rows). Unread rows carry an azure
 * dot and a heavier caller line. Times are in the mailbox's timezone.
 *
 * Transcription (v1.1): a third line under each row — the snippet for a
 * `done` transcript, "Transcribing…" while the worker owes one, or a short
 * outcome word. Nothing for `disabled`.
 */
import { useCallback, useRef, type KeyboardEvent } from 'react';
import type { VoicemailFolder, VoicemailMessage } from '../../types/voicemail';
import { callerSubtitle, callerTitle, expiryHint, formatDurationMs, formatListWhen } from './format';
import { isTranscriptActive, transcriptStatusOf } from './voicemailData';

export interface MessageListProps {
  messages: readonly VoicemailMessage[];
  folder: VoicemailFolder;
  selectedId: number | null;
  onSelect: (id: number) => void;
  timeZone: string | undefined;
  now: Date;
  /** message id → transcript snippet (useTranscriptSnippets); absent = loading or none. */
  snippets: ReadonlyMap<number, string>;
  /** summary.transcription_available — false means pending jobs are paused. */
  transcriptionAvailable: boolean;
}

/**
 * The row's transcript line, or null for none.
 *
 *   done        snippet · blank placeholder of the same height while it loads
 *   pending /   spinner + "Transcribing…" ("Transcription paused" when the
 *   processing  platform has it off) — nothing in Trash, which isn't transcribed
 *   empty       "No speech detected"
 *   failed      "No transcript"
 *   disabled    nothing
 */
function SnippetLine({
  message,
  folder,
  snippet,
  transcriptionAvailable,
}: {
  message: VoicemailMessage;
  folder: VoicemailFolder;
  snippet: string | undefined;
  transcriptionAvailable: boolean;
}) {
  const status = transcriptStatusOf(message);
  if (status === 'done') {
    return (
      <span className="vm-row-snippet">
        {snippet ? (
          <span className="vm-row-snippet-text">{snippet}</span>
        ) : (
          <span className="vm-row-snippet-text" aria-hidden="true">
            {'\u00a0'}
          </span>
        )}
      </span>
    );
  }
  if (isTranscriptActive(status)) {
    if (folder === 'trash') return null;
    return transcriptionAvailable ? (
      <span className="vm-row-snippet vm-row-snippet-quiet">
        <span className="vm-spin" aria-hidden="true" />
        <span className="vm-row-snippet-text">Transcribing…</span>
      </span>
    ) : (
      <span className="vm-row-snippet vm-row-snippet-quiet">
        <span className="vm-row-snippet-text">Transcription paused</span>
      </span>
    );
  }
  if (status === 'empty' || status === 'failed') {
    return (
      <span className="vm-row-snippet vm-row-snippet-quiet">
        <span className="vm-row-snippet-text">{status === 'empty' ? 'No speech detected' : 'No transcript'}</span>
      </span>
    );
  }
  return null;
}

export function MessageList({
  messages,
  folder,
  selectedId,
  onSelect,
  timeZone,
  now,
  snippets,
  transcriptionAvailable,
}: MessageListProps) {
  const listRef = useRef<HTMLUListElement>(null);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const next = messages[index + (e.key === 'ArrowDown' ? 1 : -1)];
      if (!next) return;
      onSelect(next.id);
      listRef.current?.querySelector<HTMLButtonElement>(`[data-msg="${next.id}"]`)?.focus();
    },
    [messages, onSelect],
  );

  return (
    <ul className="vm-list" ref={listRef} aria-label={`${folder} messages`}>
      {messages.map((m, i) => {
        const selected = m.id === selectedId;
        const unread = !m.is_read && folder !== 'trash';
        const hint = folder === 'trash' ? null : expiryHint(m, now);
        const sub = callerSubtitle(m);
        return (
          <li key={m.id}>
            <button
              type="button"
              data-msg={m.id}
              className={`vm-row${selected ? ' vm-row-on' : ''}${unread ? ' vm-row-unread' : ''}`}
              aria-current={selected ? 'true' : undefined}
              onClick={() => onSelect(m.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              <span className="vm-row-dot" aria-hidden="true" />
              <span className="vm-row-main">
                <span className="vm-row-top">
                  <span className="vm-row-caller">
                    {unread && <span className="vm-sr">Unread: </span>}
                    {callerTitle(m)}
                  </span>
                  <span className="vm-row-when">{formatListWhen(m.created_at, timeZone, now)}</span>
                </span>
                <span className="vm-row-bottom">
                  <span className="vm-row-sub">{sub ?? ''}</span>
                  <span className="vm-row-meta">
                    {hint && <span className="vm-row-expiry">{hint}</span>}
                    <span className="vm-row-dur">{formatDurationMs(m.duration_ms)}</span>
                  </span>
                </span>
                <SnippetLine
                  message={m}
                  folder={folder}
                  snippet={snippets.get(m.id)}
                  transcriptionAvailable={transcriptionAvailable}
                />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
