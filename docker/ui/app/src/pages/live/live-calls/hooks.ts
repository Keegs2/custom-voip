/**
 * Data + control layer for the Live Calls page. The list query polls active
 * calls; `useCallControl` owns one call's in-dialog control state (input fields,
 * busy flag, last confirmation) and the POST /calls/{uuid}/update action.
 *
 * React #310: every hook is called unconditionally at the top of its function.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listLiveCalls, updateCall } from '../../../api/liveCalls';
import { ApiError } from '../../../api/client';
import type { CallAction, CallUpdateResponse, LiveCall } from '../../../types/liveCall';
import { useToast } from '../../../components/ui/Toast';

export const POLL_MS = 4000;

export interface UseLiveCallsResult {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  eslOffline: boolean;
  calls: LiveCall[];
  refetch: () => void;
}

export function useLiveCalls(): UseLiveCallsResult {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['live-calls'],
    queryFn: listLiveCalls,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
  });

  const calls = useMemo(() => data?.calls ?? [], [data]);
  // esl_connected is only "offline" when explicitly false; undefined = unknown/ok.
  return {
    isLoading,
    isError,
    error,
    eslOffline: data?.esl_connected === false,
    calls,
    refetch: () => void refetch(),
  };
}

export interface UseCallControlResult {
  transferDest: string;
  setTransferDest: (v: string) => void;
  voiceUrl: string;
  setVoiceUrl: (v: string) => void;
  digits: string;
  setDigits: (v: string) => void;
  busy: CallAction | null;
  lastResult: CallUpdateResponse | null;
  act: (action: CallAction, extra?: Record<string, string>) => Promise<void>;
}

/** All input + busy state + the real update action for one live call's controls. */
export function useCallControl(call: LiveCall, onActed: () => void): UseCallControlResult {
  const { toastOk, toastErr } = useToast();
  const [transferDest, setTransferDest] = useState('');
  const [voiceUrl, setVoiceUrl] = useState('');
  const [digits, setDigits] = useState('');
  const [busy, setBusy] = useState<CallAction | null>(null);
  const [lastResult, setLastResult] = useState<CallUpdateResponse | null>(null);

  const act = async (action: CallAction, extra: Record<string, string> = {}): Promise<void> => {
    setBusy(action);
    setLastResult(null);
    try {
      const res = await updateCall(call.uuid, { action, ...extra });
      setLastResult(res);
      if (res.ok) {
        toastOk(res.confirmed ? `${action} confirmed by FreeSWITCH` : `${action} sent (awaiting confirmation)`);
      } else {
        toastErr(`${action} was not accepted`);
      }
      onActed();
    } catch (err) {
      toastErr(err instanceof ApiError ? err.message : `Failed to ${action} call`);
    } finally {
      setBusy(null);
    }
  };

  return { transferDest, setTransferDest, voiceUrl, setVoiceUrl, digits, setDigits, busy, lastResult, act };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

export function fmtSince(iso: string | null): string {
  if (!iso) return 'ringing';
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
