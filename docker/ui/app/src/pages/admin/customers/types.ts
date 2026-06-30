/**
 * Local types for the Customers admin feature folder. Page-global customer
 * types still come from `src/types/customer.ts`; only feature-local shapes and
 * constants live here.
 */

import type { AccountType, TrafficGrade } from '../../../types/customer';

/** Shape of the inline "new customer" create form. */
export interface CreateFormState {
  name: string;
  account_type: AccountType;
  traffic_grade: TrafficGrade;
  credit_limit: string;
  daily_limit: string;
  cpm_limit: string;
  ucaas_enabled: boolean;
  voicemail_enabled: boolean;
}

export const INITIAL_CREATE: CreateFormState = {
  name: '',
  account_type: 'rcf',
  traffic_grade: 'standard',
  credit_limit: '0',
  daily_limit: '500',
  cpm_limit: '60',
  ucaas_enabled: false,
  voicemail_enabled: false,
};

/** Load-more page size for the customer list. */
export const PAGE_SIZE = 25;

/** Column count of the customer table (used for the empty-state colspan). */
export const COL_COUNT = 7;
