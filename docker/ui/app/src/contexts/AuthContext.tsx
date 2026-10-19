import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { login as apiLogin, getMe } from '../api/auth';
import { ApiError } from '../api/client';
import type { User } from '../types/auth';

const AUTH_TOKEN_KEY = 'auth_token';

/**
 * The customer account a customer-facing page is about. For a tenant it is
 * their own account; for an admin in "View as Customer" it is the customer
 * they picked to preview (see `previewCustomer`).
 */
export interface EffectiveCustomer {
  id: number;
  name: string;
  account_type: User['account_type'];
}

/* ─── Context shape ──────────────────────────────────────── */

interface AuthContextValue {
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
  /**
   * True when role === 'support' — platform support staff with platform-wide
   * READ access (CDRs, Homer, STIR, slim customer/trunk lists) and no writes.
   * Not affected by customerViewMode (support users have no admin toggle).
   */
  isSupport: boolean;
  /** When true, an admin is previewing the app as a customer would see it. */
  customerViewMode: boolean;
  /** Toggles customerViewMode on/off. Navigates to / when turning ON. */
  toggleCustomerView: () => void;
  /**
   * The customer an admin previews while in customer view (picked in the
   * sidebar). In memory only — like customerViewMode it resets on refresh,
   * and it is cleared on logout. Kept across exit/re-enter of customer view
   * within the session so toggling back lands on the same account.
   */
  previewCustomer: EffectiveCustomer | null;
  setPreviewCustomer: (customer: EffectiveCustomer | null) => void;
  /**
   * The account every customer-facing page (Dashboard, /rcf, Reporting)
   * scopes to:
   *  - tenant (user / readonly with a customer_id) → their own account;
   *  - admin in customer view → `previewCustomer` (null until one is picked);
   *  - admin (normal view), support, or no account → null.
   * Pages key their customer view on `effectiveCustomer.id` so switching the
   * preview remounts them instead of changing hook order.
   */
  effectiveCustomer: EffectiveCustomer | null;
  /** True while the initial token validation is running on mount */
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  /** Re-fetches /auth/me and updates the user in context. Use after profile edits. */
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/* ─── Provider ───────────────────────────────────────────── */

export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();

  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(AUTH_TOKEN_KEY));
  // Start in loading state when a persisted token exists so we can validate it
  // before rendering protected routes.
  const [isLoading, setIsLoading] = useState<boolean>(() => Boolean(localStorage.getItem(AUTH_TOKEN_KEY)));
  // Intentionally NOT persisted to localStorage — resets on every page refresh
  // so an admin can never accidentally leave customer view active between sessions.
  const [customerViewMode, setCustomerViewMode] = useState(false);
  // Same lifetime as customerViewMode: memory only, gone on refresh/logout.
  const [previewCustomer, setPreviewCustomer] = useState<EffectiveCustomer | null>(null);

  /* ── Validate persisted token on mount ───────────────────── */
  useEffect(() => {
    const persisted = localStorage.getItem(AUTH_TOKEN_KEY);
    // No token: isLoading already started false (see its initialiser).
    if (!persisted) return;

    let cancelled = false;

    getMe()
      .then((me) => {
        if (cancelled) return;
        setUser(me);
        setToken(persisted);
      })
      .catch((err) => {
        if (cancelled) return;
        // Token is invalid or expired — clear it silently. The 401 interceptor
        // in client.ts will also call window.location.replace('/'), but we
        // handle it here too so the state is always consistent.
        if (err instanceof ApiError && err.status === 401) {
          localStorage.removeItem(AUTH_TOKEN_KEY);
          setToken(null);
          setUser(null);
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  /* ── Login ───────────────────────────────────────────────── */
  const login = useCallback(async (email: string, password: string): Promise<void> => {
    const response = await apiLogin(email, password);
    localStorage.setItem(AUTH_TOKEN_KEY, response.access_token);
    setToken(response.access_token);
    setUser(response.user);
  }, []);

  /* ── Logout ──────────────────────────────────────────────── */
  const logout = useCallback(() => {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    setToken(null);
    setUser(null);
    setCustomerViewMode(false);
    setPreviewCustomer(null);
    navigate('/', { replace: true });
  }, [navigate]);

  /* ── Refresh user ────────────────────────────────────────── */
  const refreshUser = useCallback(async (): Promise<void> => {
    const me = await getMe();
    setUser(me);
  }, []);

  /* ── Toggle customer view ────────────────────────────────── */
  const toggleCustomerView = useCallback(() => {
    const next = !customerViewMode;
    setCustomerViewMode(next);
    // When entering customer view, send the admin home (`/` → productHome →
    // /dashboard) in case they are on an admin-only page. Called here, not
    // inside the state updater: updaters run during render, and navigating
    // from one updates the router while AuthProvider renders.
    if (next) navigate('/', { replace: true });
  }, [customerViewMode, navigate]);

  /* ── Derived state ───────────────────────────────────────── */
  const isAuthenticated = user !== null && token !== null;
  const isActualAdmin = user?.role === 'admin';
  // When customerViewMode is active, isAdmin returns false so every component
  // that gates on isAdmin (sidebar groups, RequireAdmin, admin-only buttons)
  // automatically collapses to the customer view without any further changes.
  const isAdmin = isActualAdmin && !customerViewMode;
  const isSupport = user?.role === 'support';

  const ownCustomerId = user?.customer_id ?? null;
  const ownCustomerName = user?.customer_name ?? null;
  const ownAccountType = user?.account_type ?? null;
  const effectiveCustomer = useMemo<EffectiveCustomer | null>(() => {
    if (!user || isSupport) return null;
    if (isActualAdmin) return customerViewMode ? previewCustomer : null;
    if (ownCustomerId === null) return null;
    return { id: ownCustomerId, name: ownCustomerName ?? '', account_type: ownAccountType };
  }, [user, isSupport, isActualAdmin, customerViewMode, previewCustomer, ownCustomerId, ownCustomerName, ownAccountType]);

  return (
    <AuthContext.Provider value={{
      user, token, isAuthenticated,
      isAdmin, isActualAdmin, isSupport,
      customerViewMode, toggleCustomerView,
      previewCustomer, setPreviewCustomer, effectiveCustomer,
      isLoading, login, logout, refreshUser,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

/* ─── Hook ───────────────────────────────────────────────── */

// The hook lives beside its provider by design; Fast Refresh falls back to a
// full reload for this file, which is fine for an auth context.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
