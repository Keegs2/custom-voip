/**
 * Local types + constants for the Carriers admin feature folder.
 *
 * Page-global carrier types (Carrier, CarrierCreate, CarrierTransport,
 * CarrierAuthType, CarrierTestResult) still come from `src/types/carrier.ts`.
 * Only feature-local form shapes, option lists, and layout constants live here.
 */

import type { CarrierTransport, CarrierAuthType } from '../../../types/carrier';

/** The product kinds a carrier gateway can serve. */
export const PRODUCT_TYPE_OPTIONS = ['rcf', 'api', 'trunk'] as const;
export type ProductType = (typeof PRODUCT_TYPE_OPTIONS)[number];

export const TRANSPORTS: CarrierTransport[] = ['UDP', 'TCP', 'TLS'];

export const AUTH_TYPES: Array<{ value: CarrierAuthType; label: string }> = [
  { value: 'ip', label: 'IP-based' },
  { value: 'credentials', label: 'Credentials' },
  { value: 'none', label: 'None' },
];

/** Carrier create/edit form state — all string-typed for controlled inputs. */
export interface CarrierFormState {
  displayName: string;
  description: string;
  sipProxy: string;
  port: string;
  transport: CarrierTransport;
  authType: CarrierAuthType;
  username: string;
  password: string;
  codecPrefs: string;
  maxChannels: string;
  cpsLimit: string;
  productTypes: ProductType[];
  isPrimary: boolean;
  isFailover: boolean;
  register: boolean;
  callerIdInFrom: boolean;
  enabled: boolean;
}
