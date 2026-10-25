import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import {
  applyThemeToDocument,
  isTheme,
  readStoredTheme,
  readToken,
  systemTheme,
  THEME_STORAGE_KEY,
  watchSystemTheme,
  writeStoredTheme,
  type Theme,
  type ThemeToken,
} from '../styles/theme';

/* ─────────────────────────────────────────────────────────────
   Light / dark theme for the signed-in app.

   - The theme lives on <html>: `data-theme` + `style.colorScheme`
     (src/styles/theme.css defines every --t-* token for both).
   - An explicit choice persists under localStorage `crag_theme`;
     with none, the OS `prefers-color-scheme` decides and is
     tracked live. Other tabs follow via the `storage` event.
   - index.html sets the same attribute before first paint (no
     flash); this provider takes over on mount.
   - The public landing page ignores all of this (data-landing —
     see AppLayout + styles/theme.ts setLandingSurface).
   ───────────────────────────────────────────────────────────── */

export interface ThemeContextValue {
  /** The theme on screen. */
  theme: Theme;
  /** 'user' once the user picked; 'system' while following the OS. */
  source: 'user' | 'system';
  /** Pick a theme explicitly (persisted). */
  setTheme: (theme: Theme) => void;
  /** Switch to the other theme (persisted). */
  toggleTheme: () => void;
  /** Forget the explicit choice and follow the OS again. */
  followSystem: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => unknown;
};

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Runs `update` (which must change the DOM synchronously) as ONE switch:
 * per-element CSS transitions are suspended for two frames, and where the
 * View Transitions API exists the whole page cross-fades once.
 */
function switchTheme(update: () => void): void {
  const root = document.documentElement;
  root.classList.add('theme-switching');
  const release = () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => root.classList.remove('theme-switching'));
    });
  };
  const doc = document as ViewTransitionDocument;
  if (typeof doc.startViewTransition === 'function' && !prefersReducedMotion()) {
    try {
      doc.startViewTransition(update);
      release();
      return;
    } catch {
      // fall through to a plain switch
    }
  }
  update();
  release();
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // ALL hooks unconditionally at the top (React #310).
  const [stored, setStored] = useState<Theme | null>(readStoredTheme);
  const [system, setSystem] = useState<Theme>(systemTheme);
  const theme: Theme = stored ?? system;
  // Mirrors for the event handlers below (they are registered once).
  const storedRef = useRef(stored);
  const systemRef = useRef(system);
  const themeRef = useRef(theme);

  // Every change path writes <html> FIRST and then sets state, so children
  // that read a resolved token during render (useResolvedToken) already see
  // the new theme. This layout effect is the safety net (initial mount, and
  // anything that changed the attribute behind our back).
  useLayoutEffect(() => {
    storedRef.current = stored;
    systemRef.current = system;
    themeRef.current = theme;
    applyThemeToDocument(theme);
  }, [stored, system, theme]);

  // Follow the OS while no explicit choice is stored.
  useEffect(
    () =>
      watchSystemTheme((next) => {
        systemRef.current = next;
        if (storedRef.current === null && next !== themeRef.current) {
          switchTheme(() => {
            applyThemeToDocument(next);
            flushSync(() => setSystem(next));
          });
        } else {
          setSystem(next);
        }
      }),
    [],
  );

  // Another tab picked (or cleared) a theme.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_STORAGE_KEY && e.key !== null) return;
      const next = isTheme(e.newValue) ? e.newValue : readStoredTheme();
      applyThemeToDocument(next ?? systemRef.current);
      setStored(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    writeStoredTheme(next);
    if (next === themeRef.current) {
      setStored(next);
      return;
    }
    switchTheme(() => {
      applyThemeToDocument(next);
      // Commit React's side (icons, labels) inside the same snapshot.
      flushSync(() => setStored(next));
    });
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(themeRef.current === 'dark' ? 'light' : 'dark');
  }, [setTheme]);

  const followSystem = useCallback(() => {
    writeStoredTheme(null);
    const next = systemRef.current;
    if (next === themeRef.current) {
      setStored(null);
      return;
    }
    switchTheme(() => {
      applyThemeToDocument(next);
      flushSync(() => setStored(null));
    });
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, source: stored ? 'user' : 'system', setTheme, toggleTheme, followSystem }),
    [theme, stored, setTheme, toggleTheme, followSystem],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/* ─── Hooks ──────────────────────────────────────────────────
   They live beside their provider by design; Fast Refresh falls
   back to a full reload for this file, which is fine here. */

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx;
}

/**
 * The resolved value of a token (e.g. `"#0e1726"`), re-read whenever the
 * theme changes. ONLY for consumers that cannot take a `var()` string
 * (canvas drawing, colour maths, third-party colour props). Inline styles
 * and SVG should use `T.*` from styles/theme instead.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useResolvedToken(token: ThemeToken): string {
  const { theme } = useTheme();
  // `theme` is the dependency that matters: the provider writes <html>
  // before it re-renders, so the read below already sees the new theme.
  return useMemo(() => {
    void theme;
    return readToken(token);
  }, [token, theme]);
}
