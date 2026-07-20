/**
 * Static config maps for the User Detail page — presence, call results, roles,
 * account types and the deterministic avatar palette. These are pure data
 * (no JSX), so they live in a plain `.ts` module away from the components.
 */

import type { AccountType, CallResult, PresenceStatus, UserRole } from './types';

export const PRESENCE_CONFIG: Record<PresenceStatus, { label: string; color: string }> = {
  available: { label: 'Available',      color: '#22c55e' },
  away:      { label: 'Away',           color: '#f59e0b' },
  busy:      { label: 'Busy',           color: '#ef4444' },
  dnd:       { label: 'Do Not Disturb', color: '#ef4444' },
  offline:   { label: 'Offline',        color: '#64748b' },
};

export const CALL_RESULT_COLOR: Record<CallResult, string> = {
  answered:    '#22c55e',
  failed:      '#ef4444',
  busy:        '#f59e0b',
  'no-answer': '#64748b',
  cancelled:   '#64748b',
};

export const ROLE_CONFIG: Record<UserRole, { label: string; color: string }> = {
  admin:    { label: 'Admin',     color: '#a855f7' },
  user:     { label: 'User',      color: '#0ea5e9' },
  readonly: { label: 'Read-Only', color: '#64748b' },
};

export const ACCOUNT_TYPE_CONFIG: Record<AccountType, { label: string; color: string }> = {
  RCF:    { label: 'RCF',    color: '#22c55e' },
  API:    { label: 'API',    color: '#a855f7' },
  Trunk:  { label: 'Trunk',  color: '#f59e0b' },
  UCaaS:  { label: 'UCaaS',  color: '#0ea5e9' },
  Hybrid: { label: 'Hybrid', color: '#3b82f6' },
};

export const AVATAR_COLORS = [
  '#3b82f6', '#8b5cf6', '#06b6d4', '#10b981',
  '#f59e0b', '#ef4444', '#ec4899', '#6366f1',
];
