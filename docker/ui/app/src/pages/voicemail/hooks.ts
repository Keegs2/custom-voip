/**
 * Data layer for the Visual Voicemail inbox.
 *
 * Owns every `useQuery`/`useMutation`, the derived folder/selection pipeline, and
 * the ready-to-wire action callbacks (read / save / delete / restore / purge) so
 * the page component stays pure composition + top-level state.
 *
 * React #310 discipline: every hook is called unconditionally at the top; queries
 * that depend on a nullable id use `enabled:` rather than a conditional call.
 */

import { useCallback, useMemo } from 'react';
import {
  useQuery,
  useMutation,
  useQueryClient,
  keepPreviousData,
} from '@tanstack/react-query';
import { useSoftphone } from '../../contexts/SoftphoneContext';
import { useToast } from '../../components/ui/Toast';
import {
  listMailboxes,
  getMailboxMessageCount,
  listMailboxMessages,
  getMessage,
  markMessageRead,
  markMessageSaved,
  deleteMessage,
  restoreMessage,
  purgeMessage,
} from '../../api/voicemail';
import type { VoicemailMailbox, VoicemailMessage } from '../../types/voicemail';
import { FOLDER_QUERY, type Folder } from './types';

export interface UseVoicemailArgs {
  customerId: number | undefined;
  folder: Folder;
  search: string;
  /** The user's explicit mailbox pick (null ⇒ fall back to the first mailbox). */
  mailboxSel: number | null;
  /** The user's explicit message pick (null ⇒ fall back to the first row). */
  selectedSel: number | null;
  /** Lets mutations clear the selection after delete/restore/purge. */
  setSelectedId: (id: number | null) => void;
}

export interface VoicemailActions {
  onPlay: () => void;
  onCallBack: () => void;
  onToggleSave: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onPurge: () => void;
}

export interface UseVoicemailResult {
  mailboxes: VoicemailMailbox[];
  mailboxId: number | null;
  selectedMailbox: VoicemailMailbox | null;
  mailboxesLoading: boolean;
  folderCounts: Record<Folder, number | undefined>;
  visibleMessages: VoicemailMessage[];
  messagesLoading: boolean;
  selectedId: number | null;
  selectedMessage: VoicemailMessage | null;
  detail: VoicemailMessage | undefined;
  detailLoading: boolean;
  canCallBack: boolean;
  actions: VoicemailActions;
  pending: { deleting: boolean; restoring: boolean; purging: boolean };
  invalidateMailboxes: () => void;
}

