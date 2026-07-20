/**
 * Product-entitlement predicates — the SINGLE source of truth shared by the
 * route guards (RequireUcaas / RequireVoicemail) and the Sidebar's nav gating,
 * so a nav item can never point at a route whose guard bounces it (the 2026-07
 * audit found exactly that mismatch for Voicemail).
 *
 * `isAdmin` is supplied by the caller because the two consumers legitimately
 * differ:
 *   • route guards pass the raw role (`user.role === 'admin'`) — matching
 *     RequireAdmin/RequireUcaas behaviour, and
 *   • the Sidebar passes AuthContext's customerViewMode-aware `isAdmin`, so an
 *     admin previewing "as customer" sees the customer's real nav.
 * Since (customerViewMode-aware isAdmin) ⇒ (role === 'admin'), everything the
 * nav shows is always reachable through the route guard.
 */
import type { User } from '../../types/auth';

/**
 * UCaaS surface entitlement (softphone, chat, conference, documents, comms,
 * voice ops). `account_type === 'rcf'` fails every non-admin clause — an RCF
 * customer can NEVER reach a UCaaS surface, even by typing the URL directly
 * (CLAUDE.md hard rule: RCF must stay simple).
 */
export function ucaasEntitled(user: User | null, isAdmin: boolean): boolean {
  return (
    isAdmin ||
    user?.account_type === 'ucaas' ||
    (user != null && user.account_type !== 'rcf' && user.ucaas_enabled === true)
  );
}

/**
 * Standalone Visual Voicemail entitlement (`customers.voicemail_enabled`,
 * surfaced on /auth/me + login as `User.voicemail_enabled`). Deliberately
 * independent of account_type: the flagship "voicemail-only" persona forwards
 * their number to us and may hold ANY account type — including `rcf`. Legacy
 * UCaaS accounts and admins keep access via `ucaasEntitled`. An RCF customer
 * with NEITHER flag still gets nothing (RCF isolation preserved).
 */
export function voicemailEntitled(user: User | null, isAdmin: boolean): boolean {
  return user?.voicemail_enabled === true || ucaasEntitled(user, isAdmin);
}
