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
 *
 * Transcripts (v1.1, docs/VOICEMAIL_TRANSCRIPTION_PLAN.md §11.3) live under a
 * SEPARATE root, ['voicemail-transcript'], that invalidateVoicemail() never
 * touches: every fetch of a `done` transcript or snippet costs a KMS decrypt
 * and an audit row, so they are fetched once per session and refreshed only
 * on purpose (a retry, or a status change seen in the list). They live in
 * memory only — no persister, no local/session storage (plan D8).
 */
import { useCallback, useEffect, useMemo } from 'react';
import {
  keepPreviousData,
  useInfiniteQuery,
  useQueries,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type QueryObserverResult,
} from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import {
  getTranscript,
  getTranscriptSnippets,
  getVoicemailSummary,
  listAvailableNumbers,
  listGreetings,
  listMailboxes,
  listMessages,
  TRANSCRIPT_SNIPPET_BATCH_MAX,
} from '../../api/voicemail';
import type {
  MessagePage,
  Transcript,
  TranscriptSnippet,
  TranscriptStatus,
  VoicemailFolder,
  VoicemailMessage,
} from '../../types/voicemail';

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

/**
 * One folder of one mailbox, paged with "Load more".
 *
 * `pollTranscripts` (= summary.transcription_available): while any loaded
 * message's transcript is pending or processing, the folder refetches every
 * 10 s so "Transcribing…" turns into the snippet without a reload. Never in
 * Trash (trashed messages aren't transcribed), and — the React Query default
 * — never while the tab is in the background.
 */
