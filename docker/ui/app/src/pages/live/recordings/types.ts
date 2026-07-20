/**
 * Local types + constants for the Recordings live-ops page.
 * (Page-global types still come from `src/types/recording.ts`.)
 */

import type { RecordingKind } from '../../../types/recording';
import { GLASS } from '../../../components/glass/glass';

export type KindFilter = '' | RecordingKind;

export const KIND_OPTIONS: { value: KindFilter; label: string }[] = [
  { value: '', label: 'All kinds' },
  { value: 'call', label: 'Call' },
  { value: 'programmable', label: 'Programmable' },
  { value: 'conference', label: 'Conference' },
];

/** Semantic chip colour per recording kind (status colour, not the page accent). */
export const KIND_COLOR: Record<RecordingKind, string> = {
  programmable: '#c084fc',
  call: GLASS.blue,
  conference: GLASS.green,
};
