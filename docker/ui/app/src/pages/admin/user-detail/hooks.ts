/**
 * Data + logic layer for the User Detail (360) admin page.
 *
 * Per the refactor convention (docs/FRONTEND_GLASS_REFACTOR.md) the page and its
 * presentational components stay dumb: ALL data fetching, mutations and the
 * derived edit-form logic live here as hooks. React #310 discipline — every hook
 * is called unconditionally at the top of its hook function, no early returns
 * precede a hook.
 */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../../../api/client';
import { listUsers } from '../../../api/auth';
import { listCustomers } from '../../../api/customers';
import type { Customer, UpdateUserPayload, User360, User360Response, UserRole } from './types';
import { CUSTOMER_PAGE_SIZE } from './types';

// ── API fns ──────────────────────────────────────────────────────────────────

async function fetchCustomers(): Promise<Customer[]> {
  return apiRequest<Customer[]>('GET', '/customers');
}

async function fetchUser360(userId: number): Promise<User360Response> {
  return apiRequest<User360Response>('GET', `/search/user/${userId}/360`);
}

// ── 360 view query ─────────────────────────────────────────────────────────────

export function useUser360(userId: number) {
  return useQuery({
    queryKey: ['user-360', userId],
    queryFn: () => fetchUser360(userId),
    staleTime: 30_000,
    retry: 1,
  });
}

// ── All-users query (user lookup panel) ────────────────────────────────────────

export function useAllUsers() {
  return useQuery({
    queryKey: ['all-users'],
    queryFn: listUsers,
    staleTime: 30_000,
    retry: 1,
  });
}

// ── Customer picker query ──────────────────────────────────────────────────────

export function useCustomerPickerData(committedSearch: string, offset: number) {
  return useQuery({
    queryKey: ['customers-user-picker', { search: committedSearch, offset }],
    queryFn: () => listCustomers({ search: committedSearch, limit: CUSTOMER_PAGE_SIZE, offset }),
  });
}

// ── Edit-user form state + save ─────────────────────────────────────────────────

export interface UseEditUserFormArgs {
  userId: number;
  user: User360;
  onSuccess: () => void;
}

export interface UseEditUserFormResult {
  name: string; setName: (v: string) => void;
  email: string; setEmail: (v: string) => void;
  role: UserRole; setRole: (v: UserRole) => void;
  status: 'active' | 'disabled'; setStatus: (v: 'active' | 'disabled') => void;
  customerId: number; setCustomerId: (v: number) => void;
  password: string; setPassword: (v: string) => void;
  saving: boolean;
  banner: { type: 'success' | 'error'; message: string } | null;
  customers: Customer[];
  customersLoading: boolean;
  handleSave: () => Promise<void>;
}

/**
 * Owns the entire edit-user form: field state, the `/customers` lookup for the
 * customer selector, the changed-fields diff, the `PUT /auth/users/:id`
 * mutation, and the success/error banner. Mirrors the original behaviour exactly
 * (only-changed-fields payload, 800ms success delay before closing).
 */
export function useEditUserForm({ userId, user, onSuccess }: UseEditUserFormArgs): UseEditUserFormResult {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [role, setRole] = useState<UserRole>(user.role);
  const [status, setStatus] = useState<'active' | 'disabled'>(
    user.status === 'suspended' ? 'active' : user.status,
  );
  const [customerId, setCustomerId] = useState<number>(user.customer_id);
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const { data: customersRaw, isLoading: customersLoading } = useQuery({
    queryKey: ['customers'],
    queryFn: fetchCustomers,
    staleTime: 60_000,
  });

  const customers = [...(customersRaw ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  async function handleSave(): Promise<void> {
    setSaving(true);
    setBanner(null);

    // Build payload with only changed fields
    const payload: UpdateUserPayload = {};
    if (name.trim() !== user.name) payload.name = name.trim();
    if (email.trim() !== user.email) payload.email = email.trim();
    if (role !== user.role) payload.role = role;
    if (status !== user.status && !(user.status === 'suspended' && status === 'active')) {
      payload.status = status;
    }
    if (customerId !== user.customer_id) payload.customer_id = customerId;
    if (password.trim().length > 0) payload.password = password.trim();

    // If nothing changed, just close
    if (Object.keys(payload).length === 0) {
      onSuccess();
      return;
    }

    try {
      await apiRequest('PUT', `/auth/users/${userId}`, payload);
      setBanner({ type: 'success', message: 'User updated successfully.' });
      setSaving(false);
      // Brief delay so the user sees the success banner before the panel closes
      setTimeout(onSuccess, 800);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'An unexpected error occurred.';
      setBanner({ type: 'error', message: msg });
      setSaving(false);
    }
  }

  return {
    name, setName,
    email, setEmail,
    role, setRole,
    status, setStatus,
    customerId, setCustomerId,
    password, setPassword,
    saving,
    banner,
    customers,
    customersLoading,
    handleSave,
  };
}

// ── 360 view edit toggle + invalidation ─────────────────────────────────────────

export function useUser360Editing(userId: number) {
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);

  function handleEditSuccess(): void {
    setIsEditing(false);
    void queryClient.invalidateQueries({ queryKey: ['user-360', userId] });
  }

  return { isEditing, setIsEditing, handleEditSuccess };
}
