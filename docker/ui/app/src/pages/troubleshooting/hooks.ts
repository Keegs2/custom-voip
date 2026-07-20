/**
 * Data + logic layer for the Troubleshooting (SIP-trace search) page.
 *
 * Per the refactor convention (docs/FRONTEND_GLASS_REFACTOR.md): the page does
 * composition + top-level form state only; the search mutation, call-grouping
 * pipeline, and all derived values live here. Presentational components stay dumb.
 *
 * React #310: every hook below is called unconditionally at the top of its hook
 * function — no early returns precede a hook.
 */

import { useCallback, useMemo } from 'react';
import { useMutation } from '@tanstack/react-query';
import { searchSipTraces } from '../../api/homer';
import type { HomerSearchParams, HomerSearchResult } from '../../api/homer';
import type { CallGroup } from './types';

// ── Call grouping (pure) ─────────────────────────────────────────────────────

/**
 * Groups SIP messages into calls using the correlations map.
 *
 * The correlations map has Call-ID -> list of related Call-IDs. We build
 * connected components (union-find style) so that A-leg and B-leg messages are
 * merged into a single call group. Then we pick the best representative message
 * for each group: the earliest INVITE request (status === null), falling back to
 * the earliest message overall.
 */
export function groupMessagesByCall(
  results: HomerSearchResult[],
  correlations: Record<string, string[]>,
): CallGroup[] {
  // Build union-find: map each Call-ID to its canonical group key
  const parent = new Map<string, string>();

  function find(id: string): string {
    let root = id;
    while (parent.has(root) && parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    // Path compression
    let current = id;
    while (current !== root) {
      const next = parent.get(current) ?? current;
      parent.set(current, root);
      current = next;
    }
    return root;
  }

  function union(a: string, b: string): void {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent.set(rootB, rootA);
    }
  }

  // Initialize each Call-ID as its own parent
  for (const row of results) {
    if (!parent.has(row.callid)) {
      parent.set(row.callid, row.callid);
    }
  }

  // Union correlated Call-IDs
  for (const [cid, related] of Object.entries(correlations)) {
    if (!parent.has(cid)) {
      parent.set(cid, cid);
    }
    for (const relatedCid of related) {
      if (!parent.has(relatedCid)) {
        parent.set(relatedCid, relatedCid);
      }
      union(cid, relatedCid);
    }
  }

  // Group messages by their root Call-ID
  const groups = new Map<string, HomerSearchResult[]>();
  for (const row of results) {
    const root = find(row.callid);
    const existing = groups.get(root);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(root, [row]);
    }
  }

  // Build CallGroup objects
  const callGroups: CallGroup[] = [];
  for (const [, messages] of groups) {
    // Sort messages by timestamp (earliest first)
    messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    // Collect all unique Call-IDs in this group
    const callIdSet = new Set<string>();
    for (const msg of messages) {
      callIdSet.add(msg.callid);
    }
    const callIds = Array.from(callIdSet);

    // Find the representative: earliest INVITE request (status === null)
    let representative = messages.find(
      (m) => m.method.toUpperCase() === 'INVITE' && m.status === null,
    );
    // Fallback: just the earliest message
    if (!representative) {
      representative = messages[0];
    }

    // Determine the final call status: highest non-1xx response code in the group.
    // This shows whether the call was answered (200), rejected (4xx/5xx), etc.
    let finalStatus: number | null = null;
    for (const msg of messages) {
      if (msg.status !== null && msg.status >= 200) {
        if (finalStatus === null || msg.status > finalStatus) {
          finalStatus = msg.status;
        }
      }
    }
    // If we only have 1xx provisional responses, show the highest one
    if (finalStatus === null) {
      for (const msg of messages) {
        if (msg.status !== null && msg.status >= 100 && msg.status < 200) {
          if (finalStatus === null || msg.status > finalStatus) {
            finalStatus = msg.status;
          }
        }
      }
    }

    // Calculate duration: from first INVITE to the last BYE (or last message)
    let durationSec: number | null = null;
    const firstInvite = messages.find(
      (m) => m.method.toUpperCase() === 'INVITE' && m.status === null,
    );
    const lastBye = [...messages]
      .reverse()
      .find((m) => m.method.toUpperCase() === 'BYE');
    if (firstInvite && lastBye) {
      const startNs = firstInvite.timestamp_ns;
      const endNs = lastBye.timestamp_ns;
      if (
        typeof startNs === 'number' &&
        typeof endNs === 'number' &&
        startNs > 0 &&
        endNs > 0
      ) {
        durationSec = Math.round((endNs - startNs) / 1_000_000_000);
      }
    }

    callGroups.push({
      representative,
      callIds,
      messages,
      finalStatus,
      durationSec,
    });
  }

  // Sort call groups by representative timestamp (newest first for search results)
  callGroups.sort((a, b) =>
    b.representative.timestamp.localeCompare(a.representative.timestamp),
  );

  return callGroups;
}

// ── Search hook ──────────────────────────────────────────────────────────────

export interface UseSipSearchResult {
  /** Fire a search with the given Homer params (marks hasSearched). */
  run: (params: HomerSearchParams) => void;
  /** Reset the mutation + the hasSearched flag. */
  reset: () => void;
  hasSearched: boolean;
  isLoading: boolean;
  isError: boolean;
  errorMessage: string | null;
  /** Flat result rows from the API. */
  results: HomerSearchResult[];
  /** Call-ID -> related Call-IDs map. */
  correlations: Record<string, string[]>;
  /** Pipeline diagnostics surfaced above each expanded ladder. */
  pipelineWarnings: string[];
  /** Messages grouped into per-call rows (union-find on correlations). */
  callGroups: CallGroup[];
  totalMessages: number;
  totalCalls: number;
}

/**
 * Owns the SIP-trace search mutation plus the derived call-grouping pipeline.
 * The page passes its form params in via `run()` and renders the result.
 *
 * `hasSearched` is derived from React Query state (`isPending || isSuccess ||
 * isError`) so it follows `reset()` automatically and needs no extra hook.
 */
export function useSipSearch(): UseSipSearchResult {
  const mutation = useMutation({
    mutationFn: (params: HomerSearchParams) => searchSipTraces(params),
  });

  const run = useCallback(
    (params: HomerSearchParams) => {
      mutation.mutate(params);
    },
    [mutation],
  );

  const reset = useCallback(() => {
    mutation.reset();
  }, [mutation]);

  // Memoised so the `?? []` / `?? {}` fallbacks keep a stable identity while
  // there is no data — otherwise the callGroups useMemo below re-runs every
  // render (react-hooks/exhaustive-deps).
  const results = useMemo(() => mutation.data?.data ?? [], [mutation.data]);
  const correlations = useMemo(() => mutation.data?.correlations ?? {}, [mutation.data]);
  const pipelineWarnings = mutation.data?.pipeline_warnings ?? [];

  const callGroups = useMemo(
    () => groupMessagesByCall(results, correlations),
    [results, correlations],
  );

  const isError = mutation.isError;
  const errorMessage = isError
    ? mutation.error instanceof Error
      ? mutation.error.message
      : 'Search failed'
    : null;

  return {
    run,
    reset,
    // hasSearched = the mutation has been kicked off at least once since reset
    hasSearched: mutation.isPending || mutation.isSuccess || mutation.isError,
    isLoading: mutation.isPending,
    isError,
    errorMessage,
    results,
    correlations,
    pipelineWarnings,
    callGroups,
    totalMessages: results.length,
    totalCalls: callGroups.length,
  };
}
