/**
 * Auth context object + consumer hook, split out of the provider file
 * (`AuthContext.tsx`) so component files export ONLY components
 * (react-refresh/only-export-components — FRONTEND_GLASS_REFACTOR.md §5.3).
 * Import `useAuth` from here; the provider stays in `./AuthContext`.
 */
import { createContext, useContext } from 'react';
import type { User } from '../types/auth';

export interface AuthContextValue {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  /**
   * True only when role === 'admin' AND customerViewMode is false.
   * Components that check this automatically hide admin-only UI in customer view.
   */
  isAdmin: boolean;
  /**
   * True when the user's real role is 'admin', regardless of customerViewMode.
   * Use this only where you need to know the true role (e.g. showing the toggle
   * itself), never for guarding admin-only content.
   */
  isActualAdmin: boolean;
  /** When true, an admin is previewing the app as a customer would see it. */
  customerViewMode: boolean;
  /** Toggles customerViewMode on/off. Navigates to / when turning ON. */
  toggleCustomerView: () => void;
  /** True while the initial token validation is running on mount */
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  /** Re-fetches /auth/me and updates the user in context. Use after profile edits. */
  refreshUser: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
