/**
 * Data + logic layer for the Account settings page.
 *
 * Per the refactor convention (docs/FRONTEND_GLASS_REFACTOR.md): the page does
 * composition + top-level state only; the per-form mutation + validation logic
 * lives here as hooks, so the presentational cards stay dumb. Both hooks talk to
 * the SAME `/auth/me` endpoint the original page used, so saving still persists.
 *
 * React #310: every hook below is called unconditionally at the top of its hook
 * function — no early returns precede a hook.
 */

import { useCallback, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { apiRequest, ApiError } from '../../api/client';
import type { User } from '../../types/auth';
import type { StatusState, UpdateMeBody } from './types';

function messageFrom(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

// ── Profile (display name) ───────────────────────────────────────────────────

export interface UseProfileFormResult {
  name: string;
  setName: (v: string) => void;
  status: StatusState;
  saving: boolean;
  handleSave: (e: FormEvent) => void;
}

/**
 * Owns the display-name field + its live `PUT /auth/me` mutation. On success it
 * refreshes the auth user (so the sidebar/avatar update) and flashes a banner.
 */
export function useProfileForm(user: User, onRefresh: () => Promise<void>): UseProfileFormResult {
  const [name, setName] = useState(user.name ?? '');
  const [status, setStatus] = useState<StatusState>(null);

  const mutation = useMutation({
    mutationFn: (trimmed: string) =>
      apiRequest<User>('PUT', '/auth/me', { name: trimmed } satisfies UpdateMeBody),
    onSuccess: async () => {
      await onRefresh();
      setStatus({ type: 'success', message: 'Display name updated.' });
    },
    onError: (err) => setStatus({ type: 'error', message: messageFrom(err, 'Failed to save. Please try again.') }),
  });

  const handleSave = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const trimmed = name.trim();
      if (!trimmed) {
        setStatus({ type: 'error', message: 'Name cannot be empty.' });
        return;
      }
      setStatus(null);
      mutation.mutate(trimmed);
    },
    [name, mutation],
  );

  return { name, setName, status, saving: mutation.isPending, handleSave };
}

// ── Password ─────────────────────────────────────────────────────────────────

export interface UsePasswordFormResult {
  currentPassword: string;
  setCurrentPassword: (v: string) => void;
  newPassword: string;
  setNewPassword: (v: string) => void;
  confirmPassword: string;
  setConfirmPassword: (v: string) => void;
  status: StatusState;
  saving: boolean;
  handleSave: (e: FormEvent) => void;
}

function validatePassword(current: string, next: string, confirm: string): string | null {
  if (!current) return 'Current password is required.';
  if (next.length < 8) return 'New password must be at least 8 characters.';
  if (next !== confirm) return 'Passwords do not match.';
  return null;
}

/**
 * Owns the three password fields, client-side validation, and the live
 * `PUT /auth/me` mutation. Clears the fields on success.
 */
export function usePasswordForm(onRefresh: () => Promise<void>): UsePasswordFormResult {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [status, setStatus] = useState<StatusState>(null);

  const mutation = useMutation({
    mutationFn: (body: UpdateMeBody) => apiRequest<User>('PUT', '/auth/me', body),
    onSuccess: async () => {
      await onRefresh();
      setStatus({ type: 'success', message: 'Password changed successfully.' });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    },
    onError: (err) =>
      setStatus({ type: 'error', message: messageFrom(err, 'Failed to change password. Please try again.') }),
  });

  const handleSave = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const validationError = validatePassword(currentPassword, newPassword, confirmPassword);
      if (validationError) {
        setStatus({ type: 'error', message: validationError });
        return;
      }
      setStatus(null);
      mutation.mutate({ current_password: currentPassword, new_password: newPassword });
    },
    [currentPassword, newPassword, confirmPassword, mutation],
  );

  return {
    currentPassword,
    setCurrentPassword,
    newPassword,
    setNewPassword,
    confirmPassword,
    setConfirmPassword,
    status,
    saving: mutation.isPending,
    handleSave,
  };
}
