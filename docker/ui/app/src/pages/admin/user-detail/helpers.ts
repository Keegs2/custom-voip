/**
 * Pure helper functions for the User Detail page — avatar colour hashing, time
 * formatting, and the user-list filter predicate. No JSX, no hooks.
 */

import type { User } from '../../../types/auth';
import type { RecentCall } from './types';
import { AVATAR_COLORS } from './constants';

/** Count calls placed within the last 24h. Kept here (not in a component) so the
 *  `Date.now()` clock read stays out of render and satisfies the purity rule. */
export function countCallsToday(calls: RecentCall[]): number {
  const now = Date.now();
  return calls.filter((c) => now - new Date(c.timestamp).getTime() < 86_400_000).length;
}

/** Deterministically map a name to one of the avatar palette colours. */
export function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) & 0xffffffff;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

/** "Just now" / "5m ago" / "3d ago" / absolute date for older timestamps. */
export function fmtRelativeTime(iso: string | null): string {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Short absolute timestamp used in the recent-calls table. */
export function fmtTimestamp(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Filter the user list by a free-text term across name/email/role/etc. */
export function filterUsers(users: User[], term: string): User[] {
  const q = term.trim().toLowerCase();
  if (q.length === 0) return users;
  return users.filter((u) =>
    u.name.toLowerCase().includes(q) ||
    u.email.toLowerCase().includes(q) ||
    u.role.toLowerCase().includes(q) ||
    u.status.toLowerCase().includes(q) ||
    (u.customer_name ?? '').toLowerCase().includes(q) ||
    (u.account_type ?? '').toLowerCase().includes(q),
  );
}
