/**
 * format.ts — pure display helpers for Visual Voicemail. No React, no fetch.
 *
 * Times are shown in the MAILBOX's timezone (Mailbox.timezone), not the
 * browser's: a message left at 9:00 in Chicago reads 9:00 for everyone
 * looking at that mailbox. An unknown zone falls back to the browser's.
 */
import type { Mailbox, VoicemailMessage } from '../../types/voicemail';

/** "m:ss" from seconds. */
export function formatClock(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "m:ss" from milliseconds (message / greeting durations) — floors, like the player. */
export function formatDurationMs(ms: number): string {
  return formatClock((ms ?? 0) / 1000);
}

/** The zone if Intl knows it, else undefined (= the browser's zone). */
export function safeTimeZone(tz: string | null | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

function dayKey(date: Date, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/**
 * Compact list label: "2:41 PM" today, "Yesterday", the weekday within the
 * last week, "Oct 3" this year, "Oct 3, 2025" before.
 */
export function formatListWhen(iso: string, timeZone: string | undefined, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = dayKey(now, timeZone);
  const that = dayKey(d, timeZone);
  if (that === today) {
    return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(d);
  }
  const yesterday = dayKey(new Date(now.getTime() - 86_400_000), timeZone);
  if (that === yesterday) return 'Yesterday';
  const ageDays = (now.getTime() - d.getTime()) / 86_400_000;
  if (ageDays > 0 && ageDays < 6.5) {
    return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(d);
  }
  const sameYear = that.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(d);
}

/** "Tuesday, October 20, 2026 at 2:41 PM EDT". */
export function formatFullWhen(iso: string, timeZone: string | undefined): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(d);
}

/** "Jan 18, 2027". */
export function formatDate(iso: string, timeZone: string | undefined): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', year: 'numeric' }).format(d);
}

/** Whole days from now until `iso` (negative when past). */
export function daysUntil(iso: string, now: Date = new Date()): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return Math.ceil((t - now.getTime()) / 86_400_000);
}

/** Days before expiry at which the list starts warning. */
export const EXPIRY_WARN_DAYS = 7;

/** "Deleted in 3 days" / "Deleted tomorrow" / "Deleted today", or null when not soon. */
export function expiryHint(message: Pick<VoicemailMessage, 'expires_at'>, now: Date = new Date()): string | null {
  const days = daysUntil(message.expires_at, now);
  if (days > EXPIRY_WARN_DAYS) return null;
  if (days <= 0) return 'Deleted today';
  if (days === 1) return 'Deleted tomorrow';
  return `Deleted in ${days} days`;
}

/** US numbers as "(617) 555-0134"; anything else unchanged. */
export function formatPhone(raw: string | null | undefined): string {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits.length === 10 ? digits : null;
  if (!ten) return raw;
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

/** The 10 national digits of a US DID, for typed confirmations. */
export function nationalDigits(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

/** The line a message is "from": caller name, else number, else "Unknown caller". */
export function callerTitle(m: Pick<VoicemailMessage, 'caller_id_name' | 'caller_id_number'>): string {
  const name = m.caller_id_name?.trim();
  if (name && !/^(unknown|anonymous|unavailable)$/i.test(name) && name.replace(/\D/g, '') !== m.caller_id_number?.replace(/\D/g, '')) {
    return name;
  }
  const number = formatPhone(m.caller_id_number);
  return number || 'Unknown caller';
}

/** The second line under callerTitle — the number, when the title is a name. */
export function callerSubtitle(m: Pick<VoicemailMessage, 'caller_id_name' | 'caller_id_number'>): string | null {
  const title = callerTitle(m);
  const number = formatPhone(m.caller_id_number);
  return number && number !== title ? number : null;
}

/**
 * "1.2 MB" / "340 KB" in binary units (1 MB = 1024 × 1024 bytes), so the
 * 500 MB mailbox cap (524,288,000 bytes) reads as "500 MB", as the owner
 * set it.
 */
export function formatBytes(bytes: number): string {
  const KB = 1024;
  const MB = 1024 * 1024;
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / KB))} KB`;
  const mb = bytes / MB;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/** "Main line · (617) 555-0134". */
export function mailboxName(m: Pick<Mailbox, 'label' | 'did'>): string {
  return `${m.label || 'Voicemail'} · ${formatPhone(m.did)}`;
}

/** Zones offered in the mailbox settings (US + territories, then UTC). */
export const TIMEZONES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'America/New_York', label: 'Eastern (New York)' },
  { id: 'America/Chicago', label: 'Central (Chicago)' },
  { id: 'America/Denver', label: 'Mountain (Denver)' },
  { id: 'America/Phoenix', label: 'Mountain, no DST (Phoenix)' },
  { id: 'America/Los_Angeles', label: 'Pacific (Los Angeles)' },
  { id: 'America/Anchorage', label: 'Alaska (Anchorage)' },
  { id: 'Pacific/Honolulu', label: 'Hawaii (Honolulu)' },
  { id: 'America/Puerto_Rico', label: 'Atlantic (Puerto Rico)' },
  { id: 'UTC', label: 'UTC' },
];

export const DEFAULT_TIMEZONE = 'America/New_York';

/** PIN rule from the contract: 4–10 digits. */
export const PIN_PATTERN = /^\d{4,10}$/;
