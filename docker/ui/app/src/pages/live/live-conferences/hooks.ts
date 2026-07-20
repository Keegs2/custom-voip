/**
 * Data + control layer for the Live Conferences page. The list query polls every
 * active FS room; `useMemberControl` owns one member's kick/mute action + busy
 * flag. React #310: hooks are unconditional + at the top of each function.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listLiveConferences, kickLiveMember, muteLiveMember } from '../../../api/conferencesLive';
import { ApiError } from '../../../api/client';
import type { LiveConference, LiveConferenceMember } from '../../../types/conferenceLive';
import { useToast } from '../../../components/ui/Toast';

export const POLL_MS = 4000;

export interface UseLiveConferencesResult {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  eslOffline: boolean;
  count: number;
  conferences: LiveConference[];
  refetch: () => void;
}

export function useLiveConferences(): UseLiveConferencesResult {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['live-conferences'],
    queryFn: listLiveConferences,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
  });

  const conferences = useMemo(() => data?.conferences ?? [], [data]);
  return {
    isLoading,
    isError,
    error,
    // /conferences/live always returns esl_connected; treat explicit false as offline.
    eslOffline: data?.esl_connected === false,
    count: data?.count ?? 0,
    conferences,
    refetch: () => void refetch(),
  };
}

export interface UseMemberControlResult {
  busy: 'kick' | 'mute' | null;
  run: (kind: 'kick' | 'mute') => Promise<void>;
}

export function useMemberControl(room: string, member: LiveConferenceMember, onActed: () => void): UseMemberControlResult {
  const { toastOk, toastErr } = useToast();
  const [busy, setBusy] = useState<'kick' | 'mute' | null>(null);

  const run = async (kind: 'kick' | 'mute'): Promise<void> => {
    setBusy(kind);
    try {
      if (kind === 'kick') await kickLiveMember(room, member.id);
      else await muteLiveMember(room, member.id);
      toastOk(kind === 'kick' ? 'Member removed' : 'Mute toggled');
      onActed();
    } catch (err) {
      toastErr(err instanceof ApiError ? err.message : `Failed to ${kind} member`);
    } finally {
      setBusy(null);
    }
  };

  return { busy, run };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

export function memberName(m: LiveConferenceMember): string {
  return m.name || m.caller_id_name || m.caller_id_number || `Member ${m.id}`;
}
