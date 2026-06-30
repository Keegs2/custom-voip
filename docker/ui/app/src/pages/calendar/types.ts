/**
 * Local types for the Calendar feature folder. Page-global types still come
 * from `src/types/calendar.ts`; only view-local unions / consts live here.
 */
import type { CalendarProvider } from '../../types/calendar';

/** FullCalendar view keys exposed by the view switcher. */
export type CalViewKey = 'dayGridMonth' | 'timeGridWeek' | 'listWeek';

/** Provider filter — 'all' or a single connected provider. */
export type ProviderFilter = CalendarProvider | 'all';

/** The tz-aware ISO range FullCalendar reports for the visible window. */
export interface DateRange {
  start: string | null;
  end: string | null;
}

/** View switcher options (plain data — safe to live alongside types). */
export const VIEW_OPTIONS: { key: CalViewKey; label: string }[] = [
  { key: 'dayGridMonth', label: 'Month' },
  { key: 'timeGridWeek', label: 'Week' },
  { key: 'listWeek', label: 'Agenda' },
];
