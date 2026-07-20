/** Local types for the Rates admin feature. */

import type { Rate } from '../../../../types/rate';

export type SortKey = keyof Pick<
  Rate,
  'prefix' | 'description' | 'rate_per_min' | 'cost_per_min' | 'margin_per_min' | 'margin_pct' | 'increment'
>;

export interface EditState {
  description: string;
  rate_per_min: string;
  cost_per_min: string;
}

export interface AddFormState {
  prefix: string;
  description: string;
  rate_per_min: string;
  cost_per_min: string;
  connection_fee: string;
  increment: string;
}

export const DEFAULT_ADD_FORM: AddFormState = {
  prefix: '',
  description: '',
  rate_per_min: '',
  cost_per_min: '',
  connection_fee: '0',
  increment: '6',
};

export const RATES_LIMIT = 500;
