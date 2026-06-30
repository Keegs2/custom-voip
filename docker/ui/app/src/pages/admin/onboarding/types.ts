/**
 * Local types + constants for the Onboarding admin feature folder.
 *
 * Page-global types (OnboardingRequest, OnboardingStatus, ApproveResponse, …)
 * still come from `src/types/onboarding.ts`. Only feature-local unions / consts
 * live here.
 */

import type { OnboardingStatus } from '../../../types/onboarding';

/** The status filter tab union — "all" plus every real status. */
export type FilterTab = 'all' | OnboardingStatus;

export interface StatusTab {
  label: string;
  value: FilterTab;
}

export const STATUS_TABS: StatusTab[] = [
  { label: 'All',               value: 'all'              },
  { label: 'Pending',           value: 'pending'          },
  { label: 'Billing Verified',  value: 'billing_verified' },
  { label: 'Provisioning',      value: 'provisioning'     },
  { label: 'Active',            value: 'active'           },
  { label: 'Rejected',          value: 'rejected'         },
];
