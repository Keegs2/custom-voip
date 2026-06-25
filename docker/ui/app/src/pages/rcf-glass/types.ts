/**
 * Local types for the RCF glass reference page. Anything shared only within
 * this feature folder lives here (page-global types still come from
 * `src/types/rcf.ts`).
 */

export type SortField = 'did' | 'forward_to' | 'name' | 'customer';
export type ViewMode = 'cards' | 'table';

/** Page size for the "load more" pagination. */
export const PAGE_SIZE = 12;
