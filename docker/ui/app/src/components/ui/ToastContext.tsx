import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';

type ToastVariant = 'ok' | 'err';

interface Toast {
  id: number;
  message: string;
  variant: ToastVariant;
}

interface ToastContextValue {
  toastOk: (message: string) => void;
  toastErr: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 0;
const DURATION_MS = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (message: string, variant: ToastVariant) => {
      const id = ++nextId;
      setToasts((prev) => [...prev, { id, message, variant }]);
      setTimeout(() => dismiss(id), DURATION_MS);
    },
    [dismiss],
  );

  const toastOk = useCallback((message: string) => addToast(message, 'ok'), [addToast]);
  const toastErr = useCallback((message: string) => addToast(message, 'err'), [addToast]);

  return (
    <ToastContext.Provider value={{ toastOk, toastErr }}>
      {children}
      {/* Toast container */}
      <div
        className="fixed bottom-5 right-5 z-[200] flex flex-col gap-2 pointer-events-none"
        aria-live="polite"
        aria-atomic="false"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={[
              'pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-[8px]',
              'text-sm font-semibold shadow-[0_8px_32px_rgba(0,0,0,.55)]',
              'border animate-fade-in',
              toast.variant === 'ok'
                ? 'bg-[#065f46] text-[#6ee7b7] border-emerald-300/20'
                : 'bg-[#7f1d1d] text-[#fca5a5] border-red-500/30',
            ].join(' ')}
            role="alert"
          >
            <span className="flex-shrink-0">
              {toast.variant === 'ok' ? '✓' : '✕'}
            </span>
            <span>{toast.message}</span>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              className="ml-auto opacity-70 hover:opacity-100 transition-opacity text-xs leading-none"
              aria-label="Dismiss notification"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}
