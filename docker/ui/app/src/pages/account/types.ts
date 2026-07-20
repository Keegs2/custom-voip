/**
 * Local types for the Account settings feature folder. Page-global types
 * (`User`) still come from `src/types/auth.ts`; only account-local shapes live
 * here.
 */

import type { User } from '../../types/auth';

/** The PATCH/PUT body accepted by `/auth/me`. */
export interface UpdateMeBody {
  name?: string;
  current_password?: string;
  new_password?: string;
}

export type StatusType = 'success' | 'error';

/** Inline status banner state for a form (null = no banner). */
export type StatusState = { type: StatusType; message: string } | null;

/** Human-readable labels for the `User.role` union. */
export const ROLE_LABELS: Record<User['role'], string> = {
  admin: 'Administrator',
  user: 'User',
  readonly: 'Read-only',
};
