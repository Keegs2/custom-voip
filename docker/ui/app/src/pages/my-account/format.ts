/**
 * Formatting helpers + labels shared by the My Account tabs (no components —
 * kept apart from ./parts.tsx for React fast refresh).
 */
import { API_CALLING_ENABLED } from '../../config/features';
import type { User } from '../../types/auth';
import type { AccountType } from '../../types/customer';

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function accountTypeLabel(t: AccountType): string {
  switch (t) {
    case 'rcf':
      return 'Remote Call Forwarding';
    case 'api':
      return API_CALLING_ENABLED ? 'API Calling' : 'API Calling (retired)';
    case 'trunk':
      return 'SIP Trunking';
    // Hybrid = RCF + SIP Trunking (API Calling is retired; see config/features).
    case 'hybrid':
      return 'Hybrid (RCF + SIP Trunking)';
    case 'ucaas':
      return 'UCaaS';
  }
}

/** "1 number" / "20 numbers". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

// Keyed by the full auth-role union: this map labels both team members
// (TeamRole ⊂ User['role']) and the signed-in user's own role, which can be
// 'support' (platform support staff — customer-less, but still has a profile).
export const ROLE_LABEL: Record<User['role'], string> = {
  admin: 'Administrator',
  user: 'User',
  readonly: 'Read-only',
  support: 'Support',
};

