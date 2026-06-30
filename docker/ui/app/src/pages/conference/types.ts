/**
 * Local types for the Conference feature folder. Page-global conference types
 * still come from `src/types/conference.ts` — only feature-local unions live here.
 */

import type { Conference, ConferenceSchedule } from '../../types/conference';

/** The four tabs in the room detail panel. */
export type DetailTab = 'live' | 'schedule' | 'participants' | 'settings';

/**
 * A schedule row joined with its parent conference, used by the left-panel
 * "Scheduled Meetings" aggregation across every room.
 */
export interface AggregatedSchedule extends ConferenceSchedule {
  conference: Conference;
}
