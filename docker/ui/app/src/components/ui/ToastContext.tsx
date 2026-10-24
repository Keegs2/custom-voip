import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';
import { T, TONE, type StatusTone } from '../../styles/theme';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

export interface ToastOptions {
  title?: string;
  message: string;
  variant?: ToastVariant;
  duration?: number;
  persistent?: boolean;
  action?: {
    label: string;
    onClick: () => void;
  };
}

interface ToastEntry extends Required<Omit<ToastOptions, 'title' | 'action'>> {
  id: number;
  title?: string;
  action?: ToastOptions['action'];
  /** true while the exit animation is playing */
  dismissing: boolean;
}

export interface ToastContextValue {
  toast: (options: ToastOptions) => void;
  toastOk: (message: string) => void;
  toastErr: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DURATION_MS = 4000;
const ERROR_DURATION_MS = 6000;
const EXIT_ANIMATION_MS = 200;
const MAX_VISIBLE = 5;

/** Each variant's status tone — theme tokens, so a toast reads right over
    daylight paper and over granite (and portals need no scope class). */
const VARIANT_TONE: Record<ToastVariant, StatusTone> = {
  success: 'ok',
  error:   'danger',
  warning: 'warn',
  info:    'info',
};

// ---------------------------------------------------------------------------
// Per-toast icon SVGs (inline, no extra deps)
// ---------------------------------------------------------------------------

// Icons paint with currentColor; the wrapper sets the tone colour (a var()
// string — CSS custom properties are reliable in `style`, not in SVG
// presentation attributes).
function IconSuccess() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="8.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.5 9l2.5 2.5 4.5-4.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconError() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="8.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6.5 6.5l5 5M11.5 6.5l-5 5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

function IconWarning() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M9 2L16.5 15H1.5L9 2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M9 7.5v3.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <circle cx="9" cy="13" r="0.75" fill="currentColor" />
    </svg>
  );
}

function IconInfo() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <circle cx="9" cy="9" r="8.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9 8.5v4.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      <circle cx="9" cy="5.75" r="0.75" fill="currentColor" />
    </svg>
  );
}

const VARIANT_ICON: Record<ToastVariant, ReactNode> = {
  success: <IconSuccess />,
  error:   <IconError />,
  warning: <IconWarning />,
  info:    <IconInfo />,
};

// ---------------------------------------------------------------------------
// Single toast card
// ---------------------------------------------------------------------------

interface ToastCardProps {
  toast: ToastEntry;
  onDismiss: (id: number) => void;
}

