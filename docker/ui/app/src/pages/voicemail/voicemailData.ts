/**
 * voicemailData.ts — server state for Visual Voicemail (React Query), the
 * customer SCOPE every query is keyed on, and the error wording.
 *
 * Scope (contract §4 "Scope rule"):
 *
 *   viewer                         customer_id sent   cache key
 *   ─────────────────────────────  ─────────────────  ───────────
 *   tenant (user / readonly)       none (API scopes)  self:<own id>
 *   admin previewing customer N    N                  c:<N>
 *   admin console, customer N      N                  c:<N>
 *   admin console, All customers   none               all
 *
 * The key always carries the customer, so one account's mailboxes can never
 * be served from another's cache entry (a tenant switch, a preview switch,
 * or the admin flipping scopes). The sidebar reads the same summary key.
 *
 * Mutations invalidate the whole ['voicemail'] prefix: React Query refetches
 * only what is mounted (summary, mailboxes, the open mailbox's folders,
 * greetings) and marks the rest stale.
 */
import { useCallback } from 'react';
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import {
  getVoicemailSummary,
  listAvailableNumbers,
  listGreetings,
  listMailboxes,
  listMessages,
} from '../../api/voicemail';
import type { MessagePage, VoicemailFolder, VoicemailMessage } from '../../types/voicemail';

/* ─── Scope ───────────────────────────────────────────────── */

export interface VoicemailScope {
  /** customer_id for the list endpoints; undefined = tenant self-scope, or every customer (admin). */
  customerId: number | undefined;
  /** Cache discriminator, see the table above. */
  key: string;
}

/** A tenant looking at their own account. */
export function tenantScope(ownCustomerId: number): VoicemailScope {
  return { customerId: undefined, key: `self:${ownCustomerId}` };
}

/** Staff (admin) looking at one customer, or every customer. */
export function staffScope(customer: number | 'all'): VoicemailScope {
  return customer === 'all' ? { customerId: undefined, key: 'all' } : { customerId: customer, key: `c:${customer}` };
}

export const vmKeys = {
  root: ['voicemail'] as const,
  summary: (s: VoicemailScope) => ['voicemail', s.key, 'summary'] as const,
  mailboxes: (s: VoicemailScope) => ['voicemail', s.key, 'mailboxes'] as const,
  messagesOf: (s: VoicemailScope, mailboxId: number | null) => ['voicemail', s.key, 'messages', mailboxId] as const,
  messages: (s: VoicemailScope, mailboxId: number | null, folder: VoicemailFolder) =>
    ['voicemail', s.key, 'messages', mailboxId, folder] as const,
  greetings: (s: VoicemailScope, mailboxId: number | null) => ['voicemail', s.key, 'greetings', mailboxId] as const,
  available: (q: string) => ['voicemail', 'available-numbers', q] as const,
};

/* ─── Reads ───────────────────────────────────────────────── */

export function useVoicemailSummary(scope: VoicemailScope, enabled = true) {
  return useQuery({
    queryKey: vmKeys.summary(scope),
    queryFn: () => getVoicemailSummary(scope.customerId),
    enabled,
    staleTime: 60_000,
  });
}

export function useMailboxes(scope: VoicemailScope, enabled = true) {
  return useQuery({
    queryKey: vmKeys.mailboxes(scope),
    queryFn: () => listMailboxes(scope.customerId),
    enabled,
  });
}

/** Rows per request (the contract's default page). */
export const MESSAGE_PAGE_SIZE = 50;

/** One folder of one mailbox, paged with "Load more". */
export function useFolderMessages(scope: VoicemailScope, mailboxId: number | null, folder: VoicemailFolder) {
  return useInfiniteQuery({
    queryKey: vmKeys.messages(scope, mailboxId, folder),
    queryFn: ({ pageParam }) =>
      listMessages(mailboxId as number, { folder, limit: MESSAGE_PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return last.items.length > 0 && loaded < last.total ? loaded : undefined;
    },
    enabled: mailboxId !== null,
    placeholderData: keepPreviousData,
  });
}

export function useGreetings(scope: VoicemailScope, mailboxId: number | null) {
  return useQuery({
    queryKey: vmKeys.greetings(scope, mailboxId),
    queryFn: () => listGreetings(mailboxId as number),
    enabled: mailboxId !== null,
  });
}

/** Admin: unassigned DIDs for a new mailbox. `q` is digits only. */
export function useAvailableNumbers(q: string, enabled: boolean) {
  return useQuery({
    queryKey: vmKeys.available(q),
    queryFn: () => listAvailableNumbers(q, 50),
    enabled,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
}

/** Flattens a folder's pages. */
export function folderItems(data: { pages: readonly MessagePage[] } | undefined): VoicemailMessage[] {
  return data?.pages.flatMap((p) => p.items) ?? [];
}

/* ─── Cache maintenance ───────────────────────────────────── */

export function invalidateVoicemail(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: vmKeys.root });
}

/** Hook form of invalidateVoicemail for components. */
export function useInvalidateVoicemail(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => invalidateVoicemail(queryClient), [queryClient]);
}

/**
 * Patches one message in every cached folder of its mailbox (e.g. is_read
 * after playback) so the list updates before the refetch lands.
 */
export function patchCachedMessage(
  queryClient: QueryClient,
  scope: VoicemailScope,
  mailboxId: number,
  messageId: number,
  patch: Partial<VoicemailMessage>,
): void {
  queryClient.setQueriesData<InfiniteData<MessagePage, number>>(
    { queryKey: vmKeys.messagesOf(scope, mailboxId) },
    (data) =>
      data && {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          items: page.items.map((m) => (m.id === messageId ? { ...m, ...patch } : m)),
        })),
      },
  );
}

/* ─── Errors ──────────────────────────────────────────────── */

export const UNAVAILABLE_TEXT = 'Voicemail is temporarily unavailable. Your messages are safe — try again in a few minutes.';

export function isUnavailable(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 503 || err.status === 502 || err.status === 504);
}

/** One user-facing sentence for any voicemail API error. */
export function vmErrorText(err: unknown, fallback: string): string {
  if (isUnavailable(err)) return UNAVAILABLE_TEXT;
  if (err instanceof ApiError) {
    if (err.status === 403) return 'Your account role can’t make that change.';
    if (err.status === 404) return 'That item no longer exists — it may have been deleted.';
    if (err.status === 413) return 'That file is too large to upload.';
    if (err.message && err.status < 500) return err.message;
  }
  return fallback;
}
