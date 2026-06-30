/**
 * Local types for the Troubleshooting (SIP-trace search) feature folder.
 *
 * Page-global types live in `src/api/homer.ts` (HomerSearchResult / params) —
 * only types that are local to this feature live here.
 */

import type { HomerSearchResult } from '../../api/homer';

/** A single call represented by one row in the search results. */
export interface CallGroup {
  /** The representative message (initial inbound INVITE, or earliest message). */
  representative: HomerSearchResult;
  /** All Call-IDs in this correlation group. */
  callIds: string[];
  /** Every SIP message belonging to this call. */
  messages: HomerSearchResult[];
  /** Final SIP response status (highest non-1xx response, or null). */
  finalStatus: number | null;
  /** Duration in seconds from first INVITE to last BYE, or null if unavailable. */
  durationSec: number | null;
}
