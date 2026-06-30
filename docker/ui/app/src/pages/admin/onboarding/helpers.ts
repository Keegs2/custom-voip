/**
 * Pure presentation helpers for the Onboarding admin feature — status labels,
 * status accent colours (mapped onto the glass palette), and date formatters.
 *
 * Kept in a non-`.tsx` module so the `components/` folder can import them
 * without tripping `react-refresh/only-export-components`.
 */

import { GLASS } from '../../../components/glass/glass';
import type { OnboardingStatus } from '../../../types/onboarding';

/** Human-readable label for a status. */
export function statusLabel(status: OnboardingStatus): string {
  switch (status) {
    case 'pending':          return 'Pending';
    case 'billing_verified': return 'Billing Verified';
    case 'provisioning':     return 'Provisioning';
    case 'active':           return 'Active';
    case 'approved':         return 'Approved';
    case 'rejected':         return 'Rejected';
  }
}

/**
 * The accent colour a status reads as on a glass surface. Drives both the
 * status chip and the host card's hover-glow accent. Blue stays the page
 * default; statuses only deviate where the semantics demand it.
 */
export function statusColor(status: OnboardingStatus): string {
  switch (status) {
    case 'pending':          return GLASS.warning;   // awaiting action — amber
    case 'billing_verified': return GLASS.accent;    // ready to provision — blue
    case 'provisioning':     return GLASS.cyan;      // in-flight — cyan
    case 'approved':         return GLASS.cyan;
    case 'active':           return GLASS.success;    // live — green
    case 'rejected':         return GLASS.danger;     // declined — red
  }
}

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
