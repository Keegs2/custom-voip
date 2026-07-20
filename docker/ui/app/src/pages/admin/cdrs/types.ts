/**
 * Local types + consts for the CDRs admin feature folder.
 *
 * Page-global types (Cdr, CdrSearchParams, CdrSummaryRow, …) still come from
 * `src/types/`. Only feature-local unions / consts live here.
 */

/** The full set of CDR filter fields the filter bar drives. */
export interface CdrFilters {
  customer_id: string;
  product_type: string;
  direction: string;
  start_from: string;
  start_to: string;
  destination: string;
  rated_only: boolean;
  sbc_id: string;
}

/** Summary view grouping. */
export type GroupBy = 'day' | 'hour' | 'destination';

/** Records / Summary tab id. */
export type CdrTabId = 'records' | 'summary';

/** Page size for the load-more pagination. */
export const PAGE_SIZE = 50;

export const CDR_TABS: { id: CdrTabId; label: string }[] = [
  { id: 'records', label: 'Records' },
  { id: 'summary', label: 'Summary' },
];
