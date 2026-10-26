/**
 * ReadingPane — the open message: who called, ONE inline meta row (received
 * in the mailbox timezone · length · mailbox), the player, its transcript
 * (v1.1, TranscriptPanel — first lines, "Show full transcript") and, pinned
 * under the scrolling body, the actions for its folder (always visible in
 * the bounded MasterDetail pane). Mutation controls render only when the viewer can edit (readonly
 * tenants get play + download).
 *
 *   inbox / saved:  Mark read|unread · Save|Move to Inbox · Download · Delete
 *   trash:          Restore · Download · Delete forever
 */
import { useCallback } from 'react';
import { ArchiveRestore, Bookmark, BookmarkMinus, Download, Lock, Mail, MailOpen, Trash2 } from 'lucide-react';
import type { Mailbox, VoicemailFolder, VoicemailMessage } from '../../types/voicemail';
import { getMessagePlaybackToken } from '../../api/voicemail';
import { Player } from './Player';
import { TranscriptPanel } from './TranscriptPanel';
import type { VoicemailScope } from './voicemailData';
import { callerSubtitle, callerTitle, formatDate, formatDurationMs, formatFullWhen, formatMetaWhen, formatPhone } from './format';
import { ScrollArea } from '../../components/layout/kit';

export type MessageActionKind = 'read' | 'save' | 'trash' | 'restore' | 'purge';

export interface ReadingPaneProps {
  scope: VoicemailScope;
  message: VoicemailMessage;
  mailbox: Mailbox;
  folder: VoicemailFolder;
  timeZone: string | undefined;
  canEdit: boolean;
  /** Platform admin (incl. "View as Customer") — transcription switch, owner decision O2. */
  canManage: boolean;
  /** summary.transcription_available. */
  transcriptionAvailable: boolean;
  /** Switches the workspace to "Greeting & settings". */
  onOpenSettings: () => void;
  /** The action in flight for this message, if any. */
  pending: MessageActionKind | 'download' | null;
  onAction: (kind: MessageActionKind, value?: boolean) => void;
  onDownload: () => void;
  onPlaybackMinted: () => void;
}

/** Days Trash keeps a message before the retention worker purges it (contract §4.7). */
const TRASH_DAYS = 30;

export function ReadingPane({
  scope,
  message,
  mailbox,
  folder,
  timeZone,
  canEdit,
  canManage,
  transcriptionAvailable,
  onOpenSettings,
  pending,
  onAction,
  onDownload,
  onPlaybackMinted,
}: ReadingPaneProps) {
  const mint = useCallback(() => getMessagePlaybackToken(message.id), [message.id]);
  const markRead = useCallback(() => onAction('read', true), [onAction]);
  const title = callerTitle(message);
  const sub = callerSubtitle(message);
  const busy = pending !== null;
  const inTrash = folder === 'trash';

  return (
    <article className="vm-read" aria-labelledby={`vm-msg-${message.id}`}>
      <ScrollArea className="vm-read-scroll">
        <div className="vm-pane-body">
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

          {/* Clip box: a separator that starts a wrapped line is cut off. */}
          <div className="vm-meta-clip">
            <dl className="vm-meta">
              <div title={formatFullWhen(message.created_at, timeZone)}>
                <dt>Received</dt>
                <dd>{formatMetaWhen(message.created_at, timeZone)}</dd>
              </div>
              <div>
                <dt>Length</dt>
                <dd>{formatDurationMs(message.duration_ms)}</dd>
              </div>
              <div>
                <dt>Mailbox</dt>
                <dd>
                  {mailbox.label} · <span className="vm-nowrap">{formatPhone(mailbox.did)}</span>
                </dd>
              </div>
            </dl>
          </div>

          <Player
            key={message.id}
            mint={mint}
            durationMs={message.duration_ms}
            label={`message from ${title}`}
            onMinted={onPlaybackMinted}
          />

          <TranscriptPanel
            scope={scope}
            message={message}
            mailbox={mailbox}
            folder={folder}
            canEdit={canEdit}
            canManage={canManage}
            transcriptionAvailable={transcriptionAvailable}
            onMarkRead={markRead}
            onOpenSettings={onOpenSettings}
          />
        </div>
      </ScrollArea>

      <footer className="vm-read-foot">
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
      </footer>
    </article>
  );
}
