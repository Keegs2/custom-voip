/**
 * Local types + constants for the Trunks admin feature folder.
 *
 * Page-global trunk types (Trunk, TrunkIp, TrunkDid, TrunkAuthType) still come
 * from `src/types/trunk.ts`. Only feature-local form/option shapes and layout
 * constants live here.
 */

import type { TrunkAuthType } from '../../../types/trunk';

/** SIP server endpoint customers point their PBX at (East SBC-1 VIP). */
export const SIP_SERVER = '34.74.71.32:5060';

/** Column count for the trunks table (used by full-width expanded/empty rows). */
export const COL_COUNT = 10;

/** Create-trunk form state (all string-typed for controlled inputs). */
export interface CreateFormState {
  customer_id: string;
  trunk_name: string;
  auth_type: TrunkAuthType;
  max_channels: string;
  cps_limit: string;
}

export const INITIAL_CREATE: CreateFormState = {
  customer_id: '',
  trunk_name: '',
  auth_type: 'ip',
  max_channels: '10',
  cps_limit: '5',
};

/** Edit-trunk form state. */
export interface EditFormState {
  trunk_name: string;
  max_channels: string;
  cps_limit: string;
  enabled: boolean;
}

/** An available telephone number returned by `GET /numbers/available`. */
export interface AvailableTN {
  tn: string;
  city: string;
  state: string;
  rate_center: string;
  lata: string;
  tier: string;
  bw_status: string;
}
