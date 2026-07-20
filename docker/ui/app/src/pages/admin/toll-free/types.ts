/**
 * Local types + consts for the Toll-Free / RespOrg admin feature.
 *
 * Page-global TFN types live in `src/types/tollFree.ts`. Only feature-local
 * filter shapes, page-size consts, and status metadata maps live here.
 */

import { GLASS } from '../../../components/glass/glass';

/** Server page size for the inventory load-more pagination. */
export const PAGE_SIZE = 50;

/** Draft/committed filter shape driving the list query. */
export interface TfnFilters {
  search: string;
  status: string;
  cr_status: string;
  carrier_id: string;
  customer_id: string;
}

export function emptyTfnFilters(): TfnFilters {
  return { search: '', status: '', cr_status: '', carrier_id: '', customer_id: '' };
}

/** Lifecycle statuses (mirror `_ALLOWED_STATUS`). */
export const TFN_STATUSES: ReadonlyArray<string> = [
  'spare',
  'reserved',
  'assigned',
  'active',
  'suspend',
  'disconnect',
  'transitional',
  'unavailable',
  'aging',
];

/** CR (Customer Record) workflow states surfaced by the API. */
export const CR_STATUSES: ReadonlyArray<string> = ['none', 'pending', 'submitted', 'confirmed', 'rejected', 'error'];

/** Semantic colour per lifecycle status. */
export const STATUS_COLOR: Record<string, string> = {
  spare: GLASS.textMuted,
  reserved: GLASS.warning,
  assigned: GLASS.blue,
  active: GLASS.success,
  suspend: GLASS.danger,
  disconnect: GLASS.danger,
  transitional: GLASS.cyan,
  unavailable: GLASS.textFaint,
  aging: GLASS.warning,
};

/** Semantic colour per CR status. */
export const CR_STATUS_COLOR: Record<string, string> = {
  none: GLASS.textFaint,
  pending: GLASS.warning,
  submitted: GLASS.blue,
  confirmed: GLASS.success,
  rejected: GLASS.danger,
  error: GLASS.danger,
};

export function statusColor(status: string | null | undefined): string {
  if (!status) return GLASS.textFaint;
  return STATUS_COLOR[status] ?? GLASS.textMuted;
}

export function crStatusColor(status: string | null | undefined): string {
  if (!status) return GLASS.textFaint;
  return CR_STATUS_COLOR[status] ?? GLASS.textMuted;
}
