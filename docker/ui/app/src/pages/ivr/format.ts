/**
 * format.ts — dates and small words for the IVR pages (the viewer's own
 * time zone; mock and real data alike are ISO 8601 instants).
 */
import type { PromptKind } from '../../types/ivr';

export const KIND_WORDS: Readonly<Record<PromptKind, string>> = {
  tts: 'Text to speech',
  recording: 'Recording',
  upload: 'Uploaded file',
};

const TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const DAY_YEAR = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today, 2:14 PM" · "Yesterday, 9:02 AM" · "Oct 20, 2:14 PM" · "Mar 3, 2025". */
export function formatWhen(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) return `Today, ${TIME.format(d)}`;
  if (days === 1) return `Yesterday, ${TIME.format(d)}`;
  if (d.getFullYear() !== now.getFullYear()) return DAY_YEAR.format(d);
  return `${DAY.format(d)}, ${TIME.format(d)}`;
}

/** "0:42" from milliseconds. */
export function formatLength(ms: number): string {
  // Floor, like the player's clock — the two never disagree by a second.
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** True when the draft was saved after the last publish (callers hear an older version). */
export function hasUnpublishedChanges(flow: { updated_at: string; published_at: string | null }): boolean {
  if (!flow.published_at) return false;
  return new Date(flow.updated_at).getTime() > new Date(flow.published_at).getTime() + 1000;
}
