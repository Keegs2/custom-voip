/**
 * Data layer for the Call Queues monitor. Two polling queries: the queue-depth
 * summary list, and a per-queue member drill-in. React #310: hooks are
 * unconditional + at the top of each hook function.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listQueues, getQueue } from '../../../api/queues';
import type { QueueSummary, QueueMember } from '../../../types/queue';

export const POLL_MS = 5000;

export interface UseQueuesResult {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  eslOffline: boolean;
  queues: QueueSummary[];
}

export function useQueues(): UseQueuesResult {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['queues'],
    queryFn: listQueues,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
  });

  const queues = useMemo(() => data?.queues ?? [], [data]);
  return { isLoading, isError, error, eslOffline: data?.esl_connected === false, queues };
}

/** Drill-in: the live waiting-member roster for one queue. */
export function useQueueMembers(name: string) {
  return useQuery({
    queryKey: ['queue', name],
    queryFn: () => getQueue(name),
    refetchInterval: POLL_MS,
  });
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

export function memberLabel(m: QueueMember): string {
  return m.caller || m.uuid || 'caller';
}

export function fmtWait(ms?: number): string {
  if (ms === undefined || ms === null) return '—';
  const s = Math.floor(ms / 1000);
  const mm = Math.floor(s / 60);
  return `${mm}:${String(s % 60).padStart(2, '0')}`;
}
