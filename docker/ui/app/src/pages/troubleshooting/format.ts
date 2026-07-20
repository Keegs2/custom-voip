/**
 * Pure formatting / parsing helpers for the Troubleshooting page.
 *
 * Kept free of React + JSX so it can be imported by hooks, the page, and the
 * presentational components alike without any fast-refresh concerns.
 */

import { fmt } from '../../utils/format';

/** Returns ISO 8601 (minute precision) for a date offset by `offsetHours` from now. */
export function isoOffset(offsetHours: number): string {
  const d = new Date(Date.now() + offsetHours * 60 * 60 * 1000);
  // datetime-local inputs need "YYYY-MM-DDTHH:MM" — drop seconds/tz
  return d.toISOString().slice(0, 16);
}

/** Strip leading + so Homer storage format matches. */
export function stripPlus(value: string): string {
  return value.trim().replace(/^\+/, '');
}

/** Returns true when a string looks like a phone number (mostly digits). */
export function looksLikePhone(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

/** Display phone numbers prettily when they look like phones; otherwise as-is. */
export function displayUser(value: string): string {
  return looksLikePhone(value) ? fmt(value) : value;
}

/**
 * Format an ISO date string to a readable local datetime with microsecond
 * precision. JavaScript Date only has millisecond precision, so we extract the
 * fractional seconds directly from the ISO string (e.g.
 * "2026-05-20T06:44:42.123456Z").
 */
export function fmtDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    const base = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }).format(d);
    // Extract fractional seconds from the ISO string directly (up to 6 digits)
    // since Date.getMilliseconds() truncates to 3 digits
    const fracMatch = iso.match(/\.(\d+)Z?$/);
    const frac = fracMatch ? fracMatch[1].padEnd(6, '0').slice(0, 6) : '000000';
    const dotFrac = '.' + frac;
    return base.replace(/(\d{2})\s*(AM|PM)/i, `$1${dotFrac} $2`);
  } catch {
    return iso;
  }
}

/** Format seconds into a human-readable duration string. */
export function fmtCallDuration(seconds: number): string {
  if (seconds < 0) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}
