/**
 * Data + derived state for the Media & Transcription monitor. Owns the polling
 * query and the byte/frame rollups. React #310: hooks are unconditional + top.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listMediaStreams } from '../../../api/mediaStreams';
import type { MediaStream } from '../../../types/mediaStream';

const POLL_MS = 4000;

export interface UseMediaStreamsResult {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  eslOffline: boolean;
  streams: MediaStream[];
  totalBytes: number;
  totalFrames: number;
}

export function useMediaStreams(): UseMediaStreamsResult {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['media-streams'],
    queryFn: listMediaStreams,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
  });

  const streams = useMemo(() => data?.streams ?? [], [data]);
  const totalBytes = useMemo(() => streams.reduce((acc, s) => acc + s.bytes, 0), [streams]);
  const totalFrames = useMemo(() => streams.reduce((acc, s) => acc + s.frames, 0), [streams]);

  return {
    isLoading,
    isError,
    error,
    eslOffline: data?.esl_connected === false,
    streams,
    totalBytes,
    totalFrames,
  };
}

// ── Formatting helpers (pure) ────────────────────────────────────────────────

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function fmtStreamDurationMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtNum(n: number): string {
  return n.toLocaleString();
}
