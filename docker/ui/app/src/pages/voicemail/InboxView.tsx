/**
 * InboxView — one mailbox's messages: folder switch (Inbox / Saved / Trash
 * with counts), the message list and the reading pane — a kit MasterDetail
 * (docker/ui/CLAUDE.md §20): two panes of equal height that end at the
 * bottom of the first screen, each scrolling inside itself (the folder tabs
 * and the message actions stay put); stacked when the column is narrow.
 *
 * All three folders load their first page (≤ 50 rows) up front: that gives
 * the counts and makes switching instant. Mailboxes hold at most 100 stored
 * messages, so this stays small.
 *
 * Moving a message out of the open folder (save, unsave, delete, restore,
 * purge) selects its neighbour. Delete offers Undo in the toast.
 *
 * Transcription (v1.1): the open folder's done transcripts get a snippet line
 * (batched, cached per id — useTranscriptSnippets); folders poll every 10 s
 * while a loaded message is still being transcribed.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import type { Mailbox, VoicemailFolder, VoicemailMessage } from '../../types/voicemail';
import {
  getMessagePlaybackToken,
  purgeMessage,
  restoreMessage,
  trashMessage,
  updateMessage,
} from '../../api/voicemail';
import { useToast } from '../../components/ui/ToastContext';
import { Spinner } from '../../components/ui/Spinner';
import {
  folderItems,
  invalidateVoicemail,
  isUnavailable,
  patchCachedMessage,
  UNAVAILABLE_TEXT,
  useFolderMessages,
  useTranscriptSnippets,
  vmErrorText,
  type VoicemailScope,
} from './voicemailData';
import { MessageList } from './MessageList';
import { ReadingPane, type MessageActionKind, type ReadingPaneProps } from './ReadingPane';
import { ConfirmDialog } from './VmDialog';
import { callerTitle, safeTimeZone } from './format';
import { useNow } from './useNow';
import { MasterDetail, ScrollArea } from '../../components/layout/kit';

const FOLDERS: ReadonlyArray<{ id: VoicemailFolder; label: string; empty: string }> = [
  { id: 'inbox', label: 'Inbox', empty: 'No messages in the inbox. New voicemail shows up here.' },
  { id: 'saved', label: 'Saved', empty: 'Nothing saved. Save a message to keep it out of the inbox.' },
  { id: 'trash', label: 'Trash', empty: 'Trash is empty.' },
];

interface ActionVars {
  kind: MessageActionKind;
  message: VoicemailMessage;
  value?: boolean;
}

export interface InboxViewProps {
  scope: VoicemailScope;
  mailbox: Mailbox;
  canEdit: boolean;
  /** Platform admin (incl. "View as Customer") — owner decision O2. */
  canManage: boolean;
  /** summary.transcription_available. */
  transcriptionAvailable: boolean;
  /** Switches the workspace to "Greeting & settings". */
  onOpenSettings: () => void;
}

