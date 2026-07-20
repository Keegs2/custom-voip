import {
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { login as apiLogin, getMe } from '../api/auth';
import { ApiError } from '../api/client';
import type { User } from '../types/auth';
// Context object + AuthContextValue + useAuth live in ./useAuth so this file
// exports only a component (react-refresh/only-export-components).
import { AuthContext } from './useAuth';

const AUTH_TOKEN_KEY = 'auth_token';

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

  /* ── Validate persisted token on mount ───────────────────── */
  useEffect(() => {
    const persisted = localStorage.getItem(AUTH_TOKEN_KEY);
    if (!persisted) {
      // isLoading already initialised to false when no token was persisted
      // (useState initializer above). This async clear only matters in the
      // rare race where the token vanished between first render and this
      // effect (e.g. logout in another tab) — run it on the next tick so no
      // setState happens synchronously in the effect body
      // (react-hooks/set-state-in-effect).
      const t = setTimeout(() => setIsLoading(false), 0);
      return () => clearTimeout(t);
    }

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
    navigate('/', { replace: true });
  }, [navigate]);

  /* ── Refresh user ────────────────────────────────────────── */
  const refreshUser = useCallback(async (): Promise<void> => {
    const me = await getMe();
    setUser(me);
  }, []);

  /* ── Toggle customer view ────────────────────────────────── */
  const toggleCustomerView = useCallback(() => {
    setCustomerViewMode((prev) => {
      const next = !prev;
      // When entering customer view, send the admin back to the dashboard
      // in case they are on an admin-only page that would 404 in customer mode.
      if (next) navigate('/', { replace: true });
      return next;
    });
  }, [navigate]);

  /* ── Derived state ───────────────────────────────────────── */
  const isAuthenticated = user !== null && token !== null;
  const isActualAdmin = user?.role === 'admin';
  // When customerViewMode is active, isAdmin returns false so every component
  // that gates on isAdmin (sidebar groups, RequireAdmin, admin-only buttons)
  // automatically collapses to the customer view without any further changes.
  const isAdmin = isActualAdmin && !customerViewMode;

  return (
    <AuthContext.Provider value={{
      user, token, isAuthenticated,
      isAdmin, isActualAdmin,
      customerViewMode, toggleCustomerView,
      isLoading, login, logout, refreshUser,
    }}>
      {children}
    </AuthContext.Provider>
  );
}
