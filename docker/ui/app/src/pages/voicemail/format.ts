/**
 * Pure presentational formatters for the voicemail inbox. No React, no data
 * fetching — safe to import from any presentational component.
 */

import type { TranscriptStatus } from '../../types/voicemail';

/** `mm:ss` from a duration in milliseconds. */
export function formatDuration(ms: number): string {
  const s = Math.floor((ms ?? 0) / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** Relative, human date label (Just now / 3h ago / Yesterday / Monday / Jun 4). */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) {
    const diffH = Math.floor(diffMs / 3600000);
    if (diffH === 0) {
      const diffM = Math.floor(diffMs / 60000);
      return diffM < 2 ? 'Just now' : `${diffM}m ago`;
    }
    return `${diffH}h ago`;
  }
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** One-line preview describing the transcript availability for a row. */
export function transcriptPreview(status: TranscriptStatus | null | undefined): string {
  switch (status) {
    case 'done':
      return 'Transcription ready — open to read';
    case 'processing':
    case 'pending':
      return 'Transcribing…';
    case 'failed':
      return 'Transcription unavailable';
    default:
      return 'No transcription';
  }
}
