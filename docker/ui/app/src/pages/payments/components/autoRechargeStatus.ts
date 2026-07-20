/**
 * Auto-recharge status derivation.
 *
 * The REAL backend does NOT send a single `status` enum for auto-recharge; it
 * sends `enabled`, `disabled_reason`, and `consecutive_failures`. We derive a
 * display posture from those the same way everywhere the auto-recharge chip
 * appears (balance hero, auto-recharge card, demo-state panel) so the label +
 * colour stay consistent.
 *
 * Rules:
 *   • not enabled                          → Off
 *   • enabled + a decline dunning reason   → Failed / Action required
 *   • enabled + prior consecutive failures → Action required
 *   • enabled, clean                       → Armed
 */
import { GLASS } from '../../../components/glass/glass';
import type { AutoRechargeSettings } from '../../../types/payments';

export type AutoRechargePosture = 'off' | 'armed' | 'requires_action' | 'failed';

/** Which decline reasons read as "the customer must re-authenticate" vs "hard failure". */
function isAuthReason(reason: string | null | undefined): boolean {
  return !!reason && reason.toLowerCase().includes('authentication');
}

export function autoRechargePosture(ar?: AutoRechargeSettings | null): AutoRechargePosture {
  if (!ar || !ar.enabled) return 'off';
  if (ar.disabled_reason) return isAuthReason(ar.disabled_reason) ? 'requires_action' : 'failed';
  if ((ar.consecutive_failures ?? 0) > 0) return 'requires_action';
  return 'armed';
}

/** Full chip (colour + verbose label) for the balance hero. */
export function rechargeChip(ar?: AutoRechargeSettings | null): { color: string; label: string } {
  switch (autoRechargePosture(ar)) {
    case 'armed':
      return { color: GLASS.success, label: 'Auto-recharge armed' };
    case 'requires_action':
      return { color: GLASS.warning, label: 'Action required' };
    case 'failed':
      return { color: GLASS.danger, label: 'Auto-recharge failed' };
    default:
      return { color: GLASS.textFaint, label: 'Auto-recharge off' };
  }
}

/** Compact chip (colour + short label) for the card header + demo-state panel. */
export function rechargeChipShort(ar?: AutoRechargeSettings | null): { color: string; label: string } {
  switch (autoRechargePosture(ar)) {
    case 'armed':
      return { color: GLASS.success, label: 'Armed' };
    case 'requires_action':
      return { color: GLASS.warning, label: 'Action req.' };
    case 'failed':
      return { color: GLASS.danger, label: 'Failed' };
    default:
      return { color: GLASS.textFaint, label: 'Off' };
  }
}