export function InboxView({ scope, mailbox, canEdit, canManage, transcriptionAvailable, onOpenSettings }: InboxViewProps) {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const queryClient = useQueryClient();
  const { toast, toastErr } = useToast();
  const now = useNow();
  const [folder, setFolder] = useState<VoicemailFolder>('inbox');
  const [selectedSel, setSelectedSel] = useState<number | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<VoicemailMessage | null>(null);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);

  const inbox = useFolderMessages(scope, mailbox.id, 'inbox', transcriptionAvailable);
  const saved = useFolderMessages(scope, mailbox.id, 'saved', transcriptionAvailable);
  const trash = useFolderMessages(scope, mailbox.id, 'trash', transcriptionAvailable);
  const byFolder = { inbox, saved, trash } as const;
  const current = byFolder[folder];

  const items = useMemo(() => folderItems(current.data), [current.data]);
  const snippets = useTranscriptSnippets(scope, mailbox.id, items);
  const selected = items.find((m) => m.id === selectedSel) ?? items[0] ?? null;
  const timeZone = safeTimeZone(mailbox.timezone);

  /** The row to select after `message` leaves the open folder. */
  const neighbourOf = useCallback(
    (message: VoicemailMessage): number | null => {
      const i = items.findIndex((m) => m.id === message.id);
      if (i < 0) return selectedSel;
      return (items[i + 1] ?? items[i - 1])?.id ?? null;
    },
    [items, selectedSel],
  );

  const restore = useMutation({
    mutationFn: (message: VoicemailMessage) => restoreMessage(message.id),
    onSuccess: () => toast({ message: 'Message restored.', variant: 'success' }),
    onError: (err) => toastErr(vmErrorText(err, 'The message couldn’t be restored.')),
    onSettled: () => invalidateVoicemail(queryClient),
  });

  const action = useMutation({
    mutationFn: async ({ kind, message, value }: ActionVars): Promise<void> => {
      switch (kind) {
        case 'read':
          await updateMessage(message.id, { is_read: Boolean(value) });
          return;
        case 'save':
          await updateMessage(message.id, { is_saved: Boolean(value) });
          return;
        case 'trash':
          await trashMessage(message.id);
          return;
        case 'restore':
          await restoreMessage(message.id);
          return;
        case 'purge':
          await purgeMessage(message.id);
          return;
      }
    },
    onMutate: ({ kind, message, value }) => {
      if (kind === 'read') patchCachedMessage(queryClient, scope, mailbox.id, message.id, { is_read: Boolean(value) });
    },
    onSuccess: (_data, { kind, message, value }) => {
      const leaves =
        kind === 'trash' ||
        kind === 'restore' ||
        kind === 'purge' ||
        (kind === 'save' && ((folder === 'inbox' && value) || (folder === 'saved' && !value)));
      if (leaves) setSelectedSel(neighbourOf(message));
      if (kind === 'trash') {
        toast({
          message: 'Moved to Trash.',
          variant: 'info',
          duration: 8000, // long enough to reach Undo
          action: { label: 'Undo', onClick: () => restore.mutate(message) },
        });
      } else if (kind === 'purge') {
        setPurgeTarget(null);
        toast({ message: 'Message deleted permanently.', variant: 'success' });
      } else if (kind === 'save' && value) {
        toast({ message: 'Saved.', variant: 'success' });
      }
    },
    onError: (err, { kind }) => {
      if (kind === 'purge') return; // shown inside the confirm dialog
      toastErr(vmErrorText(err, 'That change didn’t go through. Try again.'));
    },
    onSettled: () => invalidateVoicemail(queryClient),
  });

  const onAction = useCallback(
    (kind: MessageActionKind, value?: boolean) => {
      if (!selected) return;
      if (kind === 'purge') {
        action.reset();
        setPurgeTarget(selected);
        return;
      }
      action.mutate({ kind, message: selected, value });
    },
    [action, selected],
  );

  const onPlaybackMinted = useCallback(() => {
    if (!selected) return;
    // The token mint marked it read server-side; reflect that now, refresh counts.
    patchCachedMessage(queryClient, scope, mailbox.id, selected.id, { is_read: true });
    invalidateVoicemail(queryClient);
  }, [queryClient, scope, mailbox.id, selected]);

  const onDownload = useCallback(async () => {
    if (!selected) return;
    setDownloadingId(selected.id);
    try {
      const token = await getMessagePlaybackToken(selected.id, true);
      // Same-origin URL whose response is `Content-Disposition: attachment`,
      // so the browser saves it with the server's filename and stays here.
      const a = document.createElement('a');
      a.href = token.url;
      a.download = '';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      onPlaybackMinted();
    } catch (err) {
      toastErr(vmErrorText(err, 'The download couldn’t start. Try again.'));
    } finally {
      setDownloadingId(null);
    }
  }, [selected, onPlaybackMinted, toastErr]);

  // ── Derived (after all hooks) ──
  const pendingKind: ReadingPaneProps['pending'] =
    selected && downloadingId === selected.id
      ? 'download'
      : action.isPending && action.variables?.message.id === selected?.id
        ? action.variables.kind
        : null;
  const counts: Record<VoicemailFolder, number | null> = {
    inbox: inbox.data?.pages[0]?.total ?? null,
    saved: saved.data?.pages[0]?.total ?? null,
    trash: trash.data?.pages[0]?.total ?? null,
  };
  const inboxUnread = inbox.data?.pages[0]?.unread ?? 0;
  const folderMeta = FOLDERS.find((f) => f.id === folder) ?? FOLDERS[0];

  let listBody: ReactNode;
  if (current.isLoading) {
    listBody = (
      <div className="vm-state-line" role="status">
        <Spinner size="sm" /> Loading messages…
      </div>
    );
  } else if (current.isError && items.length === 0) {
    listBody = (
      <div className="vm-state-line vm-state-err" role="alert">
        <span>{isUnavailable(current.error) ? UNAVAILABLE_TEXT : 'Messages couldn’t load.'}</span>
        <button type="button" className="vm-linkbtn" onClick={() => void current.refetch()}>
          Try again
        </button>
      </div>
    );
  } else if (items.length === 0) {
    listBody = <div className="dl-empty vm-list-empty">{folderMeta.empty}</div>;
  } else {
    listBody = (
      <>
        <MessageList
          messages={items}
          folder={folder}
          selectedId={selected?.id ?? null}
          onSelect={setSelectedSel}
          timeZone={timeZone}
          now={now}
          snippets={snippets}
          transcriptionAvailable={transcriptionAvailable}
        />
        {current.hasNextPage && (
          <div className="vm-more">
            <button
              type="button"
              className="dl-btn dl-btn-ghost vm-btn-sm"
              onClick={() => void current.fetchNextPage()}
              disabled={current.isFetchingNextPage}
            >
              {current.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </>
    );
  }

  const folderTabs = (
    <div className="vm-folders" role="tablist" aria-label="Folders">
      {FOLDERS.map((f) => {
        const active = f.id === folder;
        return (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={`vm-folder${active ? ' vm-folder-on' : ''}`}
            onClick={() => {
              setFolder(f.id);
              setSelectedSel(null);
            }}
          >
            {f.label}
            {counts[f.id] !== null && <span className="vm-folder-count">{counts[f.id]}</span>}
            {f.id === 'inbox' && inboxUnread > 0 && (
              <span className="vm-folder-new" aria-label={`${inboxUnread} unread`}>
                {inboxUnread} new
              </span>
            )}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="vm-inbox">
      <MasterDetail
        className="vm-md"
        listLabel="Messages"
        detailLabel="Message"
        listWidth="minmax(280px, 340px)"
        listClassName="dl-panel vm-listpanel"
        detailClassName="dl-panel vm-pane"
        list={
          <>
            {folderTabs}
            {folder === 'trash' && items.length > 0 && (
              <p className="vm-folder-note">Messages in Trash are deleted for good after 30 days.</p>
            )}
            <ScrollArea className="vm-listbody">{listBody}</ScrollArea>
          </>
        }
        detail={
          selected ? (
            <ReadingPane
              key={selected.id}
              scope={scope}
              message={selected}
              mailbox={mailbox}
              folder={folder}
              timeZone={timeZone}
              canEdit={canEdit}
              canManage={canManage}
              transcriptionAvailable={transcriptionAvailable}
              onOpenSettings={onOpenSettings}
              pending={pendingKind}
              onAction={onAction}
              onDownload={() => void onDownload()}
              onPlaybackMinted={onPlaybackMinted}
            />
          ) : (
            <div className="vm-pane-empty">
              <span className="vm-pane-empty-icon" aria-hidden="true">
                <Inbox size={22} strokeWidth={1.8} />
              </span>
              <p>{current.isLoading ? 'Loading…' : items.length === 0 ? 'Nothing to play here yet.' : 'Pick a message to play it.'}</p>
            </div>
          )
        }
      />

      {purgeTarget && (
        <ConfirmDialog
          title="Delete this message forever?"
          danger
          body={
            <p>
              The voicemail from <strong>{callerTitle(purgeTarget)}</strong> will be erased, including its encrypted
              recording. This can’t be undone.
            </p>
          }
          confirmLabel="Delete forever"
          pending={action.isPending && action.variables?.kind === 'purge'}
          error={action.isError && action.variables?.kind === 'purge' ? vmErrorText(action.error, 'The message couldn’t be deleted.') : null}
          onConfirm={() => action.mutate({ kind: 'purge', message: purgeTarget })}
          onCancel={() => setPurgeTarget(null)}
        />
      )}
    </div>
  );
}

