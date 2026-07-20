/**
 * Data + derived state for the Recordings page. The page passes its filter
 * state in; this hook owns the query and the client-side call-uuid filter.
 *
 * React #310: the hook calls useQuery/useMemo unconditionally at the top.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listRecordings } from '../../../api/recordings';
import type { Recording } from '../../../types/recording';
import type { KindFilter } from './types';

export interface UseRecordingsArgs {
  kind: KindFilter;
  callFilter: string;
}

export interface UseRecordingsResult {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  /** Unfiltered full set (for empty-vs-no-match messaging). */
  recordings: Recording[];
  /** Filtered by the client-side call-uuid term. */
  filtered: Recording[];
}

export function useRecordings({ kind, callFilter }: UseRecordingsArgs): UseRecordingsResult {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['recordings', { kind }],
    // Kind is a cheap server-side filter; the call-uuid search is applied
    // client-side so typing doesn't refetch on every keystroke.
    queryFn: () => listRecordings(kind ? { kind, limit: 200 } : { limit: 200 }),
  });

  const recordings = useMemo(() => data?.recordings ?? [], [data]);

  const filtered = useMemo(() => {
    const term = callFilter.trim().toLowerCase();
    if (!term) return recordings;
    return recordings.filter(
      (r) =>
        (r.call_uuid ?? '').toLowerCase().includes(term) ||
        r.recording_uuid.toLowerCase().includes(term),
    );
  }, [recordings, callFilter]);

  return { isLoading, isError, error, recordings, filtered };
}

// ── Formatting helpers (pure) ────────────────────────────────────────────────

export function fmtDurationMs(ms: number | null): string {
  if (!ms || ms <= 0) return '—';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtRecordingDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
