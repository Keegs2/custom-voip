/**
 * Local types + constants for the DID Search / Number Management feature.
 *
 * Page-global DID types live in `src/types/didInventory.ts`. Only feature-local
 * unions, page-size constants, and presentational metadata maps live here.
 */

import { GLASS } from '../../../components/glass/glass';
import type { DidStatus, DidAllocatedEnv } from '../../../types/didInventory';

/** Server page size for the inventory tab pagination. */
export const PAGE_SIZE = 50;

/** Which internal tab is active. Admins and customers see different sets. */
export type TabId = 'inventory' | 'available' | 'assignments' | 'my-numbers';

export interface TabDef {
  id: TabId;
  label: string;
}

/** Product types selectable when assigning a number. */
export const PRODUCT_TYPES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'rcf', label: 'Remote Call Forwarding (RCF)' },
  { value: 'api', label: 'API Calling' },
  { value: 'trunk', label: 'SIP Trunk' },
  { value: 'ucaas', label: 'UCaaS' },
];

/** US state two-letter codes for the state filter dropdown. */
export const US_STATES: ReadonlyArray<string> = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC',
];

const PURPLE = '#a855f7';

/** Semantic colour + label for each DID status (icon supplied by the component). */
export const STATUS_META: Record<DidStatus, { label: string; color: string }> = {
  available:   { label: 'Available',   color: GLASS.blue },
  assigned:    { label: 'Assigned',    color: GLASS.success },
  reserved:    { label: 'Reserved',    color: GLASS.warning },
  porting_in:  { label: 'Porting In',  color: PURPLE },
  porting_out: { label: 'Porting Out', color: PURPLE },
  suspended:   { label: 'Suspended',   color: GLASS.danger },
};

/** Semantic colour for each known product type pill. */
export const PRODUCT_META: Record<string, string> = {
  rcf:   GLASS.blue,
  api:   PURPLE,
  trunk: GLASS.warning,
  ucaas: GLASS.success,
};

/** Owning-environment colour + label. */
export const ENV_META: Record<DidAllocatedEnv, { label: string; color: string }> = {
  prod:     { label: 'Production', color: GLASS.blue },
  sandbox:  { label: 'Sandbox',    color: GLASS.cyan },
  reserved: { label: 'Reserved',   color: GLASS.textFaint },
};
