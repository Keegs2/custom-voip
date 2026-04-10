import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { login as apiLogin, getMe } from '../api/auth';
import { ApiError } from '../api/client';
import type { User } from '../types/auth';

const AUTH_TOKEN_KEY = 'auth_token';

/* ─── Context shape ──────────────────────────────────────── */

interface AuthContextValue {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  /** True only when role === 'admin' */
  isAdmin: boolean;
  /** True while the initial token validation is running on mount */
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
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

  /* ── Validate persisted token on mount ───────────────────── */
  useEffect(() => {
    const persisted = localStorage.getItem(AUTH_TOKEN_KEY);
    if (!persisted) {
      setIsLoading(false);
      return;
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
        // in client.ts will also call window.location.replace('/login'), but we
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
    navigate('/login', { replace: true });
  }, [navigate]);

  /* ── Derived state ───────────────────────────────────────── */
  const isAuthenticated = user !== null && token !== null;
  const isAdmin = user?.role === 'admin';

  return (
    <AuthContext.Provider value={{ user, token, isAuthenticated, isAdmin, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

/* ─── Hook ───────────────────────────────────────────────── */

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
