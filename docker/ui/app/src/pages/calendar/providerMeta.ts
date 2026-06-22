/**
 * Shared display metadata for calendar providers and conferencing types.
 * Keeps labels/colours in one place so the connections bar, the color legend,
 * the calendar event styling and the detail panel stay consistent.
 */
import type { CalendarProvider, ConferencingType } from '../../types/calendar';

export interface ProviderMeta {
  /** Full product name, e.g. "Google Calendar". */
  label: string;
  /** Short name for chips/filters, e.g. "Google". */
  short: string;
  /** Accent colour used for chips, legend dots and event styling. */
  color: string;
  /** Label for the "Open in …" deep link (html_link). */
  openLabel: string;
}

export const PROVIDER_META: Record<CalendarProvider, ProviderMeta> = {
  google: {
    label: 'Google Calendar',
    short: 'Google',
    color: '#4285f4',
    openLabel: 'Open in Google Calendar',
  },
  microsoft: {
    label: 'Microsoft 365',
    short: 'Outlook',
    color: '#7b83eb',
    openLabel: 'Open in Outlook',
  },
};

export const ALL_PROVIDERS: CalendarProvider[] = ['google', 'microsoft'];

/** Human label for a conferencing type (UI derives it from `type`, plan §2.5). */
export function conferencingLabel(type: ConferencingType): string {
  switch (type) {
    case 'google_meet':
      return 'Join Google Meet';
    case 'microsoft_teams':
      return 'Join Microsoft Teams';
    case 'zoom':
      return 'Join Zoom';
    case 'other':
      return 'Join video call';
    case null:
      return 'Join call';
  }
}
