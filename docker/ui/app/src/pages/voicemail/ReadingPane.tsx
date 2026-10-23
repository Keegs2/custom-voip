/**
 * ReadingPane — the open message: who called, when (mailbox timezone), the
 * player, and the actions for its folder. Mutation controls render only when
 * the viewer can edit (readonly tenants get play + download).
 *
 *   inbox / saved:  Mark read|unread · Save|Move to Inbox · Download · Delete
 *   trash:          Restore · Download · Delete forever
 */
import { useCallback } from 'react';
import { ArchiveRestore, Bookmark, BookmarkMinus, Download, Lock, Mail, MailOpen, Trash2 } from 'lucide-react';
import type { Mailbox, VoicemailFolder, VoicemailMessage } from '../../types/voicemail';
import { getMessagePlaybackToken } from '../../api/voicemail';
import { Player } from './Player';
import { callerSubtitle, callerTitle, formatDate, formatDurationMs, formatFullWhen, formatPhone } from './format';

export type MessageActionKind = 'read' | 'save' | 'trash' | 'restore' | 'purge';

export interface ReadingPaneProps {
  message: VoicemailMessage;
  mailbox: Mailbox;
  folder: VoicemailFolder;
  timeZone: string | undefined;
  canEdit: boolean;
  /** The action in flight for this message, if any. */
  pending: MessageActionKind | 'download' | null;
  onAction: (kind: MessageActionKind, value?: boolean) => void;
  onDownload: () => void;
  onPlaybackMinted: () => void;
}

/** Days Trash keeps a message before the retention worker purges it (contract §4.7). */
const TRASH_DAYS = 30;

export function ReadingPane({
  message,
  mailbox,
  folder,
  timeZone,
  canEdit,
  pending,
  onAction,
  onDownload,
  onPlaybackMinted,
}: ReadingPaneProps) {
  const mint = useCallback(() => getMessagePlaybackToken(message.id), [message.id]);
  const title = callerTitle(message);
  const sub = callerSubtitle(message);
  const busy = pending !== null;
  const inTrash = folder === 'trash';

  return (
    <article className="vm-pane-body" aria-labelledby={`vm-msg-${message.id}`}>
      <header className="vm-msg-head">
        <div className="vm-msg-id">
          <h2 id={`vm-msg-${message.id}`} className="vm-msg-title">
            {title}
          </h2>
          {sub && <p className="vm-msg-number">{sub}</p>}
        </div>
        <span className={`vm-state ${message.is_read ? 'vm-state-read' : 'vm-state-new'}`}>
          {inTrash ? 'In Trash' : message.is_read ? (message.is_saved ? 'Saved' : 'Played') : 'New'}
        </span>
      </header>

      <dl className="vm-facts">
        <div>
          <dt>Received</dt>
          <dd>{formatFullWhen(message.created_at, timeZone)}</dd>
        </div>
        <div>
          <dt>Length</dt>
          <dd>{formatDurationMs(message.duration_ms)}</dd>
        </div>
        <div className="vm-fact-wide">
          <dt>Mailbox</dt>
          <dd>
            {mailbox.label} · <span className="vm-nowrap">{formatPhone(mailbox.did)}</span>
          </dd>
        </div>
      </dl>

      <Player
        key={message.id}
        mint={mint}
        durationMs={message.duration_ms}
        label={`message from ${title}`}
        onMinted={onPlaybackMinted}
      />

      <div className="vm-actions" role="group" aria-label="Message actions">
        {canEdit && !inTrash && (
          <>
            <button
              type="button"
              className="dl-btn dl-btn-ghost vm-btn-sm"
              disabled={busy}
              onClick={() => onAction('read', !message.is_read)}
            >
              {message.is_read ? <Mail size={14} aria-hidden="true" /> : <MailOpen size={14} aria-hidden="true" />}
              {message.is_read ? 'Mark unread' : 'Mark read'}
            </button>
            <button
              type="button"
              className="dl-btn dl-btn-ghost vm-btn-sm"
              disabled={busy}
              onClick={() => onAction('save', !message.is_saved)}
            >
              {message.is_saved ? <BookmarkMinus size={14} aria-hidden="true" /> : <Bookmark size={14} aria-hidden="true" />}
              {message.is_saved ? 'Move to Inbox' : 'Save'}
            </button>
          </>
        )}
        {canEdit && inTrash && (
          <button type="button" className="dl-btn dl-btn-ghost vm-btn-sm" disabled={busy} onClick={() => onAction('restore')}>
            <ArchiveRestore size={14} aria-hidden="true" />
            Restore
          </button>
        )}
        <button type="button" className="dl-btn dl-btn-ghost vm-btn-sm" disabled={busy} onClick={onDownload}>
          {pending === 'download' ? <span className="vm-spin" aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
          Download
        </button>
        {canEdit && (
          <button
            type="button"
            className="dl-btn dl-btn-danger vm-btn-sm vm-actions-end"
            disabled={busy}
            onClick={() => onAction(inTrash ? 'purge' : 'trash')}
          >
            <Trash2 size={14} aria-hidden="true" />
            {inTrash ? 'Delete forever' : 'Delete'}
          </button>
        )}
      </div>

      <p className="vm-retention">
        <Lock size={12} strokeWidth={2.4} aria-hidden="true" />
        {inTrash ? (
          <span>
            In Trash{message.deleted_at ? ` since ${formatDate(message.deleted_at, timeZone)}` : ''}. Trash is
            emptied automatically after {TRASH_DAYS} days.
          </span>
        ) : (
          <span>
            Encrypted at rest. Kept until {formatDate(message.expires_at, timeZone)} — messages are deleted
            automatically after {mailbox.retention_days} days.
          </span>
        )}
      </p>
    </article>
  );
}