export function useFolderMessages(
  scope: VoicemailScope,
  mailboxId: number | null,
  folder: VoicemailFolder,
  pollTranscripts = false,
) {
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
    refetchInterval: (query) =>
      pollTranscripts && folder !== 'trash' && anyTranscriptActive(query.state.data) ? FOLDER_TRANSCRIPT_POLL_MS : false,
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

/* ─── Transcripts (v1.1) ──────────────────────────────────── */

/**
 * The transcript cache root — deliberately NOT under ['voicemail'], so the
 * invalidateVoicemail() that follows every mutation never refetches (and
 * re-decrypts, and re-audits) a transcript.
 */
export const vmTranscriptKeys = {
  root: ['voicemail-transcript'] as const,
  full: (s: VoicemailScope, messageId: number) => ['voicemail-transcript', s.key, 'full', messageId] as const,
  snippet: (s: VoicemailScope, messageId: number) => ['voicemail-transcript', s.key, 'snippet', messageId] as const,
};

/** Reading-pane poll while a transcript is in progress. */
export const TRANSCRIPT_POLL_MS = 5_000;
/** The reading pane stops polling after this long continuously in progress. */
export const TRANSCRIPT_STALL_MS = 3 * 60_000;
/** Folder poll while any loaded message is being transcribed. */
export const FOLDER_TRANSCRIPT_POLL_MS = 10_000;
/** A larger gap between two fetches means we weren't watching — start a fresh stall window. */
const TRANSCRIPT_WATCH_GAP_MS = 2 * TRANSCRIPT_POLL_MS + 1_000;

/**
 * A message's transcript status. Defensive about the field being absent (an
 * API older than v1.1, e.g. during a rollback): no transcript = `disabled`,
 * which renders nothing.
 */
export function transcriptStatusOf(message: Pick<VoicemailMessage, 'transcript'>): TranscriptStatus {
  return message.transcript?.status ?? 'disabled';
}

/** pending | processing — the worker still owes this message a result. */
export function isTranscriptActive(status: TranscriptStatus | null | undefined): boolean {
  return status === 'pending' || status === 'processing';
}

function anyTranscriptActive(data: { pages: readonly MessagePage[] } | undefined): boolean {
  return data?.pages.some((page) => page.items.some((m) => isTranscriptActive(transcriptStatusOf(m)))) ?? false;
}

/**
 * What useTranscript caches: the API body plus when it was fetched and since
 * when it has been continuously in progress (both stamped in the queryFn, so
 * render never reads the clock).
 */
export interface TranscriptEntry {
  transcript: Transcript;
  fetchedAt: number;
  /** First fetch of the current pending/processing run; null when not in progress. */
  activeSince: number | null;
}

/** In progress for ≥ 3 min as of the last fetch — polling has stopped. */
export function isTranscriptStalled(entry: TranscriptEntry | undefined): boolean {
  return (
    entry !== undefined &&
    entry.activeSince !== null &&
    isTranscriptActive(entry.transcript.status) &&
    entry.fetchedAt - entry.activeSince >= TRANSCRIPT_STALL_MS
  );
}

/** Network failures get one more try; API answers (4xx, 500, 503) are shown as they are. */
function retryNetworkOnce(failureCount: number, error: unknown): boolean {
  return !(error instanceof ApiError) && failureCount < 1;
}

/**
 * The full transcript of one message, for the reading pane.
 *
 * - `staleTime: Infinity` — a `done` transcript is decrypted and audited once
 *   per session. Refreshed only via invalidateTranscript() (after a retry, or
 *   when the list shows the status moved).
 * - Polls every 5 s while pending/processing (when `poll`), and stops after
 *   3 min of continuous progress: the panel then says "Still transcribing —
 *   check back shortly." Coming back to the message later starts a fresh
 *   window (it refetches on mount while in progress).
 * - `poll` is false when there is nothing to wait for: transcription paused
 *   platform-wide, or the message is in Trash.
 */
export function useTranscript(scope: VoicemailScope, messageId: number, enabled: boolean, poll = true) {
  const queryClient = useQueryClient();
  const queryKey = vmTranscriptKeys.full(scope, messageId);
  return useQuery({
    queryKey,
    queryFn: async (): Promise<TranscriptEntry> => {
      const transcript = await getTranscript(messageId);
      const fetchedAt = Date.now();
      const prev = queryClient.getQueryData<TranscriptEntry>(queryKey);
      const watched =
        prev !== undefined &&
        prev.activeSince !== null &&
        isTranscriptActive(prev.transcript.status) &&
        fetchedAt - prev.fetchedAt <= TRANSCRIPT_WATCH_GAP_MS;
      const activeSince = isTranscriptActive(transcript.status) ? (watched ? prev.activeSince : fetchedAt) : null;
      return { transcript, fetchedAt, activeSince };
    },
    enabled,
    staleTime: Infinity,
    retry: retryNetworkOnce,
    refetchOnMount: (query) =>
      isTranscriptActive(query.state.data?.transcript.status) ? 'always' : true,
    refetchInterval: (query) => {
      const entry = query.state.data;
      if (!poll || !entry || !isTranscriptActive(entry.transcript.status)) return false;
      return isTranscriptStalled(entry) ? false : TRANSCRIPT_POLL_MS;
    },
  });
}

/** Refetch one message's full transcript (if it is cached) — after a retry or a status change. */
export function invalidateTranscript(queryClient: QueryClient, scope: VoicemailScope, messageId: number): void {
  void queryClient.invalidateQueries({ queryKey: vmTranscriptKeys.full(scope, messageId), exact: true });
}

/* Snippets: per-id cache, fetched in batches of ≤ 50 per mailbox. */

/** Thrown for a done message whose snippet could not be decrypted this time — not cached, tried again later. */
class SnippetUnavailableError extends Error {
  constructor() {
    super('Transcript snippet temporarily unavailable.');
    this.name = 'SnippetUnavailableError';
  }
}

interface SnippetWaiter {
  resolve: (snippet: TranscriptSnippet) => void;
  reject: (error: unknown) => void;
}

/** Ids asked for (per mailbox) since the last flush, with everyone waiting on each. */
const snippetQueue = new Map<number, Map<number, SnippetWaiter[]>>();
/** Collect the ids every row asks for in one commit into one request. */
const SNIPPET_BATCH_WINDOW_MS = 16;

function chunk<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function flushSnippets(mailboxId: number): Promise<void> {
  const waiting = snippetQueue.get(mailboxId);
  snippetQueue.delete(mailboxId);
  if (!waiting) return;
  // One batch at a time: the API decrypts through 4 shared slots with a 2 s
  // budget per request, so parallel batches would only starve each other.
  for (const ids of chunk([...waiting.keys()], TRANSCRIPT_SNIPPET_BATCH_MAX)) {
    try {
      const page = await getTranscriptSnippets(mailboxId, ids);
      const byId = new Map(page.items.map((item) => [item.message_id, item]));
      for (const id of ids) {
        const item = byId.get(id);
        for (const waiter of waiting.get(id) ?? []) {
          if (item === undefined) {
            // Not a stored message of this mailbox any more (purged since the list loaded).
            waiter.resolve({ message_id: id, status: 'done', snippet: null });
          } else if (item.status === 'done' && item.snippet !== null) {
            waiter.resolve(item);
          } else {
            // Decrypt missed its budget, or the transcript moved on since the
            // list loaded: don't cache a hole — a later mount fetches it again.
            waiter.reject(new SnippetUnavailableError());
          }
        }
      }
    } catch (err) {
      for (const id of ids) for (const waiter of waiting.get(id) ?? []) waiter.reject(err);
    }
  }
}

/** One message's snippet, batched with every other snippet asked for in the same frame. */
function loadSnippet(mailboxId: number, messageId: number): Promise<TranscriptSnippet> {
  return new Promise((resolve, reject) => {
    let waiting = snippetQueue.get(mailboxId);
    if (!waiting) {
      waiting = new Map();
      snippetQueue.set(mailboxId, waiting);
      window.setTimeout(() => void flushSnippets(mailboxId), SNIPPET_BATCH_WINDOW_MS);
    }
    waiting.set(messageId, [...(waiting.get(messageId) ?? []), { resolve, reject }]);
  });
}

function collectSnippets(results: QueryObserverResult<TranscriptSnippet>[]): ReadonlyMap<number, string> {
  const map = new Map<number, string>();
  for (const r of results) {
    if (r.data?.snippet) map.set(r.data.message_id, r.data.snippet);
  }
  return map;
}

/**
 * One-line snippets for the visible messages whose transcript is `done`,
 * as a map message id → snippet (absent = still loading, or none to show).
 *
 * Each snippet is cached per id (`staleTime`/`gcTime: Infinity`), so a done
 * snippet is fetched at most once per session; ids without a cache entry are
 * fetched together in batches of ≤ 50 (one decrypt + one audit row per id,
 * one audit row per batch). List refetches cost nothing.
 */
export function useTranscriptSnippets(
  scope: VoicemailScope,
  mailboxId: number,
  messages: readonly VoicemailMessage[],
): ReadonlyMap<number, string> {
  const queryClient = useQueryClient();
  const doneIds = useMemo(
    () => messages.filter((m) => transcriptStatusOf(m) === 'done').map((m) => m.id),
    [messages],
  );
  const notDoneIds = useMemo(
    () => messages.filter((m) => transcriptStatusOf(m) !== 'done').map((m) => m.id),
    [messages],
  );

  // A message that left `done` (an admin re-run) drops its cached snippet, so
  // the new text is fetched once it is done again.
  useEffect(() => {
    for (const id of notDoneIds) {
      const queryKey = vmTranscriptKeys.snippet(scope, id);
      if (queryClient.getQueryState(queryKey) !== undefined) queryClient.removeQueries({ queryKey, exact: true });
    }
  }, [queryClient, scope, notDoneIds]);

  return useQueries({
    queries: doneIds.map((id) => ({
      queryKey: vmTranscriptKeys.snippet(scope, id),
      queryFn: () => loadSnippet(mailboxId, id),
      staleTime: Infinity,
      gcTime: Infinity,
      retry: false,
    })),
    combine: collectSnippets,
  });
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

/**
 * Error text for transcription actions. The API writes each 4xx detail to be
 * shown verbatim (403 "Only an administrator can change transcription
 * settings.", the 409s, 422 "Choose a supported language."), so those win;
 * everything else gets the voicemail wording.
 */
export function transcriptErrorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 404 && err.message) {
    return err.message;
  }
  return vmErrorText(err, fallback);
}