export function useVoicemailData({
  customerId,
  folder,
  search,
  mailboxSel,
  selectedSel,
  setSelectedId,
}: UseVoicemailArgs): UseVoicemailResult {
  // ── contexts ───────────────────────────────────────────────────────────────
  const { refreshVoicemailCount, makeCall, connectionState } = useSoftphone();
  const { toastOk, toastErr } = useToast();
  const queryClient = useQueryClient();

  // ── mailboxes ──────────────────────────────────────────────────────────────
  const mailboxesQuery = useQuery({
    queryKey: ['voicemail', 'mailboxes', { customerId }],
    queryFn: () => listMailboxes({ customer_id: customerId }),
    staleTime: 30_000,
  });
  const mailboxes = useMemo(() => mailboxesQuery.data ?? [], [mailboxesQuery.data]);

  // Effective mailbox: the user's pick if still valid, else the first mailbox.
  // Derived during render (never setState-in-effect) so a customer switch or a
  // deleted mailbox transparently falls back to a sensible default.
  const mailboxId =
    mailboxSel !== null && mailboxes.some((m) => m.id === mailboxSel)
      ? mailboxSel
      : mailboxes[0]?.id ?? null;

  const countQuery = useQuery({
    queryKey: ['voicemail', 'count', mailboxId],
    queryFn: () => getMailboxMessageCount(mailboxId as number),
    enabled: mailboxId !== null,
  });

  // One query per folder — the server does the filtering (folder param). The
  // folder is part of the key so each folder caches independently and switching
  // is instant after the first fetch.
  const messagesQuery = useQuery({
    queryKey: ['voicemail', 'messages', mailboxId, folder],
    queryFn: () => listMailboxMessages(mailboxId as number, { ...FOLDER_QUERY[folder], limit: 200 }),
    enabled: mailboxId !== null,
    placeholderData: keepPreviousData,
  });

  const folderMessages = useMemo(() => messagesQuery.data ?? [], [messagesQuery.data]);

  const visibleMessages = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return folderMessages;
    return folderMessages.filter(
      (m) =>
        (m.caller_id ?? '').toLowerCase().includes(q) ||
        (m.caller_name ?? '').toLowerCase().includes(q),
    );
  }, [folderMessages, search]);

  // Effective selection: the user's pick if still in view, else the first row.
  const selectedId =
    selectedSel !== null && visibleMessages.some((m) => m.id === selectedSel)
      ? selectedSel
      : visibleMessages[0]?.id ?? null;

  const detailQuery = useQuery({
    queryKey: ['voicemail', 'message', selectedId],
    queryFn: () => getMessage(selectedId as number),
    enabled: selectedId !== null,
    staleTime: 0,
  });

  // ── mutations ──────────────────────────────────────────────────────────────
  const invalidateMessages = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['voicemail', 'messages', mailboxId] });
    void queryClient.invalidateQueries({ queryKey: ['voicemail', 'count', mailboxId] });
    refreshVoicemailCount();
  }, [queryClient, mailboxId, refreshVoicemailCount]);

  const readMutation = useMutation({
    mutationFn: (id: number) => markMessageRead(id, true),
    onSuccess: invalidateMessages,
  });

  const saveMutation = useMutation({
    mutationFn: ({ id, saved }: { id: number; saved: boolean }) => markMessageSaved(id, saved),
    onSuccess: (_, { saved }) => {
      invalidateMessages();
      toastOk(saved ? 'Saved' : 'Removed from Saved');
    },
    onError: (e: Error) => toastErr(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteMessage(id),
    onSuccess: () => {
      invalidateMessages();
      toastOk('Message moved to Trash');
      setSelectedId(null);
    },
    onError: (e: Error) => toastErr(e.message),
  });

  const restoreMutation = useMutation({
    mutationFn: (id: number) => restoreMessage(id),
    onSuccess: () => {
      invalidateMessages();
      toastOk('Message restored');
      setSelectedId(null);
    },
    onError: (e: Error) => toastErr(e.message),
  });

  const purgeMutation = useMutation({
    mutationFn: (id: number) => purgeMessage(id),
    onSuccess: () => {
      invalidateMessages();
      toastOk('Message deleted permanently');
      setSelectedId(null);
    },
    onError: (e: Error) => toastErr(e.message),
  });

  // ── derived selection objects ──────────────────────────────────────────────
  const selectedMailbox = mailboxes.find((m) => m.id === mailboxId) ?? null;
  const selectedMessage = visibleMessages.find((m) => m.id === selectedId) ?? null;

  const count = countQuery.data;
  const folderCounts: Record<Folder, number | undefined> = {
    inbox: count?.total,
    unread: count?.unread,
    saved: count?.saved,
    // Trash isn't in the count summary (which excludes deleted); show the live
    // list length only while the Trash folder is open.
    trash: folder === 'trash' ? folderMessages.length : undefined,
  };

  // ── action callbacks bound to the current selection ────────────────────────
  const onPlay = useCallback(() => {
    if (selectedMessage && !selectedMessage.is_read) readMutation.mutate(selectedMessage.id);
  }, [selectedMessage, readMutation]);

  const onCallBack = useCallback(() => {
    if (selectedMessage) void makeCall(selectedMessage.caller_id);
  }, [selectedMessage, makeCall]);

  const onToggleSave = useCallback(() => {
    if (selectedMessage) saveMutation.mutate({ id: selectedMessage.id, saved: !selectedMessage.is_saved });
  }, [selectedMessage, saveMutation]);

  const onDelete = useCallback(() => {
    if (selectedMessage) deleteMutation.mutate(selectedMessage.id);
  }, [selectedMessage, deleteMutation]);

  const onRestore = useCallback(() => {
    if (selectedMessage) restoreMutation.mutate(selectedMessage.id);
  }, [selectedMessage, restoreMutation]);

  const onPurge = useCallback(() => {
    if (selectedMessage) purgeMutation.mutate(selectedMessage.id);
  }, [selectedMessage, purgeMutation]);

  const invalidateMailboxes = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['voicemail', 'mailboxes'] });
  }, [queryClient]);

  return {
    mailboxes,
    mailboxId,
    selectedMailbox,
    mailboxesLoading: mailboxesQuery.isLoading,
    folderCounts,
    visibleMessages,
    messagesLoading: messagesQuery.isLoading,
    selectedId,
    selectedMessage,
    detail: detailQuery.data,
    detailLoading: detailQuery.isLoading,
    canCallBack: connectionState === 'registered',
    actions: { onPlay, onCallBack, onToggleSave, onDelete, onRestore, onPurge },
    pending: {
      deleting: deleteMutation.isPending,
      restoring: restoreMutation.isPending,
      purging: purgeMutation.isPending,
    },
    invalidateMailboxes,
  };
}