function ToastCard({ toast, onDismiss }: ToastCardProps) {
  const tone = TONE[VARIANT_TONE[toast.variant]];
  // Solid tone for the icon, accent bar and progress; fg for the action.
  const color = tone.solid;
  const [hovered, setHovered] = useState(false);

  // Pause the progress bar while hovered.
  const animationState = hovered ? 'paused' : 'running';
  const animationClass = toast.dismissing ? 'toast-exit' : 'toast-enter';

  return (
    <div
      role="alert"
      className={animationClass}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        minWidth: 320,
        maxWidth: 420,
        borderRadius: 10,
        background: T.surfaceRaised,
        border: `1px solid ${tone.border}`,
        boxShadow: T.shadowPop,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Left accent bar */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 3,
          background: color,
          borderRadius: '10px 0 0 10px',
        }}
      />

      {/* Main content row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px 12px 18px' }}>
        {/* Icon */}
        <div style={{ flexShrink: 0, marginTop: 1, color, display: 'flex' }}>
          {VARIANT_ICON[toast.variant]}
        </div>

        {/* Text */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {toast.title && (
            <div style={{
              fontSize: '0.85rem',
              fontWeight: 700,
              color: T.textStrong,
              lineHeight: 1.3,
              marginBottom: toast.message ? 3 : 0,
            }}>
              {toast.title}
            </div>
          )}
          <div style={{
            fontSize: '0.8rem',
            color: T.textSoft,
            lineHeight: 1.5,
            wordBreak: 'break-word',
          }}>
            {toast.message}
          </div>

          {/* Action button */}
          {toast.action && (
            <button
              type="button"
              onClick={() => {
                toast.action!.onClick();
                onDismiss(toast.id);
              }}
              style={{
                marginTop: 8,
                display: 'inline-flex',
                alignItems: 'center',
                padding: '3px 10px',
                borderRadius: 999,
                border: `1px solid ${tone.border}`,
                background: tone.bg,
                color: tone.fg,
                fontSize: '0.75rem',
                fontWeight: 600,
                cursor: 'pointer',
                letterSpacing: '0.01em',
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>

        {/* Dismiss button — always in DOM, shown on hover / keyboard focus */}
        <button
          type="button"
          onClick={() => onDismiss(toast.id)}
          aria-label="Dismiss notification"
          className="toast-dismiss"
          data-shown={hovered ? 'true' : undefined}
          style={{
            flexShrink: 0,
            marginTop: -2,
            width: 22,
            height: 22,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 4,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            transition: 'opacity 150ms, color 150ms',
          }}
        >
          {/* X icon */}
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Progress bar */}
      {!toast.persistent && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: 2,
            background: T.lineSoft,
          }}
        >
          <div
            style={{
              height: '100%',
              background: color,
              opacity: 0.7,
              transformOrigin: 'left center',
              animation: `toast-progress ${toast.duration}ms linear forwards`,
              animationPlayState: animationState,
            }}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 0;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  // Start exit animation, then remove after it finishes
  const dismiss = useCallback((id: number) => {
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, dismissing: true } : t)),
    );
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, EXIT_ANIMATION_MS);
  }, []);

  const toast = useCallback(
    (options: ToastOptions) => {
      const variant = options.variant ?? 'info';
      const duration = options.duration ?? (variant === 'error' ? ERROR_DURATION_MS : DEFAULT_DURATION_MS);
      const persistent = options.persistent ?? false;

      const id = ++nextId;

      const entry: ToastEntry = {
        id,
        title: options.title,
        message: options.message,
        variant,
        duration,
        persistent,
        action: options.action,
        dismissing: false,
      };

      setToasts((prev) => {
        // Enforce max visible — dismiss oldest surplus immediately (no animation
        // so the new one slots in without layout jump)
        const next = [...prev, entry];
        if (next.length > MAX_VISIBLE) {
          const surplus = next.splice(0, next.length - MAX_VISIBLE);
          // fire their timers to avoid stale state
          surplus.forEach((t) => {
            setTimeout(() => {
              setToasts((p) => p.filter((x) => x.id !== t.id));
            }, 0);
          });
        }
        return next;
      });

      if (!persistent) {
        setTimeout(() => dismiss(id), duration);
      }
    },
    [dismiss],
  );

  // Backward-compatible shortcuts
  const toastOk = useCallback(
    (message: string) => toast({ variant: 'success', message }),
    [toast],
  );
  const toastErr = useCallback(
    (message: string) => toast({ variant: 'error', message }),
    [toast],
  );

  return (
    <ToastContext.Provider value={{ toast, toastOk, toastErr }}>
      {children}

      {/* Global keyframes — injected once, no external CSS file needed */}
      <style>{`
        @keyframes toast-enter {
          from { transform: translateX(110%); opacity: 0; }
          to   { transform: translateX(0);   opacity: 1; }
        }
        @keyframes toast-exit {
          from { transform: translateX(0);   opacity: 1; }
          to   { transform: translateX(110%); opacity: 0; }
        }
        @keyframes toast-progress {
          from { transform: scaleX(1); }
          to   { transform: scaleX(0); }
        }
        .toast-enter {
          animation: toast-enter 300ms cubic-bezier(0.21, 1.02, 0.73, 1) both;
        }
        .toast-exit {
          animation: toast-exit ${EXIT_ANIMATION_MS}ms ease-in both;
        }
        .toast-dismiss { color: var(--t-text-faint); opacity: 0; }
        .toast-dismiss[data-shown], .toast-dismiss:focus-visible { opacity: 1; }
        .toast-dismiss:hover { color: var(--t-text-soft); }
        .toast-dismiss:focus-visible { outline: 2px solid var(--t-focus); outline-offset: 1px; }
        @media (prefers-reduced-motion: reduce) {
          .toast-enter, .toast-exit { animation-duration: 1ms; }
        }
      `}</style>

      {/* Toast container */}
      <div
        aria-live="polite"
        aria-atomic="false"
        style={{
          position: 'fixed',
          bottom: 20,
          right: 20,
          zIndex: 9999,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          pointerEvents: 'none',
          alignItems: 'flex-end',
        }}
      >
        {toasts.map((t) => (
          <div key={t.id} style={{ pointerEvents: 'auto' }}>
            <ToastCard toast={t} onDismiss={dismiss} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook — lives beside its provider by design (Fast Refresh falls back to a
// full reload for this file).
// ---------------------------------------------------------------------------

// eslint-disable-next-line react-refresh/only-export-components
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}
